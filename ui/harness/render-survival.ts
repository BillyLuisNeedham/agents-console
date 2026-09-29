/**
 * Render-survival harness: mounts the real ConsoleView over the real
 * ConsoleSession with hand-settled fake seams, puts the page into a state an
 * operator would (scrolled regions, a focused note field with a caret, a
 * panned canvas), then re-renders it the way the app does on every poll tick
 * and snapshot, and records what survived. `bun harness/run.ts` builds this
 * page, opens it in headless Chromium, and prints the report the page writes
 * into #report.
 *
 * Nothing here is a bun test: the assertions need a layout engine (scroll
 * metrics, focus, pointer capture), which the DOM-less suite cannot give.
 */

import "../src/styles.css";
import { ConsoleSession } from "../src/session";
import { ConsoleView, type Handlers } from "../src/view";
import type {
  EnrichedSnapshot,
  EnrichedTicketState,
  ConversationView,
  SettingsResponse,
  TicketEvent,
  TicketEventsResponse,
} from "../src/project";
import type { LogChunk } from "../src/log-pane";

// ---------------------------------------------------------------------------
// Fixture: a pool rich enough to render every scroll region the app has.
// ---------------------------------------------------------------------------

const SELECTED_TICKET = "t-3";
const DONE_TICKET = "t-2";
const CHANGED_TICKET = "t-1";
const TRAY_NOTE = `.needs-input-row[data-key="ticket:${SELECTED_TICKET}"] textarea.needs-input-note`;
/** The canvas keys a ticket's card as "ticket:<id>"; the session's select takes the card id. */
const card = (ticketId: string): string => `ticket:${ticketId}`;

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join("\n");
}

/** A Ticket's own agent live on the snapshot, as the engine registers it. */
function agentAttempt(attempt: number, paneId: string | null): EnrichedTicketState["liveAttempt"] {
  return { attempt, paneId, role: "agent", startedAt: "2026-09-23T10:00:00.000Z" };
}

function ticket(id: string, overrides: Partial<EnrichedTicketState> = {}): EnrichedTicketState {
  const base = {
    id,
    title: `ticket ${id}`,
    blockedBy: [],
    status: "ready" as const,
    mergeState: null,
    enlisted: false,
    assignment: { harness: "claude", model: "opus", drivers: "implement" },
    liveAttempt: null,
    ...overrides,
  };
  // The Reassign view the wire carries (issue #126): derived so a done or
  // in-flight fixture ticket is not claimed as reassignable.
  const eligible = base.liveAttempt === null && base.status !== "done";
  return {
    ...base,
    reassign: base.reassign ?? {
      eligible,
      reason: eligible ? null : "an Attempt is in flight",
      verify: null,
      sources: { harness: "default", model: "pinned", drivers: "default" },
    },
  };
}

function conversation(id: string, overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id,
    title: `conversation ${id}`,
    status: "live",
    spawnedBy: null,
    assignment: { harness: "claude", model: "opus", drivers: "implement" },
    paneId: null,
    branch: null,
    turn: { state: "working", lastLine: "", idleSince: null },
    children: [],
    enlisted: false,
    ...overrides,
  };
}

