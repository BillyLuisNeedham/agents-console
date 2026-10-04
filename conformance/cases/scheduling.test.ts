/**
 * Scheduling and status, seen from outside the server (ADR-0036): pool
 * loading, the ready set and blocked-by, super-steps, the outcomes and
 * config channels, checkpoints per super-step, the Outcome contract and the
 * engine's own status writes, lifecycle events, adding blockers, the final
 * Review and deadlock. Ticket C07 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over, or the uncovered behaviour it pins.
 *
 * The stubs on PATH play the agents. A sibling held open waits on a release
 * file the case writes (the stub gives up after ten seconds), which is how a
 * case observes the pool mid-super-step without racing it.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../engine/wire.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { expectParsedEqual, expectSameBytes } from "../harness/equal.ts";
import { readCheckpoints, readEvents, readStateLine, readTicketFile, until } from "../harness/pool-files.ts";
import { freePort, serverArgv, serverChoice } from "../harness/server.ts";
import type { ConformanceStubBehaviour } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";

const CONFIG = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;
const REVIEW = "REVIEW";

/** A Ticket seed: `<id>-<letter>.md` with its state line and an optional body. */
function ticket(
  id: string,
  letter: string,
  options: { blockedBy?: string; status?: string; body?: string } = {},
): { file: string; marker: string; body?: string } {
  return {
    file: `${id}-${letter}.md`,
    marker: `<!-- state: id=${id} blocked-by=${options.blockedBy ?? "none"} status=${options.status ?? "ready"} -->`,
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

async function snapshotOf(server: CaseServer): Promise<EnrichedSnapshot> {
  const answer = await server.http.get("/api/state");
  const snapshot = answer.json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
  if (snapshot === null) throw new Error("the pool has not started");
  return snapshot;
}

/** The snapshot once the run has stopped moving and `done` holds of it. */
function settle(
  server: CaseServer,
  what: string,
  done: (snapshot: EnrichedSnapshot) => boolean = () => true,
  ms = 20_000,
): Promise<EnrichedSnapshot> {
  return until(() => snapshotOf(server), (s) => s.phase !== "running" && done(s), { what, ms });
}

const kinds = (s: EnrichedSnapshot): string[] => s.state.interrupts.map((i) => i.kind);
const statusOf = (s: EnrichedSnapshot, id: string): string | undefined =>
  s.state.tickets.find((t) => t.id === id)?.status;
const statuses = (s: EnrichedSnapshot): Record<string, string> =>
  Object.fromEntries(s.state.tickets.map((t) => [t.id, t.status]));
const onlyReview = (s: EnrichedSnapshot): boolean => kinds(s).join() === "review";

async function post(server: CaseServer, body: Record<string, unknown>, status = 202): Promise<void> {
  const answer = await server.http.post("/api/resume", body);
  expect(answer.status, `POST /api/resume ${JSON.stringify(body)}: ${answer.text}`).toBe(status);
}

/** Approve the final Review and wait for the run to end done. */
async function approve(server: CaseServer): Promise<EnrichedSnapshot> {
  await post(server, { ticketId: REVIEW, action: "approve" });
  return settle(server, "the run to end done", (s) => s.phase === "done");
}

/** Every launch's key, in launch order. */
const launches = (world: World): string[] => world.stubs.calls().map((call) => call.key);
const eventKinds = (world: World, id: string): string[] => readEvents(world.pool, id).map((e) => e.kind);

/** The prompt a launch carried: the argument after `-p`. */
function promptOf(world: World, key: string): string {
  const call = world.stubs.calls().find((c) => c.key === key);
  if (!call) throw new Error(`no launch of ${key}`);
  return call.argv[call.argv.indexOf("-p") + 1] ?? "";
}

/** The pushed snapshot on a socket once it shows what `match` asks for. */
async function pushedWhen(
  socket: SocketClient,
  what: string,
  match: (s: EnrichedSnapshot) => boolean,
): Promise<EnrichedSnapshot> {
  const holds = () => socket.pushed !== null && match(socket.pushed.snapshot as EnrichedSnapshot);
  await socket.waitFor(holds, { what });
  return socket.pushed!.snapshot as EnrichedSnapshot;
}

/** The chosen server started on a world's pool and run until it exits. */
async function runToExit(world: World, ms = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(serverArgv(serverChoice(), world.pool, await freePort()), {
    env: world.env(`${world.root}/no-herdr.sock`),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  if (!exited) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error(`the server was still running ${ms} ms after start`);
  }
  return {
    code: proc.exitCode ?? -1,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

// ---------------------------------------------------------------------------
// Pool loading
// ---------------------------------------------------------------------------

// engine.test.ts:392
conformance("scheduling", "a pool with no Issue files and no conversations/ directory refuses to start", async (t) => {
  const world = t.world({ tickets: [], config: CONFIG });
  const run = await runToExit(world);
  expect(run.code).not.toBe(0);
  expect(run.stderr.split("\n")).toContain(
    `pool load: no Issue files in ${join(world.pool, "issues")} (a Seeded Pool, which starts with no ` +
      "Tickets and grows by Enlist and Spawn, opts in by having a conversations/ directory)",
  );
});

// Uncovered behaviour: engine/pool.ts:237-241.
conformance("scheduling", "two Ticket files carrying one id refuse to start", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("01", "b")], config: CONFIG });
  const run = await runToExit(world);
  expect(run.code).not.toBe(0);
  expect(run.stderr.split("\n")).toContain("pool load: duplicate ticket id '01'");
  expect(world.stubs.calls()).toEqual([]);
});

// ---------------------------------------------------------------------------
// Super-steps and the ready set
// ---------------------------------------------------------------------------

// engine.test.ts:3427
conformance("scheduling", "independent ready Tickets run as one super-step and the run ends done", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b")], config: CONFIG });
  const server = await t.start(world);
  await settle(server, "the Review", onlyReview);
  const done = await approve(server);

  expect(done.state.log).toContain("super-step 1: 01, 02");
  expect(done.state.log.at(-1)).toBe("pool done: every ticket reached done");
  expect(done.state.interrupts).toEqual([]);
  expect(launches(world).sort()).toEqual(["01", "02"]);
  expectSameBytes(readStateLine(world.pool, "01-a.md").line, "<!-- state: id=01 blocked-by=none status=done -->");
  expectSameBytes(readStateLine(world.pool, "02-b.md").line, "<!-- state: id=02 blocked-by=none status=done -->");
});

