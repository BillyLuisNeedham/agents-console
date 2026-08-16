/**
 * Projection seam: pure mapping from SDK thread shapes to the view model the
 * DOM layer renders. No SDK calls, no DOM: fixtures in, view model out.
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

/** Channels of the graph's State, in the order the inspector shows them. */
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
// Start-run form: form fields in, run payload out
// ---------------------------------------------------------------------------

/** Ticket pools a run can start from, passed to the graph as configurable.ticketDir. */
export const TICKET_POOLS = ["tickets/", "mock-tickets/", "mock-tickets-deadlock/"] as const;

export interface StartForm {
  topic: string;
  ticketDir: string;
  packet: string;
}

export interface StartRequest {
  input: Raw;
  config: Raw;
}

/**
 * The payload for starting a run. Null when the topic is blank (the form
 * blocks submission). A blank packet is omitted entirely so the graph falls
 * back to its demo packet.
 */
export function projectStartRun(form: StartForm): StartRequest | null {
  const topic = form.topic.trim();
  if (!topic) return null;
  const packet = form.packet.trim();
  return {
    input: { topic, ...(packet ? { packet } : {}) },
    config: { configurable: { ticketDir: form.ticketDir } },
  };
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

/** Clear the live highlight when a stream ends so the last node is not left "running". */
export function finishRun(run: RunProjection): RunProjection {
  return { ...run, streaming: false, activeNodes: [] };
}

const INTERRUPT_KIND_BY_NODE = {
  approveSpec: "approve-spec",
  deadlockGate: "deadlock",
  review: "review",
} as const;

const INTERRUPT_NODE: Record<string, string> = Object.fromEntries(
  Object.entries(INTERRUPT_KIND_BY_NODE).map(([node, kind]) => [kind, node]),
);

function nodesFromInterrupt(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const nodes: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const value = (item as { value?: unknown }).value;
    if (!value || typeof value !== "object") continue;
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind !== "string") continue;
    const node = INTERRUPT_NODE[kind];
    if (node && !nodes.includes(node)) nodes.push(node);
  }
  return nodes;
}

export function applyStreamPart(run: RunProjection, part: StreamPart): RunProjection {
  if (part.event === "values") {
    const values = asValues(part.data);
    if (!values) return run;
    // An interrupt lands as a values part holding only __interrupt__: run
    // bookkeeping, not a State snapshot. Keep the last real snapshot.
    const keys = Object.keys(values);
    if (keys.length > 0 && keys.every((key) => key.startsWith("__"))) return run;
    return syncRunValues(run, values);
  }
  if (part.event === "updates") {
    const update = asValues(part.data);
    if (!update) return run;
    // Internal keys like __interrupt__ are not nodes. An interrupt-only
    // part still names the node that raised it, via value.kind.
    const named = Object.keys(update).filter((key) => !key.startsWith("__"));
    const active = named.length > 0 ? named : nodesFromInterrupt(update.__interrupt__);
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

// ---------------------------------------------------------------------------
// Topology + canvas cards
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

export type CardStatus = "idle" | "ran" | "active" | "next" | "interrupted";

export type InterruptDecision =
  | { action: "approve" }
  | { action: "reject" }
  | { action: "reload" }
  | { action: "abort" }
  | { action: "retry"; ids: string[] }
  | { action: "replan" };

export type InterruptFormView =
  | { kind: "approve-spec"; spec: string; tickets: TicketView[]; raw: unknown }
  | { kind: "deadlock"; pending: string[]; hint: string; raw: unknown }
  | { kind: "review"; tickets: TicketView[]; raw: unknown };

export interface NodeCardView {
  id: string;
  name: string;
  x: number;
  y: number;
  status: CardStatus;
  channels: ChannelView[];
  interrupt: InterruptFormView | null;
}

/** SDK Command resume payload for the decision the form collected. */
export function projectResume(decision: InterruptDecision): { command: { resume: InterruptDecision } } {
  return { command: { resume: decision } };
}

export function projectTopology(raw: unknown): Topology {
  if (!raw || typeof raw !== "object") return { nodes: [], edges: [] };
  const graph = raw as { nodes?: unknown; edges?: unknown };
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  return {
    nodes: nodes.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const id = (item as { id?: unknown }).id;
      if (id == null) return [];
      const name = (item as { name?: unknown }).name;
      return [{ id: String(id), ...(typeof name === "string" ? { name } : {}) }];
    }),
    edges: edges.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const source = (item as { source?: unknown }).source;
      const target = (item as { target?: unknown }).target;
      if (source == null || target == null) return [];
      const conditional = (item as { conditional?: unknown }).conditional;
      const data = (item as { data?: unknown }).data;
      return [
        {
          source: String(source),
          target: String(target),
          ...(typeof conditional === "boolean" ? { conditional } : {}),
          ...(typeof data === "string" ? { data } : {}),
        },
      ];
    }),
  };
}

