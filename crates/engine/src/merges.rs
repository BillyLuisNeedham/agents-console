//! Merges (engine.ts 749-890, 5887-6560, 11616-11732): the Merge hold over the engine's git probe and
//! the wait-and-recompute rule, the merge target and its checkout, the Ticket file reconcile at merge,
//! `mergeTicket`, the failed-merge records and Interrupts, resuming a conflicted merge, and the merge
//! resolver with its approval.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value};

use ac_core::assignment::engine_ticket_build_id;
use ac_core::events::{
    append_event, attempt_log_name, attempt_outcome_name, event_now, last_attempt, next_attempt,
    ticket_seed_name,
};
use ac_core::js;
use ac_core::machine_defaults::read_machine_defaults;
use ac_core::merge_hold::{MERGE_HOLD_POLL_MS, MergeHoldProbe};
use ac_core::pool::{TicketMarker, write_marker_status};
use ac_core::prompt::{ResolverPromptParts, build_resolver_prompt};
use ac_io::git::{self, MergeFailure, MergeResult, WorktreeInfo};
use ac_protocol::{Interrupt, InterruptKind, RunPhase, TicketEventKind, TicketStatus};

use crate::actor::Engine;
use crate::attempt_run::{
    AttemptEvents, AttemptNaming, AttemptSpec, CrashSubject, Fallback, PromptDelivery, Rotate,
    run_attempt,
};
use crate::checkout_gate::{hold_pool_checkout, release_pool_checkout};
use crate::interrupts::{interrupt, raise_interrupt, without};
use crate::session::{EnlistedWork, PoolUpdate, Session};
use crate::snapshot::emit_snapshot;
use crate::tickets::{attempt_env_of, close_attempt_tabs};

// ---------------------------------------------------------------------------------------------------
// The Merge hold (ADR-0014)
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

/// `mergeHold`: the ids of done tickets whose branch has not landed in the merge target, derived on
/// demand and never persisted. A git-less pool holds nothing; engine-run tickets never hold.
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

/// What the wait-and-recompute rule needs of a session: the hold derived fresh, the queued-answer
/// drain (true when it applied any), the log line that says the pool paused and why, and the emit.
pub trait HoldHost: Sync {
    fn derive(&self) -> impl Future<Output = anyhow::Result<Vec<String>>> + Send;
    fn drain(&self) -> impl Future<Output = anyhow::Result<bool>> + Send;
    fn engaged(&self, hold: Vec<String>) -> impl Future<Output = anyhow::Result<()>> + Send;
    fn emit(&self) -> impl Future<Output = anyhow::Result<()>> + Send;
}

/// The engine as a [`HoldHost`] (engine.ts `holdHost`).
pub struct EngineHoldHost<'a>(pub &'a Engine);

impl HoldHost for EngineHoldHost<'_> {
    async fn derive(&self) -> anyhow::Result<Vec<String>> {
        Ok(self.0.call(merge_hold).await?)
    }

    async fn drain(&self) -> anyhow::Result<bool> {
        self.0
            .call(|s| {
                let before = s.answers.pending().len();
                crate::answers::drain_answers(s)?;
                // The drive waits on the hold from here.
                crate::drive::drive_turned(s);
                Ok(s.answers.pending().len() != before)
            })
            .await?
    }

    async fn engaged(&self, hold: Vec<String>) -> anyhow::Result<()> {
        self.0
            .call(move |s| {
                s.log(format!(
                    "merge hold (ADR-0014): pool paused; awaiting the merge of {}",
                    hold.join(", ")
                ))
            })
            .await?;
        Ok(())
    }

    async fn emit(&self) -> anyhow::Result<()> {
        self.0.call(|s| emit_snapshot(s, RunPhase::Running)).await?;
        Ok(())
    }
}

