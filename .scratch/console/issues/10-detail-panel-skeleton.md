<!-- state: id=10 blocked-by=none status=done -->

# 10 — Detail panel skeleton

## What to build

Clicking a graph node card opens the Detail: a right-hand panel beside the canvas (flex sibling, following the rail precedent) showing the selected node's name and status. Clicking another card swaps the Detail to that node. Clicking the selected card again, or the close button, dismisses it. Selection lives at module scope and survives the full-DOM rebuild on every render, so streaming updates never close the panel or lose the selection. Click detection reuses the existing sub-4px press-release pattern: a drag still moves the card, a press-release selects it. Ticket-card click-to-expand keeps working unchanged.

## Acceptance criteria

- [x] Clicking a node card opens the Detail panel with the node's name and status
- [x] Clicking another card swaps the Detail to that node
- [x] Clicking the selected card or the close button dismisses the Detail
- [x] Selection survives re-renders while the run streams
- [x] Dragging a card still moves it; a drag is never treated as a click
- [x] Ticket-card expand behaviour unchanged
- [x] Panel pushes the canvas aside; it never overlays it

## Blocked by

None — can start immediately

## Notes

- Selection (`selectedNodeId`) lives at module scope in `view.ts`, mirroring `nodePos`/`expandedTickets`. `renderDetail` re-reads it on every render, so the full-DOM rebuild on each stream part never closes the panel.
- Re-render on select is a new `Handlers.onSelectNode` that `main.ts` implements as a plain `render()`. `view.ts` stashes it in a module-scope `onSelectNode` so the module-level `endDrag` (also bound to `window` pointerup for out-of-viewport release) can reach it.
- Click routing is in `endDrag`: a press-release on a ticket card id still goes to `toggleTicketExpand`; any other node id goes to `selectNode`. A drag (`drag.moved`) never selects, preserving the existing sub-4px press-release rule.
- `nextNodeSelection(current, clicked)` is the one new pure function (project.ts), pinned by three unit tests (select, swap, dismiss). Issues 11/12 should extend `renderDetail`, which already receives `handlers` for the interrupt form's `onResume`.
- Verified against the live dev server with `.scratch/console/verify-10.ts` (topology, name/status per card, selection toggle, status change across a resume). `bun test` (71 pass), `tsc --noEmit`, and `vite build` all clean.
