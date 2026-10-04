//! The Session: everything one pool's run knows (engine.ts `Session`), owned by the actor
//! ([`crate::actor`]) and touched only inside its jobs; the state the checkpoints carry
//! ([`PoolState`]) and the one way it changes ([`apply_update`]).
//!
//! Fields whose module another port owns carry that module's type, a narrow stub where the module is
//! not ported yet (marked STUB in the module).

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::{IndexMap, IndexSet};
use tokio::sync::{oneshot, watch};

use ac_core::assignment::Assignments;
use ac_core::checkpoints::CheckpointStore;
use ac_core::harness::Harnesses;
use ac_core::machine_defaults::MachineDefaultsPaths;
use ac_core::merge_hold::{MergeHoldMemo, MergeHoldWatch, MergeLine};
use ac_core::pool::TicketMarker;
use ac_core::queued_answers::QueuedAnswerStore;
use ac_core::spawn_proposals::SpawnProposals;
use ac_core::steward_notes::StewardNotes;
use ac_protocol::{Interrupt, Outcome, RunPhase, TicketStatus};

use crate::actor::{Engine, SnapshotPublisher};
use crate::children::ChildTracker;
use crate::conversations::Conversations;
use crate::enlisted::EnlistedAttempts;
use crate::error::EngineError;
use crate::held::{HeldPane, PaneSurvey};
use crate::jev::Jev;
use crate::keep_talking::{ContinuedAttempt, ContinuedGrade};
use crate::live_attempts::LiveAttempts;
use crate::options::SnapshotHook;
use crate::pane_reads::PaneReadRegister;
use crate::pane_session::LaunchCadence;
use crate::pool_workspace::PoolWorkspaceState;
use crate::restart::HeadlessOrphan;
use crate::snapshot::PoolSnapshot;
use crate::terminals::{EnlistedTerminals, OpenedTab};

pub use crate::snapshot::PoolState;

/// The final Review interrupt is the run's, not a ticket's: it carries this id so the Console can hang
/// it on the review card.
pub const REVIEW_TICKET_ID: &str = "REVIEW";

/// The persistence interrupt is run-level too: raised when the checkpoint store keeps failing at a
/// boundary.
pub const PERSISTENCE_TICKET_ID: &str = "PERSISTENCE";

/// One change to the pool state (engine.ts `PoolUpdate`). Tickets and outcomes merge by key, the log
/// appends, interrupts and config replace whole, and the Review approval replaces.
#[derive(Debug, Clone, Default)]
pub struct PoolUpdate {
    pub tickets: Option<IndexMap<String, TicketStatus>>,
    pub log: Option<Vec<String>>,
    pub outcomes: Option<IndexMap<String, Outcome>>,
    pub interrupts: Option<Vec<Interrupt>>,
    pub review_approved: Option<bool>,
    /// The sanctioned way to replace the assignment slice of the live config (ADR-0018), at the
    /// super-step boundary only.
    pub config: Option<ac_core::config::PoolConfig>,
}

impl PoolUpdate {
    /// An update that only adds pool log lines.
    pub fn log(lines: impl IntoIterator<Item = String>) -> Self {
        PoolUpdate {
            log: Some(lines.into_iter().collect()),
            ..PoolUpdate::default()
        }
    }
}

/// `applyUpdate`: the reducers, channel by channel.
pub fn apply_update(state: &mut PoolState, update: PoolUpdate) {
    if let Some(tickets) = update.tickets {
        state.tickets.extend(tickets);
    }
    if let Some(log) = update.log {
        state.log.extend(log);
    }
    if let Some(outcomes) = update.outcomes {
        state.outcomes.extend(outcomes);
    }
    if let Some(interrupts) = update.interrupts {
        state.interrupts = interrupts;
    }
    if let Some(config) = update.config {
        state.config = config;
    }
    if let Some(approved) = update.review_approved {
        state.review_approved = approved;
    }
}

/// The found work of an enlisted ticket (issue #101): the branch and directory the pane was enlisted
/// from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnlistedWork {
    pub branch: String,
    pub directory: String,
}

/// One terminal-backed attempt re-adopted at boot (ADR-0014). `abandoned` is set when the operator
/// answered the adoption interrupt: the finalize must record nothing further.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdoptedAttempt {
    pub pane_id: String,
    pub attempt: u64,
    pub abandoned: bool,
}

/// A waiter for the drive's next settle: the settled phase, or the error that killed the drive.
pub type SettleWaiter = oneshot::Sender<Result<RunPhase, EngineError>>;

/// A waiter for one queued answer's processing.
pub type AnswerWaiter = oneshot::Sender<Result<(), EngineError>>;

