# Not ported to conformance

Behaviour the Rust port inventory (`docs/research/rust-port/test-inventory.md`) sorts as visible that has no
conformance case yet, each with the reason and the Rust unit test or later case it implies. One section per
conformance ticket.

## C19: Assignments and Config reload (`config`)

Every one of the 44 rows is a passing case in `cases/config-assignments.test.ts`,
`cases/config-reload.test.ts` and `cases/config-resolver.test.ts`. Six of the area's seven gaps are cases there
too. One gap is left:

- **A console.json hand-edited into invalid JSON, seen from every route that reads it** (GET /api/settings,
  PUT /api/settings/pool, PUT /api/reassign, GET /api/panes, the socket's `panes.list`, the snapshot's
  `poolTitle`; source `engine/server.ts:1815`). Left because it is mostly the routes' answers, which C00 and
  C20 own, and because GET /api/panes answers with Bun's own 500 page there, the same class of answer as the
  unknown-path 500s conv-1-spawn-14 is fixing (inventory open question 5). Once that fix lands, the case is:
  a started pool, console.json rewritten to `{ not json`; GET /api/settings answers 500 `{error}`, the pool
  PUT answers 400 and leaves the broken bytes, PUT /api/reassign answers 500, GET /api/panes and `panes.list`
  answer a clean 500 refusal, and the snapshot keeps the last good `poolTitle`. The Reassign half of it
  (every ticket refused while the config will not parse) is C20's `reassign.test.ts:382` row.
