<!-- state: id=01 blocked-by=none status=done -->

# 01 — Pool engine walking skeleton

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

A bespoke pool engine that can take a directory of Issue files (line-1 state markers: id, blocked-by, status) and run it to completion against stub harnesses. State lives in four channels — `tickets` (id to status map), `log` (append), `outcomes` (id to summary + commit sha), `config` (static console.json contents) — each with its reducer. The scheduler computes ready (every blocker done), runs the ready set as one super-step against a shared starting snapshot, and applies reducers at the join. Each ticket spawns a stub harness process (a script that sets its line-1 marker and exits) using the glued-prompt shape; after exit the engine reads the marker back and merges the ticket's partial update. After each super-step the engine checkpoints state to a sqlite file in the pool directory. The whole engine is exercisable from a test: point it at a temp pool, run, observe the state snapshots it emits and the files it writes.

## Acceptance criteria

- [x] Engine loads a pool from Issue files with line-1 markers and rejects a pool with missing markers
- [x] Ready set is computed as every ticket whose blockers are all done
- [x] A super-step runs the ready set against one shared starting snapshot and merges updates via channel reducers
- [x] Stub harness spawn + marker read-back drives ticket status transitions (ready → in-progress → done)
- [x] A ticket's outcome (summary + commit sha) lands in the outcomes channel and is available to downstream prompts
- [x] A sqlite checkpoint is written to the pool directory after every super-step
- [x] A pool whose tickets all reach done terminates the run cleanly
- [x] Engine behaviour is covered by tests through its public interface only, using stub harness scripts and temp pool directories

## Blocked by

None — can start immediately

## Notes

- Repo layout changed since the runner instructions were written: commit 12aea8c promoted the prototype to the repo root, so `prototype/src/...` is now `src/...` and `prototype/NOTES.md` is `NOTES.md`. (Proven: git log + ls.)
- Engine lives in `engine/` at the repo root, a sibling of the LangGraph path in `src/` which stays untouched. Public interface is `engine/engine.ts`; everything else in the directory is internal.
- The spawn seam is a harness resolver: `Record<name, (ctx) => argv>`. The engine always spawns the process itself (stdin closed, output to `runs/<id>.log`); tests inject stub resolvers, Issue 04 hardens the default claude/opencode/cursor resolvers.
- Outcome mechanism: the harness writes `runs/<id>.outcome.json` (`{summary, commitSha}`) and the glued prompt instructs it to. The engine trusts the file; it does not derive the sha from git itself. (Decision: the Issue did not settle how outcomes are produced.)
- Skeleton treats a pool that cannot advance as `phase: "stalled"` in emitted state and stops. Crash/checkpoint/deadlock interrupts are Issue 02; rehydration semantics are Issue 03. An `in-progress` marker at load is not re-run by the skeleton.

## Review findings, and what changed because of them

Two-axis review (standards + spec) ran on the working tree before commit. Acted on:

- Snapshots now expose the in-progress leg: statuses merge into state and a snapshot emits at super-step start, before spawning. A UI reading snapshots can render in-progress cards.
- The terminal state (including the `pool done` / `pool stalled` log line) is checkpointed, so the last sqlite row matches the returned final state.
- The cursor launch line was removed from the default harness registry: the job constraints assign writing it to Issue 04. claude and opencode stay as direct copies of run.sh's proven shapes.
- Assignments resolve once at load (fail fast, like run.sh's preflight) and are reused at spawn.

Noted for later Issues, not fixed here:

- A harness that exits without touching its marker reads back as the engine's own in-progress write, so the skeleton cannot distinguish crash from live. It surfaces as `stalled` plus a log line carrying the exit code. Issue 02 owns raising the crash interrupt; it can diff the marker's mtime or content against the engine's write if it needs the distinction. (Inference: mtime works; content compare is certain.)
- A ticket that forgets its outcome file is silently absent from downstream prompts. The log line `no outcome recorded` is the only trace.
- The checkpoint test reads console.db's schema directly. Sanctioned by the spec's Testing Decisions (assert on the files the engine writes), but if the schema changes the test is what breaks.
