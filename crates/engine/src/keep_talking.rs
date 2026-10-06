//! Keep talking and Continued attempts (issue #139; engine.ts 4611-5190): continue a checkpointed
//! Attempt in its Held pane, record its ending, and grade a verify ticket's Continued attempt as a lone
//! attempt. The runtime half (the log, the teaching Turn, the ending race) is [`crate::continued`].

use std::path::Path;

use serde_json::{Map, Value};

use ac_core::events::{
    append_event, attempt_log_name, attempt_outcome_name, attempt_stream_name, event_now,
    next_attempt, read_events,
};
use ac_core::js;
use ac_core::outcome::validate_outcome;
use ac_core::pool::TicketMarker;
use ac_core::spawn_ledger::spawn_ledger_path;
use ac_core::verify_prompts::{
    ContinuedTeachingParts, KeptTalkingBy, build_continued_teaching, steward_message_turn,
};
use ac_io::git;
use ac_io::herdr::PaneAgentState;
use ac_protocol::{
    AnswerBy, InterruptKind, OutcomeStatus, RunPhase, SpawnKind, TicketEventKind, TicketStatus,
};

use crate::actor::Engine;
use crate::attempt_ending::{
    AttemptEnding, AttemptEndingDecision, EXIT_CODE_PANE_GONE, EXIT_CODE_UNREADABLE,
    SPAWN_INTERACTIVE_PROMPT_FAILED, read_attempt_result,
};
use crate::attempt_run::{read_log_tail, release_attempt_agent, report_attempt_agent};
use crate::checkout_gate::{
    hold_pool_checkout, in_pool_checkout, other_agent_in_pool_checkout, pool_checkout_free,
    release_pool_checkout,
};
use crate::continued::{
    ContinuedEnding, ContinuedEnv, ContinuedInput, ContinuedRelease, run_continued,
};
use crate::enlist_flow::end_enlisted_attempt;
use crate::enlisted::EnlistedEnding;
use crate::error::EngineError;
use crate::held::{
    ContinuedWork, HeldPane, held_exit_code_path, held_pane_listed, held_pane_of, pane_assignment,
    restore_assignment, tui_exited,
};
use crate::live_attempts::LiveAttemptEntry;
use crate::persist::persist_with_retry;
use crate::restart::{finish_adopted_finalize, record_adopted_exit};
use crate::session::{PoolUpdate, Session};
use crate::snapshot::emit_snapshot;
use crate::spawns::take_spawn_proposals;
use crate::steward_actions::note_answered;
use crate::tickets::{TicketPlan, TicketResult};
use crate::verify::{checkpoint_ticket_by_engine, grade_round, resolve_lone_attempt};

/// One Continued attempt in flight.
#[derive(Debug, Clone)]
pub struct ContinuedAttempt {
    pub attempt: u64,
    pub work: HeldPane,
    /// Whether it works inside the pool checkout's tree, decided once at its start.
    pub in_pool_checkout: bool,
    /// Lets its pane go without an ending.
    pub release: ContinuedRelease,
    pub log_path: String,
    pub outcome_path: String,
}

/// A verify ticket's Continued attempt that ended done and waits to be graded as a lone attempt.
#[derive(Debug, Clone)]
pub struct ContinuedGrade {
    pub ticket_id: String,
    pub attempt: u64,
    pub work: HeldPane,
}

/// The Steward choosing Keep talking (ADR-0030): its message is typed after the teaching Turn, and the
/// answer is its own, counted on its budget.
#[derive(Debug, Clone)]
pub struct StewardTalk {
    pub conversation: String,
    pub message: String,
}

fn runs(session: &Session) -> &Path {
    Path::new(&session.runs_dir)
}

fn refusal(ticket_id: &str, why: &str) -> EngineError {
    EngineError::refused(format!("keep talking: ticket {ticket_id} {why}"))
}

/// The ticket and its Held pane when Keep talking may claim them: waiting at a checkpoint Interrupt
/// with no answer queued and a pane held.
fn check(session: &Session, ticket_id: &str) -> Result<(TicketMarker, HeldPane), EngineError> {
    let interrupt = session
        .state
        .interrupts
        .iter()
        .find(|i| i.ticket_id == ticket_id);
    let marker = session.marker(ticket_id);
    // The state, not the marker object: a checkpoint joined at its attempt's exit reaches the markers
    // only at the boundary persist, and a sibling may still be running.
    let (Some(interrupt), Some(marker)) = (interrupt, marker) else {
        return Err(refusal(ticket_id, "is not waiting at a checkpoint"));
    };
    if interrupt.kind != InterruptKind::Checkpoint
        || session.state.tickets.get(ticket_id) != Some(&TicketStatus::Checkpoint)
        || session.adopted.contains_key(ticket_id)
    {
        return Err(refusal(ticket_id, "is not waiting at a checkpoint"));
    }
    if session
        .answers
        .pending()
        .iter()
        .any(|answer| answer.ticket_id == ticket_id)
    {
        return Err(refusal(
            ticket_id,
            "already has an answer to its checkpoint queued",
        ));
    }
    let Some(held) = session.held.get(ticket_id) else {
        return Err(refusal(ticket_id, "has no terminal left to continue in"));
    };
    Ok((marker.clone(), held.clone()))
}

