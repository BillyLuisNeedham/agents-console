<!-- state: id=06 blocked-by=none status=ready -->
# 06: Blocked-by-checkpoint visibility

**What to build:** A ticket stalled behind another ticket's checkpoint stops being a silent stall. Dependency projection identifies when a ticket's blocker sits at `checkpoint` with a pending interrupt, and the dependent's card and Detail surface "blocked by checkpoint on ticket N (waiting on you)" — so the operator can see the stall is theirs to clear and which ticket to answer. Semantics are unchanged: only `done` satisfies a blocked-by edge, and the deadlock detector's reasoning is untouched (a human-resumable pause is never reported as a deadlock). Once the blocker's checkpoint is answered and it completes, the dependent schedules normally and the notice disappears.

**Blocked by:** None (can start immediately)

- [ ] A ticket whose blocker is at `checkpoint` with a pending interrupt shows "blocked by checkpoint on ticket N (waiting on you)" on its card
- [ ] The same notice appears in the ticket's Detail
- [ ] The notice clears once the blocker completes and the dependent becomes schedulable
- [ ] Checkpoint semantics are unchanged: only `done` satisfies blocked-by, and no deadlock is raised for checkpointed blockers
- [ ] UI projection tests cover the notice and its clearing; an engine seam test confirms scheduling semantics are unchanged; existing suites pass
