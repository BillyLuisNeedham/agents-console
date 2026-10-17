/**
 * Pending spawns between an Outcome and the Tick that lands them (ADR-0040):
 * their take and landing on the parent's log and in the Spawn ledger; the
 * Hold and Discard routes on spawns no longer pending; overlaps; caps of 0
 * (issue #150).
 */

import { expect } from "bun:test";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import type { World } from "../harness/world.ts";
import {
  CONFIG,
  GOOD_BODY,
  eventsOf,
  hasTicket,
  heldSpawnsFile,
  ledger,
  poolLog,
  proposal,
  runAndApprove,
  settled,
  snapshot,
  snapshotUntil,
  ticket,
  withCaps,
} from "./spawns-support.ts";

/** A Ticket's status on the snapshot, or undefined when it has none. */
function statusOf(snap: EnrichedSnapshot, id: string): string | undefined {
  return snap.state.tickets.find((t) => t.id === id)?.status;
}

/** The ledger's lines, so a case can ask for one whole row. */
function ledgerLines(world: World): string[] {
  return ledger(world).split("\n");
}

const heldRow = (id: string, parent: string, reason: string, title: string) =>
  `| ${id} | ${parent} | ticket | ${reason} | ${title} | ${GOOD_BODY} |`;

conformance("spawns", "lands a proposal at the next Tick, its take and its landing on the parent's log", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("Follow-up")] });
  const server = await t.start(world);
  const done = await runAndApprove(server);

  expect(eventsOf(world, "01", "spawn-pending")[0]?.payload).toEqual({
    pending: [{ id: "proposal-1", title: "Follow-up" }],
  });
  expect(await poolLog(server)).toContain("ticket 01: spawn proposal proposal-1 pending for the next Tick");
  expect(statusOf(done, "01-spawn-1")).toBe("done");
  expect((heldSpawnsFile(world) as { pending: unknown[] }).pending).toEqual([]);
  expect(done.pendingSpawns).toEqual([]);
  expect(eventsOf(world, "01", "spawn-adopted")[0]?.payload).toEqual({
    adopted: ["01-spawn-1"],
    fromPending: ["proposal-1"],
  });
  expect(ledger(world)).not.toContain("proposal-1");
  expect(ledgerLines(world)).toContain("| 01-spawn-1 | done | Follow-up |");
});

conformance("spawns", "refuses to hold or discard a held spawn as pending, and lands it on an Adopt", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: withCaps({ perAttempt: 0 }) });
  world.stubs.script("01", { spawn: [proposal("Wait for me")] });
  const server = await t.start(world);
  await snapshotUntil(
    server,
    (snap) => snap.phase === "quiescent" && snap.heldSpawns.some((h) => h.id === "proposal-1"),
    "the pool to settle with proposal-1 held",
  );

  for (const route of ["/api/spawns/pending/hold", "/api/spawns/pending/discard"]) {
    const again = await server.http.post(route, { id: "proposal-1" });
    expect(again.status).toBe(409);
    expect(again.json<{ reason: string }>().reason).toBe("spawn proposal-1 is already held");
  }
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);

  const adopted = await server.http.post("/api/spawns/held/adopt", { id: "proposal-1" });
  expect(adopted.status).toBe(202);
  await snapshotUntil(server, (snap) => statusOf(snap, "01-spawn-1") !== undefined, "the Adopt to land 01-spawn-1");
  expect(hasTicket(world, "01-spawn-1.md")).toBe(true);
});

conformance("spawns", "holds a proposal past the run cap once an earlier one has landed", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", "01")], config: withCaps({ perRun: 1 }) });
  world.stubs.script("01", { spawn: [proposal("First")] });
  world.stubs.script("02", { spawn: [proposal("Second")] });
  const server = await t.start(world);
  const rest = await snapshotUntil(
    server,
    (snap) => snap.phase === "quiescent" && statusOf(snap, "02") === "done" && statusOf(snap, "01-spawn-1") !== undefined,
    "the pool to settle with 01-spawn-1 landed",
  );
  expect(rest.heldSpawns.map((h) => [h.parentId, h.reason])).toEqual([["02", "per-run"]]);
});

conformance("spawns", "refuses an operator's action on a spawn that has already landed", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("Landed")] });
  const server = await t.start(world);
  await settled(server);
  expect(hasTicket(world, "01-spawn-1.md")).toBe(true);

  for (const route of ["/api/spawns/pending/hold", "/api/spawns/pending/discard"]) {
    const refused = await server.http.post(route, { id: "proposal-1" });
    expect(refused.status).toBe(409);
    expect(refused.json<{ reason: string }>().reason).toBe(
      "no pending spawn proposal-1: it has landed or been discarded",
    );
  }
});

// The agent read the ledger and judged its proposal overlapping: the
// operator decides, not the Tick.
conformance("spawns", "holds a proposal that names what it overlaps, with the ids on the hold", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", "01")], config: CONFIG });
  world.stubs.script("01", {
    spawn: [proposal("Maybe a duplicate", { overlaps: ["02"] }), proposal("Plain")],
  });
  const server = await t.start(world);
  const done = await runAndApprove(server);

  expect(statusOf(done, "01-spawn-1")).toBe("done");
  expect(hasTicket(world, "01-spawn-2.md")).toBe(false);
  expect(done.heldSpawns).toEqual([
    expect.objectContaining({
      id: "proposal-1",
      title: "Maybe a duplicate",
      reason: "overlaps",
      overlaps: ["02"],
    }),
  ]);
  expect(eventsOf(world, "01", "spawn-held")[0]?.payload).toEqual({
    held: [{ id: "proposal-1", title: "Maybe a duplicate", reason: "overlaps", overlaps: ["02"] }],
  });
  expect(await poolLog(server)).toContain("ticket 01: proposal-1 ('Maybe a duplicate') held: it overlaps 02");
  expect(ledgerLines(world)).toContain(heldRow("proposal-1", "01", "overlaps 02", "Maybe a duplicate"));
});

