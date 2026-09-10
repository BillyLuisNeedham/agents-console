# Conversations (issue #60)

Shared understanding reached in grill session 2026-09-10. Glossary terms in CONTEXT.md: Conversation, Turn, Notice. Decision record: docs/adr/0017-conversations-beside-tickets.md.

## The thing
A Conversation is an open-ended talk between the operator and one agent. Lives in a Pool beside Tickets. Assignment fixed at start, own worktree and branch, no done condition. Not a Ticket.

## Starting
- Console form: title, optional opening Turn, Assignment (harness/model/drivers; defaults from pool).
- Or as a Spawn from another Conversation.
- Requires a terminal-backed pool (`terminal: herdr`); refused with a clear reason otherwise.
- Engine opens a named herdr tab (same naming as attempts), runs the harness as interactive TUI under `script`, types the opening Turn with echo verification (reuse ADR-0016 machinery).
- No CLI in v1.

## Talking
Operator types in the herdr tab. Console shows read-only peek. No Console-side input in v1.

## Spawning (mid-Conversation)
- Agent may propose Spawns while the Conversation runs (not only at Outcome). Proposal shape as ADR-0010 `{ title, body, blockedBy?, kind?: 'ticket' | 'conversation', assign? }`.
- `assign` optional; absent → inherit parent Conversation's Assignment.
- `blockedBy` may name only Tickets; entries naming a Conversation are dropped and logged.
- Spawns run at once, no approval interrupt.
- Caps: 5 per proposal; no run-wide cap for Conversation Spawns.
- Ids: `<conversation-id>-spawn-N`.
- Agent proposes; engine writes. Proposal channel: file the agent writes in its worktree, polled by the engine.

## Notices (coming back)
- When a spawned Ticket ends: Notice = id, title, Outcome (done / checkpoint + Brief), branch, diff summary.
- When a child Conversation is ended by the operator: Notice = child's branch + operator's optional closing line.
- Queued while the parent's agent is working; delivered (typed into the pane) when the parent is next waiting on the operator.
- Notice informs only. Operator still answers Interrupts. Parent's agent cannot answer a child's Interrupt.
- Orphaned (parent ended) or queued-at-End Notices are dropped and logged in the child's ticket log.

## Turn state
- Detected from the harness's idle prompt (readyPattern). Conversation is always `working` or `waiting` (on the operator).

## Seeing them all
- Canvas: Conversations in their own lane above tickets, edges to what they spawned. Card shows turn state, last line said, idle age.
- Conversations tray: list sorted waiting-on-you first, then longest idle.
- Needs input includes Conversations waiting on you.
- No limit on count.

## Ending
- Only the operator ends: End on card, End in Detail, or closing the herdr tab.
- Branch with commits → existing merge-approval interrupt into pool merge target; conflicts → merge-resolver.
- Tab closes after merge/rejection, as for tickets.
- Children keep running; parent is only their origin.
- Crash (pane lost without End): Conversation marked crashed, branch kept, no resume in v1.
- Conversations never hold the scheduler (no Merge hold participation), never verified/graded.

## Not in v1
Persistence/resume, Conversation inside an existing Ticket's worktree, Console-side typing, wayfinder integration, agents answering Interrupts, Verify on Conversations.
