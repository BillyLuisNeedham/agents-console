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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runPool, type HarnessCommand, type PoolSnapshot } from "./engine.ts";
import { readEvents, type TicketEvent } from "./events.ts";
import { loadPoolMarkers } from "./pool.ts";
import { defaultHarnesses } from "./spawn.ts";

export interface PoolServerOptions {
  poolDir: string;
  port: number;
  harnesses?: Record<string, HarnessCommand>;
  distDir?: string;
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
}

function readTitle(file: string): string {
  const firstHeading = readFileSync(file, "utf8")
    .split("\n")
    .find((line) => line.startsWith("# "));
  if (!firstHeading) return "(untitled)";
  return firstHeading.replace(/^#\s+/, "").trim();
}

function loadMeta(poolDir: string): TicketMeta[] {
  const issuesDir = join(poolDir, "issues");
  const markers = loadPoolMarkers(issuesDir);
  return markers.map((marker) => ({
    id: marker.id,
    title: readTitle(marker.file),
    blockedBy: marker.blockedBy,
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

function readTicketEvents(poolDir: string, ticketId: string): TicketEventsResponse {
  const runsDir = join(poolDir, "runs");
  const events = readEvents(runsDir, ticketId);
  if (events.length > 0) {
    return { events, attempts: [], reconstructed: false };
  }
  return {
    events: [],
    attempts: reconstructAttempts(runsDir, ticketId),
    reconstructed: true,
  };
}

export function createPoolServer(options: PoolServerOptions): PoolServer {
  const poolDir = options.poolDir;
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

  const server = Bun.serve({
    port: options.port,
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
        return Response.json(readTicketEvents(poolDir, ticketId));
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
  });

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
  const poolDir = poolIndex >= 0 ? args[poolIndex + 1] : undefined;
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8787;
  if (!poolDir) {
    console.error("usage: bun run engine/server.ts --pool <dir> [--port <n>]");
    process.exit(1);
  }
  const server = createPoolServer({ poolDir, port });
  void server.start().then(() => {
    console.log(`pool server on ${server.url} (${poolDir})`);
  });
}

if (import.meta.main) {
  runServerCli();
}
