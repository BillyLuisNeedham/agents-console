//! The drive (ADR-0040): the rolling scheduler every pool runs. The drive is a loop of Ticks; a Tick is
//! one job on the actor that reloads the config, drains Queued answers, reconciles deadlocks, routes
//! the Line, lands Pending spawns, starts owed grading, and launches every Ticket that may start. The
//! drive then waits for a wake. Each launched Attempt ends in its own exit job, each verify round is
//! graded once its last Candidate exits, and each merge runs on the merge chain. The close holds the
//! Review gate and the phase decision; a drive's death and its settle close it out.
//!
//!   drive_loop -- tick --> launches --> run_launch --+ exit job: the result, a crash Interrupt,
//!        ^                                           | the merge chained, a Candidate's ending
//!        +------ wake.notified() <-- wake() <--------+
//!                                     ^   ^   ^
//!          merge landed, grading ended+   |   +-- answer, settings save, spawn, Adopt, hand merge

use std::path::Path;
use std::sync::Arc;

use futures::future::join_all;
use serde_json::{Map, Value};
use tokio::sync::oneshot;

use ac_core::assignment::{Assignment, engine_ticket_build_id};
use ac_core::events::{append_event, attempt_log_name, event_now, last_attempt, next_attempt};
use ac_core::pool::{TicketMarker, is_finished, write_marker_status};
use ac_io::git;
use ac_protocol::{InterruptKind, RunPhase, SpawnKind, TicketEventKind, TicketStatus};

use crate::actor::Engine;
use crate::checkout_gate::{hold_pool_checkout, pool_checkout_free, release_pool_checkout};
use crate::error::EngineError;
use crate::interrupts::{interrupt, land_checkpoint_brief, raise_checkpoint, raise_interrupt};
use crate::merges::{chain_ticket_merge, in_merge_chain, merge_hold, merge_target_sha};
use crate::persist::{close_store, persist_with_retry, write_markers};
use crate::session::{PoolState, PoolUpdate, Session};
use crate::snapshot::emit_snapshot;
use crate::spawns::spawns_await_tick;
use crate::tickets::{
    CandidateEnding, TicketEnv, TicketPlan, TicketResult, attempt_env_of, plan_ticket, run_ticket,
};

/// How long shutdown waits for the drive to settle after the children are stopped.
pub const SHUTDOWN_SETTLE_WAIT_MS: u64 = 3_000;

/// The pool log line a shutdown leaves, once, when it stopped an Attempt.
pub const SHUTDOWN_LINE: &str =
    "engine shutdown: no crash interrupts raised and nothing more launched";

// ---------------------------------------------------------------------------------------------------
// Starting, waking, settling, dying
// ---------------------------------------------------------------------------------------------------

/// `startDrive`: a drive is in flight from here; its first emit happens now. The loop's every death
/// reports through [`report_drive_death`].
pub fn start_drive(session: &mut Session) {
    session.driving = true;
    emit_snapshot(session, RunPhase::Running);
    let engine = session.engine();
    tokio::spawn(async move {
        if let Err(error) = drive_loop(&engine).await {
            let message = error.to_string();
            let _ = engine.call(move |s| report_drive_death(s, &message)).await;
        }
    });
}

