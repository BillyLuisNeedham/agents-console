//! The Attempt-run module (ADR-0014, amended; attempt-run.ts): the one code path every spawn site in the
//! engine runs an Attempt through. A Ticket attempt, the merge resolver, a grader, the head-to-head
//! judge and a Conversation each hand this module a parameter list ([`AttemptSpec`]) and the pool
//! facts it needs ([`AttemptEnv`]), and the module owns everything the five sites used to repeat:
//! clearing the stale result, naming and rotating the attempt's files, building the one
//! [`SpawnContext`], deciding terminal-backed once, opening the herdr tab or spawning headless,
//! recording the `spawned` event, tailing the Stream file into the derived log, waiting for readiness
//! and delivering the prompt, waiting on the Attempt ending (`attempt_ending` decides how it ended), and
//! recording `exited` and `crash` on the Ticket log.
//!
//! The seam is split in two so a Conversation, which never ends on a result file, can use the launch
//! half alone: [`launch_attempt`] runs from the stale result clear to the delivered prompt and returns a
//! handle, [`await_attempt`] takes the handle to the exit facts, and [`run_attempt`] is both plus the log
//! events. Marker status writes, tab close and the role's own events stay with the callers.
//!
//! The session's half. The TypeScript hands the env the session's own `liveAttempts` and `children`
//! objects. Here both live on the Session, owned by the actor, and the env reaches them through an
//! [`AttemptHost`]: each synchronous stretch that touches them (the `spawned` event with its register
//! and its child, the ending's events with the clear) is one job on the host, so it stays atomic exactly
//! as it was. The engine's [`Engine`] is the host; a test passes a local one.
//!
//! Port notes (issue #162, M2, r-f1-attempts). Done: `attempt_run` (launch, await, run, the headless
//! spawn and its pumps, the pane tailer, the terminal launch with its botched-launch retries, prompt
//! delivery, the frame block), `attempt_ending`, `pane_session`, `children`, `live_attempts`,
//! `claude_trust`, and `ac_core::turn_state`. Next: the engine core wires `AttemptEnv` (the host is its
//! `Engine`, the Pool workspace its own `PoolWorkspace`), then the `attempts` conformance area against
//! the Rust binary.

use std::fs::File;
use std::io::Write;
use std::os::unix::fs::FileExt;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use futures::future::BoxFuture;
use nix::sys::signal::Signal;
use serde_json::{Map, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

use ac_core::events::{
    AttemptLogName, append_event, attempt_exit_code_name, attempt_log_name, attempt_outcome_name,
    attempt_stream_name, event_now,
};
use ac_core::harness::{
    HarnessMode, HarnessStreamMode, Harnesses, SpawnContext, effort_applies, elide_prompt_argv,
    engine_env_set, harness_command_for, harness_descriptor, harness_stream_mode,
    interactive_harness_command, spawn_env,
};
use ac_core::js;
use ac_core::streamlog::{StreamLineBuffer, TranscriptLineBuffer, derive_stream_line};
use ac_io::git::{commit_sha_at, is_pool_worktree};
use ac_io::herdr::{Herdr, PaneAgentState, PaneInput, attempt_tab_label};
use ac_protocol::{AttemptRole, TicketEvent, TicketEventKind, TicketStatus};

use crate::actor::Engine;
use crate::attempt_ending::{
    AttemptEndingWait, AttemptWatch, PANE_TAIL_POLL_MS, SPAWN_INTERACTIVE_PROMPT_FAILED,
    SPAWN_INTERACTIVE_READY_FAILED, SPAWN_INTERACTIVE_WRAPPER_LOST, attempt_crash_reason,
    read_attempt_result, read_exit_code, wait_for_attempt_ending,
};
use crate::children::{ChildTracker, signal_group};
use crate::claude_trust::{FolderTrustSeed, default_claude_config_path, seed_claude_folder_trust};
use crate::live_attempts::{LiveAttemptEntry, LiveAttempts};
use crate::pane_session::{
    LaunchCadence, Readiness, WrapperContext, close_pane_in_background, send_wrapper_to_pane,
    type_verified, wait_for_readiness, wait_for_shell_settled, wait_for_wrapper_landed,
};

pub use ac_core::streamlog::rotate_attempt_log;

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/// One stretch of an Attempt's work against the session's Live attempts registry and headless
/// children.
pub type RegistriesJob = Box<dyn FnOnce(&mut LiveAttempts, &mut ChildTracker) + Send>;

/// The session's half of an Attempt: its Live attempts registry and its headless children, which the
/// TypeScript handed the env as the session's own objects.
pub trait AttemptHost: Send + Sync {
    /// Run `job` against the registries in one uninterrupted stretch (on the engine, one job on the
    /// actor), then let the registry's change hook run when the job changed it. Resolves false when the
    /// session is gone and the job never ran.
    fn with_registries(&self, job: RegistriesJob) -> BoxFuture<'static, bool>;
}

/// Run `job` on the host's registries and hand back what it returned; `None` when the session is gone.
pub async fn on_registries<T, F>(host: &dyn AttemptHost, job: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce(&mut LiveAttempts, &mut ChildTracker) -> T + Send + 'static,
{
    let (answer, answered) = oneshot::channel();
    host.with_registries(Box::new(move |live, children| {
        let _ = answer.send(job(live, children));
    }))
    .await;
    answered.await.ok()
}

/// The engine is the host: the registries are its session's, and a change to the Live attempts runs the
/// registry's hook (the engine's emit) in the same job.
impl AttemptHost for Engine {
    fn with_registries(&self, job: RegistriesJob) -> BoxFuture<'static, bool> {
        let engine = self.clone();
        Box::pin(async move {
            engine
                .call(move |s| {
                    let generation = s.live_attempts.generation();
                    job(&mut s.live_attempts, &mut s.children);
                    crate::live_attempts::notify_since(s, generation);
                })
                .await
                .is_ok()
        })
    }
}

/// The Pool workspace (issue #94) as a spawn site reads it: the engine resolves it once at boot and
/// every site reads it from here. `id` waits for boot resolution, so a spawn that races it does not
/// open its tab somewhere else; `None` means no Pool workspace could be had at all, and the attempt
/// falls back to headless without ever sending an unplaced `tab.create`. `reresolve` is asked after a
/// refused `tab.create`, naming the id that spawn tried: a workspace the operator closed is replaced, a
/// workspace still there comes back as is, and a spawn that lost the race to another's re-resolve gets
/// wherever the pool's tabs go now. Callers retry the `tab.create` once.
pub trait PoolWorkspace: Send + Sync {
    fn id(&self) -> BoxFuture<'_, Option<String>>;
    fn reresolve(&self, stale_id: String) -> BoxFuture<'_, Option<String>>;
}

/// A pool with no Pool workspace: a headless pool never resolves one.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoPoolWorkspace;

impl PoolWorkspace for NoPoolWorkspace {
    fn id(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async { None })
    }

    fn reresolve(&self, _stale_id: String) -> BoxFuture<'_, Option<String>> {
        Box::pin(async { None })
    }
}

