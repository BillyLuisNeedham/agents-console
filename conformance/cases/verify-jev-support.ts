/**
 * What the Jev verify cases (C22 of the Rust port's inventory,
 * docs/research/rust-port/test-inventory.md) share. Each server holds a
 * TypeSafe key and points JEV_BASE_URL at the Jev fake
 * (conformance/fixtures/jev-fake.ts), so what Jev answers is scripted by
 * the case and what the server asked is read back from the fake: the
 * Evidence it built and the rubric's questions, the ADR-0023 instrument.
 * Every Attempt and grader is the claude stub on PATH.
 */

import { expect } from "bun:test";
import type { PoolConfig, TicketEvent } from "../../engine/wire.ts";
import type { FakeJevRequest, ScriptedAnswer } from "../fixtures/jev-fake.ts";
import { readEvents } from "../harness/pool-files.ts";
import { snapshot, settle } from "../harness/pool-run.ts";
import type { CaseServer } from "../harness/case.ts";
import type { TicketSeed, World } from "../harness/world.ts";
import { DEFAULTS, ready } from "./verify-common.ts";

/** The rubric version every Jev Grade records. */
export const RUBRIC = "jev-grader-rubric/2026-09-20.1";

/**
 * A clean pass for every rubric question: each dimension at its top level
 * and every gate, helper and advisory quiet. An unscripted Noul would get
 * the fake's uniform 0.5, which the rubric names as possible.
 */
export const CLEAN: Record<string, ScriptedAnswer> = {
  ticket_fit: 4,
  claim_fidelity: 3,
  log_health: 3,
  contradicted_claim: 0.1,
  untouched_criterion: 0.1,
  failing_at_end: 0.1,
  summary_claims_tests_pass: 0.1,
  no_test_run: 0.1,
  evidence_too_thin: 0.1,
};

/**
 * A Score answer with its expected level and confidence chosen outright,
 * not spread from a scripted level: the API's full answer shape, so the
 * server's own checks accept it.
 */
export function scoreAnswer(score: number, confidence = 0.9): Record<string, unknown> {
  return {
    type: "score",
    score,
    confidence,
    probabilities: { [String(Math.round(score))]: confidence },
    legend: {},
  };
}

/** The Evidence object one request carried as `state`. */
export interface Evidence {
  ticket: string;
  agent_summary_claim: string;
  diff: string;
  diff_note: string;
  log: string;
  log_note: string;
}

export function evidenceOf(request: FakeJevRequest): Evidence {
  return request.body.state as Evidence;
}

/** The Ticket id an Evidence's Ticket text names in its state marker. */
export function ticketIdOf(state: unknown): string {
  const ticket = (state as Partial<Evidence> | null)?.ticket ?? "";
  return /id=(\S+)/.exec(ticket)?.[1] ?? "";
}

/** The Attempt an Evidence is for, by the summary the stub writes, `summary-<id>.attempt-<n>`. */
export function attemptOf(state: unknown): number {
  const summary = (state as Partial<Evidence> | null)?.agent_summary_claim ?? "";
  return Number(/\.attempt-(\d+)$/.exec(summary)?.[1] ?? 0);
}

/** console.json with `verify: n` on each Ticket given. */
export function verifyEach(ids: string[], n = 1): PoolConfig {
  return { ...DEFAULTS, assign: Object.fromEntries(ids.map((id) => [id, { verify: n }])) };
}

/** Tickets run one after another: each waits for the one before it. */
export function chain(ids: string[]): TicketSeed[] {
  return ids.map((id, i) => ready(id, i === 0 ? "none" : ids[i - 1]));
}

/** A Ticket's graded events, by attempt. */
export function gradedEvents(world: World, id: string): TicketEvent[] {
  return readEvents(world.pool, id)
    .filter((e) => e.kind === "graded")
    .sort((a, b) => a.attempt - b.attempt);
}

/** The pool log the snapshot carries now. */
export async function poolLog(server: CaseServer): Promise<string[]> {
  return (await snapshot(server)).state.log;
}

/** The pool log's Jev lines: the boot line and the notices, never a Ticket's own lines. */
export function jevLines(log: string[]): string[] {
  return log.filter((line) => line.startsWith("Jev"));
}

/** The pool log's line for a cause the first time it makes an ask fall back. */
export function unavailable(cause: string, detail: string): string {
  return `Jev unavailable (${cause}: ${detail}); heuristics until it answers`;
}

/** The pool log's line for a round that falls back, naming the Attempt whose ask failed. */
export function couldNotGrade(id: string, attempt: number, cause: string, detail: string): string {
  return `ticket ${id}: Jev could not grade attempt ${attempt} (${cause}: ${detail}); falling back to grader tickets`;
}

/** The grade a grader stub writes when nothing scripts it. */
export const DEFAULT_GRADE = { score: 8, verdict: "pass", reasons: "default grade" };

/**
 * Wait for the run to rest with every Ticket done and the final Review
 * raised. A run that falls back to grader Tickets, or runs Tickets one
 * after another, takes a while on a loaded machine.
 */
export function settleOnReview(server: CaseServer, ms = 60_000) {
  return settle(server, (snap) => snap.state.interrupts.some((i) => i.ticketId === "REVIEW"), {
    ms,
    what: "the final Review",
  });
}

/**
 * The round fell back to one grader Ticket for Ticket 01's lone Attempt:
 * the grader's file was written and launched once, and its Grade, with no
 * provenance, is the one that landed.
 */
export function expectGraderFallback(world: World): void {
  expect(world.stubs.calls().filter((call) => call.key === "01-grader-1")).toHaveLength(1);
  expect(gradedEvents(world, "01").map((e) => e.payload)).toEqual([DEFAULT_GRADE]);
}

