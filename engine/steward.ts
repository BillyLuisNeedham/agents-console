/**
 * The Steward (ADR-0030, CONTEXT.md: Steward, Steward budget, Steward note):
 * a Conversation in the role of keeping the Pool's Tickets moving while the
 * operator is away. This module holds what the role adds to a Conversation
 * and nothing that needs a Session: the `steward` entry of console.json and
 * its check, the budget rule read off a Ticket log, the Steward note store,
 * which pending items the Steward is told about and the text that tells it,
 * the command it answers with, and the wire shapes of the routes that
 * command reaches. The engine owns the answers themselves (engine.ts); the
 * Conversation module owns the Steward's pane and Notice queue
 * (conversations.ts). Imports nothing from the engine, so the rules are
 * trivial to table-test.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TicketEvent } from "./events.ts";
import type { ReassignRequest } from "./reassign.ts";

/** The roles a Conversation may carry. Absent is an ordinary Conversation. */
export type ConversationRole = "steward";

/**
 * Who gave an answer, as the Ticket log records it. An `answered` event with
 * no `by` is the operator's: every answer written before the Steward existed
 * reads that way unchanged.
 */
export type AnswerBy = "operator" | "steward";

// ---------------------------------------------------------------------------
// The `steward` entry of console.json: a Pool setting, reloaded with the
// assignment slice and the Spawn caps (Config reload).
// ---------------------------------------------------------------------------

/** The Steward's Assignment fields, each optional, layered ahead of the pool defaults. */
export interface StewardAssign {
  harness?: string;
  model?: string;
  effort?: string;
  drivers?: string;
}

/** console.json `steward`: the Steward budget and the Steward's Assignment. */
export interface StewardConfig {
  budget?: number;
  assign?: StewardAssign;
}

export const DEFAULT_STEWARD_BUDGET = 5;

/** The Steward budget in force under a config: 5 unless the pool says otherwise. */
export function stewardBudgetOf(config: { steward?: StewardConfig }): number {
  return config.steward?.budget ?? DEFAULT_STEWARD_BUDGET;
}

/** A Steward budget: a whole number, 1 or more. */
export function isStewardBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

const ASSIGN_FIELDS = ["harness", "model", "effort", "drivers"] as const;

/**
 * A console.json `steward` value, checked for shape: absent, or an object
 * whose budget, where present, is a whole number of 1 or more, and whose
 * assign, where present, is an object of strings. Boot's parse and the
 * boundary's reload share it, so a value the reload would refuse never
 * boots. Whether the assign names a harness the pool knows is the caller's
 * check: only the engine has the harness table.
 */
export function checkStewardConfig(raw: unknown): StewardConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("pool config: steward must be an object");
  }
  const steward = raw as Record<string, unknown>;
  if (steward.budget !== undefined && !isStewardBudget(steward.budget)) {
    throw new Error("pool config: steward.budget must be a whole number, 1 or more");
  }
  if (steward.assign !== undefined) {
    const assign = steward.assign;
    if (typeof assign !== "object" || assign === null || Array.isArray(assign)) {
      throw new Error("pool config: steward.assign must be an object");
    }
    for (const field of ASSIGN_FIELDS) {
      const value = (assign as Record<string, unknown>)[field];
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`pool config: steward.assign.${field} must be a string`);
      }
    }
  }
  return steward as StewardConfig;
}

// ---------------------------------------------------------------------------
// The Steward budget, read off the Ticket log: it persists for free.
// ---------------------------------------------------------------------------

/**
 * How many answers the Steward has given a Ticket since the operator last
 * answered it: the Steward's `answered` events (Keep talking included) after
 * the operator's last one. Leaves, adopts, discards and reassigns write no
 * `answered` event, so they never count, and the operator's answer resets
 * the count by being the last one.
 */
export function stewardBudgetUsed(events: readonly TicketEvent[]): number {
  let used = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind !== "answered") continue;
    if (event.payload.by !== "steward") break;
    used += 1;
  }
  return used;
}

/** The budget as the snapshot carries it: the Pool's, and what the Steward has used per Ticket (only Tickets it has answered since the operator last did). */
export interface StewardBudgetView {
  budget: number;
  used: Record<string, number>;
}

// ---------------------------------------------------------------------------
// The Steward note: the Steward's recommendation on a pending Interrupt it
// left to the operator, kept across restarts in `runs/steward-notes.json`.
// ---------------------------------------------------------------------------

/** A Steward note as the snapshot's interrupt carries it. */
export interface StewardNote {
  text: string;
  at: string;
  /** The Steward that wrote it. */
  conversation: string;
}

