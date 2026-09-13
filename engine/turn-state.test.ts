import { describe, expect, it } from "bun:test";
import {
  FRESH_TURN,
  IDLE_STABLE_READS,
  extractLastLine,
  nextTurnState,
  type TurnState,
} from "./turn-state.ts";

const T0 = "2026-09-13T10:00:00.000Z";
const T1 = "2026-09-13T10:00:02.000Z";

// A Turn state as the tick would hold it after a read judged on `transcript`.
function held(
  transcript: string,
  state: TurnState["state"],
  stableReads: number,
  idleSince: string | null = state === "waiting" ? T0 : null,
): TurnState {
  return { state, lastLine: extractLastLine(transcript), idleSince, stableReads, transcript };
}

describe("nextTurnState", () => {
  it("starts working on the very first read (fresh state), whatever the text", () => {
    const { turn, publish } = nextTurnState(FRESH_TURN, "some pane text\n❯", "❯", T1);
    expect(turn.state).toBe("working");
    expect(turn.idleSince).toBeNull();
    expect(publish).toBe(true);
  });

  it("a text change always resets to working, clears idleSince and resets the stable count", () => {
    const { turn, publish } = nextTurnState(held("old", "waiting", 5), "new", "❯", T1);
    expect(turn.state).toBe("working");
    expect(turn.stableReads).toBe(0);
    expect(turn.idleSince).toBeNull();
    expect(publish).toBe(true);
  });

  it("a text change from working to working publishes only when lastLine moved too", () => {
    const r1 = nextTurnState(held("line one\nline two", "working", 0), "line one\nline two more", "❯", T1);
    expect(r1.turn.state).toBe("working");
    expect(r1.publish).toBe(true); // lastLine moved

    // Different full text, but the extracted last line matches: publish is
    // about state-or-lastLine, and here text differs above the last line,
    // so the transition reports working->working with the same lastLine as
    // nothing to publish.
    const r2 = nextTurnState(held("same tail\nfoo", "working", 0), "other tail\nfoo", "❯", T1);
    expect(r2.turn.lastLine).toBe("foo");
    expect(r2.publish).toBe(false);
  });

  it("requires IDLE_STABLE_READS consecutive stable+idle reads before flipping to waiting, stamping idleSince on the flip", () => {
    expect(IDLE_STABLE_READS).toBe(2);
    // First read: text changes from "" -> content, resets to working.
    let r = nextTurnState(FRESH_TURN, "agent output\n❯", "❯", T0);
    expect(r.turn.state).toBe("working");

    // Second read: same text, idle pattern present, but only 1 stable read so far.
    r = nextTurnState(r.turn, "agent output\n❯", "❯", T0);
    expect(r.turn.state).toBe("working");
    expect(r.turn.stableReads).toBe(1);
    expect(r.turn.idleSince).toBeNull();
    expect(r.publish).toBe(false);

    // Third read: same text again, second stable+idle read -> waiting, since now.
    r = nextTurnState(r.turn, "agent output\n❯", "❯", T1);
    expect(r.turn.state).toBe("waiting");
    expect(r.turn.idleSince).toBe(T1);
    expect(r.publish).toBe(true);
  });

  it("a stable read without the idle pattern present never becomes waiting and resets the stable count", () => {
    const { turn, publish } = nextTurnState(held("mid dialog", "working", 1), "mid dialog", "❯", T1);
    expect(turn.state).toBe("working");
    expect(turn.stableReads).toBe(0);
    expect(turn.idleSince).toBeNull();
    expect(publish).toBe(false);
  });

  it("once waiting, further stable+idle reads hold waiting, keep the original idleSince and publish nothing", () => {
    const { turn, publish } = nextTurnState(held("❯", "waiting", 2, T0), "❯", "❯", T1);
    expect(turn.state).toBe("waiting");
    expect(turn.idleSince).toBe(T0);
    expect(publish).toBe(false);
    expect(turn.stableReads).toBe(3);
  });

  it("once waiting, a stable read without the idle pattern holds waiting and its idleSince (no flap)", () => {
    const { turn, publish } = nextTurnState(held("❯", "waiting", 2, T0), "❯", "zzz", T1);
    expect(turn.state).toBe("waiting");
    expect(turn.idleSince).toBe(T0);
    expect(turn.stableReads).toBe(0);
    expect(publish).toBe(false);
  });

  it("an empty idlePattern never matches, so the turn can never become waiting", () => {
    const { turn } = nextTurnState(held("x", "working", 5), "x", "", T1);
    expect(turn.state).toBe("working");
    expect(turn.stableReads).toBe(0);
  });
});

