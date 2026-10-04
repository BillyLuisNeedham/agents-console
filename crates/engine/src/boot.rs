//! Starting a pool (engine.ts `startPool`, 1199-1458, with `seedEnlistedWork` and `rehydrate`): the
//! pool's Tickets and config, the Assignment table, the checkpoint store, the rehydrate of a plain
//! restart, the Jev boot line, boot reconciliation, and the drive, whose first emit has happened when
//! [`start_pool`] returns.

use std::collections::HashSet;
use std::path::Path;

use indexmap::IndexMap;
use serde_json::Value;
use tokio::sync::watch;

use ac_core::assignment::{Assignment, Assignments, DEFAULT_DRIVERS, resolve_unseen_assignments};
use ac_core::checkpoints::{CheckpointStore, SqliteCheckpointStore};
use ac_core::config::{canonical_dir, read_config, read_config_text};
use ac_core::conversation_record::load_conversations;
use ac_core::events::{attempt_outcome_name, last_attempt, read_events};
use ac_core::harness::Harnesses;
use ac_core::js;
use ac_core::machine_defaults::default_machine_defaults_paths;
use ac_core::outcome::validate_outcome;
use ac_core::pool::{is_finished, load_pool_tickets, write_marker_status};
use ac_core::pool_title::{pool_workspace_label, title_of};
use ac_core::spawn_proposals::load_spawn_proposals;
use ac_protocol::{Interrupt, InterruptKind, Outcome, TicketEventKind, TicketStatus};

use crate::actor::Engine;
use crate::attempt_ending::read_attempt_result;
use crate::interrupts::{ENGINE_BRIEF_HEADING, raise_checkpoint};
use crate::jev::{JEV_MODEL, Jev};
use crate::options::RunOptions;
use crate::pool_workspace::PoolWorkspaceState;
use crate::session::{EnlistedWork, PoolUpdate, Session, SessionBase};
use crate::steward_actions::steward_used_at_boot;

/// The note an in-progress ticket gets at boot when no agent from the dead process is found running.
pub fn engine_reset_note() -> String {
    format!(
        "\n---\n\n{ENGINE_BRIEF_HEADING}\n\nThe engine process stopped while this ticket was \
         in-progress (killed, crashed, or the machine restarted). No agent from that process was found \
         still running at this boot, so the work is part done at best and the agent left no brief. \
         The ticket is back to ready; read the working tree before it runs again.\n"
    )
}

