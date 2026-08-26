<!-- state: id=01 blocked-by=none status=done -->
# 01: Terminal results join pool state at attempt exit

**What to build:** When an attempt exits with a terminal result — `done` or `checkpoint` — that ticket's status lands in pool state and a snapshot is emitted immediately, without waiting for its super-step siblings. A ticket that finishes early shows its true status word on its card (green `done`, red `checkpoint`) while siblings still show `running`. The crash path already emits at exit; this ticket generalises the same treatment to all terminal results. The super-step boundary join becomes skip-if-present: applying the same terminal update twice is a no-op, and anything genuinely computed across results stays at the boundary. Reconnecting clients and state polls during the window see the truth, because the emitted snapshot itself carries it.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A super-step of two tickets where one finishes `done` quickly and the other runs slowly emits a snapshot before the slow sibling exits showing the fast ticket `done` and the slow ticket still `in-progress`
- [x] The same shape with a fast `checkpoint` emits a snapshot showing that ticket `checkpoint` while the sibling still runs
- [x] The boundary join after at-exit joins produces no duplicate or divergent state (idempotent), and the final snapshot sequence is coherent
- [x] Non-terminal behaviour is unchanged: siblings are never paused or cancelled, and the merge queue and deadlock detector are untouched
- [x] Engine seam tests (stub harnesses, including a blocking stub that holds a super-step open) cover all of the above; `bun test` and `bun run typecheck` pass

## Notes

- A terminal result (done or checkpoint) now lands in state the moment its attempt exits, in the per-ticket completion callback of `driveLoop` (engine/engine.ts), right where the crash-at-exit emit already was. The callback applies the result's update to `session.state` and emits, so the snapshot stream carries the true status while siblings still run.
- `TicketResult` gained `joinedAtExit`. The boundary join starts from `session.state` (which already holds the at-exit joins) and skips results joined at exit, so the same terminal update is never applied twice. Non-terminal bookkeeping (crash statuses, merges, conflict handling) still lands at the boundary, and the log channel shows no duplicate "exited" lines.
- The checkpoint interrupt is deliberately NOT moved to exit: that is Issue 02's scope. The checkpoint's interrupt and its event still wait for the boundary here; the status word turns the card red early, the interrupt raise comes in 02.
- Tests sit beside the crash-at-exit prior art in the `accept/process split` describe block, using the existing `blockingHarness` sentinel stub to hold a super-step open. Three new tests: fast done emits early, fast checkpoint emits early, and at-exit join applied exactly once with a coherent final snapshot sequence.
- The crash path is unchanged by this ticket: a crash still emits at exit but its update is not joined until the boundary (its status is `in-progress`, the same as the super-step write, so joining early would be a no-op).
- Verified: `bun test` 301 pass, `bun run typecheck` clean. ui/ untouched, no UI build needed.