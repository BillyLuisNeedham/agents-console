/**
 * Verify with Jev, the rubric (C22 of the Rust port's inventory,
 * docs/research/rust-port/test-inventory.md; ADR-0023): one Attempt of a
 * verify: 1 Ticket graded through the Jev fake, whose typed answers the
 * server composes into the Grade in code. The score is the three
 * dimensions normalised by their levels less one and weighted, rounded to
 * one decimal; a gate Noul at 0.6 or more flags, one from 0.45 is named as
 * possible; the derived gate is a passing-tests claim beside a failing
 * final run; a ticket fit judged with confidence under 0.5 flags. Every
 * word of `reasons` is one of the rubric's fixed phrases, so each case
 * pins the whole text.
 */

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";
import type { ScriptedAnswer } from "../fixtures/jev-fake.ts";
import { conformance, type Case } from "../harness/case.ts";
import { readStateLine } from "../harness/pool-files.ts";
import { settle } from "../harness/pool-run.ts";
import { ready } from "./verify-common.ts";
import { CLEAN, gradedEvents, RUBRIC, scoreAnswer, verifyEach } from "./verify-jev-support.ts";

/** The level phrases of a clean pass: each dimension at its top level. */
const CLEAN_LEVELS = "ticket fit: all criteria met; claim fidelity: summary fully borne out; log health: clean run.";

/**
 * Ticket 01 at verify: 1, its one Attempt graded by Jev answering `answers`
 * over the clean pass; run until the round has decided, a Review for a
 * pass or a checkpoint for a flag.
 */
async function gradeWith(
  t: Case,
  answers: Record<string, ScriptedAnswer>,
): Promise<{ grade: Record<string, unknown>; snap: EnrichedSnapshot; requests: number; status: string }> {
  const world = t.world({ tickets: [ready("01")], config: verifyEach(["01"]) });
  const jev = t.jev({ answers: { ...CLEAN, ...answers } });
  const server = await t.start(world, { jev });
  const snap = await settle(server, (s) => s.state.interrupts.length > 0, {
    ms: 60_000,
    what: "the round to decide",
  });
  // The round was Jev's alone: no grader Ticket was written.
  expect(existsSync(join(world.pool, "issues", "01-grader-1.md"))).toBe(false);
  const graded = gradedEvents(world, "01");
  expect(graded.map((e) => e.attempt)).toEqual([1]);
  return {
    grade: graded[0]!.payload,
    snap,
    requests: jev.requests.length,
    status: readStateLine(world.pool, "01-t.md").status,
  };
}

/** The Interrupts a decided round left: the Review for a pass, a checkpoint on 01 for a flag. */
function raised(snap: EnrichedSnapshot): [string, string][] {
  return snap.state.interrupts.map((i) => [i.ticketId, i.kind]);
}

// jev-rubric.test.ts:42
conformance("verify", "a Jev Grade weights and normalises the three dimensions into a 0-10 score", async (t) => {
  const { grade, snap, status } = await gradeWith(t, {});
  expect(grade).toEqual({
    score: 9.4,
    verdict: "pass",
    reasons: CLEAN_LEVELS,
    rubric: RUBRIC,
    model: "jev-latest",
    evidenceBudget: "base",
  });
  // A passing lone Attempt merges and its Ticket is done.
  expect(status).toBe("done");
  expect(raised(snap)).toEqual([["REVIEW", "review"]]);
});

// jev-rubric.test.ts:54
conformance("verify", "a Jev Grade flags on the weighted score alone below 6.0", async (t) => {
  const { grade, snap, status } = await gradeWith(t, { ticket_fit: 0, claim_fidelity: 0, log_health: 0 });
  // The fake spreads 1 - 0.9 in floating point, so the expected levels it
  // answers sit a hair under 0.25, 0.2 and 0.2: the weighted sum falls
  // just short of 0.065, and one decimal of it is 0.6.
  expect(grade.score).toBe(0.6);
  expect(grade.verdict).toBe("flag");
  expect(grade.reasons).toBe(
    "ticket fit: nothing of the ticket is done; claim fidelity: summary contradicted by the artifacts; " +
      "log health: run ends in failure. Flagged on the weighted score alone.",
  );
  // A flagged lone Attempt goes to the operator as a checkpoint.
  expect(status).toBe("checkpoint");
  expect(raised(snap)).toEqual([["01", "checkpoint"]]);
});

// jev-rubric.test.ts:63
conformance("verify", "a Jev Grade flags on a gate even when the weighted score would pass", async (t) => {
  const { grade, status } = await gradeWith(t, { contradicted_claim: 0.9 });
  expect(grade.score).toBe(9.4);
  expect(grade.verdict).toBe("flag");
  expect(grade.reasons).toBe(`${CLEAN_LEVELS} Flagged because the log contradicts a result the summary claims.`);
  expect(status).toBe("checkpoint");
});

