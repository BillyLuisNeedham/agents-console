# Hold the super-step until done tickets are merged

Closes issue #41. Decision record: ADR-0012 (`docs/adr/0012-hold-super-step-until-done-tickets-merged.md`).

## Problem Statement

When a ticket's attempt exits, the engine writes its marker `done` before its `pool/NN` branch merges to main. The ready set unblocks downstream tickets on that marker alone, so a dependent ticket spawns against a main that does not yet contain its blocker's work. This happened live: ticket 15 spawned while ticket 10 sat behind a merge conflict, so ticket 15 started from code missing the work it depended on. From the operator's perspective, the pool claims a blocker is finished and immediately starts work that cannot possibly see that finished work.

## Solution

The pool pauses for merge hygiene: the scheduler computes no ready set at all while any ticket is done-but-unmerged. Every ticket in the next super-step therefore starts from a main (or feature-branch target) that contains all finished work. The operator's existing merge-approval interrupt remains the signal and the action; a held ticket's Console card reads "done, merge pending" so the pause explains itself. The hold lifts when the merge lands — by approval or by a manual CLI merge the engine simply observes — or when the merge is rejected and the ticket reopens.

## User Stories

1. As the pool operator, I want downstream tickets to wait until their blocker's branch has merged, so that new work starts from code that actually contains the work it depends on.
2. As the pool operator, I want the whole pool to pause while any done ticket is unmerged, so that no super-step ever runs against a partially-merged pool.
3. As the pool operator, I want the pause to apply everywhere tickets get scheduled — main loop, verify flows, and selection runs — so that no code path can recreate the bug.
4. As the pool operator, I want tickets already running when the pause engages to finish undisturbed, so that in-flight work is not wasted.
5. As the pool operator, I want approving a queued merge to lift the pause automatically, so that one action both merges and unsticks the pool.
6. As the pool operator, I want merging a branch manually from my CLI to lift the pause, so that I can unstick the pool without touching the Console.
7. As the pool operator, I want rejecting a merge to lift the pause by reopening the ticket, so that abandoning a branch is also an escape hatch.
8. As the pool operator, I want the held state to survive an engine restart without any extra bookkeeping, so that crash-mid-merge recovery is boring.
9. As the pool operator, I want a held ticket's card to read "done, merge pending", so that I can see why the pool has paused without reading logs.
10. As the pool operator, I want no extra interrupt for the held state beyond the merge-approval I already have, so that one notification maps to one action.
11. As a ticket agent, I want my Outcome to carry my result downstream exactly as before, so that the hand-off protocol does not change.
12. As the pool operator, I want the pause to apply to feature-branch merge targets as well as main, so that the invariant "everything done is fully merged" holds regardless of branch topology.
13. As a maintainer, I want the pinned test that asserted downstream work proceeds despite a conflicted merge to be rewritten, so that the test suite encodes the new invariant instead of the old behavior.
14. As a maintainer, I want the dead spawn-time warning about unmerged blockers removed, so that no code path contradicts the new rule.

## Implementation Decisions

- The hold is a check at ready-set time: if any ticket has a `done` marker whose `pool/NN` branch is not in its merge target, the scheduler computes no ready set and the pool pauses. One rule, one code path, applied at every site that computes the ready set (main scheduling loop, verify flows, selection runs).
- The hold is **derived, never persisted**: it is recomputed on demand from markers and branch state, including at startup, consistent with ADR-0007's derive-server-side pattern. No new fields in pool state, no new checkpoint data.
- The hold lifts in exactly two ways: the merge lands (via the existing merge-approval flow or an observed manual merge), or the merge is rejected and the ticket reopens. No new force-resume mechanism — the existing controls are the escape hatches.
- Running attempts are untouched; the hold gates only spawning, matching how queued answers are already processed at the super-step boundary (ADR-0004).
- No new "held" interrupt is raised. The existing merge-approval interrupt is the signal; the Console adds a "done, merge pending" label on held tickets via the existing server-side enrichment seam (ADR-0007).
- The Outcome channel is unchanged — a blocker's Outcome JSON still carries its result downstream; only the timing changes. Downstream tickets now wait for the merge as well as the marker.
- The spawn-time warning about unmerged blockers becomes dead code under the hold and is removed.
- This deliberately reverses the half of ADR-0005's decoupling that let scheduling treat done as sufficient; "done" now means "work finished, merge pending or landed", and only the merged fact unblocks the pool. The Winner definition (ADR-0007) is untouched — selection independence from merging is a separate concern.

## Testing Decisions

- One seam, at the engine's scheduling behavior: the existing engine test suite drives the drive loop and asserts which tickets spawn when. The hold is observable entirely there — spawn or no spawn — so no new seam is introduced.
- Rewrite the pinned test that asserts a downstream ticket receives its blocker's outcome despite a conflicted merge: it now asserts the downstream ticket does **not** spawn until the merge lands, and that the outcome still flows once it does.
- New tests at the same seam: pool held when a done ticket is unmerged; hold lifts on merge approval; hold lifts on observed manual merge; hold lifts on merge rejection with ticket reopened; running attempts finish while held; hold derived correctly on restart (markers plus branch state, no persisted hold flag); hold applies in verify and selection scheduling paths; hold applies to feature-branch targets.
- Prior art: the existing ready-set, merge-conflict, and drain-at-boundary tests in the engine suite; the server-side enrichment tests for the new card label.
- Good tests assert external behavior only (which tickets spawn, what the card shows), never internal hold bookkeeping — there is none, by design.

## Out of Scope

- Per-ticket gating (unblocking a dependent the moment its specific blocker merges while the rest of the pool continues) — rejected in grilling in favor of the simpler whole-pool hold.
- Draining pending approvals before each ready-set computation as a standalone fix — loses the race when the operator is slow; subsumed by the hold.
- Any change to the Outcome JSON schema or the agent-facing protocol.
- Any change to Selection or Winner semantics.
- A "resume anyway" operator override beyond the existing approve/reject/manual-merge controls.

## Further Notes

- The behavior being replaced was half-deliberate: outcomes flowing downstream independent of merging was load-bearing for the conflicted-merge case. The spec preserves the outcome flow and changes only scheduling, which is why the pinned test is rewritten rather than deleted.
- A stuck merge now stalls the entire pool, not just dependents. This is deliberate: the hold makes the operator's merge queue the visible bottleneck.
- Visualization prototype (`engine/PROTOTYPE-issue-41-merge-gating.html`, throwaway) walked through the candidate policies; tab 3 ("hold the whole super-step") is the one chosen.
