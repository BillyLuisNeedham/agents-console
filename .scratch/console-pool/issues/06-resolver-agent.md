<!-- state: id=06 blocked-by=02,05 status=done -->

# 06 — Resolver agent and conflict approval

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

Automatic conflict resolution with human merge authority. When a merge conflicts (surfaced by ticket 05), the engine spawns a resolver agent — harness from console.json's `resolver=` key, falling back to the `~/.issue-runner` default — handing it the conflicted state. The resolver's resolution is then presented as an approval interrupt: approving commits the merge and the pool continues; rejecting converts the interrupt into a manual-resolution interrupt that carries the conflicted state plus a note of what the agent tried, and the pool waits for Billy to resolve and resume. A resolver that itself fails (crash, no resolution) takes the same manual path.

## Acceptance criteria

- [x] A detected conflict spawns the resolver agent automatically, using `resolver=` or the default harness
- [x] The resolver's resolution is presented as an approval interrupt before any commit
- [x] Approving commits the merge and the pool continues automatically
- [x] Rejecting converts to a manual-resolution interrupt carrying the conflicted state and the agent's attempt
- [x] A resolver crash or failure takes the manual path with the failure noted
- [x] Manual resolution followed by resume completes the merge and continues the pool
- [x] Covered by engine-seam tests with real git conflicts and a stub resolver

## Blocked by

- 02 — Interrupt engine
- 05 — Worktrees and parallel super-steps

## Notes

- Design, settled before coding and probed against real git in /tmp: on a conflict the engine leaves the parked worktree (branch `pool/<id>`, at `.git/pool-worktrees/<id>`) untouched, spawns the resolver in that worktree, and hands it the conflicted files. The resolver reproduces the conflict by `git merge <workingBranch>` in the worktree, stages a resolution with `git add`, and does NOT commit. It writes `runs/<id>.resolver.json` (`{"resolved": bool, "note": string}`); a separate `runs/<id>.resolver.log` holds its output.
- Resolver harness and model: `config.resolver` names the harness, falling back to the `~/.issue-runner` default (harness and model both), readable at a path the test can override (`RunOptions.issueRunnerPath`). An explicit `resolver: "none"` (or empty) opts out and takes the manual path; an explicit resolver naming an unknown harness fails fast like `resolveAssignment` does for tickets (review finding, acted on).
- The resolver spawns synchronously inside the super-step join (after all merges in that step have been applied), so main stays clean throughout and sibling merges are undisturbed. This is the one place the drive loop blocks on an agent beyond the ticket spawn itself.
- Approval: the `merge-approval` interrupt holds the resolver's note and the conflicted files. Approve commits the resolver's staged resolution in the worktree (`git commit` completes the in-progress merge, making the working branch an ancestor) then fast-forwards; reject aborts the worktree merge (branch restored to its own commits) and converts to a manual `merge-conflict` interrupt carrying the attempt.
- Answer API: `PoolRun` gains `approve(ticketId, note?)` and `reject(ticketId, note?)` beside `resume`. `resume` on a `merge-approval` throws, directing callers to approve/reject. `resume` on the converted manual interrupt re-attempts the merge exactly as Issue 05's manual path.
- Durability: `merge-conflict` and `merge-approval` interrupts are now exempted from the rehydrate stale-clearing (previously a done-ticket interrupt was always cleared, which would have dropped a pending approval across a restart; the rehydrate comment already promised merge interrupts outlive their ticket's done). The resolver attempt is held in memory for the live flow; on reject after a restart the recorded approval body stands in so the attempt note is not lost.
- Pre-existing merge-conflict tests (Issue 05) now opt out with `noResolverConfig` (`resolver: "none"`), because with a real `~/.issue-runner` on this machine the automatic fallback would otherwise try to spawn a real harness in a test.

## Review findings, and what changed because of them

Two-axis review (standards + spec) ran on the working tree before commit. Acted on:

- An explicit resolver naming an unknown harness now throws (was silently degrading to the manual path), matching how a ticket's unknown harness is rejected.
- Reject after a restart no longer loses the resolver's attempt: the recorded approval body stands in when the in-memory attempt record is gone.

Noted, not changed:

- Reject discards the resolver's staged resolution (the parked branch is restored) and hands the human the attempt note plus the conflicted files, which is what the spec means by "carrying the conflicted state and the agent's attempt"; the full resolution diff is not preserved for the human. (Inference: the spec asks for the attempt noted, not the resolution handed over.)
- The approve path has a defensive fallback (a resolution that does not merge cleanly on approval converts to a manual interrupt) that the spec does not name; without it a bad resolution would either throw or hang, so it is kept.
- The resolver reproduces the conflict by merging the working branch into the parked branch (the reverse of the engine's original merge); conflicts are symmetric so this reproduces the same set, and the stub reproduces it for real in the tests.
