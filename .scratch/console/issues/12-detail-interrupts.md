<!-- state: id=12 blocked-by=10 status=done -->

# 12 — Interrupts answerable from the Detail

## What to build

When the selected node has a pending interrupt, the Detail renders the same interrupt form as the card's inline form, wired to the same handlers. Both surfaces stay live: the inline form remains on the card so interrupted nodes stay visible on the canvas, and the Detail gives the same form room to breathe. Answering from either place calls the same resume path; the next stream update clears both. A node with no pending interrupt renders no form in the Detail.

## Acceptance criteria

- [x] Pending interrupt form renders in the Detail for the selected node
- [x] The Detail form uses the same handlers as the card's inline form; answering from either resumes the run exactly once
- [x] The card's inline interrupt form stays in place and keeps working
- [x] A node with no pending interrupt shows no form in the Detail
- [x] Form view comes from the existing interrupt form projection, pinned by seam tests

## Blocked by

- 10 — Detail panel skeleton

## Notes

- The projection was already in place from issue 11: `projectDetail` carries `interrupt` via `projectInterruptForm`, so this issue's code change is the view only. `renderDetail` now appends a `renderInterruptForm(view.interrupt, handlers)` section (after the raw-state slice) when `view.interrupt` is present, and renders nothing when it is null. Both surfaces call the same `renderInterruptForm`, so they share handlers and the same `handlers.onResume` path.
- "Exactly once" is enforced where it already was: `main.ts` `resume()` guards on `state.run.streaming`, setting it true before the first resume and no-oping any second call. The next snapshot clears the interrupt from both the card and the Detail because both re-project from `selected.interrupts`.
- The card's inline form is untouched; `renderCard` still pushes `renderInterruptForm(card.interrupt, handlers)`.
- No new seam tests were needed: `projectDetail` already pins `interrupt` (present for an interrupted node, null otherwise) at `project.test.ts:932`, and `projectInterruptForm` pins all three kinds. `bun test` (79 pass), `tsc --noEmit`, and `vite build` clean.
- Verified against the live dev server with `.scratch/console/verify-12.ts`: Detail projects the approve-spec form; a non-interrupted node projects none; card and Detail share the identical form projection; after a resume the interrupt clears from the Detail.
