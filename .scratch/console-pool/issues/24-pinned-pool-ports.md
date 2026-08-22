<!-- state: id=24 blocked-by=23 status=done -->

# 24 — Pinned pool ports

Spec: `.scratch/console-pool/spec-fleet-of-consoles.md`. Decision record: `docs/adr/0001-one-console-per-pool.md`.

## What to build

A pool's console lives at a stable, bookmarkable URL. `console.json` gains a top-level `port`. Port resolution order at boot: a `--port` CLI flag wins, then the `console.json` pin, then today's 8787-or-next-free behaviour. When a port is pinned (by flag or config) and that port is busy, boot fails loudly naming the conflicting port; only the unpinned path hunts for a free port. The `--port` flag is the one-off override — editing config for a single launch is never required.

## Acceptance criteria

- [x] A pool with `port` in its `console.json` binds that port on every launch
- [x] A busy pinned port fails loudly, naming the port — whether pinned by config or by `--port`
- [x] `--port` overrides the `console.json` pin for that launch without editing the file
- [x] A pool with no pin keeps the existing 8787-then-next-free behaviour
- [x] Server-factory test seam: each resolution-order branch covered, port conflicts exercised with real bound sockets on ephemeral ports
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 23 — Engine-enforced pool lock (both tickets edit the boot sequence; land the lock first)

## Notes

- Boot order is: lock check (23), then resolve and bind the port. The lock refusal message should report the port the live server holds, not the port the new launch wanted.
- Implemented: `engine/ports.ts` holds `DEFAULT_PORT` (8787), `validPort`, and pure `resolvePort` (flag > console.json pin > default). `createPoolServer` reads the pin from `console.json`, resolves, and binds through `bindPoolServer`: a pinned port that is busy throws `port <n> is already in use; free it or pass a different --port`; the unpinned path hunts upward from 8787 (overridable via a `defaultPort` option for tests). `runServerCli` passes `--port` through as the flag and no longer defaults to 8787 itself. `PoolConfig` gains `port?: number`.
- Review fixes (code-review, both axes clean): a failed pinned bind now clears the `runs/server.pid` it claimed, so a retry can boot (test pins this); CLI drops its own `validPort` call so `resolvePort` is the single validator and a bad `--port` exits 1 cleanly; the "every launch" test now relaunches the same pool via a stale pid.
- Verified live: config pin binds 8745; `--port 8746` overrides a config pin of 8745; a busy config pin throws naming the port; an unpinned pool with a busy default binds the next free port; `--port abc` exits 1 with a clean message. 158 tests pass (new `ports.test.ts` plus pinned-ports factory tests in `server.test.ts` using real bound sockets on ephemeral ports). Typecheck and UI build clean.
- Commit recovery (worktree protocol): this ticket's harness ran in worktree 24 on branch pool/24, so the work commit belongs there (1da30a6). An earlier session accidentally committed the same tree to main (4263f89); the resolver has since merged pool/21 and pool/17 on top of it, so main's history legitimately contains it. The engine merges pool/24 into main on read-back; the trees are identical, so that merge is clean.
