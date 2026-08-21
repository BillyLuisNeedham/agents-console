<!-- state: id=10 blocked-by=04,06,07 status=done -->

# 10 — my-console-runner skill

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The personal skill that launches all of this, living beside my-issue-runner. Pointed at a pool directory, it detects the eight facts my-issue-runner detects (issue count and markers, blocked-by edges, language and test framework, commit prefix, neighbouring context files, worktree cleanliness, `~/.issue-runner` contents, harnesses on PATH) and reports them for confirmation — an empty or markerless pool is a reason to stop, never to invent tickets. It then asks the six interview questions (drivers, default harness/model, per-ticket overrides, roster, reviewer authority, checkpoint definition) with recommendations, writes the answers as `console.json` — including the `resolver=` key — plus `AGENT.md` into the pool directory, starts the Console server bound to that pool, and opens the browser.

## Acceptance criteria

- [x] The skill lives beside my-issue-runner and resolves as a command on the intended harnesses
- [x] Detection reports the eight facts and refuses an empty or markerless pool
- [x] The interview asks the six questions with recommendations, honouring an existing `~/.issue-runner` default
- [x] Answers are written as console.json (drivers, assignments, roster, reviewer, checkpoint definition, resolver) and AGENT.md in the pool directory
- [x] The skill starts the server bound to the pool and opens the browser
- [x] The disable-model-invocation rule is respected: at most one such driver per ticket and it is first, mirroring my-issue-runner's check
- [x] Proven end-to-end: the skill launches a real pool and the Console drives it

## Blocked by

- 04 — Harness spawn kernel
- 06 — Resolver agent and conflict approval
- 07 — Server and pool projection UI

## Notes

- The skill is `~/.claude/commands/skills/personal/my-console-runner/` (SKILL.md + AGENT.template.md), committed in the skills repo as 85c6347. `link-skills.sh` and `link-opencode-commands.sh` wired it: claude command, opencode stub, cursor copy, ~/.claude/skills and ~/.agents/skills symlinks. Verified on disk.
- console.json keys the engine consumes (proven in engine.ts readConfig/resolveAssignment): `defaults` {harness, model, drivers}, `assign` per ticket, `roster` (prose), `agents` (JSON string for claude --agents), `resolver` (`none` opts out, absent falls back to ~/.issue-runner). `drivers` is a space-separated chain, first name is the driver. `reviewer` and `checkpoint` are recorded as data and reach agents through AGENT.md, which the skill fills below the template's CONFIG marker.
- Launch mechanics smoke-proven against the real server with a temp pool (two done tickets): `bun run engine/server.ts --pool <dir> --port <n>` read console.json, enriched markers into the snapshot, raised the final Review interrupt, served the SPA at / (200), and died on the pid-file kill. The xdg-open line itself is untested (inference: trivial).
- AGENT.template.md's above-CONFIG text is byte-identical to my-issue-runner's template, verified by diff against this pool's own AGENT.md.
- This pool's AGENT.md still points at `prototype/` paths; the repo was restructured to root-level `engine/` and `ui/` (inference: earlier issues moved it). The skill names the engine home as `~/repos/learning/ai-agent-graphs` and says to update that line if the repo moves. Worth a line in 11's review.
- No commit in the pool repo: the work product lives in the skills repo, and `.scratch/` is never committed.
- Proving flight completed on this pool, 2026-08-21 21:57 to 22:06. Billy ran `/my-console-runner` here: it wrote `console.json` (21:57:24) and the rewritten `AGENT.md` (21:58:05), started the server bound to this pool (pid in `runs/server.pid`, port 8787, still running) and opened the browser. Billy answered the launch interrupt in the Console, which resumed the pool and spawned the Issue 10 agent — the session captured in `runs/10.log` — on the harness, model and driver `console.json` declares (opencode, kimi k3, `implement`). Interview, inline interrupt answer, and spawn from assignments all proven live. Inference: 08 and 09 were not Console-driven; their logs (13:57 and 14:34) predate the skill run, so this pool's Console drive begins at Issue 10.
- Cosmetic observation for 11's review: the server logs a 404 for `/favicon.ico` (`ui/dist/` has none) and Bun printed an idle-timeout warning on that request. No functional impact seen.

## Brief

1. Completed: the my-console-runner skill is written, wired as a command on claude, opencode and cursor, and committed in the skills repo (85c6347). It detects the eight facts and refuses an empty or markerless pool, asks the six interview questions with recommendations (honouring ~/.issue-runner), mirrors the disable-model-invocation driver check, writes console.json (drivers, assignments, roster, reviewer, checkpoint definition, resolver) and AGENT.md into the pool, then builds the UI if needed, starts the server detached with pid and log in the pool's runs directory, probes /api/state and opens the browser. The server-launch mechanics are smoke-proven against the real engine.
2. Human: run `/my-console-runner` on a real pool and watch the Console drive it. The proving flight is the interview, the spawn of real harnesses from console.json assignments, and answering interrupts inline. (Done 2026-08-21: ran the skill on this pool, answered the launch interrupt inline, watched the Console spawn the Issue 10 agent from the console.json assignment.)
3. After: if the Console drives the pool cleanly, tick the last acceptance criterion and set this Issue to status=done. If the harness behaves in a way the skill does not cover, that surprise belongs in the skill before the Issue closes. (No surprise surfaced in the flight; the Issue closes as done.)
