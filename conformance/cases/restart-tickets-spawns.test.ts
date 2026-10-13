/**
 * Spawns across a stop and start, seen from outside the server (ADR-0036):
 * Pending and Held spawns kept in runs/held-spawns.json, a landing a stop
 * cut short, the proposals a cap truncated before Held spawns existed, and
 * spawned Tickets resolving their requested Assignment from their state
 * lines alone. Ticket C05 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over.
 *
 * A state today's server cannot make (a console.db checkpoint from before
 * ADR-0029, a held-spawns.json mid-landing) is written into the pool before
 * the server starts, in the shapes the engine writes: the store's one
 * `checkpoints` table, the events as JSON lines, held-spawns.json whole.
 */

import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { anyIsoTime, expectParsedEqual, expectSameBytes } from "../harness/equal.ts";
import { readEvents, readTicketFile } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";
import { conversationRecord, flagValue } from "./config-support.ts";
import {
  CONFIG,
  approveReview,
  poolLog,
  restartCase,
  settle,
  startLeg,
  statusesOf,
  untilState,
} from "./restart-support.ts";
import { GOOD_BODY, eventsOf, hasTicket, heldSpawnsFile, ledger, proposal, ticket, withCaps } from "./spawns-support.ts";

/**
 * A spawned Ticket's file as the engine writes it at the boundary
 * (writeSpawnTicket in engine/engine.ts), at a status: the status is the
 * only byte a run changes after.
 */
function spawnedFile(
  id: string,
  parentId: string,
  title: string,
  options: { status?: string; blockedBy?: string; assign?: Record<string, string>; body?: string } = {},
): string {
  const assign = options.assign ? ` spawn-assign=${encodeURIComponent(JSON.stringify(options.assign))}` : "";
  return (
    `<!-- state: id=${id} blocked-by=${options.blockedBy ?? "none"} status=${options.status ?? "ready"} ` +
    `spawned-by=${parentId}${assign} -->\n\n` +
    `# ${id}: ${title}\n\n` +
    `**Spawned by** ticket ${parentId} (ADR-0010): the engine wrote this ticket at the super-step boundary from ` +
    "the attempt's Outcome proposal, engine-assigned id included. It is ordinary from here on: it schedules, " +
    "verifies, and may itself spawn, and the operator can edit or kill it before it schedules.\n\n" +
    `${options.body ?? GOOD_BODY}\n`
  );
}

/** A spawned Ticket a run before this one landed, as a seed. */
function spawnedSeed(
  id: string,
  parentId: string,
  title: string,
  options: Parameters<typeof spawnedFile>[3] = {},
): TicketSeed {
  return { file: `${id}.md`, content: spawnedFile(id, parentId, title, options) };
}

/**
 * console.db holding one checkpoint of `state`, as a server left it: the
 * store's own table (engine/checkpoints.ts), one row.
 */
function writeCheckpoint(world: World, state: unknown): void {
  const db = new Database(join(world.pool, "console.db"));
  try {
    db.run(
      "CREATE TABLE IF NOT EXISTS checkpoints (" +
        "seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, state TEXT NOT NULL)",
    );
    db.run("INSERT INTO checkpoints (at, state) VALUES (?, ?)", ["2026-09-27T10:00:00.002Z", JSON.stringify(state)]);
  } finally {
    db.close();
  }
}

interface SeedEvent {
  at: string;
  attempt: number;
  kind: string;
  payload: Record<string, unknown>;
}

