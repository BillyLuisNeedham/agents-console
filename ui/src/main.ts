/**
 * Console: the pool rendered as node cards on a canvas. One Bun server per
 * pool serves the built SPA, a JSON API, and an SSE stream pushing a full
 * snapshot on every change. The UI renders from those snapshots only; ticket
 * cards and their blocked-by edges replace the old LangGraph thread UI.
 */

import "./styles.css";
import { PoolClient } from "./client";
import {
  phaseLabel,
  projectDetail,
  projectLogPane,
  projectPool,
  projectTimeline,
  selectLogAttempt,
  type LogPaneView,
  type PoolSnapshot,
  type TimelineView,
  type TicketEventsResponse,
} from "./project";
import { renderApp, type AppModel } from "./view";

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
// drops the fetched content or the selected attempt, and a slow fetch
// answering after a newer selection never clobbers the newer ticket's pane.
const logState = {
  ticketId: null as string | null,
  attempt: null as number | null,
  content: "",
  offset: 0,
  totalSize: 0,
  error: null as string | null,
};

function resetLogPane(): void {
  logState.ticketId = null;
  logState.attempt = null;
  logState.content = "";
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
 * Fetch the raw log for an attempt, paging through byte ranges until the whole
 * file is in hand. The pane is static in this ticket: it fetches once on
 * selection, and the offset contract it uses is what ticket 19 makes live.
 */
async function fetchLog(ticketId: string, attempt: number): Promise<void> {
  const key = `${ticketId}:${attempt}`;
  logState.ticketId = ticketId;
  logState.attempt = attempt;
  logState.content = "";
  logState.offset = 0;
  logState.totalSize = 0;
  logState.error = null;
  render();
  try {
    let offset = 0;
    for (;;) {
      const chunk = await client.getLog(ticketId, attempt, offset);
      // A newer selection may have landed while the fetch was out.
      if (logState.ticketId !== ticketId || logState.attempt !== attempt) {
        return;
      }
      logState.content += chunk.content;
      logState.offset = chunk.nextOffset;
      logState.totalSize = chunk.totalSize;
      if (logState.ticketId === ticketId && logState.attempt === attempt) {
        render();
      }
      if (chunk.nextOffset >= chunk.totalSize) break;
      offset = chunk.nextOffset;
    }
  } catch {
    if (logState.ticketId === ticketId && logState.attempt === attempt) {
      logState.error = `log fetch failed: ${key}`;
      render();
    }
  }
}

/**
 * Load the log pane for the selected ticket's default attempt: the running
 * attempt, else the latest. The pane is static (fetches on selection), so a
 * slow answer only lands when it is still the selected ticket.
 */
function loadLogPane(): void {
  const ticketId = state.snapshot
    ? selectedTicket(state.snapshot, state.selectedId)
    : null;
  if (!ticketId) return;
  const view = timelineState.ticketId === ticketId ? timelineState.view : null;
  const attempt = view ? selectLogAttempt(view, null) : null;
  if (attempt !== null) {
    void fetchLog(ticketId, attempt);
  } else {
    logState.ticketId = ticketId;
    logState.attempt = null;
    logState.content = "";
    logState.offset = 0;
    logState.totalSize = 0;
    logState.error = null;
    render();
  }
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
      // The log pane is static: it fetches on selection, so a new snapshot
      // for the same ticket keeps the fetched content. Only a newly selected
      // ticket starts a log fetch.
      if (logState.ticketId !== ticketId) {
        loadLogPane();
      } else {
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
                offset: logState.offset,
                totalSize: logState.totalSize,
              }
            : null,
          logIsCurrent ? logState.error : null,
        )
      : null,
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
      render();
    },
    onSelectAttempt: (ticketId, attempt) => {
      if (logState.ticketId === ticketId && logState.attempt === attempt) return;
      void fetchLog(ticketId, attempt);
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
