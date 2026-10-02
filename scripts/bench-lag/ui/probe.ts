/**
 * The lag bench's end-to-end probe (issue #157): a script the bench injects
 * into the real Console page before any of the page's own code runs
 * (CDP's Page.addScriptToEvaluateOnNewDocument), so it measures any build of
 * the Console, old or new, through what every browser exposes and nothing
 * the app itself offers: the DOM, MutationObserver, requestAnimationFrame,
 * and the Long Tasks and Resource Timing APIs.
 *
 * It records from page load: every resource the page fetches (its timing,
 * from which the bench reads the requests out at once and how long each
 * waited for a connection), long tasks, frame gaps, and each mutation batch
 * the page commits under its #app (one per render that changed something).
 *
 * The bench drives the operator's input over CDP as real mouse events and
 * arms this probe first, so each press is timed from the event's own
 * timestamp, the moment the browser took the input, which counts any wait
 * for a busy main thread: a card click until the Detail names the card
 * (the shell) and until it shows what the card's fetches bring (the data);
 * an Open in herdr until the card says it focused.
 *
 * A paint is timed to the end of the rendering step of the frame that
 * carries the change, whether the page renders in the handler (as the
 * Console did) or in an animation frame (as it does since issue #157): the
 * probe wraps requestAnimationFrame to know which, and changes nothing else.
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

interface ClickRow {
  id: string;
  /** The press's event timestamp. */
  t0: number | null;
  /** When the press's handler ran, from t0: the input's wait for the main thread. */
  inputDelayMs: number | null;
  /** The Detail tab the card opened on, which decides what its data is. */
  tab: string | null;
  /** The Detail names the card: in the DOM, then painted (its frame rendered). */
  shellMs: number | null;
  shellPaintedMs: number | null;
  /** The tab's fetched content is the card's: in the DOM, then painted. */
  dataMs: number | null;
  dataPaintedMs: number | null;
  /** The press landed somewhere other than the card. */
  missed: boolean;
}

interface FocusRow {
  id: string;
  t0: number | null;
  inputDelayMs: number | null;
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
  const longTasks: { start: number; duration: number }[] = [];
  const longFrames: { start: number; duration: number; blocking: number }[] = [];
  /** Each frame's rAF time and whether a mutation batch landed since the last. */
  const frames: { at: number; mutated: boolean }[] = [];
  const batches: { at: number; records: number }[] = [];
  const clicks: ClickRow[] = [];
  const focuses: FocusRow[] = [];
  const watchers: Watcher[] = [];
  let nextPress: Watcher | null = null;
  let mutatedSinceFrame = false;

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

  // --- the watchers -----------------------------------------------------------

  const card = (id: string) =>
    document.querySelector<HTMLElement>(`.node-card[data-node-id="ticket:${id}"]`);

  function detailTitle(): string | null {
    return document.querySelector(".detail-open .detail-title")?.textContent ?? null;
  }

  /**
   * Whether the open Detail shows the card's fetched content, by the tab it
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
  // handler's render, a fetch's answer) waits for the next. Telling the two
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

  function check(inFrame: boolean): void {
    const now = performance.now();
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
      const t0 = row.t0;
      if (now - t0 > 15_000) {
        watcher.done = true;
        continue;
      }
      if (watcher.kind === "card") {
        const c = row as ClickRow;
        if (c.shellMs === null && detailTitle() === watcher.id) {
          c.shellMs = now - t0;
          c.tab = activeTab();
          painted(inFrame, (at) => (c.shellPaintedMs = at - t0));
        }
        if (c.shellMs !== null && c.dataMs === null && detailTitle() === watcher.id && dataShown(watcher.id, c.tab)) {
          c.dataMs = now - t0;
          painted(inFrame, (at) => {
            c.dataPaintedMs = at - t0;
            watcher.done = true;
          });
        }
      } else {
        const f = row as FocusRow;
        if (f.confirmedMs === null && card(watcher.id)?.querySelector(".terminal-note")) {
          f.confirmedMs = now - t0;
          painted(inFrame, (at) => {
            f.confirmedPaintedMs = at - t0;
            watcher.done = true;
          });
        }
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
      const want =
        watcher.kind === "card"
          ? target?.closest(`.node-card[data-node-id="ticket:${watcher.id}"]`)
          : target?.closest(".terminal-focus");
      if (!want) {
        watcher.row.missed = true;
        watcher.done = true;
        return;
      }
      watcher.row.t0 = event.timeStamp;
      watcher.row.inputDelayMs = performance.now() - event.timeStamp;
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
      try {
        callback(at);
      } finally {
        const records = observer.takeRecords();
        if (records.length > 0) mutated(records, true);
      }
    });

  function frame(at: number): void {
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

  function arm(kind: "card" | "focus", id: string): { x: number; y: number } | null {
    const el = kind === "card" ? card(id) : card(id)?.querySelector(".terminal-focus");
    const point = visiblePoint(el);
    if (!point) return null;
    let row: ClickRow | FocusRow;
    if (kind === "card") {
      const click: ClickRow = { id, t0: null, inputDelayMs: null, tab: null, shellMs: null, shellPaintedMs: null, dataMs: null, dataPaintedMs: null, missed: false };
      clicks.push(click);
      row = click;
    } else {
      const focus: FocusRow = { id, t0: null, inputDelayMs: null, confirmedMs: null, confirmedPaintedMs: null, missed: false };
      focuses.push(focus);
      row = focus;
    }
    const watcher: Watcher = { kind, id, armedAt: performance.now(), row, done: false };
    watchers.push(watcher);
    nextPress = watcher;
    return point;
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
    const bare: { x: number; y: number }[] = [];
    for (let y = 60; y < innerHeight - 60; y += 40) {
      for (let x = 20; x < innerWidth - 20; x += 40) {
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest(".canvas-viewport") && !hit.closest(".node-card, button, input, textarea, a")) bare.push({ x, y });
      }
    }
    return { found: boxes.length, bounds, bare, width: innerWidth, height: innerHeight };
  }

  let window0 = 0;
  let window1 = 0;

  w.__lagProbe = {
    /** How many cards the canvas holds, to wait for the first render. */
    cards: () => document.querySelectorAll(".node-card").length,
    layout,
    armClick: (id: string) => arm("card", id),
    armFocus: (id: string) => arm("focus", id),
    begin: () => {
      window0 = performance.now();
      clicks.length = 0;
      focuses.length = 0;
      return { at: window0, origin: performance.timeOrigin };
    },
    end: () => {
      window1 = performance.now();
    },
    /** Everything inside the window, raw; the bench does the statistics. */
    report: () => {
      const inside = (t: number) => t >= window0 && t <= window1;
      return {
        origin: performance.timeOrigin,
        window: [window0, window1],
        longTaskApi,
        resources: resources.filter((r) => r.responseEnd >= window0 && r.start <= window1),
        longTasks: longTasks.filter((t) => inside(t.start)),
        longFrames: longFrames.filter((t) => inside(t.start)),
        frames: frames.filter((f) => inside(f.at)),
        batches: batches.filter((b) => inside(b.at)),
        clicks,
        focuses,
        domNodes: document.getElementsByTagName("*").length,
        cards: document.querySelectorAll(".node-card").length,
      };
    },
  };
})();

export {};