// engine.test.ts:3466
conformance("scheduling", "a Ticket waits until every blocker is done", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b", { blockedBy: "01" })], config: CONFIG });
  const release = join(world.root, "release-01");
  world.stubs.script("01", { waitFor: release });
  const server = await t.start(world);
  const socket = await t.socket(server, { visible: true });

  const held = await pushedWhen(socket, "a snapshot with 01 in-progress", (s) => statusOf(s, "01") === "in-progress");
  expect(statusOf(held, "02")).toBe("ready");
  await until(() => launches(world), (keys) => keys.length > 0, { what: "01 to launch" });
  expect(launches(world)).toEqual(["01"]);
  writeFileSync(release, "go");

  await settle(server, "the Review", onlyReview);
  const done = await approve(server);
  expect(done.state.log).toContain("super-step 1: 01");
  expect(done.state.log).toContain("super-step 2: 02");
  expect(launches(world)).toEqual(["01", "02"]);
});

// engine.test.ts:3498
conformance("scheduling", "the ready set runs against one shared starting snapshot", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a"), ticket("02", "b", { blockedBy: "01" }), ticket("03", "c", { blockedBy: "01" })],
    config: CONFIG,
  });
  const server = await t.start(world);
  const settled = await settle(server, "the Review", onlyReview);

  expect(settled.state.log).toContain("super-step 2: 02, 03");
  for (const id of ["02", "03"]) {
    expect(promptOf(world, id)).toContain("\n- 01: summary-01 (commit none)\n");
  }
  expect(promptOf(world, "02")).not.toContain("summary-03");
  expect(promptOf(world, "03")).not.toContain("summary-02");
  expect(Object.keys(settled.state.outcomes).sort()).toEqual(["01", "02", "03"]);
});

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

// engine.test.ts:3613
conformance("scheduling", "a checkpoint and its resume land in order, attempts numbered per Ticket", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\npick a name" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  await settle(server, "01's checkpoint", (s) => kinds(s).join() === "checkpoint");
  await post(server, { ticketId: "01", note: "the name is Foo" });
  await settle(server, "the Review", onlyReview);
  await approve(server);

  const events = readEvents(world.pool, "01");
  expect(events.map((e) => [e.attempt, e.kind])).toEqual([
    [1, "scheduled"],
    [1, "spawned"],
    [1, "exited"],
    [1, "checkpoint"],
    [1, "answered"],
    [2, "scheduled"],
    [2, "spawned"],
    [2, "exited"],
  ]);
  expect(events.filter((e) => e.kind === "exited").map((e) => e.payload)).toEqual([
    { code: 0, status: "checkpoint", logTail: [], outcomeExists: true },
    { code: 0, status: "done", logTail: [], outcomeExists: true },
  ]);
  expect(readEvents(world.pool, "02").map((e) => [e.attempt, e.kind])).toEqual([
    [1, "scheduled"],
    [1, "spawned"],
    [1, "exited"],
  ]);
});

// engine.test.ts:3684
conformance("scheduling", "a crash and its answer land in order, carrying the exit code", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  world.stubs.script("01", { statuses: ["keep", "done"], exitCodes: [3, 0] });
  const server = await t.start(world);
  await settle(server, "01's crash", (s) => kinds(s).join() === "crash");

  expect(eventKinds(world, "01")).toEqual(["scheduled", "spawned", "exited", "crash"]);
  expect(readEvents(world.pool, "01").at(-1)?.payload).toEqual({
    code: 3,
    reason: "harness exited 3",
    logTail: [],
    outcomeExists: false,
  });

  await post(server, { ticketId: "01" });
  await settle(server, "the Review", onlyReview);
  expect(eventKinds(world, "01")).toEqual([
    "scheduled",
    "spawned",
    "exited",
    "crash",
    "answered",
    "scheduled",
    "spawned",
    "exited",
  ]);
});

// engine.test.ts:3730, with the uncovered log lines of engine/engine.ts:9077-9086 and 9120-9126.
conformance("scheduling", "a blocked-by cycle raises a deadlock per Ticket and clears it once the blocker can finish", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { blockedBy: "02" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  const server = await t.start(world);
  const stuck = await settle(server, "both deadlocks", (s) => kinds(s).join() === "deadlock,deadlock");

  const deadlock = readEvents(world.pool, "01");
  expect(deadlock.map((e) => [e.attempt, e.kind, e.payload])).toEqual([[0, "deadlock", { blockers: ["02"] }]]);
  expect(readEvents(world.pool, "02").map((e) => [e.attempt, e.kind, e.payload])).toEqual([
    [0, "deadlock", { blockers: ["01"] }],
  ]);
  expect(stuck.state.log).toContain("interrupt raised for 01 (deadlock): blockers can never complete: 02");
  expect(stuck.state.log).toContain("interrupt raised for 02 (deadlock): blockers can never complete: 01");

  writeFileSync(join(world.pool, "issues", "02-b.md"), "<!-- state: id=02 blocked-by=none status=ready -->\n\n# 02\n");
  await post(server, { ticketId: "02", note: "broke the cycle" });
  const done = await settle(server, "the Review", onlyReview);

  expect(eventKinds(world, "01")).toEqual(["deadlock", "scheduled", "spawned", "exited", "deadlock-cleared"]);
  expect(done.state.log).toContain("interrupt cleared for 01 (deadlock): blockers can complete again");
  expect(launches(world)).toEqual(["02", "01"]);
});

