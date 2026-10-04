//! The engine's own snapshot (engine.ts `PoolSnapshot`), emitted at every lifecycle point and
//! published on the engine's watch channel, and the one emit point (`emitSnapshot`). The server
//! enriches the snapshot into the wire's `EnrichedSnapshot` (server.ts `enrich`); this is not a wire
//! shape itself.

use std::collections::HashSet;
use std::sync::Arc;

use indexmap::IndexMap;
use serde::Serialize;

use ac_core::config::PoolConfig;
use ac_core::merge_hold::WatchTimer;
use ac_core::spawn_caps::spawn_caps_of;
use ac_core::steward::steward_budget_of;
use ac_protocol::{
    AssignmentView, AttemptRole, ConversationView, HeldPaneRecord, HeldSpawnView, Interrupt,
    LiveAttemptRecord, MergeQueueEntry, Outcome, PendingSpawnView, QueuedAnswer, RunPhase,
    SpawnUsage, StewardBudgetView, TicketStatus,
};

use crate::session::Session;

/// The run's state (engine.ts `PoolState`): what a checkpoint stores and a snapshot carries.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolState {
    /// Every Ticket's status, by id, in the order the pool loaded them.
    pub tickets: IndexMap<String, TicketStatus>,
    /// The pool log, whole.
    pub log: Vec<String>,
    /// The Outcome each Ticket's latest Attempt recorded, by id.
    pub outcomes: IndexMap<String, Outcome>,
    /// The live config: console.json as the engine holds it, JavaScript's undefined slots included
    /// (ac_core's config).
    pub config: PoolConfig,
    /// The pending Interrupts, in the order they were raised; the snapshot's copy carries Steward notes.
    pub interrupts: Vec<Interrupt>,
    /// True once the final Review was approved. Persisted with the checkpoint so a restart after
    /// approval comes up done instead of re-raising the gate.
    pub review_approved: bool,
}

impl PoolState {
    /// No tickets, no log, no outcomes, no interrupts, under `config`.
    pub fn empty(config: PoolConfig) -> Self {
        PoolState {
            tickets: IndexMap::new(),
            log: Vec::new(),
            outcomes: IndexMap::new(),
            config,
            interrupts: Vec::new(),
            review_approved: false,
        }
    }
}

/// One emitted version of the run (engine.ts `PoolSnapshot`).
#[derive(Debug, Clone, PartialEq)]
pub struct PoolSnapshot {
    pub seq: u64,
    pub phase: RunPhase,
    pub state: PoolState,
    /// The queued-answer store's pending records at emit time (ADR-0004).
    pub queued_answers: Vec<QueuedAnswer>,
    /// One resolved Assignment record per ticket (ADR-0013).
    pub assignments: IndexMap<String, AssignmentView>,
    /// Every Conversation the pool knows about, live or not.
    pub conversations: Vec<ConversationView>,
    /// The Live attempt per ticket.
    pub live_attempts: IndexMap<String, LiveAttemptRecord>,
    /// The Held pane per ticket (issue #139).
    pub held_panes: IndexMap<String, HeldPaneRecord>,
    /// How many Finished terminals the pool has (issue #139).
    pub finished_terminals: u64,
    /// The Merge hold (ADR-0014): the done-but-unmerged ticket ids, derived fresh at every emit.
    pub merge_hold: Vec<String>,
    /// The Merge queue (issue #129): the same ids in the order the engine works through them.
    pub merge_queue: Vec<MergeQueueEntry>,
    /// The Spawn caps in force and this run's count against the per-run one (ADR-0029).
    pub spawn_usage: SpawnUsage,
    /// The Pending spawns (issue #150), oldest first.
    pub pending_spawns: Vec<PendingSpawnView>,
    /// The Held spawns (ADR-0029), oldest first.
    pub held_spawns: Vec<HeldSpawnView>,
    /// The Steward budget (ADR-0030).
    pub steward_budget: StewardBudgetView,
}

