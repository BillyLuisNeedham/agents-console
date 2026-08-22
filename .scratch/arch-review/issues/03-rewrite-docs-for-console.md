<!-- state: id=03 blocked-by=01,04 status=ready -->

# 03 — Rewrite the docs for the Console

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

`NOTES.md` is deleted — it is a stale experiment log for the old LangGraph system and references a start script that no longer exists. `README.md` is rewritten to describe the Console as it actually runs: the domain glossary pointer (`CONTEXT.md`), the pool engine and how to start a pool server (`bun run engine/server.ts --pool <dir>`, matching the usage text the server itself prints), the UI dev/build flow in `ui/`, and the `bun run fleet` command for listing live Consoles. The repo layout section describes `engine/`, `ui/`, `docs/adr/`, and the pool format — no mention of the deleted pipeline. A newcomer following the README boots the live system.

## Acceptance criteria

- [ ] `NOTES.md` is deleted
- [ ] `README.md` documents the pool server command, the UI build, and the fleet command
- [ ] `README.md` contains no reference to `src/`, `langgraph`, `studio`, `smoke`, `mock-tickets`, or LangSmith
- [ ] Repo-wide grep finds no doc still instructing the reader to run the deleted system (excluding git history and this pool's own files)

## Blocked by

01 — Delete the old LangGraph pipeline; 04 — Wire the fleet command (the README must not describe a half-deleted system or an unwired command)
