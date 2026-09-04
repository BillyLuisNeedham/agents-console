# Show each ticket's Assignment on its card

Closes issue #35. Grilled design; prototype validated on branch `35-harness-model-assignment-prototype` (variant A won; variants B and C rejected). Glossary: **Assignment** in CONTEXT.md; precedent: ADR-0007, extended by ADR-0012.

## Problem Statement

When Billy looks at the Console's canvas, he cannot tell which harness and model any ticket will run (or ran) on. The pool's console.json holds `defaults` and per-ticket `assign` blocks, and the engine resolves them — but the result never reaches the UI. Answering "which rig is ticket 07 on?" means opening the config file and mentally replaying the override and inheritance rules.

## Solution

Every ticket card carries a badge under its head naming its resolved Assignment: harness, model, and drivers. The engine — which already resolves assignments — puts the resolved records on the snapshot; the card renders them verbatim. The badge is always visible, on every ticket kind, in every phase. Long values truncate with an ellipsis; clicking the badge expands it to the full text in place.

## User Stories

1. As the operator, I want to see each ticket's harness on its card, so that I know which harness will run it without opening the config.
2. As the operator, I want to see each ticket's model on its card, so that I can spot a ticket running on the wrong model before it starts.
3. As the operator, I want to see each ticket's drivers on its card, so that I can tell an `implement code-review` ticket from a plain `implement` one at a glance.
4. As the operator, I want the badge to reflect field-wise overrides, so that a ticket overriding only its model shows that model with the pool's default harness.
5. As the operator, I want grader tickets to show the Assignment they inherited from their build ticket, so that I know which rig graded an attempt.
6. As the operator, I want head-to-head tickets to show the Assignment they inherited, so that I know which rig judged the runoff.
7. As the operator, I want spawned tickets to show the Assignment they inherited from their parent, so that follow-up work visibly runs on the parent's rig.
8. As the operator, I want the badge on cards whose tickets are still ready, so that I can review the pool's rig allocation before starting the run.
9. As the operator, I want the badge on working cards alongside the Vitals, so that I can see what is running and on what rig at the same time.
10. As the operator, I want the badge to stay on done and failed cards, so that I can answer "which rig did this ticket run on?" after the fact.
11. As the operator, I want a ticket with no defaults and no assign entry to show `unassigned`, so that a misconfigured pool is visible on the canvas rather than discovered at spawn time.
12. As the operator, I want long harness/model pairs truncated to one line, so that badges don't stretch or wrap cards unevenly.
13. As the operator, I want to click a truncated badge to see the full text in place, so that no value is ever unreadable.
14. As the operator, I want the badge to show only the Assignment itself — no provenance labels like "pool default" — so that cards stay quiet and scannable.
15. As the operator, I want the badge in the same position on every card regardless of attempt state, so that it never jumps vertically when Vitals appear or disappear.

## Implementation Decisions

- **Single derivation, server-side (ADR-0012).** The engine already resolves every ticket's Assignment into its session state. That resolved map goes onto the snapshot; the UI renders it verbatim. No client-side resolution, no second derivation — the drift argument of ADR-0007 applies unchanged. The prototype's client-side resolver is discarded with its branch.
- **Wire contract.** One record per ticket, carried on the snapshot alongside the existing ticket metadata. Shape (from the prototype's resolver, trimmed to what survives the grill):

  ```ts
  { harness: string | null; model: string | null; drivers: string }
  ```

  `drivers` is the engine's space-separated chain string, with the engine's existing fallback of `implement` when unset. `harness`/`model` are null only when the ticket is unassigned. No provenance field: the grill rejected source labels, so `source` is not on the wire.
- **Resolution rules are the engine's existing ones, unchanged:** a ticket's assign entry overrides the pool defaults field by field; grader, head-to-head, and spawned tickets inherit from their build or parent ticket rather than the pool defaults. This spec adds exposure, not new semantics.
- **Badge placement.** Its own row directly under the card head, above the Vitals row. Vitals appear only on cards with a live attempt; the badge's position must not depend on them.
- **Badge content.** `harness · model · drivers`, middle-dot separated, rendered exactly as resolved — including `implement` when that is the drivers value (the grill explicitly kept it). Every ticket kind gets a badge: ordinary, grader, head-to-head, spawned.
- **Unassigned.** A ticket resolving to no harness and no model renders a muted `unassigned` badge.
- **Overflow.** One line, ellipsis (model truncates before harness). Click toggles the badge to wrapped full text in place; clicking again collapses it. No tooltips, no popovers.
- **UI location.** The badge render folds into the canvas module beside the Vitals render; styling joins the main stylesheet. No new UI module, no new component framework.
- **No config surface changes.** console.json's `defaults`/`assign` schema is untouched; `drivers` remains a string there (the prototype's array normalization was wrong and is dropped).

## Testing Decisions

Good tests assert external behavior at the seam — the snapshot on the wire and the engine's resolved assignments — never DOM structure, CSS, or internal function names.

- **Primary seam: the enriched snapshot (server tests).** A pool with `defaults` and `assign` blocks produces a snapshot whose tickets carry the resolved records: defaults applied, full override, field-wise partial override, unassigned ticket. Prior art: the existing enriched-snapshot tests (pool name, ticket metadata).
- **Secondary seam: engine resolution (engine tests).** Grader, head-to-head, and spawned tickets inherit from their build/parent — the cases that would require whole verify runs to reach through the server seam. Prior art: the existing assign/drivers engine test and the verify/selection tests that already spawn grader and head-to-head tickets.
- **UI: no test seam.** The canvas has no test framework; the badge is verified manually against a demo pool, as Vitals were.

## Out of Scope

- Editing assignments from the UI — the badge is read-only.
- Provenance display ("pool default" / "ticket override" / "from 04") — rejected in the grill.
- Hiding or condensing the default `implement` drivers value — rejected in the grill.
- Any change to resolution semantics, the console.json schema, or spawn/verify machinery.
- Color-coding cards by harness (prototype variant B) and the assignments table panel (prototype variant C) — both rejected.
- Exposing `verify` on the wire record — Verify keeps its own surfaces.

## Further Notes

- Prototype branch `35-harness-model-assignment-prototype` is throwaway: nothing lifts from it except the wire record shape above and the validated layout decisions (badge under the head stacks cleanly with the Vitals footer; 280px cards truncate the model first).
- The badge must hold up on touch, hence click-to-expand in place rather than hover tooltips.
