//! The pool's Line (ADR-0039): the shell around `ac_core::line::run`. The tick's Line step reads the
//! pool into `LineFacts`, advances the run, saves `line.json` and only then writes what the run
//! projects, each file create-if-absent by its id. Line start, the Grill bridge, the Outcome check
//! at an attempt's exit and the answer check on a Line Ticket all come through here.

use std::path::Path;

use ac_core::assignment::{engine_ticket_build_id, resolve_unseen_assignments};
use ac_core::events::last_attempt;
use ac_core::js;
use ac_core::line::run::{
    Blocker, ConversationFact, ConversationOutcome, HoldAnswer, LineBrief, LineEvent, LineFacts,
    LinePlaces, LineRun, LineStart, LineStatus, OutcomeCheck, TicketFact, TicketId, brief_problem,
    hold_text, ticket_text, verdict_of,
};
use ac_core::line::{line_base_of, save_line};
use ac_core::outcome::ValidOutcome;
use ac_core::plan::{NodeBody, Plan, SpawnPolicy};
use ac_core::pool::{TicketMarker, load_pool_tickets};
use ac_io::git;
use ac_protocol::{
    ConversationRole, ConversationStatus, InterruptKind, LineGraphView, Outcome, OutcomeStatus,
    TicketStatus,
};
use serde_json::Value;

use crate::error::EngineError;
use crate::session::{PoolUpdate, Session};

/// Whether the pool's Line has ended, Done or Closed, so the pool is done.
pub fn line_ended(session: &Session) -> bool {
    session
        .line
        .as_ref()
        .is_some_and(|line| matches!(line.status(), LineStatus::Done | LineStatus::Closed))
}

/// The pool as the Line reads it, rebuilt from durable sources at every call. A Line Ticket is one
/// whose marker names a node; every other Ticket is outside the Line.
struct SessionFacts<'a> {
    session: &'a Session,
    plan: &'a Plan,
    unlanded: Vec<String>,
}

impl<'a> SessionFacts<'a> {
    fn new(session: &'a mut Session, plan: &'a Plan) -> Self {
        let unlanded = crate::merges::merge_hold(session);
        SessionFacts {
            session,
            plan,
            unlanded,
        }
    }

    // The scheduler's merged rule (drive.rs `merged`): a hold, an engine-run Ticket and every
    // Ticket outside git have no branch to merge.
    fn merged(&self, marker: &TicketMarker) -> bool {
        marker.hold
            || engine_ticket_build_id(&marker.id).is_some()
            || !self.session.git
            || !self.unlanded.contains(&marker.id)
    }

    fn verdict(&self, marker: &TicketMarker) -> Option<ac_core::plan::Verdict> {
        let kind = match marker.node.as_deref().and_then(|n| node_body(self.plan, n)) {
            Some(NodeBody::Ticket(t)) => Some(t.kind),
            _ => None,
        };
        let Some(kind) = kind else {
            return Some(ac_core::plan::Verdict::Done);
        };
        let outcome = self.session.state.outcomes.get(&marker.id);
        verdict_of(kind, outcome.and_then(|o| o.verdict.as_ref())).ok()
    }
}

