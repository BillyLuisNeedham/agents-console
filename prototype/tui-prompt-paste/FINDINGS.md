# FINDINGS: pasting a long driver prompt into live TUIs

Spike date: 2026-09-07. Live against herdr 0.8.2 (socket API), claude 2.1.263,
opencode 1.18.29, script from util-linux 2.42.2, all running in real herdr
panes on the operator's machine. Every claim below is observed, not assumed;
where a claim is inferred it is labelled inference.

## 1. Readiness: what "ready" looks like in pane content

**claude TUI**: the ready frame contains the header `Claude Code v2.1.263`
and the bottom status line `(shift+tab to cycle)`, with an empty input prompt
`❯`. The bare `❯` is NOT a safe readiness pattern: the pane's own bash prompt
is also `❯` (observed false match at t=0s on the shell line). Match the header
`Claude Code v` or the status line instead. On this machine the status line
also carries `-- INSERT --` and `auto mode on`, which reflect the operator's
own claude settings (vim editor mode, permissions defaultMode auto) and are
not guaranteed elsewhere.

**claude first-run trust dialog**: before the TUI input, claude shows a
"Quick safety check" dialog with `No, exit` and `Yes, I trust this folder` in
any directory claude has not seen. The engine's attempt worktrees are exactly
such directories. The default selection is `No, exit`, so a naive Enter exits
claude (observed: `COMMAND_EXIT_CODE="1"`, prompt returned to bash). Answering
works when paced: settle ~1.5s after first detection, send `down` (the `❯`
moves to `Yes, I trust this folder`, verified by reading the pane between
keys), then `enter`. Sending `down` immediately after detection is dropped
(observed), so pacing matters. Trust state is persisted per project path in
`~/.claude.json` under `projects[<absolute-path>].hasTrustDialogAccepted`, so
the dialog only appears once per directory; pre-seeding that map is an
alternative to key-answering but writes the operator's claude config, and a
concurrent claude could rewrite the file.

**opencode TUI**: the ready home-screen frame contains `Ask anything` (the
input placeholder) and the footer `tab agents  ctrl+p commands`, with the
version `• OpenCode 1.18.29` bottom right. No trust dialog observed. Note
`Ask anything` is the first-boot placeholder and disappears once a session has
history; for spawn-time prompt delivery the first boot frame is the one to
match.

**Readiness needs a stable frame, not the first match.** During boot the pane
content flickers between empty reads and partial frames. A single-match poll
fired a false ready on opencode at t=0.5s, and a paste sent into that window
was silently lost (the pristine home screen reappeared with no message).
Require the pattern on 2-3 consecutive reads ~500ms apart and treat empty
reads as not-ready.

## 2. pane.read line-count quirk (engine-critical)

`pane.read source=recent` returns empty or near-empty text on a freshly
spawned pane unless `lines` is at least roughly the pane's terminal height.
Measured on a 53-row pane: `lines` <= 40 returned `""`, 50 returned only the
prompt row, 52+ returned the full bottom transcript. Reads against a pane
already full of content return text at any line count. The source returns the
last N rendered rows of the pane's screen, and a fresh shell pane's screen is
mostly blank rows above the prompt, so small N reads blanks.

Consequences, both proven:
- Readiness and echo polling must request a large `lines` (>=80; this spike
  used 200).
- The engine's Console peek passes `TERMINAL_PEEK_LINES = 8`
  (engine/server.ts:733). On a fresh attempt pane it reads empty; on a live
  full-screen TUI it reads only the footer sliver (e.g. the opencode status
  line). Inference: this line-count behaviour, not viewport warming, explains
  ADR-0015's "reads against a background tab return empty for the first
  seconds" note; that prototype peeked with a small line count.

## 3. Pasting a long multi-line prompt

`pane.send_input` text applies bracketed paste (confirmed by claude's
collapse marker). Both harnesses ingested a 9.5KB / 179-line realistic prompt
whole and delivered it on `keys: ["enter"]`.

**claude**: the input line collapses the paste to `[Pasted text #1 +N lines]`
(`+178 lines` at 9.5KB) and hints `paste again to expand`. The full text is
delivered on Enter and appears in the session transcript. So pre-Enter echo
verification can only match the collapse marker, not the full text; full-text
verification must read the transcript after Enter. The collapse is claude's
TUI rendering, not data loss.

**opencode**: the paste echoes inline in the input area for moderate sizes. A
very large paste can scroll the input echo out of the recent-read window, but
the full text still lands in the transcript after Enter and the agent acts on
it (observed: opencode started working on the pasted instructions). Verify the
echo on a distinctive prompt substring or on the transcript after Enter.

**Line endings**: the spike sends text with `\n`; both TUIs accept it with no
`\r` conversion.

**The retry case is real**: the false-ready paste loss above (opencode) is
exactly what the spec's "verify, retry" step exists for. After the lost
paste, the input bar showed nothing, so re-reading and re-pasting after a
confirmed ready would have recovered.

## 4. File-referencing fallback (proven on both)

The same short command works on both harnesses: `/implement <prompt-file>`
typed at the input, then Enter.

- claude: accepted and executed (observed the command line and a run attempt).
- opencode: `/implement <prompt-file>` expands the configured
  `~/.config/opencode/command/implement.md` command with the file as
  `$ARGUMENTS`, and the agent loaded it (observed).
- cursor: unverified (see section 6).

The fallback is short enough to survive any input-buffer cap, and the prompt
file's path is engine-known because the engine writes it.

## 5. The script wrapper (ADR-0016)

`script -qfc '<harness cmd>' <typescript>` runs correctly inside a herdr pane
and records both directions; the resulting typescript contains the session
including the pasted prompt (verified by grepping it). The nested PTY output
passes through to the pane, so `pane.read` sees the TUI normally.

## 6. Cursor: unverified, and why

The cursor harness spawns Cursor's `agent` CLI (engine/spawn.ts:135). That
binary is not installed on this machine: it is absent from PATH, ~/.local/bin,
the npm global root, mise, /usr/share/cursor (the desktop app ships no agent
CLI), and a filesystem-wide search. With no CLI to launch, cursor readiness,
paste, and fallback could not be exercised. herdr's documentation lists a
Cursor Agent CLI integration, so the binary exists upstream; installing and
authenticating it is the operator's step. This ticket therefore checkpoints.

## 7. claude auth caveat

claude's session on this machine reported `Login expired · Please run /login`
(and the status line `Not logged in`), so claude produced no agent response in
any run. Paste delivery, input echo, and slash-command acceptance were all
still observed end to end. This is environment state, not a prototype finding.

## Recommendations for tickets 03 and 04

- Poll `pane.read` with `lines >= 80`; require the per-harness ready pattern
  on 2-3 consecutive reads and treat empty reads as not-ready.
- Handle claude's trust dialog inside the readiness flow (detect, settle,
  down, verify the selection moved, enter), and keep it as a per-harness
  readiness stage.
- Echo-verify per harness: claude via the `Pasted text #1` marker pre-Enter or
  the transcript post-Enter; opencode via a distinctive prompt substring
  pre-Enter (moderate sizes) or the transcript post-Enter.
- Fallback: `/implement <promptfile>` for claude and opencode; cursor TBD once
  its CLI exists.
- Fix the Console peek's small-line empty read (raise TERMINAL_PEEK_LINES or
  read with a height-aware line count).
- The `script` wrapper shape is validated; keep it as the pane command.