/** A local port nobody listens on, for a JEV_BASE_URL that cannot connect. */
export async function deadPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  return port!;
}

const TRUST = {
  evidence: {
    "`ticket`": "the work as specified: goal, scope and acceptance criteria.",
    "`diff`":
      "the work as done: the unified diff of the Attempt's commit against its base. Absent or trimmed diffs say so in `diff_note`.",
    "`log`":
      "what actually happened while the Attempt ran: commands, their output, test runs, errors. Usually the tail of a longer log; `log_note` says when it was trimmed.",
    "`agent_summary_claim`": "the agent's own description of its work. This is a claim, not evidence.",
  },
  rule: "The log and the diff are evidence. The summary is a claim. When the summary and the log disagree, the log is right. A confident summary never stands in for a passing run.",
};

/**
 * Every question the server asks Jev of one Attempt, in one request, as
 * the API receives them: three Scores, three gate Nouls, the helper Noul
 * the derived gate is built from, and two advisories. The wording is the
 * benched rubric's, so it is pinned word for word (Decided 4): a reworded
 * question changes the scores Jev gives without failing anything else.
 */
export const RUBRIC_QUESTIONS = {
  ticket_fit: {
    type: "score",
    instructions: {
      judge:
        "How far does the work in `diff` satisfy what `ticket` asks for, judged on the diff itself and confirmed by `log`, never on `agent_summary_claim` alone.",
      ...TRUST,
    },
    criteria: [
      "No diff, or a diff whose changes have nothing to do with the ticket.",
      "The diff works on the ticket but most of its acceptance criteria are still unmet.",
      "The diff meets some acceptance criteria and leaves at least one criterion plainly unmet or only partly done.",
      "The diff meets every acceptance criterion but also makes substantial changes the ticket never asked for.",
      "The diff meets every acceptance criterion, nothing material is missing, and nothing substantial was added beyond the ticket.",
    ],
  },
  claim_fidelity: {
    type: "score",
    instructions: {
      judge: "How well do `diff` and `log` bear out what `agent_summary_claim` says was done and checked.",
      ...TRUST,
    },
    criteria: [
      "The summary claims work or results that the diff and log show did not happen: a change that is not in the diff, or a test result the log contradicts.",
      "The summary overstates: the main change is in the diff, but a named change, check or test run it mentions is missing from the diff and the log.",
      "The summary matches the diff and log in substance; it is vague or leaves out something minor, but nothing it states is contradicted.",
      "Everything the summary states is visible in the diff or the log, including every test or command it says it ran and the result it reports.",
    ],
  },
  log_health: {
    type: "score",
    instructions: {
      judge:
        "How clean was the run, judged on `log` alone: crashes, stack traces, failed commands, failing tests, and warnings the agent worked around without fixing.",
      ...TRUST,
    },
    criteria: [
      "The log ends with a failing test run, a crash, or an error that was never resolved.",
      "The log shows errors or failing commands that the agent worked around, ignored, or silenced without fixing their cause.",
      "The log shows errors that appeared and were then fixed, with a later clean run of the same command or test suite.",
      "The log shows no crashes, no failed commands and no failing tests; every command and test run that appears passed.",
    ],
  },
  contradicted_claim: {
    type: "noul",
    instructions: {
      condition:
        "`agent_summary_claim` states a result that `log` contradicts. Examples: the summary says tests pass while the last test run in the log shows failures or errors; the summary says a command succeeded while the log shows it failing; the summary says a check was run and the log has no such run.",
      ...TRUST,
    },
    criteria: {
      true: "The log contradicts at least one stated result in the summary.",
      false: "Nothing the summary states is contradicted by the log, or the summary makes no checkable claim about results.",
    },
  },
  untouched_criterion: {
    type: "noul",
    instructions: {
      condition:
        "At least one acceptance criterion listed in `ticket` is not addressed anywhere in `diff`: no change in the diff works towards it.",
      ...TRUST,
    },
    criteria: {
      true: "Some acceptance criterion in the ticket has no corresponding work in the diff.",
      false: "Every acceptance criterion in the ticket has at least some work towards it in the diff.",
    },
  },
  failing_at_end: {
    type: "noul",
    instructions: {
      condition: "The last test run or build command visible in `log` reports at least one failure or error.",
      ...TRUST,
    },
    criteria: {
      true: "The final test run or build in the log failed, or the log ends in an unresolved error.",
      false: "The final test run or build in the log passed, or no test run or build appears in the log.",
    },
  },
  summary_claims_tests_pass: {
    type: "noul",
    instructions: {
      condition:
        "`agent_summary_claim` states that tests were run and passed, or that the test suite is green, or gives a passing test count.",
      note: "Judge the summary's wording only; do not check it against the log here.",
    },
    criteria: {
      true: "The summary says tests ran and passed.",
      false: "The summary makes no claim that tests passed.",
    },
  },
  no_test_run: {
    type: "noul",
    instructions: {
      condition: "`log` contains no test run at all: no test command was executed during the Attempt.",
      ...TRUST,
    },
    criteria: {
      true: "No test command or test output appears anywhere in the log.",
      false: "At least one test run appears in the log.",
    },
  },
  evidence_too_thin: {
    type: "noul",
    instructions: {
      condition:
        "The Evidence is too thin to grade: `diff` is missing or trimmed to the point that the ticket's criteria cannot be checked against it, or `log` is missing or so short that no command output can be seen.",
      ...TRUST,
    },
    criteria: {
      true: "The diff or log is missing or cut down so far that the grade would be a guess.",
      false: "Enough diff and log is present to judge the work.",
    },
  },
};
