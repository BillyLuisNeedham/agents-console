/**
 * Verify without Jev, the Selection (C21 of the Rust port's inventory,
 * docs/research/rust-port/test-inventory.md): once every Candidate of a
 * round is graded, a spread of two points or more takes the top grade
 * outright, a tighter spread runs one head-to-head judge, and an unusable
 * or tied pick falls back to the higher score, then the earlier attempt.
 * Under `selection: "human"` the operator picks through a selection
 * Interrupt instead. The head-to-head's prompt is pinned byte for byte.
 */

import { expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig, TicketEvent } from "../../engine/wire.ts";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { readEvents, readStateLine } from "../harness/pool-files.ts";
import { answer, approveReview, resume, settle, settleOn, statuses, ticketOf } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import {
  attemptBranch,
  attemptBranches,
  attemptCwd,
  branchExists,
  DEFAULTS,
  inCheckout,
  promptOf,
  ready,
  verifyConfig,
} from "./verify-common.ts";

/** A passing grade a grader stub writes, its reasons `scored <score>` unless given. */
function grade(score: number, reasons = `scored ${score}`) {
  return { grade: { score, verdict: "pass" as const, reasons } };
}

/**
 * Script Ticket 01's round: attempt N commits cand-N.txt, grader N gives
 * the Nth score, and the head-to-head does what `h2h` says when given.
 */
function scriptRound(world: World, scores: number[], h2h?: Parameters<World["stubs"]["script"]>[1]): void {
  scores.forEach((score, i) => {
    const n = i + 1;
    world.stubs.script(`01.attempt-${n}`, { work: { file: `cand-${n}.txt`, message: `cand-${n}` } });
    world.stubs.script(`01-grader-${n}`, grade(score));
  });
  if (h2h) world.stubs.script("01-head-to-head", h2h);
}

/** console.json for Ticket 01 at verify N with the operator picking. */
function humanConfig(n: number): PoolConfig {
  return verifyConfig(n, { selection: "human" });
}

/** The one event of a kind on a list, or undefined. */
function eventOf(events: TicketEvent[], kind: string): TicketEvent | undefined {
  return events.find((e) => e.kind === kind);
}

/** The attempts of a kind's events, in order. */
function attemptsOf(events: TicketEvent[], kind: string): number[] {
  return events.filter((e) => e.kind === kind).map((e) => e.attempt);
}

/** The head-to-head launches so far. */
function headToHeadCalls(world: World) {
  return world.stubs.calls().filter((call) => call.key === "01-head-to-head");
}

/** Wait for the run to rest with the final Review raised. */
function settleOnReview(server: Parameters<typeof settleOn>[0]) {
  return settleOn(server, "REVIEW", "review");
}

/**
 * The whole prompt a head-to-head launch carries, as engine/prompt.ts
 * buildHeadToHeadPrompt writes it behind the driver line the claude
 * harness puts first: copied here as literal text, paths and grades filled
 * in, so a server that drifts by one byte fails.
 */
