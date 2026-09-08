/**
 * The pool server: one Bun process per pool. It drives the pool engine and
 * serves the built SPA, a small JSON API (get state, start, resume-with-
 * answer, ticket reads, terminal peek/focus), and an SSE stream that pushes
 * a full state snapshot on every change. The UI renders from those
 * snapshots only. The terminal endpoints are the UI's only path to the
 * herdr daemon (ADR-0014): the Console never talks to herdr directly.
 *
 * The engine's snapshot carries `state.tickets` as an id -> status map and
 * `assignments` as the resolved Assignment record per ticket (ADR-0013); the
 * server enriches the former into an array of {id, title, blockedBy, status,
 * assignment, paneId?} so the projection can draw blocked-by edges, show
 * titles, render the record verbatim, and reach a terminal-backed attempt's
 * herdr pane (ADR-0014). The metadata (title, spec, blockedBy) is the
 * engine's own marker parsing, re-read from the pool's issues directory on
 * every snapshot and ticket-scoped request: a
 * ticket file that lands after boot (an engine-written Spawn or grader
 * ticket, or a hand edit) renders as a live card without a restart. The
 * grades endpoint re-derives from the same refreshed meta.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  readConfig,
  REVIEW_TICKET_ID,
  repoRootOf,
  startPool,
  UNASSIGNED_ASSIGNMENT_VIEW,
  type AssignmentView,
  type HarnessCommand,
  type InterruptKind,
  type PoolRun,
  type PoolSnapshot,
  type RunPhase,
} from "./engine.ts";
import {
  attemptLogName,
  attemptStreamName,
  parseAttemptLogName,
  readEvents,
  type TicketEvent,
} from "./events.ts";
import {
  defaultRegistryPath,
  readFleetEntry,
  readFleetEntryByPort,
  upsertFleetEntry,
} from "./fleet.ts";
import {
  loadPoolMarkers,
  MARKER_RE,
  type TicketMarker,
  type TicketStatus,
} from "./pool.ts";
import {
  HERDR_SOCKET_DEFAULT,
  focusPane,
  peekPane,
} from "./herdr.ts";
import { DEFAULT_PORT, resolvePort, type PortResolution } from "./ports.ts";
import type { QueuedAnswer } from "./queued-answers.ts";
import { defaultHarnesses } from "./spawn.ts";
import {
  branchLandedInto,
  branchFor,
  currentBranch,
  git,
  gitAvailable,
} from "./worktrees.ts";

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
  /** The snapshot stream's heartbeat interval in ms; tests shrink it. Defaults to SNAPSHOT_STREAM_HEARTBEAT_MS. */
  streamHeartbeatMs?: number;
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

interface EnrichedTicketState {
  id: string;
  title: string;
  blockedBy: string[];
  status: TicketStatus;
  /** True when the ticket is done but its branch has not landed in the
   *  merge target (ADR-0014): the "done, merge pending" card label. Derived
   *  server-side here; every UI surface reads this field and never git. */
  mergePending: boolean;
  /** The ticket's resolved Assignment record (ADR-0013), served verbatim. */
  assignment: AssignmentView;
  /**
   * The current attempt's herdr pane id (ADR-0014), present only while the
   * latest spawned event records one: terminal-backed attempts carry it,
   * headless pools and headless-fallback attempts have the field absent.
   */
  paneId?: string;
}

interface EnrichedSnapshot {
  seq: number;
  phase: RunPhase;
  /** The pool's display name: the last two path segments of the pool directory. */
  poolName: string;
  state: {
    tickets: EnrichedTicketState[];
    log: string[];
    outcomes: Record<string, { summary: string; commitSha: string | null }>;
    interrupts: { ticketId: string; kind: InterruptKind; body: string }[];
    /** Accepted answers still waiting for processing (the Queued answers). */
    queuedAnswers: QueuedAnswer[];
    config: Record<string, unknown>;
  };
}

export interface PoolServer {
  latest: EnrichedSnapshot | null;
  start: () => Promise<EnrichedSnapshot>;
  answer: (ticketId: string, action: "resume" | "approve" | "reject", note?: string) => Promise<EnrichedSnapshot>;
  /** Resolves once the in-flight drive settles, with the settled snapshot. */
  settled: () => Promise<EnrichedSnapshot>;
  url: string;
  close: () => Promise<void>;
}

