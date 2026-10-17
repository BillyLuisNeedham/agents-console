# The Factory is an engine-owned recipe, not a skill convention

**Superseded by ADR-0039** (`docs/adr/0039-the-factory-runs-a-plan-the-operator-builds.md`): the Factory now runs a Plan the operator builds, and the fixed run of Stations below survives as the "Factory today" Preset. Still in force from this record: agents never propose the next node, verdicts are typed and a missing one checkpoints "no verdict", Line Tickets are ordinary Tickets, a Line's follow-ups are held by default, Decide writes the report, approving the Finish is the Review, and the Steward never answers the Finish. Gone: the fixed order, Rounds, the layered Factory settings, and Start the Line.

The operator types the same chain into Conversation after Conversation: grill, implement, check it works, review, decide whether to go round again, then report and wait for approval (issue #184 is one symptom). The engine had every piece the chain needs (Spawns, `blockedBy`, drivers, checkpoints, Notices) but no notion of the chain itself. So every hop was an agent choosing to propose the next Ticket, and every loop limit was a number in a prompt it could miscount.

**The engine owns the Factory.** A Factory pool runs one Line, and the Line is a fixed run of Stations: the Grill, a Conversation; then Rounds of Implement, Prove, Review and Decide, each a Ticket. Each Station writes a typed verdict in its Outcome (Prove: pass or fail; Review: its findings; Decide: another Round or the Finish). The engine reads the verdict, keeps the counters and creates the next Station's Ticket, writing its body from the Line's spec and the previous Outcome. Agents never propose the next Station.

**The settings are data, layered.** Each Station's skills, its Assignment and an extra instruction; the Line's two limits (Prove failures per Round, extra Rounds Decide may start); the default Finish; and whether Prove or Review runs at all. All of these sit in the Machine defaults, the Pool settings override them, and the Grill may override any of them for its own Line. The order of the Stations and the routing between them are fixed: a user-defined Station graph was rejected as a graph editor nobody needs yet.

**Starting a Line is the operator's act.** The Grill hands off only when the operator presses Start the Line. That needs the Grill's Line brief, merges the Grill's branch and creates Round 1's Implement Ticket. Ending the Conversation still just ends it.

**Considered Options**: A `my-console-factory` skill that teaches each Station which spawn to propose next. It costs no engine change, but leaves routing and loop counting to agents, puts a Conversation-rooted chain outside the run cap, and gives the Console nothing to show a Line by. The operator chose the engine.

**Consequences**:
- Station Tickets stay ordinary Tickets. Resume, Keep talking, Close and Reassign all work, and closing one halts the Line at a checkpoint.
- A Station whose Outcome carries no valid verdict checkpoints with "no verdict". The engine never guesses which way the Line goes.
- The Steward is on by default in a Factory pool. It may answer the checkpoint a Line raises when Prove has failed too often, or a missing verdict, but never the Finish checkpoint.
- A follow-up proposed from inside a Line, unrelated to the Line's next Station, is always held, because anything that lands merges into the Line's branch. The operator Adopts or Discards it. A Steward may Adopt it only when the operator has explicitly told it to review and allow such follow-ups on their behalf.
- In a Factory pool, approving the Finish checkpoint is the Review: the run-wide Review Interrupt does not fire.
- Decide writes the report into the pool. The Console shows it in place and can open it in a browser.
