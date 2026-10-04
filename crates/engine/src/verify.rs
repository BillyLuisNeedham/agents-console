//! Verify (engine.ts 6559-6627, 7145-8845): graders, Jev grading, Selection, head-to-head, Adopt.
//!
//! Ported: the pure checks acceptance runs on an Adopt and a selection answer (`adopt_refusal`,
//! `parse_selection_answer`, `selection_answer_error`). STUB(verify): grading a round, the lone-attempt
//! and paused-round decisions, Selection, Adopt's processing and the selection answer's belong to the
//! verify port; each stub is the narrowest behaviour that compiles (a round grades nothing, so a
//! verify ticket stays in-progress).

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use ac_core::pool::TicketMarker;
use ac_protocol::{Grade, Interrupt, InterruptKind, QueuedAnswer};

use crate::actor::Engine;
use crate::session::Session;
use crate::tickets::TicketResult;

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

/// `gradeRound`: grade every attempt of a verify round.
///
/// STUB(verify): grades nothing.
pub async fn grade_round(
    engine: &Engine,
    marker: &TicketMarker,
    attempts: &[u64],
) -> anyhow::Result<HashMap<u64, Grade>> {
    let _ = (engine, marker, attempts);
    Ok(HashMap::new())
}

/// `resolveLoneAttempt`: one attempt and one grade decide at the ticket.
///
/// STUB(verify): decides nothing.
pub fn resolve_lone_attempt(
    session: &mut Session,
    marker: &TicketMarker,
    result: &TicketResult,
    grade: Option<&Grade>,
) -> anyhow::Result<()> {
    let _ = (session, marker, result, grade);
    Ok(())
}

/// `checkpointFanOutRound`: a paused candidate checkpoints the whole round (ADR-0034).
///
/// STUB(verify): checkpoints nothing.
pub fn checkpoint_fan_out_round(
    session: &mut Session,
    marker: &TicketMarker,
    round: &[&TicketResult],
    grades: &HashMap<u64, Grade>,
) -> anyhow::Result<()> {
    let _ = (session, marker, round, grades);
    Ok(())
}

/// `raiseSelectionInterrupt`: the human picks the winner.
///
/// STUB(verify): raises nothing.
pub fn raise_selection_interrupt(
    session: &mut Session,
    marker: &TicketMarker,
    attempts: &[u64],
    grades: &HashMap<u64, Grade>,
) {
    let _ = (session, marker, attempts, grades);
}

/// `selectAndMergeWinner`: the engine picks and merges the best candidate.
///
/// STUB(verify): selects nothing.
pub async fn select_and_merge_winner(
    engine: &Engine,
    marker: &TicketMarker,
    attempts: &[u64],
    grades: &HashMap<u64, Grade>,
) -> anyhow::Result<()> {
    let _ = (engine, marker, attempts, grades);
    Ok(())
}

/// `adoptCandidate`: the operator takes one finished Candidate as the Winner (ADR-0035).
///
/// STUB(verify): refuses.
pub fn adopt_candidate(
    session: &mut Session,
    marker: &TicketMarker,
    interrupt: &Interrupt,
    record: &QueuedAnswer,
) -> anyhow::Result<()> {
    let _ = (session, interrupt, record);
    Err(anyhow::anyhow!("adopt for {}: not ported yet", marker.id))
}

/// `processSelectionAnswer`: the note names the winning attempt.
///
/// STUB(verify): checks the answer, then refuses.
pub fn process_selection_answer(
    session: &mut Session,
    marker: &TicketMarker,
    interrupt: &Interrupt,
    note: Option<&str>,
) -> anyhow::Result<()> {
    let _ = session;
    match parse_selection_answer(note) {
        Some(attempt)
            if interrupt
                .candidates
                .as_ref()
                .is_some_and(|c| c.contains(&attempt)) => {}
        _ => return Err(anyhow::anyhow!(selection_answer_error(interrupt, note))),
    }
    Err(anyhow::anyhow!(
        "selection for {}: not ported yet",
        marker.id
    ))
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
}
