//! The pool's handle (engine.ts `PoolRun` and `StewardActions`) as methods on [`Engine`]: everything
//! the server asks of a running pool. Each method is one job on the actor (or a flow that sends jobs),
//! and refuses with the TypeScript's message as an [`EngineError`].

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

impl Engine {
    pub async fn accept(
        &self,
        ticket_id: String,
        note: Option<String>,
        action: ResumeAction,
        attempt: Option<u32>,
    ) -> Result<(), EngineError> {
        self.call(move |s| {
            crate::answers::submit_answer(
                s,
                &ticket_id,
                note,
                action,
                attempt.map(u64::from),
                None,
                None,
            )
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
        let (waiter, processed) = tokio::sync::oneshot::channel();
        self.call(move |s| {
            crate::answers::submit_answer(
                s,
                &ticket_id,
                note,
                action,
                attempt.map(u64::from),
                None,
                Some(waiter),
            )
        })
        .await??;
        processed
            .await
            .unwrap_or(Err(EngineError::from(crate::actor::EngineGone::Stopped)))?;
        self.settled().await
    }

    /// `settled`: the phase at the drive's next settle (at once when no drive is in flight).
    pub async fn settled(&self) -> Result<RunPhase, EngineError> {
        let settle: Settle = self.call(next_settle).await?;
        settle.phase().await
    }

    pub async fn shutdown(&self, grace: Option<Duration>) {
        crate::children::stop_all(self, grace).await;
        if let Ok(settle) = self
            .call(|s| {
                s.children.stopping = true;
                s.wake.notify_one();
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
                crate::conversations::dispose(s);
                crate::enlisted::dispose(s);
                crate::keep_talking::release_continued_attempts(s);
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
        crate::conversations::start(self, request).await
    }

    /// `endConversation` (conversations.ts).
    pub async fn end_conversation(
        &self,
        id: String,
        closing: Option<String>,
    ) -> Result<(), EngineError> {
        crate::conversations::end(self, &id, closing, ac_protocol::AnswerBy::Operator).await
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
        let attempt = crate::keep_talking::keep_talking(self, ticket_id, None).await?;
        Ok(u32::try_from(attempt).unwrap_or(u32::MAX))
    }

    /// `closeFinishedTerminals` (issue #139): how many closed.
    pub async fn close_finished_terminals(&self) -> Result<u64, EngineError> {
        crate::terminals::close_finished_terminals(self).await
    }

    pub async fn reload_config(&self) {
        let _ = self
            .call(|s| -> anyhow::Result<()> {
                if !s.driving {
                    crate::config_reload::reload_config(s)?;
                    let phase = s.idle_phase();
                    if crate::snapshot::emit_would_change(s, phase) {
                        crate::snapshot::emit_snapshot(s, phase);
                    }
                }
                s.wake();
                Ok(())
            })
            .await;
    }

    /// Start the Line (ADR-0037): the first Station Ticket's id, or the refusal's reason.
    pub async fn start_line(&self, brief: Option<String>) -> Result<String, EngineError> {
        self.call(move |s| crate::line::start_line(s, brief))
            .await?
    }

    /// Start the Line on the Grill (ADR-0037), the operator's act: the brief checked on the Grill's
    /// branch, the branch merged and Round 1's Implement written, then the Grill ended. The first
    /// Station Ticket's id, or the refusal's reason.
    pub async fn start_line_from_grill(&self, grill: String) -> Result<String, EngineError> {
        let id = grill.clone();
        let ticket = self
            .call(move |s| crate::line::start_line_from_grill(s, &id))
            .await??;
        // The Line has started by now, so an End that fails is logged, not a refusal: the Grill
        // is left for the operator to end, with nothing left on its branch to merge.
        if let Err(err) = crate::conversations::end(
            self,
            &grill,
            Some("Start the Line".to_owned()),
            ac_protocol::AnswerBy::Operator,
        )
        .await
        {
            let line = format!(
                "line: the Line started but the Grill {grill} did not end: {}",
                err.message()
            );
            let _ = self.call(move |s| s.log(line)).await;
        }
        Ok(ticket)
    }

    /// `adoptHeldSpawn` (ADR-0029).
    pub async fn adopt_held_spawn(&self, id: String) -> Result<(), EngineError> {
        self.call(move |s| crate::spawns::adopt_held_spawn(s, &id))
            .await?
    }

    /// `discardHeldSpawn` (ADR-0029).
    pub async fn discard_held_spawn(&self, id: String) -> Result<(), EngineError> {
        self.call(move |s| crate::spawns::discard_held_spawn(s, &id, None))
            .await?
    }

    /// `holdPendingSpawn` (issue #150).
    pub async fn hold_pending_spawn(&self, id: String) -> Result<(), EngineError> {
        self.call(move |s| crate::spawns::hold_pending_spawn(s, &id))
            .await?
    }

    /// `discardPendingSpawn` (issue #150).
    pub async fn discard_pending_spawn(&self, id: String) -> Result<(), EngineError> {
        self.call(move |s| crate::spawns::discard_pending_spawn(s, &id))
            .await?
    }

    /// `steward.check`: refuses unless `conversation` is the live Steward.
    pub async fn steward_check(&self, conversation: String) -> Result<(), EngineError> {
        self.call(move |s| crate::steward_actions::check_steward(s, &conversation))
            .await?
    }

    /// `steward.answer`: answer on the operator's path, as the Steward's.
    pub async fn steward_answer(
        &self,
        conversation: String,
        ticket_id: String,
        action: StewardAnswerAction,
        note: Option<String>,
    ) -> Result<(), EngineError> {
        self.call(move |s| {
            crate::steward_actions::steward_answer(s, &conversation, &ticket_id, action, note)
        })
        .await?
    }

    /// `steward.keepTalking`: the new Attempt's number.
    pub async fn steward_keep_talking(
        &self,
        conversation: String,
        ticket_id: String,
        message: String,
    ) -> Result<u32, EngineError> {
        crate::steward_actions::steward_keep_talking(self, conversation, ticket_id, message)
            .await
            .map(|attempt| u32::try_from(attempt).unwrap_or(u32::MAX))
    }

    /// `steward.leave`: leave a pending Interrupt to the operator with a Steward note.
    pub async fn steward_leave(
        &self,
        conversation: String,
        ticket_id: String,
        note: String,
    ) -> Result<(), EngineError> {
        self.call(move |s| {
            crate::steward_actions::steward_leave(s, &conversation, &ticket_id, &note)
        })
        .await?
    }

    /// `steward.adoptHeldSpawn`.
    pub async fn steward_adopt_held_spawn(
        &self,
        conversation: String,
        id: String,
    ) -> Result<(), EngineError> {
        self.call(move |s| crate::steward_actions::steward_adopt_held_spawn(s, &conversation, &id))
            .await?
    }

    /// `steward.discardHeldSpawn`.
    pub async fn steward_discard_held_spawn(
        &self,
        conversation: String,
        id: String,
    ) -> Result<(), EngineError> {
        self.call(move |s| {
            crate::steward_actions::check_steward(s, &conversation)?;
            crate::steward_actions::check_line_spawn(s, &id, "discard")?;
            crate::spawns::discard_held_spawn(s, &id, Some(&conversation))
        })
        .await?
    }

    /// `steward.reassigned`: record on each Ticket's log that the Steward wrote its assign entry.
    pub async fn steward_reassigned(
        &self,
        conversation: String,
        tickets: Vec<String>,
        fields: Map<String, Value>,
    ) -> Result<(), EngineError> {
        self.call(move |s| {
            crate::steward_actions::steward_reassigned(s, &conversation, &tickets, fields)
        })
        .await?
    }

    /// `steward.state`.
    pub async fn steward_state(
        &self,
        conversation: String,
    ) -> Result<StewardStateResponse, EngineError> {
        self.call(move |s| crate::steward_actions::steward_state(s, &conversation))
            .await?
    }

    /// `steward.end`: the Steward ends itself, as an operator End would.
    pub async fn steward_end(
        &self,
        conversation: String,
        closing: Option<String>,
    ) -> Result<(), EngineError> {
        crate::steward_actions::steward_end(self, conversation, closing).await
    }
}
