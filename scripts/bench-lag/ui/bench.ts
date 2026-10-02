/**
 * The lag bench's UI half (issue #157): mounts the real ConsoleView over the
 * real ConsoleSession, wired the way ui/src/main.ts wires them, with the
 * network replaced by seams that answer in a task of their own within a few
 * milliseconds, as a localhost fetch does. With the server out of the
 * picture every millisecond measured here is the page's own: the render,
 * the morph, the layout the canvas edges force, and whatever else the main
 * thread does per store change.
 *
 * The churn is the app's own. The real Vitals and TerminalSurface stores run
 * their real 2 s polls against fake fetches whose answers change every time,
 * and the stream seam pushes a fresh snapshot (parsed from JSON, as the SSE
 * client would) `sps` times a second, each with a moved Conversation turn
 * line and a new pool log line. While that runs the page clicks cards the
 * way an operator does (pointerdown and pointerup on the card, which is the
 * canvas's tap) and drags one, timing each.
 *
 * The page imports the target checkout through the `@console` alias
 * (vite.config.ts), so the same file measures any checkout whose ConsoleView
 * and ConsoleSession keep the constructor seams main.ts uses. The stores ask
 * for renders and send their background polls through `@bench/frame` and
 * `@bench/poll`: the checkout's own render loop and request cap where it has
 * them (issue #157), else a render per ask and no cap, as its main.ts does.
 * It POSTs its report to `/report` on its own origin; ui-bench.ts serves
 * both.
 */

import "@console/styles.css";
import { ConsoleSession } from "@console/session";
import { ConsoleView, type Handlers } from "@console/view";
import { Vitals } from "@console/vitals";
import { TerminalSurface } from "@console/terminal";
import { RenderLoop } from "@bench/frame";
import { BACKGROUND_REQUESTS, RequestLimiter } from "@bench/poll";
import type {
  ConversationView,
  EnrichedSnapshot,
  EnrichedTicketState,
  SettingsResponse,
  TicketActivityResponse,
  TicketEvent,
  TicketEventsResponse,
  TicketGradeSummary,
} from "@console/project";
import type { LogChunk } from "@console/log-pane";

const params = new URLSearchParams(location.search);
const DURATION_MS = Number(params.get("dur") ?? 30_000);
const SNAPSHOTS_PER_SEC = Number(params.get("sps") ?? 1);

// ---------------------------------------------------------------------------
// Fixture: 20 ticket cards and 3 Conversations, the shape of a pool partway
// through a day's run.
// ---------------------------------------------------------------------------

const DONE = Array.from({ length: 12 }, (_, i) => `t-${String(i + 1).padStart(2, "0")}`);
const RUNNING = ["t-13", "t-14", "t-15", "t-16"];
const WAITING = ["t-17", "t-18", "t-19", "t-20"];
const CONVERSATIONS = ["conv-1", "conv-2", "conv-3"];
const started = new Date(Date.now() - 20 * 60_000).toISOString();
/** The done tickets whose branches have not landed: the Merge queue. */
const UNMERGED = new Set(["t-10", "t-11", "t-12"]);

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join("\n");
}

function ticket(id: string, overrides: Partial<EnrichedTicketState>): EnrichedTicketState {
  const base = {
    id,
    title: `Ticket ${id}: make the thing behave under load`,
    blockedBy: [] as string[],
    status: "ready" as const,
    mergeState: null,
    enlisted: false,
    heldPane: null,
    assignment: { harness: "claude", model: "opus", drivers: "implement" },
    liveAttempt: null,
    ...overrides,
  };
  const eligible = base.liveAttempt === null && base.status !== "done";
  return {
    ...base,
    reassign: {
      eligible,
      reason: eligible ? null : "an Attempt is in flight",
      verify: null,
      sources: { harness: "default", model: "pinned", drivers: "default" },
    },
  } as EnrichedTicketState;
}

