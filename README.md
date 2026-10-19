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

### Line mode

`agent-console --plan <slug>` boots a pool that runs one Line on a Plan
(`docs/adr/0040-the-factory-runs-a-plan-the-operator-builds.md`). A Plan is a
graph of nodes and edges saved as a file. The engine reads each node's verdict
and starts whatever the Plan's edges name next. Agents never choose what runs
next.

Boot cuts `line/<slug>` from its Line base, the branch the checkout has out (or
the one `--from` names), into a worktree of its own at `.scratch/lines/<slug>`,
so the checkout it runs from keeps its branch. It makes the pool inside that
worktree at `<worktree>/.scratch/<name>`, so the pool's target branch is the
Line's, never a shared one (ADR-0038). A Line pool is terminal-backed
(`"terminal": "herdr"`).

#### Plans

A Preset is a Plan built into the Console. It is read-only and names its author
and the file the flow comes from. Saved under a new name, it becomes a Plan in
your Plan library, one file per Plan in `~/.agent-graphs/plans/<slug>.json`.
Boot offers the Presets first, then the library.

| Preset | Flow from |
| --- | --- |
| `factory-today` | Agent Console: Grill, Implement, Prove, Review, Decide, Finish (the default) |
| `matt-pocock-main`, `matt-pocock-quick`, `matt-pocock-bug`, `matt-pocock-foggy` | Matt Pocock |
| `pstack-feature`, `pstack-bug-fix` | Pstack (Lauren Tan) |
| `pclaude-feature`, `pclaude-bug-fix` | PClaude |
| `addy-commands`, `addy-bug-fix` | Addy Osmani |

Build, edit, save and boot a Plan from the **Plans** button in the Console's
header or from Settings. The view marks every problem on the node or edge that
causes it, and a Plan that has problems cannot be saved or booted. A Line copies
its Plan into `line.json` when it starts, so editing the Plan afterwards never
changes a running Line.

Each node of a Plan is one of these:

- A **Conversation node** opens a Conversation for each pass and hands on when
  the operator ends it.
- A **Ticket node** runs Tickets. Its kind sets the verdicts it can give (Agent,
  Prove, Review or Decide). It runs `one` copy, or one copy per Item (a
  per-item node). A per-item node runs at most its cap of copies at once, and
  the Items over the cap queue and start as copies finish. The Plan places a
  **Merger** after each per-item node. The Merger hands on once every copy has
  merged, and on a merge conflict it runs a resolver or waits for you.
- A **Gate** runs no agent. You, the Steward or nobody (`auto`) opens it.
- The **Finish** is the one node every Line ends at (below).

The engine names a node's passes `<node>-<n>`, so the first Implement pass is
`implement-1`, its second is `implement-2`, and the first Finish hold is
`finish-1`. Tickets and Conversations carry those ids on their cards.

#### Using it

Before the first Line on a machine:

- herdr is running, and the harness your Plan's nodes use (claude by default) is
  on PATH.
- The skills your Plan names are in `~/.claude/skills`. `factory-today` uses
  `my-grill-with-docs`, `tdd`, `my-verify`, `code-review` and `html`. Run
  `skills/link.sh` for this repo's own skills, including `my-console-steward`.
- The checkout Boot runs from has a branch out (not a detached HEAD), or
  `--from` names one. Boot cuts the Line from it and never fetches first.
- For a `draft-pr` or `pr` Finish, `gh` is logged in with push rights on the
  project.

A Line from an issue, with the operator in the room:

1. From the project's checkout, run
   `agent-console --plan factory-today --work 123`. You can give free text
   instead of an issue number, and without `--plan` Boot asks "start from which
   plan" and takes `factory-today` on Enter. Boot cuts `line/123`, opens the
   Console and hands the engine the work.
2. Talk to `grill-1`. The engine opens the Plan's entry Conversation node on its
   Assignment and skill, with the work as its first Turn. The Conversation writes
   the spec to `docs/specs/<line>.md` and a Line brief to
   `docs/specs/<line>.grill-1.brief.json` on its own branch.
3. End the Conversation from the Console. **End** is refused, with the reasons
   shown, while the branch holds no valid brief and spec. **End as closed**
   merges nothing and sends the Line straight to its Finish.
4. The engine merges the Conversation's branch, reads the brief and hands on to
   the Plan's next nodes (`implement-1` in `factory-today`). The brief sets the
   Finish act, `none` by default, so say if you want `draft-pr` or `pr`. It can
   also override a node's Assignment or note for this one Line, and it hands
   Items to a per-item node.
5. You answer only what the Plan hands you. A Ticket node that ends without a
   valid verdict raises a "no verdict" checkpoint, which you can Resume or reach
   with Keep talking. A loop whose cap is spent holds the Line (in
   `factory-today`, Prove failing twice holds as
   `prove-fail-implement-3`). Resume buys one more crossing of the loop, and
   Close halts it. An operator Gate holds as a Ticket you Resume to open, Resume
   with notes to send the notes on, or Close.
