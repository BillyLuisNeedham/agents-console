/**
 * Raising and answering Interrupts, seen from outside the server (ADR-0036):
 * the checkpoint, crash, deadlock and config Interrupts a run raises, what
 * each carries, and what POST /api/resume does with each: a resume with a
 * note re-runs the Ticket and leaves the note in its file, a resume naming
 * nothing pending is refused, approve and reject are refused anywhere but the
 * Review gate and a merge-approval. Ticket C08 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over, or the uncovered behaviour it pins.
 *
 * The stubs on PATH play the agents. Every answer here lands on an idle pool,
 * so it is processed the moment it is accepted; answers queued behind a
 * running super-step are interrupts-queued.test.ts's.
 */

import { expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../engine/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { expectParsedEqual, expectSameBytes } from "../harness/equal.ts";
import { answer, approveReview, resume, settle, snapshot, statuses } from "../harness/pool-run.ts";
import { readEvents, readStateLine, readTicketFile } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";

const CONFIG = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;

const marker = (id: string, blockedBy = "none", status = "ready"): string =>
  `<!-- state: id=${id} blocked-by=${blockedBy} status=${status} -->`;

/** A Ticket `<id>-<letter>.md`, ready, with an optional body. */
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
const pending = (s: EnrichedSnapshot): [string, string][] => s.state.interrupts.map((i) => [i.ticketId, i.kind]);

/** The run once it rests with an Interrupt raised. */
const firstInterrupt = (server: CaseServer): Promise<EnrichedSnapshot> =>
  settle(server, (s) => s.state.interrupts.length > 0, { what: "an Interrupt" });

/** The run once it rests at the Review gate. */
const atReview = (server: CaseServer): Promise<EnrichedSnapshot> =>
  settle(server, (s) => pending(s).join() === "REVIEW,review", { what: "the Review" });

// ---------------------------------------------------------------------------
// Config Interrupts
// ---------------------------------------------------------------------------

/** The config Interrupt's body for a Ticket missing `field` (engine/engine.ts). */
const configBody = (id: string, field: "harness" | "model"): string =>
  `ticket ${id} has no ${field}: set one in console.json (an assign entry for ${id}, or defaults.${field}) ` +
  "and answer resume. The pool reloads console.json at the next super-step boundary and schedules the " +
  "ticket on what it finds.";

// engine/engine.test.ts:399
conformance(
  "interrupts",
  "a Ticket with no Assignment is held at a config Interrupt naming the fix, and runs once console.json gains one",
  async (t) => {
    // No console.json at all.
    const world = t.world({ tickets: [ticket("01", "a")] });
    const server = await t.start(world);

    const held = await firstInterrupt(server);
    expect(held.phase).toBe("quiescent");
    expect(held.state.interrupts).toEqual([{ ticketId: "01", kind: "config", body: configBody("01", "harness") }]);
    const card = held.state.tickets.find((x) => x.id === "01")!;
    expect(card.status).toBe("checkpoint");
    expect(card.assignment).toEqual({ harness: null, model: null, drivers: "implement" });
    expect(held.state.log).toContain("ticket 01: no harness; config interrupt raised instead of a launch");
    expect(readEvents(world.pool, "01").map((e) => [e.attempt, e.kind, e.payload])).toEqual([
      [0, "unassigned", { missing: "harness" }],
    ]);
    // The body lands as the Ticket's Brief, as a checkpoint's would.
    expectSameBytes(
      readTicketFile(world.pool, "01-a.md"),
      `${marker("01", "none", "checkpoint")}\n\n# body\n\n---\n\n## Brief\n\n${configBody("01", "harness")}\n`,
      "issues/01-a.md",
    );
    expect(launches(world)).toEqual([]);

    writeFileSync(
      join(world.pool, "console.json"),
      JSON.stringify({ defaults: { harness: "claude", model: "stub-model" } }, null, 2),
    );
    await answer(server, { ticketId: "01" });
    const reviewed = await atReview(server);
    expect(reviewed.state.log).toContain("interrupt answered for 01 (config): resumed");
    expect(reviewed.state.log).toContain("config reloaded: defaults");
    const launched = world.stubs.calls();
    expect(launched.map((call) => [call.key, call.harness])).toEqual([["01", "claude"]]);
    const argv = launched[0]!.argv;
    expect(argv[argv.indexOf("--model") + 1]).toBe("stub-model");
    const done = await approveReview(server);
    expect(statuses(done)).toEqual({ "01": "done" });
  },
);

// engine/engine.test.ts:450
conformance("interrupts", "a config Interrupt resumed with console.json unchanged is raised again, the pool alive", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: { defaults: { harness: "claude" } } });
  const server = await t.start(world);

  const held = await firstInterrupt(server);
  expect(held.state.interrupts).toEqual([{ ticketId: "01", kind: "config", body: configBody("01", "model") }]);

  await answer(server, { ticketId: "01" });
  const again = await settle(
    server,
    (s) => s.state.log.includes("interrupt answered for 01 (config): resumed") && s.state.interrupts.length > 0,
    { what: "the config Interrupt raised again" },
  );
  expect(again.phase).toBe("quiescent");
  expect(again.state.interrupts).toEqual([{ ticketId: "01", kind: "config", body: configBody("01", "model") }]);
  expect(again.state.log.filter((line) => line === "ticket 01: no model; config interrupt raised instead of a launch")).toHaveLength(2);
  expect(eventKinds(world, "01")).toEqual(["unassigned", "answered", "unassigned"]);
  expect(launches(world)).toEqual([]);
});

