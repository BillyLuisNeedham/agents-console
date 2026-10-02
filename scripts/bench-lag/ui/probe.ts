/**
 * The lag bench's end-to-end probe (issues #157, #161): a script the bench
 * injects into the real Console page before any of the page's own code runs
 * (CDP's Page.addScriptToEvaluateOnNewDocument), so it measures any build of
 * the Console, old or new, through what every browser exposes and nothing
 * the app itself offers: the DOM, MutationObserver, requestAnimationFrame,
 * WebSocket, fetch, and the Long Tasks and Resource Timing APIs.
 *
 * It records from page load: every resource the page fetches (its timing,
 * from which the bench reads the requests out at once and how long each
 * waited for a connection), every fetch() as it starts (a request still out
 * has no Resource Timing entry yet), every frame on every WebSocket the page
 * opens (`window.WebSocket` is wrapped, so the page's own sockets are the
 * wrapper's), long tasks, each frame's time, each mutation batch the page
 * commits under its #app (one per render that changed something), and the
 * frame that first painted every card the canvas holds.
 *
 * The bench drives the operator's input over CDP as real mouse events and
 * arms this probe first. A press is timed from its release (the pointerup's
 * event timestamp, the moment the browser took it), since a tap is not a tap
 * until then: a card click until the Detail names the card (the shell) and
 * until it shows the card's own content (the data); an Open in herdr until
 * its button's row first changes (the press's feedback) and until the card
 * says it focused.
 *
 * A paint is timed to the end of the rendering step of the frame that
 * carries the change, whether the page renders in the handler (as the
 * Console did) or in an animation frame (as it does since issue #157): the
 * probe wraps requestAnimationFrame to know which, and changes nothing else.
 * Frames are numbered as they begin (each new rAF time is a new frame), so a
 * change is also placed in a frame: the number of the frame that painted it,
 * less the number of the last frame begun before the press's release, is
 * how many frames the press waited (1: the first frame after it).
 *
 * Nothing here is imported: e2e.ts strips the types and the `export {}`
 * and injects the text. It publishes itself as `window.__lagProbe`.
 */

interface ResourceRow {
  path: string;
  /** All relative to this page's time origin, in ms. */
  start: number;
  requestStart: number;
  responseEnd: number;
}

interface FetchRow {
  path: string;
  at: number;
}

interface SocketRow {
  url: string;
  opened: number;
  closed: number | null;
}

/** One socket frame as it crossed: kept whole until the report reads it. */
interface RawFrame {
  socket: number;
  dir: "in" | "out";
  at: number;
  /** The last animation frame begun when it crossed. */
  frame: number;
  data: unknown;
}

/** A frame's envelope, as the report gives it: the payload is left out. */
interface FrameRow {
  socket: number;
  dir: "in" | "out";
  at: number;
  frame: number;
  bytes: number;
  type: string;
  /** A request's or a reply's kind. */
  kind?: string;
  /** A request's or a reply's number; a card's, a subscribe's or an unsubscribe's id. */
  id?: number | string;
  /** The ticket a request names (`payload.ticketId`). */
  ticket?: string;
  /** A reply's outcome. */
  ok?: boolean;
  /** The cards a client hello subscribes. */
  cards?: string[];
}

interface ClickRow {
  id: string;
  /** How the bench made it: straight onto the card, or after resting the pointer on it. */
  how: string;
  /** The press's pointerdown timestamp. */
  t0: number | null;
  /** Its release's pointerup timestamp: every time below counts from here. */
  released: number | null;
  /** The last frame begun before the release. */
  pressFrame: number | null;
  /** When the press's handler ran, from t0: the input's wait for the main thread. */
  inputDelayMs: number | null;
  /** The Detail tab the card opened on, which decides what its data is. */
  tab: string | null;
  /** The Detail names the card: in the DOM, then painted (its frame rendered), and in which frame. */
  shellMs: number | null;
  shellPaintedMs: number | null;
  shellFrames: number | null;
  /** The tab's own content is the card's: in the DOM, then painted, and in which frame. */
  dataMs: number | null;
  dataPaintedMs: number | null;
  dataFrames: number | null;
  /** The number of the frame that painted the data, to set beside a socket frame's. */
  dataPaintFrame: number | null;
  /** The press landed somewhere other than the card. */
  missed: boolean;
}

