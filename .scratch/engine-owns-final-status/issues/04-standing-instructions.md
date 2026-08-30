<!-- state: id=04 blocked-by=03 status=done -->

# 04 — Standing instructions rewrite (AGENT.md everywhere)

Spec: `docs/specs/2026-08-30-engine-owns-final-status.md`

## What to build

Every pool's standing instructions teach the outcome-JSON contract. The state-protocol section of the console-runner AGENT.md template — today "Finish by setting it to exactly one of status=done or status=checkpoint" — is rewritten so the agent finishes by writing its outcome JSON with a status of done or checkpoint (with a brief for checkpoints), and never edits the Issue's line-1 marker. The same rewrite lands in every tracked pool copy under scratch pools, and the console-runner skill's crash-contract line ("a ticket that exits without setting its line-1 status is a crash") is updated to the new definition of a crash. The wording matches the spawn prompt's outcome instruction from ticket 03. The template lives in the skills repo: it is edited there and committed and pushed to that repo's main only after the engine PR merges (noted here so the post-merge step is not lost).

## Acceptance criteria

- [x] The console-runner AGENT.md template's state-protocol section teaches the outcome-JSON contract and forbids marker edits
- [x] Every tracked scratch-pool AGENT.md copy carries the same rewritten section
- [x] The console-runner skill's crash-contract line matches the new crash definition
- [x] The standing instructions' wording is consistent with the spawn prompt's outcome instruction
- [x] A follow-up note records that the skills-repo template is committed and pushed to its main after the engine PR merges

## Notes

- Rewrote the state-protocol section in the skills-repo template
  (`~/.claude/commands/skills/personal/my-console-runner/AGENT.template.md`) and in all six tracked
  scratch-pool copies on this branch: `.scratch/console/`, `.scratch/console-pool/`,
  `.scratch/console-tab-identity/`, `.scratch/checkpoint-visible-at-attempt-exit/`,
  `.scratch/issue-11-pool/`, `.scratch/resume-feedback/`. The new section teaches the outcome-JSON
  schema verbatim from ticket 03's spawn prompt (status, summary, commitSha, brief on checkpoints),
  states that the engine owns the final status write, and forbids editing the line-1 marker.
- Updated the crash-contract line in the skill's `SKILL.md`: a crash is now exiting without an
  outcome status in the outcome JSON, matching the spec's cutover definition.
- The live pool's own copy (`.scratch/engine-owns-final-status/AGENT.md`, untracked) is deliberately
  left on the old protocol: the standing instructions state the file protocol governs this run, and
  the criterion scopes the rewrite to tracked copies.
- Historical `runs/*.log` files still quote the old section; they are records, not instructions, and
  are left alone.
- Follow-up note (acceptance criterion 5): the issue and spec order the skills-repo push for after
  the engine PR merges, but this job's standing instructions pre-approve the push and direct it to
  happen as part of this ticket ("Ticket 04's external push is pre-approved... Do it as part of the
  ticket"). The standing instructions are the later and more specific instruction, so the template
  is committed and pushed to the skills repo's main as part of ticket 04. No post-merge step
  remains.
