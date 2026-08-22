/**
 * The pool server: one Bun process per pool. It drives the pool engine and
 * serves the built SPA, a small JSON API (get state, start, resume-with-
 * answer), and an SSE stream that pushes a full state snapshot on every
 * change. The UI renders from those snapshots only.
 *
 * The engine's snapshot carries `state.tickets` as an id -> status map; the
 * server enriches it into an array of {id, title, blockedBy, status} so the
 * projection can draw blocked-by edges and show titles, reading the pool's
 * marker files once at start for the metadata.
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
import { runPool, type HarnessCommand, type PoolSnapshot } from "./engine.ts";
import { readEvents, type TicketEvent } from "./events.ts";
import {
  defaultRegistryPath,
  readFleetEntry,
  readFleetEntryByPort,
  upsertFleetEntry,
} from "./fleet.ts";
import { loadPoolMarkers } from "./pool.ts";
import { DEFAULT_PORT, resolvePort, type PortResolution } from "./ports.ts";
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

export type PoolStatus = "ready" | "in-progress" | "done" | "checkpoint";
export type PoolPhase = "running" | "done" | "quiescent" | "stalled";

export interface EnrichedTicketState {
  id: string;
  title: string;
  blockedBy: string[];
  status: PoolStatus;
}

export interface EnrichedSnapshot {
  seq: number;
  phase: PoolPhase;
  state: {
    tickets: EnrichedTicketState[];
    log: string[];
    outcomes: Record<string, { summary: string; commitSha: string | null }>;
    interrupts: { ticketId: string; kind: string; body: string }[];
    config: Record<string, unknown>;
  };
}

export interface PoolServer {
  latest: EnrichedSnapshot | null;
  start: () => Promise<EnrichedSnapshot>;
  answer: (ticketId: string, action: "resume" | "approve" | "reject", note?: string) => Promise<EnrichedSnapshot>;
  url: string;
  close: () => Promise<void>;
}

interface TicketMeta {
  id: string;
  title: string;
  blockedBy: string[];
  /** The ticket's spec text: everything after the title heading. */
  spec: string;
}