interface StewardNoteRecord extends StewardNote {
  ticketId: string;
  kind: string;
}

/**
 * The Steward notes, one per pending Interrupt, keyed by the Interrupt's
 * ticket and kind. A note belongs to one raise of its Interrupt: it is
 * cleared when the Interrupt is answered, and pruned once the Interrupt is
 * no longer pending, so the same Ticket raising again starts with none. A
 * note on an Interrupt is also the record that the Steward left it, so the
 * Steward is not told about it again until it changes. The file is
 * rewritten whole through a rename, as the queued answers are.
 */
export interface StewardNotes {
  get(ticketId: string, kind: string): StewardNote | null;
  set(ticketId: string, kind: string, note: StewardNote): void;
  /** Drop the Ticket's note, whatever its kind; true when there was one. */
  clear(ticketId: string): boolean;
  /** Drop every note whose Interrupt is not among `pending`; true when any went. */
  prune(pending: readonly { ticketId: string; kind: string }[]): boolean;
  size(): number;
}

export function stewardNotesPath(runsDir: string): string {
  return join(runsDir, "steward-notes.json");
}

export function loadStewardNotes(runsDir: string): StewardNotes {
  const file = stewardNotesPath(runsDir);
  let notes: StewardNoteRecord[] = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { notes?: unknown };
      if (Array.isArray(parsed.notes)) {
        notes = parsed.notes.filter(
          (note): note is StewardNoteRecord =>
            typeof note === "object" &&
            note !== null &&
            typeof (note as StewardNoteRecord).ticketId === "string" &&
            typeof (note as StewardNoteRecord).kind === "string" &&
            typeof (note as StewardNoteRecord).text === "string",
        );
      }
    } catch {
      // A torn or unreadable file starts with no notes rather than taking
      // the pool down: a note is a recommendation, never a decision.
    }
  }
  const save = (): void => {
    mkdirSync(runsDir, { recursive: true });
    const aside = `${file}.tmp`;
    writeFileSync(aside, JSON.stringify({ notes }, null, 2));
    renameSync(aside, file);
  };
  return {
    get(ticketId, kind) {
      const note = notes.find((n) => n.ticketId === ticketId && n.kind === kind);
      return note ? { text: note.text, at: note.at, conversation: note.conversation } : null;
    },
    set(ticketId, kind, note) {
      notes = [...notes.filter((n) => n.ticketId !== ticketId), { ticketId, kind, ...note }];
      save();
    },
    clear(ticketId) {
      const kept = notes.filter((n) => n.ticketId !== ticketId);
      if (kept.length === notes.length) return false;
      notes = kept;
      save();
      return true;
    },
    prune(pending) {
      const kept = notes.filter((n) =>
        pending.some((i) => i.ticketId === n.ticketId && i.kind === n.kind),
      );
      if (kept.length === notes.length) return false;
      notes = kept;
      save();
      return true;
    },
    size: () => notes.length,
  };
}

// ---------------------------------------------------------------------------
// What the Steward is told about: every pending Ticket Interrupt it may
// answer and has not left, and a stalled Merge queue head.
// ---------------------------------------------------------------------------

/** The Interrupt kinds the Steward never answers: the operator's final judgement, and an engine store failure. */
export const STEWARD_EXCLUDED_KINDS: readonly string[] = ["review", "persistence"];

/** One thing the Steward should hear about, as a Notice: its identity, the Ticket it is about, and the text. */
export interface StewardItem {
  /** `interrupt:<ticket>:<kind>` or `merge-stall:<ticket>`. */
  key: string;
  kind: "steward-interrupt" | "steward-merge-stall";
  /** The Ticket the item is about: its Ticket log records the Notice. */
  ticketId: string;
  text: string;
}

/** The pool as the item rule reads it; engine.ts builds it from its Session. */
export interface StewardPoolView {
  interrupts: readonly { ticketId: string; kind: string; body: string; candidates?: number[] }[];
  titleOf: (ticketId: string) => string | null;
  /** Ids that are Conversations: their Interrupts are outside the Steward's remit. */
  conversations: ReadonlySet<string>;
  /** Tickets with an answer already queued: already answered, by someone. */
  queued: ReadonlySet<string>;
  /** Whether the Steward left this Interrupt with a note. */
  left: (ticketId: string, kind: string) => boolean;
  /** Whether a checkpoint's pane is still alive to Keep talking in. */
  keepTalking: (ticketId: string) => boolean;
  budget: number;
  used: (ticketId: string) => number;
  mergeQueue: readonly { ticketId: string; state: string }[];
}

