//! Ending a Conversation: End, the merge answers, a pane lost without End.

use serde_json::{Map, Value, json};

use ac_core::conversation_record::write_conversation_status;
use ac_io::git::{self, MergeFailure, MergeResult, WorktreeInfo};
use ac_io::herdr::{Herdr, is_tab_not_found};
use ac_protocol::{AnswerBy, ConversationStatus, Interrupt, InterruptKind, TicketEventKind};

use super::adopt::pane_listing;
use super::*;
use crate::actor::Engine;
use crate::attempt_ending::PaneEnding;
use crate::attempt_ending::wait_for_pane_ending;
use crate::checkout_gate::{
    hold_pool_checkout, pool_checkout_free, pool_checkout_held, release_pool_checkout,
};
use crate::error::EngineError;
use crate::interrupts::{clear_interrupt, interrupt, raise_interrupt};
use crate::pane_survey::{PaneListing, listed_as_recorded};

fn ending_text(ending: PaneEnding) -> &'static str {
    match ending {
        PaneEnding::PaneEnd => "pane-end",
        PaneEnding::ExitCode => "exit-code",
        PaneEnding::PaneGone => "pane-gone",
        PaneEnding::Released => "released",
    }
}

/// Watch the pane for the end nobody asked for (the tab closed, the TUI exited): that is a crash. The
/// watch is released by End and by shutdown.
pub(crate) fn watch_for_crash(s: &mut Session, rt: &Rt) {
    let (herdr, pane, exit_code_path, release) = rt.with(|r| {
        (
            r.herdr.clone(),
            r.pane_id.clone(),
            r.exit_code_path.clone(),
            r.release.clone(),
        )
    });
    let Some(pane) = pane else { return };
    let engine = s.engine();
    let rt = rt.clone();
    tokio::spawn(async move {
        let ending =
            wait_for_pane_ending(&herdr, &pane, &exit_code_path, Some(&release), None).await;
        let _ = engine
            .call(move |s| {
                if rt.with(|r| r.release.is_cancelled() || r.ending) {
                    return;
                }
                mark_crashed(s, &rt, ending);
            })
            .await;
    });
}

fn mark_crashed(s: &mut Session, rt: &Rt, ending: PaneEnding) {
    let (id, file, pane, harness, branch, enlisted, close_tabs, tailer) = rt.with(|r| {
        (
            r.id.clone(),
            r.file.clone(),
            r.pane_id.clone(),
            r.harness.clone(),
            r.worktree.branch.clone(),
            r.enlisted,
            r.close_tabs,
            r.tailer.take(),
        )
    });
    // The pane is gone: drain the tailer so the derived log holds what it showed.
    if let Some(tailer) = tailer {
        tokio::spawn(async move {
            let _ = tailer.finish().await;
        });
    }
    stop_tick(s, rt);
    let _ = write_conversation_status(&file, ConversationStatus::Crashed);
    event1(
        s,
        &id,
        TicketEventKind::Crash,
        json!({ "reason": format!("pane lost without End ({})", ending_text(ending)) }),
    );
    release_agent(s, pane.as_deref(), &harness);
    // A launch-only run clears its own Live attempt where it records the ending: here, and at End below.
    crate::live_attempts::clear(s, &id, 1);
    if !enlisted && close_tabs {
        crate::tickets::close_attempt_tabs(s, &id);
    }
    // Before the runtime leaves the map, as in finish_end: note_ended reads its notices to drop and log
    // whatever never delivered.
    super::notices::note_ended(s, &id, &branch, None, true);
    s.conversations.runtimes.shift_remove(&id);
    publish(s);
}

// ---------------------------------------------------------------------------
// Closing the tab
// ---------------------------------------------------------------------------

// A tab this module closed: the pane survey lists again, so the snapshot's Finished terminals count
// drops at once.
fn tab_closed(s: &mut Session) {
    crate::pane_survey::refresh_in_background(s);
}

