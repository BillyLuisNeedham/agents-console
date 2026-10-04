//! Boot: a Conversation recorded live when the engine last ran may still be talking in its pane, since a
//! shutdown leaves every pane and TUI as it is. Its pane decides (the ADR-0018 amendment of issue #140):
//! re-adopted while the pane is still its own and its TUI still runs, crashed otherwise, with its tab
//! closed only when the tab is still its own. Only one with no pane to ask about (a headless pool, or a
//! record with no launch on it) is crashed here, at once.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ac_core::assignment::{Assignment, DEFAULT_DRIVERS};
use ac_core::conversation_record::{ConversationRecord, write_conversation_status};
use ac_core::events::attempt_exit_code_name;
use ac_core::harness::{HarnessDescriptor, harness_descriptor};
use ac_core::js;
use ac_io::herdr::{Herdr, HerdrPane, PaneAgentState};
use ac_protocol::{AnswerBy, ConversationStatus, InterruptKind, TicketEventKind};
use serde_json::json;

use super::end::{claim_detached, close_conversation_tab, end_with, tab_is_foreign};
use super::tick::{settle_turn, start_tick};
use super::*;
use crate::actor::Engine;
use crate::interrupts::{interrupt, raise_interrupt};
use crate::live_attempts::LiveAttemptEntry;

/// One listing of herdr's panes: every listed pane by id, and every tab a listed pane sits in.
///
/// STUB(held): the pane survey's listing (pane-survey.ts) belongs to the herdr panes port; this is the
/// part of it a Conversation reads.
#[derive(Debug, Clone, Default)]
pub struct PaneListing {
    pub panes: HashMap<String, HerdrPane>,
    #[allow(dead_code)]
    pub tabs: HashSet<String>,
}

// A directory as herdr reports it: the physical path, so the recorded one is resolved the same way
// before they are compared.
fn trim_slash(path: &str) -> String {
    let physical = js::canonical_dir(path);
    if physical.chars().count() > 1 {
        physical.trim_end_matches('/').to_owned()
    } else {
        physical
    }
}

/// `listedAsRecorded` (pane-survey.ts): whether the listing still has the pane the engine recorded, and
/// it is the same pane (issue #139).
///
/// STUB(held): see [`PaneListing`].
pub fn listed_as_recorded(
    listing: &PaneListing,
    recorded: &Launch,
    workspace_id: Option<&str>,
) -> bool {
    let Some(listed) = listing.panes.get(&recorded.pane_id) else {
        return false;
    };
    if let (Some(recorded_terminal), Some(listed_terminal)) = (
        recorded.terminal_id.as_deref().filter(|id| !id.is_empty()),
        listed.terminal_id.as_deref().filter(|id| !id.is_empty()),
    ) {
        return listed_terminal == recorded_terminal;
    }
    if let (Some(recorded_tab), Some(listed_tab)) = (&recorded.tab_id, &listed.tab_id)
        && listed_tab != recorded_tab
    {
        return false;
    }
    if let (Some(workspace), Some(listed_workspace)) = (workspace_id, &listed.workspace_id)
        && listed_workspace != workspace
    {
        return false;
    }
    if let (Some(recorded_cwd), Some(listed_cwd)) = (&recorded.cwd, &listed.cwd)
        && trim_slash(listed_cwd) != trim_slash(recorded_cwd)
    {
        return false;
    }
    true
}

/// One listing of herdr's panes, or `None` when the daemon could not be asked.
pub(crate) async fn pane_listing(engine: &Engine) -> Option<PaneListing> {
    let socket = engine.call(|s| s.herdr_socket.clone()).await.ok()?;
    let listed = Herdr::new(&socket).list_panes().await.ok()?;
    let tabs = listed
        .iter()
        .filter_map(|pane| pane.tab_id.clone())
        .collect();
    let panes = listed
        .into_iter()
        .map(|pane| (pane.pane_id.clone(), pane))
        .collect();
    Some(PaneListing { panes, tabs })
}

// ---------------------------------------------------------------------------
// At boot, before the Pool workspace is known
// ---------------------------------------------------------------------------

