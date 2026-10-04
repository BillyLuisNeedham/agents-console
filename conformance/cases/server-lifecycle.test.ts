/**
 * The server process itself, seen from outside (ADR-0036): the pool lock in
 * runs/server.pid, the ports it binds or refuses, its entry in the fleet
 * registry, the Console's Stop and the shutdown on SIGTERM. Most of these
 * launch the server by hand (launchServer), since they need a launch that
 * fails, a port the case does not pick, or two servers at once.
 */

import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig, TicketEvent } from "../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import { freePort, launchServer, type LaunchedServer } from "../harness/server.ts";
import type { World } from "../harness/world.ts";

// engine/engine.ts REVIEW_TICKET_ID: the final review gate's Ticket id.
const REVIEW = "REVIEW";
// engine/protocol.ts CLOSE_STOPPED: how the server closes a socket on an orderly stop.
const CLOSE_STOPPED = { code: 1000, reason: "stopped" };
// engine/ports.ts DEFAULT_PORT: where the unpinned hunt starts.
const DEFAULT_PORT = 8787;

const CONFIG: PoolConfig = { defaults: { harness: "claude", model: "m" } };
const DONE = "<!-- state: id=01 blocked-by=none status=done -->";
const READY = "<!-- state: id=01 blocked-by=none status=ready -->";

/** The registry a server writes when given no --registry (engine/fleet.ts defaultRegistryPath). */
function homeRegistry(world: World): string {
  return join(world.home, ".agent-graphs", "pools.json");
}

interface FleetEntry {
  poolDir: string;
  port: number;
  pid: number;
  startedAt: string;
}

/** The registry file's entries as written; missing reads as none. */
function registryEntries(path: string): FleetEntry[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as FleetEntry[];
}

function lockPath(pool: string): string {
  return join(pool, "runs", "server.pid");
}

function writeLock(pool: string, content: string): void {
  mkdirSync(join(pool, "runs"), { recursive: true });
  writeFileSync(lockPath(pool), content);
}

/** A second pool in the same repository, so it shares the world's HOME and registry. */
function addPool(world: World, name: string, config: PoolConfig, marker = DONE): string {
  const pool = join(world.repo, ".scratch", name);
  mkdirSync(join(pool, "issues"), { recursive: true });
  writeFileSync(join(pool, "issues", "01-a.md"), `${marker}\n\n# A\n`);
  writeFileSync(join(pool, "console.json"), JSON.stringify(config, null, 2));
  return pool;
}

function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What a lifecycle case gets beside `t`: processes it launches by hand, all reaped after it. */
interface Rig {
  /** The server on `pool` (default the world's) with exactly these further arguments. */
  launch(world: World, args?: string[], pool?: string): LaunchedServer;
  /** A live process's pid that no server owns: a sleep the rig started. */
  livePid(): number;
  /** The pid of a process that has exited. */
  deadPid(): Promise<number>;
  /** Hold a port with a listener of the rig's own; any free one when none is named. */
  holdPort(port?: number): { port: number; release(): void };
}

