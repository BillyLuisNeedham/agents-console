<!-- state: id=08 blocked-by=02,07 status=ready -->

# 08 — Inline interrupts in card and Detail

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

Every interrupt kind answerable from the UI. A card whose ticket has a pending interrupt shows it inline — one form shape across the six kinds (ticket checkpoint, merge-conflict approval, resolver-failure/manual merge, harness crash, deadlock, final Review) with a kind-specific body: a checkpoint shows the Issue's Brief, a crash shows the log path, a conflict approval shows the resolver's resolution, and so on. The same interrupt renders at full size in the card's Detail, and both stay live as snapshots stream. Answering (with an optional note where the kind supports one) posts resume-with-answer and the pool continues with no separate continue step. Pending interrupts are visible at a glance across the canvas, so Billy can see everything waiting on him.

## Acceptance criteria

- [ ] A pending interrupt renders inline on its card with a kind-specific body
- [ ] The same interrupt renders at full size in the Detail; both views stay live across snapshots
- [ ] Answering an interrupt resumes the pool automatically — one answer, one action
- [ ] Kinds that support a note append it to the Issue file via the engine's resume path
- [ ] All six interrupt kinds are renderable and answerable
- [ ] Cards with pending interrupts are visually distinguishable from running and done cards
- [ ] Covered by projection tests over snapshots carrying each interrupt kind

## Blocked by

- 02 — Interrupt engine
- 07 — Server and pool projection UI
