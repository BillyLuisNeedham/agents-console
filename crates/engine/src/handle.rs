//! The pool's handle (engine.ts `PoolRun` and `StewardActions`) as methods on [`Engine`]: everything
//! the server asks of a running pool. Each method is one job on the actor (or a flow that sends jobs),
//! and refuses with the TypeScript's message as an [`EngineError`].
//!
//! The skeleton's bodies refuse with "not ported yet"; each feature's port replaces its methods'
//! bodies, keeping the signatures (change one only with the server port in step).

use std::time::Duration;

use serde_json::{Map, Value};

use ac_protocol::{
    ConversationView, EnlistRequest, EnlistResponse, ResumeAction, RunPhase,
    StartConversationRequest, StewardAnswerAction, StewardStateResponse,
};

use crate::actor::Engine;
use crate::error::EngineError;
use crate::pane_reads::PaneRead;

fn not_ported<T>(what: &str) -> Result<T, EngineError> {
    Err(EngineError::refused(format!("{what}: not ported yet")))
}

impl Engine {
    /// `accept`: record an answer (ADR-0004) and kick processing; never waits for it. An idle pool
    /// drains it and starts a fresh drive inside this call, so the snapshot read right after holds
    /// the processed state.
    pub async fn accept(
        &self,
        ticket_id: String,
        note: Option<String>,
        action: ResumeAction,
        attempt: Option<u32>,
    ) -> Result<(), EngineError> {
        let _ = (ticket_id, note, action, attempt);
        not_ported("accept")
    }

    /// `resume`, `approve`, `reject`, `closeTicket` and `adopt`: accept, wait for the answer to be
    /// processed, then for the next settle; resolves with the settled phase.
    pub async fn answer(
        &self,
        ticket_id: String,
        note: Option<String>,
        action: ResumeAction,
        attempt: Option<u32>,
    ) -> Result<RunPhase, EngineError> {
        let _ = (ticket_id, note, action, attempt);
        not_ported("answer")
    }

    /// `settled`: the phase at the drive's next settle (at once when no drive is in flight).
    pub async fn settled(&self) -> Result<RunPhase, EngineError> {
        not_ported("settled")
    }

    /// `shutdown` (ADR-0017): stop the headless attempts (TERM, the grace, then KILL), let the drive
    /// join its super-step (bounded), close the store, and emit the `stopped` farewell.
    pub async fn shutdown(&self, grace: Option<Duration>) {
        let _ = grace;
    }

    /// `close`: close the checkpoint store.
    pub async fn close(&self) {}

    /// `startConversation` (conversations.ts).
    pub async fn start_conversation(
        &self,
        request: StartConversationRequest,
    ) -> Result<ConversationView, EngineError> {
        let _ = request;
        not_ported("startConversation")
    }

    /// `endConversation` (conversations.ts).
    pub async fn end_conversation(
        &self,
        id: String,
        closing: Option<String>,
    ) -> Result<(), EngineError> {
        let _ = (id, closing);
        not_ported("endConversation")
    }

    /// `enlist` (issue #101): a live herdr pane as a Ticket, a Conversation or the Steward.
    pub async fn enlist(&self, request: EnlistRequest) -> Result<EnlistResponse, EngineError> {
        let _ = request;
        not_ported("enlist")
    }

    /// `paneRead` (issue #122): the last recorded read of a pane a loop watches.
    pub async fn pane_read(&self, pane_id: String) -> Option<PaneRead> {
        self.call(move |session| session.pane_reads.latest(&pane_id))
            .await
            .ok()
            .flatten()
    }

    /// `retitle` (issue #100): relabel a Pool workspace the Console created. Never fails.
    pub async fn retitle(&self, title: Option<String>) {
        let _ = title;
    }

    /// `keepTalking` (issue #139): continue a checkpointed Attempt in its Held pane; the new Attempt's
    /// number.
    pub async fn keep_talking(&self, ticket_id: String) -> Result<u32, EngineError> {
        let _ = ticket_id;
        not_ported("keepTalking")
    }