/** A Ticket's events file holding exactly these events, one JSON line each. */
function eventsFile(events: SeedEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

/** runs/held-spawns.json as the engine writes it whole. */
function proposalsFile(file: Record<string, unknown>): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The checkpoint a run before ADR-0029 left: 01 done, its Outcome proposing `spawn`. */
function preHoldingCheckpoint(tickets: Record<string, string>, spawn: unknown[]): unknown {
  return {
    tickets,
    log: [],
    outcomes: { "01": { status: "done", summary: "s", commitSha: null, spawn } },
    interrupts: [],
    reviewApproved: false,
  };
}

function statusOf(snapshot: EnrichedSnapshot, id: string): string | undefined {
  return snapshot.state.tickets.find((each) => each.id === id)?.status;
}

/** The pool at rest with `done` holding of it. */
function quiet(server: CaseServer, what: string, done: (snapshot: EnrichedSnapshot) => boolean): Promise<EnrichedSnapshot> {
  return settle(server, what, (snapshot) => snapshot.phase === "quiescent" && done(snapshot));
}

/** POST one of the Held spawn routes; the status and the parsed body. */
async function heldAction(
  server: CaseServer,
  action: "adopt" | "discard",
  id: string,
): Promise<{ status: number; body: unknown }> {
  const answer = await server.http.post(`/api/spawns/held/${action}`, { id });
  return { status: answer.status, body: answer.json() };
}

/** The first launch of `key`; throws when there is none. */
function launchOf(world: World, key: string) {
  const call = world.stubs.calls().find((each) => each.key === key);
  if (!call) throw new Error(`no launch of ${key}`);
  return call;
}

/** The Spawn ledger as the engine renders it (engine/spawn-ledger.ts), for the sections a case fills. */
function ledgerText(sections: { tickets: string[]; pending?: string[]; held?: string[] }): string {
  const table = (header: string, rows: string[] | undefined): string[] =>
    rows && rows.length > 0 ? [header, header.replace(/[^|]+/g, (cell) => (cell.trim() === "" ? cell : " --- ")), ...rows] : ["_(none)_"];
  return [
    "# Spawn ledger",
    "",
    "The work this pool has and the work on its way, rewritten by the engine whenever it changes. Read it before " +
      "you propose a Spawn. Do not propose work listed here again. If a proposal still overlaps something listed, " +
      'name those ids in its "overlaps" and the operator decides whether it lands. Never edit this file.',
    "",
    "## Tickets",
    "",
    ...table("| id | status | title |", sections.tickets),
    "",
    "## Conversations",
    "",
    "_(none)_",
    "",
    "## Pending spawns",
    "",
    "Proposals that land at the next super-step boundary.",
    "",
    ...table("| id | parent | kind | title | summary |", sections.pending),
    "",
    "## Held spawns",
    "",
    "Proposals waiting for the operator to adopt or discard them.",
    "",
    ...table("| id | parent | kind | reason | title | summary |", sections.held),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Spawned Tickets at a fresh start
// ---------------------------------------------------------------------------

// engine/engine.test.ts:8388
conformance(
  "restart",
  "spawned Tickets take their requested Assignment from their state lines at a fresh start, a Conversation's included",
  async (t) => {
    // A fresh start has only the files: the requested effort and model come
    // off each child's spawn-assign token, and the operator's assign entry
    // still wins over the request.
    const world = t.world({
      tickets: [
        ticket("01", "none", "done"),
        spawnedSeed("01-spawn-1", "01", "Adopted earlier", { assign: { effort: "max" } }),
        spawnedSeed("conv-1-spawn-1", "conv-1", "Proposed from a Conversation", {
          assign: { model: "child-model", effort: "max" },
        }),
        spawnedSeed("conv-1-spawn-2", "conv-1", "Proposed from a Conversation", {
          assign: { model: "child-model", effort: "max" },
        }),
      ],
      config: {
        defaults: { harness: "claude", model: "m", effort: "low" },
        assign: { "conv-1-spawn-2": { model: "operator-model" } },
      },
      poolFiles: conversationRecord("conv-1", { harness: "claude", model: "m", effort: "high" }),
    });
    const server = await t.start(world);
    const done = await approveReview(server);

    expect(statusesOf(done)).toEqual({
      "01": "done",
      "01-spawn-1": "done",
      "conv-1-spawn-1": "done",
      "conv-1-spawn-2": "done",
    });
    const flags = (key: string) => {
      const argv = launchOf(world, key).argv;
      return { harness: launchOf(world, key).harness, model: flagValue(argv, "--model"), effort: flagValue(argv, "--effort") };
    };
    expect(flags("01-spawn-1")).toEqual({ harness: "claude", model: "m", effort: "max" });
    expect(flags("conv-1-spawn-1")).toEqual({ harness: "claude", model: "child-model", effort: "max" });
    expect(flags("conv-1-spawn-2")).toEqual({ harness: "claude", model: "operator-model", effort: "max" });
    expect(world.stubs.calls().map((call) => call.key).sort()).toEqual(["01-spawn-1", "conv-1-spawn-1", "conv-1-spawn-2"]);
  },
);

// engine/engine.test.ts:9208
conformance("restart", "a spawned Ticket already on disk at a start inherits its parent's Assignment", async (t) => {
  // No defaults: the spawned id resolves only through its parent's entry.
  const world = t.world({
    tickets: [ticket("01"), spawnedSeed("01-spawn-1", "01", "Adopted earlier")],
    config: { assign: { "01": { harness: "claude", model: "stub-model" } } } satisfies PoolConfig,
  });
  const server = await t.start(world);
  const done = await approveReview(server);

  expect(statusesOf(done)).toEqual({ "01": "done", "01-spawn-1": "done" });
  const child = launchOf(world, "01-spawn-1");
  expect(child.harness).toBe("claude");
  expect(flagValue(child.argv, "--model")).toBe("stub-model");
  expect(done.state.tickets.find((each) => each.id === "01-spawn-1")?.assignment).toMatchObject({
    harness: "claude",
    model: "stub-model",
  });
});

// ---------------------------------------------------------------------------
// Held spawns across a restart
// ---------------------------------------------------------------------------

// engine/engine.test.ts:8634
restartCase("Held spawns are kept across a restart, and one is Adopted past the caps on the operator's word", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: withCaps({ perRun: 1 }) });
  world.stubs.script("01", { spawn: [proposal("First"), proposal("Second", { blockedBy: ["01"] })] });
  const first = await startLeg(t, world, 0);
  const held = await quiet(
    first,
    "First landed and Second held at the run cap",
    (s) => statusOf(s, "01-spawn-1") === "done" && s.heldSpawns.length === 1,
  );
  expect(held.heldSpawns.map((h) => [h.id, h.reason])).toEqual([["proposal-2", "per-run"]]);
  await first.stop();

  const second = await startLeg(t, world, 1);
  const restored = await quiet(second, "the restarted pool with Second still held", (s) => s.heldSpawns.length === 1);
  expect(restored.heldSpawns.map((h) => [h.id, h.title, h.reason])).toEqual([["proposal-2", "Second", "per-run"]]);
  // A run is one boot: the count of Spawns landed starts again at 0.
  expect(restored.spawnUsage.spawnedThisRun).toBe(0);
  expectSameBytes(
    ledger(world),
    ledgerText({
      // The Tickets in file name order: 01-spawn-1.md sorts before 01-t.md.
      tickets: ["| 01-spawn-1 | done | First |", "| 01 | done | Ticket 01 |"],
      held: [`| proposal-2 | 01 | ticket | per-run cap | Second | ${GOOD_BODY} |`],
    }),
    "runs/spawn-ledger.md after the restart",
  );

  expect(await heldAction(second, "adopt", "proposal-9")).toEqual({
    status: 409,
    body: { reason: "no held spawn proposal-9" },
  });
  expect(await heldAction(second, "adopt", "proposal-2")).toEqual({ status: 202, body: { id: "proposal-2" } });
  const landed = await quiet(second, "the Adopted spawn run to done", (s) => statusOf(s, "01-spawn-2") === "done");

  expectSameBytes(
    readTicketFile(world.pool, "01-spawn-2.md"),
    spawnedFile("01-spawn-2", "01", "Second", { status: "done", blockedBy: "01" }),
    "issues/01-spawn-2.md",
  );
  expect(landed.heldSpawns).toEqual([]);
  // The operator's Adopt passes both caps and still counts toward the run.
  expect(landed.spawnUsage.spawnedThisRun).toBe(1);
  expect(eventsOf(world, "01", "spawn-adopted").at(-1)?.payload).toEqual({
    adopted: ["01-spawn-2"],
    fromHeld: "proposal-2",
  });
  expect(await heldAction(second, "adopt", "proposal-2")).toEqual({
    status: 409,
    body: { reason: "no held spawn proposal-2" },
  });
  await approveReview(second);
});

