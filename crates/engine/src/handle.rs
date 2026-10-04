//! The pool's handle (engine.ts `PoolRun` and `StewardActions`) as methods on [`Engine`]: everything
//! the server asks of a running pool. Each method is one job on the actor (or a flow that sends jobs),
//! and refuses with the TypeScript's message as an [`EngineError`].
//!
//! Ported: accept, answer, settled, shutdown, close, reload_config, pane_read. The rest refuse with
//! "not ported yet" until their feature's port replaces the body, keeping the signature.

use std::time::Duration;

use serde_json::{Map, Value};

use ac_protocol::{
    ConversationView, ResumeAction, RunPhase, StartConversationRequest, StewardAnswerAction,
    StewardStateResponse,
};

use crate::actor::Engine;
use crate::drive::{SHUTDOWN_SETTLE_WAIT_MS, Settle, next_settle};
use crate::error::EngineError;
use crate::pane_reads::PaneRead;

fn not_ported<T>(what: &str) -> Result<T, EngineError> {
    Err(EngineError::refused(format!("{what}: not ported yet")))
}

// What an answer waits on once accepted: the next settle at once (a retry of an answer already
// processed), or its processing first.
enum Accepted {
    Processed,
    Waiting(tokio::sync::oneshot::Receiver<Result<(), EngineError>>),
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
        self.call(move |s| {
            crate::answers::accept_answer(
                s,
                &ticket_id,
                note,
                action,
                attempt.map(u64::from),
                None,
            )?;
            crate::answers::kick_processing(s).map_err(|e| EngineError::refused(e.to_string()))
        })
        .await?
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
        let accepted = self
            .call(move |s| -> Result<Accepted, EngineError> {
                let record = crate::answers::accept_answer(
                    s,
                    &ticket_id,
                    note,
                    action,
                    attempt.map(u64::from),
                    None,
                )?;
                // A retry of an answer that was already processed: nothing new to wait for.
                if record.processed_at.is_some() {
                    return Ok(Accepted::Processed);
                }
                // The waiter registers before the kick: an idle kick drains at once.
                let (tx, rx) = tokio::sync::oneshot::channel();
                s.answer_waiters.entry(record.seq).or_default().push(tx);
                crate::answers::kick_processing(s)
                    .map_err(|e| EngineError::refused(e.to_string()))?;
                Ok(Accepted::Waiting(rx))
            })
            .await??;
        if let Accepted::Waiting(processed) = accepted {
            processed
                .await
                .unwrap_or(Err(EngineError::from(crate::actor::EngineGone::Stopped)))?;
        }
        self.settled().await
    }

    /// `settled`: the phase at the drive's next settle (at once when no drive is in flight).
    pub async fn settled(&self) -> Result<RunPhase, EngineError> {
        let settle: Settle = self.call(next_settle).await?;
        settle.phase().await
    }

    /// `shutdown` (ADR-0017): stop the headless attempts (TERM, the grace, then KILL), let the drive
    /// join its super-step (bounded), close the store, and emit the `stopped` farewell.
    pub async fn shutdown(&self, grace: Option<Duration>) {
        crate::children::stop_all(self, grace).await;
        if let Ok(settle) = self
            .call(|s| {
                s.children.stopping = true;
                s.driving.then(|| next_settle(s))
            })
            .await
            && let Some(settle) = settle
        {
            let _ = tokio::time::timeout(
                Duration::from_millis(SHUTDOWN_SETTLE_WAIT_MS),
                settle.phase(),
            )
            .await;
        }
        let _ = self
            .call(|s| {
                s.conversations.dispose();
                crate::enlisted::dispose(s);
                crate::pane_survey::stop_pane_survey(s);
                crate::persist::close_store(s);
                // The farewell: one `stopped` snapshot carrying the final state (issue #97).
                crate::snapshot::emit_snapshot(s, RunPhase::Stopped);
            })
            .await;
    }

    /// `close`: close the checkpoint store.
    pub async fn close(&self) {
        let _ = self.call(crate::persist::close_store).await;
    }

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

    /// `paneRead` (issue #122): the last recorded read of a pane a loop watches.
    pub async fn pane_read(&self, pane_id: String) -> Option<PaneRead> {
        self.call(move |session| session.pane_reads.latest(&pane_id))
            .await
            .ok()
            .flatten()
    }

    /// `keepTalking` (issue #139): continue a checkpointed Attempt in its Held pane; the new Attempt's
    /// number.
    pub async fn keep_talking(&self, ticket_id: String) -> Result<u32, EngineError> {
        let _ = ticket_id;
        not_ported("keepTalking")
    }

    /// `closeFinishedTerminals` (issue #139): how many closed.
    pub async fn close_finished_terminals(&self) -> Result<u64, EngineError> {
        crate::terminals::close_finished_terminals(self).await
    }

    /// `reloadConfig` (issue #149): an idle pool runs the boundary's Config reload now and emits.
    pub async fn reload_config(&self) {
        let _ = self
            .call(crate::config_reload::reload_config_when_idle)
            .await;
    }

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
