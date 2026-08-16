<!-- state: id=04 blocked-by=02 status=ready -->

# 04 — Graph canvas: node cards, edges, live highlighting

## What to build

The graph-centric canvas. Topology is fetched from `client.assistants.getGraph(assistantId)` and rendered with a simple layered layout: one card per node, edges between them. Each node card shows only the state channels relevant to that node (e.g. the approveSpec card shows the spec; the deadlockGate card shows pending tickets and hint; the review card shows the ticket summary). Currently-running and next nodes are highlighted, driven by the `updates` stream. Replaces the plain list from the walking skeleton.

## Acceptance criteria

- [ ] Canvas renders the real graph topology from the dev server, not a hardcoded copy
- [ ] Each node card shows only its relevant channels
- [ ] Running and next nodes highlight live as `updates` events arrive
- [ ] The plain state list from ticket 1 is gone

## Blocked by

- 02 — Live streaming