/// The pool facts an Attempt runs against. `terminal_backed` is the one place the pool's terminal
/// setting is decided (ADR-0014): every site reads the flag, none of them the config.
#[derive(Clone)]
pub struct AttemptEnv {
    pub runs_dir: String,
    pub harnesses: Harnesses,
    pub herdr_socket: String,
    /// The environment the harness child inherits (`process.env`, read by the CLI).
    pub parent_env: Arc<Vec<(String, String)>>,
    /// Where this pool's tabs open (issue #94); unused by a headless pool.
    pub pool_workspace: Arc<dyn PoolWorkspace>,
    /// The session's Live attempts registry and headless children: the launch registers the Attempt
    /// once its `spawned` event is recorded, and the run clears it where the ending is recorded (a
    /// launch-only caller clears its own).
    pub host: Arc<dyn AttemptHost>,
    pub terminal_backed: bool,
    /// The launch half's timings, for a test that drives a botched launch in milliseconds; the engine
    /// leaves it unset.
    pub launch_cadence: Option<LaunchCadence>,
    /// Where claude's per-machine config lives, for the folder-trust seed; unset, it is
    /// `.claude.json` under the parent environment's `CLAUDE_CONFIG_DIR`, else under its `HOME`.
    pub claude_config_path: Option<String>,
}

/// How many times a terminal-backed launch opens a fresh tab before giving up on a wrapper that never
/// runs (issue #102).
pub const LAUNCH_TRIES: u32 = 3;

/// The free variables of the attempt's file names (events module).
pub type AttemptNaming = AttemptLogName;

/// Whether the well-known log rotates before this run writes it, keyed on the last exited attempt. A
/// verify candidate writes an attempt-numbered log directly; the resolver rotates at its own site; a
/// Conversation has exactly one attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotate {
    Exited,
    None,
}

/// What happens when the pool is terminal-backed and the tab cannot be opened or the wrapper cannot be
/// sent: headless runs the batch command with the error on the `spawned` event (ADR-0014); none fails
/// the launch, for a Conversation that is a TUI or nothing (ADR-0018).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fallback {
    Headless,
    None,
}

/// How the prompt reaches a terminal-backed pane: the descriptor's interactive shaping (the driver
/// line, echo verified on the issue reference, with the file-referencing fallback), or the body typed
/// verbatim, echo verified on `echo`, with no driver line and no fallback (a Conversation's opening
/// Turn).
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

/// The events a valid result itself carries (a ticket Outcome's rejected spawn proposals), appended
/// before `exited`.
pub type ResultEvents<R> = fn(&R) -> Vec<(TicketEventKind, Map<String, Value>)>;

/// Which events the run appends to the Ticket log.
pub enum AttemptEvents<R> {
    /// `spawned`, `exited` and `crash`; `exited_status` is the exited event's status on a clean exit
    /// with a valid result (in-progress on any crash).
    Full {
        exited_status: fn(&R) -> TicketStatus,
        result_events: Option<ResultEvents<R>>,
    },
    /// The spawn and nothing after: the resolver's and a Conversation's contract.
    SpawnedOnly,
}

/// What genuinely varies between the spawn sites. `R` is the shape of a valid result; it appears only
/// in the `exited` status rule.
pub struct AttemptSpec<R> {
    /// The Ticket (or Conversation) id the log and the files are keyed by.
    pub id: String,
    /// The canonical Issue file the driver line hands the agent.
    pub issue_path: String,
    /// The tab label's title.
    pub title: String,
    /// The prompt body.
    pub body: String,
    pub driver: String,
    pub harness: String,
    pub model: String,
    /// The Assignment's effort; absent (or empty) is the harness's default.
    pub effort: Option<String>,
    /// Where the harness runs.
    pub cwd: String,
    /// The branch fact the `spawned` event records; `None` in the main checkout.
    pub branch: Option<String>,
    /// The attempt number the events key off; the caller allocates it.
    pub attempt: u64,
    pub naming: AttemptNaming,
    pub rotate: Rotate,
    pub fallback: Fallback,
    pub prompt: PromptDelivery,
    pub crash_subject: CrashSubject,
    pub events: AttemptEvents<R>,
}

/// The follow-file tailer deriving a pane's log from its Stream file.
pub struct PaneTailer {
    stop: CancellationToken,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl PaneTailer {
    /// Drain the tail, flush the line buffer and close the log; fails when the log could not be
    /// written.
    pub async fn finish(self) -> anyhow::Result<()> {
        self.stop.cancel();
        self.task.await.context("the pane tailer stopped")?
    }
}

/// A headless child's exit, already in flight: its code once its output is drained, or the failure
/// of a log the engine could not write.
pub type HeadlessExit = BoxFuture<'static, anyhow::Result<i64>>;

/// Where a launched Attempt stands.
pub enum AttemptHandleState {
    /// The harness is running and its prompt has landed, or it runs headless.
    Live {
        /// The headless child's pid (ADR-0017); `None` in a pane.
        pid: Option<u32>,
        /// The headless child's exit; `None` in a pane.
        headless_exit: Option<HeadlessExit>,
        tailer: Option<PaneTailer>,
    },
    /// The harness died before its TUI came up (its own exit code, the pane kept), or the launch was
    /// botched (the engine's negative code, the pane closed). The launch drained the tailer, so the
    /// derived log is complete.
    Ended {
        code: i64,
        /// What the launch saw when it ended with the engine's own code: the Blocking dialog on the
        /// pane, named (issue #127). Appended to the crash reason.
        detail: Option<String>,
    },
}

/// A launched Attempt.
pub struct AttemptHandle {
    pub env: AttemptEnv,
    pub ctx: SpawnContext,
    pub crash_subject: CrashSubject,
    /// The pane the attempt runs in; `None` when headless (pool or fallback).
    pub pane_id: Option<String>,
    pub tab_id: Option<String>,
    pub state: AttemptHandleState,
}

impl AttemptHandle {
    /// The code a launch ended with, when it ended at launch.
    pub fn ended_code(&self) -> Option<i64> {
        match self.state {
            AttemptHandleState::Ended { code, .. } => Some(code),
            AttemptHandleState::Live { .. } => None,
        }
    }
}

/// One Attempt's ending: the exit facts (ADR-0012) and the result. `ok()` exactly when the harness
/// exited 0 and the result file validated; otherwise `crash_reason` says why (a non-zero code wins over
/// the file's contents, else the validator's reason). The result rides on the crash branch too.
#[derive(Debug, Clone, PartialEq)]
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

// ---------------------------------------------------------------------------
// Naming and the log tail
// ---------------------------------------------------------------------------

/// One attempt's Stream file path (ADR-0012, ADR-0016), or `None` when headless and the harness is raw.
/// A terminal-backed attempt always gets one (the `script` typescript); a headless attempt's is the
/// harness's structured stream, which only stream-mode harnesses produce.
pub fn attempt_stream_path(
    runs_dir: &str,
    ticket_id: &str,
    harness: &str,
    attempt: Option<u64>,
    resolver: bool,
    terminal: bool,
) -> Option<String> {
    (terminal || harness_stream_mode(harness) == HarnessStreamMode::Stream)
        .then(|| js::path_join(&[runs_dir, &attempt_stream_name(ticket_id, attempt, resolver)]))
}

// The exit facts' log tail (ADR-0012): the last ~20 lines of the attempt's log.
const LOG_TAIL_LINES: usize = 20;

/// The last lines of a log; a missing or unreadable log reads as no lines. A trailing newline ends the
/// file, it does not open an empty line.
pub fn read_log_tail(log_path: &str) -> Vec<String> {
    let Ok(text) = js::read_text(log_path) else {
        return Vec::new();
    };
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let start = lines.len().saturating_sub(LOG_TAIL_LINES);
    lines[start..]
        .iter()
        .map(|line| (*line).to_owned())
        .collect()
}

/// A crash reason with what the launch saw appended (issue #127): "TUI never became ready: workspace
/// trust dialog was on screen".
pub fn with_launch_detail(reason: String, handle: &AttemptHandle) -> String {
    match &handle.state {
        AttemptHandleState::Ended {
            detail: Some(detail),
            ..
        } => format!("{reason}: {detail}"),
        _ => reason,
    }
}

/// The heading the pane's last frame is written under in an otherwise empty derived log, so a reader
/// knows the lines are the engine's observation of the pane, not the harness's stream.
pub const PANE_FRAME_LOG_HEADING: &str = "[engine] the pane showed:";

// The frame block: blank lines at both ends trimmed, then at most 19 of the frame's lines under the
// heading.
fn pane_frame_log_block(frame: &str) -> String {
    let mut lines: Vec<&str> = frame.split('\n').collect();
    while lines.last().is_some_and(|line| js::trim(line).is_empty()) {
        lines.pop();
    }
    let first = lines
        .iter()
        .position(|line| !js::trim(line).is_empty())
        .unwrap_or(lines.len());
    let lines = &lines[first..];
    let start = lines.len().saturating_sub(LOG_TAIL_LINES - 1);
    format!("{PANE_FRAME_LOG_HEADING}\n{}\n", lines[start..].join("\n"))
}

// ---------------------------------------------------------------------------
// The three operations
// ---------------------------------------------------------------------------

fn runs_path(runs_dir: &str, name: &str) -> String {
    js::path_join(&[runs_dir, name])
}

// `rmSync(path, { force: true })`: a file that is not there is no failure.
fn remove_if_there(path: &str) -> anyhow::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(js::FsError::new(&err, "rm", path).into()),
    }
}

