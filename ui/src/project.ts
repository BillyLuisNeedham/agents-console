/**
 * Pool projection seam: pure mapping from the pool server's snapshot payload
 * (the same full state the SSE stream serves) to the view model the DOM layer
 * renders. No network calls, no DOM: fixtures in, view model out.
 */

import { marked } from "marked";

// ---------------------------------------------------------------------------
// Pool snapshot (wire format served by the pool server)
// ---------------------------------------------------------------------------

export type PoolStatus = "ready" | "in-progress" | "done" | "checkpoint";

interface PoolOutcome {
  summary: string;
  commitSha: string | null;
}

interface PoolInterrupt {
  ticketId: string;
  kind: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Interrupt forms: one form shape across the interrupt kinds, with a
// kind-specific title and action set. Pure config over the interrupt; the
// DOM layer renders it. The engine appends the note to the Issue file on
// every answer path, so every form carries the note field.
// ---------------------------------------------------------------------------

export type InterruptAction = "resume" | "approve" | "reject";

interface InterruptFormAction {
  action: InterruptAction;
  label: string;
  tone: "primary" | "danger";
}

interface InterruptFormView {
  title: string;
  actions: InterruptFormAction[];
  notePlaceholder?: string;
}

/** An interrupt with its form attached, as projected onto a card or Detail. */
export interface InterruptView extends PoolInterrupt {
  form: InterruptFormView;
}

const RESUME: InterruptFormAction = { action: "resume", label: "resume", tone: "primary" };
const APPROVE: InterruptFormAction = { action: "approve", label: "approve", tone: "primary" };
const REJECT: InterruptFormAction = { action: "reject", label: "reject", tone: "danger" };

const INTERRUPT_FORMS: Record<string, InterruptFormView> = {
  checkpoint: { title: "checkpoint", actions: [RESUME] },
  crash: { title: "harness crash", actions: [RESUME] },
  deadlock: { title: "deadlock", actions: [RESUME] },
  "merge-conflict": { title: "merge conflict", actions: [RESUME] },
  "merge-approval": { title: "merge approval", actions: [APPROVE, REJECT] },
  review: {
    title: "review",
    actions: [APPROVE, REJECT],
    notePlaceholder:
      "approve: optional note · reject: name the tickets to send back",
  },
};

/**
 * The form for an interrupt. The engine's six kinds all render; an unknown
 * kind falls back to a plain resume form so a newer engine never renders an
 * unanswerable interrupt.
 */
export function interruptForm(interrupt: PoolInterrupt): InterruptFormView {
  return INTERRUPT_FORMS[interrupt.kind] ?? { title: interrupt.kind, actions: [RESUME] };
}

export interface PoolTicketState {
  id: string;
  title: string;
  blockedBy: string[];
  status: PoolStatus;
}

export type PoolPhase = "running" | "done" | "quiescent" | "stalled";

interface PoolState {
  tickets: PoolTicketState[];
  log: string[];
  outcomes: Record<string, PoolOutcome>;
  interrupts: PoolInterrupt[];
  config: Record<string, unknown>;
}

export interface PoolSnapshot {
  seq: number;
  phase: PoolPhase;
  /** The pool's display name, computed server-side from the pool directory. */
  poolName: string;
  state: PoolState;
}

// ---------------------------------------------------------------------------
// Ticket events (wire format served by /api/events)
// ---------------------------------------------------------------------------

export interface TicketEvent {
  at: string;
  attempt: number;
  kind: string;
  payload: Record<string, unknown>;
}

interface ReconstructedAttempt {
  attempt: number;
  logFile: string;
  modifiedAt: string;
}

export interface TicketEventsResponse {
  events: TicketEvent[];
  attempts: ReconstructedAttempt[];
  reconstructed: boolean;
  /** The ticket's spec text: the issue file body after the title heading. */
  spec: string;
}

// ---------------------------------------------------------------------------
// Ticket body wire type (served by /api/ticket)
// ---------------------------------------------------------------------------

export interface TicketBodyResponse {
  id: string;
  /** The Issue file's markdown with the line-1 state marker stripped. */
  body: string;
}

// ---------------------------------------------------------------------------
// Log pane wire types (served by /api/log)
// ---------------------------------------------------------------------------

interface LogAttemptInfo {
  attempt: number;
  kind: "implement" | "resolver" | "reconstructed";
  logFile: string;
  current: boolean;
}

export interface TicketLogResponse {
  content: string;
  offset: number;
  nextOffset: number;
  totalSize: number;
  attempts: LogAttemptInfo[];
}

// ---------------------------------------------------------------------------
// Timeline view model
// ---------------------------------------------------------------------------

interface TimelineEventView {
  kind: string;
  at: string;
  payload: Record<string, unknown>;
}

interface TimelineAttemptView {
  number: number;
  events: TimelineEventView[];
  reconstructed: boolean;
  running: boolean;
  logFile: string | null;
}

export interface TimelineView {
  attempts: TimelineAttemptView[];
  reconstructed: boolean;
}

/**
 * The ticket timeline: one row per attempt with its events, derived from the
 * events endpoint's parsed events, or reconstructed one row per log file for
 * a pre-feature pool with no events file. The currently running attempt is
 * marked: the latest attempt whose last event has not yet exited, when the
 * ticket's status is in-progress.
 */
export function projectTimeline(
  response: TicketEventsResponse,
  status: PoolStatus,
): TimelineView {
  if (response.events.length > 0) {
    const byAttempt = new Map<number, TimelineEventView[]>();
    for (const event of response.events) {
      const list = byAttempt.get(event.attempt) ?? [];
      list.push({ kind: event.kind, at: event.at, payload: event.payload });
      byAttempt.set(event.attempt, list);
    }
    const numbers = [...byAttempt.keys()].sort((a, b) => a - b);
    const running = runningAttempt(numbers, byAttempt, status);
    return {
      attempts: numbers.map((number) => ({
        number,
        events: byAttempt.get(number)!,
        reconstructed: false,
        running: number === running,
        logFile: null,
      })),
      reconstructed: false,
    };
  }
  const attempts = response.attempts.map((row, index) => ({
    number: row.attempt,
    events: [] as TimelineEventView[],
    reconstructed: true,
    running: status === "in-progress" && index === response.attempts.length - 1,
    logFile: row.logFile,
  }));
  return { attempts, reconstructed: response.reconstructed };
}

// An attempt is live only while its last recorded event has not yet ended
// it: the harness was spawned (or is about to be) and has not exited or
// crashed. A crashed attempt stays in-progress on the marker, but it is not
// running.
const LIVE_LAST_KINDS = new Set(["scheduled", "spawned", "resolver"]);

function runningAttempt(
  numbers: number[],
  byAttempt: Map<number, TimelineEventView[]>,
  status: PoolStatus,
): number | null {
  if (status !== "in-progress") return null;
  for (let i = numbers.length - 1; i >= 0; i--) {
    const last = byAttempt.get(numbers[i])!.at(-1);
    if (last && LIVE_LAST_KINDS.has(last.kind)) return numbers[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Log pane view model
// ---------------------------------------------------------------------------

export interface LogPaneView {
  /** The attempt whose log the pane shows; null when the ticket has never run. */
  selectedAttempt: number | null;
  /** The raw log text (ANSI stripped server-side) fetched for that attempt. */
  content: string;
  /** The raw byte offset of the first byte the pane holds. */
  firstOffset: number;
  /** The raw byte offset the next tail fetch should request. */
  offset: number;
  /** The raw byte size of the attempt's log file. */
  totalSize: number;
  /** More chunks remain to fetch (offset < totalSize). */
  hasMore: boolean;
  /** Older bytes exist before the held window: offer "load earlier". */
  hasEarlier: boolean;
  /** The ticket has never run: no attempts, no pane content. */
  neverRun: boolean;
  error: string | null;
}

/**
 * The attempt the log pane shows. A clicked attempt wins; otherwise the
 * running attempt, else the latest recorded attempt. Null for a ticket that
 * has never run.
 */
export function selectLogAttempt(
  timeline: TimelineView,
  clicked: number | null,
): number | null {
  if (clicked !== null) return clicked;
  const running = timeline.attempts.find((a) => a.running);
  return (
    running?.number ??
    timeline.attempts[timeline.attempts.length - 1]?.number ??
    null
  );
}

/**
 * The log pane view: which attempt is selected, the log text fetched for it,
 * and whether the ticket's never-run fallback applies. The pane tails live:
 * `offset`/`totalSize` track the append cursor and `firstOffset` tracks the
 * oldest held byte, so the DOM layer follows the tail and offers "load
 * earlier". A null timeline (not yet loaded) projects null, so the pane is
 * simply absent until the timeline lands.
 */
export function projectLogPane(
  timeline: TimelineView | null,
  clickedAttempt: number | null,
  log: { content: string; firstOffset: number; offset: number; totalSize: number } | null,
  error: string | null,
): LogPaneView | null {
  if (!timeline) return null;
  const hasAttempts = timeline.attempts.length > 0;
  if (!hasAttempts) {
    return {
      selectedAttempt: null,
      content: "",
      firstOffset: 0,
      offset: 0,
      totalSize: 0,
      hasMore: false,
      hasEarlier: false,
      neverRun: true,
      error: null,
    };
  }
  const selectedAttempt = selectLogAttempt(timeline, clickedAttempt);
  const loaded = log ?? { content: "", firstOffset: 0, offset: 0, totalSize: 0 };
  return {
    selectedAttempt,
    content: loaded.content,
    firstOffset: loaded.firstOffset,
    offset: loaded.offset,
    totalSize: loaded.totalSize,
    hasMore: loaded.offset < loaded.totalSize,
    hasEarlier: loaded.firstOffset > 0,
    neverRun: false,
    error,
  };
}

// ---------------------------------------------------------------------------
// Log tailing decisions (pure; the DOM layer applies them to the scroll pane)
// ---------------------------------------------------------------------------

/**
 * The byte window the log pane opens and pages by. Mirrors the pool server's
 * LOG_CHUNK_BYTES: the wire contract pages in these steps, so the tail-first
 * window and the "load earlier" step are one chunk each.
 */
export const LOG_TAIL_BYTES = 64 * 1024;

/** The byte offset a tail-first open starts at: the last window of the log. */
export function initialLogWindow(totalSize: number): number {
  return Math.max(0, totalSize - LOG_TAIL_BYTES);
}

/**
 * The byte offset the next tail fetch requests, or null when the pane holds
 * the whole file. The pane appends from its last read offset until caught up.
 */
export function logTailOffset(offset: number, totalSize: number): number | null {
  return offset < totalSize ? offset : null;
}

/**
 * The byte offset a "load earlier" fetch requests: one window before the
 * oldest byte held, or null when the pane already holds the file head.
 */
export function earlierLogOffset(firstOffset: number): number | null {
  return firstOffset > 0 ? Math.max(0, firstOffset - LOG_TAIL_BYTES) : null;
}

/** Slack in px for "scrolled to the bottom": within it counts as at the tail. */
export const LOG_BOTTOM_SLACK_PX = 24;

/**
 * Whether the log pane sits at the tail. Auto-scroll follows the log only
 * while this holds; scrolling up unpins, scrolling back into the slack
 * resumes following.
 */
export function logAtBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - LOG_BOTTOM_SLACK_PX;
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type Point = { x: number; y: number };

export interface TicketCardView {
  kind: "ticket";
  id: string;
  ticketId: string;
  title: string;
  blockedBy: string[];
  status: PoolStatus;
  outcome: PoolOutcome | null;
  interrupt: InterruptView | null;
  x: number;
  y: number;
}

export interface UtilityCardView {
  kind: "utility";
  id: string;
  label: string;
  interrupt: InterruptView | null;
  x: number;
  y: number;
}

export type PoolCardView = TicketCardView | UtilityCardView;

interface PoolView {
  seq: number;
  phase: PoolPhase;
  cards: PoolCardView[];
  edges: TopologyEdge[];
  log: string[];
}

// ---------------------------------------------------------------------------
// Pool projection
// ---------------------------------------------------------------------------

export const START_CARD_ID = "START";
export const REVIEW_CARD_ID = "REVIEW";
const TICKET_PREFIX = "ticket:";

export function ticketCardId(ticketId: string): string {
  return `${TICKET_PREFIX}${ticketId}`;
}

export function isTicketCardId(id: string): boolean {
  return id.startsWith(TICKET_PREFIX);
}

// There is one pool per server, so a card's stored position is keyed by its
// own id; no thread scoping is needed.
export function layoutStorageKey(cardId: string): string {
  return cardId;
}

const LAYOUT = {
  centerX: 420,
  startY: 16,
  rowH: 200,
  colGap: 320,
  reviewY: 1200,
} as const;

/** Depth of a ticket = length of its longest blocker chain; leaf tickets are 0. */
export function ticketDepth(
  ticketId: string,
  tickets: PoolTicketState[],
  visiting: Set<string> = new Set(),
): number {
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) return 0;
  if (ticket.blockedBy.length === 0) return 0;
  if (visiting.has(ticketId)) return 0;
  visiting.add(ticketId);
  const deepest = ticket.blockedBy.reduce(
    (max, blocker) => Math.max(max, ticketDepth(blocker, tickets, visiting)),
    0,
  );
  visiting.delete(ticketId);
  return deepest + 1;
}

/** Default positions: START above, tickets layered by dependency depth, REVIEW below. */
function layoutPool(
  tickets: PoolTicketState[],
  startId: string = START_CARD_ID,
  reviewId: string = REVIEW_CARD_ID,
): Record<string, Point> {
  const positions: Record<string, Point> = {};
  positions[startId] = { x: LAYOUT.centerX, y: LAYOUT.startY };
  positions[reviewId] = { x: LAYOUT.centerX, y: LAYOUT.reviewY };

  const byDepth = new Map<number, PoolTicketState[]>();
  for (const ticket of tickets) {
    const depth = ticketDepth(ticket.id, tickets);
    const row = byDepth.get(depth) ?? [];
    row.push(ticket);
    byDepth.set(depth, row);
  }
  for (const [depth, row] of byDepth) {
    const offset = ((row.length - 1) * LAYOUT.colGap) / 2;
    row.forEach((ticket, index) => {
      positions[ticketCardId(ticket.id)] = {
        x: LAYOUT.centerX - offset + index * LAYOUT.colGap,
        y: LAYOUT.startY + LAYOUT.rowH + depth * LAYOUT.rowH,
      };
    });
  }
  return positions;
}

export function projectPoolEdges(
  tickets: PoolTicketState[],
  startId: string = START_CARD_ID,
  reviewId: string = REVIEW_CARD_ID,
): TopologyEdge[] {
  const edges: TopologyEdge[] = [];
  for (const ticket of tickets) {
    const target = ticketCardId(ticket.id);
    if (ticket.blockedBy.length === 0) {
      edges.push({ source: startId, target });
    }
    for (const blocker of ticket.blockedBy) {
      edges.push({ source: ticketCardId(blocker), target });
    }
    edges.push({ source: target, target: reviewId });
  }
  return edges;
}

function toInterruptView(raw: PoolInterrupt | null): InterruptView | null {
  return raw ? { ...raw, form: interruptForm(raw) } : null;
}

function projectTicket(
  ticket: PoolTicketState,
  state: PoolState,
  pos: Point,
): TicketCardView {
  const raw = state.interrupts.find((i) => i.ticketId === ticket.id) ?? null;
  return {
    kind: "ticket",
    id: ticketCardId(ticket.id),
    ticketId: ticket.id,
    title: ticket.title,
    blockedBy: ticket.blockedBy,
    status: ticket.status,
    outcome: state.outcomes[ticket.id] ?? null,
    interrupt: toInterruptView(raw),
    x: pos.x,
    y: pos.y,
  };
}

// A utility card can carry an interrupt too: the engine's final Review is
// raised with the review card's id, so it is answered where the run ends.
function projectUtility(
  id: string,
  label: string,
  state: PoolState,
  pos: Point,
): UtilityCardView {
  const raw = state.interrupts.find((i) => i.ticketId === id) ?? null;
  return {
    kind: "utility",
    id,
    label,
    interrupt: toInterruptView(raw),
    x: pos.x,
    y: pos.y,
  };
}

export function projectPool(snapshot: PoolSnapshot): PoolView {
  const tickets = snapshot.state.tickets;
  const positions = layoutPool(tickets);
  const cards: PoolCardView[] = [
    projectUtility(START_CARD_ID, "start", snapshot.state, positions[START_CARD_ID]),
    ...tickets.map((ticket) => projectTicket(ticket, snapshot.state, positions[ticketCardId(ticket.id)])),
    projectUtility(REVIEW_CARD_ID, "review", snapshot.state, positions[REVIEW_CARD_ID]),
  ];
  return {
    seq: snapshot.seq,
    phase: snapshot.phase,
    cards,
    edges: projectPoolEdges(tickets),
    log: snapshot.state.log,
  };
}

export function projectLog(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { log?: unknown }).log)) {
    return [];
  }
  return (raw as { log: unknown[] }).log.filter((line): line is string => typeof line === "string");
}