/// Close one of a Conversation's tabs and record it closed (issue #139), so the ending's sweep of every
/// tab under the id (`close_attempt_tabs`) does not ask herdr again; a tab herdr no longer has is closed
/// already. Best-effort, as every close is, but never silent (issue #139): a tab herdr refused to close
/// is on the Conversation's log and the pool's.
pub(crate) async fn close_conversation_tab(
    engine: &Engine,
    herdr: Herdr,
    id: String,
    tab_id: String,
    reason: String,
) {
    let key = id.clone();
    let terminal_id = engine
        .call(move |s| launch_of(s, &key).and_then(|launch| launch.terminal_id))
        .await
        .unwrap_or(None);
    let closed = match herdr.close_tab(&tab_id).await {
        Ok(()) => Ok(()),
        Err(err) if is_tab_not_found(&err) => Ok(()),
        Err(err) => Err(err.to_string()),
    };
    let _ = engine
        .call(move |s| match closed {
            Ok(()) => {
                let mut payload = Map::new();
                payload.insert("tab_id".into(), tab_id.into());
                if let Some(terminal) = terminal_id {
                    payload.insert("terminal_id".into(), terminal.into());
                }
                payload.insert("reason".into(), reason.into());
                event(s, &id, TicketEventKind::TabClosed, payload, 1);
                tab_closed(s);
            }
            Err(error) => {
                event1(
                    s,
                    &id,
                    TicketEventKind::TabCloseFailed,
                    json!({ "tab_id": tab_id, "error": error }),
                );
                s.log(format!(
                    "conversation {id}: herdr tab {tab_id} could not be closed ({error})"
                ));
            }
        })
        .await;
}

// An enlisted Conversation's tab and directory were the operator's before the pool's and stay theirs
// (issue #101): the engine never closes the tab and never removes the directory, at End or at any other
// ending. A started Conversation keeps the ordinary cleanup.
async fn close_runtime_tab(engine: &Engine, rt: &Rt) {
    let (enlisted, tab, close_tabs, herdr, id) = rt.with(|r| {
        (
            r.enlisted,
            r.tab_id.clone(),
            r.close_tabs,
            r.herdr.clone(),
            r.id.clone(),
        )
    });
    let Some(tab) = tab else { return };
    if enlisted || !close_tabs {
        return;
    }
    close_conversation_tab(engine, herdr, id, tab, "end".to_owned()).await;
}

fn dispose_worktree(s: &Session, rt: &Rt) {
    let (enlisted, worktree) = rt.with(|r| (r.enlisted, r.worktree.clone()));
    if enlisted {
        return;
    }
    git::remove_worktree(&s.cwd, &worktree);
}

pub(crate) fn finish_end(s: &mut Session, rt: &Rt, merged: bool) {
    stop_tick(s, rt);
    let (id, file, closing, by, pane, harness, branch, enlisted, close_tabs) = rt.with(|r| {
        (
            r.id.clone(),
            r.file.clone(),
            r.closing.clone(),
            r.ended_by,
            r.pane_id.clone(),
            r.harness.clone(),
            r.worktree.branch.clone(),
            r.enlisted,
            r.close_tabs,
        )
    });
    let _ = write_conversation_status(&file, ConversationStatus::Ended);
    event1(
        s,
        &id,
        TicketEventKind::Ended,
        json!({
            "closing": closing,
            "by": by.unwrap_or(AnswerBy::Operator).as_str(),
            "merged": merged,
        }),
    );
    release_agent(s, pane.as_deref(), &harness);
    crate::live_attempts::clear(s, &id, 1);
    // An enlisted Conversation's tab is the operator's and never closes (issue #101); the engine opened
    // no tab under this id to close either. One whose tab herdr lists as someone else's is not swept
    // either.
    if !enlisted && close_tabs {
        crate::tickets::close_attempt_tabs(s, &id);
    }
    // While the runtime is still in the map: note_ended reads its notices to drop and log whatever
    // never delivered.
    super::notices::note_ended(s, &id, &branch, closing.as_deref(), false);
    s.conversations.runtimes.shift_remove(&id);
    // The one place every ending path converges (End's no-commit fast path and its merge-chain success,
    // plus the three merge answers below): none of those callers run inside the drive loop, so this is
    // the single spot that guarantees the snapshot stream sees the ending promptly, mirroring
    // mark_crashed's own emit.
    publish(s);
}

