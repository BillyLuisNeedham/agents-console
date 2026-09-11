import { describe, expect, it } from "bun:test";
import {
  deriveTurnState,
  extractLastLine,
  IDLE_STABLE_READS,
  type TurnStatePrev,
} from "./turn-state.ts";

describe("deriveTurnState", () => {
  it("starts working on the very first read (prev null), whatever the text", () => {
    const r = deriveTurnState(null, "some pane text\n❯", "❯");
    expect(r.state).toBe("working");
    expect(r.changed).toBe(true);
  });

  it("a text change always resets to working and resets the stable count", () => {
    const prev = { text: "old", state: "waiting" as const, stableReads: 5 };
    const r = deriveTurnState(prev, "new", "❯");
    expect(r.state).toBe("working");
    expect(r.stableReads).toBe(0);
    expect(r.changed).toBe(true);
  });

  it("a text change from working to working (same state) is unchanged only if lastLine is identical too", () => {
    const prev = { text: "line one\nline two", state: "working" as const, stableReads: 0 };
    const r1 = deriveTurnState(prev, "line one\nline two more", "❯");
    expect(r1.state).toBe("working");
    expect(r1.changed).toBe(true); // lastLine moved

    const prev2 = { text: "same tail\nfoo", state: "working" as const, stableReads: 0 };
    // Different full text, but the extracted last line matches: still
    // "changed" is about state-or-lastLine, and here text differs above the
    // last line, so lastLine is unaffected but the function still reports
    // working->working with the same lastLine as unchanged.
    const r2 = deriveTurnState(prev2, "other tail\nfoo", "❯");
    expect(r2.lastLine).toBe("foo");
    expect(r2.changed).toBe(false);
  });

  it("requires IDLE_STABLE_READS consecutive stable+idle reads before flipping to waiting", () => {
    expect(IDLE_STABLE_READS).toBe(2);
    let prev: TurnStatePrev = { text: "", state: "working", stableReads: 0 };
    // First read: text changes from "" -> content, resets to working.
    let r = deriveTurnState(prev, "agent output\n❯", "❯");
    expect(r.state).toBe("working");
    prev = { text: "agent output\n❯", state: r.state, stableReads: r.stableReads };

    // Second read: same text, idle pattern present, but only 1 stable read so far.
    r = deriveTurnState(prev, "agent output\n❯", "❯");
    expect(r.state).toBe("working");
    expect(r.stableReads).toBe(1);
    expect(r.changed).toBe(false);
    prev = { text: "agent output\n❯", state: r.state, stableReads: r.stableReads };

    // Third read: same text again, second stable+idle read -> waiting.
    r = deriveTurnState(prev, "agent output\n❯", "❯");
    expect(r.state).toBe("waiting");
    expect(r.changed).toBe(true);
  });

  it("a stable read without the idle pattern present never becomes waiting and resets the stable count", () => {
    const prev = { text: "mid dialog", state: "working" as const, stableReads: 1 };
    const r = deriveTurnState(prev, "mid dialog", "❯");
    expect(r.state).toBe("working");
    expect(r.stableReads).toBe(0);
    expect(r.changed).toBe(false);
  });

  it("once waiting, further stable+idle reads hold waiting with no further change", () => {
    const prev = { text: "❯", state: "waiting" as const, stableReads: 2 };
    const r = deriveTurnState(prev, "❯", "❯");
    expect(r.state).toBe("waiting");
    expect(r.changed).toBe(false);
    expect(r.stableReads).toBe(3);
  });

  it("an empty idlePattern never matches, so the turn can never become waiting", () => {
    const prev = { text: "x", state: "working" as const, stableReads: 5 };
    const r = deriveTurnState(prev, "x", "");
    expect(r.state).toBe("working");
    expect(r.stableReads).toBe(0);
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

describe("deriveTurnState on live frames (issue #71)", () => {
  function step(prev: TurnStatePrev | null, text: string) {
    const r = deriveTurnState(prev, text, "❯");
    return { r, next: { text: r.transcript, state: r.state, stableReads: r.stableReads } };
  }

  it("reaches waiting on an idle claude frame and ignores the statusline ticking underneath", () => {
    let { r, next } = step(null, claudeIdle("63.5k 32% $0.07"));
    expect(r.state).toBe("working");
    expect(r.lastLine).toBe("✻ Sautéed for 1s · done 2:35 PM");
    // The usage counter moves, the transcript does not: still a stable read.
    ({ r, next } = step(next, claudeIdle("63.6k 32% $0.08")));
    expect(r.state).toBe("working");
    expect(r.stableReads).toBe(1);
    ({ r, next } = step(next, claudeIdle("63.6k 32% $0.08 ↻ 33m")));
    expect(r.state).toBe("waiting");
    expect(r.changed).toBe(true);
    // Once waiting, a footer-only change is not a change at all.
    ({ r, next } = step(next, claudeIdle("63.6k 32% $0.08 ↻ 32m")));
    expect(r.state).toBe("waiting");
    expect(r.changed).toBe(false);
    expect(r.stableReads).toBe(3);
  });

  it("goes back to working when the transcript itself moves", () => {
    const prev = { text: transcriptOf(claudeIdle()), state: "waiting" as const, stableReads: 4 };
    const r = deriveTurnState(prev, CLAUDE_WORKING, "❯");
    expect(r.state).toBe("working");
    expect(r.stableReads).toBe(0);
    expect(r.lastLine).toBe("✢ Sautéing…");
    expect(r.changed).toBe(true);
  });

  it("hands back the transcript it judged, so feeding it in as prev reads as stable", () => {
    const first = deriveTurnState(null, claudeIdle(), "❯");
    expect(first.transcript).toBe(transcriptOf(claudeIdle()));
    const second = deriveTurnState(
      { text: first.transcript, state: first.state, stableReads: first.stableReads },
      claudeIdle(),
      "❯",
    );
    expect(second.stableReads).toBe(1);
  });
});
