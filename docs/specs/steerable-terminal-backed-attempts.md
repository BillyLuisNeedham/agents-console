# Spec: Steerable Terminal-Backed Attempts

## Problem Statement

When the Console spawns a terminal-backed attempt, the herdr tab it opens is not interactive in practice. The harness runs in batch mode (`claude -p`, `opencode run`, `agent -p`): it reads one prompt, streams output, and exits. The operator watching the tab sees a one-way stream of output and cannot steer the agent — unlike running claude, opencode, or cursor locally, where the operator can type follow-up messages mid-run to course-correct. A wrong turn means waiting for the whole attempt to finish (or killing it) instead of one typed sentence.

## Solution

Terminal-backed attempts spawn the harness as a full interactive TUI inside the herdr pane — the same experience as running the harness locally. The operator clicks the tab, watches the agent work, and types into it at any time to steer, exactly as the glossary already describes a terminal-backed attempt: "a real terminal the operator can watch and type into, while the engine stays oblivious to that input."

The engine's job changes only at spawn: it starts the TUI, waits for it to be ready, types the driver prompt in, and then behaves as it does today. Completion is unchanged in spirit: the attempt ends when a valid Outcome appears; the pane stays open afterward so the operator can keep reading (and typing, though the attempt is already closed). The attempt's Stream file becomes a full bidirectional transcript — agent output and the operator's own keystrokes — captured with `script`, so the derived ticket log, grading, head-to-head judging, and Vitals all keep working with no changes to those consumers.

## User Stories

1. As the operator, I want a terminal-backed attempt to open its harness as an interactive TUI, so that the tab behaves like my local claude/opencode/cursor sessions.
2. As the operator, I want to type a follow-up message to a running attempt mid-run, so that I can course-correct without waiting for the attempt to finish.
3. As the operator, I want to steer during a long tool call or between turns, with the harness queuing my input natively, so that I never have to time my typing.
4. As the operator, I want every parallel attempt of a ticket (verify: N) to be its own interactive tab, so that I can dive into whichever candidate interests me.
5. As the operator, I want the attempt to complete when the agent declares done via its Outcome, so that the grading, selection, and merge machinery runs without waiting for me.
6. As the operator, I want the pane to stay open after the attempt completes, so that I can read back the session and poke around.
7. As the operator, I want my own keystrokes recorded in the attempt's Stream file, so that the ticket log shows the full story including my steering.
8. As the operator, I want the Console's log view for an interactive attempt to show a readable, continuously-updating transcript, so that I can follow along without switching to the tab.
9. As the operator, I want Vitals on the ticket card to keep moving during an interactive attempt, so that I can tell at a glance the attempt is alive.
10. As the operator, I want a pane that dies without writing an Outcome to be treated as a crash, so that failure detection works exactly as it does today.
11. As the operator, I want headless attempts to stay exactly as they are, so that pools without `terminal: herdr` see no change.
12. As the operator, I want the engine to detect that the TUI failed to start or never received the prompt, so that a botched spawn surfaces as a failure instead of an idle tab I mistake for a working agent.
13. As a grader agent, I want the attempt log I grade to be the full ANSI-stripped transcript of the interactive session, so that I can assess how the attempt went, including the operator's steering.
14. As a head-to-head judge, I want both candidates' transcripts in the same form, so that comparison works as it does today.
15. As the operator, I want all three harnesses (claude, opencode, cursor) to support interactivity at once, so that a pool's Assignment choice never silently downgrades to a one-way stream.
16. As the operator, I want auto-approve permission modes preserved in interactive mode, so that steering never turns into babysitting permission prompts.
17. As the operator, I want the driver prompt delivered to the TUI reliably — with readiness detection, echo verification, and retry — so that the agent always starts on the right ticket.
18. As the operator, I want a short file-referencing fallback if pasting a long prompt into a TUI proves flaky, so that prompt delivery is robust across harnesses and terminal sizes.

## Implementation Decisions

