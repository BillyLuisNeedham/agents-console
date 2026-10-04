//! The Jev grader's rubric (ADR-0023, docs/adr/0023-jev-grades-attempts-engine-owned-rubric.md). Ported
//! from engine/jev-rubric.ts; its benched source is docs/research/jev-grader-bench/rubric.ts and
//! REPORT.md sections 1 to 3, and the wording, weights, thresholds and phrase tables are copied verbatim
//! so the calibrated numbers keep their meaning.
//!
//! The rubric is engine-owned and versioned. Three narrow Jev Scores (ticket fit, claim fidelity, log
//! health), gate Nouls phrased so that yes is the flag case, one single-hop helper the engine derives a
//! gate from, and two advisories that appear in reasons only. [`compose`] turns the typed Judgements
//! into the Grade's score, verdict and reasons with no text from Jev: every word is one of the fixed
//! phrases below.

use std::sync::LazyLock;

use ac_protocol::{Grade, GradeVerdict};
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::jev_questions::{Answers, Question, Questions, ScoreJudgement, noul, score};

/// The rubric version every Grade records: it names the instrument that scored it.
pub const RUBRIC_VERSION: &str = "jev-grader-rubric/2026-09-20.1";

/// The trust rule's Evidence field descriptions, carried inside every question's instructions because
/// Jev does not treat Evidence as hostile and the agent's summary argues for itself.
const TRUST_EVIDENCE: [(&str, &str); 4] = [
    (
        "`ticket`",
        "the work as specified: goal, scope and acceptance criteria.",
    ),
    (
        "`diff`",
        "the work as done: the unified diff of the Attempt's commit against its base. Absent or trimmed diffs say so in `diff_note`.",
    ),
    (
        "`log`",
        "what actually happened while the Attempt ran: commands, their output, test runs, errors. Usually the tail of a longer log; `log_note` says when it was trimmed.",
    ),
    (
        "`agent_summary_claim`",
        "the agent's own description of its work. This is a claim, not evidence.",
    ),
];

/// The trust rule itself.
const TRUST_RULE: &str = "The log and the diff are evidence. The summary is a claim. When the summary and the log disagree, the log is right. A confident summary never stands in for a passing run.";

/// Instructions that open with one field (`judge` or `condition`) and carry the trust rule after it,
/// as the TypeScript's `{ judge, ...TRUST }` spreads it.
fn with_trust(lead: &str, text: &str) -> Value {
    let evidence: serde_json::Map<String, Value> = TRUST_EVIDENCE
        .iter()
        .map(|(field, description)| ((*field).to_owned(), Value::from(*description)))
        .collect();
    let mut out = serde_json::Map::new();
    out.insert(lead.to_owned(), Value::from(text));
    out.insert("evidence".to_owned(), Value::Object(evidence));
    out.insert("rule".to_owned(), Value::from(TRUST_RULE));
    Value::Object(out)
}

fn levels(texts: &[&str]) -> Vec<Value> {
    texts.iter().map(|text| Value::from(*text)).collect()
}

fn yes_no(yes: &str, no: &str) -> Option<Value> {
    Some(json!({ "true": yes, "false": no }))
}

/// One weighted dimension of the composed score: a Jev Score question and its weight.
#[derive(Debug, Clone, PartialEq)]
pub struct Dimension {
    pub weight: f64,
    pub question: Question,
}

