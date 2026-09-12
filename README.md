# Agent Console

The Console: a UI for driving an agent graph thread. The graph is rendered as
node cards on a canvas, with interrupts answered inline. See `CONTEXT.md` for
the domain model and vocabulary.

## Layout

- `engine/`: the pool engine, one Bun process per pool drives the graph, writes
  checkpoints and ticket logs, and serves the UI and its API
- `ui/`: the Console UI (Vite + TypeScript, no framework)
- `docs/adr/`: architecture decision records
- `CONTEXT.md`: the domain glossary

## Skills

The repo's agent skills live in `skills/`. `scripts/link-skills.sh` links them
into the local agent harnesses — symlinks into `~/.claude/skills` and
`~/.agents/skills`, real copies into `~/.cursor/skills`, and OpenCode command
stubs. Run it once after cloning and again after adding or removing a skill.

## Pools

A pool is the set of tickets one Console run works, identified by its directory
on disk. One Console server binds one pool at a time. A pool directory holds:

- `issues/`: one markdown file per ticket, each opening with a line-1 state
  marker (`<!-- state: id=.. blocked-by=.. status=.. -->`), then a title
  heading and the ticket's spec
- `console.json`: optional config, pins the port and per-ticket assignments
- `runs/`: created by the engine, holds checkpoints, per-ticket event logs, and
  the rotated attempt logs
- `conversations/`: one markdown file per Conversation, created when the first
  one starts. A Conversation is an open-ended talk with one agent in a herdr
  tab; it may Spawn tickets and other Conversations mid-run, and is told in a
  Notice when a spawned ticket ends. Requires `terminal: herdr` in
  `console.json` (see `docs/adr/0018-conversations-beside-tickets.md`)

## Run

Runtime is bun.

```sh
bun install                             # engine deps
bun install --cwd ui                    # UI deps
cd ui && bun run build                  # build the SPA into ui/dist
bun run engine/server.ts --pool <dir>   # pool server
```

The pool server binds one pool at a time and serves the built SPA, a small JSON
API, and an SSE stream pushing a state snapshot on every change. It prints its
URL (`pool server on http://localhost:<port>`); open it in a browser. An
optional `--port <n>` overrides the pinned port, and a busy pinned port fails
loudly (see `docs/adr/0001-one-console-per-pool.md`).

`bun run fleet` lists the machine's live Consoles from the fleet registry, one
per pool, so any of them can be found.

## UI

```sh
cd ui && bun run dev       # Vite dev server
cd ui && bun run build     # build the SPA into ui/dist, which the pool server serves
cd ui && bun test          # UI unit tests
cd ui && bun run typecheck # UI typecheck
```

## Checks

```sh
bun test             # engine tests
bun run typecheck    # engine typecheck
```