// The agent flagged a possible duplicate, so a mark naming ids nobody knows
// still holds the proposal, the unknown ids noted beside it.
conformance("spawns", "holds a proposal whose overlaps names ids the pool never knew, noting them", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("Ghostly", { overlaps: ["01", "99", "proposal-7"] })] });
  const server = await t.start(world);
  const done = await runAndApprove(server);

  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
  expect(done.heldSpawns).toEqual([
    expect.objectContaining({
      id: "proposal-1",
      reason: "overlaps",
      overlaps: ["01", "99", "proposal-7"],
      unknownOverlaps: ["99", "proposal-7"],
    }),
  ]);
  expect(eventsOf(world, "01", "spawn-held")[0]?.payload).toEqual({
    held: [
      {
        id: "proposal-1",
        title: "Ghostly",
        reason: "overlaps",
        overlaps: ["01", "99", "proposal-7"],
        unknownOverlaps: ["99", "proposal-7"],
      },
    ],
  });
  expect(await poolLog(server)).toContain(
    "ticket 01: proposal-1 ('Ghostly') held: it overlaps 01, 99, proposal-7 " +
      "(99, proposal-7 not in the pool or the Spawn ledger)",
  );
  expect(ledgerLines(world)).toContain(
    heldRow("proposal-1", "01", "overlaps 01, 99, proposal-7 (99, proposal-7 not in the pool)", "Ghostly"),
  );
});

// The pool moved between the take and the Tick: the spawn's blocks target
// finished. It is held with the reason instead of dropped. The take is
// seeded with the server down, since a live one lands at the very next Tick.
conformance("spawns", "holds a Pending spawn the Tick can no longer land, with the reason on it", async (t) => {
  const pendingFile = {
    seq: 1,
    pending: [
      { id: "proposal-1", parentId: "01", origin: "ticket", proposal: proposal("Fix first", { blocks: ["02"] }), at: "t0" },
    ],
    held: [],
    recovered: [],
  };
  const world = t.world({
    tickets: [ticket("01", "none", "done"), ticket("02", "01", "done")],
    config: CONFIG,
    poolFiles: { "runs/held-spawns.json": `${JSON.stringify(pendingFile, null, 2)}\n` },
  });
  const server = await t.start(world);
  const rest = await snapshotUntil(
    server,
    (snap) => snap.phase === "quiescent" && snap.heldSpawns.length === 1,
    "the first Tick to hold proposal-1",
  );

  const reason = "blocks names done tickets, which have no next attempt to hold: 02";
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
  expect(rest.pendingSpawns).toEqual([]);
  expect(rest.heldSpawns).toEqual([
    expect.objectContaining({ id: "proposal-1", reason: "refused", adoptError: reason }),
  ]);
  expect(eventsOf(world, "01", "spawn-held").at(-1)?.payload).toEqual({
    held: [{ id: "proposal-1", title: "Fix first", reason: "refused", refusal: reason }],
  });
  expect(await poolLog(server)).toContain(
    `ticket 01: pending spawn proposal-1 ('Fix first') could not land: ${reason}; it is held for the operator`,
  );
  expect(ledgerLines(world)).toContain(heldRow("proposal-1", "01", `refused at landing: ${reason}`, "Fix first"));
});

conformance("spawns", "rejects an overlaps that is not a list of ids", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("Odd", { overlaps: "02" })] });
  const server = await t.start(world);
  await runAndApprove(server);

  expect(eventsOf(world, "01", "spawn-rejected")[0]?.payload).toMatchObject({
    index: 0,
    reason: "proposal's overlaps is not a list of ids",
  });
});

// A cap of 0 is a pool that lands nothing on its own: one pool per cap, in turn.
conformance("spawns", "holds every proposal when a cap is 0", async (t) => {
  for (const [spawnCaps, reason] of [
    [{ perAttempt: 0 }, "per-attempt"],
    [{ perRun: 0 }, "per-run"],
  ] as const) {
    const world = t.world({ tickets: [ticket("01")], config: withCaps(spawnCaps) });
    world.stubs.script("01", { spawn: [proposal("A"), proposal("B")] });
    const server = await t.start(world);
    const done = await runAndApprove(server);

    expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
    expect(done.heldSpawns.map((h) => [h.title, h.reason])).toEqual([
      ["A", reason],
      ["B", reason],
    ]);
    expect(done.pendingSpawns).toEqual([]);
    await server.stop();
  }
}, { timeoutMs: 90_000 });

// A cap past what the server counts room in is no limit. The Rust port once wrapped such a cap negative,
// which held every proposal as a cap of 0 does.
conformance("spawns", "lands every proposal when a cap is too large to count", async (t) => {
  for (const spawnCaps of [{ perAttempt: 2 ** 63 }, { perRun: 1e300 }]) {
    const world = t.world({ tickets: [ticket("01")], config: withCaps(spawnCaps) });
    world.stubs.script("01", { spawn: [proposal("A"), proposal("B")] });
    const server = await t.start(world);
    const done = await runAndApprove(server);

    expect(hasTicket(world, "01-spawn-1.md")).toBe(true);
    expect(hasTicket(world, "01-spawn-2.md")).toBe(true);
    expect(done.heldSpawns).toEqual([]);
    expect(done.pendingSpawns).toEqual([]);
    await server.stop();
  }
}, { timeoutMs: 90_000 });
