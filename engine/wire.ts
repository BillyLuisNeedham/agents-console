/**
 * The wire shapes (CONTEXT.md: Wire shape): every message between engine and
 * Console, declared once. The engine owns the contract; server.ts builds
 * these payloads and the Console type-imports them (`import type` only, so
 * the Vite bundle never pulls engine code), which makes drift between the
 * two a compile error rather than a silent copy.
 *
 * The shapes fall into two groups. Types with a natural engine home are
 * re-exported from it, so the declaration stays beside the code that
 * produces it: events.ts's TicketEvent, conversations.ts's ConversationView,
 * engine.ts's Interrupt and Outcome, and so on. The response envelopes the
 * server assembles (the enriched snapshot, the per-ticket reads, the
 * terminal peek) and the resume action live here directly; they were
 * unexported internals of server.ts until this module became their home.
 */

export type { TicketEvent, TicketEventKind } from "./events.ts";
export type {
  ConversationStatus,
  ConversationView,
  StartConversationRequest,
} from "./conversations.ts";
export type {
  EvidenceBudget,
  Grade,
  Interrupt,
  InterruptKind,
  Outcome,
  OutcomeStatus,
  RunPhase,
} from "./engine.ts";
export type { TicketStatus } from "./pool.ts";
export type { AssignmentView } from "./assignment.ts";
export type { LiveAttemptRecord } from "./live-attempts.ts";
export type { QueuedAnswer } from "./queued-answers.ts";
export type { TurnSide } from "./turn-state.ts";
export type { EnlistPane, PanesResponse, EnlistRequest, EnlistResponse } from "./enlist.ts";
// The Settings pane (issue #121): the Pool settings payload and the two
// write bodies live beside the module that validates and writes them, and
// the Machine defaults shape beside the file it describes.
export type {
  MachineDefaultsRequest,
  MachineDefaultsView,
  PoolSettingsRequest,
  PoolSettingsView,
  RestartResponse,
  SettingsResponse,
} from "./pool-settings.ts";
export type { MachineDefaults } from "./machine-defaults.ts";
// Reassign (issue #126): the per-ticket view the snapshot carries and the
// write body and answer of PUT /api/reassign live beside the writer.
export type {
  AssignmentSource,
  AssignmentSources,
  ReassignRequest,
  ReassignResponse,
  TicketReassignView,
} from "./reassign.ts";
export type { PoolConfig } from "./engine.ts";

import type { ConversationView } from "./conversations.ts";
import type { Interrupt, Outcome, RunPhase } from "./engine.ts";
import type { TicketStatus } from "./pool.ts";
import type { AssignmentView } from "./assignment.ts";
import type { LiveAttemptRecord } from "./live-attempts.ts";
import type { QueuedAnswer } from "./queued-answers.ts";
import type { TicketEvent } from "./events.ts";
import type { TicketReassignView } from "./reassign.ts";

/** The action a resume request carries (POST /api/resume): `approve` and
 *  `reject` answer the review gate and merge-approval interrupts; plain
 *  `resume` answers every other kind. Declared once here; the server's
 *  answer path and the Console's client and interrupt forms all use it. */
export type ResumeAction = "resume" | "approve" | "reject";

// ---------------------------------------------------------------------------
// The snapshot (GET /api/state, POST /api/start and /api/resume, SSE stream)
// ---------------------------------------------------------------------------

export interface EnrichedTicketState {
  id: string;
  title: string;
  blockedBy: string[];
  status: TicketStatus;
  /** True when the ticket is done but its branch has not landed in the
   *  merge target (ADR-0014): the "done, merge pending" card label. A
   *  lookup into the snapshot's Merge hold, the engine's one derivation;
   *  every UI surface reads this field and never git. */
  mergePending: boolean;
  /** The ticket's resolved Assignment record (ADR-0013), served verbatim. */
  assignment: AssignmentView;
  /**
   * The ticket's Live attempt (ADR-0014): the attempt number and, for a
   * terminal-backed attempt, its herdr pane, served verbatim from the
   * engine's snapshot while the attempt runs; null once it has ended, so a
   * finished card's terminal surface and its polling stop, and null for a
   * ticket with nothing running. A headless attempt is live with a null
   * pane.
   */
  liveAttempt: LiveAttemptRecord | null;
  /**
   * The ticket was enlisted from a live herdr pane (issue #101): its
   * Assignment was recorded as found, so the card reads "as found" where a
   * spawned ticket names a model. Derived by the server from the marker's
   * durable `enlisted-from` field.
   */
  enlisted: boolean;
  /**
   * Reassign (issue #126): whether a write to this ticket's assign entry
   * would take effect at the next boundary, why not when it would not, the
   * ticket's own verify count, and where each field of `assignment` came
   * from. For a ticket with no Attempt in flight, `assignment` is resolved
   * from the config file as it stands now, so a Reassign shows on the card
   * at once rather than at the next boundary; an in-flight ticket keeps
   * the engine's frozen record.
   */
  reassign: TicketReassignView;
}

