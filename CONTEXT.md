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

**Closed**:
A Ticket dropped at a checkpoint, merge conflict or deadlock Interrupt without merging its work, because the direction changed. Not done: it stays on the board, in the Detail and in the Spawn ledger, and reads as dropped, not finished. It never satisfies a blocked-by, so each Ticket waiting on it stops with a deadlock Interrupt naming it, and the operator decides each one; only the grading Tickets the engine wrote for it close with it. The Pool can still end, and Review can still pass, with closed Tickets in it. Its branch and worktree are thrown away; work that already sits in the Pool checkout or in an enlisted pane is left where it is. The operator may add a closing note. A closed Ticket is not reopened. Introduced by ADR-0032 (`docs/adr/0032-closed-is-a-second-terminal-status.md`), closing issue #154.
_Avoid_: discarded (a Discard removes a Held spawn for good; a closed Ticket stays), cancelled, abandoned, killed, done (done means the work merged)

**Ticket file**:
The markdown file that is a Ticket's record: its state line, its spec, and whatever the work adds to it, such as a Brief or Notes. The Pool's own copy is the file of record; the next agent reads that copy, and the engine writes status there. An Attempt that runs in its own worktree gets a seed copy for context. Anything the agent adds to either copy survives: edits committed on the Attempt's branch are carried into the file of record when that branch merges, never discarded. If the two copies disagree on the same lines, the file of record shows both versions and the Ticket log says so.
_Avoid_: issue file (legacy name), marker (that's the state line the engine reads), spec (the body only), seed (that's the worktree's copy, not the record)

**Review**:
The final human judgment of finished ticket work, after implement tickets have run.
_Avoid_: per-ticket lint, typecheck (those are not Review)

**Pool**:
The set of Tickets and Conversations one Console run works, identified by its directory on disk. Hermetic: no ticket edges cross pool boundaries. One Console server binds one pool at a time. A Pool that holds no Tickets at all is still a Pool: see Seeded Pool.
_Avoid_: project, workspace, queue

**Pool title**:
One line of free text the operator gives a Pool so that several running at once can be told apart. The Console's browser tab and header lead with it, Boot's choice between Pools shows it beside each directory, and a Pool workspace the Console created carries it. Display-only: the Pool's directory stays its identity and never changes when the title does, and two Pools may share a title. Boot asks for it first when it creates a Pool and derives the directory from it; it can be changed at any time from the Pool settings and shows at once. A Pool without one is known by its directory name. Always the operator's words, never made up from the Pool's Tickets or specs.
_Avoid_: pool name, label

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
A named, machine-local bundle of a pool's behavioural config — harness, model, effort, drivers, resolver, reviewer/checkpoint — saved under `~/.agent-graphs/setups/` and offered when a new pool is configured. Pool-specific values (port, assign, AGENT.md prose) are never part of a Setup.
_Avoid_: profile, template

**Assignment**:
The harness, model, effort, and drivers an Attempt runs on. Resolved by the engine field-wise: a ticket's assign entry overrides the pool defaults field by field; grader, head-to-head, and spawned tickets inherit from their build or parent ticket ahead of the pool defaults, and any field the parent leaves empty (an enlisted Conversation names no model) falls through to the defaults. A ticket with nothing to fill a field from is unassigned; it renders that way and, when it would schedule, waits as a Config interrupt rather than launching. An Assignment belongs to an Attempt, not a ticket: it is resolved from the current Pool config at the super-step boundary that plans the Attempt, and never changes while that Attempt is in flight. A ticket with no Attempt in flight takes whatever the config says at the next boundary, whether it is a fresh Spawn or a ticket about to run again. Every ticket card shows the Assignment its next or current Attempt runs on. Introduced by ADR-0018 (`docs/adr/0018-assignments-belong-to-attempts-config-reloads-at-boundary.md`), closing issue #63.
_Avoid_: config (that's the raw file the Assignment is resolved from), profile

**Effort**:
How hard the harness thinks on an Attempt, as that harness names it (claude's low to max; another harness's own words), passed through verbatim like a model name rather than translated from a Console-wide scale. An optional field of the Assignment, layered like model; unset means the harness's own default and never raises a Config interrupt. The resolver may pin its own, beside its own model. A harness that cannot take an effort launches without it, and the Attempt shows the effort as not applied. Enlisted panes run as found, so effort never applies to them.
_Avoid_: thinking, reasoning level, variant (opencode's word for it), ultrathink

**Config interrupt**:
The Interrupt the engine raises on a Ticket about to schedule with no harness or model, in the engine's own voice like a persistence interrupt, naming the missing field and the console.json fix. The Ticket waits as a checkpoint; resume returns it to ready, and the next super-step boundary's Config reload re-resolves its Assignment. Resuming with the file unchanged raises the same interrupt again. A pool-config gap pauses one Ticket and never ends the run. Introduced by ADR-0022 (`docs/adr/0022-a-config-gap-pauses-the-ticket-not-the-run.md`), closing issue #118.
_Avoid_: dead drive (that was the old outcome), pool config error (the log line, not the pause)

**Pool settings**:
The operator's editable view of one Pool's config in the Console: Pool title, pool defaults, resolver, Spawn caps, the Steward entry (its Assignment, its Steward budget and whether it may Close), terminal, port and selection. The Pool title shows as soon as it is saved; editing the assignment slice or the Spawn caps takes effect through Config reload; the boot-only keys take effect on the next Restart, and the Console says so. Per-ticket assign entries are not Pool settings; they live with the Ticket.
_Avoid_: config (that's the raw file), preferences, options

**Machine defaults**:
The per-machine harness, model, effort, drivers, terminal and engine path that a new Pool inherits when nothing more specific says otherwise, kept in one file under `~/.agent-graphs/`. Editable from the Console beside the Pool settings. Not a Setup (a Setup is a named bundle you choose; Machine defaults apply without choosing).
_Avoid_: runner (there is no runner; the engine's term is harness), global config

**Boot**:
Starting a Console for a Pool without an agent, by running `agent-console` from a project's checkout. The Pool is a directory under the project's `.scratch/`; the script relaunches the one that is there, offers a choice when there are several, and creates one when there are none, with the checkout's current branch as the base its Attempts branch from. It prefills from the Pool's own config, then a chosen Setup, then Machine defaults, then detection, interviews only for what is still missing (the whole interview when nothing prefills), rebuilds the UI when stale, starts the server and opens the Console. A Pool is removed by deleting its directory. Not a Launch (that's an Attempt's harness starting). Introduced by ADR-0026 (`docs/adr/0026-boot-is-a-script-restart-hands-off-to-it.md`).
_Avoid_: launch (an Attempt's), spawn (a Ticket an Attempt proposes), run.sh (retired), skill (the skill now only writes the prose files)

**Restart**:
The Console stopping its own server with a farewell and handing off to Boot for the same Pool, so boot-only Pool settings and a fresh build take effect. Allowed while Attempts are live, behind the same inline confirm as Stop; headless Attempts are killed and terminal-backed ones stay in their tabs and are reconciled, as on any restart. Introduced by ADR-0026.
_Avoid_: reload (that's Config reload), reboot

**Reassign**:
The operator changing a Ticket's Assignment from the Console, one Ticket from its Detail or many at once from the Pool settings, by writing that Ticket's assign entry field by field: set a field, leave it, or clear it so the Ticket follows its parent or the pool defaults again. Only a Ticket with no Attempt in flight can be reassigned, and a Ticket the file cannot resolve is not reassignable on its own, with its reason, while every other Ticket still is; the change lands in the file at once and the engine picks it up at the next Config reload, the same seam a hand edit uses. Reassigning pins a Ticket, so it stops following the pool defaults for the fields it sets; editing the defaults instead moves every unpinned Ticket. Not a Setup (a saved bundle chosen when a Pool is made) and not a Config reload (the engine's read, not the operator's write).
_Avoid_: change setup, switch runner, override (the file's word is assign)

**Config reload**:
The engine's re-read of the Pool config file at a super-step boundary, or at once when a Pool settings save finds no drive in flight. Only the assignment slice (defaults, assign, resolver) and the Spawn caps reload; selection, terminal, and port stay as they were at boot. A reload is all or nothing: a file that fails to parse or would give any reassignable ticket an invalid Assignment is rejected whole, logged once, and the previous config stands.
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

**Continued attempt**:
An Attempt launched into the still-live pane of the Terminal-backed attempt whose checkpoint Interrupt it answers, instead of into a new tab, so the agent that holds the context carries on. The operator chooses it with Keep talking on the checkpoint Interrupt; the engine types one teaching Turn saying a fresh Outcome is expected, then leaves the pane to the operator. It is a new Attempt with its own number and Outcome: done ends the ticket as any done does, and checkpoint raises a fresh Interrupt with a new Brief, which may itself be continued. Offered for any checkpoint Interrupt whose Attempt's pane is still alive, never for a headless Attempt. Introduced by ADR-0027 (`docs/adr/0027-keep-talking-continues-a-checkpointed-attempt-in-its-pane.md`), closing issue #139.
_Avoid_: resumed attempt (Resume launches a fresh Attempt in a new tab), reopened attempt (an ended Attempt never takes a second Outcome), follow-up (that's a Spawn)

**Held pane**:
The still-live herdr pane of a Terminal-backed attempt that ended in a checkpoint Interrupt, kept the pool's while that Interrupt waits: the card keeps its Peek, focus and attach, and Keep talking can continue it as a Continued attempt. It is no Live attempt (that Attempt is over). It is held only while the checkpoint is about that Attempt's own work and its agent is still there, and let go when the Interrupt is answered, herdr no longer lists the pane as recorded, or the TUI exits and leaves a bare shell; a plain Resume closes it just before the fresh Attempt launches. An enlisted Ticket's pane is held while the Ticket still works in it, and, being the operator's, is never closed by anything, Resume included. Introduced by ADR-0027.
_Avoid_: checkpoint pane (the checkpoint is the Interrupt, not where it ran), idle pane, parked pane (a branch is parked; a pane is held)

**Finished terminal**:
A herdr tab the pool opened, for an Attempt or a Conversation, that is still open after its Attempt or Conversation ended or crashed, and is no Live attempt's, Held pane's, enlisted or live Conversation's: a crashed attempt's tab, a done ticket's before its merge, a started Conversation's left open by a Restart and crashed at the next boot. The engine never closes one on its own; the operator closes them all at once from the pool header. Introduced by ADR-0027.
_Avoid_: dead tab (the TUI in it is often still alive), orphan (an Orphan attempt is still running), stale pane

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

**Folder trust**:
claude's per-directory record that someone has vouched for a directory: asked for with a dialog the first time claude is started interactively there, and skipped ever after. The engine vouches for the directories it makes, the pool worktrees, before an Attempt's tab opens; it never vouches for the operator's own checkout, and never withdraws a vouch. Introduced by ADR-0025 (`docs/adr/0025-engine-vouches-for-the-worktrees-it-makes.md`), closing issue #127.
_Avoid_: workspace trust (claude's own name for the dialog; a Pool workspace is a herdr container), permissions (what trust unlocks, not the vouch), trust seed (the act of recording a vouch, not the vouch)

**Blocking dialog**:
A screen a harness puts up before its prompt that holds the Launch until it is answered. The engine answers only claude's Folder trust dialog, by the option's name and never blind; every other Blocking dialog is the operator's to answer, so a Launch that meets one ends as a crash that names the dialog. Not a readiness timeout (the harness is waiting, not wedged) and not an Interrupt (the engine raises those; a harness raises this).
_Avoid_: prompt (the harness's input line), modal, trust dialog (one Blocking dialog among several)

**Attempt ending**:
The observation that an Attempt is over. Headless, that is the harness's child exiting. A Terminal-backed attempt has no child, so its ending is whichever of three forms is observed first: herdr reporting the pane's end, the attempt's exit code landing on disk, or the pane found gone with no exit code behind it, which is a crash. The forms are raced, never ranked, because each is blind where another sees; only the exit code landing does not depend on the daemon still talking to us. Recorded in the fifth amendment to ADR-0014, "Attempts may run terminal-backed in herdr panes".
_Avoid_: exit (one form of an ending, not the ending), timeout (there is none; liveness is the signal), completion (an ending may be a crash), Outcome (the attempt's account of its result; an ending only says it stopped)

**Orphan attempt**:
An Attempt whose engine stopped while it ran. A headless orphan is stopped by the engine: at shutdown when the engine can, or at the next boot when a recorded process is found still alive in the ticket's worktree. A terminal-backed orphan lives on in its herdr pane and is re-adopted at boot instead. The engine never schedules a new Attempt into a worktree an orphan is still writing. Introduced by ADR-0017 (`docs/adr/0017-headless-orphans-are-killed-not-adopted.md`), closing issue #65.
_Avoid_: zombie (a zombie is dead; an orphan is alive and working), leaked process, stray agent

**Merge hold**:
The pool-wide pause the scheduler takes while any ticket is done-but-unmerged. No ready set is computed — nothing new spawns, in any flow that computes one — until every `done` ticket's branch has landed in its merge target or its merge has been rejected. Derived on demand from markers and branches, never persisted; the existing merge-approval interrupt is the signal, and a held ticket's card names where it stands in the Merge queue. Introduced by ADR-0014 (`docs/adr/0014-hold-super-step-until-done-tickets-merged.md`), closing issue #41.
_Avoid_: block (that's a ticket dependency), gate (per-ticket gating was the rejected alternative)

**Merge queue**:
The ordered line of done-but-unmerged tickets the Merge hold is waiting on, in the order the engine takes their merges on. The ticket at the head is the one whose merge is moving: being merged, being resolved by a resolver Attempt, or waiting on the operator at a merge-approval or merge-conflict interrupt. A ticket left waiting on the operator keeps its place while the engine moves on to the next, so more than one ticket can be waiting on the operator at once. Every ticket behind the head is queued, with nothing running on its behalf. A head with no resolver running and no interrupt raised is stalled, which the Console names rather than hides. Derived by the engine alongside the Merge hold, never persisted. Every held ticket's card says which of these it is, and the pool header names the head and the tickets behind it while the hold stands. Amends ADR-0014, closing issue #129.
_Avoid_: merge pending (it hid which of these a ticket was), backlog

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
The Console surface listing every ticket with an unresolved Interrupt — the operator's work queue, shown as a tray with a count. Answered tickets appear greyed until the boundary drains their Queued answers. Each row carries the ticket's Draft answer and can open that ticket's Detail full size to write it; Resume all resumes every resumable row, each with its own Draft answer. The tray is widened by dragging its edge, and reset layout restores it.
_Avoid_: action items, task list, notification center

**Draft answer**:
The operator's note for a ticket's pending Interrupt, typed but not yet sent. One per Interrupt, whichever surface it was typed in: the Needs input tray and the Detail show and edit the same draft. Kept in the browser only; gone once the Interrupt is answered or no longer pending.
_Avoid_: note (the form field, not the thing), Queued answer (that one has been sent)

**Spawn**:
A follow-up ticket an attempt proposes in its Outcome and the engine writes into the pool at the super-step boundary, under the id `<parent-id>-spawn-N`. Ordinary in every way from the moment it lands — it schedules, assigns, verifies, and may itself Spawn. A proposal may say which tickets it blocks: named ones, or all that have not started, never one already running. Bounded by two Spawn caps that are Pool settings: per attempt, and per run, where a run is one Console boot and only Ticket-origin Spawns count. A proposal beyond a cap becomes a Held spawn. The agent proposes; only the engine writes the pool. Introduced by ADR-0010 (`docs/adr/0010-agents-propose-spawn-engine-writes.md`), closing issue #32; caps, holding and blocks by ADR-0029, closing issue #149.
_Avoid_: sub-ticket (no parent-child relationship after writing), dynamic ticket (describes the mechanism, not the thing)

**Held spawn**:
A Spawn proposal a cap had no room for, one the proposing agent marked as overlapping work already in the pool, or one the operator held back, kept for the operator instead of landing. It waits, across restarts, until the operator Adopts it (it lands past both caps) or Discards it (gone for good). Not a Spawn yet: it has no ticket and no id in the pool until it is adopted. A cap of 0 holds every proposal. Introduced by ADR-0029 (`docs/adr/0029-spawn-caps-are-pool-settings-and-hold-what-they-cannot-take.md`); overlap and operator holds by issue #150.
_Avoid_: truncated spawn (nothing is truncated any more), queued spawn (it waits on the operator, not the boundary)

**Pending spawn**:
A Spawn proposal within the caps, waiting for the next super-step boundary to land. Kept across restarts and visible before it lands, to the operator in the Console and to the pool's agents, so a second agent can see the work is already coming. Until the boundary the operator may Hold it (it becomes a Held spawn) or Discard it. Not a Spawn yet: it has no ticket and no id in the pool until it lands. Introduced by issue #150.
_Avoid_: queued spawn (too close to the Merge queue), proposed spawn (a Held spawn is proposed too), draft ticket

**Spawn ledger**:
The one file in a Pool that lists the work it has and the work on its way: every Ticket and Conversation, every Pending spawn and every Held spawn. The engine keeps it current; agents read it before they propose a Spawn, so they do not propose work already listed, and mark a proposal that still overlaps something listed so it is held for the operator. The prompts name where it is and never carry what it says. Introduced by ADR-0029's issue #150 addendum.
_Avoid_: pool index, backlog (it holds running and finished work too), spawn log (the parent's Ticket log records the events; the ledger is only the current state)

**Conversation**:
An open-ended talk between the operator and one agent, living in a Pool beside its Tickets, or before there are any in a Seeded Pool. It has an Assignment fixed at start, its own worktree and branch, and no done condition: only the operator ends it, a Steward excepted. While it runs it may Spawn Tickets and other Conversations, and the engine posts a Turn into it when a Ticket it spawned ends. A Restart does not end it: the engine picks it up again while its pane still runs (ADR-0018's issue #140 amendment). Not a Ticket: a Ticket is one unit of work that must end in an Outcome; a Conversation has no finish line. Introduced toward issue #60.
_Avoid_: chat (too generic), session (a harness's own resumable unit), open-ended ticket (a Ticket must end), handoff (the old file)

**Turn**:
One exchange in a Conversation: something said to the agent, or the agent's reply. The operator types Turns in the herdr tab; the engine types a Turn when a spawned Ticket ends. A Conversation is always either waiting on the operator or working on a Turn.
_Avoid_: message (a chat term), prompt (that is only the first Turn), super-step (that is the engine's round, not the talk's)

**Turn state**:
Which side of its current Turn a Conversation is on: working (the agent is replying) or waiting (on the operator), with the last line the agent showed and, when waiting, since when. Read from the pane by the engine, never reported by the agent. A Notice is delivered only while the Conversation is waiting.
_Avoid_: Turn (that is the exchange itself), idle (the agent waits for the operator; it is not idle), status (that is live, ended or crashed)

**Peek**:
The Console's read-only view of a pane's visible viewport, on the card and in its Detail: what the operator would see in herdr right now, never the scrollback. For a pane the engine already watches for Turn state, the Peek is that watch's last read, so herdr is read once per pane; the engine reads only what the operator sees, because a scrollback read moves the pane under the operator. Amended into ADR-0021 (`docs/adr/0021-enlisted-panes-stay-in-place.md`), closing issue #122.
_Avoid_: terminal (that is the herdr pane itself), preview, tail (the Peek is the viewport, not the last N lines of history)

**Notice**:
The Turn the engine types into a parent Conversation when something it spawned ends: a spawned Ticket's id, title, Outcome and branch, or a child Conversation's branch and the operator's closing line. Queued while the parent's agent is working; delivered when the parent is next waiting on the operator. It informs the parent; it never answers an Interrupt.
_Avoid_: callback, event (that is the lifecycle log), result (an Outcome is the result; a Notice only reports it)

**Steward**:
A Conversation started, or Enlisted, in the role of keeping the Pool's Tickets moving while the operator is away. It is a role, not a new kind of citizen. The engine delivers it every pending Ticket Interrupt as a Notice, and also a stalled Merge queue head. It may answer them as the operator would, except Review and persistence. To answer a checkpoint it may Resume with a note or Keep talking with a message of its own, and it may Close a checkpoint or merge conflict only while the Pool setting "Steward may Close checkpoints" allows it, which is off unless the operator turns it on; closing a deadlocked Ticket stays the operator's. It may also Adopt or Discard Held spawns and Reassign Tickets. Every answer it gives is recorded as the Steward's, with its note. It decides and talks but never does the work itself: it answers, coaches agents, and may Spawn. A Ticket it cannot decide on sensibly, or one that has used up its Steward budget, it leaves to the operator with a Steward note. Conversations are outside its remit: it stewards Tickets, never talks. It watches the whole Pool, and a Pool has at most one Steward at a time. It answers at once; the operator starts one on leaving and ends it on returning, or the Steward ends itself when its orders are done. That is the one way a Conversation ends without the operator. Its Assignment comes from the Pool settings' Steward entry ahead of the pool defaults. It pushes, opens pull requests or merges them only when the operator's own words in that Steward allow it; the engine cannot enforce this.
_Avoid_: admin (suggests permissions or settings), supervisor, overseer, night watch, autopilot (that suggests an engine mode, not an agent)

**Steward budget**:
How many answers the Steward may give one Ticket since the operator last answered that Ticket. It is a Pool setting, 5 unless changed, and reloads like the Spawn caps. The engine refuses a Steward answer beyond it, and the Ticket waits for the operator. The operator's answer resets the count.
_Avoid_: retry limit (Attempts are not what is counted), cap (the Spawn caps bound proposals, not answers)

**Steward note**:
The Steward's recommendation on a pending Interrupt it has left to the operator. It is kept with the Interrupt, survives a restart, and shows on the Needs input row and in the Detail, where the operator can take it as their Draft answer. Leaving the Interrupt to the operator is recorded, so the Steward is not told about it again until it changes. Unlike a Draft answer, the operator did not write it.
_Avoid_: draft (the operator's own words, browser-only), suggestion, Brief (the Brief is the stopped agent's account)

**Enlist**:
The operator's act of making a live herdr pane they opened themselves a Pool citizen, as a Ticket or a Conversation, chosen at that moment and fixed from then on. The pane, its directory and its branch stay as found; the engine claims the pane, teaches its agent the protocol with a Turn, and from then on the result is an ordinary Ticket or Conversation. The engine never closes the enlisted tab, never removes its directory and never deletes its branch. Introduced by ADR-0021 (`docs/adr/0021-enlisted-panes-stay-in-place.md`), closing issue #101.
_Avoid_: adopt (the engine's word for taking in Spawn proposals at the boundary and terminal attempts at boot), import, attach, claim (that is one step of an Enlist, not the act)

**Wire shape**:
The declared shape of one message between engine and Console: the snapshot, a response envelope, a request body. Each is declared once, on the engine side; the Console type-imports it, so drift between the two is a compile error, not a silent copy.
_Avoid_: DTO, schema, contract (all too generic)

## Verification

**Verify**:
Optional per-ticket machinery that checks whether finished Attempt work actually satisfies its ticket, instead of trusting the agent's done-claim. A ticket opts in by setting `verify: N` in its assign block — N parallel Attempts, then grading and Selection. With a Jev key the engine grades each Attempt in code and no grader ticket exists; without a key, one grader ticket per Attempt is the fallback. Absent the key, the ticket runs exactly as it always has. The pool's `verify` skill, written beside AGENT.md at Console setup, holds the grading instructions the fallback grader agent follows.
_Avoid_: verifier node, judge (a judge is a model, not this machinery)

**Grade**:
One assessment of one Attempt: a score (0–10), a verdict (pass or flag), and short reasons. With a Jev key, Jev grades every Attempt in engine code from an engine-owned, versioned rubric, and the Grade records that rubric version, the response's model and its Evidence budget. Without a key the grader agent is the fallback: an ordinary ticket and assignment, so its harness and model are chosen through the normal assign machinery. The grade lands in the graded Attempt's record, visible in the ticket's Detail. With `verify: 1`, a failing Grade becomes the Brief of a checkpoint interrupt.
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
