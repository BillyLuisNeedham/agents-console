# Rust port design (issue #162)

How the Rust server is built. ADR-0036 decides what; this file says how, so every port ticket and every
subagent builds the same thing. It lives in `docs/specs/` beside the progress log and goes with it before the
PR.

## The bar

The conformance suite (`conformance/`, `bun run conformance --server rust`) is the contract. A Rust module
is done when the cases of its areas pass against the Rust binary, and when its hidden rows (the inventory's
"Hidden: Rust unit tests" lists and the NOT-PORTED.md entries that name a Rust unit test) are Rust unit
tests. The TypeScript server under `engine/` is the reference for everything the suite does not pin: read
the TypeScript function, port what it does, keep every visible string byte for byte.

## Crates

A cargo workspace at the repository root. `target/release/agent-console` is the binary the conformance
harness runs (`--rust-bin target/debug/agent-console` for a debug build).

| Crate | Path | Holds | May depend on |
| --- | --- | --- | --- |
| `ac-protocol` | `crates/protocol` | Every wire shape (wire.ts and every type it re-exports, protocol.ts), serde derives, and the TypeScript generator | serde only |
| `ac-core` | `crates/core` | The pure core and the on-disk formats: markers and Ticket files, events JSONL, console.json and Pool settings, the Spawn ledger, queued answers, Machine defaults, the fleet registry, checkpoints (SQLite), Stream logs, Assignment resolution, prompts and teachings, Outcome and Spawn validation, the Merge hold derivation, Turn state classification, Jev's rubric and Evidence | ac-protocol |
| `ac-io` | `crates/io` | The I/O edges: git, the herdr client, child processes and process groups, the TypeSafe (Jev) HTTP client | ac-protocol, ac-core |
| `ac-engine` | `crates/engine` | The pool engine: the Session, its actor, the drive loop and every flow (Attempts, pane sessions, merges, Spawns, Interrupts, Conversations, enlist, the Steward, verify) | all above |
| `ac-server` | `crates/server` | The HTTP routes, the socket at `/api/ws`, the served UI (embedded in release builds) | all above |
| `agent-console` | `crates/cli` | The binary: `server`, `boot`, `steward`, `fleet` | all above |

A lower crate never depends on a higher one. A type two crates need lives in the lower one.

## Where each TypeScript module goes

| TypeScript (engine/) | Rust |
| --- | --- |
| protocol.ts, wire.ts, and the types wire.ts re-exports | `ac-protocol` |
| pool.ts (markers, statuses, loading), events.ts, stat-cache.ts, spawn-ledger.ts, queued-answers.ts (the file), machine-defaults.ts, fleet.ts, pool-title.ts, pool-settings.ts (validation, the file), checkpoints.ts, streamlog.ts, spawn.ts (harness descriptors), spawn-caps.ts, assignment.ts, prompt.ts, merge-hold.ts (the derivation), turn-state.ts (classification), jev-rubric.ts, jev-evidence.ts, notices.ts (texts), steward.ts (texts, notes file) | `ac-core` |
| worktrees.ts and every git call, herdr.ts, children.ts, jev.ts (over HTTP, ADR-0036) | `ac-io` |
| engine.ts, conversations.ts, attempt-run.ts, attempt-ending.ts, pane-session.ts, pane-survey.ts, pane-reads.ts, held-panes.ts, finished-terminals.ts, live-attempts.ts, continued.ts, enlisted.ts, enlist.ts, claude-trust.ts, reassign.ts, spawn-proposals.ts, steward.ts (actions) | `ac-engine` |
| server.ts, ws.ts, ports.ts | `ac-server` |
| boot-cli.ts, boot-config.ts, boot-detect.ts, boot-launch.ts, boot-pool.ts, steward-cli.ts, fleet-cli.ts, the server's argv | `agent-console` |

A module may split or merge where Rust reads better; record it in the progress log.

## One task owns the pool state