function snapshot(seq: number, changedTitle: string | null): EnrichedSnapshot {
  const tickets = [
    ticket("t-1", {
      title: changedTitle ?? "ticket t-1",
      status: "in-progress",
      liveAttempt: agentAttempt(1, null),
    }),
    ticket("t-2", { status: "done" }),
    ticket("t-3", {
      status: "in-progress",
      blockedBy: ["t-2"],
      liveAttempt: agentAttempt(2, null),
    }),
    ticket("t-4", { status: "in-progress", blockedBy: ["t-1"], liveAttempt: agentAttempt(1, null) }),
    ticket("t-5", { status: "in-progress", blockedBy: ["t-1", "t-2"], liveAttempt: agentAttempt(1, null) }),
    ticket("t-6", { status: "ready", blockedBy: ["t-3", "t-4"] }),
    ticket("t-7", { status: "ready", blockedBy: ["t-5"] }),
    // Extra interrupted tickets so the Needs input tray overflows its max-height.
    ...Array.from({ length: 12 }, (_, i) =>
      ticket(`t-${i + 8}`, { status: "in-progress", liveAttempt: agentAttempt(1, null) }),
    ),
    // Extra ready tickets so the Reassign dialog's row list overflows its own
    // max-height: only a ticket with no Attempt in flight is reassignable, and
    // every in-progress ticket above carries one.
    ...Array.from({ length: 12 }, (_, i) =>
      // One of them enlisted, so the dialog renders its "harness only" tag.
      ticket(`t-${i + 20}`, { status: "ready", enlisted: i === 0 }),
    ),
  ];
  return {
    seq,
    phase: "running",
    poolName: "harness/render-survival",
    poolTitle: null,
    poolDir: "/tmp/harness-pool",
    finishedTerminals: 0,
    spawnUsage: { spawnedThisRun: 20, perAttempt: 5, perRun: 20 },
    // Enough Held spawns (issue #149) that the list scrolls under its head,
    // the first with a long body that scrolls once expanded.
    heldSpawns: Array.from({ length: 10 }, (_, i) => ({
      id: `held-${i + 1}`,
      parentId: "t-1",
      origin: "ticket" as const,
      kind: "ticket" as const,
      title: `Held proposal ${i + 1}`,
      body: TICKET_BODY,
      blockedBy: [],
      blocks: i === 0 ? ("all" as const) : null,
      reason: i % 2 ? ("per-attempt" as const) : ("per-run" as const),
      at: "2026-09-29T10:00:00Z",
      adopting: false,
    })),
    state: {
      tickets,
      conversations: Array.from({ length: 30 }, (_, i) =>
        conversation(`c-${i + 1}`, {
          turn:
            i % 3 === 0
              ? { state: "waiting", lastLine: "waiting on you", idleSince: "2026-09-21T10:00:00Z" }
              : { state: "working", lastLine: `working on ${i}`, idleSince: null },
        }),
      ),
      log: Array.from({ length: 120 }, (_, i) => `[log] pool line ${i + 1}`),
      outcomes: {
        [DONE_TICKET]: {
          status: "done",
          summary: lines("outcome summary", 80),
          commitSha: "abc1234",
        },
      },
      interrupts: [
        { ticketId: "t-3", kind: "checkpoint", body: lines("checkpoint brief", 60) },
        { ticketId: "t-4", kind: "crash", body: lines("crash log", 10) },
        { ticketId: "t-5", kind: "review", body: lines("review", 10) },
        { ticketId: "t-1", kind: "merge-approval", body: lines("merge", 10) },
        ...Array.from({ length: 12 }, (_, i) => ({
          ticketId: `t-${i + 8}`,
          kind: "crash" as const,
          body: lines("crash", 3),
        })),
      ],
      mergeQueue: [],
      queuedAnswers: [],
      config: { terminal: "herdr" },
    },
  };
}

function events(id: string): TicketEventsResponse {
  const at = "2026-09-21T10:00:00Z";
  const ev = (attempt: number, kind: TicketEvent["kind"]): TicketEvent => ({
    at,
    attempt,
    kind,
    payload: {},
  });
  const list: TicketEvent[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    list.push(ev(attempt, "scheduled"), ev(attempt, "spawned"));
    for (let i = 0; i < 12; i++) list.push(ev(attempt, "launch-retried"));
    list.push(ev(attempt, attempt === 1 ? "exited" : "checkpoint"));
  }
  return { events: list, attempts: [], reconstructed: false, spec: `spec for ${id}` };
}

const LOG_TEXT = lines("raw log", 400);

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

// The Settings pane's read, which the Reassign surfaces borrow for their
// harness list (issue #126).
const SETTINGS: SettingsResponse = {
  pool: {
    path: "/tmp/harness-pool/console.json",
    config: { defaults: { harness: "claude", model: "opus" }, port: 4300 },
    bootOnly: ["roster", "agents", "selection", "terminal", "port"],
    effective: { port: 4300, terminal: "herdr", stale: [] },
  },
  machine: {
    path: "/home/me/.agent-graphs/defaults.json",
    defaults: { harness: "claude" },
    own: { harness: "claude" },
  },
  harnesses: ["claude", "opencode"],
};

const TICKET_BODY =
  "# A long spec\n\n" +
  Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1} of the spec, long enough to wrap.`).join(
    "\n\n",
  ) +
  "\n\n```text\n" +
  lines("code", 80) +
  "\n```\n";

