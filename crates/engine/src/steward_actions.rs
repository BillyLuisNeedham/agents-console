//! The Steward's actions (ADR-0030, engine.ts 9821-10163): what the Steward may do to the pool, on
//! the operator's own paths, and the budget that bounds it.
//!
//! Every action is a plain function over the Session, run as one actor job (`check`, `answer`,
//! `leave`, `adopt_held_spawn`, `discard_held_spawn`, `reassigned`, `state`) or, where it awaits
//! (Keep talking, `end`), a flow over the [`Engine`] whose synchronous checks are one job. Every
//! refusal is the TypeScript's `steward: <why>` text. The pieces the answer path and the snapshot read
//! (`steward_answer_payload`, `note_answered`, `steward_used_at_boot`, `with_steward_notes`) sit
//! beside them.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use ac_core::events::{event_now, last_attempt, read_events};
use ac_core::js;
use ac_core::pool::{TicketMarker, known_conversation_ids};
use ac_core::steward::{
    STEWARD_CLOSE_KINDS, StewardItem, StewardPoolView, StewardReview, steward_budget_of,
    steward_items, steward_may_answer, steward_may_close_of,
};
use ac_protocol::{
    AnswerBy, Interrupt, InterruptKind, ResumeAction, StewardAnswerAction, StewardNote,
    StewardStateHeld, StewardStateInterrupt, StewardStateMerge, StewardStatePending,
    StewardStateResponse, TicketEvent, TicketEventKind,
};

use crate::actor::Engine;
use crate::error::EngineError;
use crate::session::{PoolState, PoolUpdate, Session, apply_update};
use crate::snapshot::emit_snapshot;

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

/// `stewardMessageTurn`: the Turn a Steward's coaching message is typed as after the Keep talking
/// teaching Turn, marked as the Steward's so the agent knows who is talking.
pub fn steward_message_turn(message: &str) -> String {
    format!("From the pool's Steward:\n\n{}", js::trim(message))
}

fn conversation_ids(session: &Session) -> HashSet<String> {
    known_conversation_ids(Path::new(&session.pool_dir)).unwrap_or_default()
}

fn queued_ids(session: &Session) -> HashSet<String> {
    session
        .answers
        .pending()
        .into_iter()
        .map(|answer| answer.ticket_id)
        .collect()
}

