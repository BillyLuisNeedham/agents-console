//! engine/attempt-run.test.ts: the module driven directly, a runs directory and a local host, no pool
//! and no drive loop. Headless attempts run a stub harness script in a tempdir (the shape of
//! conformance/fixtures/stub-harness.sh); terminal-backed ones run against the fake herdr, whose script
//! hook stands in for `script` creating its Stream file when the wrapper lands. The hidden row
//! attempt-run.test.ts:435 (the pool config error) is here, and so are the rows C12 left to Rust: a
//! harness with no descriptor gets the wrapper and nothing typed, and the pane frame block keeps the
//! frame's last 19 lines.

use std::sync::Mutex as StdMutex;

use ac_core::harness::HarnessCommand;
use ac_io::herdr::fake::{FakeHerdr, Options, Reply, until};
use serde_json::json;

use super::test_support::LocalHost;
use super::*;
use crate::attempt_ending::EXIT_CODE_UNREADABLE;

#[derive(Debug, Clone, PartialEq)]
struct Done {
    status: TicketStatus,
}

fn validate(parsed: &Value) -> Result<Done, String> {
    parsed
        .get("status")
        .and_then(Value::as_str)
        .and_then(TicketStatus::parse)
        .map(|status| Done { status })
        .ok_or_else(|| "outcome has no valid status".to_owned())
}

fn exited_status(done: &Done) -> TicketStatus {
    done.status
}

struct Rig {
    _dir: tempfile::TempDir,
    root: String,
    runs: String,
    issue: String,
    stub: String,
    host: Arc<LocalHost>,
}

const STUB: &str = r#"#!/usr/bin/env bash
outcome="$1"; mode="$2"
case "$mode" in
  done)
    printf 'working on it\n'
    printf '{"status":"done"}' > "$outcome"
    ;;
  crash3)
    echo "boom" >&2
    exit 3
    ;;
  signal)
    kill -TERM $$
    ;;
  sleep)
    sleep 30
    ;;
  stream)
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the spec now."}]}}'
    printf '%s' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}'
    sleep 0.3
    printf '%s\n' '}'
    echo "diag line" >&2
    printf '%s\n' '{"type":"result","subtype":"success"}'
    printf '{"status":"done"}' > "$outcome"
    ;;
esac
exit 0
"#;

fn rig() -> Rig {
    let dir = tempfile::Builder::new()
        .prefix("attempt-run-")
        .tempdir()
        .unwrap();
    let root = js::path_text(&std::fs::canonicalize(dir.path()).unwrap());
    let runs = format!("{root}/runs");
    std::fs::create_dir_all(&runs).unwrap();
    std::fs::create_dir_all(format!("{root}/issues")).unwrap();
    let issue = format!("{root}/issues/01-t.md");
    std::fs::write(
        &issue,
        "<!-- state: id=01 blocked-by=none status=in-progress -->\n# 01: t\n",
    )
    .unwrap();
    let stub = format!("{root}/stub.sh");
    std::fs::write(&stub, STUB).unwrap();
    Rig {
        _dir: dir,
        root,
        runs,
        issue,
        stub,
        host: Arc::new(LocalHost::default()),
    }
}

impl Rig {
    // The stub as a harness command: `bash stub.sh <outcome> <mode> <body>`, the body riding the argv
    // so its elision on the spawned event shows.
    fn command(&self, mode: &str) -> HarnessCommand {
        let stub = self.stub.clone();
        let mode = mode.to_owned();
        Arc::new(move |ctx: &SpawnContext| {
            vec![
                "bash".to_owned(),
                stub.clone(),
                ctx.outcome_path.clone(),
                mode.clone(),
                ctx.body.clone(),
            ]
        })
    }

    fn env(&self, harnesses: Harnesses, herdr_socket: &str, terminal_backed: bool) -> AttemptEnv {
        AttemptEnv {
            runs_dir: self.runs.clone(),
            harnesses,
            herdr_socket: herdr_socket.to_owned(),
            parent_env: Arc::new(std::env::vars().collect()),
            pool_workspace: Arc::new(TestWorkspace::new(Some("w1"), None)),
            host: Arc::clone(&self.host) as Arc<dyn AttemptHost>,
            terminal_backed,
            launch_cadence: Some(fast_cadence()),
            claude_config_path: Some(format!("{}/claude.json", self.root)),
        }
    }

    fn headless_env(&self, name: &str, mode: &str) -> AttemptEnv {
        let mut harnesses = Harnesses::defaults();
        harnesses.insert_command(name, self.command(mode));
        self.env(harnesses, &format!("{}/no-herdr.sock", self.root), false)
    }