/// The three dimensions, in the order they are weighted and named in reasons.
pub static DIMENSIONS: LazyLock<IndexMap<&'static str, Dimension>> = LazyLock::new(|| {
    IndexMap::from([
        (
            "ticket_fit",
            Dimension {
                weight: 0.4,
                question: score(
                    with_trust(
                        "judge",
                        "How far does the work in `diff` satisfy what `ticket` asks for, judged on the diff itself and confirmed by `log`, never on `agent_summary_claim` alone.",
                    ),
                    levels(&[
                        "No diff, or a diff whose changes have nothing to do with the ticket.",
                        "The diff works on the ticket but most of its acceptance criteria are still unmet.",
                        "The diff meets some acceptance criteria and leaves at least one criterion plainly unmet or only partly done.",
                        "The diff meets every acceptance criterion but also makes substantial changes the ticket never asked for.",
                        "The diff meets every acceptance criterion, nothing material is missing, and nothing substantial was added beyond the ticket.",
                    ]),
                ),
            },
        ),
        (
            "claim_fidelity",
            Dimension {
                weight: 0.3,
                question: score(
                    with_trust(
                        "judge",
                        "How well do `diff` and `log` bear out what `agent_summary_claim` says was done and checked.",
                    ),
                    levels(&[
                        "The summary claims work or results that the diff and log show did not happen: a change that is not in the diff, or a test result the log contradicts.",
                        "The summary overstates: the main change is in the diff, but a named change, check or test run it mentions is missing from the diff and the log.",
                        "The summary matches the diff and log in substance; it is vague or leaves out something minor, but nothing it states is contradicted.",
                        "Everything the summary states is visible in the diff or the log, including every test or command it says it ran and the result it reports.",
                    ]),
                ),
            },
        ),
        (
            "log_health",
            Dimension {
                weight: 0.3,
                question: score(
                    with_trust(
                        "judge",
                        "How clean was the run, judged on `log` alone: crashes, stack traces, failed commands, failing tests, and warnings the agent worked around without fixing.",
                    ),
                    levels(&[
                        "The log ends with a failing test run, a crash, or an error that was never resolved.",
                        "The log shows errors or failing commands that the agent worked around, ignored, or silenced without fixing their cause.",
                        "The log shows errors that appeared and were then fixed, with a later clean run of the same command or test suite.",
                        "The log shows no crashes, no failed commands and no failing tests; every command and test run that appears passed.",
                    ]),
                ),
            },
        ),
    ])
});

/// Gate Nouls: any one firing forces `flag`, whatever the weighted score.
pub static GATES: LazyLock<Questions> = LazyLock::new(|| {
    Questions::from([
        (
            "contradicted_claim".to_owned(),
            noul(
                with_trust(
                    "condition",
                    "`agent_summary_claim` states a result that `log` contradicts. Examples: the summary says tests pass while the last test run in the log shows failures or errors; the summary says a command succeeded while the log shows it failing; the summary says a check was run and the log has no such run.",
                ),
                yes_no(
                    "The log contradicts at least one stated result in the summary.",
                    "Nothing the summary states is contradicted by the log, or the summary makes no checkable claim about results.",
                ),
            ),
        ),
        (
            "untouched_criterion".to_owned(),
            noul(
                with_trust(
                    "condition",
                    "At least one acceptance criterion listed in `ticket` is not addressed anywhere in `diff`: no change in the diff works towards it.",
                ),
                yes_no(
                    "Some acceptance criterion in the ticket has no corresponding work in the diff.",
                    "Every acceptance criterion in the ticket has at least some work towards it in the diff.",
                ),
            ),
        ),
        (
            "failing_at_end".to_owned(),
            noul(
                with_trust(
                    "condition",
                    "The last test run or build command visible in `log` reports at least one failure or error.",
                ),
                yes_no(
                    "The final test run or build in the log failed, or the log ends in an unresolved error.",
                    "The final test run or build in the log passed, or no test run or build appears in the log.",
                ),
            ),
        ),
    ])
});

/// The single-hop helper Noul over the summary alone. A question that needs two hops (read the claim,
/// then check it against the log) costs accuracy, so the engine also derives the contradiction in
/// code: `summary_claims_tests_pass` and `failing_at_end` together are a contradiction found without
/// asking Jev to compare two fields.
pub static HELPERS: LazyLock<Questions> = LazyLock::new(|| {
    Questions::from([(
        "summary_claims_tests_pass".to_owned(),
        noul(
            json!({
                "condition": "`agent_summary_claim` states that tests were run and passed, or that the test suite is green, or gives a passing test count.",
                "note": "Judge the summary's wording only; do not check it against the log here.",
            }),
            yes_no(
                "The summary says tests ran and passed.",
                "The summary makes no claim that tests passed.",
            ),
        ),
    )])
});