function expectedHeadToHeadPrompt(
  world: World,
  skill: string | null,
  top: { attempt: number; score: number; reasons: string },
  runnerUp: { attempt: number; score: number; reasons: string },
): string {
  const runs = join(world.pool, "runs");
  const side = (label: string, s: typeof top): string[] => [
    `${label}: attempt ${s.attempt}, graded ${s.score}/10 (pass: ${s.reasons})`,
    "",
    `1. The attempt's Outcome JSON: ${runs}/01.attempt-${s.attempt}.outcome.json`,
    `2. The diff at the attempt's commit: ${runs}/01-head-to-head.attempt-${s.attempt}.diff.patch`,
    `3. The attempt log, trimmed to its last ~20k tokens when huge: ${runs}/01-head-to-head.attempt-${s.attempt}.trim.log`,
  ];
  const body = [
    "You are the head-to-head judge. Two attempts of ticket 01 finished with grades too close to call from " +
      "separate graders: their scores sit within two points of each other, and separate grading calls do not " +
      "calibrate against each other. Compare the two attempts side by side, pick the better one, and put the " +
      "pick in your outcome JSON. The engine owns every status write; you write none.",
    "",
    "---",
    "",
    skill ??
      "_(the pool has no verify skill: no verify.md beside AGENT.md, so judge both sides on the criteria " +
        "below and say so in your summary)_",
    "",
    "---",
    "",
    "Both attempts worked the same ticket:",
    "",
    `The ticket file: ${world.pool}/issues/01-t.md`,
    "",
    "The first attempt's artifacts:",
    "",
    ...side("First", top),
    "",
    "The second attempt's artifacts:",
    "",
    ...side("Second", runnerUp),
    "",
    "Trust terminal output over the agents' self-assessments.",
    "",
    "---",
    "",
    `When you finish, record your outcome as JSON at ${runs}/01-head-to-head.outcome.json: ` +
      '{"status": "done", "summary": "why your pick wins, in a sentence or two", "commitSha": null, ' +
      '"winner": <attempt number>}. The winner is the number of the better attempt, exactly one of ' +
      `${top.attempt} or ${runnerUp.attempt}. If you genuinely cannot separate them, write "winner": "tie" ` +
      "instead; the engine then falls back to the higher score, then the earlier attempt. You write no " +
      "status, raise no interrupts, and merge nothing: the pick in this file is your only output.",
  ].join("\n");
  return `/head-to-head ${world.pool}/issues/01-head-to-head.md\n\n${body}`;
}

// engine.test.ts:2760
conformance("verify", "takes an outright winner: highest score merges, losers' branches go, artifacts stay", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(3) });
  scriptRound(world, [9, 5, 7]);
  const server = await t.start(world);

  const done = await approveReview(server);

  const events = readEvents(world.pool, "01");
  const selected = eventOf(events, "selected");
  expect(selected?.attempt).toBe(1);
  expect(selected?.payload).toEqual({ score: 9, margin: 2, rule: "outright" });
  expect(headToHeadCalls(world)).toEqual([]);
  expect(existsSync(join(world.pool, "issues", "01-head-to-head.md"))).toBe(false);

  expect(attemptsOf(events, "merged")).toEqual([1]);
  expect([1, 2, 3].map((n) => inCheckout(world, `cand-${n}.txt`))).toEqual([true, false, false]);

  for (const n of [1, 2, 3]) {
    expect(branchExists(world, attemptBranch(world, "01", n))).toBe(false);
    expect(existsSync(attemptCwd(world, "01", n))).toBe(false);
  }
  expect(attemptBranches(world)).toEqual([]);

  for (const n of [2, 3]) {
    expect(existsSync(join(world.pool, "runs", `01.attempt-${n}.log`))).toBe(true);
    const outcome = readFileSync(join(world.pool, "runs", `01.attempt-${n}.outcome.json`), "utf8");
    expect(JSON.parse(outcome).status).toBe("done");
  }
  expect(
    events
      .filter((e) => e.kind === "graded")
      .sort((a, b) => a.attempt - b.attempt)
      .map((e) => [e.attempt, e.payload.score]),
  ).toEqual([[1, 9], [2, 5], [3, 7]]);

  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  expect(statuses(done)).toEqual({
    "01": "done",
    "01-grader-1": "done",
    "01-grader-2": "done",
    "01-grader-3": "done",
  });
  expect(done.state.outcomes["01"]?.summary).toBe("summary-01.attempt-1");
});

