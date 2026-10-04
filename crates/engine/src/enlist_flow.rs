//! Enlist (issue #101, docs/specs/2026-09-19-enlist-herdr-terminal.md; engine.ts 3935-4196 and
//! 10163-10699): the engine's one-shot orchestration behind `POST /api/enlist`, and the endings of an
//! enlisted attempt. Where [`crate::enlisted`] owns what lives on in the pane (the Turn tick, the
//! teaching Turn, the ending watch), this module re-judges the pane, applies the branch rule, claims
//! the runtime and writes the pool, and records how the enlisted attempt ended.

use std::path::Path;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use ac_core::assignment::{Assignment, DEFAULT_DRIVERS, assign_request, resolve_ticket_assignment};
use ac_core::conversation_record::{load_conversations, next_conversation_id};
use ac_core::events::{append_event, attempt_outcome_name, event_now, last_attempt, read_events};
use ac_core::harness::{engine_env_set, spawn_env};
use ac_core::js;
use ac_core::outcome::validate_outcome;
use ac_core::pool::{
    AddBlocker, TicketMarker, add_blocker_to_ticket, is_finished, parse_enlist_id,
    write_marker_status,
};
use ac_core::prompt::{EnlistTeachingParts, build_enlist_teaching};
use ac_core::spawn_ledger::spawn_ledger_path;
use ac_io::git::{self, branch_for, checkout_new_branch, commit_sha_at, restore_found_branch};
use ac_io::herdr::Herdr;
use ac_protocol::{
    EnlistRequest, EnlistResponse, EnlistTicketRequest, EnlistedConversation, EnlistedTicket,
    Interrupt, InterruptKind, OutcomeStatus, TicketEventKind, TicketStatus,
};

use crate::actor::Engine;
use crate::attempt_ending::{
    EXIT_CODE_PANE_GONE, EXIT_CODE_UNREADABLE, exited_phrase, read_attempt_result,
};
use crate::checkout_gate::{DeferredMerge, through_pool_checkout_gate};
use crate::conversations::EnlistConversationRegistration;
use crate::enlist::{FoundPane, find_enlistable_pane};
use crate::enlisted::{EnlistedEnding, RegisterEnlisted, register_enlisted};
use crate::error::EngineError;
use crate::held::registered_panes_of;
use crate::interrupts::{interrupt, land_checkpoint_brief, raise_checkpoint, raise_interrupt};
use crate::live_attempts::LiveAttemptEntry;
use crate::merges::{
    handle_merge_conflict, merge_target_branch, merge_with_issue_aside, merged_payload,
};
use crate::session::{EnlistedWork, PoolUpdate, Session};
use crate::tickets::{CrashFacts, crash_interrupt_body};

fn refused(message: impl Into<String>) -> EngineError {
    EngineError::refused(message)
}

fn runs(session: &Session) -> &Path {
    Path::new(&session.runs_dir)
}

// ---------------------------------------------------------------------------
// Enlist
// ---------------------------------------------------------------------------

/// `nextEnlistId`: the next operator-enlisted id: `enlist-N`, N one past the highest already in the
/// pool. The namespace is reserved (pool.ts) and hand-written tickets may not use it. Derived from the
/// markers on every enlist, so a restart continues the same sequence.
pub fn next_enlist_id(markers: &[TicketMarker]) -> String {
    let max = markers
        .iter()
        .filter_map(|marker| parse_enlist_id(&marker.id))
        .max()
        .unwrap_or(0);
    format!("enlist-{}", max + 1)
}

struct EnlistTicketFile<'a> {
    title: &'a str,
    spec: &'a str,
    pane_id: &'a str,
    harness: &'a str,
    session_id: Option<&'a str>,
    directory: &'a str,
    branch: &'a str,
    created: bool,
}

/// `writeEnlistTicket`: the enlisted ticket file, written as a Spawn's is: a line-1 marker in progress
/// from the first moment (the attempt is already running), an empty blocked-by, the operator's title
/// and spec, and a provenance paragraph naming the pane, directory, branch and harness session it was
/// enlisted from. `enlisted-from` is the marker field the reserved `enlist-` namespace requires.
fn write_enlist_ticket(
    session: &Session,
    id: &str,
    fields: &EnlistTicketFile<'_>,
) -> anyhow::Result<()> {
    let session_note = match fields.session_id.filter(|id| !id.is_empty()) {
        Some(id) => format!(", session {id}"),
        None => String::new(),
    };
    let branch_note = if fields.created {
        format!(
            "The pool branch {} was created at that HEAD and checked out there, so uncommitted \
             changes came with it.",
            fields.branch
        )
    } else {
        "The branch was used as found; nothing in the checkout moved.".to_owned()
    };
    let body = format!(
        "<!-- state: id={id} blocked-by=none status=in-progress enlisted-from={} -->\n\n# {id}: {}\n\n\
         **Enlisted** (issue #101) from herdr pane {} (harness {}{session_note}) in {}, on branch {}. \
         {branch_note}\n\n{}\n",
        fields.pane_id,
        js::trim(fields.title),
        fields.pane_id,
        fields.harness,
        fields.directory,
        fields.branch,
        js::trim(fields.spec),
    );
    // A Seeded Pool (one that opts in via conversations/, per pool.ts) may boot with no issues/
    // directory on disk at all; Enlist-as-Ticket is how such a pool gets its first Ticket, so the
    // directory has to be made here rather than assumed.
    js::mkdir_all(&session.issues_dir)?;
    js::write_file(
        js::path_join(&[&session.issues_dir, &format!("{id}.md")]),
        &body,
    )?;
    Ok(())
}

