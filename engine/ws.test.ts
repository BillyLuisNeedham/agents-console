/// <reference types="bun" />

/**
 * The Console's socket (issue #161, ADR-0032): what the server pushes down
 * /api/ws and when. The opening frames, one delta per coalesced change for
 * every socket alike, a reply behind the delta that carries its effect,
 * refusals in the HTTP twin's status, a reply or push that cannot go
 * leaving the server up, the cards and their log, the live
 * check's rule for hidden tabs, the stop's farewell, the page's embedded
 * boot, the pool log's earlier lines, and every request kind answered
 * exactly as its HTTP twin answers.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoolServer, type PoolServer, type PoolServerOptions } from "./server.ts";
import { REVIEW_TICKET_ID, type HarnessCommand, type PoolConfig } from "./engine.ts";
import { appendEvent } from "./events.ts";
import {
  CLOSE_STOPPED,
  EMBED_ELEMENT_ID,
  HEARTBEAT_MS,
  PROTOCOL_VERSION,
  applyDelta,
  readEmbeddedBoot,
  type LogPush,
  type PushedSnapshot,
  type RequestKind,
  type RequestPayload,
  type ServerMessage,
} from "./protocol.ts";
import type { EnrichedSnapshot, TicketLogResponse } from "./wire.ts";
import {
  answered,
  createPushHub,
  refused,
  type PushHub,
  type PushHubOptions,
  type PushSources,
  type SocketState,
} from "./ws.ts";
import {
  STUB_DEFAULTS,
  cleanupPools,
  makePool,
  registerTempDir,
  stubHarness,
} from "./pool-fixture.ts";
import { startExecutingFakeHerdr, type ExecutingFakeHerdr } from "./herdr-executing-fake.ts";
import { framesOf, openSocket, type SocketClient } from "./socket-fixture.ts";
import { makeTempDir } from "./tmp.ts";

const servers: PoolServer[] = [];
const sockets: SocketClient[] = [];
const fakes: ExecutingFakeHerdr[] = [];
const hubs: { hub: PushHub; serving: Bun.Server<SocketState> }[] = [];

afterEach(async () => {
  while (sockets.length > 0) sockets.pop()!.close();
  await cleanupPools(servers);
  while (fakes.length > 0) await fakes.pop()!.close();
  while (hubs.length > 0) {
    const { hub, serving } = hubs.pop()!;
    hub.close();
    // Bounded, as server.ts's stopServing is: Bun may never settle it.
    await Promise.race([serving.stop(true), Bun.sleep(100)]);
  }
});

const ready = (id: string, blockedBy = "none"): string =>
  `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`;

function startServer(
  poolDir: string,
  harnesses: Record<string, HarnessCommand>,
  options: Partial<PoolServerOptions> = {},
): PoolServer {
  const server = createPoolServer({
    poolDir,
    port: 0,
    harnesses,
    distDir: "/nonexistent",
    registryPath: join(poolDir, "fleet.json"),
    ...options,
  });
  servers.push(server);
  return server;
}

async function socket(
  server: PoolServer,
  hello?: Parameters<typeof openSocket>[1],
): Promise<SocketClient> {
  const client = await openSocket(server.url, hello);
  sockets.push(client);
  return client;
}

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A pool driven through its review gate: phase `done`, every ticket run. */
async function finishedPool(
  tickets: string[] = ["01"],
  options: Partial<PoolServerOptions> = {},
  config: Partial<PoolConfig> = {},
): Promise<{ poolDir: string; server: PoolServer }> {
  const poolDir = makePool({
    tickets: tickets.map((id) => ({ file: `${id}-a.md`, marker: ready(id) })),
    config: { ...STUB_DEFAULTS, ...config },
  });
  const server = startServer(poolDir, stubHarness(poolDir, {}).harnesses, options);
  await server.start();
  await server.settled();
  await server.answer(REVIEW_TICKET_ID, "approve");
  await server.settled();
  await waitFor(() => server.latest?.phase === "done", "the pool to finish");
  return { poolDir, server };
}

/**
 * A push hub alone behind a bare server, reading the pool through `sources`
 * instead of a pool server's own reads: the seam a test takes to hand the
 * hub what no pool server makes on purpose, a result that cannot be
 * serialised or a snapshot read that throws. Unlisted sources read an empty
 * pool, and every request is answered `{}`.
 */
function serveHub(
  sources: Partial<PushSources>,
  options: Partial<PushHubOptions> = {},
): { hub: PushHub; url: string } {
  const hub = createPushHub(
    {
      current: () => null,
      runsDir: "/nonexistent",
      issuesDir: "/nonexistent",
      bodyFile: () => null,
      body: () => null,
      events: () => ({ events: [], attempts: [], reconstructed: false, spec: "" }),
      attempts: () => [],
      readLog: () => ({ content: "", offset: 0, nextOffset: 0, totalSize: 0 }),
      log: () => refused(404, "error", "no log here"),
      activity: () => Promise.reject(new Error("no activity here")),
      peek: async () => refused(404, "error", "no pane here"),
      grades: () => ({}),
      request: async () => answered({}),
      ...sources,
    },
    { heartbeatMs: HEARTBEAT_MS, coalesceMs: 0, checkMs: 50, ...options },
  );
  const serving = Bun.serve<SocketState>({
    port: 0,
    websocket: hub.websocket,
    fetch(req, bunServer) {
      if (bunServer.upgrade(req, { data: hub.socketState() })) return undefined;
      return new Response("expected a WebSocket upgrade", { status: 400 });
    },
  });
  hubs.push({ hub, serving });
  return { hub, url: `http://localhost:${serving.port}` };
}

/** The smallest snapshot the push takes: a running pool with nothing in it. */
const EMPTY_POOL = {
  seq: 1,
  phase: "running",
  poolName: "pools/hub",
  poolTitle: null,
  poolDir: "/nonexistent",
  state: { tickets: [], conversations: [], log: [], outcomes: {}, interrupts: [] },
} as unknown as EnrichedSnapshot;

/**
 * What `body` logged with console.error, and every rejection that went
 * unhandled while it ran: in the server's process Bun exits on the first of
 * those, so a test that finds none shows the server would have stayed up.
 */
