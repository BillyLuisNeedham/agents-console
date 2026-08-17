<!-- state: id=12 blocked-by=10 status=ready -->

# 12 — Interrupts answerable from the Detail

## What to build

When the selected node has a pending interrupt, the Detail renders the same interrupt form as the card's inline form, wired to the same handlers. Both surfaces stay live: the inline form remains on the card so interrupted nodes stay visible on the canvas, and the Detail gives the same form room to breathe. Answering from either place calls the same resume path; the next stream update clears both. A node with no pending interrupt renders no form in the Detail.

## Acceptance criteria

- [ ] Pending interrupt form renders in the Detail for the selected node
- [ ] The Detail form uses the same handlers as the card's inline form; answering from either resumes the run exactly once
- [ ] The card's inline interrupt form stays in place and keeps working
- [ ] A node with no pending interrupt shows no form in the Detail
- [ ] Form view comes from the existing interrupt form projection, pinned by seam tests

## Blocked by

- 10 — Detail panel skeleton
