//! Answers (ADR-0004; engine.ts 5397-5887): accepting an answer, the processing kick, the drain that
//! applies queued answers in submission order, processing one, and Close (issue #154).

use std::path::Path;

use serde_json::{Map, Value};

use ac_core::assignment::{engine_ticket_build_id, resolve_unseen_assignments};
use ac_core::events::{append_event, event_now, last_attempt, read_events};
use ac_core::js;
use ac_core::pool::{TicketMarker, is_finished, load_pool_tickets, write_marker_status};
use ac_core::queued_answers::AcceptedAnswer;
use ac_io::git::{self, WorktreeInfo};
use ac_protocol::{
    AnswerBy, Interrupt, InterruptKind, QueuedAnswer, QueuedAnswerAction, ResumeAction, RunPhase,
    TicketEventKind, TicketStatus,
};

use crate::checkout_gate::{in_pool_checkout, pool_checkout_held};
use crate::error::EngineError;
use crate::interrupts::{
    CLOSE_KINDS, approve_review, clear_interrupt, named_review_tickets, reject_review,
    review_reject_unnamed_error,
};
use crate::merges::{
    approve_merge, reconcile_ticket_file, record_ticket_file_conflict, reject_merge, resume_merge,
    seed_path_for, ticket_worktree,
};
use crate::session::{PERSISTENCE_TICKET_ID, PoolUpdate, Session};
use crate::snapshot::emit_snapshot;
use crate::steward_actions::{note_answered, steward_answer_payload};
use crate::tickets::was_enlisted;
use crate::verify::{
    adopt_candidate, adopt_refusal, parse_selection_answer, process_selection_answer,
    selection_answer_error,
};

fn refused(message: impl Into<String>) -> EngineError {
    EngineError::refused(message)
}

fn fs_refused(error: impl std::fmt::Display) -> EngineError {
    EngineError::refused(error.to_string())
}

