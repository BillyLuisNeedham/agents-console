/**
 * Startup, seen from outside the server (the inventory's ticket C03): the
 * boot line a server prints once it serves, the line Boot reads its port
 * back from, and what a start that is refused partway leaves on disk.
 *
 * The Bun server takes the pool lock before it loads the pool and resolves
 * the port, binds and registers itself in the fleet registry before its
 * drive's first load, and releases the lock only on an orderly stop or a
 * failed bind. So a start refused at either load, or over its port, leaves
 * runs/server.pid naming its own pid, now dead; the next start takes that
 * stale lock over. The cases pin that as the Bun server does it, and
 * NOT-PORTED.md's `server` section says why it looks wrong.
 */

import { expect } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bootLine,
  CONFIG,
  doneWorld,
  entryFor,
  linesOf,
  readLock,
  registryEntries,
  serverCase,
} from "./server-support.ts";

// The gap at engine/server.ts:2797.
serverCase("the boot line › once it serves, stdout's one line is pool server on http://localhost:<port> (<pool>), naming the port it bound", async (t, rig) => {
  const world = doneWorld(t);
  const server = rig.launch(world, ["--port", "0"]);
  const port = await server.booted();
  expect(linesOf(server.stdout())).toEqual([bootLine(port, world.pool)]);
  expect((await fetch(`http://localhost:${port}/api/state`)).status).toBe(200);
  // The pool settling at its Review prints nothing more there; the stop
  // says why it goes.
  await server.stop();
  expect(linesOf(server.stdout())).toEqual([bootLine(port, world.pool), "SIGTERM: stopping attempts, then exiting"]);
  expect(server.stderr()).toBe("");
});

// The gap NOT-PORTED.md's `conversations` section names (conversations.test.ts:727,
// pool.test.ts:206), and engine/server.ts:1686-1690's port check after the lock.
serverCase("a refused start › refused at pool load or over its port, it exits 1 leaving runs/server.pid naming its own pid, and the next start takes that over", async (t, rig) => {
  const world = doneWorld(t);

  // A Ticket file the pool cannot load.
  const draft = join(world.pool, "issues", "02-draft.md");
  writeFileSync(draft, "# a draft with no state line\n");
  const atLoad = rig.launch(world, ["--port", "0"]);
  const loadRefusal = await atLoad.refused();
  expect(loadRefusal.code).toBe(1);
  expect(loadRefusal.stderr).toContain(draft);
  expect(loadRefusal.stderr).toContain("has no line-1 state marker");
  expect(readLock(world.pool)).toBe(`${atLoad.pid}\n`);
  rmSync(draft);

  // A --port out of range, then a console.json port out of range: each
  // takes the dead pid's lock over, then leaves its own.
  const flag = rig.launch(world, ["--port", "70000"]);
  expect((await flag.refused()).code).toBe(1);
  expect(readLock(world.pool)).toBe(`${flag.pid}\n`);
  writeFileSync(join(world.pool, "console.json"), JSON.stringify({ ...CONFIG, port: 70000 }, null, 2));
  const pin = rig.launch(world);
  expect((await pin.refused()).code).toBe(1);
  expect(readLock(world.pool)).toBe(`${pin.pid}\n`);
  writeFileSync(join(world.pool, "console.json"), JSON.stringify(CONFIG, null, 2));

  // None of them bound, so none registered.
  expect(registryEntries(world)).toBeNull();

  const next = rig.launch(world, ["--port", "0"]);
  const port = await next.booted();
  expect(readLock(world.pool)).toBe(`${next.pid}\n`);
  expect(registryEntries(world)?.map((entry) => [entry.poolDir, entry.port, entry.pid])).toEqual([
    [world.pool, port, next.pid],
  ]);
  await next.stop();
}, { timeoutMs: 120_000 });

// Inventory open question 5's first suspected bug: an Assignment the drive
// refuses at its first load surfaces after the bind and the registration.
serverCase("a refused start › refused by the drive's first load, past the bind, it exits 1 with no boot line, leaving runs/server.pid and its registry entry", async (t, rig) => {
  const world = doneWorld(t, { ...CONFIG, assign: { "01": { verify: 0 } } });
  const server = rig.launch(world, ["--port", "0"]);
  const refused = await server.refused();
  expect(refused.code).toBe(1);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("pool config: ticket 01 has invalid verify 0 (must be an integer >= 1)");
  expect(readLock(world.pool)).toBe(`${server.pid}\n`);
  // It had bound a port the system assigned, and registered it.
  const [left] = registryEntries(world) ?? [];
  expect(left).toEqual(entryFor(world.pool, left?.port ?? -1, server.pid));
  expect(left!.port).toBeGreaterThan(0);

  // Mended, the pool boots: the stale lock is taken over and the entry replaced.
  writeFileSync(join(world.pool, "console.json"), JSON.stringify(CONFIG, null, 2));
  const next = rig.launch(world, ["--port", "0"]);
  const port = await next.booted();
  expect(readLock(world.pool)).toBe(`${next.pid}\n`);
  expect(registryEntries(world)?.map((entry) => [entry.poolDir, entry.port, entry.pid])).toEqual([
    [world.pool, port, next.pid],
  ]);
  await next.stop();
});