async function escapesDuring(
  body: () => Promise<void>,
): Promise<{ logged: string[]; rejections: unknown[] }> {
  const logged: string[] = [];
  const rejections: unknown[] = [];
  const quiet = console.error;
  const record = (reason: unknown): void => void rejections.push(reason);
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  process.on("unhandledRejection", record);
  try {
    await body();
    // A rejection is reported once the microtasks behind it have run.
    await Bun.sleep(20);
  } finally {
    process.off("unhandledRejection", record);
    console.error = quiet;
  }
  return { logged, rejections };
}

/** The snapshot as a socket held it just before frame `index` arrived. */
function heldBefore(frames: ServerMessage[], index: number): PushedSnapshot | null {
  let held: PushedSnapshot | null = null;
  for (const frame of frames.slice(0, index)) {
    if (frame.type === "snapshot") {
      held =
        frame.snapshot === null
          ? null
          : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
    } else if (frame.type === "delta") {
      held = applyDelta(held!, frame.delta);
    }
  }
  return held;
}

const isCard =
  (id: string, has: (frame: Extract<ServerMessage, { type: "card" }>) => boolean = () => true) =>
  (frame: ServerMessage): boolean =>
    frame.type === "card" && frame.id === id && has(frame);

describe("opening a socket", () => {
  it("says hello, then sends the snapshot, without waiting for the client", async () => {
    const poolDir = makePool({ tickets: [{ file: "01-a.md", marker: ready("01") }], config: STUB_DEFAULTS });
    const server = startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const early = await socket(server);
    await early.waitFor(() => early.frames.length >= 2, { what: "the opening frames" });
    const [hello, snapshot] = early.frames;
    expect(hello).toMatchObject({ type: "hello", protocol: PROTOCOL_VERSION, heartbeatMs: HEARTBEAT_MS });
    expect(typeof (hello as { epoch: string }).epoch).toBe("string");
    // Before the pool starts there is nothing to show yet: revision 0.
    expect(snapshot).toEqual({ type: "snapshot", rev: 0, logTotal: 0, snapshot: null });

    await server.start();
    const settled = await server.settled();
    await waitFor(() => early.pushed?.snapshot.seq === settled.seq, "the socket to catch up");
    // The first version after the start goes whole, the rest as deltas.
    const opened = framesOf(early, "snapshot");
    expect(opened.map((frame) => frame.rev)).toEqual([0, 1]);
    expect(early.pushed?.snapshot.phase).toBe(settled.phase);

    // A socket opened now starts where the first one is.
    const late = await socket(server);
    await late.waitFor((frame) => frame.type === "snapshot");
    expect(late.frames[0]).toEqual(hello);
    expect(late.rev).toBe(early.rev);
    expect(late.pushed).toEqual(early.pushed);
  });

  it("refuses a plain request at the socket's path", async () => {
    const poolDir = makePool({ tickets: [{ file: "01-a.md", marker: ready("01") }], config: STUB_DEFAULTS });
    const server = startServer(poolDir, stubHarness(poolDir, {}).harnesses);
    const res = await fetch(`${server.url}/api/ws`);
    expect(res.status).toBe(400);
  });

  // A page on any other site the operator has open could otherwise open the
  // socket and drive the pool: browsers hold a socket to no same-origin rule.
  it("refuses a socket opened from another site's page, and opens one from its own page or none", async () => {
    const poolDir = makePool({ tickets: [{ file: "01-a.md", marker: ready("01") }], config: STUB_DEFAULTS });
    const server = startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    for (const origin of ["http://evil.example", "null", `http://localhost:1${new URL(server.url).port}`]) {
      const res = await fetch(`${server.url}/api/ws`, { headers: { origin } });
      expect([origin, res.status]).toEqual([origin, 403]);
    }
    await expect(
      openSocket(server.url, undefined, { Origin: "http://evil.example" }),
    ).rejects.toThrow(/failed to open/);

    // The Console's own page, and a client that names no page at all.
    for (const headers of [{ Origin: server.url }, undefined]) {
      const client = await openSocket(server.url, undefined, headers);
      sockets.push(client);
      const hello = await client.waitFor((frame) => frame.type === "hello");
      expect(hello.type).toBe("hello");
      expect(await client.request("settings.get", {})).toMatchObject({ ok: true });
    }
  });
});

describe("the snapshot push", () => {
  it("sends every socket the same delta per coalesced change, each on from the last", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: ready("01") },
        { file: "02-b.md", marker: ready("02", "01") },
      ],
      config: STUB_DEFAULTS,
    });
    const server = startServer(poolDir, stubHarness(poolDir, {}).harnesses);
    const a = await socket(server);
    const b = await socket(server);
    await a.sync();
    await b.sync();

    // The run to its review gate, then past it: the first burst goes out
    // whole, and what follows as deltas.
    await server.start();
    await server.settled();
    await waitFor(() => a.pushed?.snapshot.phase === "quiescent", "the review gate on the socket");
    await server.answer(REVIEW_TICKET_ID, "approve");
    const settled = await server.settled();
    for (const client of [a, b]) {
      await waitFor(() => client.pushed?.snapshot.seq === settled.seq, "both sockets to catch up");
    }
    // One global version: the same frames, serialised once, to both.
    const pushes = (client: SocketClient) =>
      client.frames.filter((frame) => frame.type === "snapshot" || frame.type === "delta");
    expect(JSON.stringify(pushes(a))).toBe(JSON.stringify(pushes(b)));
    // Each delta builds on the revision before it, one at a time.
    const deltas = framesOf(a, "delta").map((frame) => frame.delta);
    expect(deltas.length).toBeGreaterThan(0);
    deltas.forEach((delta, i) => {
      expect(delta.base).toBe(i + 1);
      expect(delta.rev).toBe(i + 2);
    });
    // A burst of emits is one delta: fewer of them than the engine emitted.
    expect(deltas.length + 1).toBeLessThan(settled.seq + 1);
    // What the deltas build is what the server holds.
    expect(a.pushed?.snapshot.state.tickets).toEqual(settled.state.tickets);
  });

  it("sends a hidden socket its deltas and heartbeats too", async () => {
    const poolDir = makePool({ tickets: [{ file: "01-a.md", marker: ready("01") }], config: STUB_DEFAULTS });
    const server = startServer(poolDir, stubHarness(poolDir, {}).harnesses, {
      streamHeartbeatMs: 40,
    });
    const hidden = await socket(server, { visible: false });
    await hidden.sync();
    await server.start();
    const settled = await server.settled();
    await waitFor(() => hidden.pushed?.snapshot.seq === settled.seq, "the hidden socket to catch up");
    await hidden.waitFor((frame) => frame.type === "heartbeat", { what: "a heartbeat" });
  });
});

