<!-- state: id=23 blocked-by=none status=done -->

# 23 — Engine-enforced pool lock

Spec: `.scratch/console-pool/spec-fleet-of-consoles.md`. Decision record: `docs/adr/0001-one-console-per-pool.md`.

## What to build

The engine itself enforces one server per pool, replacing the advisory pid-file convention the launcher skill used to keep. On boot the server reads `runs/server.pid` from the pool directory: if that pid belongs to a live process, it exits non-zero with a message naming the live pid, its port (from the fleet registry when known), and the pool directory; if the pid is stale or the file is absent, it writes its own pid and continues. Liveness is a signal-0 probe. There is no `--force` escape hatch — a live lock always means "use the running console or kill it".

## Acceptance criteria

- [x] Booting a second server against a pool with a live server exits non-zero, naming the live pid, its port when known, and the pool directory
- [x] Booting against a stale pid file succeeds and overwrites it with the new server's pid
- [x] The pid file is written by the server process itself, on every successful boot — no launcher involvement
- [x] No `--force` flag or equivalent override exists
- [x] Server-factory test seam: live-pid refusal, stale-pid takeover, and self-written pid each covered against temp pool directories, using real pids
- [x] Full test suite, typecheck, and build clean

## Blocked by

- None — can start immediately

## Notes

- The registry lookup for the refusal message's port is best-effort: if the registry is absent or has no entry, the message still names pid and pool dir. Ticket 25 builds the registry; the refusal must not depend on it existing.
- Implemented: the lock lives in `createPoolServer` in `engine/server.ts` (`acquirePoolLock`), claimed at server construction before any port binding or pool meta load. `engine/fleet.ts` holds the registry path default and a best-effort `readFleetEntry` that ticket 25 extends. Tests are in `engine/server.test.ts` (factory seam) and `engine/fleet.test.ts`.
- Liveness is `process.kill(pid, 0)`: success or EPERM counts as live, ESRCH as dead. A pid file that is absent, empty, non-numeric, or not a positive integer is treated as stale and taken over; pid 0 is never probed because signal 0 to pid 0 probes the process group and always looks alive.
- The refusal message is `pool <dir> is locked by live server pid <pid>[ on port <n>]; open the running console or kill it`. The port comes from the fleet registry only when its entry matches both pool and pid. The CLI catches the refusal, prints it to stderr, and exits 1. There is no `--force` anywhere.
- Interlock to sequence (inference, from code reading, proven by the review): the my-console-runner skill still writes `runs/server.pid` itself after launching (`echo $! > runs/server.pid`). Because the engine now also writes it at boot, the skill's write races the engine's first read and usually wins, so the engine reads its own pid and refuses on a fresh pool's first launch. The skill update (stop writing the pid file, rely on the engine's refusal) is a separate workstream in the spec and a write outside this repo, so it was not touched here. It must land before the skill is used to launch a fresh pool.
