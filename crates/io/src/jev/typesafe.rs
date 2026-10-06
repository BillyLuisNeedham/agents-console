//! TypeSafe's HTTP API as the TypeScript SDK (`@typesafe-ai/sdk` 0.6.0, the version package.json pins)
//! speaks it, for the one call the Console makes: `POST /v1/systemone`. There is no Rust SDK (ADR-0036),
//! so this copies the SDK's wire from its source (node_modules/@typesafe-ai/sdk/dist/index.mjs):
//!
//! - **The request.** `<baseURL>/v1/systemone`, the base URL's trailing slashes stripped. The body is
//!   `JSON.stringify({ state, questions, model })`, the same bytes on every attempt. The headers, in the
//!   SDK's order: `Authorization: Bearer <key>`, `Accept: application/json`,
//!   `User-Agent: typesafe-sdk/0.6.0`, `X-TypeSafe-SDK: typesafe-sdk/0.6.0`, `X-TypeSafe-Runtime`, and
//!   `Content-Type: application/json`; a retry adds `X-TypeSafe-Retry-Count: <n>`.
//! - **One attempt** is one round trip with its whole body read, under the per-attempt timeout (10 s by
//!   default). The timer firing is a timeout; any other failure to send or to read is a connection error.
//! - **The answer.** A 2xx body is read as text and parsed as JSON, the text itself when it does not
//!   parse, nothing when it is empty. Anything else is an API error carrying its status, its body parsed
//!   the same way, and the SDK's message (`<status> <detail>`).
//! - **Retries.** Two by default. An HTTP 408, 429 or 5xx, a timeout and a connection error retry; any
//!   other status fails at once. The wait is the server's `retry-after-ms` or `Retry-After` when it is at
//!   most 60 s, else exponential from 500 ms, capped at 5 s, less up to 25% jitter.
//!
//! Where the SDK's behaviour came from its runtime, this client chooses:
//!
//! - `X-TypeSafe-Runtime` names the runtime as the SDK does for Bun or Node (`bun/1.3.14 (linux; x64)`),
//!   with the platform and architecture in Node's words: `rust (linux; x64)`, `rust (darwin; arm64)`.
//!   No version, since a Rust binary carries none of its compiler's.
//! - A failure to connect reads as Bun's fetch words it (`Unable to connect. Is the computer able to
//!   access the url?`), and so does a connection the server closed mid-answer (`The socket connection was
//!   closed unexpectedly. ...`), so the pool log line a dead network writes is the TypeScript's. Any other
//!   transport failure (a TLS refusal, a bad URL) carries reqwest's own text.
//! - Bun asks for compressed bodies and inflates them; reqwest is built without compression here, so it
//!   asks for none and the server sends plain JSON.
//! - Proxies: Bun's fetch and reqwest both honour `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`. That is the
//!   transport's own reading of the environment, as it was in Bun, not configuration this module reads.
//! - The jitter's randomness comes from the standard library's per-hasher random keys, as there is no
//!   `Math.random`; nothing depends on its sequence.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ac_core::jev_questions::{Evidence, Questions, questions_value};
use ac_core::js;
use reqwest::header::{
    ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT,
};
use serde_json::{Map, Value};

/// The SDK version whose wire this copies; it names itself with it on every request.
pub const SDK_VERSION: &str = "0.6.0";
/// The SDK's per-attempt timeout when none is given.
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

/// How the SDK names itself, in `User-Agent` and `X-TypeSafe-SDK`.
const SDK_NAME: &str = "typesafe-sdk/0.6.0";
const SYSTEMONE_PATH: &str = "/v1/systemone";

/// Bun's fetch, failing to connect.
const BUN_UNABLE_TO_CONNECT: &str = "Unable to connect. Is the computer able to access the url?";
/// Bun's fetch, the connection closed before the answer was whole.
const BUN_SOCKET_CLOSED: &str = "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