/// One link of the merge serialization chain: resolves once every merge chained before it is done.
/// The session's chain never fails (a failed merge must not wedge the next caller's).
pub type MergeChain = Shared<BoxFuture<'static, ()>>;

/// A merge chain that is already resolved.
pub fn settled_chain() -> MergeChain {
    futures::future::ready(()).boxed().shared()
}

/// One pool's run.
pub struct Session {
    /// This session's own handle, set by the actor before its first job, so session functions can
    /// start flows.
    pub engine: Option<Engine>,
    /// Where every emit publishes its snapshot.
    pub publisher: SnapshotPublisher,
    pub pool_dir: String,
    pub issues_dir: String,
    pub runs_dir: String,
    /// The repository root the pool lives in: the pool checkout.
    pub cwd: String,
    pub git: bool,
    pub harnesses: Harnesses,
    pub assignments: Assignments,
    pub markers: Vec<TicketMarker>,
    pub state: PoolState,
    /// The emitted snapshots kept, newest last (`snapshotHistory` of them).
    pub snapshots: VecDeque<Arc<PoolSnapshot>>,
    pub snapshot_history: Option<usize>,
    /// The count of every emit so far, kept or not: the next emit's seq.
    pub emitted: u64,
    pub store: Box<dyn CheckpointStore>,
    pub store_open: bool,
    pub super_step: u64,
    pub answers: QueuedAnswerStore,
    /// True while a drive loop is in flight (between super-step boundaries included).
    pub driving: bool,
    pub settled_phase: Option<RunPhase>,
    pub settle_waiters: Vec<SettleWaiter>,
    pub answer_waiters: HashMap<u64, Vec<AnswerWaiter>>,
    pub on_snapshot: Option<SnapshotHook>,
    /// Where the Machine defaults live (issue #121).
    pub machine_defaults: MachineDefaultsPaths,
    /// Where terminal-backed attempts reach the herdr daemon (ADR-0014).
    pub herdr_socket: String,
    /// The environment every harness child inherits.
    pub parent_env: Arc<Vec<(String, String)>>,
    pub launch_cadence: Option<LaunchCadence>,
    /// The Pool workspace (issue #94): where every tab this pool opens lands.
    pub pool_workspace: PoolWorkspaceState,
    /// The Pending and Held spawns (ADR-0029, issue #150).
    pub spawn_proposals: SpawnProposals,
    /// The Spawn ledger as last written, so an emit that changed nothing writes nothing.
    pub spawn_ledger: Option<String>,
    /// Ticket-origin Spawns adopted this run (this Console boot), bounding the per-run cap.
    pub spawned_this_run: u64,
    /// Boot reconciliation: true once it has landed. The drive waits for it before its first
    /// scheduling, so a ticket about to be re-adopted from a live pane is never re-spawned.
    pub terminal_reconcile: watch::Receiver<bool>,
    /// Attempts re-adopted at boot, by ticket id.
    pub adopted: HashMap<String, AdoptedAttempt>,
    /// The merge serialization chain: every merge chains onto it, so two merges never run their git
    /// work concurrently on the pool checkout.
    pub merge_chain: MergeChain,
    /// The Merge queue's in-memory line.
    pub merge_line: MergeLine,
    /// The raw console.json text last considered at a boundary (ADR-0018); `None` when no file was
    /// there.
    pub last_config_text: Option<String>,
    pub jev: Jev,
    /// The headless children of this engine process (ADR-0017).
    pub children: ChildTracker,
    /// Headless orphans rehydrate found still alive from a previous engine process.
    pub orphans: Vec<HeadlessOrphan>,
    pub conversations: Conversations,
    /// The Live attempts registry: every Attempt between its launch and its ending.
    pub live_attempts: LiveAttempts,
    /// The Merge hold watch: re-derives the hold while the last emitted set is non-empty.
    pub hold_watch: MergeHoldWatch,
    /// The running watch timer's generation; a timer whose generation is no longer this one stops.
    pub hold_watch_timer: u64,
    /// The Merge hold's derivation behind its memo (issue #157).
    pub derive_hold: MergeHoldMemo,
    pub enlisted: EnlistedAttempts,
    /// The pane read register (issue #122).
    pub pane_reads: PaneReadRegister,
    /// The found work of every enlisted ticket (issue #101).
    pub enlisted_work: HashMap<String, EnlistedWork>,
    /// The branch this pool merges into, captured when an enlist moves the pool's own checkout.
    pub merge_target: Option<String>,
    pub enlist_poll_ms: Option<u64>,
    pub teaching_wait_ms: Option<u64>,
    pub conversation_poll_ms: Option<u64>,
    pub pane_survey_ms: Option<u64>,
    pub console_url: Option<String>,
    /// Held panes (issue #139): the pane of every ticket's checkpointed Terminal-backed attempt.
    pub held: HashMap<String, HeldPane>,
    /// The Continued attempts in flight (issue #139).
    pub continued: HashMap<String, ContinuedAttempt>,
    /// Continued attempts on a verify ticket that ended done and wait to be graded as lone attempts.
    pub continued_grades: Vec<ContinuedGrade>,
    /// What is writing in the pool checkout on the engine's own account right now (ADR-0027), each
    /// as a phrase for Keep talking's refusal, in the order they began.
    pub pool_checkout_writers: IndexMap<u64, String>,
    pub pool_checkout_writer_seq: u64,
    /// Tickets the drive planned into the pool checkout, from the plan to the attempt's ending.
    pub pool_checkout_planned: IndexSet<String>,
    /// The pane survey (issue #139); `None` in a headless pool.
    pub pane_survey: Option<PaneSurvey>,
    /// The tabs this pool's `spawned` events name, re-read with each survey listing.
    pub opened_tabs: Vec<OpenedTab>,
    /// Every pane and tab an enlisted owner's events name, re-read with each survey listing.
    pub enlisted_terminals: EnlistedTerminals,
    /// The Steward notes (ADR-0030).
    pub steward_notes: StewardNotes,
    /// The Steward budget used per Ticket; only Tickets with some used are kept.
    pub steward_used: IndexMap<String, u64>,
    /// Held spawns the Steward adopted, by id, waiting for the boundary that lands them.
    pub steward_adopts: HashMap<String, String>,
}