    fn spec(&self, harness: &str) -> AttemptSpec<Done> {
        AttemptSpec {
            id: "01".into(),
            issue_path: self.issue.clone(),
            title: "t".into(),
            body: "Standing instructions: implement the ticket and write the Outcome.".into(),
            driver: "implement".into(),
            harness: harness.into(),
            model: "stub-model".into(),
            effort: None,
            cwd: self.root.clone(),
            branch: None,
            attempt: 1,
            naming: AttemptNaming {
                attempt: None,
                resolver: false,
            },
            rotate: Rotate::Exited,
            fallback: Fallback::Headless,
            prompt: PromptDelivery::Driver,
            crash_subject: CrashSubject::Harness,
            events: AttemptEvents::Full {
                exited_status,
                result_events: None,
            },
        }
    }

    fn events(&self) -> Vec<TicketEvent> {
        js::read_text(format!("{}/01.events.jsonl", self.runs))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn kinds(&self) -> Vec<TicketEventKind> {
        self.events().into_iter().map(|event| event.kind).collect()
    }

    fn file(&self, name: &str) -> String {
        js::read_text(format!("{}/{name}", self.runs)).unwrap_or_default()
    }

    fn exists(&self, name: &str) -> bool {
        js::exists(format!("{}/{name}", self.runs))
    }
}

fn fast_cadence() -> LaunchCadence {
    LaunchCadence {
        settle_poll_ms: 10,
        settle_confirmations: 2,
        settle_timeout_ms: 1_000,
        landed_timeout_ms: 200,
        landed_poll_ms: 20,
        dialog_settle_ms: 20,
        dialog_key_gap_ms: 20,
        dialog_confirm_ms: 20,
        readiness_poll_ms: 20,
        readiness_timeout_ms: 1_000,
    }
}

/// The Pool workspace as the engine hands one to a spawn site: a resolved id, and a re-resolve whose
/// answer the test seeds, recording the stale ids it was asked about.
struct TestWorkspace {
    current: StdMutex<Option<String>>,
    next: Option<String>,
    reresolves: StdMutex<Vec<String>>,
}

impl TestWorkspace {
    fn new(id: Option<&str>, next: Option<&str>) -> Self {
        TestWorkspace {
            current: StdMutex::new(id.map(str::to_owned)),
            next: next.map(str::to_owned),
            reresolves: StdMutex::default(),
        }
    }
}

impl PoolWorkspace for TestWorkspace {
    fn id(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async { self.current.lock().unwrap().clone() })
    }

    fn reresolve(&self, stale_id: String) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            self.reresolves.lock().unwrap().push(stale_id.clone());
            let mut current = self.current.lock().unwrap();
            if current.as_deref() != Some(stale_id.as_str()) {
                return current.clone();
            }
            *current = self.next.clone();
            current.clone()
        })
    }
}

// ---------------------------------------------------------------------------
// Headless attempts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_headless_attempt_records_no_pane_facts_and_never_touches_the_socket() {
    let rig = rig();
    let env = rig.headless_env("stub", "done");
    let run = run_attempt(&env, rig.spec("stub"), validate).await.unwrap();
    assert!(run.ok());
    assert_eq!(run.code, 0);
    assert_eq!(
        run.result,
        Ok(Done {
            status: TicketStatus::Done
        })
    );
    assert_eq!(run.log_tail, ["working on it"]);
    assert!(run.outcome_exists);
    assert_eq!(run.pane_id, None);
    assert_eq!(run.log_path, format!("{}/01.log", rig.runs));

    let events = rig.events();
    assert_eq!(
        events.iter().map(|event| event.kind).collect::<Vec<_>>(),
        [TicketEventKind::Spawned, TicketEventKind::Exited]
    );
    let spawned = &events[0].payload;
    assert_eq!(
        spawned.keys().collect::<Vec<_>>(),
        [
            "argv",
            "cwd",
            "branch",
            "commitSha",
            "env",
            "harness",
            "model",
            "pid"
        ]
    );
    assert_eq!(
        spawned["argv"],
        json!([
            "bash",
            rig.stub,
            format!("{}/01.outcome.json", rig.runs),
            "done",
            "<prompt>"
        ])
    );
    assert_eq!(spawned["cwd"], json!(rig.root));
    assert_eq!(spawned["branch"], Value::Null);
    assert_eq!(spawned["harness"], json!("stub"));
    assert_eq!(spawned["model"], json!("stub-model"));
    assert!(spawned["pid"].as_u64().unwrap() > 0);
    if std::env::var("PWD").ok().as_deref() != Some(rig.root.as_str()) {
        assert_eq!(spawned["env"], json!({ "PWD": rig.root }));
    }
    assert_eq!(
        events[1].payload,
        json!({ "code": 0, "status": "done", "logTail": ["working on it"], "outcomeExists": true })
            .as_object()
            .unwrap()
            .clone()
    );
    // Live from the spawn until the ending, and the child dropped once it exited.
    rig.host.live(|live| assert!(!live.is_live("01")));
    rig.host.children(|children| assert_eq!(children.size(), 0));
    // A raw harness run headless has no Stream file.
    assert!(!rig.exists("01.stream.jsonl"));
}

