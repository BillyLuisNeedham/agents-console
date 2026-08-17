<!-- state: id=10 blocked-by=none status=ready -->

# 10 — Detail panel skeleton

## What to build

Clicking a graph node card opens the Detail: a right-hand panel beside the canvas (flex sibling, following the rail precedent) showing the selected node's name and status. Clicking another card swaps the Detail to that node. Clicking the selected card again, or the close button, dismisses it. Selection lives at module scope and survives the full-DOM rebuild on every render, so streaming updates never close the panel or lose the selection. Click detection reuses the existing sub-4px press-release pattern: a drag still moves the card, a press-release selects it. Ticket-card click-to-expand keeps working unchanged.

## Acceptance criteria

- [ ] Clicking a node card opens the Detail panel with the node's name and status
- [ ] Clicking another card swaps the Detail to that node
- [ ] Clicking the selected card or the close button dismisses the Detail
- [ ] Selection survives re-renders while the run streams
- [ ] Dragging a card still moves it; a drag is never treated as a click
- [ ] Ticket-card expand behaviour unchanged
- [ ] Panel pushes the canvas aside; it never overlays it

## Blocked by

None — can start immediately
