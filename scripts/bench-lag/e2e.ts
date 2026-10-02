/**
 * The lag bench's end-to-end half (issues #157, #161): the checkout's real
 * built Console, served by its real pool server, in a real headless
 * Chromium, driven over the Chrome DevTools Protocol, so nothing about the
 * client is modelled. The browser keeps its own connections (six per
 * origin, shared by its tabs; one held by each tab's snapshot stream on a
 * checkout that still has one, a WebSocket per tab on one that speaks the
 * push protocol), the page polls on whatever cadence its build has, if any,
 * and renders however its build renders.
 *
 * This module is the browser side: a small CDP client over Bun's own
 * WebSocket, a launcher for the headless browser, and the statistics over
 * what the page probe (ui/probe.ts, injected before the Console's own code)
 * recorded, down to the samples the gates judge (gates.ts). The bench
 * (scripts/bench-lag.ts --e2e) runs the pool, the server, the round-trip
 * proxy (proxy.ts) and the schedule of presses.
 *
 * Input goes in as CDP mouse events, which the browser delivers through its
 * real input path: a press waits for a busy main thread the way a hand's
 * does, and the canvas sees the pointerdown and pointerup it reads a tap
 * from.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WS_PATH } from "../../engine/protocol.ts";
import { requireChromium } from "./chromium.ts";
import { frameBudget, type FrameBudget, type GateInputs, type IdleTab } from "./gates.ts";

// --- CDP ---------------------------------------------------------------------

type Params = Record<string, unknown>;

/** A Chrome DevTools Protocol connection to the browser, flat sessions. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) return;
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) waiter?.reject(new Error(msg.error.message));
      else waiter?.resolve(msg.result);
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error(`could not reach the browser at ${url}`)));
    });
  }

  send<T = any>(method: string, params: Params = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

// --- the browser -----------------------------------------------------------------

/** One open Console tab: a page target and its CDP session. */
export interface BrowserTab {
  sessionId: string;
  targetId: string;
}

const WIDTH = 1600;
const HEIGHT = 1000;

/** The page probe, its types stripped, ready to inject. */
function probeSource(): string {
  const ts = readFileSync(join(import.meta.dir, "ui", "probe.ts"), "utf8");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(ts);
  return js.replace(/^export \{\};?\s*$/m, "");
}

export class ConsoleBrowser {
  private readonly probe = probeSource();

  private constructor(
    private readonly proc: Bun.Subprocess,
    private readonly cdp: Cdp,
  ) {}