#[tokio::test]
async fn a_spawned_only_spec_records_the_spawn_and_nothing_after() {
    let rig = rig();
    let env = rig.headless_env("stub", "crash3");
    let mut spec = rig.spec("stub");
    spec.events = AttemptEvents::SpawnedOnly;
    let run = run_attempt(&env, spec, validate).await.unwrap();
    assert!(!run.ok());
    assert_eq!(run.crash_reason.as_deref(), Some("harness exited 3"));
    assert_eq!(run.log_tail, ["boom"]);
    assert_eq!(rig.kinds(), [TicketEventKind::Spawned]);
    rig.host.live(|live| assert!(!live.is_live("01")));
}

#[tokio::test]
async fn a_crash_records_exited_in_progress_then_crash() {
    let rig = rig();
    let env = rig.headless_env("stub", "crash3");
    let run = run_attempt(&env, rig.spec("stub"), validate).await.unwrap();
    assert_eq!(run.code, 3);
    let events = rig.events();
    assert_eq!(
        events.iter().map(|event| event.kind).collect::<Vec<_>>(),
        [
            TicketEventKind::Spawned,
            TicketEventKind::Exited,
            TicketEventKind::Crash
        ]
    );
    assert_eq!(events[1].payload["status"], json!("in-progress"));
    assert_eq!(
        events[2].payload,
        json!({ "code": 3, "reason": "harness exited 3", "logTail": ["boom"], "outcomeExists": false })
            .as_object()
            .unwrap()
            .clone()
    );
}

#[tokio::test]
async fn a_signalled_child_exits_as_bun_reports_it() {
    let rig = rig();
    let env = rig.headless_env("stub", "signal");
    let run = run_attempt(&env, rig.spec("stub"), validate).await.unwrap();
    assert_eq!(run.code, 143);
    assert_eq!(run.crash_reason.as_deref(), Some("harness exited 143"));
}

#[tokio::test]
async fn a_child_launched_into_a_shutdown_is_stopped_and_named_so() {
    let rig = rig();
    rig.host.children(|children| children.stopping = true);
    let env = rig.headless_env("stub", "sleep");
    let run = run_attempt(&env, rig.spec("stub"), validate).await.unwrap();
    assert_eq!(run.code, 143);
    assert_eq!(
        run.crash_reason.as_deref(),
        Some("harness stopped by engine shutdown (exited 143)")
    );
}

#[tokio::test]
async fn rotates_the_well_known_log_and_stream_file_to_the_last_exited_attempts_name() {
    let rig = rig();
    std::fs::write(format!("{}/01.log", rig.runs), "old log\n").unwrap();
    std::fs::write(format!("{}/01.stream.jsonl", rig.runs), "old stream\n").unwrap();
    for (attempt, kind) in [(1, "spawned"), (1, "exited"), (2, "spawned"), (2, "exited")] {
        js::append_file(
            format!("{}/01.events.jsonl", rig.runs),
            &format!(
                "{{\"at\":\"2026-01-01T00:00:00.000Z\",\"attempt\":{attempt},\"kind\":\"{kind}\",\"payload\":{{}}}}\n"
            ),
        )
        .unwrap();
    }
    let env = rig.headless_env("stub", "done");
    let mut spec = rig.spec("stub");
    spec.attempt = 3;
    run_attempt(&env, spec, validate).await.unwrap();
    assert_eq!(rig.file("01.attempt-2.log"), "old log\n");
    assert_eq!(rig.file("01.attempt-2.stream.jsonl"), "old stream\n");
    assert_eq!(rig.file("01.log"), "working on it\n");
}