// engine.test.ts:3776
conformance("scheduling", "a Review reject lands a review-reject event on the rejected Ticket", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  const server = await t.start(world);
  await settle(server, "the Review", onlyReview);
  await post(server, { ticketId: REVIEW, action: "reject", note: "redo 01" });
  await settle(server, "a fresh Review", (s) => onlyReview(s) && launches(world).length === 2);

  expect(eventKinds(world, "01")).toEqual([
    "scheduled",
    "spawned",
    "exited",
    "review-reject",
    "scheduled",
    "spawned",
    "exited",
  ]);
});

// Uncovered behaviour: engine/engine.ts:8950-8977.
conformance("scheduling", "a Review reject drops the rejected Tickets' outcomes until they run again", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b", { blockedBy: "01" })], config: CONFIG });
  // Present from the start, so the first run passes straight through; taken
  // away before the reject, so the re-run of 01 holds until it is back.
  const release = join(world.root, "release-01");
  writeFileSync(release, "go");
  world.stubs.script("01", { waitFor: release });
  const server = await t.start(world);
  const reviewed = await settle(server, "the Review", onlyReview);
  expect(Object.keys(reviewed.state.outcomes).sort()).toEqual(["01", "02"]);
  rmSync(release);

  await post(server, { ticketId: REVIEW, action: "reject", note: "redo 01" });
  await until(() => launches(world), (keys) => keys.length === 3, { what: "01 to launch again" });
  const between = await snapshotOf(server);
  expect(between.state.outcomes).toEqual({});
  expect(existsSync(join(world.pool, "runs", "01.outcome.json"))).toBe(false);
  expect(existsSync(join(world.pool, "runs", "02.outcome.json"))).toBe(false);
  expect(eventKinds(world, "01").slice(3, 4)).toEqual(["review-reject"]);
  expect(eventKinds(world, "02")).toEqual(["scheduled", "spawned", "exited", "review-reject"]);

  writeFileSync(release, "go");
  const again = await settle(server, "a fresh Review", (s) => onlyReview(s) && launches(world).length === 4);
  expect(Object.keys(again.state.outcomes).sort()).toEqual(["01", "02"]);
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

// engine.test.ts:3876
conformance("scheduling", "an outcome lands in the outcomes channel and in its downstream Ticket's prompt", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b", { blockedBy: "01" })], config: CONFIG });
  world.stubs.script("01", { outcome: { summary: "built the schema", commitSha: "abc123" } });
  const server = await t.start(world);
  const settled = await settle(server, "the Review", onlyReview);

  expect(settled.state.outcomes["01"]).toEqual({ status: "done", summary: "built the schema", commitSha: "abc123" });
  expect(promptOf(world, "02")).toContain(
    "Outcomes from the tickets this ticket was blocked by. Build on what they did; do not rediscover it:\n\n" +
      "- 01: built the schema (commit abc123)\n",
  );
});

// engine.test.ts:3905
conformance("scheduling", "the pool log gains one super-step line per super-step", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b", { blockedBy: "01" })], config: CONFIG });
  const server = await t.start(world);
  const settled = await settle(server, "the Review", onlyReview);

  expect(settled.state.log.filter((line) => line.startsWith("super-step"))).toEqual([
    "super-step 1: 01",
    "super-step 2: 02",
  ]);
});

// engine.test.ts:3929
conformance("scheduling", "console.json is the snapshot's config channel, verbatim", async (t) => {
  const config: PoolConfig = { defaults: { harness: "claude", model: "stub-model" }, reviewer: "acceptance criteria only" };
  const world = t.world({ tickets: [ticket("01", "a")], config });
  const server = await t.start(world);
  const settled = await settle(server, "the Review", onlyReview);

  expectParsedEqual(settled.state.config, config, "state.config");
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

// engine.test.ts:6947
conformance("scheduling", "console.db gains a checkpoint at every super-step, the Review and its approval", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b", { blockedBy: "01" })], config: CONFIG });
  const server = await t.start(world);
  await settle(server, "the Review", onlyReview);
  await approve(server);

  // Two super-step joins, the review gate, the quiescent final, the
  // approval's own persist and the approval's done final.
  const rows = readCheckpoints(world.pool);
  expect(rows.map((row) => row.seq)).toEqual([...rows.map((row) => row.seq)].sort((a, b) => a - b));
  expect(rows).toHaveLength(6);
  const state = rows.map(
    (row) =>
      row.state as {
        tickets: Record<string, string>;
        outcomes: Record<string, { summary: string }>;
        interrupts: unknown[];
        reviewApproved?: boolean;
        log: string[];
      },
  );
  expect(state[0]!.tickets).toEqual({ "01": "done", "02": "ready" });
  expect(state[1]!.tickets).toEqual({ "01": "done", "02": "done" });
  expect(state[1]!.outcomes["01"]!.summary).toBe("summary-01");
  expect(state[4]!.interrupts).toEqual([]);
  expect(state[4]!.reviewApproved).toBe(true);
  expect(state[5]!.log.at(-1)).toBe("pool done: every ticket reached done");
  expect(state[5]!.reviewApproved).toBe(true);
});

// ---------------------------------------------------------------------------
// Interrupts the drive raises
// ---------------------------------------------------------------------------

// engine.test.ts:7324
conformance("scheduling", "a state line the agent rewrote to ready is a crash, not a respawn", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  world.stubs.script("01", { status: "ready", exitCode: 0 });
  const server = await t.start(world);
  const settled = await settle(server, "01's crash", (s) => kinds(s).join() === "crash");

  expect(settled.state.interrupts).toEqual([
    {
      ticketId: "01",
      kind: "crash",
      body:
        `crash: no outcome written\n${join(world.pool, "runs", "01.log")}\n\n` +
        `outcome file: ${join(world.pool, "runs", "01.outcome.json")} (missing)\n`,
    },
  ]);
  expect(launches(world)).toEqual(["01"]);
  expectSameBytes(readStateLine(world.pool, "01-a.md").line, "<!-- state: id=01 blocked-by=none status=in-progress -->");
});

