<!-- state: id=04 blocked-by=none status=ready -->
# 04: Spawn contract — canonical Issue file and AGENT.md re-read per spawn

**What to build:** The engine and the agent stop disagreeing about which Issue file is the file of record. The spawn prompt instructs the agent to read and update the Issue by its absolute main-checkout path, and read-back reads that same main-checkout file — so an attempt that finishes `done` is always recognised as `done`, ending the false crashes and skipped merges that stranded completed work. The worktree seed copy of the Issue remains, as context only; this aligns with the merge design, which already discards worktree Issue edits. Separately, AGENT.md is read fresh at every spawn instead of once at pool start, so an operator's mid-run edit to agent instructions takes effect on the very next attempt without restarting the pool.

**Blocked by:** None (can start immediately)

- [ ] The spawn prompt hands the agent the Issue's absolute main-checkout path for both reading and status updates
- [ ] Read-back reads the main-checkout Issue file, so an agent that sets `done` there is recognised as `done`
- [ ] A successful attempt is merged (no more false crash + skipped merge); an engine seam test reproduces the old false-crash scenario and shows it now passing
- [ ] AGENT.md content edited mid-run appears in the next spawn's prompt; nothing is cached on the session
- [ ] Engine seam tests cover both behaviours; existing suites pass
