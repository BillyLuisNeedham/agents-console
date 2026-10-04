//! The HTTP side (server.ts `fetch`): one handler that matches the path and method exactly as the
//! TypeScript does, in the same order, and answers each route's function the way that route always has.
//! The socket at `/api/ws` is upgraded here and served by the hub.

use axum::Router;
use axum::body::Body as HttpBody;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use ac_core::js;
use ac_engine::EngineError;
use ac_protocol::{RequestKind, StewardAnswerAction, WS_PATH};

use crate::hub::{self, CLIENT_FRAME_MAX_BYTES};
use crate::reads;
use crate::reassign::{ReassignContext, ReassignError, write_reassign};
use crate::routes::{self, Answer, Body, LogOffset, LogQuery};
use crate::server::{Server, live_attempt_ids};
use crate::ui;

/// The largest request body read (Bun's default).
const BODY_MAX_BYTES: usize = 128 * 1024 * 1024;

/// The server's router: every path goes through [`fetch`].
pub fn router(server: Server) -> Router {
    Router::new().fallback(fetch).with_state(server)
}

fn json_response(status: u16, value: &Value) -> Response {
    let mut response = (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        js::to_json(value),
    )
        .into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json;charset=utf-8"),
    );
    response
}

fn text_response(status: u16, text: &str) -> Response {
    let mut response = (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        text.to_owned(),
    )
        .into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain;charset=utf-8"),
    );
    response
}

// A throw that escaped a route: the runtime's own 500.
fn uncaught(message: &str) -> Response {
    eprintln!("{message}");
    text_response(500, "Something went wrong!")
}

/// A request's answer as its HTTP route has always sent it.
fn http_of(answer: Answer) -> Response {
    match answer {
        Answer::Ok {
            status,
            result: Ok(result),
        } => json_response(status, &result),
        Answer::Ok {
            result: Err(err), ..
        }
        | Answer::Thrown(err) => uncaught(&err),
        Answer::Refused {
            status,
            field,
            reason,
        } => json_response(status, &json!({ field.key(): reason })),
    }
}

/// `URLSearchParams.get`: the first value under the name, `+` as a space, percent-decoding with a
/// malformed sequence kept as written and invalid UTF-8 replaced.
pub fn query_param(query: &str, name: &str) -> Option<String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (decode_component(key), decode_component(value)),
            None => (decode_component(pair), String::new()),
        })
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

fn decode_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    js::decode_utf8(&out)
}

/// Whether an Origin header names the host the request came to. One that does not parse (a sandboxed
/// page's "null") names no host of ours.
pub fn same_origin(origin: &str, host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if authority.is_empty() {
        return false;
    }
    let mut origin_host = authority.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" | "ws" => Some(":80"),
        "https" | "wss" => Some(":443"),
        _ => None,
    };
    if let Some(port) = default_port
        && origin_host.ends_with(port)
    {
        origin_host.truncate(origin_host.len() - port.len());
    }
    origin_host == host
}

async fn read_body(body: HttpBody) -> Body {
    match axum::body::to_bytes(body, BODY_MAX_BYTES).await {
        Ok(bytes) => routes::parse_body(&bytes),
        Err(err) => Err(err.to_string()),
    }
}

