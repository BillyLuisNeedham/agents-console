/**
 * Verify without Jev, the grading (C21 of the Rust port's inventory,
 * docs/research/rust-port/test-inventory.md): one grader Ticket per
 * Attempt, bound to that Attempt's artifacts, re-spawned within a bound
 * when it gives no usable grade, and the lone Attempt resolved from its
 * grade. Every launch is a stub on PATH; no case sets TYPESAFE_API_KEY.
 */

import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TicketEvent } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { readEvents, readStateLine, readTicketFile } from "../harness/pool-files.ts";
import { answer, approveReview, settle, settleOn, statuses, ticketOf } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import {
  attemptBranch,
  branchExists,
  inCheckout,
  kindsOf,
  poolText,
  promptOf,
  ready,
  verifyConfig,
} from "./verify-common.ts";

type Grade = { score: unknown; verdict: unknown; reasons: unknown };

/** A grader's outcome JSON carrying `grade`, as the stub writes one. */
function gradeOutcome(key: string, grade: Grade, status = "done"): string {
  return JSON.stringify({ status, summary: `summary-${key}`, commitSha: null, grade });
}

/**
 * Script each launch of `key` in turn: an exit code and the outcome text
 * verbatim, or no outcome at all, for a grade that changes from one launch
 * to the next.
 */
function scriptSteps(world: World, key: string, steps: { exit?: number; outcome?: string }[]): void {
  world.stubs.launches(
    key,
    steps.map((step) =>
      step.outcome === undefined
        ? { status: "keep" as const, exitCode: step.exit ?? 0 }
        : { outcomeRaw: step.outcome, exitCode: step.exit ?? 0 },
    ),
  );
}

/** Every launch of `key`, in order. */
function launchesOf(world: World, key: string) {
  return world.stubs.calls().filter((call) => call.key === key);
}

/** The prompt of the only (or first) launch of `key`. */
function promptFor(world: World, key: string): string {
  const call = launchesOf(world, key)[0];
  if (!call) throw new Error(`${key} never launched`);
  return promptOf(call.argv);
}

/** The value after `flag` in an argv, or undefined. */
function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}

/** A Ticket's graded events, by attempt. */
function gradedEvents(world: World, id: string): TicketEvent[] {
  return readEvents(world.pool, id)
    .filter((e) => e.kind === "graded")
    .sort((a, b) => a.attempt - b.attempt);
}

/**
 * The grader's whole prompt, byte for byte: the driver line naming the
 * grader's Ticket file, then the engine's grader template with the bound
 * attempt's paths filled in and the pool's verify skill, trimmed, or the
 * line saying there is none.
 */
function graderPrompt(world: World, buildId: string, n: number, attempt: number, skill: string | null): string {
  const pool = world.pool;
  const gid = `${buildId}-grader-${n}`;
  return [
    `/verify ${pool}/issues/${gid}.md`,
    "",
    `You are a grader. One attempt is bound to you: attempt ${attempt} of ticket ${buildId}. Grade that attempt against the ticket, judge the artifacts, and put the grade in your outcome JSON. The engine owns every status write; you write none.`,
    "",
    "---",
    "",
    skill?.trim() ||
      "_(the pool has no verify skill: no verify.md beside AGENT.md, so grade on the criteria below and say so in your reasons)_",
    "",
    "---",
    "",
    "The bound attempt's artifacts, in the order the skill reads them:",
    "",
    `1. The ticket file: ${pool}/issues/${buildId}-t.md`,
    `2. The attempt's Outcome JSON: ${pool}/runs/${buildId}.attempt-${attempt}.outcome.json`,
    `3. The diff at the attempt's commit: ${pool}/runs/${gid}.diff.patch`,
    `4. The attempt log, trimmed to its last ~20k tokens when huge: ${pool}/runs/${gid}.trim.log`,
    "",
    "Trust terminal output over the agent's self-assessment.",
    "",
    "---",
    "",
    `When you finish, record your outcome as JSON at ${pool}/runs/${gid}.outcome.json: {"status": "done", "summary": "what you graded, in a sentence or two", "commitSha": null, "grade": {"score": 0-10, "verdict": "pass" or "flag", "reasons": "one to three short sentences naming the evidence"}}. You write no status, raise no interrupts, and merge nothing: the grade in this file is your only output.`,
  ].join("\n");
}