// engine.test.ts:2846
conformance("verify", "resolves an exact tie to the earlier attempt", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  scriptRound(world, [7, 7], { winner: "tie" });
  const server = await t.start(world);

  const snap = await settleOnReview(server);

  const events = readEvents(world.pool, "01");
  const selected = eventOf(events, "selected");
  expect(selected?.attempt).toBe(1);
  expect(selected?.payload).toEqual({ score: 7, margin: 0, rule: "fallback" });
  expect(headToHeadCalls(world)).toHaveLength(1);
  expect(readStateLine(world.pool, "01-head-to-head.md").line).toContain("id=01-head-to-head blocked-by=01 status=done");
  expect(readEvents(world.pool, "01-head-to-head").map((e) => e.kind)).toEqual(["scheduled", "spawned", "exited"]);
  expect(attemptsOf(events, "merged")).toEqual([1]);
  expect(inCheckout(world, "cand-1.txt")).toBe(true);
  expect(inCheckout(world, "cand-2.txt")).toBe(false);
  expect(branchExists(world, attemptBranch(world, "01", 2))).toBe(false);
  expect(snap.state.log).toContain("ticket 01: head-to-head 01-head-to-head tied");
});

// engine.test.ts:2890
conformance("verify", "falls back when the head-to-head gives no usable pick", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  // The judge's Outcome names no winner at all.
  scriptRound(world, [9, 8], { exitCode: 0 });
  const server = await t.start(world);

  const snap = await settleOnReview(server);

  const events = readEvents(world.pool, "01");
  const selected = eventOf(events, "selected");
  expect(selected?.attempt).toBe(1);
  expect(selected?.payload).toEqual({ score: 9, margin: 1, rule: "fallback" });
  expect(headToHeadCalls(world)).toHaveLength(1);
  expect(readStateLine(world.pool, "01-head-to-head.md").status).toBe("done");
  expect(eventOf(readEvents(world.pool, "01-head-to-head"), "crash")?.payload).toEqual({
    code: 0,
    reason: "outcome names no winner among the two attempts",
    logTail: [],
    outcomeExists: true,
  });
  expect(snap.state.log).toContain(
    "ticket 01: head-to-head 01-head-to-head gave no usable pick: outcome names no winner among the two attempts",
  );
  expect(attemptsOf(events, "merged")).toEqual([1]);
  expect(branchExists(world, attemptBranch(world, "01", 1))).toBe(false);
  expect(branchExists(world, attemptBranch(world, "01", 2))).toBe(false);
});

// engine.test.ts:2939
conformance("verify", "checkpoints instead of selecting while a round holds a paused candidate", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  world.stubs.script("01.attempt-1", { status: "checkpoint", outcome: { summary: "paused-1", commitSha: null } });
  world.stubs.script("01.attempt-2", { work: { file: "cand-2.txt", message: "cand-2" } });
  world.stubs.script("01-grader-2", grade(9));
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "checkpoint");

  const events = readEvents(world.pool, "01");
  expect(eventOf(events, "selected")).toBeUndefined();
  expect(eventOf(events, "merged")).toBeUndefined();
  expect(statuses(snap)["01"]).toBe("checkpoint");
  expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
  expect(snap.state.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
  const body = snap.state.interrupts[0]!.body;
  expect(body).toContain("### Attempt 1 checkpointed\n\nThe agent signalled a checkpoint but wrote no brief");
  expect(body).toContain("Graded 9/10, verdict pass.");
  expect(branchExists(world, attemptBranch(world, "01", 2))).toBe(true);
});