// engine.test.ts:7360
conformance("scheduling", "a blocked-by cycle raises deadlock Interrupts without launching anything", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { blockedBy: "02" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  const server = await t.start(world);
  const settled = await settle(server, "both deadlocks", (s) => s.state.interrupts.length === 2);

  expect(settled.phase).toBe("quiescent");
  expect(settled.state.interrupts).toEqual([
    { ticketId: "01", kind: "deadlock", body: "blockers can never complete: 02" },
    { ticketId: "02", kind: "deadlock", body: "blockers can never complete: 01" },
  ]);
  expect(launches(world)).toEqual([]);
});

// engine.test.ts:7394
conformance("scheduling", "ready siblings keep running while a Ticket is interrupted", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a"), ticket("02", "b"), ticket("03", "c", { blockedBy: "02" })],
    config: CONFIG,
  });
  world.stubs.script("01", { status: "checkpoint" });
  const server = await t.start(world);
  const settled = await settle(server, "03 done", (s) => statusOf(s, "03") === "done");

  expect(settled.phase).toBe("quiescent");
  expect(settled.state.log).toContain("super-step 1: 01, 02");
  expect(settled.state.log).toContain("super-step 2: 03");
  expect(statuses(settled)).toEqual({ "01": "checkpoint", "02": "done", "03": "done" });
  expect(settled.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "checkpoint"]]);
});

// engine.test.ts:7470
conformance("scheduling", "a dependent waits behind a checkpointed blocker without a deadlock, then runs after the resume", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\nneed a decision" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  world.stubs.script("01", { statuses: ["checkpoint", "done"], brief: "need a decision" });
  const server = await t.start(world);
  const paused = await settle(server, "01's checkpoint", (s) => s.state.interrupts.length > 0);

  expect(launches(world)).toEqual(["01"]);
  expect(statuses(paused)).toEqual({ "01": "checkpoint", "02": "ready" });
  expect(paused.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "need a decision" }]);

  await post(server, { ticketId: "01", note: "carry on" });
  const resumed = await settle(server, "the Review", onlyReview);
  expect(statuses(resumed)).toEqual({ "01": "done", "02": "done" });
  expect(launches(world)).toEqual(["01", "01", "02"]);
});

// engine.test.ts:7581
conformance("scheduling", "an interrupted pool reads quiescent, and only an approved Review reads done", async (t) => {
  const stuckWorld = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  stuckWorld.stubs.script("01", { status: "checkpoint" });
  const cleanWorld = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  const stuck = await t.start(stuckWorld);
  const clean = await t.start(cleanWorld);

  const stuckState = await settle(stuck, "the checkpoint", (s) => s.state.interrupts.length > 0);
  expect(stuckState.phase).toBe("quiescent");
  expect(kinds(stuckState)).toEqual(["checkpoint"]);

  const cleanState = await settle(clean, "the Review", (s) => s.state.interrupts.length > 0);
  expect(cleanState.phase).toBe("quiescent");
  expect(kinds(cleanState)).toEqual(["review"]);
  const done = await approve(clean);
  expect(done.phase).toBe("done");
  expect(done.state.interrupts).toEqual([]);
});

// engine.test.ts:7622
conformance("scheduling", "a blocker id no Ticket carries raises a deadlock without launching anything", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a", { blockedBy: "99" })], config: CONFIG });
  const server = await t.start(world);
  const settled = await settle(server, "the deadlock", (s) => s.state.interrupts.length > 0);

  expect(settled.phase).toBe("quiescent");
  expect(settled.state.interrupts).toEqual([{ ticketId: "01", kind: "deadlock", body: "blockers can never complete: 99" }]);
  expect(launches(world)).toEqual([]);
});

// ---------------------------------------------------------------------------
// The Outcome contract
// ---------------------------------------------------------------------------

/** One ready Ticket, 01-a.md, with the stub for 01 scripted, started and settled on its first interrupt. */
async function oneTicket(
  t: Case,
  behaviour: ConformanceStubBehaviour,
  body?: string,
): Promise<{ world: World; server: CaseServer; settled: EnrichedSnapshot }> {
  const world = t.world({ tickets: [ticket("01", "a", body !== undefined ? { body } : {})], config: CONFIG });
  world.stubs.script("01", behaviour);
  const server = await t.start(world);
  const settled = await settle(server, "the first interrupt", (s) => s.state.interrupts.length > 0);
  return { world, server, settled };
}

const crashPayload = (world: World) => readEvents(world.pool, "01").at(-1)?.payload;

// engine.test.ts:7724
conformance("scheduling", "the engine writes the done state line itself when the outcome says done", async (t) => {
  const { world, server } = await oneTicket(t, { status: "done" });
  const done = await approve(server);

  expect(done.phase).toBe("done");
  expectSameBytes(
    readTicketFile(world.pool, "01-a.md"),
    "<!-- state: id=01 blocked-by=none status=done -->\n\n# body\n",
    "issues/01-a.md",
  );
});

