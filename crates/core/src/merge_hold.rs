//! The Merge hold (ADR-0014, engine/merge-hold.ts): the one derivation of the done-but-unmerged ticket
//! set, its memo, the watch's bookkeeping, and the Merge queue's line. Only the pure parts live here;
//! the git probe, the watch's timer and the wait-and-recompute loop are the engine's.
//!
//! The derivation takes the ticket statuses and a git probe and returns the held ids. An engine-run
//! ticket (a grader, the head-to-head judge) is skipped by the id rule, never by the branch reading,
//! because it reaches done in the main checkout with no branch; a missing branch reads as landed (the
//! engine deletes a branch once its merge lands, and a human finishing the job by hand is trusted). A
//! git-less pool passes no probe and holds nothing.
//!
//! The Merge queue (CONTEXT.md, issue #129) is the hold set put in the order the engine works through
//! it, each ticket named by where its merge stands, derived at every emit from the line the engine
//! keeps in memory, the live resolvers and the open Interrupts.

use std::collections::HashSet;

use ac_protocol::{Interrupt, InterruptKind, MergeQueueEntry, MergeQueueState, TicketStatus};

/// How often a held pool re-derives the hold looking for a merge done by hand, in milliseconds.
pub const MERGE_HOLD_WATCH_MS: u64 = 2_000;

/// The poll cadence of a waiting flow (ADR-0014), in milliseconds: the hold is re-derived on every
/// tick, so a manual CLI merge is observed without any Console action.
pub const MERGE_HOLD_POLL_MS: u64 = 250;

/// The git facts the derivation reads.
pub trait MergeHoldProbe {
    /// The merge target: the pool checkout's current branch, main or a feature branch alike.
    fn current_branch(&self) -> String;
    fn branch_for(&self, ticket_id: &str) -> String;
    fn branch_exists(&self, branch: &str) -> bool;
    fn is_ancestor(&self, branch: &str, target: &str) -> bool;
    /// A stamp of everything the three git answers above read for these branches and the merge
    /// target: equal stamps promise equal answers. `None` when the probe cannot vouch for that right
    /// now (or never can); only the memo reads it.
    fn stamp(&self, branches: &[String]) -> Option<String> {
        let _ = branches;
        None
    }
}

// The done tickets that are not engine-run, in the order the statuses enumerate them.
fn hold_candidates<'a>(
    tickets: impl IntoIterator<Item = (&'a String, &'a TicketStatus)>,
    engine_run: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    tickets
        .into_iter()
        .filter(|(id, status)| **status == TicketStatus::Done && !engine_run(id))
        .map(|(id, _)| id.clone())
        .collect()
}

/// The held ids: every done ticket that is not engine-run and whose branch exists but has not landed
/// in the merge target. `tickets` iterates in JavaScript's key order (the caller's job). The target is
/// read once per derivation, and only when there is a candidate to check, so a pool with nothing done
/// spawns no git at all.
pub fn derive_merge_hold<'a>(
    tickets: impl IntoIterator<Item = (&'a String, &'a TicketStatus)>,
    engine_run: &dyn Fn(&str) -> bool,
    probe: Option<&dyn MergeHoldProbe>,
) -> Vec<String> {
    let Some(probe) = probe else {
        return Vec::new();
    };
    let candidates = hold_candidates(tickets, engine_run);
    derive_from_candidates(&candidates, probe)
}

fn derive_from_candidates(candidates: &[String], probe: &dyn MergeHoldProbe) -> Vec<String> {
    if candidates.is_empty() {
        return Vec::new();
    }
    let target = probe.current_branch();
    candidates
        .iter()
        .filter(|id| {
            let branch = probe.branch_for(id);
            probe.branch_exists(&branch) && !probe.is_ancestor(&branch, &target)
        })
        .cloned()
        .collect()
}