// ---------------------------------------------------------------------------
// What a raised Interrupt carries
// ---------------------------------------------------------------------------

// engine/engine.test.ts:7253
conformance("interrupts", "a checkpoint Interrupt carries the Brief the Outcome wrote, and its dependent waits", async (t) => {
  const brief = "1. did the first half\n2. human must pick a name";
  const world = t.world({
    tickets: [ticket("01", "a", { body: `# 01\n\n## Brief\n\n${brief}\n\n## Notes\n\nunrelated` }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  world.stubs.script("01", { status: "checkpoint", brief });
  const server = await t.start(world);

  const held = await firstInterrupt(server);
  expect(held.phase).toBe("quiescent");
  expect(held.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: brief }]);
  expect(statuses(held)).toEqual({ "01": "checkpoint", "02": "ready" });
  expect(held.state.log.slice(-2)).toEqual(["interrupt raised for 01 (checkpoint)", "pool quiescent: interrupts pending for 01"]);
  // The Brief section is landed afresh at the end and the rest kept, less
  // the blank lines that stood before the old Brief (NOT-PORTED.md).
  expectSameBytes(
    readTicketFile(world.pool, "01-a.md"),
    `${marker("01", "none", "checkpoint")}\n\n# 01\n## Notes\n\nunrelated\n\n---\n\n## Brief\n\n${brief}\n`,
    "issues/01-a.md",
  );
  expect(launches(world)).toEqual(["01"]);
});

// engine/engine.test.ts:7293
conformance("interrupts", "a crash Interrupt names the exit, the log and the missing Outcome", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  world.stubs.script("01", { status: "keep", exitCode: 1 });
  const server = await t.start(world);

  const held = await firstInterrupt(server);
  expect(held.phase).toBe("quiescent");
  expect(held.state.interrupts).toEqual([
    {
      ticketId: "01",
      kind: "crash",
      body:
        `crash: harness exited 1\n${join(world.pool, "runs", "01.log")}\n\n` +
        `outcome file: ${join(world.pool, "runs", "01.outcome.json")} (missing)\n`,
    },
  ]);
  expect(held.state.log).toContain("ticket 01: exited 1, marker in-progress, crash: harness exited 1");
  expect(held.state.log).toContain("interrupt raised for 01 (crash)");
});

// Uncovered behaviour: engine/engine.ts:9474-9482 and 3785-3801.
conformance("interrupts", "a crash Interrupt quotes the attempt's last log lines between the log path and the Outcome", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  world.stubs.script("01", { stdout: "first line\nsecond line\nthird line\n", outcomeRaw: "{ not json" });
  const server = await t.start(world);

  const held = await firstInterrupt(server);
  const tail = ["first line", "second line", "third line"];
  expect(held.state.interrupts).toEqual([
    {
      ticketId: "01",
      kind: "crash",
      body:
        `crash: outcome is not parseable JSON\n${join(world.pool, "runs", "01.log")}\n\n` +
        `${tail.join("\n")}\n\n` +
        `outcome file: ${join(world.pool, "runs", "01.outcome.json")} (exists)\n`,
    },
  ]);
  const events = readEvents(world.pool, "01");
  expect(events.find((e) => e.kind === "exited")?.payload).toEqual({
    code: 0,
    status: "in-progress",
    logTail: tail,
    outcomeExists: true,
  });
  expect(events.find((e) => e.kind === "crash")?.payload).toEqual({
    code: 0,
    reason: "outcome is not parseable JSON",
    logTail: tail,
    outcomeExists: true,
  });
});

// ---------------------------------------------------------------------------
// Answering with POST /api/resume
// ---------------------------------------------------------------------------

