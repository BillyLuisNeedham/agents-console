<!-- state: id=08 blocked-by=07 status=ready -->
# 08: Fix the review findings

**What to build:** Resolve every blocker finding ticket 07 recorded under its `## Findings` heading, working them in order. Each fix lands with a test that pins it at the appropriate existing seam (engine, server, or UI projection), following the spec's testing decisions. Nits may be fixed at the orchestrator's judgement or left, with the decision noted in this Issue. If ticket 07's verdict was clean (no blockers), this ticket is done immediately: note that in the Issue and set it done without further work.

**Blocked by:** 07: Code review of the resume-feedback work

**Status:** ready-for-agent

- [ ] Every blocker finding from ticket 07 is resolved, or this Issue records 07's clean verdict and stops
- [ ] Each fix is pinned by a test at an existing seam
- [ ] Each nit is either fixed or consciously deferred, with the decision noted in this Issue
- [ ] `bun test` and `bun run typecheck` pass
