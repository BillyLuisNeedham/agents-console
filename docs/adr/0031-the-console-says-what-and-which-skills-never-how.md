# The Console says what to build and which skills to use, never how to work

A ticket agent was told how to work from three places (issue #155, https://github.com/BillyLuisNeedham/agents-console/issues/155). The engine half of `AGENT.md` cast it as an **orchestrator**: delegate the reading and the mechanical work to subagents, write the substance yourself, use the read-only subagents freely and early. The glued prompt told it to "dispatch these subagents in this order, one at a time" for the tail of a chain, and added a subagent roster from the pool's `roster` setting. The pool's `agents` setting went to claude as `--agents` JSON, so the roster the prompt promised existed on claude.

We decided that **the Console tells an agent what to build and which skills to use, and never how to work.** The ticket is the spec. The drivers are the skills: the first is still the slash command the prompt opens with, and the rest are named in the prompt as skills to use, in order, once the driver's work is done. There is no orchestrator stance, no subagent roster and no delegation instruction anywhere the engine writes. Whether an agent uses subagents, and which, is its own choice.

The reasons:
- Models now choose their own method well, and fit it to the ticket: whether it needs any delegation at all, and of what. A fixed stance and a fixed roster take that choice away.
- The prescriptions went stale. They were written for the models of the day, and each new model made them more wrong. Text in the engine half of `AGENT.md` reaches every pool, so stale advice there has a wide reach.

**`roster` and `agents` are removed**, from the Boot interview, the pool config, Pool settings, Setups and the `--agents` flag. A config, Setup or Machine defaults file that still holds either key is read as if it did not, with no warning and no refusal, and the key is dropped the next time that file is written. A user's own harness agents are untouched: claude still loads whatever `~/.claude/agents` defines, and opencode and cursor their own config, because the Console no longer passes anything in their place.

**Boot refreshes the engine half of `AGENT.md`.** Everything above the CONFIG marker is the engine's and was copied once, at pool creation, so an old pool would have taught the orchestrator stance for as long as it lived. Every Boot, a Restart's included, now rewrites that half from the current template and keeps the pool's half below the marker byte for byte. An `AGENT.md` with no marker is left alone, because nothing says where its engine half ends.

Two alternatives were rejected:
- **Keeping `roster` and `agents` as a neutral, optional offer.** Even phrased as "these agents are available", a roster in the prompt is a hint about method, and the Console would keep a setting whose only purpose is to steer how the work is done. An operator who wants particular agents defines them in the harness's own config, where every session sees them, not only the Console's.
- **Only rewording the prompt and the template.** Softer wording would leave the settings and the flag in place, still feeding a roster into the prompt and into claude, and the next model would make the softer wording stale in turn.

The grader, head-to-head and verify prompts, the resolver's, the Steward's and the Conversations' are out of scope: none of them prescribed a method this way.
