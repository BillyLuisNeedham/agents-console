<!-- state: id=06 blocked-by=04 status=ready -->

# 06 — Interrupts inline in node cards

## What to build

Interrupts answered inline in the node card that raised them, as structured per-kind forms: approve-spec shows the spec and tickets with approve / reject; deadlock shows the pending tickets and hint with reload / abort; review offers approve, retry (checkbox list of ticket ids), and replan. The raw interrupt payload is available collapsed behind the form. Resuming sends the SDK Command resume payload and the run continues streaming. Projection tests cover each interrupt payload → form view model.

## Acceptance criteria

- [ ] All three interrupt kinds render structured forms in their owning node cards
- [ ] Each resume action sends the correct payload and the run continues live
- [ ] Review retry lets you pick ticket ids via checkboxes
- [ ] Raw payload viewable collapsed
- [ ] `bun test` covers the three payload kinds, reject → writeSpec, and review retry with ids

## Blocked by

- 04 — Graph canvas