// ---------------------------------------------------------------------------
// A runtime for an End on a record with no runtime
// ---------------------------------------------------------------------------

/// The runtime for an End on a record live with no runtime (issue #140): a boot that could not ask the
/// daemon, or could not read the pane, left it unadopted, and the operator must still be able to End it.
/// Its tab is closed only when herdr can be asked and does not list that tab as someone else's; it is
/// never swept by id otherwise. An enlisted one is rebuilt as found, and its tab is never closed anyway.
async fn detached_runtime(
    engine: &Engine,
    id: &str,
    known: Option<PaneListing>,
) -> Result<Rt, String> {
    let key = id.to_owned();
    let first = engine
        .call(move |s| {
            let rec = record_of(s, &key);
            let Some(rec) = rec.filter(|rec| rec.status == ConversationStatus::Live) else {
                return Err(format!("end conversation: no live conversation {key}"));
            };
            if let Some(found) = &rec.enlisted {
                return Ok(Err(enlisted_runtime(
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
                )));
            }
            Ok(Ok(launch_of(s, &key)))
        })
        .await
        .map_err(|gone| gone.to_string())??;
    let launch = match first {
        Err(runtime) => return Ok(runtime),
        Ok(launch) => launch,
    };
    let listing = match known {
        Some(listing) => Some(listing),
        None => pane_listing(engine).await,
    };
    let workspace = engine
        .call(|s| crate::tickets::attempt_env_of(s, None).pool_workspace)
        .await
        .map_err(|gone| gone.to_string())?;
    let workspace_id = workspace.id().await;
    // The pane is this Conversation's to let go only when herdr lists it as recorded or no longer lists
    // it; listed as another terminal, or with no listing to go by, its agent binding is not released
    // (review F8, as the boot's own rule has it), and its tab is not closed.
    let listed = match (&launch, &listing) {
        (Some(launch), Some(listing)) => listing.panes.contains_key(&launch.pane_id),
        _ => false,
    };
    let pane_ours = match (&launch, &listing) {
        (Some(launch), Some(listing)) => {
            !listed || listed_as_recorded(listing, &launch.recorded(), workspace_id.as_deref())
        }
        _ => false,
    };
    let tab_ours = pane_ours
        && match (&launch, &listing) {
            (Some(launch), Some(listing)) => {
                launch.tab_id.is_some() && !tab_is_foreign(listing, launch)
            }
            _ => false,
        };
    let key = id.to_owned();
    let tab = launch.as_ref().and_then(|l| l.tab_id.clone());
    engine
        .call(move |s| {
            let rec = record_of(s, &key)
                .ok_or_else(|| format!("end conversation: no live conversation {key}"))?;
            let runtime = started_runtime(s, &rec, if tab_ours { tab } else { None });
            runtime.with(|r| {
                if !pane_ours {
                    r.pane_id = None;
                }
                if !tab_ours {
                    r.close_tabs = false;
                }
            });
            Ok(runtime)
        })
        .await
        .map_err(|gone| gone.to_string())?
}

/// Whether a tab herdr lists holds none of the recorded pane: its id was reused, and closing it by id
/// would close someone else's terminal.
pub(crate) fn tab_is_foreign(listing: &PaneListing, launch: &Launch) -> bool {
    let Some(tab) = &launch.tab_id else {
        return false;
    };
    let in_tab: Vec<_> = listing
        .panes
        .values()
        .filter(|pane| pane.tab_id.as_deref() == Some(tab.as_str()))
        .collect();
    if in_tab.is_empty() {
        return false;
    }
    !in_tab.iter().any(|pane| {
        pane.pane_id == launch.pane_id
            && (launch.terminal_id.is_none()
                || pane.terminal_id.is_none()
                || pane.terminal_id == launch.terminal_id)
    })
}

