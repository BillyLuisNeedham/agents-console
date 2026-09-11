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
