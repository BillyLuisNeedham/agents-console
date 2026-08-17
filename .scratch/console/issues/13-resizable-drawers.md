<!-- state: id=13 blocked-by=none status=done -->

# 13 — Resizable bottom drawers

## What to build

A drag handle on the top edge of the bottom drawers strip. Dragging it up makes the log and state drawers taller; dragging down makes them shorter. One shared height applies to both drawer bodies, replacing the fixed 32vh heights. The height is clamped to a minimum of 15vh and a maximum of 80vh, so the canvas can never be smushed to nothing and the strip never collapses. The height lives at module scope for the session: it survives re-renders while streaming, but nothing is persisted across sessions.

## Acceptance criteria

- [x] Drag handle on the top edge of the drawers strip resizes both drawer bodies together
- [x] Height clamped to 15vh minimum and 80vh maximum
- [x] Clamp implemented as a pure function with unit tests (below min, above max, in range)
- [x] Height survives re-renders while the run streams
- [x] Opening and closing either drawer still works; a closed drawer shows only its bar
- [x] Resize behaviour verified against the live dev server with a verify script, per the verify-02 through verify-07 precedent

## Blocked by

None — can start immediately

## Notes

- `clampDrawersHeight(vh)` plus `DRAWER_MIN_VH`/`DRAWER_MAX_VH`/`DRAWER_DEFAULT_VH` live in project.ts at the pure-function seam, mirroring `zoomAtCursor`/`strokeWidthForZoom`. Three unit tests (below min, above max, in range) added to project.test.ts; 82 total pass.
- The shared height is `drawersHeight` at module scope in view.ts (default 32), read on every render and applied as an inline `height:${drawersHeight}vh` on both drawer bodies (`.log-lines` and `.inspector-channels`/`.inspector-empty`). The fixed `32vh` in styles.css is gone. Module scope means the full-DOM rebuild on each stream part keeps the height.
- The drag handle is a new `.drawer-handle` div as the first child of `.drawers` (now a column: handle, then a `.drawer-row` holding the two side-by-side drawers). Pointerdown captures the pointer; pointermove maps `dy` to vh (`100 / window.innerHeight`) and clamps; pointerup ends. `drawerDrag` is cleared at the top of `renderApp` so a mid-drag re-render cannot strand a stale drag.
- Closed drawers are unaffected: a drawer body only renders when its toggle is open, so a closed drawer shows just its bar; the shared height applies to whichever body is open.
- `.scratch/console/verify-13.ts` (gitignored, per precedent) verifies the clamp, the drag delta → height mapping (up grows, down shrinks, both clamp), and a live run's log/state projections. `bun test`, `tsc --noEmit`, and `vite build` are all clean. The actual handle drag in a browser is DOM interaction and cannot be headless-verified here; it follows the same pointer-capture pattern already used by the canvas.