/// Claim a runtime for an End on a record with no runtime, once: a second End, or an adoption pass,
/// racing it waits and gets the same runtime.
pub(crate) async fn claim_detached(
    engine: &Engine,
    id: &str,
    known: Option<PaneListing>,
) -> Result<Rt, String> {
    let (engine_for, key) = (engine.clone(), id.to_owned());
    let claimed = claim(engine, id, async move {
        let engine = engine_for;
        let existing = {
            let key = key.clone();
            engine
                .call(move |s| s.conversations.runtime(&key))
                .await
                .map_err(|gone| gone.to_string())?
        };
        if let Some(existing) = existing {
            return Ok(existing);
        }
        let runtime = detached_runtime(&engine, &key, known).await?;
        let key2 = key.clone();
        engine
            .call(move |s| match s.conversations.runtime(&key2) {
                Some(raced) => raced,
                None => {
                    s.conversations.runtimes.insert(key2, runtime.clone());
                    runtime
                }
            })
            .await
            .map_err(|gone| gone.to_string())
    })
    .await;
    claimed.unwrap_or_else(|| Err("the pool engine has stopped".to_owned()))
}

// ---------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------

/// End a Conversation the operator is done with, or a Steward ending itself (ADR-0030, which `by`
/// records).
pub async fn end(
    engine: &Engine,
    id: &str,
    closing: Option<String>,
    by: AnswerBy,
) -> Result<(), EngineError> {
    end_with(engine, id, closing, None, by).await
}

/// A Steward ends itself (ADR-0030): the End as the operator's, with the closing line and who asked.
pub async fn end_conversation_by_steward(
    engine: &Engine,
    id: String,
    closing: Option<String>,
) -> Result<(), EngineError> {
    end(engine, &id, closing, AnswerBy::Steward).await
}

/// End: only the operator does this (card End, Detail End, or closing the herdr tab: the last arrives
/// as a pane loss and is handled by `watch_for_crash` instead, never here), a Steward ending itself
/// excepted. The tab closes at once, before the merge is even attempted: once End is clicked the talk is
/// over regardless of how the merge goes, and a conflict's resolver gets its own fresh tab rather than
/// reusing the one just closed.
pub(crate) async fn end_with(
    engine: &Engine,
    id: &str,
    closing: Option<String>,
    listing: Option<PaneListing>,
    by: AnswerBy,
) -> Result<(), EngineError> {
    // An existing runtime goes straight on in the same stretch; one with none is claimed first.
    let (key, closing_now) = (id.to_owned(), closing.clone());
    let known = engine
        .call(move |s| {
            s.conversations
                .runtime(&key)
                .map(|rt| begin_end(s, &rt, closing_now, by).then_some(rt))
        })
        .await?;
    let rt = match known {
        Some(Some(rt)) => rt,
        Some(None) => return Ok(()),
        None => {
            let rt = claim_detached(engine, id, listing)
                .await
                .map_err(EngineError::refused)?;
            let (rt_now, closing_now) = (rt.clone(), closing.clone());
            let proceed = engine
                .call(move |s| begin_end(s, &rt_now, closing_now, by))
                .await?;
            if !proceed {
                return Ok(());
            }
            rt
        }
    };
    close_runtime_tab(engine, &rt).await;
    // The talk is over: drain the tailer so the derived log is complete.
    if let Some(tailer) = rt.with(|r| r.tailer.take()) {
        let _ = tailer.finish().await;
    }
    engine.call(move |s| finish_or_chain(s, &rt)).await?;
    Ok(())
}