/// The derivation behind a memo (issue #157). The hold is derived at every emit and on every tick of
/// a wait and of the watch; the memo keeps the last answer under a key of the done candidates, their
/// branch names and the probe's stamp of the refs those names read, and answers from it while the
/// key is unchanged, with no git at all. The stamp is taken before the derivation, so a ref that moves
/// while git runs leaves the answer under a stamp the next call no longer matches. A probe that cannot
/// vouch is derived every time.
#[derive(Debug, Default)]
pub struct MergeHoldMemo {
    last: Option<(MemoKey, Vec<String>)>,
}

#[derive(Debug, PartialEq, Eq)]
struct MemoKey {
    candidates: Vec<String>,
    branches: Vec<String>,
    stamp: String,
}

impl MergeHoldMemo {
    pub fn new() -> Self {
        MergeHoldMemo::default()
    }

    /// The hold, from the memo when the key has not moved.
    pub fn derive<'a>(
        &mut self,
        tickets: impl IntoIterator<Item = (&'a String, &'a TicketStatus)>,
        engine_run: &dyn Fn(&str) -> bool,
        probe: Option<&dyn MergeHoldProbe>,
    ) -> Vec<String> {
        let Some(probe) = probe else {
            return Vec::new();
        };
        let candidates = hold_candidates(tickets, engine_run);
        if candidates.is_empty() {
            return Vec::new();
        }
        let branches: Vec<String> = candidates.iter().map(|id| probe.branch_for(id)).collect();
        let Some(stamp) = probe.stamp(&branches) else {
            return derive_from_candidates(&candidates, probe);
        };
        let key = MemoKey {
            candidates,
            branches,
            stamp,
        };
        if let Some((last_key, hold)) = &self.last
            && *last_key == key
        {
            return hold.clone();
        }
        let hold = derive_from_candidates(&key.candidates, probe);
        self.last = Some((key, hold.clone()));
        hold
    }
}

/// Two hold sets compared by value, as the watch compares them.
pub fn same_set(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let seen: HashSet<&String> = a.iter().collect();
    b.iter().all(|id| seen.contains(id))
}

/// What the watch's timer should do after an emit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchTimer {
    /// Start ticking: the emitted set is non-empty and no timer runs.
    Start,
    /// Stop the timer: the emitted set is empty.
    Stop,
    /// Leave it as it is.
    Keep,
}

/// The hold watch's bookkeeping (merge-hold.ts `createMergeHoldWatch`): the set last emitted, whether
/// a timer ticks, and whether a dead or closed drive stopped it for good. While the last emitted set
/// is non-empty the engine re-derives on a slow cadence and emits when the set differs; when it is
/// empty nothing runs.
#[derive(Debug, Default)]
pub struct MergeHoldWatch {
    last: Vec<String>,
    ticking: bool,
    stopped: bool,
}

impl MergeHoldWatch {
    pub fn new() -> Self {
        MergeHoldWatch::default()
    }

    /// The engine emitted a snapshot carrying this hold set.
    pub fn emitted(&mut self, hold: &[String]) -> WatchTimer {
        self.last = hold.to_vec();
        if self.stopped {
            return WatchTimer::Keep;
        }
        if hold.is_empty() {
            if self.ticking {
                self.ticking = false;
                return WatchTimer::Stop;
            }
            WatchTimer::Keep
        } else if !self.ticking {
            self.ticking = true;
            WatchTimer::Start
        } else {
            WatchTimer::Keep
        }
    }

    /// A dead or closed drive stops the watch for good.
    pub fn stop(&mut self) {
        self.stopped = true;
        self.ticking = false;
    }

    /// Whether a timer should be ticking now.
    pub fn ticking(&self) -> bool {
        self.ticking && !self.stopped
    }

    /// One tick's verdict on a fresh derivation: true when it differs from the last emitted set, and
    /// the engine should emit.
    pub fn changed(&self, derived: &[String]) -> bool {
        !same_set(derived, &self.last)
    }
}

/// The engine's record of the merges it has taken on, in memory only (merge-hold.ts `MergeLine`). The
/// order is the order `taken` was called in: the moment a done ticket's merge joins the serialised
/// merge chain, which is attempt-exit order, and the order the conflict loop then resolves them in. A
/// ticket held after a restart was never taken, so it has no place in the line and sorts after it by
/// id.
#[derive(Debug, Default)]
pub struct MergeLine {
    order: Vec<String>,
    pending: HashSet<String>,
    active: Option<String>,
}