/// `emitSnapshot`: the one emit point for every snapshot the run produces. The hold is derived fresh
/// here and nowhere persisted (ADR-0014); the watch notes what went out so a merge done by hand can
/// move it. Each snapshot carries the store's pending answers at emit time.
pub fn emit_snapshot(session: &mut Session, phase: RunPhase) {
    let hold = crate::merges::merge_hold(session);
    let live_attempts = {
        let conversations = &session.conversations;
        session
            .live_attempts
            .records(|id| conversations.is_live(id))
    };
    let listing_finished = crate::held::finished_terminals_now(session);
    let state = crate::steward_actions::with_steward_notes(session);
    let assignments = session
        .assignments
        .iter()
        .map(|(id, assignment)| {
            (
                id.clone(),
                crate::config_reload::assignment_wire_view(session, assignment),
            )
        })
        .collect();
    let resolvers: HashSet<String> = live_attempts
        .iter()
        .filter(|(_, live)| live.role == AttemptRole::Resolver)
        .map(|(id, _)| id.clone())
        .collect();
    let merge_queue = session
        .merge_line
        .queue(&hold, &resolvers, &session.state.interrupts);
    let caps = spawn_caps_of(&session.state.config);
    let snapshot = PoolSnapshot {
        seq: session.emitted,
        phase,
        state,
        queued_answers: session.answers.pending(),
        assignments,
        conversations: session.conversations.views(),
        live_attempts,
        held_panes: crate::held::held_pane_records(session),
        finished_terminals: listing_finished,
        merge_hold: hold.clone(),
        merge_queue,
        spawn_usage: SpawnUsage {
            spawned_this_run: session.spawned_this_run,
            per_attempt: caps.per_attempt,
            per_run: caps.per_run,
        },
        pending_spawns: session.spawn_proposals.pending_views(),
        held_spawns: session.spawn_proposals.held_views(),
        steward_budget: StewardBudgetView {
            budget: steward_budget_of(&session.state.config),
            used: session
                .steward_used
                .iter()
                .map(|(id, used)| (id.clone(), *used))
                .collect(),
        },
    };
    // The Spawn ledger follows every emit, so what agents read there is never staler than what the
    // Console shows (issue #150).
    crate::spawns::refresh_spawn_ledger(session, &snapshot.conversations);
    session.emitted += 1;
    let snapshot = Arc::new(snapshot);
    session.snapshots.push_back(snapshot.clone());
    if let Some(history) = session.snapshot_history {
        while session.snapshots.len() > history {
            session.snapshots.pop_front();
        }
    }
    hold_watch_emitted(session, &hold);
    session.unpublished = Some(snapshot.clone());
    if let Some(hook) = &session.on_snapshot {
        hook(&snapshot);
    }
}

// The hold watch's timer (merge-hold.ts `createMergeHoldWatch`): while the last emitted set is
// non-empty, re-derive on a slow cadence and emit when the set differs.
fn hold_watch_emitted(session: &mut Session, hold: &[String]) {
    match session.hold_watch.emitted(hold) {
        WatchTimer::Keep => {}
        WatchTimer::Stop => session.hold_watch_timer += 1,
        WatchTimer::Start => {
            session.hold_watch_timer += 1;
            let generation = session.hold_watch_timer;
            let Some(engine) = session.engine.clone() else {
                return;
            };
            tokio::spawn(async move {
                let interval =
                    std::time::Duration::from_millis(ac_core::merge_hold::MERGE_HOLD_WATCH_MS);
                loop {
                    tokio::time::sleep(interval).await;
                    let ticking = engine
                        .call(move |s| {
                            if s.hold_watch_timer != generation || !s.hold_watch.ticking() {
                                return false;
                            }
                            let derived = crate::merges::merge_hold(s);
                            if s.hold_watch.changed(&derived) {
                                let phase = s.idle_phase();
                                emit_snapshot(s, phase);
                            }
                            s.hold_watch_timer == generation && s.hold_watch.ticking()
                        })
                        .await;
                    if !matches!(ticking, Ok(true)) {
                        return;
                    }
                }
            });
        }
    }
}
