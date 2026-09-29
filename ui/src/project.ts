/**
 * Pool projection seam: pure mapping from the pool server's snapshot payload
 * (the same full state the SSE stream serves) to the view model the DOM layer
 * renders. No network calls, no DOM: fixtures in, view model out.
 */

import { marked } from "marked";
import type { Point, TopologyEdge } from "./geometry";
import type {
  AssignmentSources,
  AssignmentView,
  ConversationStatus,
  ConversationView,
  EnlistPane,
  EnrichedSnapshot,
  EnrichedTicketState,
  Grade,
  HeldPaneRecord,
  HeldSpawnReason,
  HeldSpawnView,
  Interrupt,
  LiveAttemptRecord,
  MergeQueueEntry,
  MergeQueueState,
  Outcome,
  PoolConfig,
  QueuedAnswer,
  ResumeAction,
  RunPhase,
  StartConversationRequest,
  TicketReassignView,
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
  AssignmentSource,
  AssignmentSources,
  AssignmentView,
  CloseFinishedTerminalsResponse,
  ConversationStatus,
  ConversationView,
  EnlistPane,
  EnlistRequest,
  EnlistResponse,
  EnrichedSnapshot,
  EnrichedTicketState,
  Grade,
  HeldPaneRecord,
  HeldSpawnReason,
  HeldSpawnResponse,
  HeldSpawnView,
  InterruptKind,
  KeepTalkingRequest,
  KeepTalkingResponse,
  MachineDefaults,
  MachineDefaultsView,
  MergeQueueEntry,
  MergeQueueState,
  PanesResponse,
  PoolConfig,
  PoolSettingsView,
  QueuedAnswer,
  ReassignRequest,
  ReassignResponse,
  RestartResponse,
  ResumeAction,
  RunPhase,
  SettingsResponse,
  StartConversationRequest,
  TerminalPeekResponse,
  TicketActivityResponse,
  TicketBodyResponse,
  TicketEvent,
  TicketEventKind,
  TicketEventsResponse,
  TicketGradeSummary,
  TicketLogResponse,
  TicketReassignView,
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
  /**
   * Keep talking (issue #139), offered beside Resume only on an open
   * checkpoint whose ticket still has its Held pane: the operator carries
   * on the checkpointed Attempt's conversation in the same terminal rather
   * than resuming into a fresh Attempt. Null wherever it is not offered:
   * every other kind, a headless or closed pane, and an answer already
   * queued. It is not one of the form's actions because it is not an
   * answer: it never queues for the boundary, so the tray's "resume all"
   * never fires it.
   */
  keepTalking: KeepTalkingView | null;
}

/**
 * Keep talking's per-ticket request state (issue #139), held by the session
 * for the one Held pane it was asked of: `attempt` is that pane's Attempt,
 * so a mark left over from an earlier checkpoint never greys or annotates a
 * later one's button. `requesting` stays set after the engine accepts,
 * because the ticket only leaves checkpoint when the next snapshot says so,
 * and a second click in that gap would ask the engine for a pane it has
 * already claimed.
 */
export interface KeepTalkingState {
  attempt: number;
  requesting: boolean;
  failure: string | null;
}

/** The Keep talking button as the Detail and the Needs input tray draw it:
 *  disabled while `requesting`, with a refusal's reason beside it. */
export interface KeepTalkingView {
  requesting: boolean;
  failure: string | null;
}

const RESUME: InterruptFormAction = { action: "resume", label: "resume", tone: "primary" };
const APPROVE: InterruptFormAction = { action: "approve", label: "approve", tone: "primary" };
const REJECT: InterruptFormAction = { action: "reject", label: "reject", tone: "danger" };

const INTERRUPT_FORMS: Record<string, InterruptFormView> = {
  checkpoint: { title: "checkpoint", actions: [RESUME] },
  config: { title: "pool config", actions: [RESUME] },
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
 *  full payload, reasons and provenance included. The same wire shape the
 *  engine declares once (wire.ts's Grade); the card's TicketGradeSummary is
 *  the summary shape, this is the record. */
export type TimelineGradeView = Grade;

/**
 * One timeline row, fully decoded: the renderer reads `timeLabel`, `grade`,
 * `reassignment` and `spawn` straight off the row and never parses a
 * payload. Each is null unless the event's kind carries one and its payload
 * decoded cleanly.
 */
interface TimelineEventView {
  kind: string;
  at: string;
  timeLabel: string;
  grade: TimelineGradeView | null;
  reassignment: string | null;
  /** A spawn-held, spawn-adopted or spawn-discarded event as one line
   *  (issue #149); null on every other kind. */
  spawn: string | null;
  /** The files a merge-conflict, merge-blocked or resolver event names;
   *  null on every other kind, and on a payload without a string list. */
  files: string[] | null;
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour12: false });
}

