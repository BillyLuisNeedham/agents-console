# Prototype: clearing the TUI input area before a re-paste

A throwaway spike that answers the clear-key risk behind the retry path in
terminal-backed prompt delivery: which key sequence empties the input area of
a live opencode or cursor TUI after a long multi-line paste, so a retry cannot
submit a composite of leftover text plus the new paste.

The paste-delivery prototype (`prototype/tui-prompt-paste/`) already showed
that a lost paste can leave the input empty; this spike covers the other
failure, where the paste landed and a retry would append.

## Verdict

`ctrl+c` empties a filled input on opencode and on cursor. ctrl+u is a
last-line-only partial on both (a finding, not a pass). esc and
select-all+delete do not clear. opencode: ctrl+c on an already-empty input
exits the TUI. cursor: ctrl+c on empty stays but shows "Press Ctrl+C again
to exit"; a following paste still lands. claude was not launched (login
expired). Full per-harness detail in FINDINGS.md.

## Run it

```
bun prototype/tui-clear-input/spike.ts <opencode|cursor>
```

The spike opens a real herdr tab per candidate (unfocused, like the engine
does), launches the harness under `script`, waits for a stable ready frame,
pastes a distinctive multi-line fixture, sends the candidate keys, and dumps
the pane. Pass `probes` as the second argument to skip the candidate loop and
run only the empty-ctrl-c and clear-then-repaste trials. Requires a running
herdr daemon on the default socket and the harness CLI on PATH. claude is out
of scope on this machine (login expired).

## Files

- spike.ts: the throwaway driver (readiness, paste, candidate keys).
- FINDINGS.md: the per-harness clear-key record ticket 02 consumes.
