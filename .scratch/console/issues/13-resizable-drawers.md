<!-- state: id=13 blocked-by=none status=ready -->

# 13 — Resizable bottom drawers

## What to build

A drag handle on the top edge of the bottom drawers strip. Dragging it up makes the log and state drawers taller; dragging down makes them shorter. One shared height applies to both drawer bodies, replacing the fixed 32vh heights. The height is clamped to a minimum of 15vh and a maximum of 80vh, so the canvas can never be smushed to nothing and the strip never collapses. The height lives at module scope for the session: it survives re-renders while streaming, but nothing is persisted across sessions.

## Acceptance criteria

- [ ] Drag handle on the top edge of the drawers strip resizes both drawer bodies together
- [ ] Height clamped to 15vh minimum and 80vh maximum
- [ ] Clamp implemented as a pure function with unit tests (below min, above max, in range)
- [ ] Height survives re-renders while the run streams
- [ ] Opening and closing either drawer still works; a closed drawer shows only its bar
- [ ] Resize behaviour verified against the live dev server with a verify script, per the verify-02 through verify-07 precedent

## Blocked by

None — can start immediately