/// The SDK's retry policy. The default is `DEFAULT_RETRY_POLICY`; an override is written as the default
/// with fields changed (`RetryPolicy { max_retries: 0, ..RetryPolicy::default() }`), as the SDK merges a
/// partial policy over its default.
#[derive(Debug, Clone, PartialEq)]
pub struct RetryPolicy {
    /// Retries after the first attempt.
    pub max_retries: u32,
    /// The first backoff, doubling with each retry.
    pub backoff_initial_ms: u64,
    /// The backoff's ceiling.
    pub backoff_max_ms: u64,
    /// The fraction of a backoff taken off at random, 0 to 1.
    pub backoff_jitter: f64,
    /// The HTTP statuses that retry.
    pub http_statuses: Vec<u16>,
    /// Wait as long as the server's `retry-after-ms` or `Retry-After` says, when it is in range.
    pub respect_retry_after: bool,
    /// The longest server-asked wait taken; a longer one falls back to the backoff.
    pub max_retry_after_ms: u64,
    /// Retry a connection error.
    pub api_connection_error: bool,
    /// Retry a timeout.
    pub api_timeout_error: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy {
            max_retries: 2,
            backoff_initial_ms: 500,
            backoff_max_ms: 5_000,
            backoff_jitter: 0.25,
            // HTTP 408, 429, and 5xx responses.
            http_statuses: [408, 429].into_iter().chain(500..600).collect(),
            respect_retry_after: true,
            max_retry_after_ms: 60_000,
            api_connection_error: true,
            api_timeout_error: true,
        }
    }
}

/// Why a call produced no answer, as the SDK's error classes divide it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SdkError {
    /// A non-2xx response once retries were spent (`APIError` and its subclasses by status).
    Api(ApiError),
    /// No whole answer within the timeout (`APITimeoutError`).
    Timeout { timeout_ms: u64 },
    /// The request or the answer's delivery failed (`APIConnectionError`); the message is the SDK's
    /// `Connection error: <fetch's message>`.
    Connection { message: String },
}

/// An unsuccessful HTTP response.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ApiError {
    pub status: u16,
    /// Parsed JSON, the response text, or `None` for an empty body.
    pub body: Option<Value>,
    /// `APIError.describe(status, body)`.
    pub message: String,
}

impl ApiError {
    fn new(status: u16, body: Option<Value>) -> ApiError {
        let message = describe(status, body.as_ref());
        ApiError {
            status,
            body,
            message,
        }
    }
}

/// The client for one key and base URL: `new TypeSafeClient(config)`, reduced to `systemOne`.
pub(crate) struct TypeSafeClient {
    http: reqwest::Client,
    api_key: String,
    base_url: String,
    timeout_ms: u64,
    retry: RetryPolicy,
}

impl TypeSafeClient {
    /// A client as the SDK's constructor builds one, its checks included: a timeout that is not a
    /// positive number of milliseconds, or a retry policy out of range, is refused as the SDK throws.
    pub fn new(api_key: String, base_url: &str, timeout_ms: u64, retry: RetryPolicy) -> Self {
        assert!(
            timeout_ms > 0,
            "`timeout` must be a positive number of milliseconds, got {timeout_ms}."
        );
        assert!(
            (0.0..=1.0).contains(&retry.backoff_jitter),
            "`retry.backoffJitter` must be between 0 and 1, got {}.",
            js::number_string(retry.backoff_jitter)
        );
        if let Some(status) = retry
            .http_statuses
            .iter()
            .find(|status| !(100..=999).contains(*status))
        {
            panic!("`retry.httpStatuses` must contain HTTP status codes, got {status}.");
        }
        let http = reqwest::Client::builder()
            .build()
            .expect("the HTTP client builds");
        TypeSafeClient {
            http,
            api_key,
            base_url: base_url.trim_end_matches('/').to_owned(),
            timeout_ms,
            retry,
        }
    }

    /// The URL every ask goes to.
    pub fn systemone_url(&self) -> String {
        format!("{}{SYSTEMONE_PATH}", self.base_url)
    }