/// `keepTalking` (issue #139): continue a ticket's checkpointed Attempt in its Held pane as a Continued
/// attempt. It starts at once, never queued for the super-step boundary and never held by the Merge
/// hold, exactly as an enlist claims its pane (an exception to ADR-0004, like Enlist): the agent that
/// holds the context is waiting in the pane now, and the operator chose to talk to it now. What makes
/// that safe is what Keep talking does not do: it launches nothing, opens no worktree and merges
/// nothing, so nothing the boundary serialises is touched here; the Continued attempt's ending is
/// recorded the way an adopted attempt's is, off the drive loop, and a verify ticket's grading waits for
/// the drive ([`grade_continued_attempts`]).
///
/// The claim answers the checkpoint Interrupt (the ticket leaves Needs input), writes the marker
/// in-progress, numbers the next Attempt, records a `spawned` event naming the same pane and tab and
/// the attempt it continues, and registers it live on that pane, all before this resolves. The runtime
/// then brings the pane forward, types the one teaching Turn once the agent is waiting, and watches for
/// the ending. Resolves with the new Attempt's number.
pub async fn keep_talking(
    engine: &Engine,
    ticket_id: String,
    steward: Option<StewardTalk>,
) -> Result<u64, EngineError> {
    let id = ticket_id.clone();
    engine
        .call(move |s| -> Result<(), EngineError> {
            if s.pane_survey.is_none() {
                return Err(refusal(&id, "is in a pool that is not terminal-backed"));
            }
            check(s, &id).map(drop)
        })
        .await??;
    // The pane is asked about now, with a listing begun after this call, not the survey's last cadence:
    // a Continued attempt claimed over a closed pane would crash at once.
    let listed = engine.refresh_pane_survey().await;
    engine
        .call(move |s| claim(s, &ticket_id, listed, steward))
        .await?
}

// The claim: synchronous from the second check on, so no answer, boundary or second Keep talking can
// land between the check and the ticket moving.
fn claim(
    session: &mut Session,
    ticket_id: &str,
    listed: bool,
    steward: Option<StewardTalk>,
) -> Result<u64, EngineError> {
    let (marker, held) = check(session, ticket_id)?;
    if !listed {
        return Err(refusal(
            ticket_id,
            "cannot be checked: the herdr daemon did not list its panes",
        ));
    }
    let let_go = |session: &mut Session, why: String| -> EngineError {
        session.held.shift_remove(ticket_id);
        let phase = session.current_phase();
        emit_snapshot(session, phase);
        refusal(ticket_id, &why)
    };
    if !held_pane_listed(session, &held) {
        return Err(let_go(
            session,
            format!("lost its terminal: pane {} is gone", held.pane_id),
        ));
    }
    if tui_exited(session, ticket_id, &held) {
        return Err(let_go(
            session,
            format!(
                "lost its agent: the TUI in pane {} has exited",
                held.pane_id
            ),
        ));
    }
    // The pool checkout holds one agent at a time (ADR-0027): a Continued attempt there beside another
    // agent working there would be two writers in one tree.
    let beside = if in_pool_checkout(session, &held.cwd) {
        other_agent_in_pool_checkout(session, ticket_id)
    } else {
        None
    };
    if let Some(beside) = beside {
        return Err(refusal(
            ticket_id,
            &format!("worked in the pool checkout, where {beside}; keep talking once it is done"),
        ));
    }
    claim_pane(session, &marker, held, steward).map_err(|err| EngineError::refused(err.to_string()))
}