// ---------------------------------------------------------------------------
// Mount: the app's bootstrap, minus the network and the timers.
// ---------------------------------------------------------------------------

const root = document.getElementById("app") as HTMLElement;
let current = snapshot(0, null);

const session = new ConsoleSession({
  getState: () => Promise.resolve(current),
  getEvents: (id) => Promise.resolve(events(id)),
  getTicket: (id) => Promise.resolve({ id, body: TICKET_BODY }),
  getGrades: () => Promise.resolve({}),
  getLog: (_ticketId, _attempt, offset, end) => Promise.resolve(logChunk(offset, end)),
  answer: () => Promise.resolve(current),
  stop: () => Promise.resolve(),
  restart: () => Promise.resolve({ ok: true, port: 4300 }),
  stream: () => () => {},
  vitals: { update() {}, state: () => ({}) },
  terminal: { update() {}, state: () => ({}) },
  onChange: () => render(),
});

const view = new ConsoleView({
  onAnswer: () => Promise.resolve(),
  onChange: () => render(),
  onFocusTerminal: () => Promise.resolve(true),
  onListPanes: () =>
    Promise.resolve({
      panes: Array.from({ length: 16 }, (_, i) => ({
        paneId: `pane-${i + 1}`,
        harness: i % 2 ? "claude" : null,
        status: "idle",
        title: `pane ${i + 1}`,
        directory: `/tmp/work/${i + 1}`,
        branch: `branch-${i + 1}`,
        eligible: i % 4 !== 0,
        reason: i % 4 === 0 ? "not a checkout" : null,
      })),
    }),
  onEnlist: () => Promise.resolve({ ok: true } as never),
  onGetSettings: () => Promise.resolve(SETTINGS),
  onSavePoolSettings: () => Promise.resolve(SETTINGS),
  onAdoptHeldSpawn: (id) => Promise.resolve({ id }),
  onDiscardHeldSpawn: (id) => Promise.resolve({ id }),
  onSaveMachineDefaults: () => Promise.resolve(SETTINGS),
  onReassign: () =>
    Promise.resolve({ applied: [], skipped: [], snapshot: current }),
  onStart: () => Promise.resolve(conversation("c-new")),
  onEnd: () => Promise.resolve(),
});

const handlers: Handlers = {
  onToggleLog: () => session.toggleLog(),
  onToggleInspector: () => session.toggleInspector(),
  onSelectNode: (id) => session.select(id),
  onSelectAttempt: (t, a) => session.logs.selectAttempt(t, a),
  onSelectStream: (t, a) => session.logs.selectStream(t, a),
  onLoadEarlier: (t, a) => void session.logs.loadEarlier(t, a),
  onAnswer: () => {},
  onSelectTab: (t, tab) => session.selectTab(t, tab),
  onArmStop: () => {},
  onCancelStop: () => {},
  onConfirmStop: () => {},
  onArmRestart: () => {},
  onCancelRestart: () => {},
  onConfirmRestart: () => {},
};

let renders = 0;
function render(): void {
  renders += 1;
  view.render(root, session.model(view.conversationEndState()), handlers);
}

// ---------------------------------------------------------------------------
// Survival checks
// ---------------------------------------------------------------------------

/** The app's scroll regions (styles.css `overflow: auto`) that live code renders. */
const SCROLL_SELECTORS = [
  ".detail-open",
  ".interrupt-body",
  ".log-pane-content",
  ".detail-md pre",
  ".detail-pre",
  ".log-lines",
  // The Needs input tray's rows, which scroll under its fixed head (issue #147).
  ".needs-input-rows",
  ".conversations-tray",
  ".enlist-picker",
  // The Reassign bulk dialog's row list (issue #126): its own scroll region
  // so the head and the form below it stay put however many tickets list.
  ".reassign-rows",
  // The Held spawns list and an expanded proposal's body (issue #149).
  ".held-spawns-list",
  ".held-spawn-body",
];

/** Selectors in styles.css that no live module renders; listed so the
 *  report says why they are absent rather than silently skipping them. */
const DEAD_SELECTORS = [".thread-list", ".interrupt-raw pre", ".card-pre", ".channel-pre", ".inspector-empty"];

