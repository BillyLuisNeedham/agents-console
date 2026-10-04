//! Jev, the judgement model (issue #105; ADR-0020, docs/adr/0020-jev-gates-paths-engine-writes-status.md).
//! Ported from engine/jev.ts. This is the one module that talks to TypeSafe: it hands the engine a port
//! that asks narrow, typed questions over one Evidence object and gets a Judgement per question back,
//! or a cause for why it could not. The wire is TypeSafe's HTTP API, spoken as its TypeScript SDK speaks
//! it (`typesafe`), since there is no Rust SDK (ADR-0036).
//!
//! The port is failsafe by construction. [`Jev::ask`] never fails: a pool without a key, a bad key, a
//! rate limit, a timeout, a dead network, or a response that does not parse all come back as
//! [`JevResult::FellBack`] with a [`JevCause`], and the call site takes the heuristic path it always
//! had. A cause is announced to subscribers the first time it makes an ask fall back and again only when
//! the cause changes, so the pool log carries one line per cause rather than one per call.
//!
//! The API key never enters this module from the environment: the CLI boundary reads
//! `TYPESAFE_API_KEY` and passes it in, and with it `JEV_BASE_URL` when set, so a conformance run can
//! point the server at a fake TypeSafe endpoint (ADR-0036). The model and every other option the SDK
//! would have read from the environment are pinned here.

mod notice_board;
mod typesafe;

#[cfg(any(test, feature = "fake"))]
pub mod fake;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod wire_fake;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use ac_core::jev_questions::{Judgement, Question, ordered_questions};
use ac_core::js;

// The question helpers and Judgement shapes, re-exported so a call site takes everything Jev-shaped
// from here.
pub use ac_core::jev_questions::{
    Answers, ChoiceJudgement, Evidence, NoulJudgement, Questions, ScoreJudgement, choice, noul,
    score,
};
pub use notice_board::{NoticeBoard, NoticeListener, Unsubscribe};
pub use typesafe::{DEFAULT_TIMEOUT_MS, RetryPolicy, SDK_VERSION};

use typesafe::{SdkError, TypeSafeClient, get, is_record};

/// The model every request names; the SDK's own default, pinned so a `TYPESAFE_DEFAULT_MODEL` in the
/// environment changes nothing.
pub const JEV_MODEL: &str = "jev-latest";
/// The API root when the boundary passes none, pinned for the same reason as the model.
pub const JEV_BASE_URL: &str = "https://api.typesafe.ai";

/// The documented limits (https://docs.typesafe.ai/llms.txt).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JevLimits {
    /// Tokens per request: Evidence, questions and answers together.
    pub request_tokens: usize,
    /// Tokens the Evidence plus the single longest question may take; the docs state the state budget
    /// as the two together, not the Evidence alone.
    pub evidence_tokens: usize,
    /// Labels one Choice may offer.
    pub choice_options_max: usize,
    /// Levels one Score rubric may have, inclusive.
    pub score_levels_min: usize,
    pub score_levels_max: usize,
}

/// The limits. The token limits are enforced here by estimate, so an oversized Evidence falls back at
/// once instead of paying a round trip for a 422; the structural ones are exact.
pub const JEV_LIMITS: JevLimits = JevLimits {
    request_tokens: 64_000,
    evidence_tokens: 32_000,
    choice_options_max: 255,
    score_levels_min: 2,
    score_levels_max: 10,
};

/// The estimate the size checks use: characters per token. Measured on real Attempt artifacts
/// (ANSI-stripped logs plus unified diffs, English prose and TypeScript) on 2026-09-20, the API counts
/// about 3.5 characters per token, not the round 4 a rough guess gives. Pinned tighter than that guess
/// so Evidence this check accepts is not rejected by the API for size.
pub const JEV_CHARS_PER_TOKEN: f64 = 3.5;
/// Cost per million input tokens in USD; output is free. Informational.
pub const JEV_INPUT_USD_PER_MILLION_TOKENS: f64 = 0.042;
/// Typical round-trip latency, for the reader deciding where a call belongs.
pub const JEV_TYPICAL_LATENCY_MS: u64 = 150;

/// Why an ask fell back to the heuristic path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JevCause {
    NotConfigured,
    BadKey,
    RateLimited,
    TimedOut,
    Unreachable,
    Malformed,
    InvalidQuestion,
    EvidenceTooLarge,
}