// engine.test.ts:7738
conformance("scheduling", "an Attempt that writes no outcome is a crash", async (t) => {
  const { world, settled } = await oneTicket(t, { status: "keep" });

  expect(settled.phase).toBe("quiescent");
  expect(kinds(settled)).toEqual(["crash"]);
  expect(eventKinds(world, "01")).toEqual(["scheduled", "spawned", "exited", "crash"]);
  expect(readEvents(world.pool, "01")[2]?.payload).toEqual({
    code: 0,
    status: "in-progress",
    logTail: [],
    outcomeExists: false,
  });
  expect(crashPayload(world)).toEqual({ code: 0, reason: "no outcome written", logTail: [], outcomeExists: false });
  expectSameBytes(readStateLine(world.pool, "01-a.md").line, "<!-- state: id=01 blocked-by=none status=in-progress -->");
});

// engine.test.ts:7753
conformance("scheduling", "a stale outcome an earlier Attempt left behind is never honoured", async (t) => {
  const { world, server } = await oneTicket(t, { statuses: ["checkpoint", "keep"], brief: "pick a name" });
  await post(server, { ticketId: "01", note: "go with the first" });
  const crashed = await settle(server, "the crash", (s) => kinds(s).join() === "crash");

  expect(crashed.phase).toBe("quiescent");
  expect(crashPayload(world)).toEqual({ code: 0, reason: "no outcome written", logTail: [], outcomeExists: false });
  expectSameBytes(readStateLine(world.pool, "01-a.md").line, "<!-- state: id=01 blocked-by=none status=in-progress -->");
});

// engine.test.ts:7779
conformance("scheduling", "an outcome that is not JSON is a crash", async (t) => {
  const { world, settled } = await oneTicket(t, { outcomeRaw: "not json" });

  expect(settled.phase).toBe("quiescent");
  expect(kinds(settled)).toEqual(["crash"]);
  expect(crashPayload(world)).toEqual({ code: 0, reason: "outcome is not parseable JSON", logTail: [], outcomeExists: true });
});

// engine.test.ts:7792
conformance("scheduling", "an outcome whose status is neither done nor checkpoint is a crash", async (t) => {
  const { world, settled } = await oneTicket(t, { outcomeRaw: '{"status":"dnoe","summary":"x","commitSha":null}' });

  expect(settled.phase).toBe("quiescent");
  expect(kinds(settled)).toEqual(["crash"]);
  expect(crashPayload(world)).toEqual({
    code: 0,
    reason: "outcome's status is not done or checkpoint",
    logTail: [],
    outcomeExists: true,
  });
});

// Uncovered behaviour: engine/engine.ts:9704-9706.
conformance("scheduling", "a done outcome with no summary is a crash", async (t) => {
  const { world, settled } = await oneTicket(t, { outcomeRaw: '{"status":"done","commitSha":null}' });

  expect(kinds(settled)).toEqual(["crash"]);
  expect(crashPayload(world)).toEqual({ code: 0, reason: "outcome has no summary string", logTail: [], outcomeExists: true });
  expectSameBytes(readStateLine(world.pool, "01-a.md").line, "<!-- state: id=01 blocked-by=none status=in-progress -->");
});

// engine.test.ts:7807
conformance("scheduling", "a valid done outcome with a non-zero exit is a crash", async (t) => {
  const { world, settled } = await oneTicket(t, { status: "done", exitCode: 1 });

  expect(settled.phase).toBe("quiescent");
  expect(kinds(settled)).toEqual(["crash"]);
  expect(crashPayload(world)).toEqual({ code: 1, reason: "harness exited 1", logTail: [], outcomeExists: true });
  expectSameBytes(readStateLine(world.pool, "01-a.md").line, "<!-- state: id=01 blocked-by=none status=in-progress -->");
});

// engine.test.ts:7822
conformance("scheduling", "a done state line the agent wrote itself is ignored and put back, never re-launched", async (t) => {
  const { world, settled } = await oneTicket(t, { status: "marker-done" });

  expect(settled.phase).toBe("quiescent");
  expect(kinds(settled)).toEqual(["crash"]);
  expect(launches(world)).toEqual(["01"]);
  expectSameBytes(readStateLine(world.pool, "01-a.md").line, "<!-- state: id=01 blocked-by=none status=in-progress -->");
});

// engine.test.ts:7835
conformance("scheduling", "the engine writes the checkpoint state line itself when the outcome says checkpoint", async (t) => {
  const { world, settled } = await oneTicket(t, { status: "checkpoint", brief: "pick a name" });

  expect(settled.phase).toBe("quiescent");
  expect(settled.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "pick a name" }]);
  expectSameBytes(readStateLine(world.pool, "01-a.md").line, "<!-- state: id=01 blocked-by=none status=checkpoint -->");
  expect(eventKinds(world, "01")).toEqual(["scheduled", "spawned", "exited", "checkpoint"]);
  expect(readEvents(world.pool, "01")[2]?.payload).toEqual({
    code: 0,
    status: "checkpoint",
    logTail: [],
    outcomeExists: true,
  });
});

// engine.test.ts:7860
conformance("scheduling", "a checkpoint's brief replaces a stale Brief section in the Ticket file", async (t) => {
  const { world, settled } = await oneTicket(
    t,
    { status: "checkpoint", brief: "fresh brief" },
    "# 01\n\n## Brief\n\nstale brief from an earlier attempt",
  );

  expect(settled.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "fresh brief" }]);
  expectSameBytes(
    readTicketFile(world.pool, "01-a.md"),
    "<!-- state: id=01 blocked-by=none status=checkpoint -->\n\n# 01\n\n---\n\n## Brief\n\nfresh brief\n",
    "issues/01-a.md",
  );
});

// engine.test.ts:7890
conformance("scheduling", "a checkpoint with no brief lands the engine's placeholder Brief", async (t) => {
  const { world, settled } = await oneTicket(t, { status: "checkpoint" });

  expect(launches(world)).toEqual(["01"]);
  expect(kinds(settled)).toEqual(["checkpoint"]);
  expect(settled.state.interrupts[0]!.body).toBe(PLACEHOLDER);
  expectSameBytes(readTicketFile(world.pool, "01-a.md"), PLACEHOLDER_FILE, "issues/01-a.md");
});