interface Check {
  scenario: string;
  assertion: string;
  pass: boolean | null;
  detail: string;
}

const report: Check[] = [];

function settle(): Promise<void> {
  // Let the session's fetch continuations run. Timers only: under Chromium's
  // --virtual-time-budget a requestAnimationFrame may never fire.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settleAll(): Promise<void> {
  for (let i = 0; i < 6; i++) await settle();
}

function q<T extends Element>(selector: string): T | null {
  return root.querySelector<T>(selector);
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

async function runScenario(name: string, setup: () => Promise<void>): Promise<void> {
  stage = `${name}: setup`;
  await setup();
  await settleAll();
  render();
  await settle();

  stage = `${name}: scroll`;
  // (a) scroll every region to a nonzero position
  const scrolled: { selector: string; el: HTMLElement; top: number }[] = [];
  for (const selector of SCROLL_SELECTORS) {
    const el = q<HTMLElement>(selector);
    if (!el) {
      report.push({ scenario: name, assertion: `scroll ${selector}`, pass: null, detail: "absent in this scenario" });
      continue;
    }
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) {
      report.push({
        scenario: name,
        assertion: `scroll ${selector}`,
        pass: null,
        detail: `not scrollable in fixture (scrollHeight ${el.scrollHeight}, clientHeight ${el.clientHeight})`,
      });
      continue;
    }
    const top = Math.max(1, Math.floor(max / 2));
    el.scrollTop = top;
    // The browser fires scroll asynchronously; fire it now so a listener
    // (the log pane's pin tracker) sees the position before the next render.
    el.dispatchEvent(new Event("scroll"));
    scrolled.push({ selector, el, top: el.scrollTop });
  }
  await settle();

  // (b) focus the tray note with a caret mid-text
  const note = q<HTMLTextAreaElement>(TRAY_NOTE);
  let caret: { start: number; end: number } | null = null;
  if (note) {
    note.value = "hello morph world";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    // Without scrolling: the rows were just scrolled on purpose, and the
    // two-line rows (issue #147) can put this note out of view, where a
    // plain focus() would scroll the rows to it before any render ran.
    note.focus({ preventScroll: true });
    note.setSelectionRange(5, 5);
    caret = { start: 5, end: 5 };
  }

  // (c) pan the canvas by dragging blank viewport space
  const viewport = q<HTMLElement>(".canvas-viewport");
  const world = q<HTMLElement>(".canvas-world");
  let transform: string | null = null;
  if (viewport && world) {
    const rect = viewport.getBoundingClientRect();
    const x = rect.right - 20;
    const y = rect.bottom - 20;
    pointer("pointerdown", viewport, x, y);
    pointer("pointermove", viewport, x - 20, y - 15);
    pointer("pointermove", viewport, x - 60, y - 45);
    pointer("pointerup", viewport, x - 60, y - 45);
    transform = world.style.transform;
  }

  // (d) node identity
  const identities: { label: string; selector: string; el: Element }[] = [];
  for (const [label, selector] of [
    ["changed card", `.node-card[data-node-id="${card(CHANGED_TICKET)}"]`],
    ["unchanged card", `.node-card[data-node-id="${card("t-6")}"]`],
    ["detail panel", ".detail-open"],
    ["needs-input tray", ".needs-input-tray"],
    ["conversations tray", ".conversations-tray"],
    ["canvas viewport", ".canvas-viewport"],
  ] as const) {
    const el = q(selector);
    if (el) identities.push({ label, selector, el });
    else report.push({ scenario: name, assertion: `identity ${label}`, pass: null, detail: "absent" });
  }

  // A fullscreen Detail (the scenario's setup toggled it): its class and the
  // top edge measured from the toolbar must both be rendered from state.
  const detailOpen = q<HTMLElement>(".detail-open");
  const fullscreen =
    detailOpen?.classList.contains("detail-fullscreen")
      ? { top: detailOpen.style.top }
      : null;

  stage = `${name}: renders`;
  // (e) render N times unchanged, then once with a changed model
  const failures = new Map<string, string>();
  const note_ = (key: string, detail: string) => {
    if (!failures.has(key)) failures.set(key, detail);
  };
  const before = renders;
  for (let pass = 1; pass <= 6; pass++) {
    if (pass === 6) {
      current = snapshot(1, "ticket t-1 (changed)");
      session.setSnapshot(current); // onChange renders, as a live snapshot does
      await settle();
    } else {
      render();
    }
    const tag = pass === 6 ? "changed-model render" : `render ${pass}`;
    for (const s of scrolled) {
      const now = q<HTMLElement>(s.selector);
      const top = now?.scrollTop ?? -1;
      if (top !== s.top) note_(`scroll ${s.selector}`, `${tag}: scrollTop ${top}, expected ${s.top}`);
    }
    if (caret) {
      const active = document.activeElement;
      const start = (active as HTMLTextAreaElement | null)?.selectionStart;
      const end = (active as HTMLTextAreaElement | null)?.selectionEnd;
      if (active !== q(TRAY_NOTE)) note_("focus stays on tray note", `${tag}: activeElement is ${describe(active)}`);
      else if (start !== caret.start || end !== caret.end)
        note_("caret survives", `${tag}: selection ${start}-${end}, expected ${caret.start}-${caret.end}`);
      if (active !== note) note_("focused node identity", `${tag}: activeElement is a new node`);
    }
    if (transform !== null) {
      const now = q<HTMLElement>(".canvas-world")?.style.transform ?? "(no world)";
      if (now !== transform) note_("canvas pan", `${tag}: ${now}, expected ${transform}`);
    }
    for (const id of identities) {
      if (q(id.selector) !== id.el) note_(`identity ${id.label}`, `${tag}: node replaced`);
    }
    if (fullscreen) {
      const now = q<HTMLElement>(".detail-open");
      if (!now?.classList.contains("detail-fullscreen"))
        note_("fullscreen holds", `${tag}: detail-fullscreen class gone`);
      else if (now.style.top !== fullscreen.top)
        note_("fullscreen holds", `${tag}: top ${now.style.top}, expected ${fullscreen.top}`);
    }
  }
  const total = renders - before;

  stage = `${name}: gestures after renders`;
  // (f) gestures after the renders. A handler bound to the viewport per
  // render would stack, so one pan must move the world once and one wheel
  // notch must zoom it once; and a render landing mid-drag must not end the
  // drag, so a card dragged across one lands where both moves put it.
  if (viewport && world) {
    const dragged = q<HTMLElement>(`.node-card[data-node-id="${card("t-6")}"]`);
    if (dragged) {
      const startLeft = parseFloat(dragged.style.left);
      const startTop = parseFloat(dragged.style.top);
      const box = dragged.getBoundingClientRect();
      const x = box.left + 8;
      const y = box.bottom - 8;
      pointer("pointerdown", dragged, x, y);
      pointer("pointermove", viewport, x + 30, y + 20);
      render();
      pointer("pointermove", viewport, x + 60, y + 40);
      pointer("pointerup", viewport, x + 60, y + 40);
      const now = q<HTMLElement>(`.node-card[data-node-id="${card("t-6")}"]`);
      const left = parseFloat(now?.style.left ?? "NaN");
      const top = parseFloat(now?.style.top ?? "NaN");
      const ok = now === dragged && left === startLeft + 60 && top === startTop + 40;
      report.push({
        scenario: name,
        assertion: "card drag survives a render mid-drag",
        pass: ok,
        detail: ok
          ? `moved ${startLeft},${startTop} → ${left},${top} across a render`
          : `moved ${startLeft},${startTop} → ${left},${top}, expected ${startLeft + 60},${startTop + 40}${now === dragged ? "" : " (card replaced)"}`,
      });
    }
    const rect = viewport.getBoundingClientRect();
    const x = rect.right - 20;
    const y = rect.bottom - 20;
    const panBefore = parsePan(world.style.transform);
    pointer("pointerdown", viewport, x, y);
    pointer("pointermove", viewport, x - 20, y - 15);
    pointer("pointermove", viewport, x - 50, y - 35);
    pointer("pointerup", viewport, x - 50, y - 35);
    const panAfter = parsePan(world.style.transform);
    const panOk = panAfter.x === panBefore.x - 50 && panAfter.y === panBefore.y - 35;
    report.push({
      scenario: name,
      assertion: "pan after renders moves once",
      pass: panOk,
      detail: panOk ? `moved by -50,-35 after ${total} renders` : `moved by ${panAfter.x - panBefore.x},${panAfter.y - panBefore.y}, expected -50,-35`,
    });
    const zoomBefore = parsePan(world.style.transform).zoom;
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: x, clientY: y }));
    const zoomAfter = parsePan(world.style.transform).zoom;
    const ratio = zoomAfter / zoomBefore;
    const zoomOk = Math.abs(ratio - Math.exp(0.15)) < 1e-3;
    report.push({
      scenario: name,
      assertion: "wheel after renders zooms once",
      pass: zoomOk,
      detail: zoomOk ? `zoom ×${ratio.toFixed(4)} for one notch` : `zoom ×${ratio.toFixed(4)} for one notch, expected ×${Math.exp(0.15).toFixed(4)}`,
    });
    // Leave the view where the next scenario expects it.
    q<HTMLButtonElement>('.canvas-tools button[title="reset pan and zoom"]')?.click();
  }

  for (const s of scrolled) {
    const key = `scroll ${s.selector}`;
    report.push({ scenario: name, assertion: key, pass: !failures.has(key), detail: failures.get(key) ?? `held at ${s.top} over ${total} renders` });
  }
  if (caret) {
    for (const key of ["focus stays on tray note", "caret survives", "focused node identity"]) {
      report.push({ scenario: name, assertion: key, pass: !failures.has(key), detail: failures.get(key) ?? "ok" });
    }
  } else {
    report.push({ scenario: name, assertion: "focus stays on tray note", pass: null, detail: "tray note absent" });
  }
  if (transform !== null) {
    report.push({ scenario: name, assertion: "canvas pan", pass: !failures.has("canvas pan"), detail: failures.get("canvas pan") ?? `held ${transform}` });
  } else {
    report.push({ scenario: name, assertion: "canvas pan", pass: null, detail: "canvas absent" });
  }
  for (const id of identities) {
    const key = `identity ${id.label}`;
    report.push({ scenario: name, assertion: key, pass: !failures.has(key), detail: failures.get(key) ?? "same node" });
  }
  if (fullscreen) {
    report.push({ scenario: name, assertion: "fullscreen holds", pass: !failures.has("fullscreen holds"), detail: failures.get("fullscreen holds") ?? `class and top ${fullscreen.top} held` });
  }
  stage = `${name}: reset`;
  current = snapshot(0, null);
  session.setSnapshot(current);
  await settleAll();
}

