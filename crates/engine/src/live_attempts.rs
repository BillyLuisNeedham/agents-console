//! The Live attempts registry (CONTEXT.md "Live attempt"; live-attempts.ts): what the engine knows in
//! memory about every Attempt between its launch and its Attempt ending. The Attempt-run module
//! registers an Attempt the moment its `spawned` event is recorded and clears it where the ending is
//! recorded; boot adoption and the Conversation module go through the same two calls. The engine reads
//! the registry only when it emits a snapshot, so the Console and the terminal routes learn the live
//! pane from the snapshot and never work it out from the events files.
//!
//! The registry lives on the Session. `createLiveAttempts(onChange)` is [`LiveAttempts::new`] with the
//! change hook, a plain function over the session (the engine's emit), which [`register`] and [`clear`]
//! run after every change; the methods on [`LiveAttempts`] itself change the registry and nothing else,
//! for a caller that emits on its own. Nothing here is persisted: a restart knows only what it
//! re-adopts.

use indexmap::{IndexMap, IndexSet};

use ac_core::js;
use ac_protocol::{AttemptRole, LiveAttemptRecord};

use crate::session::Session;

/// One live Attempt as the engine keeps it; `tab_id` stays engine-side (the snapshot's
/// [`LiveAttemptRecord`] leaves it out).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveAttemptEntry {
    pub attempt: u64,
    /// The herdr pane the Attempt runs in; `None` when headless.
    pub pane_id: Option<String>,
    pub tab_id: Option<String>,
    pub role: AttemptRole,
    /// When the engine registered the Attempt live (ISO).
    pub started_at: String,
}

impl LiveAttemptEntry {
    /// An Attempt registered with only its pane: the Ticket's own agent, started now (the TypeScript's
    /// defaults for an absent role and start).
    pub fn new(attempt: u64, pane_id: Option<String>, tab_id: Option<String>) -> Self {
        LiveAttemptEntry {
            attempt,
            pane_id,
            tab_id,
            role: AttemptRole::Agent,
            started_at: js::now_iso(),
        }
    }
}

/// The change hook: the engine's emit, run with the session after a register or clear that changed the
/// set.
pub type LiveChangeHook = fn(&mut Session);

/// The registry.
#[derive(Debug, Default)]
pub struct LiveAttempts {
    live: IndexMap<String, IndexMap<u64, LiveAttemptEntry>>,
    on_change: Option<LiveChangeHook>,
    /// Counts every change, so a caller can tell whether a stretch of work changed the set.
    generation: u64,
}

impl LiveAttempts {
    /// `createLiveAttempts(onChange)`: an empty registry whose changes run `on_change`, so the engine
    /// can emit a snapshot the moment a pane becomes reachable or stops being so, instead of at the
    /// next boundary.
    pub fn new(on_change: Option<LiveChangeHook>) -> Self {
        LiveAttempts {
            on_change,
            ..LiveAttempts::default()
        }
    }

    /// An Attempt spawned: its number and, for a Terminal-backed attempt, its pane. Always a change.
    pub fn register(&mut self, id: &str, entry: LiveAttemptEntry) {
        self.live
            .entry(id.to_owned())
            .or_default()
            .insert(entry.attempt, entry);
        self.generation += 1;
    }

    /// The Attempt ended; true when it was registered (a change). A number never registered is a no-op.
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
        self.generation += 1;
        true
    }

    /// Whether any Attempt of this id is live.
    pub fn is_live(&self, id: &str) -> bool {
        self.live.contains_key(id)
    }

    /// The ids with a live Attempt, in the order they went live.
    pub fn ids(&self) -> Vec<String> {
        self.live.keys().cloned().collect()
    }

    /// Every live Attempt's pane, not only each id's highest (issue #139): a verify fan-out's earlier
    /// candidates are live too, and a tab over any of them is in use, never a Finished terminal.
    pub fn panes(&self) -> IndexSet<String> {
        self.live
            .values()
            .flat_map(|attempts| attempts.values())
            .filter_map(|entry| entry.pane_id.clone())
            .collect()
    }

    /// One record per id, the highest-numbered live Attempt: a verify fan-out has several live Attempts
    /// on one Ticket id, and when the highest ends first the record falls back to an earlier one still
    /// live. Ids `exclude` names (a Conversation's, whose pane rides its own view) are left out.
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

    /// The live entry of one Attempt.
    pub fn entry(&self, id: &str, attempt: u64) -> Option<&LiveAttemptEntry> {
        self.live.get(id)?.get(&attempt)
    }

    /// How many changes the registry has seen; [`notify_since`] compares two of these.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The change hook to run when the registry changed since `generation` was read: `None` when it
    /// did not change, or has no hook.
    pub fn changed_since(&self, generation: u64) -> Option<LiveChangeHook> {
        if self.generation == generation {
            return None;
        }
        self.on_change
    }
}

/// `liveAttempts.register` on the session's registry, then its change hook.
pub fn register(s: &mut Session, id: &str, entry: LiveAttemptEntry) {
    let generation = s.live_attempts.generation();
    s.live_attempts.register(id, entry);
    notify_since(s, generation);
}

/// `liveAttempts.clear` on the session's registry, then its change hook when the clear changed the set.
pub fn clear(s: &mut Session, id: &str, attempt: u64) {
    let generation = s.live_attempts.generation();
    s.live_attempts.clear(id, attempt);
    notify_since(s, generation);
}