impl LineFacts for SessionFacts<'_> {
    fn ticket(&self, id: &TicketId) -> TicketFact {
        let Some(marker) = self.session.marker(id.as_str()) else {
            return TicketFact::Unwritten;
        };
        let status = self.session.status_of(&marker.id).unwrap_or(marker.status);
        match status {
            TicketStatus::Closed => TicketFact::Closed,
            TicketStatus::Done if marker.hold => {
                let (note, by_steward) = last_resume_note(&marker.file);
                TicketFact::Answered { note, by_steward }
            }
            // A done Ticket with no verdict to route from waits, as the Finish's list shows.
            TicketStatus::Done => match self.verdict(marker) {
                Some(verdict) => TicketFact::Done {
                    verdict,
                    items: Vec::new(),
                    merged: self.merged(marker),
                },
                None => TicketFact::Live,
            },
            _ => TicketFact::Live,
        }
    }

    // The Grill stands in for an entry Conversation pass until slice 5 opens them itself.
    fn conversation(&self, _: &TicketId) -> ConversationFact {
        match crate::conversations::grill_id(self.session) {
            Some(_) => ConversationFact::Open,
            None => ConversationFact::Unopened,
        }
    }

    fn outcome(&self, id: &TicketId) -> Option<&Outcome> {
        self.session.state.outcomes.get(id.as_str())
    }

    fn outside_blockers(&self) -> Vec<Blocker> {
        let session = self.session;
        let mut blockers = Vec::new();
        for marker in session.markers.iter().filter(|m| m.node.is_none()) {
            match session.status_of(&marker.id).unwrap_or(marker.status) {
                TicketStatus::Closed => {}
                TicketStatus::Done if self.merged(marker) => {}
                TicketStatus::Done => blockers.push(Blocker::Unmerged(marker.id.clone())),
                _ => blockers.push(Blocker::Ticket(marker.id.clone())),
            }
        }
        blockers.extend(
            session
                .spawn_proposals
                .held()
                .iter()
                .map(|held| Blocker::HeldSpawn(held.id.clone())),
        );
        blockers.extend(
            session
                .spawn_proposals
                .pending()
                .iter()
                .map(|pending| Blocker::PendingSpawn(pending.id.clone())),
        );
        let line_ticket = |id: &str| session.marker(id).is_some_and(|m| m.node.is_some());
        blockers.extend(
            session
                .state
                .interrupts
                .iter()
                .filter(|i| !line_ticket(&i.ticket_id))
                .map(|i| Blocker::Interrupt(i.ticket_id.clone())),
        );
        blockers
    }

    fn runs_dir(&self) -> String {
        self.session.runs_dir.clone()
    }
}

/// The last Resume note on a hold's file and whether the Steward wrote it: the answer the run reads.
/// `None` when it was resumed without one.
fn last_resume_note(file: &Path) -> (Option<String>, bool) {
    let Ok(text) = js::read_text(file) else {
        return (None, false);
    };
    let Some(at) = text.rfind("\n## Resume note") else {
        return (None, false);
    };
    let rest = &text[at + 1..];
    let Some(heading_end) = rest.find('\n') else {
        return (None, false);
    };
    let by_steward = rest[..heading_end].contains("from the Steward");
    let body = &rest[heading_end + 1..];
    let end = body.find("\n## ").unwrap_or(body.len());
    let note = js::trim(&body[..end]);
    ((!note.is_empty()).then(|| note.to_owned()), by_steward)
}

// The Plan node a marker's `node=` names.
fn node_body<'p>(plan: &'p Plan, node: &str) -> Option<&'p NodeBody> {
    let id = ac_core::plan::NodeId::parse(node).ok()?;
    plan.node(&id).map(|node| &node.body)
}

/// The tick's Line step: advance the run over the pool, save `line.json` when it changed, then
/// write the projection. Every write is create-if-absent, so a tick after a crash anywhere in here
/// writes only what is missing.
pub fn advance_line(session: &mut Session) -> anyhow::Result<()> {
    let Some(advanced) = with_run(session, |run, facts| run.advance(facts)) else {
        return Ok(());
    };
    if advanced.changed
        && let Some(run) = &session.line
    {
        save_line(Path::new(&session.pool_dir), run)?;
    }
    for line in advanced.log {
        session.log(line);
    }
    let effects = advanced.effects;
    let mut written = Vec::new();
    for ticket in &effects.tickets {
        if write_if_absent(session, ticket.id.as_str(), &ticket_text(ticket))? {
            written.push(ticket.id.as_str().to_owned());
        }
    }
    for hold in &effects.holds {
        let id = hold.id.as_str();
        let text = crate::interrupts::landed_brief_text(&hold_text(hold), Some(&hold.brief));
        if write_if_absent(session, id, &text)? {
            written.push(id.to_owned());
        }
    }
    if !written.is_empty() {
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
        session.log(format!("line: wrote {}", written.join(", ")));
    }
    raise_unraised_holds(session)
}

