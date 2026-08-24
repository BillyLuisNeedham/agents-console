<!-- state: id=02 blocked-by=01 status=done -->

# 02 — Pool status word in the tab title

Spec: `.scratch/console-tab-identity/spec-console-tab-identity.md`

## What to build

The tab title leads with the pool's status: `{status} — {name}`, e.g. `needs input — ai-agent-graphs-fix/tickets`. The status is a pure projection over the snapshot, worst-first: any pending interrupt, or the run phase `stalled`, is `needs input`; otherwise the phase `running` is `running`; otherwise the phase `done` is `complete`; anything else is `idle`. `quiescent` always carries a pending interrupt, so it needs no rule of its own. The projection returns both the status word and its color (red, amber, green, grey) so ticket 03 consumes the same value. The title is recomputed on every applied snapshot.

## Acceptance criteria

- [x] A pure projection maps any snapshot to one of `needs input`, `running`, `complete`, `idle`, with its color
- [x] A snapshot with any pending interrupt projects `needs input`, whatever its phase
- [x] A snapshot with phase `stalled` and no interrupts projects `needs input`
- [x] Phases `running` and `done` with no pending interrupt project `running` and `complete` respectively
- [x] The document title reads `{status word} — {pool name}`, lowercase status word, and updates on every applied snapshot
- [x] The projection is unit-tested in the UI's existing projection test suite across every status branch
- [x] `bun test` passes in both `engine/` and `ui/`, and both typecheck scripts pass

## Notes

- Projection is `poolStatus` in `ui/src/project.ts`, returning `{ word, color }`; colors taken from the Console palette: red `--interrupt` #f85149, amber `--status-running` #d29922, green `--status-done` #3fb950, grey `--status-pending` #8b949e. Ticket 03 should consume the same value for the favicon.
- The phase union has only four values, so `idle` is reachable only by a quiescent snapshot with no pending interrupts, a shape the engine never emits (quiescent always carries an interrupt). The idle branch is tested with exactly that synthetic shape, matching the spec's "anything else is idle".
- Title wiring is one line in `setSnapshot` (`ui/src/main.ts`), the single point every applied snapshot routes through (boot, SSE, answer response), so the title recomputes on every snapshot.

## Blocked by

- 01 — Pool name in the tab title