/// What a Session cannot be built without; every other field starts empty (see [`Session::new`]).
pub struct SessionBase {
    pub publisher: SnapshotPublisher,
    pub pool_dir: String,
    pub runs_dir: String,
    /// The repository root the pool lives in.
    pub cwd: String,
    pub git: bool,
    pub harnesses: Harnesses,
    pub config: ac_core::config::PoolConfig,
    pub store: Box<dyn CheckpointStore>,
    pub machine_defaults: MachineDefaultsPaths,
    pub herdr_socket: String,
    pub spawn_proposals: SpawnProposals,
    pub terminal_reconcile: watch::Receiver<bool>,
}

impl Session {
    /// A session over `base` with no Tickets, no Assignments, an empty state and every runtime empty.
    pub fn new(base: SessionBase) -> Self {
        let runs = std::path::Path::new(&base.runs_dir);
        Session {
            engine: None,
            publisher: base.publisher,
            issues_dir: ac_core::js::path_join(&[&base.pool_dir, "issues"]),
            answers: QueuedAnswerStore::open(runs),
            steward_notes: ac_core::steward_notes::load_steward_notes(runs),
            pool_dir: base.pool_dir,
            runs_dir: base.runs_dir,
            cwd: base.cwd,
            git: base.git,
            harnesses: base.harnesses,
            assignments: Assignments::new(),
            markers: Vec::new(),
            state: PoolState::empty(base.config),
            snapshots: VecDeque::new(),
            snapshot_history: None,
            emitted: 0,
            store: base.store,
            store_open: true,
            super_step: 0,
            driving: false,
            settled_phase: None,
            settle_waiters: Vec::new(),
            answer_waiters: HashMap::new(),
            on_snapshot: None,
            machine_defaults: base.machine_defaults,
            herdr_socket: base.herdr_socket,
            parent_env: Arc::new(Vec::new()),
            launch_cadence: None,
            pool_workspace: PoolWorkspaceState::default(),
            spawn_proposals: base.spawn_proposals,
            spawn_ledger: None,
            spawned_this_run: 0,
            terminal_reconcile: base.terminal_reconcile,
            adopted: HashMap::new(),
            merge_chain: settled_chain(),
            merge_line: MergeLine::new(),
            last_config_text: None,
            jev: Jev::unconfigured(),
            children: ChildTracker::default(),
            orphans: Vec::new(),
            conversations: Conversations::default(),
            live_attempts: LiveAttempts::default(),
            hold_watch: MergeHoldWatch::new(),
            hold_watch_timer: 0,
            derive_hold: MergeHoldMemo::new(),
            enlisted: EnlistedAttempts::default(),
            pane_reads: PaneReadRegister::default(),
            enlisted_work: HashMap::new(),
            merge_target: None,
            enlist_poll_ms: None,
            teaching_wait_ms: None,
            conversation_poll_ms: None,
            pane_survey_ms: None,
            console_url: None,
            held: HashMap::new(),
            continued: HashMap::new(),
            continued_grades: Vec::new(),
            pool_checkout_writers: IndexMap::new(),
            pool_checkout_writer_seq: 0,
            pool_checkout_planned: IndexSet::new(),
            pane_survey: None,
            opened_tabs: Vec::new(),
            enlisted_terminals: EnlistedTerminals::default(),
            steward_used: IndexMap::new(),
            steward_adopts: HashMap::new(),
        }
    }