impl JevCause {
    /// The cause as the pool log names it: `not-configured`, `rate-limited`, ...
    pub fn as_str(self) -> &'static str {
        match self {
            JevCause::NotConfigured => "not-configured",
            JevCause::BadKey => "bad-key",
            JevCause::RateLimited => "rate-limited",
            JevCause::TimedOut => "timed-out",
            JevCause::Unreachable => "unreachable",
            JevCause::Malformed => "malformed",
            JevCause::InvalidQuestion => "invalid-question",
            JevCause::EvidenceTooLarge => "evidence-too-large",
        }
    }
}

impl std::fmt::Display for JevCause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The token usage a response reports.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Usage {
    pub input_tokens: f64,
    pub output_tokens: f64,
}

/// The Judgements for one ask.
#[derive(Debug, Clone, PartialEq)]
pub struct Answered {
    /// One Judgement per question asked, in the questions' order.
    pub answers: Answers,
    /// The usage the response reported, when it reported one.
    pub usage: Option<Usage>,
    /// The model the API reports it answered with; the Grade's provenance records it. `None` when the
    /// response named none.
    pub model: Option<String>,
}

/// The Judgements for one ask, or the one cause it produced none.
#[derive(Debug, Clone, PartialEq)]
pub enum JevResult {
    Answered(Answered),
    FellBack { cause: JevCause, detail: String },
}

impl JevResult {
    /// `result.ok`.
    pub fn is_ok(&self) -> bool {
        matches!(self, JevResult::Answered(_))
    }

    /// The cause, for an ask that fell back.
    pub fn cause(&self) -> Option<JevCause> {
        match self {
            JevResult::Answered(_) => None,
            JevResult::FellBack { cause, .. } => Some(*cause),
        }
    }
}

/// What subscribers hear: a cause the first time it bites, and one recovery once asks succeed again.
#[derive(Debug, Clone, PartialEq)]
pub enum JevNotice {
    Unavailable { cause: JevCause, detail: String },
    Recovered,
}

/// The port the engine holds.
pub trait Jev: Send + Sync {
    /// False for the port a pool without a key gets: every ask falls back at once, nothing is ever sent.
    fn configured(&self) -> bool;

    /// Ask every question over one Evidence in one request. Never fails.
    fn ask<'a>(
        &'a self,
        evidence: &'a Evidence,
        questions: &'a Questions,
    ) -> BoxFuture<'a, JevResult>;

    /// Hear each fallback cause once (and a recovery), not once per call.
    fn subscribe(&self, listener: NoticeListener) -> Unsubscribe;
}

/// What the CLI boundary hands `create_jev`.
#[derive(Debug, Clone, Default)]
pub struct JevOptions {
    /// The key the CLI boundary read. Absent or empty, the port is unconfigured.
    pub api_key: Option<String>,
    /// The API root the boundary read from the `JEV_BASE_URL` variable; [`JEV_BASE_URL`] when unset.
    pub base_url: Option<String>,
    /// Per-attempt timeout in milliseconds; the SDK's default (10 s) when unset.
    pub timeout_ms: Option<u64>,
    /// The retry policy; the SDK's default (2 retries, backoff from 500 ms) when unset.
    pub retry: Option<RetryPolicy>,
}

/// The real port: TypeSafe over HTTP, or nothing at all without a key.
pub struct JevClient {
    board: NoticeBoard,
    /// Built only with a key: without one nothing is ever sent.
    client: Option<TypeSafeClient>,
}

/// `createJev(options)`: the port for one key, or the unconfigured port without one.
pub fn create_jev(options: JevOptions) -> JevClient {
    let client = options.api_key.filter(|key| !key.is_empty()).map(|key| {
        TypeSafeClient::new(
            key,
            options.base_url.as_deref().unwrap_or(JEV_BASE_URL),
            options.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
            options.retry.unwrap_or_default(),
        )
    });
    JevClient {
        board: NoticeBoard::new(),
        client,
    }
}

impl JevClient {
    /// The URL asks go to; `None` for the unconfigured port, which sends nothing.
    pub fn url(&self) -> Option<String> {
        self.client.as_ref().map(TypeSafeClient::systemone_url)
    }

    fn fall_back(&self, cause: JevCause, detail: String) -> JevResult {
        self.board.fell_back(cause, &detail);
        JevResult::FellBack { cause, detail }
    }

