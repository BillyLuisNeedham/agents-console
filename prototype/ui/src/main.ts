/**
 * Console — walking skeleton plus live streaming and run start. A left rail
 * holds a start-run form (topic, ticket pool, optional packet) and lists
 * threads (Console-created by default, show-all toggle); selecting one
 * renders its channels as a plain list, joins any in-flight run's stream,
 * and updates state, log and node statuses live as super-steps land.
 */

import "./styles.css";
import {
  createThread,
  findActiveRun,
  getAssistantId,
  getThread,
  joinRun,
  listThreads,
  makeClient,
  streamRun,
} from "./client";
import type { Raw } from "./project";
import {
  applyStreamPart,
  initRun,
  projectChannels,
  projectLog,
  projectNodes,
  projectStartRun,
  projectThreadSummary,
  syncRunValues,
  TICKET_POOLS,
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
  start: {
    topic: "",
    ticketDir: TICKET_POOLS[0] as string,
    packet: "",
    starting: false,
    error: null as string | null,
  },
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
    start: state.start,
  };
}

/**
 * Rebuild the DOM from the model. Form fields are controlled from state, so
 * a rebuild would drop focus and cursor position; both are restored here for
 * whichever start-form field was being edited.
 */
function render(): void {
  const active = document.activeElement;
  const field = active instanceof HTMLElement ? active.getAttribute("data-field") : null;
  const selection =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;
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
    onStartField: (field, value) => {
      state.start = { ...state.start, [field]: value, error: null };
      render();
    },
    onStartRun: () => void startRun(),
  });
  if (field) {
    const el = root.querySelector(`[data-field="${field}"]`);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      if (selection) el.setSelectionRange(selection.start, selection.end);
    } else if (el instanceof HTMLSelectElement) {
      el.focus();
    }
  }
}

function stopStream(): void {
  state.abort?.abort();
  state.abort = null;
}

/**
 * Start a run from the rail form: create a thread tagged with the topic,
 * invoke the graph on it (ticket pool via configurable.ticketDir, packet
 * only when given), and stream it live. The new thread becomes the
 * selection, so the run strip and channels track it as super-steps land.
 */
async function startRun(): Promise<void> {
  const request = projectStartRun(state.start);
  if (!request || state.start.starting) return;
  stopStream();
  state.start = { ...state.start, starting: true, error: null };
  render();
  const controller = new AbortController();
  state.abort = controller;
  let assistantId: string;
  let thread: Thread<Raw>;
  try {
    assistantId = await getAssistantId(client);
    thread = await createThread(client, state.start.topic.trim());
  } catch (err) {
    state.start = {
      ...state.start,
      starting: false,
      error: err instanceof Error ? err.message : String(err),
    };
    render();
    return;
  }
  if (controller.signal.aborted) {
    state.start = { ...state.start, starting: false };
    render();
    return;
  }
  state.threads = [thread, ...state.threads];
  state.selectedId = thread.thread_id;
  state.selected = thread;
  state.run = { ...initRun(), streaming: true };
  state.start = {
    topic: "",
    ticketDir: state.start.ticketDir,
    packet: "",
    starting: true,
    error: null,
  };
  render();
  try {
    await streamRun(
      client,
      thread.thread_id,
      assistantId,
      request.input,
      {
        onPart: (part) => {
          if (controller.signal.aborted || state.selectedId !== thread.thread_id) return;
          state.run = applyStreamPart(state.run, part);
          render();
        },
        onError: (message) => {
          state.run = { ...state.run, streaming: false, streamError: message };
          render();
        },
        onDone: () => {
          state.run = { ...state.run, streaming: false };
        },
      },
      controller.signal,
      request.config,
    );
  } catch (err) {
    if (!controller.signal.aborted) {
      state.run = {
        ...state.run,
        streaming: false,
        streamError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  state.start = { ...state.start, starting: false };
  await load();
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
