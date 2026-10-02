/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  CLOSE_RESYNC,
  CLOSE_STOPPED,
  diffSnapshot,
  encodeMessage,
  HEARTBEAT_MS,
  PROTOCOL_VERSION,
  toPushed,
  type ClientMessage,
  type PushedSnapshot,
  type ServerMessage,
  type SnapshotDelta,
  type SocketLike,
} from "../../engine/protocol.ts";
import type { EnrichedSnapshot, EnrichedTicketState } from "./project";
import {
  CONNECTION_LOST,
  ConsoleSocket,
  NOT_CONNECTED,
  reloadForVersion,
  RequestRefused,
  VERSION_RELOAD_GUARD_MS,
  VERSION_RELOAD_KEY,
  windowNameStore,
  type CardMessage,
  type ConnectionChange,
  type LiveMessage,
} from "./socket";

function ticket(id: string, overrides: Partial<EnrichedTicketState> = {}): EnrichedTicketState {
  return {
    id,
    title: `ticket ${id}`,
    blockedBy: [],
    status: "ready",
    mergeState: null,
    enlisted: false,
    assignment: { harness: null, model: null, drivers: "implement" },
    liveAttempt: null,
    heldPane: null,
    reassign: {
      eligible: true,
      reason: null,
      verify: null,
      sources: { harness: "default", model: "default", effort: "unset", drivers: "default" },
    },
    ...overrides,
  } as EnrichedTicketState;
}

function snapshot(tickets: EnrichedTicketState[], log: string[] = []): EnrichedSnapshot {
  return {
    seq: 0,
    phase: "running",
    poolName: "repo/pool",
    poolTitle: null,
    poolDir: "/tmp/pool",
    finishedTerminals: 0,
    spawnUsage: { spawnedThisRun: 0, perAttempt: 5, perRun: 20 },
    pendingSpawns: [],
    heldSpawns: [],
    state: {
      tickets,
      conversations: [],
      log,
      outcomes: {},
      interrupts: [],
      mergeQueue: [],
      queuedAnswers: [],
      config: {},
    },
  };
}

/**
 * A socket the test plays the server's side of: what the Console sends is
 * read back decoded, and the test opens it, pushes frames into it and
 * closes it when it chooses.
 */
