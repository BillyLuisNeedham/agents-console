<!-- state: id=02 blocked-by=01 status=ready -->

# 02 — Live streaming into the projection

## What to build

Live streaming wired through a pure projection module. Runs stream with `streamMode: ["values", "updates"]` (note from the spike, SDK 2.0.0: the three-argument stream call lives on `client.runs.stream(threadId, assistantId, {...})`). The projection maps thread state + stream events to a view model; the DOM layer stays thin over it. State, log, and node statuses update live as super-steps land — no refresh. This module is the single testing seam.

## Acceptance criteria

- [ ] `values` + `updates` streaming flows through the projection into the rendered state/log
- [ ] UI updates live per super-step without manual refresh
- [ ] `bun test` covers the projection with fixtures: normal super-step progression, log append ordering
- [ ] `tsc --noEmit` clean

## Blocked by

- 01 — Walking skeleton
