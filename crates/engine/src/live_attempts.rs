//! The Live attempts registry (live-attempts.ts): every Attempt between its launch and its ending,
//! kept by the Attempt-run module, boot adoption and the Conversation module, and read when a snapshot
//! is emitted. Never persisted.
//!
//! STUB(live_attempts): the attempt launch port owns this module; this is the registry's behaviour
//! as the TypeScript has it, without the change callback (callers emit after a change).

use indexmap::IndexMap;

use ac_protocol::{AttemptRole, LiveAttemptRecord};

/// One live Attempt; `tab_id` stays engine-side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveAttemptEntry {
    pub attempt: u64,
    pub pane_id: Option<String>,
    pub tab_id: Option<String>,
    pub role: AttemptRole,
    pub started_at: String,
}

/// The registry.
#[derive(Debug, Default)]
pub struct LiveAttempts {
    live: IndexMap<String, IndexMap<u64, LiveAttemptEntry>>,
}

impl LiveAttempts {
    /// An Attempt spawned.
    pub fn register(&mut self, id: &str, entry: LiveAttemptEntry) {
        self.live
            .entry(id.to_owned())
            .or_default()
            .insert(entry.attempt, entry);
    }

    /// The Attempt ended; true when it was registered (a change worth an emit).
    pub fn clear(&mut self, id: &str, attempt: u64) -> bool {
        let Some(attempts) = self.live.get_mut(id) else {
            return false;
        };
        if attempts.shift_remove(&attempt).is_none() {
            return false;
        }
        if attempts.is_empty() {
            self.live.shift_remove(id);
        }
        true
    }

    /// Whether any Attempt of this id is live.
    pub fn is_live(&self, id: &str) -> bool {
        self.live.contains_key(id)
    }

    /// The ids with a live Attempt.
    pub fn ids(&self) -> Vec<String> {
        self.live.keys().cloned().collect()
    }

    /// One record per id, the highest-numbered live Attempt; ids `exclude` names are left out.
    pub fn records(&self, exclude: impl Fn(&str) -> bool) -> IndexMap<String, LiveAttemptRecord> {
        let mut out = IndexMap::new();
        for (id, attempts) in &self.live {
            if exclude(id) {
                continue;
            }
            if let Some(top) = attempts.values().max_by_key(|entry| entry.attempt) {
                out.insert(
                    id.clone(),
                    LiveAttemptRecord {
                        attempt: top.attempt,
                        pane_id: top.pane_id.clone(),
                        role: top.role,
                        started_at: top.started_at.clone(),
                    },
                );
            }
        }
        out
    }
}
