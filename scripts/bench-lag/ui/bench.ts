/**
 * The lag bench's UI half (issues #157, #161): mounts the real Console,
 * composed by the checkout's own createConsole (ui/src/console.ts) exactly as
 * its main.ts composes it, over a fake socket that plays the pool server's
 * side of the push protocol (ADR-0032). With the server out of the picture
 * every millisecond measured here is the page's own: decoding and applying
 * the frames, the render, the morph, the layout the canvas edges force, and
 * whatever else the main thread does per store change.
 *
 * The fake is the wire itself, not a stand-in for a store: every frame it
 * sends is built with the checkout's own protocol functions (toPushed,
 * diffSnapshot, encodeMessage) and handed to the Console as JSON text, the
 * way a WebSocket message arrives, in a task of its own. It sends what the
 * real server sends a visible socket: hello and the snapshot on open (the
 * same epoch and revision the page booted with, so it repaints nothing), a
 * delta `sps` times a second as a Conversation's turn line moves and a pool
 * log line lands, a live frame every LIVE_CHECK_MS with the running tickets'
 * activity and every pane's peek moved, and for every card the page
 * subscribes, one card frame with its body, events and log window, then the
 * log's appends as the running tickets' agents write. Requests are answered
 * by kind under their own id.
 *
 * While that runs the page clicks cards the way an operator does
 * (pointerdown and pointerup on the card, which is the canvas's tap) and
 * drags one, timing each, and reports the same numbers bench-sse.ts reports
 * for a checkout from before the protocol, on the same pool (fixture.ts).
 * vite.config.ts builds this page for a checkout that has ui/src/console.ts
 * and that one for any other. It POSTs its report to `/report` on its own
 * origin; ui-bench.ts serves both.
 */

import "@console/styles.css";
import { createConsole, type ConsoleApp } from "@console/console";
import type { TicketLogResponse } from "@console/project";
import {
  decodeClientMessage,
  diffSnapshot,
  encodeMessage,
  HEARTBEAT_MS,
  LIVE_CHECK_MS,
  PROTOCOL_VERSION,
  toPushed,
  type CardSubscription,
  type ClientMessage,
  type LogPush,
  type PushedSnapshot,
  type ServerMessage,
  type SocketLike,
} from "@engine/protocol.ts";
import {
  activity,
  bodyOf,
  CONVERSATIONS,
  DONE,
  eventsFor,
  grades,
  LOG_TEXT,
  peekText,
  poolLog,
  RUNNING,
  SETTINGS,
  snapshot,
  WAITING,
} from "./fixture";

const params = new URLSearchParams(location.search);
const DURATION_MS = Number(params.get("dur") ?? 30_000);
const SNAPSHOTS_PER_SEC = Number(params.get("sps") ?? 1);

// ---------------------------------------------------------------------------
// The pool server, played in the page.
// ---------------------------------------------------------------------------

const EPOCH = "bench-ui";
/** The log window a subscribe sends: the last 64 KiB, as the server's is. */
const LOG_WINDOW_BYTES = 64 * 1024;
/** How often a running ticket's agent writes to its log. */
const APPEND_MS = 1_500;

let seq = 1;
let pushed: PushedSnapshot = toPushed(snapshot(seq), 0);
let focusCalls = 0;
const serverTimers: ReturnType<typeof setInterval>[] = [];

/** A socket frame's arrival: never inside the task that caused it. */
function later(run: () => void): void {
  setTimeout(run, 0);
}

/** What a running ticket's agent has written since the bench began. */
const written = new Map<string, string>();
const logOf = (id: string): string => LOG_TEXT + (written.get(id) ?? "");

/** The attempt a card's log follows when it names none: the live one, or a done ticket's first. */
function latestAttempt(id: string): number | null {
  const t = pushed.snapshot.state.tickets.find((x) => x.id === id);
  if (!t) return null;
  return t.liveAttempt?.attempt ?? (t.status === "done" ? 1 : null);
}

function attemptsUpTo(n: number): TicketLogResponse["attempts"] {
  return Array.from({ length: n }, (_, i) => ({
    attempt: i + 1,
    kind: "implement" as const,
    logFile: `runs/bench/attempt-${i + 1}.log`,
    streamFile: null,
    current: i + 1 === n,
  }));
}