    /// `client.systemOne({ state, questions, model })`: the parsed answer body, `None` when it was
    /// empty, or why there was none.
    pub async fn system_one(
        &self,
        state: &Evidence,
        questions: &Questions,
        model: &str,
    ) -> Result<Option<Value>, SdkError> {
        let mut request = Map::new();
        request.insert("state".to_owned(), Value::Object(state.clone()));
        request.insert("questions".to_owned(), questions_value(questions));
        request.insert("model".to_owned(), Value::from(model));
        let body = js::stringify(&Value::Object(request));
        let url = self.systemone_url();
        let mut attempt: u32 = 0;
        loop {
            let retries_left = i64::from(self.retry.max_retries) - i64::from(attempt);
            match self.attempt(&url, &body, attempt).await {
                Err(err) => {
                    let retryable = match err {
                        SdkError::Timeout { .. } => self.retry.api_timeout_error,
                        SdkError::Connection { .. } => self.retry.api_connection_error,
                        SdkError::Api(_) => false,
                    };
                    if retries_left <= 0 || !retryable {
                        return Err(err);
                    }
                    self.back_off(attempt, None).await;
                }
                Ok(answer) => {
                    if (200..300).contains(&answer.status) {
                        return Ok(parse_body(&answer.bytes));
                    }
                    let error = ApiError::new(answer.status, parse_body(&answer.bytes));
                    if retries_left <= 0 || !self.retry.http_statuses.contains(&answer.status) {
                        return Err(SdkError::Api(error));
                    }
                    self.back_off(attempt, Some(&answer.headers)).await;
                }
            }
            attempt += 1;
        }
    }

    /// One HTTP round trip, the body read whole, under the timeout.
    async fn attempt(&self, url: &str, body: &str, attempt: u32) -> Result<Answer, SdkError> {
        // A key no header can carry fails the request before it is sent, as fetch refuses it.
        let Ok(authorization) = HeaderValue::from_str(&format!("Bearer {}", self.api_key)) else {
            return Err(SdkError::Connection {
                message: "Connection error: the API key cannot be sent in a header".to_owned(),
            });
        };
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, authorization);
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(USER_AGENT, HeaderValue::from_static(SDK_NAME));
        headers.insert(
            HeaderName::from_static("x-typesafe-sdk"),
            HeaderValue::from_static(SDK_NAME),
        );
        if let Ok(runtime) = HeaderValue::from_str(&runtime()) {
            headers.insert(HeaderName::from_static("x-typesafe-runtime"), runtime);
        }
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if attempt > 0 {
            headers.insert(
                HeaderName::from_static("x-typesafe-retry-count"),
                HeaderValue::from(attempt),
            );
        }
        let round_trip = async {
            let response = self
                .http
                .post(url)
                .headers(headers)
                .body(body.to_owned())
                .send()
                .await?;
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            let bytes = response.bytes().await?;
            Ok::<_, reqwest::Error>(Answer {
                status,
                headers,
                bytes: bytes.to_vec(),
            })
        };
        match tokio::time::timeout(Duration::from_millis(self.timeout_ms), round_trip).await {
            Err(_) => Err(SdkError::Timeout {
                timeout_ms: self.timeout_ms,
            }),
            Ok(Err(err)) => Err(SdkError::Connection {
                message: format!("Connection error: {}", fetch_failure_text(&err)),
            }),
            Ok(Ok(answer)) => Ok(answer),
        }
    }

    async fn back_off(&self, attempt: u32, headers: Option<&HeaderMap>) {
        let delay = retry_delay_ms(attempt, headers, &self.retry, now_ms(), random_unit());
        tokio::time::sleep(Duration::from_secs_f64(delay.max(0.0) / 1000.0)).await;
    }
}

struct Answer {
    status: u16,
    headers: HeaderMap,
    bytes: Vec<u8>,
}

/// `X-TypeSafe-Runtime`: the runtime, then the platform and architecture as Node names them.
pub(crate) fn runtime() -> String {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    format!("rust ({platform}; {arch})")
}

