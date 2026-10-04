/**
 * Verify with Jev, the grading path (C22 of the Rust port's inventory,
 * docs/research/rust-port/test-inventory.md; ADR-0023). With a TypeSafe
 * key every Attempt of a round is graded in code: one request per Attempt,
 * the rubric's questions over that Attempt's Evidence, no grader Ticket.
 * Without a key, or when any ask of the round falls back, the grader
 * Tickets grade the whole round instead: one instrument per round, never
 * both. The first case of this path, the outright pick from composed
 * scores (`engine.test.ts:2428`), is in jev.test.ts.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { readEvents, readStateLine } from "../harness/pool-files.ts";
import { settle, settleOn } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import { inCheckout, ready, verifyConfig } from "./verify-common.ts";
import {
  attemptOf,
  CLEAN,
  couldNotGrade,
  DEFAULT_GRADE,
  type Evidence,
  evidenceOf,
  gradedEvents,
  jevLines,
  poolLog,
  RUBRIC,
  RUBRIC_QUESTIONS,
  scoreAnswer,
  settleOnReview,
  unavailable,
  verifyEach,
} from "./verify-jev-support.ts";

/** Two Attempts that each commit their own file, and a head-to-head that picks the first should grades tie. */
function twoCandidates(world: World): void {
  for (const n of [1, 2]) world.stubs.script(`01.attempt-${n}`, { work: { file: `cand-${n}.txt`, message: `cand-${n}` } });
  world.stubs.script("01-head-to-head", { winner: 1 });
}

/** Whether an issues/ file exists. */
function issueExists(world: World, file: string): boolean {
  return existsSync(join(world.pool, "issues", file));
}

/** The pool log's per-Attempt grade lines, sorted: the graders run side by side. */
function gradedLines(log: string[]): string[] {
  return log.filter((line) => /^ticket 01: attempt \d+ graded: /.test(line)).sort();
}

/** The grade lines a round the grader Tickets graded leaves, and none from Jev. */
const GRADER_LINES = [
  "ticket 01: attempt 1 graded: score 8, verdict pass (grader 01-grader-1)",
  "ticket 01: attempt 2 graded: score 8, verdict pass (grader 01-grader-2)",
];

/** How many times the server launched `key`. */
function launches(world: World, key: string): number {
  return world.stubs.calls().filter((call) => call.key === key).length;
}

// No inventory row: the request itself, which the Jev fake makes visible.
// Its Evidence builder's rows are Rust unit tests (jev-evidence.test.ts);
// this pins what one Attempt's Evidence comes to whole.
conformance("verify", "asks Jev the rubric's questions over one Evidence object per Attempt", async (t) => {
  const world = t.world({
    tickets: [
      {
        file: "01-t.md",
        marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        body: "# Write cand.txt\n\nAcceptance: cand.txt holds one line.",
      },
    ],
    config: verifyEach(["01"]),
  });
  // The work commits a lockfile beside cand.txt, and the run prints colour
  // and a window title.
  world.stubs.script("01.attempt-1", {
    run: "printf 'work\\n' > cand.txt\nprintf 'lock\\n' > bun.lock\ngit add cand.txt bun.lock\ngit commit -qm cand",
    stdout: "\u001b[1;32mPASS\u001b[0m 3 tests\n\u001b]0;a title\u0007done\n",
  });
  const jev = t.jev({ answers: CLEAN });
  const server = await t.start(world, { jev });
  await settleOnReview(server);

  expect(jev.requests).toHaveLength(1);
  const [request] = jev.requests;
  expect(Object.keys(request!.body).sort()).toEqual(["model", "questions", "state"]);
  expect(request!.body.questions as unknown).toEqual(RUBRIC_QUESTIONS);
  // The Ticket file as it reads while the round grades, the Outcome summary
  // under a name that says it is a claim, the changed lines of the diff
  // with the lockfile's section dropped, and the log with its escape
  // sequences stripped.
  expect(evidenceOf(request!)).toEqual({
    ticket:
      "<!-- state: id=01 blocked-by=none status=in-progress -->\n\n" +
      "# Write cand.txt\n\nAcceptance: cand.txt holds one line.\n",
    agent_summary_claim: "summary-01.attempt-1",
    diff:
      "diff --git a/cand.txt b/cand.txt\nnew file mode 100644\nindex 0000000..b8f99f5\n" +
      "--- /dev/null\n+++ b/cand.txt\n@@ -0,0 +1 @@\n+work",
    diff_note: "changed lines only, no context lines",
    log: "PASS 3 tests\ndone\n",
    log_note: "the whole log",
  });
  expect(inCheckout(world, "cand.txt")).toBe(true);
});

