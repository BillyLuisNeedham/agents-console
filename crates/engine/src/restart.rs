//! Restart (engine.ts 2407-2440, 2518-2891, 3232-3935): the boot notes, headless and terminal
//! orphans, terminal adoption and its finalize, and deferred merges. `rehydrate` itself is ported in
//! [`crate::boot`] for a plain headless restart.
//!
//! STUB(restart): the restart port finishes the orphan and adoption parts. Each stub is a pool whose
//! previous engine process left nothing running: no orphan, nothing to adopt, nothing deferred.

use crate::actor::Engine;
use crate::session::Session;

/// A headless attempt a previous engine process spawned and never saw exit, still alive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadlessOrphan {
    pub ticket_id: String,
    pub attempt: u64,
    pub pid: u32,
    pub cwd: String,
}

/// `headlessOrphans`: the live headless attempts of a ticket from a previous engine process.
/// STUB(restart): none (the liveness check is the children port's).
pub fn headless_orphans(session: &Session, ticket_id: &str) -> Vec<HeadlessOrphan> {
    let _ = (session, ticket_id);
    Vec::new()
}

/// `reapHeadlessOrphans`: stop the orphans rehydrate found. STUB(restart): there are none.
pub async fn reap_headless_orphans(engine: &Engine) {
    let _ = engine;
}

/// `reconcileTerminalAttempts`: terminal-backed orphans are re-adopted or crashed (ADR-0014).
/// STUB(restart): a headless pool has none.
pub async fn reconcile_terminal_attempts(engine: &Engine) {
    let _ = engine;
}

/// `redoDeferredMerges`: chain again every merge a shutdown dropped at the pool checkout's gate.
/// STUB(restart): nothing is chained again.
pub fn redo_deferred_merges(session: &mut Session) {
    let _ = session;
}

/// `abandonAdoption`: answering an adoption checkpoint abandons the re-adopted attempt.
/// STUB(restart): nothing is ever adopted.
pub fn abandon_adoption(session: &mut Session, ticket_id: &str) {
    session.adopted.remove(ticket_id);
}

/// The note a headless orphan leaves on its Issue at boot (ADR-0017). STUB(restart): unused while
/// `headless_orphans` finds none.
pub fn engine_orphan_note(orphans: &[HeadlessOrphan]) -> String {
    let who = orphans
        .iter()
        .map(|o| format!("attempt {} (pid {})", o.attempt, o.pid))
        .collect::<Vec<_>>()
        .join(" and ");
    format!(
        "\n---\n\n{}\n\nThe engine process stopped while this ticket was in-progress, and at the next \
         boot {who} was found still running in the working tree. The engine stopped it before \
         scheduling anything, so the work is part done at best and the agent left no brief. The \
         ticket is back to ready; read the working tree before it runs again.\n",
        crate::interrupts::ENGINE_BRIEF_HEADING
    )
}
