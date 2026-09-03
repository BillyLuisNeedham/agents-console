# Spawn: attempts propose follow-up tickets, the engine writes them

Closes issue #32.

## Problem Statement

A ticket attempt regularly discovers work its ticket doesn't cover — a follow-up fix, scope the Spec missed, a refactoring the diff revealed. Today that discovery has nowhere to go: the agent's contract lets it write exactly one file (its Outcome), the pool's ticket set is fixed at `startPool`, and the only adoption seam for new ticket files is an interrupt answer happening to trigger a pool re-scan — invisible in the UI until a server restart. So discoveries die in attempt notes, or Billy hand-writes follow-ups and waits for an interrupt that may never come. The legacy `my-issue-runner` picked up new ticket files every loop iteration; the Console's engine is a regression on that one behaviour.

## Solution

Extend the Outcome JSON with an optional `spawn` array. An attempt ending `done` (or checkpointing) may propose follow-up tickets:

```json
{
  "status": "done",
  "spawn": [
    { "title": "…", "body": "…", "blockedBy": ["build-login-form"] }
  ]
}
```

At the super-step boundary the engine validates each proposal, writes the accepted ones as ordinary `issues/<id>.md` ticket files with the usual line-1 marker (`status=ready`, computed `blocked-by`), assigns ids itself as `<parent-id>-spawn-N`, reloads pool markers, and the drive loop schedules them like any other ticket. The server refreshes its pool metadata per snapshot, so Spawned tickets render as live cards immediately. This rides the exact seam the verify machinery already proved with grader tickets.

The agent proposes; only the engine writes the pool (ADR-0005's invariant, extended by ADR-0008). Spawned tickets are ordinary in every way from the moment they land — they assign, verify, and may themselves Spawn — bounded by the caps.

## User Stories

1. As a ticket agent, I want to record a follow-up I discovered mid-attempt, so that it becomes real work instead of a note nobody reads.
2. As a ticket agent, I want to declare my follow-up's blockers, so that it doesn't run before the work it depends on.
3. As a Console operator, I want follow-up tickets to appear on the canvas as soon as they're adopted, so that I can see the pool grow without restarting the server.
4. As a Console operator, I want a runaway agent capped, so that one confused attempt can't flood my pool.
5. As a Console operator, I want a good attempt with a malformed proposal to keep its result, so that sloppy follow-up ideas don't cost real work.
6. As a Console operator, I want spawned tickets visually identifiable by id (`-spawn-N`), so that I can tell discovered work from planned work at a glance.
7. As a Console operator, I want spawned tickets graded and verified like any other when their assign says so, so that discovered work meets the same bar as planned work.
8. As a Console operator, I want proposals naming tickets outside the pool dropped, so that the hermetic-pool rule holds without me policing it.
9. As a ticket agent whose ticket was itself Spawned, I want to be able to Spawn further work, so that discovery chains aren't artificially truncated at depth one.
10. As a Console operator, I want every dropped proposal logged with its reason in the ticket log, so that I can see what the engine refused and why.

## Implementation Decisions

- **Outcome schema**: optional `spawn` array of `{ title: string, body: string, blockedBy?: string[] }`. The agent never proposes an id, a status, or a marker — the engine owns all three.
- **Id assignment**: `<parent-id>-spawn-N`, N counting per parent across the run. The `-spawn-` namespace is reserved alongside `-grader-N` / `-head-to-head`: engine scheduling never treats the namespace specially (Spawned tickets are ordinary), but hand-written tickets may not use it.
- **Per-proposal validation, never per-attempt**: a proposal is dropped (with a reason in the ticket log) if its title or body is missing/thin, or any `blockedBy` id is not currently in the pool's markers. Dropping a proposal never fails the attempt; the attempt's own `done`/`checkpoint` stands. In-flight blockers are fine — the Spawned ticket simply waits on them, exactly as hand-written deps do today.
- **Caps**: at most 5 proposals honored per attempt and 20 per run. Overflow is truncated silently to the ticket log (an event, not an error). Defaults live in engine constants; no config surface for now.
- **Adoption point**: proposals are collected from Outcomes at attempt exit and written at the super-step boundary, in the same place answer processing already reloads the pool (`loadPoolMarkers` + assignment resolution for unseen ids). The drive loop's end-of-run phase computation must account for markers adopted at the boundary, so a pool with freshly Spawned ready tickets doesn't report itself done.
- **Spawn from Spawn**: a Spawned ticket's own attempts may propose `spawn` arrays; recursion is bounded only by the per-run cap.
- **Grader and head-to-head tickets cannot Spawn**: their Outcomes are engine-consumed, and a `spawn` key from them is ignored.
- **No human gate**: proposals are auto-adopted. The operator's control is post-hoc — kill or edit the card from its Detail before it's scheduled. A strict per-pool gating flag is a later issue if the itch comes.
- **Server staleness fix (in scope)**: the server currently loads pool meta once at boot (`createPoolServer`), so even engine-written grader tickets never render as cards. Meta and the known-ticket-id set are refreshed per snapshot, so Spawned (and grader) cards appear live and `/api/events` / `/api/log` accept their ids.
- **Spawn prompt teaching**: the ticket prompt's Outcome contract gains one paragraph: the `spawn` key's shape, that ids are assigned, that thin or out-of-pool proposals are dropped, and that caps exist. No new tools, no new files for the agent to write.

## Testing Decisions

- **The seam is the engine, exercised at the super-step boundary** — the same layer the existing engine tests drive. The behaviour under test is observable: ticket files on disk, events in the ticket log, and the scheduled set.
- **Engine tests** (extending `engine.test.ts`):
  1. An attempt exiting `done` with two valid proposals → both files written with correct markers and `-spawn-N` ids, both scheduled once their blockers are done.
  2. A proposal `blockedBy` an in-flight ticket → written, waits, schedules after the blocker finishes.
  3. A proposal naming an unknown/out-of-pool id → dropped, reason logged, attempt still `done`.
  4. A thin-body proposal → dropped, reason logged.
  5. Per-attempt cap: 7 proposals → first 5 written, truncation logged.
  6. Per-run cap across attempts → honored, truncation logged.
  7. A Spawned ticket's attempt proposing further Spawn → written (within caps).
  8. A grader ticket's Outcome carrying `spawn` → ignored.
  9. End-of-run phase: a pool whose last attempt Spawns a ready ticket does not report `done` until the Spawned ticket finishes.
- **Server tests**: a ticket id that appears after server boot renders in the enriched snapshot and is accepted by `/api/events` and `/api/log` without a restart.
- **Regression check**: an Outcome with no `spawn` key behaves byte-for-byte as today; `validateOutcome` accepts both shapes.

## Out of Scope

- A human approval gate for proposals (interrupt- or config-driven). Auto-adopt with post-hoc kill is the control; strict gating is a later issue if wanted.
- A Console UI affordance for the human to create tickets (`POST /api/tickets`). Different feature, different user.
- Grill/Spec-time ticket creation. Pre-run shaping already has the Packet/Spec path; Spawn is for mid-run discovery only.
- Config surfaces for the caps. Engine constants until someone needs to tune them.
- Cross-pool Spawn. The hermetic-pool rule stands; `blockedBy` validation against current markers enforces it.