export function statusLabel(status: PoolStatus): string {
  return status === "in-progress" ? "running" : status;
}

export function phaseLabel(phase: PoolPhase): string {
  switch (phase) {
    case "running":
      return "running";
    case "quiescent":
      return "waiting on you";
    case "done":
      return "done";
    case "stalled":
      return "stalled";
  }
}

export interface PoolTabStatus {
  word: string;
  color: string;
}

/**
 * The pool's at-a-glance status for the browser tab, worst-first: any pending
 * interrupt or a stalled phase needs input; otherwise a running phase is
 * running, a done phase is complete, and anything else is idle. Quiescent
 * always carries a pending interrupt, so it lands on needs input without a
 * rule of its own. Colors come from the Console palette; the tab title and the
 * favicon both consume this value.
 */
export function poolStatus(snapshot: PoolSnapshot): PoolTabStatus {
  if (snapshot.state.interrupts.length > 0 || snapshot.phase === "stalled") {
    return { word: "needs input", color: "#f85149" };
  }
  if (snapshot.phase === "running") {
    return { word: "running", color: "#d29922" };
  }
  if (snapshot.phase === "done") {
    return { word: "complete", color: "#3fb950" };
  }
  return { word: "idle", color: "#8b949e" };
}

// ---------------------------------------------------------------------------
// Detail content
// ---------------------------------------------------------------------------

