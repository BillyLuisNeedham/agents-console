//! Restart (engine.ts 2407-2440, 2518-2891, 3232-3935): the boot notes, headless and terminal
//! orphans, terminal adoption and its finalize, and deferred merges. `rehydrate` itself is ported in
//! [`crate::boot`].
//!
//! What a previous engine process left behind is settled here before the drive schedules anything:
//! a headless attempt still running is stopped (ADR-0017), a terminal-backed attempt whose pane is
//! still alive is re-adopted and its ending recorded when it comes (ADR-0014), and a merge a shutdown
//! dropped at the pool checkout's gate is chained again (ADR-0027).
//!
//! Some of what adoption calls belongs to other ports (the Continued attempts, the enlisted runtime).
//! Those calls go through the small functions in [`peers`], each named for the TypeScript it stands
//! for, so the port that owns it replaces one body.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared, join_all};
use serde_json::{Map, Value};

use ac_core::assignment::engine_ticket_build_id;
use ac_core::events::{
    append_event, attempt_exit_code_name, attempt_log_name, attempt_outcome_name, event_now,
    read_events,
};
use ac_core::js;
use ac_core::outcome::{ValidOutcome, validate_outcome};
use ac_core::pool::{TicketMarker, write_marker_status};
use ac_io::git::WorktreeInfo;
use ac_io::herdr::{Herdr, PaneAgentState};
use ac_protocol::{
    InterruptKind, OutcomeStatus, RunPhase, TicketEvent, TicketEventKind, TicketStatus,
};

use crate::actor::Engine;
use crate::attempt_ending::{
    AttemptEndingDecision, AttemptEndingWait, AttemptWatch, exited_phrase, wait_for_attempt_ending,
};
use crate::attempt_run::{
    attempt_stream_path, read_log_tail, release_attempt_agent, report_attempt_agent,
    start_pane_stream_tail,
};
use crate::boot::engine_reset_note;
use crate::checkout_gate::{DeferredMerge, through_pool_checkout_gate};
use crate::interrupts::{
    ENGINE_BRIEF_HEADING, interrupt, land_checkpoint_brief, raise_checkpoint, raise_interrupt,
};
use crate::live_attempts::{self, LiveAttemptEntry};
use crate::merges::{
    handle_merge_conflict, merge_target_ref, merge_target_sha, merge_ticket, merged_payload,
};
use crate::session::{AdoptedAttempt, PoolUpdate, Session};
use crate::snapshot::emit_snapshot;
use crate::tickets::{CrashFacts, close_attempt_tab, crash_interrupt_body};

/// A headless attempt a previous engine process spawned and never saw exit, still alive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadlessOrphan {
    pub ticket_id: String,
    pub attempt: u64,
    pub pid: u32,
    pub cwd: String,
}

/// `headlessOrphans`: the headless attempts a previous engine process spawned and never saw exit, still
/// alive: every `spawned` event carrying a pid (headless spawns record one; terminal-backed spawns
/// record a pane id instead) with no `exited` or `crash` event for the same attempt after it, whose pid
/// is live in the attempt's spawn cwd. A live pid working elsewhere is a reused pid, not an orphan. A
/// verify fan-out can leave several per ticket.
pub fn headless_orphans(session: &Session, ticket_id: &str) -> Vec<HeadlessOrphan> {
    let events = read_events(Path::new(&session.runs_dir), ticket_id);
    let mut found = Vec::new();
    for (i, event) in events.iter().enumerate() {
        if event.kind != TicketEventKind::Spawned {
            continue;
        }
        let Some(pid) = event.payload.get("pid").and_then(pid_of) else {
            continue;
        };
        let Some(cwd) = event.payload.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        if ended_after(&events, i, event.attempt) {
            continue;
        }
        if !crate::children::orphan_is_live(pid, cwd) {
            continue;
        }
        found.push(HeadlessOrphan {
            ticket_id: ticket_id.to_owned(),
            attempt: event.attempt,
            pid,
            cwd: cwd.to_owned(),
        });
    }
    found
}

// A JSON number that names a process: JavaScript's `typeof pid === "number"`.
fn pid_of(value: &Value) -> Option<u32> {
    if !value.is_number() {
        return None;
    }
    let n = value
        .as_u64()
        .or_else(|| value.as_f64().map(|f| if f > 0.0 { f as u64 } else { 0 }))?;
    Some(u32::try_from(n).unwrap_or(u32::MAX))
}

// Whether an `exited` or `crash` event for the attempt follows event `index`.
fn ended_after(events: &[Arc<TicketEvent>], index: usize, attempt: u64) -> bool {
    events.iter().skip(index + 1).any(|other| {
        other.attempt == attempt
            && matches!(other.kind, TicketEventKind::Exited | TicketEventKind::Crash)
    })
}

/// `reapHeadlessOrphans`: stop the headless orphans rehydrate found (ADR-0017), each with the same
/// TERM-grace-KILL a shutdown uses, and record the crash on the ticket's log so the attempt no longer
/// reads as running. Awaited by the drive before its first scheduling, so the re-run never lands in a
/// worktree the orphan is still writing. Never fails: an orphan that survives even KILL (not ours to
/// signal) is logged and the pool carries on.
pub async fn reap_headless_orphans(engine: &Engine) {
    let Ok(orphans) = engine.call(|s| std::mem::take(&mut s.orphans)).await else {
        return;
    };
    if orphans.is_empty() {
        return;
    }
    join_all(orphans.into_iter().map(|orphan| {
        let engine = engine.clone();
        async move {
            let gone = crate::children::stop_orphan(orphan.pid, None).await;
            let _ = engine
                .call(move |s| record_stopped_orphan(s, &orphan, gone))
                .await;
        }
    }))
    .await;
}

fn record_stopped_orphan(
    session: &mut Session,
    orphan: &HeadlessOrphan,
    gone: bool,
) -> anyhow::Result<()> {
    let id = &orphan.ticket_id;
    let outcome_exists = js::exists(js::path_join(&[
        &session.runs_dir,
        &attempt_outcome_name(id, None, false),
    ]));
    let reason = if gone {
        format!(
            "orphan attempt (pid {}) from a previous engine process was still running at boot; \
             stopped by the engine",
            orphan.pid
        )
    } else {
        format!(
            "orphan attempt (pid {}) from a previous engine process was still running at boot and \
             survived the engine's stop",
            orphan.pid
        )
    };
    let mut payload = Map::new();
    payload.insert("code".into(), Value::Null);
    payload.insert("reason".into(), Value::String(reason));
    payload.insert("logTail".into(), Value::Array(Vec::new()));
    payload.insert("outcomeExists".into(), Value::Bool(outcome_exists));
    payload.insert("pid".into(), Value::from(orphan.pid));
    append_event(
        Path::new(&session.runs_dir),
        id,
        &event_now(orphan.attempt, TicketEventKind::Crash, payload),
    )?;
    session.apply(PoolUpdate::log([format!(
        "ticket {id}: orphan attempt {} (pid {}) {}",
        orphan.attempt,
        orphan.pid,
        if gone {
            "stopped at boot"
        } else {
            "could not be stopped at boot"
        }
    )]));
    Ok(())
}

/// The note a headless orphan leaves on its Issue at boot (ADR-0017).
pub fn engine_orphan_note(orphans: &[HeadlessOrphan]) -> String {
    let who = orphans
        .iter()
        .map(|o| format!("attempt {} (pid {})", o.attempt, o.pid))
        .collect::<Vec<_>>()
        .join(" and ");
    format!(
        "\n---\n\n{ENGINE_BRIEF_HEADING}\n\nThe engine process stopped while this ticket was \
         in-progress, and at the next boot {who} was found still running in the working tree. The \
         engine stopped it before scheduling anything, so the work is part done at best and the \
         agent left no brief. The ticket is back to ready; read the working tree before it runs \
         again.\n"
    )
}

