//! The Conversation module (the Conversations ADR, conversations.ts): every live Conversation, reached
//! through the operations it exposes.
//!
//! STUB(conversations): the Conversations port owns this module. Each operation the engine core calls
//! is here with the narrowest behaviour of a pool with no live Conversation, which is what a pool that
//! never started one is: nothing is live, no view is listed, and every hook is a no-op.

use ac_core::pool::TicketMarker;
use ac_protocol::{ConversationView, Interrupt};

use crate::actor::Engine;

/// The Conversation runtimes of one pool.
#[derive(Debug, Default)]
pub struct Conversations {}

impl Conversations {
    /// Whether a Conversation with this id is live.
    pub fn is_live(&self, id: &str) -> bool {
        let _ = id;
        false
    }

    /// Every Conversation the pool knows about, live or not, as the snapshot carries them.
    pub fn views(&self) -> Vec<ConversationView> {
        Vec::new()
    }

    /// A ticket a Conversation spawned has merged: its Notice goes to the parent.
    pub fn ticket_ended(&mut self, marker: &TicketMarker, branch: &str, range: Option<String>) {
        let _ = (marker, branch, range);
    }

    /// A ticket a Conversation spawned paused at a checkpoint: its Notice goes to the parent.
    pub fn ticket_checkpointed(&mut self, marker: &TicketMarker, brief: &str) {
        let _ = (marker, brief);
    }

    /// A ticket a Conversation spawned was closed (issue #154).
    pub fn ticket_closed(&mut self, marker: &TicketMarker, note: Option<&str>) {
        let _ = (marker, note);
    }

    /// A Conversation's own merge-conflict or merge-approval answer.
    pub fn answer_merge(
        &mut self,
        id: &str,
        interrupt: &Interrupt,
        approve: Option<bool>,
    ) -> anyhow::Result<()> {
        let _ = (interrupt, approve);
        Err(anyhow::anyhow!(
            "resume: no pending interrupt for ticket {id}"
        ))
    }

    /// Conversations recorded live at boot have an unknown pane fate: they crash now.
    pub fn crash_stale_at_boot(&mut self) {}

    /// Stop every loop this process runs; the panes stay.
    pub fn dispose(&mut self) {}

    /// The Steward hears about the Ticket's next Interrupt afresh.
    pub fn steward_forget(&mut self, ticket_id: &str) {
        let _ = ticket_id;
    }

    /// The live Steward's Conversation id.
    pub fn steward_id(&self) -> Option<String> {
        None
    }

    /// Every pane and tab a Conversation recorded live names, runtime or not: no close, and no
    /// enlist, may take one while its record is live. STUB(conversations).
    pub fn live_terminals(
        &self,
    ) -> (
        std::collections::HashSet<String>,
        std::collections::HashSet<String>,
    ) {
        (Default::default(), Default::default())
    }

    /// The ids a Conversation about to be recorded may not take. STUB(conversations).
    pub fn reserved_ids(&self) -> Vec<String> {
        Vec::new()
    }

    /// Every live Conversation's id and working directory.
    pub fn live_directories(&self) -> Vec<(String, String)> {
        Vec::new()
    }
}

/// An enlisted Conversation's pane, re-adopted at boot or crashed when it has gone (issue #101).
pub async fn adopt_enlisted_at_boot(engine: &Engine) {
    let _ = engine;
}

/// A started Conversation's pane, re-adopted at boot while its TUI runs (issue #140).
pub async fn adopt_started_at_boot(engine: &Engine) {
    let _ = engine;
}

/// `readoptPending`: a Conversation a boot could not settle is tried again now (issue #140).
/// STUB(conversations): nothing is pending.
pub async fn readopt_pending(engine: &Engine) -> Result<(), String> {
    let _ = engine;
    Ok(())
}

/// A live pane the operator enlists as a Conversation (issue #101): the found facts the engine
/// records. STUB(conversations).
#[derive(Debug, Clone)]
pub struct EnlistConversationRegistration {
    pub id: String,
    pub pane_id: String,
    pub tab_id: Option<String>,
    pub harness: String,
    pub title: String,
    pub opening: Option<String>,
    pub directory: String,
    pub branch: String,
    pub session_id: Option<String>,
    pub steward: bool,
}

/// `conversations.enlist`: claim the found pane and register its runtime. STUB(conversations): the
/// claim is refused.
pub async fn enlist(
    engine: &Engine,
    registration: EnlistConversationRegistration,
) -> Result<(), String> {
    let _ = (engine, registration);
    Err("not ported yet".to_owned())
}
