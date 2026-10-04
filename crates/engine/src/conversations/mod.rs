//! Conversations (issue #60, the Conversations ADR, conversations.ts): an open-ended talk between the
//! operator and one agent, living in a Pool beside its Tickets. A Conversation has an Assignment fixed at
//! start, its own worktree and branch, runs as a terminal-backed TUI in a herdr tab, and has no done
//! condition: only the operator ends it (CONTEXT.md: Conversation, Turn, Notice).
//!
//! The record on disk is `ac_core::conversation_record`. This module is the runtime that drives a live
//! Conversation: its pane, worktree, Turn state, Notice queue and tick, plus the ids reserved for starts
//! still in flight, kept on the Session (`Session::conversations`).
//!
//! A runtime is a shared handle ([`Rt`]), as the TypeScript's runtime object was: a flow that holds one
//! across an await (a start, an enlist, a boot adoption) sees every change the engine's jobs make to it,
//! and it stays usable after it leaves the map. It is only ever touched inside a job on the actor or by
//! the flow that owns it between awaits, and never held across one.
//!
//! The parts: `start` (start and enlist), `end` (ending, merge answers, crashes), `notices` (the queue,
//! delivery and the ticket hooks), `adopt` (boot and re-adoption, claims) and `tick` (Turn state, the
//! spawn.json poll).

mod adopt;
mod end;
mod notices;
mod start;
mod tick;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use ac_core::assignment::{Assignment, DEFAULT_DRIVERS, assignment_view_of};
use ac_core::config::PoolConfig;
use ac_core::conversation_record::{ConversationRecord, load_conversations};
use ac_core::events::{append_event, event_now, last_attempt, read_events};
use ac_core::harness::{HarnessMode, effort_applies};
use ac_core::js;
use ac_core::notices::Notice;
use ac_core::pool::TicketMarker;
use ac_core::prompt::TeachingAssignment;
use ac_core::turn_state::TurnState;
use ac_io::git::{self, WorktreeInfo};
use ac_io::herdr::{Herdr, PaneAgentState};
use ac_protocol::{
    AnswerBy, ConversationRole, ConversationStatus, ConversationTurn, ConversationView,
    NoticeDelivery, TicketEventKind, TurnSide,
};

use crate::actor::Engine;
use crate::attempt_run::PaneTailer;
use crate::session::Session;
use crate::snapshot::emit_snapshot;

pub use adopt::{
    adopt_enlisted_at_boot, adopt_started_at_boot, crash_stale_at_boot, readopt_pending,
};
pub use end::{answer_merge, end, end_conversation_by_steward};
pub use notices::{ticket_checkpointed, ticket_closed, ticket_ended};
pub use start::{EnlistConversationRegistration, EnlistConversationResult, enlist, start};

/// How often a live Conversation's tick re-reads its pane unless a test shortens it.
pub const CONVERSATION_POLL_MS: u64 = 2_000;