// The first stretch of an End: recorded before anything moves (issue #140): an engine that stops mid End
// leaves the record live, and the next boot finishes this ending rather than calling the Conversation
// crashed, with the closing line and who asked for it as they were recorded. False when it is already
// ending.
fn begin_end(s: &mut Session, rt: &Rt, closing: Option<String>, by: AnswerBy) -> bool {
    if rt.with(|r| r.ending) {
        return false;
    }
    let id = rt.id();
    rt.with(|r| {
        r.ending = true;
        r.closing = closing.clone();
        r.ended_by = Some(by);
    });
    if !end_requested(s, &id) {
        let mut payload = Map::new();
        payload.insert(
            "closing".into(),
            closing.clone().map_or(Value::Null, Value::String),
        );
        if by == AnswerBy::Steward {
            payload.insert("by".into(), by.as_str().into());
        }
        event(s, &id, TicketEventKind::EndRequested, payload, 1);
    } else if closing.is_none() {
        let events = read_events(runs_dir(s), &id);
        let asked = events
            .iter()
            .rfind(|e| e.kind == TicketEventKind::EndRequested);
        if let Some(asked) = asked {
            if let Some(Value::String(text)) = asked.payload.get("closing") {
                rt.with(|r| r.closing = Some(text.clone()));
            }
            if asked.payload.get("by") == Some(&json!("steward")) {
                rt.with(|r| r.ended_by = Some(AnswerBy::Steward));
            }
        }
    }
    rt.with(|r| r.release.cancel());
    // Before the tab goes: the release names a pane, and a pane whose tab has just been closed is a pane
    // the daemon no longer has (issue #94). finish_end releases too, for the paths that reach an ending
    // without coming through here; a second release of a binding already dropped is a no-op, and both
    // are best-effort anyway.
    let (pane, harness) = rt.with(|r| (r.pane_id.clone(), r.harness.clone()));
    release_agent(s, pane.as_deref(), &harness);
    true
}

fn finish_or_chain(s: &mut Session, rt: &Rt) {
    let target = crate::merges::merge_target_branch(s);
    let branch = rt.with(|r| r.worktree.branch.clone());
    let has_commits = git::has_commits_beyond(&s.cwd, &target, &branch);
    if !has_commits {
        dispose_worktree(s, rt);
        finish_end(s, rt, false);
        return;
    }
    // The End answers once its ending is recorded and its tab closed; the merge goes on behind it (issue
    // #140), on the merge chain, which may wait on a Continued attempt in the pool checkout (ADR-0027),
    // and its outcome is reported the usual way: the ended record and snapshot, or a merge interrupt. A
    // merge-chain failure must never wedge the End: the Conversation is left `ending` with its worktree
    // intact, visible as a stuck End, and the chain itself stays usable for the next caller.
    use futures::FutureExt;
    let engine = s.engine();
    let previous = s.merge_chain.clone();
    let rt = rt.clone();
    let link = async move {
        previous.await;
        end_merge_link(&engine, rt).await;
    }
    .boxed()
    .shared();
    s.merge_chain = link.clone();
    tokio::spawn(link);
}

// The merge, inside its chain link and the pool checkout's gate (ADR-0027): checked as the merge is
// about to run, and a merge dropped there at a shutdown is an End the next boot finishes. A merge counts
// as in flight from the gate until it settles (including the resolver's run), which Keep talking refuses
// beside.
async fn end_merge_link(engine: &Engine, rt: Rt) {
    const WHAT: &str = "a Conversation's merge into the pool checkout is in flight";
    let first = {
        let rt = rt.clone();
        engine
            .call(move |s| {
                if pool_checkout_held(s) {
                    return None;
                }
                Some(run_end_merge(s, &rt, WHAT))
            })
            .await
    };
    let outcome = match first {
        Ok(Some(outcome)) => outcome,
        Ok(None) => {
            // Held: the link waits until the Continued attempt ends, and so does everything chained
            // behind it.
            if !matches!(pool_checkout_free(engine).await, Ok(true)) {
                return;
            }
            let rt = rt.clone();
            match engine.call(move |s| run_end_merge(s, &rt, WHAT)).await {
                Ok(outcome) => outcome,
                Err(_) => return,
            }
        }
        Err(_) => return,
    };
    let Some((hold, result)) = outcome else {
        return;
    };
    // The ending stays pending: the runtime remains in the map (still `ending`) until the raised
    // interrupt is answered, at which point answer_merge finishes it.
    let (id, file) = rt.with(|r| (r.id.clone(), r.file.clone()));
    let marker = marker_of_conversation(&id, &file);
    let _ = crate::merges::handle_merge_conflict(engine, marker, result, 1).await;
    let _ = engine.call(move |s| release_pool_checkout(s, hold)).await;
}

