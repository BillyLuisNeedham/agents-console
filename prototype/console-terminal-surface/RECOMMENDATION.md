# Recommendation — Console ↔ herdr terminal surface (issue #29)

**Question:** how should an operator open and interact with a running Terminal-backed attempt's terminal from the Console UI — (a) open-in-herdr or (b) embedded xterm.js terminal?

**Leaning: hybrid, with (a) as the primary affordance.** Judge by feel first (`http://localhost:5299/?surface=a|b`), but the build surfaced hard technical facts that constrain the answer:

## What the prototype proved

### Surface B (embedded) has a fidelity ceiling
- `pane.read` (any source, `format: ansi`) returns **scraped text + SGR colors only — no cursor-motion, no OSC, no alternate-screen sequences**. Line-output agents render fine (this demo works). A full-screen TUI harness (opencode-style) **cannot be faithfully embedded** — you'd get a smear of repaints, not a terminal. herdr owns the real PTY; `pane.read` is a viewport scrape, not a PTY stream. node-pty + own-PTY was already rejected in ADR-0014.
- `revision` is useless for change detection (stays 0 while output grows) — the client must diff on text content. Works, but it's polling and it's lossy.
- Input works (text + `keys:["Enter"]`; a literal `\r` in text does NOT submit — bracketed-paste semantics), including ctrl+c and arrows. But every keystroke is a HTTP→unix-socket round trip, and full-screen TUIs need far more key fidelity than this path comfortably gives.
- Scrollback capped at 10 MB/pane (`truncated: true` shows up fast even in the toy demo).

### Surface A (open-in-herdr) is fidelity-perfect and nearly free
- `pane.focus {pane_id}` is one JSON-RPC call, works, instant. The operator gets the real terminal: full TUI support, native input, scrollback, copy/paste.
- Cost: the operator leaves the Console UI and context-switches to the herdr TUI window.
- The peek preview (read-only `pane.read` on the card) is genuinely useful — glanceable liveness without leaving the Console.

## Recommendation

**Ship (a) as primary: attempt card with read-only peek + "Open in herdr" (`pane.focus`) + copyable `herdr agent attach <pane_id>`.** This is the only option that works for TUI harnesses, which is the whole point of Terminal-backed attempts.

**Keep (b)'s door open, but scoped:** an embedded pane is fine as a *secondary* convenience for line-output harnesses (plain bash loops, build watchers). Do not promise it as a full terminal. If embedded is ever built, the read path should be incremental text-diff polling as prototyped — but consider it a "tail with input", not a terminal.

The deciding question for the grill session: **will `terminal: herdr` pools ever run full-screen TUI harnesses?** If yes → (a) primary, settled. If no, ever → (b) becomes viable as the primary.

## Demo facts
- Run: `bun prototype/console-terminal-surface/server.ts` → `http://localhost:5299/?surface=a` (switcher pill or ←/→ to flip).
- Input quirk: send `text` for printables, `keys:["Enter"]` to submit; `\r` in text does not submit.
- Safety: server refuses send/focus on any pane it didn't spawn (403) — live agent panes protected.
- Prototype spawn lands in herdr's currently-focused workspace (`pane.split` ignores cwd for workspace placement), `focus:false` respected.