// ---------------------------------------------------------------------------------------------------
// Terminal-backed boot reconciliation (ADR-0014)
// ---------------------------------------------------------------------------------------------------

/// A terminal attempt herdr recorded on a `spawned` event but never saw exit.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalOrphan {
    attempt: u64,
    pane_id: String,
}

// `terminalOrphan`: the newest `spawned` event carrying a pane id with no `exited` or `crash` event for
// the same attempt after it. Attempt numbers are unique per ticket, so "no exit event with that attempt
// number after the spawn" is exact.
fn terminal_orphan(session: &Session, ticket_id: &str) -> Option<TerminalOrphan> {
    let events = read_events(Path::new(&session.runs_dir), ticket_id);
    for (i, event) in events.iter().enumerate().rev() {
        if event.kind != TicketEventKind::Spawned {
            continue;
        }
        let Some(pane_id) = event.payload.get("pane_id").and_then(Value::as_str) else {
            continue;
        };
        if !ended_after(&events, i, event.attempt) {
            return Some(TerminalOrphan {
                attempt: event.attempt,
                pane_id: pane_id.to_owned(),
            });
        }
    }
    None
}

// `terminalAdoptable`: whether an orphaned terminal attempt can be re-adopted, or must keep the
// headless orphan fate. Only ordinary solo implement attempts qualify: engine-run tickets (graders,
// head-to-head) and verify candidates belong to machinery that cannot be re-entered at boot, and a
// resolver attempt belongs to the merge-conflict flow, which re-runs its resolver on answer.
fn terminal_adoptable(session: &Session, ticket_id: &str, attempt: u64) -> bool {
    if engine_ticket_build_id(ticket_id).is_some() {
        return false;
    }
    // A Continued attempt (issue #139) is re-entered by its own runtime, on a verify ticket too: it
    // runs alone, and its ending grades it as a lone attempt from wherever it lands.
    if peers::continued_work(session, ticket_id, attempt).is_some() {
        return true;
    }
    if session
        .assignments
        .get(ticket_id)
        .is_some_and(|a| a.verify.is_some())
    {
        return false;
    }
    !read_events(Path::new(&session.runs_dir), ticket_id)
        .iter()
        .any(|event| event.kind == TicketEventKind::Resolver && event.attempt == attempt)
}

// What one marker's reconciliation came to.
enum MarkerStep {
    Done,
    // An enlisted pane's liveness is asked of the daemon, which is an await.
    NeedsEnlistedLiveness,
}

/// `reconcileTerminalAttempts`: terminal-backed orphans are re-adopted when their pane is alive, or
/// crashed when it is gone; the ready ticket re-runs. A ticket that was mid-adoption when the engine
/// died again is re-entered the same way: its marker stayed in-progress with the adoption checkpoint
/// interrupt up. Never fails: reconciliation is advisory boot work, and a daemon that cannot be asked
/// changes nothing about the pool's ordinary recovery.
pub async fn reconcile_terminal_attempts(engine: &Engine) {
    let _ = reconcile(engine).await;
}

async fn reconcile(engine: &Engine) -> anyhow::Result<()> {
    let (terminal_backed, socket, workspace) = engine
        .call(|s| {
            (
                s.state.config.terminal() == Some(ac_protocol::TerminalKind::Herdr),
                s.herdr_socket.clone(),
                s.pool_workspace.id.clone(),
            )
        })
        .await?;
    if !terminal_backed {
        return Ok(());
    }
    let herdr = Herdr::new(&socket);
    // Scoped to the Pool workspace when there is one (issue #94): this pool's orphans can only be in
    // this pool's workspace. With no Pool workspace at all the listing stays daemon-wide.
    let Ok(live) = herdr.list_pane_ids(workspace.as_deref()).await else {
        engine
            .call(|s| {
                s.apply(PoolUpdate::log([
                    "terminal reconciliation skipped: herdr daemon unreachable".to_owned(),
                ]))
            })
            .await?;
        return Ok(());
    };
    let live: HashSet<String> = live.into_iter().collect();
    // An enlisted pane is the one orphan the scoped listing cannot answer for (issue #101): the
    // operator opened its tab in their own workspace. The daemon-wide listing is the only honest
    // answer, fetched once and only when an enlisted marker needs it.
    let mut enlisted_panes: Option<HashSet<String>> = None;
    let ids: Vec<String> = engine
        .call(|s| s.markers.iter().map(|m| m.id.clone()).collect())
        .await?;
    let mut log: Vec<String> = Vec::new();
    for id in ids {
        let first = {
            let (id, live) = (id.clone(), live.clone());
            engine
                .call(move |s| reconcile_marker(s, &id, &live, None))
                .await??
        };
        let (MarkerStep::NeedsEnlistedLiveness, _) = first else {
            log.extend(first.1);
            continue;
        };
        let pane_id = {
            let id = id.clone();
            engine
                .call(move |s| terminal_orphan(s, &id).map(|o| o.pane_id))
                .await?
        };
        let Some(pane_id) = pane_id else {
            continue;
        };
        let is_live = if let Some(panes) = &enlisted_panes {
            panes.contains(&pane_id)
        } else {
            match herdr.list_pane_ids(None).await {
                Ok(panes) => {
                    let panes: HashSet<String> = panes.into_iter().collect();
                    let is_live = panes.contains(&pane_id);
                    enlisted_panes = Some(panes);
                    is_live
                }
                // A listing the daemon cannot answer says nothing about the pane, so it is treated as
                // live and its ending stays with the Outcome race rather than being called gone on a
                // failed question.
                Err(_) => true,
            }
        };
        let live = live.clone();
        let (_, lines) = engine
            .call(move |s| reconcile_marker(s, &id, &live, Some(is_live)))
            .await??;
        log.extend(lines);
    }
    if !log.is_empty() {
        engine.call(move |s| s.apply(PoolUpdate::log(log))).await?;
    }
    Ok(())
}