fn issue_file(session: &Session, id: &str) -> std::path::PathBuf {
    Path::new(&session.issues_dir).join(format!("{id}.md"))
}

// Through a rename, so a crash mid-write never leaves a torn file that "exists" and is never
// written again.
fn write_if_absent(session: &Session, id: &str, text: &str) -> anyhow::Result<bool> {
    let file = issue_file(session, id);
    if file.exists() {
        return Ok(false);
    }
    js::write_through_rename(&file, file.with_extension("md.tmp"), text)?;
    Ok(true)
}

// Every hold Ticket waiting at its checkpoint carries its Interrupt, raised the tick it was written
// or, after a crash between the file and the checkpoint row, the first tick after.
fn raise_unraised_holds(session: &mut Session) -> anyhow::Result<()> {
    let unraised: Vec<TicketMarker> = session
        .markers
        .iter()
        .filter(|m| m.hold && session.status_of(&m.id) == Some(TicketStatus::Checkpoint))
        .filter(|m| !session.state.interrupts.iter().any(|i| i.ticket_id == m.id))
        .cloned()
        .collect();
    for marker in unraised {
        let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
        crate::interrupts::raise_checkpoint(session, &marker, attempt, None)?;
    }
    Ok(())
}

/// The check a Line Ticket's done Outcome passes at its attempt's exit, frozen when it launches:
/// `None` for a Ticket that is not the Line's or runs no agent.
pub fn outcome_check_for(session: &mut Session, marker: &TicketMarker) -> Option<OutcomeCheck> {
    marker.node.as_ref()?;
    let ticket = TicketId::new(marker.id.clone());
    with_run(session, |run, facts| run.outcome_check(&ticket, facts))?
}

// A job over the run and the pool's facts: the run is lent out of the session while the facts read
// the rest of it.
fn with_run<R>(
    session: &mut Session,
    job: impl FnOnce(&mut LineRun, &SessionFacts) -> R,
) -> Option<R> {
    let mut run = session.line.take()?;
    let plan = run.plan().0.clone();
    let out = job(&mut run, &SessionFacts::new(session, &plan));
    session.line = Some(run);
    Some(out)
}

/// A Line Ticket's valid Outcome after its check: a done one whose verdict does not pass is the
/// no-verdict checkpoint (ADR-0037). A checkpoint Outcome stands as the agent wrote it.
pub fn checked(check: Option<&OutcomeCheck>, mut valid: ValidOutcome) -> ValidOutcome {
    let Some(check) = check else {
        return valid;
    };
    if valid.outcome.status != OutcomeStatus::Done {
        return valid;
    }
    let exists = |path: &str| Path::new(path).is_file();
    if let Some(problem) = check.problem(valid.outcome.verdict.as_ref(), &exists) {
        valid.outcome.status = OutcomeStatus::Checkpoint;
        valid.outcome.brief = Some(check.no_verdict_brief(&problem));
    }
    valid
}

/// `LineRun::check_answer` over the pool as it stands: the refusal's words when the Line refuses
/// this answer now (an approval of the Finish while something blocks it, notes on a Finish with no
/// revise edge).
pub fn answer_refusal(
    session: &mut Session,
    ticket_id: &str,
    close: bool,
    note: Option<&str>,
) -> Option<String> {
    let answer = if close {
        HoldAnswer::Closed
    } else {
        HoldAnswer::of_resume(note)
    };
    let ticket = TicketId::new(ticket_id);
    with_run(session, |run, facts| {
        run.check_answer(&ticket, &answer, facts)
    })?
    .err()
    .map(|refusal| refusal.to_string())
}

