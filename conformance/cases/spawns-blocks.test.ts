import { expect } from "bun:test";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import {
  CONFIG,
  eventKinds,
  eventsOf,
  hasTicket,
  ledger,
  poolLog,
  proposal,
  releaseFile,
  runAndApprove,
  settled,
  snapshot,
  snapshotUntil,
  ticket,
  withCaps,
} from "./spawns-support.ts";

/** Each Ticket's status on a snapshot, by id. */
function statuses(snap: EnrichedSnapshot): Record<string, string> {
  return Object.fromEntries(snap.state.tickets.map((entry) => [entry.id, entry.status]));
}

/** Whether some pool log line carries `text`. */
function logged(lines: string[], text: string): boolean {
  return lines.some((line) => line.includes(text));
}

/** The index of the first pool log line carrying `text`, or -1. */
function loggedAt(lines: string[], text: string): number {
  return lines.findIndex((line) => line.includes(text));
}

conformance("spawns", "refuses an Adopt whose blocks names a done ticket, and keeps the spawn held", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02", "01")],
    config: withCaps({ perAttempt: 1 }),
  });
  world.stubs.script("01", {
    spawn: [proposal("Adopted"), proposal("Fix before two", { blocks: ["02"] })],
  });
  const server = await t.start(world);

  await snapshotUntil(
    server,
    (snap) =>
      snap.phase === "quiescent" && statuses(snap)["02"] === "done" && snap.heldSpawns.some((h) => h.id === "proposal-2"),
    "02 done with proposal-2 held",
  );
  const adopt = await server.http.post("/api/spawns/held/adopt", { id: "proposal-2" });
  expect(adopt.status).toBe(409);
  expect(adopt.json<{ reason: string }>()).toEqual({
    reason: "held spawn proposal-2 cannot be adopted: blocks names done tickets, which have no next attempt to hold: 02",
  });

  const after = await snapshot(server);
  expect(after.heldSpawns).toEqual([expect.objectContaining({ id: "proposal-2", adopting: false })]);
  expect(hasTicket(world, "01-spawn-2.md")).toBe(false);
  await server.stop();

  const again = await t.start(world);
  const restarted = await settled(again);
  expect(restarted.heldSpawns.map((h) => h.id)).toEqual(["proposal-2"]);
});

