use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock};

use futures::FutureExt;
use regex::Regex;
use serde_json::{Map, Value};

use ac_core::assignment::engine_ticket_build_id;
use ac_core::events::{
    append_event, attempt_log_name, attempt_outcome_name, event_now, last_attempt, next_attempt,
    read_events, ticket_seed_name,
};
use ac_core::js;
use ac_core::line::run::TicketId;
use ac_core::machine_defaults::read_machine_defaults;
use ac_core::merge_hold::MergeHoldProbe;
use ac_core::plan::{Assign, Conflict};
use ac_core::pool::{TicketMarker, write_marker_status};
use ac_core::prompt::{ResolverPromptParts, build_resolver_prompt};
use ac_io::git::{self, MergeFailure, MergeResult, WorktreeInfo};
use ac_protocol::{Interrupt, InterruptKind, TicketEvent, TicketEventKind, TicketStatus};

use crate::actor::Engine;
use crate::attempt_run::{
    AttemptEvents, AttemptNaming, AttemptSpec, CrashSubject, Fallback, PromptDelivery, Rotate,
    run_attempt,
};
use crate::checkout_gate::{hold_pool_checkout, release_pool_checkout};
use crate::interrupts::{interrupt, raise_interrupt, without};
use crate::session::{EnlistedWork, PoolState, PoolUpdate, Session};
use crate::snapshot::emit_snapshot;
use crate::tickets::{attempt_env_of, close_attempt_tab, close_attempt_tabs};

// ---------------------------------------------------------------------------------------------------
// The unlanded list and the Merge queue (ADR-0014)
// ---------------------------------------------------------------------------------------------------

/// The engine's git probe (merge-hold.ts `gitMergeHoldProbe`, with engine.ts's overrides): the
/// captured merge target outranks the live checkout read, an enlisted ticket's branch is the one it
/// was found on, and the memo's stamp names the captured target and covers its refs.
pub struct EngineHoldProbe<'a> {
    pub cwd: &'a str,
    pub target: Option<&'a str>,
    pub enlisted: &'a HashMap<String, EnlistedWork>,
}

impl MergeHoldProbe for EngineHoldProbe<'_> {
    fn current_branch(&self) -> String {
        match self.target {
            Some(target) => target.to_owned(),
            None => git::current_branch(self.cwd),
        }
    }

    fn branch_for(&self, ticket_id: &str) -> String {
        match self.enlisted.get(ticket_id) {
            Some(work) => work.branch.clone(),
            None => git::branch_for(self.cwd, ticket_id, None),
        }
    }

    fn branch_exists(&self, branch: &str) -> bool {
        git::ref_exists(self.cwd, branch)
    }

    fn is_ancestor(&self, branch: &str, target: &str) -> bool {
        git::is_ancestor(self.cwd, branch, target)
    }

    fn stamp(&self, branches: &[String]) -> Option<String> {
        let mut refs: Vec<&str> = branches.iter().map(String::as_str).collect();
        if let Some(target) = self.target {
            refs.push(target);
        }
        let stamp = git::ref_stamp(self.cwd, refs)?;
        Some(format!("{}\n{stamp}", self.target.unwrap_or("")))
    }
}

pub fn merge_hold(session: &mut Session) -> Vec<String> {
    if !session.git {
        return Vec::new();
    }
    let Session {
        derive_hold,
        state,
        enlisted_work,
        cwd,
        merge_target,
        ..
    } = session;
    let probe = EngineHoldProbe {
        cwd,
        target: merge_target.as_deref(),
        enlisted: enlisted_work,
    };
    let tickets = crate::session::js_key_order(&state.tickets);
    derive_hold.derive(
        tickets,
        &|id| engine_ticket_build_id(id).is_some(),
        Some(&probe),
    )
}

// ---------------------------------------------------------------------------------------------------
// The merge target and its checkout
// ---------------------------------------------------------------------------------------------------

fn git_attempt(attempt: Option<u64>) -> Option<u32> {
    attempt.map(|n| u32::try_from(n).unwrap_or(u32::MAX))
}

/// `ticketWorktree`: the checkout a ticket's branch lives in: the pool worktree for an ordinary
/// ticket, the found directory for an enlisted one (issue #101).
pub fn ticket_worktree(
    session: &Session,
    marker: &TicketMarker,
    attempt: Option<u64>,
) -> WorktreeInfo {
    if let Some(work) = session.enlisted_work.get(&marker.id) {
        return WorktreeInfo {
            path: work.directory.clone(),
            branch: work.branch.clone(),
        };
    }
    WorktreeInfo {
        path: git::worktree_path_for(&session.cwd, &marker.id, git_attempt(attempt)),
        branch: git::branch_for(&session.cwd, &marker.id, git_attempt(attempt)),
    }
}

/// `mergeTargetRef`: the branch this pool merges into, as a ref.
pub fn merge_target_ref(session: &Session) -> String {
    session
        .merge_target
        .clone()
        .unwrap_or_else(|| "HEAD".to_owned())
}

/// `mergeTargetBranch`: the same, as a branch name.
pub fn merge_target_branch(session: &Session) -> String {
    session
        .merge_target
        .clone()
        .unwrap_or_else(|| git::current_branch(&session.cwd))
}

pub fn merge_target_sha(session: &Session) -> String {
    if session.git {
        git::rev_parse(&session.cwd, &merge_target_ref(session))
    } else {
        String::new()
    }
}

pub struct TipMerge {
    pub result: MergeResult,
    pub before_sha: String,
}

impl TipMerge {
    pub fn range(&self, session: &Session) -> Option<String> {
        (!self.before_sha.is_empty())
            .then(|| format!("{}..{}", self.before_sha, merge_target_ref(session)))
    }
}

fn blocked(detail: String) -> MergeResult {
    MergeResult {
        ok: false,
        reason: Some(MergeFailure::Blocked),
        conflicted: Vec::new(),
        blocked: Vec::new(),
        cleared: Vec::new(),
        detail,
    }
}

