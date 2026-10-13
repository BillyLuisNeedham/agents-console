/**
 * Verify rounds without Jev (C21 of the Rust port's inventory,
 * docs/research/rust-port/test-inventory.md): an unverified Ticket beside a
 * fan-out, a round with a crashed or paused Candidate, the operator's
 * answers to that round's Interrupt (resume, close, Adopt), and the
 * attempt numbering and logs a round leaves behind.
 */

import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import type { CaseServer } from "../harness/case.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import {
  answer,
  resume,
  settle,
  settleOn,
  statuses,
  ticketOf,
  type ResumeBody,
} from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import {
  attemptBranch,
  attemptCwd,
  branchExists,
  DEFAULTS,
  inCheckout,
  kindsOf,
  poolText,
  ready,
  verifyConfig,
} from "./verify-common.ts";

/** A Candidate that pauses at a checkpoint with `brief`. */
function paused(brief: string, spawn?: unknown) {
  return {
    status: "checkpoint" as const,
    outcome: { summary: `paused: ${brief}`, commitSha: null },
    brief,
    ...(spawn !== undefined ? { spawn } : {}),
  };
}

/** One Spawn proposal titled `title`. */
function spawnOf(title: string) {
  return [{ title, body: "A body long enough to stand on its own." }];
}

/** Every Ticket file's text under issues/, joined. */
function issuesText(world: World): string {
  const dir = join(world.pool, "issues");
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

/** How many times the stubs launched an attempt of Ticket 01. */
function attemptLaunches(world: World): number {
  return world.stubs.calls().filter((call) => /^01\.attempt-\d+$/.test(call.key)).length;
}

/** The snapshot's Interrupts on one Ticket. */
function interruptsOn(snap: EnrichedSnapshot, ticketId: string) {
  return snap.state.interrupts.filter((i) => i.ticketId === ticketId);
}

/** POST /api/resume, which must be refused with 400 and this error. */
async function refusedWith(server: CaseServer, body: ResumeBody, error: string | RegExp): Promise<void> {
  const got = await resume(server, body);
  expect(got.status).toBe(400);
  const text = got.json<{ error: string }>().error;
  if (typeof error === "string") expect(text).toBe(error);
  else expect(text).toMatch(error);
}

/** Whether a Ticket's log holds an answered event. */
function answeredOn(world: World, id: string): boolean {
  return readEvents(world.pool, id).some((e) => e.kind === "answered");
}

// engine.test.ts:890
conformance("verify", "a Ticket without verify runs exactly one attempt beside a fan-out", async (t) => {
  const world = t.world({ tickets: [ready("01"), ready("02")], config: verifyConfig(3) });
  for (const n of [1, 2, 3]) {
    world.stubs.script(`01.attempt-${n}`, { work: { file: `cand-${n}.txt`, message: `cand-${n}` } });
  }
  world.stubs.script("02", { work: { file: "plain.txt", message: "plain" } });
  const server = await t.start(world);

  const snap = await settleOn(server, "REVIEW", "review");

  // 02 has no verify key: one attempt, merged, done.
  expect(ticketOf(snap, "02").status).toBe("done");
  expect(readStateLine(world.pool, "02-t.md").status).toBe("done");
  const keys = world.stubs.calls().map((call) => call.key);
  expect(keys.filter((key) => key === "02")).toHaveLength(1);
  expect(inCheckout(world, "plain.txt")).toBe(true);
  expect(readEvents(world.pool, "02").map((e) => e.kind)).toEqual(["scheduled", "spawned", "exited", "merged"]);

  // 01 fanned out, and the tied-at-8 earlier attempt merged.
  expect(ticketOf(snap, "01").status).toBe("done");
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  expect(keys.filter((key) => /^01\.attempt-\d+$/.test(key)).sort()).toEqual([
    "01.attempt-1",
    "01.attempt-2",
    "01.attempt-3",
  ]);
  expect(inCheckout(world, "cand-1.txt")).toBe(true);
  for (const n of [1, 2, 3]) {
    expect(branchExists(world, attemptBranch(world, "01", n))).toBe(false);
  }
});

// engine.test.ts:928
conformance("verify", "a crashed attempt leaves its siblings running and raises today's crash Interrupt", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(3) });
  const marker = (name: string) => join(world.root, name);
  // Attempt 1 crashes only once a sibling has started, and attempt 3 does
  // its work only after the crash, so a serial server or one that stops
  // the round at the crash fails below.
  world.stubs.script("01.attempt-1", {
    touch: marker("crashed-1"),
    waitFor: marker("started-2"),
    status: "keep",
    exitCode: 3,
  });
  world.stubs.script("01.attempt-2", {
    touch: marker("started-2"),
    work: { file: "cand-2.txt", message: "cand-2" },
  });
  world.stubs.script("01.attempt-3", {
    waitFor: marker("crashed-1"),
    work: { file: "cand-3.txt", message: "cand-3" },
  });
  const server = await t.start(world);

  const snap = await settle(
    server,
    (s) =>
      interruptsOn(s, "01").some((i) => i.kind === "crash") &&
      [1, 2, 3].every((n) => statuses(s)[`01-grader-${n}`] === "done"),
    { what: "a crash interrupt on 01 with every grader done" },
  );

  const crashes = snap.state.interrupts.filter((i) => i.kind === "crash");
  expect(crashes).toHaveLength(1);
  expect(crashes[0]!.ticketId).toBe("01");
  expect(crashes[0]!.body).toBe(
    "crash: harness exited 3\n" +
      join(world.pool, "runs", "01.attempt-1.log") +
      "\n\n" +
      "outcome file: " +
      join(world.pool, "runs", "01.attempt-1.outcome.json") +
      " (missing)\n",
  );

  const events = readEvents(world.pool, "01");
  const crash = events.find((e) => e.kind === "crash");
  expect(crash?.attempt).toBe(1);
  expect(crash?.payload).toEqual({ code: 3, reason: "harness exited 3", logTail: [], outcomeExists: false });

  for (const n of [2, 3]) {
    const exit = events.find((e) => e.kind === "exited" && e.attempt === n);
    expect(exit?.payload).toEqual({ code: 0, status: "done", logTail: [], outcomeExists: true });
    expect(branchExists(world, attemptBranch(world, "01", n))).toBe(true);
    expect(inCheckout(world, `cand-${n}.txt`)).toBe(false);
    expect(JSON.parse(poolText(world, `runs/01.attempt-${n}.outcome.json`)).status).toBe("done");
  }
  expect(statuses(snap)).toEqual({
    "01": "in-progress",
    "01-grader-1": "done",
    "01-grader-2": "done",
    "01-grader-3": "done",
  });
  expect(readStateLine(world.pool, "01-t.md").status).toBe("in-progress");
});

