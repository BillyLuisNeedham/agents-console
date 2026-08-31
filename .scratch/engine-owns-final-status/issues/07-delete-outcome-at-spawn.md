<!-- state: id=07 blocked-by=06 status=done -->

# 07 — Delete the outcome file at spawn

Spec: `docs/specs/2026-08-30-engine-owns-final-status.md`

## What to build

Ticket 06's review found that a stale outcome file defeats the "missing outcome is a crash" contract. The outcome path is per-ticket (`runs/<id>.outcome.json`, engine/engine.ts:1823) and is deleted only on review-reject (engine.ts:1451), never at spawn. So when an attempt leaves a valid outcome behind (a checkpoint always does; a crash after writing the outcome does too) and the next attempt exits 0 without writing a fresh one, `readOutcomeResult` (engine.ts:1866) reads the stale file and the engine records the stale status: an already-answered checkpoint's brief is re-raised, or a ticket goes falsely done with Review as the only backstop.

Delete the outcome file at spawn so every attempt starts with no outcome. In `runTicket`, after `outcomePath` is computed and before `spawnToLog`, remove any existing file (`rmSync(outcomePath, { force: true })`). An attempt that exits 0 without writing a fresh outcome then crashes with reason `no outcome written`, exactly as the contract already promises for the first attempt.

The merge resolver reads its own outcome file the same way (engine.ts:1175-1206, `<id>.resolver.json`). Check whether a stale resolver outcome can mislead the same way; if so apply the same delete at resolver spawn. Record the decision either way in Notes.

## Acceptance criteria

- [x] `runTicket` deletes the ticket's outcome file before the attempt spawns
- [x] Contract test: a stale valid outcome from the previous attempt plus an exit 0 that writes nothing is recorded as a crash with reason `no outcome written`, and the stale status is not honored
- [x] Existing done/checkpoint/crash/resume tests pass unchanged except where the fix itself requires it
- [x] The resolver outcome path is checked for the same hole and the decision (fixed or not, and why) is recorded in Notes
- [x] `bun test` and `bun run typecheck` green

## Notes

- Fix: `rmSync(outcomePath, { force: true })` in `runTicket` right after `outcomePath` is computed, before the spawn (engine/engine.ts). A previous attempt's file can no longer be read as the current attempt's result.
- Resolver: same hole, confirmed and fixed. `runResolver` reads `<id>.resolver.json` after the resolver exits (engine.ts:1175-1211), and the file was never deleted anywhere (only `<id>.outcome.json` is removed, at review-reject). A resolver run that exited 0 without writing would have inherited a stale `resolved: true` from a previous run and raised an approval interrupt for a resolution the new run never produced. Applied the same `rmSync(outcomePath, { force: true })` at resolver spawn.
- Contract test added to the "outcome contract" block in engine/engine.test.ts: attempt 1 checkpoints with a valid outcome, the resume re-runs the ticket, attempt 2 exits 0 writing nothing, and the engine records a crash with reason `no outcome written` and the marker back at in-progress. Fails without the fix (the stale checkpoint is re-raised), passes with it.
- Checks: `bun test` 322 pass, `cd ui && bun test` 128 pass, `bun run typecheck` clean in both.

---

## Brief, written by the engine

The engine process stopped while this ticket was in-progress (killed, crashed, or the machine restarted), so the work is part done at best and the agent left no brief. The ticket is back to ready; read the working tree before it runs again.
