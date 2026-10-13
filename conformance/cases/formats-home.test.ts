/**
 * The files outside a Ticket's own (the inventory's ticket C01, area
 * `formats`): the fleet registry and the Machine defaults under HOME's
 * .agent-graphs/, the retired console.json keys a save drops, and the
 * queued-answer store beside the checkpoints. JSON is compared once parsed
 * (ADR-0036). Every world has its own HOME, so nothing here touches the
 * operator's files.
 *
 * Each case names the inventory rows it covers (docs/research/rust-port/
 * test-inventory.md, area `formats`) as `file:line` of the engine test it
 * came from.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { anyIsoTime, expectParsedEqual } from "../harness/equal.ts";
import { readCheckpoints, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import { ticket, untilStatus } from "./formats-helpers.ts";

const DEFAULTS = { defaults: { harness: "claude", model: "m" } };

function agentGraphs(world: World, file: string): string {
  return join(world.home, ".agent-graphs", file);
}

function seedHome(world: World, file: string, content: string): void {
  mkdirSync(join(world.home, ".agent-graphs"), { recursive: true });
  writeFileSync(agentGraphs(world, file), content);
}

// ---------------------------------------------------------------------------
// The fleet registry.
// ---------------------------------------------------------------------------

// fleet.test.ts:50 fleet registry upsert › writes the entry shape on registration
conformance("formats", "a started server registers itself in pools.json as {poolDir, port, pid, startedAt}", async (t) => {
  const world = t.world({ tickets: [ticket("01", { status: "done" })], config: DEFAULTS });
  expect(existsSync(agentGraphs(world, "pools.json"))).toBe(false);
  const server = await t.start(world);
  expectParsedEqual(
    readFileSync(agentGraphs(world, "pools.json"), "utf8"),
    [{ poolDir: world.pool, port: server.port, pid: server.pid, startedAt: anyIsoTime() }],
    "pools.json",
  );
});

// fleet.test.ts:118 fleet registry upsert › recreates a corrupt registry file on write, not an error
// fleet.test.ts:135 fleet registry upsert › recreates a registry that is not an array on write
conformance("formats", "a pools.json that is not JSON, or not an array, is replaced by this server's entry alone", async (t) => {
  for (const corrupt of ["{ not json", JSON.stringify({ poolDir: "/elsewhere", port: 1 })]) {
    const world = t.world({ tickets: [ticket("01", { status: "done" })], config: DEFAULTS });
    seedHome(world, "pools.json", corrupt);
    const server = await t.start(world);
    expectParsedEqual(
      readFileSync(agentGraphs(world, "pools.json"), "utf8"),
      [{ poolDir: world.pool, port: server.port, pid: server.pid, startedAt: anyIsoTime() }],
      `pools.json over ${JSON.stringify(corrupt)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Machine defaults and the retired keys.
// ---------------------------------------------------------------------------

interface SettingsBody {
  pool: { config: Record<string, unknown> };
  machine: { defaults: Record<string, unknown>; own: Record<string, unknown> };
}

// machine-defaults.test.ts:62 machine defaults › reads past a retired roster and agents and drops them on write
conformance("formats", "Machine defaults read past a retired roster and agents, and a save drops them", async (t) => {
  const world = t.world({ tickets: [ticket("01", { status: "done" })], config: DEFAULTS });
  seedHome(world, "defaults.json", JSON.stringify({ harness: "claude", roster: ["a"], agents: { a: {} } }));
  const server = await t.start(world);
  const before = await server.http.get("/api/settings");
  expect(before.status, before.text).toBe(200);
  expect(before.json<SettingsBody>().machine.own).toEqual({ harness: "claude" });

  const put = await server.http.put("/api/settings/machine", {
    defaults: { harness: "claude", model: "opus", roster: ["a"], agents: { a: {} } },
  });
  expect(put.status, put.text).toBe(200);
  expectParsedEqual(readFileSync(agentGraphs(world, "defaults.json"), "utf8"), { harness: "claude", model: "opus" }, "defaults.json");
});

// machine-defaults.test.ts:75 machine defaults › treats a malformed file as absent
conformance("formats", "a defaults.json that is not JSON reads as no Machine defaults", async (t) => {
  const world = t.world({ tickets: [ticket("01", { status: "done" })], config: DEFAULTS });
  seedHome(world, "defaults.json", "{ not json");
  const server = await t.start(world);
  const answer = await server.http.get("/api/settings");
  expect(answer.status, answer.text).toBe(200);
  const machine = answer.json<SettingsBody>().machine;
  expect(machine.defaults).toEqual({});
  expect(machine.own).toEqual({});
});

// pool-settings.test.ts:282 pool settings › reads past a retired roster and agents, and drops them on the next save
conformance("formats", "Pool settings read past a retired roster and agents in console.json, and a save drops them", async (t) => {
  const world = t.world({ tickets: [ticket("01", { status: "done" })] });
  writeFileSync(
    join(world.pool, "console.json"),
    JSON.stringify({ ...DEFAULTS, roster: ["a"], agents: { a: { harness: "claude" } }, port: 8787 }, null, 2),
  );
  const server = await t.start(world);
  const before = await server.http.get("/api/settings");
  expect(before.status, before.text).toBe(200);
  const config = before.json<SettingsBody>().pool.config;
  expect(config).not.toHaveProperty("roster");
  expect(config).not.toHaveProperty("agents");
  expect(config.port).toBe(8787);

  const put = await server.http.put("/api/settings/pool", { config: { reviewer: "r" } });
  expect(put.status, put.text).toBe(200);
  expectParsedEqual(
    readFileSync(join(world.pool, "console.json"), "utf8"),
    { ...DEFAULTS, port: 8787, reviewer: "r" },
    "console.json",
  );
});

// ---------------------------------------------------------------------------
// The queued-answer store.
// ---------------------------------------------------------------------------

// engine.test.ts:13026 accept/process split › records the queued answer in its own store, separate from the PoolState checkpoints
conformance("formats", "an answer is kept in runs/queued-answers.json, never in a checkpoint, and marked processed", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: DEFAULTS });
  world.stubs.script("01", { statuses: ["checkpoint", "done"], brief: "carry on?" });
  const server = await t.start(world);
  await untilStatus(world, "01-t.md", "checkpoint");
  const answer = await server.http.post("/api/resume", { ticketId: "01", note: "proceed-with-zebra" });
  expect(answer.status, answer.text).toBe(202);
  await untilStatus(world, "01-t.md", "done");

  const path = join(world.pool, "runs", "queued-answers.json");
  const store = await until(
    () => JSON.parse(readFileSync(path, "utf8")) as { answers: { processedAt: string | null }[] },
    (file) => file.answers.every((a) => a.processedAt !== null),
    { what: "the answer to be marked processed" },
  );
  expectParsedEqual(
    store,
    {
      nextSeq: 2,
      answers: [{ seq: 1, ticketId: "01", kind: "checkpoint", note: "proceed-with-zebra", at: anyIsoTime(), processedAt: anyIsoTime() }],
    },
    "runs/queued-answers.json",
  );
  expect(existsSync(`${path}.tmp`)).toBe(false);
  const checkpoints = readCheckpoints(world.pool);
  expect(checkpoints.length).toBeGreaterThan(0);
  for (const checkpoint of checkpoints) {
    const text = JSON.stringify(checkpoint.state);
    expect(text).not.toContain("proceed-with-zebra");
    expect(text.toLowerCase()).not.toContain("queued");
  }
});
