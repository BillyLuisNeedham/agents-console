/**
 * Config reload (ADR-0018), seen from outside the server (ADR-0036): an edit
 * to console.json made while a pool runs reaches the Tickets that have not
 * launched yet at the next super-step boundary, all of it or none of it,
 * and never moves an Attempt already in flight or a boot-only key. Each
 * case holds a stub open (the edit lands while it runs) and edits the file
 * as a person or an agent would.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../engine/wire.ts";
import { conformance } from "../harness/case.ts";
import { readEvents, readStateLine } from "../harness/pool-files.ts";
import {
  approveReview,
  conversationRecord,
  flagValue,
  hasTicketFile,
  holdFile,
  launchesOf,
  logLines,
  refusedAtLoad,
  release,
  snapshotOf,
  ticket,
  ticketOf,
  untilLaunched,
  untilSnapshot,
  writeConfig,
} from "./config-support.ts";

const ON_A: PoolConfig = { defaults: { harness: "claude", model: "model-a" } };
const ON_B: PoolConfig = { defaults: { harness: "claude", model: "model-b" } };

/** The model a key's first launch ran on. */
function modelOf(world: Parameters<typeof launchesOf>[0], key: string, n = 0): string | undefined {
  return flagValue(launchesOf(world, key)[n]!.argv, "--model");
}

/** A Ticket's reassigned events, payload only. */
function reassigned(pool: string, id: string): unknown[] {
  return readEvents(pool, id)
    .filter((event) => event.kind === "reassigned")
    .map((event) => event.payload);
}

const A_TO_B = {
  from: { harness: "claude", model: "model-a", drivers: "implement" },
  to: { harness: "claude", model: "model-b", drivers: "implement" },
};

conformance("config", "a reload reaches a Ticket spawned by a Conversation, which keeps inheriting the Conversation", async (t) => {
  const world = t.world({
    tickets: [
      ticket("01"),
      ticket("02", { blockedBy: ["01"] }),
      ticket("conv-1-spawn-1", { blockedBy: ["01"], spawnedBy: "conv-1" }),
    ],
    config: ON_A,
    poolFiles: conversationRecord("conv-1", { harness: "claude", model: "conv-model", effort: "low" }),
  });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, ON_B);
  release(world, "01");
  const done = await approveReview(server);

  expect(done.state.log).toContain("config reloaded: defaults");
  expect(logLines(done, "config reload rejected")).toEqual([]);
  expect(modelOf(world, "02")).toBe("model-b");
  expect(modelOf(world, "conv-1-spawn-1")).toBe("conv-model");
  expect(flagValue(launchesOf(world, "conv-1-spawn-1")[0]!.argv, "--effort")).toBe("low");
  const conversation = done.state.conversations.find((c) => c.id === "conv-1")!;
  expect(conversation.assignment).toMatchObject({ harness: "claude", model: "conv-model" });
});

conformance("config", "an edit between super-steps reassigns a Ticket that has not run, with a reassigned event on its log", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: ON_A });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, ON_B);
  release(world, "01");
  const done = await approveReview(server);

  expect(modelOf(world, "01")).toBe("model-a");
  expect(modelOf(world, "02")).toBe("model-b");
  expect(done.state.log).toContain("config reloaded: defaults");
  expect(reassigned(world.pool, "02")).toEqual([A_TO_B]);
  // 01 was not in flight at the boundary either, so it re-resolves too.
  expect(reassigned(world.pool, "01")).toEqual([A_TO_B]);
});

conformance("config", "a Console Reassign of a waiting Ticket is picked up at the next boundary", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: ON_A });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  const answer = await server.http.put("/api/reassign", { tickets: ["02"], fields: { model: "model-b", verify: null } });
  expect(answer.status).toBe(200);
  release(world, "01");
  await approveReview(server);

  expect(modelOf(world, "02")).toBe("model-b");
  expect(reassigned(world.pool, "02")).toEqual([A_TO_B]);
});

