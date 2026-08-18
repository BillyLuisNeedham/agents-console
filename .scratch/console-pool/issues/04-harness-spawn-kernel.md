<!-- state: id=04 blocked-by=01 status=ready -->

# 04 — Harness spawn kernel

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

Real harness execution, ported from run.sh's proven spawn mechanics into the engine. Each ticket spawns its assigned harness CLI (claude, opencode, or cursor's agent) non-interactively with stdin closed, in the permission mode that works unattended, with the glued prompt: driver skill first, then AGENT.md, the skill chain, and the roster glued behind. The per-ticket harness and model come from console.json (written by the runner skill; a hand-written console.json works for this ticket). Each ticket's output lands in the pool's runs directory as a per-ticket log, matching my-issue-runner's convention. The opencode path drives the skill through `--command` with the bare skill name; the cursor launch line follows Cursor's CLI docs and is treated as unproven. The known hard-won quirks (GNU/BSD sed differences, gated permission modes failing unattended) are carried over, not rediscovered.

## Acceptance criteria

- [ ] A ticket spawns its console.json-assigned harness and model with stdin closed and the unattended permission mode
- [ ] The prompt glues driver skill + AGENT.md + chain + roster in run.sh's proven shape
- [ ] opencode reaches its driver via `--command`; the cursor launch line matches Cursor's documented CLI
- [ ] Each ticket writes a per-ticket log to the pool's runs directory
- [ ] Marker read-back after exit drives status exactly as with stub harnesses (the engine cannot tell the difference)
- [ ] Proven end-to-end with at least one real harness running a trivial real ticket in a scratch pool
- [ ] Harness selection logic covered by engine-seam tests with fake CLI binaries on PATH

## Blocked by

- 01 — Pool engine walking skeleton