/// Crash every Conversation recorded live by a previous engine run (they do not resume), except
/// enlisted ones, which `adopt_enlisted_at_boot` re-adopts while their pane lives, and started ones with
/// a launch on record in a terminal-backed pool, which `adopt_started_at_boot` settles.
pub fn crash_stale_at_boot(s: &mut Session) {
    for rec in load(s) {
        if rec.status != ConversationStatus::Live {
            continue;
        }
        // An enlisted Conversation gets a chance to re-adopt first: its pane is the operator's, still
        // alive, and the record names it.
        if rec.enlisted.is_some() {
            continue;
        }
        // A started one with a pane on record gets the same chance, once the Pool workspace is known.
        if terminal_backed(s) && launch_of(s, &rec.id).is_some() {
            continue;
        }
        let _ = write_conversation_status(&rec.file, ConversationStatus::Crashed);
        event1(
            s,
            &rec.id,
            TicketEventKind::Crash,
            json!({ "reason": "engine restarted and the Conversation had no pane to re-adopt" }),
        );
    }
}

// Whether the End in flight when the engine stopped had already handed its merge on (review F4): a
// conflict, a blocked merge or a resolver after the End's request means an interrupt holds the ending
// now, and replaying the merge would run it twice.
fn end_awaits_answer(s: &Session, id: &str) -> bool {
    let events = read_events(runs_dir(s), id);
    let Some(asked) = events
        .iter()
        .rposition(|e| e.kind == TicketEventKind::EndRequested)
    else {
        return false;
    };
    events[asked..].iter().any(|e| {
        matches!(
            e.kind,
            TicketEventKind::MergeConflict
                | TicketEventKind::MergeBlocked
                | TicketEventKind::Resolver
        )
    })
}

fn has_merge_interrupt(s: &Session, id: &str) -> bool {
    s.state.interrupts.iter().any(|i| {
        i.ticket_id == id
            && matches!(
                i.kind,
                InterruptKind::MergeConflict | InterruptKind::MergeApproval
            )
    })
}

// Finish, at boot, an End the engine stopped in the middle of (issue #140): replayed from the start when
// its merge had not been handed on, or held as ending when an interrupt already owns it, so the pending
// answer finishes it (`answer_merge`) and nothing merges twice. A merge handed on with no interrupt
// waiting was a resolver cut off mid-run: the engine raises the manual merge-conflict interrupt itself,
// so Resume re-attempts the merge rather than the End standing there forever.
async fn finish_end_at_boot(engine: &Engine, id: &str, listing: Option<PaneListing>) {
    let key = id.to_owned();
    let Ok(awaits) = engine.call(move |s| end_awaits_answer(s, &key)).await else {
        return;
    };
    if !awaits {
        let _ = end_with(engine, id, None, listing, AnswerBy::Operator).await;
        return;
    }
    let Ok(rt) = claim_detached(engine, id, listing).await else {
        return;
    };
    let _ = engine
        .call(move |s| {
            if rt.with(|r| r.ending) {
                return;
            }
            let id = rt.id();
            rt.with(|r| r.ending = true);
            let asked = read_events(runs_dir(s), &id)
                .iter()
                .rfind(|e| e.kind == TicketEventKind::EndRequested)
                .cloned();
            if let Some(Some(serde_json::Value::String(closing))) =
                asked.map(|e| e.payload.get("closing").cloned())
            {
                rt.with(|r| r.closing = Some(closing));
            }
            if !has_merge_interrupt(s, &id) {
                let branch = rt.with(|r| r.worktree.branch.clone());
                raise_interrupt(
                    s,
                    interrupt(
                        &id,
                        InterruptKind::MergeConflict,
                        format!(
                            "The engine stopped while the resolver ran on conversation {id}'s End; \
                             the branch is parked at {branch}. Resolve it by hand, or answer resume \
                             to re-attempt the merge."
                        ),
                    ),
                );
            }
            publish(s);
        })
        .await;
}

