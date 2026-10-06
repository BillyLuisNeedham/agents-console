/**
 * Queued answers and the accept/process split (ADR-0004), seen from outside
 * the server (ADR-0036): an answer that lands while a super-step is in
 * flight is accepted at once (202, its `answered` event and its record in
 * runs/queued-answers.json) and processed only at the next super-step
 * boundary, in submission order, its state made durable before anything
 * else is scheduled; the snapshot carries it as a Queued answer meanwhile; a
 * retried answer is acknowledged without a second record, and a different
 * one for the same Ticket is refused. Ticket C08 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over, or the uncovered behaviour it pins.
 *
 * A super-step is held in flight by a Ticket whose stub is held open
 * (`world.stubs.hold`) until the case releases it; a held stub waits as long
 * as the case needs, where `waitFor` gives up after ten seconds.
 */

import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushedSnapshot } from "../../protocol/protocol.ts";
import type { EnrichedSnapshot, PoolConfig } from "../../protocol/wire.ts";
import { applySnapshotDelta } from "../fixtures/socket-protocol.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { anyIsoTime, expectParsedEqual, expectSameBytes } from "../harness/equal.ts";
import { resume, settle, snapshot, statuses, type ResumeBody } from "../harness/pool-run.ts";
import { readCheckpoints, readEvents, readStateLine, readTicketFile, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";

const CONFIG = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;
const REVIEW = "REVIEW";

const marker = (id: string, blockedBy = "none", status = "ready"): string =>
  `<!-- state: id=${id} blocked-by=${blockedBy} status=${status} -->`;

function ticket(id: string, letter: string, options: { blockedBy?: string; body?: string } = {}): TicketSeed {
  return {
    file: `${id}-${letter}.md`,
    marker: marker(id, options.blockedBy),
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

/** Every launch's key, in launch order. */
const launches = (world: World): string[] => world.stubs.calls().map((call) => call.key);
const eventKinds = (world: World, id: string): string[] => readEvents(world.pool, id).map((e) => e.kind);
const answered = (world: World, id: string) => readEvents(world.pool, id).filter((e) => e.kind === "answered");
const interrupted = (s: EnrichedSnapshot, id: string, kind = "checkpoint"): boolean =>
  s.state.interrupts.some((i) => i.ticketId === id && i.kind === kind);
const queuedIds = (s: EnrichedSnapshot): string[] => s.state.queuedAnswers.map((a) => a.ticketId);

/** runs/queued-answers.json, parsed. */
interface QueueFile {
  nextSeq: number;
  answers: { seq: number; ticketId: string; kind: string; processedAt: string | null }[];
}
const queueFile = (world: World): QueueFile =>
  JSON.parse(readFileSync(join(world.pool, "runs", "queued-answers.json"), "utf8")) as QueueFile;

/** POST /api/resume, which must be accepted with 202; its snapshot. */
async function accept(server: CaseServer, body: ResumeBody): Promise<EnrichedSnapshot> {
  const got = await resume(server, body);
  expect(got.status, `POST /api/resume ${JSON.stringify(body)}: ${got.text}`).toBe(202);
  return got.json<{ snapshot: EnrichedSnapshot }>().snapshot;
}

/** Wait until `keys` have all launched, and `also` holds of the snapshot. */
async function untilLaunched(
  server: CaseServer,
  world: World,
  keys: string[],
  also: (s: EnrichedSnapshot) => boolean,
  what: string,
): Promise<EnrichedSnapshot> {
  await until(() => launches(world), (got) => keys.every((key) => got.includes(key)), {
    what: `${keys.join(", ")} to launch`,
    ms: 30_000,
  });
  return until(() => snapshot(server), also, { what, ms: 30_000 });
}

/** Every version a socket was pushed, in order, each its whole snapshot. */
function pushedVersions(socket: SocketClient): EnrichedSnapshot[] {
  const versions: EnrichedSnapshot[] = [];
  let held: PushedSnapshot | null = null;
  for (const frame of socket.frames) {
    if (frame.type === "snapshot") {
      held = frame.snapshot === null ? null : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
    } else if (frame.type === "delta" && held !== null) {
      held = applySnapshotDelta(held, frame.delta);
    } else {
      continue;
    }
    if (held !== null) versions.push(held.snapshot);
  }
  return versions;
}

/**
 * The first version pushed on a socket, from the `from`th on, that `match`
 * holds of, waited for.
 */
async function pushedWhen(
  socket: SocketClient,
  match: (s: EnrichedSnapshot) => boolean,
  what: string,
  from = 0,
): Promise<EnrichedSnapshot> {
  const versions = await until(() => pushedVersions(socket).slice(from), (all) => all.some(match), { what, ms: 30_000 });
  return versions.find(match)!;
}

/**
 * Bash for a launch that waits for `gate`, however long the case takes, up
 * to two minutes; over at once when the world is deleted.
 */
function awaitGate(gate: string): string {
  return [
    "for _ in $(seq 1 2400); do",
    `  [ -e ${JSON.stringify(gate)} ] && exit 0`,
    '  [ -d "$CONFORMANCE_STUBS" ] || exit 0',
    "  sleep 0.05",
    "done",
  ].join("\n");
}

// engine/engine.test.ts:12263
conformance(
  "interrupts",
  "answers accepted mid-super-step are queued and drained in submission order at the boundary",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "a"), ticket("02", "b"), ticket("03", "c"), ticket("04", "d", { blockedBy: "03" })],
      config: CONFIG,
    });
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    world.stubs.script("02", { statuses: ["checkpoint", "done"] });
    const held = world.stubs.hold("04");
    const server = await t.start(world);
    await untilLaunched(server, world, ["04"], (s) => interrupted(s, "01") && interrupted(s, "02"), "01 and 02 at their checkpoints");

    await accept(server, { ticketId: "02", note: "answered first" });
    await accept(server, { ticketId: "01", note: "answered second" });

    // Accepted at once: the answered events and the queued records landed
    // while 04 holds the super-step open, and nothing relaunched.
    expect(eventKinds(world, "02")).toEqual(["scheduled", "spawned", "exited", "checkpoint", "answered"]);
    expect(readEvents(world.pool, "02").at(-1)!.payload).toEqual({ kind: "checkpoint" });
    const queue = queueFile(world);
    expect(queue.answers.map((a) => [a.ticketId, a.kind, a.processedAt])).toEqual([
      ["02", "checkpoint", null],
      ["01", "checkpoint", null],
    ]);
    expect(launches(world).slice(0, 3).sort()).toEqual(["01", "02", "03"]);
    expect(launches(world).slice(3)).toEqual(["04"]);
    const waiting = await snapshot(server);
    expect(queuedIds(waiting)).toEqual(["02", "01"]);
    expect(statuses(waiting)).toMatchObject({ "01": "checkpoint", "02": "checkpoint" });

    await held.release();
    const reviewed = await settle(server, (s) => interrupted(s, REVIEW, "review"), { what: "the Review" });
    expect(launches(world).slice(4).sort()).toEqual(["01", "02"]);
    const log = reviewed.state.log;
    const at = (line: string): number => log.indexOf(line);
    const exited04 = log.findIndex((line) => line.startsWith("ticket 04: exited"));
    expect(exited04).toBeGreaterThan(-1);
    expect(at("interrupt answered for 02 (checkpoint): resumed")).toBeGreaterThan(exited04);
    expect(at("interrupt answered for 01 (checkpoint): resumed")).toBeGreaterThan(at("interrupt answered for 02 (checkpoint): resumed"));
    expect(at("super-step 3: 01, 02")).toBeGreaterThan(at("interrupt answered for 01 (checkpoint): resumed"));
    // The answered event comes before the Attempt it let run.
    const kinds01 = eventKinds(world, "01");
    expect(kinds01.indexOf("answered")).toBeLessThan(kinds01.lastIndexOf("spawned"));
    expect(queueFile(world).answers.every((a) => a.processedAt !== null)).toBe(true);
    expect(reviewed.state.queuedAnswers).toEqual([]);
  },
);