function lifecycle(name: string, body: (t: Case, rig: Rig) => Promise<void>, options: { timeoutMs?: number } = {}): void {
  conformance(
    "server",
    name,
    async (t) => {
      const launched: LaunchedServer[] = [];
      const sleepers: ReturnType<typeof Bun.spawn>[] = [];
      const held: ReturnType<typeof Bun.serve>[] = [];
      const rig: Rig = {
        launch(world, args = [], pool = world.pool) {
          const server = launchServer({ pool, env: world.env(`${world.root}/no-herdr.sock`), args });
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

/** A launch that must fail: its exit code, and its stderr. */
async function refused(server: LaunchedServer): Promise<{ code: number; stderr: string }> {
  const code = await Promise.race([server.exited, Bun.sleep(20_000).then(() => null)]);
  if (code === null) throw new Error(`the server kept running when it should have refused:\n${server.stdout()}`);
  return { code, stderr: server.stderr() };
}

// ---------------------------------------------------------------------------
// The pool lock
// ---------------------------------------------------------------------------

// engine/server.test.ts:2150
lifecycle("pool lock › writes its own pid on a successful boot", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const server = await t.start(world);
  expect(readFileSync(lockPath(world.pool), "utf8")).toBe(`${server.pid}\n`);
});

// engine/server.test.ts:2159
lifecycle("pool lock › refuses a live lock, naming the live pid and the pool directory", async (t, rig) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const holder = rig.livePid();
  writeLock(world.pool, `${holder}\n`);
  const { code, stderr } = await refused(rig.launch(world, ["--port", "0"]));
  expect(code).not.toBe(0);
  expect(stderr).toContain(String(holder));
  expect(stderr).toContain(world.pool);
  expect(stderr).not.toContain("on port");
});

// engine/server.test.ts:2173
lifecycle("pool lock › names the live server's port when the registry knows it", async (t, rig) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const holder = rig.livePid();
  writeLock(world.pool, `${holder}\n`);
  const registry = join(world.root, "pools.json");
  writeFileSync(registry, JSON.stringify([{ poolDir: world.pool, port: 8799, pid: holder, startedAt: "t" }]));
  const { code, stderr } = await refused(rig.launch(world, ["--port", "0", "--registry", registry]));
  expect(code).not.toBe(0);
  expect(stderr).toContain("on port 8799");
});

// engine/server.test.ts:2188
lifecycle("pool lock › takes over a stale pid file on boot", async (t, rig) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  writeLock(world.pool, `${await rig.deadPid()}\n`);
  const server = await t.start(world);
  expect(readFileSync(lockPath(world.pool), "utf8").trim()).toBe(String(server.pid));
});

// engine/server.test.ts:2198
lifecycle("pool lock › takes over a pid file that is not a positive integer", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  for (const bogus of ["0", "-1", "not-a-pid", ""]) {
    writeLock(world.pool, bogus);
    const server = await t.start(world);
    expect(readFileSync(lockPath(world.pool), "utf8").trim(), `over ${JSON.stringify(bogus)}`).toBe(String(server.pid));
    await server.stop();
  }
}, { timeoutMs: 120_000 });

// engine/server.test.ts:2224
lifecycle("pool lock › two near-simultaneous launches cannot both pass the lock; the loser names the winner", async (t, rig) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const registry = join(world.root, "pools.json");
  const args = ["--port", "0", "--registry", registry];
  const a = rig.launch(world, args);
  const b = rig.launch(world, args);
  // The first to exit is the loser; the other holds the lock and serves.
  const loser = await Promise.race([a.exited.then(() => a), b.exited.then(() => b)]);
  const winner = loser === a ? b : a;
  expect(loser.exitCode()).not.toBe(0);
  expect(loser.stderr()).toContain("locked by live server");
  expect(loser.stderr()).toContain(String(winner.pid));
  await winner.booted();
  expect(winner.exitCode()).toBeNull();
  await winner.stop();
});

// engine/server.test.ts:2257
lifecycle("pool lock › exits non-zero from the CLI against a live lock, naming pid and pool", async (t, rig) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const holder = rig.livePid();
  writeLock(world.pool, `${holder}\n`);
  const { code, stderr } = await refused(rig.launch(world, ["--port", "8799"]));
  expect(code).not.toBe(0);
  expect(stderr).toContain(String(holder));
  expect(stderr).toContain(world.pool);
});

// ---------------------------------------------------------------------------
// Pinned pool ports
// ---------------------------------------------------------------------------

// engine/server.test.ts:2292
lifecycle("pinned pool ports › binds the console.json port on every launch", async (t, rig) => {
  const port = await freePort();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: { ...CONFIG, port } });
  const first = rig.launch(world);
  expect(await first.booted()).toBe(port);
  await first.stop();
  const second = rig.launch(world);
  expect(await second.booted()).toBe(port);
  await second.stop();
});

// engine/server.test.ts:2307
lifecycle("pinned pool ports › a failed pinned bind clears the lock it claimed, so a retry can boot", async (t, rig) => {
  const held = rig.holdPort();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: { ...CONFIG, port: held.port } });
  const { code, stderr } = await refused(rig.launch(world));
  expect(code).not.toBe(0);
  expect(stderr).toContain(String(held.port));
  // The failed boot must not leave a live-looking pid, or the retry refuses.
  expect(existsSync(lockPath(world.pool))).toBe(false);
  held.release();
  const retry = rig.launch(world);
  expect(await retry.booted()).toBe(held.port);
  await retry.stop();
});

// engine/server.test.ts:2325
lifecycle("pinned pool ports › refuses a busy console.json pin, naming the port", async (t, rig) => {
  const held = rig.holdPort();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: { ...CONFIG, port: held.port } });
  const { code, stderr } = await refused(rig.launch(world));
  expect(code).not.toBe(0);
  expect(stderr).toContain(String(held.port));
});

