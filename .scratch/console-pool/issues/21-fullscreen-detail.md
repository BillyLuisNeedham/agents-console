<!-- state: id=21 blocked-by=20 status=done -->

# 21 — Fullscreen Detail

Spec: `.scratch/console-pool/spec-ticket-log-and-detail-resize.md`.

## What to build

A toggle on the Detail header expands the panel to fill the Console window: canvas and bottom drawers covered, top toolbar still visible and usable so thread control (start, resume) stays at hand. Esc, the toggle, or selecting another card exits; exiting restores the dragged width from ticket 20, so fullscreen is a temporary excursion, not a reset. The drag handle is inert while fullscreen. This is a Detail mode, not browser fullscreen: the Detail never unmounts, so SSE rebuilds, pending interrupt forms, and ticket 19's live log tailing all keep working throughout.

## Acceptance criteria

- [x] A header toggle enters and exits fullscreen; Esc exits; selecting another card exits
- [x] Fullscreen covers the canvas and the bottom drawers; the top toolbar stays visible and interactive
- [x] Exiting fullscreen restores the dragged width
- [x] The drag handle is inert while fullscreen
- [x] A pending interrupt remains answerable from the fullscreen Detail, and live snapshots keep its content current
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 20 — Resizable Detail (fullscreen exits back to the dragged width it establishes)

## Notes

- Implementation is a class on the Detail plus a module-scope mode flag, mirroring the drawer idioms; no overlay or portal machinery.
- Fullscreen is a Detail mode: the module flag survives the full-DOM rebuild on every snapshot, and `renderApp` re-applies the class and re-measures the canvas-header's bottom edge after each swap, so the panel covers the canvas and drawers while the toolbar stays live.
- Esc and card selection reset the flag before their paths call `onSelectNode`, so the next render opens at the dragged width, not fullscreen. The toggle flips the class directly on the live DOM (no re-render), matching `applyDetailWidth`.
- Two-axis code review ran clean. Fixes applied from it: renamed `toolbarBottom` to `canvasHeaderBottom` (matches the class-touching naming idiom), extracted the toggle label/tooltip into `setFullscreenToggleLabel` (one writer for render and direct-DOM paths), and clarified the CSS comment about the `top: 0` fallback.
