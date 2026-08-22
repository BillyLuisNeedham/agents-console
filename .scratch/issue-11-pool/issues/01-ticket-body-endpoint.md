<!-- state: id=01 blocked-by=none status=done -->

# 01 — Ticket body endpoint

Spec: GitHub issue #15 (BillyLuisNeedham/agents-console). Prototype reference: branch `prototype/ticket-details`.

## What to build

The pool server gains a read-only `GET /api/ticket?id=<ticketId>` endpoint so the Console UI can read a ticket's full markdown body. It resolves the ticket's Issue file inside the pool's issues directory — exact `<id>.md` first, then any `<id>-<slug>.md` whose filename prefix before the first `-` equals the id (directory-listing scoped; the id is never used as a path). On a hit it returns `200` JSON `{ id, body }` where `body` is the file text with the line-1 `<!-- state: ... -->` marker stripped (the marker is pool metadata, never prose for the UI). On no match it returns `404` JSON `{ error: "not found" }`. The pool client gains a `getTicket(id)` method returning `{ id, body }` or null on 404, matching the existing `getEvents` style. Follow the existing `/api/events` handler pattern; the prototype branch has a reference implementation, but strip the marker server-side (the prototype did not).

## Acceptance criteria

- [x] `GET /api/ticket?id=<id>` returns `{ id, body }` for an exact `<id>.md` file
- [x] `<id>-<slug>.md` files resolve by their prefix before the first `-`
- [x] The line-1 state marker is stripped from `body` server-side
- [x] Unknown id returns 404 `{ error: "not found" }`
- [x] Pool client has `getTicket(id)` returning the body or null on 404
- [x] Endpoint covered by tests in the engine server test suite (hit, prefix hit, marker stripped, 404) — prior art: existing endpoint tests there
- [x] Full test suite, typecheck, and build clean

## Blocked by

None — can start immediately.

## Notes

- Read: engine/server.ts (handler pattern at /api/events and /api/log), engine/server.test.ts (prior art describes), engine/pool.ts (MARKER_RE, loadPoolMarkers), ui/src/client.ts (getEvents style), ui/src/project.ts (wire types), prototype branch reference (`git show prototype/ticket-details -- engine/server.ts ui/src/client.ts`).
- Decision: strip the line-1 marker plus the blank lines that follow it, so `body` starts at the first content line. The marker and its separating blank are pool metadata as a unit; the Issue settles the marker, and no acceptance criterion speaks to the blank line.
- Decision: reuse pool.ts's MARKER_RE (exported) for detection rather than a second marker regex, so "what is a state marker line" stays single-sourced.
- Note: exact-name-first vs prefix priority cannot be tested at the server level — loadPoolMarkers rejects duplicate ids, so a real pool can never hold both `01.md` and `01-b.md`. The code still checks exact first, per the Issue.
- Verification: root `bun test` 230 pass / 0 fail; ui `bun test` 82 pass / 0 fail; root `tsc --noEmit` clean; ui `vite build` clean. ui `tsc --noEmit` fails, pre-existing (see Brief).

## Brief

1. Completed: `GET /api/ticket?id=<id>` in engine/server.ts (exact `<id>.md` first, then prefix before the first `-`, directory-listing scoped; line-1 state marker plus its separating blank lines stripped server-side via pool.ts's now-exported MARKER_RE; 404 `{ error: "not found" }` on no match). Pool client `getTicket(id)` in ui/src/client.ts returning `{ id, body }` or null on 404, with `TicketBodyResponse` in ui/src/project.ts. Four new tests in engine/server.test.ts (hit, prefix hit, marker stripped, 404), all passing. Six of seven acceptance criteria ticked.
2. The human has to do: decide the fate of the committed throwaway prototype sketches (`ui/src/prototype/*`, commit 7c72b0e). `bun run typecheck` in `ui/` fails on them at pool start, before any of my changes: they import `h`, `renderInterrupt`, `renderTimelineSection`, `statusLabel` from `../view`, which view.ts does not export. This red typecheck is not caused by this Issue, so per the job constraints I did not fix it silently. My recommendation: add `"exclude": ["src/prototype"]` to `ui/tsconfig.json` — the sketches stay on disk for reference but stop pretending to compile. Deleting them or adding the missing exports to view.ts are the alternatives.
3. After that: rerun `bun run typecheck` in `ui/`. Once green, the last criterion (full test suite, typecheck, and build clean) is satisfied and this Issue can be flipped to done; the endpoint and client work itself is finished and fully tested.

## Resume note

get rid of the throwaway prototype sketches if you no longer need them. if you need them, keep them just make it work then write a ticket to delete them at the end of the run

## Resolution

The endpoint and client work was complete; the sketches were reference-only and nothing imports them, so they were deleted (`git rm -r ui/src/prototype`, 4 files). No delete-later ticket needed. After deletion: ui `bun run typecheck` clean, ui `bun test` 82 pass / 0 fail, ui `vite build` clean, root `bun test` 230 pass / 0 fail, root `tsc --noEmit` clean. All seven acceptance criteria now hold; status set to done.