/// Whether the Steward may answer this Ticket's Interrupt: anything outside the Line, and on the
/// Line only what its frozen Plan gives the Steward (ADR-0039).
pub fn steward_may_answer(session: &Session, ticket_id: &str) -> bool {
    let Some(run) = &session.line else {
        return true;
    };
    let ticket = TicketId::new(ticket_id);
    run.node_of(&ticket).is_none() || run.steward_may_answer(&ticket)
}

/// Whether this Ticket is the Line's Finish hold or Finish Ticket: approving the Line is the
/// operator's.
pub fn is_finish(session: &Session, ticket_id: &str) -> bool {
    session
        .line
        .as_ref()
        .is_some_and(|run| run.node_of(&TicketId::new(ticket_id)) == Some(run.plan().0.finish()))
}

/// Whether what this Ticket or Conversation proposes is held for the operator (ADR-0037): a Line
/// Ticket's spawns are, unless its node says `spawns: land`, and so are the Grill's.
pub fn holds_spawns(session: &Session, parent_id: &str) -> bool {
    if let Some(marker) = session.marker(parent_id)
        && let Some(node) = &marker.node
    {
        let lands = session.line.as_ref().is_some_and(|run| {
            matches!(
                node_body(run.plan().0, node),
                Some(NodeBody::Ticket(t)) if t.spawns == SpawnPolicy::Land
            )
        });
        return !lands;
    }
    crate::conversations::grill_id(session).as_deref() == Some(parent_id)
}

/// The Line's graph with live state, for the snapshot and `GET /api/line`.
pub fn line_view(session: &Session) -> Option<LineGraphView> {
    session.line.as_ref().map(LineRun::view)
}

/// What `POST /api/line` starts the Line on besides its Plan.
pub enum Begin {
    Work(String),
    /// A Line brief's path in the pool checkout.
    Brief(String),
}

/// `POST /api/line {plan, work | brief}`, sent once by Boot: the engine parses the Plan again (its
/// boundary is the one that counts), refuses what this build cannot run and harness names the
/// machine lacks, freezes it in `line.json` and wakes. No Ticket is written here: the first tick
/// projects them.
pub fn begin_line(
    session: &mut Session,
    plan: &Value,
    begin: Begin,
) -> Result<LineGraphView, EngineError> {
    if session.line.is_some() {
        return Err(EngineError::refused(
            "the pool's Line has already begun: a pool runs one Line",
        ));
    }
    let plan = Plan::from_value(plan).map_err(|problems| {
        let problems: Vec<String> = problems.into_iter().map(|p| p.message).collect();
        EngineError::refused(format!(
            "the Line cannot begin: its Plan is not valid: {}",
            problems.join("; ")
        ))
    })?;
    let unsupported = LineRun::unsupported(&plan);
    if !unsupported.is_empty() {
        return Err(EngineError::refused(format!(
            "the Line cannot begin: {}",
            unsupported.join("; ")
        )));
    }
    if let Some(problem) = unknown_harness(session, &plan) {
        return Err(EngineError::refused(format!(
            "the Line cannot begin: {problem}"
        )));
    }
    let places = LinePlaces {
        branch: target_branch(session),
        base: line_base(session)?,
        ..LinePlaces::default()
    };
    let start = match begin {
        Begin::Work(work) => LineStart::Work(work),
        Begin::Brief(path) => LineStart::Brief(checkout_brief(session, &path)?),
    };
    let name = plan.meta().name.clone();
    let run = LineRun::start(plan, places, start)
        .map_err(|why| EngineError::refused(format!("the Line cannot begin: {why}")))?;
    save_line(Path::new(&session.pool_dir), &run).map_err(|error| {
        EngineError::refused(format!("line.json could not be written: {error}"))
    })?;
    let view = run.view();
    session.line = Some(run);
    // A pool that rested empty before the Line began raised a vacuous Review; a Line pool's Review
    // is its Finish.
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
    session.log(format!("line: began on the Plan \"{name}\""));
    session.wake();
    crate::snapshot::emit_snapshot(session, session.current_phase());
    Ok(view)
}