  /**
   * Headless Chromium at real speed, its throttling off so a window nobody
   * looks at keeps full-rate timers and frames, and its debugging port
   * picked by the browser and read back from the profile.
   */
  static async launch(options: { profileDir: string; chromium?: string }): Promise<ConsoleBrowser> {
    const chromium = options.chromium ?? requireChromium();
    const proc = Bun.spawn(
      [
        chromium,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-extensions",
        "--remote-debugging-port=0",
        `--user-data-dir=${options.profileDir}`,
        `--window-size=${WIDTH},${HEIGHT}`,
        "about:blank",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    void new Response(proc.stderr).text().catch(() => {});
    const portFile = join(options.profileDir, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    let port = "";
    while (!port) {
      if (Date.now() > deadline) throw new Error("chromium never opened its debugging port");
      if (existsSync(portFile)) port = readFileSync(portFile, "utf8").split("\n")[0]?.trim() ?? "";
      if (!port) await Bun.sleep(100);
    }
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    return new ConsoleBrowser(proc, await Cdp.connect(version.webSocketDebuggerUrl));
  }

  /** A new window on `url`, the probe in place before the page's own code. */
  async open(url: string): Promise<BrowserTab> {
    const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
      width: WIDTH,
      height: HEIGHT,
    });
    const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    for (const domain of ["Page.enable", "Runtime.enable", "Performance.enable"]) {
      await this.cdp.send(domain, {}, sessionId);
    }
    await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
    await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: this.probe }, sessionId);
    await this.cdp.send("Page.navigate", { url }, sessionId);
    return { sessionId, targetId };
  }

  /** An expression's value in the tab's page. */
  async evaluate<T>(tab: BrowserTab, expression: string): Promise<T> {
    const res = await this.cdp.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, tab.sessionId);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result.value as T;
  }

  /** The pointer, no button down, to a point; where it then rests, it hovers. */
  async move(tab: BrowserTab, at: { x: number; y: number }): Promise<void> {
    const event = { type: "mouseMoved", x: at.x, y: at.y, button: "none", buttons: 0, pointerType: "mouse" };
    await this.cdp.send("Input.dispatchMouseEvent", event, tab.sessionId);
  }

  /** A mouse click as a hand makes one: over the point, press, release. */
  async click(tab: BrowserTab, at: { x: number; y: number }): Promise<void> {
    const base = { x: at.x, y: at.y, button: "left", pointerType: "mouse" };
    await this.move(tab, at);
    await this.cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1, clickCount: 1 }, tab.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0, clickCount: 1 }, tab.sessionId);
  }

  /**
   * Bring the given tickets' cards into view the way an operator would:
   * wheel the canvas out until they fit left of where the Detail opens
   * (its narrowest, 340 px, on the right), then drag the bare canvas to
   * centre them there. Returns whether they fit.
   */
  async frame(tab: BrowserTab, ids: string[]): Promise<boolean> {
    type Layout = {
      found: number;
      bounds: { left: number; top: number; right: number; bottom: number };
      bare: { x: number; y: number }[];
      width: number;
      height: number;
    };
    const layout = () => this.evaluate<Layout>(tab, `window.__lagProbe.layout(${JSON.stringify(ids)})`);
    let l = await layout();
    const region = { left: 20, top: 70, right: l.width - 360, bottom: l.height - 60 };
    for (let i = 0; i < 20; i++) {
      const fits =
        l.bounds.right - l.bounds.left <= region.right - region.left &&
        l.bounds.bottom - l.bounds.top <= region.bottom - region.top;
      if (fits || !l.bare[0]) break;
      const at = l.bare[Math.floor(l.bare.length / 2)]!;
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: 120 }, tab.sessionId);
      l = await layout();
    }
    // Pan in drags no longer than the window lets a press travel.
    for (let i = 0; i < 8; i++) {
      let dx = Math.round((region.left + region.right) / 2 - (l.bounds.left + l.bounds.right) / 2);
      let dy = Math.round((region.top + region.bottom) / 2 - (l.bounds.top + l.bounds.bottom) / 2);
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break;
      let from: { x: number; y: number } | undefined;
      for (;;) {
        from = l.bare.find((p) => p.x + dx > 10 && p.x + dx < l.width - 10 && p.y + dy > 60 && p.y + dy < l.height - 10);
        if (from || (Math.abs(dx) < 4 && Math.abs(dy) < 4)) break;
        dx = Math.round(dx / 2);
        dy = Math.round(dy / 2);
      }
      if (!from) break;
      const s = tab.sessionId;
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none", buttons: 0 }, s);
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 }, s);
      for (let k = 1; k <= 10; k++) {
        const x = Math.round(from.x + (dx * k) / 10);
        const y = Math.round(from.y + (dy * k) / 10);
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }, s);
      }
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x + dx, y: from.y + dy, button: "left", buttons: 0, clickCount: 1 }, s);
      l = await layout();
    }
    return (
      l.found === ids.length &&
      l.bounds.left >= 0 &&
      l.bounds.top >= 0 &&
      l.bounds.right <= region.right + 20 &&
      l.bounds.bottom <= l.height
    );
  }

  /** The renderer's own counters (Performance.getMetrics), durations in ms. */
  async metrics(tab: BrowserTab): Promise<Record<string, number>> {
    const { metrics } = await this.cdp.send<{ metrics: { name: string; value: number }[] }>(
      "Performance.getMetrics",
      {},
      tab.sessionId,
    );
    return Object.fromEntries(
      metrics.map((m) => [m.name, m.name.endsWith("Duration") ? m.value * 1000 : m.value]),
    );
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.cdp.send("Browser.close"), Bun.sleep(2_000)]);
    } catch {
      // Already gone.
    }
    this.cdp.close();
    this.proc.kill("SIGKILL");
    await this.proc.exited;
  }
}

// --- what the probe reports -------------------------------------------------------

export interface ProbeResource {
  path: string;
  start: number;
  requestStart: number;
  responseEnd: number;
}

/** A socket the page opened. */
export interface ProbeSocket {
  url: string;
  opened: number;
  closed: number | null;
}

/** A socket frame's envelope as the probe read it: the payload is left out. */
export interface SocketFrame {
  socket: number;
  dir: "in" | "out";
  at: number;
  bytes: number;
  type: string;
  kind?: string;
  /** A request's or a reply's number; a card's, a subscribe's or an unsubscribe's id. */
  id?: number | string;
  /** The ticket a request names. */
  ticket?: string;
  ok?: boolean;
  /** The cards a client hello subscribes. */
  cards?: string[];
}