/** A pending Interrupt the Steward may answer at all: a Ticket's, not review or persistence, not a Conversation's. */
export function stewardMayAnswer(
  interrupt: { ticketId: string; kind: string },
  conversations: ReadonlySet<string>,
): boolean {
  return !STEWARD_EXCLUDED_KINDS.includes(interrupt.kind) && !conversations.has(interrupt.ticketId);
}

export function stewardItems(pool: StewardPoolView): StewardItem[] {
  const items: StewardItem[] = [];
  for (const interrupt of pool.interrupts) {
    if (!stewardMayAnswer(interrupt, pool.conversations)) continue;
    if (pool.queued.has(interrupt.ticketId)) continue;
    if (pool.left(interrupt.ticketId, interrupt.kind)) continue;
    const used = pool.used(interrupt.ticketId);
    items.push({
      key: `interrupt:${interrupt.ticketId}:${interrupt.kind}`,
      kind: "steward-interrupt",
      ticketId: interrupt.ticketId,
      text: stewardInterruptText({
        ticketId: interrupt.ticketId,
        title: pool.titleOf(interrupt.ticketId),
        kind: interrupt.kind,
        body: interrupt.body,
        keepTalking: interrupt.kind === "checkpoint" && pool.keepTalking(interrupt.ticketId),
        remaining: Math.max(0, pool.budget - used),
        budget: pool.budget,
      }),
    });
  }
  const head = pool.mergeQueue[0];
  if (head?.state === "stalled") {
    items.push({
      key: `merge-stall:${head.ticketId}`,
      kind: "steward-merge-stall",
      ticketId: head.ticketId,
      text: stewardMergeStallText({
        ticketId: head.ticketId,
        title: pool.titleOf(head.ticketId),
        behind: pool.mergeQueue.slice(1).map((entry) => entry.ticketId),
      }),
    });
  }
  return items;
}

/**
 * Which items are news to a Steward, given what it has been told: those not
 * told yet. `told` is updated in place: an item no longer offered is
 * forgotten, so a stall that clears and comes back, or an Interrupt raised
 * again after it went, is told again; each fresh item is remembered. Kept in
 * memory only, per Steward runtime, so a restart re-delivers.
 */
export function freshStewardItems(told: Set<string>, items: readonly StewardItem[]): StewardItem[] {
  const offered = new Set(items.map((item) => item.key));
  for (const key of [...told]) if (!offered.has(key)) told.delete(key);
  const fresh = items.filter((item) => !told.has(item.key));
  for (const item of fresh) told.add(item.key);
  return fresh;
}

// How much of an Interrupt's body a Notice carries: a Brief is usually short,
// a crash body or a selection's grades can run long, and the whole of it is a
// Ticket file or a state read away.
const BODY_CHARS = 1_500;

function clip(text: string): string {
  const trimmed = text.trim() || "(none written)";
  return trimmed.length <= BODY_CHARS
    ? trimmed
    : `${trimmed.slice(0, BODY_CHARS)}\n... (cut short: read the Ticket file and its log for the rest)`;
}

// The answers each kind takes, in the command's own words.
function answersFor(kind: string, ticketId: string, keepTalking: boolean): string {
  switch (kind) {
    case "checkpoint":
      return (
        `answer ${ticketId} resume [note]` +
        (keepTalking ? `, or keep-talking ${ticketId} <message> (its pane is still alive)` : "")
      );
    case "merge-approval":
      return `answer ${ticketId} approve [note], or answer ${ticketId} reject [note]`;
    case "selection":
      return `answer ${ticketId} resume <the attempt number to merge>`;
    case "config":
      return `reassign ${ticketId} field=value..., then answer ${ticketId} resume`;
    case "merge-conflict":
      return `answer ${ticketId} resume (re-attempts the merge)`;
    default:
      return `answer ${ticketId} resume [note]`;
  }
}

export function stewardInterruptText(params: {
  ticketId: string;
  title: string | null;
  kind: string;
  body: string;
  keepTalking: boolean;
  remaining: number;
  budget: number;
}): string {
  const title = params.title ? ` ("${params.title}")` : "";
  const lines = [
    `Ticket ${params.ticketId}${title} is waiting at a ${params.kind} Interrupt.`,
    `${params.kind === "checkpoint" ? "Brief" : "Body"}:`,
    clip(params.body),
    `Answers: ${answersFor(params.kind, params.ticketId, params.keepTalking)}; ` +
      `or leave ${params.ticketId} <note> for the operator.`,
    params.remaining > 0
      ? `Steward budget on ${params.ticketId}: ${params.remaining} of ${params.budget} answers left.`
      : `Steward budget on ${params.ticketId} is spent (${params.budget} of ${params.budget}): ` +
        "leave it to the operator with a note.",
  ];
  return lines.join("\n");
}

