/**
 * The Spawn proposal schema in Outcomes, and the reserved '-spawn-'
 * namespace at pool start (ADR-0010, ADR-0036): what an attempt's Outcome
 * may propose, the reason each malformed proposal is rejected with, and
 * which hand-written Ticket files refuse to boot.
 */

import { expect } from "bun:test";
import type { EnrichedSnapshot } from "../../engine/wire.ts";
import type { Case, CaseServer } from "../harness/case.ts";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { readStateLine } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";
import {
  CONFIG,
  eventsOf,
  GOOD_BODY,
  hasTicket,
  proposal,
  runAndApprove,
  settled,
  snapshot,
  snapshotUntil,
  ticket,
  withCaps,
} from "./spawns-support.ts";

const THIN = "proposal body is missing or thin (needs 20+ characters)";
const BAD_BLOCKS = 'proposal\'s blocks is not a list of ticket ids or "all"';

/** Two-digit Ticket ids, 01 to n. */
function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String(i + 1).padStart(2, "0"));
}

/** The payloads of a Ticket's spawn-rejected events, in order. */
function rejections(world: World, id: string): unknown[] {
  return eventsOf(world, id, "spawn-rejected").map((event) => event.payload);
}

/** Start a server that must refuse to boot; its error carries the log tail. */
async function refusedStart(t: Case, world: World): Promise<string> {
  try {
    await t.start(world);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("the server booted on a pool it should have refused");
}

/** Settle on one Ticket's checkpoint interrupt, with nothing left running. */
function checkpointSettled(server: CaseServer, id: string): Promise<EnrichedSnapshot> {
  return snapshotUntil(
    server,
    (snap) =>
      snap.phase === "quiescent" &&
      snap.state.interrupts.some((i) => i.ticketId === id && i.kind === "checkpoint") &&
      snap.state.tickets.every((tk) => tk.status !== "ready" && tk.status !== "in-progress"),
    `${id}'s checkpoint interrupt`,
  );
}

/** One pool with a ready Ticket per proposal shape, each proposing that one shape. */
async function onePerShape(t: Case, shapes: unknown[]): Promise<{ world: World; snap: EnrichedSnapshot }> {
  const all = ids(shapes.length);
  const world = t.world({ tickets: all.map((id) => ticket(id)), config: CONFIG });
  shapes.forEach((shape, i) => world.stubs.script(all[i]!, { spawn: [shape] }));
  const server = await t.start(world);
  const snap = await runAndApprove(server);
  return { world, snap };
}

conformance("spawns", "accepts a spawn array and preserves each proposal's shape", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  const spawn = [
    { title: "Follow up", body: GOOD_BODY, blockedBy: ["02"] },
    { title: "No blockers", body: GOOD_BODY, blockedBy: [] },
    { title: "Blockers omitted", body: GOOD_BODY },
  ];
  world.stubs.script("01", { spawn });
  const server = await t.start(world);
  const snap = await runAndApprove(server);

  expect(snap.state.outcomes["01"]?.spawn).toEqual(spawn);
  expect(Object.keys(snap.state.outcomes["01"]?.spawn?.[2] ?? {})).toEqual(["title", "body"]);
  expect(rejections(world, "01")).toEqual([]);
});

conformance("spawns", "keeps an empty spawn array without rejections", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [] });
  const server = await t.start(world);
  const snap = await runAndApprove(server);

  expect(snap.state.outcomes["01"]?.spawn).toEqual([]);
  expect(rejections(world, "01")).toEqual([]);
});

conformance("spawns", "rejects a spawn key that is not an array", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: "yes" });
  const server = await t.start(world);
  const snap = await runAndApprove(server);

  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  expect(snap.state.outcomes["01"]?.spawn).toEqual([]);
  expect(rejections(world, "01")).toEqual([{ reason: "spawn is not an array" }]);
});