// engine/server.test.ts:2338
lifecycle("pinned pool ports › refuses a busy --port pin, naming the port", async (t, rig) => {
  const held = rig.holdPort();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const { code, stderr } = await refused(rig.launch(world, ["--port", String(held.port)]));
  expect(code).not.toBe(0);
  expect(stderr).toContain(String(held.port));
});

// engine/server.test.ts:2351
lifecycle("pinned pool ports › names the conflicting pool and pid on a busy pin when the registry knows the holder", async (t, rig) => {
  const held = rig.holdPort();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: { ...CONFIG, port: held.port } });
  const holderPool = join(world.root, "holder-pool");
  mkdirSync(holderPool);
  const holder = rig.livePid();
  const registry = join(world.root, "pools.json");
  writeFileSync(registry, JSON.stringify([{ poolDir: holderPool, port: held.port, pid: holder, startedAt: "t" }]));
  const { code, stderr } = await refused(rig.launch(world, ["--registry", registry]));
  expect(code).not.toBe(0);
  expect(stderr).toContain(String(held.port));
  expect(stderr).toContain(holderPool);
  expect(stderr).toContain(String(holder));
});

// engine/server.test.ts:2375
lifecycle("pinned pool ports › names a live holder's pool and pid when a second server boots into its pin", async (t, rig) => {
  const port = await freePort();
  // Both pools in one repository, so both servers share the world's HOME
  // and so its fleet registry.
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: { ...CONFIG, port } });
  const contenderPool = addPool(world, "contender", { ...CONFIG, port });
  const holder = rig.launch(world);
  expect(await holder.booted()).toBe(port);
  const { code, stderr } = await refused(rig.launch(world, [], contenderPool));
  expect(code).not.toBe(0);
  expect(stderr).toContain(String(port));
  expect(stderr).toContain(world.pool);
  expect(stderr).toContain(String(holder.pid));
  await holder.stop();
});

// engine/server.test.ts:2404
lifecycle("pinned pool ports › exits non-zero from the CLI on a busy pin, naming the holder from the registry", async (t, rig) => {
  const held = rig.holdPort();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const holderPool = join(world.root, "holder-pool");
  mkdirSync(holderPool);
  const holder = rig.livePid();
  const registry = join(world.root, "pools.json");
  writeFileSync(registry, JSON.stringify([{ poolDir: holderPool, port: held.port, pid: holder, startedAt: "t" }]));
  const { code, stderr } = await refused(rig.launch(world, ["--port", String(held.port), "--registry", registry]));
  expect(code).not.toBe(0);
  expect(stderr).toContain(holderPool);
  expect(stderr).toContain(String(holder));
});

// engine/server.test.ts:2439
lifecycle("pinned pool ports › a failed launch never deletes a pid file naming another live server", async (t, rig) => {
  const held = rig.holdPort();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const holder = rig.livePid();
  writeLock(world.pool, `${holder}\n`);
  const { code, stderr } = await refused(rig.launch(world, ["--port", String(held.port)]));
  expect(code).not.toBe(0);
  expect(stderr).toContain("locked by live server");
  expect(readFileSync(lockPath(world.pool), "utf8").trim()).toBe(String(holder));
});

// engine/server.test.ts:2456
lifecycle("pinned pool ports › --port overrides the console.json pin for that launch", async (t) => {
  const configPort = await freePort();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: { ...CONFIG, port: configPort } });
  // t.start pins a free port of its own with --port and checks the server
  // booted on exactly that one.
  const server = await t.start(world);
  expect(server.port).not.toBe(configPort);
  expect(server.url).toBe(`http://localhost:${server.port}`);
});

// engine/server.test.ts:2466
lifecycle("pinned pool ports › with no pin, binds the default port when it is free", async (t, rig) => {
  // The default port is not settable (decided in the test inventory's open
  // question 2), so this runs only when 8787 is free on the box.
  let probe: { port: number; release(): void };
  try {
    probe = rig.holdPort(DEFAULT_PORT);
  } catch {
    console.warn(`port ${DEFAULT_PORT} is busy on this machine: the default-port case did not run`);
    return;
  }
  probe.release();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const server = rig.launch(world);
  expect(await server.booted()).toBe(DEFAULT_PORT);
  expect(registryEntries(homeRegistry(world)).map((entry) => entry.port)).toEqual([DEFAULT_PORT]);
  await server.stop();
});

