<!-- state: id=25 blocked-by=23,24 status=done -->

# 25 — Fleet registry, written on start

Spec: `.scratch/console-pool/spec-fleet-of-consoles.md`. Glossary: Fleet in CONTEXT.md.

## What to build

A machine-wide fleet registry at `~/.agent-graphs/pools.json` records every live console: entries of `{poolDir, port, pid, startedAt}`, upserted by each server after it successfully binds. The registry is a small module whose functions take the registry path, defaulting to the machine-wide location and overridable for tests. A missing or corrupt registry file is recreated, not fatal. There is deliberately no server-side exit handler — cleanup under kill -9 would be unreliable, so all hygiene is prune-on-read (built in ticket 26; the read functions here already prune dead pids and missing pool directories before returning entries).

## Acceptance criteria

- [x] A server that binds successfully upserts its `{poolDir, port, pid, startedAt}` entry in the registry
- [x] Relaunching the same pool updates the existing entry rather than duplicating it
- [x] A missing or corrupt registry file is recreated on write, never a boot failure
- [x] Registry reads prune entries whose pid is dead or whose pool directory no longer exists before returning
- [x] Registry-module test seam: entry shape, upsert, corrupt-file recovery, and prune-on-read covered against temp registry paths using live and spare pids from the test process
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 23 — Engine-enforced pool lock (registration happens only after the lock passes)
- 24 — Pinned pool ports (the entry carries the resolved port)

## Notes

- Boot order: lock (23) → bind (24) → register (25). Registration after binding means the registry never advertises a port that didn't actually get bound.
- Implemented: `engine/fleet.ts` gains `upsertFleetEntry` (keyed by poolDir, recreates missing/corrupt files) and `readFleetEntries` (prune-on-read; drops dead pids and vanished pool dirs). `readFleetEntry` now reads through the pruned list. `createPoolServer` resolves poolDir to an absolute path once at the top, then upserts `{poolDir, port, pid, startedAt}` after the bind succeeds; registration is best-effort so a registry write failure never bricks a bound console. Tests live in `engine/fleet.test.ts` (module seam, temp registry paths, live `process.pid` and spawned-reaped spare pids) and a new `fleet registration` block in `engine/server.test.ts`; all booting server tests pass a temp `registryPath` so the machine-wide registry is never touched by the suite.