// One marker's reconciliation, the TypeScript's loop body: everything between two awaits, so one job.
// `enlisted_live` is the daemon's answer for an enlisted marker's pane, once asked.
fn reconcile_marker(
    session: &mut Session,
    id: &str,
    live: &HashSet<String>,
    enlisted_live: Option<bool>,
) -> anyhow::Result<(MarkerStep, Vec<String>)> {
    let mut log = Vec::new();
    let Some(index) = session.markers.iter().position(|m| m.id == id) else {
        return Ok((MarkerStep::Done, log));
    };
    let marker = session.markers[index].clone();
    let Some(orphan) = terminal_orphan(session, id) else {
        return Ok((MarkerStep::Done, log));
    };
    // A parked checkpoint interrupt on an in-progress marker is the adoption pattern from a previous
    // boot: an ordinary checkpoint always writes its marker to "checkpoint" before raising, an adopted
    // attempt stays in-progress while it waits.
    let mid_adoption = marker.status == TicketStatus::InProgress
        && session
            .state
            .interrupts
            .iter()
            .any(|i| i.ticket_id == id && i.kind == InterruptKind::Checkpoint);
    if marker.status != TicketStatus::Ready && !mid_adoption {
        return Ok((MarkerStep::Done, log));
    }
    if !terminal_adoptable(session, id, orphan.attempt) {
        log.push(format!(
            "ticket {id}: orphaned terminal attempt {} kept the headless orphan fate (engine-run \
             or verify attempt)",
            orphan.attempt
        ));
        // Not adopted, so nothing in this engine will ever release the agent identity the dead one
        // reported for that pane (issue #94). Best-effort, like every release.
        release_orphan_agent(session, id, &orphan.pane_id);
        return Ok((MarkerStep::Done, log));
    }
    let enlisted = marker.enlisted_from.is_some();
    // The enlisted pane is asked for daemon-wide; every other orphan's pane can only be in the Pool
    // workspace, so the scoped answer stands.
    let pane_is_live = if enlisted {
        match enlisted_live {
            Some(is_live) => is_live,
            None => return Ok((MarkerStep::NeedsEnlistedLiveness, log)),
        }
    } else {
        live.contains(&orphan.pane_id)
    };
    if !pane_is_live {
        // An enlisted pane that went while the engine was down (issue #101): the attempt is over and
        // its Outcome either landed or did not. Either way this is the enlisted ending, not the
        // generic crash.
        if enlisted {
            strip_engine_reset_note(&marker.file)?;
            peers::end_enlisted_attempt(
                session,
                id,
                peers::EnlistedEnding::PaneGone,
                orphan.attempt,
            )?;
            log.push(format!(
                "ticket {id}: enlisted pane {} is gone at boot; the attempt is checkpointed with \
                 its branch kept",
                orphan.pane_id
            ));
            return Ok((MarkerStep::Done, log));
        }
        // The attempt's pane is gone: the attempt crashed. The ready ticket re-runs; a mid-adoption
        // ticket loses its interrupt and joins it.
        let outcome_exists = js::exists(js::path_join(&[
            &session.runs_dir,
            &attempt_outcome_name(id, None, false),
        ]));
        let mut payload = Map::new();
        payload.insert("code".into(), Value::Null);
        payload.insert(
            "reason".into(),
            Value::String("attempt pane gone at boot reconciliation".into()),
        );
        payload.insert("logTail".into(), Value::Array(Vec::new()));
        payload.insert("outcomeExists".into(), Value::Bool(outcome_exists));
        append_event(
            Path::new(&session.runs_dir),
            id,
            &event_now(orphan.attempt, TicketEventKind::Crash, payload),
        )?;
        if mid_adoption {
            let interrupts = session
                .state
                .interrupts
                .iter()
                .filter(|i| i.ticket_id != id)
                .cloned()
                .collect();
            session.apply(PoolUpdate {
                interrupts: Some(interrupts),
                ..PoolUpdate::default()
            });
            write_marker_status(&marker.file, TicketStatus::Ready)?;
            session.markers[index].status = TicketStatus::Ready;
            session.apply(PoolUpdate {
                tickets: Some([(id.to_owned(), TicketStatus::Ready)].into_iter().collect()),
                ..PoolUpdate::default()
            });
        }
        log.push(format!(
            "ticket {id}: attempt {}'s pane is gone at boot; the attempt crashed and the ticket \
             re-runs",
            orphan.attempt
        ));
        // The pane left this pool's workspace, which is not proof it left the daemon: it may still be
        // alive somewhere the listing no longer covers, carrying the dead engine's "working" binding.
        release_orphan_agent(session, id, &orphan.pane_id);
        return Ok((MarkerStep::Done, log));
    }
    adopt_terminal_attempt(session, index, &orphan, mid_adoption, &mut log)?;
    Ok((MarkerStep::Done, log))
}

// `releaseOrphanAgent`: drop the agent identity a dead engine reported for an orphan's pane (issue
// #94), for every orphan this boot does not adopt: the binding is keyed by (pane, source) and nothing
// else in this engine will ever release it. Best-effort and silent; skipped when the ticket's
// Assignment does not name a harness, since the agent name is half the key.
fn release_orphan_agent(session: &Session, ticket_id: &str, pane_id: &str) {
    let Some(harness) = harness_of(session, ticket_id) else {
        return;
    };
    release_pane_agent_quietly(&session.herdr_socket, pane_id, &harness);
}

// The harness a ticket's Assignment names, when it names one.
fn harness_of(session: &Session, ticket_id: &str) -> Option<String> {
    session
        .assignments
        .get(ticket_id)
        .map(|a| a.harness.clone())
        .filter(|h| !h.is_empty())
}

// A fire-and-forget `releasePaneAgent(socket, pane, harness.toLowerCase())`.
fn release_pane_agent_quietly(herdr_socket: &str, pane_id: &str, harness: &str) {
    let herdr = Herdr::new(herdr_socket);
    let (pane_id, agent) = (pane_id.to_owned(), harness.to_lowercase());
    tokio::spawn(async move {
        let _ = herdr.release_pane_agent(&pane_id, &agent).await;
    });
}

// `adoptTerminalAttempt`: re-adopt one live orphan (ADR-0014). A fresh adoption undoes rehydrate's
// reset for this ticket (marker back to in-progress, the reset note stripped, it was appended this
// boot) and raises the interrupt that keeps the pool honest about the wait. A mid-adoption restart
// keeps the interrupt it already has and only re-registers the wait.
fn adopt_terminal_attempt(
    session: &mut Session,
    index: usize,
    orphan: &TerminalOrphan,
    mid_adoption: bool,
    log: &mut Vec<String>,
) -> anyhow::Result<()> {
    let marker = session.markers[index].clone();
    let id = marker.id.clone();
    let enlisted = marker.enlisted_from.is_some();
    // A Continued attempt (issue #139) runs under the pane's Assignment, not the config's, and its
    // ending is its own race; recovered from its `spawned` event before anything below reports the
    // agent under it.
    let continued = peers::continued_work(session, &id, orphan.attempt);
    if let Some(continued) = &continued {
        let assignment = peers::pane_assignment(session, &id, continued);
        session.assignments.insert(id.clone(), assignment);
    }
    if !mid_adoption {
        write_marker_status(&marker.file, TicketStatus::InProgress)?;
        strip_engine_reset_note(&marker.file)?;
        session.markers[index].status = TicketStatus::InProgress;
        session.apply(PoolUpdate {
            tickets: Some(
                [(id.clone(), TicketStatus::InProgress)]
                    .into_iter()
                    .collect(),
            ),
            ..PoolUpdate::default()
        });
        let body = if enlisted {
            enlisted_adoption_body(session, &marker, orphan)
        } else {
            format!(
                "The engine restarted while this ticket's terminal-backed attempt {} was still \
                 running in herdr pane {}. The pane proved live at boot, so the engine re-adopted \
                 the attempt and is waiting on the pane's exit; the attempt's real outcome will be \
                 recorded then. Answering this interrupt abandons the attempt (the pane is closed) \
                 and re-runs the ticket.",
                orphan.attempt, orphan.pane_id
            )
        };
        raise_interrupt(session, interrupt(&id, InterruptKind::Checkpoint, body));
    }
    session.adopted.insert(
        id.clone(),
        AdoptedAttempt {
            pane_id: orphan.pane_id.clone(),
            attempt: orphan.attempt,
            abandoned: false,
        },
    );
    live_attempts::register(
        session,
        &id,
        LiveAttemptEntry::new(orphan.attempt, Some(orphan.pane_id.clone()), None),
    );
    let engine = session.engine();
    if enlisted {
        // An enlisted pane gets its runtime back, not only an ending wait: the runtime's tick is what
        // reports working or blocked to herdr's sidebar as the Turn state moves (spec, story 19).
        log.push(format!(
            "ticket {id}: enlisted attempt {} re-adopted from live pane {}; watching its Turn \
             state and waiting on its ending",
            orphan.attempt, orphan.pane_id
        ));
        let pane_id = orphan.pane_id.clone();
        tokio::spawn(async move {
            readopt_enlisted_runtime(&engine, id, pane_id).await;
        });
        return Ok(());
    }
    // The pane survived an engine that did not, and herdr forgot the agent identity the dead engine
    // reported for it (issue #94): report it again, so a restarted pool's re-adopted attempts are back
    // in the agent list beside its fresh ones.
    if let Some(harness) = harness_of(session, &id) {
        report_attempt_agent(
            &session.herdr_socket,
            &orphan.pane_id,
            &id,
            &marker.title,
            &harness,
            PaneAgentState::Working,
        );
    }
    if let Some(continued) = continued {
        log.push(format!(
            "ticket {id}: continued attempt {} re-adopted from live pane {}; waiting on its Outcome",
            orphan.attempt, orphan.pane_id
        ));
        peers::readopt_continued(session, &marker, orphan.attempt, continued);
        return Ok(());
    }
    log.push(format!(
        "ticket {id}: attempt {} re-adopted from live pane {}; waiting on its exit",
        orphan.attempt, orphan.pane_id
    ));
    tokio::spawn(async move {
        finalize_adopted_attempt(&engine, id).await;
    });
    Ok(())
}

