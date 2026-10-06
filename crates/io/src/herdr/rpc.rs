//! One JSON-RPC request over a fresh unix-socket connection, the only way herdr takes one: open, write
//! `{"id":"1","method":..,"params":..}\n`, read exactly one JSON line, and let the connection go.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use ac_core::js;

use super::HerdrError;

/// How long a call waits on the daemon before giving up on it: every RPC's watchdog, counted from the
/// call's start, connect included.
pub(super) const CONNECT_GRACE: Duration = Duration::from_secs(10);

/// One request to the daemon. Resolves with the answer's `result`, `None` where the answer carries none
/// (JavaScript's `undefined`, which the shape checks print as `undefined`); fails with the daemon's
/// `error` body, on timeout, when the daemon cannot be reached, and on an unparseable answer.
pub(super) async fn call(
    socket_path: &Path,
    method: &str,
    params: Value,
) -> Result<Option<Value>, HerdrError> {
    match tokio::time::timeout(CONNECT_GRACE, exchange(socket_path, method, params)).await {
        Ok(settled) => settled,
        Err(_) => Err(HerdrError::new(format!("herdr rpc timed out ({method})"))),
    }
}

/// The request line every call writes, the subscription's included.
pub(super) fn request_line(method: &str, params: Value) -> String {
    let mut line = json!({ "id": "1", "method": method, "params": params }).to_string();
    line.push('\n');
    line
}

/// Connect to the daemon's socket, failing with the TypeScript server's text. Bun names every failed
/// unix connect ENOENT, whatever the kernel said (verified on Bun 1.3.14 for a missing path, a stale
/// socket file, a plain file and a socket it may not open), and that message is what the pool log, a
/// 502 and a spawned event's `terminal_error` showed.
pub(super) async fn connect(socket_path: &Path) -> Result<UnixStream, HerdrError> {
    UnixStream::connect(socket_path)
        .await
        .map_err(|_| HerdrError::new(format!("connect ENOENT {}", socket_path.display())))
}

async fn exchange(
    socket_path: &Path,
    method: &str,
    params: Value,
) -> Result<Option<Value>, HerdrError> {
    let mut stream = connect(socket_path).await?;
    // A write the daemon has already hung up on is not a failure of its own: Bun's socket takes it
    // silently and the close that follows settles the call from whatever arrived, as below.
    let _ = stream
        .write_all(request_line(method, params).as_bytes())
        .await;
    let mut received = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk).await {
            // The connection ended before a full line: a daemon that answered without a trailing
            // newline (or died mid-write) still settles from whatever the socket carried. A reset
            // reads the same, as it does under Bun.
            Ok(0) | Err(_) => return settle(method, &String::from_utf8_lossy(&received)),
            Ok(read) => {
                let from = received.len();
                received.extend_from_slice(&chunk[..read]);
                // The first complete line settles the call: a blocking call may keep its connection
                // open once its answer lands, and a reader waiting for the close would hang on it.
                if let Some(newline) = received[from..].iter().position(|b| *b == b'\n') {
                    let line = String::from_utf8_lossy(&received[..from + newline]);
                    return settle(method, &line);
                }
            }
        }
    }
}

/// Read one answer line as the TypeScript client did: an `error` member (any value, null included)
/// fails the call, an object without one resolves with its `result`, and any other JSON value resolves
/// with nothing. A line that is not JSON, or is JSON `null`, is a bad response.
fn settle(method: &str, line: &str) -> Result<Option<Value>, HerdrError> {
    match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(answer)) => match answer.get("error") {
            Some(error) => Err(HerdrError::new(format!(
                "{method} failed: {}",
                js::json_or_string(error)
            ))),
            None => Ok(answer.get("result").cloned()),
        },
        Ok(Value::Null) | Err(_) => Err(HerdrError::new(format!(
            "bad herdr response for {method}: {line}"
        ))),
        Ok(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settles_an_answer_line_as_the_typescript_client_did() {
        assert_eq!(
            settle("pane.list", r#"{"id":"1","result":{"panes":[]}}"#),
            Ok(Some(json!({ "panes": [] })))
        );
        assert_eq!(settle("pane.focus", r#"{"id":"1"}"#), Ok(None));
        assert_eq!(
            settle("pane.focus", r#"{"id":"1","result":null}"#),
            Ok(Some(Value::Null))
        );
        assert_eq!(settle("pane.focus", "[1,2]"), Ok(None));
        assert_eq!(settle("pane.focus", "\"ok\""), Ok(None));
        assert_eq!(
            settle("pane.focus", r#"{"id":"1","error":null,"result":{}}"#)
                .unwrap_err()
                .to_string(),
            "pane.focus failed: null"
        );
        assert_eq!(
            settle("tab.close", r#"{"id":"1","error":"tab_not_found: w7:t1"}"#)
                .unwrap_err()
                .to_string(),
            "tab.close failed: tab_not_found: w7:t1"
        );
        assert_eq!(
            settle("pane.list", "null").unwrap_err().to_string(),
            "bad herdr response for pane.list: null"
        );
        assert_eq!(
            settle("pane.list", "").unwrap_err().to_string(),
            "bad herdr response for pane.list: "
        );
        assert_eq!(
            settle("pane.list", "{\"id\":").unwrap_err().to_string(),
            "bad herdr response for pane.list: {\"id\":"
        );
    }

    #[test]
    fn writes_the_request_as_one_json_line() {
        assert_eq!(
            request_line("pane.focus", json!({ "pane_id": "w7:p1" })),
            "{\"id\":\"1\",\"method\":\"pane.focus\",\"params\":{\"pane_id\":\"w7:p1\"}}\n"
        );
    }
}
