//! The actor that owns the pool state (ADR-0036): one tokio task holds the [`Session`] and runs the
//! jobs sent to it one at a time, each to completion, so nothing needs a lock.
//!
//! The TypeScript engine is functions over one session object on one event loop: code between two
//! `await`s runs uninterrupted, and many async flows interleave at their awaits. Here each stretch of
//! synchronous TypeScript is one job, a closure over `&mut Session`, sent with [`Engine::call`] (which
//! waits for its result) or [`Engine::cast`] (which does not). A flow is an async task holding an
//! [`Engine`]; it never holds the session across an await.
//!
//! A job that panics is caught, so a bug in one job cannot take the whole pool down silently: the
//! panic is reported to [`Engine::call`]'s caller as [`EngineGone::Panicked`] with its message, and the
//! actor carries on with the next job.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use tokio::sync::{mpsc, oneshot, watch};

use crate::session::Session;
use crate::snapshot::PoolSnapshot;

type Job = Box<dyn FnOnce(&mut Session) + Send>;

/// Why a job sent to the actor came back without its result.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EngineGone {
    /// The actor has stopped: the pool was closed and its session dropped.
    #[error("the pool engine has stopped")]
    Stopped,
    /// The job panicked; the message is the panic's.
    #[error("the pool engine failed: {0}")]
    Panicked(String),
}

/// The handle to one pool's engine. Cheap to clone; every clone reaches the same actor.
#[derive(Clone)]
pub struct Engine {
    jobs: mpsc::UnboundedSender<Job>,
    snapshots: watch::Receiver<Option<Arc<PoolSnapshot>>>,
}

/// The sending half of the snapshot channel, which the session keeps and publishes every emit on.
pub type SnapshotPublisher = watch::Sender<Option<Arc<PoolSnapshot>>>;

impl Engine {
    /// Starts the actor on `session` and returns its handle. The session gets a clone of the handle
    /// (`Session::engine`) through `attach`, which runs on the actor before any other job, so the
    /// session's own functions can start flows.
    pub fn spawn(
        session: Session,
        snapshots: watch::Receiver<Option<Arc<PoolSnapshot>>>,
        attach: impl FnOnce(&mut Session, Engine) + Send + 'static,
    ) -> Engine {
        let (jobs, mut inbox) = mpsc::unbounded_channel::<Job>();
        let engine = Engine { jobs, snapshots };
        let own = engine.clone();
        let mut session = session;
        tokio::spawn(async move {
            attach(&mut session, own);
            while let Some(job) = inbox.recv().await {
                // A panic is reported through the job's own reply channel (see `call`); here it only
                // must not end the loop.
                let _ = catch_unwind(AssertUnwindSafe(|| job(&mut session)));
            }
        });
        engine
    }

    /// Runs `job` on the actor and waits for its result.
    pub async fn call<R, F>(&self, job: F) -> Result<R, EngineGone>
    where
        R: Send + 'static,
        F: FnOnce(&mut Session) -> R + Send + 'static,
    {
        let (reply, answer) = oneshot::channel::<Result<R, EngineGone>>();
        let wrapped: Job = Box::new(move |session| {
            let result = catch_unwind(AssertUnwindSafe(|| job(session)))
                .map_err(|panic| EngineGone::Panicked(panic_message(&panic)));
            let _ = reply.send(result);
        });
        self.jobs.send(wrapped).map_err(|_| EngineGone::Stopped)?;
        answer.await.unwrap_or(Err(EngineGone::Stopped))
    }

    /// Sends `job` to the actor without waiting for it: TypeScript's un-awaited call.
    pub fn cast<F>(&self, job: F)
    where
        F: FnOnce(&mut Session) + Send + 'static,
    {
        let _ = self.jobs.send(Box::new(job));
    }

    /// The last snapshot the engine emitted, or `None` before the first.
    pub fn snapshot(&self) -> Option<Arc<PoolSnapshot>> {
        self.snapshots.borrow().clone()
    }

    /// A receiver that wakes on every emit.
    pub fn subscribe(&self) -> watch::Receiver<Option<Arc<PoolSnapshot>>> {
        self.snapshots.clone()
    }

    /// Whether the actor is still running.
    pub fn is_running(&self) -> bool {
        !self.jobs.is_closed()
    }
}

fn panic_message(panic: &Box<dyn Any + Send>) -> String {
    if let Some(text) = panic.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = panic.downcast_ref::<String>() {
        text.clone()
    } else {
        "a job panicked".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> (Session, watch::Receiver<Option<Arc<PoolSnapshot>>>) {
        let (publisher, snapshots) = watch::channel(None);
        (crate::testkit::bare_session(publisher), snapshots)
    }

    #[tokio::test]
    async fn jobs_run_in_order_and_see_each_others_writes() {
        let (session, snapshots) = session();
        let engine = Engine::spawn(session, snapshots, |session, engine| {
            session.engine = Some(engine)
        });
        engine.cast(|s| s.pane_reads.record("p", "one".into(), "t1".into()));
        let read = engine.call(|s| s.pane_reads.latest("p")).await.unwrap();
        assert_eq!(read.unwrap().text, "one");
        assert!(engine.call(|s| s.engine.is_some()).await.unwrap());
    }

    #[tokio::test]
    async fn a_panicking_job_is_reported_and_the_actor_carries_on() {
        let (session, snapshots) = session();
        let engine = Engine::spawn(session, snapshots, |_, _| {});
        let failed = engine.call(|_| -> u32 { panic!("boom") }).await;
        assert_eq!(failed, Err(EngineGone::Panicked("boom".into())));
        assert_eq!(engine.call(|_| 7).await, Ok(7));
    }
}