/// Launch one Attempt: from the stale result clear to the delivered prompt. Fails only for a pool
/// config error (an Assignment the harness table cannot serve, the `ConfigError` inside), a harness that
/// cannot be started, or, with [`Fallback::None`], a terminal that could not be had: the error names
/// which half failed (`could not open a herdr tab` or `could not deliver the launch command`) so the
/// caller can prefix its own contract's words.
pub async fn launch_attempt<R>(
    env: &AttemptEnv,
    spec: &AttemptSpec<R>,
) -> anyhow::Result<AttemptHandle> {
    let id = spec.id.as_str();
    let naming = spec.naming;
    let log_path = runs_path(
        &env.runs_dir,
        &attempt_log_name(id, naming.attempt, naming.resolver),
    );
    if spec.rotate == Rotate::Exited {
        rotate_attempt_log(
            Path::new(&env.runs_dir),
            id,
            Path::new(&log_path),
            TicketEventKind::Exited,
        )?;
    }
    let outcome_path = runs_path(
        &env.runs_dir,
        &attempt_outcome_name(id, naming.attempt, naming.resolver),
    );
    // Every attempt starts with no result: a file a previous attempt left behind would be read as this
    // attempt's result.
    remove_if_there(&outcome_path)?;
    let ctx = SpawnContext {
        id: id.to_owned(),
        issue_path: spec.issue_path.clone(),
        body: spec.body.clone(),
        driver: spec.driver.clone(),
        harness: spec.harness.clone(),
        model: spec.model.clone(),
        effort: spec.effort.clone().filter(|effort| !effort.is_empty()),
        log_path,
        stream_path: attempt_stream_path(
            &env.runs_dir,
            id,
            &spec.harness,
            naming.attempt,
            naming.resolver,
            env.terminal_backed,
        ),
        outcome_path,
        exit_code_path: runs_path(
            &env.runs_dir,
            &attempt_exit_code_name(id, naming.attempt, naming.resolver),
        ),
        cwd: spec.cwd.clone(),
    };
    harness_command_for(&env.harnesses, &spec.harness, &spec.model, id)
        .map_err(anyhow::Error::new)?;
    let launch = Launch { env, spec, ctx };

    if !env.terminal_backed {
        if spec.fallback == Fallback::None {
            bail!("the pool is not terminal-backed");
        }
        return launch.headless(None, None, None).await;
    }
    // A terminal-backed attempt opens its own named herdr tab before the spawn is recorded, so the
    // spawned event can carry the pane id; the event is recorded once the wrapper send's outcome is
    // known. The launch is tried into up to LAUNCH_TRIES fresh tabs (issue #96, #102): a wrapper that
    // never ran is a Botched launch, retried into a new tab with the botched one closed and a
    // `launch-retried` event recording it; the `spawned` event names only the tab the launch ended up
    // in. The tries exhausted, the launch ends with the engine's own code.
    let cadence = env.launch_cadence.unwrap_or_default();
    let interactive_argv = interactive_harness_command(&env.harnesses, &spec.harness)
        .map(|command| command.argv(&launch.ctx))
        .unwrap_or_default();
    // Folder trust (issue #127, ADR-0025): the engine made the worktree, so it vouches for it before
    // the tab opens; the seed's outcome rides the `spawned` event. The operator's own checkout is never
    // seeded.
    let folder_trust = (spec.harness == "claude" && is_pool_worktree(&spec.cwd))
        .then(|| seed_claude_folder_trust(&spec.cwd, &claude_config_path_of(env)));
    let herdr = Herdr::new(&env.herdr_socket);
    let mut try_number = 1;
    let (terminal, landed) = loop {
        let opened = open_attempt_terminal(env, id, &spec.title, &spec.cwd).await;
        let (Some(pane_id), Some(tab_id)) = (opened.pane_id.clone(), opened.tab_id.clone()) else {
            if spec.fallback == Fallback::None {
                bail!(
                    "could not open a herdr tab: {}",
                    opened.error.as_deref().unwrap_or_default()
                );
            }
            return launch
                .headless(Some(&opened), None, folder_trust.as_ref())
                .await;
        };
        let terminal = AttemptTerminal {
            pane_id: Some(pane_id.clone()),
            tab_id: Some(tab_id.clone()),
            terminal_id: opened.terminal_id,
            error: None,
        };
        wait_for_shell_settled(&herdr, &pane_id, &cadence).await;
        let wrapper = WrapperContext::from(&launch.ctx);
        if let Some(terminal_error) =
            send_wrapper_to_pane(&herdr, &pane_id, &interactive_argv, wrapper).await
        {
            if spec.fallback == Fallback::None {
                bail!("could not deliver the launch command: {terminal_error}");
            }
            return launch
                .headless(
                    Some(&terminal),
                    Some(&terminal_error),
                    folder_trust.as_ref(),
                )
                .await;
        }
        let landed = match &launch.ctx.stream_path {
            Some(stream_path) => {
                wait_for_wrapper_landed(stream_path, &launch.ctx.exit_code_path, &cadence).await
            }
            None => true,
        };
        if landed || try_number >= LAUNCH_TRIES {
            break (terminal, landed);
        }
        let mut payload = Map::new();
        payload.insert("try".into(), Value::from(try_number));
        payload.insert("pane_id".into(), Value::String(pane_id));
        payload.insert("tab_id".into(), Value::String(tab_id.clone()));
        payload.insert(
            "reason".into(),
            Value::String("launch command never ran".into()),
        );
        launch
            .append(event_now(
                spec.attempt,
                TicketEventKind::LaunchRetried,
                payload,
            ))
            .await?;
        let herdr = herdr.clone();
        tokio::spawn(async move {
            let _ = herdr.close_tab(&tab_id).await;
        });
        try_number += 1;
    };
    let pane_id = terminal.pane_id.clone().unwrap_or_default();
    let tab_id = terminal.tab_id.clone();
    launch
        .record_spawned(
            &interactive_argv,
            HarnessMode::Interactive,
            Some(&terminal),
            None,
            None,
            folder_trust.as_ref(),
        )
        .await?;
    if !landed {
        // Every try was botched: the launch is over before any harness ran. The pane is closed the way
        // a readiness timeout's is; there is no transcript to drain.
        close_pane_in_background(&herdr, &pane_id);
        return Ok(launch.into_handle(
            Some(pane_id),
            tab_id,
            AttemptHandleState::Ended {
                code: SPAWN_INTERACTIVE_WRAPPER_LOST,
                detail: None,
            },
        ));
    }
    // The wrapper is in the pane, so the pane is this attempt's agent (issue #94). A Ticket attempt has
    // no Turn state, so it is working from here until its ending releases it.
    report_attempt_agent(
        &env.herdr_socket,
        &pane_id,
        id,
        &spec.title,
        &spec.harness,
        PaneAgentState::Working,
    );
    // The session half (ADR-0016): the tailer on the typescript Stream file, then prompt delivery. A
    // botched delivery closes the pane and ends with the engine's negative code; a harness that exited
    // on its own before the TUI came up ends with its code and keeps its pane. The tailer always drains
    // what it has so the crash log carries what the pane showed.
    let tailer = launch
        .ctx
        .stream_path
        .as_deref()
        .map(|stream_path| start_pane_stream_tail(stream_path, &launch.ctx.log_path, 0));
    if let Some(failure) =
        deliver_prompt(&herdr, &pane_id, &launch.ctx, &spec.prompt, &cadence).await
    {
        if is_botched_spawn_code(failure.code) {
            close_pane_in_background(&herdr, &pane_id);
        }
        if let Some(tailer) = tailer {
            let _ = tailer.finish().await;
        }
        // The pane's last frame goes to the derived log when the drain left it empty (issue #127): a
        // TUI that never reached its prompt streams nothing the derivation keeps.
        if let Some(frame) = &failure.frame
            && !read_log_tail(&launch.ctx.log_path)
                .iter()
                .any(|line| !js::trim(line).is_empty())
        {
            js::append_file(&launch.ctx.log_path, &pane_frame_log_block(frame))?;
        }
        return Ok(launch.into_handle(
            Some(pane_id),
            tab_id,
            AttemptHandleState::Ended {
                code: failure.code,
                detail: failure.detail,
            },
        ));
    }
    Ok(launch.into_handle(
        Some(pane_id),
        tab_id,
        AttemptHandleState::Live {
            pid: None,
            headless_exit: None,
            tailer,
        },
    ))
}