conformance("spawns", "holds a spawn whose blocks names a running ticket as started, then lands it on Adopt", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02"), ticket("03", "02")],
    config: CONFIG,
  });
  const releaseOne = releaseFile(world, "01");
  const releaseTwo = releaseFile(world, "02");
  world.stubs.script("01", {
    waitFor: releaseOne.path,
    spawn: [proposal("Before two", { blocks: ["02"] }), proposal("Before two and three", { blocks: ["02", "03"] })],
  });
  world.stubs.script("02", { waitFor: releaseTwo.path });
  const server = await t.start(world);

  await snapshotUntil(
    server,
    (snap) => statuses(snap)["01"] === "in-progress" && statuses(snap)["02"] === "in-progress",
    "01 and 02 both running",
  );
  releaseOne.release();
  const held = await snapshotUntil(server, (snap) => snap.heldSpawns.length === 2, "both spawns held");
  expect(held.heldSpawns.map((h) => [h.id, h.reason])).toEqual([
    ["proposal-1", "started"],
    ["proposal-2", "started"],
  ]);
  expect(held.heldSpawns.map((h) => [h.id, h.startedIds])).toEqual([
    ["proposal-1", ["02"]],
    ["proposal-2", ["02"]],
  ]);
  expect(held.pendingSpawns).toEqual([]);
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
  expectSameBytes(
    readStateLine(world.pool, "02-t.md").line,
    "<!-- state: id=02 blocked-by=none status=in-progress -->",
    "02's state line",
  );
  expectSameBytes(
    readStateLine(world.pool, "03-t.md").line,
    "<!-- state: id=03 blocked-by=02 status=ready -->",
    "03's state line",
  );
  expect(eventsOf(world, "01", "spawn-held").map((e) => e.payload)).toEqual([
    { held: [{ id: "proposal-1", title: "Before two", reason: "started", startedIds: ["02"] }] },
    { held: [{ id: "proposal-2", title: "Before two and three", reason: "started", startedIds: ["02"] }] },
  ]);
  expect(logged(await poolLog(server), "ticket 01: proposal-1 ('Before two') held: it blocks 02, which has started")).toBe(
    true,
  );
  expect(ledger(world)).toContain("| proposal-1 | 01 | ticket | blocks 02, which has started | Before two |");

  expect((await server.http.post("/api/spawns/held/adopt", { id: "proposal-1" })).status).toBe(202);
  await snapshotUntil(server, (snap) => statuses(snap)["01-spawn-1"] !== undefined, "01-spawn-1 landed while 02 runs");
  expect((await server.http.post("/api/spawns/held/adopt", { id: "proposal-2" })).status).toBe(202);
  const landed = await snapshotUntil(
    server,
    (snap) => statuses(snap)["01-spawn-2"] !== undefined,
    "01-spawn-2 landed while 02 runs",
  );
  expect(landed.heldSpawns).toEqual([]);
  expect(statuses(landed)["02"]).toBe("in-progress");
  expectSameBytes(
    readStateLine(world.pool, "02-t.md").line,
    "<!-- state: id=02 blocked-by=none status=in-progress -->",
    "02's state line",
  );
  expectSameBytes(
    readStateLine(world.pool, "03-t.md").line,
    "<!-- state: id=03 blocked-by=02,01-spawn-2 status=ready -->",
    "03's state line",
  );
  expect(logged(await poolLog(server), "ticket 01-spawn-2: not blocking 02, which has started")).toBe(true);
  releaseTwo.release();

  await runAndApprove(server);
  expect(eventKinds(world, "02").filter((kind) => kind === "spawned")).toHaveLength(1);
  expect(readStateLine(world.pool, "01-spawn-2.md").status).toBe("done");
  expect(readStateLine(world.pool, "03-t.md").status).toBe("done");
});

conformance("spawns", "lands a spawn whose blocks names a checkpoint ticket that never launched, and blocks it", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("03")],
    config: { assign: { "01": { harness: "claude", model: "m" } } },
  });
  const release = releaseFile(world, "01");
  world.stubs.script("01", { waitFor: release.path, spawn: [proposal("Before three", { blocks: ["03"] })] });
  const server = await t.start(world);

  await snapshotUntil(
    server,
    (snap) => statuses(snap)["03"] === "checkpoint" && statuses(snap)["01"] === "in-progress",
    "03 at its config checkpoint while 01 runs",
  );
  expect(eventKinds(world, "03")).toEqual(["unassigned"]);
  release.release();

  const landed = await snapshotUntil(server, (snap) => statuses(snap)["01-spawn-1"] !== undefined, "01-spawn-1 landed");
  expect(landed.heldSpawns).toEqual([]);
  expectSameBytes(
    readStateLine(world.pool, "03-t.md").line,
    "<!-- state: id=03 blocked-by=01-spawn-1 status=checkpoint -->",
    "03's state line",
  );
  expect(logged(await poolLog(server), "has started")).toBe(false);
});