/// What fetch would have thrown, for the SDK's `Connection error: <message>`.
fn fetch_failure_text(err: &reqwest::Error) -> String {
    if err.is_connect() {
        return BUN_UNABLE_TO_CONNECT.to_owned();
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    let mut chain = Vec::new();
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind::*;
            if matches!(
                io.kind(),
                ConnectionReset | ConnectionAborted | BrokenPipe | UnexpectedEof
            ) {
                return BUN_SOCKET_CLOSED.to_owned();
            }
        }
        let text = cause.to_string();
        // hyper's IncompleteMessage: the server hung up before the answer was whole.
        if text.contains("connection closed before message completed") {
            return BUN_SOCKET_CLOSED.to_owned();
        }
        chain.push(text);
        source = cause.source();
    }
    chain.join(": ")
}

/// `parseBody(res)`: the text decoded as `Response.text()` does, then JSON, or the text itself.
pub(crate) fn parse_body(bytes: &[u8]) -> Option<Value> {
    let text = js::decode_utf8(bytes);
    if text.is_empty() {
        return None;
    }
    Some(js::parse(&text).unwrap_or(Value::String(text)))
}

/// `APIError.describe(status, body)`: `<status> <detail>` when the body names one, else the raw body cut
/// to 200 characters.
pub(crate) fn describe(status: u16, body: Option<&Value>) -> String {
    if let Some(detail) = extract_message(body).filter(|detail| !detail.is_empty()) {
        return format!("{status} {detail}");
    }
    let Some(body) = body else {
        return format!("{status} status code (no body)");
    };
    let raw = match body {
        Value::String(text) => text.clone(),
        other => js::stringify(other),
    };
    if js::utf16_len(&raw) > 200 {
        return format!("{status} {}…", js::utf16_prefix_lossy(&raw, 200));
    }
    format!("{status} {raw}")
}

/// Whether JavaScript's `typeof value === "object"` holds and it is not null: an object or an array.
pub(crate) fn is_record(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::Array(_))
}

/// `value[key]` for a JSON value: an object's field, an array's element at an index key.
pub(crate) fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(key),
        Value::Array(items) => js::array_index(key).and_then(|index| items.get(index as usize)),
        _ => None,
    }
}

/// `extractMessage(body)`: the first of a text body, `error`, `error.message`, `message`, `detail`,
/// `detail.message` or the validation errors in `detail` that is there to read.
fn extract_message(body: Option<&Value>) -> Option<String> {
    let body = body?;
    if let Value::String(text) = body {
        return (!text.is_empty()).then(|| text.clone());
    }
    if !is_record(body) {
        return None;
    }
    let error = get(body, "error");
    let message = get(body, "message");
    let detail = get(body, "detail");
    if let Some(Value::String(error)) = error {
        return Some(error.clone());
    }
    if let Some(Value::String(text)) = error
        .filter(|e| is_record(e))
        .and_then(|e| get(e, "message"))
    {
        return Some(text.clone());
    }
    if let Some(Value::String(message)) = message {
        return Some(message.clone());
    }
    if let Some(Value::String(detail)) = detail {
        return Some(detail.clone());
    }
    if let Some(Value::String(text)) = detail
        .filter(|d| is_record(d))
        .and_then(|d| get(d, "message"))
    {
        return Some(text.clone());
    }
    if let Some(Value::Array(errors)) = detail {
        return describe_validation_errors(errors);
    }
    None
}

