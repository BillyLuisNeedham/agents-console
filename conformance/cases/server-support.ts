/**
 * What the `server` cases outside the route files share (the inventory's
 * ticket C03): server processes a case launches by hand on a world's pool,
 * the processes and ports they are tried against, the fleet registry under
 * the world's isolated HOME, and the phase of every snapshot frame a socket
 * saw. Everything here works from outside the server, as the cases do.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../engine/wire.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { applySnapshotDelta } from "../fixtures/socket-protocol.ts";
import { conformance, type Case, type CaseOptions, type CaseServer } from "../harness/case.ts";
import { anyIsoTime } from "../harness/equal.ts";
import { until } from "../harness/pool-files.ts";
import { freePort, launchServer, type LaunchedServer } from "../harness/server.ts";
import type { TicketSeed, World } from "../harness/world.ts";

/** The pool's defaults: every launch is the claude stub. */
export const CONFIG: PoolConfig = { defaults: { harness: "claude", model: "m" } };

/** engine/ports.ts DEFAULT_PORT: where the unpinned hunt starts. */
export const DEFAULT_PORT = 8787;

/** A Ticket file `<id>-t.md`, ready unless told otherwise. */
export function ticket(id: string, options: { status?: string; blockedBy?: string } = {}): TicketSeed {
  return {
    file: `${id}-t.md`,
    marker: `<!-- state: id=${id} blocked-by=${options.blockedBy ?? "none"} status=${options.status ?? "ready"} -->`,
    body: `# ${id}: Ticket ${id}\n\nDo the work of ${id}.`,
  };
}

/** A pool whose one Ticket is done already, so the server launches nothing. */
export function doneWorld(t: Case, config: PoolConfig = CONFIG): World {
  return t.world({ tickets: [ticket("01", { status: "done" })], config });
}

/** The pool lock, runs/server.pid. */
export function lockPath(pool: string): string {
  return join(pool, "runs", "server.pid");
}

/** Write runs/server.pid as given, as another process would have left it. */
export function writeLock(pool: string, content: string): void {
  mkdirSync(join(pool, "runs"), { recursive: true });
  writeFileSync(lockPath(pool), content);
}

/** runs/server.pid as written, or null when there is none. */
export function readLock(pool: string): string | null {
  return existsSync(lockPath(pool)) ? readFileSync(lockPath(pool), "utf8") : null;
}

// ---------------------------------------------------------------------------
// The fleet registry under the world's HOME
// ---------------------------------------------------------------------------

/** One registry entry as the server writes it. */
export interface FleetEntry {
  poolDir: string;
  port: number;
  pid: number;
  startedAt: string;
}

/** HOME/.agent-graphs, where the registry lives when no --registry is given (engine/fleet.ts). */
export function agentGraphs(world: World): string {
  return join(world.home, ".agent-graphs");
}

/** The registry a server writes when given no --registry. */
export function homeRegistry(world: World): string {
  return join(agentGraphs(world), "pools.json");
}

/** The entry a server writes for its pool once bound: any ISO 8601 time for its start. */
export function entryFor(poolDir: string, port: number, pid: number): FleetEntry {
  return { poolDir, port, pid, startedAt: anyIsoTime() as string };
}

/** The registry's entries, parsed; null when there is no file. */
export function registryEntries(world: World): FleetEntry[] | null {
  const path = homeRegistry(world);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FleetEntry[]) : null;
}

// ---------------------------------------------------------------------------
// Launching by hand
// ---------------------------------------------------------------------------

/** What a case gets beside `t`: processes and ports of its own, all reaped after it. */
export interface Rig {
  /**
   * The server on the world's pool (or `pool`) with exactly these further
   * arguments, so no --port unless the case passes one.
   */
  launch(world: World, args?: string[], options?: { pool?: string }): LaunchedServer;
  /** A live process's pid that no server owns: a sleep the rig started. */
  livePid(): number;
  /** The pid of a process that has exited and been reaped. */
  deadPid(): Promise<number>;
  /**
   * Hold a port with a plain listener in this process, so its holder's pid
   * is this test process's own; any free port when none is named. Throws
   * when the port is busy already.
   */
  holdPort(port?: number): { port: number; release(): void };
}

/**
 * Register one `server` case that launches servers by hand: a launch that
 * must fail, one on a port it picks itself, two at once.
 */