fn file_text(marker: &TicketMarker) -> String {
    js::path_text(&marker.file)
}

/// `mergeWithIssueAside`: merge a branch with the Ticket file stepped aside, then reconcile the pool's
/// copy with the branch's against the seed (issue #92). A merge checkout that cannot be opened is a
/// blocked merge the operator can clear and resume.
pub fn merge_with_issue_aside(
    session: &mut Session,
    marker: &TicketMarker,
    branch: &str,
) -> anyhow::Result<TipMerge> {
    let before_sha = merge_target_sha(session);
    let ours = js::read_text(&marker.file)?;
    let file = file_text(marker);
    // The base for the reconcile's fallback, taken before the merge lands: once the branch is merged,
    // the merge base is the branch's own tip and its edits to the Ticket file would read as no change.
    let merge_base = git::merge_base(&session.cwd, &merge_target_ref(session), branch);
    let pool_checkout = session.cwd.clone();
    let merged = git::with_merge_checkout(&session.cwd, session.merge_target.as_deref(), |cwd| {
        if cwd == pool_checkout {
            git::merge_in_place(&pool_checkout, &file, branch)
        } else {
            git::merge_in_checkout(&pool_checkout, cwd, &file, branch)
        }
    });
    let merged = match merged {
        Ok(merged) => merged,
        Err(err) => {
            return Ok(TipMerge {
                result: blocked(err.to_string()),
                before_sha,
            });
        }
    };
    let (result, theirs) = (merged.result, merged.theirs);
    let Some(theirs) = theirs.filter(|_| result.ok) else {
        return Ok(TipMerge { result, before_sha });
    };
    let (content, conflicted) = reconcile_ticket_file(
        session,
        marker,
        branch,
        merge_base.as_deref(),
        &ours,
        &theirs,
    )?;
    js::write_through_rename(&marker.file, marker.file.with_extension("md.tmp"), &content)?;
    if conflicted {
        record_ticket_file_conflict(session, marker, branch)?;
    }
    Ok(TipMerge { result, before_sha })
}

/// The two copies of a ticket file changed the same lines: the conflict markers stay in the file of
/// record, and the ticket log and pool log say so.
pub fn record_ticket_file_conflict(
    session: &mut Session,
    marker: &TicketMarker,
    branch: &str,
) -> anyhow::Result<()> {
    let rel = js::path_relative(&session.cwd, &file_text(marker));
    let mut payload = Map::new();
    payload.insert("file".into(), Value::String(rel.clone()));
    payload.insert("branch".into(), Value::String(branch.to_owned()));
    let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
    append_event(
        Path::new(&session.runs_dir),
        &marker.id,
        &event_now(attempt, TicketEventKind::TicketFileConflict, payload),
    )?;
    session.log(format!(
        "{}: the pool's ticket file and the branch's copy changed the same lines; conflict markers \
         left in {rel}",
        marker.id
    ));
    Ok(())
}

// Splits a ticket file at its marker line: the state line the engine owns, and everything after it.
fn split_marker_line(content: &str) -> (&str, &str) {
    match content.find('\n') {
        Some(nl) => (&content[..nl], &content[nl + 1..]),
        None => (content, ""),
    }
}

static ATTEMPT_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.attempt-(\d+)$").expect("the attempt suffix pattern compiles"));

/// The seed a branch's worktree was planned from: its attempt's seed file under runs/.
pub fn seed_path_for(session: &Session, ticket_id: &str, branch: &str) -> String {
    let attempt = ATTEMPT_SUFFIX
        .captures(branch)
        .map(|caps| js::number_from_text(&caps[1]) as u64);
    js::path_join(&[&session.runs_dir, &ticket_seed_name(ticket_id, attempt)])
}

// `ticketSeedFor`: the base for the reconcile: the seed planTicket kept, or the file as committed at
// the merge base taken before the merge landed, or the pool copy itself.
fn ticket_seed_for(
    session: &Session,
    marker: &TicketMarker,
    branch: &str,
    merge_base: Option<&str>,
    ours: &str,
) -> anyhow::Result<String> {
    let seed = seed_path_for(session, &marker.id, branch);
    if Path::new(&seed).exists() {
        return Ok(js::read_text(&seed)?);
    }
    if let Some(base) = merge_base {
        let rel = js::path_relative(&session.cwd, &file_text(marker));
        if let Some(shown) = git::show_file(&session.cwd, &format!("{base}:{rel}")) {
            return Ok(shown);
        }
    }
    Ok(ours.to_owned())
}

/// `reconcileTicketFile`: the three-way body merge through `git merge-file` (its exit status the
/// conflict count; above 127 git's own error, read as a whole-file conflict). Line 1 always comes from
/// the pool copy. `merge_base` is the branch's merge base with the working branch, taken before any
/// merge of it landed; it stands in as the base when no seed was kept. The reconciled text, and
/// whether it holds conflict markers.
pub fn reconcile_ticket_file(
    session: &Session,
    marker: &TicketMarker,
    branch: &str,
    merge_base: Option<&str>,
    ours: &str,
    theirs: &str,
) -> anyhow::Result<(String, bool)> {
    if ours == theirs {
        return Ok((ours.to_owned(), false));
    }
    let seed = ticket_seed_for(session, marker, branch, merge_base, ours)?;
    let (line1, mine) = split_marker_line(ours);
    let (_, base) = split_marker_line(&seed);
    let (_, other) = split_marker_line(theirs);
    if mine == other {
        return Ok((format!("{line1}\n{mine}"), false));
    }
    let scratch = js::path_join(&[&session.runs_dir, &format!("{}.reconcile", marker.id)]);
    js::mkdir_all(&scratch)?;
    let paths = [
        js::path_join(&[&scratch, "pool"]),
        js::path_join(&[&scratch, "seed"]),
        js::path_join(&[&scratch, "branch"]),
    ];
    js::write_file(&paths[0], mine)?;
    js::write_file(&paths[1], base)?;
    js::write_file(&paths[2], other)?;
    let branch_label = format!("branch {branch}");
    let merged = git::merge_file(
        ["pool (file of record)", "seed", &branch_label],
        [
            Path::new(&paths[0]),
            Path::new(&paths[1]),
            Path::new(&paths[2]),
        ],
    );
    let _ = std::fs::remove_dir_all(&scratch);
    match merged.code {
        Some(code) if !(0..=127).contains(&code) => Ok((
            format!(
                "{line1}\n<<<<<<< pool (file of record)\n{mine}=======\n{other}>>>>>>> branch {branch}\n"
            ),
            true,
        )),
        code => Ok((
            format!("{line1}\n{}", merged.stdout_text()),
            code.is_some_and(|code| code > 0),
        )),
    }
}

