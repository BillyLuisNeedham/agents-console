<!-- state: id=01 blocked-by=none status=done -->

# 01 — Walking skeleton: pick a thread, see its state

## What to build

The walking skeleton of the Console: a new package at `prototype/ui/` (vanilla TypeScript, Vite dev server, bun tooling, no UI framework) that talks directly to the LangGraph dev server on localhost:2024 via `@langchain/langgraph-sdk` v2. A narrow left rail lists threads — Console-created threads (tagged `{label, origin:"ui"}`) first, with a "show all" toggle — and selecting a thread renders its channels as a plain node/channel list, with the `log` channel in a collapsible bottom drawer. Ugly but real end-to-end; the canvas replaces the plain list in a later ticket.

## Acceptance criteria

- [x] `bun run dev` in `prototype/ui/` serves the Console in the browser
- [x] Thread list shows Console-created threads by default, with a working show-all toggle
- [x] Selecting a thread renders its current state channels and log
- [x] No UI framework; `tsc --noEmit` clean

## Blocked by

None — can start immediately

## Notes

- Shape: `src/client.ts` (thin SDK wrapper) → `src/project.ts` (pure projection, the testing seam) → `src/view.ts` (DOM) → `src/main.ts` (wiring). Tests in `src/project.test.ts`, 13 passing via `bun test`.
- Thread filtering is client-side: one `threads.search` (limit 50, updated_at desc), `visibleThreads` filters `metadata.origin === "ui"` unless the toggle is on. Selecting a thread re-fetches it with `threads.get` so state is fresh.
- Channels render in graph order (topic, packetSource, packet, spec, specApproved, tickets); unknown extra channels append as collapsible-free JSON; `log` is excluded from the channel list and lives in the bottom drawer.
- Deleted spike files `switcher.ts`, `variants/VariantA.ts`, `variants/VariantB.ts`. Kept `variants/VariantC.ts`, `data.ts`, `mock.ts` untouched for issue 04 (VariantC imports data.ts; data.ts imports mock.ts — all three must stay together or `tsc` breaks).
- Added dev dependency `bun-types` so `bun:test` typechecks (tsconfig `types: ["vite/client", "bun"]`). Dev-only, no runtime deps added.
- Verified: `bun test` 13/13, `tsc --noEmit` clean, `vite build` clean, `bun run dev` serves and transforms modules. Against the live dev server: `threads/search`, `threads/search` with metadata filter, and `threads/get` all return the shapes the app projects. Seeded one `origin: "ui"` thread ("console smoke thread") so the default view is non-empty; the pre-existing interrupted run thread appears under show-all.
- Residual, not machine-checked: the actual in-browser look. Worth one eyeball from Billy (`bun run dev` in `prototype/ui/`, pick the smoke thread, toggle show-all, open the log drawer).