function conversation(id: string, seq: number, i: number): ConversationView {
  const waiting = (seq + i) % 3 === 0;
  return {
    id,
    title: `Conversation ${id}`,
    status: "live",
    spawnedBy: null,
    assignment: { harness: "claude", model: "opus", drivers: "implement" },
    paneId: `pane-${id}`,
    branch: `pool/bench/${id}`,
    turn: waiting
      ? { state: "waiting", lastLine: `waiting on you (${seq})`, idleSince: new Date().toISOString() }
      : { state: "working", lastLine: `editing src/module-${(seq + i) % 17}.ts`, idleSince: null },
    children: [],
    enlisted: false,
    ending: false,
  } as ConversationView;
}

const poolLog: string[] = Array.from({ length: 150 }, (_, i) => `[pool] boot line ${i + 1}`);

function snapshot(seq: number): EnrichedSnapshot {
  const tickets: EnrichedTicketState[] = [
    ...DONE.map((id, i) =>
      ticket(id, {
        status: "done",
        // A chain of done work, so the canvas has edges to route.
        blockedBy: i > 0 && i % 3 !== 0 ? [DONE[i - 1]!] : [],
        mergeState: UNMERGED.has(id) ? "queued" : null,
      }),
    ),
    ...RUNNING.map((id, i) =>
      ticket(id, {
        status: "in-progress",
        blockedBy: [DONE[i * 3 + 2]!],
        liveAttempt: { attempt: 1 + (i % 2), paneId: `pane-${id}`, role: "agent", startedAt: started },
      }),
    ),
    ...WAITING.map((id, i) =>
      ticket(id, {
        status: "ready",
        blockedBy: i === 3 ? [RUNNING[0]!, RUNNING[1]!] : [RUNNING[i]!],
      }),
    ),
  ];
  const outcomes: EnrichedSnapshot["state"]["outcomes"] = {};
  for (const id of DONE) {
    outcomes[id] = { status: "done", summary: lines(`outcome of ${id}`, 12), commitSha: "abc1234" };
  }
  return {
    seq,
    phase: "running",
    poolName: "bench/lag",
    poolTitle: "Lag bench",
    poolDir: "/tmp/bench-pool",
    finishedTerminals: 2,
    spawnUsage: { spawnedThisRun: 6, perAttempt: 5, perRun: 20 },
    pendingSpawns: [],
    heldSpawns: [],
    stewardBudget: { budget: 5, used: {} },
    state: {
      tickets,
      conversations: CONVERSATIONS.map((id, i) => conversation(id, seq, i)),
      log: [...poolLog],
      outcomes,
      interrupts: [],
      mergeQueue: [...UNMERGED].map((ticketId) => ({ ticketId, state: "queued" as const })),
      queuedAnswers: [],
      config: { terminal: "herdr", defaults: { harness: "claude", model: "opus" } },
    },
  } as EnrichedSnapshot;
}

/** A few hundred events: several attempts' worth of launches, exits,
 *  grades, checkpoints and answers, which is what a long-lived ticket's
 *  events file reads like by the afternoon. */
function events(id: string): TicketEventsResponse {
  const list: TicketEvent[] = [];
  const t0 = Date.now() - 3 * 3600_000;
  let n = 0;
  const ev = (attempt: number, kind: TicketEvent["kind"], payload: Record<string, unknown> = {}) =>
    list.push({ at: new Date(t0 + n++ * 30_000).toISOString(), attempt, kind, payload });
  for (let attempt = 1; attempt <= 8; attempt++) {
    ev(attempt, "scheduled");
    for (let r = 0; r < 4; r++) ev(attempt, "launch-retried", { reason: "the wrapper never ran" });
    ev(attempt, "spawned", { paneId: `pane-${id}` });
    for (let k = 0; k < 10; k++) {
      ev(attempt, "checkpoint", { brief: lines("brief", 4) });
      ev(attempt, "answered", { action: "resume", note: "carry on with the smaller change" });
    }
    ev(attempt, "exited", { code: 0 });
    ev(attempt, "graded", {
      score: 6 + (attempt % 4),
      verdict: attempt % 3 ? "pass" : "flag",
      reasons: lines("reason", 6),
    });
    for (let k = 0; k < 6; k++) ev(attempt, "merge-conflict", { files: [`src/f${k}.ts`, `src/g${k}.ts`] });
  }
  return { events: list, attempts: [], reconstructed: false, spec: `# ${id}\n\n${lines("spec", 40)}` };
}

