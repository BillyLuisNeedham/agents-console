//! The pool's Line (ADR-0039): the shell around `ac_core::line::run`. The tick's Line step reads the
//! pool into `LineFacts`, advances the run, saves `line.json` and only then writes what the run
//! projects, each file create-if-absent by its id, and opens each Conversation pass it names. Line
//! start, the Outcome check at an attempt's exit and the answer check on a Line Ticket all come
//! through here.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

use ac_core::assignment::{engine_ticket_build_id, resolve_unseen_assignments};
use ac_core::conversation_record::ConversationRecord;
use ac_core::events::{last_attempt, read_events};
use ac_core::js;
use ac_core::line::run::{
    Blocker, ConversationFact, Editor, HoldAnswer, Item, LineBrief, LineFacts, LinePlaces, LineRun,
    LineStart, LineStatus, OutcomeCheck, TicketFact, TicketId, brief_problem, hold_text,
    plan_claims_id, ticket_text, verdict_of,
};
use ac_core::line::{brief_path, line_base_of, save_line};
use ac_core::outcome::ValidOutcome;
use ac_core::plan::{Conflict, MergerNode, NodeBody, Plan, PlanEdit, SpawnPolicy};
use ac_core::pool::{TicketMarker, load_pool_tickets};
use ac_io::git;
use ac_protocol::{
    ConversationStatus, InterruptKind, LineGraphView, LinePlanEditResponse, Outcome, OutcomeStatus,
    TicketEventKind, TicketStatus,
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
    /// The Line's branch, which names its briefs.
    branch: String,
    unlanded: Vec<String>,
    /// Each pass's brief as the merge target has it, read once per advance.
    briefs: RefCell<HashMap<String, Option<LineBrief>>>,
}

impl<'a> SessionFacts<'a> {
    fn new(session: &'a mut Session, plan: &'a Plan, branch: String) -> Self {
        let unlanded = crate::merges::merge_hold(session);
        SessionFacts {
            session,
            plan,
            branch,
            unlanded,
            briefs: RefCell::default(),
        }
    }

    // The pass's brief on the merge target, valid for the Plan: its End merged. The brief path
    // carries the pass id, so nothing else puts one there.
    fn merged_brief(&self, id: &str) -> Option<LineBrief> {
        if let Some(read) = self.briefs.borrow().get(id) {
            return read.clone();
        }
        let session = self.session;
        let read = session
            .git
            .then(|| {
                let target = crate::merges::merge_target_branch(session);
                let path = brief_path(&self.branch, id);
                git::show_file(&session.cwd, &format!("{target}:{path}"))
            })
            .flatten()
            .and_then(|text| LineBrief::parse(&text).ok())
            .filter(|brief| brief_problem(self.plan, brief).is_none());
        self.briefs.borrow_mut().insert(id.to_owned(), read.clone());
        read
    }

    // The scheduler's merged rule (drive.rs `merged`): a hold, an engine-run Ticket and every
    // Ticket outside git have no branch to merge.
    fn merged(&self, marker: &TicketMarker) -> bool {
        marker.hold
            || engine_ticket_build_id(&marker.id).is_some()
            || !self.session.git
            || !self.unlanded.contains(&marker.id)
    }

