<!-- state: id=11 blocked-by=01,02,03,04,05,06,07,08,09,10 status=ready -->

# 11 — Review pass against the spec

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

Final review pass over the whole ticket-pool Console before calling the spec done. Run a review (standards + spec axes — the `code-review` or `peer-review` skill) across the full diff of tickets 01 to 10, verify every user story in the spec is demonstrably working, and address the findings. The fixed point for the review is the commit immediately before ticket 01's commit. Vocabulary gets specific attention: state, channel, reducer, super-step, checkpoint, thread, interrupt, ticket, Review, Console, Detail per CONTEXT.md, with avoid-words absent from code and UI copy.

## Acceptance criteria

- [ ] Both review axes run over the full diff from the fixed point
- [ ] Every user story in the spec is verified as demonstrably working, with the verification noted
- [ ] CONTEXT.md vocabulary is used correctly in code and UI copy; avoid-words absent
- [ ] All findings addressed or explicitly deferred with reasons recorded
- [ ] Full test suite, typecheck, and build all clean

## Blocked by

- 01 — Pool engine walking skeleton
- 02 — Interrupt engine
- 03 — Durability and rehydration
- 04 — Harness spawn kernel
- 05 — Worktrees and parallel super-steps
- 06 — Resolver agent and conflict approval
- 07 — Server and pool projection UI
- 08 — Inline interrupts in card and Detail
- 09 — Final Review interrupt
- 10 — my-console-runner skill
