/**
 * Turn state (the Conversations ADR, docs/adr/0018-conversations-beside-
 * tickets.md; CONTEXT.md: Turn state): a Conversation is always either
 * `working` (its agent is acting, or nobody has looked yet) or `waiting` (on
 * the operator). Detected purely from consecutive pane reads, with no
 * knowledge of herdr, sockets, or timers — the Conversation module's tick
 * (engine/conversations.ts) is the only caller, on a fixed interval, and
 * owns everything about *when* to read a pane and what to do once the
 * state changes (publish a snapshot, deliver a queued Notice). Kept pure and
 * free of engine.ts/conversations.ts imports so its rules are trivial to
 * table-test.
 *
 * A pane read is two regions (issue #71): the transcript, and below it the
 * TUI's chrome — the input box and whatever footer the harness draws under
 * it. Only the transcript says anything about the Turn: the footer carries
 * live counters (claude's statusline ticks its usage and cost, its mode row
 * changes with the operator's settings) that move while the agent sits idle,
 * and it is what a bottom-up scan for "the last thing said" finds first.
 * So the split is made once, by transcriptOf, and both the stability
 * comparison and the last-line extraction work on the transcript alone; the
 * idle pattern is still looked for in the whole read, since every harness's
 * idle marker lives in the chrome (claude's `❯` prompt, cursor's input
 * placeholder, opencode's footer hint).
 */

import { VIEWPORT_WRAP_CHROME } from "./pane-session.ts";

// "unchanged for 2 reads with the idle pattern present" (the plan): a single
// stable-and-idle read is discounted as a boot flicker or a mid-render
// snapshot, the same reasoning waitForReadiness applies to its own
// consecutive-match rule (pane-session.ts), so the same shape of rule is
// reused here rather than invented twice.
export const IDLE_STABLE_READS = 2;

// How far above the input box's bottom border transcriptOf looks for its top
// border. An empty input box is one content row on claude (`❯ ` between two
// rules) and three on opencode (a padding row, the placeholder, the model
// line, all `┃`-prefixed); a typed draft grows it a row per line. Past this
// many rows the box is treated as having no top border in view, so a border
// row much further up (a rendered table's edge) is never mistaken for it.
export const INPUT_BOX_MAX_ROWS = 8;

/** Which side of its Turn a Conversation is on. */
export type TurnSide = "working" | "waiting";

/**
 * A Conversation's Turn state, stored whole on its runtime and handed back
 * in on the next read. `state`, `lastLine` and `idleSince` are what the wire
 * shows; `stableReads` and `transcript` are the transition's own memory
 * (the idle count so far, and the transcript region the next read is
 * compared against) and never leave the engine.
 */
export interface TurnState {
  state: TurnSide;
  lastLine: string;
  // When the Turn last flipped to `waiting`; null while working.
  idleSince: string | null;
  stableReads: number;
  transcript: string;
}

/** The Turn state of a freshly launched Conversation: working, unstable, nothing said yet. */
export const FRESH_TURN: TurnState = {
  state: "working",
  lastLine: "",
  idleSince: null,
  stableReads: 0,
  transcript: "",
};

export interface TurnTransition {
  turn: TurnState;
  // Whether `state` or `lastLine` moved — the tick's signal to publish a
  // snapshot rather than silently updating the runtime and waiting for
  // some other reason to publish one.
  publish: boolean;
}

function isBlank(row: string): boolean {
  return row.trim() === "";
}

// A border row: box-drawing and block glyphs only (claude's `────` rules,
// opencode's `╹▀▀▀▀` bottom edge and its bare `┃` padding row), which is
// exactly what VIEWPORT_WRAP_CHROME strips to nothing. A blank row is not a
// border: the padding a fixed-size read adds below the chrome, and the empty
// row a TUI leaves above its input box, must not anchor the split.
function isBorder(row: string): boolean {
  return !isBlank(row) && row.replace(VIEWPORT_WRAP_CHROME, "") === "";
}

