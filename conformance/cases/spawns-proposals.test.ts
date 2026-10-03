/**
 * The Held and Pending spawns as the server serves and stores them:
 * runs/held-spawns.json, the views on /api/state, proposal ids, refused
 * Adopts.
 */

import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, HeldSpawnView } from "../../engine/wire.ts";
import { conformance } from "../harness/case.ts";
import { anyIsoTime } from "../harness/equal.ts";
import {
  CONFIG,
  GOOD_BODY,
  eventsOf,
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

/** The refusal a boundary gives a proposal whose blocks names Ticket 02 once 02 is done. */
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
    "## Pending spawns\n\nProposals that land at the next super-step boundary.\n\n_(none)_\n\n" +
      "## Held spawns\n\nProposals waiting for the operator to adopt or discard them.\n\n_(none)_\n",
  );
});

// The cap of 0 holds 01's proposal; 02, held on a release file, keeps the
// drive running so the Adopt queues for the boundary, where 02 is done.
// Reopening 02 by hand across the restart lets the next Adopt pass its check.
conformance("spawns", "records a refused Adopt's reason on the held spawn until the next Adopt", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: withCaps({ perAttempt: 0 }) });
  const first = releaseFile(world, "02");
  world.stubs.script("01", { spawn: [proposal("A", { blocks: ["02"] })] });
  world.stubs.script("02", { waitFor: first.path });
  let server = await t.start(world);

  await snapshotUntil(server, (snap) => heldView(snap.heldSpawns, "proposal-1") !== undefined, "proposal-1 held");
  const adopt = await server.http.post("/api/spawns/held/adopt", { id: "proposal-1" });
  expect(adopt.status).toBe(202);
  expect(adopt.json<Record<string, string>>()).toEqual({ id: "proposal-1" });
  expect(heldView((await snapshot(server)).heldSpawns, "proposal-1")).toMatchObject({ adopting: true });

  first.release();
  const refused = await snapshotUntil(
    server,
    (snap) => heldView(snap.heldSpawns, "proposal-1")?.adoptError !== undefined,
    "the boundary to refuse the Adopt",
  );
  expect(heldView(refused.heldSpawns, "proposal-1")).toMatchObject({ adopting: false, adoptError: BLOCKS_DONE_02 });
  await settled(server);
  await server.stop();

  const marker = join(world.pool, "issues", "02-t.md");
  writeFileSync(marker, readFileSync(marker, "utf8").replace("status=done", "status=ready"));
  const second = releaseFile(world, "02-again");
  world.stubs.script("02", { waitFor: second.path });
  server = await t.start(world);

  // Kept across the restart.
  expect(heldView((await snapshot(server)).heldSpawns, "proposal-1")).toMatchObject({
    adopting: false,
    adoptError: BLOCKS_DONE_02,
  });
  await snapshotUntil(server, (snap) => statusOf(snap, "02") === "in-progress", "02 to run again");
  const again = await server.http.post("/api/spawns/held/adopt", { id: "proposal-1" });
  expect(again.status).toBe(202);
  const view = heldView((await snapshot(server)).heldSpawns, "proposal-1");
  expect(view).toMatchObject({ adopting: true });
  expect(view).not.toHaveProperty("adoptError");
  const held = (heldSpawnsFile(world)?.held ?? []) as Record<string, unknown>[];
  expect(held.find((h) => h.id === "proposal-1")).not.toHaveProperty("adoptError");
  second.release();
  await settled(server);
});

// Seeded: 01 is done, 02 runs held on a release file, so the Adopt of the
// Conversation's proposal queues mid-drive.
conformance("spawns", "serves each held spawn as the Console shows it, adopting included", async (t) => {
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
  const release = releaseFile(world, "02");
  world.stubs.script("02", { waitFor: release.path });
  const server = await t.start(world);

  await snapshotUntil(server, (snap) => statusOf(snap, "02") === "in-progress", "02 to run");
  const adopt = await server.http.post("/api/spawns/held/adopt", { id: "proposal-2" });
  expect(adopt.status).toBe(202);
  expect((await snapshot(server)).heldSpawns).toEqual([
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
      adopting: true,
    },
  ]);
  release.release();
  await settled(server);
});

