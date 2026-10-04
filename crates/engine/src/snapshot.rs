//! The engine's own snapshot (engine.ts `PoolSnapshot`), emitted at every lifecycle point and
//! published on the engine's watch channel. The server enriches it into the wire's
//! `EnrichedSnapshot` (server.ts `enrich`); this is not a wire shape itself.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use ac_protocol::{
    AssignmentView, ConversationView, HeldPaneRecord, HeldSpawnView, Interrupt, LiveAttemptRecord,
    MergeQueueEntry, Outcome, PendingSpawnView, QueuedAnswer, RunPhase, SpawnUsage,
    StewardBudgetView, TicketStatus,
};

/// The run's state as the snapshot carries it (engine.ts `PoolState`).
#[derive(Debug, Clone, PartialEq)]
pub struct PoolState {
    /// Every Ticket's status, by id, in the order the pool loaded them.
    pub tickets: IndexMap<String, TicketStatus>,
    /// The pool log, whole.
    pub log: Vec<String>,
    /// The Outcome each Ticket's latest Attempt recorded, by id.
    pub outcomes: IndexMap<String, Outcome>,
    /// The live config: console.json as the engine holds it, verbatim JSON (see ac_core's config).
    pub config: Map<String, Value>,
    /// The pending Interrupts, in the order they were raised; the snapshot's copy carries Steward notes.
    pub interrupts: Vec<Interrupt>,
    /// True once the final Review was approved.
    pub review_approved: bool,
}

/// One emitted version of the run (engine.ts `PoolSnapshot`).
#[derive(Debug, Clone, PartialEq)]
pub struct PoolSnapshot {
    pub seq: u64,
    pub phase: RunPhase,
    pub state: PoolState,
    pub queued_answers: Vec<QueuedAnswer>,
    pub assignments: IndexMap<String, AssignmentView>,
    pub conversations: Vec<ConversationView>,
    pub live_attempts: IndexMap<String, LiveAttemptRecord>,
    pub held_panes: IndexMap<String, HeldPaneRecord>,
    pub finished_terminals: u64,
    pub merge_hold: Vec<String>,
    pub merge_queue: Vec<MergeQueueEntry>,
    pub spawn_usage: SpawnUsage,
    pub pending_spawns: Vec<PendingSpawnView>,
    pub held_spawns: Vec<HeldSpawnView>,
    pub steward_budget: StewardBudgetView,
}