// What one launch carries between its steps.
struct Launch<'a, R> {
    env: &'a AttemptEnv,
    spec: &'a AttemptSpec<R>,
    ctx: SpawnContext,
}

impl<R> Launch<'_, R> {
    fn into_handle(
        self,
        pane_id: Option<String>,
        tab_id: Option<String>,
        state: AttemptHandleState,
    ) -> AttemptHandle {
        AttemptHandle {
            env: self.env.clone(),
            ctx: self.ctx,
            crash_subject: self.spec.crash_subject,
            pane_id,
            tab_id,
            state,
        }
    }

    // One event on the Ticket log, appended on the host, as every events-file write of an Attempt is.
    async fn append(&self, event: TicketEvent) -> anyhow::Result<()> {
        let runs_dir = self.env.runs_dir.clone();
        let id = self.spec.id.clone();
        on_registries(self.env.host.as_ref(), move |_, _| {
            append_event(Path::new(&runs_dir), &id, &event)
        })
        .await
        .ok_or_else(engine_gone)??;
        Ok(())
    }

    // The `spawned` event, and the Attempt live from that moment with the pane the event records: a
    // fallback that nulled the event's pane is headless here too. A headless child is tracked in the
    // same stretch, before the event, as the TypeScript's spawn did.
    async fn record_spawned(
        &self,
        argv: &[String],
        mode: HarnessMode,
        terminal: Option<&AttemptTerminal>,
        terminal_error: Option<&str>,
        child: Option<(u32, watch::Receiver<bool>)>,
        folder_trust: Option<&FolderTrustSeed>,
    ) -> anyhow::Result<()> {
        let at = js::now_iso();
        let headless_run = mode == HarnessMode::Batch;
        let pid = child.as_ref().map(|(pid, _)| *pid);
        let mut payload = spawned_payload(
            argv,
            &self.ctx,
            self.spec.branch.as_deref(),
            terminal,
            terminal_error,
            pid,
            &self.env.parent_env,
        );
        // Whether the effort reached the harness in the mode that actually ran.
        if self.ctx.effort.is_some() {
            payload.insert(
                "effort_applied".into(),
                Value::Bool(effort_applies(
                    &self.env.harnesses,
                    &self.spec.harness,
                    mode,
                )),
            );
        }
        if let Some(seed) = folder_trust {
            payload.insert("folder_trust".into(), Value::String(seed.note()));
        }
        let event = TicketEvent {
            at: at.clone(),
            attempt: self.spec.attempt,
            kind: TicketEventKind::Spawned,
            payload,
        };
        let pane = |field: fn(&AttemptTerminal) -> &Option<String>| {
            if headless_run {
                None
            } else {
                terminal.and_then(|terminal| field(terminal).clone())
            }
        };
        let entry = LiveAttemptEntry {
            attempt: self.spec.attempt,
            pane_id: pane(|terminal| &terminal.pane_id),
            tab_id: pane(|terminal| &terminal.tab_id),
            role: if self.spec.naming.resolver {
                AttemptRole::Resolver
            } else {
                AttemptRole::Agent
            },
            started_at: at,
        };
        let runs_dir = self.env.runs_dir.clone();
        let id = self.spec.id.clone();
        on_registries(self.env.host.as_ref(), move |live, children| {
            if let Some((pid, exited)) = child {
                children.track(pid, exited);
            }
            append_event(Path::new(&runs_dir), &id, &event)?;
            live.register(&id, entry);
            Ok::<(), js::FsError>(())
        })
        .await
        .ok_or_else(engine_gone)??;
        Ok(())
    }

    // The batch command run headless, recorded once the child exists so the event carries its pid
    // (ADR-0017).
    async fn headless(
        self,
        terminal: Option<&AttemptTerminal>,
        terminal_error: Option<&str>,
        folder_trust: Option<&FolderTrustSeed>,
    ) -> anyhow::Result<AttemptHandle> {
        let argv = harness_command_for(
            &self.env.harnesses,
            &self.spec.harness,
            &self.spec.model,
            &self.spec.id,
        )
        .map_err(anyhow::Error::new)?
        .batch_argv(&self.ctx);
        let child = spawn_headless(&argv, &self.ctx, &self.env.parent_env)?;
        let pid = child.id().unwrap_or_default();
        let (exited_tx, exited_rx) = watch::channel(false);
        let recorded = self
            .record_spawned(
                &argv,
                HarnessMode::Batch,
                terminal,
                terminal_error,
                Some((pid, exited_rx)),
                folder_trust,
            )
            .await;
        let exit = tokio::spawn(run_headless(
            child,
            self.ctx.log_path.clone(),
            self.ctx.stream_path.clone(),
            exited_tx,
        ));
        if let Err(err) = recorded {
            // The run cannot be recorded, so it must not run on unwatched.
            signal_group(pid, Signal::SIGTERM);
            return Err(err);
        }
        let headless_exit: HeadlessExit =
            Box::pin(async move { exit.await.context("the headless pump stopped")? });
        Ok(self.into_handle(
            None,
            None,
            AttemptHandleState::Live {
                pid: Some(pid),
                headless_exit: Some(headless_exit),
                tailer: None,
            },
        ))
    }
}