describe("requests", () => {
  it("replies to an action after the delta that carries its effect", async () => {
    const poolDir = makePool({ tickets: [{ file: "01-a.md", marker: ready("01") }], config: STUB_DEFAULTS });
    // A window long enough that only the reply's own flush can send the
    // answer's delta in time.
    const server = startServer(
      poolDir,
      stubHarness(poolDir, { "01": { statuses: ["checkpoint", "done"] } }).harnesses,
      { snapshotCoalesceMs: 60_000 },
    );
    await server.start();
    await server.settled();
    // Opening flushes what waits, so the socket starts at the checkpoint.
    const client = await socket(server);
    await client.sync();
    expect(client.pushed?.snapshot.state.interrupts.some((i) => i.ticketId === "01")).toBe(true);

    const before = client.rev;
    const reply = await client.request("resume", { ticketId: "01", action: "resume" });
    expect(reply).toMatchObject({ kind: "resume", ok: true, result: {} });
    const at = client.frames.indexOf(reply);
    const held = heldBefore(client.frames, at);
    // The delta is on the socket ahead of the reply, and the reply names the
    // revision it made: the answer is already in the tab's hands.
    expect(reply.rev).toBeGreaterThan(before);
    expect(held?.rev).toBe(reply.rev);
    expect(held?.snapshot.state.interrupts.some((i) => i.ticketId === "01")).toBe(false);
    await server.settled();
  });

  // The writes that change the snapshot without the engine emitting (a
  // Settings save renaming the pool, a Reassign) put their delta ahead of
  // the reply too, through the reply's own flush.
  it("replies to a settings save and a Reassign after their deltas, with none behind", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: ready("01") },
        { file: "02-a.md", marker: ready("02", "01") },
      ],
      config: STUB_DEFAULTS,
    });
    const server = startServer(
      poolDir,
      stubHarness(poolDir, { "01": { statuses: ["checkpoint", "done"] } }).harnesses,
      { snapshotCoalesceMs: 60_000 },
    );
    await server.start();
    await server.settled();
    const client = await socket(server);
    await client.sync();

    const ask = async <K extends RequestKind>(kind: K, payload: RequestPayload<K>) => {
      const from = client.frames.length;
      const reply = await client.request(kind, payload);
      expect([kind, reply.ok]).toEqual([kind, true]);
      const at = client.frames.indexOf(reply);
      const ahead = client.frames.slice(from, at).filter((frame) => frame.type === "delta");
      await Bun.sleep(150);
      const behind = client.frames.slice(at + 1).filter((frame) => frame.type === "delta");
      return { reply, ahead, behind, held: heldBefore(client.frames, at) };
    };

    const renamed = await ask("settings.pool.put", { config: { title: "Renamed" } });
    expect(renamed.ahead).toHaveLength(1);
    expect(renamed.behind).toEqual([]);
    expect(renamed.held?.snapshot.poolTitle).toBe("Renamed");
    expect(renamed.reply.rev).toBe(renamed.held!.rev);

    const reassigned = await ask("reassign", { tickets: ["02"], fields: { model: "x-model" } });
    expect(reassigned.ahead).toHaveLength(1);
    expect(reassigned.behind).toEqual([]);
    expect(
      reassigned.held?.snapshot.state.tickets.find((t) => t.id === "02")?.assignment.model,
    ).toBe("x-model");

    // A write the snapshot does not show moves nothing, and says so by
    // naming the revision the socket already holds.
    const machine = await ask("settings.machine.put", { defaults: {} });
    expect(machine.ahead).toEqual([]);
    expect(machine.reply.rev).toBe(reassigned.reply.rev);
  });

  // The HTTP route answers a write its dry run turns away (a
  // ReassignRefusal) with 400 and the reason naming the ticket it would
  // break; the socket refuses it the same, and the file stays as it was.
  it("refuses a Reassign the dry run turns away with 400, naming the ticket", async () => {
    const config = {
      defaults: { harness: "stub" },
      assign: { "01": { model: "m" }, "02": { model: "m" } },
    } satisfies PoolConfig;
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: ready("01") },
        { file: "02-a.md", marker: ready("02", "01") },
      ],
      config,
    });
    const server = startServer(
      poolDir,
      stubHarness(poolDir, { "01": { statuses: ["checkpoint", "done"] } }).harnesses,
    );
    await server.start();
    await server.settled();
    const client = await socket(server);
    const before = readFileSync(join(poolDir, "console.json"), "utf8");

    // 02's model is its own entry's alone: clearing it leaves none.
    const reply = await client.request("reassign", { tickets: ["02"], fields: { model: null } });
    expect(reply).toMatchObject({
      kind: "reassign",
      ok: false,
      refusal: {
        reason:
          "reassign: ticket '02' would be left with no model " +
          "(set one, or leave the field alone so it follows the pool defaults)",
        status: 400,
      },
    });
    expect(readFileSync(join(poolDir, "console.json"), "utf8")).toBe(before);
  });

  it("refuses with the HTTP twin's status, for every status class", async () => {
    const poolDir = makePool({
      tickets: [{ file: "01-a.md", marker: ready("01") }],
      config: { ...STUB_DEFAULTS, terminal: "herdr" },
    });
    const server = startServer(poolDir, stubHarness(poolDir, {}).harnesses, {
      herdrSocket: join(poolDir, "no-herdr.sock"),
    });
    const client = await socket(server);

    const refusal = async <K extends RequestKind>(kind: K, payload: RequestPayload<K>) => {
      const reply: ServerMessage = await client.request(kind, payload);
      if (reply.type !== "reply" || reply.ok) throw new Error(`${kind} was not refused`);
      return reply.refusal;
    };
    expect(await refusal("resume", { ticketId: "", action: "resume" })).toEqual({
      reason: "missing ticketId",
      status: 400,
    });
    // ADR-0035: an attempt is a whole number or nothing, refused as over HTTP.
    expect(await refusal("resume", { ticketId: "01", action: "adopt", attempt: 1.5 })).toEqual({
      reason: "attempt must be a whole attempt number, got 1.5",
      status: 400,
    });
    expect(await refusal("terminal.focus", { ticketId: "nope" })).toEqual({
      reason: "no terminal-backed pane for ticket nope",
      status: 404,
    });
    expect(await refusal("stop", {})).toEqual({
      reason: "pool not started: nothing to stop",
      status: 409,
    });
    expect(await refusal("reassign", { tickets: ["01"], fields: { model: "x" } })).toEqual({
      reason: "reassign: pool not started",
      status: 500,
    });
    expect((await refusal("panes.list", {})).status).toBe(502);

    // A request the envelope refuses is still answered, so its press never
    // hangs; a frame that is not a request at all is dropped.
    const from = client.frames.length;
    client.send({ type: "nonsense" } as never);
    (client as unknown as { send(raw: unknown): void }).send({
      type: "request",
      id: 77,
      kind: "stop",
    });
    const malformed = await client.waitFor(
      (frame) => frame.type === "reply" && frame.id === 77,
      { from, what: "the malformed request's refusal" },
    );
    expect(malformed).toMatchObject({
      kind: "stop",
      ok: false,
      refusal: { reason: "request without payload", status: 400 },
    });
  });
});

