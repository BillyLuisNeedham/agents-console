<!-- state: id=02 blocked-by=01 status=done -->

# 02 — Live streaming into the projection

## What to build

Live streaming wired through a pure projection module. Runs stream with `streamMode: ["values", "updates"]` (note from the spike, SDK 2.0.0: the three-argument stream call lives on `client.runs.stream(threadId, assistantId, {...})`). The projection maps thread state + stream events to a view model; the DOM layer stays thin over it. State, log, and node statuses update live as super-steps land — no refresh. This module is the single testing seam.

## Acceptance criteria

- [x] `values` + `updates` streaming flows through the projection into the rendered state/log
- [x] UI updates live per super-step without manual refresh
- [x] `bun test` covers the projection with fixtures: normal super-step progression, log append ordering
- [x] `tsc --noEmit` clean

## Blocked by

- 01 — Walking skeleton

## Notes

- Seam: `project.ts` gains `initRun` / `applyStreamPart` / `syncRunValues` / `projectNodes` — stream parts in, `RunProjection` out. `values` parts replace the snapshot (channels + log come only from here, so log ordering is the graph's own append order); `updates` parts drive node chips only, one entry per super-step's node keys.
- `client.ts` gains `findActiveRun` / `joinRun` / `streamRun` / `getAssistantId`, all streaming `["values", "updates"]` through one `consume` helper with AbortSignal cancellation. `main.ts` joins the selected thread's in-flight run on select and on first load; when the stream ends it re-fetches the thread (final values, interrupt dot in the rail).
- Proven against the live dev server (scratch script `.scratch/console/verify-02.ts`, not committed): start → approve-spec interrupt, resume approve → fan-out T1/T3 then T2, review approve → END. Joined stream carried values + updates; final log in exact graph order.
- Server behaviour that matters (proven): a **joined** stream carries `updates` only if the run was created with `streamMode` including updates. Runs the Console starts itself (issue 03, via `streamRun`) declare both modes, so this holds; runs started elsewhere may join values-only.
- Streamed `values` snapshots contain `__interrupt__` when a node interrupts, and it also appears as an `updates` key. The projection filters `__`-prefixed keys from both the channel list and the node chips (they are not nodes). Interrupt forms proper are issue 06.
- 23 tests pass, `tsc --noEmit` clean, `vite build` clean. Residual, not machine-checked: the in-browser look of the run strip while a run streams (Billy: start a run from a script or wait for issue 03's form, pick the thread, watch the chips and log move).
