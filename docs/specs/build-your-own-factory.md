# Build your own Factory (Horde Plan Mode)

Branch `feature/build-your-own-factory`. The type sketch is in `docs/specs/build-your-own-factory/sketch/` (`plan.rs`, `run.rs`, `drive.rs`): types, signatures and invariants with `todo!()` bodies, never compiled. Where it and this spec disagree, this spec wins and the sketch gets fixed. The decisions are ADR-0039 (the Factory runs a Plan) and ADR-0040 (one rolling scheduler). The words are in `CONTEXT.md`. This spec and its sketch are deleted in the last commit before the PR.

## Goal

The Factory's fixed Stations (ADR-0037) become a Plan the operator builds: a graph of nodes and edges the Rust engine runs as a Line. "Factory today" ships as one built-in Preset beside the authors' own flows. The prototype at `prototype/horde-plan-mode/index.html` only simulated runs; this build makes them real, under a rolling scheduler that starts each Ticket the moment it may start, in every pool.

## Done means

1. A pool booted with `--plan factory-today` reproduces every behaviour the `factory-*`, `cli-boot-factory` and `steward/factory` cases pin today, re-expressed on node ids (`r1-implement` is `implement-1`, `r1-fix-1` is `implement-2`, `r1-finish` is the Finish hold `finish-1`). It differs only where this spec says so: a spent Prove loop raises the loop hold `prove-fail-implement-3` instead of checkpointing the fix Ticket; a PR Finish opens its PR after approval, from `finish-1-act`, not from Decide before it; notes on the Finish reset Decide's extra-Round count; the Station settings cases are deleted.
2. A pool booted on Addy Osmani · Commands, on a real small issue in this repository, runs per-item copies of `build` under its cap and through its Merger, goes round the capped `test.fail -> build` loop, passes both operator gates, and reaches a Finish that refuses approval while anything runs, queues or waits, then accepts it. The run is recorded with `/my-verify`.
3. In the Console the operator loads a Preset, edits it, sees each validation problem on its node or edge, saves it to the Plan library, boots a Line from it, and watches the live graph (copy dots, queued counts, holds, "Finish waiting for ..."), each copy opening its Ticket.
4. `bun run conformance` on the release binary, `cd ui && bun test`, the harness scenarios and `cargo test --workspace` are green.
5. `prototype/horde-plan-mode/` and this spec are deleted in the branch's last commits.

## Settled decisions

These are closed. The design below carries each one.

- The Plan replaces the fixed recipe (ADR-0039). "Factory today" is a Preset.
- Presets are compiled in and read-only; the operator's Plans live in `~/.agent-graphs/plans/<slug>.json`; a Line freezes its Plan into `line.json` at start.
- Nodes are Conversation nodes, Ticket nodes, Mergers, Gates and the Finish. The Grill is a Conversation node. A Line starts at Boot, Start the Line is gone, and `--brief` takes the entry Conversation node as answered.
- Items are a typed `items: [{title, body}]` in an Outcome or a Line brief. Copies are per item under a cap or `all`, never best-of-N.
- The merger is its own node, placed automatically after a node that becomes per-item. Removing it hands each copy on alone. Its resolver runs on its own Assignment.
- The Rust core owns the format, validation and every run rule. The Console holds no reducer, and the text command language is dropped.
- Per-node Assignment lives in the Plan and falls through to the pool defaults. The Factory settings layers are deleted.
- The Finish cannot complete while anything runs, queues or waits; approving its hold refuses with the blockers.
- Steward powers are opt-in (`stewardEdits`, `stewardExtra`), and the Steward never answers the Finish.
- A traversed loop edge resets the loops nested inside it. Resuming a spent loop buys one traversal. `checkpoint: rest` and `continue` are dropped: the engine never answers a checkpoint by itself.
- One rolling scheduler runs every pool (ADR-0040): a Ticket starts once each blocker is Done and merged, in its own worktree cut at launch, under a pool-wide `maxLive` (unlimited by default).
- A merge conflict pauses only its Ticket's dependents, and its Interrupt counts the Tickets started since.
- A Spawn whose `blocks` names a started Ticket is Held as `started`.

## Design

### The Plan

`ac_core::plan` (sketch `plan.rs`) owns the file format, `Plan::parse`, `Plan::edit`, `PlanProblem`, `PRESETS` and the library. `parse` and `edit` are the only constructors, and `edit` re-runs `parse` on its result, so there is one validator. The file is `{horde: 1, name, author?, source?, note?, stewardEdits?, nodes, edges}`.

