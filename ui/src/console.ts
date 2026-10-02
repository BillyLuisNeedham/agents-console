/**
 * The Console, composed: the socket, the session, the live stores, the view
 * and the render loop, wired once (issue #161). main.ts calls this with the
 * browser's WebSocket and the snapshot the served page embeds; the bench's
 * UI half calls it with a fake socket that plays the protocol's frames, so
 * what it measures is this wiring and nothing standing in for it.
 *
 * Boot paints before the socket opens: the embedded snapshot is applied and
 * rendered at once, then the socket opens, and its first snapshot, when it
 * is the same epoch and revision, changes nothing. A page with no embedded
 * snapshot shows "connecting" until the socket's first one lands, and a
 * server that has not started the pool is asked to start it.
 */

import type { EmbeddedBoot, SocketLike } from "../../engine/protocol.ts";
import { nextFrame, RenderLoop, type FrameRequest } from "./frame";
import {
  adoptingSpawn,
  discardedSpawn,
  endingConversation,
  heldSpawn,
} from "./optimistic";
import type { PoolConfigPatch } from "./project";
import { ConsoleSession } from "./session";
import {
  ConsoleSocket,
  followVisibility,
  type VisibilitySource,
} from "./socket";
import { TerminalSurface } from "./terminal";
import { ConsoleView, type Handlers } from "./view";
import { Vitals } from "./vitals";

export interface ConsoleOptions {
  /** The element the Console renders into. */
  root: HTMLElement;
  /** Open a socket to the pool server: the browser's WebSocket at WS_PATH
   *  in the page, a fake that speaks the protocol in the bench. */
  openSocket: () => SocketLike;
  /** The snapshot the served index.html embeds, painted before the socket
   *  opens; null or absent paints "connecting" until the socket's first. */
  boot?: EmbeddedBoot | null;
  /** The page's visibility: a hidden page tells the server, which stops
   *  sending it live values. Absent, the page counts as always visible. */
  visibility?: VisibilitySource;
  /** Whether a server answers on a port, for the wait after a Restart. */
  probeServer?: (port: number) => Promise<boolean>;
  /** The relaunched server answered: hand the page over to it. */
  onRelaunched?: (port: number) => void;
  /**
   * The server speaks another protocol version. Resolve it (reload the
   * page) and return true, or return false to show the "reload the page"
   * banner instead. Absent, the banner shows.
   */
  onVersionMismatch?: () => boolean;
  /** Every session change, before its render is asked for: where the page
   *  writes the tab title and favicon, which a hidden tab still needs. */
  onSessionChange?: (session: ConsoleSession) => void;
  /**
   * One render. Defaults to `app.draw()`: the session's model, then the
   * view's render of it. The bench passes its own to time the two apart.
   */
  render?: (app: ConsoleApp) => void;
  /** The render loop's frame; defaults to the next animation frame. */
  frame?: FrameRequest;
  /** The page's window, as far as the Console listens to it: where the
   *  operator's presses bubble out, to render a press's own change before
   *  the next frame, and where `online` fires, to replace a socket a network
   *  change left half open. Defaults to `window` where there is one. */
  pressTarget?: EventTarget | null;
}

export interface ConsoleApp {
  socket: ConsoleSocket;
  session: ConsoleSession;
  view: ConsoleView;
  vitals: Vitals;
  terminal: TerminalSurface;
  renders: RenderLoop;
  /** The intents the rendered page reports through. */
  handlers: Handlers;
  /** Render now: the session's model, then the view's render of it. */
  draw(): void;
  /** Paint the embedded snapshot, then open the socket. */
  start(): void;
  /** Close the socket for good and stop every timer. */
  dispose(): void;
}

