<!-- state: id=04 blocked-by=01 status=done -->

# 04 — Harness spawn kernel

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

Real harness execution, ported from run.sh's proven spawn mechanics into the engine. Each ticket spawns its assigned harness CLI (claude, opencode, or cursor's agent) non-interactively with stdin closed, in the permission mode that works unattended, with the glued prompt: driver skill first, then AGENT.md, the skill chain, and the roster glued behind. The per-ticket harness and model come from console.json (written by the runner skill; a hand-written console.json works for this ticket). Each ticket's output lands in the pool's runs directory as a per-ticket log, matching my-issue-runner's convention. The opencode path drives the skill through `--command` with the bare skill name; the cursor launch line follows Cursor's CLI docs and is treated as unproven. The known hard-won quirks (GNU/BSD sed differences, gated permission modes failing unattended) are carried over, not rediscovered.

## Acceptance criteria

- [x] A ticket spawns its console.json-assigned harness and model with stdin closed and the unattended permission mode
- [x] The prompt glues driver skill + AGENT.md + chain + roster in run.sh's proven shape
- [x] opencode reaches its driver via `--command`; the cursor launch line matches Cursor's documented CLI
- [x] Each ticket writes a per-ticket log to the pool's runs directory
- [x] Marker read-back after exit drives status exactly as with stub harnesses (the engine cannot tell the difference)
- [x] Proven end-to-end with at least one real harness running a trivial real ticket in a scratch pool
- [x] Harness selection logic covered by engine-seam tests with fake CLI binaries on PATH

## Blocked by

- 01 — Pool engine walking skeleton

---

## Notes

- Much of the kernel already existed from Issue 01's walking skeleton (claude/opencode cases in `engine/spawn.ts`, glued prompt in `engine/prompt.ts`, marker read-back and per-ticket logs in `engine/engine.ts`). This Issue added the cursor case, the PATH-faked selection tests, and closed the gaps review found.
- Bun quirk, proven by test failure: `Bun.spawn` resolves argv[0] against a cached PATH unless an `env` option is given. `spawnToLog` now passes `env: { ...process.env }`, which is also what makes fake-binaries-on-PATH work as a seam.
- `console.json` gained an optional `agents` field (roster JSON), threaded to claude's launch as `--agents`. Review finding: run.sh's claude line carries `--agents "$AGENTS"` and the glued roster prose tells the spawned agent "on claude they come from the runner's config", which was false without it. opencode and cursor get the roster as prose only, same as run.sh. The spec's console.json list does not name `agents`; recorded here as a decision, Issue 10 writes it and Issue 11 can weigh it.
- Per-ticket logs now stream both pipes into one writer in arrival order, live, matching run.sh's `2>&1 | tee`. Before, the log appeared only at exit with stdout and stderr concatenated (review finding).
- Cursor launch line: `agent -p <prompt> --model <model> --force --trust --output-format text`, ported verbatim from run.sh and still marked UNPROVEN. `agent` is not installed here; Cursor's docs pages are JS-rendered so live re-verification was not possible, and run.sh's line is the record of what the docs said.
- Proving flight (AC6): real opencode (`kimi-for-coding-oauth/k3`, the `~/.issue-runner` default) ran a trivial ticket in `/tmp/console-flight` through `runPool`, driven via `--command implement`. The spawned agent set its own marker to done and wrote its outcome JSON; the engine read both back, phase done, `runs/01.log` 84 lines. Flown twice: once before and once after the log-streaming change. No surprises.
- claude was not flown: its auth on this machine is broken (subscription access disabled, no ANTHROPIC_API_KEY). That is environment, not spawn mechanics; the claude argv shape is pinned by the fake-CLI test instead. (Inference: claude's flag shape is valid per `claude --help` on this machine, which lists `auto` among the permission modes.)
- Reviewed with the two-axis code-review (standards + spec, parallel sub-agents). Acted on: the two spec findings above. Not acted on: test-block duplication (the choreography repeats four times but each test reads top to bottom on its own) and the word "message" in the opencode test (that is opencode's own CLI term for the argument).
