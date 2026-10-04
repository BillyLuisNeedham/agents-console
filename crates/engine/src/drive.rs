//! The drive (engine.ts 1553-2440): the drive loop, the Super-step boundary, the plan, the run with
//! its merge chain and joins, the close with the Review gate and the phase decision, settling, and a
//! drive's death.
//!
//! Each stretch of synchronous TypeScript between two awaits is one job on the actor; the loop itself
//! is a flow on its own task.

use std::path::Path;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared, join_all};
use serde_json::{Map, Value};
use tokio::sync::oneshot;

use ac_core::assignment::engine_ticket_build_id;
use ac_core::events::{append_event, attempt_log_name, event_now, last_attempt, next_attempt};
use ac_core::pool::{TicketMarker, is_finished, write_marker_status};
use ac_io::git::{self, MergeResult};
use ac_protocol::{InterruptKind, RunPhase, SpawnKind, TicketEventKind, TicketStatus};

use crate::actor::Engine;
use crate::checkout_gate::{
    DeferredMerge, hold_pool_checkout, pool_checkout_free, release_pool_checkout,
    through_pool_checkout_gate,
};
use crate::error::EngineError;
use crate::interrupts::{interrupt, land_checkpoint_brief, raise_checkpoint, raise_interrupt};
use crate::merges::{
    EngineHoldHost, handle_merge_conflict, hold_poll, merge_hold, merge_target_ref,
    merge_target_sha, merge_ticket, merged_payload, through_merge_hold,
};
use crate::persist::{close_store, persist_with_retry, write_markers};
use crate::session::{PoolState, PoolUpdate, Session};
use crate::snapshot::emit_snapshot;
use crate::spawns::spawns_await_boundary;
use crate::tickets::{
    CrashFacts, TicketEnv, TicketPlan, TicketResult, attempt_env_of, close_attempt_tab,
    crash_interrupt_body, plan_ticket, run_ticket,
};

/// How long shutdown waits for the drive to join its super-step after the children are stopped.
pub const SHUTDOWN_SETTLE_WAIT_MS: u64 = 3_000;

// ---------------------------------------------------------------------------------------------------
// Starting, settling, dying
// ---------------------------------------------------------------------------------------------------

/// `startDrive`: a drive is in flight from here; its first emit happens now, as the TypeScript's
/// drive loop emits before its first await. The loop's every death reports through
/// [`report_drive_death`].
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

