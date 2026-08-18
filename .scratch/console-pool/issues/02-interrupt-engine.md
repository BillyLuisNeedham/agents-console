<!-- state: id=02 blocked-by=01 status=ready -->

# 02 — Interrupt engine

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The engine's interrupt model. When a ticket's marker comes back as `checkpoint`, the engine raises an interrupt carrying the Issue's Brief; when a harness exits without setting a status, it raises a crash interrupt carrying the ticket's log path; when a ticket's blockers can never complete (cycle, or an upstream ticket failed terminally), it raises a deadlock interrupt. An interrupt pauses only its own ticket's subtree — ready siblings keep running in later super-steps. The engine exposes resume-with-answer: the caller answers an interrupt (with an optional note), the note is appended to the Issue file, and the pool continues automatically with no separate continue step. The engine reports quiescence — nothing running, interrupts pending — as a distinct state from done.

## Acceptance criteria

- [ ] `status=checkpoint` on a marker raises an interrupt carrying the ticket's Brief
- [ ] A harness exit with no status set raises a crash interrupt carrying the log path
- [ ] A ticket whose blockers can never complete raises a deadlock interrupt
- [ ] An interrupted ticket's ready siblings continue running in subsequent super-steps
- [ ] Resume-with-answer restarts the interrupted ticket's subtree and continues the pool with no separate continue action
- [ ] A resume note is appended to the Issue file
- [ ] Quiescent (all stopped, interrupts pending) is distinguishable from done (all tickets done) in emitted state
- [ ] All of the above covered by engine-seam tests with stub harnesses

## Blocked by

- 01 — Pool engine walking skeleton
