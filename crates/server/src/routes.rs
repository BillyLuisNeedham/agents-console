//! Each route's body, as a function both of its callers run (server.ts, issue #161): the HTTP route,
//! which turns the answer into the response it has always sent, and the socket, which turns it into a
//! reply. A route that reads a JSON body takes it already read, so a body that fails to parse is refused
//! at the point, and in the words, it always was; the socket's payload has parsed already.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::{Map, Value, json};

use ac_core::config::read_config;
use ac_core::js;
use ac_core::machine_defaults::write_machine_defaults;
use ac_core::plan::library::{self, LibraryError};
use ac_core::plan::{Plan, PlanEdit};
use ac_core::pool_settings::{relaunch_port, write_pool_settings};
use ac_engine::EngineError;
use ac_engine::enlist::list_enlist_panes;
use ac_io::herdr::PaneReadSource;
use ac_protocol::json::Unchecked;
use ac_protocol::{
    BecomesConversation, BecomesSteward, BecomesTicket, ConversationAssign, ConversationRole,
    EnlistConversationWireRequest, EnlistRequest, EnlistStewardWireRequest, EnlistTicketRequest,
    LineResponse, LogAttemptInfo, POOL_LOG_WINDOW, PlanBootRequest, PlanDraftResponse,
    PlanEditRequest, PlanNodeVerdicts, PlanResponse, PlanSaveResponse, PlanValidateResponse,
    PlansListResponse, RequestKind, ResumeAction, RunPhase, StartConversationRequest,
};

use crate::reads::{self, LogRange, POOL_LOG_MAX_LINES};
use crate::reassign::{ReassignContext, ReassignError, ReassignOutcome, write_reassign};
use crate::server::{Inner, LineBoot, LineBootRefusal, Server, live_attempt_ids};

/// Which key a refusal's reason goes under over HTTP: the older routes say `error`, the Conversation
/// routes and those after them `reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Error,
    Reason,
}

impl Field {
    pub fn key(self) -> &'static str {
        match self {
            Field::Error => "error",
            Field::Reason => "reason",
        }
    }
}

/// What a request came to, in the one shape both of its callers read (ws.ts `RequestAnswer`).
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// The result with its status; the result's encoding error when it could not be encoded.
    Ok {
        status: u16,
        result: Result<Value, String>,
    },
    /// A refusal: `{[field]: reason}` with the status over HTTP, `{reason, status}` on the socket.
    Refused {
        status: u16,
        field: Field,
        reason: String,
    },
    /// A throw nothing on the route caught: the runtime's 500 over HTTP, a 500 refusal on the socket.
    Thrown(String),
}

impl Answer {
    pub fn ok<T: Serialize>(status: u16, result: &T) -> Answer {
        Answer::Ok {
            status,
            result: serde_json::to_value(result).map_err(|err| err.to_string()),
        }
    }

    pub fn ok_value(status: u16, result: Value) -> Answer {
        Answer::Ok {
            status,
            result: Ok(result),
        }
    }

    pub fn refused(status: u16, field: Field, reason: impl Into<String>) -> Answer {
        Answer::Refused {
            status,
            field,
            reason: reason.into(),
        }
    }

    /// The answer less the snapshot its HTTP route carries: on the socket the snapshot's change arrives
    /// as a delta ahead of the reply.
    pub fn without_snapshot(self) -> Answer {
        match self {
            Answer::Ok {
                status,
                result: Ok(Value::Object(mut map)),
            } => {
                map.shift_remove("snapshot");
                Answer::ok_value(status, Value::Object(map))
            }
            other => other,
        }
    }
}

/// A request body as the route read it: the parsed JSON, or why it would not parse.
pub type Body = Result<Value, String>;

/// `req.json()`: the body parsed as JSON, refused in Bun's words.
pub fn parse_body(bytes: &[u8]) -> Body {
    let text = js::decode_utf8(bytes);
    if js::trim(&text).is_empty() {
        return Err("Unexpected end of JSON input".to_owned());
    }
    js::parse(&text).map_err(|_| "Failed to parse JSON".to_owned())
}

fn field_of<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    match body {
        Value::Object(map) => map.get(key),
        _ => None,
    }
}