function readTitle(file: string): string {
  const firstHeading = readFileSync(file, "utf8")
    .split("\n")
    .find((line) => line.startsWith("# "));
  if (!firstHeading) return "(untitled)";
  return firstHeading.replace(/^#\s+/, "").trim();
}

/** The issue body after the title heading and its leading blank line. */
function readSpec(file: string): string {
  const lines = readFileSync(file, "utf8").split("\n");
  const headingIndex = lines.findIndex((line) => line.startsWith("# "));
  const body = lines.slice(headingIndex + 1).join("\n").trim();
  return body;
}

function loadMeta(poolDir: string): TicketMeta[] {
  const issuesDir = join(poolDir, "issues");
  const markers = loadPoolMarkers(issuesDir);
  return markers.map((marker) => ({
    id: marker.id,
    title: readTitle(marker.file),
    blockedBy: marker.blockedBy,
    spec: readSpec(marker.file),
  }));
}

/** Enrich an engine snapshot with the pool's ticket metadata for the UI. */
function enrich(snapshot: PoolSnapshot, meta: TicketMeta[]): EnrichedSnapshot {
  return {
    seq: snapshot.seq,
    phase: snapshot.phase,
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

export interface TicketEventsResponse {
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

export interface LogAttemptInfo {
  attempt: number;
  kind: "implement" | "resolver" | "reconstructed";
  logFile: string;
  current: boolean;
}

export interface TicketLogResponse {
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

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/**
 * The ticket's attempts as log sources, in attempt order. Event-based tickets
 * (an events file exists) derive implement/resolver attempts from the events:
 * the latest of each kind holds its well-known path, older attempts their
 * rotated `<id>.attempt-N` name. A pre-feature ticket (no events file) uses
 * the reconstructed attempt rows, each with the log file it was built from.
 */
export function listAttemptLogs(
  runsDir: string,
  ticketId: string,
): LogAttemptInfo[] {
  const events = readEvents(runsDir, ticketId);
  if (events.length > 0) {
    const spawned = events.filter((e) => e.kind === "spawned");
    const resolvers = events.filter((e) => e.kind === "resolver");
    const maxSpawned = spawned.reduce((m, e) => Math.max(m, e.attempt), 0);
    const maxResolver = resolvers.reduce((m, e) => Math.max(m, e.attempt), 0);
    const byAttempt = new Map<number, LogAttemptInfo>();
    for (const event of spawned) {
      const current = event.attempt === maxSpawned;
      byAttempt.set(event.attempt, {
        attempt: event.attempt,
        kind: "implement",
        current,
        logFile: current
          ? `${ticketId}.log`
          : `${ticketId}.attempt-${event.attempt}.log`,
      });
    }
    for (const event of resolvers) {
      const current = event.attempt === maxResolver;
      byAttempt.set(event.attempt, {
        attempt: event.attempt,
        kind: "resolver",
        current,
        logFile: current
          ? `${ticketId}.resolver.log`
          : `${ticketId}.attempt-${event.attempt}.resolver.log`,
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
  const decodeEnd = utf8End(bytes, 0, bytes.length);
  return {
    content: stripAnsi(new TextDecoder().decode(bytes.subarray(0, decodeEnd))),
    offset: start,
    nextOffset: start + decodeEnd,
    totalSize,
  };
}

export interface ReconstructedAttempt {
  attempt: number;
  logFile: string;
  modifiedAt: string;
}

// The events endpoint answers for tickets the pool actually owns. Scoping to
// the known ticket ids also keeps the lookup inside the pool's runs
// directory: an arbitrary id can never walk out of it.
function knownTicketIds(meta: TicketMeta[]): Set<string> {
  return new Set(meta.map((m) => m.id));
}

// Attempt logs are `<id>.log`, `<id>.attempt-N.log`, `<id>.resolver.log`, and
// `<id>.attempt-N.resolver.log`, in the pool's runs directory. A ticket with
// no events file (a pre-feature pool) is backfilled one attempt row per
// existing log file, in modification-time order, marked as reconstructed.
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
  const escaped = ticketId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const logName = new RegExp(
    `^${escaped}(?:\\.attempt-\\d+)?(?:\\.resolver)?\\.log$`,
  );
  return files
    .filter((file) => logName.test(file))
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
  meta: TicketMeta[],
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

/** The pool's pinned port from console.json, or undefined when it pins none. */
function readConfigPort(poolDir: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(poolDir, "console.json"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const port = (parsed as Record<string, unknown>).port;
  return port === undefined ? undefined : (port as number);
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

  let latest: EnrichedSnapshot | null = null;
  let currentRun: Awaited<ReturnType<typeof runPool>> | null = null;
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

  async function driveRun(): Promise<EnrichedSnapshot> {
    if (currentRun) currentRun.close();
    const run = await runPool({
      poolDir,
      harnesses,
      onSnapshot: (snapshot) => broadcast(enrich(snapshot, meta)),
    });
    currentRun = run;
    return latest!;
  }

  const start = (): Promise<EnrichedSnapshot> => {
    if (started) return Promise.resolve(latest!);
    started = true;
    return driveRun();
  };

  async function answer(
    ticketId: string,
    action: "resume" | "approve" | "reject",
    note?: string,
  ): Promise<EnrichedSnapshot> {
    const run = currentRun;
    if (!run) throw new Error("pool not started");
    const next =
      action === "approve"
        ? await run.approve(ticketId, note)
        : action === "reject"
          ? await run.reject(ticketId, note)
          : await run.resume(ticketId, note);
    currentRun = next;
    return latest!;
  }

  const resolution = resolvePort(
    options.port,
    readConfigPort(poolDir),
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
            return Response.json({ snapshot });
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
    url: `http://localhost:${server.port}`,
    close: async () => {
      await server.stop(true);
      currentRun?.close();
    },
  };
}

export function runServerCli(): void {
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
