# Spec: a model belongs to one harness (issue #37)

## Objective

A model name (and an effort word) is one harness's own vocabulary. Today the engine copies `defaults.model` onto a unit whose harness came from somewhere else, so a mixed-harness pool launches `claude --model auto`, Claude Code rejects it, and every conflict falls to the manual path. The failure only shows in `runs/NN.resolver.log`.

Success: no unit ever launches on a model or effort that was set for a different harness, and a config that would have done so says so, naming the ticket or the resolver, before anything launches.

Users: operators of mixed-harness pools (defaults on cursor `auto`, resolver on claude); authors of `assign` entries that switch harness.

### Where it happens (read from the code, proven by reading, not yet reproduced)

- `crates/engine/src/merges.rs` `resolve_resolver`: the harness comes from the `resolver` key or the Merger's own Assignment, then `model` and `effort` fall back to `defaults.model` / `defaults.effort`, then to the Machine defaults, with no check that those belong to the same harness.
- `crates/core/src/assignment.rs` `resolve_assignment`: `first_set` picks harness, model and effort each independently across the four layers (request, requested, inherited, defaults). An `assign` entry or Line node `assign` that sets only `harness` therefore inherits `defaults.model` from a different harness. The same applies to effort.
- The quick fix already on main: `resolver` accepts `{ "harness", "model", "effort" }`. It stays.

## The rule

A layer's model (and effort) is *owned* by a harness: the harness that layer sets, or, when the layer sets none, the harness of the nearest lower layer that does. For the Machine defaults the owner is the Machine defaults' harness.

A resolved harness `H` takes a model or effort only from a layer whose owner is `H`. A layer owned by another harness is skipped and the search continues down the chain. Nothing found means the field is unset (empty model, no effort).

Consequences:
- `defaults {harness: cursor, model: auto}` plus `assign.t {harness: claude}`: `t` resolves to claude with no model. Today it resolves to `claude auto`.
- `defaults {harness: claude, model: opus}` plus `assign.t {model: sonnet}`: unchanged, `claude sonnet`.
- `defaults {harness: claude, model: opus}` plus `assign.t {harness: claude}`: unchanged, `claude opus` (same harness).
- A model set above a harness switch still pairs with the new harness (`{ "harness": "claude" }` below, `{ "model": "opus" }` above): the owner of a modelling layer with no harness is the resolved harness's own chain.

An unset model after the rule is not made up. What happens next depends on the unit (below).

## What changes

