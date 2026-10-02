/**
 * The pool server: one Bun process per pool. It drives the pool engine and
 * serves the built SPA, a small JSON API (get state, start, resume-with-
 * answer, ticket reads, terminal peek/focus), and an SSE stream that pushes
 * a full state snapshot on every change, a burst of changes as one. The UI
 * renders from those snapshots only. The terminal endpoints are the UI's
 * only path to the herdr daemon (ADR-0014): the Console never talks to
 * herdr directly.
 *
 * The engine's snapshot carries `state.tickets` as an id -> status map and
 * `assignments` as the resolved Assignment record per ticket (ADR-0013); the
 * server enriches the former into an array of {id, title, blockedBy, status,
 * mergeState, assignment, liveAttempt} so the projection can draw
 * blocked-by edges, show titles, render the record verbatim, and reach a
 * terminal-backed attempt's herdr pane (ADR-0014). Every fact on that array
 * is the engine's: the merge queue and the live attempt ride the engine's
 * snapshot, so nothing here reads git or the events files to build it, and
 * the replay surfaces serve the last snapshot as it is. The metadata
 * (title, spec, blockedBy) is the engine's own marker parsing, re-read from
 * the pool's issues directory on every snapshot and ticket-scoped request:
 * a ticket file that lands after boot (an engine-written Spawn or grader
 * ticket, or a hand edit) renders as a live card without a restart. The
 * grades endpoint re-derives from the same refreshed meta.
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  parseConfig,
  readConfig,
  REVIEW_TICKET_ID,
  loadPoolTickets,
  startPool,
  type ConversationView,
  type HarnessCommand,
  type PoolConfig,
  type PoolRun,
  type PoolSnapshot,
  type StartConversationRequest,
} from "./engine.ts";
import { loadConversations, type ConversationRecord } from "./conversations.ts";
import { titleOf } from "./pool-title.ts";
import { UNASSIGNED_ASSIGNMENT_VIEW } from "./assignment.ts";
import {
  ConfigUnreadableError,
  ReassignRefusal,
  reassignViews,
  writeReassign,
  type ReassignContext,
  type ReassignRequest,
  type ReassignResponse,
  type TicketReassignEntry,
  type TicketReassignView,
} from "./reassign.ts";
import {
  attemptLogName,
  attemptStreamName,
  eventsStamp,
  parseAttemptLogName,
  readEvents,
} from "./events.ts";
import type {
  CloseFinishedTerminalsResponse,
  EnrichedSnapshot,
  HeldSpawnResponse,
  PendingSpawnResponse,
  KeepTalkingResponse,
  LogAttemptInfo,
  ReconstructedAttempt,
  ResumeAction,
  TerminalPeekResponse,
  TicketActivityResponse,
  TicketBodyResponse,
  TicketEventsResponse,
  TicketGradeSummary,
  TicketLogResponse,
} from "./wire.ts";
import {
  defaultRegistryPath,
  pidIsLive,
  readFleetEntry,
  readFleetEntryByPort,
  upsertFleetEntry,
} from "./fleet.ts";
import {
  MARKER_RE,
  type TicketMarker,
} from "./pool.ts";
import {
  HERDR_SOCKET_DEFAULT,
  focusPane,
  peekPane,
} from "./herdr.ts";
import { listEnlistPanes, type EnlistRequest, type EnlistResponse } from "./enlist.ts";
import type {
  StewardActionResponse,
  StewardAnswerRequest,
  StewardHeldRequest,
  StewardStateResponse,
} from "./steward.ts";
import { createJev, type Jev } from "./jev.ts";
import {
  defaultMachineDefaultsPaths,
  readMachineDefaults,
  readMachineDefaultsFile,
  writeMachineDefaults,
  type MachineDefaults,
  type MachineDefaultsPaths,
} from "./machine-defaults.ts";
import {
  BOOT_ONLY_KEYS,
  poolSettingsPath,
  readPoolSettings,
  writePoolSettings,
  type RestartResponse,
  type SettingsResponse,
} from "./pool-settings.ts";
import { DEFAULT_PORT, resolvePort, type PortResolution } from "./ports.ts";
import { defaultHarnesses } from "./spawn.ts";
// The one git use left in this file is the activity endpoint's diff summary;
// no snapshot or terminal route reaches it.
import { gitAsync } from "./worktrees.ts";

export interface PoolServerOptions {
  poolDir: string;
  /** The --port CLI flag; a pin when present. Absent falls to console.json then the default. */
  port?: number;
  /** Where the unpinned hunt starts when neither flag nor console.json pins a port. Defaults to 8787. */
  defaultPort?: number;
  harnesses?: Record<string, HarnessCommand>;
  distDir?: string;
  registryPath?: string;
  /** The herdr daemon socket for terminal-backed attempts and the terminal endpoints; tests point this at a fake. Defaults to the daemon's path on this machine. */
  herdrSocket?: string;
  /**
   * The herdr workspace this server was launched in (issue #94), read from
   * `HERDR_WORKSPACE_ID` by the CLI and passed down from there. It is the
   * second candidate for the Pool workspace, after the id the pool
   * remembers, so a Console started from inside herdr puts its tabs where
   * the operator already is. Tests inject it; nothing below the CLI
   * boundary reads the environment.
   */
  herdrWorkspace?: string;
  /**
   * Jev, the judgement model (ADR-0020): built by the CLI from
   * `TYPESAFE_API_KEY` and passed down, the same way as herdrWorkspace.
   * Absent, the pool runs on its heuristics exactly as before. Tests inject
   * a fake.
   */
  jev?: Jev;
  /** The snapshot stream's heartbeat interval in ms; tests shrink it. Defaults to SNAPSHOT_STREAM_HEARTBEAT_MS. */
  streamHeartbeatMs?: number;
  /** The snapshot stream's coalescing window in ms (issue #157); 0 sends every emit as it lands. Defaults to SNAPSHOT_COALESCE_MS. */
  snapshotCoalesceMs?: number;
  /** How often an enlisted attempt re-reads its pane for Turn state (issue
   *  #101); tests shrink it so a queued teaching Turn lands without a
   *  real-time wait. Production leaves it unset (2 s). */
  enlistPollMs?: number;
  /** How often a live Conversation re-reads its pane for Turn state (issue
   *  #101); tests shrink it so an enlisted Conversation's teaching, opening
   *  and Notice Turns land without a real-time wait. Production leaves it
   *  unset (2 s). */
  conversationPollMs?: number;
  /** How long an enlist waits for a working pane to reach waiting before
   *  refusing (issue #101); tests shrink it. Production leaves it unset (a
   *  Launch's readiness bound). */
  enlistTeachingWaitMs?: number;
  /** How often the engine's pane survey lists herdr's panes (issue #139);
   *  tests shrink it. Production leaves it unset (15 s). */
  paneSurveyMs?: number;
  /**
   * What a `POST /api/stop` sets in motion once the route has accepted it
   * (issue #97). The CLI passes the same stop-then-exit the signal handler
   * runs; absent, the server runs its own `shutdown()` in place and stays
   * in the process, which is what an in-process test wants.
   */
  onStopRequested?: () => void;
  /**
   * What a `POST /api/restart` sets in motion once the route has accepted it
   * (issue #121). The CLI passes a stop-then-hand-off-to-Boot; absent, the
   * server runs its own `shutdown()` in place and stays in the process,
   * which is what an in-process test wants. A Restart is a Stop plus a
   * relaunch, so the farewell on the stream is identical and the tab that
   * asked is the one that knows the difference. It is handed the port the
   * route promised the tab, so the relaunch and the acknowledgement can
   * never name two different ports.
   */
  onRestartRequested?: (relaunchPort: number) => void;
  /**
   * Where the Machine defaults live (issue #121). Tests point this at a temp
   * home so the Settings routes never read or write the developer's own
   * file. Defaults to `~/.agent-graphs/defaults.json` with the two legacy
   * runner files behind it.
   */
  machineDefaultsPaths?: MachineDefaultsPaths;
}

/**
 * The snapshot stream's heartbeat interval: the server pushes one SSE comment
 * frame per connection at this cadence, inside common browser and proxy idle
 * timeouts so a healthy stream never idles out into a half-open state. A
 * comment frame is invisible to a browser EventSource, so the Console's client
 * reads the stream with fetch and treats any frame, snapshot or heartbeat, as
 * its liveness signal, reopening a stream that stays silent for a bounded
 * multiple of this interval. The interval is served as the stream's opening
 * frame, so the client's silence window derives from the served value.
 */
export const SNAPSHOT_STREAM_HEARTBEAT_MS = 20_000;

// How long a shutdown lets the just-closed snapshot streams flush their
// farewell before every connection is cut. Over loopback a single turn of
// the event loop is enough; the margin is for a slower link.
const STREAM_DRAIN_MS = 50;

/**
 * How long the snapshot stream gathers the engine's emits before sending
 * the latest of them (issue #157). Short enough that a tab never sees the
 * delay, long enough that a burst of emits (a super-step's boundary, a
 * merge, several panes' Turns at once) goes out as one frame.
 */
export const SNAPSHOT_COALESCE_MS = 50;

export interface PoolServer {
  latest: EnrichedSnapshot | null;
  start: () => Promise<EnrichedSnapshot>;
  answer: (ticketId: string, action: ResumeAction, note?: string) => Promise<EnrichedSnapshot>;
  /** Resolves once the in-flight drive settles, with the settled snapshot. */
  settled: () => Promise<EnrichedSnapshot>;
  url: string;
  close: () => Promise<void>;
  /**
   * The orderly stop (ADR-0017): stop the run's headless attempts, send the
   * stream its `stopped` farewell and close it (issue #97), stop serving,
   * release the pool lock. The CLI's signal handler calls this and exits
   * after it; in-process callers may call it directly. Idempotent: a second
   * call joins the first.
   */
  shutdown: (graceMs?: number) => Promise<void>;
  /** Start a Conversation (issue #60), for tests that would rather call
   *  through than round-trip HTTP. Throws "pool not started" before the
   *  first start(), and whatever the engine's startConversation throws
   *  otherwise (not terminal-backed, no git, unknown harness, ...) — the
   *  same errors the POST route maps to a 409. */
  startConversation: (req: StartConversationRequest) => Promise<ConversationView>;
  /** End a Conversation (issue #60), for tests. Throws "pool not started" or
   *  whatever the engine's endConversation throws (no live conversation
   *  with that id). */
  endConversation: (id: string, closing?: string) => Promise<void>;
  /** Enlist a live herdr pane as a Ticket (issue #101), for tests that would
   *  rather call through than round-trip HTTP. Throws "pool not started" or
   *  the engine's own reason, which the POST route maps to a 409. */
  enlist: (req: EnlistRequest) => Promise<EnlistResponse>;
  /** Keep talking (issue #139), for tests that would rather call through
   *  than round-trip HTTP. Throws "pool not started" or the engine's own
   *  reason, which the POST route maps to a 409. */
  keepTalking: (ticketId: string) => Promise<KeepTalkingResponse>;
}

// The Reassign row a ticket the module did not answer for falls back to: it
// is not reassignable, because nothing here can say that a write would reach
// it. Only a meta id that arrived between the views and this map can hit it.
const UNKNOWN_REASSIGN: TicketReassignView = {
  eligible: false,
  reason: "not yet known to the pool config",
  verify: null,
  // Drivers always resolve to something, so "unset" is a value the resolver
  // never reports for them and the badge would never otherwise show.
  sources: { harness: "unset", model: "unset", effort: "unset", drivers: "default" },
};