// engine/engine.test.ts:12351
conformance(
  "interrupts",
  "drained answers are persisted before the next super-step is scheduled",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "a"), ticket("02", "b"), ticket("03", "c"), ticket("04", "d", { blockedBy: "03" })],
      config: CONFIG,
    });
    // The re-runs of 01 and 02 hold until the case has read console.db.
    const rerun = join(world.root, "release-reruns");
    for (const id of ["01", "02"]) {
      world.stubs.script(id, { statuses: ["checkpoint", "done"], run: ["true", awaitGate(rerun)] });
    }
    const held = world.stubs.hold("03");
    const server = await t.start(world);
    await untilLaunched(server, world, ["03"], (s) => interrupted(s, "01") && interrupted(s, "02"), "01 and 02 at their checkpoints");

    await accept(server, { ticketId: "02", note: "answered first" });
    await accept(server, { ticketId: "01", note: "answered second" });
    await held.release();

    // The boundary drained both answers and scheduled the re-runs, which
    // now hold: the newest checkpoint row already has the answers applied.
    await until(() => launches(world), (got) => got.filter((key) => key === "01" || key === "02").length === 4, {
      what: "the re-runs of 01 and 02",
      ms: 30_000,
    });
    const persisted = readCheckpoints(world.pool).at(-1)!.state as {
      tickets: Record<string, string>;
      interrupts: unknown[];
      log: string[];
    };
    expect(persisted.tickets["01"]).toBe("ready");
    expect(persisted.tickets["02"]).toBe("ready");
    expect(persisted.interrupts).toEqual([]);
    expect(persisted.log).toContain("interrupt answered for 02 (checkpoint): resumed");
    expect(persisted.log).toContain("interrupt answered for 01 (checkpoint): resumed");

    writeFileSync(rerun, "go");
    const reviewed = await settle(server, (s) => interrupted(s, REVIEW, "review"), { what: "the Review" });
    expect(statuses(reviewed)).toEqual({ "01": "done", "02": "done", "03": "done", "04": "done" });
    expect(launches(world).slice(0, 3).sort()).toEqual(["01", "02", "03"]);
    expect(launches(world).slice(3).sort()).toEqual(["01", "02", "04"]);
    expect(queueFile(world).answers.every((a) => a.processedAt !== null)).toBe(true);
  },
);

