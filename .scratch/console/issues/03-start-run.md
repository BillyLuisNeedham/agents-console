<!-- state: id=03 blocked-by=02 status=done -->

# 03 — Start a run from the left rail

## What to build

A start-run form in the left rail: topic text field, ticket-pool dropdown (`tickets/`, `mock-tickets/`, `mock-tickets-deadlock/` — passed as `configurable.ticketDir`), and an optional packet textarea. Starting a run creates a thread tagged `{label: topic, origin: "ui"}`, invokes the graph with the topic (and packet text if given — the graph never reads packet files itself; omitted packet falls back to the demo packet), and begins streaming it.

## Acceptance criteria

- [x] Starting a run with a topic creates a tagged thread and shows it streaming live
- [x] Ticket-pool choice reaches the graph as `configurable.ticketDir`
- [x] Pasted packet text is used; empty packet yields the demo fallback
- [x] New thread appears in the list under its topic label

## Blocked by

- 02 — Live streaming

## Notes

- Form lives at the top of the rail (`view.ts` `renderStartForm`): topic input, pool select, packet textarea, submit on button or Enter. Fields are controlled from state; `render()` restores focus and cursor via `data-field` attributes, since every stream part rebuilds the DOM.
- `projectStartRun` (project.ts) is the tested seam: blank topic → null; packet trimmed and omitted entirely when blank, which is what makes the graph's demo-packet fallback fire.
- `createThread` (client.ts) tags `{label: topic, origin: "ui"}`; `makeClient` is now `Client<Raw>` so the thread create call types cleanly.
- Finding (proven, via `.scratch/console/verify-03.ts` against the live server): when a run interrupts, the server sends a final `values` part holding only `__interrupt__`. Issue 02's projection replaced the whole snapshot with it, blanking the channels panel until the next refetch. Fixed in `applyStreamPart`: a values part whose keys are all `__`-prefixed is bookkeeping, not State, and no longer replaces the snapshot. Regression test added.
- Verified end-to-end with the dev server up (verify-03.ts, ALL OK): tagged thread created, 6 stream parts live, pasted packet text landed in the spec, `mock-tickets/` produced M-pool tickets, blank packet produced the demo packet, run stopped at the approve-spec interrupt. Relative pool dirs resolve because the dev server's cwd is `prototype/`.
- Review nit deliberately left: "field" (`data-field`, `onStartField`, `.field`) is a CONTEXT.md avoid-word for Channels, used here only in the HTML form-control sense. Rename to `input` if that still reads wrong.
- Interrupt answering (approve-spec etc.) is issue 06; this run stops there by design.