export interface TicketDetailView {
  kind: "ticket";
  ticketId: string;
  title: string;
  status: PoolStatus;
  blockedBy: string[];
  outcome: PoolOutcome | null;
  interrupt: InterruptView | null;
}

interface UtilityDetailView {
  kind: "utility";
  id: string;
  label: string;
  interrupt: InterruptView | null;
}

export type DetailView = TicketDetailView | UtilityDetailView;

/** The Detail for a selected card, or null when the card is not in the pool. */
export function projectDetail(snapshot: PoolSnapshot, cardId: string): DetailView | null {
  const card = projectPool(snapshot).cards.find((c) => c.id === cardId);
  if (!card) return null;
  if (card.kind === "ticket") {
    return {
      kind: "ticket",
      ticketId: card.ticketId,
      title: card.title,
      status: card.status,
      blockedBy: card.blockedBy,
      outcome: card.outcome,
      interrupt: card.interrupt,
    };
  }
  return { kind: "utility", id: card.id, label: card.label, interrupt: card.interrupt };
}

// ---------------------------------------------------------------------------
// Detail tab default
// ---------------------------------------------------------------------------

export type DetailTab = "spec" | "progress" | "outcome";

/**
 * A manually chosen tab, held per ticket: the ticket id the choice belongs
 * to plus the chosen tab. Null means "auto": the default for the ticket's
 * phase. Because the choice carries its ticket id, the view layer keeps one
 * value and a stale choice from a previous selection simply does not apply.
 */