/** Build the Console. Nothing runs until `start()`. */
export function createConsole(options: ConsoleOptions): ConsoleApp {
  const root = options.root;
  // Every store below asks for a render when it changes, and the asks come
  // in bursts (a delta, then a live frame), so they are folded into one
  // render per animation frame (issue #157).
  const renders = new RenderLoop(() => (options.render ?? ((a) => a.draw()))(app), options.frame);
  const requestRender = (): void => {
    options.onSessionChange?.(session);
    renders.request();
  };

  const socket = new ConsoleSocket({
    open: options.openSocket,
    visible: options.visibility ? options.visibility.visibilityState === "visible" : true,
    onSnapshot: (pushed, delta) => {
      if (pushed) session.setPushed(pushed, delta);
      else session.start();
    },
    onLive: (live) => session.applyLive(live),
    onCard: (card) => session.applyCard(card),
    onConnection: (change) => session.connection(change),
    onVersionMismatch: () => {
      if (!options.onVersionMismatch?.()) session.versionChanged();
    },
  });

  // The Vitals store: the activity payloads the live frames carry and the
  // sparkline samples the cards' footers project from. Its tick repaints
  // only when the staleness copy or a sparkline moved, and sends nothing.
  const vitals = new Vitals({ onChange: requestRender });

  // The Terminal surface store: the peek text the live frames carry, and
  // "Open in herdr", answered on the socket.
  const terminal = new TerminalSurface({
    focus: (ticketId) => socket.request("terminal.focus", { ticketId }),
    onChange: requestRender,
  });

  // The Console session: owns the snapshot, the selection, the subscribed
  // cards, the grades, the overlays and the controls' state, and derives one
  // projected model per render. It never touches the DOM.
  const session = new ConsoleSession({
    socket,
    probeServer: options.probeServer,
    onRelaunched: options.onRelaunched,
    vitals,
    terminal,
    onChange: requestRender,
  });

  // The per-session view state: selection, dragged card positions, panel
  // width, drawer height and note drafts, owned by the canvas, Detail and
  // drawers modules. Its stores' requests go out on the socket: the
  // optimistic ones through the session's overlays, the rest showing
  // their own "…ing" until the reply.
  const view = new ConsoleView({
    // The first render paints the embedded snapshot's cards; their measuring
    // and the edges between them follow in the next frame.
    settleLater: options.frame ?? nextFrame,
    onAnswer: (ticketId, action, note) => session.answer(ticketId, action, note),
    onChange: requestRender,
    onFocusTerminal: (id) => terminal.focus(id),
    onListPanes: () => socket.request("panes.list", {}),
    onEnlist: (request) => socket.request("enlist", request),
    onGetSettings: () => socket.request("settings.get", {}),
    onSavePoolSettings: (config: PoolConfigPatch) =>
      socket.request("settings.pool.put", { config: { ...config } }),
    onSaveMachineDefaults: (defaults) => socket.request("settings.machine.put", { defaults }),
    onReassign: (request) => socket.request("reassign", request),
    onAdoptHeldSpawn: (id) => session.optimistic("spawns.held.adopt", { id }, adoptingSpawn(id)),
    onDiscardHeldSpawn: (id) =>
      session.optimistic("spawns.held.discard", { id }, discardedSpawn(id)),
    onHoldPendingSpawn: (id) => session.optimistic("spawns.pending.hold", { id }, heldSpawn(id)),
    onDiscardPendingSpawn: (id) =>
      session.optimistic("spawns.pending.discard", { id }, discardedSpawn(id)),
    onStart: (request) =>
      socket.request("conversations.start", request).then((result) => result.conversation),
    onEnd: (id, closing) =>
      session
        .optimistic(
          "conversations.end",
          closing ? { id, closing } : { id },
          endingConversation(id),
        )
        .then(() => undefined),
  });

  const handlers: Handlers = {
    onToggleLog: () => session.toggleLog(),
    onToggleInspector: () => session.toggleInspector(),
    onSelectNode: (nodeId) => session.select(nodeId),
    onHoverNode: (nodeId) => session.hover(nodeId),
    onLoadEarlierPoolLog: () => {
      void session.loadEarlierPoolLog();
    },
    onSelectAttempt: (ticketId, attempt) => session.logs.selectAttempt(ticketId, attempt),
    onSelectStream: (ticketId, attempt) => session.logs.selectStream(ticketId, attempt),
    onLoadEarlier: (ticketId, attempt) => {
      void session.logs.loadEarlier(ticketId, attempt);
    },
    // The answer draws as queued in the press's frame, and a refusal's
    // reason stands beside the interrupt's actions: nothing to report here.
    onAnswer: (ticketId, action, note) => {
      session.answer(ticketId, action, note).catch(() => {});
    },
    // Keep talking (issue #139): the session catches its own refusal into
    // the reason beside the button, so there is nothing to report here.
    onKeepTalking: (ticketId) => {
      void session.keepTalking(ticketId);
    },
    onSelectTab: (ticketId, tab) => session.selectTab(ticketId, tab),
    // The Stop control (issue #97). `confirmStop` catches its own failures
    // into the inline message beside the button: a refused stop is not a
    // broken pool.
    onArmStop: () => session.armStop(),
    onCancelStop: () => session.cancelStop(),
    onConfirmStop: () => {
      void session.confirmStop();
    },
    // The Restart control (ADR-0026), in the Settings pane's footer, the
    // same shape as Stop.
    onArmRestart: () => session.armRestart(),
    onCancelRestart: () => session.cancelRestart(),
    onConfirmRestart: () => {
      void session.confirmRestart();
    },
    // Close finished terminals (issue #139), in the pool header beside
    // Stop, and the same shape again.
    onArmCloseTerminals: () => session.armCloseTerminals(),
    onCancelCloseTerminals: () => session.cancelCloseTerminals(),
    onConfirmCloseTerminals: () => {
      void session.confirmCloseTerminals();
    },
  };

  const cleanups: (() => void)[] = [];

  const app: ConsoleApp = {
    socket,
    session,
    view,
    vitals,
    terminal,
    renders,
    handlers,
    draw() {
      view.render(root, session.model(view.conversationEndState()), handlers);
    },
    start() {
      // A render the operator's own press asked for is not left for the
      // frame: it runs as the press bubbles out of the page, after the
      // handlers that asked for it, so a press's change is drawn before
      // the next frame instead of inside it (issue #157). Background asks
      // still wait for the frame.
      const pressTarget =
        options.pressTarget !== undefined
          ? options.pressTarget
          : typeof window !== "undefined"
            ? window
            : null;
      if (pressTarget) {
        const flush = (): void => renders.flush();
        for (const type of ["pointerup", "click", "keydown"] as const) {
          pressTarget.addEventListener(type, flush);
          cleanups.push(() => pressTarget.removeEventListener(type, flush));
        }
      }
      if (options.visibility) cleanups.push(followVisibility(options.visibility, socket));
      // Back online after a network change: a socket that went quiet across
      // it is replaced at once, not when the silence watchdog fires.
      if (pressTarget) {
        const wake = (): void => socket.wake();
        pressTarget.addEventListener("online", wake);
        cleanups.push(() => pressTarget.removeEventListener("online", wake));
      }
      // The embedded snapshot paints now, in this task, before the socket
      // is even asked for.
      const boot = options.boot;
      if (boot) {
        socket.adopt(boot);
        if (boot.snapshot) {
          session.setPushed(
            { rev: boot.rev, logTotal: boot.logTotal, snapshot: boot.snapshot },
            null,
          );
          renders.flush();
        }
      }
      socket.start();
    },
    dispose() {
      socket.dispose();
      vitals.dispose();
      terminal.dispose();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
  return app;
}