// engine/server.test.ts:2474
lifecycle("pinned pool ports › with no pin, hunts to the next free port when the default is busy", async (t, rig) => {
  // Held by the rig when free; busy already otherwise, which serves as well.
  try {
    rig.holdPort(DEFAULT_PORT);
  } catch {
    // Something else on the machine holds it.
  }
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const server = rig.launch(world);
  const port = await server.booted();
  expect(port).toBeGreaterThan(DEFAULT_PORT);
  expect(registryEntries(homeRegistry(world)).map((entry) => entry.port)).toEqual([port]);
  await server.stop();
});

// engine/server.test.ts:2484
lifecycle("pinned pool ports › exits non-zero from the CLI when a --port pin is busy, naming the port", async (t, rig) => {
  const held = rig.holdPort();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: READY }], config: CONFIG });
  const { code, stderr } = await refused(rig.launch(world, ["--port", String(held.port)]));
  expect(code).not.toBe(0);
  expect(stderr).toContain(String(held.port));
});

// ---------------------------------------------------------------------------
// Fleet registration
// ---------------------------------------------------------------------------

// engine/server.test.ts:2503
lifecycle("fleet registration › upserts its entry in the registry after a successful bind", async (t, rig) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const registry = join(world.root, "pools.json");
  const server = rig.launch(world, ["--port", "0", "--registry", registry]);
  const port = await server.booted();
  const entries = registryEntries(registry);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toEqual({ poolDir: world.pool, port, pid: server.pid, startedAt: expect.any(String) });
  await server.stop();
});

// engine/server.test.ts:2524
lifecycle("fleet registration › relaunching the same pool updates the entry rather than duplicating", async (t, rig) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const registry = join(world.root, "pools.json");
  const first = rig.launch(world, ["--port", "0", "--registry", registry]);
  const firstPort = await first.booted();
  expect(registryEntries(registry).map((entry) => [entry.poolDir, entry.pid, entry.port])).toEqual([
    [world.pool, first.pid, firstPort],
  ]);
  await first.stop();
  const second = rig.launch(world, ["--port", "0", "--registry", registry]);
  const secondPort = await second.booted();
  expect(registryEntries(registry).map((entry) => [entry.poolDir, entry.pid, entry.port])).toEqual([
    [world.pool, second.pid, secondPort],
  ]);
  await second.stop();
});

// engine/server.test.ts:2555
lifecycle("fleet registration › a corrupt registry file is recreated on write, not a boot failure", async (t, rig) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const registry = join(world.root, "pools.json");
  writeFileSync(registry, "{ not json");
  const server = rig.launch(world, ["--port", "0", "--registry", registry]);
  await server.booted();
  expect(registryEntries(registry)).toHaveLength(1);
  await server.stop();
});

// engine/server.test.ts:2569
lifecycle("fleet registration › an absent registry is created on write, not a boot failure", async (t, rig) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const registry = join(world.root, "nested", "pools.json");
  const server = rig.launch(world, ["--port", "0", "--registry", registry]);
  await server.booted();
  expect(registryEntries(registry)).toHaveLength(1);
  await server.stop();
});

// engine/server.test.ts:2582
lifecycle("fleet registration › a failed bind registers nothing", async (t, rig) => {
  const held = rig.holdPort();
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: { ...CONFIG, port: held.port } });
  const registry = join(world.root, "pools.json");
  const { code, stderr } = await refused(rig.launch(world, ["--registry", registry]));
  expect(code).not.toBe(0);
  expect(stderr).toContain(String(held.port));
  expect(registryEntries(registry)).toEqual([]);
});

// engine/server.test.ts:2599
lifecycle("fleet registration › two servers booting different pools concurrently both end up in the registry", async (t, rig) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const poolB = addPool(world, "second", CONFIG);
  const registry = join(world.root, "pools.json");
  const a = rig.launch(world, ["--port", "0", "--registry", registry]);
  const b = rig.launch(world, ["--port", "0", "--registry", registry], poolB);
  await Promise.all([a.booted(20_000), b.booted(20_000)]);
  const entries = await until(
    () => registryEntries(registry),
    (got) => got.length === 2,
    { what: "both pools in the registry" },
  );
  expect(entries.map((entry) => entry.poolDir).sort()).toEqual([world.pool, poolB].sort());
  expect(entries.map((entry) => entry.pid).sort()).toEqual([a.pid, b.pid].sort());
  await Promise.all([a.stop(), b.stop()]);
});