// engine/spawn-proposals.test.ts:31
restartCase("Held spawn ids survive a restart and a discarded one is never issued again", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: withCaps({ perAttempt: 0 }) });
  world.stubs.script("01", { spawn: [proposal("A"), proposal("B")] });
  const first = await startLeg(t, world, 0);
  const both = await quiet(first, "A and B held", (s) => s.heldSpawns.length === 2);
  expect(both.heldSpawns.map((h) => [h.id, h.title, h.reason])).toEqual([
    ["proposal-1", "A", "per-attempt"],
    ["proposal-2", "B", "per-attempt"],
  ]);
  expect(await heldAction(first, "discard", "proposal-2")).toEqual({ status: 200, body: { id: "proposal-2" } });
  await first.stop();

  // A Ticket added while no server runs proposes again after the restart.
  writeFileSync(join(world.pool, "issues", "02-t.md"), "<!-- state: id=02 blocked-by=none status=ready -->\n\n# Ticket 02\n\nDo 02.\n");
  world.stubs.script("02", { spawn: [proposal("C")] });
  const second = await startLeg(t, world, 1);
  const after = await quiet(second, "02 done with C held", (s) => statusOf(s, "02") === "done" && s.heldSpawns.length === 2);

  expect(after.heldSpawns.map((h) => [h.id, h.parentId, h.title, h.reason])).toEqual([
    ["proposal-1", "01", "A", "per-attempt"],
    ["proposal-3", "02", "C", "per-attempt"],
  ]);
  const file = heldSpawnsFile(world) as { seq: number; held: { id: string }[] };
  expect(file.seq).toBe(3);
  expect(file.held.map((h) => h.id)).toEqual(["proposal-1", "proposal-3"]);
  expect(eventsOf(world, "02", "spawn-held").map((e) => e.payload)).toEqual([
    { held: [{ id: "proposal-3", title: "C", reason: "per-attempt" }] },
  ]);
});