struct BranchRule {
    branch: String,
    created: bool,
    /// Whether this enlist captured the pool's merge target (see below).
    captured: bool,
}

/// `applyEnlistBranchRule`: apply the branch rule (spec "Branch rule") to the pane an enlist picked, the
/// one piece both arms share. A checkout on the merge target gets a fresh `pool/<pool>/<id>` at HEAD,
/// checked out in place so uncommitted changes come along; any other branch is used as found.
fn apply_enlist_branch_rule(
    session: &mut Session,
    pane: &FoundPane,
    id: &str,
) -> Result<BranchRule, EngineError> {
    let pool_branch = branch_for(&session.cwd, id, None);
    // Against the merge target, not the live checkout: an earlier enlist may have moved the pool's own
    // checkout onto its created pool branch, and a pane on the target is still on the target.
    if pane.branch != merge_target_branch(session) {
        return Ok(BranchRule {
            branch: pane.branch.clone(),
            created: false,
            captured: false,
        });
    }
    let probe = checkout_new_branch(&pane.directory, &pool_branch);
    if !probe.ok {
        return Err(refused(format!(
            "enlist: could not create branch {pool_branch} in {} ({})",
            pane.directory,
            if probe.err.is_empty() {
                &probe.out
            } else {
                &probe.err
            }
        )));
    }
    // The checkout has moved onto a branch the engine created, so the branch it was on is the pool's
    // merge target from here on (ticket 04-spawn-1), and the checkout is the operator's for the rest of
    // the pool's life: the engine merges in its own merge checkout and gives every ticket a worktree.
    // Only a move in the pool's own checkout needs capturing: a linked worktree on the merge target
    // leaves `session.cwd` where it is. Compare top levels, not directories: a pane open in a
    // subdirectory moves the whole checkout too. Captured after the move, so a move that failed
    // captures nothing.
    let pane_top = git::git(&pane.directory, ["rev-parse", "--show-toplevel"]).out;
    let cwd_top = git::git(&session.cwd, ["rev-parse", "--show-toplevel"]).out;
    let captured = !pane_top.is_empty() && pane_top == cwd_top && session.merge_target.is_none();
    if captured {
        session.merge_target = Some(pane.branch.clone());
    }
    Ok(BranchRule {
        branch: pool_branch,
        created: true,
        captured,
    })
}

struct EnlistFacts {
    herdr: Herdr,
    pool_dir: String,
    registered: std::collections::HashSet<String>,
}

fn enlist_facts(session: &Session) -> EnlistFacts {
    EnlistFacts {
        herdr: Herdr::new(&session.herdr_socket),
        pool_dir: session.pool_dir.clone(),
        registered: registered_panes_of(session),
    }
}

async fn find_pane(facts: &EnlistFacts, pane_id: &str) -> Result<FoundPane, EngineError> {
    match find_enlistable_pane(
        &facts.herdr,
        Path::new(&facts.pool_dir),
        pane_id,
        &facts.registered,
    )
    .await
    {
        Ok(Ok(pane)) => Ok(pane),
        Ok(Err(reason)) => Err(refused(format!("enlist: {reason}"))),
        Err(error) => Err(refused(error.to_string())),
    }
}

fn spawned_payload(
    session: &Session,
    pane: &FoundPane,
    used_branch: &str,
    created: bool,
) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("argv".into(), Value::Array(Vec::new()));
    payload.insert("cwd".into(), Value::String(pane.directory.clone()));
    payload.insert("branch".into(), Value::String(used_branch.to_owned()));
    payload.insert(
        "commitSha".into(),
        commit_sha_at(&pane.directory).map_or(Value::Null, Value::String),
    );
    payload.insert(
        "env".into(),
        Value::Object(
            engine_env_set(
                &spawn_env(&session.parent_env, &pane.directory),
                &session.parent_env,
            )
            .into_iter()
            .map(|(key, value)| (key, Value::String(value)))
            .collect(),
        ),
    );
    payload.insert("pane_id".into(), Value::String(pane.pane_id.clone()));
    payload.insert(
        "tab_id".into(),
        pane.tab_id.clone().map_or(Value::Null, Value::String),
    );
    payload.insert("harness".into(), Value::String(pane.harness.to_lowercase()));
    payload.insert(
        "branch_rule".into(),
        Value::String(if created { "created" } else { "as-found" }.to_owned()),
    );
    payload.insert(
        "merge_target".into(),
        session
            .merge_target
            .clone()
            .map_or(Value::Null, Value::String),
    );
    payload
}

struct ConversationEnlist {
    title: String,
    steward: bool,
    opening: Option<String>,
}

