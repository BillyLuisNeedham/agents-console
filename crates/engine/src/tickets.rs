//! Tickets (engine.ts 9235-9554, 11732-11870): the Attempt-run module's environment, where an attempt
//! runs (`planTicket`), running one (`runTicket`), closing the tabs an attempt opened, and the crash
//! facts its Interrupt quotes.

use std::path::Path;
use std::sync::Arc;

use serde_json::{Map, Value};

use ac_core::assignment::Assignment;
use ac_core::config::PoolConfig;
use ac_core::events::{
    append_event, attempt_outcome_name, event_now, read_events, ticket_seed_name,
};
use ac_core::js;
use ac_core::outcome::{ValidOutcome, validate_outcome};
use ac_core::pool::{TicketMarker, read_marker, write_marker_status};
use ac_core::prompt::{PromptParts, Upstream, build_prompt};
use ac_core::spawn_caps::spawn_caps_of;
use ac_core::spawn_ledger::spawn_ledger_path;
use ac_io::git::{self, WorktreeInfo};
use ac_io::herdr::{Herdr, is_tab_not_found};
use ac_protocol::{
    OutcomeStatus, SpawnProposal, TerminalKind, TicketEvent, TicketEventKind, TicketStatus,
};

use crate::actor::Engine;
use crate::attempt_ending::exited_phrase;
use crate::attempt_run::{
    AttemptEnv, AttemptEvents, AttemptNaming, AttemptSpec, CrashSubject, Fallback, PromptDelivery,
    Rotate, run_attempt,
};
use crate::interrupts::land_checkpoint_brief;
use crate::merges::merge_target_ref;
use crate::session::{PoolState, PoolUpdate, Session};

/// `attemptEnvOf`: the Attempt-run module's environment, the one place the pool's terminal setting is
/// decided. The drive passes the super-step's frozen config; the other spawn sites read the live one.
pub fn attempt_env_of(session: &Session, config: Option<&PoolConfig>) -> AttemptEnv {
    let config = config.unwrap_or(&session.state.config);
    AttemptEnv {
        runs_dir: session.runs_dir.clone(),
        harnesses: session.harnesses.clone(),
        herdr_socket: session.herdr_socket.clone(),
        parent_env: Arc::clone(&session.parent_env),
        pool_workspace: Arc::new(crate::pool_workspace::EnginePoolWorkspace::new(
            session.engine(),
        )),
        host: Arc::new(session.engine()),
        terminal_backed: config.terminal() == Some(TerminalKind::Herdr),
        launch_cadence: session.launch_cadence,
        claude_config_path: None,
    }
}

/// Where an attempt runs and under which number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketPlan {
    pub cwd: String,
    pub worktree: Option<WorktreeInfo>,
    pub attempt: u64,
    /// True when the attempt is one candidate of a verify fan-out: it runs on its own attempt branch
    /// and its exit never writes the ticket's status.
    pub verify: bool,
}

/// One attempt's ending as the drive joins it.
#[derive(Debug, Clone)]
pub struct TicketResult {
    pub marker: TicketMarker,
    pub status: TicketStatus,
    pub log_path: String,
    pub exit_code: i64,
    pub plan: TicketPlan,
    pub update: PoolUpdate,
    /// True when the drive applied this result's update at attempt exit; the boundary join skips it.
    pub joined_at_exit: bool,
    /// The attempt's schema-valid spawn proposals (ADR-0010); a verify candidate carries none.
    pub spawn_proposals: Option<Vec<SpawnProposal>>,
    /// The exit facts (ADR-0012), frozen at exit for the crash interrupt body.
    pub log_tail: Vec<String>,
    pub outcome_path: String,
    pub outcome_exists: bool,
    /// The crash reason the crash event recorded, `None` on a clean exit.
    pub crash_reason: Option<String>,
}

/// The exit facts a crash interrupt body quotes (ADR-0012), frozen at raise time.
pub struct CrashFacts<'a> {
    pub crash_reason: &'a str,
    pub log_path: &'a str,
    pub log_tail: &'a [String],
    pub outcome_path: &'a str,
    pub outcome_exists: bool,
}