describe("extractLastLine", () => {
  it("returns the last non-empty line, trimmed", () => {
    expect(extractLastLine("first\nsecond\nthird   ")).toBe("third");
  });

  it("skips trailing blank lines", () => {
    expect(extractLastLine("hello\n\n\n   \n")).toBe("hello");
  });

  it("strips box-drawing border rows down to nothing and skips them", () => {
    expect(extractLastLine("agent said this\n──────────\n│          │\n──────────")).toBe(
      "agent said this",
    );
  });

  it("returns empty string for an all-blank or all-chrome pane", () => {
    expect(extractLastLine("   \n──────\n\n")).toBe("");
    expect(extractLastLine("")).toBe("");
  });

  it("collapses internal chrome runs but keeps the real content around them", () => {
    // A wrapped line split by box border characters mid-row, the same shape
    // viewportShows tolerates.
    expect(extractLastLine("some─────text")).toBe("some text");
  });
});

// ---------------------------------------------------------------------------
// Issue #71: the transcript / chrome split. Fixtures are verbatim rows from a
// live capture (tmux, 120x40) of claude 2.1.267 and opencode 1.18.29 on
// 2026-09-11; trailing blank rows stand in for the padding a fixed-size pane
// read adds below the chrome.
// ---------------------------------------------------------------------------

import { INPUT_BOX_MAX_ROWS, transcriptOf } from "./turn-state.ts";

const RULE = "─".repeat(120);

function pane(rows: string[], height = 40): string {
  return [...rows, ...Array(Math.max(0, height - rows.length)).fill("")].join("\n");
}

const CLAUDE_HEADER = [
  " ▐▛███▛█   Claude Code v2.1.267",
  "▝▜██████▀  Haiku 4.5 · Claude Max",
  "  ▝▝ ▝▝    /tmp/tmp.dH29nBRnvR",
  "",
  "",
];

const CLAUDE_FOOTER = (statusline: string) => [
  `  [/tmp/tmp.dH29nBRnvR ] ${statusline}`.padEnd(76) + "Update available! Run: mise upgrade claude",
  "  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents" + " ".repeat(40) + "/rc",
];

// Freshly ready, nothing said yet.
const CLAUDE_BOOT = pane([...CLAUDE_HEADER, "", RULE, "❯ ", RULE, ...CLAUDE_FOOTER("")]);

// Mid-turn: the operator's echoed turn, the spinner row, and the input box
// still showing its `❯` underneath.
const CLAUDE_WORKING = pane([
  ...CLAUDE_HEADER,
  "❯ reply with exactly the word hello and nothing else",
  "",
  "✢ Sautéing…",
  "",
  RULE,
  "❯ ",
  RULE,
  ...CLAUDE_FOOTER(""),
]);

// Turn over: the reply, the done row, and a statusline now carrying usage.
function claudeIdle(statusline = "63.5k 32% $0.07"): string {
  return pane([
    ...CLAUDE_HEADER,
    "❯ reply with exactly the word hello and nothing else",
    "",
    "● hello",
    "",
    "✻ Sautéed for 1s · done 2:35 PM",
    "",
    RULE,
    "❯ ",
    RULE,
    ...CLAUDE_FOOTER(statusline),
  ]);
}

const OPENCODE_IDLE = pane([
  ...Array(13).fill(""),
  "                                                                          ▄",
  "                                         █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█",
  "                                         █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀",
  "                                         ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
  "",
  "",
  "                       ┃",
  '                       ┃  Ask anything… "What is the tech stack of this project?"',
  "                       ┃",
  "                       ┃  Build · Kimi K3 (1M) Kimi For Coding (OAuth) · high",
  "                       ╹" + "▀".repeat(72),
  "                                                                       tab agents  ctrl+p commands",
  ...Array(13).fill(""),
  "  /tmp/tmp.dH29nBRnvR" + " ".repeat(90) + "1.18.29",
]);

