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

---

## Notes

- Design, settled before coding and probed against real git in /tmp: worktree mode applies when the pool sits in a git repo with a HEAD commit and the super-step's ready set has more than one ticket, or a parked worktree already exists for the ticket (checkpoint/crash resume). Single-ticket super-steps without a parked worktree run in the main checkout as before.
- Worktrees live at `<repo>/.git/pool-worktrees/<id>` (invisible to `git status`, proven to work), branches are `pool/<id>`, all cut from HEAD before any spawn in the super-step. Git worktree creation, merges and cleanup serialize through the engine; merges chain onto a promise queue in ticket completion order.
- The main checkout's Issue file is the truth. It is copied into the worktree at spawn (brings resume notes along), the marker is read back from the worktree copy after exit, and a done/checkpoint ticket's Issue content mirrors back to the main checkout so the dual-write and Brief stay inspectable there.
- Merge vs the dirty dual-write, proven in the probe: git refuses a merge that would touch the locally modified Issue file. The merge step moves the Issue file aside, merges, and renames it back, so engine bookkeeping never blocks a merge and is never committed by it.
- A conflicting merge is aborted (`git merge --abort`), the working branch is left clean, and a `merge-conflict` interrupt carries the conflicted files, the branch and the worktree path. The ticket stays done: its outcome still flows downstream (outcomes come from the runs directory, not the merge). Resuming that interrupt re-attempts the merge; "Already up to date" or a deleted branch counts as resolved by hand.
- A running ticket is never rebased by construction: the engine has no rebase path at all. A resumed ticket keeps its parked worktree at its original base and merges from there.
- Successful merges remove the worktree (`git worktree remove --force`, which is why the Issue mirrors back first) and delete the branch. Conflict and checkpoint keep both parked.

---

## Brief, written by the runner

The agent stopped without setting its own status, last seen as 'in-progress'. It crashed, ran out of context, or was killed. It had no chance to write a brief or to commit.

- Stopped: 2026-08-19 23:06
- Log: `.scratch/console-pool/runs/05.log`
- Working tree at the stop:

```
 M .scratch/console-pool/issues/03-durability.md
 M .scratch/console-pool/issues/04-harness-spawn-kernel.md
 M .scratch/console-pool/issues/05-worktrees-parallel.md
 M engine/engine.test.ts
 M engine/engine.ts
?? .scratch/console-pool/runs/
?? engine/worktrees.ts
```

Last lines of the log:

```
All 43 pass. Let me run the full test suite and typecheck:
[0m$ [0mbun test 2>&1 | tail -6 && bun x tsc --noEmit && echo TSC-OK
bun test v1.3.14 (0d9b296a)

 125 pass
 0 fail
 397 expect() calls
Ran 125 tests across 2 files. [1255.00ms]
TSC-OK
[0m
Full suite green. Per the implement skill, now the code review:
[0m✗ [0mRead /home/billy/.claude/commands/skills/code-review/SKILL.md failed
[91m[1mError: [0mFile not found: /home/billy/.claude/commands/skills/code-review/SKILL.md
[0m
[0m$ [0mls /home/billy/.claude/commands/skills/ 2>/dev/null; ls /home/billy/.agents/skills/code-review/
deprecated
engineering
in-progress
misc
personal
productivity
agents
SKILL.md
[0m
[91m[1mError: [0mYou've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing
```

Nothing above is confirmed. Read the log before you trust any part of this Issue.
