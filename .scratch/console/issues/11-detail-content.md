<!-- state: id=11 blocked-by=10 status=ready -->

# 11 — Detail content: channels and raw state

## What to build

The Detail shows the selected node's channels in full (untruncated, unlike the card) and its slice of the raw state. Content comes from a new projection at the existing projection seam: node id in, detail view model out, reusing the existing per-node channel selection. The panel re-projects on every render, so it tracks the selected node live as the run streams: status flips and channel updates appear while the panel is open.

## Acceptance criteria

- [ ] Detail shows the selected node's channels in full
- [ ] Detail shows the node's slice of the raw state
- [ ] Detail content comes from a new pure projection at the projection seam, pinned by seam tests (interrupted vs active vs visited node fixtures)
- [ ] Panel tracks the selected node live as super-steps land
- [ ] Cards still show only their truncated per-node channels; this ticket changes nothing on the cards

## Blocked by

- 10 — Detail panel skeleton
