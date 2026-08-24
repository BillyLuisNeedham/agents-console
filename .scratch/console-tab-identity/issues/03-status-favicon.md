<!-- state: id=03 blocked-by=02 status=done -->

# 03 — Status favicon

Spec: `.scratch/console-tab-identity/spec-console-tab-identity.md`

## What to build

The Console's favicon becomes a plain colored dot in the pool's status color, so the tab strip is scannable by color alone: red for `needs input`, amber for `running`, green for `complete`, grey for `idle`. The dot is canvas-generated and served as a data URL on a single `link rel="icon"` element the UI creates and reuses; its `href` is replaced whenever the status color from ticket 02's projection changes. No asset files and no build-step wiring. The favicon and the title swap on the same snapshot cadence.

## Acceptance criteria

- [x] The favicon is a canvas-generated colored circle on a `link rel="icon"` element; no image assets are added
- [x] The dot's color always matches the status word in the title, on every applied snapshot
- [x] All four statuses render in their distinct colors, verified by opening a Console against a fixture pool in each state
- [x] The pre-snapshot boot state has a sensible favicon (the idle grey dot), not a missing or broken icon
- [x] `bun test` passes in both `engine/` and `ui/`, and both typecheck scripts pass

## Notes

- One reused `link rel="icon"` element is created at module scope in `ui/src/main.ts`; `setFavicon` draws a 32px canvas dot and swaps the href only when the color changes. `setSnapshot` calls it with `poolStatus(snapshot).color`, the same call that sets the title, so both swap on the same snapshot cadence. The idle grey dot is set at page load, before any snapshot.
- The four hexes moved to an exported `POOL_TAB_COLORS` in `ui/src/project.ts` so the boot dot reuses the idle color instead of duplicating the hex; `poolStatus` reads from it and the existing tests pin the values.
- Verified in headless chromium (raw CDP, pixel read back from the served data URL) against fixture pools: checkpoint marker with no store re-raises its interrupt (needs input, red); a done marker plus a checkpoint with `reviewApproved: true` (complete, green); a ready ticket on a `sleep` harness (running, amber), which crashes to needs input when the harness exits without marking done, proving the live swap with no reload; and a static-only server with no API for the boot state (title `Console`, idle grey dot). The engine never emits a quiescent snapshot with no interrupt (ticket 02's note), so idle is only reachable at boot; that is where its color was verified.
- The verification script lived at /tmp/opencode/verify-favicon.ts and is not committed; the spec's Testing Decisions keep DOM wiring out of the unit suite.

## Blocked by

- 02 — Pool status word in the tab title