// ---------------------------------------------------------------------------
// Stop from the Console (#97)
// ---------------------------------------------------------------------------

interface Served {
  phase: string;
  poolDir: string;
  state: { interrupts: { kind: string }[] };
}

async function snapshot(server: CaseServer): Promise<Served | null> {
  return (await server.http.get("/api/state")).json<{ snapshot: Served | null }>().snapshot;
}

/** Wait for the REVIEW gate, approve it and wait for phase done. */
async function finish(server: CaseServer): Promise<void> {
  await until(
    () => snapshot(server),
    (got) => got?.state.interrupts.some((interrupt) => interrupt.kind === "review") ?? false,
    { ms: 30_000, what: "the pool to reach its review gate" },
  );
  const approve = await server.http.post("/api/resume", { ticketId: REVIEW, action: "approve" });
  expect(approve.status).toBe(202);
  await until(() => snapshot(server), (got) => got?.phase === "done", { ms: 30_000, what: "the pool to finish" });
}

// engine/server.test.ts:3335
lifecycle("stop from the Console (#97) › refuses a stop while the pool is running and lets the attempt finish", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: READY }], config: CONFIG });
  const sentinel = join(world.root, "go");
  world.stubs.script("01", { waitFor: sentinel });
  const server = await t.start(world);
  await until(
    async () => ({ phase: (await snapshot(server))?.phase, launched: world.stubs.calls().length }),
    (got) => got.phase === "running" && got.launched > 0,
    { what: "the pool running with 01's attempt in flight" },
  );

  const stop = await server.http.post("/api/stop");
  expect(stop.status).toBe(409);
  const error = stop.json<{ error: string }>().error;
  expect(error).toContain("not done");
  expect(error).toContain("running");

  // Nothing was torn down: the server still serves, still running.
  const state = await server.http.get("/api/state");
  expect(state.status).toBe(200);
  expect(state.json<{ snapshot: Served }>().snapshot.phase).toBe("running");

  writeFileSync(sentinel, "go");
  await until(() => readStateLine(world.pool, "01-a.md").status, (status) => status === "done", {
    ms: 20_000,
    what: "01's marker to say done",
  });
});

// engine/server.test.ts:3369
lifecycle("stop from the Console (#97) › stops a finished pool: 202, a `stopped` farewell, then a closed socket and port", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: READY }], config: CONFIG });
  const server = await t.start(world);
  await finish(server);
  expect(existsSync(lockPath(world.pool))).toBe(true);

  const client = await t.socket(server);
  const opening = await client.waitFor((frame) => frame.type === "snapshot");
  expect(opening).toMatchObject({ snapshot: { phase: "done" } });

  const stop = await server.http.post("/api/stop");
  expect(stop.status).toBe(202);
  expect(stop.json<unknown>()).toEqual({ stopping: true });

  // The farewell arrives on the open socket, then the server closes it cleanly.
  expect(await client.closed).toEqual(CLOSE_STOPPED);
  expect(client.frames.at(-1)?.type).toBe("delta");
  expect(client.pushed?.snapshot.phase).toBe("stopped");
  // The farewell names the pool dir a relaunch would pass to --pool.
  expect(client.pushed?.snapshot.poolDir).toBe(world.pool);

  // The process goes: exit 0 with the lock released (stop() checks both on a
  // server already gone), and the port refuses connections.
  await until(() => server.exited(), (gone) => gone, { ms: 20_000, what: "the server to exit" });
  await server.stop();
  expect(existsSync(lockPath(world.pool))).toBe(false);
  await expect(fetch(`${server.url}/api/state`)).rejects.toThrow();
});

// engine/server.test.ts:3405
lifecycle("stop from the Console (#97) › acknowledges a repeat stop without starting a second one", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: READY }], config: CONFIG });
  const server = await t.start(world);
  await finish(server);

  const [first, second] = await Promise.all([server.http.post("/api/stop"), server.http.post("/api/stop")]);
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(second.json<unknown>()).toEqual({ stopping: true });

  await until(() => server.exited(), (gone) => gone, { ms: 20_000, what: "the server to exit" });
  await server.stop();
  // One stop ran.
  expect(server.log().split("\n").filter((line) => line.includes("stop requested from the Console"))).toHaveLength(1);
  expect(existsSync(lockPath(world.pool))).toBe(false);
  await expect(fetch(`${server.url}/api/state`)).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// Server shutdown on signal