impl MergeLine {
    pub fn new() -> Self {
        MergeLine::default()
    }

    /// The ticket's merge joined the merge chain: it goes to the back of the line.
    pub fn taken(&mut self, id: &str) {
        self.order.retain(|o| o != id);
        self.order.push(id.to_owned());
        self.pending.insert(id.to_owned());
    }

    /// The ids whose merge joined the chain and has not settled yet, in line order.
    pub fn unsettled(&self) -> Vec<String> {
        self.order
            .iter()
            .filter(|id| self.pending.contains(*id))
            .cloned()
            .collect()
    }

    /// The engine is handling the ticket's conflict: launching or running its resolver.
    pub fn resolving(&mut self, id: &str) {
        self.active = Some(id.to_owned());
    }

    /// The engine is finished with the ticket's merge: it landed, or an interrupt now owns it.
    pub fn settled(&mut self, id: &str) {
        self.pending.remove(id);
        if self.active.as_deref() == Some(id) {
            self.active = None;
        }
    }

    /// The Merge queue: the held ids in line order, each with its state. `resolvers` are the ids with
    /// a live resolver Attempt; `interrupts` the pool's open ones.
    pub fn queue(
        &self,
        hold: &[String],
        resolvers: &HashSet<String>,
        interrupts: &[Interrupt],
    ) -> Vec<MergeQueueEntry> {
        let held: HashSet<&String> = hold.iter().collect();
        let lined = self.order.iter().filter(|id| held.contains(id));
        let mut rest: Vec<&String> = hold.iter().filter(|id| !self.order.contains(id)).collect();
        // `Array.prototype.sort` with no comparator: UTF-16 code unit order.
        rest.sort_by(|a, b| crate::js::compare_utf16(a, b));
        lined
            .chain(rest)
            .map(|id| MergeQueueEntry {
                ticket_id: id.clone(),
                state: self.state_of(id, resolvers, interrupts),
            })
            .collect()
    }

