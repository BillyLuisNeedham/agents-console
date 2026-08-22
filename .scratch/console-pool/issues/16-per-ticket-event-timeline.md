<!-- state: id=16 blocked-by=none status=done -->

# 16 — Per-ticket event timeline

Spec: `.scratch/console-pool/spec-ticket-log-and-detail-resize.md`. Storage format: `docs/adr/0002-ticket-log-storage.md`.

## What to build

Clicking a ticket card shows its timeline in the Detail: one row per attempt, with the ticket's lifecycle events listed under it. To feed it, the pool engine appends one structured JSON line per event to the ticket's events file in the pool's runs directory (timestamp, attempt number, event kind, small payload) at every lifecycle point it already passes through, numbering attempts per ticket across implement and resolver runs. A new server endpoint returns the selected ticket's parsed events. For tickets with no events file (pre-feature pools), the endpoint reconstructs one attempt row per existing log file from file presence and modification time, marked as reconstructed, so in-flight pools degrade gracefully instead of showing blank timelines.

## Acceptance criteria

- [x] Engine appends an event at each lifecycle point: scheduled, spawned, exited (with code and marker status), merged, merge-conflict, resolver run, checkpoint interrupt, crash interrupt, deadlock raised and cleared, interrupt answered, review-reject reset
- [x] Each event line carries timestamp, attempt number, kind, and a small payload; attempt numbers are per ticket and shared by implement and resolver runs
- [x] The events endpoint returns the ticket's parsed events; a ticket with no events file gets reconstructed attempt rows from its existing log files, marked reconstructed
- [x] The ticket Detail shows a timeline section: one row per attempt with its events, the currently running attempt marked
- [x] Engine temp-pool test: a scripted ticket run leaves the expected event kinds in order; server tests cover parsing and the reconstructed backfill; projection tests cover the timeline view model
- [x] Full test suite, typecheck, and build clean

## Blocked by

None — can start immediately.

## Notes

- The events file is append-only and small; it is never folded into the SSE snapshot. The client fetches it lazily for the selected ticket and refetches when a new snapshot arrives (ticket 19 builds liveness on this cadence).
- UI-only timeline state that must survive rebuilds (selected attempt, scroll pin) follows the module-scope idiom used by drawer height and interrupt note drafts.
- Pool AGENT.md conventions apply: no em dashes in prose, tests only through public seams.

---

## Notes

Worktree state on restart: this ticket runs in the engine's pool worktree (`pool/16`, at `b084321`), clean apart from the copied Issue file. The main checkout carries uncommitted changes belonging to parallel in-flight tickets (23's pool-lock in `engine/server.ts`/`server.test.ts`, fleet glossary in `CONTEXT.md`, console.json). They are not mine to touch or commit.

Plan for this ticket:

- New `engine/events.ts`: event kinds, `appendEvent`/`readEvents`/`nextAttempt`/`lastAttempt` over `runs/<id>.events.jsonl`.
- Wire emission into `engine.ts` at each lifecycle point (scheduled, spawned, exited, merged, merge-conflict, resolver, checkpoint, crash, deadlock/deadlock-cleared, answered, review-reject). Attempt number threads schedule→spawn→exit; resolver runs take the next attempt number.
- `server.ts`: `GET /api/events?ticket=<id>`, returns parsed events plus reconstructed attempt rows (from log files by mtime, marked reconstructed) for tickets with no events file. Scoped to known ticket ids.
- `ui`: pure `projectTimeline` in `project.ts`; Detail timeline section rendered in `view.ts`; lazy fetch + refetch-on-snapshot in `main.ts`/`client.ts`.

Not in scope (later tickets): raw log pane (18), attempt log rotation (17), live tailing (19), never-run spec-text fallback (18).

---

## Notes, after the run

Implemented as planned. Findings from the work:

- The `merged` event fires only when a worktree merge happens. A single-ticket super-step runs in the main checkout and never merges, so its events are scheduled, spawned, exited with no merged. Multi-ticket super-steps and parked-branch resumes do merge and emit merged. This matches how the engine works, not a gap (verified with a throwaway git-pool test, since removed).
- Deadlock clearing fires only once the ticket can complete (its blocker chain resolves), not when the answer lands, so the deadlock-cleared event lands after the ticket runs. Test asserts that ordering.
- The events endpoint is scoped to the pool's known ticket ids: an unknown id gets 404 and an arbitrary id can never walk out of the runs directory.
- Attempt numbers are shared across implement and resolver runs: a resolver run takes the next attempt number for the same ticket (pinned by test).
- Em dash rule and vocabulary (Attempt, Ticket log, no avoid-words) respected in all added prose.

---

## Resume note

dirty tree stashed (escaped ticket-23 pool-lock variant); re-attempting merge
