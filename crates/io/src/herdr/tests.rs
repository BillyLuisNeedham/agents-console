//! The herdr client against a fake daemon on a real unix socket: the behaviours of engine/herdr.test.ts
//! a unit test can reach, and the hidden rows the conformance inventory gives this module (a pane-end
//! wait released mid-connect, and one released before it starts).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::fake::{FakeHerdr, Options, Recorded, Reply, Script, until};
use super::*;

fn recorded(method: &str, params: Value) -> Recorded {
    Recorded {
        method: method.to_owned(),
        params,
    }
}

fn workspace(workspace_id: &str) -> Value {
    json!({ "workspace_id": workspace_id })
}

fn pane(tab_id: &str, pane_id: &str) -> Value {
    json!({ "tab_id": tab_id, "pane_id": pane_id })
}

/// A live pane for a wait to subscribe about: the liveness check on the subscription's acknowledgement
/// settles exited for any pane the listing does not hold.
fn live_pane() -> Vec<Value> {
    vec![pane("tab-1", "pane-1")]
}

fn script(pick: impl Fn(&str, &Value) -> Option<Reply> + Send + Sync + 'static) -> Option<Script> {
    Some(Arc::new(pick))
}

/// A fake that answers every call with this one line.
async fn answering(line: impl Into<String>) -> FakeHerdr {
    let line = line.into();
    FakeHerdr::start(Options {
        script: script(move |_, _| Some(Reply::Line(line.clone()))),
        ..Options::default()
    })
    .await
}

async fn fake_with(options: Options) -> FakeHerdr {
    FakeHerdr::start(options).await
}

fn calls_of(fake: &FakeHerdr, method: &str) -> Vec<Value> {
    fake.requests()
        .into_iter()
        .filter(|request| request.method == method)
        .map(|request| request.params)
        .collect()
}

/// Subscribed and past the liveness check: from here the only thing that can settle the wait is what the
/// test does next.
async fn subscribed_and_checked(fake: &FakeHerdr) {
    until("the subscriber connect", || fake.subscribers() == 1).await;
    until("the liveness check", || {
        fake.methods().iter().any(|method| method == "pane.list")
    })
    .await;
}

fn spawn_wait(
    herdr: &Herdr,
    pane_id: &str,
    release: Option<CancellationToken>,
) -> JoinHandle<PaneEnd> {
    let herdr = herdr.clone();
    let pane_id = pane_id.to_owned();
    tokio::spawn(async move { herdr.wait_for_pane_end(&pane_id, release.as_ref()).await })
}

fn error_text<T: std::fmt::Debug>(settled: Result<T, HerdrError>) -> String {
    settled.expect_err("the call fails").to_string()
}

// attemptTabLabel

#[test]
fn attempt_tab_label_joins_the_ticket_id_and_title_with_the_middle_dot() {
    assert_eq!(
        attempt_tab_label("01", "Named herdr tabs"),
        "01 · Named herdr tabs"
    );
}

#[test]
fn attempt_tab_label_truncates_to_the_label_cap() {
    let label = attempt_tab_label("07", &"x".repeat(60));
    assert_eq!(
        label,
        format!("07 · {}", "x".repeat(ATTEMPT_TAB_LABEL_MAX - 5))
    );
    assert_eq!(label.chars().count(), ATTEMPT_TAB_LABEL_MAX);
}

#[test]
fn attempt_tab_label_keeps_an_exactly_capped_label_whole() {
    let title = "x".repeat(ATTEMPT_TAB_LABEL_MAX - 5);
    assert_eq!(attempt_tab_label("07", &title), format!("07 · {title}"));
}

#[test]
fn attempt_tab_label_trims_the_title_and_counts_as_javascript_does() {
    assert_eq!(
        attempt_tab_label("01", "  Spaced title \n"),
        "01 · Spaced title"
    );
    // An emoji is two UTF-16 units: 33 x and one emoji fill the cap exactly...
    let fits = format!("{}😀", "x".repeat(33));
    assert_eq!(attempt_tab_label("01", &fits), format!("01 · {fits}"));
    // ...and one that would straddle it goes whole rather than in half.
    let straddles = format!("{}😀", "x".repeat(34));
    assert_eq!(
        attempt_tab_label("01", &straddles),
        format!("01 · {}", "x".repeat(34))
    );
}

// The socket default, computed at the CLI boundary

#[test]
fn default_socket_path_prefers_herdr_socket_path_and_falls_back_to_the_config_dir() {
    let home = Path::new("/home/op");
    let config = PathBuf::from("/home/op/.config/herdr/herdr.sock");
    assert_eq!(
        default_socket_path(Some("/run/herdr.sock"), home),
        PathBuf::from("/run/herdr.sock")
    );
    assert_eq!(
        default_socket_path(Some("  /run/herdr.sock\n"), home),
        PathBuf::from("/run/herdr.sock")
    );
    assert_eq!(default_socket_path(Some("   "), home), config);
    assert_eq!(default_socket_path(Some(""), home), config);
    assert_eq!(default_socket_path(None, home), config);
}

#[test]
fn names_its_states_and_origins_as_the_typescript_does() {
    assert_eq!(PaneEnd::Exited.as_str(), "exited");
    assert_eq!(PaneEnd::Closed.as_str(), "closed");
    assert_eq!(PaneEnd::Lost.as_str(), "lost");
    assert_eq!(PaneAgentState::Working.as_str(), "working");
    assert_eq!(PaneAgentState::Blocked.as_str(), "blocked");
    assert_eq!(PoolWorkspaceOrigin::Remembered.as_str(), "remembered");
    assert_eq!(PoolWorkspaceOrigin::Launch.as_str(), "launch");
    assert_eq!(PoolWorkspaceOrigin::Created.as_str(), "created");
    assert_eq!(PANE_AGENT_SOURCE, "herdr:agent-console");
}

