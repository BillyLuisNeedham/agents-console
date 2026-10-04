//! Spawns (ADR-0010, ADR-0029, issue #150; engine.ts 10699-11616): Spawn counters, taking proposals,
//! adoption at the boundary, the Spawn ledger refresh, and Held and Pending spawns.
//!
//! Ported: `refresh_spawn_ledger` and `spawns_await_boundary`, which every emit and every drive close
//! read. STUB(spawns): taking proposals, adoption, the boot recovery and settle, and the operator's
//! Adopt, Discard and Hold belong to the spawns port; each stub is the narrowest behaviour that
//! compiles.

use ac_core::spawn_ledger::{
    LedgerEntry, SpawnLedgerInput, render_spawn_ledger, write_spawn_ledger,
};
use ac_protocol::{ConversationView, SpawnKind, SpawnProposal};

use crate::session::Session;

/// `refreshSpawnLedger`: the Spawn ledger follows every emit, so what agents read there is never
/// staler than what the Console shows (issue #150). An unchanged ledger writes nothing; a write that
/// fails is left for the next change to try again.
pub fn refresh_spawn_ledger(session: &mut Session, conversations: &[ConversationView]) {
    let tickets: Vec<LedgerEntry> = session
        .markers
        .iter()
        .map(|marker| LedgerEntry {
            id: marker.id.clone(),
            title: marker.title.clone(),
            status: session
                .status_of(&marker.id)
                .unwrap_or(marker.status)
                .to_string(),
        })
        .collect();
    let conversations: Vec<LedgerEntry> = conversations
        .iter()
        .map(|c| LedgerEntry {
            id: c.id.clone(),
            title: c.title.clone(),
            status: c.status.to_string(),
        })
        .collect();
    let text = render_spawn_ledger(SpawnLedgerInput {
        tickets: &tickets,
        conversations: &conversations,
        pending: session.spawn_proposals.pending(),
        held: session.spawn_proposals.held(),
    });
    if session.spawn_ledger.as_deref() == Some(text.as_str()) {
        return;
    }
    if write_spawn_ledger(std::path::Path::new(&session.runs_dir), &text).is_ok() {
        session.spawn_ledger = Some(text);
    }
}

/// `spawnsAwaitBoundary`: Pending spawns, and Held spawns an Adopt has queued, wait for a boundary to
/// land them. A drive that closes with any leaves the next drive to land them.
pub fn spawns_await_boundary(session: &Session) -> bool {
    !session.spawn_proposals.pending().is_empty() || !session.spawn_proposals.adopting().is_empty()
}

/// `takeSpawnProposals`: an exited attempt's (or a spawn.json's) proposals, taken into the Pending
/// and Held spawns.
///
/// STUB(spawns): the proposals are dropped.
pub fn take_spawn_proposals(
    session: &mut Session,
    parent_id: &str,
    proposals: Vec<SpawnProposal>,
    origin: SpawnKind,
) {
    let _ = (session, parent_id, proposals, origin);
}

/// `adoptSpawnProposals`: the boundary lands every Pending spawn and every queued Adopt.
///
/// STUB(spawns): nothing lands.
pub fn adopt_spawn_proposals(session: &mut Session) -> anyhow::Result<()> {
    let _ = session;
    Ok(())
}

/// `recoverTruncatedSpawns`: boot holds proposals a pre-ADR-0029 cap truncated.
///
/// STUB(spawns): nothing is recovered.
pub fn recover_truncated_spawns(session: &mut Session) -> anyhow::Result<()> {
    let _ = session;
    Ok(())
}

/// `settleLandingSpawns`: boot settles spawns a dead engine was landing.
///
/// STUB(spawns): nothing is settled.
pub fn settle_landing_spawns(session: &mut Session) -> anyhow::Result<()> {
    let _ = session;
    Ok(())
}
