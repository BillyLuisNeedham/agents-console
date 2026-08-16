<!-- state: id=05 blocked-by=04 status=ready -->

# 05 — Canvas interactions (pan, zoom, drag, persistence)

## What to build

The approved canvas interactions, ported from the spike (branch `spike/console-ui-prototype`, `VariantC.ts` is the reference): pan by dragging the background; wheel zoom at the cursor with −/+/reset buttons; draggable node cards with edges following live; an edge-routing toggle (right-angle elbows default / straight); card positions persisted to localStorage with a reset-layout button. Fix the spike's known caveats: pointer release outside the viewport leaving stale drag state, and SVG stroke widths/labels scaling with zoom.

## Acceptance criteria

- [ ] Pan, wheel-zoom-at-cursor, and −/+/reset all work
- [ ] Node cards drag with edges following live
- [ ] Edge routing toggles between elbows (default) and straight
- [ ] Layout persists across reloads; reset button restores the default layout
- [ ] Drag released outside the viewport does not stick; strokes/labels stay constant under zoom

## Blocked by

- 04 — Graph canvas
