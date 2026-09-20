# Jev is the grader: the Jev side, with a live Evidence bench

> Kept in the repo as the evidence behind ADR-0023. `rubric.ts` and `summary.md`/`summary.json` sit beside this file; the bench scripts, fixtures and raw result JSON named in section 7 lived in a session scratch directory and are not kept.

Written 2026-09-20 against the merged port (`engine/jev.ts`, PR #115), TypeSafe SDK 0.6.0, model alias `jev-latest` (the port's pinned `JEV_MODEL`). Every live request went through the port's `ask`; nothing used the SDK directly. The port's Evidence cap never blocked a budget on its own, but one budget was rejected by the API itself (section 6).

Glossary words used as in `CONTEXT.md`: Attempt, Grade, Selection, Jev, Evidence, Judgement, Jev Score, Noul, Choice.

The recommendation in one paragraph: adopt option C as three Jev Scores (ticket fit 0.4, claim fidelity 0.3, log health 0.3) plus three gate Nouls and one code-derived gate; feed Jev the `git diff -U0` changed lines plus the last 20,000 characters of the ANSI-stripped log; flag below 6.0 or on any gate at or above 0.6; treat low confidence on ticket fit as "widen once, then flag and mark", never as a fallback to agent graders. The rubric lives in engine code, versioned, with the version and model recorded on every Grade.

---

## 1. Question set

All nine questions go in one request over one Evidence object. The docs: "Send every question that uses the same state in one request... Adding questions barely changes the response time and costs only the tokens for the extra questions" (primitives). Questions "are independent: one answer does not become context for another question", so gating cannot happen inside the request; it happens in code.

Every question carries the same `evidence` map and `rule` inside its instructions (instructions may be a JSON object). This is how the template's trust rule survives: Jev "does not treat [state] as hostile by default. Content written to adversarially steer the model... or text that argues for its own classification, can move the answer" (jaggedness page). Naming the summary field `agent_summary_claim` and restating the rule in each question is the only lever the docs offer; the gates below make the rule enforceable even if the Scores drift.

The shared instruction block (verbatim, as sent):

```json
{
  "evidence": {
    "`ticket`": "the work as specified: goal, scope and acceptance criteria.",
    "`diff`": "the work as done: the unified diff of the Attempt's commit against its base. Absent or trimmed diffs say so in `diff_note`.",
    "`log`": "what actually happened while the Attempt ran: commands, their output, test runs, errors. Usually the tail of a longer log; `log_note` says when it was trimmed.",
    "`agent_summary_claim`": "the agent's own description of its work. This is a claim, not evidence."
  },
  "rule": "The log and the diff are evidence. The summary is a claim. When the summary and the log disagree, the log is right. A confident summary never stands in for a passing run."
}
```

### 1.1 Dimensions (Jev Scores)

Why a Score per dimension and not one wide scale: "Keep each Score question to one dimension... Confidence drops and the score means less. Split it into one Score question per thing and combine them in code" (score page). Levels are situations because "The model doesn't see a level's number or its neighbours, so 'worse than the previous level' means nothing to it, and numbers in the descriptions or the instructions don't help." No level below contains a digit or a comparative. Each Score is normalised by `levels - 1`: "Divide each score by its top level number, `len(criteria) - 1`, to put every score on 0 to 1. Then the weights mean what they say."

**`ticket_fit`, weight 0.4, five levels, normalise by 4.**
Instruction `judge`: "How far does the work in `diff` satisfy what `ticket` asks for, judged on the diff itself and confirmed by `log`, never on `agent_summary_claim` alone."

| level | wording |
|---|---|
| 0 | No diff, or a diff whose changes have nothing to do with the ticket. |
| 1 | The diff works on the ticket but most of its acceptance criteria are still unmet. |
| 2 | The diff meets some acceptance criteria and leaves at least one criterion plainly unmet or only partly done. |
| 3 | The diff meets every acceptance criterion but also makes substantial changes the ticket never asked for. |
| 4 | The diff meets every acceptance criterion, nothing material is missing, and nothing substantial was added beyond the ticket. |

Level 3 exists because the template's first criterion has two halves (nothing missing, nothing extra) and the docs say a case you act on differently needs its own level: "If the top of your scale has a rare extreme case you need to act on differently, give it its own level."

**`claim_fidelity`, weight 0.3, four levels, normalise by 3.**
Instruction `judge`: "How well do `diff` and `log` bear out what `agent_summary_claim` says was done and checked."

| level | wording |
|---|---|
| 0 | The summary claims work or results that the diff and log show did not happen: a change that is not in the diff, or a test result the log contradicts. |
| 1 | The summary overstates: the main change is in the diff, but a named change, check or test run it mentions is missing from the diff and the log. |
| 2 | The summary matches the diff and log in substance; it is vague or leaves out something minor, but nothing it states is contradicted. |
| 3 | Everything the summary states is visible in the diff or the log, including every test or command it says it ran and the result it reports. |

This is the weakest question on the bench (confidence 0.09 to 0.65 on clean Attempts). The docs' reading of low Score confidence is "the levels are ambiguous, multi-dimensional, or the state doesn't contain enough to go on", and this level set measures two things (diff versus summary; tests versus summary). The gates already carry the test half. First follow-up after adoption: narrow this Score to the diff alone ("the changes the summary describes are present in `diff`") and re-bench; 12 requests. Ship the benched wording above until then.

**`log_health`, weight 0.3, four levels, normalise by 3.**
Instruction `judge`: "How clean was the run, judged on `log` alone: crashes, stack traces, failed commands, failing tests, and warnings the agent worked around without fixing."

| level | wording |
|---|---|
| 0 | The log ends with a failing test run, a crash, or an error that was never resolved. |
| 1 | The log shows errors or failing commands that the agent worked around, ignored, or silenced without fixing their cause. |
| 2 | The log shows errors that appeared and were then fixed, with a later clean run of the same command or test suite. |
| 3 | The log shows no crashes, no failed commands and no failing tests; every command and test run that appears passed. |

The bench placed every real Attempt at level 2 with confidence 0.7 to 0.95, which is right: these opencode transcripts all contain tool errors ("Could not find oldString", "File not found") that were then fixed. A level 3 Attempt would be a run with no error text at all.

Weights: ticket fit carries the most because it is the only dimension Selection cares about when Attempts differ in what they built; claim fidelity and log health split the rest evenly because the gates already punish the worst cases of each. The handoff's 0.40/0.40/0.20 put too much on the least confident question.

### 1.2 Gates (Nouls)

Why Nouls and not one Choice: gates are absolute conditions that can all be false at once, and the docs draw exactly this line: "A Choice over options and one Noul per option answer different questions: the Choice is relative, settling *which* option, while each Noul is absolute and can be low for all of them" (jaggedness). Each gate is phrased so that yes is the escalate case, per the Noul page ("Phrase the question so that a high value means yes") and the extraction cookbook ("frame each question so the *escalate* case is the `true` case"). One condition per Noul: "If a question has two conditions ... the value means less." Every gate has explicit `true`/`false` criteria because "When the boundary is subtle, add `criteria` with `true` and `false` descriptions."

**`contradicted_claim`** (the trust rule, asked directly)
`condition`: "`agent_summary_claim` states a result that `log` contradicts. Examples: the summary says tests pass while the last test run in the log shows failures or errors; the summary says a command succeeded while the log shows it failing; the summary says a check was run and the log has no such run."
true: "The log contradicts at least one stated result in the summary."
false: "Nothing the summary states is contradicted by the log, or the summary makes no checkable claim about results."

**`untouched_criterion`**
`condition`: "At least one acceptance criterion listed in `ticket` is not addressed anywhere in `diff`: no change in the diff works towards it."
true: "Some acceptance criterion in the ticket has no corresponding work in the diff."
false: "Every acceptance criterion in the ticket has at least some work towards it in the diff."

**`failing_at_end`** (single-hop, log only)
`condition`: "The last test run or build command visible in `log` reports at least one failure or error."
true: "The final test run or build in the log failed, or the log ends in an unresolved error."
false: "The final test run or build in the log passed, or no test run or build appears in the log."

### 1.3 Helper Noul and the derived gate

`contradicted_claim` is a two-hop question (read the claim, then check it against the log). The docs warn: "A question about a property of a property or something that requires multiple hops of reasoning costs accuracy." So the engine also derives the same contradiction from two single-hop Nouls:

**`summary_claims_tests_pass`** (over the summary alone)
`condition`: "`agent_summary_claim` states that tests were run and passed, or that the test suite is green, or gives a passing test count." `note`: "Judge the summary's wording only; do not check it against the log here."
true: "The summary says tests ran and passed." false: "The summary makes no claim that tests passed."

Derived gate in code: `summary_claims_tests_pass >= 0.6 AND failing_at_end >= 0.6` forces `flag`. On the probe both Nouls answered 0.96 and 0.98; the direct two-hop gate answered 0.90. Both fire; the derived one is the doc-aligned safety net.

### 1.4 Advisories (Nouls, never gates)

**`no_test_run`**: "`log` contains no test run at all: no test command was executed during the Attempt." true "No test command or test output appears anywhere in the log." false "At least one test run appears in the log." Named in reasons; a docs-only ticket legitimately has no tests.

**`evidence_too_thin`**: "The Evidence is too thin to grade: `diff` is missing or trimmed to the point that the ticket's criteria cannot be checked against it, or `log` is missing or so short that no command output can be seen." true "The diff or log is missing or cut down so far that the grade would be a guess." false "Enough diff and log is present to judge the work." On the bench this never rose above 0.42 even with no diff at all, while ticket-fit confidence collapsed to 0.00. Keep it for reasons; do not gate on it. Thin Evidence is detected by confidence (section 3), not by asking Jev.

### 1.5 Composition (engine code, no Jev text)

```
normalised_i = score_i / (levels_i - 1)
score10      = round1( 10 * (0.4 * fit + 0.3 * claim + 0.3 * log) )
gatesFired   = [g for g in gates if p(g) >= 0.6] + [derived if claimsPass >= 0.6 and failingAtEnd >= 0.6]
verdict      = flag if gatesFired or score10 < 6.0 else pass
reasons      = "<dim>: <level phrase>; ... . Flagged because <gate phrases>. Note: <advisories>; low confidence on <dims>."
```

Level phrases and gate phrases are fixed strings keyed by rounded level (`rubric.ts` has the table). The docs: a Score "is a position. You can use it to rank... or round it to the nearest level when your code needs one outcome." Jev "is not trained to generate text"; `reasons` never contains a word Jev produced.

---

## 2. Evidence object

One named JSON object; "Use an object for most requests so each part of the state has a descriptive name" (state page), and every question refers to fields by backticked path. Trimming exists because "Accuracy falls as the state grows with content unrelated to the decision" and because the cap is "32k tokens for `state` plus the longest question" (models page). Note the phrasing: the longest question counts against the 32k, not only the state.

| field | filled from | trimming rule | typical size (bench) |
|---|---|---|---|
| `ticket` | the Ticket file, whole text | none up to 20,000 chars; beyond that keep the first 20,000 (title, goal and acceptance criteria come first in every Console ticket) | 2.8k to 7.1k chars |
| `agent_summary_claim` | `outcome.summary` verbatim | first 4,000 chars | 0.4k to 0.6k chars |
| `diff` | `git diff -U0 <merge-base>..<attempt branch>` (the same range `attemptDiff` uses today, without context lines) | drop lockfiles, `bun.lockb`, generated and snapshot files in code first; then head-cut to whatever the cap leaves after the other fields, never below 2,000 chars; `diff_note` says how many chars of how many survived | 1.2k to 27.5k chars |
| `diff_note` | engine string | one of: "changed lines only, no context lines"; the same plus "; the diff was cut after its first N characters of M"; "no diff: <attemptDiff's reason>" | |
| `log` | the Attempt log, ANSI escapes stripped, last 20,000 chars cut forward to a line boundary | fixed tail; if the whole Evidence still exceeds the cap (only possible with a huge ticket), shrink by 15% steps to a floor of 4,000 chars | 19k to 20k chars |
| `log_note` | engine string | "the whole log" or "the log was trimmed to its last N characters of M" | |

Token estimate, using the bench's measured ratio of about 3.5 characters per input token (not the port's 4): ticket 2k, summary 0.2k, diff up to 8.6k at 30,000 chars, log 5.7k, notes negligible: about 17k tokens of Evidence. The nine questions are 9,915 chars, about 2.8k tokens, longest single question about 0.4k. Worst case with a 60,000-char diff: about 26k Evidence tokens plus 0.4k for the longest question, under 32k, and about 29k per request, under 64k. Measured on the bench, the recommended budget cost 10,047 to 19,511 input tokens per Grade, about $0.0004 to $0.0008 at $0.042 per million.