async fn fetch(State(server): State<Server>, request: Request) -> Response {
    let (mut parts, body) = request.into_parts();
    let path = parts.uri.path().to_owned();
    let query = parts.uri.query().unwrap_or("").to_owned();
    let param = |name: &str| query_param(&query, name);
    let method = parts.method.clone();
    let post = method == Method::POST;

    // The Console's one socket (issue #161). Only the Console's own page may open it; a client that
    // names no page (a script, the bench) is let through, as the HTTP routes let it through.
    if path == WS_PATH {
        let origin = parts
            .headers
            .get(header::ORIGIN)
            .map(|v| v.to_str().unwrap_or("\u{0}"));
        let host = parts
            .headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok());
        if let Some(origin) = origin
            && !same_origin(origin, host)
        {
            return text_response(403, "cross-origin socket refused");
        }
        return match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(upgrade) => upgrade
                .max_message_size(CLIENT_FRAME_MAX_BYTES)
                .max_frame_size(CLIENT_FRAME_MAX_BYTES)
                .on_upgrade(move |socket| hub::serve_socket(server, socket)),
            Err(_) => text_response(400, "expected a WebSocket upgrade"),
        };
    }

    match (path.as_str(), &method) {
        ("/api/state", _) => {
            let snapshot = server.snapshot();
            return json_response(200, &json!({ "snapshot": snapshot.as_deref() }));
        }
        ("/api/start", _) if post => return http_of(routes::start_request(&server).await),
        ("/api/stop", _) if post => {
            let mut inner = server.lock();
            return http_of(routes::stop_request(&server, &mut inner));
        }
        ("/api/restart", _) if post => {
            let mut inner = server.lock();
            return http_of(routes::restart_request(&server, &mut inner));
        }
        ("/api/settings", &Method::GET) => return http_of(routes::settings_request(&server)),
        ("/api/settings/pool", &Method::PUT) => {
            let body = read_body(body).await;
            return http_of(routes::pool_settings_request(&server, body).await);
        }
        ("/api/reassign", &Method::PUT) => {
            let body = read_body(body).await;
            let mut inner = server.lock();
            return http_of(routes::reassign_request(&server, &mut inner, body));
        }
        ("/api/settings/machine", &Method::PUT) => {
            let body = read_body(body).await;
            return http_of(routes::machine_settings_request(&server, body));
        }
        ("/api/resume", _) if post => {
            let body = read_body(body).await;
            return http_of(routes::resume_request(&server, body).await);
        }
        ("/api/events", _) => {
            let ticket = param("ticket").unwrap_or_default();
            let mut inner = server.lock();
            server.refresh_meta(&mut inner, None);
            // A Conversation id is accepted too: its events ride the same file a ticket's do.
            if !inner.ticket_ids.contains(&ticket) && !inner.conversation_ids.contains(&ticket) {
                return json_response(404, &json!({ "error": format!("unknown ticket {ticket}") }));
            }
            let events = reads::ticket_events(&server.0.runs_dir, &ticket, &inner.meta);
            return json_response(200, &events);
        }
        ("/api/grades", _) => {
            let mut inner = server.lock();
            server.refresh_meta(&mut inner, None);
            let grades = server.pool_grades(&mut inner);
            return json_response(200, &json!({ "grades": grades }));
        }
        ("/api/log", _) => {
            // An empty parameter is an absent one.
            let given = |name: &str| param(name).filter(|value| !value.is_empty());
            let query = LogQuery {
                id: param("ticket").unwrap_or_default(),
                attempt: given("attempt").map(|v| js::number_from_text(&v)),
                offset: LogOffset::At(given("offset").map_or(0.0, |v| js::number_from_text(&v))),
                end: given("end").map(|v| js::number_from_text(&v)),
                stream: param("stream").as_deref() == Some("1"),
            };
            let mut inner = server.lock();
            return http_of(routes::log_request(&server, &mut inner, query));
        }
        // The pool log's earlier lines (issue #161): `poolLog.read`'s twin.
        ("/api/pool-log", _) => {
            let before = param("before").map_or(f64::NAN, |v| js::number_from_text(&v));
            let limit = param("limit").map(|v| js::number_from_text(&v));
            let mut inner = server.lock();
            return http_of(routes::pool_log_request(&server, &mut inner, before, limit));
        }
        ("/api/conversations", _) if post => {
            let body = read_body(body).await;
            return http_of(routes::start_conversation_request(&server, body).await);
        }
        ("/api/enlist", _) if post => {
            let body = read_body(body).await;
            return http_of(routes::enlist_request(&server, body).await);
        }
        ("/api/keep-talking", _) if post => {
            let body = read_body(body).await;
            return http_of(routes::keep_talking_request(&server, body).await);
        }
        ("/api/terminals/close-finished", _) if post => {
            return http_of(routes::close_finished_request(&server).await);
        }
        ("/api/spawns/held/adopt", _) if post => {
            let body = read_body(body).await;
            return http_of(
                routes::spawn_request(&server, RequestKind::SpawnsHeldAdopt, body).await,
            );
        }
        ("/api/spawns/held/discard", _) if post => {
            let body = read_body(body).await;
            return http_of(
                routes::spawn_request(&server, RequestKind::SpawnsHeldDiscard, body).await,
            );
        }
        ("/api/spawns/pending/hold", _) if post => {
            let body = read_body(body).await;
            return http_of(
                routes::spawn_request(&server, RequestKind::SpawnsPendingHold, body).await,
            );
        }
        ("/api/spawns/pending/discard", _) if post => {
            let body = read_body(body).await;
            return http_of(
                routes::spawn_request(&server, RequestKind::SpawnsPendingDiscard, body).await,
            );
        }
        _ => {}
    }

    if path.starts_with("/api/steward/") {
        return steward_route(&server, &path, &method, &query, body).await;
    }

    match (path.as_str(), &method) {
        ("/api/conversations/end", _) if post => {
            let body = read_body(body).await;
            return http_of(routes::end_conversation_request(&server, body).await);
        }
        ("/api/activity", _) => {
            let ticket = param("ticket").unwrap_or_default();
            // The ids as of the engine's last emit.
            let known = {
                let mut inner = server.lock();
                server.current(&mut inner);
                inner.ticket_ids.contains(&ticket)
            };
            if !known {
                return json_response(404, &json!({ "error": format!("unknown ticket {ticket}") }));
            }
            return json_response(200, &server.activity(&ticket).await);
        }
        ("/api/terminal/peek", _) => {
            let ticket = param("ticket").unwrap_or_default();
            return http_of(routes::peek_request(&server, &ticket).await);
        }
        ("/api/terminal/focus", _) if post => {
            let ticket = param("ticket").unwrap_or_default();
            return http_of(routes::focus_request(&server, &ticket).await);
        }
        ("/api/panes", _) => return http_of(routes::panes_request(&server).await),
        ("/api/ticket", _) => {
            let id = param("id").unwrap_or_default();
            return match reads::ticket_body(&server.0.issues_dir, &id) {
                Ok(Some(ticket)) => json_response(200, &json!(ticket)),
                Ok(None) => json_response(404, &json!({ "error": "not found" })),
                Err(err) => uncaught(&err),
            };
        }
        _ => {}
    }

    // The page, with the first snapshot in it (issue #161).
    if path == "/" || path == "/index.html" {
        let page = {
            let mut inner = server.lock();
            hub::page(&server, &mut inner)
        };
        if let Some(page) = page {
            let mut response = (StatusCode::OK, page).into_response();
            let headers = response.headers_mut();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            return response;
        }
    }
    let file_path = if path == "/" {
        "/index.html"
    } else {
        path.as_str()
    };
    match server.0.ui.file(file_path) {
        Some(file) => {
            let mut response = (StatusCode::OK, file.bytes.into_owned()).into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(ui::content_type(file_path)),
            );
            response
        }
        // Bun answers a path no route and no file matches with its own 500 page: its `serveStatic` tests
        // the Promise `Bun.file().exists()` returns, which is always truthy, so the read of the missing file
        // fails. The intended 404 waits on the TypeScript fix (NOT-PORTED.md, "Unknown paths answer 500").
        None => text_response(500, "Internal Server Error"),
    }
}