export interface EnrichedSnapshot {
  seq: number;
  phase: RunPhase;
  /** The pool's display name: the last two path segments of the pool directory. */
  poolName: string;
  /** The pool directory the server was launched on, verbatim: what a
   *  relaunch after a Console stop (issue #97) passes to `--pool`. */
  poolDir: string;
  state: {
    tickets: EnrichedTicketState[];
    /** Every Conversation the pool knows about (issue #60), passed through
     *  from the engine's own snapshot verbatim: conversationViewOf already
     *  builds the wire shape the UI wants, so there is nothing to enrich. */
    conversations: ConversationView[];
    log: string[];
    outcomes: Record<string, Outcome>;
    interrupts: Interrupt[];
    /** Accepted answers still waiting for processing (the Queued answers). */
    queuedAnswers: QueuedAnswer[];
    config: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Ticket events (GET /api/events)
// ---------------------------------------------------------------------------

export interface ReconstructedAttempt {
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
// Ticket log (GET /api/log)
// ---------------------------------------------------------------------------

export interface LogAttemptInfo {
  attempt: number;
  kind: "implement" | "resolver" | "reconstructed";
  logFile: string;
  /**
   * The attempt's Stream file (the raw stream tee, ADR-0012), named by the
   * events module's contract the same way `logFile` is. Null when the
   * attempt has no Stream file on disk: a raw harness (opencode), a
   * pre-streaming attempt, or a reconstructed row.
   */
  streamFile: string | null;
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
// Ticket activity (GET /api/activity)
// ---------------------------------------------------------------------------

export interface TicketActivityResponse {
  ticketId: string;
  running: boolean;
  diff: { added: number; removed: number; files: string[] } | null;
  log: { size: number; mtime: string } | null;
  lastEventAt: string | null;
}

// ---------------------------------------------------------------------------
// Grades (GET /api/grades)
// ---------------------------------------------------------------------------

/**
 * One ticket's latest grade, as the card summaries show it: the score and
 * verdict with the graded attempt's number, plus the winning attempt's
 * number once Selection has named one. Derived at read time from the same
 * events files the Detail's timeline reads, so a card and the Detail never
 * disagree. Reasons stay in the events payload; the card is a summary.
 */
export interface TicketGradeSummary {
  attempt: number;
  score: number;
  verdict: string;
  /** The attempt Selection named, or the merged attempt on a ticket graded
   *  before the selection machinery. Null until either event lands. The
   *  Detail's winner badge reads this field, so both surfaces share the one
   *  derivation. */
  winner: number | null;
}

// ---------------------------------------------------------------------------
// Ticket body (GET /api/ticket)
// ---------------------------------------------------------------------------

export interface TicketBodyResponse {
  id: string;
  /** The Issue file's markdown with the line-1 state marker stripped. */
  body: string;
}

// ---------------------------------------------------------------------------
// Terminal peek (GET /api/terminal/peek)
// ---------------------------------------------------------------------------

/**
 * The peek endpoint's answer for one ticket: the pane's viewport as plain
 * text (ANSI stripped herdr-side), the engine's own last read of it when a
 * loop of the engine's watches the pane and a live viewport read otherwise
 * (issue #122). The UI keys every terminal call by ticket id; the server
 * resolves and guards the pane, and which of the two served it is not the
 * UI's concern.
 */
export interface TerminalPeekResponse {
  ticket: string;
  paneId: string;
  text: string;
}
