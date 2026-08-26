<!-- state: id=04 blocked-by=none status=done -->
# 04: Spawn contract — canonical Issue file and AGENT.md re-read per spawn

**What to build:** The engine and the agent stop disagreeing about which Issue file is the file of record. The spawn prompt instructs the agent to read and update the Issue by its absolute main-checkout path, and read-back reads that same main-checkout file — so an attempt that finishes `done` is always recognised as `done`, ending the false crashes and skipped merges that stranded completed work. The worktree seed copy of the Issue remains, as context only; this aligns with the merge design, which already discards worktree Issue edits. Separately, AGENT.md is read fresh at every spawn instead of once at pool start, so an operator's mid-run edit to agent instructions takes effect on the very next attempt without restarting the pool.

**Blocked by:** None (can start immediately)

- [x] The spawn prompt hands the agent the Issue's absolute main-checkout path for both reading and status updates
- [x] Read-back reads the main-checkout Issue file, so an agent that sets `done` there is recognised as `done`
- [x] A successful attempt is merged (no more false crash + skipped merge); an engine seam test reproduces the old false-crash scenario and shows it now passing
- [x] AGENT.md content edited mid-run appears in the next spawn's prompt; nothing is cached on the session
- [x] Engine seam tests cover both behaviours; existing suites pass

## Notes

- `SpawnContext.issueRel` is gone; the adapters build the driver line from `ctx.issuePath`, which the engine now always sets to the canonical main-checkout Issue file (`marker.file`). The resolver spawn's incidental driver line follows the same field.
- `readBack` no longer takes the plan or mirrors the worktree copy back; it reads and normalises the main-checkout marker for every attempt. `TicketPlan.issuePath` is gone with it; `planTicket` still seeds the worktree copy, now as context only.
- `Session.agentMd` and `TicketEnv.agentMd` are gone. `runTicket` reads AGENT.md from the pool directory at every spawn.
- The git stub harness in engine.test.ts no longer commits the Issue from the worktree (the canonical file lives outside it); the unused `commitIssue` option went with it. The fake-CLI prompt-path assertions moved from the relative path to the absolute main-checkout path, a redefinition the spec sanctions ("prompt paths").
- New seam tests: the false-crash regression (worktree attempt sets done only in the canonical file; recognised done and merged) and the AGENT.md mid-run edit reaching the next spawn.
- `bun test` (288 pass) and `bun run typecheck` both green. ui/ untouched, so no UI build run.