/** Two attempts that each commit their own file. */
function twoCandidates(world: World): void {
  for (const n of [1, 2]) world.stubs.script(`01.attempt-${n}`, { work: { file: `cand-${n}.txt`, message: `cand-${n}` } });
}

// engine.test.ts:1498
conformance("verify", "writes one grader ticket per attempt with the build ticket as its blocker", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  twoCandidates(world);
  const server = await t.start(world);

  const snap = await settleOn(server, "REVIEW", "review");

  expect(readStateLine(world.pool, "01-grader-1.md").line).toContain("id=01-grader-1 blocked-by=01 status=done");
  expect(readStateLine(world.pool, "01-grader-2.md").line).toContain("id=01-grader-2 blocked-by=01 status=done");
  expect(readTicketFile(world.pool, "01-grader-1.md")).toContain("attempt 1 of ticket 01");
  // With no verify.md the prompt says so and grades on the engine's own
  // criteria; the whole text is pinned.
  expectSameBytes(promptFor(world, "01-grader-1"), graderPrompt(world, "01", 1, 1, null), "grader 1's prompt");
  expectSameBytes(promptFor(world, "01-grader-2"), graderPrompt(world, "01", 2, 2, null), "grader 2's prompt");

  expect(statuses(snap)).toEqual({
    "01": "done",
    "01-grader-1": "done",
    "01-grader-2": "done",
    "01-head-to-head": "done",
  });
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  expect(inCheckout(world, "cand-1.txt")).toBe(true);
  expect(inCheckout(world, "cand-2.txt")).toBe(false);
  expect(snap.state.log.filter((line) => line.startsWith("super-step"))).toEqual(["super-step 1: 01"]);
  expect(snap.state.log).toContain("ticket 01: grading 2 attempts with grader tickets 01-grader-1, 01-grader-2");
  expect(readEvents(world.pool, "01-grader-1").map((e) => e.kind)).toEqual(["scheduled", "spawned", "exited"]);
});

// engine.test.ts:1556
conformance("verify", "binds each grader to its own attempt's artifacts and parameterizes the pool's verify skill", async (t) => {
  const skill = "# verify: grade one attempt\n\nPOOL-SKILL-MARKER: grade on the three criteria only.\n";
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2), poolFiles: { "verify.md": skill } });
  twoCandidates(world);
  const server = await t.start(world);

  await settleOn(server, "REVIEW", "review");

  for (const n of [1, 2]) {
    const [grader] = launchesOf(world, `01-grader-${n}`);
    // The skill travels verbatim inside the engine's glue, which names
    // this grader's own attempt's four artifacts and nothing of the other.
    expectSameBytes(promptOf(grader!.argv), graderPrompt(world, "01", n, n, skill), `grader ${n}'s prompt`);
    expect(promptOf(grader!.argv)).not.toContain(join(world.pool, "runs", `01.attempt-${3 - n}.outcome.json`));
    expect(grader!.cwd).toBe(world.repo);
    expect(grader!.outcome).toBe(join(world.pool, "runs", `01-grader-${n}.outcome.json`));
    expect(grader!.issue).toBe(join(world.pool, "issues", `01-grader-${n}.md`));
    // The diff file holds exactly the bound attempt's work.
    const diff = poolText(world, `runs/01-grader-${n}.diff.patch`);
    expect(diff).toContain(`cand-${n}`);
    expect(diff).not.toContain(`cand-${3 - n}`);
  }
});