/** Enrich an engine snapshot with the pool's ticket metadata for the UI. */
function enrich(
  snapshot: PoolSnapshot,
  meta: TicketMarker[],
  poolName: string,
  poolDir: string,
  // Reassign (issue #126): one row per ticket, resolved from the config file
  // rather than from the engine's session, so a save shows on the card before
  // the boundary that will actually apply it.
  reassign: Map<string, TicketReassignEntry>,
  // The Pool title (issue #100), read from the config file as it stands now
  // for the same reason: a title saved from Settings shows at once.
  poolTitle: string | null,
): EnrichedSnapshot {
  const merge = new Map(snapshot.mergeQueue.map((entry) => [entry.ticketId, entry.state]));
  return {
    seq: snapshot.seq,
    phase: snapshot.phase,
    poolName,
    poolTitle,
    poolDir,
    finishedTerminals: snapshot.finishedTerminals,
    spawnUsage: snapshot.spawnUsage,
    pendingSpawns: snapshot.pendingSpawns,
    heldSpawns: snapshot.heldSpawns,
    stewardBudget: snapshot.stewardBudget,
    state: {
      tickets: meta.map((m) => {
        const row = reassign.get(m.id);
        return {
          id: m.id,
          title: m.title,
          blockedBy: m.blockedBy,
          status: snapshot.state.tickets[m.id] ?? "ready",
          mergeState: merge.get(m.id) ?? null,
          // A reassignable ticket's Assignment comes from the config file as
          // it stands now (issue #126), so a Reassign shows on the card at
          // once rather than at the next boundary. Everywhere else the
          // engine's record is the truth: an Attempt in flight froze its
          // Assignment, and a meta id the engine has not resolved yet (a
          // hand-written file seen between the meta refresh and the boundary
          // that adopts it) reads as unassigned until the record lands, the
          // engine owning the unassigned record.
          assignment: row?.assignment ??
            snapshot.assignments[m.id] ?? {
              ...UNASSIGNED_ASSIGNMENT_VIEW,
            },
          liveAttempt: snapshot.liveAttempts[m.id] ?? null,
          heldPane: snapshot.heldPanes[m.id] ?? null,
          // An enlisted ticket (issue #101) reads "as found" where a spawned
          // one names its model: the marker field is the durable fact.
          enlisted: m.enlistedFrom !== undefined,
          reassign: row?.reassign ?? UNKNOWN_REASSIGN,
        };
      }),
      conversations: snapshot.conversations,
      log: snapshot.state.log,
      outcomes: snapshot.state.outcomes,
      interrupts: snapshot.state.interrupts,
      mergeQueue: snapshot.mergeQueue,
      queuedAnswers: snapshot.queuedAnswers,
      config: snapshot.state.config as unknown as Record<string, unknown>,
    },
  };
}

