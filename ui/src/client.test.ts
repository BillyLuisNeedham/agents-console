/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  PoolClient,
  refetchStateOnVisible,
  STREAM_HEARTBEAT_MS,
  STREAM_SILENCE_FACTOR,
} from "./client";
import type { PoolSnapshot } from "./project";

// The client's stream seam: a fake fetch feeding controllable byte streams,
// and fake timers to drive the silence watchdog, so the self-healing behavior
// is pinned without a server or a browser. A real EventSource would not do
// here: the heartbeat is an SSE comment frame, which a browser EventSource
// never dispatches, so the client reads the raw stream and any frame counts
// as liveness.

const SILENCE_MS = STREAM_HEARTBEAT_MS * STREAM_SILENCE_FACTOR;

function snap(seq: number): PoolSnapshot {
  return {
    seq,
    phase: "running",
    poolName: "repo/pool",
    state: {
      tickets: [
        {
          id: "01",
          title: "t",
          blockedBy: [],
          status: "ready",
          assignment: { harness: null, model: null, drivers: "implement" },
        },
      ],
      log: [],
      outcomes: {},
      interrupts: [],
      queuedAnswers: [],
      config: {},
    },
  };
}

function snapshotFrame(snapshot: PoolSnapshot): string {
  return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

const HEARTBEAT_FRAME = ": heartbeat\n\n";

function streamConfigFrame(heartbeatMs: number): string {
  return `event: stream-config\ndata: ${JSON.stringify({ heartbeatMs })}\n\n`;
}

interface ReadResult {
  value?: Uint8Array;
  done: boolean;
}

/** A controllable stream body: the test pushes frames and closes at will. */
class FakeStream {
  cancelCount = 0;
  private queue: Uint8Array[] = [];
  private waiters: Array<{
    resolve: (r: ReadResult) => void;
    reject: (err: unknown) => void;
  }> = [];
  private finished = false;

  read(): Promise<ReadResult> {
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift()!, done: false });
    }
    if (this.finished) return Promise.resolve({ done: true });
    return new Promise<ReadResult>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  push(text: string): void {
    this.queue.push(new TextEncoder().encode(text));
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: this.queue.shift()!, done: false });
  }

  close(): void {
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true });
    }
  }

  cancel(): Promise<void> {
    this.cancelCount += 1;
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("stream cancelled"));
    }
    return Promise.resolve();
  }
}