// The merge itself, one job: the hold taken, the branch merged. A landed merge finishes the End and lets
// the hold go; a failed one hands its result and the hold back for the resolver.
fn run_end_merge(
    s: &mut Session,
    rt: &Rt,
    what: &str,
) -> Option<(crate::checkout_gate::CheckoutHold, MergeResult)> {
    let hold = hold_pool_checkout(s, what);
    let branch = rt.with(|r| r.worktree.branch.clone());
    let result = merge_into_target(s, &branch);
    if result.ok {
        dispose_worktree(s, rt);
        let id = rt.id();
        event(s, &id, TicketEventKind::Merged, merged_payload(&result), 1);
        finish_end(s, rt, true);
        release_pool_checkout(s, hold);
        return None;
    }
    Some((hold, result))
}

/// Merge `branch` into the merge target, in whichever checkout holds it (issue #101): the engine's,
/// never one an enlisted agent works in.
pub(crate) fn merge_into_target(s: &Session, branch: &str) -> MergeResult {
    let merged = git::with_merge_checkout(&s.cwd, s.merge_target.as_deref(), |cwd| {
        git::merge_branch(cwd, branch)
    });
    match merged {
        Ok(result) => result,
        Err(err) => MergeResult {
            ok: false,
            reason: Some(MergeFailure::Blocked),
            conflicted: Vec::new(),
            blocked: Vec::new(),
            cleared: Vec::new(),
            detail: err.to_string(),
        },
    }
}

// ---------------------------------------------------------------------------
// Merge answers: merge-conflict / merge-approval answers for a Conversation id route here instead of
// through the ticket path.
// ---------------------------------------------------------------------------

// The interrupt for a merge that did not land, in either of its shapes: a conflict git started and the
// engine aborted, or a merge git refused before starting because untracked pool files stood in its way
// (#92). Both keep the merge-conflict kind (resume re-attempts the merge); only the body differs, and a
// blocked one never claims anything conflicted.
fn merge_conflict_interrupt(s: &Session, rt: &Rt, result: &MergeResult) -> Interrupt {
    let WorktreeInfo { path, branch } = rt.with(|r| r.worktree.clone());
    let id = rt.id();
    let parked = format!(
        "the Conversation's work is parked on branch {branch}, checked out at {path}.\n{}",
        if result.detail.is_empty() {
            String::new()
        } else {
            format!("git said: {}\n", result.detail)
        }
    );
    if result.reason == Some(MergeFailure::Blocked) {
        return interrupt(
            &id,
            InterruptKind::MergeConflict,
            format!(
                "merging {branch} onto the working branch was blocked: {}{parked}",
                git::blocked_merge_explanation(&s.cwd, result)
            ),
        );
    }
    let files = if result.conflicted.is_empty() {
        "(no unmerged paths listed)".to_owned()
    } else {
        result.conflicted.join(", ")
    };
    interrupt(
        &id,
        InterruptKind::MergeConflict,
        format!(
            "merging {branch} onto the working branch failed; the merge was aborted and the working \
             branch was left clean.\nconflicted files: {files}\n{parked}resolve the conflict by hand \
             and resume; the merge is re-attempted on resume."
        ),
    )
}

fn manual_merge_interrupt(
    s: &Session,
    rt: &Rt,
    result: &MergeResult,
    attempt_note: &str,
) -> Interrupt {
    let mut base = merge_conflict_interrupt(s, rt, result);
    // A blocked merge never reached the resolver's resolution; its body already says what stood in the
    // way.
    if result.reason == Some(MergeFailure::Blocked) {
        return base;
    }
    base.body = format!(
        "{}\nThe resolver agent attempted: {attempt_note}",
        base.body
    );
    base
}

