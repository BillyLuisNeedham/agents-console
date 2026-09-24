/**
 * Console session: the one module that owns the Console's session state.
 * The snapshot, the selection, the ticket-body caches, the grades, the tab
 * override, and the stale-answer guards live here, behind injected fetch
 * seams, the LogPane way: async IO plus change notification belong to the
 * module, not the render pass. `model()` is the single derivation point:
 * one `projectPool` per render, stored so the selection, the timeline
 * coordination, and the Detail all read the same cards. No DOM references;
 * the bootstrap constructs it, drives it, and renders when it changes.
 */

import { refetchStateOnVisible, type VisibilitySource } from "./client";
import { StaleGuard } from "./guard";
import { LogPane, type LogFetch } from "./log-pane";
import {
  isTerminalBacked,
  joinStreamFiles,
  phaseLabel,
  poolAssignmentDefaults,
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
  selectLogAttempt,
  type ConversationEndView,
  type DetailTab,
  type EnrichedSnapshot,
  type PoolCardView,
  type PoolTabStatus,
  type PoolView,
  type RestartResponse,
  type ResumeAction,
  type TabOverride,
  type TerminalSurfaceView,
  type TicketBodyResponse,
  type TicketEventsResponse,
  type TicketGradeSummary,
  type TimelineView,
  type VitalsState,
} from "./project";
import type { AppModel, StopState } from "./view";

/** The vitals store, as the session consumes it. */
export interface SessionVitals {
  update(snapshot: EnrichedSnapshot): void;
  state(): Record<string, VitalsState>;
}

/** The terminal surface store, as the session consumes it. */
export interface SessionTerminal {
  update(snapshot: EnrichedSnapshot): void;
  state(): Record<string, TerminalSurfaceView>;
}

export interface ConsoleSessionOptions {
  getState: () => Promise<EnrichedSnapshot | null>;
  getEvents: (id: string) => Promise<TicketEventsResponse>;
  getTicket: (id: string) => Promise<TicketBodyResponse | null>;
  getGrades: () => Promise<Record<string, TicketGradeSummary>>;
  /** The log pane's byte-range fetch, handed to the LogPane the session owns. */
  getLog: LogFetch;
  /** Answer an interrupt; resolves with the resumed pool's snapshot. */
  answer: (
    ticketId: string,
    action: ResumeAction,
    note?: string,
  ) => Promise<EnrichedSnapshot>;
  /** Stop this pool's server (issue #97). Resolves when the server has
   *  accepted the stop, rejects with the refusal's reason. */
  stop: () => Promise<void>;
  /** Restart this pool's server (ADR-0026). Resolves with the port the
   *  relaunched server will use; rejects with the refusal's reason. */
  restart: () => Promise<RestartResponse>;
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
  /** Open the snapshot stream; returns a function that closes it. */
  stream: (handlers: {
    onSnapshot: (snapshot: EnrichedSnapshot) => void;
    onError: (message: string) => void;
  }) => () => void;
  vitals: SessionVitals;
  terminal: SessionTerminal;
  /** The derivation, injectable so tests can count it. Defaults to the real
   *  projection. */
  projectPool?: typeof projectPool;
  /** A page's visibility lifecycle, for the refetch-on-visible wiring; the
   *  bootstrap passes `document`, tests omit it. */
  visibility?: VisibilitySource;
  /** Called after every state change the view should repaint. */
  onChange: () => void;
}

// A stream error marks the connection down at once, but the banner waits out
// a grace delay: a snapshot inside the window (the server replays the latest
// on reconnect) cancels it, and reconnect clears one already showing.
const STREAM_GRACE_MS = 4000;

// The relaunch poll after a Restart (ADR-0026): a Boot that has to rebuild a
// stale UI takes tens of seconds, so the window is generous, and the cadence
// is slow enough to cost nothing while it waits.
const RESTART_POLL_MS = 1000;
const RESTART_WAIT_MS = 60_000;

// The stale-answer guard's keys: one for the selected card's timeline loads,
// one for the ticket-body loads.
const TIMELINE_KEY = "timeline";
const BODY_KEY = "body";