    async fn ask_now(&self, evidence: &Evidence, questions: &Questions) -> JevResult {
        let Some(client) = &self.client else {
            return self.fall_back(
                JevCause::NotConfigured,
                "no TYPESAFE_API_KEY at launch".to_owned(),
            );
        };
        if let Some(rejected) =
            check_questions(questions).or_else(|| check_evidence(evidence, questions))
        {
            return self.fall_back(rejected.cause, rejected.detail);
        }
        let result = match client.system_one(evidence, questions, JEV_MODEL).await {
            Ok(result) => result,
            Err(err) => {
                let rejected = classify_error(&err);
                return self.fall_back(rejected.cause, rejected.detail);
            }
        };
        if let Some(malformed) = check_answers(questions, result.as_ref()) {
            return self.fall_back(JevCause::Malformed, malformed);
        }
        self.board.succeeded();
        let result = result.unwrap_or(Value::Null);
        JevResult::Answered(Answered {
            answers: read_answers(questions, &result),
            usage: usage_of(&result),
            model: get(&result, "model")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }
}

impl Jev for JevClient {
    fn configured(&self) -> bool {
        self.client.is_some()
    }

    fn ask<'a>(
        &'a self,
        evidence: &'a Evidence,
        questions: &'a Questions,
    ) -> BoxFuture<'a, JevResult> {
        Box::pin(self.ask_now(evidence, questions))
    }

    fn subscribe(&self, listener: NoticeListener) -> Unsubscribe {
        self.board.subscribe(listener)
    }
}

struct Rejection {
    cause: JevCause,
    detail: String,
}

fn invalid(detail: String) -> Option<Rejection> {
    Some(Rejection {
        cause: JevCause::InvalidQuestion,
        detail,
    })
}

/// The structural limits, checked before the wire. (The TypeScript's unknown-type branch has no Rust
/// counterpart: a [`Question`] is one of the three types.)
fn check_questions(questions: &Questions) -> Option<Rejection> {
    if questions.is_empty() {
        return invalid("no questions".to_owned());
    }
    for (id, question) in ordered_questions(questions) {
        match question {
            Question::Choice { criteria, .. } => {
                let labels = criteria.len();
                if !(2..=JEV_LIMITS.choice_options_max).contains(&labels) {
                    return invalid(format!(
                        "{id}: a Choice needs 2 to {} labels, has {labels}",
                        JEV_LIMITS.choice_options_max
                    ));
                }
            }
            Question::Score { criteria, .. } => {
                let levels = criteria.len();
                if !(JEV_LIMITS.score_levels_min..=JEV_LIMITS.score_levels_max).contains(&levels) {
                    return invalid(format!(
                        "{id}: a Score needs {} to {} levels, has {levels}",
                        JEV_LIMITS.score_levels_min, JEV_LIMITS.score_levels_max
                    ));
                }
            }
            Question::Noul { .. } => {}
        }
    }
    None
}

/// The token estimate. The documented 32k budget is the Evidence plus the single longest question, so
/// both go into the estimate; the questions object itself is not counted, since only one travels beside
/// the Evidence in a request. (The TypeScript's check that the Evidence is a named JSON object is the
/// type's here.)
fn check_evidence(evidence: &Evidence, questions: &Questions) -> Option<Rejection> {
    let evidence_chars = js::utf16_len(&js::stringify(&Value::Object(evidence.clone())));
    let longest_question_chars = questions
        .values()
        .map(|question| js::utf16_len(&js::stringify(&question.to_value())))
        .max()
        .unwrap_or(0);
    let tokens =
        ((evidence_chars + longest_question_chars) as f64 / JEV_CHARS_PER_TOKEN).ceil() as u64;
    if tokens > JEV_LIMITS.evidence_tokens as u64 {
        return Some(Rejection {
            cause: JevCause::EvidenceTooLarge,
            detail: format!(
                "about {tokens} tokens of Evidence plus the longest question, limit {}",
                JEV_LIMITS.evidence_tokens
            ),
        });
    }
    None
}

