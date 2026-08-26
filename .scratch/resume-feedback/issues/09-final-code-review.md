<!-- state: id=09 blocked-by=08 status=done -->
# 09: Final code review

**What to build:** The closing review, run through the code-review skill over ticket 08's fixes (and the whole body of work, if 08 changed anything substantial). Confirm every blocker finding from ticket 07 is genuinely resolved and pinned by a test, no new blockers were introduced, and the suites still pass. Append the verdict to this Issue under a `## Verdict` heading. If new blockers appear, set this Issue to checkpoint with a brief describing them rather than fixing them yourself.

**Blocked by:** 08: Fix the review findings

**Status:** ready-for-agent

- [x] The code-review skill has been run over ticket 08's changes
- [x] Every blocker from ticket 07 is confirmed resolved and pinned by a test
- [x] `bun test` and `bun run typecheck` pass and their output is noted in the Issue
- [x] The Issue closes with an explicit verdict under `## Verdict`: approved, or checkpointed with the new blockers described

## Review

Run per the code-review skill: fixed point `ea66aaf`, diff `ea66aaf...HEAD`
(ticket 08's single commit 48d2eb9), both axes as parallel sub-agents, key
claims spot-checked against the code by the reviewer. Ticket 08's diff is
contained (one commit, 200 insertions across engine, tests, and the two UI
refactors), so the review is over that diff; the whole body of tickets 01-06
was already reviewed in ticket 07 and 08 touched none of its substance.

### Standards

No hard violations.

- **Commit prefix, judgement call:** commit 48d2eb9 is titled `engine:` but
  also carries `ui/src/canvas.ts` and `ui/src/project.ts` (the finding 4 and
  5 refactors). One prefix is the convention and the engine change is the
  substantive one, but the prefix understates the scope. Already landed;
  noted alongside 07's finding 7 for the next queue.
- **Duplicated Code, judgement call:** the "nothing was recorded" assertion
  block (no `answered` event in the ticket log, no `queued-answers.json` on
  disk) appears in both `engine/engine.test.ts` and `engine/server.test.ts`.
  Defensible as pinning at two seams per the spec's testing decisions; a
  shared `expectNothingRecorded(poolDir)` helper would bind them. Left as is.
- **Speculative Generality, flagged and dismissed:** `handleOf`'s guard
  comment says it "never fires in practice", but it replaces the type-unsafe
  `undefined as unknown as PoolRun` bootstrap and gates every read, so it
  earns its keep.
- CONTEXT.md vocabulary, em-dash-free prose, and no AI attribution all check
  out. `namedReviewTickets`, `reviewRejectUnnamedError`, `handleOf`,
  `interruptDot`, `isAnswerQueued` are all honest names, and the two UI
  extractions remove the duplication 07 flagged.

### Spec

Blocker fix verified correct in the code, not only claimed:

- The unnamed-reject check in `acceptAnswer` runs after interrupt lookup and
  the duplicate check but before `appendEvent` and the queue write, so the
  400 the spec promises ("400 only for genuinely invalid answers") now comes
  from acceptance and nothing is recorded for an answer that had no effect.
- The duplicate check still runs first, so a retried reject of an
  already-accepted reject returns 202, matching the spec's idempotent-resume
  contract.
- The processing-time guard remains as a backstop for records accepted
  before the fix (`rejectReview` keeps its throw via the shared
  `reviewRejectUnnamedError`), satisfying finding 1's "or otherwise surface
  the processing failure".
- Pinned at two existing seams, per the spec's testing decisions: the engine
  test "reject without a named ticket throws and keeps the gate up" now also
  asserts nothing was recorded, and a new server test drives an invalid
  reject over real HTTP (400, gate still up, no queue file, valid reject
  still accepted).
- ADR-0004 untouched: acceptance still never spawns, the queued-answer store
  stays out of PoolState, join and merge semantics have no diff hunks.

Two minor items, neither a blocker:

1. **Coverage gap:** idempotent retry is tested for resume and approve but
   not for a reject-specific retry; the duplicate-first ordering that makes
   it safe is verified in the code. Behaviour present, test absent.
2. **Edge case, pre-scoped:** the acceptance check reads in-session markers
   while `processAnswer` reloads them, so a reject naming a ticket present
   on disk but absent from the session list would 400 at acceptance. 07's
   finding 1 explicitly scoped this ("markers are in-session, so the
   named-ticket check can run there").

No scope creep: the `rejectReview` refactor is behaviour-neutral (identical
message, identical note append), and no new public surface was added.

### Test and build output

- `bun test`: 298 pass, 0 fail, 1123 expect() calls, 10 files, 18.24s.
- `bun run typecheck` (`tsc --noEmit`): clean, no output.
- `bun install && bun run build` in `ui/`: vite built in 64ms, no warnings.

## Verdict

Approved. Ticket 07's one blocker is genuinely resolved and pinned by tests
at the engine and server seams, no new blockers were introduced, and all
suites pass. The remaining items are two judgement-call nits (mixed-scope
commit prefix, duplicated test assertion) and two minor spec notes (an
unpinned reject-retry path, a pre-scoped marker-staleness edge case), none
of which block the queue.