export class ConsoleSession {
  /** The selected ticket's raw log pane: the byte-window state machine,
   *  opened, followed, and reset by the session's timeline coordination and
   *  driven by the view's attempt and stream handlers. */
  readonly logs: LogPane;

  private readonly getState: ConsoleSessionOptions["getState"];
  private readonly getEvents: ConsoleSessionOptions["getEvents"];
  private readonly getTicket: ConsoleSessionOptions["getTicket"];
  private readonly getGrades: ConsoleSessionOptions["getGrades"];
  private readonly answerSeam: ConsoleSessionOptions["answer"];
  private readonly stopSeam: ConsoleSessionOptions["stop"];
  private readonly restartSeam: ConsoleSessionOptions["restart"];
  private readonly probeServer: ConsoleSessionOptions["probeServer"];
  private readonly onRelaunched: ConsoleSessionOptions["onRelaunched"];
  private readonly restartPollMs: number;
  private readonly restartWaitMs: number;
  private readonly streamSeam: ConsoleSessionOptions["stream"];
  private readonly vitals: SessionVitals;
  private readonly terminal: SessionTerminal;
  private readonly derivePool: typeof projectPool;
  private readonly onChange: () => void;

  private snapshot: EnrichedSnapshot | null = null;
  private selectedId: string | null = null;
  private logOpen = false;
  private inspectorOpen = false;
  private error: string | null = null;
  private connected = false;

  // The Stop control's state (issue #97). The confirmation is inline on the
  // button, so it is one small state machine, not a modal: `armed` is the
  // "Really stop?" prompt, `requesting` the POST in flight. It lives in
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
  // is now polling for the server Boot brings back; every other tab sees an
  // ordinary stop and its usual retry finds the same server.
  private restartState: StopState = "idle";
  private restartFailure: string | null = null;
  private restartWaiting = false;
  private restartPort: number | null = null;
  private restartPoll: ReturnType<typeof setTimeout> | null = null;
  // One poll chain at a time: the accept and the farewell both start it, and
  // the second must not lay a second chain over the first.
  private restartPolling = false;

  // The selected card's timeline: the events fetch answers on its own
  // cadence, and a slow answer answering after a newer selection (or a newer
  // refetch) is dropped by the guard, never clobbering the newer rows.
  private timelineState: { ticketId: string | null; view: TimelineView | null } = {
    ticketId: null,
    view: null,
  };

  // The latest grade per ticket, for the card summaries; refetched on the
  // snapshot cadence. Absent until the first fetch lands: the cards render
  // no grade UI until then, which is the no-grade state anyway.
  private grades: Record<string, TicketGradeSummary> = {};

  // Ticket bodies for the Spec tab: fetched once per ticket on first
  // selection and held for the session; a 404 caches null so a known-missing
  // body is never refetched. A failed fetch surfaces on the Spec tab, and
  // the next selection retries because nothing was cached.
  private readonly ticketBodies = new Map<string, string | null>();
  private readonly ticketBodyFetches = new Set<string>();
  private readonly ticketBodyErrors = new Map<string, string>();

  // The manually chosen Detail tab, carrying its ticket id: the projection
  // ignores it for any other ticket, so changing the selection reasserts the
  // phase default.
  private tabOverride: TabOverride | null = null;

  // The latest derivation, refreshed by `model()` on every render and read
  // by the selection and timeline coordination between renders.
  private view: PoolView | null = null;

  private readonly guard = new StaleGuard();

  // The browser tab's status, recomputed on every applied snapshot; the
  // bootstrap renders them into the title and favicon (DOM is its own).
  tabStatus: PoolTabStatus | null = null;
  /** The pool as the Console names it: its Pool title, else its directory. */
  poolName: string | null = null;

