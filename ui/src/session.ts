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
  joinStreamFiles,
  phaseLabel,
  poolAssignmentDefaults,
  poolStatus,
  projectConversationsNeedsInput,
  projectConversationsTray,
  projectDetail,
  projectDetailTabs,
  projectLogPane,
  projectNeedsInput,
  projectPool,
  projectTimeline,
  selectLogAttempt,
  type ConversationEndView,
  type DetailTab,
  type GradeView,
  type InterruptAction,
  type PoolCardView,
  type PoolSnapshot,
  type PoolTabStatus,
  type PoolView,
  type TabOverride,
  type TerminalSurfaceView,
  type TicketBodyResponse,
  type TicketEventsResponse,
  type TimelineView,
  type VitalsState,
} from "./project";
import type { AppModel } from "./view";

/** The vitals store, as the session consumes it. */
export interface SessionVitals {
  update(snapshot: PoolSnapshot): void;
  state(): Record<string, VitalsState>;
}

/** The terminal surface store, as the session consumes it. */
export interface SessionTerminal {
  update(snapshot: PoolSnapshot): void;
  state(): Record<string, TerminalSurfaceView>;
}

export interface ConsoleSessionOptions {
  getState: () => Promise<PoolSnapshot | null>;
  getEvents: (id: string) => Promise<TicketEventsResponse>;
  getTicket: (id: string) => Promise<TicketBodyResponse | null>;
  getGrades: () => Promise<Record<string, GradeView>>;
  /** The log pane's byte-range fetch, handed to the LogPane the session owns. */
  getLog: LogFetch;
  /** Answer an interrupt; resolves with the resumed pool's snapshot. */
  answer: (
    ticketId: string,
    action: InterruptAction,
    note?: string,
  ) => Promise<PoolSnapshot>;
  /** Open the snapshot stream; returns a function that closes it. */
  stream: (handlers: {
    onSnapshot: (snapshot: PoolSnapshot) => void;
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
  private readonly streamSeam: ConsoleSessionOptions["stream"];
  private readonly vitals: SessionVitals;
  private readonly terminal: SessionTerminal;
  private readonly derivePool: typeof projectPool;
  private readonly onChange: () => void;

  private snapshot: PoolSnapshot | null = null;
  private selectedId: string | null = null;
  private logOpen = false;
  private inspectorOpen = false;
  private error: string | null = null;
  private connected = false;

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
  private grades: Record<string, GradeView> = {};

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
  poolName: string | null = null;

  constructor(options: ConsoleSessionOptions) {
    this.getState = options.getState;
    this.getEvents = options.getEvents;
    this.getTicket = options.getTicket;
    this.getGrades = options.getGrades;
    this.answerSeam = options.answer;
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
  setSnapshot(snapshot: PoolSnapshot): void {
    this.snapshot = snapshot;
    this.connected = true;
    this.error = null;
    this.vitals.update(snapshot);
    this.terminal.update(snapshot);
    this.tabStatus = poolStatus(snapshot);
    this.poolName = snapshot.poolName;
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
        if (graceTimer === null) {
          graceTimer = setTimeout(() => {
            graceTimer = null;
            if (!this.connected) {
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
    action: InterruptAction,
    note?: string,
  ): Promise<void> {
    const snapshot = await this.answerSeam(ticketId, action, note);
    this.setSnapshot(snapshot);
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
      needsInput: this.snapshot ? projectNeedsInput(this.snapshot) : [],
      conversationsNeedsInput: this.snapshot
        ? projectConversationsNeedsInput(this.snapshot)
        : [],
      conversationsTray: this.snapshot
        ? projectConversationsTray(this.snapshot.state.conversations ?? [])
        : [],
      conversationDefaults: this.snapshot
        ? poolAssignmentDefaults(this.snapshot.state.config)
        : {},
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
    // A Conversation's status has no direct PoolStatus equivalent; `live`
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