export interface TabOverride {
  ticketId: string;
  tab: DetailTab;
}

/**
 * The tab a ticket's Detail opens on: Progress for anything live or waiting
 * on a human, Spec before the ticket has run, Outcome once it is done. A
 * pending interrupt always wins over the status, even on a done ticket: the
 * interrupt is the action surface, and the action surface is Progress.
 */
export function defaultDetailTab(
  status: PoolStatus,
  interruptPending: boolean,
): DetailTab {
  if (interruptPending) return "progress";
  switch (status) {
    case "ready":
      return "spec";
    case "in-progress":
    case "checkpoint":
      return "progress";
    case "done":
      return "outcome";
  }
}

/**
 * The tab a ticket's Detail shows. A manual choice for this ticket wins;
 * a choice made on another ticket does not apply, so the default reasserts
 * itself when the selection changes ticket.
 */
export function projectDetailTab(
  detail: TicketDetailView,
  override: TabOverride | null,
): DetailTab {
  if (override && override.ticketId === detail.ticketId) return override.tab;
  return defaultDetailTab(detail.status, detail.interrupt !== null);
}

// ---------------------------------------------------------------------------
// Detail tab bar
// ---------------------------------------------------------------------------

export interface DetailTabView {
  id: DetailTab;
  label: string;
  active: boolean;
  /** The Progress tab carries the pending-interrupt dot, mirroring the canvas card. */
  interruptDot: boolean;
}