// `enlistedAdoptionBody`: the adoption interrupt for an enlisted pane (issue #101): the pane is the
// operator's, so answering lets it go rather than closing it (ADR-0021).
fn enlisted_adoption_body(
    session: &Session,
    marker: &TicketMarker,
    orphan: &TerminalOrphan,
) -> String {
    let branch = session
        .enlisted_work
        .get(&marker.id)
        .map(|work| work.branch.clone())
        .unwrap_or_default();
    format!(
        "The engine restarted while enlisted attempt {} was still running in herdr pane {}, the \
         terminal you opened. The pane proved live at boot, so the engine re-adopted the attempt \
         and is watching the pane for its Outcome; the attempt's real outcome will be recorded \
         then. Answering this interrupt lets the pane go: it is left exactly as found, never \
         closed, and the ticket re-runs as an ordinary engine-launched attempt.{}",
        orphan.attempt,
        orphan.pane_id,
        peers::created_branch_note(session, &marker.id, &branch)
    )
}

// `readoptEnlistedRuntime`: register the enlisted runtime for a re-adopted pane (issue #101). The pane
// was taught before the restart, so no teaching Turn is queued; the harness and the found work come
// from the enlist `spawned` event `seedEnlistedWork` restored. A pane the runtime cannot claim (it
// could not be read, or an event from before the harness was recorded) falls back to the ending-only
// wait, logged, so the attempt is still recorded when it ends. An answer that let the pane go while the
// claim was in flight wins: the runtime is released again rather than left ticking.
async fn readopt_enlisted_runtime(engine: &Engine, id: String, pane_id: String) {
    let registration = {
        let (id, pane_id) = (id.clone(), pane_id.clone());
        engine
            .call(move |s| {
                let outcome_path =
                    js::path_join(&[&s.runs_dir, &attempt_outcome_name(&id, None, false)]);
                peers::EnlistedRegistration::of(
                    &id,
                    &pane_id,
                    s.enlisted_work.get(&id).cloned(),
                    harness_of(s, &id),
                    s.marker(&id).map(|m| m.title.clone()).unwrap_or_default(),
                    outcome_path,
                )
            })
            .await
    };
    let Ok(registration) = registration else {
        return;
    };
    let result = match registration {
        Some(registration) => peers::register_enlisted(engine, registration).await,
        None => Err("no found work or harness on record".to_owned()),
    };
    let _ = engine
        .call(move |s| {
            let harness = harness_of(s, &id);
            if !s.adopted.contains_key(&id) {
                // Let go while the claim was in flight: the claim reported the identity after the
                // answer released it, so release it again with the runtime.
                peers::release_enlisted(s, &id);
                if let Some(harness) = harness {
                    release_pane_agent_quietly(&s.herdr_socket, &pane_id, &harness);
                }
                return;
            }
            let Err(reason) = result else {
                return;
            };
            // The ending-only wait reports nothing, so the identity is reported once here, as every
            // re-adopted attempt's is (issue #94).
            let title = s.marker(&id).map(|m| m.title.clone()).unwrap_or_default();
            if let Some(harness) = harness {
                report_attempt_agent(
                    &s.herdr_socket,
                    &pane_id,
                    &id,
                    &title,
                    &harness,
                    PaneAgentState::Working,
                );
            }
            s.apply(PoolUpdate::log([format!(
                "ticket {id}: re-adopted pane {pane_id} could not be claimed ({reason}); waiting \
                 on its ending only"
            )]));
            let engine = s.engine();
            tokio::spawn(async move {
                finalize_adopted_enlisted(&engine, id).await;
            });
        })
        .await;
}

// `finalizeAdoptedEnlisted`: the enlisted attempt's ending-only boot finalize (issue #101, ticket 04):
// the fallback for a re-adopted pane whose runtime could not be re-registered, so its ending is still
// recorded. There is no wrapper and so no exit-code file, so the wait is the enlisted module's two-form
// race, Outcome against pane gone, rather than the generic `waitForAttemptEnding`.
async fn finalize_adopted_enlisted(engine: &Engine, id: String) {
    let facts = {
        let id = id.clone();
        engine
            .call(move |s| {
                s.adopted.get(&id).cloned().map(|adopted| {
                    (
                        adopted,
                        s.herdr_socket.clone(),
                        js::path_join(&[&s.runs_dir, &attempt_outcome_name(&id, None, false)]),
                        s.enlist_poll_ms,
                    )
                })
            })
            .await
    };
    let Ok(Some((adopted, socket, outcome_path, poll_ms))) = facts else {
        return;
    };
    let Some(ending) =
        peers::wait_for_enlisted_ending(&socket, &adopted.pane_id, &outcome_path, poll_ms).await
    else {
        return;
    };
    let _ = engine
        .call(move |s| {
            if !still_adopted(s, &id, &adopted) {
                return Ok(());
            }
            s.adopted.remove(&id);
            peers::end_enlisted_attempt(s, &id, ending, adopted.attempt)
        })
        .await;
}

// Whether the adoption a finalize began with still stands: the map entry is the ownership record, so a
// missing or flagged entry means the answer path owns the ticket from here.
fn still_adopted(session: &Session, id: &str, adopted: &AdoptedAttempt) -> bool {
    session.adopted.get(id).is_some_and(|current| {
        !current.abandoned
            && current.attempt == adopted.attempt
            && current.pane_id == adopted.pane_id
    })
}

/// `stripEngineResetNote`: remove the note rehydrate appended this boot: it is a known constant and is
/// the file's tail, having just been appended by this process.
pub fn strip_engine_reset_note(issue_file: &Path) -> anyhow::Result<()> {
    let text = js::read_text(issue_file)?;
    let note = engine_reset_note();
    let Some(rest) = text.strip_suffix(note.as_str()) else {
        return Ok(());
    };
    js::write_file(issue_file, rest)?;
    Ok(())
}

