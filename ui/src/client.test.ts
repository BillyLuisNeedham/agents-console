/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  PoolClient,
  refetchStateOnVisible,
  STREAM_HEARTBEAT_MS,
  STREAM_SILENCE_FACTOR,
} from "./client";
import type {
  ConversationView,
  EnrichedSnapshot,
  SettingsResponse,
} from "./project";

// The client's stream seam: a fake fetch feeding controllable byte streams,
// and fake timers to drive the silence watchdog, so the self-healing behavior
// is pinned without a server or a browser. A real EventSource would not do
// here: the heartbeat is an SSE comment frame, which a browser EventSource
// never dispatches, so the client reads the raw stream and any frame counts
// as liveness.

const SILENCE_MS = STREAM_HEARTBEAT_MS * STREAM_SILENCE_FACTOR;

function snap(seq: number): EnrichedSnapshot {
  return {
    seq,
    phase: "running",
    poolName: "repo/pool",
    poolDir: "/tmp/pool",
    state: {
      tickets: [
        {
          id: "01",
          title: "t",
          blockedBy: [],
          status: "ready",
          mergePending: false,
          enlisted: false,
          assignment: { harness: null, model: null, drivers: "implement" },
          liveAttempt: null,
        },
      ],
      conversations: [],
      log: [],
      outcomes: {},
      interrupts: [],
      queuedAnswers: [],
      config: {},
    },
  };
}

function snapshotFrame(snapshot: EnrichedSnapshot): string {
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
    const snapshots: EnrichedSnapshot[] = [];
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
    const snapshots: EnrichedSnapshot[] = [];
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
    const snapshots: EnrichedSnapshot[] = [];
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
    const snapshots: EnrichedSnapshot[] = [];
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
    const snapshots: EnrichedSnapshot[] = [];
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
    const fetched: EnrichedSnapshot[] = [];
    const rendered: EnrichedSnapshot[] = [];
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
    const rendered: EnrichedSnapshot[] = [];
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

describe("PoolClient Conversations routes (issue #60)", () => {
  /** A fetch stub that records every call and answers with one fixed JSON
   *  response, in the shape the real fetch Response exposes. */
  function jsonFetch(status: number, body: unknown) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it("starts a Conversation with POST /api/conversations, body and shape intact", async () => {
    const conversation: ConversationView = {
      id: "conv-2",
      title: "new one",
      status: "live",
      spawnedBy: null,
      assignment: { harness: "claude", model: null, drivers: "implement" },
      paneId: "pane-1",
      branch: null,
      turn: { state: "working", lastLine: "", idleSince: null },
      children: [],
      enlisted: false,
    };
    const { fetch, calls } = jsonFetch(201, { conversation });
    globalThis.fetch = fetch;
    const client = new PoolClient();
    const result = await client.startConversation({
      title: "new one",
      opening: "let's start",
      assign: { harness: "claude" },
    });
    expect(calls[0]!.url).toBe("/api/conversations");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      title: "new one",
      opening: "let's start",
      assign: { harness: "claude" },
    });
    expect(result).toEqual(conversation);
  });

  it("surfaces a 409's reason as the thrown Error's message", async () => {
    const { fetch } = jsonFetch(409, { reason: "pool is not terminal-backed" });
    globalThis.fetch = fetch;
    const client = new PoolClient();
    await expect(client.startConversation({ title: "x" })).rejects.toThrow(
      "pool is not terminal-backed",
    );
  });

  it("falls back to a generic message when a failed start carries no reason", async () => {
    const { fetch } = jsonFetch(400, {});
    globalThis.fetch = fetch;
    const client = new PoolClient();
    await expect(client.startConversation({ title: "x" })).rejects.toThrow(
      "start conversation failed: 400",
    );
  });

  it("ends a Conversation with POST /api/conversations/end, body and returned snapshot intact", async () => {
    const snapshot = snap(9);
    const { fetch, calls } = jsonFetch(202, { snapshot });
    globalThis.fetch = fetch;
    const client = new PoolClient();
    const result = await client.endConversation("conv-1", "wrapping up");
    expect(calls[0]!.url).toBe("/api/conversations/end");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      id: "conv-1",
      closing: "wrapping up",
    });
    expect(result).toEqual(snapshot);
  });

  it("throws on a failed end", async () => {
    const { fetch } = jsonFetch(404, {});
    globalThis.fetch = fetch;
    const client = new PoolClient();
    await expect(client.endConversation("conv-1")).rejects.toThrow(
      "end conversation failed: 404",
    );
  });
});

