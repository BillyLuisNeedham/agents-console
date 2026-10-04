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
fn held_exit_code_path(session: &Session, ticket_id: &str, held: &HeldPane) -> Option<String> {
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
    for view in crate::conversations::views(session) {
        if let Some(pane) = view.pane_id.filter(|pane| !pane.is_empty()) {
            panes.insert(pane);
        }
    }
    for held in session.held.values() {
        panes.insert(held.pane_id.clone());
    }
    panes.extend(crate::conversations::live_terminals(session).0);
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
    for view in crate::conversations::views(session) {
        if let Some(pane) = view.pane_id.filter(|pane| !pane.is_empty())
            && session.conversations.is_live(&view.id)
        {
            panes.insert(pane);
        }
    }
    panes.extend(registered_panes_of(session));
    panes.extend(session.enlisted_terminals.panes.iter().cloned());
    let mut tabs: HashSet<String> = session.enlisted_terminals.tabs.iter().cloned().collect();
    tabs.extend(crate::conversations::live_terminals(session).1);
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