/// `enlistConversation`: enlist a live herdr pane as a Conversation (issue #101): re-judge the picked
/// pane, apply the branch rule, then let the Conversation module claim the pane and register the
/// runtime the way `start` does after its launch, skipping the launch. The id is minted here (conv-N,
/// as a started Conversation) before the branch rule names the pool branch, and passed through.
/// Nothing is written before the claim; a claim that fails unwinds the branch the engine may have
/// created, so a failed enlist leaves no file and no branch.
async fn enlist_conversation(
    engine: &Engine,
    pane_id: String,
    title: Option<String>,
    opening: Option<String>,
    steward: bool,
) -> Result<EnlistResponse, EngineError> {
    let given = title.unwrap_or_default();
    let title = js::trim(&given).to_owned();
    let title = if title.is_empty() && steward {
        "Steward".to_owned()
    } else {
        title
    };
    let request = ConversationEnlist {
        title,
        steward,
        opening: opening.filter(|opening| !opening.is_empty()),
    };
    let steward_flag = request.steward;
    let facts = {
        let title = request.title.clone();
        engine
            .call(move |s| -> Result<EnlistFacts, EngineError> {
                if title.is_empty() {
                    return Err(refused("enlist: title is required"));
                }
                // One Steward at a time (ADR-0030), refused before the pane is touched; the
                // Conversation module checks again as it claims, against a race.
                if steward_flag && let Some(on_duty) = crate::conversations::steward_id(s) {
                    return Err(refused(format!(
                        "enlist: a Steward is already on duty ({on_duty}); end it before starting another"
                    )));
                }
                if !s.git {
                    return Err(refused(
                        "enlist: the pool has no git checkout, so it cannot give the Conversation a branch",
                    ));
                }
                if !crate::tickets::attempt_env_of(s, None).terminal_backed {
                    return Err(refused(
                        "enlist: the pool is not terminal-backed (set console.json \"terminal\": \"herdr\")",
                    ));
                }
                Ok(enlist_facts(s))
            })
            .await??
    };
    let pane = find_pane(&facts, &pane_id).await?;

    // The Conversation id is minted before the branch rule, because the branch it creates is named for
    // it (as the Ticket arm's is for the enlist id).
    let (id, rule) = {
        let pane = pane.clone();
        engine
            .call(move |s| -> Result<(String, BranchRule), EngineError> {
                let existing = load_conversations(&Path::new(&s.pool_dir).join("conversations"))
                    .map_err(|error| refused(error.to_string()))?;
                let reserved = crate::conversations::reserved_ids(s);
                let id = next_conversation_id(&existing, |id| reserved.iter().any(|r| r == id));
                let rule = apply_enlist_branch_rule(s, &pane, &id)?;
                Ok((id, rule))
            })
            .await??
    };

    let claimed = crate::conversations::enlist(
        engine,
        EnlistConversationRegistration {
            id: id.clone(),
            pane_id: pane.pane_id.clone(),
            tab_id: pane.tab_id.clone(),
            harness: pane.harness.clone(),
            title: request.title.clone(),
            opening: request.opening.clone(),
            directory: pane.directory.clone(),
            branch: rule.branch.clone(),
            session_id: pane.session_id.clone(),
            steward: request.steward,
        },
    )
    .await;
    if let Err(reason) = claimed {
        let (directory, found, used) = (
            pane.directory.clone(),
            pane.branch.clone(),
            rule.branch.clone(),
        );
        let (created, captured) = (rule.created, rule.captured);
        engine
            .call(move |s| {
                if created {
                    restore_found_branch(&directory, &found, &used);
                }
                if captured {
                    s.merge_target = None;
                }
            })
            .await?;
        return Err(refused(format!("enlist: {reason}")));
    }

    // The lifecycle trail, in the same shape a terminal-backed Ticket's events file has: the
    // pre-existing pane id, the found branch and which branch rule applied. Written after the claim, so
    // a failure above leaves none.
    let conversation_id = id.clone();
    engine
        .call(move |s| -> Result<(), EngineError> {
            let id = conversation_id;
            append_event(
                runs(s),
                &id,
                &event_now(1, TicketEventKind::Scheduled, Map::new()),
            )
            .map_err(|error| refused(error.to_string()))?;
            let payload = spawned_payload(s, &pane, &rule.branch, rule.created);
            append_event(
                runs(s),
                &id,
                &event_now(1, TicketEventKind::Spawned, payload),
            )
            .map_err(|error| refused(error.to_string()))?;
            let role = if request.steward {
                " (the Steward)"
            } else {
                ""
            };
            s.log(if rule.created {
                format!(
                    "conversation {id}{role}: enlisted from pane {}; branch {} created at HEAD and \
                     checked out in {}",
                    pane.pane_id, rule.branch, pane.directory
                )
            } else {
                format!(
                    "conversation {id}{role}: enlisted from pane {}; branch {} used as found in {}",
                    pane.pane_id, pane.branch, pane.directory
                )
            });
            // The module published before the log line was written: emit once more so the stream
            // carries it now rather than at the next unrelated tick.
            let phase = s.idle_phase();
            crate::snapshot::emit_snapshot(s, phase);
            Ok(())
        })
        .await??;
    Ok(EnlistResponse::Conversation(EnlistedConversation {
        conversation_id: id,
    }))
}

struct UnwindState {
    restored_files: Vec<(std::path::PathBuf, String)>,
    restored_blockers: Vec<(String, Vec<String>)>,
    branch_created: bool,
    captured_target: bool,
    directory: String,
    found_branch: String,
    pool_branch: String,
    pane_id: String,
    harness: String,
}