// engine.test.ts:2974
conformance("verify", "spawns one head-to-head for a tight spread and merges its pick", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(3) });
  // The runner-up wins the pairwise call against the raw scores.
  scriptRound(world, [9, 8, 5], { winner: 2 });
  const server = await t.start(world);

  const done = await approveReview(server);

  const calls = headToHeadCalls(world);
  expect(calls).toHaveLength(1);
  expect(readStateLine(world.pool, "01-head-to-head.md").line).toContain("id=01-head-to-head blocked-by=01 status=done");

  const runs = join(world.pool, "runs");
  const prompt = promptOf(calls[0]!.argv);
  expect(prompt).toContain("attempt 1");
  expect(prompt).toContain("attempt 2");
  expect(prompt).toContain(join(runs, "01.attempt-1.outcome.json"));
  expect(prompt).toContain(join(runs, "01.attempt-2.outcome.json"));
  expect(prompt).not.toContain(join(runs, "01.attempt-3.outcome.json"));
  expect(prompt).toContain(join(runs, "01-head-to-head.attempt-1.diff.patch"));
  expect(prompt).toContain(join(runs, "01-head-to-head.attempt-2.diff.patch"));
  expect(prompt).toContain(join(runs, "01-head-to-head.attempt-1.trim.log"));
  expect(prompt).toContain(join(runs, "01-head-to-head.attempt-2.trim.log"));
  expect(prompt).not.toContain("attempt-3");
  expect(calls[0]!.outcome).toBe(join(runs, "01-head-to-head.outcome.json"));

  const diff1 = readFileSync(join(runs, "01-head-to-head.attempt-1.diff.patch"), "utf8");
  expect(diff1).toContain("cand-1");
  expect(diff1).not.toContain("cand-2");
  const diff2 = readFileSync(join(runs, "01-head-to-head.attempt-2.diff.patch"), "utf8");
  expect(diff2).toContain("cand-2");
  expect(diff2).not.toContain("cand-1");

  const events = readEvents(world.pool, "01");
  const selected = eventOf(events, "selected");
  expect(selected?.attempt).toBe(2);
  expect(selected?.payload).toEqual({ score: 8, margin: 1, rule: "head-to-head" });
  expect(attemptsOf(events, "merged")).toEqual([2]);
  expect([1, 2, 3].map((n) => inCheckout(world, `cand-${n}.txt`))).toEqual([false, true, false]);
  expect(attemptBranches(world)).toEqual([]);

  expect(done.state.log).toContain(
    "ticket 01: margin 1 is below the outright band; spawning head-to-head 01-head-to-head between attempts 1 and 2",
  );
  expect(done.state.log).toContain("ticket 01: head-to-head 01-head-to-head picked attempt 2");
  expect(done.state.outcomes["01-head-to-head"]?.summary).toBe("summary-01-head-to-head");
  expect(statuses(done)).toEqual({
    "01": "done",
    "01-grader-1": "done",
    "01-grader-2": "done",
    "01-grader-3": "done",
    "01-head-to-head": "done",
  });
  // With no assign entry of its own the judge inherits the build's model.
  const argv = calls[0]!.argv;
  expect(argv[argv.indexOf("--model") + 1]).toBe("m");
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
});

/** console.json whose head-to-head overrides only the build's model. */
function h2hModelConfig(defaultModel: string): PoolConfig {
  return {
    defaults: { harness: "claude", model: defaultModel },
    assign: {
      "01": { verify: 2, harness: "claude", model: "build-model" },
      "01-head-to-head": { model: "h2h-model" },
    },
  };
}

// engine.test.ts:3083
conformance("verify", "resolves the head-to-head through the ordinary assign machinery", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: h2hModelConfig("m") });
  scriptRound(world, [9, 8], { winner: 1 });
  const server = await t.start(world);

  await settleOnReview(server);

  const calls = headToHeadCalls(world);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.harness).toBe("claude");
  const argv = calls[0]!.argv;
  expect(argv[argv.indexOf("--model") + 1]).toBe("h2h-model");
});

// engine.test.ts:3109
conformance("verify", "serves the head-to-head the Assignment inherited from its build ticket on the snapshot", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: h2hModelConfig("pool-default-model") });
  scriptRound(world, [9, 8], { winner: 1 });
  const server = await t.start(world);

  const snap = await settleOnReview(server);

  expect(ticketOf(snap, "01-head-to-head").assignment).toEqual({
    harness: "claude",
    model: "h2h-model",
    drivers: "implement",
  });
});