6. When the work is shipped, or a node hands on `closed`, the Line reaches the
   Finish (see The Finish below).
7. When the Line is done, stop the pool and remove its worktree (below).

A Line from a spec you already have: write the spec, and a Line brief beside it
such as `{"spec": "docs/specs/123.md", "finish": "draft-pr"}`. Then run
`agent-console --brief path/to/123.brief.json`. There is no Conversation: the
engine absorbs the brief at once and starts the Plan's entry Tickets, and
nothing is asked. A Plan with no Conversation node at its entry gets the brief
applied to the Line directly. This is the way to run a Line unattended (see the
example below).

#### The Finish

When a verdict reaches the Finish, the Line is finishing. It cannot complete
while any copy runs or queues, any Gate or spent loop holds, a Conversation pass
is open, a Ticket is unmerged, or a Held or Pending spawn waits. The Console
lists whatever it still waits for. When that list is empty, the engine writes the
Finish hold `finish-1`. Read the report in the hold's Detail, which shows the
Decide node's `runs/<line>-decide-<n>-report.html` when the Plan has one, and
answer:

- **Resume** approves the Line. Approving while anything still blocks is refused
  with the list.
- **Resume with notes** hands the notes on along the Finish's `revise` edge (in
  `factory-today`, back to Implement) and is refused when the Plan gives the
  Finish no such edge.
- **Close** ends the Line closed.

Nothing leaves the pool before you approve. After approval, the Finish act
runs. `none` ends the Line at once. `draft-pr`, `pr`, `fast-forward` or free text
runs one Finish Ticket, `finish-1-act`. It deletes the spec, the briefs and
`.verify/` in a final commit and pushes the Line's branch. Then it opens the PR
against the Line base, fast-forwards the base, or does what the free text says.
For `pr` and `draft-pr` it checks the base on `origin` first. It pushes the base
only when the brief sets `"pushBase": true`, and then only to create it or
fast-forward it, never forcing. Without the grant, a base `origin` lacks means no
PR. The Line is done once that Ticket has merged.

Boot writes the Line base into the pool's `console.json` as
`"lineBase": {"ref": "experiment/x", "commit": "<sha>"}` and prints
`line: cut line/<slug> from experiment/x (<short sha>)`. The run copies it into
`line.json`'s `base`. Review diffs from that commit, and a PR's base is the Line
base's branch on `origin`. A Line pool raises no run-wide Review, because
approving the Finish is the Review. `GET /api/line/report?node=&pass=` serves a
Decide pass's report.

#### The Steward

A Line pool starts a Steward by default, and `--no-steward` starts none. Its
powers on a Line are opt-in, set by the Plan. It answers a checkpoint only on a
Ticket node set to `checkpoint: steward`, opens only a Gate set to
`open: steward`, and gives a spent loop one extra pass only when the loop's edge
is marked `stewardExtra`. It edits the running Plan only when the Plan sets
`stewardEdits`. Otherwise it steers the Line through the nodes as drawn. It
never answers the Finish. It decides Held spawns proposed from inside the Line
only while `steward.mayAdoptLineSpawns` is true in the pool's settings (default
false).

#### Boot flags

- `--plan <slug>` enters Line mode on a Preset or a Plan in your library. Without
  it, `--work` alone enters Line mode and Boot asks which Plan, with `--yes`
  taking `factory-today`.
- `--work <issue number or text>`, or the question Boot asks without it: the
  piece of work. The engine opens the Plan's entry Conversation node on it. A
  Plan whose entry is a Ticket node starts that node's Tickets on it.
- `--brief <path>`: a ready Line brief and the spec it names (found from the
  working directory first, then beside the brief). Boot commits both onto the
  Line branch as `docs/specs/<slug>.md` and `docs/specs/<slug>.brief.json` and
  begins the Line at once. It implies Line mode and `--yes`, so nothing is asked,
  and takes `factory-today` unless `--plan` names another Plan. `--work` and
  `--brief` together are refused.
- `--from <branch>` cuts the Line from that branch instead of the current one:
  a local branch, else origin's as written (`origin/x`), else origin's by its
  name there. Another remote's branch, `HEAD`, tags and commits are refused. The
  branch may be checked out in another worktree. The Line's branch never tracks
  it.
- `--line <slug>` names the Line (default: the issue number, the brief's file
  name, or the work's first words). A slug already taken gets `-2`, `-3`, and so
  on. `--name <dir>` names the pool directory, `--title <title>` titles the pool,
  and `--config <json file>` lays its keys over the new pool's `console.json`
  before the server starts (a `steward` block, say).
- `--no-steward` starts no Steward.

Unattended, for example:

```sh
# steward.json: {"steward": {"budget": 10, "mayAdoptLineSpawns": true}}
agent-console --plan factory-today --brief docs/specs/123.brief.json \
  --title "Issue #123" --config steward.json --port 8792 --no-open
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