fn text_of(body: &Value, key: &str) -> String {
    field_of(body, key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn string_field(body: &Value, key: &str) -> Option<String> {
    field_of(body, key)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

// `body ?? {}` for the routes that read fields off whatever parsed.
fn or_empty(body: Value) -> Value {
    if body.is_null() { json!({}) } else { body }
}

fn engine_refusal_status(err: &EngineError, otherwise: u16) -> u16 {
    match err {
        EngineError::AnswerQueuedConflict(_) | EngineError::LineRefusal(_) => 409,
        _ => otherwise,
    }
}

const RESUME_ACTIONS: [&str; 5] = ["resume", "approve", "reject", "close", "adopt"];

/// `REVIEW_TICKET_ID`: the run's review gate.
const REVIEW_TICKET_ID: &str = "REVIEW";

// ---------------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------------

pub async fn start_request(server: &Server) -> Answer {
    match server.start().await {
        Ok(snapshot) => Answer::ok(200, &json!({ "snapshot": &*snapshot })),
        Err(err) => Answer::Thrown(err),
    }
}

/// Stop this server from the Console (issue #97): only a finished pool may be stopped this way, and a
/// stop already under way is acknowledged again rather than started twice.
pub fn stop_request(server: &Server, inner: &mut Inner) -> Answer {
    let phase = server.current(inner).map(|snapshot| snapshot.phase);
    let under_way = server.stop_under_way(inner);
    if !under_way && phase != Some(RunPhase::Done) {
        return Answer::refused(
            409,
            Field::Error,
            match phase {
                None => "pool not started: nothing to stop".to_owned(),
                Some(phase) => format!("pool is {}, not done: stop refused", phase.as_str()),
            },
        );
    }
    if !under_way {
        inner.stop_requested = true;
        // Off the request's own turn, so the answer is on the wire before serving stops under it.
        let owner = server.clone();
        server.0.runtime.spawn(async move { owner.request_stop() });
    }
    Answer::ok(202, &json!({ "stopping": true }))
}

/// Restart this server from the Console (issue #121): allowed in any phase. The answer names the port
/// the relaunch will listen on.
pub fn restart_request(server: &Server, inner: &mut Inner) -> Answer {
    let port = relaunch_port(server.pool_dir(), u64::from(server.port()));
    if !server.stop_under_way(inner) {
        inner.stop_requested = true;
        let owner = server.clone();
        let promised = port.clone();
        server
            .0
            .runtime
            .spawn(async move { owner.request_restart(promised) });
    }
    Answer::ok(202, &json!({ "ok": true, "port": port }))
}

pub fn settings_request(server: &Server) -> Answer {
    match server.settings_payload() {
        Ok(payload) => Answer::ok(200, &payload),
        // Only a console.json hand-edited into a broken state since boot reaches here.
        Err(err) => Answer::refused(500, Field::Error, err),
    }
}

/// A patch of the pool's settings: `assign` and every key this server does not know survive the
/// write. An idle pool reloads at once (issue #149), and the push hands a changed title to the run.
pub async fn pool_settings_request(server: &Server, body: Body) -> Answer {
    let saved = (|| -> Result<(), String> {
        let body = body?;
        let Some(Value::Object(patch)) = field_of(&body, "config") else {
            return Err("settings: config must be an object".to_owned());
        };
        write_pool_settings(server.pool_dir(), patch, &server.0.harnesses.names())
            .map_err(|err| err.to_string())?;
        Ok(())
    })();
    if let Err(err) = saved {
        return Answer::refused(400, Field::Error, err);
    }
    if let Some(engine) = server.engine() {
        engine.reload_config().await;
    }
    {
        let mut inner = server.lock();
        server.reenrich(&mut inner);
    }
    match server.settings_payload() {
        Ok(payload) => Answer::ok(200, &payload),
        Err(err) => Answer::refused(400, Field::Error, err),
    }
}

pub async fn reassign_request(server: &Server, body: Body) -> Answer {
    let written = {
        let mut inner = server.lock();
        write_reassign_request(server, &mut inner, body)
    };
    let outcome = match written {
        Ok(outcome) => outcome,
        Err(refused) => return refused,
    };
    if let Some(engine) = server.engine() {
        engine.reload_config().await;
    }
    let Some(snapshot) = server.reenrich(&mut server.lock()) else {
        return Answer::refused(500, Field::Error, "reassign: pool not started".to_owned());
    };
    Answer::ok(
        200,
        &json!({ "applied": outcome.applied, "skipped": outcome.skipped, "snapshot": &*snapshot }),
    )
}

fn write_reassign_request(
    server: &Server,
    inner: &mut Inner,
    body: Body,
) -> Result<ReassignOutcome, Answer> {
    let failed = |err: String| Answer::refused(500, Field::Error, err);
    let Some(raw) = server.last_raw() else {
        return Err(failed("reassign: pool not started".to_owned()));
    };
    let body = body.map_err(failed)?;
    if !body.is_object() {
        return Err(failed("reassign: body must be an object".to_owned()));
    }
    server.refresh_meta(inner, Some(&raw));
    let live = live_attempt_ids(&raw);
    let context = ReassignContext {
        markers: &inner.meta,
        harnesses: &server.0.harnesses,
        live_attempts: &live,
        statuses: &raw.state.tickets,
        engine_assignments: &raw.assignments,
    };
    let fields = match field_of(&body, "fields") {
        None | Some(Value::Null) => json!({}),
        Some(fields) => fields.clone(),
    };
    write_reassign(
        server.pool_dir(),
        field_of(&body, "tickets"),
        &fields,
        &context,
    )
    .map_err(|err| match err {
        ReassignError::Refusal(err) => Answer::refused(400, Field::Error, err),
        err => failed(err.message().to_owned()),
    })
}

/// The Machine defaults, written whole: a field left empty is the operator clearing it. The run is
/// woken, so a pool that sets no `maxLive` of its own launches under the new one at once.
pub async fn machine_settings_request(server: &Server, body: Body) -> Answer {
    let saved = (|| -> Result<(), String> {
        let body = body?;
        let Some(defaults @ Value::Object(_)) = field_of(&body, "defaults") else {
            return Err("settings: defaults must be an object".to_owned());
        };
        write_machine_defaults(defaults, &server.0.machine_paths.file)
            .map_err(|err| err.to_string())?;
        Ok(())
    })();
    if saved.is_ok()
        && let Some(engine) = server.engine()
    {
        engine.reload_config().await;
    }
    match saved.and_then(|()| server.settings_payload()) {
        Ok(payload) => Answer::ok(200, &payload),
        Err(err) => Answer::refused(400, Field::Error, err),
    }
}

fn library_refusal(err: LibraryError) -> Answer {
    let status = match err {
        LibraryError::BadSlug(_) | LibraryError::Invalid(_) => 400,
        LibraryError::PresetSlug(_) => 409,
        LibraryError::NotFound(_) => 404,
        LibraryError::Unreadable(_) => 422,
        LibraryError::Io(_) => 500,
    };
    Answer::refused(status, Field::Reason, err.to_string())
}

/// GET /api/plans: the Presets, then the Plan library.
pub fn plans_list_request(server: &Server) -> Answer {
    let plans = library::list(&server.0.home);
    Answer::ok(200, &PlansListResponse { plans })
}

/// GET /api/plans/<slug>: the Plan's file as it stands, with what is wrong with it.
pub fn plan_get_request(server: &Server, slug: &str) -> Answer {
    match library::get(&server.0.home, slug) {
        Ok(stored) => Answer::ok(
            200,
            &PlanResponse {
                slug: stored.slug,
                preset: stored.preset,
                plan: Unchecked::new(stored.file),
                problems: stored.problems,
            },
        ),
        Err(err) => library_refusal(err),
    }
}

/// POST /api/plans/validate: a draft Plan, checked whole.
pub fn plan_validate_request(body: Body) -> Answer {
    let checked = body.and_then(|body| {
        field_of(&body, "plan")
            .map(Plan::check)
            .ok_or_else(|| "plan is required".to_owned())
    });
    match checked {
        Ok(problems) => Answer::ok(200, &PlanValidateResponse { problems }),
        Err(err) => Answer::refused(400, Field::Reason, err),
    }
}

/// POST /api/plans/edit: typed edits on a draft, answered with the draft they make. Writes nothing. A
/// body that is not `{plan, edits}`, an edit that cannot be read or misses, or a draft the edits
/// would drop or rewrite is refused whole.
pub fn plan_edit_request(body: Body) -> Answer {
    let refused = |reason: String| Answer::refused(400, Field::Reason, reason);
    let request: PlanEditRequest = match plans_request(body) {
        Ok(request) => request,
        Err(err) => return refused(err),
    };
    let edited = PlanEdit::read_all(&request.edits)
        .and_then(|edits| Plan::edit_draft(&request.plan.value, &edits));
    match edited {
        Ok(edited) => Answer::ok(
            200,
            &PlanDraftResponse {
                plan: edited.file,
                problems: edited.problems,
                notes: edited.notes,
                verdicts: edited
                    .verdicts
                    .into_iter()
                    .map(|(id, verdicts)| PlanNodeVerdicts {
                        id,
                        verdicts: verdicts.iter().map(|v| v.as_str().to_owned()).collect(),
                    })
                    .collect(),
            },
        ),
        Err(problems) => {
            let messages: Vec<_> = problems.into_iter().map(|p| p.message).collect();
            refused(format!(
                "plans: the edits cannot be made: {}",
                messages.join("; ")
            ))
        }
    }
}

/// A Plan verb's body read as its request type.
fn plans_request<T: serde::de::DeserializeOwned>(body: Body) -> Result<T, String> {
    body.and_then(|body| serde_json::from_value(body).map_err(|err| format!("plans: {err}")))
}

/// POST /api/plans/boot: Boot, detached, for a new Line on a saved Plan. Every refusal comes before
/// anything is started: the work (400), then the Plan's load (404, 400, 422), then a server with no
/// way to start Boot (409), then a pool in no git checkout (409).
pub async fn plan_boot_request(server: &Server, body: Body) -> Answer {
    let refused = |status: u16, reason: String| Answer::refused(status, Field::Reason, reason);
    let request: PlanBootRequest = match plans_request(body) {
        Ok(request) => request,
        Err(err) => return refused(400, err),
    };
    let work = request.work.trim();
    if work.is_empty() {
        return refused(
            400,
            "plans: a Line needs its work: an issue number or what to build".to_owned(),
        );
    }
    if work.starts_with("--") {
        return refused(
            400,
            format!("plans: the work `{work}` starts with `--`, which Boot would read as a flag"),
        );
    }
    if let Err(err) = library::load(&server.0.home, &request.slug) {
        return library_refusal(err);
    }
    let Some(hand_off) = server.0.on_line_boot.clone() else {
        return refused(409, "plans: this server cannot start Boot".to_owned());
    };
    let boot = LineBoot {
        plan: request.slug,
        work: work.to_owned(),
    };
    match tokio::task::spawn_blocking(move || hand_off(&boot)).await {
        Ok(Ok(started)) => Answer::ok(200, &started),
        Ok(Err(LineBootRefusal::NoCheckout(reason))) => refused(409, reason),
        Ok(Err(LineBootRefusal::Launch(reason))) => refused(500, reason),
        Err(err) => refused(500, format!("plans: {err}")),
    }
}

/// PUT /api/plans/<slug>: `plan` is the Plan file, the HTTP body itself or the socket payload's field.
pub fn plan_save_request(server: &Server, slug: &str, plan: Body) -> Answer {
    let saved = match plan {
        Ok(plan) => library::save(&server.0.home, slug, &plan),
        Err(err) => return Answer::refused(400, Field::Reason, err),
    };
    match saved {
        Ok(plan) => Answer::ok(
            200,
            &PlanSaveResponse {
                slug: slug.to_owned(),
                plan: plan.to_file(),
            },
        ),
        Err(err) => library_refusal(err),
    }
}

/// DELETE /api/plans/<slug>.
pub fn plan_delete_request(server: &Server, slug: &str) -> Answer {
    match library::delete(&server.0.home, slug) {
        Ok(()) => Answer::ok_value(200, json!({})),
        Err(err) => library_refusal(err),
    }
}

/// POST /api/resume: acceptance only (ADR-0004). The engine records the answer and the caller gets the
/// snapshot after acceptance right away.
pub async fn resume_request(server: &Server, body: Body) -> Answer {
    let refused = |err: String| Answer::refused(400, Field::Error, err);
    let body = match body {
        Ok(body) => body,
        Err(err) => return refused(err),
    };
    if body.is_null() {
        return refused("null is not an object (evaluating 'body.ticketId')".to_owned());
    }
    let ticket_id = text_of(&body, "ticketId");
    // An absent action is a plain resume; an action the server does not know is a malformed request,
    // never quietly a resume.
    let action = match field_of(&body, "action") {
        None => ResumeAction::Resume,
        Some(value) => match value
            .as_str()
            .filter(|a| RESUME_ACTIONS.contains(a))
            .and_then(ResumeAction::parse)
        {
            Some(action) => action,
            None => {
                return refused(format!(
                    "unknown action {}: expected one of {}",
                    js::stringify(value),
                    RESUME_ACTIONS.join(", ")
                ));
            }
        },
    };
    let note = string_field(&body, "note");
    // The Candidate an Adopt takes (ADR-0035): a whole attempt number, or nothing.
    let attempt = match field_of(&body, "attempt") {
        None => None,
        Some(value) if js::is_integer(value) => {
            let number = js::number_of(value).unwrap_or(0.0);
            Some(if (0.0..=f64::from(u32::MAX)).contains(&number) {
                number as u32
            } else {
                u32::MAX
            })
        }
        Some(value) => {
            return refused(format!(
                "attempt must be a whole attempt number, got {}",
                js::stringify(value)
            ));
        }
    };
    if ticket_id.is_empty() {
        return refused("missing ticketId".to_owned());
    }
    let Some(engine) = server.engine() else {
        return refused("pool not started".to_owned());
    };
    if matches!(action, ResumeAction::Approve | ResumeAction::Reject) {
        // Only the run's review gate and a ticket's merge-approval take approve/reject. No pending
        // interrupt may be a retry of an answer already processed: the engine's store decides.
        let kind = server.snapshot().and_then(|snapshot| {
            snapshot
                .state
                .interrupts
                .iter()
                .find(|interrupt| interrupt.ticket_id == ticket_id)
                .map(|interrupt| interrupt.kind.as_str())
        });
        if let Some(kind) = kind
            && kind != "review"
            && kind != "merge-approval"
        {
            return refused(format!(
                "answer: approve/reject needs the review gate ({REVIEW_TICKET_ID}) or a merge-approval interrupt, got {kind} for {ticket_id}"
            ));
        }
    }
    if let Err(err) = engine.accept(ticket_id, note, action, attempt).await {
        return Answer::refused(
            engine_refusal_status(&err, 400),
            Field::Error,
            err.message(),
        );
    }
    let snapshot = server.snapshot();
    Answer::ok(202, &json!({ "snapshot": snapshot.as_deref() }))
}

/// Start a Conversation (issue #60). A Steward (ADR-0030) is a Conversation in a role, its title may
/// be left blank. Every refusal the engine gives is a 409: the request was well-formed, the pool just
/// cannot host it now.
pub async fn start_conversation_request(server: &Server, body: Body) -> Answer {
    let Ok(body) = body else {
        return Answer::refused(400, Field::Reason, "invalid JSON body");
    };
    let fields = or_empty(body);
    let role = match field_of(&fields, "role") {
        None => None,
        Some(Value::String(role)) if role == "steward" => Some(ConversationRole::Steward),
        Some(Value::String(role)) if role == "grill" => Some(ConversationRole::Grill),
        Some(_) => {
            return Answer::refused(
                400,
                Field::Reason,
                r#"role must be "steward" or "grill" when given"#,
            );
        }
    };
    let given = text_of(&fields, "title");
    let title = match js::trim(&given) {
        "" if role == Some(ConversationRole::Steward) => "Steward".to_owned(),
        "" if role == Some(ConversationRole::Grill) => "Grill".to_owned(),
        trimmed => trimmed.to_owned(),
    };
    if title.is_empty() {
        return Answer::refused(400, Field::Reason, "title is required");
    }
    let assign = field_of(&fields, "assign")
        .filter(|assign| assign.is_object() || assign.is_array())
        .map(|assign| ConversationAssign {
            harness: string_field(assign, "harness"),
            model: string_field(assign, "model"),
            effort: string_field(assign, "effort"),
            drivers: string_field(assign, "drivers"),
        });
    let request = StartConversationRequest {
        title,
        opening: string_field(&fields, "opening"),
        role,
        assign,
        spawned_by: None,
        id: None,
    };
    let Some(engine) = server.engine() else {
        return Answer::refused(409, Field::Reason, "pool not started");
    };
    match engine.start_conversation(request).await {
        Ok(conversation) => Answer::ok(201, &json!({ "conversation": conversation })),
        Err(err) => Answer::refused(409, Field::Reason, err.message()),
    }
}

/// End a Conversation (issue #60): 404 when there is no live Conversation with that id, 409 otherwise.
pub async fn end_conversation_request(server: &Server, body: Body) -> Answer {
    let Ok(body) = body else {
        return Answer::refused(400, Field::Reason, "invalid JSON body");
    };
    let fields = or_empty(body);
    let id = text_of(&fields, "id");
    if id.is_empty() {
        return Answer::refused(400, Field::Reason, "id is required");
    }
    let closing = string_field(&fields, "closing");
    let ended = match server.engine() {
        None => Err("pool not started".to_owned()),
        Some(engine) => engine
            .end_conversation(id, closing)
            .await
            .map_err(|err| err.message().to_owned()),
    };
    if let Err(message) = ended {
        let status = if message.contains("no live conversation") {
            404
        } else {
            409
        };
        return Answer::refused(status, Field::Reason, message);
    }
    let mut inner = server.lock();
    server.refresh_meta(&mut inner, None);
    let snapshot = server.current(&mut inner);
    Answer::ok(202, &json!({ "snapshot": snapshot.as_deref() }))
}

/// Enlist a live herdr pane as a Ticket, a Conversation or the Steward (issue #101). `becomes` is fixed
/// at enlist time and never defaulted.
pub async fn enlist_request(server: &Server, body: Body) -> Answer {
    let Ok(body) = body else {
        return Answer::refused(400, Field::Reason, "invalid JSON body");
    };
    let fields = or_empty(body);
    let pane_id = text_of(&fields, "paneId");
    if pane_id.is_empty() {
        return Answer::refused(400, Field::Reason, "paneId is required");
    }
    let title = text_of(&fields, "title");
    let becomes = field_of(&fields, "becomes").and_then(Value::as_str);
    let request = match becomes {
        Some("conversation") => EnlistRequest::Conversation(EnlistConversationWireRequest {
            becomes: BecomesConversation::Conversation,
            pane_id,
            title,
            opening: string_field(&fields, "opening"),
        }),
        Some("steward") => EnlistRequest::Steward(EnlistStewardWireRequest {
            becomes: BecomesSteward::Steward,
            pane_id,
            title: Some(title),
            opening: string_field(&fields, "opening"),
        }),
        Some("ticket") => EnlistRequest::Ticket(EnlistTicketRequest {
            becomes: BecomesTicket::Ticket,
            pane_id,
            title,
            spec: text_of(&fields, "spec"),
            blocks: field_of(&fields, "blocks")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                }),
        }),
        _ => {
            return Answer::refused(
                400,
                Field::Reason,
                r#"becomes must be "ticket", "conversation" or "steward""#,
            );
        }
    };
    let Some(engine) = server.engine() else {
        return Answer::refused(409, Field::Reason, "pool not started");
    };
    match engine.enlist(request).await {
        Ok(response) => Answer::ok(201, &response),
        Err(err) => Answer::refused(409, Field::Reason, err.message()),
    }
}

/// POST /api/line (ADR-0039), sent once by Boot: `plan` is a Preset or library slug or a Plan file,
/// with exactly one of `work` or `brief` (a Line brief's path in the pool checkout). 202 with the
/// Line; an unknown slug, an invalid or not-yet-runnable Plan, a bad brief or a second Line is the
/// 409 `reason` envelope.
pub async fn begin_line_request(server: &Server, body: Body) -> Answer {
    let Ok(body) = body else {
        return Answer::refused(400, Field::Reason, "invalid JSON body");
    };
    let body = or_empty(body);
    let text = |key: &str| match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if !js::trim(text).is_empty() => Ok(Some(text.clone())),
        Some(_) => Err(format!("{key} must be a non-empty string")),
    };
    let begin = match (text("work"), text("brief")) {
        (Err(why), _) | (_, Err(why)) => return Answer::refused(400, Field::Reason, why),
        (Ok(Some(work)), Ok(None)) => ac_engine::line::Begin::Work(work),
        (Ok(None), Ok(Some(brief))) => ac_engine::line::Begin::Brief(js::trim(&brief).to_owned()),
        _ => return Answer::refused(400, Field::Reason, "give exactly one of work or brief"),
    };
    let plan = match body.get("plan") {
        Some(Value::String(slug)) => match library::get(&server.0.home, slug) {
            Ok(stored) => stored.file,
            Err(err) => return library_refusal(err),
        },
        Some(plan @ Value::Object(_)) => plan.clone(),
        _ => {
            return Answer::refused(
                400,
                Field::Reason,
                "plan is required: a Plan's slug or its file",
            );
        }
    };
    let Some(engine) = server.engine() else {
        return Answer::refused(409, Field::Reason, "pool not started");
    };
    match engine.begin_line(plan, begin).await {
        Ok(line) => Answer::ok(202, &LineResponse { line: Some(line) }),
        Err(err) => Answer::refused(409, Field::Reason, err.message()),
    }
}

