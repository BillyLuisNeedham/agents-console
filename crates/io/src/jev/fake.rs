//! The Jev port fake, ported from engine/jev-port-fake.ts: it implements [`Jev`] without HTTP at all,
//! answering by question id, so an engine suite can say "Jev answers waiting at 0.93" or "Jev is
//! rate-limited" and drive a call site. Built for this crate's tests and, with the `fake` feature, for
//! the engine's.
//!
//! Its answers come from [`answer_for`], the wire fake's own, so the wording a suite scripts here is the
//! wording the wire would carry, and it announces through the same [`NoticeBoard`] the real port does.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use ac_core::jev_questions::{Judgement, ScriptedAnswer, answer_for};
use futures::future::BoxFuture;

use super::{
    Answered, Evidence, JEV_MODEL, Jev, JevCause, JevResult, NoticeBoard, NoticeListener,
    Questions, Unsubscribe, Usage,
};

/// Answers by question id.
pub type Script = HashMap<String, ScriptedAnswer>;

/// A per-ask answer script chosen from the Evidence; `None` falls back to the fixed answers.
pub type AnswersFor = Box<dyn Fn(&Evidence) -> Option<Script> + Send + Sync>;

/// A per-ask failure chosen from the Evidence: the cause, and a detail other than the default.
pub type FailFor = Box<dyn Fn(&Evidence) -> Option<(JevCause, Option<String>)> + Send + Sync>;

/// The detail a scripted fallback carries when the script names none.
pub const SCRIPTED_DETAIL: &str = "scripted by the test";

/// How the fake answers.
#[derive(Default)]
pub struct FakeJevOptions {
    /// Answers by question id, as for the wire fake.
    pub answers: Script,
    /// A per-ask answer script chosen from the Evidence, for a suite that needs one port to answer two
    /// Attempts differently (a verify round grades each Attempt over its own Evidence). Wins over
    /// `answers` when it returns a script.
    pub answers_for: Option<AnswersFor>,
    /// Fail the asks whose Evidence it selects, for a suite that needs one port to answer one Attempt
    /// and fall back on another. Checked after `cause`, which fails every ask.
    pub fail_for: Option<FailFor>,
    /// Fall back with this cause on every ask instead of answering.
    pub cause: Option<JevCause>,
    /// Report as unconfigured (every ask falls back with `not-configured`) when `Some(false)`.
    pub configured: Option<bool>,
}

/// One ask the fake took.
#[derive(Debug, Clone, PartialEq)]
pub struct FakeAsk {
    pub evidence: Evidence,
    pub questions: Questions,
}

/// The port fake.
pub struct FakeJev {
    board: NoticeBoard,
    configured: bool,
    state: Mutex<State>,
    answers_for: Option<AnswersFor>,
    fail_for: Option<FailFor>,
}

struct State {
    answers: Script,
    cause: Option<JevCause>,
    asks: Vec<FakeAsk>,
}

impl FakeJev {
    pub fn new(options: FakeJevOptions) -> Self {
        let configured = options.configured.unwrap_or(true);
        let cause = if configured {
            options.cause
        } else {
            Some(JevCause::NotConfigured)
        };
        FakeJev {
            board: NoticeBoard::new(),
            configured,
            state: Mutex::new(State {
                answers: options.answers,
                cause,
                asks: Vec::new(),
            }),
            answers_for: options.answers_for,
            fail_for: options.fail_for,
        }
    }

    /// Change what later asks do, to play a recovery or a new cause mid-test: new answers when given,
    /// and the cause as given.
    pub fn script(&self, answers: Option<Script>, cause: Option<JevCause>) {
        let mut state = self.lock();
        if let Some(answers) = answers {
            state.answers = answers;
        }
        state.cause = cause;
    }

    /// Every ask taken so far, in order.
    pub fn asks(&self) -> Vec<FakeAsk> {
        self.lock().asks.clone()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn ask_now(&self, evidence: &Evidence, questions: &Questions) -> JevResult {
        let (cause, answers) = {
            let mut state = self.lock();
            state.asks.push(FakeAsk {
                evidence: evidence.clone(),
                questions: questions.clone(),
            });
            (state.cause, state.answers.clone())
        };
        if let Some(cause) = cause {
            self.board.fell_back(cause, SCRIPTED_DETAIL);
            return JevResult::FellBack {
                cause,
                detail: SCRIPTED_DETAIL.to_owned(),
            };
        }
        if let Some((cause, detail)) = self.fail_for.as_ref().and_then(|f| f(evidence)) {
            let detail = detail.unwrap_or_else(|| SCRIPTED_DETAIL.to_owned());
            self.board.fell_back(cause, &detail);
            return JevResult::FellBack { cause, detail };
        }
        let scripted = self
            .answers_for
            .as_ref()
            .and_then(|f| f(evidence))
            .unwrap_or(answers);
        let answers = questions
            .iter()
            .map(|(id, question)| {
                let value = answer_for(question, scripted.get(id));
                let judgement = Judgement::from_value(question, &value).unwrap_or_else(|| {
                    panic!(
                        "the fake's scripted answer for {id} is not a {}",
                        question.kind()
                    )
                });
                (id.clone(), judgement)
            })
            .collect();
        self.board.succeeded();
        JevResult::Answered(Answered {
            answers,
            usage: Some(Usage {
                input_tokens: 0.0,
                output_tokens: 0.0,
            }),
            model: Some(JEV_MODEL.to_owned()),
        })
    }
}

impl Jev for FakeJev {
    fn configured(&self) -> bool {
        self.configured
    }

    fn ask<'a>(
        &'a self,
        evidence: &'a Evidence,
        questions: &'a Questions,
    ) -> BoxFuture<'a, JevResult> {
        Box::pin(async move { self.ask_now(evidence, questions) })
    }

    fn subscribe(&self, listener: NoticeListener) -> Unsubscribe {
        self.board.subscribe(listener)
    }
}
