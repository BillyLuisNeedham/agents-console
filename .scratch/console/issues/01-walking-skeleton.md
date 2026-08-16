<!-- state: id=01 blocked-by=none status=ready -->

# 01 — Walking skeleton: pick a thread, see its state

## What to build

The walking skeleton of the Console: a new package at `prototype/ui/` (vanilla TypeScript, Vite dev server, bun tooling, no UI framework) that talks directly to the LangGraph dev server on localhost:2024 via `@langchain/langgraph-sdk` v2. A narrow left rail lists threads — Console-created threads (tagged `{label, origin:"ui"}`) first, with a "show all" toggle — and selecting a thread renders its channels as a plain node/channel list, with the `log` channel in a collapsible bottom drawer. Ugly but real end-to-end; the canvas replaces the plain list in a later ticket.

## Acceptance criteria

- [ ] `bun run dev` in `prototype/ui/` serves the Console in the browser
- [ ] Thread list shows Console-created threads by default, with a working show-all toggle
- [ ] Selecting a thread renders its current state channels and log
- [ ] No UI framework; `tsc --noEmit` clean

## Blocked by

None — can start immediately
