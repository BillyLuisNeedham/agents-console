//! A fake TypeSafe endpoint for this module's tests, over real HTTP on a free local port, speaking the
//! real request and response shape of `POST /v1/systemone`. Ported from conformance/fixtures/jev-fake.ts
//! (`serveFakeJev`): scripted by options (an answer per question id, a failure to serve, a garbage body, a
//! delay), with every request recorded for assertions afterwards. Any other path answers 404.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use ac_core::jev_questions::{Question, ScriptedAnswer, answer_for};
use ac_core::js;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// The model the fake answers with when a request names none.
const DEFAULT_MODEL: &str = "jev-latest";
/// Characters per token in the usage the fake reports: the API's measured rate.
const CHARS_PER_TOKEN: f64 = 3.5;

/// How the fake answers.
#[derive(Debug, Clone, Default)]
pub(super) struct WireOptions {
    /// Answers by question id; an unscripted question gets a uniform answer of its type.
    pub answers: HashMap<String, ScriptedAnswer>,
    /// Serve this status instead of answers.
    pub fail: Option<Fail>,
    /// Serve a 200 whose body is not JSON.
    pub garbage: bool,
    /// Hold every response this long.
    pub delay_ms: Option<u64>,
    /// Headers every response carries besides its content type.
    pub headers: Vec<(&'static str, String)>,
}

/// A failure to serve, for the first `times` requests (every request when `None`).
#[derive(Debug, Clone)]
pub(super) struct Fail {
    pub status: u16,
    pub body: Option<Value>,
    pub times: Option<usize>,
}

impl Fail {
    pub fn always(status: u16) -> Fail {
        Fail {
            status,
            body: None,
            times: None,
        }
    }
}

/// One request the fake received.
#[derive(Debug, Clone)]
pub(super) struct Recorded {
    /// `http://<host><path>`, as the request named it.
    pub url: String,
    /// Every header, names lower-cased, in the order they arrived.
    pub headers: Vec<(String, String)>,
    /// The body as sent.
    pub raw: String,
    /// The body parsed, or the raw text when it does not parse.
    pub body: Value,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.as_str())
    }
}

struct Shared {
    options: WireOptions,
    failures_served: usize,
    requests: Vec<Recorded>,
}

/// The fake, serving until dropped.
pub(super) struct WireFake {
    url: String,
    shared: Arc<Mutex<Shared>>,
    server: JoinHandle<()>,
}

impl Drop for WireFake {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl WireFake {
    pub async fn serve(options: WireOptions) -> WireFake {
        let shared = Arc::new(Mutex::new(Shared {
            options,
            failures_served: 0,
            requests: Vec::new(),
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(handle)
            .with_state(Arc::clone(&shared));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        WireFake {
            url,
            shared,
            server,
        }
    }

    /// The API root to hand a client, `http://127.0.0.1:<port>`.
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn requests(&self) -> Vec<Recorded> {
        lock(&self.shared).requests.clone()
    }

    /// Change what later requests get.
    pub fn script(&self, options: WireOptions) {
        let mut shared = lock(&self.shared);
        shared.options = options;
        shared.failures_served = 0;
    }
}

fn lock(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn handle(State(shared): State<Arc<Mutex<Shared>>>, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_owned(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect();
    let host = request
        .headers()
        .get("host")
        .and_then(|host| host.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let raw = String::from_utf8_lossy(&to_bytes(request.into_body(), usize::MAX).await.unwrap())
        .into_owned();
    let body = js::parse(&raw).unwrap_or_else(|_| Value::String(raw.clone()));
    let options = {
        let mut shared = lock(&shared);
        shared.requests.push(Recorded {
            url: format!("http://{host}{path}"),
            headers,
            raw: raw.clone(),
            body: body.clone(),
        });
        shared.options.clone()
    };
    if method != Method::POST || path != "/v1/systemone" {
        return respond(
            404,
            &options,
            js::stringify(&json!({ "error": format!("no route {method} {path}") })),
        );
    }
    if let Some(ms) = options.delay_ms {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
    if let Some(fail) = &options.fail {
        let serve = {
            let mut shared = lock(&shared);
            let serve = fail
                .times
                .is_none_or(|times| shared.failures_served < times);
            if serve {
                shared.failures_served += 1;
            }
            serve
        };
        if serve {
            let body = fail
                .body
                .clone()
                .unwrap_or_else(|| json!({ "error": format!("status {}", fail.status) }));
            return respond(fail.status, &options, js::stringify(&body));
        }
    }
    if options.garbage {
        return respond(200, &options, "<html>not json</html>".to_owned());
    }
    let mut answers = Map::new();
    if let Some(Value::Object(questions)) = body.get("questions") {
        for (id, question) in questions {
            if let Some(question) = Question::from_value(question) {
                answers.insert(id.clone(), answer_for(&question, options.answers.get(id)));
            }
        }
    }
    let model = body
        .get("model")
        .cloned()
        .unwrap_or_else(|| Value::from(DEFAULT_MODEL));
    let input_tokens = (js::utf16_len(&raw) as f64 / CHARS_PER_TOKEN).ceil();
    let answer = json!({
        "model": model,
        "answers": answers,
        "usage": { "input_tokens": input_tokens as u64, "output_tokens": 0 },
    });
    respond(200, &options, js::stringify(&answer))
}

fn respond(status: u16, options: &WireOptions, body: String) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::from_u16(status).unwrap())
        .header("content-type", "application/json");
    for (name, value) in &options.headers {
        response = response.header(*name, value);
    }
    response.body(Body::from(body)).unwrap()
}

/// A local URL nobody listens on: the shape of a dead network.
pub(super) async fn dead_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    url
}

/// A local server that takes each connection and hangs up without a word.
pub(super) async fn hanging_up_url() -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            drop(socket);
        }
    });
    (url, server)
}
