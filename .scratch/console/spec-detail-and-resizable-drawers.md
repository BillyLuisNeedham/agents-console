# Spec: Detail panel and resizable drawers

## Problem Statement

When Billy drives a thread in the Console, the node cards on the canvas are the only window into what a node is doing. A card is small: its channels are truncated, its interrupt form is cramped, and there is nowhere to read the full picture of a single node. He wants to click a card and have a right-hand panel come in that tells him "here is what is going on here", with room to read and to act.

Separately, the bottom strip holding the log and state drawers is a fixed height. When the state inspector is open its contents are smushed into a shallow band, and there is no way to pull it taller.

## Solution

Clicking a node card opens the Detail: a right-hand panel for the selected node, sitting beside the canvas the way the thread rail sits on the left. The Detail shows the node's name, status, channels in full, its slice of the raw state, and its pending interrupt if it has one. The Detail is interactive: an interrupt can be answered from the panel, not only inline in the card. Both surfaces stay live. Clicking another card swaps the Detail to that node; the panel tracks the selected node as the run streams.

The bottom drawers strip gains a drag handle on its top edge. Dragging it up makes the log and state drawers taller; dragging down makes them shorter, within sensible bounds.

## User Stories

1. As Billy, I want to click a node card so that a Detail panel opens for that node.
2. As Billy, I want the Detail to show the node's name, so that I know what I am looking at.
3. As Billy, I want the Detail to show the node's status (idle, ran, active, next, interrupted), so that I can see where the run is.
4. As Billy, I want the Detail to show the node's channels in full, so that I am not reading truncated card content.
5. As Billy, I want the Detail to show the node's slice of the raw state, so that I can inspect exactly what the run knows.
6. As Billy, I want the Detail to show the node's pending interrupt form when one exists, so that I can see what the run is waiting on.
7. As Billy, I want to answer an interrupt from the Detail, so that I have room to read the spec, tickets or deadlock before deciding.
8. As Billy, I want the card's inline interrupt form to stay in place, so that interrupted nodes remain visible on the canvas even when not selected.
9. As Billy, I want an answer given in the Detail and the card's inline form to be the same action, so that the run resumes once regardless of where I answered.
10. As Billy, I want to click a different card so that the Detail swaps to that node.
11. As Billy, I want to close the Detail with a close button, so that I can get the canvas back.
12. As Billy, I want clicking the already-selected card to close the Detail, so that dismissing it does not require aiming at a small button.
13. As Billy, I want the Detail to track the selected node as the run streams, so that I can watch its status and channels change live.
14. As Billy, I want clicking a ticket card to keep its current expand behaviour, so that the new click handling does not regress tickets.
15. As Billy, I want dragging a card to still move it, so that a drag is never mistaken for a click.
16. As Billy, I want the Detail to push the canvas aside rather than cover it, so that I never lose sight of the graph.
17. As Billy, I want to drag the top edge of the bottom drawers strip upward, so that the log and state drawers get taller.
18. As Billy, I want to drag the edge downward, so that I can shrink the drawers when I want more canvas.
19. As Billy, I want one shared height for the log and state drawers, so that there is one handle and no per-drawer fiddling.
20. As Billy, I want the drawers height bounded, so that I can never smush the canvas to nothing or collapse the drawers strip entirely.
21. As Billy, I want the drawers height to survive re-renders while I work, so that streaming updates do not snap it back.
22. As Billy, I want the Detail's selection to survive re-renders, so that streaming updates do not close the panel or lose my place.

## Implementation Decisions

- The Detail is a third flex child of the content row, after the main canvas area, following the fixed-width rail precedent. No overlay, no transform animation.
- Selection state (the selected node id, or none) lives at module scope in the view layer and is reapplied after each full-DOM rebuild, per the established pattern for canvas interaction state.
- Click detection reuses the existing sub-4px press-release check in the drag-end handler, extended from ticket cards to graph node cards. A drag still moves the card; a press-release selects it. Interactive elements inside cards keep their guard.
- The Detail's content is a new projection at the existing projection seam: node id in, detail view model out (name, status, full channels, raw state slice, interrupt form view). It reuses the existing per-node channel selection and interrupt form projection.
- The interrupt form in the Detail is the same view and the same handlers as the card's inline form. Answering from either place calls the same resume path; the next stream update clears both.
- Clicking another card replaces the selection. Clicking the selected card or the close button clears it.
- The drawers strip gets a drag handle on its top border. Pointer movement maps to a shared height applied to both drawer bodies, replacing the fixed 32vh heights.
- The height is clamped to a minimum of 15vh and a maximum of 80vh. The clamp is a pure function.
- The height lives at module scope for the session only. Nothing is written to localStorage.
- The unimported VariantC spike is the reference for how a node Detail and a bottom drawer can look and behave. The production implementation follows the current view-layer patterns, not the spike's parallel data layer.
- Stack unchanged: vanilla TypeScript, Vite, bun. No UI framework, no new runtime dependencies. No backend changes.

## Testing Decisions

- A good test exercises external behaviour through the projection seam: fixtures in, view model out. No DOM, no SDK calls, no implementation details.
- The Detail projection is tested in the existing projection test file, alongside the 68 tests already pinning the seam: a thread fixture with an interrupted node projects a detail view model carrying the full channels and the interrupt form view; a node with no interrupt projects none; selection of a visited versus active node projects the right status.
- The drawers height clamp is tested as a pure function: below minimum clamps to minimum, above maximum clamps to maximum, inside the range passes through.
- DOM-level behaviour (press-release selects, drag still drags, the handle resizes, the panel tracks a live stream) is verified against the live dev server with a verify script, following the verify-02 through verify-07 precedent.

## Out of Scope

- Per-node logs. The run has one shared log channel; associating lines with nodes is not part of this spec.
- Checkpoint history, time travel, thread forking. Still deferred, per the parent spec.
- Persisting the drawers height or the Detail selection across sessions.
- Removing or restyling the card's inline interrupt form.
- Splitting or otherwise restructuring the view module. Recorded as deferred work in the final review; not part of this spec.
- Backend or graph changes of any kind.

## Further Notes

- The parent spec lives as GitHub issue #1 on BillyLuisNeedham/agents-console. This spec is the local successor for the next iteration and may be published there later at Billy's discretion.
- The VariantC spike remains unimported. It is a reference, not a dependency.