/// POST /api/line/start {grill} (the bridge until Conversation nodes, ADR-0039): Start the Line on the
/// Grill, which checks the brief on the Grill's branch, merges that branch and ends the Grill. An
/// operator route: the Steward's routes have no such verb. 202 with the Line; a missing or invalid
/// brief, no Conversation pass waiting, or a Grill that is not one is the 409 `reason` envelope.
pub async fn start_line_request(server: &Server, body: Body) -> Answer {
    let Ok(body) = body else {
        return Answer::refused(400, Field::Reason, "invalid JSON body");
    };
    let grill = match or_empty(body).get("grill") {
        Some(Value::String(id)) if !js::trim(id).is_empty() => js::trim(id).to_owned(),
        _ => return Answer::refused(400, Field::Reason, "grill must be a Conversation id"),
    };
    let Some(engine) = server.engine() else {
        return Answer::refused(409, Field::Reason, "pool not started");
    };
    match engine.start_line_from_grill(grill).await {
        Ok(line) => Answer::ok(202, &LineResponse { line: Some(line) }),
        Err(err) => Answer::refused(409, Field::Reason, err.message()),
    }
}

/// GET /api/line: the pool's Line as the engine runs it, null in a pool that runs none.
pub async fn line_request(server: &Server) -> Answer {
    let Some(engine) = server.engine() else {
        return Answer::ok(200, &LineResponse { line: None });
    };
    match engine.line_view().await {
        Ok(line) => Answer::ok(200, &LineResponse { line }),
        Err(err) => Answer::refused(500, Field::Reason, err.message()),
    }
}