// engine/engine.test.ts:12422
conformance(
  "interrupts",
  "a Queued answer is pushed on the socket at acceptance and gone once the boundary processes it",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "a"), ticket("02", "b"), ticket("03", "c", { blockedBy: "02" })],
      config: CONFIG,
    });
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    const held = world.stubs.hold("03");
    const server = await t.start(world);
    const socket = await t.socket(server, { visible: true });
    await untilLaunched(server, world, ["03"], (s) => interrupted(s, "01"), "01 at its checkpoint");
    const from = pushedVersions(socket).length;

    await accept(server, { ticketId: "01", note: "go on" });
    const queued = await pushedWhen(
      socket,
      (s) => queuedIds(s).includes("01"),
      "a version carrying 01's Queued answer",
      from,
    );
    expect(queued.state.queuedAnswers.map((a) => [a.ticketId, a.kind])).toEqual([["01", "checkpoint"]]);
    expect(interrupted(queued, "01")).toBe(true);

    await held.release();
    await settle(server, (s) => interrupted(s, REVIEW, "review"), { what: "the Review" });
    const settled = await pushedWhen(
      socket,
      (s) => s.phase === "quiescent" && interrupted(s, REVIEW, "review"),
      "the resting version pushed",
    );
    expect(settled.state.queuedAnswers).toEqual([]);
    expect(interrupted(settled, "01")).toBe(false);
    expect(statuses(settled)).toEqual({ "01": "done", "02": "done", "03": "done" });
  },
);

// engine/engine.test.ts:12468
conformance(
  "interrupts",
  "a Review approval is recorded as an answered event and a queued record, and ends the run",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
    const server = await t.start(world);
    await settle(server, (s) => interrupted(s, REVIEW, "review"), { what: "the Review" });

    await accept(server, { ticketId: REVIEW, action: "approve", note: "ship it" });
    const done = await settle(server, (s) => s.phase === "done", { what: "the run to end" });

    expect(readEvents(world.pool, REVIEW).map((e) => [e.attempt, e.kind, e.payload])).toEqual([
      [0, "answered", { kind: "review" }],
    ]);
    expectParsedEqual(
      readFileSync(join(world.pool, "runs", "queued-answers.json"), "utf8"),
      {
        nextSeq: 2,
        answers: [
          {
            seq: 1,
            ticketId: REVIEW,
            kind: "review",
            approve: true,
            note: "ship it",
            at: anyIsoTime(),
            processedAt: anyIsoTime(),
          },
        ],
      },
      "runs/queued-answers.json",
    );
    expect(done.state.log).toContain("review approved: the run is complete (ship it)");
    expect(done.state.log.at(-1)).toBe("pool done: every ticket reached done");
  },
);

