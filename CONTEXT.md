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

**Super-step boundary**:
The pause between two super-steps, where the engine does what a super-step in flight must not: the Config reload, the Queued answer drain, Spawn adoption, the reconciles, and the check of the Merge hold. Only then is the ready set computed and the next super-step planned. While the Merge hold stands the boundary waits and recomputes; nothing is planned until it lifts.
_Avoid_: tick (implies a clock; the boundary runs when the previous super-step ends), between-step

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

**Ticket file**:
The markdown file that is a Ticket's record: its state line, its spec, and whatever the work adds to it, such as a Brief or Notes. The Pool's own copy is the file of record; the next agent reads that copy, and the engine writes status there. An Attempt that runs in its own worktree gets a seed copy for context. Anything the agent adds to either copy survives: edits committed on the Attempt's branch are carried into the file of record when that branch merges, never discarded. If the two copies disagree on the same lines, the file of record shows both versions and the Ticket log says so.
_Avoid_: issue file (legacy name), marker (that's the state line the engine reads), spec (the body only), seed (that's the worktree's copy, not the record)

**Review**:
The final human judgment of finished ticket work, after implement tickets have run.
_Avoid_: per-ticket lint, typecheck (those are not Review)

**Pool**:
The set of Tickets and Conversations one Console run works, identified by its directory on disk. Hermetic: no ticket edges cross pool boundaries. One Console server binds one pool at a time. A Pool that holds no Tickets at all is still a Pool: see Seeded Pool.
_Avoid_: project, workspace, queue

**Seeded Pool**:
A Pool that starts with no Tickets and grows from live work: the operator Enlists herdr panes into it as Conversations, and those Conversations Spawn the Tickets. It opts in by holding a `conversations/` directory, which may be empty; without that directory an empty ticket directory is the "no Tickets written yet" mistake and the Console refuses to start. Ordinary in every other respect, and seeded only at the beginning: the same config, the same server, the same super-steps and merges, and from its first Spawn it holds Tickets like any other Pool. Introduced by ADR-0024 (`docs/adr/0024-a-pool-may-start-with-no-tickets.md`).
_Avoid_: empty pool (it is empty only at the start), conversation-only pool (it stops being that at the first Spawn), scratch pool, sandbox

**Console**:
Billy's UI for driving a thread — the agent graph rendered as node cards on a canvas, with interrupts answered inline in the node that raised them or from that node's Detail. One Console process serves exactly one Pool; running several pools means several Consoles, each on its own port.
_Avoid_: dashboard, Studio (the LangGraph UI it replaces)

**Console session**:
The Console's client-side owner of the snapshot, selection, caches and stale-answer guards across snapshot cycles. It runs the snapshot-to-cards derivation once per cycle; renderers read its projected model and decode nothing themselves. Not a harness session (a harness's own resumable unit) and not a Conversation (which is a Pool citizen with no finish line).
_Avoid_: session (ambiguous with the harness's), view model (too generic)

**Fleet**:
The set of live Consoles on this machine, recorded in a registry file so any of them can be found.

**Setup**:
A named, machine-local bundle of a pool's behavioural config — harness, model, drivers, roster, resolver, reviewer/checkpoint — saved under `~/.agent-graphs/setups/` and offered when a new pool is configured. Pool-specific values (port, assign, AGENT.md prose) are never part of a Setup.
_Avoid_: profile, template

**Assignment**:
The harness, model, and drivers an Attempt runs on. Resolved by the engine field-wise: a ticket's assign entry overrides the pool defaults field by field; grader, head-to-head, and spawned tickets inherit from their build or parent ticket ahead of the pool defaults, and any field the parent leaves empty (an enlisted Conversation names no model) falls through to the defaults. A ticket with nothing to fill a field from is unassigned; it renders that way and, when it would schedule, waits as a Config interrupt rather than launching. An Assignment belongs to an Attempt, not a ticket: it is resolved from the current Pool config at the super-step boundary that plans the Attempt, and never changes while that Attempt is in flight. A ticket with no Attempt in flight takes whatever the config says at the next boundary, whether it is a fresh Spawn or a ticket about to run again. Every ticket card shows the Assignment its next or current Attempt runs on. Introduced by ADR-0018 (`docs/adr/0018-assignments-belong-to-attempts-config-reloads-at-boundary.md`), closing issue #63.
_Avoid_: config (that's the raw file the Assignment is resolved from), profile

**Config interrupt**:
The Interrupt the engine raises on a Ticket about to schedule with no harness or model, in the engine's own voice like a persistence interrupt, naming the missing field and the console.json fix. The Ticket waits as a checkpoint; resume returns it to ready, and the next super-step boundary's Config reload re-resolves its Assignment. Resuming with the file unchanged raises the same interrupt again. A pool-config gap pauses one Ticket and never ends the run. Introduced by ADR-0022 (`docs/adr/0022-a-config-gap-pauses-the-ticket-not-the-run.md`), closing issue #118.
_Avoid_: dead drive (that was the old outcome), pool config error (the log line, not the pause)

**Config reload**:
The engine's re-read of the Pool config file at a super-step boundary. Only the assignment slice reloads (defaults, assign, resolver); roster, agents, selection, terminal, and port stay as they were at boot. A reload is all or nothing: a file that fails to parse or would give any reassignable ticket an invalid Assignment is rejected whole, logged once, and the previous config stands.
_Avoid_: hot reload (implies a watcher; there is none), restart

**Detail**:
The Console's right-hand panel for the selected node card — its status, channels, and pending interrupt at full size. Mirrors the card's interrupt form; both stay live. Resizable by dragging its left edge; can expand to fill the Console window.
_Avoid_: drawer (that's the bottom log/state strip), inspector (the state channel drawer)

**Attempt**:
One run of a harness on behalf of a Ticket or a Conversation, from Launch to exit. A ticket accumulates attempts across retries, merge-resolver runs, and review rejects; a Conversation has exactly one, ended by the operator or by a crash.
_Avoid_: run (that's the whole thread), execution, job

**Live attempt**:
An Attempt between its launch and its Attempt ending, as the engine knows it in memory: the attempt number and, for a Terminal-backed attempt, its pane. The engine's snapshot carries one per Ticket, the highest-numbered Attempt still live, so the Console and the terminal routes read the pane from the snapshot and never work it out from the events files. Gone the moment the ending is recorded; never persisted, so a restart knows only what it re-adopts.
_Avoid_: running attempt (status is the ticket's), current attempt (a settled Attempt is still the latest), active pane (the pane is where it runs, not what it is)

**Terminal-backed attempt**:
An Attempt whose harness runs as an interactive TUI in a herdr pane instead of a headless child — a real terminal the operator can watch and type into mid-run, while the engine stays oblivious to that input. The attempt ends when a valid Outcome appears; the TUI stays alive afterward and pane exit trails whenever the operator closes the tab, so pane loss *without* an Outcome is the crash signal. Its Stream file is a `script` typescript (both directions), not harness stream-json (ADR-0016). Opted into per pool with `terminal: herdr`; headless remains the default and fallback. Introduced by ADR-0014 (`docs/adr/0014-attempts-terminal-backed-in-herdr.md`), toward issue #29.
_Avoid_: interactive attempt (interaction is the operator's, not the attempt's), attached attempt, PTY attempt

**Pool workspace**:
The one herdr workspace a Terminal-backed pool opens its attempt and Conversation tabs in, so every tab of one Pool sits together and never in another project's workspace. Resolved once at boot, from the workspace the Console server was launched in or by creating a fresh one, and kept across restarts while it still exists. Settled by the issue #94 amendment to ADR-0015 (`docs/adr/0015-attempts-spawn-as-named-herdr-tabs.md`).
_Avoid_: workspace (banned as a Pool synonym; a herdr workspace is a container, a Pool is the work), window, project workspace

**Outcome**:
The JSON an attempt writes at exit to signal its result: done, or checkpoint with a Brief for the human. It may also carry Spawn proposals. The engine reads the Outcome and writes the ticket's final status itself; agents never write status. Introduced by ADR-0005 (`docs/adr/0005-engine-owns-final-status.md`), closing issue #18.
_Avoid_: exit code (a crash signal, not a result), status marker (the engine owns that write)

**Launch**:
Starting an Attempt's harness: headless, spawning the child; Terminal-backed, opening the tab, waiting for its shell, typing the wrapper command, waiting for the TUI's ready frame, and typing the prompt. The launch is over when the harness is running and holds its prompt, or when it has been decided that it never will. One Attempt has one launch, however many tabs the launch opened to get there.
_Avoid_: spawn (that's a proposed follow-up ticket), start (the operator starts a Conversation; the engine launches its Attempt), boot (the pool's)

**Botched launch**:
A Launch whose wrapper command never ran, so no harness ever started: the pane's shell was still starting when the command was typed and swallowed part of it. Retried into a fresh tab a bounded number of times before it counts as the Attempt's crash; never graded, and a Conversation it fails leaves no worktree or branch behind, since nothing ever ran in them. Distinct from a harness that ran and died, whose own exit code is the ending.
_Avoid_: spawn race (the mechanism, not the thing), dead on arrival, readiness timeout (a launch whose harness ran but never painted; that one is not retried)

**Attempt ending**:
The observation that an Attempt is over. Headless, that is the harness's child exiting. A Terminal-backed attempt has no child, so its ending is whichever of three forms is observed first: herdr reporting the pane's end, the attempt's exit code landing on disk, or the pane found gone with no exit code behind it, which is a crash. The forms are raced, never ranked, because each is blind where another sees; only the exit code landing does not depend on the daemon still talking to us. Recorded in the fifth amendment to ADR-0014, "Attempts may run terminal-backed in herdr panes".
_Avoid_: exit (one form of an ending, not the ending), timeout (there is none; liveness is the signal), completion (an ending may be a crash), Outcome (the attempt's account of its result; an ending only says it stopped)

**Orphan attempt**:
An Attempt whose engine stopped while it ran. A headless orphan is stopped by the engine: at shutdown when the engine can, or at the next boot when a recorded process is found still alive in the ticket's worktree. A terminal-backed orphan lives on in its herdr pane and is re-adopted at boot instead. The engine never schedules a new Attempt into a worktree an orphan is still writing. Introduced by ADR-0017 (`docs/adr/0017-headless-orphans-are-killed-not-adopted.md`), closing issue #65.
_Avoid_: zombie (a zombie is dead; an orphan is alive and working), leaked process, stray agent

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

**Stopped**:
The terminal phase a pool server sends as its farewell on an orderly shutdown, whether the Console asked for it (only offered once the pool is done) or a signal did. The last snapshot on the stream before the stream ends; a tab that has seen it knows the server left on purpose, shows the relaunch command, and reconnects on its own when the pool is relaunched. Distinct from dead: nothing went wrong, and there is no `errors.jsonl` entry. Introduced by ADR-0019 (`docs/adr/0019-finished-pool-stops-from-the-console-with-a-farewell.md`), closing issue #97.
_Avoid_: killed, crashed, disconnected (those are the cases it exists to be told apart from)

**Needs input**:
The Console surface listing every ticket with an unresolved Interrupt — the operator's work queue, shown as a tray with a count. Answered tickets appear greyed until the boundary drains their Queued answers.
_Avoid_: action items, task list, notification center

**Spawn**:
A follow-up ticket an attempt proposes in its Outcome and the engine writes into the pool at the super-step boundary, under the id `<parent-id>-spawn-N`. Ordinary in every way from the moment it lands — it schedules, assigns, verifies, and may itself Spawn — bounded by engine-enforced caps per attempt and per run. The agent proposes; only the engine writes the pool. Introduced by ADR-0010 (`docs/adr/0010-agents-propose-spawn-engine-writes.md`), closing issue #32.
_Avoid_: sub-ticket (no parent-child relationship after writing), dynamic ticket (describes the mechanism, not the thing)

**Conversation**:
An open-ended talk between the operator and one agent, living in a Pool beside its Tickets, or before there are any in a Seeded Pool. It has an Assignment fixed at start, its own worktree and branch, and no done condition: only the operator ends it. While it runs it may Spawn Tickets and other Conversations, and the engine posts a Turn into it when a Ticket it spawned ends. Not a Ticket: a Ticket is one unit of work that must end in an Outcome; a Conversation has no finish line. Introduced toward issue #60.
_Avoid_: chat (too generic), session (a harness's own resumable unit), open-ended ticket (a Ticket must end), handoff (the old file)

**Turn**:
One exchange in a Conversation: something said to the agent, or the agent's reply. The operator types Turns in the herdr tab; the engine types a Turn when a spawned Ticket ends. A Conversation is always either waiting on the operator or working on a Turn.
_Avoid_: message (a chat term), prompt (that is only the first Turn), super-step (that is the engine's round, not the talk's)

**Turn state**:
Which side of its current Turn a Conversation is on: working (the agent is replying) or waiting (on the operator), with the last line the agent showed and, when waiting, since when. Read from the pane by the engine, never reported by the agent. A Notice is delivered only while the Conversation is waiting.
_Avoid_: Turn (that is the exchange itself), idle (the agent waits for the operator; it is not idle), status (that is live, ended or crashed)

**Notice**:
The Turn the engine types into a parent Conversation when something it spawned ends: a spawned Ticket's id, title, Outcome and branch, or a child Conversation's branch and the operator's closing line. Queued while the parent's agent is working; delivered when the parent is next waiting on the operator. It informs the parent; it never answers an Interrupt.
_Avoid_: callback, event (that is the lifecycle log), result (an Outcome is the result; a Notice only reports it)

**Enlist**:
The operator's act of making a live herdr pane they opened themselves a Pool citizen, as a Ticket or a Conversation, chosen at that moment and fixed from then on. The pane, its directory and its branch stay as found; the engine claims the pane, teaches its agent the protocol with a Turn, and from then on the result is an ordinary Ticket or Conversation. The engine never closes the enlisted tab, never removes its directory and never deletes its branch. Introduced by ADR-0021 (`docs/adr/0021-enlisted-panes-stay-in-place.md`), closing issue #101.
_Avoid_: adopt (the engine's word for taking in Spawn proposals at the boundary and terminal attempts at boot), import, attach, claim (that is one step of an Enlist, not the act)

**Wire shape**:
The declared shape of one message between engine and Console: the snapshot, a response envelope, a request body. Each is declared once, on the engine side; the Console type-imports it, so drift between the two is a compile error, not a silent copy.
_Avoid_: DTO, schema, contract (all too generic)

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


**Jev**:
TypeSafe's judgement model: a System One model that answers narrow, typed questions over Evidence with calibrated probabilities, never generated text. Optional to a Pool: when no key is configured the engine takes its heuristic paths exactly as it always has. A Jev answer gates which engine path runs; the engine remains the only writer of status.
_Avoid_: LLM, the AI, TypeSafe (that's the vendor)

**Evidence**:
The named JSON object a call site hands Jev to answer a question over: only the context relevant to that question. Not State (the run's memory), though it may be assembled from it.
_Avoid_: state (Jev's own parameter name collides with the run's State), context, prompt

**Claimed**:
Text a spawned agent wrote about its own work: an Outcome's summary and the sha it reports, a Brief, a Grade's reasons, a spawn title and body, a resolver's note. A claim is the thing being judged, never the authority a judgement rests on, so it enters an Evidence object in a field of its own and is never joined into a question's instructions. ADR-0022 (`docs/adr/0022-agent-authored-text-is-a-claim.md`).
_Avoid_: self-report, agent output (too broad), untrusted (says why it matters, not what it is)

**Observed**:
What the engine or the harness produced rather than an agent: the attempt log, the diff at the commit, the exit status, the sha the engine read back itself. Where Observed and Claimed disagree about the same work, the Observed wins, and the engine asks for that comparison as a judgement of its own rather than trusting a score to absorb it.
_Avoid_: ground truth, actual, evidence (Evidence is the whole object handed to Jev, not this half of it)

**Judgement**:
One typed answer from Jev to one question: a Choice (one label, with a probability per label and a confidence), a Noul (a probability that a condition holds), or a Jev Score (an expected position on an ordered rubric, with probabilities and a confidence). Every question over the same Evidence is asked in one request.
_Avoid_: verdict (that's head-to-head grading), guess, prediction, score (say Jev Score; a Grade has a score too)