// ---------------------------------------------------------------------------
// Pending spawns across a restart
// ---------------------------------------------------------------------------

// engine/spawn-proposals.test.ts:169
restartCase("Pending and held proposals taken in one write keep their ids across a stop, and land in order after it", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  world.stubs.script("01", { spawn: [proposal("A"), proposal("B", { overlaps: ["02"] }), proposal("C")] });
  // 02 keeps the super-step open, so the proposals wait for a boundary.
  const sibling = world.stubs.hold("02");
  const first = await startLeg(t, world, 0);
  const taken = await untilState(
    first,
    "A and C pending, B held, 02 in flight",
    (s) =>
      s.pendingSpawns.length === 2 &&
      s.heldSpawns.length === 1 &&
      s.state.tickets.find((each) => each.id === "02")?.liveAttempt !== null,
  );
  expect(taken.pendingSpawns.map((p) => [p.id, p.title])).toEqual([
    ["proposal-1", "A"],
    ["proposal-3", "C"],
  ]);
  expect(taken.heldSpawns.map((h) => [h.id, h.title, h.reason, h.overlaps])).toEqual([
    ["proposal-2", "B", "overlaps", ["02"]],
  ]);
  await first.stop();

  // What the stop left: the ids in proposal order, pending and held alike.
  expectParsedEqual(
    heldSpawnsFile(world),
    {
      seq: 3,
      proposalFrom: 0,
      pending: [
        { id: "proposal-1", parentId: "01", origin: "ticket", proposal: proposal("A"), at: anyIsoTime() },
        { id: "proposal-3", parentId: "01", origin: "ticket", proposal: proposal("C"), at: anyIsoTime() },
      ],
      held: [
        {
          id: "proposal-2",
          parentId: "01",
          origin: "ticket",
          proposal: proposal("B", { overlaps: ["02"] }),
          at: anyIsoTime(),
          reason: "overlaps",
        },
      ],
      recovered: [],
    },
    "runs/held-spawns.json after the stop",
  );

  // The restarted server's first boundary lands the Pending spawns in the
  // order they were taken; the held one waits for the operator.
  const second = await startLeg(t, world, 1);
  const landed = await untilState(
    second,
    "A and C landed, B still held",
    (s) => statusOf(s, "01-spawn-1") !== undefined && statusOf(s, "01-spawn-2") !== undefined,
  );
  expect(landed.pendingSpawns).toEqual([]);
  expect(landed.heldSpawns.map((h) => [h.id, h.title, h.reason])).toEqual([["proposal-2", "B", "overlaps"]]);
  expect(eventsOf(world, "01", "spawn-adopted").map((e) => e.payload)).toEqual([
    { adopted: ["01-spawn-1", "01-spawn-2"], fromPending: ["proposal-1", "proposal-3"] },
  ]);

  await sibling.release();
  const rest = await quiet(second, "the pool at rest with B held", (s) => statusOf(s, "02") === "done");
  expect(rest.heldSpawns.map((h) => h.id)).toEqual(["proposal-2"]);
  expect(statusesOf(rest)).toEqual({ "01": "done", "01-spawn-1": "done", "01-spawn-2": "done", "02": "done" });
  for (const [id, title] of [["01-spawn-1", "A"], ["01-spawn-2", "C"]] as const) {
    expectSameBytes(readTicketFile(world.pool, `${id}.md`), spawnedFile(id, "01", title, { status: "done" }), `issues/${id}.md`);
  }
});

