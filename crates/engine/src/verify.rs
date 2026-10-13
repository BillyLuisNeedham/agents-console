//! Verify (engine.ts 6559-6627, 7145-8845): graders, Jev grading, Selection, head-to-head, Adopt.
//!
//! A verify round (`verify: N`) runs N Candidates of one Ticket, each on its own attempt branch, and the
//! drive grades them here: through Jev when the pool holds a key (ADR-0023), else through grader Tickets
//! the engine writes and runs (and re-spawns up to twice). The grades then decide: a lone attempt at the
//! Ticket, a paused round's checkpoint (ADR-0034), or Selection, whose tight band is the head-to-head
//! Ticket's. A human selection and an Adopt (ADR-0035) complete Selection the same way.
//!
//! The TypeScript's `emit` callback is `emit_snapshot(s, Running)`. Where it passed a no-op (a human
//! selection and an Adopt, which the answer drain emits for), the functions take no emit.

use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

use futures::future::join_all;
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Map, Value};

use ac_core::assignment::{
    Assignment, grader_id_for, head_to_head_id_for, resolve_engine_ticket_assignment,
};
use ac_core::events::{
    append_event, attempt_log_name, attempt_outcome_name, event_now, last_attempt, next_attempt,
    read_events,
};
use ac_core::jev_evidence::{BuiltEvidence, EvidenceInput, build_evidence};
use ac_core::jev_rubric::{QUESTIONS, RUBRIC_VERSION, THRESHOLDS, compose};
use ac_core::js;
use ac_core::outcome::{ValidOutcome, validate_outcome};
use ac_core::pool::{
    TicketMarker, is_finished, load_pool_tickets, read_marker, write_marker_status,
};
use ac_core::verify_prompts::{
    GraderPromptParts, HeadToHeadPromptParts, HeadToHeadSideParts, build_grader_prompt,
    build_head_to_head_prompt,
};
use ac_io::git::{self, MergeFailure, MergeResult, WorktreeInfo};
use ac_io::jev::JevResult;
use ac_protocol::{
    EvidenceBudget, Grade, GradeVerdict, Interrupt, InterruptKind, Outcome, QueuedAnswer, RunPhase,
    SpawnKind, TicketEventKind, TicketStatus,
};

use crate::actor::Engine;
use crate::attempt_ending::read_attempt_result;
use crate::attempt_run::{
    AttemptEvents, AttemptNaming, AttemptSpec, CrashSubject, Fallback, PromptDelivery, Rotate,
    run_attempt,
};
use crate::interrupts::{
    ENGINE_CHECKPOINT_PLACEHOLDER, interrupt, land_checkpoint_brief, raise_checkpoint,
    raise_interrupt,
};
use crate::jev::Jev;
use crate::merges::{
    EngineHoldHost, hold_poll, merge_target_ref, merge_target_sha, merge_ticket, merged_payload,
    through_merge_hold,
};
use crate::restart::abandon_adoption;
use crate::session::{PoolUpdate, Session};
use crate::snapshot::emit_snapshot;
use crate::spawns::take_spawn_proposals;
use crate::tickets::{TicketResult, attempt_env_of, close_attempt_tab};

// The grader's driver name, under the same contract as the resolver's: a real harness invokes it as a
// command stub, so a pool that grades on real harnesses needs a `verify` command written where the
// harness looks for commands.
const GRADER_DRIVER: &str = "verify";

// The head-to-head judge's driver name, same contract as the grader's.
const HEAD_TO_HEAD_DRIVER: &str = "head-to-head";

// The attempt log handed to a grader is capped at roughly 20k tokens, at the usual ~4 characters per
// token. Lengths are in UTF-16 code units, as JavaScript counts them.
const GRADER_TRIM_CHARS: usize = 80_000;

// The re-spawn bound: a crashed grader is re-spawned at most this many times per fan-out round before
// the engine gives up on it.
const GRADER_RESPAWN_LIMIT: u64 = 2;

static FIRST_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d+)").expect("the number pattern compiles"));

/// Why an Adopt (ADR-0035) cannot take this attempt from this Interrupt, or `None` when it can. Only a
/// paused verify round's checkpoint names Candidates to adopt.
pub fn adopt_refusal(interrupt: &Interrupt, attempt: u64) -> Option<String> {
    if interrupt.kind != InterruptKind::Checkpoint {
        return Some(format!(
            "answer: adopt takes a paused verify round's checkpoint interrupt, got {} for {}",
            interrupt.kind, interrupt.ticket_id
        ));
    }
    let candidates = interrupt.candidates.clone().unwrap_or_default();
    if candidates.is_empty() {
        return Some(format!(
            "answer: {}'s checkpoint names no finished candidate to adopt; resume or close it",
            interrupt.ticket_id
        ));
    }
    if !candidates.contains(&attempt) {
        return Some(format!(
            "answer: adopt must name one of the finished candidates ({}); got attempt {attempt} for {}",
            join_numbers(&candidates),
            interrupt.ticket_id
        ));
    }
    None
}

fn join_numbers(numbers: &[u64]) -> String {
    numbers
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// The answer's attempt number: the first integer in the note, so "2", "attempt 2" and "merge
/// attempt-2 please" all name attempt 2.
pub fn parse_selection_answer(note: Option<&str>) -> Option<u64> {
    let text = ac_core::js::trim(note.unwrap_or(""));
    FIRST_NUMBER
        .captures(text)
        .map(|caps| caps[1].parse::<u64>().unwrap_or(u64::MAX))
}

/// The refusal of a selection answer that names no candidate.
pub fn selection_answer_error(interrupt: &Interrupt, note: Option<&str>) -> String {
    format!(
        "selection answer must name one of the candidate attempts ({}); got {}",
        join_numbers(interrupt.candidates.as_deref().unwrap_or(&[])),
        ac_core::js::to_json(note.unwrap_or(""))
    )
}

// ---------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------

fn runs(session: &Session) -> &Path {
    Path::new(&session.runs_dir)
}

fn runs_file(session: &Session, name: &str) -> String {
    js::path_join(&[&session.runs_dir, name])
}

fn marker_file(marker: &TicketMarker) -> String {
    js::path_text(&marker.file)
}

fn read_optional(path: &str) -> Option<String> {
    if js::exists(path) {
        js::read_text(path).ok()
    } else {
        None
    }
}

fn attempt_number(attempt: u64) -> Option<u32> {
    Some(u32::try_from(attempt).unwrap_or(u32::MAX))
}

fn emit_running(session: &mut Session) {
    emit_snapshot(session, RunPhase::Running);
}

fn append(
    session: &Session,
    ticket_id: &str,
    attempt: u64,
    kind: TicketEventKind,
    payload: Map<String, Value>,
) -> anyhow::Result<()> {
    append_event(runs(session), ticket_id, &event_now(attempt, kind, payload))?;
    Ok(())
}

// The engine writes a ticket's marker line, and the session's marker agrees.
fn set_marker_status(
    session: &mut Session,
    marker: &TicketMarker,
    status: TicketStatus,
) -> anyhow::Result<()> {
    write_marker_status(&marker.file, status)?;
    if let Some(own) = session.marker_mut(&marker.id) {
        own.status = status;
    }
    Ok(())
}

/// `workAttemptOf`: the attempt whose worktree and branch an attempt's work lives in: itself, or for a
/// Continued attempt the one its chain began at, as its `spawned` event recorded (issue #139).
pub fn work_attempt_of(session: &Session, ticket_id: &str, attempt: u64) -> u64 {
    read_events(runs(session), ticket_id)
        .iter()
        .rev()
        .find(|event| event.kind == TicketEventKind::Spawned && event.attempt == attempt)
        .and_then(|event| event.payload.get("work_attempt"))
        .and_then(js::number_of)
        .map_or(attempt, |work| work as u64)
}

fn score_text(score: f64) -> String {
    js::number_string(score)
}

/// `gradedPayload`: the Grade plus whichever provenance fields it carries.
fn graded_payload(grade: &Grade) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("score".into(), js::number_value(grade.score));
    payload.insert("verdict".into(), Value::String(grade.verdict.to_string()));
    payload.insert("reasons".into(), Value::String(grade.reasons.clone()));
    if let Some(rubric) = &grade.rubric {
        payload.insert("rubric".into(), Value::String(rubric.clone()));
    }
    if let Some(model) = &grade.model {
        payload.insert("model".into(), Value::String(model.clone()));
    }
    if let Some(budget) = grade.evidence_budget {
        payload.insert("evidenceBudget".into(), Value::String(budget.to_string()));
    }
    payload
}

// ---------------------------------------------------------------------------------------------------
// The grader's Outcome and the artifacts handed to a grader
// ---------------------------------------------------------------------------------------------------

/// The grader's outcome: the standard contract plus a validated grade.
#[derive(Debug, Clone, PartialEq)]
pub struct GradeResult {
    pub outcome: Outcome,
    pub grade: Grade,
}

/// `validateGrade`: anything that is not a valid grade is unusable rather than a low score or a silent
/// pass, so a broken grader can never decide the build ticket's fate. A checkpoint outcome is unusable
/// too: the grader's contract is one done outcome carrying its grade.
pub fn validate_grade(parsed: &Value) -> Result<GradeResult, String> {
    let base = validate_outcome(parsed)?;
    if base.outcome.status != ac_protocol::OutcomeStatus::Done {
        return Err("grader outcome is a checkpoint, not a grade".into());
    }
    let grade = parsed.get("grade");
    if !matches!(grade, Some(Value::Object(_) | Value::Array(_))) {
        return Err("outcome carries no grade object".into());
    }
    let field = |key: &str| grade.and_then(|grade| grade.get(key));
    let score = match field("score").and_then(Value::as_f64) {
        Some(score) if score.is_finite() && (0.0..=10.0).contains(&score) => score,
        _ => return Err("grade has no score in 0..10".into()),
    };
    let verdict = match field("verdict").and_then(Value::as_str) {
        Some("pass") => GradeVerdict::Pass,
        Some("flag") => GradeVerdict::Flag,
        _ => return Err("grade verdict is not pass or flag".into()),
    };
    let Some(reasons) = field("reasons").and_then(Value::as_str) else {
        return Err("grade has no reasons string".into());
    };
    // Provenance (ADR-0023) is optional: an agent grader writes none and the Grade validates
    // unchanged.
    Ok(GradeResult {
        outcome: base.outcome,
        grade: Grade {
            score,
            verdict,
            reasons: reasons.to_owned(),
            rubric: field("rubric").and_then(Value::as_str).map(str::to_owned),
            model: field("model").and_then(Value::as_str).map(str::to_owned),
            evidence_budget: match field("evidenceBudget").and_then(Value::as_str) {
                Some("base") => Some(EvidenceBudget::Base),
                Some("widened") => Some(EvidenceBudget::Widened),
                _ => None,
            },
        },
    })
}

/// `trimTail`: the attempt log's tail, capped at about 20k tokens, so a huge log cannot blow the
/// grader's window. A trimmed copy opens with a notice naming the cut; a log within the budget passes
/// through whole.
pub fn trim_tail(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= GRADER_TRIM_CHARS {
        return text.to_owned();
    }
    let mut tail = &units[units.len() - GRADER_TRIM_CHARS..];
    if let Some(newline) = tail.iter().position(|unit| *unit == u16::from(b'\n'))
        && newline < tail.len() - 1
    {
        tail = &tail[newline + 1..];
    }
    format!(
        "[log trimmed to the last ~20k tokens; {} of {} characters shown]\n{}",
        tail.len(),
        units.len(),
        String::from_utf16_lossy(tail)
    )
}