/**
 * Typing into a Settings text field (issue #142): every keystroke re-renders
 * the pane through the store's onChange, with no render() of the harness's
 * own in between, so Save must light up on the first key while the field
 * keeps its node, its focus and a caret the operator put mid-text.
 */
async function settingsTyping(): Promise<void> {
  const name = "settings typing";
  stage = name;
  if (!q(".settings-pane")) q<HTMLButtonElement>(".canvas-settings")?.click();
  await settleAll();
  const selector = '[data-key="pool-model-input"]';
  const input = q<HTMLInputElement>(selector);
  const save = () => q<HTMLButtonElement>('[data-key="settings-save-pool"] .settings-save');
  if (!input || !save()) {
    report.push({ scenario: name, assertion: "save enables on typing", pass: null, detail: "settings pane absent" });
    return;
  }
  const push = (assertion: string, failure: string | null, ok: string) =>
    report.push({ scenario: name, assertion, pass: failure === null, detail: failure ?? ok });
  const wasDisabled = save()!.disabled;

  // Insert keys one at a time at a caret mid-text: "opus" becomes "op-4us".
  input.focus();
  input.setSelectionRange(2, 2);
  const rendersBefore = renders;
  let failure: string | null = null;
  for (const key of "-4") {
    const at = input.selectionStart ?? 0;
    input.value = input.value.slice(0, at) + key + input.value.slice(at);
    input.setSelectionRange(at + 1, at + 1);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const now = q<HTMLInputElement>(selector);
    if (now !== input) failure ??= `after "${key}": the field was replaced`;
    else if (document.activeElement !== input) failure ??= `after "${key}": activeElement is ${describe(document.activeElement)}`;
    else if (input.selectionStart !== at + 1 || input.selectionEnd !== at + 1)
      failure ??= `after "${key}": selection ${input.selectionStart}-${input.selectionEnd}, expected ${at + 1}`;
  }
  const typed = renders - rendersBefore;
  push("keystrokes re-render", typed >= 2 ? null : `${typed} renders for 2 keystrokes`, `${typed} renders for 2 keystrokes`);
  push("focus and caret survive typing", failure, `caret held at 4 in "${input.value}"`);
  push(
    "save enables on typing",
    wasDisabled && !save()!.disabled ? null : `disabled before ${wasDisabled}, after ${save()!.disabled}`,
    "disabled before, enabled after the first keystrokes",
  );

  // Put it back: a revert is clean again, so Save greys out.
  input.value = "opus";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  push("save disables on revert", save()!.disabled ? null : "still enabled", "disabled");
  input.blur();
}

