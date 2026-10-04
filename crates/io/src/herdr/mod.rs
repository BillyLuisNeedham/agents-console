//! The herdr socket client (ADR-0014, refined by ADR-0015): the engine's one module that speaks to the
//! herdr daemon. Ported from engine/herdr.ts.
//!
//! herdr speaks newline-delimited JSON-RPC over a unix socket, ONE REQUEST PER CONNECTION: open a fresh
//! connection, write `{"id":..,"method":..,"params":..}\n`, read exactly one JSON line, then the daemon
//! closes the socket. Every call therefore connects anew (verified live against herdr 0.8.2; the
//! prototype-verified quirks are recorded in docs/adr/0015-attempts-spawn-as-named-herdr-tabs.md).
//!
//! Terminal-backed attempts (pools configured `terminal: "herdr"`) each open their own named tab at spawn
//! time via [`Herdr::open_attempt_tab`]: the tab is created unfocused in the attempt's worktree cwd, named
//! `<ticket-id> · <ticket-title>` so the operator's tab bar reads as the roster of tickets in flight, and
//! inside the **Pool workspace** (issue #94), the one herdr workspace every tab of one Pool opens in.
//! herdr protocol 20 answers `tab.create` with `tab_created { tab, root_pane }`, both required, so the
//! pane id comes straight off `root_pane`; the engine records it on the attempt's `spawned` event.
//!
//! The Pool workspace itself is resolved once per boot by [`Herdr::resolve_pool_workspace`] (remembered
//! id, else the workspace the server was launched in, else a fresh one created for the pool), and the
//! engine keeps the id in the pool's runs directory so a restart lands its tabs back where the operator
//! left them.
//!
//! herdr lists a pane in its left-hand agent sidebar only when the pane has an agent bound to it, and its
//! own process-name detection never binds ours (the harness runs inside `script`), so the engine asserts
//! the identity itself: [`Herdr::report_pane_agent`] after the wrapper lands and on every Turn flip,
//! [`Herdr::release_pane_agent`] at the Attempt ending. Both are best-effort.
//!
//! Every call is an `async fn` and, being a Rust future, sends nothing until it is awaited or spawned. A
//! call the TypeScript fired and forgot (`void closeTab(...)`) is a `tokio::spawn` here, never a future
//! left to drop.

mod pane_end;
mod rpc;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{SystemTime, UNIX_EPOCH};

use ac_core::js;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

pub use pane_end::PaneEnd;

/// Attempt tab labels cap at this many characters (`~40` per the spec), counted as JavaScript counts
/// them, in UTF-16 code units.
pub const ATTEMPT_TAB_LABEL_MAX: usize = 40;

/// What the engine calls itself when it asserts a pane's agent identity, on every `pane.report_agent`
/// and the matching `pane.release_agent`: herdr keys a reported agent by (pane, source), so the source
/// is what stops one reporter from releasing another's binding.
pub const PANE_AGENT_SOURCE: &str = "herdr:agent-console";

/// The daemon's socket when a run names none: `HERDR_SOCKET_PATH` when set and not blank (trimmed),
/// herdr's own variable (it exports it into every pane it runs, so a Console started inside herdr talks
/// to that daemon), else the socket under the user's config dir. The CLI reads the variable and the home
/// directory and passes both here; nothing below the CLI reads the environment.
pub fn default_socket_path(herdr_socket_path: Option<&str>, home: &Path) -> PathBuf {
    match herdr_socket_path.map(js::trim) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => home.join(".config/herdr/herdr.sock"),
    }
}

/// A failed herdr call. Its text is the TypeScript client's, byte for byte: callers show it in the pool
/// log, in a 502 and on a spawned event's `terminal_error`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct HerdrError {
    message: String,
}

impl HerdrError {
    /// An error carrying this text.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// The error's text, as the TypeScript's `err.message`.
    pub fn message(&self) -> &str {
        &self.message
    }
}

/// The attempt tab's label: `<ticket-id> · <ticket-title>`, capped at [`ATTEMPT_TAB_LABEL_MAX`]
/// characters so a long ticket title never blows up the operator's tab bar. JavaScript counts and cuts in
/// UTF-16 code units, and so does this; where its cut would split a surrogate pair, the whole character
/// goes, since a lone surrogate is no Rust string.
pub fn attempt_tab_label(ticket_id: &str, title: &str) -> String {
    let label = format!("{ticket_id} · {}", js::trim(title));
    if js::utf16_len(&label) > ATTEMPT_TAB_LABEL_MAX {
        js::utf16_prefix(&label, ATTEMPT_TAB_LABEL_MAX).to_owned()
    } else {
        label
    }
}