/** A log's last window, as the server reads it for a subscribe or a follow. */
function tail(id: string, attempt: number): TicketLogResponse {
  const text = logOf(id);
  const offset = Math.max(0, text.length - LOG_WINDOW_BYTES);
  return {
    content: text.slice(offset),
    offset,
    nextOffset: text.length,
    totalSize: text.length,
    attempts: attemptsUpTo(attempt),
  };
}

/** One card the page has subscribed: its attempt and how far its log has been sent. */
interface Followed {
  attempt: number | null;
  sent: number;
}

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  visible = true;
  private readonly cards = new Map<string, Followed>();

  constructor() {
    sockets.add(this);
    later(() => this.opened());
  }

  /** The server's side of an open: hello, the snapshot, the whole live cache. */
  private opened(): void {
    this.readyState = 1;
    this.onopen?.({});
    this.deliver({ type: "hello", protocol: PROTOCOL_VERSION, epoch: EPOCH, heartbeatMs: HEARTBEAT_MS });
    this.deliver({ type: "snapshot", rev: pushed.rev, logTotal: pushed.logTotal, snapshot: pushed.snapshot });
    this.deliver(liveFrame(true));
  }

  send(data: string): void {
    const message = decodeClientMessage(data);
    later(() => this.receive(message));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    sockets.delete(this);
    later(() => this.onclose?.({ code, reason }));
  }

  /** A frame to the page, as JSON text, the way a WebSocket message arrives. */
  deliver(message: ServerMessage): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: encodeMessage(message) });
  }

  private receive(message: ClientMessage): void {
    switch (message.type) {
      case "hello":
        this.visible = message.visible;
        for (const card of message.cards) this.subscribe(card);
        return;
      case "visibility":
        this.visible = message.visible;
        return;
      case "subscribe":
        this.subscribe(message.card);
        return;
      case "unsubscribe":
        this.cards.delete(message.id);
        return;
      case "request":
        this.deliver(this.answer(message));
        return;
    }
  }

  /** A new subscription's one frame, everything in it; a repeat only moves the follow. */
  private subscribe(card: CardSubscription): void {
    const attempt = card.follow?.attempt ?? latestAttempt(card.id);
    const held = this.cards.get(card.id);
    if (held) {
      held.attempt = attempt;
      return;
    }
    const latest = attempt === null ? null : tail(card.id, attempt);
    this.cards.set(card.id, { attempt, sent: latest?.nextOffset ?? 0 });
    const conversation = CONVERSATIONS.includes(card.id);
    this.deliver({
      type: "card",
      id: card.id,
      body: conversation ? null : { id: card.id, body: bodyOf(card.id) },
      events: conversation ? { events: [], attempts: [], reconstructed: false, spec: "" } : eventsFor(card.id),
      log: latest && attempt !== null ? { mode: "window", attempt, stream: false, ...latest } : null,
    });
  }

  /** The bytes each followed log gained since it was last sent. Hidden sockets wait. */
  appendLogs(): void {
    if (!this.visible) return;
    for (const [id, card] of this.cards) {
      if (card.attempt === null) continue;
      const text = logOf(id);
      if (text.length <= card.sent) continue;
      const push: LogPush = {
        mode: "append",
        attempt: card.attempt,
        stream: false,
        content: text.slice(card.sent),
        offset: card.sent,
        nextOffset: text.length,
        totalSize: text.length,
      };
      card.sent = text.length;
      this.deliver({ type: "card", id, log: push });
    }
  }

  private answer(request: Extract<ClientMessage, { type: "request" }>): ServerMessage {
    const ok = (result: unknown) =>
      ({ type: "reply", id: request.id, kind: request.kind, rev: pushed.rev, ok: true, result }) as ServerMessage;
    switch (request.kind) {
      case "terminal.focus":
        focusCalls += 1;
        return ok({ ok: true, paneId: `pane-${request.payload.ticketId}` });
      case "log.read": {
        const text = logOf(request.payload.id);
        const from = Math.min(request.payload.offset, text.length);
        const to = Math.min(request.payload.end ?? text.length, text.length);
        return ok({
          content: text.slice(from, to),
          offset: from,
          nextOffset: to,
          totalSize: text.length,
          attempts: attemptsUpTo(request.payload.attempt ?? latestAttempt(request.payload.id) ?? 1),
        });
      }
      case "log.follow": {
        const attempt = request.payload.attempt ?? latestAttempt(request.payload.id) ?? 1;
        const latest = tail(request.payload.id, attempt);
        const card = this.cards.get(request.payload.id);
        if (card) {
          card.attempt = attempt;
          card.sent = latest.nextOffset;
        }
        return ok(latest);
      }
      case "poolLog.read": {
        const before = Math.min(request.payload.before, poolLog.length);
        const start = Math.max(0, before - (request.payload.limit ?? 500));
        return ok({ start, lines: poolLog.slice(start, before), total: poolLog.length });
      }
      case "settings.get":
      case "settings.pool.put":
      case "settings.machine.put":
        return ok(SETTINGS);
      case "panes.list":
        return ok({ panes: [] });
      default:
        return ok({});
    }
  }
}

