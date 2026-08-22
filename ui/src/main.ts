/**
 * Console: the pool rendered as node cards on a canvas. One Bun server per
 * pool serves the built SPA, a JSON API, and an SSE stream pushing a full
 * snapshot on every change. The UI renders from those snapshots only; ticket
 * cards and their blocked-by edges replace the old LangGraph thread UI.
 */

import "./styles.css";
import { PoolClient } from "./client";
import {
  earlierLogOffset,
  initialLogWindow,
  logTailOffset,
  phaseLabel,
  projectDetail,
  projectLogPane,
  projectPool,
  projectTimeline,
  selectLogAttempt,
  type PoolSnapshot,
  type TimelineView,
  type TicketEventsResponse,
} from "./project";
import { captureLogAnchor, renderApp, type AppModel } from "./view";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app not found");
const root: HTMLElement = appRoot;

const client = new PoolClient();

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
  spec: "",
};

// The selected ticket's raw log pane: module scope so a full-DOM rebuild never
// drops the fetched content, the selected attempt, or the pin, and a slow
// fetch answering after a newer selection never clobbers the newer ticket's
// pane. `clicked` records whether the attempt was picked by hand: a clicked
// attempt stays when a new attempt starts, an unclicked pane follows the
// running one. `firstOffset`..`offset` bookend the held byte window.
const logState = {
  ticketId: null as string | null,
  attempt: null as number | null,
  clicked: false,
  content: "",
  firstOffset: 0,
  offset: 0,
  totalSize: 0,
  error: null as string | null,
  tailInFlight: false,
  earlierInFlight: false,
};

// PROTOTYPE — throwaway: the selected ticket's raw markdown body for the
// ticket-detail view variants (issue #11). Module scope like the timeline, so
// a full-DOM rebuild never drops it; a null value means the server reported
// the ticket missing.
const ticketBodies = new Map<string, string | null>();

function resetLogPane(): void {
  logState.ticketId = null;
  logState.attempt = null;
  logState.clicked = false;
  logState.content = "";
  logState.firstOffset = 0;
  logState.offset = 0;
  logState.totalSize = 0;
  logState.error = null;
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
  timelineState.spec = response.spec;
  timelineState.view = projectTimeline(
    response,
    card?.kind === "ticket" ? card.status : "ready",
  );
}

/**
 * Open an attempt's raw log tail-first: probe the size (an offset past EOF
 * serves empty content plus the total), fetch the last window, then tail
 * whatever grew in the meantime. A slow answer only lands when it is still
 * the selected attempt.
 */
async function openLog(
  ticketId: string,
  attempt: number,
  clicked: boolean,
): Promise<void> {
  logState.ticketId = ticketId;
  logState.attempt = attempt;
  logState.clicked = clicked;
  logState.content = "";
  logState.firstOffset = 0;
  logState.offset = 0;
  logState.totalSize = 0;
  logState.error = null;
  render();
  try {
    const probe = await client.getLog(ticketId, attempt, Number.MAX_SAFE_INTEGER);
    if (logState.ticketId !== ticketId || logState.attempt !== attempt) return;
    const chunk = await client.getLog(
      ticketId,
      attempt,
      initialLogWindow(probe.totalSize),
    );
    if (logState.ticketId !== ticketId || logState.attempt !== attempt) return;
    logState.content = chunk.content;
    logState.firstOffset = chunk.offset;
    logState.offset = chunk.nextOffset;
    logState.totalSize = chunk.totalSize;
    render();
    // The attempt may have grown while the open fetched.
    void tailLog(ticketId, attempt);
  } catch {
    if (logState.ticketId === ticketId && logState.attempt === attempt) {
      logState.error = `log fetch failed: ${ticketId}:${attempt}`;
      render();
    }
  }
}

/**
 * Append whatever bytes the selected attempt's log has grown since the last
 * read: the live tail, driven by the snapshot cadence. Fetches only bytes
 * past the last offset read; a no-op once caught up.
 */
async function tailLog(ticketId: string, attempt: number): Promise<void> {
  if (logState.tailInFlight) return;
  if (logState.ticketId !== ticketId || logState.attempt !== attempt) return;
  logState.tailInFlight = true;
  try {
    while (logTailOffset(logState.offset, logState.totalSize) !== null) {
      const from = logState.offset;
      const chunk = await client.getLog(ticketId, attempt, from);
      if (logState.ticketId !== ticketId || logState.attempt !== attempt) {
        return;
      }
      logState.content += chunk.content;
      logState.offset = chunk.nextOffset;
      logState.totalSize = chunk.totalSize;
      render();
      if (chunk.nextOffset <= from) break;
    }
  } catch {
    if (logState.ticketId === ticketId && logState.attempt === attempt) {
      logState.error = `log fetch failed: ${ticketId}:${attempt}`;
      render();
    }
  } finally {
    logState.tailInFlight = false;
  }
}

/**
 * Prepend the window before the oldest byte held ("load earlier"). The fetch
 * is bounded by `firstOffset`, so the range cannot overlap the held content.
 * The anchor captured before the mutation keeps the opened view put across
 * the rebuild.
 */