// Nothing on the way out takes the server down: Bun ends the process on an
// unhandled rejection, so a throw a push or a reply leaves behind would stop
// every tab's pool, not just the one press.
describe("a push or a reply that cannot go", () => {
  it("refuses a result it cannot serialise, keeps the socket, and answers the next request", async () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const results: Partial<Record<RequestKind, unknown>> = {
      "settings.get": circular,
      "panes.list": { panes: [], count: 1n },
    };
    const { url } = serveHub({
      request: async (kind) => answered(kind in results ? results[kind] : { fine: true }),
    });
    const client = await openSocket(url);
    sockets.push(client);

    const replies: ServerMessage[] = [];
    const { logged, rejections } = await escapesDuring(async () => {
      replies.push(await client.request("settings.get", {}));
      replies.push(await client.request("panes.list", {}));
      replies.push(await client.request("start", {}));
    });

    expect(rejections).toEqual([]);
    const [cyclic, bigInt, next] = replies;
    for (const [reply, kind] of [
      [cyclic, "settings.get"],
      [bigInt, "panes.list"],
    ] as const) {
      expect(reply).toMatchObject({ type: "reply", kind, ok: false, refusal: { status: 500 } });
      const { reason } = (reply as Extract<ServerMessage, { ok: false }>).refusal;
      expect(reason).toStartWith("could not encode the result: ");
      expect(logged.some((line) => line.includes(`reply to ${kind}`))).toBe(true);
    }
    // The socket is still up: the request after them is answered.
    expect(next).toMatchObject({ type: "reply", kind: "start", ok: true, result: { fine: true } });
  });

  // With no coalescing window the engine's emit pushes in its own call
  // stack, inside the engine's async drive, where a throw would reject it.
  // The emit here is fired and left, so a throw would escape unhandled.
  it("logs a push that throws with no coalescing window, and pushes the next emit", async () => {
    let current: () => EnrichedSnapshot | null = () => null;
    const { hub, url } = serveHub({ current: () => current() }, { coalesceMs: 0 });
    const client = await openSocket(url);
    sockets.push(client);
    await client.sync();

    current = () => {
      throw new Error("enrichment failed");
    };
    const emit = async (): Promise<void> => hub.schedule();
    const { logged, rejections } = await escapesDuring(async () => void emit());
    expect(rejections).toEqual([]);
    expect(logged).toContain("snapshot push: enrichment failed");

    current = () => EMPTY_POOL;
    hub.schedule();
    const pushed = await client.waitFor<Extract<ServerMessage, { type: "snapshot" }>>(
      (frame) => frame.type === "snapshot" && frame.rev === 1,
      { what: "the next emit's snapshot" },
    );
    expect(pushed.snapshot?.seq).toBe(EMPTY_POOL.seq);
  });
});