/// One live Conversation's runtime: its pane, worktree, Turn state, Notice queue and tick.
pub struct Runtime {
    pub id: String,
    pub file: PathBuf,
    pub pane_id: Option<String>,
    pub tab_id: Option<String>,
    pub worktree: WorktreeInfo,
    pub exit_code_path: String,
    pub stream_path: String,
    pub log_path: String,
    /// True when the operator enlisted a pane they opened (issue #101): the worktree is the found
    /// directory, the tab and directory are never closed or removed, and End merges the found branch
    /// and leaves both as they are.
    pub enlisted: bool,
    /// The agent identity this Conversation's pane is reported under in herdr's agent sidebar (issue
    /// #94): the harness the Assignment resolved, and the pane's tab label as the message every report
    /// carries.
    pub harness: String,
    pub label: String,
    /// Stored whole and replaced whole on every tick.
    pub turn: TurnState,
    /// The follow-file tailer deriving the log from the pane's Stream file (ADR-0012), started by the
    /// launch and finished by End or crash so the derived log is complete.
    pub tailer: Option<PaneTailer>,
    /// Notices from spawned work that ended, delivered as a Turn once the tick sees this Conversation
    /// waiting.
    pub notices: Vec<Notice>,
    /// Set while Notices keep failing to land in the pane, from the first failure until one lands.
    pub delivery: Option<NoticeDelivery>,
    /// Set the moment End is called; guards the background crash watcher against racing the ending it
    /// already knows about.
    pub ending: bool,
    pub closing: Option<String>,
    /// Who asked for the End: the operator, or a Steward ending itself (ADR-0030).
    pub ended_by: Option<AnswerBy>,
    /// The Steward role (ADR-0030), from the record.
    pub role: Option<ConversationRole>,
    /// What this Steward has been told about, in memory only, so a re-adopted Steward hears everything
    /// still pending.
    pub told: HashSet<String>,
    /// Set once its first offer has taken what merged before it as told.
    pub baselined: bool,
    /// False when this Conversation's tabs may not be closed by id: a runtime rebuilt for an End whose
    /// pane herdr lists as something else (issue #139), where the id no longer names this
    /// Conversation's terminal.
    pub close_tabs: bool,
    pub release: CancellationToken,
    /// The tick: pane read, Turn state, Notice delivery, spawn proposals. Stopped at End, crash and
    /// dispose.
    pub timer: Option<tokio::task::JoinHandle<()>>,
    pub herdr: Herdr,
}

/// A shared handle to one runtime.
#[derive(Clone)]
pub struct Rt(Arc<Mutex<Runtime>>);

impl Rt {
    pub(crate) fn new(runtime: Runtime) -> Self {
        Rt(Arc::new(Mutex::new(runtime)))
    }

    fn lock(&self) -> MutexGuard<'_, Runtime> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Run `f` on the runtime. Never await inside `f`, and never call `with` on the same runtime
    /// inside it.
    pub fn with<R>(&self, f: impl FnOnce(&mut Runtime) -> R) -> R {
        f(&mut self.lock())
    }

    pub fn id(&self) -> String {
        self.with(|r| r.id.clone())
    }
}

// One claim on a Conversation at a time (review F3): an End on a record with no runtime and an adoption
// pass both build a runtime across awaits, and two of them racing would each set one.
struct Claim {
    lock: Arc<tokio::sync::Mutex<()>>,
    holders: usize,
}

/// The Conversation runtimes of one pool.
pub struct Conversations {
    runtimes: IndexMap<String, Rt>,
    /// Ids of starts still in flight (start is async and its record is written well after the herdr tab
    /// opens): the spawn counters fold these in so a second adoption before the record lands can never
    /// mint the same `<parent>-spawn-N` twice.
    reserved: IndexSet<String>,
    /// A Steward start or enlist in flight, which holds the slot before its record is written.
    steward_starting: Option<String>,
    claims: HashMap<String, Claim>,
    /// Boot adoption, one pass at a time: the boot's own and a later retry off the pane survey never
    /// claim the same record twice.
    passes: Arc<tokio::sync::Mutex<()>>,
    retrying: bool,
}

impl Default for Conversations {
    fn default() -> Self {
        Conversations {
            runtimes: IndexMap::new(),
            reserved: IndexSet::new(),
            steward_starting: None,
            claims: HashMap::new(),
            passes: Arc::new(tokio::sync::Mutex::new(())),
            retrying: false,
        }
    }
}

impl std::fmt::Debug for Conversations {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Conversations")
            .field("live", &self.runtimes.keys().collect::<Vec<_>>())
            .field("reserved", &self.reserved)
            .finish()
    }
}

impl Conversations {
    /// Whether a Conversation is live right now (ending included).
    pub fn is_live(&self, id: &str) -> bool {
        self.runtimes.contains_key(id)
    }

    fn runtime(&self, id: &str) -> Option<Rt> {
        self.runtimes.get(id).cloned()
    }

    /// Ids of Conversations whose start is still in flight and has no record on disk yet, so a Spawn
    /// counter never mints one twice before its record reaches disk.
    pub fn reserved_ids(&self) -> Vec<String> {
        self.reserved.iter().cloned().collect()
    }