// engine/engine.test.ts:9398
conformance("restart", "a Pending spawn left in runs/held-spawns.json lands at the first boundary", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "none", "done")],
    config: CONFIG,
    poolFiles: {
      "runs/held-spawns.json": proposalsFile({
        seq: 1,
        pending: [{ id: "proposal-1", parentId: "01", origin: "ticket", proposal: proposal("Survivor"), at: "t0" }],
        held: [],
        recovered: [],
      }),
    },
  });
  const server = await t.start(world);
  const done = await approveReview(server);

  expect(statusOf(done, "01-spawn-1")).toBe("done");
  expect(done.spawnUsage.spawnedThisRun).toBe(1);
  expect(done.pendingSpawns).toEqual([]);
  expect((heldSpawnsFile(world) as { pending: unknown[] }).pending).toEqual([]);
  expect(eventsOf(world, "01", "spawn-adopted").map((e) => e.payload)).toEqual([
    { adopted: ["01-spawn-1"], fromPending: ["proposal-1"] },
  ]);
  expectSameBytes(
    readTicketFile(world.pool, "01-spawn-1.md"),
    spawnedFile("01-spawn-1", "01", "Survivor", { status: "done" }),
    "issues/01-spawn-1.md",
  );
});

// engine/engine.test.ts:9427
conformance(
  "restart",
  "a landing a stop cut short is settled at boot without landing twice, its blocks put back",
  async (t) => {
    // proposal-1's Ticket was written before the stop and proposal-2's was
    // not: the first is forgotten as landed, the second lands as it would have.
    const world = t.world({
      tickets: [
        ticket("01", "none", "done"),
        spawnedSeed("01-spawn-1", "01", "Landed", { status: "done" }),
        ticket("02"),
      ],
      config: CONFIG,
      poolFiles: {
        "runs/held-spawns.json": proposalsFile({
          seq: 2,
          pending: [
            {
              id: "proposal-1",
              parentId: "01",
              origin: "ticket",
              proposal: proposal("Landed", { blocks: ["02"] }),
              at: "t0",
              landing: "01-spawn-1",
            },
            {
              id: "proposal-2",
              parentId: "01",
              origin: "ticket",
              proposal: proposal("Not yet"),
              at: "t0",
              landing: "01-spawn-2",
            },
          ],
          held: [],
          recovered: [],
        }),
      },
    });
    const server = await t.start(world);
    const done = await approveReview(server);

    expect(await poolLog(server)).toContain(
      "ticket 01: pending spawn proposal-1 had landed as 01-spawn-1 before the restart; it blocks 02",
    );
    // The stop came before the landing's blocks: they are put back.
    expectSameBytes(
      readTicketFile(world.pool, "02-t.md"),
      "<!-- state: id=02 blocked-by=01-spawn-1 status=done -->\n\n# Ticket 02\n\nDo 02.\n",
      "issues/02-t.md",
    );
    expect(eventsOf(world, "01", "spawn-adopted").map((e) => e.payload)).toEqual([
      { adopted: ["01-spawn-1"], fromPending: ["proposal-1"], blocks: { "01-spawn-1": ["02"] } },
      { adopted: ["01-spawn-2"], fromPending: ["proposal-2"] },
    ]);
    expectSameBytes(
      readTicketFile(world.pool, "01-spawn-2.md"),
      spawnedFile("01-spawn-2", "01", "Not yet", { status: "done" }),
      "issues/01-spawn-2.md",
    );
    expect(hasTicket(world, "01-spawn-3.md")).toBe(false);
    expect((heldSpawnsFile(world) as { pending: unknown[] }).pending).toEqual([]);
    expect(statusesOf(done)).toEqual({ "01": "done", "01-spawn-1": "done", "01-spawn-2": "done", "02": "done" });
  },
);