/// `describeValidationErrors(errors)`: `path: message` entries, joined with `; `.
fn describe_validation_errors(errors: &[Value]) -> Option<String> {
    let parts: Vec<String> = errors
        .iter()
        .filter(|e| is_record(e))
        .filter_map(|e| {
            let Some(Value::String(msg)) = get(e, "msg") else {
                return None;
            };
            let loc = match get(e, "loc") {
                Some(Value::Array(path)) => path
                    .iter()
                    .filter(|step| step.as_str() != Some("body"))
                    .map(|step| match step {
                        Value::Null => String::new(),
                        other => js::string_of(other),
                    })
                    .collect::<Vec<_>>()
                    .join("."),
                _ => String::new(),
            };
            Some(if loc.is_empty() {
                msg.clone()
            } else {
                format!("{loc}: {msg}")
            })
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// `retryDelayMs(attempt, headers, policy)`: the server's wait when allowed, else capped exponential
/// backoff less its jitter.
pub(crate) fn retry_delay_ms(
    attempt: u32,
    headers: Option<&HeaderMap>,
    policy: &RetryPolicy,
    now_ms: f64,
    random: f64,
) -> f64 {
    if policy.respect_retry_after
        && let Some(headers) = headers
        && let Some(retry_after) = parse_retry_after(headers, now_ms)
        && retry_after <= policy.max_retry_after_ms as f64
    {
        return retry_after;
    }
    let exponential = (policy.backoff_initial_ms as f64 * 2f64.powi(attempt as i32))
        .min(policy.backoff_max_ms as f64);
    math_round(exponential * (1.0 - random * policy.backoff_jitter))
}

/// `parseRetryAfter(headers)`: `retry-after-ms` first, then `Retry-After` as seconds or an HTTP date.
fn parse_retry_after(headers: &HeaderMap, now_ms: f64) -> Option<f64> {
    if let Some(raw) = header_text(headers, "retry-after-ms") {
        let ms = js::number_from_text(&raw);
        if ms.is_finite() && ms >= 0.0 {
            return Some(ms);
        }
    }
    let raw = header_text(headers, "retry-after")?;
    let seconds = js::number_from_text(&raw);
    if seconds.is_finite() {
        return (seconds >= 0.0).then_some(seconds * 1000.0);
    }
    let date = chrono::DateTime::parse_from_rfc2822(js::trim(&raw))
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(js::trim(&raw)))
        .ok()?;
    Some((date.timestamp_millis() as f64 - now_ms).max(0.0))
}

/// `headers.get(name)`: every value of the header, joined with `, `.
fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

/// `Math.round(x)`: the nearest whole number, a tie going towards positive infinity.
fn math_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |since| since.as_millis() as f64)
}

