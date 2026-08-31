<!-- state: id=02 blocked-by=01 status=done -->

# 02 — Checkpoint and Brief via the outcome JSON

Spec: `docs/specs/2026-08-30-engine-owns-final-status.md`

## What to build

A ticket agent's planned pause travels through the outcome JSON instead of a marker edit. At attempt exit, a valid outcome with `status=checkpoint` causes the engine to write `checkpoint` to the canonical Issue marker, append the outcome's `brief` value to the Issue as its `## Brief` section (a placeholder section when the brief is absent — never a crash, since the agent did signal an intentional pause), and raise the checkpoint interrupt through the existing Brief-extraction path. The interrupt is raised at attempt exit, answerable while sibling tickets still run, exactly as today. Because the Brief lands in the Issue, rehydration after a server restart re-raises the interrupt from the Issue unchanged.

## Acceptance criteria

- [x] A valid outcome with `status=checkpoint` results in the engine writing `checkpoint` to the canonical Issue marker at attempt exit
- [x] The engine appends the outcome's brief to the Issue as its `## Brief` section, and the checkpoint interrupt's body comes from that section
- [x] A checkpoint outcome with no brief yields a placeholder Brief section, not a crash
- [x] The checkpoint interrupt is raised at attempt exit and is answerable while sibling tickets still run
- [x] After a server restart, rehydration re-raises the checkpoint interrupt from the Brief in the Issue
- [x] Contract tests cover each of the above through the engine's externally visible behavior

## Notes

- `runTicket` lands the brief into the canonical Issue right after the engine's marker write, so the drive loop's existing at-exit `raiseCheckpoint` reads it through `extractBrief` unchanged (`engine/engine.ts` `landCheckpointBrief`).
- Decision the ticket left open, made here: every checkpoint **replaces** the Issue's Brief section outright (agent brief or the engine's placeholder), rather than appending alongside stale sections. `extractBrief` reads the first `## Brief` section, so append-only would let a brief from an earlier attempt masquerade as the current one; and a conditional placeholder (only when no section exists) would fail the placeholder criterion whenever a stale section survived. The Brief section is protocol now, like the line-1 marker: it always mirrors the latest checkpoint outcome. Notes, acceptance criteria and Resume notes in the Issue are untouched.
- `extractBrief` and the new strip now share one heading matcher (`BRIEF_HEADING`), so a `## Briefing` heading is neither landed-over nor read as a Brief. A `## Brief, written by the engine` reset note counts as a Brief section and is replaced by a real checkpoint's brief, which is the intent.
- The placeholder body ("wrote no brief ... answer the interrupt") is engine-authored under the shared `## Brief, written by the engine` heading, matching the existing reset-note convention.
- Test moves: the fake harnesses (`stubHarness`, `blockingHarness`) carry an optional `brief` into the outcome JSON. Pre-existing tests that asserted interrupt bodies from Briefs pre-written into the Issue (old-protocol style) now pass the same text through the outcome; their assertions are unchanged. The at-exit timing and mid-flight answerability criterion was already covered by the `accept/process split` describe, so no duplicate test was added there.
- Two-axis code review (standards + spec) ran on the diff; both findings it raised (two Brief-heading matchers, conditional placeholder letting a stale brief survive) are what the uniform-replace design above resolves.