// engine/spawn-proposals.test.ts:216
conformance("restart", "a landing mark whose Ticket never landed is cleared at boot, and the spawn lands once", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "none", "done")],
    config: CONFIG,
    poolFiles: {
      "runs/held-spawns.json": proposalsFile({
        seq: 2,
        pending: [
          {
            id: "proposal-2",
            parentId: "01",
            origin: "ticket",
            proposal: proposal("Mid-landing"),
            at: "t0",
            landing: "01-spawn-1",
          },
        ],
        held: [],
        recovered: [],
      }),
    },
  });
  const server = await t.start(world);
  const done = await approveReview(server);

  const log = await poolLog(server);
  expect(log.filter((line) => line.includes("before the restart"))).toEqual([]);
  expect(log).toContain("ticket 01: adopted spawn tickets 01-spawn-1");
  expect(eventsOf(world, "01", "spawn-adopted").map((e) => e.payload)).toEqual([
    { adopted: ["01-spawn-1"], fromPending: ["proposal-2"] },
  ]);
  expectSameBytes(
    readTicketFile(world.pool, "01-spawn-1.md"),
    spawnedFile("01-spawn-1", "01", "Mid-landing", { status: "done" }),
    "issues/01-spawn-1.md",
  );
  expect(hasTicket(world, "01-spawn-2.md")).toBe(false);
  expect((heldSpawnsFile(world) as { pending: unknown[] }).pending).toEqual([]);
  expect(statusesOf(done)).toEqual({ "01": "done", "01-spawn-1": "done" });
});

// ---------------------------------------------------------------------------
// Proposals a cap truncated before Held spawns existed
// ---------------------------------------------------------------------------

/** The time of the pre-ADR-0029 adoption every recovery case seeds: the recovery's key and its holds' time. */
const ADOPTED_AT = "2026-09-27T10:00:00.001Z";

// engine/engine.test.ts:8700
restartCase("proposals a cap truncated before Held spawns existed are recovered at boot, once", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "none", "done"), spawnedSeed("01-spawn-1", "01", "Adopted", { status: "done" })],
    config: CONFIG,
    poolFiles: {
      "runs/01.events.jsonl": eventsFile([
        {
          at: "2026-09-27T10:00:00.000Z",
          attempt: 1,
          kind: "spawn-rejected",
          payload: { title: "Rejected", reason: "blockedBy names tickets outside the pool: 99" },
        },
        { at: ADOPTED_AT, attempt: 1, kind: "spawn-adopted", payload: { adopted: ["01-spawn-1"], truncated: 1 } },
      ]),
    },
  });
  writeCheckpoint(
    world,
    preHoldingCheckpoint({ "01": "done", "01-spawn-1": "done" }, [
      proposal("Adopted"),
      proposal("Rejected", { blockedBy: ["99"] }),
      proposal("Truncated"),
    ]),
  );
  const first = await startLeg(t, world, 0);
  const recovered = await quiet(first, "the truncated proposal held", (s) => s.heldSpawns.length === 1);

  expect(recovered.heldSpawns.map((h) => [h.id, h.parentId, h.title, h.reason, h.at])).toEqual([
    ["proposal-1", "01", "Truncated", "per-run", ADOPTED_AT],
  ]);
  expect(readEvents(world.pool, "01").at(-1)).toMatchObject({
    attempt: 1,
    kind: "spawn-held",
    payload: { held: [{ id: "proposal-1", title: "Truncated", reason: "per-run" }], recovered: true },
  });
  expect(await poolLog(first)).toContain(
    "ticket 01: recovered 1 spawn proposal a cap truncated before held spawns existed: proposal-1",
  );
  expect(await heldAction(first, "discard", "proposal-1")).toEqual({ status: 200, body: { id: "proposal-1" } });
  await first.stop();

  // Neither the discard nor a second boot brings it back.
  const second = await startLeg(t, world, 1);
  const again = await quiet(second, "the restarted pool at rest", () => true);
  expect(again.heldSpawns).toEqual([]);
  expect(eventsOf(world, "01", "spawn-held")).toHaveLength(1);
  expect((heldSpawnsFile(world) as { recovered: string[] }).recovered).toEqual([`01@${ADOPTED_AT}`]);
});