// engine/engine.test.ts:7427
conformance("interrupts", "a resume with a note re-runs the checkpointed Ticket and the pool carries on", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\nneed a decision" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  await firstInterrupt(server);

  const accepted = await resume(server, { ticketId: "01", note: "carry on with option two" });
  expect(accepted.status).toBe(202);
  await atReview(server);
  const done = await approveReview(server);

  expect(done.state.interrupts).toEqual([]);
  expect(statuses(done)).toEqual({ "01": "done", "02": "done" });
  expect(launches(world)).toEqual(["01", "01", "02"]);
  expect(done.state.log).toContain("interrupt answered for 01 (checkpoint): resumed");
  expect(readStateLine(world.pool, "01-a.md").line).toBe(marker("01", "none", "done"));
  expect(readStateLine(world.pool, "02-b.md").line).toBe(marker("02", "01", "done"));
});

// engine/engine.test.ts:7508
conformance("interrupts", "a resume note is appended to the Ticket file under its own heading", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\nneed a decision" })], config: CONFIG });
  world.stubs.script("01", { statuses: ["checkpoint", "done"], brief: "need a decision" });
  const server = await t.start(world);
  await firstInterrupt(server);

  await answer(server, { ticketId: "01", note: "picked the name Foo" });
  await atReview(server);
  expectSameBytes(
    readTicketFile(world.pool, "01-a.md"),
    `${marker("01", "none", "done")}\n\n# 01\n\n---\n\n## Brief\n\nneed a decision\n` +
      "\n## Resume note\n\npicked the name Foo\n",
    "issues/01-a.md",
  );
});

// engine/engine.test.ts:7529
conformance("interrupts", "a resume for a Ticket with no pending Interrupt is refused", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  world.stubs.script("01", { status: "checkpoint" });
  const server = await t.start(world);
  await firstInterrupt(server);

  const refused = await resume(server, { ticketId: "02" });
  expect(refused.status).toBe(400);
  expectParsedEqual(refused.text, { error: "resume: no pending interrupt for ticket 02" }, "the 400");
  expect(pending(await snapshot(server))).toEqual([["01", "checkpoint"]]);
  expect(existsSync(join(world.pool, "runs", "queued-answers.json"))).toBe(false);
});

// engine/engine.test.ts:7546
conformance("interrupts", "a deadlock resumed once its pool files are fixed runs both Tickets to done", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { blockedBy: "02" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  const server = await t.start(world);
  const stuck = await settle(server, (s) => s.state.interrupts.length === 2, { what: "both deadlocks" });
  expect(pending(stuck)).toEqual([
    ["01", "deadlock"],
    ["02", "deadlock"],
  ]);

  writeFileSync(join(world.pool, "issues", "02-b.md"), `${marker("02")}\n\n# 02\n`);
  await answer(server, { ticketId: "02", note: "broke the cycle" });
  await atReview(server);
  const done = await approveReview(server);

  expect(done.state.interrupts).toEqual([]);
  expect(statuses(done)).toEqual({ "01": "done", "02": "done" });
  expect(launches(world)).toEqual(["02", "01"]);
  expect(done.state.log).toContain("interrupt answered for 02 (deadlock): resumed");
});

// engine/engine.test.ts:7675, with the uncovered behaviour of engine/server.ts:1918-1926: a
// POST /api/resume that names no action is a plain resume.
conformance("interrupts", "a crash resumed with no action and no note re-runs the Ticket", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  world.stubs.script("01", { statuses: ["keep", "done"] });
  const server = await t.start(world);
  const crashed = await firstInterrupt(server);
  expect(pending(crashed)).toEqual([["01", "crash"]]);

  const accepted = await resume(server, { ticketId: "01" });
  expect(accepted.status).toBe(202);
  await atReview(server);
  const done = await approveReview(server);

  expect(done.phase).toBe("done");
  expect(launches(world)).toEqual(["01", "01"]);
  expect(done.state.log).toContain("interrupt answered for 01 (crash): resumed");
  expect(readEvents(world.pool, "01").find((e) => e.kind === "answered")?.payload).toEqual({ kind: "crash" });
});

// Uncovered behaviour: engine/server.ts:1507.
conformance("interrupts", "approve and reject are refused on a checkpoint, which stays pending with nothing queued", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  world.stubs.script("01", { status: "checkpoint" });
  const server = await t.start(world);
  await firstInterrupt(server);

  for (const action of ["approve", "reject"] as const) {
    const refused = await resume(server, { ticketId: "01", action, note: "redo 01" });
    expect(refused.status).toBe(400);
    expectParsedEqual(
      refused.text,
      {
        error:
          "answer: approve/reject needs the review gate (REVIEW) or a merge-approval interrupt, " +
          "got checkpoint for 01",
      },
      `the ${action}'s 400`,
    );
  }
  expect(pending(await snapshot(server))).toEqual([["01", "checkpoint"]]);
  expect(eventKinds(world, "01")).not.toContain("answered");
  expect(existsSync(join(world.pool, "runs", "queued-answers.json"))).toBe(false);
});