// engine.test.ts:1626
conformance("verify", "lands each grade in the graded attempt's record", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(3) });
  for (const n of [1, 2, 3]) world.stubs.script(`01.attempt-${n}`, { work: { file: `cand-${n}.txt`, message: `cand-${n}` } });
  world.stubs.script("01-grader-1", { grade: { score: 9, verdict: "pass", reasons: "solid work" } });
  world.stubs.script("01-grader-2", { grade: { score: 3, verdict: "flag", reasons: "tests missing" } });
  const server = await t.start(world);

  const snap = await settleOn(server, "REVIEW", "review");

  expect(gradedEvents(world, "01").map((e) => [e.attempt, e.payload])).toEqual([
    [1, { score: 9, verdict: "pass", reasons: "solid work" }],
    [2, { score: 3, verdict: "flag", reasons: "tests missing" }],
    [3, { score: 8, verdict: "pass", reasons: "default grade" }],
  ]);
  expect(snap.state.log).toContain("ticket 01: attempt 1 graded: score 9, verdict pass (grader 01-grader-1)");
  expect(snap.state.log).toContain("ticket 01: attempt 2 graded: score 3, verdict flag (grader 01-grader-2)");
  expect(readStateLine(world.pool, "01-grader-2.md").status).toBe("done");
  // Margin 1 over attempt 3 is below the outright bound, so the
  // deterministic order decided.
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  expect(readEvents(world.pool, "01").find((e) => e.kind === "selected")?.payload).toEqual({
    score: 9,
    margin: 1,
    rule: "fallback",
  });
});

// engine.test.ts:1673
conformance("verify", "resolves a grader's harness and model through assign, overridable per grader", async (t) => {
  const world = t.world({
    tickets: [ready("01")],
    config: {
      defaults: { harness: "claude", model: "m" },
      assign: {
        "01": { verify: 2, harness: "claude", model: "build-model" },
        // Harness only: the model still comes from the build Ticket.
        "01-grader-2": { harness: "opencode" },
      },
    },
  });
  twoCandidates(world);
  world.stubs.script("01-grader-2", { grade: { score: 6, verdict: "pass", reasons: "ok" } });
  const server = await t.start(world);

  await settleOn(server, "REVIEW", "review");

  const [grader1] = launchesOf(world, "01-grader-1");
  const [grader2] = launchesOf(world, "01-grader-2");
  expect(grader1!.harness).toBe("claude");
  expect(flagValue(grader1!.argv, "--model")).toBe("build-model");
  expect(grader2!.harness).toBe("opencode");
  expect(flagValue(grader2!.argv, "--model")).toBe("build-model");
  expect(readStateLine(world.pool, "01-grader-2.md").status).toBe("done");
  expect(gradedEvents(world, "01").find((e) => e.attempt === 2)?.payload).toEqual({
    score: 6,
    verdict: "pass",
    reasons: "ok",
  });
});

// engine.test.ts:1731
conformance("verify", "serves grader tickets the Assignment inherited from their build ticket on the snapshot", async (t) => {
  const world = t.world({
    tickets: [ready("01")],
    config: {
      defaults: { harness: "claude", model: "pool-default-model" },
      assign: {
        "01": { verify: 2, harness: "claude", model: "build-model", drivers: "implement code-review" },
        "01-grader-2": { harness: "opencode" },
      },
    },
  });
  twoCandidates(world);
  const server = await t.start(world);

  const snap = await settleOn(server, "REVIEW", "review");

  // The graders inherit their build Ticket's model and drivers, not the
  // pool defaults, whose model appears on no record.
  expect(ticketOf(snap, "01").assignment).toEqual({ harness: "claude", model: "build-model", drivers: "implement code-review" });
  expect(ticketOf(snap, "01-grader-1").assignment).toEqual({
    harness: "claude",
    model: "build-model",
    drivers: "implement code-review",
  });
  expect(ticketOf(snap, "01-grader-2").assignment).toEqual({
    harness: "opencode",
    model: "build-model",
    drivers: "implement code-review",
  });
});

