use std::path::Path;
use std::sync::Arc;

use futures::future::join_all;
use serde_json::{Map, Value};
use tokio::sync::oneshot;

use ac_core::assignment::{Assignment, engine_ticket_build_id};
use ac_core::events::{append_event, attempt_log_name, event_now, last_attempt, next_attempt};
use ac_core::machine_defaults::read_machine_defaults;
use ac_core::max_live::max_live_of;
use ac_core::pool::{TicketMarker, is_finished, write_marker_status};
use ac_io::git;
use ac_protocol::{AttemptRole, InterruptKind, RunPhase, SpawnKind, TicketEventKind, TicketStatus};

use crate::actor::Engine;
use crate::checkout_gate::{hold_pool_checkout, release_pool_checkout};
use crate::error::EngineError;
use crate::interrupts::{interrupt, land_checkpoint_brief, raise_checkpoint, raise_interrupt};
use crate::merges::{chain_ticket_merge, in_merge_chain, merge_hold, merge_target_sha};
use crate::persist::{close_store, persist, persist_with_retry, retry_persist, write_markers};
use crate::session::{PoolState, PoolUpdate, Session};
use crate::snapshot::emit_snapshot;
use crate::spawns::spawns_await_tick;
use crate::tickets::{
    CandidateEnding, TicketEnv, TicketPlan, TicketResult, attempt_env_of, plan_ticket, run_ticket,
};

pub const SHUTDOWN_SETTLE_WAIT_MS: u64 = 3_000;

pub const SHUTDOWN_LINE: &str =
    "engine shutdown: no crash interrupts raised and nothing more launched";

pub fn start_drive(session: &mut Session) {
    session.driving = true;
    if session.emitted == 0 {
        emit_snapshot(session, RunPhase::Running);
    }
    let engine = session.engine();
    tokio::spawn(async move {
        if let Err(error) = drive_loop(&engine).await {
            let message = error.to_string();
            let _ = engine.call(move |s| report_drive_death(s, &message)).await;
        }
    });
}

impl Session {
    pub fn wake(&mut self) {
        self.wakes.ring();
        if self.driving {
            self.wake.notify_one();
        } else if self.drive_startable() {
            start_drive(self);
        }
    }

    pub fn drive_startable(&self) -> bool {
        !self.driving && self.store_open && !self.children.stopping
    }
}

/// The boot's drive has reached its first real wait, or settled: start_pool may return.
pub fn drive_turned(session: &mut Session) {
    if let Some(turned) = session.first_turn.take() {
        session.publish_now();
        let _ = turned.send(());
    }
}

/// What `nextSettle` hands back: the phase now when no drive is in flight, or a wait for the next
/// settle.
pub enum Settle {
    Now(RunPhase),
    Wait(oneshot::Receiver<Result<RunPhase, EngineError>>),
}

/// `nextSettle`: the phase at the drive's next settle, at once when no drive is in flight.
pub fn next_settle(session: &mut Session) -> Settle {
    if !session.driving {
        return Settle::Now(session.idle_phase());
    }
    let (tx, rx) = oneshot::channel();
    session.settle_waiters.push(tx);
    Settle::Wait(rx)
}

impl Settle {
    /// The settled phase, waited for when the drive is in flight.
    pub async fn phase(self) -> Result<RunPhase, EngineError> {
        match self {
            Settle::Now(phase) => Ok(phase),
            Settle::Wait(rx) => rx.await.unwrap_or(Err(EngineError::refused(
                crate::actor::EngineGone::Stopped.to_string(),
            ))),
        }
    }
}

/// `settleDrive`: the drive loop's endgame, reached exactly once per loop. Waiters for the next settle
/// get the phase, or the loop's fatal error, which also fails every answer still waiting on
/// processing.
pub fn settle_drive(session: &mut Session, phase: Option<RunPhase>, error: Option<&str>) {
    session.driving = false;
    if let Some(phase) = phase {
        session.settled_phase = Some(phase);
    }
    let settled = session.idle_phase();
    session.publish_now();
    for waiter in session.settle_waiters.drain(..) {
        let _ = waiter.send(match error {
            Some(error) => Err(EngineError::refused(error)),
            None => Ok(settled),
        });
    }
    if let Some(error) = error {
        for (_, waiters) in session.answer_waiters.drain() {
            for waiter in waiters {
                let _ = waiter.send(Err(EngineError::refused(error)));
            }
        }
    }
}

