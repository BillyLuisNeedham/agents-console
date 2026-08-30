<!-- state: id=06 blocked-by=02 04 05 status=checkpoint -->

# 06 — Final review of the branch

Spec: `docs/specs/2026-08-30-engine-owns-final-status.md`

## What to build

This is the final ticket of the pool. Once tickets 02, 04 and 05 are done, review the complete diff of branch fix/issue-18-engine-owns-status against main using the code-review skill, on both its axes: standards (does the code follow the repo's documented standards) and spec (does it match docs/specs/2026-08-30-engine-owns-final-status.md and issue #18). Trivial findings (typos, dead code, obvious nits) may be fixed directly in this ticket. Anything material (a design disagreement, a spec acceptance criterion not met, a behaviour change needed) must NOT be fixed: set status=checkpoint with a Brief listing each finding and what the human must decide.

## Acceptance criteria

- [x] code-review run over the full diff main...fix/issue-18-engine-owns-status
- [x] every standards finding either fixed (trivial) or reported in a checkpoint brief (material)
- [x] every user story and acceptance criterion of the spec verified against the code
- [x] `bun test`, `cd ui && bun test` and `bun run typecheck` all green

## Notes

- Ran the code-review skill over `main...HEAD`: Standards and Spec axes as parallel deepseek
  subagents, then verified every material claim myself against the code.
- Ticket 04 completed while the review was in flight (commit 3465628, skills-repo push 1a3d375),
  so both subagents' headline finding ("standing instructions not rewritten") was stale by
  aggregation time. I reviewed commit 3465628 directly: the six tracked pool copies and the
  template carry the outcome-JSON contract with wording consistent with `prompt.ts:92-98`.
  The skills repo is clean and pushed.
- User stories 1-12 verified against the code: status from outcome JSON only (engine.ts:1866-1884),
  crash payload carries code plus reason (engine.ts:1898-1904), checkpoint Brief landed and
  interrupt raised at attempt exit (engine.ts:1876-1880), Brief survives rehydration via the
  Issue, Review unchanged (engine.ts:1438-1471), rehydration trusts markers (engine.ts:653-663),
  standing instructions rewritten (ticket 04), ADR-0005 and the Outcome glossary entry present.
- Checks: 321 engine tests, 128 UI tests, both `tsc --noEmit` passes, all green on the final HEAD.
- Minor findings reported but not fixed (all judgement calls, none worth churn): the fifth crash
  class "outcome has no summary string" (engine.ts:1727) is not in the spec's enumeration and has
  no contract test; the checkpoint Brief replaces any stale Brief section rather than appending
  (deliberate, recorded in ticket 02's outcome and the comment at engine.ts:1609-1616); the reset
  note path (engine.ts:686) appends without stripping old Brief sections, but no reader is harmed
  because `stripBriefSections` removes both heading forms on the next checkpoint; the two
  Brief-append shapes differ in separator handling; crash reasons are raw strings rather than a
  literal union.

## Brief

What I completed: the full two-axis review of `main...fix/issue-18-engine-owns-status`, with every
material claim re-verified by hand, and all four checks green. The branch faithfully implements the
spec: all 12 user stories check out, all 8 required contract tests exist, interrupt timing is
unchanged, and tickets 01-05's deliverables are all present on the branch.

One material finding needs your decision (proven by reading engine.ts, labelled a hole, not a
guess):

1. **A stale outcome file defeats the "missing outcome is a crash" contract.** The outcome path is
   per-ticket (`runs/<id>.outcome.json`, engine.ts:1823) and is deleted only on review-reject
   (engine.ts:1451), never at spawn. So when an attempt leaves a valid new-schema outcome behind
   (a checkpoint always does; a crash after writing the outcome does too) and the next attempt
   exits 0 without writing a fresh outcome, for example an agent that writes the file to a
   worktree-relative path, `readOutcomeResult` (engine.ts:1866) reads the stale file and the engine
   records the stale status. Consequences: after a checkpoint, the human is re-raised the brief
   they already answered; after a crash-with-valid-outcome, a ticket can go falsely `done` and
   merge, with Review as the only backstop. The spec's crash list ("missing outcome file") is met
   by the letter, so this is a robustness gap the spec did not anticipate, not a spec breach.

   Recommended fix (a behaviour change, so not made under this ticket): delete the outcome file at
   spawn (`rmSync(outcomePath, { force: true })` in `runTicket` before `spawnToLog`) so every
   attempt starts with no outcome, plus a contract test: stale outcome from the previous attempt
   plus exit 0 with nothing written crashes with "no outcome written". The alternative is to accept
   the hole and document it, since Review remains the human check on any done claim.

What the human has to do: decide fix-now vs accept-and-document for finding 1. Everything else in
the review is either verified-clean or a judgement-call nit listed under Notes; no action needed on
those unless you disagree.

After you have decided: if fix-now, a small follow-up ticket (one line plus one contract test)
closes it and the branch is ready for its PR; if accept, note it in ADR-0005 or the spec's Further
Notes and open the PR. Either way the branch is otherwise ready to land.