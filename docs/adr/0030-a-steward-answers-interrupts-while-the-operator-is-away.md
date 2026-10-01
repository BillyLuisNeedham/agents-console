# A Steward answers Interrupts while the operator is away

Pools left running overnight stall quietly. A checkpoint waits for an answer. A merge Interrupt sets the Merge hold, and that stops every Ticket in the Pool. Operators tried leaving a Conversation in charge, but its teaching says it "cannot answer either one's own Interrupt", and ADR-0018 deliberately left open whether a parent's agent may answer a child's Interrupt. This ADR closes that question for one role.

**A Steward is a Conversation in a role, not a new kind of citizen.** It is started from the Console with the operator's standing orders as its opening Turn, or Enlisted as a Steward. From then on it has everything a Conversation has: a pane, Turn state, Notices, Spawn, and survival across a Restart. ADR-0018 refused to make a Conversation a kind of Ticket because every Ticket invariant would need an exception. A third citizen kind would repeat that cost for a citizen whose life is a Conversation's in every respect but its teaching and its powers. A Pool has at most one live Steward, and it watches the whole Pool, because two agents answering the same Interrupt would race. Narrower scope ("only the next super-step") goes in its orders, not into the model.

**Interrupts are pushed to it.** While a Steward is live, the engine delivers every pending Ticket Interrupt as a Notice, through the same queue that delivers a Notice only while the agent is waiting. When a Steward starts or is re-adopted, every Interrupt already pending is delivered. A stalled Merge queue head raises no Interrupt, but it is delivered too, because it is the commonest overnight freeze. The Steward does not poll. Conversations' own waits are not Interrupts and are outside its remit: it stewards Tickets.

**It answers on the operator's path, and every answer is marked as its own.** The Steward has an agent-facing command onto the same answer path the Console uses. It may answer every kind of Interrupt except two:
- review, which is by definition the operator's final judgement;
- persistence, which is an engine store failure.

To answer a checkpoint it may Resume with a note, or Keep talking with a message the engine types after its teaching Turn. It may also Adopt or Discard Held spawns and Reassign Tickets. Every answer is recorded as the Steward's, with its note, so the Ticket log shows the operator next morning what was decided and why. The Steward decides and talks, but never does the work itself. Its only ways to change the code are an answer, a coaching message and a Spawn.

**A budget the engine enforces bounds it.** The Steward budget (a Pool setting, 5 unless changed, reloaded at the boundary like the Spawn caps) is how many answers it may give one Ticket since the operator last answered that Ticket. The engine refuses an answer beyond it. A prompt-only limit was rejected: a checkpoint-resume loop is exactly the failure that runs all night, and the prompt is what that loop has already stopped heeding.

**When it cannot decide, it leaves the Interrupt with a Steward note.** The note is its recommendation, kept with the Interrupt across restarts and shown in Needs input. The operator can take it as their Draft answer. Draft answers stay browser-only and the operator's own words. Leaving an Interrupt is recorded, so the Steward is not told about it again until it changes.

**Push and pull-request rights are granted in prose.** A Steward may push, open pull requests or merge them only when the operator's own words to that Steward allow it. The engine does not enforce this, and cannot: the agent has a shell. A Pool setting for it was rejected because it would duplicate what the operator says when starting the Steward, and it would suggest an enforcement that does not exist.

**It may end itself.** When its orders are done ("watch the next super-step, then finish"), the Steward ends itself with a closing line. This is the one exception to "only the operator ends a Conversation".

**Its Assignment** comes from a Steward entry in the Pool settings, ahead of the pool defaults, the way the resolver pins its own. Judgement work usually wants a different model from building.

**Rejected:** an engine-side unattended mode answering Interrupts by rule or by Jev. It cannot read a Brief and coach the agent that wrote it, which is most of what an overnight checkpoint needs.

**Consequences:** ADR-0018's deferral is settled for the Steward only. Other Conversations still cannot answer Interrupts. The Console's HTTP API is still unauthenticated. The Steward's command names its Conversation id, and the engine checks that id against the live Steward to attribute answers and enforce the budget. That check is an attribution check, not a security boundary.
