# Needs-input tray: the Console's bulk answer surface

Closes https://github.com/BillyLuisNeedham/agents-console/issues/27 (bulk resume calls).
Design prototype (throwaway): branch `prototype/bulk-resume`, variant B (`chromeB` in `ui/src/prototype/variants.ts`). Rewrite, do not promote.

## Problem Statement

A harness crash — or a machine restart — leaves several tickets interrupted at once, each waiting on a resume with its own instruction ("clean the worktree first", "skip the flaky test"). Today the Console answers interrupts one at a time through each ticket's card or Detail form: open ticket, read the interrupt, type the note, hit resume, repeat. With four or five tickets down after a crash this is slow and easy to get wrong — notes get retyped, a ticket gets missed, and the operator cannot see the full queue of what is waiting.

The engine already supports the batch: it accepts any number of answers immediately and drains them together at the next super-step boundary (ADR-0004). What is missing is the Console surface that lets the operator work the queue.

## Solution

Add the **Needs input** tray: a fixed overlay on the left of the Console listing every ticket with an unresolved Interrupt, with a count in its header. Each row carries the ticket id, the interrupt kind, and that interrupt's own actions — a note field plus resume for the resume kinds, approve/reject for review and merge-approval. A header button resumes every open resume-kind row at once, each with its own note.

The tray is the operator's work queue, not a new answering path: it answers interrupts through the exact same seam as the card and Detail forms, so an answered row greys out in place as "answered · waiting" and disappears when the super-step boundary drains it. Clicking a row's ticket id selects the card and opens its Detail, where the same interrupt is answerable at full size.

The tray collapses to a badge showing the count, and hides itself entirely when nothing needs input.

## User Stories

1. As Billy, after a harness crash takes down several tickets, I want one list of everything waiting on me, so that I can see the whole queue without hunting across the canvas.
2. As Billy, I want to type a per-ticket instruction into each waiting row, so that each resume carries the context that ticket needs.
3. As Billy, I want a single "resume all" action that fires every open resume with its own note, so that recovery from a crash is one click after the notes are in.
4. As Billy, I want an answered row to grey out in place as "answered · waiting", so that I can see the engine accepted my answer and is holding it for the super-step boundary.
5. As Billy, I want waiting rows to stay visible until the boundary drains them, so that the tray never lies about what is still pending.
6. As Billy, I want review and merge-approval interrupts in the same tray with their approve/reject actions, so that the tray is the single place I work every kind of input the pool needs.
7. As Billy, I want to click a row's ticket id to open that ticket's Detail, so that I can read the full interrupt body or the ticket log before answering.
8. As Billy, I want the Detail form and the tray row to answer the same interrupt through the same seam, so that answering in one place updates the other with no special-casing.
9. As Billy, I want the tray to collapse to a badge with the count, so that it does not cover the canvas while I work.
10. As Billy, I want the tray gone entirely when nothing needs input, so that an idle pool shows no dead chrome.
11. As Billy, I want my half-typed notes to survive live snapshots, so that a pool update never eats an instruction I was writing.
12. As Billy, if one of several parallel resumes fails, I want that row marked with an inline error and a retry, while the other answers stand, so that one bad ticket never forces me to redo the batch.
13. As Billy, I want no server change for this feature, so that the Console works against every pool engine already deployed.
14. As a future reader of this codebase, I want "Needs input" in CONTEXT.md as the name of this surface, so that prose and code share one term.

## Implementation Decisions