#[tokio::test]
async fn a_verify_candidate_names_its_files_by_attempt_and_rotates_nothing() {
    let rig = rig();
    std::fs::write(format!("{}/01.log", rig.runs), "the ticket's log\n").unwrap();
    let env = rig.headless_env("stub", "done");
    let mut spec = rig.spec("stub");
    spec.attempt = 3;
    spec.naming = AttemptNaming {
        attempt: Some(3),
        resolver: false,
    };
    spec.rotate = Rotate::None;
    let run = run_attempt(&env, spec, validate).await.unwrap();
    assert_eq!(
        run.outcome_path,
        format!("{}/01.attempt-3.outcome.json", rig.runs)
    );
    assert_eq!(
        run.exit_code_path,
        format!("{}/01.attempt-3.exitcode", rig.runs)
    );
    assert_eq!(rig.file("01.attempt-3.log"), "working on it\n");
    assert_eq!(rig.file("01.log"), "the ticket's log\n");
}

#[tokio::test]
async fn the_resolver_names_its_files_and_its_crash_with_its_own_words() {
    let rig = rig();
    let env = rig.headless_env("stub", "crash3");
    let mut spec = rig.spec("stub");
    spec.naming = AttemptNaming {
        attempt: None,
        resolver: true,
    };
    spec.rotate = Rotate::None;
    spec.crash_subject = CrashSubject::Resolver;
    let run = run_attempt(&env, spec, validate).await.unwrap();
    assert_eq!(run.log_path, format!("{}/01.resolver.log", rig.runs));
    assert_eq!(
        run.outcome_path,
        format!("{}/01.resolver.outcome.json", rig.runs)
    );
    assert_eq!(run.crash_reason.as_deref(), Some("resolver exited 3"));
    assert_eq!(rig.file("01.resolver.log"), "boom\n");
}

#[tokio::test]
async fn a_stale_result_is_cleared_before_the_attempt_runs() {
    let rig = rig();
    std::fs::write(
        format!("{}/01.outcome.json", rig.runs),
        r#"{"status":"done"}"#,
    )
    .unwrap();
    let env = rig.headless_env("stub", "crash3");
    let run = run_attempt(&env, rig.spec("stub"), validate).await.unwrap();
    assert!(!run.outcome_exists);
    assert_eq!(run.result, Err("no outcome written".into()));
}

#[tokio::test]
async fn the_pool_config_error_launches_nothing() {
    let rig = rig();
    let env = rig.headless_env("stub", "done");
    let refusal = |harness: &str, model: &str| {
        let mut spec = rig.spec(harness);
        spec.model = model.to_owned();
        spec
    };
    let err = run_attempt(&env, refusal("", "m"), validate)
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "pool config: ticket 01 has no harness (set one in console.json assign or defaults)"
    );
    assert!(err.downcast_ref::<ac_core::config::ConfigError>().is_some());
    let err = run_attempt(&env, refusal("stub", ""), validate)
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "pool config: ticket 01 has no model (set one in console.json assign or defaults)"
    );
    let err = run_attempt(&env, refusal("nope", "m"), validate)
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "pool config: ticket 01 names unknown harness 'nope'. Known: claude, cursor, opencode, stub"
    );
    assert!(rig.events().is_empty());
    assert!(!rig.exists("01.log"));
}

#[tokio::test]
async fn a_streamed_harness_tees_stdout_and_derives_both_outputs_into_the_log() {
    let rig = rig();
    // A harness named claude is a stream-mode harness, whatever command the pool registers for it.
    let env = rig.headless_env("claude", "stream");
    let run = run_attempt(&env, rig.spec("claude"), validate)
        .await
        .unwrap();
    assert!(run.ok());
    let log = rig.file("01.log");
    let mut lines: Vec<&str> = log.lines().collect();
    lines.sort_unstable();
    assert_eq!(
        lines,
        ["Reading the spec now.", "[tool] Bash: ls", "diag line"],
        "a line split across two chunks derives once, the result event says nothing"
    );
    let stream = rig.file("01.stream.jsonl");
    assert!(stream.starts_with(
        "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Reading the spec now.\"}]}}\n"
    ));
    assert!(stream.ends_with("{\"type\":\"result\",\"subtype\":\"success\"}\n"));
    assert!(
        !stream.contains("diag line"),
        "stderr never reaches the Stream file"
    );
}

#[tokio::test]
async fn a_headless_pool_refuses_a_launch_that_must_be_a_terminal() {
    let rig = rig();
    let env = rig.headless_env("stub", "done");
    let mut spec = rig.spec("stub");
    spec.fallback = Fallback::None;
    let err = launch_attempt(&env, &spec).await.err().unwrap();
    assert_eq!(err.to_string(), "the pool is not terminal-backed");
}

// ---------------------------------------------------------------------------
// Terminal-backed attempts against the fake herdr
// ---------------------------------------------------------------------------