/**
 * The transcript region of a pane read: every row above the TUI's input
 * box. The box is located structurally rather than by any harness-specific
 * text, from a live capture of claude 2.1.267 (idle and mid-turn) and
 * opencode 1.18.29 (idle), both of which draw it the same way: a border row
 * closes it at the bottom, its content rows sit above that, and a border row
 * opens it at the top; the footer (claude's statusline and mode row,
 * opencode's `tab agents  ctrl+p commands` and version line) renders below
 * the bottom border, never inside or above the box. So: the lowest border
 * row in the read is the bottom edge, the *highest* border row within
 * INPUT_BOX_MAX_ROWS above it is the top edge, and everything above the top
 * edge is transcript. Highest, not nearest: opencode pads the inside of its
 * box with bare `┃` rows, which are border rows too, and the nearest one
 * would leave the placeholder above the cut. The cost is that a border row
 * the transcript itself ends with inside that reach (a rendered table's
 * bottom edge, a markdown rule) is taken as the top edge instead, which
 * drops that static tail from the transcript and moves lastLine up a row or
 * two; stability is unaffected. With no border row anywhere (a read that
 * caught no chrome at all) the whole read is transcript; with a bottom edge
 * but no other in reach, the bottom edge alone is the split. cursor is
 * inferred to fit the same rule from the prototype's description of its
 * bordered input (prototype/tui-prompt-paste/FINDINGS.md); not captured
 * live.
 */
export function transcriptOf(text: string): string {
  const rows = text.split("\n");
  let bottom = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isBorder(rows[i])) {
      bottom = i;
      break;
    }
  }
  if (bottom < 0) return text;
  let top = bottom;
  for (let j = bottom - 1; j >= Math.max(0, bottom - INPUT_BOX_MAX_ROWS); j--) {
    if (isBorder(rows[j])) top = j;
  }
  return rows.slice(0, top).join("\n");
}

// The last row of an already-split transcript that still has content once
// VIEWPORT_WRAP_CHROME's whitespace-and-box-drawing runs are collapsed:
// what the operator would read as "the last thing said" (claude's
// `✻ Sautéed for 1s · done 2:35 PM` once a turn ends, its `✢ Sautéing…`
// spinner row mid-turn, both verified live). A transcript that ends in a
// rendered table's bottom edge skips that edge and returns the table's last
// content row, collapsed.
function lastLineOf(transcript: string): string {
  const lines = transcript.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const stripped = lines[i].replace(VIEWPORT_WRAP_CHROME, " ").trim();
    if (stripped !== "") return stripped;
  }
  return "";
}

/**
 * The last content line of a raw pane read's transcript region: transcriptOf
 * then the bottom-up scan above. Before issue #71 this scanned the whole
 * read and so always returned claude's mode row (`-- INSERT -- ⏵⏵ auto mode
 * on ...`), the lowest text in every frame.
 */
export function extractLastLine(text: string): string {
  return lastLineOf(transcriptOf(text));
}

/**
 * One turn-state read: the current Turn state, one pane read, the harness's
 * idle pattern and the clock, to the next Turn state and whether to publish
 * it. Any change in the pane's transcript region — the agent streaming, the
 * operator typing, a Notice just delivered — resets the idle count and marks
 * the turn `working`, whatever it was before: only a transcript-stable pane
 * can be idle. Chrome-only movement (a statusline counter ticking under the
 * input box) is not a change at all. Once the transcript stops changing,
 * `idlePattern`'s presence in the whole read is checked each read;
 * IDLE_STABLE_READS consecutive stable-and-idle reads flip the state to
 * `waiting`, stamping `idleSince` with `now`, and it stays there (through
 * further stable-and-idle reads, `idleSince` untouched) until the transcript
 * changes again, which clears it. A stable pane whose idle pattern is absent
 * (a dialog, a crash in progress) never reaches `waiting` and resets its
 * stable-idle count the same way an outright change would; it simply holds
 * the current state, so a Conversation already `waiting` does not flap back
 * to `working` on a read that is stable but not (yet) idle, and one already
 * `working` does not flip early.
 */
export function nextTurnState(
  current: TurnState,
  text: string,
  idlePattern: string,
  now: string,
): TurnTransition {
  const transcript = transcriptOf(text);
  const lastLine = lastLineOf(transcript);
  if (transcript !== current.transcript) {
    const publish =
      current.state !== "working" || lastLine !== lastLineOf(current.transcript);
    return {
      turn: { state: "working", lastLine, idleSince: null, stableReads: 0, transcript },
      publish,
    };
  }
  const idle = idlePattern.length > 0 && text.includes(idlePattern);
  // Mirrors waitForReadiness's own stable-count rule (pane-session.ts): a
  // stable-but-not-idle read (a dialog, a mid-render frame) resets the
  // count rather than merely pausing it, so `waiting` requires the idle
  // pattern on IDLE_STABLE_READS *consecutive* reads, not just any two ever
  // seen while text happened not to change.
  const stableReads = idle ? current.stableReads + 1 : 0;
  const state: TurnSide =
    idle && stableReads >= IDLE_STABLE_READS ? "waiting" : current.state;
  const idleSince =
    state === "waiting" ? (current.state === "waiting" ? current.idleSince : now) : null;
  return {
    turn: { state, lastLine, idleSince, stableReads, transcript },
    publish: state !== current.state,
  };
}
