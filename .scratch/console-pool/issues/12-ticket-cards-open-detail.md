<!-- state: id=12 blocked-by=none status=ready -->

# 12 — Ticket cards open the Detail panel

Spec: `.scratch/console-pool/spec-console-flight-fixes.md`

## What to build

Clicking any card on the canvas selects it and opens the right-hand Detail panel at full size: its status, channels, and pending interrupt, answerable there. Today a click on a ticket card only toggles the card's inline expansion and never selects, so the Detail is unreachable for tickets (start and review cards work). The inline card expansion is retired: the card stays a summary, the Detail is the single place a ticket is read and its interrupt answered. Clicking the already-selected card clears the selection and closes the panel, matching the utility cards' toggle.

## Acceptance criteria

- [ ] Clicking a ticket card of any status (ready, in-progress, checkpoint, done, interrupt pending) opens its Detail panel
- [ ] Clicking the selected card again clears the selection and closes the Detail
- [ ] The inline card expansion is retired; a card click drives the Detail only
- [ ] A pending interrupt remains answerable from the Detail's form
- [ ] Selection survives live snapshots, and selecting a card that has left the pool closes the Detail gracefully
- [ ] Selection-reducer and projection tests extended at the existing seams; full test suite, typecheck, and build clean

## Blocked by

None — can start immediately.

## Notes

- Root cause (found in proving-flight diagnosis): the click branch in the canvas view routes ticket-card clicks to the inline expand toggle and only utility-card clicks to selection, a leftover from the thread-driven Console. The pool-era projection and Detail renderer already handle ticket cards fully and have tests behind them, so this is a wiring change at the click handler plus removal of the expand path, not new rendering.
- The dead `.node-card-active` / `.node-card-next` styles and the expansion's CSS are candidates for removal with the feature; keep the sweep tight.
- Parent-spec interaction: spec-ticket-pools story 22 asked for the Brief as an interrupt on the card and in its Detail. This spec supersedes the card half: the Detail is the answering surface (agreed in the grill: Billy answers in the right-hand panel, never on the card). Note the amendment in the ticket's closing notes so ticket 11's review sees it.