  constructor(options: ConsoleSessionOptions) {
    this.getState = options.getState;
    this.getEvents = options.getEvents;
    this.getTicket = options.getTicket;
    this.getGrades = options.getGrades;
    this.answerSeam = options.answer;
    this.stopSeam = options.stop;
    this.restartSeam = options.restart;
    this.probeServer = options.probeServer;
    this.onRelaunched = options.onRelaunched;
    this.restartPollMs = options.restartPollMs ?? RESTART_POLL_MS;
    this.restartWaitMs = options.restartWaitMs ?? RESTART_WAIT_MS;
    this.streamSeam = options.stream;
    this.vitals = options.vitals;
    this.terminal = options.terminal;
    this.derivePool = options.projectPool ?? projectPool;
    this.onChange = options.onChange;
    this.logs = new LogPane({
      fetch: options.getLog,
      onChange: () => this.onChange(),
    });
    if (options.visibility) {
      // Belt and braces over the stream's self-healing: a tab that returns
      // to visible (after the machine slept, or hours buried) refetches the
      // latest snapshot, so a stale page catches up even before the stream's
      // silence watchdog reopens it.
      refetchStateOnVisible(options.visibility, this.getState, (snapshot) =>
        this.setSnapshot(snapshot),
      );
    }
  }

  /**
   * Apply a snapshot, from the boot fetch, the stream, an answer, or the
   * visibility refetch: hold it, refresh the vitals and terminal stores and
   * the tab status, refetch the selected card's timeline (a new snapshot can
   * move the selected ticket; the events file is append-only and small, so a
   * refetch is cheap), refetch the grades, and repaint.
   */
  setSnapshot(snapshot: EnrichedSnapshot): void {
    const wasStopped = this.snapshot?.phase === "stopped";
    this.snapshot = snapshot;
    this.connected = true;
    if (wasStopped && snapshot.phase !== "stopped") {
      // A fresh snapshot after a `stopped` one is the relaunched server the
      // client's retry found on its own (issue #97): the page is live again,
      // so the stop control and the "from this page" marker start over.
      this.stoppedFromHere = false;
      this.stopState = "idle";
      this.stopFailure = null;
      this.cancelRelaunchPoll();
      this.restartWaiting = false;
      this.restartState = "idle";
      this.restartFailure = null;
    } else if (this.stopState === "armed" && snapshot.phase !== "done") {
      // Stop is offered only on a done pool, so a phase that moved off done
      // withdraws the offer and the armed confirmation goes with it. A
      // request already in flight keeps its label until the farewell lands.
      this.stopState = "idle";
      this.stopFailure = null;
    }
    this.error = null;
    this.vitals.update(snapshot);
    this.terminal.update(snapshot);
    this.tabStatus = poolStatus(snapshot);
    this.poolName = poolDisplayName(snapshot);
    if (snapshot.phase === "stopped" && this.restartWaiting && this.restartPort !== null) {
      // The farewell of the restart this tab asked for: from here the old
      // server is gone and only the new one can answer, so start watching
      // for it. Idempotent, since a replayed `stopped` snapshot would
      // otherwise start a second poll.
      this.awaitRelaunch(this.restartPort);
    }
    if (this.selectedId) void this.loadTimeline();
    this.refreshGrades();
    this.onChange();
  }

  /**
   * Open the snapshot stream and keep the connection banner honest. A
   * stream error marks the connection down at once, but the banner waits
   * out the grace delay, and the timer arms only on the first error of an
   * outage: a dead connection re-fires onError on every retry, and
   * re-arming each time would push the banner past the grace window forever.
   * A `stopped` snapshot is the exception (issue #97): the server closes
   * every stream and stops serving right after that farewell, so the
   * disconnect that follows is the expected end of an orderly shutdown, not
   * a fault. The connection still goes down, but no banner is raised; the
   * canvas says the pool stopped, and the client's retry picks a relaunched
   * server back up on its own.
   */
  connect(): void {
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastStreamError = "";
    const cancelGrace = () => {
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };
    this.streamSeam({
      onSnapshot: (snapshot) => {
        cancelGrace();
        this.setSnapshot(snapshot);
      },
      onError: (message) => {
        this.connected = false;
        lastStreamError = message;
        if (this.stoppedPhase()) {
          this.onChange();
          return;
        }
        if (graceTimer === null) {
          graceTimer = setTimeout(() => {
            graceTimer = null;
            if (!this.connected && !this.stoppedPhase()) {
              this.error = lastStreamError;
              this.onChange();
            }
          }, STREAM_GRACE_MS);
        }
        this.onChange();
      },
    });
  }

