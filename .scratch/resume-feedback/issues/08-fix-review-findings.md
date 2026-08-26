<!-- state: id=08 blocked-by=07 status=done -->
# 08: Fix the review findings

**What to build:** Resolve every blocker finding ticket 07 recorded under its `## Findings` heading, working them in order. Each fix lands with a test that pins it at the appropriate existing seam (engine, server, or UI projection), following the spec's testing decisions. Nits may be fixed at the orchestrator's judgement or left, with the decision noted in this Issue. If ticket 07's verdict was clean (no blockers), this ticket is done immediately: note that in the Issue and set it done without further work.

**Blocked by:** 07: Code review of the resume-feedback work

**Status:** ready-for-agent

- [x] Every blocker finding from ticket 07 is resolved, or this Issue records 07's clean verdict and stops
- [x] Each fix is pinned by a test at an existing seam
- [x] Each nit is either fixed or consciously deferred, with the decision noted in this Issue
- [x] `bun test` and `bun run typecheck` pass

## Notes

**Finding 1 (blocker), fixed.** The named-ticket check now runs at
acceptance: `acceptAnswer` (`engine/engine.ts`) rejects a review reject whose
note names no ticket before any `answered` event or queued record is
written, so the caller gets the 400 the spec promises instead of a 202 whose
failure is swallowed at processing. The check shares `namedReviewTickets` and
`reviewRejectUnnamedError` with `rejectReview`, which keeps its throw as the
processing-time guard. The duplicate check runs before the validation, so a
retry of an already-accepted reject is still acknowledged. Pinned at two
seams: the engine test "reject without a named ticket throws and keeps the
gate up" now also asserts nothing was recorded, and a new server test POSTs
an invalid reject over real HTTP, gets the 400, sees the gate still up with
no queue file on disk, and confirms a valid reject is still accepted.

**Finding 2, deferred.** The "pool not started" 400 stays: 07's review and
Issue 01 both scoped it as honest (it can only fire before any interrupt
exists). No fix, no test.

**Finding 3, fixed.** `processAnswer` now carries a comment explaining the
ticketId-only interrupt match (a ticket holds one pending interrupt at a
time, and a record only drains while it is up).

**Finding 4, fixed in the UI.** Both `toInterruptView` and `poolStatus` now
share `isAnswerQueued` in `ui/src/project.ts`. The engine's near-twin in
`acceptAnswer` is left as is: it also matches on `approve`, so it is a
different predicate, not a copy.

**Finding 5, fixed.** `interruptDot` in `ui/src/canvas.ts` renders the
pending/queued dot for both the ticket and utility card renderers.

**Finding 6, fixed.** `Session.handle` is now `PoolRun | null`, assigned in
`startPool` right after `makeHandle`, and every read goes through the
`handleOf` guard. The `undefined as unknown as PoolRun` bootstrap is gone.

**Finding 7, no action.** The two-prefix commit already landed; recorded in
07 so the next queue keeps to one prefix. Nothing to change in the tree.

## Verification

- `bun test`: 298 pass, 0 fail, 1123 expect() calls, 10 files.
- `bun run typecheck` (`tsc --noEmit`): clean.
- `bun install && bun run build` in `ui/`: built in 60ms, no warnings.
