<!-- state: id=08 blocked-by=07 status=in-progress -->

# 08 — Final review of the stale-outcome fix

Spec: `docs/specs/2026-08-30-engine-owns-final-status.md`

## What to build

This is the second and final review of the pool. Once ticket 07 is done, review the complete diff of branch fix/issue-18-engine-owns-status against main using the code-review skill, on both its axes: standards (does the code follow the repo's documented standards) and spec (does it match docs/specs/2026-08-30-engine-owns-final-status.md and issue #18). Ticket 06 already reviewed the branch once and found the stale-outcome hole that ticket 07 fixes, so verify 07's fix and its contract test against that Brief in particular, then re-verify the rest of the branch the way ticket 06 did (its Notes record what was already checked, so build on them rather than rediscovering). Trivial findings (typos, dead code, obvious nits) may be fixed directly in this ticket. Anything material (a design disagreement, a spec acceptance criterion not met, a behaviour change needed) must NOT be fixed: set status=checkpoint with a Brief listing each finding and what the human must decide.

## Acceptance criteria

- [x] code-review run over the full diff main...fix/issue-18-engine-owns-status
- [x] ticket 07's fix and contract test verified against the stale-outcome hole described in ticket 06's Brief
- [x] every standards finding either fixed (trivial) or reported in a checkpoint brief (material)
- [x] every user story and acceptance criterion of the spec verified against the code
- [x] `bun test`, `cd ui && bun test` and `bun run typecheck` all green

## Notes

- Ran the code-review skill over `main...HEAD` (9 commits, head ff71a2a): Standards and Spec axes
  as parallel deepseek subagents, then verified every material claim myself against the code.
  The repo documents no coding standards, so the Standards axis carried only the smell baseline.
- Ticket 07 verified against ticket 06's Brief (proven by reading the diff of ff71a2a): the fix is
  exactly the recommended `rmSync(outcomePath, { force: true })` at spawn in `runTicket`
  (engine.ts:1827-1829), plus the same delete at resolver spawn in `runResolver`
  (engine.ts:1176-1178) for the resolver-side hole 07's Notes confirmed. The contract test
  "never honors a stale outcome a previous attempt left behind" (engine.test.ts:1484) drives
  attempt 1 to a checkpoint, resumes, and has attempt 2 exit 0 writing nothing ("keep"); the
  engine records a crash with payload `{code: 0, reason: "no outcome written"}` and the marker
  back at in-progress. The stale checkpoint brief is not re-raised. Hole closed.
- Delta since ticket 06's review is commits b144530, d440a71 (docs only), 3465628 (standing
  instructions, which 06 reviewed directly) and ff71a2a (verified above). The rest of the branch
  stands on 06's verification: user stories 1-12, all 8 required contract tests, interrupt timing
  unchanged. The Spec subagent re-verified all 12 stories and all 8 contract tests against the
  spec and found no missing or partial spec requirement.
- No material findings. Nothing fixed in this ticket because nothing rose to trivial-typo level;
  the findings below are all judgement calls, recorded per ticket 06's precedent:
  - The resolver-side stale-outcome fix has no contract test of its own (the ticket path does).
    Ticket 07's acceptance criteria asked only for the decision to be recorded in Notes, which it
    was; the spec's contract-test list covers the ticket path and holds the resolver outcome
    contract out of scope ("stays as they are"). Inference: regression risk is low because the
    fix is one line identical in shape to the tested ticket path.
  - The spawn-side delete is duplicated verbatim (with a cross-referencing comment) in runTicket
    and runResolver. A shared helper for a single `rmSync` call would be a Middle Man; left as is.
  - The outcome artifact has two names (`<id>.outcome.json` vs `<id>.resolver.json`). Pre-existing;
    renaming would churn rehydrate and the review-reject delete for no behavioural gain.
  - The bash outcome-writer stub is inlined in three places across engine.test.ts and
    server.test.ts (two of the three were rewritten by this branch). Cross-file test-stub
    extraction judged not worth the churn.
  - `readOutcomeResult`/`OutcomeResult` naming sits close to the `Outcome` type it parses;
    judgement call, left as is.
  - `landCheckpointBrief` replaces a stale Brief section rather than appending, and the placeholder
    heading differs from a real brief's. Deliberate and documented (ticket 02, ticket 06 Notes).
- Checks on final HEAD ff71a2a: `bun test` 322 pass, `cd ui && bun test` 128 pass,
  `bun run typecheck` clean in both root and ui.
