/**
 * Console: the pool rendered as node cards on a canvas. One Bun server per
 * pool serves the built SPA, a JSON API, and an SSE stream pushing a full
 * snapshot on every change. The UI renders from those snapshots only; ticket
 * cards and their blocked-by edges render the thread.
 */

import "./styles.css";
import { PoolClient, refetchStateOnVisible } from "./client";
import { LogPane } from "./log-pane";
import { Vitals } from "./vitals";
import {
  joinStreamFiles,
  phaseLabel,
  poolAssignmentDefaults,
  POOL_TAB_COLORS,
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
  type GradeView,
  type PoolSnapshot,
  type TabOverride,
  type TicketEventsResponse,
  type TimelineView,
} from "./project";
import { ConsoleView, type AppModel } from "./view";
import { TerminalSurface } from "./terminal";

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

const state = {
  snapshot: null as PoolSnapshot | null,
  selectedId: null as string | null,
  logOpen: false,
  inspectorOpen: false,
  error: null as string | null,
  connected: false,
};

// The selected ticket's timeline: module scope so a full-DOM rebuild from a
// live snapshot never drops it, and a slow fetch answering after a newer
// selection never clobbers the newer ticket's rows.
const timelineState = {
  ticketId: null as string | null,
  view: null as TimelineView | null,
};

// The selected ticket's raw log pane: one module owns the byte-window state
// machine (open, live tail, load earlier), the attempt-stay and
// stale-selection guards, and the scroll pin. The bootstrap drives it and
// renders when it changes; it never does offset arithmetic itself.
const logPane = new LogPane({
  fetch: (ticketId, attempt, offset, end, stream) =>
    client.getLog(ticketId, attempt, offset, end, stream),
  onChange: () => render(),
});

// The per-session view state: selection, dragged card positions, panel
// width, drawer height, and note drafts, owned by the canvas, detail, and
// drawers modules and composed here once for the session. The tray's answer
// seam resolves on accept and rejects on failure so the tray marks its own
// row; the Detail keeps its fire-and-forget onAnswer below with the global
// banner.
const consoleView = new ConsoleView({
  onAnswer: (ticketId, action, note) =>
    client.answer(ticketId, action, note).then(setSnapshot),
  onChange: () => render(),
  onFocusTerminal: (ticketId) => terminal.focus(ticketId),
  onStart: (request) => client.startConversation(request),
  onEnd: (conversationId, closing) =>
    client.endConversation(conversationId, closing).then(setSnapshot),
});

// The latest grade per ticket, for the card summaries. Module scope so a
// full-DOM rebuild never drops it; refetched on the snapshot cadence like the
// selected ticket's events. Absent until the first fetch lands: the cards
// render no grade UI until then, which is the no-grade state anyway.
let grades: Record<string, GradeView> = {};

// The Vitals store: polls the activity endpoint per live-attempt ticket and
// holds the payloads and sparkline samples the cards' footers project from.
// Module scope so a full-DOM rebuild never drops them; the projection renders
// nothing for a card until its first payload lands, so there is no empty
// flash. Its onChange fires on poll responses and on the 2s wall-clock tick
// that keeps staleness copy honest while the snapshot stream is silent.
const vitals = new Vitals({
  fetch: (ticketId) => client.getActivity(ticketId),
  onChange: () => render(),
});

// The Terminal surface store: polls the peek endpoint per terminal-backed
// running attempt and holds the peek text and focus confirmations the cards'
// surfaces project from. Module scope so a full-DOM rebuild never drops the
// entries; the projection renders a pending "waiting for output" shell for a
// pane before its first payload lands, so there is no empty flash.
const terminal = new TerminalSurface({
  peek: (ticketId) => client.peekTerminal(ticketId),
  focus: (ticketId) => client.focusTerminal(ticketId),
  onChange: () => render(),
});

// On a dev HMR re-execution this module runs again and builds fresh stores;
// dispose the old ones or their poll timers double up.
import.meta.hot?.dispose(() => {
  vitals.dispose();
  terminal.dispose();
});

