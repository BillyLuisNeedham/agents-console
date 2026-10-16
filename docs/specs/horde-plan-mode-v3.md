# Horde Plan Mode prototype, v3: authors' presets, its own merger node, chunked copies, a Finish that waits

## What this is

`prototype/horde-plan-mode/index.html` is a single-file logic prototype of **Horde Plan Mode**: a build-your-own Factory, where the operator lays out nodes and links instead of running the fixed Grill → Implement → Prove → Review → Decide → Finish Line. Open it by double-clicking. It is a prototype and it is deleted before the feature's PR, so: no tests committed, no build step, no framework, everything inline. Its first `<script>` block is a pure module, `Horde` (`reduce(state, action)`, `parse(line)`, `toCommand(action)`, `toFile`, `fromFile`), with no DOM in it. Keep it pure. The page is a thin shell over it. Every button sends the same text command an agent would type, and that parity must hold for everything added here.

Read the file first. It already has nodes with spawn `no|ask|yes`, checkpoint `wait|steward|continue|rest`, copies, merge, free-text harness, model and effort with quick picks, gates (`open operator|steward|auto`, `join any|all`), capped loop links, handoffs that wait on a node until it is linked onward, a Needs-you tray, a Links form in the inspector, a multi-line opening prompt, Save, a Plan file tab, an Agent tab, and six guided walkthroughs. The visual language is the Console's (`ui/src/styles.css` tokens). Keep the look.

The operator, Billy, settled these in review on 2026-10-16. Build all of them.

## 1. Copies split one plan into chunks. They never duplicate work

A node that runs several copies does so because the work handed to it was split into items (slices, tickets, findings). One item per copy. There is never more than one agent building the same thing: no best-of-N.

- Remove the `fixed` copies mode. Copies are `one` or `per-item`.
- `per-item` takes a cap on how many run **at once**: a number, or `all` (no cap: as many copies as there are items). Command: `set builder copies per-item:3` or `per-item:all`.
- Items beyond the cap queue. When a copy finishes, the next queued item starts a new copy in the same pass ("waves"). The node finishes only when every item is done. Show the queue on the card and in the inspector, e.g. "3 running · 2 queued".
- Remove the old behaviour that shared several items into one copy.
- Rework every walkthrough and preset that used `fixed`, so they hand items in instead.

## 2. The merger is its own node

- A new node kind, `merger`. It folds the branches of the node before it into the line base. Its verdict is `merged`.
- Put one down automatically when a node can run more than one copy (`per-item`): place it beside that node, and route that node's success links through it. The success verdict is the node's first verdict, e.g. `builder.done → builder-merge`, then `builder-merge.merged → whatever followed`. A `link builder.done -> review` made while the node has a merger links from the merger instead, and says so.
- To opt out, remove the merger node or `set builder merge off`. Either reconnects the links straight from the node, and its branches then travel on separately. `set builder merge auto` puts the merger back.
- A merger that receives a single branch passes it through.
- On a conflict, the merger follows its own setting `conflict: resolver|wait`:
  - `resolver`: run a resolver copy on the merger's free-text harness, model and effort, default skill `resolving-merge-conflicts`. Finishing that copy with `merged` carries on.
  - `wait`: stop at a checkpoint for the operator.
- The prototype has no real git, so add a free-play control on the merger: "Next merge conflicts" (command `conflict <merger-id>`).
- A merger is not "Run this node"-able.

## 3. Finish waits for everything else

Reaching a Finish node does not finish the run while anything else is running or queued. That covers:
- a copy that is running, at a checkpoint or resting
- queued items or inbox handoffs
- a gate waiting to be opened
- a held spawn
- a spent loop waiting on the operator

Finish then shows "waiting for: …" naming what it waits on, and completes by itself once that clears. A gate still collecting inputs that will never come, or a handoff waiting on a node, does not block it. The "Gates" walkthrough currently shows "Run finished" while API runs again. Change it to show Finish waiting and then completing.

## 4. The Steward's powers are opt-in

- A plan-level setting, "Steward may edit this plan" (`set plan steward-edits yes|no`, default no). It is saved in the plan file.
- The Agent tab gets "Send as: you | Steward". A command sent as the Steward is written `as steward: <command>` in the log.
- When the setting is no, the Steward's plan edits are refused: add, remove, set, link, unlink, loop, move, name. Without that permission the Steward only steers the run through: resume, adopt, discard, and open a gate whose opener is `steward`.
- A loop link may be marked "the Steward may allow one extra pass" (`loop <edge> steward yes|no`, saved in the file). When that loop is spent, the Steward allows one more pass by itself, once, and logs it. After that it asks the operator as now. Unmarked loops always ask the operator.