// engine.test.ts:1799
conformance("verify", "re-spawns a grader that produced no usable grade and lands the eventual grade", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  twoCandidates(world);
  // Grader 1 dies on its first run; grader 2 first writes an outcome with
  // no grade object. Both grade on the re-spawn.
  scriptSteps(world, "01-grader-1", [
    { exit: 9 },
    { outcome: gradeOutcome("01-grader-1", { score: 7, verdict: "pass", reasons: "second try" }) },
  ]);
  scriptSteps(world, "01-grader-2", [
    { outcome: '{"status":"done","summary":"no grade","commitSha":null}' },
    { outcome: gradeOutcome("01-grader-2", { score: 4, verdict: "flag", reasons: "weak work" }) },
  ]);
  const server = await t.start(world);

  const snap = await settleOn(server, "REVIEW", "review");

  // 7 against 4 is an outright win for attempt 1.
  expect(snap.state.interrupts.map((i) => i.kind)).toEqual(["review"]);
  expect(statuses(snap)).toEqual({ "01": "done", "01-grader-1": "done", "01-grader-2": "done" });
  expect(inCheckout(world, "cand-1.txt")).toBe(true);
  expect(inCheckout(world, "cand-2.txt")).toBe(false);
  expect(gradedEvents(world, "01").map((e) => [e.attempt, e.payload])).toEqual([
    [1, { score: 7, verdict: "pass", reasons: "second try" }],
    [2, { score: 4, verdict: "flag", reasons: "weak work" }],
  ]);
  expect(launchesOf(world, "01-grader-1")).toHaveLength(2);
  expect(launchesOf(world, "01-grader-2")).toHaveLength(2);

  const g1 = readEvents(world.pool, "01-grader-1");
  expect(kindsOf(g1, 1)).toEqual(["scheduled", "spawned", "exited", "crash"]);
  expect(kindsOf(g1, 2)).toEqual(["grader-respawn", "scheduled", "spawned", "exited"]);
  expect(g1.find((e) => e.kind === "grader-respawn")?.payload).toEqual({
    build: "01",
    gradedAttempt: 1,
    reason: "harness exited 9",
    respawn: 1,
  });
  const g2 = readEvents(world.pool, "01-grader-2");
  expect(kindsOf(g2, 1)).toEqual(["scheduled", "spawned", "exited", "crash"]);
  expect(g2.find((e) => e.kind === "crash")?.payload).toEqual({
    code: 0,
    reason: "outcome carries no grade object",
    logTail: [],
    outcomeExists: true,
  });
  expect(snap.state.log).toContain("ticket 01: re-spawning grader 01-grader-1 for attempt 1 (respawn 1 of 2)");
  expect(snap.state.log).toContain("ticket 01: re-spawning grader 01-grader-2 for attempt 2 (respawn 1 of 2)");
});

// engine.test.ts:1898
conformance("verify", "treats a grader's checkpoint outcome as an unusable grade and logs the crash", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1) });
  world.stubs.script("01.attempt-1", { work: { file: "cand.txt", message: "cand" } });
  // Even with a grade in it, a checkpoint is not a usable grade.
  world.stubs.script("01-grader-1", { status: "checkpoint", grade: { score: 10, verdict: "pass", reasons: "perfect" } });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "crash");

  expect(gradedEvents(world, "01")).toEqual([]);
  expect(readEvents(world.pool, "01-grader-1").find((e) => e.kind === "crash")?.payload).toEqual({
    code: 0,
    reason: "grader outcome is a checkpoint, not a grade",
    logTail: [],
    outcomeExists: true,
  });
  expect(snap.state.log).toContain(
    "ticket 01: grader 01-grader-1 produced no usable grade for attempt 1: grader outcome is a checkpoint, not a grade",
  );
});

// engine.test.ts:1934
conformance("verify", "bounds grader re-spawns and raises a crash interrupt on the build ticket", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1) });
  world.stubs.script("01.attempt-1", { work: { file: "cand.txt", message: "cand" } });
  world.stubs.script("01-grader-1", { exitCode: 9 });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "crash");

  // The first run and two re-spawns, then the human hears of it.
  expect(launchesOf(world, "01-grader-1")).toHaveLength(3);
  const crashes = snap.state.interrupts.filter((i) => i.kind === "crash");
  expect(crashes).toHaveLength(1);
  expect(crashes[0]!.ticketId).toBe("01");
  expect(crashes[0]!.body).toContain("01-grader-1");
  expect(crashes[0]!.body).toContain("harness exited 9");
  expect(crashes[0]!.body).toContain(join(world.pool, "runs", "01-grader-1.log"));

  expect(gradedEvents(world, "01")).toEqual([]);
  expect(readStateLine(world.pool, "01-t.md").status).toBe("in-progress");
  expect(readStateLine(world.pool, "01-grader-1.md").status).toBe("in-progress");
  const run: TicketEvent["kind"][] = ["scheduled", "spawned", "exited", "crash"];
  expect(readEvents(world.pool, "01-grader-1").map((e) => e.kind)).toEqual([
    ...run,
    "grader-respawn",
    ...run,
    "grader-respawn",
    ...run,
  ]);
});