/// `stewardItemsOf`: what the Steward should be told about now, built from the Session for the item
/// rule. The Merge queue and the hold are the last emitted ones: both are derived at each emit and
/// never stored. A Ticket has merged when it is done and its branch is held by nothing; engine-run
/// judges never merge.
pub fn steward_items_of(session: &Session) -> Vec<StewardItem> {
    let titles: HashMap<&str, &str> = session
        .markers
        .iter()
        .map(|marker| (marker.id.as_str(), marker.title.as_str()))
        .collect();
    let last = session.snapshots.back();
    let held: HashSet<&str> = last
        .map(|snapshot| snapshot.merge_hold.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let conversations = conversation_ids(session);
    let queued = queued_ids(session);
    let merged: Vec<String> = match last {
        Some(_) => session
            .markers
            .iter()
            .filter(|marker| {
                session.state.tickets.get(&marker.id) == Some(&ac_protocol::TicketStatus::Done)
                    && !held.contains(marker.id.as_str())
                    && ac_core::assignment::engine_ticket_build_id(&marker.id).is_none()
            })
            .map(|marker| marker.id.clone())
            .collect(),
        None => Vec::new(),
    };
    let review = if session
        .state
        .interrupts
        .iter()
        .any(|i| i.kind == InterruptKind::Review)
    {
        Some(StewardReview::Pending)
    } else if session.state.review_approved {
        Some(StewardReview::Approved)
    } else {
        None
    };
    let merge_queue = last
        .map(|snapshot| snapshot.merge_queue.clone())
        .unwrap_or_default();
    let title_of = |id: &str| titles.get(id).map(|title| (*title).to_owned());
    let left = |id: &str, kind: &str| session.steward_notes.get(id, kind).is_some();
    let keep_talking = |id: &str| session.held.contains_key(id);
    let used = |id: &str| session.steward_used.get(id).copied().unwrap_or(0);
    steward_items(&StewardPoolView {
        interrupts: &session.state.interrupts,
        title_of: &title_of,
        conversations: &conversations,
        queued: &queued,
        left: &left,
        keep_talking: &keep_talking,
        budget: steward_budget_of(&session.state.config),
        used: &used,
        may_close: steward_may_close_of(&session.state.config),
        merge_queue: &merge_queue,
        merged: &merged,
        review,
    })
}

fn steward_refusal(why: impl AsRef<str>) -> EngineError {
    EngineError::refused(format!("steward: {}", why.as_ref()))
}

/// `checkSteward`: the check every Steward action starts with: the id it names is the live Steward's.
/// It attributes the action and enforces the budget; the Console's API has no authentication, so it is
/// no security boundary (ADR-0030).
pub fn check_steward(session: &Session, conversation: &str) -> Result<(), EngineError> {
    let Some(on_duty) = crate::conversations::steward_id(session) else {
        return Err(steward_refusal("no Steward is on duty"));
    };
    if on_duty != conversation {
        return Err(steward_refusal(format!(
            "{conversation} is not the Steward on duty ({on_duty} is)"
        )));
    }
    Ok(())
}

// The pending Interrupt a Steward action is about, refused when it is not the Steward's to touch:
// review, persistence and a Conversation's own.
fn steward_interrupt(
    session: &Session,
    conversation: &str,
    ticket_id: &str,
) -> Result<Interrupt, EngineError> {
    check_steward(session, conversation)?;
    let Some(interrupt) = session
        .state
        .interrupts
        .iter()
        .find(|i| i.ticket_id == ticket_id)
    else {
        return Err(steward_refusal(format!(
            "ticket {ticket_id} has no pending Interrupt"
        )));
    };
    match interrupt.kind {
        InterruptKind::Review => {
            return Err(steward_refusal(
                "the review Interrupt is the operator's final judgement, never the Steward's",
            ));
        }
        InterruptKind::Persistence => {
            return Err(steward_refusal(
                "the persistence Interrupt is an engine store failure, never the Steward's",
            ));
        }
        _ => {}
    }
    if !steward_may_answer(
        &interrupt.ticket_id,
        interrupt.kind.as_str(),
        &conversation_ids(session),
    ) {
        return Err(steward_refusal(format!(
            "{ticket_id} is a Conversation: the Steward stewards Tickets, never talks"
        )));
    }
    if session
        .answers
        .pending()
        .iter()
        .any(|answer| answer.ticket_id == ticket_id)
    {
        return Err(steward_refusal(format!(
            "ticket {ticket_id} already has an answer queued"
        )));
    }
    Ok(interrupt.clone())
}

// The budget check (Steward budget): read off the Ticket log, the record of truth, at the moment of
// answering.
fn check_steward_budget(session: &Session, ticket_id: &str) -> Result<(), EngineError> {
    let budget = steward_budget_of(&session.state.config);
    let used = steward_budget_used(&read_events(Path::new(&session.runs_dir), ticket_id));
    if used >= budget {
        return Err(steward_refusal(format!(
            "the Steward budget on ticket {ticket_id} is spent ({used} of {budget} answers since \
             the operator last answered it): leave it to the operator with a note"
        )));
    }
    Ok(())
}

// A Steward Close (ADR-0030's #154 amendment) is allowed only while the pool's "Steward may Close
// checkpoints" is on, read at the moment the answer arrives, and only on a checkpoint or a merge
// conflict: closing a deadlocked dependent is the operator's. It needs a note saying why, and counts
// against the budget like any answer.
fn check_steward_close(
    session: &Session,
    ticket_id: &str,
    kind: &str,
    note: Option<&str>,
) -> Result<(), EngineError> {
    if !steward_may_close_of(&session.state.config) {
        return Err(steward_refusal(
            "Close is off for this pool; the operator turns on Steward may Close checkpoints in Settings",
        ));
    }
    if kind == "deadlock" {
        return Err(steward_refusal(format!(
            "closing a deadlocked ticket is the operator's: leave {ticket_id} with a note"
        )));
    }
    if !STEWARD_CLOSE_KINDS.contains(&kind) {
        return Err(steward_refusal(format!(
            "ticket {ticket_id}'s {kind} Interrupt cannot be closed"
        )));
    }
    if note.is_none_or(|note| js::trim(note).is_empty()) {
        return Err(steward_refusal(
            "a close needs a note saying why the ticket is dropped",
        ));
    }
    Ok(())
}

/// `stewardAnswer`: an answer on the operator's own path, as the Steward's. (Adopting a Candidate is
/// the operator's alone, ADR-0035: the action type has no adopt, and the route refuses the word.)
pub fn steward_answer(
    session: &mut Session,
    conversation: &str,
    ticket_id: &str,
    action: StewardAnswerAction,
    note: Option<String>,
) -> Result<(), EngineError> {
    let interrupt = steward_interrupt(session, conversation, ticket_id)?;
    let kind = interrupt.kind.as_str();
    match action {
        StewardAnswerAction::Close => {
            check_steward_close(session, ticket_id, kind, note.as_deref())?;
        }
        StewardAnswerAction::Resume if interrupt.kind == InterruptKind::MergeApproval => {
            return Err(steward_refusal(format!(
                "ticket {ticket_id}'s merge-approval takes approve or reject"
            )));
        }
        StewardAnswerAction::Approve | StewardAnswerAction::Reject
            if interrupt.kind != InterruptKind::MergeApproval =>
        {
            return Err(steward_refusal(format!(
                "ticket {ticket_id}'s {kind} Interrupt takes resume"
            )));
        }
        _ => {}
    }
    check_steward_budget(session, ticket_id)?;
    let resume = match action {
        StewardAnswerAction::Resume => ResumeAction::Resume,
        StewardAnswerAction::Approve => ResumeAction::Approve,
        StewardAnswerAction::Reject => ResumeAction::Reject,
        StewardAnswerAction::Close => ResumeAction::Close,
    };
    crate::answers::accept_answer(session, ticket_id, note, resume, None, Some(conversation))?;
    crate::answers::kick_processing(session).map_err(|e| EngineError::refused(e.to_string()))
}

/// The checks `stewardKeepTalking` makes before it calls Keep talking, all synchronous: the
/// Interrupt is a checkpoint the Steward may answer, the message says something, and the budget has
/// room. The budget is read before Keep talking's await, and the answered event it counts lands after
/// it; no second action slips between, because Keep talking claims the checkpoint synchronously once
/// its await returns, and a ticket no longer at a checkpoint refuses.
pub fn steward_keep_talking_checks(
    session: &Session,
    conversation: &str,
    ticket_id: &str,
    message: &str,
) -> Result<(), EngineError> {
    let interrupt = steward_interrupt(session, conversation, ticket_id)?;
    if interrupt.kind != InterruptKind::Checkpoint {
        return Err(steward_refusal(format!(
            "ticket {ticket_id} is not waiting at a checkpoint"
        )));
    }
    if js::trim(message).is_empty() {
        return Err(steward_refusal(
            "keep talking needs a message for the agent",
        ));
    }
    check_steward_budget(session, ticket_id)
}

/// `stewardLeave`: leaving an Interrupt to the operator (Steward note): the note is kept with the
/// Interrupt across restarts and shown in Needs input, and the leave is on the Ticket log. It never
/// counts against the budget, and the Steward is not told about the Interrupt again until it changes.
pub fn steward_leave(
    session: &mut Session,
    conversation: &str,
    ticket_id: &str,
    note: &str,
) -> Result<(), EngineError> {
    let interrupt = steward_interrupt(session, conversation, ticket_id)?;
    let text = js::trim(note);
    if text.is_empty() {
        return Err(steward_refusal(
            "a leave needs a note: the Steward's recommendation",
        ));
    }
    let at = js::now_iso();
    let kind = interrupt.kind.as_str();
    session
        .steward_notes
        .set(
            ticket_id,
            kind,
            &StewardNote {
                text: text.to_owned(),
                at: at.clone(),
                conversation: conversation.to_owned(),
            },
        )
        .map_err(|e| EngineError::refused(e.to_string()))?;
    append_log_event(
        session,
        ticket_id,
        &at,
        TicketEventKind::StewardNote,
        json!({ "kind": kind, "note": text, "by": "steward", "conversation": conversation }),
    )?;
    apply_update(
        &mut session.state,
        PoolUpdate::log([format!(
            "ticket {ticket_id}: the Steward left its {kind} Interrupt to the operator"
        )]),
    );
    let phase = session.current_phase();
    emit_snapshot(session, phase);
    Ok(())
}

fn append_log_event(
    session: &Session,
    ticket_id: &str,
    at: &str,
    kind: TicketEventKind,
    payload: Value,
) -> Result<(), EngineError> {
    let Value::Object(payload) = payload else {
        unreachable!("an event payload is an object");
    };
    let runs = Path::new(&session.runs_dir);
    let mut event = event_now(last_attempt(runs, ticket_id), kind, payload);
    event.at = at.to_owned();
    ac_core::events::append_event(runs, ticket_id, &event)
        .map_err(|e| EngineError::refused(e.to_string()))
}

/// `stewardAdoptHeldSpawn`: the Steward's Adopt of a Held spawn; the adoption it queues says whose
/// it was.
pub fn steward_adopt_held_spawn(
    session: &mut Session,
    conversation: &str,
    id: &str,
) -> Result<(), EngineError> {
    check_steward(session, conversation)?;
    // Before the Adopt, which lands at once on an idle pool.
    session
        .steward_adopts
        .insert(id.to_owned(), conversation.to_owned());
    let adopted = crate::spawns::adopt_held_spawn(session, id);
    if adopted.is_err() {
        session.steward_adopts.remove(id);
    }
    adopted
}

/// `stewardReassigned`: a Reassign by the Steward is the Console's own write of console.json (the
/// server's, reassign.ts); the engine records whose it was on each Ticket's log, since its own
/// `reassigned` follows only at the next Config reload.
pub fn steward_reassigned(
    session: &mut Session,
    conversation: &str,
    tickets: &[String],
    fields: Map<String, Value>,
) -> Result<(), EngineError> {
    check_steward(session, conversation)?;
    let at = js::now_iso();
    for ticket_id in tickets {
        append_log_event(
            session,
            ticket_id,
            &at,
            TicketEventKind::ReassignRequested,
            json!({ "fields": fields, "by": "steward", "conversation": conversation }),
        )?;
    }
    apply_update(
        &mut session.state,
        PoolUpdate::log([format!("the Steward reassigned {}", tickets.join(", "))]),
    );
    let phase = session.current_phase();
    emit_snapshot(session, phase);
    Ok(())
}

/// `stewardState`: a compact read of what the Steward stewards.
pub fn steward_state(
    session: &Session,
    conversation: &str,
) -> Result<StewardStateResponse, EngineError> {
    check_steward(session, conversation)?;
    let conversations = conversation_ids(session);
    let queued = queued_ids(session);
    let titles: HashMap<&str, &str> = session
        .markers
        .iter()
        .map(|marker| (marker.id.as_str(), marker.title.as_str()))
        .collect();
    let budget = steward_budget_of(&session.state.config);
    Ok(StewardStateResponse {
        steward: conversation.to_owned(),
        budget,
        may_close: steward_may_close_of(&session.state.config),
        phase: session.current_phase().as_str().to_owned(),
        interrupts: session
            .state
            .interrupts
            .iter()
            .map(|interrupt| {
                let used = session
                    .steward_used
                    .get(&interrupt.ticket_id)
                    .copied()
                    .unwrap_or(0);
                StewardStateInterrupt {
                    ticket_id: interrupt.ticket_id.clone(),
                    title: titles
                        .get(interrupt.ticket_id.as_str())
                        .map(|title| (*title).to_owned()),
                    kind: interrupt.kind.as_str().to_owned(),
                    answerable: steward_may_answer(
                        &interrupt.ticket_id,
                        interrupt.kind.as_str(),
                        &conversations,
                    ),
                    keep_talking: interrupt.kind == InterruptKind::Checkpoint
                        && session.held.contains_key(&interrupt.ticket_id),
                    queued: queued.contains(&interrupt.ticket_id),
                    note: session
                        .steward_notes
                        .get(&interrupt.ticket_id, interrupt.kind.as_str())
                        .map(|note| note.text),
                    used,
                    remaining: budget.saturating_sub(used),
                }
            })
            .collect(),
        merge_queue: session
            .snapshots
            .back()
            .map(|snapshot| {
                snapshot
                    .merge_queue
                    .iter()
                    .map(|entry| StewardStateMerge {
                        ticket_id: entry.ticket_id.clone(),
                        state: entry.state.as_str().to_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        pending_spawns: session
            .spawn_proposals
            .pending_views()
            .into_iter()
            .map(|view| StewardStatePending {
                id: view.id,
                parent_id: view.parent_id,
                title: view.title,
            })
            .collect(),
        held_spawns: session
            .spawn_proposals
            .held_views()
            .into_iter()
            .map(|view| StewardStateHeld {
                id: view.id,
                parent_id: view.parent_id,
                title: view.title,
                reason: view.reason.as_str().to_owned(),
            })
            .collect(),
        ledger: crate::spawns::ledger_path(session),
    })
}

/// `StewardActions.keepTalking`: the checks, then Keep talking as the Steward's, its message typed
/// after the teaching Turn.
pub async fn steward_keep_talking(
    engine: &Engine,
    conversation: String,
    ticket_id: String,
    message: String,
) -> Result<u64, EngineError> {
    let (c, t, m) = (conversation.clone(), ticket_id.clone(), message.clone());
    engine
        .call(move |s| steward_keep_talking_checks(s, &c, &t, &m))
        .await??;
    crate::keep_talking::keep_talking(
        engine,
        ticket_id,
        Some(crate::keep_talking::StewardTalk {
            conversation,
            message,
        }),
    )
    .await
}

/// `StewardActions.end`: the one way a Conversation ends without the operator (ADR-0030).
pub async fn steward_end(
    engine: &Engine,
    conversation: String,
    closing: Option<String>,
) -> Result<(), EngineError> {
    let c = conversation.clone();
    engine.call(move |s| check_steward(s, &c)).await??;
    crate::conversations::end(engine, &conversation, closing, AnswerBy::Steward).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn event(kind: TicketEventKind, payload: Value) -> Arc<TicketEvent> {
        let Value::Object(payload) = payload else {
            unreachable!("a payload is an object");
        };
        Arc::new(TicketEvent {
            at: "2026-10-01T00:00:00.000Z".to_owned(),
            attempt: 1,
            kind,
            payload,
        })
    }

    fn answered(payload: Value) -> Arc<TicketEvent> {
        event(TicketEventKind::Answered, payload)
    }

    // steward.test.ts: the Steward budget, read off the Ticket log
    #[test]
    fn counts_the_stewards_answers_and_keep_talks_since_the_operator_last_answered() {
        assert_eq!(steward_budget_used(&[]), 0);
        assert_eq!(
            steward_budget_used(&[
                answered(json!({ "kind": "checkpoint", "by": "steward" })),
                answered(json!({ "kind": "checkpoint" })),
                answered(json!({ "kind": "checkpoint", "by": "steward" })),
                event(TicketEventKind::StewardNote, json!({ "by": "steward" })),
                answered(
                    json!({ "kind": "checkpoint", "action": "keep-talking", "by": "steward" })
                ),
            ]),
            2
        );
        // The operator's answer resets it.
        assert_eq!(
            steward_budget_used(&[
                answered(json!({ "kind": "crash", "by": "steward" })),
                answered(json!({ "kind": "crash" })),
            ]),
            0
        );
    }

    #[test]
    fn an_answer_by_the_steward_carries_who_and_the_trimmed_note_and_a_resume_has_no_action() {
        let payload = steward_answer_payload("conv-1", ResumeAction::Resume, Some("  go on \n"));
        assert_eq!(
            Value::Object(payload),
            json!({ "by": "steward", "conversation": "conv-1", "note": "go on" })
        );
        let payload = steward_answer_payload("conv-1", ResumeAction::Approve, Some("  "));
        assert_eq!(
            Value::Object(payload),
            json!({ "by": "steward", "conversation": "conv-1", "action": "approve" })
        );
    }

    #[test]
    fn types_a_coaching_message_as_the_stewards() {
        assert_eq!(
            steward_message_turn("  try the smaller fix \n"),
            "From the pool's Steward:\n\ntry the smaller fix"
        );
    }

    // conformance/NOT-PORTED.md (C18): the two Steward refusals no black-box case reaches.
    async fn steward_on_duty_over_a_settled_pool() -> (crate::testkit::Pool, Engine) {
        use ac_core::conversation_record::{ConversationRecord, write_conversation};
        use ac_protocol::{ConversationRole, ConversationStatus};

        let pool = crate::testkit::Pool::git(&[("01", &[])]);
        let engine = pool.start().await;
        crate::testkit::settled(&engine).await;
        let dir = pool.file("conversations");
        write_conversation(
            &dir,
            &ConversationRecord {
                id: "conv-1".into(),
                file: dir.join("conv-1.md"),
                title: "Steward".into(),
                opening: String::new(),
                status: ConversationStatus::Live,
                spawned_by: None,
                harness: "claude".into(),
                model: "m".into(),
                effort: None,
                drivers: String::new(),
                enlisted: None,
                role: Some(ConversationRole::Steward),
            },
        )
        .unwrap();
        (pool, engine)
    }

    fn pending(ticket_id: &str, kind: InterruptKind) -> Interrupt {
        Interrupt {
            ticket_id: ticket_id.into(),
            kind,
            body: "b".into(),
            candidates: None,
            steward_note: None,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refuses_a_steward_answer_whose_ticket_id_is_a_known_conversation() {
        use ac_core::conversation_record::{ConversationRecord, write_conversation};
        use ac_protocol::ConversationStatus;

        let (pool, engine) = steward_on_duty_over_a_settled_pool().await;
        let dir = pool.file("conversations");
        write_conversation(
            &dir,
            &ConversationRecord {
                id: "conv-2".into(),
                file: dir.join("conv-2.md"),
                title: "Talk".into(),
                opening: String::new(),
                status: ConversationStatus::Live,
                spawned_by: None,
                harness: "claude".into(),
                model: "m".into(),
                effort: None,
                drivers: String::new(),
                enlisted: None,
                role: None,
            },
        )
        .unwrap();
        let refusal = engine
            .call(|s| {
                s.state
                    .interrupts
                    .push(pending("conv-2", InterruptKind::MergeConflict));
                steward_answer(s, "conv-1", "conv-2", StewardAnswerAction::Resume, None)
            })
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(
            refusal.message(),
            "steward: conv-2 is a Conversation: the Steward stewards Tickets, never talks"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refuses_a_steward_resume_on_a_merge_approval_interrupt() {
        let (_pool, engine) = steward_on_duty_over_a_settled_pool().await;
        let refusal = engine
            .call(|s| {
                s.state
                    .interrupts
                    .push(pending("01", InterruptKind::MergeApproval));
                steward_answer(s, "conv-1", "01", StewardAnswerAction::Resume, None)
            })
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(
            refusal.message(),
            "steward: ticket 01's merge-approval takes approve or reject"
        );
    }
}
