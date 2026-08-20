<!-- state: id=07 blocked-by=01 status=done -->

# 07 — Server and pool projection UI

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The Console re-pointed at the pool engine. One Bun process per pool serves the built SPA, a small JSON API (get state, start, resume-with-answer), and an SSE stream that pushes a full state snapshot on every change. The UI keeps its existing canvas, node cards, Detail panel, drawer, and styles, but the LangGraph client and projection are deleted and replaced with a pool projection: each ticket is a card, blocked-by entries are edges, and the fixed machinery (start, final Review) appears as small utility cards at the ends. Card status mirrors the ticket's marker status. Canvas interactions (pan, zoom, drag, edge-routing toggle, persisted positions) keep working unchanged. The thread-driving UI leaves the main path.

## Acceptance criteria

- [x] One Bun process serves the built SPA, the JSON API, and the SSE snapshot stream for one pool
- [x] Every state change pushes a full snapshot over SSE; the UI renders from snapshots only
- [x] Each ticket renders as a card with edges drawn from its blocked-by list
- [x] Card status mirrors the line-1 marker status live as the run progresses
- [x] Start and Review machinery appear as small utility cards, visually distinct from ticket cards
- [x] Pan, zoom, drag, edge-routing toggle, and persisted positions all work unchanged
- [x] The LangGraph client, thread list, and thread projection are gone from the main path
- [x] Pool projection is covered by pure-function tests over snapshot fixtures, following the existing projection-test precedent

## Blocked by

- 01 — Pool engine walking skeleton

## Notes

- Server lives at `engine/server.ts` (the Bun HTTP/SSE adapter) and `engine/server.test.ts` (smoke tests). It drives the engine with `runPool`, enriching each engine snapshot with the pool's ticket metadata (id, title from the Issue's first `# ` heading, blockedBy from the markers, status from `state.tickets`) so the projection can draw blocked-by edges. One process serves `/api/state`, `/api/start`, `/api/resume`, `/api/stream` (SSE) and the built SPA from `ui/dist`. CLI: `bun run engine/server.ts --pool <dir> [--port <n>]`; the skill (Issue 10) launches it and opens the browser.
- The UI's active path (`client.ts` + `project.ts` + `main.ts` + `view.ts`) was rewritten to render only from pool snapshots. `client.ts` is now the pool client (get state, start, resume-with-answer, SSE). `project.ts` is the pool projection: tickets as cards, blocked-by edges, START and REVIEW as small utility cards, status mirroring markers. `view.ts` keeps the canvas mechanics (pan, zoom, drag, edge-routing toggle, persisted positions) and Detail panel; ticket cards expand on click, utility cards select into Detail. The old `data.ts`, `mock.ts`, `variants/VariantC.ts` and the `@langchain/langgraph-sdk` dependency are deleted; the bundle dropped from ~68 KB to ~17 KB.
- The `start` endpoint is idempotent: the CLI auto-starts the run on boot, and the UI calls `start` only when `/api/state` returns null, so a browser reload never double-starts. (Decision: the Issue did not settle whether the server or the browser triggers the initial run.)
- Inline interrupt answering forms (checkpoint, crash, deadlock, merge-conflict, merge-approval, final Review) are deliberately deferred to Issues 08 and 09. This Issue exposes `POST /api/resume` with an optional note (the engine appends it to the Issue file) and renders a pending interrupt's body in a card's Detail, but the full answer-in-place UI is 08's scope.
- Engine untouched: `engine/engine.ts` and its tests are unchanged; the server only consumes `runPool`'s public interface. `engine/server.ts` typechecks under the root tsconfig.

## Brief, written by the agent

1. Built the one-Bun-process pool server (`engine/server.ts`) serving the built SPA, a JSON API (`/api/state`, `/api/start`, `/api/resume`), and an SSE snapshot stream, plus smoke tests (`engine/server.test.ts`).
2. Rewrote the UI's active path to the pool projection: tickets as cards with blocked-by edges, START and REVIEW as visually distinct utility cards, status mirroring markers, snapshot-only rendering, and the LangGraph client/thread list/thread projection removed. Projection covered by 29 pure-function tests over snapshot fixtures.
3. Verified: root and UI typechecks pass, engine+server tests (80) and UI tests (29) pass, `vite build` succeeds, and an end-to-end smoke of the server (serve SPA, get state, SSE, close) works.
4. What a human should do next: launch the server against a real pool (the Issue 10 skill will do this) and open the browser to confirm the pool renders and stays live over SSE.
5. After that: Issue 08 builds the inline interrupt forms on top of the `/api/resume` endpoint this Issue provides.