Engine-side cap to enforce before sending: stringified Evidence at most 100,000 characters (about 29k tokens at 3.5 chars per token), leaving room for the longest question. See section 6 for why the port's current 128,000-character allowance is unsafe.

Strip ANSI before sending. The real Attempt logs are opencode TUI transcripts that start with an escape byte; stripping removed only 1 to 2% of bytes here, but the engine's `trimTail` today sends escapes through, and escape sequences are pure distractor.

---

## 3. Thresholds

The docs put thresholds on the caller, "evaluated on the user's data and consequences", and ADR-0020 sets them per action. These come from the bench distributions:

| threshold | value | why |
|---|---|---|
| `flag` below | **6.0** on the 0-10 composed score | every passing Attempt on the bench scored 7.2 to 8.4; every flagged one 3.4 to 5.1. The gap is 5.1 to 7.2 and 6.0 sits inside it. Selection's 2-point margin is unchanged and works on this scale (passes clustered within 1.2 points of each other, flags 3 points below). |
| gate fires at | **0.6** on any of the three gate Nouls, and on both halves of the derived gate | non-firing gates on real Attempts sat at 0.03 to 0.37; firing ones at 0.68 to 0.97. The only values near the line were `untouched_criterion` at 0.43 to 0.63 on a review ticket whose criteria ("run the code-review skill") are not diff-visible. The Noul page says to raise the threshold "when acting on a false yes is expensive" and lower it "when missing a true yes is expensive, such as failing to flag a safety issue"; a false flag costs one human look, a missed contradiction merges a false claim, so 0.6 leans towards flagging. A gate between 0.45 and 0.6 is named in reasons as "possible" and does not flag. |
| low confidence | **below 0.5** on a dimension's Score confidence | the docs' own floor: "The 0.5 confidence floor catches anything the model reports as genuinely uncertain." |

