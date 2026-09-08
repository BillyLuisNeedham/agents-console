# Prototype: pasting a long driver prompt into live TUIs

A throwaway spike that answers the prompt-delivery risk behind the steerable
terminal-backed attempts spec (docs/specs/steerable-terminal-backed-attempts.md,
ADR-0016): can the engine reliably paste a long multi-line driver prompt into a
claude, opencode, or cursor TUI running inside a real herdr pane, verify it
landed, and fall back to a short file-referencing command when it does not?

The question this settles is the spec's "Further Notes" risk: "Pasting a long
multi-line prompt into a TUI is the main technical risk (bracketed-paste and
input-buffer quirks differ per harness)."

## Verdict

Paste works on all three harnesses. A 9.5KB-scale multi-line prompt is ingested
whole by each TUI through herdr's `pane.send_input` text primitive, delivered
on Enter, and echoed in the session transcript (claude and cursor collapse the
input echo to a `[Pasted text #N +N lines]` marker; opencode echoes inline).
The practical risks are not the paste itself but (1) detecting TUI readiness
without false positives, and (2) claude's first-run trust dialog, which blocks
any unseen directory. cursor needs `--trust` at spawn or its CLI refuses to
run. Full per-harness detail in FINDINGS.md.

## Run it

```
bun prototype/tui-prompt-paste/spike.ts <claude|opencode|cursor> [paste|fallback]
```

The spike opens a real herdr tab (unfocused, like the engine does), launches
the harness, waits for a stable ready frame, pastes the realistic prompt or
types the file-referencing fallback, and dumps the pane after each step.
Requires a running herdr daemon on the default socket and the harness CLI on
PATH (cursor's agent CLI is `cursor-agent` 2026.09.02-c22c1a3 on a free plan,
so the spike launches it with `--model auto`). The prompt fixture is generated
in /tmp.

## Files

- spike.ts: the throwaway driver (readiness, paste, fallback).
- FINDINGS.md: the full findings note ticket 03 consumes.

## Capture

Findings live in FINDINGS.md. The answer (paste is reliable, readiness and the
claude trust dialog are the real work) is recorded there and on the issue.
This prototype is primary source for the prompt-delivery portion of tickets 03
and 04.