fn failed_merge_event(s: &Session, rt: &Rt, result: &MergeResult) {
    let id = rt.id();
    if result.reason == Some(MergeFailure::Blocked) {
        event1(
            s,
            &id,
            TicketEventKind::MergeBlocked,
            json!({ "files": result.blocked }),
        );
    } else {
        event1(
            s,
            &id,
            TicketEventKind::MergeConflict,
            json!({ "files": result.conflicted }),
        );
    }
}

fn merged_payload(result: &MergeResult) -> Map<String, Value> {
    crate::merges::merged_payload(result)
}

fn resume_merge(s: &mut Session, rt: &Rt, pending: &Interrupt) {
    let id = rt.id();
    let branch = rt.with(|r| r.worktree.branch.clone());
    let result = merge_into_target(s, &branch);
    if !result.ok {
        failed_merge_event(s, rt, &result);
        clear_interrupt(
            s,
            pending,
            format!(
                "merge re-attempt for conversation {id} {}",
                if result.reason == Some(MergeFailure::Blocked) {
                    "is still blocked"
                } else {
                    "still conflicts"
                }
            ),
        );
        let again = merge_conflict_interrupt(s, rt, &result);
        raise_interrupt(s, again);
        return;
    }
    dispose_worktree(s, rt);
    event(s, &id, TicketEventKind::Merged, merged_payload(&result), 1);
    clear_interrupt(
        s,
        pending,
        format!("interrupt answered for conversation {id} (merge-conflict): merge landed"),
    );
    finish_end(s, rt, true);
}

fn approve_merge(s: &mut Session, rt: &Rt, pending: &Interrupt) {
    let id = rt.id();
    let worktree = rt.with(|r| r.worktree.clone());
    git::commit_merge(&worktree);
    let result = merge_into_target(s, &worktree.branch);
    if !result.ok {
        failed_merge_event(s, rt, &result);
        clear_interrupt(
            s,
            pending,
            format!(
                "merge after resolver approval for conversation {id} {}",
                if result.reason == Some(MergeFailure::Blocked) {
                    "is blocked"
                } else {
                    "still conflicts"
                }
            ),
        );
        let manual = manual_merge_interrupt(
            s,
            rt,
            &result,
            "the resolver's resolution did not merge cleanly on approval",
        );
        raise_interrupt(s, manual);
        return;
    }
    dispose_worktree(s, rt);
    event(s, &id, TicketEventKind::Merged, merged_payload(&result), 1);
    clear_interrupt(
        s,
        pending,
        format!(
            "interrupt answered for conversation {id} (merge-approval): resolver resolution committed"
        ),
    );
    finish_end(s, rt, true);
}

fn reject_merge(s: &mut Session, rt: &Rt, pending: &Interrupt) {
    let id = rt.id();
    let path = rt.with(|r| r.worktree.path.clone());
    git::merge_abort(&path);
    clear_interrupt(
        s,
        pending,
        format!(
            "merge-approval rejected for conversation {id}: staged resolution discarded, branch parked"
        ),
    );
    // Unlike a ticket's rejection, the Conversation is not reopened: only the operator starts a new one
    // (spec: only the operator ends a Conversation, and ending is terminal). The branch stays parked.
    finish_end(s, rt, false);
}

/// A merge-conflict or merge-approval answer whose id names a live Conversation.
pub fn answer_merge(
    s: &mut Session,
    id: &str,
    pending: &Interrupt,
    approve: Option<bool>,
) -> anyhow::Result<()> {
    let Some(rt) = s.conversations.runtime(id) else {
        anyhow::bail!("conversation merge answer: no live conversation {id}");
    };
    if pending.kind == InterruptKind::MergeConflict {
        resume_merge(s, &rt, pending);
        return Ok(());
    }
    if approve == Some(true) {
        approve_merge(s, &rt, pending);
    } else {
        reject_merge(s, &rt, pending);
    }
    Ok(())
}
