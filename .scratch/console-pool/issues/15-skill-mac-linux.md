<!-- state: id=15 blocked-by=none status=done -->

# 15 — my-console-runner launches on mac and linux

Spec: `.scratch/console-pool/spec-console-flight-fixes.md`

## What to build

The my-console-runner skill's launch flow works on both platforms. Its final step opens the browser with the platform's opener (`open` on macOS, `xdg-open` on Linux), chosen by an `uname` branch, and it detaches the pool server portably so the launch no longer depends on Linux-only commands. Only the source skill is edited; the generated copies are refreshed from it.

## Acceptance criteria

- [x] The browser-open step branches on `uname`: `open` on Darwin, `xdg-open` otherwise
- [x] The server-detach step drops the Linux-only `setsid`, keeping `nohup … &` so the server still outlives the session and its pid is still captured
- [x] Only the source SKILL.md is hand-edited; the cursor copy is refreshed by re-running the link script; the opencode stub (a generated pointer) and the symlinks are verified to follow the source
- [x] A Linux launch still works end to end after the change (smoke proof: server starts detached, state endpoint answers, browser opens)
- [x] The change is committed in the skills repo, matching ticket 10's precedent
- [x] The ticket's notes record that the Mac branch is proven only on Billy's next Mac run, not from this Linux box

## Blocked by

None — can start immediately (different repository, no overlap with tickets 12–14).

## Notes

- The two Linux-only commands were the only portability hazards found in the skill's launch flow; the rest (bun, the state-endpoint probe, pid-file handling, redirects) is already portable.
- The link scripts themselves are already macOS-aware, so refreshing the generated copies is safe on either platform.
- This is the "surprise belongs in the skill" item from ticket 10's Brief: the browser-open line was the one explicitly untested piece of ticket 10's smoke proof.
- The skill lives in the skills repo at `~/.claude/commands/skills/personal/my-console-runner/`; the proving flight runs from the pool repo, so this ticket's harness works in the skills repo and commits there.
- Done 2026-08-21. Source SKILL.md edited (the only hand edit), committed in the skills repo as 6b95018 `my-console-runner: launch on mac and linux`. Cursor copy refreshed by re-running `link-skills.sh` and diffed equal to the source; `~/.claude/skills` and `~/.agents/skills` verified as symlinks to the source; the opencode stub verified as a generated pointer that reads the source file, so it follows the edit with no refresh needed.
- Linux smoke proof passed: server launched with the new `nohup … &` line against a temp pool on port 8799, pid captured in `runs/server.pid` and alive under that pid, `/api/state` answered with a snapshot, the `uname` branch took the `xdg-open` path (exit 0, browser opened), server killed afterwards. The live flight server on port 8787 was not touched.
- The Mac branch (`open` on Darwin) is proven only on Billy's next Mac run, not from this Linux box. Inferred, not proven: `open` is macOS's opener by the platform's own convention.
- Harness quirk (inference): this agent's bash tool kills the whole process tree when a command times out, which takes down even a `nohup`'d child. That is a property of the tool's reaper, not of the detach line; the smoke proof ran launch, probe and kill inside one command to avoid it.