// engine.test.ts:7906
conformance("scheduling", "a later checkpoint with no brief replaces a stale Brief with the placeholder", async (t) => {
  const { world, settled } = await oneTicket(t, { status: "checkpoint" }, "# body\n\n## Brief\n\nstale brief from an earlier attempt");

  expect(kinds(settled)).toEqual(["checkpoint"]);
  expect(settled.state.interrupts[0]!.body).toBe(PLACEHOLDER);
  expectSameBytes(readTicketFile(world.pool, "01-a.md"), PLACEHOLDER_FILE, "issues/01-a.md");
});

// ---------------------------------------------------------------------------
// Adding a blocker to a Ticket (through Enlist)
// ---------------------------------------------------------------------------

/** A terminal-backed pool on the fake herdr, offering one idle claude pane in the checkout. */
async function enlistPool(
  t: Case,
  tickets: ReturnType<typeof ticket>[],
): Promise<{ world: World; start: () => Promise<CaseServer> }> {
  const world = t.world({ tickets, config: { ...CONFIG, terminal: "herdr" } });
  const herdr = await t.herdr(world);
  await herdr.control("seedAgent", {
    paneId: "pane-op",
    agent: "claude",
    cwd: world.repo,
    title: "✳ Claude Code",
    status: "idle",
    rendered: "Claude Code v1\n❯ ",
    tabId: "tab-op",
  });
  return { world, start: () => t.start(world, { herdr }) };
}

const enlistBody = (blocks: string[]) => ({ becomes: "ticket", paneId: "pane-op", title: "Found work", spec: "the spec", blocks });

// engine.test.ts:9796
conformance("scheduling", "Enlist refuses to block a done Ticket and writes nothing", async (t) => {
  const { world, start } = await enlistPool(t, [ticket("01", "t", { status: "done" })]);
  const before = readTicketFile(world.pool, "01-t.md");
  const server = await start();
  await settle(server, "the Review", onlyReview);

  const answer = await server.http.post("/api/enlist", enlistBody(["01"]));
  expect(answer.status).toBe(409);
  expectParsedEqual(answer.text, { reason: "enlist: ticket 01 is done; a done ticket cannot wait on anything" }, "the 409");
  expectSameBytes(readTicketFile(world.pool, "01-t.md"), before, "issues/01-t.md");
  expect(existsSync(join(world.pool, "issues", "enlist-1.md"))).toBe(false);
});

// engine.test.ts:9817
conformance("scheduling", "Enlist refuses to block a Ticket that is not in the pool", async (t) => {
  const { world, start } = await enlistPool(t, [ticket("01", "t", { status: "done" })]);
  const before = readTicketFile(world.pool, "01-t.md");
  const server = await start();
  await settle(server, "the Review", onlyReview);

  const answer = await server.http.post("/api/enlist", enlistBody(["99"]));
  expect(answer.status).toBe(409);
  expectParsedEqual(answer.text, { reason: "enlist: ticket 99 is not in the pool" }, "the 409");
  expectSameBytes(readTicketFile(world.pool, "01-t.md"), before, "issues/01-t.md");
  expect(existsSync(join(world.pool, "issues", "enlist-1.md"))).toBe(false);
});

// engine.test.ts:9830
conformance("scheduling", "a Ticket an enlisted Ticket blocks waits until the enlisted Ticket is done", async (t) => {
  const { world, start } = await enlistPool(t, [ticket("00", "z"), ticket("01", "t", { blockedBy: "00" })]);
  // Terminal-backed launches name no outcome file in their argv, so 00's
  // stub holds open under `_claude` and the case writes its outcome, as the
  // agent in the pane would.
  const release = join(world.root, "release-00");
  world.stubs.script("_claude", { outcome: null, waitFor: release });
  const server = await start();
  await until(() => launches(world), (keys) => keys.length === 1, { what: "00 to launch" });

  const answer = await server.http.post("/api/enlist", enlistBody(["01"]));
  expect(answer.status).toBe(201);
  expectParsedEqual(answer.text, { ticketId: "enlist-1" }, "the 201");
  expectSameBytes(readStateLine(world.pool, "01-t.md").line, "<!-- state: id=01 blocked-by=00,enlist-1 status=ready -->");

  writeFileSync(join(world.pool, "runs", "00.outcome.json"), '{"status":"done","summary":"s","commitSha":null}');
  writeFileSync(release, "go");
  const waiting = await settle(server, "00 done", (s) => statusOf(s, "00") === "done");
  expect(waiting.state.log.at(-1)).toBe("pool quiescent: waiting on enlist-1");
  expect(statusOf(waiting, "01")).toBe("ready");
  expect(readEvents(world.pool, "01")).toEqual([]);

  writeFileSync(join(world.pool, "runs", "enlist-1.outcome.json"), '{"status":"done","summary":"e","commitSha":null}');
  await until(() => eventKinds(world, "01"), (got) => got.includes("scheduled"), { what: "01 to be scheduled" });
  expect(eventKinds(world, "enlist-1").slice(0, 3)).toEqual(["scheduled", "spawned", "exited"]);
  const order = (await snapshotOf(server)).state.log;
  expect(order.indexOf("super-step 2: 01")).toBeGreaterThan(
    order.indexOf("ticket enlist-1: enlisted attempt 1 exited 0, marker done"),
  );
});

// ---------------------------------------------------------------------------
// The final Review
// ---------------------------------------------------------------------------