function encodeSnapshot(snapshot: EnrichedSnapshot): Uint8Array {
  return new TextEncoder().encode(
    `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
  );
}

// The snapshot stream's liveness pulse: an SSE comment frame, so it carries no
// event for a browser EventSource to dispatch and is pure keep-alive plus the
// raw-frame liveness signal the fetch-based client measures.
const HEARTBEAT_FRAME = new TextEncoder().encode(": heartbeat\n\n");

// The stream's opening frame: the server publishes its heartbeat interval so
// the client derives its silence window from the served value rather than a
// hard-coded copy that could drift from the server's interval.
function encodeStreamConfig(heartbeatMs: number): Uint8Array {
  return new TextEncoder().encode(
    `event: stream-config\ndata: ${JSON.stringify({ heartbeatMs })}\n\n`,
  );
}

function serveStatic(distDir: string, pathname: string): Response | null {
  const resolved = pathname === "/" ? "/index.html" : pathname;
  const file = join(distDir, resolved);
  const body = Bun.file(file);
  if (!body.exists()) return null;
  const type =
    file.endsWith(".html")
      ? "text/html"
      : file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".json")
            ? "application/json"
            : "application/octet-stream";
  return new Response(body, { headers: { "content-type": type } });
}

// ---------------------------------------------------------------------------
// Ticket events endpoint
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ticket log endpoint
// ---------------------------------------------------------------------------

/** The largest byte range a single log response serves. Larger logs page. */
export const LOG_CHUNK_BYTES = 64 * 1024;

// ANSI escape sequences: CSI (colors, cursor movement) and OSC (title, hyperlinks)
// are stripped server-side so the served log reads as clean text.
const ANSI_ESCAPE_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/**
 * The ticket's attempts as log sources, in attempt order. Event-based tickets
 * (an events file exists) derive implement/resolver attempts from the events:
 * the latest of each kind holds its well-known path while that file exists,
 * older attempts their rotated attempt-numbered name (both named by the
 * events module's contract). Stream files resolve through the same contract
 * and the same current/rotated rule, so a re-run rotates both files alike;
 * an attempt whose Stream file was never written (a raw harness such as
 * opencode, or a pre-streaming attempt) carries null rather than a name the
 * filesystem cannot back. A verify fan-out's attempts write
 * attempt-numbered logs directly and the well-known name never appears, so
 * the current attempt falls back to its own number. A pre-feature ticket (no
 * events file) uses the reconstructed attempt rows, each with the log file it
 * was built from and no Stream file, since none existed pre-streaming.
 */
function listAttemptLogs(
  runsDir: string,
  ticketId: string,
): LogAttemptInfo[] {
  const events = readEvents(runsDir, ticketId);
  if (events.length > 0) {
    const spawned = events.filter((e) => e.kind === "spawned");
    const resolvers = events.filter((e) => e.kind === "resolver");
    const maxSpawned = spawned.reduce((m, e) => Math.max(m, e.attempt), 0);
    const maxResolver = resolvers.reduce((m, e) => Math.max(m, e.attempt), 0);
    const hasWellKnownLog = (resolver: boolean): boolean =>
      existsSync(join(runsDir, attemptLogName(ticketId, null, resolver)));
    const hasWellKnownStream = (resolver: boolean): boolean =>
      existsSync(join(runsDir, attemptStreamName(ticketId, null, resolver)));
    // The Stream file exists check: null when the resolved name is absent on
    // disk, so a raw harness's attempt renders no link rather than a dead one.
    const streamName = (
      attempt: number | null,
      resolver: boolean,
    ): string | null => {
      const name = attemptStreamName(ticketId, attempt, resolver);
      return existsSync(join(runsDir, name)) ? name : null;
    };
    const byAttempt = new Map<number, LogAttemptInfo>();
    for (const event of spawned) {
      const current = event.attempt === maxSpawned;
      byAttempt.set(event.attempt, {
        attempt: event.attempt,
        kind: "implement",
        current,
        logFile: attemptLogName(
          ticketId,
          current && hasWellKnownLog(false) ? null : event.attempt,
          false,
        ),
        streamFile: streamName(
          current && hasWellKnownStream(false) ? null : event.attempt,
          false,
        ),
      });
    }
    for (const event of resolvers) {
      const current = event.attempt === maxResolver;
      byAttempt.set(event.attempt, {
        attempt: event.attempt,
        kind: "resolver",
        current,
        logFile: attemptLogName(
          ticketId,
          current && hasWellKnownLog(true) ? null : event.attempt,
          true,
        ),
        streamFile: streamName(
          current && hasWellKnownStream(true) ? null : event.attempt,
          true,
        ),
      });
    }
    return [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt);
  }
  const reconstructed = reconstructAttempts(runsDir, ticketId);
  return reconstructed.map((row, index) => ({
    attempt: row.attempt,
    kind: "reconstructed" as const,
    logFile: row.logFile,
    streamFile: null,
    current: index === reconstructed.length - 1,
  }));
}

/**
 * The UTF-8 length of the leading char at `index`, or 0 when `index` sits on a
 * continuation byte or past the buffer. Used to avoid splitting a multi-byte
 * char across a byte-range boundary, which would decode as U+FFFD in the pane.
 */
function utf8CharLength(bytes: Uint8Array, index: number): number {
  const lead = bytes[index];
  if (lead === undefined) return 0;
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 0;
}

/**
 * Trim a raw byte slice so no multi-byte UTF-8 char straddles its tail: a
 * leading char whose continuation bytes fall past `end` is cut out, so the
 * next range read (from the trimmed end) brings it back whole.
 */
function utf8End(bytes: Uint8Array, start: number, end: number): number {
  let cut = end;
  let i = end - 1;
  while (i >= start && (bytes[i] & 0xc0) === 0x80) {
    cut = i;
    i -= 1;
  }
  if (i >= start) {
    const len = utf8CharLength(bytes, i);
    if (len > 0 && i + len > end) cut = i;
  }
  return cut;
}

/**
 * Trim a raw byte slice so no multi-byte UTF-8 char straddles its head: a
 * range that begins on a continuation byte drops the partial char and starts
 * at the next lead byte, so the pane head never decodes as U+FFFD. The byte
 * count removed is reported back so the caller can adjust the served offset.
 */
function utf8HeadTrim(bytes: Uint8Array, start: number, end: number): number {
  let cut = start;
  while (cut < end && (bytes[cut] & 0xc0) === 0x80) {
    cut += 1;
  }
  return cut - start;
}

/**
 * Read a byte range of a log file: from `offset` up to `LOG_CHUNK_BYTES` more
 * bytes (or EOF), ANSI-stripped. The client pages by requesting from the
 * returned `nextOffset` until it equals `totalSize`. An optional `end` bounds
 * the range below the chunk size, which is how "load earlier" reads exactly
 * the missing prefix before the bytes the pane already holds.
 */
async function readLogRange(
  logPath: string,
  offset: number,
  end?: number,
): Promise<{ content: string; offset: number; nextOffset: number; totalSize: number }> {
  if (!existsSync(logPath)) {
    return { content: "", offset: 0, nextOffset: 0, totalSize: 0 };
  }
  const file = Bun.file(logPath);
  const totalSize = file.size;
  const start = Math.min(Math.max(0, offset), totalSize);
  const bound =
    end !== undefined && Number.isFinite(end)
      ? Math.max(start, end)
      : start + LOG_CHUNK_BYTES;
  const rangeEnd = Math.min(start + LOG_CHUNK_BYTES, bound, totalSize);
  const bytes = new Uint8Array(await file.slice(start, rangeEnd).arrayBuffer());
  const headTrim = utf8HeadTrim(bytes, 0, bytes.length);
  const decodeEnd = utf8End(bytes, headTrim, bytes.length);
  return {
    content: stripAnsi(
      new TextDecoder().decode(bytes.subarray(headTrim, decodeEnd)),
    ),
    offset: start + headTrim,
    nextOffset: start + decodeEnd,
    totalSize,
  };
}

// Attempt logs are the four names the events module's naming contract
// produces, in the pool's runs directory. A ticket with no events file (a
// pre-feature pool) is backfilled one attempt row per existing log file, in
// modification-time order, marked as reconstructed.
function reconstructAttempts(
  runsDir: string,
  ticketId: string,
): ReconstructedAttempt[] {
  let files: string[] = [];
  try {
    files = readdirSync(runsDir);
  } catch {
    return [];
  }
  return files
    .filter((file) => parseAttemptLogName(ticketId, file) !== null)
    .map((file) => {
      const stat = statSync(join(runsDir, file));
      return { file, mtime: stat.mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ file, mtime }, index) => ({
      attempt: index + 1,
      logFile: file,
      modifiedAt: new Date(mtime).toISOString(),
    }));
}

function readTicketEvents(
  poolDir: string,
  ticketId: string,
  meta: TicketMarker[],
): TicketEventsResponse {
  const runsDir = join(poolDir, "runs");
  const events = readEvents(runsDir, ticketId);
  const spec = meta.find((m) => m.id === ticketId)?.spec ?? "";
  if (events.length > 0) {
    return { events, attempts: [], reconstructed: false, spec };
  }
  return {
    events: [],
    attempts: reconstructAttempts(runsDir, ticketId),
    reconstructed: true,
    spec,
  };
}

const UNTRACKED_MAX_BYTES = 256 * 1024;
const UNTRACKED_MAX_FILES = 100;

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lines++;
  }
  return text.endsWith("\n") ? lines : lines + 1;
}

// The worktree's diff summary, read with git off the engine's thread (issue
// #157): the UI asks for it every ~2 s per live ticket per tab, and a
// synchronous read stalled every other request and the snapshot stream
// while git and the untracked-file reads ran.
async function computeActivityDiff(cwd: string): Promise<TicketActivityResponse["diff"]> {
  try {
    const [numstat, status] = await Promise.all([
      gitAsync(cwd, ["diff", "--numstat", "HEAD"]),
      gitAsync(cwd, ["status", "--porcelain"]),
    ]);
    if (!numstat.ok || !status.ok) return null;
    const lines = new Map<string, { added: number; removed: number }>();
    const order: string[] = [];
    const record = (path: string, added: number, removed: number): void => {
      const existing = lines.get(path);
      if (existing) {
        existing.added += added;
        existing.removed += removed;
      } else {
        lines.set(path, { added, removed });
        order.push(path);
      }
    };
    for (const line of numstat.out.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed, ...rest] = line.split("\t");
      const path = rest.join("\t");
      if (!path) continue;
      // A binary entry ("- - path") counts as a file without lines.
      record(path, added === "-" ? 0 : Number(added) || 0, removed === "-" ? 0 : Number(removed) || 0);
    }
    let untracked = 0;
    for (const line of status.out.split("\n")) {
      if (!line.startsWith("?? ")) continue;
      if (untracked >= UNTRACKED_MAX_FILES) break;
      untracked += 1;
      let path = line.slice(3);
      if (path.startsWith('"') && path.endsWith('"')) {
        path = path.slice(1, -1);
      }
      try {
        const full = join(cwd, path);
        const info = await stat(full);
        if (!info.isFile()) continue;
        if (info.size >= UNTRACKED_MAX_BYTES) {
          // Over the read cap it still counts as a touched file, just with no
          // line counts.
          record(path, 0, 0);
          continue;
        }
        record(path, countLines(await readFile(full, "utf8")), 0);
      } catch {
        continue;
      }
    }
    return {
      added: order.reduce((sum, p) => sum + lines.get(p)!.added, 0),
      removed: order.reduce((sum, p) => sum + lines.get(p)!.removed, 0),
      files: order,
    };
  } catch {
    return null;
  }
}

/**
 * A ticket's Vitals. `running` and everything read from the runs directory
 * are read fresh on every request, since each is a stat or a cached events
 * parse; only the worktree diff, the one part that runs git, comes through
 * `diffOf`, the server's shared and briefly cached read.
 */
async function readTicketActivity(
  poolDir: string,
  ticketId: string,
  running: boolean,
  diffOf: (worktree: string) => Promise<TicketActivityResponse["diff"]>,
): Promise<TicketActivityResponse> {
  const runsDir = join(poolDir, "runs");
  const events = readEvents(runsDir, ticketId);
  let worktree: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind !== "spawned" && event.kind !== "resolver") continue;
    // Legacy events carry no cwd in their payload; they are skipped, never an
    // error, and the search falls back to an older attempt that has one.
    if (typeof event.payload?.cwd === "string") {
      worktree = event.payload.cwd;
      break;
    }
  }
  // `running` is the caller's: the last snapshot shows a Live attempt for
  // this ticket (an implement run in flight, or a resolver run in flight on
  // a conflicted merge). The events are read here only for the worktree.
  const lastEventAt = events.length > 0 ? events[events.length - 1].at : null;
  const diff =
    worktree !== null && existsSync(worktree) ? await diffOf(worktree) : null;
  const attempts = listAttemptLogs(runsDir, ticketId);
  const current = attempts[attempts.length - 1];
  let log: TicketActivityResponse["log"] = null;
  if (current) {
    try {
      const info = statSync(join(runsDir, current.logFile));
      log = { size: info.size, mtime: info.mtime.toISOString() };
    } catch {
      log = null;
    }
  }
  return { ticketId, running, diff, log, lastEventAt };
}

/**
 * How long one worktree diff answers every request for its ticket. Just
 * under the UI's ~2 s poll, so one tab still sees each poll's diff fresh,
 * while a second tab, or a burst of requests, shares the read already made.
 */
export const ACTIVITY_CACHE_TTL_MS = 1500;

// ---------------------------------------------------------------------------
// Grades endpoint
// ---------------------------------------------------------------------------

// The winning attempt's latest well-formed grade per ticket, keyed by ticket
// id; before a selection has landed, the latest graded event stands in.
// Parallel graders append in completion order, so the last graded line in the
// file can be a loser's grade: when a selected event (or, on a ticket graded
// before the selection machinery, a merged event) names the winner, that
// attempt's grade is what the card shows. The selected event lands before the
// merge, and a conflicted merge checkpoints with no merged event at all, so
// selected is the source of truth and merged only the fallback. Tickets with
// no grade are absent, so the UI renders no grade UI for them. A graded event
// whose payload is malformed is skipped the way the events reader skips a
// torn line: it can never have come from the engine's write path.
function readPoolGrades(
  poolDir: string,
  meta: TicketMarker[],
): Record<string, TicketGradeSummary> {
  const runsDir = join(poolDir, "runs");
  const grades: Record<string, TicketGradeSummary> = {};
  for (const marker of meta) {
    const events = readEvents(runsDir, marker.id);
    const graded = events.filter(
      (event) =>
        event.kind === "graded" &&
        typeof event.payload.score === "number" &&
        typeof event.payload.verdict === "string" &&
        typeof event.payload.reasons === "string",
    );
    const last = graded.at(-1);
    if (!last) continue;
    const winner =
      events.filter((event) => event.kind === "selected").at(-1)?.attempt ??
      events.filter((event) => event.kind === "merged").at(-1)?.attempt ??
      null;
    // A named winner whose own grade is malformed serves nothing: falling
    // back to another attempt's grade would put a loser's numbers on the
    // card while the Detail's badge marks the winner.
    const pick =
      winner !== null
        ? graded.filter((event) => event.attempt === winner).at(-1)
        : last;
    if (!pick) continue;
    grades[marker.id] = {
      attempt: pick.attempt,
      score: pick.payload.score as number,
      verdict: pick.payload.verdict as string,
      winner,
    };
  }
  return grades;
}

// ---------------------------------------------------------------------------
// Ticket body endpoint
// ---------------------------------------------------------------------------

// The line-1 `<!-- state: ... -->` marker is pool metadata, never prose for
// the UI: drop it, and the blank lines that separated it from the body.
function stripStateMarker(text: string): string {
  const lines = text.split("\n");
  if (!MARKER_RE.test(lines[0] ?? "")) return text;
  let first = 1;
  while (first < lines.length && lines[first].trim() === "") first += 1;
  return lines.slice(first).join("\n");
}

// The ticket body endpoint answers with the ticket's markdown body. Issue
// files are named `<id>.md` or `<id>-<slug>.md`; match the exact name first,
// then any file whose prefix before the first `-` equals the id. The lookup
// is scoped to the files readdir reports from the pool's issues directory, so
// an arbitrary id can never walk out of it (plain string equality, no regex
// on the id).
function readTicketBody(
  poolDir: string,
  ticketId: string,
): TicketBodyResponse | null {
  const issuesDir = join(poolDir, "issues");
  let files: string[] = [];
  try {
    files = readdirSync(issuesDir);
  } catch {
    return null;
  }
  const markdown = files.filter((file) => file.endsWith(".md"));
  const file =
    markdown.find((file) => file === `${ticketId}.md`) ??
    markdown.find((file) => {
      const dash = file.indexOf("-");
      return dash > 0 && file.slice(0, dash) === ticketId;
    });
  if (!file) return null;
  return {
    id: ticketId,
    body: stripStateMarker(readFileSync(join(issuesDir, file), "utf8")),
  };
}

function readLockedPid(poolDir: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(join(poolDir, "runs", "server.pid"), "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAddressInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "EADDRINUSE";
}

/**
 * Bind the pool server per the resolution. A pinned port that is busy is a
 * hard failure naming the port and, when the fleet registry knows the holder,
 * the conflicting pool directory and pid; only the unpinned path hunts upward
 * from the default for a free one. Port 0 means "any free port" (Bun
 * ephemeral).
 */
function bindPoolServer(
  resolution: PortResolution,
  serve: (port: number) => Bun.Server<undefined>,
  registryPath: string,
): Bun.Server<undefined> {
  if (resolution.pinned) {
    try {
      return serve(resolution.port);
    } catch (err) {
      if (isAddressInUse(err)) {
        const holder = readFleetEntryByPort(registryPath, resolution.port);
        const holderText = holder
          ? ` by pool ${holder.poolDir} (pid ${holder.pid})`
          : "";
        throw new Error(
          `port ${resolution.port} is already in use${holderText}; ` +
            "free it or pass a different --port",
        );
      }
      throw err;
    }
  }
  if (resolution.port === 0) return serve(0);
  let port = resolution.port;
  while (port <= 65535) {
    try {
      return serve(port);
    } catch (err) {
      if (!isAddressInUse(err)) throw err;
      port += 1;
    }
  }
  throw new Error(`no free port found from ${resolution.port} upward`);
}

/**
 * One server per pool. If runs/server.pid names a live process, refuse with a
 * message naming that pid, its fleet-registry port when known, and the pool
 * directory. Otherwise claim the pool by writing our own pid. There is no
 * force override: a live lock always means use the running console or kill it.
 *
 * The claim is atomic (O_EXCL create), so two near-simultaneous launches of
 * the same pool cannot both pass. A stale lock is cleared only when it still
 * names a dead pid or is still unreadable after a beat, so a lock another
 * server is mid-way through claiming is never trampled.
 */
function acquirePoolLock(poolDir: string, registryPath: string): void {
  const pidPath = join(poolDir, "runs", "server.pid");
  mkdirSync(join(poolDir, "runs"), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(pidPath, `${process.pid}\n`, { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readLockedPid(poolDir);
    if (holder !== null) {
      if (pidIsLive(holder)) {
        const entry = readFleetEntry(registryPath, poolDir, holder);
        const portText = entry ? ` on port ${entry.port}` : "";
        throw new Error(
          `pool ${poolDir} is locked by live server pid ${holder}${portText}; ` +
            "open the running console or kill it",
        );
      }
      // A dead holder is a stale lock. Remove it only if it still names the
      // same dead pid on re-read: a live server may have claimed it since.
      if (readLockedPid(poolDir) === holder) {
        rmSync(pidPath, { force: true });
      }
      continue;
    }
    // Empty or unreadable: a writer may be mid-claim, its pid landing within
    // microseconds. Wait a beat and re-read; a lock still empty afterwards is
    // garbage from a crashed or bogus earlier state, and is cleared.
    Bun.sleepSync(25);
    if (readLockedPid(poolDir) === null) {
      rmSync(pidPath, { force: true });
    }
  }
  throw new Error(
    `pool ${poolDir}: could not claim the pool lock after five attempts`,
  );
}

/**
 * Release the pool lock on an orderly shutdown, only if it still names this
 * process: a relaunch that already reclaimed the pool must keep its lock. A
 * crash still leaves the file, and the next boot's stale-lock check clears
 * it, exactly as before.
 */
function releasePoolLock(poolDir: string): void {
  if (readLockedPid(poolDir) !== process.pid) return;
  rmSync(join(poolDir, "runs", "server.pid"), { force: true });
}

/**
 * The oldest Bun a terminal-backed pool boots on. Bun 1.2.13 on macOS
 * segfaulted inside its event loop's poll dispatch a few hundred
 * milliseconds into a `terminal: "herdr"` boot (issue #61), the same pool
 * booting clean headless. The crash was not reproduced on Linux under
 * 1.2.13 or 1.3.14, so this floor is not a verified fix: the trace sits in
 * the runtime rather than the engine, bun.report's own advice was to
 * upgrade, and 1.2.x separately fails the engine's own suite, so the
 * terminal path refuses a runtime it is not tested on with a line of its
 * own instead of letting it crash without one. A crash on a newer Bun is a
 * new trace, not this floor's business.
 */
export const TERMINAL_MIN_BUN_VERSION = "1.3.0";

/**
 * Why a terminal-backed pool cannot boot on this runtime, or null when it
 * can. Headless pools are never refused: the fault is on the terminal path
 * alone, and running headless is exactly the workaround (issue #61).
 */
export function terminalRuntimeRefusal(
  config: PoolConfig,
  bunVersion: string,
): string | null {
  if (config.terminal !== "herdr") return null;
  if (!versionBelow(bunVersion, TERMINAL_MIN_BUN_VERSION)) return null;
  return (
    `terminal-backed pools need Bun ${TERMINAL_MIN_BUN_VERSION} or newer ` +
    `(this is Bun ${bunVersion}): Bun 1.2.13 segfaulted inside its event ` +
    `loop on the terminal-backed boot (issue #61). Run \`bun upgrade\`, or ` +
    `drop "terminal" from console.json to run the pool headless.`
  );
}

// Numeric dotted-version comparison; an unparseable version is not below
// anything, so an unexpected runtime string never refuses a boot.
function versionBelow(version: string, floor: string): boolean {
  const parse = (v: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const have = parse(version);
  const want = parse(floor);
  if (!have || !want) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] < want[i];
  }
  return false;
}