    fn state_of(
        &self,
        id: &str,
        resolvers: &HashSet<String>,
        interrupts: &[Interrupt],
    ) -> MergeQueueState {
        if self.active.as_deref() == Some(id) || resolvers.contains(id) {
            return MergeQueueState::Resolving;
        }
        let kinds: HashSet<InterruptKind> = interrupts
            .iter()
            .filter(|i| i.ticket_id == id)
            .map(|i| i.kind)
            .collect();
        if kinds.contains(&InterruptKind::MergeApproval) {
            return MergeQueueState::AwaitingApproval;
        }
        if kinds.contains(&InterruptKind::MergeConflict) {
            return MergeQueueState::NeedsYou;
        }
        if self.pending.contains(id) {
            MergeQueueState::Queued
        } else {
            MergeQueueState::Stalled
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    // A probe over fixed facts that counts its git calls, as merge-hold.test.ts's fake does.
    #[derive(Default)]
    struct FakeProbe {
        target: String,
        exists: HashSet<String>,
        landed: HashSet<String>,
        stamp: RefCell<Option<String>>,
        git_calls: Cell<u32>,
    }

    impl FakeProbe {
        fn new(exists: &[&str], landed: &[&str]) -> Self {
            FakeProbe {
                target: "main".into(),
                exists: exists.iter().map(|b| b.to_string()).collect(),
                landed: landed.iter().map(|b| b.to_string()).collect(),
                ..FakeProbe::default()
            }
        }
    }

    impl MergeHoldProbe for FakeProbe {
        fn current_branch(&self) -> String {
            self.git_calls.set(self.git_calls.get() + 1);
            self.target.clone()
        }
        fn branch_for(&self, ticket_id: &str) -> String {
            format!("pool/k/{ticket_id}")
        }
        fn branch_exists(&self, branch: &str) -> bool {
            self.git_calls.set(self.git_calls.get() + 1);
            self.exists.contains(branch)
        }
        fn is_ancestor(&self, branch: &str, _target: &str) -> bool {
            self.git_calls.set(self.git_calls.get() + 1);
            self.landed.contains(branch)
        }
        fn stamp(&self, _branches: &[String]) -> Option<String> {
            self.stamp.borrow().clone()
        }
    }

    fn statuses(entries: &[(&str, TicketStatus)]) -> Vec<(String, TicketStatus)> {
        entries.iter().map(|(id, s)| (id.to_string(), *s)).collect()
    }

    fn pairs(tickets: &[(String, TicketStatus)]) -> impl Iterator<Item = (&String, &TicketStatus)> {
        tickets.iter().map(|(id, status)| (id, status))
    }

    fn not_engine(_: &str) -> bool {
        false
    }

    #[test]
    fn holds_done_tickets_whose_branch_exists_and_has_not_landed() {
        let tickets = statuses(&[
            ("01", TicketStatus::Done),
            ("02", TicketStatus::Done),
            ("03", TicketStatus::Done),
            ("04", TicketStatus::Ready),
            ("01-grader-1", TicketStatus::Done),
        ]);
        let probe = FakeProbe::new(
            &["pool/k/01", "pool/k/02", "pool/k/04", "pool/k/01-grader-1"],
            &["pool/k/02"],
        );
        let engine_run = |id: &str| id.contains("-grader-");
        assert_eq!(
            derive_merge_hold(pairs(&tickets), &engine_run, Some(&probe)),
            vec!["01".to_string()]
        );
        assert_eq!(
            derive_merge_hold(pairs(&tickets), &engine_run, None),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_pool_with_nothing_done_spawns_no_git() {
        let tickets = statuses(&[("01", TicketStatus::Ready)]);
        let probe = FakeProbe::new(&["pool/k/01"], &[]);
        assert!(derive_merge_hold(pairs(&tickets), &not_engine, Some(&probe)).is_empty());
        assert_eq!(probe.git_calls.get(), 0);
    }

    // merge-hold.test.ts:119
    #[test]
    fn memo_answers_an_unchanged_stamp_from_the_last_derivation_spawning_no_git() {
        let tickets = statuses(&[("01", TicketStatus::Done)]);
        let probe = FakeProbe::new(&["pool/k/01"], &[]);
        *probe.stamp.borrow_mut() = Some("s1".into());
        let mut memo = MergeHoldMemo::new();
        assert_eq!(
            memo.derive(pairs(&tickets), &not_engine, Some(&probe)),
            ["01"]
        );
        let calls = probe.git_calls.get();
        assert!(calls > 0);
        assert_eq!(
            memo.derive(pairs(&tickets), &not_engine, Some(&probe)),
            ["01"]
        );
        assert_eq!(probe.git_calls.get(), calls);
    }

    // merge-hold.test.ts:129
    #[test]
    fn memo_derives_again_when_the_stamp_moves_so_a_merge_that_landed_is_seen() {
        let tickets = statuses(&[("01", TicketStatus::Done)]);
        let mut probe = FakeProbe::new(&["pool/k/01"], &[]);
        *probe.stamp.borrow_mut() = Some("s1".into());
        let mut memo = MergeHoldMemo::new();
        assert_eq!(
            memo.derive(pairs(&tickets), &not_engine, Some(&probe)),
            ["01"]
        );
        probe.landed.insert("pool/k/01".into());
        *probe.stamp.borrow_mut() = Some("s2".into());
        assert!(
            memo.derive(pairs(&tickets), &not_engine, Some(&probe))
                .is_empty()
        );
    }

    // merge-hold.test.ts:141
    #[test]
    fn memo_derives_again_when_another_ticket_reaches_done_whatever_the_stamp_says() {
        let probe = FakeProbe::new(&["pool/k/01", "pool/k/02"], &[]);
        *probe.stamp.borrow_mut() = Some("s1".into());
        let mut memo = MergeHoldMemo::new();
        let before = statuses(&[("01", TicketStatus::Done), ("02", TicketStatus::Ready)]);
        assert_eq!(
            memo.derive(pairs(&before), &not_engine, Some(&probe)),
            ["01"]
        );
        let after = statuses(&[("01", TicketStatus::Done), ("02", TicketStatus::Done)]);
        assert_eq!(
            memo.derive(pairs(&after), &not_engine, Some(&probe)),
            ["01", "02"]
        );
    }

    // merge-hold.test.ts:149
    #[test]
    fn memo_derives_every_time_a_probe_cannot_vouch_for_its_refs() {
        let tickets = statuses(&[("01", TicketStatus::Done)]);
        let probe = FakeProbe::new(&["pool/k/01"], &[]);
        let mut memo = MergeHoldMemo::new();
        memo.derive(pairs(&tickets), &not_engine, Some(&probe));
        let first = probe.git_calls.get();
        memo.derive(pairs(&tickets), &not_engine, Some(&probe));
        assert_eq!(probe.git_calls.get(), first * 2);
    }

    // merge-hold.test.ts:309
    #[test]
    fn watch_runs_nothing_while_the_emitted_set_is_empty() {
        let mut watch = MergeHoldWatch::new();
        assert_eq!(watch.emitted(&[]), WatchTimer::Keep);
        assert!(!watch.ticking());
        assert_eq!(watch.emitted(&["01".into()]), WatchTimer::Start);
        assert!(watch.ticking());
        assert_eq!(watch.emitted(&["01".into()]), WatchTimer::Keep);
        assert!(!watch.changed(&["01".into()]));
        assert!(watch.changed(&[]));
        assert_eq!(watch.emitted(&[]), WatchTimer::Stop);
        assert!(!watch.ticking());
    }

    // merge-hold.test.ts:361
    #[test]
    fn watch_stops_for_good_once_stopped_whatever_is_emitted_afterwards() {
        let mut watch = MergeHoldWatch::new();
        assert_eq!(watch.emitted(&["01".into()]), WatchTimer::Start);
        watch.stop();
        assert!(!watch.ticking());
        assert_eq!(watch.emitted(&["02".into()]), WatchTimer::Keep);
        assert!(!watch.ticking());
    }

    #[test]
    fn same_set_compares_by_value() {
        assert!(same_set(
            &["a".into(), "b".into()],
            &["b".into(), "a".into()]
        ));
        assert!(!same_set(&["a".into()], &["a".into(), "b".into()]));
    }

    fn interrupt(id: &str, kind: InterruptKind) -> Interrupt {
        Interrupt {
            ticket_id: id.into(),
            kind,
            body: String::new(),
            candidates: None,
            steward_note: None,
        }
    }

    #[test]
    fn the_merge_queue_orders_the_line_first_then_the_rest_by_id_with_each_state() {
        let mut line = MergeLine::new();
        line.taken("03");
        line.taken("01");
        line.taken("02");
        line.taken("03");
        line.resolving("01");
        line.settled("02");
        let hold: Vec<String> = ["10", "02", "03", "01", "05"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let resolvers: HashSet<String> = HashSet::new();
        let queue = line.queue(
            &hold,
            &resolvers,
            &[
                interrupt("02", InterruptKind::MergeConflict),
                interrupt("05", InterruptKind::MergeApproval),
            ],
        );
        let got: HashMap<&str, MergeQueueState> = queue
            .iter()
            .map(|e| (e.ticket_id.as_str(), e.state))
            .collect();
        let order: Vec<&str> = queue.iter().map(|e| e.ticket_id.as_str()).collect();
        assert_eq!(order, ["01", "02", "03", "05", "10"]);
        assert_eq!(got["01"], MergeQueueState::Resolving);
        assert_eq!(got["02"], MergeQueueState::NeedsYou);
        assert_eq!(got["03"], MergeQueueState::Queued);
        assert_eq!(got["05"], MergeQueueState::AwaitingApproval);
        assert_eq!(got["10"], MergeQueueState::Stalled);
        line.settled("01");
        let resolvers: HashSet<String> = ["03".to_string()].into_iter().collect();
        let queue = line.queue(&hold, &resolvers, &[]);
        assert_eq!(queue[0].state, MergeQueueState::Stalled);
        assert_eq!(queue[2].state, MergeQueueState::Resolving);
    }
}