/** The pool's ticket metadata, as the engine parses it from the Issue files. */
function loadMeta(poolDir: string): TicketMarker[] {
  return loadPoolMarkers(join(poolDir, "issues"));
}

// The events that close an attempt for good: a resolver run records no exited
// event, so answered and merged close it too. Without them a resolver-driven
// merge would read as live forever.
const SETTLED_EVENT_KINDS = new Set(["exited", "crash", "answered", "merged"]);

/**
 * The current attempt's pane id per ticket, derived from the ticket's own
 * events: a terminal-backed spawn records its recovered pane id on the
 * `spawned` event as `pane_id` (ADR-0014, ADR-0015), and the latest attempt's
 * latest spawned event wins, so a later headless-fallback attempt clears an
 * earlier pane id. Only a live attempt maps to an entry: a settled attempt
 * (SETTLED_EVENT_KINDS), a headless pool (no pane facts recorded), the
 * fallback's `pane_id: null`, and a ticket with no attempt at all all leave
 * the ticket without a paneId, so headless attempts and headless pools expose
 * none — and a finished attempt's paneId leaves the snapshot, which is what
 * stops the card's terminal surface and its polling (the spec's "stops when
 * the attempt ends").
 */
export function currentAttemptPaneIds(
  runsDir: string,
  meta: TicketMarker[],
): Record<string, string> {
  const paneIds: Record<string, string> = {};
  for (const marker of meta) {
    const events = readEvents(runsDir, marker.id);
    const latest = events.reduce((m, e) => Math.max(m, e.attempt), 0);
    if (latest === 0) continue;
    const latestEvents = events.filter((e) => e.attempt === latest);
    if (latestEvents.some((e) => SETTLED_EVENT_KINDS.has(e.kind))) continue;
    const paneId = latestEvents
      .filter((e) => e.kind === "spawned")
      .at(-1)?.payload.pane_id;
    if (typeof paneId === "string" && paneId !== "") {
      paneIds[marker.id] = paneId;
    }
  }
  return paneIds;
}

/**
 * The done-but-unmerged ticket ids (ADR-0014): a ticket the snapshot reports
 * done whose branch has not landed in the merge target, the pool checkout's
 * current branch, main or a feature branch alike. Derived on demand from
 * branch state, never persisted, the way the engine derives the hold itself
 * (ADR-0007's pattern). A git-less pool has no branches, so nothing is ever
 * pending there.
 */
function deriveMergePending(
  poolDir: string,
  statuses: Iterable<readonly [string, TicketStatus]>,
): Set<string> {
  const entries = [...statuses];
  const pending = new Set<string>();
  if (!entries.some(([, status]) => status === "done")) return pending;
  const cwd = repoRootOf(poolDir);
  if (!gitAvailable(cwd)) return pending;
  const target = currentBranch(cwd);
  for (const [id, status] of entries) {
    if (status !== "done") continue;
    if (branchLandedInto(cwd, branchFor(cwd, id), target)) continue;
    pending.add(id);
  }
  return pending;
}

/** Enrich an engine snapshot with the pool's ticket metadata for the UI. */
function enrich(
  snapshot: PoolSnapshot,
  meta: TicketMarker[],
  poolName: string,
  poolDir: string,
  paneIds: Record<string, string>,
): EnrichedSnapshot {
  const pending = deriveMergePending(
    poolDir,
    Object.entries(snapshot.state.tickets),
  );
  return {
    seq: snapshot.seq,
    phase: snapshot.phase,
    poolName,
    state: {
      tickets: meta.map((m) => ({
        id: m.id,
        title: m.title,
        blockedBy: m.blockedBy,
        status: snapshot.state.tickets[m.id] ?? "ready",
        mergePending: pending.has(m.id),
        // A meta id the engine has not resolved yet (a hand-written file
        // seen between the meta refresh and the boundary that adopts it)
        // reads as unassigned until the record lands; the engine's map is
        // the only derivation, and the engine owns the unassigned record.
        assignment: snapshot.assignments[m.id] ?? {
          ...UNASSIGNED_ASSIGNMENT_VIEW,
        },
        ...(paneIds[m.id] !== undefined ? { paneId: paneIds[m.id] } : {}),
      })),
      log: snapshot.state.log,
      outcomes: snapshot.state.outcomes,
      interrupts: snapshot.state.interrupts,
      queuedAnswers: snapshot.queuedAnswers,
      config: snapshot.state.config as unknown as Record<string, unknown>,
    },
  };
}

