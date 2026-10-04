//! Persistence (engine.ts 5316-5397): the markers dual-write, the checkpoint write, its retry and the
//! persistence Interrupt, and closing the store.

use std::time::Duration;

use ac_protocol::{Interrupt, InterruptKind};

use crate::actor::Engine;
use crate::session::{PERSISTENCE_TICKET_ID, Session};

/// The persist retry's backoff (issue #26): three retries, so four attempts in all.
pub const PERSIST_RETRY_BACKOFF_MS: [u64; 3] = [50, 100, 200];

/// `writeMarkers`: every checkpoint write is preceded by bringing the line-1 markers on disk into
/// agreement with state, so the pool directory is always inspectable and the markers stay the shared
/// truth.
pub fn write_markers(session: &mut Session) -> anyhow::Result<()> {
    let Session { markers, state, .. } = session;
    ac_core::pool::write_markers(markers, |id| state.tickets.get(id).copied())
}

/// `persist`: the markers, then the checkpoint.
pub fn persist(session: &mut Session) -> anyhow::Result<()> {
    write_markers(session)?;
    let state = serde_json::to_value(&session.state)?;
    session.store.write(&state)
}

/// `persistWithRetry`: a failed write retries with backoff; on success the drive carries on, and on
/// exhaustion the persistence Interrupt is raised and the pool waits for a human with the store still
/// open. Never closes the store; false when the retries were exhausted.
pub async fn persist_with_retry(engine: &Engine) -> anyhow::Result<bool> {
    let mut backoff = PERSIST_RETRY_BACKOFF_MS.iter();
    loop {
        let error = match engine.call(persist).await? {
            Ok(()) => return Ok(true),
            Err(error) => error.to_string(),
        };
        let Some(ms) = backoff.next() else {
            engine
                .call(move |s| crate::interrupts::raise_interrupt(s, persistence_interrupt(&error)))
                .await?;
            return Ok(false);
        };
        tokio::time::sleep(Duration::from_millis(*ms)).await;
    }
}

/// The run-level persistence Interrupt: answering it retries persistence and continues the run.
pub fn persistence_interrupt(error: &str) -> Interrupt {
    Interrupt {
        ticket_id: PERSISTENCE_TICKET_ID.to_owned(),
        kind: InterruptKind::Persistence,
        body: format!(
            "persistence is failing: the checkpoint store failed to write after {} attempts with \
             backoff.\nlast error: {error}\nthe store remains open. answer this interrupt once the \
             store is healthy to retry persistence and continue the run.",
            PERSIST_RETRY_BACKOFF_MS.len() + 1
        ),
        candidates: None,
        steward_note: None,
    }
}

/// `closeStore`: a closed or dead drive stops the hold watch too, then the store closes, once.
pub fn close_store(session: &mut Session) {
    session.hold_watch.stop();
    session.hold_watch_timer += 1;
    if !session.store_open {
        return;
    }
    session.store_open = false;
    session.store.close();
}
