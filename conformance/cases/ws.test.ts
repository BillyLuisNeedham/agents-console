/**
 * The Console's socket (issue #161, ADR-0032), ported from engine/ws.test.ts
 * onto a real server process (ADR-0036): the opening frames, one delta per
 * coalesced change for every socket alike, a reply behind the delta that
 * carries its effect, refusals in the HTTP twin's status, the cards and
 * their log, the live check's rule for hidden tabs, the stop's farewell,
 * the page's embedded boot, the pool log's earlier lines, and every request
 * kind answered as its HTTP twin answers.
 *
 * Where the engine suite opened sockets before `server.start()`, these open
 * them once the server is up: the command line starts the pool in the same
 * tick it binds. Where it held an Attempt open with a stub's `waitFor`,
 * these put a holding `claude` first on the world's PATH (holdClaude).
 */

import { expect } from "bun:test";
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LogPush,
  PushedSnapshot,
  RequestKind,
  RequestPayload,
  ServerMessage,
} from "../../protocol/protocol.ts";
import type { EnrichedSnapshot, PoolConfig, TicketLogResponse } from "../../protocol/wire.ts";
import { openSocket, framesOf, type SocketClient } from "../fixtures/socket-fixture.ts";
import { PROTOCOL_VERSION, WS_PATH, applySnapshotDelta } from "../fixtures/socket-protocol.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { expectParsedEqual, expectSameFile } from "../harness/equal.ts";
import { until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";

// protocol/protocol.ts HEARTBEAT_MS: the heartbeat interval the hello announces.
const HEARTBEAT_MS = 20_000;
// protocol/protocol.ts EMBED_ELEMENT_ID: the page's boot snapshot element.
const EMBED_ELEMENT_ID = "console-boot";
// protocol/protocol.ts CLOSE_STOPPED: the farewell close.
const CLOSE_STOPPED = { code: 1000, reason: "stopped" };
// engine/engine.ts REVIEW_TICKET_ID: the final Review gate's Interrupt.
const REVIEW = "REVIEW";
// engine/spawn.ts, claude's readyPattern: what its pane shows once it can take a prompt.
const CLAUDE_READY = "Claude Code v";

const STUB = join(import.meta.dir, "..", "fixtures", "stub-harness.sh");

/** The engine suite's STUB_DEFAULTS, on a harness the world stubs. */
const CLAUDE = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;

const ready = (id: string, blockedBy = "none"): string =>
  `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`;

type Snapshot = EnrichedSnapshot;
type Card = Extract<ServerMessage, { type: "card" }>;
type Live = Extract<ServerMessage, { type: "live" }>;

/** The snapshot GET /api/state serves now. */
async function state(server: CaseServer): Promise<Snapshot> {
  const answer = await server.http.get("/api/state");
  return answer.json<{ snapshot: Snapshot }>().snapshot;
}

/** Wait for GET /api/state to reach `phase`, and hand back that snapshot. */
function phase(server: CaseServer, want: string, ms = 30_000): Promise<Snapshot> {
  return until(() => state(server), (snap) => snap?.phase === want, { what: `the pool to be ${want}`, ms });
}

/** Wait for a quiescent pool whose Interrupts include one for `ticket`. */
function interruptFor(server: CaseServer, ticket: string, ms = 30_000): Promise<Snapshot> {
  return until(
    () => state(server),
    (snap) => snap?.phase === "quiescent" && snap.state.interrupts.some((i) => i.ticketId === ticket),
    { what: `an Interrupt for ${ticket}`, ms },
  );
}

/** Answer an Interrupt over HTTP, as the Console's buttons do. */
async function answer(server: CaseServer, ticketId: string, action: string): Promise<void> {
  const res = await server.http.post("/api/resume", { ticketId, action });
  expect([ticketId, action, res.status < 300]).toEqual([ticketId, action, true]);
}

/** A world of ready Tickets `<id>-a.md` with the body "# body". */
function poolWorld(t: Case, ids: string[], config: PoolConfig = CLAUDE, blocked: Record<string, string> = {}): World {
  return t.world({
    tickets: ids.map((id) => ({ file: `${id}-a.md`, marker: ready(id, blocked[id]), body: "# body" })),
    config,
  });
}

/** A pool driven through its review gate: phase `done`, every Ticket run. */
async function finishedPool(t: Case, ids: string[] = ["01"]): Promise<{ world: World; server: CaseServer }> {
  const world = poolWorld(t, ids);
  const server = await t.start(world);
  await interruptFor(server, REVIEW);
  await answer(server, REVIEW, "approve");
  await phase(server, "done");
  return { world, server };
}

/**
 * A `claude` that waits for `release` before it runs the stub, put first on
 * the world's PATH in place of the stub's own wrapper: the engine suite's
 * `waitFor`, without the stub's ten-second bound. Bounded at two minutes so
 * a case that fails before releasing it leaves nothing behind.
 */
function holdClaude(world: World, release: string): void {
  writeFileSync(
    join(world.stubs.bin, "claude"),
    `#!/usr/bin/env bash\nfor _ in $(seq 1 2400); do [ -e ${JSON.stringify(release)} ] && break; sleep 0.05; done\n` +
      `exec bash ${JSON.stringify(STUB)} claude "$@"\n`,
  );
  chmodSync(join(world.stubs.bin, "claude"), 0o755);
}

/** The snapshot as a socket held it just before frame `index` arrived. */
function heldBefore(frames: ServerMessage[], index: number): PushedSnapshot | null {
  let held: PushedSnapshot | null = null;
  for (const frame of frames.slice(0, index)) {
    if (frame.type === "snapshot") {
      held = frame.snapshot === null ? null : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
    } else if (frame.type === "delta") {
      held = applySnapshotDelta(held!, frame.delta);
    }
  }
  return held;
}

const isCard =
  (id: string, has: (frame: Card) => boolean = () => true) =>
  (frame: ServerMessage): boolean =>
    frame.type === "card" && frame.id === id && has(frame);

/** A card frame for `id`, waited for from `from`. */
function cardOf(client: SocketClient, id: string, options: { from?: number; ms?: number; what?: string; has?: (frame: Card) => boolean } = {}): Promise<Card> {
  return client.waitFor<Card>(isCard(id, options.has), { from: options.from, ms: options.ms, what: options.what ?? `${id}'s card` });
}

/** The attempt log a card's window names, as a path in the pool. */
function logPath(world: World, window: LogPush, attempt = 0): string {
  return join(world.pool, "runs", window.attempts![attempt]!.logFile);
}

// ---------------------------------------------------------------------------
// opening a socket
// ---------------------------------------------------------------------------

// engine/ws.test.ts:233
conformance("protocol", "opening a socket › says hello, then sends the snapshot, without waiting for the client", async (t) => {
  const world = poolWorld(t, ["01"]);
  const server = await t.start(world);

  // No hello and no request: the server speaks first.
  const early = await t.socket(server);
  await early.waitFor(() => early.frames.length >= 2, { what: "the opening frames" });
  const [hello, snapshot] = early.frames;
  expectParsedEqual(
    hello,
    { type: "hello", protocol: PROTOCOL_VERSION, epoch: expect.any(String), heartbeatMs: HEARTBEAT_MS },
    "the first frame",
  );
  expect(snapshot!.type).toBe("snapshot");
  expect((snapshot as Extract<ServerMessage, { type: "snapshot" }>).snapshot).not.toBeNull();

  // The run settles, and the socket catches up with it.
  const settled = await interruptFor(server, REVIEW);
  await until(() => early.pushed?.snapshot.seq, (seq) => seq === settled.seq, { what: "the socket to catch up" });
  expect(early.pushed?.snapshot.phase).toBe(settled.phase);

  // A socket opened now starts where the first one is.
  const late = await t.socket(server);
  await late.waitFor((frame) => frame.type === "snapshot", { what: "the late socket's snapshot" });
  await early.sync();
  expect(late.frames[0]).toEqual(hello!);
  expect(late.rev).toBe(early.rev);
  expect(late.pushed).toEqual(early.pushed);
});

// engine/ws.test.ts:261
conformance("protocol", "opening a socket › refuses a plain request at the socket's path", async (t) => {
  const world = poolWorld(t, ["01"]);
  const server = await t.start(world);
  const res = await server.http.get(WS_PATH);
  expect(res.status).toBe(400);
  expect(res.text).toBe("expected a WebSocket upgrade");
});

// engine/ws.test.ts:270
conformance(
  "protocol",
  "opening a socket › refuses a socket opened from another site's page, and opens one from its own page or none",
  async (t) => {
    const world = poolWorld(t, ["01"]);
    const server = await t.start(world);

    for (const origin of ["http://evil.example", "null", `http://localhost:1${server.port}`]) {
      const res = await fetch(`${server.url}${WS_PATH}`, { headers: { origin } });
      expect([origin, res.status, await res.text()]).toEqual([origin, 403, "cross-origin socket refused"]);
    }
    await expect(openSocket(server.url, undefined, { Origin: "http://evil.example" })).rejects.toThrow(/failed to open/);

    // The Console's own page, and a client that names no page at all.
    for (const headers of [{ Origin: server.url }, undefined]) {
      const client = await t.socket(server, undefined, headers);
      const hello = await client.waitFor((frame) => frame.type === "hello", { what: "the hello" });
      expect(hello.type).toBe("hello");
      expect(await client.request("settings.get", {})).toMatchObject({ ok: true });
    }
  },
);

// ---------------------------------------------------------------------------
// the snapshot push
// ---------------------------------------------------------------------------

// engine/ws.test.ts:294
conformance("protocol", "the snapshot push › sends every socket the same delta per coalesced change, each on from the last", async (t) => {
  const world = poolWorld(t, ["01", "02"], CLAUDE, { "02": "01" });
  const release = join(world.root, "release");
  holdClaude(world, release);
  const server = await t.start(world);

  // 01 is held, so both sockets open on the same revision before the run moves.
  await until(
    () => state(server),
    (snap) => snap?.state.tickets.find((ticket) => ticket.id === "01")?.liveAttempt != null,
    { what: "01's Attempt to be running", ms: 30_000 },
  );
  const a = await t.socket(server);
  const b = await t.socket(server);
  await a.sync();
  await b.sync();
  await a.sync();
  expect(b.rev).toBe(a.rev);
  const firstRev = a.rev;
  const firstSeq = a.pushed!.snapshot.seq;

  // The run to its review gate, then past it.
  writeFileSync(release, "go");
  await until(() => a.pushed?.snapshot.state.interrupts.some((i) => i.ticketId === REVIEW), (got) => got === true, {
    what: "the review gate on the socket",
    ms: 30_000,
  });
  await answer(server, REVIEW, "approve");
  const settled = await phase(server, "done");
  for (const client of [a, b]) {
    await until(() => client.pushed?.snapshot.seq, (seq) => seq === settled.seq, { what: "both sockets to catch up" });
  }

  // One global version: the same frames to both.
  const pushes = (client: SocketClient) =>
    client.frames.filter((frame) => frame.type === "snapshot" || frame.type === "delta");
  expect(JSON.stringify(pushes(a))).toBe(JSON.stringify(pushes(b)));
  // Each delta builds on the revision before it, one at a time.
  const deltas = framesOf(a, "delta").map((frame) => frame.delta);
  expect(deltas.length).toBeGreaterThan(0);
  deltas.forEach((delta, i) => {
    expect(delta.base).toBe(firstRev + i);
    expect(delta.rev).toBe(firstRev + i + 1);
  });
  // A burst of emits is one delta: fewer of them than the engine emitted.
  expect(deltas.length).toBeLessThan(settled.seq - firstSeq);
  // What the deltas build is what the server holds.
  expect(a.pushed?.snapshot.state.tickets).toEqual(settled.state.tickets);
});

// engine/ws.test.ts:335
conformance(
  "protocol",
  "the snapshot push › sends a hidden socket its deltas and heartbeats too",
  async (t) => {
    const world = poolWorld(t, ["01"]);
    const release = join(world.root, "release");
    holdClaude(world, release);
    const server = await t.start(world);
    const hidden = await t.socket(server, { visible: false });
    await hidden.sync();
    const opened = hidden.rev;

    writeFileSync(release, "go");
    const settled = await interruptFor(server, REVIEW);
    await until(() => hidden.pushed?.snapshot.seq, (seq) => seq === settled.seq, {
      what: "the hidden socket to catch up",
    });
    expect(framesOf(hidden, "delta").length).toBeGreaterThan(0);
    expect(hidden.rev).toBeGreaterThan(opened);
    // The real interval: a heartbeat within it, and a little over.
    await hidden.waitFor((frame) => frame.type === "heartbeat", { what: "a heartbeat", ms: HEARTBEAT_MS + 10_000 });
  },
  { timeoutMs: 90_000 },
);

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

// engine/ws.test.ts:350
conformance("protocol", "requests › replies to an action after the delta that carries its effect", async (t) => {
  const world = poolWorld(t, ["01"]);
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  await interruptFor(server, "01");
  const client = await t.socket(server);
  await client.sync();
  expect(client.pushed?.snapshot.state.interrupts.some((i) => i.ticketId === "01")).toBe(true);

  const before = client.rev;
  const reply = await client.request("resume", { ticketId: "01", action: "resume" });
  expect(reply).toMatchObject({ kind: "resume", ok: true, result: {} });
  const at = client.frames.indexOf(reply);
  const held = heldBefore(client.frames, at);
  // The delta is on the socket ahead of the reply, and the reply names the
  // revision it made.
  expect(reply.rev).toBeGreaterThan(before);
  expect(held?.rev).toBe(reply.rev);
  expect(held?.snapshot.state.interrupts.some((i) => i.ticketId === "01")).toBe(false);
  await interruptFor(server, REVIEW);
});

// engine/ws.test.ts:382
conformance("protocol", "requests › replies to a settings save and a Reassign after their deltas, with none behind", async (t) => {
  const world = poolWorld(t, ["01", "02"], CLAUDE, { "02": "01" });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  await interruptFor(server, "01");
  const client = await t.socket(server);
  await client.sync();

  const ask = async <K extends RequestKind>(kind: K, payload: RequestPayload<K>) => {
    const from = client.frames.length;
    const reply = await client.request(kind, payload);
    expect([kind, reply.ok]).toEqual([kind, true]);
    const at = client.frames.indexOf(reply);
    const ahead = client.frames.slice(from, at).filter((frame) => frame.type === "delta");
    await Bun.sleep(150);
    await client.sync();
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
  expect(reassigned.held?.snapshot.state.tickets.find((ticket) => ticket.id === "02")?.assignment.model).toBe("x-model");

  // A write the snapshot does not show moves nothing, and names the
  // revision the socket already holds.
  const machine = await ask("settings.machine.put", { defaults: {} });
  expect(machine.ahead).toEqual([]);
  expect(machine.reply.rev).toBe(reassigned.reply.rev);
});

// engine/ws.test.ts:434
conformance("config", "requests › refuses a Reassign the dry run turns away with 400, naming the ticket", async (t) => {
  const config = {
    defaults: { harness: "claude" },
    assign: { "01": { model: "m" }, "02": { model: "m" } },
  } satisfies PoolConfig;
  const world = poolWorld(t, ["01", "02"], config, { "02": "01" });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  await interruptFor(server, "01");
  const client = await t.socket(server);
  const before = readFileSync(join(world.pool, "console.json"));

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
  expectSameFile(join(world.pool, "console.json"), before);
});

// engine/ws.test.ts:470
conformance("protocol", "requests › refuses with the HTTP twin's status, for every status class", async (t) => {
  // No herdr daemon listens on the world's socket.
  const world = poolWorld(t, ["01"], { ...CLAUDE, terminal: "herdr" });
  const server = await t.start(world);
  await interruptFor(server, REVIEW);
  const client = await t.socket(server);

  type Twin = { method: string; path: string; body?: unknown };
  const refusal = async <K extends RequestKind>(kind: K, payload: RequestPayload<K>, twin: Twin | null) => {
    const reply: ServerMessage = await client.request(kind, payload);
    if (reply.type !== "reply" || reply.ok) throw new Error(`${kind} was not refused: ${JSON.stringify(reply)}`);
    if (twin === null) return reply.refusal;
    const res = await server.http.call(twin.method, twin.path, twin.body);
    const body = res.json<{ error?: string; reason?: string }>();
    expect([kind, reply.refusal]).toEqual([kind, { reason: (body.error ?? body.reason)!, status: res.status }]);
    return reply.refusal;
  };

  expect(
    await refusal("resume", { ticketId: "", action: "resume" }, {
      method: "POST",
      path: "/api/resume",
      body: { ticketId: "", action: "resume" },
    }),
  ).toEqual({ reason: "missing ticketId", status: 400 });
  // ADR-0035: an attempt is a whole number or nothing, refused as over HTTP.
  expect(
    await refusal("resume", { ticketId: "01", action: "adopt", attempt: 1.5 }, {
      method: "POST",
      path: "/api/resume",
      body: { ticketId: "01", action: "adopt", attempt: 1.5 },
    }),
  ).toEqual({ reason: "attempt must be a whole attempt number, got 1.5", status: 400 });
  expect(
    await refusal("terminal.focus", { ticketId: "nope" }, { method: "POST", path: "/api/terminal/focus?ticket=nope" }),
  ).toEqual({ reason: "no terminal-backed pane for ticket nope", status: 404 });
  // A pool not yet done may not be stopped.
  expect(await refusal("stop", {}, { method: "POST", path: "/api/stop" })).toEqual({
    reason: "pool is quiescent, not done: stop refused",
    status: 409,
  });
  // Its twin, GET /api/panes, is not asked here: on the Bun server it answers
  // 502 and then the process dies of an uncaught connect error, a bug in
  // the TypeScript server; the engine suite asked the socket only.
  expect((await refusal("panes.list", {}, null)).status).toBe(502);
  // console.json turned unreadable under the server: its own failure, 500.
  writeFileSync(join(world.pool, "console.json"), "{ not json");
  expect(
    (
      await refusal("reassign", { tickets: ["01"], fields: { model: "x" } }, {
        method: "PUT",
        path: "/api/reassign",
        body: { tickets: ["01"], fields: { model: "x" } },
      })
    ).status,
  ).toBe(500);

  // A request the envelope refuses is still answered, so its press never
  // hangs; a frame that is not a request at all is dropped.
  const from = client.frames.length;
  client.send({ type: "nonsense" } as never);
  client.send({ type: "request", id: 77, kind: "stop" } as never);
  const malformed = await client.waitFor((frame) => frame.type === "reply" && frame.id === 77, {
    from,
    what: "the malformed request's refusal",
  });
  expect(malformed).toMatchObject({
    kind: "stop",
    ok: false,
    refusal: { reason: "request without payload", status: 400 },
  });
  await client.sync();
  // Between them, only the malformed request's refusal and the sync's reply.
  const replies = client.frames.slice(from).filter((frame) => frame.type === "reply");
  expect(replies.map((frame) => (frame as { kind: string }).kind)).toEqual(["stop", "poolLog.read"]);
});

// ---------------------------------------------------------------------------
// cards
// ---------------------------------------------------------------------------

// engine/ws.test.ts:735
conformance("protocol", "cards › sends a subscribed card whole in one frame, then its log's appends and its events", async (t) => {
  const { world, server } = await finishedPool(t);
  const client = await t.socket(server);
  await client.sync();

  const from = client.frames.length;
  client.send({ type: "subscribe", card: { id: "01" } });
  const card = await cardOf(client, "01", { from });
  expect(card.body).toEqual({ id: "01", body: "# body\n" });
  expect(card.events?.events.map((event) => event.kind)).toContain("spawned");
  const window = card.log as LogPush;
  expect(window).toMatchObject({ mode: "window", attempt: 1, stream: false, offset: 0 });
  expect(window.nextOffset).toBe(window.totalSize);
  expect(window.attempts?.map((a) => a.attempt)).toEqual([1]);

  // The log grows: the new bytes arrive as an append from where the window
  // ended, found by the watch long before the 2 s backstop.
  const logFile = logPath(world, window);
  const grownFrom = client.frames.length;
  appendFileSync(logFile, "more output\n");
  const append = await cardOf(client, "01", {
    from: grownFrom,
    ms: 1_500,
    what: "the append",
    has: (frame) => frame.log?.mode === "append",
  });
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
  appendFileSync(
    join(world.pool, "runs", "01.events.jsonl"),
    `${JSON.stringify({ kind: "answered", attempt: 1, at: new Date().toISOString(), payload: { note: "later" } })}\n`,
  );
  const events = await cardOf(client, "01", {
    from: grownFrom,
    ms: 1_500,
    what: "the events",
    has: (frame) => frame.events !== undefined,
  });
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

// engine/ws.test.ts:797
conformance("protocol", "cards › answers a card the pool does not know with an error", async (t) => {
  const { world, server } = await finishedPool(t);
  const client = await t.socket(server);
  client.send({ type: "subscribe", card: { id: "99" } });
  const card = await cardOf(client, "99");
  expect(card).toEqual({ type: "card", id: "99", error: "unknown ticket 99" });

  // Later file changes bring nothing for 99.
  appendFileSync(
    join(world.pool, "runs", "01.events.jsonl"),
    `${JSON.stringify({ kind: "answered", attempt: 1, at: new Date().toISOString(), payload: { note: "later" } })}\n`,
  );
  await Bun.sleep(300);
  await client.sync();
  expect(client.frames.filter(isCard("99"))).toHaveLength(1);
});

// engine/ws.test.ts:805
conformance("protocol", "cards › holds 32 cards a socket at most, and turns away unknown ids without reading the disk", async (t) => {
  // Done already, so nothing runs and the pool settles at once.
  const ids = Array.from({ length: 34 }, (_, i) => String(i + 1).padStart(2, "0"));
  const world = t.world({
    tickets: ids.map((id) => ({ file: `${id}-a.md`, marker: `<!-- state: id=${id} blocked-by=none status=done -->` })),
    config: CLAUDE,
  });
  const server = await t.start(world);
  await interruptFor(server, REVIEW);
  const client = await t.socket(server);
  await client.sync();

  // A hello past the cap holds the first 32 and drops the rest unread.
  let from = client.frames.length;
  client.send({ type: "hello", protocol: PROTOCOL_VERSION, visible: true, cards: ids.map((id) => ({ id })) });
  await client.sync();
  const held = client.frames.slice(from).filter((frame) => frame.type === "card") as Card[];
  expect(held.map((frame) => frame.id)).toEqual(ids.slice(0, 32));
  expect(held.every((frame) => frame.error === undefined)).toBe(true);
  from = client.frames.length;
  client.send({ type: "subscribe", card: { id: "34" } });
  expect(await cardOf(client, "34", { from })).toEqual({
    type: "card",
    id: "34",
    error: "a socket holds at most 32 cards",
  });

  // Two thousand ids the pool does not know: answered from the pushed
  // snapshot alone, at once (the engine suite's bound was 150 ms in
  // process; a loaded machine gets more).
  from = client.frames.length;
  const bogus = Array.from({ length: 2000 }, (_, i) => ({ id: `x${i}` }));
  const started = performance.now();
  client.send({ type: "hello", protocol: PROTOCOL_VERSION, visible: true, cards: bogus });
  await client.sync();
  expect(performance.now() - started).toBeLessThan(2_000);
  const refused = client.frames.slice(from).filter((frame) => frame.type === "card");
  expect(refused).toHaveLength(32);
  expect(refused[0]).toEqual({ type: "card", id: "x0", error: "unknown ticket x0" });

  // A frame past 64 KiB is not read at all: the socket is cut.
  client.send({
    type: "hello",
    protocol: PROTOCOL_VERSION,
    visible: true,
    cards: [{ id: "x".repeat(70 * 1024) }],
  });
  expect([1006, 1009]).toContain((await client.closed).code);
});

// engine/ws.test.ts:862
conformance(
  "protocol",
  "cards › refuses a card it cannot read without holding it, and reads it afresh once it can",
  async (t) => {
    if (process.getuid?.() === 0) return; // root reads a file chmod 000 anyway
    const world = poolWorld(t, ["01", "02"]);
    const server = await t.start(world);
    await interruptFor(server, REVIEW);
    const issue = join(world.pool, "issues", "02-a.md");
    chmodSync(issue, 0o000);
    try {
      const first = await t.socket(server, { visible: true, cards: [{ id: "02" }, { id: "01" }] });
      const refusal = await cardOf(first, "02");
      expect(refusal.error).toContain("could not be read");
      const whole = await cardOf(first, "01");
      expect(whole.body).toEqual({ id: "01", body: "# body\n" });
      expect(whole.events).not.toBeNull();
      expect(whole.events).toBeDefined();
    } finally {
      chmodSync(issue, 0o644);
    }

    const later = await t.socket(server, { visible: true, cards: [{ id: "02" }] });
    const card = await cardOf(later, "02");
    expect(card.body).toEqual({ id: "02", body: "# body\n" });
    expect(card.events?.events.map((event) => event.kind)).toContain("spawned");
  },
);

// engine/ws.test.ts:899
conformance("protocol", "cards › leaves each event's logTail out of a card, and keeps it in GET /api/events", async (t) => {
  const { server } = await finishedPool(t);
  const http = (await server.http.get("/api/events?ticket=01")).json<{
    events: { kind: string; payload: Record<string, unknown> }[];
  }>();
  expect(http.events.some((event) => "logTail" in event.payload)).toBe(true);

  const client = await t.socket(server, { visible: true, cards: [{ id: "01" }] });
  const card = await cardOf(client, "01");
  const events = card.events!.events;
  expect(events.some((event) => "logTail" in event.payload)).toBe(false);
  expectParsedEqual(
    events,
    http.events.map(({ payload: { logTail: _logTail, ...payload }, ...event }) => ({ ...event, payload })),
    "the card's events",
  );
});

// engine/ws.test.ts:921
conformance("protocol", "cards › never splits an escape sequence across two appends", async (t) => {
  const { world, server } = await finishedPool(t);
  const client = await t.socket(server, { visible: true, cards: [{ id: "01" }] });
  const card = await cardOf(client, "01");
  const window = card.log as LogPush;
  const logFile = logPath(world, window);
  const appended = (from: number) =>
    cardOf(client, "01", { from, what: "an append", has: (frame) => frame.log?.mode === "append" });

  let from = client.frames.length;
  appendFileSync(logFile, "red \x1b[38;5");
  const first = await appended(from);
  expect(first.log).toMatchObject({ content: "red ", nextOffset: window.nextOffset + 4 });
  // GET /api/log's forward read stops at the same place.
  const http = (await server.http.get(`/api/log?ticket=01&offset=${window.nextOffset}`)).json<TicketLogResponse>();
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

// engine/ws.test.ts:954
conformance("protocol", "cards › holds a hidden socket's appends, and catches it up when it shows", async (t) => {
  const { world, server } = await finishedPool(t);
  const client = await t.socket(server, { visible: true, cards: [{ id: "01" }] });
  const card = await cardOf(client, "01");
  const window = card.log as LogPush;
  const logFile = logPath(world, window);

  client.send({ type: "visibility", visible: false });
  await client.sync();
  const hiddenFrom = client.frames.length;
  appendFileSync(logFile, "while hidden\n");
  await Bun.sleep(300);
  await client.sync();
  expect(client.frames.slice(hiddenFrom).filter(isCard("01"))).toEqual([]);

  client.send({ type: "visibility", visible: true });
  const append = await cardOf(client, "01", {
    from: hiddenFrom,
    what: "the held append",
    has: (frame) => frame.log?.mode === "append",
  });
  expect(append.log).toMatchObject({ offset: window.nextOffset, content: "while hidden\n" });
});

// engine/ws.test.ts:977
conformance(
  "protocol",
  "cards › points a card's appends at another attempt with log.follow, and reads any range with log.read",
  async (t) => {
    const world = poolWorld(t, ["01"]);
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    const server = await t.start(world);
    await interruptFor(server, "01");
    await answer(server, "01", "resume");
    await interruptFor(server, REVIEW);
    const client = await t.socket(server, { visible: true, cards: [{ id: "01" }] });
    const card = await cardOf(client, "01");
    // Following the latest attempt, the second.
    expect((card.log as LogPush).attempt).toBe(2);
    const [first, second] = (card.log as LogPush).attempts!;
    writeFileSync(join(world.pool, "runs", first!.logFile), "attempt one\n");

    const followed = await client.request("log.follow", { id: "01", attempt: 1, stream: false });
    expect(followed.ok).toBe(true);
    const tail = (followed as Extract<typeof followed, { ok: true }>).result;
    expect(tail.content).toBe("attempt one\n");
    // The same read as GET /api/log's tail, named by what it was read from.
    const http = (await server.http.get("/api/log?ticket=01&attempt=1&offset=0")).json<TicketLogResponse>();
    expect(tail).toEqual({ ...http, attempt: 1, stream: false });

    // A follow of the latest attempt says which attempt that resolved to.
    const latest = await client.request("log.follow", { id: "01", attempt: null, stream: false });
    expect(latest).toMatchObject({ ok: true, result: { attempt: 2, stream: false } });
    await client.request("log.follow", { id: "01", attempt: 1, stream: false });

    // Appends now follow the first attempt, and not the second.
    const from = client.frames.length;
    appendFileSync(join(world.pool, "runs", second!.logFile), "attempt two\n");
    appendFileSync(join(world.pool, "runs", first!.logFile), "one more\n");
    const append = await cardOf(client, "01", {
      from,
      what: "the first attempt's append",
      has: (frame) => frame.log?.mode === "append",
    });
    expect(append.log).toMatchObject({ attempt: 1, offset: tail.nextOffset, content: "one more\n" });
    await Bun.sleep(200);
    await client.sync();
    expect(client.frames.slice(from).filter(isCard("01", (frame) => frame.log?.attempt === 2))).toEqual([]);

    // log.read changes nothing it follows, and reads what GET /api/log does.
    const read = await client.request("log.read", { id: "01", attempt: 2, offset: 0 });
    const httpRead = (await server.http.get("/api/log?ticket=01&attempt=2&offset=0")).json<TicketLogResponse>();
    expect(read).toMatchObject({ ok: true, result: httpRead });
    expect(httpRead.content).toContain("attempt two\n");
  },
);

// ---------------------------------------------------------------------------
// the live check
// ---------------------------------------------------------------------------

// engine/ws.test.ts:1032
conformance(
  "protocol",
  "the live check › sends a hidden socket no live values, and the whole of them when it shows",
  async (t) => {
    const world = poolWorld(t, ["01"]);
    const release = join(world.root, "release");
    holdClaude(world, release);
    const server = await t.start(world);
    const hidden = await t.socket(server, { visible: false });
    await hidden.sync();
    const shown = await t.socket(server, { visible: true });
    await shown.sync();

    const live = await shown.waitFor<Live>((frame) => frame.type === "live" && frame.activity?.["01"] !== undefined, {
      what: "01's activity on the visible socket",
      ms: 15_000,
    });
    expect(live.activity?.["01"]).toMatchObject({ ticketId: "01", running: true });
    // Everything the check sent the visible socket is sent by now.
    await hidden.sync();
    expect(framesOf(hidden, "live").filter((frame) => frame.activity || frame.peeks)).toEqual([]);

    const from = hidden.frames.length;
    hidden.send({ type: "visibility", visible: true });
    const whole = await hidden.waitFor<Live>((frame) => frame.type === "live", {
      from,
      what: "the live cache on showing",
    });
    // The cache whole: the activity the visible socket was last sent.
    await shown.sync();
    const sent = framesOf(shown, "live")
      .map((frame) => frame.activity?.["01"])
      .filter((activity) => activity !== undefined);
    expect(sent).toContainEqual(whole.activity!["01"]!);

    writeFileSync(release, "go");
    await interruptFor(server, REVIEW);
  },
  { timeoutMs: 90_000 },
);

// engine/ws.test.ts:1068
conformance(
  "protocol",
  "the live check › peeks a new pane at once, and pushes its text again only when it moves",
  async (t) => {
    const world = poolWorld(t, ["01"], { ...CLAUDE, terminal: "herdr" });
    const release = join(world.root, "release");
    holdClaude(world, release);
    const herdr = await t.herdr(world, { rendered: `${CLAUDE_READY}2.1\n❯ ` });
    const server = await t.start(world, { herdr });
    const client = await t.socket(server);
    await client.sync();

    // The frame whose push first put 01's pane on the socket.
    const paneOf = (held: PushedSnapshot | null) =>
      held?.snapshot.state.tickets.find((ticket) => ticket.id === "01")?.liveAttempt?.paneId;
    await until(() => paneOf(client.pushed), (pane) => typeof pane === "string", {
      what: "01's pane on the socket",
      ms: 30_000,
    });
    const paneId = paneOf(client.pushed)!;
    let added = 0;
    while (paneOf(heldBefore(client.frames, added + 1)) !== paneId) added++;
    const first = await client.waitFor<Live>((frame) => frame.type === "live" && frame.peeks?.["01"] !== undefined, {
      from: added,
      what: "01's first peek",
    });
    expect(first.peeks?.["01"]).toMatchObject({ ticket: "01", paneId });
    // A push that adds a pane runs the check at once, not on the 2 s timer.
    const waited = client.times[client.frames.indexOf(first)]! - client.times[added]!;
    expect(waited).toBeLessThan(1_000);

    // The pane's text moves: the next check pushes it, and only it.
    const movedFrom = client.frames.length;
    await herdr.control("setPaneContent", paneId, "working");
    const moved = await client.waitFor<Live>(
      (frame) => frame.type === "live" && frame.peeks?.["01"] !== undefined,
      { from: movedFrom, what: "01's moved peek", ms: 5_000 },
    );
    expect(moved.peeks?.["01"]).toEqual({ ticket: "01", paneId, text: "working" });
    await Bun.sleep(2_200);
    await client.sync();
    const lives = framesOf(client, "live");
    expect(lives.slice(lives.indexOf(moved) + 1).filter((frame) => frame.peeks?.["01"] !== undefined)).toEqual([]);

    writeFileSync(release, "go");
  },
  { timeoutMs: 90_000 },
);

// ---------------------------------------------------------------------------
// the stop
// ---------------------------------------------------------------------------

// engine/ws.test.ts:1121
conformance("server", "the stop › replies, sends the `stopped` delta, then closes 1000 stopped", async (t) => {
  const { world, server } = await finishedPool(t);
  const client = await t.socket(server);
  await client.sync();

  const reply = await client.request("stop", {});
  expect(reply).toMatchObject({ ok: true, result: { stopping: true } });
  expect(await client.closed).toEqual(CLOSE_STOPPED);
  // The farewell is the last delta, behind the reply.
  const deltas = framesOf(client, "delta");
  expect(deltas.at(-1)?.delta.set?.phase).toBe("stopped");
  expect(client.frames.indexOf(deltas.at(-1)!)).toBeGreaterThan(client.frames.indexOf(reply));
  expect(client.pushed?.snapshot.poolDir).toBe(world.pool);

  // The process exits 0 on its own, the pool lock released (stop() checks
  // both of a server that has already exited), and nothing answers.
  await until(() => server.exited(), (gone) => gone, { what: "the server to exit", ms: 20_000 });
  await server.stop();
  await expect(fetch(`${server.url}/api/state`)).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// the served page
// ---------------------------------------------------------------------------

// engine/ws.test.ts:1142
conformance(
  "http",
  "the served page › embeds the boot snapshot the socket's first frames repeat",
  async (t) => {
    const world = poolWorld(t, ["01"]);
    const server = await t.start(world);
    await interruptFor(server, REVIEW);

    const embed = new RegExp(`<script id="${EMBED_ELEMENT_ID}" type="application/json">(.*?)</script></head>`, "s");
    const bootOf = async (path: string) => {
      const res = await server.http.get(path);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toContain("text/html");
      const match = embed.exec(res.text);
      expect(match).not.toBeNull();
      return JSON.parse(match![1]!) as {
        protocol: number;
        epoch: string;
        rev: number;
        logTotal: number;
        snapshot: Snapshot | null;
      };
    };

    const boot = await bootOf("/");
    expect(boot.protocol).toBe(PROTOCOL_VERSION);
    expect(typeof boot.epoch).toBe("string");
    expect(boot.snapshot?.seq).toBe((await state(server)).seq);
    expect(await bootOf("/index.html")).toEqual(boot);

    // The socket opened from that page starts at the same epoch and
    // revision, so the Console keeps what it painted.
    const client = await t.socket(server);
    await client.waitFor((frame) => frame.type === "snapshot", { what: "the snapshot" });
    expect((client.frames[0] as { epoch: string }).epoch).toBe(boot.epoch);
    expect(client.rev).toBe(boot.rev);
    expect(client.pushed?.logTotal).toBe(boot.logTotal);
    expect(client.pushed?.snapshot).toEqual(boot.snapshot!);
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// GET /api/pool-log
// ---------------------------------------------------------------------------

// engine/ws.test.ts:1184
conformance("http", "GET /api/pool-log › serves the pool log's lines before a line, as many as asked up to the cap", async (t) => {
  const { server } = await finishedPool(t, ["01", "02", "03"]);
  const log = (await state(server)).state.log;
  expect(log.length).toBeGreaterThan(4);
  const get = async (query: string) => {
    const res = await server.http.get(`/api/pool-log?${query}`);
    return { status: res.status, body: res.json() };
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

// ---------------------------------------------------------------------------
// socket and HTTP parity
// ---------------------------------------------------------------------------

type Twin = { method: "GET" | "POST" | "PUT"; path: string; body?: unknown };

/** One kind asked on the socket and over its HTTP twin, compared. */
async function parity<K extends RequestKind>(
  client: SocketClient,
  socketServer: CaseServer,
  httpServer: CaseServer,
  kind: K,
  payload: RequestPayload<K>,
  twin: Twin,
  seen: Set<string>,
): Promise<void> {
  const reply = await client.request(kind, payload);
  const res = await httpServer.http.call(twin.method, twin.path, twin.body);
  const body = res.json<Record<string, unknown>>();
  if (reply.ok) {
    expect(`${kind} ${res.status < 300}`).toBe(`${kind} true`);
    const { snapshot: _snapshot, ...rest } = body;
    let result: unknown = reply.result;
    if (reply.kind === "log.follow") {
      // The follow's reply names the attempt and variant it read, which its
      // HTTP twin, a plain read of the same tail, does not.
      const { attempt, stream, ...window } = reply.result as { attempt: unknown; stream: unknown };
      expect({ attempt, stream }).toEqual({ attempt: 1, stream: false });
      result = window;
    }
    if (reply.kind === "restart") {
      // Each names the port its own server relaunches on.
      expect(result).toEqual({ ok: true, port: socketServer.port });
      expect(rest).toEqual({ ok: true, port: httpServer.port });
    } else {
      expect([kind, result]).toEqual([kind, rest]);
    }
  } else {
    expect([kind, reply.refusal]).toEqual([kind, { reason: (body.error ?? body.reason) as string, status: res.status }]);
  }
  seen.add(`${kind}:${reply.ok ? "ok" : reply.refusal.status}`);
}

/** An `agent-console` first on the world's PATH that only records it ran: the Restart's
 *  hand-off to Boot, which would otherwise start a server the case does not own. */
function stubBoot(world: World): void {
  writeFileSync(join(world.stubs.bin, "agent-console"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(world.root, "boot-handoff"))}\n`);
  chmodSync(join(world.stubs.bin, "agent-console"), 0o755);
}

// engine/ws.test.ts:1223
conformance(
  "protocol",
  "socket and HTTP parity › answers every request kind as its HTTP twin does",
  async (t) => {
    const { server } = await finishedPool(t, ["01", "02"]);
    const client = await t.socket(server);
    await client.sync();
    const logTotal = (await state(server)).state.log.length;

    const cases: { [K in Exclude<RequestKind, "stop" | "restart">]: [RequestPayload<K>, Twin] } = {
      start: [{}, { method: "POST", path: "/api/start" }],
      resume: [
        { ticketId: "02", action: "resume" },
        { method: "POST", path: "/api/resume", body: { ticketId: "02", action: "resume" } },
      ],
      keepTalking: [{ ticketId: "01" }, { method: "POST", path: "/api/keep-talking", body: { ticketId: "01" } }],
      "terminal.focus": [{ ticketId: "01" }, { method: "POST", path: "/api/terminal/focus?ticket=01" }],
      "terminals.closeFinished": [{}, { method: "POST", path: "/api/terminals/close-finished" }],
      enlist: [
        { becomes: "ticket", paneId: "p1", title: "t", spec: "s" },
        { method: "POST", path: "/api/enlist", body: { becomes: "ticket", paneId: "p1", title: "t", spec: "s" } },
      ],
      reassign: [
        { tickets: ["nope"], fields: { model: "x" } },
        { method: "PUT", path: "/api/reassign", body: { tickets: ["nope"], fields: { model: "x" } } },
      ],
      "spawns.held.adopt": [{ id: "nope" }, { method: "POST", path: "/api/spawns/held/adopt", body: { id: "nope" } }],
      "spawns.held.discard": [{ id: "nope" }, { method: "POST", path: "/api/spawns/held/discard", body: { id: "nope" } }],
      "spawns.pending.hold": [{ id: "nope" }, { method: "POST", path: "/api/spawns/pending/hold", body: { id: "nope" } }],
      "spawns.pending.discard": [
        { id: "nope" },
        { method: "POST", path: "/api/spawns/pending/discard", body: { id: "nope" } },
      ],
      "conversations.start": [{ title: "talk" }, { method: "POST", path: "/api/conversations", body: { title: "talk" } }],
      "conversations.end": [{ id: "nope" }, { method: "POST", path: "/api/conversations/end", body: { id: "nope" } }],
      "settings.get": [{}, { method: "GET", path: "/api/settings" }],
      "settings.pool.put": [
        { config: { title: "Parity" } },
        { method: "PUT", path: "/api/settings/pool", body: { config: { title: "Parity" } } },
      ],
      "settings.machine.put": [{ defaults: {} }, { method: "PUT", path: "/api/settings/machine", body: { defaults: {} } }],
      "panes.list": [{}, { method: "GET", path: "/api/panes" }],
      "log.read": [{ id: "01", offset: 0 }, { method: "GET", path: "/api/log?ticket=01&offset=0" }],
      // A tail read: the file is under a window long, so it starts at 0.
      "log.follow": [{ id: "01", attempt: null, stream: false }, { method: "GET", path: "/api/log?ticket=01&offset=0" }],
      "poolLog.read": [
        { before: logTotal, limit: 3 },
        { method: "GET", path: `/api/pool-log?before=${logTotal}&limit=3` },
      ],
    };

    const seen = new Set<string>();
    for (const [kind, [payload, twin]] of Object.entries(cases) as [RequestKind, [RequestPayload<RequestKind>, Twin]][]) {
      await parity(client, server, server, kind, payload, twin, seen);
    }

    // Stop and Restart each end the server they are asked of, so each is
    // asked of two servers in the same state: one on the socket, one over
    // HTTP. Stop on finished pools; Restart (any phase) with Boot stubbed.
    const [stopSocket, stopHttp] = await Promise.all([finishedPool(t), finishedPool(t)]);
    const stopClient = await t.socket(stopSocket.server);
    await parity(stopClient, stopSocket.server, stopHttp.server, "stop", {}, { method: "POST", path: "/api/stop" }, seen);

    const restartWorlds = [poolWorld(t, ["01"]), poolWorld(t, ["01"])];
    for (const world of restartWorlds) stubBoot(world);
    const [restartSocket, restartHttp] = await Promise.all(restartWorlds.map((world) => t.start(world)));
    await Promise.all([interruptFor(restartSocket!, REVIEW), interruptFor(restartHttp!, REVIEW)]);
    const restartClient = await t.socket(restartSocket!);
    await parity(restartClient, restartSocket!, restartHttp!, "restart", {}, { method: "POST", path: "/api/restart" }, seen);

    // Every server asked to end does, cleanly.
    for (const ended of [stopSocket.server, stopHttp.server, restartSocket!, restartHttp!]) {
      await until(() => ended.exited(), (gone) => gone, { what: "the asked server to exit", ms: 20_000 });
      await ended.stop();
    }

    // Both shapes are exercised: answers and refusals of several classes.
    expect([...seen].filter((s) => s.endsWith(":ok")).length).toBeGreaterThan(5);
    expect(new Set([...seen].map((s) => s.split(":")[1]))).toEqual(new Set(["ok", "400", "404", "409"]));
  },
  { timeoutMs: 180_000 },
);
