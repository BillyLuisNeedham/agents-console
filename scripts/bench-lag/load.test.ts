import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeClientMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  WS_PATH,
  type ClientMessage,
} from "../../engine/protocol.ts";
import { ConnectionPool, detectProtocol, Tab } from "./load.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** A server that speaks just enough of the push protocol, and keeps what it was sent. */
function socketServer(options: { refuseFocus?: boolean } = {}) {
  const received: ClientMessage[] = [];
  const sockets = new Set<Bun.ServerWebSocket<unknown>>();
  let rev = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname === WS_PATH && srv.upgrade(req)) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(encodeMessage({ type: "hello", protocol: PROTOCOL_VERSION, epoch: "e", heartbeatMs: 20_000 }));
        ws.send(encodeMessage({ type: "snapshot", rev, logTotal: 0, snapshot: null }));
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, data) {
        const m = decodeClientMessage(String(data));
        received.push(m);
        if (m.type === "subscribe") ws.send(encodeMessage({ type: "card", id: m.card.id, body: null, log: null }));
        if (m.type === "request" && m.kind === "terminal.focus") {
          ws.send(
            encodeMessage(
              options.refuseFocus
                ? { type: "reply", id: m.id, kind: m.kind, rev, ok: false, refusal: { reason: "no pane", status: 409 } }
                : { type: "reply", id: m.id, kind: m.kind, rev, ok: true, result: { ok: true, paneId: "p1" } },
            ),
          );
        }
      },
    },
  });
  servers.push(server);
  const push = () => {
    for (const ws of sockets) ws.send(encodeMessage({ type: "delta", delta: { base: rev, rev: rev + 1, set: {} } }));
    rev++;
  };
  return { base: `http://127.0.0.1:${server.port}`, received, push };
}

describe("detectProtocol", () => {
  test("a server whose socket says hello speaks the push protocol", async () => {
    expect(await detectProtocol(socketServer().base)).toBe("ws");
  });

  test("a server with only an SSE stream speaks the old one", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname !== "/api/stream") return new Response("not found", { status: 404 });
        // As the old server does, the stream opens with its snapshot.
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: {"snapshot":null}\n\n'));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    expect(await detectProtocol(`http://127.0.0.1:${server.port}`)).toBe("sse");
  });

  test("a server that serves neither is an error, not a guess", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("nope", { status: 404 }) });
    servers.push(server);
    await expect(detectProtocol(`http://127.0.0.1:${server.port}`)).rejects.toThrow(/neither/);
  });
});

describe("a tab over the socket", () => {
  test("says hello visible with its selected card, and sends nothing on its own after", async () => {
    const fake = socketServer();
    const tab = new Tab(fake.base, new ConnectionPool(6), "07", "ws");
    await tab.open();
    await Bun.sleep(300);
    expect(fake.received).toEqual([{ type: "hello", protocol: PROTOCOL_VERSION, visible: true, cards: [{ id: "07" }] }]);
    tab.close();
  });

  test("a click leaves the old card, subscribes the new one and lasts until its card frame", async () => {
    const fake = socketServer();
    const tab = new Tab(fake.base, new ConnectionPool(6), "07", "ws");
    await tab.open();
    const click = await tab.click("03");
    expect(fake.received.slice(1)).toEqual([
      { type: "unsubscribe", id: "07" },
      { type: "subscribe", card: { id: "03" } },
    ]);
    expect(click.requests).toBe(1);
    expect(click.queuedMs).toBe(0);
    expect(tab.stats.unanswered).toBe(0);
    tab.close();
  });

  test("Open in herdr is a terminal.focus request, its reply's status the HTTP twin's", async () => {
    const ok = socketServer();
    const tab = new Tab(ok.base, new ConnectionPool(6), null, "ws");
    await tab.open();
    expect((await tab.focus("13")).status).toBe(200);
    expect(ok.received.at(-1)).toEqual({ type: "request", id: 1, kind: "terminal.focus", payload: { ticketId: "13" } });
    tab.close();

    const refused = socketServer({ refuseFocus: true });
    const other = new Tab(refused.base, new ConnectionPool(6), null, "ws");
    await other.open();
    expect((await other.focus("13")).status).toBe(409);
    other.close();
  });

  test("while recording, every snapshot and delta counts as a snapshot and every frame by type", async () => {
    const fake = socketServer();
    const tab = new Tab(fake.base, new ConnectionPool(6), null, "ws");
    await tab.open();
    await Bun.sleep(100);
    tab.record(true);
    fake.push();
    fake.push();
    await tab.focus("13");
    tab.record(false);
    expect(tab.stats.snapshots).toBe(2);
    expect(tab.stats.frames.delta?.count).toBe(2);
    expect(tab.stats.frames.reply?.count).toBe(1);
    expect(tab.stats.frames.hello).toBeUndefined();
    tab.close();
  });
});
