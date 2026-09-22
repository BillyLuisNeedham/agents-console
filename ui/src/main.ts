/**
 * Console: the pool rendered as node cards on a canvas. One Bun server per
 * pool serves the built SPA, a JSON API, and an SSE stream pushing a full
 * snapshot on every change. The UI renders from those snapshots only; ticket
 * cards and their blocked-by edges render the thread.
 */

import "./styles.css";
import { PoolClient } from "./client";
import { POOL_TAB_COLORS, type EnrichedSnapshot } from "./project";
import { ConsoleSession } from "./session";
import { TerminalSurface } from "./terminal";
import { ConsoleView } from "./view";
import { Vitals } from "./vitals";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app not found");
const root: HTMLElement = appRoot;

const client = new PoolClient();

// The favicon: one reused link element whose href is a canvas-drawn dot in
// the pool status color. The idle grey dot stands from page load, before the
// first snapshot lands; every applied snapshot swaps the dot on the title's
// cadence.
const faviconLink = document.createElement("link");
faviconLink.rel = "icon";
document.head.appendChild(faviconLink);
let faviconColor = "";

function setFavicon(color: string): void {
  if (color === faviconColor) return;
  faviconColor = color;
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, Math.PI * 2);
  ctx.fill();
  faviconLink.href = canvas.toDataURL("image/png");
}

setFavicon(POOL_TAB_COLORS.idle);

// The Vitals store: polls the activity endpoint per live-attempt ticket and
// holds the payloads and sparkline samples the cards' footers project from.
// Its onChange fires on poll responses and on the 2s wall-clock tick that
// keeps staleness copy honest while the snapshot stream is silent.
const vitals = new Vitals({
  fetch: (ticketId) => client.getActivity(ticketId),
  onChange: () => render(),
});

// The Terminal surface store: polls the peek endpoint per terminal-backed
// running attempt and holds the peek text and focus confirmations the cards'
// surfaces project from.
const terminal = new TerminalSurface({
  peek: (ticketId) => client.peekTerminal(ticketId),
  focus: (ticketId) => client.focusTerminal(ticketId),
  onChange: () => render(),
});

// The Console session: owns the snapshot, the selection, the ticket-body
// caches, the grades, the tab override, the log pane, and the stale-answer
// guards, and derives one projected model per render. The bootstrap drives
// it and renders when it changes; it never touches the DOM.
const session = new ConsoleSession({
  getState: () => client.getState(),
  getEvents: (id) => client.getEvents(id),
  getTicket: (id) => client.getTicket(id),
  getGrades: () => client.getGrades(),
  getLog: (ticketId, attempt, offset, end, stream) =>
    client.getLog(ticketId, attempt, offset, end, stream),
  answer: (ticketId, action, note) => client.answer(ticketId, action, note),
  stop: () => client.stop(),
  restart: () => client.restart(),
  probeServer: (port) => probeServer(port),
  onRelaunched: (port) => handOverTo(port),
  stream: (handlers) => client.stream(handlers),
  vitals,
  terminal,
  visibility: document,
  onChange: () => render(),
});

// The per-session view state: selection, dragged card positions, panel
// width, drawer height, and note drafts, owned by the canvas, detail, and
// drawers modules and composed here once for the session. The tray's answer
// seam resolves on accept and rejects on failure so the tray marks its own
// row; the Detail keeps its fire-and-forget onAnswer below with the global
// banner.
const consoleView = new ConsoleView({
  onAnswer: (ticketId, action, note) => session.answer(ticketId, action, note),
  onChange: () => render(),
  onFocusTerminal: (ticketId) => terminal.focus(ticketId),
  onListPanes: () => client.listPanes(),
  onEnlist: (request) => client.enlist(request),
  onGetSettings: () => client.getSettings(),
  onSavePoolSettings: (config) => client.savePoolSettings(config),
  onSaveMachineDefaults: (defaults) => client.saveMachineDefaults(defaults),
  // Reassign (issue #126): the write answers with a fresh snapshot, so the
  // cards show the new Assignment the moment the file is on disk rather than
  // at the next boundary.
  onReassign: (request) =>
    client.reassign(request).then((response) => {
      session.setSnapshot(response.snapshot);
      return response;
    }),
  onStart: (request) => client.startConversation(request),
  onEnd: (conversationId, closing) =>
    client
      .endConversation(conversationId, closing)
      .then((snapshot) => session.setSnapshot(snapshot)),
});

