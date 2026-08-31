<!-- state: id=08 blocked-by=07 status=ready -->

# 08 — Final review of the stale-outcome fix

Spec: `docs/specs/2026-08-30-engine-owns-final-status.md`

## What to build

This is the second and final review of the pool. Once ticket 07 is done, review the complete diff of branch fix/issue-18-engine-owns-status against main using the code-review skill, on both its axes: standards (does the code follow the repo's documented standards) and spec (does it match docs/specs/2026-08-30-engine-owns-final-status.md and issue #18). Ticket 06 already reviewed the branch once and found the stale-outcome hole that ticket 07 fixes, so verify 07's fix and its contract test against that Brief in particular, then re-verify the rest of the branch the way ticket 06 did (its Notes record what was already checked, so build on them rather than rediscovering). Trivial findings (typos, dead code, obvious nits) may be fixed directly in this ticket. Anything material (a design disagreement, a spec acceptance criterion not met, a behaviour change needed) must NOT be fixed: set status=checkpoint with a Brief listing each finding and what the human must decide.

## Acceptance criteria

- [ ] code-review run over the full diff main...fix/issue-18-engine-owns-status
- [ ] ticket 07's fix and contract test verified against the stale-outcome hole described in ticket 06's Brief
- [ ] every standards finding either fixed (trivial) or reported in a checkpoint brief (material)
- [ ] every user story and acceptance criterion of the spec verified against the code
- [ ] `bun test`, `cd ui && bun test` and `bun run typecheck` all green
