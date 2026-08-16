/**
 * Console (prototype) — data layer.
 *
 * Talks to the LangGraph dev server at http://localhost:2024 (no auth, CORS
 * open) using the `@langchain/langgraph-sdk` v2 generation. If the server is
 * unreachable, `loadContext()` still succeeds and returns `MockData`, so every
 * variant renders identically whether live or mock — `ShellContext.mock` tells
 * them which world they are in.
 */

import { Client, type Interrupt, type Thread } from "@langchain/langgraph-sdk";
import { mockContext } from "./mock";

export const DEV_SERVER_URL = "http://localhost:2024";
export const GRAPH_ID = "graph";
export const UI_ORIGIN = "ui";
export const TICKET_POOLS = ["tickets", "mock-tickets", "mock-tickets-deadlock"] as const;

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------

export type TicketStatus = "pending" | "running" | "done";

export interface Ticket {
  id: string;
  title: string;
  blockedBy: string[];
  status: TicketStatus;
}

// ---------------------------------------------------------------------------
// Thread values (what a thread's State carries)
// ---------------------------------------------------------------------------

export interface ThreadValues {
  spec: string;
  tickets: Ticket[];
  log: string[];
  packet: string;
}

// ---------------------------------------------------------------------------
// Interrupts
// ---------------------------------------------------------------------------

export const INTERRUPT_KINDS = ["approve-spec", "deadlock", "review"] as const;
export type InterruptKind = (typeof INTERRUPT_KINDS)[number];

export interface ApproveSpecInterruptValue {
  kind: "approve-spec";
  spec: string;
  tickets: Ticket[];
}

export interface DeadlockInterruptValue {
  kind: "deadlock";
  pending: string[];
  hint: string;
}

export interface ReviewInterruptValue {
  kind: "review";
  tickets: Ticket[];
}

export type InterruptValue =
  | ApproveSpecInterruptValue
  | DeadlockInterruptValue
  | ReviewInterruptValue;

/** Payload shapes used to resume each interrupt kind. */
export type ApproveSpecDecision = { action: "approve" } | { action: "reject" };
export type DeadlockDecision = { action: "reload" } | { action: "abort" };
export type ReviewDecision =
  | { action: "approve" }
  | { action: "retry"; ids: string[] }
  | { action: "replan" };
export type InterruptDecision = ApproveSpecDecision | DeadlockDecision | ReviewDecision;