    /// Reserve an id for a start about to be fired (idempotent). The start releases it when it ends.
    pub fn reserve(&mut self, id: &str) {
        self.reserved.insert(id.to_owned());
    }
}

// ---------------------------------------------------------------------------
// Small helpers over the Session
// ---------------------------------------------------------------------------

pub(crate) fn terminal_backed(s: &Session) -> bool {
    s.state.config.terminal() == Some(ac_protocol::TerminalKind::Herdr)
}

pub(crate) fn conversations_dir(s: &Session) -> PathBuf {
    Path::new(&s.pool_dir).join("conversations")
}

pub(crate) fn conversation_file(s: &Session, id: &str) -> PathBuf {
    conversations_dir(s).join(format!("{id}.md"))
}

/// Every Conversation on disk, sorted by file name.
pub(crate) fn load(s: &Session) -> Vec<ConversationRecord> {
    load_conversations(&conversations_dir(s)).unwrap_or_default()
}

fn record_of(s: &Session, id: &str) -> Option<ConversationRecord> {
    load(s).into_iter().find(|rec| rec.id == id)
}

/// Publish a snapshot now: a Conversation's start, end, crash and Turn changes all happen off the drive
/// loop, so nothing else would.
pub(crate) fn publish(s: &mut Session) {
    let phase = s.idle_phase();
    emit_snapshot(s, phase);
}

pub(crate) fn runs_dir(s: &Session) -> &Path {
    Path::new(&s.runs_dir)
}

pub(crate) fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// One event on a Conversation's own log (attempt 1 unless given).
pub(crate) fn event(
    s: &Session,
    id: &str,
    kind: TicketEventKind,
    payload: Map<String, Value>,
    attempt: u64,
) {
    let _ = append_event(runs_dir(s), id, &event_now(attempt, kind, payload));
}

pub(crate) fn event1(s: &Session, id: &str, kind: TicketEventKind, payload: Value) {
    event(s, id, kind, object(payload), 1);
}

pub(crate) fn last_attempt_of(s: &Session, id: &str) -> u64 {
    last_attempt(runs_dir(s), id)
}

// ---------------------------------------------------------------------------
// The pane's agent identity in herdr's sidebar (issue #94). A Conversation is the one Attempt with a
// Turn state, so it is the one whose reported state moves: "working" while the agent works, "blocked"
// while it waits on the operator, which is herdr's word for "a human is what it needs". Both calls are
// fire-and-forget and swallow their failures, exactly as the tab closes do: the sidebar is a
// convenience, never a dependency.
// ---------------------------------------------------------------------------

pub(crate) fn report_agent(rt: &Rt, state: PaneAgentState) {
    let (herdr, pane, harness, label) = rt.with(|r| {
        (
            r.herdr.clone(),
            r.pane_id.clone(),
            r.harness.to_lowercase(),
            r.label.clone(),
        )
    });
    let Some(pane) = pane else { return };
    tokio::spawn(async move {
        let _ = herdr
            .report_pane_agent(&pane, &harness, state, &label)
            .await;
    });
}

pub(crate) fn release_agent(s: &Session, pane_id: Option<&str>, harness: &str) {
    let Some(pane) = pane_id else { return };
    crate::attempt_run::release_attempt_agent(&s.herdr_socket, pane, harness);
}

// ---------------------------------------------------------------------------
// A started Conversation's launch as its `spawned` event recorded it
// ---------------------------------------------------------------------------

/// The pane and tab a started Conversation ran in, where, and when.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub pane_id: String,
    pub tab_id: Option<String>,
    pub cwd: Option<String>,
    pub terminal_id: Option<String>,
    pub at: String,
}

impl Launch {
    /// The pane as the pane survey compares it with a listing.
    pub(crate) fn recorded(&self) -> crate::pane_survey::RecordedPane {
        crate::pane_survey::RecordedPane {
            pane_id: self.pane_id.clone(),
            tab_id: self.tab_id.clone(),
            cwd: self.cwd.clone(),
            terminal_id: self.terminal_id.clone(),
        }
    }
}

