# Agent Console

The Console: a UI for driving an agent graph thread — the graph rendered as node
cards on a canvas, with interrupts answered inline. See `CONTEXT.md` for the
domain model and vocabulary.

## Layout

- `src/` — the LangGraph graph (grill packet → spec → tickets → implement → review)
- `ui/` — the Console UI (Vite + TypeScript)
- `tickets/`, `mock-tickets*/` — ticket pools the graph schedules over
- `docs/` — reference notes (LangGraph JS API)
- `NOTES.md` — running project notes

## Run

Runtime is bun; npm works as the command interface too.

```sh
bun install                # graph deps
bun install --cwd ui       # UI deps
npm run studio             # LangGraph dev server (needs .env — see scripts/setup-langsmith.sh)
npm run smoke              # headless smoke run of the graph
cd ui && npm run dev       # Console UI dev server
```

Typecheck: `npm run typecheck` (root) and `cd ui && npm run typecheck`.
UI tests: `cd ui && npm test`.
