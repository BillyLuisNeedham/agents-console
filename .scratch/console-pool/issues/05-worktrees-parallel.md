<!-- state: id=05 blocked-by=01 status=ready -->

# 05 — Worktrees and parallel super-steps

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

True parallel fan-out with git isolation. When a super-step's ready set has more than one ticket, each ticket gets its own git worktree branched from current HEAD at super-step start, and the tickets' harness processes run concurrently against the shared starting snapshot. As tickets finish, their branches merge back onto the pool's working branch in completion order. A running ticket is never rebased. When a merge conflicts, the engine detects it, records the conflicted state, and raises the merge-conflict interrupt kind (resolution itself is ticket 06 — here it is enough that the conflict surfaces cleanly and the pool continues other work). Downstream tickets still receive their blockers' outcomes even when their worktree was cut before those blockers merged.

## Acceptance criteria

- [ ] A multi-ticket ready set runs concurrently, each in its own worktree branched from HEAD
- [ ] All tickets in a super-step observe the same starting snapshot
- [ ] Finished branches merge in completion order onto the pool's working branch
- [ ] A running ticket is never rebased
- [ ] A conflicting merge is detected, its conflicted state recorded, and a merge-conflict interrupt raised without stalling unrelated tickets
- [ ] A downstream ticket's prompt carries its blockers' outcomes regardless of merge timing
- [ ] Covered by engine-seam tests using real git in temp directories, including a constructed clash between two stub tickets

## Blocked by

- 01 — Pool engine walking skeleton
