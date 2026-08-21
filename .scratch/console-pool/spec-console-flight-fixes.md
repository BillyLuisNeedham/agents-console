# Spec: Console proving-flight fixes

Status: agreed in grill session, written locally (no tracker). Apply `ready-for-agent` if published later.

Follow-up to `spec-ticket-pools.md`, from Billy's first proving flight of `my-console-runner` on this pool.

## Problem Statement

Billy ran `/my-console-runner` on the real console-pool and watched the Console drive it. Four things were wrong:

1. Clicking the start and review cards opens the right-hand Detail panel, but clicking a ticket card — including the checkpoint card carrying the Brief he needed to answer — does nothing to the Detail panel. The full-size view of a ticket is unreachable.
2. While the Console sits open, a "pool stream disconnected" error flashes on the top bar roughly every ten seconds for about two seconds, even though nothing is wrong. A quiet pool looks like a broken pool.
3. With many cards on the canvas it isn't obvious which card flows to which. The blocked-by edges are drawn, but tracing a card's inflow and outflow by eye across a busy canvas is work.
4. The my-console-runner skill only launches on Linux: its browser-open and server-detach commands don't exist on a Mac, and Billy wants the skill to work on both.

## Solution

Every card click opens the Detail panel — the card itself stays a summary; the right-hand panel is where a ticket is read and its interrupt answered.

The pool stream stays connected while the pool is quiet, and a brief network blip never flashes an error; the banner appears only when the stream has genuinely been down for a few seconds, and clears itself on reconnect.

Selecting a card lights up its flow neighbourhood: the cards that flow into it and the cards it flows out to change colour, inflow and outflow in slightly different colours, with the connecting edges recoloured to match — so one click answers "what feeds this, and what does it feed?"

The my-console-runner skill picks its browser opener and detach mechanism per platform, so the same skill launches a pool on a Mac and on Linux.

## User Stories

Detail on every card:

1. As Billy, I want clicking any ticket card to open its Detail panel, so that I can read a ticket's status, channels, and pending interrupt at full size no matter its status.
2. As Billy, I want the checkpoint card's Detail to open when I click it, so that the Brief a checkpoint exists to show me is actually reachable.
3. As Billy, I want clicking a done or in-progress card to open Detail too, so that finished and running work is inspectable the same way as stopped work.
4. As Billy, I want clicking the already-selected card to close the Detail, so that the panel toggles the way the utility cards already do.
5. As Billy, I want card clicks to drive the right-hand panel only — not an inline expansion on the card — because I will always read and answer in the Detail, never type on the card.

A stream that doesn't cry wolf:

6. As Billy, I want the pool stream to stay connected while the pool waits at an interrupt or sits done, so that a healthy quiet pool never reports itself disconnected.
7. As Billy, I want a momentary stream blip to recover silently, so that a reconnect inside a few seconds costs me no attention.
8. As Billy, I want the error banner to appear only if the stream has stayed down for several seconds, so that when I see it, it means something.
9. As Billy, I want the banner to clear itself when the stream reconnects, so that the top bar returns to truth without me doing anything.
10. As Billy, I want the top bar's connection label to say connecting while the stream is down, so that the bar never claims "connected" underneath an error.

Legible flow:

11. As Billy, I want the card I select to get a clear selected ring, so that I always know which card the neighbourhood belongs to.
12. As Billy, I want the selected card's inflow cards to change colour, so that I can see at a glance what must finish before it.
13. As Billy, I want the selected card's outflow cards to change to a slightly different colour than the inflow, so that upstream and downstream are never confused.
14. As Billy, I want the edges touching the selected card recoloured to match their direction, so that the connectors agree with the cards they join.
15. As Billy, I want only the immediate neighbours highlighted — one hop, not the whole dependency cone — so that selecting a card in a chain doesn't light up the whole canvas.
16. As Billy, I want the start and review cards to participate in highlighting, so that blockerless tickets show start as inflow and every ticket shows review as outflow, matching the edges already drawn.
17. As Billy, I want a highlighted done card to lose its faded look, so that the highlight is actually visible on finished work.
18. As Billy, I want clearing the selection to remove every highlight, so that the canvas returns to its resting state cleanly.
19. As Billy, I want the highlight to survive live snapshots while the pool runs, so that a status change mid-run doesn't strip the neighbourhood I'm reading.

One skill, two platforms:

20. As Billy, I want the skill to open the browser with `open` on a Mac and `xdg-open` on Linux, so that the proving flight's final step works on whichever machine I'm on.
21. As Billy, I want the skill to detach the server portably, so that the launch flow doesn't depend on Linux-only commands.
22. As Billy, I want the generated copies of the skill refreshed from the single source, so that no stub or copy keeps the old Linux-only text.

## Implementation Decisions