// ---------------------------------------------------------------------------------------------------
// mergeTicket and the failed-merge records
// ---------------------------------------------------------------------------------------------------

/// `mergeTicket`: merge one finished ticket's branch onto the pool's working branch, and remove its
/// worktree once it landed.
pub fn merge_ticket(
    session: &mut Session,
    marker: &TicketMarker,
    worktree: &WorktreeInfo,
) -> anyhow::Result<TipMerge> {
    let merge = merge_with_issue_aside(session, marker, &worktree.branch)?;
    if merge.result.ok {
        remove_merge_worktree(session, marker, worktree);
    }
    Ok(merge)
}

/// `removeMergeWorktree`: never for an enlisted ticket (issue #101), whose checkout and branch are the
/// operator's.
pub fn remove_merge_worktree(session: &Session, marker: &TicketMarker, worktree: &WorktreeInfo) {
    if marker.enlisted_from.is_some() || session.enlisted_work.contains_key(&marker.id) {
        return;
    }
    git::remove_worktree(&session.cwd, worktree);
}

pub async fn in_merge_chain<T: Send + 'static>(
    engine: &Engine,
    job: impl FnOnce(&mut Session) -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    let (done, result) = tokio::sync::oneshot::channel();
    let link_engine = engine.clone();
    engine
        .call(move |s| {
            chain_link(s, async move {
                let _ = done.send(link_engine.call(job).await);
            });
        })
        .await?;
    result
        .await
        .map_err(|_| anyhow::anyhow!("the merge chain dropped a link"))??
}

pub fn chain_ticket_merge(
    session: &mut Session,
    marker: TicketMarker,
    worktree: WorktreeInfo,
    attempt: u64,
    what: Option<&str>,
) {
    session.merge_line.taken(&marker.id);
    let engine = session.engine();
    let what = what.map(str::to_owned);
    chain_link(session, async move {
        let merged = merge_link(&engine, marker, worktree, attempt, what).await;
        let _ = engine
            .call(move |s| {
                if let Err(error) = merged {
                    s.drive_failure.get_or_insert(error.to_string());
                }
                crate::restart::finish_adopted_finalize(s);
            })
            .await;
    });
}

pub fn chain_link(
    session: &mut Session,
    work: impl std::future::Future<Output = ()> + Send + 'static,
) {
    let previous = session.merge_chain.clone();
    let engine = session.engine();
    let link = async move {
        previous.await;
        work.await;
        crate::persist::persist_after_flow(&engine).await;
    }
    .boxed()
    .shared();
    session.merge_chain = link.clone();
    tokio::spawn(link);
}

async fn merge_link(
    engine: &Engine,
    marker: TicketMarker,
    worktree: WorktreeInfo,
    attempt: u64,
    what: Option<String>,
) -> anyhow::Result<()> {
    let (merge_marker, merge_worktree) = (marker.clone(), worktree);
    let conflict = engine
        .call(move |s| {
            let (marker, worktree) = (merge_marker, merge_worktree);
            let merge = merge_ticket(s, &marker, &worktree)?;
            if !merge.result.ok {
                return Ok(Some(merge.result));
            }
            let id = &marker.id;
            s.merge_line.settled(id);
            append_event(
                Path::new(&s.runs_dir),
                id,
                &event_now(
                    attempt,
                    TicketEventKind::Merged,
                    merged_payload(&merge.result),
                ),
            )?;
            close_attempt_tab(s, id, attempt);
            let range = merge.range(s);
            crate::conversations::ticket_ended(s, &marker, &worktree.branch, range);
            let branch = &worktree.branch;
            s.log(match &what {
                Some(what) => {
                    format!("ticket {id}: {what} {attempt} merged {branch} onto the working branch")
                }
                None => format!(
                    "ticket {id}: merged {branch} onto the working branch{}",
                    landed_detail(&merge.result)
                ),
            });
            anyhow::Ok(None)
        })
        .await??;
    if let Some(conflict) = conflict {
        handle_merge_conflict(engine, marker, conflict, attempt).await?;
    }
    Ok(())
}

/// `recordFailedMerge`: merge-blocked names the files in the way of a merge git refused to start (#92),
/// merge-conflict the unmerged paths of one it started.
pub fn record_failed_merge(
    session: &Session,
    ticket_id: &str,
    attempt: u64,
    result: &MergeResult,
) -> anyhow::Result<()> {
    let is_blocked = result.reason == Some(MergeFailure::Blocked);
    let mut payload = Map::new();
    payload.insert(
        "files".into(),
        Value::from(if is_blocked {
            result.blocked.clone()
        } else {
            result.conflicted.clone()
        }),
    );
    let kind = if is_blocked {
        TicketEventKind::MergeBlocked
    } else {
        TicketEventKind::MergeConflict
    };
    append_event(
        Path::new(&session.runs_dir),
        ticket_id,
        &event_now(attempt, kind, payload),
    )?;
    Ok(())
}