/// `acceptAnswer`: the answer is recorded and acknowledged, nothing else (ADR-0004): the `answered`
/// event lands in the ticket log first, then the queued record in its own store. Never mutates state
/// and never spawns. Idempotent: an answer matching one already queued (or, with its interrupt gone,
/// one already accepted) is acknowledged with the existing record. The checks run in the
/// TypeScript's order. `steward` names the Steward's Conversation when the Steward answers.
pub fn accept_answer(
    session: &mut Session,
    ticket_id: &str,
    note: Option<String>,
    action: ResumeAction,
    attempt: Option<u64>,
    steward: Option<&str>,
) -> Result<QueuedAnswer, EngineError> {
    let approve = match action {
        ResumeAction::Approve => Some(true),
        ResumeAction::Reject => Some(false),
        _ => None,
    };
    let queued_action = match action {
        ResumeAction::Close => Some(QueuedAnswerAction::Close),
        ResumeAction::Adopt => Some(QueuedAnswerAction::Adopt),
        _ => None,
    };
    let adopt = action == ResumeAction::Adopt;
    let close = action == ResumeAction::Close;
    if adopt && attempt.is_none() {
        return Err(refused(format!(
            "answer: adopt needs the attempt number of the candidate to take for {ticket_id}"
        )));
    }
    if !adopt && attempt.is_some() {
        return Err(refused(format!(
            "answer: an attempt only goes with adopt, not {action}, for {ticket_id}"
        )));
    }
    let Some(pending) = session
        .state
        .interrupts
        .iter()
        .find(|i| i.ticket_id == ticket_id)
        .cloned()
    else {
        if let Some(prior) = session
            .answers
            .latest_for(ticket_id, approve, queued_action, attempt)
        {
            return Ok(prior.clone());
        }
        return Err(refused(format!(
            "resume: no pending interrupt for ticket {ticket_id}"
        )));
    };
    if adopt && let Some(refusal) = adopt_refusal(&pending, attempt.unwrap_or_default()) {
        return Err(refused(refusal));
    }
    if close && !CLOSE_KINDS.contains(&pending.kind) {
        return Err(refused(format!(
            "answer: close takes a checkpoint, merge-conflict or deadlock interrupt, got {} for \
             {ticket_id}",
            pending.kind
        )));
    }
    if close && session.marker(ticket_id).is_none() {
        return Err(refused(format!(
            "answer: {ticket_id} is not a Ticket in this pool; only a Ticket can be closed"
        )));
    }
    if pending.kind == InterruptKind::Review && approve.is_none() {
        return Err(refused(
            "answer: use approve() or reject() for the final review interrupt",
        ));
    }
    if pending.kind == InterruptKind::MergeApproval && approve.is_none() {
        return Err(refused(format!(
            "answer: use approve() or reject() for the merge-approval interrupt on ticket {ticket_id}"
        )));
    }
    let queued = session.answers.pending();
    if let Some(duplicate) = queued.iter().find(|a| {
        a.ticket_id == ticket_id
            && a.kind == pending.kind
            && a.approve == approve
            && a.action == queued_action
            && a.attempt == attempt
    }) {
        return Ok(duplicate.clone());
    }
    // A different answer already queued wins at the drain; this one is refused now, while the
    // answerer is still listening.
    if queued.iter().any(|a| a.ticket_id == ticket_id) {
        return Err(EngineError::AnswerQueuedConflict(format!(
            "answer: ticket {ticket_id} already has an answer queued"
        )));
    }
    if pending.kind == InterruptKind::Review
        && approve == Some(false)
        && named_review_tickets(&session.markers, note.as_deref()).is_empty()
    {
        return Err(refused(review_reject_unnamed_error(&session.markers)));
    }
    if pending.kind == InterruptKind::Selection {
        let named = parse_selection_answer(note.as_deref());
        let candidate = named.is_some_and(|n| {
            pending
                .candidates
                .as_ref()
                .is_some_and(|candidates| candidates.contains(&n))
        });
        if !candidate {
            return Err(refused(selection_answer_error(&pending, note.as_deref())));
        }
    }
    let mut payload = Map::new();
    payload.insert(
        "kind".into(),
        Value::String(pending.kind.as_str().to_owned()),
    );
    if let Some(queued_action) = queued_action {
        payload.insert(
            "action".into(),
            Value::String(queued_action.as_str().to_owned()),
        );
        if adopt {
            payload.insert("attempt".into(), Value::from(attempt.unwrap_or_default()));
        }
        if let Some(note) = note.as_deref().map(js::trim).filter(|n| !n.is_empty()) {
            payload.insert("note".into(), Value::String(note.to_owned()));
        }
    }
    if let Some(conversation) = steward {
        payload.extend(steward_answer_payload(
            conversation,
            action,
            note.as_deref(),
        ));
    }
    let runs = Path::new(&session.runs_dir).to_path_buf();
    append_event(
        &runs,
        ticket_id,
        &event_now(
            last_attempt(&runs, ticket_id),
            TicketEventKind::Answered,
            payload,
        ),
    )
    .map_err(fs_refused)?;
    let record = session
        .answers
        .enqueue(AcceptedAnswer {
            ticket_id: ticket_id.to_owned(),
            kind: pending.kind,
            approve,
            action: queued_action,
            attempt: if adopt { attempt } else { None },
            note,
            by: steward.map(|_| AnswerBy::Steward),
            at: js::now_iso(),
        })
        .map_err(fs_refused)?;
    note_answered(
        session,
        ticket_id,
        if steward.is_some() {
            AnswerBy::Steward
        } else {
            AnswerBy::Operator
        },
    );
    // Mid-flight acceptance is the one moment the queue changes without an emit of its own.
    if session.driving {
        session.queued_since_drain = true;
        emit_snapshot(session, RunPhase::Running);
    }
    Ok(record)
}

/// `kickProcessing`: every answer path's second step. Idle, the drain applies the answer right away
/// and a fresh drive starts; in flight, the queued record waits for the boundary drain.
pub fn kick_processing(session: &mut Session) -> anyhow::Result<()> {
    if session.driving {
        return Ok(());
    }
    drain_answers(session)?;
    crate::drive::start_drive(session);
    Ok(())
}

/// `drainAnswers`: every queued answer applied in submission order. One that fails processing
/// rejects its own waiters and is consumed; a processed one persists the resulting state itself
/// before its record is marked processed. A persist failure propagates.
pub fn drain_answers(session: &mut Session) -> anyhow::Result<()> {
    session.queued_since_drain = false;
    for record in session.answers.pending() {
        // An answer that merges into the pool checkout waits, still queued, while a Continued attempt
        // works there (ADR-0027). A Close merges nothing, so it never waits.
        let merges_into_checkout = record.action == Some(QueuedAnswerAction::Adopt)
            || (record.action != Some(QueuedAnswerAction::Close)
                && matches!(
                    record.kind,
                    InterruptKind::MergeConflict
                        | InterruptKind::MergeApproval
                        | InterruptKind::Selection
                ));
        if pool_checkout_held(session) && merges_into_checkout {
            continue;
        }
        let waiters = session
            .answer_waiters
            .remove(&record.seq)
            .unwrap_or_default();
        if let Err(error) = process_answer(session, &record) {
            session.answers.mark_processed(record.seq)?;
            for waiter in waiters {
                let _ = waiter.send(Err(EngineError::refused(error.to_string())));
            }
            continue;
        }
        if let Err(error) = crate::persist::persist(session) {
            for waiter in waiters {
                let _ = waiter.send(Err(EngineError::refused(error.to_string())));
            }
            return Err(error);
        }
        session.answers.mark_processed(record.seq)?;
        for waiter in waiters {
            let _ = waiter.send(Ok(()));
        }
    }
    Ok(())
}

