/**
 * Adopting Spawn proposals at the super-step boundary (ADR-0010, ADR-0029):
 * the Ticket files written, the Assignment a proposal requests, rejections,
 * and the Spawn caps.
 */

import { expect } from "bun:test";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { readStateLine, readTicketFile } from "../harness/pool-files.ts";
import type { EnrichedSnapshot } from "../../engine/wire.ts";
import type { World } from "../harness/world.ts";
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

/** The argv a Ticket's first Attempt launched on, from its spawned event. */
function spawnedArgv(world: World, id: string): string[] {
  const spawned = eventsOf(world, id, "spawned")[0];
  if (!spawned) throw new Error(`runs/${id}.events.jsonl has no spawned event`);
  return spawned.payload.argv as string[];
}

/** A flag and its value out of an argv, or [] when the flag is absent. */
function flag(argv: string[], name: string): string[] {
  const at = argv.indexOf(name);
  return at < 0 ? [] : argv.slice(at, at + 2);
}

/** The launches the stubs recorded for one key. */
function launches(world: World, key: string) {
  return world.stubs.calls().filter((call) => call.key === key);
}

/** Every Ticket's status in a snapshot, by id. */
function statuses(snap: EnrichedSnapshot): Record<string, string> {
  return Object.fromEntries(snap.state.tickets.map((ticket) => [ticket.id, ticket.status]));
}

const encoded = (assign: Record<string, unknown>) => encodeURIComponent(JSON.stringify(assign));

conformance(
  "spawns",
  "writes valid proposals as ordinary tickets and schedules them once their blockers finish",
  async (t) => {
    const world = t.world({ tickets: [ticket("01"), ticket("02", "01")], config: CONFIG });
    world.stubs.script("01", { spawn: [proposal("After two", { blockedBy: ["02"] }), proposal("Anytime")] });
    const server = await t.start(world);

    const done = await runAndApprove(server);

    expect(hasTicket(world, "01-spawn-1.md")).toBe(true);
    expect(hasTicket(world, "01-spawn-2.md")).toBe(true);
    // The engine assigned the ids and the markers: the ordinary blocking
    // edge, engine-owned status, and the spawned-by provenance.
    expectSameBytes(
      readStateLine(world.pool, "01-spawn-1.md").line,
      "<!-- state: id=01-spawn-1 blocked-by=02 status=done spawned-by=01 -->",
      "01-spawn-1's state line",
    );
    expectSameBytes(
      readStateLine(world.pool, "01-spawn-2.md").line,
      "<!-- state: id=01-spawn-2 blocked-by=none status=done spawned-by=01 -->",
      "01-spawn-2's state line",
    );
    expect(readTicketFile(world.pool, "01-spawn-1.md")).toContain("# 01-spawn-1: After two");
    // Both ran as ordinary Tickets. A Ticket that shared its super-step ran
    // in a worktree of the git pool, so its branch merged after it.
    for (const id of ["01-spawn-1", "01-spawn-2"]) {
      expect(eventKinds(world, id).filter((kind) => kind !== "merged")).toEqual(["scheduled", "spawned", "exited"]);
    }
    expect(statuses(done)).toEqual({
      "01": "done",
      "02": "done",
      "01-spawn-1": "done",
      "01-spawn-2": "done",
    });
  },
);

conformance(
  "spawns",
  "launches a ticket-proposed child on the proposal's assign, persisted on its marker",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01")],
      config: { defaults: { harness: "claude", model: "m", effort: "high" } },
    });
    world.stubs.script("01", {
      spawn: [proposal("Harder", { assign: { model: "child-model", effort: "max" } })],
    });
    const server = await t.start(world);

    const done = await runAndApprove(server);

    expect(statuses(done)["01-spawn-1"]).toBe("done");
    expect(readStateLine(world.pool, "01-spawn-1.md").line).toEndWith(
      `spawned-by=01 spawn-assign=${encoded({ model: "child-model", effort: "max" })} -->`,
    );
    expect(flag(spawnedArgv(world, "01"), "--effort")).toEqual(["--effort", "high"]);
    expect(flag(spawnedArgv(world, "01-spawn-1"), "--effort")).toEqual(["--effort", "max"]);
    const child = launches(world, "01-spawn-1");
    expect(child).toHaveLength(1);
    expect(flag(child[0]!.argv, "--model")).toEqual(["--model", "child-model"]);
    expect(flag(child[0]!.argv, "--effort")).toEqual(["--effort", "max"]);
    expect(flag(launches(world, "01")[0]!.argv, "--effort")).toEqual(["--effort", "high"]);
  },
);

