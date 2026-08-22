<!-- state: id=02 blocked-by=none status=ready -->

# 02 — Tab-default projection

Spec: GitHub issue #15 (BillyLuisNeedham/agents-console).

## What to build

The ui projection layer (the pure, DOM-free seam where `projectDetail` and the other projections already live) gains a pure function that decides which Detail tab a ticket shows: `ready → Spec`; `in-progress` or `checkpoint → Progress`; `done → Outcome`; a pending interrupt → Progress regardless of status (the interrupt always wins, even on a done ticket). A manually chosen tab overrides the default for that ticket; the override resets when the selected ticket changes. Model the override as data the projection can reason about (e.g. the selected ticket id plus the manually chosen tab, or null for "auto"), so the whole rule is testable without the DOM. The view layer will call this projection; this ticket delivers only the pure logic and its tests, so it can land green before any UI uses it.

## Acceptance criteria

- [ ] Pure projection maps each pool status to its default tab (ready→Spec, in-progress/checkpoint→Progress, done→Outcome)
- [ ] A pending interrupt maps to Progress on every status, including done
- [ ] A manual tab choice overrides the default for the current ticket
- [ ] The override resets when the selected ticket changes
- [ ] All of the above covered by unit tests in the ui projection test suite — prior art: existing `project.test.ts` projections
- [ ] Full test suite, typecheck, and build clean

## Blocked by

None — can start immediately.