describe("cards", () => {
  it("sends a subscribed card whole in one frame, then its log's appends and its events", async () => {
    const { poolDir, server } = await finishedPool();
    const client = await socket(server);
    await client.sync();

    const from = client.frames.length;
    client.send({ type: "subscribe", card: { id: "01" } });
    const card = await client.waitFor<Extract<ServerMessage, { type: "card" }>>(isCard("01"), {
      from,
      what: "01's card",
    });
    expect(card.body).toEqual({ id: "01", body: "# body\n" });
    expect(card.events?.events.map((event) => event.kind)).toContain("spawned");
    const window = card.log as LogPush;
    expect(window).toMatchObject({ mode: "window", attempt: 1, stream: false, offset: 0 });
    expect(window.nextOffset).toBe(window.totalSize);
    expect(window.attempts?.map((a) => a.attempt)).toEqual([1]);

    // The log grows: the new bytes arrive as an append from where the
    // window ended, found by the watch long before the 2 s backstop.
    const logFile = join(poolDir, "runs", window.attempts![0]!.logFile);
    const grownFrom = client.frames.length;
    appendFileSync(logFile, "more output\n");
    const append = await client.waitFor<Extract<ServerMessage, { type: "card" }>>(
      isCard("01", (frame) => frame.log?.mode === "append"),
      { from: grownFrom, what: "the append", ms: 1_500 },
    );
    expect(append.log).toEqual({
      mode: "append",
      attempt: 1,
      stream: false,
      content: "more output\n",
      offset: window.nextOffset,
      nextOffset: window.nextOffset + "more output\n".length,
      totalSize: window.nextOffset + "more output\n".length,
    });
    // The subscribe made one frame, and nothing else came between.
    expect(client.frames.slice(from, grownFrom).filter(isCard("01"))).toHaveLength(1);

    // A new event reaches the card whole.
    appendEvent(join(poolDir, "runs"), "01", {
      kind: "answered",
      attempt: 1,
      at: new Date().toISOString(),
      payload: { note: "later" },
    });
    const events = await client.waitFor<Extract<ServerMessage, { type: "card" }>>(
      isCard("01", (frame) => frame.events !== undefined),
      { from: grownFrom, what: "the events", ms: 1_500 },
    );
    expect(events.events?.events.at(-1)?.kind).toBe("answered");

    // Unsubscribed, the card goes quiet.
    client.send({ type: "unsubscribe", id: "01" });
    await client.sync();
    const quietFrom = client.frames.length;
    appendFileSync(logFile, "unseen\n");
    await Bun.sleep(300);
    await client.sync();
    expect(client.frames.slice(quietFrom).filter(isCard("01"))).toEqual([]);
  });

  it("answers a card the pool does not know with an error", async () => {
    const { server } = await finishedPool();
    const client = await socket(server);
    client.send({ type: "subscribe", card: { id: "99" } });
    const card = await client.waitFor(isCard("99"));
    expect(card).toEqual({ type: "card", id: "99", error: "unknown ticket 99" });
  });

  it("holds 32 cards a socket at most, and turns away unknown ids without reading the disk", async () => {
    // Done already, so nothing runs and the pool settles at once.
    const ids = Array.from({ length: 34 }, (_, i) => String(i + 1).padStart(2, "0"));
    const poolDir = makePool({
      tickets: ids.map((id) => ({
        file: `${id}-a.md`,
        marker: `<!-- state: id=${id} blocked-by=none status=done -->`,
      })),
      config: STUB_DEFAULTS,
    });
    const server = startServer(poolDir, stubHarness(poolDir, {}).harnesses);
    await server.start();
    await server.settled();
    const client = await socket(server);
    await client.sync();

    // A hello past the cap holds the first 32 and drops the rest unread.
    let from = client.frames.length;
    client.send({ type: "hello", protocol: PROTOCOL_VERSION, visible: true, cards: ids.map((id) => ({ id })) });
    await client.sync();
    const held = client.frames.slice(from).filter((frame) => frame.type === "card");
    expect(held.map((frame) => (frame as { id: string }).id)).toEqual(ids.slice(0, 32));
    expect(held.every((frame) => (frame as { error?: string }).error === undefined)).toBe(true);
    from = client.frames.length;
    client.send({ type: "subscribe", card: { id: "34" } });
    expect(await client.waitFor(isCard("34"), { from })).toEqual({
      type: "card",
      id: "34",
      error: "a socket holds at most 32 cards",
    });

    // Two thousand ids the pool does not know: answered from the pushed
    // snapshot alone, at no cost a tab could feel.
    from = client.frames.length;
    const bogus = Array.from({ length: 2000 }, (_, i) => ({ id: `x${i}` }));
    const started = performance.now();
    client.send({ type: "hello", protocol: PROTOCOL_VERSION, visible: true, cards: bogus });
    await client.sync();
    expect(performance.now() - started).toBeLessThan(150);
    const refused = client.frames.slice(from).filter((frame) => frame.type === "card");
    expect(refused).toHaveLength(32);
    expect(refused[0]).toEqual({ type: "card", id: "x0", error: "unknown ticket x0" });

    // A frame past 64 KiB is not read at all: the socket is cut (Bun drops
    // the connection rather than sending 1009).
    client.send({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      visible: true,
      cards: [{ id: "x".repeat(70 * 1024) }],
    });
    expect([1006, 1009]).toContain((await client.closed).code);
  });

  // A card whose Issue file cannot be read is refused, holds nothing, and
  // leaves the hello's other cards held; once the file reads again, the
  // next subscribe gets it whole.
  it("refuses a card it cannot read without holding it, and reads it afresh once it can", async () => {
    if (process.getuid?.() === 0) return; // root reads a file chmod 000 anyway
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: ready("01") },
        { file: "02-b.md", marker: ready("02") },
      ],
      config: STUB_DEFAULTS,
    });
    const server = startServer(poolDir, stubHarness(poolDir, {}).harnesses);
    await server.start();
    await server.settled();
    const issue = join(poolDir, "issues", "02-b.md");
    const quiet = console.error;
    console.error = () => {};
    chmodSync(issue, 0o000);
    try {
      const first = await socket(server, { visible: true, cards: [{ id: "02" }, { id: "01" }] });
      const refusal = await first.waitFor(isCard("02"));
      expect((refusal as { error?: string }).error).toContain("could not be read");
      const whole = await first.waitFor<Extract<ServerMessage, { type: "card" }>>(isCard("01"));
      expect(whole.body).toEqual({ id: "01", body: "# body\n" });
      expect(whole.events).not.toBeNull();
    } finally {
      chmodSync(issue, 0o644);
      console.error = quiet;
    }

    const later = await socket(server, { visible: true, cards: [{ id: "02" }] });
    const card = await later.waitFor<Extract<ServerMessage, { type: "card" }>>(isCard("02"));
    expect(card.body).toEqual({ id: "02", body: "# body\n" });
    expect(card.events?.events.map((event) => event.kind)).toContain("spawned");
  });

  // An exited event carries the attempt's last log lines, which over a run
  // grows the events file to megabytes; the card's own log already shows
  // them, so a card's events leave them out, and the HTTP read keeps them.
  it("leaves each event's logTail out of a card, and keeps it in GET /api/events", async () => {
    const { server } = await finishedPool();
    const http = (await (await fetch(`${server.url}/api/events?ticket=01`)).json()) as {
      events: { kind: string; payload: Record<string, unknown> }[];
    };
    expect(http.events.some((event) => "logTail" in event.payload)).toBe(true);

    const client = await socket(server, { visible: true, cards: [{ id: "01" }] });
    const card = await client.waitFor<Extract<ServerMessage, { type: "card" }>>(isCard("01"));
    const events = card.events!.events;
    expect(events.some((event) => "logTail" in event.payload)).toBe(false);
    expect(events).toEqual(
      http.events.map(({ payload: { logTail: _logTail, ...payload }, ...event }) => ({
        ...event,
        payload,
      })) as never,
    );
  });

  // The stripping is per read, so a sequence split between two reads would
  // show its second half as text: an append stops short of a sequence still
  // arriving, and the next one brings it whole.
  it("never splits an escape sequence across two appends", async () => {
    const { poolDir, server } = await finishedPool();
    const client = await socket(server, { visible: true, cards: [{ id: "01" }] });
    const card = await client.waitFor<Extract<ServerMessage, { type: "card" }>>(isCard("01"));
    const window = card.log as LogPush;
    const logFile = join(poolDir, "runs", window.attempts![0]!.logFile);
    const appended = (from: number) =>
      client.waitFor<Extract<ServerMessage, { type: "card" }>>(
        isCard("01", (frame) => frame.log?.mode === "append"),
        { from, what: "an append" },
      );

    let from = client.frames.length;
    appendFileSync(logFile, "red \x1b[38;5");
    const first = await appended(from);
    expect(first.log).toMatchObject({ content: "red ", nextOffset: window.nextOffset + 4 });
    // GET /api/log's forward read stops at the same place.
    const http = (await (
      await fetch(`${server.url}/api/log?ticket=01&offset=${window.nextOffset}`)
    ).json()) as TicketLogResponse;
    expect([http.content, http.nextOffset]).toEqual(["red ", window.nextOffset + 4]);

    from = client.frames.length;
    appendFileSync(logFile, ";196mtext\x1b[0m done\n");
    const second = await appended(from);
    expect(second.log).toMatchObject({ content: "text done\n", offset: window.nextOffset + 4 });
    const shown = framesOf(client, "card")
      .filter((frame) => frame.log?.mode === "append")
      .map((frame) => frame.log!.content)
      .join("");
    expect(shown).toBe("red text done\n");
  });

  it("holds a hidden socket's appends, and catches it up when it shows", async () => {
    const { poolDir, server } = await finishedPool();
    const client = await socket(server, { visible: true, cards: [{ id: "01" }] });
    const card = await client.waitFor<Extract<ServerMessage, { type: "card" }>>(isCard("01"));
    const window = card.log as LogPush;
    const logFile = join(poolDir, "runs", window.attempts![0]!.logFile);

    client.send({ type: "visibility", visible: false });
    await client.sync();
    const hiddenFrom = client.frames.length;
    appendFileSync(logFile, "while hidden\n");
    await Bun.sleep(300);
    await client.sync();
    expect(client.frames.slice(hiddenFrom).filter(isCard("01"))).toEqual([]);

    client.send({ type: "visibility", visible: true });
    const append = await client.waitFor<Extract<ServerMessage, { type: "card" }>>(
      isCard("01", (frame) => frame.log?.mode === "append"),
      { from: hiddenFrom, what: "the held append" },
    );
    expect(append.log).toMatchObject({ offset: window.nextOffset, content: "while hidden\n" });
  });

  it("points a card's appends at another attempt with log.follow, and reads any range with log.read", async () => {
    const poolDir = makePool({ tickets: [{ file: "01-a.md", marker: ready("01") }], config: STUB_DEFAULTS });
    const server = startServer(
      poolDir,
      stubHarness(poolDir, { "01": { statuses: ["checkpoint", "done"] } }).harnesses,
    );
    await server.start();
    await server.settled();
    await server.answer("01", "resume");
    await server.settled();
    const client = await socket(server, { visible: true, cards: [{ id: "01" }] });
    const card = await client.waitFor<Extract<ServerMessage, { type: "card" }>>(isCard("01"));
    // Following the latest attempt, the second.
    expect((card.log as LogPush).attempt).toBe(2);
    const [first, second] = (card.log as LogPush).attempts!;
    writeFileSync(join(poolDir, "runs", first!.logFile), "attempt one\n");

    const followed = await client.request("log.follow", { id: "01", attempt: 1, stream: false });
    expect(followed.ok).toBe(true);
    const tail = (followed as Extract<typeof followed, { ok: true }>).result;
    expect(tail.content).toBe("attempt one\n");
    // The same read as GET /api/log's tail, named by what it was read from.
    const http = (await (
      await fetch(`${server.url}/api/log?ticket=01&attempt=1&offset=0`)
    ).json()) as TicketLogResponse;
    expect(tail).toEqual({ ...http, attempt: 1, stream: false });

    // A follow of the latest attempt says which attempt that resolved to.
    const latest = await client.request("log.follow", { id: "01", attempt: null, stream: false });
    expect(latest).toMatchObject({ ok: true, result: { attempt: 2, stream: false } });
    await client.request("log.follow", { id: "01", attempt: 1, stream: false });

    // Appends now follow the first attempt, and not the second.
    const from = client.frames.length;
    appendFileSync(join(poolDir, "runs", second!.logFile), "attempt two\n");
    appendFileSync(join(poolDir, "runs", first!.logFile), "one more\n");
    const append = await client.waitFor<Extract<ServerMessage, { type: "card" }>>(
      isCard("01", (frame) => frame.log?.mode === "append"),
      { from, what: "the first attempt's append" },
    );
    expect(append.log).toMatchObject({ attempt: 1, offset: tail.nextOffset, content: "one more\n" });
    await Bun.sleep(200);
    expect(
      client.frames.slice(from).filter(isCard("01", (frame) => frame.log?.attempt === 2)),
    ).toEqual([]);

    // log.read changes nothing it follows, and reads what GET /api/log does.
    const read = await client.request("log.read", { id: "01", attempt: 2, offset: 0 });
    const httpRead = await (await fetch(`${server.url}/api/log?ticket=01&attempt=2&offset=0`)).json();
    expect(read).toMatchObject({ ok: true, result: httpRead });
    expect((httpRead as TicketLogResponse).content).toContain("attempt two\n");
  });
});

