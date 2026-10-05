# Conventions

Specs live in git history, not on main. Before opening a PR from a branch that added files under `docs/specs/`, delete those files in a final commit on the branch.

Skills live under `skills/`, one directory per skill, and reach Claude Code only through a symlink in `~/.claude/skills`. A new skill is a new directory plus `skills/link.sh`, which links every one of them idempotently.

Every engine change lands with conformance cases for what it changes that can be seen from outside the server: HTTP, the socket at `/api/ws`, files in the pool directory, calls on the herdr socket, or harness processes started. Cases live in `conformance/cases`, run with `bun run conformance --server bun`, and import nothing from the engine but types from `protocol/protocol.ts` and `protocol/wire.ts`, which `cargo run -p ac-protocol --bin gen-typescript -- protocol` generates from the Rust types (ADR-0036).