/// `abandonAdoption`: answering the adoption interrupt abandons the re-adopted attempt: the pane is
/// closed, the finalize records nothing, and the generic answer handling re-runs the ticket from its
/// reset marker. An enlisted pane is the operator's and is never closed (ADR-0021): the pool lets it go
/// instead, releasing the runtime and the agent identity it had claimed, and drops the as-found record
/// so the re-run is an ordinary engine-launched attempt with a real Assignment in a pool worktree,
/// never a fresh attempt launched into the operator's own checkout with no model.
pub fn abandon_adoption(session: &mut Session, ticket_id: &str) -> anyhow::Result<()> {
    let Some(adopted) = session.adopted.remove(ticket_id) else {
        return Ok(());
    };
    live_attempts::clear(session, ticket_id, adopted.attempt);
    let marker = session.marker(ticket_id).cloned();
    // A re-adopted Continued attempt (issue #139) has a runtime of its own watching the pane; it lets
    // go here, and the pane closes below as any abandoned adoption's does.
    if peers::release_continued(session, ticket_id)
        && let Some(marker) = &marker
    {
        peers::restore_assignment(session, marker);
    }
    if let Some(marker) = marker.filter(|m| m.enlisted_from.is_some()) {
        peers::release_enlisted(session, ticket_id);
        if let Some(harness) = harness_of(session, ticket_id) {
            release_pane_agent_quietly(&session.herdr_socket, &adopted.pane_id, &harness);
        }
        session.enlisted_work.remove(ticket_id);
        session.held.shift_remove(ticket_id);
        // Recorded, so a restart does not restore the found work from the enlist's event and take the
        // let-go pane back as the Ticket's.
        let mut payload = Map::new();
        payload.insert("pane_id".into(), Value::String(adopted.pane_id.clone()));
        append_event(
            Path::new(&session.runs_dir),
            ticket_id,
            &event_now(adopted.attempt, TicketEventKind::LetGo, payload),
        )?;
        let assignment = peers::re_run_assignment(session, &marker)?;
        session.assignments.insert(ticket_id.to_owned(), assignment);
        session.apply(PoolUpdate::log([format!(
            "ticket {ticket_id}: adoption abandoned (interrupt answered); enlisted pane {} left as \
             found and the ticket re-runs as an ordinary attempt",
            adopted.pane_id
        )]));
        return Ok(());
    }
    let herdr = Herdr::new(&session.herdr_socket);
    let pane_id = adopted.pane_id.clone();
    tokio::spawn(async move {
        let _ = herdr.close_pane(&pane_id).await;
    });
    session.apply(PoolUpdate::log([format!(
        "ticket {ticket_id}: adoption abandoned (interrupt answered); pane {} closed and the ticket \
         re-runs",
        adopted.pane_id
    )]));
    Ok(())
}

// ---------------------------------------------------------------------------------------------------
// The adopted attempt's ending
// ---------------------------------------------------------------------------------------------------

// What `finalizeAdoptedAttempt` reads before its first await.
struct Finalizing {
    adopted: AdoptedAttempt,
    harness: String,
    socket: String,
    stream_path: Option<String>,
    log_path: String,
    exit_code_path: String,
    outcome_path: String,
}

/// `finalizeAdoptedAttempt`: the adopted attempt's background ending (ADR-0014, amended by ADR-0016):
/// waits for the attempt's Outcome, or the pane's loss without one, then records the attempt's exit
/// exactly the way a launched attempt's tail would: the exited event on every ending, the crash event
/// and interrupt on a bad exit, the marker status and checkpoint Brief on a clean one, and a done
/// ticket's merge chained onto the session merge chain so it never runs its git work concurrently with
/// the drive's merges. Never fails: it is advisory bookkeeping alongside the drive.
pub async fn finalize_adopted_attempt(engine: &Engine, id: String) {
    let facts = {
        let id = id.clone();
        engine
            .call(move |s| {
                let adopted = s.adopted.get(&id)?.clone();
                s.marker(&id)?;
                let harness = s
                    .assignments
                    .get(&id)
                    .map(|a| a.harness.clone())
                    .unwrap_or_default();
                // Adopted attempts are terminal-backed by definition (they have a pane); their Stream
                // file is the `script` typescript the killed engine's pane kept writing, so deriving
                // it whole reproduces the log exactly.
                let stream_path =
                    attempt_stream_path(&s.runs_dir, &id, &harness, None, false, true);
                Some(Finalizing {
                    adopted,
                    harness,
                    socket: s.herdr_socket.clone(),
                    stream_path,
                    log_path: js::path_join(&[&s.runs_dir, &attempt_log_name(&id, None, false)]),
                    exit_code_path: js::path_join(&[
                        &s.runs_dir,
                        &attempt_exit_code_name(&id, None, false),
                    ]),
                    outcome_path: js::path_join(&[
                        &s.runs_dir,
                        &attempt_outcome_name(&id, None, false),
                    ]),
                })
            })
            .await
    };
    let Ok(Some(facts)) = facts else {
        return;
    };
    let tailer = facts
        .stream_path
        .as_deref()
        .map(|stream| start_pane_stream_tail(stream, &facts.log_path, 0));
    // The adopted attempt's ending is the Attempt-ending module's one decision, exactly as a live
    // terminal-backed spawn's: a pane watch (pane end against the exit-code file, pane loss without an
    // Outcome the crash signal) raced against the result-file poll, because the TUI deliberately stays
    // alive after the agent declares done (ADR-0016). An exit-code file written while the engine was
    // down resolves immediately, without opening a connection.
    let decision = wait_for_attempt_ending(AttemptEndingWait {
        watch: AttemptWatch::Pane {
            herdr: Herdr::new(&facts.socket),
            pane_id: facts.adopted.pane_id.clone(),
        },
        exit_code_path: facts.exit_code_path.clone(),
        outcome_path: facts.outcome_path.clone(),
        validate: validate_outcome,
        crash_subject: "harness".to_owned(),
        tracker: None,
        cadence: None,
    })
    .await;
    // Drained ahead of the log-tail read, so the exit facts are complete; also drained on an
    // abandoned wait, whose return skips the record but never the drain.
    if let Some(tailer) = tailer {
        let _ = tailer.finish().await;
    }
    let Ok(decision) = decision else {
        return;
    };
    let _ = engine
        .call(move |s| {
            // The adopted Attempt is over: its pane leaves herdr's agent list the way a freshly
            // launched attempt's does at its own ending (issue #94). Before the abandonment checks,
            // because an abandoned adoption closed the pane and the identity must go either way.
            if !facts.harness.is_empty() {
                release_attempt_agent(&facts.socket, &facts.adopted.pane_id, &facts.harness);
            }
            // Abandoned while waiting (the human answered): the answer path owns the ticket now and
            // this finalize records nothing further.
            if !still_adopted(s, &id, &facts.adopted) {
                return Ok(());
            }
            let Some(marker) = s.marker(&id).cloned() else {
                return Ok(());
            };
            // Ownership passes to the recorded exit: from here a later answer is ordinary interrupt
            // handling, never an abandonment.
            s.adopted.remove(&id);
            live_attempts::clear(s, &id, facts.adopted.attempt);
            record_adopted_exit(
                s,
                &marker,
                facts.adopted.attempt,
                &decision,
                &facts.log_path,
                &facts.outcome_path,
                "adopted attempt",
            )
        })
        .await;
}

