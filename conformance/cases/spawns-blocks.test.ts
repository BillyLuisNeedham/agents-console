/**
 * Spawn adoption past the first boundary: held Adopts the boundary refuses,
 * caps from config, blocks, grandchildren, graders and head-to-head, crashed
 * and checkpoint attempts.
 */

import { expect } from "bun:test";
import type { EnrichedSnapshot, HeldSpawnResponse } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import {
  CONFIG,
  eventKinds,
  eventsOf,
  hasTicket,
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

// 02 is held on a release file so the Adopt passes its check while 02 still
// runs; by the boundary that would land it, 02 is done and has no next
// attempt to hold.
conformance("spawns", "keeps a held spawn whose Adopt the boundary refuses, with the reason on it", async (t) => {
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
  expect(adopt.json<HeldSpawnResponse>()).toEqual({ id: "proposal-2" });
  await snapshotUntil(
    server,
    (snap) => snap.heldSpawns.some((h) => h.id === "proposal-2" && h.adopting),
    "proposal-2 to show adopting",
  );
  release.release();

  const reason = "blocks names done tickets, which have no next attempt to hold: 02";
  const after = await snapshotUntil(
    server,
    (snap) => snap.heldSpawns.some((h) => h.adoptError !== undefined),
    "the refused Adopt's reason on the held spawn",
  );
  expect(after.heldSpawns).toEqual([
    expect.objectContaining({ id: "proposal-2", adopting: false, adoptError: reason }),
  ]);
  expect(hasTicket(world, "01-spawn-2.md")).toBe(false);
  expect(eventsOf(world, "01", "spawn-rejected").at(-1)!.payload).toEqual({
    title: "Fix before two",
    reason,
    fromHeld: "proposal-2",
  });
  expect(await poolLog(server)).toContainEqual(
    expect.stringContaining(
      `ticket 01: adopting held spawn proposal-2 ('Fix before two') refused: ${reason}; it stays held`,
    ),
  );
  await settled(server);
  await server.stop();

  // The refusal survives a restart, and the spawn is still there to decide.
  const again = await t.start(world);
  const restarted = await settled(again);
  expect(restarted.heldSpawns.map((h) => [h.id, h.adoptError])).toEqual([["proposal-2", reason]]);
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
  expect(logged(log, "super-step 2: 01-spawn-1, 03")).toBe(true);
  expect(logged(log, "super-step 3: 02")).toBe(true);
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
  const first = loggedAt(log, "super-step 1: 01");
  const second = loggedAt(log, "super-step 2: 01-spawn-1");
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);
  expect(eventKinds(world, "01-spawn-1")).toEqual(["scheduled", "spawned", "exited"]);
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