conformance("spawns", "lands an Adopt of a cap-held spawn whose blocks names a running ticket without blocking it", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02", "01")],
    config: withCaps({ perAttempt: 1 }),
  });
  const release = releaseFile(world, "02");
  world.stubs.script("01", {
    spawn: [proposal("Adopted"), proposal("Fix before two", { blocks: ["02"] })],
  });
  world.stubs.script("02", { waitFor: release.path });
  const server = await t.start(world);

  await snapshotUntil(
    server,
    (snap) => statuses(snap)["02"] === "in-progress" && snap.heldSpawns.some((h) => h.id === "proposal-2"),
    "02 running with proposal-2 held",
  );
  const adopt = await server.http.post("/api/spawns/held/adopt", { id: "proposal-2" });
  expect(adopt.status).toBe(202);
  const landed = await snapshotUntil(
    server,
    (snap) => statuses(snap)["01-spawn-2"] !== undefined,
    "01-spawn-2 landed while 02 runs",
  );
  expect(landed.heldSpawns).toEqual([]);
  expect(statuses(landed)["02"]).toBe("in-progress");
  expectSameBytes(
    readStateLine(world.pool, "02-t.md").line,
    "<!-- state: id=02 blocked-by=01 status=in-progress -->",
    "02's state line",
  );
  release.release();

  await runAndApprove(server);
  expect(eventKinds(world, "02").filter((kind) => kind === "spawned")).toHaveLength(1);
  expect(readStateLine(world.pool, "01-spawn-2.md").status).toBe("done");
});

conformance(
  "spawns",
  "reads the caps from the pool config field by field and carries the usage on the snapshot",
  async (t) => {
    const world = t.world({ tickets: [ticket("01")], config: withCaps({ perAttempt: 2 }) });
    world.stubs.script("01", { spawn: [1, 2, 3].map((n) => proposal(`N${n}`)) });
    const server = await t.start(world);

    const done = await runAndApprove(server);
    expect(hasTicket(world, "01-spawn-1.md")).toBe(true);
    expect(hasTicket(world, "01-spawn-2.md")).toBe(true);
    expect(hasTicket(world, "01-spawn-3.md")).toBe(false);
    expect(done.spawnUsage).toEqual({ spawnedThisRun: 2, perAttempt: 2, perRun: 20 });
  },
);

// 01 is held on a release file so the first snapshot is read before it
// proposes anything.
conformance("spawns", "counts the run cap from this boot, not from the spawned tickets already on disk", async (t) => {
  const earlier = [1, 2, 3].map((n) => ({
    file: `00-spawn-${n}.md`,
    marker: `<!-- state: id=00-spawn-${n} blocked-by=none status=done spawned-by=00 -->`,
  }));
  const world = t.world({
    tickets: [ticket("00", "none", "done"), ...earlier, ticket("01")],
    config: withCaps({ perRun: 3 }),
  });
  const release = releaseFile(world, "01");
  world.stubs.script("01", { waitFor: release.path, spawn: [proposal("After the restart")] });
  const server = await t.start(world);

  expect((await snapshot(server)).spawnUsage.spawnedThisRun).toBe(0);
  release.release();
  const done = await runAndApprove(server);
  expect(hasTicket(world, "01-spawn-1.md")).toBe(true);
  expect(done.spawnUsage.spawnedThisRun).toBe(1);
});

conformance("spawns", "adds a spawn that blocks named tickets to their blocked-by, so it runs first", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02", "01"), ticket("03", "01")],
    config: CONFIG,
  });
  world.stubs.script("01", { spawn: [proposal("Fix first", { blocks: ["02"] })] });
  const server = await t.start(world);

  await runAndApprove(server);
  expectSameBytes(
    readStateLine(world.pool, "02-t.md").line,
    "<!-- state: id=02 blocked-by=01,01-spawn-1 status=done -->",
    "02's state line",
  );
  expectSameBytes(
    readStateLine(world.pool, "03-t.md").line,
    "<!-- state: id=03 blocked-by=01 status=done -->",
    "03's state line",
  );
  const log = await poolLog(server);
  const started = (id: string) => loggedAt(log, `start ${id} at `);
  expect(started("01")).toBeGreaterThanOrEqual(0);
  expect(started("03")).toBeGreaterThan(started("01"));
  expect(started("01-spawn-1")).toBeGreaterThan(started("01"));
  expect(started("02")).toBeGreaterThan(started("01-spawn-1"));
  expect(logged(log, "ticket 01: spawn 01-spawn-1 blocks 02")).toBe(true);
  expect(eventsOf(world, "01", "spawn-adopted")[0]!.payload).toEqual({
    adopted: ["01-spawn-1"],
    fromPending: ["proposal-1"],
    blocks: { "01-spawn-1": ["02"] },
  });
});