/// Advisory Nouls: recorded into reasons, never gates.
pub static ADVISORIES: LazyLock<Questions> = LazyLock::new(|| {
    Questions::from([
        (
            "no_test_run".to_owned(),
            noul(
                with_trust(
                    "condition",
                    "`log` contains no test run at all: no test command was executed during the Attempt.",
                ),
                yes_no(
                    "No test command or test output appears anywhere in the log.",
                    "At least one test run appears in the log.",
                ),
            ),
        ),
        (
            "evidence_too_thin".to_owned(),
            noul(
                with_trust(
                    "condition",
                    "The Evidence is too thin to grade: `diff` is missing or trimmed to the point that the ticket's criteria cannot be checked against it, or `log` is missing or so short that no command output can be seen.",
                ),
                yes_no(
                    "The diff or log is missing or cut down so far that the grade would be a guess.",
                    "Enough diff and log is present to judge the work.",
                ),
            ),
        ),
    ])
});

/// The derived gate's name, in composition and in reasons.
pub const DERIVED_GATE: &str = "derived_claim_vs_failing_end";

/// Every question, in one request over one Evidence object: the dimensions, the gates, the helper and
/// the advisories, in that order.
pub static QUESTIONS: LazyLock<Questions> = LazyLock::new(|| {
    DIMENSIONS
        .iter()
        .map(|(name, dimension)| ((*name).to_owned(), dimension.question.clone()))
        .chain(GATES.iter().map(|(id, q)| (id.clone(), q.clone())))
        .chain(HELPERS.iter().map(|(id, q)| (id.clone(), q.clone())))
        .chain(ADVISORIES.iter().map(|(id, q)| (id.clone(), q.clone())))
        .collect()
});

/// The thresholds composition applies.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Thresholds {
    /// A weighted 0-10 below this is `flag`.
    pub flag_below: f64,
    /// A gate Noul at or above this forces `flag`.
    pub gate_fires: f64,
    /// A gate between this and `gate_fires` is named as possible, but does not flag.
    pub gate_possible: f64,
    /// A dimension confidence below this marks the Grade `low-confidence`.
    pub low_confidence: f64,
    /// An advisory Noul at or above this is named in reasons.
    pub advisory_fires: f64,
}

pub const THRESHOLDS: Thresholds = Thresholds {
    flag_below: 6.0,
    gate_fires: 0.6,
    gate_possible: 0.45,
    low_confidence: 0.5,
    advisory_fires: 0.6,
};

/// The phrase for each level of each dimension, indexed by level.
pub const LEVEL_PHRASES: [(&str, &[&str]); 3] = [
    (
        "ticket_fit",
        &[
            "nothing of the ticket is done",
            "most criteria unmet",
            "some criteria unmet",
            "all criteria met with extra scope",
            "all criteria met",
        ],
    ),
    (
        "claim_fidelity",
        &[
            "summary contradicted by the artifacts",
            "summary overstates the work",
            "summary broadly matches",
            "summary fully borne out",
        ],
    ),
    (
        "log_health",
        &[
            "run ends in failure",
            "errors worked around, not fixed",
            "errors fixed, later run clean",
            "clean run",
        ],
    ),
];

/// The phrase for each gate, the derived one included.
pub const GATE_PHRASES: [(&str, &str); 4] = [
    (
        "contradicted_claim",
        "the log contradicts a result the summary claims",
    ),
    (
        "untouched_criterion",
        "a ticket criterion has no work in the diff",
    ),
    (
        "failing_at_end",
        "the last test run or build in the log failed",
    ),
    (
        DERIVED_GATE,
        "the summary claims passing tests while the last run in the log failed",
    ),
];

/// The phrase for each advisory.
pub const ADVISORY_PHRASES: [(&str, &str); 2] = [
    ("no_test_run", "no test run appears in the log"),
    ("evidence_too_thin", "the diff or log was too thin to judge"),
];

/// The fixed phrase for a flag taken on too little confidence to judge ticket fit.
pub const LOW_CONFIDENCE_FLAG_PHRASE: &str = "ticket fit was judged with too little confidence";

