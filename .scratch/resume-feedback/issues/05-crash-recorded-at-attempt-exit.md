<!-- state: id=05 blocked-by=none status=done -->
# 05: Crash recorded at attempt exit

**What to build:** A crashed attempt stops masquerading as running work. The moment an attempt exits unsuccessfully, the crash event is appended to the ticket log and the marker is updated by the attempt-running path (per-ticket event appends are concurrency-safe), and a snapshot is emitted so the Console shows the crash within seconds — instead of the UI displaying a long-finished ticket as running until the slowest sibling's super-step ends. The crash interrupt is still raised at the super-step boundary, preserving state-join safety; only the recording and its visibility move to exit time.

**Blocked by:** None (can start immediately)

- [x] The crash event appears in the ticket log immediately when the attempt exits, not at the end of the super-step
- [x] A snapshot is emitted when the crash is recorded, so the Console reflects it within seconds with no polling
- [x] The crash interrupt is raised at the super-step boundary as today, and answering it behaves as today
- [x] An engine seam test with a fast-failing ticket and a slow sibling shows the crash recorded at exit, before the sibling finishes; existing suites pass

## Notes

- `runTicket` now appends the `crash` event right after `exited` when read-back says the attempt died (engine/engine.ts). The marker correction was already at-exit in `readBack`; no change needed there.
- The boundary block keeps only `raiseInterrupt`; the duplicate `appendEvent` is gone, so a crash is recorded exactly once.
- The snapshot is emitted from the per-ticket completion callback in `driveLoop` (same place merges chain on). It carries the unchanged in-flight PoolState; the Console's snapshot cadence refetches the ticket's events, and the crash row plus the dropped "running" badge are what the operator sees. Inference: the card status stays `in-progress` until the boundary, matching the marker, which is the design's intent.
- `blockingHarness` gained `exitCode` (and `ready` as a settable status) so the seam test's fast-failing ticket leaves its marker rewritten and exits 3; existing callers pass no sixth arg and behave as before.
- Verified: `bun test` 289 pass, `bun run typecheck` clean. ui/ untouched.
