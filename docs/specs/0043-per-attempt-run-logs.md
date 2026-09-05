## Problem Statement

When a harness attempt dies mid-run — the token ceiling (#42), a kill, an OOM — the operator gets a near-empty log and no facts about what was spawned, where, or from what commit. `--output-format text` prints the agent's final message only at exit, so `runs/NN.log` stays empty for the entire run. Debugging ticket 15 attempt 2 meant reading the agent's own notes and `ps`-ing for detached processes; ticket 15 attempt 1 spawned on the wrong commit and nothing in `runs/` recorded which commit or cwd it started from (#41). The operator cannot watch a live attempt, and cannot reconstruct a dead one.

## Solution

Stream the harness. Claude and cursor attempts spawn with a structured stream mode; the engine tees the raw stream to a per-attempt **Stream file** and derives the human-readable attempt log from it **live**, so the log can be tailed mid-run and reads in order after a crash. Spawn and exit facts (argv, cwd, commit, env; log tail, outcome existence) land on the lifecycle events and in the crash interrupt body, so the Console surfaces what an attempt was doing and what it was waiting on without the operator touching the filesystem. The Console's attempt list links each attempt's Stream file for deep forensics.

## User Stories

1. As an operator, I want to tail a running attempt's log, so that I can see what the agent is doing right now instead of waiting for exit.
2. As an operator, I want the log to read in the order events happened, so that I can follow the agent's reasoning chronologically.
3. As an operator, I want assistant text in the log verbatim, so that I can read what the agent said.
4. As an operator, I want one line per tool call with the tool name and a summary, so that I can scan the agent's actions quickly.
5. As an operator, I want the raw harness stream preserved verbatim per attempt, so that when the derived log loses fidelity I can forensically inspect the source.
6. As an operator, I want a dead attempt's log to contain everything up to the moment of death, so that a kill, OOM, or ceiling doesn't erase the evidence.
7. As an operator, I want the derived log written live as bytes arrive, so that no buffering hides recent activity.
8. As an operator, I want log lines the engine doesn't recognize passed through rather than dropped, so that a harness schema change degrades the log gracefully instead of silently.
9. As an operator, I want the spawn event to record the harness argv with the prompt body elided, so that I can see exactly how the agent was invoked without a wall of prompt text.
10. As an operator, I want the spawn event to record the cwd, so that I know where the attempt ran (#41).
11. As an operator, I want the spawn event to record the commit SHA the checkout or worktree was at, so that a wrong-commit spawn is visible from one line (#41).
12. As an operator, I want the spawn event to record the env keys the engine set (with values), so that I can reproduce the attempt's environment.
13. As an operator, I want these spawn facts on every spawn site — implement, resolver, grader, head-to-head — so that no attempt type is a debugging blind spot.
14. As an operator, I want the exit event to carry the last ~20 lines of the log, so that the event stream alone tells me how the attempt ended.
15. As an operator, I want the exit event to record whether an outcome file exists, so that I can distinguish "agent never wrote its outcome" from "outcome was invalid".
16. As an operator, I want the crash interrupt body to quote the log tail and outcome fact, so that the Console's Needs-input surface answers "what happened" without opening files.
17. As an operator, I want the crash interrupt body to still name the log path, so that I can go to the file for the full picture.
18. As an operator, I want each attempt in the Console's attempt list to link its Stream file, so that deep forensics are one click away.
19. As an operator, I want the Console's existing live log tail to keep working unchanged against the derived log, so that the Detail panel stays the place to watch a run.
20. As an operator, I want opencode attempts to keep their raw stdout log, so that their already-live output isn't regressed by a parser that doesn't apply to them.
21. As an operator, I want Stream files and derived logs rotated with the same naming contract as today's logs, so that old attempts stay addressable after a re-run.
22. As an operator, I want grader and head-to-head artifacts (trim logs) to keep working, so that verification output isn't broken by the log change.
23. As a future maintainer, I want an ADR explaining why the ticket log is derived rather than raw, so that nobody "simplifies" it back to raw bytes and reintroduces the empty-log bug.
24. As a pool agent author, I want the prompt's teaching about log paths to stay accurate, so that agents don't write to stale assumptions.

## Implementation Decisions

- **Harness adapters** (the module mapping harness name → argv): claude and cursor gain the structured stream mode (`stream-json`, verbose). opencode is unchanged — it has no structured stream and its raw stdout is already live. Each adapter effectively declares its log mode: streamed-and-derived vs raw-passthrough.
- **Two files per attempt**: the **Stream file** (`<id>.stream.jsonl`) is the verbatim tee of raw stream bytes; the **attempt log** (`<id>.log`) is derived from it. Streamed harnesses produce both; raw harnesses produce only the log, exactly as today.
- **Derivation happens in the spawn pump, live**: the pump (the single function every harness spawn funnels through, which today tees stdout+stderr to the log) gains a per-harness stream parser. Each chunk is tee'd raw to the Stream file and parsed line-wise; complete JSONL lines become derived log lines. Post-hoc conversion was rejected: a kill loses everything, which is the bug being fixed.
- **Derived line format**: assistant text verbatim; one `[tool] Name: summary` line per tool call (summary = the salient argument, e.g. the command for Bash); tool durations only where the stream provides timing cheaply — timestamps from the stream are the fallback. Unparseable or unrecognized lines pass through to the log rather than being dropped: the stream-json schema drifts with harness releases, and a silently degrading log is worse than a raw one.
- **All four spawn sites** get the treatment: implement attempts, resolver runs, grader (verify) runs, and head-to-head judges. They share the pump; the parser is selected by harness, not by site.
- **Spawn facts** on the `spawned` event (all spawn sites, including the currently empty grader/h2h payloads): argv with the prompt body replaced by a placeholder, cwd, branch (already present for implement), commit SHA (resolved with git at spawn time in the spawn cwd — nothing captures this today), and the env keys the engine set with their values (today exactly one: PWD).
- **Exit facts** on the `exited` event: the last ~20 lines of the derived log and a boolean for whether the outcome file exists. The same facts are appended to the `crash` event.
- **Crash interrupt body** becomes: log path, blank line, the ~20-line tail, and an outcome-file line. The body is rendered raw in the Console already, so no UI change is needed for this; it is persisted, so it freezes the tail at raise time (accepted — the path can go stale after rotation today, and the quoted tail removes the need to chase it).
- **Naming and rotation**: the events module owns the log-naming contract (ADR-0003); it extends to Stream files — `<id>.stream.jsonl`, rotated to `<id>.attempt-N.stream.jsonl`, with resolver variants — following the identical rotation rules as logs. Attempt-listing and attempt-name parsing extend so the server resolves attempt number → Stream file the same way it resolves logs today.
- **Console UI**: the attempt list (Detail, Progress tab) surfaces a per-attempt Stream file link. The server already computes per-attempt file names in its attempt listing; the UI currently discards that field — it flows through to the view model. No card-level log view: cards stay summaries; the Detail's existing live tail works unchanged because the served log file is still `NN.log`, just derived.
- **Two log dialects, accepted**: opencode attempts keep raw-stdout logs while claude/cursor logs are derived. The parser is keyed by harness, so the distinction is explicit in code.
- **Docs**: ADR-0012 (attempt logs are derived from the harness stream) and the CONTEXT.md "Stream file" / updated "Ticket log" terms are already written on this branch and ship with the work.
- **Prompt teaching**: anywhere the engine's prompt text describes log/outcome paths stays accurate — the outcome mechanism is untouched; the outcome file still gates done vs crash exactly as ADR-0005 specifies.

## Testing Decisions

Good tests here assert external behavior — file contents, event payloads, argv, rendered view models — not parser internals. The parser's pass-through rule is external behavior: feed it unrecognized lines, assert they appear in the log.

- **Fake harness CLI through the run path** (primary seam, existing): the engine tests already drive a fake CLI script and assert argv and stdin. The fake gains a stream-json mode emitting canned JSONL (assistant text, tool calls, an unparseable line). Assert: the Stream file is tee'd verbatim; the derived log contains the expected lines in order, live (readable before the fake exits); rotation covers both files on re-run; unparseable lines pass through.
- **Harness argv builders** (existing): exact-argv assertions per adapter — claude/cursor gain the stream flags, opencode unchanged.
- **Event payloads** (existing): `spawned` facts asserted from real runs through the fake CLI; commit SHA asserted against a real temp git repo at a known commit; `exited` tail and outcome-exists asserted for both done and crash paths; crash interrupt body asserted to quote the tail.
- **UI projection** (existing): fixtures-in tests for the attempt list view model surfacing the Stream file link from the server's attempt listing.

## Out of Scope

- Streaming support for opencode (no structured stream exists; its raw stdout already streams live).
- Tool-call duration correlation where the stream doesn't provide timing cheaply.
- A card-level log tail on the canvas — cards stay summaries.
- Changing the outcome mechanism or final-status ownership (ADR-0005 untouched).
- Retroactive repair of logs from attempts that already ran.
- UI rendering of the crash interrupt body beyond what raw `<pre>` display already does.

## Further Notes

- Closes #43; motivated by #41 (wrong-commit spawn) and #42 (ceiling death with a 208-byte log).
- Key trade-off recorded in ADR-0012: marrying the claude/cursor stream schema is accepted, mitigated by the pass-through rule.
- The crash interrupt body is persisted with pool state; quoting the tail freezes it at raise time, which is what the operator wants when reading it later.
