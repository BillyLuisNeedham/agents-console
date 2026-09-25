/**
 * Conversations (issue #60, docs/specs/2026-09-10-conversations.md,
 * docs/adr/0018-conversations-beside-tickets.md — note that ADR number
 * was renumbered from 0017 after colliding with 0017-headless-orphans-are-killed-not-
 * adopted.md in this tree; "the Conversations ADR" below always means the
 * former): an open-ended talk between the operator and one agent, living in
 * a Pool beside its Tickets. A Conversation has an Assignment fixed at
 * start, its own worktree and branch, runs as a terminal-backed TUI in a
 * herdr tab, and has no done condition — only the operator ends it
 * (CONTEXT.md: Conversation, Turn, Notice).
 *
 * Storage mirrors pool.ts's ticket markers: `<pool>/conversations/<id>.md`,
 * a line-1 `<!-- conversation: ... -->` marker followed by a `# title`
 * heading and the opening Turn as the body. Unlike a ticket marker, field
 * values are percent-encoded on write and decoded on read: a Conversation's
 * `drivers` field may carry a space-separated chain the way a ticket's does
 * (engine.ts's `assignment.drivers.split(/\s+/)`), and the marker line
 * itself is split on whitespace, so an un-encoded chain would corrupt the
 * parse. Tickets never hit this because pool.ts's fields (id, status,
 * blocked-by, spawned-by) never contain spaces.
 *
 * The module proper is built once at startPool (createConversations): it
 * takes the environment a Conversation runs against (ConversationEnv) and
 * the engine operations it may call (ConversationHost), and owns every
 * live Conversation's runtime — its pane, worktree, Turn state, Notice
 * queue and 2 s tick — plus the ids reserved for starts still in flight.
 * Nothing here reaches into the engine's Session, and nothing runs at
 * import time; the storage functions above the module are plain exports the
 * server and the tests share.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  attemptExitCodeName,
  attemptLogName,
  attemptStreamName,
  lastAttempt,
  readEvents,
  type TicketEventKind,
} from "./events.ts";
import type { TicketMarker } from "./pool.ts";
import {
  branchFor,
  worktreePathFor,
  commitMerge,
  git,
  blockedMergeExplanation,
  discardWorktree,
  prepareWorktree,
  removeWorktree,
  type MergeResult,
  type WorktreeInfo,
} from "./worktrees.ts";
import {
  exitCrashReason,
  waitForPaneEnding,
  type PaneEnding,
} from "./attempt-ending.ts";
import {
  attemptTabLabel,
  closeTab,
  isTabNotFound,
  listAgents,
  listPanes,
  peekPane,
  relabelTab,
  releasePaneAgent,
  reportPaneAgent,
  type HerdrAgent,
  type PaneAgentState,
} from "./herdr.ts";
import {
  launchAttempt,
  startPaneStreamTail,
  withLaunchDetail,
  type AttemptEnv,
  type AttemptHandle,
  type PaneTailer,
} from "./attempt-run.ts";
import { buildConversationTeaching } from "./prompt.ts";
import {
  conversationEndedNoticeText,
  diffStatSummary,
  ticketEndedNoticeText,
  type Notice,
} from "./notices.ts";
import type { PaneReadRegister } from "./pane-reads.ts";
import { listedAsRecorded, type PaneListing } from "./pane-survey.ts";
import { READINESS_TIMEOUT_MS, stillWorkingReason, typeVerified } from "./pane-session.ts";
import { defaultHarnessDescriptors, idlePatternFor, type HarnessDescriptor } from "./spawn.ts";
import { FRESH_TURN, IDLE_STABLE_READS, nextTurnState, type TurnSide, type TurnState } from "./turn-state.ts";
import {
  assignmentViewOf,
  DEFAULT_DRIVERS,
  resolveAssignment,
  type AssignmentView,
} from "./assignment.ts";
import type { Interrupt, PoolConfig } from "./engine.ts";

// ---------------------------------------------------------------------------
// Storage: the marker format and its parser, in the style of pool.ts.
// ---------------------------------------------------------------------------

const CONVERSATION_STATUSES = ["live", "ended", "crashed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * What an enlisted Conversation was found as (issue #101): the pane the
 * operator opened, its tab, its directory and branch as found, and the
 * harness session herdr reported. Absent for a started Conversation, which
 * has an engine-made worktree of its own; present exactly when the operator
 * enlisted an existing terminal. A live enlisted record is re-adopted at
 * boot when its pane is still in herdr's listing.
 */
export interface EnlistedConversation {
  paneId: string;
  tabId: string | null;
  directory: string;
  branch: string;
  sessionId: string | null;
}

export interface ConversationRecord {
  id: string;
  file: string;
  title: string;
  opening: string;
  status: ConversationStatus;
  spawnedBy?: string;
  harness: string;
  model: string;
  drivers: string;
  enlisted?: EnlistedConversation;
}

export const CONVERSATION_MARKER_RE = /^<!--\s*conversation:\s*(.+?)\s*-->\s*$/;

function parseConversationMarkerLine(
  line: string,
  file: string,
): Omit<ConversationRecord, "file" | "title" | "opening"> {
  const match = CONVERSATION_MARKER_RE.exec(line);
  if (!match) {
    throw new Error(
      `conversation load: ${file} has no line-1 conversation marker ` +
        "(expected <!-- conversation: id=.. status=.. -->)",
    );
  }
  const fields = new Map<string, string>();
  for (const pair of match[1].split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) fields.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const id = fields.get("id");
  const status = fields.get("status");
  if (!id) throw new Error(`conversation load: ${file}: marker is missing id=`);
  if (!status || !(CONVERSATION_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `conversation load: ${file}: marker status must be one of ` +
        `${CONVERSATION_STATUSES.join("|")}, got '${status ?? ""}'`,
    );
  }
  const spawnedByRaw = fields.get("spawned-by");
  const spawnedBy =
    spawnedByRaw && spawnedByRaw !== "none" ? decodeURIComponent(spawnedByRaw) : undefined;
  // Enlist provenance (issue #101): written only for an enlisted
  // Conversation, so its absence is the ordinary started one.
  const paneRaw = fields.get("pane");
  const enlisted =
    paneRaw && paneRaw !== "none"
      ? {
          paneId: decodeURIComponent(paneRaw),
          tabId: fields.get("tab") ? decodeURIComponent(fields.get("tab")!) : null,
          directory: decodeURIComponent(fields.get("directory") ?? ""),
          branch: decodeURIComponent(fields.get("branch") ?? ""),
          sessionId: fields.get("session") ? decodeURIComponent(fields.get("session")!) : null,
        }
      : undefined;
  return {
    id,
    status: status as ConversationStatus,
    ...(spawnedBy ? { spawnedBy } : {}),
    harness: decodeURIComponent(fields.get("harness") ?? ""),
    model: decodeURIComponent(fields.get("model") ?? ""),
    drivers: decodeURIComponent(fields.get("drivers") ?? ""),
    ...(enlisted ? { enlisted } : {}),
  };
}

function markerLine(rec: Omit<ConversationRecord, "file" | "title" | "opening">): string {
  const fields = [
    `id=${rec.id}`,
    `status=${rec.status}`,
    `spawned-by=${rec.spawnedBy ? encodeURIComponent(rec.spawnedBy) : "none"}`,
    `harness=${encodeURIComponent(rec.harness)}`,
    `model=${encodeURIComponent(rec.model)}`,
    `drivers=${encodeURIComponent(rec.drivers)}`,
    ...(rec.enlisted
      ? [
          `pane=${encodeURIComponent(rec.enlisted.paneId)}`,
          `tab=${rec.enlisted.tabId ? encodeURIComponent(rec.enlisted.tabId) : "none"}`,
          `directory=${encodeURIComponent(rec.enlisted.directory)}`,
          `branch=${encodeURIComponent(rec.enlisted.branch)}`,
          `session=${rec.enlisted.sessionId ? encodeURIComponent(rec.enlisted.sessionId) : "none"}`,
        ]
      : []),
  ];
  return `<!-- conversation: ${fields.join(" ")} -->`;
}

