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
  projectPool,
  type PoolSnapshot,
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

function model(): AppModel {
  const view = state.snapshot ? projectPool(state.snapshot) : null;
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
    detail: state.snapshot && state.selectedId
      ? projectDetail(state.snapshot, state.selectedId)
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
      render();
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
  client.stream({
    onSnapshot: setSnapshot,
    onError: (message) => {
      state.error = message;
      render();
    },
  });
}

void boot();