// engine.test.ts:3140
conformance("verify", "falls back to the higher raw score when the head-to-head ties", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  // The earlier attempt holds the lower score, so the higher-score clause decides.
  scriptRound(world, [8, 9], { winner: "tie" });
  const server = await t.start(world);

  await settleOnReview(server);

  const events = readEvents(world.pool, "01");
  const selected = eventOf(events, "selected");
  expect(selected?.attempt).toBe(2);
  expect(selected?.payload).toEqual({ score: 9, margin: 1, rule: "fallback" });
  expect(attemptsOf(events, "merged")).toEqual([2]);
  expect(inCheckout(world, "cand-2.txt")).toBe(true);
  expect(branchExists(world, attemptBranch(world, "01", 1))).toBe(false);
});

// engine.test.ts:3169
conformance("verify", "closes a superseded head-to-head card left ready by an earlier round", async (t) => {
  const world = t.world({
    tickets: [
      ready("01"),
      {
        file: "01-head-to-head.md",
        content: "<!-- state: id=01-head-to-head blocked-by=01 status=ready -->\n\n# 01-head-to-head\n",
      },
    ],
    config: verifyConfig(2),
  });
  scriptRound(world, [9, 5]);
  const server = await t.start(world);

  const snap = await settleOnReview(server);

  expect(headToHeadCalls(world)).toEqual([]);
  expect(readStateLine(world.pool, "01-head-to-head.md").status).toBe("done");
  expect(statuses(snap)["01-head-to-head"]).toBe("done");
  expect(snap.state.log).toContain(
    "ticket 01: closed superseded head-to-head card 01-head-to-head (this round's selection did not need it)",
  );
});

// engine.test.ts:3218
conformance("verify", "keeps the absent key automatic: selection without any interrupt", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  scriptRound(world, [9, 8]);
  const server = await t.start(world);

  const snap = await settleOnReview(server);

  expect(snap.state.interrupts.map((i) => i.kind)).toEqual(["review"]);
  const events = readEvents(world.pool, "01");
  expect(eventOf(events, "selected")?.attempt).toBe(1);
  expect(attemptsOf(events, "merged")).toEqual([1]);
  expect(branchExists(world, attemptBranch(world, "01", 1))).toBe(false);
});

// engine.test.ts:3244
conformance("verify", "raises the selection interrupt with every grade when selection is human", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: humanConfig(2) });
  scriptRound(world, [9, 8]);
  world.stubs.script("01-grader-1", grade(9, "crisp edges and honest tests"));
  world.stubs.script("01-grader-2", grade(8, "works but the tests are thin"));
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "selection");

  expect(snap.state.interrupts).toHaveLength(1);
  const body = snap.state.interrupts[0]!.body;
  expect(body).toContain("attempt 1: score 9/10");
  expect(body).toContain("attempt 2: score 8/10");
  expect(body).toContain("crisp edges and honest tests");
  expect(body).toContain("works but the tests are thin");
  expect(statuses(snap)["01"]).toBe("in-progress");
  expect(readStateLine(world.pool, "01-t.md").status).toBe("in-progress");
  const events = readEvents(world.pool, "01");
  expect(eventOf(events, "selected")).toBeUndefined();
  expect(eventOf(events, "merged")).toBeUndefined();
  for (const n of [1, 2]) expect(branchExists(world, attemptBranch(world, "01", n))).toBe(true);
});

// engine.test.ts:3278
conformance("verify", "merges the attempt the answer names and discards the rest", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: humanConfig(2) });
  scriptRound(world, [9, 8]);
  const server = await t.start(world);
  await settleOn(server, "01", "selection");
  const branches = [1, 2].map((n) => attemptBranch(world, "01", n));

  await answer(server, { ticketId: "01", note: "attempt 2" });
  const done = await approveReview(server);

  const events = readEvents(world.pool, "01");
  const selected = eventOf(events, "selected");
  expect(selected?.attempt).toBe(2);
  expect(selected?.payload).toEqual({ score: null, margin: null, rule: "human" });
  expect(attemptsOf(events, "merged")).toEqual([2]);
  expect(inCheckout(world, "cand-2.txt")).toBe(true);
  expect(inCheckout(world, "cand-1.txt")).toBe(false);
  for (const branch of branches) expect(branchExists(world, branch)).toBe(false);
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  expect(done.phase).toBe("done");
  expect(done.state.outcomes["01"]?.summary).toBe("summary-01.attempt-2");
});

