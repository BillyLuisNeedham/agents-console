<!-- state: id=03 blocked-by=01,02 status=done -->
# 03: Code review of the checkpoint-at-exit work

**What to build:** A full review of everything tickets 01-02 landed, run through the code-review skill against the spec (`docs/specs/2026-08-26-checkpoint-visible-at-attempt-exit.md`) and ADR-0004. Check the work along both axes the skill provides: does it follow the repo's documented standards, and does it match what the spec and the tickets actually asked for. Verify each ticket's acceptance criteria genuinely hold, that the test suites pass, and that the settled semantics were honoured: siblings are never paused by an early checkpoint, the boundary join is idempotent after at-exit joins, answers during the window are queued and processed only at the boundary, and the queued-answer store stays out of PoolState. Append every finding to this Issue as a numbered list under a `## Findings` heading, each marked blocker or nit. An empty findings list is a valid, successful outcome.

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [x] The code-review skill has been run over the full diff of tickets 01-02
- [x] Every finding is appended to this Issue under `## Findings`, numbered, each marked blocker or nit
- [x] `bun test` and `bun run typecheck` pass and their output is noted in the Issue
- [x] The settled semantics are verified: no sibling pausing, idempotent boundary join, window answers queued not processed, queued-answer store separate from PoolState
- [x] The Issue closes with an explicit verdict: clean, or N blockers for ticket 04

## Method

Fixed point `c0079e7` (the queue-setup commit); diff `git diff c0079e7...HEAD` covering `c99f478` (ticket 01) and `b8251c8` (ticket 02). The code-review skill's two axes ran as parallel sub-agents: Standards (no documented standards exist in this repo, so the Fowler smell baseline plus house-idiom consistency) and Spec (the spec, ADR-0004, and both tickets' acceptance criteria). I verified every reported finding against the diff myself before accepting it.

## Test output

- `bun test`: 305 pass, 0 fail, 1171 expect() calls across 10 files (18.95s).
- `bun run typecheck`: clean at the root and in `ui/`.
- ui/ production code untouched by 01-02 (test files only), so no UI build was required; ticket 02's notes record a green `bun run build` at its own close.

## Settled semantics, verified in the diff

- **No sibling pausing**: the at-exit path (engine/engine.ts:513-534) only applies the terminal update to `session.state`, raises the checkpoint interrupt, appends the event, and emits. Siblings still run under the same `Promise.all`; nothing signals or cancels them. The engine tests assert the sibling stays `in-progress` through the window.
- **Idempotent boundary join**: `result.joinedAtExit = true` is set at exit (engine/engine.ts:524) and the boundary skips such results (`if (result.joinedAtExit) continue`, engine/engine.ts:547). The boundary now folds remaining results onto `session.state` rather than the pre-flight snapshot, which is exactly the state the at-exit joins landed on, so nothing double-applies. Pinned by the exactly-once "exited" log-line assertions.
- **Window answers queued, not processed**: `acceptAnswer`/`drainAnswers` are untouched; the new wiring test shows an answer accepted mid-window lands in the queued-answer store with `processedAt` null, the marker stays `checkpoint`, the resume promise stays pending until the sentinel releases the sibling, and processing happens at the boundary.
- **Queued-answer store separate from PoolState**: the store (`session.answers`, persisted on its own) is not in the diff; acceptance never mutates pool state.
- **Merge queue and deadlock detector untouched**: neither appears in the diff.

## Findings

1. **nit** — Stale comment contradicting the change. The boundary crash branch still says "the state join above stays the single writer of PoolState" (engine/engine.ts:582), but the at-exit path now also writes `session.state` directly. The spec deliberately relaxed the single-writer rule for terminal results; the comment now describes a rule the code no longer follows.
2. **nit** — Misattributed marker assertions in the two fast-exit engine tests. The on-disk marker (`status=done` / `status=checkpoint` on line 1 of the issue file) is written by the stub harness at exit, not by the engine; the engine writes markers only at scheduling and persist. The assertions pass regardless of the change under review, and the test comment "the marker on disk agrees" overstates what is pinned. The snapshot assertions are the ones that pin at-exit behaviour, and they are sound.
3. **nit** — Duplicated checkpoint raise-and-record block. The at-exit path and the recovery path each carry `raiseInterrupt(session, checkpointInterrupt(...))` plus an identical `appendEvent(... kind: "checkpoint" ...)`. A shared helper would serve both. Judgement call; the recovery twin predates the change.
4. **nit** — Log channel ordering can differ from before. At-exit joins land in attempt-completion order, while non-terminal results still fold in `results` order at the boundary, so interleaved log lines can appear in a different order than the old all-at-boundary join produced. Cosmetic; final snapshot sequences are asserted coherent.
5. **nit** — Coverage by composition for US6 and the dependent-notice clearing. "Queued waiting state shows on the checkpointed card during the window" and "blocked-by-checkpoint notice clears when the blocker resolves" are each covered only by combining the window-shape projection tests with pre-existing queued-answer/notice tests; no single test pins either on the window snapshot. Both render already-covered behaviour, so the risk is low.
6. **nit** — `joinedAtExit` names the mechanism, and at the boundary it is always equivalent to `status !== "in-progress"`. Redundant but self-documenting; acceptable as written.

Standards axis otherwise found the new tests match the file's existing idioms exactly, and noted the at-exit event's `attempt: result.plan.attempt` is a deliberate improvement over the house pattern of `lastAttempt(...)` (no filesystem read, exact attempt). Spec axis found no scope creep: no production UI, server, scheduling, merge-queue, deadlock-detector, or queued-answer-semantics changes; the ui/ edits are test-only, and the `blockedByCheckpoint: []` fixture fix repairs a pre-existing typecheck error, disclosed in ticket 02's notes.

## Verdict

**Clean.** 0 blockers for ticket 04; 6 nits above, all judgement calls or comment/test-hygiene items. Ticket 04 may take or leave the nits.