pub(crate) fn launch_of(s: &Session, id: &str) -> Option<Launch> {
    let events = read_events(runs_dir(s), id);
    let spawned = events.iter().rev().find(|e| {
        e.kind == TicketEventKind::Spawned
            && matches!(e.payload.get("pane_id"), Some(Value::String(_)))
    })?;
    let text = |key: &str| match spawned.payload.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };
    Some(Launch {
        pane_id: text("pane_id")?,
        tab_id: text("tab_id"),
        cwd: text("cwd"),
        terminal_id: text("terminal_id"),
        at: spawned.at.clone(),
    })
}

/// The pane a Conversation record names: the found one for an enlisted Conversation, its launch's for
/// a started one.
fn recorded_pane_of(s: &Session, rec: &ConversationRecord) -> Option<String> {
    rec.enlisted
        .as_ref()
        .map(|found| found.pane_id.clone())
        .or_else(|| launch_of(s, &rec.id).map(|launch| launch.pane_id))
}

/// Whether the operator asked this Conversation to End and the End never finished (issue #140): an
/// engine that stopped mid-End leaves the record live, and the next boot finishes it as the ending it
/// was.
pub(crate) fn end_requested(s: &Session, id: &str) -> bool {
    let events = read_events(runs_dir(s), id);
    let Some(asked) = events
        .iter()
        .rposition(|e| e.kind == TicketEventKind::EndRequested)
    else {
        return false;
    };
    !events[asked..]
        .iter()
        .any(|e| e.kind == TicketEventKind::Ended)
}

// ---------------------------------------------------------------------------
// Views (PoolSnapshot.conversations)
// ---------------------------------------------------------------------------

fn children_of(s: &Session, id: &str, conversations: &[ConversationRecord]) -> Vec<String> {
    let tickets = s
        .markers
        .iter()
        .filter(|m| m.spawned_by.as_deref() == Some(id))
        .map(|m| m.id.clone());
    let kids = conversations
        .iter()
        .filter(|c| c.spawned_by.as_deref() == Some(id))
        .map(|c| c.id.clone());
    tickets.chain(kids).collect()
}

fn view_of(
    s: &Session,
    rec: &ConversationRecord,
    conversations: &[ConversationRecord],
) -> ConversationView {
    let runtime = s.conversations.runtime(&rec.id);
    let ending = rec.status == ConversationStatus::Live
        && match &runtime {
            Some(rt) => rt.with(|r| r.ending),
            None => end_requested(s, &rec.id),
        };
    // An enlisted Conversation has no pool branch to derive: the branch it was found on is the one its
    // record names.
    let branch = match &runtime {
        Some(rt) => rt.with(|r| r.worktree.branch.clone()),
        None => match &rec.enlisted {
            Some(found) => found.branch.clone(),
            None => git::branch_for(&s.cwd, &rec.id, None),
        },
    };
    // A record written before drivers were stored reads as the default. A Conversation is always the TUI
    // (ADR-0018), so that is the mode its effort must reach.
    let assignment = Assignment {
        harness: rec.harness.clone(),
        model: rec.model.clone(),
        effort: rec.effort.clone(),
        drivers: if rec.drivers.is_empty() {
            DEFAULT_DRIVERS.to_owned()
        } else {
            rec.drivers.clone()
        },
        verify: None,
    };
    // A live record the engine has not re-adopted yet (issue #140) still names its pane, so the pane
    // stays the pool's in every surface that reads the view: the enlist picker, the terminal routes.
    let pane_id = if ending {
        None
    } else {
        match &runtime {
            Some(rt) => rt.with(|r| r.pane_id.clone()),
            None if rec.status == ConversationStatus::Live => recorded_pane_of(s, rec),
            None => None,
        }
    };
    let turn = match &runtime {
        Some(rt) => rt.with(|r| ConversationTurn {
            state: r.turn.state,
            last_line: r.turn.last_line.clone(),
            idle_since: r.turn.idle_since.clone(),
        }),
        None => ConversationTurn {
            state: TurnSide::Waiting,
            last_line: String::new(),
            idle_since: None,
        },
    };
    ConversationView {
        id: rec.id.clone(),
        title: rec.title.clone(),
        status: rec.status,
        spawned_by: rec.spawned_by.clone(),
        assignment: assignment_view_of(
            &assignment,
            effort_applies(&s.harnesses, &rec.harness, HarnessMode::Interactive),
        ),
        pane_id,
        // A conversation with no live runtime (ended cleanly, or never tracked across a restart) has no
        // branch worth naming once it merged; a git-less pool has none at all. Neither is an error: the
        // card simply shows nothing to look at.
        branch: s.git.then_some(branch),
        turn,
        children: children_of(s, &rec.id, conversations),
        enlisted: rec.enlisted.is_some(),
        ending,
        role: rec.role,
        delivery: runtime.and_then(|rt| rt.with(|r| r.delivery.clone())),
    }
}