export interface ProbeClick {
  id: string;
  how: string;
  t0: number | null;
  released: number | null;
  pressFrame: number | null;
  inputDelayMs: number | null;
  tab: string | null;
  shellMs: number | null;
  shellPaintedMs: number | null;
  shellFrames: number | null;
  dataMs: number | null;
  dataPaintedMs: number | null;
  dataFrames: number | null;
  missed: boolean;
}

export interface ProbeFocus {
  id: string;
  t0: number | null;
  released: number | null;
  pressFrame: number | null;
  inputDelayMs: number | null;
  feedbackPaintedMs: number | null;
  feedbackFrames: number | null;
  confirmedMs: number | null;
  confirmedPaintedMs: number | null;
  missed: boolean;
}

export interface ProbeReport {
  origin: number;
  window: [number, number];
  idle: [number, number];
  longTaskApi: boolean;
  resources: ProbeResource[];
  fetches: { path: string; at: number }[];
  sockets: ProbeSocket[];
  socketFrames: SocketFrame[];
  longTasks: { start: number; duration: number }[];
  longFrames: { start: number; duration: number; blocking: number }[];
  frames: { at: number; mutated: boolean }[];
  batches: { at: number; records: number }[];
  cardsShown: { cards: number; paintedAt: number | null }[];
  clicks: ProbeClick[];
  focuses: ProbeFocus[];
  domNodes: number;
  cards: number;
}

// --- the statistics -----------------------------------------------------------------

export interface Stats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export function stats(values: number[]): Stats {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0);
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    n: s.length,
    mean: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
    p50: round(at(50)),
    p95: round(at(95)),
    max: round(s.at(-1) ?? 0),
  };
}

/** `/api/terminal/peek?ticket=13` → `/api/terminal/peek`. */
function kindOf(path: string): string {
  return path.split("?")[0]!;
}

/**
 * How many of `spans` overlap, over the window: the most at once, the
 * time-weighted mean, and the most in each second.
 */
function overlap(spans: [number, number][], from: number, to: number) {
  const edges: [number, number][] = [];
  for (const [a, b] of spans) {
    const s = Math.max(a, from);
    const e = Math.min(b, to);
    if (e > s) edges.push([s, 1], [e, -1]);
  }
  // Ends before starts at the same instant: back to back is not overlap.
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let depth = 0;
  let max = 0;
  let area = 0;
  let last = from;
  const seconds = Math.max(1, Math.ceil((to - from) / 1000));
  const perSecond = new Array<number>(seconds).fill(0);
  for (const [t, step] of edges) {
    area += depth * (t - last);
    last = t;
    depth += step;
    max = Math.max(max, depth);
    const k = Math.min(seconds - 1, Math.floor((t - from) / 1000));
    perSecond[k] = Math.max(perSecond[k]!, depth);
  }
  return { max, mean: Math.round((area / Math.max(1, to - from)) * 100) / 100, perSecond };
}

// --- the page's socket ---------------------------------------------------------------

/** The socket the page held at `t`: the last one opened by then and not closed before it. */
function socketAt(sockets: readonly ProbeSocket[], t: number): number | null {
  for (let i = sockets.length - 1; i >= 0; i--) {
    const s = sockets[i]!;
    if (s.opened <= t && (s.closed === null || s.closed > t)) return i;
  }
  return null;
}

/**
 * Whether the page held a subscription to card `id` at `t`, on the socket
 * it had open then: its hello's cards, then each subscribe and unsubscribe
 * it sent, replayed in order.
 */
export function subscribedAt(
  frames: readonly SocketFrame[],
  sockets: readonly ProbeSocket[],
  id: string,
  t: number,
): boolean {
  return subscriptionAt(frames, sockets, id, t) !== null;
}

/** When the subscription the page held to `id` at `t` began, or null when it held none. */
function subscriptionAt(
  frames: readonly SocketFrame[],
  sockets: readonly ProbeSocket[],
  id: string,
  t: number,
): number | null {
  const socket = socketAt(sockets, t);
  if (socket === null) return null;
  let since: number | null = null;
  for (const f of frames) {
    if (f.socket !== socket || f.dir !== "out" || f.at > t) continue;
    if (f.type === "hello") since = f.cards?.includes(id) ? f.at : null;
    else if (f.type === "subscribe" && f.id === id) since ??= f.at;
    else if (f.type === "unsubscribe" && f.id === id) since = null;
  }
  return since;
}