// engine.test.ts:1989
conformance("verify", "grades the re-fan-out after a grader-exhaustion crash resume", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1), git: false });
  world.stubs.script("01-grader-1", {
    exitCodes: [9, 9, 9, 0],
    grade: { score: 6, verdict: "pass", reasons: "recovered" },
  });
  const server = await t.start(world);

  const crashed = await settleOn(server, "01", "crash");
  expect(crashed.state.interrupts.map((i) => i.kind)).toEqual(["crash"]);

  await answer(server, { ticketId: "01", action: "resume" });
  const snap = await settleOn(server, "REVIEW", "review");

  expect(snap.state.interrupts.map((i) => i.kind)).toEqual(["review"]);
  expect(statuses(snap)).toEqual({ "01": "done", "01-grader-1": "done" });
  expect(gradedEvents(world, "01").map((e) => [e.attempt, e.payload])).toEqual([
    [2, { score: 6, verdict: "pass", reasons: "recovered" }],
  ]);
  // Three crashes in round one, one grade in round two; the human's
  // resume, not a crash, started the fourth run.
  expect(launchesOf(world, "01-grader-1")).toHaveLength(4);
  const run: TicketEvent["kind"][] = ["scheduled", "spawned", "exited"];
  expect(readEvents(world.pool, "01-grader-1").map((e) => e.kind)).toEqual([
    ...run,
    "crash",
    "grader-respawn",
    ...run,
    "crash",
    "grader-respawn",
    ...run,
    "crash",
    ...run,
  ]);
});

// engine.test.ts:2057
conformance("verify", "does not honor a grader's own status write", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1), git: false });
  // The grader rewrites its own marker to done and writes no outcome.
  world.stubs.script("01-grader-1", { status: "marker-done" });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "crash");

  expect(readStateLine(world.pool, "01-grader-1.md").status).toBe("in-progress");
  expect(readEvents(world.pool, "01-grader-1").find((e) => e.kind === "crash")?.payload).toEqual({
    code: 0,
    reason: "no outcome written",
    logTail: [],
    outcomeExists: false,
  });
  expect(gradedEvents(world, "01")).toEqual([]);
  expect(statuses(snap)).toEqual({ "01": "in-progress", "01-grader-1": "in-progress" });
});

// engine.test.ts:2097
conformance("verify", "trims a huge attempt log to its tail and says so", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  // About 150,000 characters: well past the 80,000 the trim keeps, and
  // under the 256 KiB a stub's stdout pipe holds whole.
  const lines: string[] = [];
  for (let i = 0; i < 4500; i++) lines.push(`noise line ${i} padding padding`);
  world.stubs.script("01.attempt-1", {
    stdout: `${lines.join("\n")}\nTAILMARKER-end\n`,
    work: { file: "cand-1.txt", message: "cand-1" },
  });
  world.stubs.script("01.attempt-2", { work: { file: "cand-2.txt", message: "cand-2" } });
  const server = await t.start(world);

  await settleOn(server, "REVIEW", "review");

  expect(poolText(world, "runs/01.attempt-1.log").length).toBeGreaterThan(80_000);
  const trim1 = poolText(world, "runs/01-grader-1.trim.log");
  expect(trim1.startsWith("[log trimmed to the last ~20k tokens;")).toBe(true);
  expect(trim1.length).toBeLessThan(80_200);
  expect(trim1.trimEnd().endsWith("TAILMARKER-end")).toBe(true);
  // A log within the budget passes through whole, with no notice.
  const log2 = poolText(world, "runs/01.attempt-2.log");
  expect(poolText(world, "runs/01-grader-2.trim.log")).toBe(log2);
  expect(log2.startsWith("[log trimmed")).toBe(false);
  expect(promptFor(world, "01-grader-1")).toContain(join(world.pool, "runs", "01-grader-1.trim.log"));
});