/// Whether a failed close says the tab was not there to close (herdr's `tab_not_found`): a tab that is
/// already gone is the close done, not a failure worth recording (issue #139). Two closers of one tab (a
/// Conversation's End and its ending's sweep, a Resume close and a later merge) are ordinary, and so is
/// an operator who closed it by hand. Takes the error itself or its text.
pub fn is_tab_not_found(err: impl Display) -> bool {
    // The TypeScript's /tab_not_found|tab .*not found|no such tab/i: case folded in ASCII only, as a
    // JavaScript regex without the u flag folds these letters, and `.` stopping at JavaScript's line
    // terminators.
    static TAB_NOT_FOUND: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i-u:tab_not_found)|(?i-u:tab )[^\n\r\u{2028}\u{2029}]*(?i-u:not found)|(?i-u:no such tab)",
        )
        .expect("the tab-not-found pattern compiles")
    });
    TAB_NOT_FOUND.is_match(&err.to_string())
}

/// An attempt's named tab, as `tab.create` answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptTab {
    pub tab_id: String,
    pub pane_id: String,
    /// herdr's `terminal_id` for the root pane, when the answer carries one: unique per terminal and
    /// never reused, unlike the short pane and tab ids, so a record carrying it names this terminal and
    /// no later one.
    pub terminal_id: Option<String>,
}

/// Where the Pool workspace id the engine uses came from (issue #94).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PoolWorkspaceOrigin {
    /// The id this pool used last, read from its runs directory.
    Remembered,
    /// The workspace the Console server was launched in (`HERDR_WORKSPACE_ID`).
    Launch,
    /// A fresh one created for the pool.
    Created,
}

impl PoolWorkspaceOrigin {
    /// The TypeScript name of the origin: `remembered`, `launch` or `created`.
    pub fn as_str(self) -> &'static str {
        match self {
            PoolWorkspaceOrigin::Remembered => "remembered",
            PoolWorkspaceOrigin::Launch => "launch",
            PoolWorkspaceOrigin::Created => "created",
        }
    }
}

/// The Pool workspace a resolution settled on, and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolWorkspaceResolution {
    pub workspace_id: String,
    pub origin: PoolWorkspaceOrigin,
}

/// What a Pool workspace is resolved from: the two ids that may name one already, and what a fresh one
/// is labelled and opened in.
#[derive(Debug, Clone, Copy)]
pub struct PoolWorkspaceCandidates<'a> {
    /// The id this pool used last; `None` or empty when it remembers none.
    pub remembered: Option<&'a str>,
    /// The workspace the server was launched in; `None` or empty when it was not launched in one.
    pub launch: Option<&'a str>,
    /// The label a created workspace takes: the Pool title, else the pool directory's name.
    pub label: &'a str,
    /// The directory a created workspace opens in: the pool's repo root.
    pub cwd: &'a str,
}

/// Which of herdr's pane snapshots a read takes (issue #122, ADR-0021's amendment).
///
/// Reading scrollback moves the viewport of a pane an operator sits in: on a Mac each `Recent` read
/// scrolled the pane up and back under their hands. So the steady-state watch of a pane the operator may
/// be typing in (an enlisted attempt's, a Conversation's, the card Peek's) reads `Visible`, and only the
/// launch-time reads of a tab the engine opened and nobody is in (the readiness and echo polling) still
/// read `Recent`: a fresh pane's viewport is mostly blank above its prompt, and the prototype found small
/// reads of it come back empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneReadSource {
    /// The viewport and nothing above it, what the operator sees; herdr sizes it to the pane.
    Visible,
    /// The last `lines` rendered rows, reaching into scrollback.
    Recent { lines: u32 },
}

/// How herdr's agent sidebar shows a pane the engine reported: working is an attempt the agent is
/// running, blocked is a Conversation waiting on the operator (herdr's vocabulary for "it needs a
/// human"). A Ticket attempt has no Turn state and stays working for its whole life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PaneAgentState {
    Working,
    Blocked,
}

