<!-- state: id=04 blocked-by=03 status=done -->
# 04: Fix the review findings

**What to build:** Resolve every blocker finding ticket 03 recorded under its `## Findings` heading, working them in order. Each fix lands with a test that pins it at the appropriate existing seam (engine, or UI projection), following the spec's testing decisions. Nits may be fixed at the orchestrator's judgement or left, with the decision noted in this Issue. If ticket 03's verdict was clean (no blockers), this ticket is done immediately: note that in the Issue and set it done without further work.

**Blocked by:** 03: Code review of the checkpoint-at-exit work

**Status:** done

- [x] Every blocker finding from ticket 03 is resolved, or this Issue records 03's clean verdict and stops
- [x] Each fix is pinned by a test at an existing seam
- [x] Each nit is either fixed or consciously deferred, with the decision noted in this Issue
- [x] `bun test` and `bun run typecheck` pass

## Verdict

Ticket 03 closed **clean: 0 blockers, 6 nits**. Per the ticket's own terms, that is a done, not a stop. I fixed four of the six nits and consciously deferred two, each decision below.

## Nit decisions

- **Nit 1 (stale comment): fixed.** Rewrote the boundary crash-branch comment in engine/engine.ts: it no longer claims the state join is "the single writer of PoolState"; it now says only the crash interrupt waits for the boundary, since the at-exit path already raised the checkpoint's.
- **Nit 2 (misattributed marker assertions): fixed.** Dropped the on-disk marker assertions from the two fast-exit engine tests (done and checkpoint) and reworded the comments that claimed "the marker on disk agrees". The stub harness writes the line-1 marker at exit (engine.test.ts blocking-stub `sed -i ...`), so those assertions pinned harness behaviour, not the at-exit join; the snapshot assertions are the ones that pin the change and they are untouched.
- **Nit 3 (duplicated checkpoint raise-and-record): fixed.** Extracted `raiseCheckpoint(session, marker, attempt)` in engine/engine.ts; both the at-exit path and the recovery path call it. The attempt is passed in, so the at-exit caller keeps its exact-attempt improvement and the recovery caller still reads `lastAttempt`.
- **Nit 4 (log channel ordering): deferred.** The ordering change is inherent to emitting terminal results at attempt exit rather than folding them all at the boundary; restoring the old ordering would mean buffering terminal results and defeats the spec's point. Cosmetic, review called it cosmetic.
- **Nit 5 (coverage by composition for US6 and dependent-notice clearing): fixed.** Added two UI projection tests in the "checkpoint visible at attempt exit" block: one pins the queued answer's waiting state on the checkpointed card during the window, one pins the blocked-by-checkpoint notice clearing when the blocker resolves on a window-shaped snapshot. Both now pin on the window snapshot directly.
- **Nit 6 (`joinedAtExit` naming): deferred.** The field is redundant with `status !== "in-progress"` at the boundary but self-documenting; the review itself accepts it as written.

## Test output

- `bun test`: 307 pass (was 305), 0 fail, 1176 expect() calls across 10 files.
- `bun run typecheck`: clean at the root and in `ui/`.
- `bun install --cwd ui && bun run build`: builds.