// The issue file's heading grammar, mirrored from pool.ts: the title is the
// first "# " heading, the opening Turn everything after it.
function readTitle(lines: string[]): string {
  const firstHeading = lines.find((line) => line.startsWith("# "));
  if (!firstHeading) return "(untitled)";
  return firstHeading.replace(/^#\s+/, "").trim();
}

function readOpening(lines: string[]): string {
  const headingIndex = lines.findIndex((line) => line.startsWith("# "));
  return lines.slice(headingIndex + 1).join("\n").trim();
}

export function readConversation(file: string): ConversationRecord {
  const lines = readFileSync(file, "utf8").split("\n");
  const marker = parseConversationMarkerLine(lines[0], file);
  return { ...marker, file, title: readTitle(lines), opening: readOpening(lines) };
}

/** Every Conversation on disk, sorted by file name. An absent directory reads as none: a pool with no Conversations yet is ordinary, unlike issues/. */
export function loadConversations(dir: string): ConversationRecord[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  return files.map((file) => readConversation(join(dir, file)));
}

export function writeConversation(dir: string, rec: ConversationRecord): void {
  mkdirSync(dir, { recursive: true });
  const body = [`# ${rec.title}`, "", rec.opening].join("\n");
  writeFileSync(rec.file, `${markerLine(rec)}\n\n${body}\n`);
}

export function writeConversationStatus(file: string, status: ConversationStatus): void {
  const raw = readFileSync(file, "utf8");
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(newline);
  if (!CONVERSATION_MARKER_RE.test(lines[0])) {
    throw new Error(`conversation marker write: ${file} has no line-1 marker`);
  }
  lines[0] = lines[0].replace(/status=[a-z]+/, `status=${status}`);
  writeFileSync(file, lines.join(newline));
}

/** The next operator-started id: `conv-N`, one past the highest existing and
 *  clear of any start still in flight. Spawned Conversations get
 *  `<parent>-spawn-N` instead, assigned by nextConversationSpawnId below. */
export function nextConversationId(
  existing: ConversationRecord[],
  reserved: ReadonlySet<string> = new Set(),
): string {
  const nums = existing
    .map((r) => /^conv-(\d+)$/.exec(r.id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  let n = nums.length ? Math.max(...nums) : 0;
  let id: string;
  do {
    n += 1;
    id = `conv-${n}`;
  } while (reserved.has(id));
  return id;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A spawned Conversation's id: `<parent>-spawn-N`, the same namespace ADR-0010 reserves for spawned tickets (pool.ts's parseSpawnId), N counting per parent. */
function nextConversationSpawnId(parentId: string, existing: ConversationRecord[]): string {
  const re = new RegExp(`^${escapeRegExp(parentId)}-spawn-(\\d+)$`);
  const nums = existing
    .map((r) => re.exec(r.id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return `${parentId}-spawn-${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

function conversationsDir(poolDir: string): string {
  return join(poolDir, "conversations");
}

function conversationFile(poolDir: string, id: string): string {
  return join(conversationsDir(poolDir), `${id}.md`);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// The runtime: one record per live Conversation, owned by the module.
// ---------------------------------------------------------------------------

export interface ConversationRuntime {
  id: string;
  file: string;
  paneId: string | null;
  tabId: string | null;
  worktree: WorktreeInfo;
  exitCodePath: string;
  streamPath: string;
  logPath: string;
  /** True when the operator enlisted a pane they opened (issue #101): the
   *  worktree is the found directory, the tab and directory are never closed
   *  or removed, and End merges the found branch and leaves both as they
   *  are. */
  enlisted: boolean;
  // The agent identity this Conversation's pane is reported under in
  // herdr's agent sidebar (issue #94): the harness the Assignment resolved,
  // and the pane's tab label as the message every report carries.
  harness: string;
  label: string;
  // Stored whole and replaced whole on every tick (engine/turn-state.ts).
  turn: TurnState;
  // The follow-file tailer deriving the log from the pane's Stream file
  // (ADR-0012), started by the launch and finished by End or crash so the
  // derived log is complete.
  tailer?: PaneTailer | null;
  // Notices from spawned work that ended, delivered as a Turn once the tick
  // sees this Conversation waiting.
  notices: Notice[];
  // Set the moment End is called; guards the background crash watcher
  // (watchForCrash) from racing the ending it already knows about.
  ending: boolean;
  closing?: string;
  /** False when this Conversation's tabs may not be closed by id: a runtime
   *  rebuilt for an End whose pane herdr lists as something else (issue
   *  #139), where the id no longer names this Conversation's terminal. */
  closeTabs?: boolean;
  release: AbortController;
  // The 2 s tick: pane read, Turn state, Notice delivery, spawn proposals.
  // Cleared at End, crash and dispose.
  timer: ReturnType<typeof setInterval> | null;
}

const CONVERSATION_POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// The wire view (PoolSnapshot.conversations).
// ---------------------------------------------------------------------------

export interface ConversationView {
  id: string;
  title: string;
  status: ConversationStatus;
  spawnedBy: string | null;
  assignment: AssignmentView;
  paneId: string | null;
  branch: string | null;
  turn: { state: TurnSide; lastLine: string; idleSince: string | null };
  children: string[];
  /** Enlisted from a live herdr pane (issue #101): the card reads "as found"
   *  where a started Conversation names its model. */
  enlisted: boolean;
}

export interface StartConversationRequest {
  title: string;
  opening?: string;
  assign?: { harness?: string; model?: string; drivers?: string };
  spawnedBy?: string;
  // Spawn adoption (engine.ts's adoptSpawnProposals) precomputes a
  // collision-free id shared across a parent's ticket-spawn and
  // Conversation-spawn counters before calling this: the two are otherwise
  // numbered independently (nextConversationSpawnId below only counts
  // existing Conversation records) and could mint the same `<parent>-spawn-N`
  // a sibling ticket spawn already claimed. When given, used verbatim
  // instead of computing one. Absent for every operator-started call (the
  // Console form) and every existing direct test, whose id keeps coming from
  // nextConversationId/nextConversationSpawnId.
  id?: string;
}

// What the two ticket-ending hooks need of a Ticket: the marker's id, title
// and spawned-by, nothing more.
export interface TicketLike {
  id: string;
  title: string;
  spawnedBy?: string;
}

/**
 * A live pane the operator enlists as a Conversation (issue #101): the found
 * facts the engine recorded, the operator's title and optional opening Turn,
 * and an id the engine minted before applying the branch rule (so the pool
 * branch, the record file and the spawn-proposal path all name it). No assign
 * and no spawnedBy: an enlisted Conversation is as found.
 */
export interface EnlistConversationRegistration {
  id: string;
  paneId: string;
  tabId: string | null;
  /** herdr's agent label: the harness the pane is running. */
  harness: string;
  title: string;
  opening?: string;
  directory: string;
  branch: string;
  sessionId: string | null;
}

export type EnlistConversationResult =
  | { ok: true; view: ConversationView }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// The module: what it takes and what it exposes.
// ---------------------------------------------------------------------------

/**
 * The pool facts a Conversation runs against: the Attempt-run environment
 * (ADR-0014) plus the pool directory, the checkout and whether git is there.
 * Built once at startPool; the terminal setting and agents file never
 * reload (ADR-0018 reloads only the assignment slice), so nothing here goes
 * stale.
 */
export interface ConversationEnv extends AttemptEnv {
  poolDir: string;
  cwd: string;
  git: boolean;
  /** Where each tick's viewport read is recorded for the card Peek (issue #122). */
  paneReads: PaneReadRegister;
  /** How often a live Conversation's tick re-reads its pane; 2 s unless a
   *  test shortens it (the enlisted-attempts module's own pollMs precedent). */
  pollMs?: number;
  /** How long an enlist waits for a working pane to reach waiting so the
   *  teaching Turn can be typed (issue #101); a Launch's readiness bound
   *  unless a test shortens it. */
  teachingWaitMs?: number;
}

/**
 * The engine operations a Conversation may call, implemented in engine.ts
 * by one small function over its Session. Everything the engine owns and a
 * Conversation touches goes through here: the snapshot stream, the
 * interrupt list, the merge chain, the spawn queue, the assignment table,
 * the pool's markers and its live config.
 */
export interface ConversationHost {
  /** Publish a snapshot now: a Conversation's start, end, crash and Turn changes all happen off the drive loop, so nothing else would. */
  publish(): void;
  raiseInterrupt(interrupt: Interrupt): void;
  clearInterrupt(interrupt: Interrupt, log: string): void;
  /** Hand a conflicted merge to the resolver machinery; settles once the resulting interrupt is raised. */
  resolveConflict(marker: TicketMarker, result: MergeResult, attempt: number): Promise<void>;
  /** Close every herdr tab opened under this id: the launch's, and any resolver run's. */
  closeAttemptTabs(id: string): void;
  /** Run `work` after every merge queued before it, so no two merges touch the checkout at once; settles as `work` does. */
  chainMerge(work: () => Promise<void> | void): Promise<void>;
  /** The branch the pool merges into: the pool checkout's, or the target an enlist captured when it moved that checkout (issue #101). */
  mergeTargetBranch(): string;
  /** Merge `branch` into the merge target, in whichever checkout holds it (issue #101): the engine's, never one an enlisted agent works in. Call inside `chainMerge`. */
  mergeIntoTarget(branch: string): MergeResult;
  /** Validate and adopt a Conversation's raw spawn proposals (the `spawn` field of its spawn.json): `onRejected` is handed the malformed entries for the module to log before the survivors are queued, adopted at once when the engine is idle. */
  adoptSpawns(parentId: string, raw: unknown, onRejected: (rejections: { index?: number; reason: string }[]) => void): void;
  /** Record a Conversation's resolved Assignment under its id (if not already known) so work it spawns inherits it. */
  recordAssignment(id: string, assignment: { harness: string; model: string; drivers: string }): void;
  /** The pool's Tickets as the engine currently knows them. */
  markers(): readonly TicketMarker[];
  /** Add one line to the pool log, published with the next snapshot. */
  log(line: string): void;
  /** A tab this module closed: the pane survey lists again, so the snapshot's Finished terminals count drops at once. */
  tabClosed(): void;
  /** The live pool config. */
  config(): PoolConfig;
}

export interface ConversationModule {
  /** Start a Conversation; throws when the pool cannot host one at all. */
  start(req: StartConversationRequest): Promise<ConversationView>;
  /**
   * Claim a live pane the operator opened as a Conversation (issue #101),
   * skipping the launch: settle its Turn state, report the agent identity,
   * relabel its tab, write the record and queue the teaching and opening
   * Turns through the Notice path. Resolves a reason on failure, having
   * removed anything it wrote.
   */
  enlist(req: EnlistConversationRegistration): Promise<EnlistConversationResult>;
  /** End a Conversation the operator is done with. */
  end(id: string, closing?: string): Promise<void>;
  /** A merge-conflict or merge-approval answer whose id names a live Conversation. */
  answerMerge(id: string, interrupt: Interrupt, approve: boolean | undefined): void;
  /** Every Conversation the pool knows about, live or not, as the snapshot wants them. */
  views(): ConversationView[];
  /** Crash every Conversation recorded live by a previous engine run (they do not resume), except enlisted ones, which adoptEnlistedAtBoot re-adopts while their pane lives. */
  crashStaleAtBoot(): void;
  /** Re-adopt live enlisted Conversations whose pane is still in herdr's listing; crash the ones whose pane is gone. Best effort: a daemon that cannot be asked changes nothing. */
  adoptEnlistedAtBoot(): Promise<void>;
  /** Re-adopt live started Conversations whose pane is still theirs and whose TUI still runs (issue #140); crash the rest and close their tabs. Best effort, as above. */
  adoptStartedAtBoot(): Promise<void>;
  /** Try both adoptions again for live records a boot could not settle (the daemon did not answer, or a pane could not be read); a no-op when there are none or a try is in flight. */
  readoptPending(): Promise<void>;
  /** Every pane and tab a Conversation recorded live names, runtime or not: no close, and no enlist, may take one while its record is live. */
  liveTerminals(): { panes: Set<string>; tabs: Set<string> };
  /** Where every live Conversation works, enlisted ones included: its worktree or found directory. */
  liveDirectories(): { id: string; cwd: string }[];
  /** A spawned Ticket reached done: notify its parent Conversation, if any. */
  ticketEnded(marker: TicketLike, branch: string, diffRange: string | null): void;
  /** A spawned Ticket checkpointed: notify its parent Conversation, if any. */
  ticketCheckpointed(marker: TicketLike, brief: string): void;
  /** Whether a Conversation is live right now (ending included). */
  isLive(id: string): boolean;
  /** Ids of Conversations whose start is still in flight and has no record on disk yet. */
  reservedIds(): Iterable<string>;
  /** Stop every tick; called at shutdown. Runtimes are left as they are. */
  dispose(): void;
}

export function createConversations(env: ConversationEnv, host: ConversationHost): ConversationModule {
  const dir = conversationsDir(env.poolDir);
  const pollMs = env.pollMs ?? CONVERSATION_POLL_MS;
  const teachingWaitMs = env.teachingWaitMs ?? READINESS_TIMEOUT_MS;
  const runtimes = new Map<string, ConversationRuntime>();
  // Ids of starts still in flight (start is async and its record is
  // written well after the herdr tab opens): engine.ts's spawn counters
  // fold these in so a second adoption before the record lands can never
  // mint the same `<parent>-spawn-N` twice.
  const reserved = new Set<string>();

  function publish(): void {
    host.publish();
  }

  function event(id: string, kind: TicketEventKind, payload: Record<string, unknown>, attempt = 1): void {
    appendEvent(env.runsDir, id, { at: nowIso(), attempt, kind, payload });
  }

  // -------------------------------------------------------------------------
  // The pane's agent identity in herdr's sidebar (issue #94). A Conversation
  // is the one Attempt with a Turn state, so it is the one whose reported
  // state moves: "working" while the agent works, "blocked" while it waits
  // on the operator, which is herdr's word for "a human is what it needs".
  // Both calls are fire-and-forget and swallow their failures, exactly as
  // the tab closes do: the sidebar is a convenience, never a dependency.
  // -------------------------------------------------------------------------

  function reportAgent(runtime: ConversationRuntime, state: PaneAgentState): void {
    if (!runtime.paneId) return;
    void reportPaneAgent(
      env.herdrSocket,
      runtime.paneId,
      runtime.harness.toLowerCase(),
      state,
      runtime.label,
    ).catch(() => {});
  }

  function releaseAgent(paneId: string | null, harness: string): void {
    if (!paneId) return;
    void releasePaneAgent(env.herdrSocket, paneId, harness.toLowerCase()).catch(
      () => {},
    );
  }

  /**
   * One Turn-state read from the pane, publishing when the read changes what
   * the snapshot shows and reporting the herdr sidebar state on a flip. A
   * failed read throws and leaves the state as it was; the caller decides
   * whether that is fatal (the enlist claim) or one tick's blip.
   *
   * The read is of the viewport only (`visible`, issue #122): Turn state
   * needs no more than the prompt area at the bottom, and a scrollback read
   * moves the viewport of the operator sitting in the pane. What was read
   * is recorded for the card Peek, so this is the one read of the pane per
   * tick.
   */
  async function readTurn(
    runtime: ConversationRuntime,
    descriptor: HarnessDescriptor | null,
  ): Promise<void> {
    if (!runtime.paneId) return;
    const text = await peekPane(env.herdrSocket, runtime.paneId, { source: "visible" });
    const at = nowIso();
    env.paneReads.record(runtime.paneId, text, at);
    const { turn, publish: changed } = nextTurnState(
      runtime.turn,
      text,
      descriptor ? idlePatternFor(descriptor) : "",
      at,
    );
    const flipped = runtime.turn.state !== turn.state;
    runtime.turn = turn;
    if (changed) publish();
    if (flipped) {
      reportAgent(runtime, turn.state === "waiting" ? "blocked" : "working");
    }
  }

  /**
   * The runtime for an enlisted Conversation (issue #101): the found pane's
   * facts, the found directory and branch standing in as its worktree, no
   * tailer and no engine-owned exit-code or Stream file, since the operator
   * opened the pane. Shared by the live enlist and the boot re-adoption so
   * the two claims cannot drift.
   */
  function enlistedRuntime(rec: {
    id: string;
    file: string;
    paneId: string;
    tabId: string | null;
    harness: string;
    title: string;
    directory: string;
    branch: string;
  }): ConversationRuntime {
    return {
      id: rec.id,
      file: rec.file,
      paneId: rec.paneId,
      tabId: rec.tabId,
      worktree: { path: rec.directory, branch: rec.branch },
      exitCodePath: join(env.runsDir, `${rec.id}.exit`),
      streamPath: join(env.runsDir, `${rec.id}.stream.jsonl`),
      logPath: join(env.runsDir, `${rec.id}.log`),
      enlisted: true,
      harness: rec.harness,
      label: attemptTabLabel(rec.id, rec.title),
      turn: FRESH_TURN,
      notices: [],
      ending: false,
      release: new AbortController(),
      timer: null,
    };
  }

  /**
   * Settle a freshly claimed pane's Turn state from consecutive reads (the
   * same rule turn-state.ts applies on its own tick): one read establishes
   * the transcript, then IDLE_STABLE_READS more with the idle pattern present
   * flip the state to waiting. A throw leaves the caller to decide whether
   * that is fatal (the enlist claim) or one boot's blip (the re-adoption).
   */
  async function settleTurn(
    runtime: ConversationRuntime,
    descriptor: HarnessDescriptor | null,
  ): Promise<void> {
    for (let read = 0; read <= IDLE_STABLE_READS; read++) {
      await readTurn(runtime, descriptor);
      if (runtime.turn.state === "waiting") break;
    }
  }

  // -------------------------------------------------------------------------
  // Views.
  // -------------------------------------------------------------------------

  function childrenOf(id: string, conversations: ConversationRecord[]): string[] {
    const tickets = host
      .markers()
      .filter((m) => m.spawnedBy === id)
      .map((m) => m.id);
    const kids = conversations.filter((c) => c.spawnedBy === id).map((c) => c.id);
    return [...tickets, ...kids];
  }

  function viewOf(rec: ConversationRecord, conversations: ConversationRecord[]): ConversationView {
    const runtime = runtimes.get(rec.id);
    // An enlisted Conversation has no pool branch to derive: the branch it
    // was found on is the one its record names.
    const branch = runtime
      ? runtime.worktree.branch
      : (rec.enlisted?.branch ?? branchFor(env.cwd, rec.id));
    return {
      id: rec.id,
      title: rec.title,
      status: rec.status,
      spawnedBy: rec.spawnedBy ?? null,
      // A record written before drivers were stored reads as the default.
      assignment: assignmentViewOf({ ...rec, drivers: rec.drivers || DEFAULT_DRIVERS }),
      // A live record the engine has not re-adopted yet (issue #140) still
      // names its pane, so the pane stays the pool's in every surface that
      // reads the view: the enlist picker, the terminal routes.
      paneId: runtime?.paneId ?? (rec.status === "live" ? recordedPaneOf(rec) : null),
      // A conversation with no live runtime (ended cleanly, or never tracked
      // across a restart) has no branch worth naming once it merged; a
      // git-less pool has none at all. Neither is an error: the card simply
      // shows nothing to look at.
      branch: env.git ? branch : null,
      turn: runtime
        ? { state: runtime.turn.state, lastLine: runtime.turn.lastLine, idleSince: runtime.turn.idleSince }
        : { state: "waiting", lastLine: "", idleSince: null },
      children: childrenOf(rec.id, conversations),
      enlisted: rec.enlisted !== undefined,
    };
  }

  function views(): ConversationView[] {
    const conversations = loadConversations(dir);
    return conversations.map((rec) => viewOf(rec, conversations));
  }

  // -------------------------------------------------------------------------
  // Boot: a Conversation recorded live when the engine last ran may still be
  // talking in its pane, since a shutdown leaves every pane and TUI as it is.
  // Its pane decides (the ADR-0018 amendment of issue #140): re-adopted while
  // the pane is still its own and its TUI still runs, crashed otherwise, with
  // its tab closed only when the tab is still its own. Only one with no pane to ask about (a headless pool,
  // or a record with no launch on it) is crashed here, at once.
  // -------------------------------------------------------------------------

  function crashStaleAtBoot(): void {
    for (const rec of loadConversations(dir)) {
      if (rec.status !== "live") continue;
      // An enlisted Conversation gets a chance to re-adopt first
      // (adoptEnlistedAtBoot below): its pane is the operator's, still
      // alive, and the record names it.
      if (rec.enlisted) continue;
      // A started one with a pane on record gets the same chance
      // (adoptStartedAtBoot), once the Pool workspace is known.
      if (env.terminalBacked && launchOf(rec.id) !== null) continue;
      writeConversationStatus(rec.file, "crashed");
      event(rec.id, "crash", {
        reason: "engine restarted and the Conversation had no pane to re-adopt",
      });
    }
  }

  // A started Conversation's launch as its `spawned` event recorded it: the
  // pane and tab it ran in, where, and when. Null for none.
  function launchOf(
    id: string,
  ): {
    paneId: string;
    tabId: string | null;
    cwd: string | null;
    terminalId: string | null;
    at: string;
  } | null {
    const spawned = readEvents(env.runsDir, id)
      .filter((e) => e.kind === "spawned" && typeof e.payload.pane_id === "string")
      .pop();
    if (!spawned) return null;
    return {
      paneId: spawned.payload.pane_id as string,
      tabId: typeof spawned.payload.tab_id === "string" ? spawned.payload.tab_id : null,
      cwd: typeof spawned.payload.cwd === "string" ? spawned.payload.cwd : null,
      terminalId:
        typeof spawned.payload.terminal_id === "string" ? spawned.payload.terminal_id : null,
      at: spawned.at,
    };
  }

  // The pane a Conversation record names: the found one for an enlisted
  // Conversation, its launch's for a started one.
  function recordedPaneOf(rec: ConversationRecord): string | null {
    return rec.enlisted?.paneId ?? launchOf(rec.id)?.paneId ?? null;
  }

  function liveTerminals(): { panes: Set<string>; tabs: Set<string> } {
    const panes = new Set<string>();
    const tabs = new Set<string>();
    for (const rec of loadConversations(dir)) {
      if (rec.status !== "live") continue;
      const launch = launchOf(rec.id);
      const paneId = rec.enlisted?.paneId ?? launch?.paneId ?? null;
      const tabId = rec.enlisted ? rec.enlisted.tabId : (launch?.tabId ?? null);
      if (paneId) panes.add(paneId);
      if (tabId) tabs.add(tabId);
    }
    return { panes, tabs };
  }

  // Whether the operator asked this Conversation to End and the End never
  // finished (issue #140): an engine that stopped mid-End leaves the record
  // live, and the next boot finishes it as the ending it was.
  function endRequested(id: string): boolean {
    const events = readEvents(env.runsDir, id);
    const asked = events.map((e) => e.kind).lastIndexOf("end-requested");
    return asked !== -1 && !events.slice(asked).some((e) => e.kind === "ended");
  }

  // One listing of herdr's panes, or null when the daemon could not be asked.
  async function paneListing(): Promise<PaneListing | null> {
    try {
      const listed = await listPanes(env.herdrSocket);
      return {
        panes: new Map(listed.map((pane) => [pane.paneId, pane])),
        tabs: new Set(listed.flatMap((pane) => (pane.tabId === null ? [] : [pane.tabId]))),
      };
    } catch {
      return null;
    }
  }

  // Whether a tab herdr lists holds none of the recorded pane: its id was
  // reused, and closing it by id would close someone else's terminal.
  function tabIsForeign(
    listing: PaneListing,
    launch: { paneId: string; tabId: string | null; terminalId: string | null },
  ): boolean {
    if (launch.tabId === null) return false;
    const inTab = [...listing.panes.values()].filter((pane) => pane.tabId === launch.tabId);
    if (inTab.length === 0) return false;
    return !inTab.some(
      (pane) =>
        pane.paneId === launch.paneId &&
        (launch.terminalId === null || pane.terminalId === null || pane.terminalId === launch.terminalId),
    );
  }

  // Boot adoption, one pass at a time: the boot's own and a later retry off
  // the pane survey never claim the same record twice.
  let adopting: Promise<void> = Promise.resolve();
  let retrying = false;
  function serially(pass: () => Promise<void>): Promise<void> {
    const run = adopting.then(pass, pass);
    adopting = run.catch(() => {});
    return run;
  }

  function readoptPending(): Promise<void> {
    if (retrying || !env.terminalBacked) return Promise.resolve();
    const pending = loadConversations(dir).some(
      (rec) => rec.status === "live" && !runtimes.has(rec.id),
    );
    if (!pending) return Promise.resolve();
    retrying = true;
    return serially(async () => {
      await adoptEnlistedPass();
      await adoptStartedPass();
    }).finally(() => {
      retrying = false;
    });
  }

  /**
   * Re-adopt live started Conversations at boot (issue #140, the ADR-0018
   * amendment). A Restart or Stop leaves the pane and its TUI running, so a
   * restart no longer ends the talk. The recorded pane decides, against one
   * listing of herdr's panes:
   *
   * - listed as recorded (listedAsRecorded: its terminal id, or the same
   *   tab, the Pool workspace and the recorded directory, ADR-0027) with
   *   its TUI still running: re-adopted, its runtime back the way a launch
   *   leaves it: the tab, so End closes it; the derived log, re-derived
   *   whole from its Stream file; the Turn-state tick and the Notice queue
   *   (empty: Notices were never persisted, and one dropped at shutdown was
   *   logged as dropped); the Live attempt; and the crash watch.
   * - listed as recorded with its TUI exited, or gone from the listing:
   *   crashed with its branch kept, its agent identity released and its tab
   *   closed, so a Restart never leaves a tab open for good.
   * - listed, but as something else: crashed and left exactly as it is for
   *   the operator, tab and agent untouched, because the id no longer names
   *   this Conversation's terminal.
   *
   * An End that was in flight when the engine stopped is finished as the
   * ending it was, whatever the pane's state. A daemon that cannot be asked
   * changes nothing: the records stay live, their panes stay the pool's, and
   * the pane survey's next listing tries again.
   */
  function adoptStartedAtBoot(): Promise<void> {
    return serially(adoptStartedPass);
  }

  async function adoptStartedPass(): Promise<void> {
    if (!env.terminalBacked) return;
    const live = loadConversations(dir).filter(
      (rec) =>
        rec.status === "live" &&
        rec.enlisted === undefined &&
        !runtimes.has(rec.id) &&
        launchOf(rec.id) !== null,
    );
    if (live.length === 0) return;
    const listing = await paneListing();
    if (listing === null) return;
    const workspaceId = await env.poolWorkspace.id();
    for (const rec of live) {
      const launch = launchOf(rec.id)!;
      if (endRequested(rec.id)) {
        await end(rec.id, undefined, listing).catch(() => {});
        continue;
      }
      const exitCodePath = join(env.runsDir, attemptExitCodeName(rec.id, null, false));
      const tuiExited =
        existsSync(exitCodePath) && statSync(exitCodePath).mtimeMs >= Date.parse(launch.at);
      const listed = listing.panes.has(launch.paneId);
      const ours = listedAsRecorded(listing, launch, workspaceId);
      if (listed && !ours) {
        writeConversationStatus(rec.file, "crashed");
        event(rec.id, "crash", {
          reason: `engine restarted and herdr lists pane ${launch.paneId} as another terminal`,
        });
        host.log(
          `conversation ${rec.id}: crashed at boot; herdr lists its pane ${launch.paneId} ` +
            "as another terminal, so its tab and agent were left as they are",
        );
        publish();
        continue;
      }
      if (!listed || tuiExited) {
        crashAtBoot(rec, launch, listing, tuiExited ? "its TUI had exited" : "its pane was gone");
        continue;
      }
      const descriptor = defaultHarnessDescriptors[rec.harness.trim().toLowerCase()] ?? null;
      const runtime = startedRuntime(rec, launch.tabId);
      try {
        await settleTurn(runtime, descriptor);
      } catch {
        // The pane could not be read: leave the record live, as for an
        // enlisted one; the survey's next listing tries again rather than
        // ending a talk that may still be there. No tick follows, so nothing
        // may serve what the reads recorded.
        env.paneReads.forget(launch.paneId);
        continue;
      }
      runtime.tailer = startPaneStreamTail(runtime.streamPath, runtime.logPath);
      reportAgent(runtime, runtime.turn.state === "waiting" ? "blocked" : "working");
      runtimes.set(rec.id, runtime);
      env.liveAttempts.register(rec.id, 1, {
        paneId: launch.paneId,
        tabId: launch.tabId,
        startedAt: launch.at,
      });
      watchForCrash(runtime);
      host.recordAssignment(rec.id, {
        harness: rec.harness,
        model: rec.model,
        drivers: rec.drivers || DEFAULT_DRIVERS,
      });
      runtime.timer = setInterval(() => tick(rec.id), pollMs);
      host.log(`conversation ${rec.id}: re-adopted at boot from live pane ${launch.paneId}`);
      publish();
    }
  }

  // A started Conversation's runtime rebuilt from its record and launch,
  // with no tick, tailer or watch yet: the boot adoption adds those, an End
  // with no runtime (issue #140) needs none.
  function startedRuntime(rec: ConversationRecord, tabId: string | null): ConversationRuntime {
    const launch = launchOf(rec.id);
    return {
      id: rec.id,
      file: rec.file,
      paneId: launch?.paneId ?? null,
      tabId,
      worktree: { path: worktreePathFor(env.cwd, rec.id), branch: branchFor(env.cwd, rec.id) },
      exitCodePath: join(env.runsDir, attemptExitCodeName(rec.id, null, false)),
      streamPath: join(env.runsDir, attemptStreamName(rec.id, null, false)),
      logPath: join(env.runsDir, attemptLogName(rec.id, null, false)),
      enlisted: false,
      harness: rec.harness,
      label: attemptTabLabel(rec.id, rec.title),
      turn: FRESH_TURN,
      notices: [],
      ending: false,
      release: new AbortController(),
      timer: null,
    };
  }

  // A started Conversation found dead at boot: crashed as before, branch
  // kept, plus what a crash while the engine ran would have done and a dead
  // engine could not: its agent identity released and its tab closed. The
  // tab is closed unless herdr lists it holding none of this launch's pane
  // (a reused id); a tab herdr no longer has is closed already; a refusal is
  // logged (tab-close-failed).
  function crashAtBoot(
    rec: ConversationRecord,
    launch: { paneId: string; tabId: string | null; terminalId: string | null },
    listing: PaneListing,
    why: string,
  ): void {
    writeConversationStatus(rec.file, "crashed");
    event(rec.id, "crash", { reason: `engine restarted and ${why}` });
    host.log(`conversation ${rec.id}: crashed at boot, ${why}; its tab is closed`);
    releaseAgent(launch.paneId, rec.harness);
    publish();
    if (launch.tabId === null || tabIsForeign(listing, launch)) return;
    void closeConversationTab(rec.id, launch.tabId, "crashed at boot");
  }

  /**
   * Re-adopt live enlisted Conversations at boot (issue #101): the operator's
   * pane may still be there, and the record names it, so a fresh runtime
   * re-tracks Turn state, delivers Notices and Spawns again. A pane that has
   * left herdr's listing is the crash ADR-0018 prescribes, branch kept.
   * Best effort, like the terminal-attempt reconcile beside it: a daemon that
   * cannot be asked changes nothing, and the records stay live for the next
   * boot.
   */
  function adoptEnlistedAtBoot(): Promise<void> {
    return serially(adoptEnlistedPass);
  }

  async function adoptEnlistedPass(): Promise<void> {
    if (!env.terminalBacked) return;
    const live = loadConversations(dir).filter(
      (rec) => rec.status === "live" && rec.enlisted !== undefined && !runtimes.has(rec.id),
    );
    if (live.length === 0) return;
    let agents: HerdrAgent[];
    try {
      agents = await listAgents(env.herdrSocket);
    } catch {
      return;
    }
    const listed = new Map(agents.map((agent) => [agent.paneId, agent]));
    for (const rec of live) {
      const found = rec.enlisted!;
      if (endRequested(rec.id)) {
        await end(rec.id).catch(() => {});
        continue;
      }
      if (!listed.has(found.paneId)) {
        // The pane went while the engine was down: crashed, branch kept.
        writeConversationStatus(rec.file, "crashed");
        event(rec.id, "crash", { reason: "enlisted pane gone at boot" });
        continue;
      }
      const descriptor = defaultHarnessDescriptors[rec.harness.trim().toLowerCase()];
      if (!descriptor) {
        writeConversationStatus(rec.file, "crashed");
        event(rec.id, "crash", {
          reason: `no harness the engine knows for enlisted conversation ${rec.id}`,
        });
        continue;
      }
      const runtime = enlistedRuntime({
        id: rec.id,
        file: rec.file,
        paneId: found.paneId,
        tabId: found.tabId,
        harness: rec.harness,
        title: rec.title,
        directory: found.directory,
        branch: found.branch,
      });
      try {
        await settleTurn(runtime, descriptor);
      } catch {
        // The pane could not be read: leave the record live, the next boot
        // tries again rather than destroying a talk that may still be there.
        // No tick follows, so nothing may serve what the reads recorded.
        env.paneReads.forget(found.paneId);
        continue;
      }
      reportAgent(runtime, runtime.turn.state === "waiting" ? "blocked" : "working");
      runtimes.set(rec.id, runtime);
      watchForCrash(runtime);
      host.recordAssignment(rec.id, {
        harness: rec.harness,
        model: rec.model,
        drivers: rec.drivers || DEFAULT_DRIVERS,
      });
      runtime.timer = setInterval(() => tick(rec.id), pollMs);
      publish();
    }
  }

  // -------------------------------------------------------------------------
  // Starting.
  // -------------------------------------------------------------------------

  function resolveStartAssignment(
    req: StartConversationRequest,
    existing: ConversationRecord[],
  ): { harness: string; model: string; drivers: string } {
    const parent = req.spawnedBy ? existing.find((r) => r.id === req.spawnedBy) : undefined;
    return resolveAssignment({
      subject: "conversation start:",
      request: req.assign,
      inherited: parent
        ? { harness: parent.harness, model: parent.model, drivers: parent.drivers }
        : undefined,
      defaults: host.config().defaults,
      strict: true,
      verify: false,
      harnesses: env.harnesses,
    });
  }

  /**
   * Start a Conversation: refuse a non-terminal pool, resolve its
   * Assignment, give it a worktree and branch, then launch it through the
   * Attempt-run module (ADR-0014's one code path): the named herdr tab, the
   * interactive harness under the ADR-0016 wrapper, the readiness wait, and
   * the opening Turn typed verbatim and echo verified. A Conversation has
   * no headless fallback (ADR-0018: it is a terminal-backed TUI or
   * nothing), so a tab or a launch command that could not be had is a
   * start failure. Throws only when the pool cannot host a Conversation at
   * all (headless, no git) or the launch never got a running pane; once the
   * record exists on disk it resolves even when the harness died before its
   * TUI, the TUI never became ready, or the opening Turn never landed,
   * reporting the Conversation crashed rather than losing the attempt to an
   * unstructured rejection.
   */
  async function start(req: StartConversationRequest): Promise<ConversationView> {
    if (!env.terminalBacked) {
      throw new Error(
        "conversation start: the pool is not terminal-backed (set " +
          'console.json terminal: "herdr")',
      );
    }
    if (!env.git) {
      throw new Error(
        "conversation start: the pool has no git checkout, so it cannot give " +
          "the Conversation its own worktree and branch",
      );
    }
    if (!req.title?.trim()) {
      throw new Error("conversation start: title is required");
    }
    const existing = loadConversations(dir);
    const id =
      req.id ??
      (req.spawnedBy
        ? nextConversationSpawnId(req.spawnedBy, existing)
        : nextConversationId(existing, reserved));
    // Reserved before the first await, so an adoption that reads the
    // reserved ids right after firing this start already sees it.
    reserved.add(id);
    try {
      return await launch(id, req, existing);
    } finally {
      reserved.delete(id);
    }
  }

  async function launch(
    id: string,
    req: StartConversationRequest,
    existing: ConversationRecord[],
  ): Promise<ConversationView> {
    const { harness, model, drivers } = resolveStartAssignment(req, existing);
    // Forked from the merge target, not the pool checkout's HEAD: once an
    // enlist has moved that checkout onto a created pool branch (issue
    // #101), HEAD there is the enlisted agent's branch, and a Conversation
    // forked from it would carry that agent's commits onto the target at End.
    const worktree = prepareWorktree(env.cwd, id, undefined, host.mergeTargetBranch());
    const file = conversationFile(env.poolDir, id);
    const opening = req.opening ?? "";
    // The spawn-teaching paragraph (prompt.ts) always lands, appended to the
    // opening Turn when there is one; typed alone otherwise, so an agent
    // given no opening still learns the propose-and-adopt mechanism before
    // the operator's first real Turn. spawnPath mirrors the events module's
    // outcome naming for a Conversation's own proposal channel:
    // `<id>.spawn.json` beside its `.outcome.json`, polled by this
    // Conversation's tick.
    const spawnPath = spawnProposalPath(id);
    const teaching = buildConversationTeaching(
      spawnPath,
      { harness, model, drivers },
      host.config().defaults,
    );
    const toType = opening.trim() ? `${opening}\n\n${teaching}` : teaching;

    // The launch: one attempt, the well-known file names, no rotation, no
    // headless fallback, the opening Turn as a plain prompt (no driver line:
    // a Conversation has no skill to invoke and no file-referencing
    // fallback, so a paste that never lands is a crash, not a silently empty
    // pane), and only the spawned event on the log; the crash and ending
    // events are the Conversation's own. `issuePath` points at the
    // Conversation's record so a custom harness that renders it never
    // points at nothing.
    let handle: AttemptHandle;
    try {
      handle = await launchAttempt(env, {
        id,
        issuePath: file,
        title: req.title,
        body: toType,
        driver: "converse",
        harness,
        model,
        cwd: worktree.path,
        branch: worktree.branch,
        attempt: 1,
        naming: { attempt: null, resolver: false },
        rotate: "none",
        fallback: "none",
        prompt: { kind: "plain", echo: opening.trim() || teaching },
        crashSubject: "harness",
        events: { kind: "spawned-only" },
      });
    } catch (err) {
      removeWorktree(env.cwd, worktree);
      throw new Error(
        `conversation start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const record: ConversationRecord = {
      id,
      file,
      title: req.title.trim(),
      opening,
      status: "live",
      ...(req.spawnedBy ? { spawnedBy: req.spawnedBy } : {}),
      harness,
      model,
      drivers,
    };
    writeConversation(dir, record);

    if (handle.kind === "ended") {
      // The harness died before its TUI came up (its own exit code,
      // ADR-0016), or the launch command never ran, the TUI never became
      // ready, or the opening Turn never landed (the engine's codes): the
      // launch is over. The record stays, marked crashed, so the event trail
      // is kept and the id is never reused, but the worktree and branch go
      // (issue #102, ADR-0018's amendment): the Conversation never went live,
      // so there is nothing in them to keep, and a pool where launching is a
      // coin flip would otherwise collect an orphaned pair per failure. A
      // Conversation that crashes after it went live keeps its branch
      // (markCrashed): the operator may have work in it. A crash, not a
      // rejection, matching every other pane-loss-without-End ending. The
      // launch keeps a pane whose harness died on its own (ADR-0014's
      // crashed-attempt rule), but this Conversation never joins the
      // runtimes, so nothing else would ever close the tab: it goes here, as
      // markCrashed's does.
      writeConversationStatus(file, "crashed");
      event(id, "crash", {
        code: handle.code,
        reason: withLaunchDetail(
          exitCrashReason(handle.code, handle.ctx.exitCodePath, "harness", handle.paneId),
          handle,
        ),
      });
      // The launch reported the pane's agent the moment the wrapper landed
      // (attempt-run.ts); this Conversation never got further, so the
      // identity goes with the ending, as at every other ending below.
      releaseAgent(handle.paneId, harness);
      env.liveAttempts.clear(id, 1);
      host.closeAttemptTabs(id);
      noteEnded(id, { branch: worktree.branch, crashed: true });
      discardWorktree(env.cwd, worktree);
      // Same reasoning as the success path below: this launch never touches
      // the drive loop, so nothing else would ever tell the snapshot stream
      // this Conversation existed at all.
      publish();
      return viewOf({ ...record, status: "crashed" }, loadConversations(dir));
    }

    const runtime: ConversationRuntime = {
      id,
      file,
      paneId: handle.paneId,
      tabId: handle.tabId,
      worktree,
      exitCodePath: handle.ctx.exitCodePath,
      streamPath: handle.ctx.streamPath ?? join(env.runsDir, `${id}.stream.jsonl`),
      logPath: handle.ctx.logPath,
      enlisted: false,
      harness,
      label: attemptTabLabel(id, req.title),
      turn: FRESH_TURN,
      tailer: handle.tailer,
      notices: [],
      ending: false,
      release: new AbortController(),
      timer: null,
    };
    runtimes.set(id, runtime);
    watchForCrash(runtime);
    // The Assignment under this Conversation's id, so a Ticket it spawns
    // whose spawned-by names it resolves the same way a grader or spawned
    // ticket inherits from its own parent.
    host.recordAssignment(id, { harness, model, drivers });
    runtime.timer = setInterval(() => tick(id), pollMs);
    // start is called directly off the PoolRun handle (the server route, or
    // a fire-and-forget spawn adoption), never through the drive loop, so
    // nothing else emits a snapshot that would tell the SSE stream this
    // Conversation now exists; a pool with no other ticket activity in
    // flight could otherwise go arbitrarily long before the next unrelated
    // emit.
    publish();
    return viewOf(record, loadConversations(dir));
  }

  /**
   * Enlist a live pane the operator opened as a Conversation (issue #101):
   * the launch `start` does minus the launch. The pane, tab, directory and
   * branch are taken as found, the agent identity is reported and the tab
   * relabelled, the record is written, and the Spawn teaching and the
   * operator's opening Turn are queued through the Notice path (typed now if
   * the pane is already waiting, otherwise on the tick's next waiting read).
   *
   * Resolves a reason rather than throwing when the pane cannot be claimed:
   * the caller (engine.ts's enlistConversation) unwinds the branch it may
   * have created and answers its 409. A failure after the record is written
   * removes the record, its events and the agent identity, so a failed
   * enlist leaves nothing.
   */
  async function enlist(req: EnlistConversationRegistration): Promise<EnlistConversationResult> {
    if (!env.terminalBacked) {
      return { ok: false, reason: "the pool is not terminal-backed" };
    }
    if (!env.git) {
      return { ok: false, reason: "the pool has no git checkout" };
    }
    const harness = req.harness.trim().toLowerCase();
    const descriptor = defaultHarnessDescriptors[harness];
    if (!descriptor) return { ok: false, reason: "no harness the engine knows" };

    // Reserved before the first await: the id is already fixed by the branch
    // rule the engine applied, so a concurrent start must not mint it too.
    reserved.add(req.id);
    try {
      const file = conversationFile(env.poolDir, req.id);
      const found: EnlistedConversation = {
        paneId: req.paneId,
        tabId: req.tabId,
        directory: req.directory,
        branch: req.branch,
        sessionId: req.sessionId,
      };
      const runtime = enlistedRuntime({
        id: req.id,
        file,
        paneId: req.paneId,
        tabId: req.tabId,
        harness,
        title: req.title,
        directory: req.directory,
        branch: req.branch,
      });

      // Settle the Turn state from consecutive reads, exactly as the
      // enlisted Ticket's claim does: an idle pane is taught now, and a
      // working one is given a Launch's readiness bound to reach waiting,
      // re-read every poll, so the Turns land the moment the agent is
      // waiting on the operator and never mid-reply. Past the bound the
      // enlist is refused and leaves nothing.
      // A refused enlist leaves nothing, the settling reads' register entry
      // included: no tick will follow them, so nothing may serve them.
      const refuse = (reason: string): EnlistConversationResult => {
        env.paneReads.forget(req.paneId);
        return { ok: false, reason };
      };
      try {
        await settleTurn(runtime, descriptor);
        const deadline = Date.now() + teachingWaitMs;
        while (runtime.turn.state !== "waiting") {
          if (Date.now() >= deadline) {
            return refuse(stillWorkingReason(teachingWaitMs));
          }
          await Bun.sleep(pollMs);
          await readTurn(runtime, descriptor);
        }
      } catch (err) {
        return refuse(
          `the pane could not be read (${err instanceof Error ? err.message : String(err)})`,
        );
      }

      reportAgent(runtime, "blocked");

      const opening = req.opening ?? "";
      const record: ConversationRecord = {
        id: req.id,
        file,
        title: req.title.trim(),
        opening,
        status: "live",
        harness,
        // The Assignment as found: herdr names no model, so the card reads
        // "as found" where a started Conversation names one.
        model: "",
        drivers: DEFAULT_DRIVERS,
        enlisted: found,
      };
      // The record lands before delivery: deliver reads it for the harness
      // descriptor, and the card must exist the moment the enlist does.
      writeConversation(dir, record);

      // The teaching, then the opening Turn, both through the Notice path:
      // the same queue-then-deliver-while-waiting the spawned Notices use.
      runtime.notices.push({
        to: req.id,
        from: req.id,
        kind: "enlist-teaching",
        text: buildConversationTeaching(
          join(env.runsDir, `${req.id}.spawn.json`),
          { harness, model: "", drivers: DEFAULT_DRIVERS },
          host.config().defaults,
        ),
      });
      if (opening.trim()) {
        runtime.notices.push({
          to: req.id,
          from: req.id,
          kind: "opening-turn",
          text: opening,
        });
      }

      runtimes.set(req.id, runtime);
      if (runtime.turn.state === "waiting") {
        await deliver(req.id);
        if (runtime.notices.length > 0) {
          // The teaching never landed: remove the half-written record and
          // its events, drop the runtime and the identity, and let the
          // caller unwind the branch it may have created.
          runtimes.delete(req.id);
          releaseAgent(runtime.paneId, runtime.harness);
          try {
            rmSync(file, { force: true });
            rmSync(join(env.runsDir, `${req.id}.events.jsonl`), { force: true });
          } catch {
            // Best-effort.
          }
          return refuse("the teaching Turn could not be delivered");
        }
      }
      // The operator's tab is relabelled only once the claim has held, so a
      // refused enlist leaves the label as it found it; awaited (still
      // best-effort) so the claim is whole when the enlist answers.
      if (req.tabId !== null) {
        await relabelTab(env.herdrSocket, req.tabId, runtime.label).catch(() => {});
      }
      watchForCrash(runtime);
      // The Assignment under this Conversation's id, as start records it, so
      // a Ticket it spawns inherits it.
      host.recordAssignment(req.id, {
        harness,
        model: "",
        drivers: DEFAULT_DRIVERS,
      });
      runtime.timer = setInterval(() => tick(req.id), pollMs);
      publish();
      return { ok: true, view: viewOf(record, loadConversations(dir)) };
    } finally {
      reserved.delete(req.id);
    }
  }

  function watchForCrash(runtime: ConversationRuntime): void {
    if (!runtime.paneId) return;
    void waitForPaneEnding(env.herdrSocket, runtime.paneId, runtime.exitCodePath, runtime.release.signal)
      .then((ending) => {
        if (runtime.release.signal.aborted || runtime.ending) return;
        markCrashed(runtime, ending);
      })
      .catch(() => {});
  }

  /**
   * Stop the tick and forget the pane's recorded read with it: the tick is
   * the register's only writer for this pane, so once it stops (End, crash,
   * shutdown) the Peek must read live or find nothing, never a viewport
   * frozen at the last tick.
   */
  function stopTick(runtime: ConversationRuntime): void {
    if (runtime.timer !== null) clearInterval(runtime.timer);
    runtime.timer = null;
    if (runtime.paneId) env.paneReads.forget(runtime.paneId);
  }

  function markCrashed(runtime: ConversationRuntime, ending: PaneEnding): void {
    // The pane is gone: drain the tailer so the derived log holds what it showed.
    void runtime.tailer?.finish().catch(() => {});
    stopTick(runtime);
    writeConversationStatus(runtime.file, "crashed");
    event(runtime.id, "crash", { reason: `pane lost without End (${ending})` });
    releaseAgent(runtime.paneId, runtime.harness);
    // A launch-only run clears its own Live attempt where it records the
    // ending (attempt-run.ts): here, and at End below.
    env.liveAttempts.clear(runtime.id, 1);
    if (!runtime.enlisted && runtime.closeTabs !== false) host.closeAttemptTabs(runtime.id);
    // Before the runtime leaves the map, as in finishEnd: noteEnded reads
    // runtime.notices to drop and log whatever never delivered.
    noteEnded(runtime.id, { branch: runtime.worktree.branch, crashed: true });
    runtimes.delete(runtime.id);
    publish();
  }

  // -------------------------------------------------------------------------
  // Ending.
  // -------------------------------------------------------------------------

  // An enlisted Conversation's tab and directory were the operator's before
  // the pool's and stay theirs (issue #101): the engine never closes the tab
  // and never removes the directory, at End or at any other ending. A
  // started Conversation keeps the ordinary cleanup.
  // Best-effort, as every close is, but never silent (issue #139): a tab
  // herdr refused to close is on the Conversation's log and the pool's.
  function closeRuntimeTab(runtime: ConversationRuntime): Promise<void> {
    if (runtime.enlisted || !runtime.tabId || runtime.closeTabs === false) return Promise.resolve();
    return closeConversationTab(runtime.id, runtime.tabId, "end");
  }

  // Close one of a Conversation's tabs and record it closed (issue #139), so
  // the ending's sweep of every tab under the id (host.closeAttemptTabs)
  // does not ask herdr again; a tab herdr no longer has is closed already.
  function closeConversationTab(id: string, tabId: string, reason: string): Promise<void> {
    const terminalId = launchOf(id)?.terminalId ?? null;
    const closed = (): void => {
      event(id, "tab-closed", {
        tab_id: tabId,
        ...(terminalId !== null ? { terminal_id: terminalId } : {}),
        reason,
      });
      host.tabClosed();
    };
    return closeTab(env.herdrSocket, tabId).then(closed, (err: unknown) => {
      if (isTabNotFound(err)) {
        closed();
        return;
      }
      const error = err instanceof Error ? err.message : String(err);
      event(id, "tab-close-failed", { tab_id: tabId, error });
      host.log(`conversation ${id}: herdr tab ${tabId} could not be closed (${error})`);
    });
  }

  function disposeWorktree(runtime: ConversationRuntime): void {
    if (runtime.enlisted) return;
    removeWorktree(env.cwd, runtime.worktree);
  }

  function finishEnd(runtime: ConversationRuntime, merged: boolean): void {
    stopTick(runtime);
    writeConversationStatus(runtime.file, "ended");
    event(runtime.id, "ended", { closing: runtime.closing ?? null, by: "operator", merged });
    releaseAgent(runtime.paneId, runtime.harness);
    env.liveAttempts.clear(runtime.id, 1);
    // An enlisted Conversation's tab is the operator's and never closes
    // (issue #101); the engine opened no tab under this id to close either.
    // One whose tab herdr lists as someone else's is not swept either.
    if (!runtime.enlisted && runtime.closeTabs !== false) host.closeAttemptTabs(runtime.id);
    // While the runtime is still in the map: noteEnded reads its notices
    // to drop and log whatever never delivered.
    noteEnded(runtime.id, {
      branch: runtime.worktree.branch,
      closing: runtime.closing,
      crashed: false,
    });
    runtimes.delete(runtime.id);
    // The one place every ending path converges (end's no-commit fast path
    // and its merge-chain success, plus the three merge answers below):
    // none of those callers run inside the drive loop (end is a direct
    // PoolRun call; the merge answers route through processAnswer, which
    // only emits once a fresh drive actually starts or reaches its next
    // boundary, not synchronously), so this is the single spot that
    // guarantees the snapshot stream sees the ending promptly, mirroring
    // markCrashed's own emit just above.
    publish();
  }

  /**
   * The runtime for an End on a record live with no runtime (issue #140): a
   * boot that could not ask the daemon, or could not read the pane, left it
   * unadopted, and the operator must still be able to End it. Its tab is
   * closed only when herdr can be asked and does not list that tab as
   * someone else's; it is never swept by id otherwise. An enlisted one is
   * rebuilt as found, and its tab is never closed anyway.
   */
  async function detachedRuntime(id: string, known?: PaneListing): Promise<ConversationRuntime> {
    const rec = loadConversations(dir).find((candidate) => candidate.id === id);
    if (!rec || rec.status !== "live") {
      throw new Error(`end conversation: no live conversation ${id}`);
    }
    if (rec.enlisted) {
      const runtime = enlistedRuntime({
        id: rec.id,
        file: rec.file,
        paneId: rec.enlisted.paneId,
        tabId: rec.enlisted.tabId,
        harness: rec.harness,
        title: rec.title,
        directory: rec.enlisted.directory,
        branch: rec.enlisted.branch,
      });
      runtimes.set(id, runtime);
      return runtime;
    }
    const launch = launchOf(id);
    const listing = known ?? (await paneListing());
    const ours =
      launch !== null && launch.tabId !== null && listing !== null && !tabIsForeign(listing, launch);
    const runtime = startedRuntime(rec, ours ? launch!.tabId : null);
    if (!ours) runtime.closeTabs = false;
    runtimes.set(id, runtime);
    return runtime;
  }

  /**
   * End a Conversation: only the operator does this (card End, Detail End,
   * or closing the herdr tab — the last arrives as a pane loss and is
   * handled by watchForCrash instead, never here). The tab closes at once,
   * before the merge is even attempted: once End is clicked the talk is over
   * regardless of how the merge goes, and a conflict's resolver gets its own
   * fresh tab (host.resolveConflict) rather than reusing the one just
   * closed.
   */
  async function end(id: string, closing?: string, listing?: PaneListing): Promise<void> {
    const runtime = runtimes.get(id) ?? (await detachedRuntime(id, listing));
    if (runtime.ending) return;
    runtime.ending = true;
    runtime.closing = closing;
    // Recorded before anything moves (issue #140): an engine that stops mid
    // End leaves the record live, and the next boot finishes this ending
    // rather than calling the Conversation crashed.
    if (!endRequested(id)) event(id, "end-requested", { closing: closing ?? null });
    runtime.release.abort();
    // Before the tab goes: the release names a pane, and a pane whose tab
    // has just been closed is a pane the daemon no longer has (issue #94).
    // finishEnd releases too, for the paths that reach an ending without
    // coming through here; a second release of a binding already dropped is
    // a no-op, and both are best-effort anyway.
    releaseAgent(runtime.paneId, runtime.harness);
    await closeRuntimeTab(runtime);
    // The talk is over: drain the tailer so the derived log is complete.
    await runtime.tailer?.finish().catch(() => {});

    const target = host.mergeTargetBranch();
    const countProbe = git(env.cwd, ["rev-list", "--count", `${target}..${runtime.worktree.branch}`]);
    const hasCommits = countProbe.ok && Number(countProbe.out) > 0;
    if (!hasCommits) {
      disposeWorktree(runtime);
      finishEnd(runtime, false);
      return;
    }

    // The End answers once its ending is recorded and its tab closed; the
    // merge goes on behind it (issue #140), on the merge chain, which may
    // wait on a Continued attempt in the pool checkout (ADR-0027), and its
    // outcome is reported the usual way: the ended record and snapshot, or
    // a merge interrupt. A merge-chain failure must never wedge the End: the
    // Conversation is left `ending` with its worktree intact, visible as a
    // stuck End, and the chain itself stays usable for the next caller (the
    // host's contract).
    void host
      .chainMerge(async () => {
        const result = host.mergeIntoTarget(runtime.worktree.branch);
        if (result.ok) {
          disposeWorktree(runtime);
          event(id, "merged", mergedPayload(result));
          finishEnd(runtime, true);
          return;
        }
        const synthMarker: TicketMarker = {
          id,
          file: runtime.file,
          blockedBy: [],
          status: "done",
          title: id,
          spec: "",
        };
        // The ending stays pending: the runtime remains in the map (still
        // `ending`) until the raised interrupt is answered, at which point
        // answerMerge below finishes it.
        await host.resolveConflict(synthMarker, result, 1);
      })
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Merge answers: merge-conflict / merge-approval answers for a
  // Conversation id route here instead of through the ticket path.
  // -------------------------------------------------------------------------

  // The interrupt for a merge that did not land, in either of its shapes: a
  // conflict git started and the engine aborted, or a merge git refused
  // before starting because untracked pool files stood in its way (#92).
  // Both keep the merge-conflict kind (resume re-attempts the merge); only
  // the body differs, and a blocked one never claims anything conflicted.
  function mergeConflictInterrupt(runtime: ConversationRuntime, result: MergeResult): Interrupt {
    const parked =
      `the Conversation's work is parked on branch ${runtime.worktree.branch}, ` +
      `checked out at ${runtime.worktree.path}.\n` +
      (result.detail ? `git said: ${result.detail}\n` : "");
    if (result.reason === "blocked") {
      return {
        ticketId: runtime.id,
        kind: "merge-conflict",
        body:
          `merging ${runtime.worktree.branch} onto the working branch was blocked: ` +
          blockedMergeExplanation(env.cwd, result) +
          parked,
      };
    }
    const files = result.conflicted.length > 0 ? result.conflicted.join(", ") : "(no unmerged paths listed)";
    return {
      ticketId: runtime.id,
      kind: "merge-conflict",
      body:
        `merging ${runtime.worktree.branch} onto the working branch failed; the ` +
        "merge was aborted and the working branch was left clean.\n" +
        `conflicted files: ${files}\n` +
        parked +
        "resolve the conflict by hand and resume; the merge is re-attempted on resume.",
    };
  }

  function manualMergeInterrupt(
    runtime: ConversationRuntime,
    result: MergeResult,
    attemptNote: string,
  ): Interrupt {
    const base = mergeConflictInterrupt(runtime, result);
    // A blocked merge never reached the resolver's resolution; its body
    // already says what stood in the way.
    if (result.reason === "blocked") return base;
    return { ...base, body: `${base.body}\nThe resolver agent attempted: ${attemptNote}` };
  }

  function failedMergeEvent(runtime: ConversationRuntime, result: MergeResult): void {
    if (result.reason === "blocked") {
      event(runtime.id, "merge-blocked", { files: result.blocked });
    } else {
      event(runtime.id, "merge-conflict", { files: result.conflicted });
    }
  }

  function mergedPayload(result: MergeResult): Record<string, unknown> {
    return result.cleared.length > 0 ? { cleared: result.cleared } : {};
  }

  function resumeMerge(runtime: ConversationRuntime, interrupt: Interrupt): void {
    const result = host.mergeIntoTarget(runtime.worktree.branch);
    if (!result.ok) {
      failedMergeEvent(runtime, result);
      host.clearInterrupt(
        interrupt,
        `merge re-attempt for conversation ${runtime.id} ` +
          (result.reason === "blocked" ? "is still blocked" : "still conflicts"),
      );
      host.raiseInterrupt(mergeConflictInterrupt(runtime, result));
      return;
    }
    disposeWorktree(runtime);
    event(runtime.id, "merged", mergedPayload(result));
    host.clearInterrupt(
      interrupt,
      `interrupt answered for conversation ${runtime.id} (merge-conflict): merge landed`,
    );
    finishEnd(runtime, true);
  }

  function approveMerge(runtime: ConversationRuntime, interrupt: Interrupt): void {
    commitMerge(runtime.worktree);
    const result = host.mergeIntoTarget(runtime.worktree.branch);
    if (!result.ok) {
      failedMergeEvent(runtime, result);
      host.clearInterrupt(
        interrupt,
        `merge after resolver approval for conversation ${runtime.id} ` +
          (result.reason === "blocked" ? "is blocked" : "still conflicts"),
      );
      host.raiseInterrupt(
        manualMergeInterrupt(runtime, result, "the resolver's resolution did not merge cleanly on approval"),
      );
      return;
    }
    disposeWorktree(runtime);
    event(runtime.id, "merged", mergedPayload(result));
    host.clearInterrupt(
      interrupt,
      `interrupt answered for conversation ${runtime.id} (merge-approval): resolver resolution committed`,
    );
    finishEnd(runtime, true);
  }

  function rejectMerge(runtime: ConversationRuntime, interrupt: Interrupt): void {
    git(runtime.worktree.path, ["merge", "--abort"]);
    host.clearInterrupt(
      interrupt,
      `merge-approval rejected for conversation ${runtime.id}: staged resolution discarded, branch parked`,
    );
    // Unlike a ticket's rejectMerge, the Conversation is not reopened: only
    // the operator starts a new one (spec: only the operator ends a
    // Conversation, and ending is terminal). The branch stays parked.
    finishEnd(runtime, false);
  }

  function answerMerge(id: string, interrupt: Interrupt, approve: boolean | undefined): void {
    const runtime = runtimes.get(id);
    if (!runtime) {
      throw new Error(`conversation merge answer: no live conversation ${id}`);
    }
    if (interrupt.kind === "merge-conflict") {
      resumeMerge(runtime, interrupt);
      return;
    }
    if (approve) {
      approveMerge(runtime, interrupt);
    } else {
      rejectMerge(runtime, interrupt);
    }
  }

  // -------------------------------------------------------------------------
  // Notices: queued on the parent's runtime, typed into its pane once it is
  // next waiting, dropped (and logged on the child's file) when the parent
  // is gone or ending.
  // -------------------------------------------------------------------------

  function logDropped(notice: Notice, reason: string): void {
    event(
      notice.from,
      "notice-dropped",
      { to: notice.to, kind: notice.kind, reason, text: notice.text },
      lastAttempt(env.runsDir, notice.from),
    );
  }

  /**
   * Queue one Notice for delivery, or drop it at once. Void by design:
   * queueing is synchronous bookkeeping on the runtime; a delivery that
   * becomes possible immediately (the parent is already `waiting`) is kicked
   * off in the background rather than awaited here, so no caller needs to
   * become async just to raise one.
   */
  function enqueue(notice: Notice): void {
    const runtime = runtimes.get(notice.to);
    if (!runtime || runtime.ending) {
      // Orphaned: the parent never existed this run, already ended, crashed,
      // or is mid-End (its tab is already closing). Dropped and logged on
      // the CHILD's own file — the spec's wording is explicit that this
      // lands on "the child's ticket log", never the parent's, since the
      // parent may have nothing worth writing to by the time this fires.
      logDropped(notice, runtime ? "parent conversation is ending" : "parent conversation is not live");
      return;
    }
    runtime.notices.push(notice);
    if (runtime.turn.state === "waiting") {
      void deliver(notice.to);
    }
  }

  function harnessDescriptorFor(runtime: ConversationRuntime) {
    const rec = readConversation(runtime.file);
    return defaultHarnessDescriptors[rec.harness];
  }

  /**
   * Drain a Conversation's queued Notices by typing each as its own Turn
   * (typeVerified + Enter — typeVerified sends the Enter itself once the
   * echo confirms). Claims the whole queue up front (a synchronous splice,
   * before any await), so a concurrent trigger — the tick's own waiting
   * check racing an enqueue that fired mid-tick — can never double-deliver.
   * A delivery that fails to echo (typeVerified resolves false) *or throws*
   * (a herdr RPC failure: a daemon blip, a socket error) stops the drain and
   * puts the undelivered remainder back at the front of the queue for the
   * next trigger to retry, rather than skipping ahead or losing it. Both
   * callers fire this with a bare `void` (raising a Notice, or the tick's
   * own waiting check, must never become async just to wait on delivery),
   * so this function itself must never reject: an uncaught rejection from a
   * `void`-launched promise is an unhandled rejection Bun can escalate to a
   * process crash. Every failure, from typeVerified itself or from anything
   * around it (a Conversation's record briefly unreadable), is therefore
   * caught here, logged once as this attempt's own "notice" event, and
   * turned into "still queued" rather than an exception.
   */
  async function deliver(id: string): Promise<void> {
    try {
      const runtime = runtimes.get(id);
      if (!runtime || runtime.ending || !runtime.paneId || runtime.notices.length === 0) return;
      const descriptor = harnessDescriptorFor(runtime);
      const queue = runtime.notices.splice(0);
      for (let i = 0; i < queue.length; i++) {
        const notice = queue[i];
        const echoTargets = [descriptor?.echoPattern, notice.text].filter(
          (t): t is string => typeof t === "string" && t.length > 0,
        );
        let delivered = false;
        let error: string | undefined;
        try {
          delivered = await typeVerified(
            env.herdrSocket,
            runtime.paneId,
            notice.text,
            echoTargets,
            descriptor?.clearKeys ?? [],
          );
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        const payload = { kind: notice.kind, delivered, ...(error ? { error } : {}) };
        event(notice.from, "notice", { ...payload, to: notice.to }, lastAttempt(env.runsDir, notice.from));
        event(id, "notice", { ...payload, from: notice.from }, lastAttempt(env.runsDir, id));
        if (!delivered) {
          runtime.notices.unshift(...queue.slice(i));
          return;
        }
      }
    } catch {
      // Belt and braces beyond the per-notice catch above: anything else
      // that could throw here (harnessDescriptorFor's file read, a runtime
      // that vanished mid-drain) must still never escape as an unhandled
      // rejection. Nothing to queue back in this outer case since the queue
      // was already claimed by the inner splice; the next enqueue or waiting
      // read starts a fresh drain.
    }
  }

  // Whether `id` names a Conversation the pool has ever recorded, live or
  // not. Distinct from isLive: a ticket's spawned-by can name a Conversation
  // that has since ended or crashed, and that case must still reach enqueue
  // so its Notice is dropped and *logged*, not silently skipped — only a
  // spawned-by that names an ordinary Ticket (not a Conversation at all)
  // should build nothing.
  function isKnown(id: string): boolean {
    return loadConversations(dir).some((r) => r.id === id);
  }

  /**
   * A spawned Ticket reached `done` (its merge landed): if its `spawned-by`
   * names any Conversation the pool has recorded, enqueue a Notice —
   * enqueue itself decides delivery vs. drop from there (the parent may no
   * longer be live). `diffRange` is a git range (`<sha-before>..HEAD`)
   * computed by the caller before the merge removed the ticket's branch —
   * null when the range could not be captured (a headless pool, or a fast
   * path that skipped it), in which case the diff reads as unavailable
   * rather than guessing.
   */
  function ticketEnded(marker: TicketLike, branch: string, diffRange: string | null): void {
    if (!marker.spawnedBy || !isKnown(marker.spawnedBy)) return;
    const diffStat = diffRange ? diffStatSummary(env.cwd, diffRange) : "(diff unavailable)";
    const text = ticketEndedNoticeText({
      id: marker.id,
      title: marker.title,
      outcome: "done",
      branch,
      diffStat,
    });
    enqueue({ to: marker.spawnedBy, from: marker.id, kind: "ticket-ended", text });
  }

  /**
   * A spawned Ticket checkpointed: if its `spawned-by` names any
   * Conversation the pool has recorded, enqueue a Notice (same "known, not
   * just live" rule as ticketEnded above). The branch still exists in a git
   * pool (a checkpoint never merges), so the diff is a live three-dot range
   * against the pool's current working branch; a headless pool has neither,
   * and the Notice still goes out (to be delivered or dropped) with
   * placeholders for both.
   */
  function ticketCheckpointed(marker: TicketLike, brief: string): void {
    if (!marker.spawnedBy || !isKnown(marker.spawnedBy)) return;
    const branch = env.git ? branchFor(env.cwd, marker.id) : "(no git checkout)";
    const diffStat = env.git
      ? diffStatSummary(env.cwd, `${host.mergeTargetBranch()}...${branch}`)
      : "(no git checkout)";
    const text = ticketEndedNoticeText({
      id: marker.id,
      title: marker.title,
      outcome: "checkpoint",
      brief,
      branch,
      diffStat,
    });
    enqueue({ to: marker.spawnedBy, from: marker.id, kind: "ticket-ended", text });
  }

  // A Conversation has genuinely ended (merged, ended with no commits, or
  // ended with its branch parked on reject) or crashed: drop what never
  // delivered, and tell its own parent, if it has one. Called while the
  // runtime is still in the map.
  function noteEnded(id: string, info: { branch: string; closing?: string; crashed: boolean }): void {
    const runtime = runtimes.get(id);
    for (const notice of runtime?.notices ?? []) {
      logDropped(notice, "parent conversation ended before delivery");
    }
    const parentId = loadConversations(dir).find((r) => r.id === id)?.spawnedBy;
    if (!parentId) return;
    const text = conversationEndedNoticeText({ branch: info.branch, closing: info.closing });
    enqueue({ to: parentId, from: id, kind: "conversation-ended", text });
  }

  // -------------------------------------------------------------------------
  // The tick: Turn state (engine/turn-state.ts), Notice delivery and this
  // Conversation's own mid-run Spawn proposal file, every 2 s per live
  // Conversation.
  // -------------------------------------------------------------------------

  function spawnProposalPath(id: string): string {
    return join(env.runsDir, `${id}.spawn.json`);
  }

  /**
   * Read `runs/<id>.spawn.json`, consume it (rm, whether it parsed or not: a
   * malformed file left in place would be re-read and re-rejected forever),
   * and hand its `spawn` field to the host, which validates it against
   * exactly the shape a Ticket's outcome.spawn is held to and adopts the
   * survivors. Rejected entries are logged first, the same way an outcome's
   * are (spawn-rejected on this Conversation's own file, since it is both
   * proposer and parent here).
   */
  function pollSpawnProposals(id: string): void {
    const path = spawnProposalPath(id);
    if (!existsSync(path)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      rmSync(path, { force: true });
      return;
    }
    rmSync(path, { force: true });
    const spawnField = (raw as { spawn?: unknown } | null)?.spawn;
    host.adoptSpawns(id, spawnField, (rejections) => {
      for (const rejection of rejections) {
        event(
          id,
          "spawn-rejected",
          { index: rejection.index, reason: rejection.reason },
          lastAttempt(env.runsDir, id),
        );
      }
    });
  }

  function tick(id: string): void {
    const runtime = runtimes.get(id);
    if (!runtime || runtime.ending || !runtime.paneId) return;
    // A single tick's failure (a transient read error, a record momentarily
    // unreadable) must never take the tick down for every other live
    // Conversation, nor stop this one's own future ticks: swallow and let
    // the next tick try again, the same tolerance peekPane's own callers
    // already apply to a daemon blip.
    let descriptor: HarnessDescriptor | null;
    try {
      descriptor = harnessDescriptorFor(runtime) ?? null;
    } catch {
      return;
    }
    void readTurn(runtime, descriptor)
      .then(() => {
        // The runtime may have ended while this read was in flight (the tab
        // closes as soon as End is called, well before the pane's fate is
        // known); re-fetch rather than trusting the closure's reference.
        const live = runtimes.get(id);
        if (!live || live.ending) return;
        if (live.turn.state === "waiting" && live.notices.length > 0) {
          void deliver(id);
        }
        pollSpawnProposals(id);
      })
      .catch(() => {
        // See above: one tick's failure is not fatal.
      });
  }

  // Shutdown: every tick and crash watch stops, and nothing else moves. The
  // pane, its TUI and its tab are left exactly as they are for the next boot
  // to re-adopt (issue #140); a watch left running would record the pane's
  // later end as a crash from an engine that is going away.
  function dispose(): void {
    for (const runtime of runtimes.values()) {
      stopTick(runtime);
      runtime.release.abort();
    }
  }

  return {
    start,
    enlist,
    end,
    answerMerge,
    views,
    crashStaleAtBoot,
    adoptStartedAtBoot,
    readoptPending,
    liveTerminals,
    liveDirectories: () =>
      [...runtimes.values()].map((runtime) => ({ id: runtime.id, cwd: runtime.worktree.path })),
    adoptEnlistedAtBoot,
    ticketEnded,
    ticketCheckpointed,
    isLive: (id) => runtimes.has(id),
    reservedIds: () => reserved,
    dispose,
  };
}
