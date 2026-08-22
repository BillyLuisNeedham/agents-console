<!-- state: id=29 blocked-by=23,24,25,26,27 status=done -->

# 29 — Fleet batch review fixes

Spec: `.scratch/console-pool/spec-fleet-of-consoles.md`. Source: ticket 28's review Brief (`.scratch/console-pool/issues/28-review-pass-fleet-batch.md`), findings 1-3 plus the second pass's finding 4. Billy's call on the three findings was: fix all three.

## What to build

Three small hardening fixes from the fleet-batch review, plus a one-character prose fix:

1. **Name the holder on a busy pinned port (spec story 7).** A pool pinned to a busy port currently exits with `port N is already in use; free it or pass a different --port`, but the spec (lines 32 and 52) asks for the conflicting process to be named. The lock-refusal path already does a best-effort fleet-registry lookup to name a holder; mirror that in the port-conflict path: check the fleet registry for an entry claiming that port and name its pool directory and pid when found. Best-effort only: if the holder is not in the registry, the current message stands.
2. **Close the pool-lock TOCTOU window.** `acquirePoolLock` is read-then-write with no atomicity: two near-simultaneous launches of the same pool can both pass, and the failed-bind cleanup deletes the pid file unconditionally, which can erase the winning server's lock. Make the claim atomic (create `runs/server.pid` with O_EXCL or equivalent) and make cleanup remove the file only if it still names our pid.
3. **Make fleet registry writes atomic.** `upsertFleetEntry` is an unlocked read-modify-write; two servers booting different pools at the same moment can lose one entry. Write to a temp file and rename (a lockfile is also acceptable if simpler).
4. **Em dash in committed prose.** engine/server.ts has the comment "Registration is best-effort — a registry write that..." (around line 507 on main), breaching the standing no-em-dashes rule. Reword without the em dash.

## Acceptance criteria

- [x] Busy pinned port names the conflicting pool directory and pid when the fleet registry knows the holder; falls back to the current message when it does not (verified live with two temp pools)
- [x] Two near-simultaneous launches of the same pool cannot both pass the lock; the loser exits 1 naming the winner
- [x] Failed-bind cleanup never deletes a pid file that names another live server
- [x] Two servers booting different pools concurrently both end up in the fleet registry (no lost entry)
- [x] No em dashes in engine/server.ts prose
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 23 — Engine-enforced pool lock (fix 2 reworks its claim and cleanup)
- 24 — Pinned pool ports (fix 1 extends its conflict error)
- 25 — Fleet registry (fix 3 reworks its write; fix 1 reads it)
- 26 — Fleet list command (reads the registry fix 3 rewrites)
- 27 — my-console-runner speaks the new conventions (skill copy quotes the refusal messages)

## Notes

- Each fix mirrors code that already exists: the lock refusal's registry lookup for fix 1, standard O_EXCL/temp-rename patterns for fixes 2 and 3. Keep the changes small; this is hardening, not a redesign.
- Tests stay at the public interface: temp pool directories, temp registry paths, stub harnesses. Concurrency tests can spawn real server processes against temp pools, following the existing server.test.ts precedent.

### Worklog (ticket 29)

All four fixes landed in `engine/fleet.ts` and `engine/server.ts`, with tests in `fleet.test.ts` and `server.test.ts`.

- Fix 1: `readFleetEntryByPort` in fleet.ts (live pruned lookup by port, mirroring `readFleetEntry`); `bindPoolServer` takes the registry path and appends ` by pool <dir> (pid <pid>)` to the busy-pin error when the registry knows the holder. Fallback message unchanged.
- Fix 2: `acquirePoolLock` now claims with O_EXCL (`writeFileSync` flag "wx") and loops: a live holder refuses; a dead holder is removed only if a re-read still shows the same dead pid; an empty/unreadable lock is given a 25ms beat before being cleared, so a concurrent writer mid-claim is not trampled (closes the null-null re-read race a review sub-agent found in my first cut). Failed-bind cleanup removes `runs/server.pid` only when it still names our own pid.
- Fix 3: `upsertFleetEntry` serializes writes with a `.lock` file claimed via O_EXCL, waits up to 10s on a live holder, clears a dead holder's stale lock, and replaces the registry via temp-file + rename so a reader never sees a torn file.
- Fix 4: the em dash in the "Registration is best-effort" comment is now a colon.
- Added a `--registry <file>` seam to the server CLI (mirrors fleet-cli.ts's existing `--registry`), so CLI-level tests never touch the real `~/.agent-graphs/pools.json`. Without it the lock and registry concurrency tests would write outside the repo.
- Tests: live two-pool holder naming (a real bound server plus a contender booting into its pin), two-spawned-process same-pool lock race (loser exits 1 naming the winner's pid), foreign-live-pid lock survival, two-spawned-process different-pool registry race (both entries land), stale registry lock recovery, no temp/lock leftovers.
- Full suite: 220 pass, 0 fail (repeated full runs; the new concurrency tests are stable across repeated runs). `tsc --noEmit` clean; `bun run build` in ui clean.

Pre-existing flake, not caused by this ticket and out of its scope: `engine.test.ts` "rotates the resolver log to its attempt-numbered name on a second resolver run" fails intermittently (about 1 in 4 full-suite runs; reproduced on base HEAD without my changes). The failure is at the `merge-approval` assertion after `run.reject` (engine.test.ts:3057): the second resolver's conflict interrupt has not always landed when the rejection resolves. It is a timing race in the merge-resolver subsystem, which this ticket does not touch. Left as found.

---

## Brief, written by the engine

The engine process stopped while this ticket was in-progress (killed, crashed, or the machine restarted), so the work is part done at best and the agent left no brief. The ticket is back to ready; read the working tree before it runs again.