// engine.test.ts:3312
conformance("verify", "rejects an answer naming no candidate with a clear error, merging nothing", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: humanConfig(2) });
  scriptRound(world, [9, 8]);
  const server = await t.start(world);
  await settleOn(server, "01", "selection");
  const branches = [1, 2].map((n) => attemptBranch(world, "01", n));

  const unknown = await resume(server, { ticketId: "01", note: "9" });
  expect(unknown.status).toBe(400);
  expect(unknown.text).toMatch(/candidate attempts \(1, 2\); got \\?"9\\?"/);
  const vague = await resume(server, { ticketId: "01", note: "you pick" });
  expect(vague.status).toBe(400);
  expect(vague.text).toMatch(/candidate attempts \(1, 2\); got \\?"you pick\\?"/);

  const snap = await settle(server);
  expect(eventOf(readEvents(world.pool, "01"), "merged")).toBeUndefined();
  for (const branch of branches) expect(branchExists(world, branch)).toBe(true);
  expect(statuses(snap)["01"]).toBe("in-progress");
  expect(snap.state.interrupts.map((i) => i.kind)).toEqual(["selection"]);

  await answer(server, { ticketId: "01", note: "attempt 1" });
  const done = await approveReview(server);
  expect(done.phase).toBe("done");
  expect(attemptsOf(readEvents(world.pool, "01"), "merged")).toEqual([1]);
  expect(branchExists(world, branches[1]!)).toBe(false);
});

// engine.test.ts:3391
conformance("verify", "leaves a verify: 1 ticket's grade-decides path alone under selection: human", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: humanConfig(1) });
  world.stubs.script("01.attempt-1", { work: { file: "cand-1.txt", message: "cand-1" } });
  const server = await t.start(world);

  const snap = await settleOnReview(server);

  expect(snap.state.interrupts.map((i) => i.kind)).toEqual(["review"]);
  const events = readEvents(world.pool, "01");
  expect(eventOf(events, "selected")).toBeUndefined();
  expect(eventOf(events, "merged")).toBeDefined();
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
});

// prompt.test.ts:304
conformance("verify", "the head-to-head prompt names both sides' grades and binds each side's three artifacts", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  scriptRound(world, [9, 8]);
  const server = await t.start(world);

  await settleOnReview(server);

  const calls = headToHeadCalls(world);
  expect(calls).toHaveLength(1);
  const prompt = promptOf(calls[0]!.argv);
  expect(prompt).toContain("attempt 1, graded 9/10");
  expect(prompt).toContain("attempt 2, graded 8/10");
  expect(prompt).toContain(join(world.pool, "issues", "01-t.md"));
  expectSameBytes(
    prompt,
    expectedHeadToHeadPrompt(
      world,
      null,
      { attempt: 1, score: 9, reasons: "scored 9" },
      { attempt: 2, score: 8, reasons: "scored 8" },
    ),
    "the head-to-head prompt",
  );
});

const SKILL = "POOL-SKILL-MARKER: compare on the three criteria only.";

