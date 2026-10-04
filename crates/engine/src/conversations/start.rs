//! Starting and enlisting a Conversation.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use ac_core::assignment::{
    Assignment, AssignmentLayer, AssignmentRequest, DEFAULT_DRIVERS, ResolveAssignmentParams,
    resolve_assignment,
};
use ac_core::conversation_record::{ConversationRecord, EnlistedConversation, write_conversation};
use ac_core::harness::harness_descriptor;
use ac_core::js;
use ac_core::notices::{Notice, NoticeKind};
use ac_core::steward::steward_assign_of;
use ac_io::git::{self, WorktreeInfo};
use ac_io::herdr::{Herdr, PaneAgentState};
use ac_protocol::{
    ConversationRole, ConversationStatus, ConversationView, StartConversationRequest,
    TicketEventKind,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::actor::Engine;
use crate::attempt_run::{
    AttemptEvents, AttemptHandle, AttemptHandleState, AttemptNaming, AttemptSpec, CrashSubject,
    Fallback, PromptDelivery, Rotate, launch_attempt, with_launch_detail,
};
use crate::error::EngineError;
use crate::tickets::attempt_env_of;

fn refused(message: impl Into<String>) -> EngineError {
    EngineError::refused(message)
}

// What the start's first stretch settled: everything the launch needs, and nothing that needs the
// session.
struct Prepared {
    id: String,
    title: String,
    opening: String,
    role: Option<ConversationRole>,
    spawned_by: Option<String>,
    assignment: Assignment,
    worktree: WorktreeInfo,
    file: PathBuf,
    to_type: String,
    teaching: String,
    env: crate::attempt_run::AttemptEnv,
}

// A spawned Conversation inherits its parent's Assignment; a Steward takes the Steward entry of the Pool
// settings (ADR-0030), the way the resolver pins its own; both sit between the request and the pool
// defaults.
fn resolve_start_assignment(
    s: &Session,
    req: &StartConversationRequest,
    existing: &[ConversationRecord],
) -> Result<Assignment, EngineError> {
    let parent = req
        .spawned_by
        .as_deref()
        .and_then(|parent| existing.iter().find(|rec| rec.id == parent));
    let is_steward = req.role == Some(ConversationRole::Steward);
    let steward = if is_steward {
        steward_assign_of(config(s))
    } else {
        None
    };
    let request = req.assign.as_ref().map(|assign| {
        AssignmentRequest::from(AssignmentLayer::of_fields(
            assign.harness.as_deref(),
            assign.model.as_deref(),
            assign.effort.as_deref(),
            assign.drivers.as_deref(),
        ))
    });
    let inherited = match (parent, &steward) {
        (Some(parent), _) => Some(AssignmentLayer::of_fields(
            Some(&parent.harness),
            Some(&parent.model),
            parent.effort.as_deref(),
            Some(&parent.drivers),
        )),
        (None, Some(steward)) => Some(AssignmentLayer::of_fields(
            Some(steward.harness.as_deref().unwrap_or("")),
            Some(steward.model.as_deref().unwrap_or("")),
            steward.effort.as_deref(),
            Some(steward.drivers.as_deref().unwrap_or("")),
        )),
        (None, None) => None,
    };
    let defaults = ac_core::assignment::defaults_layer(config(s));
    resolve_assignment(ResolveAssignmentParams {
        subject: if is_steward {
            "steward start:"
        } else {
            "conversation start:"
        },
        request: request.as_ref(),
        requested: None,
        inherited: inherited.as_ref(),
        defaults: Some(&defaults),
        strict: true,
        verify: false,
        harnesses: &s.harnesses,
    })
    .map_err(|err| refused(err.0))
}

// The synchronous stretch of `start` up to the launch: the checks, the id, the reservation, the
// Assignment, the worktree and the teaching.
fn prepare(s: &mut Session, req: &StartConversationRequest) -> Result<Prepared, EngineError> {
    if !terminal_backed(s) {
        return Err(refused(
            "conversation start: the pool is not terminal-backed (set console.json terminal: \"herdr\")",
        ));
    }
    if !s.git {
        return Err(refused(
            "conversation start: the pool has no git checkout, so it cannot give the Conversation \
             its own worktree and branch",
        ));
    }
    if js::trim(&req.title).is_empty() {
        return Err(refused("conversation start: title is required"));
    }
    let is_steward = req.role == Some(ConversationRole::Steward);
    if is_steward && let Some(on_duty) = steward_on_duty(s) {
        return Err(refused(format!(
            "steward start: {}",
            second_steward_reason(&on_duty)
        )));
    }
    let existing = load(s);
    let id = match (&req.id, &req.spawned_by) {
        (Some(id), _) => id.clone(),
        (None, Some(parent)) => {
            ac_core::conversation_record::next_conversation_spawn_id(parent, &existing)
        }
        (None, None) => ac_core::conversation_record::next_conversation_id(&existing, |id| {
            s.conversations.reserved.contains(id)
        }),
    };
    // Reserved before the first await, so an adoption that reads the reserved ids right after firing
    // this start already sees it.
    s.conversations.reserved.insert(id.clone());
    if is_steward {
        s.conversations.steward_starting = Some(id.clone());
    }
    let prepared = prepare_reserved(s, req, &id, &existing);
    if prepared.is_err() {
        unreserve(s, &id);
    }
    prepared
}

fn prepare_reserved(
    s: &mut Session,
    req: &StartConversationRequest,
    id: &str,
    existing: &[ConversationRecord],
) -> Result<Prepared, EngineError> {
    let assignment = resolve_start_assignment(s, req, existing)?;
    // Forked from the merge target, not the pool checkout's HEAD: once an enlist has moved that
    // checkout onto a created pool branch (issue #101), HEAD there is the enlisted agent's branch, and
    // a Conversation forked from it would carry that agent's commits onto the target at End.
    let base = crate::merges::merge_target_branch(s);
    let worktree =
        git::prepare_worktree(&s.cwd, id, None, &base).map_err(|err| refused(err.to_string()))?;
    let file = conversation_file(s, id);
    let opening = req.opening.clone().unwrap_or_default();
    // The spawn-teaching paragraph always lands, appended to the opening Turn when there is one; typed
    // alone otherwise, so an agent given no opening still learns the propose-and-adopt mechanism before
    // the operator's first real Turn.
    let teaching = teaching_for(s, id, req.role, &assignment);
    let to_type = if js::trim(&opening).is_empty() {
        teaching.clone()
    } else {
        format!("{opening}\n\n{teaching}")
    };
    Ok(Prepared {
        id: id.to_owned(),
        title: req.title.clone(),
        opening,
        role: req.role,
        spawned_by: req.spawned_by.clone(),
        assignment,
        worktree,
        file,
        to_type,
        teaching,
        env: attempt_env_of(s, None),
    })
}

fn unreserve(s: &mut Session, id: &str) {
    s.conversations.reserved.shift_remove(id);
    if s.conversations.steward_starting.as_deref() == Some(id) {
        s.conversations.steward_starting = None;
    }
}

/// Start a Conversation: refuse a non-terminal pool, resolve its Assignment, give it a worktree and
/// branch, then launch it through the Attempt-run module (ADR-0014's one code path): the named herdr
/// tab, the interactive harness under the ADR-0016 wrapper, the readiness wait, and the opening Turn
/// typed verbatim and echo verified. A Conversation has no headless fallback (ADR-0018: it is a
/// terminal-backed TUI or nothing), so a tab or a launch command that could not be had is a start
/// failure. Fails only when the pool cannot host a Conversation at all (headless, no git) or the launch
/// never got a running pane; once the record exists on disk it resolves even when the harness died
/// before its TUI, the TUI never became ready, or the opening Turn never landed, reporting the
/// Conversation crashed rather than losing the attempt to an unstructured rejection.
pub async fn start(
    engine: &Engine,
    req: StartConversationRequest,
) -> Result<ConversationView, EngineError> {
    let prepared = engine.call(move |s| prepare(s, &req)).await??;
    let id = prepared.id.clone();
    let view = launch(engine, prepared).await;
    engine.call(move |s| unreserve(s, &id)).await?;
    view
}

async fn launch(engine: &Engine, p: Prepared) -> Result<ConversationView, EngineError> {
    let Assignment {
        harness,
        model,
        effort,
        ..
    } = p.assignment.clone();
    // The launch: one attempt, the well-known file names, no rotation, no headless fallback, the
    // opening Turn as a plain prompt (no driver line: a Conversation has no skill to invoke and no
    // file-referencing fallback, so a paste that never lands is a crash, not a silently empty pane),
    // and only the spawned event on the log; the crash and ending events are the Conversation's own.
    let spec: AttemptSpec<()> = AttemptSpec {
        id: p.id.clone(),
        issue_path: js::path_text(&p.file),
        title: p.title.clone(),
        body: p.to_type.clone(),
        driver: "converse".to_owned(),
        harness: harness.clone(),
        model: model.clone(),
        effort: effort.clone(),
        cwd: p.worktree.path.clone(),
        branch: Some(p.worktree.branch.clone()),
        attempt: 1,
        naming: AttemptNaming {
            attempt: None,
            resolver: false,
        },
        rotate: Rotate::None,
        fallback: Fallback::None,
        prompt: PromptDelivery::Plain {
            echo: if js::trim(&p.opening).is_empty() {
                p.teaching.clone()
            } else {
                p.opening.clone()
            },
        },
        crash_subject: CrashSubject::Harness,
        events: AttemptEvents::SpawnedOnly,
    };
    let launched = launch_attempt(&p.env, &spec).await;
    engine.call(move |s| after_launch(s, p, launched)).await?
}

// The stretch after the launch: the record lands, and the Conversation either never went live or joins
// the runtimes.
fn after_launch(
    s: &mut Session,
    p: Prepared,
    launched: anyhow::Result<AttemptHandle>,
) -> Result<ConversationView, EngineError> {
    let handle = match launched {
        Ok(handle) => handle,
        Err(err) => {
            git::remove_worktree(&s.cwd, &p.worktree);
            return Err(refused(format!("conversation start: {err}")));
        }
    };
    let record = ConversationRecord {
        id: p.id.clone(),
        file: p.file.clone(),
        title: js::trim(&p.title).to_owned(),
        opening: p.opening.clone(),
        status: ConversationStatus::Live,
        spawned_by: p.spawned_by.clone(),
        harness: p.assignment.harness.clone(),
        model: p.assignment.model.clone(),
        effort: p.assignment.effort.clone(),
        drivers: p.assignment.drivers.clone(),
        enlisted: None,
        role: p.role,
    };
    write_conversation(&conversations_dir(s), &record).map_err(|err| refused(err.to_string()))?;
    let id = p.id.clone();
    if let AttemptHandleState::Ended { code, .. } = &handle.state {
        // The harness died before its TUI came up (its own exit code, ADR-0016), or the launch command
        // never ran, the TUI never became ready, or the opening Turn never landed (the engine's codes):
        // the launch is over. The record stays, marked crashed, so the event trail is kept and the id is
        // never reused, but the worktree and branch go (issue #102, ADR-0018's amendment): the
        // Conversation never went live, so there is nothing in them to keep. A Conversation that
        // crashes after it went live keeps its branch (mark_crashed): the operator may have work in it.
        // The launch keeps a pane whose harness died on its own (ADR-0014's crashed-attempt rule), but
        // this Conversation never joins the runtimes, so nothing else would ever close the tab: it goes
        // here, as mark_crashed's does.
        let code = *code;
        let _ = ac_core::conversation_record::write_conversation_status(
            &p.file,
            ConversationStatus::Crashed,
        );
        let reason = with_launch_detail(
            crate::attempt_ending::exit_crash_reason(
                code,
                &handle.ctx.exit_code_path,
                "harness",
                handle.pane_id.as_deref(),
            ),
            &handle,
        );
        event1(
            s,
            &id,
            TicketEventKind::Crash,
            json!({ "code": code, "reason": reason }),
        );
        // The launch reported the pane's agent the moment the wrapper landed; this Conversation never
        // got further, so the identity goes with the ending, as at every other ending.
        release_agent(s, handle.pane_id.as_deref(), &p.assignment.harness);
        crate::live_attempts::clear(s, &id, 1);
        // The sweep's closes complete after the start has answered: the TypeScript's single thread
        // wrote the response before it read herdr's replies, so a caller never saw the `tab-closed`
        // events of a start that crashed before they were its own to read.
        let engine = s.engine();
        let sweep = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = engine
                .call(move |s| crate::tickets::close_attempt_tabs(s, &sweep))
                .await;
        });
        super::notices::note_ended(s, &id, &p.worktree.branch, None, true);
        git::discard_worktree(&s.cwd, &p.worktree);
        // This launch never touches the drive loop, so nothing else would ever tell the snapshot stream
        // this Conversation existed at all.
        publish(s);
        let mut crashed = record;
        crashed.status = ConversationStatus::Crashed;
        return Ok(view_of(s, &crashed, &load(s)));
    }
    let AttemptHandleState::Live { tailer, .. } = handle.state else {
        unreachable!("an attempt that did not end at launch is live");
    };
    let runtime = Rt::new(Runtime {
        id: id.clone(),
        file: p.file.clone(),
        pane_id: handle.pane_id.clone(),
        tab_id: handle.tab_id.clone(),
        worktree: p.worktree.clone(),
        exit_code_path: handle.ctx.exit_code_path.clone(),
        stream_path: handle
            .ctx
            .stream_path
            .clone()
            .unwrap_or_else(|| js::path_join(&[&s.runs_dir, &format!("{id}.stream.jsonl")])),
        log_path: handle.ctx.log_path.clone(),
        enlisted: false,
        harness: p.assignment.harness.clone(),
        label: ac_io::herdr::attempt_tab_label(&id, &p.title),
        turn: ac_core::turn_state::FRESH_TURN,
        tailer,
        notices: Vec::new(),
        delivery: None,
        ending: false,
        closing: None,
        ended_by: None,
        role: p.role,
        told: Default::default(),
        baselined: false,
        close_tabs: true,
        release: CancellationToken::new(),
        timer: None,
        herdr: Herdr::new(&s.herdr_socket),
    });
    s.conversations.runtimes.insert(id.clone(), runtime.clone());
    super::end::watch_for_crash(s, &runtime);
    // The Assignment under this Conversation's id, so a Ticket it spawns whose spawned-by names it
    // resolves the same way a grader or spawned ticket inherits from its own parent.
    record_assignment(s, &id, p.assignment.clone());
    super::tick::start_tick(s, &runtime);
    // start is called directly off the handle (the server route, or a fire-and-forget spawn adoption),
    // never through the drive loop, so nothing else emits a snapshot that would tell the socket this
    // Conversation now exists; a pool with no other ticket activity in flight could otherwise go
    // arbitrarily long before the next unrelated emit.
    publish(s);
    Ok(view_of(s, &record, &load(s)))
}