/// GET /api/line/report?node=&pass=: the report that Decide pass wrote (ADR-0037), as the HTML it is,
/// for the Finish hold's Detail and Open in browser. 404 with the `reason` envelope when the pool's
/// Line has no such node or the pass has written none.
pub async fn line_report(server: &Server, node: &str, pass: &str) -> Result<Vec<u8>, Answer> {
    let not_found = |why: String| Answer::refused(404, Field::Reason, why);
    let Ok(pass) = pass.parse::<u32>() else {
        return Err(Answer::refused(
            400,
            Field::Reason,
            "pass must be a pass number",
        ));
    };
    let Some(engine) = server.engine() else {
        return Err(not_found("the pool runs no Line".into()));
    };
    let path = match engine.line_report_path(node.to_owned(), pass).await {
        Ok(Ok(path)) => path,
        Ok(Err(why)) => return Err(not_found(why)),
        Err(err) => return Err(Answer::refused(500, Field::Reason, err.message())),
    };
    std::fs::read(&path).map_err(|_| {
        not_found(format!(
            "no report yet: {node} pass {pass} has written none"
        ))
    })
}

/// Keep talking (issue #139): continue a ticket's checkpointed Attempt in its Held pane. Never queued,
/// so it answers once the pane is claimed.
pub async fn keep_talking_request(server: &Server, body: Body) -> Answer {
    let Ok(body) = body else {
        return Answer::refused(400, Field::Reason, "invalid JSON body");
    };
    let ticket_id = text_of(&or_empty(body), "ticketId");
    if ticket_id.is_empty() {
        return Answer::refused(400, Field::Reason, "ticketId is required");
    }
    let Some(engine) = server.engine() else {
        return Answer::refused(409, Field::Reason, "pool not started");
    };
    match engine.keep_talking(ticket_id.clone()).await {
        Ok(attempt) => Answer::ok(202, &json!({ "ticketId": ticket_id, "attempt": attempt })),
        Err(err) => Answer::refused(409, Field::Reason, err.message()),
    }
}

