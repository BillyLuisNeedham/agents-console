//! The Jev port (issue #105, ADR-0020) against the wire fake: the real client over real HTTP to a fake
//! TypeSafe endpoint, so retries, error classes and body parsing are the client's own. Every failure
//! comes back as a fallback with its cause, never a failure of the call, and each cause is announced
//! once. Ported from engine/jev.test.ts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ac_core::jev_questions::{ScriptedAnswer, questions_value};
use ac_core::js;
use serde_json::{Map, Value, json};

use super::fake::{FakeJev, FakeJevOptions};
use super::wire_fake::{Fail, WireFake, WireOptions, dead_url, hanging_up_url};
use super::*;

fn no_retry() -> RetryPolicy {
    RetryPolicy {
        max_retries: 0,
        ..RetryPolicy::default()
    }
}

fn one_quick_retry() -> RetryPolicy {
    RetryPolicy {
        max_retries: 1,
        backoff_initial_ms: 1,
        backoff_max_ms: 1,
        ..RetryPolicy::default()
    }
}

fn labels(names: &[&str]) -> Map<String, Value> {
    names
        .iter()
        .map(|name| (name.to_string(), Value::Null))
        .collect()
}

fn questions() -> Questions {
    Questions::from([
        (
            "waiting".to_owned(),
            noul(
                "Is the agent waiting on the operator?",
                Some(json!({ "true": "yes", "false": "no" })),
            ),
        ),
        (
            "why".to_owned(),
            choice(
                "Why did the attempt end?",
                labels(&["finished", "stuck", "ceiling"]),
            ),
        ),
        (
            "brief".to_owned(),
            score(
                "How complete is the Brief?",
                vec![json!("empty"), json!("thin"), json!("complete")],
            ),
        ),
    ])
}

fn evidence() -> Evidence {
    json!({ "pane": "❯ ", "ticket": "01" })
        .as_object()
        .unwrap()
        .clone()
}

fn script(answers: &[(&str, ScriptedAnswer)]) -> HashMap<String, ScriptedAnswer> {
    answers
        .iter()
        .map(|(id, answer)| (id.to_string(), answer.clone()))
        .collect()
}

fn options(fake: &WireFake, retry: RetryPolicy) -> JevOptions {
    JevOptions {
        api_key: Some("test-key".to_owned()),
        base_url: Some(fake.url().to_owned()),
        timeout_ms: None,
        retry: Some(retry),
    }
}

fn configured(fake: &WireFake) -> JevClient {
    create_jev(options(fake, no_retry()))
}

async fn serve(options: WireOptions) -> WireFake {
    WireFake::serve(options).await
}

async fn failing(status: u16) -> WireFake {
    serve(WireOptions {
        fail: Some(Fail::always(status)),
        ..WireOptions::default()
    })
    .await
}

fn notices_of(jev: &dyn Jev) -> Arc<Mutex<Vec<JevNotice>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    jev.subscribe(Box::new(move |notice| {
        sink.lock().unwrap().push(notice.clone())
    }));
    seen
}

fn names(notices: &Mutex<Vec<JevNotice>>) -> Vec<String> {
    notices
        .lock()
        .unwrap()
        .iter()
        .map(|notice| match notice {
            JevNotice::Recovered => "recovered".to_owned(),
            JevNotice::Unavailable { cause, .. } => cause.to_string(),
        })
        .collect()
}

fn answered(result: JevResult) -> Answered {
    match result {
        JevResult::Answered(answered) => answered,
        JevResult::FellBack { cause, detail } => panic!("fell back: {cause}: {detail}"),
    }
}

fn fell_back(result: JevResult) -> (JevCause, String) {
    match result {
        JevResult::FellBack { cause, detail } => (cause, detail),
        JevResult::Answered(answered) => panic!("answered: {answered:?}"),
    }
}

