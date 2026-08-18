<!-- state: id=07 blocked-by=01 status=ready -->

# 07 — Server and pool projection UI

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The Console re-pointed at the pool engine. One Bun process per pool serves the built SPA, a small JSON API (get state, start, resume-with-answer), and an SSE stream that pushes a full state snapshot on every change. The UI keeps its existing canvas, node cards, Detail panel, drawer, and styles, but the LangGraph client and projection are deleted and replaced with a pool projection: each ticket is a card, blocked-by entries are edges, and the fixed machinery (start, final Review) appears as small utility cards at the ends. Card status mirrors the ticket's marker status. Canvas interactions (pan, zoom, drag, edge-routing toggle, persisted positions) keep working unchanged. The thread-driving UI leaves the main path.

## Acceptance criteria

- [ ] One Bun process serves the built SPA, the JSON API, and the SSE snapshot stream for one pool
- [ ] Every state change pushes a full snapshot over SSE; the UI renders from snapshots only
- [ ] Each ticket renders as a card with edges drawn from its blocked-by list
- [ ] Card status mirrors the line-1 marker status live as the run progresses
- [ ] Start and Review machinery appear as small utility cards, visually distinct from ticket cards
- [ ] Pan, zoom, drag, edge-routing toggle, and persisted positions all work unchanged
- [ ] The LangGraph client, thread list, and thread projection are gone from the main path
- [ ] Pool projection is covered by pure-function tests over snapshot fixtures, following the existing projection-test precedent

## Blocked by

- 01 — Pool engine walking skeleton
