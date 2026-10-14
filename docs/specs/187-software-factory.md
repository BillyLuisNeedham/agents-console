# The Factory (issue #187)

What the Factory is and how to build it. ADR-0037 (the Factory is an engine-owned recipe) and ADR-0038 (Prove checks merged work on the Line's branch) decide the shape; the glossary's Factory section (`CONTEXT.md`) names the parts. This file lives in `docs/specs/` and goes before the PR.

## The Line, end to end

```
Boot (Factory mode) ── cuts line/<slug> from main, boots the pool, opens the Grill
  Grill (Conversation; my-grill-with-docs + show-me) ── writes spec, ADRs, Line brief
  operator: Start the Line ── merges the Grill's branch, ends the Grill
  Round n:
    Implement ─▶ Prove ─pass─▶ Review ─▶ Decide ─round─▶ Round n+1 (Decide may start 1 extra)
                   └─fail─▶ fix Implement ─▶ Prove   (2 per Round, then a checkpoint)
                                                   └─finish─▶ Finish
  Finish ── the Finish act (default: none) ─▶ report ─▶ Finish checkpoint for the operator
    Resume "approved" ─▶ Line done          Resume with notes ─▶ another Round (past the limit)
```

A Factory pool runs exactly one Line. Its target branch is the Line's branch, cut from main by Boot, never a shared branch.

## Stations

| Station | Citizen | Default skills (drivers) | Default Assignment | Verdict in its Outcome |
| --- | --- | --- | --- | --- |
| Grill | Conversation | `my-grill-with-docs show-me` | claude opus high | none: it writes the Line brief |
| Implement | Ticket | `implement` | claude opus high | none: `done` routes to Prove |
| Prove | Ticket | `my-verify` | claude opus medium | `pass` or `fail`, with the evidence path |
| Review | Ticket | `code-review` | claude opus high | findings: each `{severity: must|should|nit, title, detail}` |
| Decide | Ticket | `html` (for the report) | claude opus medium | `round` (with the chosen fixes and the dropped ones, each with a reason) or `finish` |

- **Routing is the engine's.** The engine reads the verdict at the Outcome, keeps the counters, and creates the next Station's Ticket. Its body comes from the spec path plus the previous Outcome: Prove's failure Brief for a fix, Decide's chosen fixes for a new Round, the per-Station note or override from the Line brief, and the Station's extra instruction. Agents never propose the next Station.
- **Decide accounts for every must.** It fixes it in the next Round or drops it with a reason. It may also pick shoulds and nits.
- **No verdict, no guess.** An Outcome with a missing or invalid verdict checkpoints its Ticket with the Brief "no verdict". Resume or Keep talking asks for one, and the Steward may answer.
- **The Prove limit.** A third Prove failure in one Round checkpoints the Line. Each Resume with a note buys one more fix, and the note goes into its body. Close halts the Line: Decide still writes the report so far and the Line ends at the Finish checkpoint.
- **Switched-off Stations.** With Prove off, Implement routes to Review. With Review off, Prove's pass routes to Decide, which then has no findings to account for.
- **Ids are readable.** `r1-implement`, `r1-prove`, `r1-fix-1`, `r1-prove-2`, `r1-review`, `r1-decide`, `r2-implement`, …
- **Station Tickets are ordinary Tickets**: interactive herdr panes, with Resume, Keep talking, Close and Reassign. Closing a Station Ticket halts the Line at a checkpoint asking what next.
- **Ad-hoc spawns inside a Line** (anything a Station or the Grill proposes) are always Held spawns. The Steward may Adopt one only when the operator has told it to, through a pool setting (`steward.mayAdoptLineSpawns`, default false).

## Settings

Layered, each field falling through on its own: Machine defaults → Pool settings → the Line brief.

```json
"factory": {
  "stations": {
    "implement": { "drivers": "implement", "assign": { "harness": "claude", "model": "opus", "effort": "high" }, "note": "" },
    "prove":     { "enabled": true, "drivers": "my-verify", "assign": { "effort": "medium" } },
    "review":    { "enabled": true, "drivers": "code-review" },
    "decide":    { "drivers": "html", "assign": { "effort": "medium" } },
    "grill":     { "drivers": "my-grill-with-docs show-me" }
  },
  "limits": { "proveFailsPerRound": 2, "extraRounds": 1 },
  "finish": "none"
}
```

The Settings pane edits the machine and pool layers. They reload at the super-step boundary like the rest of the reloaded slice (ADR-0018). The Line brief may override any field for its own Line.

## Line brief

Written by the Grill at `docs/specs/<line>.brief.json` on the Grill's branch (or handed to Boot ready-made, see below):

```json
{ "spec": "docs/specs/<line>.md", "finish": "none | draft-pr | pr | <free text the Decide agent carries out>", "factory": { …any settings override… } }
```

Start the Line refuses with a reason when the brief is missing or invalid.

**Ready brief.** Boot's Factory mode also accepts a ready brief and spec (`--brief <path>`, the brief naming its spec file). That pool has no Grill. Boot commits the spec (and the brief) onto the new Line branch as `docs/specs/<line>.md`, and Round 1 starts at once. It is for work already well specified, and for the overnight pilots.

## Finish

Decide carries out the Finish (default: none), then writes the report with `/html` to `runs/<line>-report.html`: every Round's Prove evidence, every Review finding and what happened to it, and the Finish's result (e.g. the PR link). When the Finish opens a PR, Decide first deletes `docs/specs/<line>*` in a final commit. The Finish checkpoint's Brief links the report.

## Console

- The header gets a Line strip: `Round 2 · Prove · fails 1/2 · Finish: draft PR`.
- Each card carries its Station label.
- The Finish checkpoint's Detail shows the report in place, with Open in browser.
- Boot asks for the piece of work (an issue number or free text) when Factory mode is chosen.
- In a Factory pool the run-wide Review Interrupt never fires: approving the Finish checkpoint is the Review.
- The Steward is on by default in a Factory pool. It never answers the Finish checkpoint.

## Slices

Each lands with conformance cases for everything it changes that is visible from outside the server (AGENTS.md), plus unit tests.

1. **Line core.** Line state on disk. A Station tag on Tickets. Typed verdicts parsed from the Outcome. Engine routing and the two counters. Readable ids. The no-verdict checkpoint, the Prove-limit checkpoint, Close halting a Line, and ad-hoc spawns held. Everything is driven from a Line brief with built-in default settings, and a Line is started by an HTTP call (Start the Line) on a pool booted with a ready brief. Conformance: a fake harness walks pass, fail and limit, round and finish, and no verdict.
2. **Station settings.** `factory` in Machine defaults and Pool settings, with field-wise fallthrough and Line brief overrides. The Settings pane. The Prove and Review off switches. The reload at the boundary.
3. **Boot's Factory mode, the Grill and Start the Line.** Boot asks for the work, cuts `line/<slug>` from main and opens the Grill Conversation on the Grill Station's skills with the issue as its first Turn. The Start the Line button on the Grill, operator-only, refused without a valid brief. `--brief` for a ready brief.
4. **Finish and the Console.** Decide's Finish and report. The report viewer in Detail with Open in browser. The Line strip and Station labels. Review suppression in a Factory pool. The Steward on by default, never answering the Finish, and `mayAdoptLineSpawns`.

## Pilots

Run once all four slices have merged and the draft PR is open, on the binary built from this branch (`bin/agent-console` rebuilds it when the sources are newer):

1. #186 (a Continued attempt's checkpoint Outcome drops its spawn array), from a ready brief with Finish `draft-pr`.
2. #179 (a harness the pane cannot find at launch crashes the Launch), the same way. It starts when #186's Line reaches its Finish checkpoint or halts. If the build finishes after about 03:00, both run in parallel instead.

Each pilot is its own Factory pool, with its Line branch cut from main. Its Steward is on with a budget of 10 and `mayAdoptLineSpawns: true`.

A Factory bug a pilot exposes is fixed by a Ticket in the build pool, merged to this branch and pushed to the PR. That pilot is then rerun once on the rebuilt binary, with at most 2 reruns in the night. A bug in the pilot's own work (the #186 or #179 fix) is not a Factory bug: its Line handles it.

There is no stop time: the night runs until the PR, both pilots and their reruns are done. It ends with a sitrep HTML in the build pool, linked from a PR comment.