/// Close every Finished terminal (issue #139).
pub async fn close_finished_request(server: &Server) -> Answer {
    let Some(engine) = server.engine() else {
        return Answer::refused(409, Field::Reason, "pool not started");
    };
    match engine.close_finished_terminals().await {
        Ok(closed) => Answer::ok(200, &json!({ "closed": closed })),
        Err(err) => Answer::refused(409, Field::Reason, err.message()),
    }
}

/// Adopt or Discard a Held spawn (issue #149, ADR-0029).
pub async fn spawn_request(server: &Server, kind: RequestKind, body: Body) -> Answer {
    let Ok(body) = body else {
        return Answer::refused(400, Field::Reason, "invalid JSON body");
    };
    let id = text_of(&or_empty(body), "id");
    if id.is_empty() {
        return Answer::refused(400, Field::Reason, "id is required");
    }
    let Some(engine) = server.engine() else {
        return Answer::refused(409, Field::Reason, "pool not started");
    };
    let (done, status) = match kind {
        RequestKind::SpawnsHeldAdopt => (engine.adopt_held_spawn(id.clone()).await, 202),
        _ => (engine.discard_held_spawn(id.clone()).await, 200),
    };
    match done {
        Ok(()) => Answer::ok(status, &json!({ "id": id })),
        Err(err) => Answer::refused(409, Field::Reason, err.message()),
    }
}

