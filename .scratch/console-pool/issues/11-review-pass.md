<!-- state: id=11 blocked-by=01,02,03,04,05,06,07,08,09,10,12,13,14,15 status=checkpoint -->

# 11 — Review pass against the spec

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

Final review pass over the whole ticket-pool Console before calling the spec done. Run a review (standards + spec axes — the `code-review` or `peer-review` skill) across the full diff of tickets 01 to 15, verify every user story in the spec and its follow-up `.scratch/console-pool/spec-console-flight-fixes.md` is demonstrably working, and address the findings. The fixed point for the review is the commit immediately before ticket 01's commit. Vocabulary gets specific attention: state, channel, reducer, super-step, checkpoint, thread, interrupt, ticket, Review, Console, Detail per CONTEXT.md, with avoid-words absent from code and UI copy.

## Acceptance criteria

- [x] Both review axes run over the full diff from the fixed point
- [ ] Every user story in the spec is verified as demonstrably working, with the verification noted
- [x] CONTEXT.md vocabulary is used correctly in code and UI copy; avoid-words absent
- [ ] All findings addressed or explicitly deferred with reasons recorded
- [x] Full test suite, typecheck, and build all clean

## Blocked by

- 01 — Pool engine walking skeleton
- 02 — Interrupt engine
- 03 — Durability and rehydration
- 04 — Harness spawn kernel
- 05 — Worktrees and parallel super-steps
- 06 — Resolver agent and conflict approval
- 07 — Server and pool projection UI
- 08 — Inline interrupts in card and Detail
- 09 — Final Review interrupt
- 10 — my-console-runner skill
- 12 — Ticket cards open the Detail panel
- 13 — Pool stream survives a quiet pool
- 14 — Flow neighbourhood highlighting
- 15 — my-console-runner launches on mac and linux

## Notes

