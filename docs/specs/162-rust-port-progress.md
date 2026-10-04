# Rust port progress (issue #162, ticket conv-2-spawn-2)

The running log of the port: what is done, what is next, and the decisions made on the way. A resumed
Attempt or a compacted context starts here. ADR-0036 is the authority, then #162, then docs/adr/ and
CONTEXT.md.

## How the work is run

- One Ticket (conv-2-spawn-2) owns M0 to M5 on `feature/162-rust-migration`, committing straight to it.
- Subagents work in detached git worktrees at `~/.herdr/worktrees/agent-console/rust-port-<name>`, made
  by a helper that runs `git worktree add --detach` and `bun install` at the root and in `ui/`. They commit
  there on a detached HEAD; the commits are cherry-picked or merged onto the branch, so no branch is
  created. Each worktree is removed once its work has landed.
- At most about five subagents at once: the box has 12 cores, and earlier runs of about 25 parallel
  agents hit the account's usage limit.

## Status

### M0: conformance cases (TypeScript)

Baseline at c429645: 57 case files; one failing case against Bun,
"[scheduling] a result joined at exit is applied once, and the last frame agrees with /api/state".

| Area | Inventory ticket | State |
| --- | --- | --- |
| interrupts | C08 | wave 1, subagent m0-c08 |
| attempts, terminal launch | C12 | wave 1, subagent m0-c12 |
| attempts, endings and logs | C13 | wave 1, subagent m0-c13 |
| herdr panes | C15 | wave 1, subagent m0-c15 |
| config, Reassign and settings | C20 | wave 1, subagent m0-c20 |
| protocol and http outside route files | C02 | wave 2 |
| server lifecycle | C03 | wave 2 |
| restart, Tickets and Attempts | C05 | wave 2 |
| restart, Conversations and panes | C06 | wave 2 |
| Conversation Turn state and Notices | C17 | wave 2 |
| verify with Jev | C22 | wave 2 |
| the failing scheduling case | | fixed in 879b564: the case now waits for the settled frame (a read's reply can overtake a coalesced push) |

### M1 to M5

- Workspace skeleton (6 crates) at 05614ca; design at docs/specs/162-rust-port-design.md.
- Running: r-protocol (ac-protocol types, then the TypeScript generator and its tsc check), r-git (ac-io git,
  worktrees.ts, stat-cache), r-herdr (ac-io herdr client).
- Next once r-protocol commits its types: formats-a (pool files, events, streamlog, checkpoints, queued
  answers, ledger, runs/ files, Conversation records) and formats-b (console.json, Pool settings, Machine
  defaults, fleet, harness descriptors, Assignments). Briefs drafted in the session scratchpad.
- Then the foundation: F1-engine (Session, actor, start, drive, headless attempts, the success-path merge,
  persist, snapshot) and S-server (server CLI, lock, ports, routes, /api/ws) side by side; then the feature
  wave by area (see the design doc's module map).

## Decisions

(none yet)

## Hidden behaviour the M0 agents reported

What no case pins but the Rust port should copy (or decide on), as each M0 agent reported it. Port work
reads its area's entries here as well as in conformance/NOT-PORTED.md.

### config (C20)

- GET /api/state serves a stale snapshot after a hand edit of console.json: the Bun server rebuilds the
  snapshot only on an engine emit, a Reassign or a settings save. No case pins it either way.
- A non-object or non-JSON body to PUT /api/reassign answers 500; PUT /api/settings/pool answers 400 for the
  same body (recorded, not pinned). Reassign checks the request before it reads the file, so a malformed
  request against an unreadable console.json answers 400, not 500. Duplicate ids are applied once.
- The Pool title is cut to 80 characters before it is trimmed (leading whitespace counts against the 80);
  control characters are dropped after whitespace is collapsed. Worth a Rust unit test.
- console.json and defaults.json are written to a `.tmp-<pid>` file beside them, then renamed over the old
  file. When console.json stops parsing, the snapshot keeps the last good Pool title (pinned).
- NOT-PORTED.md's formats note that a spawn-assign effort makes reassign.sources.effort read unset does not
  reproduce at 7e67446: a spawned Ticket that has not run reads `requested` (the case for
  reassign.test.ts:154 pins requested).

## Notes from the Rust port agents

### ac_io::herdr (r-herdr, 1c8824d)

- A Rust future sends nothing until it is awaited or spawned: every herdr call the TypeScript fires and
  forgets (`void closeTab(...)`, `void releasePaneAgent(...).catch(() => {})`) is a `tokio::spawn` of an
  `async move` block owning a `Herdr` clone.
- AbortController is `tokio_util::sync::CancellationToken`: pass `Some(&token)` to `wait_for_pane_end`;
  dropping the wait's future also closes its subscription. ac-engine needs `tokio-util.workspace = true`.
- Only the CLI reads the environment: `default_socket_path(HERDR_SOCKET_PATH, home)` (home as Node's
  `os.homedir()`: $HOME, else the password database); `HERDR_WORKSPACE_ID` is the launch candidate for
  `resolve_pool_workspace`.
- `wait_for_pane_end` runs its liveness `pane.list` checks on detached tasks, as the TypeScript's floating
  promises did, so the daemon sees the same calls.
- `HerdrError`'s Display is the TypeScript's `err.message` exactly: no "Error: " prefix, and wrap it with
  `.context(...)` only where the TypeScript's text changed too. `is_tab_not_found` takes anything Display.
- `Herdr::rpc` returns `Option<Value>`: `None` is JavaScript's undefined, `Some(Null)` is null; they print
  differently in shape errors.
- `crates/io/src/herdr/js.rs` holds JavaScript-compatible helpers (number printing, JSON.stringify of a
  Value, String(), trim, UTF-16 length and prefix), private for now: move them to `ac_core::js` once it
  exists and point herdr at it.
- `crates/io/src/herdr/fake.rs` is a test-only port of the fake herdr; share it behind a test-support
  feature if engine unit tests need one.
- The RPC watchdog is a fixed 10 s; tests that need it to fire use `#[tokio::test(start_paused = true)]`.
- Connect failures read `connect ENOENT <path>` for every cause, as Bun 1.3.14 reports them; a label cut
  that would split a surrogate pair drops the character; a `null` entry in `agent.list` is skipped.
