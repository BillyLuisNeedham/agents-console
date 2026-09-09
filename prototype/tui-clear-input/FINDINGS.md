# FINDINGS: clearing the input area of live TUIs

Spike date: 2026-09-09. Live against herdr 0.8.2 (socket API), opencode
1.18.29, cursor agent CLI 2026.09.02-c22c1a3, script from util-linux, all
running in real herdr panes on the operator's machine. Every claim below is
observed, not assumed; where a claim is inferred it is labelled inference.

claude is out of scope on this machine (login expired). It was not launched.
The operator verifies claude's clear key manually on another machine.

This spike answers the retry-corruption risk in `deliverPromptInner`: a
false-negative echo re-pastes the full prompt on top of whatever still sits
in the input. The paste-delivery prototype already showed a lost paste can
leave the input empty; this one covers the other failure, where the paste
landed and a retry would append.

## Method

One fresh unfocused herdr tab per trial, harness launched under
`script -qfc '<cmd>' <typescript>` as the engine does. After a stable ready
frame (three consecutive matches), a distinctive 10-line paste (unique
`SPIKECLEARMARKER` tokens, including FIRST and LAST lines) is sent through
`pane.send_input` text. The candidate keys follow. The pane is read with
`lines=200`. A full clear is zero tokens remaining and the empty-input
placeholder back; a last-line-only kill is a partial, not a pass. A 24-line
paste was also tried on opencode first and showed the same ctrl+u partial.

herdr 0.8.2 rejects the key name `delete` (`invalid_key`). The ticket's
select-all+delete candidate was therefore sent as `ctrl+a` then `backspace`.

## 1. opencode

Ready frame: `Ask anything` (input placeholder) and footer `tab agents`. No
trust dialog.

| Candidate | Keys | Result |
| --- | --- | --- |
| ctrl+u | `ctrl+u` | **partial (last line only)**. 10 tokens → 9, LAST gone, earlier lines remain. |
| esc | `esc` | **uncleared**. 10 tokens, LAST remains. Pane identical to post-paste. |
| select-all+delete | `ctrl+a`, `backspace` | **uncleared**. 10 tokens remain. ctrl+a is beginning-of-line, not select-all. |
| ctrl+a then ctrl+k | `ctrl+a`, `ctrl+k` | **partial (last line only)**. Same shape as ctrl+u. |
| ctrl+c | `ctrl+c` | **cleared**. 0 tokens. `Ask anything…` placeholder returned. TUI chrome (`tab agents`, version) still present. |

**Verified clear-key sequence: `ctrl+c`.**

Empty-input ctrl+c **exits** the TUI (pane returns to the bash prompt). Do
not send ctrl+c at a ready frame whose input is already empty.

Paste → ctrl+c → paste: the second paste lands (10 tokens, LAST visible).
The retry cycle works when the first paste actually occupied the input.

## 2. cursor

Ready frame: header `Cursor Agent`, footer `Run Everything`, placeholder
`→ Plan, search, build anything`. Launched with `agent --force --trust
--model auto` (same shape as the paste prototype). Auth was not a blocker
on this machine; the TUI came up.

A 10-line paste echoes inline in the input box (the 9.5KB paste in the
sibling prototype collapsed to `[Pasted text #N]`; this smaller fixture
did not). The input viewport shows the last ~6 lines, so FIRST is off-screen
and token counts are against the visible lines.

| Candidate | Keys | Result |
| --- | --- | --- |
| ctrl+u | `ctrl+u` | **partial (last line only)**. Visible tokens 6 → 5, LAST gone. |
| esc | `esc` | **uncleared**. LAST remains, token count unchanged. |
| select-all+delete | `ctrl+a`, `backspace` | **uncleared**. Joined LAST onto the previous line (deleted a newline), did not empty the input. |
| ctrl+a then ctrl+k | `ctrl+a`, `ctrl+k` | **partial (last line only)**. Same shape as ctrl+u. |
| ctrl+c | `ctrl+c` | **cleared**. 0 tokens. Placeholder returned. Also renders `Press Ctrl+C again to exit`. |

**Verified clear-key sequence: `ctrl+c`.**

Empty-input ctrl+c does **not** exit. The TUI stays, placeholder still
showing, with the same `Press Ctrl+C again to exit` hint. Inference: a
second ctrl+c on that frame would exit; this spike did not send it.

Paste → ctrl+c → paste: the second paste lands (LAST visible, tokens
present). The exit hint is gone after the second paste. The retry cycle
works when the first paste occupied the input.

## 3. claude: unverified

Not launched. Login on this machine is expired (`Login expired · Please
run /login` in the paste prototype). The pool owner verifies claude's
clear key on another machine. Until then claude has no verified clear
sequence.

## 4. herdr key-name note

`pane.send_input` keys on herdr 0.8.2 accept `ctrl+u`, `esc`, `ctrl+a`,
`backspace`, `ctrl+k`, `ctrl+c`. The name `delete` returns
`{"code":"invalid_key","message":"unsupported key delete"}`. Ticket 02
should send `backspace`, not `delete`, if it ever needs that key.

## Recommendations for ticket 02

- Populate the spawn descriptor's clear-keys field with `["ctrl+c"]` for
  opencode and for cursor.
- Leave claude's slot empty, pending the operator's manual verification.
- ctrl+u is a proven partial on both TUIs: it must not be used as the
  clear sequence, or a retry still concatenates leftover lines.
- opencode: do not send ctrl+c against an already-empty input (it exits).
  A first-paste clear on a freshly ready opencode TUI is unsafe. Clear
  before a retry or fallback, when the previous paste is known to have
  occupied the input.
- cursor: ctrl+c on empty stays in the TUI but arms an exit hint.
  A following paste still lands. A following second ctrl+c is inferred to
  exit and was not tried.