/// `processAnswer`: apply one accepted answer to state and the markers.
pub fn process_answer(session: &mut Session, record: &QueuedAnswer) -> anyhow::Result<()> {
    let Some(pending) = session
        .state
        .interrupts
        .iter()
        .find(|i| i.ticket_id == record.ticket_id)
        .cloned()
    else {
        anyhow::bail!(
            "resume: no pending interrupt for ticket {}",
            record.ticket_id
        );
    };
    session.markers = load_pool_tickets(Path::new(&session.pool_dir), false)?;
    resolve_unseen_assignments(
        &session.markers,
        &mut session.assignments,
        &session.state.config,
        &session.harnesses,
    )?;
    let note = record.note.as_deref();
    if pending.kind == InterruptKind::Review {
        if record.approve == Some(true) {
            approve_review(session, &pending, note);
            return Ok(());
        }
        return reject_review(session, &pending, note);
    }
    // The persistence interrupt belongs to the run: answering it only clears it, and the resumed
    // drive's next boundary write is the retry.
    if pending.kind == InterruptKind::Persistence {
        clear_interrupt(
            session,
            &pending,
            format!(
                "interrupt answered for {PERSISTENCE_TICKET_ID} (persistence): the drive retries the \
                 checkpoint write"
            ),
        );
        return Ok(());
    }
    if matches!(
        pending.kind,
        InterruptKind::MergeConflict | InterruptKind::MergeApproval
    ) && session.conversations.is_live(&record.ticket_id)
    {
        return crate::conversations::answer_merge(
            session,
            &record.ticket_id,
            &pending,
            record.approve,
        );
    }
    let Some(marker) = session.marker(&record.ticket_id).cloned() else {
        anyhow::bail!(
            "resume: ticket {} has no Issue file in {}",
            record.ticket_id,
            session.issues_dir
        );
    };
    match record.action {
        Some(QueuedAnswerAction::Close) => return close_ticket(session, &marker, &pending, record),
        Some(QueuedAnswerAction::Adopt) => {
            return adopt_candidate(session, &marker, &pending, record);
        }
        None => {}
    }
    match pending.kind {
        InterruptKind::MergeConflict => return resume_merge(session, &marker, &pending, note),
        InterruptKind::MergeApproval => {
            return if record.approve == Some(true) {
                approve_merge(session, &marker, &pending, note)
            } else {
                reject_merge(session, &marker, &pending, note)
            };
        }
        InterruptKind::Selection => {
            return process_selection_answer(session, &marker, &pending, note);
        }
        _ => {}
    }
    // Answering an adoption checkpoint abandons the re-adopted attempt (ADR-0014).
    if session.adopted.contains_key(&record.ticket_id) {
        crate::restart::abandon_adoption(session, &record.ticket_id);
    }
    // A plain Resume passes the Held pane over (issue #139): the next Attempt launches fresh.
    session.held.shift_remove(&record.ticket_id);
    if marker.status != TicketStatus::Done {
        write_marker_status(&marker.file, TicketStatus::Ready)?;
        if let Some(m) = session.marker_mut(&marker.id) {
            m.status = TicketStatus::Ready;
        }
    }
    if let Some(note) = note.map(js::trim).filter(|n| !n.is_empty()) {
        // The Steward's note is marked as its own (ADR-0030).
        let heading = if record.by == Some(AnswerBy::Steward) {
            "## Resume note, from the Steward"
        } else {
            "## Resume note"
        };
        js::append_file(&marker.file, &format!("\n{heading}\n\n{note}\n"))?;
    }
    let tickets = session.marker_statuses();
    let interrupts: Vec<Interrupt> = session
        .state
        .interrupts
        .iter()
        .filter(|i| i.ticket_id != record.ticket_id)
        .cloned()
        .collect();
    let line = format!(
        "interrupt answered for {} ({}): {}{}",
        record.ticket_id,
        pending.kind,
        if marker.status == TicketStatus::Done {
            "already done on disk"
        } else {
            "resumed"
        },
        if record.by == Some(AnswerBy::Steward) {
            " by the Steward"
        } else {
            ""
        }
    );
    session.apply(PoolUpdate {
        tickets: Some(tickets),
        interrupts: Some(interrupts),
        log: Some(vec![line]),
        ..PoolUpdate::default()
    });
    Ok(())
}

