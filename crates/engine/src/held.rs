//! Held panes (issue #139, CONTEXT.md "Held pane"; engine.ts 4196-4480, held-panes.ts): the still-live
//! herdr pane of a Terminal-backed attempt that ended in a checkpoint Interrupt. The attempt is over,
//! so it is no Live attempt, but its TUI is still there with the whole conversation in it (ADR-0016),
//! and while the Interrupt waits the Console keeps the pane reachable: peek, focus and attach serve it,
//! and Keep talking continues it as a Continued attempt.
//!
//! The engine holds a pane where the checkpoint is raised and reads it back from the attempt's
//! `spawned` event after a restart, so [`held_pane_of`] is the one reading of that event. Whether the
//! pane is still alive is not the event's to say; the pane survey ([`crate::pane_survey`]) answers that.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use ac_core::assignment::{Assignment, DEFAULT_DRIVERS, resolve_unseen_assignments};
use ac_core::events::{attempt_exit_code_name, read_events};
use ac_core::js;
use ac_core::pool::TicketMarker;
use ac_io::git::worktree_path_for;
use ac_protocol::{HeldPaneRecord, InterruptKind, TicketEvent, TicketEventKind, TicketStatus};

use crate::pane_survey::{PaneListing, RecordedPane, listed_as_recorded};
use crate::session::{Session, js_key_order};
use crate::terminals::{OpenedTab, Untouchable};

/// A Held pane with everything a Continued attempt needs to carry on in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldPane {
    /// The checkpointed Attempt whose pane this is.
    pub attempt: u64,
    pub pane_id: String,
    pub tab_id: Option<String>,
    /// herdr's never-reused terminal id, when the spawn recorded one.
    pub terminal_id: Option<String>,
    /// Where the attempt ran: its worktree, or the pool checkout.
    pub cwd: String,
    /// The branch the attempt worked on; `None` in the pool checkout.
    pub branch: Option<String>,
    /// The Assignment the pane is running: the checkpointed Attempt's own, as its `spawned` event
    /// recorded it, whatever a Reassign has written since. Empty when the event predates the record.
    pub harness: String,
    pub model: String,
    /// The effort it launched with, when it named one (CONTEXT.md: Effort).
    pub effort: Option<String>,
    /// The Attempt whose worktree and branch the work lives in: the attempt itself, or for a Continued
    /// attempt the one its chain began at.
    pub work_attempt: u64,
    /// Whether the attempt's files are attempt-numbered: a verify candidate's are, a solo attempt's are
    /// the ticket's well-known ones, and a Continued attempt keeps the naming of the attempt it
    /// continues.
    pub numbered: bool,
    /// The Stream file the pane's `script` writes, as a Continued attempt's `spawned` event recorded
    /// it; `None` for the attempt that opened the pane, whose own Stream file it is.
    pub stream: Option<String>,
    /// When the attempt's `spawned` event was recorded (ISO).
    pub spawned_at: String,
    /// Whether the pane's TUI runs under the engine's wrapper, which writes an exit-code file when the
    /// TUI exits: true for an attempt the engine launched, false for an enlisted pane.
    pub wrapped: bool,
}

/// A Continued attempt's own facts, read back from its `spawned` event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContinuedWork {
    pub pane: HeldPane,
    pub stream_offset: u64,
}

