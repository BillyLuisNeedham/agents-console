/**
 * maxLive (ADR-0040), seen from outside the server: a pool-wide bound on the
 * Ticket Attempts the engine runs at once. A launch waits while the bound is
 * reached, a verify Ticket needs room for every Candidate unless nothing is
 * live, and a resolver counts but is never withheld. Every order here is read
 * from the pool log's `start <id>` lines and the events files, never from a
 * wait.
 */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig, TicketEvent } from "../../protocol/wire.ts";
import { conformance, type Case } from "../harness/case.ts";
import { CLAUDE_READY } from "../harness/herdr.ts";
import { gitIn } from "../harness/git-pool.ts";
import { answer, settle, snapshot, statuses, ticketOf } from "../harness/pool-run.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { StubHold } from "../harness/stubs.ts";
import type { TicketSeed, World } from "../harness/world.ts";
import { copiesPlan, makingItems, pieces } from "./line-copies-support.ts";
import { begun, lineWorld } from "./line-support.ts";

const CONFIG = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;

function ticket(id: string): TicketSeed {
  return { file: `${id}-t.md`, marker: `<!-- state: id=${id} blocked-by=none status=ready -->` };
}

const launches = (world: World): string[] => world.stubs.calls().map((call) => call.key);
const reviewUp = (s: EnrichedSnapshot): boolean => s.state.interrupts.some((i) => i.ticketId === "REVIEW");

/** The Tickets the pool log says started, in order. */
function started(s: EnrichedSnapshot): string[] {
  return s.state.log.flatMap((line) => /^start (\S+)/.exec(line)?.[1] ?? []);
}

/** A Ticket's events of `kind`, at `attempt` when given. */
function eventsOf(world: World, id: string, kind: string, attempt?: number): TicketEvent[] {
  return readEvents(world.pool, id).filter((e) => e.kind === kind && (attempt === undefined || e.attempt === attempt));
}

/** When Ticket `id` was scheduled the `n`th time, from its events. */
function scheduledAt(world: World, id: string, n = 1): string {
  const scheduled = eventsOf(world, id, "scheduled")[n - 1];
  if (!scheduled) throw new Error(`${id} was never scheduled ${n} time(s)`);
  return scheduled.at;
}

function exitedAt(world: World, id: string, attempt = 1): string {
  const exited = eventsOf(world, id, "exited", attempt)[0];
  if (!exited) throw new Error(`${id} attempt ${attempt} never exited`);
  return exited.at;
}

/** Hold `key`'s launches, and let them go at the teardown if the case failed first. */
function holdStub(t: Case, world: World, key: string, behaviour?: Parameters<World["stubs"]["hold"]>[1]): StubHold {
  const held = world.stubs.hold(key, behaviour);
  let released = false;
  t.defer(async () => {
    if (!released) await held.release(2_000).catch(() => {});
  });
  return {
    async release(ms) {
      await held.release(ms);
      released = true;
    },
  };
}

function untilLaunched(world: World, keys: string[], ms = 30_000): Promise<string[]> {
  return until(() => launches(world), (seen) => keys.every((key) => seen.includes(key)), {
    what: `${keys.join(", ")} to launch`,
    ms,
  });
}

/** The Machine defaults file under the world's HOME, written before the server starts. */
function machineDefaults(world: World, defaults: Record<string, unknown>): void {
  mkdirSync(join(world.home, ".agent-graphs"), { recursive: true });
  writeFileSync(join(world.home, ".agent-graphs", "defaults.json"), JSON.stringify(defaults));
}

conformance("scheduling", "with maxLive 1 the second Ticket starts only once the first has ended", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: { ...CONFIG, maxLive: 1 } });
  const first = holdStub(t, world, "01");
  const server = await t.start(world);

  await untilLaunched(world, ["01"]);
  // Without the bound both would have started in the Tick that started 01.
  expect(started(await snapshot(server))).toEqual(["01"]);
  expect(readEvents(world.pool, "02")).toEqual([]);

  await first.release();
  const reviewed = await settle(server, reviewUp, { what: "the Review" });
  expect(statuses(reviewed)).toEqual({ "01": "done", "02": "done" });
  expect(started(reviewed)).toEqual(["01", "02"]);
  expect(scheduledAt(world, "02") >= exitedAt(world, "01")).toBe(true);
  expect(launches(world)).toEqual(["01", "02"]);
});

