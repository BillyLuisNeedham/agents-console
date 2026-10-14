//! The Factory's Line in the engine (issue #187, ADR-0037): Start the Line, routing a Station Ticket's
//! ending to the next Station at the super-step boundary, and the verdict check every Station attempt's
//! Outcome passes through. The decisions are `ac_core::line`'s; this module reads the pool for them and
//! writes what they return: the next Station Ticket, the Line's state in `line.json`, and the engine's
//! checkpoints.
//!
//! Routing runs at the boundary rather than at an attempt's exit, so every way a Station Ticket can end
//! (a launched attempt, an adopted one, a Continued one, a Close, a Resume of the Finish checkpoint)
//! comes to the one place, and a restart between the ending and the routing loses nothing: the Line
//! still points at the ended Ticket, and the next boundary routes it.

use std::path::Path;

use ac_core::assignment::resolve_unseen_assignments;
use ac_core::events::last_attempt;
use ac_core::js;
use ac_core::line::{
    NewTicket, Routed, StationEnd, VerdictCheck, approves, check_station_outcome, find_brief,
    no_verdict_brief, read_brief, resolve_factory, route, save_line, start_line as begin_line,
    station_ticket_text, verdict_check,
};
use ac_core::outcome::ValidOutcome;
use ac_core::pool::{TicketMarker, load_pool_tickets, write_marker_status};
use ac_protocol::{InterruptKind, LineStatus, Station, TicketStatus};

use crate::error::EngineError;
use crate::session::{PoolUpdate, Session};

/// The verdict check a Ticket's attempt Outcome passes through: `None` for a Ticket that is no Station
/// of a Line (an Implement's check passes everything).
pub fn verdict_check_for(session: &Session, marker: &TicketMarker) -> Option<VerdictCheck> {
    let station = marker.station?;
    Some(match &session.line {
        Some(line) => verdict_check(line, station),
        None => VerdictCheck {
            station,
            musts: Vec::new(),
        },
    })
}

/// A Station attempt's valid Outcome after its verdict check: a done one without a valid verdict is
/// the no-verdict checkpoint.
pub fn checked(check: Option<&VerdictCheck>, valid: ValidOutcome) -> ValidOutcome {
    match check {
        Some(check) => check_station_outcome(check, valid),
        None => valid,
    }
}

/// Start the Line (ADR-0037): read the brief, write the Line's state and Round 1's Implement Ticket,
/// and kick the drive. Refused, with the reason, when the brief is missing or invalid or a Line has
/// already started.
pub fn start_line(session: &mut Session, brief: Option<String>) -> Result<String, EngineError> {
    if let Some(line) = &session.line {
        return Err(EngineError::refused(format!(
            "the Line has already started: Round {}, {} ({})",
            line.round, line.ticket, line.status
        )));
    }
    let checkout = Path::new(&session.cwd).to_path_buf();
    let path = find_brief(&checkout, brief.as_deref()).map_err(EngineError::refused)?;
    let brief = read_brief(&checkout, &path).map_err(EngineError::refused)?;
    let factory = resolve_factory(&brief);
    let (line, first) = begin_line(brief, &path, &factory);
    if session.marker(&first.id).is_some() {
        return Err(EngineError::refused(format!(
            "ticket {} is already in the pool: a Factory pool runs one Line",
            first.id
        )));
    }
    let id = first.id.clone();
    write_station_ticket(session, &first).map_err(|e| EngineError::refused(e.to_string()))?;
    if let Err(error) = save_line(Path::new(&session.pool_dir), &line) {
        // Without line.json the Ticket would run as no Station of any Line: take it back, so Start
        // can be tried again.
        let file = Path::new(&session.issues_dir).join(format!("{id}.md"));
        let _ = std::fs::remove_file(&file);
        if let Ok(markers) = load_pool_tickets(Path::new(&session.pool_dir), true) {
            session.markers = markers;
            session.state.tickets.shift_remove(&id);
        }
        return Err(EngineError::refused(format!(
            "line.json could not be written: {error}"
        )));
    }
    session.line = Some(line);
    // A pool booted with no Ticket rested at a vacuous Review; the Line's first Ticket ends it, as an
    // approval only stands while every Ticket is finished.
    let interrupts: Vec<_> = session
        .state
        .interrupts
        .iter()
        .filter(|i| i.kind != InterruptKind::Review)
        .cloned()
        .collect();
    session.apply(PoolUpdate {
        interrupts: Some(interrupts),
        review_approved: Some(false),
        ..PoolUpdate::default()
    });
    session.log(format!("line: started from {path}; {id} written"));
    // A drive closing right now would settle without seeing the new Ticket: have it start the next.
    if session.driving {
        session.finalized_while_driving = true;
    }
    crate::answers::kick_processing(session).map_err(|e| EngineError::refused(e.to_string()))?;
    crate::snapshot::emit_snapshot(session, session.current_phase());
    Ok(id)
}

// The last Resume note on a Ticket file: the operator's (or the Steward's) answer on the Finish
// checkpoint. `None` when it was resumed without one.
fn last_resume_note(file: &Path) -> Option<String> {
    let text = js::read_text(file).ok()?;
    let at = text.rfind("\n## Resume note")?;
    let rest = &text[at + 1..];
    let body_at = rest.find('\n')? + 1;
    let body = &rest[body_at..];
    let end = body.find("\n## ").unwrap_or(body.len());
    let note = js::trim(&body[..end]);
    (!note.is_empty()).then(|| note.to_owned())
}

