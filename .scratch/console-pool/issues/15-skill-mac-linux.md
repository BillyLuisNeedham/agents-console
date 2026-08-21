<!-- state: id=15 blocked-by=none status=ready -->

# 15 — my-console-runner launches on mac and linux

Spec: `.scratch/console-pool/spec-console-flight-fixes.md`

## What to build

The my-console-runner skill's launch flow works on both platforms. Its final step opens the browser with the platform's opener (`open` on macOS, `xdg-open` on Linux), chosen by an `uname` branch, and it detaches the pool server portably so the launch no longer depends on Linux-only commands. Only the source skill is edited; the generated copies are refreshed from it.

## Acceptance criteria

- [ ] The browser-open step branches on `uname`: `open` on Darwin, `xdg-open` otherwise
- [ ] The server-detach step drops the Linux-only `setsid`, keeping `nohup … &` so the server still outlives the session and its pid is still captured
- [ ] Only the source SKILL.md is hand-edited; the cursor copy is refreshed by re-running the link script; the opencode stub (a generated pointer) and the symlinks are verified to follow the source
- [ ] A Linux launch still works end to end after the change (smoke proof: server starts detached, state endpoint answers, browser opens)
- [ ] The change is committed in the skills repo, matching ticket 10's precedent
- [ ] The ticket's notes record that the Mac branch is proven only on Billy's next Mac run, not from this Linux box

## Blocked by

None — can start immediately (different repository, no overlap with tickets 12–14).

## Notes

- The two Linux-only commands were the only portability hazards found in the skill's launch flow; the rest (bun, the state-endpoint probe, pid-file handling, redirects) is already portable.
- The link scripts themselves are already macOS-aware, so refreshing the generated copies is safe on either platform.
- This is the "surprise belongs in the skill" item from ticket 10's Brief: the browser-open line was the one explicitly untested piece of ticket 10's smoke proof.
- The skill lives in the skills repo at `~/.claude/commands/skills/personal/my-console-runner/`; the proving flight runs from the pool repo, so this ticket's harness works in the skills repo and commits there.