/**
 * The cached latest was enriched at its emit, but the branch state behind
 * the merge-pending label can move without one: a manual CLI merge while
 * the pool sits quiescent raises no snapshot. The replay surfaces (/api/state
 * and a stream connect) re-derive before serving, so a Console opened after
 * such a merge sees the label gone rather than the last emit's.
 */
function withMergePending(
  snapshot: EnrichedSnapshot,
  poolDir: string,
): EnrichedSnapshot {
  const pending = deriveMergePending(
    poolDir,
    snapshot.state.tickets.map(
      (ticket) => [ticket.id, ticket.status] as const,
    ),
  );
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      tickets: snapshot.state.tickets.map((ticket) => ({
        ...ticket,
        mergePending: pending.has(ticket.id),
      })),
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

interface TicketEventsResponse {
  events: TicketEvent[];
  attempts: ReconstructedAttempt[];
  reconstructed: boolean;
  /** The ticket's spec text: the issue file body after the title heading. */
  spec: string;
}

// ---------------------------------------------------------------------------
// Ticket log endpoint
// ---------------------------------------------------------------------------

/** The largest byte range a single log response serves. Larger logs page. */
export const LOG_CHUNK_BYTES = 64 * 1024;

interface LogAttemptInfo {
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

interface TicketLogResponse {
  content: string;
  offset: number;
  nextOffset: number;
  totalSize: number;
  attempts: LogAttemptInfo[];
}

interface TicketActivityResponse {
  ticketId: string;
  running: boolean;
  diff: { added: number; removed: number; files: string[] } | null;
  log: { size: number; mtime: string } | null;
  lastEventAt: string | null;
}

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

/** Resolve an attempt number to its log file name, or null for an unknown attempt. */
function attemptLogFile(
  runsDir: string,
  ticketId: string,
  attempt: number,
): string | null {
  const found = listAttemptLogs(runsDir, ticketId).find(
    (info) => info.attempt === attempt,
  );
  return found?.logFile ?? null;
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

interface ReconstructedAttempt {
  attempt: number;
  logFile: string;
  modifiedAt: string;
}

// The events endpoint answers for tickets the pool actually owns. Scoping to
// the known ticket ids also keeps the lookup inside the pool's runs
// directory: an arbitrary id can never walk out of it. The set tracks the
// pool's issues directory (refreshed per snapshot and per request), so a
// ticket the engine writes after boot is known the moment it lands.
function knownTicketIds(meta: TicketMarker[]): Set<string> {
  return new Set(meta.map((m) => m.id));
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

function computeActivityDiff(cwd: string): TicketActivityResponse["diff"] {
  try {
    const numstat = git(cwd, ["diff", "--numstat", "HEAD"]);
    const status = git(cwd, ["status", "--porcelain"]);
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
        const stat = statSync(full);
        if (!stat.isFile()) continue;
        if (stat.size >= UNTRACKED_MAX_BYTES) {
          // Over the read cap it still counts as a touched file, just with no
          // line counts.
          record(path, 0, 0);
          continue;
        }
        record(path, countLines(readFileSync(full, "utf8")), 0);
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

function readTicketActivity(
  poolDir: string,
  ticketId: string,
): TicketActivityResponse {
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
  // Live means the ticket's latest attempt is doing work: an implement run in
  // flight, or a resolver run in flight on a checkpointed merge. The latest
  // attempt is the highest attempt number recorded; an attempt only counts
  // once it has actually spawned.
  const latestAttempt = events.reduce((m, e) => Math.max(m, e.attempt), 0);
  const latestAttemptEvents = events.filter((e) => e.attempt === latestAttempt);
  const running =
    latestAttempt > 0 &&
    latestAttemptEvents.some(
      (e) => e.kind === "spawned" || e.kind === "resolver",
    ) &&
    !latestAttemptEvents.some((e) => SETTLED_EVENT_KINDS.has(e.kind));
  const lastEventAt = events.length > 0 ? events[events.length - 1].at : null;
  const diff =
    worktree !== null && existsSync(worktree)
      ? computeActivityDiff(worktree)
      : null;
  const attempts = listAttemptLogs(runsDir, ticketId);
  const current = attempts[attempts.length - 1];
  let log: TicketActivityResponse["log"] = null;
  if (current) {
    try {
      const stat = statSync(join(runsDir, current.logFile));
      log = { size: stat.size, mtime: stat.mtime.toISOString() };
    } catch {
      log = null;
    }
  }
  return { ticketId, running, diff, log, lastEventAt };
}

export const ACTIVITY_CACHE_TTL_MS = 1000;

// ---------------------------------------------------------------------------
// Terminal endpoints (peek and focus)
// ---------------------------------------------------------------------------

/**
 * The card's read-only preview shows this many lines of the pane's recent
 * output. On a terminal-backed attempt the harness fills the pane with a
 * full-screen TUI, and `pane.read source=recent` returns only the last N
 * rendered rows (prototype/tui-prompt-paste/FINDINGS.md section 2, proven):
 * a small line count reads empty on a fresh pane or a footer sliver on a live
 * TUI. This must be at least a terminal height so the peek shows the TUI's
 * working area, while staying a bounded glance rather than a full log.
 */
export const TERMINAL_PEEK_LINES = 80;

/**
 * The ticket-id -> pane-id translation both terminal endpoints key on
 * (ADR-0014): the pane id recorded on the ticket's latest attempt's
 * `spawned` event, but only while that attempt is still live. A settled
 * attempt (finished), a headless fallback spawn (pane_id null on the
 * spawned event), and a ticket with no attempt at all all resolve to null,
 * so the endpoints answer "no pane" rather than reaching a stale or foreign
 * pane.
 */
export function resolveTerminalPane(
  runsDir: string,
  ticketId: string,
): string | null {
  const events = readEvents(runsDir, ticketId);
  const latest = events.reduce((m, e) => Math.max(m, e.attempt), 0);
  if (latest === 0) return null;
  const latestEvents = events.filter((e) => e.attempt === latest);
  if (latestEvents.some((e) => SETTLED_EVENT_KINDS.has(e.kind))) return null;
  const spawned = latestEvents.filter((e) => e.kind === "spawned");
  const paneId = spawned.at(-1)?.payload.pane_id;
  return typeof paneId === "string" && paneId !== "" ? paneId : null;
}

/**
 * Every pane id this pool recorded on a `spawned` event, across its
 * tickets: the allowlist behind the spawned-only guard. Derived from pool
 * state at request time rather than held in memory, so a server restart
 * neither widens it (forgetting a spawn) nor narrows it (protecting a pane
 * that is legitimately gone); the prototype's per-process Set did both.
 */
export function spawnedPaneAllowlist(
  runsDir: string,
  meta: TicketMarker[],
): Set<string> {
  const allowlist = new Set<string>();
  for (const marker of meta) {
    for (const event of readEvents(runsDir, marker.id)) {
      if (event.kind !== "spawned") continue;
      const paneId = event.payload.pane_id;
      if (typeof paneId === "string" && paneId !== "") allowlist.add(paneId);
    }
  }
  return allowlist;
}

/**
 * The spawned-only refusal (the headline guard, user story 12): null when
 * the pane id is one this pool recorded on a spawned event, else the error
 * message the endpoint serves with its 403. Because the endpoints are
 * keyed by ticket id and the translation above only yields pane ids from
 * the pool's own events, normal traffic can never trip this; it exists so
 * a hand-corrupted events file still cannot point the Console at a pane
 * the pool did not spawn.
 */
export function terminalSpawnRefusal(
  allowlist: Set<string>,
  paneId: string,
): string | null {
  return allowlist.has(paneId)
    ? null
    : `refusing: pane ${paneId} is not one this pool spawned`;
}

// ---------------------------------------------------------------------------
// Grades endpoint
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

export interface TicketBodyResponse {
  id: string;
  /** The Issue file's markdown with the line-1 state marker stripped. */
  body: string;
}

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

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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

export function createPoolServer(options: PoolServerOptions): PoolServer {
  const poolDir = resolve(options.poolDir);
  const registryPath = options.registryPath ?? defaultRegistryPath();
  acquirePoolLock(poolDir, registryPath);
  const distDir = options.distDir ?? join(import.meta.dir, "..", "ui", "dist");
  const harnesses = { ...defaultHarnesses, ...options.harnesses };
  const herdrSocket = options.herdrSocket ?? HERDR_SOCKET_DEFAULT;
  const streamHeartbeatMs =
    options.streamHeartbeatMs ?? SNAPSHOT_STREAM_HEARTBEAT_MS;
  let meta = loadMeta(poolDir);
  let ticketIds = knownTicketIds(meta);
  const poolName = poolDir.split("/").slice(-2).join("/");

  // A short in-memory cache per ticket id absorbs the client's rapid repeat
  // polls (ADR 0011): one entry per known ticket id, so it never grows past
  // the pool's size. No mtime-based invalidation in v1.
  const activityCache = new Map<
    string,
    { at: number; value: TicketActivityResponse }
  >();
  function readTicketActivityCached(ticketId: string): TicketActivityResponse {
    const hit = activityCache.get(ticketId);
    const now = Date.now();
    if (hit && now - hit.at < ACTIVITY_CACHE_TTL_MS) return hit.value;
    const value = readTicketActivity(poolDir, ticketId);
    activityCache.set(ticketId, { at: now, value });
    return value;
  }

  // Pool meta is read from disk, never cached from boot: the engine writes
  // ticket files mid-run (Spawn adoptions, grader and head-to-head tickets),
  // and each must render as a card and be accepted by the ticket endpoints
  // the moment it lands. A reload that fails keeps the last-known-good meta
  // and the next snapshot or request retries: a torn write or a draft file
  // without a valid marker must never break snapshot delivery.
  function refreshMeta(): void {
    try {
      meta = loadMeta(poolDir);
      ticketIds = knownTicketIds(meta);
    } catch {
      // Keep the last-known-good meta.
    }
  }

  let latest: EnrichedSnapshot | null = null;
  let currentRun: PoolRun | null = null;
  let started = false;

  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  function broadcast(snapshot: EnrichedSnapshot): void {
    latest = snapshot;
    const bytes = encodeSnapshot(snapshot);
    for (const controller of [...clients]) {
      try {
        controller.enqueue(bytes);
      } catch {
        clients.delete(controller);
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
      onSnapshot: (snapshot) => {
        refreshMeta();
        broadcast(
          enrich(
            snapshot,
            meta,
            poolName,
            poolDir,
            currentAttemptPaneIds(join(poolDir, "runs"), meta),
          ),
        );
      },
    });
    return latest!;
  }

  const start = (): Promise<EnrichedSnapshot> => {
    if (!started) {
      started = true;
      driveRun();
    }
    return Promise.resolve(latest!);
  };

  // Acceptance only (ADR-0004): the engine records the answer synchronously
  // and the caller gets the current snapshot right away; processing happens
  // immediately when the pool is idle and at the next super-step boundary
  // otherwise.
  async function answer(
    ticketId: string,
    action: "resume" | "approve" | "reject",
    note?: string,
  ): Promise<EnrichedSnapshot> {
    const run = currentRun;
    if (!run) throw new Error("pool not started");
    if (action !== "resume") {
      // Only the run's review gate (REVIEW_TICKET_ID) and a ticket's
      // merge-approval take approve/reject; anything else is a malformed
      // request, so fail at the seam instead of the engine silently treating
      // it as a resume.
      const kind = latest?.state.interrupts.find(
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
    return latest!;
  }

  const settled = (): Promise<EnrichedSnapshot> => {
    const run = currentRun;
    if (!run) return Promise.resolve(latest!);
    return run.settled.then(() => latest!);
  };

  // The shared first half of both terminal endpoints: the ticket-id -> pane
  // translation and the spawned-only guard. Unknown tickets take the same
  // "no pane" answer as headless, finished, and never-spawned ones, so the
  // endpoints never reveal which ticket ids exist and every no-pane case is
  // one shape. The 403 guard cannot trip on well-formed pool state (the
  // translation and the allowlist read the same events); it is the
  // belt-and-braces refusal for corrupted state.
  function resolveTerminalRequest(ticketId: string):
    | { ok: true; paneId: string }
    | { ok: false; status: number; error: string } {
    refreshMeta();
    if (!ticketIds.has(ticketId)) {
      return {
        ok: false,
        status: 404,
        error: `no terminal-backed pane for ticket ${ticketId}`,
      };
    }
    const paneId = resolveTerminalPane(join(poolDir, "runs"), ticketId);
    if (paneId === null) {
      return {
        ok: false,
        status: 404,
        error: `no terminal-backed pane for ticket ${ticketId}`,
      };
    }
    const refusal = terminalSpawnRefusal(
      spawnedPaneAllowlist(join(poolDir, "runs"), meta),
      paneId,
    );
    if (refusal !== null) {
      return { ok: false, status: 403, error: refusal };
    }
    return { ok: true, paneId };
  }

  const resolution = resolvePort(
    options.port,
    readConfig(poolDir).port,
    options.defaultPort ?? DEFAULT_PORT,
  );
  let server: Bun.Server<undefined>;
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
          return Response.json({
            snapshot: latest ? withMergePending(latest, poolDir) : null,
          });
        }

        if (pathname === "/api/start" && req.method === "POST") {
          const snapshot = await start();
          return Response.json({ snapshot });
        }

        if (pathname === "/api/resume" && req.method === "POST") {
          try {
            const body = (await req.json()) as {
              ticketId?: unknown;
              action?: unknown;
              note?: unknown;
            };
            const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
            const action = body.action === "approve" || body.action === "reject"
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
          if (!ticketIds.has(ticketId)) {
            return Response.json({ error: `unknown ticket ${ticketId}` }, { status: 404 });
          }
          return Response.json(readTicketEvents(poolDir, ticketId, meta));
        }

        if (pathname === "/api/grades") {
          refreshMeta();
          return Response.json({ grades: readPoolGrades(poolDir, meta) });
        }

        if (pathname === "/api/log") {
          const ticketId = url.searchParams.get("ticket") ?? "";
          refreshMeta();
          if (!ticketIds.has(ticketId)) {
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
          const file = wantsStream
            ? (info?.streamFile ?? null)
            : attemptLogFile(runsDir, ticketId, attempt);
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

        if (pathname === "/api/activity") {
          const ticketId = url.searchParams.get("ticket") ?? "";
          if (!ticketIds.has(ticketId)) {
            return Response.json({ error: `unknown ticket ${ticketId}` }, { status: 404 });
          }
          return Response.json(readTicketActivityCached(ticketId));
        }

        // The card's read-only peek: the attempt pane's recent output as
        // plain text (ANSI stripped herdr-side, a small line count). An
        // empty read (a background tab still warming up) is empty text,
        // not an error; a daemon failure is a clean 502 the card renders
        // as "pane unavailable". Nothing here reads pane.read's revision:
        // it is verified stagnant, so freshness is the card re-polling and
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
            const text = await peekPane(
              herdrSocket,
              resolved.paneId,
              TERMINAL_PEEK_LINES,
            );
            return Response.json({
              ticket: ticketId,
              paneId: resolved.paneId,
              text,
            });
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 502 },
            );
          }
        }

        // "Open in herdr": focus the attempt's pane, jumping the operator's
        // herdr TUI to the attempt's tab. Same translation and spawned-only
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
              clients.add(ctrl);
              ctrl.enqueue(encodeStreamConfig(streamHeartbeatMs));
              if (latest) {
                ctrl.enqueue(encodeSnapshot(withMergePending(latest, poolDir)));
              }
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
      return latest;
    },
    start,
    answer,
    settled,
    url: `http://localhost:${server.port}`,
    close: async () => {
      await server.stop(true);
      currentRun?.close();
    },
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
  let server: PoolServer;
  try {
    server = createPoolServer({
      poolDir,
      ...(port !== undefined ? { port } : {}),
      ...(registryPath !== undefined ? { registryPath } : {}),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  void server.start().then(() => {
    console.log(`pool server on ${server.url} (${poolDir})`);
  });
}

if (import.meta.main) {
  runServerCli();
}
