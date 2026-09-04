# Ticket Card Vitals

Closes #25. Decided by grilling 2026-09-03 after the prototype on branch
`25-agent-activity-visualization` (Variant A won; Variants B and C rejected).
Glossary term: **Vitals** (CONTEXT.md). Architectural shape recorded in
ADR 0010 (vitals are client-polled worktree/log reads, not engine events).

## Problem Statement

When a ticket's attempt is running, Billy has no idea whether the agent is
actually doing anything. Agents can go long stretches without writing to their
attempt log, and opening the ticket log to check is exactly the effort the
Console exists to remove. He wants ambient confidence that the agent is moving
— visible at a glance on the canvas, without opening anything.

## Solution

Every ticket card with a live attempt shows **Vitals**: a compact footer with
the attempt's worktree diff totals (`+128 −34 · 6 files`), how long ago
something observable last happened (`changed 4s ago` / `output 12s ago`, or
`idle 1m 12s` after a minute of silence), and a small sparkline of diff-total
history so movement over the last ~80 seconds is visible as a trend, not just a
number. Checkpointed tickets keep their last-known Vitals, frozen and greyed,
so there's context while answering the interrupt. Done and abandoned tickets
show nothing — the final diff is the merge.

## User Stories

1. As the Console operator, I want to see live diff totals on each running ticket card, so that I know the agent is producing changes without opening anything.
2. As the Console operator, I want to see how many files the attempt has touched, so that I can gauge the shape of the change at a glance.
3. As the Console operator, I want a "changed Xs ago" readout, so that I can tell fresh movement from a stale number.
4. As the Console operator, I want attempt-log output to also count as life ("output Xs ago"), so that an agent that is thinking and printing doesn't read as dead.
5. As the Console operator, I want an explicit "idle Xm Ys" state after a minute of silence, shown in the interrupt color, so that a stuck agent draws my eye.
6. As the Console operator, I want a sparkline of recent diff-total history, so that I can see whether the agent is steadily moving, bursty, or flat.
7. As the Console operator, I want Vitals on a card whose attempt is running, and only there, so that the canvas stays quiet for tickets with nothing live.
8. As the Console operator, I want a checkpointed ticket to keep its last-known Vitals, frozen and greyed ("paused · changed 3m ago"), so that I have context about the work while I answer its interrupt.
9. As the Console operator, I want merge-resolver runs on checkpointed tickets to show live Vitals, so that I can see conflict resolution progressing.
10. As the Console operator, I want done and abandoned tickets to show no Vitals, so that finished work carries no noise.
11. As the Console operator, I want no Vitals flash between a card going in-progress and the first data arriving, so that empty chrome never appears.
12. As the Console operator, I want untracked new files to count toward the diff, so that an agent scaffolding new modules reads as productive.
13. As the Console operator, I want Vitals for an attempt running in the main checkout (solo attempt, no worktree), shown the same way, so that solo work is as visible as worktree work.
14. As the Console operator, I want Vitals to survive the canvas's full-DOM rebuild on every snapshot, so that they don't flicker or vanish when the pool state changes.
15. As the Console operator, I want Vitals to keep ticking while the pool waits at an interrupt and the snapshot stream is silent, so that staleness is honest wall-clock time.
16. As the Console operator, I want the sparkline rebuilt from live polling after a Console reload, accepting a short empty window, so that no server state is needed for a cosmetic trend.
17. As the Console operator, I want Vitals polling to stop when no card has a live attempt, so that an idle pool costs no git spawns.
18. As the Console operator, I want several running tickets each polled independently, so that one slow or huge worktree doesn't delay the others' freshness.

## Implementation Decisions

- **Endpoint**: the engine server serves `GET /api/activity?ticket=<id>`, 404
  for unknown tickets. Response shape (from the prototype, decision-rich):

  ```ts
  type TicketActivityResponse = {
    ticketId: string;
    running: boolean;
    diff: { added: number; removed: number; files: string[] } | null;
    log: { size: number; mtime: string } | null;
    lastEventAt: string | null;
  };
  ```

- **Diff computation**: `git diff --numstat HEAD` in the attempt's worktree,
  plus untracked files line-counted by reading each (cap 100 files, 256KB per
  file). Binary/`-` numstat entries count as files without lines.
