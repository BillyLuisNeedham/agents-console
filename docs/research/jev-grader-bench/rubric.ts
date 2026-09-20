/**
 * The Jev grader question set (option C): three narrow Jev Scores, one per
 * dimension of verify.template.md, plus gate Nouls that force `flag`.
 * Throwaway bench copy; the engine version lives in the Console repo later.
 */
import { noul, score, type Questions } from "/home/billy/.herdr/worktrees/agent-console/feature-jev-integration/engine/jev.ts";

export const RUBRIC_VERSION = "jev-grader-rubric/2026-09-20.1";

/**
 * The trust rule, carried inside every question's instructions because Jev
 * does not treat Evidence as hostile and the agent's summary argues for
 * itself. Named Evidence fields make the rule concrete.
 */
const TRUST = {
  evidence: {
    "`ticket`": "the work as specified: goal, scope and acceptance criteria.",
    "`diff`": "the work as done: the unified diff of the Attempt's commit against its base. Absent or trimmed diffs say so in `diff_note`.",
    "`log`": "what actually happened while the Attempt ran: commands, their output, test runs, errors. Usually the tail of a longer log; `log_note` says when it was trimmed.",
    "`agent_summary_claim`": "the agent's own description of its work. This is a claim, not evidence.",
  },
  rule: "The log and the diff are evidence. The summary is a claim. When the summary and the log disagree, the log is right. A confident summary never stands in for a passing run.",
};

export const DIMENSIONS = {
  ticket_fit: {
    weight: 0.4,
    question: score(
      {
        judge: "How far does the work in `diff` satisfy what `ticket` asks for, judged on the diff itself and confirmed by `log`, never on `agent_summary_claim` alone.",
        ...TRUST,
      },
      [
        "No diff, or a diff whose changes have nothing to do with the ticket.",
        "The diff works on the ticket but most of its acceptance criteria are still unmet.",
        "The diff meets some acceptance criteria and leaves at least one criterion plainly unmet or only partly done.",
        "The diff meets every acceptance criterion but also makes substantial changes the ticket never asked for.",
        "The diff meets every acceptance criterion, nothing material is missing, and nothing substantial was added beyond the ticket.",
      ] as const,
    ),
  },
  claim_fidelity: {
    weight: 0.3,
    question: score(
      {
        judge: "How well do `diff` and `log` bear out what `agent_summary_claim` says was done and checked.",
        ...TRUST,
      },
      [
        "The summary claims work or results that the diff and log show did not happen: a change that is not in the diff, or a test result the log contradicts.",
        "The summary overstates: the main change is in the diff, but a named change, check or test run it mentions is missing from the diff and the log.",
        "The summary matches the diff and log in substance; it is vague or leaves out something minor, but nothing it states is contradicted.",
        "Everything the summary states is visible in the diff or the log, including every test or command it says it ran and the result it reports.",
      ] as const,
    ),
  },
  log_health: {
    weight: 0.3,
    question: score(
      {
        judge: "How clean was the run, judged on `log` alone: crashes, stack traces, failed commands, failing tests, and warnings the agent worked around without fixing.",
        ...TRUST,
      },
      [
        "The log ends with a failing test run, a crash, or an error that was never resolved.",
        "The log shows errors or failing commands that the agent worked around, ignored, or silenced without fixing their cause.",
        "The log shows errors that appeared and were then fixed, with a later clean run of the same command or test suite.",
        "The log shows no crashes, no failed commands and no failing tests; every command and test run that appears passed.",
      ] as const,
    ),
  },
} as const;

