<!-- state: id=03 blocked-by=01,02 status=done -->

# 03 — Tabbed Detail panel

Spec: GitHub issue #15 (BillyLuisNeedham/agents-console). Prototype reference: branch `prototype/ticket-details`, Variant A "Phase tabs" — the design winner, chosen by clicking through three variants against a live pool. Rewrite it properly; do not promote prototype code verbatim.

## What to build

Clicking a ticket card in the Console opens a Detail whose body is three tabs — **Spec / Progress / Outcome** — replacing the current single-stack ticket Detail entirely (no feature flag, no fallback; the Detail header with title/fullscreen/close and the utility-card Details are unchanged).

**Spec** shows the ticket's markdown body rendered with `marked` (new ui dependency), preceded by a dim `blocked by X, Y` / `no blockers` line. **Progress** shows the status, the existing interrupt form component unchanged (the only action surface), and the existing timeline section with full attempt-row → log-pane behavior (clicking an attempt row opens that attempt's raw log, exactly as today's Detail). **Outcome** shows the outcome summary and commit sha; before the ticket finishes it stays visible with a dim "not finished yet" placeholder so the tab bar never reshapes.

The default tab comes from the projection built in ticket 02; a pending interrupt also puts a red dot on the Progress tab, mirroring the canvas card's interrupt dot. The ticket body is fetched via the endpoint from ticket 01: fetched once per ticket on first selection, cached in memory for the session (null cached for known-missing), and a late response never clobbers a newer selection (mirror the guard the timeline/log fetches use). Tab state lives in memory only — no URL state, no persistence.

## Acceptance criteria

- [x] The ticket Detail body is the Spec / Progress / Outcome tab bar; the old stacked layout is gone
- [x] Spec renders the ticket body as markdown (headings, lists, code blocks) with a dim blockers line above it
- [x] Progress carries the interrupt form and the timeline; attempt rows still open raw logs in the log pane
- [x] Outcome shows summary + commit sha, or a dim placeholder before the ticket finishes
- [x] Default tab follows the ticket-02 projection; manual choice is remembered per ticket and resets on ticket change
- [x] A pending interrupt adds a red dot to the Progress tab
- [x] The body is fetched once per ticket and cached; a slow fetch never clobbers a newer selection
- [x] Full test suite, typecheck, and build clean

## Blocked by

01 — Ticket body endpoint; 02 — Tab-default projection.

## Notes

- Infra collision (proven): worktree and branch names are shared across pools by ticket id (`pool/<id>` under `.git/pool-worktrees/`). The arch-review pool's engine merged its own ticket 03 into `arch/cleanup` at ~21:27 and deleted the shared `pool/03` branch and the worktree this attempt was spawned in, minutes after spawn. No ticket-03 work was lost (none had been written). I recreated `.git/pool-worktrees/03` as a fresh `pool/03` branched from `main` (8b83e92, which carries tickets 01 and 02) and continued there. Risk of a repeat is low: the arch-review ticket 03 is merged, so its engine will not touch `pool/03` again.
- Decisions the Issue left open, settled here:
  - The never-run spec fallback in the old stacked Detail (`renderNeverRun`, fed by the events endpoint's `spec` field) was deleted: the Spec tab owns the ticket body now, and a never-run ticket's Progress tab shows the timeline's own "no attempts yet" marker. The now-dead `spec` threading (`LogPaneView.spec`, the `projectLogPane` spec parameter, `timelineState.spec`) was removed with it; the events endpoint's wire field is untouched.
  - Tab memory keeps ticket 02's single-`TabOverride` design: a choice made on ticket A survives viewing ticket B and returning to A, but choosing a tab on B replaces it. That is the semantics the projection documents and tests; the criterion's "remembered per ticket, resets on ticket change" reads onto it.
  - A failed body fetch (not a 404) caches nothing, records a `ticket body fetch failed: ...` line shown on the Spec tab (mirroring how the log fetches surface errors), and retries on the next selection. 404 still caches null for the session.
  - `marked` output is assigned to innerHTML unsanitised: the bodies are the pool's own Issue files, served same-origin. A pool that ever renders third-party markdown needs a sanitiser; noted in `ticketBodyHtml`'s doc comment.
- Review (two-axis, per the implement flow): no hard standards violations; the spec axis's two real findings (swallowed fetch error, dead spec threading) are fixed above. Findings deliberately not acted on: per-ticket tab memory as a Map (contradicts ticket 02's documented design) and a sanitiser dependency (not asked for; trust note above).

## Resume note

can you try again