/// A fake daemon holding the Pool workspace `w1`, whose panes "run" the wrapper: when it lands, the
/// Stream file appears as script would create it (unless `landing` is off), and every read answers
/// `frame`.
struct Daemon {
    fake: FakeHerdr,
}

async fn daemon(stream_path: String, landing: bool, frame: &str) -> Daemon {
    let frame = frame.to_owned();
    let fake = FakeHerdr::start(Options {
        workspaces: vec![
            json!({ "workspace_id": "w1" }),
            json!({ "workspace_id": "w2" }),
        ],
        script: Some(Arc::new(move |method: &str, params: &Value| match method {
            "pane.send_input" => {
                let wrapper = params
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| text.starts_with("script -eq"));
                if wrapper && landing {
                    std::fs::write(&stream_path, "").unwrap();
                }
                None
            }
            "pane.read" => Some(Reply::Line(
                json!({ "id": "1", "result": { "read": { "text": frame } } }).to_string(),
            )),
            _ => None,
        })),
        ..Options::default()
    })
    .await;
    Daemon { fake }
}

impl Daemon {
    fn socket(&self) -> String {
        js::path_text(self.fake.herdr().socket_path())
    }

    fn calls(&self, method: &str) -> Vec<Value> {
        self.fake
            .requests()
            .into_iter()
            .filter(|request| request.method == method)
            .map(|request| request.params)
            .collect()
    }
}

fn custom_terminal_env(rig: &Rig, socket: &str, name: &str) -> AttemptEnv {
    let mut harnesses = Harnesses::defaults();
    harnesses.insert_command(name, rig.command("sleep"));
    rig.env(harnesses, socket, true)
}

#[tokio::test]
async fn a_harness_with_no_descriptor_gets_the_wrapper_and_nothing_typed() {
    let rig = rig();
    let stream_path = format!("{}/01.stream.jsonl", rig.runs);
    let d = daemon(stream_path.clone(), true, "$ ").await;
    let env = custom_terminal_env(&rig, &d.socket(), "custom");
    let spec = rig.spec("custom");
    let handle = launch_attempt(&env, &spec).await.unwrap();
    assert_eq!(handle.pane_id.as_deref(), Some("w1:p1"));
    assert_eq!(handle.tab_id.as_deref(), Some("w1:t1"));
    assert!(matches!(handle.state, AttemptHandleState::Live { .. }));
    // Exactly one input reached the pane: the wrapper and its Enter.
    let inputs = d.calls("pane.send_input");
    let wrapper = crate::pane_session::interactive_wrapper(
        &rig.command("sleep")(&handle.ctx),
        WrapperContext::from(&handle.ctx),
        crate::pane_session::ScriptPlatform::host(),
    );
    assert_eq!(
        inputs,
        [json!({ "pane_id": "w1:p1", "text": wrapper, "keys": ["enter"] })]
    );
    assert_eq!(
        d.calls("tab.create"),
        [json!({ "label": "01 · t", "focus": false, "cwd": rig.root, "workspace_id": "w1" })]
    );
    let spawned = &rig.events()[0];
    assert_eq!(spawned.payload["pane_id"], json!("w1:p1"));
    assert_eq!(spawned.payload["tab_id"], json!("w1:t1"));
    assert!(!spawned.payload.contains_key("pid"));
    assert!(!spawned.payload.contains_key("terminal_error"));
    rig.host.live(|live| {
        let entry = live.entry("01", 1).unwrap();
        assert_eq!(entry.pane_id.as_deref(), Some("w1:p1"));
        assert_eq!(entry.tab_id.as_deref(), Some("w1:t1"));
    });
    until("the agent report", || {
        !d.calls("pane.report_agent").is_empty()
    })
    .await;
    let report = &d.calls("pane.report_agent")[0];
    assert_eq!(report["agent"], json!("custom"));
    assert_eq!(report["state"], json!("working"));
    assert_eq!(report["message"], json!("01 · t"));

    // The transcript reaches the derived log; the Outcome ends the attempt with the pane left open.
    std::fs::write(&stream_path, "\x1b[32mhello from the TUI\x1b[0m\r\n").unwrap();
    std::fs::write(
        format!("{}/01.outcome.json", rig.runs),
        r#"{"status":"done"}"#,
    )
    .unwrap();
    let run = await_attempt(handle, validate).await.unwrap();
    assert!(run.ok());
    assert_eq!(run.log_tail, ["hello from the TUI"]);
    assert_eq!(
        d.calls("pane.send_input").len(),
        1,
        "nothing typed after the wrapper"
    );
    assert!(d.calls("pane.close").is_empty());
    until("the agent release", || {
        !d.calls("pane.release_agent").is_empty()
    })
    .await;
    assert_eq!(
        d.calls("pane.release_agent")[0],
        json!({ "pane_id": "w1:p1", "source": "herdr:agent-console", "agent": "custom" })
    );
}