/// `crashInterruptBody`: the crash reason, the log path, a blank line, the tail, and the outcome-file
/// line.
pub fn crash_interrupt_body(facts: &CrashFacts<'_>) -> String {
    let tail = facts.log_tail.join("\n");
    format!(
        "crash: {}\n{}\n\n{}outcome file: {} ({})\n",
        facts.crash_reason,
        facts.log_path,
        if tail.is_empty() {
            String::new()
        } else {
            format!("{tail}\n\n")
        },
        facts.outcome_path,
        if facts.outcome_exists {
            "exists"
        } else {
            "missing"
        }
    )
}

/// `wasEnlisted`: the marker's `enlisted-from` is the durable answer (issue #101); the tab of an
/// enlisted ticket is the operator's own, and closing it is the one thing the engine never does.
pub fn was_enlisted(session: &Session, ticket_id: &str) -> bool {
    session
        .marker(ticket_id)
        .is_some_and(|marker| marker.enlisted_from.is_some())
}

fn text<'a>(event: &'a TicketEvent, key: &str) -> Option<&'a str> {
    event.payload.get(key).and_then(Value::as_str)
}

/// finished-terminals.ts `tabRecordedClosed`: whether the events already record the tab closed.
pub fn tab_recorded_closed(
    events: &[Arc<TicketEvent>],
    tab_id: &str,
    terminal_id: Option<&str>,
) -> bool {
    events.iter().any(|event| {
        if event.kind != TicketEventKind::TabClosed {
            return false;
        }
        if let (Some(terminal), Some(closed)) = (terminal_id, text(event, "terminal_id")) {
            return closed == terminal;
        }
        text(event, "tab_id") == Some(tab_id)
    })
}

/// `closeAttemptTab`: close the herdr tab one attempt opened, when its role has ended. Best-effort and
/// non-blocking; a headless attempt names no tab.
pub fn close_attempt_tab(session: &Session, ticket_id: &str, attempt: u64) {
    if was_enlisted(session, ticket_id) {
        return;
    }
    let spawned = read_events(Path::new(&session.runs_dir), ticket_id)
        .into_iter()
        .find(|event| {
            event.kind == TicketEventKind::Spawned
                && event.attempt == attempt
                && text(event, "tab_id").is_some()
        });
    if let Some(spawned) = spawned {
        close_spawned_tab(session, ticket_id, &spawned, "role ended");
    }
}

/// `closeAttemptTabs`: close every herdr tab the ticket ever opened, one close per terminal.
pub fn close_attempt_tabs(session: &Session, ticket_id: &str) {
    if was_enlisted(session, ticket_id) {
        return;
    }
    let mut seen: Vec<String> = Vec::new();
    for spawned in read_events(Path::new(&session.runs_dir), ticket_id) {
        if spawned.kind != TicketEventKind::Spawned {
            continue;
        }
        let Some(tab_id) = text(&spawned, "tab_id") else {
            continue;
        };
        let key = match text(&spawned, "terminal_id") {
            Some(terminal) => format!("terminal:{terminal}"),
            None => format!("tab:{tab_id}"),
        };
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        close_spawned_tab(session, ticket_id, &spawned, "role ended");
    }
}

/// `closeSpawnedTab`: close the tab a `spawned` event names, unless the events already record it
/// closed.
pub fn close_spawned_tab(session: &Session, owner: &str, spawned: &TicketEvent, reason: &str) {
    let Some(tab_id) = text(spawned, "tab_id").map(str::to_owned) else {
        return;
    };
    let terminal_id = text(spawned, "terminal_id").map(str::to_owned);
    let events = read_events(Path::new(&session.runs_dir), owner);
    if tab_recorded_closed(&events, &tab_id, terminal_id.as_deref()) {
        return;
    }
    let engine = session.engine();
    let herdr = Herdr::new(&session.herdr_socket);
    let (owner, attempt, reason) = (owner.to_owned(), spawned.attempt, reason.to_owned());
    tokio::spawn(async move {
        close_tab_recorded(&engine, &herdr, owner, attempt, tab_id, terminal_id, reason).await;
    });
}