/// `unwindEnlist`: undo a failed enlist (spec "Failed enlist leaves nothing"): stop the runtime, drop
/// the ticket file and its events, restore every edited marker byte for byte, remove the marker from
/// the session, release the pane's agent identity, and remove the branch the enlist created. Every step
/// is best-effort so one failure cannot block the rest of the unwind. The found branch and directory
/// are never touched.
fn unwind_enlist(session: &mut Session, id: &str, state: UnwindState) {
    session.enlisted.release(id);
    crate::live_attempts::clear(session, id, 1);
    session.markers.retain(|marker| marker.id != id);
    session.state.tickets.shift_remove(id);
    session.assignments.shift_remove(id);
    session.enlisted_work.remove(id);
    // A failed enlist that had moved the pool checkout moves it back below, so the live branch read is
    // right again and the captured target must go with it, or every later merge would run against a
    // stale target.
    if state.captured_target {
        session.merge_target = None;
    }
    let _ = std::fs::remove_file(js::path_join(&[&session.issues_dir, &format!("{id}.md")]));
    let _ = std::fs::remove_file(js::path_join(&[
        &session.runs_dir,
        &format!("{id}.events.jsonl"),
    ]));
    for (file, original) in &state.restored_files {
        let _ = js::write_file(file, original);
    }
    for (restored_id, blocked_by) in state.restored_blockers {
        if let Some(marker) = session.marker_mut(&restored_id) {
            marker.blocked_by = blocked_by;
        }
    }
    // The identity the enlist reported goes with the failed attempt, the way it goes at every other
    // ending (issue #94): best-effort, silent.
    let herdr = Herdr::new(&session.herdr_socket);
    let (pane, harness) = (state.pane_id.clone(), state.harness.to_lowercase());
    tokio::spawn(async move {
        let _ = herdr.release_pane_agent(&pane, &harness).await;
    });
    if state.branch_created {
        restore_found_branch(&state.directory, &state.found_branch, &state.pool_branch);
    }
}

/// `enlistTicket`: enlist a live herdr pane as a Ticket (issue #101), the one-shot orchestration behind
/// `POST /api/enlist`: re-judge the picked pane against herdr, apply the branch rule, register the
/// runtime and claim the pane, then write the pool (the ticket file, the "Blocks" edits, the events,
/// the marker, the Live attempt). Every failure before the runtime is claimed throws before anything is
/// written; a claim that fails unwinds the checkout it may have branched, and a write that fails after
/// the claim unwinds everything (file, edits, branch, registration, agent identity), so a failed enlist
/// leaves nothing behind.
pub async fn enlist_ticket(
    engine: &Engine,
    request: EnlistTicketRequest,
) -> Result<EnlistResponse, EngineError> {
    let title = js::trim(&request.title).to_owned();
    if title.is_empty() {
        return Err(refused("enlist: title is required"));
    }
    let facts = engine
        .call(|s| -> Result<EnlistFacts, EngineError> {
            if !s.git {
                return Err(refused(
                    "enlist: the pool has no git checkout, so it cannot give the ticket a branch",
                ));
            }
            if !crate::tickets::attempt_env_of(s, None).terminal_backed {
                return Err(refused(
                    "enlist: the pool is not terminal-backed (set console.json \"terminal\": \"herdr\")",
                ));
            }
            Ok(enlist_facts(s))
        })
        .await??;
    let pane = find_pane(&facts, &request.pane_id).await?;

    // Every ticked ticket is validated before any write, so a bad "Blocks" entry fails the whole
    // enlist rather than leaving half the edits applied.
    let mut blocks: Vec<String> = Vec::new();
    for id in request.blocks.clone().unwrap_or_default() {
        if !blocks.contains(&id) {
            blocks.push(id);
        }
    }
    let prepared = {
        let (pane, blocks) = (pane.clone(), blocks.clone());
        engine
            .call(move |s| -> Result<(String, BranchRule, String, String, String), EngineError> {
                for blocker in &blocks {
                    let Some(target) = s.marker(blocker) else {
                        return Err(refused(format!("enlist: ticket {blocker} is not in the pool")));
                    };
                    if is_finished(Some(target.status)) {
                        return Err(refused(format!(
                            "enlist: ticket {blocker} is {}; a {} ticket cannot wait on anything",
                            target.status, target.status
                        )));
                    }
                }
                let id = next_enlist_id(&s.markers);
                let rule = apply_enlist_branch_rule(s, &pane, &id)?;
                let issue_path = js::path_join(&[&s.issues_dir, &format!("{id}.md")]);
                let outcome_path =
                    js::path_join(&[&s.runs_dir, &attempt_outcome_name(&id, None, false)]);
                let ledger = js::path_text(&spawn_ledger_path(runs(s)));
                let teaching = build_enlist_teaching(&EnlistTeachingParts {
                    id: &id,
                    issue_path: &issue_path,
                    outcome_path: &outcome_path,
                    branch: &rule.branch,
                    ledger_path: &ledger,
                });
                Ok((id, rule, issue_path, outcome_path, teaching))
            })
            .await??
    };
    let (id, rule, issue_path, outcome_path, teaching) = prepared;

    // The claim: report the agent identity, relabel the operator's tab and type the teaching Turn
    // (queued when the pane is working). A teaching Turn that cannot be delivered is the one claim
    // failure that unwinds.
    let registration = register_enlisted(
        engine,
        RegisterEnlisted {
            id: id.clone(),
            pane_id: pane.pane_id.clone(),
            tab_id: pane.tab_id.clone(),
            harness: pane.harness.clone(),
            title: title.clone(),
            branch: rule.branch.clone(),
            directory: pane.directory.clone(),
            outcome_path,
            teaching: Some(teaching),
        },
    )
    .await;
    if let Err(reason) = registration {
        let (directory, found, used) = (
            pane.directory.clone(),
            pane.branch.clone(),
            rule.branch.clone(),
        );
        let (created, captured) = (rule.created, rule.captured);
        engine
            .call(move |s| {
                if created {
                    restore_found_branch(&directory, &found, &used);
                }
                if captured {
                    s.merge_target = None;
                }
            })
            .await?;
        return Err(refused(format!("enlist: {reason}")));
    }

    // From here the runtime is live; every failure unwinds it completely.
    let ticket_id = id.clone();
    engine
        .call(move |s| -> Result<(), EngineError> {
            let mut restored_files: Vec<(std::path::PathBuf, String)> = Vec::new();
            let mut restored_blockers: Vec<(String, Vec<String>)> = Vec::new();
            let written = write_enlisted_ticket(
                s,
                &ticket_id,
                &title,
                &request.spec,
                &issue_path,
                &pane,
                &rule,
                &blocks,
                &mut restored_files,
                &mut restored_blockers,
            );
            match written {
                Ok(()) => Ok(()),
                Err(error) => {
                    unwind_enlist(
                        s,
                        &ticket_id,
                        UnwindState {
                            restored_files,
                            restored_blockers,
                            branch_created: rule.created,
                            captured_target: rule.captured,
                            directory: pane.directory.clone(),
                            found_branch: pane.branch.clone(),
                            pool_branch: rule.branch.clone(),
                            pane_id: pane.pane_id.clone(),
                            harness: pane.harness.clone(),
                        },
                    );
                    Err(error)
                }
            }
        })
        .await??;
    Ok(EnlistResponse::Ticket(EnlistedTicket { ticket_id: id }))
}

