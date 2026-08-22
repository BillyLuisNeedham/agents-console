<!-- state: id=04 blocked-by=03 status=ready -->

# 04 — Prototype cleanup

Spec: GitHub issue #15 (BillyLuisNeedham/agents-console).

## What to build

With the tabbed Detail shipped, the throwaway prototype scaffolding leaves main: the `?variant=` floating switcher, its styles, the `proto-variant-change` listener, and the losing Variants B and C (Variant A's file goes too if anything of it remains once ticket 03 has rewritten the design properly). No `?variant=` param should have any effect on the Console afterward. The full prototype — all three variants plus wiring — remains on the `prototype/ticket-details` branch as the primary source, so nothing is lost.

## Acceptance criteria

- [ ] The prototype switcher and its keyboard listener are gone from the ui
- [ ] The losing variant components are gone from main
- [ ] `?variant=A|B|C` has no visible effect
- [ ] The `prototype/ticket-details` branch still holds the full prototype for reference
- [ ] Full test suite, typecheck, and build clean

## Blocked by

03 — Tabbed Detail panel.