/// `closeTabRecorded`: close one tab the engine opened, best-effort and never silently (issue #139). A
/// tab herdr no longer has is closed already; a refusal lands as `tab-close-failed` and a pool log
/// line. Whether the tab closed.
pub async fn close_tab_recorded(
    engine: &Engine,
    herdr: &Herdr,
    owner: String,
    attempt: u64,
    tab_id: String,
    terminal_id: Option<String>,
    reason: String,
) -> bool {
    let closed = match herdr.close_tab(&tab_id).await {
        Ok(()) => Ok(()),
        Err(err) if is_tab_not_found(&err) => Ok(()),
        Err(err) => Err(err.to_string()),
    };
    engine
        .call(move |s| {
            let runs = Path::new(&s.runs_dir).to_path_buf();
            match closed {
                Ok(()) => {
                    let mut payload = Map::new();
                    payload.insert("tab_id".into(), Value::String(tab_id));
                    if let Some(terminal) = terminal_id {
                        payload.insert("terminal_id".into(), Value::String(terminal));
                    }
                    payload.insert("reason".into(), Value::String(reason));
                    let _ = append_event(
                        &runs,
                        &owner,
                        &event_now(attempt, TicketEventKind::TabClosed, payload),
                    );
                    // The snapshot's Finished terminals count should not wait a cadence to drop the
                    // tab just closed.
                    crate::pane_survey::refresh_in_background(s);
                    true
                }
                Err(error) => {
                    let mut payload = Map::new();
                    payload.insert("tab_id".into(), Value::String(tab_id.clone()));
                    payload.insert("error".into(), Value::String(error.clone()));
                    let _ = append_event(
                        &runs,
                        &owner,
                        &event_now(attempt, TicketEventKind::TabCloseFailed, payload),
                    );
                    s.log(format!(
                        "{owner}: herdr tab {tab_id} could not be closed ({error})"
                    ));
                    false
                }
            }
        })
        .await
        .unwrap_or(false)
}

fn git_attempt(attempt: u64) -> Option<u32> {
    Some(u32::try_from(attempt).unwrap_or(u32::MAX))
}

/// `planTicket`: where an attempt runs. A lone ready ticket runs in the pool checkout itself; a
/// multi-ticket super-step, a parked branch, a verify candidate, a captured merge target or a
/// Continued attempt in the checkout gives the ticket its own worktree, seeded with the Ticket file
/// (kept under runs/ too for the reconcile at merge).
pub fn plan_ticket(
    session: &mut Session,
    marker: &TicketMarker,
    ready_count: usize,
    attempt: u64,
    verify: bool,
) -> anyhow::Result<TicketPlan> {
    if !session.git {
        session.pool_checkout_planned.insert(marker.id.clone());
        return Ok(TicketPlan {
            cwd: session.cwd.clone(),
            worktree: None,
            attempt,
            verify,
        });
    }
    if !verify
        && ready_count < 2
        && !git::branch_exists(&session.cwd, &marker.id, None)
        && session.merge_target.is_none()
        && !session.continued.values().any(|c| c.in_pool_checkout)
    {
        // Occupied from the plan on (ADR-0027).
        session.pool_checkout_planned.insert(marker.id.clone());
        return Ok(TicketPlan {
            cwd: session.cwd.clone(),
            worktree: None,
            attempt,
            verify,
        });
    }
    let worktree = git::prepare_worktree(
        &session.cwd,
        &marker.id,
        if verify { git_attempt(attempt) } else { None },
        &merge_target_ref(session),
    )?;
    let file = js::path_text(&marker.file);
    let seed_copy = js::path_join(&[&worktree.path, &js::path_relative(&session.cwd, &file)]);
    if let Some(parent) = Path::new(&seed_copy).parent() {
        js::mkdir_all(parent)?;
    }
    std::fs::copy(&marker.file, &seed_copy)?;
    js::mkdir_all(&session.runs_dir)?;
    std::fs::copy(
        &marker.file,
        Path::new(&session.runs_dir).join(ticket_seed_name(
            &marker.id,
            if verify { Some(attempt) } else { None },
        )),
    )?;
    Ok(TicketPlan {
        cwd: worktree.path.clone(),
        worktree: Some(worktree),
        attempt,
        verify,
    })
}

