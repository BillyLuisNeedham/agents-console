/**
 * Pool projection seam: pure mapping from the pool server's snapshot payload
 * (the same full state the SSE stream serves) to the view model the DOM layer
 * renders. No network calls, no DOM: fixtures in, view model out.
 */

import { marked } from "marked";
import type { Point, TopologyEdge } from "./geometry";
import type {
  AssignmentView,
  ConversationStatus,
  ConversationView,
  EnrichedSnapshot,
  EnrichedTicketState,
  Interrupt,
  Outcome,
  QueuedAnswer,
  ResumeAction,
  RunPhase,
  StartConversationRequest,
  TicketActivityResponse,
  TicketEvent,
  TicketEventsResponse,
  TicketGradeSummary,
  TicketStatus,
  TurnSide,
} from "../../engine/wire.ts";

// ---------------------------------------------------------------------------
// Wire shapes (CONTEXT.md: Wire shape): declared once in the engine's wire
// module and type-imported here, so drift between engine and Console is a
// compile error. Re-exported so the rest of the UI keeps one import site.
// ---------------------------------------------------------------------------

export type {
  AssignmentView,
  ConversationStatus,
  ConversationView,
  EnrichedSnapshot,
  EnrichedTicketState,
  InterruptKind,
  QueuedAnswer,
  ResumeAction,
  RunPhase,
  StartConversationRequest,
  TerminalPeekResponse,
  TicketActivityResponse,
  TicketBodyResponse,
  TicketEvent,
  TicketEventKind,
  TicketEventsResponse,
  TicketGradeSummary,
  TicketLogResponse,
  TicketStatus,
  TurnSide,
} from "../../engine/wire.ts";

/** The snapshot's state slice, as the projections take it. */
type PoolState = EnrichedSnapshot["state"];

/** A Conversation's Turn as the wire carries it on its view. */
type ConversationTurn = ConversationView["turn"];

// ---------------------------------------------------------------------------
// Interrupt forms: one form shape across the interrupt kinds, with a
// kind-specific title and action set. Pure config over the interrupt; the
// DOM layer renders it. The engine appends the note to the Issue file on
// every answer path, so every form carries the note field.
// ---------------------------------------------------------------------------

interface InterruptFormAction {
  action: ResumeAction;
  label: string;
  tone: "primary" | "danger";
}

interface InterruptFormView {
  title: string;
  actions: InterruptFormAction[];
  notePlaceholder?: string;
}

/** An interrupt with its form attached, as projected onto a card or Detail. */
export interface InterruptView extends Interrupt {
  form: InterruptFormView;
  /** True while an accepted answer waits for processing: answered-and-waiting. */
  queued: boolean;
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
  selection: {
    title: "human selection",
    actions: [RESUME],
    notePlaceholder: "the winning attempt's number",
  },
  review: {
    title: "review",
    actions: [APPROVE, REJECT],
    notePlaceholder:
      "approve: optional note · reject: name the tickets to send back",
  },
};

/**
 * The form for an interrupt. An unknown kind (an engine newer than this
 * build) falls back to a plain resume form so it never renders an
 * unanswerable interrupt.
 */
function interruptForm(interrupt: Interrupt): InterruptFormView {
  return INTERRUPT_FORMS[interrupt.kind] ?? { title: interrupt.kind, actions: [RESUME] };
}

/** The Turn state badge's word: "waiting on you" outranks "agent working" as
 *  the operator's cue, matching the Conversations tray's own wording. Shared
 *  by the Conversation card and its Detail. */
export function conversationTurnLabel(state: TurnSide): string {
  return state === "waiting" ? "waiting on you" : "agent working";
}

/** The word an unassigned Assignment (or one of its null fields) reads as. */
export const UNASSIGNED_LABEL = "unassigned";

// ---------------------------------------------------------------------------
// Timeline view model
// ---------------------------------------------------------------------------

/** A grade as the timeline shows it under its attempt's graded event: the
 *  full payload, reasons included. The card's TicketGradeSummary is the
 *  summary shape; this is the record. */
export interface TimelineGradeView {
  score: number;
  verdict: string;
  reasons: string;
}

/**
 * One timeline row, fully decoded: the renderer reads `timeLabel`, `grade`
 * and `reassignment` straight off the row and never parses a payload. The
 * grade and reassignment are null unless the event's kind carries one and
 * its payload decoded cleanly.
 */
interface TimelineEventView {
  kind: string;
  at: string;
  timeLabel: string;
  grade: TimelineGradeView | null;
  reassignment: string | null;
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour12: false });
}

/** The graded event's payload as a grade, or null when a field is missing or
 *  mistyped. The engine writes all three fields, so a null here means a torn
 *  or foreign line, and the timeline falls back to the plain event row. */
function gradeFromPayload(payload: Record<string, unknown>): TimelineGradeView | null {
  const { score, verdict, reasons } = payload;
  if (
    typeof score !== "number" ||
    typeof verdict !== "string" ||
    typeof reasons !== "string"
  ) {
    return null;
  }
  return { score, verdict, reasons };
}

