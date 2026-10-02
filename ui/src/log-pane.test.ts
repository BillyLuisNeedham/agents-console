/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { LogFollow, LogPush, LogReadRequest } from "../../engine/protocol.ts";
import { LOG_PANE_MAX_CHARS, LogPane, noteLogScroll } from "./log-pane";
import { earlierLogOffset, type TicketLogResponse } from "./project";

// The byte window the server pages by: a window is the file's last one.
const LOG_TAIL_BYTES = 64 * 1024;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type AttemptRow = TicketLogResponse["attempts"][number];

function attemptRow(attempt: number, streamFile: string | null = null): AttemptRow {
  return { attempt, kind: "implement", logFile: `runs/01/${attempt}.log`, streamFile, current: false };
}

/** A `window` frame for attempt 1's derived log unless `extra` says otherwise. */
function windowPush(
  content: string,
  offset: number,
  nextOffset: number,
  totalSize: number,
  extra: Partial<LogPush> = {},
): LogPush {
  return { mode: "window", attempt: 1, stream: false, content, offset, nextOffset, totalSize, ...extra };
}

/** An `append` frame continuing from `offset`, one byte per character. */
function appendPush(content: string, offset: number, extra: Partial<LogPush> = {}): LogPush {
  const nextOffset = offset + content.length;
  return {
    mode: "append",
    attempt: 1,
    stream: false,
    content,
    offset,
    nextOffset,
    totalSize: nextOffset,
    ...extra,
  };
}

function response(
  content: string,
  offset: number,
  nextOffset: number,
  totalSize: number,
  attempts: AttemptRow[] = [],
): TicketLogResponse {
  return { content, offset, nextOffset, totalSize, attempts };
}

/**
 * A pane over hand-settled seams: every follow and read parks on a deferred
 * the test settles when it chooses, and repaints are counted, so a test
 * pins what was asked and when the pane repainted before any answer lands.
 */
function rig() {
  const follows: { ticketId: string; follow: LogFollow; d: Deferred<TicketLogResponse> }[] = [];
  const reads: { request: LogReadRequest; d: Deferred<TicketLogResponse> }[] = [];
  let changes = 0;
  const pane = new LogPane({
    follow: (ticketId, follow) => {
      const d = deferred<TicketLogResponse>();
      follows.push({ ticketId, follow, d });
      return d.promise;
    },
    read: (request) => {
      const d = deferred<TicketLogResponse>();
      reads.push({ request, d });
      return d.promise;
    },
    onChange: () => {
      changes += 1;
    },
  });
  return { pane, follows, reads, changes: () => changes };
}