/// A number in `[0, 1)`, for the jitter.
fn random_unit() -> f64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos()),
    );
    (hasher.finish() >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn describes_an_api_error_as_the_sdk_does() {
        assert_eq!(
            describe(400, Some(&json!({ "error": "bad question" }))),
            "400 bad question"
        );
        assert_eq!(
            describe(401, Some(&json!({ "error": { "message": "no such key" } }))),
            "401 no such key"
        );
        assert_eq!(
            describe(403, Some(&json!({ "message": "denied" }))),
            "403 denied"
        );
        assert_eq!(
            describe(404, Some(&json!({ "detail": "Not Found" }))),
            "404 Not Found"
        );
        assert_eq!(
            describe(429, Some(&json!({ "detail": { "message": "slow down" } }))),
            "429 slow down"
        );
        assert_eq!(
            describe(
                422,
                Some(&json!({ "detail": [
                    { "loc": ["body", "questions", "why"], "msg": "field required" },
                    { "loc": ["body"], "msg": "bad body" },
                    { "msg": 3 },
                ] }))
            ),
            "422 questions.why: field required; bad body"
        );
        assert_eq!(
            describe(
                400,
                Some(&json!({ "detail": { "error_type": "max_tokens_exceeded" } }))
            ),
            r#"400 {"detail":{"error_type":"max_tokens_exceeded"}}"#
        );
        // The first field that is there decides, even when it is empty: the raw body stands in.
        assert_eq!(
            describe(500, Some(&json!({ "error": "", "message": "x" }))),
            r#"500 {"error":"","message":"x"}"#
        );
        assert_eq!(
            describe(502, Some(&json!("upstream down"))),
            "502 upstream down"
        );
        assert_eq!(describe(500, None), "500 status code (no body)");
        let long = Value::String("x".repeat(250));
        assert_eq!(
            describe(503, Some(&json!({ "list": [long] })))
                .chars()
                .count(),
            4 + 200 + 1
        );
        assert!(describe(503, Some(&json!({ "n": [1.0, 2.5] }))).ends_with(r#"{"n":[1,2.5]}"#));
    }

    #[test]
    fn parses_a_body_as_json_or_keeps_its_text() {
        assert_eq!(parse_body(b""), None);
        assert_eq!(parse_body(br#"{"a":1}"#), Some(json!({ "a": 1 })));
        assert_eq!(
            parse_body(b"<html>not json</html>"),
            Some(json!("<html>not json</html>"))
        );
        // Response.text() drops a byte-order mark.
        assert_eq!(parse_body(b"\xEF\xBB\xBF[1]"), Some(json!([1])));
    }

    #[test]
    fn backs_off_exponentially_with_jitter_capped_at_the_ceiling() {
        let policy = RetryPolicy::default();
        assert_eq!(retry_delay_ms(0, None, &policy, 0.0, 0.0), 500.0);
        assert_eq!(retry_delay_ms(1, None, &policy, 0.0, 0.0), 1000.0);
        assert_eq!(retry_delay_ms(4, None, &policy, 0.0, 0.0), 5000.0);
        assert_eq!(retry_delay_ms(9, None, &policy, 0.0, 0.0), 5000.0);
        // Up to a quarter off, rounded.
        assert_eq!(retry_delay_ms(0, None, &policy, 0.0, 0.999), 375.0);
        assert_eq!(retry_delay_ms(1, None, &policy, 0.0, 0.5), 875.0);
    }

    #[test]
    fn waits_as_the_server_asks_when_it_asks_within_a_minute() {
        let policy = RetryPolicy::default();
        let headers = |pairs: &[(&'static str, &str)]| {
            let mut map = HeaderMap::new();
            for (name, value) in pairs {
                map.append(*name, HeaderValue::from_str(value).unwrap());
            }
            map
        };
        let wait = |pairs: &[(&'static str, &str)]| {
            retry_delay_ms(0, Some(&headers(pairs)), &policy, 1_000_000.0, 0.0)
        };
        assert_eq!(wait(&[("retry-after-ms", "250")]), 250.0);
        assert_eq!(
            wait(&[("retry-after-ms", "250"), ("retry-after", "9")]),
            250.0
        );
        assert_eq!(
            wait(&[("retry-after-ms", "soon"), ("retry-after", "2")]),
            2000.0
        );
        assert_eq!(wait(&[("retry-after", "1.5")]), 1500.0);
        // Negative seconds, too long a wait, or no header at all: the backoff.
        assert_eq!(wait(&[("retry-after", "-1")]), 500.0);
        assert_eq!(wait(&[("retry-after", "61")]), 500.0);
        assert_eq!(wait(&[]), 500.0);
        // An HTTP date, as a wait from now.
        let at = |ms: i64| {
            chrono::DateTime::from_timestamp_millis(ms)
                .unwrap()
                .to_rfc2822()
        };
        assert_eq!(wait(&[("retry-after", &at(1_003_000))]), 3000.0);
        assert_eq!(wait(&[("retry-after", &at(900_000))]), 0.0);
        // Not respected, the header is ignored.
        let ignoring = RetryPolicy {
            respect_retry_after: false,
            ..RetryPolicy::default()
        };
        assert_eq!(
            retry_delay_ms(
                0,
                Some(&headers(&[("retry-after-ms", "5")])),
                &ignoring,
                0.0,
                0.0
            ),
            500.0
        );
    }

    #[test]
    fn names_the_runtime_in_nodes_words() {
        let runtime = runtime();
        assert!(runtime.starts_with("rust ("), "{runtime}");
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            assert_eq!(runtime, "rust (linux; x64)");
        }
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert_eq!(runtime, "rust (darwin; arm64)");
        }
    }

    #[test]
    fn strips_the_base_urls_trailing_slashes() {
        let client = TypeSafeClient::new(
            "k".to_owned(),
            "http://127.0.0.1:4141//",
            DEFAULT_TIMEOUT_MS,
            RetryPolicy::default(),
        );
        assert_eq!(client.systemone_url(), "http://127.0.0.1:4141/v1/systemone");
    }

    #[test]
    #[should_panic(expected = "`timeout` must be a positive number of milliseconds, got 0.")]
    fn refuses_a_zero_timeout_as_the_sdk_does() {
        TypeSafeClient::new("k".to_owned(), "http://x", 0, RetryPolicy::default());
    }
}
