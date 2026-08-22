<!-- state: id=02 blocked-by=none status=done -->

# 02 — Tab-default projection

Spec: GitHub issue #15 (BillyLuisNeedham/agents-console).

## What to build

The ui projection layer (the pure, DOM-free seam where `projectDetail` and the other projections already live) gains a pure function that decides which Detail tab a ticket shows: `ready → Spec`; `in-progress` or `checkpoint → Progress`; `done → Outcome`; a pending interrupt → Progress regardless of status (the interrupt always wins, even on a done ticket). A manually chosen tab overrides the default for that ticket; the override resets when the selected ticket changes. Model the override as data the projection can reason about (e.g. the selected ticket id plus the manually chosen tab, or null for "auto"), so the whole rule is testable without the DOM. The view layer will call this projection; this ticket delivers only the pure logic and its tests, so it can land green before any UI uses it.

## Acceptance criteria

- [x] Pure projection maps each pool status to its default tab (ready→Spec, in-progress/checkpoint→Progress, done→Outcome)
- [x] A pending interrupt maps to Progress on every status, including done
- [x] A manual tab choice overrides the default for the current ticket
- [x] The override resets when the selected ticket changes
- [x] All of the above covered by unit tests in the ui projection test suite — prior art: existing `project.test.ts` projections
- [x] Full test suite, typecheck, and build clean

## Blocked by

None — can start immediately.

## Notes

- Delivered as `DetailTab`, `TabOverride`, `defaultDetailTab` and `projectDetailTab` in `ui/src/project.ts`, tested in `ui/src/project.test.ts`. The override is data: `{ ticketId, tab }` or null for auto. A choice carries its ticket id, so a stale choice from a previous selection does not apply and the default reasserts itself; that is how the reset-on-ticket-change rule is modelled.
- A manual choice also overrides the interrupt-driven Progress default. The Issue says the interrupt wins over the status default and a manual choice overrides the default; spec user story 10 (the panel does not yank itself back) settles that the manual choice wins outright.
- Typecheck caveat (pre-existing, not caused by this ticket): `bun run typecheck` in `ui/` was already red at pool start. Every error is in `src/prototype/` (the throwaway sketches from commit 7c72b0e import names `view.ts` does not export). Verified red with my changes stashed, and verified my changed files contribute zero errors. Nothing outside `src/prototype/` imports it, and ticket 04 deletes those files, so I left them and the tsconfig alone: if the red were disqualifying, tickets 02 and 03 could never pass since 04 is blocked by 03. Full `bun test` (ui: 87 pass) and `bun run build` are clean; the engine suite is untouched and green (144 pass).
- `ui/node_modules` did not exist in this worktree; ran `bun install` in `ui/` (lockfile unchanged).