/// Every Conversation the pool knows about, live or not, as the snapshot wants them.
pub fn views(s: &Session) -> Vec<ConversationView> {
    let conversations = load(s);
    conversations
        .iter()
        .map(|rec| view_of(s, rec, &conversations))
        .collect()
}

// ---------------------------------------------------------------------------
// What the pool asks of the Conversations
// ---------------------------------------------------------------------------

/// Every pane and tab a Conversation recorded live names, runtime or not: no close, and no enlist, may
/// take one while its record is live.
pub fn live_terminals(s: &Session) -> (HashSet<String>, HashSet<String>) {
    let mut panes = HashSet::new();
    let mut tabs = HashSet::new();
    for rec in load(s) {
        if rec.status != ConversationStatus::Live {
            continue;
        }
        let launch = launch_of(s, &rec.id);
        let pane = match &rec.enlisted {
            Some(found) => Some(found.pane_id.clone()),
            None => launch.as_ref().map(|l| l.pane_id.clone()),
        };
        let tab = match &rec.enlisted {
            Some(found) => found.tab_id.clone(),
            None => launch.and_then(|l| l.tab_id),
        };
        panes.extend(pane);
        tabs.extend(tab);
    }
    (panes, tabs)
}

/// Where every live Conversation works, enlisted ones included: its worktree or found directory. Every
/// live record, adopted or not: a record the engine could not re-adopt still has an agent working where
/// it was recorded (review F9).
pub fn live_directories(s: &Session) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = s
        .conversations
        .runtimes
        .values()
        .map(|rt| rt.with(|r| (r.id.clone(), r.worktree.path.clone())))
        .collect();
    for rec in load(s) {
        if rec.status != ConversationStatus::Live || s.conversations.runtimes.contains_key(&rec.id)
        {
            continue;
        }
        let cwd = match &rec.enlisted {
            Some(found) => Some(found.directory.clone()),
            None => launch_of(s, &rec.id).and_then(|launch| launch.cwd),
        };
        if let Some(cwd) = cwd {
            out.push((rec.id, cwd));
        }
    }
    out
}

/// Ids of Conversations whose start is still in flight and has no record on disk yet.
pub fn reserved_ids(s: &Session) -> Vec<String> {
    s.conversations.reserved_ids()
}

/// The live Steward's id (ADR-0030), adopted or not yet; `None` when none is on duty.
pub fn steward_id(s: &Session) -> Option<String> {
    load(s)
        .into_iter()
        .find(|rec| {
            rec.role == Some(ConversationRole::Steward) && rec.status == ConversationStatus::Live
        })
        .map(|rec| rec.id)
}

pub(crate) fn steward_on_duty(s: &Session) -> Option<String> {
    s.conversations
        .steward_starting
        .clone()
        .or_else(|| steward_id(s))
}

pub(crate) fn second_steward_reason(on_duty: &str) -> String {
    format!("a Steward is already on duty ({on_duty}); end it before starting another")
}

/// An Interrupt on this Ticket was answered: the Steward is told about the next one afresh.
pub fn steward_forget(s: &mut Session, ticket_id: &str) {
    let prefix = format!("interrupt:{ticket_id}:");
    for rt in s.conversations.runtimes.values() {
        rt.with(|r| {
            if r.role == Some(ConversationRole::Steward) {
                r.told.retain(|key| !key.starts_with(&prefix));
            }
        });
    }
}