impl PaneAgentState {
    /// The state as herdr takes it: `working` or `blocked`.
    pub fn as_str(self) -> &'static str {
        match self {
            PaneAgentState::Working => "working",
            PaneAgentState::Blocked => "blocked",
        }
    }
}

/// One pane as `pane.list` reports it (issue #139): a field the daemon does not report is `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerdrPane {
    pub pane_id: String,
    pub tab_id: Option<String>,
    pub workspace_id: Option<String>,
    pub cwd: Option<String>,
    pub terminal_id: Option<String>,
}

/// One pane as herdr's `agent.list` reports it (the enlist picker's raw material, issue #101). herdr lists
/// an entry per pane it binds an agent to, whether the engine reported the agent or herdr detected one
/// itself; the fields are the ones the picker shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerdrAgent {
    pub pane_id: String,
    /// The pane's tab: what an enlist relabels ([`Herdr::relabel_tab`]), `None` when the daemon does not
    /// report one.
    pub tab_id: Option<String>,
    pub harness: Option<String>,
    pub status: String,
    pub title: String,
    /// The pane's cwd (herdr reports no branch, so the engine resolves that itself).
    pub directory: Option<String>,
    /// The harness session herdr reports for the pane, when it reports one: named in an enlisted ticket's
    /// provenance. `None` when absent (the fake and some daemon versions carry no such field).
    pub session_id: Option<String>,
}

/// Input for a pane, exactly as the operator's keystrokes would land. A literal `\r` inside text is pasted
/// data, not a submit (verified herdr behaviour), so a command line travels as text and its Enter as a
/// key. The two may share one call: herdr applies text first, then keys (verified live on 0.8.2, and what
/// its CLI's `pane run` sends), which is how a command line and its submit reach the shell without a gap
/// between them (issue #96).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaneInput {
    pub text: Option<String>,
    pub keys: Option<Vec<String>>,
}

impl PaneInput {
    /// Text alone, pasted.
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: Some(text.into()),
            keys: None,
        }
    }

    /// Keys alone, pressed in order (`enter`, `down`, ...).
    pub fn keys<I, S>(keys: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            text: None,
            keys: Some(keys.into_iter().map(Into::into).collect()),
        }
    }

    /// These keys too, pressed after the text lands.
    pub fn and_keys<I, S>(mut self, keys: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.keys = Some(keys.into_iter().map(Into::into).collect());
        self
    }
}

// The `seq` every report carries, so the daemon can order two reports about one pane whatever order
// they arrive in. Strictly increasing within this process, and seeded from the clock so a restarted
// engine almost always continues above where its predecessor left off: the exception is a process that
// reported more times than the milliseconds it lived, or a clock that went backwards.
static PANE_AGENT_SEQ: LazyLock<AtomicU64> = LazyLock::new(|| {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64);
    AtomicU64::new(now)
});

/// The herdr daemon behind one socket. Every call opens its own connection, so the handle is only the
/// socket's path, and cheap to clone into the task that makes the call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Herdr {
    socket_path: Arc<Path>,
}

