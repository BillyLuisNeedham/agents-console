<!-- state: id=06 blocked-by=02,05 status=ready -->

# 06 — Resolver agent and conflict approval

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

Automatic conflict resolution with human merge authority. When a merge conflicts (surfaced by ticket 05), the engine spawns a resolver agent — harness from console.json's `resolver=` key, falling back to the `~/.issue-runner` default — handing it the conflicted state. The resolver's resolution is then presented as an approval interrupt: approving commits the merge and the pool continues; rejecting converts the interrupt into a manual-resolution interrupt that carries the conflicted state plus a note of what the agent tried, and the pool waits for Billy to resolve and resume. A resolver that itself fails (crash, no resolution) takes the same manual path.

## Acceptance criteria

- [ ] A detected conflict spawns the resolver agent automatically, using `resolver=` or the default harness
- [ ] The resolver's resolution is presented as an approval interrupt before any commit
- [ ] Approving commits the merge and the pool continues automatically
- [ ] Rejecting converts to a manual-resolution interrupt carrying the conflicted state and the agent's attempt
- [ ] A resolver crash or failure takes the manual path with the failure noted
- [ ] Manual resolution followed by resume completes the merge and continues the pool
- [ ] Covered by engine-seam tests with real git conflicts and a stub resolver

## Blocked by

- 02 — Interrupt engine
- 05 — Worktrees and parallel super-steps