/// A live pane the operator enlists as a Conversation (issue #101): the found facts the engine recorded,
/// the operator's title and optional opening Turn, and an id the engine minted before applying the
/// branch rule (so the pool branch, the record file and the spawn-proposal path all name it). No assign
/// and no spawnedBy: an enlisted Conversation is as found.
#[derive(Debug, Clone)]
pub struct EnlistConversationRegistration {
    pub id: String,
    pub pane_id: String,
    pub tab_id: Option<String>,
    /// herdr's agent label: the harness the pane is running.
    pub harness: String,
    pub title: String,
    pub opening: Option<String>,
    pub directory: String,
    pub branch: String,
    pub session_id: Option<String>,
    /// Enlisted as the Steward (ADR-0030).
    pub steward: bool,
}

impl EnlistConversationRegistration {
    fn role(&self) -> Option<ConversationRole> {
        self.steward.then_some(ConversationRole::Steward)
    }
}

/// The view of the Conversation an enlist made, or the reason it could not.
pub type EnlistConversationResult = Result<ConversationView, String>;

struct EnlistClaim {
    rt: Rt,
    descriptor: &'static ac_core::harness::HarnessDescriptor,
    poll: Duration,
    wait: Duration,
}

fn enlist_claim(
    s: &mut Session,
    req: &EnlistConversationRegistration,
) -> Result<EnlistClaim, String> {
    if !terminal_backed(s) {
        return Err("the pool is not terminal-backed".to_owned());
    }
    if !s.git {
        return Err("the pool has no git checkout".to_owned());
    }
    let harness = js::trim(&req.harness).to_lowercase();
    let Some(descriptor) = harness_descriptor(&harness) else {
        return Err("no harness the engine knows".to_owned());
    };
    let is_steward = req.role() == Some(ConversationRole::Steward);
    if is_steward && let Some(on_duty) = steward_on_duty(s) {
        return Err(second_steward_reason(&on_duty));
    }
    // Reserved before the first await: the id is already fixed by the branch rule the engine applied, so
    // a concurrent start must not mint it too.
    s.conversations.reserved.insert(req.id.clone());
    if is_steward {
        s.conversations.steward_starting = Some(req.id.clone());
    }
    let rt = enlisted_runtime(
        s,
        EnlistedFacts {
            id: &req.id,
            file: conversation_file(s, &req.id),
            pane_id: &req.pane_id,
            tab_id: req.tab_id.clone(),
            harness: &harness,
            title: &req.title,
            directory: &req.directory,
            branch: &req.branch,
            role: req.role(),
        },
    );
    Ok(EnlistClaim {
        rt,
        descriptor,
        poll: Duration::from_millis(s.conversation_poll_ms.unwrap_or(CONVERSATION_POLL_MS)),
        wait: Duration::from_millis(
            s.teaching_wait_ms
                .unwrap_or(crate::pane_session::READINESS_TIMEOUT_MS),
        ),
    })
}