const EVENTS = new Map<string, TicketEventsResponse>();
function eventsFor(id: string): TicketEventsResponse {
  let cached = EVENTS.get(id);
  if (!cached) {
    cached = events(id);
    EVENTS.set(id, cached);
  }
  // A fresh object per fetch, as a parsed response would be.
  return JSON.parse(JSON.stringify(cached)) as TicketEventsResponse;
}

const LOG_TEXT = lines("[agent] raw log output, a tool call or a diff hunk", 3000);

function logChunk(offset: number, end?: number): LogChunk {
  const total = LOG_TEXT.length;
  const from = Math.min(offset, total);
  const to = Math.min(end ?? total, total);
  return {
    content: LOG_TEXT.slice(from, to),
    offset: from,
    nextOffset: to,
    totalSize: total,
    attempts: [
      { attempt: 1, streamFile: null },
      { attempt: 2, streamFile: null },
    ],
  };
}

function grades(): Record<string, TicketGradeSummary> {
  const out: Record<string, TicketGradeSummary> = {};
  for (const [i, id] of DONE.entries()) {
    out[id] = { attempt: 1, score: 6 + (i % 4), verdict: i % 5 ? "pass" : "flag", winner: 1 };
  }
  return out;
}

let activityTick = 0;
function activity(ticketId: string): TicketActivityResponse {
  activityTick += 1;
  const files = Array.from({ length: 3 + (activityTick % 5) }, (_, i) => `src/area-${i}/file-${i}.ts`);
  return {
    ticketId,
    running: true,
    diff: { added: 40 + activityTick, removed: 10 + (activityTick % 13), files },
    log: { size: 100_000 + activityTick * 512, mtime: new Date().toISOString() },
    lastEventAt: new Date(Date.now() - 5_000).toISOString(),
  };
}

let peekTick = 0;
function peekText(ticketId: string): string {
  peekTick += 1;
  return [
    `● ${ticketId}: reading src/module-${peekTick % 23}.ts`,
    `  ⎿  ${peekTick % 40} lines`,
    `● running bun test (${peekTick})`,
    "  ⎿  412 pass, 0 fail",
    "> ",
  ].join("\n");
}

const SETTINGS: SettingsResponse = {
  pool: {
    path: "/tmp/bench-pool/console.json",
    config: { defaults: { harness: "claude", model: "opus" }, port: 4300 },
    bootOnly: ["selection", "terminal", "port"],
    effective: { port: 4300, terminal: "herdr", stale: [] },
  },
  machine: {
    path: "/home/me/.agent-graphs/defaults.json",
    defaults: { harness: "claude" },
    own: { harness: "claude" },
  },
  harnesses: ["claude", "opencode"],
};

/**
 * A seam's answer, in a task of its own the way a fetch response arrives:
 * never inside the caller's task. A microtask would chain every poll's
 * answer (seven peeks, four activities, the grades) and its render into the
 * one task that asked, and report a long task the real app never has.
 */
function soon<T>(make: () => T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(make()), 0));
}

/** A poll's answer, a few milliseconds out as a localhost fetch would be, so
 *  a burst of polls lands spread over tasks rather than back to back. */
function polled<T>(make: () => T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(make()), 1 + Math.random() * 8));
}

// ---------------------------------------------------------------------------
// Mount: main.ts's bootstrap with the network replaced.
// ---------------------------------------------------------------------------

const root = document.getElementById("app") as HTMLElement;
let seq = 1;
let current = snapshot(seq);
let streamTimer: ReturnType<typeof setInterval> | null = null;
let focusCalls = 0;

// Whether the page is inside an animation frame's callbacks, where a render
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

// main.ts's render loop and background cap, or the unbatched wiring of a
// checkout without them.
const loop = new RenderLoop(() => render());
const requestRender = (): void => loop.request();
const background = new RequestLimiter(BACKGROUND_REQUESTS);

const vitals = new Vitals({
  fetch: (ticketId) => background.run(() => polled(() => activity(ticketId))),
  onChange: requestRender,
});