// herdrRpc

#[tokio::test]
async fn rpc_sends_one_request_per_connection_and_resolves_the_result() {
    let fake = fake_with(Options::default()).await;
    let herdr = fake.herdr();
    let first = herdr.rpc("pane.list", json!({})).await;
    let second = herdr.rpc("pane.list", json!({})).await;
    // One connection per call, exactly as the daemon's protocol demands.
    assert_eq!(fake.connections(), 2);
    assert_eq!(first, Ok(Some(json!({ "panes": [] }))));
    assert_eq!(second, Ok(Some(json!({ "panes": [] }))));
    assert_eq!(
        fake.requests(),
        vec![
            recorded("pane.list", json!({})),
            recorded("pane.list", json!({}))
        ]
    );
    until("every answered connection close", || {
        fake.open_connections() == 0
    })
    .await;
}

#[tokio::test]
async fn rpc_rejects_with_the_herdr_error_body() {
    let fake = fake_with(Options {
        fail: vec![(
            "pane.list",
            json!({ "code": -1, "message": "daemon says no" }),
        )],
        ..Options::default()
    })
    .await;
    assert_eq!(
        error_text(fake.herdr().rpc("pane.list", json!({})).await),
        r#"pane.list failed: {"code":-1,"message":"daemon says no"}"#
    );
}

#[tokio::test]
async fn rpc_settles_on_the_first_line_while_the_daemon_holds_the_connection_open() {
    let fake = fake_with(Options {
        script: script(|_, _| {
            Some(Reply::LineKeepOpen(
                r#"{"id":"1","result":{"type":"ok"}}"#.to_owned(),
            ))
        }),
        ..Options::default()
    })
    .await;
    let settled = tokio::time::timeout(
        Duration::from_secs(5),
        fake.herdr().rpc("pane.focus", json!({ "pane_id": "p1" })),
    )
    .await
    .expect("the first line settles the call, not the close");
    assert_eq!(settled, Ok(Some(json!({ "type": "ok" }))));
    // And the client lets the held connection go.
    until("the client hang up", || fake.open_connections() == 0).await;
}

#[tokio::test]
async fn rpc_settles_from_an_answer_the_daemon_ends_without_a_newline() {
    let fake = fake_with(Options {
        script: script(|_, _| {
            Some(Reply::Bytes(
                br#"{"id":"1","result":{"type":"ok"}}"#.to_vec(),
            ))
        }),
        ..Options::default()
    })
    .await;
    assert_eq!(
        fake.herdr()
            .rpc("pane.focus", json!({ "pane_id": "p1" }))
            .await,
        Ok(Some(json!({ "type": "ok" })))
    );
}

#[tokio::test]
async fn rpc_fails_on_an_answer_that_does_not_parse() {
    let fake = answering("<html>not herdr</html>").await;
    assert_eq!(
        error_text(
            fake.herdr()
                .rpc("pane.focus", json!({ "pane_id": "p1" }))
                .await
        ),
        "bad herdr response for pane.focus: <html>not herdr</html>"
    );
}

#[tokio::test]
async fn rpc_fails_when_the_daemon_hangs_up_without_answering() {
    let fake = fake_with(Options {
        script: script(|_, _| Some(Reply::Close)),
        ..Options::default()
    })
    .await;
    assert_eq!(
        error_text(
            fake.herdr()
                .rpc("pane.focus", json!({ "pane_id": "p1" }))
                .await
        ),
        "bad herdr response for pane.focus: "
    );
}

#[tokio::test(start_paused = true)]
async fn rpc_times_out_after_ten_seconds_on_a_daemon_that_never_answers() {
    let fake = fake_with(Options {
        script: script(|_, _| Some(Reply::Hang)),
        ..Options::default()
    })
    .await;
    let began = tokio::time::Instant::now();
    let settled = fake
        .herdr()
        .rpc("pane.focus", json!({ "pane_id": "p1" }))
        .await;
    assert_eq!(error_text(settled), "herdr rpc timed out (pane.focus)");
    assert!(began.elapsed() >= Duration::from_secs(10));
    assert_eq!(fake.methods(), vec!["pane.focus"]);
    // The timed-out call lets its connection go.
    until("the client hang up", || fake.open_connections() == 0).await;
}

