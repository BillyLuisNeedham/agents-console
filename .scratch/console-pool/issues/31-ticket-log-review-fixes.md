<!-- state: id=31 blocked-by=29 status=done -->

# 31 — Ticket-log batch review fixes

Spec: `.scratch/console-pool/spec-ticket-log-and-detail-resize.md`. Source: ticket 22's review (`.scratch/console-pool/issues/22-review-pass-ticket-log-detail.md`), which Billy's standing pattern sends to a follow-up ticket, mirroring ticket 29 for the fleet batch.

## What to build

Three fixes from ticket 22's review of the ticket-log and Detail batch (16-21):

1. **Deflake the resolver-rotation test.** `engine/engine.test.ts` worktrees > "rotates the resolver log to its attempt-numbered name on a second resolver run" fails under full-suite parallel load (it misses the second merge-approval interrupt, around line 3058) and passes in isolation. Make it deterministic under parallel load without weakening what it pins.
2. **Fix the UTF-8 head-boundary defect in log range reads.** Ticket 22 found a boundary defect in the `/api/log` range-read path (the head of a range can split a multi-byte character). Fix the boundary handling and add a regression test alongside the existing UTF-8 boundary tests in engine/server.test.ts.
3. **Pin Detail width persistence (spec story 21).** The `console-detail-width` localStorage key exists in ui/src/view.ts and the clamp helper is tested, but no test pins that the width survives a reload. Add a projection-level test that pins the persistence round trip, following the project.test.ts precedent.

Also: after ticket 29 lands, re-check engine/server.ts for em dashes in prose (ticket 22 flagged one at line 676, in the same comment ticket 29 already rewords) and confirm none remain.

## Acceptance criteria

- [x] The resolver-rotation test passes under repeated full-suite parallel runs
- [x] Log range reads never split a multi-byte UTF-8 character at the head of a range; regression test added
- [x] A test pins Detail width persistence across reloads
- [x] No em dashes in engine/server.ts prose
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 29 — Fleet batch review fixes (both touch engine/server.ts; run after it to keep the merges simple)

## Notes

- Deliberately out of scope, deferred to Billy: story 6's claim that the live tail is not truly live mid-attempt (snapshots appear to broadcast only at super-step boundaries — a streaming-cadence design question, not a small fix), and story 3's wording nit. Both are recorded in ticket 22's Notes.
- The baseline smells in ticket 22's Standards section (duplicated pidIsLive, the 64 KiB constant pair, and friends) stay deferred; this ticket is the three defects, not a refactor.

## Notes (implementation)

- Deflake root cause, proven: the gitStubHarness WAIT_MERGED poll ran `git log | grep -q` under `set -o pipefail`. `grep -q` closes the pipe the instant it matches, git log then dies on SIGPIPE (141), and pipefail reports the whole pipeline as failed even though the match was found. So the "wait for the sibling's merge" check could spuriously give up (exit 42) and crash ticket 02, which is exactly the missing second merge-approval. Reproduced under concurrent bun test processes (failed ~3-4 of 6), then after the fix passed 36 consecutive concurrent full-suite runs. The fix captures git log to a shell variable and matches with `case`, which is pipe-free and deterministic. This was a test-stub bug, not an engine defect, confirming ticket 22's inference.
- UTF-8 head fix: `readLogRange` now head-trims via `utf8HeadTrim` (skips a leading continuation byte) and reports `offset = start + headTrim`, so a tail-first open or load-earlier read that starts mid-character drops the partial char and reports the adjusted offset instead of decoding U+FFFD. The tail trim is unchanged.
- Detail width persistence: moved the parse-and-clamp of the stored `console-detail-width` string into a pure `parseStoredDetailWidth` in project.ts, used by view.ts's readStoredDetailWidth, and pinned the round trip (stored string -> parsed -> clamped) at the projection seam in project.test.ts.
- Em dash: none remain in engine/*.ts; ticket 29's colon reword holds at server.ts:739.

## Resume note

Spurious crash (known marker race, gh issue 13). Work merged to main as aec2f65; full suite green 4 consecutive runs, typecheck and build clean. Nothing to redo.