fn text(payload: &Map<String, Value>, key: &str) -> Option<String> {
    payload.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn number(payload: &Map<String, Value>, key: &str) -> Option<u64> {
    let value = payload.get(key)?;
    if !value.is_number() {
        return None;
    }
    value
        .as_u64()
        .or_else(|| value.as_f64().map(|f| if f > 0.0 { f as u64 } else { 0 }))
}

/// `heldPaneOf`: the Held pane candidate of one attempt, read from the ticket's events: the attempt's
/// `spawned` event, when it names a pane. `None` for a headless attempt, a headless fallback, an
/// attempt with no spawn on record, and a resolver's attempt (a resolver never checkpoints its
/// ticket). `numbered_cwd` is the attempt worktree a verify candidate of this number would run in: an
/// original spawn records no naming, and a candidate is exactly the attempt that ran there.
pub fn held_pane_of(
    events: &[Arc<TicketEvent>],
    attempt: u64,
    numbered_cwd: impl Fn(u64) -> String,
) -> Option<HeldPane> {
    if events
        .iter()
        .any(|event| event.kind == TicketEventKind::Resolver && event.attempt == attempt)
    {
        return None;
    }
    let spawned = events
        .iter()
        .rfind(|event| event.kind == TicketEventKind::Spawned && event.attempt == attempt)?;
    let payload = &spawned.payload;
    let pane_id = text(payload, "pane_id")?;
    let cwd = text(payload, "cwd")?;
    let work_attempt = number(payload, "work_attempt").unwrap_or(attempt);
    let numbered = match payload.get("numbered") {
        Some(Value::Bool(numbered)) => *numbered,
        _ => cwd == numbered_cwd(attempt),
    };
    let wrapped = match payload.get("wrapped") {
        Some(Value::Bool(wrapped)) => *wrapped,
        _ => payload
            .get("argv")
            .and_then(Value::as_array)
            .is_some_and(|argv| !argv.is_empty()),
    };
    Some(HeldPane {
        attempt,
        pane_id,
        tab_id: text(payload, "tab_id"),
        terminal_id: text(payload, "terminal_id"),
        cwd,
        branch: text(payload, "branch"),
        harness: text(payload, "harness").unwrap_or_default(),
        model: text(payload, "model").unwrap_or_default(),
        effort: text(payload, "effort"),
        work_attempt,
        numbered,
        stream: text(payload, "stream"),
        spawned_at: spawned.at.clone(),
        wrapped,
    })
}

/// `lastCheckpointAttempt`: the attempt a ticket's latest checkpoint was raised for, read back from its
/// `checkpoint` events after a restart; `None` when it never checkpointed.
pub fn last_checkpoint_attempt(events: &[Arc<TicketEvent>]) -> Option<u64> {
    events
        .iter()
        .rfind(|event| event.kind == TicketEventKind::Checkpoint)
        .map(|event| event.attempt)
}

fn numbered_cwd_of(session: &Session, ticket_id: &str) -> impl Fn(u64) -> String + use<> {
    let cwd = session.cwd.clone();
    let id = ticket_id.to_owned();
    move |n| worktree_path_for(&cwd, &id, u32::try_from(n).ok())
}

/// `holdCheckpointPane`: hold the pane of a checkpointed attempt, called wherever a checkpoint
/// Interrupt is raised, so a checkpoint over a pane keeps it reachable while the Interrupt waits.
/// Whether this pane is the one to hold is [`own_held_pane`]'s rule; whether it is still alive, and
/// still the pane recorded, is the survey's to say, so it is asked now rather than at its next
/// cadence. An adoption's checkpoint is an Attempt still running, which is no hold.
pub fn hold_checkpoint_pane(session: &mut Session, marker: &TicketMarker, attempt: u64) {
    if session.adopted.contains_key(&marker.id) {
        return;
    }
    let events = read_events(Path::new(&session.runs_dir), &marker.id);
    match own_held_pane(session, marker, &events, attempt) {
        None => {
            session.held.shift_remove(&marker.id);
        }
        Some(held) => {
            session.held.insert(marker.id.clone(), held);
            crate::pane_survey::refresh_in_background(session);
        }
    }
}

/// `ownHeldPane`: the rule for which pane a checkpoint holds (ADR-0027): the pane of the Attempt the
/// checkpoint is about, and only while it is still that Attempt's agent to talk to. The checkpoint
/// must follow the Attempt's own ending (its `exited`), and no engine-raised checkpoint about the
/// ticket's circumstances (`branch-held`) may have come after that ending. The agent must still be
/// there: a wrapped TUI that exited leaves a bare shell in its pane, which is nothing to talk to. An
/// enlisted pane is held only while the Ticket still works in it.
pub fn own_held_pane(
    session: &Session,
    marker: &TicketMarker,
    events: &[Arc<TicketEvent>],
    attempt: u64,
) -> Option<HeldPane> {
    if marker.enlisted_from.is_some() && !session.enlisted_work.contains_key(&marker.id) {
        return None;
    }
    let ended = events
        .iter()
        .rposition(|event| event.kind == TicketEventKind::Exited && event.attempt == attempt)?;
    if events
        .iter()
        .skip(ended + 1)
        .any(|event| event.kind == TicketEventKind::BranchHeld)
    {
        return None;
    }
    let held = held_pane_of(events, attempt, numbered_cwd_of(session, &marker.id))?;
    if tui_exited(session, &marker.id, &held) {
        return None;
    }
    Some(held)
}

/// `heldExitCodePath`: the exit-code file the Held pane's wrapper writes when its TUI exits: the file
/// of the attempt that launched the wrapper (the chain's first), named as that attempt's files are.
/// `None` for an enlisted pane, which has none.
pub fn held_exit_code_path(session: &Session, ticket_id: &str, held: &HeldPane) -> Option<String> {
    if !held.wrapped {
        return None;
    }
    Some(js::path_join(&[
        &session.runs_dir,
        &attempt_exit_code_name(
            ticket_id,
            if held.numbered {
                Some(held.work_attempt)
            } else {
                None
            },
            false,
        ),
    ]))
}

/// `tuiExited`: whether the Held pane's TUI has exited, leaving its shell: its wrapper's exit-code
/// file is there and was written after the attempt began. One older than that is stale, a solo
/// ticket's well-known file from before.
pub fn tui_exited(session: &Session, ticket_id: &str, held: &HeldPane) -> bool {
    let Some(path) = held_exit_code_path(session, ticket_id, held) else {
        return false;
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return false;
    };
    let Ok(spawned) = chrono::DateTime::parse_from_rfc3339(&held.spawned_at) else {
        return false;
    };
    js::mtime_ms(&meta) >= spawned.timestamp_millis() as f64
}

/// `heldPaneListed`: whether the survey's listing still has the Held pane as it was recorded: the same
/// tab, the Pool workspace (an enlisted pane lives in the operator's), and the recorded directory.
pub fn held_pane_listed(session: &Session, held: &HeldPane) -> bool {
    let Some(listing) = session.pane_survey.as_ref().and_then(|s| s.latest()) else {
        return false;
    };
    let enlisted = !held.wrapped;
    listed_as_recorded(
        &listing,
        &RecordedPane {
            pane_id: held.pane_id.clone(),
            tab_id: held.tab_id.clone(),
            cwd: Some(held.cwd.clone()),
            terminal_id: held.terminal_id.clone(),
        },
        if enlisted {
            None
        } else {
            session.pool_workspace.id.as_deref()
        },
    )
}

/// `seedHeldPanes`: the Held panes a restart finds (issue #139): every ticket still waiting at a
/// checkpoint Interrupt the checkpoint store brought back, held again from the attempt its last
/// `checkpoint` event names. A checkpoint rehydrate re-raised itself was held there already; holding
/// it twice is the same.
pub fn seed_held_panes(session: &mut Session) {
    let waiting: Vec<(TicketMarker, u64)> = session
        .markers
        .iter()
        .filter(|marker| marker.status == TicketStatus::Checkpoint)
        .filter(|marker| {
            session
                .state
                .interrupts
                .iter()
                .any(|i| i.ticket_id == marker.id && i.kind == InterruptKind::Checkpoint)
        })
        .filter_map(|marker| {
            last_checkpoint_attempt(&read_events(Path::new(&session.runs_dir), &marker.id))
                .map(|attempt| (marker.clone(), attempt))
        })
        .collect();
    for (marker, attempt) in waiting {
        hold_checkpoint_pane(session, &marker, attempt);
    }
}

/// `heldPaneRecords`: the snapshot's Held panes: a hold whose ticket still waits at its checkpoint
/// Interrupt with nothing live, over a pane the survey's last listing still has. Before the first
/// listing nothing is shown: a pane from before a restart is not offered until herdr has said it is
/// there.
pub fn held_pane_records(session: &Session) -> IndexMap<String, HeldPaneRecord> {
    let mut out = IndexMap::new();
    if session
        .pane_survey
        .as_ref()
        .and_then(|survey| survey.latest())
        .is_none()
    {
        return out;
    }
    for (id, held) in &session.held {
        if session.state.tickets.get(id) != Some(&TicketStatus::Checkpoint) {
            continue;
        }
        if session.live_attempts.is_live(id) {
            continue;
        }
        let waiting = session
            .state
            .interrupts
            .iter()
            .any(|i| &i.ticket_id == id && i.kind == InterruptKind::Checkpoint);
        if !waiting || !held_pane_listed(session, held) || tui_exited(session, id, held) {
            continue;
        }
        out.insert(
            id.clone(),
            HeldPaneRecord {
                attempt: held.attempt,
                pane_id: held.pane_id.clone(),
            },
        );
    }
    // The snapshot carries an object: JavaScript enumerates integer-like keys first.
    js_key_order(&out)
        .into_iter()
        .map(|(id, record)| (id.clone(), record.clone()))
        .collect()
}

/// `registeredPanesOf`: the pane ids a live attempt or a live Conversation already holds, a Held pane
/// included (it is the pool's while its checkpoint waits), and every pane a Conversation record names
/// while it is live.
pub fn registered_panes_of(session: &Session) -> HashSet<String> {
    let mut panes = HashSet::new();
    let conversations = &session.conversations;
    for record in session
        .live_attempts
        .records(|id| conversations.is_live(id))
        .values()
    {
        if let Some(pane) = record.pane_id.as_ref().filter(|pane| !pane.is_empty()) {
            panes.insert(pane.clone());
        }
    }
    for view in conversations.views() {
        if let Some(pane) = view.pane_id.filter(|pane| !pane.is_empty()) {
            panes.insert(pane);
        }
    }
    for held in session.held.values() {
        panes.insert(held.pane_id.clone());
    }
    panes.extend(conversations.live_terminals().0);
    panes
}

/// `untouchable`: every pane and tab no close may touch (issue #139): a Live attempt's (a Continued
/// attempt's included), a Held pane's, a live Conversation's, every pane the engine counts as
/// registered, every pane and tab a Conversation record names while it is live, and every pane and tab
/// any enlisted Ticket or Conversation names on its events (ADR-0021). The last is read with the
/// survey's listing, because an operator may enlist the still-live agent in a finished tab of the
/// pool's own, and from then on that tab is theirs whoever opened it.
pub fn untouchable(session: &Session) -> Untouchable {
    let mut panes: HashSet<String> = session.live_attempts.panes().into_iter().collect();
    for held in session.held.values() {
        panes.insert(held.pane_id.clone());
    }
    for view in session.conversations.views() {
        if let Some(pane) = view.pane_id.filter(|pane| !pane.is_empty())
            && session.conversations.is_live(&view.id)
        {
            panes.insert(pane);
        }
    }
    panes.extend(registered_panes_of(session));
    panes.extend(session.enlisted_terminals.panes.iter().cloned());
    let mut tabs: HashSet<String> = session.enlisted_terminals.tabs.iter().cloned().collect();
    tabs.extend(session.conversations.live_terminals().1);
    Untouchable { panes, tabs }
}

/// `finishedNow`: the Finished terminals as the last listing has them.
pub fn finished_now(session: &Session, listing: &PaneListing) -> Vec<OpenedTab> {
    crate::terminals::finished_terminals(
        &session.opened_tabs,
        listing,
        &untouchable(session),
        session.pool_workspace.id.as_deref(),
    )
}

/// The Finished terminals count from the survey's last listing: 0 before the first.
pub fn finished_terminals_now(session: &Session) -> u64 {
    match session.pane_survey.as_ref().and_then(|s| s.latest()) {
        Some(listing) => finished_now(session, &listing).len() as u64,
        None => 0,
    }
}

/// `surveyListed`: a survey listing landed: a Held pane whose pane has gone, is listed as something
/// other than what was recorded, or whose TUI exited is let go (the Interrupt stays; only Keep talking
/// goes with it), and a snapshot goes out when the Held panes or the Finished terminals count moved
/// since the last one. Compared rather than emitted every time, so a quiet pool's cadence sends
/// nothing; derived rather than compared as listings, because a tab becomes finished when its attempt
/// ends, with no change in herdr at all.
pub fn survey_listed(session: &mut Session) {
    let Some(listing) = session.pane_survey.as_ref().and_then(|s| s.latest()) else {
        return;
    };
    // The daemon answers again: a Conversation a boot could not settle is tried again now (issue #140).
    let engine = session.engine();
    tokio::spawn(async move {
        if let Err(error) = crate::conversations::readopt_pending(&engine).await {
            let _ = engine
                .call(move |s| {
                    s.log(format!(
                        "conversations: re-adoption failed ({error}); the next listing tries again"
                    ))
                })
                .await;
        }
    });
    let gone: Vec<String> = session
        .held
        .iter()
        .filter(|(id, held)| !held_pane_listed(session, held) || tui_exited(session, id, held))
        .map(|(id, _)| id.clone())
        .collect();
    for id in gone {
        session.held.shift_remove(&id);
    }
    let held = held_pane_records(session);
    let finished = finished_now(session, &listing).len() as u64;
    if let Some(last) = session.snapshots.back()
        && last.finished_terminals == finished
        && serde_json::to_string(&last.held_panes).ok() == serde_json::to_string(&held).ok()
    {
        return;
    }
    let phase = session.current_phase();
    crate::snapshot::emit_snapshot(session, phase);
}

/// `workAttemptOf`: the attempt whose worktree and branch an attempt's work lives in: itself, or for
/// a Continued attempt the one its chain began at, as its `spawned` event recorded (issue #139).
pub fn work_attempt_of(session: &Session, ticket_id: &str, attempt: u64) -> u64 {
    read_events(Path::new(&session.runs_dir), ticket_id)
        .iter()
        .rfind(|event| event.kind == TicketEventKind::Spawned && event.attempt == attempt)
        .and_then(|spawned| number(&spawned.payload, "work_attempt"))
        .unwrap_or(attempt)
}

/// `continuedWork`: a Continued attempt's own facts, read back from its `spawned` event: `None` when
/// the attempt is not one.
pub fn continued_work(session: &Session, ticket_id: &str, attempt: u64) -> Option<ContinuedWork> {
    let events = read_events(Path::new(&session.runs_dir), ticket_id);
    let spawned = events
        .iter()
        .rfind(|event| event.kind == TicketEventKind::Spawned && event.attempt == attempt)?;
    if spawned.payload.get("continued") != Some(&Value::Bool(true)) {
        return None;
    }
    let pane = held_pane_of(&events, attempt, numbered_cwd_of(session, ticket_id))?;
    Some(ContinuedWork {
        pane,
        stream_offset: number(&spawned.payload, "stream_offset").unwrap_or(0),
    })
}

/// `paneAssignment`: the Assignment a Held pane runs: the one its attempt launched with, as the
/// `spawned` event recorded it, whatever a Reassign has written since; the ticket's current record
/// fills a field an older event did not record. An enlisted pane's is as found (issue #101): herdr
/// names its harness and nobody knows its model, which no config fills in.
pub fn pane_assignment(session: &Session, ticket_id: &str, held: &HeldPane) -> Assignment {
    let current = session.assignments.get(ticket_id);
    let enlisted = session.enlisted_work.contains_key(ticket_id);
    // An effort is only ever read off an event that recorded a model too, so a pane launched with none
    // stays at none rather than taking the config's.
    let effort = if enlisted {
        None
    } else if !held.model.is_empty() {
        held.effort.clone()
    } else {
        current.and_then(|c| c.effort.clone())
    };
    let pick = |held: &str, current: Option<&str>| {
        if !held.is_empty() {
            held.to_owned()
        } else {
            current.unwrap_or("").to_owned()
        }
    };
    Assignment {
        harness: pick(&held.harness, current.map(|c| c.harness.as_str())),
        model: if enlisted {
            String::new()
        } else {
            pick(&held.model, current.map(|c| c.model.as_str()))
        },
        effort: effort.filter(|e| !e.is_empty()),
        drivers: current.map_or_else(|| DEFAULT_DRIVERS.to_owned(), |c| c.drivers.clone()),
        verify: current.and_then(|c| c.verify),
    }
}

/// `restoreAssignment`: a Continued attempt's ending hands the ticket back to the config's
/// Assignment: the pane's was the attempt's, and the next Attempt launches on whatever the config says
/// now.
pub fn restore_assignment(session: &mut Session, marker: &TicketMarker) {
    let previous = session.assignments.shift_remove(&marker.id);
    let resolved = resolve_unseen_assignments(
        &session.markers,
        &mut session.assignments,
        &session.state.config,
        &session.harnesses,
    );
    if resolved.is_err()
        && let Some(previous) = previous
    {
        session.assignments.insert(marker.id.clone(), previous);
    }
}

#[cfg(test)]
mod tests {
    //! engine/held-panes.test.ts.

    use super::*;
    use serde_json::json;

    const AT: &str = "2026-09-25T10:00:00.000Z";

    fn event(attempt: u64, kind: TicketEventKind, payload: Value) -> Arc<TicketEvent> {
        Arc::new(TicketEvent {
            at: AT.to_owned(),
            attempt,
            kind,
            payload: payload.as_object().cloned().unwrap_or_default(),
        })
    }

    fn numbered_cwd(n: u64) -> String {
        format!("/pool/.git/pool-worktrees/01-attempt-{n}")
    }

    #[test]
    fn reads_a_checkpointed_attempts_pane_place_and_assignment_off_its_spawned_event() {
        let events = [
            event(
                1,
                TicketEventKind::Spawned,
                json!({
                    "argv": ["bash", "-c", "claude"],
                    "cwd": "/pool/.git/pool-worktrees/01",
                    "branch": "pool/p/01",
                    "pane_id": "w1:p1",
                    "tab_id": "w1:t1",
                    "terminal_id": "term_65b1",
                    "harness": "claude",
                    "model": "opus",
                }),
            ),
            event(
                1,
                TicketEventKind::Exited,
                json!({"code": 0, "status": "checkpoint"}),
            ),
            event(1, TicketEventKind::Checkpoint, json!({})),
        ];
        assert_eq!(
            held_pane_of(&events, 1, numbered_cwd),
            Some(HeldPane {
                attempt: 1,
                pane_id: "w1:p1".into(),
                tab_id: Some("w1:t1".into()),
                terminal_id: Some("term_65b1".into()),
                cwd: "/pool/.git/pool-worktrees/01".into(),
                branch: Some("pool/p/01".into()),
                harness: "claude".into(),
                model: "opus".into(),
                effort: None,
                work_attempt: 1,
                numbered: false,
                stream: None,
                spawned_at: AT.into(),
                wrapped: true,
            })
        );
    }

    #[test]
    fn knows_a_verify_candidate_by_the_attempt_worktree_it_ran_in() {
        let events = [event(
            3,
            TicketEventKind::Spawned,
            json!({
                "cwd": numbered_cwd(3),
                "branch": "pool/p/01-attempt-3",
                "pane_id": "w1:p3",
                "tab_id": "w1:t3",
            }),
        )];
        let held = held_pane_of(&events, 3, numbered_cwd).unwrap();
        assert!(held.numbered);
        assert_eq!(held.work_attempt, 3);
        assert_eq!((held.harness.as_str(), held.model.as_str()), ("", ""));
    }

    #[test]
    fn follows_a_continued_attempt_back_to_the_attempt_whose_worktree_and_stream_file_it_uses() {
        let events = [
            event(
                2,
                TicketEventKind::Spawned,
                json!({"cwd": numbered_cwd(2), "pane_id": "w1:p2", "tab_id": "w1:t2"}),
            ),
            event(
                3,
                TicketEventKind::Spawned,
                json!({
                    "cwd": numbered_cwd(2),
                    "pane_id": "w1:p2",
                    "tab_id": "w1:t2",
                    "continued": true,
                    "continues": 2,
                    "work_attempt": 2,
                    "numbered": true,
                    "stream": "/pool/runs/01.attempt-2.stream.jsonl",
                }),
            ),
        ];
        let held = held_pane_of(&events, 3, numbered_cwd).unwrap();
        assert_eq!(held.attempt, 3);
        assert_eq!(held.pane_id, "w1:p2");
        assert_eq!(held.work_attempt, 2);
        assert!(held.numbered);
        assert_eq!(
            held.stream.as_deref(),
            Some("/pool/runs/01.attempt-2.stream.jsonl")
        );
    }

    #[test]
    fn holds_nothing_for_a_headless_attempt_a_fallback_a_resolver_or_an_attempt_never_spawned() {
        assert_eq!(
            held_pane_of(
                &[event(
                    1,
                    TicketEventKind::Spawned,
                    json!({"cwd": "/pool", "pid": 42})
                )],
                1,
                numbered_cwd
            ),
            None
        );
        assert_eq!(
            held_pane_of(
                &[event(
                    1,
                    TicketEventKind::Spawned,
                    json!({"cwd": "/pool", "pane_id": null, "terminal_error": "x"})
                )],
                1,
                numbered_cwd
            ),
            None
        );
        assert_eq!(
            held_pane_of(
                &[
                    event(2, TicketEventKind::Resolver, json!({})),
                    event(
                        2,
                        TicketEventKind::Spawned,
                        json!({"cwd": "/pool", "pane_id": "w1:p2", "tab_id": "w1:t2"})
                    ),
                ],
                2,
                numbered_cwd
            ),
            None
        );
        assert_eq!(held_pane_of(&[], 1, numbered_cwd), None);
    }

    #[test]
    fn reads_back_the_attempt_the_latest_checkpoint_was_raised_for() {
        assert_eq!(
            last_checkpoint_attempt(&[
                event(1, TicketEventKind::Checkpoint, json!({})),
                event(2, TicketEventKind::Spawned, json!({})),
                event(3, TicketEventKind::Checkpoint, json!({})),
            ]),
            Some(3)
        );
        assert_eq!(
            last_checkpoint_attempt(&[event(1, TicketEventKind::Spawned, json!({}))]),
            None
        );
    }

    #[test]
    fn a_spawn_without_a_wrapped_flag_is_wrapped_when_it_has_an_argv() {
        let spawned = |extra: Value| {
            let mut payload = json!({"cwd": "/w", "pane_id": "p", "tab_id": "t"});
            payload
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            [event(1, TicketEventKind::Spawned, payload)]
        };
        let wrapped = |extra: Value| {
            held_pane_of(&spawned(extra), 1, numbered_cwd)
                .unwrap()
                .wrapped
        };
        assert!(wrapped(json!({"argv": ["bash"]})));
        assert!(!wrapped(json!({"argv": []})));
        assert!(!wrapped(json!({})));
        assert!(!wrapped(json!({"wrapped": false, "argv": ["bash"]})));
        assert!(wrapped(json!({"wrapped": true})));
    }

    // The survey and the hold over a real session: the hidden rows of the herdr area.
    mod surveyed {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};

        use futures::FutureExt;
        use tokio::sync::watch;

        use ac_core::events::{append_event, event_now};
        use ac_io::herdr::HerdrPane;
        use ac_protocol::{Interrupt, InterruptKind};

        use super::*;
        use crate::actor::Engine;
        use crate::live_attempts::LiveAttemptEntry;
        use crate::pane_survey::{Lister, create_pane_survey_over};

        fn marker(id: &str, status: TicketStatus) -> TicketMarker {
            TicketMarker {
                id: id.to_owned(),
                file: std::path::PathBuf::from(format!("/nonexistent/{id}.md")),
                blocked_by: Vec::new(),
                status,
                title: id.to_owned(),
                spec: String::new(),
                spawned_by: None,
                enlisted_from: None,
                spawn_assign: None,
            }
        }

        fn pane(id: &str, tab: &str) -> HerdrPane {
            HerdrPane {
                pane_id: id.to_owned(),
                tab_id: Some(tab.to_owned()),
                workspace_id: None,
                cwd: None,
                terminal_id: None,
            }
        }

        fn spawned(runs: &Path, owner: &str, attempt: u64, payload: Value) {
            let payload: Map<String, Value> = payload.as_object().cloned().unwrap();
            append_event(
                runs,
                owner,
                &event_now(attempt, TicketEventKind::Spawned, payload),
            )
            .unwrap();
        }

        struct Rig {
            engine: Engine,
            dir: tempfile::TempDir,
            panes: Arc<Mutex<Vec<HerdrPane>>>,
            answers: Arc<AtomicBool>,
        }

        async fn rig(markers: Vec<TicketMarker>) -> Rig {
            let dir = tempfile::tempdir().unwrap();
            let root = ac_core::js::path_text(dir.path());
            let (publisher, snapshots) = watch::channel(None);
            let mut session = crate::testkit::bare_session(publisher);
            session.runs_dir = root.clone();
            session.pool_dir = root;
            session.state.tickets = markers.iter().map(|m| (m.id.clone(), m.status)).collect();
            session.markers = markers;
            let engine = Engine::spawn(session, snapshots, |s, engine| s.engine = Some(engine));
            let panes: Arc<Mutex<Vec<HerdrPane>>> = Arc::new(Mutex::new(Vec::new()));
            let answers = Arc::new(AtomicBool::new(true));
            let (source, answering) = (Arc::clone(&panes), Arc::clone(&answers));
            let lister: Lister = Arc::new(move || {
                let listed = answering
                    .load(Ordering::SeqCst)
                    .then(|| source.lock().unwrap().clone());
                async move { listed }.boxed()
            });
            engine
                .call(move |s| create_pane_survey_over(s, None, lister))
                .await
                .unwrap();
            Rig {
                engine,
                dir,
                panes,
                answers,
            }
        }

        #[tokio::test]
        async fn opened_tabs_are_recomputed_only_when_the_survey_lists_even_when_the_listing_fails()
        {
            let rig = rig(vec![marker("01", TicketStatus::Done)]).await;
            let runs = rig.dir.path().to_path_buf();
            spawned(&runs, "01", 1, json!({"pane_id": "p1", "tab_id": "t1"}));
            let tabs = |engine: Engine| async move {
                engine
                    .call(|s| {
                        s.opened_tabs
                            .iter()
                            .map(|t| t.tab_id.clone())
                            .collect::<Vec<_>>()
                    })
                    .await
                    .unwrap()
            };
            assert!(tabs(rig.engine.clone()).await.is_empty());
            rig.panes.lock().unwrap().push(pane("p1", "t1"));
            assert!(rig.engine.refresh_pane_survey().await);
            assert_eq!(tabs(rig.engine.clone()).await, ["t1"]);

            // A tab the events name later is not seen until the survey lists again.
            spawned(&runs, "01", 2, json!({"pane_id": "p2", "tab_id": "t2"}));
            assert_eq!(tabs(rig.engine.clone()).await, ["t1"]);
            // A listing the daemon cannot answer still refreshes the opened tabs, while the old
            // listing stays.
            rig.answers.store(false, Ordering::SeqCst);
            assert!(!rig.engine.refresh_pane_survey().await);
            assert_eq!(tabs(rig.engine.clone()).await, ["t1", "t2"]);
            let listed = rig
                .engine
                .call(|s| {
                    s.pane_survey
                        .as_ref()
                        .and_then(|survey| survey.latest())
                        .map(|l| l.panes.len())
                })
                .await
                .unwrap();
            assert_eq!(listed, Some(1));
        }

        #[tokio::test]
        async fn the_untouchable_panes_are_read_at_every_emit_not_only_at_a_listing() {
            let rig = rig(vec![marker("01", TicketStatus::Done)]).await;
            spawned(
                rig.dir.path(),
                "01",
                1,
                json!({"pane_id": "p1", "tab_id": "t1"}),
            );
            rig.panes.lock().unwrap().push(pane("p1", "t1"));
            assert!(rig.engine.refresh_pane_survey().await);
            let finished = |engine: Engine| async move {
                engine.call(|s| finished_terminals_now(s)).await.unwrap()
            };
            assert_eq!(finished(rig.engine.clone()).await, 1);
            // The pane comes into use: the count drops at the next emit with no new listing.
            rig.engine
                .call(|s| {
                    crate::live_attempts::register(
                        s,
                        "01",
                        LiveAttemptEntry::new(2, Some("p1".into()), Some("t1".into())),
                    )
                })
                .await
                .unwrap();
            assert_eq!(finished(rig.engine.clone()).await, 0);
            assert_eq!(
                rig.engine
                    .call(|s| s
                        .pane_survey
                        .as_ref()
                        .unwrap()
                        .latest()
                        .unwrap()
                        .panes
                        .len())
                    .await
                    .unwrap(),
                1
            );
        }

        #[tokio::test]
        async fn a_held_panes_tui_exit_is_checked_at_every_emit_but_the_hold_goes_only_at_a_listing()
         {
            let rig = rig(vec![marker("01", TicketStatus::Checkpoint)]).await;
            let runs = rig.dir.path().to_path_buf();
            spawned(
                &runs,
                "01",
                1,
                json!({"pane_id": "p1", "tab_id": "t1", "cwd": "/nonexistent/w", "argv": ["bash"]}),
            );
            rig.panes.lock().unwrap().push(pane("p1", "t1"));
            assert!(rig.engine.refresh_pane_survey().await);
            rig.engine
                .call(|s| {
                    s.state.interrupts.push(Interrupt {
                        ticket_id: "01".into(),
                        kind: InterruptKind::Checkpoint,
                        body: "b".into(),
                        candidates: None,
                        steward_note: None,
                    });
                    let events = read_events(Path::new(&s.runs_dir), "01");
                    let held = held_pane_of(&events, 1, |_| String::new()).unwrap();
                    s.held.insert("01".into(), held);
                })
                .await
                .unwrap();
            let records = |engine: Engine| async move {
                engine
                    .call(|s| (held_pane_records(s).len(), s.held.len()))
                    .await
                    .unwrap()
            };
            assert_eq!(records(rig.engine.clone()).await, (1, 1));
            // The wrapper writes its exit-code file after the attempt began: the TUI exited.
            std::fs::write(runs.join("01.exitcode"), "0").unwrap();
            assert_eq!(
                records(rig.engine.clone()).await,
                (0, 1),
                "hidden at the emit, kept"
            );
            assert!(rig.engine.refresh_pane_survey().await);
            assert_eq!(
                records(rig.engine.clone()).await,
                (0, 0),
                "let go at the listing"
            );
        }
    }
}
