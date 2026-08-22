<!-- state: id=30 blocked-by=29 status=done -->

# 30 — Review pass over the fleet fixes

Spec: `.scratch/console-pool/spec-fleet-of-consoles.md`. Mirrors tickets 22 and 28's shape. Reviews ticket 29, the follow-up fixes from ticket 28's review.

## What to build

Review pass over ticket 29's diff before calling the fleet spec done. Run both review axes (standards plus spec, per the `code-review` skill) across ticket 29's commit, and verify live that each fix behaves as specified: a busy pinned port names the holder when the registry knows it, two simultaneous same-pool launches produce exactly one winner, failed-bind cleanup leaves another server's pid file intact, two concurrent different-pool boots both register, and engine/server.ts prose carries no em dashes. Re-verify spec stories 1, 2, 7, and 10 end to end against temp pools, since the fixes touch their code paths. This ticket changes no code: if the review finds problems it ends as a checkpoint and the brief carries the disagreement; a clean review ends it as done.

## Acceptance criteria

- [x] Both review axes run over ticket 29's diff and findings addressed (adjudications in Notes)
- [x] Each of ticket 29's four fixes verified live against temp pools
- [x] Spec stories 1, 2, 7, and 10 re-verified end to end
- [x] CONTEXT.md vocabulary used correctly; avoid-words absent
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 29 — Fleet batch review fixes (the diff under review)

## Notes

- This is a batch review, not the pool's final Review interrupt — the engine raises that itself once every ticket in the pool is done.
- Ticket 28's Brief carries the original findings and the live-verification table format to reuse.

### Review setup (ticket 30)

- Review diff: ticket 29's single commit 7a4b1fc (`git diff 7a4b1fc~1...7a4b1fc`), four files: engine/fleet.ts, engine/fleet.test.ts, engine/server.ts, engine/server.test.ts.
- Spec sources: this pool's `.scratch/console-pool/spec-fleet-of-consoles.md` plus ticket 29's own Issue text.
- Standards sources: no CODING_STANDARDS.md / CONTRIBUTING.md exists; documented standards are CONTEXT.md vocabulary plus this job's runner constraints, over the fixed smell baseline from the code-review skill.
- Both axes ran as parallel sub-agents, adjudicated by me.

### Standards axis

No documented-standard breaches: no em dashes added (the diff removes the one finding 4 targeted), vocabulary correct in user-facing strings, no `--force` hatch, no new dependencies, tests stay at the public interface, no AI attribution. Judgement-call smells only, none blocking:

- Duplicated Code: the lock-claim protocol shape (claim, live-holder/dead-holder/empty branches) now exists in both `acquirePoolLock` (server.ts) and `upsertFleetEntry` (fleet.ts), and `readLockPid` (fleet.ts) mirrors `readLockedPid` (server.ts). The loops genuinely diverge (deadline versus attempt count, re-read-before-remove in one), so extraction is a judgement call; noted so the two cannot drift unnoticed.
- Speculative Generality: `FLEET_LOCK_TIMEOUT_MS` is exported but nothing imports it. One-line tidy when next touching fleet.ts.
- Mysterious Name (minor): `readLockPid` versus `readLockedPid` differ by one letter for near-identical jobs.

### Spec axis

All four fixes landed and every ticket 29 acceptance criterion holds. Three concerns raised, adjudicated as follows:

1. Residual theoretical race in the lock claim: an empty or unreadable lock gets a 25ms beat before clearing, so a writer stalled more than 25ms between create and write could still be trampled. Judgement: accepted. Every practical file lock has such a window; the acceptance criterion (two near-simultaneous launches cannot both pass) is proven by a real two-process test and re-verified live below. Recorded as a known limitation, not a spec gap.
2. The conditional failed-bind cleanup branch (`readLockedPid === process.pid`) is effectively unreachable, because a live foreign lock refuses before the bind is attempted. Judgement: the criterion is behavioural — cleanup never deletes a pid file naming another live server — and it holds, verified live below (pool A's pid file survived a refused contender boot). The branch is cheap defence in depth, not dead weight to remove.
3. The `--registry` CLI flag on server.ts is beyond the four fixes' letter. Judgement: justified, not scope creep. Ticket 29's worklog disclosed it; without it the CLI-level concurrency tests would write to the real `~/.agent-graphs/pools.json`, breaching this job's no-writes-outside-the-repo constraint. It mirrors fleet-cli.ts's existing `--registry`.

Also raised: fix 1's holder lookup trusts any live-pid registry entry for the port (pid reuse could misname). That matches the Issue's own "best-effort" wording; accepted. The lock-race test would hang rather than fail against a non-atomic regression and does not assert the winner bound; test-robustness judgement call, noted.

### Live verification (temp pools under /tmp, real spawned servers, temp registry via --registry, all processes killed after)

- Fix 1 / story 7: pool B pinned to live pool A's port exits 1 with `port 19411 is already in use by pool <poolA> (pid <pidA>); free it or pass a different --port`. PASS.
- Fix 1 fallback: a port held by a process the registry does not know exits 1 with the original holder-less message. PASS.
- Stories 1, 2: second boot on live pool A exits 1 with `pool <poolA> is locked by live server pid <pidA> on port 19411; open the running console or kill it` (port from the registry). PASS.
- Failed-bind cleanup invariant: after the refused boot, pool A's pid file still names the live server and pool A still serves. PASS.
- Fix 2: two simultaneous same-pool launches produce exactly one winner; the loser exits 1 naming the winner's pid; the pid file names the winner. PASS.
- Fix 3 / story 10: two concurrent different-pool boots both land in the fleet registry (four entries present including A's; no lost write), and fleet list prints both. PASS.
- Fix 4: no em dashes in engine/server.ts. PASS.

### Suite

`bun test` 220 pass / 0 fail; `bunx tsc --noEmit` clean; `bun run build` in ui/ clean. Ticket 29's noted pre-existing resolver-log flake did not appear in this run.

### Disposition

Clean review: no hard findings, no spec gaps, nothing needing Billy's decision. The smells and limitations above are recorded for the pool's final Review interrupt. This ticket changes no code, and the Issue files are untracked runner state (`.scratch/` is never committed), so there is no commit for this ticket.
