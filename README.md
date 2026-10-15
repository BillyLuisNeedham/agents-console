# Agent Console

The Console: a UI for driving an agent graph thread. The graph is rendered as
node cards on a canvas, with interrupts answered inline. See `CONTEXT.md` for
the domain model and vocabulary.

## Layout

- `crates/`: the pool engine in Rust, one binary, `agent-console`, with `boot`,
  `server`, `steward` and `fleet` subcommands. One server process per pool
  drives the graph, writes checkpoints and ticket logs, and serves the UI and
  its API (`docs/adr/0036-port-to-rust-behind-a-black-box-conformance-suite.md`)
- `protocol/`: the wire shapes and the socket protocol as TypeScript, generated
  from the Rust types, which the UI and the conformance suite import
- `ui/`: the Console UI (Vite + TypeScript, no framework)
- `conformance/`: the server's black-box suite (`conformance/README.md`)
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

`JEV_BASE_URL` sends Jev's requests to another API root instead of
`https://api.typesafe.ai`. Leave it unset in everyday use: it exists so the
conformance suite can point the server at a fake TypeSafe endpoint and script
what Jev answers (`docs/adr/0036-port-to-rust-behind-a-black-box-conformance-suite.md`).
The SDK's own `TYPESAFE_BASE_URL` changes nothing.

## Install

You need Rust (cargo, from https://rustup.rs) to build the engine, and Bun
(https://bun.sh) to build the UI and run the suites. Bun is a development tool
only: the engine is one binary, and a release build embeds the built UI.

```sh
bun install                 # the suites' and scripts' dependencies
bun install --cwd ui        # UI dependencies
skills/link.sh              # skills, and the agent-console shim on PATH
```

## Run

The everyday way in is `agent-console`, the Boot script. Run it from a project
checkout and it finds the pool (the working directory when that is a pool, the
one under the checkout's `.scratch/` when there is one, otherwise a choice or a
new one), prefills its config from the pool, a Setup and the machine defaults,
asks only for what is left, starts the server and opens the browser. It takes
`[pool-dir] [--yes] [--relaunch] [--port <n>] [--setup <name>] [--no-open]`.
`skills/link.sh` puts it on PATH; from this checkout it is `bun run boot -- <dir>`.

### Factory mode

`agent-console --factory` boots a Factory pool, which runs one Line
(`docs/adr/0037-the-factory-is-an-engine-owned-recipe.md`). Boot cuts
`line/<slug>` from `main` into a worktree of its own at
`.scratch/lines/<slug>`, so the checkout it runs from keeps its branch, and
makes the pool inside that worktree at `<worktree>/.scratch/<name>`: the pool's
target branch is the Line's, never a shared one (ADR-0038). A Factory pool is
terminal-backed (`"terminal": "herdr"`).

- `--work <issue number or text>`, or the question Boot asks without it: Boot
  opens the Grill, a Conversation on the Grill Station's skills with the work as
  its first Turn. The Grill writes `docs/specs/<slug>.md` and
  `docs/specs/<slug>.brief.json` on its branch, and the operator presses Start
  the Line on it, which merges that branch and starts Round 1.
- `--brief <path>`: a ready Line brief and the spec it names (found from the
  working directory first, then beside the brief). No Grill: Boot commits both
  onto the Line branch as `docs/specs/<slug>.md` and `docs/specs/<slug>.brief.json`
  and starts Round 1 at once. It implies `--factory` and `--yes`, so nothing is
  asked.
- `--line <slug>` names the Line (default: the issue number, the brief's file
  name, or the work's first words); a slug already taken gets `-2`, `-3`, ….
  `--name <dir>` names the pool directory, `--title <title>` titles the pool, and
  `--config <json file>` lays its keys over the new pool's `console.json` before
  the server starts (a `steward` block, say).
- The Steward is on by default: Boot starts one once the Grill or Round 1 is
  up, and `--no-steward` starts none. It may answer a Station's "no verdict"
  checkpoint and the Prove limit, never the Finish checkpoint. It decides Held
  spawns proposed from inside the Line only while `steward.mayAdoptLineSpawns`
  is true in the pool's settings (default false).

Boot marks the pool `"factoryPool": true` in `console.json`, and a Factory pool
raises no run-wide Review: approving the Finish checkpoint is the Review. At the
Finish, Decide carries out the brief's `finish` (`none`, `draft-pr`, `pr`, or an
act it names) and writes the report to `runs/<slug>-report.html` in the pool.
The Finish checkpoint's Brief links it, the Console shows it in that checkpoint's
Detail with Open in browser, and `GET /api/line/report` serves it. The header
shows the Line (`Round 2 · Prove · fails 1/2 · Finish: draft PR`) and each card
its Station.

Unattended, for example:

```sh
agent-console --brief .scratch/pilots/186.brief.json --title "Pilot #186" \
  --config steward.json --port 8792 --no-open
```

When the Line is done, stop its pool and remove the worktree with
`git worktree remove .scratch/lines/<slug>` (and `git branch -D line/<slug>`).

`agent-console` is a shim (`bin/agent-console`) in front of the binary. Before it
hands its arguments to `target/release/agent-console boot`, it rebuilds what is
stale: the UI with Bun when `ui/dist` is missing or older than the UI's sources
or `protocol/`, then the binary with `cargo build --release` when it is missing
or older than `crates/`, `Cargo.toml`, `Cargo.lock` or `ui/dist`. Build output
goes to stderr.

The pieces it drives, for running them by hand:

```sh
cd ui && bun run build                              # build the SPA into ui/dist
cargo build --release                               # the binary, with ui/dist embedded
target/release/agent-console server --pool <dir>    # pool server
```

The pool server binds one pool at a time and serves the built SPA, a small JSON
API, and the one WebSocket the Console talks over, `/api/ws`
(`docs/adr/0032-the-console-talks-over-one-pushed-websocket.md`). The served
page carries the first snapshot, so it paints before the socket opens; the
socket then pushes the snapshot's changes as deltas, the live values (activity,
peeks, grades) while the tab is visible, and the data of the cards the Console
subscribes to, and it carries every action and read as a request answered by
the same function as its HTTP twin. The messages are declared in
`protocol/protocol.ts` (generated from the Rust types), the code that encodes,
decodes, diffs and applies them is `ui/src/protocol.ts`, the server's side is in
`crates/server`, and every HTTP route but the old `/api/stream` stays for the
Steward's command, Boot and scripts.
It prints its URL (`pool server on http://localhost:<port>`); open it in a
browser. An optional `--port <n>` overrides the pinned port, and a busy pinned
port fails loudly (see `docs/adr/0001-one-console-per-pool.md`).

`bun run fleet` lists the machine's live Consoles from the fleet registry, one
per pool, so any of them can be found.

## UI

```sh
cd ui && bun run dev       # Vite dev server
cd ui && bun run build     # build the SPA into ui/dist, which the binary embeds
cd ui && bun test          # UI unit tests
cd ui && bun run typecheck # UI typecheck
```

## Checks

```sh
cargo test --workspace                              # engine tests
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
cargo build --release && bun run conformance        # the black-box suite against the binary
bun test                                            # the suites' and bench's own tests
bun run typecheck                                   # conformance, scripts and protocol typecheck
```

`protocol/*.ts` is generated: after changing the Rust types in
`crates/protocol`, run `cargo run -p ac-protocol --bin gen-typescript --
protocol`, and a test fails until the checked-in files match.