conformance("spawns", "writes no spawn-assign for a proposal with no assign, so the child inherits", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: { ...CONFIG, assign: { "01": { effort: "low" } } },
  });
  world.stubs.script("01", { spawn: [proposal("Plain")] });
  const server = await t.start(world);

  await runAndApprove(server);

  expect(readStateLine(world.pool, "01-spawn-1.md").line).not.toContain("spawn-assign");
  expect(flag(spawnedArgv(world, "01-spawn-1"), "--effort")).toEqual(["--effort", "low"]);
});

conformance("spawns", "ignores a proposal's assign.verify, landing the rest with a log line", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("Graded?", { assign: { effort: "max", verify: 3 } })] });
  const server = await t.start(world);

  const done = await runAndApprove(server);

  expect(await poolLog(server)).toContain(
    "ticket 01: spawn proposal 'Graded?' asked for assign.verify; " +
      "ignored, since whether a Ticket is graded is the operator's call",
  );
  expect(readStateLine(world.pool, "01-spawn-1.md").line).toEndWith(
    `spawn-assign=${encoded({ effort: "max" })} -->`,
  );
  // One ordinary Attempt, no candidates fanned out and no grader.
  expect(statuses(done)["01-spawn-1"]).toBe("done");
  expect(Object.keys(statuses(done)).filter((id) => id.includes("grader"))).toEqual([]);
  expect(world.stubs.calls().filter((call) => call.key.startsWith("01-spawn-1")).map((call) => call.key)).toEqual([
    "01-spawn-1",
  ]);
  expect(eventKinds(world, "01")).not.toContain("spawn-rejected");
});

// 02 is held open on a release file, so the snapshot can be read while it
// runs and the adopted Ticket waits on it.
conformance("spawns", "holds a proposal blocked by an in-flight ticket until the blocker finishes", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", "01")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("After two", { blockedBy: ["02"] })] });
  const gate = releaseFile(world, "02");
  world.stubs.script("02", { waitFor: gate.path });
  const server = await t.start(world);

  const waiting = await snapshotUntil(
    server,
    (snap) => statuses(snap)["01-spawn-1"] !== undefined && statuses(snap)["02"] === "in-progress",
    "01-spawn-1 adopted while 02 runs",
  );
  expect(statuses(waiting)["01-spawn-1"]).toBe("ready");
  gate.release();

  await runAndApprove(server);
  const log = await poolLog(server);
  expect(log).toContain("super-step 1: 01");
  expect(log).toContain("super-step 2: 02");
  expect(log).toContain("super-step 3: 01-spawn-1");
});

conformance(
  "spawns",
  "drops a proposal whose blockedBy names an unknown ticket, with the reason on the ticket log",
  async (t) => {
    const world = t.world({ tickets: [ticket("01")], config: CONFIG });
    world.stubs.script("01", { spawn: [proposal("Ghost", { blockedBy: ["99"] })] });
    const server = await t.start(world);

    await runAndApprove(server);

    // The attempt's own done stands; the proposal is gone with its reason.
    expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
    expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
    expect(eventsOf(world, "01", "spawn-rejected")[0]?.payload).toMatchObject({
      title: "Ghost",
      reason: "blockedBy names tickets outside the pool: 99",
    });
    expect(await poolLog(server)).toContain(
      "ticket 01: spawn proposal 'Ghost' rejected: blockedBy names tickets outside the pool: 99",
    );
  },
);

conformance("spawns", "drops a thin-body proposal with the reason on the ticket log", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [{ title: "Thin", body: "too thin" }] });
  const server = await t.start(world);

  await runAndApprove(server);

  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
  expect(eventsOf(world, "01", "spawn-rejected")[0]?.payload).toMatchObject({
    index: 0,
    reason: "proposal body is missing or thin (needs 20+ characters)",
  });
});