export function serverCase(name: string, body: (t: Case, rig: Rig) => Promise<void>, options: CaseOptions = {}): void {
  conformance(
    "server",
    name,
    async (t) => {
      const launched: LaunchedServer[] = [];
      const sleepers: ReturnType<typeof Bun.spawn>[] = [];
      const held: ReturnType<typeof Bun.serve>[] = [];
      const rig: Rig = {
        launch(world, args = [], launchOptions = {}) {
          const env = world.env(`${world.root}/no-herdr.sock`);
          const server = launchServer({ pool: launchOptions.pool ?? world.pool, env, args });
          launched.push(server);
          return server;
        },
        livePid() {
          const sleeper = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
          sleepers.push(sleeper);
          return sleeper.pid;
        },
        async deadPid() {
          const gone = Bun.spawn(["true"]);
          await gone.exited;
          return gone.pid;
        },
        holdPort(port = 0) {
          const listener = Bun.serve({ port, fetch: () => new Response("held") });
          held.push(listener);
          return { port: listener.port!, release: () => void listener.stop(true) };
        },
      };
      try {
        await body(t, rig);
      } finally {
        for (const server of launched) await server.kill();
        for (const sleeper of sleepers) sleeper.kill("SIGKILL");
        for (const listener of held) void listener.stop(true);
      }
    },
    options,
  );
}

/** Two free ports, never the same one twice. */
export async function twoFreePorts(): Promise<[number, number]> {
  const first = await freePort();
  for (;;) {
    const second = await freePort();
    if (second !== first) return [first, second];
  }
}

/** The lines of a stream, less the empty one a final newline leaves. */
export function linesOf(text: string): string[] {
  return text.split("\n").filter((line, i, all) => line !== "" || i < all.length - 1);
}

/** The boot line a server prints once it serves (engine/server.ts runServerCli). */
export function bootLine(port: number, pool: string): string {
  return `pool server on http://localhost:${port} (${pool})`;
}

// ---------------------------------------------------------------------------
// The snapshot, and snapshot frames phase by phase
// ---------------------------------------------------------------------------

/** GET /api/state's snapshot. */
export async function snapshotOf(server: CaseServer): Promise<EnrichedSnapshot | null> {
  const answer = await server.http.get("/api/state");
  expect(answer.status).toBe(200);
  return answer.json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
}

/** Wait for the snapshot to hold `done`. */
export async function untilSnapshot(
  server: CaseServer,
  done: (snapshot: EnrichedSnapshot) => boolean,
  what: string,
  ms = 30_000,
): Promise<EnrichedSnapshot> {
  return (await until(() => snapshotOf(server), (snapshot) => snapshot !== null && done(snapshot), { what, ms }))!;
}

/** Wait for the final Review, approve it, and wait for the run to end done. */
export async function finishRun(server: CaseServer): Promise<EnrichedSnapshot> {
  await untilSnapshot(server, (s) => s.state.interrupts.some((i) => i.ticketId === "REVIEW"), "the final Review");
  const answer = await server.http.post("/api/resume", { ticketId: "REVIEW", action: "approve" });
  expect(answer.status).toBe(202);
  return untilSnapshot(server, (s) => s.phase === "done", "the run to end done");
}

/** One snapshot or delta frame as the client applied it. */
export interface PhaseFrame {
  type: "snapshot" | "delta";
  seq: number;
  phase: string;
}

/**
 * Every snapshot and delta frame the socket received so far, in arrival
 * order, each with the seq and phase of the snapshot it left the client
 * holding: the frames replayed with socket-protocol.ts's own delta rules.
 */
export function phaseFrames(client: SocketClient): PhaseFrame[] {
  const out: PhaseFrame[] = [];
  let pushed: Parameters<typeof applySnapshotDelta>[0] | null = null;
  for (const frame of client.frames) {
    if (frame.type === "snapshot") {
      pushed = frame.snapshot === null ? null : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
      if (pushed) out.push({ type: "snapshot", seq: pushed.snapshot.seq, phase: pushed.snapshot.phase });
    } else if (frame.type === "delta") {
      pushed = applySnapshotDelta(pushed!, frame.delta);
      out.push({ type: "delta", seq: pushed.snapshot.seq, phase: pushed.snapshot.phase });
    }
  }
  return out;
}