conformance("spawns", "rejects a malformed spawn entry per proposal with a clear reason", async (t) => {
  const shapes: { entry: unknown; reason: string }[] = [
    { entry: { body: GOOD_BODY }, reason: "proposal has no title" },
    { entry: { title: "   ", body: GOOD_BODY }, reason: "proposal has no title" },
    { entry: { title: "No body" }, reason: THIN },
    { entry: { title: "No body", body: "   " }, reason: THIN },
    { entry: { title: "Thin", body: "too thin" }, reason: THIN },
    { entry: { title: "T", body: GOOD_BODY, blockedBy: "02" }, reason: "proposal's blockedBy is not a list of strings" },
    { entry: { title: "T", body: GOOD_BODY, blockedBy: [1] }, reason: "proposal's blockedBy is not a list of strings" },
    { entry: { title: "T", body: GOOD_BODY, blockedBy: ["  "] }, reason: "proposal's blockedBy is not a list of strings" },
    { entry: { title: "T", body: GOOD_BODY, blockedBy: null }, reason: "proposal's blockedBy is not a list of strings" },
    { entry: 42, reason: "spawn entry is not an object" },
    { entry: null, reason: "spawn entry is not an object" },
    { entry: ["x"], reason: "spawn entry is not an object" },
  ];
  const { world, snap } = await onePerShape(t, shapes.map((shape) => shape.entry));

  ids(shapes.length).forEach((id, i) => {
    expect(rejections(world, id), `Ticket ${id}'s rejection`).toEqual([{ index: 0, reason: shapes[i]!.reason }]);
    expect(snap.state.outcomes[id]?.spawn, `Ticket ${id}'s kept proposals`).toEqual([]);
  });
});

// ADR-0029: a proposal may name the Tickets it blocks, or "all". The two
// kept shapes go on to the boundary, where adoption may refuse them for
// reasons of its own; the schema's rejections are the ones with an index.
conformance("spawns", "keeps a proposal's blocks, named or all, and rejects any other shape", async (t) => {
  const kept = [proposal("Named", { blocks: ["02", "03"] }), proposal("Everything", { blocks: "all" })];
  const shapes: { entry: unknown; reason: string | null }[] = [
    { entry: kept[0], reason: null },
    { entry: kept[1], reason: null },
    { entry: proposal("T", { blocks: "02" }), reason: BAD_BLOCKS },
    { entry: proposal("T", { blocks: [""] }), reason: BAD_BLOCKS },
    { entry: proposal("T", { blocks: [2] }), reason: BAD_BLOCKS },
    { entry: proposal("T", { blocks: null }), reason: BAD_BLOCKS },
    {
      entry: proposal("T", { kind: "conversation", blocks: "all" }),
      reason: "proposal's blocks is only for a ticket: a Conversation blocks nothing",
    },
  ];
  const { world, snap } = await onePerShape(t, shapes.map((shape) => shape.entry));

  ids(shapes.length).forEach((id, i) => {
    const { entry, reason } = shapes[i]!;
    const schema = rejections(world, id).filter((payload) => "index" in (payload as object));
    if (reason === null) {
      expect(snap.state.outcomes[id]?.spawn as unknown, `Ticket ${id}'s kept proposal`).toEqual([entry]);
      expect(schema, `Ticket ${id}'s schema rejections`).toEqual([]);
    } else {
      expect(snap.state.outcomes[id]?.spawn, `Ticket ${id}'s kept proposals`).toEqual([]);
      expect(schema, `Ticket ${id}'s rejection`).toEqual([{ index: 0, reason }]);
    }
  });
});

conformance("spawns", "keeps the well-formed entries around a malformed one, naming the bad index", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  const good = { title: "Follow up", body: GOOD_BODY };
  world.stubs.script("01", { spawn: [good, { title: "Thin" }, good] });
  const server = await t.start(world);
  const snap = await runAndApprove(server);

  expect(snap.state.outcomes["01"]?.spawn).toEqual([good, good]);
  expect(rejections(world, "01")).toEqual([{ index: 1, reason: THIN }]);
});

conformance("spawns", "passes an outcome with no spawn key byte-for-byte as today", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  // 01 is unscripted: a done Outcome with no spawn key.
  world.stubs.script("02", { outcomeRaw: JSON.stringify({ status: "checkpoint", summary: "s", brief: "b" }) });
  const server = await t.start(world);
  const snap = await checkpointSettled(server, "02");

  expect(snap.state.outcomes["01"]).toEqual({ status: "done", summary: "summary-01", commitSha: null });
  expect("spawn" in (snap.state.outcomes["01"] ?? {})).toBe(false);
  expect(snap.state.outcomes["02"]).toEqual({ status: "checkpoint", summary: "s", commitSha: null, brief: "b" });
  expect("spawn" in (snap.state.outcomes["02"] ?? {})).toBe(false);
});