fn engine_gone() -> anyhow::Error {
    anyhow!("the pool engine has stopped")
}

// The folder-trust seed's file: the env's, else the parent environment's claude config.
fn claude_config_path_of(env: &AttemptEnv) -> String {
    if let Some(path) = &env.claude_config_path {
        return path.clone();
    }
    let var = |name: &str| {
        env.parent_env
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    default_claude_config_path(var("CLAUDE_CONFIG_DIR"), var("HOME").unwrap_or_default())
}

/// Wait for a launched Attempt's ending and read its result. A live pane goes in as a pane watch, a
/// headless child as its exit, and an ended handle skips the wait, its launch having already decided
/// the ending. The tailer is drained before the log tail is read, so the exit facts are complete; the
/// pane's agent identity is released here (issue #94), where every ending of a spawn-site attempt
/// converges. Fails only when the headless child's log could not be written.
pub async fn await_attempt<R, V>(
    handle: AttemptHandle,
    validate: V,
) -> anyhow::Result<AttemptRun<R>>
where
    V: Fn(&Value) -> Result<R, String>,
{
    let AttemptHandle {
        env,
        ctx,
        crash_subject,
        pane_id,
        tab_id,
        state,
    } = handle;
    let (code, result, crash_reason) = match state {
        AttemptHandleState::Ended { code, detail } => {
            let result = read_attempt_result(&ctx.outcome_path, &validate);
            let crash_reason = if code != 0 {
                let reason = attempt_crash_reason(
                    false,
                    code,
                    &ctx.exit_code_path,
                    crash_subject.as_str(),
                    pane_id.as_deref(),
                );
                Some(match detail {
                    Some(detail) => format!("{reason}: {detail}"),
                    None => reason,
                })
            } else {
                result.as_ref().err().cloned()
            };
            (code, result, crash_reason)
        }
        AttemptHandleState::Live {
            headless_exit,
            tailer,
            ..
        } => {
            let watch = match headless_exit {
                Some(exit) => AttemptWatch::Headless { exit },
                None => AttemptWatch::Pane {
                    herdr: Herdr::new(&env.herdr_socket),
                    pane_id: pane_id.clone().unwrap_or_default(),
                },
            };
            let decision = wait_for_attempt_ending(AttemptEndingWait {
                watch,
                exit_code_path: ctx.exit_code_path.clone(),
                outcome_path: ctx.outcome_path.clone(),
                validate: &validate,
                crash_subject: crash_subject.as_str().to_owned(),
                tracker: Some(Arc::clone(&env.host)),
                cadence: None,
            })
            .await;
            if let Some(tailer) = tailer {
                let _ = tailer.finish().await;
            }
            let decision = decision?;
            (decision.code, decision.result, decision.crash_reason)
        }
    };
    if let Some(pane_id) = &pane_id {
        release_attempt_agent(&env.herdr_socket, pane_id, &ctx.harness);
    }
    Ok(AttemptRun {
        code,
        log_tail: read_log_tail(&ctx.log_path),
        outcome_exists: js::exists(&ctx.outcome_path),
        pane_id,
        tab_id,
        log_path: ctx.log_path,
        outcome_path: ctx.outcome_path,
        exit_code_path: ctx.exit_code_path,
        result,
        crash_reason,
    })
}

/// One Attempt end to end: launch, await, and (with full events) the `exited` event on every ending
/// and the `crash` event on a bad one. A crash is recorded the moment the attempt exits; the crash
/// interrupt itself is still the caller's. The Live attempt leaves the registry in the same stretch as
/// the ending's events.
pub async fn run_attempt<R, V>(
    env: &AttemptEnv,
    spec: AttemptSpec<R>,
    validate: V,
) -> anyhow::Result<AttemptRun<R>>
where
    V: Fn(&Value) -> Result<R, String>,
{
    let handle = launch_attempt(env, &spec).await?;
    let run = await_attempt(handle, validate).await?;
    let mut events = Vec::new();
    if let AttemptEvents::Full {
        exited_status,
        result_events,
    } = &spec.events
    {
        let valid = run.result.as_ref().ok().filter(|_| run.ok());
        let status = valid.map_or(TicketStatus::InProgress, exited_status);
        if let (Some(valid), Some(result_events)) = (valid, result_events) {
            for (kind, payload) in result_events(valid) {
                events.push(event_now(spec.attempt, kind, payload));
            }
        }
        let log_tail = Value::from(run.log_tail.clone());
        let mut exited = Map::new();
        exited.insert("code".into(), Value::from(run.code));
        exited.insert("status".into(), Value::String(status.to_string()));
        exited.insert("logTail".into(), log_tail.clone());
        exited.insert("outcomeExists".into(), Value::Bool(run.outcome_exists));
        events.push(event_now(spec.attempt, TicketEventKind::Exited, exited));
        if let Some(reason) = &run.crash_reason {
            let mut crash = Map::new();
            crash.insert("code".into(), Value::from(run.code));
            crash.insert("reason".into(), Value::String(reason.clone()));
            crash.insert("logTail".into(), log_tail);
            crash.insert("outcomeExists".into(), Value::Bool(run.outcome_exists));
            events.push(event_now(spec.attempt, TicketEventKind::Crash, crash));
        }
    }
    let runs_dir = env.runs_dir.clone();
    let id = spec.id.clone();
    let attempt = spec.attempt;
    on_registries(env.host.as_ref(), move |live, _| {
        for event in &events {
            append_event(Path::new(&runs_dir), &id, event)?;
        }
        live.clear(&id, attempt);
        Ok::<(), js::FsError>(())
    })
    .await
    .ok_or_else(engine_gone)??;
    Ok(run)
}

// ---------------------------------------------------------------------------
// The terminal half: tab, agent identity, spawned payload
// ---------------------------------------------------------------------------

/// The terminal facts a terminal-backed spawn adds to the `spawned` event's payload (ADR-0014,
/// ADR-0015): the root pane and its tab, herdr's never-reused terminal id when it gave one, and, when
/// the tab could not be opened, the error that stopped it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct AttemptTerminal {
    pane_id: Option<String>,
    tab_id: Option<String>,
    terminal_id: Option<String>,
    error: Option<String>,
}

