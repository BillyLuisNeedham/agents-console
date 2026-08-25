---
status: ready-for-agent
origin: https://github.com/BillyLuisNeedham/agents-console/issues/12
adr: docs/adr/0004-accept-answers-immediately-process-at-boundary.md
---

# Spec: Resume feedback, queued answers, and pool-drive fixes

## Problem Statement

Billy operates a pool through the Console: tickets run long attempts (20–40
minutes), reach interrupts, and wait for a human answer. Today, answering an
interrupt is a leap into the dark:

- The answer request hangs until the whole drive settles — to curl and to the
  Console UI, the click looks dead.
- An answer submitted while a super-step is in flight sits in an invisible
  in-memory queue: no event, no state change, nothing on the card. There is no
  way to tell the answer landed.
- During the initial drive, every answer is rejected outright with 400
  "pool not started", even though interrupts are pending and the board shows
  them.
- If the server dies with answers queued, they vanish silently; a retried
  answer after a client timeout risks a confusing "no pending interrupt"
  error.

Separately, five bugs found while operating a pool degrade every run: a ticket
paused at a checkpoint invisibly stalls its dependents; an attempt's result is
read back from the wrong Issue copy, producing false crashes and skipped
merges; a crash is only recorded when the super-step ends, so the UI shows a
finished ticket as running for tens of minutes; and AGENT.md edits never take
effect because the file is read once at pool start.

## Solution

Answering an interrupt becomes two distinct moments: **acceptance** and
**processing** (ADR-0004).

- **Acceptance is immediate and durable.** The moment an answer arrives it is
  recorded — an `answered` event in the ticket log and a queued-answer record
  in a persisted store — and the request returns 202 right away. No hanging,
  no 400s, from the first super-step onward.
- **A queued answer is visible.** The ticket card and Detail show the
  interrupt as answered-and-waiting until it is processed, pushed over the SSE
  snapshot stream with no polling.
- **Processing happens at the next safe point.** When the pool is idle the
  answer is processed immediately, as today. While a super-step is in flight
  the queued answer is processed at the next super-step boundary — the
  engine's normal scheduling quantum.
- **Nothing is lost.** Queued answers survive a server restart and are drained
  after rehydrate. A retried answer (client timed out and resubmitted) is
  idempotent: 202 again, not a misleading error.

The five operating bugs are fixed at their roots: dependents of a
checkpointing ticket show exactly what they're waiting on; the main-checkout
Issue file becomes the single canonical copy that both the agent and read-back
use; a crash is recorded and shown the moment the attempt exits; and AGENT.md
is re-read at every spawn.

## User Stories