/// Bind a unix socket and drop its listener, leaving the file behind with nobody listening. Another test
/// of this binary may fork a child while the listener's descriptor is open, and that child keeps the
/// socket listening until it execs, so wait until the kernel really refuses connections before returning.
fn leave_a_stale_socket(path: &std::path::Path) {
    drop(std::os::unix::net::UnixListener::bind(path).unwrap());
    assert!(path.exists());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::os::unix::net::UnixStream::connect(path).is_ok() {
        assert!(
            std::time::Instant::now() < deadline,
            "the dropped listener still accepts connections"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[tokio::test]
async fn rpc_fails_with_buns_connect_text_when_no_daemon_listens() {
    let dir = tempfile::tempdir().unwrap();
    let absent = dir.path().join("absent.sock");
    assert_eq!(
        error_text(Herdr::new(&absent).rpc("pane.focus", json!({})).await),
        format!("connect ENOENT {}", absent.display())
    );
    // A socket file nobody listens on any more (the kernel's ECONNREFUSED) reads the same under Bun.
    let stale = dir.path().join("stale.sock");
    leave_a_stale_socket(&stale);
    assert_eq!(
        error_text(Herdr::new(&stale).rpc("pane.focus", json!({})).await),
        format!("connect ENOENT {}", stale.display())
    );
}

// openAttemptTab

#[tokio::test]
async fn open_attempt_tab_creates_an_unfocused_tab_in_the_pool_workspace_and_takes_the_pane_off_root_pane()
 {
    let fake = fake_with(Options {
        workspaces: vec![workspace("w7")],
        foreign_panes: vec![pane("tab-foreign", "pane-foreign")],
        ..Options::default()
    })
    .await;
    let tab = fake
        .herdr()
        .open_attempt_tab("01 · Named herdr tabs", "/work/tree", "w7")
        .await
        .unwrap();
    // The ids the daemon minted inside the named workspace (issue #94): the tab landed in the Pool
    // workspace, not wherever herdr's focus was.
    assert_eq!(
        tab,
        AttemptTab {
            tab_id: "w7:t1".to_owned(),
            pane_id: "w7:p1".to_owned(),
            terminal_id: None,
        }
    );
    // One call, and only one: protocol 20 answers tab.create with `tab_created { tab, root_pane }`.
    let requests = fake.requests();
    assert_eq!(
        requests,
        vec![recorded(
            "tab.create",
            json!({ "label": "01 · Named herdr tabs", "focus": false, "cwd": "/work/tree", "workspace_id": "w7" }),
        )]
    );
    assert_eq!(
        requests[0].params.to_string(),
        r#"{"label":"01 · Named herdr tabs","focus":false,"cwd":"/work/tree","workspace_id":"w7"}"#
    );
}

#[tokio::test]
async fn open_attempt_tab_fails_when_tab_create_returns_an_error() {
    let fake = fake_with(Options {
        workspaces: vec![workspace("w7")],
        fail: vec![(
            "tab.create",
            json!({ "code": -1, "message": "no daemon here" }),
        )],
        ..Options::default()
    })
    .await;
    assert_eq!(
        error_text(
            fake.herdr()
                .open_attempt_tab("01 · Named herdr tabs", "/work/tree", "w7")
                .await
        ),
        r#"tab.create failed: {"code":-1,"message":"no daemon here"}"#
    );
}

#[tokio::test]
async fn open_attempt_tab_fails_when_the_pool_workspace_is_gone() {
    // The operator closed it mid-run: the daemon refuses the tab, and the caller re-resolves once before
    // falling back.
    let fake = fake_with(Options {
        workspaces: vec![workspace("w7")],
        ..Options::default()
    })
    .await;
    fake.remove_workspace("w7");
    assert_eq!(
        error_text(
            fake.herdr()
                .open_attempt_tab("01 · Named herdr tabs", "/work/tree", "w7")
                .await
        ),
        r#"tab.create failed: {"code":-32001,"message":"no such workspace w7"}"#
    );
}

#[tokio::test]
async fn open_attempt_tab_fails_when_the_answer_carries_no_root_pane() {
    // A daemon older than protocol 20: the tab exists but its pane id is unknowable.
    let fake = fake_with(Options {
        workspaces: vec![workspace("w7")],
        root_paneless: true,
        ..Options::default()
    })
    .await;
    assert_eq!(
        error_text(
            fake.herdr()
                .open_attempt_tab("01 · Named herdr tabs", "/work/tree", "w7")
                .await
        ),
        r#"tab.create returned no root pane id: {"type":"tab_created","tab":{"tab_id":"w7:t1","workspace_id":"w7"}}"#
    );
}

#[tokio::test]
async fn open_attempt_tab_takes_the_root_pane_terminal_id_off_an_answer_that_carries_one() {
    let fake = answering(
        r#"{"id":"1","result":{"type":"tab_created","tab":{"tab_id":"w7:t1"},"root_pane":{"pane_id":"w7:p1","tab_id":"w7:t1","terminal_id":"term_65b1"}}}"#,
    )
    .await;
    assert_eq!(
        fake.herdr().open_attempt_tab("01 · x", "/w", "w7").await,
        Ok(AttemptTab {
            tab_id: "w7:t1".to_owned(),
            pane_id: "w7:p1".to_owned(),
            terminal_id: Some("term_65b1".to_owned()),
        })
    );
}

#[tokio::test]
async fn open_attempt_tab_fails_when_the_answer_carries_no_tab_id() {
    // No result at all is JavaScript's undefined, printed as such.
    let fake = answering(r#"{"id":"1"}"#).await;
    assert_eq!(
        error_text(fake.herdr().open_attempt_tab("01 · x", "/w", "w7").await),
        "tab.create returned no tab id: undefined"
    );
    let fake =
        answering(r#"{"id":"1","result":{"tab":{"tab_id":""},"root_pane":{"pane_id":"p1"}}}"#)
            .await;
    assert_eq!(
        error_text(fake.herdr().open_attempt_tab("01 · x", "/w", "w7").await),
        r#"tab.create returned no tab id: {"tab":{"tab_id":""},"root_pane":{"pane_id":"p1"}}"#
    );
}

// resolvePoolWorkspace

const CANDIDATES: PoolWorkspaceCandidates<'static> = PoolWorkspaceCandidates {
    remembered: Some("wR"),
    launch: Some("wL"),
    label: "pool",
    cwd: "/repo",
};

#[tokio::test]
async fn resolve_pool_workspace_keeps_the_remembered_workspace_when_it_is_still_there() {
    let fake = fake_with(Options {
        workspaces: vec![workspace("wR"), workspace("wL")],
        ..Options::default()
    })
    .await;
    assert_eq!(
        fake.herdr().resolve_pool_workspace(&CANDIDATES).await,
        Ok(PoolWorkspaceResolution {
            workspace_id: "wR".to_owned(),
            origin: PoolWorkspaceOrigin::Remembered,
        })
    );
    // Confirmed before it is used, and nothing else asked: no listing, no path matching, no create.
    assert_eq!(
        fake.requests(),
        vec![recorded("workspace.get", json!({ "workspace_id": "wR" }))]
    );
}

#[tokio::test]
async fn resolve_pool_workspace_falls_to_the_launch_workspace_when_the_remembered_one_is_gone() {
    let fake = fake_with(Options {
        workspaces: vec![workspace("wR"), workspace("wL")],
        ..Options::default()
    })
    .await;
    fake.remove_workspace("wR");
    assert_eq!(
        fake.herdr().resolve_pool_workspace(&CANDIDATES).await,
        Ok(PoolWorkspaceResolution {
            workspace_id: "wL".to_owned(),
            origin: PoolWorkspaceOrigin::Launch,
        })
    );
    assert_eq!(
        fake.requests(),
        vec![
            recorded("workspace.get", json!({ "workspace_id": "wR" })),
            recorded("workspace.get", json!({ "workspace_id": "wL" })),
        ]
    );
}

#[tokio::test]
async fn resolve_pool_workspace_creates_one_unfocused_and_labelled_for_the_pool_when_neither_holds()
{
    let fake = fake_with(Options::default()).await;
    assert_eq!(
        fake.herdr().resolve_pool_workspace(&CANDIDATES).await,
        Ok(PoolWorkspaceResolution {
            workspace_id: "w1".to_owned(),
            origin: PoolWorkspaceOrigin::Created,
        })
    );
    let requests = fake.requests();
    assert_eq!(
        requests.last(),
        Some(&recorded(
            "workspace.create",
            json!({ "label": "pool", "cwd": "/repo", "focus": false }),
        ))
    );
    assert_eq!(
        requests.last().unwrap().params.to_string(),
        r#"{"label":"pool","cwd":"/repo","focus":false}"#
    );
}

#[tokio::test]
async fn resolve_pool_workspace_creates_one_when_the_pool_remembers_nothing_and_was_not_launched_in_one()
 {
    let fake = fake_with(Options::default()).await;
    let candidates = PoolWorkspaceCandidates {
        remembered: None,
        launch: None,
        ..CANDIDATES
    };
    assert_eq!(
        fake.herdr().resolve_pool_workspace(&candidates).await,
        Ok(PoolWorkspaceResolution {
            workspace_id: "w1".to_owned(),
            origin: PoolWorkspaceOrigin::Created,
        })
    );
    // No candidate to confirm, so nothing but the create.
    assert_eq!(fake.methods(), vec!["workspace.create"]);
}

#[tokio::test]
async fn resolve_pool_workspace_skips_an_empty_candidate_as_it_skips_a_missing_one() {
    let fake = fake_with(Options::default()).await;
    let candidates = PoolWorkspaceCandidates {
        remembered: Some(""),
        launch: Some(""),
        ..CANDIDATES
    };
    assert_eq!(
        fake.herdr()
            .resolve_pool_workspace(&candidates)
            .await
            .map(|resolution| resolution.origin),
        Ok(PoolWorkspaceOrigin::Created)
    );
    assert_eq!(fake.methods(), vec!["workspace.create"]);
}

#[tokio::test]
async fn resolve_pool_workspace_rejects_when_the_daemon_will_not_create_one_either() {
    let fake = fake_with(Options {
        fail: vec![(
            "workspace.create",
            json!({ "code": -1, "message": "daemon says no" }),
        )],
        ..Options::default()
    })
    .await;
    let candidates = PoolWorkspaceCandidates {
        remembered: None,
        launch: None,
        ..CANDIDATES
    };
    assert_eq!(
        error_text(fake.herdr().resolve_pool_workspace(&candidates).await),
        r#"workspace.create failed: {"code":-1,"message":"daemon says no"}"#
    );
}

#[tokio::test]
async fn resolve_pool_workspace_rejects_a_created_answer_without_a_workspace_id() {
    let fake = answering(r#"{"id":"1","result":{"type":"ok"}}"#).await;
    let candidates = PoolWorkspaceCandidates {
        remembered: None,
        launch: None,
        ..CANDIDATES
    };
    assert_eq!(
        error_text(fake.herdr().resolve_pool_workspace(&candidates).await),
        r#"workspace.create returned no workspace id: {"type":"ok"}"#
    );
}

// relabelWorkspace and workspaceExists

#[tokio::test]
async fn relabel_workspace_renames_the_workspace_by_id_with_workspace_rename() {
    let fake = fake_with(Options {
        workspaces: vec![json!({ "workspace_id": "w1", "label": "old" })],
        ..Options::default()
    })
    .await;
    assert_eq!(
        fake.herdr()
            .relabel_workspace("w1", "Jev as the grader")
            .await,
        Ok(())
    );
    assert_eq!(
        fake.requests(),
        vec![recorded(
            "workspace.rename",
            json!({ "workspace_id": "w1", "label": "Jev as the grader" }),
        )]
    );
    assert_eq!(fake.workspaces()[0]["label"], "Jev as the grader");
}

#[tokio::test]
async fn relabel_workspace_rejects_when_the_daemon_holds_no_such_workspace() {
    let fake = fake_with(Options::default()).await;
    assert_eq!(
        error_text(fake.herdr().relabel_workspace("w9", "x").await),
        r#"workspace.rename failed: {"code":-32001,"message":"no such workspace w9"}"#
    );
}

#[tokio::test]
async fn workspace_exists_only_for_a_workspace_the_daemon_answers_with() {
    let fake = fake_with(Options {
        workspaces: vec![workspace("w7")],
        ..Options::default()
    })
    .await;
    assert!(fake.herdr().workspace_exists("w7").await);
    assert!(!fake.herdr().workspace_exists("w8").await);
    let empty = answering(r#"{"id":"1","result":{"workspace":{"workspace_id":""}}}"#).await;
    assert!(!empty.herdr().workspace_exists("w7").await);
    let dir = tempfile::tempdir().unwrap();
    assert!(
        !Herdr::new(dir.path().join("absent.sock"))
            .workspace_exists("w7")
            .await
    );
}

// listPaneIds

#[tokio::test]
async fn list_pane_ids_scopes_the_listing_to_the_pool_workspace_when_one_is_known() {
    let fake = fake_with(Options {
        workspaces: vec![workspace("w7")],
        ..Options::default()
    })
    .await;
    let herdr = fake.herdr();
    let mine = herdr
        .open_attempt_tab("01 · Mine", "/w", "w7")
        .await
        .unwrap();
    // A pane of another workspace: the daemon serves every one of them, and the scope is what keeps
    // this pool's reconciliation to its own.
    fake.add_workspace(workspace("w8"));
    herdr
        .open_attempt_tab("02 · Theirs", "/w", "w8")
        .await
        .unwrap();
    assert_eq!(
        herdr.list_pane_ids(Some("w7")).await,
        Ok(vec![mine.pane_id])
    );
    assert_eq!(herdr.list_pane_ids(None).await.unwrap().len(), 2);
    assert_eq!(
        calls_of(&fake, "pane.list"),
        vec![json!({ "workspace_id": "w7" }), json!({})]
    );
}

#[tokio::test]
async fn list_pane_ids_reads_an_answer_without_panes_as_none_and_skips_unnamed_entries() {
    let fake = answering(r#"{"id":"1","result":{"type":"ok"}}"#).await;
    assert_eq!(fake.herdr().list_pane_ids(None).await, Ok(Vec::new()));
    let fake =
        answering(r#"{"id":"1","result":{"panes":[{"pane_id":"p1"},null,{"pane_id":7},"p2",{"tab_id":"t"}]}}"#)
            .await;
    assert_eq!(
        fake.herdr().list_pane_ids(None).await,
        Ok(vec!["p1".to_owned()])
    );
}

// Pane agent reporting

#[tokio::test]
async fn reports_the_agent_under_the_engines_own_source_with_a_monotonic_seq() {
    let fake = fake_with(Options::default()).await;
    let herdr = fake.herdr();
    herdr
        .report_pane_agent("pane-1", "claude", PaneAgentState::Working, "01 · t")
        .await
        .unwrap();
    herdr
        .report_pane_agent("pane-1", "claude", PaneAgentState::Blocked, "01 · t")
        .await
        .unwrap();
    let reports = calls_of(&fake, "pane.report_agent");
    assert_eq!(reports.len(), 2);
    let keys: Vec<&str> = reports[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["pane_id", "source", "agent", "state", "seq", "message"]
    );
    assert_eq!(reports[0]["pane_id"], "pane-1");
    assert_eq!(reports[0]["source"], PANE_AGENT_SOURCE);
    assert_eq!(reports[0]["agent"], "claude");
    assert_eq!(reports[0]["state"], "working");
    assert_eq!(reports[0]["message"], "01 · t");
    assert_eq!(reports[1]["state"], "blocked");
    let first = reports[0]["seq"].as_u64().expect("seq is a number");
    let second = reports[1]["seq"].as_u64().expect("seq is a number");
    assert!(second > first);
    // Seeded from the clock, in milliseconds.
    assert!(first > 1_600_000_000_000);
}

#[tokio::test]
async fn releases_the_agent_under_the_same_source() {
    let fake = fake_with(Options::default()).await;
    fake.herdr()
        .release_pane_agent("pane-1", "claude")
        .await
        .unwrap();
    assert_eq!(
        fake.requests(),
        vec![recorded(
            "pane.release_agent",
            json!({ "pane_id": "pane-1", "source": PANE_AGENT_SOURCE, "agent": "claude" }),
        )]
    );
}

#[tokio::test]
async fn rejects_when_the_daemon_refuses_the_report_so_the_caller_can_swallow_it() {
    let fake = fake_with(Options {
        fail: vec![(
            "pane.report_agent",
            json!({ "code": -1, "message": "no such pane" }),
        )],
        ..Options::default()
    })
    .await;
    assert_eq!(
        error_text(
            fake.herdr()
                .report_pane_agent("pane-1", "claude", PaneAgentState::Working, "01 · t")
                .await
        ),
        r#"pane.report_agent failed: {"code":-1,"message":"no such pane"}"#
    );
}

// peekPane and the plain calls

#[tokio::test]
async fn peek_pane_reads_the_visible_viewport_or_recent_rows_as_text() {
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        ..Options::default()
    })
    .await;
    let herdr = fake.herdr();
    assert_eq!(
        herdr.peek_pane("pane-1", PaneReadSource::Visible).await,
        Ok("$ ".to_owned())
    );
    assert_eq!(
        herdr
            .peek_pane("pane-1", PaneReadSource::Recent { lines: 80 })
            .await,
        Ok("$ ".to_owned())
    );
    let reads = calls_of(&fake, "pane.read");
    // A visible read takes no line count; herdr sizes it to the pane.
    assert_eq!(
        reads[0].to_string(),
        r#"{"pane_id":"pane-1","source":"visible","format":"text","strip_ansi":true}"#
    );
    assert_eq!(
        reads[1].to_string(),
        r#"{"pane_id":"pane-1","source":"recent","format":"text","strip_ansi":true,"lines":80}"#
    );
    assert_eq!(
        error_text(herdr.peek_pane("nope", PaneReadSource::Visible).await),
        r#"pane.read failed: {"code":-32000,"message":"pane nope not found"}"#
    );
}

#[tokio::test]
async fn peek_pane_reads_an_answer_without_text_as_empty() {
    for answer in [
        r#"{"id":"1","result":{"read":{"revision":0}}}"#,
        r#"{"id":"1","result":{"read":"text"}}"#,
        r#"{"id":"1"}"#,
    ] {
        let fake = answering(answer).await;
        assert_eq!(
            fake.herdr().peek_pane("p1", PaneReadSource::Visible).await,
            Ok(String::new()),
            "{answer}"
        );
    }
}

#[tokio::test]
async fn the_plain_calls_send_their_method_and_params() {
    let fake = fake_with(Options::default()).await;
    let herdr = fake.herdr();
    herdr.focus_pane("p1").await.unwrap();
    herdr
        .pane_send_input("p1", &PaneInput::text("bash -c 'x'").and_keys(["enter"]))
        .await
        .unwrap();
    herdr
        .pane_send_input("p1", &PaneInput::keys(["down"]))
        .await
        .unwrap();
    herdr
        .pane_send_input("p1", &PaneInput::text("pasted"))
        .await
        .unwrap();
    herdr.relabel_tab("t1", "01 · Enlisted").await.unwrap();
    herdr.close_pane("p1").await.unwrap();
    herdr.close_tab("t1").await.unwrap();
    let requests = fake.requests();
    assert_eq!(
        requests,
        vec![
            recorded("pane.focus", json!({ "pane_id": "p1" })),
            recorded(
                "pane.send_input",
                json!({ "pane_id": "p1", "text": "bash -c 'x'", "keys": ["enter"] }),
            ),
            recorded(
                "pane.send_input",
                json!({ "pane_id": "p1", "keys": ["down"] })
            ),
            recorded(
                "pane.send_input",
                json!({ "pane_id": "p1", "text": "pasted" })
            ),
            recorded(
                "tab.rename",
                json!({ "tab_id": "t1", "label": "01 · Enlisted" })
            ),
            recorded("pane.close", json!({ "pane_id": "p1" })),
            recorded("tab.close", json!({ "tab_id": "t1" })),
        ]
    );
    // The text travels before its keys, as herdr applies them.
    assert_eq!(
        requests[1].params.to_string(),
        r#"{"pane_id":"p1","text":"bash -c 'x'","keys":["enter"]}"#
    );
    // Every one of them on its own connection.
    assert_eq!(fake.connections(), 7);
}

// listPanes and listAgents (issue #139)

#[tokio::test]
async fn list_panes_reads_each_panes_tab_workspace_directory_and_terminal_id() {
    let fake = fake_with(Options {
        foreign_panes: vec![
            json!({ "tab_id": "t1", "pane_id": "p1", "workspace_id": "w1" }),
            // herdr 0.8.2's own fields, beyond the fake's usual three.
            json!({ "tab_id": "w7:t1", "pane_id": "w7:p1", "workspace_id": "w7", "cwd": "/w", "terminal_id": "term_65b1" }),
        ],
        ..Options::default()
    })
    .await;
    assert_eq!(
        fake.herdr().list_panes().await,
        Ok(vec![
            HerdrPane {
                pane_id: "p1".to_owned(),
                tab_id: Some("t1".to_owned()),
                workspace_id: Some("w1".to_owned()),
                cwd: None,
                terminal_id: None,
            },
            HerdrPane {
                pane_id: "w7:p1".to_owned(),
                tab_id: Some("w7:t1".to_owned()),
                workspace_id: Some("w7".to_owned()),
                cwd: Some("/w".to_owned()),
                terminal_id: Some("term_65b1".to_owned()),
            },
        ])
    );
    assert_eq!(calls_of(&fake, "pane.list"), vec![json!({})]);
}

#[tokio::test]
async fn list_panes_throws_on_an_answer_with_no_panes_list_rather_than_reading_it_as_none() {
    let fake = answering(r#"{"id":"1","result":{"type":"ok"}}"#).await;
    assert_eq!(
        error_text(fake.herdr().list_panes().await),
        r#"pane.list answered without a panes list: {"type":"ok"}"#
    );
}

#[tokio::test]
async fn list_agents_throws_when_agent_list_answers_without_an_agents_list() {
    let fake = answering(r#"{"id":"1","result":{}}"#).await;
    assert_eq!(
        error_text(fake.herdr().list_agents().await),
        "agent.list answered without an agents list: {}"
    );
}

#[tokio::test]
async fn list_agents_reads_each_agent_with_herdrs_fallback_fields() {
    let fake = answering(
        r#"{"id":"1","result":{"type":"agent_list","agents":[
            {"pane_id":"p1","tab_id":"t1","agent":"claude","agent_status":"idle","terminal_title":"T","terminal_title_stripped":"S","title":"x","name":"y","cwd":"/a","foreground_cwd":"/b","session_id":"s1","session":"s9"},
            {"pane_id":"p2","name":"N","foreground_cwd":"/f","session":"s2"},
            {"pane_id":"p3","terminal_title":"","name":"N3","agent_status":7},
            {"tab_id":"no pane"},
            {"pane_id":7},
            "p4",
            null
        ]}}"#
            .lines()
            .map(str::trim)
            .collect::<String>(),
    )
    .await;
    assert_eq!(
        fake.herdr().list_agents().await,
        Ok(vec![
            HerdrAgent {
                pane_id: "p1".to_owned(),
                tab_id: Some("t1".to_owned()),
                harness: Some("claude".to_owned()),
                status: "idle".to_owned(),
                title: "T".to_owned(),
                directory: Some("/a".to_owned()),
                session_id: Some("s1".to_owned()),
            },
            HerdrAgent {
                pane_id: "p2".to_owned(),
                tab_id: None,
                harness: None,
                status: "unknown".to_owned(),
                title: "N".to_owned(),
                directory: Some("/f".to_owned()),
                session_id: Some("s2".to_owned()),
            },
            // An empty title is a title: the fallbacks are for a field that is not a string.
            HerdrAgent {
                pane_id: "p3".to_owned(),
                tab_id: None,
                harness: None,
                status: "unknown".to_owned(),
                title: String::new(),
                directory: None,
                session_id: None,
            },
        ])
    );
    assert_eq!(calls_of(&fake, "agent.list"), vec![json!({})]);
}

// isTabNotFound

#[test]
fn reads_herdrs_tab_not_found_as_a_tab_already_gone() {
    assert!(is_tab_not_found(
        r#"tab.close failed: {"code":-32000,"message":"tab_not_found: w7:t1"}"#
    ));
    assert!(!is_tab_not_found("tab.close failed: refused"));
    assert!(is_tab_not_found(HerdrError::new(
        "tab.close failed: TAB w7:t1 Not Found"
    )));
    assert!(is_tab_not_found("tab.close failed: No such tab"));
    // `.` stops at a line break, as JavaScript's does.
    assert!(!is_tab_not_found("tab w7:t1\nnot found"));
    // Case folds in ASCII only: the long s is no s to a JavaScript regex without the u flag.
    assert!(!is_tab_not_found("no ſuch tab"));
}

// waitForPaneEnd

#[tokio::test]
async fn wait_for_pane_end_settles_exited_on_the_panes_own_exit_event() {
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        ..Options::default()
    })
    .await;
    let ending = spawn_wait(&fake.herdr(), "pane-1", None);
    subscribed_and_checked(&fake).await;
    // The subscription names every end the daemon can report; the filtering by pane is the client's
    // job, since every subscriber sees every pane.
    let subscribe = &fake.requests()[0];
    assert_eq!(subscribe.method, "events.subscribe");
    assert_eq!(
        subscribe.params.to_string(),
        r#"{"subscriptions":[{"type":"pane.exited"},{"type":"pane.closed"},{"type":"tab.closed"}]}"#
    );
    fake.push_event("pane_exited", json!({ "pane_id": "pane-1" }));
    assert_eq!(ending.await.unwrap(), PaneEnd::Exited);
    until("the subscriber go", || fake.subscribers() == 0).await;
}

#[tokio::test]
async fn wait_for_pane_end_settles_closed_when_the_panes_tab_is_closed() {
    // Issue #61: `tab.close` pushes one `tab_closed` and no `pane_closed` for the panes it took
    // (verified against herdr 0.8.2), so a wait that only listened for pane events parked for good when
    // the operator closed an attempt's tab. The tab event names no pane, so the wait re-reads the listing
    // and settles on the pane's absence.
    let fake = fake_with(Options {
        workspaces: vec![workspace("w7")],
        ..Options::default()
    })
    .await;
    let herdr = fake.herdr();
    let tab = herdr
        .open_attempt_tab("01 · Tab", "/work/tree", "w7")
        .await
        .unwrap();
    let ending = spawn_wait(&herdr, &tab.pane_id, None);
    subscribed_and_checked(&fake).await;
    herdr.close_tab(&tab.tab_id).await.unwrap();
    assert_eq!(ending.await.unwrap(), PaneEnd::Closed);
}

#[tokio::test]
async fn wait_for_pane_end_keeps_waiting_through_another_tabs_close() {
    // Every subscriber sees every tab's close; only the listing says whose pane went with it.
    let fake = fake_with(Options {
        workspaces: vec![workspace("w7")],
        ..Options::default()
    })
    .await;
    let herdr = fake.herdr();
    let mine = herdr
        .open_attempt_tab("01 · Mine", "/work/tree", "w7")
        .await
        .unwrap();
    let other = herdr
        .open_attempt_tab("02 · Other", "/work/tree", "w7")
        .await
        .unwrap();
    let ending = spawn_wait(&herdr, &mine.pane_id, None);
    subscribed_and_checked(&fake).await;
    herdr.close_tab(&other.tab_id).await.unwrap();
    // The subscription's own liveness check, then the re-read the other tab's close forces.
    until("the listing re-read after the other tab's close", || {
        calls_of(&fake, "pane.list").len() >= 2
    })
    .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!ending.is_finished());
    fake.push_event("pane_exited", json!({ "pane_id": mine.pane_id }));
    assert_eq!(ending.await.unwrap(), PaneEnd::Exited);
}

#[tokio::test]
async fn wait_for_pane_end_settles_lost_at_once_when_released_mid_connect_and_still_lets_go_of_the_socket()
 {
    // Hidden row (herdr.test.ts:376): released while its subscription connect is still in flight, the
    // wait resolves lost at once and closes the connection, leaving no subscriber on the daemon.
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        ..Options::default()
    })
    .await;
    let herdr = fake.herdr();
    let release = CancellationToken::new();
    let mut ending = std::pin::pin!(herdr.wait_for_pane_end("pane-1", Some(&release)));
    // One poll starts the connect, which waits on the runtime to report it writable.
    assert!(futures::poll!(ending.as_mut()).is_pending());
    release.cancel();
    assert_eq!(ending.await, PaneEnd::Lost);
    until("the connection come and go", || {
        fake.connections() == 1 && fake.open_connections() == 0
    })
    .await;
    assert_eq!(fake.subscribers(), 0);
}

