<!-- state: id=14 blocked-by=12 status=ready -->

# 14 — Flow neighbourhood highlighting

Spec: `.scratch/console-pool/spec-console-flight-fixes.md`

## What to build

Selecting a card lights up its flow neighbourhood so one click answers "what feeds this, and what does it feed?" The selected card gets a clear selected ring. The cards that flow into it (its inflow, one hop: the tickets it depends on, plus start when it is blockerless) change to the accent blue. The cards it flows out to (its outflow, one hop: the tickets that depend on it, plus review) change to a distinct purple. The edges touching the selection recolour to match their direction. Clearing the selection removes every highlight; a highlighted done card loses its faded look; the highlight re-derives correctly on every live snapshot.

## Acceptance criteria

- [ ] A pure derivation at the projection seam takes the projected edges and the selected card id and returns the one-hop inflow and outflow sets, tested with fixtures (upstream/downstream, empty sets, start/review participation, selection cleared)
- [ ] One hop only: no transitive dependency cone
- [ ] Selected card shows a selected ring at a heavier weight than the neighbour highlights
- [ ] Inflow cards and their edges use the existing accent blue; outflow cards and their edges use a new purple token consistent with the palette; the two are never confusable
- [ ] Highlight styles win over status and interrupt styles (placed to win in source order, mirroring the interrupt precedent), and highlighted done cards render at full opacity
- [ ] Clearing the selection removes all highlights, and the highlight survives live snapshots while the pool runs
- [ ] Edge arrowheads keep the shared marker (per-edge marker colouring not worth it)
- [ ] Full test suite, typecheck, and build clean

## Blocked by

- 12 — Ticket cards open the Detail panel (selection must be reachable from ticket-card clicks for the highlight to have anything to hang on, and both touch the same view code)

## Notes

- The projection already emits the full edge list and the canvas already draws edges as SVG paths with a shared arrow marker, so the feature is a derivation plus render-time classes; no engine or wire-format changes.
- Existing palette (GitHub-derived): accent blue, amber running, green done, red interrupt, grey pending. Outflow purple should be added as a style token; inflow reuses the accent token.
- Colours and the visual result are verified by eye during the proving flight; the derivation is what carries tests.
