<!-- state: id=07 blocked-by=04 status=ready -->

# 07 — Ticket cards for the Send fan-out

## What to build

Ticket cards for the Send fan-out. When schedule fans out N Sends, one card per ticket spawns in a fanned row beside the implementTicket node, each with an edge from schedule. Cards show id, title, and live status; pending cards also show blockedBy ids. Clicking a card expands its full details in place. Done cards stay, dimmed/marked done; ticket cards live and die with the thread, not mid-run.

## Acceptance criteria

- [ ] Fan-out of N tickets spawns N cards beside implementTicket with schedule edges
- [ ] Card statuses track ticket state live (pending → running → done)
- [ ] Pending cards show blockedBy
- [ ] Click expands full ticket details in place
- [ ] Done cards dim but remain; cards clear only with the thread
- [ ] `bun test` covers fan-out → N cards and status transitions

## Blocked by

- 04 — Graph canvas