// engine.test.ts:1020
conformance("verify", "one checkpointed Candidate and one finished checkpoint the Ticket, and resume fans out again", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  world.stubs.script("01.attempt-1", {
    status: "checkpoint",
    outcome: { summary: "paused-1", commitSha: null },
    brief: "Which port should the server take?",
  });
  world.stubs.script("01.attempt-2", { work: { file: "cand-2.txt", message: "cand-2" } });
  const server = await t.start(world);

  const snap = await settle(
    server,
    (s) => interruptsOn(s, "01").some((i) => i.kind === "checkpoint") && statuses(s)["01-grader-2"] === "done",
    { what: "a checkpoint interrupt on 01 with grader 2 done" },
  );

  expect(snap.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "checkpoint"]]);
  expect(statuses(snap)).toEqual({ "01": "checkpoint", "01-grader-1": "done", "01-grader-2": "done" });
  expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
  const body = snap.state.interrupts[0]!.body;
  expect(body).toContain("The verify round of 2 attempts ended with 1 checkpointed");
  expect(body).toContain("### Attempt 1 checkpointed\n\nWhich port should the server take?");
  const branch2 = attemptBranch(world, "01", 2);
  expect(body).toContain(`### Attempt 2 finished\n\nGraded 8/10, verdict pass. Its work waits unmerged on ${branch2}.`);

  const events = readEvents(world.pool, "01");
  expect(events.find((e) => e.kind === "exited" && e.attempt === 1)?.payload).toEqual({
    code: 0,
    status: "checkpoint",
    logTail: [],
    outcomeExists: true,
  });
  expect(events.filter((e) => e.kind === "checkpoint").map((e) => e.attempt)).toEqual([1]);
  expect(events.some((e) => e.kind === "selected" || e.kind === "merged")).toBe(false);
  expect(branchExists(world, branch2)).toBe(true);
  expect(inCheckout(world, "cand-2.txt")).toBe(false);

  // Resume runs a fresh fan-out, numbering on from the paused round.
  await answer(server, { ticketId: "01", action: "resume" });
  const resumed = await settle(
    server,
    (s) => !["checkpoint", "ready", "in-progress"].includes(statuses(s)["01"] ?? ""),
    { what: "01 to leave its checkpoint and finish the fresh round" },
  );
  expect(attemptLaunches(world)).toBe(4);
  expect(
    world.stubs.calls().filter((call) => call.key === "01.attempt-3" || call.key === "01.attempt-4"),
  ).toHaveLength(2);
  expect(
    readEvents(world.pool, "01")
      .filter((e) => e.kind === "scheduled")
      .map((e) => e.attempt),
  ).toEqual([1, 2, 3, 4]);
  expect(ticketOf(resumed, "01").status).not.toBe("in-progress");
});

