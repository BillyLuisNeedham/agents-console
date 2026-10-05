/**
 * Console session: the one module that owns the Console's session state.
 * The snapshot, the selection, the subscribed cards' data, the grades, the
 * tab override, the optimistic overlays and the pool log's earlier lines
 * live here, fed by the socket (issue #161): the snapshot as the socket
 * pushes and applies it, the live values and the cards' frames as they
 * come, and every action and read as a request on the socket seam. Async
 * IO plus change notification belong to the module, not the render pass.
 * `model()` is the single derivation point: one `projectPool` per render,
 * stored so the selection, the timeline and the Detail all read the same
 * cards. No DOM references; the bootstrap constructs it, drives it, and
 * renders when it changes.
 */

import {
  HOVER_DWELL_MS,
  HOVER_SUBSCRIPTIONS,
  type CardSubscription,
  type LogFollow,
  type LogFollowResult,
  type PushedSnapshot,
  type RequestKind,
  type RequestPayload,
  type RequestResult,
  type SnapshotDelta,
} from "../../protocol/protocol.ts";
import { LogPane, type LogPaneState } from "./log-pane";
import { answered, applyOverlays, type Overlay } from "./optimistic";
import {
  isTerminalBacked,
  joinStreamFiles,
  phaseLabel,
  poolAssignmentDefaults,
  stewardAssignmentDefaults,
  poolDisplayName,
  poolStatus,
  projectConversationsNeedsInput,
  projectConversationsTray,
  projectDetail,
  projectDetailTabs,
  projectEnlistBlocks,
  projectReassignTickets,
  projectLogPane,
  projectNeedsInput,
  projectPool,
  projectTimeline,
  type ConversationEndView,
  type DetailTab,
  type EnrichedSnapshot,
  type KeepTalkingState,
  type PoolCardView,
  type PoolTabStatus,
  type PoolView,
  type ResumeAction,
  type TabOverride,
  type TerminalPeekResponse,
  type TerminalSurfaceView,
  type TicketActivityResponse,
  type TicketBodyResponse,
  type TicketEventsResponse,
  type TicketGradeSummary,
  type TicketStatus,
  type TimelineView,
  type VitalsState,
} from "./project";
import type { CardMessage, ConnectionChange, LiveMessage } from "./socket";
import type { PeekFailure } from "../../protocol/protocol.ts";
import type { AppModel, StopState } from "./view";

/** The vitals store, as the session consumes it. */
export interface SessionVitals {
  update(snapshot: EnrichedSnapshot): void;
  apply(activity: Record<string, TicketActivityResponse>): void;
  state(): Record<string, VitalsState>;
}

/** The terminal surface store, as the session consumes it. */
export interface SessionTerminal {
  update(snapshot: EnrichedSnapshot): void;
  apply(peeks: Record<string, TerminalPeekResponse | PeekFailure>): void;
  state(): Record<string, TerminalSurfaceView>;
}

/** The socket, as the session asks things of it. */
export interface SessionSocket {
  request<K extends RequestKind>(kind: K, payload: RequestPayload<K>): Promise<RequestResult<K>>;
  subscribe(card: CardSubscription): void;
  unsubscribe(id: string): void;
  follow(id: string, follow: LogFollow): Promise<LogFollowResult>;
}

export interface ConsoleSessionOptions {
  socket: SessionSocket;
  /** Whether a server is answering on a port. Resolving false (or throwing)
   *  means nothing is there yet; the bootstrap owns the fetch, since the
   *  probe crosses an origin and the session holds no DOM or location. */
  probeServer?: (port: number) => Promise<boolean>;
  /** The relaunched server answered: hand the page over to it. The
   *  bootstrap owns this too, for the same reason. */
  onRelaunched?: (port: number) => void;
  /** The relaunch poll's cadence, injectable so tests need not wait. */
  restartPollMs?: number;
  /** How long the poll keeps trying before it gives up and lets the
   *  ordinary stopped notice print the relaunch command. */
  restartWaitMs?: number;
  /** How long the pointer rests on a card before it is prefetched;
   *  injectable so tests need not wait. */
  hoverDwellMs?: number;
  /** How long a card the server could not read waits before it is asked
   *  for again; injectable so tests need not wait. */
  cardRetryMs?: number;
  vitals: SessionVitals;
  terminal: SessionTerminal;
  /** The derivation, injectable so tests can count it. Defaults to the real
   *  projection. */
  projectPool?: typeof projectPool;
  /** Called after every state change the view should repaint. */
  onChange: () => void;
}

/** A subscribed card's data as its frames brought it. Absent fields have
 *  not arrived yet. */
interface CardData {
  body?: TicketBodyResponse | null;
  events?: TicketEventsResponse;
  error?: string;
}

// A socket close marks the connection down at once, but the banner waits
// out a grace delay: a reconnect inside the window cancels it, and the next
// reconnect clears one already showing.
const CONNECTION_GRACE_MS = 4000;

// The relaunch poll after a Restart (ADR-0026): a Boot that has to rebuild a
// stale UI takes tens of seconds, so the window is generous, and the cadence
// is slow enough to cost nothing while it waits.
const RESTART_POLL_MS = 1000;
const RESTART_WAIT_MS = 60_000;

/** The most pool log lines the window's appends keep above it once
 *  "load earlier" has run: past it the oldest go, and it reads them back. */
const POOL_LOG_EARLIER_KEPT = 5_000;

/** How long a card the server could not read waits to be asked for again. */
const CARD_RETRY_MS = 2_000;

/** The banner a tab shows when the server speaks another protocol version
 *  and reloading would only loop. */