/** Gate Nouls: any one firing forces `flag`, whatever the weighted score. */
export const GATES = {
  contradicted_claim: noul(
    {
      condition: "`agent_summary_claim` states a result that `log` contradicts. Examples: the summary says tests pass while the last test run in the log shows failures or errors; the summary says a command succeeded while the log shows it failing; the summary says a check was run and the log has no such run.",
      ...TRUST,
    },
    {
      true: "The log contradicts at least one stated result in the summary.",
      false: "Nothing the summary states is contradicted by the log, or the summary makes no checkable claim about results.",
    },
  ),
  untouched_criterion: noul(
    {
      condition: "At least one acceptance criterion listed in `ticket` is not addressed anywhere in `diff`: no change in the diff works towards it.",
      ...TRUST,
    },
    {
      true: "Some acceptance criterion in the ticket has no corresponding work in the diff.",
      false: "Every acceptance criterion in the ticket has at least some work towards it in the diff.",
    },
  ),
  failing_at_end: noul(
    {
      condition: "The last test run or build command visible in `log` reports at least one failure or error.",
      ...TRUST,
    },
    {
      true: "The final test run or build in the log failed, or the log ends in an unresolved error.",
      false: "The final test run or build in the log passed, or no test run or build appears in the log.",
    },
  ),
} as const;

/**
 * Single-hop helper Noul over the summary alone. The docs warn that a
 * question needing two hops (read the claim, then check it against the log)
 * costs accuracy, so the engine also derives the contradiction in code:
 * `summary_claims_tests_pass` AND `failing_at_end` is a contradiction found
 * without asking Jev to compare two fields.
 */
export const HELPERS = {
  summary_claims_tests_pass: noul(
    {
      condition: "`agent_summary_claim` states that tests were run and passed, or that the test suite is green, or gives a passing test count.",
      note: "Judge the summary's wording only; do not check it against the log here.",
    },
    {
      true: "The summary says tests ran and passed.",
      false: "The summary makes no claim that tests passed.",
    },
  ),
} as const;

/** Advisory Nouls: recorded into reasons, never gates. */
export const ADVISORIES = {
  no_test_run: noul(
    {
      condition: "`log` contains no test run at all: no test command was executed during the Attempt.",
      ...TRUST,
    },
    {
      true: "No test command or test output appears anywhere in the log.",
      false: "At least one test run appears in the log.",
    },
  ),
  evidence_too_thin: noul(
    {
      condition: "The Evidence is too thin to grade: `diff` is missing or trimmed to the point that the ticket's criteria cannot be checked against it, or `log` is missing or so short that no command output can be seen.",
      ...TRUST,
    },
    {
      true: "The diff or log is missing or cut down so far that the grade would be a guess.",
      false: "Enough diff and log is present to judge the work.",
    },
  ),
} as const;

export const QUESTIONS = {
  ...Object.fromEntries(Object.entries(DIMENSIONS).map(([k, d]) => [k, d.question])),
  ...GATES,
  ...HELPERS,
  ...ADVISORIES,
} as unknown as {
  [K in keyof typeof DIMENSIONS]: (typeof DIMENSIONS)[K]["question"];
} & typeof GATES & typeof HELPERS & typeof ADVISORIES;

export const THRESHOLDS = {
  /** A weighted 0-10 below this is `flag`. */
  flagBelow: 6.0,
  /** A gate Noul at or above this forces `flag`. */
  gateFires: 0.6,
  /** A dimension confidence below this marks the Grade `low-confidence`. */
  lowConfidence: 0.5,
  /** An advisory Noul at or above this is named in reasons. */
  advisoryFires: 0.6,
} as const;

export type Composed = {
  score10: number;
  verdict: "pass" | "flag";
  gatesFired: string[];
  advisories: string[];
  lowConfidence: string[];
  perDimension: Record<string, { level: number; normalised: number; confidence: number; probabilities: Record<string, number> }>;
  gates: Record<string, number>;
  reasons: string;
};

type Answers = Record<string, any>;