// engine/spawn-proposals.test.ts:54
restartCase("a recovery is recorded with its holds in one write, so a later boot never runs it again", async (t) => {
  const titles = ["One", "Two", "Three", "Four", "Five", "Six", "Seven"];
  const children = titles.slice(0, 5).map((title, i) => spawnedSeed(`01-spawn-${i + 1}`, "01", title, { status: "done" }));
  const world = t.world({
    tickets: [ticket("01", "none", "done"), ...children],
    config: CONFIG,
    poolFiles: {
      "runs/01.events.jsonl": eventsFile([
        {
          at: ADOPTED_AT,
          attempt: 1,
          kind: "spawn-adopted",
          payload: { adopted: ["01-spawn-1", "01-spawn-2", "01-spawn-3", "01-spawn-4", "01-spawn-5"], truncated: 2 },
        },
      ]),
    },
  });
  writeCheckpoint(
    world,
    preHoldingCheckpoint(
      Object.fromEntries([["01", "done"], ...children.map((_, i) => [`01-spawn-${i + 1}`, "done"])]),
      titles.map((title) => proposal(title)),
    ),
  );
  const first = await startLeg(t, world, 0);
  const recovered = await quiet(first, "the last two proposals held", (s) => s.heldSpawns.length === 2);

  // The first five landed under the old per-attempt cap of five, so the two
  // it truncated were past that cap.
  expect(recovered.heldSpawns.map((h) => [h.id, h.title, h.reason, h.at])).toEqual([
    ["proposal-1", "Six", "per-attempt", ADOPTED_AT],
    ["proposal-2", "Seven", "per-attempt", ADOPTED_AT],
  ]);
  expectParsedEqual(
    heldSpawnsFile(world),
    {
      seq: 2,
      proposalFrom: 0,
      pending: [],
      held: [
        { id: "proposal-1", parentId: "01", origin: "ticket", proposal: proposal("Six"), reason: "per-attempt", at: ADOPTED_AT },
        { id: "proposal-2", parentId: "01", origin: "ticket", proposal: proposal("Seven"), reason: "per-attempt", at: ADOPTED_AT },
      ],
      recovered: [`01@${ADOPTED_AT}`],
    },
    "runs/held-spawns.json after the recovery",
  );
  for (const id of ["proposal-1", "proposal-2"]) {
    expect(await heldAction(first, "discard", id)).toEqual({ status: 200, body: { id } });
  }
  await first.stop();

  const second = await startLeg(t, world, 1);
  const again = await quiet(second, "the restarted pool at rest", () => true);
  expect(again.heldSpawns).toEqual([]);
  expectParsedEqual(
    heldSpawnsFile(world),
    { seq: 2, proposalFrom: 0, pending: [], held: [], recovered: [`01@${ADOPTED_AT}`] },
    "runs/held-spawns.json after the second boot",
  );
  expect(eventsOf(world, "01", "spawn-held")).toHaveLength(1);
});

// engine/engine.test.ts:8769
conformance("restart", "a truncation whose rejected proposal shares its title with another is not recovered", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "none", "done"), spawnedSeed("01-spawn-1", "01", "Twin", { status: "done" })],
    config: CONFIG,
    poolFiles: {
      "runs/01.events.jsonl": eventsFile([
        {
          at: "2026-09-27T10:00:00.000Z",
          attempt: 1,
          kind: "spawn-rejected",
          payload: { title: "Twin", reason: "blockedBy names tickets outside the pool: 99" },
        },
        { at: ADOPTED_AT, attempt: 1, kind: "spawn-adopted", payload: { adopted: ["01-spawn-1"], truncated: 1 } },
      ]),
    },
  });
  writeCheckpoint(
    world,
    preHoldingCheckpoint({ "01": "done", "01-spawn-1": "done" }, [
      proposal("Twin"),
      proposal("Truncated"),
      proposal("Twin", { blockedBy: ["99"] }),
    ]),
  );
  const server = await t.start(world);
  const rest = await quiet(server, "the pool at rest", () => true);

  expect(rest.heldSpawns).toEqual([]);
  expect(await poolLog(server)).toContain(
    "ticket 01: 1 spawn proposal truncated before held spawns existed could not be recovered: its rejected " +
      "proposal 'Twin' shares a title with another, so which one was rejected is unknown",
  );
  // Marked as recovered with nothing held, so no later boot weighs it again.
  expect((heldSpawnsFile(world) as { held: unknown[]; recovered: string[] })).toMatchObject({
    held: [],
    recovered: [`01@${ADOPTED_AT}`],
  });
  expect(eventsOf(world, "01", "spawn-held")).toEqual([]);
});