fn steward_refusal(status: u16, reason: impl Into<String>) -> Response {
    json_response(status, &json!({ "reason": reason.into() }))
}

fn steward_done(message: String, status: u16) -> Response {
    json_response(status, &json!({ "ok": true, "message": message }))
}

// A refusal of the Steward's is a 409; a file this server cannot read is its own failure, a 500.
fn engine_refused(err: EngineError) -> Response {
    let status = if matches!(err, EngineError::ConfigUnreadable(_)) {
        500
    } else {
        409
    };
    steward_refusal(status, err.message())
}

/// The Steward's command (ADR-0030, steward-cli.ts): its answers, Keep talks, leaves, Held spawn
/// decisions, Reassigns, state read and its own End, each naming its Conversation id, which the engine
/// checks against the live Steward. A refusal is the 409 `reason` envelope.
async fn steward_route(
    server: &Server,
    path: &str,
    method: &Method,
    query: &str,
    body: HttpBody,
) -> Response {
    let Some(engine) = server.engine() else {
        return steward_refusal(409, "pool not started");
    };
    if path == "/api/steward/state" && method == Method::GET {
        let conversation = query_param(query, "conversation").unwrap_or_default();
        return match engine.steward_state(conversation).await {
            Ok(state) => json_response(200, &json!(state)),
            Err(err) => steward_refusal(409, err.message()),
        };
    }
    if method != Method::POST {
        return steward_refusal(404, format!("no steward route {path}"));
    }
    let body = match read_body(body).await {
        Ok(Value::Null) => json!({}),
        Ok(body) => body,
        Err(_) => return steward_refusal(400, "invalid JSON body"),
    };
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let conversation = text("conversation");
    if conversation.is_empty() {
        return steward_refusal(400, "conversation is required");
    }
    let ticket_id = text("ticketId");
    match path {
        "/api/steward/answer" => {
            let action = text("action");
            // Adopting a Candidate is the operator's alone (ADR-0035).
            if action == "adopt" {
                let ticket = if ticket_id.is_empty() {
                    "the ticket"
                } else {
                    ticket_id.as_str()
                };
                return steward_refusal(
                    400,
                    format!(
                        "adopting a candidate is the operator's: leave {ticket} with a note naming the one you recommend"
                    ),
                );
            }
            let parsed = ["resume", "approve", "reject", "close"]
                .contains(&action.as_str())
                .then(|| StewardAnswerAction::parse(&action))
                .flatten();
            let Some(parsed) = parsed.filter(|_| !ticket_id.is_empty()) else {
                return steward_refusal(
                    400,
                    "ticketId and an action of resume, approve, reject or close are required",
                );
            };
            let note = body.get("note").and_then(Value::as_str).map(str::to_owned);
            match engine
                .steward_answer(conversation, ticket_id.clone(), parsed, note)
                .await
            {
                Ok(()) => steward_done(format!("answered {ticket_id}: {action}"), 202),
                Err(err) => engine_refused(err),
            }
        }
        "/api/steward/keep-talking" => {
            let message = text("message");
            if ticket_id.is_empty() || js::trim(&message).is_empty() {
                return steward_refusal(400, "ticketId and message are required");
            }
            match engine
                .steward_keep_talking(conversation, ticket_id.clone(), message)
                .await
            {
                Ok(attempt) => steward_done(
                    format!("keep talking on {ticket_id}: attempt {attempt} continues in its pane"),
                    202,
                ),
                Err(err) => engine_refused(err),
            }
        }
        "/api/steward/leave" => {
            let note = text("note");
            if ticket_id.is_empty() || js::trim(&note).is_empty() {
                return steward_refusal(400, "ticketId and note are required");
            }
            match engine
                .steward_leave(conversation, ticket_id.clone(), note)
                .await
            {
                Ok(()) => steward_done(
                    format!("left {ticket_id} to the operator with your note"),
                    200,
                ),
                Err(err) => engine_refused(err),
            }
        }
        "/api/steward/held" => {
            let action = text("action");
            let id = text("id");
            if id.is_empty() || (action != "adopt" && action != "discard") {
                return steward_refusal(400, "id and an action of adopt or discard are required");
            }
            let done = if action == "adopt" {
                engine
                    .steward_adopt_held_spawn(conversation, id.clone())
                    .await
            } else {
                engine
                    .steward_discard_held_spawn(conversation, id.clone())
                    .await
            };
            match done {
                Ok(()) => steward_done(
                    format!(
                        "{} held spawn {id}",
                        if action == "adopt" {
                            "adopted"
                        } else {
                            "discarded"
                        }
                    ),
                    200,
                ),
                Err(err) => engine_refused(err),
            }
        }
        "/api/steward/reassign" => {
            if let Err(err) = engine.steward_check(conversation.clone()).await {
                return engine_refused(err);
            }
            let Some(raw) = server.last_raw() else {
                return steward_refusal(409, "reassign: pool not started");
            };
            let tickets = match body.get("tickets") {
                Some(Value::Array(items)) => Value::Array(items.clone()),
                _ => json!([]),
            };
            let fields = match body.get("fields") {
                Some(Value::Object(fields)) => fields.clone(),
                _ => serde_json::Map::new(),
            };
            let written = {
                let mut inner = server.lock();
                server.refresh_meta(&mut inner, Some(&raw));
                let live = live_attempt_ids(&raw);
                let context = ReassignContext {
                    markers: &inner.meta,
                    harnesses: &server.0.harnesses,
                    live_attempts: &live,
                    statuses: &raw.state.tickets,
                    engine_assignments: &raw.assignments,
                };
                write_reassign(
                    server.pool_dir(),
                    Some(&tickets),
                    &Value::Object(fields.clone()),
                    &context,
                )
            };
            if let Err(err) = written {
                let status = if matches!(err, ReassignError::ConfigUnreadable(_)) {
                    500
                } else {
                    409
                };
                return steward_refusal(status, err.message());
            }
            let named: Vec<String> = tickets
                .as_array()
                .into_iter()
                .flatten()
                .map(|ticket| {
                    if ticket.is_null() {
                        String::new()
                    } else {
                        js::string_of(ticket)
                    }
                })
                .collect();
            if let Err(err) = engine
                .steward_reassigned(conversation, named.clone(), fields)
                .await
            {
                return engine_refused(err);
            }
            {
                let mut inner = server.lock();
                server.reenrich(&mut inner);
            }
            steward_done(
                format!("reassigned {}; resume to run on it", named.join(", ")),
                200,
            )
        }
        "/api/steward/end" => {
            if let Err(err) = engine.steward_check(conversation.clone()).await {
                return engine_refused(err);
            }
            let closing = body
                .get("closing")
                .and_then(Value::as_str)
                .map(str::to_owned);
            // Off the request's own turn: the End closes the Steward's tab, and the command asking for
            // it runs inside that tab, so the answer goes out first.
            server.0.runtime.spawn(async move {
                if let Err(err) = engine.steward_end(conversation, closing).await {
                    eprintln!("steward end: {}", err.message());
                }
            });
            steward_done("ending: your tab closes now".to_owned(), 202)
        }
        _ => steward_refusal(404, format!("no steward route {path}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_query_parameters_as_url_search_params_does() {
        assert_eq!(
            query_param("ticket=01&x=2", "ticket").as_deref(),
            Some("01")
        );
        assert_eq!(query_param("a=1&a=2", "a").as_deref(), Some("1"));
        assert_eq!(query_param("before=", "before").as_deref(), Some(""));
        assert_eq!(query_param("before", "before").as_deref(), Some(""));
        assert_eq!(query_param("id=a%20b+c", "id").as_deref(), Some("a b c"));
        assert_eq!(query_param("id=%zz", "id").as_deref(), Some("%zz"));
        assert_eq!(query_param("x=1", "ticket"), None);
    }

    #[test]
    fn matches_an_origin_to_the_host_it_came_to() {
        assert!(same_origin("http://localhost:8790", Some("localhost:8790")));
        assert!(same_origin(
            "http://LOCALHOST:8790/",
            Some("localhost:8790")
        ));
        assert!(same_origin("http://localhost:80", Some("localhost")));
        assert!(!same_origin("http://evil.example", Some("localhost:8790")));
        assert!(!same_origin("null", Some("localhost:8790")));
        assert!(!same_origin(
            "http://localhost:8791",
            Some("localhost:8790")
        ));
        assert!(!same_origin("http://localhost:8790", None));
    }
}
