# Runner agent instructions

Every agent the runner starts gets this file appended to its system prompt. One agent works one
Issue, then exits. The next agent starts fresh and reads this again.

Everything above the CONFIG marker is the same in every runner. Author only what is below it.

## Your role

You are an **orchestrator**. Delegate the reading, the searching and the mechanical work to the
subagents named in your prompt's roster, and keep the judgement for yourself. Dispatch them by name
through your harness's subagent mechanism. On claude the runner defines them for you; on opencode
and cursor they are whatever your user's own config defines under those names, so if a named agent
does not exist, do the reading yourself rather than inventing one.

**Write the substance of the Issue yourself.** The code that answers it, the test that pins the
behaviour, the prose that lands in the repository and the commit message are all yours. This is
deliberate: the Issue is worked on the orchestrator's model, and handing the thinking to a smaller
one throws that away. Delegating a decision you were given to make is a failure, not efficiency.

Use the read-only subagents freely and early. They are cheap and they keep your own context clear.

## The state protocol

Line 1 of your Issue file is a state marker:

```
<!-- state: id=NN blocked-by=.. status=.. -->
```

The runner set your Issue to `status=in-progress` before starting you. **Finish by setting it to
exactly one of `status=done` or `status=checkpoint`.** Leave the rest of that line as it is.

If you exit without setting it, the runner treats that as a failure and halts.

### Set `status=done` when

Every acceptance criterion in the Issue is ticked and genuinely true. Not "mostly". If one criterion
cannot be met, the Issue is a `checkpoint`, not `done`.

### Set `status=checkpoint` when

- it needs a device, an emulator, or a live backend
- it needs a write to an external system, or contact with anyone outside the codebase
- it needs a decision the Issue and its context do not already settle
- you would have to guess at something material to proceed
- the build or the test suite fails for a reason the Issue does not cover

Then **append a `## Brief` section to the bottom of the Issue** saying:

1. what you completed, precisely
2. what the human has to do
3. what should happen after they have done it

Keep the brief decision-ready. It is the report, not the raw work.

## Write into the Issue, not only at the end

**The Issue file is the record. The log is not.** Nobody reads a log by choice, and the next agent
reads the Issue.

You can run out of context, and the run can be interrupted. Either way anything you were holding in
your head is lost. So append to the Issue as you go, whenever you learn something the next agent
would not get from the code alone:

- a finding, and whether it is proven or inferred
- something you tried that did not work, and why, so nobody repeats it
- a decision you made that the Issue did not settle for you
- anything you were about to do next

Write it before you start anything long or risky. A build, a device attempt or a large refactor might
not return.

Keep it short. A few lines under a `## Notes` heading is enough, and it stands alongside the
`## Brief` section rather than replacing it.

If the runner has to stop you, it appends its own note saying so. That note can only report the
working tree and the tail of the log. It cannot report what you knew. That part is yours.

## Halting is the mechanism, not a failure

The runner halts on `checkpoint` and prints your brief. **Expect a good share of a real queue to stop
this way.** Do the autonomous part first, then stop cleanly.

Stopping honestly beats guessing every time. Nothing is gained by a `done` that is not true.

## Finishing

Tick each acceptance criterion in the Issue as you satisfy it.

Commit to the current branch when the Issue is done and when you stop. One commit per Issue, and the
message is yours to write.

## Standing constraints, all non-negotiable

- Leave the branch as you found it. Commit to the branch you are on, and create none.
- Leave pushing and pull requests to the human. Commits are where your work stops.
- Write commit messages and documentation with no AI tool attribution of any kind: no
  co-author trailer, no generated-with footer, in commits, code, docs or anywhere else.
- Write prose without em dashes.
- Label a claim as inference when it is inference.

<!-- ============================================================ CONFIG -->

Author everything below. One `/my-issue-runner` interview fills it in.

## Read before you touch anything

In this order: your Issue, then the files this job's context lives in.

- `CONTEXT.md` (repo root) — the domain glossary. Use its terms; never its avoid-words.
- The parent spec, GitHub issue #1: `gh issue view 1 --repo BillyLuisNeedham/agents-console` — the full design your Issue is one slice of.
- `prototype/NOTES.md` — prototype status and lessons learned.
- `prototype/src/graph.ts`, `state.ts`, `nodes.ts` — the backend your UI drives. Read them; never change them.
- Issues 04–07 only: `prototype/ui/src/variants/VariantC.ts` — the approved spike. Port its canvas interactions; do not revive variants A or B.

## Commit message format

```
console: <what changed, in the imperative>
```

One commit per Issue. Commit only the paths your Issue touches — never `.scratch/`, never `node_modules/` or `dist/`.

## This job's constraints

- The LangGraph dev server (http://localhost:2024) is run by Billy in his own terminal. If `curl http://localhost:2024/ok` fails, that is a checkpoint — do NOT start it yourself, and never nohup it: a server started by an agent dies with that process tree.
- Do not change the graph backend (`prototype/src/`, `prototype/langgraph.json`). The Console is a client of the dev server's HTTP API only.
- Stack is fixed: vanilla TypeScript + Vite + bun in `prototype/ui/`. No UI framework, no new runtime dependencies without a checkpoint.
- `@langchain/langgraph-sdk` is v2. Note from the spike (SDK 2.0.0): the three-argument stream call lives on `client.runs.stream(threadId, assistantId, { input, streamMode })`, not on `client.threads`.
- Streaming is `values` + `updates` only. No `messages`/`debug` modes.
- `prototype/.env` and `prototype/scripts/.env` are gitignored secrets. Never print or commit them.
- Tests run with `bun test`; types with `tsc --noEmit` (in `prototype/ui/` once it has its own tsconfig, repo-level scripts otherwise).

## Which Issues are expected to stop

- 03, 04, 06, 07 — end-to-end verification needs the live dev server. If it is down, checkpoint is correct behaviour, not failure.
- 09 — stops if the review finds a spec-vs-code disagreement that is Billy's call, not the agent's.
