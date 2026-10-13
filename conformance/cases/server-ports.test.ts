/**
 * Where the server binds (the inventory's ticket C03, from
 * engine/ports.test.ts): the --port flag first, then the console.json pin,
 * then the default 8787 or the next free port above it. A pinned port binds
 * exactly or the server refuses, naming it; port 0 is any free port the
 * system assigns and never a pin; a port that is not an integer in 0-65535
 * is refused before anything binds. Every server here is launched by hand,
 * so a case passes exactly the port arguments it means to.
 *
 * Every world has its own HOME, so the fleet registry a refusal reads to
 * name a port's holder is the world's own: a port held by anything outside
 * the case reads as held by no known pool.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { freePort, portTaken } from "../harness/server.ts";
import {
  bootLine,
  CONFIG,
  DEFAULT_PORT,
  doneWorld,
  linesOf,
  registryEntries,
  serverCase,
  twoFreePorts,
  type Rig,
} from "./server-support.ts";

/** The refusal a pinned port that is busy gets when the registry names no live holder. */
function busyPin(port: number): string {
  return `port ${port} is already in use; free it or pass a different --port\n`;
}

/**
 * The range the system assigns a port 0 from, or null where it cannot be
 * read: what tells "any free port" from a hunt upward from 8787.
 */
function ephemeralRange(): [number, number] | null {
  try {
    const [low, high] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
    if (Number.isInteger(low) && Number.isInteger(high)) return [low!, high!];
  } catch {
    // Not Linux.
  }
  const sysctl = Bun.spawnSync(["sysctl", "-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [low, high] = sysctl.stdout.toString().trim().split(/\s+/).map(Number);
  return sysctl.exitCode === 0 && Number.isInteger(low) && Number.isInteger(high) ? [low!, high!] : null;
}

/**
 * Whether a bound port lies in the range the system assigns port 0 from,
 * which a hunt from 8787 never reaches; null where the range cannot be read.
 */
function inEphemeralRange(port: number): boolean | null {
  const range = ephemeralRange();
  return range === null ? null : port >= range[0] && port <= range[1];
}

/**
 * Hold a port a server under test has just let go of. Its listener is gone
 * once the server exits, but the bind is retried for a moment in case the
 * system has not let the address go yet.
 */
async function holdFreed(rig: Rig, port: number): Promise<{ port: number; release(): void }> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return rig.holdPort(port);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await Bun.sleep(100);
    }
  }
}

// ---------------------------------------------------------------------------
// Port resolution order
// ---------------------------------------------------------------------------

// engine/ports.test.ts:7
serverCase("port resolution order › the --port flag wins over the console.json pin, as the boot line and the registry entry show", async (t, rig) => {
  const [pin, flag] = await twoFreePorts();
  const world = doneWorld(t, { ...CONFIG, port: pin });
  const server = rig.launch(world, ["--port", String(flag)]);
  expect(await server.booted()).toBe(flag);
  expect(linesOf(server.stdout())[0]).toBe(bootLine(flag, world.pool));
  expect(registryEntries(world)?.map((entry) => [entry.poolDir, entry.port, entry.pid])).toEqual([
    [world.pool, flag, server.pid],
  ]);
  await server.stop();
});

// engine/ports.test.ts:11
serverCase("port resolution order › the console.json pin wins over the default, and a busy pin refuses, naming the port, rather than hunting", async (t, rig) => {
  const port = await freePort();
  const world = doneWorld(t, { ...CONFIG, port });
  const first = rig.launch(world);
  expect(await first.booted()).toBe(port);
  await first.stop();

  // The same pin held by a plain listener: no hunt to the next port, a
  // refusal. The stopped server's entry is still in the registry, with a
  // dead pid, so it names no holder.
  await holdFreed(rig, port);
  const refused = await rig.launch(world).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(busyPin(port));
  expect(refused.stdout).toBe("");
});

// engine/ports.test.ts:15, the half with 8787 busy; the half with it free is
// server-lifecycle.test.ts's case for engine/server.test.ts:2466.
serverCase("port resolution order › with neither pin and 8787 busy, it hunts upward from 8787 rather than failing or taking any free port", async (t, rig) => {
  try {
    rig.holdPort(DEFAULT_PORT);
  } catch {
    // Something else on the machine holds it, which serves as well.
  }
  const world = doneWorld(t);
  const server = rig.launch(world);
  const port = await server.booted();
  // Above 8787, and not a port the system hands out for port 0. (Which
  // port above it cannot be pinned on a shared machine: other servers come
  // and go on the ports just above 8787.)
  expect(port).toBeGreaterThan(DEFAULT_PORT);
  expect(inEphemeralRange(port) ?? false).toBe(false);
  expect(linesOf(server.stdout())[0]).toBe(bootLine(port, world.pool));
  expect(registryEntries(world)?.map((entry) => entry.port)).toEqual([port]);
  await server.stop();
});

