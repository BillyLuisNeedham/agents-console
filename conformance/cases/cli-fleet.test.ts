/**
 * The fleet list command (the inventory's `cli` rows from fleet-cli.test.ts),
 * run as a process over a registry file: one line per live pool, the dead
 * and the deleted pruned from what it prints and never from the file.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { cliWorld } from "../harness/cli.ts";

function entry(poolDir: string, port: number, pid: number): Record<string, unknown> {
  return { poolDir, port, pid, startedAt: "2026-10-03T00:00:00.000Z" };
}

conformance("cli", "fleet lists every live pool as poolDir → http://localhost:<port>, one per line, in registry order", async (t) => {
  const w = cliWorld(t);
  const live = w.liveProcess().pid;
  const a = w.dir("pool-a");
  const b = w.dir("pool-b");
  const registry = w.write("pools.json", JSON.stringify([entry(a, 8787, live), entry(b, 8799, live)]));
  const run = await w.run("fleet", ["--registry", registry]);
  expect(run.code).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.stdout).toBe(`${a} → http://localhost:8787\n${b} → http://localhost:8799\n`);
});

conformance("cli", "fleet prunes dead-pid and missing-poolDir entries from what it prints", async (t) => {
  const w = cliWorld(t);
  const live = w.liveProcess().pid;
  const alive = w.dir("alive");
  const dead = w.dir("dead");
  const registry = w.write(
    "pools.json",
    JSON.stringify([entry(alive, 8787, live), entry(dead, 8788, w.deadPid()), entry(w.path("gone"), 8789, live)]),
  );
  const run = await w.run("fleet", ["--registry", registry]);
  expect(run.code).toBe(0);
  expect(run.stdout).toBe(`${alive} → http://localhost:8787\n`);
});

conformance("cli", "fleet prints no live consoles for an absent registry", async (t) => {
  const w = cliWorld(t);
  const run = await w.run("fleet", ["--registry", w.path("no-such.json")]);
  expect(run.code).toBe(0);
  expect(run.stdout).toBe("no live consoles\n");
});

conformance("cli", "fleet prints no live consoles for an empty registry", async (t) => {
  const w = cliWorld(t);
  const registry = w.write("pools.json", "[]");
  const run = await w.run("fleet", ["--registry", registry]);
  expect(run.code).toBe(0);
  expect(run.stdout).toBe("no live consoles\n");
});

conformance("cli", "fleet prints no live consoles when every entry is pruned", async (t) => {
  const w = cliWorld(t);
  const registry = w.write("pools.json", JSON.stringify([entry(w.dir("dead"), 8787, w.deadPid())]));
  const run = await w.run("fleet", ["--registry", registry]);
  expect(run.code).toBe(0);
  expect(run.stdout).toBe("no live consoles\n");
});

conformance("cli", "fleet never rewrites the registry it reads", async (t) => {
  const w = cliWorld(t);
  const registry = w.write(
    "pools.json",
    JSON.stringify([entry(w.dir("alive"), 8787, w.liveProcess().pid), entry(w.dir("dead"), 8788, w.deadPid())]),
  );
  const before = readFileSync(registry);
  const run = await w.run("fleet", ["--registry", registry]);
  expect(run.code).toBe(0);
  expect(readFileSync(registry).equals(before)).toBe(true);
});

conformance("cli", "fleet reads the registry under HOME when given none", async (t) => {
  const w = cliWorld(t);
  const pool = w.dir("pool");
  w.write(join("home", ".agent-graphs", "pools.json"), JSON.stringify([entry(pool, 8790, w.liveProcess().pid)]));
  const run = await w.run("fleet", []);
  expect(run.code).toBe(0);
  expect(run.stdout).toBe(`${pool} → http://localhost:8790\n`);
});