| Node | Runs | Hands on |
|---|---|---|
| Conversation node | a Conversation per pass | `done`, `closed` |
| Ticket node, kind Agent | Tickets | `done`, `closed` |
| Ticket node, kind Prove | Tickets | `pass`, `fail`, `closed` |
| Ticket node, kind Review | Tickets | `clean`, `findings`, `closed` |
| Ticket node, kind Decide | Tickets; writes the report | `ship`, `another-round`, `closed` |
| Merger | nothing | its `of` node's verdicts |
| Gate (operator or Steward) | a hold Ticket | `open`, `revise`, `closed` |
| Gate (auto) | nothing | `open` |
| Finish | the Finish hold, then the Finish Ticket | `revise` |

A Ticket node has `skill`, `assign {harness, model, effort}`, `copies` (`one`, or `per-item` with a cap or `all`), `makesItems`, `checkpoint` (`operator` or `steward`), `spawns` (`hold`, ADR-0037's rule and the default, or `land`) and `note`. A Conversation node has `skill`, `assign` and `note`. A Merger has `of` and `conflict` (`resolver` with its own `assign`, or `wait`). A Gate has `open` (`operator`, `steward`, `auto`) and `join` (`any`, `all`). The Finish has `act` and `assign`.

An edge is `{from, on, to, cap?}`, unique on `(from, on, to)`. A cap is `{max, stewardExtra, whenSpent}`, where `whenSpent` is `hold` or a node id. Validation reports every problem at once:

- ids match `[a-z][a-z0-9-]{0,39}`, do not end in `-<digits>`, and avoid reserved words;
- `on` is in the from node's vocabulary, and nothing but `revise` leaves the Finish;
- there is one Finish and at least one entry, every node is reachable from an entry, and the Finish from every node;
- a Merger's `of` is a per-item Ticket node, one Merger per node, and every out-edge of a node with a Merger goes to it;
- every cycle holds a loop edge: a capped edge, or one leaving a person (an operator or Steward gate, or `finish.revise`). A cap on an edge that closes no cycle is a problem.

`parse` derives the entries and, for each loop edge, the capped loops nested inside its cycle. Traversing a loop edge resets those counts, so in Factory today `decide.another-round -> implement` resets `prove.fail -> implement` each Round, as Prove's per-Round limit does now.

`closed` with no edge of its own goes to the Finish, carrying the reason, so every Plan can end. Any other unrouted verdict parks on its node and flows on if a later edit links it. A parked handoff never blocks the Finish.

`Plan::edit` takes typed `PlanEdit`s (`AddNode`, `RemoveNode`, `SetNode`, `Link`, `Unlink`, `SetCap`, `SetMeta`, `Move`) and keeps mergers in step. A node set to per-item gains `<id>-merge`, and its out-edges move to the Merger. A node set back to one copy loses its Merger, whose out-edges move back. Removing a Merger moves its out-edges onto its node, which is the opt-out. A `Link` from a node with a Merger is made from the Merger. Each move returns a note the editor shows. Because this lives in core, the Console and the Steward get the same behaviour.

### Run state and transitions

`ac_core::line::run` (sketch `run.rs`) holds `LineRun`: the frozen Plan and its `rev`; the Line's places (branch, base, spec, `pushBase`, work); its status; per node the passes, current pass, inbox, parked handoffs and gate arrivals; per loop edge the count, bought traversals, `steward_used` and held handoff. It stores structure and what it has absorbed. A Ticket's status belongs to its state line and merged-ness belongs to git, so neither is stored.

The transition is level-triggered. `observe(facts)` lists what the pool shows that the run has not absorbed, in plan order. `apply(event)` absorbs one event, and a second apply is a no-op. `advance(facts)` runs both to a fixpoint, settles the Finish, and returns the effects as a projection: every Ticket, hold Ticket and Conversation the run names that the pool lacks. Ids are a pure function of run state, so every write is create-if-absent:

| What | Id |
|---|---|
| one-copy pass | `implement-2` |
| per-item copy | `build-2.3` |
| Conversation pass | `grill-1` |
| gate hold | `approve-1` |
| loop hold | `prove-fail-implement-3` |
| Finish hold | `finish-1` |
| Finish Ticket | `finish-1-act` |

A copy has two moments. It is freed when it ends, done or closed: its slot frees and the next queued item starts as a new copy in the same pass. It is settled when it is done and merged into the Line's branch, or closed: its verdict now counts. With a Merger the pass completes once every copy has settled and hands its verdict to the Merger, which hands it straight on. That verdict is `closed` if any copy closed, else the first non-ok verdict in copy order, else the kind's ok verdict. Without a Merger each copy hands on its own verdict as it settles. A copy waiting at a checkpoint keeps its slot.

A handoff is `{from, verdict, items, after, notes, halted}`. The next Tickets are `blocked-by` the Tickets in `after`, so the merge gate and the Console's topology edges see the flow without knowing about Lines. `after` lists Done Tickets and answered hold Tickets, never a Closed one, because a Closed blocker deadlocks its dependent (ADR-0033). A gate's handoff carries its own hold beside what it collected.

A node handed work while its pass is live keeps it in its inbox, one later pass per handoff. A per-item node handed items starts `min(cap, n)` copies and queues the rest; handed none, it runs one copy on the Line's work. A one-copy node's body lists every item. A `join: all` gate waits for a handoff on every incoming edge, then combines them.

Gates, spent loops and the Finish wait as hold Tickets: `status=checkpoint node=<id> hold`, with an Interrupt and no agent, never launched. Resume writes the hold Done (never Ready) with the note on its events, Resume with notes is `revise`, and Close is `closed`. On a loop hold, Resume buys one more traversal, and Close stops the loop, so the from node hands on `closed`. A cap with `whenSpent: <node>` sends the handoff there instead of holding: in Factory today a spent `another-round` goes to the Finish with a note, as Decide does now.

A Ticket's body is built from its node (skill, note, kind teaching, items teaching if `makesItems`), the Line's spec, the handoff (items, notes, halted) and the Outcomes of the Tickets in `after`. A Decide body also lists every Prove and Review Outcome since that node's previous pass. Decide still writes the report, keyed by its pass. Every Line Ticket's Outcome is checked against its kind at exit, and a missing or invalid verdict is the "no verdict" checkpoint (ADR-0037).

### Conversation nodes and the Line brief

A Conversation node's pass opens a Conversation `{node}-{pass}` on the node's Assignment. Its opening Turn carries the Line's work or the handoff and teaches the Line brief: `docs/specs/<line>.<conversation>.brief.json` on the Conversation's branch, `{spec?, items?, finish?, pushBase?, nodes?}`, where `nodes` maps node ids to `{assign?, note?}`.

`conversations.end` parses the brief on the branch. A missing or invalid brief refuses the End with its problems and changes nothing. A valid one ends the Conversation and chains its branch's merge onto the Merge queue. `conversations.end {close: true}` merges nothing and hands on `closed`, as a crash does.

The engine never records the brief at End. It reads it from the Conversation's branch at every advance, or from the Line's branch once that branch has merged and been deleted, and the run absorbs it only after the merge. Absorbing applies `spec` and `pushBase` to the Line, applies `finish` and `nodes` to the frozen Plan as operator edits, and hands on `done` with the items. A crash anywhere in between replays from disk.

`--brief <path>` absorbs the entry Conversation node's pass at once and opens no Conversation. A Plan with no entry Conversation node applies the brief to the Line and starts its entry Tickets on it.

### The Finish

When a handoff reaches the Finish, the Line is `Finishing` and the graph names what it waits for: live copies, queued items, inbox handoffs, gate and loop holds, open Conversation passes, any non-Line Ticket not Done or Closed, any done Ticket not merged, any Held or Pending spawn, any pending Interrupt. The Finish hold `finish-<n>` is written the first time that list is empty. It is the operator's: the Steward is never told of it and is refused on it.

An answer on it is checked when accepted and again when it drains. Approval while anything blocks is refused with the list. Resume with notes is refused if the Finish has no `revise` edge, and otherwise hands the notes on along it. Close ends the Line Closed.

The act runs after approval. `none` ends the Line at once. Any other act (`draft-pr`, `pr`, `fast-forward`, free text) writes one Finish Ticket, `finish-<n>-act`, on the Finish node's Assignment. Its body is today's `finish_act` text: delete the spec, briefs and `.verify/` in a final commit, push the head as the Line's branch, then open the PR against the Line base, fast-forward the base (locally, and on origin only under `pushBase`, never forced), or carry out the free text. The Line is `Acting` until that Ticket is done and merged, then Done, or Closed if it is Closed. A `pr` or `draft-pr` Outcome without the PR's url is "no verdict". The Steward may not answer that Ticket.

This shape works without a Decide node, which most authors' flows lack, because the act belongs to the Finish. Nothing leaves the pool before the operator approves, where today the draft PR opens first. It is safe to re-run after a crash. The approval is a Queued answer on disk, and the hold's Done state line is the fact the run reads. `Acting {ticket}` is saved before the Ticket is written under a fixed id, so it is written once. An Attempt killed mid-act returns to Ready on its own branch, and the act's teaching checks before each step: an open PR from the Line's branch is the result, a push origin already has is a no-op, a deleted spec stays deleted. The engine never runs `gh` or pushes, so a free-text act needs no second path.

### The rolling scheduler

`crates/engine/src/drive.rs` (sketch `drive.rs`) becomes a loop of ticks. A tick is one actor job:

1. reload `console.json` if its stamp moved;
2. drain Queued answers;
3. reconcile deadlocks;
4. advance the Line: save `line.json`, then write the projection;
5. land Pending spawns;
6. start owed grading flows;
7. launch every eligible Ticket;
8. persist and emit if anything changed.

The drive then waits on `Session::wake`, a `Notify` permit that cannot be lost. Every exit, merge landing, accepted answer, settings save, Conversation end, plan edit, grading end, Adopt, Enlist and Reassign calls it, and so does the Merge queue watch when it sees a hand merge. It replaces `kick_processing`.

A Ticket is eligible when it is Ready, not a hold, not live, and each blocker is Done and merged. A hold Ticket and an engine-run Ticket count as merged by rule, because neither has a branch; so does every Ticket outside git. Otherwise merged means the branch is an ancestor of the merge target, through the existing memo, a missing branch reading as landed. Launches also wait while `maxLive` Attempts are live. Live counts every Ticket Attempt the engine runs (Candidates, resolvers, Continued attempts), not Conversations or enlisted panes. A `verify: N` Ticket needs room for N unless nothing is live, and a resolver is counted but never withheld. Config gaps and held branches raise today's checkpoints.

Every launch cuts a worktree from the merge target's tip at that moment, which holds every blocker. No Ticket runs in the pool checkout. The pool log's `super-step N: ids` becomes `start <id> at <sha7>`. Per-node caps are not the scheduler's: copies past a cap are never written.

The boundary's duties now run per Ticket. Answers and Close are processed at the next tick, at once when nothing is mid-job. Crash Interrupts are raised at the exit. A verify Ticket's Candidates join a per-Ticket group, graded when the last exits. Merges chain per Ticket as today, and a conflict follows the Ticket's policy: its node's Merger for a Line Ticket, `resolver` otherwise. A checkpoint row is written after every job that changed state. The drive closes when a tick launches nothing and nothing is live, merging, grading or waiting to land.

### Persistence and restart

| Where | What |
|---|---|
| Ticket file state line | status, plus `node=` and `hold` in place of `station=` |
| `line.json` | `{horde: 1, plan, rev, places, run}`, temp file and rename |
| `console.db` | a checkpoint row after each job that changed state |
| `runs/` | as today; Outcomes gain `items` |
| `~/.agent-graphs/plans/` | the Plan library |
| the binary | the Presets |
| nowhere | merged-ness, eligibility, Line events, Finish blockers, a conflict's started-since count |

Restart is today's rehydrate with four changes. `line.json` loads as a `LineRun`, and an old `LineState` file is refused with a message to start a new Line. Verify groups are rebuilt from each in-progress verify Ticket's events, the round being the `spawned` events since its last `scheduled`: if every Candidate exited, grading resumes for the ungraded; if some are live again through terminal re-adoption, the group waits for them; if one neither exited nor came back, the marker returns to Ready and the round fans out again with continued numbers, as today. Owed Continued grades come from `owed_continued_grade`, unchanged. Nothing else is rebuilt: the first tick's `advance` re-observes every fact and the projection writes what a crash left unwritten. An in-progress Ticket with no Interrupt relaunches into its existing branch, whose cut still holds its blockers.

### The Steward

`steward_actions.rs` asks `LineRun::steward_may_answer(ticket)` in place of today's hard-coded Finish refusal, and the Steward is told only of what it allows: a checkpoint on a copy whose node is `checkpoint: steward`, the hold of an `open: steward` gate, and a spent loop's hold on a `stewardExtra` edge, once per reset. Never the Finish hold or the Finish Ticket, and nothing once the Line has ended. Plan edits through `POST /api/steward/plan` are refused unless the frozen Plan says `stewardEdits`. Line-held spawns keep `mayAdoptLineSpawns`. The budget and Steward notes are unchanged. Its teaching names the Plan and what it may answer.

### Wire: verbs and snapshot

Each verb is a socket request with an HTTP twin, declared in `crates/protocol` and generated into `protocol/*.ts`, with `PROTOCOL_VERSION` bumped.

| Verb | HTTP | Does |
|---|---|---|
| `plans.list` | `GET /api/plans` | Presets, then library Plans, each with its problems |
| `plans.get` | `GET /api/plans/<slug>` | one Plan's file |
| `plans.validate` | `POST /api/plans/validate` | `PlanProblem[]` |
| `plans.edit` | `POST /api/plans/edit` | `{plan, edits}` on a draft, valid or not: the draft after the edits with its problems, the edits' notes and each node's verdicts; refused for a draft it would have to drop or rewrite |
| `plans.save` | `PUT /api/plans/<slug>` | refused for a Preset slug or an invalid Plan |
| `plans.delete` | `DELETE /api/plans/<slug>` | refused for a Preset slug |
| `plans.boot` | `POST /api/plans/boot` | runs Boot detached with `--plan`, `--work`, `--yes` from the main worktree of the pool's repository, and answers its argv, cwd and log |
| `line.plan.edit` | `POST /api/line/plan` | `{baseRev, edits}`, the new `rev` or 409 |
| (Steward) | `POST /api/steward/plan` | the same, gated by `stewardEdits` |
| (Boot) | `POST /api/line` | `{plan, work or brief}`, once per pool |

`conversations.end` gains `close`. `GET /api/line` returns the graph view, and `GET /api/line/report` takes `node` and `pass`. `Snapshot.line` becomes `LineGraphView`: the frozen Plan and `rev`, the status with `waitingFor`, per node its passes, copy ids, queued and inbox counts, parked verdicts, gate arrivals and hold, and per loop edge its count, max, bought and hold. `TicketCard.station` becomes `node`. `PoolConfig` and `MachineDefaults` lose `factory` and gain `maxLive`. `HeldSpawnReason` gains `started`, `Outcome` gains `items`, the merge-conflict Interrupt gains `startedSince`, and `ConversationRole::Grill` becomes the Conversation's `node`.

### Console surfaces

- **Plans view**, from Settings and the pool header. It lists Presets by author, each with its `source` and `note`, then library Plans. A Plan opens on the existing canvas and SVG edge layer, which gain drag-to-link, add and remove node, and an inspector for node, edge and Plan fields. Every change goes through `plans.edit`, which applies `PlanEdit`s in core (so Mergers stay in step and new nodes are named there) and answers the problems `plans.validate` would, and each problem marks its node or edge. It saves, saves as, deletes, and boots a Line through `plans.boot`. Its only state is the draft Plan document.
- **Line view.** A pool running a Line draws its frozen Plan with live state from `LineGraphView`: copy dots coloured by their Tickets' status, "3 running, 2 queued", parked verdicts, holds, loop counts against caps, and "Finish waiting for ..." with the list. A copy dot opens its Ticket's card and Detail. Edits on a running Line send `line.plan.edit`, and "Save as" copies the frozen Plan into the library. It is a mode of the same canvas, morphed on node ids (ADR-0025).
- **Settings** lose the Factory fields on both forms and gain `maxLive` (Pool settings, reloads; Machine defaults).
- **Conversations tray and Detail.** Start the Line is gone. A refused End shows its problems inline and offers "End as closed". The report iframe reads `GET /api/line/report?node=&pass=`.

### Boot

`agent-console boot --plan <slug>` replaces `--factory`, with `--work`, `--brief`, `--from`, `--line` and `--no-steward` as today. `--work` alone enters Line mode. Without `--plan`, Line mode asks "start from which plan", listing Presets then library slugs, in the Setup picker's pattern, and `--yes` takes `factory-today`. Boot loads the Plan, cuts `line/<slug>` as today, writes `console.json`, starts the server and sends `POST /api/line`. The engine parses the Plan again, because its boundary is the one that counts.

### Presets

JSON files under `crates/core/src/plan/presets/`, ported from the prototype's `PRESET_SCRIPTS` with the same nodes, skills, Assignments, caps and two-sentence notes. Approval points are operator gates, loops carry the author's limit or 2 with the note saying so, fan-out steps are per-item nodes with a Merger, and the node that feeds a per-item node is marked `makesItems` (Addy's `tasks`, Matt Pocock's `to-tickets` and `chart`, the bug-fix flows' `how`).

| Slug | Author | Source |
|---|---|---|
| `factory-today` | Agent Console | `docs/adr/0039-the-factory-runs-a-plan-the-operator-builds.md` |
| `matt-pocock-main` | Matt Pocock | `skills/engineering/ask-matt/SKILL.md` |
| `matt-pocock-quick` | Matt Pocock | `skills/engineering/implement/SKILL.md` |
| `matt-pocock-bug` | Matt Pocock | `skills/engineering/diagnosing-bugs/SKILL.md` |
| `matt-pocock-foggy` | Matt Pocock | `skills/engineering/wayfinder/SKILL.md` |
| `pstack-feature` | Pstack (Lauren Tan) | `skills/pstack/pstack-poteto-mode/playbooks/feature.md` |
| `pstack-bug-fix` | Pstack (Lauren Tan) | `skills/pstack/pstack-poteto-mode/playbooks/bug-fix.md` |
| `pclaude-feature` | PClaude | `skills/pclaude/pclaude-poteto-mode/playbooks/feature.md` |
| `pclaude-bug-fix` | PClaude | `skills/pclaude/pclaude-poteto-mode/playbooks/bug-fix.md` |
| `addy-commands` | Addy Osmani | `skills/addy/addy-using-agent-skills/SKILL.md` |
| `addy-bug-fix` | Addy Osmani | `skills/addy/addy-using-agent-skills/SKILL.md` |

Factory today: `grill` is a Conversation node; `implement`, `prove`, `review` and `decide` are one-copy Ticket nodes on `checkpoint: steward`; the Finish's act is `none` unless the Line brief sets one. Its edges:

- `grill.done -> implement`, `implement.done -> prove`, `prove.pass -> review`;
- `prove.fail -> implement`, cap 2, `stewardExtra`, held when spent;
- `review.clean -> decide`, `review.findings -> decide`, `decide.ship -> finish`;
- `decide.another-round -> implement`, cap 1, going to `finish` when spent;
- `finish.revise -> implement`;
- `implement.closed`, `prove.closed` and `review.closed`, each to `decide`.

## What gets deleted

- **Core.** `Station`, `LineState`, `LineRound`, `LineProve`, `route()`, the six `*_ticket` writers, `StationSettings`, `FactoryStations`, `FactoryLimits`, `FactorySettings`, `resolve_factory`, `default_factory`, the old `LineBrief` and `find_brief`.
- **Engine.** `route_line`, `route_once`, `write_station_ticket`, `start_line`, `super_step_boundary`, `run_super_step`, `plan_super_step`, `ready_set`, `through_merge_hold`, `kick_processing`, `pool_checkout_planned` with the lone-Ticket path, `Session.super_step`.
- **Wire.** `LineView`, `station` on markers and cards, `factory` on `PoolConfig` and `MachineDefaults`, `ConversationRole::Grill`, `POST /api/line/start`.
- **CLI and UI.** `--factory`; `lineStrip`, the Station badge, Start the Line and `postStartLine`, `factory-settings.ts`, `renderFactoryFields`.
- **Last.** `prototype/horde-plan-mode/`, then this spec.

## Slices

Each slice lands green on the full suite with its conformance cases and unit tests, and regenerates `protocol/*.ts` when it touches wire types. Cases import only types from `protocol/protocol.ts` and `protocol/wire.ts`, and run on the release binary (`cd ui && bun install && bun run build`, then `cargo build --release`).

1. **The rolling scheduler, every pool.** The riskiest slice: it changes every pool. `tick`, `eligibility`, `Session::wake`; the per-blocker merge gate with its explicit hold and engine-run rules; a worktree for every Ticket; per-Ticket exits (crash Interrupts, verify groups, conflicts, checkpoint rows); answers and config each tick; verify groups rebuilt at boot. The Factory still runs on the old `route_line`, called from the tick.
   - `grep -rliE 'super.?step' conformance/cases` lists 35 case files, each reworded or rewritten: `scheduling`, `interrupts-queued`, `interrupts-close`, `interrupts-answers`, `interrupts-keep-talking`, `interrupts-persistence`, `steward/notices`, `steward/teaching`, `steward/answers`, `pool-routes`, `spawns-adoption`, `spawns-blocks`, `spawns-pending`, `spawns-proposals`, `spawn-steward-routes`, `takeover`, `restart-tickets-spawns`, `restart-tickets-durability`, `restart-tickets-terminal`, `restart-tickets-orphans`, `restart-tickets-answers`, `server-terminal-phases`, `merges-worktrees`, `herdr-panes-finished`, `herdr-panes-survey`, `herdr-workspace`, `formats-ledger`, `formats-markdown`, `conversations-notices-texts`, `config-reload`, `verify-grading`, `verify-rounds`, `attempts-launch`, `pane-routes`, `factory-settings`. Also `conformance/harness/prompts.ts`, `pool-state.ts`, `areas.ts` and `takeover.ts`.
   - `merges-hold` becomes `merges-gate`: a dependent waits for its own blocker's merge while an unrelated Ticket starts. Also `merges-queue`; `merges-reconcile`, whose header assumes a lone Ticket runs in the pool checkout; `restart-tickets-merges`, which pins the `merge hold ... pool paused` log line; `verify-fanout`, whose Candidates are cut from one HEAD at launch; and `restart-tickets-verify`, which gains a case where a round stopped after every Candidate exited is graded once on restart, not fanned out again.
   - New `scheduling-rolling`: C, blocked by fast B, launches after B's merge while slow A runs; D, with no blockers, launches while B's merge is pending; a crash Interrupt lands at the exit.
   - Unit: an `eligibility` table, `wake` keeping its permit, the verify-group rebuild. `persist.rs` and `e2e_tests.rs` stop pinning row counts.
2. **`maxLive`, `started` spawns, the conflict count.** New `scheduling-max-live`: with `maxLive: 1` the second Ticket starts when the first ends, `verify: 2` runs alone, a resolver is not withheld. Rewritten: `config-settings-pool`, `config-settings-machine`, `config-reload` (it reloads), `spawns-blocks` (`blocks: [running-id]` is Held as `started`). New in `merges-resolver`: an unrelated Ticket starts during a waiting conflict, whose Interrupt then says 1 started since.
3. **Plan format, validation, library, Presets.** `ac_core::plan`, `PlanEdit` with merger placement, `library`, `factory-today` and the ten authors' Presets, and `plans.list`, `plans.get`, `plans.validate`, `plans.save`, `plans.delete`. New `plans-validate` (each rule refuses with its node or edge, all problems together, an uncapped cycle through an operator gate accepted), `plans-library` (fenced HOME: save writes the file, a Preset slug is refused, a broken file is listed with its problems), `plans-presets` (each validates and has `author` and `source`). Unit: merger placement and lifting for every edit, nested-loop derivation, every Preset parses.
4. **The run core replaces `route()`.** `LineRun` for one-copy Ticket nodes, loops (caps, nested reset, `whenSpent`, loop holds), gates, the Finish hold and its refusal, the Finish Ticket, `closed`'s default; `line.json`, `POST /api/line`, `boot --plan <slug> --brief`, `node=` and `hold` markers, `steward_may_answer`. Deletes Stations, Rounds, `route()`, the writers and the Factory settings layers.
   - Rewritten from `factory-*`: `line-start`, `line-routing` (the spent Prove hold buys one traversal, and survives a restart), `line-finish` (approval refused while a non-Line Ticket runs; `finish-1-act` opens the draft PR after approval), `line-base`, `line-base-cli`, `cli-boot-plan` (from `cli-boot-factory`), `steward/line` (from `steward/factory`: no-verdict answered, Finish hold refused, loop hold answered once on `stewardExtra`). `factory-settings` is deleted.
   - New `line-close`: Closing `implement-1` runs Decide with `halted`, and an unrouted `closed` reaches the Finish. New `restart-line`: a stop after `prove-1` is done but before its merge writes `review-1` once, after the merge; a deleted unlaunched projection is rewritten byte for byte; a stop between approval and `finish-1-act` writes it once.
   - Unit: transitions over a fake `LineFacts`, observe and apply idempotence, id determinism, blocker lists.
5. **Conversation nodes.** Conversation passes, briefs read from the branch each advance, `conversations.end {close}`, `boot --plan --work`; `POST /api/line/start` and Start the Line removed. Rewritten: `factory-grill` as `line-conversations` (End refused without a brief; a valid brief merges, then `implement-1`; its items reach a per-item node; End as closed hands on `closed`), `factory-line-keep-talking` as `line-keep-talking`, `restart-conversations-boot` (a stop after End and before the merge still hands on once), `conversations-lifecycle`, `http` (the route list). Unit: brief parsing, absorption order.
6. **Per-item copies, items, the Merger.** `Outcome.items` with bounds, `makesItems` teaching, per-item passes and their queue, both hand-on modes, conflict policy from the Merger. New `line-copies`: 5 items under cap 2 start exactly 2 harnesses, a third when one exits; ids `build-1.1` to `build-1.5`; the next Ticket is blocked by the done copies and written after the fifth merges; a checkpointed copy keeps its slot; a closed copy is absent from `after`. New `line-merger`: with no Merger, one downstream Ticket per settled copy; `conflict: wait` raises a merge-conflict Interrupt and holds the pass; `resolver` runs on the Merger's harness, seen in argv. Rewritten: `spawns-schema` (malformed `items` dropped with a log line, the attempt still done). Extended: `restart-line` (a stop mid-pass with 3 queued duplicates no copy).
7. **Steward powers and running-Line edits.** `line.plan.edit`, `POST /api/steward/plan`, `check_edit`, parked handoffs flowing on Link, the `stewardEdits` gate. New `line-plan-edit`: rev bumps, a stale rev is 409, removing a live node is refused, linking a parked verdict writes the downstream Ticket, `line.json` changes and the library file does not. Extended: `steward/line` (edits refused without `stewardEdits`, an `open: steward` gate answered, an operator gate refused).
8. **The live Line graph.** `LineGraphView` and its deltas, the Line view on the canvas. Rewritten: `protocol-cards` (a 5-item pass shows 2 running, 3 queued and the Finish's `waitingFor`), `protocol-deltas`, `http-page`. UI: projection tests in `bun test`; harness scenarios for graph render survival and copy click-through.
9. **The Plans view and Boot's picker.** The editor, `plans.boot`, Boot's plan question, the Settings changes. New `cli-boot-plan` cases (Presets then library slugs, `--plan` skips the question, `--yes` takes `factory-today`) and `plans-boot` (the Boot argv). UI: editing, inline problems, save and save as; harness gestures for drag-to-link and node drag.
10. **Live run and cleanup.** Delete `prototype/horde-plan-mode/`, record Done means items 2 and 3 with `/my-verify`, delete this spec last.

## Open risks

- **Rolling everywhere.** A plain pool whose Tickets leaned on a fully merged main without declaring `blocked-by` now starts them before unrelated work merges. The fix is declaring blockers. Slice 1 should check the operator's live pools first.
- **Cost under `all`.** With `maxLive` unlimited by default, a per-item `all` node on 30 items starts 30 harnesses. Presets using `all` should say so in their note.
- **Dots in Ticket ids.** Checked in slice 6: a dot passes the marker parser, `blocked-by`, branch names (`git check-ref-format` accepts `pool/<key>/build-1.3`), `worktree_path_for` and the run-file names, so Copy ids keep it and the `build-2-3` fallback is not needed. One consequence: markers launch in file-name order, so under a cap of 10 or more `build-1.10` launches before `build-1.2`.
- **Engine-chosen Conversation ids.** A Conversation node pass needs the id `grill-1`, and today the engine mints Conversation ids from its own counter. Slice 5 must let the Line name them without collisions.
- **Factory-today divergences.** The three behaviour changes in Done means item 1 are deliberate. If Finish notes must leave Decide's extra-Round count alone, `finish.revise` needs a way to exempt it from the reset, and nothing here offers one.
- **The act's idempotence is taught.** The engine cannot stop an agent opening a second PR; the url check at exit catches a missing result, not a duplicate.
- **Frozen Plans and a stricter validator.** A frozen Plan that stops validating after an upgrade refuses the Line at boot with its problems. Bump `horde` when a rule breaks old files.
- **Suite time.** The suite takes about 50 minutes and slice 1 touches about 40 files. Run the touched areas first, then the whole suite once per slice.
