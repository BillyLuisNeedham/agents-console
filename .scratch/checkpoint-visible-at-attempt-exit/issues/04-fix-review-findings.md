<!-- state: id=04 blocked-by=03 status=ready -->
# 04: Fix the review findings

**What to build:** Resolve every blocker finding ticket 03 recorded under its `## Findings` heading, working them in order. Each fix lands with a test that pins it at the appropriate existing seam (engine, or UI projection), following the spec's testing decisions. Nits may be fixed at the orchestrator's judgement or left, with the decision noted in this Issue. If ticket 03's verdict was clean (no blockers), this ticket is done immediately: note that in the Issue and set it done without further work.

**Blocked by:** 03: Code review of the checkpoint-at-exit work

**Status:** ready-for-agent

- [ ] Every blocker finding from ticket 03 is resolved, or this Issue records 03's clean verdict and stops
- [ ] Each fix is pinned by a test at an existing seam
- [ ] Each nit is either fixed or consciously deferred, with the decision noted in this Issue
- [ ] `bun test` and `bun run typecheck` pass
