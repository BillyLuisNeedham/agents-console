# Effort is the harness's own word, and a harness that can't take it launches without it

The Console chose a model per Attempt but never how hard that model thinks, so every agent ran at its harness's default effort (issue #144, https://github.com/BillyLuisNeedham/agents-console/issues/144). We made **Effort** (CONTEXT.md) a fourth, optional field of the Assignment beside harness, model and drivers. It layers field-wise the way model does (ADR-0013, ADR-0018): a ticket's assign entry, then the build or parent ticket it inherits from, then the pool defaults. It belongs to the Attempt and reloads at the boundary. It is set wherever model is set: console.json, Machine defaults, Setups, Pool settings, Reassign and a Conversation's start. An unset effort passes no flag, so the harness's own default applies, and it never raises a Config interrupt (ADR-0022): a missing effort is not a gap.

**Values are the harness's own words, passed through verbatim.** claude takes `--effort low|medium|high|xhigh|max`, and opencode's `run` takes `--variant` with names of its own such as `minimal`. The scales do not line up: claude has levels opencode lacks and the reverse. The Console already treats a model name as belonging to one harness, which is why the resolver can pin its own model. Effort follows the same rule. A Console-wide scale translated per harness was rejected: every translation would be a guess, it would hide the harness's extremes, and it would need updating whenever a harness changes its levels. The inputs suggest each harness's known values but accept anything.

**A harness that cannot take an effort launches without it.** The opencode TUI has no effort flag, cursor's `agent` has none either (effort there lives inside the model string), and a custom harness may have none. Each harness descriptor says whether it can take effort. When it cannot, the Attempt launches as if no effort had been set, and the card and Detail show the effort as not applied. Two alternatives were rejected:
- Refusing, or pausing the ticket on a Config interrupt, would stop real work over a preference.
- Writing the effort into cursor's model string would make the Console rewrite a value the operator typed.

An operator who wants cursor effort writes it into the model themselves.

**Only the resolver has an effort of its own**, beside its own model, falling back the way its model does. Graders, head-to-head and spawned tickets inherit effort exactly as they inherit model. A per-role knob, such as "graders run at low", was rejected for now: Reassign already overrides a single ticket, and a role-level setting would be a second layering system beside the Assignment's.

Enlisted panes run as found, so effort never applies to them. Jev's judgement model is not an agent's harness and is out of scope.