// No inventory row: the Evidence of a pool outside git.
conformance("verify", "a pool outside git hands Jev no diff, and says why", async (t) => {
  const world = t.world({ git: false, tickets: [ready("01")], config: verifyEach(["01"]) });
  const jev = t.jev({ answers: CLEAN });
  const server = await t.start(world, { jev });
  await settle(server, (s) => s.state.interrupts.length > 0, { ms: 60_000, what: "the round to decide" });

  expect(jev.requests).toHaveLength(1);
  const evidence = evidenceOf(jev.requests[0]!);
  expect(evidence.diff).toBe("");
  expect(evidence.diff_note).toBe("no diff: the pool does not run in git");
  expect(gradedEvents(world, "01").map((e) => e.payload.rubric)).toEqual([RUBRIC]);
});

// engine.test.ts:2490
conformance("verify", "takes a composed spread of exactly two points outright, not by float subtraction", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  twoCandidates(world);
  // Jev Scores are expected levels, so composed scores carry a decimal:
  // 8.2 and 6.2 sit exactly two points apart, but 8.2 - 6.2 in floating
  // point is 1.9999999999999991, just inside the head-to-head band.
  const jev = t.jev({
    answersFor: (state) =>
      attemptOf(state) === 1
        ? { ...CLEAN, ticket_fit: scoreAnswer(4), claim_fidelity: scoreAnswer(3), log_health: scoreAnswer(1.2) }
        : { ...CLEAN, ticket_fit: scoreAnswer(4), claim_fidelity: scoreAnswer(1.2), log_health: scoreAnswer(1) },
  });
  const server = await t.start(world, { jev });
  await settleOnReview(server);

  expect(gradedEvents(world, "01").map((e) => [e.attempt, e.payload.score, e.payload.verdict])).toEqual([
    [1, 8.2, "pass"],
    [2, 6.2, "pass"],
  ]);
  expect(issueExists(world, "01-head-to-head.md")).toBe(false);
  expect(launches(world, "01-head-to-head")).toBe(0);
  const selected = readEvents(world.pool, "01").find((e) => e.kind === "selected");
  expect(selected?.attempt).toBe(1);
  expect(selected?.payload).toEqual({ score: 8.2, margin: 2, rule: "outright" });
  expect(inCheckout(world, "cand-1.txt")).toBe(true);
  expect(inCheckout(world, "cand-2.txt")).toBe(false);
  // The grades endpoint reads a Jev Grade as it reads any other.
  const grades = await server.http.get("/api/grades");
  expect(grades.status).toBe(200);
  expect(grades.json<unknown>()).toEqual({ grades: { "01": { attempt: 1, score: 8.2, verdict: "pass", winner: 1 } } });
});

// engine.test.ts:2524
conformance("verify", "keeps the grader-ticket path when the server has no Jev key", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  twoCandidates(world);
  // JEV_BASE_URL names a live fake, but with no key nothing is ever sent.
  const jev = t.jev({ answers: CLEAN });
  const server = await t.start(world, { env: { JEV_BASE_URL: jev.url } });
  await settleOnReview(server);

  expect(jev.requests).toEqual([]);
  expect(issueExists(world, "01-grader-1.md")).toBe(true);
  expect(issueExists(world, "01-grader-2.md")).toBe(true);
  expect(launches(world, "01-grader-1")).toBe(1);
  expect(launches(world, "01-grader-2")).toBe(1);
  const log = await poolLog(server);
  expect(jevLines(log)).toEqual(["Jev not configured, heuristics only"]);
  expect(log).toContain("ticket 01: grading 2 attempts with grader tickets 01-grader-1, 01-grader-2");
  // An agent grader's Grade carries no provenance.
  expect(gradedEvents(world, "01").map((e) => e.payload)).toEqual([DEFAULT_GRADE, DEFAULT_GRADE]);
});