function refreshGrades(): void {
  client
    .getGrades()
    .then((next) => {
      if (JSON.stringify(next) === JSON.stringify(grades)) return;
      grades = next;
      render();
    })
    .catch(() => {
      // A failed grades fetch leaves the last good summaries in place; the
      // next snapshot's cadence retries.
    });
}

// Ticket bodies for the Spec tab: fetched once per ticket on first selection
// and held for the session; a 404 caches null so a known-missing body is
// never refetched. Module scope so a full-DOM rebuild never drops them.
const ticketBodies = new Map<string, string | null>();
const ticketBodyFetches = new Set<string>();
// A failed body fetch, keyed by ticket id: surfaced on the Spec tab, and the
// next selection retries because nothing was cached.
const ticketBodyErrors = new Map<string, string>();

// The manually chosen Detail tab. One value carrying its ticket id: the
// projection ignores it for any other ticket, so changing the selection
// reasserts the phase default. Memory only; no URL state, no persistence.
let tabOverride: TabOverride | null = null;

/**
 * Fetch the selected ticket's body once, on first selection. The cache write
 * is keyed by ticket id so a slow answer cannot clobber a newer selection's
 * body; the render after it lands fires only while the ticket is still
 * selected (the same guard the timeline and log fetches use).
 */
function ensureTicketBody(ticketId: string): void {
  if (ticketBodies.has(ticketId) || ticketBodyFetches.has(ticketId)) return;
  ticketBodyFetches.add(ticketId);
  client
    .getTicket(ticketId)
    .then((ticket) => {
      ticketBodies.set(ticketId, ticket?.body ?? null);
      ticketBodyErrors.delete(ticketId);
    })
    .catch((err) => {
      ticketBodyErrors.set(
        ticketId,
        `ticket body fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      ticketBodyFetches.delete(ticketId);
      if (state.snapshot && selectedTicket(state.snapshot, state.selectedId) === ticketId) {
        render();
      }
    });
}

function selectedTicket(snapshot: PoolSnapshot, selectedId: string | null): string | null {
  if (!selectedId) return null;
  const card = projectPool(snapshot, grades).cards.find((c) => c.id === selectedId);
  return card?.kind === "ticket" ? card.ticketId : null;
}

/**
 * The id the events endpoint is fetched for: a ticket's or a Conversation's,
 * since /api/events?ticket=<id> accepts either (a Conversation's timeline
 * reuses the same path). Null when the selection is neither, or nothing is
 * selected.
 */
function selectedEventsId(snapshot: PoolSnapshot, selectedId: string | null): string | null {
  if (!selectedId) return null;
  const card = projectPool(snapshot, grades).cards.find((c) => c.id === selectedId);
  if (card?.kind === "ticket") return card.ticketId;
  if (card?.kind === "conversation") return card.conversationId;
  return null;
}

function applyTimeline(id: string, response: TicketEventsResponse): void {
  const card = state.snapshot
    ? projectPool(state.snapshot, grades).cards.find(
        (c) =>
          (c.kind === "ticket" && c.ticketId === id) ||
          (c.kind === "conversation" && c.conversationId === id),
      )
    : undefined;
  timelineState.ticketId = id;
  // A Conversation's status has no direct PoolStatus equivalent; `live` reads
  // as `in-progress` for the timeline's running-attempt marker, anything
  // else as `done` (nothing left running).
  const status =
    card?.kind === "ticket"
      ? card.status
      : card?.kind === "conversation"
        ? card.status === "live"
          ? "in-progress"
          : "done"
        : "ready";
  timelineState.view = projectTimeline(response, status);
}

/**
 * Open the log pane for a newly selected ticket: the default attempt (the
 * running one, else the latest), unclicked so the pane follows the live
 * attempt as new attempts start. A ticket with no attempts holds an empty
 * pane.
 */
function openLogPane(ticketId: string): void {
  const timeline =
    timelineState.ticketId === ticketId ? timelineState.view : null;
  const attempt = timeline ? selectLogAttempt(timeline, null) : null;
  void logPane.open(ticketId, attempt, false);
}

async function loadTimeline(): Promise<void> {
  const id = state.snapshot ? selectedEventsId(state.snapshot, state.selectedId) : null;
  if (!id) {
    timelineState.ticketId = null;
    timelineState.view = null;
    logPane.reset();
    render();
    return;
  }
  // The raw log pane tails a ticket attempt's log file; a Conversation's
  // timeline reuses the same events fetch, but not the log pane (its own
  // log-tailing story is not part of this surface yet).
  const isTicket = state.snapshot
    ? selectedTicket(state.snapshot, state.selectedId) === id
    : false;
  timelineState.ticketId = id;
  try {
    const response = await client.getEvents(id);
    // A newer selection may have landed while the fetch was out.
    if (timelineState.ticketId === id) {
      applyTimeline(id, response);
      if (!isTicket) {
        logPane.reset();
        render();
        return;
      }
      // The snapshot cadence doubles as the liveness signal: a newly selected
      // ticket opens its pane, and an already-open pane follows the tail.
      if (logPane.state.ticketId !== id) {
        openLogPane(id);
      } else {
        void logPane.follow(id, timelineState.view);
        render();
      }
    }
  } catch {
    if (timelineState.ticketId === id) {
      timelineState.view = null;
      render();
    }
  }
}

function model(): AppModel {
  const conversationEndings = consoleView.conversationEndState();
  const view = state.snapshot
    ? projectPool(
        state.snapshot,
        grades,
        vitals.state(),
        terminal.state(),
        Date.now(),
        conversationEndings,
      )
    : null;
  const detail =
    state.snapshot && state.selectedId
      ? projectDetail(
          state.snapshot,
          state.selectedId,
          grades,
          terminal.state(),
          Date.now(),
          conversationEndings,
        )
      : null;
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
    detailEventsId !== null && timelineState.ticketId === detailEventsId;
  const logIsCurrent =
    detailTicketId !== null && logPane.state.ticketId === detailTicketId;
  // The timeline joins the log pane's attempt listing (the /api/log response's
  // per-attempt Stream file resolution), so each attempt row knows its Stream
  // file. A pane for another ticket (or no pane yet, or a Conversation, which
  // has no log pane) contributes no listing.
  const timeline =
    isCurrent && timelineState.view
      ? joinStreamFiles(
          timelineState.view,
          logIsCurrent ? logPane.state.attempts : null,
        )
      : null;
  return {
    phase: view?.phase ?? null,
    phaseLabel: view ? phaseLabel(view.phase) : "connecting",
    cards: view?.cards ?? [],
    edges: view?.edges ?? [],
    log: view ? view.log : [],
    logOpen: state.logOpen,
    inspectorJson: state.snapshot
      ? JSON.stringify(state.snapshot.state, null, 2)
      : "- no state yet -",
    inspectorOpen: state.inspectorOpen,
    connected: state.connected,
    seq: state.snapshot?.seq ?? 0,
    error: state.error,
    detail,
    detailTabs:
      detail?.kind === "ticket" ? projectDetailTabs(detail, tabOverride) : null,
    detailBody:
      detailTicketId !== null && ticketBodies.has(detailTicketId)
        ? (ticketBodies.get(detailTicketId) ?? null)
        : undefined,
    detailBodyError:
      detailTicketId !== null
        ? (ticketBodyErrors.get(detailTicketId) ?? null)
        : null,
    timeline,
    logPane: detailTicketId
      ? projectLogPane(
          isCurrent ? timelineState.view : null,
          logIsCurrent ? logPane.state.attempt : null,
          logIsCurrent
            ? {
                stream: logPane.state.stream,
                content: logPane.state.content,
                firstOffset: logPane.state.firstOffset,
                offset: logPane.state.offset,
                totalSize: logPane.state.totalSize,
              }
            : null,
          logIsCurrent ? logPane.state.error : null,
        )
      : null,
    needsInput: state.snapshot ? projectNeedsInput(state.snapshot) : [],
    conversationsNeedsInput: state.snapshot
      ? projectConversationsNeedsInput(state.snapshot)
      : [],
    conversationsTray: state.snapshot
      ? projectConversationsTray(state.snapshot.state.conversations ?? [])
      : [],
    conversationDefaults: state.snapshot
      ? poolAssignmentDefaults(state.snapshot.state.config)
      : {},
  };
}

function render(): void {
  consoleView.render(root, model(), {
    onToggleLog: () => {
      state.logOpen = !state.logOpen;
      render();
    },
    onToggleInspector: () => {
      state.inspectorOpen = !state.inspectorOpen;
      render();
    },
    onSelectNode: (nodeId) => {
      state.selectedId = nodeId;
      if (state.snapshot) {
        const ticketId = selectedTicket(state.snapshot, nodeId);
        if (ticketId) ensureTicketBody(ticketId);
      }
      void loadTimeline();
      render();
    },
    onSelectTab: (ticketId, tab) => {
      tabOverride = { ticketId, tab };
      render();
    },
    onSelectAttempt: (ticketId, attempt) => {
      logPane.selectAttempt(ticketId, attempt);
    },
    onSelectStream: (ticketId, attempt) => {
      logPane.selectStream(ticketId, attempt);
    },
    onLoadEarlier: (ticketId, attempt) => {
      void logPane.loadEarlier(ticketId, attempt);
    },
    onAnswer: (ticketId, action, note) => {
      // One answer, one action: the response snapshot and the SSE stream both
      // carry the resumed pool.
      client
        .answer(ticketId, action, note)
        .then(setSnapshot)
        .catch((err) => {
          state.error = `answer failed: ${err instanceof Error ? err.message : String(err)}`;
          render();
        });
    },
  });
}

function setSnapshot(snapshot: PoolSnapshot): void {
  state.snapshot = snapshot;
  state.connected = true;
  state.error = null;
  vitals.update(snapshot);
  terminal.update(snapshot);
  const status = poolStatus(snapshot);
  document.title = `${status.word} — ${snapshot.poolName}`;
  setFavicon(status.color);
  // A new snapshot can move the selected ticket (spawned, exited, merged),
  // so the timeline refetches on that cadence; the events file is append-only
  // and small, so a refetch is cheap.
  if (state.snapshot && state.selectedId) {
    void loadTimeline();
  }
  refreshGrades();
  render();
}

async function boot(): Promise<void> {
  let snapshot: PoolSnapshot | null = null;
  try {
    snapshot = await client.getState();
  } catch (err) {
    state.error = `pool server unreachable: ${err instanceof Error ? err.message : String(err)}`;
    render();
    return;
  }
  if (snapshot) {
    setSnapshot(snapshot);
  } else {
    try {
      setSnapshot(await client.start());
    } catch (err) {
      state.error = `failed to start the pool: ${err instanceof Error ? err.message : String(err)}`;
      render();
      return;
    }
  }
  // A stream error marks the connection down at once, but the banner waits
  // out a grace delay: a snapshot inside the window (the server replays the
  // latest on reconnect) cancels it, and reconnect clears one already
  // showing. The timer arms only on the first error of an outage: a dead
  // connection re-fires onError on every EventSource retry, and re-arming
  // each time would push the banner past the grace window forever.
  const STREAM_GRACE_MS = 4000;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStreamError = "";
  const cancelGrace = () => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };
  client.stream({
    onSnapshot: (snapshot) => {
      cancelGrace();
      setSnapshot(snapshot);
    },
    onError: (message) => {
      state.connected = false;
      lastStreamError = message;
      if (graceTimer === null) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (!state.connected) {
            state.error = lastStreamError;
            render();
          }
        }, STREAM_GRACE_MS);
      }
      render();
    },
  });
  // Belt and braces over the stream's self-healing: a tab that returns to
  // visible (after the machine slept, or hours buried) refetches the latest
  // snapshot, so a stale page catches up even before the stream's silence
  // watchdog reopens it.
  refetchStateOnVisible(
    document,
    () => client.getState(),
    (snapshot) => setSnapshot(snapshot),
  );
}

void boot();
