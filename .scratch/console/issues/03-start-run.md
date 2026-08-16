<!-- state: id=03 blocked-by=02 status=ready -->

# 03 — Start a run from the left rail

## What to build

A start-run form in the left rail: topic text field, ticket-pool dropdown (`tickets/`, `mock-tickets/`, `mock-tickets-deadlock/` — passed as `configurable.ticketDir`), and an optional packet textarea. Starting a run creates a thread tagged `{label: topic, origin: "ui"}`, invokes the graph with the topic (and packet text if given — the graph never reads packet files itself; omitted packet falls back to the demo packet), and begins streaming it.

## Acceptance criteria

- [ ] Starting a run with a topic creates a tagged thread and shows it streaming live
- [ ] Ticket-pool choice reaches the graph as `configurable.ticketDir`
- [ ] Pasted packet text is used; empty packet yields the demo fallback
- [ ] New thread appears in the list under its topic label

## Blocked by

- 02 — Live streaming