interface FocusRow {
  id: string;
  t0: number | null;
  released: number | null;
  pressFrame: number | null;
  inputDelayMs: number | null;
  /** The button's row first changed (the press's feedback): painted, and in which frame. */
  feedbackPaintedMs: number | null;
  feedbackFrames: number | null;
  /** The card says "focused in herdr": in the DOM, then painted. */
  confirmedMs: number | null;
  confirmedPaintedMs: number | null;
  missed: boolean;
}

interface Watcher {
  kind: "card" | "focus";
  id: string;
  armedAt: number;
  row: ClickRow | FocusRow;
  /** The focus button's row as it was at the pointerdown, to tell its first change. */
  before: string | null;
  done: boolean;
}

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w.__lagProbe) return;

  try {
    performance.setResourceTimingBufferSize(1_000_000);
  } catch {
    // An old engine: the observer below still sees every entry.
  }

  const resources: ResourceRow[] = [];
  const fetches: FetchRow[] = [];
  const sockets: SocketRow[] = [];
  const rawFrames: RawFrame[] = [];
  const longTasks: { start: number; duration: number }[] = [];
  const longFrames: { start: number; duration: number; blocking: number }[] = [];
  /** Each frame's rAF time and whether a mutation batch landed since the last. */
  const frames: { at: number; mutated: boolean }[] = [];
  const batches: { at: number; records: number }[] = [];
  /** The Ticket cards on the canvas, each time their number changed until the
   *  window began: when the DOM first held them, and when that was painted. */
  const cardsShown: { cards: number; at: number; paintedAt: number | null }[] = [];
  const clicks: ClickRow[] = [];
  const focuses: FocusRow[] = [];
  const watchers: Watcher[] = [];
  let nextPress: Watcher | null = null;
  let mutatedSinceFrame = false;
  /** The measured window and the idle one after it, set by the bench. */
  let window0 = 0;
  let window1 = 0;
  let idle0 = 0;
  let idle1 = 0;
  // Frames by number. Every animation callback of one frame gets the same
  // time, so a time not seen before is a new frame beginning.
  let frameNo = 0;
  let frameAt = -1;

  function observe(type: string, take: (entry: PerformanceEntry) => void): boolean {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) take(entry);
      }).observe({ type, buffered: true });
      return true;
    } catch {
      return false;
    }
  }

  observe("resource", (entry) => {
    const e = entry as PerformanceResourceTiming;
    const url = new URL(e.name);
    resources.push({
      path: url.pathname + url.search,
      start: e.startTime,
      requestStart: e.requestStart || e.startTime,
      responseEnd: e.responseEnd,
    });
  });
  const longTaskApi = observe("longtask", (e) => longTasks.push({ start: e.startTime, duration: e.duration }));
  observe("long-animation-frame", (e) =>
    longFrames.push({
      start: e.startTime,
      duration: e.duration,
      blocking: (e as unknown as { blockingDuration?: number }).blockingDuration ?? 0,
    }),
  );

  // --- the network the page opens ---------------------------------------------

  // fetch() as it is called: a poll still out when the report is read has no
  // Resource Timing entry yet, and this one counts it anyway.
  const nativeFetch = window.fetch.bind(window);
  (window as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = (input, init) => {
    try {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href, location.href);
      fetches.push({ path: url.pathname + url.search, at: performance.now() });
    } catch {
      // An unparsable URL: fetch itself will say so.
    }
    return nativeFetch(input, init);
  };

  // Every socket the page opens is one of these. Each frame is kept whole and
  // read only when the bench asks for the report, so the page's own handler
  // (which this listener runs ahead of, being added first) pays a push.
  const NativeSocket = window.WebSocket;
  class ProbedSocket extends NativeSocket {
    private readonly probeIndex: number;

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const index = sockets.push({ url: String(url), opened: performance.now(), closed: null }) - 1;
      this.probeIndex = index;
      this.addEventListener("message", (event) =>
        rawFrames.push({ socket: index, dir: "in", at: performance.now(), frame: frameNo, data: event.data }),
      );
      this.addEventListener("close", () => (sockets[index]!.closed = performance.now()));
    }

    override send(data: Parameters<WebSocket["send"]>[0]): void {
      rawFrames.push({ socket: this.probeIndex, dir: "out", at: performance.now(), frame: frameNo, data });
      super.send(data);
    }
  }
  window.WebSocket = ProbedSocket;

  const utf8 = new TextEncoder();

  /** A frame's envelope and size, its payload parsed and dropped. */
  function envelope(frame: RawFrame): FrameRow {
    const text = typeof frame.data === "string" ? frame.data : null;
    const size = (data: unknown): number =>
      data instanceof Blob ? data.size : ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? data.byteLength : 0;
    const row: FrameRow = {
      socket: frame.socket,
      dir: frame.dir,
      at: frame.at,
      frame: frame.frame,
      bytes: text !== null ? utf8.encode(text).length : size(frame.data),
      type: text !== null ? "unparsed" : "binary",
    };
    if (text === null) return row;
    try {
      const m = JSON.parse(text) as Record<string, unknown>;
      row.type = typeof m.type === "string" ? m.type : "untyped";
      if (typeof m.kind === "string") row.kind = m.kind;
      if (typeof m.id === "number" || typeof m.id === "string") row.id = m.id;
      if (typeof m.ok === "boolean") row.ok = m.ok;
      const card = m.card as { id?: unknown } | undefined;
      if (m.type === "subscribe" && typeof card?.id === "string") row.id = card.id;
      const payload = m.payload as { ticketId?: unknown } | undefined;
      if (m.type === "request" && typeof payload?.ticketId === "string") row.ticket = payload.ticketId;
      if (m.type === "hello" && Array.isArray(m.cards)) {
        row.cards = (m.cards as { id?: unknown }[]).flatMap((c) => (typeof c?.id === "string" ? [c.id] : []));
      }
    } catch {
      // Not JSON: counted as "unparsed".
    }
    return row;
  }

  // --- the watchers -----------------------------------------------------------

  const card = (id: string) =>
    document.querySelector<HTMLElement>(`.node-card[data-node-id="ticket:${id}"]`);

  /** The row holding a card's Open in herdr button: where its press shows. */
  const focusRow = (id: string) => card(id)?.querySelector(".terminal-focus")?.parentElement ?? null;

  function detailTitle(): string | null {
    return document.querySelector(".detail-open .detail-title")?.textContent ?? null;
  }

  /**
   * Whether the open Detail shows the card's own content, by the tab it
   * opened on. Progress: the timeline's attempt rows and the raw log's tail,
   * whose lines carry the ticket's id. The Detail keeps the previous card's
   * timeline until the new card's events answer, but the log pane opens on
   * a card only after its events answered, so the two together are this
   * card's. (A card on Progress has run, so it has attempts.) Spec: the
   * rendered body, kept per ticket. Outcome: nothing to fetch, so the shell
   * is it.
   */
  function dataShown(id: string, tab: string | null): boolean {
    const detail = document.querySelector(".detail-open");
    if (!detail) return false;
    if (tab === "progress") {
      const timeline = detail.querySelector(".timeline");
      if (!timeline?.querySelector(".timeline-attempt")) return false;
      const log = detail.querySelector(".log-pane-content");
      return !!log && (log.textContent ?? "").includes(`[${id}]`);
    }
    if (tab === "spec") return !!detail.querySelector(".detail-md");
    return true;
  }

  function activeTab(): string | null {
    const label = document.querySelector(".detail-open .detail-tab-active")?.textContent ?? "";
    const word = label.trim().toLowerCase();
    return word.startsWith("progress") ? "progress" : word.startsWith("spec") ? "spec" : word.startsWith("outcome") ? "outcome" : null;
  }

  // --- paint -----------------------------------------------------------------

  // When a change reaches the screen: at the end of the rendering step of the
  // frame that carries it, which a message posted during that frame's
  // animation callbacks follows. A change made inside an animation callback
  // (a render loop's render) is in this frame; one made in any other task (a
  // handler's render, a socket frame's) waits for the next. Telling the two
  // apart is why the page's animation callbacks are wrapped below: each one's
  // mutations are taken as it returns, so they are known to be in the frame.
  const nativeFrame = window.requestAnimationFrame.bind(window);
  const rendered = new MessageChannel();
  const afterRender: ((at: number) => void)[] = [];
  rendered.port1.onmessage = () => {
    const at = performance.now();
    for (const then of afterRender.splice(0)) then(at);
  };
  function painted(inFrame: boolean, then: (at: number) => void): void {
    const queue = () => {
      afterRender.push(then);
      rendered.port2.postMessage(null);
    };
    if (inFrame) queue();
    else nativeFrame(queue);
  }

  function enterFrame(at: number): void {
    if (at === frameAt) return;
    frameAt = at;
    frameNo++;
  }
  /** The frame a change seen now is painted in: this one inside a frame, else the next. */
  const paintFrame = (inFrame: boolean) => (inFrame ? frameNo : frameNo + 1);

  function check(inFrame: boolean): void {
    const now = performance.now();
    if (window0 === 0) {
      const n = document.querySelectorAll('.node-card[data-node-id^="ticket:"]').length;
      if (n !== (cardsShown.at(-1)?.cards ?? 0)) {
        const row = { cards: n, at: now, paintedAt: null as number | null };
        cardsShown.push(row);
        painted(inFrame, (at) => (row.paintedAt = at));
      }
    }
    for (const watcher of watchers) {
      if (watcher.done) continue;
      const row = watcher.row;
      if (row.t0 === null) {
        if (now - watcher.armedAt > 5_000) {
          row.missed = true;
          watcher.done = true;
        }
        continue;
      }
      if (now - row.t0 > 15_000) {
        watcher.done = true;
        continue;
      }
      // Nothing counts before the release: a tap is not one until then.
      if (row.released === null || row.pressFrame === null) continue;
      const from = row.released;
      const frames = paintFrame(inFrame) - row.pressFrame;
      if (watcher.kind === "card") {
        const c = row as ClickRow;
        if (c.shellMs === null && detailTitle() === watcher.id) {
          c.shellMs = now - from;
          c.shellFrames = frames;
          c.tab = activeTab();
          painted(inFrame, (at) => (c.shellPaintedMs = at - from));
        }
        if (c.shellMs !== null && c.dataMs === null && detailTitle() === watcher.id && dataShown(watcher.id, c.tab)) {
          c.dataMs = now - from;
          c.dataFrames = frames;
          c.dataPaintFrame = paintFrame(inFrame);
          painted(inFrame, (at) => {
            c.dataPaintedMs = at - from;
            watcher.done = true;
          });
        }
      } else {
        const f = row as FocusRow;
        if (f.feedbackFrames === null && (focusRow(watcher.id)?.outerHTML ?? "") !== watcher.before) {
          f.feedbackFrames = frames;
          painted(inFrame, (at) => (f.feedbackPaintedMs = at - from));
        }
        if (f.confirmedMs === null && card(watcher.id)?.querySelector(".terminal-note")) {
          f.confirmedMs = now - from;
          painted(inFrame, (at) => {
            f.confirmedPaintedMs = at - from;
            if (f.feedbackFrames !== null) watcher.done = true;
          });
        }
        if (f.feedbackFrames !== null && f.confirmedPaintedMs !== null) watcher.done = true;
      }
    }
  }

  // The press: its event timestamp is when the browser took the input, so
  // the time from there to the handler is the wait for the main thread.
  window.addEventListener(
    "pointerdown",
    (event) => {
      const watcher = nextPress;
      if (!watcher) return;
      nextPress = null;
      const target = event.target instanceof Element ? event.target : null;
      const own = `.node-card[data-node-id="ticket:${watcher.id}"]`;
      const want = watcher.kind === "card" ? target?.closest(own) : target?.closest(`${own} .terminal-focus`);
      if (!want) {
        watcher.row.missed = true;
        watcher.done = true;
        return;
      }
      watcher.row.t0 = event.timeStamp;
      watcher.row.inputDelayMs = performance.now() - event.timeStamp;
      if (watcher.kind === "focus") watcher.before = focusRow(watcher.id)?.outerHTML ?? "";
    },
    true,
  );
  // The release, ahead of the page's own handlers, which act on it.
  window.addEventListener(
    "pointerup",
    (event) => {
      for (const watcher of watchers) {
        const row = watcher.row;
        if (watcher.done || row.t0 === null || row.released !== null) continue;
        row.released = event.timeStamp;
        row.pressFrame = frameNo;
      }
    },
    true,
  );

  // --- renders and frames -----------------------------------------------------

  /** A batch of mutations: one render's, when it changed the DOM. */
  function mutated(records: MutationRecord[], inFrame: boolean): void {
    // Under #app only: the tab title and favicon are not the page's render.
    const app = document.getElementById("app");
    let n = 0;
    for (const r of records) if (app && app.contains(r.target)) n++;
    if (n > 0) {
      batches.push({ at: performance.now(), records: n });
      mutatedSinceFrame = true;
    }
    check(inFrame);
  }
  const observer = new MutationObserver((records) => mutated(records, false));
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    nativeFrame((at) => {
      enterFrame(at);
      try {
        callback(at);
      } finally {
        const records = observer.takeRecords();
        if (records.length > 0) mutated(records, true);
      }
    });

  function frame(at: number): void {
    enterFrame(at);
    frames.push({ at, mutated: mutatedSinceFrame });
    mutatedSinceFrame = false;
    // What the DOM holds now, this frame paints.
    check(true);
    nativeFrame(frame);
  }
  nativeFrame(frame);

  // --- what the bench calls -----------------------------------------------------

  /** A point inside `el` the mouse would land on it at, or null when covered or off screen. */
  function visiblePoint(el: Element | null | undefined): { x: number; y: number } | null {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    for (const [fx, fy] of [[0.5, 0.5], [0.15, 0.2], [0.85, 0.2], [0.15, 0.8], [0.85, 0.8], [0.5, 0.15]] as const) {
      const x = Math.round(box.left + box.width * fx);
      const y = Math.round(box.top + box.height * fy);
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) {
        // A card is tapped where no button is, the way the canvas reads a tap.
        if (el.classList.contains("node-card") && hit.closest("button, input, textarea, a, .assignment-badge")) continue;
        return { x, y };
      }
    }
    return null;
  }

  /** Whether a point is bare canvas: no card, no control. */
  function bare(x: number, y: number): boolean {
    const hit = document.elementFromPoint(x, y);
    return !!hit?.closest(".canvas-viewport") && !hit.closest(".node-card, button, input, textarea, a");
  }

  /**
   * Bare canvas points on a grid, the first `limit` of them. Each costs a
   * hit test, so the whole scan (to pan from) runs only while the bench
   * frames the view, never inside the measured window.
   */
  function barePoints(limit = Infinity): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = [];
    for (let y = 60; y < innerHeight - 60; y += 40) {
      for (let x = 20; x < innerWidth - 20; x += 40) {
        if (bare(x, y)) points.push({ x, y });
        if (points.length >= limit) return points;
      }
    }
    return points;
  }

  // Where the pointer rests between presses: bare canvas, so it hovers no
  // card. Kept, and checked with one hit test per press; a press's pointer
  // goes there as soon as the press is released.
  let park: { x: number; y: number } | null = null;
  function parkPoint(): { x: number; y: number } | null {
    if (park && bare(park.x, park.y)) return park;
    park = barePoints(1)[0] ?? null;
    return park;
  }

  function arm(kind: "card" | "focus", id: string, how: string) {
    const el = kind === "card" ? card(id) : card(id)?.querySelector(".terminal-focus");
    const point = visiblePoint(el);
    if (!point) return null;
    let row: ClickRow | FocusRow;
    if (kind === "card") {
      const click: ClickRow = { id, how, t0: null, released: null, pressFrame: null, inputDelayMs: null, tab: null, shellMs: null, shellPaintedMs: null, shellFrames: null, dataMs: null, dataPaintedMs: null, dataFrames: null, dataPaintFrame: null, missed: false };
      clicks.push(click);
      row = click;
    } else {
      const focus: FocusRow = { id, t0: null, released: null, pressFrame: null, inputDelayMs: null, feedbackPaintedMs: null, feedbackFrames: null, confirmedMs: null, confirmedPaintedMs: null, missed: false };
      focuses.push(focus);
      row = focus;
    }
    const watcher: Watcher = { kind, id, armedAt: performance.now(), row, before: null, done: false };
    watchers.push(watcher);
    nextPress = watcher;
    return { ...point, park: parkPoint() };
  }

  /**
   * Where the given tickets' cards sit on screen, and the bare canvas points
   * a press would pan from, so the bench can wheel and drag the canvas until
   * every card it will press is in view.
   */
  function layout(ids: string[]) {
    const boxes = ids.flatMap((id) => {
      const el = card(id);
      return el ? [el.getBoundingClientRect()] : [];
    });
    const bounds = {
      left: Math.min(...boxes.map((b) => b.left)),
      top: Math.min(...boxes.map((b) => b.top)),
      right: Math.max(...boxes.map((b) => b.right)),
      bottom: Math.max(...boxes.map((b) => b.bottom)),
    };
    park = null;
    return { found: boxes.length, bounds, bare: barePoints(), width: innerWidth, height: innerHeight };
  }

  w.__lagProbe = {
    /** How many cards the canvas holds, to wait for the first render. */
    cards: () => document.querySelectorAll(".node-card").length,
    layout,
    parkPoint,
    /** `how` is the bench's own label for the click: "cold" or "hover". */
    armClick: (id: string, how = "cold") => arm("card", id, how),
    armFocus: (id: string) => arm("focus", id, "focus"),
    begin: () => {
      window0 = performance.now();
      clicks.length = 0;
      focuses.length = 0;
      return { at: window0, origin: performance.timeOrigin };
    },
    end: () => {
      window1 = performance.now();
    },
    /** The idle window: the bench makes no input between these two. */
    idle: () => {
      idle0 = performance.now();
    },
    idleEnd: () => {
      idle1 = performance.now();
    },
    /**
     * Everything from the window's start, raw; the bench does the
     * statistics. Socket frames and the cards shown come from page load.
     */
    report: () => {
      const last = Math.max(window1, idle1);
      const inside = (t: number) => t >= window0 && t <= last;
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return {
        origin: performance.timeOrigin,
        window: [window0, window1],
        idle: [idle0, idle1],
        // The page's start, from navigation (time 0): its document's arrival,
        // its parse, and what it fetched before the window began.
        startup: {
          htmlEnd: nav?.responseEnd ?? null,
          domInteractive: nav?.domInteractive ?? null,
          resources: resources.filter((r) => r.start < window0),
        },
        longTaskApi,
        resources: resources.filter((r) => r.responseEnd >= window0),
        fetches: fetches.filter((f) => f.at >= window0),
        sockets,
        socketFrames: rawFrames.map(envelope),
        longTasks: longTasks.filter((t) => inside(t.start)),
        longFrames: longFrames.filter((t) => inside(t.start)),
        frames: frames.filter((f) => inside(f.at)),
        batches: batches.filter((b) => inside(b.at)),
        cardsShown,
        clicks,
        focuses,
        domNodes: document.getElementsByTagName("*").length,
        cards: document.querySelectorAll(".node-card").length,
      };
    },
  };
})();

export {};
