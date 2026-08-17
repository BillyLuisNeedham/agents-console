<!-- state: id=06 blocked-by=04 status=done -->

# 06 — Interrupts inline in node cards

## What to build

Interrupts answered inline in the node card that raised them, as structured per-kind forms: approve-spec shows the spec and tickets with approve / reject; deadlock shows the pending tickets and hint with reload / abort; review offers approve, retry (checkbox list of ticket ids), and replan. The raw interrupt payload is available collapsed behind the form. Resuming sends the SDK Command resume payload and the run continues streaming. Projection tests cover each interrupt payload → form view model.

## Acceptance criteria

- [x] All three interrupt kinds render structured forms in their owning node cards
- [x] Each resume action sends the correct payload and the run continues live
- [x] Review retry lets you pick ticket ids via checkboxes
- [x] Raw payload viewable collapsed
- [x] `bun test` covers the three payload kinds, reject → writeSpec, and review retry with ids

## Blocked by

- 04 — Graph canvas

## Notes

- Seam is `project.ts`: interrupt payload → form view model on the owning card; `projectResume` → SDK `{ command: { resume } }`. No DOM tests.
- Backend contract (do not change): approve-spec `{ action: approve|reject }`; deadlock `{ action: reload|abort }`; review `{ action: approve }` / `{ action: retry, ids }` / `{ action: replan }`.
- Spike `data.ts:resumeRun` sent the decision as `input`. Wrong. Live path is `client.runs.stream(..., { command: { resume: decision }, streamMode: ["values","updates"] })`.
- Card status gains `"interrupted"` (pulse, red border) when that node owns a pending interrupt. Form mounts in `.node-card-body`. Drag guard already excludes button/input/summary.
- Dev server was up at start (`GET /ok` → 200). Will verify resume live before marking done.
- Live verify-06: reject → writeSpec twice in the log; review retry T1 → `review: retry T1` then schedule; deadlock abort; deadlock reload re-reads `mock-tickets-deadlock/` from persisted configurable (no need to re-send ticketDir on resume).
- Review (standards/spec): kept `projectResume` on the projection seam (that's what bun test pins). Dropped optimistic interrupt-clear. Approve-spec form shows the full spec, scrollable.
