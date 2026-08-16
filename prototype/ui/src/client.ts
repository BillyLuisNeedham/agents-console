/**
 * Thin wrapper over the LangGraph SDK client. The Console is a client of the
 * dev server's HTTP API only; this module is the single place that talks to it.
 */

import { Client, type Thread } from "@langchain/langgraph-sdk";
import type { Raw, StreamPart } from "./project";

export const DEV_SERVER_URL = "http://localhost:2024";

export function makeClient(): Client<Raw> {
  return new Client<Raw>({ apiUrl: DEV_SERVER_URL, apiKey: null });
}

export async function listThreads(client: Client<Raw>): Promise<Thread<Raw>[]> {
  return client.threads.search<Raw>({
    limit: 50,
    sortBy: "updated_at",
    sortOrder: "desc",
  });
}

export async function getThread(client: Client<Raw>, threadId: string): Promise<Thread<Raw>> {
  return client.threads.get<Raw>(threadId);
}

/** Create a Console-tagged thread. The label is the run's topic. */
export async function createThread(client: Client<Raw>, label: string): Promise<Thread<Raw>> {
  return client.threads.create({ metadata: { label, origin: "ui" } });
}

// ---------------------------------------------------------------------------
// Run streaming: values + updates only, ever
// ---------------------------------------------------------------------------

const STREAM_MODE = ["values", "updates"] as const;

export interface StreamHandlers {
  onPart: (part: StreamPart) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

async function consume(
  stream: AsyncGenerator<{ event: string; data: unknown }>,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const part of stream) {
      if (signal.aborted) return;
      handlers.onPart({ event: String(part.event), data: part.data });
    }
    if (!signal.aborted) handlers.onDone();
  } catch (err) {
    if (signal.aborted) return;
    handlers.onError(err instanceof Error ? err.message : String(err));
  }
}

/** The id of the run currently executing on a thread, if there is one. */
export async function findActiveRun(client: Client<Raw>, threadId: string): Promise<string | null> {
  const runs = await client.runs.list(threadId);
  const active = runs.find((run) => run.status === "running" || run.status === "pending");
  return active?.run_id ?? null;
}

/** Join an in-flight run's stream, from wherever it has got to. */
export async function joinRun(
  client: Client<Raw>,
  threadId: string,
  runId: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const stream = client.runs.joinStream(threadId, runId, {
    signal,
    streamMode: [...STREAM_MODE],
  });
  await consume(stream, handlers, signal);
}

/** Start a run on a thread and stream it to completion. */
export async function streamRun(
  client: Client<Raw>,
  threadId: string,
  assistantId: string,
  input: Raw,
  handlers: StreamHandlers,
  signal: AbortSignal,
  config?: Raw,
): Promise<void> {
  const stream = client.runs.stream(threadId, assistantId, {
    input,
    config,
    signal,
    streamMode: [...STREAM_MODE],
  });
  await consume(stream, handlers, signal);
}

/** The dev server registers one assistant per graph in langgraph.json. */
export async function getAssistantId(client: Client<Raw>): Promise<string> {
  const assistants = await client.assistants.search({ limit: 1 });
  const first = assistants[0];
  if (!first) throw new Error("no assistant registered on the dev server");
  return first.assistant_id;
}

/** Compiled graph topology: nodes and edges as the dev server reports them. */
export async function getGraph(client: Client<Raw>, assistantId: string): Promise<unknown> {
  return client.assistants.getGraph(assistantId);
}
