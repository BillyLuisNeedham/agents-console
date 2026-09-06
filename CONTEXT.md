# Agent Graphs

The Console is Billy's UI for driving an agent graph thread — the graph rendered as node cards on a canvas, with interrupts answered inline. This file is the domain model the code and the UI are written in.

## Language

**Agent Graph**:
An executable control-flow structure for agentic work. Nodes do work; edges choose what runs next; state is what the run knows.
_Avoid_: knowledge graph, graph database, GNN

**State**:
The run's memory. Nodes return partial updates; channels merge those updates.
_Avoid_: context window, conversation history (those may live *in* state, they are not state)

**Node**:
A function that reads state and returns a partial update. May be deterministic code or a model call.
_Avoid_: agent (a node may *run* an agent; it is not itself the agent), step, stage

**Edge**:
A routing rule from one node to the next. Fixed, or it inspects state.
_Avoid_: handoff, transition (unless talking about the existing non-graph pipeline)

**Channel**:
One keyed field in state, with its own merge rule.
_Avoid_: field, property (too generic)

**Reducer**:
The function `(current, update) => value` that merges one channel.

**Super-step**:
One coordinated round of node execution. Parallel nodes in the same super-step see the same starting snapshot.

**Checkpoint**:
A saved snapshot of state after a super-step. Makes a run pausable and resumable.

**Thread**:
One durable run of the graph, identified so later invokes resume the same checkpoints.

**Interrupt**:
A planned pause that waits for a human before the graph continues.
_Avoid_: debugger breakpoint, exception

**Grill**:
The interview that sharpens a plan until the work is clear enough to specify.

**Spec**:
The written description of the work to do, produced after Grill.