conformance("spawns", "carries a valid spawn array through a done attempt untouched", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  const spawn = [{ title: "Follow up", body: GOOD_BODY, blockedBy: ["02"] }];
  world.stubs.script("01", { spawn });
  const server = await t.start(world);
  const snap = await runAndApprove(server);

  expectSameBytes(
    readStateLine(world.pool, "01-t.md").line,
    "<!-- state: id=01 blocked-by=none status=done -->",
    "01's state line",
  );
  expect(snap.state.outcomes["01"]).toEqual({ status: "done", summary: "summary-01", commitSha: null, spawn });
});

conformance("spawns", "keeps a done attempt's result when one spawn entry is malformed", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  const good = { title: "Follow up", body: GOOD_BODY };
  world.stubs.script("01", { spawn: [good, { title: "Thin" }] });
  const server = await t.start(world);
  const snap = await runAndApprove(server);

  expectSameBytes(
    readStateLine(world.pool, "01-t.md").line,
    "<!-- state: id=01 blocked-by=none status=done -->",
    "01's state line",
  );
  expect(eventsOf(world, "01", "exited").map((event) => event.payload)).toEqual([
    { code: 0, status: "done", logTail: [], outcomeExists: true },
  ]);
  expect(snap.state.outcomes["01"]?.spawn).toEqual([good]);
});

conformance("spawns", "raises the checkpoint interrupt unchanged when a checkpoint outcome carries spawn", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { status: "checkpoint", brief: "pick a name", spawn: [proposal("Follow up")] });
  const server = await t.start(world);
  const snap = await checkpointSettled(server, "01");

  expect(snap.phase).toBe("quiescent");
  expect(snap.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "pick a name" }]);
  expectSameBytes(
    readStateLine(world.pool, "01-t.md").line,
    "<!-- state: id=01 blocked-by=none status=checkpoint -->",
    "01's state line",
  );
});

// The proposal kind and assign shapes the schema refuses, beyond the
// engine tests' own rows (engine/engine.ts's validateSpawnProposals).
conformance("spawns", "rejects a proposal whose kind is neither ticket nor conversation", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("Epic", { kind: "epic" })] });
  const server = await t.start(world);
  const snap = await runAndApprove(server);

  expect(rejections(world, "01")).toEqual([
    { index: 0, reason: "proposal's kind must be \"ticket\" or \"conversation\", got 'epic'" },
  ]);
  expect(snap.state.outcomes["01"]?.spawn).toEqual([]);
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
});

conformance("spawns", "rejects a proposal whose assign is not an object or carries a field that is not a string", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", {
    spawn: [proposal("Fast", { assign: "fast" }), proposal("Numbered", { assign: { model: 3 } })],
  });
  const server = await t.start(world);
  const snap = await runAndApprove(server);

  expect(rejections(world, "01")).toEqual([
    { index: 0, reason: "proposal's assign is not an object" },
    { index: 1, reason: "proposal's assign.model is not a string" },
  ]);
  expect(snap.state.outcomes["01"]?.spawn).toEqual([]);
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
  expect(hasTicket(world, "01-spawn-2.md")).toBe(false);
});

conformance("spawns", "falls back to each Spawn cap's default field by field", async (t) => {
  const partial = t.world({ tickets: [ticket("01")], config: withCaps({ perRun: 3 }) });
  const unset = t.world({ tickets: [ticket("01")], config: CONFIG });
  const partialServer = await t.start(partial);
  const unsetServer = await t.start(unset);

  expect((await snapshot(partialServer)).spawnUsage).toEqual({ spawnedThisRun: 0, perAttempt: 5, perRun: 3 });
  expect((await snapshot(unsetServer)).spawnUsage).toEqual({ spawnedThisRun: 0, perAttempt: 5, perRun: 20 });
  await settled(partialServer);
  await settled(unsetServer);
});