fn claim_pane(
    session: &mut Session,
    marker: &TicketMarker,
    held: HeldPane,
    steward: Option<StewardTalk>,
) -> anyhow::Result<u64> {
    let ticket_id = marker.id.as_str();
    let attempt = next_attempt(runs(session), ticket_id);
    let naming = held.numbered.then_some(attempt);
    let log_path = js::path_join(&[
        &session.runs_dir,
        &attempt_log_name(ticket_id, naming, false),
    ]);
    let outcome_path = js::path_join(&[
        &session.runs_dir,
        &attempt_outcome_name(ticket_id, naming, false),
    ]);
    // A solo ticket's well-known log is the checkpointed attempt's until it rotates, and so is its
    // Stream file, which `script` keeps writing under the rotated name (a rename moves no open file); a
    // verify attempt's are attempt-numbered already.
    if !held.numbered {
        ac_core::streamlog::rotate_attempt_log(
            runs(session),
            ticket_id,
            Path::new(&log_path),
            TicketEventKind::Exited,
        )?;
    }
    let stream = held.stream.clone().unwrap_or_else(|| {
        js::path_join(&[
            &session.runs_dir,
            &attempt_stream_name(ticket_id, Some(held.attempt), false),
        ])
    });
    let stream_path = js::exists(&stream).then_some(stream);
    let stream_offset = stream_path
        .as_deref()
        .and_then(|path| std::fs::metadata(path).ok())
        .map_or(0, |meta| meta.len());
    // The Outcome the checkpoint was read from is spent: cleared before the watch is armed, so it can
    // never be read as this attempt's. So is a stale exit-code file (tuiExited has said it predates the
    // attempt): from here its landing can only be this TUI exiting.
    let _ = std::fs::remove_file(&outcome_path);
    if let Some(exit_code) = held_exit_code_path(session, ticket_id, &held) {
        let _ = std::fs::remove_file(exit_code);
    }
    let assignment = pane_assignment(session, ticket_id, &held);
    let at = js::now_iso();
    let by_steward = steward.is_some();
    let mut answered = Map::new();
    answered.insert("kind".into(), Value::String("checkpoint".into()));
    answered.insert("action".into(), Value::String("keep-talking".into()));
    if let Some(talk) = &steward {
        answered.insert("by".into(), Value::String("steward".into()));
        answered.insert(
            "conversation".into(),
            Value::String(talk.conversation.clone()),
        );
        answered.insert("message".into(), Value::String(talk.message.clone()));
    }
    let mut event = event_now(held.attempt, TicketEventKind::Answered, answered);
    event.at = at.clone();
    append_event(runs(session), ticket_id, &event)?;
    note_answered(
        session,
        ticket_id,
        if by_steward {
            AnswerBy::Steward
        } else {
            AnswerBy::Operator
        },
    );
    let parent_env = session.parent_env.clone();
    let env: Map<String, Value> = ac_core::harness::engine_env_set(
        &ac_core::harness::spawn_env(&parent_env, &held.cwd),
        &parent_env,
    )
    .into_iter()
    .map(|(key, value)| (key, Value::String(value)))
    .collect();
    let mut spawned = Map::new();
    spawned.insert("argv".into(), Value::Array(Vec::new()));
    spawned.insert("cwd".into(), Value::String(held.cwd.clone()));
    spawned.insert(
        "branch".into(),
        held.branch.clone().map_or(Value::Null, Value::String),
    );
    spawned.insert(
        "commitSha".into(),
        git::commit_sha_at(&held.cwd).map_or(Value::Null, Value::String),
    );
    spawned.insert("env".into(), Value::Object(env));
    spawned.insert("harness".into(), Value::String(assignment.harness.clone()));
    spawned.insert("model".into(), Value::String(assignment.model.clone()));
    if let Some(effort) = assignment.effort.as_ref().filter(|e| !e.is_empty()) {
        spawned.insert("effort".into(), Value::String(effort.clone()));
    }
    spawned.insert("pane_id".into(), Value::String(held.pane_id.clone()));
    spawned.insert(
        "tab_id".into(),
        held.tab_id.clone().map_or(Value::Null, Value::String),
    );
    if let Some(terminal) = &held.terminal_id {
        spawned.insert("terminal_id".into(), Value::String(terminal.clone()));
    }
    spawned.insert("continued".into(), Value::Bool(true));
    spawned.insert("continues".into(), Value::from(held.attempt));
    spawned.insert("work_attempt".into(), Value::from(held.work_attempt));
    spawned.insert("numbered".into(), Value::Bool(held.numbered));
    spawned.insert(
        "stream".into(),
        stream_path.clone().map_or(Value::Null, Value::String),
    );
    spawned.insert("stream_offset".into(), Value::from(stream_offset));
    spawned.insert("wrapped".into(), Value::Bool(held.wrapped));
    let mut event = event_now(attempt, TicketEventKind::Spawned, spawned);
    event.at = at.clone();
    append_event(runs(session), ticket_id, &event)?;
    ac_core::pool::write_marker_status(&marker.file, TicketStatus::InProgress)?;
    if let Some(own) = session.marker_mut(ticket_id) {
        own.status = TicketStatus::InProgress;
    }
    session.held.shift_remove(ticket_id);
    session
        .assignments
        .insert(ticket_id.to_owned(), assignment.clone());
    let interrupts = session
        .state
        .interrupts
        .iter()
        .filter(|i| i.ticket_id != ticket_id)
        .cloned()
        .collect();
    session.apply(PoolUpdate {
        tickets: Some([(ticket_id.to_owned(), TicketStatus::InProgress)].into()),
        interrupts: Some(interrupts),
        log: Some(vec![format!(
            "ticket {ticket_id}: keep talking{}; attempt {attempt} continues attempt {} in pane {}",
            if by_steward { " (the Steward)" } else { "" },
            held.attempt,
            held.pane_id
        )]),
        ..PoolUpdate::default()
    });
    let work = HeldPane {
        attempt,
        stream: stream_path,
        spawned_at: at.clone(),
        ..held.clone()
    };
    report_attempt_agent(
        &session.herdr_socket,
        &held.pane_id,
        ticket_id,
        &marker.title,
        &assignment.harness,
        PaneAgentState::Working,
    );
    let teaching = build_continued_teaching(&ContinuedTeachingParts {
        id: ticket_id,
        issue_path: &js::path_text(&marker.file),
        outcome_path: &outcome_path,
        attempt,
        ledger_path: &js::path_text(&spawn_ledger_path(Path::new(&session.runs_dir))),
        by: if by_steward {
            KeptTalkingBy::Steward
        } else {
            KeptTalkingBy::Operator
        },
    });
    start_continued(
        session,
        marker,
        Started {
            attempt,
            work,
            log_path,
            outcome_path,
            stream_offset,
            teaching: Some(teaching),
            message: steward.map(|talk| steward_message_turn(&talk.message)),
        },
    );
    // Registered last: the registration emits, and the snapshot it sends must already show the ticket
    // running with no Interrupt.
    let mut entry = LiveAttemptEntry::new(attempt, Some(held.pane_id.clone()), held.tab_id.clone());
    entry.started_at = at;
    crate::live_attempts::register(session, ticket_id, entry);
    // The next boundary persist (or the persistence interrupt machinery) owns store failures; a claim
    // already made stands.
    let _ = crate::persist::persist(session);
    Ok(attempt)
}

