//! The notice board every Jev port shares (the real one and the fake): a cause is announced when it
//! differs from the last one, and a recovery once after any fallback. It compares against remembered
//! state, not a seen-set, so a cause that returns after a different one is heard again.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use super::{JevCause, JevNotice};

/// A subscriber: called with each notice, on whichever task made the ask that produced it. A listener
/// must not call back into the board it listens to.
pub type NoticeListener = Box<dyn Fn(&JevNotice) + Send + Sync>;

type SharedListener = Arc<dyn Fn(&JevNotice) + Send + Sync>;

/// The dedupe and fan-out of a port's notices: `createNoticeBoard()`.
#[derive(Clone, Default)]
pub struct NoticeBoard {
    inner: Arc<BoardInner>,
}

#[derive(Default)]
struct BoardInner {
    listeners: Mutex<Vec<(u64, SharedListener)>>,
    next_id: AtomicU64,
    /// The cause last announced, `None` once asks succeed again. Held while a notice goes out, so two
    /// asks failing at once announce in the order their causes were recorded.
    last_cause: Mutex<Option<JevCause>>,
}

/// The handle `subscribe` returns: `unsubscribe` stops the listener's notices. Dropping it leaves the
/// listener subscribed, as discarding the TypeScript's returned function did.
pub struct Unsubscribe {
    board: Weak<BoardInner>,
    id: u64,
}

impl Unsubscribe {
    /// Stop this listener's notices.
    pub fn unsubscribe(self) {
        if let Some(board) = self.board.upgrade() {
            lock(&board.listeners).retain(|(id, _)| *id != self.id);
        }
    }
}

impl NoticeBoard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hear each fallback cause once (and a recovery), not once per call.
    pub fn subscribe(&self, listener: NoticeListener) -> Unsubscribe {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        lock(&self.inner.listeners).push((id, Arc::from(listener)));
        Unsubscribe {
            board: Arc::downgrade(&self.inner),
            id,
        }
    }

    /// An ask fell back: announce the cause unless it is the one last announced.
    pub fn fell_back(&self, cause: JevCause, detail: &str) {
        let mut last = lock(&self.inner.last_cause);
        if *last == Some(cause) {
            return;
        }
        *last = Some(cause);
        self.announce(&JevNotice::Unavailable {
            cause,
            detail: detail.to_owned(),
        });
    }

    /// An ask was answered: announce one recovery if the last ask fell back.
    pub fn succeeded(&self) {
        let mut last = lock(&self.inner.last_cause);
        if last.is_none() {
            return;
        }
        *last = None;
        self.announce(&JevNotice::Recovered);
    }

    fn announce(&self, notice: &JevNotice) {
        let listeners: Vec<_> = lock(&self.inner.listeners)
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect();
        for listener in listeners {
            listener(notice);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
