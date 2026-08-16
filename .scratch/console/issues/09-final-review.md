<!-- state: id=09 blocked-by=05,06,07,08 status=ready -->

# 09 — Final code review pass

## What to build

Final review pass over the whole Console before calling the spec done. Run the review (standards + spec axes — the `code-review` or `peer-review` skill) across the full diff, verify every user story in the parent spec is demonstrably working, and address findings.

## Acceptance criteria

- [ ] `tsc --noEmit` clean and `bun test` green
- [ ] Review findings addressed or explicitly deferred
- [ ] Every user story in the parent spec checked off as demoed
- [ ] CONTEXT.md vocabulary respected — no avoid-words in code or UI copy

## Blocked by

- 05 — Canvas interactions
- 06 — Interrupts inline
- 07 — Ticket cards
- 08 — State inspector