/// `startPool`: load the pool, build the session, rehydrate, start the actor and the drive. The first
/// snapshot has been emitted when this returns. Fails as the TypeScript's start throws: an unloadable
/// pool, a bad console.json, an Assignment that cannot resolve, a store that will not open.
pub async fn start_pool(options: RunOptions) -> anyhow::Result<Engine> {
    let pool_dir = canonical_dir(&options.pool_dir);
    let runs_dir = js::path_join(&[&pool_dir, "runs"]);
    let markers = load_pool_tickets(Path::new(&pool_dir), options.allow_empty_issues)?;
    js::mkdir_all(&runs_dir)?;
    let config = read_config(&pool_dir)?;
    // The reload's baseline (ADR-0018): the exact bytes the boot parse read.
    let last_config_text = read_config_text(&pool_dir)?;
    let mut harnesses = Harnesses::defaults();
    if let Some(extra) = &options.harnesses {
        for name in extra.names() {
            if let Some(harness) = extra.get(&name) {
                harnesses.insert(&name, harness.clone());
            }
        }
    }
    let cwd = ac_io::git::repo_root_of(&pool_dir);
    let git = ac_io::git::git_available(&cwd);
    // A merge checkout a dead engine left behind holds the merge target (issue #101).
    if git {
        ac_io::git::remove_stale_merge_checkout(&cwd)?;
    }
    let herdr_socket = options.herdr_socket.clone().unwrap_or_else(|| {
        js::path_text(&ac_io::herdr::default_socket_path(
            None,
            Path::new(&options.home),
        ))
    });
    // Conversation ids are seeded first: a Ticket spawned mid-Conversation names one as its parent.
    let mut assignments = Assignments::new();
    for rec in load_conversations(&Path::new(&pool_dir).join("conversations"))? {
        if rec.harness.is_empty() {
            continue;
        }
        assignments.insert(
            rec.id.clone(),
            Assignment {
                harness: rec.harness,
                model: rec.model,
                effort: rec.effort.filter(|e| !e.is_empty()),
                drivers: rec.drivers,
                verify: None,
            },
        );
    }
    resolve_unseen_assignments(&markers, &mut assignments, &config, &harnesses)?;
    let store: Box<dyn CheckpointStore> = match options.store {
        Some(store) => store,
        None => Box::new(SqliteCheckpointStore::open(Path::new(&pool_dir))?),
    };
    let mut machine_defaults = options
        .machine_defaults
        .clone()
        .unwrap_or_else(|| default_machine_defaults_paths(&options.home));
    if let Some(file) = &options.machine_defaults_path {
        machine_defaults.file = file.clone();
    }
    if let Some(file) = &options.issue_runner_path {
        machine_defaults.issue_runner = file.clone();
    }
    let runs = Path::new(&runs_dir);
    let (publisher, snapshots) = watch::channel(None);
    let (reconcile_done, terminal_reconcile) = watch::channel(false);
    let mut session = Session::new(SessionBase {
        publisher,
        pool_dir: pool_dir.clone(),
        runs_dir: runs_dir.clone(),
        cwd,
        git,
        harnesses,
        config: config.clone(),
        store,
        machine_defaults,
        herdr_socket,
        spawn_proposals: load_spawn_proposals(runs)?,
        terminal_reconcile,
    });
    session.state.tickets = markers.iter().map(|m| (m.id.clone(), m.status)).collect();
    session.steward_used = steward_used_at_boot(&runs_dir, &markers);
    session.markers = markers;
    session.assignments = assignments;
    session.snapshot_history = options.snapshot_history;
    session.on_snapshot = options.on_snapshot.clone();
    session.parent_env = options.parent_env.clone();
    session.launch_cadence = options.launch_cadence;
    session.pool_workspace = PoolWorkspaceState {
        launch: options.herdr_workspace.clone(),
        wanted: pool_workspace_label(title_of(&config).as_deref(), &pool_dir),
        ..PoolWorkspaceState::default()
    };
    session.last_config_text = last_config_text;
    session.jev = options.jev.clone().unwrap_or_else(Jev::unconfigured);
    session.enlist_poll_ms = options.enlist_poll_ms;
    session.teaching_wait_ms = options.enlist_teaching_wait_ms;
    session.conversation_poll_ms = options.conversation_poll_ms;
    session.pane_survey_ms = options.pane_survey_ms;
    session.console_url = options.console_url.clone();
    seed_enlisted_work(&mut session)?;
    rehydrate(&mut session)?;
    crate::spawns::recover_truncated_spawns(&mut session)?;
    crate::spawns::settle_landing_spawns(&mut session)?;
    let engine = Engine::spawn(session, snapshots, |session, engine| {
        session.engine = Some(engine)
    });
    let (turned, first_turn) = tokio::sync::oneshot::channel();
    engine
        .call(move |s| {
            // The pane survey (issue #139) only has panes to list in a terminal-backed pool; it is
            // the herdr panes port's (STUB in held).
            crate::held::seed_held_panes(s);
            // Jev (ADR-0020): one boot line saying which path is live, then one line per fallback
            // cause as the port's own dedupe announces them, never one per call. The subscription is
            // released with the store at close. The listener runs on the task that asked; the line
            // joins the log in the actor's order.
            let notices = s.engine();
            s.jev_unsubscribe = s.jev.subscribe(Box::new(move |notice| {
                let line = crate::jev::jev_notice_line(notice);
                notices.cast(move |s| s.log(line));
            }));
            s.log(if s.jev.configured() {
                format!("Jev configured ({JEV_MODEL})")
            } else {
                "Jev not configured, heuristics only".to_owned()
            });
            // Conversations do not resume: any recorded live at boot crashes now.
            s.conversations.crash_stale_at_boot();
            start_boot_reconcile(s, reconcile_done);
            s.first_turn = Some(turned);
            crate::drive::start_drive(s);
        })
        .await?;
    // The drive's first stretch runs before start_pool returns, as the TypeScript's runs in the
    // microtasks after startPool and before the server's boot line.
    let _ = first_turn.await;
    Ok(engine)
}

// The Pool workspace comes first (issue #94), then boot reconciliation, awaited by the drive before
// its first scheduling: terminal-backed orphans re-adopted or crashed (ADR-0014), headless orphans
// stopped (ADR-0017), enlisted and started Conversations re-adopted; then the merges a shutdown
// dropped at the pool checkout's gate are chained again.
fn start_boot_reconcile(session: &mut Session, done: watch::Sender<bool>) {
    // A headless pool with no orphan has nothing to reconcile against: the TypeScript's chain settles
    // in microtasks, before the drive's first await, so it is done here and now.
    let terminal_backed = session.state.config.terminal() == Some(ac_protocol::TerminalKind::Herdr);
    if !terminal_backed && session.orphans.is_empty() {
        crate::restart::redo_deferred_merges(session);
        let _ = done.send(true);
        return;
    }
    let engine = session.engine();
    tokio::spawn(async move {
        crate::pool_workspace::resolve_pool_workspace_for_session(&engine).await;
        futures::join!(
            crate::restart::reconcile_terminal_attempts(&engine),
            crate::restart::reap_headless_orphans(&engine),
            crate::conversations::adopt_enlisted_at_boot(&engine),
            crate::conversations::adopt_started_at_boot(&engine),
        );
        let _ = engine.call(crate::restart::redo_deferred_merges).await;
        let _ = done.send(true);
    });
}