/** Let the pane's continuations run after a settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LogPane windows", () => {
  it("replaces what the card holds with each window the server pushes", () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push(
      "01",
      windowPush("tail of one", 100, 111, 111, { attempts: [attemptRow(1, "s1.jsonl")] }),
    );
    expect(r.pane.state).toMatchObject({
      ticketId: "01",
      attempt: 1,
      clicked: false,
      stream: false,
      content: "tail of one",
      firstOffset: 100,
      offset: 111,
      totalSize: 111,
      error: null,
    });
    expect(r.pane.state.attempts).toEqual([attemptRow(1, "s1.jsonl")]);
    // A new attempt started: the server moves the unclicked pane to it.
    r.pane.push("01", windowPush("two", 0, 3, 3, { attempt: 2, attempts: [attemptRow(1), attemptRow(2)] }));
    expect(r.pane.state).toMatchObject({ attempt: 2, content: "two", firstOffset: 0, offset: 3 });
    expect(r.pane.state.attempts.map((row) => row.attempt)).toEqual([1, 2]);
  });

  it("holds an empty pane for a card with no attempt", () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", null);
    expect(r.pane.state).toMatchObject({ ticketId: "01", attempt: null, content: "", offset: 0 });
    expect(r.follows).toHaveLength(0);
  });

  it("shows an empty pane for the shown card until its first window lands", () => {
    const r = rig();
    r.pane.show("01");
    expect(r.pane.state).toMatchObject({ ticketId: "01", attempt: null, content: "" });
    r.pane.reset();
    expect(r.pane.state.ticketId).toBeNull();
  });
});

describe("LogPane appends", () => {
  it("continues the window from the byte it holds", () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("abc", 0, 3, 3));
    r.pane.push("01", appendPush("def", 3));
    expect(r.pane.state).toMatchObject({ content: "abcdef", firstOffset: 0, offset: 6, totalSize: 6 });
    r.pane.push("01", appendPush("g", 6, { attempts: [attemptRow(1, "s.jsonl")] }));
    expect(r.pane.state.content).toBe("abcdefg");
    expect(r.pane.state.attempts).toEqual([attemptRow(1, "s.jsonl")]);
    expect(r.follows).toHaveLength(0);
  });

  it("drops an append that does not match the attempt or variant it holds", () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("two", 0, 3, 3, { attempt: 2 }));
    // Frames already on the wire when the pane moved name the old log.
    r.pane.push("01", appendPush("old attempt", 3, { attempt: 1 }));
    r.pane.push("01", appendPush("stream bytes", 3, { attempt: 2, stream: true }));
    expect(r.pane.state).toMatchObject({ attempt: 2, stream: false, content: "two", offset: 3 });
    expect(r.follows).toHaveLength(0);
  });

  it("drops an append for a card that holds no window yet", () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", appendPush("orphan", 0));
    expect(r.pane.state).toMatchObject({ attempt: null, content: "" });
    expect(r.follows).toHaveLength(0);
  });

  it("re-sends an unclicked pane's follow on a gap, drops appends while it is out, and takes its window", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("abc", 0, 3, 3));
    r.pane.push("01", appendPush("lost the bytes before", 10));
    expect(r.follows).toHaveLength(1);
    expect(r.follows[0]).toMatchObject({ ticketId: "01", follow: { attempt: null, stream: false } });
    expect(r.pane.state.content).toBe("abc");
    // While the follow is out, appends wait for its window.
    r.pane.push("01", appendPush("def", 3));
    expect(r.pane.state.content).toBe("abc");
    r.follows[0]!.d.resolve(response("fresh tail", 100, 110, 110, [attemptRow(1)]));
    await flush();
    expect(r.pane.state).toMatchObject({
      attempt: 1,
      stream: false,
      content: "fresh tail",
      firstOffset: 100,
      offset: 110,
      totalSize: 110,
    });
    r.pane.push("01", appendPush("!", 110));
    expect(r.pane.state.content).toBe("fresh tail!");
  });

  it("re-sends a clicked pane's own follow on a gap", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("one", 0, 3, 3, { attempt: 3 }));
    r.pane.selectStream("01", 2);
    r.follows[0]!.d.resolve(response("stream", 0, 6, 6));
    await flush();
    expect(r.pane.state).toMatchObject({ attempt: 2, stream: true, clicked: true, content: "stream" });
    r.pane.push("01", appendPush("gap", 50, { attempt: 2, stream: true }));
    expect(r.follows[1]).toMatchObject({ ticketId: "01", follow: { attempt: 2, stream: true } });
  });
});

describe("LogPane picked attempts", () => {
  it("shows a picked attempt at once, empty, and fills it from its follow's window", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("two", 0, 3, 3, { attempt: 2 }));
    const before = r.changes();
    r.pane.selectAttempt("01", 1);
    // The press's own change, before anything answers.
    expect(r.changes()).toBe(before + 1);
    expect(r.pane.state).toMatchObject({ attempt: 1, clicked: true, stream: false, content: "" });
    expect(r.follows).toHaveLength(1);
    expect(r.follows[0]).toMatchObject({ ticketId: "01", follow: { attempt: 1, stream: false } });
    r.follows[0]!.d.resolve(response("one", 7, 10, 10, [attemptRow(1), attemptRow(2)]));
    await flush();
    expect(r.pane.state).toMatchObject({
      attempt: 1,
      clicked: true,
      content: "one",
      firstOffset: 7,
      offset: 10,
      totalSize: 10,
    });
    expect(r.pane.state.attempts.map((row) => row.attempt)).toEqual([1, 2]);
  });

  it("follows a picked Stream file the same way", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("derived", 0, 7, 7));
    r.pane.selectStream("01", 1);
    expect(r.pane.state).toMatchObject({ attempt: 1, stream: true, clicked: true, content: "" });
    expect(r.follows[0]).toMatchObject({ follow: { attempt: 1, stream: true } });
    r.follows[0]!.d.resolve(response("{\"raw\":1}", 0, 9, 9));
    await flush();
    expect(r.pane.state).toMatchObject({ stream: true, content: "{\"raw\":1}" });
  });

  it("sends nothing for the attempt and variant already shown, and switches variants", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("one", 0, 3, 3));
    r.pane.selectAttempt("01", 1);
    expect(r.follows).toHaveLength(0);
    r.pane.selectStream("01", 1);
    expect(r.follows).toHaveLength(1);
    r.follows[0]!.d.resolve(response("raw", 0, 3, 3));
    await flush();
    r.pane.selectStream("01", 1);
    expect(r.follows).toHaveLength(1);
    r.pane.selectAttempt("01", 1);
    expect(r.follows).toHaveLength(2);
    expect(r.follows[1]).toMatchObject({ follow: { attempt: 1, stream: false } });
  });

  it("drops a follow's window that lands after a newer pick", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("three", 0, 5, 5, { attempt: 3 }));
    r.pane.selectAttempt("01", 1);
    r.pane.selectAttempt("01", 2);
    r.follows[0]!.d.resolve(response("one", 0, 3, 3));
    await flush();
    expect(r.pane.state).toMatchObject({ attempt: 2, content: "" });
    r.follows[1]!.d.resolve(response("two", 0, 3, 3));
    await flush();
    expect(r.pane.state).toMatchObject({ attempt: 2, content: "two" });
  });

  it("drops a window the server pushes for the old follow while a pick is out", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("two", 0, 3, 3, { attempt: 2 }));
    r.pane.selectAttempt("01", 1);
    r.pane.push("01", windowPush("new latest", 0, 10, 10, { attempt: 3 }));
    expect(r.pane.state).toMatchObject({ attempt: 1, content: "" });
    r.follows[0]!.d.resolve(response("one", 0, 3, 3));
    await flush();
    expect(r.pane.state).toMatchObject({ attempt: 1, content: "one" });
  });

  it("marks the pane when a follow is refused", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("one", 0, 3, 3));
    r.pane.selectAttempt("01", 2);
    r.follows[0]!.d.reject(new Error("unknown attempt"));
    await flush();
    expect(r.pane.state.error).toBe("log fetch failed: 01:2");
    // The appends are no longer held back for it.
    r.pane.push("01", appendPush("x", 0, { attempt: 2 }));
    expect(r.pane.state.content).toBe("x");
  });
});

describe("LogPane.loadEarlier", () => {
  it("prepends the range before the oldest byte held until the pane holds the head", async () => {
    const r = rig();
    r.pane.show("01");
    const first = 2 * LOG_TAIL_BYTES;
    r.pane.push("01", windowPush("c", first, first + 1, first + 1));
    void r.pane.loadEarlier("01", 1);
    expect(r.reads).toHaveLength(1);
    expect(r.reads[0]!.request).toEqual({
      id: "01",
      attempt: 1,
      offset: earlierLogOffset(first)!,
      end: first,
      stream: false,
    });
    r.reads[0]!.d.resolve(response("b", LOG_TAIL_BYTES, first, first + 1));
    await flush();
    expect(r.pane.state).toMatchObject({ content: "bc", firstOffset: LOG_TAIL_BYTES, offset: first + 1 });
    void r.pane.loadEarlier("01", 1);
    expect(r.reads[1]!.request).toMatchObject({ offset: 0, end: LOG_TAIL_BYTES });
    r.reads[1]!.d.resolve(response("a", 0, LOG_TAIL_BYTES, first + 1));
    await flush();
    expect(r.pane.state).toMatchObject({ content: "abc", firstOffset: 0 });
    void r.pane.loadEarlier("01", 1);
    expect(r.reads).toHaveLength(2);
  });

  it("reads once at a time, and only for the attempt it holds", () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("tail", 500, 504, 504));
    void r.pane.loadEarlier("01", 2);
    expect(r.reads).toHaveLength(0);
    void r.pane.loadEarlier("01", 1);
    void r.pane.loadEarlier("01", 1);
    expect(r.reads).toHaveLength(1);
  });

  it("reads the Stream file's earlier bytes for a pane showing it", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.selectStream("01", 1);
    r.follows[0]!.d.resolve(response("raw", 900, 903, 903));
    await flush();
    void r.pane.loadEarlier("01", 1);
    expect(r.reads[0]!.request).toMatchObject({ stream: true, end: 900 });
  });

  it("drops a read that lands after a new window replaced the pane", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("old", 500, 503, 503));
    void r.pane.loadEarlier("01", 1);
    r.pane.push("01", windowPush("new", 900, 903, 903));
    r.reads[0]!.d.resolve(response("earlier", 0, 500, 503));
    await flush();
    expect(r.pane.state).toMatchObject({ content: "new", firstOffset: 900 });
  });

  it("marks the pane when a read fails", async () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("tail", 500, 504, 504));
    void r.pane.loadEarlier("01", 1);
    r.reads[0]!.d.reject(new Error("gone"));
    await flush();
    expect(r.pane.state.error).toBe("log fetch failed: 01:1");
    expect(r.pane.state.content).toBe("tail");
  });
});

describe("LogPane cap (issue #157)", () => {
  const big = (letter: string) => letter.repeat(100_000);

  /** A window of `a` then appends of `b`, `c`, `d`, each a 100-byte step. */
  function fill(pane: LogPane, id: string): void {
    pane.push(id, windowPush(big("a"), 0, 100, 100));
    pane.push(id, appendPush(big("b"), 100, { nextOffset: 200, totalSize: 200 }));
    pane.push(id, appendPush(big("c"), 200, { nextOffset: 300, totalSize: 300 }));
    pane.push(id, appendPush(big("d"), 300, { nextOffset: 400, totalSize: 400 }));
  }

  it("lets go of the oldest whole chunks past the cap while pinned, and load earlier reads them back", () => {
    noteLogScroll(100, 100, 200);
    const r = rig();
    r.pane.show("01");
    fill(r.pane, "01");
    // 400k held is past the 256k cap: the two oldest chunks go, whole.
    expect(r.pane.state.content.length).toBeLessThanOrEqual(LOG_PANE_MAX_CHARS);
    expect(r.pane.state.content).toBe(big("c") + big("d"));
    expect(r.pane.state.firstOffset).toBe(200);
    void r.pane.loadEarlier("01", 1);
    expect(r.reads[0]!.request).toMatchObject({ end: 200 });
  });

  it("keeps everything for a shown pane scrolled off the tail, but caps a prefetched one", () => {
    noteLogScroll(0, 100, 1_000);
    try {
      const r = rig();
      r.pane.show("01");
      fill(r.pane, "01");
      expect(r.pane.state.content.length).toBe(400_000);
      expect(r.pane.state.firstOffset).toBe(0);
      fill(r.pane, "02");
      r.pane.show("02");
      expect(r.pane.state.content).toBe(big("c") + big("d"));
    } finally {
      noteLogScroll(100, 100, 200);
    }
  });
});