/// Stop every tick and crash watch; called at shutdown. The pane, its TUI and its tab are left exactly
/// as they are for the next boot to re-adopt (issue #140); a watch left running would record the pane's
/// later end as a crash from an engine that is going away.
pub fn dispose(s: &mut Session) {
    let runtimes: Vec<Rt> = s.conversations.runtimes.values().cloned().collect();
    for rt in runtimes {
        stop_tick(s, &rt);
        rt.with(|r| r.release.cancel());
    }
}

/// Stop the tick and forget the pane's recorded read with it: the tick is the register's only writer for
/// this pane, so once it stops (End, crash, shutdown) the Peek must read live or find nothing, never a
/// viewport frozen at the last tick.
pub(crate) fn stop_tick(s: &mut Session, rt: &Rt) {
    let pane = rt.with(|r| {
        if let Some(timer) = r.timer.take() {
            timer.abort();
        }
        r.pane_id.clone()
    });
    if let Some(pane) = pane {
        s.pane_reads.forget(&pane);
    }
}

/// The live config.
pub(crate) fn config(s: &Session) -> &PoolConfig {
    &s.state.config
}

// ---------------------------------------------------------------------------
// The per-id claim: a claim waits for any claim in flight on the same id
// ---------------------------------------------------------------------------

/// Run `build` as the only claim on `id` at a time.
pub(crate) async fn claim<T>(
    engine: &Engine,
    id: &str,
    build: impl std::future::Future<Output = T>,
) -> Option<T> {
    let key = id.to_owned();
    let lock = engine
        .call(move |s| {
            let claim = s.conversations.claims.entry(key).or_insert_with(|| Claim {
                lock: Arc::new(tokio::sync::Mutex::new(())),
                holders: 0,
            });
            claim.holders += 1;
            Arc::clone(&claim.lock)
        })
        .await
        .ok()?;
    let guard = lock.lock().await;
    let out = build.await;
    drop(guard);
    let key = id.to_owned();
    let _ = engine
        .call(move |s| {
            if let Some(claim) = s.conversations.claims.get_mut(&key) {
                claim.holders -= 1;
                if claim.holders == 0 {
                    s.conversations.claims.remove(&key);
                }
            }
        })
        .await;
    Some(out)
}

/// Whether a claim on `id` is in flight.
pub(crate) fn claiming(s: &Session, id: &str) -> bool {
    s.conversations.claims.contains_key(id)
}

// ---------------------------------------------------------------------------
// Teaching and the Steward
// ---------------------------------------------------------------------------

fn spawn_proposal_path(s: &Session, id: &str) -> String {
    js::path_join(&[&s.runs_dir, &format!("{id}.spawn.json")])
}

// What the pool's `defaults` entry names, as a teaching reads it.
fn defaults_teaching(config: &PoolConfig) -> TeachingAssignment {
    let field = |name: &str| match config.get("defaults").and_then(|d| d.get(name)) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Null) | None => None,
        Some(other) => Some(js::string_of(other)),
    };
    TeachingAssignment {
        harness: field("harness"),
        model: field("model"),
        effort: field("effort"),
        drivers: field("drivers"),
    }
}

/// What a Conversation is taught, by role: a Steward its role and command on top of the Conversation
/// protocol (prompt.ts).
pub(crate) fn teaching_for(
    s: &Session,
    id: &str,
    role: Option<ConversationRole>,
    own: &Assignment,
) -> String {
    let config = config(s);
    let spawn_path = spawn_proposal_path(s, id);
    let own = TeachingAssignment {
        harness: Some(own.harness.clone()),
        model: Some(own.model.clone()),
        effort: own.effort.clone(),
        drivers: Some(own.drivers.clone()),
    };
    let per_file = ac_core::spawn_caps::spawn_caps_of(config).per_attempt;
    let ledger = js::path_text(&ac_core::spawn_ledger::spawn_ledger_path(runs_dir(s)));
    let defaults = defaults_teaching(config);
    if role != Some(ConversationRole::Steward) {
        return ac_core::prompt::build_conversation_teaching(
            &spawn_path,
            &own,
            &defaults,
            per_file,
            &ledger,
        );
    }
    stewards::steward_teaching(s, id, &spawn_path, &own, &defaults, per_file, &ledger)
}