/// Enlist a live pane the operator opened as a Conversation (issue #101): the launch `start` does minus
/// the launch. The pane, tab, directory and branch are taken as found, the agent identity is reported
/// and the tab relabelled, the record is written, and the Spawn teaching and the operator's opening Turn
/// are queued through the Notice path (typed now if the pane is already waiting, otherwise on the tick's
/// next waiting read).
///
/// Resolves a reason rather than failing when the pane cannot be claimed: the caller (the enlist flow)
/// unwinds the branch it may have created and answers its 409. A failure after the record is written
/// removes the record, its events and the agent identity, so a failed enlist leaves nothing.
pub async fn enlist(
    engine: &Engine,
    req: EnlistConversationRegistration,
) -> EnlistConversationResult {
    let (claim_req, id, role) = (req.clone(), req.id.clone(), req.role());
    let claim = match engine.call(move |s| enlist_claim(s, &claim_req)).await {
        Ok(Ok(claim)) => claim,
        Ok(Err(reason)) => return Err(reason),
        Err(gone) => return Err(gone.to_string()),
    };
    let result = enlist_claimed(engine, req, &claim).await;
    let _ = engine
        .call(move |s| {
            s.conversations.reserved.shift_remove(&id);
            if role == Some(ConversationRole::Steward)
                && s.conversations.steward_starting.as_deref() == Some(id.as_str())
            {
                s.conversations.steward_starting = None;
            }
        })
        .await;
    result
}

