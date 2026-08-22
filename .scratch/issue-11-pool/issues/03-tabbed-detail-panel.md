<!-- state: id=03 blocked-by=01,02 status=ready -->

# 03 — Tabbed Detail panel

Spec: GitHub issue #15 (BillyLuisNeedham/agents-console). Prototype reference: branch `prototype/ticket-details`, Variant A "Phase tabs" — the design winner, chosen by clicking through three variants against a live pool. Rewrite it properly; do not promote prototype code verbatim.

## What to build

Clicking a ticket card in the Console opens a Detail whose body is three tabs — **Spec / Progress / Outcome** — replacing the current single-stack ticket Detail entirely (no feature flag, no fallback; the Detail header with title/fullscreen/close and the utility-card Details are unchanged).

**Spec** shows the ticket's markdown body rendered with `marked` (new ui dependency), preceded by a dim `blocked by X, Y` / `no blockers` line. **Progress** shows the status, the existing interrupt form component unchanged (the only action surface), and the existing timeline section with full attempt-row → log-pane behavior (clicking an attempt row opens that attempt's raw log, exactly as today's Detail). **Outcome** shows the outcome summary and commit sha; before the ticket finishes it stays visible with a dim "not finished yet" placeholder so the tab bar never reshapes.

The default tab comes from the projection built in ticket 02; a pending interrupt also puts a red dot on the Progress tab, mirroring the canvas card's interrupt dot. The ticket body is fetched via the endpoint from ticket 01: fetched once per ticket on first selection, cached in memory for the session (null cached for known-missing), and a late response never clobbers a newer selection (mirror the guard the timeline/log fetches use). Tab state lives in memory only — no URL state, no persistence.

## Acceptance criteria

- [ ] The ticket Detail body is the Spec / Progress / Outcome tab bar; the old stacked layout is gone
- [ ] Spec renders the ticket body as markdown (headings, lists, code blocks) with a dim blockers line above it
- [ ] Progress carries the interrupt form and the timeline; attempt rows still open raw logs in the log pane
- [ ] Outcome shows summary + commit sha, or a dim placeholder before the ticket finishes
- [ ] Default tab follows the ticket-02 projection; manual choice is remembered per ticket and resets on ticket change
- [ ] A pending interrupt adds a red dot to the Progress tab
- [ ] The body is fetched once per ticket and cached; a slow fetch never clobbers a newer selection
- [ ] Full test suite, typecheck, and build clean

## Blocked by

01 — Ticket body endpoint; 02 — Tab-default projection.