const SPAWN_ONE = "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 -->";
const RESERVED = "the '-spawn-' id namespace is reserved for engine-adopted tickets";

/** A Ticket file with exactly this marker and a short body. */
function seed(file: string, marker: string): TicketSeed {
  return { file, marker, body: "# Seeded\n\nbody" };
}

/** A Conversation record as engine/conversations.ts writes one, ended. */
function conversation(id: string): Record<string, string> {
  return {
    [`conversations/${id}.md`]:
      `<!-- conversation: id=${id} status=ended spawned-by=none harness=claude model=m drivers=implement -->\n\n` +
      `# Talk ${id}\n\nThe opening Turn.\n`,
  };
}

/** The Ticket ids /api/state lists, sorted. */
async function ticketIds(server: CaseServer): Promise<string[]> {
  return (await snapshot(server)).state.tickets.map((tk) => tk.id).sort();
}

conformance("spawns", "loads an engine-written spawn ticket whose parent is in the pool", async (t) => {
  const world = t.world({ tickets: [ticket("01"), seed("01-spawn-1.md", SPAWN_ONE)], config: CONFIG });
  const server = await t.start(world);

  expect(await ticketIds(server)).toEqual(["01", "01-spawn-1"]);
  await settled(server);
});

conformance("spawns", "rejects a hand-written ticket in the reserved namespace", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), seed("01-spawn-9.md", "<!-- state: id=01-spawn-9 blocked-by=none status=ready -->")],
    config: CONFIG,
  });
  const message = await refusedStart(t, world);

  expect(message).toContain("exited 1 before its boot line");
  expect(message).toContain(`${world.pool}/issues/01-spawn-9.md`);
  expect(message).toContain(RESERVED);
});

conformance("spawns", "rejects a hand-written ticket in the reserved namespace at pool start", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), seed("01-spawn-9.md", "<!-- state: id=01-spawn-9 blocked-by=none status=ready -->")],
    config: CONFIG,
  });
  const message = await refusedStart(t, world);

  expect(message).toContain("exited 1 before its boot line");
  expect(message).toContain(RESERVED);
});

conformance("spawns", "rejects a spawn ticket whose spawned-by does not match its id's parent", async (t) => {
  const world = t.world({
    tickets: [
      ticket("01"),
      ticket("02"),
      seed("01-spawn-1.md", "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=02 -->"),
    ],
    config: CONFIG,
  });
  const message = await refusedStart(t, world);

  expect(message).toContain("exited 1 before its boot line");
  expect(message).toContain(`${world.pool}/issues/01-spawn-1.md: ${RESERVED}`);
  expect(message).toContain("spawned-by=01 in its marker");
});

conformance("spawns", "rejects a spawn ticket whose parent has left the pool", async (t) => {
  const world = t.world({ tickets: [ticket("02"), seed("01-spawn-1.md", SPAWN_ONE)], config: CONFIG });
  const message = await refusedStart(t, world);

  expect(message).toContain("exited 1 before its boot line");
  expect(message).toContain("spawned-by '01' names no ticket or known Conversation in the pool");
});

conformance("spawns", "accepts a spawn ticket whose spawned-by names a known Conversation, not a ticket", async (t) => {
  const world = t.world({
    tickets: [seed("conv-1-spawn-1.md", "<!-- state: id=conv-1-spawn-1 blocked-by=none status=ready spawned-by=conv-1 -->")],
    config: CONFIG,
    poolFiles: conversation("conv-1"),
  });
  const server = await t.start(world);

  expect(await ticketIds(server)).toEqual(["conv-1-spawn-1"]);
  await settled(server);
});

conformance("spawns", "still rejects that same ticket when the Conversation id is not in the known set", async (t) => {
  const world = t.world({
    tickets: [seed("conv-1-spawn-1.md", "<!-- state: id=conv-1-spawn-1 blocked-by=none status=ready spawned-by=conv-1 -->")],
    config: CONFIG,
    poolFiles: conversation("conv-2"),
  });
  const message = await refusedStart(t, world);

  expect(message).toContain("exited 1 before its boot line");
  expect(message).toContain("spawned-by 'conv-1' names no ticket or known Conversation in the pool");
});