conformance(
  "spawns",
  "blocks every ticket not yet started when a spawn blocks all, except its own blockers",
  async (t) => {
    const world = t.world({
      tickets: [ticket("00", "none", "done"), ticket("01"), ticket("02", "01"), ticket("03", "01"), ticket("04", "03")],
      config: CONFIG,
    });
    world.stubs.script("01", {
      spawn: [proposal("After four's blockers", { blockedBy: ["04"], blocks: "all" }), proposal("A sibling")],
    });
    const server = await t.start(world);

    await runAndApprove(server);
    // 03 and 04 are the spawn's own blockers: blocking them would deadlock.
    expect(readStateLine(world.pool, "02-t.md").blockedBy).toEqual(["01", "01-spawn-1"]);
    expect(readStateLine(world.pool, "03-t.md").blockedBy).toEqual(["01"]);
    expect(readStateLine(world.pool, "04-t.md").blockedBy).toEqual(["03"]);
    expect(readStateLine(world.pool, "00-t.md").blockedBy).toEqual([]);
    const sibling = readStateLine(world.pool, "01-spawn-2.md");
    expect(sibling.blockedBy).toEqual(["01-spawn-1"]);
    expect(eventsOf(world, "01", "spawn-adopted")[0]!.payload).toEqual({
      adopted: ["01-spawn-1", "01-spawn-2"],
      fromPending: ["proposal-1", "proposal-2"],
      blocks: { "01-spawn-1": ["01-spawn-2", "02"] },
    });
  },
);

conformance("spawns", "rejects a spawn whose named blocks are unknown, done, or would make a cycle", async (t) => {
  const world = t.world({
    tickets: [ticket("00", "none", "done"), ticket("01"), ticket("02", "01"), ticket("03", "02")],
    config: CONFIG,
  });
  world.stubs.script("01", {
    spawn: [
      proposal("Ghost", { blocks: ["99"] }),
      proposal("Too late", { blocks: ["00"] }),
      proposal("Circular", { blockedBy: ["03"], blocks: ["02"] }),
    ],
  });
  const server = await t.start(world);

  await runAndApprove(server);
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
  expect(eventsOf(world, "01", "spawn-rejected").map((e) => [e.payload.title, e.payload.reason])).toEqual([
    ["Ghost", "blocks names tickets outside the pool: 99"],
    ["Too late", "blocks names done tickets, which have no next attempt to hold: 00"],
    ["Circular", "blocks names tickets this proposal already waits on, a cycle: 02"],
  ]);
});

conformance("spawns", "lets a spawned ticket's own attempt spawn further tickets", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("Child")] });
  world.stubs.script("01-spawn-1", { spawn: [proposal("Grandchild")] });
  const server = await t.start(world);

  const done = await runAndApprove(server);
  const grandchild = readStateLine(world.pool, "01-spawn-1-spawn-1.md");
  expect(grandchild.line).toContain("id=01-spawn-1-spawn-1 blocked-by=none");
  expect(grandchild.line).toContain("spawned-by=01-spawn-1");
  expect(statuses(done)).toEqual({ "01": "done", "01-spawn-1": "done", "01-spawn-1-spawn-1": "done" });
});