// engine.test.ts:1096
conformance("verify", "a round whose every Candidate checkpoints lists the briefs in attempt order, and Close closes it", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  world.stubs.script("01.attempt-1", {
    status: "checkpoint",
    outcome: { summary: "p1", commitSha: null },
    brief: "brief one",
  });
  world.stubs.script("01.attempt-2", {
    status: "checkpoint",
    outcome: { summary: "p2", commitSha: null },
    brief: "brief two",
  });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "checkpoint");

  expect(snap.state.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
  expect(ticketOf(snap, "01").status).toBe("checkpoint");
  const body = snap.state.interrupts[0]!.body;
  expect(body).toContain("ended with 2 checkpointed");
  expect(body.indexOf("### Attempt 1 checkpointed\n\nbrief one")).toBeGreaterThan(-1);
  expect(body.indexOf("### Attempt 2 checkpointed\n\nbrief two")).toBeGreaterThan(body.indexOf("brief one"));
  // The lowest-numbered paused Candidate owns the checkpoint.
  expect(
    readEvents(world.pool, "01")
      .filter((e) => e.kind === "checkpoint")
      .map((e) => e.attempt),
  ).toEqual([1]);

  await answer(server, { ticketId: "01", action: "close" });
  const closed = await settle(server, (s) => statuses(s)["01"] === "closed", { what: "01 to be closed" });
  expect(ticketOf(closed, "01").status).toBe("closed");
  expect(readStateLine(world.pool, "01-t.md").status).toBe("closed");
});

// engine.test.ts:1138
conformance("verify", "a paused Candidate's checkpoint owns a round that also crashed", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  world.stubs.script("01.attempt-1", {
    status: "checkpoint",
    outcome: { summary: "p1", commitSha: null },
    brief: "brief one",
  });
  world.stubs.script("01.attempt-2", { status: "keep", exitCode: 3 });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "checkpoint");

  // One Interrupt, the checkpoint; the crash stays on the log and in the Brief.
  expect(snap.state.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
  expect(ticketOf(snap, "01").status).toBe("checkpoint");
  expect(snap.state.interrupts[0]!.body).toContain(
    "### Attempt 2 crashed\n\nharness exited 3. Its log is " + join(world.pool, "runs", "01.attempt-2.log") + ".",
  );
  expect(readEvents(world.pool, "01").some((e) => e.kind === "crash" && e.attempt === 2)).toBe(true);
});