export function stewardMergeStallText(params: {
  ticketId: string;
  title: string | null;
  behind: string[];
}): string {
  const title = params.title ? ` ("${params.title}")` : "";
  return [
    `The Merge queue head, Ticket ${params.ticketId}${title}, is stalled: it is done, its branch ` +
      "has not landed, and no resolver runs and no Interrupt is raised for it. Nothing in the " +
      "pool moves until it lands.",
    params.behind.length > 0
      ? `Waiting behind it: ${params.behind.join(", ")}.`
      : "Nothing else waits behind it.",
    "There is no Interrupt to answer. Read its Ticket log and branch, and tell the operator in " +
      "this pane what you found; merge it by hand only if the operator's own words allowed you to.",
  ].join("\n");
}

/** One Turn telling the Steward everything delivered together. */
export function stewardBatchText(texts: readonly string[]): string {
  if (texts.length === 1) return `Pool news for the Steward:\n\n${texts[0]}`;
  return `Pool news for the Steward (${texts.length} items):\n\n${texts.join("\n\n---\n\n")}`;
}

// ---------------------------------------------------------------------------
// The command the Steward answers with (engine/steward-cli.ts).
// ---------------------------------------------------------------------------

// A shell word: bare when it is plainly safe, single-quoted otherwise.
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The exact invocation the teaching names: this Bun, this engine's CLI, the
 * pool directory (how the CLI finds the Console again after a Restart moved
 * its port), the Console's URL when the engine knows it, and the Steward's
 * own Conversation id, which every route checks against the live Steward.
 */
export function stewardCommand(params: {
  bun: string;
  cli: string;
  poolDir: string;
  url: string | null;
  conversation: string;
}): string {
  return [
    shellWord(params.bun),
    shellWord(params.cli),
    "--pool",
    shellWord(params.poolDir),
    ...(params.url ? ["--url", shellWord(params.url)] : []),
    "--as",
    shellWord(params.conversation),
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Wire shapes: the routes under /api/steward/, each naming the Steward's
// Conversation id. The server checks it against the live Steward; that is an
// attribution check, not a security boundary (ADR-0030).
// ---------------------------------------------------------------------------

/** POST /api/steward/answer: the operator's answer path, as the Steward's. */
export interface StewardAnswerRequest {
  conversation: string;
  ticketId: string;
  action: "resume" | "approve" | "reject";
  note?: string;
}

/** POST /api/steward/keep-talking: Keep talking, then the message typed after the teaching Turn. */
export interface StewardKeepTalkingRequest {
  conversation: string;
  ticketId: string;
  message: string;
}

/** POST /api/steward/leave: leave a pending Interrupt to the operator with a Steward note. */
export interface StewardLeaveRequest {
  conversation: string;
  ticketId: string;
  note: string;
}

/** POST /api/steward/held: Adopt or Discard a Held spawn. */
export interface StewardHeldRequest {
  conversation: string;
  action: "adopt" | "discard";
  id: string;
}

/** POST /api/steward/reassign: Reassign's own body (reassign.ts's ReassignRequest), as the Steward's. */
export interface StewardReassignRequest extends ReassignRequest {
  conversation: string;
}

/** POST /api/steward/end: the Steward ends itself, closing line included. */
export interface StewardEndRequest {
  conversation: string;
  closing?: string;
}

/** The answer every Steward write route gives: what was done, in one line. */
export interface StewardActionResponse {
  ok: true;
  message: string;
}

/** One pending Interrupt as the Steward's state read shows it. */
export interface StewardStateInterrupt {
  ticketId: string;
  title: string | null;
  kind: string;
  /** Whether the Steward may answer it at all (not review, persistence or a Conversation's). */
  answerable: boolean;
  keepTalking: boolean;
  /** An answer is already queued for it. */
  queued: boolean;
  /** The Steward's own note, when it left the Interrupt. */
  note: string | null;
  used: number;
  remaining: number;
}

/** GET /api/steward/state?conversation=<id>: a compact read of what the Steward stewards. */
export interface StewardStateResponse {
  steward: string;
  budget: number;
  phase: string;
  interrupts: StewardStateInterrupt[];
  mergeQueue: { ticketId: string; state: string }[];
  pendingSpawns: { id: string; parentId: string; title: string }[];
  heldSpawns: { id: string; parentId: string; title: string; reason: string }[];
  /** The Spawn ledger, for the whole pool's state in one file. */
  ledger: string;
}
