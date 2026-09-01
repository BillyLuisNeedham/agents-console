# Verify: grader tickets and selection

Introduces **Verify**, **Grade**, and **Selection**. Recorded in ADR-0006 and the CONTEXT.md "Verification" section.

## Problem Statement

When an attempt exits `done`, the engine writes the ticket's final status on the agent's word alone. There is no check that the work satisfies the ticket. The human finds out at Review, at the end of the whole run — one bad done-claim can sit in a merged branch until then. There is also no way to get a second opinion on a ticket: one attempt, one shot.

## Solution

Verification is per-ticket and opt-in: a ticket that sets `verify: N` gets N parallel attempts and a grader ticket per attempt, each grading its attempt against the ticket's acceptance criteria. The engine selects the best graded attempt and merges only that one. A lone failing attempt (`verify: 1`) becomes a checkpoint interrupt carrying the grader's complaint as its Brief — the human decides what happens next, there is no silent retry. Tickets without `verify` behave exactly as they do today. Everything — graders, the head-to-head, optionally the selection itself — is a ticket in the pool, so harness, model, and scope are chosen through the ordinary ticket machinery, and the whole flow is visible as node cards on the canvas.

## User Stories

1. As Billy, I want verification off unless a ticket opts in with `verify: N`, so that the many runs where I don't care about grading pay nothing.
2. As Billy, I want `verify: N` to mean N parallel attempts and grading in one key, so that there is no combination of flags to get wrong.
3. As Billy, I want tickets without `verify` to run exactly as they do today, so that the feature is pure addition.
4. As Billy, I want a ticket's N attempts spawned in parallel within the normal scheduling round, so that best-of-N needs no new scheduling machinery.
5. As Billy, I want the pool's `verify` skill — the grader's grading instructions — written beside AGENT.md during Console setup, so that grading criteria are tuneable per pool and exist before any ticket opts in.
6. As Billy, I want grader tickets to be real tickets on disk in the pool, so that they render as node cards, carry ordinary blocking edges, and can be edited mid-run.
7. As Billy, I want one grader ticket per attempt, each bound to its attempt's artifacts, so that every candidate gets an independent grade.
8. As Billy, I want to choose the grader's harness and model through the ordinary assign machinery, since grader tickets are ordinary tickets, so that a grader can be a different agent than the builder with zero new config.
9. As Billy, I want the grader to read the ticket file, the attempt's Outcome, the diff at its commit, and the attempt log (trimmed to the last ~20k tokens when huge), so that the grade is grounded in artifacts, not the agent's self-assessment.
10. As Billy, I want the grader instructed to trust terminal output over the agent's summary, so that the grade resists reward hacking.
11. As Billy, I want each grade to carry a score (0–10), a verdict (pass or flag), and short reasons, written into the attempt's record and visible in the ticket's Detail, so that I can see why the winner won.
12. As Billy, I want the engine to take a winner whose margin is ≥2 points outright, so that clear calls cost nothing and no model is invoked.
13. As Billy, I want a tight spread to spawn a single head-to-head ticket comparing the top two attempts side by side, so that close calls get the more reliable pairwise judgment — and that ticket too can run on any harness and model I choose.
14. As Billy, I want a `selection: human` pool option that raises an interrupt at the selection point showing the grades, so that on the runs where I want to be the judge, I pick the winner myself.
15. As Billy, I want `selection: auto` to be the default, so that graded runs don't stall waiting for me.
16. As Billy, I want only the winning attempt's branch merged through the existing merge path, so that pool history contains the work that was actually selected.
17. As Billy, I want losers' branches discarded but their logs, outcomes, and grades kept, so that nothing is silently lost and Detail stays truthful.
18. As Billy, I want a lone failing attempt to raise a checkpoint interrupt with the grader's complaint as the Brief, so that a bad done-claim is caught at the ticket, not at Review.
19. As Billy, I want answering that checkpoint with "resume" to reset the ticket to ready, so that the existing resume path just works.
20. As Billy, I want a grader crash to spawn a fresh grader ticket, not to pass or fail the build ticket on its own, so that verification depends on a grader that actually ran.
21. As Billy, I want merge-resolver attempts left ungraded, so that the resolver flow is untouched in v1.
22. As Billy, I want the engine to keep owning every status write and interrupt, so that ADR-0005's contract holds and agents never write status.
23. As Billy, I want Review unchanged at the end of the run, so that verification sharpens the input to my final judgment rather than replacing it.
24. As a future reader, I want the margin-and-head-to-head selection rule recorded in an ADR, so that the shape is not surprising.

## Implementation Decisions

