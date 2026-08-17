<!-- state: id=11 blocked-by=10 status=done -->

# 11 — Detail content: channels and raw state

## What to build

The Detail shows the selected node's channels in full (untruncated, unlike the card) and its slice of the raw state. Content comes from a new projection at the existing projection seam: node id in, detail view model out, reusing the existing per-node channel selection. The panel re-projects on every render, so it tracks the selected node live as the run streams: status flips and channel updates appear while the panel is open.

## Acceptance criteria

- [x] Detail shows the selected node's channels in full
- [x] Detail shows the node's slice of the raw state
- [x] Detail content comes from a new pure projection at the projection seam, pinned by seam tests (interrupted vs active vs visited node fixtures)
- [x] Panel tracks the selected node live as super-steps land
- [x] Cards still show only their truncated per-node channels; this ticket changes nothing on the cards

## Blocked by

- 10 — Detail panel skeleton

## Notes

- `projectDetail(nodeId, topology, run, interrupts)` is the new pure projection (project.ts): node id in, `DetailView` out (`name`, `status`, `channels`, `stateSlice`, `interrupt`). It reuses `nodeChannelsForCard` (per-node channel selection) and `projectInterruptForm` (interrupt form projection), and shares `resolveNodeStatus` with `projectNodeCards` so card and Detail status can never diverge.
- `projectNodeStateSlice(nodeId, raw)` returns the raw State values for the channels a node owns (via `NODE_CHANNELS`), keyed by channel name. The Detail renders it as pretty-printed JSON.
- Status computation was extracted out of `projectNodeCards` into `resolveNodeStatus`; card output is byte-for-byte unchanged (all 71 pre-existing tests still pass). Cards still truncate `pre`/`json` to 8 lines in `renderCardChannel`; the Detail renders `pre`/`json` in full via `renderDetailChannel`.
- Selection stays in `view.ts` (module scope, per the spec's implementation decision). `main.ts` mirrors it through the existing `onSelectNode` callback into `state.selectedNodeId`, which `model()` uses to project `detail` at the seam. The detail re-projects on every render, so status flips and channel updates appear live while the panel is open.
- The Detail does not yet render the interrupt form; the view model carries `interrupt` for issue 12 to wire the form.
- Seam tests: 8 new (`projectDetail` x6, `projectNodeStateSlice` x2), 79 total pass. `tsc --noEmit` and `vite build` clean. Verified against the live dev server with `.scratch/console/verify-11.ts` (interrupted/ran status, full 24-line spec vs 8-line truncation, no unrelated-channel leak, status transition across a resume).
