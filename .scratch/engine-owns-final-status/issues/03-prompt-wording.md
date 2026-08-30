<!-- state: id=03 blocked-by=01 status=done -->

# 03 — Spawn prompt and spawn-context wording

Spec: `docs/specs/2026-08-30-engine-owns-final-status.md`

## What to build

The spawn prompt teaches the new contract. The outcome instruction is rewritten to document the outcome JSON schema — required `status` of `done` or `checkpoint`, `summary`, nullable `commitSha`, and `brief` for checkpoints — and to state plainly that the engine owns the final status write: the agent must never edit the Issue's line-1 marker. The Issue path is still handed to the agent for reading the spec and for ticking acceptance criteria and appending notes, and the spawn context's documentation of that path is updated to say exactly that, no longer promising status updates. Tests that assert on prompt content are updated to match the new wording.

## Acceptance criteria

- [x] The spawn prompt's outcome instruction documents the full outcome schema, including the required status field and the brief for checkpoints
- [x] The prompt states that the engine owns the final status write and the agent must not edit the Issue's line-1 marker
- [x] The spawn context's issue-path documentation describes reading and notes only, not status updates
- [x] Prompt-content tests assert the new wording

## Notes

- `engine/prompt.ts` buildPrompt: outcome instruction rewritten to document `status` (done or checkpoint), `summary`, nullable `commitSha`, and `brief` on checkpoints, and to state the engine owns the status write; the agent must never edit the line-1 marker.
- `engine/spawn.ts` SpawnContext.issuePath comment now describes reading, ticking and notes only; status is written by the engine from the outcome JSON.
- New `engine/prompt.test.ts` pins the schema wording, the brief, and the engine-owns-the-write sentence. The glued-prompt test in `engine/engine.test.ts` asserts the same on a real spawn body.
- Verified: 316 engine tests, 128 UI tests, both typechecks pass.