/// `attemptDiff`: the attempt's work as a diff: the attempt branch against the commit it was cut from,
/// so sibling merges onto the working branch during the fan-out never leak into one attempt's grade. A
/// Continued attempt works on the branch of the attempt its chain began at, so that is the one read.
fn attempt_diff(session: &Session, build_id: &str, attempt: u64) -> String {
    if !session.git {
        return "(no diff: the pool does not run in git)\n".into();
    }
    let work = attempt_number(work_attempt_of(session, build_id, attempt));
    let branch = git::branch_for(&session.cwd, build_id, work);
    if !git::branch_exists(&session.cwd, build_id, work) {
        return format!("(no diff: no attempt branch {branch})\n");
    }
    let Some(base) = git::merge_base(&session.cwd, "HEAD", &branch) else {
        return "(no diff: no common ancestor with the attempt branch)\n".into();
    };
    let diff = git::git(&session.cwd, ["diff", &format!("{base}..{branch}")]);
    if !diff.ok {
        return "(no diff: git diff failed)\n".into();
    }
    diff.out
}

/// `attemptDiffParts`: the Attempt diff split into its text and why there is none, the shape the
/// Evidence builder wants: `-U0` changed lines on the base budget, context lines on the widening
/// re-ask (ADR-0023).
fn attempt_diff_parts(
    session: &Session,
    build_id: &str,
    attempt: u64,
    no_context: bool,
) -> (String, Option<String>) {
    if !session.git {
        return (String::new(), Some("the pool does not run in git".into()));
    }
    let work = attempt_number(work_attempt_of(session, build_id, attempt));
    let branch = git::branch_for(&session.cwd, build_id, work);
    if !git::branch_exists(&session.cwd, build_id, work) {
        return (String::new(), Some(format!("no attempt branch {branch}")));
    }
    let Some(base) = git::merge_base(&session.cwd, "HEAD", &branch) else {
        return (
            String::new(),
            Some("no common ancestor with the attempt branch".into()),
        );
    };
    let range = format!("{base}..{branch}");
    let mut args = vec!["diff"];
    if no_context {
        args.push("-U0");
    }
    args.push(&range);
    let diff = git::git(&session.cwd, args);
    if !diff.ok {
        return (String::new(), Some("git diff failed".into()));
    }
    (diff.out, None)
}

