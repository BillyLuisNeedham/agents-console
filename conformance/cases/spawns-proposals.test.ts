/**
 * The Held and Pending spawns as the server serves and stores them:
 * runs/held-spawns.json, the views on /api/state, proposal ids, refused
 * Adopts. A Pending spawn lasts one Tick (ADR-0040), so its view is seen
 * only as it lands or is held.
 */

import { expect } from "bun:test";
import type { EnrichedSnapshot, HeldSpawnView } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import {
  CONFIG,
  GOOD_BODY,
  eventsOf,
  hasTicket,
  heldSpawnsFile,
  ledger,
  proposal,
  releaseFile,
  settled,
  snapshot,
  snapshotUntil,
  ticket,
  withCaps,
} from "./spawns-support.ts";

/** The refusal a Tick gives a proposal whose blocks names Ticket 02 once 02 is done. */
const BLOCKS_DONE_02 = "blocks names done tickets, which have no next attempt to hold: 02";

/** A Ticket's status on the snapshot, or undefined when the pool lacks it. */
function statusOf(snap: EnrichedSnapshot, id: string): string | undefined {
  return snap.state.tickets.find((t) => t.id === id)?.status;
}

/** The held spawn with an id on the snapshot, or undefined. */
function heldView(views: HeldSpawnView[], id: string): HeldSpawnView | undefined {
  return views.find((view) => view.id === id);
}

conformance("spawns", "starts empty when the pool has never held a spawn", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  const server = await t.start(world);
  const snap = await settled(server);
  expect(snap.heldSpawns).toEqual([]);
  expect(snap.pendingSpawns).toEqual([]);
  expect(ledger(world)).toContain(
    "## Pending spawns\n\nProposals that land at the next Tick.\n\n_(none)_\n\n" +
      "## Held spawns\n\nProposals waiting for the operator to adopt or discard them.\n\n_(none)_\n",
  );
});

// A refused Adopt is seeded with the server down: a live Adopt lands or is
// refused at the Tick it wakes, too soon to watch it queued. 02, held on a
// release file, still runs when the next Adopt passes its check.
conformance("spawns", "keeps a refused Adopt's reason on the held spawn until the next Adopt", async (t) => {
  const file = {
    seq: 1,
    proposalFrom: 0,
    pending: [],
    held: [
      {
        id: "proposal-1",
        parentId: "01",
        origin: "ticket",
        proposal: { title: "A", body: GOOD_BODY, blocks: ["02"] },
        reason: "per-attempt",
        at: "2026-01-01T00:00:01.000Z",
        adoptError: BLOCKS_DONE_02,
      },
    ],
    recovered: [],
  };
  const world = t.world({
    tickets: [ticket("01", "none", "done"), ticket("02")],
    config: CONFIG,
    poolFiles: { "runs/held-spawns.json": JSON.stringify(file, null, 2) },
  });
  const release = releaseFile(world, "02");
  world.stubs.script("02", { waitFor: release.path });
  const server = await t.start(world);

  const running = await snapshotUntil(server, (snap) => statusOf(snap, "02") === "in-progress", "02 to run");
  expect(heldView(running.heldSpawns, "proposal-1")).toMatchObject({ adopting: false, adoptError: BLOCKS_DONE_02 });
  const again = await server.http.post("/api/spawns/held/adopt", { id: "proposal-1" });
  expect(again.status).toBe(202);
  expect(again.json<Record<string, string>>()).toEqual({ id: "proposal-1" });
  const landed = await snapshotUntil(server, (snap) => statusOf(snap, "01-spawn-1") !== undefined, "the Adopt to land");
  expect(heldView(landed.heldSpawns, "proposal-1")).toBeUndefined();
  expect(heldSpawnsFile(world)?.held).toEqual([]);
  release.release();
  await settled(server);
});