/**
 * Whether a hovered card's prefetch had landed by `t`: the page held its
 * subscription, and the server's `card` frame for it had come in since the
 * subscription began.
 */
export function prefetchedAt(
  frames: readonly SocketFrame[],
  sockets: readonly ProbeSocket[],
  id: string,
  t: number,
): boolean {
  const since = subscriptionAt(frames, sockets, id, t);
  if (since === null) return false;
  const socket = socketAt(sockets, t);
  return frames.some(
    (f) => f.socket === socket && f.dir === "in" && f.type === "card" && f.id === id && f.at >= since && f.at <= t,
  );
}

/** The first `card` frame for `id` that came in after `t`. */
export function cardFrameAfter(frames: readonly SocketFrame[], id: string, t: number): SocketFrame | null {
  return frames.find((f) => f.dir === "in" && f.type === "card" && f.id === id && f.at >= t) ?? null;
}

/**
 * An Open in herdr's round trip on the socket: the first `terminal.focus`
 * request for `ticket` sent after `t`, and the reply carrying its number
 * on the same socket, or null when no such request went.
 */
export function focusRoundTrip(
  frames: readonly SocketFrame[],
  ticket: string,
  t: number,
): { request: SocketFrame; reply: SocketFrame | null } | null {
  const request = frames.find(
    (f) => f.dir === "out" && f.type === "request" && f.kind === "terminal.focus" && f.ticket === ticket && f.at >= t,
  );
  if (!request) return null;
  const reply = frames.find(
    (f) => f.dir === "in" && f.type === "reply" && f.socket === request.socket && f.id === request.id && f.at >= request.at,
  );
  return { request, reply: reply ?? null };
}

export interface Tally {
  count: number;
  bytes: number;
}

/** The frames in [from, to], by direction and type, requests and replies by kind too. */
export function countFrames(
  frames: readonly SocketFrame[],
  from: number,
  to: number,
): { sent: Record<string, Tally>; received: Record<string, Tally> } {
  const sent: Record<string, Tally> = {};
  const received: Record<string, Tally> = {};
  for (const f of frames) {
    if (f.at < from || f.at > to) continue;
    const key = f.kind ? `${f.type} ${f.kind}` : f.type;
    const tally = ((f.dir === "out" ? sent : received)[key] ??= { count: 0, bytes: 0 });
    tally.count++;
    tally.bytes += f.bytes;
  }
  return { sent, received };
}

/** Whether a page spoke the push protocol: it opened a socket at WS_PATH. */
export function speaksSocket(report: Pick<ProbeReport, "sockets">): boolean {
  return report.sockets.some((s) => {
    try {
      return new URL(s.url).pathname === WS_PATH;
    } catch {
      return false;
    }
  });
}

// --- the window's numbers -------------------------------------------------------------

/** The Detail tabs whose content a click has to bring; Outcome draws from the snapshot. */
const FETCHED_TABS = new Set(["progress", "spec"]);

