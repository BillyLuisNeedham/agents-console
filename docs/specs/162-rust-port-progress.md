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
| attempts, endings and logs | C13 | landed (1e39261), 30 cases |
| herdr panes | C15 | landed (eecd384..1bee44e), 42 cases |
| config, Reassign and settings | C20 | landed (7e67446), 68 cases |
| protocol and http outside route files | C02 | wave 2, subagent m0-c02 |
| server lifecycle | C03 | landed (490a174..e890464), 37 cases |
| restart, Tickets and Attempts | C05 | landed, 55 cases |
| restart, Conversations and panes | C06 | wave 2 |
| Conversation Turn state and Notices | C17 | wave 2 |
| verify with Jev | C22 | wave 2 |
| the failing scheduling case | | fixed in 879b564: the case now waits for the settled frame (a read's reply can overtake a coalesced push) |

### M1 to M5

- Workspace skeleton (6 crates) at 05614ca; design at docs/specs/162-rust-port-design.md; wire shapes
  research at docs/specs/162-rust-port-wire-shapes.md.
- Landed: ac_io::herdr (1c8824d), ac_io::git and ac_core::stat_cache (d94eec5..b8b3947), ac-protocol types
  (2e17992; the TypeScript generator and its tsc check still to come from r-protocol).
- Running: r-protocol (generator), r-formats-a (pool files, events, streamlog, checkpoints, queued answers,
  ledger, runs/ files, Conversation records, ac_core::js), r-formats-b (console.json, Pool settings, Machine
  defaults, fleet, harness descriptors, Assignments).
- Next: the foundation, F1-engine (Session, actor, start, drive, headless attempts, the success-path merge,
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

### herdr panes (C15, eecd384..1bee44e)

- The fake herdr gained `closeTab(tabId)`, `relistPane(paneId, listing)` and `answerWith(method, reply)`.
- The bulk close (POST /api/terminals/close-finished) and Keep talking list through the same pane survey
  the snapshot derives from, and their listing updates Held panes and the Finished terminals count exactly
  as a cadence listing does; cases use them as on-demand listing triggers instead of the 15 s cadence. A
  bulk close with its own one-off listing fails them.
- At boot, holding a checkpointed pane (seedHeldPanes) asks the survey for a listing at once.
- A Held pane let go by a listing (gone, listed differently, TUI exited) stays let go; if a later listing
  shows it again, its tab becomes a Finished terminal, never held again (pinned).
- Hidden, Rust unit tests: opened tabs and enlisted terminals are recomputed only when the survey lists
  (inside its list callback); the untouchable panes (live, held, Conversations, registered) at every emit.
  A failed listing still refreshes the opened tabs while the old listing stays. The snapshot's Held panes
  check the TUI's exit-code file at every emit, but the hold itself is deleted only at a listing (or Keep
  talking's refresh).
- Crash Interrupts join at the super-step boundary (a live sibling holds them back); checkpoints join at
  exit and hold their pane at once.
- The bulk close records each tab-closed on the owner's latest attempt, with the terminal id of the last
  spawn that named the tab (pinned).
- For the operator to judge before the port copies them (recorded in NOT-PORTED.md): a tab.close refused
  outside the bulk close writes its pool-log line without emitting a snapshot; the enlist teaching Turn
  checks its paste with `recent` 200-line reads of the operator's pane, which moves their viewport.
- Known load flakes outside C15: attempts-argv "a terminal-backed launch runs each harness's interactive
  argv" (timed out waiting for launches); engine attempt-run.test.ts "surfaces a botched spawn".

### restart, Tickets and Attempts (C05)

- Restart cases that start more than one server are takeover cases: each later server runs the next leg
  of CONFORMANCE_LEGS, so `--legs bun,rust` has Rust boot on what Bun left.
- merge-hold.test.ts:536 is a Rust unit test: boot never re-adopts a resolver's pane (`terminalAdoptable`
  gives a resolver the headless orphan fate), so after a restart the Ticket reads needs-you.
- On macOS a reused pid is stopped as an orphan: with no procfs, `orphanIsLive` trusts liveness alone and
  boot TERMs then KILLs the process group of whatever now holds the recorded pid. Rust should check the
  working directory on every platform (unit test drafted in NOT-PORTED.md).
- A server whose store refuses every write still stops cleanly (exit 0, lock released) with no checkpoint
  row; the next boot runs from the state lines alone (pinned).
- children.test.ts:76 is a Rust unit test: a child registered after shutdown began gets TERM sent to its
  process group as it arrives.

### attempts, endings and logs (C13, 1e39261)

- The fake herdr gained `closePane`, `delistPane`, `hangUpSubscribers`, `listedPanes`,
  `endPaneOn(method, paneId, nth)` and `HerdrProcess.kill()` (C15's `closeTab` serves both tickets).
- A pane leaving herdr's listing is noticed only by the ending's 30 s liveness sweep, which lists every
  workspace's panes (`pane.list {}`); a refused listing is skipped, a dropped or hung-up subscription is
  not an ending, and the wait is never re-subscribed or clock-bounded. A pane gone from the listing gets
  a 10 s grace (the exit-code file polled at 250 ms) before pane gone (-2).
- A pane that ends with no exit-code file is exit code unreadable (-1) about 2 s later: readExitCode
  retries 10 times at 200 ms.
- The Bun server subscribes to pane ends twice per launch: once for readiness (let go before the paste),
  once for the ending; on the ending subscription's ack it lists panes once (catches a pane already gone).
- The wrapper's send removes a stale exit-code file and Stream file first (pane-session.ts:314).
- A terminal-backed log is cut at the Attempt's end: the tailer drains once at the ending, so output after
  the Outcome (and script's "Script done on" footer) never reaches runs/<id>.log or the logTail.
- An Outcome valid when the pane ends wins: the ending re-reads the result before calling it a crash.
- In stream mode stderr goes through the same stream-json deriver as stdout (not pinned); raw-mode logs
  (opencode) are written chunk by chunk with no line splitting (pinned).
- Rust unit tests: an exit-code file landing inside the grace window ends with the file's code, never pane
  gone; the stream and transcript line buffers reassemble a line, a UTF-8 character and an escape
  sequence split across two chunks, exactly once.
- Known race in tests reading "notice delivered" events: the fake records the submitted Turn before the
  engine appends the event (steward.test.ts engine tests; conformance steward/notices "a Steward enlisted
  beside a checkpoint is told it once ...").

### ac-protocol (r-protocol, 2e17992..bacc23b)

- Every wire type and protocol.ts in `crates/protocol/src/{wire,protocol}.rs`, re-exported at the crate
  root; serde helpers in `json.rs` (`True` for `ok: true`, `js_number` for floats so 8 prints 8,
  absent/null/set as `Option<Option<T>>`, `Unchecked<T>` for raw passed-through values); declare new wire
  types with `wire_struct!`, `wire_enum!`, `wire_union!` so the generator covers them.
- `ac_protocol::typescript::generate()` writes wire.ts and protocol.ts (`cargo run -p ac-protocol --bin
  gen-typescript -- <dir>`); `crates/protocol/tests/typescript.rs` checks them against engine/wire.ts and
  engine/protocol.ts with the repository's tsc (identical types both ways, export names, the UI's strict
  settings, constant values). Real Bun frames and bodies in `crates/protocol/testdata/bun` round-trip
  byte for byte.
- Left to others: the snapshot diff and its hidden rows protocol.test.ts:161 and :169 (ac-core or the
  server), the envelope decode (server). The server checks the envelope on a `serde_json::Value` and hands
  the raw payload to the handler (a bad payload is a 400 refusal, as ui/src/protocol.ts does), never a
  typed decode into ClientMessage.
- Typed as declared, not reproduced: `?offset=abc` giving null offsets, a missing or non-string
  `lastEventAt`, extra keys on hand-written event lines (the server should pass event lines through as
  raw JSON to keep them).

### config and Assignments in ac-core (r-formats-b, 7813eac, 8b79dfa)

- Modules: `config` (console.json, the live config `PoolConfig` = raw JSON with JavaScript's undefined
  slots, `reload_candidate`, accessors documented against the TypeScript reads), `pool_settings`
  (validation and saves on raw values with the TypeScript's messages; `write_config_atomically`, which
  Reassign must use too; the settings payload, stale-key badge, relaunch port, Restart answer),
  `pool_title`, `machine_defaults`, `fleet`, `harness` (spawn.ts, renamed so it is not confused with
  Spawns), `spawn_caps`, `assignment` (every resolution path, `resolve_pool_assignments` never fails a
  ticket, `resolve_unseen_assignments` is all or nothing), `steward` (the console.json entry only).
- Never use the typed `ac_protocol::PoolConfig` in the engine or server; change the live config with
  `set`, `remove` and `set_undefined`, which keep key order.
- `upsert_fleet_entry` blocks its thread while it polls the lock (Bun.sleepSync): call it from
  `spawn_blocking` or at boot. The server adds its own prefix ("fleet registry: fleet registry: lock").
- `spawn_env` and `engine_env_set` take the parent environment as an argument; only the CLI reads it.
- Test overrides of the harness table go in as `Harness::Custom(Arc<dyn Fn>)`.
- A hand-written null in an assign field counts as set, as in the TypeScript: `harness: null` resolves to
  "" with source "pinned". Reassign checks harnesses with `require_known_harness("reassign: harness", ...)`;
  the Conversation start layers a Steward's entry as inherited via `AssignmentLayer::from(&steward_assign_of(config)?)`.
- Deviations (edges, nothing pins them): a hand-written non-string Assignment field (`model: 5`) becomes
  the string "5" (TypeScript keeps the number); a verify past u64 saturates; a non-string effort is
  coerced (TypeScript throws a TypeError); JSON parse errors read "JSON Parse error: <serde message>".
- `js_compat.rs` is a private copy of the JavaScript helpers, to fold into `ac_core::js` with herdr's
  `js.rs` and git's `node.rs`.

### ac-engine core (F1-engine)

- Modules beyond the design's map: `checkout_gate` (engine.ts 4480-4611, the pool checkout's gate,
  which the drive and the merges need), `options` (RunOptions), `testkit` and `e2e_tests` (test only:
  a git pool, a scripted stub harness, an in-memory store that fails on demand). ac-core gained
  `merge_hold` (derivation, memo, the watch's bookkeeping, the Merge line), `outcome` (validateOutcome
  and Spawn proposal validation) and `prompt` (the Ticket and resolver prompts; the other prompts join
  it with their ports).
- `Session::new(SessionBase)` builds a session with every runtime empty; boot sets the rest.
  `PoolState.config` is `ac_core::config::PoolConfig`.
- Every TypeScript `await` of a promise that settles with no I/O lets no HTTP handler in; every
  `engine.call` boundary does. The one place that mattered: an answer accepted after the last
  boundary's drain, while the drive closes, would sit queued until an unrelated kick. The session's
  `queued_since_drain` flag makes the closing drive kick the next one, as it does for spawns waiting
  to land.
- The merge chain is a `Shared` future per link (`Session::merge_chain`); a super-step's own queue is
  a link that fails once a merge before it threw, so later merges of that step are skipped and the
  step's join fails, as the TypeScript's local promise chain does.
- STUB modules, for their owners: `attempt_run`, `attempt_ending`, `live_attempts`, `children`,
  `pane_session` (attempt launch: `run_attempt(&AttemptEnv, AttemptSpec<R>, fn(&Value) ->
  Result<R, String>) -> anyhow::Result<AttemptRun<R>>`, a minimal headless run so the drive can be
  tested; the Live attempts registry and the children are reached through `AttemptEnv::engine`);
  `conversations`, `enlisted`, `held`, `terminals`, `pool_workspace`, `keep_talking`, `restart`
  (orphans and adoption), `spawns` (taking and adopting proposals; the ledger refresh is ported),
  `steward_actions` (the actions; the answer and snapshot helpers are ported), `verify` (grading and
  Selection; the acceptance checks are ported), `jev`.
- While `spawns::adopt_spawn_proposals` is a stub, a pool with a Pending spawn on disk never lands it:
  every drive closes quiescent and kicks the next, a busy loop. The spawns port ends it.