// engine.test.ts:9849
conformance("scheduling", "exactly one Review Interrupt is raised when every Ticket is done", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b", { blockedBy: "01" })], config: CONFIG });
  const server = await t.start(world);
  const settled = await settle(server, "the Review", (s) => s.state.interrupts.length > 0);

  expect(settled.phase).toBe("quiescent");
  expect(statuses(settled)).toEqual({ "01": "done", "02": "done" });
  expect(settled.state.interrupts).toEqual([
    {
      ticketId: REVIEW,
      kind: "review",
      body:
        "every ticket is done.\n- 01: summary-01\n- 02: summary-02\n" +
        "approve to end the run, or reject with a note naming the tickets to send back; " +
        "their downstream tickets return to ready with them.",
    },
  ]);
  expect(settled.state.log.at(-1)).toBe("pool quiescent: interrupts pending for REVIEW");
});

// engine.test.ts:9912
conformance("scheduling", "a Review reject sends the named Tickets and their downstream back to ready, then re-reviews", async (t) => {
  const world = t.world({
    tickets: [
      ticket("01", "a"),
      ticket("02", "b", { blockedBy: "01" }),
      ticket("03", "c", { blockedBy: "02" }),
      ticket("04", "d"),
    ],
    config: CONFIG,
  });
  const server = await t.start(world);
  await settle(server, "the Review", onlyReview);
  const note02 = readTicketFile(world.pool, "02-b.md");
  const note03 = readTicketFile(world.pool, "03-c.md");

  await post(server, { ticketId: REVIEW, action: "reject", note: "redo 02: the parser is wrong" });
  const again = await settle(server, "a fresh Review", (s) => onlyReview(s) && launches(world).length === 6);

  const order = launches(world);
  expect(order.slice(0, 2).sort()).toEqual(["01", "04"]);
  expect(order.slice(2)).toEqual(["02", "03", "02", "03"]);
  expect(statuses(again)).toEqual({ "01": "done", "02": "done", "03": "done", "04": "done" });
  expect(again.state.log).toContain("review rejected: 02 back to ready; downstream 03 also reset");
  expectSameBytes(
    readTicketFile(world.pool, "02-b.md"),
    `${note02}\n## Review note\n\nredo 02: the parser is wrong\n`,
    "issues/02-b.md",
  );
  expectSameBytes(readTicketFile(world.pool, "03-c.md"), note03, "issues/03-c.md");
  const done = await approve(server);
  expect(done.phase).toBe("done");
});

// engine.test.ts:9970
conformance("scheduling", "a Review reject naming no Ticket is refused and keeps the gate up", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  const server = await t.start(world);
  await settle(server, "the Review", onlyReview);

  const answer = await server.http.post("/api/resume", { ticketId: REVIEW, action: "reject", note: "this is not good enough" });
  expect(answer.status).toBe(400);
  expect(answer.json<{ error: string }>().error).toContain("name at least one ticket");
  expect(kinds(await snapshotOf(server))).toEqual(["review"]);
  expect(eventKinds(world, REVIEW)).not.toContain("answered");
  expect(existsSync(join(world.pool, "runs", "queued-answers.json"))).toBe(false);

  const done = await approve(server);
  expect(done.phase).toBe("done");
});

// engine.test.ts:10009
conformance("scheduling", "a plain resume on the Review gate is refused", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  const server = await t.start(world);
  await settle(server, "the Review", onlyReview);

  const answer = await server.http.post("/api/resume", { ticketId: REVIEW });
  expect(answer.status).toBe(400);
  expectParsedEqual(answer.text, { error: "answer: use approve() or reject() for the final review interrupt" }, "the 400");
  expect(kinds(await snapshotOf(server))).toEqual(["review"]);
});

// Uncovered behaviour: engine/engine.ts:5440-5445.
conformance("scheduling", "a Close on the Review gate is refused", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  const server = await t.start(world);
  await settle(server, "the Review", onlyReview);

  const answer = await server.http.post("/api/resume", { ticketId: REVIEW, action: "close" });
  expect(answer.status).toBe(400);
  expectParsedEqual(
    answer.text,
    { error: "answer: close takes a checkpoint, merge-conflict or deadlock interrupt, got review for REVIEW" },
    "the 400",
  );
  expect(kinds(await snapshotOf(server))).toEqual(["review"]);
});

// engine.test.ts:10030
conformance("scheduling", "an approve over a state line a human reset on disk continues to a fresh Review", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  const server = await t.start(world);
  await settle(server, "the Review", onlyReview);

  const file = join(world.pool, "issues", "01-a.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("status=done", "status=ready"));
  await post(server, { ticketId: REVIEW, action: "approve" });
  const again = await settle(server, "a fresh Review", (s) => onlyReview(s) && launches(world).length === 2);

  expect(again.phase).toBe("quiescent");
  expect(launches(world)).toEqual(["01", "01"]);
  expect(again.state.log).toContain(
    "review approved, but markers on disk are not all done: the run continues to a fresh review",
  );
  const done = await approve(server);
  expect(done.phase).toBe("done");
});

// engine.test.ts:10062
conformance("scheduling", "the Review waits while another Interrupt is pending", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\nneed a decision" }), ticket("02", "b")],
    config: CONFIG,
  });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  const paused = await settle(server, "01's checkpoint", (s) => statusOf(s, "02") === "done" && s.state.interrupts.length > 0);
  expect(paused.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "checkpoint"]]);

  await post(server, { ticketId: "01" });
  const resumed = await settle(server, "the Review", (s) => statusOf(s, "01") === "done");
  expect(resumed.phase).toBe("quiescent");
  expect(kinds(resumed)).toEqual(["review"]);
});

// ---------------------------------------------------------------------------
// Accepting a result at the Attempt's exit, before its super-step ends
// ---------------------------------------------------------------------------