#[tokio::test]
async fn wait_for_pane_end_resolves_lost_without_connecting_when_released_before_it_starts() {
    // Hidden row (herdr.test.ts:390).
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        ..Options::default()
    })
    .await;
    let release = CancellationToken::new();
    release.cancel();
    assert_eq!(
        fake.herdr()
            .wait_for_pane_end("pane-1", Some(&release))
            .await,
        PaneEnd::Lost
    );
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(fake.connections(), 0);
}

#[tokio::test]
async fn wait_for_pane_end_settles_closed_when_the_pane_vanished_without_exiting() {
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        ..Options::default()
    })
    .await;
    let ending = spawn_wait(&fake.herdr(), "pane-1", None);
    subscribed_and_checked(&fake).await;
    fake.push_event("pane_closed", json!({ "pane_id": "pane-1" }));
    assert_eq!(ending.await.unwrap(), PaneEnd::Closed);
}

#[tokio::test]
async fn wait_for_pane_end_ignores_another_panes_event() {
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        ..Options::default()
    })
    .await;
    let ending = spawn_wait(&fake.herdr(), "pane-1", None);
    subscribed_and_checked(&fake).await;
    // The daemon pushes every pane's ends to every subscriber, so a busy host delivers other attempts'
    // endings down this same connection.
    fake.push_event("pane_exited", json!({ "pane_id": "pane-other" }));
    fake.push_event("pane_closed", json!({ "pane_id": "pane-other" }));
    fake.push_event("pane_exited", json!({ "pane_id": "pane-1" }));
    assert_eq!(ending.await.unwrap(), PaneEnd::Exited);
}

