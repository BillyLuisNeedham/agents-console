/**
 * Projection seam: pure mapping from SDK thread shapes to the view model the
 * DOM layer renders. No SDK calls, no DOM — fixtures in, view model out.
 */

import type { Thread } from "@langchain/langgraph-sdk";

export type Raw = Record<string, unknown>;

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface ThreadSummary {
  threadId: string;
  label: string;
  origin: string;
  status: string;
  updatedAt: string;
  interruptCount: number;
}

export interface TicketView {
  id: string;
  title: string;
  blockedBy: string[];
  status: "pending" | "running" | "done";
}

export type ChannelView =
  | { name: string; kind: "text"; text: string }
  | { name: string; kind: "pre"; text: string }
  | { name: string; kind: "tickets"; tickets: TicketView[] }
  | { name: string; kind: "json"; json: string };

// ---------------------------------------------------------------------------
// Thread summaries (left rail)
// ---------------------------------------------------------------------------

export function projectThreadSummary(thread: Thread<Raw>): ThreadSummary {
  const metadata = (thread.metadata ?? {}) as Raw;
  return {
    threadId: thread.thread_id,
    label:
      typeof metadata.label === "string" && metadata.label.length > 0
        ? metadata.label
        : thread.thread_id,
    origin: typeof metadata.origin === "string" ? metadata.origin : "unknown",
    status: thread.status,
    updatedAt: thread.updated_at,
    interruptCount: Object.values(thread.interrupts ?? {}).reduce(
      (count, list) => count + (list?.length ?? 0),
      0,
    ),
  };
}

/** The rail lists Console-created threads unless the show-all toggle is on. */
export function visibleThreads(threads: Thread<Raw>[], showAll: boolean): Thread<Raw>[] {
  if (showAll) return threads;
  return threads.filter(
    (thread) => (thread.metadata as Raw | undefined)?.origin === "ui",
  );
}

// ---------------------------------------------------------------------------
// Channels (selected thread)
// ---------------------------------------------------------------------------

/** Channels of the graph's State, in the order the detail panel shows them. */
const CHANNEL_ORDER = ["topic", "packetSource", "packet", "spec", "specApproved", "tickets"];

const PRE_CHANNELS = new Set(["packet", "spec"]);

function asValues(raw: unknown): Raw | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Raw;
}

function projectTickets(raw: unknown): TicketView[] {
  if (!Array.isArray(raw)) return [];
  const tickets: TicketView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as Raw;
    tickets.push({
      id: String(t.id ?? ""),
      title: String(t.title ?? ""),
      blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
      status:
        t.status === "running" || t.status === "done" ? t.status : "pending",
    });
  }
  return tickets;
}

function projectChannel(name: string, value: unknown): ChannelView {
  if (name === "tickets") return { name, kind: "tickets", tickets: projectTickets(value) };
  if (PRE_CHANNELS.has(name) && typeof value === "string") {
    return { name, kind: "pre", text: value };
  }
  if (typeof value === "string") return { name, kind: "text", text: value };
  if (typeof value === "number" || typeof value === "boolean") {
    return { name, kind: "text", text: String(value) };
  }
  return { name, kind: "json", json: JSON.stringify(value, null, 2) };
}

export function projectChannels(raw: unknown): ChannelView[] {
  const values = asValues(raw);
  if (!values) return [];
  const known = CHANNEL_ORDER.filter((name) => name in values);
  const extra = Object.keys(values)
    .filter((name) => !CHANNEL_ORDER.includes(name) && name !== "log" && !name.startsWith("__"))
    .sort();
  return [...known, ...extra].map((name) => projectChannel(name, values[name]));
}

export function projectLog(raw: unknown): string[] {
  const values = asValues(raw);
  const log = values?.log;
  if (!Array.isArray(log)) return [];
  return log.filter((line): line is string => typeof line === "string");
}

// ---------------------------------------------------------------------------
// Run projection: stream events in, view model out
// ---------------------------------------------------------------------------

/**
 * One part of a run's stream. The Console streams `values` + `updates` only;
 * anything else the server sends is ignored by the projection.
 */
export interface StreamPart {
  event: string;
  data: unknown;
}

export interface NodeView {
  node: string;
  status: "ran" | "active";
}

/**
 * What a live run has told us so far. `values` is the latest full State
 * snapshot (the source of truth for channels and log); the node lists come
 * from `updates` parts, one per super-step.
 */
export interface RunProjection {
  values: Raw;
  visitedNodes: string[];
  activeNodes: string[];
  streaming: boolean;
  streamError: string | null;
}

export function initRun(values?: unknown): RunProjection {
  return {
    values: asValues(values) ?? {},
    visitedNodes: [],
    activeNodes: [],
    streaming: false,
    streamError: null,
  };
}

/** Replace the snapshot (e.g. after a re-fetch) without losing node tracking. */
export function syncRunValues(run: RunProjection, values: unknown): RunProjection {
  return { ...run, values: asValues(values) ?? run.values };
}

export function applyStreamPart(run: RunProjection, part: StreamPart): RunProjection {
  if (part.event === "values") {
    return syncRunValues(run, part.data);
  }
  if (part.event === "updates") {
    const update = asValues(part.data);
    if (!update) return run;
    // Internal keys like __interrupt__ are not nodes; node chips name nodes.
    const active = Object.keys(update).filter((key) => !key.startsWith("__"));
    if (active.length === 0) return run;
    const visited = [...run.visitedNodes];
    for (const node of active) {
      if (!visited.includes(node)) visited.push(node);
    }
    return { ...run, activeNodes: active, visitedNodes: visited };
  }
  if (part.event === "error") {
    const data = asValues(part.data);
    const message =
      typeof data?.message === "string" ? data.message : "the run stream reported an error";
    return { ...run, streamError: message };
  }
  return run;
}

/** Node chips in first-seen order; the latest super-step's nodes are active. */
export function projectNodes(run: RunProjection): NodeView[] {
  return run.visitedNodes.map((node) => ({
    node,
    status: run.activeNodes.includes(node) ? "active" : "ran",
  }));
}
