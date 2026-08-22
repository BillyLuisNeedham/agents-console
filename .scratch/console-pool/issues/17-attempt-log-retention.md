<!-- state: id=17 blocked-by=16 status=done -->

# 17 — Attempt log retention

Spec: `.scratch/console-pool/spec-ticket-log-and-detail-resize.md`. Storage format: `docs/adr/0002-ticket-log-storage.md`.

## What to build

Re-running a ticket (crash retry, review reject) no longer overwrites its raw log. Before a new attempt writes, the ticket's existing raw logs rotate to attempt-numbered names, and the long-standing paths always hold the current attempt. Resolver logs rotate the same way and count as attempts. Every attempt of a ticket stays on disk, so the whole history of the ticket's work is preserved; the crash interrupt's log-path body and manual terminal tailing keep working untouched because the current attempt keeps the well-known path.

## Acceptance criteria

- [x] On a re-run, the ticket's existing raw log rotates to its attempt-numbered name before the new attempt writes; the resolver log rotates likewise
- [x] The long-standing log paths always hold the current attempt
- [x] Rotated filenames agree with the attempt numbers in the ticket's events file
- [x] The crash interrupt's log-path body still points at the live current-attempt log
- [x] Engine temp-pool test: a scripted re-run leaves both attempts' logs on disk under the expected names, newest at the long-standing path
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 16 — Per-ticket event timeline (attempt numbering is established there)

## Notes

- Rotation happens at spawn time, not at exit: the old log is complete and closed by then, and a crash mid-attempt never leaves a half-rotated pair.
- No migration of existing pools: tickets that already ran simply start rotating from their next attempt.

---

## Notes, agent 17 run 1 (checkpoint)

Blocked before any code. The working tree this run was spawned into does not have Issue 16's events feature, which this Issue's acceptance criteria depend on.

Evidence, all proven from the live repo:

- The pool engine server (pid 4129377, `bun engine/server.ts --pool .scratch/console-pool --port 8787`) started `01:24:15`, BEFORE issue 16's commit `ae6f99f` (`01:39:26`). It loaded the pre-events `engine.ts` at startup and has not reloaded: `GET /api/events?ticket=16` on `localhost:8787` returns the static-file fallback error, not JSON.
- `main` HEAD is `b084321`. `git merge-base --is-ancestor pool/16 main` fails: pool/16 is not on main. The events feature (issue 16) lives only on branch `pool/16` (`ae6f99f`). Its merge onto main is pending the `merge-approval` interrupt for ticket 16, whose resolver staged no resolution ("branch merges cleanly onto main as-is").
- The working tree at the repo root has no `engine/events.ts`, no `appendEvent`/`nextAttempt`/`lastAttempt` anywhere in `engine/`, no `events.jsonl` files in `.scratch/console-pool/runs/`, and no `/api/events` endpoint in `engine/server.ts`.
- The engine ran this ticket in the main checkout (repo root, branch `main`), not a worktree, because a single ready ticket with no parked `pool/17` branch runs in the main checkout (`planTicket`).

Why that blocks Issue 17 (not a puzzle): the rotation logic must name files `<id>.attempt-N.log` where N agrees with the attempt numbers in the ticket's events file (acceptance criterion 3). The attempt counter is Issue 16's `nextAttempt(runsDir, id)` over the events file. Without it the engine has no attempt numbering to agree with, and the temp-pool re-run test (criterion 5) could not assert the names. Reimplementing a parallel counter would contradict ADR 0002's "events format treated as stable from first write" and collide with pool/16 when it merges.

Also worth noting: even after the merge lands, the running engine process will not emit events or serve `/api/events` until it restarts, because Bun loads the modules at process start. So the merge approval alone is not enough; the server must restart to pick up the events-capable engine.

## Notes, agent 17 run 2 (done)

The blocker from run 1 cleared: issue 16's events feature is on `main` and the live server was restarted. This run implemented rotation at spawn time.

What landed:

- `engine/events.ts`: `lastAttemptOfKind(runsDir, id, kind)` returns the latest attempt carrying a given event kind (0 before any such event).
- `engine/engine.ts`: `rotateAttemptLog` renames a well-known raw log to its attempt-numbered name before the new attempt writes. Called from `runTicket` for `<id>.log` (kind `spawned`) and from `runResolver` for `<id>.resolver.log` (kind `resolver`). Resolver logs rotate before the resolver event is appended, so the attempt number read is the previous resolver's.
- The attempt number for a rotated file is read from the events file (the last event of the matching kind), so filenames agree with the events file. A pre-feature log with no recorded event of its kind rotates to `attempt-0`.
- The crash interrupt's log-path body is the well-known `<id>.log`, which always holds the current attempt because rotation only ever moves an older file away at spawn time. No change needed there.
- Engine tests: a temp-pool re-run leaves both attempts on disk (attempt 1 at `<id>.attempt-1.log`, attempt 2 at `<id>.log`), and a resolver that runs twice for the same ticket leaves `<id>.attempt-2.resolver.log` plus the current `<id>.resolver.log`, with events agreeing on attempts 1/3 for implement and 2/4 for resolver.
- All suites green: 143 engine/server/fleet tests, 61 UI tests, `tsc --noEmit`, and `vite build`.

One decision worth recording: rotated names use the attempt recorded for the last event of the matching kind, not `plan.attempt - 1`. In the resolver scenario implement attempt 1 conflicts, resolver runs as attempt 2, then the re-run implement is attempt 3; `plan.attempt - 1` would have been 2 (the resolver's number), which would mislabel the implement log.

## Brief

1. **Completed:** diagnosed a hard blocker. Issue 17 requires Issue 16's events feature (attempt numbers from `runs/<id>.events.jsonl`), which does not exist in the working tree this run was spawned into. It exists only on branch `pool/16` (`ae6f99f`), whose merge onto `main` is waiting on the pending `merge-approval` interrupt for ticket 16. The live pool server also started before issue 16 landed, so it runs the pre-events engine and would need a restart to emit events even after the merge.

2. **What the human has to do:**
   - Approve the pending `merge-approval` interrupt for ticket 16 in the Console, so `pool/16` (the events feature) merges onto `main`.
   - Restart the pool server so it loads the merged engine code (events emission + `/api/events`). The current process loaded pre-events code at `01:24` and will not pick up the new engine without a restart.
   - Then reset ticket 17 to ready so it re-runs against a `main` that has the events feature.

3. **What should happen after:** ticket 17's next run implements rotation at spawn time in the implement path (`runTicket`/`spawnToLog`) and the resolver path (`runResolver`): before writing the new attempt, rotate an existing `<id>.log` to `<id>.attempt-N.log` and `<id>.resolver.log` to `<id>.attempt-N.resolver.log`, with N from `nextAttempt(runsDir, id)` and the attempt recorded the same way issue 16 does, so filenames agree with the events file. Long-standing paths keep the current attempt, the crash interrupt's log-path body keeps pointing at the live log, and a temp-pool scripted re-run test asserts both attempts stay on disk. Then full suite, typecheck, and build.
