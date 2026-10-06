/**
 * The fleet registry, HOME/.agent-graphs/pools.json, as a server started
 * with no --registry writes and reads it (the inventory's ticket C03, from
 * engine/fleet.test.ts): the entry it upserts once it has bound, keyed by
 * pool directory; the lock beside the file that serialises writers; and the
 * prune-on-read lookups its refusals make to name the holder of a busy pin
 * or of a live pool lock. A stopping server never touches the registry, so
 * a dead pid or a deleted pool only drops from view on the next read.
 *
 * Every world has its own HOME, so nothing here reads or writes the
 * operator's registry.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ticketContent, type World } from "../harness/world.ts";
import {
  agentGraphs,
  CONFIG,
  doneWorld,
  entryFor,
  homeRegistry,
  readLock,
  registryEntries,
  serverCase,
  ticket,
  twoFreePorts,
  writeLock,
} from "./server-support.ts";

/** How long a registry write waits on a lock a live writer holds (engine/fleet.ts FLEET_LOCK_TIMEOUT_MS). */
const FLEET_LOCK_WAIT_MS = 10_000;

/** The registry's lock file, beside it. */
function registryLock(world: World): string {
  return `${homeRegistry(world)}.lock`;
}

/** Write a file under HOME/.agent-graphs, making the directory. */
function seedGraphs(world: World, file: string, content: string): string {
  mkdirSync(agentGraphs(world), { recursive: true });
  const path = join(agentGraphs(world), file);
  writeFileSync(path, content);
  return path;
}

/** A second pool in the world's repository, so it shares the world's HOME and so its registry. */
function addPool(world: World, name: string): string {
  const pool = join(world.repo, ".scratch", name);
  mkdirSync(join(pool, "issues"), { recursive: true });
  writeFileSync(join(pool, "issues", "01-t.md"), ticketContent(ticket("01", { status: "done" })));
  writeFileSync(join(pool, "console.json"), JSON.stringify(CONFIG, null, 2));
  return pool;
}

/** The refusal a busy pin gets when the registry names no live holder. */
function busyPin(port: number): string {
  return `port ${port} is already in use; free it or pass a different --port\n`;
}

