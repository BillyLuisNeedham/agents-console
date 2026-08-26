<!-- state: id=01 blocked-by=none status=ready -->
# 01: Terminal results join pool state at attempt exit

**What to build:** When an attempt exits with a terminal result — `done` or `checkpoint` — that ticket's status lands in pool state and a snapshot is emitted immediately, without waiting for its super-step siblings. A ticket that finishes early shows its true status word on its card (green `done`, red `checkpoint`) while siblings still show `running`. The crash path already emits at exit; this ticket generalises the same treatment to all terminal results. The super-step boundary join becomes skip-if-present: applying the same terminal update twice is a no-op, and anything genuinely computed across results stays at the boundary. Reconnecting clients and state polls during the window see the truth, because the emitted snapshot itself carries it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A super-step of two tickets where one finishes `done` quickly and the other runs slowly emits a snapshot before the slow sibling exits showing the fast ticket `done` and the slow ticket still `in-progress`
- [ ] The same shape with a fast `checkpoint` emits a snapshot showing that ticket `checkpoint` while the sibling still runs
- [ ] The boundary join after at-exit joins produces no duplicate or divergent state (idempotent), and the final snapshot sequence is coherent
- [ ] Non-terminal behaviour is unchanged: siblings are never paused or cancelled, and the merge queue and deadlock detector are untouched
- [ ] Engine seam tests (stub harnesses, including a blocking stub that holds a super-step open) cover all of the above; `bun test` and `bun run typecheck` pass

---

## Brief, written by the runner

You interrupted this run. The work is part done at best, and the agent had no chance to write its own brief or to commit. The Issue is back to ready, so read this note and the working tree before you start the queue again.

- Stopped: 2026-08-26 13:29
- Log: `.scratch/checkpoint-visible-at-attempt-exit/runs/01.log`
- Working tree at the stop:

```
 M .scratch/checkpoint-visible-at-attempt-exit/issues/01-terminal-results-join-at-attempt-exit.md
?? .scratch/checkpoint-visible-at-attempt-exit/runs/
?? .scratch/resume-feedback/runs/
```

Last lines of the log:

```

**What to build:** A full review of everything tickets 01-02 landed, run through the code-review skill against the spec (`docs/specs/2026-08-26-checkpoint-visible-at-attempt-exit.md`) and ADR-0004. Check the work along both axes the skill provides: does it follow the repo's documented standards, and does it match what the spec and the tickets actually asked for. Verify each ticket's acceptance criteria genuinely hold, that the test suites pass, and that the settled semantics were honoured: siblings are never paused by an early checkpoint, the boundary join is idempotent after at-exit joins, answers during the window are queued and processed only at the boundary, and the queued-answer store stays out of PoolState. Append every finding to this Issue as a numbered list under a `## Findings` heading, each marked blocker or nit. An empty findings list is a valid, successful outcome.

**Blocked by:** 01, 02

==> .scratch/checkpoint-visible-at-attempt-exit/issues/04-fix-review-findings.md <==
<!-- state: id=04 blocked-by=03 status=ready -->
# 04: Fix the review findings

**What to build:** Resolve every blocker finding ticket 03 recorded under its `## Findings` heading, working them in order. Each fix lands with a test that pins it at the appropriate existing seam (engine, or UI projection), following the spec's testing decisions. Nits may be fixed at the orchestrator's judgement or left, with the decision noted in this Issue. If ticket 03's verdict was clean (no blockers), this ticket is done immediately: note that in the Issue and set it done without further work.

**Blocked by:** 03: Code review of the checkpoint-at-exit work

==> .scratch/checkpoint-visible-at-attempt-exit/issues/05-final-code-review.md <==
<!-- state: id=05 blocked-by=04 status=ready -->
# 05: Final code review

**What to build:** The closing review, run through the code-review skill over ticket 04's fixes (and the whole body of work, if 04 changed anything substantial). Confirm every blocker finding from ticket 03 is genuinely resolved and pinned by a test, no new blockers were introduced, and the suites still pass. Append the verdict to this Issue under a `## Verdict` heading. If new blockers appear, set this Issue to checkpoint with a brief describing them rather than fixing them yourself.

**Blocked by:** 04: Fix the review findings
[0m
Terminated                 opencode run --command "$driver" "$rel

${prompt#*'
'}" --model "$model" --auto < /dev/null
```

Nothing above is confirmed. Read the log before you trust any part of this Issue.
