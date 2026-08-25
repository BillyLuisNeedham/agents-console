<!-- state: id=07 blocked-by=01,02,03,04,05,06 status=ready -->
# 07: Code review of the resume-feedback work

**What to build:** A full review of everything tickets 01-06 landed, run through the code-review skill against the spec (`docs/specs/2026-08-25-resume-feedback-and-pool-drive-fixes.md`) and ADR-0004. Check the work along both axes the skill provides: does it follow the repo's documented standards, and does it match what the spec and the tickets actually asked for. Verify each ticket's acceptance criteria genuinely hold, that the test suites pass, and that the accept/process split was honoured (no answer path ever spawns an attempt; the queued-answer store stays out of PoolState). Append every finding to this Issue as a numbered list under a `## Findings` heading, each marked blocker or nit. An empty findings list is a valid, successful outcome.

**Blocked by:** 01, 02, 03, 04, 05, 06

**Status:** ready-for-agent

- [ ] The code-review skill has been run over the full diff of tickets 01-06
- [ ] Every finding is appended to this Issue under `## Findings`, numbered, each marked blocker or nit
- [ ] `bun test` and `bun run typecheck` pass and their output is noted in the Issue
- [ ] The accept/process split is verified: acceptance never spawns, the queued-answer store is separate from PoolState, resume is idempotent
- [ ] The Issue closes with an explicit verdict: clean, or N blockers for ticket 08