/// What a Continued attempt's runtime starts from.
struct Started {
    attempt: u64,
    work: HeldPane,
    log_path: String,
    outcome_path: String,
    stream_offset: u64,
    /// `None` for a pane re-adopted at boot, taught before the restart, which is also not brought
    /// forward: nobody asked for it.
    teaching: Option<String>,
    message: Option<String>,
}

/// `startContinued`: start a Continued attempt's runtime and route its ending to the record.
fn start_continued(session: &mut Session, marker: &TicketMarker, started: Started) {
    let engine = session.engine();
    let ticket_id = marker.id.clone();
    let harness = session
        .assignments
        .get(&marker.id)
        .map_or_else(|| started.work.harness.clone(), |a| a.harness.clone());
    let on_message = started.message.is_some().then(|| {
        let engine = engine.clone();
        let ticket_id = ticket_id.clone();
        let (pane, attempt) = (started.work.pane_id.clone(), started.attempt);
        Box::new(move |failure: Option<String>| {
            let Some(failure) = failure else { return };
            let line = format!(
                "ticket {ticket_id}: the Steward's message could not be typed into pane {pane} \
                 ({failure}); continued attempt {attempt} carries on without it"
            );
            engine.cast(move |s| {
                s.log(line);
                let phase = s.current_phase();
                emit_snapshot(s, phase);
            });
        }) as crate::continued::OnMessage
    });
    let run = run_continued(
        ContinuedEnv {
            herdr_socket: session.herdr_socket.clone(),
            poll: session.enlist_poll_ms.map(std::time::Duration::from_millis),
            teaching_wait: session
                .teaching_wait_ms
                .map(std::time::Duration::from_millis),
        },
        ContinuedInput {
            pane_id: started.work.pane_id.clone(),
            harness,
            focus: started.teaching.is_some(),
            teaching: started.teaching,
            message: started.message,
            on_message,
            outcome_path: started.outcome_path.clone(),
            exit_code_path: held_exit_code_path(session, &marker.id, &started.work),
            stream_path: started.work.stream.clone(),
            stream_offset: started.stream_offset,
            log_path: started.log_path.clone(),
        },
    );
    session.continued.insert(
        marker.id.clone(),
        ContinuedAttempt {
            attempt: started.attempt,
            in_pool_checkout: in_pool_checkout(session, &started.work.cwd),
            work: started.work,
            release: run.release,
            log_path: started.log_path,
            outcome_path: started.outcome_path,
        },
    );
    let attempt = started.attempt;
    let ending = run.ending;
    tokio::spawn(async move {
        if let Ok(ending) = ending.await {
            let _ = engine
                .call(move |s| end_continued_attempt(s, &ticket_id, attempt, ending))
                .await;
        }
    });
}

/// `readoptContinued`: re-adopt a Continued attempt found live at boot (issue #139): its own runtime
/// again, with no teaching (the agent was taught before the restart), its log re-derived from where the
/// attempt began in the Stream file. `adoptTerminalAttempt` has already raised the adoption interrupt
/// and registered it live, as for any terminal-backed orphan.
pub fn readopt_continued(
    session: &mut Session,
    marker: &TicketMarker,
    attempt: u64,
    work: ContinuedWork,
) {
    let naming = work.pane.numbered.then_some(attempt);
    let log_path = js::path_join(&[
        &session.runs_dir,
        &attempt_log_name(&marker.id, naming, false),
    ]);
    let outcome_path = js::path_join(&[
        &session.runs_dir,
        &attempt_outcome_name(&marker.id, naming, false),
    ]);
    start_continued(
        session,
        marker,
        Started {
            attempt,
            work: work.pane,
            log_path,
            outcome_path,
            stream_offset: work.stream_offset,
            teaching: None,
            message: None,
        },
    );
}

/// Let a ticket's Continued attempt go (an abandoned adoption): its runtime stops watching and the
/// entry is dropped; nothing is recorded. Whether there was one; the caller restores the Assignment.
pub fn release_continued(session: &mut Session, ticket_id: &str) -> bool {
    match session.continued.remove(ticket_id) {
        Some(continued) => {
            continued.release.release();
            true
        }
        None => false,
    }
}

/// Shutdown: a Continued attempt's pane outlives the engine like any terminal-backed attempt's, and boot
/// re-adopts it; only this process's watch on it stops.
pub fn release_continued_attempts(session: &mut Session) {
    for continued in session.continued.values() {
        continued.release.release();
    }
}

// The attempt's own briefing when its teaching Turn could not be typed: the agent was never told a fresh
// Outcome is owed, so the attempt is over rather than left running on a promise nobody made.
fn untaught_brief(attempt: u64, pane_id: &str, reason: &str) -> String {
    format!(
        "Keep talking could not teach the agent in pane {pane_id}: {reason}. Continued attempt \
         {attempt} is over without an Outcome, and the pane was left as it was. Keep talking again \
         once the agent is waiting on you, or answer resume to start a fresh attempt."
    )
}

