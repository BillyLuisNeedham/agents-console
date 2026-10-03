/**
 * The Jev grader rubric's composition (ADR-0023, REPORT.md sections 1 and 3).
 * These cases pin the arithmetic, the gates and the fixed-phrase reasons with
 * typed answers built by the Jev fake's own `answerFor`, so the wording Jev
 * would have seen is the wording here.
 */

import { describe, expect, it } from "bun:test";
import { answerFor, type ScriptedAnswer } from "../conformance/fixtures/jev-fake.ts";
import {
  compose,
  DERIVED_GATE,
  PHRASES,
  QUESTIONS,
  RUBRIC_VERSION,
  THRESHOLDS,
} from "./jev-rubric.ts";

/** Answers for every rubric question, scripted by id. */
function answers(script: Record<string, ScriptedAnswer>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [id, question] of Object.entries(QUESTIONS)) {
    out[id] = answerFor(question, script[id]);
  }
  return out;
}

/** The clean pass the bench saw: every dimension high, every gate quiet. */
const clean = {
  ticket_fit: 4,
  claim_fidelity: 3,
  log_health: 3,
  contradicted_claim: 0.1,
  untouched_criterion: 0.1,
  failing_at_end: 0.1,
  summary_claims_tests_pass: 0.1,
  no_test_run: 0.1,
  evidence_too_thin: 0.1,
} as const;

describe("compose", () => {
  it("weights and normalises the three dimensions into a 0-10 score", () => {
    const composed = compose(answers({ ...clean }));
    expect(composed.score10).toBe(9.4);
    expect(composed.verdict).toBe("pass");
    expect(composed.gatesFired).toEqual([]);
    expect(composed.lowConfidence).toEqual([]);
    expect(composed.reasons).toBe(
      "ticket fit: all criteria met; claim fidelity: summary fully borne out; " +
        "log health: clean run.",
    );
  });

  it("flags on the weighted score alone below 6.0", () => {
    const composed = compose(
      answers({ ...clean, ticket_fit: 0, claim_fidelity: 0, log_health: 0 }),
    );
    expect(composed.score10).toBeLessThan(THRESHOLDS.flagBelow);
    expect(composed.verdict).toBe("flag");
    expect(composed.reasons).toContain("Flagged on the weighted score alone.");
  });

  it("flags on a gate even when the weighted score would pass", () => {
    const composed = compose(
      answers({ ...clean, contradicted_claim: 0.9 }),
    );
    expect(composed.score10).toBeGreaterThan(THRESHOLDS.flagBelow);
    expect(composed.verdict).toBe("flag");
    expect(composed.gatesFired).toContain("contradicted_claim");
    expect(composed.reasons).toContain(
      "Flagged because the log contradicts a result the summary claims.",
    );
  });

  it("flags and names the derived gate when a passing-tests claim sits beside a failing final run", () => {
    const composed = compose(
      answers({
        ...clean,
        summary_claims_tests_pass: 0.95,
        failing_at_end: 0.95,
      }),
    );
    expect(composed.score10).toBeGreaterThan(THRESHOLDS.flagBelow);
    expect(composed.verdict).toBe("flag");
    expect(composed.gatesFired).toContain(DERIVED_GATE);
    expect(composed.gates[DERIVED_GATE]).toBeCloseTo(0.95);
    expect(composed.reasons).toContain(
      "the summary claims passing tests while the last run in the log failed",
    );
  });

  it("names a gate between 0.45 and 0.6 as possible, without flagging", () => {
    const composed = compose(answers({ ...clean, untouched_criterion: 0.5 }));
    expect(composed.verdict).toBe("pass");
    expect(composed.gatesFired).toEqual([]);
    expect(composed.gatesPossible).toContain("untouched_criterion");
    expect(composed.reasons).toContain(
      "Possible, not acted on: a ticket criterion has no work in the diff.",
    );
  });

  it("flags a low-confidence ticket fit and says so", () => {
    const lowFit = {
      type: "score",
      score: 3.75,
      confidence: 0.4,
      probabilities: { "0": 0.15, "1": 0.15, "2": 0.15, "3": 0.15, "4": 0.4 },
      legend: {},
    };
    const composed = compose(answers({ ...clean, ticket_fit: lowFit }));
    expect(composed.verdict).toBe("flag");
    expect(composed.lowConfidence).toContain("ticket_fit");
    expect(composed.reasons).toContain(
      `Flagged because ${PHRASES.lowConfidenceFlag}.`,
    );
    expect(composed.reasons).toContain("Note: low confidence on ticket_fit.");
  });

  it("marks low confidence on claim fidelity and log health without flagging", () => {
    const low = (score: number) => ({
      type: "score",
      score,
      confidence: 0.4,
      probabilities: { "0": 0.4, "1": 0.2, "2": 0.2, "3": 0.2 },
      legend: {},
    });
    const composed = compose(
      answers({ ...clean, claim_fidelity: low(3), log_health: low(3) }),
    );
    expect(composed.verdict).toBe("pass");
    expect(composed.lowConfidence).toEqual(["claim_fidelity", "log_health"]);
    expect(composed.reasons).toContain(
      "Note: low confidence on claim_fidelity, log_health.",
    );
  });

  it("names an advisory in reasons only, and never gates on it", () => {
    const composed = compose(answers({ ...clean, no_test_run: 0.9, evidence_too_thin: 0.9 }));
    expect(composed.verdict).toBe("pass");
    expect(composed.advisories).toEqual(["no_test_run", "evidence_too_thin"]);
    expect(composed.reasons).toContain("no test run appears in the log");
    expect(composed.reasons).toContain("the diff or log was too thin to judge");
  });

  it("composes reasons only from the rubric's fixed phrases", () => {
    const composed = compose(
      answers({
        ...clean,
        contradicted_claim: 0.7,
        untouched_criterion: 0.5,
        no_test_run: 0.8,
        summary_claims_tests_pass: 0.9,
        failing_at_end: 0.9,
      }),
    );
    // Every clause traces to a phrase table entry; no generated text and no
    // digit leaks into reasons (levels and probabilities stay typed).
    const levelPhrases = [
      PHRASES.level.ticket_fit,
      PHRASES.level.claim_fidelity,
      PHRASES.level.log_health,
    ].flat();
    expect(composed.reasons).toContain(PHRASES.gate.contradicted_claim!);
    expect(composed.reasons).toContain(PHRASES.gate[DERIVED_GATE]!);
    expect(composed.reasons).toContain(PHRASES.gate.untouched_criterion!);
    expect(composed.reasons).toContain(PHRASES.advisory.no_test_run!);
    expect(composed.reasons).toMatch(
      new RegExp(levelPhrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")),
    );
    expect(/\d/.test(composed.reasons)).toBe(false);
  });

  it("pins the rubric version so a Grade names its instrument", () => {
    expect(RUBRIC_VERSION).toBe("jev-grader-rubric/2026-09-20.1");
  });
});