#[tokio::test]
async fn a_pane_end_with_no_file_is_the_attempts_crash() {
    let rig = rig();
    let stream_path = format!("{}/01.stream.jsonl", rig.runs);
    let d = daemon(stream_path, true, "$ ").await;
    let env = custom_terminal_env(&rig, &d.socket(), "custom");
    let handle = launch_attempt(&env, &rig.spec("custom")).await.unwrap();
    let ending = tokio::spawn(await_attempt(handle, validate));
    until("the ending's subscription", || d.fake.subscribers() == 1).await;
    d.fake
        .push_event("pane_exited", json!({ "pane_id": "w1:p1" }));
    let run = ending.await.unwrap().unwrap();
    assert_eq!(run.code, EXIT_CODE_UNREADABLE);
    assert_eq!(
        run.crash_reason.unwrap(),
        format!(
            "harness exit code unreadable: the pane wrapper never wrote a usable {}/01.exitcode",
            rig.runs
        )
    );
}

#[tokio::test]
async fn a_botched_launch_is_retried_into_fresh_tabs_then_ends_as_never_ran() {
    let rig = rig();
    let d = daemon(String::new(), false, "$ ").await;
    let env = custom_terminal_env(&rig, &d.socket(), "custom");
    let run = run_attempt(&env, rig.spec("custom"), validate)
        .await
        .unwrap();
    assert_eq!(run.code, SPAWN_INTERACTIVE_WRAPPER_LOST);
    assert_eq!(
        run.crash_reason.as_deref(),
        Some("launch command never ran")
    );
    assert_eq!(run.pane_id.as_deref(), Some("w1:p3"));
    assert_eq!(d.calls("tab.create").len(), LAUNCH_TRIES as usize);
    let events = rig.events();
    assert_eq!(
        events.iter().map(|event| event.kind).collect::<Vec<_>>(),
        [
            TicketEventKind::LaunchRetried,
            TicketEventKind::LaunchRetried,
            TicketEventKind::Spawned,
            TicketEventKind::Exited,
            TicketEventKind::Crash,
        ]
    );
    assert_eq!(
        events[0].payload,
        json!({ "try": 1, "pane_id": "w1:p1", "tab_id": "w1:t1", "reason": "launch command never ran" })
            .as_object()
            .unwrap()
            .clone()
    );
    assert_eq!(events[1].payload["try"], json!(2));
    assert_eq!(events[2].payload["tab_id"], json!("w1:t3"));
    until("the botched tabs closed", || {
        d.calls("tab.close").len() == 2
    })
    .await;
    assert_eq!(
        d.calls("tab.close"),
        [json!({ "tab_id": "w1:t1" }), json!({ "tab_id": "w1:t2" })]
    );
    until("the last pane closed", || !d.calls("pane.close").is_empty()).await;
    assert_eq!(d.calls("pane.close"), [json!({ "pane_id": "w1:p3" })]);
    // Never reported, still released at the ending.
    assert!(d.calls("pane.report_agent").is_empty());
    until("the agent release", || {
        !d.calls("pane.release_agent").is_empty()
    })
    .await;
}

#[tokio::test]
async fn no_pool_workspace_falls_back_to_headless_without_an_unplaced_tab() {
    let rig = rig();
    let d = daemon(String::new(), true, "$ ").await;
    let mut env = custom_terminal_env(&rig, &d.socket(), "stub");
    env.harnesses.insert_command("stub", rig.command("done"));
    env.pool_workspace = Arc::new(NoPoolWorkspace);
    let run = run_attempt(&env, rig.spec("stub"), validate).await.unwrap();
    assert!(run.ok());
    assert!(d.calls("tab.create").is_empty());
    let spawned = &rig.events()[0].payload;
    assert_eq!(spawned["pane_id"], Value::Null);
    assert_eq!(spawned["tab_id"], Value::Null);
    assert_eq!(
        spawned["terminal_error"],
        json!("no Pool workspace: the herdr daemon could not give this pool one at boot")
    );
    assert!(spawned["pid"].as_u64().is_some());
    // A terminal-backed pool's headless fallback still writes a Stream file.
    assert!(rig.exists("01.stream.jsonl"));
}