/// Run the registry's change hook when the registry changed since `generation` was read.
pub fn notify_since(s: &mut Session, generation: u64) {
    if let Some(on_change) = s.live_attempts.changed_since(generation) {
        on_change(s);
    }
}

#[cfg(test)]
mod tests {
    //! engine/live-attempts.test.ts, the hidden rows live-attempts.test.ts:39 and :70 included.

    use super::*;

    const AT: &str = "2026-09-23T10:00:00.000Z";

    fn entry(attempt: u64, pane: Option<&str>, tab: Option<&str>) -> LiveAttemptEntry {
        LiveAttemptEntry {
            attempt,
            pane_id: pane.map(str::to_owned),
            tab_id: tab.map(str::to_owned),
            role: AttemptRole::Agent,
            started_at: AT.into(),
        }
    }

    fn record(attempt: u64, pane: Option<&str>, role: AttemptRole) -> LiveAttemptRecord {
        LiveAttemptRecord {
            attempt,
            pane_id: pane.map(str::to_owned),
            role,
            started_at: AT.into(),
        }
    }

    fn none(_: &str) -> bool {
        false
    }

    #[test]
    fn registers_with_its_pane_and_clears_at_the_ending() {
        let mut live = LiveAttempts::default();
        live.register("01", entry(1, Some("pane-1"), Some("tab-1")));
        assert!(live.is_live("01"));
        assert_eq!(
            live.records(none),
            IndexMap::from([(
                "01".to_owned(),
                record(1, Some("pane-1"), AttemptRole::Agent)
            )])
        );
        assert!(live.clear("01", 1));
        assert!(!live.is_live("01"));
        assert!(live.records(none).is_empty());
    }

    #[test]
    fn carries_a_headless_attempt_with_no_pane() {
        let mut live = LiveAttempts::default();
        live.register("01", entry(3, None, None));
        assert_eq!(
            live.records(none)["01"],
            record(3, None, AttemptRole::Agent)
        );
    }

    #[test]
    fn serves_the_highest_live_attempt_of_a_fan_out_and_falls_back() {
        let mut live = LiveAttempts::default();
        for n in 4..=6 {
            let pane = format!("pane-{n}");
            live.register("01", entry(n, Some(&pane), Some("tab")));
        }
        assert_eq!(live.records(none)["01"].attempt, 6);
        live.clear("01", 6);
        assert_eq!(
            live.records(none)["01"],
            record(5, Some("pane-5"), AttemptRole::Agent)
        );
        live.clear("01", 4);
        assert_eq!(live.records(none)["01"].attempt, 5);
        live.clear("01", 5);
        assert!(live.records(none).is_empty());
    }

    #[test]
    fn leaves_out_the_ids_the_caller_excludes_which_still_count_as_live() {
        let mut live = LiveAttempts::default();
        live.register("01", entry(1, Some("pane-1"), Some("tab-1")));
        live.register("conv-1", entry(1, Some("pane-c"), Some("tab-c")));
        assert_eq!(
            live.records(|id| id.starts_with("conv-")),
            IndexMap::from([(
                "01".to_owned(),
                record(1, Some("pane-1"), AttemptRole::Agent)
            )])
        );
        assert!(live.is_live("conv-1"));
    }

    #[test]
    fn carries_a_resolvers_role() {
        let mut live = LiveAttempts::default();
        live.register(
            "02",
            LiveAttemptEntry {
                role: AttemptRole::Resolver,
                ..entry(3, Some("pane-r"), Some("tab-r"))
            },
        );
        assert_eq!(
            live.records(none)["02"],
            record(3, Some("pane-r"), AttemptRole::Resolver)
        );
    }

    #[test]
    fn stamps_an_attempt_registered_without_a_start_with_now() {
        let before = js::now_iso();
        let fresh = LiveAttemptEntry::new(1, None, None);
        let after = js::now_iso();
        assert!(fresh.started_at >= before && fresh.started_at <= after);
        assert_eq!(fresh.role, AttemptRole::Agent);
    }

    fn emit(_: &mut Session) {}

    #[test]
    fn notifies_on_every_change_and_not_on_a_clear_that_changes_nothing() {
        let mut live = LiveAttempts::new(Some(emit));
        let start = live.generation();
        live.register("01", entry(1, None, None));
        assert!(live.changed_since(start).is_some());
        let registered = live.generation();
        assert!(!live.clear("01", 2));
        assert!(!live.clear("02", 1));
        assert!(live.changed_since(registered).is_none());
        assert!(live.clear("01", 1));
        assert!(live.changed_since(registered).is_some());
        // A registry without a hook notifies nothing.
        let mut quiet = LiveAttempts::default();
        let start = quiet.generation();
        quiet.register("01", entry(1, None, None));
        assert!(quiet.changed_since(start).is_none());
    }

    #[test]
    fn lists_every_live_pane_a_fan_outs_earlier_candidates_included() {
        let mut live = LiveAttempts::default();
        live.register("01", entry(4, Some("pane-4"), Some("tab-4")));
        live.register("01", entry(5, Some("pane-5"), Some("tab-5")));
        live.register("02", entry(1, None, None));
        let mut panes: Vec<String> = live.panes().into_iter().collect();
        panes.sort();
        assert_eq!(panes, ["pane-4", "pane-5"]);
        live.clear("01", 4);
        assert_eq!(live.panes().into_iter().collect::<Vec<_>>(), ["pane-5"]);
    }
}