    /// This session's handle. Set by the actor before any job runs.
    pub fn engine(&self) -> Engine {
        self.engine
            .clone()
            .expect("the session's engine is attached before its first job")
    }

    /// Add one pool log line.
    pub fn log(&mut self, line: impl Into<String>) {
        self.state.log.push(line.into());
    }

    /// Apply one update to the state.
    pub fn apply(&mut self, update: PoolUpdate) {
        apply_update(&mut self.state, update);
    }

    /// The phase an emit outside the drive's own lifecycle carries: `settledPhase ?? "running"`.
    pub fn idle_phase(&self) -> RunPhase {
        self.settled_phase.unwrap_or(RunPhase::Running)
    }

    /// `session.driving ? "running" : (session.settledPhase ?? "running")`.
    pub fn current_phase(&self) -> RunPhase {
        if self.driving {
            RunPhase::Running
        } else {
            self.idle_phase()
        }
    }

    /// The marker of a ticket, by id.
    pub fn marker(&self, id: &str) -> Option<&TicketMarker> {
        self.markers.iter().find(|marker| marker.id == id)
    }

    /// The marker of a ticket, by id, to change.
    pub fn marker_mut(&mut self, id: &str) -> Option<&mut TicketMarker> {
        self.markers.iter_mut().find(|marker| marker.id == id)
    }

    /// Every marker's status, as the pool state's tickets channel takes them.
    pub fn marker_statuses(&self) -> IndexMap<String, TicketStatus> {
        self.markers
            .iter()
            .map(|marker| (marker.id.clone(), marker.status))
            .collect()
    }

    /// The pool state's tickets in the order JavaScript enumerates an object's keys
    /// (`Object.entries(state.tickets)`).
    pub fn tickets_in_js_order(&self) -> Vec<(&String, &TicketStatus)> {
        js_key_order(&self.state.tickets)
    }

    /// The status the pool state holds for a ticket.
    pub fn status_of(&self, id: &str) -> Option<TicketStatus> {
        self.state.tickets.get(id).copied()
    }
}

/// A map's entries in the order JavaScript enumerates an object's own keys: array-index keys ascending
/// first, then every other key in insertion order.
pub fn js_key_order<V>(map: &IndexMap<String, V>) -> Vec<(&String, &V)> {
    let mut indices: Vec<(u32, (&String, &V))> = Vec::new();
    let mut others = Vec::with_capacity(map.len());
    for entry in map {
        match ac_core::js::array_index(entry.0) {
            Some(index) => indices.push((index, entry)),
            None => others.push(entry),
        }
    }
    indices.sort_by_key(|(index, _)| *index);
    indices
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(others)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_update_merges_tickets_and_outcomes_appends_the_log_and_replaces_the_rest() {
        let mut state = PoolState::empty(ac_core::config::PoolConfig::default());
        state.tickets.insert("01".into(), TicketStatus::Ready);
        state.interrupts.push(Interrupt {
            ticket_id: "01".into(),
            kind: ac_protocol::InterruptKind::Crash,
            body: "b".into(),
            candidates: None,
            steward_note: None,
        });
        apply_update(
            &mut state,
            PoolUpdate {
                tickets: Some(IndexMap::from([
                    ("02".to_string(), TicketStatus::Done),
                    ("01".to_string(), TicketStatus::InProgress),
                ])),
                log: Some(vec!["a".into()]),
                ..PoolUpdate::default()
            },
        );
        apply_update(&mut state, PoolUpdate::log(["b".to_string()]));
        apply_update(
            &mut state,
            PoolUpdate {
                interrupts: Some(vec![]),
                review_approved: Some(true),
                ..PoolUpdate::default()
            },
        );
        assert_eq!(
            state.tickets.iter().collect::<Vec<_>>(),
            [
                (&"01".to_string(), &TicketStatus::InProgress),
                (&"02".to_string(), &TicketStatus::Done)
            ]
        );
        assert_eq!(state.log, ["a", "b"]);
        assert!(state.interrupts.is_empty());
        assert!(state.review_approved);
    }

    #[test]
    fn js_key_order_puts_array_indices_first_ascending() {
        let map: IndexMap<String, u8> = [("b", 1), ("10", 2), ("01", 3), ("2", 4)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let keys: Vec<&str> = js_key_order(&map)
            .into_iter()
            .map(|(k, _)| k.as_str())
            .collect();
        assert_eq!(keys, ["2", "10", "b", "01"]);
    }
}