/// How many other Tickets have started since a Ticket's merge-conflict Interrupt was raised: the
/// distinct ones with a `scheduled` event after the Ticket's latest `merge-conflict` or
/// `merge-blocked` event. That event is written when the conflict is found, before a resolver runs,
/// so a Ticket that starts while the resolver works counts. A failed Resume appends a fresh one, so
/// the baseline moves with the re-raised Interrupt. `None` while none has, or when the Ticket has no
/// such event.
fn started_since_conflict(
    conflicted: &[Arc<TicketEvent>],
    others: impl Iterator<Item = Vec<Arc<TicketEvent>>>,
) -> Option<u64> {
    let baseline = conflicted
        .iter()
        .rfind(|e| {
            matches!(
                e.kind,
                TicketEventKind::MergeConflict | TicketEventKind::MergeBlocked
            )
        })?
        .at
        .as_str();
    let started = others
        .filter(|events| {
            events
                .iter()
                .any(|e| e.kind == TicketEventKind::Scheduled && e.at.as_str() > baseline)
        })
        .count() as u64;
    (started > 0).then_some(started)
}

/// The state a snapshot carries, with each Ticket merge-conflict Interrupt's copy saying how many
/// other Tickets started since it was raised (ADR-0040). Derived from the Tickets' events at each
/// build, never persisted, so it survives a restart; nothing is read while no such Interrupt waits.
/// Engine-run Tickets (graders and judges) are in the markers but were never started by the
/// scheduler, and Conversations are not in the markers, so neither counts.
pub fn with_started_since(session: &Session, state: &mut PoolState) {
    let runs = Path::new(&session.runs_dir);
    for interrupt in &mut state.interrupts {
        if interrupt.kind != InterruptKind::MergeConflict
            || !session.markers.iter().any(|m| m.id == interrupt.ticket_id)
        {
            continue;
        }
        let own = read_events(runs, &interrupt.ticket_id);
        let others = session
            .markers
            .iter()
            .filter(|m| m.id != interrupt.ticket_id && engine_ticket_build_id(&m.id).is_none())
            .map(|m| read_events(runs, &m.id));
        interrupt.started_since = started_since_conflict(&own, others);
    }
}

/// `mergedPayload`: the untracked pool copies the merge deleted because they matched the branch's
/// version byte for byte (#92), when any.
pub fn merged_payload(result: &MergeResult) -> Map<String, Value> {
    let mut payload = Map::new();
    if !result.cleared.is_empty() {
        payload.insert("cleared".into(), Value::from(result.cleared.clone()));
    }
    payload
}

/// `mergeConflictInterrupt`: the interrupt for a merge that did not land, a conflict git started and
/// the engine aborted, or a merge git refused before starting.
pub fn merge_conflict_interrupt(
    session: &Session,
    marker: &TicketMarker,
    result: &MergeResult,
) -> Interrupt {
    let worktree = ticket_worktree(session, marker, None);
    let branch = &worktree.branch;
    let parked = format!(
        "the ticket's work is parked on branch {branch}, checked out at {}.\n{}",
        worktree.path,
        if result.detail.is_empty() {
            String::new()
        } else {
            format!("git said: {}\n", result.detail)
        }
    );
    if result.reason == Some(MergeFailure::Blocked) {
        return interrupt(
            &marker.id,
            InterruptKind::MergeConflict,
            format!(
                "merging {branch} onto the working branch was blocked: {}{parked}",
                git::blocked_merge_explanation(&session.cwd, result)
            ),
        );
    }
    let files = if result.conflicted.is_empty() {
        "(no unmerged paths listed)".to_owned()
    } else {
        result.conflicted.join(", ")
    };
    interrupt(
        &marker.id,
        InterruptKind::MergeConflict,
        format!(
            "merging {branch} onto the working branch failed; the merge was aborted and the working \
             branch was left clean.\nconflicted files: {files}\n{parked}resolve the conflict and \
             resume this ticket; the merge is re-attempted on resume."
        ),
    )
}

/// `manualMergeInterrupt`: the resolver path's merge-conflict, with what the resolver tried noted.
pub fn manual_merge_interrupt(
    session: &Session,
    marker: &TicketMarker,
    result: &MergeResult,
    attempt_note: &str,
) -> Interrupt {
    let mut base = merge_conflict_interrupt(session, marker, result);
    if result.reason != Some(MergeFailure::Blocked) {
        base.body = format!(
            "{}\nThe resolver agent attempted: {attempt_note}",
            base.body
        );
    }
    base
}

fn landed_detail(result: &MergeResult) -> String {
    if result.detail.ends_with("is gone") {
        format!(" ({})", result.detail)
    } else {
        String::new()
    }
}

fn append_resume_note(marker: &TicketMarker, note: Option<&str>) -> anyhow::Result<()> {
    let note = js::trim(note.unwrap_or(""));
    if !note.is_empty() {
        js::append_file(&marker.file, &format!("\n## Resume note\n\n{note}\n"))?;
    }
    Ok(())
}

// The merge landed after an answer: the worktree goes, the merged event lands, the tabs close and the
// Conversation hears of it.
fn record_answer_merge(
    session: &mut Session,
    marker: &TicketMarker,
    worktree: &WorktreeInfo,
    merge: &TipMerge,
) -> anyhow::Result<()> {
    remove_merge_worktree(session, marker, worktree);
    let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
    append_event(
        Path::new(&session.runs_dir),
        &marker.id,
        &event_now(
            attempt,
            TicketEventKind::Merged,
            merged_payload(&merge.result),
        ),
    )?;
    if !session.enlisted_work.contains_key(&marker.id) {
        close_attempt_tabs(session, &marker.id);
    }
    let range = merge.range(session);
    crate::conversations::ticket_ended(session, marker, &worktree.branch, range);
    Ok(())
}