// ---------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------

/// Where a log read starts: a byte offset (a JavaScript number), or the file's last window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LogOffset {
    At(f64),
    Tail,
}

/// GET /api/log's query.
#[derive(Debug, Clone, PartialEq)]
pub struct LogQuery {
    pub id: String,
    pub attempt: Option<f64>,
    pub offset: LogOffset,
    pub end: Option<f64>,
    pub stream: bool,
}

/// A log read that answered: the range, and the ticket's attempt list.
pub struct LogRead {
    pub range: LogRange,
    pub attempts: Vec<LogAttemptInfo>,
}

/// One byte range of an attempt's log, the derived one or (`stream`) its Stream file. A Conversation id
/// works unchanged. `attempt` absent is the latest.
pub fn log_read(server: &Server, inner: &mut Inner, query: LogQuery) -> Result<LogRead, Answer> {
    server.refresh_meta(inner, None);
    if !inner.ticket_ids.contains(&query.id) && !inner.conversation_ids.contains(&query.id) {
        return Err(Answer::refused(
            404,
            Field::Error,
            format!("unknown ticket {}", query.id),
        ));
    }
    let attempts = reads_attempts(server, &query.id);
    let attempt = query
        .attempt
        .unwrap_or_else(|| attempts.last().map_or(0.0, |row| row.attempt as f64));
    let info = attempts.iter().find(|row| row.attempt as f64 == attempt);
    let file = info.and_then(|info| {
        if query.stream {
            info.stream_file.clone()
        } else {
            Some(info.log_file.clone())
        }
    });
    let Some(file) = file else {
        let attempt = js::number_string(attempt);
        return Err(Answer::refused(
            404,
            Field::Error,
            match info {
                Some(_) => format!("no stream file for attempt {attempt} of {}", query.id),
                None => format!("unknown attempt {attempt} for {}", query.id),
            },
        ));
    };
    let path = server.0.runs_dir.join(file);
    let offset = match query.offset {
        LogOffset::Tail => reads::log_tail_offset(&path),
        LogOffset::At(offset) => offset,
    };
    let range = reads::read_log_range(&path, offset, query.end).map_err(Answer::Thrown)?;
    Ok(LogRead { range, attempts })
}