const SPINE: Record<string, { x: number; y: number }> = {
  __start__: { x: 300, y: 16 },
  START: { x: 300, y: 16 },
  writeSpec: { x: 300, y: 196 },
  approveSpec: { x: 300, y: 376 },
  schedule: { x: 300, y: 556 },
  implementTicket: { x: 300, y: 736 },
  deadlockGate: { x: 620, y: 596 },
  review: { x: 300, y: 916 },
  __end__: { x: 300, y: 1096 },
  END: { x: 300, y: 1096 },
};

export type Point = { x: number; y: number };

export function layoutGraph(nodes: TopologyNode[]): Record<string, Point> {
  const positions: Record<string, Point> = {};
  let unknown = 0;
  for (const node of nodes) {
    const seeded = SPINE[node.id];
    if (seeded) positions[node.id] = seeded;
    else {
      positions[node.id] = { x: 640, y: 16 + unknown * 160 };
      unknown += 1;
    }
  }
  return positions;
}

export function mergeLayout(
  defaults: Record<string, Point>,
  stored: Record<string, Point>,
): Record<string, Point> {
  const positions: Record<string, Point> = {};
  for (const [id, pos] of Object.entries(defaults)) {
    positions[id] = stored[id] ?? pos;
  }
  return positions;
}

export function parseStoredLayout(raw: unknown): Record<string, Point> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const positions: Record<string, Point> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const x = (value as { x?: unknown }).x;
    const y = (value as { y?: unknown }).y;
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    positions[id] = { x, y };
  }
  return positions;
}

export type EdgeMode = "ortho" | "straight";

