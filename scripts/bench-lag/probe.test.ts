/**
 * The lag bench's page probe (ui/probe.ts) in a real headless Chromium,
 * against a page small enough to know exactly what it does: a socket that
 * speaks the push protocol, a card that draws its Detail in the click's own
 * handler, a card that waits two frames to, and an Open in herdr button.
 * Skipped on a machine with no Chromium or Chrome (chromium.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeClientMessage, encodeMessage, PROTOCOL_VERSION, WS_PATH } from "../../engine/protocol.ts";
import { findChromium } from "./chromium.ts";
import {
  cardFrameAfter,
  ConsoleBrowser,
  focusRoundTrip,
  subscribedAt,
  type BrowserTab,
  type ProbeReport,
} from "./e2e.ts";

const chromium = findChromium();

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body style="margin:0">
<div id="app">
  <div class="canvas-viewport" style="position:absolute;left:0;top:0;width:900px;height:700px">
    <div class="node-card" data-node-id="ticket:07" style="position:absolute;left:100px;top:100px;width:220px;height:120px">card 07
      <div class="terminal-row" style="position:absolute;left:10px;bottom:10px"><button class="btn terminal-focus">Open in herdr</button></div>
    </div>
    <div class="node-card" data-node-id="ticket:08" style="position:absolute;left:400px;top:100px;width:220px;height:120px">card 08</div>
  </div>
  <div id="detail" style="position:absolute;left:950px;top:0;width:300px;height:700px"></div>
</div>
<script>
  const socket = new WebSocket("ws://" + location.host + "${WS_PATH}");
  socket.onopen = () => socket.send(JSON.stringify({ type: "hello", protocol: ${PROTOCOL_VERSION}, visible: true, cards: [] }));
  socket.onmessage = (event) => {
    if (JSON.parse(event.data).type !== "reply") return;
    const note = document.createElement("span");
    note.className = "terminal-note";
    note.textContent = "focused in herdr";
    document.querySelector('[data-node-id="ticket:07"] .terminal-row').appendChild(note);
  };
  const showDetail = (id) =>
    (document.getElementById("detail").innerHTML =
      '<div class="detail-open"><div class="detail-title">' + id + '</div><div class="detail-tab-active">Outcome</div></div>');
  document.querySelector('[data-node-id="ticket:07"]').addEventListener("click", (event) => {
    if (event.target.closest(".terminal-focus")) return;
    socket.send(JSON.stringify({ type: "subscribe", card: { id: "07" } }));
    showDetail("07");
  });
  document.querySelector('[data-node-id="ticket:08"]').addEventListener("click", () =>
    requestAnimationFrame(() => requestAnimationFrame(() => showDetail("08"))),
  );
  document.querySelector(".terminal-focus").addEventListener("click", (event) => {
    event.target.textContent = "opening...";
    socket.send(JSON.stringify({ type: "request", id: 1, kind: "terminal.focus", payload: { ticketId: "07" } }));
  });
  fetch("/ping");
</script></body></html>`;

let server: ReturnType<typeof Bun.serve> | null = null;
let browser: ConsoleBrowser | null = null;
let tab: BrowserTab | null = null;
let profile = "";

async function until<T>(what: string, probe: () => Promise<T | null | false | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const evaluate = <T>(expression: string) => browser!.evaluate<T>(tab!, expression);
const report = () => evaluate<ProbeReport>("window.__lagProbe.report()");

describe.skipIf(!chromium)("the page probe in Chromium", () => {
  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const path = new URL(req.url).pathname;
        if (path === WS_PATH && srv.upgrade(req, { data: undefined })) return undefined;
        if (path === "/ping") return new Response("pong");
        return new Response(PAGE, { headers: { "content-type": "text/html" } });
      },
      websocket: {
        open(ws) {
          ws.send(encodeMessage({ type: "hello", protocol: PROTOCOL_VERSION, epoch: "test", heartbeatMs: 20_000 }));
          ws.send(encodeMessage({ type: "snapshot", rev: 0, logTotal: 0, snapshot: null }));
        },
        message(ws, data) {
          const m = decodeClientMessage(String(data));
          if (m.type === "subscribe") ws.send(encodeMessage({ type: "card", id: m.card.id, body: null, log: null }));
          if (m.type === "request" && m.kind === "terminal.focus") {
            ws.send(encodeMessage({ type: "reply", id: m.id, kind: m.kind, rev: 0, ok: true, result: { ok: true, paneId: "p1" } }));
          }
        },
      },
    });
    profile = mkdtempSync(join(tmpdir(), "bench-probe-"));
    browser = await ConsoleBrowser.launch({ profileDir: profile, chromium: chromium! });
    tab = await browser.open(`http://127.0.0.1:${server.port}/`);
    await until("the page's socket to say hello", async () => {
      const r = await evaluate<ProbeReport | null>("window.__lagProbe && document.querySelector('.node-card') ? window.__lagProbe.report() : null");
      return r?.socketFrames.some((f) => f.dir === "out" && f.type === "hello") ?? false;
    });
    await evaluate("window.__lagProbe.begin()");
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  const press = async (expression: string) => {
    const at = await evaluate<{ x: number; y: number; park: { x: number; y: number } | null } | null>(expression);
    if (!at) throw new Error(`nothing to press for ${expression}`);
    await browser!.click(tab!, at);
    if (at.park) await browser!.move(tab!, at.park);
  };

  test("a Detail drawn in the click's own handler is painted in the first frame after the press", async () => {
    await press(`window.__lagProbe.armClick("07", "cold")`);
    const click = await until("the shell", async () => (await report()).clicks.find((c) => c.id === "07" && c.shellPaintedMs !== null));
    expect(click.missed).toBe(false);
    expect(click.released).not.toBeNull();
    expect(click.shellFrames).toBe(1);
    expect(click.shellPaintedMs).toBeGreaterThan(0);
  }, 20_000);

  test("one drawn two animation frames later is counted as frame 2", async () => {
    await press(`window.__lagProbe.armClick("08", "hover")`);
    const click = await until("the shell", async () => (await report()).clicks.find((c) => c.id === "08" && c.shellPaintedMs !== null));
    expect(click.how).toBe("hover");
    expect(click.shellFrames).toBe(2);
  }, 20_000);

  test("Open in herdr: the button's row changing is the feedback, the note the confirmation", async () => {
    await press(`window.__lagProbe.armFocus("07")`);
    const focus = await until("the confirmation", async () => (await report()).focuses.find((f) => f.confirmedPaintedMs !== null));
    expect(focus.feedbackFrames).toBe(1);
    expect(focus.missed).toBe(false);
  }, 20_000);

  test("every socket frame is counted by direction and type, with its bytes and the ids the bench matches on", async () => {
    await evaluate("window.__lagProbe.end()");
    const r = await report();
    expect(r.sockets).toHaveLength(1);
    expect(new URL(r.sockets[0]!.url).pathname).toBe(WS_PATH);
    const seen = r.socketFrames.map((f) => `${f.dir} ${f.type}${f.kind ? ` ${f.kind}` : ""}${f.id !== undefined ? ` ${f.id}` : ""}`);
    // The page's hello and the server's opening frames race; the rest follow the presses.
    expect(seen.slice(0, 3).sort()).toEqual(["in hello", "in snapshot", "out hello"]);
    expect(seen.slice(3)).toEqual([
      "out subscribe 07",
      "in card 07",
      "out request terminal.focus 1",
      "in reply terminal.focus 1",
    ]);
    const hello = r.socketFrames.find((f) => f.dir === "out" && f.type === "hello")!;
    const helloText = JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, visible: true, cards: [] });
    expect(hello.bytes).toBe(Buffer.byteLength(helloText));
    expect(hello.cards).toEqual([]);
    expect(r.socketFrames.find((f) => f.type === "request")?.ticket).toBe("07");
    expect(r.socketFrames.find((f) => f.type === "reply")?.ok).toBe(true);

    // What the bench reads off them.
    const [click] = r.clicks;
    const [focus] = r.focuses;
    expect(subscribedAt(r.socketFrames, r.sockets, "07", click!.t0!)).toBe(false);
    expect(subscribedAt(r.socketFrames, r.sockets, "07", Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(cardFrameAfter(r.socketFrames, "07", click!.t0!)).not.toBeNull();
    expect(focusRoundTrip(r.socketFrames, "07", focus!.t0!)?.reply).not.toBeNull();
  }, 20_000);

  test("a fetch is counted as it starts and again by its timing entry; frames and the cards shown too", async () => {
    await evaluate("fetch('/ping?late=1').then((res) => res.text())");
    const r = await until("the fetch's timing entry", async () => {
      const now = await report();
      return now.resources.some((x) => x.path === "/ping?late=1") ? now : null;
    });
    expect(r.fetches.map((f) => f.path)).toContain("/ping?late=1");
    expect(r.frames.length).toBeGreaterThan(10);
    expect(r.cardsShown.at(-1)?.cards).toBe(2);
    expect(r.cardsShown.at(-1)?.paintedAt).toBeGreaterThan(0);
  }, 20_000);
});