What the engine does on low confidence, per dimension:

- **`ticket_fit` below 0.5, and the Evidence was trimmed (diff cut or log tail shorter than the log).** Widen once: re-ask with the full-context diff and the last 80,000 characters of the log if that fits the cap, else the largest tail that does. One extra request, about 25k to 34k tokens. On the bench this dimension's confidence was driven entirely by Evidence: 0.86 to 0.96 with any diff, 0.00 to 0.09 with none.
- **`ticket_fit` still below 0.5 after widening, or nothing to widen.** Accept the Grade, mark it `low-confidence` with the dimension named in reasons, and set `verdict: flag`. The docs for low confidence: "Do not act. Route to a human." Flag is the route to a human that the Console already has.
- **`claim_fidelity` or `log_health` below 0.5.** Accept and mark in reasons. No flag. On the bench claim fidelity was below 0.5 on most clean Attempts; flagging on it would flag good work, and section 1.1 explains why it is the rubric's fault.
- **Never fall back to agent graders on low confidence.** The fallback exists for Jev unreachable (decision 5 in the handoff). Mixing an agent-graded score with Jev-graded scores inside one Selection compares numbers from two different instruments; ADR-0006 says even two agent graders are not comparable.

Gates have no confidence: "There is no separate `confidence` value for a Noul." The probability is the strength; reasons show it to one decimal when a gate fires.

