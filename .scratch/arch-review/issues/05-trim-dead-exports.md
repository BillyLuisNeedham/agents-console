<!-- state: id=05 blocked-by=none status=ready -->

# 05 — Trim the dead exports

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

Each module's exported surface shrinks to what consumers actually import. Concretely, all verified by grep during the review: the events module's `EVENT_KINDS` value export goes (the derived type stays — or the events reader validates against the array so it earns its keep; implementer's choice, pin with a test either way). The server's exports with zero consumers (`stripAnsi`, `listAttemptLogs`, `runServerCli`, and the wire types the UI re-declares for itself) become module-private. The engine module's self-only exports (`readyTickets` and the types only it uses) become private. In the UI projection, `isUtilityCardId` is deleted outright and the fourteen importer-free exports are unexported. Where a test alone reaches for a symbol, the test imports from the defining module or exercises the public seam instead. Behavior is unchanged; every suite stays green.

## Acceptance criteria

- [ ] No export remains in `engine/` or `ui/src/` with zero consumers outside its own module (verified by grep per symbol)
- [ ] `EVENT_KINDS` is either deleted or consumed by validation, with a test pinning the choice
- [ ] `isUtilityCardId` is deleted
- [ ] `bun test` passes at root and in `ui/`; `tsc --noEmit` passes at root and in `ui/`

## Blocked by

None — can start immediately