## 5. Presets: the authors' own flows

Replace the guessed presets. Each preset must follow the flow its **author** recommends, not a chain that looks sensible. Read the sources below, in `/home/billy/repos/skills` (on branch `pclaude`) and `/home/billy/repos/pstack/pstack/`, before laying any preset out. Use real skill names as each node's skill.
- Author-stated human approval points become `gate` nodes with opener `operator`.
- Author-stated loops get the author's limit as the cap. Where the author gives none, use cap 2 and say so in the note.
- Fan-out steps become `per-item` nodes with a merger.

Each preset carries `source` (a file path) and `note` (one or two sentences: what is distinctive, plus anything the graph cannot express, such as "/clear between tickets"). Show both on the Plan file tab and as a line under the preset picker when a preset is loaded. Keep both in the saved file. Group the picker by author with `<optgroup>`.

The flows, from their sources:

- **Matt Pocock**, `skills/engineering/ask-matt/SKILL.md`, which names one main flow and on-ramps:
  - *Main:* `grill-with-docs` → `prototype` → `to-spec` → `to-tickets` → [gate: "Iterate until the user approves the breakdown", to-tickets/SKILL.md] → `implement-spec` (per-item over ready tickets, merged into one integration branch) → one `code-review` → fixes by a single implementer (no re-review loop) → `pr` → `retro`. Note that `handoff` is the optional detour between sessions.
  - *Quick:* `implement` (runs `tdd` then `code-review`).
  - *Bug:* `diagnosing-bugs` → `retro`.
  - *Foggy:* `wayfinder` → `to-spec` → `to-tickets` → `implement`.
- **Pstack** (Lauren Tan, "poteto"), playbooks under `skills/pstack/pstack-poteto-mode/playbooks/`. Upstream README: "use `/poteto-mode` at the start of a task":
  - *Feature* (feature.md): `pstack-how` → `pstack-architect` → per-item over independent workstreams → verify on the matching surface → `pstack-interrogate` if contested → Opening a PR (`deslop`, `pstack-no-comments`, `pstack-technical-writing`, `pstack-unslop`) → Babysit, a loop to READY with "one retry only" for a CI flake → [gate: "Babysitting never authorizes merging"].
  - *Bug fix* (bug-fix.md): reproduce → `pstack-how`/`pstack-why` → `pstack-architect` → fix → verify on the same surface → `pstack-tdd` failing repro committed first → Opening a PR.
  - Pstack runs on Cursor, so the harness is `cursor`. Read the playbooks for the model they default to.
- **PClaude**, Billy's Claude Code port of Pstack, at `skills/pclaude/`: the same two flows with `pclaude-*` names and harness `claude`. Use `skills/pclaude/docs/README.md` for the ordering. The note says it is a port still in progress (see `PORTING.md`).
- **Addy Osmani**, `skills/addy/addy-using-agent-skills/SKILL.md` "Lifecycle Sequence" and the command skills:
  - *Commands:* `addy-spec` → [gate: confirm SPEC.md] → `addy-plan` → [gate: review tasks/plan.md] → `addy-build` (per-item over tasks, red-green per task) → `addy-test` → `addy-review` → `addy-code-simplify` → `addy-ship`, which fans out code-reviewer, security-auditor and test-engineer in parallel into GO/NO-GO.
  - *Bug fix:* `addy-debugging-and-error-recovery` → `addy-test-driven-development` → `addy-code-review-and-quality`.
- **Factory today**: keep it as is, the engine's fixed Line.

If the sources show a flow differs from this list, the source wins. Say what you changed in the Outcome.

## 6. Walkthroughs

Keep the six, updated for the changes above. Add:
- *Waves:* 5 slices with a cap of 2. Watch the queue drain and the merger take the branches.
- *Merge conflict:* arm a conflict, watch the resolver run, finish it.
- *Steward powers:* a Steward edit refused, then allowed after `set plan steward-edits yes`; a Steward-marked loop allowing one extra pass, then asking you.

Every step stays a real command. Every walkthrough must run start to finish with only its intended refusals.

## Done means

- Every walkthrough runs clean end to end, run headless against the `Horde` module (extract the script blocks and drive `WALKS` under bun). Every preset loads, and every loop in it has a cap.
- The page renders without console errors in headless Chromium at 1500×950 and at 420px wide. Capture screenshots of: a loaded author preset, a merger mid-conflict, Finish waiting, and the Steward refused.
- The pure module still references no DOM.
- `prototype/horde-plan-mode/index.html` is the only file changed, apart from this spec.