describe("transcriptOf (issue #71)", () => {
  it("cuts claude's read at the input box's top rule, dropping the box and both footer rows", () => {
    const transcript = transcriptOf(claudeIdle());
    expect(transcript.split("\n").at(-2)).toBe("✻ Sautéed for 1s · done 2:35 PM");
    expect(transcript).not.toContain("❯ \n");
    expect(transcript).not.toContain("-- INSERT --");
    expect(transcript).not.toContain("63.5k");
    // The operator's echoed turn, above the box, is transcript.
    expect(transcript).toContain("❯ reply with exactly the word hello");
  });

  it("cuts opencode's read at the box's bare ┃ padding row, not at the block-glyph logo above it", () => {
    const transcript = transcriptOf(OPENCODE_IDLE);
    expect(transcript).not.toContain("Ask anything");
    expect(transcript).not.toContain("ctrl+p commands");
    expect(transcript).not.toContain("1.18.29");
    expect(transcript).toContain("█▀▀█");
  });

  it("returns the whole read when no border row is in view", () => {
    expect(transcriptOf("agent said this\n\n\n")).toBe("agent said this\n\n\n");
    expect(transcriptOf("")).toBe("");
  });

  it("splits at the bottom border alone when no other border sits within INPUT_BOX_MAX_ROWS", () => {
    const rows = [
      "┌────┐",
      "│ a  │",
      "└────┘",
      ...Array(INPUT_BOX_MAX_ROWS + 1).fill("draft line"),
      RULE,
      "footer",
    ];
    const transcript = transcriptOf(rows.join("\n"));
    expect(transcript.split("\n")).toEqual(rows.slice(0, -2));
  });

  it("takes a top border exactly INPUT_BOX_MAX_ROWS above the bottom one", () => {
    const rows = ["said", RULE, ...Array(INPUT_BOX_MAX_ROWS - 1).fill("draft"), RULE, "footer"];
    expect(transcriptOf(rows.join("\n"))).toBe("said");
  });

  it("takes the highest border row in reach, so a box padded inside with bare ┃ rows is cut at its top", () => {
    const rows = ["said", "┃", "┃ typed", "┃", "┃ model", "╹▀▀▀▀", "footer"];
    expect(transcriptOf(rows.join("\n"))).toBe("said");
  });
});

describe("extractLastLine on live frames (issue #71)", () => {
  it("names the done row once claude's turn ends, not the mode row at the bottom of the chrome", () => {
    expect(extractLastLine(claudeIdle())).toBe("✻ Sautéed for 1s · done 2:35 PM");
  });

  it("names the spinner row while claude works", () => {
    expect(extractLastLine(CLAUDE_WORKING)).toBe("✢ Sautéing…");
  });

  it("names the header's path row on claude's boot frame, when nothing has been said", () => {
    expect(extractLastLine(CLAUDE_BOOT)).toBe("/tmp/tmp.dH29nBRnvR");
  });

  it("is empty on opencode's home screen, whose only content above the box is its logo", () => {
    expect(extractLastLine(OPENCODE_IDLE)).toBe("");
  });

  it("skips a rendered table's bottom edge at the end of a transcript and returns its last row", () => {
    expect(extractLastLine("│ a │ b │\n└───┴───┘")).toBe("a b");
  });
});

describe("nextTurnState on live frames (issue #71)", () => {
  it("reaches waiting on an idle claude frame and ignores the statusline ticking underneath", () => {
    let r = nextTurnState(FRESH_TURN, claudeIdle("63.5k 32% $0.07"), "❯", T0);
    expect(r.turn.state).toBe("working");
    expect(r.turn.lastLine).toBe("✻ Sautéed for 1s · done 2:35 PM");
    // The usage counter moves, the transcript does not: still a stable read.
    r = nextTurnState(r.turn, claudeIdle("63.6k 32% $0.08"), "❯", T0);
    expect(r.turn.state).toBe("working");
    expect(r.turn.stableReads).toBe(1);
    r = nextTurnState(r.turn, claudeIdle("63.6k 32% $0.08 ↻ 33m"), "❯", T1);
    expect(r.turn.state).toBe("waiting");
    expect(r.turn.idleSince).toBe(T1);
    expect(r.publish).toBe(true);
    // Once waiting, a footer-only change is not a change at all.
    r = nextTurnState(r.turn, claudeIdle("63.6k 32% $0.08 ↻ 32m"), "❯", "2026-09-13T10:00:04.000Z");
    expect(r.turn.state).toBe("waiting");
    expect(r.turn.idleSince).toBe(T1);
    expect(r.publish).toBe(false);
    expect(r.turn.stableReads).toBe(3);
  });

  it("goes back to working when the transcript itself moves", () => {
    const { turn, publish } = nextTurnState(
      held(transcriptOf(claudeIdle()), "waiting", 4),
      CLAUDE_WORKING,
      "❯",
      T1,
    );
    expect(turn.state).toBe("working");
    expect(turn.stableReads).toBe(0);
    expect(turn.idleSince).toBeNull();
    expect(turn.lastLine).toBe("✢ Sautéing…");
    expect(publish).toBe(true);
  });

  it("carries the transcript it judged, so the same frame next read is stable", () => {
    const first = nextTurnState(FRESH_TURN, claudeIdle(), "❯", T0);
    expect(first.turn.transcript).toBe(transcriptOf(claudeIdle()));
    const second = nextTurnState(first.turn, claudeIdle(), "❯", T1);
    expect(second.turn.stableReads).toBe(1);
  });
});