describe("PoolClient.stop (issue #97)", () => {
  /** The same fetch stub shape as the Conversations routes above, plus a
   *  json() that rejects, for a body that never arrives. */
  function jsonFetch(status: number, body: unknown, bodyFails = false) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () =>
          bodyFails ? Promise.reject(new Error("not json")) : Promise.resolve(body),
      } as unknown as Response);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it("POSTs /api/stop with no body and resolves on the 202", async () => {
    const { fetch, calls } = jsonFetch(202, { stopping: true });
    globalThis.fetch = fetch;
    const client = new PoolClient();
    await client.stop();
    expect(calls[0]!.url).toBe("/api/stop");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it("surfaces a 409's error as the thrown Error's message", async () => {
    const { fetch } = jsonFetch(409, {
      error: "pool is running, not done: stop refused",
    });
    globalThis.fetch = fetch;
    await expect(new PoolClient().stop()).rejects.toThrow(
      "pool is running, not done: stop refused",
    );
  });

  it("falls back to a generic message when a refusal carries no error body", async () => {
    const { fetch } = jsonFetch(500, null, true);
    globalThis.fetch = fetch;
    await expect(new PoolClient().stop()).rejects.toThrow("pool stop failed: 500");
  });

  it("propagates a network failure", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("fetch failed"))) as unknown as typeof globalThis.fetch;
    await expect(new PoolClient().stop()).rejects.toThrow("fetch failed");
  });
});
describe("PoolClient settings and restart (ADR-0026)", () => {
  const SETTINGS: SettingsResponse = {
    pool: {
      path: "/tmp/pool/console.json",
      config: { defaults: { harness: "claude" }, port: 4300 },
      bootOnly: ["roster", "agents", "selection", "terminal", "port"],
      effective: { port: 4300, terminal: null, stale: [] },
    },
    machine: {
      path: "/home/me/.agent-graphs/defaults.json",
      defaults: { harness: "claude", engine: "/repo/engine" },
      own: { harness: "claude" },
    },
    harnesses: ["claude", "opencode"],
  };

  function jsonFetch(status: number, body: unknown, bodyFails = false) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () =>
          bodyFails ? Promise.reject(new Error("not json")) : Promise.resolve(body),
      } as unknown as Response);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it("reads the settings payload verbatim", async () => {
    const { fetch, calls } = jsonFetch(200, SETTINGS);
    globalThis.fetch = fetch;
    const result = await new PoolClient().getSettings();
    expect(calls[0]!.url).toBe("/api/settings");
    expect(result).toEqual(SETTINGS);
  });

  it("PUTs a pool patch under `config` and answers with the re-read payload", async () => {
    const { fetch, calls } = jsonFetch(200, SETTINGS);
    globalThis.fetch = fetch;
    const result = await new PoolClient().savePoolSettings({ port: null });
    expect(calls[0]!.url).toBe("/api/settings/pool");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      config: { port: null },
    });
    expect(result).toEqual(SETTINGS);
  });

  it("PUTs machine defaults under `defaults`", async () => {
    const { fetch, calls } = jsonFetch(200, SETTINGS);
    globalThis.fetch = fetch;
    await new PoolClient().saveMachineDefaults({ harness: "opencode" });
    expect(calls[0]!.url).toBe("/api/settings/machine");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      defaults: { harness: "opencode" },
    });
  });

  it("surfaces a 400's error as the thrown Error's message", async () => {
    const { fetch } = jsonFetch(400, { error: "port 80 is privileged" });
    globalThis.fetch = fetch;
    await expect(new PoolClient().savePoolSettings({ port: 80 })).rejects.toThrow(
      "port 80 is privileged",
    );
  });

  it("falls back to a generic message when a refusal carries no error body", async () => {
    const { fetch } = jsonFetch(500, null, true);
    globalThis.fetch = fetch;
    await expect(new PoolClient().saveMachineDefaults({})).rejects.toThrow(
      "settings save failed: 500",
    );
  });

  it("POSTs /api/restart and answers with the port the relaunch will use", async () => {
    const { fetch, calls } = jsonFetch(202, { ok: true, port: 4311 });
    globalThis.fetch = fetch;
    const result = await new PoolClient().restart();
    expect(calls[0]!.url).toBe("/api/restart");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(result.port).toBe(4311);
  });

  it("surfaces a refused restart's reason", async () => {
    const { fetch } = jsonFetch(409, { error: "no boot script on this pool" });
    globalThis.fetch = fetch;
    await expect(new PoolClient().restart()).rejects.toThrow(
      "no boot script on this pool",
    );
  });

  it("falls back to a generic message for a refusal with no reason", async () => {
    const { fetch } = jsonFetch(500, null, true);
    globalThis.fetch = fetch;
    await expect(new PoolClient().restart()).rejects.toThrow(
      "pool restart failed: 500",
    );
  });
});