    /// `closeFinishedTerminals` (issue #139): how many closed.
    pub async fn close_finished_terminals(&self) -> Result<u64, EngineError> {
        not_ported("closeFinishedTerminals")
    }

    /// `reloadConfig` (issue #149): an idle pool runs the boundary's Config reload now and emits.
    pub async fn reload_config(&self) {}

    /// `adoptHeldSpawn` (ADR-0029).
    pub async fn adopt_held_spawn(&self, id: String) -> Result<(), EngineError> {
        let _ = id;
        not_ported("adoptHeldSpawn")
    }

    /// `discardHeldSpawn` (ADR-0029).
    pub async fn discard_held_spawn(&self, id: String) -> Result<(), EngineError> {
        let _ = id;
        not_ported("discardHeldSpawn")
    }

    /// `holdPendingSpawn` (issue #150).
    pub async fn hold_pending_spawn(&self, id: String) -> Result<(), EngineError> {
        let _ = id;
        not_ported("holdPendingSpawn")
    }

    /// `discardPendingSpawn` (issue #150).
    pub async fn discard_pending_spawn(&self, id: String) -> Result<(), EngineError> {
        let _ = id;
        not_ported("discardPendingSpawn")
    }

    /// `steward.check`: refuses unless `conversation` is the live Steward.
    pub async fn steward_check(&self, conversation: String) -> Result<(), EngineError> {
        let _ = conversation;
        not_ported("steward.check")
    }

    /// `steward.answer`: answer on the operator's path, as the Steward's.
    pub async fn steward_answer(
        &self,
        conversation: String,
        ticket_id: String,
        action: StewardAnswerAction,
        note: Option<String>,
    ) -> Result<(), EngineError> {
        let _ = (conversation, ticket_id, action, note);
        not_ported("steward.answer")
    }

    /// `steward.keepTalking`: the new Attempt's number.
    pub async fn steward_keep_talking(
        &self,
        conversation: String,
        ticket_id: String,
        message: String,
    ) -> Result<u32, EngineError> {
        let _ = (conversation, ticket_id, message);
        not_ported("steward.keepTalking")
    }

    /// `steward.leave`: leave a pending Interrupt to the operator with a Steward note.
    pub async fn steward_leave(
        &self,
        conversation: String,
        ticket_id: String,
        note: String,
    ) -> Result<(), EngineError> {
        let _ = (conversation, ticket_id, note);
        not_ported("steward.leave")
    }

    /// `steward.adoptHeldSpawn`.
    pub async fn steward_adopt_held_spawn(
        &self,
        conversation: String,
        id: String,
    ) -> Result<(), EngineError> {
        let _ = (conversation, id);
        not_ported("steward.adoptHeldSpawn")
    }

    /// `steward.discardHeldSpawn`.
    pub async fn steward_discard_held_spawn(
        &self,
        conversation: String,
        id: String,
    ) -> Result<(), EngineError> {
        let _ = (conversation, id);
        not_ported("steward.discardHeldSpawn")
    }

    /// `steward.reassigned`: record on each Ticket's log that the Steward wrote its assign entry.
    pub async fn steward_reassigned(
        &self,
        conversation: String,
        tickets: Vec<String>,
        fields: Map<String, Value>,
    ) -> Result<(), EngineError> {
        let _ = (conversation, tickets, fields);
        not_ported("steward.reassigned")
    }

    /// `steward.state`.
    pub async fn steward_state(
        &self,
        conversation: String,
    ) -> Result<StewardStateResponse, EngineError> {
        let _ = conversation;
        not_ported("steward.state")
    }

    /// `steward.end`: the Steward ends itself, as an operator End would.
    pub async fn steward_end(
        &self,
        conversation: String,
        closing: Option<String>,
    ) -> Result<(), EngineError> {
        let _ = (conversation, closing);
        not_ported("steward.end")
    }
}
