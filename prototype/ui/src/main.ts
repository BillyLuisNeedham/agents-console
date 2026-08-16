/**
 * Console — walking skeleton. A left rail lists threads (Console-created by
 * default, show-all toggle); selecting one renders its channels as a plain
 * list, with the log channel in a collapsible bottom drawer.
 */

import "./styles.css";
import { getThread, listThreads, makeClient } from "./client";
import type { Raw } from "./project";
import { projectChannels, projectLog, projectThreadSummary, visibleThreads } from "./project";
import { renderApp, type AppModel } from "./view";
import type { Thread } from "@langchain/langgraph-sdk";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app not found");
const root: HTMLElement = appRoot;

const client = makeClient();

const state = {
  threads: [] as Thread<Raw>[],
  showAll: false,
  selectedId: null as string | null,
  selected: null as Thread<Raw> | null,
  logOpen: false,
  error: null as string | null,
};

function model(): AppModel {
  const visible = visibleThreads(state.threads, state.showAll);
  const summaries = visible.map(projectThreadSummary);
  const selected =
    state.selected && visible.some((t) => t.thread_id === state.selected?.thread_id)
      ? state.selected
      : null;
  return {
    threads: summaries,
    showAll: state.showAll,
    selectedId: selected?.thread_id ?? null,
    channels: projectChannels(selected?.values ?? null),
    log: projectLog(selected?.values ?? null),
    logOpen: state.logOpen,
    error: state.error,
  };
}

function render(): void {
  renderApp(root, model(), {
    onSelectThread: (threadId) => void selectThread(threadId),
    onToggleShowAll: (showAll) => {
      state.showAll = showAll;
      render();
    },
    onToggleLog: () => {
      state.logOpen = !state.logOpen;
      render();
    },
    onRefresh: () => void load(),
  });
}

async function selectThread(threadId: string): Promise<void> {
  state.selectedId = threadId;
  try {
    state.selected = await getThread(client, threadId);
    state.error = null;
  } catch (err) {
    state.error = `failed to load thread: ${err instanceof Error ? err.message : String(err)}`;
  }
  render();
}

async function load(): Promise<void> {
  try {
    state.threads = await listThreads(client);
    state.error = null;
    const visible = visibleThreads(state.threads, state.showAll);
    const stillThere = visible.some((t) => t.thread_id === state.selectedId);
    if (!stillThere) {
      const first = visible[0] ?? null;
      state.selectedId = first?.thread_id ?? null;
      state.selected = first ?? null;
    } else if (state.selectedId) {
      state.selected = await getThread(client, state.selectedId);
    }
  } catch (err) {
    state.error = `dev server unreachable at http://localhost:2024 — is \`langgraphjs dev\` running? (${
      err instanceof Error ? err.message : String(err)
    })`;
  }
  render();
}

void load();