// ---------------------------------------------------------------------------

// engine/server.test.ts:3475
lifecycle("server shutdown on signal › SIGTERM stops the running attempt and its grandchildren, releases server.pid, and exits 0", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: READY }], config: CONFIG });
  // In place of the stub claude: one that backgrounds a long sleep, records
  // its pid and waits on it, so the attempt has a grandchild to stop.
  const grandchildFile = join(world.root, "grandchild.pid");
  const claude = join(world.stubs.bin, "claude");
  writeFileSync(claude, ["#!/usr/bin/env bash", "sleep 60 &", `echo $! > "${grandchildFile}"`, "wait", ""].join("\n"));
  chmodSync(claude, 0o755);
  const server = await t.start(world);
  let pid = 0;
  let grandchild = 0;
  try {
    const spawned = await until(
      () => ({
        event: readEvents(world.pool, "01").find((event: TicketEvent) => event.kind === "spawned"),
        grandchild: existsSync(grandchildFile) ? readFileSync(grandchildFile, "utf8").trim() : "",
      }),
      (got) => typeof (got.event?.payload as { pid?: number } | undefined)?.pid === "number" && got.grandchild !== "",
      { ms: 20_000, what: "01's attempt and its grandchild running" },
    );
    pid = (spawned.event!.payload as { pid: number }).pid;
    grandchild = Number(spawned.grandchild);
    expect(live(pid)).toBe(true);
    expect(live(grandchild)).toBe(true);
    expect(existsSync(lockPath(world.pool))).toBe(true);

    // A Console tab watching when the signal lands ends on the farewell.
    const tab = await t.socket(server);
    await tab.waitFor((frame) => frame.type === "snapshot" && frame.snapshot !== null);

    // SIGTERM; stop() requires exit 0 and runs/server.pid released.
    await server.stop();

    expect(await until(() => live(pid) || live(grandchild), (alive) => !alive, { ms: 3_000, what: "the attempt and its grandchild to be gone" })).toBe(false);
    expect(existsSync(lockPath(world.pool))).toBe(false);
    expect(await tab.closed).toEqual(CLOSE_STOPPED);
    expect(tab.pushed?.snapshot.phase).toBe("stopped");
    expect(server.log()).toContain("SIGTERM: stopping attempts, then exiting");
    expect(readFileSync(join(world.pool, "runs", "01.events.jsonl"), "utf8")).toContain(
      "harness stopped by engine shutdown (exited 143)",
    );
  } finally {
    for (const p of [pid, grandchild]) {
      if (p > 0) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
  }
});

// engine/server.test.ts:3582
lifecycle("server shutdown on signal › POST /api/stop exits the CLI process once the pool is done, and refuses before it", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: DONE }], config: CONFIG });
  const server = await t.start(world);
  await until(
    () => snapshot(server),
    (got) => got?.state.interrupts.some((interrupt) => interrupt.kind === "review") ?? false,
    { ms: 30_000, what: "the pool to reach its review gate" },
  );

  // Held at the review gate, the pool is not done: the stop is refused.
  const early = await server.http.post("/api/stop");
  expect(early.status).toBe(409);
  expect(early.json<{ error: string }>().error).toContain("not done");
  expect((await snapshot(server))?.phase).not.toBe("stopped");

  const approve = await server.http.post("/api/resume", { ticketId: REVIEW, action: "approve" });
  expect(approve.status).toBe(202);
  await until(() => snapshot(server), (got) => got?.phase === "done", { ms: 30_000, what: "the pool to finish" });

  const tab = await t.socket(server);
  await tab.waitFor((frame) => frame.type === "snapshot" && frame.snapshot !== null);

  const stop = await server.http.post("/api/stop");
  expect(stop.status).toBe(202);
  expect(stop.json<unknown>()).toEqual({ stopping: true });

  expect(await tab.closed).toEqual(CLOSE_STOPPED);
  expect(tab.pushed?.snapshot.phase).toBe("stopped");

  // The process exits 0, says why, and leaves the pool unlocked.
  await until(() => server.exited(), (gone) => gone, { ms: 20_000, what: "the server to exit" });
  await server.stop();
  expect(server.log()).toContain("stop requested from the Console: stopping attempts, then exiting");
  expect(existsSync(lockPath(world.pool))).toBe(false);
});