/** The graded event's payload as a grade, or null when a field is missing or
 *  mistyped. The engine writes the three core fields always and the three
 *  provenance fields on a Jev Grade (ADR-0023), so a null here means a torn
 *  or foreign line, and the timeline falls back to the plain event row. A
 *  provenance field that is missing or mistyped is simply left off; the core
 *  three decide whether the row is a grade at all. */
function gradeFromPayload(payload: Record<string, unknown>): TimelineGradeView | null {
  const { score, verdict, reasons, rubric, model, evidenceBudget } = payload;
  if (
    typeof score !== "number" ||
    typeof verdict !== "string" ||
    typeof reasons !== "string"
  ) {
    return null;
  }
  if (verdict !== "pass" && verdict !== "flag") return null;
  const grade: TimelineGradeView = { score, verdict, reasons };
  if (typeof rubric === "string") grade.rubric = rubric;
  if (typeof model === "string") grade.model = model;
  if (evidenceBudget === "base" || evidenceBudget === "widened") {
    grade.evidenceBudget = evidenceBudget;
  }
  return grade;
}

// A config reload's `reassigned` event (ADR-0018), as one readable line: "harness
// / model → harness / model". A field the config leaves unassigned reads as
// "unassigned", matching how the card badge reads a null Assignment field; an
// effort, optional by nature, is named only on a side that has one.
// Anything not shaped like a from/to Assignment record (a foreign or torn
// line) decodes to null — never throws, so an event kind this build does not
// fully understand still shows its timestamp instead of breaking the timeline.
function reassignmentFromPayload(payload: Record<string, unknown>): string | null {
  const describe = (side: unknown): string | null => {
    if (typeof side !== "object" || side === null) return null;
    const { harness, model, effort } = side as Record<string, unknown>;
    if (harness !== null && typeof harness !== "string") return null;
    if (model !== null && typeof model !== "string") return null;
    const named = typeof effort === "string" && effort ? ` / effort ${effort}` : "";
    return `${harness ?? UNASSIGNED_LABEL} / ${model ?? UNASSIGNED_LABEL}${named}`;
  };
  const from = describe(payload.from);
  const to = describe(payload.to);
  if (from === null || to === null) return null;
  return `reassigned: ${from} → ${to}`;
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

// The Held spawn events (issue #149, ADR-0029), each as one readable line:
// "2 spawns held (per-run cap): 'A', 'B'", "adopted 03-spawn-1 from held-1
// · 03-spawn-1 blocks 04, 05", "held spawn 'A' discarded". A pre-ADR
// adoption carries a `truncated` count instead of holding, and says so. Like
// the reassignment line, a payload of the wrong shape decodes to null.
function spawnFromPayload(kind: string, payload: Record<string, unknown>): string | null {
  if (kind === "spawn-held") {
    const held = payload.held;
    if (!Array.isArray(held) || held.length === 0) return null;
    const titles: string[] = [];
    const reasons = new Set<string>();
    for (const entry of held) {
      if (typeof entry !== "object" || entry === null) return null;
      const { title, reason } = entry as Record<string, unknown>;
      if (typeof title !== "string") return null;
      if (reason !== "per-attempt" && reason !== "per-run") return null;
      titles.push(`'${title}'`);
      reasons.add(HELD_SPAWN_REASON[reason]);
    }
    const why = [...reasons].sort();
    if (payload.recovered === true) why.push("recovered at boot");
    const count = held.length === 1 ? "1 spawn" : `${held.length} spawns`;
    return `${count} held (${why.join(", ")}): ${titles.join(", ")}`;
  }
  if (kind === "spawn-adopted") {
    const { adopted, fromHeld, blocks, truncated } = payload;
    if (!isStringList(adopted)) return null;
    const parts = [
      `adopted ${adopted.length > 0 ? adopted.join(", ") : "none"}` +
        (typeof fromHeld === "string" ? ` from ${fromHeld}` : ""),
    ];
    if (typeof blocks === "object" && blocks !== null) {
      for (const [spawnId, targets] of Object.entries(blocks)) {
        if (isStringList(targets) && targets.length > 0) {
          parts.push(`${spawnId} blocks ${targets.join(", ")}`);
        }
      }
    }
    if (typeof truncated === "number" && truncated > 0) {
      parts.push(`${truncated} truncated by the cap`);
    }
    return parts.join(" · ");
  }
  if (kind === "spawn-discarded") {
    return typeof payload.title === "string"
      ? `held spawn '${payload.title}' discarded`
      : null;
  }
  return null;
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
    spawn: spawnFromPayload(event.kind, event.payload),
    files: FILE_EVENT_KINDS.has(event.kind) ? filesFromPayload(event.payload) : null,
  };
}

const FILE_EVENT_KINDS = new Set(["merge-conflict", "merge-blocked", "resolver"]);

function filesFromPayload(payload: Record<string, unknown>): string[] | null {
  const files = payload.files;
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) return null;
  return files;
}

