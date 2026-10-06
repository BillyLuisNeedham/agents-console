/**
 * Pending spawns between an Outcome and the boundary: on disk, on the
 * snapshot and in the Spawn ledger; the operator's Hold and Discard;
 * overlaps; caps of 0 (issue #150).
 */

import { expect } from "bun:test";
import type { EnrichedSnapshot, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
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
  releaseFile,
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

/**
 * 01 and 02 run in the same super-step; 01 exits at once with `spawn` while
 * 02 waits on a release file, so 01's proposals stay Pending spawns until 02
 * is released. 02 proposes `later` when given.
 */
async function pendingRig(
  t: Case,
  spawn: unknown[],
  config: PoolConfig = CONFIG,
  later: unknown[] = [],
): Promise<{ world: World; server: CaseServer; release(): void }> {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config });
  const gate = releaseFile(world, "02");
  world.stubs.script("01", { spawn });
  world.stubs.script("02", { waitFor: gate.path, ...(later.length > 0 ? { spawn: later } : {}) });
  const server = await t.start(world);
  await snapshotUntil(server, (snap) => snap.pendingSpawns.length === 1, "01's proposal to be pending");
  return { world, server, release: gate.release };
}

const pendingRow = (id: string, parent: string, title: string) =>
  `| ${id} | ${parent} | ticket | ${title} | ${GOOD_BODY} |`;
const heldRow = (id: string, parent: string, reason: string, title: string) =>
  `| ${id} | ${parent} | ticket | ${reason} | ${title} | ${GOOD_BODY} |`;

conformance("spawns", "keeps a proposal on disk and on the snapshot until the boundary lands it", async (t) => {
  const { world, server, release } = await pendingRig(t, [proposal("Follow-up")]);

  const pending = await snapshot(server);
  expect(pending.pendingSpawns).toEqual([
    expect.objectContaining({ id: "proposal-1", parentId: "01", title: "Follow-up", overlaps: [] }),
  ]);
  const store = heldSpawnsFile(world) as { pending: { id: string }[] };
  expect(store.pending.map((p) => p.id)).toEqual(["proposal-1"]);
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
  expect(eventsOf(world, "01", "spawn-pending")[0]?.payload).toEqual({
    pending: [{ id: "proposal-1", title: "Follow-up" }],
  });
  expect(ledgerLines(world)).toContain(pendingRow("proposal-1", "01", "Follow-up"));

  release();
  const done = await runAndApprove(server);

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

conformance("spawns", "holds a Pending spawn on the operator's word, under the same id, until an Adopt", async (t) => {
  const { world, server, release } = await pendingRig(t, [proposal("Wait for me")]);

  const held = await server.http.post("/api/spawns/pending/hold", { id: "proposal-1" });
  expect(held.status).toBe(200);
  expect(held.json<{ id: string }>()).toEqual({ id: "proposal-1" });

  const after = await snapshot(server);
  expect(after.pendingSpawns).toEqual([]);
  expect(after.heldSpawns.map((h) => [h.id, h.reason])).toEqual([["proposal-1", "operator"]]);
  expect(eventsOf(world, "01", "spawn-held").at(-1)?.payload).toEqual({
    held: [{ id: "proposal-1", title: "Wait for me", reason: "operator" }],
  });
  expect(ledgerLines(world)).toContain(heldRow("proposal-1", "01", "held by operator", "Wait for me"));

  for (const route of ["/api/spawns/pending/hold", "/api/spawns/pending/discard"]) {
    const again = await server.http.post(route, { id: "proposal-1" });
    expect(again.status).toBe(409);
    expect(again.json<{ reason: string }>().reason).toBe("spawn proposal-1 is already held");
  }

  release();
  await snapshotUntil(
    server,
    (snap) => snap.phase === "quiescent" && statusOf(snap, "02") === "done",
    "the pool to settle with 02 done",
  );
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);

  const adopted = await server.http.post("/api/spawns/held/adopt", { id: "proposal-1" });
  expect(adopted.status).toBe(202);
  await snapshotUntil(server, (snap) => statusOf(snap, "01-spawn-1") !== undefined, "the Adopt to land 01-spawn-1");
  expect(hasTicket(world, "01-spawn-1.md")).toBe(true);
});

// Only what lands counts toward the run: a discarded Pending spawn gives its
// reserved room back.
conformance("spawns", "discards a Pending spawn for good and frees its room under the run cap", async (t) => {
  const { world, server, release } = await pendingRig(
    t,
    [proposal("Unwanted")],
    withCaps({ perRun: 1 }),
    [proposal("Wanted")],
  );

  const discarded = await server.http.post("/api/spawns/pending/discard", { id: "proposal-1" });
  expect(discarded.status).toBe(200);

  expect((await snapshot(server)).pendingSpawns).toEqual([]);
  expect(eventsOf(world, "01", "spawn-discarded")[0]?.payload).toEqual({
    id: "proposal-1",
    title: "Unwanted",
    pending: true,
  });
  expect(await poolLog(server)).toContain(
    "ticket 01: pending spawn proposal-1 ('Unwanted') discarded by the operator",
  );
  const again = await server.http.post("/api/spawns/pending/discard", { id: "proposal-1" });
  expect(again.status).toBe(409);
  expect(again.json<{ reason: string }>().reason).toBe(
    "no pending spawn proposal-1: it has landed or been discarded",
  );

  release();
  const done = await runAndApprove(server);
  expect(statusOf(done, "02-spawn-1")).toBe("done");
  expect(hasTicket(world, "01-spawn-1.md")).toBe(false);
  expect(done.heldSpawns).toEqual([]);
});

conformance("spawns", "reserves a Pending spawn's room: a second proposal past the run cap is held", async (t) => {
  const { server, release } = await pendingRig(
    t,
    [proposal("First")],
    withCaps({ perRun: 1 }),
    [proposal("Second")],
  );
  release();
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
// operator decides, not the boundary.
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

// The pool moved between the take and the boundary: the spawn's blocks
// target finished. It is held with the reason instead of dropped.
conformance("spawns", "holds a Pending spawn the boundary can no longer land, with the reason on it", async (t) => {
  const { world, server, release } = await pendingRig(t, [proposal("Fix first", { blocks: ["02"] })]);
  release();
  const rest = await snapshotUntil(
    server,
    (snap) => snap.phase === "quiescent" && snap.heldSpawns.length === 1,
    "the boundary to hold proposal-1",
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