// Number.parseInt(text.trim(), 10): the leading integer, or none.
fn parse_int(text: &str) -> Option<i64> {
    let text = js::trim(text);
    let digits_from = usize::from(text.starts_with(['-', '+']));
    let end = text[digits_from..]
        .find(|c: char| !c.is_ascii_digit())
        .map_or(text.len(), |i| i + digits_from);
    if end == digits_from {
        return None;
    }
    text[..end].parse().ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Observed {
    Outcome,
    Exited,
    PaneGone,
    Untaught,
}

/// `endContinuedAttempt`: record a Continued attempt's ending (issue #139). A solo ticket's is exactly
/// an adopted attempt's (`record_adopted_exit`): done writes the status and chains the ordinary merge,
/// checkpoint raises a fresh Interrupt over the same pane (so it can be continued again), anything else
/// is a crash. A pane that went with no Outcome is a crash, as it is for any terminal attempt. A verify
/// ticket's attempt is graded as a lone attempt: a checkpoint pauses the ticket as the lone path does,
/// and done waits for the drive to grade it. An untaught attempt pauses at a checkpoint of the engine's
/// own. A released one records nothing: whoever released it owns the ticket.
fn end_continued_attempt(
    session: &mut Session,
    ticket_id: &str,
    attempt: u64,
    ending: ContinuedEnding,
) -> anyhow::Result<()> {
    if ending == ContinuedEnding::Released {
        return Ok(());
    }
    match session.continued.get(ticket_id) {
        Some(entry) if entry.attempt == attempt => {}
        _ => return Ok(()),
    }
    let Some(marker) = session.marker(ticket_id).cloned() else {
        return Ok(());
    };
    let Some(entry) = session.continued.remove(ticket_id) else {
        return Ok(());
    };
    let (work, log_path, outcome_path) = (entry.work, entry.log_path, entry.outcome_path);
    // A valid Outcome is the ending whichever observation came first: the agent may write it and the
    // operator close the tab (or quit the TUI) before the next sweep, and that is a finished attempt,
    // not a crash.
    let read = read_attempt_result(&outcome_path, validate_outcome);
    let observed = match &ending {
        ContinuedEnding::Untaught { .. } => Observed::Untaught,
        _ if read.is_ok() => Observed::Outcome,
        ContinuedEnding::Exited => Observed::Exited,
        _ => Observed::PaneGone,
    };
    // An enlisted ticket's Continued attempt ends the way its enlisted attempt did (ADR-0021): the same
    // two observations, recorded by the same hands, so done merges the found branch in place, a pane
    // gone first is a checkpoint that keeps the branch (never a crash, never a re-run), and the tab,
    // directory and branch are left exactly as they are. Its Assignment stays as found. Only an
    // untaught one is this function's own below. It has no wrapper, so it never sees an exit-code
    // ending.
    let enlisted = marker.enlisted_from.is_some() && session.enlisted_work.contains_key(ticket_id);
    if enlisted && observed != Observed::Untaught {
        crate::pane_survey::refresh_in_background(session);
        return end_enlisted_attempt(
            session,
            ticket_id,
            if observed == Observed::Outcome {
                EnlistedEnding::Outcome
            } else {
                EnlistedEnding::PaneGone
            },
            Some(attempt),
        );
    }
    // A re-adopted Continued attempt's adoption is over with its ending: its interrupt goes with the
    // record below, as an adopted attempt's does.
    session.adopted.remove(ticket_id);
    crate::live_attempts::clear(session, ticket_id, attempt);
    let harness = session
        .assignments
        .get(ticket_id)
        .map(|a| a.harness.clone())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| work.harness.clone());
    release_attempt_agent(&session.herdr_socket, &work.pane_id, &harness);
    if !enlisted {
        restore_assignment(session, &marker);
    }
    crate::pane_survey::refresh_in_background(session);
    let clear_interrupts = |session: &mut Session| {
        let interrupts = session
            .state
            .interrupts
            .iter()
            .filter(|i| i.ticket_id != ticket_id)
            .cloned()
            .collect();
        session.apply(PoolUpdate {
            interrupts: Some(interrupts),
            ..PoolUpdate::default()
        });
    };

    if let ContinuedEnding::Untaught { reason } = &ending {
        let mut exited = Map::new();
        exited.insert("code".into(), Value::from(SPAWN_INTERACTIVE_PROMPT_FAILED));
        exited.insert("status".into(), Value::String("checkpoint".into()));
        exited.insert("logTail".into(), Value::from(read_log_tail(&log_path)));
        exited.insert(
            "outcomeExists".into(),
            Value::Bool(js::exists(&outcome_path)),
        );
        append_event(
            runs(session),
            ticket_id,
            &event_now(attempt, TicketEventKind::Exited, exited),
        )?;
        clear_interrupts(session);
        checkpoint_ticket_by_engine(
            session,
            &marker,
            attempt,
            Some(&untaught_brief(attempt, &work.pane_id, reason)),
            format!(
                "ticket {ticket_id}: continued attempt {attempt} could not be taught ({reason}); \
                 checkpoint raised"
            ),
            true,
            None,
        )?;
        finish_adopted_finalize(session);
        return Ok(());
    }

    let exit_code = || -> i64 {
        held_exit_code_path(session, ticket_id, &work)
            .and_then(|path| js::read_text(&path).ok())
            .and_then(|text| parse_int(text.as_str()))
            .unwrap_or(EXIT_CODE_UNREADABLE)
    };
    let decision = match observed {
        Observed::PaneGone => AttemptEndingDecision {
            ending: AttemptEnding::PaneGone,
            code: EXIT_CODE_PANE_GONE,
            result: read.clone(),
            crash_reason: Some(format!(
                "pane {} went before continued attempt {attempt} wrote an Outcome",
                work.pane_id
            )),
        },
        Observed::Exited => AttemptEndingDecision {
            ending: AttemptEnding::ExitCode,
            code: exit_code(),
            result: read.clone(),
            crash_reason: Some(format!(
                "the TUI in pane {} exited before continued attempt {attempt} wrote an Outcome",
                work.pane_id
            )),
        },
        _ => match &read {
            Ok(_) => AttemptEndingDecision {
                ending: AttemptEnding::Outcome,
                code: 0,
                result: read.clone(),
                crash_reason: None,
            },
            Err(reason) => AttemptEndingDecision {
                ending: AttemptEnding::Outcome,
                code: EXIT_CODE_UNREADABLE,
                result: read.clone(),
                crash_reason: Some(reason.clone()),
            },
        },
    };
    if let Ok(valid) = &read
        && decision.crash_reason.is_none()
    {
        for rejection in &valid.spawn_rejections {
            let mut payload = Map::new();
            payload.insert("reason".into(), Value::String(rejection.reason.clone()));
            if let Some(index) = rejection.index {
                payload.insert("index".into(), Value::from(index));
            }
            append_event(
                runs(session),
                ticket_id,
                &event_now(attempt, TicketEventKind::SpawnRejected, payload),
            )?;
        }
    }

    if !work.numbered || decision.crash_reason.is_some() || read.is_err() {
        if !work.numbered
            && decision.crash_reason.is_none()
            && let Ok(valid) = &read
            && valid.outcome.status == OutcomeStatus::Done
            && let Some(proposals) = valid.outcome.spawn.as_ref().filter(|p| !p.is_empty())
        {
            take_spawn_proposals(session, ticket_id, proposals.clone(), SpawnKind::Ticket)?;
        }
        return record_adopted_exit(
            session,
            &marker,
            attempt,
            &decision,
            &log_path,
            &outcome_path,
            "continued attempt",
        );
    }

    // A verify ticket's Continued attempt, ended with a valid Outcome: the exit is recorded as a verify
    // candidate's is, and the lone-attempt rules decide the rest.
    let Ok(valid) = read else {
        return Ok(());
    };
    let outcome = valid.outcome;
    let mut exited = Map::new();
    exited.insert("code".into(), Value::from(0));
    exited.insert("status".into(), Value::String(outcome.status.to_string()));
    exited.insert("logTail".into(), Value::from(read_log_tail(&log_path)));
    exited.insert("outcomeExists".into(), Value::Bool(true));
    append_event(
        runs(session),
        ticket_id,
        &event_now(attempt, TicketEventKind::Exited, exited),
    )?;
    clear_interrupts(session);
    if outcome.status == OutcomeStatus::Checkpoint {
        checkpoint_ticket_by_engine(
            session,
            &marker,
            attempt,
            outcome.brief.as_deref(),
            format!("ticket {ticket_id}: continued attempt {attempt} checkpointed"),
            true,
            None,
        )?;
        session.apply(PoolUpdate {
            outcomes: Some([(ticket_id.to_owned(), outcome.clone())].into()),
            ..PoolUpdate::default()
        });
        if let Some(proposals) = outcome.spawn.as_ref().filter(|p| !p.is_empty()) {
            take_spawn_proposals(session, ticket_id, proposals.clone(), SpawnKind::Ticket)?;
        }
        finish_adopted_finalize(session);
        return Ok(());
    }
    session.continued_grades.push(ContinuedGrade {
        ticket_id: ticket_id.to_owned(),
        attempt,
        work,
    });
    session.log(format!(
        "ticket {ticket_id}: continued attempt {attempt} done; graded as a lone attempt at the next \
         boundary"
    ));
    finish_adopted_finalize(session);
    Ok(())
}