export interface E2eResult {
  durationS: number;
  tabs: number;
  rttMs: number;
  cards: number;
  domNodes: number;
  /** What the first tab's page spoke: a socket at WS_PATH, or the old HTTP stream and polls. */
  protocol: "ws" | "sse";
  /** Each tab: navigation start to the end of the first frame that painted every Ticket's card. */
  start: { usableMs: Stats; each: (number | null)[] };
  /**
   * Card clicks on the first tab, all timed from the press's release: to
   * the Detail naming the card (the shell), and to the tab's own content
   * (Progress: the timeline and the log's tail; Spec: the body), each to the
   * end of the frame that painted it and as a count of frames. Outcome needs
   * no fetch, so its clicks count in the shell only. Cold clicks press a
   * card the pointer never rested on; hovered ones rest on it first, for
   * `hoverMs`.
   */
  click: {
    n: number;
    hoverMs: number;
    unreachable: { cold: number; hover: number };
    missed: number;
    unfilled: number;
    /** Cold clicks on a card the page already held a subscription to, so not cold at all. */
    notCold: number;
    tabs: Record<string, number>;
    shellMs: Stats;
    shellFrames: Stats;
    cold: {
      n: number;
      dataMs: Stats;
      /** The release to the first `card` frame for the card: one round trip on the socket. */
      cardFrameMs: Stats | null;
      /** Of which: the release to the page sending its `subscribe`. */
      toSubscribeMs: Stats | null;
    };
    hover: {
      n: number;
      dataFrames: Stats;
      dataMs: Stats;
      /** Hovered clicks whose card frame had come in before the press. */
      prefetched: number | null;
    };
    /** The Progress clicks alone, cold and hovered: the timeline and the log. */
    progressDataMs: Stats;
    inputDelayMs: Stats;
    /** Each click, in order. Times in ms; frames counted from the press. */
    each: {
      id: string;
      how: string;
      tab: string | null;
      shell: number | null;
      shellFrames: number | null;
      data: number | null;
      dataFrames: number | null;
      /** Socket pages: whether the card was subscribed when it was pressed. */
      subscribed: boolean | null;
    }[];
  };
  /**
   * Open in herdr on the first tab, from the release: the press's feedback
   * (its button's row first changing) in frames; the server's answer in the
   * page's hands (the socket's reply, or the POST's last byte); the card's
   * "focused in herdr" painted. The HTTP ones are the old page's only.
   */
  focus: {
    n: number;
    unreachable: number;
    missed: number;
    unanswered: number;
    unconfirmed: number;
    answeredVia: { socket: number; http: number };
    feedbackFrames: Stats;
    answeredMs: Stats;
    /** Over the socket: the release to the request frame leaving the page. */
    toRequestFrameMs: Stats | null;
    /** Over the socket: the release to the page's handler getting the reply,
     *  which waits for the frame after the press (see summarizeE2e). */
    handledMs: Stats | null;
    toFetchMs: Stats;
    toRequestMs: Stats;
    toResponseMs: Stats;
    confirmedMs: Stats;
    inputDelayMs: Stats;
  };
  /** First tab: mutation batches under #app (one per render that changed
   *  the DOM), frames that carried one, and the records in them. */
  renders: { batchesPerSec: number; framesWithMutationsPerSec: number; recordsPerSec: number };
  /** First tab's frames over the window; `tabs` is every tab's budget over the window and the idle
   *  one, its late frames' times in ms from that tab's window start. */
  frames: { perSec: number; gapMs: Stats; over50ms: number; tabs: FrameBudget[] };
  longTasks: { api: boolean; count: number; longestMs: number; totalMs: number; over100ms: number };
  longFrames: { count: number; longestMs: number; blockingMs: number };
  /** First tab's renderer, from CDP Performance.getMetrics over the window. */
  mainThread: { busyPct: number; scriptMs: number; layoutMs: number; styleMs: number; layouts: number; styleRecalcs: number };
  /** Every tab's fetches together, the browser's connections being shared:
   *  asked (fetch made to last byte) and on the wire (request sent to last
   *  byte), and the wait between the two, the queue for a connection. Each
   *  tab's snapshot stream, where it has one, holds one connection more. */
  requests: {
    perSec: number;
    inFlight: { max: number; mean: number; perSecondMax: number[] };
    onWire: { max: number; mean: number };
    waitForConnectionMs: Stats;
    byKind: Record<string, { perSec: number; totalMs: Stats; waitMeanMs: number }>;
  };
  /** First tab's socket frames over the window; null for a page with no socket. */
  ws: { sockets: number; sent: Record<string, Tally>; received: Record<string, Tally> } | null;
  /** Every tab over the idle window, its input stopped, and when it began (ms from the
   *  tab's window start); and what still came in. */
  idle: { tabs: IdleTab[]; fromMs: number[]; received: Record<string, Tally> };
  /** The samples the gates judge (gates.ts). */
  gateInputs: GateInputs;
}

/** A socket request and its reply as the proxy saw them cross (proxy.ts). */
export interface SocketTrip {
  id: number;
  kind: string;
  /** From the request frame leaving the browser to its reply handed back to it. */
  ms: number;
}

export interface E2eOptions {
  rttMs: number;
  /** The first tab's socket requests timed at the network; absent, a socket answer goes unmeasured. */
  socketTrips?: SocketTrip[];
  /** Presses the bench never made: the card or its button was covered or off screen. */
  unreachable: { cold: number; hover: number; focus: number };
  /** How many Ticket cards the pool's canvas holds once loaded. */
  tickets: number;
  /** How long the pointer rested on a card before a hovered click. */
  hoverMs: number;
}