/**
 * The Detail's tab bar: Spec, Progress and Outcome in a fixed order, so the
 * bar never reshapes as the ticket moves through its phases. The active tab
 * comes from the same rule as the tab default (a manual choice for this
 * ticket wins), and a pending interrupt marks the Progress tab with the red
 * dot the canvas card already shows.
 */
export function projectDetailTabs(
  detail: TicketDetailView,
  override: TabOverride | null,
): DetailTabView[] {
  const active = projectDetailTab(detail, override);
  const tab = (id: DetailTab, label: string): DetailTabView => ({
    id,
    label,
    active: id === active,
    interruptDot: id === "progress" && detail.interrupt !== null,
  });
  return [tab("spec", "Spec"), tab("progress", "Progress"), tab("outcome", "Outcome")];
}

/**
 * The Spec tab's body: the ticket's markdown rendered to HTML. The DOM layer
 * assigns it as innerHTML; the ticket files are the pool's own prose, served
 * same-origin, so no sanitiser sits between.
 */
export function ticketBodyHtml(body: string): string {
  return marked(body, { async: false });
}

/**
 * The next Detail selection after a card press-release. Clicking the selected
 * card again clears the selection; clicking any other card swaps to it.
 */
export function nextNodeSelection(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

// ---------------------------------------------------------------------------
// Canvas geometry (unchanged from the thread-driven Console)
// ---------------------------------------------------------------------------

export type EdgeMode = "ortho" | "straight";

export interface CardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TopologyEdge {
  source: string;
  target: string;
  conditional?: boolean;
  data?: string;
}

/**
 * The flow neighbourhood of a selected card: its one-hop inflow (the cards
 * whose edges point at it: its blockers, plus start when it is blockerless)
 * and one-hop outflow (the cards it points at: its dependents, plus review).
 * One hop only, never the transitive cone, so a chain does not light up the
 * whole canvas. A cleared selection has an empty neighbourhood.
 */
export function flowNeighbourhood(
  edges: TopologyEdge[],
  selectedId: string | null,
): { inflow: string[]; outflow: string[] } {
  if (!selectedId) return { inflow: [], outflow: [] };
  return {
    inflow: edges.filter((edge) => edge.target === selectedId).map((edge) => edge.source),
    outflow: edges.filter((edge) => edge.source === selectedId).map((edge) => edge.target),
  };
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

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

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

// ---------------------------------------------------------------------------
// Drawers height clamp
// ---------------------------------------------------------------------------

export const DRAWER_MIN_VH = 15;
export const DRAWER_MAX_VH = 80;
export const DRAWER_DEFAULT_VH = 32;

/** Clamp a drawer height in vh units to the shared bounds. */
export function clampDrawersHeight(vh: number): number {
  return Math.min(DRAWER_MAX_VH, Math.max(DRAWER_MIN_VH, vh));
}

// ---------------------------------------------------------------------------
// Detail width clamp
// ---------------------------------------------------------------------------

export const DETAIL_MIN_PX = 340;
/** The Detail's maximum width, as a fraction of the window width. */
export const DETAIL_MAX_FRACTION = 0.8;

/**
 * Clamp a Detail width in px to the readable minimum and most of the window.
 * `maxPx` is the caller-computed window fraction (about 80vw). On a window too
 * narrow to hold the 340px minimum, the window bound wins and the panel
 * tracks the window.
 */
export function clampDetailWidth(px: number, maxPx: number): number {
  return Math.min(maxPx, Math.max(DETAIL_MIN_PX, px));
}

/**
 * The Detail width persistence round trip: the width is stored as a plain
 * number string under one global key, and a reload parses it back and clamps
 * it to the current window. A missing, unparseable, or non-finite stored
 * value falls back to the readable minimum.
 */
export function parseStoredDetailWidth(
  raw: string | null,
  maxPx: number,
): number {
  const parsed = raw == null ? Number.NaN : Number(raw);
  return clampDetailWidth(
    Number.isFinite(parsed) ? parsed : DETAIL_MIN_PX,
    maxPx,
  );
}