conformance("spawns", "serves each held spawn as the Console shows it", async (t) => {
  const file = {
    seq: 2,
    proposalFrom: 0,
    pending: [],
    held: [
      {
        id: "proposal-1",
        parentId: "01",
        origin: "ticket",
        proposal: { title: "A", body: GOOD_BODY, blockedBy: ["02"], blocks: "all" },
        reason: "per-run",
        at: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "proposal-2",
        parentId: "c-1",
        origin: "conversation",
        proposal: { title: "B", body: GOOD_BODY, kind: "conversation" },
        reason: "per-attempt",
        at: "2026-01-01T00:00:02.000Z",
      },
    ],
    recovered: [],
  };
  const world = t.world({
    tickets: [ticket("01", "none", "done"), ticket("02")],
    config: CONFIG,
    poolFiles: { "runs/held-spawns.json": JSON.stringify(file, null, 2) },
  });
  const server = await t.start(world);

  expect((await settled(server)).heldSpawns).toEqual([
    {
      id: "proposal-1",
      parentId: "01",
      origin: "ticket",
      kind: "ticket",
      title: "A",
      body: GOOD_BODY,
      blockedBy: ["02"],
      blocks: "all",
      overlaps: [],
      reason: "per-run",
      unknownOverlaps: [],
      at: "2026-01-01T00:00:01.000Z",
      adopting: false,
    },
    {
      id: "proposal-2",
      parentId: "c-1",
      origin: "conversation",
      kind: "conversation",
      title: "B",
      body: GOOD_BODY,
      blockedBy: [],
      blocks: null,
      overlaps: [],
      reason: "per-attempt",
      unknownOverlaps: [],
      at: "2026-01-01T00:00:02.000Z",
      adopting: false,
    },
  ]);
});

// B names 01 in its overlaps, so it is held between A and C: one take
// numbers them all, and the two Pending spawns land in one write.
conformance("spawns", "lands the pending spawns of one Outcome in one write, and refuses a discard after", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("A"), proposal("B", { overlaps: ["01"] }), proposal("C")] });
  const server = await t.start(world);

  const landed = await snapshotUntil(
    server,
    (snap) => statusOf(snap, "01-spawn-1") !== undefined && statusOf(snap, "01-spawn-2") !== undefined,
    "the two spawns to land",
  );
  expect(landed.pendingSpawns).toEqual([]);
  expect(landed.heldSpawns.map((h) => [h.id, h.title, h.reason])).toEqual([["proposal-2", "B", "overlaps"]]);
  expect(heldSpawnsFile(world)?.pending).toEqual([]);
  expect(eventsOf(world, "01", "spawn-adopted").map((event) => event.payload)).toEqual([
    { adopted: ["01-spawn-1", "01-spawn-2"], fromPending: ["proposal-1", "proposal-3"] },
  ]);
  const late = await server.http.post("/api/spawns/pending/discard", { id: "proposal-1" });
  expect(late.status).toBe(409);
  expect(late.json<Record<string, string>>()).toEqual({ reason: "no pending spawn proposal-1: it has landed or been discarded" });
  await settled(server);
});

// proposal-1 has landed and proposal-2 is discarded when 02's Outcome names
// them, beside ids no proposal of this pool ever had and a Ticket it lacks.
// 02 waits on a release file until the discard is done.
conformance("spawns", "knows every proposal id it ever issued, and none it did not", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", "01")], config: withCaps({ perAttempt: 1 }) });
  const release = releaseFile(world, "02");
  world.stubs.script("01", { spawn: [proposal("A"), proposal("B")] });
  world.stubs.script("02", {
    waitFor: release.path,
    spawn: [proposal("D", { overlaps: ["proposal-1", "proposal-2", "proposal-9", "held-2", "07"] })],
  });
  const server = await t.start(world);

  await snapshotUntil(
    server,
    (snap) => statusOf(snap, "01-spawn-1") !== undefined && heldView(snap.heldSpawns, "proposal-2") !== undefined,
    "proposal-1 landed and proposal-2 held",
  );
  expect((await server.http.post("/api/spawns/held/discard", { id: "proposal-2" })).status).toBe(200);
  release.release();

  const snap = await snapshotUntil(
    server,
    (s) => heldView(s.heldSpawns, "proposal-3") !== undefined,
    "02's proposal held",
  );
  expect(heldView(snap.heldSpawns, "proposal-3")).toMatchObject({
    parentId: "02",
    title: "D",
    reason: "overlaps",
    overlaps: ["proposal-1", "proposal-2", "proposal-9", "held-2", "07"],
    unknownOverlaps: ["proposal-9", "held-2", "07"],
  });
  await settled(server);
});