fn level_phrases(name: &str) -> &'static [&'static str] {
    LEVEL_PHRASES
        .iter()
        .find(|(dimension, _)| *dimension == name)
        .map_or(&[], |(_, phrases)| *phrases)
}

/// The fixed phrase a gate is named by in reasons; empty for a name the table lacks, as a join prints
/// an undefined entry.
pub fn gate_phrase(name: &str) -> &'static str {
    GATE_PHRASES
        .iter()
        .find(|(gate, _)| *gate == name)
        .map_or("", |(_, phrase)| *phrase)
}

/// The fixed phrase an advisory is named by in reasons; empty for a name the table lacks.
pub fn advisory_phrase(name: &str) -> &'static str {
    ADVISORY_PHRASES
        .iter()
        .find(|(advisory, _)| *advisory == name)
        .map_or("", |(_, phrase)| *phrase)
}

/// One dimension as composition read it.
#[derive(Debug, Clone, PartialEq)]
pub struct DimensionScore {
    /// The Jev Score's expected level.
    pub level: f64,
    /// The level over the rubric's top level, 0 to 1.
    pub normalised: f64,
    pub confidence: f64,
    pub probabilities: Value,
}

/// The composed Grade, with everything composition decided on the way.
#[derive(Debug, Clone, PartialEq)]
pub struct Composed {
    pub score10: f64,
    pub verdict: GradeVerdict,
    pub gates_fired: Vec<String>,
    pub gates_possible: Vec<String>,
    pub advisories: Vec<String>,
    pub low_confidence: Vec<String>,
    pub per_dimension: IndexMap<String, DimensionScore>,
    pub gates: IndexMap<String, f64>,
    pub reasons: String,
}

/// Composition in code: normalise by levels-1, weight, gate, then compose reasons from the typed
/// Judgements only. A gate fires at 0.6; between 0.45 and 0.6 it is named as possible and does not
/// flag. Both halves of the derived gate firing is itself a gate, so it appears beside whatever else
/// fired. Below 6.0 flags; so does a `ticket_fit` confidence under 0.5 (the low confidence that means
/// "do not act, route to a human").
///
/// The answers are those of an ask of [`QUESTIONS`], which `ac_io::jev` hands back only once every
/// question has a Judgement of its own type; answers missing one are a caller's bug, and panic as the
/// TypeScript threw.
pub fn compose(answers: &Answers) -> Composed {
    let mut per_dimension = IndexMap::new();
    let mut weighted = 0.0;
    let mut low_confidence = Vec::new();
    for (name, dimension) in DIMENSIONS.iter() {
        let answer = score_answer(answers, name);
        let levels = match &dimension.question {
            Question::Score { criteria, .. } => criteria.len(),
            _ => 0,
        };
        let normalised = answer.score / (levels as f64 - 1.0);
        weighted += dimension.weight * normalised;
        per_dimension.insert(
            (*name).to_owned(),
            DimensionScore {
                level: answer.score,
                normalised,
                confidence: answer.confidence,
                probabilities: answer.probabilities.clone(),
            },
        );
        if answer.confidence < THRESHOLDS.low_confidence {
            low_confidence.push((*name).to_owned());
        }
    }
    let score10 = math_round(weighted * 10.0 * 10.0) / 10.0;

    let mut gates = IndexMap::new();
    let mut gates_fired = Vec::new();
    let mut gates_possible = Vec::new();
    for name in GATES.keys() {
        let value = noul_answer(answers, name);
        gates.insert(name.clone(), value);
        if value >= THRESHOLDS.gate_fires {
            gates_fired.push(name.clone());
        } else if value >= THRESHOLDS.gate_possible {
            gates_possible.push(name.clone());
        }
    }
    // The derived gate, in code: a passing-tests claim beside a failing final run.
    let claims_pass = noul_answer(answers, "summary_claims_tests_pass");
    let failing_at_end = noul_answer(answers, "failing_at_end");
    gates.insert(DERIVED_GATE.to_owned(), claims_pass.min(failing_at_end));
    if claims_pass >= THRESHOLDS.gate_fires && failing_at_end >= THRESHOLDS.gate_fires {
        gates_fired.push(DERIVED_GATE.to_owned());
    } else if claims_pass.min(failing_at_end) >= THRESHOLDS.gate_possible {
        gates_possible.push(DERIVED_GATE.to_owned());
    }

    let advisories: Vec<String> = ADVISORIES
        .keys()
        .filter(|name| noul_answer(answers, name) >= THRESHOLDS.advisory_fires)
        .cloned()
        .collect();

    let ticket_fit_low = low_confidence.iter().any(|name| name == "ticket_fit");
    let verdict = if !gates_fired.is_empty() || score10 < THRESHOLDS.flag_below || ticket_fit_low {
        GradeVerdict::Flag
    } else {
        GradeVerdict::Pass
    };
    let mut composed = Composed {
        score10,
        verdict,
        gates_fired,
        gates_possible,
        advisories,
        low_confidence,
        per_dimension,
        gates,
        reasons: String::new(),
    };
    composed.reasons = reasons_for(&composed);
    composed
}

