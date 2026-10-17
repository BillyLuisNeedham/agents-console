# One rolling scheduler starts each Ticket once its own blockers have merged

Amends ADR-0014 (`docs/adr/0014-hold-super-step-until-done-tickets-merged.md`), and changes the "at the boundary" wording of ADR-0004, ADR-0010, ADR-0018 (Assignments) and ADR-0029. The scheduler ran in super-steps: plan every ready Ticket, run them all, and do nothing new until the last one ends. No ADR chose that. It came from the TypeScript engine's Pregel vocabulary, and every later rule that waits for "the boundary" inherited it. Under a Plan (ADR-0039) it costs most where it matters: one slow copy holds back the next wave of a per-item node, and every other branch of the graph with it. The operator's call was that Tickets "should run as quickly as they can".

**One scheduler, rolling, for every pool.** The drive is a loop of ticks. A tick is one actor job that reloads the config if it changed, drains Queued answers, reconciles deadlocks, advances the Line, lands Pending spawns, starts owed grading, and launches every eligible Ticket. It then waits for a wake, which every exit, merge landing, answer, settings save, Conversation end, plan edit, grading end, Adopt, Enlist and Reassign sends. A Ticket starts the moment it is eligible, not when its siblings end. There is no super-step mode left for plain pools: two schedulers would be two merge rules and two sets of conformance cases forever.

**ADR-0014's whole-pool hold becomes per-blocker gating.** A Ticket is eligible once each of its blockers is Done and merged into the target. Its worktree is cut from the target's tip at its own launch, which by then holds every blocker's work. That keeps what the hold was for: no Ticket starts on a target that lacks work it depends on (issue #41). It drops what the hold added on top, which was every Ticket waiting on every merge. ADR-0014 rejected per-blocker gating because the scheduler would have to join two facts per Ticket, and because a partly unmerged pool would schedule new work. The first cost is now one memoised ancestry check per blocker. The second is the point: unrelated work should not wait. A Ticket that relied on a fully merged main without naming its blocker must now name it.

Merged has three rules, applied in this order. A hold Ticket and an engine-run Ticket (grader, head-to-head) count as merged by rule, because neither has a branch; the engine never infers this from a missing branch. A pool outside git counts every Done Ticket as merged. Otherwise the branch must be an ancestor of the target. ADR-0014's missing-branch reading still covers a branch the operator merged or deleted by hand. The Merge queue stays as ADR-0014's amendments describe it, derived and never persisted.

**Every Ticket runs in its own worktree.** The lone ready Ticket no longer runs in the pool checkout: with rolling starts there is no "lone" Ticket, and a Ticket in the checkout would share the tree that merges write to. The pool checkout is written only by merges, through the checkout gate (ADR-0027).

**What replaces each boundary duty.**

| Duty | Before | Now |
|---|---|---|
| Answers and Close (ADR-0004) | processed at the boundary, or at once when idle | processed at the next tick, which runs at once unless a job is mid-flight. ADR-0004's reason to wait, a join rebuilding state from a frozen snapshot, is gone. Acceptance, the Queued answer file and 202 are unchanged. |
| Config reload (ADR-0018) | at the boundary | at every tick, when `console.json`'s stamp moved. A live Attempt keeps its Assignment; any Ticket not yet launched takes the new one. The all-or-nothing rule is unchanged. |
| Spawn landing (ADR-0010, ADR-0029) | at the boundary | at the tick after a proposal is taken. A `blocks` naming a Ticket that has started is no longer added under it: the proposal is Held with the reason `started`. |
| Deadlock reconcile | twice per boundary | once per tick, raise-if-absent keyed on Ticket and blocker. |
| Crash Interrupts | after the step's join | at the Attempt's exit. |
| Verify grading | after the step's join | per Ticket, once its last Candidate exits. A restart rebuilds the group from the Ticket's events. |
| Continued grading | between steps | a grading flow started by the tick; owed grades are still derived from events at boot. |
| Merge conflicts | one at a time after the join; the hold paused every start | per Ticket as its merge ends, still serialised by the merge chain. Only the conflicted Ticket's dependents wait. Its Interrupt shows how many Tickets started since it was raised, derived from events. |
| Upstream Outcomes in prompts | a snapshot frozen per step | a snapshot frozen per launch; a Done blocker's Outcome cannot change under it. |
| Checkpoint rows (ADR-0008) | one per boundary | one after each job that changed the pool's state. No row count is a contract. |
| Pool log | `super-step N: ids` | `start <id> at <sha7>` per launch. |

**A pool-wide `maxLive` throttles launches.** Super-steps had no concurrency cap and needed none, because a step was as wide as the ready set at one moment. Rolling starts plus a per-item `all` would launch every item at once. `maxLive` is a Pool setting with a Machine default, unlimited unless set, that holds launches while that many Ticket Attempts are live. A verify Ticket needs room for all its Candidates unless nothing is live. A resolver counts but is never withheld, because it is the way out of a conflict (ADR-0014's exception stands). Per-node caps stay in the Plan's pass queues, so the scheduler never needs to know what a node is.

**Considered Options**: Keeping super-steps for plain pools and rolling only Lines was rejected as two schedulers. Keeping the whole-pool hold under rolling starts was rejected: it puts back the stall rolling exists to remove, every start waiting on every merge. A slot-counting scheduler that knows each node's cap was rejected, because caps would then have two owners and copies past a cap would sit as Tickets that are written but may not run. Answers processed in the HTTP job itself, with no tick, were rejected so that every change to eligibility goes through one job in one order.

**Consequences**:
- About forty conformance files change their wording or their assertions. Every `super-step` log line, row count and "at the boundary" text goes.
- The Console's Queued answer and Pending spawn states now last a tick, not a super-step.
- Prove still checks merged work (ADR-0038): Prove is blocked by the Ticket it proves, so it starts only after that Ticket's merge.
- A stuck merge no longer stalls the whole pool. New work may start against a target that is about to change, and the conflict Interrupt says how much did.