conformance(
  "scheduling",
  "a verify: 2 Ticket under maxLive 1 runs both Candidates alone, and nothing else starts until they have ended",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02")],
      config: { ...CONFIG, maxLive: 1, assign: { "01": { verify: 2 } } },
    });
    const one = holdStub(t, world, "01.attempt-1");
    const two = holdStub(t, world, "01.attempt-2");
    const server = await t.start(world);

    await untilLaunched(world, ["01.attempt-1", "01.attempt-2"]);
    const both = await snapshot(server);
    expect(started(both)).toEqual(["01"]);
    expect(ticketOf(both, "01").liveAttempt).not.toBeNull();
    expect(readEvents(world.pool, "02")).toEqual([]);

    await one.release();
    await until(() => eventsOf(world, "01", "exited", 1), (exited) => exited.length === 1, {
      what: "the first Candidate to exit",
      ms: 30_000,
    });
    await two.release();
    const reviewed = await settle(server, reviewUp, { what: "the Review" });
    expect(statuses(reviewed)).toMatchObject({ "01": "done", "02": "done" });
    expect(started(reviewed).filter((id) => id === "01" || id === "02")).toEqual(["01", "02"]);
    expect(scheduledAt(world, "02") >= exitedAt(world, "01", 1)).toBe(true);
    expect(scheduledAt(world, "02") >= exitedAt(world, "01", 2)).toBe(true);
  },
);

conformance(
  "scheduling",
  "a conflicted merge's resolver runs while the pool is at its maxLive, and a Ready Ticket still waits",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02"), ticket("03")],
      config: { ...CONFIG, maxLive: 2, resolver: "claude" },
      repoFiles: { "shared.txt": "base\n" },
    });
    const first = holdStub(t, world, "01", {
      run: "echo from-01 > shared.txt\ngit add -A\ngit commit -qm work-01",
    });
    const second = holdStub(t, world, "02");
    const resolver = holdStub(t, world, "01.resolver", {
      outcomeRaw: JSON.stringify({ resolved: false, note: "left for the operator" }),
    });
    const server = await t.start(world);

    await untilLaunched(world, ["01", "02"]);
    expect(started(await snapshot(server))).toEqual(["01", "02"]);
    const lowered = await server.http.put("/api/settings/pool", { config: { maxLive: 1 } });
    expect(lowered.status, lowered.text).toBe(200);
    await until(() => snapshot(server), (s) => s.state.log.includes("config reloaded: maxLive"), {
      what: "the reload of maxLive",
      ms: 30_000,
    });

    // The target moves under 01's branch by hand, so 01's merge conflicts.
    writeFileSync(join(world.repo, "shared.txt"), "from-main\n");
    gitIn(world.repo, ["commit", "-qm", "hand edit", "--", "shared.txt"]);
    await first.release();
    await untilLaunched(world, ["01.resolver"]);
    const resolving = await snapshot(server);
    expect(ticketOf(resolving, "01").liveAttempt?.role).toBe("resolver");
    expect(ticketOf(resolving, "02").liveAttempt).not.toBeNull();
    expect(started(resolving)).toEqual(["01", "02"]);
    expect(readEvents(world.pool, "03")).toEqual([]);

    // With 02 ended the resolver alone fills the bound, so 03 still waits for it.
    await second.release();
    await until(() => snapshot(server), (s) => statuses(s)["02"] === "done", { what: "02 to end", ms: 30_000 });
    expect(readEvents(world.pool, "03")).toEqual([]);
    await resolver.release();
    // 01's merge waits at its Interrupt, so the drive keeps running rather than resting.
    const rested = await until(() => snapshot(server), (s) => statuses(s)["03"] === "done", {
      what: "03 to run once the resolver ended",
      ms: 30_000,
    });
    expect(started(rested)).toEqual(["01", "02", "03"]);
    const log = rested.state.log;
    const raised = log.findIndex((line) => line.startsWith("interrupt raised for 01 (merge-conflict)"));
    expect(raised).toBeGreaterThan(-1);
    expect(log.findIndex((line) => line.startsWith("start 03"))).toBeGreaterThan(raised);
  },
);

conformance(
  "scheduling",
  "the Machine default's maxLive applies to a pool that sets none, is read afresh when saved, and the pool's own wins over it",
  async (t) => {
    const inherited = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
    machineDefaults(inherited, { maxLive: 1 });
    const first = holdStub(t, inherited, "01");
    const second = holdStub(t, inherited, "02");
    const server = await t.start(inherited);

    await untilLaunched(inherited, ["01"]);
    expect(started(await snapshot(server))).toEqual(["01"]);
    const raised = await server.http.put("/api/settings/machine", { defaults: { maxLive: 2 } });
    expect(raised.status, raised.text).toBe(200);
    await untilLaunched(inherited, ["02"]);
    expect(eventsOf(inherited, "01", "exited")).toEqual([]);
    await first.release();
    await second.release();
    await settle(server, reviewUp, { what: "the Review" });

    const own = t.world({ tickets: [ticket("01"), ticket("02")], config: { ...CONFIG, maxLive: 2 } });
    machineDefaults(own, { maxLive: 1 });
    const ownFirst = holdStub(t, own, "01");
    const ownSecond = holdStub(t, own, "02");
    const ownServer = await t.start(own);

    await untilLaunched(own, ["01", "02"]);
    expect(started(await snapshot(ownServer))).toEqual(["01", "02"]);
    await ownFirst.release();
    await ownSecond.release();
    await settle(ownServer, reviewUp, { what: "the Review" });
  },
);

