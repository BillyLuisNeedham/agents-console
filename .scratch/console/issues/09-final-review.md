<!-- state: id=09 blocked-by=05,06,07,08 status=done -->

# 09 — Final code review pass

## What to build

Final review pass over the whole Console before calling the spec done. Run the review (standards + spec axes — the `code-review` or `peer-review` skill) across the full diff, verify every user story in the parent spec is demonstrably working, and address findings.

## Acceptance criteria

- [x] `tsc --noEmit` clean and `bun test` green
- [x] Review findings addressed or explicitly deferred
- [x] Every user story in the parent spec checked off as demoed
- [x] CONTEXT.md vocabulary respected — no avoid-words in code or UI copy

## Blocked by

- 05 — Canvas interactions
- 06 — Interrupts inline
- 07 — Ticket cards
- 08 — State inspector

## Notes

- Fixed point: `2fe6ffc` (parent of walking skeleton). Spec: GitHub issue #1. No CODING_STANDARDS.md; standards = CONTEXT.md + issue #1 decisions + Fowler baseline.
- Dev server was up. Live threads still on it: verify-07 (review interrupt), verify-06 reload (deadlock), verify-04 (approve-spec). Topology: 8 nodes, 20 edges.
- `bun test` 68 pass; `tsc --noEmit` clean.

## Standards

No hard violations. Vocabulary is clean in Console code and UI copy. Streaming is `["values","updates"]` only. Tests are pure projection. Spike A/B deleted; VariantC unimported.

Judgement / smells:

1. Em dashes in Console prose. Addressed in `main.ts`, `view.ts`, `project.ts`, `styles.css`, `package.json`. Left in leftover spike files (`VariantC.ts`, `data.ts`, `mock.ts`).
2. Duplicated stream handlers in `main.ts`. Addressed: `bindStream`.
3. `INTERRUPT_NODE` / `NODE_INTERRUPT_KIND` inverses. Addressed: one `INTERRUPT_KIND_BY_NODE` map.
4. Repeated `channel.kind` cascade in `view.ts`. Deferred: two small renderers, not worth a registry.
5. `worldSize` / `fitWorld` overlap. Deferred: one sizes from the model, one from live DOM.
6. Divergent Change in `view.ts` (927 lines). Deferred: splitting the DOM layer is a later deepening, not a spec hole.
7. `SPINE` START/END aliases. Deferred: harmless aliases for ids the server might use.
8. `status: string` on thread/stream parts. Deferred: minor.

## Spec

(a) Missing or partial

- Story 19 "when schedule fans out": cards come from `values.tickets`, not a schedule updates part. Intentional (issue 07): a picked-up thread must still show its tickets (story 24). Accepted.
- "simple layered layout": `layoutGraph` is a hard-coded spine, not a computed layerer. Accepted for this fixed topology.
- Stories 1+4 highlighting: picking a finished thread shows idle cards (no stream history). Story 14 is "as state streams in". Accepted.

(b) Scope creep

- `joinStream` / `watch()` on thread pick. Kept: required to see an in-flight run after refresh (story 4).
- Rail refresh, interrupt-count dot, stream-error banner. Kept: small and useful.

(c) Implemented but wrong

- Story 14: last node stayed "running" after the stream ended. Fixed: `finishRun` clears `activeNodes`.
- Story 17: deadlock pending came from `values.tickets`, not the payload. Fixed: payload `pending` wins.
- Story 12: ticket positions leaked across threads under `ticket:T1`. Fixed: `layoutStorageKey` scopes tickets per thread.
- Stories 16/26: spec shown on the card and again in the form. Deferred: the spec asked for both.

## Findings addressed

- `finishRun` + `bindStream` so a completed stream is not left labelled running.
- Deadlock card pending list taken from the interrupt payload.
- Ticket layout keys namespaced by thread id; graph nodes stay global.
- One interrupt-kind map; shared stream handlers.
- Em dashes removed from Console-owned copy.

## Findings deferred

- Split `view.ts`; channel-kind registry; world-size helper; spine aliases; thread status unions.
- Hard-coded spine vs generic layered layout.
- Ticket cards from the tickets channel (keeps story 24).
- Spec appearing on both the approveSpec channel and the interrupt form.
- `joinStream`, refresh, interrupt dot, stream-error banner.

## User stories

Live server had Console threads for all three interrupt kinds plus topology. Canvas interactions were live-verified in issues 05 and 07. Projection tests cover the rest.

1. [x] Thread list. `visibleThreads` + live `threads/search` returns origin=ui runs.
2. [x] Tag `{label, origin:"ui"}`. `createThread` in client.ts; live metadata matches.
3. [x] Default filter + show-all. `visibleThreads` tests.
4. [x] Pick a thread, see state. `selectThread` loads values onto cards; live threads have spec/tickets/log.
5. [x] Start by topic. `projectStartRun` tests; start form in view.ts.
6. [x] Ticket pool dropdown. `TICKET_POOLS` = tickets/, mock-tickets/, mock-tickets-deadlock/.
7. [x] Optional packet. Blank omitted so the graph uses the demo packet.
8. [x] Topology from `getGraph`. Live: 8 nodes, 20 edges, rendered as cards.
9. [x] Pan background. Issue 05 live.
10. [x] Wheel zoom at cursor, −/+/reset. Issue 05 + `zoomAtCursor` tests.
11. [x] Drag cards, edges follow. Issue 05 live.
12. [x] Positions persist; reset-layout. Issue 05; this pass scopes ticket keys per thread.
13. [x] Elbow default / straight toggle. `edgePath` tests; view toggle.
14. [x] Running + next highlighted. `projectNodeCards` tests; `finishRun` clears the leftover running label.
15. [x] Per-node channels only. `projectNodeChannels` tests.
16. [x] approveSpec shows spec. Channel + live verify-04 interrupt.
17. [x] deadlockGate pending + hint. Payload-backed; live verify-06 reload.
18. [x] review shows ticket summary. Channel + live verify-07.
19. [x] One card per ticket. `projectTicketCards`; issue 07 live T1/T2/T3.
20. [x] schedule → ticket edges. `projectTicketEdges` test.
21. [x] id, title, live status. Tests + issue 07 pending→running→done.
22. [x] Pending blockedBy. Test + issue 07 T2 after T1.
23. [x] Click expands in place. Issue 07 (view-only).
24. [x] Done cards stay; cards die with the thread. Tests + `renderApp` clears missing ticket ids.
25. [x] Interrupt form inline. All three kinds on live threads.
26. [x] approve / reject + spec + tickets. Form + `projectResume`.
27. [x] reload / abort. Issue 06 live.
28. [x] approve / retry(ids) / replan. Tests + issue 06 retry T1.
29. [x] Raw payload collapsed. `<details>` in the form.
30. [x] Log drawer. `projectLog` + `renderLogDrawer`.
31. [x] State inspector drawer. `projectChannels` + issue 08.

## Vocabulary

No avoid-words used as concept names in `client.ts`, `main.ts`, `project.ts`, `view.ts`. Spike leftovers not in the Console path.