class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  push(message: ServerMessage): void {
    this.onmessage?.({ data: encodeMessage(message) });
  }

  /** The server's hello, then its snapshot: what every open starts with. */
  greet(pushed: PushedSnapshot | null, epoch = "e1", heartbeatMs = HEARTBEAT_MS): void {
    this.open();
    this.push({ type: "hello", protocol: PROTOCOL_VERSION, epoch, heartbeatMs });
    this.push(
      pushed
        ? { type: "snapshot", rev: pushed.rev, logTotal: pushed.logTotal, snapshot: pushed.snapshot }
        : { type: "snapshot", rev: 0, logTotal: 0, snapshot: null },
    );
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  requests(): Extract<ClientMessage, { type: "request" }>[] {
    return this.sent.filter(
      (m): m is Extract<ClientMessage, { type: "request" }> => m.type === "request",
    );
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A socket over fakes, with every callback recorded. */
function rig(options: { reconnectDelaysMs?: number[]; visible?: boolean; stableMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const snapshots: { pushed: PushedSnapshot | null; delta: SnapshotDelta | null }[] = [];
  const connections: ConnectionChange[] = [];
  const lives: LiveMessage[] = [];
  const cards: CardMessage[] = [];
  let mismatches = 0;
  const socket = new ConsoleSocket({
    open: () => {
      const fake = new FakeSocket();
      sockets.push(fake);
      return fake;
    },
    onSnapshot: (pushed, delta) => snapshots.push({ pushed, delta }),
    onLive: (live) => lives.push(live),
    onCard: (card) => cards.push(card),
    onConnection: (change) => connections.push(change),
    onVersionMismatch: () => {
      mismatches += 1;
    },
    reconnectDelaysMs: options.reconnectDelaysMs ?? [1],
    visible: options.visible,
    stableMs: options.stableMs ?? 1,
  });
  return {
    socket,
    sockets,
    snapshots,
    connections,
    lives,
    cards,
    mismatches: () => mismatches,
    last: () => sockets[sockets.length - 1]!,
  };
}

describe("ConsoleSocket: the snapshot", () => {
  it("says hello with the protocol, the visibility and the subscriptions on open", () => {
    const r = rig({ visible: false });
    r.socket.subscribe({ id: "07" });
    r.socket.start();
    expect(r.last().sent).toHaveLength(0);
    r.last().open();
    expect(r.last().sent).toEqual([
      { type: "hello", protocol: PROTOCOL_VERSION, visible: false, cards: [{ id: "07" }] },
    ]);
    r.socket.dispose();
  });

  it("takes the first snapshot whole and reports the connection up", () => {
    const r = rig();
    r.socket.start();
    const first = toPushed(snapshot([ticket("A")]), 3);
    r.last().greet(first);
    expect(r.snapshots).toHaveLength(1);
    expect(r.snapshots[0]!.pushed?.rev).toBe(3);
    expect(r.snapshots[0]!.delta).toBeNull();
    expect(r.connections).toEqual([{ up: true }]);
    r.socket.dispose();
  });

  it("reports a pool that has not started as a null snapshot", () => {
    const r = rig();
    r.socket.start();
    r.last().greet(null);
    expect(r.snapshots).toEqual([{ pushed: null, delta: null }]);
    r.socket.dispose();
  });

  it("applies deltas, carrying every unchanged ticket over by reference", () => {
    const r = rig();
    r.socket.start();
    const first = toPushed(snapshot([ticket("A"), ticket("B")]), 1);
    r.last().greet(first);
    const held = r.socket.snapshot!;
    const next = toPushed(snapshot([ticket("A"), ticket("B", { status: "in-progress" })]), 2);
    const delta = diffSnapshot(first, next)!;
    r.last().push({ type: "delta", delta });
    const applied = r.socket.snapshot!;
    expect(applied.rev).toBe(2);
    expect(applied.snapshot.state.tickets[0]).toBe(held.snapshot.state.tickets[0]!);
    expect(applied.snapshot.state.tickets[1]!.status).toBe("in-progress");
    expect(r.snapshots[1]).toEqual({ pushed: applied, delta });
    r.socket.dispose();
  });

  it("resyncs on a delta that does not fit: closes 4001 and takes a fresh snapshot", async () => {
    const r = rig();
    r.socket.start();
    const first = toPushed(snapshot([ticket("A")]), 1);
    r.last().greet(first);
    const stale = diffSnapshot(
      toPushed(snapshot([ticket("A")]), 7),
      toPushed(snapshot([ticket("A", { status: "done" })]), 8),
    )!;
    const old = r.last();
    old.push({ type: "delta", delta: stale });
    expect(old.closedWith).toEqual({ code: CLOSE_RESYNC.code, reason: CLOSE_RESYNC.reason });
    // The reopen waits out the reconnect delay, as a close's does.
    expect(r.sockets).toHaveLength(1);
    await wait(5);
    expect(r.sockets).toHaveLength(2);
    expect(r.socket.snapshot?.rev).toBe(1);
    r.last().greet(toPushed(snapshot([ticket("A", { status: "done" })]), 8));
    expect(r.socket.snapshot?.rev).toBe(8);
    expect(r.snapshots.at(-1)!.pushed?.snapshot.state.tickets[0]!.status).toBe("done");
    r.socket.dispose();
  });

  it("keeps the embedded snapshot when the socket's first is the same epoch and revision", () => {
    const r = rig();
    const boot = snapshot([ticket("A")]);
    r.socket.adopt({ protocol: PROTOCOL_VERSION, epoch: "e1", rev: 4, logTotal: 0, snapshot: boot });
    r.socket.start();
    r.last().greet(toPushed(JSON.parse(JSON.stringify(boot)) as EnrichedSnapshot, 4), "e1");
    expect(r.snapshots).toHaveLength(0);
    expect(r.socket.snapshot!.snapshot).toBe(boot);
    expect(r.connections).toEqual([{ up: true }]);
    r.socket.dispose();
  });

  it("takes the socket's snapshot when the epoch or the revision differs", () => {
    const other = rig();
    const boot = snapshot([ticket("A")]);
    other.socket.adopt({ protocol: PROTOCOL_VERSION, epoch: "e1", rev: 4, logTotal: 0, snapshot: boot });
    other.socket.start();
    other.last().greet(toPushed(boot, 4), "e2");
    expect(other.snapshots).toHaveLength(1);
    other.socket.dispose();

    const later = rig();
    later.socket.adopt({ protocol: PROTOCOL_VERSION, epoch: "e1", rev: 4, logTotal: 0, snapshot: boot });
    later.socket.start();
    later.last().greet(toPushed(boot, 5), "e1");
    expect(later.snapshots).toHaveLength(1);
    later.socket.dispose();
  });

  it("skips the repeat on a reconnect to the same server at the same revision", async () => {
    const r = rig();
    r.socket.start();
    const first = toPushed(snapshot([ticket("A")]), 2);
    r.last().greet(first, "e1");
    r.last().serverClose(1006);
    await wait(5);
    r.last().greet(toPushed(snapshot([ticket("A")]), 2), "e1");
    expect(r.snapshots).toHaveLength(1);
    r.socket.dispose();
  });

  it("routes live and card frames, and drops a frame that does not decode", () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1));
    r.last().onmessage?.({ data: "not json" });
    r.last().onmessage?.({ data: JSON.stringify({ type: "nonsense" }) });
    r.last().push({ type: "live", grades: {} });
    r.last().push({ type: "card", id: "07", error: "unknown ticket 07" });
    expect(r.lives).toEqual([{ type: "live", grades: {} }]);
    expect(r.cards).toEqual([{ type: "card", id: "07", error: "unknown ticket 07" }]);
    r.socket.dispose();
  });
});