describe("LogPane prefetch (issue #161)", () => {
  it("holds a card's frames while it is not shown, without a repaint, and shows them at once", () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("02", windowPush("prefetched", 0, 10, 10));
    r.pane.push("02", appendPush(" and more", 10));
    expect(r.changes()).toBe(0);
    expect(r.pane.state).toMatchObject({ ticketId: "01", content: "" });
    r.pane.show("02");
    expect(r.pane.state).toMatchObject({
      ticketId: "02",
      attempt: 1,
      content: "prefetched and more",
      offset: 19,
    });
  });

  it("repaints only for the shown card's changes", () => {
    const r = rig();
    r.pane.show("01");
    r.pane.push("01", windowPush("one", 0, 3, 3));
    expect(r.changes()).toBe(1);
    r.pane.push("02", windowPush("two", 0, 3, 3));
    r.pane.push("02", appendPush("!", 3));
    expect(r.changes()).toBe(1);
    r.pane.push("01", appendPush("!", 3));
    expect(r.changes()).toBe(2);
  });

  it("lets a forgotten card's log go, and drops a follow that answers for it", async () => {
    const r = rig();
    r.pane.push("02", windowPush("two", 0, 3, 3));
    r.pane.forget("02");
    r.pane.show("02");
    expect(r.pane.state).toMatchObject({ ticketId: "02", attempt: null, content: "" });
    r.pane.push("02", windowPush("again", 0, 5, 5));
    r.pane.selectAttempt("02", 4);
    r.pane.forget("02");
    r.follows[0]!.d.resolve(response("late", 0, 4, 4));
    await flush();
    expect(r.pane.state).toMatchObject({ ticketId: "02", attempt: null, content: "" });
  });
});