const VERSION_BANNER = "Console was updated: reload the page";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ConsoleSession {
  /** The selected ticket's raw log pane, fed by its card's log frames and
   *  driven by the view's attempt, stream and "load earlier" handlers. */
  readonly logs: LogPane;

  private readonly socket: SessionSocket;
  private readonly probeServer: ConsoleSessionOptions["probeServer"];
  private readonly onRelaunched: ConsoleSessionOptions["onRelaunched"];
  private readonly restartPollMs: number;
  private readonly restartWaitMs: number;
  private readonly hoverDwellMs: number;
  private readonly cardRetryMs: number;
  private readonly vitals: SessionVitals;
  private readonly terminal: SessionTerminal;
  private readonly derivePool: typeof projectPool;
  private readonly onChange: () => void;

  private snapshot: EnrichedSnapshot | null = null;
  private selectedId: string | null = null;
  private logOpen = false;
  private inspectorOpen = false;
  // The inspector's text, kept for the snapshot it was printed from.
  private inspector: { snapshot: EnrichedSnapshot; json: string } | null = null;
  private error: string | null = null;
  private connected = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConnectionError = "";
  // The server speaks another protocol version and the page did not reload
  // (it already had, moments ago): the banner says to, and stays.
  private versionStale = false;

  // The pool log (issue #161): the snapshot carries its last 500 lines and
  // its full length. "Load earlier" reads the lines before those into
  // `earlier`, and while it holds any (or a read is out), the lines an
  // append pushes out of the window move onto its end, so the drawer's text
  // stays one contiguous run. `earlier` grows in place, its version counting
  // the changes, and is let go of from its oldest end past its cap, which
  // "load earlier" can read back. A new log, or a whole snapshot, starts
  // over; the generation drops a read that answers after. The drawer's text
  // is joined only while it is open, once per change to either part.
  private logTotal = 0;
  private earlier: string[] = [];
  private earlierVersion = 0;
  private earlierCap = POOL_LOG_EARLIER_KEPT;
  private earlierLoading = false;
  private earlierError: string | null = null;
  private earlierGeneration = 0;
  private earlierText: { version: number; text: string } | null = null;
  private logText: { version: number; window: string[]; text: string } | null = null;

  // The Stop control's state (issue #97). The confirmation is inline on the
  // button, so it is one small state machine, not a modal: `armed` is the
  // "Really stop?" prompt, `requesting` the request in flight. It lives in
  // memory only, so a refresh disarms. `stoppedFromHere` marks the tab whose
  // Stop request was accepted, which is the only tab that can honestly say
  // the stop came from this page.
  private stopState: StopState = "idle";
  private stopFailure: string | null = null;
  private stoppedFromHere = false;

  // The Restart control's state (ADR-0026). The same three-state inline
  // confirm as Stop, but offered in any phase: a boot-only key takes effect
  // no other way, and a pool that is running is exactly when the operator
  // notices the key is wrong. `restartWaiting` marks the tab that asked and
  // is now waiting for the server Boot brings back; every other tab sees an
  // ordinary stop and its socket's retry finds the same server.
  private restartState: StopState = "idle";
  private restartFailure: string | null = null;
  private restartWaiting = false;
  private restartPort: number | null = null;
  private restartPoll: ReturnType<typeof setTimeout> | null = null;
  // One poll chain at a time: the accept and the farewell both start it, and
  // the second must not lay a second chain over the first.
  private restartPolling = false;

  // Keep talking's marks (issue #139), keyed by ticket id and tied to the
  // Held pane's Attempt they were asked of. The session holds them rather
  // than either surface, so the Detail's button and the tray's disable
  // together and show the same refusal. A snapshot whose ticket no longer
  // holds that pane drops its mark: the Continued attempt started, the
  // checkpoint was answered, or the pane closed.
  private readonly keepTalkingMarks = new Map<string, KeepTalkingState>();

  // The pool header's "Close N finished terminals" control (issue #139): the
  // same three-state inline confirm as Stop, offered while the snapshot
  // counts any Finished terminals.
  private closeTerminalsState: StopState = "idle";
  private closeTerminalsFailure: string | null = null;

  // Optimistic presses (issue #161): one overlay per request out, keyed by
  // the session's own count, drawn over the snapshot until the reply lands.
  // The confirming delta is ahead of the reply on the socket, so dropping
  // the overlay then changes nothing on screen; a refusal drops it too.
  private readonly overlays = new Map<number, Overlay>();
  private overlayCount = 0;
  // Moves on every overlay added or dropped, so the drawn snapshot is
  // remade only when the set changed.
  private overlayVersion = 0;
  private shown: { base: EnrichedSnapshot; overlays: number; snapshot: EnrichedSnapshot } | null =
    null;
  // A refused answer's reason per ticket, beside the interrupt's actions on
  // both surfaces until the next answer, or until the interrupt resolves.
  private readonly answerFailures = new Map<string, string>();

  // The latest grade per ticket, for the card summaries, pushed whole when
  // it moves. Empty until the first live frame: the cards render no grade
  // UI until then, which is the no-grade state anyway.
  private grades: Record<string, TicketGradeSummary> = {};

  // The subscribed cards (issue #161): the selected one, and up to
  // HOVER_SUBSCRIPTIONS cards the pointer rested on, least recently hovered
  // first. Their frames' data is held while they stay subscribed, so a click
  // on a hovered card draws its Detail whole in the click's own render.
  private selectedCardId: string | null = null;
  private hovered: string[] = [];
  private dwell: ReturnType<typeof setTimeout> | null = null;
  private readonly subscribed = new Set<string>();
  private readonly cards = new Map<string, CardData>();
  // A card the server could not read waits here to be asked for again.
  private readonly cardRetries = new Map<string, ReturnType<typeof setTimeout>>();
  // The selected card's timeline, projected once per events frame and
  // status, a frame that continues the last one carrying its rows over; and
  // the same joined with the log pane's Stream files, once per either.
  private timeline: {
    id: string;
    events: TicketEventsResponse;
    status: TicketStatus;
    view: TimelineView;
  } | null = null;
  private joined: {
    view: TimelineView;
    listing: LogPaneState["attempts"] | null;
    joined: TimelineView;
  } | null = null;

  // The manually chosen Detail tab, carrying its ticket id: the projection
  // ignores it for any other ticket, so changing the selection reasserts the
  // phase default.
  private tabOverride: TabOverride | null = null;

  // The latest derivation, refreshed by `model()` on every render and read
  // by the selection between renders.
  private view: PoolView | null = null;

  // The browser tab's status, recomputed on every applied snapshot; the
  // bootstrap renders them into the title and favicon (DOM is its own).
  tabStatus: PoolTabStatus | null = null;
  /** The pool as the Console names it: its Pool title, else its directory. */
  poolName: string | null = null;

  constructor(options: ConsoleSessionOptions) {
    this.socket = options.socket;
    this.probeServer = options.probeServer;
    this.onRelaunched = options.onRelaunched;
    this.restartPollMs = options.restartPollMs ?? RESTART_POLL_MS;
    this.restartWaitMs = options.restartWaitMs ?? RESTART_WAIT_MS;
    this.hoverDwellMs = options.hoverDwellMs ?? HOVER_DWELL_MS;
    this.cardRetryMs = options.cardRetryMs ?? CARD_RETRY_MS;
    this.vitals = options.vitals;
    this.terminal = options.terminal;
    this.derivePool = options.projectPool ?? projectPool;
    this.onChange = options.onChange;
    this.logs = new LogPane({
      follow: (id, follow) => this.socket.follow(id, follow),
      read: (request) => this.socket.request("log.read", request),
      onChange: () => this.onChange(),
    });
  }

  // -------------------------------------------------------------------------
  // What the socket pushes
  // -------------------------------------------------------------------------

  /**
   * Apply a snapshot whole: the embedded one at boot, or a test's. The
   * socket's pushes go through `setPushed`, which this is the whole-snapshot
   * case of.
   */
  setSnapshot(snapshot: EnrichedSnapshot): void {
    this.setPushed({ rev: 0, logTotal: snapshot.state.log.length, snapshot }, null);
  }

  /**
   * Apply a pushed version of the snapshot, whole or made by `delta`: hold
   * it, keep the pool log's earlier lines contiguous with it, refresh the
   * vitals and terminal stores and the tab status, and repaint. Unchanged
   * tickets and Conversations arrive as the same objects they were, so the
   * projection and the morph see that nothing about them moved.
   */
  setPushed(pushed: PushedSnapshot, delta: SnapshotDelta | null): void {
    this.followPoolLog(pushed, delta);
    this.logTotal = pushed.logTotal;
    const snapshot = pushed.snapshot;
    const wasStopped = this.snapshot?.phase === "stopped";
    this.snapshot = snapshot;
    this.connected = true;
    if (wasStopped && snapshot.phase !== "stopped") {
      // A fresh snapshot after a `stopped` one is the relaunched server the
      // socket's retry found on its own (issue #97): the page is live again,
      // so the stop control and the "from this page" marker start over. The
      // tab that asked for a Restart hands itself over, since the relaunch
      // may have rebuilt the UI it is running.
      const handOver = this.restartWaiting ? this.restartPort : null;
      this.stoppedFromHere = false;
      this.stopState = "idle";
      this.stopFailure = null;
      this.cancelRelaunchPoll();
      this.restartWaiting = false;
      this.restartState = "idle";
      this.restartFailure = null;
      if (handOver !== null) this.onRelaunched?.(handOver);
    } else if (this.stopState === "armed" && snapshot.phase !== "done") {
      // Stop is offered only on a done pool, so a phase that moved off done
      // withdraws the offer and the armed confirmation goes with it. A
      // request already in flight keeps its label until the farewell lands.
      this.stopState = "idle";
      this.stopFailure = null;
    }
    if (this.closeTerminalsState === "armed" && snapshot.finishedTerminals === 0) {
      // Nothing left to close (another tab closed them, or a pane went on
      // its own): the offer is withdrawn and the armed prompt goes with it.
      this.closeTerminalsState = "idle";
    }
    this.pruneKeepTalking(snapshot);
    for (const ticketId of [...this.answerFailures.keys()]) {
      if (!snapshot.state.interrupts.some((i) => i.ticketId === ticketId)) {
        this.answerFailures.delete(ticketId);
      }
    }
    this.error = null;
    this.vitals.update(snapshot);
    this.terminal.update(snapshot);
    this.tabStatus = poolStatus(snapshot);
    this.poolName = poolDisplayName(snapshot);
    if (snapshot.phase === "stopped" && this.restartWaiting && this.restartPort !== null) {
      // The farewell of the restart this tab asked for: from here the old
      // server is gone and only the new one can answer, so start watching
      // for it. Idempotent, since a repeated `stopped` snapshot would
      // otherwise start a second poll.
      this.awaitRelaunch(this.restartPort);
    }
    this.onChange();
  }

  /**
   * A `live` frame: the activity and peeks that moved, each store
   * repainting once for its part, and the grades whole.
   */
  applyLive(live: LiveMessage): void {
    if (live.activity) this.vitals.apply(live.activity);
    if (live.peeks) this.terminal.apply(live.peeks);
    if (live.grades) {
      this.grades = live.grades;
      this.onChange();
    }
  }

  /**
   * A `card` frame for a subscribed card: its fields replace what is held
   * (a log append continues it). Only the selected card is on screen, so a
   * hovered card's frames are held without a repaint. A frame for a card
   * let go of, already on the wire when it was, is dropped.
   */
  applyCard(card: CardMessage): void {
    if (!this.subscribed.has(card.id)) return;
    const held = this.cards.get(card.id) ?? {};
    const next: CardData = { ...held };
    if (card.body !== undefined) next.body = card.body;
    if (card.events !== undefined) next.events = card.events;
    if (card.error !== undefined) next.error = card.error;
    else if (card.body !== undefined || card.events !== undefined) delete next.error;
    this.cards.set(card.id, next);
    if (card.log !== undefined) this.logs.push(card.id, card.log);
    const moved =
      card.body !== undefined || card.events !== undefined || card.error !== undefined;
    if (moved && card.id === this.selectedCardId) this.onChange();
    if (card.error !== undefined) this.retryCard(card.id);
  }

  /**
   * A card the server could not read (an id it does not know yet, a file
   * it failed on) is let go of, its error shown, and asked for again after
   * CARD_RETRY_MS while the selection or the hover still holds it, so a
   * passing failure does not stand until the card is picked again.
   */
  private retryCard(id: string): void {
    if (this.subscribed.delete(id)) this.socket.unsubscribe(id);
    if (this.cardRetries.has(id)) return;
    this.cardRetries.set(
      id,
      setTimeout(() => {
        this.cardRetries.delete(id);
        if (id === this.selectedCardId || this.hovered.includes(id)) this.hold(id);
        else this.release(id);
      }, this.cardRetryMs),
    );
  }

  /**
   * The socket came up or went down, and keeps the connection banner
   * honest. A close marks the connection down at once, but the banner
   * waits out the grace delay, armed only on the first close of an outage:
   * a dead server closes every retry, and re-arming each time would push
   * the banner past the window forever. A `stopped` close is the exception
   * (issue #97): the server closes every socket right after its farewell,
   * so it is the expected end of an orderly shutdown, not a fault. The
   * connection still goes down, but no banner is raised; the canvas says
   * the pool stopped, and the socket's retry picks a relaunched server back
   * up on its own.
   */
  connection(change: ConnectionChange): void {
    if (change.up) {
      this.cancelGrace();
      if (!this.connected || this.error !== null) {
        this.connected = true;
        this.error = null;
        this.onChange();
      }
      return;
    }
    this.connected = false;
    this.lastConnectionError = change.reason;
    if (change.stopped || this.stoppedPhase()) {
      this.onChange();
      return;
    }
    if (this.graceTimer === null) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (!this.connected && !this.stoppedPhase()) {
          this.error = this.lastConnectionError;
          this.onChange();
        }
      }, CONNECTION_GRACE_MS);
    }
    this.onChange();
  }

  /** The server speaks another protocol version, and the page already
   *  reloaded for that moments ago: say so, and stop claiming a connection. */
  versionChanged(): void {
    this.versionStale = true;
    this.connected = false;
    this.onChange();
  }

  /**
   * The socket's snapshot is null: the server has not started the pool.
   * Start it; the snapshot that start produces renders it.
   */
  start(): void {
    this.socket.request("start", {}).catch((err) => {
      this.reportError(`failed to start the pool: ${messageOf(err)}`);
    });
  }

  // -------------------------------------------------------------------------
  // Selection and hover prefetch
  // -------------------------------------------------------------------------

  /**
   * The selection, reported by the view: hold it, subscribe its card (the
   * server answers with its body, events and log in one frame), let the
   * card it replaced go, and repaint. The repaint waits on nothing: the
   * selection and the Detail's shell show at once, whole when the card was
   * prefetched, and fill in as the frame lands otherwise.
   */
  select(nodeId: string | null): void {
    this.selectedId = nodeId;
    const card = nodeId ? this.cardOf(nodeId) : undefined;
    const next = card ? subscriptionId(card) : null;
    const previous = this.selectedCardId;
    this.selectedCardId = next;
    if (next !== null) {
      // The selection holds it now, outside the hovered few.
      this.hovered = this.hovered.filter((id) => id !== next);
      this.hold(next);
    }
    if (previous !== null && previous !== next) this.release(previous);
    this.logs.show(card?.kind === "ticket" ? card.ticketId : null);
    this.onChange();
  }

  /**
   * The pointer moved onto a card (or off every card, null). A card the
   * pointer rests on for the dwell is subscribed as a prefetch, so a click
   * that follows finds its data in hand; a pass-over sends nothing. At most
   * HOVER_SUBSCRIPTIONS hovered cards are held, the least recently hovered
   * let go first. Nothing here repaints.
   */
  hover(nodeId: string | null): void {
    if (this.dwell !== null) {
      clearTimeout(this.dwell);
      this.dwell = null;
    }
    if (nodeId === null) return;
    const card = this.cardOf(nodeId);
    const id = card ? subscriptionId(card) : null;
    if (id === null || id === this.selectedCardId) return;
    if (this.hovered.includes(id)) {
      this.hovered = [...this.hovered.filter((held) => held !== id), id];
      return;
    }
    this.dwell = setTimeout(() => {
      this.dwell = null;
      if (id === this.selectedCardId || this.hovered.includes(id)) return;
      this.hovered.push(id);
      this.hold(id);
      while (this.hovered.length > HOVER_SUBSCRIPTIONS) this.release(this.hovered.shift()!);
    }, this.hoverDwellMs);
  }

  private hold(id: string): void {
    if (this.subscribed.has(id)) return;
    this.subscribed.add(id);
    this.socket.subscribe({ id });
  }

  // Let a card go once neither the selection nor the hover holds it: its
  // pushes stop and its held data goes with them.
  private release(id: string): void {
    if (id === this.selectedCardId || this.hovered.includes(id)) return;
    if (this.subscribed.delete(id)) this.socket.unsubscribe(id);
    const retry = this.cardRetries.get(id);
    if (retry !== undefined) clearTimeout(retry);
    this.cardRetries.delete(id);
    this.cards.delete(id);
    this.logs.forget(id);
  }

  /** A manually chosen Detail tab for a ticket. */
  selectTab(ticketId: string, tab: DetailTab): void {
    this.tabOverride = { ticketId, tab };
    this.onChange();
  }

  toggleLog(): void {
    this.logOpen = !this.logOpen;
    this.onChange();
  }

  toggleInspector(): void {
    this.inspectorOpen = !this.inspectorOpen;
    this.onChange();
  }

  // -------------------------------------------------------------------------
  // Presses
  // -------------------------------------------------------------------------

  /**
   * Send an action optimistically: the overlay draws what the action will
   * do in the press's own frame, and stands until the reply. Resolves with
   * the result, or rejects with the refusal for the control to show beside
   * itself; either way the overlay is gone and the snapshot as pushed is
   * what shows.
   */
  async optimistic<K extends RequestKind>(
    kind: K,
    payload: RequestPayload<K>,
    overlay: Overlay,
  ): Promise<RequestResult<K>> {
    const key = ++this.overlayCount;
    this.overlays.set(key, overlay);
    this.overlayVersion += 1;
    this.onChange();
    try {
      return await this.socket.request(kind, payload);
    } finally {
      this.overlays.delete(key);
      this.overlayVersion += 1;
      this.onChange();
    }
  }

  /**
   * Answer an interrupt, optimistically: both surfaces show it answered and
   * waiting in the press's frame. Rejects with the refusal's reason so the
   * Needs input tray can mark its own row; the reason also stands beside
   * the Detail's actions until the next answer.
   */
  async answer(
    ticketId: string,
    action: ResumeAction,
    note?: string,
    attempt?: number,
  ): Promise<void> {
    if (this.answerFailures.delete(ticketId)) this.onChange();
    try {
      // `attempt` names the Candidate an Adopt takes (ADR-0035), and rides
      // only when given.
      await this.optimistic(
        "resume",
        {
          ticketId,
          action,
          ...(note ? { note } : {}),
          ...(attempt !== undefined ? { attempt } : {}),
        },
        answered(ticketId, action, note, attempt),
      );
    } catch (err) {
      this.answerFailures.set(ticketId, messageOf(err));
      this.onChange();
      throw err;
    }
  }

  /** True once the latest snapshot is the farewell of an orderly shutdown. */
  private stoppedPhase(): boolean {
    return this.snapshot?.phase === "stopped";
  }

  /** Arm the Stop control's inline confirmation (issue #97). Nothing is sent. */
  armStop(): void {
    this.stopState = "armed";
    this.stopFailure = null;
    this.onChange();
  }

  /** Disarm the confirmation. Nothing is sent, on the way in or out. */
  cancelStop(): void {
    this.stopState = "idle";
    this.stopFailure = null;
    this.onChange();
  }

  /**
   * Send the stop. The button stays on "stopping..." after the accept,
   * because the reply only means the server accepted: the stop itself is
   * done when the farewell `stopped` snapshot lands, and that snapshot
   * withdraws the control. A refusal (the pool started running again, or
   * was never started) or a lost socket disarms and shows its reason inline
   * next to the button, never on the global banner: nothing about the pool
   * is broken, the request simply did not apply.
   */
  async confirmStop(): Promise<void> {
    this.stopState = "requesting";
    this.stopFailure = null;
    this.onChange();
    try {
      await this.socket.request("stop", {});
      this.stoppedFromHere = true;
    } catch (err) {
      this.stopState = "idle";
      this.stopFailure = messageOf(err);
    }
    this.onChange();
  }

  /** Arm the Restart control's inline confirmation. Nothing is sent. */
  armRestart(): void {
    this.restartState = "armed";
    this.restartFailure = null;
    this.onChange();
  }

  /** Disarm it. Nothing is sent, on the way in or out. */
  cancelRestart(): void {
    this.restartState = "idle";
    this.restartFailure = null;
    this.onChange();
  }

  /**
   * Send the restart. The reply carries the port the relaunched server will
   * use, which is the port this tab then watches: a restart that changed
   * the port moves the page to the new origin, and one that did not still
   * needs the page to wait, because the server it is talking to is about to
   * exit. The control stays on "restarting..." from here until the new
   * server answers or the wait runs out; a refusal disarms and shows its
   * reason beside the button, never on the global banner.
   */
  async confirmRestart(): Promise<void> {
    this.restartState = "requesting";
    this.restartFailure = null;
    this.onChange();
    try {
      const response = await this.socket.request("restart", {});
      this.restartWaiting = true;
      this.restartPort = response.port;
      // The farewell usually lands first and starts the poll; a server that
      // exits without one (or a socket already down) would leave nothing to
      // start it, so the accept starts it too. `awaitRelaunch` is idempotent.
      this.awaitRelaunch(response.port);
    } catch (err) {
      this.restartState = "idle";
      this.restartFailure = messageOf(err);
    }
    this.onChange();
  }

  /**
   * Poll the port the restart named until a server answers there, then hand
   * the page over to it. Nothing answering inside the window ends the wait
   * rather than retrying forever: the restarting notice gives way to the
   * ordinary stopped one, which prints the command for relaunching by hand.
   */
  private awaitRelaunch(port: number): void {
    if (this.restartPolling) return;
    if (!this.probeServer || !this.onRelaunched) return;
    this.restartPolling = true;
    const deadline = Date.now() + this.restartWaitMs;
    const tick = async (): Promise<void> => {
      this.restartPoll = null;
      if (!this.restartWaiting) {
        this.restartPolling = false;
        return;
      }
      let alive = false;
      try {
        alive = await this.probeServer!(port);
      } catch {
        alive = false;
      }
      if (!this.restartWaiting) {
        this.restartPolling = false;
        return;
      }
      if (alive) {
        this.restartWaiting = false;
        this.restartPolling = false;
        this.onRelaunched!(port);
        return;
      }
      if (Date.now() >= deadline) {
        this.restartWaiting = false;
        this.restartPolling = false;
        this.restartState = "idle";
        this.onChange();
        return;
      }
      this.restartPoll = setTimeout(() => void tick(), this.restartPollMs);
    };
    this.restartPoll = setTimeout(() => void tick(), this.restartPollMs);
  }

  private cancelRelaunchPoll(): void {
    this.restartPolling = false;
    if (this.restartPoll !== null) {
      clearTimeout(this.restartPoll);
      this.restartPoll = null;
    }
  }

  /**
   * Keep talking (issue #139): ask the engine to continue the ticket's
   * checkpointed Attempt in its Held pane. The mark disables the button on
   * both surfaces in the press's own frame and stays after the engine
   * accepts, since the ticket leaves checkpoint only when the snapshot says
   * so; that snapshot drops the mark. A refusal clears the in-flight flag
   * and keeps its reason on the mark, shown beside the button on both
   * surfaces, never on the global banner. A click with no Held pane, or one
   * already out for it, sends nothing.
   */
  async keepTalking(ticketId: string): Promise<void> {
    const held = this.snapshot?.state.tickets.find((t) => t.id === ticketId)?.heldPane;
    if (!held) return;
    const mark = this.keepTalkingMarks.get(ticketId);
    if (mark?.attempt === held.attempt && mark.requesting) return;
    this.keepTalkingMarks.set(ticketId, {
      attempt: held.attempt,
      requesting: true,
      failure: null,
    });
    this.onChange();
    try {
      await this.socket.request("keepTalking", { ticketId });
    } catch (err) {
      // The snapshot may have dropped the mark while the request was out;
      // a refusal for a pane that is already gone has nothing left to mark.
      const current = this.keepTalkingMarks.get(ticketId);
      if (current?.attempt === held.attempt) {
        this.keepTalkingMarks.set(ticketId, {
          ...current,
          requesting: false,
          failure: messageOf(err),
        });
        this.onChange();
      }
    }
  }

  /** Drop the Keep talking marks whose ticket no longer holds the pane they
   *  were asked of. */
  private pruneKeepTalking(snapshot: EnrichedSnapshot): void {
    for (const [ticketId, mark] of [...this.keepTalkingMarks]) {
      const held = snapshot.state.tickets.find((t) => t.id === ticketId)?.heldPane;
      if (held?.attempt !== mark.attempt) this.keepTalkingMarks.delete(ticketId);
    }
  }

  /** Arm the close-finished-terminals confirmation (issue #139). Nothing is sent. */
  armCloseTerminals(): void {
    this.closeTerminalsState = "armed";
    this.closeTerminalsFailure = null;
    this.onChange();
  }

  /** Disarm it. Nothing is sent, on the way in or out. */
  cancelCloseTerminals(): void {
    this.closeTerminalsState = "idle";
    this.closeTerminalsFailure = null;
    this.onChange();
  }

  /**
   * Close the Finished terminals. The count on the button comes from the
   * snapshot, and the delta that drops it is ahead of the reply, so the
   * reply only returns the control to idle. A refusal (a pool that is not
   * Terminal-backed) or a lost socket disarms and shows its reason beside
   * the button, the way Stop does.
   */
  async confirmCloseTerminals(): Promise<void> {
    this.closeTerminalsState = "requesting";
    this.closeTerminalsFailure = null;
    this.onChange();
    try {
      await this.socket.request("terminals.closeFinished", {});
    } catch (err) {
      this.closeTerminalsFailure = messageOf(err);
    }
    this.closeTerminalsState = "idle";
    this.onChange();
  }

  /**
   * "Load earlier" in the pool log drawer: the lines before the ones held,
   * read once at a time and prepended. From the moment it is asked, lines
   * the window lets go are kept, so the read's lines meet them with no gap.
   */
  async loadEarlierPoolLog(): Promise<void> {
    if (!this.snapshot || this.earlierLoading) return;
    const before = this.logTotal - this.earlier.length - this.snapshot.state.log.length;
    if (before <= 0) return;
    const generation = this.earlierGeneration;
    this.earlierLoading = true;
    this.earlierError = null;
    this.onChange();
    try {
      const range = await this.socket.request("poolLog.read", { before });
      if (generation !== this.earlierGeneration) return;
      this.earlier = [...range.lines, ...this.earlier];
      this.earlierVersion += 1;
      // What the operator asked to read is never let go of by the cap; the
      // lines the window lets go of later are, past it.
      this.earlierCap = Math.max(POOL_LOG_EARLIER_KEPT, this.earlier.length);
    } catch (err) {
      if (generation !== this.earlierGeneration) return;
      this.earlierError = `load earlier failed: ${messageOf(err)}`;
    } finally {
      if (generation === this.earlierGeneration) {
        this.earlierLoading = false;
        this.onChange();
      }
    }
  }

  // Keep `earlier` contiguous with the window: an append that pushes lines
  // out of the window moves them onto its end while it holds any or a read
  // is out; a new log or a whole snapshot starts over.
  private followPoolLog(pushed: PushedSnapshot, delta: SnapshotDelta | null): void {
    const log = delta?.log;
    if (delta !== null && log === undefined) return;
    if (delta === null || !("append" in log!) || !this.snapshot) {
      if (this.earlier.length > 0 || this.earlierLoading || this.earlierError !== null) {
        this.earlier = [];
        this.earlierVersion += 1;
        this.earlierCap = POOL_LOG_EARLIER_KEPT;
        this.earlierLoading = false;
        this.earlierError = null;
        this.earlierGeneration += 1;
      }
      return;
    }
    if (this.earlier.length === 0 && !this.earlierLoading) return;
    const old = this.snapshot.state.log;
    const appended = log.append;
    const slid = old.length + appended.length - pushed.snapshot.state.log.length;
    if (slid <= 0) return;
    // In place: an append costs the lines it pushes out, not the whole run.
    for (let i = 0; i < Math.min(slid, old.length); i++) this.earlier.push(old[i]!);
    for (let i = 0; i < slid - old.length; i++) this.earlier.push(appended[i]!);
    if (this.earlier.length > this.earlierCap) {
      this.earlier.splice(0, this.earlier.length - this.earlierCap);
    }
    this.earlierVersion += 1;
  }

  /** Surface a failure on the global banner (the fire-and-forget paths). */
  reportError(message: string): void {
    this.error = message;
    this.onChange();
  }

  // -------------------------------------------------------------------------
  // The render model
  // -------------------------------------------------------------------------

  /**
   * The render model: the single derivation point. One `projectPool` per
   * render, over the snapshot with any optimistic overlays drawn on it, and
   * stored so the Detail and the next selection read the same cards.
   */
  model(endings: Record<string, ConversationEndView>): AppModel {
    const snapshot = this.shownSnapshot();
    this.view = snapshot
      ? this.derivePool(
          snapshot,
          this.grades,
          this.vitals.state(),
          this.terminal.state(),
          Date.now(),
          endings,
          Object.fromEntries(this.keepTalkingMarks),
        )
      : null;
    const cards = this.view?.cards ?? [];
    const detail = this.selectedId
      ? projectDetail(cards, this.selectedId, {
          pending: this.view?.pendingSpawns ?? [],
          held: this.view?.heldSpawns ?? [],
        })
      : null;
    const detailTicketId = detail?.kind === "ticket" ? detail.ticketId : null;
    // The selected card's frames: a ticket's body, events and log, a
    // Conversation's events (its log pane is not part of this surface).
    const detailCardId =
      detail?.kind === "ticket"
        ? detail.ticketId
        : detail?.kind === "conversation"
          ? detail.conversationId
          : null;
    const data = detailCardId !== null ? this.cards.get(detailCardId) : undefined;
    const card = this.view?.cards.find((c) => c.id === this.selectedId);
    const timelineView =
      detailCardId !== null && data?.events
        ? this.timelineOf(detailCardId, data.events, timelineStatus(card))
        : null;
    const logIsCurrent =
      detailTicketId !== null && this.logs.state.ticketId === detailTicketId;
    // The timeline joins the log pane's attempt listing (the log frames'
    // per-attempt Stream file resolution), so each attempt row knows its
    // Stream file. A pane for another ticket (or no pane yet, or a
    // Conversation, which has no log pane) contributes no listing.
    const timeline = timelineView
      ? this.joinedOf(timelineView, logIsCurrent ? this.logs.state.attempts : null)
      : null;
    const logHeld = this.earlier.length + (this.snapshot?.state.log.length ?? 0);
    return {
      poolName: this.poolName,
      phase: this.view?.phase ?? null,
      phaseLabel: this.view ? phaseLabel(this.view.phase) : "connecting",
      cards,
      edges: this.view?.edges ?? [],
      logText: this.logOpen ? this.poolLogText() : "",
      logHeld,
      logTotal: Math.max(this.logTotal, logHeld),
      logEarlier: {
        loading: this.earlierLoading,
        error: this.earlierError,
      },
      logOpen: this.logOpen,
      inspectorJson: this.inspectorText(),
      inspectorOpen: this.inspectorOpen,
      connected: this.connected,
      seq: this.snapshot?.seq ?? 0,
      error: this.versionStale ? VERSION_BANNER : this.error,
      stop: {
        // Offered only on a done pool over a live socket (issue #97): there
        // is nothing to interrupt, and a request down a dead socket would go
        // nowhere. The relaunch command is Boot on the pool directory
        // verbatim, as the snapshot carries it.
        offered: this.view?.phase === "done" && this.connected,
        state: this.stopState,
        failure: this.stopFailure,
        stoppedFromHere: this.stoppedFromHere,
        relaunch: this.snapshot
          ? `agent-console ${this.snapshot.poolDir}`
          : null,
      },
      restart: {
        // Offered on a live socket in any phase, and kept while this tab
        // waits for the relaunch, so the control can say "restarting..."
        // after the socket has gone with the old server.
        offered: this.connected || this.restartWaiting,
        state: this.restartState,
        failure: this.restartFailure,
        waiting: this.restartWaiting,
      },
      closeTerminals: {
        // Offered while any Finished terminal is open, over a live socket
        // for the same reason Stop is: a request down a dead socket goes
        // nowhere, and the count it would show could be stale.
        offered: (this.snapshot?.finishedTerminals ?? 0) > 0 && this.connected,
        count: this.snapshot?.finishedTerminals ?? 0,
        state: this.closeTerminalsState,
        failure: this.closeTerminalsFailure,
      },
      terminalBacked: snapshot ? isTerminalBacked(snapshot.state.config) : false,
      mergeQueueLine: this.view?.mergeQueueLine ?? null,
      spawnLine: this.view?.spawnLine ?? null,
      pendingSpawns: this.view?.pendingSpawns ?? [],
      heldSpawns: this.view?.heldSpawns ?? [],
      detail,
      detailTabs:
        detail?.kind === "ticket" ? projectDetailTabs(detail, this.tabOverride) : null,
      detailBody:
        detailTicketId !== null && data?.body !== undefined
          ? (data.body?.body ?? null)
          : undefined,
      detailBodyError:
        detailTicketId !== null && data?.error !== undefined
          ? `ticket body unavailable: ${data.error}`
          : null,
      answerFailures: Object.fromEntries(this.answerFailures),
      timeline,
      logPane: detailTicketId
        ? projectLogPane(
            timelineView,
            logIsCurrent ? this.logs.state.attempt : null,
            logIsCurrent
              ? {
                  stream: this.logs.state.stream,
                  content: this.logs.state.content,
                  firstOffset: this.logs.state.firstOffset,
                  offset: this.logs.state.offset,
                  totalSize: this.logs.state.totalSize,
                }
              : null,
            logIsCurrent ? this.logs.state.error : null,
          )
        : null,
      needsInput: projectNeedsInput(cards),
      conversationsNeedsInput: snapshot ? projectConversationsNeedsInput(snapshot) : [],
      conversationsTray: snapshot
        ? projectConversationsTray(snapshot.state.conversations)
        : [],
      conversationDefaults: snapshot ? poolAssignmentDefaults(snapshot.state.config) : {},
      steward: this.view?.steward ?? null,
      stewardDefaults: snapshot ? stewardAssignmentDefaults(snapshot.state.config) : {},
      enlistBlocks: snapshot ? projectEnlistBlocks(snapshot.state.tickets) : [],
      reassignTickets: snapshot ? projectReassignTickets(snapshot.state.tickets) : [],
    };
  }

  /** The snapshot with every optimistic overlay drawn on it, kept until
   *  the snapshot or the overlays change. */
  private shownSnapshot(): EnrichedSnapshot | null {
    if (!this.snapshot) return null;
    if (this.overlays.size === 0) return this.snapshot;
    if (this.shown?.base !== this.snapshot || this.shown.overlays !== this.overlayVersion) {
      this.shown = {
        base: this.snapshot,
        overlays: this.overlayVersion,
        snapshot: applyOverlays(this.snapshot, this.overlays.values()),
      };
    }
    return this.shown.snapshot;
  }

  /** The pool log drawer's text: the earlier lines read back, then the
   *  window, joined once per change to either. */
  private poolLogText(): string {
    const window = this.snapshot?.state.log ?? [];
    if (this.logText?.version !== this.earlierVersion || this.logText.window !== window) {
      if (this.earlierText?.version !== this.earlierVersion) {
        this.earlierText = { version: this.earlierVersion, text: this.earlier.join("\n") };
      }
      const tail = window.join("\n");
      const text =
        this.earlier.length === 0
          ? tail
          : window.length === 0
            ? this.earlierText.text
            : `${this.earlierText.text}\n${tail}`;
      this.logText = { version: this.earlierVersion, window, text };
    }
    return this.logText.text;
  }

  private timelineOf(
    id: string,
    events: TicketEventsResponse,
    status: TicketStatus,
  ): TimelineView {
    const held = this.timeline;
    if (held?.id !== id || held.events !== events || held.status !== status) {
      const previous = held?.id === id ? { response: held.events, view: held.view } : null;
      this.timeline = { id, events, status, view: projectTimeline(events, status, previous) };
    }
    return this.timeline!.view;
  }

  private joinedOf(view: TimelineView, listing: LogPaneState["attempts"] | null): TimelineView {
    if (this.joined?.view !== view || this.joined.listing !== listing) {
      this.joined = { view, listing, joined: joinStreamFiles(view, listing) };
    }
    return this.joined.joined;
  }

  /**
   * The State inspector's text: the snapshot's state pretty-printed, built
   * only while the drawer is open and once per snapshot (issue #157). The
   * whole pool's state is the largest string the Console makes, and nothing
   * shows it while the drawer is shut.
   */
  private inspectorText(): string {
    if (!this.inspectorOpen) return "";
    if (!this.snapshot) return "- no state yet -";
    if (this.inspector?.snapshot !== this.snapshot) {
      this.inspector = {
        snapshot: this.snapshot,
        json: JSON.stringify(this.snapshot.state, null, 2),
      };
    }
    return this.inspector.json;
  }

  /** A card, off the latest derivation. */
  private cardOf(nodeId: string): PoolCardView | undefined {
    return this.view?.cards.find((card) => card.id === nodeId);
  }

  private cancelGrace(): void {
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /** Stop every timer the session holds (teardown): the connection's
   *  grace, the hover's dwell, the relaunch poll and the card retries. */
  dispose(): void {
    this.cancelGrace();
    if (this.dwell !== null) clearTimeout(this.dwell);
    this.dwell = null;
    this.restartWaiting = false;
    this.cancelRelaunchPoll();
    for (const timer of this.cardRetries.values()) clearTimeout(timer);
    this.cardRetries.clear();
  }
}

/** The id a card subscribes under: a ticket's or a Conversation's own id.
 *  Spawn and utility cards have no frames to subscribe to. */
function subscriptionId(card: PoolCardView): string | null {
  if (card.kind === "ticket") return card.ticketId;
  if (card.kind === "conversation") return card.conversationId;
  return null;
}

/**
 * The status the selected card's timeline reads its running attempt from.
 * A Conversation's has no direct TicketStatus equivalent: `live` reads as
 * `in-progress`, anything else as `done` (nothing left running).
 */
function timelineStatus(card: PoolCardView | undefined): TicketStatus {
  if (card?.kind === "ticket") return card.status;
  if (card?.kind === "conversation") return card.status === "live" ? "in-progress" : "done";
  return "ready";
}