describe("ConsoleSocket: requests", () => {
  it("answers each request by its id, in whatever order the replies come", async () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1));
    const focus = r.socket.request("terminal.focus", { ticketId: "07" });
    const stop = r.socket.request("stop", {});
    const [first, second] = r.last().requests();
    expect(first).toEqual({
      type: "request",
      id: 1,
      kind: "terminal.focus",
      payload: { ticketId: "07" },
    });
    expect(second!.id).toBe(2);
    r.last().push({
      type: "reply",
      id: 2,
      kind: "stop",
      rev: 1,
      ok: false,
      refusal: { reason: "pool is running, not done: stop refused", status: 409 },
    });
    r.last().push({
      type: "reply",
      id: 1,
      kind: "terminal.focus",
      rev: 1,
      ok: true,
      result: { ok: true, paneId: "p3" },
    });
    expect(await focus).toEqual({ ok: true, paneId: "p3" });
    const refused = await stop.catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(RequestRefused);
    expect((refused as RequestRefused).message).toBe("pool is running, not done: stop refused");
    expect((refused as RequestRefused).status).toBe(409);
    r.socket.dispose();
  });

  it("sends a request asked for while connecting right behind our hello", () => {
    const r = rig();
    r.socket.start();
    void r.socket.request("panes.list", {}).catch(() => {});
    expect(r.last().sent).toHaveLength(0);
    r.last().open();
    expect(r.last().sent.map((m) => m.type)).toEqual(["hello", "request"]);
    r.socket.dispose();
  });

  it("sends frames asked for between the open and the server's hello, never dropping them (#161)", () => {
    const r = rig();
    r.socket.start();
    r.last().open();
    r.socket.subscribe({ id: "07" });
    r.socket.unsubscribe("07");
    r.socket.setVisible(false);
    void r.socket.request("stop", {}).catch(() => {});
    expect(r.last().sent.map((m) => m.type)).toEqual([
      "hello",
      "subscribe",
      "unsubscribe",
      "visibility",
      "request",
    ]);
    r.socket.dispose();
  });

  it("refuses a request at once while there is no socket to send it on", async () => {
    const r = rig({ reconnectDelaysMs: [60_000] });
    const unstarted = await r.socket.request("stop", {}).catch((err: unknown) => err);
    expect((unstarted as RequestRefused).message).toBe(NOT_CONNECTED.reason);
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1));
    r.last().serverClose(1006);
    const between = await r.socket.request("stop", {}).catch((err: unknown) => err);
    expect((between as RequestRefused).status).toBe(0);
    r.socket.dispose();
  });

  it("refuses every request still out when the socket closes, and never resends one", async () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1));
    const resume = r.socket.request("resume", { ticketId: "07", action: "resume" });
    r.last().serverClose(1006, "gone");
    const err = (await resume.catch((e: unknown) => e)) as RequestRefused;
    expect(err).toBeInstanceOf(RequestRefused);
    expect(err.message).toBe(CONNECTION_LOST.reason);
    expect(err.status).toBe(0);
    await wait(5);
    r.last().greet(toPushed(snapshot([]), 2));
    expect(r.last().requests()).toHaveLength(0);
    r.socket.dispose();
  });

  it("counts request ids from 1 again on every socket", async () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1));
    void r.socket.request("panes.list", {}).catch(() => {});
    void r.socket.request("panes.list", {}).catch(() => {});
    r.last().serverClose(1006);
    await wait(5);
    r.last().greet(toPushed(snapshot([]), 1));
    void r.socket.request("panes.list", {}).catch(() => {});
    expect(r.last().requests()[0]!.id).toBe(1);
    r.socket.dispose();
  });

  it("points a subscription's log with log.follow and keeps the follow for the next hello", () => {
    const r = rig();
    r.socket.subscribe({ id: "07" });
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1));
    void r.socket.follow("07", { attempt: 2, stream: true }).catch(() => {});
    expect(r.last().requests()[0]).toEqual({
      type: "request",
      id: 1,
      kind: "log.follow",
      payload: { id: "07", attempt: 2, stream: true },
    });
    r.socket.dispose();
  });
});

