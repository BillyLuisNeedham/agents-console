<!-- state: id=07 blocked-by=04 status=done -->

# 07 — Ticket cards for the Send fan-out

## What to build

Ticket cards for the Send fan-out. When schedule fans out N Sends, one card per ticket spawns in a fanned row beside the implementTicket node, each with an edge from schedule. Cards show id, title, and live status; pending cards also show blockedBy ids. Clicking a card expands its full details in place. Done cards stay, dimmed/marked done; ticket cards live and die with the thread, not mid-run.

## Acceptance criteria

- [x] Fan-out of N tickets spawns N cards beside implementTicket with schedule edges
- [x] Card statuses track ticket state live (pending → running → done)
- [x] Pending cards show blockedBy
- [x] Click expands full ticket details in place
- [x] Done cards dim but remain; cards clear only with the thread
- [x] `bun test` covers fan-out → N cards and status transitions

## Blocked by

- 04 — Graph canvas

## Notes

- Seam is `projectTicketCards` / `projectTicketEdges` on `run.values.tickets`. Cards exist whenever the selected thread has tickets; they do not wait for a schedule updates part (loading a finished thread has empty `visitedNodes`).
- Card ids are `ticket:${id}` so they never collide with topology nodes. Layout: column at (640, 736 + i*160), beside implementTicket. Edges: `schedule` → each card.
- Expand-in-place is view state (module-scope set), not projection. Click vs drag uses the existing 4px threshold.
- Live server is up (`/ok` 200). Will verify after the unit tests.
- Live verify (`verify-07.ts`, tickets/ pool) after approve: T1/T2/T3 cards at (640, 736/896/1056), schedule edges, T2 pending with blockedBy T1, T1 pending→running→done, all three stay done. Proven.
- Click-to-expand is view-only (module-scope set + class). Not in the projection seam. Inference: a stream rebuild mid-pointerdown can drop a click, same as any other canvas click.