/// `resumeMerge`: resuming a merge-conflict interrupt re-attempts the merge. A fresh conflict refreshes
/// the interrupt; the ticket itself stays done.
pub fn resume_merge(
    session: &mut Session,
    marker: &TicketMarker,
    pending: &Interrupt,
    note: Option<&str>,
) -> anyhow::Result<()> {
    let worktree = ticket_worktree(session, marker, None);
    let branch = worktree.branch.clone();
    let merge = merge_with_issue_aside(session, marker, &branch)?;
    let result = &merge.result;
    append_resume_note(marker, note)?;
    if !result.ok {
        let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
        record_failed_merge(session, &marker.id, attempt, result)?;
        let mut interrupts = without(&session.state.interrupts, pending);
        interrupts.push(merge_conflict_interrupt(session, marker, result));
        session.apply(PoolUpdate {
            interrupts: Some(interrupts),
            log: Some(vec![format!(
                "merge re-attempt for {} {}",
                marker.id,
                if result.reason == Some(MergeFailure::Blocked) {
                    "is still blocked"
                } else {
                    "still conflicts"
                }
            )]),
            ..PoolUpdate::default()
        });
        return Ok(());
    }
    record_answer_merge(session, marker, &worktree, &merge)?;
    let interrupts = without(&session.state.interrupts, pending);
    session.apply(PoolUpdate {
        interrupts: Some(interrupts),
        log: Some(vec![format!(
            "interrupt answered for {} (merge-conflict): merge landed{}",
            marker.id,
            landed_detail(result)
        )]),
        ..PoolUpdate::default()
    });
    Ok(())
}

/// `approveMerge`: commit the resolver's staged resolution, then merge; the pool continues.
pub fn approve_merge(
    session: &mut Session,
    marker: &TicketMarker,
    pending: &Interrupt,
    note: Option<&str>,
) -> anyhow::Result<()> {
    let worktree = ticket_worktree(session, marker, None);
    git::commit_merge(&worktree);
    append_resume_note(marker, note)?;
    let merge = merge_with_issue_aside(session, marker, &worktree.branch)?;
    let result = &merge.result;
    if !result.ok {
        let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
        record_failed_merge(session, &marker.id, attempt, result)?;
        let mut interrupts = without(&session.state.interrupts, pending);
        interrupts.push(manual_merge_interrupt(
            session,
            marker,
            result,
            "the resolver's resolution did not merge cleanly on approval",
        ));
        session.apply(PoolUpdate {
            interrupts: Some(interrupts),
            log: Some(vec![format!(
                "merge after resolver approval for {} {}",
                marker.id,
                if result.reason == Some(MergeFailure::Blocked) {
                    "is blocked"
                } else {
                    "still conflicts"
                }
            )]),
            ..PoolUpdate::default()
        });
        return Ok(());
    }
    record_answer_merge(session, marker, &worktree, &merge)?;
    let interrupts = without(&session.state.interrupts, pending);
    session.apply(PoolUpdate {
        interrupts: Some(interrupts),
        log: Some(vec![format!(
            "interrupt answered for {} (merge-approval): resolver resolution committed",
            marker.id
        )]),
        ..PoolUpdate::default()
    });
    Ok(())
}

/// `rejectMerge`: the staged resolution is discarded and the ticket reopens (ADR-0014), which lifts
/// the unlanded list.
pub fn reject_merge(
    session: &mut Session,
    marker: &TicketMarker,
    pending: &Interrupt,
    note: Option<&str>,
) -> anyhow::Result<()> {
    let worktree = ticket_worktree(session, marker, None);
    git::merge_abort(&worktree.path);
    append_resume_note(marker, note)?;
    write_marker_status(&marker.file, TicketStatus::Ready)?;
    if let Some(m) = session.marker_mut(&marker.id) {
        m.status = TicketStatus::Ready;
    }
    let interrupts = without(&session.state.interrupts, pending);
    session.apply(PoolUpdate {
        tickets: Some([(marker.id.clone(), TicketStatus::Ready)].into_iter().collect()),
        interrupts: Some(interrupts),
        log: Some(vec![format!(
            "merge-approval rejected for {}: staged resolution discarded, ticket reopened for a re-run",
            marker.id
        )]),
        ..PoolUpdate::default()
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------------------
// The merge resolver
// ---------------------------------------------------------------------------------------------------

/// The driver name the resolver runs under: a command stub that exists on every harness.
pub const RESOLVER_DRIVER: &str = "resolving-merge-conflicts";

/// The resolver agent's harness, model and effort.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolverSpec {
    pub harness: String,
    pub model: String,
    pub effort: Option<String>,
}

fn text_field(value: Option<&Value>, key: &str) -> Option<String> {
    value
        .and_then(|v| v.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|t| !t.is_empty())
}

/// `resolveResolver`: console.json's resolver (a harness name, "none", or `{ harness, model, effort }`)
/// over the pool defaults and the Machine defaults, with a Merger's own non-empty fields ahead of all
/// of them. `None` takes the manual path; an explicit resolver naming an unknown harness fails.
fn resolve_resolver(session: &Session, merger: &Assign) -> anyhow::Result<Option<ResolverSpec>> {
    let config = &session.state.config;
    let (harness, model, effort) = match config.resolver() {
        Some(Value::Object(_)) => {
            let spec = config.resolver();
            (
                text_field(spec, "harness"),
                text_field(spec, "model"),
                text_field(spec, "effort"),
            )
        }
        Some(Value::String(name)) => (Some(name.clone()), None, None),
        _ => (None, None, None),
    };
    let ahead = |own: &Option<String>, config: Option<String>| {
        own.clone().filter(|t| !js::trim(t).is_empty()).or(config)
    };
    let (harness, model, effort) = (
        ahead(&merger.harness, harness),
        ahead(&merger.model, model),
        ahead(&merger.effort, effort),
    );
    let explicit = harness.as_deref().map(|h| js::trim(h).to_owned());
    if matches!(explicit.as_deref(), Some("" | "none")) {
        return Ok(None);
    }
    let defaults = config.get("defaults");
    let mut harness = explicit.clone();
    let mut model = non_empty(model.map(|m| js::trim(&m).to_owned()))
        .or_else(|| non_empty(text_field(defaults, "model")));
    let mut effort = non_empty(effort.map(|e| js::trim(&e).to_owned()))
        .or_else(|| non_empty(text_field(defaults, "effort").map(|e| js::trim(&e).to_owned())));
    if harness.is_none() || model.is_none() || effort.is_none() {
        let machine = read_machine_defaults(&session.machine_defaults);
        harness = harness.or(non_empty(machine.harness));
        model = model.or(non_empty(machine.model));
        effort = effort.or(non_empty(machine.effort));
    }
    let (Some(harness), Some(model)) = (harness, model) else {
        return Ok(None);
    };
    if !session.harnesses.contains(&harness) {
        if let Some(explicit) = explicit {
            anyhow::bail!(
                "pool config: resolver names unknown harness '{explicit}'. Known: {}",
                session.harnesses.known()
            );
        }
        return Ok(None);
    }
    Ok(Some(ResolverSpec {
        harness,
        model,
        effort,
    }))
}

/// What a conflicting merge does for one Ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictPolicy {
    /// The Merger says wait: the operator's merge-conflict Interrupt, no resolver.
    Wait,
    Resolve(ResolverSpec),
    /// No resolver is configured, so the manual path.
    NoResolver,
}

/// The conflict policy for `ticket`, read from the frozen Plan at conflict time so it holds across a
/// restart: its node's Merger when it has one, else the pool's own resolver.
pub fn conflict_policy(session: &Session, ticket: &str) -> anyhow::Result<ConflictPolicy> {
    let merger = session.line.as_ref().and_then(|line| {
        let node = line.node_of(&TicketId::new(ticket))?;
        line.plan().0.conflict_for(node)
    });
    let own = Assign::default();
    let assign = match merger {
        Some(Conflict::Wait) => return Ok(ConflictPolicy::Wait),
        Some(Conflict::Resolver(assign)) => assign,
        None => &own,
    };
    Ok(match resolve_resolver(session, assign)? {
        Some(resolver) => ConflictPolicy::Resolve(resolver),
        None => ConflictPolicy::NoResolver,
    })
}

/// The resolver's result: whether it staged a resolution, and its note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    pub resolved: bool,
    pub note: Option<String>,
}