// Open the attempt's named herdr tab in the Pool workspace (issue #94). Never fails: herdr is optional
// (ADR-0014), so a missing or misbehaving daemon falls the spawn back to headless with the failure on
// the spawned event. A refused `tab.create` costs one re-resolve and one retry; a pool with no Pool
// workspace never sends an unplaced `tab.create`.
async fn open_attempt_terminal(
    env: &AttemptEnv,
    id: &str,
    title: &str,
    cwd: &str,
) -> AttemptTerminal {
    let label = attempt_tab_label(id, title);
    let herdr = Herdr::new(&env.herdr_socket);
    let opened = async {
        let Some(workspace_id) = env.pool_workspace.id().await else {
            return Err(
                "no Pool workspace: the herdr daemon could not give this pool one at boot"
                    .to_owned(),
            );
        };
        match herdr.open_attempt_tab(&label, cwd, &workspace_id).await {
            Ok(tab) => Ok(tab),
            Err(refused) => {
                // The refused id goes back with the question, so the engine can tell a transient
                // refusal from a workspace that is gone.
                let Some(retry_id) = env.pool_workspace.reresolve(workspace_id).await else {
                    return Err(refused.message().to_owned());
                };
                herdr
                    .open_attempt_tab(&label, cwd, &retry_id)
                    .await
                    .map_err(|err| err.message().to_owned())
            }
        }
    };
    match opened.await {
        Ok(tab) => AttemptTerminal {
            pane_id: Some(tab.pane_id),
            tab_id: Some(tab.tab_id),
            terminal_id: tab.terminal_id,
            error: None,
        },
        Err(error) => AttemptTerminal {
            error: Some(error),
            ..AttemptTerminal::default()
        },
    }
}

/// Report this attempt's agent identity on its pane (issue #94), so herdr lists it in the operator's
/// agent sidebar: the harness as the agent name, the attempt's tab label as the message. Fire and
/// forget: a daemon that will not take the report changes nothing about the attempt.
pub fn report_attempt_agent(
    herdr_socket: &str,
    pane_id: &str,
    id: &str,
    title: &str,
    harness: &str,
    state: PaneAgentState,
) {
    let herdr = Herdr::new(herdr_socket);
    let pane_id = pane_id.to_owned();
    let agent = harness.to_lowercase();
    let label = attempt_tab_label(id, title);
    tokio::spawn(async move {
        let _ = herdr
            .report_pane_agent(&pane_id, &agent, state, &label)
            .await;
    });
}

/// Release this attempt's agent identity at its ending (issue #94), the other half of
/// [`report_attempt_agent`]. Fire and forget for the same reasons.
pub fn release_attempt_agent(herdr_socket: &str, pane_id: &str, harness: &str) {
    let herdr = Herdr::new(herdr_socket);
    let pane_id = pane_id.to_owned();
    let agent = harness.to_lowercase();
    tokio::spawn(async move {
        let _ = herdr.release_pane_agent(&pane_id, &agent).await;
    });
}

fn env_object(pairs: &[(String, String)]) -> Value {
    Value::Object(
        pairs
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    )
}

// The `spawned` event's payload (ADR-0012): the argv with the prompt body elided, the cwd, the branch,
// the commit the cwd was at, the environment keys the engine set beyond the parent's, the Assignment it
// launched with (issue #139), a headless child's pid (ADR-0017), and a terminal-backed spawn's pane and
// tab (ADR-0014, ADR-0015): both null on a headless fallback, which carries its terminal error instead.
fn spawned_payload(
    argv: &[String],
    ctx: &SpawnContext,
    branch: Option<&str>,
    terminal: Option<&AttemptTerminal>,
    terminal_error: Option<&str>,
    pid: Option<u32>,
    parent_env: &[(String, String)],
) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert(
        "argv".into(),
        Value::from(elide_prompt_argv(argv, &ctx.body)),
    );
    payload.insert("cwd".into(), Value::String(ctx.cwd.clone()));
    payload.insert(
        "branch".into(),
        branch.map_or(Value::Null, |branch| Value::String(branch.to_owned())),
    );
    payload.insert(
        "commitSha".into(),
        commit_sha_at(&ctx.cwd).map_or(Value::Null, Value::String),
    );
    payload.insert(
        "env".into(),
        env_object(&engine_env_set(
            &spawn_env(parent_env, &ctx.cwd),
            parent_env,
        )),
    );
    payload.insert("harness".into(), Value::String(ctx.harness.clone()));
    payload.insert("model".into(), Value::String(ctx.model.clone()));
    if let Some(effort) = &ctx.effort {
        payload.insert("effort".into(), Value::String(effort.clone()));
    }
    if let Some(pid) = pid {
        payload.insert("pid".into(), Value::from(pid));
    }
    if let Some(terminal) = terminal {
        let id_of = |id: &Option<String>| match (terminal_error, id) {
            (None, Some(id)) => Value::String(id.clone()),
            _ => Value::Null,
        };
        payload.insert("pane_id".into(), id_of(&terminal.pane_id));
        payload.insert("tab_id".into(), id_of(&terminal.tab_id));
        if terminal_error.is_none()
            && let Some(terminal_id) = terminal.terminal_id.as_ref().filter(|id| !id.is_empty())
        {
            payload.insert("terminal_id".into(), Value::String(terminal_id.clone()));
        }
        if let Some(error) = terminal_error.or(terminal.error.as_deref()) {
            payload.insert("terminal_error".into(), Value::String(error.to_owned()));
        }
    }
    payload
}

// ---------------------------------------------------------------------------
// Prompt delivery
// ---------------------------------------------------------------------------

// Whether a spawn's code is one of the engine's own: the harness never ran, or never took its prompt.
fn is_botched_spawn_code(code: i64) -> bool {
    matches!(
        code,
        SPAWN_INTERACTIVE_READY_FAILED
            | SPAWN_INTERACTIVE_PROMPT_FAILED
            | SPAWN_INTERACTIVE_WRAPPER_LOST
    )
}

/// How a prompt delivery failed: the code the launch ends with, and, when the readiness wait saw
/// something, what stood on the pane (issue #127): a sentence for the crash reason and the frame for the
/// log.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DeliveryFailure {
    code: i64,
    detail: Option<String>,
    frame: Option<String>,
}

impl DeliveryFailure {
    fn code(code: i64) -> Self {
        DeliveryFailure {
            code,
            detail: None,
            frame: None,
        }
    }
}

// The prompt delivery half of a terminal-backed spawn (ADR-0016): wait for the ready frame, type the
// prompt, verify the echo, retry on a lost paste, and (for a driver prompt) fall back to a short
// file-referencing command. A send failing mid-delivery (the daemon died after the wrapper was sent) is
// the botched-spawn failure, never an error: one attempt's terminal trouble must not take the drive
// down. A harness with no descriptor declares no TUI: a driver prompt types nothing, and a plain prompt
// skips the readiness wait but is still typed.
async fn deliver_prompt(
    herdr: &Herdr,
    pane_id: &str,
    ctx: &SpawnContext,
    prompt: &PromptDelivery,
    cadence: &LaunchCadence,
) -> Option<DeliveryFailure> {
    deliver_prompt_inner(herdr, pane_id, ctx, prompt, cadence)
        .await
        .unwrap_or_else(|_| Some(DeliveryFailure::code(SPAWN_INTERACTIVE_PROMPT_FAILED)))
}

