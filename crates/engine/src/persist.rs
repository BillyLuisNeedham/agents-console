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
    if !session.store_failing && session.persisted.as_ref() == Some(&state) {
        return Ok(());
    }
    let written = session.store.write(&state);
    session.store_failing = written.is_err();
    written?;
    session.persisted = Some(state);
    Ok(())
}

pub async fn persist_with_retry(engine: &Engine) -> anyhow::Result<bool> {
    match engine.call(persist).await? {
        Ok(()) => Ok(true),
        Err(refused) => retry_persist(engine, refused).await,
    }
}

pub async fn retry_persist(engine: &Engine, refused: anyhow::Error) -> anyhow::Result<bool> {
    let mut error = refused.to_string();
    for ms in PERSIST_RETRY_BACKOFF_MS {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        match engine.call(persist).await? {
            Ok(()) => return Ok(true),
            Err(refused) => error = refused.to_string(),
        }
    }
    engine
        .call(move |s| crate::interrupts::raise_interrupt(s, persistence_interrupt(&error)))
        .await?;
    Ok(false)
}

pub async fn persist_after_flow(engine: &Engine) {
    let _ = engine
        .call(|s| {
            if s.store_open && !s.store_failing {
                let _ = persist(s);
            }
        })
        .await;
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
        started_since: None,
    }
}

/// `closeStore`: a closed or dead drive stops the hold watch too, then the store closes, once.
pub fn close_store(session: &mut Session) {
    session.hold_watch.stop();
    session.hold_watch_timer += 1;
    if let Some(unsubscribe) = session.jev_unsubscribe.take() {
        unsubscribe.unsubscribe();
    }
    if !session.store_open {
        return;
    }
    session.store_open = false;
    session.store.close();
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use ac_protocol::{InterruptKind, ResumeAction, RunPhase, TicketStatus};

    use crate::testkit::{Pool, answer, last, settled};

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_write_that_fails_once_is_retried_and_the_run_goes_on() {
        let pool = Pool::git(&[("01", &[]), ("02", &["01"])]);
        pool.store.fail.store(1, Ordering::SeqCst);
        let engine = pool.start().await;
        assert_eq!(settled(&engine).await, RunPhase::Quiescent);
        let snap = last(&engine);
        assert_eq!(snap.state.tickets["01"], TicketStatus::Done);
        assert_eq!(snap.state.tickets["02"], TicketStatus::Done);
        assert!(
            !snap
                .state
                .interrupts
                .iter()
                .any(|i| i.kind == InterruptKind::Persistence)
        );
        assert_eq!(
            pool.store.fail.load(Ordering::SeqCst),
            0,
            "the failure was spent"
        );
        let phase = answer(&engine, "REVIEW".into(), None, ResumeAction::Approve, None)
            .await
            .unwrap();
        assert_eq!(phase, RunPhase::Done);
        let rows = pool.store.writes.lock().unwrap().clone();
        assert!(
            rows.iter()
                .any(|row| row["tickets"] == serde_json::json!({"01": "done", "02": "done"}))
        );
        assert_eq!(rows.last().unwrap()["reviewApproved"], true);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_store_that_always_fails_makes_four_attempts_per_write_and_stays_open() {
        let pool = Pool::git(&[("01", &[])]);
        let budget = 1_000;
        pool.store.fail.store(budget, Ordering::SeqCst);
        let engine = pool.start().await;
        assert_eq!(settled(&engine).await, RunPhase::Quiescent);
        let attempts = budget - pool.store.fail.load(Ordering::SeqCst);
        assert_eq!(attempts, 8);
        assert!(pool.store.writes.lock().unwrap().is_empty());
        assert!(
            last(&engine)
                .state
                .interrupts
                .iter()
                .any(|i| i.kind == InterruptKind::Persistence)
        );
        assert_eq!(pool.store.closed.load(Ordering::SeqCst), 0);
    }
}