// engine.test.ts:2178
conformance("verify", "raises a checkpoint interrupt carrying the grader's complaint on a flag verdict", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1) });
  world.stubs.script("01.attempt-1", { work: { file: "cand.txt", message: "cand" } });
  world.stubs.script("01-grader-1", { grade: { score: 3, verdict: "flag", reasons: "the claimed tests do not exist" } });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "checkpoint");

  // The Brief is the grade, not the agent's summary.
  expect(snap.state.interrupts).toHaveLength(1);
  const body = snap.state.interrupts[0]!.body;
  expect(body).toContain("score 3/10");
  expect(body).toContain("verdict flag");
  expect(body).toContain("the claimed tests do not exist");
  expect(body).not.toContain("summary-01");

  expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
  const issue = readTicketFile(world.pool, "01-t.md");
  expect(issue).toContain("## Brief");
  expect(issue).toContain("the claimed tests do not exist");
  expect(inCheckout(world, "cand.txt")).toBe(false);
  expect(branchExists(world, attemptBranch(world, "01", 1))).toBe(true);
  expect(readEvents(world.pool, "01").map((e) => e.kind)).toEqual([
    "scheduled",
    "spawned",
    "exited",
    "graded",
    "checkpoint",
  ]);
  expect(readStateLine(world.pool, "01-grader-1.md").status).toBe("done");
});

// engine.test.ts:2261
conformance("verify", "resumes a flagged lone attempt to ready and runs it to done on the next round", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1) });
  twoCandidates(world);
  scriptSteps(world, "01-grader-1", [
    { outcome: gradeOutcome("01-grader-1", { score: 2, verdict: "flag", reasons: "wrong file" }) },
    { outcome: gradeOutcome("01-grader-1", { score: 9, verdict: "pass", reasons: "solid" }) },
  ]);
  const server = await t.start(world);

  await settleOn(server, "01", "checkpoint");
  await answer(server, { ticketId: "01", action: "resume", note: "write the right file" });
  const done = await approveReview(server);

  expect(statuses(done)).toEqual({ "01": "done", "01-grader-1": "done" });
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  expect(readTicketFile(world.pool, "01-t.md")).toContain("## Resume note");
  expect(inCheckout(world, "cand-2.txt")).toBe(true);
  expect(inCheckout(world, "cand-1.txt")).toBe(false);
  expect(readEvents(world.pool, "01").map((e) => [e.attempt, e.kind])).toEqual([
    [1, "scheduled"],
    [1, "spawned"],
    [1, "exited"],
    [1, "graded"],
    [1, "checkpoint"],
    [1, "answered"],
    [2, "scheduled"],
    [2, "spawned"],
    [2, "exited"],
    [2, "graded"],
    [2, "merged"],
  ]);
  expect(branchExists(world, attemptBranch(world, "01", 2))).toBe(false);
});

// engine.test.ts:2315
conformance("verify", "resolves nothing for a crashed lone attempt, even with a passing grade", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1), git: false });
  world.stubs.script("01.attempt-1", { status: "keep", exitCode: 4 });
  const server = await t.start(world);

  const snap = await settle(server, (s) => s.state.interrupts.length > 0 && s.state.tickets.every((ticket) =>
    ticket.liveAttempt === null
  ), { what: "the crash to stand with nothing running" });

  expect(snap.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "crash"]]);
  expect(statuses(snap)).toEqual({ "01": "in-progress", "01-grader-1": "done" });
  expect(readStateLine(world.pool, "01-t.md").status).toBe("in-progress");
});

// engine.test.ts:2337
conformance("verify", "lets an attempt's own checkpoint win over its grade", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1), git: false });
  world.stubs.script("01.attempt-1", { status: "checkpoint", brief: "waiting on the API name" });
  world.stubs.script("01-grader-1", { grade: { score: 0, verdict: "flag", reasons: "incomplete" } });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "checkpoint");

  // A pause made no done-claim for the grade to verify.
  expect(snap.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "waiting on the API name" }]);
  expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
  expect(gradedEvents(world, "01").map((e) => e.payload)).toEqual([{ score: 0, verdict: "flag", reasons: "incomplete" }]);
  expect(snap.state.outcomes["01"]?.summary).toBe("summary-01.attempt-1");
});