// The take is seeded with the server down: a live one lands at the very next Tick.
conformance("spawns", "holds a Pending spawn the Tick refused, under the same id, with the reason", async (t) => {
  const file = {
    seq: 1,
    pending: [{ id: "proposal-1", parentId: "01", origin: "ticket", proposal: proposal("A", { blocks: ["02"] }), at: "t0" }],
    held: [],
    recovered: [],
  };
  const world = t.world({
    tickets: [ticket("01", "none", "done"), ticket("02", "none", "done")],
    config: CONFIG,
    poolFiles: { "runs/held-spawns.json": JSON.stringify(file, null, 2) },
  });
  const server = await t.start(world);

  const snap = await snapshotUntil(
    server,
    (s) => heldView(s.heldSpawns, "proposal-1") !== undefined,
    "the first Tick to hold proposal-1",
  );
  expect(snap.pendingSpawns).toEqual([]);
  expect(heldView(snap.heldSpawns, "proposal-1")).toMatchObject({
    parentId: "01",
    reason: "refused",
    adoptError: BLOCKS_DONE_02,
    adopting: false,
  });
  expect(heldSpawnsFile(world)).toMatchObject({
    pending: [],
    held: [{ id: "proposal-1", reason: "refused", adoptError: BLOCKS_DONE_02 }],
  });
  await settled(server);
});

// The pool is headless, so the Conversation Spawn is refused at its start, after its landing minted and
// reserved its id. The refusal gives the id back, as the TypeScript server never held it, and the
// parent's next Spawn takes the number again (NOT-PORTED.md, r-spawns). 02 waits on 01 and then on a
// release file, so the Adopt lands at a later Tick than the refused start.
conformance("spawns", "gives a refused Conversation Spawn's id to the parent's next Spawn", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", "01")], config: withCaps({ perAttempt: 1 }) });
  const gate = releaseFile(world, "02");
  world.stubs.script("01", { spawn: [proposal("Talk", { kind: "conversation" }), proposal("Later")] });
  world.stubs.script("02", { waitFor: gate.path });
  const server = await t.start(world);

  await snapshotUntil(
    server,
    () => eventsOf(world, "01", "spawn-rejected").length > 0,
    "the Conversation Spawn's refused start",
  );
  expect(eventsOf(world, "01", "spawn-rejected")[0]?.payload).toEqual({
    title: "Talk",
    reason:
      'conversation start failed: conversation start: the pool is not terminal-backed (set console.json terminal: "herdr")',
  });
  const held = (await snapshot(server)).heldSpawns.find((view) => view.title === "Later");
  expect(held).toMatchObject({ reason: "per-attempt" });
  expect((await server.http.post("/api/spawns/held/adopt", { id: held!.id })).status).toBe(202);

  gate.release();
  await snapshotUntil(server, (snap) => statusOf(snap, "01-spawn-1") !== undefined, "the adopted Spawn to land");
  expect(hasTicket(world, "01-spawn-1.md")).toBe(true);
  expect(hasTicket(world, "01-spawn-2.md")).toBe(false);
  // The refused Conversation was adopted under the same id first.
  expect(eventsOf(world, "01", "spawn-adopted").map((event) => event.payload.adopted)).toEqual([
    ["01-spawn-1"],
    ["01-spawn-1"],
  ]);
  await settled(server);
});