/**
 * The conflicted files a resolver Attempt was handed (issue #129): read off
 * the resolver event of that Attempt in the ticket's timeline, the events
 * file's durable record. Empty until the timeline has loaded, and for an
 * Attempt that is not a resolver's.
 */
export function resolverFiles(timeline: TimelineView | null, attempt: number): string[] {
  const row = timeline?.attempts.find((a) => a.number === attempt);
  const event = row?.events.find((e) => e.kind === "resolver");
  return event?.files ?? [];
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
  /** How long a resolver on a done card has been running ("resolving 10m
   *  5s", issue #129); null for every other live Attempt. */
  elapsed: string | null;
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

/** The header's coarser duration: "45s", "10m", "1h 12m". */
function shortDurationCopy(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
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
 * whenever no payload has arrived: the no-empty-flash rule. The one done
 * ticket that shows them is one whose resolver the engine says is live
 * (issue #129): the footer then also says how long it has been running.
 */
export function projectVitals(
  input: VitalsState | null,
  status: TicketStatus,
  now: number,
  resolverStartedAt: string | null = null,
): VitalsView | null {
  if (!input) return null;
  if (status === "ready") return null;
  if (status === "done" && (resolverStartedAt === null || !input.activity.running)) return null;
  const live = input.activity.running;
  if (status === "in-progress" && !live) return null;
  const diff = input.activity.diff;
  const started = resolverStartedAt === null ? Number.NaN : Date.parse(resolverStartedAt);
  return {
    mode: live ? "live" : "frozen",
    elapsed: Number.isNaN(started) ? null : `resolving ${vitalsIdleCopy(now - started)}`,
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
  /** Where the ticket stands in the Merge queue (issue #129), null unless it
   *  is held: the card's state word names it. The engine's; the card only
   *  shows it. */
  mergeState: MergeQueueState | null;
  /** The resolver running on the ticket's conflicted merge, when the
   *  engine's live attempt is one; null for the Ticket's own agent. */
  resolver: ResolverView | null;
  /** The ticket's resolved Assignment (ADR-0013), rendered verbatim. */
  assignment: AssignmentView;
  /** The ticket was enlisted from a live herdr pane (issue #101): the badge
   *  reads "as found" where a spawned ticket names a model. */
  enlisted: boolean;
  /**
   * Reassign (issue #126): whether this ticket's assign entry can be
   * rewritten now, why not when it cannot, its own verify count, and where
   * each field of `assignment` came from. Display-only on the card; the
   * editor is the Detail's Reassign section and the Settings pane's bulk
   * dialog, and both read it from here through the Detail projection.
   */
  reassign: TicketReassignView;
  /** An Attempt is in flight. The card shows nothing new for it; the Detail
   *  uses it to say why a ticket is read-only rather than guessing. */
  hasLiveAttempt: boolean;
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
   * The ticket's herdr pane id (ADR-0014), for the card's terminal surface:
   * its Live attempt's, or its Held pane's while it waits at a checkpoint
   * (issue #139). Null for headless attempts and headless pools.
   */
  paneId: string | null;
  /**
   * The card's terminal surface: the peek viewport, "Open in herdr", and the
   * attach chip. Present exactly while the ticket has a pane (`paneId`):
   * a terminal-backed attempt running, or its Held pane waiting at a
   * checkpoint; null for headless and finished cards, which stay untouched.
   */
  terminal: TerminalSurfaceView | null;
  x: number;
  y: number;
}

/**
 * A live resolver Attempt as the card and the Detail show it (issue #129):
 * its number, its pane when terminal-backed (the "open resolver" jump), and
 * how long it has been running, ticked from the engine's start stamp.
 */
export interface ResolverView {
  attempt: number;
  paneId: string | null;
  startedAt: string;
  elapsed: string;
}

function projectResolver(live: LiveAttemptRecord | null, now: number): ResolverView | null {
  if (live?.role !== "resolver") return null;
  const started = Date.parse(live.startedAt);
  return {
    attempt: live.attempt,
    paneId: live.paneId,
    startedAt: live.startedAt,
    elapsed: Number.isNaN(started) ? "" : vitalsIdleCopy(now - started),
  };
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
  /** The Conversation was enlisted from a live herdr pane (issue #101): the
   *  badge reads "as found" where a started Conversation names a model. */
  enlisted: boolean;
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
  /** The canvas header's Merge queue line (issue #129); null with no hold. */
  mergeQueueLine: string | null;
  /** The canvas header's Spawn caps line (issue #149). */
  spawnLine: SpawnLineView;
  /** The Held spawns list the line opens (issue #149), oldest first. */
  heldSpawns: HeldSpawnRow[];
}

/**
 * The Spawn caps line (issue #149): "Spawns 3/20 this run · 5 per attempt",
 * with "· N held" while Held spawns wait. `warn` while the run is at or over
 * its cap, or anything is held: either way the next proposal, or one
 * already made, needs the operator.
 */
export interface SpawnLineView {
  text: string;
  warn: boolean;
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

/** A ticket row's vertical pitch: taller while any of its tickets shows a terminal surface. */
function rowPitch(row: EnrichedTicketState[]): number {
  return row.some((ticket) => ticketPaneId(ticket) !== null)
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

function toInterruptView(
  raw: Interrupt | null,
  state: PoolState,
  heldPane: HeldPaneRecord | null = null,
  keepTalking: KeepTalkingState | undefined = undefined,
): InterruptView | null {
  if (!raw) return null;
  const queued = isAnswerQueued(state.queuedAnswers, raw);
  return {
    ...raw,
    form: interruptForm(raw),
    queued,
    keepTalking: queued ? null : projectKeepTalking(raw, heldPane, keepTalking),
  };
}

/**
 * Keep talking's view for a ticket's interrupt (issue #139): offered only
 * on a checkpoint whose ticket carries a Held pane, the engine's word that
 * the checkpointed Attempt's TUI is still alive to talk to. Every other
 * kind is answered through its form alone: a merge conflict, an approval, a
 * crash or a config problem is not a conversation to carry on. The
 * session's mark counts only for the Held pane it was asked of.
 */
function projectKeepTalking(
  raw: Interrupt,
  heldPane: HeldPaneRecord | null,
  state: KeepTalkingState | undefined,
): KeepTalkingView | null {
  if (raw.kind !== "checkpoint" || heldPane === null) return null;
  const current = state?.attempt === heldPane.attempt ? state : undefined;
  return {
    requesting: current?.requesting ?? false,
    failure: current?.failure ?? null,
  };
}

/**
 * The one reading of "this ticket has a pane to show": its Live attempt's
 * pane while a terminal-backed attempt runs, else its Held pane's while it
 * waits at a checkpoint with the checkpointed Attempt's TUI still alive
 * (issue #139), else null. The engine never sets both. The card's terminal
 * surface, the terminal store's peek polling and the row pitch all read it
 * here, so a Held pane keeps peek, "Open in herdr" and the attach chip the
 * way a running attempt does, and all three stop together when neither is
 * there. The server resolves a Held pane for the ticket-keyed peek and
 * focus routes exactly as it resolves a Live attempt's.
 */
export function ticketPaneId(ticket: EnrichedTicketState): string | null {
  return ticket.liveAttempt?.paneId ?? ticket.heldPane?.paneId ?? null;
}

/**
 * The card's terminal surface (ADR-0014): present exactly when the card has
 * a pane, a ticket's by `ticketPaneId` (its running attempt's, or its Held
 * pane's at a checkpoint; both go the moment the engine drops them) and a
 * live Conversation's own, so headless and finished cards stay untouched. Before the first peek payload lands the
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
  keepTalking: KeepTalkingState | undefined,
): TicketCardView {
  const raw = state.interrupts.find((i) => i.ticketId === ticket.id) ?? null;
  const paneId = ticketPaneId(ticket);
  return {
    kind: "ticket",
    id: ticketCardId(ticket.id),
    ticketId: ticket.id,
    title: ticket.title,
    blockedBy: ticket.blockedBy,
    blockedByCheckpoint: checkpointBlockers(ticket, state),
    status: ticket.status,
    mergeState: ticket.mergeState,
    resolver: projectResolver(ticket.liveAttempt, now),
    assignment: ticket.assignment,
    enlisted: ticket.enlisted,
    reassign: ticket.reassign,
    hasLiveAttempt: ticket.liveAttempt !== null,
    outcome: state.outcomes[ticket.id] ?? null,
    interrupt: toInterruptView(raw, state, ticket.heldPane, keepTalking),
    grade,
    vitals: projectVitals(
      vitals,
      ticket.status,
      now,
      ticket.liveAttempt?.role === "resolver" ? ticket.liveAttempt.startedAt : null,
    ),
    paneId,
    terminal: projectTerminalSurface(paneId, terminal),
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
 *  has ever been attempted this session. The engine's own word that an End
 *  is under way (issue #140) counts too: after a reload, or an End from
 *  another tab, the merge may still be landing, and End stays disabled. */
function projectConversationEnd(
  state: ConversationEndView | undefined,
  engineEnding: boolean,
): ConversationEndView {
  const view = state ?? { ending: false, failure: null };
  return engineEnding ? { ...view, ending: true } : view;
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
    enlisted: conversation.enlisted,
    terminal: projectTerminalSurface(conversation.paneId, terminal),
    endView: projectConversationEnd(endings[conversation.id], conversation.ending),
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
  keepTalking: Record<string, KeepTalkingState> = {},
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
        keepTalking[ticket.id],
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
    mergeQueueLine: mergeQueueLine(snapshot, now),
    spawnLine: spawnLine(snapshot),
    heldSpawns: projectHeldSpawns(snapshot.heldSpawns, now),
  };
}

function spawnLine(snapshot: EnrichedSnapshot): SpawnLineView {
  const { spawnedThisRun, perAttempt, perRun } = snapshot.spawnUsage;
  const held = snapshot.heldSpawns.length;
  const parts = [`Spawns ${spawnedThisRun}/${perRun} this run`, `${perAttempt} per attempt`];
  if (held > 0) parts.push(`${held} held`);
  return { text: parts.join(" · "), warn: spawnedThisRun >= perRun || held > 0 };
}

// ---------------------------------------------------------------------------
// Held spawns (issue #149, ADR-0029)
// ---------------------------------------------------------------------------

/** How the list names the cap that held a spawn. */
const HELD_SPAWN_REASON: Record<HeldSpawnReason, string> = {
  "per-attempt": "per-attempt cap",
  "per-run": "per-run cap",
};

/** One Held spawn as the list shows it, in the engine's order, oldest first. */
export interface HeldSpawnRow {
  id: string;
  title: string;
  /** What adopting it starts. */
  kind: "ticket" | "conversation";
  /** "from 03", or "from Conversation c-1". */
  parent: string;
  /** "per-attempt cap" or "per-run cap". */
  reason: string;
  /** How long it has waited: "12m ago". */
  waited: string;
  /** When it was held, as the wire carries it, for the hover. */
  at: string;
  /** "waits on 01, 02"; null when it waits on nothing. */
  blockedBy: string | null;
  /** "blocks 04, 05", or every ticket not yet started; null for none. */
  blocks: string | null;
  body: string;
  /** An Adopt is on its way to the boundary: nothing more to decide. */
  adopting: boolean;
}

export function projectHeldSpawns(held: HeldSpawnView[], now: number): HeldSpawnRow[] {
  return held.map((spawn) => {
    const at = Date.parse(spawn.at);
    return {
      id: spawn.id,
      title: spawn.title,
      kind: spawn.kind,
      parent:
        spawn.origin === "conversation"
          ? `from Conversation ${spawn.parentId}`
          : `from ${spawn.parentId}`,
      reason: HELD_SPAWN_REASON[spawn.reason],
      waited: Number.isNaN(at) ? "" : `${shortDurationCopy(now - at)} ago`,
      at: spawn.at,
      blockedBy: spawn.blockedBy.length > 0 ? `waits on ${spawn.blockedBy.join(", ")}` : null,
      blocks:
        spawn.blocks === "all"
          ? "blocks every ticket not yet started"
          : spawn.blocks && spawn.blocks.length > 0
            ? `blocks ${spawn.blocks.join(", ")}`
            : null,
      body: spawn.body,
      adopting: spawn.adopting,
    };
  });
}

/** How the header words a Merge queue state after the ticket ids. */
const MERGE_QUEUE_HEADER: Record<MergeQueueState, string> = {
  resolving: "resolving",
  "awaiting-approval": "awaiting approval",
  "needs-you": "needs you",
  queued: "queued",
  stalled: "stalled, nothing running",
};

/**
 * The header line while the Merge hold stands (issue #129): the queue in the
 * engine's order, head first, with runs of the same state folded together
 * ("merge hold: 02 resolving (10m) · 04, 05, 09 queued"). A live resolver
 * carries its running time; one the engine is still launching has none yet.
 * Null when nothing is held, so the line is gone with the hold.
 */
function mergeQueueLine(snapshot: EnrichedSnapshot, now: number): string | null {
  const queue = snapshot.state.mergeQueue;
  if (queue.length === 0) return null;
  const runs: MergeQueueEntry[][] = [];
  for (const entry of queue) {
    const last = runs[runs.length - 1];
    if (last && last[0].state === entry.state && entry.state !== "resolving") last.push(entry);
    else runs.push([entry]);
  }
  const parts = runs.map((run) => {
    const words = `${run.map((e) => e.ticketId).join(", ")} ${MERGE_QUEUE_HEADER[run[0].state]}`;
    if (run[0].state !== "resolving") return words;
    const live = snapshot.state.tickets.find((t) => t.id === run[0].ticketId)?.liveAttempt;
    const started = live?.role === "resolver" ? Date.parse(live.startedAt) : Number.NaN;
    return Number.isNaN(started) ? words : `${words} (${shortDurationCopy(now - started)})`;
  });
  return `merge hold: ${parts.join(" · ")}`;
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
  if (typeof source.effort === "string") defaults.effort = source.effort;
  if (typeof source.drivers === "string") defaults.drivers = source.drivers;
  return defaults;
}

/**
 * Whether the pool is Terminal-backed (ADR-0014): its `config.terminal` reads
 * "herdr". The header offers Enlist only on such a pool, so the Console never
 * shows an action the pool cannot perform.
 */
export function isTerminalBacked(config: Record<string, unknown>): boolean {
  return config.terminal === "herdr";
}

// ---------------------------------------------------------------------------
// Settings (ADR-0026, issue #121): the wire shapes are the engine's, declared
// beside the module that validates and writes the file and re-exported above.
// What lives here is the Console's own half: which boot-only keys are waiting
// on a Restart, and the patch body the Settings pane sends.
// ---------------------------------------------------------------------------

/**
 * The keys a running server cannot pick up from a Config reload, as the
 * badge logic names them. The engine's BOOT_ONLY_KEYS says the same thing and
 * the payload carries it twice over, as `bootOnly` and as the `effective.stale`
 * subset the badges read, but both are arrays of plain strings: the union is
 * spelled again here so the pane's badge lookups are checked against a closed
 * set rather than against whatever the wire happened to send.
 */
export type BootOnlyKey = "roster" | "agents" | "selection" | "terminal" | "port";

/**
 * The PUT /api/settings/pool body's `config`. The engine takes any subset of
 * its settings keys and leaves the rest alone; the pane shows them all at
 * once, so it sends them all, a key as null when the operator emptied it
 * (port back to auto, terminal back to headless). `defaults` travels whole,
 * its own fields blanked the same way.
 */
export interface PoolConfigPatch {
  defaults?: { harness: string; model: string; effort: string; drivers: string };
  resolver?: PoolConfig["resolver"] | null;
  terminal?: "herdr" | null;
  port?: number | null;
  selection?: "auto" | "human" | null;
  roster?: string | null;
  agents?: string | null;
  reviewer?: string | null;
  checkpoint?: string | null;
  /** The Pool title (issue #100); null clears it back to the directory name. */
  title?: string | null;
  /** The Spawn caps (issue #149), replaced whole: a null field goes back to
   *  the engine's default, and both null removes the key. */
  spawnCaps?: { perAttempt: number | null; perRun: number | null };
}

/**
 * Which boot-only keys are waiting on a Restart, narrowed from the engine's
 * `effective.stale` to the union the pane badges. The engine derives that
 * list by comparing the file against what this process actually booted with,
 * which is strictly more than a tab can know on its own: the badge survives a
 * reload, shows in a second tab, and catches an edit made in the file by hand.
 *
 * Port is the one key whose reading is not the obvious one, and the engine
 * owns that judgement rather than this projection. It reports staleness as
 * "a Restart would move the Console", so a pin matching the running port is
 * not stale, and clearing a pin is not stale either, because the handover
 * pins the running port so the restarting tab can find the server again. A
 * cleared pin takes effect at the next cold Boot instead.
 */
export function projectRestartBadges(stale: readonly string[]): Set<BootOnlyKey> {
  const badges = new Set<BootOnlyKey>();
  for (const key of stale) {
    if (
      key === "roster" ||
      key === "agents" ||
      key === "selection" ||
      key === "terminal" ||
      key === "port"
    ) {
      badges.add(key);
    }
  }
  return badges;
}

/** One row of the Enlist picker: a live herdr pane as the operator reads it. */
export interface EnlistPickerRow {
  paneId: string;
  harness: string | null;
  status: string;
  title: string;
  directory: string;
  branch: string;
  eligible: boolean;
  reason: string | null;
}

/**
 * The Enlist picker's rows: every pane herdr reported, eligible first so the
 * actionable panes sit at the top, then by harness and title. Ineligible rows
 * stay in the list with their reason (the store greys them and they are not
 * selectable); they are never dropped, so the operator learns why.
 */
export function projectEnlistPicker(panes: EnlistPane[]): EnlistPickerRow[] {
  return panes
    .map((pane) => ({
      paneId: pane.paneId,
      harness: pane.harness,
      status: pane.status,
      title: pane.title,
      directory: pane.directory ?? "",
      branch: pane.branch ?? "",
      eligible: pane.eligible,
      reason: pane.reason,
    }))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      const aHarness = a.harness ?? "";
      const bHarness = b.harness ?? "";
      if (aHarness !== bHarness) return aHarness < bHarness ? -1 : 1;
      if (a.title !== b.title) return a.title < b.title ? -1 : 1;
      return a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0;
    });
}

/** One row of the Enlist form's "Blocks" tick list: a ticket that can still
 *  wait on the enlisted one. */
export interface EnlistBlockRow {
  id: string;
  title: string;
}

/**
 * The Enlist form's "Blocks" tick list (issue #101): every ticket not yet
 * done, in pool order. A done ticket is excluded because blocked-by gates a
 * ticket's next Attempt and a done ticket has none, so ticking it could never
 * take effect. The enlisted ticket does not exist yet, so nothing is filtered
 * for it here.
 */
export function projectEnlistBlocks(tickets: EnrichedTicketState[]): EnlistBlockRow[] {
  return tickets
    .filter((ticket) => ticket.status !== "done")
    .map((ticket) => ({ id: ticket.id, title: ticket.title }));
}

// ---------------------------------------------------------------------------
// Reassign (CONTEXT.md: Reassign; issue #126): the rows the bulk dialog in
// the Settings pane lists. Every judgement is the engine's, carried on the
// snapshot: which tickets can be reassigned, where each Assignment field
// came from, and the caveat on an eligible one. Nothing is re-derived here.
// ---------------------------------------------------------------------------

/** One reassignable ticket, as the bulk dialog lists it. */
export interface ReassignTicketRow {
  id: string;
  title: string;
  status: TicketStatus;
  /** The Assignment in force, the same record the card shows. */
  assignment: AssignmentView;
  /** Where each field of `assignment` came from, for the row's pills. */
  sources: AssignmentSources;
  /** The ticket's own verify count; null when it has none. */
  verify: number | null;
  /** Enlisted from a live herdr pane (issue #101): it runs as it was found,
   *  so the engine fixes its model, drivers and verify and only its harness
   *  can be reassigned. */
  enlisted: boolean;
  /** The engine's caveat on an eligible ticket, or null. */
  reason: string | null;
}

/**
 * Every ticket the engine says can be reassigned, in snapshot order. An
 * ineligible ticket is left out entirely: the bulk dialog only offers what a
 * write would reach, and the Detail says why a single ticket is read-only.
 */
export function projectReassignTickets(
  tickets: EnrichedTicketState[],
): ReassignTicketRow[] {
  return tickets
    .filter((ticket) => ticket.reassign.eligible)
    .map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      assignment: ticket.assignment,
      sources: ticket.reassign.sources,
      verify: ticket.reassign.verify,
      enlisted: ticket.enlisted,
      reason: ticket.reassign.reason,
    }));
}

/** The two kinds a picked pane can become, fixed at enlist time (issue #101). */
export type EnlistBecomes = "ticket" | "conversation";

/** The one-line reminder beside the Becomes switch, so the operator picks the
 *  right kind without re-reading the glossary. */
export const ENLIST_BECOMES_HINT =
  "Ticket ends in an Outcome and can be waited on; Conversation is an open talk that cannot block anything.";

/**
 * The greyed note that stands where Blocks would be when the form is in
 * Conversation mode (ADR-0018: a Conversation can never appear in a Ticket's
 * blocked-by, so nothing may wait on it). It points back to Ticket.
 */
export const ENLIST_CONVERSATION_NOTE =
  "A Conversation cannot block a Ticket (ADR-0018). Switch back to Ticket if other work must wait on this.";

/**
 * What the Enlist form shows for the chosen Becomes: the fields that belong to
 * the kind, and the note that replaces Blocks. A pure projection, so the
 * Console's DOM-free tests pin both modes without rendering. The one-line
 * hint beside the switch is mode-independent and lives in
 * ENLIST_BECOMES_HINT rather than on the view.
 */
export interface EnlistFormView {
  /** The spec textarea (Ticket only). */
  showsSpec: boolean;
  /** The Blocks tick list (Ticket only). */
  showsBlocks: boolean;
  /** The optional opening-Turn textarea (Conversation only). */
  showsOpening: boolean;
  /** The greyed note standing in for Blocks in Conversation mode; null in
   *  Ticket mode, where the tick list shows. */
  note: string | null;
}

export function projectEnlistForm(becomes: EnlistBecomes): EnlistFormView {
  return becomes === "ticket"
    ? { showsSpec: true, showsBlocks: true, showsOpening: false, note: null }
    : {
        showsSpec: false,
        showsBlocks: false,
        showsOpening: true,
        note: ENLIST_CONVERSATION_NOTE,
      };
}

/**
 * A held ticket's state word, one per Merge queue state (issue #129). The
 * two that wait on the operator read the way their interrupts are titled
 * ("merge approval", "merge conflict"), so the card, the Detail and the
 * Needs input tray name the same thing.
 */
const MERGE_STATE_LABELS: Record<MergeQueueState, string> = {
  resolving: "resolving merge conflict",
  "awaiting-approval": "merge approval: needs you",
  "needs-you": "merge conflict: needs you",
  queued: "merge queued",
  stalled: "merge stalled: nothing running",
};

export function statusLabel(
  status: TicketStatus,
  mergeState: MergeQueueState | null = null,
): string {
  if (status === "done" && mergeState) return MERGE_STATE_LABELS[mergeState];
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
    // The farewell phase of an orderly shutdown (issue #97): terminal, and
    // the last thing the stream carries before the server stops serving.
    case "stopped":
      return "stopped";
  }
}