/// The boundary's Line step: while the current Station Ticket has ended, route it and write the next.
/// Each routing writes a fresh Ticket that has not ended, so this settles in one pass; the loop bound
/// only guards against a Line that would not.
pub fn route_line(session: &mut Session) -> anyhow::Result<()> {
    for _ in 0..8 {
        if !route_once(session)? {
            return Ok(());
        }
    }
    Ok(())
}

fn route_once(session: &mut Session) -> anyhow::Result<bool> {
    let Some(line) = session.line.clone() else {
        return Ok(false);
    };
    if matches!(line.status, LineStatus::Done | LineStatus::Closed) {
        return Ok(false);
    }
    let Some(marker) = session.marker(&line.ticket).cloned() else {
        session.log(format!(
            "line: its current Ticket {} is not in the pool; the Line waits",
            line.ticket
        ));
        return Ok(false);
    };
    let status = session
        .state
        .tickets
        .get(&marker.id)
        .copied()
        .unwrap_or(marker.status);
    let outcome = session.state.outcomes.get(&marker.id).cloned();
    let end = match (line.station, status) {
        // Decided from the note alone, so a routing a restart cut short after the Finish was marked
        // done replays the same way.
        (Station::Finish, TicketStatus::Ready | TicketStatus::Done) => {
            match last_resume_note(&marker.file) {
                note if approves(note.as_deref()) => StationEnd::Approved,
                Some(note) => StationEnd::Notes(note),
                None => StationEnd::Approved,
            }
        }
        (_, TicketStatus::Closed) => StationEnd::Closed,
        (_, TicketStatus::Done) => match &outcome {
            Some(outcome) => StationEnd::Done(outcome),
            None => {
                session.log(format!(
                    "line: {} is done but has no Outcome to route from; the Line waits",
                    marker.id
                ));
                return Ok(false);
            }
        },
        _ => return Ok(false),
    };
    let factory = resolve_factory(&line.brief);
    let mut next_line = line.clone();
    let routed = match route(&mut next_line, &factory, end) {
        Ok(routed) => routed,
        Err(problem) => {
            // A done Station whose verdict does not parse never routes: it is the no-verdict
            // checkpoint, as at its exit.
            let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
            crate::verify::checkpoint_ticket_by_engine(
                session,
                &marker,
                attempt,
                Some(&no_verdict_brief(line.station, &problem)),
                format!(
                    "line: {} has no valid verdict ({problem}); checkpointed",
                    marker.id
                ),
                false,
                None,
            )?;
            return Ok(false);
        }
    };
    if line.station == Station::Finish && status != TicketStatus::Done {
        // The Finish checkpoint is the operator's: resumed, it is answered, never run.
        write_marker_status(&marker.file, TicketStatus::Done)?;
        if let Some(m) = session.marker_mut(&marker.id) {
            m.status = TicketStatus::Done;
        }
        session.apply(PoolUpdate {
            tickets: Some(
                [(marker.id.clone(), TicketStatus::Done)]
                    .into_iter()
                    .collect(),
            ),
            ..PoolUpdate::default()
        });
    }
    let line_text = match &routed {
        Routed::Next(next) => {
            write_station_ticket(session, next)?;
            format!("line: {} routed to {}", marker.id, next.id)
        }
        Routed::Done => format!("line: {} approved; the Line is done", marker.id),
        Routed::Closed => format!("line: {} closed; the Line ends at its Finish", marker.id),
    };
    save_line(Path::new(&session.pool_dir), &next_line)?;
    session.line = Some(next_line);
    session.log(line_text);
    Ok(matches!(routed, Routed::Next(_)))
}

// Write one Station Ticket into the pool and fold it in as answer processing brings a hand-written
// ticket in. A file already there is the one an interrupted routing wrote, and is kept. A Ticket
// written at a checkpoint (the Prove limit, the Finish) raises its Interrupt at once.
fn write_station_ticket(session: &mut Session, ticket: &NewTicket) -> anyhow::Result<()> {
    let file = Path::new(&session.issues_dir).join(format!("{}.md", ticket.id));
    if !file.exists() {
        js::write_file(&file, &station_ticket_text(ticket))?;
    }
    session.markers = load_pool_tickets(Path::new(&session.pool_dir), false)?;
    resolve_unseen_assignments(
        &session.markers,
        &mut session.assignments,
        &session.state.config,
        &session.harnesses,
    )?;
    let tickets = session.marker_statuses();
    session.apply(PoolUpdate {
        tickets: Some(tickets),
        ..PoolUpdate::default()
    });
    if let Some(brief) = &ticket.checkpoint {
        let Some(marker) = session.marker(&ticket.id).cloned() else {
            return Ok(());
        };
        if marker.status == TicketStatus::Ready {
            let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
            crate::verify::checkpoint_ticket_by_engine(
                session,
                &marker,
                attempt,
                Some(brief),
                format!("line: {} written at a checkpoint", marker.id),
                false,
                None,
            )?;
        }
    }
    Ok(())
}