fn reads_attempts(server: &Server, id: &str) -> Vec<LogAttemptInfo> {
    ac_core::streamlog::list_attempt_logs(&server.0.runs_dir, id)
}

/// GET /api/log's answer: the range's fields, then the attempt list.
pub fn log_request(server: &Server, inner: &mut Inner, query: LogQuery) -> Answer {
    match log_read(server, inner, query) {
        Ok(read) => {
            let mut result = read.range.fields();
            result.insert(
                "attempts".into(),
                serde_json::to_value(&read.attempts).unwrap_or(Value::Null),
            );
            Answer::ok_value(200, Value::Object(result))
        }
        Err(refusal) => refusal,
    }
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// A run of the pool log (issue #161): up to `limit` lines ending before line `before` of the whole log,
/// of which the snapshot carries only the last POOL_LOG_WINDOW lines.
pub fn pool_log_request(
    server: &Server,
    inner: &mut Inner,
    before: f64,
    limit: Option<f64>,
) -> Answer {
    if !is_safe_integer(before) || before < 0.0 {
        return Answer::refused(400, Field::Error, "before must be a line number");
    }
    if limit.is_some_and(|limit| !is_safe_integer(limit) || limit < 1.0) {
        return Answer::refused(400, Field::Error, "limit must be a positive whole number");
    }
    let snapshot = server.current(inner);
    let log: &[String] = snapshot.as_ref().map_or(&[], |s| s.state.log.as_slice());
    let end = (before as usize).min(log.len());
    let window = limit.map_or(POOL_LOG_WINDOW, |limit| {
        limit.min(usize::MAX as f64) as usize
    });
    let start = end.saturating_sub(window.min(POOL_LOG_MAX_LINES));
    Answer::ok(
        200,
        &json!({ "start": start, "lines": &log[start..end], "total": log.len() }),
    )
}

/// The id (a ticket's or a Conversation's) to pane translation, from the last snapshot alone: a
/// ticket's Live attempt pane, its Held pane, or a Conversation's. Every no-pane case is one shape.
fn terminal_pane(server: &Server, ticket_id: &str) -> Result<String, Answer> {
    let snapshot = server.snapshot();
    let pane = snapshot.as_ref().and_then(|snapshot| {
        let ticket = snapshot.state.tickets.iter().find(|t| t.id == ticket_id);
        ticket
            .and_then(|t| {
                t.live_attempt
                    .as_ref()
                    .and_then(|live| live.pane_id.clone())
            })
            .or_else(|| ticket.and_then(|t| t.held_pane.as_ref().map(|held| held.pane_id.clone())))
            .or_else(|| {
                snapshot
                    .state
                    .conversations
                    .iter()
                    .find(|c| c.id == ticket_id)
                    .and_then(|c| c.pane_id.clone())
            })
    });
    match pane.filter(|pane| !pane.is_empty()) {
        Some(pane) => Ok(pane),
        None => Err(Answer::refused(
            404,
            Field::Error,
            format!("no terminal-backed pane for ticket {ticket_id}"),
        )),
    }
}

/// The card's Peek: the engine's own last read of a pane one of its loops watches (issue #122), else a
/// live read of the viewport only. A daemon failure is a 502.
pub async fn peek_request(server: &Server, ticket_id: &str) -> Answer {
    let pane = match terminal_pane(server, ticket_id) {
        Ok(pane) => pane,
        Err(refusal) => return refusal,
    };
    let recorded = match server.engine() {
        Some(engine) => engine.pane_read(pane.clone()).await,
        None => None,
    };
    let text = match recorded {
        Some(read) => read.text,
        None => match server
            .0
            .herdr
            .peek_pane(&pane, PaneReadSource::Visible)
            .await
        {
            Ok(text) => text,
            Err(err) => return Answer::refused(502, Field::Error, err.message()),
        },
    };
    Answer::ok(
        200,
        &json!({ "ticket": ticket_id, "paneId": pane, "text": text }),
    )
}

/// "Open in herdr": focus the attempt's pane.
pub async fn focus_request(server: &Server, ticket_id: &str) -> Answer {
    let pane = match terminal_pane(server, ticket_id) {
        Ok(pane) => pane,
        Err(refusal) => return refusal,
    };
    match server.0.herdr.focus_pane(&pane).await {
        Ok(()) => Answer::ok(200, &json!({ "ok": true, "paneId": pane })),
        Err(err) => Answer::refused(502, Field::Error, err.message()),
    }
}

/// Enlist discovery (issue #101): the live herdr panes with the engine's verdict beside each. Only a
/// terminal-backed pool has panes to offer.
pub async fn panes_request(server: &Server) -> Answer {
    match read_config(server.pool_dir()) {
        Err(err) => return Answer::Thrown(err.to_string()),
        Ok(config) if config.terminal_text() != Some("herdr") => {
            return Answer::refused(
                409,
                Field::Reason,
                r#"enlist requires a terminal-backed pool (set console.json "terminal": "herdr")"#,
            );
        }
        Ok(_) => {}
    }
    let mut registered = HashSet::new();
    if let Some(snapshot) = server.snapshot() {
        for ticket in &snapshot.state.tickets {
            let pane = ticket
                .live_attempt
                .as_ref()
                .and_then(|live| live.pane_id.clone())
                .or_else(|| ticket.held_pane.as_ref().map(|held| held.pane_id.clone()));
            if let Some(pane) = pane.filter(|pane| !pane.is_empty()) {
                registered.insert(pane);
            }
        }
        for conversation in &snapshot.state.conversations {
            if let Some(pane) = conversation.pane_id.clone().filter(|pane| !pane.is_empty()) {
                registered.insert(pane);
            }
        }
    }
    let pool_dir = std::path::PathBuf::from(server.pool_dir());
    match list_enlist_panes(&server.0.herdr, &pool_dir, &registered).await {
        Ok(panes) => Answer::ok(200, &panes),
        Err(err) => Answer::refused(502, Field::Error, err.message()),
    }
}

// ---------------------------------------------------------------------------------------------------
// The socket's side of every request but `log.follow`
// ---------------------------------------------------------------------------------------------------

fn numeric(payload: &Map<String, Value>, key: &str) -> Option<f64> {
    payload
        .get(key)
        .filter(|v| v.is_number())
        .and_then(js::number_of)
}

/// A socket request, run by the function its HTTP twin runs: the payload is the twin's body, or its
/// query as fields, and the result is the route's response less any snapshot it carries.
pub async fn socket_request(
    server: &Server,
    kind: RequestKind,
    payload: Map<String, Value>,
) -> Answer {
    let field = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let body = || Ok(Value::Object(payload.clone()));
    match kind {
        RequestKind::Start => start_request(server).await.without_snapshot(),
        RequestKind::Resume => resume_request(server, body()).await.without_snapshot(),
        RequestKind::Stop => {
            let mut inner = server.lock();
            stop_request(server, &mut inner)
        }
        RequestKind::Restart => {
            let mut inner = server.lock();
            restart_request(server, &mut inner)
        }
        RequestKind::KeepTalking => keep_talking_request(server, body()).await,
        RequestKind::TerminalFocus => focus_request(server, &field("ticketId")).await,
        RequestKind::TerminalsCloseFinished => close_finished_request(server).await,
        RequestKind::Enlist => enlist_request(server, body()).await,
        RequestKind::Reassign => reassign_request(server, body()).await.without_snapshot(),
        RequestKind::SpawnsHeldAdopt | RequestKind::SpawnsHeldDiscard => {
            spawn_request(server, kind, body()).await
        }
        RequestKind::ConversationsStart => start_conversation_request(server, body()).await,
        RequestKind::ConversationsEnd => end_conversation_request(server, body())
            .await
            .without_snapshot(),
        RequestKind::SettingsGet => settings_request(server),
        RequestKind::SettingsPoolPut => pool_settings_request(server, body()).await,
        RequestKind::SettingsMachinePut => machine_settings_request(server, body()).await,
        RequestKind::PanesList => panes_request(server).await,
        RequestKind::PlansList => plans_list_request(server),
        RequestKind::PlansGet => plan_get_request(server, &field("slug")),
        RequestKind::PlansValidate => plan_validate_request(body()),
        RequestKind::PlansSave => plan_save_request(
            server,
            &field("slug"),
            payload
                .get("plan")
                .cloned()
                .ok_or_else(|| "plan is required".to_owned()),
        ),
        RequestKind::PlansDelete => plan_delete_request(server, &field("slug")),
        RequestKind::PlansEdit => plan_edit_request(body()),
        RequestKind::PlansBoot => plan_boot_request(server, body()).await,
        RequestKind::LogRead => {
            let mut inner = server.lock();
            log_request(
                server,
                &mut inner,
                LogQuery {
                    id: field("id"),
                    attempt: numeric(&payload, "attempt"),
                    offset: LogOffset::At(numeric(&payload, "offset").unwrap_or(0.0)),
                    end: numeric(&payload, "end"),
                    stream: payload.get("stream") == Some(&Value::Bool(true)),
                },
            )
        }
        RequestKind::PoolLogRead => {
            let mut inner = server.lock();
            pool_log_request(
                server,
                &mut inner,
                numeric(&payload, "before").unwrap_or(f64::NAN),
                numeric(&payload, "limit"),
            )
        }
        // The hub answers `log.follow` itself, since it moves the socket's own subscription.
        RequestKind::LogFollow => Answer::Thrown("log.follow is the socket's own".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_body_as_bun_does() {
        assert_eq!(
            parse_body(b""),
            Err("Unexpected end of JSON input".to_owned())
        );
        assert_eq!(parse_body(b"{nope"), Err("Failed to parse JSON".to_owned()));
        assert_eq!(parse_body(b"null"), Ok(Value::Null));
    }

    #[test]
    fn drops_only_the_snapshot_from_a_result() {
        let answer = Answer::ok_value(200, json!({ "applied": [], "snapshot": {}, "skipped": [] }));
        assert_eq!(
            answer.without_snapshot(),
            Answer::ok_value(200, json!({ "applied": [], "skipped": [] }))
        );
    }

    struct Unencodable;

    impl Serialize for Unencodable {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("a circular reference"))
        }
    }

    #[test]
    fn keeps_a_result_it_cannot_encode_as_the_error() {
        assert_eq!(
            Answer::ok(200, &Unencodable),
            Answer::Ok {
                status: 200,
                result: Err("a circular reference".to_owned())
            }
        );
    }
}