const sockets = new Set<FakeSocket>();

/** A live check's frame: every running ticket's activity and every pane's peek moved. */
function liveFrame(withGrades: boolean): ServerMessage {
  const panes = [...RUNNING, ...CONVERSATIONS];
  return {
    type: "live",
    activity: Object.fromEntries(RUNNING.map((id) => [id, activity(id)])),
    peeks: Object.fromEntries(panes.map((id) => [id, { ticket: id, paneId: `pane-${id}`, text: peekText(id) }])),
    ...(withGrades ? { grades: grades() } : {}),
  };
}

/** The server's cadences: deltas, live checks, log appends, heartbeats. */
function startServer(): void {
  serverTimers.push(
    setInterval(() => {
      seq += 1;
      poolLog.push(`[pool] snapshot ${seq}: a turn moved`);
      const next = toPushed(snapshot(seq), pushed.rev + 1);
      const delta = diffSnapshot(pushed, next);
      if (!delta) return;
      pushed = next;
      for (const socket of sockets) socket.deliver({ type: "delta", delta });
    }, 1000 / SNAPSHOTS_PER_SEC),
    setInterval(() => {
      const frame = liveFrame(false);
      for (const socket of sockets) if (socket.visible) socket.deliver(frame);
    }, LIVE_CHECK_MS),
    setInterval(() => {
      for (const id of RUNNING) {
        written.set(id, (written.get(id) ?? "") + `\n[${id}] the agent wrote another step at ${Date.now()}`);
      }
      for (const socket of sockets) socket.appendLogs();
    }, APPEND_MS),
    setInterval(() => {
      for (const socket of sockets) socket.deliver({ type: "heartbeat" });
    }, HEARTBEAT_MS),
  );
}

function stopServer(): void {
  for (const timer of serverTimers.splice(0)) clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Mount: main.ts's createConsole, with the fake socket and the boot snapshot
// the served page would embed.
// ---------------------------------------------------------------------------

const root = document.getElementById("app") as HTMLElement;

// Whether the page is inside an animation frame's callbacks, where the render
// loop renders: what it changes there is painted at the end of this frame,
// where a render in a handler waits for the next (clickCard below).
let inAnimationFrame = false;
const nativeFrame = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
  nativeFrame((at) => {
    inAnimationFrame = true;
    try {
      callback(at);
    } finally {
      inAnimationFrame = false;
    }
  });

const app = createConsole({
  root,
  openSocket: () => new FakeSocket(),
  // The served page's embedded snapshot, parsed from its JSON as main.ts reads it.
  boot: JSON.parse(
    JSON.stringify({
      protocol: PROTOCOL_VERSION,
      epoch: EPOCH,
      rev: pushed.rev,
      logTotal: pushed.logTotal,
      snapshot: pushed.snapshot,
    }),
  ),
  render: (a) => render(a),
});

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Off until the warm-up is over, so the first mount's cost is not a sample. */
let measuring = false;
let renders = 0;
const renderMs: number[] = [];
/** The projection alone (`session.model()`), so a slow render says whether
 *  the derivation or the DOM side owns it. */
const modelMs: number[] = [];
/** Render plus the style and layout the browser owes for it, forced at once:
 *  the work the next frame would otherwise do. */
const renderLayoutMs: number[] = [];

/** A click waiting for the Detail to name its card, told whether the render
 *  that did ran inside an animation frame. */
let titleWatch: { id: string; shown: (inFrame: boolean) => void } | null = null;

function render(a: ConsoleApp): void {
  const t0 = performance.now();
  const model = a.session.model(a.view.conversationEndState());
  const tm = performance.now();
  a.view.render(root, model, a.handlers);
  const t1 = performance.now();
  void document.body.offsetHeight;
  const t2 = performance.now();
  if (titleWatch && detailTitle() === titleWatch.id) {
    const watch = titleWatch;
    titleWatch = null;
    watch.shown(inAnimationFrame);
  }
  if (!measuring) return;
  renders += 1;
  modelMs.push(tm - t0);
  renderMs.push(t1 - t0);
  renderLayoutMs.push(t2 - t0);
}

const longTasks: number[] = [];
try {
  new PerformanceObserver((list) => {
    if (!measuring) return;
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: false });
} catch {
  // No Long Tasks API: the report says so through an empty list.
}

/** Frame gaps from requestAnimationFrame: a gap well past 16.7 ms is a
 *  frame the main thread was too busy to paint. */
const frameGaps: number[] = [];
let lastFrame = 0;
function frameLoop(now: number): void {
  if (measuring && lastFrame > 0) frameGaps.push(now - lastFrame);
  lastFrame = now;
  requestAnimationFrame(frameLoop);
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stats(values: number[]): { n: number; mean: number; p50: number; p95: number; max: number } {
  if (values.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    n: values.length,
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]!),
  };
}

