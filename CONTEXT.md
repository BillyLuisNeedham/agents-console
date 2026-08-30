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

**Detail**:
The Console's right-hand panel for the selected node card — its status, channels, and pending interrupt at full size. Mirrors the card's interrupt form; both stay live. Resizable by dragging its left edge; can expand to fill the Console window.
_Avoid_: drawer (that's the bottom log/state strip), inspector (the state channel drawer)

**Attempt**:
One run of a ticket by a harness, from spawn to exit. A ticket accumulates attempts across retries, merge-resolver runs, and review rejects.
_Avoid_: run (that's the whole thread), execution, job

**Outcome**:
The JSON an attempt writes at exit to signal its result: done, or checkpoint with a Brief for the human. The engine reads the Outcome and writes the ticket's final status itself; agents never write status. Introduced by `docs/specs/2026-08-30-engine-owns-final-status.md`, closing issue #18.
_Avoid_: exit code (a crash signal, not a result), status marker (the engine owns that write)

**Ticket log**:
The complete record of a ticket's work — every attempt's raw harness output plus the lifecycle events (scheduled, spawned, exited, merged, interrupted) between them. Read from the ticket's Detail.
_Avoid_: log drawer (that's the pool-level channel), transcript, chat history

**Queued answer**:
An interrupt answer the Console has accepted and acknowledged but not yet processed, because a super-step is in flight. Visible on the ticket as a waiting state; processed at the next super-step boundary; survives a server restart.
_Avoid_: pending answer (that's the interrupt, not the answer)