describe("ConsoleSocket: subscriptions and visibility", () => {
  it("re-sends every subscription, follow included, in the hello of each reopen", async () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1));
    r.socket.subscribe({ id: "07" });
    r.socket.subscribe({ id: "03" });
    void r.socket.follow("03", { attempt: 1, stream: true }).catch(() => {});
    r.socket.unsubscribe("07");
    expect(r.last().sent.filter((m) => m.type !== "request")).toEqual([
      { type: "hello", protocol: PROTOCOL_VERSION, visible: true, cards: [] },
      { type: "subscribe", card: { id: "07" } },
      { type: "subscribe", card: { id: "03" } },
      { type: "unsubscribe", id: "07" },
    ]);
    r.last().serverClose(1006);
    await wait(5);
    r.last().open();
    expect(r.last().sent).toEqual([
      {
        type: "hello",
        protocol: PROTOCOL_VERSION,
        visible: true,
        cards: [{ id: "03", follow: { attempt: 1, stream: true } }],
      },
    ]);
    r.socket.dispose();
  });

  it("sends nothing to unsubscribe a card it never subscribed", () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1));
    r.socket.unsubscribe("nope");
    expect(r.last().sent.map((m) => m.type)).toEqual(["hello"]);
    r.socket.dispose();
  });

  it("tells the server when the page is hidden or shown, once per change", () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1));
    r.socket.setVisible(false);
    r.socket.setVisible(false);
    r.socket.setVisible(true);
    expect(r.last().sent.filter((m) => m.type === "visibility")).toEqual([
      { type: "visibility", visible: false },
      { type: "visibility", visible: true },
    ]);
    r.socket.dispose();
  });
});