conformance("config", "an Attempt keeps the Assignment it launched on through an edit, and the next one takes the new config", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: ON_A });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  await untilSnapshot(server, (s) => s.state.interrupts.some((i) => i.ticketId === "01"), "01's checkpoint");
  writeConfig(world, ON_B);
  expect((await server.http.post("/api/resume", { ticketId: "01" })).status).toBe(202);
  await approveReview(server);

  expect(launchesOf(world, "01")).toHaveLength(2);
  expect([modelOf(world, "01", 0), modelOf(world, "01", 1)]).toEqual(["model-a", "model-b"]);
  expect(reassigned(world.pool, "01")).toEqual([A_TO_B]);
});

conformance("config", "an edit made after a Spawn is adopted, before it is ready to run, is the one it launches on", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: ON_A });
  world.stubs.script("01", {
    spawn: [{ title: "Follow-up", body: "Do some more follow-up work here.", blockedBy: ["02"] }],
  });
  world.stubs.script("02", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  await untilSnapshot(
    server,
    (s) => s.phase === "quiescent" && s.state.interrupts.some((i) => i.ticketId === "02"),
    "the pool to pause on 02's checkpoint",
  );
  expect(readStateLine(world.pool, "01-spawn-1.md").status).toBe("ready");
  expect(launchesOf(world, "01-spawn-1")).toEqual([]);
  writeConfig(world, ON_B);
  expect((await server.http.post("/api/resume", { ticketId: "02" })).status).toBe(202);
  await approveReview(server);

  expect(modelOf(world, "01-spawn-1")).toBe("model-b");
});

conformance("config", "console.json that will not parse is rejected, the old config kept, and the cause logged once across boundaries", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] }), ticket("03", { blockedBy: ["02"] })],
    config: ON_A,
  });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, "{ not json");
  release(world, "01");
  const done = await approveReview(server);

  expect([modelOf(world, "02"), modelOf(world, "03")]).toEqual(["model-a", "model-a"]);
  expect(logLines(done, "config reload rejected")).toHaveLength(1);
});

conformance("config", "an edit with one assign entry naming an unknown harness is rejected whole, its valid parts too", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: ON_A });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, { ...ON_B, assign: { "02": { harness: "no-such-harness" } } });
  release(world, "01");
  const done = await approveReview(server);

  expect(modelOf(world, "02")).toBe("model-a");
  expect(logLines(done, "config reload rejected")).toHaveLength(1);
  expect(reassigned(world.pool, "02")).toEqual([]);
});

conformance("config", "port, terminal and selection never move under a live run, whatever console.json says", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })],
    config: { ...ON_A, port: 4100, selection: "auto" },
  });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, { ...ON_B, port: 9999, terminal: "herdr", selection: "human" });
  release(world, "01");
  const done = await approveReview(server);

  expect(modelOf(world, "02")).toBe("model-b");
  expect(done.state.config.port).toBe(4100);
  expect(done.state.config).not.toHaveProperty("terminal");
  expect(done.state.config.selection).toBe("auto");
  // Headless: 02 ran as claude's batch argv straight from the server, no pane.
  expect(launchesOf(world, "02")[0]!.argv[0]).toBe("-p");
});

conformance("config", "console.json rewritten unchanged is no reload: no log line and no reassigned event", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: ON_A });
  const bytes = readFileSync(join(world.pool, "console.json"));
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, bytes.toString("utf8"));
  release(world, "01");
  const done = await approveReview(server);

  expect(logLines(done, "config reloaded")).toEqual([]);
  expect(logLines(done, "config reload rejected")).toEqual([]);
  expect(reassigned(world.pool, "02")).toEqual([]);
});