- **Ticket → worktree mapping**: `spawned` and `resolver` ticket events record
  `cwd`/`branch` in their payload (already implemented on the prototype
  branch); the endpoint resolves the latest attempt's worktree from these.
  Missing `cwd` (old events) yields `diff: null`, never an error.
- **Caching**: 1s TTL in-memory cache per ticket id on the server. No
  mtime-based invalidation in v1.
- **Staleness anchor**: the newest of `lastEventAt` and the attempt log's
  mtime. Copy: `changed Xs ago` when the event is newest, `output Xs ago` when
  the log is newest; over 60s of silence: `idle Xm Ys` in the interrupt color.
  10s/60s thresholds are named constants, hardcoded (no Setup config).
- **Client polling**: a client-side vitals store polls the endpoint every 2s
  for each ticket whose latest attempt is live (running, or checkpoint with a
  resolver in flight), and refetches on every SSE snapshot. Polling stops when
  nothing is live. One request per ticket per poll; no batching.
- **Rendering**: Vitals are part of the card's view model from the projection
  and render inside the card render — they survive the full-DOM rebuild like
  everything else. The prototype's post-render DOM injection is discarded.
- **Sparkline**: 48×14 SVG polyline of the diff total per poll sample, last 40
  samples (~80s), held in ephemeral client memory. Reload starts it empty.
- **Card states**: live Vitals on running attempts; frozen greyed Vitals
  (`paused · changed 3m ago`) on checkpoint cards without a live resolver;
  nothing on done/abandoned; nothing before the first payload arrives.
- **Main-checkout attempts**: diff shown exactly as for worktrees, unmarked.
- **Visual language**: `+added` in the ok color, `−removed` in the removed/
  interrupt-adjacent color, existing CSS tokens only; footer sits at the bottom
  of the card, always on running cards once data exists.
- **Glossary & ADR**: "Vitals" is in CONTEXT.md; ADR 0010 records why Vitals
  are client-polled rather than snapshot-driven. No other ADRs.

## Testing Decisions

Good tests here assert external behavior only: HTTP responses for the engine,
view-model output for the UI. No tests of git invocation internals, timer
scheduling, or DOM structure.

Two seams, both existing:

1. **Engine — the `/api/activity` HTTP seam.** Server-level tests against a
   fixture pool with a real temporary git worktree: diff totals with staged/
   unstaged/untracked mixes, the 100-file and 256KB caps, `diff: null` when no
   `cwd` is recorded, 404 on unknown ticket, log size/mtime present, cache
   returns the same payload within the TTL. Prior art: `engine/server.test.ts`
   (fixture pools, stub harnesses, real HTTP).
2. **UI — the projection seam.** The projection gains pure functions mapping
   (activity response, ticket status, now) to a card's vitals view data:
   live/frozen/hidden per status, staleness copy and idle threshold, "no
   changes yet" vs totals, frozen copy for checkpoint. Prior art:
   `ui/src/project.test.ts` (snapshot → view model assertions). Sparkline
   sampling (40-cap, push-per-poll) is a small pure reducer, same seam.

The polling timer, the fetch wiring, and the DOM footer itself are thin
infrastructure over these seams, matching how the log pane and needs-input
tray treat their snapshot-cadence fetches.

## Out of Scope

- Variant B (pool-level telemetry strip) and Variant C (Detail work feed) —
  rejected at the prototype verdict.
- Per-file diff rows anywhere; that is ticket-log territory.
- Changes to the Detail panel or the ticket log.
- Batched activity endpoint; per-ticket requests only.
- Server-persisted sparkline history; ephemeral client memory only.
- Walking worktree file mtimes for staleness.
- Marking or suppressing main-checkout diffs.
- Configurable thresholds, poll cadence, or sparkline size (no Setup keys).
- The prototype switcher, `?variant` gating, and demo mode — all discarded.

## Further Notes

- Prototype branch `25-agent-activity-visualization` (worktree
  `/home/billy/repos/agent-console-25`) contains the winning implementation to
  mine: `ui/src/prototype/variant-a.ts` (rendering, staleness copy, sparkline)
  and the server-side `readTicketActivity`/`computeActivityDiff`. Fold the
  backend in mostly as-is; re-express the frontend per the rendering decision.
- Per AGENTS.md, delete this file from the branch in a final commit before the
  PR; the spec lives on in git history and on issue #25.
- Local spec; not published to the tracker, no `ready-for-agent` label applied.
