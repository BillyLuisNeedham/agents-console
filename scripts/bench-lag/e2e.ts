/**
 * The lag bench's end-to-end half (issue #157): the checkout's real built
 * Console, served by its real pool server, in a real headless Chromium,
 * driven over the Chrome DevTools Protocol, so nothing about the client is
 * modelled. The browser keeps its own connections (six per origin, shared
 * by its tabs, one held by each tab's snapshot stream), the page polls on
 * whatever cadence its build has, and renders however its build renders.
 *
 * This module is the browser side: a small CDP client over Bun's own
 * WebSocket, a launcher for the headless browser, and the statistics over
 * what the page probe (ui/probe.ts, injected before the Console's own code)
 * recorded. The bench (scripts/bench-lag.ts --e2e) runs the pool, the
 * server, the round-trip proxy (proxy.ts) and the schedule of clicks.
 *
 * Input goes in as CDP mouse events, which the browser delivers through its
 * real input path: a press waits for a busy main thread the way a hand's
 * does, and the canvas sees the pointerdown and pointerup it reads a tap
 * from.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    const chromium = options.chromium ?? process.env.CHROMIUM ?? "/usr/bin/chromium";
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

  /** A mouse click as a hand makes one: over the point, press, release. */
  async click(tab: BrowserTab, at: { x: number; y: number }): Promise<void> {
    const base = { x: at.x, y: at.y, button: "left", pointerType: "mouse" };
    await this.cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none", buttons: 0 }, tab.sessionId);
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

export interface ProbeReport {
  origin: number;
  window: [number, number];
  longTaskApi: boolean;
  resources: ProbeResource[];
  longTasks: { start: number; duration: number }[];
  longFrames: { start: number; duration: number; blocking: number }[];
  frames: { at: number; mutated: boolean }[];
  batches: { at: number; records: number }[];
  clicks: {
    id: string;
    t0: number | null;
    inputDelayMs: number | null;
    tab: string | null;
    shellMs: number | null;
    shellPaintedMs: number | null;
    dataMs: number | null;
    dataPaintedMs: number | null;
    missed: boolean;
  }[];
  focuses: {
    id: string;
    t0: number | null;
    inputDelayMs: number | null;
    confirmedMs: number | null;
    confirmedPaintedMs: number | null;
    missed: boolean;
  }[];
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

export interface E2eResult {
  durationS: number;
  tabs: number;
  rttMs: number;
  cards: number;
  domNodes: number;
  /** Card clicks on the first tab: press to the Detail naming the card, and
   *  to the tab's fetched content (Progress: the timeline and the log's
   *  tail; Spec: the body), each to the end of the frame that painted it.
   *  Outcome needs no fetch, so its clicks count in the shell only. */
  click: {
    n: number;
    unreachable: number;
    missed: number;
    unfilled: number;
    tabs: Record<string, number>;
    shellMs: Stats;
    dataMs: Stats;
    /** The Progress clicks alone: the timeline and the log, never cached. */
    progressDataMs: Stats;
    inputDelayMs: Stats;
    /** Each click, in order: the card, its tab, and its two times (ms). */
    each: { id: string; tab: string | null; shell: number | null; data: number | null }[];
  };
  /** Open in herdr on the first tab: press to the fetch being made, to its
   *  request leaving on a connection, to its response, and to the card's
   *  "focused in herdr" painted. */
  focus: {
    n: number;
    unreachable: number;
    missed: number;
    unconfirmed: number;
    toFetchMs: Stats;
    toRequestMs: Stats;
    toResponseMs: Stats;
    confirmedMs: Stats;
    inputDelayMs: Stats;
  };
  /** First tab: mutation batches under #app (one per render that changed
   *  the DOM), frames that carried one, and the records in them. */
  renders: { batchesPerSec: number; framesWithMutationsPerSec: number; recordsPerSec: number };
  frames: { perSec: number; gapMs: Stats; over50ms: number };
  longTasks: { api: boolean; count: number; longestMs: number; totalMs: number; over100ms: number };
  longFrames: { count: number; longestMs: number; blockingMs: number };
  /** First tab's renderer, from CDP Performance.getMetrics over the window. */
  mainThread: { busyPct: number; scriptMs: number; layoutMs: number; styleMs: number; layouts: number; styleRecalcs: number };
  /** Every tab's fetches together, the browser's connections being shared:
   *  asked (fetch made to last byte) and on the wire (request sent to last
   *  byte), and the wait between the two, the queue for a connection. Each
   *  tab's snapshot stream holds one connection more throughout. */
  requests: {
    perSec: number;
    inFlight: { max: number; mean: number; perSecondMax: number[] };
    onWire: { max: number; mean: number };
    waitForConnectionMs: Stats;
    byKind: Record<string, { perSec: number; totalMs: Stats; waitMeanMs: number }>;
  };
}

/** The window's numbers, from every tab's probe and the first tab's metrics. */
export function summarizeE2e(
  reports: ProbeReport[],
  metrics: { before: Record<string, number>; after: Record<string, number> },
  rttMs: number,
  /** Presses the bench never made: the card or its button was covered or off screen. */
  unreachable: { click: number; focus: number },
): E2eResult {
  const first = reports[0]!;
  const [w0, w1] = first.window;
  const wallMs = w1 - w0;
  const perSec = (n: number) => Math.round((n / (wallMs / 1000)) * 100) / 100;

  const clicks = first.clicks.filter((c) => c.t0 !== null && !c.missed);
  const fetched = clicks.filter((c) => c.tab !== "outcome");
  const tabs: Record<string, number> = {};
  for (const c of clicks) tabs[c.tab ?? "none"] = (tabs[c.tab ?? "none"] ?? 0) + 1;

  // An Open in herdr's fetch: the first focus request for that card after the press.
  const focusRows = first.focuses.filter((f) => f.t0 !== null && !f.missed);
  const focusFetches = focusRows.map((f) =>
    first.resources.find(
      (r) => kindOf(r.path) === "/api/terminal/focus" && r.path.includes(`ticket=${f.id}`) && r.start >= f.t0! - 1,
    ),
  );
  const toFocus = (pick: (r: ProbeResource) => number) =>
    stats(focusRows.flatMap((f, i) => (focusFetches[i] ? [pick(focusFetches[i]!) - f.t0!] : [])));

  // All tabs on one clock: each probe's times are its own page's, so add
  // the page's time origin.
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

  const gaps = first.frames.slice(1).map((f, i) => f.at - first.frames[i]!.at);
  const busy = (name: string) => (metrics.after[name] ?? 0) - (metrics.before[name] ?? 0);
  const round = (x: number) => Math.round(x * 10) / 10;

  return {
    durationS: Math.round(wallMs / 1000),
    tabs: reports.length,
    rttMs,
    cards: first.cards,
    domNodes: first.domNodes,
    click: {
      n: clicks.length,
      unreachable: unreachable.click,
      missed: first.clicks.filter((c) => c.missed).length,
      unfilled: fetched.filter((c) => c.dataPaintedMs === null).length,
      tabs,
      shellMs: stats(clicks.flatMap((c) => (c.shellPaintedMs !== null ? [c.shellPaintedMs] : []))),
      dataMs: stats(fetched.flatMap((c) => (c.dataPaintedMs !== null ? [c.dataPaintedMs] : []))),
      progressDataMs: stats(
        fetched.flatMap((c) => (c.tab === "progress" && c.dataPaintedMs !== null ? [c.dataPaintedMs] : [])),
      ),
      inputDelayMs: stats(clicks.map((c) => c.inputDelayMs ?? 0)),
      each: clicks.map((c) => ({
        id: c.id,
        tab: c.tab,
        shell: c.shellPaintedMs === null ? null : Math.round(c.shellPaintedMs * 10) / 10,
        data: c.dataPaintedMs === null ? null : Math.round(c.dataPaintedMs * 10) / 10,
      })),
    },
    focus: {
      n: focusRows.length,
      unreachable: unreachable.focus,
      missed: first.focuses.filter((f) => f.missed).length,
      unconfirmed: focusRows.filter((f) => f.confirmedPaintedMs === null).length,
      toFetchMs: toFocus((r) => r.start),
      toRequestMs: toFocus((r) => r.requestStart),
      toResponseMs: toFocus((r) => r.responseEnd),
      confirmedMs: stats(focusRows.flatMap((f) => (f.confirmedPaintedMs !== null ? [f.confirmedPaintedMs] : []))),
      inputDelayMs: stats(focusRows.map((f) => f.inputDelayMs ?? 0)),
    },
    renders: {
      batchesPerSec: perSec(first.batches.length),
      framesWithMutationsPerSec: perSec(first.frames.filter((f) => f.mutated).length),
      recordsPerSec: perSec(first.batches.reduce((n, b) => n + b.records, 0)),
    },
    frames: { perSec: perSec(first.frames.length), gapMs: stats(gaps), over50ms: gaps.filter((g) => g > 50).length },
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
  };
}
