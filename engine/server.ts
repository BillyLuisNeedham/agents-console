/**
 * The pool server: one Bun process per pool. It drives the pool engine and
 * serves the built SPA, a small JSON API (get state, start, resume-with-
 * answer), and an SSE stream that pushes a full state snapshot on every
 * change. The UI renders from those snapshots only.
 *
 * The engine's snapshot carries `state.tickets` as an id -> status map; the
 * server enriches it into an array of {id, title, blockedBy, status} so the
 * projection can draw blocked-by edges and show titles. The metadata (title,
 * spec, blockedBy) is the engine's own marker parsing, loaded once at start.
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
  startPool,
  type HarnessCommand,
  type InterruptKind,
  type PoolRun,
  type PoolSnapshot,
  type RunPhase,
} from "./engine.ts";
import {
  attemptLogName,
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
import { DEFAULT_PORT, resolvePort, type PortResolution } from "./ports.ts";
import type { QueuedAnswer } from "./queued-answers.ts";
import { defaultHarnesses } from "./spawn.ts";

export interface PoolServerOptions {
  poolDir: string;
  /** The --port CLI flag; a pin when present. Absent falls to console.json then the default. */
  port?: number;
  /** Where the unpinned hunt starts when neither flag nor console.json pins a port. Defaults to 8787. */
  defaultPort?: number;
  harnesses?: Record<string, HarnessCommand>;
  distDir?: string;
  registryPath?: string;
}

interface EnrichedTicketState {
  id: string;
  title: string;
  blockedBy: string[];
  status: TicketStatus;
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

/** Enrich an engine snapshot with the pool's ticket metadata for the UI. */
function enrich(snapshot: PoolSnapshot, meta: TicketMarker[], poolName: string): EnrichedSnapshot {
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
      })),
      log: snapshot.state.log,
      outcomes: snapshot.state.outcomes,
      interrupts: snapshot.state.interrupts,
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
  current: boolean;
}

interface TicketLogResponse {
  content: string;
  offset: number;
  nextOffset: number;
  totalSize: number;
  attempts: LogAttemptInfo[];
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
 * events module's contract). A verify fan-out's attempts write
 * attempt-numbered logs directly and the well-known name never appears, so
 * the current attempt falls back to its own number. A pre-feature ticket (no
 * events file) uses the reconstructed attempt rows, each with the log file it
 * was built from.
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
      });
    }
    return [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt);
  }
  const reconstructed = reconstructAttempts(runsDir, ticketId);
  return reconstructed.map((row, index) => ({
    attempt: row.attempt,
    kind: "reconstructed" as const,
    logFile: row.logFile,
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
// directory: an arbitrary id can never walk out of it.
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
  const meta = loadMeta(poolDir);
  const ticketIds = knownTicketIds(meta);
  const poolName = poolDir.split("/").slice(-2).join("/");

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
      onSnapshot: (snapshot) => broadcast(enrich(snapshot, meta, poolName)),
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
          return Response.json({ snapshot: latest });
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
          if (!ticketIds.has(ticketId)) {
            return Response.json({ error: `unknown ticket ${ticketId}` }, { status: 404 });
          }
          return Response.json(readTicketEvents(poolDir, ticketId, meta));
        }

        if (pathname === "/api/log") {
          const ticketId = url.searchParams.get("ticket") ?? "";
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
          // for the log pane's "load earlier" prefix reads.
          const attempt =
            rawAttempt !== null && rawAttempt !== ""
              ? Number(rawAttempt)
              : (attempts[attempts.length - 1]?.attempt ?? 0);
          const offset = rawOffset !== null && rawOffset !== "" ? Number(rawOffset) : 0;
          const end = rawEnd !== null && rawEnd !== "" ? Number(rawEnd) : undefined;
          const logFile = attemptLogFile(runsDir, ticketId, attempt);
          if (!logFile) {
            return Response.json(
              { error: `unknown attempt ${attempt} for ${ticketId}` },
              { status: 404 },
            );
          }
          const range = await readLogRange(join(runsDir, logFile), offset, end);
          return Response.json({ ...range, attempts });
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
          // The stream is silent whenever the pool waits at an interrupt, so it
          // opts out of the default idle timeout; every other route keeps it.
          bunServer.timeout(req, 0);
          let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
          const stream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              controller = ctrl;
              clients.add(ctrl);
              if (latest) ctrl.enqueue(encodeSnapshot(latest));
            },
            cancel() {
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