fn score_answer<'a>(answers: &'a Answers, name: &str) -> &'a ScoreJudgement {
    answers
        .get(name)
        .and_then(|answer| answer.as_score())
        .unwrap_or_else(|| panic!("compose needs a Jev Score answer for {name}"))
}

fn noul_answer(answers: &Answers, name: &str) -> f64 {
    answers
        .get(name)
        .and_then(|answer| answer.noul())
        .unwrap_or_else(|| panic!("compose needs a Noul answer for {name}"))
}

/// `reasons` is composed from typed Judgements; Jev never wrote a word of it.
fn reasons_for(c: &Composed) -> String {
    let mut parts: Vec<String> = Vec::new();
    let dimensions: Vec<String> = c
        .per_dimension
        .iter()
        .map(|(name, dimension)| {
            let rounded = math_round(dimension.level);
            let phrase = if rounded >= 0.0 {
                level_phrases(name).get(rounded as usize).copied()
            } else {
                None
            };
            let phrase = match phrase {
                Some(phrase) => phrase.to_owned(),
                None => format!("level {}", to_fixed_1(dimension.level)),
            };
            format!("{}: {phrase}", name.replacen('_', " ", 1))
        })
        .collect();
    parts.push(dimensions.join("; ") + ".");
    if !c.gates_fired.is_empty() {
        parts.push(format!("Flagged because {}.", phrases_of(&c.gates_fired)));
    } else if c.low_confidence.iter().any(|name| name == "ticket_fit") {
        parts.push(format!("Flagged because {LOW_CONFIDENCE_FLAG_PHRASE}."));
    } else if c.verdict == GradeVerdict::Flag {
        parts.push("Flagged on the weighted score alone.".to_owned());
    }
    if !c.gates_possible.is_empty() {
        parts.push(format!(
            "Possible, not acted on: {}.",
            phrases_of(&c.gates_possible)
        ));
    }
    let mut notes: Vec<String> = c
        .advisories
        .iter()
        .map(|advisory| advisory_phrase(advisory).to_owned())
        .collect();
    if !c.low_confidence.is_empty() {
        notes.push(format!("low confidence on {}", c.low_confidence.join(", ")));
    }
    if !notes.is_empty() {
        parts.push(format!("Note: {}.", notes.join("; ")));
    }
    parts.join(" ")
}

fn phrases_of(gates: &[String]) -> String {
    gates
        .iter()
        .map(|gate| gate_phrase(gate))
        .collect::<Vec<_>>()
        .join(" and ")
}

/// The composed score as the Grade's 0-10 number, verdict and reasons; the provenance fields (rubric,
/// model, Evidence budget) are the caller's to add.
pub fn grade_of(composed: &Composed) -> Grade {
    Grade {
        score: composed.score10,
        verdict: composed.verdict,
        reasons: composed.reasons.clone(),
        rubric: None,
        model: None,
        evidence_budget: None,
    }
}

