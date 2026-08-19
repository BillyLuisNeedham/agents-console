<!-- state: id=02 blocked-by=01 status=done -->

# 02 — Interrupt engine

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The engine's interrupt model. When a ticket's marker comes back as `checkpoint`, the engine raises an interrupt carrying the Issue's Brief; when a harness exits without setting a status, it raises a crash interrupt carrying the ticket's log path; when a ticket's blockers can never complete (cycle, or an upstream ticket failed terminally), it raises a deadlock interrupt. An interrupt pauses only its own ticket's subtree — ready siblings keep running in later super-steps. The engine exposes resume-with-answer: the caller answers an interrupt (with an optional note), the note is appended to the Issue file, and the pool continues automatically with no separate continue step. The engine reports quiescence — nothing running, interrupts pending — as a distinct state from done.

## Acceptance criteria

- [x] `status=checkpoint` on a marker raises an interrupt carrying the ticket's Brief
- [x] A harness exit with no status set raises a crash interrupt carrying the log path
- [x] A ticket whose blockers can never complete raises a deadlock interrupt
- [x] An interrupted ticket's ready siblings continue running in subsequent super-steps
- [x] Resume-with-answer restarts the interrupted ticket's subtree and continues the pool with no separate continue action
- [x] A resume note is appended to the Issue file
- [x] Quiescent (all stopped, interrupts pending) is distinguishable from done (all tickets done) in emitted state
- [x] All of the above covered by engine-seam tests with stub harnesses

## Blocked by

- 01 — Pool engine walking skeleton

## Notes

- Repo layout moved since the runner instructions were written: `prototype/` was promoted to the repo root (see Issue 01 Notes). Engine is `engine/engine.ts`; tests run with `bun test`, types with `npm run typecheck`.
- Design: interrupts live in state as `state.interrupts` (replace reducer, control plane rather than a data channel), so they flow through snapshots and sqlite checkpoints unchanged. Kinds: `checkpoint` (body = the Issue's `## Brief` section), `crash` (body = the ticket's log path), `deadlock` (body = the blockers that can never complete).
- Crash detection: the engine writes `in-progress` before spawn and nothing legitimate writes it after, so a marker that reads back `in-progress` means the harness never set a status.
- Deadlock detection: a non-done ticket with no pending interrupt can never complete when its blocked-by closure hits a cycle, a deadlock-interrupted ticket, or an unknown blocker id. Checkpoint and crash interrupts count as resumable, so downstream of them waits rather than deadlocks. Detection runs at every super-step boundary; stale deadlock interrupts clear when the pool files are fixed.
- Resume: `PoolRun.resume(ticketId, note?)` appends the note to the Issue (`## Resume note`), reloads markers from disk (markers are truth, so pool-file fixes are picked up), sets the ticket ready, and re-enters the drive loop. No separate continue action.
- Phase vocabulary gains `quiescent` (nothing running, interrupts pending), distinct from `done`. `stalled` stays only for the residue case (no ready tickets, no interrupts) which rehydration (Issue 03) owns.

## Review findings, and what changed because of them

Two-axis review (spec + standards) ran on the working tree before commit. Acted on:

- A throw inside the drive loop left console.db open; the loop is wrapped again and the store closes on error. `PoolRun.close()` now exists for abandoning a quiescent run without leaking the handle.
- Resume reloads markers but assignments were resolved once at load, so a new Issue file added while quiescent crashed the next spawn with an opaque TypeError. Resume now resolves assignments for any marker that lacks one, keeping the fail-fast validation.
- Concurrent resume calls are serialized through a per-session promise chain.
- Resume respects a ticket the human marked `status=done` on disk (clears the interrupt, logs "already done on disk") instead of dragging it back to ready.
- Removed dead code (an unreachable deadlock body fallback, a dead reducer branch) and tightened a vacuous snapshot assertion.

Noted for later Issues, not fixed here:

- A harness that exits having written `status=ready` re-enters the ready set and would re-spawn forever. Pre-existing from Issue 01; no test covers it. (Inference: treating read-back `ready` as a crash would close it.)
- An `in-progress` read-back after exit is always reported as a crash, even if a harness wrote `in-progress` itself. Spec-conformant ("crash = exit with no status set"); the same marker at load is rehydration's problem (Issue 03).
- Downstream of a deadlocked ticket deadlocks too (propagation through `canComplete`), and an unknown blocker id deadlocks the ticket. Both tested; the propagation case rides the same code path as the cycle case.
