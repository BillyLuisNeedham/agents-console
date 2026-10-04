//! The Attempt-run module (ADR-0014, attempt-run.ts): the one code path every spawn site runs an
//! Attempt through.
//!
//! STUB(attempt_run): the attempt launch port owns this module. The interface is the TypeScript's
//! (`AttemptEnv`, `AttemptSpec`, `runAttempt`, `readLogTail`), and the body is a minimal headless run
//! so the engine core can be driven end to end before the real one lands: the batch argv in its own
//! process group, both output streams written raw to the log, the `spawned`, `exited` and `crash`
//! events with the TypeScript's payloads, and the Live attempts registry kept. No Stream file, no
//! stream-mode derivation, no terminal-backed launch (a terminal-backed pool falls back to headless).

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use serde_json::{Map, Value};
use tokio::sync::watch;

use ac_core::events::{
    append_event, attempt_exit_code_name, attempt_log_name, attempt_outcome_name, event_now,
};
use ac_core::harness::{
    Harnesses, SpawnContext, elide_prompt_argv, engine_env_set, harness_command_for, spawn_env,
};
use ac_core::streamlog::rotate_attempt_log;
use ac_protocol::{AttemptRole, TicketEventKind, TicketStatus};

use crate::actor::Engine;
use crate::attempt_ending::{ResultValidator, attempt_crash_reason, read_attempt_result};
use crate::live_attempts::LiveAttemptEntry;
use crate::pane_session::LaunchCadence;

/// The pool facts an Attempt runs against. `terminal_backed` is the one place the pool's terminal
/// setting is decided (ADR-0014). The Live attempts registry, the children and the Pool workspace are
/// reached through `engine`.
#[derive(Clone)]
pub struct AttemptEnv {
    pub engine: Engine,
    pub runs_dir: String,
    pub harnesses: Harnesses,
    pub herdr_socket: String,
    /// The environment the harness child inherits.
    pub parent_env: Arc<Vec<(String, String)>>,
    pub terminal_backed: bool,
    pub launch_cadence: Option<LaunchCadence>,
    /// Where claude's per-machine config lives, for the folder-trust seed.
    pub claude_config_path: Option<String>,
}

/// The free variables of the attempt's file names (events module).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttemptNaming {
    pub attempt: Option<u64>,
    pub resolver: bool,
}

/// Whether the well-known log rotates before this run writes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotate {
    Exited,
    None,
}

/// What happens when the pool is terminal-backed and the tab cannot be had.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fallback {
    Headless,
    None,
}

/// How the prompt reaches a terminal-backed pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptDelivery {
    Driver,
    Plain { echo: String },
}

/// The subject a crash reason names: "harness exited 3", "resolver exited 3".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashSubject {
    Harness,
    Resolver,
}

impl CrashSubject {
    pub fn as_str(self) -> &'static str {
        match self {
            CrashSubject::Harness => "harness",
            CrashSubject::Resolver => "resolver",
        }
    }
}

/// The events a valid result itself carries, appended before `exited`.
pub type ResultEvents<R> = fn(&R) -> Vec<(TicketEventKind, Map<String, Value>)>;

/// Which events the run appends to the Ticket log.
pub enum AttemptEvents<R> {
    /// `spawned`, `exited` and `crash`; `exited_status` is the exited event's status on a clean exit
    /// with a valid result.
    Full {
        exited_status: fn(&R) -> TicketStatus,
        result_events: Option<ResultEvents<R>>,
    },
    /// The spawn and nothing after: the resolver's and a Conversation's contract.
    SpawnedOnly,
}

/// What genuinely varies between the spawn sites.
pub struct AttemptSpec<R> {
    pub id: String,
    pub issue_path: String,
    pub title: String,
    pub body: String,
    pub driver: String,
    pub harness: String,
    pub model: String,
    pub effort: Option<String>,
    pub cwd: String,
    /// The branch fact the `spawned` event records; `None` in the main checkout.
    pub branch: Option<String>,
    pub attempt: u64,
    pub naming: AttemptNaming,
    pub rotate: Rotate,
    pub fallback: Fallback,
    pub prompt: PromptDelivery,
    pub crash_subject: CrashSubject,
    pub events: AttemptEvents<R>,
}

