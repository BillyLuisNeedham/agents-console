/**
 * Console: the pool rendered as node cards on a canvas. One Bun server per
 * pool serves the built SPA, a JSON API, and an SSE stream pushing a full
 * snapshot on every change. The UI renders from those snapshots only; ticket
 * cards and their blocked-by edges render the thread.
 */

import "./styles.css";
import { PoolClient } from "./client";
import { LogPane } from "./log-pane";
import {
  phaseLabel,
  POOL_TAB_COLORS,
  poolStatus,
  projectDetail,
  projectDetailTabs,
  projectLogPane,
  projectNeedsInput,
  projectPool,
  projectTimeline,
  selectLogAttempt,
  type PoolSnapshot,
  type TabOverride,
  type TicketEventsResponse,
  type TimelineView,
} from "./project";
import { ConsoleView, type AppModel } from "./view";

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
  fetch: (ticketId, attempt, offset, end) =>
    client.getLog(ticketId, attempt, offset, end),
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
});

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
  const card = projectPool(snapshot).cards.find((c) => c.id === selectedId);
  return card?.kind === "ticket" ? card.ticketId : null;
}

function applyTimeline(ticketId: string, response: TicketEventsResponse): void {
  const card = state.snapshot
    ? projectPool(state.snapshot).cards.find(
        (c) => c.kind === "ticket" && c.ticketId === ticketId,
      )
    : undefined;
  timelineState.ticketId = ticketId;
  timelineState.view = projectTimeline(
    response,
    card?.kind === "ticket" ? card.status : "ready",
  );
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
  const ticketId = state.snapshot
    ? selectedTicket(state.snapshot, state.selectedId)
    : null;
  if (!ticketId) {
    timelineState.ticketId = null;
    timelineState.view = null;
    logPane.reset();
    render();
    return;
  }
  timelineState.ticketId = ticketId;
  try {
    const response = await client.getEvents(ticketId);
    // A newer selection may have landed while the fetch was out.
    if (timelineState.ticketId === ticketId) {
      applyTimeline(ticketId, response);
      // The snapshot cadence doubles as the liveness signal: a newly selected
      // ticket opens its pane, and an already-open pane follows the tail.
      if (logPane.state.ticketId !== ticketId) {
        openLogPane(ticketId);
      } else {
        void logPane.follow(ticketId, timelineState.view);
        render();
      }
    }
  } catch {
    if (timelineState.ticketId === ticketId) {
      timelineState.view = null;
      render();
    }
  }
}

function model(): AppModel {
  const view = state.snapshot ? projectPool(state.snapshot) : null;
  const detail =
    state.snapshot && state.selectedId
      ? projectDetail(state.snapshot, state.selectedId)
      : null;
  const detailTicketId = detail?.kind === "ticket" ? detail.ticketId : null;
  const isCurrent =
    detailTicketId !== null && timelineState.ticketId === detailTicketId;
  const logIsCurrent =
    detailTicketId !== null && logPane.state.ticketId === detailTicketId;
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
    timeline: isCurrent ? timelineState.view : null,
    logPane: detailTicketId
      ? projectLogPane(
          isCurrent ? timelineState.view : null,
          logIsCurrent ? logPane.state.attempt : null,
          logIsCurrent
            ? {
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
  const status = poolStatus(snapshot);
  document.title = `${status.word} — ${snapshot.poolName}`;
  setFavicon(status.color);
  // A new snapshot can move the selected ticket (spawned, exited, merged),
  // so the timeline refetches on that cadence; the events file is append-only
  // and small, so a refetch is cheap.
  if (state.snapshot && state.selectedId) {
    void loadTimeline();
  }
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
}

void boot();
