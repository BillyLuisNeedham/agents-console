# Terminal-backed attempts are reachable from the Console

Closes issue #29 (UI surface). Decision record: ADR-0014 (`docs/adr/0014-attempts-terminal-backed-in-herdr.md`) — this spec settles the UI-surface question ADR-0014 explicitly deferred, using the throwaway prototype at `prototype/console-terminal-surface/` plus prototype variant T (`?termproto=1`) as evidence. Surface A ("open in herdr", card-native) won; the embedded xterm.js surface (B) was rejected on fidelity grounds (see Further Notes).

## Problem Statement

When a pool runs with `terminal: herdr`, every attempt lives in a real terminal the operator could watch and type into — but the Console gives no way to reach it. The operator sees cards moving through the graph while the actual terminals sit anonymous in the herdr TUI: no indication of which pane belongs to which ticket, no way to jump to one without hunting through tabs by hand, and no glanceable sign of life on the card itself. The North Star — each agent is an interactable terminal — is engine-ready but operator-invisible.

## Solution

A Terminal-backed attempt's Console card carries a small terminal surface: a read-only peek of the pane's recent output, an "Open in herdr" button that jumps the herdr TUI straight to the attempt, and a copyable `herdr agent attach` command as the CLI escape hatch. On the herdr side, each attempt no longer hides in an anonymous split: it gets its own **tab named after the ticket** (`<ticket-id> · <ticket-title>`), created unfocused, so the operator's terminal reads like a row of named workstations. Watching stays in the Console; typing happens in herdr — the card makes the relationship explicit rather than trying to embed a terminal in the page.

## User Stories

1. As the pool operator, I want each running attempt's card to show a live peek of its terminal output, so that I can tell at a glance whether an agent is working, stuck, or waiting.
2. As the pool operator, I want the peek to be read-only and non-interactive, so that I never mistake a card for a terminal and accidentally type into a stale snapshot.
3. As the pool operator, I want an "Open in herdr" button on each terminal-backed attempt card, so that one click takes me to the real terminal when I want to interact.
4. As the pool operator, I want clicking "Open in herdr" to focus the attempt's tab in my herdr TUI, so that I land exactly where the agent is running without hunting.
5. As the pool operator, I want a copyable `herdr agent attach <pane_id>` command on the card, so that I have a scriptable, terminal-native path to the same place.
6. As the pool operator, I want each attempt to live in its own herdr tab named after its ticket, so that my terminal's tab bar reads as a list of tickets in flight.
7. As the pool operator, I want attempt tabs created without stealing focus, so that a spawning ticket never yanks my terminal away from what I'm doing.
8. As the pool operator, I want attempt tabs named `<ticket-id> · <ticket-title>`, so that the mapping from tab to ticket is obvious without memorising ids.
9. As the pool operator, I want the terminal surface to appear only on attempts that are actually terminal-backed, so that headless attempts never show dead affordances.
10. As the pool operator, I want the peek to keep refreshing while the attempt runs, so that the card stays a trustworthy liveness signal.
11. As the pool operator, I want the surface to degrade gracefully when the pane is gone or unreadable, so that a crashed attempt shows "pane unavailable" rather than a broken card.
12. As the pool operator, I want Console terminal controls to refuse to act on panes the pool didn't spawn, so that a UI bug can never type into or focus an unrelated live agent session sharing my herdr daemon.
13. As the pool operator, I want the card's terminal buttons to never trigger canvas drag, so that clicking "Open in herdr" doesn't rearrange my graph.
14. As a ticket agent, I want my attempt's terminal naming and lifecycle unchanged by the Console surface, so that the engine's ADR-0014 contract (exit + Outcome ends the attempt, operator input is oblivious to the engine) holds exactly.
15. As a maintainer, I want the pane id to reach the card through the existing snapshot-enrichment seam, so that no new state channel appears between engine and UI.
16. As a maintainer, I want the Console server to own all herdr socket traffic for this feature, so that the UI keeps its single-server, same-origin topology and never learns herdr's wire protocol.
17. As a maintainer, I want the prototype's herdr quirks (revision stagnation, background-tab warm-up, paste semantics) recorded as decisions, so that the real implementation doesn't rediscover them by debugging.

## Implementation Decisions

- **Pane id flows through the existing enrichment seam.** The `spawned` event records the `pane_id` (ADR-0014); the pool server enriches each ticket's snapshot entry with the current attempt's `paneId`, and the card projection carries it to the card. No new engine→UI channel; the Console UI continues to talk only to its pool server, same-origin, no CORS.
- **Each attempt gets a named herdr tab, not a split.** Attempt creation uses herdr's `tab.create` with `label` = `<ticket-id> · <ticket-title>` (truncated to ~40 chars), `focus: false`, `cwd` = the attempt's worktree. This refines ADR-0014's "pane created via socket API, always focus:false": the unit is a whole tab so the tab bar is the ticket roster. The new pane id is recovered from `pane.list` filtered by the returned tab id (`tab_created` carries no root pane id — prototype finding).
- **Two new pool-server endpoints**, keyed by ticket id, both proxied to the herdr socket by the engine-side server:
  - **peek**: `pane.read` with source `recent`, `strip_ansi: true`, a small line count (~6–8), returning text for the card's read-only preview.
  - **focus**: `pane.focus` on the attempt's pane, used by "Open in herdr".