export interface PoolTabStatus {
  word: string;
  color: string;
}

/**
 * What the Console calls this pool (issue #100): its Pool title when it has
 * one, else the directory name the server derives. Display-only; the
 * directory stays the identity.
 */
export function poolDisplayName(snapshot: EnrichedSnapshot): string {
  return snapshot.poolTitle ?? snapshot.poolName;
}

/**
 * The browser tab's title, the pool first (issue #100): with several
 * Consoles open, the start of the tab is what shows, and it has to say which
 * pool before it says how that pool is doing.
 */
export function poolTabTitle(name: string, status: PoolTabStatus): string {
  return `${name} — ${status.word}`;
}

/** The tab status colors, from the Console palette. The favicon's boot dot
 *  consumes the idle color before any snapshot lands. Dead shares the alarm
 *  red with needs input: its word carries the difference. A stopped server
 *  (issue #97) shares the idle grey: nothing is wrong, nothing is running. */
export const POOL_TAB_COLORS = {
  needsInput: "#f85149",
  running: "#d29922",
  complete: "#3fb950",
  idle: "#8b949e",
  dead: "#f85149",
  stopped: "#8b949e",
} as const;

/**
 * The pool's at-a-glance status for the browser tab, worst-first: the two
 * terminal phases outrank everything, because no answer can reach either, so
 * needs input would mislead. A dead phase is a drive that died; a stopped
 * phase is the server's own orderly shutdown (issue #97), which leaves any
 * interrupt on the snapshot unanswerable until someone relaunches. Then a
 * pending interrupt with no queued answer or a stalled phase needs input;
 * otherwise a running phase is running, a done phase is complete, and
 * anything else is idle. An interrupt whose answer is already queued waits
 * on the engine, not the operator, so it stays out of needs input. Quiescent
 * always carries a pending interrupt, so it lands on needs input without a
 * rule of its own. Colors come from the Console palette; the tab title and
 * the favicon both consume this value.
 */