- **Interactive spawn for terminal-backed attempts, all harnesses.** The terminal-backed spawn path drops the batch flags (`-p` / `run` / `--output-format stream-json` / `--verbose`) and launches each harness's interactive TUI. Auto-approve flags (`--permission-mode auto`, `--auto`, `--force --trust`) are preserved. The headless path is untouched: batch mode, stdin closed, structured stream tee'd.
- **Wrapper v2: capture via `script`.** The command typed into the pane wraps the harness invocation in `script -qfc '<harness cmd>' <stream-file>`: `script` allocates the PTY the TUI requires, passes the session through to the pane live, and records both directions to the Stream file. The trailing exit-code write stays, firing whenever the TUI eventually exits, for crash forensics.
- **Prompt delivery by typing, with verification.** Since the prompt can no longer arrive as argv, the engine waits for TUI readiness (polling the pane's rendered content for a per-harness ready pattern), sends the driver prompt plus Enter through the existing pane-input primitive, re-reads the pane to verify the prompt landed, retries on timeout, and falls back to typing a short command that references an engine-written prompt file if full-prompt pasting fails. Prompt shaping is per harness, matching how each TUI accepts commands (claude expands a leading `/driver …` slash command; opencode and cursor take their driver invocation in their own interactive form).
- **Completion on Outcome, not exit.** A terminal-backed attempt completes when a valid Outcome JSON is present, without waiting for pane exit — in TUI mode the process deliberately stays alive after the agent declares done. Pane exit/close/lost *without* a valid Outcome remains the crash signal, as today. The engine stays oblivious to operator input, per the glossary.
- **Stream file becomes a transcript.** For terminal-backed attempts the Stream file is the `script` typescript (raw ANSI, bidirectional) rather than harness stream-json; the derived per-attempt log is produced by stripping ANSI, as the derivation step already does. This amends ADR-0012's assumption of a structured harness stream for the terminal-backed path only — headless attempts still derive from stream-json. All harnesses, including opencode, get a Stream file in terminal-backed mode.
- **Consumers unchanged.** Grading, head-to-head judging, the Console log view, and Vitals read the derived log and its file stats; because the transcript keeps growing live, none of them change.
- **Grader and spawned tickets follow the pool.** They are ordinary assignments; in a `terminal: herdr` pool they too spawn interactively. No special-casing.

## Testing Decisions

- A good test observes external behavior at the engine↔herdr boundary: what the engine types into the pane and when, what lands in the Stream file, and what makes the engine consider the attempt done or crashed. Tests must not depend on TUI internals, readiness-pattern strings beyond one canonical fixture, or timing accidentals.
- One seam, and it already exists: the fake herdr daemon at the JSON-RPC socket used by the terminal-backed attempt tests. Tests drive the engine against the fake and assert on recorded `pane.send_input` calls, fabricated `pane.read` content, and pane lifecycle events. No new seams.
- What gets tested at that seam: the wrapper command wraps the harness in `script` with the attempt's Stream path; the engine waits for readiness before typing the prompt; echo verification triggers a retry and then the file-reference fallback; a valid Outcome without pane exit completes the attempt; pane loss without Outcome is a crash; headless spawns are byte-for-byte unchanged.
- The stream→log derivation gets a unit test that an ANSI-laden typescript derives into a readable transcript, alongside the existing derivation tests.
- Prior art: the terminal-backed attempt tests and the headless stdin-closed test in the engine test suite, and the existing streamlog derivation tests.

## Out of Scope

- Typing into the attempt from the Console UI (an input box on the embedded terminal surface and a send endpoint). The operator types in the herdr tab itself; Console-side input remains deferred.
- Any change to the headless spawn path, batch log pipeline, or pools without `terminal: herdr`.
- Session recording/replay UI beyond the existing log view.
- Per-harness TUI configuration beyond spawn flags (themes, keybindings, etc.).
- Making batch-mode harnesses accept mid-run stdin (the stream-json input-mode alternative, rejected in favor of full TUI).

## Further Notes

- The glossary entry for **Terminal-backed attempt** says the attempt "ends only on exit plus Outcome"; under this spec it ends on Outcome, with pane exit trailing whenever the operator closes the tab. The entry needs a small touch-up when this lands.
- An ADR should accompany implementation: it amends ADR-0012 (Stream is a `script` typescript, not harness stream-json, for terminal-backed attempts) and resolves ADR-0014's deferral of the embedded interactive terminal (resolved toward the herdr tab, not the Console surface).
- Pasting a long multi-line prompt into a TUI is the main technical risk (bracketed-paste and input-buffer quirks differ per harness). Prototype the paste against the real claude TUI early; the file-reference fallback is the safety net, not the plan.