// engine.test.ts:12710
conformance("scheduling", "a crash is recorded at the Attempt's exit, while a slow sibling holds the super-step", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b")], config: CONFIG });
  const release01 = join(world.root, "release-01");
  const release = join(world.root, "release-02");
  world.stubs.script("01", { status: "keep", exitCode: 3, waitFor: release01 });
  world.stubs.script("02", { waitFor: release });
  const server = await t.start(world);
  const socket = await t.socket(server, { visible: true });
  const live = (s: EnrichedSnapshot, id: string) => s.state.tickets.find((x) => x.id === id)?.liveAttempt != null;
  await pushedWhen(socket, "both Attempts live", (s) => live(s, "01") && live(s, "02"));
  writeFileSync(release01, "go");

  await until(() => eventKinds(world, "01"), (got) => got.includes("crash"), { what: "01's crash event" });
  expect(eventKinds(world, "01")).toEqual(["scheduled", "spawned", "exited", "crash"]);
  expect(crashPayload(world)).toEqual({ code: 3, reason: "harness exited 3", logTail: [], outcomeExists: false });
  expectSameBytes(readStateLine(world.pool, "01-a.md").line, "<!-- state: id=01 blocked-by=none status=in-progress -->");
  // Pushed at the crash: 01 is no longer live while 02 still runs, its
  // state line still in-progress, and the Interrupt waits for the
  // super-step boundary.
  const pushed = await pushedWhen(socket, "a frame with 01 no longer live", (s) => !live(s, "01"));
  expect(statusOf(pushed, "01")).toBe("in-progress");
  expect(statusOf(pushed, "02")).toBe("in-progress");
  expect(live(pushed, "02")).toBe(true);
  expect(pushed.state.interrupts).toEqual([]);
  expect((await snapshotOf(server)).state.interrupts).toEqual([]);

  writeFileSync(release, "go");
  const settled = await settle(server, "the crash Interrupt", (s) => statusOf(s, "02") === "done");
  expect(settled.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "crash"]]);
  expect(eventKinds(world, "01").filter((kind) => kind === "crash")).toHaveLength(1);
});

// engine.test.ts:12782
conformance("scheduling", "a done result joins state at the Attempt's exit, before a slow sibling exits", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b")], config: CONFIG });
  const release = join(world.root, "release-02");
  world.stubs.script("02", { waitFor: release });
  const server = await t.start(world);
  const socket = await t.socket(server, { visible: true });

  const early = await pushedWhen(
    socket,
    "a frame with 01 done and 02 in-progress",
    (s) => statusOf(s, "01") === "done" && statusOf(s, "02") === "in-progress",
  );
  expect(early.state.interrupts).toEqual([]);

  writeFileSync(release, "go");
  const settled = await settle(server, "the Review", onlyReview);
  expect(statuses(settled)).toEqual({ "01": "done", "02": "done" });
  expect(settled.state.log.filter((line) => line === "ticket 01: exited 0, marker done")).toHaveLength(1);
});

// engine.test.ts:12833
conformance("scheduling", "a checkpoint's Interrupt is raised at the Attempt's exit, before a slow sibling exits", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\npick a name" }), ticket("02", "b")],
    config: CONFIG,
  });
  const release = join(world.root, "release-02");
  world.stubs.script("01", { statuses: ["checkpoint", "done"], brief: "pick a name" });
  world.stubs.script("02", { waitFor: release });
  const server = await t.start(world);
  const socket = await t.socket(server, { visible: true });

  const early = await pushedWhen(
    socket,
    "a frame with 01's checkpoint pending while 02 runs",
    (s) => statusOf(s, "01") === "checkpoint" && statusOf(s, "02") === "in-progress" && s.state.interrupts.length > 0,
  );
  expect(early.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "pick a name" }]);
  expect(eventKinds(world, "01").filter((kind) => kind === "checkpoint")).toHaveLength(1);

  writeFileSync(release, "go");
  const settled = await settle(server, "02 done", (s) => statusOf(s, "02") === "done");
  expect(statuses(settled)).toEqual({ "01": "checkpoint", "02": "done" });
  expect(settled.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "pick a name" }]);
  expect(eventKinds(world, "01").filter((kind) => kind === "checkpoint")).toHaveLength(1);
});

// engine.test.ts:12963
conformance("scheduling", "a result joined at exit is applied once, and the last frame agrees with /api/state", async (t) => {
  const world = t.world({
    tickets: [
      ticket("01", "a", { body: "# 01\n\n## Brief\n\npick a name" }),
      ticket("02", "b"),
      ticket("03", "c", { blockedBy: "02" }),
    ],
    config: CONFIG,
  });
  const release = join(world.root, "release-02");
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  world.stubs.script("02", { waitFor: release });
  const server = await t.start(world);
  const socket = await t.socket(server, { visible: true });

  await pushedWhen(
    socket,
    "a frame with 01 checkpoint while 02 runs",
    (s) => statusOf(s, "01") === "checkpoint" && statusOf(s, "02") === "in-progress",
  );
  writeFileSync(release, "go");
  const settled = await settle(server, "03 done", (s) => statusOf(s, "03") === "done");
  await socket.sync();

  expect(settled.state.log.filter((line) => line === "ticket 01: exited 0, marker checkpoint")).toHaveLength(1);
  expect(statuses(settled)).toEqual({ "01": "checkpoint", "02": "done", "03": "done" });
  expect(settled.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "checkpoint"]]);
  expectParsedEqual(socket.pushed!.snapshot, await snapshotOf(server), "the last frame's snapshot");
});

/** The Brief the engine lands for a checkpoint that wrote none, and the Interrupt's body. */
const PLACEHOLDER =
  "The agent signalled a checkpoint but wrote no brief, so what the attempt completed is only in the " +
  "ticket log. Answer the interrupt to point the next attempt.";

/** issues/01-a.md after a checkpoint with no brief, its body `# body`. */
const PLACEHOLDER_FILE =
  "<!-- state: id=01 blocked-by=none status=checkpoint -->\n\n# body\n\n---\n\n" +
  `## Brief, written by the engine\n\n${PLACEHOLDER}\n`;