// Boot adoption, one pass at a time: the boot's own and a later retry off the pane survey never claim
// the same record twice.
async fn serially<F, Fut>(engine: &Engine, pass: F)
where
    F: FnOnce(Engine) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let Ok(lock) = engine.call(|s| Arc::clone(&s.conversations.passes)).await else {
        return;
    };
    let _turn = lock.lock().await;
    pass(engine.clone()).await;
}

/// Try both adoptions again for live records a boot could not settle (the daemon did not answer, or a
/// pane could not be read); a no-op when there are none or a try is in flight.
pub async fn readopt_pending(engine: &Engine) {
    let go = engine
        .call(|s| {
            if s.conversations.retrying || !terminal_backed(s) {
                return false;
            }
            let pending = load(s).iter().any(|rec| {
                rec.status == ConversationStatus::Live
                    && !s.conversations.runtimes.contains_key(&rec.id)
            });
            if !pending {
                return false;
            }
            s.conversations.retrying = true;
            true
        })
        .await;
    if go != Ok(true) {
        return;
    }
    serially(engine, |engine| async move {
        adopt_enlisted_pass(&engine).await;
        adopt_started_pass(&engine).await;
    })
    .await;
    let _ = engine.call(|s| s.conversations.retrying = false).await;
}

// ---------------------------------------------------------------------------
// Started Conversations
// ---------------------------------------------------------------------------

/// Re-adopt live started Conversations at boot (issue #140, the ADR-0018 amendment). A Restart or Stop
/// leaves the pane and its TUI running, so a restart no longer ends the talk. The recorded pane decides,
/// against one listing of herdr's panes:
///
/// - listed as recorded (its terminal id, or the same tab, the Pool workspace and the recorded
///   directory, ADR-0027) with its TUI still running: re-adopted, its runtime back the way a launch
///   leaves it: the tab, so End closes it; the derived log, re-derived whole from its Stream file; the
///   Turn-state tick and the Notice queue (empty: Notices were never persisted, and one dropped at
///   shutdown was logged as dropped); the Live attempt; and the crash watch.
/// - listed as recorded with its TUI exited, or gone from the listing: crashed with its branch kept, its
///   agent identity released and its tab closed, so a Restart never leaves a tab open for good.
/// - listed, but as something else: crashed and left exactly as it is for the operator, tab and agent
///   untouched, because the id no longer names this Conversation's terminal.
///
/// An End that was in flight when the engine stopped is finished as the ending it was, whatever the
/// pane's state. A daemon that cannot be asked changes nothing: the records stay live, their panes stay
/// the pool's, and the pane survey's next listing tries again.
pub async fn adopt_started_at_boot(engine: &Engine) {
    serially(engine, |engine| async move {
        adopt_started_pass(&engine).await;
    })
    .await;
}

enum Next {
    Skip,
    FinishEnd,
    Done,
    Adopt(
        Rt,
        Option<&'static HarnessDescriptor>,
        Launch,
        ConversationRecord,
    ),
}

// The decision for one started record, in one stretch: skip it, hand it to its End, crash it, or build
// the runtime to adopt.
fn decide_started(
    s: &mut Session,
    id: &str,
    listing: &PaneListing,
    workspace_id: Option<&str>,
) -> Next {
    if s.conversations.runtimes.contains_key(id) || claiming(s, id) {
        return Next::Skip;
    }
    let Some(rec) = record_of(s, id).filter(|rec| rec.status == ConversationStatus::Live) else {
        return Next::Skip;
    };
    let Some(launch) = launch_of(s, id) else {
        return Next::Skip;
    };
    if end_requested(s, id) {
        return Next::FinishEnd;
    }
    let exit_code_path = js::path_join(&[&s.runs_dir, &attempt_exit_code_name(id, None, false)]);
    let launched_at = chrono::DateTime::parse_from_rfc3339(&launch.at)
        .map(|at| at.timestamp_millis() as f64)
        .unwrap_or(f64::NAN);
    let tui_exited = js::exists(&exit_code_path)
        && std::fs::metadata(&exit_code_path)
            .map(|meta| js::mtime_ms(&meta) >= launched_at)
            .unwrap_or(false);
    let listed = listing.panes.contains_key(&launch.pane_id);
    let ours = listed_as_recorded(listing, &launch, workspace_id);
    if listed && !ours {
        let _ = write_conversation_status(&rec.file, ConversationStatus::Crashed);
        event1(
            s,
            id,
            TicketEventKind::Crash,
            json!({ "reason": format!("engine restarted and herdr lists pane {} as another terminal", launch.pane_id) }),
        );
        s.log(format!(
            "conversation {id}: crashed at boot; herdr lists its pane {} as another terminal, so its tab and agent were left as they are",
            launch.pane_id
        ));
        publish(s);
        return Next::Done;
    }
    if !listed || tui_exited {
        crash_at_boot(
            s,
            &rec,
            &launch,
            listing,
            if tui_exited {
                "its TUI had exited"
            } else {
                "its pane was gone"
            },
        );
        return Next::Done;
    }
    let descriptor = harness_descriptor(&js::trim(&rec.harness).to_lowercase());
    let rt = started_runtime(s, &rec, launch.tab_id.clone());
    Next::Adopt(rt, descriptor, launch, rec)
}

