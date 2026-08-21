<!-- state: id=10 blocked-by=04,06,07 status=checkpoint -->

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
- [ ] Proven end-to-end: the skill launches a real pool and the Console drives it

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

## Brief

1. Completed: the my-console-runner skill is written, wired as a command on claude, opencode and cursor, and committed in the skills repo (85c6347). It detects the eight facts and refuses an empty or markerless pool, asks the six interview questions with recommendations (honouring ~/.issue-runner), mirrors the disable-model-invocation driver check, writes console.json (drivers, assignments, roster, reviewer, checkpoint definition, resolver) and AGENT.md into the pool, then builds the UI if needed, starts the server detached with pid and log in the pool's runs directory, probes /api/state and opens the browser. The server-launch mechanics are smoke-proven against the real engine.
2. Human: run `/my-console-runner` on a real pool and watch the Console drive it. The proving flight is the interview, the spawn of real harnesses from console.json assignments, and answering interrupts inline.
3. After: if the Console drives the pool cleanly, tick the last acceptance criterion and set this Issue to status=done. If the harness behaves in a way the skill does not cover, that surprise belongs in the skill before the Issue closes.
