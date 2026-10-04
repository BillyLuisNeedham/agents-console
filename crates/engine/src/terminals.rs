//! Closing tabs and the Finished terminals (issue #139; engine.ts 5189-5316).
//!
//! STUB(terminals): the herdr panes port owns this module. Every close here needs the pane survey's
//! listing, which a headless pool never has, so each one closes nothing, as the TypeScript does with
//! no survey.

use ac_core::pool::TicketMarker;

use crate::actor::Engine;

/// A tab the engine recorded opening, as its `spawned` event named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedTab {
    pub owner: String,
    pub tab_id: String,
}

/// Every pane and tab an enlisted owner's events name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnlistedTerminals {
    pub panes: Vec<String>,
    pub tabs: Vec<String>,
}

/// `closeCheckpointedTabs`: a ticket resumed from a checkpoint launches fresh, its old pane closed
/// first. STUB(terminals): no survey, nothing closes.
pub async fn close_checkpointed_tabs(engine: &Engine, markers: &[TicketMarker]) {
    let _ = (engine, markers);
}

/// `closeTicketTabs`: a closed ticket's tabs close by the idle rule. STUB(terminals): no survey,
/// nothing closes.
pub async fn close_ticket_tabs(engine: &Engine, ticket_id: &str) {
    let _ = (engine, ticket_id);
}
