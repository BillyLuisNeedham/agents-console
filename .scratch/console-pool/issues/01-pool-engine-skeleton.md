<!-- state: id=01 blocked-by=none status=ready -->

# 01 — Pool engine walking skeleton

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

A bespoke pool engine that can take a directory of Issue files (line-1 state markers: id, blocked-by, status) and run it to completion against stub harnesses. State lives in four channels — `tickets` (id to status map), `log` (append), `outcomes` (id to summary + commit sha), `config` (static console.json contents) — each with its reducer. The scheduler computes ready (every blocker done), runs the ready set as one super-step against a shared starting snapshot, and applies reducers at the join. Each ticket spawns a stub harness process (a script that sets its line-1 marker and exits) using the glued-prompt shape; after exit the engine reads the marker back and merges the ticket's partial update. After each super-step the engine checkpoints state to a sqlite file in the pool directory. The whole engine is exercisable from a test: point it at a temp pool, run, observe the state snapshots it emits and the files it writes.

## Acceptance criteria

- [ ] Engine loads a pool from Issue files with line-1 markers and rejects a pool with missing markers
- [ ] Ready set is computed as every ticket whose blockers are all done
- [ ] A super-step runs the ready set against one shared starting snapshot and merges updates via channel reducers
- [ ] Stub harness spawn + marker read-back drives ticket status transitions (ready → in-progress → done)
- [ ] A ticket's outcome (summary + commit sha) lands in the outcomes channel and is available to downstream prompts
- [ ] A sqlite checkpoint is written to the pool directory after every super-step
- [ ] A pool whose tickets all reach done terminates the run cleanly
- [ ] Engine behaviour is covered by tests through its public interface only, using stub harness scripts and temp pool directories

## Blocked by

None — can start immediately