fn classify_error(err: &SdkError) -> Rejection {
    let (cause, detail) = match err {
        SdkError::Api(api) if api.status == 401 || api.status == 403 => {
            (JevCause::BadKey, format!("HTTP {}", api.status))
        }
        SdkError::Api(api) if api.status == 429 => (JevCause::RateLimited, "HTTP 429".to_owned()),
        // The API reports an oversized request as HTTP 400 with the reason in the body, not 422. Read
        // that body so the call site's fallback takes its size branch rather than its invalid-question
        // branch.
        SdkError::Api(api)
            if api.status == 400
                && error_type_of(api.body.as_ref()) == Some("max_tokens_exceeded") =>
        {
            (
                JevCause::EvidenceTooLarge,
                format!("HTTP {}: {}", api.status, api.message),
            )
        }
        SdkError::Api(api) if api.status == 400 || api.status == 422 => (
            JevCause::InvalidQuestion,
            format!("HTTP {}: {}", api.status, api.message),
        ),
        SdkError::Timeout { timeout_ms } => (
            JevCause::TimedOut,
            format!("no answer within {timeout_ms}ms"),
        ),
        SdkError::Connection { message } => (JevCause::Unreachable, message.clone()),
        SdkError::Api(api) => (JevCause::Unreachable, format!("HTTP {}", api.status)),
    };
    Rejection { cause, detail }
}

/// The `error_type` a rejected request's body carries, when it carries one. The API writes
/// `{"detail":{"error_type":"..."}}`; `max_tokens_exceeded` is how it says the request did not fit the
/// model's window. The body is untrusted, so every step is guarded.
fn error_type_of(body: Option<&Value>) -> Option<&str> {
    let body = body.filter(|body| is_record(body))?;
    let detail = get(body, "detail").filter(|detail| is_record(detail))?;
    get(detail, "error_type")?.as_str()
}

/// The names every JavaScript object answers `in` through its prototype, so `label in criteria` holds
/// for them whatever the labels are.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

fn is_probability(value: Option<&Value>) -> bool {
    value
        .and_then(js::number_of)
        .is_some_and(|n| (0.0..=1.0).contains(&n))
}

/// The response is trusted only once every question has an answer of its own type and shape.
fn check_answers(questions: &Questions, result: Option<&Value>) -> Option<String> {
    let Some(result) = result.filter(|result| is_record(result)) else {
        return Some("response is not an object".to_owned());
    };
    let Some(answers) = get(result, "answers").filter(|answers| is_record(answers)) else {
        return Some("response has no answers".to_owned());
    };
    for (id, question) in ordered_questions(questions) {
        let Some(answer) = get(answers, id).filter(|answer| is_record(answer)) else {
            return Some(format!("no answer for {id}"));
        };
        let kind = get(answer, "type");
        if kind.and_then(Value::as_str) != Some(question.kind()) {
            let kind = kind.map_or_else(|| "undefined".to_owned(), js::string_of);
            return Some(format!(
                "{id}: answer type {kind} for a {}",
                question.kind()
            ));
        }
        match question {
            Question::Noul { .. } => {
                if !is_probability(get(answer, "noul")) {
                    return Some(format!("{id}: noul is not a probability"));
                }
            }
            Question::Choice { criteria, .. } => {
                let offered = match get(answer, "choice") {
                    Some(Value::String(label)) => {
                        criteria.contains_key(label)
                            || OBJECT_PROTOTYPE_KEYS.contains(&label.as_str())
                    }
                    _ => false,
                };
                if !offered {
                    return Some(format!("{id}: choice is not one of the labels"));
                }
                if let Some(problem) = check_confidence_and_probabilities(id, answer) {
                    return Some(problem);
                }
            }
            Question::Score { .. } => {
                if !matches!(get(answer, "score"), Some(Value::Number(_))) {
                    return Some(format!("{id}: score is not a number"));
                }
                if let Some(problem) = check_confidence_and_probabilities(id, answer) {
                    return Some(problem);
                }
            }
        }
    }
    None
}

fn check_confidence_and_probabilities(id: &str, answer: &Value) -> Option<String> {
    if !is_probability(get(answer, "confidence")) {
        return Some(format!("{id}: confidence is not a probability"));
    }
    if !get(answer, "probabilities").is_some_and(is_record) {
        return Some(format!("{id}: no probabilities"));
    }
    None
}

/// The checked answers as Judgements, one per question.
fn read_answers(questions: &Questions, result: &Value) -> Answers {
    let answers = get(result, "answers");
    questions
        .iter()
        .filter_map(|(id, question)| {
            let answer = answers.and_then(|answers| get(answers, id))?;
            Judgement::from_value(question, answer).map(|judgement| (id.clone(), judgement))
        })
        .collect()
}

fn usage_of(result: &Value) -> Option<Usage> {
    let usage = get(result, "usage")?;
    Some(Usage {
        input_tokens: get(usage, "input_tokens").and_then(js::number_of)?,
        output_tokens: get(usage, "output_tokens").and_then(js::number_of)?,
    })
}
