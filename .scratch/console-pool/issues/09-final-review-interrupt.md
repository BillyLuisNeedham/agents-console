<!-- state: id=09 blocked-by=02,08 status=done -->

# 09 — Final Review interrupt

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The run's closing gate. When every ticket is done, the engine raises the final Review interrupt — one place for Billy to judge the whole run's finished work. Approving ends the run: the pool is complete and the server stays up so state, outcomes, and logs remain inspectable. Rejecting names specific tickets; those tickets return to ready with Billy's note appended to their Issue files, their downstream tickets' statuses are invalidated back to ready as well, and the run continues until every ticket is done again and a new Review interrupt is raised. Review is answerable inline like every other interrupt kind.

## Acceptance criteria

- [x] All tickets done raises exactly one final Review interrupt
- [x] Approving ends the run; the server stays up with full state inspectable
- [x] Rejecting returns the named tickets to ready with the note appended to their Issue files
- [x] Downstream tickets of a rejected ticket also return to ready
- [x] The run continues after a rejection and raises a fresh Review interrupt when done again
- [x] Review is answerable from the UI through the same interrupt form as other kinds
- [x] Covered by engine-seam tests (approve path, reject path, re-review) and projection tests for the Review form

## Blocked by

- 02 — Interrupt engine
- 08 — Inline interrupts in card and Detail

## Notes

- The Review interrupt carries the id `REVIEW` (exported as `REVIEW_TICKET_ID` from the engine), which is the projection's `REVIEW_CARD_ID` by contract, so the interrupt hangs on the review utility card and is answered there and from its Detail through the same interrupt form.
- Approving sets a `reviewApproved` field on state, persisted with the checkpoint, so a server restart after approval comes up done instead of re-asking. Rehydration clears it (and any stored review interrupt) when the markers on disk are not all done, so a hand reset between runs earns a fresh Review.
- `phase: "done"` now means "review approved": a fully-finished pool stops quiescent at the gate. The existing engine and server tests were updated to approve through a shared helper rather than expecting done directly.
- Decision the Issue left open: how a reject names tickets. The note is parsed for known ticket ids delimited by non-id characters ("redo 02 and 05" names 02 and 05); a reject naming nothing known is refused with an error listing the ids. The note is appended to the named tickets' Issue files as `## Review note`; downstream tickets (the transitive closure over blocked-by) are reset to ready without a note, and their outcomes are dropped from the channel and their outcome files deleted.
- From the two-axis review: a live approve over a marker a human had reset on disk used to close the run over unfinished work; now the approval only stands when the reloaded markers are all done, otherwise the run continues to a fresh Review (regression test added). The review branch in `answerTicket` was folded into the shared marker-reload path, and the interrupt-to-view mapping in the projection was de-duplicated.
- Inference, untested end to end: the interrupt draft keying in the view prunes by interrupt ticket id, so a note typed into the review form survives snapshot re-renders the same way ticket notes do; covered indirectly by the existing view wiring, not by a DOM test (there is no DOM test layer).