impl Herdr {
    /// The daemon listening on this socket.
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: Arc::from(socket_path.into()),
        }
    }

    /// The socket every call connects to.
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// One JSON-RPC request over a fresh connection. Resolves with the answer's `result` (`None` where
    /// it carries none); fails with the herdr `error` body (`<method> failed: <body>`), and on timeout
    /// (`herdr rpc timed out (<method>)`, after 10 s), an unreachable daemon, or an answer that does not
    /// parse (`bad herdr response for <method>: <line>`).
    pub async fn rpc(&self, method: &str, params: Value) -> Result<Option<Value>, HerdrError> {
        rpc::call(&self.socket_path, method, params).await
    }

    /// Open an attempt's named tab in the Pool workspace (issue #94): `tab.create` unfocused in the
    /// attempt's worktree cwd, carrying the workspace id so every tab of one Pool lands together instead
    /// of wherever the daemon's focus happens to be. The pane id comes off the answer's `root_pane`. Fails
    /// when the daemon errors or either id is missing from the answer; callers treat a failure as the
    /// headless fallback (ADR-0014) and record it on the spawned event.
    pub async fn open_attempt_tab(
        &self,
        label: &str,
        cwd: &str,
        workspace_id: &str,
    ) -> Result<AttemptTab, HerdrError> {
        let created = self
            .rpc(
                "tab.create",
                json!({ "label": label, "focus": false, "cwd": cwd, "workspace_id": workspace_id }),
            )
            .await?;
        let answer = created.as_ref();
        let Some(tab_id) = non_empty_str(answer, &["tab", "tab_id"]) else {
            return Err(HerdrError::new(format!(
                "tab.create returned no tab id: {}",
                js::stringify_or_undefined(answer)
            )));
        };
        let Some(pane_id) = non_empty_str(answer, &["root_pane", "pane_id"]) else {
            return Err(HerdrError::new(format!(
                "tab.create returned no root pane id: {}",
                js::stringify_or_undefined(answer)
            )));
        };
        Ok(AttemptTab {
            tab_id,
            pane_id,
            terminal_id: str_at(answer, &["root_pane", "terminal_id"]),
        })
    }

    /// Resolve the Pool workspace (issue #94), the one herdr workspace a Terminal-backed pool opens its
    /// attempt and Conversation tabs in. Three steps, in order:
    ///
    /// 1. remembered: the id this pool used last. It is used only once `workspace.get` confirms the
    ///    workspace is still there; an operator who closed it leaves an id that answers with an error,
    ///    and the resolution falls through.
    /// 2. launch: the workspace the Console server was launched in, confirmed the same way, so a pool
    ///    started from inside herdr puts its tabs where the operator already is.
    /// 3. Otherwise a fresh one: `workspace.create` labelled for the pool, in the pool's repo root,
    ///    unfocused (ADR-0015's rule that a spawn never steals the operator's focus, applied one level
    ///    up).
    ///
    /// There is deliberately no path matching against `workspace.list`: a workspace's cwd is the
    /// operator's to change and two pools of one repo would collide on it, so identity comes from an id
    /// the pool recorded or was told, never from a guess. Fails when no candidate held and the daemon
    /// will not create one; the caller boots falling back to headless rather than refusing the pool.
    pub async fn resolve_pool_workspace(
        &self,
        candidates: &PoolWorkspaceCandidates<'_>,
    ) -> Result<PoolWorkspaceResolution, HerdrError> {
        let known = [
            (PoolWorkspaceOrigin::Remembered, candidates.remembered),
            (PoolWorkspaceOrigin::Launch, candidates.launch),
        ];
        for (origin, workspace_id) in known {
            let Some(workspace_id) = workspace_id.filter(|id| !id.is_empty()) else {
                continue;
            };
            if self.workspace_exists(workspace_id).await {
                return Ok(PoolWorkspaceResolution {
                    workspace_id: workspace_id.to_owned(),
                    origin,
                });
            }
        }
        let created = self
            .rpc(
                "workspace.create",
                json!({ "label": candidates.label, "cwd": candidates.cwd, "focus": false }),
            )
            .await?;
        match non_empty_str(created.as_ref(), &["workspace", "workspace_id"]) {
            Some(workspace_id) => Ok(PoolWorkspaceResolution {
                workspace_id,
                origin: PoolWorkspaceOrigin::Created,
            }),
            None => Err(HerdrError::new(format!(
                "workspace.create returned no workspace id: {}",
                js::stringify_or_undefined(created.as_ref())
            ))),
        }
    }

    /// Relabel a workspace (`workspace.rename`, herdr protocol 20). The engine calls it only on a Pool
    /// workspace it created itself, when the Pool title changes (issue #100): a launch workspace, or one
    /// a pool merely remembers without having made it, is the operator's, and its label is theirs. Fails
    /// on a refusal; the caller decides how loud that is.
    pub async fn relabel_workspace(
        &self,
        workspace_id: &str,
        label: &str,
    ) -> Result<(), HerdrError> {
        self.rpc(
            "workspace.rename",
            json!({ "workspace_id": workspace_id, "label": label }),
        )
        .await
        .map(drop)
    }

    /// Whether the daemon still holds this workspace: `workspace.get` answering with one. Any failure (an
    /// unknown id, a daemon that is not there) is a no, because both mean the same thing to the caller:
    /// this id cannot be used. The engine's re-resolve asks the same question of the id a `tab.create`
    /// just refused: a workspace that is still there means the refusal was something else, and nothing
    /// should be created.
    pub async fn workspace_exists(&self, workspace_id: &str) -> bool {
        match self
            .rpc("workspace.get", json!({ "workspace_id": workspace_id }))
            .await
        {
            Ok(got) => non_empty_str(got.as_ref(), &["workspace", "workspace_id"]).is_some(),
            Err(_) => false,
        }
    }

    /// Read a pane's output: `pane.read` from the given source, text format, ANSI stripped. An empty read
    /// (a freshly created background tab returns empty for its first seconds while herdr warms up its
    /// viewport, verified behaviour) is empty text, never an error. `revision` is deliberately not
    /// returned: the prototype verified it stays stagnant while output grows, so freshness comes from
    /// re-polling and comparing text, never from the revision counter.
    pub async fn peek_pane(
        &self,
        pane_id: &str,
        read: PaneReadSource,
    ) -> Result<String, HerdrError> {
        let mut params = Map::new();
        params.insert("pane_id".into(), json!(pane_id));
        match read {
            PaneReadSource::Visible => {
                params.insert("source".into(), json!("visible"));
            }
            PaneReadSource::Recent { .. } => {
                params.insert("source".into(), json!("recent"));
            }
        }
        params.insert("format".into(), json!("text"));
        params.insert("strip_ansi".into(), json!(true));
        if let PaneReadSource::Recent { lines } = read {
            params.insert("lines".into(), json!(lines));
        }
        let read = self.rpc("pane.read", Value::Object(params)).await?;
        Ok(str_at(read.as_ref(), &["read", "text"]).unwrap_or_default())
    }

    /// Focus the pane's tab in the operator's herdr TUI: one `pane.focus` call. The pool server only ever
    /// names a pane the engine's own snapshot records as a live attempt's or a live Conversation's, so
    /// this can never yank the TUI to an unrelated live agent session sharing the daemon.
    pub async fn focus_pane(&self, pane_id: &str) -> Result<(), HerdrError> {
        self.rpc("pane.focus", json!({ "pane_id": pane_id }))
            .await
            .map(drop)
    }

    /// Report a pane's agent identity (issue #94): herdr lists a pane in its left-hand agent sidebar only
    /// when the pane has an agent bound to it, and its process-name detection never binds ours, because
    /// the harness runs inside `script` (ADR-0016). So the engine asserts the identity itself (the harness
    /// name, the state, and the attempt's tab label as the message) once the wrapper has landed, and again
    /// on every Conversation Turn flip. Each report takes the next `seq`, sent or not.
    pub async fn report_pane_agent(
        &self,
        pane_id: &str,
        agent: &str,
        state: PaneAgentState,
        message: &str,
    ) -> Result<(), HerdrError> {
        let seq = PANE_AGENT_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
        self.rpc(
            "pane.report_agent",
            json!({
                "pane_id": pane_id,
                "source": PANE_AGENT_SOURCE,
                "agent": agent,
                "state": state.as_str(),
                "seq": seq,
                "message": message,
            }),
        )
        .await
        .map(drop)
    }

    /// Drop the agent identity this engine reported for a pane, at the Attempt ending: the attempt is
    /// over, so it leaves herdr's agent list even where the pane itself lives on (a crashed attempt's tab
    /// stays open until merge, ADR-0014). Best-effort, exactly as [`Herdr::close_tab`] is.
    pub async fn release_pane_agent(&self, pane_id: &str, agent: &str) -> Result<(), HerdrError> {
        self.rpc(
            "pane.release_agent",
            json!({ "pane_id": pane_id, "source": PANE_AGENT_SOURCE, "agent": agent }),
        )
        .await
        .map(drop)
    }

    /// The live pane ids herdr currently holds, from `pane.list`. Boot reconciliation (ADR-0014) treats
    /// membership as liveness: a recorded attempt pane that is not listed died with the daemon restart or
    /// was closed. Scoped to the Pool workspace when one is given (issue #94), so the answer is this
    /// pool's panes rather than every pane on the host; daemon-wide otherwise. An answer with no `panes`
    /// array reads as none.
    pub async fn list_pane_ids(
        &self,
        workspace_id: Option<&str>,
    ) -> Result<Vec<String>, HerdrError> {
        let params = match workspace_id {
            Some(workspace_id) => json!({ "workspace_id": workspace_id }),
            None => json!({}),
        };
        let list = self.rpc("pane.list", params).await?;
        let Some(panes) = list
            .as_ref()
            .and_then(|list| list.get("panes"))
            .and_then(Value::as_array)
        else {
            return Ok(Vec::new());
        };
        Ok(panes
            .iter()
            .filter_map(|pane| str_at(Some(pane), &["pane_id"]))
            .collect())
    }

    /// Every pane the daemon lists, with the tab, workspace and directory it reports for each (issue
    /// #139): the pane survey's one read, which answers both "is this pane alive" and "is this tab still
    /// open", and lets a recorded pane be checked against what herdr now lists under its id. Daemon-wide:
    /// a pool's tabs are in its Pool workspace, but a workspace re-resolved mid-run left the tabs opened
    /// before it in the old one. An answer with no `panes` array fails rather than reading as no panes:
    /// the survey keeps its last good listing then, where an empty one would let go of every Held pane at
    /// once.
    pub async fn list_panes(&self) -> Result<Vec<HerdrPane>, HerdrError> {
        let list = self.rpc("pane.list", json!({})).await?;
        let Some(panes) = list
            .as_ref()
            .and_then(|list| list.get("panes"))
            .and_then(Value::as_array)
        else {
            return Err(HerdrError::new(format!(
                "pane.list answered without a panes list: {}",
                js::stringify_or_undefined(list.as_ref())
            )));
        };
        Ok(panes
            .iter()
            .filter_map(|pane| {
                let pane = Some(pane);
                Some(HerdrPane {
                    pane_id: str_at(pane, &["pane_id"])?,
                    tab_id: str_at(pane, &["tab_id"]),
                    workspace_id: str_at(pane, &["workspace_id"]),
                    cwd: str_at(pane, &["cwd"]),
                    terminal_id: str_at(pane, &["terminal_id"]),
                })
            })
            .collect())
    }

    /// The live agents herdr holds, from `agent.list`: every pane with an agent bound to it,
    /// engine-reported or herdr-detected. The enlist route reads it through the engine, never the
    /// Console, and judges eligibility itself. An answer missing the `agents` array fails, as
    /// [`Herdr::list_panes`] does (issue #139): read as none, it would tell boot that every enlisted
    /// Conversation's pane was gone, and the pane is the operator's. An entry with no string `pane_id`
    /// is skipped (a null entry included, which the TypeScript would have failed on).
    pub async fn list_agents(&self) -> Result<Vec<HerdrAgent>, HerdrError> {
        let list = self.rpc("agent.list", json!({})).await?;
        let Some(agents) = list
            .as_ref()
            .and_then(|list| list.get("agents"))
            .and_then(Value::as_array)
        else {
            return Err(HerdrError::new(format!(
                "agent.list answered without an agents list: {}",
                js::stringify_or_undefined(list.as_ref())
            )));
        };
        Ok(agents
            .iter()
            .filter_map(|agent| {
                let field = |name: &str| str_at(Some(agent), &[name]);
                Some(HerdrAgent {
                    pane_id: field("pane_id")?,
                    tab_id: field("tab_id"),
                    harness: field("agent"),
                    status: field("agent_status").unwrap_or_else(|| "unknown".to_owned()),
                    title: field("terminal_title")
                        .or_else(|| field("terminal_title_stripped"))
                        .or_else(|| field("title"))
                        .or_else(|| field("name"))
                        .unwrap_or_default(),
                    directory: field("cwd").or_else(|| field("foreground_cwd")),
                    session_id: field("session_id").or_else(|| field("session")),
                })
            })
            .collect())
    }

    /// Send input to a pane, exactly as the operator's keystrokes would land (`pane.send_input`): the
    /// text, then the keys, whichever the input carries.
    pub async fn pane_send_input(
        &self,
        pane_id: &str,
        input: &PaneInput,
    ) -> Result<(), HerdrError> {
        let mut params = Map::new();
        params.insert("pane_id".into(), json!(pane_id));
        if let Some(text) = &input.text {
            params.insert("text".into(), json!(text));
        }
        if let Some(keys) = &input.keys {
            params.insert("keys".into(), json!(keys));
        }
        self.rpc("pane.send_input", Value::Object(params))
            .await
            .map(drop)
    }

    /// Wait until the pane is gone, on herdr's `events.subscribe`: one connection subscribes to
    /// `pane.exited`, `pane.closed` and `tab.closed` (verified live against herdr 0.8.2; `events.wait`
    /// only supports agent-status matches, so a subscription is the only event channel) and the first
    /// matching event settles the wait. The daemon pushes every pane's events to every subscriber, so the
    /// filter is client-side. Three backstops close the gaps a subscription cannot see: the connection
    /// ending, erroring or closing settles [`PaneEnd::Lost`]; a pane already absent from `pane.list` when
    /// the subscription's acknowledgement lands settles [`PaneEnd::Exited`] (its end predated the
    /// subscription, so no event will ever arrive); and the optional release settles `Lost` for a caller
    /// that found the attempt's ending somewhere else and wants its connection back. The liveness check
    /// runs only after the acknowledgement, so an end can never slip between the check and the daemon
    /// registering the subscription.
    ///
    /// `tab.closed` is subscribed because a closed tab takes its panes silently (verified against herdr
    /// 0.8.2, issue #61): `tab.close` pushes one `tab_closed` carrying the tab id and no `pane_closed` for
    /// any pane in it. The event carries no pane id, so a `tab_closed` for any tab re-checks `pane.list`:
    /// the pane gone from the listing settles [`PaneEnd::Closed`], the pane still listed was another
    /// tab's. The daemon drops the panes from its listing before it answers `tab.close`, and pushes
    /// `tab_closed` tens of milliseconds after that answer, so the re-read never sees the pane it is
    /// about to lose.
    ///
    /// `Lost` says only that this observation is over, never that the attempt is: the pane may still be
    /// running and the daemon merely unreachable. What a caller does about that is the caller's.
    ///
    /// A release already given resolves `Lost` without connecting. A release given later resolves `Lost`
    /// at once and closes the connection wherever it had got to; so does dropping the wait's future.
    pub async fn wait_for_pane_end(
        &self,
        pane_id: &str,
        release: Option<&CancellationToken>,
    ) -> PaneEnd {
        pane_end::wait(self, pane_id, release).await
    }

    /// Close a pane (`pane.close`). Best-effort: callers use it where a vanished pane is already the
    /// expected state, so a failure (daemon restart, pane already gone) is not an error to them.
    pub async fn close_pane(&self, pane_id: &str) -> Result<(), HerdrError> {
        self.rpc("pane.close", json!({ "pane_id": pane_id }))
            .await
            .map(drop)
    }

    /// Close a tab (`tab.close`), the engine's cleanup for a merged attempt's terminal (ADR-0014: exited
    /// panes persist until merge, then close). Closing the tab closes its panes with it.
    pub async fn close_tab(&self, tab_id: &str) -> Result<(), HerdrError> {
        self.rpc("tab.close", json!({ "tab_id": tab_id }))
            .await
            .map(drop)
    }

    /// Relabel a tab (`tab.rename`): the enlist claim renames the operator's existing tab to the attempt
    /// label the engine would have given a tab it opened itself (ADR-0015), so an enlisted pane reads like
    /// a spawned one in the tab bar. Best-effort, like every herdr call here: a daemon that refuses it
    /// leaves the operator's original label in place, not a broken enlist.
    ///
    /// Inference: the real daemon's relabel method name is unverified in this repository; the shared
    /// executing fake is the one contract this call is exercised against, and it answers `tab.rename`
    /// with `{ tab_id, label }`. If the daemon spells it otherwise, this is the one line to change.
    pub async fn relabel_tab(&self, tab_id: &str, label: &str) -> Result<(), HerdrError> {
        self.rpc("tab.rename", json!({ "tab_id": tab_id, "label": label }))
            .await
            .map(drop)
    }
}

/// The string at this path through nested objects, if every step is there and the end is a string.
/// Reading a field of anything that is not an object finds nothing, as JavaScript's optional chaining
/// reads `undefined` there.
fn str_at(value: Option<&Value>, path: &[&str]) -> Option<String> {
    let mut at = value?;
    for key in path {
        at = at.get(*key)?;
    }
    at.as_str().map(str::to_owned)
}

/// [`str_at`], counting an empty string as missing: how the client checks an id it must have.
fn non_empty_str(value: Option<&Value>, path: &[&str]) -> Option<String> {
    str_at(value, path).filter(|text| !text.is_empty())
}