export function poolStatus(snapshot: EnrichedSnapshot): PoolTabStatus {
  if (snapshot.phase === "dead") {
    return { word: "dead", color: POOL_TAB_COLORS.dead };
  }
  if (snapshot.phase === "stopped") {
    return { word: "stopped", color: POOL_TAB_COLORS.stopped };
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
  /** Mirrors the card's: where the ticket stands in the Merge queue. */
  mergeState: MergeQueueState | null;
  /** Mirrors the card's: the resolver running on the ticket's merge. */
  resolver: ResolverView | null;
  blockedBy: string[];
  blockedByCheckpoint: string[];
  outcome: Outcome | null;
  interrupt: InterruptView | null;
  /** The winning attempt's number from the grades endpoint, for the
   *  timeline's winner badge. Null when the ticket is ungraded or no
   *  selection has landed: no badge renders. */
  winner: number | null;
  /** The ticket's resolved Assignment, the same record the card shows: the
   *  Reassign editor prefills from it (issue #126). */
  assignment: AssignmentView;
  /** Mirrors the card's enlisted flag, so the Reassign section can say that
   *  an enlisted ticket's saved change waits on the engine. */
  enlisted: boolean;
  /** Eligibility, its reason, the ticket's own verify count and the
   *  Assignment's per-field provenance (issue #126). */
  reassign: TicketReassignView;
  /** An Attempt is in flight: the Reassign editor stands aside for the
   *  read-only view while one is. */
  hasLiveAttempt: boolean;
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
      mergeState: card.mergeState,
      resolver: card.resolver,
      blockedBy: card.blockedBy,
      blockedByCheckpoint: card.blockedByCheckpoint,
      outcome: card.outcome,
      interrupt: card.interrupt,
      winner: card.grade?.winner ?? null,
      assignment: card.assignment,
      enlisted: card.enlisted,
      reassign: card.reassign,
      hasLiveAttempt: card.hasLiveAttempt,
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
 * A pure projection of the projected cards: no new data source, the tray
 * reads what the cards read. Takes the cards so the session's single
 * projectPool per cycle stays single.
 */
export function projectNeedsInput(cards: PoolCardView[]): NeedsInputRow[] {
  const rows: NeedsInputRow[] = [];
  for (const card of cards) {
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

// ---------------------------------------------------------------------------
// Needs input tray width clamp
// ---------------------------------------------------------------------------

export const NEEDS_INPUT_MIN_PX = 300;
/** The tray's maximum width, as a fraction of the canvas column's width. */
export const NEEDS_INPUT_MAX_FRACTION = 0.6;

/**
 * Clamp a Needs input tray width in px (issue #147): never narrower than the
 * tray's original 300px, never wider than most of the canvas column it
 * overlays. `maxPx` is the caller-computed column fraction. On a column too
 * narrow to hold the minimum, the column bound wins, as the Detail's does.
 */
export function clampNeedsInputWidth(px: number, maxPx: number): number {
  return Math.min(maxPx, Math.max(NEEDS_INPUT_MIN_PX, px));
}

/**
 * The tray width persistence round trip, the Detail's shape: a plain number
 * string under one global key, parsed back and clamped to the current
 * column. A missing, unparseable, or non-finite value falls back to the
 * minimum, which is the default width.
 */
export function parseStoredNeedsInputWidth(
  raw: string | null,
  maxPx: number,
): number {
  const parsed = raw == null ? Number.NaN : Number(raw);
  return clampNeedsInputWidth(
    Number.isFinite(parsed) ? parsed : NEEDS_INPUT_MIN_PX,
    maxPx,
  );
}