fn exited_status(valid: &ValidOutcome) -> TicketStatus {
    match valid.outcome.status {
        OutcomeStatus::Done => TicketStatus::Done,
        OutcomeStatus::Checkpoint => TicketStatus::Checkpoint,
    }
}

// Malformed spawn entries were dropped per proposal at validation (ADR-0010); each reason lands on the
// ticket's log at the exit that produced it, ahead of the exited event.
fn spawn_rejection_events(valid: &ValidOutcome) -> Vec<(TicketEventKind, Map<String, Value>)> {
    valid
        .spawn_rejections
        .iter()
        .map(|rejection| {
            let mut payload = Map::new();
            payload.insert("reason".into(), Value::String(rejection.reason.clone()));
            if let Some(index) = rejection.index {
                payload.insert("index".into(), Value::from(index));
            }
            (TicketEventKind::SpawnRejected, payload)
        })
        .collect()
}

/// What `runTicket` reads of the pool besides the Attempt-run environment.
pub struct TicketEnv {
    pub engine: Engine,
    pub attempt: AttemptEnv,
    pub pool_dir: String,
    pub issues_dir: String,
}

/// `runTicket`: one ticket attempt, from its prompt to the status the engine writes (ADR-0005). The
/// ending comes from the Outcome alone; a verify candidate writes no status anywhere at its exit.
pub async fn run_ticket(
    marker: TicketMarker,
    snapshot: &PoolState,
    assignment: &Assignment,
    env: &TicketEnv,
    plan: TicketPlan,
) -> anyhow::Result<TicketResult> {
    let mut drivers = js::words(&assignment.drivers);
    let driver = drivers.next().unwrap_or("").to_owned();
    let chain: Vec<&str> = drivers.collect();
    let naming = AttemptNaming {
        attempt: if plan.verify {
            Some(plan.attempt)
        } else {
            None
        },
        resolver: false,
    };
    let outcome_path = js::path_join(&[
        &env.attempt.runs_dir,
        &attempt_outcome_name(&marker.id, naming.attempt, false),
    ]);
    let upstream: Vec<Upstream<'_>> = marker
        .blocked_by
        .iter()
        .filter_map(|id| {
            snapshot
                .outcomes
                .get(id)
                .map(|outcome| Upstream { id, outcome })
        })
        .collect();
    // AGENT.md is read at every spawn, never cached, so an operator's mid-run edit lands in the very
    // next attempt's prompt.
    let agent_md_path = js::path_join(&[&env.pool_dir, "AGENT.md"]);
    let agent_md = if Path::new(&agent_md_path).exists() {
        js::read_text(&agent_md_path)?
    } else {
        String::new()
    };
    let ledger = js::path_text(&spawn_ledger_path(Path::new(&env.attempt.runs_dir)));
    let prompt = build_prompt(&PromptParts {
        chain: &chain,
        agent_md: &agent_md,
        upstream: &upstream,
        outcome_path: &outcome_path,
        spawn_caps: spawn_caps_of(&snapshot.config),
        ledger_path: &ledger,
    });
    let run = run_attempt(
        &env.attempt,
        AttemptSpec {
            id: marker.id.clone(),
            issue_path: js::path_text(&marker.file),
            title: marker.title.clone(),
            body: prompt,
            driver,
            harness: assignment.harness.clone(),
            model: assignment.model.clone(),
            effort: assignment.effort.clone().filter(|e| !e.is_empty()),
            cwd: plan.cwd.clone(),
            branch: plan.worktree.as_ref().map(|w| w.branch.clone()),
            attempt: plan.attempt,
            naming,
            rotate: if plan.verify {
                Rotate::None
            } else {
                Rotate::Exited
            },
            fallback: Fallback::Headless,
            prompt: PromptDelivery::Driver,
            crash_subject: CrashSubject::Harness,
            events: AttemptEvents::Full {
                exited_status,
                result_events: Some(spawn_rejection_events),
            },
        },
        validate_outcome,
    )
    .await?;
    let verify = plan.verify;
    let file = marker.file.clone();
    let ok_outcome = run.result.as_ref().ok().filter(|_| run.ok()).cloned();
    let status = match &ok_outcome {
        Some(valid) => exited_status(valid),
        None => TicketStatus::InProgress,
    };
    // The engine owns the status write: run in the actor, as the TypeScript's continuation runs on its
    // one thread.
    {
        let brief = ok_outcome.as_ref().and_then(|v| v.outcome.brief.clone());
        let ok = ok_outcome.is_some();
        env.engine
            .call(move |_| -> anyhow::Result<()> {
                if verify {
                    return Ok(());
                }
                if ok {
                    write_marker_status(&file, status)?;
                    if status == TicketStatus::Checkpoint {
                        land_checkpoint_brief(&file, brief.as_deref())?;
                    }
                } else if read_marker(&file)?.status != TicketStatus::InProgress {
                    write_marker_status(&file, TicketStatus::InProgress)?;
                }
                Ok(())
            })
            .await??;
    }
    let crash = run
        .crash_reason
        .as_ref()
        .map_or(String::new(), |reason| format!(", crash: {reason}"));
    let line = if verify {
        format!(
            "ticket {}: attempt {} {} ({status}){crash}",
            marker.id,
            plan.attempt,
            exited_phrase(run.code)
        )
    } else {
        format!(
            "ticket {}: {}, marker {status}{crash}",
            marker.id,
            exited_phrase(run.code)
        )
    };
    let update = PoolUpdate {
        tickets: (!verify).then(|| [(marker.id.clone(), status)].into_iter().collect()),
        log: Some(vec![line]),
        // A valid result's Outcome rides even on a crash: a valid Outcome beside a non-zero code is
        // still a fact a site records.
        outcomes: match (&run.result, verify) {
            (Ok(valid), false) => Some(
                [(marker.id.clone(), valid.outcome.clone())]
                    .into_iter()
                    .collect(),
            ),
            _ => None,
        },
        ..PoolUpdate::default()
    };
    Ok(TicketResult {
        status,
        log_path: run.log_path.clone(),
        exit_code: run.code,
        joined_at_exit: false,
        log_tail: run.log_tail.clone(),
        outcome_path: run.outcome_path.clone(),
        outcome_exists: run.outcome_exists,
        crash_reason: run.crash_reason.clone(),
        spawn_proposals: match &ok_outcome {
            Some(valid) if !verify => Some(valid.outcome.spawn.clone().unwrap_or_default()),
            _ => None,
        },
        update,
        plan,
        marker,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_crash_body_leads_with_the_reason_and_quotes_the_tail_when_there_is_one() {
        let tail = vec!["one".to_string(), "two".to_string()];
        assert_eq!(
            crash_interrupt_body(&CrashFacts {
                crash_reason: "harness exited 3",
                log_path: "/p/runs/01.log",
                log_tail: &tail,
                outcome_path: "/p/runs/01.outcome.json",
                outcome_exists: false,
            }),
            "crash: harness exited 3\n/p/runs/01.log\n\none\ntwo\n\noutcome file: /p/runs/01.outcome.json (missing)\n"
        );
        assert_eq!(
            crash_interrupt_body(&CrashFacts {
                crash_reason: "no outcome written",
                log_path: "/l",
                log_tail: &[],
                outcome_path: "/o",
                outcome_exists: true,
            }),
            "crash: no outcome written\n/l\n\noutcome file: /o (exists)\n"
        );
    }
}