#[tokio::test]
async fn a_refused_tab_re_resolves_once_and_retries_or_falls_back() {
    let rig = rig();
    let d = daemon(format!("{}/01.stream.jsonl", rig.runs), true, "$ ").await;
    // The workspace the pool remembers is gone; the re-resolve finds w2.
    let mut env = custom_terminal_env(&rig, &d.socket(), "custom");
    let workspace = Arc::new(TestWorkspace::new(Some("gone"), Some("w2")));
    env.pool_workspace = workspace.clone();
    let handle = launch_attempt(&env, &rig.spec("custom")).await.unwrap();
    assert_eq!(handle.pane_id.as_deref(), Some("w2:p1"));
    assert_eq!(*workspace.reresolves.lock().unwrap(), ["gone"]);
    drop(handle);

    // No workspace to be had: the headless fallback, with the refusal on the spawned event.
    let rig = self::rig();
    let mut env = custom_terminal_env(&rig, &d.socket(), "stub");
    env.harnesses.insert_command("stub", rig.command("done"));
    env.pool_workspace = Arc::new(TestWorkspace::new(Some("gone"), None));
    let run = run_attempt(&env, rig.spec("stub"), validate).await.unwrap();
    assert!(run.ok());
    assert_eq!(
        rig.events()[0].payload["terminal_error"],
        json!("tab.create failed: {\"code\":-32001,\"message\":\"no such workspace gone\"}")
    );

    // A launch that must be a terminal fails instead, naming the half that failed.
    env.pool_workspace = Arc::new(TestWorkspace::new(Some("gone"), None));
    let mut spec = rig.spec("stub");
    spec.fallback = Fallback::None;
    let err = launch_attempt(&env, &spec).await.err().unwrap();
    assert!(
        err.to_string()
            .starts_with("could not open a herdr tab: tab.create failed: ")
    );
}

#[tokio::test]
async fn a_wrapper_that_cannot_be_sent_falls_back_to_headless_closing_the_pane() {
    let rig = rig();
    let fake = FakeHerdr::start(Options {
        workspaces: vec![json!({ "workspace_id": "w1" })],
        fail: vec![(
            "pane.send_input",
            json!({ "code": -1, "message": "input refused" }),
        )],
        ..Options::default()
    })
    .await;
    let socket = js::path_text(fake.herdr().socket_path());
    let mut env = custom_terminal_env(&rig, &socket, "stub");
    env.harnesses.insert_command("stub", rig.command("done"));
    let run = run_attempt(&env, rig.spec("stub"), validate).await.unwrap();
    assert!(run.ok());
    assert_eq!(run.pane_id, None);
    let spawned = &rig.events()[0].payload;
    assert_eq!(spawned["pane_id"], Value::Null);
    assert_eq!(spawned["tab_id"], Value::Null);
    assert!(!spawned.contains_key("terminal_id"));
    assert_eq!(
        spawned["terminal_error"],
        json!("pane.send_input failed: {\"code\":-1,\"message\":\"input refused\"}")
    );
    until("the half-started pane closed", || {
        fake.methods().iter().any(|method| method == "pane.close")
    })
    .await;
    rig.host.live(|live| assert!(!live.is_live("01")));
}

#[tokio::test]
async fn a_blocking_dialog_ends_the_launch_and_its_frame_reaches_the_empty_log() {
    let rig = rig();
    let mut frame = vec!["", "  "];
    frame.push("WARNING: Claude Code running in Bypass Permissions mode");
    let rows: Vec<String> = (1..=30).map(|n| format!("row {n}")).collect();
    frame.extend(rows.iter().map(String::as_str));
    frame.extend(["", "   "]);
    let frame = frame.join("\n");
    let d = daemon(format!("{}/01.stream.jsonl", rig.runs), true, &frame).await;
    // A harness named claude reads its descriptor's readiness, whatever command runs.
    let env = custom_terminal_env(&rig, &d.socket(), "claude");
    let run = run_attempt(&env, rig.spec("claude"), validate)
        .await
        .unwrap();
    assert_eq!(run.code, SPAWN_INTERACTIVE_READY_FAILED);
    assert_eq!(
        run.crash_reason.as_deref(),
        Some(
            "TUI never became ready: the bypass-permissions warning was on screen, which only the operator may answer"
        )
    );
    // The heading, then the frame's last 19 lines with its blank ends trimmed.
    let expected: Vec<String> = std::iter::once(PANE_FRAME_LOG_HEADING.to_owned())
        .chain((12..=30).map(|n| format!("row {n}")))
        .collect();
    assert_eq!(rig.file("01.log"), format!("{}\n", expected.join("\n")));
    assert_eq!(run.log_tail, expected);
    until("the botched pane closed", || {
        !d.calls("pane.close").is_empty()
    })
    .await;
    // The operator's own checkout is never seeded.
    assert!(!rig.events()[0].payload.contains_key("folder_trust"));
}

