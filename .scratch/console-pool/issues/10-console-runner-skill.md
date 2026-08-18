<!-- state: id=10 blocked-by=04,06,07 status=ready -->

# 10 — my-console-runner skill

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The personal skill that launches all of this, living beside my-issue-runner. Pointed at a pool directory, it detects the eight facts my-issue-runner detects (issue count and markers, blocked-by edges, language and test framework, commit prefix, neighbouring context files, worktree cleanliness, `~/.issue-runner` contents, harnesses on PATH) and reports them for confirmation — an empty or markerless pool is a reason to stop, never to invent tickets. It then asks the six interview questions (drivers, default harness/model, per-ticket overrides, roster, reviewer authority, checkpoint definition) with recommendations, writes the answers as `console.json` — including the `resolver=` key — plus `AGENT.md` into the pool directory, starts the Console server bound to that pool, and opens the browser.

## Acceptance criteria

- [ ] The skill lives beside my-issue-runner and resolves as a command on the intended harnesses
- [ ] Detection reports the eight facts and refuses an empty or markerless pool
- [ ] The interview asks the six questions with recommendations, honouring an existing `~/.issue-runner` default
- [ ] Answers are written as console.json (drivers, assignments, roster, reviewer, checkpoint definition, resolver) and AGENT.md in the pool directory
- [ ] The skill starts the server bound to the pool and opens the browser
- [ ] The disable-model-invocation rule is respected: at most one such driver per ticket and it is first, mirroring my-issue-runner's check
- [ ] Proven end-to-end: the skill launches a real pool and the Console drives it

## Blocked by

- 04 — Harness spawn kernel
- 06 — Resolver agent and conflict approval
- 07 — Server and pool projection UI
