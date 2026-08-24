<!-- state: id=01 blocked-by=none status=done -->

# 01 — Pool name in the tab title

Spec: `.scratch/console-tab-identity/spec-console-tab-identity.md`

## What to build

The Console's browser tab names its pool. The pool server computes the pool's display name as the last two path segments of the pool directory (`<parent>/<basename>`, e.g. `ai-agent-graphs-fix/tickets`) and carries it on the enriched snapshot as a new top-level field, alongside the existing ticket metadata enrichment. The engine's own snapshot type is untouched. The UI sets the document title from that field on every snapshot it applies. Before the first snapshot arrives, the static title stands as it does today.

## Acceptance criteria

- [x] The enriched snapshot carries the pool's display name as the last two path segments of the pool directory
- [x] The document title shows the pool's display name once a snapshot has landed (the status word is ticket 02; an interim bare name is fine within this ticket only if 02 is not yet merged)
- [x] The name comes from the server; the UI does no path derivation of its own
- [x] The server enrichment is covered in the engine's server test suite, including pool directories with different path shapes
- [x] `bun test` passes in both `engine/` and `ui/`, and both typecheck scripts pass

## Notes

- The field is `poolName`, a top-level field on the enriched snapshot (`engine/server.ts`), computed once in `createPoolServer` from the resolved pool directory. The engine's own snapshot type is untouched.
- The UI sets `document.title = snapshot.poolName` in `setSnapshot` (`ui/src/main.ts`), so the title is the bare name until ticket 02 prepends the status word.
- Server test asserts three path shapes: a worktree pool, a second same-named pool in another worktree, and a pool under `.scratch/`.
- `bun run build` run in `ui/` so `ui/dist/` serves the change.

## Blocked by

None — can start immediately