function parsePan(transform: string): { x: number; y: number; zoom: number } {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(transform);
  return m ? { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) } : { x: NaN, y: NaN, zoom: NaN };
}

function describe(el: Element | null): string {
  if (!el) return "null";
  return `<${el.tagName.toLowerCase()}${el.className ? ` class="${el.className}"` : ""}>`;
}

async function main(): Promise<void> {
  stage = "mount";
  session.setSnapshot(current);
  session.toggleLog(); // the log drawer starts closed
  session.select(card(SELECTED_TICKET));
  await settleAll();
  // Open the Enlist picker the way the operator does: the header button.
  q<HTMLButtonElement>(".canvas-enlist")?.click();
  await settleAll();
  // And the Reassign bulk dialog the way the operator does: the Settings
  // pane's button (issue #126). Both panes stay open for the scenarios, so
  // their scroll regions are measured alongside the trays'.
  q<HTMLButtonElement>(".canvas-settings")?.click();
  await settleAll();
  q<HTMLButtonElement>(".settings-reassign-open")?.click();
  await settleAll();
  // And the Held spawns list from the header's Spawn caps line (issue #149),
  // its first proposal's body expanded.
  q<HTMLButtonElement>(".canvas-spawn-line")?.click();
  await settleAll();
  q<HTMLButtonElement>(".held-spawn-toggle")?.click();
  await settleAll();

  await runScenario("progress tab", async () => {
    session.select(card(SELECTED_TICKET));
    session.selectTab(SELECTED_TICKET, "progress");
  });
  await runScenario("spec tab", async () => {
    session.select(card(SELECTED_TICKET));
    session.selectTab(SELECTED_TICKET, "spec");
  });
  await runScenario("outcome tab", async () => {
    session.select(card(DONE_TICKET));
    session.selectTab(DONE_TICKET, "outcome");
  });
  await runScenario("fullscreen detail", async () => {
    session.select(card(SELECTED_TICKET));
    session.selectTab(SELECTED_TICKET, "progress");
    await settleAll();
    q<HTMLButtonElement>(".detail-fullscreen-toggle")?.click();
  });
  q<HTMLButtonElement>(".detail-fullscreen-toggle")?.click();
  await settingsTyping();

  for (const selector of DEAD_SELECTORS) {
    report.push({ scenario: "-", assertion: `scroll ${selector}`, pass: null, detail: "selector in styles.css but no live module renders it" });
  }

  const json = JSON.stringify({ renders, checks: report }, null, 2);
  console.log("RENDER-SURVIVAL-REPORT " + json);
  const pre = document.getElementById("report") as HTMLPreElement;
  pre.textContent = btoa(unescape(encodeURIComponent(json)));
  document.title = "render survival: done";
}

// Watchdog: if a step never settles, publish the partial report anyway so
// the runner reports where the page stalled instead of hanging.
let stage = "boot";
setTimeout(() => {
  if (document.title.startsWith("render survival:")) return;
  const pre = document.getElementById("report") as HTMLPreElement;
  const json = JSON.stringify({ error: `watchdog: stalled at "${stage}" after ${renders} renders`, checks: report });
  pre.textContent = btoa(unescape(encodeURIComponent(json)));
  document.title = "render survival: stalled";
}, 10_000);

main().catch((err) => {
  const pre = document.getElementById("report") as HTMLPreElement;
  const json = JSON.stringify({ error: err instanceof Error ? err.stack ?? err.message : String(err), checks: report });
  pre.textContent = btoa(unescape(encodeURIComponent(json)));
  document.title = "render survival: error";
});
