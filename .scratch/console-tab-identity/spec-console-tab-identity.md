# Spec: Console tab identity

## Problem Statement

Every Console tab is titled `Console` and carries the browser's default icon. Billy runs several Consoles at once — one per Pool, sometimes the same codebase in multiple worktrees — and the browser tab strip gives him no way to tell them apart. To find the Console that needs him he has to click through every tab. Worse, nothing in the tab says a pool is waiting on a human, so a pool sitting at an interrupt looks identical to one happily running.

## Solution

The browser tab becomes the pool's at-a-glance identity and status:

- The tab title reads `{status} — {worktree}/{pool}`, e.g. `needs input — ai-agent-graphs-fix/tickets`. The name is the last two path segments of the pool directory, so two worktrees of the same repo running same-named pools still read differently.
- The favicon is a plain colored dot in the status color, so the tab strip is scannable by color alone: red when a pool needs input, amber while it is running, green when complete, grey when idle.
- Both update live as snapshots arrive; no reload, no polling beyond the existing SSE stream.

## User Stories

1. As Billy, I want each Console tab to name its pool, so that I can tell a dozen open Consoles apart without clicking through them.
2. As Billy, I want the name to include the worktree directory, so that two worktrees of the same repo running same-named pools are still distinguishable.
3. As Billy, I want the tab title to lead with the pool's status word, so that the most important fact is the first thing I read.
4. As Billy, I want the favicon to be a dot in the status color, so that I can scan the tab strip by color without reading any text.
5. As Billy, I want a pool waiting on an interrupt to read `needs input` in red, so that it calls out to me from the tab strip.
6. As Billy, I want a pool mid-run to read `running` in amber, so that I can see work in flight at a glance.
7. As Billy, I want a finished pool to read `complete` in green, so that I know its run ended cleanly.
8. As Billy, I want a pool with nothing in flight to read `idle` in grey, so that a quiet tab does not cry for attention.
9. As Billy, I want the title and favicon to update as the pool's state changes, so that the tab never lies about a pool that has moved on.
10. As Billy, I want a stalled pool (tickets exist, none can run, no interrupt pending) to read as needing input, so that a wedged pool never looks healthy.
11. As a future maintainer, I want the status rollup to be a pure projection over the snapshot, so that it is unit-testable without a browser.
12. As a future maintainer, I want the pool's display name to come from the server, so that the UI never re-derives path logic the server already owns.

## Implementation Decisions

- The status rollup is a pure projection in the UI's projection module, mapping a snapshot to one of four statuses. Worst-first: any pending interrupt, or the run phase being `stalled`, is **needs input** (red); otherwise the phase `running` is **running** (amber); otherwise the phase `done` is **complete** (green); anything else is **idle** (grey). `quiescent` always carries a pending interrupt, so it lands on needs input without a rule of its own.
- The title format is exactly `{status word} — {name}`: `needs input — ai-agent-graphs-fix/tickets`. The status word is lowercase. No ticket counts, no extra prefix.
- The name is the last two path segments of the pool directory (`<parent>/<basename>`), computed by the server and carried on the enriched snapshot as a new top-level field. The engine's own snapshot type is untouched; this is server-side enrichment alongside the existing ticket metadata enrichment.
- The document title is set on every snapshot the UI applies, and the favicon is swapped on the same cadence. Before the first snapshot arrives the static `<title>Console</title>` stands; there is no name to show yet and the moment is brief.
- The favicon is a canvas-generated colored circle served as a data URL on a `link rel="icon"` element the UI creates and reuses. No asset files, no build-step wiring. One element, its `href` replaced when the status color changes.
- Status colors: red, amber, green, grey. Exact hex values are the implementer's choice from the Console's existing palette where one fits.
- Nothing about the Console's in-page header changes. This spec covers the browser tab only.

## Testing Decisions

- Test external behavior only: the rollup's status word and color per snapshot shape, and the server's name enrichment per pool directory layout. Never test DOM wiring or canvas pixels.
- The rollup projection is unit-tested in the UI's existing projection test suite (`bun test` in `ui/`), which is the prior art for projection tests: feed snapshot shapes, assert the projected value.
- The server's name enrichment is covered in the engine's existing server test suite (`engine/server.test.ts`): point the server at pool directories with different path shapes and assert the field on the enriched snapshot.
- The title and favicon DOM effects are thin wiring around the projection and are not unit-tested; they are verified by opening a Console against a fixture pool.

## Out of Scope

- The in-page Console header and any other in-canvas status display.
- Per-pool custom names, emoji, or any user-configured title format.
- Ticket counts or per-ticket detail in the title.
- Browser notifications, sounds, or any attention channel beyond the tab itself.
- The Fleet registry and any fleet-level listing UI.

## Further Notes

- Agreed in the grill: status first in the title, favicon is the status and nothing else, last-two-segments naming with no fallback logic, four statuses with the exact rollup above.
- The pool directory for a worktree console reads naturally under this rule: `<worktree-dir>/<pool-dir>`. Pools living under `.scratch/` read as `.scratch/<pool-dir>`, which is still unique per pool and was accepted as the trade for zero configuration.