1. As a pool operator, I want my interrupt answer acknowledged immediately, so that I know my click landed without watching a request hang.
2. As a pool operator, I want the answer request to return within a moment even while attempts are running, so that I can answer interrupts from curl or the UI without timeouts.
3. As a pool operator, I want the `answered` event written to the ticket log at the moment my answer is accepted, so that the ticket log is a truthful record of when I acted.
4. As a pool operator, I want to see on the ticket card that my answer is queued and waiting, so that I never wonder whether I need to click again.
5. As a pool operator, I want the same waiting state in the ticket's Detail, so that both surfaces agree.
6. As a pool operator, I want the waiting state pushed to me over the snapshot stream, so that I never re-poll or refresh to see it.
7. As a pool operator, I want the waiting state to clear when the answer is processed, so that the card always reflects reality.
8. As a pool operator, I want to answer interrupts during the pool's initial drive, so that I'm never locked out with "pool not started" while interrupts pend.
9. As a pool operator, I want my answer to a ticket processed immediately when the pool is idle, so that the common case stays as fast as today.
10. As a pool operator, I want my answer to take effect at the next super-step boundary when attempts are in flight, so that the engine's scheduling stays safe and predictable.
11. As a pool operator, I want answers to multiple tickets' interrupts to queue and process in submission order, so that a burst of answers behaves deterministically.
12. As a pool operator, I want my queued answer to survive a server restart, so that a crash never silently drops my decision.
13. As a pool operator, I want queued answers drained automatically after the server restarts and rehydrates, so that recovery needs no manual redo.
14. As a pool operator, I want a retried answer (after a client timeout) to be acknowledged again rather than erroring, so that retries are safe and unconfusing.
15. As a pool operator, I want review approvals and rejections acknowledged and recorded the same way as other answers, so that all interrupt kinds behave uniformly.
16. As a pool operator reading a ticket log, I want to see the `answered` event before the attempt it unblocked, so that causality in the log is clear.
17. As a pool operator, I want a ticket that is waiting on another ticket's checkpoint to say so — "blocked by checkpoint on ticket N (waiting on you)" — so that a stall is visible instead of silent.
18. As a pool operator, I want checkpoint semantics unchanged — only `done` satisfies a blocked-by edge — so that dependents never run on unconfirmed work.
19. As a pool operator, I want the deadlock detector left as-is for checkpointed blockers, so that a human-resumable pause is never misreported as a deadlock.
20. As a pool operator, I want the agent and the engine to treat the same Issue file as the file of record, so that an attempt's `done` is always seen.
21. As a pool operator, I want attempts that complete successfully to be recognised as `done`, so that false crashes stop stranding finished work.
22. As a pool operator, I want merges of completed tickets to run, so that finished work stops being stranded unmerged.
23. As a pool operator, I want a crash recorded the moment the attempt exits, so that the UI stops showing a finished ticket as running for tens of minutes.
24. As a pool operator, I want a snapshot pushed when a crash is recorded, so that I see failures within seconds.
25. As a pool operator, I want the crash interrupt raised as it is today (at the super-step boundary), so that state integrity is preserved.
26. As a pool operator, I want edits to AGENT.md to take effect on the next spawn, so that I can correct agent instructions mid-run without restarting the pool.
27. As a pool operator scripting against the API, I want a fast, honest 202 response, so that my scripts stop hanging and can distinguish "accepted" from "processed".
28. As a pool operator scripting against the API, I want to confirm acceptance via the ticket's events, so that a timed-out client can verify its answer landed.

## Implementation Decisions

- **Accept/process split (ADR-0004).** Every interrupt answer is split into
  *acceptance* (record and acknowledge) and *processing* (apply the answer and
  continue the drive). This is the architectural spine of the spec.
- **Acceptance writes, in order:** the `answered` event to the ticket log
  (carrying the interrupt kind, as today), then a queued-answer record
  (ticket id, interrupt identity, answer payload, submission order) to the
  queued-answer store. The HTTP response is 202 with the current snapshot.
- **Queued answers get their own persisted store**, separate from PoolState.
  The super-step join rebuilds PoolState from a pre-flight snapshot and would
  clobber a queued-answers channel; a separate store sidesteps the join
  entirely and persists independently, so a restart cannot lose queued
  answers. The store lives alongside the pool's other run artifacts.
- **Snapshots merge the queued-answer store at emit time.** The server's
  snapshot projection combines PoolState with the queued-answer records, so
  `/api/state` and every SSE frame carry the waiting state with no change to
  super-step merge semantics.
- **The pool run handle exists from the first super-step.** Starting a pool
  returns a live handle immediately, with the drive proceeding in the
  background, so answers are accepted from the very start and "pool not
  started" disappears. The handle's answer interface accepts answers at any
  time.
- **Processing drains the queue at the super-step boundary.** While a drive is
  in flight, queued answers are processed in submission order at the next
  boundary — after the in-flight super-step's join and persistence, before the
  next super-step's scheduling. When no drive is in flight, acceptance is
  followed immediately by processing, preserving today's behaviour for the
  idle case.
- **Only acceptance is immediate; spawning never is.** An answered ticket's
  next attempt is always spawned by the drive, never by the answer path, so
  the single-writer invariant on the checkout and markers is preserved.
- **Idempotent resume.** An answer for an interrupt that already has a queued
  or accepted answer (same ticket, same interrupt identity) returns 202 again
  without recording a duplicate. A genuinely interrupt-less ticket still
  errors as today.
- **Review interrupts get `answered` events at acceptance too**, like every
  other interrupt kind; the existing `review-reject` event remains for the
  rejection outcome.