/// `closeTicket`: Close (issue #154) drops the ticket where it stands and never merges it. Its status
/// becomes `closed`, finished for the run's end and the Review but never satisfying a `blocked-by`.
/// Its work is discarded as a losing Attempt's is, after whatever an agent wrote into a worktree copy
/// of the ticket file is carried into the file of record; an enlisted ticket's work is the operator's.
pub fn close_ticket(
    session: &mut Session,
    marker: &TicketMarker,
    pending: &Interrupt,
    record: &QueuedAnswer,
) -> anyhow::Result<()> {
    if session.adopted.contains_key(&marker.id) {
        crate::restart::abandon_adoption(session, &marker.id);
    }
    session.held.shift_remove(&marker.id);
    let enlisted = was_enlisted(session, &marker.id);
    let work = if enlisted {
        "enlisted, so its branch, directory and pane were left as found".to_owned()
    } else {
        discard_closed_work(session, marker)
    };
    write_marker_status(&marker.file, TicketStatus::Closed)?;
    if let Some(m) = session.marker_mut(&marker.id) {
        m.status = TicketStatus::Closed;
    }
    if let Some(note) = record
        .note
        .as_deref()
        .map(js::trim)
        .filter(|n| !n.is_empty())
    {
        let heading = if record.by == Some(AnswerBy::Steward) {
            "## Close note, from the Steward"
        } else {
            "## Close note"
        };
        js::append_file(&marker.file, &format!("\n{heading}\n\n{note}\n"))?;
    }
    // Best-effort like every rule close: a survey that could not be had closes nothing.
    if !enlisted {
        let engine = session.engine();
        let id = marker.id.clone();
        tokio::spawn(async move { crate::terminals::close_ticket_tabs(&engine, &id).await });
    }
    crate::conversations::ticket_closed(session, marker, record.note.as_deref());
    let cascaded = close_engine_tickets(session, &marker.id)?;
    let mut closed = vec![marker.id.clone()];
    closed.extend(cascaded.iter().cloned());
    let mut log = vec![format!(
        "interrupt answered for {} ({}): closed{}; {work}",
        marker.id,
        pending.kind,
        if record.by == Some(AnswerBy::Steward) {
            " by the Steward"
        } else {
            ""
        }
    )];
    log.extend(
        cascaded
            .iter()
            .map(|id| format!("ticket {id}: closed with its build ticket {}", marker.id)),
    );
    let interrupts: Vec<Interrupt> = session
        .state
        .interrupts
        .iter()
        .filter(|i| !closed.contains(&i.ticket_id))
        .cloned()
        .collect();
    session.apply(PoolUpdate {
        tickets: Some(
            closed
                .iter()
                .map(|id| (id.clone(), TicketStatus::Closed))
                .collect(),
        ),
        interrupts: Some(interrupts),
        log: Some(log),
        ..PoolUpdate::default()
    });
    Ok(())
}