/// One Attempt's ending: the exit facts (ADR-0012) and the result. `ok()` exactly when the harness
/// exited 0 and the result file validated; otherwise `crash_reason` says why.
#[derive(Debug, Clone)]
pub struct AttemptRun<R> {
    pub code: i64,
    pub log_tail: Vec<String>,
    pub outcome_exists: bool,
    pub pane_id: Option<String>,
    pub tab_id: Option<String>,
    pub log_path: String,
    pub outcome_path: String,
    pub exit_code_path: String,
    pub result: Result<R, String>,
    pub crash_reason: Option<String>,
}

impl<R> AttemptRun<R> {
    pub fn ok(&self) -> bool {
        self.crash_reason.is_none()
    }
}

// The exit facts' log tail (ADR-0012): the last ~20 lines of the attempt's log.
const LOG_TAIL_LINES: usize = 20;

/// `readLogTail`: the last lines of a log; a missing or unreadable log reads as no lines.
pub fn read_log_tail(log_path: &str) -> Vec<String> {
    let Ok(text) = ac_core::js::read_text(log_path) else {
        return Vec::new();
    };
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let start = lines.len().saturating_sub(LOG_TAIL_LINES);
    lines[start..].iter().map(|line| line.to_string()).collect()
}

fn path_of(runs_dir: &str, name: &str) -> String {
    ac_core::js::path_join(&[runs_dir, name])
}

fn env_object(pairs: &[(String, String)]) -> Value {
    Value::Object(
        pairs
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    )
}