#[tokio::test]
async fn wait_for_pane_end_settles_lost_when_the_daemon_hangs_up_on_the_subscriber() {
    // Ticket 19 of the run-digest pool: the daemon dropped the subscription with a plain FIN, saying
    // nothing and reporting no error, and the wait parked for 98 minutes over an attempt that had already
    // finished. A hang-up must settle the ending, so the exit-code file can answer.
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        ..Options::default()
    })
    .await;
    let ending = spawn_wait(&fake.herdr(), "pane-1", None);
    subscribed_and_checked(&fake).await;
    fake.hang_up_subscribers();
    assert_eq!(ending.await.unwrap(), PaneEnd::Lost);
}

#[tokio::test]
async fn wait_for_pane_end_settles_lost_when_the_subscriber_connection_is_dropped() {
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        ..Options::default()
    })
    .await;
    let ending = spawn_wait(&fake.herdr(), "pane-1", None);
    subscribed_and_checked(&fake).await;
    fake.drop_subscribers();
    assert_eq!(ending.await.unwrap(), PaneEnd::Lost);
}

#[tokio::test]
async fn wait_for_pane_end_settles_lost_when_there_is_no_daemon_to_subscribe_to() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        Herdr::new(dir.path().join("absent.sock"))
            .wait_for_pane_end("pane-1", None)
            .await,
        PaneEnd::Lost
    );
}

