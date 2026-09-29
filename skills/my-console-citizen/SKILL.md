---
name: my-console-citizen
description: Behave as a Pool citizen inside a Console pool. Use when a teaching Turn or an AGENT.md says your pane was enlisted into a pool, when you are about to propose a follow-up Ticket or Conversation (a spawn), or when you must choose the harness and model a follow-up runs on.
---

You work inside a Console pool. The engine owns pool state; you propose, the engine writes.

## Your facts

The teaching Turn that enlisted you (or the pool's `AGENT.md`) states four things. Find them before you propose anything:

- your own **Assignment**: the harness, model, effort and drivers you run on. An enlisted pane names a harness and often no model, because herdr found you as you are.
- the pool **defaults**: the Assignment a follow-up runs on when nobody says otherwise.
- the **spawn path**: the file you write proposals to, and its JSON shape.
- the **Spawn ledger**: `runs/spawn-ledger.md` in the pool, which the engine keeps current. It lists every Ticket and Conversation in the pool, every proposal waiting for the next boundary (a Pending spawn), and every proposal waiting for the operator (a Held spawn).

## Proposing a follow-up

1. Read the Spawn ledger first. Work it already lists is taken: do not propose it again, whoever proposed it. If your follow-up still overlaps something listed there, say so with `overlaps: ["id", ...]`, naming the Tickets, Conversations or proposals (`proposal-N`) it overlaps. The proposal is then held for the operator to decide, instead of landing on its own.
2. Write the body for a fresh agent with none of your context: the goal, the files, the acceptance criteria. A thin body is dropped with the reason in the ticket log.
3. Decide the follow-up's Assignment:
   - The pool defaults fit: omit `assign`. Whatever your own Assignment leaves empty falls through to the defaults.
   - The follow-up needs something the defaults do not give (a stronger model or a higher effort for a review, a different harness): set only the fields that differ in `assign`.
   - `effort` is the harness's own word (claude: low, medium, high, xhigh, max), passed through as written; leave it out for the harness's default.
   - You cannot tell, or the defaults name no model: ask the operator in this pane before you write the file. The operator is in the room; a guess costs a wasted Attempt.
4. `blockedBy` names Tickets only, never a Conversation.
5. Write the file. Within the pool's Spawn caps the proposal waits as a Pending spawn and lands at the next super-step boundary, where the engine assigns the id and writes the ticket; the operator may hold or discard it before then. Beyond a cap it is held for the operator, and a cap of 0 holds every proposal. You never write under `issues/`, never set a status, never pick an id.

## Ending

A Ticket ends with an Outcome; a Conversation ends only when the operator ends it. When a Ticket you proposed ends, the engine posts a Turn into your pane with its Outcome.