impl Session {
    /// The one way anything asks the drive to look again (ADR-0040). In flight, a permit the drive's
    /// wait takes; idle, the Queued answers drain at once and a fresh drive starts. A pool whose store
    /// has closed, or that is shutting down, starts nothing. A drain whose persist fails refuses here.
    pub fn wake(&mut self) -> anyhow::Result<()> {
        self.wakes += 1;
        if self.driving {
            self.wake.notify_one();
            return Ok(());
        }
        if !self.store_open || self.children.stopping {
            return Ok(());
        }
        crate::answers::drain_answers(self)?;
        start_drive(self);
        Ok(())
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

// ---------------------------------------------------------------------------------------------------
// Eligibility: the scheduler's one rule
// ---------------------------------------------------------------------------------------------------

/// Whether a Ticket starts now, waits, or needs the operator first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Eligibility {
    Start,
    Wait(WaitWhy),
    Checkpoint(CheckpointWhy),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitWhy {
    NotReady,
    /// The Finish checkpoint: answered by the operator, never run (ADR-0037).
    Hold,
    /// A grader or head-to-head judge: run by its grading flow, never launched by a Tick.
    EngineRun,
    Live,
    BlockerNotDone(String),
    BlockerNotMerged(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointWhy {
    MissingAssignment(&'static str),
    BranchHeldAt(String),
}

/// What [`eligibility`] reads of the pool.
pub trait PoolFacts {
    fn status(&self, id: &str) -> Option<TicketStatus>;
    /// A hold Ticket: the Finish checkpoint.
    fn is_hold(&self, id: &str) -> bool;
    fn is_live(&self, id: &str) -> bool;
    fn in_git(&self) -> bool;
    /// The branch reading: the Ticket's branch is gone or an ancestor of the merge target.
    fn landed(&mut self, id: &str) -> bool;
    fn missing_assignment(&self, id: &str) -> Option<&'static str>;
    /// Where the Ticket's branch is checked out, when that is somewhere the engine cannot run it.
    fn branch_held_at(&mut self, marker: &TicketMarker) -> Option<String>;
}

/// Whether a done blocker counts as merged (ADR-0040), in this order: a hold Ticket and an engine-run
/// Ticket by rule, since neither has a branch; every Ticket of a pool outside git; otherwise the branch
/// reading, where a missing branch reads as landed by hand.
pub fn merged(facts: &mut impl PoolFacts, id: &str) -> bool {
    if facts.is_hold(id) || engine_ticket_build_id(id).is_some() || !facts.in_git() {
        return true;
    }
    facts.landed(id)
}

/// The scheduler's rule: a Ticket starts once it is Ready, not a hold, not engine-run, not live, and
/// each blocker is done and merged; a config gap or a branch held elsewhere raises its checkpoint.
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
    if let Some(missing) = facts.missing_assignment(id) {
        return Eligibility::Checkpoint(CheckpointWhy::MissingAssignment(missing));
    }
    if let Some(at) = facts.branch_held_at(marker) {
        return Eligibility::Checkpoint(CheckpointWhy::BranchHeldAt(at));
    }
    Eligibility::Start
}

// The pool as one Tick reads it. The branch reading is the Merge hold's derivation, behind its memo,
// taken at most once per Tick.
struct SessionFacts<'a> {
    session: &'a mut Session,
    unlanded: &'a mut Option<Vec<String>>,
}

impl PoolFacts for SessionFacts<'_> {
    fn status(&self, id: &str) -> Option<TicketStatus> {
        self.session.status_of(id)
    }

    fn is_hold(&self, id: &str) -> bool {
        self.session
            .marker(id)
            .is_some_and(|m| m.station == Some(ac_protocol::Station::Finish))
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

// A pool-config gap pauses the one ticket as a config interrupt instead of ending the run.
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

// ---------------------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------------------

/// One Ticket's launch, planned in the Tick that found it eligible: one plan per Attempt (N for a
/// `verify: N` round), its Assignment and environment as they stand now, and the state its prompts
/// read upstream Outcomes from, frozen at the launch.
pub struct Launch {
    pub marker: TicketMarker,
    pub plans: Vec<TicketPlan>,
    pub assignment: Assignment,
    pub env: TicketEnv,
    pub snapshot: Arc<PoolState>,
}

/// What the drive does after a Tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    Wait,
    /// Nothing runs, merges, grades or can start: the drive closes.
    Close,
}

/// A Tick's result: the launches to start, what the drive does next, and whether the state moved
/// since the store last took it.
pub struct Tick {
    pub launches: Vec<Launch>,
    pub next: Next,
    pub changed: bool,
}

/// `driveLoop`: Ticks until one closes the drive, each followed by its launches, a checkpoint row when
/// the state changed, and a wait for the next wake.
pub async fn drive_loop(engine: &Engine) -> anyhow::Result<()> {
    // Boot reconciliation lands before the first Tick.
    let mut reconcile = engine.call(|s| s.terminal_reconcile.clone()).await?;
    if !*reconcile.borrow() {
        engine.call(drive_turned).await?;
    }
    let _ = reconcile.wait_for(|done| *done).await;
    let wake = engine.call(|s| Arc::clone(&s.wake)).await?;
    loop {
        // A shutdown launches nothing more and closes once the stopped Attempts' exits are recorded.
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
        for launch in launches {
            tokio::spawn(run_launch(engine.clone(), launch));
        }
        // An exhausted retry raises the persistence Interrupt, which holds every launch until answered.
        if changed {
            persist_with_retry(engine).await?;
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

/// One Tick, one job. Each step is idempotent, so a spurious wake costs one job. The order is the
/// order each step can create work for the next.
pub fn tick(session: &mut Session) -> anyhow::Result<Tick> {
    if let Some(failure) = session.drive_failure.take() {
        anyhow::bail!(failure);
    }
    let before = serde_json::to_value(&session.state)?;
    crate::config_reload::reload_config(session)?;
    crate::answers::drain_answers(session)?;
    crate::interrupts::reconcile_deadlocks(session)?;
    crate::line::route_line(session)?;
    crate::spawns::adopt_spawn_proposals(session)?;
    start_owed_grading(session)?;
    let held = persistence_pending(session);
    let launches = if held {
        Vec::new()
    } else {
        launch_eligible(session)?
    };
    let state = serde_json::to_value(&session.state)?;
    if state != before || !launches.is_empty() {
        emit_snapshot(session, RunPhase::Running);
    }
    drive_turned(session);
    session.wakes_seen = session.wakes;
    // A done Ticket whose merge has not landed keeps the drive alive, as ADR-0014's hold did: the
    // pool never reaches its Review with work unmerged, and the Merge queue watch wakes it when a
    // merge done by hand lands.
    let close = launches.is_empty()
        && session.launched.is_empty()
        && session.merge_line.unsettled().is_empty()
        && session.grading == 0
        && session.continued_grades.is_empty()
        && !spawns_await_tick(session)
        && merge_hold(session).is_empty();
    Ok(Tick {
        launches,
        next: if close { Next::Close } else { Next::Wait },
        changed: !held && session.persisted.as_ref() != Some(&state),
    })
}

// Every eligible Ticket in load order, launched; a checkpoint raised for each that needs the operator.
fn launch_eligible(session: &mut Session) -> anyhow::Result<Vec<Launch>> {
    let mut unlanded = None;
    let mut launches = Vec::new();
    for index in 0..session.markers.len() {
        let marker = session.markers[index].clone();
        let verdict = eligibility(
            &mut SessionFacts {
                session,
                unlanded: &mut unlanded,
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

// The launch of one Ticket: every Attempt numbered and planned (a worktree cut from the target's tip
// now), the marker in progress on disk, a scheduled event per Attempt and one `start` line, all before
// any spawn.
fn plan_launch(session: &mut Session, marker: &TicketMarker) -> anyhow::Result<Launch> {
    let runs = Path::new(&session.runs_dir).to_path_buf();
    let verify = verify_of(session, marker);
    if verify.is_some() {
        // A pre-verify solo attempt's well-known log rotates before the fan-out spawns.
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

// A launch's Attempts, each run to its exit job. A Ticket resumed from a checkpoint launches fresh:
// its old pane closes first (issue #139).
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
        }
    });
    join_all(runs).await;
}

// One Attempt's exit job. A failure to run it at all, or to record its exit, kills the drive at the
// next Tick, as a fatal stretch of the drive does.
fn on_exit(session: &mut Session, id: &str, result: Result<TicketResult, String>) {
    if let Some(at) = session.launched.iter().position(|l| l == id) {
        session.launched.remove(at);
    }
    let recorded =
        result.and_then(|result| record_exit(session, result).map_err(|e| e.to_string()));
    if let Err(error) = recorded {
        session.drive_failure.get_or_insert(error);
    }
    let _ = session.wake();
}

// The proposals taken; the result applied; a Candidate's ending joins its round; a done Ticket's merge
// chained; a checkpoint's or a crash's Interrupt raised now. A shutdown-stopped Attempt raises nothing
// (ADR-0017).
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

// ---------------------------------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------------------------------

/// The Candidates of one verify Ticket's round, joined per Ticket: complete once every Candidate
/// ended, then graded by one grading flow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyGroup {
    pub expected: usize,
    pub ended: Vec<CandidateEnding>,
    /// Its grading flow has started.
    pub flow: bool,
}

impl VerifyGroup {
    pub fn complete(&self) -> bool {
        self.ended.len() >= self.expected
    }
}

// Step 6 of a Tick: a grading flow for each owed Continued grade and each complete verify round. A
// round's crashed Candidates raise their crash Interrupts first, unless a Candidate checkpointed: the
// checkpoint its grading raises owns the round then (ADR-0034).
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

// A grading flow's end: counted off, its error left for the next Tick, the drive woken.
fn grading_ended(session: &mut Session, outcome: anyhow::Result<()>) {
    session.grading -= 1;
    if let Err(error) = outcome {
        session.drive_failure.get_or_insert(error.to_string());
    }
    let _ = session.wake();
}

// Work that may merge into the pool checkout: it waits at the checkout's gate (ADR-0027) and writes
// there until it is done. `None` when a shutdown began while it waited.
async fn writing_in_pool_checkout<T, F>(
    engine: &Engine,
    what: String,
    work: impl FnOnce() -> F,
) -> anyhow::Result<Option<T>>
where
    F: std::future::Future<Output = anyhow::Result<T>>,
{
    if !pool_checkout_free(engine).await? {
        return Ok(None);
    }
    let hold = engine.call(move |s| hold_pool_checkout(s, what)).await?;
    let done = work().await;
    engine.call(move |s| release_pool_checkout(s, hold)).await?;
    done.map(Some)
}

// One verify round graded and decided.
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
    .await
    .map(drop);
    let id = marker.id;
    let _ = engine
        .call(move |s| {
            s.verify_groups.remove(&id);
            grading_ended(s, outcome);
        })
        .await;
}

// A verify round's decision: lone-attempt resolution, a paused round's checkpoint, or Selection. The
// graders run beside everything; a decision that merges waits its turn on the merge chain.
async fn decide_round(
    engine: &Engine,
    marker: &TicketMarker,
    round: &[CandidateEnding],
    verify: u64,
) -> anyhow::Result<()> {
    let attempts: Vec<u64> = round.iter().map(|e| e.attempt).collect();
    let grades = crate::verify::grade_round(engine, marker, &attempts).await?;
    // A round a shutdown cut short is decided at the next boot, from its events.
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
        crate::verify::finish_selection(s, &marker, selection)
    })
    .await
}

// One owed Continued grade (issue #139), graded and decided as a lone attempt.
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
        let (attempt, work) = (owed.attempt, owed.work.clone());
        let graded = writing_in_pool_checkout(&engine, what, || {
            crate::keep_talking::grade_continued_attempt(&engine, &marker, attempt, work)
        })
        .await?;
        // A shutdown while it waited leaves the grade owed, and the next boot grades it.
        if graded.is_none() {
            engine
                .call(move |s| s.continued_grades.insert(0, owed))
                .await?;
        }
        Ok(())
    }
    .await;
    let _ = engine.call(move |s| grading_ended(s, outcome)).await;
}

/// Restart: an in-progress verify Ticket with no Interrupt gets its round back from its events file.
/// The round is the run of `scheduled` events that ends at its last one. A round whose every Candidate
/// ended (an `exited` or a `crash` event) is restored complete, and the first Tick grades what is
/// ungraded and decides; true then, and the marker stays in progress. A round with a Candidate that
/// never ended is not restored: the marker returns to Ready and the round fans out again.
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

/// `closeDrive`: the Review gate, the phase decision, the final persist and the settle. A wake that
/// came after the last Tick starts the next drive.
pub async fn close_drive(engine: &Engine) -> anyhow::Result<()> {
    // A closed ticket (issue #154) is finished too.
    let (pending, closed_ids, raised, merging_at_gate) = engine
        .call(|s| {
            let pending: Vec<String> = s
                .markers
                .iter()
                .filter(|m| !is_finished(s.status_of(&m.id)))
                .map(|m| m.id.clone())
                .collect();
            let closed: Vec<String> = s
                .markers
                .iter()
                .filter(|m| s.status_of(&m.id) == Some(TicketStatus::Closed))
                .map(|m| m.id.clone())
                .collect();
            // The closing gate: every ticket finished and nothing else waiting on the human raises
            // the final Review; an approval recorded in state holds it down for good. A merge still in
            // flight off the drive (an adopted or Continued attempt's ending) holds the gate too. In a
            // Factory pool approving the Finish checkpoint is the Review (ADR-0037).
            let merging = s.merge_line.unsettled();
            let raise = pending.is_empty()
                && !crate::line::is_factory_pool(s)
                && s.state.interrupts.is_empty()
                && !s.state.review_approved
                && merging.is_empty();
            if raise {
                let review = crate::interrupts::review_interrupt(s);
                raise_interrupt(s, review);
            }
            (pending, closed, raise, merging)
        })
        .await?;
    if raised {
        persist_with_retry(engine).await?;
    }
    let pending_c = pending.clone();
    let mut phase = engine
        .call(move |s| {
            let pending = pending_c;
            // Tickets whose Attempt runs outside the drive (issue #139) end on their own. So does a
            // ticket whose merge is still in flight off the drive: its ending already landed, its
            // merge has not (see the closing gate above). One the gate saw in flight counts even if it
            // settled since: the gate held the Review for it, and its merge's wake starts the drive
            // that raises it, so this one must not close the store first.
            let mut merging = s.merge_line.unsettled();
            for id in merging_at_gate {
                if !merging.contains(&id) {
                    merging.push(id);
                }
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
            // A Factory pool is done only when its Line is: before Start the Line, and while it
            // routes, an empty or finished pool waits on it.
            let line_waits = crate::line::is_factory_pool(s) && !crate::line::line_ended(s);
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
                        if s.line.is_some() {
                            "the Line".to_owned()
                        } else {
                            "Start the Line".to_owned()
                        }
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
            s.log(line);
            phase
        })
        .await?;
    // The final persist decides the store's fate: still failing, the run waits quiescent for a human.
    if !persist_with_retry(engine).await? {
        phase = RunPhase::Quiescent;
    }
    engine
        .call(move |s| {
            let mut phase = phase;
            // Something woke the drive after its last Tick: the store stays open and the next drive
            // starts once this one settles.
            let again = s.wakes != s.wakes_seen || spawns_await_tick(s);
            if again {
                phase = RunPhase::Quiescent;
            }
            emit_snapshot(s, phase);
            if phase != RunPhase::Quiescent {
                close_store(s);
            }
            settle_drive(s, Some(phase), None);
            drive_turned(s);
            if again {
                s.wake()?;
            }
            Ok(())
        })
        .await?
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    // A pool over fixed facts: statuses, the hold, the live ids, the ids whose branch has not landed,
    // the missing Assignment fields and the held branches.
    #[derive(Default)]
    struct Facts {
        statuses: HashMap<String, TicketStatus>,
        hold: Vec<String>,
        live: Vec<String>,
        git: bool,
        unlanded: Vec<String>,
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
            station: None,
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
    fn a_wake_in_flight_leaves_a_permit_and_moves_the_count_a_closing_drive_reads() {
        let (publisher, _) = tokio::sync::watch::channel(None);
        let mut session = crate::testkit::bare_session(publisher);
        session.driving = true;
        session.wakes_seen = session.wakes;
        session.wake().unwrap();
        let waited = futures::FutureExt::now_or_never(session.wake.notified());
        assert!(
            waited.is_some(),
            "the drive's next wait takes the permit at once"
        );
        assert_ne!(
            session.wakes, session.wakes_seen,
            "a drive closing after this wake starts the next"
        );
    }
}
