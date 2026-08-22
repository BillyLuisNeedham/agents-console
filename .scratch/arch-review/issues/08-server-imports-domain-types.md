<!-- state: id=08 blocked-by=07 status=ready -->

# 08 — Server imports the engine's domain types

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

The server stops re-declaring domain facts the engine already owns. Ticket status, run phase, and the interrupt kind union are imported from the engine side; the server's copies — including the deliberate weakening of interrupt kind to `string` — are deleted. The REVIEW ticket id stays one constant in the engine and the server uses it. The UI's wire-type copies across the HTTP seam are inherent and stay as they are. Drift between engine and server becomes a compile error instead of a comment-held convention.

## Acceptance criteria

- [ ] The server imports ticket status, run phase, interrupt kind, and the REVIEW ticket id from the engine modules
- [ ] No domain union literal (`ready | in-progress | done | checkpoint`, `running | done | quiescent | stalled`, the six interrupt kinds) is spelled out in the server
- [ ] The served wire format is unchanged — existing server tests pass unmodified
- [ ] `bun test` and `tsc --noEmit` pass at the root

## Blocked by

07 — One parser per file format (same server module)