// engine.test.ts:1184
conformance("verify", "Adopt merges the adopted Candidate as a human selection, discards the rest and takes only its spawns", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(3) });
  world.stubs.script("01.attempt-1", paused("Which port?", spawnOf("From the paused candidate")));
  world.stubs.script("01.attempt-2", {
    work: { file: "cand-2.txt", message: "cand-2" },
    spawn: spawnOf("From candidate two"),
  });
  world.stubs.script("01.attempt-3", {
    work: { file: "cand-3.txt", message: "cand-3" },
    outcome: { summary: "the adopted work", commitSha: null },
    spawn: spawnOf("From the adopted candidate"),
  });
  world.stubs.script("01-grader-2", { grade: { score: 9, verdict: "pass", reasons: "tidy" } });
  world.stubs.script("01-grader-3", { grade: { score: 4, verdict: "flag", reasons: "rough" } });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "checkpoint");

  // Every finished, graded Candidate, the flagged one included, in attempt
  // order; the paused one is not among them.
  expect(snap.state.interrupts.map((i) => [i.kind, i.candidates])).toEqual([["checkpoint", [2, 3]]]);
  expect(snap.state.interrupts[0]!.body).toContain("The operator may instead adopt a finished candidate (2, 3)");
  const worktrees = [1, 2].map((n) => attemptCwd(world, "01", n));
  const branches = [1, 2].map((n) => attemptBranch(world, "01", n));
  expect(issuesText(world)).not.toContain("From the");

  // The note holds a number and is never read for one: attempt 3 merges.
  await answer(server, { ticketId: "01", action: "adopt", attempt: 3, note: "2 overfits the fixture" });
  const adopted = await settle(
    server,
    (s) => statuses(s)["01"] === "done" && interruptsOn(s, "01").length === 0,
    { what: "01 to be done with no interrupt on it" },
  );

  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  const events = readEvents(world.pool, "01");
  expect(events.find((e) => e.kind === "answered")?.payload).toEqual({
    kind: "checkpoint",
    action: "adopt",
    attempt: 3,
    note: "2 overfits the fixture",
  });
  expect(events.filter((e) => e.kind === "selected").map((e) => [e.attempt, e.payload])).toEqual([
    [3, { score: 4, margin: null, rule: "human" }],
  ]);
  expect(events.filter((e) => e.kind === "merged").map((e) => e.attempt)).toEqual([3]);
  expect(inCheckout(world, "cand-3.txt")).toBe(true);
  expect(inCheckout(world, "cand-2.txt")).toBe(false);
  for (const [i, branch] of branches.entries()) {
    expect(branchExists(world, branch)).toBe(false);
    expect(existsSync(worktrees[i]!)).toBe(false);
  }
  expect(adopted.state.outcomes["01"]?.summary).toBe("the adopted work");
  expect(adopted.state.log).toContain(
    "ticket 01: the operator adopted attempt 3 from the paused verify round's checkpoint",
  );
  expect(adopted.state.log).toContain(
    "interrupt answered for 01 (checkpoint): attempt 3 adopted from the paused verify round, " +
      "with the note: 2 overfits the fixture",
  );

  // Only the adopted Candidate's proposal lands, at the super-step boundary.
  const issues = await until(() => issuesText(world), (text) => text.includes("From the adopted candidate"), {
    what: "the adopted candidate's spawn to land",
  });
  expect(issues).not.toContain("From the paused candidate");
  expect(issues).not.toContain("From candidate two");
});

// engine.test.ts:1253
conformance("verify", "Adopt naming a paused or crashed attempt, or malformed, is refused and queues nothing", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(3) });
  world.stubs.script("01.attempt-1", paused("Which port?"));
  world.stubs.script("01.attempt-2", { work: { file: "cand-2.txt", message: "cand-2" } });
  world.stubs.script("01.attempt-3", { status: "keep", exitCode: 3 });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "checkpoint");
  expect(snap.state.interrupts.map((i) => [i.kind, i.candidates])).toEqual([["checkpoint", [2]]]);

  await refusedWith(
    server,
    { ticketId: "01", action: "adopt", attempt: 1 },
    "answer: adopt must name one of the finished candidates (2); got attempt 1 for 01",
  );
  await refusedWith(server, { ticketId: "01", action: "adopt", attempt: 3 }, /got attempt 3 for 01/);
  await refusedWith(
    server,
    { ticketId: "01", action: "adopt" },
    "answer: adopt needs the attempt number of the candidate to take for 01",
  );
  await refusedWith(
    server,
    { ticketId: "01", action: "resume", attempt: 2 },
    "answer: an attempt only goes with adopt, not resume, for 01",
  );
  await refusedWith(
    server,
    { ticketId: "01", action: "close", note: "why", attempt: 2 },
    "answer: an attempt only goes with adopt, not close, for 01",
  );
  expect(answeredOn(world, "01")).toBe(false);
  const after = await settle(server);
  expect(ticketOf(after, "01").status).toBe("checkpoint");
  expect(interruptsOn(after, "01").map((i) => i.kind)).toEqual(["checkpoint"]);

  // Nothing was queued by the refusals, so the valid Adopt goes through.
  await answer(server, { ticketId: "01", action: "adopt", attempt: 2 });
  await settle(server, (s) => statuses(s)["01"] === "done", { what: "01 to be done" });
  expect(inCheckout(world, "cand-2.txt")).toBe(true);
});