// engine.test.ts:2557
conformance("verify", "flags a passing weighted score when a passing-tests claim sits beside a failing final run", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyEach(["01"]) });
  // The Outcome claims a green suite over a log whose last test run failed.
  world.stubs.script("01.attempt-1", {
    outcome: { summary: "All tests pass: 483 pass, 0 fail.", commitSha: null },
    stdout: "bun test\n482 pass\n1 fail\n1 error\n",
  });
  // Jev judges what the Evidence shows it: the claim beside the failing run.
  const jev = t.jev({
    answersFor: (state) => {
      const text = JSON.stringify(state);
      const contradicted = text.includes("All tests pass") && text.includes("1 fail");
      return {
        ...CLEAN,
        // Errors fixed, later run clean: the weighted score passes, so the
        // gates are the only reason to flag.
        log_health: 2,
        contradicted_claim: contradicted ? 0.9 : 0.1,
        failing_at_end: contradicted ? 0.95 : 0.1,
        summary_claims_tests_pass: contradicted ? 0.95 : 0.1,
      };
    },
  });
  const server = await t.start(world, { jev });
  await settleOn(server, "01", "checkpoint", 60_000);

  const evidence = evidenceOf(jev.requests[0]!);
  expect(evidence.agent_summary_claim).toBe("All tests pass: 483 pass, 0 fail.");
  expect(evidence.log).toBe("bun test\n482 pass\n1 fail\n1 error\n");
  const [graded] = gradedEvents(world, "01");
  expect(graded!.payload.score).toBe(8.5);
  expect(graded!.payload.verdict).toBe("flag");
  expect(graded!.payload.reasons).toBe(
    "ticket fit: all criteria met; claim fidelity: summary fully borne out; log health: errors fixed, later run clean. " +
      "Flagged because the log contradicts a result the summary claims and the last test run or build in the log failed and " +
      "the summary claims passing tests while the last run in the log failed.",
  );
  expect(issueExists(world, "01-grader-1.md")).toBe(false);
  expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
});

// engine.test.ts:2612
conformance("verify", "widens once on trimmed Evidence, then accepts a flagged low-confidence Grade", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyEach(["01"]) });
  // A log over the 20,000-character base tail, so the first Evidence is
  // trimmed and the one widening re-ask is allowed. The work changes a
  // line of an existing file, so the diff has context lines to add.
  const lines = Array.from({ length: 700 }, (_, i) => `log line ${String(i).padStart(4, "0")}: ${"x".repeat(32)}`);
  world.stubs.script("01.attempt-1", {
    stdout: `${lines.join("\n")}\n`,
    work: { file: "README.md", line: "added", message: "readme" },
  });
  const jev = t.jev({ answers: { ...CLEAN, ticket_fit: scoreAnswer(3.75, 0.4) } });
  const server = await t.start(world, { jev });
  await settleOn(server, "01", "checkpoint", 60_000);

  // Exactly two asks for the one Attempt: the base one and the widening.
  expect(jev.requests).toHaveLength(2);
  const whole = readFileSync(join(world.pool, "runs", "01.attempt-1.log"), "utf8");
  expect(whole.length).toBeGreaterThan(20_000);
  const [base, widened] = jev.requests.map(evidenceOf);
  // The base tail: at most 20,000 characters, cut forward to a line start.
  expect(base!.log.length).toBeLessThanOrEqual(20_000);
  expect(base!.log.length).toBeGreaterThan(20_000 - 50);
  expect(whole.endsWith(base!.log)).toBe(true);
  expect(base!.log.startsWith("log line ")).toBe(true);
  expect(base!.log_note).toBe(`the log was trimmed to its last ${base!.log.length} characters of ${whole.length}`);
  expect(base!.diff_note).toBe("changed lines only, no context lines");
  expect(base!.diff).not.toContain("\n # conformance");
  // The widened tail holds the whole log, and the diff its context lines.
  expect(widened!.log).toBe(whole);
  expect(widened!.log_note).toBe("the whole log");
  expect(widened!.diff_note).toBe("the full diff, with context lines");
  expect(widened!.diff).toContain("\n # conformance\n+added");

  const [graded] = gradedEvents(world, "01");
  expect(graded!.payload).toEqual({
    score: 9.4,
    verdict: "flag",
    reasons:
      "ticket fit: all criteria met; claim fidelity: summary fully borne out; log health: clean run. " +
      "Flagged because ticket fit was judged with too little confidence. Note: low confidence on ticket_fit.",
    rubric: RUBRIC,
    model: "jev-latest",
    evidenceBudget: "widened",
  });
  expect(await poolLog(server)).toContain(
    `ticket 01: attempt 1 graded: score 9.4, verdict flag (Jev ${RUBRIC}, widened evidence)`,
  );
  expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
});