/// Evidence whose serialised JSON is exactly `length` characters: repetitive English, like a log read.
fn evidence_of(length: usize) -> Evidence {
    let sentence = "the agent is waiting on the operator. ";
    let filler = sentence.repeat(length / sentence.len() + 2);
    json!({ "log": &filler[..length - 10] })
        .as_object()
        .unwrap()
        .clone()
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

#[tokio::test]
async fn asks_every_question_over_one_evidence_in_one_request_and_returns_each_typed_judgement() {
    let fake = serve(WireOptions {
        answers: script(&[
            ("waiting", 0.93.into()),
            ("why", "stuck".into()),
            ("brief", 2.into()),
        ]),
        ..WireOptions::default()
    })
    .await;
    let jev = configured(&fake);
    let result = answered(jev.ask(&evidence(), &questions()).await);
    assert_eq!(result.answers["waiting"].noul(), Some(0.93));
    let why = result.answers["why"].as_choice().unwrap();
    assert_eq!(why.choice, "stuck");
    assert_eq!(why.probabilities["stuck"], 0.9);
    assert_eq!(why.confidence, 0.9);
    let brief = result.answers["brief"].as_score().unwrap();
    assert!((brief.score - 1.85).abs() < 1e-9);
    assert_eq!(brief.probabilities["2"], 0.9);
    assert!(result.usage.unwrap().input_tokens > 0.0);
    assert_eq!(result.model.as_deref(), Some(JEV_MODEL));
    // One request, carrying the Evidence as state, every question, the pinned model.
    let requests = fake.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.url, format!("{}/v1/systemone", fake.url()));
    assert_eq!(request.header("authorization"), Some("Bearer test-key"));
    assert_eq!(request.body["state"], Value::Object(evidence()));
    let ids: Vec<&String> = request.body["questions"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(ids, ["waiting", "why", "brief"]);
    assert_eq!(request.body["model"], JEV_MODEL);
}

#[tokio::test]
async fn sends_the_sdks_body_and_headers() {
    let fake = serve(WireOptions::default()).await;
    let jev = configured(&fake);
    assert!(jev.ask(&evidence(), &questions()).await.is_ok());
    let request = &fake.requests()[0];
    // `JSON.stringify({ state, questions, model })`, the questions as the SDK's helpers build them.
    let expected = json!({
        "state": evidence(),
        "questions": questions_value(&questions()),
        "model": "jev-latest",
    });
    assert_eq!(request.raw, js::stringify(&expected));
    assert!(request.raw.starts_with(r#"{"state":{"pane":"❯ ","ticket":"01"},"questions":{"waiting":{"type":"noul","instructions":"Is the agent waiting on the operator?","criteria":{"true":"yes","false":"no"}}"#));
    assert_eq!(request.header("accept"), Some("application/json"));
    assert_eq!(request.header("content-type"), Some("application/json"));
    assert_eq!(request.header("user-agent"), Some("typesafe-sdk/0.6.0"));
    assert_eq!(request.header("x-typesafe-sdk"), Some("typesafe-sdk/0.6.0"));
    assert_eq!(
        request.header("x-typesafe-runtime"),
        Some(typesafe::runtime().as_str())
    );
    // The first attempt carries no retry count.
    assert_eq!(request.header("x-typesafe-retry-count"), None);
}

#[tokio::test]
async fn configuration_comes_only_from_the_options() {
    // The client reads nothing from its environment: no key passed means unconfigured, whatever the
    // environment holds, and the root and model stay pinned without one passed.
    let unset = create_jev(JevOptions::default());
    assert!(!unset.configured());
    assert_eq!(unset.url(), None);
    let (cause, _) = fell_back(unset.ask(&evidence(), &questions()).await);
    assert_eq!(cause, JevCause::NotConfigured);
    let pinned = create_jev(JevOptions {
        api_key: Some("k".to_owned()),
        ..JevOptions::default()
    });
    assert!(pinned.configured());
    assert_eq!(
        pinned.url().as_deref(),
        Some("https://api.typesafe.ai/v1/systemone")
    );
    // An empty key is no key, as the boundary's `|| undefined` makes it.
    let empty = create_jev(JevOptions {
        api_key: Some(String::new()),
        ..JevOptions::default()
    });
    assert!(!empty.configured());
    // Nothing below the CLI boundary names an environment variable.
    for source in [
        include_str!("mod.rs"),
        include_str!("typesafe.rs"),
        include_str!("notice_board.rs"),
    ] {
        assert!(!source.contains(concat!("env::", "var")));
    }
}

#[tokio::test]
async fn sends_to_the_base_url_the_boundary_passes_in() {
    let fake = serve(WireOptions::default()).await;
    let jev = create_jev(JevOptions {
        base_url: Some(format!("{}/", fake.url())),
        ..options(&fake, no_retry())
    });
    assert!(jev.ask(&evidence(), &questions()).await.is_ok());
    assert_eq!(
        fake.requests()[0].url,
        format!("{}/v1/systemone", fake.url())
    );
}

// ---------------------------------------------------------------------------
// Fallback causes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unconfigured_falls_back_before_any_request_announced_once_across_many_asks() {
    let jev = create_jev(JevOptions::default());
    let notices = notices_of(&jev);
    for _ in 0..3 {
        let (cause, _) = fell_back(jev.ask(&evidence(), &questions()).await);
        assert_eq!(cause, JevCause::NotConfigured);
    }
    assert_eq!(
        *notices.lock().unwrap(),
        [JevNotice::Unavailable {
            cause: JevCause::NotConfigured,
            detail: "no TYPESAFE_API_KEY at launch".to_owned(),
        }]
    );
}

#[tokio::test]
async fn a_rejected_key_401_or_403_is_bad_key() {
    for status in [401, 403] {
        let fake = failing(status).await;
        let (cause, detail) = fell_back(configured(&fake).ask(&evidence(), &questions()).await);
        assert_eq!(cause, JevCause::BadKey);
        assert_eq!(detail, format!("HTTP {status}"));
    }
}

#[tokio::test]
async fn a_429_is_rate_limited_once_the_retries_are_spent() {
    let fake = failing(429).await;
    let jev = create_jev(options(&fake, one_quick_retry()));
    let (cause, detail) = fell_back(jev.ask(&evidence(), &questions()).await);
    assert_eq!(
        (cause, detail.as_str()),
        (JevCause::RateLimited, "HTTP 429")
    );
    let requests = fake.requests();
    assert_eq!(requests.len(), 2);
    // The retry names itself, and carries the same body.
    assert_eq!(requests[1].header("x-typesafe-retry-count"), Some("1"));
    assert_eq!(requests[0].raw, requests[1].raw);
}

#[tokio::test]
async fn retries_twice_by_default() {
    let fake = failing(503).await;
    let jev = create_jev(options(
        &fake,
        RetryPolicy {
            backoff_initial_ms: 1,
            backoff_max_ms: 1,
            ..RetryPolicy::default()
        },
    ));
    let (cause, detail) = fell_back(jev.ask(&evidence(), &questions()).await);
    assert_eq!(
        (cause, detail.as_str()),
        (JevCause::Unreachable, "HTTP 503")
    );
    let counts: Vec<Option<String>> = fake
        .requests()
        .iter()
        .map(|request| request.header("x-typesafe-retry-count").map(str::to_owned))
        .collect();
    assert_eq!(counts, [None, Some("1".to_owned()), Some("2".to_owned())]);
}

#[tokio::test]
async fn a_status_that_does_not_retry_fails_at_once() {
    for status in [400, 401, 404, 422] {
        let fake = failing(status).await;
        let jev = create_jev(options(&fake, one_quick_retry()));
        assert!(!jev.ask(&evidence(), &questions()).await.is_ok());
        assert_eq!(fake.requests().len(), 1, "HTTP {status}");
    }
}

#[tokio::test]
async fn waits_as_long_as_the_server_asks_before_retrying() {
    // A backoff of a minute, but the server asks for 5 ms: the retry comes at once.
    let fake = serve(WireOptions {
        fail: Some(Fail {
            status: 429,
            body: None,
            times: Some(1),
        }),
        headers: vec![("retry-after-ms", "5".to_owned())],
        ..WireOptions::default()
    })
    .await;
    let jev = create_jev(options(
        &fake,
        RetryPolicy {
            max_retries: 1,
            backoff_initial_ms: 60_000,
            ..RetryPolicy::default()
        },
    ));
    let started = Instant::now();
    assert!(jev.ask(&evidence(), &questions()).await.is_ok());
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(fake.requests().len(), 2);
}

#[tokio::test]
async fn a_transient_failure_the_retry_clears_still_answers() {
    let fake = serve(WireOptions {
        fail: Some(Fail {
            status: 529,
            body: None,
            times: Some(1),
        }),
        answers: script(&[("waiting", 0.2.into())]),
        ..WireOptions::default()
    })
    .await;
    let jev = create_jev(options(&fake, one_quick_retry()));
    let notices = notices_of(&jev);
    let result = answered(jev.ask(&evidence(), &questions()).await);
    assert_eq!(result.answers["waiting"].noul(), Some(0.2));
    assert_eq!(fake.requests().len(), 2);
    assert!(notices.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_5xx_with_no_retry_left_is_unreachable_as_is_a_dead_network() {
    let dead = failing(500).await;
    let (cause, detail) = fell_back(configured(&dead).ask(&evidence(), &questions()).await);
    assert_eq!(
        (cause, detail.as_str()),
        (JevCause::Unreachable, "HTTP 500")
    );

    let jev = create_jev(JevOptions {
        api_key: Some("k".to_owned()),
        base_url: Some(dead_url().await),
        timeout_ms: None,
        retry: Some(no_retry()),
    });
    let (cause, detail) = fell_back(jev.ask(&evidence(), &questions()).await);
    assert_eq!(cause, JevCause::Unreachable);
    // Bun's fetch words a refused connection this way, and the SDK wraps it.
    assert_eq!(
        detail,
        "Connection error: Unable to connect. Is the computer able to access the url?"
    );
}

#[tokio::test]
async fn a_connection_dropped_before_the_answer_is_unreachable() {
    let (url, server) = hanging_up_url().await;
    let jev = create_jev(JevOptions {
        api_key: Some("k".to_owned()),
        base_url: Some(url),
        timeout_ms: None,
        retry: Some(no_retry()),
    });
    let (cause, detail) = fell_back(jev.ask(&evidence(), &questions()).await);
    server.abort();
    assert_eq!(cause, JevCause::Unreachable);
    assert_eq!(
        detail,
        "Connection error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"
    );
}

#[tokio::test]
async fn no_answer_within_the_timeout_is_timed_out() {
    let fake = serve(WireOptions {
        delay_ms: Some(500),
        ..WireOptions::default()
    })
    .await;
    let jev = create_jev(JevOptions {
        timeout_ms: Some(20),
        ..options(&fake, no_retry())
    });
    let (cause, detail) = fell_back(jev.ask(&evidence(), &questions()).await);
    assert_eq!(cause, JevCause::TimedOut);
    assert_eq!(detail, "no answer within 20ms");
}

#[tokio::test]
async fn a_400_and_a_422_are_invalid_question() {
    for status in [400, 422] {
        let fake = failing(status).await;
        let (cause, detail) = fell_back(configured(&fake).ask(&evidence(), &questions()).await);
        assert_eq!(cause, JevCause::InvalidQuestion);
        assert_eq!(detail, format!("HTTP {status}: {status} status {status}"));
    }
}

#[tokio::test]
async fn a_400_carrying_max_tokens_exceeded_is_evidence_too_large_with_the_body_preserved() {
    let carrying = |status: u16, error_type: &str| Fail {
        status,
        body: Some(json!({ "detail": { "error_type": error_type } })),
        times: None,
    };
    let fake = serve(WireOptions {
        fail: Some(carrying(400, "max_tokens_exceeded")),
        ..WireOptions::default()
    })
    .await;
    let (cause, detail) = fell_back(configured(&fake).ask(&evidence(), &questions()).await);
    assert_eq!(cause, JevCause::EvidenceTooLarge);
    assert_eq!(
        detail,
        r#"HTTP 400: 400 {"detail":{"error_type":"max_tokens_exceeded"}}"#
    );
    // A 400 for any other reason stays invalid-question.
    fake.script(WireOptions {
        fail: Some(carrying(400, "bad_question")),
        ..WireOptions::default()
    });
    let (cause, _) = fell_back(configured(&fake).ask(&evidence(), &questions()).await);
    assert_eq!(cause, JevCause::InvalidQuestion);
    // And a 422 never becomes a size rejection, whatever it carries.
    fake.script(WireOptions {
        fail: Some(carrying(422, "max_tokens_exceeded")),
        ..WireOptions::default()
    });
    let (cause, _) = fell_back(configured(&fake).ask(&evidence(), &questions()).await);
    assert_eq!(cause, JevCause::InvalidQuestion);
}

#[tokio::test]
async fn a_200_whose_body_is_not_json_is_malformed() {
    let fake = serve(WireOptions {
        garbage: true,
        ..WireOptions::default()
    })
    .await;
    let (cause, detail) = fell_back(configured(&fake).ask(&evidence(), &questions()).await);
    assert_eq!(cause, JevCause::Malformed);
    assert_eq!(detail, "response is not an object");
}

#[tokio::test]
async fn an_answer_of_the_wrong_type_or_a_label_not_offered_is_malformed() {
    let wrong_type = serve(WireOptions {
        answers: script(&[("why", json!({ "type": "noul", "noul": 0.2 }).into())]),
        ..WireOptions::default()
    })
    .await;
    let (cause, detail) = fell_back(configured(&wrong_type).ask(&evidence(), &questions()).await);
    assert_eq!(cause, JevCause::Malformed);
    assert_eq!(detail, "why: answer type noul for a choice");
    let off_label = serve(WireOptions {
        answers: script(&[(
            "why",
            json!({ "choice": "other", "confidence": 0.9, "probabilities": { "other": 0.9 } })
                .into(),
        )]),
        ..WireOptions::default()
    })
    .await;
    let (cause, detail) = fell_back(configured(&off_label).ask(&evidence(), &questions()).await);
    assert_eq!(cause, JevCause::Malformed);
    assert_eq!(detail, "why: choice is not one of the labels");
}

#[test]
fn checks_every_answer_against_its_question_as_the_typescript_does() {
    let qs = questions();
    let check = |result: Value| check_answers(&qs, Some(&result));
    let good = |overrides: Value| {
        let mut answers = json!({
            "waiting": { "type": "noul", "noul": 0.5 },
            "why": { "type": "choice", "choice": "stuck", "confidence": 0.9, "probabilities": {} },
            "brief": { "type": "score", "score": 1, "confidence": 0.9, "probabilities": [] },
        });
        for (id, answer) in overrides.as_object().unwrap() {
            answers[id] = answer.clone();
        }
        json!({ "model": "m", "answers": answers })
    };
    assert_eq!(check(good(json!({}))), None);
    assert_eq!(
        check_answers(&qs, None).as_deref(),
        Some("response is not an object")
    );
    assert_eq!(
        check(json!("text")).as_deref(),
        Some("response is not an object")
    );
    assert_eq!(
        check(json!(null)).as_deref(),
        Some("response is not an object")
    );
    assert_eq!(check(json!([])).as_deref(), Some("response has no answers"));
    assert_eq!(
        check(json!({ "answers": 3 })).as_deref(),
        Some("response has no answers")
    );
    assert_eq!(
        check(json!({ "answers": {} })).as_deref(),
        Some("no answer for waiting")
    );
    assert_eq!(
        check(good(json!({ "waiting": { "noul": 0.5 } }))).as_deref(),
        Some("waiting: answer type undefined for a noul")
    );
    assert_eq!(
        check(good(json!({ "waiting": [1] }))).as_deref(),
        Some("waiting: answer type undefined for a noul")
    );
    assert_eq!(
        check(good(json!({ "waiting": { "type": 7 } }))).as_deref(),
        Some("waiting: answer type 7 for a noul")
    );
    assert_eq!(
        check(good(json!({ "waiting": { "type": "noul", "noul": 1.5 } }))).as_deref(),
        Some("waiting: noul is not a probability")
    );
    assert_eq!(
        check(good(
            json!({ "why": { "type": "choice", "choice": "stuck", "confidence": "high" } })
        ))
        .as_deref(),
        Some("why: confidence is not a probability")
    );
    assert_eq!(
        check(good(json!({ "why": { "type": "choice", "choice": "stuck", "confidence": 0.9, "probabilities": null } })))
            .as_deref(),
        Some("why: no probabilities")
    );
    // JavaScript's `in` reaches the prototype, so a prototype name passes as a label.
    assert_eq!(
        check(good(
            json!({ "why": { "type": "choice", "choice": "toString", "confidence": 0.9, "probabilities": {} } })
        )),
        None
    );
    assert_eq!(
        check(good(json!({ "brief": { "type": "score", "score": "2", "confidence": 0.9, "probabilities": {} } })))
            .as_deref(),
        Some("brief: score is not a number")
    );
}

// ---------------------------------------------------------------------------
// Limits, checked before the wire
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_choice_past_the_label_cap_a_score_outside_2_10_levels_or_no_questions_is_invalid_question()
 {
    let fake = serve(WireOptions::default()).await;
    let jev = configured(&fake);
    let too_many: Map<String, Value> = (0..=JEV_LIMITS.choice_options_max)
        .map(|i| (format!("l{i}"), Value::Null))
        .collect();
    let ask = |questions: Questions| {
        let jev = &jev;
        async move { fell_back(jev.ask(&evidence(), &questions).await) }
    };
    let (cause, detail) = ask(Questions::from([(
        "pick".to_owned(),
        choice("which?", too_many),
    )]))
    .await;
    assert_eq!(cause, JevCause::InvalidQuestion);
    assert_eq!(detail, "pick: a Choice needs 2 to 255 labels, has 256");
    let eleven = score("?", vec![json!("level"); 11]);
    let (cause, detail) = ask(Questions::from([("rate".to_owned(), eleven)])).await;
    assert_eq!(cause, JevCause::InvalidQuestion);
    assert_eq!(detail, "rate: a Score needs 2 to 10 levels, has 11");
    let one = score("?", vec![json!("only")]);
    let (cause, _) = ask(Questions::from([("rate".to_owned(), one)])).await;
    assert_eq!(cause, JevCause::InvalidQuestion);
    let (cause, detail) = ask(Questions::new()).await;
    assert_eq!(
        (cause, detail.as_str()),
        (JevCause::InvalidQuestion, "no questions")
    );
    assert!(fake.requests().is_empty());
}

#[tokio::test]
async fn evidence_past_the_token_estimate_is_evidence_too_large() {
    let fake = serve(WireOptions::default()).await;
    let jev = configured(&fake);
    let length = (JEV_LIMITS.evidence_tokens as f64 * JEV_CHARS_PER_TOKEN).ceil() as usize + 100;
    let huge = json!({ "log": "x".repeat(length) })
        .as_object()
        .unwrap()
        .clone();
    let (cause, detail) = fell_back(jev.ask(&huge, &questions()).await);
    assert_eq!(cause, JevCause::EvidenceTooLarge);
    assert!(
        detail.starts_with("about ")
            && detail.ends_with(" tokens of Evidence plus the longest question, limit 32000"),
        "{detail}"
    );
    assert!(fake.requests().is_empty());
}

#[tokio::test]
async fn about_120k_characters_of_real_evidence_is_evidence_too_large_before_the_wire() {
    let fake = serve(WireOptions::default()).await;
    let jev = configured(&fake);
    // The size a live bench measured on 2026-09-20: it passed the old four-characters-per-token guess
    // at about 30k and was rejected by the API at about 35k real tokens.
    let evidence = evidence_of(120_000);
    assert_eq!(
        js::stringify(&Value::Object(evidence.clone())).len(),
        120_000
    );
    let (cause, _) = fell_back(jev.ask(&evidence, &questions()).await);
    assert_eq!(cause, JevCause::EvidenceTooLarge);
    assert!(fake.requests().is_empty());
}

#[tokio::test]
async fn the_estimate_counts_the_longest_question_as_well_as_the_evidence() {
    let fake = serve(WireOptions::default()).await;
    let jev = configured(&fake);
    // Evidence one margin short of the budget on its own: it fits with a short question and does not
    // once a long question joins it.
    let budget_chars = (JEV_LIMITS.evidence_tokens as f64 * JEV_CHARS_PER_TOKEN).floor() as usize;
    let evidence = evidence_of(budget_chars - 1_000);
    let long = "Describe what happened to this attempt in complete sentences. ".repeat(20);
    let asked = |text: String| {
        Questions::from([(
            "why".to_owned(),
            choice(text, labels(&["finished", "stuck"])),
        )])
    };
    let (cause, _) = fell_back(jev.ask(&evidence, &asked(long)).await);
    assert_eq!(cause, JevCause::EvidenceTooLarge);
    assert!(fake.requests().is_empty());
    // The same Evidence with a short question fits, in one request.
    assert!(jev.ask(&evidence, &asked("Why?".to_owned())).await.is_ok());
    assert_eq!(fake.requests().len(), 1);
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

#[tokio::test]
async fn announces_a_cause_once_again_when_the_cause_changes_and_one_recovery_when_answers_resume()
{
    let fake = failing(401).await;
    let jev = configured(&fake);
    let notices = notices_of(&jev);
    jev.ask(&evidence(), &questions()).await;
    jev.ask(&evidence(), &questions()).await;
    fake.script(WireOptions {
        fail: Some(Fail::always(429)),
        ..WireOptions::default()
    });
    jev.ask(&evidence(), &questions()).await;
    jev.ask(&evidence(), &questions()).await;
    fake.script(WireOptions::default());
    jev.ask(&evidence(), &questions()).await;
    jev.ask(&evidence(), &questions()).await;
    assert_eq!(names(&notices), ["bad-key", "rate-limited", "recovered"]);
    assert_eq!(
        notices.lock().unwrap()[0],
        JevNotice::Unavailable {
            cause: JevCause::BadKey,
            detail: "HTTP 401".to_owned(),
        }
    );
}

#[tokio::test]
async fn unsubscribing_stops_the_notices() {
    let fake = failing(401).await;
    let jev = configured(&fake);
    let seen = Arc::new(Mutex::new(Vec::<JevNotice>::new()));
    let sink = Arc::clone(&seen);
    let off = jev.subscribe(Box::new(move |notice| {
        sink.lock().unwrap().push(notice.clone())
    }));
    off.unsubscribe();
    jev.ask(&evidence(), &questions()).await;
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn a_cause_that_returns_after_another_is_heard_again() {
    let board = NoticeBoard::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    board.subscribe(Box::new(move |notice| {
        sink.lock().unwrap().push(notice.clone())
    }));
    board.succeeded();
    board.fell_back(JevCause::TimedOut, "a");
    board.fell_back(JevCause::TimedOut, "b");
    board.fell_back(JevCause::Unreachable, "c");
    board.fell_back(JevCause::TimedOut, "d");
    board.succeeded();
    board.succeeded();
    assert_eq!(
        names(&seen),
        ["timed-out", "unreachable", "timed-out", "recovered"]
    );
}

#[test]
fn a_cause_reads_as_the_pool_log_names_it() {
    let all = [
        (JevCause::NotConfigured, "not-configured"),
        (JevCause::BadKey, "bad-key"),
        (JevCause::RateLimited, "rate-limited"),
        (JevCause::TimedOut, "timed-out"),
        (JevCause::Unreachable, "unreachable"),
        (JevCause::Malformed, "malformed"),
        (JevCause::InvalidQuestion, "invalid-question"),
        (JevCause::EvidenceTooLarge, "evidence-too-large"),
    ];
    for (cause, name) in all {
        assert_eq!(cause.to_string(), name);
        assert_eq!(serde_json::to_value(cause).unwrap(), name);
    }
}

// ---------------------------------------------------------------------------
// The port fake
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_port_fake_answers_by_question_id_falls_back_by_scripted_cause_and_announces_through_the_same_board()
 {
    let jev = FakeJev::new(FakeJevOptions {
        answers: script(&[("waiting", 0.8.into()), ("why", "ceiling".into())]),
        ..FakeJevOptions::default()
    });
    let notices = notices_of(&jev);
    let result = answered(jev.ask(&evidence(), &questions()).await);
    assert_eq!(result.answers["waiting"].noul(), Some(0.8));
    assert_eq!(result.answers["why"].as_choice().unwrap().choice, "ceiling");
    let brief = result.answers["brief"].as_score().unwrap();
    assert!((brief.probabilities["0"].as_f64().unwrap() - 1.0 / 3.0).abs() < 1e-9);
    jev.script(None, Some(JevCause::TimedOut));
    let (cause, detail) = fell_back(jev.ask(&evidence(), &questions()).await);
    assert_eq!(
        (cause, detail.as_str()),
        (JevCause::TimedOut, "scripted by the test")
    );
    jev.script(None, None);
    assert!(jev.ask(&evidence(), &questions()).await.is_ok());
    assert_eq!(jev.asks().len(), 3);
    assert_eq!(names(&notices), ["timed-out", "recovered"]);
    let unset = FakeJev::new(FakeJevOptions {
        configured: Some(false),
        ..FakeJevOptions::default()
    });
    assert!(!unset.configured());
    let (cause, _) = fell_back(unset.ask(&evidence(), &questions()).await);
    assert_eq!(cause, JevCause::NotConfigured);
    // A failure chosen from the Evidence, and answers chosen from it.
    let picky = FakeJev::new(FakeJevOptions {
        answers_for: Some(Box::new(|evidence| {
            (evidence.get("ticket") == Some(&json!("01")))
                .then(|| script(&[("waiting", 0.1.into())]))
        })),
        fail_for: Some(Box::new(|evidence| {
            (evidence.get("ticket") == Some(&json!("02"))).then_some((JevCause::RateLimited, None))
        })),
        ..FakeJevOptions::default()
    });
    let first = answered(picky.ask(&evidence(), &questions()).await);
    assert_eq!(first.answers["waiting"].noul(), Some(0.1));
    let second = json!({ "ticket": "02" }).as_object().unwrap().clone();
    let (cause, _) = fell_back(picky.ask(&second, &questions()).await);
    assert_eq!(cause, JevCause::RateLimited);
}