/** The window's numbers, from every tab's probe and the first tab's metrics. */
export function summarizeE2e(
  reports: ProbeReport[],
  metrics: { before: Record<string, number>; after: Record<string, number> },
  options: E2eOptions,
): E2eResult {
  const { rttMs, unreachable } = options;
  const first = reports[0]!;
  const [w0, w1] = first.window;
  const wallMs = w1 - w0;
  const perSec = (n: number) => Math.round((n / (wallMs / 1000)) * 100) / 100;
  const round = (x: number) => Math.round(x * 10) / 10;
  const socket = speaksSocket(first);
  const frames = first.socketFrames;

  // --- clicks
  const pressed = first.clicks.filter((c) => c.t0 !== null && !c.missed);
  const missedClicks = first.clicks.filter((c) => c.missed);
  // Held before the press began: a page may well subscribe on the pointerdown.
  const subscribed = (c: ProbeClick) => (socket ? subscribedAt(frames, first.sockets, c.id, c.t0!) : null);
  const cold = pressed.filter((c) => c.how !== "hover");
  const hover = pressed.filter((c) => c.how === "hover");
  const notCold = cold.filter((c) => subscribed(c) === true);
  // A click whose shell never showed has no known tab, so its content is owed too.
  const withData = (list: ProbeClick[]) => list.filter((c) => c.tab === null || FETCHED_TABS.has(c.tab));
  const coldData = withData(cold);
  const hoverData = withData(hover);
  const tabs: Record<string, number> = {};
  for (const c of pressed) tabs[c.tab ?? "none"] = (tabs[c.tab ?? "none"] ?? 0) + 1;
  const filled = (values: (number | null)[]) => values.filter((v): v is number => v !== null);

  // --- Open in herdr: the socket's reply, else the POST, timed from the release.
  const focusRows = first.focuses.filter((f) => f.t0 !== null && !f.missed);
  const focusFetches = focusRows.map((f) =>
    f.released === null
      ? undefined
      : first.resources.find(
          (r) => kindOf(r.path) === "/api/terminal/focus" && r.path.includes(`ticket=${f.id}`) && r.start >= f.t0! - 1,
        ),
  );
  const toFocus = (pick: (r: ProbeResource) => number) =>
    stats(focusRows.flatMap((f, i) => (focusFetches[i] ? [pick(focusFetches[i]!) - f.released!] : [])));
  // The answer as the network has it, on either protocol: the POST's
  // responseEnd, or the page's send of the request frame plus the proxy's
  // time from that frame leaving the browser to its reply coming back. Not
  // when the page's handler runs: Chromium runs the frame that paints a
  // press before it dispatches what arrived after the press, so that reads
  // a frame late whatever the server did (`handledMs`, kept beside it).
  const unclaimed = [...(options.socketTrips ?? [])];
  const answers = focusRows.map((f, i): { ms: number; via: "socket" | "http"; handled: number | null } | null => {
    if (f.released === null) return null;
    const trip = focusRoundTrip(frames, f.id, f.t0!);
    if (trip) {
      const at = unclaimed.findIndex((t) => t.id === trip.request.id && t.kind === "terminal.focus");
      if (at === -1) return null;
      const [wire] = unclaimed.splice(at, 1);
      return {
        ms: trip.request.at - f.released + wire!.ms,
        via: "socket",
        handled: trip.reply ? trip.reply.at - f.released : null,
      };
    }
    const fetched = focusFetches[i];
    return fetched ? { ms: fetched.responseEnd - f.released, via: "http", handled: null } : null;
  });

  // --- requests: all tabs on one clock: each probe's times are its own
  //     page's, so add the page's time origin.
  const abs0 = first.origin + w0;
  const abs1 = first.origin + w1;
  const all = reports.flatMap((r) =>
    r.resources.map((x) => ({
      kind: kindOf(x.path),
      start: r.origin + x.start,
      wire: r.origin + x.requestStart,
      end: r.origin + x.responseEnd,
    })),
  );
  const started = all.filter((x) => x.start >= abs0 && x.start <= abs1);
  const asked = overlap(all.map((x) => [x.start, x.end]), abs0, abs1);
  const wire = overlap(all.map((x) => [x.wire, x.end]), abs0, abs1);
  const byKind: E2eResult["requests"]["byKind"] = {};
  for (const kind of [...new Set(started.map((x) => x.kind))].sort()) {
    const list = started.filter((x) => x.kind === kind);
    byKind[kind] = {
      perSec: perSec(list.length),
      totalMs: stats(list.map((x) => x.end - x.start)),
      waitMeanMs: stats(list.map((x) => x.wire - x.start)).mean,
    };
  }

  // --- frames, the idle window and the start, every tab.
  const windowFrames = first.frames.filter((f) => f.at <= w1);
  const gaps = windowFrames.slice(1).map((f, i) => f.at - windowFrames[i]!.at);
  // On each tab's window clock, so a late frame's time says where in the run it was.
  const budgets = reports.map((r) => frameBudget(r.frames.map((f) => f.at - r.window[0])));
  const idleTabs: IdleTab[] = reports.map((r) => {
    const [i0, i1] = r.idle;
    const inIdle = (t: number) => i1 > i0 && t >= i0 && t <= i1;
    return {
      ms: Math.max(0, i1 - i0),
      resources: r.resources.filter((x) => inIdle(x.start)).length,
      fetches: r.fetches.filter((x) => inIdle(x.at)).length,
      socketFramesSent: r.socketFrames.filter((f) => f.dir === "out" && inIdle(f.at)).length,
    };
  });
  const idleReceived: Record<string, Tally> = {};
  for (const r of reports) {
    for (const [key, t] of Object.entries(countFrames(r.socketFrames, r.idle[0], r.idle[1]).received)) {
      const sum = (idleReceived[key] ??= { count: 0, bytes: 0 });
      sum.count += t.count;
      sum.bytes += t.bytes;
    }
  }
  const usable = reports.map(
    (r) => r.cardsShown.find((row) => row.cards >= options.tickets)?.paintedAt ?? null,
  );

  const busy = (name: string) => (metrics.after[name] ?? 0) - (metrics.before[name] ?? 0);

  // --- the gates' samples: every press the bench meant to make is one, and
  //     one it could not make, or that landed elsewhere, is an empty one.
  const nulls = (n: number) => new Array<number | null>(n).fill(null);
  const missedBy = (how: "cold" | "hover") =>
    missedClicks.filter((c) => (how === "hover") === (c.how === "hover")).length;
  const missedFocus = first.focuses.filter((f) => f.missed).length;
  const clickMisses = missedClicks.length + unreachable.cold + unreachable.hover;
  const gateInputs: GateInputs = {
    rttMs,
    feedbackFrames: [
      ...pressed.map((c) => c.shellFrames),
      ...focusRows.map((f) => f.feedbackFrames),
      ...nulls(clickMisses + missedFocus + unreachable.focus),
    ],
    shellFrames: [...pressed.map((c) => c.shellFrames), ...nulls(clickMisses)],
    coldDataMs: [
      ...coldData.map((c) => (subscribed(c) === true ? null : c.dataPaintedMs)),
      ...nulls(missedBy("cold") + unreachable.cold),
    ],
    hoverDataFrames: [...hoverData.map((c) => c.dataFrames), ...nulls(missedBy("hover") + unreachable.hover)],
    focusAnsweredMs: [...answers.map((a) => a?.ms ?? null), ...nulls(missedFocus + unreachable.focus)],
    frames: budgets,
    idle: idleTabs,
    usableMs: usable,
  };

  const counted = countFrames(frames, w0, w1);
  return {
    durationS: Math.round(wallMs / 1000),
    tabs: reports.length,
    rttMs,
    cards: first.cards,
    domNodes: first.domNodes,
    protocol: socket ? "ws" : "sse",
    start: { usableMs: stats(filled(usable)), each: usable.map((v) => (v === null ? null : round(v))) },
    click: {
      n: pressed.length,
      hoverMs: options.hoverMs,
      unreachable: { cold: unreachable.cold, hover: unreachable.hover },
      missed: missedClicks.length,
      unfilled: [...coldData, ...hoverData].filter((c) => c.dataPaintedMs === null).length,
      notCold: notCold.length,
      tabs,
      shellMs: stats(filled(pressed.map((c) => c.shellPaintedMs))),
      shellFrames: stats(filled(pressed.map((c) => c.shellFrames))),
      cold: {
        n: coldData.length,
        dataMs: stats(filled(coldData.map((c) => c.dataPaintedMs))),
        cardFrameMs: socket
          ? stats(
              cold.flatMap((c) => {
                if (c.released === null || subscribed(c)) return [];
                const frame = cardFrameAfter(frames, c.id, c.t0!);
                return frame ? [frame.at - c.released] : [];
              }),
            )
          : null,
        toSubscribeMs: socket
          ? stats(
              cold.flatMap((c) => {
                if (c.released === null || subscribed(c)) return [];
                const sent = frames.find((f) => f.dir === "out" && f.type === "subscribe" && f.id === c.id && f.at >= c.t0!);
                return sent ? [sent.at - c.released] : [];
              }),
            )
          : null,
      },
      hover: {
        n: hoverData.length,
        dataFrames: stats(filled(hoverData.map((c) => c.dataFrames))),
        dataMs: stats(filled(hoverData.map((c) => c.dataPaintedMs))),
        prefetched: socket ? hover.filter((c) => prefetchedAt(frames, first.sockets, c.id, c.t0!)).length : null,
      },
      progressDataMs: stats(filled(pressed.map((c) => (c.tab === "progress" ? c.dataPaintedMs : null)))),
      inputDelayMs: stats(pressed.map((c) => c.inputDelayMs ?? 0)),
      each: pressed.map((c) => ({
        id: c.id,
        how: c.how,
        tab: c.tab,
        shell: c.shellPaintedMs === null ? null : round(c.shellPaintedMs),
        shellFrames: c.shellFrames,
        data: c.dataPaintedMs === null ? null : round(c.dataPaintedMs),
        dataFrames: c.dataFrames,
        subscribed: subscribed(c),
      })),
    },
    focus: {
      n: focusRows.length,
      unreachable: unreachable.focus,
      missed: missedFocus,
      unanswered: answers.filter((a) => a === null).length,
      unconfirmed: focusRows.filter((f) => f.confirmedPaintedMs === null).length,
      answeredVia: {
        socket: answers.filter((a) => a?.via === "socket").length,
        http: answers.filter((a) => a?.via === "http").length,
      },
      feedbackFrames: stats(filled(focusRows.map((f) => f.feedbackFrames))),
      answeredMs: stats(filled(answers.map((a) => a?.ms ?? null))),
      handledMs: socket ? stats(filled(answers.map((a) => a?.handled ?? null))) : null,
      toRequestFrameMs: socket
        ? stats(
            focusRows.flatMap((f) => {
              const trip = f.released === null ? null : focusRoundTrip(frames, f.id, f.t0!);
              return trip ? [trip.request.at - f.released!] : [];
            }),
          )
        : null,
      toFetchMs: toFocus((r) => r.start),
      toRequestMs: toFocus((r) => r.requestStart),
      toResponseMs: toFocus((r) => r.responseEnd),
      confirmedMs: stats(filled(focusRows.map((f) => f.confirmedPaintedMs))),
      inputDelayMs: stats(focusRows.map((f) => f.inputDelayMs ?? 0)),
    },
    renders: {
      batchesPerSec: perSec(first.batches.filter((b) => b.at <= w1).length),
      framesWithMutationsPerSec: perSec(windowFrames.filter((f) => f.mutated).length),
      recordsPerSec: perSec(first.batches.filter((b) => b.at <= w1).reduce((n, b) => n + b.records, 0)),
    },
    frames: { perSec: perSec(windowFrames.length), gapMs: stats(gaps), over50ms: gaps.filter((g) => g > 50).length, tabs: budgets },
    longTasks: {
      api: first.longTaskApi,
      count: first.longTasks.length,
      longestMs: round(Math.max(0, ...first.longTasks.map((t) => t.duration))),
      totalMs: round(first.longTasks.reduce((n, t) => n + t.duration, 0)),
      over100ms: first.longTasks.filter((t) => t.duration > 100).length,
    },
    longFrames: {
      count: first.longFrames.length,
      longestMs: round(Math.max(0, ...first.longFrames.map((t) => t.duration))),
      blockingMs: round(first.longFrames.reduce((n, t) => n + t.blocking, 0)),
    },
    mainThread: {
      busyPct: round((busy("TaskDuration") / wallMs) * 100),
      scriptMs: Math.round(busy("ScriptDuration")),
      layoutMs: Math.round(busy("LayoutDuration")),
      styleMs: Math.round(busy("RecalcStyleDuration")),
      layouts: busy("LayoutCount"),
      styleRecalcs: busy("RecalcStyleCount"),
    },
    requests: {
      perSec: perSec(started.length),
      inFlight: { max: asked.max, mean: asked.mean, perSecondMax: asked.perSecond },
      onWire: { max: wire.max, mean: wire.mean },
      waitForConnectionMs: stats(started.map((x) => x.wire - x.start)),
      byKind,
    },
    ws: socket ? { sockets: first.sockets.length, sent: counted.sent, received: counted.received } : null,
    idle: { tabs: idleTabs, fromMs: reports.map((r) => Math.round(r.idle[0] - r.window[0])), received: idleReceived },
    gateInputs,
  };
}