describe("the live check", () => {
  it("sends a hidden socket no live values, and the whole of them when it shows", async () => {
    const poolDir = makePool({ tickets: [{ file: "01-a.md", marker: ready("01") }], config: STUB_DEFAULTS });
    const release = join(poolDir, "release");
    const server = startServer(
      poolDir,
      stubHarness(poolDir, { "01": { waitFor: release } }).harnesses,
    );
    const hidden = await socket(server, { visible: false });
    await hidden.sync();
    const shown = await socket(server, { visible: true });
    await shown.sync();

    await server.start();
    const live = await shown.waitFor<Extract<ServerMessage, { type: "live" }>>(
      (frame) => frame.type === "live" && frame.activity?.["01"] !== undefined,
      { what: "01's activity on the visible socket" },
    );
    expect(live.activity?.["01"]).toMatchObject({ ticketId: "01", running: true });
    // Everything the check sent the visible socket is sent by now.
    await hidden.sync();
    expect(
      framesOf(hidden, "live").filter((frame) => frame.activity || frame.peeks),
    ).toEqual([]);

    const from = hidden.frames.length;
    hidden.send({ type: "visibility", visible: true });
    const whole = await hidden.waitFor<Extract<ServerMessage, { type: "live" }>>(
      (frame) => frame.type === "live",
      { from, what: "the live cache on showing" },
    );
    expect(whole.activity?.["01"]).toEqual(live.activity!["01"]!);

    writeFileSync(release, "go");
    await server.settled();
  }, 20_000);

  it("peeks a new pane at once, and pushes its text again only when it moves", async () => {
    const poolDir = makePool({
      tickets: [{ file: "01-a.md", marker: ready("01") }],
      config: { ...STUB_DEFAULTS, terminal: "herdr" },
    });
    const release = join(poolDir, "release");
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    const server = startServer(
      poolDir,
      stubHarness(poolDir, { "01": { waitFor: release } }).harnesses,
      { herdrSocket: fake.socketPath },
    );
    const client = await socket(server);
    await client.sync();

    await server.start();
    const added = await client.waitFor(
      () => typeof client.pushed?.snapshot.state.tickets[0]?.liveAttempt?.paneId === "string",
      { what: "01's pane on the socket" },
    );
    const paneId = client.pushed!.snapshot.state.tickets[0]!.liveAttempt!.paneId!;
    const from = client.frames.indexOf(added);
    const first = await client.waitFor<Extract<ServerMessage, { type: "live" }>>(
      (frame) => frame.type === "live" && frame.peeks?.["01"] !== undefined,
      { from, what: "01's first peek" },
    );
    expect(first.peeks?.["01"]).toMatchObject({ ticket: "01", paneId });
    // A push that adds a pane runs the check at once, not on the 2 s timer.
    const waited = client.times[client.frames.indexOf(first)]! - client.times[from]!;
    expect(waited).toBeLessThan(1_000);

    // The pane's text moves: the next check pushes it, and only it.
    const movedFrom = client.frames.length;
    fake.setPaneContent(paneId, "working");
    const moved = await client.waitFor<Extract<ServerMessage, { type: "live" }>>(
      (frame) => frame.type === "live" && frame.peeks?.["01"] !== undefined,
      { from: movedFrom, what: "01's moved peek", ms: 5_000 },
    );
    expect(moved.peeks?.["01"]).toEqual({ ticket: "01", paneId, text: "working" });
    await Bun.sleep(2_200);
    expect(
      framesOf(client, "live")
        .slice(framesOf(client, "live").indexOf(moved) + 1)
        .filter((frame) => frame.peeks?.["01"] !== undefined),
    ).toEqual([]);

    writeFileSync(release, "go");
    await server.settled();
  }, 20_000);
});

