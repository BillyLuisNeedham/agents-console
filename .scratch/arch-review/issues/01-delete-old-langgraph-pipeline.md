<!-- state: id=01 blocked-by=none status=ready -->

# 01 — Delete the old LangGraph pipeline

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

The repo keeps exactly one executable system: the Console (`engine/` + `ui/`). The old LangGraph experiment is deleted in full: the `src/` graph modules, `langgraph.json`, the old-format ticket pools (`tickets/`, `mock-tickets/`, `mock-tickets-deadlock/`), `scripts/setup-langsmith.sh` and `scripts/.env`, the root `.env` (a live LangSmith key — never print its value), `.run/`, `.langgraph_api/`, and `docs/langgraph-js-api-2026.md`. The root package manifest loses the `smoke` and `studio` scripts and every dependency only the old graph used (`@langchain/*`, `zod`, and the langgraph CLI). tsconfig drops `"src"` from its include. After the deletion, `bun test` and `tsc --noEmit` at the root are green and nothing in `engine/` or `ui/` references anything deleted (verified by grep during the review — the two systems share zero imports).

## Acceptance criteria

- [ ] All listed files and directories are deleted from the working tree
- [ ] Root package manifest has no `smoke`/`studio` scripts and no `@langchain/*`, `zod`, or langgraph CLI dependencies; lockfile regenerated
- [ ] tsconfig include no longer covers `src/`
- [ ] Repo-wide grep finds no reference to `langgraph`, `mock-tickets`, `setup-langsmith`, `LANGSMITH`, or `src/graph` outside git history and this pool's own files
- [ ] `bun test` and `tsc --noEmit` pass at the root
- [ ] No `.env` file remains in the working tree; no secret value was printed or committed

## Blocked by

None — can start immediately