- **Card click = Detail, for every card.** The click handler's split routing — ticket cards toggling an inline expansion, only utility cards selecting — is a leftover from the thread-driven Console. Selection now applies to every card: a click selects (and re-click clears), which opens the Detail. The inline card expansion is retired: the Detail is the single place a ticket is read and its interrupt answered. The pool-era projection and Detail renderer already handle ticket cards fully, so this is a wiring change at the click handler, not new rendering.
- **Stream drops fixed at the source.** The Bun server's default idle timeout closes any connection silent for ten seconds, and the SSE stream is silent whenever the pool waits at an interrupt — the Console's normal state. The stream route opts out of the idle timeout (Bun's documented per-request mechanism for SSE), scoped to that route only; the JSON and static routes keep the default. No heartbeat frames: unnecessary once the timeout is off.
- **Client grace before the banner.** A stream error marks the connection as down immediately (so the top bar's label is honest) but the error banner is shown only if the stream is still down after a grace delay of about four seconds; a snapshot arriving inside the grace window cancels the banner and restores the connected state. Native EventSource reconnect and the server's replay-latest-on-connect already heal the gap — no reconnect machinery changes.
- **Flow neighbourhood derived from the projected edges.** A new pure derivation takes the projection's existing edge list and the selected card id and returns two sets — inflow (edge sources pointing at the selection) and outflow (edge targets the selection points at). One hop only: a transitive cone on a chained pool colours most of the canvas and destroys the at-a-glance value. Deriving from edges rather than ticket data means the start and review utility cards participate for free, matching the drawn topology exactly.
- **Highlight styling follows the existing ring idiom.** Three new card classes — selected, inflow, outflow — plus two edge classes, placed at the end of the stylesheet so they win over status and interrupt styles in source order, mirroring how the interrupt style already wins over status. Highlighted cards restore full opacity so a done neighbour isn't dimmed. Edge arrowheads keep the shared marker (per-edge marker colouring isn't worth it).
- **Colours.** Inflow = the existing accent blue; outflow = a Primer purple that sits with the existing GitHub-derived palette and collides with none of the status colours (amber running, green done, red interrupt, grey pending); selected = the accent at a heavier weight. The purple is added as a style token.
- **Skill portability.** Two lines in the skill's launch flow change: the browser-open becomes a platform branch on `uname` (`open` on Darwin, `xdg-open` otherwise), and the server-detach drops the Linux-only `setsid`, keeping `nohup … &`, which detaches portably and still captures the pid. These were the only two Linux-only commands in the skill. After the source edit, the link script refreshes the generated cursor copy; the opencode stub is a pointer and the symlinks follow the source, so no other copy needs touching.
- **Queue placement.** The work lands as tickets 12–15 appended to this pool: 12 ticket-card Detail, 13 stream fix, 14 flow highlighting, 15 skill portability. Ticket 14's click-routing change overlaps 12's — wire the blocked-by edges accordingly at ticket time. Ticket 10 stays at checkpoint until a fresh my-console-runner flight over this pool proves the skill end-to-end; ticket 11's blocked-by extends over 12–15 so the review pass still runs last (and keeps its noted job of flagging the pool AGENT.md's stale paths).
- **Ticket 15's honesty clause.** Its acceptance can only prove the platform branch exists and Linux still launches — the Mac half is proven the first time Billy runs the skill on a Mac.

## Testing Decisions

- Only external behavior is tested, never implementation details — same bar as the parent spec.
- **Projection seam (primary).** The neighbourhood derivation is pure and is tested at the established projection seam with snapshot/edge fixtures, following the prior art of the existing projection tests: upstream/downstream sets, empty sets, start/review participation, selection cleared.
- **Selection reducer.** The click-a-ticket-card-selects behavior is exercised through the existing selection-reducer tests rather than DOM tests.
- **Server seam.** A bun test starts the real pool server, connects to the stream route, and asserts the connection survives more than ten seconds of silence — the failure mode was reproduced empirically during diagnosis, so this test watches exactly it. Prior art: the engine's temp-pool tests.
- **Manually verified during the flight:** the grace banner (composition-root wiring, not worth a harness), the highlight colours (visual), and the skill's launch flow (smoke-proven, per ticket 10's precedent — with the Mac branch accepted as unprovable from Linux).

## Out of Scope

- Transitive dependency-cone highlighting (one hop only, deliberately).
- SSE heartbeat frames, reconnect backoff tuning, and permanent-outage detection beyond the grace banner.
- Per-edge arrowhead recolouring.
- Inline card expansion in any form — retired, not redesigned.
- The pool AGENT.md's stale paths — ticket 11's review owns that note.
- Push, pull requests, or any publishing — the standing line.
- Proving the Mac branch on Mac hardware from this Linux box.

## Further Notes

- Root causes, found by diagnosis subagents: the click split is a legacy branch from the thread-driven Console (pool-era selection code was already complete and tested behind it); the stream drop is Bun's documented ten-second default idle timeout, reproduced against the real server; the edges the highlight needs were already projected and drawn; the skill's stubs are generated, so the portability fix is single-source.
- This spec's proving flight doubles as ticket 10's missing acceptance criterion: running my-console-runner over the pool carrying tickets 12–15 is the end-to-end proof the skill closes on.