    fn items(&self, marker: &TicketMarker) -> Vec<Item> {
        let outcome = self.session.state.outcomes.get(&marker.id);
        let items = outcome.and_then(|o| o.items.as_deref()).unwrap_or_default();
        items
            .iter()
            .map(|item| Item {
                title: item.title.clone(),
                body: item.body.clone(),
            })
            .collect()
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
                    items: self.items(marker),
                    merged: self.merged(marker),
                },
                None => TicketFact::Live,
            },
            _ => TicketFact::Live,
        }
    }

    fn conversation(&self, id: &TicketId) -> ConversationFact {
        let session = self.session;
        let id = id.as_str();
        let record = crate::conversations::record_of(session, id);
        let merged = record.as_ref().and_then(|_| self.merged_brief(id));
        conversation_fact(
            record.as_ref(),
            crate::conversations::is_reserved(session, id),
            merged,
            |kind, key| {
                read_events(Path::new(&session.runs_dir), id)
                    .iter()
                    .rfind(|e| e.kind == kind)
                    .and_then(|e| e.payload.get(key))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            },
        )
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

/// A Conversation pass as the pool shows it: a brief merged into the Line's branch is its end
/// whatever the record says; else no record and no start in flight is unopened, a live record or a
/// start in flight is open, and a crashed or ended one is closed, with the crash's reason or the End's
/// closing note.
fn conversation_fact(
    record: Option<&ConversationRecord>,
    reserved: bool,
    merged: Option<LineBrief>,
    last_said: impl Fn(TicketEventKind, &str) -> Option<String>,
) -> ConversationFact {
    if let Some(brief) = merged {
        return ConversationFact::Ended {
            brief,
            merged: true,
        };
    }
    let Some(record) = record else {
        return if reserved {
            ConversationFact::Open
        } else {
            ConversationFact::Unopened
        };
    };
    match record.status {
        ConversationStatus::Live => ConversationFact::Open,
        ConversationStatus::Crashed => ConversationFact::Closed {
            why: last_said(TicketEventKind::Crash, "reason").unwrap_or_else(|| "crashed".into()),
        },
        ConversationStatus::Ended => ConversationFact::Closed {
            why: last_said(TicketEventKind::Ended, "closing")
                .unwrap_or_else(|| "ended as closed".into()),
        },
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
    let mut refused = false;
    for pass in &effects.conversations {
        refused |= !open_pass(session, pass);
    }
    raise_unraised_holds(session)?;
    // A refused pass's crashed record is a fact this tick must absorb: a drive that closes on it
    // would never be woken to read it.
    if refused {
        return advance_line(session);
    }
    Ok(())
}

// A Conversation pass opens on the id the Line named, reserved in this job so the next tick reads it
// open. A start that cannot be had is recorded crashed, which hands the pass on closed, and answers
// false; so is one whose launch never got a pane, and the drive wakes once that start is over.
fn open_pass(session: &mut Session, pass: &ac_core::line::run::NewConversation) -> bool {
    let id = pass.id.to_string();
    let prepared = match crate::conversations::prepare_pass(session, pass) {
        Ok(prepared) => prepared,
        Err(err) => {
            session.log(format!("line: {id} did not open: {}", err.message()));
            crate::conversations::record_refused_pass(session, pass, err.message());
            return false;
        }
    };
    session.log(format!("line: {id} opens"));
    let engine = session.engine();
    tokio::spawn(async move {
        let started = crate::conversations::launch_prepared(&engine, prepared).await;
        let _ = engine
            .call(move |s| {
                if let Err(err) = started {
                    s.log(format!("line: {id} did not open: {}", err.message()));
                }
                s.wake();
            })
            .await;
    });
    true
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
    let branch = run.places.branch.clone();
    let out = job(&mut run, &SessionFacts::new(session, &plan, branch));
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
/// Ticket's spawns are, unless its node says `spawns: land`, and so are a Line Conversation pass's.
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
    crate::conversations::record_of(session, parent_id).is_some_and(|rec| rec.node.is_some())
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
/// boundary is the one that counts), refuses harness names the machine lacks (a node's or a
/// Merger's resolver), freezes it in `line.json` and wakes. No Ticket is written here: the first tick
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
    if let Some(problem) = unknown_harness(session, &plan) {
        return Err(EngineError::refused(format!(
            "the Line cannot begin: {problem}"
        )));
    }
    let taken = ids_the_line_would_write(session, &plan);
    if !taken.is_empty() {
        return Err(EngineError::refused(format!(
            "the Line cannot begin: the pool already holds {}, which the Line would write as its own",
            taken.join(", ")
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

/// `line.plan.edit` and the Steward's `POST /api/steward/plan` (ADR-0039): the edit is made on a
/// copy of the run and saved before it replaces the live one, so a refusal or an unwritable
/// `line.json` leaves the Line as it was. The next tick writes what the edit handed on.
pub fn edit_plan(
    session: &mut Session,
    by: Editor,
    base_rev: u64,
    edits: &[PlanEdit],
) -> Result<LinePlanEditResponse, EngineError> {
    let Some(run) = &session.line else {
        return Err(EngineError::LineRefusal("this pool runs no Line".into()));
    };
    let mut next = run.clone();
    let notes = next
        .edit(by, base_rev, edits)
        .map_err(|refusal| EngineError::LineRefusal(refusal.to_string()))?;
    let (plan, rev) = next.plan();
    if let Some(problem) = unknown_harness(session, plan) {
        return Err(EngineError::LineRefusal(problem));
    }
    if rev != run.plan().1 {
        save_line(Path::new(&session.pool_dir), &next).map_err(|error| {
            EngineError::LineRefusal(format!("line.json could not be written: {error}"))
        })?;
        session.line = Some(next);
        let who = match by {
            Editor::Operator => "the operator".to_owned(),
            Editor::Steward => format!(
                "the Steward ({})",
                crate::conversations::steward_id(session).unwrap_or_default()
            ),
        };
        session.log(format!("line: {who} edited the Plan: rev {rev}"));
        session.wake();
        crate::snapshot::emit_snapshot(session, session.current_phase());
    }
    Ok(LinePlanEditResponse { rev, notes })
}

// The Tickets and Conversations already in the pool under an id the Line writes create-if-absent,
// which the Line would take for its own pass.
fn ids_the_line_would_write(session: &Session, plan: &Plan) -> Vec<String> {
    let tickets = session.markers.iter().map(|marker| marker.id.clone());
    let conversations = crate::conversations::load(session)
        .into_iter()
        .map(|record| record.id);
    tickets
        .chain(conversations)
        .filter(|id| plan_claims_id(plan, id))
        .collect()
}

// Every harness a node names must be one this machine knows: a Ticket written on an unknown one
// would fail every Assignment resolution, a boot's too.
fn unknown_harness(session: &Session, plan: &Plan) -> Option<String> {
    plan.nodes().find_map(|node| {
        let assign = match &node.body {
            NodeBody::Conversation(c) => &c.assign,
            NodeBody::Ticket(t) => &t.assign,
            NodeBody::Finish(f) => &f.assign,
            NodeBody::Merger(MergerNode {
                conflict: Conflict::Resolver(assign),
                ..
            }) => assign,
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
    fn a_mergers_resolver_harness_is_checked_at_line_start_like_a_nodes() {
        let (publisher, _) = tokio::sync::watch::channel(None);
        let session = crate::testkit::bare_session(publisher);
        let plan = |harness: &str| {
            Plan::from_value(&json!({"horde": 1, "name": "p", "nodes": [
                {"kind": "agent", "id": "build", "title": "B", "x": 0, "y": 0,
                 "copies": {"perItem": 2}},
                {"kind": "merger", "id": "m", "title": "M", "x": 0, "y": 0, "of": "build",
                 "conflict": {"resolver": {"harness": harness}}},
                {"kind": "finish", "id": "finish", "title": "F", "x": 0, "y": 0}
            ], "edges": [
                {"from": "build", "on": "done", "to": "m"},
                {"from": "m", "on": "done", "to": "finish"}
            ]}))
            .unwrap()
        };
        assert_eq!(super::unknown_harness(&session, &plan("claude")), None);
        let problem = super::unknown_harness(&session, &plan("nonesuch")).unwrap();
        assert!(
            problem.starts_with("node m names unknown harness 'nonesuch'"),
            "{problem}"
        );
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
    fn a_conversation_pass_reads_as_its_merged_brief_else_as_its_record() {
        use ac_core::conversation_record::ConversationRecord;
        use ac_core::line::run::{ConversationFact, LineBrief};
        use ac_protocol::{ConversationStatus, TicketEventKind};
        let record = |status| ConversationRecord {
            id: "grill-1".into(),
            file: "grill-1.md".into(),
            title: "Grill, pass 1".into(),
            opening: String::new(),
            status,
            spawned_by: None,
            harness: "claude".into(),
            model: "opus".into(),
            effort: None,
            drivers: "my-grill-with-docs".into(),
            enlisted: None,
            role: None,
            node: Some("grill".into()),
        };
        let brief = LineBrief::parse(r#"{"spec": "docs/specs/x.md"}"#).unwrap();
        let said = |kind: TicketEventKind, key: &str| match (kind, key) {
            (TicketEventKind::Crash, "reason") => Some("pane lost without End (pane-gone)".into()),
            _ => None,
        };
        let silent = |_: TicketEventKind, _: &str| None;
        let ended = |rec: Option<&ConversationRecord>| {
            super::conversation_fact(rec, false, Some(brief.clone()), silent)
        };
        let merged = ConversationFact::Ended {
            brief: brief.clone(),
            merged: true,
        };
        assert_eq!(ended(Some(&record(ConversationStatus::Ended))), merged);
        assert_eq!(ended(Some(&record(ConversationStatus::Live))), merged);
        assert_eq!(
            super::conversation_fact(None, false, None, silent),
            ConversationFact::Unopened
        );
        assert_eq!(
            super::conversation_fact(None, true, None, silent),
            ConversationFact::Open
        );
        let live = record(ConversationStatus::Live);
        assert_eq!(
            super::conversation_fact(Some(&live), false, None, silent),
            ConversationFact::Open
        );
        let crashed = record(ConversationStatus::Crashed);
        assert_eq!(
            super::conversation_fact(Some(&crashed), false, None, said),
            ConversationFact::Closed {
                why: "pane lost without End (pane-gone)".into()
            }
        );
        assert_eq!(
            super::conversation_fact(Some(&crashed), false, None, silent),
            ConversationFact::Closed {
                why: "crashed".into()
            }
        );
        let closed = record(ConversationStatus::Ended);
        assert_eq!(
            super::conversation_fact(Some(&closed), false, None, silent),
            ConversationFact::Closed {
                why: "ended as closed".into()
            }
        );
        assert_eq!(
            super::conversation_fact(Some(&closed), false, None, |_, key| {
                (key == "closing").then(|| "not worth doing".into())
            }),
            ConversationFact::Closed {
                why: "not worth doing".into()
            }
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