// prompt.test.ts:317
conformance("verify", "the head-to-head prompt carries the pool's verify skill as the shared criteria, or says it is absent", async (t) => {
  for (const skill of [SKILL, null]) {
    const world = t.world({
      tickets: [ready("01")],
      config: verifyConfig(2),
      ...(skill !== null ? { poolFiles: { "verify.md": `${skill}\n` } } : {}),
    });
    scriptRound(world, [9, 8]);
    const server = await t.start(world);

    await settleOnReview(server);

    const prompt = promptOf(headToHeadCalls(world)[0]!.argv);
    if (skill !== null) {
      expect(prompt).toContain(SKILL);
    } else {
      expect(prompt).toContain("(the pool has no verify skill");
    }
    expectSameBytes(
      prompt,
      expectedHeadToHeadPrompt(
        world,
        skill,
        { attempt: 1, score: 9, reasons: "scored 9" },
        { attempt: 2, score: 8, reasons: "scored 8" },
      ),
      `the head-to-head prompt ${skill !== null ? "with" : "without"} verify.md`,
    );
  }
}, { timeoutMs: 90_000 });

// prompt.test.ts:329
conformance("verify", "the head-to-head prompt states the pick contract, the tie clause, and the trust rule", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  // The higher grade on attempt 2 puts it first and orders the contract's pair.
  scriptRound(world, [7, 8]);
  const server = await t.start(world);

  await settleOnReview(server);

  const prompt = promptOf(headToHeadCalls(world)[0]!.argv);
  expect(prompt).toContain('"winner"');
  expect(prompt).toContain("exactly one of 2 or 1");
  expect(prompt).toContain('"winner": "tie"');
  expect(prompt).toContain("falls back to the higher score, then the earlier");
  expect(prompt).toContain("Trust terminal output over the agents' self-assessments.");
  expect(prompt).toContain("The engine owns every status write");
  expectSameBytes(
    prompt,
    expectedHeadToHeadPrompt(
      world,
      null,
      { attempt: 2, score: 8, reasons: "scored 8" },
      { attempt: 1, score: 7, reasons: "scored 7" },
    ),
    "the head-to-head prompt",
  );
});

// Gap (a): a winner written as a string still names an attempt.
conformance("verify", "takes a head-to-head winner written as the string '2'", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  scriptRound(world, [9, 8], { winner: "2" });
  const server = await t.start(world);

  await settleOnReview(server);

  const events = readEvents(world.pool, "01");
  const selected = eventOf(events, "selected");
  expect(selected?.attempt).toBe(2);
  expect(selected?.payload).toEqual({ score: 8, margin: 1, rule: "head-to-head" });
  expect(inCheckout(world, "cand-2.txt")).toBe(true);
  expect(inCheckout(world, "cand-1.txt")).toBe(false);
});

// Gap (b): a checkpoint Outcome from the judge is no pick, whatever winner it names.
conformance("verify", "treats a head-to-head checkpoint Outcome as no pick and falls back", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  scriptRound(world, [9, 8], { status: "checkpoint", winner: 2 });
  const server = await t.start(world);

  await settleOnReview(server);

  const crash = eventOf(readEvents(world.pool, "01-head-to-head"), "crash");
  expect(crash?.payload.reason).toBe("head-to-head outcome is a checkpoint, not a pick");
  expect(readStateLine(world.pool, "01-head-to-head.md").status).toBe("done");
  const selected = eventOf(readEvents(world.pool, "01"), "selected");
  expect(selected?.attempt).toBe(1);
  expect(selected?.payload).toEqual({ score: 9, margin: 1, rule: "fallback" });
  expect(inCheckout(world, "cand-1.txt")).toBe(true);
});

// Gap (c): outside git the selected work is already in the checkout.
conformance("verify", "selects without merging in a pool outside git", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2), git: false });
  world.stubs.script("01-grader-1", grade(9));
  world.stubs.script("01-grader-2", grade(5));
  const server = await t.start(world);

  const snap = await settleOnReview(server);

  expect(snap.state.log.some((line) =>
    line.includes("attempt 1 selected (the pool does not run in git; the selected work is already in the checkout)"),
  )).toBe(true);
  const events = readEvents(world.pool, "01");
  expect(eventOf(events, "selected")?.attempt).toBe(1);
  expect(eventOf(events, "merged")).toBeUndefined();
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
});