conformance("config", "the Spawn caps reload at the boundary, into the proposals taken after it and the next prompt", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: ON_A });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  world.stubs.script("02", {
    spawn: [1, 2, 3].map((n) => ({ title: `N${n}`, body: "A body long enough to stand." })),
  });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, { ...ON_A, spawnCaps: { perAttempt: 1, perRun: 7 } });
  release(world, "01");
  const done = await approveReview(server);

  expect(done.state.log).toContain("config reloaded: spawnCaps");
  expect(hasTicketFile(world, "02-spawn-1.md")).toBe(true);
  expect(hasTicketFile(world, "02-spawn-2.md")).toBe(false);
  expect(done.heldSpawns.map((held) => held.reason)).toEqual(["per-attempt", "per-attempt"]);
  const promptOf = (key: string) => flagValue(launchesOf(world, key)[0]!.argv, "-p")!;
  expect(promptOf("01")).toContain("5 proposals honored per attempt and 20 per run");
  expect(promptOf("02")).toContain("1 proposal honored per attempt and 7 per run");
});

conformance("config", "a reload whose Spawn cap is not a whole number of 0 or more is rejected, the caps kept", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })],
    config: { ...ON_A, spawnCaps: { perRun: 9 } },
  });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, { ...ON_A, spawnCaps: { perRun: -1 } });
  release(world, "01");
  const done = await approveReview(server);

  expect(done.state.log).toContain(
    "config reload rejected: pool config: spawnCaps.perRun must be a whole number, 0 or more",
  );
  expect(done.spawnUsage.perRun).toBe(9);
});

conformance("config", "a Pool settings save reloads at once when no drive is in flight", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: ON_A });
  const server = await t.start(world);
  await untilSnapshot(
    server,
    (s) => s.phase === "quiescent" && s.state.interrupts.some((i) => i.ticketId === "REVIEW"),
    "the pool to settle at Review",
  );
  const answer = await server.http.put("/api/settings/pool", { config: { spawnCaps: { perRun: 30 } } });
  expect(answer.status).toBe(200);
  const snapshot = await snapshotOf(server);

  expect(snapshot.state.log).toContain("config reloaded: spawnCaps");
  expect(snapshot.spawnUsage).toEqual({ spawnedThisRun: 0, perAttempt: 5, perRun: 30 });
});

conformance("config", "the operator's assign entry for a spawned child beats the proposal's request, field by field", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: { defaults: { harness: "claude", model: "stub-model" }, assign: { "01-spawn-1": { effort: "medium" } } },
  });
  world.stubs.script("01", {
    spawn: [{ title: "Harder", body: "A body long enough to stand.", assign: { model: "child-model", effort: "max" } }],
  });
  const server = await t.start(world);
  const done = await approveReview(server);

  const [child] = launchesOf(world, "01-spawn-1");
  expect([flagValue(child!.argv, "--model"), flagValue(child!.argv, "--effort")]).toEqual(["child-model", "medium"]);
  expect(ticketOf(done, "01-spawn-1").assignment).toMatchObject({ model: "child-model", effort: "medium" });
});

conformance("config", "a spawned Ticket is served the Assignment it inherits from its parent, its own entry over it", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("01-spawn-1", { spawnedBy: "01" })],
    config: {
      assign: {
        "01": { harness: "claude", model: "parent-model" },
        "01-spawn-1": { drivers: "implement code-review" },
      },
    },
  });
  const server = await t.start(world);
  const done = await approveReview(server);

  expect(ticketOf(done, "01").assignment).toEqual({ harness: "claude", model: "parent-model", drivers: "implement" });
  expect(ticketOf(done, "01-spawn-1").assignment).toEqual({
    harness: "claude",
    model: "parent-model",
    drivers: "implement code-review",
  });
});

