# No silent dead drives

Closes https://github.com/BillyLuisNeedham/agents-console/issues/26.

## Problem Statement

A pool stalled after its only checkpoint-and-resume ticket finished done. The final ticket sat ready with every blocker done, the engine process alive and idle, no interrupt pending, and the snapshot still reporting `phase: "running"`. No further super-step was scheduled, and persistence stopped at the same moment — `console.db` showed no rows for the resumed attempts, the interrupts, the answers, or the final done. Restarting the server fixed it immediately, proving the on-disk state was schedulable and the fault was in the in-memory session.

The investigation found the structural cause: the entire drive loop sits in one try/catch whose fatal path closes the checkpoint store, settles the drive, and rethrows — and the caller swallows that rethrow. One error, of any kind, permanently kills the drive loop while the server keeps serving the last snapshot as if the run were live. The Console's frozen `running` phase is a lie, and there is no durable record of what killed it. This failure mode now has a name: a **dead drive**.

A second, related hang class lives in the spawn pump: a harness child can exit while a grandchild still holds its pipe open, and the pump then waits forever — parking the drive at the merge-resolver await with no child process left to observe.

## Solution

The drive loop must survive a persist failure: a failed boundary persist retries with short backoff, and if it still cannot write, the pool raises an interrupt so a human decides — it never silently closes the store and dies. Any error that does kill the drive is never swallowed: it is written to a durable error log in the pool, appended to the pool log, and surfaced as a terminal phase so the Console shows the pool as dead instead of frozen on running.

State changes made while processing interrupt answers persist themselves immediately, so an answered resume is never in-memory-only. And the spawn pump can no longer wait forever on a pipe a grandchild holds open after the child has exited.

## User Stories

1. As Billy, I want a failed checkpoint write to retry itself, so that one flaky moment does not take down the pool.
2. As Billy, I want the pool to keep scheduling tickets after a persist hiccup, so that issue #26's stall cannot recur.
3. As Billy, I want a persist failure that will not clear to raise an interrupt, so that I decide what happens next rather than discovering a frozen pool.
4. As Billy, I want a persist failure to never close the checkpoint store, so that the retry and the next boundary both still have a database to write to.
5. As Billy, I want any drive-killing error written to a durable error log in the pool directory, so that I can debug it after the fact.
6. As Billy, I want any drive-killing error appended to the pool log, so that it shows in the Console's log drawer immediately.
7. As Billy, I want the Console to show a dead drive as a terminal state rather than running, so that a frozen snapshot never masquerades as a live pool.
8. As Billy, I want every catch that can kill the drive to report through the same mechanism, so that no failure path can forget to log.
9. As Billy, I want interrupt answers processed at the boundary to persist their state change immediately, so that an answered resume is never in-memory-only.
10. As Billy, I want a harness child whose pipe is held open by a grandchild to not park the drive forever, so that merge-resolver and ticket spawns cannot hang the loop.
11. As Billy, I want the spawn to return within a bounded grace after the child exits, so that late output is captured without waiting indefinitely.
12. As Billy, I want the next stall-class bug to name itself in the logs, so that I never again diagnose "alive and idle with no terminal line".
13. As Billy, I want restarting the server after a dead drive to keep working from disk state, so that restart remains the escape hatch it is today.
14. As a future reader of this codebase, I want an ADR explaining why a persist failure interrupts instead of killing the pool, so that the removal of the swallow-and-close design is not surprising.
15. As a future maintainer, I want a regression test that injects a store failure mid-run, so that the fix stays proven as the engine changes.

## Implementation Decisions

- **Persist failures retry, then interrupt.** A boundary persist that throws is retried with a short backoff, a small bounded number of times. On success the drive continues normally. On exhaustion the pool raises a run-level interrupt ("persistence is failing") and waits for a human, the store still open.
- **A persist failure never closes the store.** The fatal-catch path no longer treats a persist error as fatal to the session. The store closes only on a genuinely terminal end (the closing gate) or an error the drive truly cannot continue from.
- **Drive death is durable and visible.** The drive loop's fatal catch — and every other catch that settles or kills the drive — reports through one shared mechanism that: appends the error to a durable JSONL error log in the pool's runs directory; appends it to the pool log; and emits the terminal phase before settling waiters with the error. The swallowed rethrow at the drive's entry point is removed.
- **A new terminal phase.** RunPhase gains `dead`, distinct from the closing gate's done/stalled/quiescent. The server snapshot carries it and the Console renders it as terminal. A dead drive is defined by this emission: if the phase was emitted, the drive reported its own death; if it wasn't, the drive is lying.
- **Answer processing persists its own state change.** The path that drains queued answers and applies their state changes outside the drive's join-then-persist flow persists the resulting state itself, before the next super-step is scheduled. A resumed ticket's state is durable from the moment its answer is processed.
- **The spawn pump cannot outlive the child.** Once the harness process has exited, the stdout/stderr pumps get a bounded grace to drain and are then torn down (streams destroyed), so a grandchild holding a pipe open after the child's exit cannot park the drive forever. This applies to ticket spawns and merge-resolver spawns alike.
- **Existing behavior is otherwise unchanged.** The closing gate, deadlock reconciliation, rehydration from disk markers, queued-answer semantics, and the Review flow all stay as they are. Restart-from-disk remains the escape hatch.
- **Docs.** The PR includes ADR-0006 ("a persist failure interrupts instead of killing the pool") and the CONTEXT.md glossary entry for **Dead drive** (already added in this worktree).

## Testing Decisions

- **Seam: the existing engine integration seam.** Drive the engine end-to-end with fake harness CLIs, exactly as the engine test suite does today. One new minimal injection seam is needed and allowed: the checkpoint store becomes substitutable at pool start so a test can make persist throw on demand. No other seams.
- Good tests assert externally visible behavior only: tickets scheduled, events in ticket logs, interrupts raised, checkpoint rows in the database, error log contents, the emitted phase, and state after rehydration. They do not assert on engine internals.
- New tests cover: a store failure at a boundary retries and recovers, the next ticket is scheduled, and the row eventually lands; a persistently failing store raises the persistence interrupt with the store still open, and the pool resumes cleanly after restart; a drive-killing error writes the durable error log, appends to the pool log, and emits the dead phase; an answered interrupt's state change survives a server kill before the next super-step (no reliance on in-memory state); a fake child that exits while a grandchild holds its pipe open lets the spawn return and the loop proceed to the next super-step.
- Prior art: the engine integration suite's fake-CLI harness pattern, the checkpoint-to-resume tests, and the restart-with-queued-answer tests.

## Out of Scope

- Identifying the original first trigger of issue #26's stall. The stalled pool's artifacts no longer exist on disk; the new observability names the next occurrence instead.
- Changes to the closing gate's semantics (done, stalled, quiescent) or to deadlock reconciliation.
- Retry policies for failures other than persist, and any retry/backoff policy for the human's interrupt answers.
- Rich Console treatment of the dead phase beyond rendering it as a terminal state.
- Verifying a ticket's done claim (that commits landed, that tests pass) — Review remains the human check.

## Further Notes

- The work happens in the git worktree on branch `fix/issue-26-pool-stall`, landing as a PR into main that closes issue #26. Implementation is delegated to deepseek agents under orchestration; no code is written in the main checkout.
- CONTEXT.md gained the **Dead drive** glossary entry during the grill session, in this worktree.
