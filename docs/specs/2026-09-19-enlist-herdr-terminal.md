# Enlist: a herdr terminal the operator opened becomes a Ticket or a Conversation in a running Pool

Closes issue #101 (https://github.com/BillyLuisNeedham/agents-console/issues/101).

Decided through a grill on 2026-09-18 and the prototype at `prototype/enlist-herdr-terminal/`
(variant F, "Enlist as Ticket or Conversation", is the one Billy picked; A to E are the
alternatives he passed over and are listed under Out of Scope).

## Problem Statement

Billy often opens a claude or opencode terminal in herdr by hand, in the pool's repository,
and talks to the agent for a while before it is clear that the work matters to the pool:
other tickets should wait on it, its branch should merge the way ticket work merges, or the
talk should be able to Spawn tickets and hear back when they end. Today there is no way in.
The engine only knows panes it opened itself, the Console's peek and focus routes rely on
that, and the only things that add to a running pool are an agent's Spawn proposals. So the
work either stays outside the pool, invisible on the canvas and unmergeable through it, or
Billy re-types the whole context into a New Conversation and abandons the terminal he was
already in.

## Solution

One new operator action in the Console, **Enlist**: pick a live herdr pane and make it a Pool
citizen without leaving the terminal it is in. The Console header gains an "Enlist terminal"
button beside New Conversation (only on a Terminal-backed pool). It opens a picker of the
panes herdr's agent list reports, read by the pool server over the herdr socket. Panes that
cannot be enlisted are shown greyed with the reason rather than hidden: not a checkout of
this pool's repository, no harness the engine knows, or already owned by the engine.

Picking a pane opens a form headed by a **Becomes** switch: **Ticket** or **Conversation**,
decided at enlist time and fixed from then on.

- As a **Ticket** it has an end: the operator gives it a title and a spec, chooses which
  unfinished tickets will wait on it, and the engine writes its Ticket file with the attempt
  already in progress. The ticket ends the ordinary way, when its agent writes an Outcome,
  and its branch merges through the existing merge-approval and Merge hold machinery.
- As a **Conversation** it has no finish line: title, an optional opening Turn, and nothing
  may wait on it (ADR-0018 stands). It may Spawn, receives Notices, and merges when the
  operator ends it.

