<!-- state: id=03 blocked-by=01 status=ready -->

# 03 — Durability and rehydration

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The engine's durability story. Line-1 state markers are dual-written alongside every sqlite checkpoint, and on any disagreement the marker wins — the file on disk is the human-readable truth shared with `run.sh`. An engine process that stops mid-run (kill, crash, machine restart) can be started again against the same pool directory and rehydrates: tickets marked done stay done, in-progress tickets are treated per their marker (an interrupted agent's marker semantics match my-issue-runner's: back to ready with the note it left), pending interrupts are restored, and the run continues from the next super-step. A pool driven partway by the Console remains drivable by `run.sh` and vice versa.

## Acceptance criteria

- [ ] Every checkpoint write is accompanied by the corresponding line-1 marker writes
- [ ] On rehydration, a marker that disagrees with the checkpoint wins
- [ ] A killed engine resumes the same pool from rehydrated state without re-running done tickets
- [ ] Pending interrupts survive a restart and are still answerable
- [ ] A pool part-run by the engine can be inspected by `run.sh status` and continued by it
- [ ] Covered by engine-seam tests, including a kill-mid-super-step scenario

## Blocked by

- 01 — Pool engine walking skeleton
