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
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  type TicketEventKind,
} from "./events.ts";
import type { TicketMarker } from "./pool.ts";
import {
  branchFor,
  currentBranch,
  commitMerge,
  git,
  mergeBranch,
  prepareWorktree,
  removeWorktree,
  worktreePathFor,
  type MergeResult,
  type WorktreeInfo,
} from "./worktrees.ts";
import { waitForAttemptEnding, type AttemptEnding } from "./attempt-ending.ts";
import { closeTab } from "./herdr.ts";
import {
  exitCrashReason,
  launchAttempt,
  type AttemptHandle,
  type PaneTailer,
} from "./attempt-run.ts";
import { buildConversationTeaching } from "./prompt.ts";
import type { Notice } from "./notices.ts";
import {
  attemptEnvOf,
  clearInterrupt,
  closeAttemptTabs,
  emitSnapshot,
  handleMergeConflict,
  raiseInterrupt,
  type AssignmentView,
  type Interrupt,
  type Session,
} from "./engine.ts";

// ---------------------------------------------------------------------------
// Storage: the marker format and its parser, in the style of pool.ts.
// ---------------------------------------------------------------------------

const CONVERSATION_STATUSES = ["live", "ended", "crashed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export type TurnState = "working" | "waiting";

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
  return {
    id,
    status: status as ConversationStatus,
    ...(spawnedBy ? { spawnedBy } : {}),
    harness: decodeURIComponent(fields.get("harness") ?? ""),
    model: decodeURIComponent(fields.get("model") ?? ""),
    drivers: decodeURIComponent(fields.get("drivers") ?? ""),
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

/** The next operator-started id: `conv-N`, one past the highest existing. Spawned Conversations get `<parent>-spawn-N` instead, assigned by nextConversationSpawnId below. */
export function nextConversationId(existing: ConversationRecord[]): string {
  const nums = existing
    .map((r) => /^conv-(\d+)$/.exec(r.id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return `conv-${(nums.length ? Math.max(...nums) : 0) + 1}`;
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
// Runtime tracking (engine.ts's Session.conversations) and the B hooks.
// ---------------------------------------------------------------------------

interface ConversationTurn {
  state: TurnState;
  lastLine: string;
  idleSince: string | null;
  // Workstream B's deriveTurnState counter (engine/turn-state.ts), carried
  // here so its poller has somewhere to keep it between polls; A never reads
  // it.
  stableReads: number;
  // The previous read's transcript region (TurnStateResult.transcript), the
  // text deriveTurnState compares the next read against.
  lastText: string;
}

// Notice's canonical definition now lives in engine/notices.ts (Workstream
// B); re-exported here so every existing import of it from conversations.ts
// (A's own code, and anything written against A's placeholder before B
// landed) keeps working unchanged.
export type { Notice } from "./notices.ts";

export interface ConversationRuntime {
  id: string;
  file: string;
  paneId: string | null;
  tabId: string | null;
  worktree: WorktreeInfo;
  exitCodePath: string;
  streamPath: string;
  logPath: string;
  turn: ConversationTurn;
  // The follow-file tailer deriving the log from the pane's Stream file
  // (ADR-0012), started by the launch and finished by End or crash so the
  // derived log is complete; absent for a Conversation recovered without a
  // launch (boot).
  tailer?: PaneTailer | null;
  // Workstream B's queue: proposals from spawned work land here, delivered
  // as a Turn once the poller sees this Conversation waiting.
  notices: Notice[];
  // Set the moment endConversation is called; guards the background crash
  // watcher (watchForCrash) from racing the ending it already knows about.
  ending: boolean;
  closing?: string;
  release: AbortController;
}

// Workstream B's per-Conversation poller (turn state + notice delivery,
// engine/turn-state.ts): startConversation calls this once the pane is
// ready, if B has installed one via setConversationPoller. Left unset, a
// Conversation still starts and runs; only its turn/notice tracking on the
// Console lags until B lands. The simplest hook that keeps A and B from
// needing to import each other's modules.
export type ConversationPoller = (session: Session, id: string) => void;
let conversationPoller: ConversationPoller | null = null;
export function setConversationPoller(poller: ConversationPoller | null): void {
  conversationPoller = poller;
}

// Workstream B's parent-notification hook (spec's Notices section: a child
// Conversation's end enqueues a Notice on its parent). Called once a
// Conversation has genuinely ended (merged, ended with no commits, or ended
// with its branch parked on reject) or crashed, naming the branch and the
// operator's optional closing line; B installs the real enqueue via
// setConversationEndedHook, and A calls it unconditionally so no ending path
// can forget to.
export type ConversationEndedHook = (
  session: Session,
  id: string,
  info: { branch: string; closing?: string; crashed: boolean },
) => void;
let conversationEndedHook: ConversationEndedHook | null = null;
export function setConversationEndedHook(hook: ConversationEndedHook | null): void {
  conversationEndedHook = hook;
}

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
  turn: { state: TurnState; lastLine: string; idleSince: string | null };
  children: string[];
}

function assignmentViewOf(rec: { harness: string; model: string; drivers: string }): AssignmentView {
  return {
    harness: rec.harness || null,
    model: rec.model || null,
    drivers: rec.drivers || "implement",
  };
}

function childrenOf(session: Session, id: string, conversations: ConversationRecord[]): string[] {
  const tickets = session.markers
    .filter((m) => m.spawnedBy === id)
    .map((m) => m.id);
  const kids = conversations.filter((c) => c.spawnedBy === id).map((c) => c.id);
  return [...tickets, ...kids];
}

function conversationViewOf(
  session: Session,
  rec: ConversationRecord,
  conversations: ConversationRecord[],
): ConversationView {
  const runtime = session.conversations.get(rec.id);
  const branch = runtime
    ? runtime.worktree.branch
    : branchFor(session.cwd, rec.id);
  return {
    id: rec.id,
    title: rec.title,
    status: rec.status,
    spawnedBy: rec.spawnedBy ?? null,
    assignment: assignmentViewOf(rec),
    paneId: runtime?.paneId ?? null,
    // A conversation with no live runtime (ended cleanly, or never tracked
    // across a restart) has no branch worth naming once it merged; a
    // git-less pool has none at all. Neither is an error: the card simply
    // shows nothing to look at.
    branch: session.git ? branch : null,
    turn: runtime
      ? { state: runtime.turn.state, lastLine: runtime.turn.lastLine, idleSince: runtime.turn.idleSince }
      : { state: "waiting", lastLine: "", idleSince: null },
    children: childrenOf(session, rec.id, conversations),
  };
}

/** Every Conversation the pool knows about, live or not, as the snapshot wants them. */
export function conversationViews(session: Session): ConversationView[] {
  const conversations = loadConversations(conversationsDir(session.poolDir));
  return conversations.map((rec) => conversationViewOf(session, rec, conversations));
}

// ---------------------------------------------------------------------------
// Boot: a Conversation recorded live when the engine last ran is stale — its
// pane's fate is unknown and, per the spec, Conversations do not resume in
// v1 regardless — so every one of them crashes at boot rather than sitting
// unreachable with no runtime entry to end it by.
// ---------------------------------------------------------------------------

export function crashStaleLiveConversationsAtBoot(session: Session): void {
  for (const rec of loadConversations(conversationsDir(session.poolDir))) {
    if (rec.status !== "live") continue;
    writeConversationStatus(rec.file, "crashed");
    appendEvent(session.runsDir, rec.id, {
      at: nowIso(),
      attempt: 1,
      kind: "crash" as TicketEventKind,
      payload: {
        reason:
          "engine restarted; Conversations do not resume (the Conversations ADR)",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Starting.
// ---------------------------------------------------------------------------

export interface StartConversationRequest {
  title: string;
  opening?: string;
  assign?: { harness?: string; model?: string; drivers?: string };
  spawnedBy?: string;
  // The spawn poller (engine/notices.ts's adoptSpawnProposals path)
  // precomputes a collision-free id shared across a parent's ticket-spawn
  // and Conversation-spawn counters before calling this: the two are
  // otherwise numbered independently (nextConversationSpawnId below only
  // counts existing Conversation records) and could mint the same
  // `<parent>-spawn-N` a sibling ticket spawn already claimed. When given,
  // used verbatim instead of computing one. Absent for every operator-
  // started call (the Console form) and every existing direct test, whose
  // id keeps coming from nextConversationId/nextConversationSpawnId.
  id?: string;
}

function resolveConversationAssignment(
  session: Session,
  req: StartConversationRequest,
  existing: ConversationRecord[],
): { harness: string; model: string; drivers: string } {
  let base: { harness: string; model: string; drivers: string } | undefined;
  if (req.spawnedBy) {
    const parent = existing.find((r) => r.id === req.spawnedBy);
    if (parent) base = { harness: parent.harness, model: parent.model, drivers: parent.drivers };
  }
  const config = session.state.config;
  const harness = req.assign?.harness ?? base?.harness ?? config.defaults?.harness ?? "";
  const model = req.assign?.model ?? base?.model ?? config.defaults?.model ?? "";
  const drivers = req.assign?.drivers ?? base?.drivers ?? config.defaults?.drivers ?? "implement";
  if (!harness) {
    throw new Error(
      "conversation start: no harness resolved (set assign.harness, inherit " +
        "from the parent Conversation, or console.json defaults.harness)",
    );
  }
  if (!session.harnesses[harness]) {
    throw new Error(
      `conversation start: names unknown harness '${harness}'. Known: ` +
        `${Object.keys(session.harnesses).sort().join(", ")}`,
    );
  }
  if (!model) {
    throw new Error(
      "conversation start: no model resolved (set assign.model, inherit " +
        "from the parent Conversation, or console.json defaults.model)",
    );
  }
  return { harness, model, drivers };
}

/**
 * Start a Conversation: refuse a non-terminal pool, resolve its Assignment,
 * give it a worktree and branch, then launch it through the Attempt-run
 * module (ADR-0014's one code path): the named herdr tab, the interactive
 * harness under the ADR-0016 wrapper, the readiness wait, and the opening
 * Turn typed verbatim and echo verified. A Conversation has no headless
 * fallback (ADR-0018: it is a terminal-backed TUI or nothing), so a tab or
 * a launch command that could not be had is a start failure. Throws only
 * when the pool cannot host a Conversation at all (headless, no git) or the
 * launch never got a running pane; once the record exists on disk it
 * resolves even when the harness died before its TUI, the TUI never became
 * ready, or the opening Turn never landed, reporting the Conversation
 * crashed rather than losing the attempt to an unstructured rejection.
 */
export async function startConversation(
  session: Session,
  req: StartConversationRequest,
): Promise<ConversationView> {
  const env = attemptEnvOf(session);
  if (!env.terminalBacked) {
    throw new Error(
      "conversation start: the pool is not terminal-backed (set " +
        'console.json terminal: "herdr")',
    );
  }
  if (!session.git) {
    throw new Error(
      "conversation start: the pool has no git checkout, so it cannot give " +
        "the Conversation its own worktree and branch",
    );
  }
  if (!req.title?.trim()) {
    throw new Error("conversation start: title is required");
  }
  const dir = conversationsDir(session.poolDir);
  const existing = loadConversations(dir);
  const id =
    req.id ??
    (req.spawnedBy
      ? nextConversationSpawnId(req.spawnedBy, existing)
      : nextConversationId(existing));
  const { harness, model, drivers } = resolveConversationAssignment(session, req, existing);
  const worktree = prepareWorktree(session.cwd, id);
  const file = conversationFile(session.poolDir, id);
  const opening = req.opening ?? "";
  // The spawn-teaching paragraph (Workstream B, prompt.ts) always lands,
  // appended to the opening Turn when there is one; typed alone otherwise,
  // so an agent given no opening still learns the propose-and-adopt
  // mechanism before the operator's first real Turn. spawnPath mirrors the
  // events module's outcome naming for a Conversation's own proposal
  // channel: `<id>.spawn.json` beside its `.outcome.json`, polled by
  // notices.ts's per-Conversation poller.
  const spawnPath = join(session.runsDir, `${id}.spawn.json`);
  const teaching = buildConversationTeaching(spawnPath);
  const toType = opening.trim() ? `${opening}\n\n${teaching}` : teaching;

  // The launch: one attempt, the well-known file names, no rotation, no
  // headless fallback, the opening Turn as a plain prompt (no driver line:
  // a Conversation has no skill to invoke and no file-referencing fallback,
  // so a paste that never lands is a crash, not a silently empty pane), and
  // only the spawned event on the log; the crash and ending events are the
  // Conversation's own. `issuePath` points at the Conversation's record so
  // a custom harness that renders it never points at nothing.
  let launch: AttemptHandle;
  try {
    launch = await launchAttempt(env, {
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
    removeWorktree(session.cwd, worktree);
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

  if (launch.kind === "ended") {
    // The harness died before its TUI came up (its own exit code, ADR-0016),
    // or the TUI never became ready or the opening Turn never landed (the
    // engine's codes): the launch is over, but the record and worktree
    // stay. A crash, not a rejection, matching every other
    // pane-loss-without-End ending. The launch keeps a pane whose harness
    // died on its own (ADR-0014's crashed-attempt rule), but this
    // Conversation never joins session.conversations, so nothing else would
    // ever close the tab: it goes here, as markConversationCrashed's does.
    writeConversationStatus(file, "crashed");
    appendEvent(session.runsDir, id, {
      at: nowIso(),
      attempt: 1,
      kind: "crash" as TicketEventKind,
      payload: {
        code: launch.code,
        reason: exitCrashReason(launch.code, launch.ctx.exitCodePath, "harness", launch.paneId),
      },
    });
    closeAttemptTabs(session, id);
    conversationEndedHook?.(session, id, { branch: worktree.branch, crashed: true });
    // Same reasoning as the success path below: this launch never touches
    // the drive loop (startConversation is called directly off the
    // PoolRun handle, not through kickProcessing), so nothing else would
    // ever tell the snapshot stream this Conversation existed at all.
    emitSnapshot(session, session.settledPhase ?? "running");
    return conversationViewOf(session, { ...record, status: "crashed" }, loadConversations(dir));
  }

  const runtime: ConversationRuntime = {
    id,
    file,
    paneId: launch.paneId,
    tabId: launch.tabId,
    worktree,
    exitCodePath: launch.ctx.exitCodePath,
    streamPath: launch.ctx.streamPath ?? join(session.runsDir, `${id}.stream.jsonl`),
    logPath: launch.ctx.logPath,
    turn: { state: "working", lastLine: "", idleSince: null, stableReads: 0, lastText: "" },
    tailer: launch.tailer,
    notices: [],
    ending: false,
    release: new AbortController(),
  };
  session.conversations.set(id, runtime);
  watchForCrash(session, runtime);
  conversationPoller?.(session, id);
  // startConversation is called directly off the PoolRun handle (the
  // server route, or a fire-and-forget spawn adoption), never through
  // kickProcessing/the drive loop, so nothing else emits a snapshot that
  // would tell the SSE stream this Conversation
  // now exists; a pool with no other ticket activity in flight could
  // otherwise go arbitrarily long before the next unrelated emit.
  emitSnapshot(session, session.settledPhase ?? "running");

  return conversationViewOf(session, record, loadConversations(dir));
}

function watchForCrash(session: Session, runtime: ConversationRuntime): void {
  if (!runtime.paneId) return;
  void waitForAttemptEnding(session.herdrSocket, runtime.paneId, runtime.exitCodePath, runtime.release.signal)
    .then((ending) => {
      if (runtime.release.signal.aborted || runtime.ending) return;
      markConversationCrashed(session, runtime, ending);
    })
    .catch(() => {});
}

function markConversationCrashed(session: Session, runtime: ConversationRuntime, ending: AttemptEnding): void {
  // The pane is gone: drain the tailer so the derived log holds what it showed.
  void runtime.tailer?.finish().catch(() => {});
  writeConversationStatus(runtime.file, "crashed");
  appendEvent(session.runsDir, runtime.id, {
    at: nowIso(),
    attempt: 1,
    kind: "crash" as TicketEventKind,
    payload: { reason: `pane lost without End (${ending})` },
  });
  closeAttemptTabs(session, runtime.id);
  // Same reordering as finishConversationEnd, same reason: B's hook needs
  // runtime.notices before it is gone.
  conversationEndedHook?.(session, runtime.id, { branch: runtime.worktree.branch, crashed: true });
  session.conversations.delete(runtime.id);
  emitSnapshot(session, session.settledPhase ?? "running");
}

// ---------------------------------------------------------------------------
// Ending.
// ---------------------------------------------------------------------------

function finishConversationEnd(session: Session, runtime: ConversationRuntime, merged: boolean): void {
  writeConversationStatus(runtime.file, "ended");
  appendEvent(session.runsDir, runtime.id, {
    at: nowIso(),
    attempt: 1,
    kind: "ended" as TicketEventKind,
    payload: { closing: runtime.closing ?? null, by: "operator", merged },
  });
  closeAttemptTabs(session, runtime.id);
  // The hook fires while the runtime is still in session.conversations (the
  // delete follows it, deliberately reordered from A's original): B's hook
  // reads runtime.notices to drop and log whatever never delivered, and
  // session.conversations.get(id) would already be empty-handed the other
  // way round.
  conversationEndedHook?.(session, runtime.id, {
    branch: runtime.worktree.branch,
    closing: runtime.closing,
    crashed: false,
  });
  session.conversations.delete(runtime.id);
  // The one place every ending path converges (endConversation's no-commit
  // fast path and its merge-chain success, plus resumeConversationMerge,
  // approveConversationMerge and rejectConversationMerge below, all call
  // this instead of duplicating the ending): none of those callers run
  // inside the drive loop (endConversation is a direct PoolRun call; the
  // merge answers route through processAnswer/kickProcessing, which only
  // emits once a fresh drive actually starts or reaches its next boundary,
  // not synchronously), so this is the single spot that guarantees the
  // snapshot stream sees the ending promptly, mirroring
  // markConversationCrashed's own emit just above.
  emitSnapshot(session, session.settledPhase ?? "running");
}

/**
 * End a Conversation: only the operator does this (card End, Detail End, or
 * closing the herdr tab — the last arrives as a pane loss and is handled by
 * watchForCrash instead, never here). The tab closes at once, before the
 * merge is even attempted: once End is clicked the talk is over regardless
 * of how the merge goes, and a conflict's resolver gets its own fresh tab
 * (handleMergeConflict) rather than reusing the one just closed.
 */
export async function endConversation(session: Session, id: string, closing?: string): Promise<void> {
  const runtime = session.conversations.get(id);
  if (!runtime) throw new Error(`end conversation: no live conversation ${id}`);
  if (runtime.ending) return;
  runtime.ending = true;
  runtime.closing = closing;
  runtime.release.abort();
  if (runtime.tabId) await closeTab(session.herdrSocket, runtime.tabId).catch(() => {});
  // The talk is over: drain the tailer so the derived log is complete.
  await runtime.tailer?.finish().catch(() => {});

  const target = currentBranch(session.cwd);
  const countProbe = git(session.cwd, ["rev-list", "--count", `${target}..${runtime.worktree.branch}`]);
  const hasCommits = countProbe.ok && Number(countProbe.out) > 0;
  if (!hasCommits) {
    removeWorktree(session.cwd, runtime.worktree);
    finishConversationEnd(session, runtime, false);
    return;
  }

  await new Promise<void>((resolve) => {
    session.mergeChain = session.mergeChain
      .then(() => {
        const result = mergeBranch(session.cwd, runtime.worktree.branch);
        if (result.ok) {
          removeWorktree(session.cwd, runtime.worktree);
          appendEvent(session.runsDir, id, {
            at: nowIso(),
            attempt: 1,
            kind: "merged" as TicketEventKind,
            payload: {},
          });
          finishConversationEnd(session, runtime, true);
          resolve();
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
        // The ending stays pending: runtime remains in session.conversations
        // (still `ending`) until the raised interrupt is answered, at which
        // point answerConversationMerge below finishes it.
        return handleMergeConflict(session, synthMarker, result, 1).then(resolve);
      })
      .catch(() => {
        // A merge-chain failure must never wedge the chain for the next
        // caller (a ticket's merge, another Conversation's End); the
        // Conversation is left `ending` with its worktree intact, visible
        // as a stuck End the operator can retry.
        resolve();
      });
  });
}

// ---------------------------------------------------------------------------
// The processAnswer hook: merge-conflict / merge-approval answers for a
// Conversation id route here instead of through the ticket path.
// ---------------------------------------------------------------------------

function conversationMergeConflictInterrupt(
  session: Session,
  runtime: ConversationRuntime,
  result: MergeResult,
): Interrupt {
  const files = result.conflicted.length > 0 ? result.conflicted.join(", ") : "(no unmerged paths listed)";
  return {
    ticketId: runtime.id,
    kind: "merge-conflict",
    body:
      `merging ${runtime.worktree.branch} onto the working branch failed; the ` +
      "merge was aborted and the working branch was left clean.\n" +
      `conflicted files: ${files}\n` +
      `the Conversation's work is parked on branch ${runtime.worktree.branch}, ` +
      `checked out at ${worktreePathFor(session.cwd, runtime.id)}.\n` +
      (result.detail ? `git said: ${result.detail}\n` : "") +
      "resolve the conflict by hand and resume; the merge is re-attempted on resume.",
  };
}

function conversationManualMergeInterrupt(
  session: Session,
  runtime: ConversationRuntime,
  result: MergeResult,
  attemptNote: string,
): Interrupt {
  const base = conversationMergeConflictInterrupt(session, runtime, result);
  return { ...base, body: `${base.body}\nThe resolver agent attempted: ${attemptNote}` };
}

function resumeConversationMerge(
  session: Session,
  runtime: ConversationRuntime,
  interrupt: Interrupt,
): void {
  const result = mergeBranch(session.cwd, runtime.worktree.branch);
  if (!result.ok) {
    appendEvent(session.runsDir, runtime.id, {
      at: nowIso(),
      attempt: 1,
      kind: "merge-conflict" as TicketEventKind,
      payload: { files: result.conflicted },
    });
    clearInterrupt(session, interrupt, `merge re-attempt for conversation ${runtime.id} still conflicts`);
    raiseInterrupt(session, conversationMergeConflictInterrupt(session, runtime, result));
    return;
  }
  removeWorktree(session.cwd, runtime.worktree);
  appendEvent(session.runsDir, runtime.id, {
    at: nowIso(),
    attempt: 1,
    kind: "merged" as TicketEventKind,
    payload: {},
  });
  clearInterrupt(
    session,
    interrupt,
    `interrupt answered for conversation ${runtime.id} (merge-conflict): merge landed`,
  );
  finishConversationEnd(session, runtime, true);
}

function approveConversationMerge(
  session: Session,
  runtime: ConversationRuntime,
  interrupt: Interrupt,
): void {
  commitMerge(runtime.worktree);
  const result = mergeBranch(session.cwd, runtime.worktree.branch);
  if (!result.ok) {
    appendEvent(session.runsDir, runtime.id, {
      at: nowIso(),
      attempt: 1,
      kind: "merge-conflict" as TicketEventKind,
      payload: { files: result.conflicted },
    });
    clearInterrupt(
      session,
      interrupt,
      `merge after resolver approval for conversation ${runtime.id} still conflicts`,
    );
    raiseInterrupt(
      session,
      conversationManualMergeInterrupt(
        session,
        runtime,
        result,
        "the resolver's resolution did not merge cleanly on approval",
      ),
    );
    return;
  }
  removeWorktree(session.cwd, runtime.worktree);
  appendEvent(session.runsDir, runtime.id, {
    at: nowIso(),
    attempt: 1,
    kind: "merged" as TicketEventKind,
    payload: {},
  });
  clearInterrupt(
    session,
    interrupt,
    `interrupt answered for conversation ${runtime.id} (merge-approval): resolver resolution committed`,
  );
  finishConversationEnd(session, runtime, true);
}

function rejectConversationMerge(
  session: Session,
  runtime: ConversationRuntime,
  interrupt: Interrupt,
): void {
  git(runtime.worktree.path, ["merge", "--abort"]);
  clearInterrupt(
    session,
    interrupt,
    `merge-approval rejected for conversation ${runtime.id}: staged resolution discarded, branch parked`,
  );
  // Unlike a ticket's rejectMerge, the Conversation is not reopened: only
  // the operator starts a new one (spec: only the operator ends a
  // Conversation, and ending is terminal). The branch stays parked.
  finishConversationEnd(session, runtime, false);
}

/**
 * engine.ts's processAnswer calls this when a merge-conflict or
 * merge-approval interrupt's ticketId names a live Conversation, before
 * falling through to the ticket path (which would fail: a Conversation has
 * no Issue file in session.markers).
 */
export function answerConversationMerge(
  session: Session,
  id: string,
  interrupt: Interrupt,
  approve: boolean | undefined,
): void {
  const runtime = session.conversations.get(id);
  if (!runtime) {
    throw new Error(`conversation merge answer: no live conversation ${id}`);
  }
  if (interrupt.kind === "merge-conflict") {
    resumeConversationMerge(session, runtime, interrupt);
    return;
  }
  if (approve) {
    approveConversationMerge(session, runtime, interrupt);
  } else {
    rejectConversationMerge(session, runtime, interrupt);
  }
}
