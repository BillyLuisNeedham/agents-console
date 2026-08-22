<!-- state: id=20 blocked-by=none status=done -->

# 20 — Resizable Detail

Spec: `.scratch/console-pool/spec-ticket-log-and-detail-resize.md`.

## What to build

The Detail's left edge becomes a drag handle: dragging it widens or narrows the panel live, clamped between a readable minimum (340px, the current fixed width) and most of the window (about 80vw). The chosen width persists to a single global localStorage key and is restored on reload. The pattern copies the bottom drawers' existing drag handle: module-scope size var, clamp helper beside the existing drawer clamp, inline style applied per render so the full-DOM rebuild idiom is untouched.

## Acceptance criteria

- [x] Dragging the Detail's left edge resizes the panel live
- [x] Width is clamped between 340px and about 80vw; the clamp helper is pure and tested at the projection seam
- [x] The width persists across reloads via localStorage (one global key, not per pool)
- [x] The canvas reflows as the Detail resizes and cards remain draggable and clickable at any width
- [x] With no card selected the Detail stays hidden regardless of stored width
- [x] Full test suite, typecheck, and build clean

## Blocked by

None — can start immediately.

## Notes

- No dependencies on the ticket-log tickets: this touches panel sizing only, not Detail content.

## Brief

The engine process stopped while this ticket was in-progress, but the working tree already carried the full implementation: the drag handle (`renderDetailHandle`/`bindDetailHandle`), the module-scope width var with one global localStorage key `console-detail-width`, the pure `clampDetailWidth` helper in `project.ts` beside `clampDrawersHeight` with projection-seam tests, the `.detail-handle` CSS, and the inline per-render width on `.detail-open`.

Verified this run: `bun test` 55 pass, `bun run typecheck` clean, `bun run build` clean. Ran the two-axis code review; both axes came back clean apart from one defect both flagged: the `clampDetailWidth` docstring claimed the 340px minimum wins on a window too narrow to hold it, but the code lets the window bound win (and the test endorsed that). Fixed the docstring and renamed the misleading test to "tracks the window bound when the window is too narrow to hold the minimum". Drag feel and clamping remain to be felt in the proving flight, per the spec's testing decisions.
