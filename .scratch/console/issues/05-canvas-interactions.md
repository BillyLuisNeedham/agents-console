<!-- state: id=05 blocked-by=04 status=done -->

# 05 — Canvas interactions (pan, zoom, drag, persistence)

## What to build

The approved canvas interactions, ported from the spike (branch `spike/console-ui-prototype`, `VariantC.ts` is the reference): pan by dragging the background; wheel zoom at the cursor with −/+/reset buttons; draggable node cards with edges following live; an edge-routing toggle (right-angle elbows default / straight); card positions persisted to localStorage with a reset-layout button. Fix the spike's known caveats: pointer release outside the viewport leaving stale drag state, and SVG stroke widths/labels scaling with zoom.

## Acceptance criteria

- [x] Pan, wheel-zoom-at-cursor, and −/+/reset all work
- [x] Node cards drag with edges following live
- [x] Edge routing toggles between elbows (default) and straight
- [x] Layout persists across reloads; reset button restores the default layout
- [x] Drag released outside the viewport does not stick; strokes/labels stay constant under zoom

## Blocked by

- 04 — Graph canvas

## Notes

- 04 left a scrollable canvas (`overflow: auto`) with orthogonal edges and no pan/zoom/drag. VariantC is the reference: transform pan/zoom on `.canvas-world`, pointer capture for drag, ortho default / non-ortho toggle.
- VariantC's non-ortho mode is a bezier. Spec says straight lines. Implementing actual straight segments, not the bezier.
- `renderApp` rebuilds the whole DOM every stream part. Interaction state (view transform, nodePos, edgeMode) must live at module scope in `view.ts` and be reapplied after each rebuild.
- Persistence is card positions in localStorage. Not pan/zoom, not edge mode.
- Two reset controls: reset pan/zoom (VariantC's reset), and reset-layout (clear stored positions, restore `layoutGraph` defaults).
- Caveat fixes: capture pointer on pointerdown and listen on `window` for pointerup/cancel; stroke-width / dash / marker / label size divided by zoom.
- Testable seam stays `project.ts`: `mergeLayout`, `parseStoredLayout`, `edgePath`, `zoomAtCursor`. No DOM tests.
