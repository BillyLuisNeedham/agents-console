/**
 * PROTOTYPE — throwaway. The interactive page behind
 * `bun harness/prototype-stop.ts`: the real ConsoleView over the real
 * ConsoleSession and a fake socket, with a pool in a live phase, so the
 * three always-present Stop variants (src/prototype-stop-variants.ts) can
 * be compared on real snapshot data.
 *
 *   ?variant=A|B|C      which Stop (the switcher at the bottom cycles it)
 *   &phase=done|...     the pool's phase (default running); done ends the work
 *   &demo=armed         open the variant's confirming state on load
 *   &open=settings      open the Settings pane, to see what sits over it
 */

import "../src/styles.css";
import { RenderLoop } from "../src/frame";
import { ConsoleSession, type SessionSocket } from "../src/session";
import { ConsoleView, type Handlers } from "../src/view";
import type {
  ConversationView,
  EnrichedSnapshot,
  EnrichedTicketState,
  SettingsResponse,
} from "../src/project";
import type { RunPhase } from "../../protocol/wire.ts";

const params = new URLSearchParams(location.search);
const PHASES: RunPhase[] = ["running", "done", "quiescent", "stalled", "dead"];
const phase: RunPhase = PHASES.includes(params.get("phase") as RunPhase)
  ? (params.get("phase") as RunPhase)
  : "running";
const done = phase === "done";

function ticket(id: string, title: string, overrides: Partial<EnrichedTicketState> = {}): EnrichedTicketState {
  const base = {
    id,
    title,
    blockedBy: [],
    status: "ready" as const,
    mergeState: null,
    enlisted: false,
    assignment: { harness: "claude", model: "opus", drivers: "implement" },
    liveAttempt: null,
    heldPane: null,
    ...overrides,
  };
  const eligible = base.liveAttempt === null && base.status !== "done" && base.status !== "closed";
  return {
    ...base,
    reassign: base.reassign ?? {
      eligible,
      reason: eligible ? null : "an Attempt is in flight",
      verify: null,
      sources: { harness: "default", model: "pinned", effort: "unset", drivers: "default" },
    },
  };
}

/** A running ticket, or a done one once the phase is done. */
function running(id: string, title: string, pane: string, blockedBy: string[] = []): EnrichedTicketState {
  if (done) return ticket(id, title, { status: "done", blockedBy });
  return ticket(id, title, {
    status: "in-progress",
    blockedBy,
    liveAttempt: { attempt: 1, paneId: pane, role: "agent", startedAt: new Date(Date.now() - 9 * 60_000).toISOString() },
  });
}

function conversation(id: string, title: string, overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id,
    title,
    status: done ? "ended" : "live",
    spawnedBy: null,
    assignment: { harness: "claude", model: "opus", drivers: "implement" },
    paneId: done ? null : `pane-${id}`,
    branch: null,
    turn: { state: "working", lastLine: "reading the spec", idleSince: null },
    children: [],
    enlisted: false,
    ending: false,
    ...overrides,
  } as ConversationView;
}

function snapshot(): EnrichedSnapshot {
  return {
    seq: 42,
    phase,
    poolName: "prototype/stop-button",
    poolTitle: "Stop button prototype",
    poolDir: "/tmp/prototype-stop-pool",
    finishedTerminals: 0,
    spawnUsage: { spawnedThisRun: 3, perAttempt: 5, perRun: 20 },
    pendingSpawns: [],
    heldSpawns: [],
    stewardBudget: { budget: 5, used: {} },
    line: null,
    state: {
      tickets: [
        ticket("t-1", "Schema for the pool ledger", { status: "done" }),
        running("t-2", "Port the merge queue", "pane-t-2", ["t-1"]),
        running("t-3", "Settings pane keyboard nav", "pane-t-3", ["t-1"]),
        running("t-4", "Retry harness launch on 127", "pane-t-4"),
        ticket("t-5", "Docs for the Line base", { status: done ? "done" : "ready", blockedBy: ["t-2", "t-3"] }),
      ],
      conversations: [conversation("c-1", "Grill: always-present Stop")],
      log: Array.from({ length: 20 }, (_, i) => `[log] pool line ${i + 1}`),
      outcomes: {},
      interrupts: [],
      mergeQueue: [],
      queuedAnswers: [],
      config: { terminal: "herdr" },
    },
  } as unknown as EnrichedSnapshot;
}

