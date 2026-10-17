import { expect } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { anyIsoTime, expectParsedEqual, expectSameBytes } from "../harness/equal.ts";
import { resume, settle, snapshot, statuses, type ResumeBody } from "../harness/pool-run.ts";
import { readCheckpoints, readEvents, readTicketFile, until } from "../harness/pool-files.ts";
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

const stillRunning = (world: World, id: string): boolean =>
  launches(world).includes(id) && !eventKinds(world, id).includes("exited");

const untilLaunchedTimes = (world: World, id: string, n: number): Promise<string[]> =>
  until(() => launches(world), (got) => got.filter((key) => key === id).length === n, {
    what: `${id} to launch ${n} times`,
    ms: 30_000,
  });

function appendAnswered(world: World, id: string, payload: Record<string, unknown>): void {
  const attempt = Math.max(0, ...readEvents(world.pool, id).map((event) => event.attempt));
  const event = { at: new Date().toISOString(), attempt, kind: "answered", payload };
  appendFileSync(join(world.pool, "runs", `${id}.events.jsonl`), `${JSON.stringify(event)}\n`);
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
  "answers given while a sibling runs are processed at once, in submission order, and relaunch their Tickets beside it",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b"), ticket("03", "c")], config: CONFIG });
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    world.stubs.script("02", { statuses: ["checkpoint", "done"] });
    const held = world.stubs.hold("03");
    const server = await t.start(world);
    await untilLaunched(server, world, ["03"], (s) => interrupted(s, "01") && interrupted(s, "02"), "01 and 02 at their checkpoints");

    await accept(server, { ticketId: "02", note: "answered first" });
    await accept(server, { ticketId: "01", note: "answered second" });

    const relaunched = await until(
      () => snapshot(server),
      (s) => statuses(s)["01"] === "done" && statuses(s)["02"] === "done",
      { what: "01 and 02 run again to done", ms: 30_000 },
    );
    expect(stillRunning(world, "03")).toBe(true);
    expect(launches(world).filter((key) => key !== "03").sort()).toEqual(["01", "01", "02", "02"]);
    expect(relaunched.state.queuedAnswers).toEqual([]);
    const log = relaunched.state.log;
    const at = (line: string): number => log.indexOf(line);
    expect(at("interrupt answered for 02 (checkpoint): resumed")).toBeGreaterThan(-1);
    expect(at("interrupt answered for 01 (checkpoint): resumed")).toBeGreaterThan(at("interrupt answered for 02 (checkpoint): resumed"));
    const lastStart = (id: string): number => Math.max(...log.map((line, i) => (line.startsWith(`start ${id} at `) ? i : -1)));
    expect(lastStart("01")).toBeGreaterThan(at("interrupt answered for 01 (checkpoint): resumed"));
    expect(lastStart("02")).toBeGreaterThan(at("interrupt answered for 02 (checkpoint): resumed"));
    const kinds01 = eventKinds(world, "01");
    expect(kinds01.indexOf("answered")).toBeLessThan(kinds01.lastIndexOf("spawned"));
    expect(queueFile(world).answers.map((a) => [a.ticketId, a.kind, a.processedAt !== null])).toEqual([
      ["02", "checkpoint", true],
      ["01", "checkpoint", true],
    ]);

    await held.release();
    const reviewed = await settle(server, (s) => interrupted(s, REVIEW, "review"), { what: "the Review" });
    expect(statuses(reviewed)).toEqual({ "01": "done", "02": "done", "03": "done" });
  },
);

// engine/engine.test.ts:12351
conformance(
  "interrupts",
  "processed answers are persisted while the Attempts they relaunched still run",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b"), ticket("03", "c")], config: CONFIG });
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
    await untilLaunchedTimes(world, "01", 2);
    await untilLaunchedTimes(world, "02", 2);

    const rows = readCheckpoints(world.pool).map(
      (row) => row.state as { tickets: Record<string, string>; interrupts: unknown[]; log: string[] },
    );
    const answeredRow = rows.find(
      (row) =>
        row.log.includes("interrupt answered for 02 (checkpoint): resumed") &&
        row.log.includes("interrupt answered for 01 (checkpoint): resumed"),
    );
    expect(answeredRow).toBeDefined();
    expect(answeredRow!.interrupts).toEqual([]);
    expect(["ready", "in-progress"]).toContain(answeredRow!.tickets["01"]!);
    expect(["ready", "in-progress"]).toContain(answeredRow!.tickets["02"]!);

    writeFileSync(rerun, "go");
    await held.release();
    const reviewed = await settle(server, (s) => interrupted(s, REVIEW, "review"), { what: "the Review" });
    expect(statuses(reviewed)).toEqual({ "01": "done", "02": "done", "03": "done" });
    expect(queueFile(world).answers.every((a) => a.processedAt !== null)).toBe(true);
  },
);