// engine.test.ts:2364
conformance("verify", "raises a checkpoint with the conflict in the Brief when the passing merge conflicts", async (t) => {
  const world = t.world({ tickets: [ready("01"), ready("02")], config: verifyConfig(1) });
  world.stubs.script("01.attempt-1", { work: { file: "cand.txt", line: "attempt", overwrite: true, message: "attempt" } });
  world.stubs.script("02", { work: { file: "cand.txt", line: "plain", overwrite: true, message: "plain" } });
  // The grader waits for 02's merge to reach the checkout, so 01's
  // passing attempt always merges second.
  world.stubs.script("01-grader-1", {
    waitFor: join(world.repo, "cand.txt"),
    grade: { score: 8, verdict: "pass", reasons: "default grade" },
  });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "checkpoint");

  // A lone attempt has no sibling to re-attempt, so the Brief carries the
  // conflict instead of a merge-conflict Interrupt.
  expect(snap.state.interrupts).toHaveLength(1);
  expect(snap.state.interrupts[0]!.kind).toBe("checkpoint");
  const branch = attemptBranch(world, "01", 1);
  expect(snap.state.interrupts[0]!.body).toContain("cand.txt");
  expect(snap.state.interrupts[0]!.body).toContain(branch);
  expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
  expect(readFileSync(join(world.repo, "cand.txt"), "utf8")).toBe("plain\n");
  expect(branchExists(world, branch)).toBe(true);
});

// Inventory gap: each malformed grade is a crash with its own reason.
conformance("verify", "refuses a grade out of range, an unknown verdict and non-string reasons, each as a crash", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1) });
  scriptSteps(world, "01-grader-1", [
    { outcome: gradeOutcome("01-grader-1", { score: 11, verdict: "pass", reasons: "too high" }) },
    { outcome: gradeOutcome("01-grader-1", { score: 5, verdict: "maybe", reasons: "unsure" }) },
    { outcome: gradeOutcome("01-grader-1", { score: 5, verdict: "pass", reasons: 42 }) },
  ]);
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "crash");

  expect(
    readEvents(world.pool, "01-grader-1").filter((e) => e.kind === "crash").map((e) => e.payload.reason),
  ).toEqual(["grade has no score in 0..10", "grade verdict is not pass or flag", "grade has no reasons string"]);
  expect(snap.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "crash"]]);
  expect(gradedEvents(world, "01")).toEqual([]);
});

// Inventory gap: verify.md is read fresh at every grading round.
conformance("verify", "hands the next round's grader the verify skill as rewritten mid-run", async (t) => {
  const world = t.world({
    tickets: [ready("01")],
    config: verifyConfig(1),
    poolFiles: { "verify.md": "FIRST-SKILL: grade strictly.\n" },
  });
  scriptSteps(world, "01-grader-1", [
    { outcome: gradeOutcome("01-grader-1", { score: 2, verdict: "flag", reasons: "wrong file" }) },
    { outcome: gradeOutcome("01-grader-1", { score: 9, verdict: "pass", reasons: "solid" }) },
  ]);
  const server = await t.start(world);

  await settleOn(server, "01", "checkpoint");
  writeFileSync(join(world.pool, "verify.md"), "SECOND-SKILL: grade kindly.\n");
  await answer(server, { ticketId: "01", action: "resume" });
  await settleOn(server, "REVIEW", "review");

  const [first, second] = launchesOf(world, "01-grader-1");
  expectSameBytes(promptOf(first!.argv), graderPrompt(world, "01", 1, 1, "FIRST-SKILL: grade strictly.\n"), "round one's prompt");
  expectSameBytes(promptOf(second!.argv), graderPrompt(world, "01", 1, 2, "SECOND-SKILL: grade kindly.\n"), "round two's prompt");
});

// Inventory gap: a passing attempt whose merge an untracked file blocks.
conformance("verify", "raises a checkpoint naming the file when an untracked file blocks the passing merge", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1) });
  world.stubs.script("01.attempt-1", { work: { file: "cand.txt", line: "attempt", overwrite: true, message: "cand" } });
  writeFileSync(join(world.repo, "cand.txt"), "untracked\n");
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "checkpoint");

  expect(snap.state.interrupts).toHaveLength(1);
  const body = snap.state.interrupts[0]!.body;
  expect(body).toContain(`merging ${attemptBranch(world, "01", 1)} onto the working branch was blocked`);
  expect(body).toContain("files in the way: cand.txt");
  expect(readFileSync(join(world.repo, "cand.txt"), "utf8")).toBe("untracked\n");
  expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
  expect(readTicketFile(world.pool, "01-t.md")).toContain("files in the way: cand.txt");
});