const SETTINGS: SettingsResponse = {
  pool: {
    path: "/tmp/prototype-stop-pool/console.json",
    config: { defaults: { harness: "claude", model: "opus" }, port: 4300 },
    bootOnly: ["selection", "terminal", "port"],
    effective: { port: 4300, terminal: "herdr", stale: [] },
  },
  machine: { path: "/home/me/.agent-graphs/defaults.json", defaults: { harness: "claude" }, own: { harness: "claude" } },
  harnesses: ["claude", "opencode"],
};

const root = document.getElementById("app") as HTMLElement;

const socket: SessionSocket = {
  request: () => Promise.resolve({}) as never,
  subscribe: () => {},
  unsubscribe: () => {},
  follow: () => Promise.resolve({}) as never,
};

const session = new ConsoleSession({
  socket,
  vitals: { update() {}, apply() {}, state: () => ({}) },
  terminal: { update() {}, apply() {}, state: () => ({}) },
  onChange: () => loop.request(),
});

const view = new ConsoleView({
  onAnswer: () => Promise.resolve(),
  onChange: () => loop.request(),
  onFocusTerminal: () => Promise.resolve(true),
  onListPanes: () => Promise.resolve({ panes: [] }),
  onEnlist: () => Promise.resolve({ ok: true } as never),
  onGetSettings: () => Promise.resolve(SETTINGS),
  onSavePoolSettings: () => Promise.resolve(SETTINGS),
  onAdoptHeldSpawn: (id) => Promise.resolve({ id }),
  onDiscardHeldSpawn: (id) => Promise.resolve({ id }),
  onHoldPendingSpawn: (id) => Promise.resolve({ id }),
  onDiscardPendingSpawn: (id) => Promise.resolve({ id }),
  onSaveMachineDefaults: () => Promise.resolve(SETTINGS),
  onReassign: () => Promise.resolve({ applied: [], skipped: [] }),
  onStart: () => Promise.resolve(conversation("c-new", "new")),
  onEnd: () => Promise.resolve(),
  onStartLine: () => Promise.resolve(),
});

const noop = (): void => {};
const handlers: Handlers = {
  onToggleLog: () => session.toggleLog(),
  onToggleInspector: () => session.toggleInspector(),
  onSelectNode: (id) => session.select(id),
  onHoverNode: (id) => session.hover(id),
  onLoadEarlierPoolLog: noop,
  onSelectAttempt: (t, a) => session.logs.selectAttempt(t, a),
  onSelectStream: (t, a) => session.logs.selectStream(t, a),
  onLoadEarlier: noop,
  onAnswer: noop,
  onKeepTalking: noop,
  onSelectTab: (t, tab) => session.selectTab(t, tab),
  // The real Stop never fires here: the prototype stubs its own.
  onArmStop: noop,
  onCancelStop: noop,
  onConfirmStop: () => console.warn("[prototype-stop] real Stop pressed; ignored"),
  onArmRestart: noop,
  onCancelRestart: noop,
  onConfirmRestart: noop,
  onArmCloseTerminals: noop,
  onCancelCloseTerminals: noop,
  onConfirmCloseTerminals: noop,
};

const loop = new RenderLoop(
  () => view.render(root, session.model(view.conversationEndState(), view.conversationLineStartState()), handlers),
  (frame) => requestAnimationFrame(() => frame()),
);
for (const type of ["pointerup", "click", "keydown"] as const) window.addEventListener(type, () => loop.flush());

session.setSnapshot(snapshot());
loop.flush();
if (params.get("open") === "settings") {
  setTimeout(() => document.querySelector<HTMLButtonElement>(".canvas-settings")?.click(), 0);
}
// A live frame every two seconds, so a variant is seen surviving re-renders.
setInterval(() => session.setSnapshot({ ...snapshot(), seq: session.model(view.conversationEndState(), view.conversationLineStartState()).seq + 1 }), 2000);