async fn enlist_claimed(
    engine: &Engine,
    req: EnlistConversationRegistration,
    claim: &EnlistClaim,
) -> EnlistConversationResult {
    let rt = &claim.rt;
    let pane = req.pane_id.clone();
    // A refused enlist leaves nothing, the settling reads' register entry included: no tick will follow
    // them, so nothing may serve them.
    let refuse = |reason: String| {
        let engine = engine.clone();
        let pane = pane.clone();
        async move {
            let _ = engine.call(move |s| s.pane_reads.forget(&pane)).await;
            Err::<ConversationView, String>(reason)
        }
    };
    // Settle the Turn state from consecutive reads, exactly as the enlisted Ticket's claim does: an
    // idle pane is taught now, and a working one is given a Launch's readiness bound to reach waiting,
    // re-read every poll, so the Turns land the moment the agent is waiting on the operator and never
    // mid-reply. Past the bound the enlist is refused and leaves nothing.
    let settled: Result<Option<String>, String> = async {
        super::tick::settle_turn(engine, rt, Some(claim.descriptor))
            .await
            .map_err(|err| err.to_string())?;
        let deadline = Instant::now() + claim.wait;
        while rt.with(|r| r.turn.state) != ac_protocol::TurnSide::Waiting {
            if Instant::now() >= deadline {
                return Ok(Some(crate::pane_session::still_working_reason(
                    u64::try_from(claim.wait.as_millis()).unwrap_or(u64::MAX),
                )));
            }
            tokio::time::sleep(claim.poll).await;
            super::tick::read_turn(engine, rt, Some(claim.descriptor))
                .await
                .map_err(|err| err.to_string())?;
        }
        Ok(None)
    }
    .await;
    match settled {
        Err(message) => {
            return refuse(format!("the pane could not be read ({message})")).await;
        }
        Ok(Some(reason)) => return refuse(reason).await,
        Ok(None) => {}
    }

    let harness = js::trim(&req.harness).to_lowercase();
    let request = req.clone();
    let rt_for_record = rt.clone();
    let stage = engine
        .call(move |s| enlist_record(s, &request, &rt_for_record, &harness))
        .await
        .map_err(|gone| gone.to_string())?;
    let (record, was_waiting, plan) = match stage {
        Ok(stage) => stage,
        Err(reason) => return refuse(reason).await,
    };
    if let Some(plan) = plan {
        super::notices::deliver_run(engine, plan).await;
    }
    if was_waiting {
        let rolled_back = {
            let (id, rt) = (req.id.clone(), rt.clone());
            engine
                .call(move |s| {
                    if rt.with(|r| r.notices.is_empty()) {
                        return false;
                    }
                    // The teaching never landed: remove the half-written record and its events, drop
                    // the runtime and the identity, and let the caller unwind the branch it may have
                    // created.
                    s.conversations.runtimes.shift_remove(&id);
                    let (pane, harness) = rt.with(|r| (r.pane_id.clone(), r.harness.clone()));
                    release_agent(s, pane.as_deref(), &harness);
                    let _ = std::fs::remove_file(conversation_file(s, &id));
                    let _ = std::fs::remove_file(runs_dir(s).join(format!("{id}.events.jsonl")));
                    true
                })
                .await
                .map_err(|gone| gone.to_string())?
        };
        if rolled_back {
            return refuse("the teaching Turn could not be delivered".to_owned()).await;
        }
    }
    // The operator's tab is relabelled only once the claim has held, so a refused enlist leaves the label
    // as it found it; awaited (still best-effort) so the claim is whole when the enlist answers.
    if let Some(tab) = &req.tab_id {
        let (herdr, label) = rt.with(|r| (r.herdr.clone(), r.label.clone()));
        let _ = herdr.relabel_tab(tab, &label).await;
    }
    let (rt, id, harness) = (
        rt.clone(),
        req.id.clone(),
        js::trim(&req.harness).to_lowercase(),
    );
    engine
        .call(move |s| {
            super::end::watch_for_crash(s, &rt);
            // The Assignment under this Conversation's id, as start records it, so a Ticket it spawns
            // inherits it.
            record_assignment(
                s,
                &id,
                Assignment {
                    harness,
                    model: String::new(),
                    effort: None,
                    drivers: DEFAULT_DRIVERS.to_owned(),
                    verify: None,
                },
            );
            super::tick::start_tick(s, &rt);
            publish(s);
            Ok(view_of(s, &record, &load(s)))
        })
        .await
        .map_err(|gone| gone.to_string())?
}