- **Spawned-only guard.** Both endpoints refuse any pane id not recorded in this pool run's `spawned` events. Live agent sessions share the herdr daemon; the Console must be structurally incapable of focusing or reading an unrelated pane. (Prototype enforced this with a per-process Set and a 403; the real implementation derives the allowlist from pool state.)
- **Card surface is append-only decoration.** Peek (a dim, `pointer-events: none` `<pre>`), the focus button, and the attach chip are appended to the ticket card body on cards whose attempt is terminal-backed and running. Card action buttons are already excluded from canvas drag; no canvas changes needed. The peek polls the pool server's peek endpoint on a slow interval (~2s) and stops when the attempt ends.
- **Diff on text, not revision.** The prototype verified `pane.read`'s `revision` does not advance reliably (stays 0 while output grows). Peek freshness comes from re-polling and comparing text; nothing in the design depends on `revision`.
- **No input path in the Console.** Typing happens in herdr. The prototype verified input is *possible* (`pane.send_input`, printable text + `keys: ["Enter"]` — a literal `\r` in text does not submit, bracketed-paste semantics) but this spec deliberately ships no Console input, keeping the engine-oblivious-to-operator-input contract crisp.
- **Graceful degradation.** If the peek read fails or the pane is unknown, the card shows a "pane unavailable" line in place of the peek; the focus button disables. Background-tab reads can return empty for the first seconds after tab creation (herdr warms up viewports lazily — prototype finding); the card treats empty as "waiting for output", not an error.

## Testing Decisions

Good tests here assert external behaviour at the existing seams: snapshot enrichment, HTTP endpoints, and card projection — never DOM minutiae or socket internals.

- **Enrichment**: a `spawned` event carrying a `pane_id` results in the ticket's enriched snapshot entry exposing `paneId` (prior art: the assignment enrichment tests added under ADR-0013, engine `*.test.ts` via `bun test`).
- **Terminal endpoints**: the peek and focus endpoints translate ticket id → recorded pane id and issue the right herdr socket calls, tested against a fake herdr unix socket speaking newline-delimited JSON (prior art: engine spawn/worktree tests with faked externals). The spawned-only guard is the headline test: an endpoint asked about a foreign pane id refuses.
- **Projection**: `TicketCardView` carries `paneId` through for terminal-backed attempts and omits it for headless ones (prior art: existing project/canvas projection tests in `ui/`).
- **Tab naming**: attempt creation calls `tab.create` with the ticket-derived label and `focus: false` (asserted against the fake socket's recorded requests).

## Out of Scope

- **The embedded xterm.js terminal (surface B)** — rejected, see Further Notes.
- **Console-side terminal input** — verified feasible, deliberately not shipped.
- **Pane lifecycle, reconciliation, exit detection, stream teeing** — locked by ADR-0014, unchanged except the tab refinement above.
- **Closing attempt tabs after merge** — ADR-0014's "exited panes persist until merge, then closed" applies; tab close is the same operation on the tab's panes.
- **Headless (non-`terminal: herdr`) pools** — no surface, no behaviour change.
- **WebSocket/SSE protocol changes** — the existing snapshot stream carries the enrichment.

## Further Notes

- **Why surface B lost.** `pane.read` (any source, any format) returns scraped text plus SGR colour only — no cursor-motion, alternate-screen, or OSC sequences. Line-output agents render acceptably (the prototype's embedded terminal worked), but a full-screen TUI harness — the very agents this feature exists for — cannot be faithfully embedded; the result is a smear of repaints, not a terminal. Combined with per-keystroke HTTP round trips and a 10 MB scrollback cap, embedding is a fidelity trap. `pane.focus` is one JSON-RPC call with perfect fidelity because herdr owns the real PTY.
- **Prototype artefacts** (throwaway, not for merge to main): standalone bridge + both surfaces in `prototype/console-terminal-surface/` (README documents endpoints and quirks), and variant T on the real Console UI behind `?termproto=1` (`ui/src/prototype/variant-t.ts`, gated in `ui/src/prototype/index.ts`). Demo: `bun prototype/console-terminal-surface/server.ts` → `http://localhost:5299/?surface=a|b`, and the in-context UI on the vite dev server with `?termproto=1&demo=1`.
- **herdr quirks the implementation must bake in** (all verified live against herdr 0.8.2): one request per socket connection; `revision` stagnant — diff on text; `\r` in `send_text` does not submit; background tabs return empty reads until warmed; `tab.create` returns no root pane id — recover it via `pane.list` by tab id.
- **ADR-0014 amendment**: the attempt-terminal unit changed from "pane" to "named tab per attempt". Record this in ADR-0014 (or a follow-up ADR) when the spec lands.