// engine/engine.test.ts:12662
conformance(
  "interrupts",
  "a retried answer is acknowledged without a second event or record, and is processed once",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "a"), ticket("02", "b"), ticket("03", "c", { blockedBy: "02" })],
      config: CONFIG,
    });
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    const held = world.stubs.hold("03");
    const server = await t.start(world);
    await untilLaunched(server, world, ["03"], (s) => interrupted(s, "01"), "01 at its checkpoint");

    await accept(server, { ticketId: "01", note: "carry on" });
    await accept(server, { ticketId: "01", note: "carry on" });
    expect(answered(world, "01")).toHaveLength(1);
    expect(queueFile(world).answers).toHaveLength(1);
    expect(queuedIds(await snapshot(server))).toEqual(["01"]);

    await held.release();
    const reviewed = await settle(server, (s) => interrupted(s, REVIEW, "review"), { what: "the Review" });
    expect(statuses(reviewed)).toEqual({ "01": "done", "02": "done", "03": "done" });
    expect(launches(world).filter((key) => key === "01")).toHaveLength(2);
    expect(answered(world, "01")).toHaveLength(1);
    const queue = queueFile(world);
    expect(queue.answers).toHaveLength(1);
    expect(queue.answers[0]!.processedAt).not.toBeNull();
    expect(reviewed.state.log.filter((line) => line === "interrupt answered for 01 (checkpoint): resumed")).toHaveLength(1);
  },
);

// engine/engine.test.ts:12897, with the uncovered behaviour of engine/engine.ts:5470-5477 and
// engine/server.ts:1943: a different answer for a Ticket with one queued is a 409.
conformance(
  "interrupts",
  "an answer accepted while a sibling still runs waits as a Queued answer, refuses a second one, and is processed at the boundary",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\npick a name" }), ticket("02", "b")],
      config: CONFIG,
    });
    world.stubs.script("01", { statuses: ["checkpoint", "done"], brief: "pick a name" });
    const held = world.stubs.hold("02");
    const server = await t.start(world);
    const socket = await t.socket(server, { visible: true });
    // 01's checkpoint is raised at its exit, while 02 still runs.
    await untilLaunched(server, world, ["01", "02"], (s) => interrupted(s, "01"), "01 at its checkpoint");

    const reply = await accept(server, { ticketId: "01", note: "the name is Foo" });
    expect(queuedIds(reply)).toEqual(["01"]);
    expect(interrupted(reply, "01")).toBe(true);
    const queued = await pushedWhen(socket, (s) => queuedIds(s).includes("01"), "a version carrying 01's Queued answer");
    expect(queued.state.queuedAnswers.map((a) => [a.ticketId, a.kind])).toEqual([["01", "checkpoint"]]);
    expect(queued.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "pick a name" }]);
    expect(answered(world, "01")).toHaveLength(1);
    expect(queueFile(world).answers.map((a) => [a.ticketId, a.processedAt])).toEqual([["01", null]]);
    // Queued, not processed: the state line still reads checkpoint.
    expect(readStateLine(world.pool, "01-a.md").status).toBe("checkpoint");

    const close = await resume(server, { ticketId: "01", action: "close", note: "drop it" });
    expect(close.status).toBe(409);
    expectParsedEqual(close.text, { error: "answer: ticket 01 already has an answer queued" }, "the 409");
    expect(answered(world, "01")).toHaveLength(1);
    expect(queueFile(world).answers).toHaveLength(1);

    await held.release();
    const reviewed = await settle(server, (s) => interrupted(s, REVIEW, "review"), { what: "the Review" });
    expect(statuses(reviewed)).toEqual({ "01": "done", "02": "done" });
    expect(queueFile(world).answers[0]!.processedAt).not.toBeNull();
    expectSameBytes(
      readTicketFile(world.pool, "01-a.md"),
      `${marker("01", "none", "done")}\n\n# 01\n\n---\n\n## Brief\n\npick a name\n\n## Resume note\n\nthe name is Foo\n`,
      "issues/01-a.md",
    );
  },
);