- **Checkpoint semantics unchanged.** Only `done` satisfies a blocked-by edge;
  the deadlock detector's reasoning is untouched. The change is visibility:
  dependency projection identifies a blocker sitting at `checkpoint` with a
  pending interrupt, and the dependent's card and Detail surface "blocked by
  checkpoint on ticket N (waiting on you)".
- **The main-checkout Issue file is the single canonical copy.** The spawn
  prompt instructs the agent to read and update the Issue by its absolute
  main-checkout path; read-back reads that same file. The worktree seed copy
  remains, as context only. This aligns the engine with the merge design
  (which already discards worktree Issue edits) and eliminates the false
  crash / skipped merge pair.
- **Crash recorded at attempt exit.** When an attempt exits unsuccessfully,
  the crash event and the marker update are written immediately by the
  attempt-running path (per-ticket event appends are concurrency-safe), and a
  snapshot is emitted so the UI updates within seconds. The crash interrupt is
  still raised at the super-step boundary, preserving state-join safety.
- **AGENT.md is re-read at every spawn**, so mid-run edits take effect on the
  next attempt. Nothing is cached on the session.
- **Server API contract:** `POST /api/resume` returns 202 on acceptance (all
  interrupt kinds, approve/reject included), 400 only for genuinely invalid
  answers (unknown ticket, no pending interrupt and no matching accepted
  answer), and never for "pool not started".

## Testing Decisions

- **What makes a good test here:** exercise external behaviour through the
  existing public seams — drive a pool with stub harnesses and assert on
  events, snapshots, HTTP responses, and on-disk artifacts. Never assert on
  internal wiring (chains, flags, module privates).
- **Engine seam** (`runPool` with stub `HarnessCommand`s; prior art:
  engine/engine.test.ts): acceptance writes the `answered` event and a queued
  record without driving; boundary drain processes queued answers in order;
  idle-pool answers process immediately; queued answers survive rehydrate and
  drain; crash event is written at attempt exit; AGENT.md is re-read per
  spawn; read-back recognises an agent that updates the canonical Issue copy.
  One test-infrastructure addition: a stub harness that blocks until released
  (e.g. waits on a sentinel file), so tests can hold a super-step open and
  answer mid-flight.
- **Server seam** (`startServer` + real HTTP; prior art: engine/server.test.ts):
  202 returned promptly while a super-step is held open; no 400 during the
  initial drive; duplicate answer returns 202 without a second `answered`
  event; queued answers appear in `/api/state` and in SSE frames.
- **UI projection seam** (prior art: ui/src/project.test.ts): a snapshot
  carrying a queued answer projects the waiting state onto the card and
  Detail view models; a dependent of a checkpointed ticket projects the
  "blocked by checkpoint (waiting on you)" surface.
- Existing suites must keep passing unchanged except where behaviour is
  deliberately redefined (resume response code, crash timing, prompt paths).

## Out of Scope

- **True immediate spawn mid-super-step** (forced worktree spawns, join
  rebase, drive reentrancy guard): rejected in ADR-0004; the boundary is the
  scheduling quantum.
- **Checkpoint satisfying blocked-by edges**, or any deadlock-detector
  behaviour change.
- **The super-step join and channel merge semantics** — untouched by design.
- **Merge, resolver, and review-gate flows**, beyond review interrupts gaining
  the uniform `answered` event.
- **Visual redesign** of the Console beyond the two new surfaces (queued-answer
  waiting state, blocked-by-checkpoint notice).
- **Fleet/multi-pool concerns.**

## Further Notes

- Origin: GitHub issue #12 and its comments (five operating bugs), verified
  against the code during the design interview.
- Decision record: `docs/adr/0004-accept-answers-immediately-process-at-boundary.md`.
- Glossary: `Queued answer` is defined in CONTEXT.md; spec language follows
  the domain model (interrupt, super-step, checkpoint, thread, pool, attempt,
  ticket log, Detail).
- The observed production pain (ticket 28's answer invisible behind ticket
  19's attempt; resume 400ing for 20–40 minutes) is the acceptance bar: after
  this work, both are impossible.