conformance("spawns", "holds the proposals beyond the per-attempt cap of five for the operator", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [1, 2, 3, 4, 5, 6, 7].map((n) => proposal(`Number ${n}`)) });
  const server = await t.start(world);

  const done = await runAndApprove(server);

  for (const n of [1, 2, 3, 4, 5]) expect(hasTicket(world, `01-spawn-${n}.md`)).toBe(true);
  expect(hasTicket(world, "01-spawn-6.md")).toBe(false);
  expect(hasTicket(world, "01-spawn-7.md")).toBe(false);
  expect(eventsOf(world, "01", "spawn-adopted")[0]?.payload).toEqual({
    adopted: ["01-spawn-1", "01-spawn-2", "01-spawn-3", "01-spawn-4", "01-spawn-5"],
    fromPending: ["proposal-1", "proposal-2", "proposal-3", "proposal-4", "proposal-5"],
  });
  expect(eventsOf(world, "01", "spawn-held")[0]?.payload).toEqual({
    held: [
      { id: "proposal-6", title: "Number 6", reason: "per-attempt" },
      { id: "proposal-7", title: "Number 7", reason: "per-attempt" },
    ],
  });
  expect(done.heldSpawns.map((h) => [h.id, h.parentId, h.title, h.reason])).toEqual([
    ["proposal-6", "01", "Number 6", "per-attempt"],
    ["proposal-7", "01", "Number 7", "per-attempt"],
  ]);
  const log = await poolLog(server);
  expect(log).toContain(
    "ticket 01: 2 proposals held at the caps (5 per attempt, 20 per run): proposal-6, proposal-7",
  );
  expect(log).toContain(
    "ticket 01: adopted spawn tickets 01-spawn-1, 01-spawn-2, 01-spawn-3, 01-spawn-4, 01-spawn-5",
  );
});

conformance("spawns", "holds what the per-run cap of twenty has no room for across attempts", async (t) => {
  const parents = ["01", "02", "03", "04", "05"];
  const world = t.world({ tickets: parents.map((id) => ticket(id)), config: CONFIG });
  for (const id of parents) {
    world.stubs.script(id, { spawn: [1, 2, 3, 4, 5, 6, 7].map((n) => proposal(`N${n}`)) });
  }
  const server = await t.start(world);

  const done = await runAndApprove(server, 45_000);

  // Twenty files land, five per parent for whichever four parents reached
  // the boundary first; the fifth finds no room left in the run cap.
  const files = parents.flatMap((id) => [1, 2, 3, 4, 5, 6, 7].map((n) => `${id}-spawn-${n}.md`));
  expect(files.filter((file) => hasTicket(world, file))).toHaveLength(20);
  // Which parent found the run full is racy; that exactly one did, with
  // all seven held, is not.
  const heldReasons = parents.map((id) =>
    eventsOf(world, id, "spawn-held").flatMap((e) => (e.payload.held as { reason: string }[]).map((h) => h.reason)),
  );
  expect(heldReasons.filter((reasons) => reasons.length === 2)).toEqual(
    Array.from({ length: 4 }, () => ["per-attempt", "per-attempt"]),
  );
  expect(heldReasons.filter((reasons) => reasons.length === 7)).toEqual([
    ["per-run", "per-run", "per-run", "per-run", "per-run", "per-attempt", "per-attempt"],
  ]);
  expect(done.heldSpawns).toHaveLength(15);
  expect(done.spawnUsage.spawnedThisRun).toBe(20);
}, { timeoutMs: 90_000 });

conformance("spawns", "discards a held spawn for good, recorded on the parent's log", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: withCaps({ perAttempt: 1 }) });
  world.stubs.script("01", { spawn: [proposal("Kept"), proposal("Unwanted")] });
  const server = await t.start(world);

  const quiet = await settled(server);
  expect(quiet.heldSpawns.map((h) => [h.id, h.title])).toEqual([["proposal-2", "Unwanted"]]);

  const discard = await server.http.post("/api/spawns/held/discard", { id: "proposal-2" });
  expect(discard.status).toBe(200);
  expect(discard.json<unknown>()).toEqual({ id: "proposal-2" });
  expect((await snapshot(server)).heldSpawns).toEqual([]);
  expect(eventsOf(world, "01", "spawn-discarded").map((e) => e.payload)).toEqual([
    { id: "proposal-2", title: "Unwanted" },
  ]);
  expect(await poolLog(server)).toContain("ticket 01: held spawn proposal-2 ('Unwanted') discarded by the operator");

  const again = await server.http.post("/api/spawns/held/discard", { id: "proposal-2" });
  expect(again.status).toBe(409);
  expect(again.json<unknown>()).toEqual({ reason: "no held spawn proposal-2" });

  await server.stop();
  const restarted = await t.start(world);
  expect((await settled(restarted, "the restarted pool to settle")).heldSpawns).toEqual([]);
}, { timeoutMs: 90_000 });