// No inventory row: the widening re-ask is an ask like any other, and a
// failed one abandons the round.
conformance("verify", "a widening re-ask that fails gives the round to the grader Ticket", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyEach(["01"]) });
  world.stubs.script("01.attempt-1", { stdout: `${"y".repeat(30_000)}\n` });
  // The base ask answers with a low-confidence ticket fit over a trimmed
  // log; the widened one, which carries the whole log, is refused.
  const jev = t.jev({
    answers: { ...CLEAN, ticket_fit: scoreAnswer(3.75, 0.4) },
    failFor: (state) => ((state as Evidence).log_note === "the whole log" ? { status: 401 } : undefined),
  });
  const server = await t.start(world, { jev });
  await settleOnReview(server);

  expect(jev.requests.map((request) => evidenceOf(request).log_note)).toEqual([
    "the log was trimmed to its last 20000 characters of 30001",
    "the whole log",
  ]);
  const log = await poolLog(server);
  expect(jevLines(log)).toEqual(["Jev configured (jev-latest)", unavailable("bad-key", "HTTP 401")]);
  expect(log.filter((line) => line.includes("Jev could not grade"))).toEqual([
    couldNotGrade("01", 1, "bad-key", "HTTP 401"),
  ]);
  expect(launches(world, "01-grader-1")).toBe(1);
  expect(gradedEvents(world, "01").map((e) => e.payload)).toEqual([DEFAULT_GRADE]);
});

// engine.test.ts:2653
conformance("verify", "falls back to grader tickets when a Jev ask fails, with the cause logged once", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  twoCandidates(world);
  const jev = t.jev({ fail: { status: 429 } });
  const server = await t.start(world, { jev });
  await settleOnReview(server);

  // Attempt 1's ask failed once its retries were spent, and the round was
  // abandoned there: attempt 2 was never asked.
  expect(jev.requests.map((request) => attemptOf(request.body.state))).toEqual([1, 1, 1]);
  expect(issueExists(world, "01-grader-1.md")).toBe(true);
  expect(issueExists(world, "01-grader-2.md")).toBe(true);
  expect(launches(world, "01-grader-1")).toBe(1);
  expect(launches(world, "01-grader-2")).toBe(1);
  const log = await poolLog(server);
  const cause = unavailable("rate-limited", "HTTP 429");
  const fellBack = couldNotGrade("01", 1, "rate-limited", "HTTP 429");
  expect(jevLines(log)).toEqual(["Jev configured (jev-latest)", cause]);
  expect(log.filter((line) => line.includes("Jev could not grade"))).toEqual([fellBack]);
  // In order: the cause as it bites, the switch, then the grader Tickets.
  const graders = log.indexOf("ticket 01: grading 2 attempts with grader tickets 01-grader-1, 01-grader-2");
  expect(log.indexOf(cause)).toBeLessThan(log.indexOf(fellBack));
  expect(log.indexOf(fellBack)).toBeLessThan(graders);
  expect(log).not.toContain("ticket 01: grading 2 attempts with Jev");
  expect(gradedLines(log)).toEqual(GRADER_LINES);
  expect(gradedEvents(world, "01").map((e) => e.payload)).toEqual([DEFAULT_GRADE, DEFAULT_GRADE]);
});

// engine.test.ts:2689
conformance("verify", "discards attempt 1's composed Grade when attempt 2's ask fails mid-round", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  twoCandidates(world);
  // Attempt 1 is asked first and answered; attempt 2's ask is the one that
  // fails. The composed Grade attempt 1 earned must never land beside the
  // grader Tickets' Grades: one round is one instrument.
  const jev = t.jev({
    answers: CLEAN,
    failFor: (state) => (attemptOf(state) === 2 ? { status: 429 } : undefined),
  });
  const server = await t.start(world, { jev });
  await settleOnReview(server);

  expect(jev.requests.map((request) => attemptOf(request.body.state))).toEqual([1, 2, 2, 2]);
  expect(launches(world, "01-grader-1")).toBe(1);
  expect(launches(world, "01-grader-2")).toBe(1);
  const log = await poolLog(server);
  // Attempt 1's answer was no recovery (nothing had failed yet), so the
  // cause is the only notice.
  expect(jevLines(log)).toEqual(["Jev configured (jev-latest)", unavailable("rate-limited", "HTTP 429")]);
  expect(log.filter((line) => line.includes("Jev could not grade"))).toEqual([
    couldNotGrade("01", 2, "rate-limited", "HTTP 429"),
  ]);
  expect(log).not.toContain("ticket 01: grading 2 attempts with Jev");
  expect(gradedLines(log)).toEqual(GRADER_LINES);
  expect(gradedEvents(world, "01").map((e) => e.payload)).toEqual([DEFAULT_GRADE, DEFAULT_GRADE]);
});
