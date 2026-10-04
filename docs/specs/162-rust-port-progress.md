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
- At most four subagents at once, and none of them spawns helpers of its own. On 2026-10-04 eight
  agents, several with helper agents, used up the account's usage window in about 1 h 45 min (reset at
  14:50 BST); every agent paused mid-work and was woken with SendMessage after the reset.

## Status

### M0: conformance cases (TypeScript)

Baseline at c429645: 57 case files; one failing case against Bun,
"[scheduling] a result joined at exit is applied once, and the last frame agrees with /api/state".

| Area | Inventory ticket | State |
| --- | --- | --- |
| interrupts | C08 | landed (588d76d..63102a3), 48 cases |
| attempts, terminal launch | C12 | landed (1f8a9b2..e54c5bc), 66 cases |
| attempts, endings and logs | C13 | wave 1, subagent m0-c13 |
| herdr panes | C15 | wave 1, subagent m0-c15 |
| config, Reassign and settings | C20 | landed (7e67446), 68 cases |
| protocol and http outside route files | C02 | wave 2, subagent m0-c02 |
| server lifecycle | C03 | landed (490a174..e890464), 37 cases |
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

### interrupts (C08)

- The persist backoff is 50, 100 and 200 ms (4 attempts). Persists in the answer drain and in Keep talking
  get no retry: a drain failure leaves memory changed with no emit; a Keep talking failure is swallowed and
  the claim stands. Answering PERSISTENCE while console.db is still locked answers 400
  `{"error":"database is locked"}`, records the answer (answered event plus an unprocessed queued record),
  and clears the Interrupt in memory with no emit and no drive (pinned).
- A Continued attempt's ending check runs every 2 s: the Outcome first, then the exit-code file, then
  herdr's pane listing; a failed listing says nothing about the pane.
- acceptAnswer's checks run in this order: attempt and adopt; the retry lookup when nothing is pending; the
  close kinds; close on a non-Ticket ("answer: <id> is not a Ticket in this pool; only a Ticket can be
  closed"); approve/reject for the review gate and merge-approvals; the duplicate ack; a different answer
  already queued (409); a reject naming no ticket; selection naming. The server's own approve/reject guard
  reads the Interrupt kind from the snapshot it last served.
- A Close is drained even while a Continued attempt holds the pool checkout.
- Keep talking's "lost its terminal" and "lost its agent" refusals are dead code in the TypeScript (pinned
  as "has no terminal left to continue in").

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

### ac_io::git and ac_core::stat_cache (r-git, d94eec5..b8b3947)

- worktrees.ts split into `git/worktrees.rs` (keys, naming, worktree lifecycle, merge checkout, ref stamp)
  and `git/merge.rs` (merge_branch and helpers); `runner.rs` (`git`/`git_async` give trimmed
  `GitProbe {ok, out, err}`; `run_git`/`run_git_async` give raw `GitOutput`), `repo.rs`, `diffs.rs`
  (`activity_diff`, `branch_diff`, `diff_stat_summary`), `boot.rs` (Boot's git reads). `git/mod.rs` opens
  with tables of every TypeScript git call site and the Rust function serving it.
- Ported from engine.ts already: mergeInPlace, mergeInCheckout, withMergeCheckout (`with_merge_checkout`,
  body gets the cwd as `&str`), removeEnlistedBranch (`restore_found_branch`), repoRootOf, the git half of
  attemptDiff. Left for M3: the merge-hold probe and memo, the Ticket-file reconcile (its git parts are
  `merge_base`, `show_file`, `merge_file`). Left for M4: the activity diff's 1.5 s TTL cache.
- `pool_key_for` is total (hashes the given path when realpath fails); the functions that change disk use
  `try_pool_key_for`, which fails first with Bun's lstat ENOENT text, as the TypeScript does.
- `node.rs` holds crate-private JS/Node helpers (trim, Number, path join and relative, realpath, Bun's fs
  error texts): candidates for `ac_core::js` together with herdr's `js.rs`.
- engine.ts:10279-10281's enlist capture ports as `pane_top.is_some() && pane_top == cwd_top`.
- `merge_file`: an exit code above 127 is git's error, `None` is killed by a signal.
- This box's git config enables rerere (autoupdate): a conflict's stderr starts "Recorded preimage", which
  becomes `MergeResult.detail`; tests must not assume the CONFLICT lines come first.

### attempts, terminal-backed launch (C12, 1f8a9b2..e54c5bc)

- The fake herdr gained `noRootPane`, `keyFrames`, `failFrom`, and an `at` on every recorded call.
- A terminal-backed attempt's derived log carries util-linux script's own "Script started on ..." (and
  "Script done ...") lines; script writes its header only on the harness's first output or its exit, so a
  silent TUI leaves the log empty. Cases pin the harness's lines and the frame block, never script's.
- GET /api/log?stream=1 serves the Stream file with ANSI stripped (seen, not pinned).
- An attempt botched in all three tabs never reports its pane's agent but still releases it (inference).
- A tab.create answer without root_pane leaves two tabs open that nothing closes.
- Rust unit tests implied: the frame block keeps the last 19 lines; the trust seed writes both the path
  and its realpath when they differ; readiness needs 3 matching reads 500 ms apart; a dialog still up 4
  polls after its answer ends the wait; a harness without a descriptor gets the wrapper and nothing typed.

### server lifecycle (C03, 490a174..e890464)

- Pool lock (runs/server.pid): O_EXCL create; a dead holder is removed only if a re-read still names the
  same pid; an empty lock gets a 25 ms beat and is cleared if still empty; give up after 5 attempts. On
  release, remove the file only if it still names our own pid.
- A start refused after the lock (an unloadable Ticket file, a --port or console.json port out of range)
  exits 1 and leaves runs/server.pid naming its dead pid (pinned); the next start takes it over. With
  verify 0 the drive refuses its first load only after the bind and the registration: exit 1 (unhandled
  rejection, no boot line), lock and registry entry left behind (pinned).
- Fleet write: O_EXCL `pools.json.lock`; a live holder is polled every 10 ms for up to 10 s, then the write
  fails; a dead holder's lock is cleared at once; an empty lock only once that deadline passed. Written to
  pools.json.tmp then renamed; the lock released in a finally. The registry is never pruned on write; only
  malformed entries are dropped and unknown keys survive (keep it as serde_json::Value). A stopping server
  never touches the registry. pidIsLive counts EPERM as alive. Entries match by exact string equality on
  the lexically resolved poolDir (steward-cli compares realpaths). The live-registry-lock message reads
  "fleet registry: fleet registry: lock ..." on Bun (only the prefix is pinned).
- --port is read with JavaScript's Number: "abc" says "got NaN" (pinned); "" boots on any free port; 0x10
  and 1e3 read as 16 and 1000 (not pinned).
- The boot line prints --pool exactly as given; everything else uses the resolved path. It is printed only
  after the drive's first load succeeds.
- Shutdown has a 15 s hard limit: past it the server exits 1 and skips the Boot hand-off. The Boot a
  Restart relaunches opens the browser again (no --no-open passed).