describe("ConsoleSocket: liveness and reconnect", () => {
  it("drops a socket silent for three heartbeats and opens a fresh one", async () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1), "e1", 5);
    const out = r.socket.request("panes.list", {}).catch((e: unknown) => e);
    const silent = r.last();
    await wait(40);
    expect(silent.closedWith).not.toBeNull();
    expect(r.sockets.length).toBeGreaterThanOrEqual(2);
    expect(((await out) as RequestRefused).status).toBe(0);
    // Silence is a reopen, not an outage: no banner-raising close is reported.
    expect(r.connections).toEqual([{ up: true }]);
    r.socket.dispose();
  });

  it("any frame, a heartbeat included, holds the silence off", async () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1), "e1", 20);
    for (let i = 0; i < 4; i++) {
      await wait(25);
      r.last().push({ type: "heartbeat" });
    }
    expect(r.sockets).toHaveLength(1);
    r.socket.dispose();
  });

  it("reconnects after a close on the delays, starting over once a socket stays up", async () => {
    const r = rig({ reconnectDelaysMs: [5, 60_000] });
    r.socket.start();
    r.last().serverClose(1006);
    await wait(15);
    expect(r.sockets).toHaveLength(2);
    // That one never said hello: the next delay is the long one.
    r.last().serverClose(1006);
    await wait(15);
    expect(r.sockets).toHaveLength(2);
    r.socket.dispose();

    // A hello alone does not start the delays over: the socket must stay up.
    const brief = rig({ reconnectDelaysMs: [5, 60_000], stableMs: 1_000 });
    brief.socket.start();
    brief.last().serverClose(1006);
    await wait(15);
    brief.last().greet(toPushed(snapshot([]), 1));
    brief.last().serverClose(1006);
    await wait(15);
    expect(brief.sockets).toHaveLength(2);
    brief.socket.dispose();

    const steady = rig({ reconnectDelaysMs: [5, 60_000], stableMs: 5 });
    steady.socket.start();
    steady.last().serverClose(1006);
    await wait(15);
    steady.last().greet(toPushed(snapshot([]), 1));
    await wait(15);
    steady.last().serverClose(1006);
    await wait(15);
    expect(steady.sockets).toHaveLength(3);
    steady.socket.dispose();
  });

  it("backs off resyncs too: five deltas that do not fit open nothing like six sockets (#161)", async () => {
    const r = rig({ reconnectDelaysMs: [5, 60_000], stableMs: 1_000 });
    r.socket.start();
    const stale = diffSnapshot(
      toPushed(snapshot([ticket("A")]), 7),
      toPushed(snapshot([ticket("A", { status: "done" })]), 8),
    )!;
    for (let i = 0; i < 5; i++) {
      r.last().greet(toPushed(snapshot([ticket("A")]), 1));
      r.last().push({ type: "delta", delta: stale });
      await wait(10);
    }
    expect(r.sockets).toHaveLength(2);
    r.socket.dispose();
  });

  it("replaces a socket gone quiet when the page is shown again, and keeps a lively one (#161)", async () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1), "e1", 20);
    const quiet = r.last();
    r.socket.setVisible(false);
    await wait(35);
    // More than 1.5 heartbeats silent, short of the 3 the watchdog waits for.
    expect(r.sockets).toHaveLength(1);
    r.socket.setVisible(true);
    expect(quiet.closedWith).not.toBeNull();
    expect(r.sockets).toHaveLength(2);
    r.last().greet(toPushed(snapshot([]), 1), "e1", 20);
    r.socket.setVisible(false);
    r.socket.setVisible(true);
    expect(r.sockets).toHaveLength(2);
    r.socket.dispose();
  });

  it("reopens at once on a wake while it waits out a reconnect delay (#161)", () => {
    const r = rig({ reconnectDelaysMs: [60_000] });
    r.socket.start();
    r.last().serverClose(1006);
    expect(r.sockets).toHaveLength(1);
    r.socket.wake();
    expect(r.sockets).toHaveLength(2);
    r.socket.dispose();
  });

  it("reports the stopped farewell close as stopped, and keeps retrying for a relaunch", async () => {
    const r = rig();
    r.socket.start();
    r.last().greet(toPushed(snapshot([]), 1));
    r.last().serverClose(CLOSE_STOPPED.code, CLOSE_STOPPED.reason);
    expect(r.connections.at(-1)).toEqual({ up: false, reason: "stopped", stopped: true });
    r.last().serverClose(1006);
    await wait(5);
    expect(r.sockets.length).toBeGreaterThanOrEqual(2);
    r.socket.dispose();
  });

  it("reports an ordinary close as a fault", () => {
    const r = rig();
    r.socket.start();
    r.last().serverClose(1006);
    expect(r.connections).toEqual([
      { up: false, reason: "pool socket closed (1006)", stopped: false },
    ]);
    r.socket.dispose();
  });

  it("stops for good on a server of another protocol version", async () => {
    const r = rig();
    r.socket.start();
    r.last().open();
    r.last().push({ type: "hello", protocol: PROTOCOL_VERSION + 1, epoch: "e9", heartbeatMs: 20 });
    expect(r.mismatches()).toBe(1);
    expect(r.last().closedWith).not.toBeNull();
    await wait(10);
    expect(r.sockets).toHaveLength(1);
    expect(r.connections).toHaveLength(0);
  });

  it("opens nothing more once disposed", async () => {
    const r = rig();
    r.socket.start();
    r.socket.dispose();
    r.last().serverClose(1006);
    await wait(5);
    expect(r.sockets).toHaveLength(1);
  });
});