// engine.test.ts:1290
conformance("verify", "Adopt is refused on a checkpoint naming no Candidate and on any other Interrupt kind", async (t) => {
  const world = t.world({
    tickets: [ready("01"), ready("02"), ready("03")],
    config: { ...DEFAULTS, assign: { "01": { verify: 2 } } },
  });
  // Every Candidate paused: nothing finished to adopt.
  world.stubs.script("01.attempt-1", paused("one"));
  world.stubs.script("01.attempt-2", paused("two"));
  // A lone checkpoint, as every pool before Adopt has.
  world.stubs.script("02", { status: "checkpoint" });
  world.stubs.script("03", { status: "keep", exitCode: 3 });
  const server = await t.start(world);

  const snap = await settle(server, (s) => s.state.interrupts.length === 3, { what: "three interrupts" });
  expect(
    snap.state.interrupts
      .map((i) => [i.ticketId, i.kind, i.candidates])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual([
    ["01", "checkpoint", undefined],
    ["02", "checkpoint", undefined],
    ["03", "crash", undefined],
  ]);

  await refusedWith(
    server,
    { ticketId: "01", action: "adopt", attempt: 1 },
    "answer: 01's checkpoint names no finished candidate to adopt; resume or close it",
  );
  await refusedWith(
    server,
    { ticketId: "02", action: "adopt", attempt: 1 },
    /^answer: 02's checkpoint names no finished candidate to adopt/,
  );
  await refusedWith(
    server,
    { ticketId: "03", action: "adopt", attempt: 1 },
    "answer: adopt takes a paused verify round's checkpoint interrupt, got crash for 03",
  );
  for (const id of ["01", "02", "03"]) expect(answeredOn(world, id)).toBe(false);
});

// engine.test.ts:1397
conformance("verify", "a pre-verify solo attempt's well-known log is rotated to attempt 0 before the fan-out", async (t) => {
  const world = t.world({
    tickets: [ready("01")],
    config: verifyConfig(2),
    poolFiles: { "runs/01.log": "solo era\n" },
  });
  const server = await t.start(world);

  await settleOn(server, "REVIEW", "review");

  expect(poolText(world, "runs/01.attempt-0.log")).toBe("solo era\n");
  expect(existsSync(join(world.pool, "runs", "01.log"))).toBe(false);
  for (const n of [1, 2]) {
    expect(existsSync(join(world.pool, "runs", `01.attempt-${n}.log`))).toBe(true);
  }
});

// engine.test.ts:1421
conformance("verify", "resuming a crashed round fans out again with continued attempt numbers", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2), git: false });
  world.stubs.script("01.attempt-1", { status: "keep", exitCode: 7 });
  const server = await t.start(world);

  await settle(
    server,
    (s) => interruptsOn(s, "01").some((i) => i.kind === "crash") && statuses(s)["01-grader-2"] === "done",
    { what: "a crash interrupt on 01 with grader 2 done" },
  );

  await answer(server, { ticketId: "01", action: "resume" });
  const resumed = await settleOn(server, "REVIEW", "review");

  // Without git there is no branch to merge, so no merged event.
  expect(resumed.state.interrupts.map((i) => i.kind)).toEqual(["review"]);
  expect(statuses(resumed)).toEqual({
    "01": "done",
    "01-grader-1": "done",
    "01-grader-2": "done",
    "01-head-to-head": "done",
  });
  const keys = world.stubs.calls().map((call) => call.key);
  expect(keys.filter((key) => /^01\.attempt-\d+$/.test(key)).sort()).toEqual([
    "01.attempt-1",
    "01.attempt-2",
    "01.attempt-3",
    "01.attempt-4",
  ]);

  const events = readEvents(world.pool, "01");
  expect(kindsOf(events, 1)).toEqual(["scheduled", "spawned", "exited", "crash", "graded"]);
  // The resume's answered event carries the latest attempt.
  expect(kindsOf(events, 2)).toEqual(["scheduled", "spawned", "exited", "graded", "answered"]);
  expect(kindsOf(events, 3)).toEqual(["scheduled", "spawned", "exited", "graded", "selected"]);
  expect(kindsOf(events, 4)).toEqual(["scheduled", "spawned", "exited", "graded"]);
  // Each grader card ran once per round, its attempt counter numbering on.
  for (const gid of ["01-grader-1", "01-grader-2"]) {
    expect(keys.filter((key) => key === gid)).toHaveLength(2);
    expect(readEvents(world.pool, gid).map((e) => e.attempt)).toEqual([1, 1, 1, 2, 2, 2]);
  }
  expect(existsSync(join(world.pool, "runs", "01.attempt-1.outcome.json"))).toBe(false);
  for (const n of [2, 3, 4]) {
    expect(JSON.parse(poolText(world, `runs/01.attempt-${n}.outcome.json`)).status).toBe("done");
  }
});