/** A fetch stub that hands each call its own FakeStream, in order. */
function streamFetch() {
  const streams: FakeStream[] = [];
  const fetch = (async () => {
    const stream = new FakeStream();
    streams.push(stream);
    return {
      ok: true,
      status: 200,
      body: { getReader: () => stream },
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, streams };
}

/** A fetch stub whose every call rejects: the server is down. */
function downFetch() {
  const calls: number[] = [];
  const fetch = (() => {
    calls.push(1);
    return Promise.reject(new Error("network down"));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Minimal fake setTimeout/clearTimeout, since bun 1.3 lacks mock.timers. */
function fakeTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  globalThis.setTimeout = ((fn: () => void, ms = 0) => {
    const id = ++seq;
    jobs.set(id, { at: now + ms, fn });
    return id;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    jobs.delete(id);
  }) as unknown as typeof globalThis.clearTimeout;
  return {
    /** Advance the clock; due jobs run in order. */
    tick(ms: number): void {
      now += ms;
      for (const [id, job] of [...jobs]) {
        if (job.at <= now) {
          jobs.delete(id);
          job.fn();
        }
      }
    },
    restore(): void {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

const realFetch = globalThis.fetch;
let timers: ReturnType<typeof fakeTimers> | null = null;

beforeEach(() => {
  timers = fakeTimers();
});

afterEach(() => {
  timers?.restore();
  timers = null;
  globalThis.fetch = realFetch;
});

/** Let the client's async continuation run to its next parked read. */
function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe("PoolClient.stream", () => {
  it("renders a snapshot frame", async () => {
    const { fetch, streams } = streamFetch();
    globalThis.fetch = fetch;
    const snapshots: PoolSnapshot[] = [];
    const errors: string[] = [];
    const client = new PoolClient();
    client.stream({
      onSnapshot: (s) => snapshots.push(s),
      onError: (m) => errors.push(m),
    });
    await flush();
    streams[0]!.push(snapshotFrame(snap(7)));
    await flush();
    expect(snapshots.map((s) => s.seq)).toEqual([7]);
    expect(errors).toEqual([]);
  });

  it("counts a heartbeat comment frame as liveness but never as a snapshot", async () => {
    const { fetch, streams } = streamFetch();
    globalThis.fetch = fetch;
    const snapshots: PoolSnapshot[] = [];
    const client = new PoolClient();
    client.stream({
      onSnapshot: (s) => snapshots.push(s),
      onError: () => {},
    });
    await flush();
    // Half the silence window passes, then a heartbeat keeps the stream alive.
    timers!.tick(SILENCE_MS / 2);
    streams[0]!.push(HEARTBEAT_FRAME);
    await flush();
    // Past the original expiry the stream still has not reopened: the heartbeat
    // reset the window, and a heartbeat never renders as a snapshot.
    timers!.tick(SILENCE_MS / 2);
    expect(streams.length).toBe(1);
    expect(snapshots).toEqual([]);
    // A full window past the heartbeat, silence finally reopens the stream.
    timers!.tick(SILENCE_MS / 2);
    expect(streams.length).toBe(2);
  });

  it("derives the silence window from the served heartbeat interval", async () => {
    const { fetch, streams } = streamFetch();
    globalThis.fetch = fetch;
    const snapshots: PoolSnapshot[] = [];
    const client = new PoolClient();
    client.stream({
      onSnapshot: (s) => snapshots.push(s),
      onError: () => {},
    });
    await flush();
    // The server's opening frame publishes a 100ms interval: the silence
    // window becomes 300ms, far inside the fallback's. The config frame is
    // liveness and never renders as a snapshot.
    streams[0]!.push(streamConfigFrame(100));
    await flush();
    expect(snapshots).toEqual([]);
    timers!.tick(299);
    expect(streams.length).toBe(1);
    timers!.tick(1);
    expect(streams.length).toBe(2);
  });

  it("keeps the fallback silence window when no stream-config frame arrives", async () => {
    const { fetch, streams } = streamFetch();
    globalThis.fetch = fetch;
    const client = new PoolClient();
    client.stream({
      onSnapshot: () => {},
      onError: () => {},
    });
    await flush();
    timers!.tick(SILENCE_MS - 1);
    expect(streams.length).toBe(1);
    timers!.tick(1);
    expect(streams.length).toBe(2);
  });

  it("ignores a stream-config frame whose interval is not a positive number", async () => {
    const { fetch, streams } = streamFetch();
    globalThis.fetch = fetch;
    const client = new PoolClient();
    client.stream({
      onSnapshot: () => {},
      onError: () => {},
    });
    await flush();
    streams[0]!.push("event: stream-config\ndata: {}\n\n");
    await flush();
    // The fallback window still applies: one full window reopens, nothing sooner.
    timers!.tick(SILENCE_MS - 1);
    expect(streams.length).toBe(1);
    timers!.tick(1);
    expect(streams.length).toBe(2);
  });

  it("tears down a silent stream, reopens it, and renders the replayed snapshot", async () => {
    const { fetch, streams } = streamFetch();
    globalThis.fetch = fetch;
    const snapshots: PoolSnapshot[] = [];
    const errors: string[] = [];
    const client = new PoolClient();
    client.stream({
      onSnapshot: (s) => snapshots.push(s),
      onError: (m) => errors.push(m),
    });
    await flush();
    streams[0]!.push(snapshotFrame(snap(1)));
    await flush();
    expect(snapshots.map((s) => s.seq)).toEqual([1]);

    // The stream goes silent mid-run: no frames and no error event.
    timers!.tick(SILENCE_MS);
    await flush();
    expect(streams[0]!.cancelCount).toBe(1);
    expect(streams.length).toBe(2);
    expect(errors).toEqual([]);

    // The reopened stream replays the latest snapshot on connect.
    streams[1]!.push(snapshotFrame(snap(2)));
    await flush();
    expect(snapshots.map((s) => s.seq)).toEqual([1, 2]);
    expect(errors).toEqual([]);
  });

  it("surfaces a genuinely down server through onError and retries the reopen", async () => {
    const { fetch, calls } = downFetch();
    globalThis.fetch = fetch;
    const errors: string[] = [];
    const client = new PoolClient();
    client.stream({
      onSnapshot: () => {},
      onError: (m) => errors.push(m),
    });
    await flush();
    expect(errors).toEqual(["network down"]);
    expect(calls.length).toBe(1);

    // The retry reopens on the EventSource-like cadence and fails again.
    timers!.tick(3_000);
    await flush();
    expect(calls.length).toBe(2);
    expect(errors).toEqual(["network down", "network down"]);
  });

  it("treats a server-closed stream as a disconnect and reconnects", async () => {
    const { fetch, streams } = streamFetch();
    globalThis.fetch = fetch;
    const errors: string[] = [];
    const client = new PoolClient();
    client.stream({
      onSnapshot: () => {},
      onError: (m) => errors.push(m),
    });
    await flush();
    streams[0]!.close();
    await flush();
    expect(errors).toEqual(["pool stream disconnected"]);

    timers!.tick(3_000);
    await flush();
    expect(streams.length).toBe(2);
  });

  it("stops everything once the close handle is called", async () => {
    const { fetch, streams } = streamFetch();
    globalThis.fetch = fetch;
    const snapshots: PoolSnapshot[] = [];
    const errors: string[] = [];
    const client = new PoolClient();
    const close = client.stream({
      onSnapshot: (s) => snapshots.push(s),
      onError: (m) => errors.push(m),
    });
    await flush();
    streams[0]!.push(snapshotFrame(snap(1)));
    await flush();
    expect(snapshots.map((s) => s.seq)).toEqual([1]);

    close();
    expect(streams[0]!.cancelCount).toBe(1);
    timers!.tick(SILENCE_MS + 10_000);
    await flush();
    expect(streams.length).toBe(1);
    expect(snapshots.map((s) => s.seq)).toEqual([1]);
    expect(errors).toEqual([]);
  });
});

describe("refetchStateOnVisible", () => {
  function source() {
    const listeners = new Set<() => void>();
    return {
      visibilityState: "hidden",
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
      fire: () => {
        for (const listener of [...listeners]) listener();
      },
    };
  }

  it("refetches the latest snapshot when the page returns to visible", async () => {
    const s = source();
    const fetched: PoolSnapshot[] = [];
    const rendered: PoolSnapshot[] = [];
    refetchStateOnVisible(
      s,
      () => {
        fetched.push(snap(3));
        return Promise.resolve(snap(3));
      },
      (snapshot) => rendered.push(snapshot),
    );
    // Hidden transitions never refetch.
    s.fire();
    await flush();
    expect(fetched).toEqual([]);

    s.visibilityState = "visible";
    s.fire();
    await flush();
    expect(fetched.map((x) => x.seq)).toEqual([3]);
    expect(rendered.map((x) => x.seq)).toEqual([3]);
  });

  it("ignores a failed refetch and lets the stream recover", async () => {
    const s = source();
    const rendered: PoolSnapshot[] = [];
    refetchStateOnVisible(
      s,
      () => Promise.reject(new Error("pool state failed: 500")),
      (snapshot) => rendered.push(snapshot),
    );
    s.visibilityState = "visible";
    s.fire();
    await flush();
    expect(rendered).toEqual([]);
  });
});