/// `throughMergeHold`, the one wait-and-recompute rule: recompute; if the recompute saw the hold
/// standing, wait the hold out (draining queued answers on every tick) and recompute again; hand back
/// the first value a recompute produced with nothing held. The engagement is logged once per wait.
pub async fn through_merge_hold<T, H, F, Fut>(
    host: &H,
    mut recompute: F,
    interval: Duration,
) -> anyhow::Result<T>
where
    H: HoldHost,
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<(T, Vec<String>)>>,
{
    loop {
        let (value, hold) = recompute().await?;
        if hold.is_empty() {
            return Ok(value);
        }
        host.engaged(hold).await?;
        host.emit().await?;
        while !host.derive().await?.is_empty() {
            if host.drain().await? {
                host.emit().await?;
            }
            tokio::time::sleep(interval).await;
        }
    }
}

/// The poll cadence of a waiting flow.
pub fn hold_poll() -> Duration {
    Duration::from_millis(MERGE_HOLD_POLL_MS)
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

/// `mergeTargetSha`: the merge target's commit, captured just before a merge for the range a
/// done-Notice's diff summary covers; empty in a git-less pool.
pub fn merge_target_sha(session: &Session) -> String {
    if session.git {
        git::rev_parse(&session.cwd, &merge_target_ref(session))
    } else {
        String::new()
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
) -> anyhow::Result<MergeResult> {
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
        Err(err) => return Ok(blocked(err.to_string())),
    };
    let (result, theirs) = (merged.result, merged.theirs);
    let Some(theirs) = theirs.filter(|_| result.ok) else {
        return Ok(result);
    };
    let (content, conflicted) = reconcile_ticket_file(
        session,
        marker,
        branch,
        merge_base.as_deref(),
        &ours,
        &theirs,
    )?;
    js::write_file(&marker.file, &content)?;
    if conflicted {
        record_ticket_file_conflict(session, marker, branch)?;
    }
    Ok(result)
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
) -> anyhow::Result<MergeResult> {
    let result = merge_with_issue_aside(session, marker, &worktree.branch)?;
    if result.ok {
        remove_merge_worktree(session, marker, worktree);
    }
    Ok(result)
}

/// `removeMergeWorktree`: never for an enlisted ticket (issue #101), whose checkout and branch are the
/// operator's.
pub fn remove_merge_worktree(session: &Session, marker: &TicketMarker, worktree: &WorktreeInfo) {
    if marker.enlisted_from.is_some() || session.enlisted_work.contains_key(&marker.id) {
        return;
    }
    git::remove_worktree(&session.cwd, worktree);
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
    result: &MergeResult,
    before_sha: &str,
) -> anyhow::Result<()> {
    remove_merge_worktree(session, marker, worktree);
    let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
    append_event(
        Path::new(&session.runs_dir),
        &marker.id,
        &event_now(attempt, TicketEventKind::Merged, merged_payload(result)),
    )?;
    if !session.enlisted_work.contains_key(&marker.id) {
        close_attempt_tabs(session, &marker.id);
    }
    let range =
        (!before_sha.is_empty()).then(|| format!("{before_sha}..{}", merge_target_ref(session)));
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
    let before_sha = merge_target_sha(session);
    let result = merge_with_issue_aside(session, marker, &branch)?;
    append_resume_note(marker, note)?;
    if !result.ok {
        let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
        record_failed_merge(session, &marker.id, attempt, &result)?;
        let mut interrupts = without(&session.state.interrupts, pending);
        interrupts.push(merge_conflict_interrupt(session, marker, &result));
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
    record_answer_merge(session, marker, &worktree, &result, &before_sha)?;
    let interrupts = without(&session.state.interrupts, pending);
    session.apply(PoolUpdate {
        interrupts: Some(interrupts),
        log: Some(vec![format!(
            "interrupt answered for {} (merge-conflict): merge landed{}",
            marker.id,
            landed_detail(&result)
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
    let before_sha = merge_target_sha(session);
    let result = merge_with_issue_aside(session, marker, &worktree.branch)?;
    if !result.ok {
        let attempt = last_attempt(Path::new(&session.runs_dir), &marker.id);
        record_failed_merge(session, &marker.id, attempt, &result)?;
        let mut interrupts = without(&session.state.interrupts, pending);
        interrupts.push(manual_merge_interrupt(
            session,
            marker,
            &result,
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
    record_answer_merge(session, marker, &worktree, &result, &before_sha)?;
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
/// the merge hold.
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
/// over the pool defaults and the Machine defaults. `None` takes the manual path; an explicit resolver
/// naming an unknown harness fails.
pub fn resolve_resolver(session: &Session) -> anyhow::Result<Option<ResolverSpec>> {
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
                let Some(resolver) = resolve_resolver(s)? else {
                    let manual = manual_merge_interrupt(
                        s,
                        &marker,
                        &result,
                        "no resolver harness available (set console.json resolver= or a \
                         ~/.issue-runner default)",
                    );
                    raise_interrupt(s, manual);
                    return Ok(Route::Done);
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
    use std::sync::Mutex;

    // A host over a scripted sequence of derived holds, recording what the rule did.
    struct ScriptedHost {
        derived: Mutex<Vec<Vec<String>>>,
        calls: Mutex<Vec<String>>,
    }

    impl ScriptedHost {
        fn new(derived: Vec<Vec<&str>>) -> Self {
            ScriptedHost {
                derived: Mutex::new(
                    derived
                        .into_iter()
                        .map(|d| d.into_iter().map(str::to_owned).collect())
                        .collect(),
                ),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl HoldHost for ScriptedHost {
        async fn derive(&self) -> anyhow::Result<Vec<String>> {
            self.calls.lock().unwrap().push("derive".into());
            let mut derived = self.derived.lock().unwrap();
            Ok(if derived.is_empty() {
                Vec::new()
            } else {
                derived.remove(0)
            })
        }
        async fn drain(&self) -> anyhow::Result<bool> {
            self.calls.lock().unwrap().push("drain".into());
            Ok(false)
        }
        async fn engaged(&self, hold: Vec<String>) -> anyhow::Result<()> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("engaged {}", hold.join(",")));
            Ok(())
        }
        async fn emit(&self) -> anyhow::Result<()> {
            self.calls.lock().unwrap().push("emit".into());
            Ok(())
        }
    }

    // merge-hold.test.ts:418
    #[tokio::test]
    async fn hands_back_the_first_recompute_when_nothing_holds_without_a_wait() {
        let host = ScriptedHost::new(vec![]);
        let value = through_merge_hold(
            &host,
            || async { Ok((7, Vec::new())) },
            Duration::from_millis(1),
        )
        .await
        .unwrap();
        assert_eq!(value, 7);
        assert!(host.calls().is_empty());
    }

    // merge-hold.test.ts:431
    #[tokio::test]
    async fn re_waits_a_hold_that_re_engages_between_the_wait_and_the_recompute() {
        // The first recompute sees 01 held; the wait sees it lift; the second recompute sees 02 held
        // (re-engaged), so a second wait starts, logged again; the third recompute is clear.
        let host = ScriptedHost::new(vec![vec!["01"], vec![], vec!["02"], vec![]]);
        let holds = Mutex::new(vec![vec!["01"], vec!["02"], vec![]]);
        let value = through_merge_hold(
            &host,
            || {
                let hold: Vec<String> = holds
                    .lock()
                    .unwrap()
                    .remove(0)
                    .into_iter()
                    .map(str::to_owned)
                    .collect();
                async move { Ok((hold.is_empty(), hold)) }
            },
            Duration::from_millis(1),
        )
        .await
        .unwrap();
        assert!(value);
        assert_eq!(
            host.calls(),
            [
                "engaged 01",
                "emit",
                "derive",
                "drain",
                "derive",
                "engaged 02",
                "emit",
                "derive",
                "drain",
                "derive"
            ]
        );
    }

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

    #[test]
    fn splits_a_ticket_file_at_its_marker_line() {
        assert_eq!(split_marker_line("a\nb\nc"), ("a", "b\nc"));
        assert_eq!(split_marker_line("a"), ("a", ""));
    }
}
