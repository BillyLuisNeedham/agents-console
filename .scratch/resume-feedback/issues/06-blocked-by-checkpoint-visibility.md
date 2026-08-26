<!-- state: id=06 blocked-by=none status=done -->
# 06: Blocked-by-checkpoint visibility

**What to build:** A ticket stalled behind another ticket's checkpoint stops being a silent stall. Dependency projection identifies when a ticket's blocker sits at `checkpoint` with a pending interrupt, and the dependent's card and Detail surface "blocked by checkpoint on ticket N (waiting on you)" — so the operator can see the stall is theirs to clear and which ticket to answer. Semantics are unchanged: only `done` satisfies a blocked-by edge, and the deadlock detector's reasoning is untouched (a human-resumable pause is never reported as a deadlock). Once the blocker's checkpoint is answered and it completes, the dependent schedules normally and the notice disappears.

**Blocked by:** None (can start immediately)

- [x] A ticket whose blocker is at `checkpoint` with a pending interrupt shows "blocked by checkpoint on ticket N (waiting on you)" on its card
- [x] The same notice appears in the ticket's Detail
- [x] The notice clears once the blocker completes and the dependent becomes schedulable
- [x] Checkpoint semantics are unchanged: only `done` satisfies blocked-by, and no deadlock is raised for checkpointed blockers
- [x] UI projection tests cover the notice and its clearing; an engine seam test confirms scheduling semantics are unchanged; existing suites pass

## Notes

- The wire snapshot already carried everything needed (per-ticket `blockedBy` and `status`, flat `interrupts`), so the change is pure UI projection: `checkpointBlockers` in `ui/src/project.ts` computes the ids of blockers at `checkpoint` with a pending interrupt, only while the dependent is still `ready`. No engine or server change.
- The notice text comes from one exported helper, `checkpointNotice`, so the card (`canvas.ts`) and the Detail's Spec tab (`detail.ts`) render identical wording, singular or plural. Styled in the same amber as the queued-answer waiting state. A blocked ticket is `ready`, which defaults the Detail to the Spec tab, so the notice is visible by default.
- Semantics pinned by a new engine seam test in `engine/engine.test.ts`: a dependent of a checkpointed blocker never spawns and no deadlock interrupt is raised while the checkpoint pends; after resume the blocker completes and the dependent schedules. `readyTickets` and `reconcileDeadlocks` are untouched.
- Verified: `bun test` (297 pass), `bun run typecheck`, and the UI build all clean.
