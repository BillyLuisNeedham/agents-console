<!-- state: id=08 blocked-by=01 status=done -->

# 08 — State inspector drawer

## What to build

A full state inspector in a second collapsible bottom drawer next to the log. Shows the complete thread state for learning purposes, updating live with the stream. Keeps full state off the node cards, which show only their relevant channels.

## Acceptance criteria

- [x] Inspector drawer shows complete thread state, collapsible
- [x] State updates live as super-steps land
- [x] Node cards still show only per-node channels

## Blocked by

- 01 — Walking skeleton

## Notes

- `projectChannels(run.values)` is already the complete-State projection (graph order, extras as JSON, `log` and `__` keys excluded). Inspector will render that; no new projection function.
- Live updates come free: `applyStreamPart` replaces `run.values` on each `values` part and `render()` rebuilds the DOM.
- Node cards stay on `projectNodeChannels` / `NODE_CHANNELS`. Inspector is a second consumer of the same snapshot, not a change to the cards.
- Layout: wrap log + inspector in a `.drawers` row so they sit next to each other, each independently collapsible. `align-items: flex-start` keeps the closed bar aligned with the open bar.
