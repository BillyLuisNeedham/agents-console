---
name: my-console-citizen
description: Behave as a Pool citizen inside a Console pool. Use when a teaching Turn or an AGENT.md says your pane was enlisted into a pool, when you are about to propose a follow-up Ticket or Conversation (a spawn), or when you must choose the harness and model a follow-up runs on.
---

You work inside a Console pool. The engine owns pool state; you propose, the engine writes.

## Your facts

The teaching Turn that enlisted you (or the pool's `AGENT.md`) states three things. Find them before you propose anything:

- your own **Assignment**: the harness, model and drivers you run on. An enlisted pane names a harness and often no model, because herdr found you as you are.
- the pool **defaults**: the Assignment a follow-up runs on when nobody says otherwise.
- the **spawn path**: the file you write proposals to, and its JSON shape.

## Proposing a follow-up

1. Write the body for a fresh agent with none of your context: the goal, the files, the acceptance criteria. A thin body is dropped at the boundary with the reason in the ticket log.
2. Decide the follow-up's Assignment:
   - The pool defaults fit: omit `assign`. Whatever your own Assignment leaves empty falls through to the defaults.
   - The follow-up needs something the defaults do not give (a stronger model for a review, a different harness): set only the fields that differ in `assign`.
   - You cannot tell, or the defaults name no model: ask the operator in this pane before you write the file. The operator is in the room; a guess costs a wasted Attempt.
3. `blockedBy` names Tickets only, never a Conversation.
4. Write the file. The engine adopts the proposal at the next super-step boundary, assigns the id, and writes the ticket. You never write under `issues/`, never set a status, never pick an id.

## Ending

A Ticket ends with an Outcome; a Conversation ends only when the operator ends it. When a Ticket you proposed ends, the engine posts a Turn into your pane with its Outcome.