// A started Conversation found dead at boot: crashed as before, branch kept, plus what a crash while the
// engine ran would have done and a dead engine could not: its agent identity released and its tab
// closed. The tab is closed unless herdr lists it holding none of this launch's pane (a reused id); a
// tab herdr no longer has is closed already; a refusal is logged (tab-close-failed).
fn crash_at_boot(
    s: &mut Session,
    rec: &ConversationRecord,
    launch: &Launch,
    listing: &PaneListing,
    why: &str,
) {
    let _ = write_conversation_status(&rec.file, ConversationStatus::Crashed);
    event1(
        s,
        &rec.id,
        TicketEventKind::Crash,
        json!({ "reason": format!("engine restarted and {why}") }),
    );
    s.log(format!(
        "conversation {}: crashed at boot, {why}; its tab is closed",
        rec.id
    ));
    release_agent(s, Some(&launch.pane_id), &rec.harness);
    publish(s);
    let Some(tab) = launch.tab_id.clone() else {
        return;
    };
    if tab_is_foreign(listing, launch) {
        return;
    }
    let engine = s.engine();
    let herdr = Herdr::new(&s.herdr_socket);
    let id = rec.id.clone();
    tokio::spawn(async move {
        close_conversation_tab(&engine, herdr, id, tab, "crashed at boot".to_owned()).await;
    });
}

async fn adopt_started_pass(engine: &Engine) {
    let Ok(live) = engine
        .call(|s| {
            if !terminal_backed(s) {
                return Vec::new();
            }
            load(s)
                .into_iter()
                .filter(|rec| {
                    rec.status == ConversationStatus::Live
                        && rec.enlisted.is_none()
                        && !s.conversations.runtimes.contains_key(&rec.id)
                        && launch_of(s, &rec.id).is_some()
                })
                .map(|rec| rec.id)
                .collect::<Vec<_>>()
        })
        .await
    else {
        return;
    };
    if live.is_empty() {
        return;
    }
    let Some(listing) = pane_listing(engine).await else {
        return;
    };
    let Ok(workspace) = engine
        .call(|s| crate::tickets::attempt_env_of(s, None).pool_workspace)
        .await
    else {
        return;
    };
    let workspace_id = workspace.id().await;
    for id in live {
        let (key, listing_now, ws) = (id.clone(), listing.clone(), workspace_id.clone());
        let Ok(next) = engine
            .call(move |s| decide_started(s, &key, &listing_now, ws.as_deref()))
            .await
        else {
            return;
        };
        match next {
            Next::Skip | Next::Done => {}
            Next::FinishEnd => finish_end_at_boot(engine, &id, Some(listing.clone())).await,
            Next::Adopt(rt, descriptor, launch, rec) => {
                adopt_started(engine, rt, descriptor, launch, rec).await;
            }
        }
    }
}

