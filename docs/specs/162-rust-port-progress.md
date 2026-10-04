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