// Gap (d): the loser goes unmerged, its record does not.
conformance("verify", "force-deletes a losing branch that never merged and keeps its logs and Grade", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  scriptRound(world, [9, 5]);
  const server = await t.start(world);

  await settleOnReview(server);

  const loser = attemptBranch(world, "01", 2);
  expect(branchExists(world, loser)).toBe(false);
  expect(existsSync(attemptCwd(world, "01", 2))).toBe(false);
  // Its commit never reached the working branch.
  expect(inCheckout(world, "cand-2.txt")).toBe(false);
  expect(world.git(["log", "--format=%s", "main"]).split("\n")).not.toContain("cand-2");
  expect(existsSync(join(world.pool, "runs", "01.attempt-2.log"))).toBe(true);
  expect(existsSync(join(world.pool, "runs", "01.attempt-2.outcome.json"))).toBe(true);
  const graded = readEvents(world.pool, "01").find((e) => e.kind === "graded" && e.attempt === 2);
  expect(graded?.payload).toEqual({ score: 5, verdict: "pass", reasons: "scored 5" });
});

// Gap (e): a selected winner whose merge conflicts checkpoints with the conflict in its Brief.
conformance("verify", "checkpoints a selected winner whose merge conflicts, naming the file and its branch", async (t) => {
  const world = t.world({
    tickets: [ready("01"), ready("02")],
    config: verifyConfig(2),
  });
  for (const n of [1, 2]) {
    world.stubs.script(`01.attempt-${n}`, {
      work: { file: "cand.txt", line: `from 01 attempt ${n}`, overwrite: true, message: `cand-${n}` },
    });
  }
  world.stubs.script("01-grader-1", grade(9));
  world.stubs.script("01-grader-2", grade(5));
  world.stubs.script("02", { work: { file: "cand.txt", line: "from 02", overwrite: true, message: "02" } });
  const server = await t.start(world);

  const snap = await settleOn(server, "01", "checkpoint");

  const events = readEvents(world.pool, "01");
  expect(eventOf(events, "selected")?.attempt).toBe(1);
  expect(eventOf(events, "merged")).toBeUndefined();
  expect(attemptsOf(readEvents(world.pool, "02"), "merged")).toEqual([1]);
  expect(readFileSync(join(world.repo, "cand.txt"), "utf8")).toBe("from 02\n");
  expect(branchExists(world, attemptBranch(world, "01", 2))).toBe(false);
  expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
  const interrupt = snap.state.interrupts.find((i) => i.ticketId === "01")!;
  expect(interrupt.kind).toBe("checkpoint");
  expect(interrupt.body).toContain("cand.txt");
  expect(interrupt.body).toContain(attemptBranch(world, "01", 1));
});

// Gap (f): the grades endpoint reads the events file as it stands.
conformance("verify", "GET /api/grades serves a grade appended to a done Ticket's events", async (t) => {
  const world = t.world({
    tickets: [{ file: "01-t.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" }],
    config: DEFAULTS,
  });
  const server = await t.start(world);

  const before = await server.http.get("/api/grades");
  expect(before.status).toBe(200);
  expect(before.json<unknown>()).toEqual({ grades: {} });

  mkdirSync(join(world.pool, "runs"), { recursive: true });
  const event: TicketEvent = {
    at: "2026-09-02T10:00:00.000Z",
    attempt: 1,
    kind: "graded",
    payload: { score: 7, verdict: "pass", reasons: "appended" },
  };
  appendFileSync(join(world.pool, "runs", "01.events.jsonl"), `${JSON.stringify(event)}\n`);

  const after = await server.http.get("/api/grades");
  expect(after.json<unknown>()).toEqual({ grades: { "01": { attempt: 1, score: 7, verdict: "pass", winner: null } } });
});