/// `recordAdoptedExit`: record one adopted attempt's exit (ADR-0014): the mirror of a launched
/// attempt's exit tail, without the spawn-time parts. A Continued attempt (issue #139) ends through
/// here too: like an adopted one it runs in a pane the drive is not waiting on, and its ending is
/// recorded the same way; `what` names which of the two the pool log is talking about. Consumes the
/// Attempt-ending module's decision rather than re-reading and re-deriving it; what stays here is its
/// own: the marker status write, the checkpoint Brief, the interrupt and the merge chaining.
pub fn record_adopted_exit(
    session: &mut Session,
    marker: &TicketMarker,
    attempt: u64,
    decision: &AttemptEndingDecision<ValidOutcome>,
    log_path: &str,
    outcome_path: &str,
    what: &str,
) -> anyhow::Result<()> {
    let id = marker.id.clone();
    let runs_dir = session.runs_dir.clone();
    let runs = Path::new(&runs_dir);
    let code = decision.code;
    let crash_reason = decision.crash_reason.as_deref();
    // Where the attempt's work is: the worktree and branch its `spawned` event recorded (a Continued
    // attempt's names the worktree of the attempt it continues), or none when it ran in the pool
    // checkout itself, whose done work is already on the working branch.
    let recorded = read_events(runs, &id)
        .into_iter()
        .rfind(|event| event.kind == TicketEventKind::Spawned && event.attempt == attempt);
    let worktree = recorded.and_then(|event| {
        let cwd = event.payload.get("cwd").and_then(Value::as_str)?;
        let branch = event.payload.get("branch").and_then(Value::as_str)?;
        Some(WorktreeInfo {
            path: cwd.to_owned(),
            branch: branch.to_owned(),
        })
    });
    let outcome_exists = js::exists(outcome_path);
    let log_tail = read_log_tail(log_path);
    let outcome = decision.result.as_ref().ok();
    let status = match outcome {
        Some(valid) if crash_reason.is_none() => match valid.outcome.status {
            OutcomeStatus::Done => TicketStatus::Done,
            OutcomeStatus::Checkpoint => TicketStatus::Checkpoint,
        },
        _ => TicketStatus::InProgress,
    };
    let exit_payload = |with_status: bool, reason: Option<&str>| {
        let mut payload = Map::new();
        payload.insert("code".into(), Value::from(code));
        if with_status {
            payload.insert("status".into(), Value::String(status.to_string()));
        }
        if let Some(reason) = reason {
            payload.insert("reason".into(), Value::String(reason.to_owned()));
        }
        payload.insert("logTail".into(), Value::from(log_tail.clone()));
        payload.insert("outcomeExists".into(), Value::Bool(outcome_exists));
        payload
    };
    append_event(
        runs,
        &id,
        &event_now(attempt, TicketEventKind::Exited, exit_payload(true, None)),
    )?;
    if let Some(reason) = crash_reason {
        append_event(
            runs,
            &id,
            &event_now(
                attempt,
                TicketEventKind::Crash,
                exit_payload(false, Some(reason)),
            ),
        )?;
    } else {
        write_marker_status(&marker.file, status)?;
        if let Some(own) = session.marker_mut(&id) {
            own.status = status;
        }
        if status == TicketStatus::Checkpoint {
            land_checkpoint_brief(
                &marker.file,
                outcome.and_then(|valid| valid.outcome.brief.as_deref()),
            )?;
        }
    }
    let mut line = format!(
        "ticket {id}: {what} {attempt} {}, marker {status}",
        exited_phrase(code)
    );
    if let Some(reason) = crash_reason {
        line.push_str(&format!(", crash: {reason}"));
    }
    let interrupts = session
        .state
        .interrupts
        .iter()
        .filter(|i| i.ticket_id != id)
        .cloned()
        .collect();
    session.apply(PoolUpdate {
        tickets: Some([(id.clone(), status)].into_iter().collect()),
        interrupts: Some(interrupts),
        log: Some(vec![line]),
        outcomes: outcome.map(|valid| [(id.clone(), valid.outcome.clone())].into_iter().collect()),
        ..PoolUpdate::default()
    });
    let current = session
        .marker(&id)
        .cloned()
        .unwrap_or_else(|| marker.clone());
    if let Some(reason) = crash_reason {
        let body = crash_interrupt_body(&CrashFacts {
            crash_reason: reason,
            log_path,
            log_tail: &log_tail,
            outcome_path,
            outcome_exists,
        });
        raise_interrupt(session, interrupt(&id, InterruptKind::Crash, body));
    } else if status == TicketStatus::Checkpoint {
        raise_checkpoint(session, &current, attempt, None)?;
    }
    // The branch is checked by name as recorded: branch_exists would name it again from the ticket id.
    if status == TicketStatus::Done
        && let Some(worktree) = worktree
        && ac_io::git::git(
            &session.cwd,
            [
                "rev-parse".to_owned(),
                "--verify".to_owned(),
                format!("refs/heads/{}", worktree.branch),
            ],
        )
        .ok
    {
        // The merge chains onto the session merge chain: the drive's merges wait for it and it waits
        // for them, so two git merges never run concurrently on the main checkout. The kick below runs
        // only once the chain settles, so a resumed drive's closing gate can never raise the Review
        // interrupt ahead of this merge landing.
        session.merge_line.taken(&id);
        drop(merge_done_ticket(
            session, current, worktree, attempt, what, true,
        ));
    } else {
        finish_adopted_finalize(session);
    }
    Ok(())
}

/// A merge chained onto the session's merge chain, settled when the merge has run.
pub type MergeLink = Shared<BoxFuture<'static, Result<(), String>>>;

/// `mergeDoneTicket`: merge a done ticket's worktree branch off the drive loop: an adopted or a
/// Continued attempt's ending, or a merge a shutdown dropped at the pool checkout's gate and the next
/// boot takes up again (ADR-0027). It chains onto the session merge chain, so two git merges never run
/// at once on the main checkout, passes the gate inside its link, and records the merge exactly as the
/// drive's own merges do: the merged event, the tab close, the done-Notice, the pool log; a conflict
/// goes to the resolver machinery. With `finish` the link ends in [`finish_adopted_finalize`], however
/// the merge went.
pub fn merge_done_ticket(
    session: &mut Session,
    marker: TicketMarker,
    worktree: WorktreeInfo,
    attempt: u64,
    what: &str,
    finish: bool,
) -> MergeLink {
    let engine = session.engine();
    let previous = session.merge_chain.clone();
    let what = what.to_owned();
    let link_engine = engine.clone();
    let link: MergeLink = async move {
        previous.await;
        merge_link(&link_engine, marker, worktree, attempt, what).await
    }
    .boxed()
    .shared();
    session.merge_chain = link.clone().map(drop).boxed().shared();
    let driven = link.clone();
    tokio::spawn(async move {
        let _ = driven.await;
        if finish {
            let _ = engine.call(finish_adopted_finalize).await;
        }
    });
    link
}