/// The boot's drive has reached its first real wait, or settled: start_pool may return.
pub fn drive_turned(session: &mut Session) {
    if let Some(turned) = session.first_turn.take() {
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
// The loop
// ---------------------------------------------------------------------------------------------------

/// `driveLoop`: one super-step per turn: the boundary decides whether there is a next one, the plan
/// numbers and records it, the run fans it out and joins it, and the close settles the drive.
pub async fn drive_loop(engine: &Engine) -> anyhow::Result<()> {
    // Boot reconciliation lands before the first scheduling.
    let mut reconcile = engine.call(|s| s.terminal_reconcile.clone()).await?;
    if !*reconcile.borrow() {
        engine.call(drive_turned).await?;
    }
    let _ = reconcile.wait_for(|done| *done).await;
    loop {
        // A verify ticket's Continued attempt that ended done is graded here, between super-steps.
        crate::keep_talking::grade_continued_attempts(engine).await?;
        if engine.call(|s| s.children.stopping).await? {
            break;
        }
        let Some(step) = super_step_boundary(engine).await? else {
            break;
        };
        if run_super_step(engine, step).await? == StepEnd::Stop {
            break;
        }
    }
    close_drive(engine).await
}

/// `readySet`: the ready set's one home. While any done ticket's branch is unmerged nothing is handed
/// back (ADR-0014); an all-engine proposal is cleared where proposed; otherwise the ordinary tickets
/// whose marker is ready and whose blockers are all done. The hold rides back beside the set.
pub fn ready_set(
    session: &mut Session,
    candidates: &[TicketMarker],
) -> (Vec<TicketMarker>, Vec<String>) {
    let hold = merge_hold(session);
    if !hold.is_empty() {
        return (Vec::new(), hold);
    }
    if candidates
        .iter()
        .all(|marker| engine_ticket_build_id(&marker.id).is_some())
    {
        return (candidates.to_vec(), hold);
    }
    let tickets = &session.state.tickets;
    let ready = candidates
        .iter()
        .filter(|marker| {
            engine_ticket_build_id(&marker.id).is_none()
                && tickets.get(&marker.id) == Some(&TicketStatus::Ready)
                && marker
                    .blocked_by
                    .iter()
                    .all(|id| tickets.get(id) == Some(&TicketStatus::Done))
        })
        .cloned()
        .collect();
    (ready, hold)
}

/// `superStepBoundary`: everything a super-step in flight must not do, then the ready set, run through
/// the wait-and-recompute rule so the whole boundary runs again once a hold lifts. `None` is the
/// close. The plan of a ready set is made in the same job that found it: in the TypeScript no
/// request is served between the boundary and the plan, so none may be here (a request between them
/// would read the files an adoption just wrote beside a snapshot older than they are).
pub async fn super_step_boundary(engine: &Engine) -> anyhow::Result<Option<SuperStepPlan>> {
    let host = EngineHoldHost(engine);
    let step = through_merge_hold(
        &host,
        || {
            let engine = engine.clone();
            async move {
                engine
                    .call(
                        |s| -> anyhow::Result<(Option<SuperStepPlan>, Vec<String>)> {
                            crate::interrupts::reconcile_deadlocks(s)?;
                            // Config reload (ADR-0018), before the drain and adoption below.
                            crate::config_reload::reload_config_at_boundary(s)?;
                            // Answers accepted while the previous super-step was in flight.
                            crate::answers::drain_answers(s)?;
                            // A Close the drain just applied leaves its dependents unable to run.
                            crate::interrupts::reconcile_deadlocks(s)?;
                            // Spawn adoption (ADR-0010) rides the same boundary.
                            crate::spawns::adopt_spawn_proposals(s)?;
                            let markers = s.markers.clone();
                            let (ready, hold) = ready_set(s, &markers);
                            if ready.is_empty() || !hold.is_empty() {
                                return Ok((None, hold));
                            }
                            Ok((Some(plan_super_step(s, ready)?), hold))
                        },
                    )
                    .await?
            }
        },
        hold_poll(),
    )
    .await?;
    Ok(step)
}

/// One super-step, planned.
pub struct SuperStepPlan {
    pub ready: Vec<TicketMarker>,
    pub planned: Vec<(TicketMarker, TicketPlan)>,
    /// The state every attempt of this super-step spawns against, fixed at the plan.
    pub snapshot: Arc<PoolState>,
}

// The Assignment field a ticket about to schedule has no value for (issue #118).
fn missing_assignment_field(session: &Session, marker: &TicketMarker) -> Option<&'static str> {
    let assignment = session.assignments.get(&marker.id);
    if assignment.is_none_or(|a| a.harness.is_empty()) {
        return Some("harness");
    }
    if assignment.is_none_or(|a| a.model.is_empty()) {
        return Some("model");
    }
    None
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
         defaults.{missing}) and answer resume. The pool reloads console.json at the next super-step \
         boundary and schedules the ticket on what it finds."
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

/// `planSuperStep`: the super-step gets its number, every attempt its number, the markers their
/// in-progress status on disk, and every attempt its scheduled event, all before any spawn. A step
/// with nothing left to plan is no super-step.
pub fn plan_super_step(
    session: &mut Session,
    ready: Vec<TicketMarker>,
) -> anyhow::Result<SuperStepPlan> {
    let mut held: Vec<String> = Vec::new();
    for marker in &ready {
        if let Some(missing) = missing_assignment_field(session, marker) {
            checkpoint_unassigned(session, marker, missing)?;
            held.push(marker.id.clone());
            continue;
        }
        if let Some(at) = held_branch_directory(session, marker) {
            checkpoint_held_branch(session, marker, &at)?;
            held.push(marker.id.clone());
        }
    }
    let ready: Vec<TicketMarker> = ready
        .into_iter()
        .filter(|marker| !held.contains(&marker.id))
        .collect();
    if ready.is_empty() {
        emit_snapshot(session, RunPhase::Running);
        return Ok(SuperStepPlan {
            ready,
            planned: Vec::new(),
            snapshot: Arc::new(session.state.clone()),
        });
    }
    session.super_step += 1;
    let runs = Path::new(&session.runs_dir).to_path_buf();
    let mut planned = Vec::new();
    for marker in &ready {
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
        let base = next_attempt(&runs, &marker.id);
        for i in 0..verify.unwrap_or(1) {
            let plan = plan_ticket(session, marker, ready.len(), base + i, verify.is_some())?;
            planned.push((marker.clone(), plan));
        }
    }
    let ids: Vec<&str> = ready.iter().map(|m| m.id.as_str()).collect();
    session.apply(PoolUpdate {
        tickets: Some(
            ready
                .iter()
                .map(|m| (m.id.clone(), TicketStatus::InProgress))
                .collect(),
        ),
        log: Some(vec![format!(
            "super-step {}: {}",
            session.super_step,
            ids.join(", ")
        )]),
        ..PoolUpdate::default()
    });
    write_markers(session)?;
    drive_turned(session);
    for (marker, plan) in &planned {
        append_event(
            &runs,
            &marker.id,
            &event_now(plan.attempt, TicketEventKind::Scheduled, Map::new()),
        )?;
    }
    emit_snapshot(session, RunPhase::Running);
    Ok(SuperStepPlan {
        ready,
        planned,
        snapshot: Arc::new(session.state.clone()),
    })
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------

/// Whether the drive goes on to the next boundary or stops at the close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepEnd {
    Continue,
    Stop,
}

/// One merge this super-step ran: the result, the attempt, and the merge target's tip just before it.
struct StepMerge {
    marker: TicketMarker,
    result: MergeResult,
    attempt: u64,
    before_sha: String,
}

/// The step's own merge queue: a link that fails once any merge before it threw, so later merges of
/// the step are skipped and the step's join sees the error, as the TypeScript's local promise chain.
type StepLink = Shared<BoxFuture<'static, Result<(), String>>>;

struct StepMerges {
    queue: Mutex<StepLink>,
    merges: Mutex<Vec<StepMerge>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// The `.then` on each attempt's ending: proposals ride to the boundary, a verify candidate moves only
// the pool log, a done attempt with a worktree joins the merge chain, and a terminal result joins state
// at once (a checkpoint raises its interrupt here).
fn on_ticket_exit(
    session: &mut Session,
    mut result: TicketResult,
    step: &Arc<StepMerges>,
) -> anyhow::Result<TicketResult> {
    if let Some(proposals) = result.spawn_proposals.clone().filter(|p| !p.is_empty()) {
        crate::spawns::take_spawn_proposals(
            session,
            &result.marker.id,
            proposals,
            SpawnKind::Ticket,
        )?;
    }
    if result.plan.verify {
        session.apply(result.update.clone());
        result.joined_at_exit = true;
        emit_snapshot(session, RunPhase::Running);
        return Ok(result);
    }
    if let (Some(worktree), TicketStatus::Done) = (result.plan.worktree.clone(), result.status) {
        // Its place in the Merge queue is the order it joins the chain.
        session.merge_line.taken(&result.marker.id);
        let engine = session.engine();
        let marker = result.marker.clone();
        let attempt = result.plan.attempt;
        let step_for_link = Arc::clone(step);
        let deferred = DeferredMerge {
            ticket_id: marker.id.clone(),
            path: worktree.path.clone(),
            branch: worktree.branch.clone(),
            attempt,
        };
        let work = async move {
            through_pool_checkout_gate(&engine, Some(deferred), move |s| {
                // Captured inside the serialized chain, just before the merge.
                let before_sha = merge_target_sha(s);
                let merged = merge_ticket(s, &marker, &worktree)?;
                lock(&step_for_link.merges).push(StepMerge {
                    marker,
                    result: merged,
                    attempt,
                    before_sha,
                });
                Ok(())
            })
            .await
            .map(drop)
            .map_err(|error| error.to_string())
        };
        let link: StepLink = {
            let mut queue = lock(&step.queue);
            let prev = queue.clone();
            let link = async move {
                prev.await?;
                work.await
            }
            .boxed()
            .shared();
            *queue = link.clone();
            link
        };
        // Published at every extension, so a merge chained from outside the drive never sees a
        // stale tail.
        session.merge_chain = link.clone().map(drop).boxed().shared();
        tokio::spawn(link);
    }
    if result.status == TicketStatus::InProgress {
        // A crashed attempt was recorded at exit; the snapshot shows it now.
        emit_snapshot(session, RunPhase::Running);
    } else {
        session.apply(result.update.clone());
        result.joined_at_exit = true;
        if result.status == TicketStatus::Checkpoint {
            raise_checkpoint(session, &result.marker, result.plan.attempt, None)?;
        }
        emit_snapshot(session, RunPhase::Running);
    }
    Ok(result)
}

enum PostJoin {
    Conflict(usize),
    Stop,
    Graded,
}

// The boundary join, the merge outcomes from `from` up to the next conflict, then the shutdown gate,
// the crash interrupts and the fan-out tallies: one stretch of the TypeScript between two awaits.
fn after_join(
    session: &mut Session,
    results: &[TicketResult],
    ready: &[TicketMarker],
    step: &StepMerges,
    from: usize,
) -> anyhow::Result<PostJoin> {
    if from == 0 {
        for result in results {
            if !result.joined_at_exit {
                session.apply(result.update.clone());
            }
        }
    }
    let merges = lock(&step.merges);
    for (index, merge) in merges.iter().enumerate().skip(from) {
        if !merge.result.ok {
            return Ok(PostJoin::Conflict(index));
        }
        let id = &merge.marker.id;
        session.merge_line.settled(id);
        append_event(
            Path::new(&session.runs_dir),
            id,
            &event_now(
                merge.attempt,
                TicketEventKind::Merged,
                merged_payload(&merge.result),
            ),
        )?;
        close_attempt_tab(session, id, merge.attempt);
        let branch = git::branch_for(&session.cwd, id, None);
        let range = (!merge.before_sha.is_empty())
            .then(|| format!("{}..{}", merge.before_sha, merge_target_ref(session)));
        crate::conversations::ticket_ended(session, &merge.marker, &branch, range);
        session.log(format!(
            "ticket {id}: merged {branch} onto the working branch{}",
            if merge.result.detail.ends_with("is gone") {
                format!(" ({})", merge.result.detail)
            } else {
                String::new()
            }
        ));
    }
    drop(merges);
    if session.children.stopping {
        // Shutdown (ADR-0017): no crash interrupts for the stopped attempts, nothing more scheduled.
        session.log(
            "engine shutdown: super-step joined; no crash interrupts raised and nothing more \
             scheduled",
        );
        return Ok(PostJoin::Stop);
    }
    for result in results {
        // A verify round that also holds a checkpointed candidate is owned by the checkpoint its
        // grading raises (ADR-0034).
        if result.plan.verify
            && results
                .iter()
                .any(|r| r.marker.id == result.marker.id && r.status == TicketStatus::Checkpoint)
        {
            continue;
        }
        if result.status == TicketStatus::InProgress {
            let reason = result.crash_reason.as_deref().unwrap_or("crashed");
            let body = crash_interrupt_body(&CrashFacts {
                crash_reason: reason,
                log_path: &result.log_path,
                log_tail: &result.log_tail,
                outcome_path: &result.outcome_path,
                outcome_exists: result.outcome_exists,
            });
            raise_interrupt(
                session,
                interrupt(&result.marker.id, InterruptKind::Crash, body),
            );
        }
    }
    for marker in ready {
        if session
            .assignments
            .get(&marker.id)
            .and_then(|a| a.verify)
            .is_none()
        {
            continue;
        }
        let attempts: Vec<&TicketResult> = results
            .iter()
            .filter(|r| r.marker.id == marker.id)
            .collect();
        let tally = |status: TicketStatus| attempts.iter().filter(|r| r.status == status).count();
        session.log(format!(
            "ticket {}: verify fan-out complete: {} attempts exited ({} done, {} checkpoint, {} \
             crash); no merge and no status write until grading",
            marker.id,
            attempts.len(),
            tally(TicketStatus::Done),
            tally(TicketStatus::Checkpoint),
            tally(TicketStatus::InProgress)
        ));
    }
    Ok(PostJoin::Graded)
}

/// `runSuperStep`: the fan-out, the serialised merge chain, the boundary join, the merge outcomes, the
/// crash interrupts, grading and selection, and the boundary persist.
pub async fn run_super_step(engine: &Engine, plan: SuperStepPlan) -> anyhow::Result<StepEnd> {
    let SuperStepPlan {
        ready,
        planned,
        snapshot,
    } = plan;
    // A ticket resumed from a checkpoint launches fresh: its old pane closes first (issue #139).
    let markers: Vec<TicketMarker> = planned.iter().map(|(m, _)| m.clone()).collect();
    crate::terminals::close_checkpointed_tabs(engine, &markers).await;
    let config = snapshot.config.clone();
    let ids: Vec<String> = planned.iter().map(|(m, _)| m.id.clone()).collect();
    let (env, assignments, chain) = engine
        .call(move |s| {
            let env = TicketEnv {
                engine: s.engine(),
                attempt: attempt_env_of(s, Some(&config)),
                pool_dir: s.pool_dir.clone(),
                issues_dir: s.issues_dir.clone(),
            };
            let assignments: Vec<_> = ids
                .iter()
                .map(|id| s.assignments.get(id).cloned().unwrap_or_default())
                .collect();
            (env, assignments, s.merge_chain.clone())
        })
        .await?;
    // Merges land in completion order: each ticket's merge chains onto a serialized queue the moment
    // the ticket finishes, starting from the session-wide chain.
    let step = Arc::new(StepMerges {
        queue: Mutex::new(chain.map(Ok).boxed().shared()),
        merges: Mutex::new(Vec::new()),
    });
    let runs = planned
        .into_iter()
        .zip(assignments)
        .map(|((marker, plan), assignment)| {
            let (env, snapshot, step) = (&env, &snapshot, Arc::clone(&step));
            async move {
                let id = marker.id.clone();
                let result = run_ticket(marker, snapshot, &assignment, env, plan).await;
                // Its ending, however it ends, ends its hold on the pool checkout.
                engine
                    .call(move |s| {
                        s.pool_checkout_planned.shift_remove(&id);
                    })
                    .await?;
                let result = result?;
                engine
                    .call(move |s| on_ticket_exit(s, result, &step))
                    .await?
            }
        });
    let mut results = Vec::new();
    for result in join_all(runs).await {
        results.push(result?);
    }
    let last = lock(&step.queue).clone();
    last.await.map_err(anyhow::Error::msg)?;
    let results = Arc::new(results);
    let ready = Arc::new(ready);
    let mut from = 0;
    loop {
        let (results_c, ready_c, step_c) =
            (Arc::clone(&results), Arc::clone(&ready), Arc::clone(&step));
        let next = engine
            .call(move |s| after_join(s, &results_c, &ready_c, &step_c, from))
            .await??;
        match next {
            PostJoin::Stop => return Ok(StepEnd::Stop),
            PostJoin::Graded => break,
            PostJoin::Conflict(index) => {
                let (marker, result, attempt) = {
                    let merges = lock(&step.merges);
                    let merge = &merges[index];
                    (merge.marker.clone(), merge.result.clone(), merge.attempt)
                };
                handle_merge_conflict(engine, marker, result, attempt).await?;
                from = index + 1;
            }
        }
    }
    // Grading (ticket 03): once every attempt of a verify ticket has exited.
    for marker in ready.iter() {
        let marker_c = marker.clone();
        let verify = engine
            .call(move |s| s.assignments.get(&marker_c.id).and_then(|a| a.verify))
            .await?;
        let Some(verify) = verify else {
            continue;
        };
        let mut attempts: Vec<u64> = results
            .iter()
            .filter(|r| r.marker.id == marker.id)
            .map(|r| r.plan.attempt)
            .collect();
        attempts.sort_unstable();
        // Both decisions can merge into the pool checkout, so the round waits at its gate first.
        if !pool_checkout_free(engine).await? {
            return Ok(StepEnd::Stop);
        }
        let what = format!(
            "the verify round of {} is deciding its merge into the pool checkout",
            marker.id
        );
        let hold = engine.call(move |s| hold_pool_checkout(s, what)).await?;
        let decided = decide_round(engine, marker, &results, &attempts, verify).await;
        engine.call(move |s| release_pool_checkout(s, hold)).await?;
        decided?;
    }
    // The boundary persist: an exhausted retry raises the persistence interrupt and stops scheduling.
    if !persist_with_retry(engine).await? {
        return Ok(StepEnd::Stop);
    }
    engine.call(|s| emit_snapshot(s, RunPhase::Running)).await?;
    Ok(StepEnd::Continue)
}

// A verify round's decision: lone-attempt resolution, a paused round's checkpoint, or Selection.
async fn decide_round(
    engine: &Engine,
    marker: &TicketMarker,
    results: &[TicketResult],
    attempts: &[u64],
    verify: u64,
) -> anyhow::Result<()> {
    let grades = crate::verify::grade_round(engine, marker, attempts).await?;
    let round: Vec<TicketResult> = results
        .iter()
        .filter(|r| r.marker.id == marker.id)
        .cloned()
        .collect();
    if verify == 1 && attempts.len() == 1 {
        let (marker, grade, lone) = (
            marker.clone(),
            grades.get(&attempts[0]).cloned(),
            round[0].clone(),
        );
        return engine
            .call(move |s| crate::verify::resolve_lone_attempt(s, &marker, &lone, grade.as_ref()))
            .await?;
    }
    if round.iter().any(|r| r.status == TicketStatus::Checkpoint) {
        let (marker, grades) = (marker.clone(), grades.clone());
        return engine
            .call(move |s| {
                let round: Vec<&TicketResult> = round.iter().collect();
                crate::verify::checkpoint_fan_out_round(s, &marker, &round, &grades)
            })
            .await?;
    }
    let all_graded: bool = attempts.iter().all(|a| grades.contains_key(a));
    if round.iter().all(|r| r.status == TicketStatus::Done) && all_graded {
        let human = engine
            .call(|s| s.state.config.selection_mode() == ac_protocol::SelectionMode::Human)
            .await?;
        if human {
            let (marker, attempts, grades) = (marker.clone(), attempts.to_vec(), grades.clone());
            engine
                .call(move |s| {
                    crate::verify::raise_selection_interrupt(s, &marker, &attempts, &grades);
                    emit_snapshot(s, RunPhase::Running);
                })
                .await?;
        } else {
            crate::verify::select_and_merge_winner(engine, marker, attempts, &grades).await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------
// The close
// ---------------------------------------------------------------------------------------------------

/// `closeDrive`: the Review gate, the phase decision, the final persist and the settle.
pub async fn close_drive(engine: &Engine) -> anyhow::Result<()> {
    // A closed ticket (issue #154) is finished too.
    let (pending, closed_ids, raised) = engine
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
            // the final Review; an approval recorded in state holds it down for good.
            let raise =
                pending.is_empty() && s.state.interrupts.is_empty() && !s.state.review_approved;
            if raise {
                let review = crate::interrupts::review_interrupt(s);
                raise_interrupt(s, review);
            }
            (pending, closed, raise)
        })
        .await?;
    if raised {
        persist_with_retry(engine).await?;
    }
    let pending_c = pending.clone();
    let mut phase = engine
        .call(move |s| {
            let pending = pending_c;
            // Tickets whose Attempt runs outside the drive (issue #139) end on their own.
            let outside: Vec<&String> = pending
                .iter()
                .filter(|id| s.live_attempts.is_live(id))
                .collect();
            let interrupts = !s.state.interrupts.is_empty();
            let phase = if interrupts
                || !outside.is_empty()
                || !s.continued_grades.is_empty()
                || spawns_await_boundary(s)
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
                    if !outside.is_empty() {
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
            // A proposal taken, or a Held spawn adopted, while this drive was closing waits for a
            // boundary this drive will not reach.
            if spawns_await_boundary(s) {
                phase = RunPhase::Quiescent;
            }
            emit_snapshot(s, phase);
            if phase != RunPhase::Quiescent {
                close_store(s);
            }
            settle_drive(s, Some(phase), None);
            drive_turned(s);
            // A Continued attempt's grading or spawns waiting to land kicked a drive that was still
            // in flight, which does nothing: the drive that closes starts the next. So does an answer
            // queued after the last boundary's drain.
            if !s.continued_grades.is_empty() || spawns_await_boundary(s) || s.queued_since_drain {
                crate::answers::kick_processing(s)?;
            }
            Ok(())
        })
        .await?
}