export function createPoolServer(options: PoolServerOptions): PoolServer {
  const poolDir = resolve(options.poolDir);
  // The config as this process booted with it. The terminal refusal, the port
  // resolution and the Settings pane's `effective` all read this one parse:
  // the boot-only keys (ADR-0018) are frozen for the life of the run, so a
  // later re-read could only disagree with what is actually running.
  const bootConfig = readConfig(poolDir);
  const refusal = terminalRuntimeRefusal(bootConfig, Bun.version);
  if (refusal !== null) throw new Error(refusal);
  const registryPath = options.registryPath ?? defaultRegistryPath();
  acquirePoolLock(poolDir, registryPath);
  const distDir = options.distDir ?? join(import.meta.dir, "..", "ui", "dist");
  const harnesses = { ...defaultHarnesses, ...options.harnesses };
  const herdrSocket = options.herdrSocket ?? HERDR_SOCKET_DEFAULT;
  const herdrWorkspace = options.herdrWorkspace;
  const jev = options.jev;
  const machineDefaultsPaths =
    options.machineDefaultsPaths ?? defaultMachineDefaultsPaths();
  const streamHeartbeatMs =
    options.streamHeartbeatMs ?? SNAPSHOT_STREAM_HEARTBEAT_MS;
  // The pool's ticket metadata, as the engine parses it from the Issue files —
  // the engine's own load (loadPoolTickets), so the server accepts exactly the
  // pools the engine does: an empty issues/ on a pool with a conversations/
  // directory, and a Ticket whose spawned-by names a Conversation (issue #71).
  // The id set scopes the ticket endpoints to ids the pool actually owns, and
  // keeps every lookup inside the pool's runs directory: an arbitrary id can
  // never walk out of it. Both track the issues directory (refreshed per
  // snapshot and per request), so a ticket the engine writes after boot is
  // known the moment it lands.
  let meta = loadPoolTickets(poolDir);
  let ticketIds = new Set(meta.map((m) => m.id));
  // Conversation ids (issue #60), read the same way ticket meta is: from
  // disk on every snapshot and every Conversation request, so a Conversation
  // that just started is known before its next engine snapshot lands. The
  // conversations directory does not exist on a pool with none yet, and
  // loadConversations reads that as [] rather than throwing.
  let conversationRecords: ConversationRecord[] = loadConversations(
    join(poolDir, "conversations"),
  );
  let conversationIds = new Set(conversationRecords.map((c) => c.id));
  const poolName = poolDir.split("/").slice(-2).join("/");

  // A short in-memory cache of each ticket's worktree diff absorbs the
  // client's repeat polls (ADR 0011): one entry per known ticket id, so it
  // never grows past the pool's size. A read in flight is shared by every
  // request that arrives while it runs, and its answer then serves for the
  // TTL from when it landed; a new worktree (the next attempt) reads afresh.
  // No mtime-based invalidation.
  const diffCache = new Map<
    string,
    { worktree: string; landedAt: number | null; diff: Promise<TicketActivityResponse["diff"]> }
  >();
  function worktreeDiff(
    ticketId: string,
    worktree: string,
  ): Promise<TicketActivityResponse["diff"]> {
    const hit = diffCache.get(ticketId);
    if (
      hit?.worktree === worktree &&
      (hit.landedAt === null || Date.now() - hit.landedAt < ACTIVITY_CACHE_TTL_MS)
    ) {
      return hit.diff;
    }
    const entry = {
      worktree,
      landedAt: null as number | null,
      diff: computeActivityDiff(worktree).finally(() => {
        entry.landedAt = Date.now();
      }),
    };
    diffCache.set(ticketId, entry);
    return entry.diff;
  }
  function readTicketActivityCached(ticketId: string): Promise<TicketActivityResponse> {
    return readTicketActivity(
      poolDir,
      ticketId,
      (current()?.state.tickets.find((t) => t.id === ticketId)?.liveAttempt ?? null) !== null,
      (worktree) => worktreeDiff(ticketId, worktree),
    );
  }

  // The grades as last derived, under a key of the ticket ids and each one's
  // events file stamp (issue #157): the Console asks on every snapshot, and
  // the answer moves only when a ticket or an events file does. An events
  // file inside the racy window has no stamp, so the grades are derived
  // afresh until it settles.
  let gradesCache: { key: string; grades: Record<string, TicketGradeSummary> } | null = null;
  function poolGrades(): Record<string, TicketGradeSummary> {
    const runsDir = join(poolDir, "runs");
    const stamps = meta.map((m) => [m.id, eventsStamp(runsDir, m.id)] as const);
    if (stamps.some(([, stamp]) => stamp === null)) return readPoolGrades(poolDir, meta);
    const key = JSON.stringify(stamps);
    if (gradesCache?.key !== key) gradesCache = { key, grades: readPoolGrades(poolDir, meta) };
    return gradesCache.grades;
  }

  // Pool meta is read from disk, never cached from boot: the engine writes
  // ticket files mid-run (Spawn adoptions, grader and head-to-head tickets),
  // and each must render as a card and be accepted by the ticket endpoints
  // the moment it lands. A reload that fails keeps the last-known-good meta
  // and the next snapshot or request retries: a torn write or a draft file
  // without a valid marker must never break snapshot delivery.
  function refreshMeta(): void {
    try {
      meta = loadPoolTickets(poolDir);
      ticketIds = new Set(meta.map((m) => m.id));
    } catch {
      // Keep the last-known-good meta.
    }
    try {
      conversationRecords = loadConversations(join(poolDir, "conversations"));
    } catch {
      // Keep the last-known-good records.
    }
    // Union in whatever the live snapshot already knows: a Conversation
    // that started this instant is on disk before its record here is
    // re-read (writeConversation happens before the herdr tab opens), so
    // this is belt-and-braces rather than the primary source, matching how
    // `ticketIds` trusts the disk read as the ground truth.
    const fromSnapshot = lastRaw?.conversations.map((c) => c.id) ?? [];
    conversationIds = new Set([
      ...conversationRecords.map((c) => c.id),
      ...fromSnapshot,
    ]);
  }

  // The enriched snapshot as last built. Read it through current(), never
  // directly: an engine snapshot that arrived since is enriched there first.
  let latest: EnrichedSnapshot | null = null;
  // The last engine snapshot as it arrived, kept so a Reassign write can
  // rebuild the enriched snapshot from the file it just wrote without waiting
  // for the run to tick: a quiescent pool has no next tick to wait for.
  let lastRaw: PoolSnapshot | null = null;
  // An engine snapshot not yet enriched (issue #157). The engine emits in
  // bursts, a Turn's last line every couple of seconds per live pane among
  // them, and enriching each one re-read the pool's files and serialised the
  // whole snapshot for every emit. Now the enrichment waits until something
  // reads the snapshot: a request, or the stream's coalesced send below.
  let pendingRaw: PoolSnapshot | null = null;

  /**
   * The enriched snapshot as of the engine's last emit. Every reader comes
   * through here, so a route answering right after the engine emitted (an
   * accepted answer, a Reassign write) answers with that emit, exactly as
   * when every emit was enriched on arrival.
   */
  function current(): EnrichedSnapshot | null {
    if (pendingRaw !== null) {
      const raw = pendingRaw;
      refreshMeta();
      latest = enrich(raw, meta, poolName, poolDir, reassignRows(raw, meta), titleNow());
      pendingRaw = null;
    }
    return latest;
  }
  let currentRun: PoolRun | null = null;
  let started = false;

  // The pool config, parsed once per distinct file text. Every snapshot tick
  // wants it (Reassign resolves each ticket's Assignment from the file), and
  // the file changes rarely, so the read stays and the parse is cached.
  // Keyed on the text rather than on an mtime so a hand edit and a save are
  // both caught, however fast they land.
  let configCache: { text: string; config: PoolConfig | null; error: string | null } = {
    text: "",
    config: {},
    error: null,
  };
  function currentConfig(): { config: PoolConfig | null; error: string | null } {
    let text = "";
    try {
      const path = poolSettingsPath(poolDir);
      text = existsSync(path) ? readFileSync(path, "utf8") : "";
    } catch (err) {
      return { config: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (text !== configCache.text) {
      try {
        // The text just read, not a second read of the file: a rewrite
        // between the two would leave the cache key describing one version
        // of console.json and the parsed config another.
        configCache = { text, config: parseConfig(text, poolDir), error: null };
      } catch (err) {
        configCache = {
          text,
          config: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { config: configCache.config, error: configCache.error };
  }

  // The Pool title (issue #100) as the config file last parsed it, and the
  // one the engine was last told. A file that no longer parses keeps the
  // last good title rather than blanking the header over a torn write.
  let poolTitle = titleOf(bootConfig);

  /**
   * The Pool title for the next snapshot, read through the same cached parse
   * Reassign uses. A title that moved since the last snapshot, whether saved
   * from Settings or edited by hand, is handed to the run so a Pool
   * workspace the Console created is relabelled to it; the engine decides
   * whether the workspace is its to relabel.
   */
  function titleNow(): string | null {
    const { config } = currentConfig();
    if (config === null) return poolTitle;
    const title = titleOf(config);
    if (title !== poolTitle) {
      poolTitle = title;
      void currentRun?.retitle(title);
    }
    return poolTitle;
  }

  /** Every ticket's Reassign row for one engine snapshot (issue #126). */
  function reassignRows(
    snapshot: PoolSnapshot,
    markers: TicketMarker[],
  ): Map<string, TicketReassignEntry> {
    const { config, error } = currentConfig();
    return reassignViews({
      markers,
      config,
      configError: error,
      harnesses,
      liveAttempts: liveAttemptIds(snapshot),
      statuses: snapshot.state.tickets,
      engineAssignments: snapshot.assignments,
    });
  }

  function liveAttemptIds(snapshot: PoolSnapshot): Set<string> {
    return new Set(
      Object.entries(snapshot.liveAttempts)
        .filter(([, record]) => record != null)
        .map(([id]) => id),
    );
  }

  /**
   * Rebuild the enriched snapshot from the last engine snapshot and the
   * config file as it is right now, and push it to every open tab. A
   * Reassign write calls this so its own answer, and every other tab, shows
   * the new Assignment immediately; the engine's next boundary is what
   * actually moves the run, and it will emit the `reassigned` events then.
   */
  function reenrich(): EnrichedSnapshot | null {
    if (!lastRaw) return current();
    received(lastRaw);
    return current();
  }

  // Every open snapshot stream, each with the teardown of its own heartbeat
  // so a shutdown can end the streams cleanly rather than leaving them to be
  // cut by the socket close, and the snapshot it was last sent, so a send
  // never repeats one.
  const clients = new Map<
    ReadableStreamDefaultController<Uint8Array>,
    { stopHeartbeat: () => void; sent: EnrichedSnapshot | null }
  >();

  // The stream's coalescing window (issue #157): an emit starts it, every
  // emit inside it joins it, and at its end the snapshot as it stands then
  // goes out once, serialised once for every tab. A burst of emits is one
  // send, at most this long after its first.
  const coalesceMs = options.snapshotCoalesceMs ?? SNAPSHOT_COALESCE_MS;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  // The frame of the snapshot last serialised, so a send and a connect
  // never encode the same snapshot twice.
  let framed: { snapshot: EnrichedSnapshot; bytes: Uint8Array } | null = null;

  function frameOf(snapshot: EnrichedSnapshot): Uint8Array {
    if (framed?.snapshot !== snapshot) framed = { snapshot, bytes: encodeSnapshot(snapshot) };
    return framed.bytes;
  }

  // Sends one stream the snapshot as it stands, unless it already has it.
  function sendTo(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const client = clients.get(controller);
    const snapshot = current();
    if (!client || snapshot === null || client.sent === snapshot) return;
    try {
      controller.enqueue(frameOf(snapshot));
      client.sent = snapshot;
    } catch {
      client.stopHeartbeat();
      clients.delete(controller);
    }
  }

  // The window's end. The snapshot is brought up to date even with no tab
  // open, so the ids the ticket routes accept and the Pool title the run
  // is told follow the engine without waiting for a reader.
  function sendNow(): void {
    if (sendTimer !== null) clearTimeout(sendTimer);
    sendTimer = null;
    current();
    for (const controller of [...clients.keys()]) sendTo(controller);
  }

  // An engine snapshot arrived (or a Reassign write rebuilt the last one):
  // readers see it at once, the streams at the end of the window.
  function received(snapshot: PoolSnapshot): void {
    pendingRaw = snapshot;
    if (coalesceMs <= 0) sendNow();
    else if (sendTimer === null) sendTimer = setTimeout(sendLater, coalesceMs);
  }

  // The timed send has no caller to throw to: an enrichment that fails is
  // reported, and the next emit or request tries again.
  function sendLater(): void {
    try {
      sendNow();
    } catch (err) {
      console.error(
        `snapshot stream: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // End every snapshot stream after its last frame (the farewell, when the
  // run sent one): the client sees an orderly end-of-stream behind a
  // `stopped` snapshot, not a reset socket. A send still waiting out its
  // window goes first, so the farewell is never left behind.
  function closeStreams(): void {
    sendNow();
    for (const [controller, { stopHeartbeat }] of [...clients]) {
      stopHeartbeat();
      clients.delete(controller);
      try {
        controller.close();
      } catch {
        // Already gone; nothing to end.
      }
    }
  }

  // The engine handle exists from the first super-step: startPool returns it
  // immediately and the drive proceeds in the background, so answers are
  // accepted from the very start of the run.
  function driveRun(): EnrichedSnapshot {
    if (currentRun) currentRun.close();
    currentRun = startPool({
      poolDir,
      harnesses,
      herdrSocket,
      ...(herdrWorkspace !== undefined ? { herdrWorkspace } : {}),
      ...(options.enlistPollMs !== undefined ? { enlistPollMs: options.enlistPollMs } : {}),
      ...(options.conversationPollMs !== undefined
        ? { conversationPollMs: options.conversationPollMs }
        : {}),
      ...(options.enlistTeachingWaitMs !== undefined
        ? { enlistTeachingWaitMs: options.enlistTeachingWaitMs }
        : {}),
      ...(options.paneSurveyMs !== undefined ? { paneSurveyMs: options.paneSurveyMs } : {}),
      ...(jev !== undefined ? { jev } : {}),
      // The Steward's teaching names where its command reaches (ADR-0030).
      consoleUrl: `http://localhost:${server.port}`,
      // The server reads only the snapshot it was last handed (issue #157).
      snapshotHistory: 1,
      onSnapshot: (snapshot) => {
        lastRaw = snapshot;
        received(snapshot);
      },
    });
    return current()!;
  }

  const start = (): Promise<EnrichedSnapshot> => {
    if (!started) {
      started = true;
      driveRun();
    }
    return Promise.resolve(current()!);
  };

  // Acceptance only (ADR-0004): the engine records the answer synchronously
  // and the caller gets the current snapshot right away; processing happens
  // immediately when the pool is idle and at the next super-step boundary
  // otherwise.
  async function answer(
    ticketId: string,
    action: ResumeAction,
    note?: string,
  ): Promise<EnrichedSnapshot> {
    const run = currentRun;
    if (!run) throw new Error("pool not started");
    if (action !== "resume") {
      // Only the run's review gate (REVIEW_TICKET_ID) and a ticket's
      // merge-approval take approve/reject; anything else is a malformed
      // request, so fail at the seam instead of the engine silently treating
      // it as a resume.
      const kind = current()?.state.interrupts.find(
        (i) => i.ticketId === ticketId,
      )?.kind;
      // No pending interrupt: this may be a retry of an answer already
      // accepted and processed, which must be acknowledged again. The
      // engine's queued-answer store decides (202 retry vs genuine 400).
      if (kind !== undefined && kind !== "review" && kind !== "merge-approval") {
        throw new Error(
          `answer: approve/reject needs the review gate (${REVIEW_TICKET_ID}) ` +
            `or a merge-approval interrupt, got ${kind ?? "no interrupt"} ` +
            `for ${ticketId}`,
        );
      }
    }
    run.accept(
      ticketId,
      note,
      action === "approve" ? true : action === "reject" ? false : undefined,
    );
    // The snapshot after acceptance: mid-flight it carries the queued answer
    // (the acceptance emit has already broadcast it), idle it carries the
    // processed state, since the drain and the fresh drive's first emit run
    // synchronously inside accept. Returning the pre-accept snapshot instead
    // would race that SSE frame and could clobber the waiting state in the
    // UI.
    return current()!;
  }

  const settled = (): Promise<EnrichedSnapshot> => {
    const run = currentRun;
    if (!run) return Promise.resolve(current()!);
    return run.settled.then(() => current()!);
  };

  // Conversations (issue #60): thin proxies onto the engine's own
  // startConversation/endConversation, exposed both as PoolServer methods
  // (for tests that would rather call through than round-trip HTTP) and
  // behind the two POST routes below. "pool not started" mirrors `answer`'s
  // "pool not started" guard above: neither route is reachable before the
  // first /api/start in practice (the CLI calls it at boot), but a test or
  // a client racing ahead of it gets a clear error instead of a null
  // dereference.
  async function startConversation(
    req: StartConversationRequest,
  ): Promise<ConversationView> {
    const run = currentRun;
    if (!run) throw new Error("pool not started");
    return run.startConversation(req);
  }

  async function endConversation(id: string, closing?: string): Promise<void> {
    const run = currentRun;
    if (!run) throw new Error("pool not started");
    return run.endConversation(id, closing);
  }

  // Enlist (issue #101): the same thin proxy shape as startConversation,
  // behind POST /api/enlist below.
  async function enlist(req: EnlistRequest): Promise<EnlistResponse> {
    const run = currentRun;
    if (!run) throw new Error("pool not started");
    return run.enlist(req);
  }

  // Keep talking (issue #139): the same thin proxy shape as enlist, behind
  // POST /api/keep-talking below.
  async function keepTalking(ticketId: string): Promise<KeepTalkingResponse> {
    const run = currentRun;
    if (!run) throw new Error("pool not started");
    const { attempt } = await run.keepTalking(ticketId);
    return { ticketId, attempt };
  }

  // The shared first half of both terminal endpoints: the id (a ticket's or,
  // since issue #60, a Conversation's) -> pane translation, read from the
  // last snapshot alone: a ticket's Live attempt pane or a Conversation
  // view's pane, both the engine's own record of the panes it holds. Unknown
  // ids take the same "no pane" answer as headless, finished, and
  // never-spawned ones and ended Conversations, so the endpoints never
  // reveal which ids exist and every no-pane case is one shape. Since issue
  // #101 the guarantee is engine registration, not who opened the tab: an
  // enlisted pane is registered by the engine exactly as a spawned one is,
  // so it resolves here and a pane the engine never registered never does.
  // A Held pane (issue #139) is the engine's record too: the pane of a
  // checkpointed attempt, served while its Interrupt waits and the pane is
  // still listed, so a card at a checkpoint keeps its peek and focus.
  function resolveTerminalRequest(ticketId: string):
    | { ok: true; paneId: string }
    | { ok: false; status: number; error: string } {
    const ticket = current()?.state.tickets.find((t) => t.id === ticketId);
    const paneId =
      ticket?.liveAttempt?.paneId ??
      ticket?.heldPane?.paneId ??
      current()?.state.conversations.find((c) => c.id === ticketId)?.paneId ??
      null;
    if (paneId === null || paneId === "") {
      return {
        ok: false,
        status: 404,
        error: `no terminal-backed pane for ticket ${ticketId}`,
      };
    }
    return { ok: true, paneId };
  }

  // ---------------------------------------------------------------------
  // Settings (issue #121)
  // ---------------------------------------------------------------------

  /**
   * Everything the Settings pane draws, in one payload: the pool's config as
   * it is on disk right now, which of its keys a save will not reach until a
   * Restart, what this process actually booted with, the Machine defaults in
   * force beside the file's own fields, and the harness names to offer.
   *
   * The pool half is re-read on every request rather than served from boot:
   * the pane has to show a hand edit, and a save has to be reflected back
   * from the file it just wrote, not from this process's memory of it.
   */
  function settingsPayload(boundPort: number): SettingsResponse {
    const pool = readPoolSettings(poolDir);
    return {
      pool: {
        path: pool.path,
        config: pool.config,
        bootOnly: [...BOOT_ONLY_KEYS],
        effective: {
          port: boundPort,
          terminal: bootConfig.terminal ?? null,
          stale: staleBootOnlyKeys(pool.config, boundPort),
        },
      },
      machine: {
        path: machineDefaultsPaths.file,
        defaults: readMachineDefaults(machineDefaultsPaths),
        own: readMachineDefaultsFile(machineDefaultsPaths.file),
      },
      harnesses: Object.keys(harnesses).sort(),
    };
  }

  /**
   * The boot-only keys whose saved value is not what this process is running
   * on, so the Console can badge them as waiting for a Restart. Derived here
   * rather than from what a save changed, because the difference outlives
   * the tab that made it: a reload, a second tab, or an edit made by hand in
   * the file all have to show the same badge.
   *
   * Port is judged by where a Restart would actually put the Console rather
   * than by whether the pin changed: pinning the port the pool already runs
   * on moves nothing. Clearing a pin moves nothing either, because the
   * handover pins the running port so the waiting tab finds the Console
   * again; a cleared pin takes effect at the next cold Boot instead, which
   * is the one place this readout and the operator's intent part company.
   */
  function staleBootOnlyKeys(config: PoolConfig, boundPort: number): string[] {
    const stale: string[] = [];
    for (const key of BOOT_ONLY_KEYS) {
      if (key === "port") {
        if (relaunchPort(boundPort) !== boundPort) stale.push(key);
      } else if (key === "terminal") {
        if ((config.terminal ?? null) !== (bootConfig.terminal ?? null)) stale.push(key);
      } else if (JSON.stringify(config[key]) !== JSON.stringify(bootConfig[key])) {
        stale.push(key);
      }
    }
    return stale;
  }

  /**
   * Where the tab should look for the Console once Boot has relaunched it:
   * the pin in console.json, re-read from disk because the pane may have
   * saved a new one a moment ago and that save is exactly what a Restart
   * exists to apply; otherwise this server's bound port, which already
   * reflects any `--port` this CLI was started with. The bound port must
   * not outrank the pin: every Restart hands Boot a `--port`, so if the
   * command line won here a pin saved after the first Restart could never
   * take effect. Port 0 is never a pin, so it is not one here.
   */
  function relaunchPort(boundPort: number): number {
    try {
      const pin = readPoolSettings(poolDir).config.port;
      return pin !== undefined && pin !== 0 ? pin : boundPort;
    } catch {
      // A console.json edited into a broken state since boot: the bound port
      // is still the honest answer, and the Boot script will say the rest.
      return boundPort;
    }
  }

  const resolution = resolvePort(
    options.port,
    bootConfig.port,
    options.defaultPort ?? DEFAULT_PORT,
  );
  let server: Bun.Server<undefined>;

  // The orderly stop, one per server: a signal, a `POST /api/stop`, or an
  // in-process caller all land here, and a second arrival joins the first.
  // The attempts stop first, while the run's own exit handling can still
  // record each stop, and the run's farewell `stopped` snapshot goes out to
  // every stream as its last frame; the streams end next, then serving
  // stops so no answer arrives into a closing run; the lock goes last, once
  // nothing of this process still owns the pool.
  let stopping: Promise<void> | null = null;
  const shutdown = (graceMs?: number): Promise<void> => {
    if (!stopping) {
      stopping = (async () => {
        if (currentRun) await currentRun.shutdown(graceMs);
        closeStreams();
        // A closed stream still has its last frames in flight: a forced stop
        // on the same turn resets the socket under the farewell and the tab
        // never sees it. One short pause lets the closed streams flush. (A
        // graceful stop(false) first is not the answer: a stop(true) after
        // it no longer closes the idle keep-alive connections, so the port
        // would go on answering with the lock already released.)
        await Bun.sleep(STREAM_DRAIN_MS);
        await server.stop(true);
        releasePoolLock(poolDir);
      })();
    }
    return stopping;
  };
  // Set the moment a stop is accepted, on the route's own turn, so a second
  // POST arriving before the deferred stop has begun is acknowledged rather
  // than starting another one. `shutdown` latches itself, but an
  // `onStopRequested` owner leaves no promise here to join, so the latch has
  // to sit in front of the handover too (issue #97).
  let stopRequested = false;
  const requestStop = (): void => {
    if (options.onStopRequested) options.onStopRequested();
    else void shutdown();
  };
  // A Restart is the same stop with a relaunch behind it (issue #121), so it
  // shares the latch above: a Stop and a Restart racing each other land one
  // teardown, and whichever arrived first decides whether a Console comes
  // back. Absent an owner the server shuts itself down in place, which is
  // what an in-process test wants; nothing relaunches it there.
  const requestRestart = (relaunchPort: number): void => {
    if (options.onRestartRequested) options.onRestartRequested(relaunchPort);
    else void shutdown();
  };
  const stopUnderWay = (): boolean => stopRequested || stopping !== null;

  try {
    server = bindPoolServer(
      resolution,
      (port) =>
      Bun.serve({
        port,
      async fetch(req, bunServer) {
        const url = new URL(req.url);
        const pathname = url.pathname;

        if (pathname === "/api/state") {
          return Response.json({ snapshot: current() });
        }

        if (pathname === "/api/start" && req.method === "POST") {
          const snapshot = await start();
          return Response.json({ snapshot });
        }

        // Stop this server from the Console (issue #97): only a finished
        // pool may be stopped this way. Any other phase can have an attempt
        // mid-flight (or an answer the operator is about to give), so a
        // stale tab or a stray curl gets a 409 rather than a stop. The reply
        // goes out before the stop begins, the way /api/resume acknowledges
        // before processing; the farewell on the stream is how the tab
        // learns the stop landed. A stop already under way is acknowledged
        // again rather than started twice.
        if (pathname === "/api/stop" && req.method === "POST") {
          const phase = current()?.phase ?? null;
          if (!stopUnderWay() && phase !== "done") {
            return Response.json(
              {
                error:
                  phase === null
                    ? "pool not started: nothing to stop"
                    : `pool is ${phase}, not done: stop refused`,
              },
              { status: 409 },
            );
          }
          if (!stopUnderWay()) {
            stopRequested = true;
            // Off the request's own turn, so the 202 is on the wire before
            // serving stops underneath it.
            setTimeout(requestStop, 0);
          }
          return Response.json({ stopping: true }, { status: 202 });
        }

        // Restart this server from the Console (issue #121): stop with the
        // same farewell a Stop sends, then hand off to Boot for the same
        // Pool, so boot-only Pool settings and a fresh UI build take effect.
        // Allowed in any phase, unlike Stop: a Restart is how a live run
        // picks up a new port or terminal setting, and the operator has
        // already passed the Console's inline confirm to get here. Headless
        // attempts are killed by the shutdown and terminal-backed ones stay
        // in their tabs to be re-adopted, exactly as on any other restart.
        // The 202 names the port the relaunch will listen on, which is the
        // one piece a reconnecting tab cannot work out for itself.
        if (pathname === "/api/restart" && req.method === "POST") {
          const port = relaunchPort(bunServer.port ?? resolution.port);
          if (!stopUnderWay()) {
            stopRequested = true;
            // Off the request's own turn, so the 202 is on the wire before
            // serving stops underneath it.
            setTimeout(() => requestRestart(port), 0);
          }
          return Response.json({ ok: true, port } satisfies RestartResponse, {
            status: 202,
          });
        }

        // The Settings pane's reads and writes (issue #121). The pool's
        // config file stays the source of truth: this is a second way to
        // edit it, never a second copy of it.
        if (pathname === "/api/settings" && req.method === "GET") {
          try {
            return Response.json(settingsPayload(bunServer.port ?? resolution.port));
          } catch (err) {
            // Only a console.json hand-edited into a broken state since boot
            // reaches here: the server parsed it to start at all.
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 500 },
            );
          }
        }

        // A patch, not a replacement: `assign` and any key this server does
        // not know survive the write (pool-settings.ts). The assignment slice
        // of what lands here (defaults, resolver) reaches the run on its own,
        // without a restart: the engine re-reads console.json from disk at
        // every super-step boundary and compares it against the text it last
        // considered (ADR-0018), so nothing between here and there caches the
        // file in a way that could swallow this write. The boot-only keys
        // need the Restart, which is what `bootOnly` in the reply is for.
        if (pathname === "/api/settings/pool" && req.method === "PUT") {
          try {
            const body = (await req.json()) as { config?: unknown };
            const patch = body?.config;
            if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
              throw new Error("settings: config must be an object");
            }
            writePoolSettings(poolDir, patch as Record<string, unknown>, {
              harnesses: Object.keys(harnesses),
            });
            // A pool with nothing in flight reaches no boundary to reload
            // at, so the save asks for the reload itself (issue #149): a
            // changed Spawn cap is on the snapshot before this answers. In
            // flight, the next boundary reads the file as it would anyway.
            currentRun?.reloadConfig();
            // The Pool title (issue #100) is the one setting with no seam to
            // wait for: every open tab shows it from this push, and the
            // push is what hands a changed title to the run.
            reenrich();
            return Response.json(settingsPayload(bunServer.port ?? resolution.port));
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 400 },
            );
          }
        }

        // Reassign (issue #126). The write is an edit of the same console.json
        // the Settings pane edits, so it answers in the settings convention:
        // 400 { error } for a refused request, 500 for a file this server can
        // no longer read. The engine picks the write up at its next Config
        // reload and emits the `reassigned` events itself (ADR-0018); nothing
        // here reaches into the run. The answer carries a freshly enriched
        // snapshot so the cards show the new Assignment without waiting for
        // that boundary, which a quiescent pool would never reach.
        if (pathname === "/api/reassign" && req.method === "PUT") {
          try {
            if (!lastRaw) throw new Error("reassign: pool not started");
            const body = (await req.json()) as Partial<ReassignRequest>;
            if (typeof body !== "object" || body === null || Array.isArray(body)) {
              throw new Error("reassign: body must be an object");
            }
            refreshMeta();
            const context: ReassignContext = {
              markers: meta,
              harnesses,
              liveAttempts: liveAttemptIds(lastRaw),
              statuses: lastRaw.state.tickets,
              engineAssignments: lastRaw.assignments,
            };
            const outcome = writeReassign(
              poolDir,
              { tickets: body.tickets as string[], fields: body.fields ?? {} },
              context,
            );
            const snapshot = reenrich();
            if (!snapshot) throw new Error("reassign: pool not started");
            const answer: ReassignResponse = { ...outcome, snapshot };
            return Response.json(answer);
          } catch (err) {
            // 400 only for a request this server genuinely refused. A file it
            // cannot read or write, and a pool that never started, are its own
            // failures and must not read back as the operator's mistake.
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: err instanceof ReassignRefusal ? 400 : 500 },
            );
          }
        }

        // The Machine defaults are written whole, the way the file itself is
        // (machine-defaults.ts): the pane shows every field, so a field left
        // empty is the operator clearing it. The legacy runner files are
        // never written, only read behind this one.
        if (pathname === "/api/settings/machine" && req.method === "PUT") {
          try {
            const body = (await req.json()) as { defaults?: unknown };
            const defaults = body?.defaults;
            if (
              typeof defaults !== "object" ||
              defaults === null ||
              Array.isArray(defaults)
            ) {
              throw new Error("settings: defaults must be an object");
            }
            writeMachineDefaults(defaults as MachineDefaults, machineDefaultsPaths.file);
            return Response.json(settingsPayload(bunServer.port ?? resolution.port));
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 400 },
            );
          }
        }

        if (pathname === "/api/resume" && req.method === "POST") {
          try {
            const body = (await req.json()) as {
              ticketId?: unknown;
              action?: unknown;
              note?: unknown;
            };
            const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
            const action: ResumeAction = body.action === "approve" || body.action === "reject"
              ? body.action
              : "resume";
            const note = typeof body.note === "string" ? body.note : undefined;
            if (!ticketId) throw new Error("missing ticketId");
            const snapshot = await answer(ticketId, action, note);
            return Response.json({ snapshot }, { status: 202 });
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 400 },
            );
          }
        }

        if (pathname === "/api/events") {
          const ticketId = url.searchParams.get("ticket") ?? "";
          refreshMeta();
          // A Conversation id (issue #60) is accepted here too: its events
          // ride the same `runs/<id>.events.jsonl` file a ticket's do, so
          // readTicketEvents needs nothing Conversation-specific. `spec`
          // comes back "" for a Conversation (meta has no entry for it) —
          // the Detail's Conversation view has its own opening Turn to show
          // and never reads this field the way a ticket's Detail does.
          if (!ticketIds.has(ticketId) && !conversationIds.has(ticketId)) {
            return Response.json({ error: `unknown ticket ${ticketId}` }, { status: 404 });
          }
          return Response.json(readTicketEvents(poolDir, ticketId, meta));
        }

        if (pathname === "/api/grades") {
          refreshMeta();
          return Response.json({ grades: poolGrades() });
        }

        if (pathname === "/api/log") {
          const ticketId = url.searchParams.get("ticket") ?? "";
          refreshMeta();
          // A Conversation id works unchanged here too: startConversation
          // names its log/Stream files `<id>.log` / `<id>.stream.jsonl` —
          // exactly attemptLogName/attemptStreamName's current-attempt
          // name — and records one `spawned` event at attempt 1, so
          // listAttemptLogs derives the same single "implement" row a
          // terminal-backed ticket attempt gets, with the derived
          // (ANSI-stripped) log or the raw Stream file behind `stream=1`.
          if (!ticketIds.has(ticketId) && !conversationIds.has(ticketId)) {
            return Response.json({ error: `unknown ticket ${ticketId}` }, { status: 404 });
          }
          const runsDir = join(poolDir, "runs");
          const attempts = listAttemptLogs(runsDir, ticketId);
          const rawAttempt = url.searchParams.get("attempt");
          const rawOffset = url.searchParams.get("offset");
          const rawEnd = url.searchParams.get("end");
          // The offset is a byte offset into the raw log; the client pages by
          // continuing from the returned nextOffset. Default to the current
          // (latest) attempt and offset 0. The optional end bounds the range
          // for the log pane's "load earlier" prefix reads. The optional
          // stream flag serves the attempt's Stream file (the raw stream tee)
          // through the same byte-range path instead of its derived log.
          const wantsStream = url.searchParams.get("stream") === "1";
          const attempt =
            rawAttempt !== null && rawAttempt !== ""
              ? Number(rawAttempt)
              : (attempts[attempts.length - 1]?.attempt ?? 0);
          const offset = rawOffset !== null && rawOffset !== "" ? Number(rawOffset) : 0;
          const end = rawEnd !== null && rawEnd !== "" ? Number(rawEnd) : undefined;
          const info = attempts.find((row) => row.attempt === attempt);
          const file = wantsStream ? (info?.streamFile ?? null) : (info?.logFile ?? null);
          if (!file) {
            return Response.json(
              {
                error: info
                  ? `no stream file for attempt ${attempt} of ${ticketId}`
                  : `unknown attempt ${attempt} for ${ticketId}`,
              },
              { status: 404 },
            );
          }
          const range = await readLogRange(join(runsDir, file), offset, end);
          return Response.json({ ...range, attempts });
        }

        // Conversations (issue #60): start, end. The Console's client
        // reads a 409's failure reason off a `reason` field (ui/src/client.ts
        // `startConversation`), not `error` — the shape every other route in
        // this file uses — so these routes reply with `reason` to
        // match the shipped UI rather than this file's own convention.
        if (pathname === "/api/conversations" && req.method === "POST") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ reason: "invalid JSON body" }, { status: 400 });
          }
          const fields = (body ?? {}) as Record<string, unknown>;
          // A Steward (ADR-0030) is a Conversation in a role: its opening is
          // the operator's standing orders, and its title may be left blank.
          if (fields.role !== undefined && fields.role !== "steward") {
            return Response.json({ reason: 'role must be "steward" when given' }, { status: 400 });
          }
          const role = fields.role === "steward" ? ("steward" as const) : undefined;
          const title =
            (typeof fields.title === "string" ? fields.title : "").trim() ||
            (role === "steward" ? "Steward" : "");
          if (!title) {
            return Response.json({ reason: "title is required" }, { status: 400 });
          }
          const opening = typeof fields.opening === "string" ? fields.opening : undefined;
          const rawAssign =
            fields.assign && typeof fields.assign === "object"
              ? (fields.assign as Record<string, unknown>)
              : undefined;
          const stringField = (value: unknown): string | undefined =>
            typeof value === "string" ? value : undefined;
          const assign = rawAssign
            ? {
                harness: stringField(rawAssign.harness),
                model: stringField(rawAssign.model),
                effort: stringField(rawAssign.effort),
                drivers: stringField(rawAssign.drivers),
              }
            : undefined;
          try {
            const conversation = await startConversation({
              title,
              opening,
              assign,
              ...(role ? { role } : {}),
            });
            return Response.json({ conversation }, { status: 201 });
          } catch (err) {
            // Every refusal the engine's startConversation throws (not
            // terminal-backed, no git checkout, unknown harness, no
            // harness/model resolved, the herdr tab failing to open) reads
            // as a 409: the request was well-formed, the pool just cannot
            // host a Conversation right now.
            return Response.json(
              { reason: err instanceof Error ? err.message : String(err) },
              { status: 409 },
            );
          }
        }

        // Enlist a live herdr pane as a Ticket or a Conversation (issue #101).
        // The body is the one wire shape engine/enlist.ts declares; `becomes`
        // is fixed at enlist time and chooses the arm. A well-formed request
        // the pool refuses (pane gone, already in the pool, branch creation
        // failing, teaching undeliverable) is the Conversation start route's
        // 409 `reason` envelope, so the Console's form surfaces it inline.
        if (pathname === "/api/enlist" && req.method === "POST") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ reason: "invalid JSON body" }, { status: 400 });
          }
          const fields = (body ?? {}) as Record<string, unknown>;
          const paneId = typeof fields.paneId === "string" ? fields.paneId : "";
          if (!paneId) {
            return Response.json({ reason: "paneId is required" }, { status: 400 });
          }
          const title = typeof fields.title === "string" ? fields.title : "";
          // `becomes` is fixed at enlist time and the wire type is a two
          // member union, so an absent or misspelled value is refused rather
          // than defaulted to a Ticket: enlisting is not undoable, and
          // silently picking the kind that has an end is the wrong guess to
          // make on the operator's behalf.
          if (
            fields.becomes !== "ticket" &&
            fields.becomes !== "conversation" &&
            fields.becomes !== "steward"
          ) {
            return Response.json(
              { reason: 'becomes must be "ticket", "conversation" or "steward"' },
              { status: 400 },
            );
          }
          try {
            if (fields.becomes === "conversation" || fields.becomes === "steward") {
              const opening =
                typeof fields.opening === "string" ? fields.opening : undefined;
              const answer = await enlist({
                becomes: fields.becomes,
                paneId,
                title,
                ...(opening !== undefined ? { opening } : {}),
              });
              return Response.json(answer, { status: 201 });
            }
            const spec = typeof fields.spec === "string" ? fields.spec : "";
            const blocks = Array.isArray(fields.blocks)
              ? fields.blocks.filter((id): id is string => typeof id === "string")
              : undefined;
            const answer = await enlist({
              becomes: "ticket",
              paneId,
              title,
              spec,
              ...(blocks !== undefined ? { blocks } : {}),
            });
            return Response.json(answer, { status: 201 });
          } catch (err) {
            return Response.json(
              { reason: err instanceof Error ? err.message : String(err) },
              { status: 409 },
            );
          }
        }

        // Keep talking (issue #139): continue a ticket's checkpointed Attempt
        // in its Held pane. Not a resume action, because it is never queued
        // (ADR-0004's exception, as Enlist is), so it answers once the pane is
        // claimed: 202 with the Continued attempt's number, or the enlist
        // route's 409 `reason` envelope when the engine refuses (no Held pane,
        // not at a checkpoint, an answer already queued, the pane gone).
        if (pathname === "/api/keep-talking" && req.method === "POST") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ reason: "invalid JSON body" }, { status: 400 });
          }
          const fields = (body ?? {}) as Record<string, unknown>;
          const ticketId = typeof fields.ticketId === "string" ? fields.ticketId : "";
          if (!ticketId) {
            return Response.json({ reason: "ticketId is required" }, { status: 400 });
          }
          try {
            const answer = await keepTalking(ticketId);
            return Response.json(answer, { status: 202 });
          } catch (err) {
            return Response.json(
              { reason: err instanceof Error ? err.message : String(err) },
              { status: 409 },
            );
          }
        }

        // Close every Finished terminal (issue #139): the pool header's bulk
        // close, behind the Console's inline confirm. The engine works out
        // the set afresh and closes it; nothing else ever closes one.
        if (pathname === "/api/terminals/close-finished" && req.method === "POST") {
          const run = currentRun;
          if (!run) {
            return Response.json({ reason: "pool not started" }, { status: 409 });
          }
          try {
            const closed = await run.closeFinishedTerminals();
            return Response.json({ closed } satisfies CloseFinishedTerminalsResponse);
          } catch (err) {
            return Response.json(
              { reason: err instanceof Error ? err.message : String(err) },
              { status: 409 },
            );
          }
        }

        // Adopt or Discard a Held spawn (issue #149, ADR-0029): the
        // proposals a Spawn cap had no room for wait on the snapshot for the
        // operator. Adopt answers 202 once queued, past both caps (the
        // snapshot shows the ticket once the boundary, or at once an idle
        // engine, writes it); Discard answers once the spawn is gone. A
        // refusal is the keep-talking route's 409 `reason` envelope.
        if (
          (pathname === "/api/spawns/held/adopt" || pathname === "/api/spawns/held/discard") &&
          req.method === "POST"
        ) {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ reason: "invalid JSON body" }, { status: 400 });
          }
          const fields = (body ?? {}) as Record<string, unknown>;
          const id = typeof fields.id === "string" ? fields.id : "";
          if (!id) {
            return Response.json({ reason: "id is required" }, { status: 400 });
          }
          const run = currentRun;
          if (!run) {
            return Response.json({ reason: "pool not started" }, { status: 409 });
          }
          const adopt = pathname === "/api/spawns/held/adopt";
          try {
            if (adopt) run.adoptHeldSpawn(id);
            else run.discardHeldSpawn(id);
            return Response.json({ id } satisfies HeldSpawnResponse, {
              status: adopt ? 202 : 200,
            });
          } catch (err) {
            return Response.json(
              { reason: err instanceof Error ? err.message : String(err) },
              { status: 409 },
            );
          }
        }

        if (
          (pathname === "/api/spawns/pending/hold" ||
            pathname === "/api/spawns/pending/discard") &&
          req.method === "POST"
        ) {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ reason: "invalid JSON body" }, { status: 400 });
          }
          const fields = (body ?? {}) as Record<string, unknown>;
          const id = typeof fields.id === "string" ? fields.id : "";
          if (!id) {
            return Response.json({ reason: "id is required" }, { status: 400 });
          }
          const run = currentRun;
          if (!run) {
            return Response.json({ reason: "pool not started" }, { status: 409 });
          }
          try {
            if (pathname === "/api/spawns/pending/hold") run.holdPendingSpawn(id);
            else run.discardPendingSpawn(id);
            return Response.json({ id } satisfies PendingSpawnResponse);
          } catch (err) {
            return Response.json(
              { reason: err instanceof Error ? err.message : String(err) },
              { status: 409 },
            );
          }
        }

        // The Steward's command (ADR-0030, steward-cli.ts): its answers,
        // Keep talks, leaves, Held spawn decisions, Reassigns, state read
        // and its own End, each naming its Conversation id, which the engine
        // checks against the live Steward to attribute the action and
        // enforce the budget. Not a security boundary: this API has no
        // authentication. A refusal is the 409 `reason` envelope.
        if (pathname.startsWith("/api/steward/")) {
          const run = currentRun;
          if (!run) {
            return Response.json({ reason: "pool not started" }, { status: 409 });
          }
          const done = (message: string, status = 200): Response =>
            Response.json({ ok: true, message } satisfies StewardActionResponse, { status });
          const refused = (err: unknown, status = 409): Response =>
            Response.json(
              { reason: err instanceof Error ? err.message : String(err) },
              { status },
            );
          if (pathname === "/api/steward/state" && req.method === "GET") {
            const conversation = url.searchParams.get("conversation") ?? "";
            try {
              return Response.json(run.steward.state(conversation) satisfies StewardStateResponse);
            } catch (err) {
              return refused(err);
            }
          }
          if (req.method !== "POST") {
            return Response.json({ reason: `no steward route ${pathname}` }, { status: 404 });
          }
          let body: Record<string, unknown>;
          try {
            body = ((await req.json()) ?? {}) as Record<string, unknown>;
          } catch {
            return Response.json({ reason: "invalid JSON body" }, { status: 400 });
          }
          const text = (key: string): string =>
            typeof body[key] === "string" ? (body[key] as string) : "";
          const conversation = text("conversation");
          if (!conversation) {
            return Response.json({ reason: "conversation is required" }, { status: 400 });
          }
          const ticketId = text("ticketId");
          try {
            switch (pathname) {
              case "/api/steward/answer": {
                const action = text("action") as StewardAnswerRequest["action"];
                if (!ticketId || !["resume", "approve", "reject"].includes(action)) {
                  return Response.json(
                    { reason: "ticketId and an action of resume, approve or reject are required" },
                    { status: 400 },
                  );
                }
                const note = typeof body.note === "string" ? body.note : undefined;
                run.steward.answer(conversation, ticketId, action, note);
                return done(`answered ${ticketId}: ${action}`, 202);
              }
              case "/api/steward/keep-talking": {
                if (!ticketId || !text("message").trim()) {
                  return Response.json(
                    { reason: "ticketId and message are required" },
                    { status: 400 },
                  );
                }
                const { attempt } = await run.steward.keepTalking(conversation, ticketId, text("message"));
                return done(`keep talking on ${ticketId}: attempt ${attempt} continues in its pane`, 202);
              }
              case "/api/steward/leave": {
                if (!ticketId || !text("note").trim()) {
                  return Response.json({ reason: "ticketId and note are required" }, { status: 400 });
                }
                run.steward.leave(conversation, ticketId, text("note"));
                return done(`left ${ticketId} to the operator with your note`);
              }
              case "/api/steward/held": {
                const action = text("action") as StewardHeldRequest["action"];
                const id = text("id");
                if (!id || (action !== "adopt" && action !== "discard")) {
                  return Response.json(
                    { reason: "id and an action of adopt or discard are required" },
                    { status: 400 },
                  );
                }
                if (action === "adopt") run.steward.adoptHeldSpawn(conversation, id);
                else run.steward.discardHeldSpawn(conversation, id);
                return done(`${action === "adopt" ? "adopted" : "discarded"} held spawn ${id}`);
              }
              case "/api/steward/reassign": {
                run.steward.check(conversation);
                if (!lastRaw) throw new Error("reassign: pool not started");
                const tickets = Array.isArray(body.tickets) ? (body.tickets as string[]) : [];
                const fields =
                  typeof body.fields === "object" && body.fields !== null && !Array.isArray(body.fields)
                    ? (body.fields as Record<string, unknown>)
                    : {};
                refreshMeta();
                writeReassign(
                  poolDir,
                  { tickets, fields },
                  {
                    markers: meta,
                    harnesses,
                    liveAttempts: liveAttemptIds(lastRaw),
                    statuses: lastRaw.state.tickets,
                    engineAssignments: lastRaw.assignments,
                  },
                );
                run.steward.reassigned(conversation, tickets, fields);
                reenrich();
                return done(`reassigned ${tickets.join(", ")}; resume to run on it`);
              }
              case "/api/steward/end": {
                run.steward.check(conversation);
                const closing = typeof body.closing === "string" ? body.closing : undefined;
                // Off the request's own turn: the End closes the Steward's
                // tab, and the command asking for it runs inside that tab, so
                // the answer goes out first.
                setTimeout(() => {
                  void run.steward.end(conversation, closing).catch((err) => {
                    console.error(
                      `steward end: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  });
                }, 0);
                return done("ending: your tab closes now", 202);
              }
              default:
                return Response.json({ reason: `no steward route ${pathname}` }, { status: 404 });
            }
          } catch (err) {
            // A refusal of the Steward's (the engine's own reasons, a refused
            // Reassign) is a 409; a file this server cannot read is its own
            // failure, as on the Reassign route.
            return refused(err, err instanceof ConfigUnreadableError ? 500 : 409);
          }
        }

        if (pathname === "/api/conversations/end" && req.method === "POST") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ reason: "invalid JSON body" }, { status: 400 });
          }
          const fields = (body ?? {}) as Record<string, unknown>;
          const id = typeof fields.id === "string" ? fields.id : "";
          if (!id) {
            return Response.json({ reason: "id is required" }, { status: 400 });
          }
          const closing = typeof fields.closing === "string" ? fields.closing : undefined;
          try {
            await endConversation(id, closing);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // The engine's endConversation throws this exact prefix for both
            // an id it has never heard of and one that already ended: either
            // way there is no live Conversation to end, which is what a 404
            // means everywhere else in this file (an unknown ticket id).
            // Anything else (a merge-chain failure the engine already logs
            // and recovers from) is a 409, not a client error.
            const status = message.includes("no live conversation") ? 404 : 409;
            return Response.json({ reason: message }, { status });
          }
          refreshMeta();
          return Response.json({ snapshot: current() }, { status: 202 });
        }

        if (pathname === "/api/activity") {
          const ticketId = url.searchParams.get("ticket") ?? "";
          // The ids as of the engine's last emit: a ticket the engine wrote
          // a moment ago is known once its snapshot is (current() refreshes
          // the meta behind ticketIds when one is waiting).
          current();
          if (!ticketIds.has(ticketId)) {
            return Response.json({ error: `unknown ticket ${ticketId}` }, { status: 404 });
          }
          return Response.json(await readTicketActivityCached(ticketId));
        }

        // The card's Peek: the pane's viewport as plain text (ANSI stripped
        // herdr-side). A pane an operator sits in is read once per tick and
        // for one purpose (issue #122): when the engine's own loop watches
        // the pane (an enlisted Ticket's, a Conversation's) the answer is
        // that loop's last recorded read and herdr is not asked again. A
        // spawned terminal-backed attempt has no loop, so it is read live,
        // and of the viewport only: a scrollback read moves the operator's
        // viewport, which is the bug this route used to cause twice over.
        // An empty read (a background tab still warming up) is empty text,
        // not an error; a daemon failure is a clean 502 the card renders as
        // "pane unavailable". Nothing here reads pane.read's revision: it is
        // verified stagnant, so freshness is the card re-polling and
        // comparing text.
        if (pathname === "/api/terminal/peek") {
          const ticketId = url.searchParams.get("ticket") ?? "";
          const resolved = resolveTerminalRequest(ticketId);
          if (!resolved.ok) {
            return Response.json(
              { error: resolved.error },
              { status: resolved.status },
            );
          }
          try {
            const recorded = currentRun?.paneRead(resolved.paneId) ?? null;
            const text =
              recorded?.text ??
              (await peekPane(herdrSocket, resolved.paneId, { source: "visible" }));
            const body: TerminalPeekResponse = {
              ticket: ticketId,
              paneId: resolved.paneId,
              text,
            };
            return Response.json(body);
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 502 },
            );
          }
        }

        // "Open in herdr": focus the attempt's pane, jumping the operator's
        // herdr TUI to the attempt's tab. Same translation and registration
        // guard as peek; a mutating call, so POST only.
        if (pathname === "/api/terminal/focus" && req.method === "POST") {
          const ticketId = url.searchParams.get("ticket") ?? "";
          const resolved = resolveTerminalRequest(ticketId);
          if (!resolved.ok) {
            return Response.json(
              { error: resolved.error },
              { status: resolved.status },
            );
          }
          try {
            await focusPane(herdrSocket, resolved.paneId);
            return Response.json({ ok: true, paneId: resolved.paneId });
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 502 },
            );
          }
        }

        // Enlist discovery (issue #101): the live herdr panes, read over the
        // socket on request and never through the snapshot (pane lists are
        // ephemeral). Only a terminal-backed pool has panes to offer, so a
        // headless one refuses with the same `reason` envelope the
        // Conversation routes use; the Console hides the button anyway.
        // Eligibility is the engine's judgement (engine/enlist.ts); the
        // registered pane ids are the engine's own record, read from the last
        // snapshot: a ticket's Live attempt pane and a live Conversation's.
        if (pathname === "/api/panes") {
          if (readConfig(poolDir).terminal !== "herdr") {
            return Response.json(
              {
                reason:
                  "enlist requires a terminal-backed pool " +
                  '(set console.json "terminal": "herdr")',
              },
              { status: 409 },
            );
          }
          const registeredPanes = new Set<string>();
          for (const ticket of current()?.state.tickets ?? []) {
            const paneId = ticket.liveAttempt?.paneId ?? ticket.heldPane?.paneId;
            if (paneId) registeredPanes.add(paneId);
          }
          for (const conversation of current()?.state.conversations ?? []) {
            if (conversation.paneId) registeredPanes.add(conversation.paneId);
          }
          try {
            const panes = await listEnlistPanes({
              socketPath: herdrSocket,
              poolDir,
              registeredPanes,
            });
            return Response.json(panes);
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 502 },
            );
          }
        }

        if (pathname === "/api/ticket") {
          const ticketId = url.searchParams.get("id") ?? "";
          const ticket = readTicketBody(poolDir, ticketId);
          if (!ticket) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          return Response.json(ticket);
        }

        if (pathname === "/api/stream") {
          // The stream is silent whenever the pool waits at an interrupt, so
          // it opts out of the default idle timeout; every other route keeps
          // it. Heartbeat comment frames still flow on their own cadence (the
          // client's liveness signal, and what keeps proxy idle timeouts from
          // firing), but a quiet pool emits no snapshot, and the opt-out keeps
          // the wait from being cut short.
          bunServer.timeout(req, 0);
          let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
          let heartbeat: ReturnType<typeof setInterval> | null = null;
          const stopHeartbeat = (): void => {
            if (heartbeat !== null) {
              clearInterval(heartbeat);
              heartbeat = null;
            }
          };
          const stream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              controller = ctrl;
              ctrl.enqueue(encodeStreamConfig(streamHeartbeatMs));
              clients.set(ctrl, { stopHeartbeat, sent: null });
              sendTo(ctrl);
              heartbeat = setInterval(() => {
                try {
                  ctrl.enqueue(HEARTBEAT_FRAME);
                } catch {
                  // A dead connection's enqueue throws; drop the client.
                  stopHeartbeat();
                  clients.delete(ctrl);
                }
              }, streamHeartbeatMs);
            },
            cancel() {
              stopHeartbeat();
              if (controller) clients.delete(controller);
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }

        const staticRes = serveStatic(distDir, pathname);
        if (staticRes) return staticRes;
        return new Response("not found", { status: 404 });
      },
      }),
      registryPath,
    );
  } catch (err) {
    // The lock was claimed before the bind; a bind that never happened must
    // not leave our own live-looking pid behind, or the next launch refuses
    // itself. Only our pid is removed: a lock another live server holds must
    // survive this launch's failure.
    if (readLockedPid(poolDir) === process.pid) {
      rmSync(join(poolDir, "runs", "server.pid"), { force: true });
    }
    throw err;
  }

  // The bind succeeded, so the pool is live and advertises itself. Boot order
  // is lock -> bind -> register: the registry never names a port that did not
  // actually get bound. Registration is best-effort: a registry write that
  // fails must not take down a console that already bound successfully.
  const boundPort = server.port;
  if (boundPort !== undefined) {
    try {
      upsertFleetEntry(registryPath, {
        poolDir,
        port: boundPort,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(
        `fleet registry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    get latest() {
      return current();
    },
    start,
    answer,
    settled,
    startConversation,
    endConversation,
    enlist,
    keepTalking,
    url: `http://localhost:${server.port}`,
    close: async () => {
      if (sendTimer !== null) clearTimeout(sendTimer);
      sendTimer = null;
      await server.stop(true);
      currentRun?.close();
    },
    shutdown,
  };
}

function runServerCli(): void {
  const args = process.argv.slice(2);
  const poolIndex = args.indexOf("--pool");
  const portIndex = args.indexOf("--port");
  const registryIndex = args.indexOf("--registry");
  const poolDir = poolIndex >= 0 ? args[poolIndex + 1] : undefined;
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;
  const registryPath =
    registryIndex >= 0 && args[registryIndex + 1]
      ? args[registryIndex + 1]
      : undefined;
  if (!poolDir) {
    console.error(
      "usage: bun run engine/server.ts --pool <dir> [--port <n>] [--registry <file>]",
    );
    process.exit(1);
  }
  // The one read of HERDR_WORKSPACE_ID in the engine (issue #94): the
  // workspace herdr exports into the shell the Console was launched from, so
  // a pool started inside herdr opens its tabs where the operator already
  // is. It travels on as an option, and nothing below this boundary ever
  // consults the environment for it.
  const herdrWorkspace = process.env.HERDR_WORKSPACE_ID || undefined;
  // The one read of TYPESAFE_API_KEY (ADR-0020): the key becomes a Jev port
  // here and travels on as an option; absent, the port is unconfigured and
  // the pool runs on its heuristics. Nothing below this boundary reads it,
  // and the SDK is never given the chance to (jev.ts).
  const jev = createJev({ apiKey: process.env.TYPESAFE_API_KEY || undefined });
  let server: PoolServer;
  const stopAndExit = shutdownThenExit(() => server);
  try {
    server = createPoolServer({
      poolDir,
      ...(port !== undefined ? { port } : {}),
      ...(registryPath !== undefined ? { registryPath } : {}),
      ...(herdrWorkspace !== undefined ? { herdrWorkspace } : {}),
      jev,
      onStopRequested: () => stopAndExit("stop requested from the Console"),
      onRestartRequested: (relaunchPort) => {
        console.log("restart requested from the Console: handing off to Boot");
        stopAndExit("restart requested from the Console", () =>
          handOffToBoot(poolDir, relaunchPort),
        );
      },
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  void server.start().then(() => {
    console.log(`pool server on ${server.url} (${poolDir})`);
  });
  // Wrapped rather than passed straight through: a signal handler is called
  // with (signal, code), and the second argument must not arrive as this
  // stop's after-stop hook.
  installShutdownHandlers((reason) => stopAndExit(reason));
}

/**
 * The Restart's second half (issue #121): start Boot for the same Pool and
 * let this process go. Boot waits for the pool lock and the port to come
 * free on its own, so nothing here has to sequence against the shutdown that
 * just finished. Detached with its output appended to the pool's boot log,
 * because the terminal this server was launched from is about to get its
 * prompt back and the relaunch has to outlive it.
 *
 * The port is the one the route already promised the tab, and it is passed
 * on as a pin even when nothing in console.json pinned it: the tab watches
 * that exact port for the Console coming back, so Boot binding a different
 * one leaves it waiting on a server that will never answer. The cost is that
 * a port stolen in the gap fails the relaunch loudly in the boot log rather
 * than being hunted around, which is ADR-0001's own bargain for a pinned
 * port and a narrow window besides: this process released it a moment ago.
 */
function handOffToBoot(poolDir: string, port: number): void {
  const runsDir = join(poolDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const bootLog = openSync(join(runsDir, "boot.log"), "a");
  const child = Bun.spawn(
    [
      "bun",
      "run",
      join(import.meta.dir, "boot-cli.ts"),
      "--pool",
      poolDir,
      "--yes",
      "--relaunch",
      // Port 0 is "any free port", never a pin, so it is never passed on.
      ...(port > 0 ? ["--port", String(port)] : []),
    ],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: bootLog,
      stderr: bootLog,
      stdin: "ignore",
      detached: true,
    },
  );
  child.unref();
}

/**
 * The CLI's one way out (ADR-0017): stop the attempts, release the pool,
 * exit. A signal, a Console stop (issue #97) and a Console restart (issue
 * #121) all take it, and a second arrival during the stop is ignored rather
 * than cutting the stop short. A stop that hangs past its bound exits
 * anyway, so the operator is never left with a server that will not die.
 * `afterStop` is the Restart's handover to Boot, run once the stop has
 * finished and immediately before the exit.
 */
function shutdownThenExit(
  server: () => PoolServer,
): (reason: string, afterStop?: () => void) => void {
  let stopping = false;
  return (reason, afterStop) => {
    if (stopping) return;
    stopping = true;
    console.log(`${reason}: stopping attempts, then exiting`);
    const bound = setTimeout(() => process.exit(1), SHUTDOWN_HARD_LIMIT_MS);
    void server().shutdown().then(
      () => {
        // A Restart's handover, run only on the orderly path: a stop that
        // hangs past its bound exits without relaunching rather than leaving
        // two Consoles racing for one pool, and the operator boots again.
        afterStop?.();
        process.exit(0);
      },
      (err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      },
    );
    bound.unref();
  };
}

/**
 * Trap SIGTERM and SIGINT: an untrapped kill left every headless harness
 * running under init, and the relaunch raced them in their own worktrees
 * (issue #65).
 */
function installShutdownHandlers(stopAndExit: (reason: string) => void): void {
  process.on("SIGTERM", stopAndExit);
  process.on("SIGINT", stopAndExit);
}

// Well past the children's TERM grace plus the drive's settle wait: a stop
// that has not finished by then is stuck on something the exit will free.
const SHUTDOWN_HARD_LIMIT_MS = 15_000;

if (import.meta.main) {
  runServerCli();
}