// The merge inside its link: through the gate, recorded as the drive's own merges are, a conflict to the
// resolver.
async fn merge_link(
    engine: &Engine,
    marker: TicketMarker,
    worktree: WorktreeInfo,
    attempt: u64,
    what: String,
) -> Result<(), String> {
    let deferred = DeferredMerge {
        ticket_id: marker.id.clone(),
        path: worktree.path.clone(),
        branch: worktree.branch.clone(),
        attempt,
    };
    let (merge_marker, merge_worktree) = (marker.clone(), worktree);
    let passed = through_pool_checkout_gate(engine, Some(deferred), move |s| {
        let (marker, worktree) = (merge_marker, merge_worktree);
        // Captured inside the serialized chain, right before the merge: HEAD may have moved since this
        // ticket's attempt ended (another merge landing first), and merge_ticket removes this branch
        // on success, so the range for a done-Notice's diff summary has to be taken here or not at all.
        let before_sha = merge_target_sha(s);
        let merge = merge_ticket(s, &marker, &worktree)?;
        if !merge.ok {
            return Ok(Some(merge));
        }
        s.merge_line.settled(&marker.id);
        append_event(
            Path::new(&s.runs_dir),
            &marker.id,
            &event_now(attempt, TicketEventKind::Merged, merged_payload(&merge)),
        )?;
        close_attempt_tab(s, &marker.id, attempt);
        let range =
            (!before_sha.is_empty()).then(|| format!("{before_sha}..{}", merge_target_ref(s)));
        crate::conversations::ticket_ended(s, &marker, &worktree.branch, range);
        s.apply(PoolUpdate::log([format!(
            "ticket {}: {what} {attempt} merged {} onto the working branch",
            marker.id, worktree.branch
        )]));
        Ok(None)
    })
    .await
    .map_err(|error| error.to_string())?;
    if let Some(Some(merge)) = passed {
        handle_merge_conflict(engine, marker, merge, attempt)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// `finishAdoptedFinalize`: the adopted finalize's last step, after its merge chain has settled: emit
/// the new state, persist it, and kick a drive pass when the run had already settled (it was waiting
/// quiescent on the adoption interrupt), so the closing gate, the ready set, and any queued answers see
/// the attempt's real ending. The kick is a no-op while a drive is in flight; its boundary machinery
/// picks the state up instead.
pub fn finish_adopted_finalize(session: &mut Session) {
    let phase = if session.driving {
        RunPhase::Running
    } else {
        RunPhase::Quiescent
    };
    emit_snapshot(session, phase);
    // The next boundary persist (or the persistence interrupt machinery) owns store failures; the
    // finalize's record must not die on one.
    let _ = crate::persist::persist(session);
    let _ = crate::answers::kick_processing(session);
}

// ---------------------------------------------------------------------------------------------------
// Deferred merges (ADR-0027)
// ---------------------------------------------------------------------------------------------------

/// `redoDeferredMerges`: chain again every merge a shutdown dropped at the pool checkout's gate: a done
/// ticket whose last `merge-deferred` has no merge record after it (merged, merge-conflict,
/// merge-blocked, resolver) and no merge interrupt waiting. Through the ordinary path, so the merge
/// passes the gate again (a re-adopted Continued attempt may still hold the checkout), lands or goes to
/// the resolver machinery as any merge does, and takes its place in the Merge queue rather than
/// standing there stalled.
pub fn redo_deferred_merges(session: &mut Session) {
    for index in 0..session.markers.len() {
        let marker = session.markers[index].clone();
        if session.status_of(&marker.id) != Some(TicketStatus::Done) {
            continue;
        }
        if session.state.interrupts.iter().any(|i| {
            i.ticket_id == marker.id
                && matches!(
                    i.kind,
                    InterruptKind::MergeConflict | InterruptKind::MergeApproval
                )
        }) {
            continue;
        }
        let events = read_events(Path::new(&session.runs_dir), &marker.id);
        let Some(deferred_at) = events
            .iter()
            .rposition(|event| event.kind == TicketEventKind::MergeDeferred)
        else {
            continue;
        };
        let settled = events.iter().skip(deferred_at + 1).any(|event| {
            matches!(
                event.kind,
                TicketEventKind::Merged
                    | TicketEventKind::MergeConflict
                    | TicketEventKind::MergeBlocked
                    | TicketEventKind::Resolver
            )
        });
        if settled {
            continue;
        }
        let deferred = &events[deferred_at];
        // The ticket ran again since (a later attempt spawned): that attempt's own ending decides its
        // merge, not this old record.
        if events
            .iter()
            .skip(deferred_at + 1)
            .any(|event| event.kind == TicketEventKind::Spawned && event.attempt > deferred.attempt)
        {
            continue;
        }
        let (Some(path), Some(branch)) = (
            deferred.payload.get("path").and_then(Value::as_str),
            deferred.payload.get("branch").and_then(Value::as_str),
        ) else {
            continue;
        };
        let (path, branch) = (path.to_owned(), branch.to_owned());
        session.apply(PoolUpdate::log([format!(
            "ticket {}: merge dropped at the last shutdown chained again",
            marker.id
        )]));
        if marker.enlisted_from.is_some() && session.enlisted_work.contains_key(&marker.id) {
            peers::chain_enlisted_merge(session, &marker, deferred.attempt, &branch);
            continue;
        }
        session.merge_line.taken(&marker.id);
        drop(merge_done_ticket(
            session,
            marker,
            WorktreeInfo { path, branch },
            deferred.attempt,
            "attempt",
            true,
        ));
    }
}

/// What restart calls that belong to the ports of the Continued attempts and the enlisted runtime.
/// Each function is named for the TypeScript it stands for and holds the narrowest behaviour of a pool
/// without that feature in flight; the port that owns the feature replaces the body.
#[allow(dead_code)] // stubs until the owning ports land
mod peers {
    use ac_core::assignment::Assignment;
    use ac_core::pool::TicketMarker;

    use crate::actor::Engine;
    use crate::session::{EnlistedWork, Session};

    /// A Continued attempt's facts read back from its `spawned` event (`continuedWork`).
    pub use crate::held::ContinuedWork;

    /// `continuedWork`.
    pub fn continued_work(
        session: &Session,
        ticket_id: &str,
        attempt: u64,
    ) -> Option<ContinuedWork> {
        crate::held::continued_work(session, ticket_id, attempt)
    }

    /// `paneAssignment`.
    pub fn pane_assignment(session: &Session, ticket_id: &str, work: &ContinuedWork) -> Assignment {
        crate::held::pane_assignment(session, ticket_id, &work.pane)
    }

    /// `restoreAssignment`.
    pub fn restore_assignment(session: &mut Session, marker: &TicketMarker) {
        crate::held::restore_assignment(session, marker);
    }

    /// `readoptContinued`: re-register a Continued attempt's runtime for a live pane.
    pub fn readopt_continued(
        session: &mut Session,
        marker: &TicketMarker,
        attempt: u64,
        work: ContinuedWork,
    ) {
        crate::keep_talking::readopt_continued(session, marker, attempt, work);
    }

    /// `session.continued.get(id)`'s runtime released and the entry deleted, as `abandonAdoption`
    /// does; whether there was one.
    pub fn release_continued(session: &mut Session, ticket_id: &str) -> bool {
        crate::keep_talking::release_continued(session, ticket_id)
    }

    /// How an enlisted attempt ended (enlisted.ts `EnlistedEnding`). PEER(enlisted).
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum EnlistedEnding {
        Outcome,
        PaneGone,
    }

    /// `endEnlistedAttempt`. PEER(enlist_flow): records nothing.
    pub fn end_enlisted_attempt(
        session: &mut Session,
        ticket_id: &str,
        ending: EnlistedEnding,
        attempt: u64,
    ) -> anyhow::Result<()> {
        let _ = (session, ticket_id, ending, attempt);
        Ok(())
    }

    /// `chainEnlistedMerge`. PEER(enlist_flow).
    pub fn chain_enlisted_merge(
        session: &mut Session,
        marker: &TicketMarker,
        attempt: u64,
        branch: &str,
    ) {
        let _ = (session, marker, attempt, branch);
    }

    /// What `session.enlisted.register` takes for a re-adopted pane.
    #[derive(Debug, Clone)]
    pub struct EnlistedRegistration {
        pub id: String,
        pub pane_id: String,
        pub harness: String,
        pub title: String,
        pub branch: String,
        pub directory: String,
        pub outcome_path: String,
    }

    impl EnlistedRegistration {
        /// The registration, or `None` when there is no found work or no harness on record.
        pub fn of(
            id: &str,
            pane_id: &str,
            work: Option<EnlistedWork>,
            harness: Option<String>,
            title: String,
            outcome_path: String,
        ) -> Option<Self> {
            let (work, harness) = (work?, harness?);
            Some(EnlistedRegistration {
                id: id.to_owned(),
                pane_id: pane_id.to_owned(),
                harness,
                title,
                branch: work.branch,
                directory: work.directory,
                outcome_path,
            })
        }
    }

    /// `session.enlisted.register`: claim the pane's runtime; the reason when it cannot be claimed.
    /// PEER(enlisted).
    pub async fn register_enlisted(
        engine: &Engine,
        registration: EnlistedRegistration,
    ) -> Result<(), String> {
        let _ = (engine, registration);
        Err("the enlisted runtime is not ported yet".to_owned())
    }

    /// `session.enlisted.release`. PEER(enlisted).
    pub fn release_enlisted(session: &mut Session, ticket_id: &str) {
        let _ = (session, ticket_id);
    }

    /// `waitForEnlistedEnding`: the two-form race, Outcome against pane gone; `None` when the wait
    /// threw. PEER(enlisted).
    pub async fn wait_for_enlisted_ending(
        herdr_socket: &str,
        pane_id: &str,
        outcome_path: &str,
        poll_ms: Option<u64>,
    ) -> Option<EnlistedEnding> {
        let _ = (herdr_socket, pane_id, outcome_path, poll_ms);
        None
    }

    /// `createdBranchNote`: the re-run of a created-branch enlist (spec story 11) needs the branch
    /// free: a Brief that offers the re-run says so up front.
    pub fn created_branch_note(session: &Session, ticket_id: &str, branch: &str) -> String {
        let Some(work) = session.enlisted_work.get(ticket_id) else {
            return String::new();
        };
        if work.branch != branch || branch != ac_io::git::branch_for(&session.cwd, ticket_id, None)
        {
            return String::new();
        }
        format!(
            " The enlist created {branch} in that checkout, and a re-run needs the branch free: \
             check another branch out there first, or the re-run waits as a checkpoint until you do."
        )
    }

    /// `reRunAssignment`: the Assignment a ticket that stopped being an enlisted attempt runs on: the
    /// ordinary pool assignment for its id, with verify stripped (an enlisted id never fans out).
    pub fn re_run_assignment(
        session: &Session,
        marker: &TicketMarker,
    ) -> anyhow::Result<Assignment> {
        let mut resolved = ac_core::assignment::resolve_ticket_assignment(
            marker,
            &session.state.config,
            &session.harnesses,
        )?;
        resolved.verify = None;
        Ok(resolved)
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    use ac_protocol::TicketEventKind as Kind;

    use super::*;
    use crate::testkit::{Pool, Script, pool_git, settled, wait_for};

    fn orphan(attempt: u64, pid: u32) -> HeadlessOrphan {
        HeadlessOrphan {
            ticket_id: "01".into(),
            attempt,
            pid,
            cwd: "/w".into(),
        }
    }

    #[test]
    fn the_orphan_note_names_each_attempt_and_pid() {
        let note = engine_orphan_note(&[orphan(1, 10), orphan(2, 11)]);
        assert!(note.contains("attempt 1 (pid 10) and attempt 2 (pid 11) was found still running"));
        assert!(note.starts_with(&format!("\n---\n\n{ENGINE_BRIEF_HEADING}\n\n")));
    }

    #[test]
    fn the_reset_note_is_stripped_only_from_the_files_tail() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("01.md");
        let body = "<!-- state: id=01 blocked-by=none status=ready -->\n\n# 01\n";
        std::fs::write(&file, format!("{body}{}", engine_reset_note())).unwrap();
        strip_engine_reset_note(&file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), body);
        // A file that does not end with the note is left alone, as is one that never had it.
        std::fs::write(&file, format!("{}{body}", engine_reset_note())).unwrap();
        strip_engine_reset_note(&file).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            format!("{}{body}", engine_reset_note())
        );
    }

    // A process in its own group, in `cwd`, reaped on a thread so a stop sees it gone.
    fn sleeper(cwd: &str) -> u32 {
        let mut child = Command::new("sleep")
            .arg("60")
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        pid
    }

    fn spawned_event(attempt: u64, payload: serde_json::Value) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "at": "2026-10-04T09:00:00.000Z",
                "attempt": attempt,
                "kind": "spawned",
                "payload": payload,
            })
        )
    }

    fn set_status(pool: &Pool, rel: &str, from: &str, to: &str) {
        let text = pool
            .read(rel)
            .replacen(&format!("status={from}"), &format!("status={to}"), 1);
        std::fs::write(pool.file(rel), text).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn boot_stops_a_headless_orphan_before_it_schedules_and_records_the_crash() {
        let pool = Pool::git(&[("01", &[])]);
        let work = pool.dir.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let cwd = ac_core::js::canonical_dir(&work.to_string_lossy());
        let pid = sleeper(&cwd);
        let elsewhere = sleeper(&pool.path);
        set_status(&pool, "issues/01.md", "ready", "in-progress");
        std::fs::create_dir_all(pool.file("runs")).unwrap();
        std::fs::write(
            pool.file("runs/01.events.jsonl"),
            [
                // Alive and working in its cwd: an orphan.
                spawned_event(1, serde_json::json!({ "pid": pid, "cwd": cwd })),
                // Alive but working elsewhere: a reused pid.
                spawned_event(2, serde_json::json!({ "pid": elsewhere, "cwd": cwd })),
            ]
            .concat(),
        )
        .unwrap();
        let engine = pool.start().await;
        settled(&engine).await;
        let snapshot = wait_for(&engine, |s| {
            s.state
                .log
                .iter()
                .any(|l| l.contains("orphan attempt 1") && l.ends_with("stopped at boot"))
        })
        .await;
        let log = &snapshot.state.log;
        assert!(
            log.contains(&format!(
                "ticket 01: marker was in-progress and attempt 1 (pid {pid}) is still running from \
                 the previous engine process; stopping it before scheduling, ticket back to ready"
            )),
            "{log:#?}"
        );
        assert!(
            log.contains(&format!(
                "ticket 01: orphan attempt 1 (pid {pid}) stopped at boot"
            )),
            "{log:#?}"
        );
        assert!(!crate::children::process_is_live(pid));
        assert!(crate::children::process_is_live(elsewhere));
        let crash = pool
            .events("01")
            .into_iter()
            .find(|e| e.kind == Kind::Crash && e.attempt == 1)
            .expect("the orphan's crash is recorded");
        assert_eq!(
            crash.payload["reason"],
            format!(
                "orphan attempt (pid {pid}) from a previous engine process was still running at \
                 boot; stopped by the engine"
            )
        );
        assert_eq!(crash.payload["pid"], pid);
        assert_eq!(crash.payload["code"], serde_json::Value::Null);
        assert!(pool.read("issues/01.md").contains(&format!(
            "attempt 1 (pid {pid}) was found still running in the working tree"
        )));
        crate::children::signal_group(elsewhere, nix::sys::signal::Signal::SIGKILL);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn boot_chains_again_a_merge_a_shutdown_dropped_at_the_gate() {
        let pool = Pool::git(&[("01", &[])]);
        pool.script("01", vec![Script::done("one")]);
        let branch = ac_io::git::branch_for(&pool.path, "01", None);
        let worktree = ac_io::git::worktree_path_for(&pool.path, "01", None);
        pool_git(&pool, &["worktree", "add", "-q", "-b", &branch, &worktree]);
        std::fs::write(format!("{worktree}/one.txt"), "one\n").unwrap();
        for args in [
            vec!["add", "one.txt"],
            vec![
                "-c",
                "user.email=t@e.com",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                "one",
            ],
        ] {
            let out = Command::new("git")
                .arg("-C")
                .arg(&worktree)
                .args(&args)
                .output()
                .unwrap();
            assert!(out.status.success());
        }
        set_status(&pool, "issues/01.md", "ready", "done");
        std::fs::create_dir_all(pool.file("runs")).unwrap();
        let event = |attempt: u64, kind: &str, payload: serde_json::Value| {
            format!(
                "{}\n",
                serde_json::json!({
                    "at": "2026-10-04T09:00:00.000Z",
                    "attempt": attempt,
                    "kind": kind,
                    "payload": payload,
                })
            )
        };
        std::fs::write(
            pool.file("runs/01.events.jsonl"),
            [
                spawned_event(1, serde_json::json!({ "cwd": worktree, "branch": branch })),
                event(
                    1,
                    "exited",
                    serde_json::json!({ "code": 0, "status": "done" }),
                ),
                event(
                    1,
                    "merge-deferred",
                    serde_json::json!({ "path": worktree, "branch": branch }),
                ),
            ]
            .concat(),
        )
        .unwrap();
        let engine = pool.start().await;
        let snapshot = wait_for(&engine, |s| {
            s.state.log.iter().any(|l| l.contains("attempt 1 merged"))
        })
        .await;
        assert!(
            snapshot.state.log.contains(
                &"ticket 01: merge dropped at the last shutdown chained again".to_owned()
            )
        );
        assert!(snapshot.state.log.contains(&format!(
            "ticket 01: attempt 1 merged {branch} onto the working branch"
        )));
        assert!(pool.file("one.txt").exists());
        assert_eq!(
            pool.kinds("01").last().copied(),
            Some(Kind::Merged),
            "{:?}",
            pool.kinds("01")
        );
    }
}