- **UI-only change.** The engine and server are untouched. The wire path is the existing one: one `POST /api/resume` per answer, and the tray's bulk action fires N of them in parallel. A batch endpoint is deferred as optional polish.
- **One seam, extended.** The tray's data derives from the existing projection seam (snapshot → view model): a new pure projection maps the pool snapshot to tray rows — ticket id, node id, title, the interrupt with its form (reusing the existing interrupt-form config so all six kinds render, and unknown kinds fall back to a plain resume form exactly as cards do), and the queued flag matched from the snapshot's queued answers. No new data source; the tray reads what the cards already read.
- **The bulk action covers resume-kind rows only.** Rows whose interrupt form has a single action (checkpoint, crash, deadlock, merge-conflict) are answerable in bulk; the header button is "resume all N" where N counts open rows of those kinds, and it fires each row's resume with that row's note. Review and merge-approval rows render their own approve/reject actions and are answered individually — a bulk approve/reject is a judgment the operator makes per ticket.
- **Row actions mirror the interrupt's form.** Each row renders the same action set the card/Detail form renders for that kind, note field included (the engine appends the note on every answer path). Approve/reject rows reuse the form's labels and tones.
- **Answered-and-waiting rows grey out in place.** A row whose interrupt has a matching queued answer renders as "answered · waiting", its actions disabled, until the boundary snapshot drops the interrupt. (Locked grilling decision.)
- **A new view module owns the tray.** Following the canvas/detail/drawers split: one module owns the tray's per-session state — note drafts keyed by ticket id (pruned against pending interrupts on every render, as the Detail does), the collapsed flag, and per-row answer errors — and renders from the model; the composition root wires it beside the canvas, Detail, and drawers. The full-DOM rebuild on every snapshot never drops a draft.
- **Placement: fixed left overlay, collapsible to a badge.** The tray overlays the canvas on the left; collapsing leaves a badge reading "needs input · N". At zero pending interrupts the tray and badge are both hidden. (Locked grilling decisions.)
- **Row click selects the card.** A row's ticket id behaves like a card tap: it selects the node and opens the Detail through the existing selection handler.
- **Per-row failure surface.** The answer handler gains a promise interface (resolving on accept, rejecting on failure) so the tray can mark a row "answer failed · retry" without disturbing the other rows; the Detail's existing fire-and-forget use is unchanged. Retry refires that row's action with its note. A failure never clears the note draft.
- **Ordering.** Rows order the way the cards order — the projection's existing card order — so the tray and the canvas agree.

## Testing Decisions

- **Seam: the existing projection seam.** Tray rows are a pure function of the pool snapshot, tested with fixture snapshots exactly as the projection tests do today. No new seam is introduced; the tray module's state machine (drafts, collapse, per-row errors) is tested as a class with hand-settled fake promises, as the log-pane tests do.
- Good tests assert externally visible behavior only: which rows a snapshot projects, in what order, with which forms and queued flags; that a draft survives a re-render; that a rejected answer marks only its own row and a retry refires it. They do not assert on DOM structure or CSS.
- New projection tests cover: a snapshot with several interrupts across kinds projects one row each; queued answers mark their rows waiting and exclude them from the bulk count; review/merge-approval rows carry approve/reject forms and are excluded from the bulk count; zero interrupts projects an empty tray; an unknown interrupt kind projects a plain resume row.
- New module tests cover: note drafts keyed by ticket id survive a re-render and are pruned when the interrupt resolves; collapse/expand preserves drafts; a rejected answer leaves the row's error and note intact while a parallel accepted answer greys its own row; retry refires with the same note; the bulk action fires exactly the open resume-kind rows, each with its own note.
- Prior art: the fixture-snapshot tests in the projection test suite, and the deferred-promise fake-fetch pattern in the log-pane test suite.

## Out of Scope

- A batch resume endpoint on the pool server (optional later polish; the engine's accept-now/drain-at-boundary contract already handles N answers).
- A shared note applied to every ticket at once (prototype variant C's idea; per-ticket notes only in v1).
- Card checkboxes or any selection model on the canvas (prototype variant A; rejected).
- Bulk approve/reject of review or merge-approval interrupts.
- Any change to the card or Detail interrupt forms, the engine, the server API, or the SSE snapshot shape.
- The prototype itself: `prototype/bulk-resume` stays a throwaway branch; nothing under `ui/src/prototype/` merges to main.

## Further Notes

- CONTEXT.md already carries the **Needs input** term (added when the design locked); this spec is its first consumer.
- The prototype's `chromeB` is the look-and-feel source of truth for the tray (header with count and bulk button, per-row note + action, greyed waiting rows); treat its `proto-*` styling as a sketch to restyle natively, not to ship.
- The Console currently has no partial-failure surface anywhere (a failed answer is one global banner); the per-row error pattern introduced here is the first, and the natural template if cards/Detail later want the same.
