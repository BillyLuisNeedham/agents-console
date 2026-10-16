# PROTOTYPE — always-present Stop server button (throwaway, never merge)

Question: what should a Stop server control look like when it is offered in
every phase, not only `done`?

Run: `cd ui && bun run prototype:stop`, open http://127.0.0.1:5199/?variant=A
(A header button with cost-naming confirm, B floating kill switch with popover,
C hold-to-stop chip in the status line; `&phase=done`, `&demo=armed`,
`&open=settings`). Stop is stubbed.

## Verdict (2026-10-16)

1. None of A/B/C as placed: Stop lives in the Settings pane footer,
   left-aligned, opposite the Restart control.
2. Stopping while work is live leaves Ticket and Conversation panes alive in
   herdr; a relaunch picks them back up. The server's done-only 409 gate goes.
3. A `done` pool keeps today's single inline "Really stop?".