async fn deliver_prompt_inner(
    herdr: &Herdr,
    pane_id: &str,
    ctx: &SpawnContext,
    prompt: &PromptDelivery,
    cadence: &LaunchCadence,
) -> anyhow::Result<Option<DeliveryFailure>> {
    let descriptor = harness_descriptor(&ctx.harness);
    if descriptor.is_none() && *prompt == PromptDelivery::Driver {
        return Ok(None);
    }
    if let Some(descriptor) = descriptor {
        match wait_for_readiness(
            herdr,
            pane_id,
            &ctx.harness,
            descriptor.ready_pattern,
            &ctx.exit_code_path,
            cadence,
        )
        .await
        {
            Readiness::Ready => {}
            // The harness exited before its TUI came up: its own code is the attempt's ending.
            Readiness::Exited => {
                return Ok(Some(DeliveryFailure::code(
                    read_exit_code(&ctx.exit_code_path).await,
                )));
            }
            Readiness::Blocked { detail, frame, .. } => {
                return Ok(Some(DeliveryFailure {
                    code: SPAWN_INTERACTIVE_READY_FAILED,
                    detail: Some(detail),
                    frame: Some(frame),
                }));
            }
            Readiness::TimedOut { dialog, frame } => {
                return Ok(Some(DeliveryFailure {
                    code: SPAWN_INTERACTIVE_READY_FAILED,
                    detail: dialog.map(|dialog| {
                        format!("the {dialog} was answered and the ready frame still never came")
                    }),
                    frame: Some(frame),
                }));
            }
            Readiness::PaneEnded => {
                return Ok(Some(DeliveryFailure::code(SPAWN_INTERACTIVE_READY_FAILED)));
            }
        }
    }
    let clear_keys: Vec<String> = descriptor
        .map(|descriptor| {
            descriptor
                .clear_keys
                .iter()
                .map(|key| (*key).to_owned())
                .collect()
        })
        .unwrap_or_default();
    let descriptor = match (prompt, descriptor) {
        (PromptDelivery::Plain { echo }, descriptor) => {
            let echo_targets: Vec<String> =
                [descriptor.and_then(|d| d.echo_pattern), Some(echo.as_str())]
                    .into_iter()
                    .flatten()
                    .filter(|target| !target.is_empty())
                    .map(str::to_owned)
                    .collect();
            let landed =
                type_verified(herdr, pane_id, &ctx.body, &echo_targets, &clear_keys).await?;
            return Ok((!landed).then(|| DeliveryFailure::code(SPAWN_INTERACTIVE_PROMPT_FAILED)));
        }
        (PromptDelivery::Driver, Some(descriptor)) => descriptor,
        (PromptDelivery::Driver, None) => return Ok(None),
    };
    let shaped = (descriptor.prompt_shaping.interactive)(ctx.shaping());
    // The fallback's prompt file, named from the result path so N parallel attempts never share one: the
    // issue reference the driver line would have carried, then the body.
    let prompt_file = match ctx.outcome_path.strip_suffix(".json") {
        Some(stem) => format!("{stem}.prompt.txt"),
        None => ctx.outcome_path.clone(),
    };
    js::write_file(&prompt_file, &format!("{}\n\n{}", ctx.issue_path, ctx.body))?;
    // The issue reference rides every known TUI's prompt, so it is the harness-agnostic echo signal.
    let echo_targets: Vec<String> = descriptor
        .echo_pattern
        .into_iter()
        .chain([ctx.issue_path.as_str()])
        .map(str::to_owned)
        .collect();
    // A harness with no verified clear sequence cannot safely re-paste: one attempt, then a loud fail.
    if type_verified(herdr, pane_id, &shaped, &echo_targets, &clear_keys).await? {
        return Ok(None);
    }
    if clear_keys.is_empty() {
        return Ok(Some(DeliveryFailure::code(SPAWN_INTERACTIVE_PROMPT_FAILED)));
    }
    // Full-prompt pasting failed: the file-referencing fallback, short enough to survive any input
    // buffer cap, carrying the attempt's own driver. One un-retried attempt into a just-cleared pane.
    let fallback = format!("/{} {prompt_file}", ctx.driver);
    herdr
        .pane_send_input(pane_id, &PaneInput::keys(clear_keys.iter().cloned()))
        .await?;
    if type_verified(herdr, pane_id, &fallback, &[prompt_file], &[]).await? {
        return Ok(None);
    }
    Ok(Some(DeliveryFailure::code(SPAWN_INTERACTIVE_PROMPT_FAILED)))
}

// ---------------------------------------------------------------------------
// The Stream file: the pane tailer and the headless pump
// ---------------------------------------------------------------------------

// Once the harness child has exited, its pumps get this long to drain whatever is still in flight
// before the reads are given up: a grandchild that inherits the child's pipe and outlives it holds the
// write end open, and an unbounded pump would park the drive forever on a child that is already gone.
const SPAWN_PUMP_GRACE_MS: u64 = 2_000;

// A file the engine writes as a stream: the first failure (opening it, or a write) is recorded and the
// file is dropped, so later writes are skipped and the spawn fails on the error after teardown.
struct Sink {
    file: Option<File>,
    error: Option<String>,
}