describe("reloadForVersion", () => {
  function store(): { items: Map<string, string>; getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (k) => items.get(k) ?? null,
      setItem: (k, v) => {
        items.set(k, v);
      },
    };
  }

  it("reloads and stamps the time", () => {
    const s = store();
    let reloads = 0;
    expect(reloadForVersion(s, 1_000, () => reloads++)).toBe(true);
    expect(reloads).toBe(1);
    expect(s.items.get(VERSION_RELOAD_KEY)).toBe("1000");
  });

  it("does not reload again inside the guard window, so the caller shows the banner", () => {
    const s = store();
    let reloads = 0;
    reloadForVersion(s, 1_000, () => reloads++);
    expect(reloadForVersion(s, 1_000 + VERSION_RELOAD_GUARD_MS - 1, () => reloads++)).toBe(false);
    expect(reloads).toBe(1);
    expect(reloadForVersion(s, 1_000 + VERSION_RELOAD_GUARD_MS, () => reloads++)).toBe(true);
    expect(reloads).toBe(2);
  });

  it("guards with the window's name where storage is missing or throws (#161)", () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    for (const storage of [null, throwing]) {
      const win = { name: "" };
      let reloads = 0;
      expect(reloadForVersion(storage, 1_000, () => reloads++, windowNameStore(win))).toBe(true);
      expect(win.name).toBe(`${VERSION_RELOAD_KEY}=1000`);
      // The reloaded page finds the stamp in the name and does not loop.
      expect(reloadForVersion(storage, 2_000, () => reloads++, windowNameStore(win))).toBe(false);
      expect(reloads).toBe(1);
    }
  });

  it("does not reload when it can stamp nowhere, since nothing would stop a loop", () => {
    let reloads = 0;
    expect(reloadForVersion(null, 1, () => reloads++)).toBe(false);
    expect(reloads).toBe(0);
  });
});
