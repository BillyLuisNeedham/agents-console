<!-- state: id=26 blocked-by=25 status=done -->

# 26 — Fleet list command

Spec: `.scratch/console-pool/spec-fleet-of-consoles.md`.

## What to build

A thin CLI entry beside the server (not a flag on it) that answers "what's running": it reads the fleet registry (prune-on-read from ticket 25 applies, so dead servers and deleted pools never appear) and prints one line per live pool as `poolDir → http://localhost:<port>`. The command is strictly read-only — it never starts, stops, or signals anything. An empty registry prints a clear "no live consoles" line rather than nothing.

## Acceptance criteria

- [x] Running the command lists every live pool with its URL, one per line
- [x] Dead-pid and missing-poolDir entries are pruned and never printed
- [x] An empty or absent registry prints a clear no-live-consoles message and exits zero
- [x] The command never mutates server or pool state beyond the prune
- [x] Test seam: listed output and pruning covered against a temp registry with live and spare pids
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 25 — Fleet registry, written on start (the registry module and its prune-on-read are the command's whole substrate)

## Notes

- Keep the output script-friendly: plain lines, no decoration, so it composes with `xargs open` and friends.
- The spec file `spec-fleet-of-consoles.md` does not exist in this worktree's `.scratch/`; it lives in the main repo's `.scratch/console-pool/` (gitignored, not carried into worktrees). Read it from there; its content is the authority.
- Design: new `engine/fleet-cli.ts` beside `engine/server.ts`, run as `bun run engine/fleet-cli.ts [--registry <path>]`. The `--registry` flag is the test seam so the suite never touches `~/.agent-graphs/pools.json` (same reason every server test passes a temp `registryPath`). Output is exactly `poolDir → http://localhost:<port>` per live pool, and `no live consoles` when nothing is live, exit 0. No-live-consoles message goes to stdout per the spec's "prints a clear 'no live consoles' line" wording.
- Prune is read-time (ticket 25's `readFleetEntries`), so the command never rewrites the registry; the read-only test pins that the file is byte-identical after a run.