function cardEl(ticketId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.node-card[data-node-id="ticket:${ticketId}"]`);
}

function viewportEl(): HTMLElement | null {
  return root.querySelector<HTMLElement>(".canvas-viewport");
}

function pointer(type: string, target: Element, x: number, y: number): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  );
}

function detailTitle(): string | null {
  return root.querySelector(".detail-open .detail-title")?.textContent ?? null;
}

/**
 * The end of the rendering step of the frame that carries a change: a
 * message posted during that frame's animation callbacks lands just after.
 * A change made inside them is in this frame; one made in a handler, the
 * next.
 */
function frameRendered(inFrame: boolean): Promise<void> {
  return new Promise((resolve) => {
    const post = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    };
    if (inFrame) post();
    else nativeFrame(post);
  });
}

/**
 * One card click, the way the canvas reads a tap: pointerdown and pointerup
 * on the card with no move between. Timed from the press to the end of the
 * frame that paints the Detail naming the card, whether the checkout renders
 * in the handler or in the next animation frame.
 */
async function clickCard(ticketId: string): Promise<{ total: number; sync: number; renders: number } | null> {
  const el = cardEl(ticketId);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const x = box.left + 20;
  const y = box.top + 12;
  const rendersBefore = renders;
  const shown = new Promise<boolean>((resolve) => (titleWatch = { id: ticketId, shown: resolve }));
  const t0 = performance.now();
  pointer("pointerdown", el, x, y);
  pointer("pointerup", el, x, y);
  const sync = performance.now() - t0;
  const inFrame = await Promise.race([shown, sleep(5_000).then(() => null)]);
  if (inFrame === null) {
    titleWatch = null;
    return null;
  }
  await frameRendered(inFrame);
  return { total: performance.now() - t0, sync, renders: renders - rendersBefore };
}

/**
 * One card drag: a press on the card, a move per frame (the rate a real
 * pointer delivers them), and a release. Each move is timed twice: the
 * handler's synchronous cost, and from dispatch to the next frame.
 */
async function dragCard(
  ticketId: string,
  moves: number,
): Promise<{ sync: number[]; toFrame: number[]; moved: boolean; renders: number }> {
  const el = cardEl(ticketId);
  const viewport = viewportEl();
  const sync: number[] = [];
  const toFrame: number[] = [];
  if (!el || !viewport) return { sync, toFrame, moved: false, renders: 0 };
  const startLeft = parseFloat(el.style.left);
  const startTop = parseFloat(el.style.top);
  const box = el.getBoundingClientRect();
  const x = box.left + 20;
  const y = box.top + 12;
  const rendersBefore = renders;
  pointer("pointerdown", el, x, y);
  await nextFrame();
  for (let i = 1; i <= moves; i++) {
    const t0 = performance.now();
    pointer("pointermove", viewport, x + i * 3, y + i * 2);
    sync.push(performance.now() - t0);
    await nextFrame();
    toFrame.push(performance.now() - t0);
  }
  pointer("pointerup", viewport, x + moves * 3, y + moves * 2);
  const now = cardEl(ticketId);
  const moved =
    now !== null &&
    parseFloat(now.style.left) > startLeft &&
    parseFloat(now.style.top) > startTop;
  return { sync, toFrame, moved, renders: renders - rendersBefore };
}

async function run(): Promise<Record<string, unknown>> {
  requestAnimationFrame(frameLoop);
  // The boot snapshot paints now; the socket opens and the server starts.
  app.start();
  startServer();
  // Warm up: the first mount, the first frames, the edge layout.
  await sleep(2_500);
  measuring = true;
  const start = performance.now();
  const end = start + DURATION_MS;

  // A third of the window quiet (churn only), then clicks, then drags, all
  // under the same churn.
  await sleep(DURATION_MS / 3);

  const clickTimes: number[] = [];
  const clickSync: number[] = [];
  let clickRenders = 0;
  let clicksMissed = 0;
  const targets = [...RUNNING, ...DONE.slice(0, 6), ...WAITING];
  for (let i = 0; i < 20 && performance.now() < end - DURATION_MS / 4; i++) {
    const result = await clickCard(targets[i % targets.length]!);
    if (result) {
      clickTimes.push(result.total);
      clickSync.push(result.sync);
      clickRenders += result.renders;
    } else {
      clicksMissed += 1;
    }
    await sleep(150 + ((i * 37) % 200));
  }

  const dragSync: number[] = [];
  const dragFrame: number[] = [];
  let dragRenders = 0;
  let dragMoved = true;
  for (const id of ["t-18", "t-19"]) {
    const result = await dragCard(id, 60);
    dragSync.push(...result.sync);
    dragFrame.push(...result.toFrame);
    dragRenders += result.renders;
    dragMoved &&= result.moved;
    await sleep(300);
  }

  const left = end - performance.now();
  if (left > 0) await sleep(left);
  measuring = false;
  const elapsed = performance.now() - start;
  stopServer();
  app.dispose();

  const renderStats = stats(renderMs);
  const frames = stats(frameGaps);
  return {
    durationMs: Math.round(elapsed),
    snapshotsPerSec: SNAPSHOTS_PER_SEC,
    cards: root.querySelectorAll(".node-card").length,
    domNodes: root.getElementsByTagName("*").length,
    renders,
    rendersPerSec: Math.round((renders / (elapsed / 1000)) * 100) / 100,
    renderMs: { mean: renderStats.mean, p50: renderStats.p50, p95: renderStats.p95, max: renderStats.max },
    modelMs: stats(modelMs),
    renderLayoutMs: stats(renderLayoutMs),
    renderBusyPct: Math.round((renderLayoutMs.reduce((a, b) => a + b, 0) / elapsed) * 10_000) / 100,
    longestTaskMs: Math.round(Math.max(0, ...longTasks)),
    longTasksOver50ms: longTasks.filter((d) => d > 50).length,
    frameGapMs: { p50: frames.p50, p95: frames.p95, max: frames.max },
    framesOver50ms: frameGaps.filter((g) => g > 50).length,
    clickToDetailMs: (({ n, p50, p95, max }) => ({ n, p50, p95, max }))(stats(clickTimes)),
    clickSyncMs: stats(clickSync),
    rendersDuringClicks: clickRenders,
    dragMoveMs: (({ n, mean, p95, max }) => ({ n, mean, p95, max }))(stats(dragSync)),
    dragMoveToFrameMs: stats(dragFrame),
    rendersDuringDrags: dragRenders,
    sanity: {
      detailOpened: clickTimes.length > 0 && clicksMissed === 0,
      clicksMissed,
      dragMoved,
      longTaskApi: typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes.includes("longtask"),
      snapshotsPushed: seq - 1,
      focusCalls,
    },
  };
}

async function report(body: Record<string, unknown>): Promise<void> {
  await fetch("/report", { method: "POST", body: JSON.stringify(body) });
}

run().then(report, (err: unknown) =>
  report({ error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) }),
);
