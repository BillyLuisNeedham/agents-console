//! The Steward's actions (ADR-0030, engine.ts 9821-10163): what the Steward may do to the pool, on
//! the operator's own paths, and the budget that bounds it.
//!
//! Ported: the pieces the answer path and the snapshot read (`steward_answer_payload`,
//! `note_answered`, `steward_used_at_boot`, `with_steward_notes`). STUB(steward_actions): the actions
//! themselves (check, answer, Keep talking, leave, adopt, discard, reassigned, state, end) belong to
//! the Steward port.

use std::path::Path;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use ac_core::events::read_events;
use ac_core::pool::TicketMarker;
use ac_protocol::{AnswerBy, ResumeAction, TicketEvent, TicketEventKind};

use crate::session::{PoolState, Session};

/// The fields an answer by the Steward adds to its `answered` event: who answered, and the note it
/// gave.
pub fn steward_answer_payload(
    conversation: &str,
    action: ResumeAction,
    note: Option<&str>,
) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("by".into(), Value::String("steward".into()));
    payload.insert(
        "conversation".into(),
        Value::String(conversation.to_owned()),
    );
    if action != ResumeAction::Resume {
        payload.insert("action".into(), Value::String(action.as_str().to_owned()));
    }
    if let Some(note) = note
        && !ac_core::js::trim(note).is_empty()
    {
        payload.insert(
            "note".into(),
            Value::String(ac_core::js::trim(note).to_owned()),
        );
    }
    payload
}

/// `noteAnswered`: an Interrupt was answered, by the operator or the Steward. The budget moves (the
/// Steward's answer counts, the operator's resets it), the Steward note goes with the Interrupt it
/// was on, and a Steward hears about the Ticket's next Interrupt afresh.
pub fn note_answered(session: &mut Session, ticket_id: &str, by: AnswerBy) {
    if by == AnswerBy::Steward {
        *session
            .steward_used
            .entry(ticket_id.to_owned())
            .or_insert(0) += 1;
    } else {
        session.steward_used.shift_remove(ticket_id);
    }
    let _ = session.steward_notes.clear(ticket_id);
    crate::conversations::steward_forget(session, ticket_id);
}

/// steward.ts `stewardBudgetUsed`: the Steward's answers since the operator last answered, counted
/// back from the newest `answered` event.
pub fn steward_budget_used(events: &[std::sync::Arc<TicketEvent>]) -> u64 {
    let mut used = 0;
    for event in events.iter().rev() {
        if event.kind != TicketEventKind::Answered {
            continue;
        }
        if event.payload.get("by").and_then(Value::as_str) != Some("steward") {
            break;
        }
        used += 1;
    }
    used
}

/// The budget used per Ticket at boot, read off every Ticket log once.
pub fn steward_used_at_boot(runs_dir: &str, markers: &[TicketMarker]) -> IndexMap<String, u64> {
    let mut used = IndexMap::new();
    for marker in markers {
        let n = steward_budget_used(&read_events(Path::new(runs_dir), &marker.id));
        if n > 0 {
            used.insert(marker.id.clone(), n);
        }
    }
    used
}

/// `withStewardNotes`: the state a snapshot carries, with each Steward note on its Interrupt's copy.
/// A note whose Interrupt is no longer pending is pruned first.
pub fn with_steward_notes(session: &mut Session) -> PoolState {
    if session.steward_notes.size() == 0 {
        return session.state.clone();
    }
    let pending: Vec<(String, String)> = session
        .state
        .interrupts
        .iter()
        .map(|i| (i.ticket_id.clone(), i.kind.as_str().to_owned()))
        .collect();
    let pending: Vec<(&str, &str)> = pending
        .iter()
        .map(|(id, kind)| (id.as_str(), kind.as_str()))
        .collect();
    let _ = session.steward_notes.prune(&pending);
    let mut state = session.state.clone();
    if session.steward_notes.size() == 0 {
        return state;
    }
    for interrupt in &mut state.interrupts {
        if let Some(note) = session
            .steward_notes
            .get(&interrupt.ticket_id, interrupt.kind.as_str())
        {
            interrupt.steward_note = Some(note);
        }
    }
    state
}
