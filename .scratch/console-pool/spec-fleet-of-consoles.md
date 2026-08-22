# Spec: A fleet of Consoles — several pools running concurrently

Status: agreed in grill session, written locally (no tracker). Apply `ready-for-agent` if published later.

## Problem Statement

Billy wants several ticket pools in flight at once — today that means remembering which port each Console landed on, hoping "8787 or next free" didn't drift, and trusting a pid-file convention that nothing actually enforces. Two servers can silently bind the same pool and corrupt its checkpoints, markers, and worktrees. And when he comes back to the machine, there is no way to see which pools are running or where to open them.

## Solution

Multi-console becomes a first-class, safe way of working. Each Console server keeps binding exactly one pool (per ADR 0001 — the multi-pool single-server direction is deliberately deferred), but three things make a fleet of them practical:

1. **The engine enforces one server per pool.** The engine writes `runs/server.pid` itself on boot, refuses to start if that pid belongs to a live process, and takes over if it's stale. The advisory convention in the launcher skill is replaced by a guarantee in `createPoolServer`.
2. **Pools pin their ports.** `console.json` gains a `port`; a pool always lives at the same URL. A busy pinned port fails loudly, naming the conflict; a `--port` CLI flag overrides for one-off launches. Next-free remains the fallback when no port is pinned.
3. **A fleet registry makes consoles findable.** Each server records itself in `~/.agent-graphs/pools.json` on start. A new `fleet` CLI command lists live pools with their URLs, pruning entries whose pid is dead or whose pool directory no longer exists — so crashes and deleted pools never leave phantom entries.

The `my-console-runner` skill is updated to match: it writes `port` into the pools it configures and stops writing the pid file itself (the engine owns that now).

## User Stories

Safety:

1. As Billy, I want the engine to refuse to start when its pool already has a live server, so that two consoles can never silently corrupt one pool's checkpoints, markers, or worktrees.
2. As Billy, I want the refusal message to name the live process and its port, so that I know where the running console is instead of hunting for it.
3. As Billy, I want a stale pid file to be taken over automatically, so that a crashed or killed server never bricks its pool.
4. As Billy, I want the engine to write its own pid file on boot, so that direct launches — not just skill launches — are covered by the lock.
5. As Billy, I want no `--force` escape hatch, so that the answer to a live lock is always "use the running console or kill it", never "corrupt the pool a little".

Stable identity:

6. As Billy, I want to pin a pool's port in its `console.json`, so that a pool's console always lives at the same bookmarkable URL.
7. As Billy, I want a busy pinned port to fail loudly with the conflicting process named, so that drift is surfaced, not silently absorbed by next-free.
8. As Billy, I want a `--port` CLI flag that overrides the pin for one launch, so that one-off situations don't require editing config.
9. As Billy, I want next-free behavior preserved when no port is pinned, so that quick throwaway pools still launch with zero configuration.

Discoverability:

10. As Billy, I want every console server to register itself in a machine-wide registry on start, so that there's one place recording which pools are live.
11. As Billy, I want a `fleet` command that lists live pools with their URLs, so that finding my consoles is one terminal command from wherever I am.
12. As Billy, I want dead entries — crashed servers, deleted pool directories — pruned automatically when I list, so that the registry never cries wolf.
13. As Billy, I want the registry to live outside any repo, so that pools in different repos all show up in one fleet.

Skill interop:

14. As Billy, I want my-console-runner to write the pinned port into `console.json` when it configures a pool, so that pools I set up through the skill get stable URLs without a manual edit.
15. As Billy, I want the skill to stop writing the pid file, so that there's exactly one writer of the lock the engine enforces.
16. As Billy, I want relaunching an already-running pool through the skill to point me at the live console, so that the skill and the engine tell the same story.

## Implementation Decisions

- **Lock enforcement lives in the server factory, not the skill.** Boot sequence: read `runs/server.pid` from the pool directory; if the pid is alive, exit non-zero with a message naming the pid, its port (from the fleet registry if known), and the pool directory; if stale or absent, write our own pid and continue. Liveness is a `kill(pid, 0)`-style probe. No `--force` flag.
- **Port resolution order**: `--port` CLI flag > `console.json` `port` > 8787-then-next-free. A pinned port (from either of the first two) that is busy is a hard failure naming the holder; only the unpinned path hunts for a free port.
- **Fleet registry** is a JSON file at `~/.agent-graphs/pools.json`, entries `{poolDir, port, pid, startedAt}`. Servers upsert their entry after successfully binding. There is no server-side exit handler — cleanup would be unreliable under kill -9, so hygiene is entirely prune-on-read. Registry writes tolerate a missing/corrupt file (recreate) and prune-on-read drops entries whose pid is dead or whose `poolDir` no longer exists on disk.
- **New `fleet` CLI entry** (a thin script beside the server, not a flag on it): reads the registry, prunes, prints live pools as `poolDir → http://localhost:<port>` lines. Read-only; it never starts or stops anything.
- **Skill updates** (my-console-runner): the interview gains a port answer written as `port` in `console.json` (suggesting 8787 or next free at setup time); the launch phase stops writing `runs/server.pid` and instead relies on the engine's refusal when the pool is already live, surfacing that refusal to the user.
- **Concurrency between servers on different pools** needs no changes — they share nothing on disk. Cross-pool ticket edges remain out of the model (ADR 0001).

## Testing Decisions

- Two seams. The existing top seam — the server factory against temp pool directories, per the prior art in the server and engine test suites — covers lock behavior: live-pid refusal, stale-pid takeover, self-written pid, pinned-port conflict, and `--port` override are all asserted through boot outcomes and error messages, never internals.
- One new seam, kept small: a fleet-registry module whose functions take the registry path (defaulting to the machine-wide location, overridable in tests). Tests assert the entry shape written on registration and prune-on-read against dead pids and missing pool directories, using temp files and live/spare pids from the test process itself.
- Only external behavior is tested: boot success/refusal, files written, error text, printed fleet list. No probing of in-memory server state.
- Port-conflict tests use real bound sockets on ephemeral ports — no mocking of the network layer.
- The skill changes are conventions over files (what gets written into `console.json`, what no longer gets written); they're covered by the skill's text and manual launch, not an automated suite, matching how the skills are tested today.

## Out of Scope

- A single multi-pool server or in-app pool switching (deferred per ADR 0001; the refactor path is recorded there).
- Cross-pool ticket dependencies of any kind.
- A fleet landing page or any browser-side fleet UI — the CLI list is the whole interface for now.
- Stopping, restarting, or otherwise managing consoles from the fleet command — it lists, nothing more.
- Server-side registry cleanup on exit (prune-on-read replaces it deliberately).
- Changes to how pools execute tickets — engine run semantics are untouched.

## Further Notes

- The registry location is machine-wide (`~/.agent-graphs/`) because pools are not tied to this repo; the engine is versioned here but the pools it drives live anywhere.
- Prune-on-read means the registry is allowed to be stale between reads; that's a feature — no lifecycle hooks, no crash-safety problem.
- Deliberately deferred: `--force` lock override (add when a legitimate need appears), registry entry metadata beyond the four fields (ticket counts, run phase — add when the list command needs to be a dashboard).