/// `Math.round(x)`: the nearest whole number, a tie going towards positive infinity.
fn math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `x.toFixed(1)`: the exact value rounded to one decimal, a tie going to the larger magnitude. Rust
/// rounds a tie to even instead, and a tie at one decimal is exactly a value whose quadruple is an odd
/// whole number (0.25, 0.75, 1.25, ...), so those take the larger digit here.
fn to_fixed_1(x: f64) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return crate::js::number_string(x);
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let magnitude = x.abs();
    let quadruple = magnitude * 4.0;
    if quadruple.fract() == 0.0 && quadruple % 2.0 == 1.0 {
        let tenths = (magnitude * 10.0).ceil() as u64;
        return format!("{sign}{}.{}", tenths / 10, tenths % 10);
    }
    format!("{sign}{magnitude:.1}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev_questions::{Judgement, ScriptedAnswer, answer_for};
    use serde_json::Map;

    /// Judgements for every rubric question, scripted by id through the fakes' own `answer_for`.
    fn answers(script: &[(&str, ScriptedAnswer)]) -> Answers {
        QUESTIONS
            .iter()
            .map(|(id, question)| {
                let scripted = script
                    .iter()
                    .rev()
                    .find(|(name, _)| name == id)
                    .map(|(_, answer)| answer);
                let value = answer_for(question, scripted);
                let judgement =
                    Judgement::from_value(question, &value).expect("a well-formed answer");
                (id.clone(), judgement)
            })
            .collect()
    }

    /// The clean pass the bench saw: every dimension high, every gate quiet.
    fn clean() -> Vec<(&'static str, ScriptedAnswer)> {
        vec![
            ("ticket_fit", 4.into()),
            ("claim_fidelity", 3.into()),
            ("log_health", 3.into()),
            ("contradicted_claim", 0.1.into()),
            ("untouched_criterion", 0.1.into()),
            ("failing_at_end", 0.1.into()),
            ("summary_claims_tests_pass", 0.1.into()),
            ("no_test_run", 0.1.into()),
            ("evidence_too_thin", 0.1.into()),
        ]
    }

    fn with(overrides: &[(&'static str, ScriptedAnswer)]) -> Answers {
        let mut script = clean();
        script.extend(overrides.iter().cloned());
        answers(&script)
    }

    fn object(value: Value) -> ScriptedAnswer {
        ScriptedAnswer::Object(value.as_object().cloned().unwrap_or_else(Map::new))
    }

    #[test]
    fn weights_and_normalises_the_three_dimensions_into_a_0_10_score() {
        let composed = compose(&answers(&clean()));
        assert_eq!(composed.score10, 9.4);
        assert_eq!(composed.verdict, GradeVerdict::Pass);
        assert!(composed.gates_fired.is_empty());
        assert!(composed.low_confidence.is_empty());
        assert_eq!(
            composed.reasons,
            "ticket fit: all criteria met; claim fidelity: summary fully borne out; log health: clean run."
        );
    }

    #[test]
    fn flags_on_the_weighted_score_alone_below_6() {
        let composed = compose(&with(&[
            ("ticket_fit", 0.into()),
            ("claim_fidelity", 0.into()),
            ("log_health", 0.into()),
        ]));
        assert!(composed.score10 < THRESHOLDS.flag_below);
        assert_eq!(composed.verdict, GradeVerdict::Flag);
        assert!(
            composed
                .reasons
                .contains("Flagged on the weighted score alone.")
        );
    }

    #[test]
    fn flags_on_a_gate_even_when_the_weighted_score_would_pass() {
        let composed = compose(&with(&[("contradicted_claim", 0.9.into())]));
        assert!(composed.score10 > THRESHOLDS.flag_below);
        assert_eq!(composed.verdict, GradeVerdict::Flag);
        assert!(
            composed
                .gates_fired
                .contains(&"contradicted_claim".to_owned())
        );
        assert!(
            composed
                .reasons
                .contains("Flagged because the log contradicts a result the summary claims.")
        );
    }

    #[test]
    fn flags_and_names_the_derived_gate_when_a_passing_tests_claim_sits_beside_a_failing_final_run()
    {
        let composed = compose(&with(&[
            ("summary_claims_tests_pass", 0.95.into()),
            ("failing_at_end", 0.95.into()),
        ]));
        assert!(composed.score10 > THRESHOLDS.flag_below);
        assert_eq!(composed.verdict, GradeVerdict::Flag);
        assert!(composed.gates_fired.contains(&DERIVED_GATE.to_owned()));
        assert!((composed.gates[DERIVED_GATE] - 0.95).abs() < 1e-9);
        assert!(
            composed
                .reasons
                .contains("the summary claims passing tests while the last run in the log failed")
        );
    }

    #[test]
    fn names_a_gate_between_045_and_06_as_possible_without_flagging() {
        let composed = compose(&with(&[("untouched_criterion", 0.5.into())]));
        assert_eq!(composed.verdict, GradeVerdict::Pass);
        assert!(composed.gates_fired.is_empty());
        assert!(
            composed
                .gates_possible
                .contains(&"untouched_criterion".to_owned())
        );
        assert!(
            composed
                .reasons
                .contains("Possible, not acted on: a ticket criterion has no work in the diff.")
        );
    }

    #[test]
    fn flags_a_low_confidence_ticket_fit_and_says_so() {
        let low_fit = object(json!({
            "type": "score",
            "score": 3.75,
            "confidence": 0.4,
            "probabilities": { "0": 0.15, "1": 0.15, "2": 0.15, "3": 0.15, "4": 0.4 },
            "legend": {},
        }));
        let composed = compose(&with(&[("ticket_fit", low_fit)]));
        assert_eq!(composed.verdict, GradeVerdict::Flag);
        assert!(composed.low_confidence.contains(&"ticket_fit".to_owned()));
        assert!(
            composed
                .reasons
                .contains(&format!("Flagged because {LOW_CONFIDENCE_FLAG_PHRASE}."))
        );
        assert!(
            composed
                .reasons
                .contains("Note: low confidence on ticket_fit.")
        );
    }

    #[test]
    fn marks_low_confidence_on_claim_fidelity_and_log_health_without_flagging() {
        let low = |level: f64| {
            object(json!({
                "type": "score",
                "score": level,
                "confidence": 0.4,
                "probabilities": { "0": 0.4, "1": 0.2, "2": 0.2, "3": 0.2 },
                "legend": {},
            }))
        };
        let composed = compose(&with(&[
            ("claim_fidelity", low(3.0)),
            ("log_health", low(3.0)),
        ]));
        assert_eq!(composed.verdict, GradeVerdict::Pass);
        assert_eq!(composed.low_confidence, ["claim_fidelity", "log_health"]);
        assert!(
            composed
                .reasons
                .contains("Note: low confidence on claim_fidelity, log_health.")
        );
    }

    #[test]
    fn names_an_advisory_in_reasons_only_and_never_gates_on_it() {
        let composed = compose(&with(&[
            ("no_test_run", 0.9.into()),
            ("evidence_too_thin", 0.9.into()),
        ]));
        assert_eq!(composed.verdict, GradeVerdict::Pass);
        assert_eq!(composed.advisories, ["no_test_run", "evidence_too_thin"]);
        assert!(composed.reasons.contains("no test run appears in the log"));
        assert!(
            composed
                .reasons
                .contains("the diff or log was too thin to judge")
        );
    }

    #[test]
    fn composes_reasons_only_from_the_rubrics_fixed_phrases() {
        let composed = compose(&with(&[
            ("contradicted_claim", 0.7.into()),
            ("untouched_criterion", 0.5.into()),
            ("no_test_run", 0.8.into()),
            ("summary_claims_tests_pass", 0.9.into()),
            ("failing_at_end", 0.9.into()),
        ]));
        // Every clause traces to a phrase table entry; no generated text and no digit leaks into
        // reasons (levels and probabilities stay typed).
        assert!(composed.reasons.contains(gate_phrase("contradicted_claim")));
        assert!(composed.reasons.contains(gate_phrase(DERIVED_GATE)));
        assert!(
            composed
                .reasons
                .contains(gate_phrase("untouched_criterion"))
        );
        assert!(composed.reasons.contains(advisory_phrase("no_test_run")));
        assert!(
            LEVEL_PHRASES
                .iter()
                .flat_map(|(_, phrases)| phrases.iter())
                .any(|phrase| composed.reasons.contains(phrase))
        );
        assert!(!composed.reasons.chars().any(|c| c.is_ascii_digit()));
        // And the whole of it, as the TypeScript composes it.
        assert_eq!(
            composed.reasons,
            "ticket fit: all criteria met; claim fidelity: summary fully borne out; log health: clean run. \
             Flagged because the log contradicts a result the summary claims and the last test run or build in the log failed and the summary claims passing tests while the last run in the log failed. \
             Possible, not acted on: a ticket criterion has no work in the diff. \
             Note: no test run appears in the log."
        );
    }

    #[test]
    fn pins_the_rubric_version_so_a_grade_names_its_instrument() {
        assert_eq!(RUBRIC_VERSION, "jev-grader-rubric/2026-09-20.1");
    }

    #[test]
    fn asks_nine_questions_in_the_rubrics_order() {
        let ids: Vec<&str> = QUESTIONS.keys().map(String::as_str).collect();
        assert_eq!(
            ids,
            [
                "ticket_fit",
                "claim_fidelity",
                "log_health",
                "contradicted_claim",
                "untouched_criterion",
                "failing_at_end",
                "summary_claims_tests_pass",
                "no_test_run",
                "evidence_too_thin",
            ]
        );
        // The instructions carry the trust rule after the lead field, as `{ judge, ...TRUST }` builds them.
        let ticket_fit = QUESTIONS["ticket_fit"].to_value();
        let keys: Vec<&String> = ticket_fit["instructions"]
            .as_object()
            .unwrap()
            .keys()
            .collect();
        assert_eq!(keys, ["judge", "evidence", "rule"]);
        let helper = QUESTIONS["summary_claims_tests_pass"].to_value();
        let keys: Vec<&String> = helper["instructions"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["condition", "note"]);
        assert_eq!(
            helper["criteria"],
            json!({ "true": "The summary says tests ran and passed.", "false": "The summary makes no claim that tests passed." })
        );
    }

    #[test]
    fn a_level_off_the_phrase_table_is_named_by_its_number() {
        let off = |level: f64| {
            object(
                json!({ "type": "score", "score": level, "confidence": 0.9, "probabilities": {} }),
            )
        };
        let composed = compose(&with(&[
            ("ticket_fit", off(5.25)),
            ("log_health", off(-0.75)),
        ]));
        assert!(composed.reasons.starts_with("ticket fit: level 5.3; "));
        assert!(composed.reasons.contains("log health: level -0.8."));
        // A level that rounds to -0 still reads the first phrase, as `phrases[-0]` is `phrases[0]`.
        let composed = compose(&with(&[("log_health", off(-0.25))]));
        assert!(
            composed
                .reasons
                .contains("log health: run ends in failure.")
        );
    }

    #[test]
    fn rounds_and_fixes_numbers_as_javascript_does() {
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert_eq!(math_round(0.49999999999999994), 0.0);
        assert_eq!(math_round(93.99999999999999), 94.0);
        assert_eq!(to_fixed_1(0.25), "0.3");
        assert_eq!(to_fixed_1(-0.25), "-0.3");
        assert_eq!(to_fixed_1(1.05), "1.1");
        assert_eq!(to_fixed_1(2.0), "2.0");
        assert_eq!(to_fixed_1(-0.04), "-0.0");
        assert_eq!(to_fixed_1(1.45), "1.4");
    }

    #[test]
    fn grade_of_carries_the_composed_score_verdict_and_reasons() {
        let composed = compose(&answers(&clean()));
        let grade = grade_of(&composed);
        assert_eq!(grade.score, 9.4);
        assert_eq!(grade.verdict, GradeVerdict::Pass);
        assert_eq!(grade.reasons, composed.reasons);
        assert_eq!(grade.rubric, None);
    }
}
