# Engine owns the final status write

Closes https://github.com/BillyLuisNeedham/agents-console/issues/18 (fix option 4).

## Problem Statement

A ticket agent works in a worktree. When it finishes, it must record `status=done` (or `status=checkpoint`) on line 1 of its Issue file in the main checkout — the one canonical copy the engine trusts. Agents whose tools default to cwd-relative paths (opencode, cursor) sometimes edit the worktree copy instead. The agent then exits 0 having done all the work, but the engine's read-back sees the canonical file still at `in-progress` and records a crash.

Answering the crash interrupt with "resume" re-runs the same prompt, the agent repeats the same relative-path slip, and the ticket ping-pongs crash/resume forever. From inside the worktree the agent cannot see the mistake; from the Console the human cannot tell a dead harness from a finished ticket without reading logs. The only escape is hand-editing the canonical Issue.

## Solution

Change the state protocol so the agent never writes the Issue's status at all. The agent signals its ending through the outcome JSON it already writes at the end of every attempt, and the engine writes the final status to the canonical Issue itself. A relative-path slip can now cost the agent its notes, but never its status — the false-crash class is deleted, not patched.

This is a clean break: marker statuses written by agents are no longer honored. Every pool's standing instructions are updated in the same change, and any attempt in flight at cutover crashes at most once, then finishes under the new protocol on resume.

## User Stories

1. As Billy, I want a finished ticket to be recorded as done even when the agent edited a worktree-relative path, so that completed work never surfaces as a crash.
2. As Billy, I want crash interrupts to mean the attempt genuinely failed, so that I can trust the interrupt stream.
3. As Billy, I want a checkpoint interrupt raised the moment the attempt exits, so that I get fast feedback while sibling tickets still run.
4. As Billy, I want the checkpoint's Brief written into the Issue by the engine, so that the interrupt body is always present and re-raisable after a server restart.
5. As Billy, I want crash events to carry a distinct reason, so that I can tell "harness exited non-zero" from "agent never wrote its outcome" without opening the log.
6. As Billy, I want a ticket resumed after a cutover crash to re-spawn under the new protocol and finish, so that the upgrade is self-healing.
7. As a ticket agent, I want exactly one file to write my result to, at a path handed to me in my prompt, so that I cannot strand my status in the wrong copy.
8. As a ticket agent, I want the status protocol stated in my standing instructions, so that every harness (claude, opencode, cursor) follows the same contract.
9. As a ticket agent, I want to keep ticking acceptance criteria and appending notes in the Issue, so that my human-readable record of the work survives.
10. As Billy, I want Review to keep working unchanged — approve when every ticket is done, reject resets named tickets and their downstream to ready and deletes their outcomes.
11. As Billy, I want rehydration after a server restart to keep treating on-disk markers as truth, so that restarts remain boring.
12. As a future reader of this codebase, I want an ADR explaining why the engine owns the final status write, so that the protocol change is not surprising.

## Implementation Decisions

- **Outcome JSON becomes the agent's only result channel.** The attempt's outcome file gains a required `status` field: `{"status": "done" | "checkpoint", "summary": string, "commitSha": string | null, "brief": string}`. `summary` and `commitSha` keep their current meaning.
- **The engine writes the final status.** At attempt exit, the engine reads the outcome JSON. On exit code 0 with a valid `done` or `checkpoint`, it writes that status to the canonical Issue's line-1 marker itself. Marker statuses written by the agent are no longer honored anywhere.
- **The Brief travels in the outcome JSON.** For `status=checkpoint`, the engine appends the `brief` value to the canonical Issue as its `## Brief` section, then raises the checkpoint interrupt through the existing Brief-extraction path. A missing `brief` on a checkpoint yields a placeholder section, not a crash — the agent did signal an intentional pause.
- **New crash contract.** Anything else is a crash: non-zero exit, missing outcome file, unparseable outcome, or an invalid `status` value. The crash event payload carries the exit code and a distinct reason so the ticket log distinguishes them. Read-back of the marker as an ending signal is removed.
- **Timing is unchanged.** The outcome is read at attempt exit, exactly where read-back ran. Checkpoint interrupts are still raised at attempt exit (answerable while siblings run, processed at the next boundary); crash interrupts are still raised at the super-step boundary with a snapshot emitted at exit.
- **The Issue remains the agent's working record.** The agent still reads the Issue and ticks acceptance criteria and appends notes via the absolute main-checkout path it is handed. Those edits are best-effort context, not protocol; the merge still discards worktree Issue edits.
- **Prompt and spawn changes.** The spawn prompt's outcome instruction is rewritten to document the new schema and to state that the engine owns the status write. The spawn context's `issuePath` documentation is updated: the path is for reading and notes, no longer for status updates.
- **Standing instructions updated everywhere.** The state-protocol section of the pool AGENT.md template ("Finish by setting it to exactly one of status=done or status=checkpoint") is rewritten to the outcome-JSON contract, in the template and in every tracked pool copy. The console-runner skill's crash-contract line is updated to match.
- **Everything else is unchanged.** The merge-resolver's own outcome contract (`{"resolved": ...}`), the Review flow, rehydration, the ready/in-progress writes the engine already makes, and the merge's discard of worktree Issue edits all stay as they are.
- **Docs.** The PR includes ADR-0005 ("the engine owns the final status write") and a CONTEXT.md glossary entry for **Outcome** — the JSON an attempt writes to signal its result.

## Testing Decisions

- **Seam: the existing engine integration seam.** Drive the engine end-to-end with fake harness CLIs, exactly as engine.test.ts does today — the fakes learn file paths from environment variables, never by parsing prompts. No new seam is introduced.
- Good tests assert externally visible behavior only: marker contents on disk, events in the ticket log, interrupts raised and their timing, state after rehydration. They do not assert on engine internals.
- The fake CLIs switch from sed-ing the Issue marker to writing the outcome JSON, mirroring the new agent contract.
- New contract tests cover: done via outcome; checkpoint via outcome with the Brief appended and the interrupt raised at attempt exit; the Brief surviving rehydration; missing outcome is a crash with its reason; malformed outcome is a crash; an invalid status value is a crash; a valid done outcome with a non-zero exit is a crash; an agent-written marker status is ignored (the clean break).
- Prior art: the crash recording tests, the crash-resume test, and the canonical-path done test in the engine test suite.

## Out of Scope

- The legacy shell runners under scratch pools, which still encode the old protocol.
- Verifying the agent's done claim (that the commit landed, that tests pass) — the Review interrupt remains the human check.
- Issue #18's fix option 1 (read-back falls back to the worktree copy) — superseded by this change.
- Issue #18's fix option 3 (symlink the canonical Issue into worktrees).
- Any change to acceptance-criteria ticking or to the merge discarding worktree Issue edits.

## Further Notes

- Cutover: an attempt in flight when the new engine first runs crashes at most once (old-protocol agent, no outcome status). Answering resume re-spawns it with the updated standing instructions; the parked worktree is reused, so committed work survives.
- Order of operations: merge the engine PR, then commit and push the console-runner skill template directly to the skills repo's main.
- The work happens in a git worktree on a fix branch, landing as a PR into main that closes issue #18. Implementation is delegated to deepseek agents under orchestration; no code is written in the main checkout.