/// What a Steward is told and how it is taught: the seam to the Steward port (steward.ts), kept in one
/// place so the two ports meet here.
pub(crate) mod stewards {
    use super::*;
    use ac_core::steward::{
        StewardItem, StewardItemKind, fresh_steward_items, steward_batch_text, steward_command,
    };
    use ac_core::steward::{steward_budget_of, steward_may_close_of};

    pub type Item = StewardItem;

    /// What a Steward should be told about now (steward.ts's `stewardItems` over the session).
    pub(super) fn items(s: &mut Session) -> Vec<StewardItem> {
        crate::steward_actions::steward_items_of(s)
    }

    pub(super) fn fresh(
        told: &mut HashSet<String>,
        items: &[StewardItem],
        baseline: bool,
    ) -> Vec<StewardItem> {
        fresh_steward_items(told, items, baseline)
    }

    pub(super) fn batch_text(items: &[StewardItem]) -> String {
        steward_batch_text(items)
    }

    pub fn notice_kind(kind: StewardItemKind) -> ac_core::notices::NoticeKind {
        use ac_core::notices::NoticeKind;
        match kind {
            StewardItemKind::Interrupt => NoticeKind::StewardInterrupt,
            StewardItemKind::MergeStall => NoticeKind::StewardMergeStall,
            StewardItemKind::Merged => NoticeKind::StewardMerged,
            StewardItemKind::Pool => NoticeKind::StewardPool,
        }
    }

    pub(super) fn steward_teaching(
        s: &Session,
        id: &str,
        spawn_path: &str,
        own: &TeachingAssignment,
        defaults: &TeachingAssignment,
        per_file: u64,
        ledger: &str,
    ) -> String {
        let exe = std::env::current_exe()
            .map(|path| js::path_text(&path))
            .unwrap_or_else(|_| "agent-console".to_owned());
        let command = steward_command(&exe, &s.pool_dir, s.console_url.as_deref(), id);
        ac_core::prompt::build_steward_teaching(&ac_core::prompt::StewardTeaching {
            spawn_path,
            own,
            defaults,
            per_file,
            ledger_path: ledger,
            command: &command,
            budget: steward_budget_of(&s.state.config),
            may_close: steward_may_close_of(&s.state.config),
        })
    }
}

pub(crate) use stewards::{Item as StewardItem, notice_kind as steward_notice_kind};

/// Queue whatever the Steward has not been told about yet, once per item: an item already queued is not
/// queued twice.
pub(crate) fn offer_steward(s: &mut Session, rt: &Rt) {
    let items = stewards::items(s);
    let id = rt.id();
    rt.with(|r| {
        let queued: HashSet<String> = r.notices.iter().filter_map(|n| n.key.clone()).collect();
        let baseline = !r.baselined;
        let fresh = stewards::fresh(&mut r.told, &items, baseline);
        r.baselined = true;
        for item in fresh {
            if queued.contains(&item.key) {
                continue;
            }
            r.notices.push(Notice {
                to: id.clone(),
                from: item.ticket_id.clone().unwrap_or_else(|| id.clone()),
                kind: steward_notice_kind(item.kind),
                text: item.text.clone(),
                key: Some(item.key.clone()),
            });
        }
    });
}

pub(crate) fn steward_items_now(s: &mut Session) -> Vec<StewardItem> {
    stewards::items(s)
}

pub(crate) fn steward_batch_text(items: &[StewardItem]) -> String {
    stewards::batch_text(items)
}

// ---------------------------------------------------------------------------
// The host's smaller operations
// ---------------------------------------------------------------------------