const terminal = new TerminalSurface({
  peek: (ticketId) =>
    background.run(() =>
      polled(() => ({ ticket: ticketId, paneId: `pane-${ticketId}`, text: peekText(ticketId) })),
    ),
  focus: () =>
    soon(() => {
      focusCalls += 1;
    }),
  onChange: requestRender,
});

const session = new ConsoleSession({
  getState: () => soon(() => current),
  getEvents: (id) => soon(() => eventsFor(id)),
  getTicket: (id) => soon(() => ({ id, body: `# ${id}\n\n${lines("spec paragraph", 60)}` })),
  getGrades: () => background.run(() => polled(() => grades())),
  getLog: (_ticketId, _attempt, offset, end) => soon(() => logChunk(offset, end)),
  answer: () => soon(() => current),
  stop: () => soon(() => undefined),
  restart: () => soon(() => ({ ok: true, port: 4300 }) as never),
  keepTalking: () => soon(() => ({ ok: true }) as never),
  closeFinishedTerminals: () => soon(() => ({ closed: 0 }) as never),
  stream: (handlers) => {
    // The SSE stream: a fresh snapshot on the pool's cadence, parsed from
    // its JSON as the client's EventSource handler parses it.
    streamTimer = setInterval(() => {
      seq += 1;
      poolLog.push(`[pool] snapshot ${seq}: a turn moved`);
      current = snapshot(seq);
      handlers.onSnapshot(JSON.parse(JSON.stringify(current)) as EnrichedSnapshot);
    }, 1000 / SNAPSHOTS_PER_SEC);
    return () => {
      if (streamTimer !== null) clearInterval(streamTimer);
    };
  },
  vitals,
  terminal,
  onChange: requestRender,
});

const consoleView = new ConsoleView({
  onAnswer: (ticketId, action, note) => session.answer(ticketId, action, note),
  onChange: requestRender,
  onFocusTerminal: (ticketId) => terminal.focus(ticketId),
  onListPanes: () => soon(() => ({ panes: [] })),
  onEnlist: () => soon(() => ({ ok: true }) as never),
  onGetSettings: () => soon(() => SETTINGS),
  onSavePoolSettings: () => soon(() => SETTINGS),
  onSaveMachineDefaults: () => soon(() => SETTINGS),
  onReassign: () => soon(() => ({ applied: [], skipped: [], snapshot: current }) as never),
  onAdoptHeldSpawn: (id) => soon(() => ({ id }) as never),
  onDiscardHeldSpawn: (id) => soon(() => ({ id }) as never),
  onHoldPendingSpawn: (id) => soon(() => ({ id }) as never),
  onDiscardPendingSpawn: (id) => soon(() => ({ id }) as never),
  onStart: () => soon(() => conversation("conv-new", 0, 0)),
  onEnd: () => soon(() => undefined),
} as ConstructorParameters<typeof ConsoleView>[0]);

const handlers: Handlers = {
  onToggleLog: () => session.toggleLog(),
  onToggleInspector: () => session.toggleInspector(),
  onSelectNode: (nodeId) => session.select(nodeId),
  onSelectAttempt: (ticketId, attempt) => session.logs.selectAttempt(ticketId, attempt),
  onSelectStream: (ticketId, attempt) => session.logs.selectStream(ticketId, attempt),
  onLoadEarlier: (ticketId, attempt) => void session.logs.loadEarlier(ticketId, attempt),
  onAnswer: () => {},
  onKeepTalking: () => {},
  onSelectTab: (ticketId, tab) => session.selectTab(ticketId, tab),
  onArmStop: () => {},
  onCancelStop: () => {},
  onConfirmStop: () => {},
  onArmRestart: () => {},
  onCancelRestart: () => {},
  onConfirmRestart: () => {},
  onArmCloseTerminals: () => {},
  onCancelCloseTerminals: () => {},
  onConfirmCloseTerminals: () => {},
};

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

function render(): void {
  const t0 = performance.now();
  const model = session.model(consoleView.conversationEndState());
  const tm = performance.now();
  consoleView.render(root, model, handlers);
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
  render();
  session.setSnapshot(current);
  session.connect();
  // Warm up: the first mount, the first poll answers, the edge layout.
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
  if (streamTimer !== null) clearInterval(streamTimer);
  vitals.dispose();
  terminal.dispose();

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