/// `validateResolution`: a `resolved` boolean and an optional note.
pub fn validate_resolution(parsed: &Value) -> Result<Resolution, String> {
    let Some(resolved) = parsed.get("resolved").and_then(Value::as_bool) else {
        return Err("resolver outcome has no resolved boolean".into());
    };
    Ok(Resolution {
        resolved,
        note: parsed
            .get("note")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// `approvalInterrupt`: the resolver resolved the conflict; the operator approves or rejects.
pub fn approval_interrupt(
    session: &Session,
    marker: &TicketMarker,
    result: &MergeResult,
    attempt_note: &str,
) -> Interrupt {
    let files = if result.conflicted.is_empty() {
        "(none listed)".to_owned()
    } else {
        result.conflicted.join(", ")
    };
    interrupt(
        &marker.id,
        InterruptKind::MergeApproval,
        format!(
            "The resolver agent resolved the merge conflict for ticket {}.\nIt attempted: \
             {attempt_note}\nconflicted files: {files}\nthe resolution is staged on branch {}; \
             approve to commit it and continue, or reject to resolve by hand.",
            marker.id,
            ticket_worktree(session, marker, None).branch
        ),
    )
}

/// `handleMergeConflict`: a conflict goes to the resolver, whose result becomes an approval
/// interrupt; a failed or absent resolver takes the manual path. However the handling ends, the
/// engine is finished with this merge.
pub async fn handle_merge_conflict(
    engine: &Engine,
    marker: TicketMarker,
    result: MergeResult,
    attempt: u64,
) -> anyhow::Result<()> {
    let id = marker.id.clone();
    let routed = route_merge_conflict(engine, marker, result, attempt).await;
    engine.call(move |s| s.merge_line.settled(&id)).await?;
    routed
}

enum Route {
    Done,
    Resolve(WorktreeInfo, ResolverSpec),
}

async fn route_merge_conflict(
    engine: &Engine,
    marker: TicketMarker,
    result: MergeResult,
    attempt: u64,
) -> anyhow::Result<()> {
    let route = {
        let marker = marker.clone();
        let result = result.clone();
        engine
            .call(move |s| -> anyhow::Result<Route> {
                record_failed_merge(s, &marker.id, attempt, &result)?;
                // A blocked merge never started (#92): there is nothing for a resolver to reproduce.
                if result.reason == Some(MergeFailure::Blocked) {
                    let conflict = merge_conflict_interrupt(s, &marker, &result);
                    raise_interrupt(s, conflict);
                    return Ok(Route::Done);
                }
                let worktree = ticket_worktree(s, &marker, None);
                let resolver = match conflict_policy(s, &marker.id)? {
                    ConflictPolicy::Wait => {
                        let conflict = merge_conflict_interrupt(s, &marker, &result);
                        raise_interrupt(s, conflict);
                        return Ok(Route::Done);
                    }
                    ConflictPolicy::NoResolver => {
                        let manual = manual_merge_interrupt(
                            s,
                            &marker,
                            &result,
                            "no resolver harness available (set console.json resolver= or a \
                             ~/.issue-runner default)",
                        );
                        raise_interrupt(s, manual);
                        return Ok(Route::Done);
                    }
                    ConflictPolicy::Resolve(resolver) => resolver,
                };
                // The head of the Merge queue is resolving from here, before the resolver is live.
                s.merge_line.resolving(&marker.id);
                let phase = s.idle_phase();
                emit_snapshot(s, phase);
                Ok(Route::Resolve(worktree, resolver))
            })
            .await??
    };
    let Route::Resolve(worktree, resolver) = route else {
        return Ok(());
    };
    let resolution = run_resolver(engine, &marker, &worktree, &resolver, &result).await?;
    engine
        .call(move |s| {
            if resolution.resolved {
                let approval = approval_interrupt(s, &marker, &result, &resolution.note);
                raise_interrupt(s, approval);
            } else {
                // Discard whatever the resolver left in the worktree before the manual path.
                git::merge_abort(&worktree.path);
                let manual = manual_merge_interrupt(s, &marker, &result, &resolution.note);
                raise_interrupt(s, manual);
            }
        })
        .await?;
    Ok(())
}

/// A resolver run's verdict and the note for the operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolverAttempt {
    pub resolved: bool,
    pub note: String,
}

async fn run_resolver(
    engine: &Engine,
    marker: &TicketMarker,
    worktree: &WorktreeInfo,
    resolver: &ResolverSpec,
    result: &MergeResult,
) -> anyhow::Result<ResolverAttempt> {
    // A resolver works a merge that lands in the pool checkout: a writer there until it is done.
    let what = format!("a resolver is resolving {}'s merge", marker.id);
    let hold = engine.call(move |s| hold_pool_checkout(s, what)).await?;
    let run = run_resolver_attempt(engine, marker, worktree, resolver, result).await;
    engine.call(move |s| release_pool_checkout(s, hold)).await?;
    run
}

async fn run_resolver_attempt(
    engine: &Engine,
    marker: &TicketMarker,
    worktree: &WorktreeInfo,
    resolver: &ResolverSpec,
    result: &MergeResult,
) -> anyhow::Result<ResolverAttempt> {
    let (marker_c, worktree_c, files) =
        (marker.clone(), worktree.clone(), result.conflicted.clone());
    let (attempt, prompt, env) = engine
        .call(move |s| -> anyhow::Result<_> {
            let runs = Path::new(&s.runs_dir).to_path_buf();
            let attempt = next_attempt(&runs, &marker_c.id);
            ac_core::streamlog::rotate_attempt_log(
                &runs,
                &marker_c.id,
                &runs.join(attempt_log_name(&marker_c.id, None, true)),
                TicketEventKind::Resolver,
            )?;
            let outcome_path =
                js::path_join(&[&s.runs_dir, &attempt_outcome_name(&marker_c.id, None, true)]);
            let mut payload = Map::new();
            payload.insert("files".into(), Value::from(files.clone()));
            payload.insert("cwd".into(), Value::String(worktree_c.path.clone()));
            payload.insert("branch".into(), Value::String(worktree_c.branch.clone()));
            append_event(
                &runs,
                &marker_c.id,
                &event_now(attempt, TicketEventKind::Resolver, payload),
            )?;
            let working_branch = merge_target_branch(s);
            let prompt = build_resolver_prompt(&ResolverPromptParts {
                id: &marker_c.id,
                worktree: &worktree_c.path,
                branch: &worktree_c.branch,
                working_branch: &working_branch,
                files: &files,
                outcome_path: &outcome_path,
            });
            Ok((attempt, prompt, attempt_env_of(s, None)))
        })
        .await??;
    let run = run_attempt(
        &env,
        AttemptSpec {
            id: marker.id.clone(),
            issue_path: file_text(marker),
            title: marker.title.clone(),
            body: prompt,
            driver: RESOLVER_DRIVER.to_owned(),
            harness: resolver.harness.clone(),
            model: resolver.model.clone(),
            effort: resolver.effort.clone(),
            cwd: worktree.path.clone(),
            branch: Some(worktree.branch.clone()),
            attempt,
            naming: AttemptNaming {
                attempt: None,
                resolver: true,
            },
            rotate: Rotate::None,
            fallback: Fallback::Headless,
            prompt: PromptDelivery::Driver,
            crash_subject: CrashSubject::Resolver,
            events: AttemptEvents::SpawnedOnly,
        },
        validate_resolution,
    )
    .await?;
    let note_or = |note: &Option<String>, fallback: &str| match note.as_deref() {
        Some(note) if !note.is_empty() => note.to_owned(),
        _ => fallback.to_owned(),
    };
    if run.ok()
        && let Ok(resolution) = &run.result
        && resolution.resolved
    {
        return Ok(ResolverAttempt {
            resolved: true,
            note: note_or(&resolution.note, "(resolver gave no note)"),
        });
    }
    let note = match (&run.crash_reason, run.code != 0, &run.result) {
        (Some(reason), true, _) => reason.clone(),
        (_, _, Ok(resolution)) => note_or(&resolution.note, "resolver reported no resolution"),
        _ => "resolver produced no resolution".to_owned(),
    };
    Ok(ResolverAttempt {
        resolved: false,
        note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_resolution_needs_a_resolved_boolean() {
        assert_eq!(
            validate_resolution(&serde_json::json!({"resolved": "yes"})).unwrap_err(),
            "resolver outcome has no resolved boolean"
        );
        assert_eq!(
            validate_resolution(&serde_json::json!({"resolved": true, "note": 3})).unwrap(),
            Resolution {
                resolved: true,
                note: None
            }
        );
    }

    fn event_at(at: &str, kind: TicketEventKind) -> Arc<TicketEvent> {
        Arc::new(TicketEvent {
            at: at.to_owned(),
            attempt: 1,
            kind,
            payload: Map::new(),
        })
    }

    #[test]
    fn counts_each_other_ticket_that_started_after_the_latest_conflict_once() {
        let conflicted = vec![
            event_at("2026-10-18T10:00:00.000Z", TicketEventKind::MergeConflict),
            event_at("2026-10-18T10:05:00.000Z", TicketEventKind::MergeBlocked),
        ];
        let verify_round = vec![
            event_at("2026-10-18T10:06:00.000Z", TicketEventKind::Scheduled),
            event_at("2026-10-18T10:06:00.000Z", TicketEventKind::Scheduled),
        ];
        let before_the_conflict = vec![event_at(
            "2026-10-18T10:04:00.000Z",
            TicketEventKind::Scheduled,
        )];
        let never_started = vec![event_at(
            "2026-10-18T10:07:00.000Z",
            TicketEventKind::Merged,
        )];
        let others = vec![verify_round, before_the_conflict, never_started];
        assert_eq!(
            started_since_conflict(&conflicted, others.into_iter()),
            Some(1)
        );
    }

    #[test]
    fn a_start_while_the_resolver_works_counts_from_the_conflict_not_the_resolver() {
        let conflicted = vec![
            event_at("2026-10-18T10:00:00.000Z", TicketEventKind::MergeConflict),
            event_at("2026-10-18T10:00:01.000Z", TicketEventKind::Resolver),
            event_at("2026-10-18T10:00:02.000Z", TicketEventKind::Spawned),
        ];
        let during_the_resolver = vec![event_at(
            "2026-10-18T10:00:03.000Z",
            TicketEventKind::Scheduled,
        )];
        assert_eq!(
            started_since_conflict(&conflicted, vec![during_the_resolver].into_iter()),
            Some(1)
        );
    }

    #[test]
    fn a_conflict_nobody_started_after_has_no_count() {
        let conflicted = vec![event_at(
            "2026-10-18T10:00:00.000Z",
            TicketEventKind::MergeConflict,
        )];
        let earlier = vec![event_at(
            "2026-10-18T09:00:00.000Z",
            TicketEventKind::Scheduled,
        )];
        assert_eq!(
            started_since_conflict(&conflicted, vec![earlier].into_iter()),
            None
        );
        assert_eq!(started_since_conflict(&[], std::iter::empty()), None);
    }

    // A pool whose Line has opened `build` with two Items, so `build-1.1` and `build-1.2` are the
    // Line's Tickets, under the given Merger conflict setting.
    fn pool_with_line(conflict: Option<Value>, resolver: Value) -> Session {
        use ac_core::line::run::{LineBrief, LinePlaces, LineRun, LineStart};
        let (publisher, _) = tokio::sync::watch::channel(None);
        let mut session = crate::testkit::bare_session(publisher);
        session.state.config = ac_core::config::PoolConfig::from_map(
            serde_json::json!({
                "resolver": resolver,
                "defaults": {"harness": "claude", "model": "sonnet"}
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let mut nodes = vec![
            serde_json::json!({"kind": "agent", "id": "build", "title": "Build", "x": 0, "y": 0,
                "copies": {"perItem": 2}}),
            serde_json::json!({"kind": "agent", "id": "plain", "title": "Plain", "x": 0, "y": 0}),
            serde_json::json!({"kind": "finish", "id": "finish", "title": "Finish", "x": 0, "y": 0}),
        ];
        let mut edges = vec![serde_json::json!({"from": "plain", "on": "done", "to": "finish"})];
        match conflict {
            Some(conflict) => {
                nodes.push(
                    serde_json::json!({"kind": "merger", "id": "build-merge", "title": "M",
                    "x": 0, "y": 0, "of": "build", "conflict": conflict}),
                );
                edges.push(serde_json::json!({"from": "build", "on": "done", "to": "build-merge"}));
                edges
                    .push(serde_json::json!({"from": "build-merge", "on": "done", "to": "finish"}));
            }
            None => edges.push(serde_json::json!({"from": "build", "on": "done", "to": "finish"})),
        }
        let plan = ac_core::plan::Plan::from_value(
            &serde_json::json!({"horde": 1, "name": "p", "nodes": nodes, "edges": edges}),
        )
        .unwrap();
        let brief = LineBrief::parse(
            r#"{"items": [{"title": "a", "body": "A"}, {"title": "b", "body": "B"}]}"#,
        )
        .unwrap();
        session.line =
            Some(LineRun::start(plan, LinePlaces::default(), LineStart::Brief(brief)).unwrap());
        session
    }

    fn resolver(harness: &str, model: &str, effort: Option<&str>) -> ConflictPolicy {
        ConflictPolicy::Resolve(ResolverSpec {
            harness: harness.to_owned(),
            model: model.to_owned(),
            effort: effort.map(str::to_owned),
        })
    }

    #[test]
    fn a_merger_set_to_wait_holds_its_copies_for_the_operator() {
        let session = pool_with_line(Some(Value::from("wait")), Value::from("claude"));
        assert_eq!(
            conflict_policy(&session, "build-1.1").unwrap(),
            ConflictPolicy::Wait
        );
        assert_eq!(
            conflict_policy(&session, "build-1.2").unwrap(),
            ConflictPolicy::Wait
        );
    }

    #[test]
    fn a_mergers_resolver_fields_win_and_each_empty_one_falls_through_to_the_pool() {
        let pool = serde_json::json!({"harness": "claude", "model": "sonnet", "effort": "low"});
        let merger = |assign: Value| Some(serde_json::json!({"resolver": assign}));
        let session = pool_with_line(
            merger(serde_json::json!({"harness": "opencode", "model": "gpt-5"})),
            pool.clone(),
        );
        assert_eq!(
            conflict_policy(&session, "build-1.1").unwrap(),
            resolver("opencode", "gpt-5", Some("low"))
        );
        let session = pool_with_line(merger(serde_json::json!({"effort": "high"})), pool);
        assert_eq!(
            conflict_policy(&session, "build-1.1").unwrap(),
            resolver("claude", "sonnet", Some("high"))
        );
    }

    #[test]
    fn a_merger_can_name_a_resolver_when_the_pool_has_none() {
        let session = pool_with_line(
            Some(serde_json::json!({"resolver": {"harness": "opencode", "model": "gpt-5"}})),
            Value::from("none"),
        );
        assert_eq!(
            conflict_policy(&session, "build-1.1").unwrap(),
            resolver("opencode", "gpt-5", None)
        );
    }

    #[test]
    fn a_ticket_with_no_merger_takes_the_pools_own_resolver() {
        let pool = serde_json::json!({"harness": "claude", "model": "sonnet", "effort": "low"});
        let session = pool_with_line(None, pool.clone());
        for ticket in ["build-1.1", "plain-1", "01"] {
            assert_eq!(
                conflict_policy(&session, ticket).unwrap(),
                resolver("claude", "sonnet", Some("low")),
                "{ticket}"
            );
        }
        let none = pool_with_line(None, Value::from("none"));
        assert_eq!(
            conflict_policy(&none, "build-1.1").unwrap(),
            ConflictPolicy::NoResolver
        );
    }

    #[test]
    fn splits_a_ticket_file_at_its_marker_line() {
        assert_eq!(split_marker_line("a\nb\nc"), ("a", "b\nc"));
        assert_eq!(split_marker_line("a"), ("a", ""));
    }
}