describe("the stop", () => {
  it("replies, sends the `stopped` delta, then closes 1000 stopped", async () => {
    const { poolDir, server } = await finishedPool();
    const client = await socket(server);
    await client.sync();

    const reply = await client.request("stop", {});
    expect(reply).toMatchObject({ ok: true, result: { stopping: true } });
    const closed = await client.closed;
    expect(closed).toEqual({ code: CLOSE_STOPPED.code, reason: CLOSE_STOPPED.reason });
    // The farewell is the last delta, behind the reply.
    const deltas = framesOf(client, "delta");
    expect(deltas.at(-1)?.delta.set?.phase).toBe("stopped");
    expect(client.frames.indexOf(deltas.at(-1)!)).toBeGreaterThan(client.frames.indexOf(reply));
    expect(client.pushed?.snapshot.poolDir).toBe(poolDir);

    await server.shutdown();
    await expect(fetch(`${server.url}/api/state`)).rejects.toThrow();
  }, 20_000);
});

describe("the served page", () => {
  it("embeds the boot snapshot the socket's first frames repeat", async () => {
    const dist = makeTempDir("dist-");
    registerTempDir(dist);
    writeFileSync(
      join(dist, "index.html"),
      "<!doctype html><html><head><title>Console</title></head><body></body></html>",
    );
    const poolDir = makePool({ tickets: [{ file: "01-a.md", marker: ready("01") }], config: STUB_DEFAULTS });
    const server = startServer(poolDir, stubHarness(poolDir, {}).harnesses, { distDir: dist });

    const bootOf = async (path: string) => {
      const res = await fetch(`${server.url}${path}`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      const match = new RegExp(
        `<script id="${EMBED_ELEMENT_ID}" type="application/json">(.*?)</script></head>`,
      ).exec(html);
      expect(match).not.toBeNull();
      return readEmbeddedBoot(match![1]);
    };

    // Before the start: the null snapshot of revision 0.
    expect(await bootOf("/")).toMatchObject({ protocol: PROTOCOL_VERSION, rev: 0, snapshot: null });

    await server.start();
    const settled = await server.settled();
    const boot = await bootOf("/");
    expect(boot?.snapshot?.seq).toBe(settled.seq);
    expect(await bootOf("/index.html")).toEqual(boot);

    // The socket opened from that page starts at the same epoch and
    // revision, so the Console keeps what it painted.
    const client = await socket(server);
    await client.waitFor((frame) => frame.type === "snapshot");
    expect((client.frames[0] as { epoch: string }).epoch).toBe(boot!.epoch);
    expect(client.rev).toBe(boot!.rev);
    expect(client.pushed?.snapshot).toEqual(boot!.snapshot!);
  });
});

describe("GET /api/pool-log", () => {
  it("serves the pool log's lines before a line, as many as asked up to the cap", async () => {
    const { server } = await finishedPool(["01", "02", "03"]);
    const log = server.latest!.state.log;
    expect(log.length).toBeGreaterThan(4);
    const get = async (query: string) => {
      const res = await fetch(`${server.url}/api/pool-log?${query}`);
      return { status: res.status, body: await res.json() };
    };
    expect(await get(`before=${log.length}`)).toEqual({
      status: 200,
      body: { start: 0, lines: log, total: log.length },
    });
    expect(await get("before=4&limit=2")).toEqual({
      status: 200,
      body: { start: 2, lines: log.slice(2, 4), total: log.length },
    });
    // Past the end reads to the end; a limit over the cap is the cap.
    expect((await get(`before=${log.length + 50}&limit=99999`)).body).toEqual({
      start: 0,
      lines: log,
      total: log.length,
    });
    expect(await get("before=nope")).toEqual({
      status: 400,
      body: { error: "before must be a line number" },
    });
    expect(await get("before=3&limit=0")).toEqual({
      status: 400,
      body: { error: "limit must be a positive whole number" },
    });
  });
});

// Every request kind, once over the socket and once over its HTTP twin, on
// the same pool in the same state: the same result, or the same refusal
// with the same status. The kinds that change something are asked in a
// state where asking twice answers the same (a refusal, or an idempotent
// write), so the order of the two asks does not matter.
describe("socket and HTTP parity", () => {
  it("answers every request kind as its HTTP twin does", async () => {
    const home = makeTempDir("machine-home-");
    registerTempDir(home);
    const { server } = await finishedPool(["01", "02"], {
      onStopRequested: () => {},
      onRestartRequested: () => {},
      machineDefaultsPaths: {
        file: join(home, "defaults.json"),
        issueRunner: join(home, ".issue-runner"),
        consoleRunner: join(home, ".console-runner"),
      },
    });
    const client = await socket(server);
    const logTotal = server.latest!.state.log.length;

    type Http = { method: "GET" | "POST" | "PUT"; path: string; body?: unknown };
    const cases: { [K in RequestKind]: [RequestPayload<K>, Http] } = {
      start: [{}, { method: "POST", path: "/api/start" }],
      resume: [
        { ticketId: "02", action: "resume" },
        { method: "POST", path: "/api/resume", body: { ticketId: "02", action: "resume" } },
      ],
      stop: [{}, { method: "POST", path: "/api/stop" }],
      restart: [{}, { method: "POST", path: "/api/restart" }],
      keepTalking: [
        { ticketId: "01" },
        { method: "POST", path: "/api/keep-talking", body: { ticketId: "01" } },
      ],
      "terminal.focus": [{ ticketId: "01" }, { method: "POST", path: "/api/terminal/focus?ticket=01" }],
      "terminals.closeFinished": [{}, { method: "POST", path: "/api/terminals/close-finished" }],
      enlist: [
        { becomes: "ticket", paneId: "p1", title: "t", spec: "s" },
        {
          method: "POST",
          path: "/api/enlist",
          body: { becomes: "ticket", paneId: "p1", title: "t", spec: "s" },
        },
      ],
      reassign: [
        { tickets: ["nope"], fields: { model: "x" } },
        { method: "PUT", path: "/api/reassign", body: { tickets: ["nope"], fields: { model: "x" } } },
      ],
      "spawns.held.adopt": [
        { id: "nope" },
        { method: "POST", path: "/api/spawns/held/adopt", body: { id: "nope" } },
      ],
      "spawns.held.discard": [
        { id: "nope" },
        { method: "POST", path: "/api/spawns/held/discard", body: { id: "nope" } },
      ],
      "spawns.pending.hold": [
        { id: "nope" },
        { method: "POST", path: "/api/spawns/pending/hold", body: { id: "nope" } },
      ],
      "spawns.pending.discard": [
        { id: "nope" },
        { method: "POST", path: "/api/spawns/pending/discard", body: { id: "nope" } },
      ],
      "conversations.start": [
        { title: "talk" },
        { method: "POST", path: "/api/conversations", body: { title: "talk" } },
      ],
      "conversations.end": [
        { id: "nope" },
        { method: "POST", path: "/api/conversations/end", body: { id: "nope" } },
      ],
      "settings.get": [{}, { method: "GET", path: "/api/settings" }],
      "settings.pool.put": [
        { config: { title: "Parity" } },
        { method: "PUT", path: "/api/settings/pool", body: { config: { title: "Parity" } } },
      ],
      "settings.machine.put": [
        { defaults: {} },
        { method: "PUT", path: "/api/settings/machine", body: { defaults: {} } },
      ],
      "panes.list": [{}, { method: "GET", path: "/api/panes" }],
      "log.read": [{ id: "01", offset: 0 }, { method: "GET", path: "/api/log?ticket=01&offset=0" }],
      // A tail read: the file is under a window long, so it starts at 0.
      "log.follow": [
        { id: "01", attempt: null, stream: false },
        { method: "GET", path: "/api/log?ticket=01&offset=0" },
      ],
      "poolLog.read": [
        { before: logTotal, limit: 3 },
        { method: "GET", path: `/api/pool-log?before=${logTotal}&limit=3` },
      ],
    };

    const seen = new Set<string>();
    for (const [kind, [payload, http]] of Object.entries(cases) as [
      RequestKind,
      [RequestPayload<RequestKind>, Http],
    ][]) {
      const reply = await client.request(kind, payload);
      const res = await fetch(`${server.url}${http.path}`, {
        method: http.method,
        ...(http.body !== undefined
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(http.body) }
          : {}),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (reply.ok) {
        expect(`${kind} ${res.status < 300}`).toBe(`${kind} true`);
        const { snapshot: _snapshot, ...rest } = body;
        let result: unknown = reply.result;
        if (reply.kind === "log.follow") {
          // The follow's reply names the attempt and variant it read, which
          // its HTTP twin, a plain read of the same tail, does not.
          const { attempt, stream, ...window } = reply.result;
          expect({ attempt, stream }).toEqual({ attempt: 1, stream: false });
          result = window;
        }
        expect([kind, result]).toEqual([kind, rest as never]);
      } else {
        expect([kind, reply.refusal]).toEqual([
          kind,
          { reason: (body.error ?? body.reason) as string, status: res.status },
        ]);
      }
      seen.add(`${kind}:${reply.ok ? "ok" : reply.refusal.status}`);
    }
    // Both shapes are exercised: answers and refusals of several classes.
    expect([...seen].filter((s) => s.endsWith(":ok")).length).toBeGreaterThan(5);
    expect(new Set([...seen].map((s) => s.split(":")[1]))).toEqual(
      new Set(["ok", "400", "404", "409"]),
    );
  }, 30_000);
});
