//! The pane read register (issue #122, pane-reads.ts): the last viewport read of every pane the
//! enlisted and Conversation loops watch, so the server's peek route serves a recorded read rather
//! than reading a pane the operator sits in a second time.

use std::collections::HashMap;

/// One recorded viewport read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRead {
    /// The viewport's text as herdr rendered it, ANSI stripped.
    pub text: String,
    /// When the loop read it (ISO).
    pub at: String,
}

/// The register: the latest read per pane.
#[derive(Debug, Default)]
pub struct PaneReadRegister {
    reads: HashMap<String, PaneRead>,
}

impl PaneReadRegister {
    /// Remember the loop's latest read of `pane_id`, replacing the previous one.
    pub fn record(&mut self, pane_id: &str, text: String, at: String) {
        self.reads
            .insert(pane_id.to_string(), PaneRead { text, at });
    }

    /// Drop the pane's entry: no loop watches it any more. A pane never recorded is a no-op.
    pub fn forget(&mut self, pane_id: &str) {
        self.reads.remove(pane_id);
    }

    /// The latest recorded read, or `None` when no loop watches the pane.
    pub fn latest(&self, pane_id: &str) -> Option<PaneRead> {
        self.reads.get(pane_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_replaces_and_forgets() {
        let mut register = PaneReadRegister::default();
        assert_eq!(register.latest("p1"), None);
        register.record("p1", "one".into(), "2026-01-01T00:00:00.000Z".into());
        register.record("p1", "two".into(), "2026-01-01T00:00:01.000Z".into());
        assert_eq!(register.latest("p1").unwrap().text, "two");
        register.forget("p1");
        assert_eq!(register.latest("p1"), None);
        // Forgetting a pane never recorded is a no-op and leaves the others (pane-reads.test.ts:20).
        register.record("p2", "kept".into(), "2026-01-01T00:00:02.000Z".into());
        register.forget("never");
        assert_eq!(register.latest("never"), None);
        assert_eq!(register.latest("p2").unwrap().text, "kept");
    }
}