// Every harness a node names must be one this machine knows: a Ticket written on an unknown one
// would fail every Assignment resolution, a boot's too.
fn unknown_harness(session: &Session, plan: &Plan) -> Option<String> {
    plan.nodes().find_map(|node| {
        let assign = match &node.body {
            NodeBody::Conversation(c) => &c.assign,
            NodeBody::Ticket(t) => &t.assign,
            NodeBody::Finish(f) => &f.assign,
            NodeBody::Merger(_) | NodeBody::Gate(_) => return None,
        };
        let harness = assign.harness.as_deref()?;
        (!session.harnesses.contains(harness)).then(|| {
            format!(
                "node {} names unknown harness '{harness}'. Known: {}",
                node.id,
                session.harnesses.known()
            )
        })
    })
}

// A `--brief` path in the pool checkout, read and checked: it and its spec stay in the checkout.
fn checkout_brief(session: &Session, path: &str) -> Result<LineBrief, EngineError> {
    let refused = |why: String| EngineError::refused(format!("Line brief {path}: {why}"));
    if !in_checkout(path) {
        return Err(refused(
            "name it by its path inside the pool checkout".into(),
        ));
    }
    let text = js::read_text(Path::new(&session.cwd).join(path))
        .map_err(|_| refused("not found in the pool checkout".into()))?;
    let brief = LineBrief::parse(&text).map_err(refused)?;
    if let Some(spec) = &brief.spec
        && !(in_checkout(spec) && Path::new(&session.cwd).join(spec).is_file())
    {
        return Err(refused(format!(
            "its spec {spec} is not in the pool checkout"
        )));
    }
    Ok(brief)
}

