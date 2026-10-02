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
  SpawnUsage,
} from "./engine.ts";
export type { TicketStatus } from "./pool.ts";
export type { AssignmentView } from "./assignment.ts";
export type { AttemptRole, LiveAttemptRecord } from "./live-attempts.ts";
export type { HeldPaneRecord } from "./held-panes.ts";
export type { NoticeDelivery } from "./notices.ts";
export type { HeldSpawnReason, HeldSpawnView, PendingSpawnView } from "./spawn-proposals.ts";
export type { MergeQueueEntry, MergeQueueState } from "./merge-hold.ts";
export type { QueuedAnswer } from "./queued-answers.ts";
export type { TurnSide } from "./turn-state.ts";
export type {
  EnlistPane,
  PanesResponse,
  EnlistRequest,
  EnlistResponse,
  EnlistStewardWireRequest,
} from "./enlist.ts";
// The Steward (ADR-0030): its role on a Conversation, its note on an
// Interrupt, its budget on the snapshot, who answered on a Ticket log
// event, the Pool settings entry, and the bodies its command sends.
export type {
  AnswerBy,
  ConversationRole,
  StewardActionResponse,
  StewardAnswerRequest,
  StewardAssign,
  StewardBudgetView,
  StewardConfig,
  StewardEndRequest,
  StewardHeldRequest,
  StewardKeepTalkingRequest,
  StewardLeaveRequest,
  StewardNote,
  StewardReassignRequest,
  StewardStateInterrupt,
  StewardStateResponse,
} from "./steward.ts";
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
import type { Interrupt, Outcome, RunPhase, SpawnUsage } from "./engine.ts";
import type { TicketStatus } from "./pool.ts";
import type { AssignmentView } from "./assignment.ts";
import type { LiveAttemptRecord } from "./live-attempts.ts";
import type { HeldPaneRecord } from "./held-panes.ts";
import type { HeldSpawnView, PendingSpawnView } from "./spawn-proposals.ts";
import type { MergeQueueEntry, MergeQueueState } from "./merge-hold.ts";
import type { QueuedAnswer } from "./queued-answers.ts";
import type { TicketEvent } from "./events.ts";
import type { TicketReassignView } from "./reassign.ts";
import type { StewardBudgetView } from "./steward.ts";

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
  /** Where the ticket stands in the Merge queue (issue #129): null unless
   *  it is done and its branch has not landed in the merge target
   *  (ADR-0014). A lookup into the snapshot's Merge queue, the engine's one
   *  derivation; every UI surface reads this field and never git. */
  mergeState: MergeQueueState | null;
  /** The ticket's resolved Assignment record (ADR-0013), served verbatim. */
  assignment: AssignmentView;
  /**
   * The ticket's Live attempt (ADR-0014): the attempt number and, for a
   * terminal-backed attempt, its herdr pane, served verbatim from the
   * engine's snapshot while the attempt runs; null once it has ended, so a
   * finished card's terminal surface and its polling stop, and null for a
   * ticket with nothing running. A headless attempt is live with a null
   * pane. Its role says whether it is the Ticket's own agent or a resolver
   * on the Ticket's conflicted merge (issue #129).
   */
  liveAttempt: LiveAttemptRecord | null;
  /**
   * The ticket's Held pane (issue #139): while it waits at a checkpoint
   * Interrupt whose Terminal-backed attempt's pane is still alive in herdr,
   * that attempt's number and pane, so the card and the Detail keep peek,
   * focus and attach for it and offer Keep talking. Null once the Interrupt
   * is answered or the pane is gone, for a headless attempt, and for every
   * ticket not at a checkpoint. Never set together with `liveAttempt`.
   */
  heldPane: HeldPaneRecord | null;
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
  /** The Pool title (issue #100) from the pool's config as it stands now, or
   *  null when it has none; the Console shows it ahead of `poolName`, which
   *  it falls back to. Display-only: the directory stays the identity. */
  poolTitle: string | null;
  /** The pool directory the server was launched on, verbatim: what a
   *  relaunch after a Console stop (issue #97) passes to `--pool`. */
  poolDir: string;
  /**
   * Finished terminals (issue #139): how many herdr tabs this pool opened
   * are still open over an Attempt or a Conversation that has ended, none
   * of them a Live attempt's, a Held pane's, an enlisted pane or a live
   * Conversation's. The pool header offers to close them when it is not 0;
   * the engine never closes them on its own.
   */
  finishedTerminals: number;
  /**
   * The Spawn caps in force and this run's count (issue #149), from the
   * engine's snapshot verbatim: "Spawns `spawnedThisRun`/`perRun` this run"
   * and "`perAttempt` per attempt". A run is this Console boot.
   */
  spawnUsage: SpawnUsage;
  /**
   * The Pending spawns (issue #150), oldest first, from the engine's
   * snapshot verbatim: proposals within the caps that land at the next
   * super-step boundary unless the operator Holds or Discards them first.
   */
  pendingSpawns: PendingSpawnView[];
  /**
   * The Held spawns (issue #149, ADR-0029, widened by issue #150), oldest
   * first, from the engine's snapshot verbatim: the proposals a Spawn cap
   * had no room for, the agent marked as overlapping, or the operator held
   * back, each waiting for the operator to Adopt it (past the caps) or
   * Discard it.
   */
  heldSpawns: HeldSpawnView[];
  /**
   * The Steward budget (ADR-0030), from the engine's snapshot verbatim: the
   * Pool's budget per Ticket, and what the Steward has used on each Ticket
   * it answered since the operator last did (absent from `used` is 0).
   * Remaining is `budget - used`. Always sent; optional only so a fixture
   * written before the Steward still types.
   */
  stewardBudget?: StewardBudgetView;
  state: {
    tickets: EnrichedTicketState[];
    /** Every Conversation the pool knows about (issue #60), passed through
     *  from the engine's own snapshot verbatim: conversationViewOf already
     *  builds the wire shape the UI wants, so there is nothing to enrich. */
    conversations: ConversationView[];
    log: string[];
    outcomes: Record<string, Outcome>;
    interrupts: Interrupt[];
    /** The Merge queue (issue #129): every held ticket, head first, in the
     *  order the engine works through them. Empty when no hold stands. */
    mergeQueue: MergeQueueEntry[];
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
// Keep talking (POST /api/keep-talking)
// ---------------------------------------------------------------------------

/**
 * Keep talking (issue #139): continue a ticket's checkpointed Attempt in its
 * Held pane. Not a resume action: it is never queued for the super-step
 * boundary (ADR-0004's exception, as Enlist is), so it has its own route.
 */
export interface KeepTalkingRequest {
  ticketId: string;
}

/** The Continued attempt's number, once the engine has claimed the pane. A
 *  refusal is the 409 `reason` envelope the enlist route answers with. */
export interface KeepTalkingResponse {
  ticketId: string;
  attempt: number;
}

// ---------------------------------------------------------------------------
// Close finished terminals (POST /api/terminals/close-finished)
// ---------------------------------------------------------------------------

/** How many Finished terminals the bulk close closed. */
export interface CloseFinishedTerminalsResponse {
  closed: number;
}

// ---------------------------------------------------------------------------
// Held spawns (POST /api/spawns/held/adopt, /api/spawns/held/discard)
// ---------------------------------------------------------------------------

/**
 * Adopt or Discard one Held spawn (issue #149, ADR-0029), by its id. Adopt
 * answers 202 once the adoption is queued (written at once on an idle pool,
 * at the next boundary otherwise); Discard answers 200 once it is gone. A
 * refusal is the 409 `reason` envelope the keep-talking route answers with.
 */
export interface HeldSpawnRequest {
  id: string;
}

export interface HeldSpawnResponse {
  id: string;
}

// ---------------------------------------------------------------------------
// Pending spawns (POST /api/spawns/pending/hold, /api/spawns/pending/discard)
// ---------------------------------------------------------------------------

/**
 * Hold or Discard one Pending spawn before the boundary lands it (issue
 * #150), by its id. Hold answers 200 once it is a Held spawn (held by the
 * operator, same id); Discard answers 200 once it is gone. One that has
 * already landed, or is not pending, is refused with the 409 `reason`
 * envelope.
 */
export interface PendingSpawnRequest {
  id: string;
}

export interface PendingSpawnResponse {
  id: string;
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