conformance(
  "scheduling",
  "a Continued attempt counts toward maxLive, and its ending starts the Ticket waiting on it",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02")],
      config: { ...CONFIG, terminal: "herdr", maxLive: 1 },
    });
    world.stubs.script("01", { status: "checkpoint", brief: "ask me", hold: 120 });
    world.stubs.script("02", { statuses: ["checkpoint", "done"], brief: "go on?" });
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    const server = await t.start(world, { herdr });

    await settle(
      server,
      (s) => ticketOf(s, "01").heldPane != null && s.state.interrupts.some((i) => i.ticketId === "02" && i.kind === "checkpoint"),
      { what: "01's Held pane and 02's checkpoint" },
    );
    const talk = await server.http.post("/api/keep-talking", { ticketId: "01" });
    expect(talk.status, talk.text).toBe(202);
    await answer(server, { ticketId: "02" });
    const waiting = await until(() => snapshot(server), (s) => statuses(s)["02"] === "ready", {
      what: "02 to be ready again",
      ms: 30_000,
    });
    expect(ticketOf(waiting, "01").liveAttempt?.attempt).toBe(2);
    expect(eventsOf(world, "02", "scheduled")).toHaveLength(1);

    writeFileSync(
      join(world.pool, "runs", "01.outcome.json"),
      JSON.stringify({ status: "done", summary: "talked it through", commitSha: null }),
    );
    const rested = await settle(server, (s) => statuses(s)["02"] === "done", { what: "02 to run again to done" });
    expect(statuses(rested)["01"]).toBe("done");
    expect(scheduledAt(world, "02", 2) >= exitedAt(world, "01", 2)).toBe(true);
  },
);

conformance(
  "scheduling",
  "a Line Merger's resolver runs while the pool is at its maxLive, and a queued copy still waits for it",
  async (t) => {
    const world = lineWorld(t, null, { "shared.txt": "base\n" }, { ...CONFIG, maxLive: 2, resolver: "claude" });
    world.stubs.script("tasks-1", makingItems(pieces(3)));
    const first = holdStub(t, world, "build-1.1", {
      run: "echo from-1 > shared.txt\ngit add -A\ngit commit -qm work-1",
    });
    const second = holdStub(t, world, "build-1.2");
    const resolver = holdStub(t, world, "build-1.1.resolver", {
      outcomeRaw: JSON.stringify({ resolved: false, note: "left for the operator" }),
    });
    const third = holdStub(t, world, "build-1.3");
    const server = await t.start(world);
    await begun(server, { plan: copiesPlan({ cap: 2, merger: true }), work: "#1" });

    await untilLaunched(world, ["build-1.1", "build-1.2"]);
    const lowered = await server.http.put("/api/settings/pool", { config: { maxLive: 1 } });
    expect(lowered.status, lowered.text).toBe(200);
    await until(() => snapshot(server), (s) => s.state.log.includes("config reloaded: maxLive"), {
      what: "the reload of maxLive",
      ms: 30_000,
    });

    writeFileSync(join(world.repo, "shared.txt"), "from-main\n");
    gitIn(world.repo, ["commit", "-qm", "hand edit", "--", "shared.txt"]);
    await first.release();
    await untilLaunched(world, ["build-1.1.resolver"]);
    const resolving = await snapshot(server);
    expect(ticketOf(resolving, "build-1.1").liveAttempt?.role).toBe("resolver");
    expect(ticketOf(resolving, "build-1.2").liveAttempt).not.toBeNull();
    expect(started(resolving)).toEqual(["tasks-1", "build-1.1", "build-1.2"]);
    expect(launches(world)).not.toContain("build-1.3");

    await second.release();
    await until(() => snapshot(server), (s) => statuses(s)["build-1.2"] === "done", { what: "build-1.2 to end", ms: 30_000 });
    expect(launches(world)).not.toContain("build-1.3");
    await resolver.release();
    await untilLaunched(world, ["build-1.3"]);
    expect(started(await snapshot(server))).toEqual(["tasks-1", "build-1.1", "build-1.2", "build-1.3"]);
    await third.release();
  },
);