/// `attemptOutcomeSummary`: the attempt's Outcome summary, the agent's claim about its own work. Never
/// the whole outcome: only the summary is Evidence.
fn attempt_outcome_summary(session: &Session, build_id: &str, attempt: u64) -> String {
    let path = runs_file(
        session,
        &attempt_outcome_name(build_id, Some(attempt), false),
    );
    let Some(raw) = read_optional(&path) else {
        return String::new();
    };
    js::parse(&raw)
        .ok()
        .and_then(|parsed| {
            parsed
                .get("summary")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

/// `buildAttemptEvidence`: one Attempt's Evidence at one budget (ADR-0023): the Ticket text, the
/// summary claim, the changed-lines or full-context diff, and the ANSI-stripped log tail.
fn build_attempt_evidence(
    session: &Session,
    build: &TicketMarker,
    attempt: u64,
    widened: bool,
) -> BuiltEvidence {
    let (diff, reason) = attempt_diff_parts(session, &build.id, attempt, !widened);
    let ticket = read_optional(&marker_file(build)).unwrap_or_default();
    let summary = attempt_outcome_summary(session, &build.id, attempt);
    let log = read_optional(&runs_file(
        session,
        &attempt_log_name(&build.id, Some(attempt), false),
    ))
    .unwrap_or_else(|| "(no attempt log was recorded)\n".to_owned());
    build_evidence(&EvidenceInput {
        ticket: &ticket,
        summary: &summary,
        diff: &diff,
        diff_reason: reason.as_deref(),
        log: &log,
        widened,
    })
}

// ---------------------------------------------------------------------------------------------------
// Grading a round
// ---------------------------------------------------------------------------------------------------

/// `gradeRound`: one verify round's grades, by attempt number, through the grading path switch
/// (ADR-0023): with a Jev key the round is graded in code, every Attempt over its own Evidence, and no
/// grader tickets are written. Without a key, or when any ask falls back, the grader tickets run; never
/// both in one round. Shared by the drive's fan-out and a verify ticket's Continued attempt (issue
/// #139), which is a round of one.
pub async fn grade_round(
    engine: &Engine,
    marker: &TicketMarker,
    attempts: &[u64],
) -> anyhow::Result<HashMap<u64, Grade>> {
    let jev = engine.call(|s| s.jev.clone()).await?;
    if !jev.configured() {
        return run_graders(engine, marker, attempts).await;
    }
    match run_jev_graders(engine, &jev, marker, attempts).await? {
        JevGrading::FellBack {
            attempt,
            cause,
            detail,
        } => {
            let line = format!(
                "ticket {}: Jev could not grade attempt {attempt} ({cause}: {detail}); falling back \
                 to grader tickets",
                marker.id
            );
            engine.call(move |s| s.log(line)).await?;
            run_graders(engine, marker, attempts).await
        }
        JevGrading::Graded(grades) => {
            // Named before the per-attempt lines, so the pool log reads in order; it is written only
            // once the whole round has an answer, because a fallback means the round was never Jev's.
            let (marker, attempts, round) = (marker.clone(), attempts.to_vec(), grades.clone());
            engine
                .call(move |s| -> anyhow::Result<()> {
                    s.log(format!(
                        "ticket {}: grading {} attempt{} with Jev",
                        marker.id,
                        attempts.len(),
                        if attempts.len() == 1 { "" } else { "s" }
                    ));
                    for attempt in &attempts {
                        if let Some(grade) = round.get(attempt) {
                            record_jev_grade(s, &marker, *attempt, grade)?;
                        }
                    }
                    Ok(())
                })
                .await??;
            Ok(grades)
        }
    }
}

/// What the Jev grading path came to: every Attempt's Grade, or the one ask that could not be answered.
enum JevGrading {
    Graded(HashMap<u64, Grade>),
    FellBack {
        attempt: u64,
        cause: ac_io::jev::JevCause,
        detail: String,
    },
}

/// `runJevGraders`: grade every Attempt of one verify round in code, over its own Evidence, with no
/// grader ticket. One round is graded by one instrument: any ask that cannot be answered, for any
/// cause, abandons the whole round (no grade is recorded) and the caller runs the grader agents
/// instead.
async fn run_jev_graders(
    engine: &Engine,
    jev: &Jev,
    build: &TicketMarker,
    attempts: &[u64],
) -> anyhow::Result<JevGrading> {
    let mut grades = HashMap::new();
    for &attempt in attempts {
        let marker = build.clone();
        let base = engine
            .call(move |s| build_attempt_evidence(s, &marker, attempt, false))
            .await?;
        let mut answered = match jev.ask(&base.evidence, &QUESTIONS).await {
            JevResult::Answered(answered) => answered,
            JevResult::FellBack { cause, detail } => {
                return Ok(JevGrading::FellBack {
                    attempt,
                    cause,
                    detail,
                });
            }
        };
        let mut budget = EvidenceBudget::Base;
        // Low ticket-fit confidence on trimmed Evidence widens once, then accepts whatever comes back
        // (ADR-0023): the grade is marked low-confidence and flagged, never handed to a second
        // instrument.
        let confidence = answered
            .answers
            .get("ticket_fit")
            .and_then(|judgement| judgement.confidence());
        if confidence.is_some_and(|confidence| confidence < THRESHOLDS.low_confidence)
            && base.trimmed
        {
            let marker = build.clone();
            let widened = engine
                .call(move |s| build_attempt_evidence(s, &marker, attempt, true))
                .await?;
            answered = match jev.ask(&widened.evidence, &QUESTIONS).await {
                JevResult::Answered(answered) => answered,
                JevResult::FellBack { cause, detail } => {
                    return Ok(JevGrading::FellBack {
                        attempt,
                        cause,
                        detail,
                    });
                }
            };
            budget = EvidenceBudget::Widened;
        }
        let composed = compose(&answered.answers);
        grades.insert(
            attempt,
            Grade {
                score: composed.score10,
                verdict: composed.verdict,
                reasons: composed.reasons,
                rubric: Some(RUBRIC_VERSION.to_owned()),
                model: answered.model,
                evidence_budget: Some(budget),
            },
        );
    }
    Ok(JevGrading::Graded(grades))
}

/// `recordJevGrade`: record one Jev-composed Grade exactly where a grader ticket's Grade lands: the
/// graded event on the build ticket's file. No grader ticket exists to write a status for; the build
/// ticket stays in-progress until selection decides.
fn record_jev_grade(
    session: &mut Session,
    build: &TicketMarker,
    attempt: u64,
    grade: &Grade,
) -> anyhow::Result<()> {
    append(
        session,
        &build.id,
        attempt,
        TicketEventKind::Graded,
        graded_payload(grade),
    )?;
    session.log(format!(
        "ticket {}: attempt {attempt} graded: score {}, verdict {} (Jev {}, {} evidence)",
        build.id,
        score_text(grade.score),
        grade.verdict,
        grade.rubric.as_deref().unwrap_or(RUBRIC_VERSION),
        grade
            .evidence_budget
            .map_or("base".to_owned(), |budget| budget.to_string())
    ));
    emit_running(session);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------
// Grader tickets
// ---------------------------------------------------------------------------------------------------

/// `engineSpawnSet`: the engine-run flows' spawn set, the three sites that share it being grading's
/// initial round, its re-spawn rounds and the head-to-head judge. The recompute is the ready set over
/// the flow's proposal; an all-engine proposal returns empty for no reason but the hold, so the rule's
/// re-wait on a held recompute keeps a judge spawn from ever destructuring an empty set.
async fn engine_spawn_set(
    engine: &Engine,
    candidates: Vec<TicketMarker>,
) -> anyhow::Result<Vec<TicketMarker>> {
    let host = EngineHoldHost(engine);
    through_merge_hold(
        &host,
        || {
            let engine = engine.clone();
            let candidates = candidates.clone();
            async move {
                Ok(engine
                    .call(move |s| crate::drive::ready_set(s, &candidates))
                    .await?)
            }
        },
        hold_poll(),
    )
    .await
}

/// `writeGraderTicket`: a real ticket in the pool's directory, with the ordinary blocking edge from its
/// build ticket, so it renders as a node card and its assignment is editable like any ticket's. The
/// engine rewrites it every time the build's fan-out completes, so a re-round rebinds the same card to
/// the round's new attempt.
fn write_grader_ticket(
    session: &Session,
    build: &TicketMarker,
    index: u64,
    attempt: u64,
) -> anyhow::Result<()> {
    let gid = grader_id_for(&build.id, index);
    let outcome_path = runs_file(
        session,
        &attempt_outcome_name(&build.id, Some(attempt), false),
    );
    let diff_path = runs_file(session, &format!("{gid}.diff.patch"));
    let log_path = runs_file(session, &format!("{gid}.trim.log"));
    let build_id = &build.id;
    let build_file = marker_file(build);
    let body = format!(
        "<!-- state: id={gid} blocked-by={build_id} status=ready -->\n\n\
         # {gid}: grade attempt {attempt} of ticket {build_id}\n\n\
         **Grader for:** ticket {build_id}, attempt {attempt}.\n\n\
         **Bound artifacts:** ticket file `{build_file}`; outcome `{outcome_path}`; diff \
         `{diff_path}`; trimmed log `{log_path}`.\n\n\
         The engine wrote this ticket when every attempt of ticket {build_id} had exited, and runs \
         it through the pool's ordinary assign machinery: an `assign` entry for this id in \
         console.json overrides the build ticket's harness and model. Its prompt is the pool's \
         verify skill parameterized with the artifacts above, and the grade travels in this \
         ticket's outcome JSON. Graders write no status, raise no interrupts, and merge nothing.\n"
    );
    js::write_file(runs_parent_issue(session, &format!("{gid}.md")), &body)?;
    Ok(())
}

fn runs_parent_issue(session: &Session, name: &str) -> String {
    js::path_join(&[&session.issues_dir, name])
}

/// One grader awaiting a usable grade, carried across re-spawn rounds with the reason its last run
/// failed (the re-spawn event and the exhaustion interrupt both name it).
#[derive(Clone)]
struct PendingGrader {
    marker: TicketMarker,
    assignment: Assignment,
    attempt: u64,
    last_reason: String,
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// `runGraders`: grading one verify ticket's exited fan-out: write the grader tickets, then run them
/// all through their resolved assignments. A grader whose run produced no usable grade is re-spawned
/// for the same attempt, in parallel per round, until every grader has graded or the bound is
/// exhausted and a crash interrupt hands the build ticket to the human. Returns the usable grades by
/// attempt number; a grader that never graded leaves its attempt unmapped.
async fn run_graders(
    engine: &Engine,
    build: &TicketMarker,
    attempts: &[u64],
) -> anyhow::Result<HashMap<u64, Grade>> {
    let (build_c, attempts_c) = (build.clone(), attempts.to_vec());
    let (build_assignment, mut pending) = engine
        .call(
            move |s| -> anyhow::Result<(Assignment, Vec<PendingGrader>)> {
                for (index, attempt) in attempts_c.iter().enumerate() {
                    write_grader_ticket(s, &build_c, index as u64 + 1, *attempt)?;
                }
                s.markers = load_pool_tickets(Path::new(&s.pool_dir), false)?;
                let build_assignment =
                    s.assignments.get(&build_c.id).cloned().ok_or_else(|| {
                        anyhow::anyhow!("no assignment for ticket {}", build_c.id)
                    })?;
                let mut pending = Vec::new();
                for (index, attempt) in attempts_c.iter().enumerate() {
                    let id = grader_id_for(&build_c.id, index as u64 + 1);
                    let marker = s
                        .marker(&id)
                        .cloned()
                        .ok_or_else(|| anyhow::anyhow!("grader ticket {id} was not written"))?;
                    let assignment = resolve_engine_ticket_assignment(
                        &s.state.config,
                        &marker,
                        &build_assignment,
                        &s.harnesses,
                    )?;
                    s.assignments.insert(marker.id.clone(), assignment.clone());
                    pending.push(PendingGrader {
                        marker,
                        assignment,
                        attempt: *attempt,
                        last_reason: String::new(),
                    });
                }
                Ok((build_assignment, pending))
            },
        )
        .await??;
    // The verify flow's spawn set routes through the one entry point via the shared engine-run helper:
    // the merge hold is the one rule that can withhold the graders.
    let spawnable =
        engine_spawn_set(engine, pending.iter().map(|g| g.marker.clone()).collect()).await?;
    pending.retain(|g| spawnable.iter().any(|m| m.id == g.marker.id));
    let (build_c, round) = (build.clone(), pending.clone());
    let attempt_count = attempts.len();
    engine
        .call(move |s| -> anyhow::Result<()> {
            s.log(format!(
                "ticket {}: grading {attempt_count} attempt{} with grader tickets {}",
                build_c.id,
                plural(attempt_count),
                round
                    .iter()
                    .map(|g| g.marker.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            for grader in &round {
                let attempt = next_attempt(runs(s), &grader.marker.id);
                append(
                    s,
                    &grader.marker.id,
                    attempt,
                    TicketEventKind::Scheduled,
                    Map::new(),
                )?;
                s.apply(PoolUpdate {
                    tickets: Some(IndexMap::from([(
                        grader.marker.id.clone(),
                        TicketStatus::InProgress,
                    )])),
                    ..PoolUpdate::default()
                });
                set_marker_status(s, &grader.marker, TicketStatus::InProgress)?;
            }
            emit_running(s);
            Ok(())
        })
        .await??;
    let mut grades = HashMap::new();
    let mut round = 0u64;
    loop {
        let results = join_all(
            pending
                .iter()
                .map(|g| run_grader(engine, build, &g.marker, g.attempt, &g.assignment)),
        )
        .await;
        let mut still_pending = Vec::new();
        for (grader, result) in pending.iter().zip(results) {
            match result? {
                Ok(grade) => {
                    grades.insert(grader.attempt, grade);
                }
                Err(reason) => still_pending.push(PendingGrader {
                    last_reason: reason,
                    ..grader.clone()
                }),
            }
        }
        pending = still_pending;
        if pending.is_empty() {
            return Ok(grades);
        }
        if round >= GRADER_RESPAWN_LIMIT {
            let (build_c, exhausted) = (build.clone(), pending);
            engine
                .call(move |s| raise_grader_exhausted(s, &build_c, &exhausted))
                .await?;
            return Ok(grades);
        }
        let respawn = round + 1;
        // The re-spawn round's spawn set routes through the one entry point like the initial one: only
        // the graders it hands back run again, and an empty recompute is the merge hold re-engaged.
        let respawnable =
            engine_spawn_set(engine, pending.iter().map(|g| g.marker.clone()).collect()).await?;
        let (build_c, waiting, build_assignment_c) =
            (build.clone(), pending, build_assignment.clone());
        pending = engine
            .call(move |s| -> anyhow::Result<Vec<PendingGrader>> {
                let mut next = Vec::new();
                for grader in waiting
                    .into_iter()
                    .filter(|g| respawnable.iter().any(|m| m.id == g.marker.id))
                {
                    // The re-spawn resolves its assignment fresh, so an operator's mid-run edit to
                    // console.json lands on the very next grader run.
                    let assignment = resolve_engine_ticket_assignment(
                        &s.state.config,
                        &grader.marker,
                        &build_assignment_c,
                        &s.harnesses,
                    )?;
                    s.assignments
                        .insert(grader.marker.id.clone(), assignment.clone());
                    // The re-spawn marker and the schedule it opens share one attempt number: they are
                    // one lifecycle moment, and the fresh run's spawned event reads its attempt back
                    // from here.
                    let attempt_no = next_attempt(runs(s), &grader.marker.id);
                    let mut payload = Map::new();
                    payload.insert("build".into(), Value::String(build_c.id.clone()));
                    payload.insert("gradedAttempt".into(), Value::from(grader.attempt));
                    payload.insert("reason".into(), Value::String(grader.last_reason.clone()));
                    payload.insert("respawn".into(), Value::from(respawn));
                    append(
                        s,
                        &grader.marker.id,
                        attempt_no,
                        TicketEventKind::GraderRespawn,
                        payload,
                    )?;
                    append(
                        s,
                        &grader.marker.id,
                        attempt_no,
                        TicketEventKind::Scheduled,
                        Map::new(),
                    )?;
                    s.log(format!(
                        "ticket {}: re-spawning grader {} for attempt {} (respawn {respawn} of \
                         {GRADER_RESPAWN_LIMIT})",
                        build_c.id, grader.marker.id, grader.attempt
                    ));
                    next.push(PendingGrader {
                        assignment,
                        ..grader
                    });
                }
                emit_running(s);
                Ok(next)
            })
            .await??;
        round = respawn;
    }
}

/// `raiseGraderExhausted`: every re-spawn also crashed: stop retrying and raise a crash interrupt on the
/// build ticket, so the broken grader surfaces to the human. The build ticket's marker keeps the
/// in-progress the fan-out gave it; answering the interrupt with resume sends the ticket through a fresh
/// fan-out round, whose grader cards are rewritten and whose bound starts over.
fn raise_grader_exhausted(
    session: &mut Session,
    build: &TicketMarker,
    exhausted: &[PendingGrader],
) {
    let runs_count = GRADER_RESPAWN_LIMIT + 1;
    let body = exhausted
        .iter()
        .map(|g| {
            format!(
                "grader {} gave no usable grade for attempt {} after {runs_count} runs (last crash: \
                 {}); grader log: {}",
                g.marker.id,
                g.attempt,
                g.last_reason,
                runs_file(session, &attempt_log_name(&g.marker.id, None, false))
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    raise_interrupt(session, interrupt(&build.id, InterruptKind::Crash, body));
    session.apply(PoolUpdate::log(exhausted.iter().map(|g| {
        format!(
            "ticket {}: grader {} gave no usable grade for attempt {} after {runs_count} runs; \
             crash interrupt raised for the build ticket",
            build.id, g.marker.id, g.attempt
        )
    })));
    emit_running(session);
}

/// One grader run's ending: a usable grade, or the reason the run decided nothing (a dead harness, an
/// unparseable outcome, a pause).
type GraderRun = Result<Grade, String>;

/// What a grader run needs from the session, read in one stretch before the attempt launches.
struct GraderLaunch {
    spec_body: String,
    grader_attempt: u64,
    env: crate::attempt_run::AttemptEnv,
}

async fn run_grader(
    engine: &Engine,
    build: &TicketMarker,
    grader: &TicketMarker,
    attempt: u64,
    assignment: &Assignment,
) -> anyhow::Result<GraderRun> {
    let (build_c, grader_c) = (build.clone(), grader.clone());
    let launch = engine
        .call(move |s| -> anyhow::Result<GraderLaunch> {
            let gid = grader_c.id.clone();
            let grader_outcome_path = runs_file(s, &attempt_outcome_name(&gid, None, false));
            let attempt_outcome_path =
                runs_file(s, &attempt_outcome_name(&build_c.id, Some(attempt), false));
            let diff_path = runs_file(s, &format!("{gid}.diff.patch"));
            let trim_path = runs_file(s, &format!("{gid}.trim.log"));
            js::write_file(&diff_path, &attempt_diff(s, &build_c.id, attempt))?;
            let log = read_optional(&runs_file(
                s,
                &attempt_log_name(&build_c.id, Some(attempt), false),
            ))
            .unwrap_or_else(|| "(no attempt log was recorded)\n".to_owned());
            js::write_file(&trim_path, &trim_tail(&log))?;
            // Read fresh at every grading round, like AGENT.md at every spawn: an operator's mid-run
            // edit lands in the very next grader's prompt.
            let skill = read_optional(&js::path_join(&[&s.pool_dir, "verify.md"]));
            let prompt = build_grader_prompt(&GraderPromptParts {
                build_id: &build_c.id,
                attempt,
                skill: skill.as_deref(),
                ticket_path: &marker_file(&build_c),
                outcome_path: &attempt_outcome_path,
                diff_path: &diff_path,
                log_path: &trim_path,
                grader_outcome_path: &grader_outcome_path,
            });
            // The grader ticket's own attempt number for this round: the scheduled event bumped
            // lastAttempt to this round's number, so the value read here (before this round's spawned
            // append) is the one the events and the verdict-landed tab close both key off.
            Ok(GraderLaunch {
                spec_body: prompt,
                grader_attempt: last_attempt(runs(s), &gid),
                env: attempt_env_of(s, None),
            })
        })
        .await??;
    let grader_attempt = launch.grader_attempt;
    // The grader's run is the Attempt-run module's (ADR-0014): the exited status on a usable grade is
    // done, and the crash reason on the failure path is the run's.
    let run = run_attempt(
        &launch.env,
        AttemptSpec {
            id: grader.id.clone(),
            issue_path: marker_file(grader),
            title: grader.title.clone(),
            body: launch.spec_body,
            driver: GRADER_DRIVER.to_owned(),
            harness: assignment.harness.clone(),
            model: assignment.model.clone(),
            effort: assignment
                .effort
                .clone()
                .filter(|effort| !effort.is_empty()),
            cwd: engine.call(|s| s.cwd.clone()).await?,
            branch: None,
            attempt: grader_attempt,
            naming: AttemptNaming {
                attempt: None,
                resolver: false,
            },
            rotate: Rotate::Exited,
            fallback: Fallback::Headless,
            prompt: PromptDelivery::Driver,
            crash_subject: CrashSubject::Harness,
            events: AttemptEvents::Full {
                exited_status: |_: &GradeResult| TicketStatus::Done,
                result_events: None,
            },
        },
        validate_grade,
    )
    .await?;
    let (build_c, grader_c) = (build.clone(), grader.clone());
    match (run.ok(), run.result) {
        (true, Ok(result)) => {
            engine
                .call(move |s| -> anyhow::Result<GraderRun> {
                    // A usable grade: the engine writes the grader's done status (ADR-0005: the engine
                    // owns every status write) and copies the grade into the graded attempt's record,
                    // a graded event on the build ticket's file.
                    set_marker_status(s, &grader_c, TicketStatus::Done)?;
                    let grade = &result.grade;
                    let mut payload = Map::new();
                    payload.insert("score".into(), js::number_value(grade.score));
                    payload.insert("verdict".into(), Value::String(grade.verdict.to_string()));
                    payload.insert("reasons".into(), Value::String(grade.reasons.clone()));
                    append(s, &build_c.id, attempt, TicketEventKind::Graded, payload)?;
                    // The grader's tab never merges, so its role ends the moment the verdict lands;
                    // a re-spawn round opens a fresh tab.
                    close_attempt_tab(s, &grader_c.id, grader_attempt);
                    s.apply(PoolUpdate {
                        tickets: Some(IndexMap::from([(grader_c.id.clone(), TicketStatus::Done)])),
                        outcomes: Some(IndexMap::from([(
                            grader_c.id.clone(),
                            result.outcome.clone(),
                        )])),
                        log: Some(vec![format!(
                            "ticket {}: attempt {attempt} graded: score {}, verdict {} (grader {})",
                            build_c.id,
                            score_text(grade.score),
                            grade.verdict,
                            grader_c.id
                        )]),
                        ..PoolUpdate::default()
                    });
                    emit_running(s);
                    Ok(Ok(result.grade))
                })
                .await?
        }
        (_, _) => {
            let reason = run
                .crash_reason
                .unwrap_or_else(|| "produced no usable grade".to_owned());
            let failed = reason.clone();
            engine
                .call(move |s| {
                    record_grader_failure(s, &build_c, &grader_c, attempt, grader_attempt, &failed)
                })
                .await??;
            Ok(Err(reason))
        }
    }
}

/// `recordGraderFailure`: a grader that exited non-zero or wrote no parseable grade decides nothing:
/// the crash lands on the grader ticket (the run recorded its exited and crash events), its marker
/// stays in-progress, and the build ticket is untouched.
fn record_grader_failure(
    session: &mut Session,
    build: &TicketMarker,
    grader: &TicketMarker,
    attempt: u64,
    grader_attempt: u64,
    reason: &str,
) -> anyhow::Result<()> {
    // Whatever marker status the grader agent wrote for itself, the engine owns the write: a grader
    // without a usable grade is never done.
    if read_marker(&grader.file)?.status != TicketStatus::InProgress {
        write_marker_status(&grader.file, TicketStatus::InProgress)?;
    }
    // The failed round's tab is dead: the pane already exited and the re-spawn opens a fresh tab. The
    // round's own attempt number comes from the caller, not a re-read.
    close_attempt_tab(session, &grader.id, grader_attempt);
    session.log(format!(
        "ticket {}: grader {} produced no usable grade for attempt {attempt}: {reason}",
        build.id, grader.id
    ));
    emit_running(session);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------
// The lone attempt and a paused round
// ---------------------------------------------------------------------------------------------------

fn outcome_of(session: &Session, ticket_id: &str, attempt: u64) -> Result<ValidOutcome, String> {
    read_attempt_result(
        runs_file(
            session,
            &attempt_outcome_name(ticket_id, Some(attempt), false),
        ),
        validate_outcome,
    )
}

fn take_proposals(session: &mut Session, ticket_id: &str, outcome: &Outcome) -> anyhow::Result<()> {
    if let Some(proposals) = &outcome.spawn
        && !proposals.is_empty()
    {
        take_spawn_proposals(session, ticket_id, proposals.clone(), SpawnKind::Ticket)?;
    }
    Ok(())
}

/// `resolveLoneAttempt`: a verify: 1 ticket's grade decides at the ticket instead of at Review. A flag
/// verdict raises the checkpoint interrupt whose Brief is the grader's complaint; a pass verdict marks
/// the ticket done exactly as an unverified ticket is: the attempt branch merges through the existing
/// merge path and the engine writes the done status (ADR-0005). An attempt that paused or crashed made
/// no done-claim for the grade to verify: the agent's own checkpoint takes the checkpoint path, a crash
/// stays with its crash interrupt, and a missing grade leaves the ticket untouched for the grader
/// re-spawn.
pub fn resolve_lone_attempt(
    session: &mut Session,
    marker: &TicketMarker,
    result: &TicketResult,
    grade: Option<&Grade>,
) -> anyhow::Result<()> {
    let attempt = result.plan.attempt;
    // A crashed attempt decided nothing; the crash interrupt raised at the boundary owns the ticket and
    // a resume re-runs it.
    if result.status == TicketStatus::InProgress {
        return Ok(());
    }
    let outcome = outcome_of(session, &marker.id, attempt);
    if result.status == TicketStatus::Checkpoint {
        // The attempt paused, so there is no done-claim and the agent's own brief travels, exactly as
        // an unverified ticket's checkpoint does; the grade lands as context only and never overrides
        // a pause.
        checkpoint_ticket_by_engine(
            session,
            marker,
            attempt,
            outcome
                .as_ref()
                .ok()
                .and_then(|o| o.outcome.brief.as_deref()),
            format!(
                "ticket {}: attempt {attempt} checkpointed; its grade is context only and the \
                 attempt's own brief travels",
                marker.id
            ),
            true,
            None,
        )?;
        if let Ok(valid) = &outcome {
            session.apply(PoolUpdate {
                outcomes: Some(IndexMap::from([(marker.id.clone(), valid.outcome.clone())])),
                ..PoolUpdate::default()
            });
            take_proposals(session, &marker.id, &valid.outcome)?;
        }
        return Ok(());
    }
    let Some(grade) = grade else {
        return Ok(());
    };
    if grade.verdict == GradeVerdict::Flag {
        checkpoint_ticket_by_engine(
            session,
            marker,
            attempt,
            Some(&grade_complaint(grade)),
            format!(
                "ticket {}: attempt {attempt}'s grade was flagged; checkpoint raised with the \
                 grader's complaint as the Brief",
                marker.id
            ),
            true,
            None,
        )?;
        return Ok(());
    }
    complete_lone_attempt(session, marker, result, &outcome)
}

/// `checkpointFanOutRound`: a verify round holding a checkpointed candidate (ADR-0034): nothing is
/// selected and nothing merges, whatever the finished candidates scored, because a pause means an agent
/// met a decision or a guess it would not make, and taking a sibling's work would let that guess win
/// unseen. The ticket checkpoints. Its Brief carries each paused candidate's own brief, then a line for
/// every finished candidate with its grade and every crashed one with its reason. The lowest-numbered
/// paused candidate is the checkpoint's attempt, so its pane is the one held for Keep talking.
pub fn checkpoint_fan_out_round(
    session: &mut Session,
    marker: &TicketMarker,
    round: &[&TicketResult],
    grades: &HashMap<u64, Grade>,
) -> anyhow::Result<()> {
    let mut sorted: Vec<&TicketResult> = round.to_vec();
    sorted.sort_by_key(|r| r.plan.attempt);
    let paused: Vec<&&TicketResult> = sorted
        .iter()
        .filter(|r| r.status == TicketStatus::Checkpoint)
        .collect();
    let mut sections: Vec<String> = Vec::new();
    let mut paused_outcome: Option<Outcome> = None;
    for result in &sorted {
        let attempt = result.plan.attempt;
        if result.status == TicketStatus::Checkpoint {
            let outcome = outcome_of(session, &marker.id, attempt);
            if let Ok(valid) = &outcome
                && paused_outcome.is_none()
            {
                paused_outcome = Some(valid.outcome.clone());
            }
            let brief = outcome
                .as_ref()
                .ok()
                .and_then(|valid| valid.outcome.brief.as_deref())
                .map(js::trim)
                .filter(|brief| !brief.is_empty());
            sections.push(format!(
                "### Attempt {attempt} checkpointed\n\n{}",
                brief.unwrap_or(ENGINE_CHECKPOINT_PLACEHOLDER)
            ));
        } else if result.status == TicketStatus::Done {
            let graded = match grades.get(&attempt) {
                Some(grade) => format!(
                    "Graded {}/10, verdict {}.",
                    score_text(grade.score),
                    grade.verdict
                ),
                None => "It has no usable grade.".to_owned(),
            };
            let waits = if session.git {
                format!(
                    " Its work waits unmerged on {}.",
                    git::branch_for(&session.cwd, &marker.id, attempt_number(attempt))
                )
            } else {
                String::new()
            };
            sections.push(format!("### Attempt {attempt} finished\n\n{graded}{waits}"));
        } else {
            sections.push(format!(
                "### Attempt {attempt} crashed\n\n{}. Its log is {}.",
                result.crash_reason.as_deref().unwrap_or("crashed"),
                result.log_path
            ));
        }
    }
    // The Candidates the operator may adopt (ADR-0035): every one that finished done and was graded,
    // pass or flag. They ride on the Interrupt, persisted with it, so an Adopt is checked against this
    // exact round.
    let adoptable: Vec<u64> = sorted
        .iter()
        .filter(|r| r.status == TicketStatus::Done && grades.contains_key(&r.plan.attempt))
        .map(|r| r.plan.attempt)
        .collect();
    let mut brief = format!(
        "The verify round of {} attempts ended with {} checkpointed, so no candidate was selected \
         and nothing merged.\n\n{}\n\nAnswering resume resets the ticket to ready; the next round \
         runs a fresh fan-out and grades it again. Closing it ends the ticket without merging any \
         candidate.",
        sorted.len(),
        paused.len(),
        sections.join("\n\n")
    );
    if !adoptable.is_empty() {
        brief.push_str(&format!(
            " The operator may instead adopt a finished candidate ({}): it merges as the winner and \
             the rest are discarded.",
            join_numbers(&adoptable)
        ));
    }
    let first = paused
        .first()
        .map(|r| r.plan.attempt)
        .ok_or_else(|| anyhow::anyhow!("a checkpointed round has a paused candidate"))?;
    checkpoint_ticket_by_engine(
        session,
        marker,
        first,
        Some(&brief),
        format!(
            "ticket {}: verify round checkpointed ({} paused); no candidate selected, attempt \
             {first}'s pane is the one held",
            marker.id,
            paused
                .iter()
                .map(|r| r.plan.attempt.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        true,
        (!adoptable.is_empty()).then_some(adoptable),
    )?;
    // The paused candidate's outcome becomes the ticket's, as a lone checkpoint's does. Its spawn
    // proposals stay with the round: a verify candidate's proposals ride or die with selection, and
    // none ran.
    if let Some(outcome) = paused_outcome {
        session.apply(PoolUpdate {
            outcomes: Some(IndexMap::from([(marker.id.clone(), outcome)])),
            ..PoolUpdate::default()
        });
    }
    Ok(())
}

/// `checkpointTicketByEngine`: the engine-side checkpoint for a ticket whose status the engine decides
/// (a lone attempt, a flagged grade, a verify round holding a paused candidate, a conflicted winner):
/// the engine writes the checkpoint status itself (ADR-0005), lands the Brief in the canonical Issue,
/// and raises the interrupt through the same path an attempt's own checkpoint uses, so the resume flow
/// and the re-raise after a restart are the existing ones. `candidates` are a paused verify round's
/// adoptable Candidates (ADR-0035), for its checkpoint Interrupt to carry.
pub fn checkpoint_ticket_by_engine(
    session: &mut Session,
    marker: &TicketMarker,
    attempt: u64,
    brief: Option<&str>,
    log_line: String,
    emit: bool,
    candidates: Option<Vec<u64>>,
) -> anyhow::Result<()> {
    set_marker_status(session, marker, TicketStatus::Checkpoint)?;
    land_checkpoint_brief(&marker.file, brief)?;
    raise_checkpoint(session, marker, attempt, candidates)?;
    session.apply(PoolUpdate {
        tickets: Some(IndexMap::from([(
            marker.id.clone(),
            TicketStatus::Checkpoint,
        )])),
        log: Some(vec![log_line]),
        ..PoolUpdate::default()
    });
    if emit {
        emit_running(session);
    }
    Ok(())
}

/// `completeLoneAttempt`: the pass verdict: the ticket is done exactly as an unverified ticket is. The
/// attempt's branch merges through the existing merge path, the merged event lands on the ticket's log,
/// and the attempt's outcome becomes the ticket's outcome for downstream prompts.
fn complete_lone_attempt(
    session: &mut Session,
    marker: &TicketMarker,
    result: &TicketResult,
    outcome: &Result<ValidOutcome, String>,
) -> anyhow::Result<()> {
    let attempt = result.plan.attempt;
    let mut log = format!(
        "ticket {}: attempt {attempt} passed grading; ticket done",
        marker.id
    );
    // Captured before mergeTicket runs (it removes the worktree and its branch on success): a verify
    // ticket spawned by a Conversation still gets a done-Notice with a real diff summary.
    let before_sha = merge_target_sha(session);
    if session.git {
        let worktree = result
            .plan
            .worktree
            .clone()
            .unwrap_or_else(|| WorktreeInfo {
                path: git::worktree_path_for(&session.cwd, &marker.id, attempt_number(attempt)),
                branch: git::branch_for(&session.cwd, &marker.id, attempt_number(attempt)),
            });
        let merge = merge_ticket(session, marker, &worktree)?;
        if !merge.ok {
            // The conflict machinery re-attempts the solo branch on resume, and a lone attempt has
            // none, so the conflict surfaces as a checkpoint instead: the Brief names the conflicted
            // files and the parked attempt branch, and resume re-runs the ticket from the moved HEAD.
            let complaint = merge_conflict_complaint(session, &marker.id, attempt, &merge);
            checkpoint_ticket_by_engine(
                session,
                marker,
                attempt,
                Some(&complaint),
                format!(
                    "ticket {}: attempt {attempt} passed grading but its {}; checkpoint raised for \
                     the human",
                    marker.id,
                    if merge.reason == Some(MergeFailure::Blocked) {
                        "merge was blocked"
                    } else {
                        "merge conflicted"
                    }
                ),
                true,
                None,
            )?;
            return Ok(());
        }
        append(
            session,
            &marker.id,
            attempt,
            TicketEventKind::Merged,
            merged_payload(&merge),
        )?;
        close_attempt_tab(session, &marker.id, attempt);
        let range = (!before_sha.is_empty())
            .then(|| format!("{before_sha}..{}", merge_target_ref(session)));
        crate::conversations::ticket_ended(session, marker, &worktree.branch, range);
        log = format!(
            "ticket {}: attempt {attempt} passed grading; merged {} onto the working branch",
            marker.id, worktree.branch
        );
    }
    set_marker_status(session, marker, TicketStatus::Done)?;
    let mut update = PoolUpdate {
        tickets: Some(IndexMap::from([(marker.id.clone(), TicketStatus::Done)])),
        log: Some(vec![log]),
        ..PoolUpdate::default()
    };
    if let Ok(valid) = outcome {
        update.outcomes = Some(IndexMap::from([(marker.id.clone(), valid.outcome.clone())]));
        take_proposals(session, &marker.id, &valid.outcome)?;
    }
    session.apply(update);
    emit_running(session);
    Ok(())
}

/// `gradeComplaint`: the checkpoint Brief for a flagged lone attempt: the grade's verdict and reasons,
/// so the human reads the grader's complaint without opening the log.
fn grade_complaint(grade: &Grade) -> String {
    format!(
        "The attempt claimed done, but its grader flagged the work: score {}/10, verdict {}.\n\n{}\n\n\
         Answering resume resets the ticket to ready; the next round runs a fresh attempt and grades \
         it again.",
        score_text(grade.score),
        grade.verdict,
        js::trim(&grade.reasons)
    )
}

/// `mergeConflictComplaint`: the checkpoint Brief for a lone attempt whose passing merge conflicted.
fn merge_conflict_complaint(
    session: &Session,
    build_id: &str,
    attempt: u64,
    result: &MergeResult,
) -> String {
    let branch = git::branch_for(
        &session.cwd,
        build_id,
        attempt_number(work_attempt_of(session, build_id, attempt)),
    );
    if result.reason == Some(MergeFailure::Blocked) {
        return format!(
            "The attempt passed grading, but merging {branch} onto the working branch was blocked: \
             {}The work is parked on {branch}. Clear the files by hand and merge the branch \
             yourself, or answer resume to re-run the ticket from the current HEAD.",
            git::blocked_merge_explanation(&session.cwd, result)
        );
    }
    let files = if result.conflicted.is_empty() {
        "(no unmerged paths listed)".to_owned()
    } else {
        result.conflicted.join(", ")
    };
    format!(
        "The attempt passed grading, but merging {branch} onto the working branch conflicted: \
         {files}. The work is parked on {branch} and the working branch was left clean. Resolve the \
         conflict by hand, or answer resume to re-run the ticket from the current HEAD."
    )
}

// ---------------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------------

/// The rule a Selection was made under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionRule {
    Outright,
    Fallback,
    Human,
    HeadToHead,
}

impl SelectionRule {
    fn as_str(self) -> &'static str {
        match self {
            SelectionRule::Outright => "outright",
            SelectionRule::Fallback => "fallback",
            SelectionRule::Human => "human",
            SelectionRule::HeadToHead => "head-to-head",
        }
    }
}

/// What a Selection recorded: the attempt, its score, the margin over the runner-up (none when there
/// is a single candidate or the choice was the operator's) and the rule.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Picked {
    pub attempt: u64,
    pub score: Option<f64>,
    pub margin: Option<f64>,
    pub rule: SelectionRule,
}

/// `scoreGap`: the spread between two Grade scores, to the one decimal a composed Jev score carries
/// (ADR-0023). Plain subtraction puts 8.2 - 6.2 just under 2, inside the head-to-head band.
pub fn score_gap(a: f64, b: f64) -> f64 {
    ((a - b).abs() * 10.0).round() / 10.0
}

/// The candidates ranked: highest score first, an exact tie going to the earlier attempt. Nothing else
/// breaks it, so the same grades always select the same attempt.
fn ranked(attempts: &[u64], grades: &HashMap<u64, Grade>) -> Vec<(u64, Grade)> {
    let mut ranked: Vec<(u64, Grade)> = attempts
        .iter()
        .filter_map(|attempt| grades.get(attempt).map(|grade| (*attempt, grade.clone())))
        .collect();
    ranked.sort_by(|a, b| {
        b.1.score
            .partial_cmp(&a.1.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    ranked
}

/// `selectWinner`: the total order the spec fixes. Outright when the margin clears two points, the
/// deterministic fallback otherwise, until the head-to-head ticket takes the tight band over.
pub fn select_winner(ranked: &[(u64, Grade)]) -> Picked {
    let (attempt, winner) = &ranked[0];
    let margin = ranked
        .get(1)
        .map(|(_, runner_up)| score_gap(winner.score, runner_up.score));
    Picked {
        attempt: *attempt,
        score: Some(winner.score),
        margin,
        rule: if margin.is_none_or(|margin| margin >= 2.0) {
            SelectionRule::Outright
        } else {
            SelectionRule::Fallback
        },
    }
}

fn margin_text(margin: Option<f64>) -> String {
    margin.map_or("null".to_owned(), score_text)
}

/// `selectAndMergeWinner`: selecting and merging the winner of a completed, fully graded fan-out: every
/// attempt exited done and every grader returned a usable grade. A margin of two points or more takes
/// the top score outright; a tighter spread calls the head-to-head ticket, whose pick decides between
/// the top two, falling back to the deterministic order on a tie or an unusable outcome. Completing the
/// selection does the rest.
pub async fn select_and_merge_winner(
    engine: &Engine,
    marker: &TicketMarker,
    attempts: &[u64],
    grades: &HashMap<u64, Grade>,
) -> anyhow::Result<()> {
    let ranked = ranked(attempts, grades);
    let selection = select_winner(&ranked);
    let mut picked = selection;
    let selection_score = score_text(selection.score.unwrap_or_default());
    let mut why = format!(
        "selected attempt {} (score {selection_score}{}): {}",
        selection.attempt,
        selection.margin.map_or(String::new(), |margin| format!(
            ", margin {}",
            score_text(margin)
        )),
        if selection.rule == SelectionRule::Outright {
            "takes it outright"
        } else {
            "below the outright margin; highest score, then earlier attempt"
        }
    );
    if selection.rule == SelectionRule::Fallback {
        // The tight band: separate grading calls are uncalibrated, so the engine does not trust a
        // one-point spread on its own. One head-to-head ticket sees the top two side by side and names
        // the winner; a tie or an unusable outcome leaves the deterministic order standing.
        let h2h = head_to_head_id_for(&marker.id);
        let verdict = run_head_to_head(engine, marker, &ranked[0], &ranked[1]).await?;
        match verdict {
            HeadToHeadVerdict::Pick { attempt, .. } => {
                let score = grades.get(&attempt).map(|grade| grade.score);
                picked = Picked {
                    attempt,
                    score,
                    margin: Some(score_gap(ranked[0].1.score, ranked[1].1.score)),
                    rule: SelectionRule::HeadToHead,
                };
                why = format!(
                    "selected attempt {attempt} (score {}, margin {}): the head-to-head ticket {h2h} \
                     picked it",
                    score_text(score.unwrap_or_default()),
                    margin_text(picked.margin)
                );
            }
            other => {
                why = format!(
                    "selected attempt {} (score {selection_score}, margin {}): {}highest score, \
                     then earlier attempt",
                    selection.attempt,
                    margin_text(selection.margin),
                    match other {
                        HeadToHeadVerdict::Tie { .. } =>
                            format!("the head-to-head ticket {h2h} could not separate them; "),
                        HeadToHeadVerdict::Unusable { reason } => format!(
                            "the head-to-head ticket {h2h} gave no usable pick ({reason}); "
                        ),
                        HeadToHeadVerdict::Pick { .. } => String::new(),
                    }
                );
            }
        }
    }
    let marker = marker.clone();
    engine
        .call(move |s| -> anyhow::Result<()> {
            // A superseded head-to-head card closes with the selection: a review reject resets its
            // marker to ready with its build ticket's, and a re-round whose grades then decide
            // outright never rewrites it, so without this the run could never pass Review's all-done
            // check.
            if selection.rule == SelectionRule::Outright {
                close_superseded_head_to_head(s, &marker.id)?;
            }
            complete_selection(s, &marker, picked, &why, true)
        })
        .await?
}

/// `raiseSelectionInterrupt`: the selection point with the human as judge: the interrupt carries every
/// candidate's grade, and the answer names the attempt whose branch merges. The ticket stays in-progress
/// with every attempt branch parked; the candidates ride on the interrupt so the answer is validated
/// against the exact fan-out the grades came from, restarts included.
pub fn raise_selection_interrupt(
    session: &mut Session,
    marker: &TicketMarker,
    attempts: &[u64],
    grades: &HashMap<u64, Grade>,
) {
    let mut selection = interrupt(
        &marker.id,
        InterruptKind::Selection,
        selection_interrupt_body(attempts, grades),
    );
    selection.candidates = Some(attempts.to_vec());
    raise_interrupt(session, selection);
    session.log(format!(
        "ticket {}: selection interrupt raised with {} candidates' grades (selection: human)",
        marker.id,
        attempts.len()
    ));
}

/// `selectionInterruptBody`: one line per candidate with its score, verdict and the grader's reasons, so
/// the human judges over the same artifacts the auto rule would.
fn selection_interrupt_body(attempts: &[u64], grades: &HashMap<u64, Grade>) -> String {
    let lines: Vec<String> = attempts
        .iter()
        .filter_map(|attempt| grades.get(attempt).map(|grade| (attempt, grade)))
        .map(|(attempt, grade)| {
            format!(
                "- attempt {attempt}: score {}/10, verdict {}\n  {}",
                score_text(grade.score),
                grade.verdict,
                js::trim(&grade.reasons).replace('\n', "\n  ")
            )
        })
        .collect();
    format!(
        "verify fan-out complete: {} graded attempts, and the pool's selection is yours.\n\n{}\n\n\
         Answer with the number of the attempt to merge; the rest are discarded with their logs, \
         outcomes and grades kept.",
        attempts.len(),
        lines.join("\n")
    )
}

/// `processSelectionAnswer`: the note names the winning attempt, the engine merges that attempt's branch
/// through the existing merge path and completes the selection exactly as the auto rule would. An answer
/// naming no candidate is rejected here too, not merged (the acceptance-time check guards the live
/// caller; this one guards a record accepted before the check existed).
pub fn process_selection_answer(
    session: &mut Session,
    marker: &TicketMarker,
    interrupt: &Interrupt,
    note: Option<&str>,
) -> anyhow::Result<()> {
    let attempt = match parse_selection_answer(note) {
        Some(attempt)
            if interrupt
                .candidates
                .as_ref()
                .is_some_and(|c| c.contains(&attempt)) =>
        {
            attempt
        }
        _ => return Err(anyhow::anyhow!(selection_answer_error(interrupt, note))),
    };
    // The selection interrupt has served its purpose; the merge or the checkpoint it leads to owns the
    // ticket from here.
    session.apply(PoolUpdate {
        interrupts: Some(without_interrupt(session, interrupt)),
        log: Some(vec![format!(
            "interrupt answered for {} (selection): attempt {attempt} to merge",
            marker.id
        )]),
        ..PoolUpdate::default()
    });
    complete_selection(
        session,
        marker,
        Picked {
            attempt,
            score: None,
            margin: None,
            rule: SelectionRule::Human,
        },
        &format!("human selected attempt {attempt}"),
        false,
    )
}

fn without_interrupt(session: &Session, dropped: &Interrupt) -> Vec<Interrupt> {
    session
        .state
        .interrupts
        .iter()
        .filter(|i| *i != dropped)
        .cloned()
        .collect()
}

/// `candidateScore`: the score of an adopted Candidate's grade: its latest well-formed graded event on
/// the ticket's log. The grades of a round live only for the super-step that graded it, and the log is
/// where they outlive a restart. `None` when no grade can be found.
fn candidate_score(session: &Session, ticket_id: &str, attempt: u64) -> Option<f64> {
    read_events(runs(session), ticket_id)
        .iter()
        .filter(|event| event.kind == TicketEventKind::Graded && event.attempt == attempt)
        .filter_map(|event| event.payload.get("score").and_then(Value::as_f64))
        .next_back()
}

/// `adoptCandidate`: Adopt (ADR-0035): the operator takes one finished Candidate of a paused verify
/// round as the Winner. The checkpoint Interrupt is dropped and the paused candidate's question with
/// it, unanswered; the Held pane is let go, and its tab closes with every other attempt's when the
/// selection discards them. From there it is a human selection: the Candidate merges through
/// `complete_selection`, and a conflicted merge checkpoints as a selected winner's does. The note is the
/// record of why, on the answered event and the pool log; it is never read for a number.
pub fn adopt_candidate(
    session: &mut Session,
    marker: &TicketMarker,
    interrupt: &Interrupt,
    record: &QueuedAnswer,
) -> anyhow::Result<()> {
    let attempt = record.attempt;
    // The acceptance-time check guards the live caller; this one guards a record accepted against an
    // Interrupt that has since changed.
    let attempt = match attempt {
        None => {
            return Err(anyhow::anyhow!(
                "answer: adopt needs the attempt number of the candidate to take for {}",
                marker.id
            ));
        }
        Some(attempt) => {
            if let Some(refusal) = adopt_refusal(interrupt, attempt) {
                return Err(anyhow::anyhow!(refusal));
            }
            attempt
        }
    };
    if session.adopted.contains_key(&marker.id) {
        abandon_adoption(session, &marker.id)?;
    }
    session.held.shift_remove(&marker.id);
    let note = record
        .note
        .as_deref()
        .map(js::trim)
        .filter(|n| !n.is_empty());
    session.apply(PoolUpdate {
        interrupts: Some(without_interrupt(session, interrupt)),
        log: Some(vec![format!(
            "interrupt answered for {} (checkpoint): attempt {attempt} adopted from the paused \
             verify round{}",
            marker.id,
            note.map_or(String::new(), |note| format!(", with the note: {note}"))
        )]),
        ..PoolUpdate::default()
    });
    complete_selection(
        session,
        marker,
        Picked {
            attempt,
            score: candidate_score(session, &marker.id, attempt),
            margin: None,
            rule: SelectionRule::Human,
        },
        &format!(
            "the operator adopted attempt {attempt} from the paused verify round's checkpoint"
        ),
        false,
    )
}

/// `completeSelection`: completing a selection, however it was made: the selected event records which
/// attempt won and under which rule, the winner's branch merges through the existing merge path, the
/// engine writes the done status (ADR-0005), and every other attempt branch of the ticket, this round's
/// losers and any superseded round's alike, is discarded. A conflicted merge parks the winner's branch
/// and checkpoints for the human, the way a lone attempt's conflicted merge does.
fn complete_selection(
    session: &mut Session,
    marker: &TicketMarker,
    picked: Picked,
    why: &str,
    emit: bool,
) -> anyhow::Result<()> {
    let attempt = picked.attempt;
    let mut payload = Map::new();
    payload.insert(
        "score".into(),
        picked.score.map_or(Value::Null, js::number_value),
    );
    payload.insert(
        "margin".into(),
        picked.margin.map_or(Value::Null, js::number_value),
    );
    payload.insert(
        "rule".into(),
        Value::String(picked.rule.as_str().to_owned()),
    );
    append(
        session,
        &marker.id,
        attempt,
        TicketEventKind::Selected,
        payload,
    )?;
    session.log(format!("ticket {}: {why}", marker.id));
    let merged_note = if session.git {
        let worktree = WorktreeInfo {
            path: git::worktree_path_for(&session.cwd, &marker.id, attempt_number(attempt)),
            branch: git::branch_for(&session.cwd, &marker.id, attempt_number(attempt)),
        };
        let merge = merge_ticket(session, marker, &worktree)?;
        if !merge.ok {
            discard_losers(session, &marker.id, attempt);
            let complaint = merge_conflict_complaint(session, &marker.id, attempt, &merge);
            return checkpoint_ticket_by_engine(
                session,
                marker,
                attempt,
                Some(&complaint),
                format!(
                    "ticket {}: attempt {attempt} selected but its merge {}; checkpoint raised for \
                     the human",
                    marker.id,
                    if merge.reason == Some(MergeFailure::Blocked) {
                        "was blocked"
                    } else {
                        "conflicted"
                    }
                ),
                emit,
                None,
            );
        }
        append(
            session,
            &marker.id,
            attempt,
            TicketEventKind::Merged,
            merged_payload(&merge),
        )?;
        close_attempt_tab(session, &marker.id, attempt);
        format!(
            " merged {} onto the working branch",
            git::branch_for(&session.cwd, &marker.id, attempt_number(attempt))
        )
    } else {
        " (the pool does not run in git; the selected work is already in the checkout)".to_owned()
    };
    set_marker_status(session, marker, TicketStatus::Done)?;
    let discarded = discard_losers(session, &marker.id, attempt);
    let mut update = PoolUpdate {
        tickets: Some(IndexMap::from([(marker.id.clone(), TicketStatus::Done)])),
        log: Some(vec![format!(
            "ticket {}: attempt {attempt} selected{merged_note}{}",
            marker.id,
            if discarded.is_empty() {
                String::new()
            } else {
                format!(
                    "; discarded losing attempts {} (their logs, outcomes and grades are kept)",
                    discarded
                        .iter()
                        .map(u64::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
        )]),
        ..PoolUpdate::default()
    };
    // The winner's outcome becomes the ticket's, the way a solo done attempt's does, so downstream
    // prompts read what was actually selected. Its spawn proposals ride to the boundary's adoption
    // buffer with it.
    if let Ok(valid) = outcome_of(session, &marker.id, attempt) {
        update.outcomes = Some(IndexMap::from([(marker.id.clone(), valid.outcome.clone())]));
        take_proposals(session, &marker.id, &valid.outcome)?;
    }
    session.apply(update);
    if emit {
        emit_running(session);
    }
    Ok(())
}

/// `discardLosers`: every attempt branch of the build ticket except the winner's goes: this round's
/// losers and any superseded round's alike, and each discarded attempt's terminal tab with it, because a
/// loser's tab never merges. Returns the attempt numbers discarded, so the pool log can name them.
fn discard_losers(session: &Session, build_id: &str, keep: u64) -> Vec<u64> {
    if !session.git {
        return Vec::new();
    }
    let losers: Vec<u64> = git::attempt_branches(&session.cwd, build_id)
        .into_iter()
        .map(u64::from)
        .filter(|attempt| *attempt != keep)
        .collect();
    for attempt in &losers {
        git::discard_worktree(
            &session.cwd,
            &WorktreeInfo {
                path: git::worktree_path_for(&session.cwd, build_id, attempt_number(*attempt)),
                branch: git::branch_for(&session.cwd, build_id, attempt_number(*attempt)),
            },
        );
        close_attempt_tab(session, build_id, *attempt);
    }
    losers
}

// ---------------------------------------------------------------------------------------------------
// Head-to-head
// ---------------------------------------------------------------------------------------------------

/// One side of the comparison: the attempt, the grade it received, and the artifact paths the
/// head-to-head ticket binds.
struct HeadToHeadSide {
    attempt: u64,
    grade: Grade,
    outcome_path: String,
    diff_path: String,
    log_path: String,
}

/// What the head-to-head run decided: the attempt it picked, a declared tie, or the reason it decided
/// nothing (a dead harness, an unparseable outcome, a pause). A tie and an unusable outcome lead to the
/// same deterministic fallback; the reason only tells the log which one fired.
#[derive(Debug, Clone, PartialEq)]
pub enum HeadToHeadVerdict {
    Pick { attempt: u64, outcome: Outcome },
    Tie { outcome: Outcome },
    Unusable { reason: String },
}

/// `validateVerdict`: the head-to-head's outcome: the standard contract plus a `winner` naming exactly
/// one of the two candidate attempt numbers, or the string "tie" when the judge genuinely cannot
/// separate them. Anything else is unusable rather than a guess: the deterministic fallback owns the
/// decision then.
pub fn validate_verdict(parsed: &Value, candidates: [u64; 2]) -> Result<HeadToHeadVerdict, String> {
    let base = validate_outcome(parsed)?;
    if base.outcome.status != ac_protocol::OutcomeStatus::Done {
        return Err("head-to-head outcome is a checkpoint, not a pick".into());
    }
    let winner = parsed.get("winner");
    if winner.and_then(Value::as_str) == Some("tie") {
        return Ok(HeadToHeadVerdict::Tie {
            outcome: base.outcome,
        });
    }
    let pick = match winner {
        Some(Value::Number(number)) => number.as_f64().filter(|n| n.fract() == 0.0),
        Some(Value::String(text))
            if !text.is_empty() && text.chars().all(|c| c.is_ascii_digit()) =>
        {
            Some(js::number_from_text(text))
        }
        _ => None,
    };
    match pick.filter(|pick| candidates.iter().any(|c| *c as f64 == *pick)) {
        Some(pick) => Ok(HeadToHeadVerdict::Pick {
            attempt: pick as u64,
            outcome: base.outcome,
        }),
        None => Err("outcome names no winner among the two attempts".into()),
    }
}

/// `writeHeadToHeadTicket`: a real ticket in the pool's directory with the ordinary blocking edge from
/// its build ticket, so it renders as a node card and its assignment is editable like any ticket's. The
/// engine rewrites it every time the tight band is reached, rebinding the same card to the round's top
/// two instead of accumulating one per round.
fn write_head_to_head_ticket(
    session: &Session,
    build: &TicketMarker,
    top: &HeadToHeadSide,
    runner_up: &HeadToHeadSide,
) -> anyhow::Result<()> {
    let h2h_id = head_to_head_id_for(&build.id);
    let bind = |label: &str, side: &HeadToHeadSide| {
        format!(
            "{label} attempt {} (graded {}/10): outcome `{}`; diff `{}`; trimmed log `{}`",
            side.attempt,
            score_text(side.grade.score),
            side.outcome_path,
            side.diff_path,
            side.log_path
        )
    };
    let build_id = &build.id;
    let body = format!(
        "<!-- state: id={h2h_id} blocked-by={build_id} status=ready -->\n\n\
         # {h2h_id}: pick between attempts {} and {} of ticket {build_id}\n\n\
         **Head-to-head for:** ticket {build_id}. Attempts {} and {} graded {} and {}, inside the \
         two-point outright margin, so the pairwise call decides.\n\n\
         **Bound artifacts:** ticket file `{}`; {}; {}.\n\n\
         The engine wrote this ticket when selection found the top two grades too close to call from \
         separate graders, and runs it through the pool's ordinary assign machinery: an `assign` \
         entry for this id in console.json overrides the build ticket's harness and model. Its \
         prompt lays both attempts' artifacts side by side, and its outcome JSON carries \
         `\"winner\"`, the number of the attempt it picks, or `\"tie\"`. It writes no status, raises \
         no interrupts, and merges nothing.\n",
        top.attempt,
        runner_up.attempt,
        top.attempt,
        runner_up.attempt,
        score_text(top.grade.score),
        score_text(runner_up.grade.score),
        marker_file(build),
        bind("first", top),
        bind("second", runner_up),
    );
    js::write_file(runs_parent_issue(session, &format!("{h2h_id}.md")), &body)?;
    Ok(())
}

fn side_parts<'a>(side: &'a HeadToHeadSide, verdict: &'a str) -> HeadToHeadSideParts<'a> {
    HeadToHeadSideParts {
        attempt: side.attempt,
        outcome_path: &side.outcome_path,
        diff_path: &side.diff_path,
        log_path: &side.log_path,
        score: side.grade.score,
        verdict,
        reasons: &side.grade.reasons,
    }
}

/// `runHeadToHead`: running the head-to-head for a tight spread: write the compare ticket, resolve its
/// assignment through the ordinary machinery, spawn it, and read the pick. Unlike a grader there is no
/// re-spawn: an unusable outcome falls back to the deterministic order by contract, so a dead judge can
/// never stall the run. The card still closes done either way (the engine owns the status write): its
/// lifecycle is over once its outcome has been consumed, and an open card would hold Review's all-done
/// check shut forever.
async fn run_head_to_head(
    engine: &Engine,
    build: &TicketMarker,
    top: &(u64, Grade),
    runner_up: &(u64, Grade),
) -> anyhow::Result<HeadToHeadVerdict> {
    let h2h_id = head_to_head_id_for(&build.id);
    let (build_c, top_c, runner_c) = (build.clone(), top.clone(), runner_up.clone());
    let h2h_c = h2h_id.clone();
    let (sides, h2h) = engine
        .call(
            move |s| -> anyhow::Result<([HeadToHeadSide; 2], TicketMarker)> {
                let side = |(attempt, grade): &(u64, Grade)| HeadToHeadSide {
                    attempt: *attempt,
                    grade: grade.clone(),
                    outcome_path: runs_file(
                        s,
                        &attempt_outcome_name(&build_c.id, Some(*attempt), false),
                    ),
                    diff_path: runs_file(s, &format!("{h2h_c}.attempt-{attempt}.diff.patch")),
                    log_path: runs_file(s, &format!("{h2h_c}.attempt-{attempt}.trim.log")),
                };
                let sides = [side(&top_c), side(&runner_c)];
                write_head_to_head_ticket(s, &build_c, &sides[0], &sides[1])?;
                s.markers = load_pool_tickets(Path::new(&s.pool_dir), false)?;
                let h2h = s.marker(&h2h_c).cloned().ok_or_else(|| {
                    anyhow::anyhow!("head-to-head ticket {h2h_c} was not written")
                })?;
                Ok((sides, h2h))
            },
        )
        .await??;
    // The selection run's spawn set routes through the one entry point via the shared engine-run
    // helper: the run spawns the judge it hands back, and the merge hold is the one rule that can
    // withhold it.
    let judge = engine_spawn_set(engine, vec![h2h.clone()])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no head-to-head judge to spawn"))?;
    let (build_c, judge_c, h2h_c) = (build.clone(), judge.clone(), h2h.clone());
    let gap = score_gap(top.1.score, runner_up.1.score);
    let (top_attempt, runner_attempt) = (top.0, runner_up.0);
    let (spec_body, h2h_attempt, env, cwd, assignment) = engine
        .call(move |s| -> anyhow::Result<_> {
            let build_assignment = s
                .assignments
                .get(&build_c.id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("no assignment for ticket {}", build_c.id))?;
            let assignment = resolve_engine_ticket_assignment(
                &s.state.config,
                &judge_c,
                &build_assignment,
                &s.harnesses,
            )?;
            s.assignments.insert(h2h_c.id.clone(), assignment.clone());
            let scheduled = next_attempt(runs(s), &h2h_c.id);
            append(
                s,
                &h2h_c.id,
                scheduled,
                TicketEventKind::Scheduled,
                Map::new(),
            )?;
            s.apply(PoolUpdate {
                tickets: Some(IndexMap::from([(
                    h2h_c.id.clone(),
                    TicketStatus::InProgress,
                )])),
                log: Some(vec![format!(
                    "ticket {}: margin {} is below the outright band; spawning head-to-head {} \
                     between attempts {top_attempt} and {runner_attempt}",
                    build_c.id,
                    score_text(gap),
                    h2h_c.id
                )]),
                ..PoolUpdate::default()
            });
            set_marker_status(s, &judge_c, TicketStatus::InProgress)?;
            emit_running(s);
            let h2h_outcome_path = runs_file(s, &attempt_outcome_name(&h2h_c.id, None, false));
            for side in &sides {
                js::write_file(&side.diff_path, &attempt_diff(s, &build_c.id, side.attempt))?;
                let log = read_optional(&runs_file(
                    s,
                    &attempt_log_name(&build_c.id, Some(side.attempt), false),
                ))
                .unwrap_or_else(|| "(no attempt log was recorded)\n".to_owned());
                js::write_file(&side.log_path, &trim_tail(&log))?;
            }
            // Read fresh at every run, like the verify skill at every grader spawn: an operator's
            // mid-run edit lands in the very next judge's prompt.
            let skill = read_optional(&js::path_join(&[&s.pool_dir, "verify.md"]));
            let verdicts = [
                sides[0].grade.verdict.to_string(),
                sides[1].grade.verdict.to_string(),
            ];
            let prompt = build_head_to_head_prompt(&HeadToHeadPromptParts {
                build_id: &build_c.id,
                ticket_path: &marker_file(&build_c),
                skill: skill.as_deref(),
                top: side_parts(&sides[0], &verdicts[0]),
                runner_up: side_parts(&sides[1], &verdicts[1]),
                outcome_path: &h2h_outcome_path,
            });
            // This round's attempt number for the head-to-head ticket: the scheduled append above
            // bumped lastAttempt to it, so the value read here (before the spawned append) is the one
            // the events and the tab close key off.
            Ok((
                prompt,
                last_attempt(runs(s), &h2h_c.id),
                attempt_env_of(s, None),
                s.cwd.clone(),
                assignment,
            ))
        })
        .await??;
    let candidates = [top.0, runner_up.0];
    // The judge's run is the Attempt-run module's (ADR-0014): the exited status on a usable pick is
    // done, and the exit facts ride the run.
    let run = run_attempt(
        &env,
        AttemptSpec {
            id: h2h.id.clone(),
            issue_path: marker_file(&judge),
            title: h2h.title.clone(),
            body: spec_body,
            driver: HEAD_TO_HEAD_DRIVER.to_owned(),
            harness: assignment.harness.clone(),
            model: assignment.model.clone(),
            effort: assignment
                .effort
                .clone()
                .filter(|effort| !effort.is_empty()),
            cwd,
            branch: None,
            attempt: h2h_attempt,
            naming: AttemptNaming {
                attempt: None,
                resolver: false,
            },
            rotate: Rotate::Exited,
            fallback: Fallback::Headless,
            prompt: PromptDelivery::Driver,
            crash_subject: CrashSubject::Harness,
            events: AttemptEvents::Full {
                exited_status: |_: &HeadToHeadVerdict| TicketStatus::Done,
                result_events: None,
            },
        },
        move |parsed: &Value| validate_verdict(parsed, candidates),
    )
    .await?;
    let verdict = match (run.ok(), run.result) {
        (true, Ok(verdict)) => verdict,
        (_, _) => HeadToHeadVerdict::Unusable {
            reason: run
                .crash_reason
                .unwrap_or_else(|| "produced no usable pick".to_owned()),
        },
    };
    let (build_c, judge_c, h2h_c, settled) = (
        build.clone(),
        judge.clone(),
        h2h_id.clone(),
        verdict.clone(),
    );
    engine
        .call(move |s| -> anyhow::Result<()> {
            set_marker_status(s, &judge_c, TicketStatus::Done)?;
            // The judge's tab never merges: its role ends the moment the verdict is consumed and the
            // card goes done, on a usable pick and an unusable one alike.
            close_attempt_tab(s, &h2h_c, h2h_attempt);
            let line = match &settled {
                HeadToHeadVerdict::Pick { attempt, .. } => format!(
                    "ticket {}: head-to-head {h2h_c} picked attempt {attempt}",
                    build_c.id
                ),
                HeadToHeadVerdict::Tie { .. } => {
                    format!("ticket {}: head-to-head {h2h_c} tied", build_c.id)
                }
                HeadToHeadVerdict::Unusable { reason } => format!(
                    "ticket {}: head-to-head {h2h_c} gave no usable pick: {reason}",
                    build_c.id
                ),
            };
            let mut update = PoolUpdate {
                tickets: Some(IndexMap::from([(h2h_c.clone(), TicketStatus::Done)])),
                log: Some(vec![line]),
                ..PoolUpdate::default()
            };
            match &settled {
                HeadToHeadVerdict::Pick { outcome, .. } | HeadToHeadVerdict::Tie { outcome } => {
                    update.outcomes = Some(IndexMap::from([(h2h_c.clone(), outcome.clone())]));
                }
                HeadToHeadVerdict::Unusable { .. } => {}
            }
            s.apply(update);
            emit_running(s);
            Ok(())
        })
        .await??;
    Ok(verdict)
}

/// `closeSupersededHeadToHead`: closing a superseded head-to-head card: a review reject resets its
/// marker to ready along with its build ticket's, and an engine crash mid-judge leaves it behind for
/// rehydrate to reset; a re-round whose grades then decide outright never rewrites the card, so without
/// this the run could never pass Review's all-done check. The engine owns the write, and the card's own
/// ticket log already holds the round it judged.
fn close_superseded_head_to_head(session: &mut Session, build_id: &str) -> anyhow::Result<()> {
    let h2h_id = head_to_head_id_for(build_id);
    let file = runs_parent_issue(session, &format!("{h2h_id}.md"));
    if !js::exists(&file) {
        return Ok(());
    }
    if is_finished(Some(read_marker(Path::new(&file))?.status)) {
        return Ok(());
    }
    write_marker_status(Path::new(&file), TicketStatus::Done)?;
    if let Some(marker) = session.marker_mut(&h2h_id) {
        marker.status = TicketStatus::Done;
    }
    session.apply(PoolUpdate {
        tickets: Some(IndexMap::from([(h2h_id.clone(), TicketStatus::Done)])),
        log: Some(vec![format!(
            "ticket {build_id}: closed superseded head-to-head card {h2h_id} (this round's \
             selection did not need it)"
        )]),
        ..PoolUpdate::default()
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interrupt(kind: InterruptKind, candidates: Option<Vec<u64>>) -> Interrupt {
        Interrupt {
            ticket_id: "01".into(),
            kind,
            body: String::new(),
            candidates,
            steward_note: None,
        }
    }

    #[test]
    fn an_adopt_names_a_finished_candidate_of_a_paused_round() {
        assert_eq!(
            adopt_refusal(&interrupt(InterruptKind::Crash, None), 1).unwrap(),
            "answer: adopt takes a paused verify round's checkpoint interrupt, got crash for 01"
        );
        assert_eq!(
            adopt_refusal(&interrupt(InterruptKind::Checkpoint, None), 1).unwrap(),
            "answer: 01's checkpoint names no finished candidate to adopt; resume or close it"
        );
        assert_eq!(
            adopt_refusal(&interrupt(InterruptKind::Checkpoint, Some(vec![1, 3])), 2).unwrap(),
            "answer: adopt must name one of the finished candidates (1, 3); got attempt 2 for 01"
        );
        assert_eq!(
            adopt_refusal(&interrupt(InterruptKind::Checkpoint, Some(vec![1, 3])), 3),
            None
        );
    }

    #[test]
    fn a_selection_answer_is_the_first_number_in_the_note() {
        assert_eq!(
            parse_selection_answer(Some("merge attempt-2 please")),
            Some(2)
        );
        assert_eq!(parse_selection_answer(Some("none")), None);
        assert_eq!(parse_selection_answer(None), None);
        assert_eq!(
            selection_answer_error(
                &interrupt(InterruptKind::Selection, Some(vec![1, 2])),
                Some("x\"y")
            ),
            "selection answer must name one of the candidate attempts (1, 2); got \"x\\\"y\""
        );
    }

    fn grade(score: f64, verdict: GradeVerdict, reasons: &str) -> Grade {
        Grade {
            score,
            verdict,
            reasons: reasons.into(),
            rubric: None,
            model: None,
            evidence_budget: None,
        }
    }

    #[test]
    fn a_grade_needs_a_done_outcome_and_a_score_verdict_and_reasons() {
        use serde_json::json;
        let ok = json!({"status": "done", "summary": "s", "grade":
            {"score": 7.5, "verdict": "pass", "reasons": "fine"}});
        let valid = validate_grade(&ok).unwrap();
        assert_eq!(valid.grade, grade(7.5, GradeVerdict::Pass, "fine"));
        let check = |value: serde_json::Value, reason: &str| {
            assert_eq!(validate_grade(&value).unwrap_err(), reason);
        };
        check(
            json!({"status": "checkpoint", "summary": "s"}),
            "grader outcome is a checkpoint, not a grade",
        );
        check(
            json!({"status": "done", "summary": "s"}),
            "outcome carries no grade object",
        );
        check(
            json!({"status": "done", "summary": "s", "grade": null}),
            "outcome carries no grade object",
        );
        check(
            json!({"status": "done", "summary": "s", "grade": {"score": 11, "verdict": "pass", "reasons": ""}}),
            "grade has no score in 0..10",
        );
        check(
            json!({"status": "done", "summary": "s", "grade": {"score": "7", "verdict": "pass", "reasons": ""}}),
            "grade has no score in 0..10",
        );
        check(
            json!({"status": "done", "summary": "s", "grade": {"score": 5, "verdict": "maybe", "reasons": ""}}),
            "grade verdict is not pass or flag",
        );
        check(
            json!({"status": "done", "summary": "s", "grade": {"score": 5, "verdict": "flag"}}),
            "grade has no reasons string",
        );
        check(
            json!({"status": "nope"}),
            "outcome's status is not done or checkpoint",
        );
    }

    #[test]
    fn a_jev_grades_provenance_passes_through_validation_and_the_graded_payload() {
        use serde_json::json;
        let parsed = json!({"status": "done", "summary": "s", "grade": {
            "score": 8, "verdict": "pass", "reasons": "r",
            "rubric": "jev-grader-rubric/x", "model": "m", "evidenceBudget": "widened", "extra": 1}});
        let valid = validate_grade(&parsed).unwrap();
        assert_eq!(valid.grade.rubric.as_deref(), Some("jev-grader-rubric/x"));
        assert_eq!(valid.grade.evidence_budget, Some(EvidenceBudget::Widened));
        assert_eq!(
            js::to_json(&graded_payload(&valid.grade)),
            r#"{"score":8,"verdict":"pass","reasons":"r","rubric":"jev-grader-rubric/x","model":"m","evidenceBudget":"widened"}"#
        );
        // An agent-graded Grade's payload is the three fields it always was.
        assert_eq!(
            js::to_json(&graded_payload(&grade(6.5, GradeVerdict::Flag, "no"))),
            r#"{"score":6.5,"verdict":"flag","reasons":"no"}"#
        );
    }

    #[test]
    fn a_log_over_the_budget_keeps_its_tail_from_a_line_start_behind_a_notice() {
        assert_eq!(trim_tail("short"), "short");
        let log = format!("{}\nkept line\nlast", "x".repeat(GRADER_TRIM_CHARS));
        let trimmed = trim_tail(&log);
        let total = js::utf16_len(&log);
        assert_eq!(
            trimmed,
            format!(
                "[log trimmed to the last ~20k tokens; 14 of {total} characters shown]\nkept line\nlast"
            )
        );
        // A tail that is one unbroken line is kept as it is.
        let flat = "y".repeat(GRADER_TRIM_CHARS + 5);
        assert!(trim_tail(&flat).starts_with(&format!(
            "[log trimmed to the last ~20k tokens; {GRADER_TRIM_CHARS} of {} characters shown]\n",
            GRADER_TRIM_CHARS + 5
        )));
    }

    #[test]
    fn the_highest_score_wins_and_an_exact_tie_goes_to_the_earlier_attempt() {
        let grades: HashMap<u64, Grade> = [
            (1, grade(6.0, GradeVerdict::Pass, "a")),
            (2, grade(8.2, GradeVerdict::Pass, "b")),
            (3, grade(8.2, GradeVerdict::Pass, "c")),
        ]
        .into();
        let ranked = ranked(&[1, 2, 3], &grades);
        assert_eq!(
            ranked.iter().map(|(a, _)| *a).collect::<Vec<_>>(),
            [2, 3, 1]
        );
        let picked = select_winner(&ranked);
        assert_eq!(picked.attempt, 2);
        assert_eq!(picked.margin, Some(0.0));
        assert_eq!(picked.rule, SelectionRule::Fallback);
    }

    #[test]
    fn a_margin_of_two_points_takes_it_outright_and_a_lone_candidate_has_none() {
        // 8.2 - 6.2 is 1.9999999999999991 in floating point: rounded to the score's decimal, it clears.
        let ranked = vec![
            (1, grade(8.2, GradeVerdict::Pass, "a")),
            (2, grade(6.2, GradeVerdict::Pass, "b")),
        ];
        let picked = select_winner(&ranked);
        assert_eq!(picked.margin, Some(2.0));
        assert_eq!(picked.rule, SelectionRule::Outright);
        let lone = select_winner(&ranked[..1]);
        assert_eq!(lone.margin, None);
        assert_eq!(lone.rule, SelectionRule::Outright);
        assert_eq!(score_gap(7.0, 8.4), 1.4);
    }

    #[test]
    fn the_selection_interrupt_lists_each_candidate_with_its_reasons() {
        let grades: HashMap<u64, Grade> = [
            (1, grade(7.0, GradeVerdict::Pass, " solid\nwork ")),
            (2, grade(4.5, GradeVerdict::Flag, "thin")),
        ]
        .into();
        assert_eq!(
            selection_interrupt_body(&[1, 2], &grades),
            "verify fan-out complete: 2 graded attempts, and the pool's selection is yours.\n\n\
             - attempt 1: score 7/10, verdict pass\n  solid\n  work\n\
             - attempt 2: score 4.5/10, verdict flag\n  thin\n\n\
             Answer with the number of the attempt to merge; the rest are discarded with their \
             logs, outcomes and grades kept."
        );
    }

    #[test]
    fn a_head_to_head_verdict_names_one_of_the_two_attempts_or_a_tie() {
        use serde_json::json;
        let outcome =
            |winner: serde_json::Value| json!({"status": "done", "summary": "s", "winner": winner});
        let pick = |winner| validate_verdict(&outcome(winner), [1, 3]);
        assert!(matches!(
            pick(json!(3)),
            Ok(HeadToHeadVerdict::Pick { attempt: 3, .. })
        ));
        assert!(matches!(
            pick(json!("1")),
            Ok(HeadToHeadVerdict::Pick { attempt: 1, .. })
        ));
        assert!(matches!(
            pick(json!("tie")),
            Ok(HeadToHeadVerdict::Tie { .. })
        ));
        for bad in [
            json!(2),
            json!("2"),
            json!(1.5),
            json!("one"),
            json!(null),
            json!("-1"),
        ] {
            assert_eq!(
                pick(bad).unwrap_err(),
                "outcome names no winner among the two attempts"
            );
        }
        assert_eq!(
            validate_verdict(&json!({"status": "checkpoint", "summary": "s"}), [1, 2]).unwrap_err(),
            "head-to-head outcome is a checkpoint, not a pick"
        );
    }
}