// The enlist `spawned` event of an enlisted Ticket or Conversation: the one carrying the found
// directory and branch (a Continued attempt's is not the enlist).
fn enlist_spawned_event(
    session: &Session,
    id: &str,
) -> Option<std::sync::Arc<ac_protocol::TicketEvent>> {
    read_events(Path::new(&session.runs_dir), id)
        .into_iter()
        .rfind(|event| {
            event.kind == TicketEventKind::Spawned
                && event.payload.get("continued") != Some(&Value::Bool(true))
                && event.payload.get("cwd").is_some_and(Value::is_string)
                && event.payload.get("branch").is_some_and(Value::is_string)
        })
}

/// `seedEnlistedWork`: the found work of every enlisted ticket, recovered from its enlist `spawned`
/// event after a restart (issue #101), and the merge target an enlist captured.
pub fn seed_enlisted_work(session: &mut Session) -> anyhow::Result<()> {
    let conversations = load_conversations(&Path::new(&session.pool_dir).join("conversations"))?;
    for rec in conversations {
        if rec.enlisted.is_none() {
            continue;
        }
        if let Some(target) = enlist_spawned_event(session, &rec.id).and_then(|e| {
            e.payload
                .get("merge_target")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }) {
            session.merge_target = Some(target);
        }
    }
    for index in 0..session.markers.len() {
        let marker = session.markers[index].clone();
        if marker.enlisted_from.is_none() {
            continue;
        }
        let Some(spawned) = enlist_spawned_event(session, &marker.id) else {
            continue;
        };
        if let Some(target) = spawned.payload.get("merge_target").and_then(Value::as_str) {
            session.merge_target = Some(target.to_owned());
        }
        if read_events(Path::new(&session.runs_dir), &marker.id)
            .iter()
            .any(|event| event.kind == TicketEventKind::LetGo)
        {
            continue;
        }
        let text = |key: &str| {
            spawned
                .payload
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        session.enlisted_work.insert(
            marker.id.clone(),
            EnlistedWork {
                branch: text("branch"),
                directory: text("cwd"),
            },
        );
        // The Assignment as found, for an attempt still in flight.
        if marker.status == TicketStatus::InProgress
            && let Some(harness) = spawned.payload.get("harness").and_then(Value::as_str)
        {
            session.assignments.insert(
                marker.id.clone(),
                Assignment {
                    harness: harness.to_owned(),
                    model: String::new(),
                    effort: None,
                    drivers: DEFAULT_DRIVERS.to_owned(),
                    verify: None,
                },
            );
        }
    }
    Ok(())
}

/// `rehydrate`: the last checkpoint restores the run's channels, but the line-1 markers are the truth
/// for ticket statuses. An in-progress marker with no pending interrupt goes back to ready with a note
/// on the Issue; a stored interrupt whose marker says done or ready is stale and clears; a checkpoint
/// marker with no stored interrupt re-raises it from the Brief; Outcome files on disk win over the
/// checkpoint. The orphan and adoption parts are the restart port's.
pub fn rehydrate(session: &mut Session) -> anyhow::Result<()> {
    let stored = session.store.latest()?;
    let mut log: Vec<String> = Vec::new();
    if let Some(stored) = stored {
        let field = |key: &str| stored.get(key);
        session.state.log = match field("log") {
            Some(Value::Array(lines)) => lines
                .iter()
                .map(|line| {
                    line.as_str()
                        .map_or_else(|| js::string_of(line), str::to_owned)
                })
                .collect(),
            _ => Vec::new(),
        };
        session.state.outcomes = match field("outcomes") {
            Some(Value::Object(outcomes)) => outcomes
                .iter()
                .filter_map(|(id, outcome)| {
                    serde_json::from_value::<Outcome>(outcome.clone())
                        .ok()
                        .map(|o| (id.clone(), o))
                })
                .collect(),
            _ => IndexMap::new(),
        };
        session.state.interrupts = match field("interrupts") {
            Some(Value::Array(interrupts)) => interrupts
                .iter()
                .filter_map(|i| serde_json::from_value::<Interrupt>(i.clone()).ok())
                .map(|mut i| {
                    i.steward_note = None;
                    i
                })
                .collect(),
            _ => Vec::new(),
        };
        session.state.review_approved = field("reviewApproved") == Some(&Value::Bool(true));
        log.push(format!(
            "rehydrated from checkpoint: {} interrupt(s), {} outcome(s) restored",
            session.state.interrupts.len(),
            session.state.outcomes.len()
        ));
    }
    let interrupted: HashSet<String> = session
        .state
        .interrupts
        .iter()
        .map(|i| i.ticket_id.clone())
        .collect();
    for index in 0..session.markers.len() {
        let marker = session.markers[index].clone();
        if marker.status != TicketStatus::InProgress || interrupted.contains(&marker.id) {
            continue;
        }
        // A verify ticket's Continued attempt that ended done before a restart is graded first.
        if let Some(owed) = crate::keep_talking::owed_continued_grade(session, &marker) {
            log.push(format!(
                "ticket {}: continued attempt {} ended done before a restart; graded as a lone \
                 attempt before anything runs",
                marker.id, owed.attempt
            ));
            session.continued_grades.push(owed);
            continue;
        }
        let orphans = crate::restart::headless_orphans(session, &marker.id);
        write_marker_status(&marker.file, TicketStatus::Ready)?;
        js::append_file(
            &marker.file,
            &if orphans.is_empty() {
                engine_reset_note()
            } else {
                crate::restart::engine_orphan_note(&orphans)
            },
        )?;
        session.markers[index].status = TicketStatus::Ready;
        if orphans.is_empty() {
            log.push(format!(
                "ticket {}: marker was in-progress with no live agent; back to ready",
                marker.id
            ));
        } else {
            log.push(format!(
                "ticket {}: marker was in-progress and {} is still running from the previous engine \
                 process; stopping it before scheduling, ticket back to ready",
                marker.id,
                orphans
                    .iter()
                    .map(|o| format!("attempt {} (pid {})", o.attempt, o.pid))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            session.orphans.extend(orphans);
        }
    }
    let tickets = session.marker_statuses();
    session.apply(PoolUpdate {
        tickets: Some(tickets),
        ..PoolUpdate::default()
    });
    // An approval only stands while every marker on disk is finished.
    if session.markers.iter().any(|m| !is_finished(Some(m.status)))
        && (session.state.review_approved
            || session
                .state
                .interrupts
                .iter()
                .any(|i| i.kind == InterruptKind::Review))
    {
        let interrupts = session
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
        log.push(
            "review gate cleared: markers on disk are not all done, so a fresh Review will be raised \
             when they finish"
                .into(),
        );
    }
    let stale: Vec<Interrupt> = session
        .state
        .interrupts
        .iter()
        .filter(|i| {
            let status = session.status_of(&i.ticket_id);
            // A closed ticket waits on nothing, a merge least of all.
            if status == Some(TicketStatus::Closed) {
                return true;
            }
            if matches!(
                i.kind,
                InterruptKind::MergeConflict | InterruptKind::MergeApproval
            ) {
                return false;
            }
            matches!(status, Some(TicketStatus::Done | TicketStatus::Ready))
        })
        .cloned()
        .collect();
    if !stale.is_empty() {
        let interrupts = session
            .state
            .interrupts
            .iter()
            .filter(|i| !stale.contains(i))
            .cloned()
            .collect();
        let lines = stale
            .iter()
            .map(|i| {
                format!(
                    "interrupt cleared for {} ({}): marker says {}",
                    i.ticket_id,
                    i.kind,
                    session
                        .status_of(&i.ticket_id)
                        .map_or("undefined".to_owned(), |s| s.to_string())
                )
            })
            .collect();
        session.apply(PoolUpdate {
            interrupts: Some(interrupts),
            log: Some(lines),
            ..PoolUpdate::default()
        });
    }
    for index in 0..session.markers.len() {
        let marker = session.markers[index].clone();
        if marker.status == TicketStatus::Checkpoint
            && !session
                .state
                .interrupts
                .iter()
                .any(|i| i.ticket_id == marker.id)
        {
            let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
            raise_checkpoint(session, &marker, attempt, None)?;
        }
    }
    let mut recovered: IndexMap<String, Outcome> = IndexMap::new();
    for marker in &session.markers {
        if marker.status != TicketStatus::Done {
            continue;
        }
        let path = Path::new(&session.runs_dir).join(attempt_outcome_name(&marker.id, None, false));
        if let Ok(valid) = read_attempt_result(&path, validate_outcome) {
            recovered.insert(marker.id.clone(), valid.outcome);
        }
    }
    if !recovered.is_empty() {
        session.apply(PoolUpdate {
            outcomes: Some(recovered),
            ..PoolUpdate::default()
        });
    }
    if !log.is_empty() {
        session.apply(PoolUpdate::log(log));
    }
    Ok(())
}
