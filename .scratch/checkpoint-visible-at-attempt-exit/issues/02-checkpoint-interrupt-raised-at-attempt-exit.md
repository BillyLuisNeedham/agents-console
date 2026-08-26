<!-- state: id=02 blocked-by=01 status=done -->
# 02: Checkpoint interrupt raised at attempt exit

**What to build:** A checkpoint's interrupt enters pool state when the attempt exits, not at the super-step boundary. The moment a ticket checkpoints, its card pulses red with the interrupt dot, its Detail offers the interrupt form, and the tab title and favicon turn red "needs input" — even while a sibling is still running. An answer given during that window is accepted immediately, shows the queued waiting state on the card, and is processed at the next super-step boundary per ADR-0004. Raising the interrupt is not processing an answer, so the ADR's accept/process split is untouched. Dependents of the checkpointed ticket keep showing their blocked-by-checkpoint notice during the window, as they do today.

**Blocked by:** 01: Terminal results join pool state at attempt exit

**Status:** ready-for-agent

- [x] A two-ticket super-step with a fast checkpoint and a slow sibling emits a snapshot before the sibling exits carrying the checkpoint interrupt pending
- [x] The projected card for the checkpointed ticket shows the full needs-human look (red checkpoint word, pulsing border, interrupt dot, interrupt form in Detail) during the window
- [x] `poolStatus` reports "needs input" during the window (tab title and favicon turn red)
- [x] An answer submitted during the window is accepted, appears as a queued answer on the card, and is processed at the next super-step boundary
- [x] A dependent ticket's blocked-by-checkpoint notice projects during the window and clears when the blocker resolves, as today
- [x] Engine seam tests and UI projection tests cover all of the above; `bun test` and `bun run typecheck` pass, and the UI still builds

## Notes

- The checkpoint interrupt and its checkpoint event now land at attempt exit, in the same per-ticket `.then` callback of `driveLoop` (engine/engine.ts) where Issue 01's terminal join already is. The boundary loop's checkpoint branch is gone; only the crash interrupt still waits for the boundary. raiseInterrupt's dedupe and the skip-if-present join keep the at-exit raise from double-applying.
- The snapshot emitted at exit therefore carries the pending interrupt, so the card, Detail, tab, and favicon go red during the window (all already-rendering UI, no production UI change). An answer accepted then is queued in the queued-answer store per ADR-0004 and processed at the next boundary; raising an interrupt is not processing an answer, so the split is untouched.
- Tests: Issue 01's checkpoint test was renamed to "raises a checkpoint's interrupt at attempt exit, before a slow sibling exits" and now asserts the interrupt is pending in the early snapshot; a new test "accepts an answer during the window, queues it, and processes it at the boundary" pins the queued-then-processed path through the new timing; three UI projection tests project the window snapshot shape (needs-human card + Detail form + poolStatus "needs input" + blocked-by-checkpoint on a dependent).
- Fixed a pre-existing UI typecheck error on the way: two test helpers in ui/src/project.test.ts built a `TicketDetailView` literal without the required `blockedByCheckpoint` field. Test-only fix; the error predates this ticket (present at commit c99f478).
- Verified: `bun test` 305 pass (was 301 before 02), root and ui `bun run typecheck` clean, `bun install --cwd ui && bun run build` builds.