/// `gradeContinuedAttempts`: grade every verify ticket's Continued attempt that ended done (issue
/// #139), each as a lone attempt: one round of one attempt, then the lone rules (a flag checkpoints the
/// ticket over the same pane, a pass merges the branch the chain worked on). Run by the drive loop
/// between super-steps, the one place grading already runs: graders are spawned attempts and a pass
/// merges, neither of which may run beside a super-step (ADR-0004).
pub async fn grade_continued_attempts(engine: &Engine) -> anyhow::Result<()> {
    if engine.call(|s| s.continued_grades.is_empty()).await? {
        return Ok(());
    }
    loop {
        let next = engine
            .call(|s| (!s.continued_grades.is_empty()).then(|| s.continued_grades.remove(0)))
            .await?;
        let Some(owed) = next else { break };
        let id = owed.ticket_id.clone();
        let marker = engine
            .call(move |s| {
                s.marker(&id)
                    .filter(|m| m.status == TicketStatus::InProgress)
                    .cloned()
            })
            .await?;
        let Some(marker) = marker else { continue };
        // Before the grade is recorded (as in the drive's grading): a shutdown while it waits leaves
        // the grade owed, and the next boot grades it.
        if !pool_checkout_free(engine).await? {
            engine
                .call(move |s| s.continued_grades.insert(0, owed))
                .await?;
            return Ok(());
        }
        let what = format!(
            "the lone grade of {}'s continued attempt is deciding its merge",
            marker.id
        );
        let hold = engine.call(move |s| hold_pool_checkout(s, what)).await?;
        let graded = grade_continued_attempt(engine, &marker, owed.attempt, owed.work).await;
        engine.call(move |s| release_pool_checkout(s, hold)).await?;
        graded?;
    }
    persist_with_retry(engine).await?;
    engine.call(|s| emit_snapshot(s, RunPhase::Running)).await?;
    Ok(())
}

