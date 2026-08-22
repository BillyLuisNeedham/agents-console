<!-- state: id=04 blocked-by=03 status=done -->

# 04 — Prototype cleanup

Spec: GitHub issue #15 (BillyLuisNeedham/agents-console).

## What to build

With the tabbed Detail shipped, the throwaway prototype scaffolding leaves main: the `?variant=` floating switcher, its styles, the `proto-variant-change` listener, and the losing Variants B and C (Variant A's file goes too if anything of it remains once ticket 03 has rewritten the design properly). No `?variant=` param should have any effect on the Console afterward. The full prototype — all three variants plus wiring — remains on the `prototype/ticket-details` branch as the primary source, so nothing is lost.

## Acceptance criteria

- [x] The prototype switcher and its keyboard listener are gone from the ui
- [x] The losing variant components are gone from main
- [x] `?variant=A|B|C` has no visible effect
- [x] The `prototype/ticket-details` branch still holds the full prototype for reference
- [x] Full test suite, typecheck, and build clean

## Blocked by

03 — Tabbed Detail panel.

## Notes

- The deletion this ticket existed to do had already landed on main as b6288c5 ("ui: delete throwaway prototype sketches, unblocking typecheck"), made during ticket 03 after ticket 02 found the sketches were the only typecheck errors. So this attempt was verification, not deletion; no code change was left to make.
- Verified on main: no `variant`/`switcher`/`proto` reference anywhere in `ui/src` or `ui/index.html` (the one `URLSearchParams` in `client.ts:105` builds the `/api/log` query, unrelated); nothing reads `location.search`, so `?variant=A|B|C` is inert. `ui/src/prototype/` does not exist. The same check on the `pool/03` tip (504f313, ticket 03's unmerged work) is also clean, so the merge will not reintroduce anything.
- Verified on `prototype/ticket-details`: the full prototype survives there — `ui/src/prototype/switcher.ts`, `VariantA.ts`, `VariantB.ts`, `VariantC.ts`, plus its wiring in `main.ts`, `view.ts` and `styles.css`.
- Verified green on main: engine `bun test` 235 pass / 0 fail, engine `tsc --noEmit` clean; ui `bun test` 87 pass / 0 fail, ui `tsc --noEmit` clean, `vite build` clean.