async function prependLog(ticketId: string, attempt: number): Promise<void> {
  if (logState.earlierInFlight) return;
  if (logState.ticketId !== ticketId || logState.attempt !== attempt) return;
  const from = earlierLogOffset(logState.firstOffset);
  if (from === null) return;
  logState.earlierInFlight = true;
  try {
    const chunk = await client.getLog(ticketId, attempt, from, logState.firstOffset);
    if (logState.ticketId !== ticketId || logState.attempt !== attempt) return;
    captureLogAnchor();
    logState.content = chunk.content + logState.content;
    logState.firstOffset = chunk.offset;
    render();
  } catch {
    if (logState.ticketId === ticketId && logState.attempt === attempt) {
      logState.error = `log fetch failed: ${ticketId}:${attempt}`;
      render();
    }
  } finally {
    logState.earlierInFlight = false;
  }
}

/**
 * Load the log pane for the selected ticket's default attempt: the running
 * attempt, else the latest. Unclicked, so the pane follows the live attempt
 * as new attempts start.
 */
function loadLogPane(): void {
  const ticketId = state.snapshot
    ? selectedTicket(state.snapshot, state.selectedId)
    : null;
  if (!ticketId) return;
  const view = timelineState.ticketId === ticketId ? timelineState.view : null;
  const attempt = view ? selectLogAttempt(view, null) : null;
  if (attempt !== null) {
    void openLog(ticketId, attempt, false);
  } else {
    logState.ticketId = ticketId;
    logState.attempt = null;
    logState.clicked = false;
    logState.content = "";
    logState.firstOffset = 0;
    logState.offset = 0;
    logState.totalSize = 0;
    logState.error = null;
    render();
  }
}

/**
 * The snapshot-cadence liveness step for the open pane. Attempt-stay: a
 * clicked attempt is never switched away from; an unclicked pane follows the
 * running attempt as new attempts start. The selected attempt tails.
 */
function followLog(ticketId: string): void {
  const view = timelineState.view;
  if (!view) return;
  if (logState.attempt === null) {
    if (view.attempts.length > 0) loadLogPane();
    return;
  }
  const desired = selectLogAttempt(
    view,
    logState.clicked ? logState.attempt : null,
  );
  if (desired === null) return;
  if (desired !== logState.attempt) {
    void openLog(ticketId, desired, false);
    return;
  }
  void tailLog(ticketId, desired);
}

async function loadTimeline(): Promise<void> {
  const ticketId = state.snapshot
    ? selectedTicket(state.snapshot, state.selectedId)
    : null;
  if (!ticketId) {
    timelineState.ticketId = null;
    timelineState.view = null;
    timelineState.spec = "";
    resetLogPane();
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
      if (logState.ticketId !== ticketId) {
        loadLogPane();
      } else {
        followLog(ticketId);
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
    detailTicketId !== null && logState.ticketId === detailTicketId;
  // PROTOTYPE — throwaway: the selected ticket's cached raw body for the
  // ticket-detail view variants (issue #11); null when the selection is not a
  // ticket, not yet fetched, or known missing.
  const ticketBody = detailTicketId
    ? (ticketBodies.get(detailTicketId) ?? null)
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
    timeline: isCurrent ? timelineState.view : null,
    logPane: detailTicketId
      ? projectLogPane(
          isCurrent ? timelineState.view : null,
          logIsCurrent ? logState.attempt : null,
          isCurrent ? timelineState.spec : "",
          logIsCurrent
            ? {
                content: logState.content,
                firstOffset: logState.firstOffset,
                offset: logState.offset,
                totalSize: logState.totalSize,
              }
            : null,
          logIsCurrent ? logState.error : null,
        )
      : null,
    ticketBody,
  };
}

function render(): void {
  renderApp(root, model(), {
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
      void loadTimeline();
      // PROTOTYPE — throwaway: fetch the selected ticket's raw body for the
      // ticket-detail view variants (issue #11). Cached per ticket, so only a
      // first visit fetches; a slow fetch answering after a newer selection
      // re-renders only when the selection is still this ticket (the same
      // guard loadTimeline uses).
      const bodyTicketId = state.snapshot
        ? selectedTicket(state.snapshot, state.selectedId)
        : null;
      if (bodyTicketId && !ticketBodies.has(bodyTicketId)) {
        void client
          .getTicket(bodyTicketId)
          .then((ticket) => {
            ticketBodies.set(bodyTicketId, ticket?.body ?? null);
            if (
              state.snapshot &&
              selectedTicket(state.snapshot, state.selectedId) === bodyTicketId
            ) {
              render();
            }
          })
          .catch(() => {
            ticketBodies.set(bodyTicketId, null);
            if (
              state.snapshot &&
              selectedTicket(state.snapshot, state.selectedId) === bodyTicketId
            ) {
              render();
            }
          });
      }
      render();
    },
    onSelectAttempt: (ticketId, attempt) => {
      if (logState.ticketId === ticketId && logState.attempt === attempt) return;
      void openLog(ticketId, attempt, true);
    },
    onLoadEarlier: (ticketId, attempt) => {
      void prependLog(ticketId, attempt);
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
  // PROTOTYPE — throwaway: the variant switcher cycles the ?variant= URL param
  // and fires this window event; re-render on the same path as a snapshot
  // render.
  window.addEventListener("proto-variant-change", () => {
    render();
  });
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