Record on every Grade: the rubric version string, the `model` field of the response, and the Evidence budget used (base or widened). Section 5 says why.

---

## 4. Bench results

Setup: 4 real Attempts from `~/repos/agent-console/.scratch/card-assignment-badges/` (the only modern pool with Outcome JSON; the two architecture pools named in memory do not exist on this box) plus one constructed probe. Each Attempt x budget cell ran the identical request three times (one repeat for the tail-size variant and the probe). 54 live requests, 887,024 input tokens, about $0.037. Raw results, fixtures and the aggregated table are listed in section 7.

Attempts:

| id | what the ticket asked | log | diff |
|---|---|---|---|
| small | deflake `engine/server.test.ts` (03-spawn-1) | 19 KB | 1 file, +14/-5 |
| mid | review the badge branch and fix findings, attempt 1 of ticket 03 | 56 KB | 7 files, +25/-84 |
| large | serve resolved assignments on the snapshot (ticket 01) | 139 KB | 8 files, +345/-28 |
| large clean | render the assignment badge on cards (ticket 02) | 98 KB | 13 files, +105/-731 |
| probe | the mid Attempt's log cut just after its failing full-suite run (482 pass, 1 fail, 1 error), summary unchanged and claiming 483 pass | 47 KB | as mid |

Budgets (the handoff's four, plus one variant): 1 full diff with context plus 80,000-char log tail; 2 changed lines only (`-U0`) plus 20,000-char tail; 2b changed lines plus 40,000-char tail; 3 log only; 4 two-pass: one Noul per diff hunk and per 6,000-char log segment to select, then grade over the selection.

### 4.1 Table

Confidence is per dimension (fit / claim / log), gate p is the mean probability (contradicted / untouched / failing at end), tokens are mean input tokens per Grade including the two-pass selection request.

| Attempt | Budget | ok | mean 0-10 | spread | verdict | conf fit/claim/log | gate p | fired | tokens | ms |
|---|---|---|---|---|---|---|---|---|---|---|
| small | 1 full diff + 80k tail | 3/3 | 8.4 | 0.0 | pass | 0.93/0.54/0.92 | 0.13/0.18/0.03 | none | 10,386 | 353 |
| small | **2 hunks + 20k tail** | 3/3 | 8.1 | 0.0 | pass | 0.89/0.31/0.92 | 0.15/0.20/0.03 | none | 10,047 | 309 |
| small | 2b hunks + 40k tail | 1/1 | 8.2 | - | pass | 0.92/0.38/0.92 | 0.14/0.21/0.03 | none | 10,047 | 297 |
| small | 3 log only | 3/3 | 8.2 | 0.1 | pass | 0.81/0.45/0.94 | 0.12/0.23/0.04 | none | 9,661 | 294 |
| small | 4 two-pass | 3/3 | 7.9 | 0.1 | pass | 0.86/0.08/0.95 | 0.13/0.22/0.04 | none | 18,120 | 658 |
| mid | 1 full diff + 80k tail | 3/3 | 4.7 | 0.2 | flag | 0.45/0.62/0.71 | 0.80/0.47/0.10 | contradicted_claim | 24,506 | 396 |
| mid | **2 hunks + 20k tail** | 3/3 | 5.1 | 0.2 | flag | 0.24/0.53/0.80 | 0.70/0.50/0.11 | contradicted_claim | 13,973 | 327 |
| mid | 2b hunks + 40k tail | 1/1 | 4.9 | - | flag | 0.32/0.61/0.80 | 0.76/0.51/0.16 | contradicted_claim | 19,642 | 354 |
| mid | 3 log only | 3/3 | 3.4 | 0.1 | flag | 0.00/0.65/0.77 | 0.86/0.48/0.09 | contradicted_claim | 20,522 | 365 |
| mid | 4 two-pass | 3/3 | 4.4 | 0.1 | flag | 0.56/0.65/0.73 | 0.75/0.63/0.15 | contradicted_claim, untouched_criterion | 37,774 | 796 |
| large | 1 full diff + 80k tail | 3/3 | 8.3 | 0.1 | pass | 0.90/0.45/0.91 | 0.14/0.13/0.11 | none | 33,985 | 848 |
| large | **2 hunks + 20k tail** | 3/3 | 8.4 | 0.0 | pass | 0.96/0.57/0.90 | 0.10/0.13/0.11 | none | 15,275 | 331 |
| large | 2b hunks + 40k tail | 1/1 | 8.3 | - | pass | 0.94/0.45/0.92 | 0.14/0.11/0.10 | none | 21,655 | 1,086 |
| large | 3 log only | 3/3 | 7.0 | 0.6 | pass | 0.09/0.32/0.87 | 0.14/0.23/0.11 | none | 33,134 | 476 |
| large | 4 two-pass | 0/3 | - | - | fallback | - | - | - | - | 264 |
| large clean | **2 hunks + 20k tail** | 3/3 | 7.2 | 0.4 | pass | 0.86/0.09/0.82 | 0.36/0.17/0.15 | none | 19,511 | 595 |
| probe | 1 full diff + 80k tail | 1/1 | 2.5 | - | flag | 0.71/0.78/0.85 | 0.92/0.66/0.96 | all three + derived | 21,995 | 1,108 |
| probe | **2 hunks + 20k tail** | 1/1 | 2.5 | - | flag | 0.62/0.83/0.82 | 0.90/0.74/0.96 | all three + derived | 13,906 | 325 |
| probe | 3 log only | 1/1 | 1.3 | - | flag | 0.19/0.92/0.92 | 0.95/0.72/0.97 | all three + derived | 18,011 | 348 |
| probe | 4 two-pass | 1/1 | 3.7 | - | flag | 0.54/0.74/0.47 | 0.74/0.79/0.31 | contradicted, untouched | 31,038 | 795 |

Failures: the large Attempt's two-pass fell back on all three repeats with `invalid-question`, detail `HTTP 400 {"detail":{"error_type":"max_tokens_exceeded"}}` from the selection request (120,880 chars of Evidence, 43 Nouls). No other fallback, no timeout, no rate limit.

Advisories: `no_test_run` was 0.01 everywhere (every Attempt ran tests); `evidence_too_thin` peaked at 0.42 (mid, two-pass) and 0.34 (mid, log only), never firing.

Disagreement between budgets: on every Attempt every budget that answered gave the same verdict. Largest mean-score gap between budgets on one Attempt: 1.4 (large: 8.4 with hunks versus 7.0 log-only), 1.6 (mid: 5.1 versus 3.4 log-only), 0.5 (small). Excluding log-only, no Attempt moved more than 0.7 between budgets.

Stability across identical repeats: spread 0.0 to 0.2 on the 0-10 score for every cell except log-only on the large Attempt (0.6) and the large clean Attempt (0.4, where claim-fidelity confidence was 0.00 to 0.17). Gate probabilities moved by at most 0.05 between repeats. The jaggedness page's claim of "quantitatively similar outputs for semantically similar inputs" holds for identical inputs.

A caveat on the mid Attempt: its Outcome JSON was overwritten by attempt 2 of the same ticket, so the summary describes work ("verified the operator ruling", "483 pass / 0 fail") that attempt 1's log does not contain. The `contradicted_claim` gate at 0.70 to 0.86 is a correct reading of the artifacts as paired, and a natural, unconstructed demonstration of the trust rule. The 0.47 to 0.63 on `untouched_criterion` is the review ticket's criteria not being diff-visible; the 0.6 threshold left it unfired on three of four budgets, which is the right call for a borderline.

### 4.2 Reading

**Adopt budget 2: changed lines (`git diff -U0`) plus the last 20,000 characters of the log.** It gave the same verdicts as the full diff on every Attempt, the highest ticket-fit confidence on the largest Attempt (0.96 against 0.90), the tightest repeats (spread 0.0 to 0.2), and 10k to 20k input tokens against 24k to 34k for the full diff. It never approached the cap on the 139 KB log. Doubling the tail to 40,000 characters (2b) changed no score by more than 0.2 and no confidence for the better; the extra 20k characters of log are distractor.

Where the budgets disagree, and what it teaches:

- **Log only loses ticket fit.** Without a diff, confidence on `ticket_fit` fell to 0.00 to 0.09 on the two larger Attempts and the score drifted 1.4 to 1.6 points below the diff budgets. The diff is essential Evidence; the log is not a substitute. This is also why section 3 reads low ticket-fit confidence as "thin Evidence, widen".
- **The full diff buys claim-fidelity confidence on small diffs only** (0.54 against 0.31 on the small Attempt) and loses it on the large one (0.45 against 0.57). Context lines help when the diff is tiny and hurt when it is not. Not worth doubling the tokens.
- **Two-pass is worse on every axis it was meant to help.** Pass one must see everything it selects from, so the 139 KB Attempt hit the API limit: a two-pass does not escape the cap, it meets it earlier with 43 questions attached. Where it ran it doubled requests and tokens (18k to 38k), cut claim-fidelity confidence to 0.08 on the small Attempt (selection dropped the context the claim needed), fired `untouched_criterion` on the borderline case the single-pass budgets left alone, and on the probe its `failing_at_end` dropped to 0.31 because segmenting the log separated the failing counts from their command. A "summarise" first pass is not possible at all: Jev returns no text.
- **The trust rule survives.** The constructed probe fired all three gates at 0.90 to 0.97 under the recommended budget and the derived gate at 0.96. The single-hop `failing_at_end` (0.96) and the two-hop `contradicted_claim` (0.90) agreed; the derived gate would have flagged it even if the two-hop question had wobbled.

Not shown by this bench: there is no agent-grader baseline (no `graded` event exists on disk), so nothing here says Jev grades better or worse than the current grader. It says the Jev Grade is stable, cheap, separates the clean Attempts from the mismatched ones by three points, and enforces the trust rule on a blunt contradiction. A subtle contradiction (a summary that is careful to be technically true) is untested.

---

## 5. Rubric ownership, from the Jev side

Position: **A now, and stay closer to A than the Console side plans.** The engine owns the rubric text, weights, gate set and thresholds as one versioned unit. A later Pool override should add gate Nouls, not edit levels.

The Jev-side reason is that a Score rubric is not a prompt, it is a calibrated instrument. The docs are explicit that its meaning is tied to its wording: "Two wordings of the same scale can behave differently on your data"; "higher confidence alone does not show that a description is better"; and thresholds are tuned per wording and per model version ("If you have tuned confidence thresholds against a specific version, pin that version's ID instead of the alias"). Every number in section 3 was read off the distribution the wording in section 1 produces. Let an operator reword level 2 of `ticket_fit` and the 6.0 line, the 0.6 gate line and the low-confidence rule all silently stop meaning what they meant, with nothing in the Pool to say so. `verify.md` today is prose an agent interprets; a Jev rubric is closer to a test fixture.

On the specific question, whether drift between Pools breaks cross-request comparability enough to matter: **it does not matter where the Console compares scores, and it matters everywhere a human does.** Selection compares Attempts of one ticket, graded in one round, under one rubric and one model; drift between Pools never enters that comparison. ADR-0006 already says a 7 from one grading is not comparable to a 7 from another, and Jev does not change that between Pools or across time. So drift breaks nothing the engine does. What it breaks is the reading of a score in Detail: a 7.2 in a Pool with a hand-tuned rubric and a 7.2 elsewhere are different instruments. The cure is provenance, not prohibition: every Grade records `rubric: jev-grader-rubric/<date>.<n>`, the response's `model` field, and the Evidence budget, and Detail shows it. That also answers the Console's known wart (adding a key silently changes what a score means): it is not silent if the Grade says which instrument produced it.

Two consequences for the Console side:

- The port pins the alias `jev-latest`. The models page says the alias "moves when a new release ships, so the answers behind it can change without a change on your side." Once thresholds are set, pin the versioned id the models page lists and bump it deliberately, re-running the bench (54 requests, four cents) each time.
- Option C later should mean: a Pool may append gate Nouls of a fixed shape ("`<criterion text>` has no work in `diff`"), generated by the engine from the ticket's acceptance-criteria bullets, one Noul per bullet, summed in code. That is the doc-approved way to ask "how many criteria are unmet" (Jev "does not count reliably... count in code") and it makes `untouched_criterion` sharper without letting anyone touch a level.

---

## 6. What the docs say will not work, and what the bench confirmed

1. **The port's size estimate is loose and the API's rejection is misclassified.** The port allows 32,000 tokens x 4 chars = 128,000 characters of Evidence. Measured usage was about 3.4 to 3.6 characters per token on this content, so 128,000 characters is about 36k real tokens, over the cap. The bench hit this: 120,880 characters passed the port's check and the API answered HTTP 400 `max_tokens_exceeded`, which `classifyError` maps to `invalid-question` (BadRequestError), not `evidence-too-large`. Two fixes: estimate at 3.2 characters per token (or cap stringified Evidence at 100,000 characters), and classify a 400 whose body says `max_tokens_exceeded` as `evidence-too-large`. Also the docs' cap is "32k tokens for `state` plus the longest question", so the longest question's size belongs in the estimate.
2. **The handoff's budget 1 does not fit in general.** "Full diff + a 20,000-token log tail" is about 70,000 characters of log at the real ratio plus the diff; it fitted here because the largest diff was 22,000 characters. A 60,000-character diff would be head-cut, and the diff is the Evidence that matters (section 4.2).
3. **Two-pass cannot be "summarise then grade".** Jev "is not trained to generate text". As "select then grade" it fails at exactly the size it was meant to rescue (section 4.2) and the docs' own filter advice is "retrieve and filter in code first"; a relevance Noul is for "when it's not possible to filter in state". Windowing the log by tail in code is the filter.
4. **Comparing a summary to a log is a multi-hop question** ("multiple hops of reasoning costs accuracy"). It worked on the bench (0.70 to 0.95), but the derived single-hop gate is the design's insurance, and the follow-up in 1.1 narrows `claim_fidelity` for the same reason.
5. **Jev cannot count**, so no question asks how many criteria are unmet or how many tests failed; every gate is "at least one" or "the last run", and per-criterion Nouls are the future shape (section 5).
6. **Evidence is not hostile-checked.** The summary field argues for itself. Mitigations in place: the field name says "claim", the rule sits in every question, two gates read the log without the summary at all. A summary that lies subtly is untested.
7. **Noul has no confidence**, so "per-dimension confidence" in the handoff's bench spec applies to the three Scores only; gates report probability, and the low-confidence rule in section 3 reads Scores only.
8. **Level wording carries no numbers.** The template's "score 0 to 10" instruction and its "about the last 20k tokens" hint are not transferable into a Score's criteria; digits in levels "don't help". The rubric above has none.

---

## 7. Files

All under `/tmp/claude-1000/-home-billy--herdr-worktrees-agent-console-feature-jev-integration/007514f1-9381-475d-9449-72510f16d7e0/scratchpad/jev-grader/`:

| file | what |
|---|---|
| `rubric.ts` | the question set exactly as sent, weights, thresholds, `compose()` and the reasons phrase tables |
| `bench.ts` | the bench: budgets, fitting rules, two-pass selection, repeats; imports `ask` from the worktree's `engine/jev.ts` |
| `extract.ts` | builds the fixtures from `~/repos/agent-console/.scratch/card-assignment-badges/` (read-only) and the constructed probe |
| `summarise.ts` | aggregates every raw result into `summary.md` and `summary.json` |
| `gen-html.ts` | renders the page below from `rubric.ts` and `summary.json` |
| `fixtures/*.json` | five fixtures: ticket text, summary, outcome, base and commit shas, full and `-U0` diffs, ANSI-stripped log, source paths |
| `results/raw-2026-09-20T06-45-*.json` | main run: 3 Attempts x 4 budgets x 3 repeats, 42 requests, with every answer, probability table, usage and Evidence sizes |
| `results-extra/raw-*.json` | the 40k-tail variant (3 requests) and the large clean Attempt (3 requests) |
| `results-probe/raw-*.json` | the constructed probe, 5 requests |
| `results-smoke/raw-*.json` | the first wire check, 1 request |
| `summary.md`, `summary.json` | the aggregated table behind section 4 |
| `show-me-jev-grader-bench.html` | the one-page visual: question cards, composition, bench table with the recommended budget highlighted |
| `render.png` | a headless-chromium render of the page at 1280x900 |