The TypeScript engine is functions over one `Session` object, run on one event loop: code between two
`await`s runs without interruption, and any number of async flows (the drive loop, an Attempt's run, a
Conversation's tick, the pane survey, an HTTP handler) interleave at their awaits. The Rust engine keeps
exactly those semantics, with no locks:

- **The actor.** One tokio task owns `Session` and takes messages from an unbounded channel. The main
  message is a closure, `Box<dyn FnOnce(&mut Session) + Send>`, run to completion before the next.
  `Engine` (cheap to clone) is the handle: `engine.call(|s| ...)` sends a closure and awaits its result
  over a oneshot; `engine.cast(|s| ...)` sends one without waiting.
- **Flows.** Every TypeScript `async function` over the session becomes an `async fn` that takes an
  `Engine` and runs as its own task (`tokio::spawn`). Each stretch of synchronous TypeScript between two
  awaits becomes one `engine.call` closure, so it stays atomic exactly as it was. A closure never awaits
  and never holds anything across an await; what a flow needs after an await, it copies out first.
- **Sync functions.** A TypeScript function that never awaits becomes a plain `fn(&mut Session, ...)`,
  called inside a closure. Synchronous I/O the TypeScript does there (`writeFileSync`, `spawnSync` git)
  stays synchronous there: it blocks the actor exactly as it blocked the event loop, which keeps ordering
  identical. Move it out only where the TypeScript does it asynchronously.
- **Starting work.** A closure that starts async work (TypeScript's un-awaited promise, `void f()`) spawns
  a task with a clone of the `Engine` it finds in the session (`s.engine.clone()`).
- **Waiting.** Promises the session stores (settle waiters, answer waiters) become oneshot senders stored
  in the session. TypeScript's promise chains that serialize work (the merge chain) become a queue drained
  by one task, or a `tokio::sync::Mutex<()>` a flow holds across its awaits: a flow-held gate is not a lock
  on state.
- **Publishing.** Every emit builds the `PoolSnapshot` and publishes it on a `tokio::sync::watch` channel as
  an `Arc`. The server reads the latest snapshot from the watch without messaging the actor.
- **Pure core.** Decisions that need only data (the ready set, the Merge hold, Assignment resolution,
  Outcome and Spawn validation, Selection, verdict validation, config parsing, the snapshot delta, prompt
  rendering) are plain functions in `ac-core` with unit tests, called from the session functions.

## Conventions

- **Strings are contract.** Every visible string (HTTP bodies and errors, log lines, Interrupt bodies,
  prompts, teachings, Notices, Ticket and Conversation markdown, ledger text, stdout and stderr lines) is
  copied byte for byte from the TypeScript, interpolation included. Long texts go in `const` strings or
  `include_str!` files beside the module.
- **JSON.** `serde_json` with `preserve_order`: objects keep insertion order, as JavaScript's do, and
  struct fields are declared in the order the TypeScript builds the object. Optional fields that the
  TypeScript leaves out when undefined are `Option` with `skip_serializing_if = "Option::is_none"`; a field
  the TypeScript sends as `null` is an `Option` without the skip. Match `JSON.stringify(x, null, 2)` (two
  spaces, `serde_json::to_string_pretty`) where the TypeScript pretty-prints, and the trailing newline it
  adds or leaves out.
- **Numbers.** JavaScript numbers are f64; where a value is always an integer, use an integer type. A float
  that reaches a human-read file or a string must print as JavaScript prints it (`0.6`, not `0.6000000000000001`
  when JavaScript would round the same way; `1` for `1.0`). `ac_core::js::number_string` does this.
- **Time.** `new Date().toISOString()` is `chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)`
  (`2026-10-04T09:30:21.394Z`): `ac_core::js::now_iso()`.
- **Errors.** `anyhow` inside flows; where an error's message is visible, build it with the TypeScript's
  exact text. A thrown `Error` that the TypeScript catches and turns into an HTTP 4xx/5xx is a `Result::Err`
  with that message.
- **Processes.** `tokio::process::Command`. Headless children get their own process group (`setsid` in
  `pre_exec`, as Bun's `detached: true`), and the shutdown signals the group. Every child the engine starts
  is reaped.
- **Paths.** Canonicalize as the TypeScript does (`realpathSync`), and no further.
- **Environment.** Read only at the CLI boundary (`crates/cli`), as the TypeScript does; pass values down
  as options.
- **Tests.** Unit tests sit beside the code (`#[cfg(test)] mod tests`). Port the TypeScript unit tests of a
  pure function when they are cheap, and every hidden row the inventory assigns to the module.
- **Style.** `cargo fmt`, `cargo clippy --all-targets -- -D warnings` clean. Doc comments say what a thing
  is for, in the TypeScript's own domain words (CONTEXT.md). Prose without em dashes.

## Running the suite against Rust

```
cargo build -p agent-console            # target/debug/agent-console
bun run conformance --server rust --rust-bin target/debug/agent-console <filter>
```

`<filter>` is a path fragment of the case files. `CONFORMANCE_KEEP=1` keeps the worlds for a failure worth
reading. The Bun server is the reference: run the same filter with `--server bun` to see what passing looks
like.