/// One owed lone grade and its decision ([`grade_continued_attempts`]).
async fn grade_continued_attempt(
    engine: &Engine,
    marker: &TicketMarker,
    attempt: u64,
    work: HeldPane,
) -> anyhow::Result<()> {
    let grades = grade_round(engine, marker, &[attempt]).await?;
    let marker = marker.clone();
    engine
        .call(move |s| {
            let log_path = js::path_join(&[
                &s.runs_dir,
                &attempt_log_name(&marker.id, Some(attempt), false),
            ]);
            let outcome_path = js::path_join(&[
                &s.runs_dir,
                &attempt_outcome_name(&marker.id, Some(attempt), false),
            ]);
            let result = TicketResult {
                marker: marker.clone(),
                status: TicketStatus::Done,
                log_path,
                exit_code: 0,
                plan: TicketPlan {
                    cwd: work.cwd.clone(),
                    worktree: work.branch.clone().map(|branch| git::WorktreeInfo {
                        path: work.cwd.clone(),
                        branch,
                    }),
                    attempt,
                    verify: true,
                },
                update: PoolUpdate::default(),
                joined_at_exit: true,
                spawn_proposals: None,
                log_tail: Vec::new(),
                outcome_exists: js::exists(&outcome_path),
                outcome_path,
                crash_reason: None,
            };
            resolve_lone_attempt(s, &marker, &result, grades.get(&attempt))
        })
        .await?
}