/** Flat projection of `thread.interrupts` for the UI. */
export interface InterruptProjection {
  kind: InterruptKind;
  id?: string;
  ns: string[];
  value: InterruptValue;
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

export interface TopologyNode {
  id: string;
  name?: string;
}

export interface TopologyEdge {
  source: string;
  target: string;
  conditional?: boolean;
  data?: string;
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export interface ThreadListItem {
  threadId: string;
  label: string;
  origin: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  values: ThreadValues | null;
  interrupts: InterruptProjection[];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Run-start inputs: topic + ticket pool (via `configurable.ticketDir`) + optional packet. */
export interface RunInput {
  topic: string;
  ticketDir: string;
  packet?: string;
}

export interface StreamOutcome {
  values: ThreadValues[];
  updates: Record<string, unknown>[];
  interrupted: InterruptProjection | null;
}

export type StreamRun = (threadId: string, input: RunInput) => Promise<StreamOutcome>;
export type ResumeRun = (threadId: string, decision: InterruptDecision) => Promise<StreamOutcome>;

// ---------------------------------------------------------------------------
// ShellContext — the contract variants render from
// ---------------------------------------------------------------------------

export interface ShellContext {
  /** Threads the UI created (`metadata.origin === "ui"`) — the default view. */
  threads: ThreadListItem[];
  /** Every thread on the server, regardless of origin — the "show all" view. */
  allThreads: ThreadListItem[];
  selectedThreadId: string | null;
  /** Values of the selected thread. */
  selected: ThreadValues | null;
  /** Pending interrupts of the selected thread (each thread also carries its own). */
  interrupts: InterruptProjection[];
  topology: Topology;
  /** True when rendering from MockData because the dev server is unreachable. */
  mock: boolean;
  streamRun: StreamRun;
  resumeRun: ResumeRun;
}

// ---------------------------------------------------------------------------
// Live client
// ---------------------------------------------------------------------------

let client: Client | null = null;
let assistantId: string | null = null;

function makeClient(): Client {
  return new Client({ apiUrl: DEV_SERVER_URL, apiKey: null });
}

/** The dev server auto-creates one assistant per graph in langgraph.json; graph id is `graph`. */
async function resolveAssistantId(c: Client): Promise<string> {
  const matches = await c.assistants.search({ graphId: GRAPH_ID, limit: 1 });
  if (matches.length > 0) return matches[0].assistant_id;
  const fallback = await c.assistants.search({ limit: 1 });
  if (fallback.length === 0) {
    throw new Error(`No assistant found on ${DEV_SERVER_URL}`);
  }
  return fallback[0].assistant_id;
}

async function fetchTopology(c: Client, aid: string): Promise<Topology> {
  const graph = await c.assistants.getGraph(aid);
  return {
    nodes: (graph.nodes ?? []).map((n) => ({
      id: String(n.id),
      ...(n.name ? { name: n.name } : {}),
    })),
    edges: (graph.edges ?? []).map((e) => ({
      source: String(e.source),
      target: String(e.target),
      ...(e.conditional !== undefined ? { conditional: e.conditional } : {}),
      ...(e.data ? { data: e.data } : {}),
    })),
  };
}

function projectValues(raw: unknown): ThreadValues | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    spec: typeof o.spec === "string" ? o.spec : "",
    tickets: Array.isArray(o.tickets) ? (o.tickets as Ticket[]) : [],
    log: Array.isArray(o.log) ? o.log.filter((x): x is string => typeof x === "string") : [],
    packet: typeof o.packet === "string" ? o.packet : "",
  };
}

function isInterruptValue(value: unknown): value is InterruptValue {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && (INTERRUPT_KINDS as readonly string[]).includes(kind);
}

function projectInterrupts(
  interrupts: Record<string, Array<Interrupt>> | undefined,
): InterruptProjection[] {
  const out: InterruptProjection[] = [];
  for (const [ns, list] of Object.entries(interrupts ?? {})) {
    for (const item of list ?? []) {
      if (!isInterruptValue(item.value)) continue;
      const value = item.value as InterruptValue;
      out.push({
        kind: value.kind,
        ...(item.id ? { id: item.id } : {}),
        ns: ns.split("/"),
        value,
      });
    }
  }
  return out;
}

function projectThread(thread: Thread<Record<string, unknown>>): ThreadListItem {
  const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
  return {
    threadId: thread.thread_id,
    label:
      typeof metadata.label === "string" && metadata.label.length > 0
        ? metadata.label
        : thread.thread_id,
    origin: typeof metadata.origin === "string" ? metadata.origin : "unknown",
    status: thread.status,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    values: projectValues(thread.values),
    interrupts: projectInterrupts(thread.interrupts),
  };
}

async function loadLive(): Promise<ShellContext> {
  const c = makeClient();
  const aid = await resolveAssistantId(c);
  client = c;
  assistantId = aid;

  const query = {
    limit: 20,
    sortBy: "updated_at" as const,
    sortOrder: "desc" as const,
  };
  const [allRaw, uiRaw] = await Promise.all([
    c.threads.search<Record<string, unknown>>({ ...query }),
    c.threads.search<Record<string, unknown>>({ ...query, metadata: { origin: UI_ORIGIN } }),
  ]);
  const topology = await fetchTopology(c, aid);

  const all = allRaw.map(projectThread);
  const ui = uiRaw.map(projectThread);
  const pool = ui.length > 0 ? ui : all;
  const selectedThreadId = pool.length > 0 ? pool[0].threadId : null;
  const selectedItem = pool.find((t) => t.threadId === selectedThreadId) ?? null;

  return {
    threads: ui,
    allThreads: all,
    selectedThreadId,
    selected: selectedItem?.values ?? null,
    interrupts: selectedItem?.interrupts ?? [],
    topology,
    mock: false,
    streamRun,
    resumeRun,
  };
}

async function pendingInterrupt(threadId: string): Promise<InterruptProjection | null> {
  if (!client) return null;
  try {
    const thread = await client.threads.get<Record<string, unknown>>(threadId);
    const found = projectInterrupts(thread.interrupts);
    return found.length > 0 ? found[0] : null;
  } catch {
    return null;
  }
}

async function runWith(
  threadId: string,
  payload: { input: Record<string, unknown> | null; config?: { configurable: { ticketDir: string } } },
): Promise<StreamOutcome> {
  if (!client || !assistantId) {
    throw new Error("streamRun/resumeRun require a live connection; MOCK DATA mode is read-only");
  }
  const values: ThreadValues[] = [];
  const updates: Record<string, unknown>[] = [];
  const stream = client.runs.stream(threadId, assistantId, {
    ...payload,
    streamMode: ["values", "updates"],
  });
  try {
    for await (const part of stream) {
      if (part.event === "values") {
        const projected = projectValues(part.data);
        if (projected) values.push(projected);
      } else if (part.event === "updates") {
        updates.push(part.data);
      }
    }
  } catch {
    // Interrupted runs can close the stream with an error on some servers.
  }
  const interrupted = await pendingInterrupt(threadId);
  return { values, updates, interrupted };
}

export const streamRun: StreamRun = (threadId, input) =>
  runWith(threadId, {
    input: {
      topic: input.topic,
      ...(input.packet && input.packet.trim() ? { packet: input.packet.trim() } : {}),
    },
    config: { configurable: { ticketDir: input.ticketDir } },
  });

/** Resume an interrupted run by streaming the interrupt's expected payload as input. */
export const resumeRun: ResumeRun = (threadId, decision) =>
  runWith(threadId, { input: decision as unknown as Record<string, unknown> });

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function serverReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${DEV_SERVER_URL}/info`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function loadContext(): Promise<ShellContext> {
  if (await serverReachable()) {
    try {
      return await loadLive();
    } catch {
      // Any live failure falls through to mock — variants must render either way.
    }
  }
  return mockContext();
}