/// `reportDriveDeath`: the durable record of a drive death (runs/errors.jsonl), the pool log line the
/// Console shows, the store closed, the `dead` emit, and the settle. Every part is best-effort but the
/// settle, so a dead drive never hangs a waiter.
pub fn report_drive_death(session: &mut Session, message: &str) {
    let _ = ac_core::drive_errors::record_drive_death(Path::new(&session.runs_dir), message, None);
    session.log(format!("pool dead: {message}"));
    close_store(session);
    emit_snapshot(session, RunPhase::Dead);
    settle_drive(session, Some(RunPhase::Dead), Some(message));
    drive_turned(session);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Eligibility {
    Start,
    Wait(WaitWhy),
    Checkpoint(CheckpointWhy),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitWhy {
    NotReady,
    Hold,
    EngineRun,
    Live,
    BlockerNotDone(String),
    BlockerNotMerged(String),
    PoolFull { live: u64, max: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointWhy {
    MissingAssignment(&'static str),
    BranchHeldAt(String),
}

pub trait PoolFacts {
    fn status(&self, id: &str) -> Option<TicketStatus>;
    fn is_hold(&self, id: &str) -> bool;
    fn is_live(&self, id: &str) -> bool;
    fn in_git(&self) -> bool;
    fn landed(&mut self, id: &str) -> bool;
    fn live_count(&self) -> u64;
    fn max_live(&mut self) -> Option<u64>;
    fn need(&self, marker: &TicketMarker) -> u64;
    fn missing_assignment(&self, id: &str) -> Option<&'static str>;
    fn branch_held_at(&mut self, marker: &TicketMarker) -> Option<String>;
}

pub fn merged(facts: &mut impl PoolFacts, id: &str) -> bool {
    if facts.is_hold(id) || engine_ticket_build_id(id).is_some() || !facts.in_git() {
        return true;
    }
    facts.landed(id)
}

pub fn eligibility(facts: &mut impl PoolFacts, marker: &TicketMarker) -> Eligibility {
    let id = marker.id.as_str();
    if facts.status(id) != Some(TicketStatus::Ready) {
        return Eligibility::Wait(WaitWhy::NotReady);
    }
    if facts.is_hold(id) {
        return Eligibility::Wait(WaitWhy::Hold);
    }
    if engine_ticket_build_id(id).is_some() {
        return Eligibility::Wait(WaitWhy::EngineRun);
    }
    if facts.is_live(id) {
        return Eligibility::Wait(WaitWhy::Live);
    }
    if let Some(blocker) = marker
        .blocked_by
        .iter()
        .find(|b| facts.status(b) != Some(TicketStatus::Done))
    {
        return Eligibility::Wait(WaitWhy::BlockerNotDone(blocker.clone()));
    }
    if let Some(blocker) = marker.blocked_by.iter().find(|b| !merged(facts, b)) {
        return Eligibility::Wait(WaitWhy::BlockerNotMerged(blocker.clone()));
    }
    // With nothing live a Ticket always starts, so a verify round wider than the bound still runs.
    if let Some(max) = facts.max_live() {
        let live = facts.live_count();
        if live > 0 && live + facts.need(marker) > max {
            return Eligibility::Wait(WaitWhy::PoolFull { live, max });
        }
    }
    if let Some(missing) = facts.missing_assignment(id) {
        return Eligibility::Checkpoint(CheckpointWhy::MissingAssignment(missing));
    }
    if let Some(at) = facts.branch_held_at(marker) {
        return Eligibility::Checkpoint(CheckpointWhy::BranchHeldAt(at));
    }
    Eligibility::Start
}

struct SessionFacts<'a> {
    session: &'a mut Session,
    unlanded: &'a mut Option<Vec<String>>,
    max_live: &'a mut Option<Option<u64>>,
}

impl PoolFacts for SessionFacts<'_> {
    fn status(&self, id: &str) -> Option<TicketStatus> {
        self.session.status_of(id)
    }

    fn is_hold(&self, id: &str) -> bool {
        self.session.marker(id).is_some_and(|m| m.hold)
    }

    fn is_live(&self, id: &str) -> bool {
        self.session.live_attempts.is_live(id)
            || self.session.adopted.contains_key(id)
            || self.session.continued.contains_key(id)
    }

    fn in_git(&self) -> bool {
        self.session.git
    }

    fn landed(&mut self, id: &str) -> bool {
        let session = &mut *self.session;
        !self
            .unlanded
            .get_or_insert_with(|| merge_hold(session))
            .iter()
            .any(|held| held == id)
    }

    fn live_count(&self) -> u64 {
        live_ticket_attempts(self.session)
    }

    fn max_live(&mut self) -> Option<u64> {
        let session = &*self.session;
        *self
            .max_live
            .get_or_insert_with(|| max_live_in_force(session))
    }

    fn need(&self, marker: &TicketMarker) -> u64 {
        verify_of(self.session, marker).unwrap_or(1)
    }

    fn missing_assignment(&self, id: &str) -> Option<&'static str> {
        let assignment = self.session.assignments.get(id);
        if assignment.is_none_or(|a| a.harness.is_empty()) {
            return Some("harness");
        }
        if assignment.is_none_or(|a| a.model.is_empty()) {
            return Some("model");
        }
        None
    }

    fn branch_held_at(&mut self, marker: &TicketMarker) -> Option<String> {
        held_branch_directory(self.session, marker)
    }
}

/// The Ticket Attempts `maxLive` counts (ADR-0041): every Candidate and plain Attempt from its launch
/// to its exit, every resolver, and every Continued or boot-adopted Attempt. Conversations, enlisted
/// panes, graders and head-to-head judges are not counted.
pub fn live_ticket_attempts(session: &Session) -> u64 {
    let enlisted = |id: &String| {
        session
            .marker(id)
            .is_some_and(|m| m.enlisted_from.is_some())
    };
    let launched = session.launched.iter().filter(|id| !enlisted(id)).count();
    let resolvers = session.live_attempts.count_of(AttemptRole::Resolver);
    let continued = session.continued.keys().filter(|id| !enlisted(id)).count();
    let adopted = session
        .adopted
        .keys()
        .filter(|id| !enlisted(id) && !session.continued.contains_key(*id))
        .count();
    (launched + resolvers + continued + adopted) as u64
}

/// The pool's `maxLive`, else the Machine default's, read afresh each Tick.
fn max_live_in_force(session: &Session) -> Option<u64> {
    max_live_of(&session.state.config)
        .or_else(|| read_machine_defaults(&session.machine_defaults).max_live)
}

fn verify_of(session: &Session, marker: &TicketMarker) -> Option<u64> {
    if marker.enlisted_from.is_some() {
        return None;
    }
    session.assignments.get(&marker.id).and_then(|a| a.verify)
}

// Where a ticket's solo branch is checked out, when that is somewhere other than its own pool
// worktree (issue #101).
fn held_branch_directory(session: &Session, marker: &TicketMarker) -> Option<String> {
    if !session.git || verify_of(session, marker).is_some() {
        return None;
    }
    if !git::branch_exists(&session.cwd, &marker.id, None) {
        return None;
    }
    let at = git::branch_checked_out_at(
        &session.cwd,
        &git::branch_for(&session.cwd, &marker.id, None),
    )?;
    if at == git::worktree_path_for(&session.cwd, &marker.id, None) {
        return None;
    }
    Some(at)
}

fn checkpoint_unassigned(
    session: &mut Session,
    marker: &TicketMarker,
    missing: &str,
) -> anyhow::Result<()> {
    let runs = Path::new(&session.runs_dir).to_path_buf();
    let attempt = last_attempt(&runs, &marker.id);
    let mut payload = Map::new();
    payload.insert("missing".into(), Value::String(missing.to_owned()));
    append_event(
        &runs,
        &marker.id,
        &event_now(attempt, TicketEventKind::Unassigned, payload),
    )?;
    write_marker_status(&marker.file, TicketStatus::Checkpoint)?;
    if let Some(m) = session.marker_mut(&marker.id) {
        m.status = TicketStatus::Checkpoint;
    }
    let id = &marker.id;
    let body = format!(
        "ticket {id} has no {missing}: set one in console.json (an assign entry for {id}, or \
         defaults.{missing}) and answer resume. The pool reloads console.json at the next Tick and \
         schedules the ticket on what it finds."
    );
    land_checkpoint_brief(&marker.file, Some(&body))?;
    raise_interrupt(session, interrupt(id, InterruptKind::Config, body));
    session.apply(PoolUpdate {
        tickets: Some(
            [(id.clone(), TicketStatus::Checkpoint)]
                .into_iter()
                .collect(),
        ),
        log: Some(vec![format!(
            "ticket {id}: no {missing}; config interrupt raised instead of a launch"
        )]),
        ..PoolUpdate::default()
    });
    Ok(())
}

fn checkpoint_held_branch(
    session: &mut Session,
    marker: &TicketMarker,
    at: &str,
) -> anyhow::Result<()> {
    let branch = git::branch_for(&session.cwd, &marker.id, None);
    let runs = Path::new(&session.runs_dir).to_path_buf();
    let attempt = last_attempt(&runs, &marker.id);
    let mut payload = Map::new();
    payload.insert("branch".into(), Value::String(branch.clone()));
    payload.insert("directory".into(), Value::String(at.to_owned()));
    append_event(
        &runs,
        &marker.id,
        &event_now(attempt, TicketEventKind::BranchHeld, payload),
    )?;
    write_marker_status(&marker.file, TicketStatus::Checkpoint)?;
    if let Some(m) = session.marker_mut(&marker.id) {
        m.status = TicketStatus::Checkpoint;
    }
    land_checkpoint_brief(
        &marker.file,
        Some(&format!(
            "This ticket's branch {branch} is checked out in {at} (the checkout an enlist moved onto \
             it, or a worktree made by hand), so the engine cannot open a worktree to run the ticket \
             while it is there. The work on the branch is kept. Check another branch out in that \
             directory and answer resume: the run then continues on the parked branch as an ordinary \
             engine-launched attempt."
        )),
    )?;
    let mut checkpointed = marker.clone();
    checkpointed.status = TicketStatus::Checkpoint;
    raise_checkpoint(session, &checkpointed, attempt, None)?;
    session.apply(PoolUpdate {
        tickets: Some(
            [(marker.id.clone(), TicketStatus::Checkpoint)]
                .into_iter()
                .collect(),
        ),
        log: Some(vec![format!(
            "ticket {}: branch {branch} is checked out in {at}; checkpoint raised instead of a re-run",
            marker.id
        )]),
        ..PoolUpdate::default()
    });
    Ok(())
}

pub struct Launch {
    pub marker: TicketMarker,
    pub plans: Vec<TicketPlan>,
    pub assignment: Assignment,
    pub env: TicketEnv,
    pub snapshot: Arc<PoolState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    Wait,
    Close,
}

pub struct Tick {
    pub launches: Vec<Launch>,
    pub next: Next,
    pub changed: bool,
}

pub async fn drive_loop(engine: &Engine) -> anyhow::Result<()> {
    let mut reconcile = engine.call(|s| s.terminal_reconcile.clone()).await?;
    if !*reconcile.borrow() {
        engine.call(drive_turned).await?;
    }
    let _ = reconcile.wait_for(|done| *done).await;
    let wake = engine.call(|s| Arc::clone(&s.wake)).await?;
    loop {
        let (stopping, running) = engine
            .call(|s| (s.children.stopping, !s.launched.is_empty()))
            .await?;
        if stopping && !running {
            break;
        }
        if stopping {
            wake.notified().await;
            continue;
        }
        let Tick {
            launches,
            next,
            changed,
        } = engine.call(tick).await??;
        let refused = if changed {
            engine.call(persist).await?.err()
        } else {
            None
        };
        for launch in launches {
            tokio::spawn(run_launch(engine.clone(), launch));
        }
        if let Some(refused) = refused {
            retry_persist(engine, refused).await?;
        }
        if next == Next::Close {
            break;
        }
        wake.notified().await;
    }
    close_drive(engine).await
}

fn persistence_pending(session: &Session) -> bool {
    session
        .state
        .interrupts
        .iter()
        .any(|i| i.kind == InterruptKind::Persistence)
}

const TICK_STEPS: [fn(&mut Session) -> anyhow::Result<()>; 6] = [
    crate::config_reload::reload_config,
    crate::answers::drain_answers,
    crate::interrupts::reconcile_deadlocks,
    // After the spawns land, are held or are refused: the Finish reads what it waits for from them,
    // and a drive that closes on this tick would never read them again.
    crate::spawns::adopt_spawn_proposals,
    crate::line::advance_line,
    start_owed_grading,
];

pub fn tick(session: &mut Session) -> anyhow::Result<Tick> {
    if let Some(failure) = session.drive_failure.take() {
        anyhow::bail!(failure);
    }
    let before = serde_json::to_value(&session.state)?;
    let line_before = session.line.clone();
    for step in TICK_STEPS {
        step(session)?;
    }
    let held = persistence_pending(session);
    let launches = if held {
        Vec::new()
    } else {
        launch_eligible(session)?
    };
    let state = serde_json::to_value(&session.state)?;
    let close = launches.is_empty()
        && session.launched.is_empty()
        && session.merge_line.unsettled().is_empty()
        && session.grading == 0
        && session.continued_grades.is_empty()
        && !spawns_await_tick(session)
        && merge_hold(session).is_empty();
    // line.json is saved by its step; a change to the run alone still persists and emits.
    let line_moved = session.line != line_before;
    let stirred = state != before || line_moved || !launches.is_empty() || !close;
    if stirred {
        emit_snapshot(session, RunPhase::Running);
    }
    drive_turned(session);
    session.wakes.see_all();
    Ok(Tick {
        launches,
        next: if close { Next::Close } else { Next::Wait },
        changed: !held && (line_moved || session.persisted.as_ref() != Some(&state)),
    })
}

fn launch_eligible(session: &mut Session) -> anyhow::Result<Vec<Launch>> {
    let mut unlanded = None;
    let mut max_live = None;
    let mut launches = Vec::new();
    for index in 0..session.markers.len() {
        let marker = session.markers[index].clone();
        let verdict = eligibility(
            &mut SessionFacts {
                session,
                unlanded: &mut unlanded,
                max_live: &mut max_live,
            },
            &marker,
        );
        match verdict {
            Eligibility::Start => launches.push(plan_launch(session, &marker)?),
            Eligibility::Checkpoint(CheckpointWhy::MissingAssignment(missing)) => {
                checkpoint_unassigned(session, &marker, missing)?;
            }
            Eligibility::Checkpoint(CheckpointWhy::BranchHeldAt(at)) => {
                checkpoint_held_branch(session, &marker, &at)?;
            }
            Eligibility::Wait(_) => {}
        }
    }
    Ok(launches)
}

fn plan_launch(session: &mut Session, marker: &TicketMarker) -> anyhow::Result<Launch> {
    let runs = Path::new(&session.runs_dir).to_path_buf();
    let verify = verify_of(session, marker);
    if verify.is_some() {
        ac_core::streamlog::rotate_attempt_log(
            &runs,
            &marker.id,
            &runs.join(attempt_log_name(&marker.id, None, false)),
            TicketEventKind::Exited,
        )?;
    }
    let first = next_attempt(&runs, &marker.id);
    let count = verify.unwrap_or(1);
    let mut plans = Vec::new();
    for attempt in first..first + count {
        plans.push(plan_ticket(session, marker, attempt, verify.is_some())?);
    }
    let id = &marker.id;
    let line = if session.git {
        let tip = merge_target_sha(session);
        format!("start {id} at {}", tip.get(..7).unwrap_or(&tip))
    } else {
        format!("start {id}")
    };
    session.apply(PoolUpdate {
        tickets: Some(
            [(id.clone(), TicketStatus::InProgress)]
                .into_iter()
                .collect(),
        ),
        log: Some(vec![line]),
        ..PoolUpdate::default()
    });
    write_markers(session)?;
    for plan in &plans {
        append_event(
            &runs,
            id,
            &event_now(plan.attempt, TicketEventKind::Scheduled, Map::new()),
        )?;
        session.launched.push(id.clone());
    }
    if let Some(expected) = verify {
        session.verify_groups.insert(
            id.clone(),
            VerifyGroup {
                expected: expected as usize,
                ended: Vec::new(),
                flow: false,
            },
        );
    }
    Ok(Launch {
        marker: marker.clone(),
        plans,
        assignment: session.assignments.get(id).cloned().unwrap_or_default(),
        env: TicketEnv {
            engine: session.engine(),
            attempt: attempt_env_of(session, None),
            pool_dir: session.pool_dir.clone(),
            issues_dir: session.issues_dir.clone(),
        },
        snapshot: Arc::new(session.state.clone()),
    })
}

async fn run_launch(engine: Engine, launch: Launch) {
    let Launch {
        marker,
        plans,
        assignment,
        env,
        snapshot,
    } = launch;
    crate::terminals::close_checkpointed_tabs(&engine, std::slice::from_ref(&marker)).await;
    let runs = plans.into_iter().map(|plan| {
        let (engine, marker, assignment, env, snapshot) =
            (&engine, marker.clone(), &assignment, &env, &snapshot);
        async move {
            let id = marker.id.clone();
            let result = run_ticket(marker, snapshot, assignment, env, plan)
                .await
                .map_err(|error| error.to_string());
            let _ = engine.call(move |s| on_exit(s, &id, result)).await;
            crate::persist::persist_after_flow(engine).await;
        }
    });
    join_all(runs).await;
}

fn on_exit(session: &mut Session, id: &str, result: Result<TicketResult, String>) {
    if let Some(at) = session.launched.iter().position(|l| l == id) {
        session.launched.remove(at);
    }
    let recorded =
        result.and_then(|result| record_exit(session, result).map_err(|e| e.to_string()));
    if let Err(error) = recorded {
        session.drive_failure.get_or_insert(error);
    }
    session.wake();
}

fn record_exit(session: &mut Session, result: TicketResult) -> anyhow::Result<()> {
    if let Some(proposals) = result.spawn_proposals.clone().filter(|p| !p.is_empty()) {
        crate::spawns::take_spawn_proposals(
            session,
            &result.marker.id,
            proposals,
            SpawnKind::Ticket,
        )?;
    }
    session.apply(result.update.clone());
    let attempt = result.plan.attempt;
    if result.plan.verify {
        if let Some(group) = session.verify_groups.get_mut(&result.marker.id) {
            group.ended.push(result.ending());
        }
    } else {
        match result.status {
            TicketStatus::Done => {
                if let Some(worktree) = result.plan.worktree.clone() {
                    chain_ticket_merge(session, result.marker.clone(), worktree, attempt, None);
                }
            }
            TicketStatus::Checkpoint => raise_checkpoint(session, &result.marker, attempt, None)?,
            TicketStatus::InProgress if session.children.stopping => note_shutdown(session),
            TicketStatus::InProgress => {
                let body = result.ending().crash_body();
                raise_interrupt(
                    session,
                    interrupt(&result.marker.id, InterruptKind::Crash, body),
                );
            }
            _ => {}
        }
    }
    emit_snapshot(session, RunPhase::Running);
    Ok(())
}

fn note_shutdown(session: &mut Session) {
    if !session.shutdown_noted {
        session.shutdown_noted = true;
        session.log(SHUTDOWN_LINE);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyGroup {
    pub expected: usize,
    pub ended: Vec<CandidateEnding>,
    pub flow: bool,
}

impl VerifyGroup {
    pub fn complete(&self) -> bool {
        self.ended.len() >= self.expected
    }
}

fn start_owed_grading(session: &mut Session) -> anyhow::Result<()> {
    let engine = session.engine();
    for owed in std::mem::take(&mut session.continued_grades) {
        session.grading += 1;
        tokio::spawn(continued_grade_flow(engine.clone(), owed));
    }
    let complete: Vec<TicketMarker> = session
        .markers
        .iter()
        .filter(|m| {
            session
                .verify_groups
                .get(&m.id)
                .is_some_and(|g| !g.flow && g.complete())
        })
        .cloned()
        .collect();
    for marker in complete {
        let Some(group) = session.verify_groups.get_mut(&marker.id) else {
            continue;
        };
        group.flow = true;
        let mut ended = group.ended.clone();
        let expected = group.expected as u64;
        ended.sort_by_key(|e| e.attempt);
        let tally = |status: TicketStatus| ended.iter().filter(|e| e.status == status).count();
        if tally(TicketStatus::Checkpoint) == 0 {
            for crashed in ended
                .iter()
                .filter(|e| e.status == TicketStatus::InProgress)
            {
                raise_interrupt(
                    session,
                    interrupt(&marker.id, InterruptKind::Crash, crashed.crash_body()),
                );
            }
        }
        session.log(format!(
            "ticket {}: verify fan-out complete: {} attempts exited ({} done, {} checkpoint, {} \
             crash); no merge and no status write until grading",
            marker.id,
            ended.len(),
            tally(TicketStatus::Done),
            tally(TicketStatus::Checkpoint),
            tally(TicketStatus::InProgress)
        ));
        session.grading += 1;
        tokio::spawn(verify_grade_flow(engine.clone(), marker, ended, expected));
    }
    Ok(())
}

fn grading_ended(session: &mut Session, outcome: anyhow::Result<()>) {
    session.grading -= 1;
    if let Err(error) = outcome {
        session.drive_failure.get_or_insert(error.to_string());
    }
    session.wake();
}

async fn writing_in_pool_checkout<T, F>(
    engine: &Engine,
    what: String,
    work: impl FnOnce() -> F,
) -> anyhow::Result<T>
where
    F: std::future::Future<Output = anyhow::Result<T>>,
{
    let hold = engine.call(move |s| hold_pool_checkout(s, what)).await?;
    let done = work().await;
    engine.call(move |s| release_pool_checkout(s, hold)).await?;
    done
}

async fn verify_grade_flow(
    engine: Engine,
    marker: TicketMarker,
    ended: Vec<CandidateEnding>,
    verify: u64,
) {
    let what = format!(
        "the verify round of {} is deciding its merge into the pool checkout",
        marker.id
    );
    let outcome = writing_in_pool_checkout(&engine, what, || {
        decide_round(&engine, &marker, &ended, verify)
    })
    .await;
    let id = marker.id;
    let _ = engine
        .call(move |s| {
            s.verify_groups.remove(&id);
            grading_ended(s, outcome);
        })
        .await;
    crate::persist::persist_after_flow(&engine).await;
}

async fn decide_round(
    engine: &Engine,
    marker: &TicketMarker,
    round: &[CandidateEnding],
    verify: u64,
) -> anyhow::Result<()> {
    let attempts: Vec<u64> = round.iter().map(|e| e.attempt).collect();
    let grades = crate::verify::grade_round(engine, marker, &attempts).await?;
    if engine.call(|s| s.children.stopping).await? {
        return Ok(());
    }
    if verify == 1 && round.len() == 1 {
        let (marker, grade, lone) = (
            marker.clone(),
            grades.get(&attempts[0]).cloned(),
            round[0].clone(),
        );
        return in_merge_chain(engine, move |s| {
            crate::verify::resolve_lone_attempt(s, &marker, &lone, grade.as_ref())
        })
        .await;
    }
    if round.iter().any(|e| e.status == TicketStatus::Checkpoint) {
        let (marker, round) = (marker.clone(), round.to_vec());
        return engine
            .call(move |s| crate::verify::checkpoint_fan_out_round(s, &marker, &round, &grades))
            .await?;
    }
    let all_graded = attempts.iter().all(|a| grades.contains_key(a));
    if !round.iter().all(|e| e.status == TicketStatus::Done) || !all_graded {
        return Ok(());
    }
    let human = engine
        .call(|s| s.state.config.selection_mode() == ac_protocol::SelectionMode::Human)
        .await?;
    if human {
        let marker = marker.clone();
        return engine
            .call(move |s| {
                crate::verify::raise_selection_interrupt(s, &marker, &attempts, &grades);
                emit_snapshot(s, RunPhase::Running);
            })
            .await
            .map_err(Into::into);
    }
    let selection = crate::verify::pick_winner(engine, marker, &attempts, &grades).await?;
    let marker = marker.clone();
    in_merge_chain(engine, move |s| {
        crate::verify::complete_selection(s, &marker, selection.picked, &selection.why, true)
    })
    .await
}

async fn continued_grade_flow(engine: Engine, owed: crate::keep_talking::ContinuedGrade) {
    let outcome = async {
        let id = owed.ticket_id.clone();
        let marker = engine
            .call(move |s| {
                s.marker(&id)
                    .filter(|m| m.status == TicketStatus::InProgress)
                    .cloned()
            })
            .await?;
        let Some(marker) = marker else {
            return Ok(());
        };
        let what = format!(
            "the lone grade of {}'s continued attempt is deciding its merge",
            marker.id
        );
        writing_in_pool_checkout(&engine, what, || {
            crate::keep_talking::grade_continued_attempt(&engine, &marker, owed.attempt, owed.work)
        })
        .await
    }
    .await;
    let _ = engine.call(move |s| grading_ended(s, outcome)).await;
    crate::persist::persist_after_flow(&engine).await;
}

pub fn rebuild_verify_group(session: &mut Session, marker: &TicketMarker) -> bool {
    if verify_of(session, marker).is_none() {
        return false;
    }
    let Some(group) = rebuilt_group(session, &marker.id) else {
        return false;
    };
    session.verify_groups.insert(marker.id.clone(), group);
    true
}

fn rebuilt_group(session: &Session, id: &str) -> Option<VerifyGroup> {
    let runs = Path::new(&session.runs_dir);
    let events = ac_core::events::read_events(runs, id);
    let last = events
        .iter()
        .rposition(|e| e.kind == TicketEventKind::Scheduled)?;
    let mut start = last;
    while start > 0 && events[start - 1].kind == TicketEventKind::Scheduled {
        start -= 1;
    }
    let attempts: Vec<u64> = events[start..=last].iter().map(|e| e.attempt).collect();
    if events[last..]
        .iter()
        .any(|e| matches!(e.kind, TicketEventKind::Selected | TicketEventKind::Merged))
    {
        return None;
    }
    let mut ended = Vec::new();
    for attempt in &attempts {
        let of = |kind: TicketEventKind| {
            events[last..]
                .iter()
                .rfind(|e| e.kind == kind && e.attempt == *attempt)
        };
        let (exited, crash) = (of(TicketEventKind::Exited), of(TicketEventKind::Crash));
        let ending = exited.or(crash)?;
        let status = match exited
            .and_then(|e| e.payload.get("status"))
            .and_then(Value::as_str)
        {
            Some("done") => TicketStatus::Done,
            Some("checkpoint") => TicketStatus::Checkpoint,
            _ => TicketStatus::InProgress,
        };
        let outcome_name = ac_core::events::attempt_outcome_name(id, Some(*attempt), false);
        ended.push(CandidateEnding {
            attempt: *attempt,
            status,
            crash_reason: crash
                .and_then(|c| c.payload.get("reason"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            log_path: ac_core::js::path_join(&[
                &session.runs_dir,
                &attempt_log_name(id, Some(*attempt), false),
            ]),
            log_tail: ending
                .payload
                .get("logTail")
                .and_then(Value::as_array)
                .map(|lines| {
                    lines
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            outcome_path: ac_core::js::path_join(&[&session.runs_dir, &outcome_name]),
            outcome_exists: ending
                .payload
                .get("outcomeExists")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            worktree: None,
        });
    }
    Some(VerifyGroup {
        expected: attempts.len(),
        ended,
        flow: false,
    })
}

// ---------------------------------------------------------------------------------------------------
// The close
// ---------------------------------------------------------------------------------------------------

pub async fn close_drive(engine: &Engine) -> anyhow::Result<()> {
    let (mut phase, quiet) = engine
        .call(|s| {
            let pending: Vec<String> = s
                .markers
                .iter()
                .filter(|m| !is_finished(s.status_of(&m.id)))
                .map(|m| m.id.clone())
                .collect();
            let closed_ids: Vec<String> = s
                .markers
                .iter()
                .filter(|m| s.status_of(&m.id) == Some(TicketStatus::Closed))
                .map(|m| m.id.clone())
                .collect();
            let merging = s.merge_line.unsettled();
            let raised = pending.is_empty()
                && s.line.is_none()
                && s.state.interrupts.is_empty()
                && !s.state.review_approved
                && merging.is_empty();
            if raised {
                let review = crate::interrupts::review_interrupt(s);
                raise_interrupt(s, review);
            }
            let mut outside: Vec<&String> = pending
                .iter()
                .filter(|id| s.live_attempts.is_live(id))
                .collect();
            for id in &merging {
                if !outside.contains(&id) {
                    outside.push(id);
                }
            }
            let interrupts = !s.state.interrupts.is_empty();
            // A Line pool is done only when its Line is: while it runs, a finished pool waits on it.
            let line_waits = s.line.is_some() && !crate::line::line_ended(s);
            let phase = if interrupts
                || !outside.is_empty()
                || !s.continued_grades.is_empty()
                || spawns_await_tick(s)
                || (line_waits && pending.is_empty())
            {
                RunPhase::Quiescent
            } else if pending.is_empty() {
                RunPhase::Done
            } else {
                RunPhase::Stalled
            };
            let line = match phase {
                RunPhase::Done if !closed_ids.is_empty() => format!(
                    "pool done: every ticket reached done or was closed ({} closed)",
                    closed_ids.join(", ")
                ),
                RunPhase::Done => "pool done: every ticket reached done".to_owned(),
                RunPhase::Quiescent if interrupts => format!(
                    "pool quiescent: interrupts pending for {}",
                    s.state
                        .interrupts
                        .iter()
                        .map(|i| i.ticket_id.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                RunPhase::Quiescent => format!(
                    "pool quiescent: waiting on {}",
                    if line_waits && pending.is_empty() && outside.is_empty() {
                        "the Line".to_owned()
                    } else if !outside.is_empty() {
                        outside
                            .iter()
                            .map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    } else if !s.continued_grades.is_empty() {
                        "a continued attempt's grading".to_owned()
                    } else {
                        "spawns to land".to_owned()
                    }
                ),
                _ => format!("pool stalled: {} cannot run", pending.join(", ")),
            };
            let quiet = !raised
                && s.settled_phase == Some(phase)
                && !crate::snapshot::emit_would_change(s, phase);
            if !quiet {
                s.log(line);
            }
            (phase, quiet)
        })
        .await?;
    // The final persist decides the store's fate: still failing, the run waits quiescent for a human.
    if !persist_with_retry(engine).await? {
        phase = RunPhase::Quiescent;
    }
    engine
        .call(move |s| {
            let mut phase = phase;
            let again = s.wakes.any_unseen() || spawns_await_tick(s);
            if again {
                phase = RunPhase::Quiescent;
            }
            if !quiet || again || crate::snapshot::emit_would_change(s, phase) {
                emit_snapshot(s, phase);
            }
            if phase != RunPhase::Quiescent {
                close_store(s);
            }
            settle_drive(s, Some(phase), None);
            drive_turned(s);
            if again {
                s.wake();
            }
            Ok(())
        })
        .await?
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[derive(Default)]
    struct Facts {
        statuses: HashMap<String, TicketStatus>,
        hold: Vec<String>,
        live: Vec<String>,
        git: bool,
        unlanded: Vec<String>,
        live_count: u64,
        max_live: Option<u64>,
        need: HashMap<String, u64>,
        missing: HashMap<String, &'static str>,
        held_at: HashMap<String, String>,
    }

    impl PoolFacts for Facts {
        fn status(&self, id: &str) -> Option<TicketStatus> {
            self.statuses.get(id).copied()
        }
        fn is_hold(&self, id: &str) -> bool {
            self.hold.iter().any(|h| h == id)
        }
        fn is_live(&self, id: &str) -> bool {
            self.live.iter().any(|l| l == id)
        }
        fn in_git(&self) -> bool {
            self.git
        }
        fn landed(&mut self, id: &str) -> bool {
            !self.unlanded.iter().any(|u| u == id)
        }
        fn live_count(&self) -> u64 {
            self.live_count
        }
        fn max_live(&mut self) -> Option<u64> {
            self.max_live
        }
        fn need(&self, marker: &TicketMarker) -> u64 {
            self.need.get(&marker.id).copied().unwrap_or(1)
        }
        fn missing_assignment(&self, id: &str) -> Option<&'static str> {
            self.missing.get(id).copied()
        }
        fn branch_held_at(&mut self, marker: &TicketMarker) -> Option<String> {
            self.held_at.get(&marker.id).cloned()
        }
    }

    fn marker(id: &str, blocked_by: &[&str]) -> TicketMarker {
        TicketMarker {
            id: id.to_owned(),
            file: std::path::PathBuf::from(format!("{id}.md")),
            blocked_by: blocked_by.iter().map(|b| (*b).to_owned()).collect(),
            status: TicketStatus::Ready,
            title: id.to_owned(),
            spec: String::new(),
            spawned_by: None,
            enlisted_from: None,
            spawn_assign: None,
            node: None,
            hold: false,
        }
    }

    fn facts(statuses: &[(&str, TicketStatus)]) -> Facts {
        Facts {
            statuses: statuses
                .iter()
                .map(|(id, status)| ((*id).to_owned(), *status))
                .collect(),
            git: true,
            ..Facts::default()
        }
    }

    #[test]
    fn eligibility_answers_every_row_of_the_rule_in_order() {
        use TicketStatus::{Closed, Done, InProgress, Ready};
        let grader = "01-grader-1";
        let rows: Vec<(&str, Facts, TicketMarker, Eligibility)> = vec![
            (
                "not ready",
                facts(&[("01", InProgress)]),
                marker("01", &[]),
                Eligibility::Wait(WaitWhy::NotReady),
            ),
            (
                "a hold Ticket is never run",
                Facts {
                    hold: vec!["01".into()],
                    ..facts(&[("01", Ready)])
                },
                marker("01", &[]),
                Eligibility::Wait(WaitWhy::Hold),
            ),
            (
                "an engine-run Ticket is its grading flow's",
                facts(&[(grader, Ready), ("01", InProgress)]),
                marker(grader, &["01"]),
                Eligibility::Wait(WaitWhy::EngineRun),
            ),
            (
                "live",
                Facts {
                    live: vec!["01".into()],
                    ..facts(&[("01", Ready)])
                },
                marker("01", &[]),
                Eligibility::Wait(WaitWhy::Live),
            ),
            (
                "a blocker still running",
                facts(&[("02", Ready), ("01", InProgress)]),
                marker("02", &["01"]),
                Eligibility::Wait(WaitWhy::BlockerNotDone("01".into())),
            ),
            (
                "a closed blocker is not done",
                facts(&[("02", Ready), ("01", Closed)]),
                marker("02", &["01"]),
                Eligibility::Wait(WaitWhy::BlockerNotDone("01".into())),
            ),
            (
                "a done blocker whose branch has not landed",
                Facts {
                    unlanded: vec!["01".into()],
                    ..facts(&[("02", Ready), ("01", Done)])
                },
                marker("02", &["01"]),
                Eligibility::Wait(WaitWhy::BlockerNotMerged("01".into())),
            ),
            (
                "a done hold blocker is merged by rule",
                Facts {
                    hold: vec!["01".into()],
                    unlanded: vec!["01".into()],
                    ..facts(&[("02", Ready), ("01", Done)])
                },
                marker("02", &["01"]),
                Eligibility::Start,
            ),
            (
                "a done engine-run blocker is merged by rule",
                Facts {
                    unlanded: vec![grader.into()],
                    ..facts(&[("02", Ready), (grader, Done)])
                },
                marker("02", &[grader]),
                Eligibility::Start,
            ),
            (
                "outside git every done blocker is merged",
                Facts {
                    git: false,
                    unlanded: vec!["01".into()],
                    ..facts(&[("02", Ready), ("01", Done)])
                },
                marker("02", &["01"]),
                Eligibility::Start,
            ),
            (
                "a full pool waits, naming what is live and the bound",
                Facts {
                    live_count: 2,
                    max_live: Some(2),
                    ..facts(&[("03", Ready)])
                },
                marker("03", &[]),
                Eligibility::Wait(WaitWhy::PoolFull { live: 2, max: 2 }),
            ),
            (
                "a blocker not merged is named before a full pool",
                Facts {
                    unlanded: vec!["01".into()],
                    live_count: 2,
                    max_live: Some(2),
                    ..facts(&[("02", Ready), ("01", Done)])
                },
                marker("02", &["01"]),
                Eligibility::Wait(WaitWhy::BlockerNotMerged("01".into())),
            ),
            (
                "a full pool waits before a missing Assignment is raised",
                Facts {
                    live_count: 1,
                    max_live: Some(1),
                    missing: HashMap::from([("02".to_owned(), "harness")]),
                    ..facts(&[("02", Ready)])
                },
                marker("02", &[]),
                Eligibility::Wait(WaitWhy::PoolFull { live: 1, max: 1 }),
            ),
            (
                "a pool with room starts",
                Facts {
                    live_count: 1,
                    max_live: Some(2),
                    ..facts(&[("02", Ready)])
                },
                marker("02", &[]),
                Eligibility::Start,
            ),
            (
                "with nothing live a verify round wider than the bound starts",
                Facts {
                    max_live: Some(1),
                    need: HashMap::from([("01".to_owned(), 2)]),
                    ..facts(&[("01", Ready)])
                },
                marker("01", &[]),
                Eligibility::Start,
            ),
            (
                "no bound never waits",
                Facts {
                    live_count: 40,
                    ..facts(&[("41", Ready)])
                },
                marker("41", &[]),
                Eligibility::Start,
            ),
            (
                "a verify round that does not fit waits",
                Facts {
                    live_count: 2,
                    max_live: Some(3),
                    need: HashMap::from([("v".to_owned(), 2)]),
                    ..facts(&[("v", Ready), ("p", Ready)])
                },
                marker("v", &[]),
                Eligibility::Wait(WaitWhy::PoolFull { live: 2, max: 3 }),
            ),
            (
                "a plain Ticket fits where that verify round did not",
                Facts {
                    live_count: 2,
                    max_live: Some(3),
                    need: HashMap::from([("v".to_owned(), 2)]),
                    ..facts(&[("v", Ready), ("p", Ready)])
                },
                marker("p", &[]),
                Eligibility::Start,
            ),
            (
                "a missing Assignment field",
                Facts {
                    missing: HashMap::from([("01".to_owned(), "model")]),
                    ..facts(&[("01", Ready)])
                },
                marker("01", &[]),
                Eligibility::Checkpoint(CheckpointWhy::MissingAssignment("model")),
            ),
            (
                "a branch checked out elsewhere",
                Facts {
                    held_at: HashMap::from([("01".to_owned(), "/elsewhere".to_owned())]),
                    ..facts(&[("01", Ready)])
                },
                marker("01", &[]),
                Eligibility::Checkpoint(CheckpointWhy::BranchHeldAt("/elsewhere".into())),
            ),
            (
                "each blocker done and merged",
                facts(&[("03", Ready), ("01", Done), ("02", Done)]),
                marker("03", &["01", "02"]),
                Eligibility::Start,
            ),
        ];
        for (row, mut facts, marker, expected) in rows {
            assert_eq!(eligibility(&mut facts, &marker), expected, "{row}");
        }
    }

    #[test]
    fn counts_each_live_ticket_attempt_once_and_nothing_the_engine_runs_beside_them() {
        use crate::continued::ContinuedRelease;
        use crate::held::HeldPane;
        use crate::keep_talking::ContinuedAttempt;
        use crate::live_attempts::LiveAttemptEntry;
        use crate::session::AdoptedAttempt;
        let (publisher, _) = tokio::sync::watch::channel(None);
        let mut session = crate::testkit::bare_session(publisher);
        let enlisted = |id: &str| TicketMarker {
            enlisted_from: Some("/checkout".into()),
            ..marker(id, &[])
        };
        session.markers = vec![
            marker("01", &[]),
            marker("v", &[]),
            marker("m", &[]),
            marker("a", &[]),
            marker("c", &[]),
            enlisted("e"),
            enlisted("f"),
            enlisted("g"),
        ];
        session.launched = ["01", "v", "v", "e"].map(String::from).to_vec();
        session
            .live_attempts
            .register("01", LiveAttemptEntry::new(1, None, None));
        session.live_attempts.register(
            "m",
            LiveAttemptEntry {
                role: AttemptRole::Resolver,
                ..LiveAttemptEntry::new(2, None, None)
            },
        );
        session
            .live_attempts
            .register("01-grader-1", LiveAttemptEntry::new(1, None, None));
        session
            .live_attempts
            .register("conv-1", LiveAttemptEntry::new(1, None, None));
        let adopted = || AdoptedAttempt {
            pane_id: "p".into(),
            attempt: 1,
            abandoned: false,
        };
        session.adopted.insert("a".into(), adopted());
        session.adopted.insert("f".into(), adopted());
        session
            .live_attempts
            .register("a", LiveAttemptEntry::new(1, Some("p".into()), None));
        let continued = || ContinuedAttempt {
            attempt: 2,
            work: HeldPane {
                attempt: 1,
                pane_id: "p".into(),
                tab_id: None,
                terminal_id: None,
                cwd: "/w".into(),
                branch: None,
                harness: "claude".into(),
                model: "m".into(),
                effort: None,
                work_attempt: 1,
                numbered: false,
                stream: None,
                spawned_at: String::new(),
                wrapped: true,
            },
            release: ContinuedRelease::detached(),
            log_path: String::new(),
            outcome_path: String::new(),
        };
        // A Continued attempt re-adopted at boot is both adopted and continued.
        session.adopted.insert("c".into(), adopted());
        session.continued.insert("c".into(), continued());
        session.continued.insert("g".into(), continued());
        // 01 once, both of v's Candidates, m's resolver, a's adopted Attempt and c's Continued one.
        assert_eq!(live_ticket_attempts(&session), 6);
    }

    #[test]
    fn a_wake_in_flight_leaves_a_permit_and_moves_the_count_a_closing_drive_reads() {
        let (publisher, _) = tokio::sync::watch::channel(None);
        let mut session = crate::testkit::bare_session(publisher);
        session.driving = true;
        session.wakes.see_all();
        session.wake();
        let waited = futures::FutureExt::now_or_never(session.wake.notified());
        assert!(
            waited.is_some(),
            "the drive's next wait takes the permit at once"
        );
        assert!(
            session.wakes.any_unseen(),
            "a drive closing after this wake starts the next"
        );
    }
}
