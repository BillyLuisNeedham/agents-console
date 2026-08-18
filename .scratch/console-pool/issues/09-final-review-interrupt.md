<!-- state: id=09 blocked-by=02,08 status=ready -->

# 09 — Final Review interrupt

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The run's closing gate. When every ticket is done, the engine raises the final Review interrupt — one place for Billy to judge the whole run's finished work. Approving ends the run: the pool is complete and the server stays up so state, outcomes, and logs remain inspectable. Rejecting names specific tickets; those tickets return to ready with Billy's note appended to their Issue files, their downstream tickets' statuses are invalidated back to ready as well, and the run continues until every ticket is done again and a new Review interrupt is raised. Review is answerable inline like every other interrupt kind.

## Acceptance criteria

- [ ] All tickets done raises exactly one final Review interrupt
- [ ] Approving ends the run; the server stays up with full state inspectable
- [ ] Rejecting returns the named tickets to ready with the note appended to their Issue files
- [ ] Downstream tickets of a rejected ticket also return to ready
- [ ] The run continues after a rejection and raises a fresh Review interrupt when done again
- [ ] Review is answerable from the UI through the same interrupt form as other kinds
- [ ] Covered by engine-seam tests (approve path, reject path, re-review) and projection tests for the Review form

## Blocked by

- 02 — Interrupt engine
- 08 — Inline interrupts in card and Detail