export interface CardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function edgePath(
  source: CardBox,
  target: CardBox,
  mode: EdgeMode,
): { d: string; lx: number; ly: number } {
  const sx = source.x + source.w / 2;
  const sy = source.y + source.h / 2;
  const tx = target.x + target.w / 2;
  const ty = target.y + target.h / 2;
  const up = ty < sy;
  const outY = up ? source.y : source.y + source.h;
  const inY = up ? target.y + target.h : target.y;
  if (mode === "ortho") {
    const midY = (outY + inY) / 2;
    return {
      d: `M ${sx} ${outY} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${inY}`,
      lx: sx + 6,
      ly: midY,
    };
  }
  return {
    d: `M ${sx} ${outY} L ${tx} ${inY}`,
    lx: (sx + tx) / 2 + 6,
    ly: (outY + inY) / 2,
  };
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;

export interface ViewTransform {
  x: number;
  y: number;
  zoom: number;
}

export function zoomAtCursor(
  view: ViewTransform,
  cursor: Point,
  factor: number,
): ViewTransform {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  if (zoom === view.zoom) return view;
  const wx = (cursor.x - view.x) / view.zoom;
  const wy = (cursor.y - view.y) / view.zoom;
  return { x: cursor.x - wx * zoom, y: cursor.y - wy * zoom, zoom };
}

export function strokeWidthForZoom(zoom: number): number {
  return 1.5 / zoom;
}

const NODE_CHANNELS: Record<string, string[]> = {
  __start__: ["topic", "packet"],
  START: ["topic", "packet"],
  writeSpec: ["spec"],
  approveSpec: ["spec"],
  schedule: ["tickets"],
  implementTicket: ["tickets"],
  deadlockGate: ["tickets"],
  review: ["tickets"],
};

function displayName(id: string, name?: string): string {
  if (name) return name;
  if (id === "__start__") return "START";
  if (id === "__end__") return "END";
  return id;
}

export function projectNodeChannels(nodeId: string, raw: unknown): ChannelView[] {
  const values = asValues(raw) ?? {};
  const names = NODE_CHANNELS[nodeId] ?? [];
  const channels: ChannelView[] = [];
  for (const name of names) {
    if (!(name in values)) continue;
    const channel = projectChannel(name, values[name]);
    if (nodeId === "deadlockGate" && channel.kind === "tickets") {
      channels.push({
        ...channel,
        tickets: channel.tickets.filter((ticket) => ticket.status === "pending"),
      });
    } else {
      channels.push(channel);
    }
  }
  return channels;
}

function nodeChannelsForCard(
  nodeId: string,
  values: Raw,
  interrupt: InterruptFormView | null,
): ChannelView[] {
  if (interrupt?.kind === "deadlock") {
    const known = new Map(projectTickets(values.tickets).map((ticket) => [ticket.id, ticket]));
    return [
      {
        name: "tickets",
        kind: "tickets",
        tickets: interrupt.pending.map(
          (id) => known.get(id) ?? { id, title: "", blockedBy: [], status: "pending" as const },
        ),
      },
      { name: "hint", kind: "text", text: interrupt.hint },
    ];
  }
  return projectNodeChannels(nodeId, values);
}

function interruptValueOf(item: unknown): Raw | null {
  if (!item || typeof item !== "object") return null;
  return asValues((item as { value?: unknown }).value);
}

export function projectInterruptForm(interrupts: unknown, nodeId: string): InterruptFormView | null {
  const want = INTERRUPT_KIND_BY_NODE[nodeId as keyof typeof INTERRUPT_KIND_BY_NODE];
  if (!want || !interrupts || typeof interrupts !== "object") return null;
  for (const list of Object.values(interrupts as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const value = interruptValueOf(item);
      if (!value || value.kind !== want) continue;
      if (want === "approve-spec") {
        return {
          kind: "approve-spec",
          spec: typeof value.spec === "string" ? value.spec : "",
          tickets: projectTickets(value.tickets),
          raw: value,
        };
      }
      if (want === "deadlock") {
        return {
          kind: "deadlock",
          pending: Array.isArray(value.pending) ? value.pending.map(String) : [],
          hint: typeof value.hint === "string" ? value.hint : "",
          raw: value,
        };
      }
      return {
        kind: "review",
        tickets: projectTickets(value.tickets),
        raw: value,
      };
    }
  }
  return null;
}

export function projectNodeCards(
  topology: Topology,
  run: RunProjection | null,
  interrupts?: unknown,
): NodeCardView[] {
  const positions = layoutGraph(topology.nodes);
  const active = new Set(run?.activeNodes ?? []);
  const visited = new Set(run?.visitedNodes ?? []);
  const next = new Set<string>();
  if (run) {
    for (const edge of topology.edges) {
      if (edge.conditional) continue;
      if (active.has(edge.source) && !active.has(edge.target) && !visited.has(edge.target)) {
        next.add(edge.target);
      }
    }
  }
  const values = run?.values ?? {};
  return topology.nodes.map((node) => {
    const interrupt = projectInterruptForm(interrupts, node.id);
    const status: CardStatus = interrupt
      ? "interrupted"
      : active.has(node.id)
        ? "active"
        : next.has(node.id)
          ? "next"
          : visited.has(node.id)
            ? "ran"
            : "idle";
    const pos = positions[node.id] ?? { x: 0, y: 0 };
    const channels = nodeChannelsForCard(node.id, values, interrupt);
    return {
      id: node.id,
      name: displayName(node.id, node.name),
      x: pos.x,
      y: pos.y,
      status,
      channels,
      interrupt,
    };
  });
}

// ---------------------------------------------------------------------------
// Ticket cards (Send fan-out)
// ---------------------------------------------------------------------------

export interface TicketCardView {
  id: string;
  ticketId: string;
  title: string;
  blockedBy: string[];
  status: TicketView["status"];
  x: number;
  y: number;
}

const TICKET_FAN = { x: 640, y: 736, dy: 160 };
const TICKET_CARD_PREFIX = "ticket:";

export function ticketCardId(ticketId: string): string {
  return `${TICKET_CARD_PREFIX}${ticketId}`;
}

export function isTicketCardId(id: string): boolean {
  return id.startsWith(TICKET_CARD_PREFIX);
}

/** Ticket cards share ids across threads; graph nodes do not. */
export function layoutStorageKey(cardId: string, threadId: string | null): string {
  return isTicketCardId(cardId) && threadId ? `${threadId}:${cardId}` : cardId;
}

export function projectTicketCards(run: RunProjection | null): TicketCardView[] {
  if (!run) return [];
  return projectTickets(run.values.tickets).map((ticket, index) => ({
    id: ticketCardId(ticket.id),
    ticketId: ticket.id,
    title: ticket.title,
    blockedBy: ticket.blockedBy,
    status: ticket.status,
    x: TICKET_FAN.x,
    y: TICKET_FAN.y + index * TICKET_FAN.dy,
  }));
}

export function projectTicketEdges(cards: TicketCardView[]): TopologyEdge[] {
  return cards.map((card) => ({ source: "schedule", target: card.id }));
}