#[tokio::test]
async fn wait_for_pane_end_settles_lost_when_the_caller_releases_it() {
    // The caller found the attempt's ending somewhere the daemon knows nothing about, and wants its
    // subscription back rather than leaving one dead connection per attempt behind it.
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        ..Options::default()
    })
    .await;
    let release = CancellationToken::new();
    let ending = spawn_wait(&fake.herdr(), "pane-1", Some(release.clone()));
    subscribed_and_checked(&fake).await;
    release.cancel();
    assert_eq!(ending.await.unwrap(), PaneEnd::Lost);
    until("the subscriber go", || fake.subscribers() == 0).await;
}

#[tokio::test]
async fn wait_for_pane_end_settles_exited_when_the_pane_is_already_gone_as_the_subscription_lands()
{
    // Its end predated the subscription, so no event will ever arrive: the liveness check on the
    // acknowledgement is the only thing that can see it.
    let fake = fake_with(Options {
        list_only: Some(Vec::new()),
        ..Options::default()
    })
    .await;
    assert_eq!(
        fake.herdr().wait_for_pane_end("pane-1", None).await,
        PaneEnd::Exited
    );
}

#[tokio::test]
async fn wait_for_pane_end_settles_lost_when_the_daemon_refuses_the_subscription() {
    // A daemon without events.subscribe answers with an error and hangs up, as for any call.
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        fail: vec![(
            "events.subscribe",
            json!({ "code": -32601, "message": "unknown method" }),
        )],
        ..Options::default()
    })
    .await;
    assert_eq!(
        fake.herdr().wait_for_pane_end("pane-1", None).await,
        PaneEnd::Lost
    );
}

#[tokio::test]
async fn wait_for_pane_end_lets_go_of_the_subscription_when_its_future_is_dropped() {
    let fake = fake_with(Options {
        foreign_panes: live_pane(),
        ..Options::default()
    })
    .await;
    let ending = spawn_wait(&fake.herdr(), "pane-1", None);
    subscribed_and_checked(&fake).await;
    ending.abort();
    until("the subscriber go", || fake.subscribers() == 0).await;
}
