//! Held panes and the pane survey's listing (issue #139; engine.ts 4196-4480, held-panes.ts,
//! pane-survey.ts, finished-terminals.ts): the pane of every ticket's checkpointed Terminal-backed
//! attempt, and the cached herdr listing behind the Held panes and the Finished terminals.
//!
//! STUB(held): the herdr panes port owns this module. A headless pool has no pane survey and no pane
//! to hold, and that is the behaviour here: nothing is held, nothing is listed.

use indexmap::IndexMap;

use ac_core::pool::TicketMarker;
use ac_protocol::HeldPaneRecord;

use crate::session::Session;

/// A held pane: the pane, where it works, under which Assignment and naming.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldPane {
    pub pane_id: String,
    pub attempt: u64,
}

/// The pane survey: the cached herdr listing. STUB(held): never built.
#[derive(Debug)]
pub struct PaneSurvey {}

/// `holdCheckpointPane`: a checkpoint holds its attempt's pane. STUB(held): a headless attempt has no
/// pane, so the hold is dropped.
pub fn hold_checkpoint_pane(session: &mut Session, marker: &TicketMarker, attempt: u64) {
    let _ = attempt;
    session.held.remove(&marker.id);
}

/// `seedHeldPanes`: the Held panes a restart finds. STUB(held): none.
pub fn seed_held_panes(session: &mut Session) {
    let _ = session;
}

/// `heldPaneRecords`: the snapshot's Held panes; none before the survey's first listing.
pub fn held_pane_records(session: &Session) -> IndexMap<String, HeldPaneRecord> {
    let _ = session;
    IndexMap::new()
}

/// The Finished terminals count from the survey's last listing: 0 in a headless pool.
pub fn finished_terminals_now(session: &Session) -> u64 {
    let _ = session;
    0
}