// `discardClosedWork`: the closed ticket's work, discarded unmerged where it has a branch of its own,
// and what happened to it, for the pool log. A failure part way is reported in that line and stops the
// discard there, rather than the Close.
fn discard_closed_work(session: &mut Session, marker: &TicketMarker) -> String {
    let mut discarded: Vec<String> = Vec::new();
    let mut worktrees: Vec<WorktreeInfo> = Vec::new();
    let outcome = (|| -> anyhow::Result<Option<String>> {
        if session.git {
            let mut attempts = git::attempt_branches(&session.cwd, &marker.id);
            attempts.sort_unstable();
            worktrees = attempts
                .into_iter()
                .map(|attempt| ticket_worktree(session, marker, Some(u64::from(attempt))))
                .collect();
            if git::branch_exists(&session.cwd, &marker.id, None) {
                worktrees.push(ticket_worktree(session, marker, None));
            }
        }
        if worktrees.is_empty() {
            return Ok(Some(closed_work_without_branch(session, marker)));
        }
        for worktree in worktrees.clone() {
            keep_ticket_file_notes(session, marker, &worktree)?;
            git::discard_worktree(&session.cwd, &worktree);
            discarded.push(worktree.branch.clone());
        }
        Ok(None)
    })();
    match outcome {
        Ok(Some(without)) => without,
        Ok(None) => format!(
            "discarded {} unmerged, with {}",
            discarded.join(", "),
            if discarded.len() == 1 {
                "its worktree"
            } else {
                "their worktrees"
            }
        ),
        Err(error) => {
            let left: Vec<&str> = worktrees
                .iter()
                .map(|w| w.branch.as_str())
                .filter(|branch| !discarded.iter().any(|d| d == branch))
                .collect();
            format!(
                "{}discarding its work failed ({error}){}",
                if discarded.is_empty() {
                    String::new()
                } else {
                    format!("discarded {} unmerged; ", discarded.join(", "))
                },
                if left.is_empty() {
                    String::new()
                } else {
                    format!(
                        "; {} {} still there",
                        left.join(", "),
                        if left.len() == 1 { "is" } else { "are" }
                    )
                }
            )
        }
    }
}

// `closedWorkWithoutBranch`: what became of a closed ticket's work when it has no branch.
fn closed_work_without_branch(session: &Session, marker: &TicketMarker) -> String {
    let cwds: Vec<Value> = read_events(Path::new(&session.runs_dir), &marker.id)
        .iter()
        .filter(|event| event.kind == TicketEventKind::Spawned)
        .map(|event| event.payload.get("cwd").cloned().unwrap_or(Value::Null))
        .collect();
    if cwds.is_empty() {
        return "it never ran, so there was no work to discard".into();
    }
    // A pool worktree lives under the common git dir, inside the pool checkout's own directory, so it
    // is told apart by its path first.
    let worktree_path = git::worktree_path_for(&session.cwd, &marker.id, None);
    let worktrees = Path::new(&worktree_path)
        .parent()
        .map(js::path_text)
        .unwrap_or_default();
    let ran_here = !session.git
        || cwds.iter().any(|cwd| {
            cwd.as_str().is_some_and(|cwd| {
                !cwd.starts_with(&format!("{worktrees}/")) && in_pool_checkout(session, cwd)
            })
        });
    if ran_here {
        "it ran in the pool checkout, so its work was left in place there; nothing was reset".into()
    } else {
        "its branch was already gone, so there was no work to discard".into()
    }
}

// `keepTicketFileNotes`: carry what an agent wrote into its worktree's copy of the ticket file into the
// file of record before the worktree goes. A copy still equal to its seed holds nothing of the agent's,
// and a worktree with no seed kept is left alone.
fn keep_ticket_file_notes(
    session: &mut Session,
    marker: &TicketMarker,
    worktree: &WorktreeInfo,
) -> anyhow::Result<()> {
    let seed_path = seed_path_for(session, &marker.id, &worktree.branch);
    if !Path::new(&seed_path).exists() {
        return Ok(());
    }
    let rel = js::path_relative(&session.cwd, &js::path_text(&marker.file));
    let copy = js::path_join(&[&worktree.path, &rel]);
    let theirs = if Path::new(&copy).exists() {
        Some(js::read_text(&copy)?)
    } else {
        git::show_file(&session.cwd, &format!("{}:{rel}", worktree.branch))
    };
    let Some(theirs) = theirs else {
        return Ok(());
    };
    if theirs == js::read_text(&seed_path)? {
        return Ok(());
    }
    let ours = js::read_text(&marker.file)?;
    let (content, conflicted) =
        reconcile_ticket_file(session, marker, &worktree.branch, &ours, &theirs)?;
    js::write_file(&marker.file, &content)?;
    if conflicted {
        record_ticket_file_conflict(session, marker, &worktree.branch)?;
    }
    Ok(())
}

// `closeEngineTickets`: the engine-written judges of a closed build ticket close with it. The ids
// closed.
fn close_engine_tickets(session: &mut Session, build_id: &str) -> anyhow::Result<Vec<String>> {
    let mut closed = Vec::new();
    for marker in &mut session.markers {
        if engine_ticket_build_id(&marker.id) != Some(build_id) || is_finished(Some(marker.status))
        {
            continue;
        }
        write_marker_status(&marker.file, TicketStatus::Closed)?;
        marker.status = TicketStatus::Closed;
        closed.push(marker.id.clone());
    }
    Ok(closed)
}