/// `owedContinuedGrade`: the lone grade a verify ticket's Continued attempt is still owed at boot (issue
/// #139): its latest spawn is a Continued attempt on attempt-numbered files, that attempt exited done,
/// and no grade was recorded for it since.
pub fn owed_continued_grade(session: &Session, marker: &TicketMarker) -> Option<ContinuedGrade> {
    let events = read_events(runs(session), &marker.id);
    let spawned = events
        .iter()
        .rfind(|event| event.kind == TicketEventKind::Spawned)?;
    if spawned.payload.get("continued") != Some(&Value::Bool(true))
        || spawned.payload.get("numbered") != Some(&Value::Bool(true))
    {
        return None;
    }
    let attempt = spawned.attempt;
    let exited = events.iter().position(|event| {
        event.kind == TicketEventKind::Exited
            && event.attempt == attempt
            && event.payload.get("status").and_then(Value::as_str) == Some("done")
    })?;
    if events
        .iter()
        .skip(exited + 1)
        .any(|event| event.attempt == attempt && event.kind == TicketEventKind::Graded)
    {
        return None;
    }
    let cwd = session.cwd.clone();
    let id = marker.id.clone();
    let work = held_pane_of(&events, attempt, move |n| {
        git::worktree_path_for(&cwd, &id, u32::try_from(n).ok())
    })?;
    Some(ContinuedGrade {
        ticket_id: marker.id.clone(),
        attempt,
        work,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exit_code_file_reads_as_javascripts_parse_int() {
        assert_eq!(parse_int("0\n"), Some(0));
        assert_eq!(parse_int(" 130 "), Some(130));
        assert_eq!(parse_int("-4x"), Some(-4));
        assert_eq!(parse_int("+7"), Some(7));
        assert_eq!(parse_int(""), None);
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int("-"), None);
    }

    #[test]
    fn an_untaught_attempt_names_the_pane_and_why() {
        assert_eq!(
            untaught_brief(3, "p1", "the Turn could not be delivered"),
            "Keep talking could not teach the agent in pane p1: the Turn could not be delivered. \
             Continued attempt 3 is over without an Outcome, and the pane was left as it was. Keep \
             talking again once the agent is waiting on you, or answer resume to start a fresh \
             attempt."
        );
    }

    use ac_protocol::Interrupt;
    use tokio::sync::watch;

    fn session() -> Session {
        let (publisher, _) = watch::channel(None);
        crate::testkit::bare_session(publisher)
    }

    fn marker() -> TicketMarker {
        TicketMarker {
            id: "01".into(),
            file: "/p/issues/01.md".into(),
            blocked_by: Vec::new(),
            status: TicketStatus::Checkpoint,
            title: "t".into(),
            spec: String::new(),
            spawned_by: None,
            enlisted_from: None,
            spawn_assign: None,
        }
    }

    fn checkpointed(session: &mut Session, held: bool) {
        session.markers.push(marker());
        session
            .state
            .tickets
            .insert("01".into(), TicketStatus::Checkpoint);
        session.state.interrupts.push(Interrupt {
            ticket_id: "01".into(),
            kind: InterruptKind::Checkpoint,
            body: "b".into(),
            candidates: None,
            steward_note: None,
        });
        if held {
            session.held.insert(
                "01".into(),
                HeldPane {
                    attempt: 1,
                    pane_id: "p1".into(),
                    tab_id: Some("t1".into()),
                    terminal_id: None,
                    cwd: "/w".into(),
                    branch: None,
                    harness: "claude".into(),
                    model: "m".into(),
                    effort: None,
                    work_attempt: 1,
                    numbered: false,
                    stream: None,
                    spawned_at: "2026-10-04T00:00:00.000Z".into(),
                    wrapped: true,
                },
            );
        }
    }

    // NOT-PORTED.md, interrupts "Pinned short" (gap entries engine.ts:4682, :4685): the claim's own
    // refusals. Over a Held pane the fresh listing no longer has it answers that the pane is gone; over
    // one whose TUI's exit-code file landed after the attempt began, that the TUI has exited; each lets
    // the hold go. From outside, the survey's listing handler lets such a hold go before the claim
    // runs, so a request is told there is no terminal left, as on Bun (the conformance cases pin that).
    #[test]
    fn the_claim_says_why_a_held_pane_cannot_be_continued_and_lets_the_hold_go() {
        use crate::pane_survey::{ListedPane, PaneListing, PaneSurvey};
        let listing = |panes: Vec<&str>| PaneListing {
            tabs: ["t1".to_string()].into_iter().collect(),
            panes: panes
                .into_iter()
                .map(|id| {
                    (
                        id.to_owned(),
                        ListedPane {
                            pane_id: id.to_owned(),
                            tab_id: Some("t1".into()),
                            workspace_id: None,
                            cwd: Some("/w".into()),
                            terminal_id: None,
                        },
                    )
                })
                .collect(),
        };
        let words = |s: &mut Session| {
            claim(s, "01", true, None)
                .map(|_| ())
                .unwrap_err()
                .to_string()
        };

        let mut s = session();
        checkpointed(&mut s, true);
        s.pane_survey = Some(PaneSurvey::listed(listing(vec!["p2"])));
        assert_eq!(
            words(&mut s),
            "keep talking: ticket 01 lost its terminal: pane p1 is gone"
        );
        assert!(!s.held.contains_key("01"), "the hold is let go");

        let runs = tempfile::tempdir().unwrap();
        let mut s = session();
        checkpointed(&mut s, true);
        s.runs_dir = runs.path().to_string_lossy().into_owned();
        s.pane_survey = Some(PaneSurvey::listed(listing(vec!["p1"])));
        let exit_code = held_exit_code_path(&s, "01", &s.held["01"]).unwrap();
        std::fs::write(exit_code, "0\n").unwrap();
        assert_eq!(
            words(&mut s),
            "keep talking: ticket 01 lost its agent: the TUI in pane p1 has exited"
        );
        assert!(!s.held.contains_key("01"), "the hold is let go");
    }

    #[test]
    fn keep_talking_refuses_what_is_not_waiting_at_a_checkpoint_with_a_pane_held() {
        let mut s = session();
        let words = |s: &Session| check(s, "01").unwrap_err().to_string();
        assert_eq!(
            words(&s),
            "keep talking: ticket 01 is not waiting at a checkpoint"
        );
        checkpointed(&mut s, false);
        assert_eq!(
            words(&s),
            "keep talking: ticket 01 has no terminal left to continue in"
        );
        checkpointed(&mut s, true);
        s.state.interrupts.truncate(1);
        assert_eq!(check(&s, "01").unwrap().1.pane_id, "p1");
        // The state, not the marker object, says whether the ticket waits.
        s.state
            .tickets
            .insert("01".into(), TicketStatus::InProgress);
        assert_eq!(
            words(&s),
            "keep talking: ticket 01 is not waiting at a checkpoint"
        );
        s.state
            .tickets
            .insert("01".into(), TicketStatus::Checkpoint);
        s.state.interrupts[0].kind = InterruptKind::Review;
        assert_eq!(
            words(&s),
            "keep talking: ticket 01 is not waiting at a checkpoint"
        );
    }

    #[test]
    fn a_verify_ticket_owes_the_lone_grade_of_a_continued_attempt_that_ended_done() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = session();
        s.runs_dir = dir.path().to_string_lossy().into_owned();
        s.cwd = "/repo".into();
        let marker = marker();
        let write = |attempt: u64, kind: TicketEventKind, payload: Value| {
            let Value::Object(payload) = payload else {
                unreachable!()
            };
            append_event(dir.path(), "01", &event_now(attempt, kind, payload)).unwrap();
        };
        assert!(owed_continued_grade(&s, &marker).is_none());
        write(
            2,
            TicketEventKind::Spawned,
            serde_json::json!({"pane_id": "p1", "cwd": "/w", "continued": true, "numbered": true,
                "continues": 1, "work_attempt": 1}),
        );
        // Still running: no exit yet.
        assert!(owed_continued_grade(&s, &marker).is_none());
        write(
            2,
            TicketEventKind::Exited,
            serde_json::json!({"code": 0, "status": "done"}),
        );
        let owed = owed_continued_grade(&s, &marker).unwrap();
        assert_eq!((owed.ticket_id.as_str(), owed.attempt), ("01", 2));
        assert_eq!(owed.work.pane_id, "p1");
        write(2, TicketEventKind::Graded, serde_json::json!({"score": 8}));
        assert!(owed_continued_grade(&s, &marker).is_none());
    }
}
