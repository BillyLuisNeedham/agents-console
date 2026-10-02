/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { LOG_PANE_MAX_CHARS, LogPane, noteLogScroll, type LogChunk } from "./log-pane";
import type { TimelineView } from "./project";

// The byte window the pane pages by, mirroring the pool server's chunk size.
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

interface LogCall {
  ticketId: string;
  attempt: number;
  offset: number;
  end?: number;
  stream?: boolean;
}

/** A log fetch whose every call returns a promise the test settles by hand. */
function fakeFetch() {
  const calls: LogCall[] = [];
  const pending: Deferred<LogChunk>[] = [];
  const fetch = (
    ticketId: string,
    attempt: number,
    offset: number,
    end?: number,
    stream?: boolean,
  ): Promise<LogChunk> => {
    calls.push({ ticketId, attempt, offset, end, stream });
    const d = deferred<LogChunk>();
    pending.push(d);
    return d.promise;
  };
  return { fetch, calls, pending };
}

function chunk(
  content: string,
  offset: number,
  nextOffset: number,
  totalSize: number,
  attempts?: { attempt: number; streamFile: string | null }[],
): LogChunk {
  return { content, offset, nextOffset, totalSize, attempts };
}

function timelineView(
  attempts: { number: number; running: boolean }[],
): TimelineView {
  return {
    attempts: attempts.map(({ number, running }) => ({
      number,
      events: [],
      reconstructed: false,
      running,
      logFile: null,
      streamFile: null,
    })),
    reconstructed: false,
  };
}

function paneWith(fetch: ReturnType<typeof fakeFetch>["fetch"]): LogPane {
  return new LogPane({ fetch, onChange: () => {} });
}