- **One key.** `verify: N` lives in a ticket's `assign` block. Absent = today's behavior, exactly. N is the number of parallel attempts and the number of grader tickets. There is no separate enable flag and no invalid combination.
- **Everything is a ticket.** Grader tickets and the head-to-head ticket are real tickets, written into the pool's ticket directory by the engine when needed, with ordinary blocking edges: build → its grader tickets → selection. They are removed from the ready set like any finished ticket; the canvas shows the fan-out as node cards.
- **The engine owns the loop, not the judgment.** The engine spawns attempts, spawns grader tickets, reads grades, does the arithmetic selection, spawns the head-tohead ticket only when the margin demands it, raises interrupts, and writes statuses. Graders and the head-to-head ticket supply judgments as Outcomes; they never write status, never merge, never interrupt — consistent with ADR-0005.
- **Grader tickets are ordinary assignments.** Harness and model resolve through the same `assign` machinery as any ticket, so a grader can run on a different model or harness than its build ticket by editing its assignment. The grader's prompt is the pool's `verify` skill parameterized with the bound attempt's ticket file, Outcome, diff at commit, and trimmed log.
- **Grade shape.** `{"score": 0–10, "verdict": "pass" | "flag", "reasons": string}` in the grader's Outcome, copied into the graded attempt's record (ticket log events + Detail).
- **Selection.** Winner = highest score. Margin ≥2 → engine takes it outright. Otherwise one head-to-head ticket sees the top two attempts' artifacts side by side and its Outcome names the winner; on a tie or grader failure, the higher raw score wins, then the earlier attempt.
- **Human selection.** Pool config `selection: auto | human`, default `auto`. In `human`, the engine raises an interrupt at the selection point carrying the grades; the answer names the winning attempt.
- **Grader crash.** A grader that crashes or returns an unparseable grade is re-spawned (fresh grader ticket), bounded by the engine's existing crash-retry behavior. The build ticket never passes or fails because its grader had a bad day.
- **Merge.** Only the winner's branch merges through the existing merge path. Loser branches are deleted; their logs, outcomes, and grades remain in the ticket log.
- **Lone-attempt failure.** `verify: 1` with a failing verdict raises a checkpoint interrupt whose Brief is the grader's complaint, via the Brief path the engine already owns. Resume behaves like any checkpoint resume.
- **Setup.** Console setup writes the pool's `verify` skill beside AGENT.md (seeded with the agreed criteria: does the work match the ticket; do outputs match the claims; are there error signals in the log). Setup gains no enable question — activation is the per-ticket key.
- **Docs.** PR carries the CONTEXT.md "Verification" glossary section and ADR-0006; the setup skill documents the new key and the `verify` skill it writes.

## Testing Decisions

- **Seam: the existing engine integration seam.** Drive the engine end-to-end with fake harness CLIs, exactly as the engine suite does today; the fakes learn paths from environment variables, never by parsing prompts. No new seam is introduced.
- Good tests assert externally visible behavior only: marker statuses on disk, grader tickets created with correct blocking edges, events and grades in the ticket log, interrupts raised and their Briefs, which branch got merged, loser branches gone. They never assert on engine internals.
- The fake harness gains a grader mode: deterministic grade outcomes driven by fixture content (e.g. a magic string in the log yields a known score), so margin and head-to-head paths are exercisable without a model.
- New contract tests cover: no `verify` key = zero behavioral change; `verify: 1` pass → done as today; `verify: 1` fail → checkpoint with complaint Brief; `verify: 3` with clear margin → winner merges, no head-to-head ticket spawned; `verify: 3` with close scores → head-to-head ticket spawned and its winner merges; losers' branches deleted, logs and grades retained; grader crash → fresh grader ticket spawned; `selection: human` → interrupt carries grades and the answer names the winner.
- Prior art: the crash-recording, checkpoint-Brief, and merge-path tests in the engine suite, plus the resolver-spawn tests as the model for the engine spawning ticket-shaped work.

## Out of Scope

- The paper's logprob-expectation scoring (needs DeepSeek API, Vertex Gemini, or vLLM) — plain score first; swap only if grades prove too coarse.
- Grading merge-resolver attempts.
- A separate VERIFY node card type — graders are ordinary ticket cards; no new card rendering.
- Agent-side selection outside the head-to-head ticket, and any Python sidecar — the thin core lives in the engine's own language.
- Pool-level defaults for `verify` — activation is strictly per ticket.

## Further Notes

Inspired by llm-as-a-verifier's Terminal-Bench self-verification results (best-of-N selection beats Pass@1 even when verifier and worker are the same model), but deliberately not a port: their absolute-score selection is replaced by margin-plus-head-to-head (separate grading calls are uncalibrated), their pairwise tournament is collapsed to at most one compare, and the graders are first-class tickets rather than harness internals — which is what makes grader harness and model user-choice. See ADR-0006.
