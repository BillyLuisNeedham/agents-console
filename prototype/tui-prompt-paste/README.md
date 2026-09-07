# Prototype: pasting a long driver prompt into live TUIs

A throwaway spike that answers the prompt-delivery risk behind the steerable
terminal-backed attempts spec (docs/specs/steerable-terminal-backed-attempts.md,
ADR-0016): can the engine reliably paste a long multi-line driver prompt into a
claude or opencode TUI running inside a real herdr pane, verify it landed, and
fall back to a short file-referencing command when it does not?

The question this settles is the spec's "Further Notes" risk: "Pasting a long
multi-line prompt into a TUI is the main technical risk (bracketed-paste and
input-buffer quirks differ per harness)."

## Verdict

Paste works on both claude and opencode. A 9.5KB / 179-line prompt is ingested
whole by each TUI through herdr's `pane.send_input` text primitive, delivered
on Enter, and echoed in the session transcript. The practical risks are not the
paste itself but (1) detecting TUI readiness without false positives, and
(2) claude's first-run trust dialog, which blocks any unseen directory.
Cursor's agent CLI is not installed on this machine, so cursor is unverified
(see FINDINGS.md).

## Run it

```
bun prototype/tui-prompt-paste/spike.ts <claude|opencode> [paste|fallback]
```

The spike opens a real herdr tab (unfocused, like the engine does), launches
the harness, waits for a stable ready frame, pastes the realistic prompt or
types the file-referencing fallback, and dumps the pane after each step.
Requires a running herdr daemon on the default socket and the harness CLI on
PATH. The prompt fixture is generated in /tmp.

## Files

- spike.ts: the throwaway driver (readiness, paste, fallback).
- FINDINGS.md: the full findings note ticket 03 consumes.

## Capture

Findings live in FINDINGS.md. The answer (paste is reliable, readiness and the
claude trust dialog are the real work) is recorded there and on the issue.
This prototype is primary source for the prompt-delivery portion of tickets 03
and 04.