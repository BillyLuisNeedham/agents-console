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
    .filter((name) => !CHANNEL_ORDER.includes(name) && name !== "log")
    .sort();
  return [...known, ...extra].map((name) => projectChannel(name, values[name]));
}

export function projectLog(raw: unknown): string[] {
  const values = asValues(raw);
  const log = values?.log;
  if (!Array.isArray(log)) return [];
  return log.filter((line): line is string => typeof line === "string");
}