  /**
   * The selection, reported by the view: hold it, fetch the newly selected
   * ticket's body once, reload the timeline, and repaint.
   */
  select(nodeId: string | null): void {
    this.selectedId = nodeId;
    if (nodeId) {
      const ticketId = this.selectedTicketId();
      if (ticketId) this.ensureTicketBody(ticketId);
    }
    void this.loadTimeline();
    this.onChange();
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

  /**
   * Answer an interrupt: one answer, one action, and the response snapshot
   * applies like any other. Rejects on failure so the Needs input tray can
   * mark its own row; the Detail's fire-and-forget path catches and reports
   * through `reportError`.
   */
  async answer(
    ticketId: string,
    action: ResumeAction,
    note?: string,
  ): Promise<void> {
    const snapshot = await this.answerSeam(ticketId, action, note);
    this.setSnapshot(snapshot);
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
   * Send the stop. The button stays on "stopping..." after the 202, because
   * the request only means the server accepted: the stop itself is done when
   * the farewell `stopped` snapshot lands, and that snapshot withdraws the
   * control. A refusal (the pool started running again, or was never
   * started) or a network failure disarms and shows its reason inline next
   * to the button, never on the global banner: nothing about the pool is
   * broken, the request simply did not apply.
   */
  async confirmStop(): Promise<void> {
    this.stopState = "requesting";
    this.stopFailure = null;
    this.onChange();
    try {
      await this.stopSeam();
      this.stoppedFromHere = true;
    } catch (err) {
      this.stopState = "idle";
      this.stopFailure = err instanceof Error ? err.message : String(err);
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
   * Send the restart. The 202 carries the port the relaunched server will
   * use, which is the port this tab then watches: a restart that changed the
   * port moves the page to the new origin, and one that did not still needs
   * the page to wait, because the server it is talking to is about to exit.
   * The control stays on "restarting..." from here until the new server
   * answers or the wait runs out; a refusal disarms and shows its reason
   * beside the button, never on the global banner.
   */
  async confirmRestart(): Promise<void> {
    this.restartState = "requesting";
    this.restartFailure = null;
    this.onChange();
    try {
      const response = await this.restartSeam();
      this.restartWaiting = true;
      this.restartPort = response.port;
      // The farewell usually lands first and starts the poll; a server that
      // exits without one (or a stream already down) would leave nothing to
      // start it, so the accept starts it too. `awaitRelaunch` is idempotent.
      this.awaitRelaunch(response.port);
    } catch (err) {
      this.restartState = "idle";
      this.restartFailure = err instanceof Error ? err.message : String(err);
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

  /** Surface a failure on the global banner (the fire-and-forget paths). */
  reportError(message: string): void {
    this.error = message;
    this.onChange();
  }

  /**
   * The render model: the single derivation point. One `projectPool` per
   * render, stored so the Detail, the timeline join, and the next selection
   * or snapshot's coordination all read the same cards.
   */
  model(endings: Record<string, ConversationEndView>): AppModel {
    this.view = this.snapshot
      ? this.derivePool(
          this.snapshot,
          this.grades,
          this.vitals.state(),
          this.terminal.state(),
          Date.now(),
          endings,
        )
      : null;
    const cards = this.view?.cards ?? [];
    const detail = this.selectedId ? projectDetail(cards, this.selectedId) : null;
    const detailTicketId = detail?.kind === "ticket" ? detail.ticketId : null;
    // The events fetch (and so the timeline) covers a selected Conversation
    // too, reusing /api/events?ticket=<id>; the raw log pane below it stays
    // ticket-only.
    const detailEventsId =
      detail?.kind === "ticket"
        ? detail.ticketId
        : detail?.kind === "conversation"
          ? detail.conversationId
          : null;
    const isCurrent =
      detailEventsId !== null && this.timelineState.ticketId === detailEventsId;
    const logIsCurrent =
      detailTicketId !== null && this.logs.state.ticketId === detailTicketId;
    // The timeline joins the log pane's attempt listing (the /api/log
    // response's per-attempt Stream file resolution), so each attempt row
    // knows its Stream file. A pane for another ticket (or no pane yet, or a
    // Conversation, which has no log pane) contributes no listing.
    const timeline =
      isCurrent && this.timelineState.view
        ? joinStreamFiles(
            this.timelineState.view,
            logIsCurrent ? this.logs.state.attempts : null,
          )
        : null;
    return {
      poolName: this.poolName,
      phase: this.view?.phase ?? null,
      phaseLabel: this.view ? phaseLabel(this.view.phase) : "connecting",
      cards,
      edges: this.view?.edges ?? [],
      log: this.view ? this.view.log : [],
      logOpen: this.logOpen,
      inspectorJson: this.snapshot
        ? JSON.stringify(this.snapshot.state, null, 2)
        : "- no state yet -",
      inspectorOpen: this.inspectorOpen,
      connected: this.connected,
      seq: this.snapshot?.seq ?? 0,
      error: this.error,
      stop: {
        // Offered only on a done pool over a live stream (issue #97): there
        // is nothing to interrupt, and a POST down a dead stream would go
        // nowhere. The relaunch command is the pool directory verbatim, as
        // the snapshot carries it.
        offered: this.view?.phase === "done" && this.connected,
        state: this.stopState,
        failure: this.stopFailure,
        stoppedFromHere: this.stoppedFromHere,
        relaunch: this.snapshot
          ? `bun run engine/server.ts --pool ${this.snapshot.poolDir}`
          : null,
      },
      restart: {
        // Offered on a live stream in any phase, and kept while this tab
        // waits for the relaunch, so the control can say "restarting..."
        // after the stream has gone with the old server.
        offered: this.connected || this.restartWaiting,
        state: this.restartState,
        failure: this.restartFailure,
        waiting: this.restartWaiting,
      },
      terminalBacked: this.snapshot
        ? isTerminalBacked(this.snapshot.state.config)
        : false,
      mergeQueueLine: this.view?.mergeQueueLine ?? null,
      detail,
      detailTabs:
        detail?.kind === "ticket" ? projectDetailTabs(detail, this.tabOverride) : null,
      detailBody:
        detailTicketId !== null && this.ticketBodies.has(detailTicketId)
          ? (this.ticketBodies.get(detailTicketId) ?? null)
          : undefined,
      detailBodyError:
        detailTicketId !== null
          ? (this.ticketBodyErrors.get(detailTicketId) ?? null)
          : null,
      timeline,
      logPane: detailTicketId
        ? projectLogPane(
            isCurrent ? this.timelineState.view : null,
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
      conversationsNeedsInput: this.snapshot
        ? projectConversationsNeedsInput(this.snapshot)
        : [],
      conversationsTray: this.snapshot
        ? projectConversationsTray(this.snapshot.state.conversations)
        : [],
      conversationDefaults: this.snapshot
        ? poolAssignmentDefaults(this.snapshot.state.config)
        : {},
      enlistBlocks: this.snapshot
        ? projectEnlistBlocks(this.snapshot.state.tickets)
        : [],
      reassignTickets: this.snapshot
        ? projectReassignTickets(this.snapshot.state.tickets)
        : [],
    };
  }

  // -------------------------------------------------------------------------
  // Timeline and body loads
  // -------------------------------------------------------------------------

  /** The selected card, off the latest derivation. */
  private selectedCard(): PoolCardView | undefined {
    if (!this.selectedId) return undefined;
    return this.view?.cards.find((card) => card.id === this.selectedId);
  }

  /** The selected card's ticket id, when it is a ticket card. */
  private selectedTicketId(): string | null {
    const card = this.selectedCard();
    return card?.kind === "ticket" ? card.ticketId : null;
  }

  /**
   * The id the events endpoint is fetched for: a ticket's or a
   * Conversation's, since /api/events?ticket=<id> accepts either (a
   * Conversation's timeline reuses the same path). Null when the selection
   * is neither, or nothing is selected.
   */
  private selectedEventsId(): string | null {
    const card = this.selectedCard();
    if (card?.kind === "ticket") return card.ticketId;
    if (card?.kind === "conversation") return card.conversationId;
    return null;
  }

  private async loadTimeline(): Promise<void> {
    const id = this.selectedEventsId();
    const token = this.guard.begin(TIMELINE_KEY);
    if (!id) {
      this.timelineState.ticketId = null;
      this.timelineState.view = null;
      this.logs.reset();
      this.onChange();
      return;
    }
    // The raw log pane tails a ticket attempt's log file; a Conversation's
    // timeline reuses the same events fetch, but not the log pane (its own
    // log-tailing story is not part of this surface yet).
    const isTicket = this.selectedTicketId() === id;
    this.timelineState.ticketId = id;
    try {
      const response = await this.getEvents(id);
      // A newer selection or refetch may have begun while the fetch was out.
      if (!this.guard.isCurrent(TIMELINE_KEY, token)) return;
      this.applyTimeline(id, response);
      if (!isTicket) {
        this.logs.reset();
        this.onChange();
        return;
      }
      // The snapshot cadence doubles as the liveness signal: a newly
      // selected ticket opens its pane, and an already-open pane follows
      // the tail.
      if (this.logs.state.ticketId !== id) {
        this.openLogPane(id);
      } else {
        void this.logs.follow(id, this.timelineState.view);
        this.onChange();
      }
    } catch {
      if (this.guard.isCurrent(TIMELINE_KEY, token)) {
        this.timelineState.view = null;
        this.onChange();
      }
    }
  }

  private applyTimeline(id: string, response: TicketEventsResponse): void {
    const card = this.view?.cards.find(
      (c) =>
        (c.kind === "ticket" && c.ticketId === id) ||
        (c.kind === "conversation" && c.conversationId === id),
    );
    this.timelineState.ticketId = id;
    // A Conversation's status has no direct TicketStatus equivalent; `live`
    // reads as `in-progress` for the timeline's running-attempt marker,
    // anything else as `done` (nothing left running).
    const status =
      card?.kind === "ticket"
        ? card.status
        : card?.kind === "conversation"
          ? card.status === "live"
            ? "in-progress"
            : "done"
          : "ready";
    this.timelineState.view = projectTimeline(response, status);
  }

  /**
   * Open the log pane for a newly selected ticket: the default attempt (the
   * running one, else the latest), unclicked so the pane follows the live
   * attempt as new attempts start. A ticket with no attempts holds an empty
   * pane.
   */
  private openLogPane(ticketId: string): void {
    const timeline =
      this.timelineState.ticketId === ticketId ? this.timelineState.view : null;
    const attempt = timeline ? selectLogAttempt(timeline, null) : null;
    void this.logs.open(ticketId, attempt, false);
  }

  /**
   * Fetch the selected ticket's body once, on first selection. The cache
   * write is keyed by ticket id so a slow answer cannot clobber a newer
   * selection's body; the repaint after it lands fires only while the body
   * load is still the current one and the ticket is still selected.
   */
  private ensureTicketBody(ticketId: string): void {
    if (this.ticketBodies.has(ticketId) || this.ticketBodyFetches.has(ticketId)) return;
    this.ticketBodyFetches.add(ticketId);
    const token = this.guard.begin(BODY_KEY);
    this.getTicket(ticketId)
      .then((ticket) => {
        this.ticketBodies.set(ticketId, ticket?.body ?? null);
        this.ticketBodyErrors.delete(ticketId);
      })
      .catch((err) => {
        this.ticketBodyErrors.set(
          ticketId,
          `ticket body fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.ticketBodyFetches.delete(ticketId);
        if (
          this.guard.isCurrent(BODY_KEY, token) &&
          this.selectedTicketId() === ticketId
        ) {
          this.onChange();
        }
      });
  }

  private refreshGrades(): void {
    this.getGrades()
      .then((next) => {
        if (JSON.stringify(next) === JSON.stringify(this.grades)) return;
        this.grades = next;
        this.onChange();
      })
      .catch(() => {
        // A failed grades fetch leaves the last good summaries in place;
        // the next snapshot's cadence retries.
      });
  }
}
