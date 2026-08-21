<!-- state: id=12 blocked-by=none status=done -->

# 12 — Ticket cards open the Detail panel

Spec: `.scratch/console-pool/spec-console-flight-fixes.md`

## What to build

Clicking any card on the canvas selects it and opens the right-hand Detail panel at full size: its status, channels, and pending interrupt, answerable there. Today a click on a ticket card only toggles the card's inline expansion and never selects, so the Detail is unreachable for tickets (start and review cards work). The inline card expansion is retired: the card stays a summary, the Detail is the single place a ticket is read and its interrupt answered. Clicking the already-selected card clears the selection and closes the panel, matching the utility cards' toggle.

## Acceptance criteria

- [x] Clicking a ticket card of any status (ready, in-progress, checkpoint, done, interrupt pending) opens its Detail panel
- [x] Clicking the selected card again clears the selection and closes the Detail
- [x] The inline card expansion is retired; a card click drives the Detail only
- [x] A pending interrupt remains answerable from the Detail's form
- [x] Selection survives live snapshots, and selecting a card that has left the pool closes the Detail gracefully
- [x] Selection-reducer and projection tests extended at the existing seams; full test suite, typecheck, and build clean

## Blocked by

None — can start immediately.

## Notes

- Root cause (found in proving-flight diagnosis): the click branch in the canvas view routes ticket-card clicks to the inline expand toggle and only utility-card clicks to selection, a leftover from the thread-driven Console. The pool-era projection and Detail renderer already handle ticket cards fully and have tests behind them, so this is a wiring change at the click handler plus removal of the expand path, not new rendering.
- The dead `.node-card-active` / `.node-card-next` styles and the expansion's CSS are candidates for removal with the feature; keep the sweep tight.
- Parent-spec interaction: spec-ticket-pools story 22 asked for the Brief as an interrupt on the card and in its Detail. This spec supersedes the card half: the Detail is the answering surface (agreed in the grill: Billy answers in the right-hand panel, never on the card). Note the amendment in the ticket's closing notes so ticket 11's review sees it.

## Closing notes

- Click routing in `endDrag` (ui/src/view.ts) now sends every card to `selectNode`; the ticket/utility split is gone. `nextNodeSelection` already toggled, so re-click clearing came free.
- Expansion retired: `expandedTickets`, `toggleTicketExpand`, the card's `ticket-card-details` block, and the `.ticket-card-expanded` / `.ticket-card-details` CSS are removed, along with the dead `.node-card-active` / `.node-card-next` rules named in the Issue.
- Amendment for ticket 11's review: spec-ticket-pools story 22's card half is superseded. The card interrupt form is removed with the expansion; the card keeps only the interrupt dot, and `renderInterrupt` now renders in the Detail only. Billy answers in the right-hand panel, never on the card.
- Selection survival was already structural (selection id held outside the rebuilt DOM; `projectDetail` returns null for a departed card, closing the panel). Tests at the projection seam now pin it: per-status Detail, interrupt form in the Detail, status change across snapshots, departed card.
- Verified: `bun test` 103 pass / 0 fail, `tsc --noEmit` clean, `bun run build` clean. Mid-run the suite showed one failure from ticket 13's in-flight stream test (its agent was editing engine/server.ts concurrently); my diff was verified in isolation on a clean worktree at HEAD (102/0), and the shared tree went green once 13's fix landed. Commit `3a36537` touches only ui/src/view.ts, ui/src/styles.css, ui/src/project.test.ts.
