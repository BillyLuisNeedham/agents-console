<!-- state: id=03 blocked-by=01 status=done -->
# 03: Queued-answer waiting state in snapshots and the Console

**What to build:** An accepted-but-unprocessed answer (a Queued answer, per CONTEXT.md) is visible everywhere the operator looks, with no polling. The server's snapshot projection merges the queued-answer store into every emitted snapshot, so `/api/state` and every SSE frame carry the waiting state with no change to super-step merge semantics. The ticket card shows its interrupt as answered-and-waiting; the Detail shows the same state at full size; both clear the moment the answer is processed and the interrupt leaves state. The operator can always tell "my click landed and is waiting" from "still needs my answer".

**Blocked by:** 01: Accept/process split — answers acknowledged with 202, processed at the super-step boundary

**Status:** ready-for-agent

- [x] Snapshots (both `/api/state` and SSE frames) include queued answers, merged at emit time from the queued-answer store
- [x] The ticket card renders a distinct answered-and-waiting state on its interrupt while the answer is queued
- [x] The Detail renders the same waiting state, mirroring the card
- [x] The waiting state clears on the snapshot where the answer has been processed, without any refresh or re-poll
- [x] UI projection tests cover the waiting state and its clearing; server seam tests cover the snapshot shape; existing suites pass

## Notes

Design (settled before writing code):

- Engine emits carry the queue: `PoolSnapshot` gains `queuedAnswers` (the
  store's `pending()` at emit time), hoisting `emit` out of `driveLoop` to a
  session-scoped helper. PoolState itself is untouched (ADR-0004).
- `acceptAnswer` emits a snapshot when a new record is enqueued while a drive
  is in flight, so the waiting state broadcasts immediately instead of at the
  next boundary. Idle acceptance skips the emit: processing is synchronous in
  the same tick and the drive's own first emit follows right after. Every
  `markProcessed` is already followed by an emit (boundary drain and idle
  kick both lead into `driveLoop`), so the emitted queue never goes stale.
- Server `enrich` copies `queuedAnswers` into `state`; `/api/state`, SSE
  replay and live frames all read `latest`, so one merge point covers all.
- `/api/resume` 202 now returns the post-accept `latest`: mid-flight it
  carries the waiting state (the acceptance broadcast already updated
  `latest`), idle it carries the processed state. This deliberately redefines
  the Issue 01 assertion that the 202 shows the interrupt pending (returning
  the pre-accept snapshot would race the acceptance SSE frame and could
  clobber the waiting state in the UI).
- UI: `state.queuedAnswers` on the wire; `InterruptView` gains `queued`.
  Card and Detail render an amber answered-and-waiting state (red stays
  "needs your answer"); `poolStatus` counts an interrupt as needing input
  only while it has no queued answer.

Outcome:

- All criteria met; full suite green (286 pass), `bun run typecheck` clean,
  UI builds. Review of the diff found no blockers and no should-fix items.
- Pre-existing flake fixed en route (proven on HEAD: ~1 in 10 runs): the
  pool-name server test never settled its drives, so a drive still writing
  attempt logs when afterEach removed the temp dir failed an unrelated test
  with an unhandled ENOENT. The test now awaits `server.settled()`; 10/10
  clean runs after.
- Known nit, left as-is (pre-existing pattern, out of scope): `setSnapshot`
  in `ui/src/main.ts` applies snapshots unconditionally, with no seq guard.
  The 202 now returns the post-accept snapshot, so the acceptance SSE frame
  and the 202 agree; a guard would make the ordering structural rather than
  timing-based.
- Verified correct by review, recorded so nobody re-checks: a queued review
  approval would project onto the review card and Detail, but the review
  gate is only reachable on a quiescent pool where processing is immediate,
  so the waiting state never actually renders there.