// engine/ports.test.ts:30
serverCase("port resolution order › port 0 means any free port the system assigns, from the flag or from console.json, and is never a pin", async (t, rig) => {
  for (const from of ["--port 0", "console.json port 0"] as const) {
    const world = doneWorld(t, from === "--port 0" ? CONFIG : { ...CONFIG, port: 0 });
    const server = rig.launch(world, from === "--port 0" ? ["--port", "0"] : []);
    const port = await server.booted();
    expect([from, inEphemeralRange(port) ?? true]).toEqual([from, true]);
    expect([from, linesOf(server.stdout())[0]]).toEqual([from, bootLine(port, world.pool)]);
    expect([from, registryEntries(world)?.map((entry) => entry.port)]).toEqual([from, [port]]);
    await server.stop();
  }
});

// engine/ports.test.ts:35
serverCase("port resolution order › --port 0 wins over a console.json pin even when that pinned port is busy", async (t, rig) => {
  const held = rig.holdPort();
  const world = doneWorld(t, { ...CONFIG, port: held.port });
  const server = rig.launch(world, ["--port", "0"]);
  const port = await server.booted();
  expect(port).not.toBe(held.port);
  expect(inEphemeralRange(port) ?? true).toBe(true);
  await server.stop();
});

// engine/ports.test.ts:39
serverCase("port resolution order › --port 8787 is a pin like any other: busy, it refuses rather than hunting to 8788", async (t, rig) => {
  try {
    rig.holdPort(DEFAULT_PORT);
  } catch {
    // Something else on the machine holds it, which serves as well.
  }
  const world = doneWorld(t);
  const refused = await rig.launch(world, ["--port", String(DEFAULT_PORT)]).refused();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(busyPin(DEFAULT_PORT));
  expect(registryEntries(world)).toBeNull();
});

// ---------------------------------------------------------------------------
// Port validation
// ---------------------------------------------------------------------------

// engine/ports.test.ts:45
serverCase("port validation › accepts an integer in 0-65535: a console.json pin of 65535 binds it, and --port 0 binds", async (t, rig) => {
  if (await portTaken(65535)) {
    console.warn("port 65535 is busy on this machine: the 65535 half of the port validation case did not run");
  } else {
    const top = doneWorld(t, { ...CONFIG, port: 65535 });
    const server = rig.launch(top);
    expect(await server.booted()).toBe(65535);
    expect(linesOf(server.stdout())[0]).toBe(bootLine(65535, top.pool));
    await server.stop();
  }
  const zero = doneWorld(t);
  const server = rig.launch(zero, ["--port", "0"]);
  const port = await server.booted();
  expect(linesOf(server.stdout())[0]).toBe(bootLine(port, zero.pool));
  await server.stop();
});

// engine/ports.test.ts:50
// The gap at engine/server.ts:1686-1690 (--port 70000) is the last value.
serverCase("port validation › refuses a --port that is not an integer in 0-65535, naming the value, and registers nothing", async (t, rig) => {
  // The value as given, and as the refusal names it: a word is not a number.
  const values: [string, string][] = [
    ["-1", "-1"],
    ["65536", "65536"],
    ["1.5", "1.5"],
    ["abc", "NaN"],
    ["Infinity", "Infinity"],
    ["70000", "70000"],
  ];
  for (const [given, named] of values) {
    const world = doneWorld(t);
    const refused = await rig.launch(world, ["--port", given]).refused();
    expect([given, refused.code, refused.stdout, refused.stderr]).toEqual([
      given,
      1,
      "",
      `--port: port must be an integer 0-65535, got ${named}\n`,
    ]);
    expect([given, registryEntries(world)]).toEqual([given, null]);
  }
}, { timeoutMs: 120_000 });

serverCase("port validation › refuses a console.json port that is not an integer in 0-65535, naming console.json and the value", async (t, rig) => {
  for (const port of [70000, -1, 1.5]) {
    const world = doneWorld(t, { ...CONFIG, port });
    const refused = await rig.launch(world).refused();
    expect([port, refused.code, refused.stdout, refused.stderr]).toEqual([
      port,
      1,
      "",
      `console.json: port must be an integer 0-65535, got ${port}\n`,
    ]);
    expect([port, registryEntries(world)]).toEqual([port, null]);
  }
}, { timeoutMs: 120_000 });