Either way the work stays **in place**: the pane, its working directory and its branch are
recorded as found, never re-homed. The engine claims the pane the way it claims the panes it
spawns (agent identity in herdr's sidebar, the tab relabelled `<id> · <title>`), types a
teaching Turn so the agent learns the protocol it was never launched with, and from then on
the card is an ordinary card. The one thing the engine never does to an enlisted pane is
close it: the tab was the operator's before it was the pool's, and it stays theirs after.

## User Stories

1. As a Console operator, I want a list of the live herdr terminals on this machine, so that I can pick the one I have been talking in without typing pane ids.
2. As a Console operator, I want each listed terminal to show its harness, whether it is idle or working, its title, its directory and its branch, so that I can recognise the right one at a glance.
3. As a Console operator, I want terminals that cannot be enlisted shown with the reason instead of silently missing, so that I learn why (wrong repository, unknown harness, already in the pool) rather than wonder whether the list is broken.
4. As a Console operator, I want to decide at enlist time whether the terminal becomes a Ticket or a Conversation, so that one entry point covers both "this is work others wait on" and "this is a talk I want in the pool".
5. As a Console operator, I want a one-line reminder of the difference beside the switch, so that I pick the right kind without re-reading the glossary.
6. As a Console operator enlisting a Ticket, I want to give it a title and a spec, with the title prefilled from the terminal's own title, so that the Ticket file reads like any other ticket's.
7. As a Console operator enlisting a Ticket, I want to tick which unfinished tickets will wait on it, so that the dependency lands on the canvas as an edge the moment I submit.
8. As a Console operator enlisting a Ticket, I want done tickets excluded from that list, so that I cannot express a dependency that can never take effect.
9. As a Console operator enlisting a Conversation, I want the form to say plainly that a Conversation cannot block a Ticket and point me back to Ticket if other work must wait, so that I do not discover the rule after submitting.
10. As a Console operator, I want the pane's directory and branch used as found, so that the agent keeps every file it has open and every commit it has made.
11. As a Console operator whose terminal is on the merge target branch, I want the engine to create the pool branch there before enlisting, so that the work has a branch to merge from and my uncommitted changes come with it.
12. As a Console operator whose terminal is already on a feature branch, I want that branch used as the ticket's branch, so that nothing about my checkout changes.
13. As a Console operator, I want the enlisted terminal's agent taught the pool's protocol (its id, its Ticket file, how to write an Outcome, how to Spawn) as a Turn in the pane, so that the ticket can end the ordinary way instead of only by the tab closing.
14. As a Console operator, I want that teaching Turn typed only when the agent is waiting on me and queued while it is working, so that it never lands in the middle of the agent's reply.
15. As a Console operator enlisting a Conversation with an opening Turn, I want the opening Turn typed after the teaching, so that the agent is briefed before it is asked anything.
16. As a Console operator, I want the enlisted card to appear immediately, in progress, with its edges, so that the pool reflects the new work without a restart.
17. As a Console operator, I want the enlisted card to show its harness and read "as found" where the model would be, so that I can tell an enlisted attempt from one the engine launched.
18. As a Console operator, I want peek and "Open in herdr" to work on the enlisted card, so that an enlisted pane is as reachable as a spawned one.
19. As a Console operator, I want herdr's sidebar to show the enlisted pane under the pool's agent identity, working or blocked as its Turn state says, so that the pool's tabs read the same whether the engine or I opened them.
20. As a Console operator, I want the enlisted tab relabelled with the pool id and title, so that I can find it among my tabs the way I find spawned ones.
21. As a Console operator, I want the enlisted Ticket to end when its agent writes an Outcome, so that done, checkpoint and Spawn all work as they do for any ticket.
22. As a Console operator, I want a done enlisted Ticket to hold the pool and merge through the usual merge approval, so that its branch lands the way every other branch lands.
23. As a Console operator, I want tickets that waited on the enlisted Ticket to become runnable once it has merged, so that the dependency I drew means what it means everywhere else.
24. As a Console operator, I want an enlisted Conversation to Spawn tickets and receive Notices, so that enlisting loses none of what a New Conversation can do.
25. As a Console operator, I want to end an enlisted Conversation from the Console and have its branch merge, so that ending is the same gesture as for any Conversation.
26. As a Console operator, I want the engine to leave my checkout where it is after a merge, never removing the directory or deleting the branch, so that enlisting never destroys a working tree I made.
27. As a Console operator, I want the engine to never close an enlisted tab, on ending or on End, so that the terminal I opened is still there when the pool is done with it.
28. As a Console operator, I want closing an enlisted tab after its Outcome to count as a trailing exit, not a crash, so that tidying my tabs does not fail a finished ticket.
29. As a Console operator, I want closing an enlisted Ticket's tab before its Outcome to land the ticket in a checkpoint that says the pane went and the branch is kept, so that I decide what happens next rather than the engine re-running blind.
30. As a Console operator, I want an enlisted Conversation whose pane goes to be recorded crashed with its branch kept, exactly as a spawned Conversation would, so that the two kinds of Conversation fail the same way.
31. As a Console operator, I want a restart of the pool server to re-adopt a live enlisted pane, so that enlisting survives the engine the way spawned terminal attempts do.
32. As a Console operator, I want an enlist that fails (pane gone between picking and submitting, teaching Turn never landed, branch could not be created) to leave no Ticket file, no Conversation file and no branch behind, so that a failed enlist is invisible afterwards.
33. As a Console operator, I want the picker to refuse a pane whose directory is not a checkout of this pool's repository, so that the hermetic-pool rule holds without me policing it.
34. As a Console operator, I want the picker to refuse a pane the engine already owns, so that one pane is never two attempts.
35. As a Console operator, I want the Enlist button absent on a headless pool, so that I am never offered an action the pool cannot perform.
36. As a ticket agent that was enlisted, I want to be told my ticket id, where my Ticket file is and how to write an Outcome, so that I can finish like any other ticket agent.
37. As a Conversation agent that was enlisted, I want the same Spawn teaching a started Conversation receives, so that I can propose tickets and hear back.

## Implementation Decisions

- **Vocabulary.** *Enlist* is the operator's act of making a live herdr pane a Pool citizen; added to `CONTEXT.md`. "Adopt" stays reserved for the engine's two existing adoptions (Spawn proposals at the boundary; terminal attempts at boot). Everything that results from an Enlist is an ordinary Ticket or Conversation; there is no "enlisted ticket" kind.
- **Discovery lives on the server, never in the browser.** The pool server reads herdr's `agent.list` over the socket on request and returns a panes response envelope; the Console never speaks to herdr. The picker fetches on open, not through the snapshot: pane lists are ephemeral and not pool state.
- **Eligibility, evaluated by the engine, reported with reasons.** A pane is enlistable when: its harness (herdr's agent label) is one the engine has a descriptor for; its directory is a checkout of the pool's repository, meaning it shares the pool's git common directory (a worktree or the main checkout both qualify); and no live attempt or Conversation already holds its pane id. Ineligible panes are returned with a reason string and rendered greyed, never dropped.
- **Becomes is fixed at enlist time.** The enlist request body carries `becomes: "ticket" | "conversation"` plus the fields for that kind. There is no conversion afterwards.
- **In place, as found.** The record stores the pane id, the harness, the harness's session id as herdr reports it, the directory and the branch found. The Assignment is recorded as found: harness known, model and drivers unknown, and the card shows "as found" where the model would be. Config reload never touches it (an Attempt's Assignment never changes in flight, ADR-0018).
- **Branch rule.** If the found directory is on the merge target branch, the engine creates `pool/<pool>/<id>` at its HEAD and checks it out there before writing anything; a checkout at the same commit carries uncommitted changes with it. If it is on any other branch, that branch is the ticket's branch as found. The engine records which happened on the ticket log. The engine never removes the found directory and never deletes the found branch, at merge or at any other time; those two behaviours belong to pool worktrees only.
- **Ticket ids.** The engine mints `enlist-N`, N counting per pool across the run, a reserved namespace beside `-spawn-N` and `-grader-N`: hand-written tickets may not use it, and the card is identifiable as enlisted work at a glance.
- **Ticket file.** Written by the engine, as `writeSpawnTicket` writes a Spawn: line-1 marker with `status=in-progress` from the first moment (the attempt is already running), an empty `blocked-by`, the operator's title and spec, and a provenance paragraph naming the pane, directory, branch and harness session it was enlisted from. Only the engine writes the pool (ADR-0010).
- **"Blocks" is written onto the other tickets.** The form's tick list is every ticket not yet done. Submitting adds the new id to each ticked ticket's `blocked-by`, an engine write with no prior art: a small pure operation beside the Spawn writer that rewrites one marker line and re-reads markers, applied at the same point Spawn adoption re-reads the pool. It carries the meaning `blocked-by` already has (the next Attempt of that ticket is not planned until the blocker is done and merged) and nothing more. The enlisted Ticket has no `blocked-by` of its own: it is already running, so gating its start is meaningless.
- **Registration mirrors boot re-adoption.** A Ticket enlist registers a Live attempt on the found pane with no tab of its own, exactly as `adoptTerminalAttempt` registers a re-adopted attempt, then records a `scheduled` and a `spawned` event carrying the pane id so the events file is the same shape as any terminal-backed attempt's and boot reconciliation re-adopts it after a restart without special casing. A Conversation enlist registers a Conversation runtime on the found pane the way `start` does after its launch, skipping the launch.
- **Teaching Turn.** The engine types a Turn into the pane through the Notice delivery path: only while the pane's Turn state is waiting, queued while it is working. The Ticket teaching names the ticket id, the Ticket file of record, the Outcome contract (done or checkpoint with a Brief, optional Spawn) and where to commit (the found branch). The Conversation teaching is the one a started Conversation gets, followed by the opening Turn if given. Turn state is read from the pane for enlisted Tickets as it is for Conversations.
- **Attempt ending for an enlisted Ticket** is raced between two of the three forms: the Outcome landing and the pane found gone. There is no wrapper, so no exit-code file and no Stream file; the Ticket log holds lifecycle events only, and Vitals read the found directory's diff. Pane gone after the Outcome is a trailing exit. Pane gone before the Outcome ends the attempt in `checkpoint` with a Brief saying the pane went and the branch is kept; the operator's answer re-runs the ticket as an ordinary engine-launched attempt. An enlisted Conversation whose pane goes is `crashed`, branch kept, as ADR-0018 says.
- **Verify is ignored** for an enlisted Ticket: a `verify: N` assign entry has nothing to run N of, since the one attempt is already in flight. Logged once at enlist.
- **herdr side.** On enlist the engine reports agent identity on the pane under the pool's source, as it does for spawned panes, and relabels the tab `<id> · <title>` with the same cap the spawn label uses. The tab stays in whatever herdr workspace it is in; it is not moved into the Pool workspace. On ending or End the engine releases the agent identity and leaves the tab open. Every herdr call here is best effort, as ADR-0015 already has it.
- **The spawned-only guarantee becomes engine-registered.** Peek and focus resolve a pane from the snapshot's live attempt or Conversation view, as today; registration is the allowlist, whether the engine opened the tab or the operator enlisted it.
- **Failed enlist leaves nothing.** Pane not found or not idle-readable at submit, teaching Turn undeliverable within the same bounded wait a Launch uses, or branch creation failing: the engine unwinds (no Ticket or Conversation file, no `blocked-by` edits, no branch, agent identity released) and the route answers with a reason in the same 409 envelope the Conversation start route uses.
- **Wire shapes**, each declared once on the engine side and type-imported by the Console: the panes response (pane id, harness, status, title, directory, branch, eligible or reason), the enlist request body, and the enlisted card's "as found" marker on the existing ticket and Conversation views.
- **Console.** Header button "Enlist terminal" beside New Conversation, present only when the pool is Terminal-backed. A picker modal, then the form with the Becomes switch re-rendering in place, both owned by one session store the way the Conversations tray is, with a pure projection of panes to picker rows and of the pool to the "Blocks" tick list. The prototype's reducer settled the form's shape; the decision-rich part is the switch:

  ```
  becomes = "ticket"       → fields: title, spec, blocks[], branch
  becomes = "conversation" → fields: title, opening?, branch    (no blocks: ADR-0018)
  branch  = found on merge target ? create pool/<pool>/<id> here : use as found
  ```

  (from the prototype's variant F).

## Testing Decisions

- A good test drives the feature from the outside and asserts what the operator or the next agent would see: files on disk, events in the Ticket log, requests herdr received, rows the Console would render. Nothing asserts on helper names or call order.
- **Seam 1, the pool server over HTTP against the executing fake herdr.** One suite in the server tests, built on the existing Conversation-route fixtures (git-backed temp pool, `terminal: herdr`, the readiness-free harness). The executing fake gains `agent.list` in its one shared definition, never a fourth inline copy. Cases: the panes route lists eligible and ineligible panes with reasons; enlist as Ticket writes the `enlist-1` file in progress with provenance, adds `enlist-1` to the ticked tickets' `blocked-by`, records events carrying the pre-existing pane id, sends no `tab.create`, reports agent identity and relabels the tab, types the teaching Turn only once the pane is waiting; Outcome landing ends the attempt done and the merge goes through approval; pane gone before the Outcome lands the checkpoint with the branch kept; enlist as Conversation writes its file, types teaching then opening, Spawns and receives a Notice, and End merges the found branch without closing the tab or removing the directory; a pane on the merge target gets the pool branch created in place; an ineligible pane is refused with its reason; a restart re-adopts a live enlisted pane; a failed enlist leaves no files, no edits and no branch.
- **Seam 2, the Console's DOM-free stores and projections.** The enlist store tested the way the Conversations tray is (injected handlers returning hand-settled deferreds, so in-flight order is pinned), covering: picker fetch, ineligible rows kept and greyed, the Becomes switch re-rendering the draft, submit sending only the fields for the chosen kind, refusal text surfaced from the 409 reason. The pure projections tested literal-in, rows-out beside the Conversations tray projection: panes to picker rows, pool to the "Blocks" tick list (done excluded), and the "as found" card marker.
- **One pure unit** for the `blocked-by` edit, beside the Spawn writer's tests: rewriting one marker line adds the id, preserves the rest of the file byte for byte, and is a no-op for an id already present.
- Prior art: the Conversation round trip through the HTTP routes; the boot re-adoption tests (a pane the engine did not open, `tab.create` count zero, exit landing later); Spawn adoption's on-disk marker assertions; the Conversations tray harness and the projection suite.

## Out of Scope

- Converting an enlisted Ticket to a Conversation or back after enlist.
- Re-homing (prototype variant C): relaunching the harness with its session id in a fresh pool worktree. In place was chosen.
- Self-enlist from inside the terminal (variant D) and drag-from-a-tray (variant E). One Console entry point was chosen.
- A standalone Console route or UI for editing any ticket's `blocked-by`. The engine gains the operation; only the enlist form uses it.
- `blocked-by` on the enlisted Ticket itself, and any new "merge waits on blockers" semantics for in-progress tickets.
- Moving the enlisted tab into the Pool workspace.
- Enlisting a pane outside the pool's repository, or one whose harness the engine has no descriptor for.
- Verify, grading and Selection on an enlisted Ticket.
- A derived attempt log for an enlisted attempt (no Stream file exists; the Ticket log holds lifecycle events only).
- Headless pools: Enlist requires `terminal: herdr`.
- Terminal managers other than herdr.

## Further Notes

- The grill's recommendations that Billy did not answer separately are recorded above as decisions, since he chose the prototype that embodies them: Ticket or Conversation chosen at enlist time; in place; the teaching Turn; "blocks" only; a Console picker; the term Enlist. Two were narrowed from the recommendation to the prototype's behaviour and can be widened later: the `blocked-by` edit is not exposed as a general route, and the prototype's "already running, only its merge would wait" flag on in-progress tickets is dropped because it implied merge semantics the engine does not have.
- Two things the prototype glossed that the implementation must not: herdr does not report the model, so "as found" really means unknown; and herdr reports a directory, not a branch, so the engine resolves the branch itself with git in that directory.
- Related open issues: #74 (restart orphans a live Conversation's pane), #86 (headless and interactive in one session), #87 (re-adopted terminal attempt's merge), #93 (talk to the agent in checkpoints). The enlisted-Ticket crash path leans on the same checkpoint shape #87 and #93 touch.
- The prototype's five discarded variants remain the primary source for why F; per the prototype skill they ride to a throwaway branch, not main.