impl Sink {
    // `createWriteStream(path)`: created or truncated.
    fn create(path: &str) -> Self {
        match File::create(path) {
            Ok(file) => Sink {
                file: Some(file),
                error: None,
            },
            Err(err) => Sink {
                file: None,
                error: Some(js::FsError::new(&err, "open", path).to_string()),
            },
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        let Some(file) = &mut self.file else {
            return;
        };
        if let Err(err) = file.write_all(bytes) {
            self.error
                .get_or_insert_with(|| js::FsError::bare(&err, "write").to_string());
            self.file = None;
        }
    }
}

type SharedSink = Arc<Mutex<Sink>>;

fn lock(sink: &SharedSink) -> std::sync::MutexGuard<'_, Sink> {
    sink.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The follow-file tailer (ADR-0014, ADR-0016): reads the pane's `script` typescript Stream file as it
/// grows and derives the attempt log from it line by line, stripping the terminal's escapes and control
/// noise (`TranscriptLineBuffer`). Polls by positioned reads every 250 ms; `finish` drains the tail,
/// flushes the line buffer and closes the log. Also the boot-adopted attempt's finalize and a Continued
/// attempt's (issue #139), whose pane's `script` is still writing the Stream file of the attempt it
/// continues: `from_offset` is where that file stood when the Continued attempt began.
pub fn start_pane_stream_tail(stream_path: &str, log_path: &str, from_offset: u64) -> PaneTailer {
    let stop = CancellationToken::new();
    let stopped = stop.clone();
    let stream_path = stream_path.to_owned();
    let mut log = Sink::create(log_path);
    let task = tokio::spawn(async move {
        let mut tail = StreamTail {
            stream_path,
            from_offset,
            file: None,
            offset: 0,
            buffer: TranscriptLineBuffer::new(),
        };
        loop {
            tokio::select! {
                () = tokio::time::sleep(Duration::from_millis(PANE_TAIL_POLL_MS)) => tail.step(&mut log),
                () = stopped.cancelled() => break,
            }
        }
        tail.step(&mut log);
        for line in tail.buffer.flush() {
            log.write(format!("{line}\n").as_bytes());
        }
        drop(tail.file.take());
        match log.error {
            Some(error) => Err(anyhow!(error)),
            None => Ok(()),
        }
    });
    PaneTailer { stop, task }
}

struct StreamTail {
    stream_path: String,
    from_offset: u64,
    file: Option<File>,
    offset: u64,
    buffer: TranscriptLineBuffer,
}

impl StreamTail {
    // One poll step: open the file once script has created it, then read everything new since the last
    // offset through the line buffer.
    fn step(&mut self, log: &mut Sink) {
        if self.file.is_none() {
            let Ok(file) = File::open(&self.stream_path) else {
                return;
            };
            self.file = Some(file);
            self.offset = self.from_offset;
            self.buffer = TranscriptLineBuffer::new();
        }
        let Some(file) = &self.file else {
            return;
        };
        let Ok(size) = file.metadata().map(|meta| meta.len()) else {
            return;
        };
        if size < self.offset {
            // The file was replaced (a re-run truncated it): re-read from scratch.
            self.offset = 0;
            self.buffer = TranscriptLineBuffer::new();
        }
        let mut chunk = vec![0u8; 64 * 1024];
        while self.offset < size {
            let read = match file.read_at(&mut chunk, self.offset) {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            self.offset += read as u64;
            for line in self.buffer.push(&chunk[..read]) {
                log.write(format!("{line}\n").as_bytes());
            }
        }
    }
}

// Start the batch command headless, in its own process group and session (ADR-0017, Bun's
// `detached`), with the environment the spawned event's env facts derive from, stdin closed and both
// outputs piped.
fn spawn_headless(
    argv: &[String],
    ctx: &SpawnContext,
    parent_env: &[(String, String)],
) -> anyhow::Result<tokio::process::Child> {
    let Some((program, args)) = argv.split_first() else {
        bail!("the harness command is empty");
    };
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(&ctx.cwd)
        .env_clear()
        .envs(spawn_env(parent_env, &ctx.cwd))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    // SAFETY: setsid is async-signal-safe and touches nothing of the parent's.
    unsafe {
        command.pre_exec(|| {
            nix::unistd::setsid()
                .map(drop)
                .map_err(std::io::Error::from)
        });
    }
    command.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            anyhow!("Executable not found in $PATH: \"{program}\"")
        } else {
            anyhow!(err)
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PumpMode {
    /// stdout of a streamed harness: teed verbatim to the Stream file and derived line by line.
    Stream,
    /// stderr of a streamed harness: the same deriver without the tee, so diagnostics pass through.
    Diagnostics,
    /// Either output of a raw harness: the chunk itself.
    Raw,
}

// The headless child's run: both outputs pumped into one log in arrival order, live (a streamed
// harness's stdout also teed to its Stream file), the child's exit announced the moment it happens,
// then the pumps given the grace to drain. Resolves with the exit code (a signalled death as 128 plus
// the signal, as Bun reports it), or fails when the log or the Stream file could not be written.
async fn run_headless(
    mut child: tokio::process::Child,
    log_path: String,
    stream_path: Option<String>,
    exited: watch::Sender<bool>,
) -> anyhow::Result<i64> {
    let log: SharedSink = Arc::new(Mutex::new(Sink::create(&log_path)));
    let tee: Option<SharedSink> = stream_path
        .as_deref()
        .map(|path| Arc::new(Mutex::new(Sink::create(path))));
    let failure: Arc<Mutex<Option<String>>> = Arc::default();
    let (out_mode, err_mode) = if tee.is_some() {
        (PumpMode::Stream, PumpMode::Diagnostics)
    } else {
        (PumpMode::Raw, PumpMode::Raw)
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let waiting = async {
        let status = child.wait().await;
        let _ = exited.send(true);
        status
    };
    let (status, (), ()) = tokio::join!(
        waiting,
        pump(
            stdout,
            out_mode,
            &log,
            tee.as_ref(),
            &failure,
            exited.subscribe()
        ),
        pump(stderr, err_mode, &log, None, &failure, exited.subscribe()),
    );
    let error = failure
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .or_else(|| lock(&log).error.take())
        .or_else(|| tee.as_ref().and_then(|tee| lock(tee).error.take()));
    drop(log);
    drop(tee);
    if let Some(error) = error {
        bail!(error);
    }
    let status = status?;
    Ok(status
        .code()
        .map_or_else(|| 128 + i64::from(status.signal().unwrap_or(0)), i64::from))
}

async fn pump(
    reader: Option<impl AsyncRead + Unpin>,
    mode: PumpMode,
    log: &SharedSink,
    tee: Option<&SharedSink>,
    failure: &Mutex<Option<String>>,
    exited: watch::Receiver<bool>,
) {
    let Some(mut reader) = reader else {
        return;
    };
    let mut buffer = (mode != PumpMode::Raw).then(StreamLineBuffer::new);
    let write_derived = |line: String| {
        let text = derive_stream_line(&line).unwrap_or(line);
        if !text.is_empty() {
            lock(log).write(format!("{text}\n").as_bytes());
        }
    };
    let grace = async {
        crate::children::child_exited(exited).await;
        tokio::time::sleep(Duration::from_millis(SPAWN_PUMP_GRACE_MS)).await;
    };
    tokio::pin!(grace);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = tokio::select! {
            read = reader.read(&mut chunk) => read,
            () = &mut grace => break,
        };
        match read {
            Ok(0) => break,
            Ok(read) => {
                let bytes = &chunk[..read];
                if mode == PumpMode::Stream
                    && let Some(tee) = tee
                {
                    lock(tee).write(bytes);
                }
                match &mut buffer {
                    Some(buffer) => buffer.push(bytes).into_iter().for_each(&write_derived),
                    None => lock(log).write(bytes),
                }
            }
            Err(err) => {
                failure
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get_or_insert(err.to_string());
                return;
            }
        }
    }
    if let Some(buffer) = &mut buffer {
        buffer.flush().into_iter().for_each(write_derived);
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A host with no engine behind it, for the module tests: the registries behind a mutex.

    use super::*;

    #[derive(Default)]
    pub(crate) struct LocalHost {
        registries: Mutex<(LiveAttempts, ChildTracker)>,
    }

    impl LocalHost {
        pub(crate) fn children<T>(&self, job: impl FnOnce(&mut ChildTracker) -> T) -> T {
            job(&mut self.registries.lock().unwrap().1)
        }

        pub(crate) fn live<T>(&self, job: impl FnOnce(&mut LiveAttempts) -> T) -> T {
            job(&mut self.registries.lock().unwrap().0)
        }
    }

    impl AttemptHost for LocalHost {
        fn with_registries(&self, job: RegistriesJob) -> BoxFuture<'static, bool> {
            let mut registries = self.registries.lock().unwrap();
            let (live, children) = &mut *registries;
            job(live, children);
            Box::pin(async { true })
        }
    }
}

#[cfg(test)]
mod tests;
