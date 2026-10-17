use std::path::Path;

use ac_core::assignment::resolve_unseen_assignments;
use ac_core::events::last_attempt;
use ac_core::js;
use ac_core::line::{
    BriefPlace, FactoryLayers, LinePlaces, NewTicket, ResolvedFactory, Routed, StationEnd,
    VerdictCheck, approves, check_station_outcome, factory_layer_of, find_brief, find_brief_in,
    line_base_of, no_verdict_brief, read_brief, read_brief_in, report_file_name, resolve_factory,
    route, save_line, start_line as begin_line, station_ticket_text, verdict_check, written_report,
};
use ac_core::machine_defaults::read_machine_defaults;
use ac_core::outcome::ValidOutcome;
use ac_core::pool::{TicketMarker, load_pool_tickets, write_marker_status};
use ac_io::git;
use ac_protocol::{
    ConversationRole, ConversationStatus, InterruptKind, LineStatus, LineView, Station,
    TicketStatus,
};

use crate::error::EngineError;
use crate::session::{PoolUpdate, Session};

/// A Factory pool (ADR-0037): one whose Line has started, or one Boot's Factory mode marked
/// `factoryPool` in console.json. Approving its Finish checkpoint is the Review, so it raises no
/// run-wide Review Interrupt.
pub fn is_factory_pool(session: &Session) -> bool {
    session.line.is_some()
        || session
            .state
            .config
            .get("factoryPool")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
}

/// Whether a Factory pool's Line has ended (approved, or closed at its Finish), so the pool is done.
pub fn line_ended(session: &Session) -> bool {
    session
        .line
        .as_ref()
        .is_some_and(|line| matches!(line.status, LineStatus::Done | LineStatus::Closed))
}

