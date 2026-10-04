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
| the failing scheduling case | | wave 2 |

### M1 to M5

Not started.

## Decisions

(none yet)
