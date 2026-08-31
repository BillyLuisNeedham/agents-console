<!-- state: id=07 blocked-by=06 status=ready -->

# 07 — Delete the outcome file at spawn

Spec: `docs/specs/2026-08-30-engine-owns-final-status.md`

## What to build

Ticket 06's review found that a stale outcome file defeats the "missing outcome is a crash" contract. The outcome path is per-ticket (`runs/<id>.outcome.json`, engine/engine.ts:1823) and is deleted only on review-reject (engine.ts:1451), never at spawn. So when an attempt leaves a valid outcome behind (a checkpoint always does; a crash after writing the outcome does too) and the next attempt exits 0 without writing a fresh one, `readOutcomeResult` (engine.ts:1866) reads the stale file and the engine records the stale status: an already-answered checkpoint's brief is re-raised, or a ticket goes falsely done with Review as the only backstop.

Delete the outcome file at spawn so every attempt starts with no outcome. In `runTicket`, after `outcomePath` is computed and before `spawnToLog`, remove any existing file (`rmSync(outcomePath, { force: true })`). An attempt that exits 0 without writing a fresh outcome then crashes with reason `no outcome written`, exactly as the contract already promises for the first attempt.

The merge resolver reads its own outcome file the same way (engine.ts:1175-1206, `<id>.resolver.json`). Check whether a stale resolver outcome can mislead the same way; if so apply the same delete at resolver spawn. Record the decision either way in Notes.

## Acceptance criteria

- [ ] `runTicket` deletes the ticket's outcome file before the attempt spawns
- [ ] Contract test: a stale valid outcome from the previous attempt plus an exit 0 that writes nothing is recorded as a crash with reason `no outcome written`, and the stale status is not honored
- [ ] Existing done/checkpoint/crash/resume tests pass unchanged except where the fix itself requires it
- [ ] The resolver outcome path is checked for the same hole and the decision (fixed or not, and why) is recorded in Notes
- [ ] `bun test` and `bun run typecheck` green
