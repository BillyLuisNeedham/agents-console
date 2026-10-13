/**
 * The Reassign route (issue #126), seen from outside the server (ADR-0036):
 * the Reassign rows every Ticket carries on the snapshot, what a
 * `PUT /api/reassign` answers, and what lands in console.json.
 *
 * A Ticket "held running" is one whose stub harness waits for a file the case
 * never writes; the stub gives up after ten seconds, so each case does its
 * work well inside that.
 */

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, EnrichedTicketState, PoolConfig, ReassignResponse } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { readConsoleJson, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";

const DEFAULTS: PoolConfig = { defaults: { harness: "claude", model: "m" } };

const READY = (id: string, blocked = "none") => `<!-- state: id=${id} blocked-by=${blocked} status=ready -->`;
const SPAWNED = (id: string, parent: string, blocked: string) =>
  `<!-- state: id=${id} blocked-by=${blocked} status=ready spawned-by=${parent} -->`;

/** 01 ready, 02 ready behind it: the original rig's two Tickets. */
const TWO: TicketSeed[] = [
  { file: "01-a.md", marker: READY("01") },
  { file: "02-b.md", marker: READY("02", "01") },
];

/** Hold 01's Attempt running: its stub waits for a file that never comes. */
function hold01(world: World): void {
  world.stubs.script("01", { waitFor: join(world.root, "never") });
}

function heldWorld(t: Case, tickets: TicketSeed[] = TWO, config: PoolConfig = DEFAULTS): World {
  const world = t.world({ tickets, config });
  hold01(world);
  return world;
}

async function getState(server: CaseServer): Promise<EnrichedSnapshot | null> {
  const answer = await server.http.get("/api/state");
  expect(answer.status).toBe(200);
  return answer.json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
}

function ticket(snapshot: EnrichedSnapshot, id: string): EnrichedTicketState {
  const found = snapshot.state.tickets.find((x) => x.id === id);
  if (!found) throw new Error(`no ticket ${id} in the snapshot`);
  return found;
}

/** Wait until 01's Attempt is in flight. */
async function live01(server: CaseServer): Promise<EnrichedSnapshot> {
  return (await until(
    () => getState(server),
    (got) => got !== null && got.state.tickets.some((x) => x.id === "01" && x.liveAttempt !== null),
    { what: "01's Attempt to be in flight", ms: 20_000 },
  ))!;
}

function onDisk(world: World): Record<string, unknown> {
  return readConsoleJson(world.pool) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The snapshot's Reassign rows
// ---------------------------------------------------------------------------

// engine/reassign-routes.test.ts:90
conformance(
  "config",
  "the snapshot's Reassign rows › carries eligibility and per-field sources on every ticket",
  async (t) => {
    const world = t.world({ tickets: TWO, config: { ...DEFAULTS, assign: { "02": { model: "opus" } } } });
    const server = await t.start(world);

    // Both Tickets run to done.
    const state = (await until(
      () => getState(server),
      (got) => got?.phase === "quiescent" && got.state.tickets.every((x) => x.status === "done"),
      { what: "both tickets to run to done", ms: 30_000 },
    ))!;

    expect(ticket(state, "02").reassign.sources).toEqual({
      harness: "default",
      model: "pinned",
      effort: "unset",
      drivers: "default",
    });
    expect(ticket(state, "02").assignment).toEqual({ harness: "claude", model: "opus", drivers: "implement" });
    expect(ticket(state, "01").reassign.eligible).toBe(false);
    expect(ticket(state, "01").reassign.reason).toBe("done");
  },
);

// engine/reassign-routes.test.ts:113
conformance(
  "config",
  "the snapshot's Reassign rows › merges over a hand edit made since the last boundary",
  async (t) => {
    const world = heldWorld(t);
    const server = await t.start(world);
    await live01(server);

    writeFileSync(
      join(world.pool, "console.json"),
      JSON.stringify({ ...DEFAULTS, assign: { "02": { drivers: "by-hand" } } }),
    );

    const answer = await server.http.put("/api/reassign", { tickets: ["02"], fields: { model: "opus" } });
    expect(answer.status).toBe(200);
    const reassigned = answer.json<ReassignResponse>();

    expect(onDisk(world).assign).toEqual({ "02": { drivers: "by-hand", model: "opus" } });
    expect(ticket(reassigned.snapshot, "02").assignment).toEqual({
      harness: "claude",
      model: "opus",
      drivers: "by-hand",
    });
  },
);

// engine/reassign-routes.test.ts:142
conformance(
  "config",
  "the snapshot's Reassign rows › shows a spawned child inheriting its in-flight parent's frozen model",
  async (t) => {
    const world = heldWorld(
      t,
      [
        { file: "01-a.md", marker: READY("01") },
        { file: "01-spawn-1.md", marker: SPAWNED("01-spawn-1", "01", "01") },
      ],
      { defaults: { harness: "claude", model: "model-a" } },
    );
    const server = await t.start(world);
    await live01(server);

    // The pool default moves while 01's Attempt holds its own Assignment.
    writeFileSync(join(world.pool, "console.json"), JSON.stringify({ defaults: { harness: "claude", model: "model-b" } }));

    const answer = await server.http.put("/api/reassign", { tickets: ["01-spawn-1"], fields: { drivers: "review" } });
    expect(answer.status).toBe(200);
    const reassigned = answer.json<ReassignResponse>();

    expect(ticket(reassigned.snapshot, "01").assignment.model).toBe("model-a");
    expect(ticket(reassigned.snapshot, "01-spawn-1").assignment).toEqual({
      harness: "claude",
      model: "model-a",
      drivers: "review",
    });
  },
);

// ---------------------------------------------------------------------------
// Reassign on a Conversation's spawns (issue #156)
// ---------------------------------------------------------------------------

// engine/reassign-routes.test.ts:198
conformance(
  "config",
  "Reassign on a Conversation's spawns › offers the child and grandchild with inherited sources, and writes the child",
  async (t) => {
    const world = t.world({
      tickets: [
        { file: "01-a.md", marker: READY("01") },
        { file: "conv-1-spawn-1.md", marker: SPAWNED("conv-1-spawn-1", "conv-1", "01") },
        {
          file: "conv-1-spawn-1-spawn-1.md",
          marker: SPAWNED("conv-1-spawn-1-spawn-1", "conv-1-spawn-1", "conv-1-spawn-1"),
        },
      ],
      config: DEFAULTS,
      poolFiles: {
        "conversations/conv-1.md":
          "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude " +
          "model=conv-model effort=low drivers=implement -->\n\n# Talk\n",
      },
    });
    // 01 held open, so neither spawn runs and both stay reassignable.
    hold01(world);
    const server = await t.start(world);

    const state = await live01(server);
    for (const id of ["conv-1-spawn-1", "conv-1-spawn-1-spawn-1"]) {
      expect(ticket(state, id).reassign.eligible).toBe(true);
      expect(ticket(state, id).reassign.reason).toBeNull();
      expect(ticket(state, id).reassign.sources).toEqual({
        harness: "inherited",
        model: "inherited",
        effort: "inherited",
        drivers: "inherited",
      });
      expect(ticket(state, id).assignment).toMatchObject({ model: "conv-model", effort: "low" });
    }

    const answer = await server.http.put("/api/reassign", { tickets: ["conv-1-spawn-1"], fields: { model: "opus" } });
    expect(answer.status).toBe(200);
    const reassigned = answer.json<ReassignResponse>();

    expect(reassigned.applied).toEqual(["conv-1-spawn-1"]);
    expect(onDisk(world).assign).toEqual({ "conv-1-spawn-1": { model: "opus" } });
    expect(ticket(reassigned.snapshot, "conv-1-spawn-1").assignment).toMatchObject({ model: "opus" });
    expect(ticket(reassigned.snapshot, "conv-1-spawn-1-spawn-1").assignment).toMatchObject({
      model: "opus",
      effort: "low",
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /api/reassign
// ---------------------------------------------------------------------------

// engine/reassign-routes.test.ts:260
conformance(
  "config",
  "PUT /api/reassign › writes the file and answers with a snapshot already showing it",
  async (t) => {
    const world = heldWorld(t);
    const server = await t.start(world);
    await live01(server);

    const answer = await server.http.put("/api/reassign", {
      tickets: ["02"],
      fields: { harness: "claude", model: "opus", verify: 2 },
    });
    expect(answer.status).toBe(200);
    const reassigned = answer.json<ReassignResponse>();

    expect(reassigned.applied).toEqual(["02"]);
    expect(reassigned.skipped).toEqual([]);
    expect(onDisk(world).assign).toEqual({ "02": { harness: "claude", model: "opus", verify: 2 } });

    const row = ticket(reassigned.snapshot, "02");
    expect(row.assignment).toEqual({ harness: "claude", model: "opus", drivers: "implement" });
    expect(row.reassign.verify).toBe(2);
    expect(row.reassign.sources).toEqual({
      harness: "pinned",
      model: "pinned",
      effort: "unset",
      drivers: "default",
    });
  },
);

// engine/reassign-routes.test.ts:297
conformance(
  "config",
  "PUT /api/reassign › answers 400 { error } naming the ticket, and leaves the file alone",
  async (t) => {
    const world = heldWorld(t);
    const server = await t.start(world);
    await live01(server);
    const before = onDisk(world);

    const answer = await server.http.put("/api/reassign", { tickets: ["02"], fields: { harness: "gemini" } });

    expect(answer.status).toBe(400);
    expect(answer.json<{ error: string }>().error).toContain("unknown harness 'gemini'");
    expect(onDisk(world)).toEqual(before);
  },
);

// engine/reassign-routes.test.ts:316
conformance("config", "PUT /api/reassign › answers 400 for an id the pool does not own", async (t) => {
  const world = heldWorld(t);
  const server = await t.start(world);
  await live01(server);

  const answer = await server.http.put("/api/reassign", { tickets: ["99"], fields: { model: "opus" } });
  expect(answer.status).toBe(400);
  expect(answer.json<{ error: string }>().error).toContain("unknown ticket '99'");
});

// engine/reassign-routes.test.ts:332
conformance(
  "config",
  "PUT /api/reassign › shows an in-flight ticket as read-only and skips a write to it",
  async (t) => {
    const world = heldWorld(t);
    const server = await t.start(world);
    const state = await live01(server);

    expect(ticket(state, "01").reassign.eligible).toBe(false);
    expect(ticket(state, "01").reassign.reason).toBe("an Attempt is running");

    const answer = await server.http.put("/api/reassign", { tickets: ["01", "02"], fields: { model: "opus" } });
    expect(answer.status).toBe(200);
    const reassigned = answer.json<ReassignResponse>();
    expect(reassigned.applied).toEqual(["02"]);
    expect(reassigned.skipped).toEqual([{ id: "01", reason: "an Attempt is running" }]);
    expect(onDisk(world).assign).toEqual({ "02": { model: "opus" } });
  },
);