/** The refusal a live pool lock gets, with the holder's port when the registry knows it. */
function lockedBy(pool: string, pid: number, port?: number): string {
  const on = port === undefined ? "" : ` on port ${port}`;
  return `pool ${pool} is locked by live server pid ${pid}${on}; open the running console or kill it\n`;
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

// engine/fleet.test.ts:60
serverCase("fleet registry upsert › relaunching a pool on another port replaces its entry rather than duplicating", async (t, rig) => {
  const world = doneWorld(t);
  const [firstPort, secondPort] = await twoFreePorts();
  const first = rig.launch(world, ["--port", String(firstPort)]);
  await first.booted();
  const registered = registryEntries(world);
  expect(registered).toEqual([entryFor(world.pool, firstPort, first.pid)]);

  // SIGTERM releases the pool lock and leaves the registry as it was.
  await first.stop();
  expect(registryEntries(world)).toEqual(registered);

  const second = rig.launch(world, ["--port", String(secondPort)]);
  await second.booted();
  expect(registryEntries(world)).toEqual([entryFor(world.pool, secondPort, second.pid)]);
  await second.stop();
});

// engine/fleet.test.ts:82
serverCase("fleet registry upsert › a second pool's registration leaves the first pool's entry as it was, after it", async (t, rig) => {
  const world = doneWorld(t);
  const secondPool = addPool(world, "second");
  const a = rig.launch(world, ["--port", "0"]);
  const aPort = await a.booted();
  const [aEntry] = registryEntries(world)!;
  expect(aEntry).toEqual(entryFor(world.pool, aPort, a.pid));

  const b = rig.launch(world, ["--port", "0"], { pool: secondPool });
  const bPort = await b.booted();
  expect(registryEntries(world)).toEqual([aEntry, entryFor(secondPool, bPort, b.pid)]);
  await Promise.all([a.stop(), b.stop()]);
});

// engine/fleet.test.ts:104
// Also the first half of the gap at engine/server.ts:2711.
serverCase("fleet registry upsert › creates HOME/.agent-graphs and pools.json when neither exists, holding the server's entry", async (t, rig) => {
  const world = doneWorld(t);
  expect(existsSync(agentGraphs(world))).toBe(false);
  const server = rig.launch(world, ["--port", "0"]);
  const port = await server.booted();
  expect(registryEntries(world)).toEqual([entryFor(world.pool, port, server.pid)]);
  await server.stop();
});

serverCase("fleet registry upsert › records the pool directory absolute and normalised, however --pool spelt it", async (t, rig) => {
  const world = doneWorld(t);
  const spelt = `${join(world.repo, ".scratch")}/../.scratch/./pool/`;
  const server = rig.launch(world, ["--port", "0"], { pool: spelt });
  const port = await server.booted();
  expect(registryEntries(world)).toEqual([entryFor(world.pool, port, server.pid)]);
  expect(readLock(world.pool)).toBe(`${server.pid}\n`);
  // A second launch spelt the same way finds that entry, and names the pool as it was recorded.
  const refused = await rig.launch(world, ["--port", "0"], { pool: spelt }).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(lockedBy(world.pool, server.pid, port));
  await server.stop();
});

serverCase("fleet registry upsert › keeps every well-formed entry of another pool, live or not and whole, drops the rest, and puts its own last", async (t, rig) => {
  const world = doneWorld(t);
  const at = "2026-10-03T00:00:00.000Z";
  const pool = (name: string): string => {
    const dir = join(world.root, name);
    mkdirSync(dir);
    return dir;
  };
  const live = { poolDir: pool("live"), port: 8788, pid: rig.livePid(), startedAt: at };
  const dead = { poolDir: pool("dead"), port: 8789, pid: await rig.deadPid(), startedAt: at };
  const gone = { poolDir: join(world.root, "gone"), port: 8790, pid: rig.livePid(), startedAt: at };
  // A key beside the four survives the rewrite.
  const extra = { poolDir: pool("extra"), port: 8791, pid: rig.livePid(), startedAt: at, note: "kept whole" };
  seedGraphs(
    world,
    "pools.json",
    JSON.stringify([
      // This pool's own entry, left by a server that has gone.
      { poolDir: world.pool, port: 8792, pid: await rig.deadPid(), startedAt: at },
      live,
      { poolDir: pool("port-text"), port: "8793", pid: rig.livePid(), startedAt: at },
      dead,
      { poolDir: pool("no-start"), port: 8794, pid: rig.livePid() },
      gone,
      "not an entry",
      null,
      extra,
    ]),
  );
  const server = rig.launch(world, ["--port", "0"]);
  const port = await server.booted();
  expect(registryEntries(world) as unknown[]).toEqual([live, dead, gone, extra, entryFor(world.pool, port, server.pid)]);
  await server.stop();
});

// engine/fleet.test.ts:152
serverCase("fleet registry upsert › clears a registry lock a crashed writer left, registering without waiting on it", async (t, rig) => {
  const world = doneWorld(t);
  seedGraphs(world, "pools.json.lock", `${await rig.deadPid()}\n`);
  const launched = Date.now();
  const server = rig.launch(world, ["--port", "0"]);
  const port = await server.booted();
  // A live writer's lock is waited on for ten seconds; a dead one's is not.
  expect(Date.now() - launched).toBeLessThan(FLEET_LOCK_WAIT_MS);
  expect(registryEntries(world)).toEqual([entryFor(world.pool, port, server.pid)]);
  expect(existsSync(registryLock(world))).toBe(false);
  expect(server.stderr()).toBe("");
  await server.stop();
});

// engine/fleet.test.ts:170
serverCase("fleet registry upsert › replaces pools.json by rename, leaving no temporary or lock file beside it", async (t, rig) => {
  const world = doneWorld(t);
  const server = rig.launch(world, ["--port", "0"]);
  await server.booted();
  expect(readdirSync(agentGraphs(world))).toEqual(["pools.json"]);
  await server.stop();
});

serverCase("fleet registry upsert › waits ten seconds on a registry lock a live writer holds, then serves without an entry, saying so on stderr", async (t, rig) => {
  const world = doneWorld(t);
  const writer = rig.livePid();
  const lock = seedGraphs(world, "pools.json.lock", `${writer}\n`);
  const launched = Date.now();
  const server = rig.launch(world, ["--port", "0"]);
  const port = await server.booted(FLEET_LOCK_WAIT_MS + 20_000);
  expect(Date.now() - launched).toBeGreaterThanOrEqual(FLEET_LOCK_WAIT_MS);
  // The line names the lock and its holder. (The Bun server says "fleet
  // registry: " twice over; NOT-PORTED.md.)
  const said = server.stderr().split("\n").filter((line) => line !== "");
  expect(said).toHaveLength(1);
  expect(said[0]!.startsWith("fleet registry: ")).toBe(true);
  expect(said[0]).toContain(`lock ${lock} is held by live pid ${writer}`);
  // Nothing was written past the lock, which is left to its holder.
  expect(registryEntries(world)).toBeNull();
  expect(readFileSync(lock, "utf8")).toBe(`${writer}\n`);
  expect((await fetch(`http://localhost:${port}/api/state`)).status).toBe(200);
  await server.stop();
}, { slow: true });

serverCase("fleet registry upsert › clears a registry lock still empty after ten seconds, as a writer that crashed mid-claim left it, and registers", async (t, rig) => {
  const world = doneWorld(t);
  seedGraphs(world, "pools.json.lock", "");
  const launched = Date.now();
  const server = rig.launch(world, ["--port", "0"]);
  const port = await server.booted(FLEET_LOCK_WAIT_MS + 20_000);
  expect(Date.now() - launched).toBeGreaterThanOrEqual(FLEET_LOCK_WAIT_MS);
  expect(registryEntries(world)).toEqual([entryFor(world.pool, port, server.pid)]);
  expect(existsSync(registryLock(world))).toBe(false);
  expect(server.stderr()).toBe("");
  await server.stop();
}, { slow: true });

// The second half of the gap at engine/server.ts:2711.
serverCase("fleet registration › a registry that cannot be written is reported on stderr as fleet registry:, and the server serves anyway", async (t, rig) => {
  const world = doneWorld(t);
  // HOME/.agent-graphs is a regular file, so no registry can be made under it.
  writeFileSync(agentGraphs(world), "not a directory\n");
  const server = rig.launch(world, ["--port", "0"]);
  const port = await server.booted();
  const said = server.stderr().split("\n").filter((line) => line !== "");
  expect(said).toHaveLength(1);
  expect(said[0]!.startsWith("fleet registry: ")).toBe(true);
  expect((await fetch(`http://localhost:${port}/api/state`)).status).toBe(200);
  expect(readFileSync(agentGraphs(world), "utf8")).toBe("not a directory\n");
  await server.stop();
});

// ---------------------------------------------------------------------------
// Prune-on-read: naming the holder of a busy pin
// ---------------------------------------------------------------------------

// engine/fleet.test.ts:186
serverCase("fleet registry prune-on-read › a busy pin with no registry names no holder", async (t, rig) => {
  const held = rig.holdPort();
  const world = doneWorld(t, { ...CONFIG, port: held.port });
  const refused = await rig.launch(world).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(busyPin(held.port));
  // A bind that failed registers nothing.
  expect(existsSync(agentGraphs(world))).toBe(false);
});

// engine/fleet.test.ts:191
serverCase("fleet registry prune-on-read › a busy pin with a registry that is not JSON names no holder, and leaves the file as it was", async (t, rig) => {
  const held = rig.holdPort();
  const world = doneWorld(t, { ...CONFIG, port: held.port });
  const registry = seedGraphs(world, "pools.json", "{ not json");
  const refused = await rig.launch(world).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(busyPin(held.port));
  expect(readFileSync(registry, "utf8")).toBe("{ not json");
});

// engine/fleet.test.ts:197
serverCase("fleet registry prune-on-read › a busy pin whose registry entry has a dead pid names no holder, and the file keeps the entry", async (t, rig) => {
  const held = rig.holdPort();
  const world = doneWorld(t, { ...CONFIG, port: held.port });
  const holderPool = join(world.root, "holder-pool");
  mkdirSync(holderPool);
  const text = JSON.stringify([{ poolDir: holderPool, port: held.port, pid: await rig.deadPid(), startedAt: "t" }]);
  const registry = seedGraphs(world, "pools.json", text);
  const refused = await rig.launch(world).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(busyPin(held.port));
  expect(readFileSync(registry, "utf8")).toBe(text);
});

// engine/fleet.test.ts:211
serverCase("fleet registry prune-on-read › a busy pin whose registry entry names a pool directory that is gone names no holder", async (t, rig) => {
  const held = rig.holdPort();
  const world = doneWorld(t, { ...CONFIG, port: held.port });
  // The pid is live: the listener holding the port is this test process.
  const text = JSON.stringify([{ poolDir: join(world.root, "gone"), port: held.port, pid: process.pid, startedAt: "t" }]);
  const registry = seedGraphs(world, "pools.json", text);
  const refused = await rig.launch(world).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(busyPin(held.port));
  expect(readFileSync(registry, "utf8")).toBe(text);
});

// engine/fleet.test.ts:224
serverCase("fleet registry prune-on-read › a busy pin whose holder is live with its pool directory in place is named, pool and pid", async (t, rig) => {
  const held = rig.holdPort();
  const world = doneWorld(t, { ...CONFIG, port: held.port });
  const holderPool = join(world.root, "holder-pool");
  mkdirSync(holderPool);
  seedGraphs(world, "pools.json", JSON.stringify([{ poolDir: holderPool, port: held.port, pid: process.pid, startedAt: "t" }]));
  const refused = await rig.launch(world).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(
    `port ${held.port} is already in use by pool ${holderPool} (pid ${process.pid}); free it or pass a different --port\n`,
  );
});

// ---------------------------------------------------------------------------
// readFleetEntry: naming the port of a live pool lock's holder
// ---------------------------------------------------------------------------

// engine/fleet.test.ts:236
serverCase("fleet registry readFleetEntry › a live pool lock with no registry is refused naming the pid and no port", async (t, rig) => {
  const world = doneWorld(t);
  const holder = rig.livePid();
  writeLock(world.pool, `${holder}\n`);
  const refused = await rig.launch(world, ["--port", "0"]).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(lockedBy(world.pool, holder));
  expect(readLock(world.pool)).toBe(`${holder}\n`);
});

// engine/fleet.test.ts:241
serverCase("fleet registry readFleetEntry › a live pool lock with a registry that is not JSON is refused naming the pid and no port", async (t, rig) => {
  const world = doneWorld(t);
  const holder = rig.livePid();
  writeLock(world.pool, `${holder}\n`);
  seedGraphs(world, "pools.json", "{ not json");
  const refused = await rig.launch(world, ["--port", "0"]).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(lockedBy(world.pool, holder));
});

// engine/fleet.test.ts:247
serverCase("fleet registry readFleetEntry › a live pool lock whose holder the registry lists only for another pool is refused naming no port", async (t, rig) => {
  const world = doneWorld(t);
  const holder = rig.livePid();
  writeLock(world.pool, `${holder}\n`);
  // The same live pid, registered for another pool that exists: a match
  // needs this pool and that pid both.
  const other = join(world.root, "other-pool");
  mkdirSync(other);
  seedGraphs(world, "pools.json", JSON.stringify([{ poolDir: other, port: 8788, pid: holder, startedAt: "t" }]));
  const refused = await rig.launch(world, ["--port", "0"]).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(lockedBy(world.pool, holder));
});

// engine/fleet.test.ts:263
serverCase("fleet registry readFleetEntry › a second server on a live pool is refused naming the first's pid and port from the registry", async (t, rig) => {
  const world = doneWorld(t);
  const first = rig.launch(world, ["--port", "0"]);
  const port = await first.booted();
  const refused = await rig.launch(world, ["--port", "0"]).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(lockedBy(world.pool, first.pid, port));
  // The first server keeps the pool, its lock and its one entry.
  expect(readLock(world.pool)).toBe(`${first.pid}\n`);
  expect(registryEntries(world)?.map((entry) => [entry.poolDir, entry.port, entry.pid])).toEqual([
    [world.pool, port, first.pid],
  ]);
  expect((await fetch(`http://localhost:${port}/api/state`)).status).toBe(200);
  await first.stop();
});

// engine/fleet.test.ts:273
serverCase("fleet registry readFleetEntry › a live pool lock is refused naming no port when the registry's entry for the pool has a dead pid", async (t, rig) => {
  const world = doneWorld(t);
  const holder = rig.livePid();
  writeLock(world.pool, `${holder}\n`);
  // Left by a crashed server on 8787: its pid is not the live holder's.
  seedGraphs(world, "pools.json", JSON.stringify([{ poolDir: world.pool, port: 8787, pid: await rig.deadPid(), startedAt: "t" }]));
  const refused = await rig.launch(world, ["--port", "0"]).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(lockedBy(world.pool, holder));
});