#[tokio::test]
async fn a_pool_worktree_is_seeded_for_claude_and_the_seed_rides_the_spawned_event() {
    let rig = rig();
    let worktree = format!("{}/pool-worktrees/abcd1234/01", rig.root);
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(format!("{}/claude.json", rig.root), "{\"projects\":{}}").unwrap();
    let mut env = custom_terminal_env(&rig, &format!("{}/no-herdr.sock", rig.root), "claude");
    env.harnesses.insert_command("claude", rig.command("done"));
    let mut spec = rig.spec("claude");
    spec.cwd = worktree.clone();
    run_attempt(&env, spec, validate).await.unwrap();
    let spawned = &rig.events()[0].payload;
    assert_eq!(spawned["folder_trust"], json!("seeded"));
    assert!(
        spawned["terminal_error"]
            .as_str()
            .unwrap()
            .starts_with("connect ENOENT ")
    );
    let config = js::parse(&rig_file(&rig, "claude.json")).unwrap();
    assert_eq!(
        config["projects"][&worktree]["hasTrustDialogAccepted"],
        true
    );

    // A seed that could not land says so, and the launch goes on.
    std::fs::remove_file(format!("{}/claude.json", rig.root)).unwrap();
    let mut spec = rig.spec("claude");
    spec.cwd = worktree;
    spec.attempt = 2;
    run_attempt(&env, spec, validate).await.unwrap();
    let spawned = rig
        .events()
        .into_iter()
        .filter(|event| event.kind == TicketEventKind::Spawned)
        .nth(1)
        .unwrap();
    assert_eq!(
        spawned.payload["folder_trust"],
        json!(format!("skipped: {}/claude.json does not exist", rig.root))
    );
}

fn rig_file(rig: &Rig, name: &str) -> String {
    js::read_text(format!("{}/{name}", rig.root)).unwrap()
}

#[test]
fn the_frame_block_keeps_at_most_nineteen_lines_under_its_heading() {
    let frame: Vec<String> = (1..=25).map(|n| format!("line {n}")).collect();
    let block = pane_frame_log_block(&format!("\n \n{}\n\n", frame.join("\n")));
    let lines: Vec<&str> = block.lines().collect();
    assert_eq!(lines.len(), 20);
    assert_eq!(lines[0], PANE_FRAME_LOG_HEADING);
    assert_eq!(lines[1], "line 7");
    assert_eq!(lines[19], "line 25");
    assert!(block.ends_with("line 25\n"));
    assert_eq!(
        pane_frame_log_block("  only\n"),
        format!("{PANE_FRAME_LOG_HEADING}\n  only\n")
    );
}

#[test]
fn the_log_tail_is_the_last_twenty_lines_without_the_closing_newline() {
    let rig = rig();
    let log = format!("{}/x.log", rig.runs);
    assert!(read_log_tail(&log).is_empty());
    let text: String = (1..=25).map(|n| format!("{n}\n")).collect();
    std::fs::write(&log, text).unwrap();
    let tail = read_log_tail(&log);
    assert_eq!(tail.len(), 20);
    assert_eq!(tail[0], "6");
    assert_eq!(tail[19], "25");
}

#[test]
fn the_stream_path_follows_the_pool_and_the_harness() {
    assert_eq!(
        attempt_stream_path("/r", "01", "opencode", None, false, true).as_deref(),
        Some("/r/01.stream.jsonl")
    );
    assert_eq!(
        attempt_stream_path("/r", "01", "opencode", None, false, false),
        None
    );
    assert_eq!(
        attempt_stream_path("/r", "01", "claude", Some(2), true, false).as_deref(),
        Some("/r/01.attempt-2.resolver.stream.jsonl")
    );
}

#[tokio::test]
async fn the_pane_tailer_reads_from_an_offset_and_reassembles_split_writes() {
    let rig = rig();
    let stream = format!("{}/01.stream.jsonl", rig.runs);
    let log = format!("{}/01.log", rig.runs);
    std::fs::write(&stream, "before the continued attempt\r\n").unwrap();
    let offset = std::fs::metadata(&stream).unwrap().len();
    let tailer = start_pane_stream_tail(&stream, &log, offset);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&stream)
        .unwrap();
    file.write_all("half a li".as_bytes()).unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    file.write_all("ne é\x1b[3".as_bytes()).unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    file.write_all(b"2mgreen\x1b[0m\r\ntail").unwrap();
    tailer.finish().await.unwrap();
    assert_eq!(js::read_text(&log).unwrap(), "half a line égreen\ntail\n");
}