fn in_checkout(path: &str) -> bool {
    let path = Path::new(js::trim(path));
    !path.as_os_str().is_empty()
        && path.is_relative()
        && path.components().all(|c| {
            matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

// The Line base Boot's Line mode wrote into console.json (issue #193): none in a pool Boot did not
// cut, whose Line reads as cut from main. A malformed one refuses the Line rather than read as main,
// where its PR would land on the wrong shared branch (ADR-0038).
fn line_base(session: &Session) -> Result<Option<ac_protocol::LineBase>, EngineError> {
    let Some(value) = session.state.config.get("lineBase") else {
        return Ok(None);
    };
    line_base_of(value).map(Some).map_err(|why| {
        EngineError::refused(format!(
            "the Line cannot begin: console.json's lineBase is malformed ({why}), and a Line read \
             as cut from main would open its PR against main. Fix it to the {{ ref, commit }} Boot \
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

/// Start the Line on the Grill (the bridge until slice 5): check the Line brief committed on the
/// Grill's branch at the path its pass names, merge that branch into the Line's, and hand the brief
/// to the run as the entry Conversation pass's end, in one stretch so nothing lands between the
/// merge and the pass's end. The caller ends the Grill after, with nothing left to merge. Refused,
/// with the reason and nothing changed, when the pool has no Line, no Conversation pass waits, the
/// id is no live Grill, the brief is missing or invalid, or the merge does not land.
pub fn start_line_from_grill(
    session: &mut Session,
    grill: &str,
) -> Result<LineGraphView, EngineError> {
    let Some(run) = &session.line else {
        return Err(EngineError::refused(
            "the pool runs no Line: Boot begins one with --plan",
        ));
    };
    let Some(pass) = run.grill_pass() else {
        return Err(EngineError::refused(
            "the Line has no Conversation pass waiting for its Grill",
        ));
    };
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
    let path = run.brief_path(&pass.id);
    // The branch's committed tree: work the Grill has not committed never merges, so it never counts.
    let text = git::show_file(&session.cwd, &format!("{branch}:{path}")).ok_or_else(|| {
        EngineError::refused(format!(
            "the Grill's committed branch {branch} has no Line brief at {path}"
        ))
    })?;
    let brief = LineBrief::parse(&text)
        .map_err(|why| EngineError::refused(format!("Line brief {path}: {why}")))?;
    if let Some(problem) = brief_problem(run.plan().0, &brief) {
        return Err(EngineError::refused(format!(
            "Line brief {path}: {problem}"
        )));
    }
    if let Some(spec) = &brief.spec
        && git::show_file(&session.cwd, &format!("{branch}:{spec}")).is_none()
    {
        return Err(EngineError::refused(format!(
            "Line brief {path}: its spec {spec} is not on the Grill's committed branch {branch}"
        )));
    }
    let merged = crate::conversations::merge_into_target(session, &branch);
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
    let Some(run) = session.line.as_mut() else {
        unreachable!("the Line was checked above, in this same job");
    };
    run.apply(LineEvent::ConversationEnded {
        node: pass.node,
        id: pass.id,
        outcome: ConversationOutcome::Briefed(brief),
    })
    .map_err(|refusal| EngineError::refused(refusal.to_string()))?;
    let view = run.view();
    save_line(Path::new(&session.pool_dir), run).map_err(|error| {
        EngineError::refused(format!("line.json could not be written: {error}"))
    })?;
    session.log(format!(
        "line: started from the Grill {grill}'s brief {path}"
    ));
    session.wake();
    crate::snapshot::emit_snapshot(session, session.current_phase());
    Ok(view)
}

/// Where a Decide pass's report is, for `GET /api/line/report?node=&pass=`; why there is none.
pub fn report_path(session: &Session, node: &str, pass: u32) -> Result<String, String> {
    let run = session.line.as_ref().ok_or("the pool runs no Line")?;
    let id = ac_core::plan::NodeId::parse(node)
        .ok()
        .filter(|id| run.plan().0.node(id).is_some())
        .ok_or_else(|| format!("the Line has no node {node}"))?;
    Ok(run.report_path(&id, pass, &session.runs_dir))
}

#[cfg(test)]
mod tests {
    use ac_core::line::run::{LinePlaces, LineRun, LineStart};
    use ac_core::plan::Plan;
    use ac_core::pool::{load_pool_tickets, write_marker_status};
    use ac_protocol::{InterruptKind, ResumeAction, TicketStatus};
    use serde_json::json;

    use crate::error::EngineError;
    use crate::session::Session;

    fn line_pool(dir: &std::path::Path) -> Session {
        let (publisher, _) = tokio::sync::watch::channel(None);
        let mut session = crate::testkit::bare_session(publisher);
        let pool = dir.to_string_lossy().into_owned();
        session.issues_dir = format!("{pool}/issues");
        session.runs_dir = format!("{pool}/runs");
        std::fs::create_dir_all(&session.issues_dir).unwrap();
        std::fs::create_dir_all(&session.runs_dir).unwrap();
        session.answers = ac_core::queued_answers::QueuedAnswerStore::open(std::path::Path::new(
            &session.runs_dir,
        ));
        session.pool_dir = pool;
        let plan = Plan::from_value(&json!({"horde": 1, "name": "build then finish", "nodes": [
            {"kind": "agent", "id": "build", "title": "Build", "x": 0, "y": 0},
            {"kind": "finish", "id": "finish", "title": "Finish", "x": 0, "y": 0}
        ], "edges": [{"from": "build", "on": "done", "to": "finish"}]}))
        .unwrap();
        session.line =
            Some(LineRun::start(plan, LinePlaces::default(), LineStart::Work("w".into())).unwrap());
        session
    }

    fn set_status(session: &mut Session, id: &str, status: TicketStatus) {
        write_marker_status(
            &std::path::Path::new(&session.issues_dir).join(format!("{id}.md")),
            status,
        )
        .unwrap();
        session.markers =
            load_pool_tickets(std::path::Path::new(&session.pool_dir), false).unwrap();
        session.state.tickets.insert(id.to_owned(), status);
    }

    #[test]
    fn a_done_outcome_whose_verdict_does_not_pass_is_the_no_verdict_checkpoint() {
        use ac_core::line::run::OutcomeCheck;
        use ac_protocol::OutcomeStatus;
        let done = |verdict: serde_json::Value| {
            ac_core::outcome::validate_outcome(
                &json!({"status": "done", "summary": "s", "verdict": verdict}),
            )
            .unwrap()
        };
        let bad = super::checked(Some(&OutcomeCheck::Prove), done(json!({"prove": "maybe"})));
        assert_eq!(bad.outcome.status, OutcomeStatus::Checkpoint);
        assert!(bad.outcome.brief.unwrap().starts_with("no verdict\n\n"));
        let good = done(json!({"prove": "pass", "evidence": "e"}));
        assert_eq!(
            super::checked(Some(&OutcomeCheck::Prove), good.clone()),
            good
        );
        let none = done(json!(null));
        assert_eq!(super::checked(None, none.clone()), none);
    }

    #[test]
    fn the_finish_hold_refuses_approval_while_a_ticket_outside_the_line_runs_then_resumes_done() {
        let dir = tempfile::tempdir().unwrap();
        let mut session = line_pool(dir.path());
        super::advance_line(&mut session).unwrap();
        let build = session
            .marker("build-1")
            .expect("the first tick writes build-1");
        assert_eq!(build.node.as_deref(), Some("build"));
        set_status(&mut session, "build-1", TicketStatus::Done);
        std::fs::write(
            format!("{}/02.md", session.issues_dir),
            crate::testkit::ticket_text("02", &[], "ready"),
        )
        .unwrap();
        set_status(&mut session, "02", TicketStatus::Ready);

        super::advance_line(&mut session).unwrap();
        assert!(
            session.marker("finish-1").is_none(),
            "the Finish hold waits for 02"
        );
        set_status(&mut session, "02", TicketStatus::Done);
        super::advance_line(&mut session).unwrap();
        let hold = session.marker("finish-1").expect("the Finish holds");
        assert!(hold.hold);
        assert!(
            session
                .state
                .interrupts
                .iter()
                .any(|i| i.ticket_id == "finish-1" && i.kind == InterruptKind::Checkpoint)
        );

        set_status(&mut session, "02", TicketStatus::Ready);
        let refused = crate::answers::accept_answer(
            &mut session,
            "finish-1",
            None,
            ResumeAction::Resume,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(
            refused,
            EngineError::LineRefusal("answer: the Finish is waiting for: 02".into())
        );

        set_status(&mut session, "02", TicketStatus::Done);
        let record = crate::answers::accept_answer(
            &mut session,
            "finish-1",
            Some("Approved.".into()),
            ResumeAction::Resume,
            None,
            None,
        )
        .unwrap();
        crate::answers::process_answer(&mut session, &record).unwrap();
        let text = std::fs::read_to_string(format!("{}/finish-1.md", session.issues_dir)).unwrap();
        assert!(text.starts_with("<!-- state: id=finish-1 blocked-by=build-1 status=done"));
        assert!(text.ends_with("\n## Resume note\n\nApproved.\n"));
        super::advance_line(&mut session).unwrap();
        assert!(
            super::line_ended(&session),
            "an approval with act none ends the Line"
        );
    }

    #[test]
    fn a_steward_resume_with_no_note_on_a_hold_still_reads_as_the_stewards() {
        let dir = tempfile::tempdir().unwrap();
        let mut session = line_pool(dir.path());
        super::advance_line(&mut session).unwrap();
        set_status(&mut session, "build-1", TicketStatus::Done);
        super::advance_line(&mut session).unwrap();
        let record = crate::answers::accept_answer(
            &mut session,
            "finish-1",
            None,
            ResumeAction::Resume,
            None,
            Some("conv-9"),
        )
        .unwrap();
        crate::answers::process_answer(&mut session, &record).unwrap();
        let file = std::path::Path::new(&session.issues_dir).join("finish-1.md");
        assert_eq!(super::last_resume_note(&file), (None, true));
    }
}