// On a dev HMR re-execution this module runs again and builds fresh stores;
// dispose the old ones or their poll timers double up.
import.meta.hot?.dispose(() => {
  vitals.dispose();
  terminal.dispose();
});

/** The port this page is served from, the scheme's default when implicit. */
function currentPort(): string {
  if (location.port) return location.port;
  return location.protocol === "https:" ? "443" : "80";
}

/**
 * Whether a server is answering on a port, for the relaunch poll after a
 * Restart. A restart that changed the port makes this a cross-origin
 * request, and the pool server sends no CORS headers, so the response would
 * be unreadable; `no-cors` asks for an opaque one instead, which is all the
 * probe needs. Resolving at all means something accepted the connection;
 * nothing listening rejects.
 */
async function probeServer(port: number): Promise<boolean> {
  const url = `${location.protocol}//${location.hostname}:${port}/api/state`;
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The relaunched server is up: hand the page over to it. A new port is a new
 * origin, so the page goes there. The same port reloads rather than leaning
 * on the stream's own retry, because a Restart is the moment Boot rebuilds a
 * stale UI: the bytes this page is running may be the ones it just replaced,
 * and only a reload picks up the new ones. It is safe at this point because
 * nothing is in flight, the old server having already exited.
 */
function handOverTo(port: number): void {
  if (String(port) !== currentPort()) {
    location.assign(`${location.protocol}//${location.hostname}:${port}${location.pathname}`);
    return;
  }
  location.reload();
}

function render(): void {
  // The tab title and favicon follow the latest snapshot's pool status; the
  // session computes it, the DOM write is the bootstrap's.
  const status = session.tabStatus;
  if (status && session.poolName) {
    document.title = `${status.word} — ${session.poolName}`;
    setFavicon(status.color);
  }
  consoleView.render(root, session.model(consoleView.conversationEndState()), {
    onToggleLog: () => session.toggleLog(),
    onToggleInspector: () => session.toggleInspector(),
    onSelectNode: (nodeId) => session.select(nodeId),
    onSelectAttempt: (ticketId, attempt) => session.logs.selectAttempt(ticketId, attempt),
    onSelectStream: (ticketId, attempt) => session.logs.selectStream(ticketId, attempt),
    onLoadEarlier: (ticketId, attempt) => {
      void session.logs.loadEarlier(ticketId, attempt);
    },
    onAnswer: (ticketId, action, note) => {
      session.answer(ticketId, action, note).catch((err) => {
        session.reportError(
          `answer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
    onSelectTab: (ticketId, tab) => session.selectTab(ticketId, tab),
    // The Stop control (issue #97). `confirmStop` catches its own failures
    // into the inline message beside the button, so there is nothing to
    // report here: a refused stop is not a broken pool.
    onArmStop: () => session.armStop(),
    onCancelStop: () => session.cancelStop(),
    onConfirmStop: () => {
      void session.confirmStop();
    },
    // The Restart control (ADR-0026), in the Settings pane's footer. Same
    // shape as Stop: `confirmRestart` catches its own refusal into the
    // message beside the button, so there is nothing to report here.
    onArmRestart: () => session.armRestart(),
    onCancelRestart: () => session.cancelRestart(),
    onConfirmRestart: () => {
      void session.confirmRestart();
    },
  });
}

async function boot(): Promise<void> {
  let snapshot: EnrichedSnapshot | null = null;
  try {
    snapshot = await client.getState();
  } catch (err) {
    session.reportError(
      `pool server unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (snapshot) {
    session.setSnapshot(snapshot);
  } else {
    try {
      session.setSnapshot(await client.start());
    } catch (err) {
      session.reportError(
        `failed to start the pool: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }
  session.connect();
}

void boot();