// A config reload's `reassigned` event (ADR-0018), as one readable line: "harness
// / model → harness / model". A field the config leaves unassigned reads as
// "unassigned", matching how the card badge reads a null Assignment field.
// Anything not shaped like a from/to Assignment record (a foreign or torn
// line) decodes to null — never throws, so an event kind this build does not
// fully understand still shows its timestamp instead of breaking the timeline.
function reassignmentFromPayload(payload: Record<string, unknown>): string | null {
  const describe = (side: unknown): string | null => {
    if (typeof side !== "object" || side === null) return null;
    const { harness, model } = side as Record<string, unknown>;
    if (harness !== null && typeof harness !== "string") return null;
    if (model !== null && typeof model !== "string") return null;
    return `${harness ?? UNASSIGNED_LABEL} / ${model ?? UNASSIGNED_LABEL}`;
  };
  const from = describe(payload.from);
  const to = describe(payload.to);
  if (from === null || to === null) return null;
  return `reassigned: ${from} → ${to}`;
}

/** One raw event decoded into its timeline row. */
function decodeTimelineEvent(event: TicketEvent): TimelineEventView {
  return {
    kind: event.kind,
    at: event.at,
    timeLabel: formatEventTime(event.at),
    grade: event.kind === "graded" ? gradeFromPayload(event.payload) : null,
    reassignment:
      event.kind === "reassigned" ? reassignmentFromPayload(event.payload) : null,
  };
}

interface TimelineAttemptView {
  number: number;
  events: TimelineEventView[];
  reconstructed: boolean;
  running: boolean;
  logFile: string | null;
  /**
   * The attempt's Stream file, joined from the log pane's attempt listing
   * (see `joinStreamFiles`); null until a listing lands, and for an attempt
   * that has no Stream file on disk.
   */
  streamFile: string | null;
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
  status: TicketStatus,
): TimelineView {
  if (response.events.length > 0) {
    const byAttempt = new Map<number, TimelineEventView[]>();
    for (const event of response.events) {
      const list = byAttempt.get(event.attempt) ?? [];
      list.push(decodeTimelineEvent(event));
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
        streamFile: null,
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
    streamFile: null,
  }));
  return { attempts, reconstructed: response.reconstructed };
}

/**
 * The timeline with each attempt's Stream file joined in from the log pane's
 * attempt listing: the per-attempt listing the /api/log response has always
 * carried and the UI discarded. The join is by attempt number, so a stream
 * link surfaces only where the server found a Stream file on disk; an
 * attempt with none (a raw harness such as opencode, or a pre-streaming
 * attempt) keeps null and the Detail renders no link rather than a dead one.
 * A null listing (the pane has not answered yet) leaves the timeline as it
 * is; the next listing re-joins on the same pure rule.
 */
export function joinStreamFiles(
  timeline: TimelineView,
  listing: { attempt: number; streamFile: string | null }[] | null,
): TimelineView {
  if (!listing) return timeline;
  const streamByAttempt = new Map(
    listing.map((row) => [row.attempt, row.streamFile] as const),
  );
  return {
    ...timeline,
    attempts: timeline.attempts.map((row) => ({
      ...row,
      streamFile: streamByAttempt.get(row.number) ?? null,
    })),
  };
}

// An attempt is live only while its last recorded event has not yet ended
// it: the harness was spawned (or is about to be) and has not exited or
// crashed. A crashed attempt stays in-progress on the marker, but it is not
// running.
const LIVE_LAST_KINDS = new Set(["scheduled", "spawned", "resolver"]);

