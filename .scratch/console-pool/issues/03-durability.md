<!-- state: id=03 blocked-by=01 status=done -->

# 03 — Durability and rehydration

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The engine's durability story. Line-1 state markers are dual-written alongside every sqlite checkpoint, and on any disagreement the marker wins — the file on disk is the human-readable truth shared with `run.sh`. An engine process that stops mid-run (kill, crash, machine restart) can be started again against the same pool directory and rehydrates: tickets marked done stay done, in-progress tickets are treated per their marker (an interrupted agent's marker semantics match my-issue-runner's: back to ready with the note it left), pending interrupts are restored, and the run continues from the next super-step. A pool driven partway by the Console remains drivable by `run.sh` and vice versa.

## Acceptance criteria

- [x] Every checkpoint write is accompanied by the corresponding line-1 marker writes
- [x] On rehydration, a marker that disagrees with the checkpoint wins
- [x] A killed engine resumes the same pool from rehydrated state without re-running done tickets
- [x] Pending interrupts survive a restart and are still answerable
- [x] A pool part-run by the engine can be inspected by `run.sh status` and continued by it
- [x] Covered by engine-seam tests, including a kill-mid-super-step scenario

## Blocked by

- 01 — Pool engine walking skeleton

---

## Notes

- The previous agent on this Issue crashed before writing anything (its runner brief is below, kept for the record). This run started from a clean tree: no engine changes had survived.
- Rehydration (`rehydrate` in engine/engine.ts) runs once at `runPool` start, before the drive loop. The last sqlite checkpoint restores the `log`, `outcomes` and `interrupts` channels; the `tickets` channel always comes from the line-1 markers, so markers win every disagreement. `CheckpointStore.latest()` reads the newest row.
- Marker semantics at load: `in-progress` with no pending interrupt means the agent died with the last process, so the marker goes back to `ready` and the engine appends a `## Brief, written by the engine` note to the Issue (run.sh's rule that a stop leaves a trace in the Issue). `in-progress` with a pending crash interrupt is left alone: the interrupt says a human has not looked yet. A stored interrupt whose marker says `done` or `ready` (a human answered or `run.sh reset` it on disk) is stale and clears. A `checkpoint` marker with no stored interrupt (a pool run.sh halted) re-raises its interrupt from the Brief, which is what makes run.sh pools answerable in the engine.
- Outcomes re-read from `runs/<id>.outcome.json` for done tickets, disk winning over the checkpoint. This is what recovers a finished ticket's outcome after a kill mid-super-step, where the ticket completed but no checkpoint landed (proven by the kill test: 01's outcome survives with zero checkpoint rows).
- Dual-write: `persist(session)` (write markers, then sqlite) is the only path that writes checkpoints, and the in-progress marker write moved from `runTicket` up into the drive loop, so the markers on disk agree with state at every emitted snapshot. The AC1 test asserts exactly that through `onSnapshot`.
- run.sh interop test copies the real `.scratch/console-pool/run.sh` into a temp pool, fakes `claude` on PATH and HOME for `~/.issue-runner`, and `git init`s (no commits, so preflight's dirty-tracked-files refusal passes with everything untracked). It proves `run.sh status` reads the engine's board and `run.sh` continues the pool without re-running the done ticket.
- `stalled` is now unreachable through the public seam by construction (every non-done marker funnels to ready or to an interrupt), so the old stalled test was replaced rather than ported. The phase stays in `RunPhase` as a defensive residue. (Inference: no marker combination reaches it after rehydration.)

## Review findings, and what changed because of them

Two-axis review (standards + spec, parallel sub-agents) ran on the working tree before commit. Acted on:

- A stored interrupt survived a human `run.sh reset` (marker back to ready): the ticket re-ran but the interrupt lingered in state for ever. Rehydration now clears stored interrupts for markers that say ready as well as done, with a test.
- The in-progress reset left no trace on the Issue file, breaking run.sh's shared rule. The engine now appends a `## Brief, written by the engine` note when it resets a stranded in-progress marker.
- Outcomes were restored only from the checkpoint, so a kill mid-super-step lost a finished ticket's outcome even though its outcome file was on disk. Done tickets' outcome files now win at rehydration; the kill test asserts the recovery.
- The checkpoint-interrupt literal was built in two places (drive loop and rehydration); extracted to `checkpointInterrupt(marker)`.
- The tickets channel merge in rehydration now goes through `applyUpdate` like every other mutation, instead of poking the map directly.

Noted, not acted on:

- `CheckpointStore.latest()` does not guard `JSON.parse`. sqlite commits are atomic per row, so a torn row is not a realistic kill artifact; a corrupt db should fail loudly at startup anyway.
- Standards axis flagged that `persist` has three call sites with different ordering against `emit`. Deliberate: the pre-spawn emit needs markers written but no checkpoint yet (a super-step start is not a checkpoint boundary, per the spec's "checkpoint after each super-step").

## Brief, written by the runner (2026-08-18, superseded)

The first agent on this Issue stopped without setting its own status: it hit a usage-limit error mid-read, before writing any code. Its brief and log tail are in `.scratch/console-pool/runs/03.log`. Nothing from that run survived in the tree; this Issue was worked fresh.
