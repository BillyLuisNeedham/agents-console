# One Console server per Pool; pools are hermetic

Running several pools means several Console server processes, one per pool, each on its own port — not one server hosting many pools. A pool's identity is its directory on disk, and no ticket edges cross pool boundaries.

We considered a single multi-pool server (one process, one port, UI switching between pools) and deferred it: multi-process already works with zero engine changes, and the real friction is discoverability, which a machine-wide fleet registry (`~/.agent-graphs/pools.json`) plus a `fleet` list command solves cheaply. Multi-process also gives fault isolation — one crashed pool run can't take others down.

Because the engine assumes exclusive ownership of its pool (checkpoint DB, line-1 state markers, git worktrees, run logs are all written non-atomically), the engine enforces one-server-per-pool itself: it writes `runs/server.pid` on boot, refuses to start if that pid is alive, and takes over if it's stale. The pid-file convention was previously advisory (launcher-only) and the failure mode was silent corruption, so enforcement lives in `createPoolServer`, not the skill.

**Consequences**: each pool pins its port in `console.json` for a stable URL; a busy pinned port fails loudly (with a `--port` override for one-offs). If window-juggling across consoles proves painful, the multi-pool server can be revisited — the refactor is bounded (the server's closure over one `poolDir` becomes a `Map<poolDir, Session>`) but nothing in the current work precludes it.
