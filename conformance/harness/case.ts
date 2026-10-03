/**
 * A conformance case: one Bun test, tagged with its contract area, that
 * builds its own world, runs the chosen server against it as a separate
 * process, and observes only what is visible from outside that process
 * (ADR-0036): HTTP, the socket, the pool's files, the calls on the herdr
 * socket and the harness processes the server started.
 *
 *   conformance("http", "GET /api/state answers the seeded pool", async (t) => {
 *     const world = t.world({ tickets: [...] });
 *     const server = await t.start(world);
 *     const state = await server.http.get("/api/state");
 *   });
 *
 * Everything a case starts is torn down after it, pass or fail: sockets
 * closed, servers stopped (an unclean stop fails the case), the fake herdr
 * stopped, the world deleted. CONFORMANCE_KEEP=1 keeps the worlds and names
 * them, for a failure worth reading on disk. A case that times out is
 * abandoned rather than torn down: Bun kills the processes it left, and the
 * runner deletes the temporary directory every world was made in.
 *
 * A takeover case (`{ takeover: true }`) runs one pool across several
 * server processes in turn, its legs, each started with `t.start(world,
 * { leg })` once the last has stopped. Which server each leg runs is
 * `t.legs`, from CONFORMANCE_LEGS (harness/server.ts); harness/takeover.ts
 * drives the usual shape of one.
 */

import { test } from "bun:test";
import { rmSync } from "node:fs";
import type { CardSubscription } from "../../engine/protocol.ts";
import { openSocket, type SocketClient } from "../fixtures/socket-fixture.ts";
import type { Area } from "./areas.ts";
import { startHerdr, type HerdrOptions, type HerdrProcess } from "./herdr.ts";
import { http, type Http } from "./http.ts";
import {
  legsMissing,
  serverChoice,
  serverLegs,
  serverMissing,
  startServer,
  type RunningServer,
  type ServerChoice,
  type ServerKind,
} from "./server.ts";
import { makeWorld, type World, type WorldSpec } from "./world.ts";

export interface CaseServer extends RunningServer {
  http: Http;
}

export interface Case {
  /** The server this run drives. */
  kind: ServerKind;
  /**
   * The server each leg of a takeover case runs, in order; a case that is
   * not a takeover has the one leg, `kind`.
   */
  legs: ServerKind[];
  /** A fresh world on disk. */
  world(spec?: WorldSpec): World;
  /** The fake herdr for a world, as its own process with the world's environment. */
  herdr(world: World, options?: HerdrOptions): Promise<HerdrProcess>;
  /**
   * The server under test on a world's pool, ready. With `herdr` it talks
   * to that fake; without, its HERDR_SOCKET_PATH names a socket nobody
   * listens on, so the pool runs headless. `leg` picks the server from
   * `legs` (default 0); another server on the same pool must have stopped
   * first, since the pool lock admits one.
   */
  start(world: World, options?: { herdr?: HerdrProcess; leg?: number }): Promise<CaseServer>;
  /** A socket on a server; with `hello`, the client's hello goes first. */
  socket(server: RunningServer, hello?: { visible: boolean; cards?: CardSubscription[] }): Promise<SocketClient>;
}

export interface CaseOptions {
  /** The case's bound, start and stop included. Default 60 s. */
  timeoutMs?: number;
  /** A takeover case, whose legs run the servers CONFORMANCE_LEGS names. */
  takeover?: boolean;
}

/** The servers a case's legs run: CONFORMANCE_LEGS for a takeover, else the run's one. */
function caseLegs(options: CaseOptions): ServerChoice[] {
  return options.takeover ? serverLegs() : [serverChoice()];
}

function caseContext(legs: ServerChoice[]): { t: Case; teardown(failed: boolean): Promise<void> } {
  const choice = serverChoice();
  const worlds: World[] = [];
  const herdrs: HerdrProcess[] = [];
  const servers: CaseServer[] = [];
  const sockets: SocketClient[] = [];
  const t: Case = {
    kind: choice.kind,
    legs: legs.map((leg) => leg.kind),
    world(spec) {
      const world = makeWorld(spec);
      worlds.push(world);
      return world;
    },
    async herdr(world, options) {
      const fake = await startHerdr(world.env(""), options);
      herdrs.push(fake);
      return fake;
    },
    async start(world, options = {}) {
      const socket = options.herdr?.socketPath ?? `${world.root}/no-herdr.sock`;
      const leg = legs[options.leg ?? 0];
      if (!leg) throw new Error(`no leg ${options.leg}: this case has ${legs.length}`);
      const running = await startServer({ pool: world.pool, env: world.env(socket), choice: leg });
      const server: CaseServer = { ...running, http: http(running.url) };
      servers.push(server);
      return server;
    },
    async socket(server, hello) {
      const client = await openSocket(server.url, hello);
      sockets.push(client);
      return client;
    },
  };
  return {
    t,
    async teardown(failed) {
      const problems: string[] = [];
      for (const socket of sockets) socket.close();
      for (const server of servers) {
        if (failed) {
          console.error(`--- ${server.kind} server log, ${server.logPath}:\n${server.log()}`);
        }
        if (server.exited()) continue;
        try {
          await server.stop();
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err));
        }
      }
      for (const fake of herdrs) await fake.stop();
      for (const world of worlds) {
        if (process.env.CONFORMANCE_KEEP === "1") {
          console.error(`kept the world at ${world.root}`);
          continue;
        }
        rmSync(world.root, { recursive: true, force: true });
      }
      if (problems.length > 0) throw new Error(problems.join("\n"));
    },
  };
}

/**
 * Register one case. Its test name is `[<area>] <name>`, which is how the
 * runner counts it under its area. When the chosen server cannot run (the
 * Rust binary is not built), or for a takeover one of its legs' servers,
 * the case is skipped, never failed, and the runner reports why.
 */
export function conformance(
  area: Area,
  name: string,
  body: (t: Case) => Promise<void>,
  options: CaseOptions = {},
): void {
  const title = `[${area}] ${name}`;
  const legs = caseLegs(options);
  if (serverMissing(serverChoice()) !== null || legsMissing(legs) !== null) {
    test.skip(title, () => {});
    return;
  }
  test(
    title,
    async () => {
      const { t, teardown } = caseContext(legs);
      let failed = false;
      try {
        await body(t);
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        await teardown(failed);
      }
    },
    options.timeoutMs ?? 60_000,
  );
}