conformance("config", "the Steward entry reloads at the boundary, and an unknown Steward harness rejects the reload whole", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] }), ticket("03", { blockedBy: ["02"] })],
    config: ON_A,
  });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  world.stubs.script("02", { waitFor: holdFile(world, "02") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, { ...ON_A, steward: { budget: 2, assign: { harness: "nope" } } });
  release(world, "01");
  await untilLaunched(world, "02");
  const rejected = await snapshotOf(server);
  expect(logLines(rejected, "config reload rejected")).toEqual([
    "config reload rejected: pool config: steward.assign names unknown harness 'nope'. Known: claude, cursor, opencode",
  ]);
  expect(rejected.stewardBudget?.budget).toBe(5);

  writeConfig(world, { ...ON_A, steward: { budget: 2 } });
  release(world, "02");
  const done = await approveReview(server);
  expect(done.state.log).toContain("config reloaded: steward");
  expect(done.stewardBudget?.budget).toBe(2);
});

// Visible behaviour no engine test covered (the inventory's `config` gaps).

conformance("config", "an edit that changes only a boot-only key is no reload: the slice compares by value, not by file text", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: ON_A });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, { ...ON_A, port: 4321 });
  release(world, "01");
  const done = await approveReview(server);

  expect(logLines(done, "config reload")).toEqual([]);
  expect(reassigned(world.pool, "02")).toEqual([]);
});

conformance("config", "the reload's log line names the changed keys in slice order, whatever order the edit made them in", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: ON_A });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  // assign written ahead of defaults in the file.
  writeConfig(world, JSON.stringify({ assign: { "02": { effort: "low" } }, defaults: ON_B.defaults }));
  release(world, "01");
  const done = await approveReview(server);

  expect(logLines(done, "config reload")).toEqual(["config reloaded: defaults, assign"]);
  expect(modelOf(world, "02")).toBe("model-b");
});

conformance("config", "a Reassign of a Ticket at its checkpoint reaches the relaunch its resume makes", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: { defaults: { harness: "claude", model: "m" } } });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  await untilSnapshot(
    server,
    (s) => s.phase === "quiescent" && s.state.interrupts.some((i) => i.ticketId === "01"),
    "01's checkpoint",
  );
  expect((await server.http.put("/api/reassign", { tickets: ["01"], fields: { model: "opus" } })).status).toBe(200);
  expect((await server.http.post("/api/resume", { ticketId: "01" })).status).toBe(202);
  await approveReview(server);

  expect(launchesOf(world, "01").map((call) => flagValue(call.argv, "--model"))).toEqual(["m", "opus"]);
  const kinds = readEvents(world.pool, "01").map((event) => event.kind);
  const spawnedAgain = kinds.lastIndexOf("spawned");
  expect(kinds.indexOf("reassigned")).toBeGreaterThan(kinds.indexOf("spawned"));
  expect(kinds.indexOf("reassigned")).toBeLessThan(spawnedAgain);
  expect(reassigned(world.pool, "01")).toEqual([
    {
      from: { harness: "claude", model: "m", drivers: "implement" },
      to: { harness: "claude", model: "opus", drivers: "implement" },
    },
  ]);
});

conformance("config", "a Spawn cap per attempt that is not a whole number of 0 or more stops the pool at load, and is rejected whole mid-run", async (t) => {
  for (const perAttempt of [-1, 1.5]) {
    const world = t.world({ tickets: [ticket("01")], config: { ...ON_A, spawnCaps: { perAttempt } } });
    const { code, output } = await refusedAtLoad(world);
    expect([perAttempt, code === 0]).toEqual([perAttempt, false]);
    expect(output).toContain("pool config: spawnCaps.perAttempt must be a whole number, 0 or more");
  }

  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] }), ticket("03", { blockedBy: ["02"] })],
    config: { ...ON_A, spawnCaps: { perAttempt: 2 } },
  });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, { ...ON_B, spawnCaps: { perAttempt: 1.5 } });
  release(world, "01");
  const done = await approveReview(server);

  expect(logLines(done, "config reload")).toEqual([
    "config reload rejected: pool config: spawnCaps.perAttempt must be a whole number, 0 or more",
  ]);
  expect(done.spawnUsage.perAttempt).toBe(2);
  expect([modelOf(world, "02"), modelOf(world, "03")]).toEqual(["model-a", "model-a"]);
});
