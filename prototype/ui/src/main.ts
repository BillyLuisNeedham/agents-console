/**
 * Console — walking skeleton plus live streaming. A left rail lists threads
 * (Console-created by default, show-all toggle); selecting one renders its
 * channels as a plain list, joins any in-flight run's stream, and updates
 * state, log and node statuses live as super-steps land.
 */

import "./styles.css";
import { findActiveRun, getThread, joinRun, listThreads, makeClient } from "./client";
import type { Raw } from "./project";
import {
  applyStreamPart,
  initRun,
  projectChannels,
  projectLog,
  projectNodes,
  projectThreadSummary,
  syncRunValues,
  visibleThreads,
  type RunProjection,
} from "./project";
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
  run: initRun() as RunProjection,
  abort: null as AbortController | null,
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
    channels: projectChannels(selected ? state.run.values : null),
    log: projectLog(selected ? state.run.values : null),
    logOpen: state.logOpen,
    nodes: selected ? projectNodes(state.run) : [],
    streaming: state.run.streaming,
    streamError: state.run.streamError,
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

function stopStream(): void {
  state.abort?.abort();
  state.abort = null;
}

/** Join the selected thread's in-flight run, if it has one. */
async function watch(threadId: string): Promise<void> {
  stopStream();
  const controller = new AbortController();
  state.abort = controller;
  try {
    const runId = await findActiveRun(client, threadId);
    if (!runId || controller.signal.aborted || state.selectedId !== threadId) return;
    state.run = { ...state.run, streaming: true, streamError: null };
    render();
    await joinRun(
      client,
      threadId,
      runId,
      {
        onPart: (part) => {
          state.run = applyStreamPart(state.run, part);
          render();
        },
        onError: (message) => {
          state.run = { ...state.run, streaming: false, streamError: message };
          render();
        },
        onDone: () => {
          state.run = { ...state.run, streaming: false };
          void load();
        },
      },
      controller.signal,
    );
  } catch (err) {
    if (controller.signal.aborted || state.selectedId !== threadId) return;
    state.run = {
      ...state.run,
      streaming: false,
      streamError: err instanceof Error ? err.message : String(err),
    };
    render();
  }
}

async function selectThread(threadId: string): Promise<void> {
  stopStream();
  state.selectedId = threadId;
  try {
    const thread = await getThread(client, threadId);
    if (state.selectedId !== threadId) return;
    state.selected = thread;
    state.run = initRun(thread.values);
    state.error = null;
  } catch (err) {
    state.error = `failed to load thread: ${err instanceof Error ? err.message : String(err)}`;
  }
  render();
  void watch(threadId);
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
      state.run = initRun(first?.values);
      if (first) void watch(first.thread_id);
      else stopStream();
    } else if (state.selectedId) {
      state.selected = await getThread(client, state.selectedId);
      state.run = syncRunValues(state.run, state.selected.values);
    }
  } catch (err) {
    state.error = `dev server unreachable at http://localhost:2024 — is \`langgraphjs dev\` running? (${
      err instanceof Error ? err.message : String(err)
    })`;
  }
  render();
}

void load();