// jev-rubric.test.ts:75
conformance("verify", "a Jev Grade names the derived gate when a passing-tests claim sits beside a failing final run", async (t) => {
  const { grade, status } = await gradeWith(t, { summary_claims_tests_pass: 0.95, failing_at_end: 0.95 });
  expect(grade.score).toBe(9.4);
  expect(grade.verdict).toBe("flag");
  // failing_at_end is a gate of its own, so it fires beside the derived one.
  expect(grade.reasons).toBe(
    `${CLEAN_LEVELS} Flagged because the last test run or build in the log failed and ` +
      "the summary claims passing tests while the last run in the log failed.",
  );
  expect(status).toBe("checkpoint");
});

// jev-rubric.test.ts:92
conformance("verify", "a Jev Grade names a gate between 0.45 and 0.6 as possible, without flagging", async (t) => {
  const { grade, status } = await gradeWith(t, { untouched_criterion: 0.5 });
  expect(grade.score).toBe(9.4);
  expect(grade.verdict).toBe("pass");
  expect(grade.reasons).toBe(`${CLEAN_LEVELS} Possible, not acted on: a ticket criterion has no work in the diff.`);
  expect(status).toBe("done");
});

// jev-rubric.test.ts:102
conformance("verify", "a Jev Grade flags a ticket fit judged with low confidence, and says so", async (t) => {
  // The Evidence is small, so nothing was trimmed and there is no widening
  // re-ask: the one answer stands.
  const { grade, requests, status } = await gradeWith(t, { ticket_fit: scoreAnswer(3.75, 0.4) });
  expect(requests).toBe(1);
  expect(grade).toEqual({
    score: 9.4,
    verdict: "flag",
    reasons:
      `${CLEAN_LEVELS} Flagged because ticket fit was judged with too little confidence. ` +
      "Note: low confidence on ticket_fit.",
    rubric: RUBRIC,
    model: "jev-latest",
    evidenceBudget: "base",
  });
  expect(status).toBe("checkpoint");
});

// jev-rubric.test.ts:119
conformance("verify", "a Jev Grade marks low confidence on claim fidelity and log health without flagging", async (t) => {
  const { grade, status } = await gradeWith(t, {
    claim_fidelity: scoreAnswer(3, 0.4),
    log_health: scoreAnswer(3, 0.4),
  });
  expect(grade.score).toBe(9.8);
  expect(grade.verdict).toBe("pass");
  expect(grade.reasons).toBe(`${CLEAN_LEVELS} Note: low confidence on claim_fidelity, log_health.`);
  expect(status).toBe("done");
});

// jev-rubric.test.ts:137
conformance("verify", "a Jev Grade names an advisory in its reasons only, and never gates on it", async (t) => {
  const { grade, status } = await gradeWith(t, { no_test_run: 0.9, evidence_too_thin: 0.9 });
  expect(grade.score).toBe(9.4);
  expect(grade.verdict).toBe("pass");
  expect(grade.reasons).toBe(
    `${CLEAN_LEVELS} Note: no test run appears in the log; the diff or log was too thin to judge.`,
  );
  expect(status).toBe("done");
});

// jev-rubric.test.ts:145
conformance("verify", "a Jev Grade's reasons are composed only from the rubric's fixed phrases", async (t) => {
  const { grade } = await gradeWith(t, {
    contradicted_claim: 0.7,
    untouched_criterion: 0.5,
    no_test_run: 0.8,
    summary_claims_tests_pass: 0.9,
    failing_at_end: 0.9,
  });
  expect(grade.verdict).toBe("flag");
  expect(grade.reasons).toBe(
    `${CLEAN_LEVELS} Flagged because the log contradicts a result the summary claims and ` +
      "the last test run or build in the log failed and " +
      "the summary claims passing tests while the last run in the log failed. " +
      "Possible, not acted on: a ticket criterion has no work in the diff. " +
      "Note: no test run appears in the log.",
  );
  // Levels and probabilities stay typed: no number reaches the text.
  expect(/\d/.test(String(grade.reasons))).toBe(false);
});

// jev-rubric.test.ts:173
conformance("verify", "a Jev Grade names its rubric version, on the graded event and in the pool log", async (t) => {
  const { grade, snap } = await gradeWith(t, {});
  expect(grade.rubric).toBe("jev-grader-rubric/2026-09-20.1");
  expect(snap.state.log).toContain(
    "ticket 01: attempt 1 graded: score 9.4, verdict pass (Jev jev-grader-rubric/2026-09-20.1, base evidence)",
  );
  expect(snap.state.log).toContain("ticket 01: grading 1 attempt with Jev");
});