/// A runtime for an enlisted Conversation (issue #101): the found pane's facts, the found directory and
/// branch standing in as its worktree, no tailer and no engine-owned exit-code or Stream file, since the
/// operator opened the pane. Shared by the live enlist and the boot re-adoption so the two claims cannot
/// drift.
pub(crate) struct EnlistedFacts<'a> {
    pub id: &'a str,
    pub file: PathBuf,
    pub pane_id: &'a str,
    pub tab_id: Option<String>,
    pub harness: &'a str,
    pub title: &'a str,
    pub directory: &'a str,
    pub branch: &'a str,
    pub role: Option<ConversationRole>,
}

pub(crate) fn enlisted_runtime(s: &Session, facts: EnlistedFacts<'_>) -> Rt {
    let id = facts.id;
    Rt::new(Runtime {
        id: id.to_owned(),
        file: facts.file,
        pane_id: Some(facts.pane_id.to_owned()),
        tab_id: facts.tab_id,
        worktree: WorktreeInfo {
            path: facts.directory.to_owned(),
            branch: facts.branch.to_owned(),
        },
        exit_code_path: js::path_join(&[&s.runs_dir, &format!("{id}.exit")]),
        stream_path: js::path_join(&[&s.runs_dir, &format!("{id}.stream.jsonl")]),
        log_path: js::path_join(&[&s.runs_dir, &format!("{id}.log")]),
        enlisted: true,
        harness: facts.harness.to_owned(),
        label: ac_io::herdr::attempt_tab_label(id, facts.title),
        turn: ac_core::turn_state::FRESH_TURN,
        tailer: None,
        notices: Vec::new(),
        delivery: None,
        ending: false,
        closing: None,
        ended_by: None,
        role: facts.role,
        told: HashSet::new(),
        baselined: false,
        close_tabs: true,
        release: CancellationToken::new(),
        timer: None,
        herdr: Herdr::new(&s.herdr_socket),
    })
}

/// A started Conversation's runtime rebuilt from its record and launch, with no tick, tailer or watch
/// yet: the boot adoption adds those, an End with no runtime (issue #140) needs none.
pub(crate) fn started_runtime(s: &Session, rec: &ConversationRecord, tab_id: Option<String>) -> Rt {
    use ac_core::events::{attempt_exit_code_name, attempt_log_name, attempt_stream_name};
    let launch = launch_of(s, &rec.id);
    Rt::new(Runtime {
        id: rec.id.clone(),
        file: rec.file.clone(),
        pane_id: launch.map(|l| l.pane_id),
        tab_id,
        worktree: WorktreeInfo {
            path: git::worktree_path_for(&s.cwd, &rec.id, None),
            branch: git::branch_for(&s.cwd, &rec.id, None),
        },
        exit_code_path: js::path_join(&[
            &s.runs_dir,
            &attempt_exit_code_name(&rec.id, None, false),
        ]),
        stream_path: js::path_join(&[&s.runs_dir, &attempt_stream_name(&rec.id, None, false)]),
        log_path: js::path_join(&[&s.runs_dir, &attempt_log_name(&rec.id, None, false)]),
        enlisted: false,
        harness: rec.harness.clone(),
        label: ac_io::herdr::attempt_tab_label(&rec.id, &rec.title),
        turn: ac_core::turn_state::FRESH_TURN,
        tailer: None,
        notices: Vec::new(),
        delivery: None,
        ending: false,
        closing: None,
        ended_by: None,
        role: rec.role,
        told: HashSet::new(),
        baselined: false,
        close_tabs: true,
        release: CancellationToken::new(),
        timer: None,
        herdr: Herdr::new(&s.herdr_socket),
    })
}

/// Record a Conversation's resolved Assignment under its id (if not already known) so work it spawns
/// inherits it.
pub(crate) fn record_assignment(s: &mut Session, id: &str, assignment: Assignment) {
    if !s.assignments.contains_key(id) {
        s.assignments.insert(id.to_owned(), assignment);
    }
}

pub(crate) fn marker_of_conversation(id: &str, file: &Path) -> TicketMarker {
    TicketMarker {
        id: id.to_owned(),
        file: file.to_path_buf(),
        blocked_by: Vec::new(),
        status: ac_protocol::TicketStatus::Done,
        title: id.to_owned(),
        spec: String::new(),
        spawned_by: None,
        enlisted_from: None,
        spawn_assign: None,
    }
}