type EnlistStage = (
    ConversationRecord,
    bool,
    Option<super::notices::DeliverPlan>,
);

// The stretch that writes the record and queues the teaching and the opening Turn.
fn enlist_record(
    s: &mut Session,
    req: &EnlistConversationRegistration,
    rt: &Rt,
    harness: &str,
) -> Result<EnlistStage, String> {
    super::report_agent(rt, PaneAgentState::Blocked);
    let opening = req.opening.clone().unwrap_or_default();
    let file = conversation_file(s, &req.id);
    let found = EnlistedConversation {
        pane_id: req.pane_id.clone(),
        tab_id: req.tab_id.clone(),
        directory: req.directory.clone(),
        branch: req.branch.clone(),
        session_id: req.session_id.clone(),
    };
    let record = ConversationRecord {
        id: req.id.clone(),
        file,
        title: js::trim(&req.title).to_owned(),
        opening: opening.clone(),
        status: ConversationStatus::Live,
        spawned_by: None,
        harness: harness.to_owned(),
        // The Assignment as found: herdr names no model, so the card reads "as found" where a started
        // Conversation names one.
        model: String::new(),
        effort: None,
        drivers: DEFAULT_DRIVERS.to_owned(),
        enlisted: Some(found),
        role: req.role(),
    };
    // The record lands before delivery: deliver reads it for the harness descriptor, and the card must
    // exist the moment the enlist does.
    write_conversation(&conversations_dir(s), &record).map_err(|err| err.to_string())?;
    // The teaching, then the opening Turn, both through the Notice path: the same
    // queue-then-deliver-while-waiting the spawned Notices use.
    let teaching = teaching_for(
        s,
        &req.id,
        req.role(),
        &Assignment {
            harness: harness.to_owned(),
            model: String::new(),
            effort: None,
            drivers: DEFAULT_DRIVERS.to_owned(),
            verify: None,
        },
    );
    rt.with(|r| {
        r.notices.push(Notice {
            to: req.id.clone(),
            from: req.id.clone(),
            kind: NoticeKind::EnlistTeaching,
            text: teaching,
            key: None,
        });
        if !js::trim(&opening).is_empty() {
            r.notices.push(Notice {
                to: req.id.clone(),
                from: req.id.clone(),
                kind: NoticeKind::OpeningTurn,
                text: opening,
                key: None,
            });
        }
    });
    s.conversations.runtimes.insert(req.id.clone(), rt.clone());
    let was_waiting = rt.with(|r| r.turn.state) == ac_protocol::TurnSide::Waiting;
    let plan = if was_waiting {
        super::notices::deliver_begin(s, &req.id)
    } else {
        None
    };
    Ok((record, was_waiting, plan))
}
