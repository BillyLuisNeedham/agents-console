# Render-survival harness

A manual, real-browser proof of what survives the Console's re-renders. It is
**not part of `bun test`**: the checks need scroll metrics, focus and pointer
capture, which the DOM-less bun suite cannot give.

## What it proves

The page mounts the real `ConsoleView` over the real `ConsoleSession` with fake
seams (a fixture pool of tickets, interrupts, Conversations, a long log, a long
spec), then does what an operator does:

- scrolls every `overflow: auto` region styles.css declares and a live module
  renders (`.detail-open`, `.log-pane-content`, `.log-lines`,
  `.needs-input-rows`, `.conversations-tray`, `.enlist-picker`, the Spawns
  list and an expanded proposal's body, and the three `<pre>` blocks that only
  scroll when their content is taller than the panel)
- focuses the Needs input tray's note field with a caret mid-text
- pans the canvas with a pointer drag
- records the identity of a few nodes (cards, the Detail, the trays)

then renders five times with the same model (a poll tick) and once more from a
changed snapshot (a live SSE snapshot), and after each render asserts that
scroll positions, focus, caret, canvas pan and node identity are unchanged.
Three scenarios cover the Detail's Spec, Progress and Outcome tabs, since only
one is on screen at a time, and one more the Detail of a Pending spawn's faded
card (issue #150), whose card and a Held spawn's keep their nodes too.

## Run it

```sh
cd ui
bun harness/run.ts          # table; exit 1 on any FAIL
bun harness/run.ts --json   # the raw report
```

It builds `harness/` with Vite into `harness/dist`, serves it on a free port
(module scripts do not load over `file://`), opens it in headless Chromium
(`CHROMIUM=/path/to/chromium` to override `/usr/bin/chromium`), and reads the
report the page writes into `<pre id="report">`. The dumped page lands in
`harness/dist/page.html` for a look at what actually rendered.

Typecheck the harness with `./node_modules/.bin/tsc --noEmit -p harness/tsconfig.json`.

## Reading the table

- `PASS` / `FAIL`: the assertion held, or broke, across all six renders (the
  detail names the first render that broke it).
- `skip`: nothing to assert. Either the region is absent in that scenario, or
  the fixture does not make it overflow ("not scrollable in fixture"), or the
  selector is dead CSS no live module renders.

After the renders it makes the gestures an operator makes next, since a
handler bound to the viewport per render would stack: one pan must move the
world once, one wheel notch must zoom it once, and a card dragged with a render
landing mid-drag must land where both moves put it. A fourth scenario toggles
the Detail to fullscreen and checks the class and the measured top edge hold.
A last one types into a Settings text field key by key, with a caret
mid-text, and checks each keystroke re-renders on its own, the field keeps its
node, focus and caret, and the pool's Save enables and greys out again on a
revert (issue #142).

## Baseline on the `replaceChildren` renderer (2026-09-21)

Before the morph (ADR-0025), everything that survived did so by a hand-rolled
rescue around the rebuild: the log pane's reading-position restore, a keyed
focus capture/restore, and the canvas's `bindCanvas` re-applying the pan.
Every other scrolled region snapped back, and no node kept its identity. The
Needs input tray landed at a nonzero but wrong position because `focus()` on
the restored note scrolled it into view.

## With the morph

Every assertion passes with the rescues deleted. What remains after the commit
is the log pane's tail pin and prepend anchor (`settleLogScroll`), because the
pane is one text node and the browser's scroll anchoring has nothing to hold
when it grows at the top, and the canvas's edge drawing, which needs the cards
laid out.