/** Let the pane's continuations run after a settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LogPane.open", () => {
  it("opens tail-first: probe the size, fetch the last window, tail the growth", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false);
    expect(pane.state.ticketId).toBe("01");
    expect(pane.state.attempt).toBe(1);
    // The probe reads past EOF for the size only.
    expect(fake.calls[0]).toMatchObject({
      ticketId: "01",
      attempt: 1,
      offset: Number.MAX_SAFE_INTEGER,
    });
    fake.pending[0].resolve(chunk("", 300, 300, 300));
    await flush();
    // The last window: totalSize - LOG_TAIL_BYTES, floored at zero.
    expect(fake.calls[1]).toMatchObject({ offset: 0 });
    fake.pending[1].resolve(chunk("tail", 0, 250, 300));
    await flush();
    expect(pane.state.content).toBe("tail");
    expect(pane.state.firstOffset).toBe(0);
    // The window fetch reported growth, so the open's trailing tail picks it up.
    expect(fake.calls[2]).toMatchObject({ offset: 250 });
    fake.pending[2].resolve(chunk("grew", 250, 300, 300));
    await opened;
    await flush();
    expect(pane.state.content).toBe("tailgrew");
    expect(pane.state.offset).toBe(300);
    expect(pane.state.totalSize).toBe(300);
  });

  it("holds an empty pane for a ticket with no attempts", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    await pane.open("01", null, false);
    expect(pane.state.ticketId).toBe("01");
    expect(pane.state.attempt).toBeNull();
    expect(pane.state.content).toBe("");
    expect(fake.calls).toHaveLength(0);
  });

  it("reports a failed fetch while the pane is still selected", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false);
    fake.pending[0].reject(new Error("boom"));
    await opened;
    expect(pane.state.error).toBe("log fetch failed: 01:1");
  });

  it("never lets a slow open clobber a newer selection", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const staleOpen = pane.open("01", 1, false);
    pane.selectAttempt("02", 3);
    expect(fake.calls.map((c) => c.ticketId)).toEqual(["01", "02"]);
    // The newer selection's open lands in full.
    fake.pending[1].resolve(chunk("", 40, 40, 40));
    await flush();
    fake.pending[2].resolve(chunk("newer", 0, 40, 40));
    await flush();
    expect(pane.state.ticketId).toBe("02");
    expect(pane.state.attempt).toBe(3);
    expect(pane.state.content).toBe("newer");
    // The stale probe answers now; its window fetch must never fire.
    fake.pending[0].resolve(chunk("", 999, 999, 999));
    await staleOpen;
    await flush();
    expect(pane.state.ticketId).toBe("02");
    expect(pane.state.attempt).toBe(3);
    expect(pane.state.content).toBe("newer");
    expect(fake.calls).toHaveLength(3);
  });

  it("never lets a slow tail clobber a newer selection", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(chunk("", 12, 12, 12));
    await flush();
    // The window fetch reports more bytes, so the trailing tail goes out.
    fake.pending[1].resolve(chunk("a", 0, 5, 12));
    await opened;
    await flush();
    expect(fake.calls[2]).toMatchObject({ attempt: 1, offset: 5 });
    // A newer selection lands while the tail fetch is out.
    pane.selectAttempt("02", 1);
    fake.pending[2].resolve(chunk("stale", 5, 12, 12));
    await flush();
    expect(pane.state.ticketId).toBe("02");
    expect(pane.state.content).toBe("");
    // The newer selection's open settles undisturbed.
    fake.pending[3].resolve(chunk("", 4, 4, 4));
    await flush();
    fake.pending[4].resolve(chunk("new", 0, 4, 4));
    await flush();
    expect(pane.state.content).toBe("new");
  });
});

describe("LogPane.follow", () => {
  it("tails the selected attempt and stops once caught up", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(chunk("", 12, 12, 12));
    await flush();
    // The window fetch serves only part of the log.
    fake.pending[1].resolve(chunk("a", 0, 5, 12));
    await flush();
    // The open's trailing tail pages forward to the end.
    expect(fake.calls[2]).toMatchObject({ attempt: 1, offset: 5 });
    fake.pending[2].resolve(chunk("b", 5, 12, 12));
    await opened;
    await flush();
    expect(pane.state.content).toBe("ab");
    expect(pane.state.offset).toBe(12);
    // Caught up: the snapshot-cadence follow issues no fetch.
    await pane.follow("01", timelineView([{ number: 1, running: true }]));
    expect(fake.calls).toHaveLength(3);
  });

  it("keeps a clicked attempt when a newer attempt starts running", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, true);
    fake.pending[0].resolve(chunk("", 10, 10, 10));
    await flush();
    fake.pending[1].resolve(chunk("one", 0, 10, 10));
    await opened;
    await flush();
    // Attempt 2 starts running; the clicked pane stays on attempt 1.
    const timeline = timelineView([
      { number: 1, running: false },
      { number: 2, running: true },
    ]);
    await pane.follow("01", timeline);
    expect(pane.state.attempt).toBe(1);
    expect(pane.state.clicked).toBe(true);
    expect(fake.calls.every((c) => c.attempt === 1)).toBe(true);
  });

  it("follows the running attempt when the pane was not clicked", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(chunk("", 10, 10, 10));
    await flush();
    fake.pending[1].resolve(chunk("one", 0, 10, 10));
    await opened;
    await flush();
    const timeline = timelineView([
      { number: 1, running: false },
      { number: 2, running: true },
    ]);
    const following = pane.follow("01", timeline);
    expect(pane.state.attempt).toBe(2);
    expect(pane.state.clicked).toBe(false);
    expect(fake.calls[2]).toMatchObject({
      attempt: 2,
      offset: Number.MAX_SAFE_INTEGER,
    });
    fake.pending[2].resolve(chunk("", 20, 20, 20));
    await flush();
    fake.pending[3].resolve(chunk("two", 0, 20, 20));
    await following;
    await flush();
    expect(pane.state.content).toBe("two");
  });

  it("opens the running attempt when the pane holds none yet", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    await pane.open("01", null, false);
    const timeline = timelineView([
      { number: 1, running: false },
      { number: 2, running: true },
    ]);
    const following = pane.follow("01", timeline);
    expect(pane.state.attempt).toBe(2);
    expect(fake.calls[0]).toMatchObject({
      attempt: 2,
      offset: Number.MAX_SAFE_INTEGER,
    });
    fake.pending[0].resolve(chunk("", 8, 8, 8));
    await flush();
    fake.pending[1].resolve(chunk("live", 0, 8, 8));
    await following;
    await flush();
    expect(pane.state.content).toBe("live");
  });
});

describe("LogPane.selectAttempt", () => {
  it("ignores re-picking the attempt already shown", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(chunk("", 10, 10, 10));
    await flush();
    fake.pending[1].resolve(chunk("one", 0, 10, 10));
    await opened;
    await flush();
    pane.selectAttempt("01", 1);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("LogPane.loadEarlier", () => {
  it("prepends the previous window until the pane holds the file head", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(
      chunk("", LOG_TAIL_BYTES + 100, LOG_TAIL_BYTES + 100, LOG_TAIL_BYTES + 100),
    );
    await flush();
    fake.pending[1].resolve(
      chunk("tail", 100, LOG_TAIL_BYTES + 100, LOG_TAIL_BYTES + 100),
    );
    await opened;
    await flush();
    expect(pane.state.firstOffset).toBe(100);
    const earlier = pane.loadEarlier("01", 1);
    // One window back from the oldest held byte, bounded by it.
    expect(fake.calls[2]).toMatchObject({ offset: 0, end: 100 });
    fake.pending[2].resolve(chunk("head", 0, 100, LOG_TAIL_BYTES + 100));
    await earlier;
    expect(pane.state.content).toBe("headtail");
    expect(pane.state.firstOffset).toBe(0);
    // The pane holds the file head: no further earlier fetch.
    await pane.loadEarlier("01", 1);
    expect(fake.calls).toHaveLength(3);
  });

  it("never lets a slow load-earlier land on a newer selection", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(
      chunk("", LOG_TAIL_BYTES + 100, LOG_TAIL_BYTES + 100, LOG_TAIL_BYTES + 100),
    );
    await flush();
    fake.pending[1].resolve(
      chunk("tail", 100, LOG_TAIL_BYTES + 100, LOG_TAIL_BYTES + 100),
    );
    await opened;
    await flush();
    const earlier = pane.loadEarlier("01", 1);
    // A newer selection lands while the earlier fetch is out.
    pane.selectAttempt("01", 2);
    fake.pending[2].resolve(chunk("stale", 0, 100, LOG_TAIL_BYTES + 100));
    await earlier;
    expect(pane.state.attempt).toBe(2);
    expect(pane.state.content).toBe("");
    // The newer selection's open settles undisturbed.
    fake.pending[3].resolve(chunk("", 7, 7, 7));
    await flush();
    fake.pending[4].resolve(chunk("two", 0, 7, 7));
    await flush();
    expect(pane.state.content).toBe("two");
  });

  it("drops a slow open when the same attempt was re-opened underneath it", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const first = pane.open("01", 1, false);
    // A re-open of the very same attempt begins a newer window while the
    // first open's probe is still out.
    const second = pane.open("01", 1, false);
    fake.pending[0].resolve(chunk("", 300, 300, 300));
    fake.pending[1].resolve(chunk("", 300, 300, 300));
    await flush();
    // The first open's probe answer is stale: it fetches no further. Only
    // the second open reads the window, so the content cannot double-append.
    expect(fake.calls).toHaveLength(3);
    fake.pending[2].resolve(chunk("tail", 0, 250, 300));
    await flush();
    expect(pane.state.content).toBe("tail");
    fake.pending[3].resolve(chunk("grew", 250, 300, 300));
    await first;
    await second;
    await flush();
    expect(pane.state.content).toBe("tailgrew");
  });
});

describe("LogPane stream variant", () => {
  it("opens a Stream file with the stream flag and holds the response's listing", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const listing = [
      { attempt: 1, streamFile: null },
      { attempt: 2, streamFile: "01.attempt-2.stream.jsonl" },
    ];
    const opened = pane.open("01", 2, true, true);
    expect(pane.state.stream).toBe(true);
    expect(fake.calls[0]).toMatchObject({
      ticketId: "01",
      attempt: 2,
      offset: Number.MAX_SAFE_INTEGER,
      stream: true,
    });
    fake.pending[0].resolve(chunk("", 300, 300, 300));
    await flush();
    expect(fake.calls[1]).toMatchObject({ offset: 0, stream: true });
    fake.pending[1].resolve(chunk("raw", 0, 300, 300, listing));
    await opened;
    await flush();
    expect(pane.state.content).toBe("raw");
    expect(pane.state.attempts).toEqual(listing);
  });

  it("selectStream switches the pane to the stream and back, no-op only when already there", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(chunk("", 10, 10, 10));
    await flush();
    fake.pending[1].resolve(chunk("log", 0, 10, 10));
    await opened;
    await flush();
    // Picking the attempt row again while the log shows: a no-op.
    pane.selectAttempt("01", 1);
    expect(fake.calls).toHaveLength(2);
    // The stream link reopens the same attempt in the stream variant.
    pane.selectStream("01", 1);
    expect(fake.calls[2]).toMatchObject({ attempt: 1, offset: Number.MAX_SAFE_INTEGER, stream: true });
    fake.pending[2].resolve(chunk("", 9, 9, 9));
    await flush();
    fake.pending[3].resolve(chunk("stream", 0, 9, 9));
    await flush();
    expect(pane.state.stream).toBe(true);
    expect(pane.state.content).toBe("stream");
    // Re-picking the shown stream is a no-op; the attempt row switches back
    // to the derived log.
    pane.selectStream("01", 1);
    expect(fake.calls).toHaveLength(4);
    pane.selectAttempt("01", 1);
    expect(fake.calls[4]).toMatchObject({ attempt: 1, stream: false });
    fake.pending[4].resolve(chunk("", 5, 5, 5));
    await flush();
    fake.pending[5].resolve(chunk("log2", 0, 5, 5));
    await flush();
    expect(pane.state.stream).toBe(false);
    expect(pane.state.content).toBe("log2");
  });

  it("keeps the stream variant when an unclicked pane follows a new attempt", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false, true);
    fake.pending[0].resolve(chunk("", 10, 10, 10));
    await flush();
    fake.pending[1].resolve(chunk("one", 0, 10, 10));
    await opened;
    await flush();
    // Attempt 2 starts running; the unclicked pane follows it and stays in
    // the stream variant.
    const following = pane.follow(
      "01",
      timelineView([
        { number: 1, running: false },
        { number: 2, running: true },
      ]),
    );
    expect(pane.state.attempt).toBe(2);
    expect(pane.state.stream).toBe(true);
    expect(fake.calls[2]).toMatchObject({ attempt: 2, offset: Number.MAX_SAFE_INTEGER, stream: true });
    fake.pending[2].resolve(chunk("", 8, 8, 8));
    await flush();
    fake.pending[3].resolve(chunk("two", 0, 8, 8));
    await following;
    await flush();
    expect(pane.state.content).toBe("two");
  });

  it("never lets an in-flight log tail land after the pane switched to the stream", async () => {
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(chunk("", 12, 12, 12));
    await flush();
    fake.pending[1].resolve(chunk("a", 0, 5, 12));
    await opened;
    await flush();
    // The log's trailing tail fetch is out when the stream link fires.
    expect(fake.calls[2]).toMatchObject({ offset: 5, stream: false });
    pane.selectStream("01", 1);
    fake.pending[3].resolve(chunk("", 8, 8, 8));
    await flush();
    fake.pending[4].resolve(chunk("stream-head", 0, 8, 8));
    await flush();
    // The stale log tail answers now: it must not append into the stream view.
    fake.pending[2].resolve(chunk("STALE-LOG", 5, 12, 12));
    await flush();
    expect(pane.state.content).toBe("stream-head");
    expect(pane.state.stream).toBe(true);
  });
});

describe("LogPane under load (issue #157)", () => {
  it("repaints once for a catch-up tail, however many chunks it reads", async () => {
    const fake = fakeFetch();
    let changes = 0;
    const pane = new LogPane({
      fetch: fake.fetch,
      onChange: () => {
        changes += 1;
      },
    });
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(chunk("", 30, 30, 30));
    await flush();
    fake.pending[1].resolve(chunk("a", 0, 10, 30));
    await opened;
    await flush();
    const atTail = changes;
    fake.pending[2].resolve(chunk("b", 10, 20, 30));
    await flush();
    fake.pending[3].resolve(chunk("c", 20, 30, 30));
    await flush();
    expect(pane.state.content).toBe("abc");
    expect(changes - atTail).toBe(1);
  });

  it("aborts the old window's reads when the pane moves to another", () => {
    const signals: AbortSignal[] = [];
    const pane = new LogPane({
      fetch: (_ticketId, _attempt, _offset, _end, _stream, signal) => {
        if (signal) signals.push(signal);
        return new Promise<LogChunk>(() => {});
      },
      onChange: () => {},
    });
    void pane.open("01", 1, false);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    pane.selectAttempt("02", 1);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    pane.reset();
    expect(signals[1]!.aborted).toBe(true);
  });

  it("lets go of the oldest whole chunks past the cap while it follows, and load earlier reads them back", async () => {
    noteLogScroll(100, 100, 200);
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const big = (letter: string) => letter.repeat(100_000);
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(chunk("", 100, 100, 400));
    await flush();
    fake.pending[1].resolve(chunk(big("a"), 0, 100, 400));
    await opened;
    await flush();
    fake.pending[2].resolve(chunk(big("b"), 100, 200, 400));
    await flush();
    fake.pending[3].resolve(chunk(big("c"), 200, 300, 400));
    await flush();
    fake.pending[4].resolve(chunk(big("d"), 300, 400, 400));
    await flush();
    // 400k held is past the 256k cap: the two oldest chunks go, whole.
    expect(pane.state.content.length).toBeLessThanOrEqual(LOG_PANE_MAX_CHARS);
    expect(pane.state.content).toBe(big("c") + big("d"));
    expect(pane.state.firstOffset).toBe(200);
    void pane.loadEarlier("01", 1);
    expect(fake.calls[5]).toMatchObject({ end: 200 });
  });

  it("skips a backlog past the cap to the last window instead of reading it all", async () => {
    noteLogScroll(100, 100, 200);
    const fake = fakeFetch();
    const pane = paneWith(fake.fetch);
    const total = 10_000_000;
    const opened = pane.open("01", 1, false);
    fake.pending[0].resolve(chunk("", 1, 1, 1));
    await flush();
    fake.pending[1].resolve(chunk("old", 0, 1, total));
    await opened;
    await flush();
    expect(fake.calls[2]).toMatchObject({ offset: total - LOG_TAIL_BYTES });
    fake.pending[2].resolve(chunk("newest", total - LOG_TAIL_BYTES, total, total));
    await flush();
    expect(pane.state.content).toBe("newest");
    expect(pane.state.firstOffset).toBe(total - LOG_TAIL_BYTES);
    expect(fake.calls).toHaveLength(3);
  });
});
