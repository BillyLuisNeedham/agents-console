<!-- state: id=02 blocked-by=none status=ready -->

# 02 — Delete the UI prototype sketches

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

`ui/src/prototype/` (four files, ~1,079 lines, self-marked throwaway) is deleted. Nothing imports it — verified by grep — but it sits inside the UI's tsconfig and imports names `view.ts` never exported, so `bun run typecheck` in `ui/` currently fails with 13 errors. After the deletion the UI typecheck, test suite, and build are all green. Git history preserves the sketches for reference.

## Acceptance criteria

- [ ] `ui/src/prototype/` is deleted
- [ ] `bun run typecheck` passes in `ui/`
- [ ] `bun test` passes in `ui/`
- [ ] `bun run build` passes in `ui/`

## Blocked by

None — can start immediately
