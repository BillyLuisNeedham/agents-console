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

A Terminal-backed pool gains citizens a second way, beside starting a
Conversation: **Enlist**. The operator picks a live herdr pane they opened
themselves and makes it a Ticket or a Conversation, chosen at that moment and
fixed from then on. The header's "Enlist terminal" button lists the panes
herdr reports and greys the ones that cannot be enlisted with the reason
beside them (not a checkout of this pool's repository, no harness the engine
has a descriptor for, or a pane the pool already holds). The pane, its
directory and its branch are used as found: the engine claims the pane,
relabels its tab, teaches its agent the pool's protocol as a Turn, and from
then on the card is an ordinary card, ending, merging and spawning the way
every other card does. An enlisted Ticket is minted `enlist-N` and unfinished
tickets can be ticked to wait on it; an enlisted Conversation cannot be waited
on (ADR-0018). The engine never closes the enlisted tab, never removes its
directory and never deletes its branch (see
`docs/adr/0021-enlisted-panes-stay-in-place.md`).

## Terminal-backed pools

With `terminal: herdr` in `console.json`, every attempt and every Conversation
runs as an interactive TUI in its own named herdr tab. All of a pool's tabs
open in one **Pool workspace**: the herdr workspace the server was launched in
(`HERDR_WORKSPACE_ID`), else one created for the pool, remembered in
`runs/pool-workspace.json` so a restart lands its tabs back where the operator
left them. Each attempt's pane also appears in herdr's left-hand agent list,
named for the harness and labelled with the attempt's tab label; a Conversation
shows as blocked there while it waits on the operator.

## Jev

With `TYPESAFE_API_KEY` set in the environment the Console is launched from,
the engine can put narrow, typed questions to TypeSafe's Jev (a judgement
model) where it would otherwise match strings, and the pool log says so at
boot. Without the key, or whenever Jev cannot answer, every decision takes
the heuristic path it always had (see
`docs/adr/0020-jev-gates-paths-engine-writes-status.md`).

## Run

Runtime is bun.

The everyday way in is `agent-console`, the Boot script. Run it from a project
checkout and it finds the pool (the working directory when that is a pool, the
one under the checkout's `.scratch/` when there is one, otherwise a choice or a
new one), prefills its config from the pool, a Setup and the machine defaults,
asks only for what is left, rebuilds the Console when the build is stale, starts
the server and opens the browser. It takes
`[pool-dir] [--yes] [--relaunch] [--port <n>] [--setup <name>] [--no-open]`.
`skills/link.sh` puts it on PATH; from this checkout it is `bun run boot -- <dir>`.

The pieces it drives, for running them by hand:

```sh
bun install                             # engine deps
bun install --cwd ui                    # UI deps
cd ui && bun run build                  # build the SPA into ui/dist
bun run engine/server.ts --pool <dir>   # pool server
```

The pool server binds one pool at a time and serves the built SPA, a small JSON
API, and the one WebSocket the Console talks over, `/api/ws`
(`docs/adr/0032-the-console-talks-over-one-pushed-websocket.md`). The served
page carries the first snapshot, so it paints before the socket opens; the
socket then pushes the snapshot's changes as deltas, the live values (activity,
peeks, grades) while the tab is visible, and the data of the cards the Console
subscribes to, and it carries every action and read as a request answered by
the same function as its HTTP twin. The messages are declared in
`engine/protocol.ts`, the server's side is `engine/ws.ts`, and every HTTP route
but the old `/api/stream` stays for the Steward's command, Boot and scripts.
It prints its URL (`pool server on http://localhost:<port>`); open it in a
browser. An optional `--port <n>` overrides the pinned port, and a busy pinned
port fails loudly (see `docs/adr/0001-one-console-per-pool.md`).

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