// The writes of an enlist after the claim; the caller unwinds when one fails.
#[allow(clippy::too_many_arguments)]
fn write_enlisted_ticket(
    s: &mut Session,
    id: &str,
    title: &str,
    spec: &str,
    issue_path: &str,
    pane: &FoundPane,
    rule: &BranchRule,
    blocks: &[String],
    restored_files: &mut Vec<(std::path::PathBuf, String)>,
    restored_blockers: &mut Vec<(String, Vec<String>)>,
) -> Result<(), EngineError> {
    let io = |error: &dyn std::fmt::Display| refused(error.to_string());
    write_enlist_ticket(
        s,
        id,
        &EnlistTicketFile {
            title,
            spec,
            pane_id: &pane.pane_id,
            harness: &pane.harness,
            session_id: pane.session_id.as_deref(),
            directory: &pane.directory,
            branch: &rule.branch,
            created: rule.created,
        },
    )
    .map_err(|e| io(&e))?;
    append_event(
        runs(s),
        id,
        &event_now(1, TicketEventKind::Scheduled, Map::new()),
    )
    .map_err(|e| io(&e))?;
    let payload = spawned_payload(s, pane, &rule.branch, rule.created);
    append_event(
        runs(s),
        id,
        &event_now(1, TicketEventKind::Spawned, payload),
    )
    .map_err(|e| io(&e))?;

    for blocker in blocks {
        let target = s
            .marker(blocker)
            .cloned()
            .expect("every ticked ticket was validated before the claim");
        restored_files.push((
            target.file.clone(),
            js::read_text(&target.file).map_err(|e| io(&e))?,
        ));
        restored_blockers.push((target.id.clone(), target.blocked_by.clone()));
        match add_blocker_to_ticket(Path::new(&s.pool_dir), blocker, id).map_err(|e| io(&e))? {
            AddBlocker::Added { .. } => {}
            AddBlocker::Refused(reason) => {
                return Err(refused(format!(
                    "enlist: could not add {id} to {blocker}'s blocked-by ({reason})"
                )));
            }
        }
        // Keep the in-memory marker in step with the file: the next super-step boundary's ready set
        // reads it, and the ticked ticket must be gated.
        if let Some(marker) = s.marker_mut(blocker)
            && !marker.blocked_by.iter().any(|b| b == id)
        {
            marker.blocked_by.push(id.to_owned());
        }
    }

    s.markers.push(TicketMarker {
        id: id.to_owned(),
        file: std::path::PathBuf::from(issue_path),
        blocked_by: Vec::new(),
        status: TicketStatus::InProgress,
        title: title.to_owned(),
        spec: js::trim(spec).to_owned(),
        spawned_by: None,
        enlisted_from: Some(pane.pane_id.clone()),
        spawn_assign: None,
    });
    let tickets: IndexMap<String, TicketStatus> =
        [(id.to_owned(), TicketStatus::InProgress)].into();
    s.apply(PoolUpdate {
        tickets: Some(tickets),
        log: Some(vec![if rule.created {
            format!(
                "ticket {id}: enlisted from pane {}; branch {} created at HEAD and checked out in {}",
                pane.pane_id, rule.branch, pane.directory
            )
        } else {
            format!(
                "ticket {id}: enlisted from pane {}; branch {} used as found in {}",
                pane.pane_id, pane.branch, pane.directory
            )
        }]),
        ..PoolUpdate::default()
    });
    // The Assignment as found: the harness herdr named, model and drivers unknown (the card reads "as
    // found" where the model would be). Recorded now so a config reload never reassigns an attempt
    // already in flight.
    s.assignments.insert(
        id.to_owned(),
        Assignment {
            harness: pane.harness.to_lowercase(),
            model: String::new(),
            effort: None,
            drivers: DEFAULT_DRIVERS.to_owned(),
            verify: None,
        },
    );
    // The found work, for the merge hold and the merge paths: an enlisted ticket has no
    // `pool/<pool>/<id>` branch, so they read this instead.
    s.enlisted_work.insert(
        id.to_owned(),
        EnlistedWork {
            branch: rule.branch.clone(),
            directory: pane.directory.clone(),
        },
    );
    // Verify is ignored for an enlisted Ticket (spec "Verify is ignored"): there is nothing to run N of,
    // because the one attempt is already in flight. Logged once here, at enlist.
    if let Some(configured) = assign_request(&s.state.config, id)
        .verify
        .filter(|verify| !verify.is_null())
    {
        let shown = match &configured {
            Value::String(text) => text.clone(),
            Value::Number(number) => number
                .as_f64()
                .map_or_else(|| number.to_string(), js::number_string),
            other => other.to_string(),
        };
        s.log(format!(
            "ticket {id}: verify: {shown} ignored; an enlisted ticket runs ungraded"
        ));
    }
    // Registration is the allowlist peek and focus read (spec): the moment this lands, the card's pane
    // resolves and a snapshot goes out.
    crate::live_attempts::register(
        s,
        id,
        LiveAttemptEntry::new(1, Some(pane.pane_id.clone()), pane.tab_id.clone()),
    );
    Ok(())
}