conformance(
  "interrupts",
  "an answer given while a sibling runs comes back in its 202 as a Queued answer, then is processed while the sibling still runs",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\npick a name" }), ticket("02", "b")],
      config: CONFIG,
    });
    world.stubs.script("01", { statuses: ["checkpoint", "done"], brief: "pick a name" });
    const held = world.stubs.hold("02");
    const server = await t.start(world);
    const socket = await t.socket(server, { visible: true });
    await untilLaunched(server, world, ["01", "02"], (s) => interrupted(s, "01"), "01 at its checkpoint");

    const reply = await accept(server, { ticketId: "01", note: "the name is Foo" });
    expect(reply.state.queuedAnswers.map((a) => [a.ticketId, a.kind])).toEqual([["01", "checkpoint"]]);
    expect(interrupted(reply, "01")).toBe(true);
    expect(answered(world, "01")).toHaveLength(1);

    const processed = await until(() => snapshot(server), (s) => statuses(s)["01"] === "done", {
      what: "01 to run again to done",
      ms: 30_000,
    });
    expect(stillRunning(world, "02")).toBe(true);
    expect(processed.state.queuedAnswers).toEqual([]);
    expect(interrupted(processed, "01")).toBe(false);
    expect(queueFile(world).answers.map((a) => [a.ticketId, a.processedAt !== null])).toEqual([["01", true]]);
    expectSameBytes(
      readTicketFile(world.pool, "01-a.md"),
      `${marker("01", "none", "done")}\n\n# 01\n\n---\n\n## Brief\n\npick a name\n\n## Resume note\n\nthe name is Foo\n`,
      "issues/01-a.md",
    );

    await held.release();
    const reviewed = await settle(server, (s) => interrupted(s, REVIEW, "review"), { what: "the Review" });
    expect(statuses(reviewed)).toEqual({ "01": "done", "02": "done" });
    await socket.waitFor(
      () => socket.pushed !== null && interrupted(socket.pushed.snapshot as EnrichedSnapshot, REVIEW, "review"),
      { what: "the Review pushed on the socket" },
    );
    const pushed = socket.pushed!.snapshot as EnrichedSnapshot;
    expect(pushed.state.queuedAnswers).toEqual([]);
    expect(interrupted(pushed, "01")).toBe(false);
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

conformance(
  "interrupts",
  "Queued answers a stopped server left unprocessed are drained by the next server's first Tick, in submission order",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b")], config: CONFIG });
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    world.stubs.script("02", { statuses: ["checkpoint", "done"] });
    const first = await t.start(world);
    await settle(first, (s) => interrupted(s, "01") && interrupted(s, "02"), { what: "01 and 02 at their checkpoints" });
    await first.stop();

    appendAnswered(world, "02", { kind: "checkpoint" });
    appendAnswered(world, "01", { kind: "checkpoint" });
    const at = new Date().toISOString();
    const records = [
      { seq: 1, ticketId: "02", kind: "checkpoint", note: "answered first", at, processedAt: null },
      { seq: 2, ticketId: "01", kind: "checkpoint", note: "answered second", at, processedAt: null },
    ];
    writeFileSync(join(world.pool, "runs", "queued-answers.json"), JSON.stringify({ nextSeq: 3, answers: records }, null, 2));

    const second = await t.start(world);
    const reviewed = await settle(second, (s) => interrupted(s, REVIEW, "review"), { what: "the Review" });
    expect(statuses(reviewed)).toEqual({ "01": "done", "02": "done" });
    expect(launches(world).sort()).toEqual(["01", "01", "02", "02"]);
    const log = reviewed.state.log;
    expect(log.indexOf("interrupt answered for 02 (checkpoint): resumed")).toBeGreaterThan(-1);
    expect(log.indexOf("interrupt answered for 01 (checkpoint): resumed")).toBeGreaterThan(
      log.indexOf("interrupt answered for 02 (checkpoint): resumed"),
    );
    expect(queueFile(world).answers.map((a) => [a.seq, a.ticketId, a.processedAt !== null])).toEqual([
      [1, "02", true],
      [2, "01", true],
    ]);
    expect(answered(world, "01")).toHaveLength(1);
    expect(answered(world, "02")).toHaveLength(1);
  },
);
