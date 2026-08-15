# Prototype notes — agent graph for grill → spec → tickets

Why I'm doing this: judging whether an explicit agent graph is worth adding to my grill → spec → tickets → review workflow, and whether it should become a reusable skill.

## End state

- The workflow works end-to-end for real: grill → spec → tickets → implement → review, one run.
- Not a demo with a stubbed grill — a real run on real tickets.
- Success looks like: I kick off a run, the graph turns a packet into a spec, I approve it, tickets fan out with `blockedBy` respected, work happens, I review, done.
- The graph has to earn it: routing, checkpoints, resume, "where is state" visibility — not just a fancier handoff file.

## Grill outside the graph

- The interactive grill probably does NOT live inside the graph.
- It's a back-and-forth with me in a terminal — too chatty to be a node in a durable graph.
- So: grill runs externally (like grill-me does today), and the graph consumes what it produced. The packet is graph input.
- The graph's job starts where the grill ends: packet → spec, my approval, then drive tickets.

## First runs: two ticket pools

- Both first real instances are pools of tickets, not the whole flow from scratch.
- (a) A pool produced by the grill-me → spec → tickets flow — the thing this graph is meant to replace/augment.
- (b) A pool from a wayfinder call — wayfinder's map becomes a ticket pool the graph schedules over.
- Both exercise the same core: a pool of tickets, `blockedBy` edges, Send/fan-out, super-steps, interrupts when a human is needed.

## Evolution into a skill

- Endgame: a skill that generates a graph, then runs it over a pool of tickets.
- Two phases: (1) generate the graph from the pool's shape — sources, statuses, routing; (2) run it — schedule, implement, checkpoint, resume.
- The prototype hardcodes one workflow. The skill should make the workflow itself the output, not the input.
- Reusable across pools: different sources, different pools, same scheduling logic.

## Ticket sources

- Tickets have to be source-agnostic.
- Local: files — what the prototype does now, tickets as files with ids and `blockedBy`.
- Jira: tickets live in Jira, graph reads and writes them.
- GitHub: issues as tickets.
- The graph ingests a pool from any of these and schedules over them the same way. A source is a loader, not a rewrite of the graph.

## UI

- I like seeing what's where — the read-only UI at 127.0.0.1:8787.
- Keep it: a page showing which node state is in, which tickets are done/blocked/running, where the interrupts are.
- The UI is part of why the graph might win — a handoff file can't show the live state of a run.
