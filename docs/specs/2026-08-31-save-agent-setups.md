# Save agent setups for reuse across code bases

Closes issue #23.

## Problem Statement

Every time Billy points a Console at a new pool, the `my-console-runner` interview asks the same behavioural questions from scratch: which harness and model drive the tickets, which driver skills and chains to use, what the subagent roster is, which harness resolves merges, what the reviewer's authority is, and what counts as a checkpoint. His answers are almost always the same — the same harness, the same model, the same one general-purpose subagent, the same review protocol — but there is no way to carry them from one pool to the next. Re-answering is tedious, and worse, the answers drift: each pool's roster prose and agent definitions are re-typed from memory instead of reused verbatim.

## Solution

Introduce the **Setup** (already in the domain glossary): a named, machine-local bundle of a pool's behavioural config, saved on this machine and offered whenever a new pool is configured.

When Billy configures a pool, the interview opens by listing his saved Setups and asking which one to start from. Picking one prefills every behavioural answer — drivers, harness, model, roster, resolver, reviewer, checkpoint — and each answer is still confirmed with him, so a Setup is a starting point, never a silent override. At the end of the interview he is asked whether to save the resulting config as a Setup, under a name he chooses.

Pool-specific values are never part of a Setup: the port, the per-ticket `assign` overrides, and the pool-specific prose below the AGENT.md marker are all regenerated per pool exactly as today.

## User Stories

1. As a Console operator, I want to save the agent configuration I just designed for a pool, so that I can reuse it on the next code base without re-answering the same interview questions.
2. As a Console operator, I want to name a saved Setup myself, so that I can recognise it later ("frontend-k3", "android-deepseek").
3. As a Console operator, I want to be offered my saved Setups when I configure a new pool, so that reuse is one answer instead of a whole interview.
4. As a Console operator, I want a chosen Setup to prefill the interview answers rather than skip them, so that I can adjust one answer for this pool without forking the Setup.
5. As a Console operator, I want the saved drivers chain to be a default I can override per pool, so that a pool of research tickets and a pool of implement tickets can share one Setup.
6. As a Console operator, I want my subagent roster — names, descriptions, prompts, and models — saved verbatim, so that the roster I tuned once stops drifting across pools.
7. As a Console operator, I want the roster saved in both its forms (prose for the prompt, JSON for claude's agents flag), so that the two never fall out of step when reused.
8. As a Console operator, I want my reviewer-authority and checkpoint-definition prose saved with the Setup, so that the review protocol I settled on is applied consistently.
9. As a Console operator, I want pool-specific values — the port, per-ticket assignments, and AGENT.md's pool prose — excluded from a Setup, so that reusing a Setup never clobbers per-pool wiring.
10. As a Console operator, I want saving a Setup to be an explicit prompt at the end of the interview, so that one-off configs don't clutter my list of Setups.
11. As a Console operator, I want to be warned before overwriting an existing Setup name, so that I don't destroy a Setup by accident.
12. As a Console operator, I want Setups stored as plain files in a known directory on my machine, so that I can inspect, edit, or delete them by hand without waiting for a management UI.
13. As a Console operator, I want configuring a pool to work exactly as before when I have no saved Setups, so that the new step never gets in the way of a first run.
14. As a Console operator, I want Setups to live outside any repository, so that they follow me across every code base on this machine.

## Implementation Decisions

- **The change is confined to the `my-console-runner` skill.** The pool already carries its config as data and the engine never needs to know Setups exist: the skill writes the pool's config file exactly as today, it just gains two new steps. No engine changes, no UI changes, no changes to the pool's on-disk layout.
- **Storage location**: one JSON file per Setup under the machine-local directory `~/.agent-graphs/setups/`, named `<name>.json`, where `<name>` is the operator's chosen name slugified. This sits beside the existing Fleet registry and follows the standing convention that machine-local Console state lives in `~/.agent-graphs/`.
- **Setup file shape**: exactly the behavioural slice of the pool's config — `defaults` (harness, model, drivers), `roster`, `agents`, `resolver`, `reviewer`, `checkpoint`. No new schema: a Setup file can be merged straight into the config the skill writes. The `roster` and `agents` pair is saved together from the one interview answer, preserving the skill's existing keep-in-step rule.
- **Excluded from a Setup**: `port` (one Console per pool, pinned per instance), `assign` (keyed by this pool's ticket ids), and everything below the AGENT.md marker (context files, commit prefix, pool constraints, expected stops — all regenerated per pool by the interview as today).
- **Load step (Q0)**: the interview opens by listing the Setups found in the directory and asking which to start from, including a "none" option. Choosing one prefills the existing interview answers for drivers, harness/model, roster, resolver, reviewer, and checkpoint; every answer is still confirmed with the operator as today. An empty or missing directory means Q0 is skipped silently and the interview runs exactly as before.
- **Save step**: after the pool's config and AGENT.md are written, the skill asks "Save this Setup as...?" A declined answer or empty name means nothing is saved. An accepted name is slugified; if a Setup with that name already exists, the operator must confirm the overwrite before the file is replaced.
- **Prefill, never skip**: a loaded Setup supplies defaults to the existing questions, it does not remove them. Per-pool questions that have no saved answer — the port probe, per-ticket `assign` overrides, expected stops — are always asked fresh.
- **Terminology**: the feature is documented and spoken of as **Setup**, per the glossary entry added to CONTEXT.md. The words "profile" and "template" are avoided.

## Testing Decisions

- **The seam is the skill itself, exercised end-to-end.** The change is agent instructions (prose plus a file convention), not engine code, and this repo has no automated tests for skills — there is no prior art to extend, and no new automated harness is introduced.
- **Good test = a dogfooded round-trip against real scratch pools.** The behaviour under test is external and observable: files on disk and the interview's questions. The walkthrough:
  1. Run the skill against a scratch pool with no Setups present; confirm the interview runs unchanged and the closing save prompt writes `~/.agent-graphs/setups/<name>.json` with the expected six keys and nothing pool-specific.
  2. Run the skill against a second scratch pool; confirm Q0 lists the saved Setup, choosing it prefills the behavioural answers, and the written pool config matches what the un-prefilled interview would have produced.
  3. Confirm the exclusions: no port, no assign, and AGENT.md regenerated per pool.
  4. Confirm the guards: declining to save writes nothing, and reusing an existing name requires overwrite confirmation.
- **Regression check**: with the setups directory absent or empty, the interview must be byte-for-byte the old flow — Q0 must not appear.

## Out of Scope

- Managing Setups after creation: no list/delete/rename/edit UI or commands. Setups are plain files in a known directory, maintained by hand. A later issue if it ever itches.
- Sharing or syncing Setups across machines. The issue explicitly scopes this to local.
- Any engine, server, or Console UI changes.
- Migrating existing pools onto Setups. Existing pools are untouched; Setups only affect pools configured after this lands.
- A schema or validation tool for Setup files. The engine never reads them, so there is nothing to validate against beyond the skill's own merge.

## Further Notes

- No ADR: the decision is easily reversible, touches no engine code, and the "why" (behavioural config is machine-local preference, not project knowledge) is short. Recorded here instead.
- The glossary term **Setup** was added to CONTEXT.md during the design conversation.
- Real pools on this machine already show the reuse pattern this formalises: the same harness/model pair, the same single general-purpose subagent roster, and near-identical reviewer/checkpoint prose recur across pools, each re-typed by the interview.