function runningAttempt(
  numbers: number[],
  byAttempt: Map<number, TimelineEventView[]>,
  status: TicketStatus,
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
  /**
   * Whether the pane shows the attempt's Stream file (the raw stream tee)
   * rather than its derived log; the pane head labels the difference.
   */
  stream: boolean;
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
  log: {
    stream: boolean;
    content: string;
    firstOffset: number;
    offset: number;
    totalSize: number;
  } | null,
  error: string | null,
): LogPaneView | null {
  if (!timeline) return null;
  const hasAttempts = timeline.attempts.length > 0;
  if (!hasAttempts) {
    return {
      selectedAttempt: null,
      stream: false,
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
  const loaded = log ?? {
    stream: false,
    content: "",
    firstOffset: 0,
    offset: 0,
    totalSize: 0,
  };
  return {
    selectedAttempt,
    stream: loaded.stream,
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
const LOG_TAIL_BYTES = 64 * 1024;

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
const LOG_BOTTOM_SLACK_PX = 24;

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
// Vitals: the card footer's liveness readout (ADR 0011)
// ---------------------------------------------------------------------------

/** Under this age the staleness readout counts as fresh movement. */
const VITALS_FRESH_MS = 10_000;
/** Silence past this age reads as idle, in the interrupt color. */
const VITALS_IDLE_MS = 60_000;
/** The sparkline holds at most this many per-poll diff-total samples. */
export const VITALS_MAX_SAMPLES = 40;

export type VitalsMode = "live" | "frozen";

export interface VitalsDiffView {
  added: number;
  removed: number;
  fileCount: number;
}

export interface VitalsStalenessView {
  kind: "changed" | "output" | "idle";
  /** Under VITALS_FRESH_MS the readout reads as moving. */
  fresh: boolean;
  copy: string;
}

export interface VitalsView {
  mode: VitalsMode;
  /** Totals for the `+a −r · N files` readout; null reads "no changes yet". */
  diff: VitalsDiffView | null;
  staleness: VitalsStalenessView | null;
  /** Diff total per poll, oldest first, capped at VITALS_MAX_SAMPLES. */
  samples: number[];
}

/** One ticket's held vitals: the latest activity payload and its samples. */
export interface VitalsState {
  activity: TicketActivityResponse;
  samples: number[];
}

function vitalsAgoCopy(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

function vitalsIdleCopy(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/**
 * The next sparkline sample list: one push per poll of the activity endpoint,
 * capped at the last VITALS_MAX_SAMPLES samples (~80s at the 2s cadence).
 * Pure; the store holds the list between polls.
 */
export function pushVitalsSample(samples: number[], total: number): number[] {
  const next = [...samples, total];
  return next.length > VITALS_MAX_SAMPLES
    ? next.slice(next.length - VITALS_MAX_SAMPLES)
    : next;
}

/**
 * A card's vitals view from (activity payload, ticket status, now): live on
 * an attempt that is running, including a resolver in flight on a
 * checkpointed merge (which the response's running flag already means),
 * frozen on a checkpoint whose latest response says nothing is live, and
 * hidden for done and ready tickets, for an in-progress ticket that is not
 * running (a crashed attempt parked at in-progress is not live work), and
 * whenever no payload has arrived: the no-empty-flash rule.
 */
export function projectVitals(
  input: VitalsState | null,
  status: TicketStatus,
  now: number,
): VitalsView | null {
  if (!input) return null;
  if (status === "done" || status === "ready") return null;
  const live = input.activity.running;
  if (status === "in-progress" && !live) return null;
  const diff = input.activity.diff;
  return {
    mode: live ? "live" : "frozen",
    diff:
      diff && diff.added + diff.removed > 0
        ? { added: diff.added, removed: diff.removed, fileCount: diff.files.length }
        : null,
    staleness: projectStaleness(input.activity, now, live ? "live" : "frozen"),
    samples: input.samples,
  };
}

/**
 * The staleness readout, anchored to the newest observable moment: the
 * ticket's last engine event ("changed") or the attempt log's last write
 * ("output"). Past VITALS_IDLE_MS of silence a live readout goes
 * `idle Xm Ys`; a frozen one keeps its `paused ·` copy and never idles,
 * since a paused card is waiting on the operator, not a stuck agent.
 */
function projectStaleness(
  activity: TicketActivityResponse,
  now: number,
  mode: VitalsMode,
): VitalsStalenessView | null {
  const anchors: { at: number; kind: "changed" | "output" }[] = [];
  const eventAt = activity.lastEventAt
    ? Date.parse(activity.lastEventAt)
    : Number.NaN;
  if (!Number.isNaN(eventAt)) anchors.push({ at: eventAt, kind: "changed" });
  const logAt = activity.log ? Date.parse(activity.log.mtime) : Number.NaN;
  if (!Number.isNaN(logAt)) anchors.push({ at: logAt, kind: "output" });
  if (anchors.length === 0) return null;
  anchors.sort((a, b) => b.at - a.at);
  const newest = anchors[0];
  const age = now - newest.at;
  if (mode === "frozen") {
    return {
      kind: newest.kind,
      fresh: false,
      copy: `paused · ${newest.kind} ${vitalsAgoCopy(age)}`,
    };
  }
  if (age > VITALS_IDLE_MS) {
    return { kind: "idle", fresh: false, copy: `idle ${vitalsIdleCopy(age)}` };
  }
  return {
    kind: newest.kind,
    fresh: age < VITALS_FRESH_MS,
    copy: `${newest.kind} ${vitalsAgoCopy(age)}`,
  };
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface TicketCardView {
  kind: "ticket";
  id: string;
  ticketId: string;
  title: string;
  blockedBy: string[];
  /** Blockers sitting at checkpoint with a pending interrupt: the stall is
   *  the operator's to clear. Empty unless this ticket is still waiting. */
  blockedByCheckpoint: string[];
  status: TicketStatus;
  /** Done with its branch still unmerged: the card's state word reads
   *  "done, merge pending". Derived server-side; the card only shows it. */
  mergePending: boolean;
  /** The ticket's resolved Assignment (ADR-0013), rendered verbatim. */
  assignment: AssignmentView;
  outcome: Outcome | null;
  interrupt: InterruptView | null;
  /** The ticket's latest grade, for the card summary. Null when ungraded:
   *  no grade UI renders at all, so there is no empty state. */
  grade: TicketGradeSummary | null;
  /** The Vitals footer's view data. Null whenever nothing should render:
   *  done or ready tickets, a crashed attempt parked at in-progress, or no
   *  activity payload yet (no empty flash before the first data lands). */
  vitals: VitalsView | null;
  /**
   * The current attempt's herdr pane id (ADR-0014), for the card's terminal
   * surface. Null for headless attempts and headless pools.
   */
  paneId: string | null;
  /**
   * The card's terminal surface: the peek viewport, "Open in herdr", and the
   * attach chip. Present exactly while the attempt is terminal-backed and
   * running (the snapshot carries its paneId); null for headless and
   * finished cards, which stay untouched.
   */
  terminal: TerminalSurfaceView | null;
  x: number;
  y: number;
}

export type TerminalSurfaceStatus = "pending" | "live" | "waiting" | "unavailable";

/**
 * The terminal surface's view data: the read-only peek of the attempt pane
 * plus the transient "Open in herdr" confirmation. `pending` is the state
 * before the first peek answers (the surface shell already renders, in its
 * "waiting for output" body); `waiting` is an answered-but-empty read (a
 * background tab still warming up), never an error; `unavailable` is a
 * missing or unreadable pane, which also disables the focus button.
 */
export interface TerminalSurfaceView {
  paneId: string;
  status: TerminalSurfaceStatus;
  /** The latest peek text; meaningful only while `status` is "live". */
  text: string;
  /** True briefly after "Open in herdr" succeeded: the card's confirmation. */
  justFocused: boolean;
}

export interface UtilityCardView {
  kind: "utility";
  id: string;
  label: string;
  interrupt: InterruptView | null;
  x: number;
  y: number;
}

/** The End action's in-flight/failure state for one Conversation, shared by
 *  the card and Detail (both call the same seam). */
export interface ConversationEndView {
  ending: boolean;
  failure: string | null;
}

export interface ConversationCardView {
  kind: "conversation";
  id: string;
  conversationId: string;
  title: string;
  status: ConversationStatus;
  spawnedBy: string | null;
  assignment: AssignmentView;
  paneId: string | null;
  branch: string | null;
  turn: ConversationTurn;
  /** "4m", "1h 12m"; null while the Turn state is `working` (no idleSince). */
  idleAge: string | null;
  /** The card's terminal surface, reused from ticket cards; present while
   *  the Conversation is live and carries a pane id. */
  terminal: TerminalSurfaceView | null;
  endView: ConversationEndView;
  x: number;
  y: number;
}

export type PoolCardView = TicketCardView | UtilityCardView | ConversationCardView;

export interface PoolView {
  seq: number;
  phase: RunPhase;
  cards: PoolCardView[];
  edges: TopologyEdge[];
  log: string[];
}

// ---------------------------------------------------------------------------
// Pool projection
// ---------------------------------------------------------------------------

const START_CARD_ID = "START";
const REVIEW_CARD_ID = "REVIEW";
const TICKET_PREFIX = "ticket:";
const CONVERSATION_PREFIX = "conversation:";

function ticketCardId(ticketId: string): string {
  return `${TICKET_PREFIX}${ticketId}`;
}

function conversationCardId(conversationId: string): string {
  return `${CONVERSATION_PREFIX}${conversationId}`;
}

/**
 * Default layout metrics. Cards are content-sized (no CSS height), so a row's
 * pitch has to leave room for the tallest card it can hold. Measured against
 * the stylesheet at the 280px card width: a headless ticket card is ~116px
 * (~160px with Vitals and a grade line), a terminal-backed ticket card ~255px,
 * and a live Conversation card ~285px (~325px with a two-line title and an
 * idle row). `rowH` fits the headless case; `terminalRowH` a row holding a
 * pane-backed ticket; `conversationLaneH` the Conversations lane, whose live
 * cards always carry a pane.
 */
const LAYOUT = {
  centerX: 420,
  startY: 16,
  rowH: 200,
  terminalRowH: 340,
  conversationLaneH: 380,
  colGap: 320,
  reviewY: 1200,
} as const;

/** Depth of a ticket = length of its longest blocker chain; leaf tickets are 0. */
function ticketDepth(
  ticketId: string,
  tickets: EnrichedTicketState[],
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

/**
 * Default positions: START above, the Conversations lane (if any) directly
 * below it, tickets layered by dependency depth below that, REVIEW below the
 * last layer (never above its fixed spot). Conversations exist beside
 * tickets, not in the dependency graph, so they lay out as one row, centered
 * like a ticket depth-0 row; their presence pushes every ticket row down by
 * the lane's height, so the lane never overlaps the ticket layers.
 *
 * Each ticket row's pitch is the tallest card it can hold: `terminalRowH`
 * while any ticket in it runs a pane-backed attempt (the card then carries
 * the terminal surface), `rowH` otherwise. A headless pool therefore keeps
 * the plain `rowH` grid throughout. The pitch follows the snapshot, so rows
 * below a row settle back up once its attempts end; dragged positions are
 * stored separately and never touched by this.
 */
function layoutPool(
  tickets: EnrichedTicketState[],
  conversations: ConversationView[] = [],
  startId: string = START_CARD_ID,
  reviewId: string = REVIEW_CARD_ID,
): Record<string, Point> {
  const positions: Record<string, Point> = {};
  positions[startId] = { x: LAYOUT.centerX, y: LAYOUT.startY };

  const hasConversations = conversations.length > 0;
  if (hasConversations) {
    const offset = ((conversations.length - 1) * LAYOUT.colGap) / 2;
    conversations.forEach((conversation, index) => {
      positions[conversationCardId(conversation.id)] = {
        x: LAYOUT.centerX - offset + index * LAYOUT.colGap,
        y: LAYOUT.startY + LAYOUT.rowH,
      };
    });
  }
  const ticketBaseY =
    LAYOUT.startY + LAYOUT.rowH + (hasConversations ? LAYOUT.conversationLaneH : 0);

  const byDepth = new Map<number, EnrichedTicketState[]>();
  let maxDepth = -1;
  for (const ticket of tickets) {
    const depth = ticketDepth(ticket.id, tickets);
    const row = byDepth.get(depth) ?? [];
    row.push(ticket);
    byDepth.set(depth, row);
    maxDepth = Math.max(maxDepth, depth);
  }
  // Rows stack top-down, each starting where the previous one's pitch ends.
  let rowY = ticketBaseY;
  for (let depth = 0; depth <= maxDepth; depth++) {
    const row = byDepth.get(depth) ?? [];
    const offset = ((row.length - 1) * LAYOUT.colGap) / 2;
    row.forEach((ticket, index) => {
      positions[ticketCardId(ticket.id)] = {
        x: LAYOUT.centerX - offset + index * LAYOUT.colGap,
        y: rowY,
      };
    });
    rowY += rowPitch(row);
  }
  positions[reviewId] = { x: LAYOUT.centerX, y: Math.max(LAYOUT.reviewY, rowY) };
  return positions;
}

/** A ticket row's vertical pitch: taller while any of its tickets runs a pane-backed attempt. */
function rowPitch(row: EnrichedTicketState[]): number {
  return row.some((ticket) => typeof ticket.liveAttempt?.paneId === "string")
    ? LAYOUT.terminalRowH
    : LAYOUT.rowH;
}

function projectPoolEdges(
  tickets: EnrichedTicketState[],
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

/**
 * Edges from a Conversation card to what it spawned: the ids in its
 * `children` (ADR-0018), each resolved against the pool's live tickets and
 * Conversations to the right prefix. A child id that names neither (a race
 * between the snapshot and the spawn, or a spawn that failed validation)
 * draws no edge rather than a dangling one.
 */
function projectConversationEdges(
  conversations: ConversationView[],
  tickets: EnrichedTicketState[],
): TopologyEdge[] {
  const ticketIds = new Set(tickets.map((t) => t.id));
  const conversationIds = new Set(conversations.map((c) => c.id));
  const edges: TopologyEdge[] = [];
  for (const conversation of conversations) {
    const source = conversationCardId(conversation.id);
    for (const childId of conversation.children) {
      if (ticketIds.has(childId)) {
        edges.push({ source, target: ticketCardId(childId) });
      } else if (conversationIds.has(childId)) {
        edges.push({ source, target: conversationCardId(childId) });
      }
    }
  }
  return edges;
}

/**
 * The blockers holding this ticket at a checkpoint with a pending interrupt:
 * the stall a human can clear, named so the card and Detail can surface it.
 * A ticket only waits on its blockers while it is still ready, and a blocker
 * only counts while its interrupt pends: once the checkpoint is answered and
 * the blocker completes, the dependent schedules and the notice disappears.
 * Visibility only: scheduling still requires done, and a checkpointed blocker
 * is never a deadlock.
 */
function checkpointBlockers(ticket: EnrichedTicketState, state: PoolState): string[] {
  if (ticket.status !== "ready") return [];
  return ticket.blockedBy.filter((blockerId) => {
    const blocker = state.tickets.find((t) => t.id === blockerId);
    return (
      blocker?.status === "checkpoint" &&
      state.interrupts.some((i) => i.ticketId === blockerId)
    );
  });
}

/** The notice the card and Detail share for a checkpoint-blocked ticket. */
export function checkpointNotice(blockers: string[]): string {
  const noun = blockers.length === 1 ? "ticket" : "tickets";
  return `blocked by checkpoint on ${noun} ${blockers.join(", ")} (waiting on you)`;
}

/** True when the queued answer is the accepted answer for this interrupt. */
function isAnswerQueued(
  answers: QueuedAnswer[],
  interrupt: Interrupt,
): boolean {
  return answers.some(
    (answer) =>
      answer.ticketId === interrupt.ticketId && answer.kind === interrupt.kind,
  );
}

function toInterruptView(raw: Interrupt | null, state: PoolState): InterruptView | null {
  if (!raw) return null;
  return {
    ...raw,
    form: interruptForm(raw),
    queued: isAnswerQueued(state.queuedAnswers, raw),
  };
}

/**
 * The card's terminal surface (ADR-0014): present exactly when the ticket's
 * current attempt is terminal-backed and running (the enriched snapshot's
 * live attempt carries its pane, and the record goes the moment the attempt
 * ends), so headless
 * and finished cards stay untouched. Before the first peek payload lands the
 * store holds no entry; the card still gets the surface, in its pending
 * "waiting for output" state, so there is no empty flash.
 */
function projectTerminalSurface(
  paneId: string | null,
  state: TerminalSurfaceView | undefined,
): TerminalSurfaceView | null {
  if (paneId === null) return null;
  return state ?? { paneId, status: "pending", text: "", justFocused: false };
}

function projectTicket(
  ticket: EnrichedTicketState,
  state: PoolState,
  pos: Point,
  grade: TicketGradeSummary | null,
  vitals: VitalsState | null,
  terminal: TerminalSurfaceView | undefined,
  now: number,
): TicketCardView {
  const raw = state.interrupts.find((i) => i.ticketId === ticket.id) ?? null;
  return {
    kind: "ticket",
    id: ticketCardId(ticket.id),
    ticketId: ticket.id,
    title: ticket.title,
    blockedBy: ticket.blockedBy,
    blockedByCheckpoint: checkpointBlockers(ticket, state),
    status: ticket.status,
    mergePending: ticket.mergePending,
    assignment: ticket.assignment,
    outcome: state.outcomes[ticket.id] ?? null,
    interrupt: toInterruptView(raw, state),
    grade,
    vitals: projectVitals(vitals, ticket.status, now),
    paneId: ticket.liveAttempt?.paneId ?? null,
    terminal: projectTerminalSurface(ticket.liveAttempt?.paneId ?? null, terminal),
    x: pos.x,
    y: pos.y,
  };
}

/**
 * The idle age readout ("4m", "1h 12m") from a Turn's `idleSince`: null while
 * the Turn is `working` (no idleSince yet) or the timestamp fails to parse.
 */
function conversationIdleAge(
  idleSince: string | null,
  now: number,
): string | null {
  if (!idleSince) return null;
  const at = Date.parse(idleSince);
  if (Number.isNaN(at)) return null;
  const s = Math.max(0, Math.floor((now - at) / 1000));
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s`;
  const h = Math.floor(m / 60);
  if (h < 1) return `${m}m`;
  return `${h}h ${m % 60}m`;
}

/** The End action's view for a Conversation id; the default before any End
 *  has ever been attempted this session. */
function projectConversationEnd(
  state: ConversationEndView | undefined,
): ConversationEndView {
  return state ?? { ending: false, failure: null };
}

function projectConversation(
  conversation: ConversationView,
  pos: Point,
  terminal: TerminalSurfaceView | undefined,
  endings: Record<string, ConversationEndView>,
  now: number,
): ConversationCardView {
  return {
    kind: "conversation",
    id: conversationCardId(conversation.id),
    conversationId: conversation.id,
    title: conversation.title,
    status: conversation.status,
    spawnedBy: conversation.spawnedBy,
    assignment: conversation.assignment,
    paneId: conversation.paneId,
    branch: conversation.branch,
    turn: conversation.turn,
    idleAge: conversationIdleAge(conversation.turn.idleSince, now),
    terminal: projectTerminalSurface(conversation.paneId, terminal),
    endView: projectConversationEnd(endings[conversation.id]),
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
    interrupt: toInterruptView(raw, state),
    x: pos.x,
    y: pos.y,
  };
}

export function projectPool(
  snapshot: EnrichedSnapshot,
  grades: Record<string, TicketGradeSummary> = {},
  vitals: Record<string, VitalsState> = {},
  terminal: Record<string, TerminalSurfaceView> = {},
  now: number = Date.now(),
  conversationEndings: Record<string, ConversationEndView> = {},
): PoolView {
  const tickets = snapshot.state.tickets;
  const conversations = snapshot.state.conversations;
  const positions = layoutPool(tickets, conversations);
  const cards: PoolCardView[] = [
    projectUtility(START_CARD_ID, "start", snapshot.state, positions[START_CARD_ID]),
    ...conversations.map((conversation) =>
      projectConversation(
        conversation,
        positions[conversationCardId(conversation.id)],
        terminal[conversation.id],
        conversationEndings,
        now,
      ),
    ),
    ...tickets.map((ticket) =>
      projectTicket(
        ticket,
        snapshot.state,
        positions[ticketCardId(ticket.id)],
        grades[ticket.id] ?? null,
        vitals[ticket.id] ?? null,
        terminal[ticket.id],
        now,
      ),
    ),
    projectUtility(REVIEW_CARD_ID, "review", snapshot.state, positions[REVIEW_CARD_ID]),
  ];
  return {
    seq: snapshot.seq,
    phase: snapshot.phase,
    cards,
    edges: [
      ...projectPoolEdges(tickets),
      ...projectConversationEdges(conversations, tickets),
    ],
    log: snapshot.state.log,
  };
}

// ---------------------------------------------------------------------------
// Conversations tray and Needs input rows
// ---------------------------------------------------------------------------

export interface ConversationTrayRow {
  id: string;
  cardId: string;
  title: string;
  status: ConversationStatus;
  turn: ConversationTurn;
  idleAge: string | null;
}

/**
 * The Conversations tray's rows: every live Conversation, sorted waiting-on-
 * you first, then longest idle (oldest idleSince first). A Conversation
 * `working` on a Turn has no idleSince and sorts after every waiting one,
 * and after every other working one (arrival order is as good as any).
 * Ended and crashed Conversations stay off the tray; they are done and read
 * from their card or Detail, not the operator's work queue.
 */
export function projectConversationsTray(
  conversations: ConversationView[],
  now: number = Date.now(),
): ConversationTrayRow[] {
  const rows = conversations
    .filter((c) => c.status === "live")
    .map((c) => ({
      id: c.id,
      cardId: conversationCardId(c.id),
      title: c.title,
      status: c.status,
      turn: c.turn,
      idleAge: conversationIdleAge(c.turn.idleSince, now),
    }));
  return rows.sort((a, b) => {
    const aWaiting = a.turn.state === "waiting" ? 0 : 1;
    const bWaiting = b.turn.state === "waiting" ? 0 : 1;
    if (aWaiting !== bWaiting) return aWaiting - bWaiting;
    const aIdle = a.turn.idleSince
      ? Date.parse(a.turn.idleSince)
      : Number.POSITIVE_INFINITY;
    const bIdle = b.turn.idleSince
      ? Date.parse(b.turn.idleSince)
      : Number.POSITIVE_INFINITY;
    return aIdle - bIdle;
  });
}

/** One row the Needs input tray gains for a Conversation waiting on the
 *  operator: no interrupt to answer, so no form; the row's action is
 *  opening the herdr pane, not an answer. */
export interface ConversationNeedsInputRow {
  cardId: string;
  conversationId: string;
  label: string;
  title: string;
}

/**
 * Needs input's Conversation rows: every live Conversation whose Turn state
 * is `waiting`, in Conversation order (the same order the lane and the tray
 * use). A Notice queued for delivery does not change this: the Conversation
 * only counts as needing the operator once its own Turn is waiting.
 */
export function projectConversationsNeedsInput(
  snapshot: EnrichedSnapshot,
): ConversationNeedsInputRow[] {
  const conversations = snapshot.state.conversations;
  return conversations
    .filter((c) => c.status === "live" && c.turn.state === "waiting")
    .map((c) => ({
      cardId: conversationCardId(c.id),
      conversationId: c.id,
      label: c.id,
      title: c.title,
    }));
}

/**
 * The pool's default Assignment, read from the snapshot's `config` for the
 * New Conversation form's placeholders (the same defaults `startConversation`
 * falls back to when the operator leaves a field blank). A guess at the
 * wire shape: `config.harness` / `config.model` / `config.drivers`, read
 * only when they are strings, so an older or differently-shaped config
 * degrades to no placeholder rather than a crash.
 */
export function poolAssignmentDefaults(
  config: Record<string, unknown>,
): NonNullable<StartConversationRequest["assign"]> {
  // The pool's console.json nests its Assignment defaults under `defaults`;
  // the form shows them as placeholders so a blank field means "pool default".
  const nested = config.defaults;
  const source: Record<string, unknown> =
    nested && typeof nested === "object" ? (nested as Record<string, unknown>) : {};
  const defaults: NonNullable<StartConversationRequest["assign"]> = {};
  if (typeof source.harness === "string") defaults.harness = source.harness;
  if (typeof source.model === "string") defaults.model = source.model;
  if (typeof source.drivers === "string") defaults.drivers = source.drivers;
  return defaults;
}

export function statusLabel(status: TicketStatus, mergePending = false): string {
  if (status === "done" && mergePending) return "done, merge pending";
  return status === "in-progress" ? "running" : status;
}

export function phaseLabel(phase: RunPhase): string {
  switch (phase) {
    case "running":
      return "running";
    case "quiescent":
      return "waiting on you";
    case "done":
      return "done";
    case "stalled":
      return "stalled";
    case "dead":
      return "dead";
  }
}

export interface PoolTabStatus {
  word: string;
  color: string;
}

/** The tab status colors, from the Console palette. The favicon's boot dot
 *  consumes the idle color before any snapshot lands. Dead shares the alarm
 *  red with needs input: its word carries the difference. */
export const POOL_TAB_COLORS = {
  needsInput: "#f85149",
  running: "#d29922",
  complete: "#3fb950",
  idle: "#8b949e",
  dead: "#f85149",
} as const;

/**
 * The pool's at-a-glance status for the browser tab, worst-first: a dead
 * phase is terminal and outranks everything (no answer can reach a dead
 * drive, so needs input would mislead); then a pending interrupt with no
 * queued answer or a stalled phase needs input; otherwise a running phase is
 * running, a done phase is complete, and anything else is idle. An interrupt
 * whose answer is already queued waits on the engine, not the operator, so
 * it stays out of needs input. Quiescent always carries a pending interrupt,
 * so it lands on needs input without a rule of its own. Colors come from the
 * Console palette; the tab title and the favicon both consume this value.
 */
export function poolStatus(snapshot: EnrichedSnapshot): PoolTabStatus {
  if (snapshot.phase === "dead") {
    return { word: "dead", color: POOL_TAB_COLORS.dead };
  }
  const unanswered = snapshot.state.interrupts.some(
    (interrupt) => !isAnswerQueued(snapshot.state.queuedAnswers, interrupt),
  );
  if (unanswered || snapshot.phase === "stalled") {
    return { word: "needs input", color: POOL_TAB_COLORS.needsInput };
  }
  if (snapshot.phase === "running") {
    return { word: "running", color: POOL_TAB_COLORS.running };
  }
  if (snapshot.phase === "done") {
    return { word: "complete", color: POOL_TAB_COLORS.complete };
  }
  return { word: "idle", color: POOL_TAB_COLORS.idle };
}

// ---------------------------------------------------------------------------
// Detail content
// ---------------------------------------------------------------------------

export interface TicketDetailView {
  kind: "ticket";
  ticketId: string;
  title: string;
  status: TicketStatus;
  /** Mirrors the card's: done with its branch still unmerged. */
  mergePending: boolean;
  blockedBy: string[];
  blockedByCheckpoint: string[];
  outcome: Outcome | null;
  interrupt: InterruptView | null;
  /** The winning attempt's number from the grades endpoint, for the
   *  timeline's winner badge. Null when the ticket is ungraded or no
   *  selection has landed: no badge renders. */
  winner: number | null;
}

interface UtilityDetailView {
  kind: "utility";
  id: string;
  label: string;
  interrupt: InterruptView | null;
}

/** The Conversation Detail: the card's facts at full size, for the terminal
 *  peek, timeline, and End form the Detail renders around them. */
export interface ConversationDetailView {
  kind: "conversation";
  conversationId: string;
  title: string;
  status: ConversationStatus;
  spawnedBy: string | null;
  assignment: AssignmentView;
  paneId: string | null;
  branch: string | null;
  turn: ConversationTurn;
  idleAge: string | null;
  terminal: TerminalSurfaceView | null;
  endView: ConversationEndView;
}

export type DetailView = TicketDetailView | UtilityDetailView | ConversationDetailView;

/**
 * The Detail for a selected card, read off the pool's already-projected
 * cards: the caller derives the cards once per cycle and passes them in, so
 * the Detail and the canvas never disagree about the same snapshot. Null
 * when the card is not in the pool.
 */
export function projectDetail(
  cards: PoolCardView[],
  cardId: string,
): DetailView | null {
  const card = cards.find((c) => c.id === cardId);
  if (!card) return null;
  if (card.kind === "ticket") {
    return {
      kind: "ticket",
      ticketId: card.ticketId,
      title: card.title,
      status: card.status,
      mergePending: card.mergePending,
      blockedBy: card.blockedBy,
      blockedByCheckpoint: card.blockedByCheckpoint,
      outcome: card.outcome,
      interrupt: card.interrupt,
      winner: card.grade?.winner ?? null,
    };
  }
  if (card.kind === "conversation") {
    return {
      kind: "conversation",
      conversationId: card.conversationId,
      title: card.title,
      status: card.status,
      spawnedBy: card.spawnedBy,
      assignment: card.assignment,
      paneId: card.paneId,
      branch: card.branch,
      turn: card.turn,
      idleAge: card.idleAge,
      terminal: card.terminal,
      endView: card.endView,
    };
  }
  return { kind: "utility", id: card.id, label: card.label, interrupt: card.interrupt };
}

// ---------------------------------------------------------------------------
// Needs input tray
// ---------------------------------------------------------------------------

/**
 * One row of the Needs input tray: a pending Interrupt with the card it
 * selects, projected in card order. `ticketId` is who the interrupt is
 * raised against (the answer and note-draft key); `label` is what the row
 * shows (the ticket id, or the utility card's label for the final Review).
 */
export interface NeedsInputRow {
  cardId: string;
  ticketId: string;
  label: string;
  /** The ticket's title; null for a utility row. */
  title: string | null;
  interrupt: InterruptView;
}

/**
 * The Needs input tray's rows: one per card holding an unresolved Interrupt,
 * in card order, so the tray and the canvas agree. Each interrupt carries
 * its form (the shared interrupt-form config, unknown kinds falling back to
 * a plain resume form) and its queued flag, exactly as the cards project it.
 * A pure projection of the snapshot: no new data source, the tray reads what
 * the cards read.
 */
export function projectNeedsInput(snapshot: EnrichedSnapshot): NeedsInputRow[] {
  const rows: NeedsInputRow[] = [];
  for (const card of projectPool(snapshot).cards) {
    if (card.kind === "conversation") continue;
    if (!card.interrupt) continue;
    rows.push(
      card.kind === "ticket"
        ? {
            cardId: card.id,
            ticketId: card.ticketId,
            label: card.ticketId,
            title: card.title,
            interrupt: card.interrupt,
          }
        : {
            cardId: card.id,
            ticketId: card.interrupt.ticketId,
            label: card.label,
            title: null,
            interrupt: card.interrupt,
          },
    );
  }
  return rows;
}

/**
 * True when a row's interrupt form is the single-action resume shape the
 * tray's bulk action covers: the resume kinds (checkpoint, crash, deadlock,
 * merge-conflict) and an unknown kind's plain resume fallback. Review and
 * merge-approval rows carry two actions and are answered individually.
 */
function isResumeKindRow(row: NeedsInputRow): boolean {
  return (
    row.interrupt.form.actions.length === 1 &&
    row.interrupt.form.actions[0].action === "resume"
  );
}

/**
 * The rows the tray's "resume all" fires: the open (not yet
 * answered-and-waiting) resume-kind rows, in row order. Rows whose answer is
 * already queued, and rows the operator answers individually (review and
 * merge-approval), stay out of the bulk fire and out of its count.
 */
export function bulkResumeRows(rows: NeedsInputRow[]): NeedsInputRow[] {
  return rows.filter((row) => !row.interrupt.queued && isResumeKindRow(row));
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
function defaultDetailTab(
  status: TicketStatus,
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
function projectDetailTab(
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
// Drawers height clamp
// ---------------------------------------------------------------------------

const DRAWER_MIN_VH = 15;
const DRAWER_MAX_VH = 80;
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