async fn adopt_started(
    engine: &Engine,
    rt: Rt,
    descriptor: Option<&'static HarnessDescriptor>,
    launch: Launch,
    rec: ConversationRecord,
) {
    let id = rec.id.clone();
    let engine_in = engine.clone();
    let _ = claim(engine, &id, async move {
        let engine = engine_in;
        if settle_turn(&engine, &rt, descriptor).await.is_err() {
            // The pane could not be read: leave the record live, as for an enlisted one; the survey's
            // next listing tries again rather than ending a talk that may still be there. No tick
            // follows, so nothing may serve what the reads recorded.
            let pane = launch.pane_id.clone();
            let _ = engine.call(move |s| s.pane_reads.forget(&pane)).await;
            return;
        }
        let _ = engine
            .call(move |s| {
                // An End, or another claim, may have landed across the reads.
                if s.conversations.runtimes.contains_key(&rec.id) || end_requested(s, &rec.id) {
                    s.pane_reads.forget(&launch.pane_id);
                    return;
                }
                let (stream_path, log_path) =
                    rt.with(|r| (r.stream_path.clone(), r.log_path.clone()));
                let tailer = crate::attempt_run::start_pane_stream_tail(&stream_path, &log_path, 0);
                rt.with(|r| r.tailer = Some(tailer));
                report_agent(&rt, state_of(&rt));
                s.conversations.runtimes.insert(rec.id.clone(), rt.clone());
                crate::live_attempts::register(
                    s,
                    &rec.id,
                    LiveAttemptEntry {
                        started_at: launch.at.clone(),
                        ..LiveAttemptEntry::new(
                            1,
                            Some(launch.pane_id.clone()),
                            launch.tab_id.clone(),
                        )
                    },
                );
                super::end::watch_for_crash(s, &rt);
                record_assignment(s, &rec.id, assignment_of(&rec));
                start_tick(s, &rt);
                s.log(format!(
                    "conversation {}: re-adopted at boot from live pane {}",
                    rec.id, launch.pane_id
                ));
                publish(s);
            })
            .await;
    })
    .await;
}

fn state_of(rt: &Rt) -> PaneAgentState {
    if rt.with(|r| r.turn.state) == ac_protocol::TurnSide::Waiting {
        PaneAgentState::Blocked
    } else {
        PaneAgentState::Working
    }
}

fn assignment_of(rec: &ConversationRecord) -> Assignment {
    Assignment {
        harness: rec.harness.clone(),
        model: rec.model.clone(),
        effort: rec.effort.clone().filter(|e| !e.is_empty()),
        drivers: if rec.drivers.is_empty() {
            DEFAULT_DRIVERS.to_owned()
        } else {
            rec.drivers.clone()
        },
        verify: None,
    }
}

// ---------------------------------------------------------------------------
// Enlisted Conversations
// ---------------------------------------------------------------------------

/// Re-adopt live enlisted Conversations at boot (issue #101): the operator's pane may still be there, and
/// the record names it, so a fresh runtime re-tracks Turn state, delivers Notices and Spawns again. A
/// pane that has left herdr's listing is the crash ADR-0018 prescribes, branch kept. Best effort, like
/// the terminal-attempt reconcile beside it: a daemon that cannot be asked changes nothing, and the
/// records stay live for the next boot.
pub async fn adopt_enlisted_at_boot(engine: &Engine) {
    serially(engine, |engine| async move {
        adopt_enlisted_pass(&engine).await;
    })
    .await;
}