/// The verdict check a Ticket's attempt Outcome passes through: `None` for a Ticket that is no Station
/// of a Line (an Implement's check passes everything).
pub fn verdict_check_for(session: &Session, marker: &TicketMarker) -> Option<VerdictCheck> {
    let station = marker.station?;
    Some(match &session.line {
        Some(line) => {
            let factory = session
                .line_factory
                .clone()
                .unwrap_or_else(|| resolve_factory(&factory_layers(session), &line.brief));
            verdict_check(line, &factory, station)
        }
        None => VerdictCheck::of(station),
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

pub fn factory_layers(session: &Session) -> FactoryLayers {
    FactoryLayers {
        machine: read_machine_defaults(&session.machine_defaults)
            .factory
            .map(|layer| *layer),
        pool: factory_layer_of(session.state.config.get("factory")),
    }
}

fn line_factory(session: &mut Session) -> Option<ResolvedFactory> {
    let line = session.line.as_ref()?;
    if session.line_factory.is_none() {
        session.line_factory = Some(resolve_factory(&factory_layers(session), &line.brief));
    }
    session.line_factory.clone()
}

/// The Line as the Console's header strip reads it, `None` before Start the Line.
pub fn line_view(session: &mut Session) -> Option<LineView> {
    let factory = line_factory(session)?;
    let line = session.line.as_ref()?;
    Some(LineView {
        round: line.round,
        station: line.station,
        ticket: line.ticket.clone(),
        status: line.status,
        prove_fails: line.prove_fails,
        prove_fails_allowed: factory.prove_fails_per_round + line.fixes_bought,
        finish: factory.finish.clone(),
        report: written_report(line).is_some(),
        halted: line.halted.clone(),
    })
}

/// Start the Line (ADR-0037): read the brief, write the Line's state and Round 1's Implement Ticket,
/// and kick the drive. Refused, with the reason, when the brief is missing or invalid or a Line has
/// already started.
pub fn start_line(session: &mut Session, brief: Option<String>) -> Result<String, EngineError> {
    refuse_if_started(session)?;
    let checkout = Path::new(&session.cwd).to_path_buf();
    let path = find_brief(&checkout, brief.as_deref()).map_err(EngineError::refused)?;
    let brief = read_brief(&checkout, &path).map_err(EngineError::refused)?;
    let factory = resolve_factory(&factory_layers(session), &brief);
    refuse_if_unlaunchable(session, &factory)?;
    let base = line_base(session)?;
    session.line_factory = Some(factory.clone());
    let places = LinePlaces {
        branch: target_branch(session),
        base,
        report: js::path_text(&Path::new(&session.runs_dir).join(report_file_name(&path))),
    };
    let (line, first) = begin_line(brief, &path, &factory, places);
    refuse_if_taken(session, &first)?;
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
    session
        .wake()
        .map_err(|e| EngineError::refused(e.to_string()))?;
    crate::snapshot::emit_snapshot(session, session.current_phase());
    Ok(id)
}

fn refuse_if_started(session: &Session) -> Result<(), EngineError> {
    match &session.line {
        Some(line) => Err(EngineError::refused(format!(
            "the Line has already started: Round {}, {} ({})",
            line.round, line.ticket, line.status
        ))),
        None => Ok(()),
    }
}

fn refuse_if_unlaunchable(session: &Session, factory: &ResolvedFactory) -> Result<(), EngineError> {
    match factory.unknown_harness(&session.harnesses) {
        Some(problem) => Err(EngineError::refused(format!(
            "the Line cannot start: {problem}. Fix the Line brief or the Factory settings"
        ))),
        None => Ok(()),
    }
}

fn refuse_if_taken(session: &Session, first: &NewTicket) -> Result<(), EngineError> {
    match session.marker(&first.id) {
        Some(_) => Err(EngineError::refused(format!(
            "ticket {} is already in the pool: a Factory pool runs one Line",
            first.id
        ))),
        None => Ok(()),
    }
}

// The Line base Boot's Factory mode wrote into console.json (issue #193): none in a pool Boot did not
// cut, whose Line reads as cut from main. A malformed one refuses the Line rather than read as main,
// where its PR would land on the wrong shared branch (ADR-0038).
fn line_base(session: &Session) -> Result<Option<ac_protocol::LineBase>, EngineError> {
    let Some(value) = session.state.config.get("lineBase") else {
        return Ok(None);
    };
    line_base_of(value).map(Some).map_err(|why| {
        EngineError::refused(format!(
            "the Line cannot start: console.json's lineBase is malformed ({why}), and a Line read as \
             cut from main would open its PR against main. Fix it to the {{ ref, commit }} Boot \
             wrote, or remove it for a Line cut from main"
        ))
    })
}

// The branch the pool merges into: the one an enlist captured, else the pool checkout's own.
fn target_branch(session: &Session) -> String {
    session.merge_target.clone().unwrap_or_else(|| {
        git::git_line(&session.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default()
    })
}

// The Grill's branch's committed tree (Start the Line reads the brief there before merging anything):
// work the Grill has not committed never merges, so it never counts.
struct GrillBranch<'a> {
    cwd: &'a str,
    branch: &'a str,
}

impl BriefPlace for GrillBranch<'_> {
    fn name(&self) -> String {
        format!("the Grill's committed branch {}", self.branch)
    }
    fn names_in(&self, dir: &str) -> Vec<String> {
        let tree = format!("{}:{dir}", self.branch);
        let probe = git::git(self.cwd, ["ls-tree", "--name-only", tree.as_str()]);
        if !probe.ok {
            return Vec::new();
        }
        probe.out.lines().map(str::to_owned).collect()
    }
    fn read(&self, path: &str) -> Option<Result<String, String>> {
        let object = format!("{}:{path}", self.branch);
        let kind = git::git(self.cwd, ["cat-file", "-t", object.as_str()]);
        if !kind.ok || kind.out.trim() != "blob" {
            return None;
        }
        let shown = git::run_git(Some(Path::new(self.cwd)), ["show", object.as_str()]);
        Some(if shown.code == Some(0) {
            Ok(String::from_utf8_lossy(&shown.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&shown.stderr).trim().to_owned())
        })
    }
}

/// Start the Line on the Grill (ADR-0037), the operator's act: check the Line brief on the Grill's
/// committed branch, merge that branch into the Line's, and start the Line from the merged brief, in
/// one stretch so nothing lands between the merge and Round 1's Implement. The caller ends the Grill
/// after, with nothing left to merge. Refused, with the reason and nothing changed, when the Line has
/// started, the id is no live Grill, the brief is missing or invalid, a Station names a harness the
/// pool does not know, its first Ticket is already in the pool, or the merge does not land. Only a failed write of the first Ticket or `line.json` after
/// the merge refuses with the merge landed; Start the Line can then be tried again.
pub fn start_line_from_grill(session: &mut Session, grill: &str) -> Result<String, EngineError> {
    refuse_if_started(session)?;
    let Some(record) = crate::conversations::load(session)
        .into_iter()
        .find(|rec| rec.id == grill)
    else {
        return Err(EngineError::refused(format!("no Conversation {grill}")));
    };
    if record.role != Some(ConversationRole::Grill) {
        return Err(EngineError::refused(format!(
            "{grill} is not the Grill: the Line starts only from its Grill"
        )));
    }
    let (branch, ending) = crate::conversations::branch_and_ending(session, grill);
    if record.status != ConversationStatus::Live || ending {
        return Err(EngineError::refused(format!(
            "the Grill {grill} has ended; the Line starts only from a live Grill"
        )));
    }
    let place = GrillBranch {
        cwd: &session.cwd,
        branch: &branch,
    };
    let path = find_brief_in(&place, None).map_err(EngineError::refused)?;
    let brief = read_brief_in(&place, &path).map_err(EngineError::refused)?;
    // Every refusal Start the Line can make on the brief comes before the merge, so a refused start
    // leaves the Line's branch as it was.
    let factory = resolve_factory(&factory_layers(session), &brief);
    refuse_if_unlaunchable(session, &factory)?;
    let (_, first) = begin_line(brief, &path, &factory, LinePlaces::default());
    refuse_if_taken(session, &first)?;
    if crate::checkout_gate::pool_checkout_held(session) {
        return Err(EngineError::refused(
            "a Continued attempt holds the pool checkout; Start the Line once it ends",
        ));
    }
    let hold = crate::checkout_gate::hold_pool_checkout(
        session,
        "Start the Line is merging the Grill's branch",
    );
    let merged = crate::conversations::merge_into_target(session, &branch);
    crate::checkout_gate::release_pool_checkout(session, hold);
    if !merged.ok {
        return Err(EngineError::refused(format!(
            "the Grill's branch {branch} did not merge into the Line's branch, so the Line has not \
             started and the Grill goes on: {}",
            if merged.detail.is_empty() {
                merged.conflicted.join(", ")
            } else {
                merged.detail.clone()
            }
        )));
    }
    session.log(format!(
        "line: Start the Line merged the Grill {grill}'s branch {branch}"
    ));
    start_line(session, Some(path))
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

pub fn route_line(session: &mut Session) -> anyhow::Result<()> {
    session.line_factory = session
        .line
        .as_ref()
        .map(|line| resolve_factory(&factory_layers(session), &line.brief));
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
    let factory = resolve_factory(&factory_layers(session), &line.brief);
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
    if let Routed::Next(next) = &routed
        && let Some(problem) = unknown_harness_of(session, next)
    {
        // A settings layer changed under the Line to a harness the pool does not know. The next
        // Ticket is never written (its marker would fail every Assignment resolution, a boot's too):
        // the ended Station checkpoints instead, and once resumed it runs again and routes on the
        // fixed settings.
        let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
        crate::verify::checkpoint_ticket_by_engine(
            session,
            &marker,
            attempt,
            Some(&format!(
                "The Line cannot route to {}: {problem}. Fix the Factory settings (the Pool \
                 settings or the Machine defaults), then Resume: this Station runs again and its \
                 Outcome routes on the fixed settings.",
                next.id
            )),
            format!(
                "line: {} not written ({problem}); {} checkpointed",
                next.id, marker.id
            ),
            false,
            None,
        )?;
        return Ok(false);
    }
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

// The harness a Station Ticket would run on, when the pool does not know it.
fn unknown_harness_of(session: &Session, ticket: &NewTicket) -> Option<String> {
    let harness = ticket.assign.as_ref()?.harness.as_deref()?;
    (!session.harnesses.contains(harness)).then(|| {
        format!(
            "it names unknown harness '{harness}'. Known: {}",
            session.harnesses.known()
        )
    })
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