/// `runAttempt`: one Attempt end to end. Fails only for a pool config error (an Assignment the
/// harness table cannot serve) or a log the engine cannot write.
pub async fn run_attempt<R: Send + 'static>(
    env: &AttemptEnv,
    spec: AttemptSpec<R>,
    validate: ResultValidator<R>,
) -> anyhow::Result<AttemptRun<R>> {
    let runs = env.runs_dir.as_str();
    let naming = spec.naming;
    let log_path = path_of(
        runs,
        &attempt_log_name(&spec.id, naming.attempt, naming.resolver),
    );
    if spec.rotate == Rotate::Exited {
        rotate_attempt_log(
            Path::new(runs),
            &spec.id,
            Path::new(&log_path),
            TicketEventKind::Exited,
        )?;
    }
    let outcome_path = path_of(
        runs,
        &attempt_outcome_name(&spec.id, naming.attempt, naming.resolver),
    );
    let _ = std::fs::remove_file(&outcome_path);
    let exit_code_path = path_of(
        runs,
        &attempt_exit_code_name(&spec.id, naming.attempt, naming.resolver),
    );
    let ctx = SpawnContext {
        id: spec.id.clone(),
        issue_path: spec.issue_path.clone(),
        body: spec.body.clone(),
        driver: spec.driver.clone(),
        harness: spec.harness.clone(),
        model: spec.model.clone(),
        effort: spec.effort.clone(),
        log_path: log_path.clone(),
        outcome_path: outcome_path.clone(),
        exit_code_path: exit_code_path.clone(),
        cwd: spec.cwd.clone(),
        stream_path: None,
    };
    let harness = harness_command_for(&env.harnesses, &spec.harness, &spec.model, &spec.id)?;
    let argv = harness.batch_argv(&ctx);
    let child_env = spawn_env(&env.parent_env, &spec.cwd);
    ac_core::js::mkdir_all(runs)?;
    let log = std::fs::File::create(&log_path)?;
    let mut command = tokio::process::Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(child_env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .process_group(0)
        .kill_on_drop(false);
    let mut child = command.spawn()?;
    let pid = child.id().unwrap_or(0);
    let (exited_tx, exited_rx) = watch::channel(false);
    let mut payload = Map::new();
    payload.insert(
        "argv".into(),
        Value::from(elide_prompt_argv(&argv, &spec.body)),
    );
    payload.insert("cwd".into(), Value::String(spec.cwd.clone()));
    payload.insert(
        "branch".into(),
        spec.branch.clone().map_or(Value::Null, Value::String),
    );
    payload.insert(
        "commitSha".into(),
        ac_io::git::commit_sha_at(&spec.cwd).map_or(Value::Null, Value::String),
    );
    payload.insert(
        "env".into(),
        env_object(&engine_env_set(&child_env, &env.parent_env)),
    );
    payload.insert("harness".into(), Value::String(spec.harness.clone()));
    payload.insert("model".into(), Value::String(spec.model.clone()));
    if let Some(effort) = &spec.effort {
        payload.insert("effort".into(), Value::String(effort.clone()));
    }
    payload.insert("pid".into(), Value::from(pid));
    let spawned = event_now(spec.attempt, TicketEventKind::Spawned, payload);
    let started_at = spawned.at.clone();
    let id = spec.id.clone();
    let attempt = spec.attempt;
    let role = if naming.resolver {
        AttemptRole::Resolver
    } else {
        AttemptRole::Agent
    };
    let runs_dir = env.runs_dir.clone();
    env.engine
        .call(move |s| {
            s.children.track(pid, exited_rx);
            let _ = append_event(Path::new(&runs_dir), &id, &spawned);
            s.live_attempts.register(
                &id,
                LiveAttemptEntry {
                    attempt,
                    pane_id: None,
                    tab_id: None,
                    role,
                    started_at,
                },
            );
            let phase = s.idle_phase();
            crate::snapshot::emit_snapshot(s, phase);
        })
        .await?;
    let status = child.wait().await?;
    let _ = exited_tx.send(true);
    let code = status.code().map_or_else(
        || {
            use std::os::unix::process::ExitStatusExt;
            128 + i64::from(status.signal().unwrap_or(0))
        },
        i64::from,
    );
    let stopping = env
        .engine
        .call(move |s| {
            s.children.untrack(pid);
            s.children.stopping
        })
        .await?;
    let result = read_attempt_result(Path::new(&outcome_path), validate);
    let crash_reason = if code != 0 {
        Some(attempt_crash_reason(
            stopping,
            code,
            &exit_code_path,
            spec.crash_subject.as_str(),
            None,
        ))
    } else {
        result.as_ref().err().cloned()
    };
    let log_tail = read_log_tail(&log_path);
    let outcome_exists = Path::new(&outcome_path).exists();
    let mut events = Vec::new();
    if let AttemptEvents::Full {
        exited_status,
        result_events,
    } = &spec.events
    {
        let ok = crash_reason.is_none();
        let status = match (&result, ok) {
            (Ok(valid), true) => exited_status(valid),
            _ => TicketStatus::InProgress,
        };
        if let (Ok(valid), true, Some(result_events)) = (&result, ok, result_events) {
            for (kind, payload) in result_events(valid) {
                events.push(event_now(spec.attempt, kind, payload));
            }
        }
        let tail = Value::from(log_tail.clone());
        let mut exited = Map::new();
        exited.insert("code".into(), Value::from(code));
        exited.insert("status".into(), Value::String(status.to_string()));
        exited.insert("logTail".into(), tail.clone());
        exited.insert("outcomeExists".into(), Value::Bool(outcome_exists));
        events.push(event_now(spec.attempt, TicketEventKind::Exited, exited));
        if let Some(reason) = &crash_reason {
            let mut crash = Map::new();
            crash.insert("code".into(), Value::from(code));
            crash.insert("reason".into(), Value::String(reason.clone()));
            crash.insert("logTail".into(), tail);
            crash.insert("outcomeExists".into(), Value::Bool(outcome_exists));
            events.push(event_now(spec.attempt, TicketEventKind::Crash, crash));
        }
    }
    let id = spec.id.clone();
    let runs_dir = env.runs_dir.clone();
    env.engine
        .call(move |s| {
            for event in &events {
                let _ = append_event(Path::new(&runs_dir), &id, event);
            }
            if s.live_attempts.clear(&id, attempt) {
                let phase = s.idle_phase();
                crate::snapshot::emit_snapshot(s, phase);
            }
        })
        .await?;
    Ok(AttemptRun {
        code,
        log_tail,
        outcome_exists,
        pane_id: None,
        tab_id: None,
        log_path,
        outcome_path,
        exit_code_path,
        result,
        crash_reason,
    })
}