enum NextEnlisted {
    Skip,
    FinishEnd,
    Done,
    Adopt(Rt, &'static HarnessDescriptor, ConversationRecord),
}

fn decide_enlisted(s: &mut Session, id: &str, listed: &HashSet<String>) -> NextEnlisted {
    if s.conversations.runtimes.contains_key(id) || claiming(s, id) {
        return NextEnlisted::Skip;
    }
    let Some(rec) = record_of(s, id).filter(|rec| rec.status == ConversationStatus::Live) else {
        return NextEnlisted::Skip;
    };
    let Some(found) = rec.enlisted.clone() else {
        return NextEnlisted::Skip;
    };
    if end_requested(s, id) {
        return NextEnlisted::FinishEnd;
    }
    if !listed.contains(&found.pane_id) {
        // The pane went while the engine was down: crashed, branch kept.
        let _ = write_conversation_status(&rec.file, ConversationStatus::Crashed);
        event1(
            s,
            id,
            TicketEventKind::Crash,
            json!({ "reason": "enlisted pane gone at boot" }),
        );
        return NextEnlisted::Done;
    }
    let Some(descriptor) = harness_descriptor(&js::trim(&rec.harness).to_lowercase()) else {
        let _ = write_conversation_status(&rec.file, ConversationStatus::Crashed);
        event1(
            s,
            id,
            TicketEventKind::Crash,
            json!({ "reason": format!("no harness the engine knows for enlisted conversation {id}") }),
        );
        return NextEnlisted::Done;
    };
    let rt = enlisted_runtime(
        s,
        EnlistedFacts {
            id: &rec.id,
            file: rec.file.clone(),
            pane_id: &found.pane_id,
            tab_id: found.tab_id.clone(),
            harness: &rec.harness,
            title: &rec.title,
            directory: &found.directory,
            branch: &found.branch,
            role: rec.role,
        },
    );
    NextEnlisted::Adopt(rt, descriptor, rec)
}

async fn adopt_enlisted_pass(engine: &Engine) {
    let Ok(live) = engine
        .call(|s| {
            if !terminal_backed(s) {
                return Vec::new();
            }
            load(s)
                .into_iter()
                .filter(|rec| {
                    rec.status == ConversationStatus::Live
                        && rec.enlisted.is_some()
                        && !s.conversations.runtimes.contains_key(&rec.id)
                })
                .map(|rec| rec.id)
                .collect::<Vec<_>>()
        })
        .await
    else {
        return;
    };
    if live.is_empty() {
        return;
    }
    let Ok(socket) = engine.call(|s| s.herdr_socket.clone()).await else {
        return;
    };
    let Ok(agents) = Herdr::new(&socket).list_agents().await else {
        return;
    };
    let listed: HashSet<String> = agents.into_iter().map(|agent| agent.pane_id).collect();
    for id in live {
        let (key, listed_now) = (id.clone(), listed.clone());
        let Ok(next) = engine
            .call(move |s| decide_enlisted(s, &key, &listed_now))
            .await
        else {
            return;
        };
        match next {
            NextEnlisted::Skip | NextEnlisted::Done => {}
            NextEnlisted::FinishEnd => finish_end_at_boot(engine, &id, None).await,
            NextEnlisted::Adopt(rt, descriptor, rec) => {
                adopt_enlisted(engine, rt, descriptor, rec).await;
            }
        }
    }
}

async fn adopt_enlisted(
    engine: &Engine,
    rt: Rt,
    descriptor: &'static HarnessDescriptor,
    rec: ConversationRecord,
) {
    let id = rec.id.clone();
    let pane = rt.with(|r| r.pane_id.clone()).unwrap_or_default();
    let engine_in = engine.clone();
    let _ = claim(engine, &id, async move {
        let engine = engine_in;
        if settle_turn(&engine, &rt, Some(descriptor)).await.is_err() {
            // The pane could not be read: leave the record live, the next listing tries again rather
            // than destroying a talk that may still be there. No tick follows, so nothing may serve
            // what the reads recorded.
            let found = pane.clone();
            let _ = engine.call(move |s| s.pane_reads.forget(&found)).await;
            return;
        }
        let _ = engine
            .call(move |s| {
                // An End, or another claim, may have landed across the reads.
                if s.conversations.runtimes.contains_key(&rec.id) || end_requested(s, &rec.id) {
                    s.pane_reads.forget(&pane);
                    return;
                }
                report_agent(&rt, state_of(&rt));
                s.conversations.runtimes.insert(rec.id.clone(), rt.clone());
                super::end::watch_for_crash(s, &rt);
                record_assignment(s, &rec.id, assignment_of(&rec));
                start_tick(s, &rt);
                publish(s);
            })
            .await;
    })
    .await;
}