1. **Core resolution** (`ac_core::assignment`): implement the owner rule once in `resolve_assignment` and `resolve_assignment_sources`, so the Console's "pinned" / "inherited" labels in Reassign (issue #126) agree with what launches. A model skipped for belonging to another harness reads as unset, not as "inherited".
2. **Resolver** (`resolve_resolver`): apply the same rule over its layers (Merger's own fields, `resolver` entry, pool defaults, Machine defaults). A resolver whose harness is not `defaults.harness` (or the Machine defaults' harness, for that layer) and that resolves no model is a config error, not `Ok(None)` and not a launch: `pool config: resolver names harness 'claude' but no model: its model comes from defaults.model, which is for 'cursor'. Give resolver a model: { "harness": "claude", "model": "..." }`. It fails at boot and in a Config reload (a reload that would raise it is rejected whole, ADR on reload unchanged). A resolver with no explicit harness and no usable harness at all keeps today's `Ok(None)`, the manual path.
3. **Assign entries and Line node assigns**: the model resolves per rule. An unset model on a Ticket is the existing misconfiguration path (a Ticket with no model resolves to an empty model and the operator's Config interrupt names it, issue #118), not a new boot failure. See Open questions, 1.
4. **Conversations** (`conversations/start.rs`, strict path): already errors on no model ("no model resolved"); that message gains the "belongs to another harness" reason when the cause is the skip.
5. **`my-console-runner` skill**: when the resolver harness differs from the default harness, ask for the resolver's model and write the object form. Same for any `assign` entry that changes harness.
6. **CONTEXT.md and one ADR**: add the term for this rule to the glossary under Assignment (no existing term covers "owned by a harness"), and an ADR "A model name belongs to one harness" recording the rule, the resolver-fails-at-boot decision, and the per-harness-defaults deferral.

## Not in scope

- Per-harness default models (`defaults.harnesses.claude.model`, or a per-harness line in `~/.issue-runner`). The issue marks it optional and it adds a fifth layer and a Settings pane field. Proposed as a follow-up, not built here.
- Translating a model name between harnesses.
- Validating that a model name exists for its harness.
- Enlisted panes (their model is whatever they run as found).

## Commands

```
Rust:         cargo test --workspace
Build:        cd ui && bun install && bun run build && cd .. && cargo build --release
Conformance:  bun run conformance            # against the release binary, ~50 min for the whole suite
One case:     bun run conformance -- conformance/cases/config-resolver.test.ts   # runner flag to confirm; check package.json first
Types:        cargo run -p ac-protocol --bin gen-typescript -- protocol          # only if a wire type changes
UI tests:     cd ui && bun test
```

`bun` is at `~/.bun/bin`, not on PATH in this shell.

## Project structure (the files this touches)

```
crates/core/src/assignment.rs      → owner rule in resolve_assignment / resolve_assignment_sources, unit tests beside it
crates/engine/src/merges.rs        → resolve_resolver, its error, its tests
crates/engine/src/config_reload.rs → reload rejects a resolver the new rule fails
crates/engine/src/conversations/start.rs → strict-path message
skills/my-console-runner/          → SKILL.md / GUIDE.md: ask for the resolver model on a harness change
conformance/cases/config-resolver.test.ts, config-assignments.test.ts, cli-boot-config.test.ts → new cases
CONTEXT.md, docs/adr/              → term and ADR
```

## Code style

The surrounding Rust: doc comments say what a function resolves and why, error strings start `pool config: `, and a fail-fast config error is an `anyhow::bail!` naming the key and what to write.

```rust
anyhow::bail!(
    "pool config: resolver names unknown harness '{explicit}'. Known: {}",
    session.harnesses.known()
);
```

No em dashes in prose or comments.

## Testing strategy

Red first, per the repo's tdd habit.

- **Unit (`ac_core::assignment`)**: a table over the owner rule: defaults on another harness, same harness, model above a harness switch, effort following the same rule, Machine defaults layer, a null stopping the chain, sources agreeing with the resolved value.
- **Unit (`merges.rs`)**: the issue's exact case (defaults cursor `auto`, resolver claude, no model) is a config error; the object form with a model passes; same harness as defaults still inherits; `"none"` and no resolver are unchanged; a Merger's own `harness` with no model follows the same rule.
- **Conformance** (AGENTS.md: every engine change lands with cases for what shows outside the server; import only types from `protocol/`):
  - boot with defaults on one stub harness and a resolver on another with no model: exit non-zero, stderr names the resolver and the fix; no harness process started.
  - the same pool with the resolver's model given: a conflict launches the resolver with that model in its argv.
  - an `assign` entry that changes harness without a model: the Ticket launches nothing and its Config interrupt names it and says why; with a model it launches with that model.
  - a Config reload that introduces the bad resolver is rejected whole and the previous config stands.
  - existing cases that rely on cross-harness inheritance (`resolver: "resolver-stub"` with `defaults.harness: "stub"`) get a model of their own, as the issue says.
- Run the existing `config-*`, `cli-boot-*` and `attempts-launch` cases before the full suite.

## Boundaries

- Always: tests first; conformance for each externally visible change; keep the `resolver` string form working when the harness equals the defaults' harness.
- Ask first: adding the per-harness defaults layer; changing the `console.json` shape beyond what is above; making an unset Ticket model a boot failure.
- Never: guess a model for the operator; copy a model across harnesses "to be helpful"; edit another pool's files; push or open the PR (the human does; delete this spec in a last commit before it, per AGENTS.md).

## Success criteria

1. `defaults {cursor, auto}` plus `resolver {harness: claude}` fails boot with an error naming the resolver and the object form to write.
2. The same pool with `resolver {harness: claude, model: opus}` boots and the resolver's argv carries `--model opus`.
3. An `assign` entry changing harness without a model never launches on `defaults.model`; the Ticket raises the existing Config interrupt naming it.
4. Same-harness inheritance is unchanged: every existing case that does not cross a harness passes untouched.
5. Reassign's "pinned" / "inherited" labels agree with the launched values across a harness switch.
6. `cargo test --workspace`, the touched conformance cases and `cd ui && bun test` pass; the full `bun run conformance` is run once before the PR.
7. The runner skill asks for the resolver model on a harness change; CONTEXT.md and the ADR are written.

## Open questions (each with a recommendation; the Confirm gate settles them)

1. **Assign entries: boot failure or Config interrupt?** The issue says fail fast at boot for both. Tickets are deliberately lenient (a Ticket with no model renders as a misconfiguration and raises a Config interrupt, #118; one bad Ticket must not stop the pool). Recommendation: resolver fails fast, Tickets use the Config interrupt, because the resolver has no per-ticket home to show the error on.
2. **Effort too?** The issue names only the model. Effort is the same harness-native word (CONTEXT.md, Effort), so it has the same bug. Recommendation: apply the rule to effort in this change; it is the same code path and leaving it half-fixed invites the same report.
3. **Machine defaults layer.** The resolver falls back to `model` from `~/.agent-graphs/` Machine defaults when the pool names none. Recommendation: the rule applies there too, owner = the Machine defaults' own harness.
4. **Per-harness default models.** Recommendation: defer; the object form on each entry is enough for the mixed pool in the issue. Propose it as a follow-up once this lands.
