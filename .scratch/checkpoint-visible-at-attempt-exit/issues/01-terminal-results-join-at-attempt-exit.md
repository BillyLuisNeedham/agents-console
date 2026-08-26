<!-- state: id=01 blocked-by=none status=ready -->
# 01: Terminal results join pool state at attempt exit

**What to build:** When an attempt exits with a terminal result — `done` or `checkpoint` — that ticket's status lands in pool state and a snapshot is emitted immediately, without waiting for its super-step siblings. A ticket that finishes early shows its true status word on its card (green `done`, red `checkpoint`) while siblings still show `running`. The crash path already emits at exit; this ticket generalises the same treatment to all terminal results. The super-step boundary join becomes skip-if-present: applying the same terminal update twice is a no-op, and anything genuinely computed across results stays at the boundary. Reconnecting clients and state polls during the window see the truth, because the emitted snapshot itself carries it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A super-step of two tickets where one finishes `done` quickly and the other runs slowly emits a snapshot before the slow sibling exits showing the fast ticket `done` and the slow ticket still `in-progress`
- [ ] The same shape with a fast `checkpoint` emits a snapshot showing that ticket `checkpoint` while the sibling still runs
- [ ] The boundary join after at-exit joins produces no duplicate or divergent state (idempotent), and the final snapshot sequence is coherent
- [ ] Non-terminal behaviour is unchanged: siblings are never paused or cancelled, and the merge queue and deadlock detector are untouched
- [ ] Engine seam tests (stub harnesses, including a blocking stub that holds a super-step open) cover all of the above; `bun test` and `bun run typecheck` pass