/** Composition in code: normalise by levels-1, weight, gate, then compose reasons from the typed answers only. */
export function compose(answers: Answers): Composed {
  const perDimension: Composed["perDimension"] = {};
  let weighted = 0;
  const lowConfidence: string[] = [];
  for (const [name, dim] of Object.entries(DIMENSIONS)) {
    const a = answers[name];
    const levels = dim.question.criteria.length;
    const normalised = a.score / (levels - 1);
    weighted += dim.weight * normalised;
    perDimension[name] = { level: a.score, normalised, confidence: a.confidence, probabilities: a.probabilities };
    if (a.confidence < THRESHOLDS.lowConfidence) lowConfidence.push(name);
  }
  const score10 = Math.round(weighted * 10 * 10) / 10;
  const gates: Record<string, number> = {};
  const gatesFired: string[] = [];
  for (const name of Object.keys(GATES)) {
    gates[name] = answers[name].noul;
    if (answers[name].noul >= THRESHOLDS.gateFires) gatesFired.push(name);
  }
  // Derived gate, in code: a passing-tests claim beside a failing final run.
  const claimsPass = answers.summary_claims_tests_pass.noul;
  gates["derived_claim_vs_failing_end"] = Math.min(claimsPass, answers.failing_at_end.noul);
  if (claimsPass >= THRESHOLDS.gateFires && answers.failing_at_end.noul >= THRESHOLDS.gateFires && !gatesFired.includes("contradicted_claim")) {
    gatesFired.push("derived_claim_vs_failing_end");
  }
  const advisories: string[] = [];
  for (const name of Object.keys(ADVISORIES)) {
    if (answers[name].noul >= THRESHOLDS.advisoryFires) advisories.push(name);
  }
  const verdict: Composed["verdict"] = gatesFired.length > 0 || score10 < THRESHOLDS.flagBelow ? "flag" : "pass";
  return { score10, verdict, gatesFired, advisories, lowConfidence, perDimension, gates, reasons: reasonsFor({ score10, verdict, gatesFired, advisories, lowConfidence, perDimension, gates }) };
}

const LEVEL_PHRASE: Record<string, string[]> = {
  ticket_fit: ["nothing of the ticket is done", "most criteria unmet", "some criteria unmet", "all criteria met with extra scope", "all criteria met"],
  claim_fidelity: ["summary contradicted by the artifacts", "summary overstates the work", "summary broadly matches", "summary fully borne out"],
  log_health: ["run ends in failure", "errors worked around, not fixed", "errors fixed, later run clean", "clean run"],
};
const GATE_PHRASE: Record<string, string> = {
  contradicted_claim: "the log contradicts a result the summary claims",
  untouched_criterion: "a ticket criterion has no work in the diff",
  failing_at_end: "the last test run or build in the log failed",
  derived_claim_vs_failing_end: "the summary claims passing tests while the last run in the log failed",
};
const ADVISORY_PHRASE: Record<string, string> = {
  no_test_run: "no test run appears in the log",
  evidence_too_thin: "the diff or log was too thin to judge",
};

/** `reasons` is composed from typed answers; Jev never wrote a word of it. */
function reasonsFor(c: Omit<Composed, "reasons">): string {
  const parts: string[] = [];
  const dims = Object.entries(c.perDimension).map(([name, d]) => {
    const phrase = LEVEL_PHRASE[name]![Math.round(d.level)] ?? `level ${d.level.toFixed(1)}`;
    return `${name.replace("_", " ")}: ${phrase}`;
  });
  parts.push(dims.join("; ") + ".");
  if (c.gatesFired.length) parts.push("Flagged because " + c.gatesFired.map((g) => GATE_PHRASE[g]).join(" and ") + ".");
  else if (c.verdict === "flag") parts.push("Flagged on the weighted score alone.");
  const notes = [...c.advisories.map((a) => ADVISORY_PHRASE[a]), ...(c.lowConfidence.length ? [`low confidence on ${c.lowConfidence.join(", ")}`] : [])];
  if (notes.length) parts.push("Note: " + notes.join("; ") + ".");
  return parts.join(" ");
}
