<!-- state: id=01 blocked-by=none status=ready -->

# 01 — Ticket body endpoint

Spec: GitHub issue #15 (BillyLuisNeedham/agents-console). Prototype reference: branch `prototype/ticket-details`.

## What to build

The pool server gains a read-only `GET /api/ticket?id=<ticketId>` endpoint so the Console UI can read a ticket's full markdown body. It resolves the ticket's Issue file inside the pool's issues directory — exact `<id>.md` first, then any `<id>-<slug>.md` whose filename prefix before the first `-` equals the id (directory-listing scoped; the id is never used as a path). On a hit it returns `200` JSON `{ id, body }` where `body` is the file text with the line-1 `<!-- state: ... -->` marker stripped (the marker is pool metadata, never prose for the UI). On no match it returns `404` JSON `{ error: "not found" }`. The pool client gains a `getTicket(id)` method returning `{ id, body }` or null on 404, matching the existing `getEvents` style. Follow the existing `/api/events` handler pattern; the prototype branch has a reference implementation, but strip the marker server-side (the prototype did not).

## Acceptance criteria

- [ ] `GET /api/ticket?id=<id>` returns `{ id, body }` for an exact `<id>.md` file
- [ ] `<id>-<slug>.md` files resolve by their prefix before the first `-`
- [ ] The line-1 state marker is stripped from `body` server-side
- [ ] Unknown id returns 404 `{ error: "not found" }`
- [ ] Pool client has `getTicket(id)` returning the body or null on 404
- [ ] Endpoint covered by tests in the engine server test suite (hit, prefix hit, marker stripped, 404) — prior art: existing endpoint tests there
- [ ] Full test suite, typecheck, and build clean

## Blocked by

None — can start immediately.