**Packet**:
The prose Grill writes into state when the interview is done — decisions plus any extra context Spec needs. The graph's replacement for today's handoff file.
_Avoid_: message (that's a chat turn), handoff (the old file/skill), decision list (too thin)

**Ticket**:
One unit of implement work. It has an id and the ids of tickets that must finish before it may run.
_Avoid_: issue, task, Implement (Implement is not a node; tickets are)
On disk the pool's ticket directory is still called `issues/`, and the skill `my-issue-runner` keeps its name — legacy names for the same concept; prose says ticket.

**Review**:
The final human judgment of finished ticket work, after implement tickets have run.
_Avoid_: per-ticket lint, typecheck (those are not Review)

**Pool**:
The set of tickets one Console run works, identified by its directory on disk. Hermetic: no ticket edges cross pool boundaries. One Console server binds one pool at a time.
_Avoid_: project, workspace, queue

**Console**:
Billy's UI for driving a thread — the agent graph rendered as node cards on a canvas, with interrupts answered inline in the node that raised them or from that node's Detail. One Console process serves exactly one Pool; running several pools means several Consoles, each on its own port.
_Avoid_: dashboard, Studio (the LangGraph UI it replaces)

**Fleet**:
The set of live Consoles on this machine, recorded in a registry file so any of them can be found.

**Setup**:
A named, machine-local bundle of a pool's behavioural config — harness, model, drivers, roster, resolver, reviewer/checkpoint — saved under `~/.agent-graphs/setups/` and offered when a new pool is configured. Pool-specific values (port, assign, AGENT.md prose) are never part of a Setup.
_Avoid_: profile, template

**Assignment**:
The harness, model, and drivers a ticket runs on. Resolved by the engine field-wise: a ticket's assign entry overrides the pool defaults field by field; grader, head-to-head, and spawned tickets inherit from their build or parent ticket rather than the pool defaults. A ticket with neither defaults nor an assign entry is unassigned. Every ticket card shows its Assignment.
_Avoid_: config (that's the raw file the Assignment is resolved from), profile

**Detail**:
The Console's right-hand panel for the selected node card — its status, channels, and pending interrupt at full size. Mirrors the card's interrupt form; both stay live. Resizable by dragging its left edge; can expand to fill the Console window.
_Avoid_: drawer (that's the bottom log/state strip), inspector (the state channel drawer)

**Attempt**:
One run of a ticket by a harness, from spawn to exit. A ticket accumulates attempts across retries, merge-resolver runs, and review rejects.
_Avoid_: run (that's the whole thread), execution, job

**Terminal-backed attempt**:
An Attempt whose harness runs in a herdr pane instead of a headless child — live in a real terminal the operator can watch and type into, while the engine stays oblivious to that input and the attempt still ends only on exit plus Outcome. Opted into per pool with `terminal: herdr`; headless remains the default and fallback. Introduced by ADR-0014 (`docs/adr/0014-attempts-terminal-backed-in-herdr.md`), toward issue #29.
_Avoid_: interactive attempt (interaction is the operator's, not the attempt's), attached attempt, PTY attempt

**Outcome**:
The JSON an attempt writes at exit to signal its result: done, or checkpoint with a Brief for the human. It may also carry Spawn proposals. The engine reads the Outcome and writes the ticket's final status itself; agents never write status. Introduced by ADR-0005 (`docs/adr/0005-engine-owns-final-status.md`), closing issue #18.
_Avoid_: exit code (a crash signal, not a result), status marker (the engine owns that write)

**Merge hold**:
The pool-wide pause the scheduler takes while any ticket is done-but-unmerged. No ready set is computed — nothing new spawns, in any flow that computes one — until every `done` ticket's branch has landed in its merge target or its merge has been rejected. Derived on demand from markers and branches, never persisted; the existing merge-approval interrupt is the signal, and a held ticket's card reads "done, merge pending". Introduced by ADR-0014 (`docs/adr/0014-hold-super-step-until-done-tickets-merged.md`), closing issue #41.
_Avoid_: block (that's a ticket dependency), gate (per-ticket gating was the rejected alternative)

**Ticket log**:
The complete record of a ticket's work — every attempt's log plus the lifecycle events (scheduled, spawned, exited, merged, interrupted) between them. Read from the ticket's Detail. Since ADR-0012 the per-attempt log is derived live from the attempt's Stream file, not raw harness bytes.
_Avoid_: log drawer (that's the pool-level channel), transcript, chat history

**Stream file**:
The raw, verbatim tee of a streaming harness's structured output for one attempt — `runs/<id>.stream.jsonl`, written live as bytes arrive. The source of truth the attempt's human-readable log is derived from; kept for forensics when the derived view loses fidelity. Only harnesses with a structured stream mode (claude, cursor) produce one; opencode's raw stdout already serves as its log.
_Avoid_: raw log (that's what the ticket log used to be), jsonl log, event log (that's the lifecycle events file)

**Vitals**:
The compact liveness readout on a ticket card while an attempt runs — diff totals, time since last observable change, sparkline. Read live from the attempt's worktree diff and log growth, not from the ticket log.
_Avoid_: activity (too generic), status (that's the ticket's lifecycle state), progress (implies a known finish line)

**Queued answer**:
An interrupt answer the Console has accepted and acknowledged but not yet processed, because a super-step is in flight. Visible on the ticket as a waiting state; processed at the next super-step boundary; survives a server restart.
_Avoid_: pending answer (that's the interrupt, not the answer)

**Dead drive**:
A drive loop that has died — from an unhandled error or a hang — while the server keeps serving the last snapshot as if the run were still live. Distinct from stalled: the closing gate never ran; since ADR-0008 a reported death emits the terminal dead phase, and a death that emits nothing is lying.
_Avoid_: stuck, frozen, hung pool

**Needs input**:
The Console surface listing every ticket with an unresolved Interrupt — the operator's work queue, shown as a tray with a count. Answered tickets appear greyed until the boundary drains their Queued answers.
_Avoid_: action items, task list, notification center

**Spawn**:
A follow-up ticket an attempt proposes in its Outcome and the engine writes into the pool at the super-step boundary, under the id `<parent-id>-spawn-N`. Ordinary in every way from the moment it lands — it schedules, assigns, verifies, and may itself Spawn — bounded by engine-enforced caps per attempt and per run. The agent proposes; only the engine writes the pool. Introduced by ADR-0010 (`docs/adr/0010-agents-propose-spawn-engine-writes.md`), closing issue #32.
_Avoid_: sub-ticket (no parent-child relationship after writing), dynamic ticket (describes the mechanism, not the thing)

## Verification

**Verify**:
Optional per-ticket machinery that checks whether finished Attempt work actually satisfies its ticket, instead of trusting the agent's done-claim. A ticket opts in by setting `verify: N` in its assign block — N parallel Attempts, one grader ticket per Attempt, then Selection. Absent the key, the ticket runs exactly as it always has. The pool's `verify` skill, written beside AGENT.md at Console setup, holds the grading instructions a grader agent follows.
_Avoid_: verifier node, judge (a judge is a model, not this machinery)

**Grade**:
One grader's assessment of one Attempt: a score (0–10), a verdict (pass or flag), and short reasons. The grader is itself a ticket — an ordinary assignment, so its harness and model are chosen through the normal assign machinery. The grade lands in the graded Attempt's record, visible in the ticket's Detail. With `verify: 1`, a failing Grade becomes the Brief of a checkpoint interrupt.
_Avoid_: rating, review (Review is the human's final judgment)

**Selection**:
The engine's pick of the best graded Attempt among a ticket's N candidates. A margin of ≥2 points takes the winner outright; a tighter spread spawns one head-to-head ticket comparing the top two side by side (the way the paper's pairwise comparisons work). Losers' branches are discarded; their logs and grades stay. A pool may set `selection: human` to raise an interrupt and let the human pick instead.
_Avoid_: tournament, ranking

**Winner**:
The Attempt Selection named, recorded as the `selected` event on the ticket's log. The Winner is the winner from the moment that event lands — before and independent of its branch merging, so a conflicted merge sitting at a checkpoint changes nothing about which Attempt won. On a ticket graded before the selection machinery, the merged Attempt stands in. Derived exactly once, server-side, in the grades endpoint; every UI surface reads it from there.
_Avoid_: merged attempt (that's the fallback, not the definition)

**verify: N**:
The per-ticket assign key that activates verification. N is both the number of parallel Attempts and the number of grader tickets. The key's absence — not a zero, not a false — means the ticket runs ungraded, exactly as before.
_Avoid_: takes, retries

