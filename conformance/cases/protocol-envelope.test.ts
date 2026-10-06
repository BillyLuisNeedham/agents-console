/**
 * The socket's envelope, seen from outside the server (ADR-0036): a request
 * and its reply, frames that are not this protocol's, and replies kept to
 * the socket that asked. Ported from the envelope cases of
 * engine/protocol.test.ts (since moved to ui/src/protocol.test.ts, each case
 * two lines below the line cited), which decoded frames in process; here a
 * real server is sent them. Two cases are the inventory's gaps beside
 * engine/ws.ts.
 */

import { expect } from "bun:test";
import type { ServerMessage } from "../../protocol/protocol.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { expectParsedEqual } from "../harness/equal.ts";
import { approveReview, doneTicket, snapshotOf } from "./config-support.ts";
import { CLAUDE, REVIEW, deltasFrom, interruptFor } from "./protocol-support.ts";

type Reply = Extract<ServerMessage, { type: "reply" }>;

/** A server on a pool run to its end, phase done: a stop request would stop it. */
async function donePool(t: Case): Promise<CaseServer> {
  const server = await t.start(t.world({ tickets: [doneTicket("01")], config: CLAUDE }));
  await approveReview(server);
  return server;
}

/** The replies a socket got from frame `from` on. */
function repliesFrom(client: SocketClient, from: number): Reply[] {
  return client.frames.slice(from).filter((frame): frame is Reply => frame.type === "reply");
}

/** Whether the server has closed the socket by now. */
async function isClosed(client: SocketClient): Promise<boolean> {
  const now = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0));
  return Promise.race([client.closed.then(() => true), now]);
}

// engine/protocol.test.ts:258
conformance("protocol", "the envelope › round-trips a request and its reply", async (t) => {
  const server = await t.start(t.world({ tickets: [doneTicket("01")], config: CLAUDE }));
  await interruptFor(server, REVIEW);
  const client = await t.socket(server);
  await client.sync();
  const from = client.frames.length;

  // The client numbers its requests; the reply carries the number back, with
  // the kind, the revision the socket was at, and the refusal.
  client.send({ type: "request", id: 3, kind: "terminal.focus", payload: { ticketId: "01" } });
  const reply = await client.waitFor<Reply>((frame) => frame.type === "reply" && frame.id === 3, {
    from,
    what: "the reply to request 3",
  });
  expectParsedEqual(
    reply,
    {
      type: "reply",
      id: 3,
      kind: "terminal.focus",
      rev: client.rev,
      ok: false,
      refusal: { reason: "no terminal-backed pane for ticket 01", status: 404 },
    },
    "the reply",
  );
  // Its HTTP twin refuses alike.
  const twin = await server.http.post("/api/terminal/focus?ticket=01");
  expect([twin.status, twin.json()]).toEqual([404, { error: "no terminal-backed pane for ticket 01" }]);
});

// engine/protocol.test.ts:276
conformance("protocol", "the envelope › refuses what is not this protocol's", async (t) => {
  const server = await donePool(t);
  const client = await t.socket(server);
  await client.sync();
  const from = client.frames.length;

  client.sendRaw("not json");
  client.sendRaw("[]");
  client.sendRaw(JSON.stringify({ type: "nope" }));
  client.sendRaw(JSON.stringify({ type: "request", id: 1, kind: "rm -rf", payload: {} }));
  // A stop with no id: were it run, this finished pool would stop.
  client.sendRaw(JSON.stringify({ type: "request", kind: "stop", payload: {} }));
  client.sendRaw(JSON.stringify({ type: "subscribe" }));

  // None is answered, the socket stays open, and the next request is.
  const reply = await client.request("settings.get", {});
  expect(reply.ok).toBe(true);
  expect(client.frames.slice(from).filter((frame) => frame.type === "reply" || frame.type === "card")).toEqual([reply]);
  expect(await isClosed(client)).toBe(false);
  expect((await snapshotOf(server)).phase).toBe("done");
  expect(server.exited()).toBe(false);
});

// The gap at engine/ws.ts:1114
conformance(
  "protocol",
  "the envelope › replies to no binary frame, unknown kind or negative id, and answers the next request",
  async (t) => {
    const server = await donePool(t);
    const client = await t.socket(server);
    await client.sync();
    const from = client.frames.length;

    client.sendRaw("not json");
    // A stop the server would take, were it sent as text: this finished pool
    // would stop.
    client.sendRaw(new TextEncoder().encode(JSON.stringify({ type: "request", id: 9, kind: "stop", payload: {} })));
    client.sendRaw(JSON.stringify({ type: "request", id: 5, kind: "bogus", payload: {} }));
    client.sendRaw(JSON.stringify({ type: "request", id: -1, kind: "stop", payload: {} }));
    client.send({ type: "request", id: 6, kind: "poolLog.read", payload: { before: 0 } });

    const reply = await client.waitFor<Reply>((frame) => frame.type === "reply" && frame.id === 6, {
      from,
      what: "the poolLog.read reply",
    });
    expect(reply).toMatchObject({ kind: "poolLog.read", ok: true });
    expect(repliesFrom(client, from)).toEqual([reply]);
    expect(await isClosed(client)).toBe(false);
    // Nothing stopped the pool: the server is up, its pool still done.
    expect((await snapshotOf(server)).phase).toBe("done");
    expect(server.exited()).toBe(false);
  },
);

// The gap at engine/ws.ts:1081
conformance(
  "protocol",
  "requests › answers each socket's request under its own id, and sends every socket the delta",
  async (t) => {
    const server = await t.start(t.world({ tickets: [doneTicket("01")], config: CLAUDE }));
    await interruptFor(server, REVIEW);
    const a = await t.socket(server);
    const b = await t.socket(server);
    // Each socket's first request is its id 1.
    await a.waitFor((frame) => frame.type === "snapshot", { what: "A's snapshot" });
    await b.waitFor((frame) => frame.type === "snapshot", { what: "B's snapshot" });
    const fromA = a.frames.length;
    const fromB = b.frames.length;

    const put = await a.request("settings.pool.put", { config: { title: "Renamed" } });
    expect(put).toMatchObject({ id: 1, kind: "settings.pool.put", ok: true });
    const got = await b.request("settings.get", {});
    expect(got).toMatchObject({
      id: 1,
      kind: "settings.get",
      ok: true,
      result: { pool: { config: { title: "Renamed" } } },
    });
    await a.sync();
    await b.sync();

    // Both were sent the delta carrying the new title.
    for (const [name, client, from] of [["A", a, fromA], ["B", b, fromB]] as const) {
      const titled = deltasFrom(client, from).filter((delta) => delta.set?.poolTitle !== undefined);
      expect([name, titled.map((delta) => delta.set?.poolTitle)]).toEqual([name, ["Renamed"]]);
    }
    // Each got only its own replies: A never B's settings.get, B never A's put.
    expect(repliesFrom(a, fromA).map((reply) => [reply.id, reply.kind])).toEqual([
      [1, "settings.pool.put"],
      [2, "poolLog.read"],
    ]);
    expect(repliesFrom(b, fromB).map((reply) => [reply.id, reply.kind])).toEqual([
      [1, "settings.get"],
      [2, "poolLog.read"],
    ]);
  },
);