conformance("spawns", "ignores a grader's spawn and adopts the passing attempt's own proposals", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: { ...CONFIG, assign: { "01": { verify: 1 } } },
  });
  world.stubs.script("01.attempt-1", { spawn: [proposal("From the attempt")] });
  world.stubs.script("01-grader-1", {
    grade: { score: 9, verdict: "pass", reasons: "fine" },
    spawn: [proposal("From the grader")],
  });
  const server = await t.start(world);

  const done = await runAndApprove(server);
  // The grader ran and proposed; grader outcomes are engine-consumed, so
  // its spawn key is ignored.
  expect(world.stubs.calls().map((call) => call.key)).toEqual(["01.attempt-1", "01-grader-1", "01-spawn-1"]);
  expect(hasTicket(world, "01-grader-1-spawn-1.md")).toBe(false);
  expect(readStateLine(world.pool, "01-spawn-1.md").line).toContain("spawned-by=01");
  expect(statuses(done)["01-spawn-1"]).toBe("done");
});

conformance("spawns", "ignores a spawn key on the head-to-head outcome", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: { ...CONFIG, assign: { "01": { verify: 2 } } },
  });
  world.stubs.script("01.attempt-1", { spawn: [proposal("From the winner")] });
  world.stubs.script("01-grader-1", { grade: { score: 8, verdict: "pass", reasons: "scored 8" } });
  world.stubs.script("01-grader-2", { grade: { score: 7, verdict: "pass", reasons: "scored 7" } });
  world.stubs.script("01-head-to-head", { winner: 1, spawn: [proposal("From the judge")] });
  const server = await t.start(world);

  const done = await runAndApprove(server);
  expect(eventsOf(world, "01", "selected")[0]?.attempt).toBe(1);
  expect(world.stubs.calls().map((call) => call.key)).toContain("01-head-to-head");
  expect(hasTicket(world, "01-head-to-head-spawn-1.md")).toBe(false);
  expect(statuses(done)["01"]).toBe("done");
  expect(readStateLine(world.pool, "01-spawn-1.md").line).toContain("spawned-by=01");
});

conformance("spawns", "does not adopt a crashed attempt's proposals", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { exitCode: 3, spawn: [proposal("From a crash")] });
  const server = await t.start(world);

  const quiet = await settled(server);
  expect(quiet.phase).toBe("quiescent");
  expect(quiet.state.interrupts.map((i) => i.kind)).toEqual(["crash"]);
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
});

conformance("spawns", "does not report done while a freshly spawned ready ticket still runs", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("The real end")] });
  const server = await t.start(world);

  await runAndApprove(server);
  const log = await poolLog(server);
  const first = loggedAt(log, "start 01 at ");
  const second = loggedAt(log, "start 01-spawn-1 at ");
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);
  expect(eventKinds(world, "01-spawn-1")).toEqual(["scheduled", "spawned", "exited", "merged"]);
  expect(readStateLine(world.pool, "01-spawn-1.md").status).toBe("done");
});

conformance("spawns", "adopts a checkpoint attempt's proposals while the run pauses on the interrupt", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { status: "checkpoint", brief: "pick a name", spawn: [proposal("While paused")] });
  const server = await t.start(world);

  await until(
    () => (hasTicket(world, "01-spawn-1.md") ? readStateLine(world.pool, "01-spawn-1.md").status : ""),
    (status) => status === "done",
    { what: "01-spawn-1 to run to done", ms: 20_000 },
  );
  const quiet = await settled(server);
  expect(quiet.phase).toBe("quiescent");
  expect(quiet.state.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
  expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
});

conformance("spawns", "grades a spawned ticket whose assign sets verify", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: { ...CONFIG, assign: { "01-spawn-1": { verify: 1 } } },
  });
  world.stubs.script("01", { spawn: [proposal("Graded child")] });
  const server = await t.start(world);

  await runAndApprove(server);
  expect(readStateLine(world.pool, "01-spawn-1-grader-1.md").status).toBe("done");
  expect(readStateLine(world.pool, "01-spawn-1.md").status).toBe("done");
  expect(eventKinds(world, "01-spawn-1")).toContain("graded");
});