Blocked-by extended over 12 to 15 (added after this ticket's first checkpoint): the review pass runs last, over the proving-flight fixes as well as the original ten. The review below covered tickets 01 to 10; when this ticket resumes after 12 to 15 land, the re-review covers the new diff against spec-console-flight-fixes.md.

Fixed point: `41ac900` (the queue-setup commit, immediately before ticket 01's `4e96563`). Diff: `git diff 41ac900...HEAD`, 16 commits, 32 files, +6370/-4064. Code under review: `engine/` and `ui/`. Both axes ran as parallel sub-agents per the code-review skill.

Checks: `bun test` 97 pass / 0 fail; `tsc --noEmit` clean; `bun run build` in `ui/` clean.

Story verification: 31 of 34 user stories verified working (evidence mapped story-by-story to tests in `engine/engine.test.ts`, `engine/server.test.ts`, `ui/src/project.test.ts`, issue notes, and the ticket-10 proving flight). Stories 13, 24, 27 are PARTIAL; see the Spec findings in the Brief.

Vocabulary judgement I made (the review did not settle it): the Standards axis flagged ~38 uses of "Issue" in new engine identifiers (`issuesDir`, `issuePath`, `loadPoolMarkers`), and CONTEXT.md lists "issue" as an avoid-word for Ticket. I suppressed it: the spec itself names the on-disk format "directories of Issue files with line-1 state markers" (spec line 7), and the documented spec language overrides the baseline. The engine uses "ticket" for the domain concept and "Issue file" only for the disk artifact, matching the UI copy. If Billy disagrees, a rename is mechanical.

Em-dash findings are real runner-convention violations but trivial: one in `engine/engine.test.ts:1369` prose, plus several in `.scratch/console-pool/` runner-note prose added by earlier tickets.

## Standards (sub-agent report, lightly cleaned)

Documented-standard issues:

1. CONTEXT.md vocabulary, "issue" avoid-word: new engine code coins `issuesDir`, `issuePath`, `issueRel`, `issueRunnerPath` etc. (~38 uses in `engine.ts`). Judgement call, suppressed per the Notes reasoning above; the file format name is inherited from `my-issue-runner` and the spec's own wording.
2. Prose without em dashes: `engine/engine.test.ts:1369` ("done is stale — and the earlier review approval lapses with it") plus em dashes in `.scratch/console-pool/` runner-note prose. Hard violation of a documented runner convention, trivially fixable.

Clean on: no AI-tool attribution anywhere; dependencies only dropped (`@langchain/langgraph-sdk` removed from `ui/package.json`); sqlite from `bun:sqlite` only.

Baseline smells (all judgement calls):

1. Duplicated Code in `engine.ts`: the four answer paths (`answerTicket`/`resumeMerge`/`approveMerge`/`rejectMerge`) repeat the resume-note append, the worktree/branch construction, and the filter-interrupt-then-drive tail.
2. Primitive Obsession: the `"resume" | "approve" | "reject"` tri-state declared three times (`server.ts`, `client.ts`, `project.ts`), internally smuggled as `approve?: boolean`.
3. Data Clumps: `(session, marker, interrupt, note)` travels together across all four answer paths; `Session` is a 19-field struct threaded everywhere.
4. Shotgun Surgery: `REVIEW_TICKET_ID` (`engine.ts`) and `REVIEW_CARD_ID` (`project.ts`) are the same string "by contract"; adding an interrupt kind touches the engine union, the `answerTicket` cascade, and `INTERRUPT_FORMS`.
5. Speculative Generality: `TopologyEdge.conditional`/`data` never set by the pool projection (carried over from the thread Console); `layoutPool`/`projectPoolEdges` id defaults never overridden.
6. Repeated Switches: the `interrupt.kind` cascade in `answerTicket` mirrors the action switch in `server.ts` and the `INTERRUPT_FORMS` keying in `project.ts`.
7. Test choreography duplication in `engine.test.ts`, flagged by the ticket-05 review and left unaddressed.

Standards summary: 2 documented-standard findings (1 suppressed by judgement, 1 real but trivial), 7 baseline smells, all judgement calls. Worst: the answer-path duplication in `engine.ts`.

## Spec (sub-agent report, lightly cleaned)

(a) Missing or partial:

1. Story 13 (spec line 78: "one git worktree per running ticket, branched from HEAD at super-step start"). `planTicket` (`engine.ts:1209`) runs a single-ticket super-step in the main checkout, not a worktree. The spec's wording is unconditional. Documented in ticket 05's notes.
2. Story 27 (spec line 59: "a harness crash — a ticket that ends with no status set — surfaced as an interrupt"). Only a read-back of `in-progress` raises the crash interrupt. A main-checkout harness that exits leaving `status=ready` is immediately re-spawned by `readyTickets` (`engine.ts:171-176`, `:1337`): an unbounded spawn loop that never reaches a human. Ticket 02's own notes flag "re-spawn forever" as uncovered.

(b) Scope creep:

1. `agents` key in console.json: spec line 73 names the console.json contents and `agents` is not among them, yet it is added at `engine.ts:61`, `spawn.ts:31`, the skill, and this pool's console.json. Ticket 04 recorded it as a decision for 11 to weigh.
2. `reviewApproved` channel: spec line 76 lists exactly four channels (`tickets`, `log`, `outcomes`, `config`); a fifth state field is added (`engine.ts:93`). Defensible for durable Review approval across restarts (stories 29/30), but beyond the named channels.

(c) Implemented but looks wrong:

1. Story 24: the resolver is broken on opencode, this pool's configured resolver. `RESOLVER_DRIVER = "resolve"` (`engine.ts:686`) goes through opencode's `--command resolve` (`spawn.ts:42`), but no `resolve` command stub exists in `~/.config/opencode/command/` (only `resolving-merge-conflicts.md`, a different name). With `"resolver": "opencode"` in console.json, every conflict degrades to the manual path with a "resolver exited N" note. claude's resolver works; opencode's does not.
2. Crash semantics are mode-inconsistent: the worktree read-back maps a `ready` write to `in-progress` and raises the crash interrupt (`engine.ts:1231`), while the main-checkout read-back returns `ready` verbatim, producing the infinite respawn of finding (a)2. The same agent behaviour yields opposite outcomes depending on worktree mode.

Spec summary: 6 findings. Worst: (c)1, the opencode resolver path never works, so story 24 is silently degraded on this pool's own configuration.

## Brief

1. Completed: both review axes over the full diff from `41ac900`; story-by-story verification of all 34 spec user stories (31 verified with cited evidence, 3 partial); vocabulary pass over code and UI copy; full test suite (97/97), `tsc --noEmit`, and the `ui/` build all clean. No code changed, per the Issue's rules.

2. Billy has to rule on the findings:

   - **Accept or fix story 13's deviation**: single-ticket super-steps run in the main checkout, not a worktree. Either amend the spec wording to match, or make `planTicket` unconditional-worktree.
   - **Fix or defer the crash-detection gap**: a main-checkout harness exiting with `status=ready` re-spawns forever instead of raising a crash interrupt (stories 19 and 27), and the worktree path treats the same marker differently. This is the only finding that can silently burn harness spend.
   - **Fix the opencode resolver name** (`resolve` vs `resolving-merge-conflicts`) or change this pool's `resolver=` to a harness whose command stub exists. As configured, story 24 never exercises the resolver agent.
   - **Ratify or remove the scope creep**: the `agents` console.json key and the `reviewApproved` channel. Both look deliberate and useful; the spec text just never named them.
   - **Em dashes**: one in `engine/engine.test.ts:1369`, several in earlier `.scratch` runner notes. Trivial sweep.
   - **Baseline smells** (answer-path duplication, tri-state declared three times, Session god-object, REVIEW id contract string): judgement calls; defer, ticket, or leave.

3. After Billy rules: fixes become new tickets or a small fix pass on this branch, then either re-run this review over the new diff or accept the remaining findings and call the spec done. The run's final Review interrupt (ticket 09's machinery) is still pending in the pool, so the pool itself is waiting on the same decision.