conformance("spawns", "holds a pending spawn for the operator under the same id", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  const release = releaseFile(world, "02");
  world.stubs.script("01", { spawn: [proposal("A")] });
  world.stubs.script("02", { waitFor: release.path });
  const server = await t.start(world);

  await snapshotUntil(server, (snap) => snap.pendingSpawns.length === 1, "proposal-1 pending");
  const hold = await server.http.post("/api/spawns/pending/hold", { id: "proposal-1" });
  expect(hold.status).toBe(200);
  expect(hold.json<Record<string, string>>()).toEqual({ id: "proposal-1" });

  const snap = await snapshot(server);
  expect(snap.pendingSpawns).toEqual([]);
  expect(snap.heldSpawns).toEqual([
    expect.objectContaining({ id: "proposal-1", parentId: "01", origin: "ticket", title: "A", reason: "operator" }),
  ]);
  const file = heldSpawnsFile(world);
  expect(file?.pending).toEqual([]);
  expect(file?.held).toEqual([
    {
      id: "proposal-1",
      parentId: "01",
      origin: "ticket",
      proposal: { title: "A", body: GOOD_BODY },
      reason: "operator",
      at: anyIsoTime(),
    },
  ]);

  const twice = await server.http.post("/api/spawns/pending/hold", { id: "proposal-1" });
  expect(twice.status).toBe(409);
  expect(twice.json<Record<string, string>>()).toEqual({ reason: "spawn proposal-1 is already held" });
  release.release();
  await settled(server);
});

conformance("spawns", "removes a pending spawn once, and forgets landed ones in one write", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  const release = releaseFile(world, "02");
  world.stubs.script("01", { spawn: [proposal("A"), proposal("B"), proposal("C")] });
  world.stubs.script("02", { waitFor: release.path });
  const server = await t.start(world);

  await snapshotUntil(server, (snap) => snap.pendingSpawns.length === 3, "three pending spawns");
  const discard = await server.http.post("/api/spawns/pending/discard", { id: "proposal-2" });
  expect(discard.status).toBe(200);
  expect(discard.json<Record<string, string>>()).toEqual({ id: "proposal-2" });
  const twice = await server.http.post("/api/spawns/pending/discard", { id: "proposal-2" });
  expect(twice.status).toBe(409);
  expect(twice.json<Record<string, string>>()).toEqual({ reason: "no pending spawn proposal-2: it has landed or been discarded" });

  release.release();
  const landed = await snapshotUntil(
    server,
    (snap) => statusOf(snap, "01-spawn-1") !== undefined && statusOf(snap, "01-spawn-2") !== undefined,
    "the two spawns to land",
  );
  expect(landed.pendingSpawns).toEqual([]);
  expect(heldSpawnsFile(world)?.pending).toEqual([]);
  expect(eventsOf(world, "01", "spawn-adopted").map((event) => event.payload)).toEqual([
    { adopted: ["01-spawn-1", "01-spawn-2"], fromPending: ["proposal-1", "proposal-3"] },
  ]);
  await settled(server);
});

// proposal-1 is discarded and proposal-2 pending when 02's Outcome names
// them, beside ids no proposal of this pool ever had and a Ticket it lacks.
conformance("spawns", "knows every proposal id it ever issued, and none it did not", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  const release = releaseFile(world, "02");
  world.stubs.script("01", { spawn: [proposal("A"), proposal("B")] });
  world.stubs.script("02", {
    waitFor: release.path,
    spawn: [proposal("D", { overlaps: ["proposal-1", "proposal-2", "proposal-9", "held-2", "07"] })],
  });
  const server = await t.start(world);

  await snapshotUntil(server, (snap) => snap.pendingSpawns.length === 2, "two pending spawns");
  expect((await server.http.post("/api/spawns/pending/discard", { id: "proposal-1" })).status).toBe(200);
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

conformance("spawns", "holds a Pending spawn the boundary refused, under the same id, with the reason", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  const release = releaseFile(world, "02");
  world.stubs.script("01", { spawn: [proposal("A", { blocks: ["02"] })] });
  world.stubs.script("02", { waitFor: release.path });
  const server = await t.start(world);

  await snapshotUntil(server, (snap) => snap.pendingSpawns.length === 1, "proposal-1 pending");
  release.release();
  const snap = await snapshotUntil(
    server,
    (s) => heldView(s.heldSpawns, "proposal-1") !== undefined,
    "the boundary to hold proposal-1",
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

conformance("spawns", "serves each pending spawn as the Console shows it", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  const release = releaseFile(world, "02");
  world.stubs.script("01", { spawn: [proposal("A", { blockedBy: ["02"] })] });
  world.stubs.script("02", { waitFor: release.path });
  const server = await t.start(world);

  const snap = await snapshotUntil(server, (s) => s.pendingSpawns.length === 1, "proposal-1 pending");
  expect(snap.pendingSpawns).toEqual([
    {
      id: "proposal-1",
      parentId: "01",
      origin: "ticket",
      kind: "ticket",
      title: "A",
      body: GOOD_BODY,
      blockedBy: ["02"],
      blocks: null,
      overlaps: [],
      at: anyIsoTime() as string,
    },
  ]);
  release.release();
  await settled(server);
});