impl Engine {
    /// `enlist` (issue #101): a live herdr pane as a Ticket, a Conversation or the Steward. The
    /// `becomes` the operator fixed at enlist time chooses the arm; a Steward is a Conversation in a
    /// role (ADR-0030).
    pub async fn enlist(&self, request: EnlistRequest) -> Result<EnlistResponse, EngineError> {
        match request {
            EnlistRequest::Ticket(request) => enlist_ticket(self, request).await,
            EnlistRequest::Conversation(request) => {
                enlist_conversation(
                    self,
                    request.pane_id,
                    Some(request.title),
                    request.opening,
                    false,
                )
                .await
            }
            EnlistRequest::Steward(request) => {
                enlist_conversation(self, request.pane_id, request.title, request.opening, true)
                    .await
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The enlisted attempt's ending (issue #101, ticket 04)
// ---------------------------------------------------------------------------

/// `reRunAssignment`: the Assignment a ticket that stopped being an enlisted attempt runs on: the
/// ordinary pool assignment for its id, with verify stripped (an enlisted id never fans out,
/// `planSuperStep` says so too). Used where a pane-gone checkpoint hands the ticket back to the
/// ordinary engine-launched path.
fn re_run_assignment(session: &Session, marker: &TicketMarker) -> anyhow::Result<Assignment> {
    let mut resolved =
        resolve_ticket_assignment(marker, &session.state.config, &session.harnesses)?;
    resolved.verify = None;
    Ok(resolved)
}

/// `createdBranchNote`: the re-run of a created-branch enlist (spec story 11) needs the branch free: a
/// Brief that offers the re-run says so up front.
fn created_branch_note(session: &Session, ticket_id: &str, branch: &str) -> String {
    match session.enlisted_work.get(ticket_id) {
        Some(work)
            if work.branch == branch && branch == branch_for(&session.cwd, ticket_id, None) =>
        {
            format!(
                " The enlist created {branch} in that checkout, and a re-run needs the branch free: \
                 check another branch out there first, or the re-run waits as a checkpoint until you \
                 do."
            )
        }
        _ => String::new(),
    }
}

/// `paneGoneBrief`: the Brief a pane that went before its Outcome leaves behind: what happened and the
/// promise the engine keeps, that the found branch is still there. The operator answers and the ticket
/// re-runs as an ordinary engine-launched attempt, which is exactly what the generic answer path does.
fn pane_gone_brief(session: &Session, ticket_id: &str, branch: &str) -> String {
    format!(
        "The herdr pane this enlisted attempt was running in went away before the agent wrote an \
         Outcome, so the attempt is over and the engine did not re-run it blind. The found branch \
         {branch} and the checkout it lives in were left exactly where they were. Answer resume to \
         re-run this ticket as an ordinary engine-launched attempt, or leave it parked and finish \
         the work by hand.{}",
        created_branch_note(session, ticket_id, branch)
    )
}

/// `enlistedAttemptEnded`: whether an exit was already recorded for this attempt, so a second
/// observation of the ending (a race between the runtime's watch and a moved pane, or a boot reconcile
/// after a live ending) records nothing twice.
fn enlisted_attempt_ended(session: &Session, ticket_id: &str, attempt: u64) -> bool {
    read_events(runs(session), ticket_id).iter().any(|event| {
        event.attempt == attempt
            && matches!(event.kind, TicketEventKind::Exited | TicketEventKind::Crash)
    })
}

/// `finishAdoptedFinalize`: the last step of an ending, after its merge chain has settled: emit the new
/// state, persist it, and kick a drive pass when the run had already settled, so the closing gate, the
/// ready set, and any queued answers see the attempt's real ending. The kick is a no-op while a drive
/// is in flight; its boundary machinery picks the state up instead.
pub fn finish_adopted_finalize(session: &mut Session) {
    let phase = if session.driving {
        ac_protocol::RunPhase::Running
    } else {
        ac_protocol::RunPhase::Quiescent
    };
    crate::snapshot::emit_snapshot(session, phase);
    // The next boundary persist (or the persistence interrupt machinery) owns store failures; the
    // finalize's record must not die on one.
    let _ = crate::persist::persist(session);
    let _ = crate::answers::kick_processing(session);
}

/// `endEnlistedAttempt`: record an enlisted attempt's ending (issue #101, ticket 04). The two
/// observations the runtime races (an Outcome on disk, the pane found gone) both land here; boot
/// re-adoption lands here too. There is no wrapper, so no exit code and no Stream file: the log gets
/// the lifecycle events only.
///
/// A valid Outcome writes its own status, raising the ordinary checkpoint or chaining the ordinary
/// merge. A pane that went first is a checkpoint whose Brief names the branch it kept, never a crash,
/// and never a re-run: the operator decides. The engine never closes the tab and never removes the
/// found directory or branch.
pub fn end_enlisted_attempt(
    session: &mut Session,
    ticket_id: &str,
    ending: EnlistedEnding,
    attempt_hint: Option<u64>,
) -> anyhow::Result<()> {
    let Some(mut marker) = session.marker(ticket_id).cloned() else {
        return Ok(());
    };
    if is_finished(Some(marker.status)) {
        return Ok(());
    }
    // A re-adopted pane's ending arrives through its runtime: the adoption is over with it, so a later
    // answer to a stale interrupt abandons nothing.
    session.adopted.remove(ticket_id);
    let live = session
        .live_attempts
        .records(|_| false)
        .shift_remove(ticket_id);
    let attempt = attempt_hint
        .or_else(|| live.as_ref().map(|live| live.attempt))
        .unwrap_or_else(|| last_attempt(runs(session), ticket_id));
    if enlisted_attempt_ended(session, ticket_id, attempt) {
        crate::live_attempts::clear(session, ticket_id, attempt);
        return Ok(());
    }
    let outcome_path = js::path_join(&[
        &session.runs_dir,
        &attempt_outcome_name(ticket_id, None, false),
    ]);
    let outcome = read_attempt_result(&outcome_path, validate_outcome);
    let work = session.enlisted_work.get(ticket_id).cloned();
    let branch = work
        .map(|work| work.branch)
        .unwrap_or_else(|| branch_for(&session.cwd, ticket_id, None));
    let pane_id = live.and_then(|live| live.pane_id);

    crate::live_attempts::clear(session, ticket_id, attempt);
    // The agent identity goes at the ending, the way it goes at every other ending (issue #94); the tab
    // stays, because it was the operator's before it was the pool's. Best-effort, silent.
    let harness = session
        .assignments
        .get(ticket_id)
        .map(|assignment| assignment.harness.clone())
        .filter(|harness| !harness.is_empty());
    if let (Some(pane), Some(harness)) = (pane_id, harness) {
        let herdr = Herdr::new(&session.herdr_socket);
        tokio::spawn(async move {
            let _ = herdr
                .release_pane_agent(&pane, &harness.to_lowercase())
                .await;
        });
    }

    let mut status = TicketStatus::InProgress;
    let mut code: i64 = 0;
    let mut crash_reason: Option<String> = None;
    let mut brief: Option<String> = None;
    match ending {
        EnlistedEnding::Outcome => match &outcome {
            Ok(valid) => {
                status = match valid.outcome.status {
                    OutcomeStatus::Done => TicketStatus::Done,
                    OutcomeStatus::Checkpoint => TicketStatus::Checkpoint,
                };
                brief = valid.outcome.brief.clone();
            }
            Err(reason) => {
                // The file was there but the validator refused it: a genuine crash, the same ending
                // an ordinary attempt's unreadable Outcome gets.
                crash_reason = Some(reason.clone());
                code = EXIT_CODE_UNREADABLE;
            }
        },
        EnlistedEnding::PaneGone => {
            status = TicketStatus::Checkpoint;
            code = EXIT_CODE_PANE_GONE;
            brief = Some(pane_gone_brief(session, ticket_id, &branch));
            // The pane went before an Outcome, so the next Attempt is an ordinary engine-launched one
            // (the spec's answer path). It needs a real Assignment and the pool's own branch naming,
            // so the as-found record is dropped here: the found branch and directory are still kept,
            // they are simply no longer the ticket's working branch.
            session.enlisted_work.remove(ticket_id);
            let assignment = re_run_assignment(session, &marker)?;
            session.assignments.insert(ticket_id.to_owned(), assignment);
        }
    }
    let outcome_exists = js::exists(&outcome_path);
    let mut exited = Map::new();
    exited.insert("code".into(), Value::from(code));
    exited.insert("status".into(), Value::String(status.to_string()));
    exited.insert("logTail".into(), Value::Array(Vec::new()));
    exited.insert("outcomeExists".into(), Value::Bool(outcome_exists));
    append_event(
        runs(session),
        ticket_id,
        &event_now(attempt, TicketEventKind::Exited, exited),
    )?;
    let cleared: Vec<Interrupt> = session
        .state
        .interrupts
        .iter()
        .filter(|i| i.ticket_id != ticket_id)
        .cloned()
        .collect();
    if let Some(reason) = crash_reason {
        let mut crash = Map::new();
        crash.insert("code".into(), Value::from(code));
        crash.insert("reason".into(), Value::String(reason.clone()));
        crash.insert("logTail".into(), Value::Array(Vec::new()));
        crash.insert("outcomeExists".into(), Value::Bool(outcome_exists));
        append_event(
            runs(session),
            ticket_id,
            &event_now(attempt, TicketEventKind::Crash, crash),
        )?;
        session.apply(PoolUpdate {
            interrupts: Some(cleared),
            log: Some(vec![format!(
                "ticket {ticket_id}: enlisted attempt {attempt} {}, crash: {reason}",
                exited_phrase(code)
            )]),
            ..PoolUpdate::default()
        });
        raise_interrupt(
            session,
            interrupt(
                ticket_id,
                InterruptKind::Crash,
                crash_interrupt_body(&CrashFacts {
                    crash_reason: &reason,
                    log_path: "",
                    log_tail: &[],
                    outcome_path: &outcome_path,
                    outcome_exists,
                }),
            ),
        );
        finish_adopted_finalize(session);
        return Ok(());
    }

    write_marker_status(&marker.file, status)?;
    marker.status = status;
    if let Some(live_marker) = session.marker_mut(ticket_id) {
        live_marker.status = status;
    }
    if status == TicketStatus::Checkpoint {
        land_checkpoint_brief(&marker.file, brief.as_deref())?;
    }
    session.apply(PoolUpdate {
        tickets: Some([(ticket_id.to_owned(), status)].into()),
        interrupts: Some(cleared),
        log: Some(vec![format!(
            "ticket {ticket_id}: enlisted attempt {attempt} {}, marker {status}",
            exited_phrase(code)
        )]),
        outcomes: outcome
            .as_ref()
            .ok()
            .map(|valid| [(ticket_id.to_owned(), valid.outcome.clone())].into()),
        ..PoolUpdate::default()
    });
    if status == TicketStatus::Checkpoint {
        raise_checkpoint(session, &marker, attempt, None)?;
    }
    if status == TicketStatus::Done {
        if let Ok(valid) = &outcome
            && let Some(spawn) = valid
                .outcome
                .spawn
                .as_ref()
                .filter(|spawn| !spawn.is_empty())
        {
            crate::spawns::take_spawn_proposals(
                session,
                ticket_id,
                spawn.clone(),
                ac_protocol::SpawnKind::Ticket,
            )?;
        }
        chain_enlisted_merge(session, marker, attempt, branch);
        return Ok(());
    }
    finish_adopted_finalize(session);
    Ok(())
}

/// `chainEnlistedMerge`: merge a done enlisted ticket's found branch, chained onto the session merge
/// chain so its git work never runs concurrently with the drive's merges (ADR-0014's adopted-finalize
/// reasoning). On success the found directory and branch are left alone, unlike an ordinary ticket's
/// merge; on a conflict the existing merge-conflict machinery takes over in the found checkout.
fn chain_enlisted_merge(session: &mut Session, marker: TicketMarker, attempt: u64, branch: String) {
    session.merge_line.taken(&marker.id);
    // The found branch is merged in place; a merge a shutdown drops at the pool checkout's gate names
    // the found directory, for the next boot.
    let deferred = DeferredMerge {
        ticket_id: marker.id.clone(),
        path: session
            .enlisted_work
            .get(&marker.id)
            .map_or_else(|| session.cwd.clone(), |work| work.directory.clone()),
        branch: branch.clone(),
        attempt,
    };
    let engine = session.engine();
    let previous = session.merge_chain.clone();
    let link = {
        use futures::FutureExt;
        async move {
            previous.await;
            let merge_marker = marker.clone();
            let merge_branch = branch.clone();
            let merged = through_pool_checkout_gate(&engine, Some(deferred), move |s| {
                let merge = merge_with_issue_aside(s, &merge_marker, &merge_branch)?;
                if merge.ok {
                    s.merge_line.settled(&merge_marker.id);
                    append_event(
                        runs(s),
                        &merge_marker.id,
                        &event_now(attempt, TicketEventKind::Merged, merged_payload(&merge)),
                    )?;
                    s.log(format!(
                        "ticket {}: enlisted attempt {attempt} merged {merge_branch} onto the working branch",
                        merge_marker.id
                    ));
                    return Ok(None);
                }
                Ok(Some(merge))
            })
            .await;
            if let Ok(Some(Some(conflict))) = merged {
                let _ = handle_merge_conflict(&engine, marker, conflict, attempt).await;
            }
            let _ = engine.call(finish_adopted_finalize).await;
        }
        .boxed()
        .shared()
    };
    session.merge_chain = link.clone();
    tokio::spawn(link);
}

/// `recordEnlistedTrailingExit`: the pane left herdr's listing after the Outcome had already ended the
/// attempt (spec, user story 28): a trailing exit. Tidying the tab after a finished ticket changes
/// nothing about the ticket, it is only recorded on the pool log so the run's account is complete.
pub fn record_enlisted_trailing_exit(session: &mut Session, ticket_id: &str) {
    let Some(marker) = session.marker(ticket_id) else {
        return;
    };
    if marker.status == TicketStatus::InProgress {
        return;
    }
    session.log(format!(
        "ticket {ticket_id}: herdr pane left after its outcome (trailing exit); the ticket is unchanged"
    ));
    let phase = session.current_phase();
    crate::snapshot::emit_snapshot(session, phase);
}
