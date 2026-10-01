# Spec: the Steward

The domain decisions are settled. Read `CONTEXT.md` (Steward, Steward budget, Steward note, Conversation, Notice, Enlist, Keep talking / Continued attempt, Held spawn, Reassign, Merge queue) and `docs/adr/0030-a-steward-answers-interrupts-while-the-operator-is-away.md` before writing code. Where this spec and those disagree, the glossary and ADR win. Everything below is implementation guidance. Deviate when the code argues for it, and say why in your report.

## Engine

1. **Role.** A Conversation carries an optional `role: "steward"`. It is persisted with the Conversation record (conversations/*.md), survives restart and re-adoption, and is exposed on `ConversationView`. Starting or Enlisting a Steward while one is live is refused with a clear error. An ended or crashed Steward frees the slot.
2. **Start.** Use `POST /api/conversations` with `role: "steward"`, or a sibling route if that is cleaner. Its `opening` is the operator's standing orders. Enlist (`POST /api/enlist`) accepts `becomes: "steward"`, which ends up as a Conversation with the role.
3. **Assignment.** Add `steward: { budget?: number, assign?: {harness, model, effort, drivers} }` to console.json. Resolve the Steward's start Assignment as: request assign, then `steward.assign`, then the pool defaults. Validate and reload it with the assignment slice and the Spawn caps (Config reload, all or nothing). The budget defaults to 5 and must be a positive integer.
4. **Teaching.** `buildStewardTeaching` (next to `buildConversationTeaching` in engine/prompt.ts) teaches the Conversation protocol, plus:
   - load the new `my-console-steward` skill;
   - the command it answers with (point 6);
   - its budget;
   - the review/persistence exclusion;
   - "decide and talk, never do the work: no edits in ticket worktrees";
   - "you may push / open PRs / merge PRs only if the operator's own words in this pane allow it";
   - how to leave an Interrupt with a Steward note;
   - how to end itself.

   Enlist teaching of a Steward uses the same text.
5. **Notices to the Steward.** While a Steward is live, queue a Notice for:
   - each pending Ticket Interrupt it has not been told about and has not left. Exclude review, persistence, and Interrupts on Conversation ids. Include the kind, ticket id and title, the Brief or body, the allowed answers, whether Keep talking is possible, and the budget remaining.
   - a stalled Merge queue head, once per stall.

   On Steward start and re-adoption, deliver everything pending. Derive "told" in memory, so a restart re-delivers. "Left" is persisted with the Steward note. An Interrupt raised again (a new raise) counts as new. Batch several pending items into one Notice Turn when they are delivered together. Reuse the existing Notice queue: deliver only while waiting.
6. **Agent-facing command.** Add a thin CLI (for example `engine/steward-cli.ts`, run as `bun <engine>/steward-cli.ts <verb> ...`). The teaching names its exact invocation and the pool's URL. It wraps HTTP routes that take the Steward's conversation id; the server checks that id against the live Steward. Verbs:
   - `answer <ticket> resume|approve|reject [note]`: the same `answer()` path the Console uses. Refuse review and persistence. Refuse beyond the budget.
   - `keep-talking <ticket> <message>`: Keep talking, then the engine types the message after its teaching Turn. Counts against the budget.
   - `leave <ticket> <note>`: records the Steward note on the pending Interrupt (persisted, survives restart), and marks it left. Doesn't count.
   - `held adopt|discard <proposal-id>`.
   - `reassign <ticket> field=value...`: the same rules as `PUT /api/reassign`.
   - `state`: a compact read of pending Interrupts, the Merge queue, held and pending spawns, and the budget per ticket. The agent may also read pool files directly.
   - `end [closing line]`: the Steward ends itself, as an operator End would, closing line included.
7. **Attribution and budget.** Answers, Keep talks, adopts, discards and reassigns by the Steward carry `by: "steward"` (plus the conversation id) in the events they write, and the Ticket log renders them as the Steward's. Budget used per ticket = Steward answers and Keep talks on that ticket since the operator last answered it, derived from the Ticket log events. That makes it persistent for free. Leaves, adopts, discards and reassigns don't count. The operator answering resets it.
8. **Steward note.** Persisted on the pending Interrupt, or in a small store keyed by the Interrupt's raise, whichever survives restart more simply. It is on the snapshot's interrupt, and cleared when the Interrupt is answered or re-raised.
9. **Snapshot / wire shapes.**
   - `conversations[].role`;
   - `interrupts[].stewardNote` (text, at);
   - per-ticket Steward budget used and remaining (or enough to derive it);
   - `steward` in the pool settings wire shape;
   - an answer's `by` in the Ticket log events.

   Declare them once on the engine side (Wire shape rule).
10. **Skill.** Add `skills/my-console-steward/SKILL.md`, written for agents (see the writing-for-agents conventions in the other skills):
    - how to judge each Interrupt kind sensibly: read the Brief, the Ticket file, the diff and the Ticket log;
    - prefer Keep talking to coach when the pane is alive and the fix is a nudge, and Resume with a note when a fresh start is better;
    - approve a staged merge resolution only after reading it;
    - for crashes, resume, but after two crashes on one Ticket consider Reassign or leaving it;
    - for config, Reassign to a sensible Assignment, then resume;
    - for selection, pick by grades;
    - leave product decisions and anything destructive or irreversible to the operator, with a recommendation;
    - push/PR only if told;
    - never edit worktrees; Spawn fix-ups within the caps;
    - end itself when its orders are done.

    `skills/link.sh` must pick it up (check it links every dir). Mention the Steward in `my-console-citizen` only as far as needed.

## Console (UI)

- **Start Steward:** an action near where Conversations are started, with a standing-orders textarea and an optional Assignment override defaulting to the Steward entry. It is disabled with a reason while a Steward is live.
- **Enlist dialog:** a third choice, Steward, disabled while one is live.
- **Steward's card:** visibly marked as the Steward. The pool header says a Steward is on duty, linking or focusing to its card.
- **Needs input row and Detail:** show the Steward note when there is one, plus a "Use as answer" action that copies it into the Draft answer. Show the Steward budget used/remaining on the ticket's Detail when the Steward has answered it.
- **Ticket log:** Steward-made answers read as the Steward's, with the note.
- **Pool settings:** the Steward budget and the Steward Assignment fields, saved through the existing settings save and reload path.

## Tests

Engine:
- role persistence;
- one-Steward refusal;
- Notice queueing and backlog on start and re-adoption;
- exclusions;
- the stalled-head Notice;
- answer attribution;
- budget refusal and reset by operator answer;
- the leave note persisting across restart;
- end by the Steward;
- the assign resolution order;
- config validation and reload.

UI: projection/state tests in the existing style (no DOM in bun tests). The full suite must be green: `PATH="$HOME/.bun/bin:$PATH" bun test` (~3.5 min; run in the background, output to a file), plus `bun run typecheck`.
