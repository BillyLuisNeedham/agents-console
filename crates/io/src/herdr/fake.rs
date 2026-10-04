//! A fake herdr daemon for this module's tests, over a real unix socket speaking the real wire shape: one
//! JSON line in, one JSON line out, per connection. Ported from conformance/fixtures/herdr-fake.ts, the
//! fake the TypeScript client's own suite ran against, plus a script hook for answers no daemon state
//! produces (a malformed line, silence, a connection held open) and the few calls that fake left
//! unanswered.
//!
//! `tab.create` mints a tab id and a root pane inside the workspace the call names (`<ws>:t<N>`,
//! `<ws>:p<N>`) and refuses a workspace the fake does not hold; `workspace.get`, `workspace.create` and
//! `workspace.rename` work on the workspaces it holds; `pane.list` serves the created panes plus any
//! foreign ones, filtered by `workspace_id` when the call scopes itself; `tab.close` drops the tab's
//! panes and pushes only `tab_closed`, `pane.close` drops the pane and pushes `pane_closed`, the daemon's
//! own asymmetry (verified against herdr 0.8.2, issue #61). `events.subscribe` is acknowledged and its
//! connection kept as the subscriber's event channel, which a test drives from the daemon's side.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedReadHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::Herdr;

/// One call the fake received.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Recorded {
    pub method: String,
    pub params: Value,
}

/// An answer a test scripts for one call, in place of the fake's own.
pub(super) enum Reply {
    /// This line and a newline, then the fake hangs up.
    Line(String),
    /// These bytes exactly, then the fake hangs up.
    Bytes(Vec<u8>),
    /// This line and a newline, with the connection left open.
    LineKeepOpen(String),
    /// No answer ever, with the connection left open: a wedged daemon.
    Hang,
    /// Hang up without answering.
    Close,
}

/// Picks a scripted answer for a call by its method and params, or `None` for the fake's own.
pub(super) type Script = Arc<dyn Fn(&str, &Value) -> Option<Reply> + Send + Sync>;

#[derive(Default)]
pub(super) struct Options {
    /// Panes the daemon already holds (live agents the pool must never touch), as `pane.list` lists them.
    pub foreign_panes: Vec<Value>,
    /// When set, `pane.list` answers exactly these, ignoring created tabs.
    pub list_only: Option<Vec<Value>>,
    /// Workspaces the daemon already holds, as `{ workspace_id, label? }`.
    pub workspaces: Vec<Value>,
    /// `tab.create` answers with the tab alone: a daemon older than herdr protocol 20.
    pub root_paneless: bool,
    /// Methods answered with this error body.
    pub fail: Vec<(&'static str, Value)>,
    pub script: Option<Script>,
}

/// What a subscriber's connection is told to do from the daemon's side.
enum Push {
    Line(String),
    /// End with a plain FIN, saying nothing first.
    HangUp,
    /// Drop the connection outright, the shape of a daemon that died.
    Drop,
}

struct State {
    requests: Vec<Recorded>,
    connections: usize,
    open: usize,
    subscribers: HashMap<u64, mpsc::UnboundedSender<Push>>,
    next_subscriber: u64,
    panes: Vec<Value>,
    list_only: Option<Vec<Value>>,
    workspaces: Vec<Value>,
    minted: u64,
    minted_workspaces: u64,
    root_paneless: bool,
    fail: HashMap<String, Value>,
    script: Option<Script>,
}

/// What a connection does once its request is read.
enum Action {
    /// Write these bytes, hang up, then push this event line to every subscriber.
    End(Vec<u8>, Option<String>),
    KeepOpen(Vec<u8>),
    Subscribe(Vec<u8>),
    Hang,
    Close,
}

pub(super) struct FakeHerdr {
    socket_path: PathBuf,
    state: Arc<Mutex<State>>,
    accept: JoinHandle<()>,
    _dir: tempfile::TempDir,
}

impl Drop for FakeHerdr {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

impl FakeHerdr {
    pub async fn start(options: Options) -> FakeHerdr {
        let dir = tempfile::Builder::new()
            .prefix("herdr-fake-")
            .tempdir()
            .expect("a scratch directory for the fake's socket");
        let socket_path = dir.path().join("herdr.sock");
        let listener = UnixListener::bind(&socket_path).expect("the fake listens");
        let state = Arc::new(Mutex::new(State {
            requests: Vec::new(),
            connections: 0,
            open: 0,
            subscribers: HashMap::new(),
            next_subscriber: 0,
            panes: options.foreign_panes,
            list_only: options.list_only,
            workspaces: options.workspaces,
            minted: 0,
            minted_workspaces: 0,
            root_paneless: options.root_paneless,
            fail: options
                .fail
                .into_iter()
                .map(|(method, body)| (method.to_owned(), body))
                .collect(),
            script: options.script,
        }));
        let accept = tokio::spawn({
            let state = Arc::clone(&state);
            async move {
                while let Ok((stream, _)) = listener.accept().await {
                    {
                        let mut state = state.lock().unwrap();
                        state.connections += 1;
                        state.open += 1;
                    }
                    tokio::spawn(serve(stream, Arc::clone(&state)));
                }
            }
        });
        FakeHerdr {
            socket_path,
            state,
            accept,
            _dir: dir,
        }
    }

    /// A client on this fake's socket.
    pub fn herdr(&self) -> Herdr {
        Herdr::new(&self.socket_path)
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.state().requests.clone()
    }

    /// The methods called so far, in arrival order.
    pub fn methods(&self) -> Vec<String> {
        self.state()
            .requests
            .iter()
            .map(|request| request.method.clone())
            .collect()
    }

    /// Connections accepted so far.
    pub fn connections(&self) -> usize {
        self.state().connections
    }

    /// Connections still open.
    pub fn open_connections(&self) -> usize {
        self.state().open
    }

    /// Connections held open by an `events.subscribe`.
    pub fn subscribers(&self) -> usize {
        self.state().subscribers.len()
    }

    /// Push one event line to every subscriber, as the daemon pushes every pane's.
    pub fn push_event(&self, event: &str, data: Value) {
        broadcast(&mut self.state(), event_line(event, data));
    }

    /// Hang up on every subscriber with a plain FIN, saying nothing first.
    pub fn hang_up_subscribers(&self) {
        for subscriber in self.state().subscribers.values() {
            let _ = subscriber.send(Push::HangUp);
        }
    }

    /// Drop every subscriber abruptly, the shape of a daemon that died.
    pub fn drop_subscribers(&self) {
        for subscriber in self.state().subscribers.values() {
            let _ = subscriber.send(Push::Drop);
        }
    }

    /// Close a workspace out from under the pool, the way an operator does mid-run (issue #94).
    pub fn remove_workspace(&self, workspace_id: &str) {
        let mut state = self.state();
        state
            .workspaces
            .retain(|workspace| workspace["workspace_id"] != workspace_id);
        state
            .panes
            .retain(|pane| pane["workspace_id"] != workspace_id);
    }

    /// Hold one more workspace, as if the operator had opened it.
    pub fn add_workspace(&self, workspace: Value) {
        self.state().workspaces.push(workspace);
    }

    /// The workspaces the fake holds, seeded plus created.
    pub fn workspaces(&self) -> Vec<Value> {
        self.state().workspaces.clone()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }
}

/// Wait for something the fake daemon has seen, so a test drives the daemon's side only once the client
/// has actually got there.
pub(super) async fn until(what: &str, held: impl Fn() -> bool) {
    for _ in 0..500 {
        if held() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the fake daemon never saw {what}");
}

async fn serve(stream: UnixStream, state: Arc<Mutex<State>>) {
    let (mut reader, mut writer) = stream.into_split();
    let mut received = Vec::new();
    let mut chunk = [0u8; 4096];
    let action = loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break Action::Close,
            Ok(read) => received.extend_from_slice(&chunk[..read]),
        }
        if let Some(newline) = received.iter().position(|b| *b == b'\n') {
            let request: Value =
                serde_json::from_slice(&received[..newline]).expect("the client writes JSON lines");
            break answer(&mut state.lock().unwrap(), &request);
        }
    };
    match action {
        Action::End(bytes, then) => {
            let _ = writer.write_all(&bytes).await;
            let _ = writer.shutdown().await;
            if let Some(event) = then {
                broadcast(&mut state.lock().unwrap(), event);
            }
        }
        Action::KeepOpen(bytes) => {
            let _ = writer.write_all(&bytes).await;
            until_closed(&mut reader).await;
        }
        Action::Hang => until_closed(&mut reader).await,
        Action::Close => {}
        Action::Subscribe(ack) => {
            let (push, mut pushed) = mpsc::unbounded_channel();
            let key = {
                let mut state = state.lock().unwrap();
                state.next_subscriber += 1;
                let key = state.next_subscriber;
                state.subscribers.insert(key, push);
                key
            };
            let _ = writer.write_all(&ack).await;
            loop {
                tokio::select! {
                    order = pushed.recv() => match order {
                        Some(Push::Line(line)) => {
                            let _ = writer.write_all(line.as_bytes()).await;
                        }
                        Some(Push::HangUp) => {
                            let _ = writer.shutdown().await;
                        }
                        Some(Push::Drop) | None => break,
                    },
                    read = reader.read(&mut chunk) => {
                        if matches!(read, Ok(0) | Err(_)) {
                            break;
                        }
                    }
                }
            }
            state.lock().unwrap().subscribers.remove(&key);
        }
    }
    state.lock().unwrap().open -= 1;
}

async fn until_closed(reader: &mut OwnedReadHalf) {
    let mut chunk = [0u8; 1024];
    while !matches!(reader.read(&mut chunk).await, Ok(0) | Err(_)) {}
}

fn broadcast(state: &mut State, line: String) {
    for subscriber in state.subscribers.values() {
        let _ = subscriber.send(Push::Line(line.clone()));
    }
}

fn event_line(event: &str, data: Value) -> String {
    let mut fields = Map::new();
    fields.insert("type".into(), json!(event));
    if let Value::Object(data) = data {
        fields.extend(data);
    }
    line(json!({ "event": event, "data": fields }))
}

fn line(value: Value) -> String {
    format!("{value}\n")
}

fn end(value: Value) -> Action {
    Action::End(line(value).into_bytes(), None)
}

fn error(id: &Value, code: i64, message: String) -> Action {
    end(json!({ "id": id, "error": { "code": code, "message": message } }))
}

fn ok_line(id: &Value) -> Vec<u8> {
    line(json!({ "id": id, "result": { "type": "ok" } })).into_bytes()
}

fn ok(id: &Value) -> Action {
    Action::End(ok_line(id), None)
}

fn text(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn answer(state: &mut State, request: &Value) -> Action {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = text(request, "method").unwrap_or_default();
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    state.requests.push(Recorded {
        method: method.clone(),
        params: params.clone(),
    });
    if let Some(reply) = state
        .script
        .as_ref()
        .and_then(|script| script(&method, &params))
    {
        return match reply {
            Reply::Line(text) => Action::End(format!("{text}\n").into_bytes(), None),
            Reply::Bytes(bytes) => Action::End(bytes, None),
            Reply::LineKeepOpen(text) => Action::KeepOpen(format!("{text}\n").into_bytes()),
            Reply::Hang => Action::Hang,
            Reply::Close => Action::Close,
        };
    }
    if let Some(failure) = state.fail.get(&method) {
        return end(json!({ "id": id, "error": failure }));
    }
    let holds = |state: &State, workspace_id: &str| {
        state
            .workspaces
            .iter()
            .any(|workspace| workspace["workspace_id"] == workspace_id)
    };
    match method.as_str() {
        "events.subscribe" => {
            Action::Subscribe(line(json!({ "id": id, "result": {} })).into_bytes())
        }
        "tab.create" => {
            let workspace_id = text(&params, "workspace_id");
            if let Some(workspace_id) = &workspace_id
                && !holds(state, workspace_id)
            {
                return error(&id, -32001, format!("no such workspace {workspace_id}"));
            }
            state.minted += 1;
            let minted = state.minted;
            let (tab_id, pane_id) = match &workspace_id {
                Some(workspace_id) => (
                    format!("{workspace_id}:t{minted}"),
                    format!("{workspace_id}:p{minted}"),
                ),
                None => (format!("tab-{minted}"), format!("pane-{minted}")),
            };
            let mut pane = json!({ "tab_id": tab_id, "pane_id": pane_id });
            let mut tab = json!({ "tab_id": tab_id });
            let mut root_pane = json!({ "pane_id": pane_id, "tab_id": tab_id });
            if let Some(workspace_id) = &workspace_id {
                pane["workspace_id"] = json!(workspace_id);
                tab["workspace_id"] = json!(workspace_id);
                root_pane["workspace_id"] = json!(workspace_id);
            }
            state.panes.push(pane);
            let mut result = json!({ "type": "tab_created", "tab": tab });
            if !state.root_paneless {
                result["root_pane"] = root_pane;
            }
            end(json!({ "id": id, "result": result }))
        }
        "workspace.get" => {
            let wanted = text(&params, "workspace_id").unwrap_or_default();
            match state
                .workspaces
                .iter()
                .find(|workspace| workspace["workspace_id"] == wanted.as_str())
            {
                Some(workspace) => end(json!({ "id": id, "result": { "workspace": workspace } })),
                None => error(&id, -32001, format!("no such workspace {wanted}")),
            }
        }
        "workspace.create" => {
            state.minted_workspaces += 1;
            state.minted += 1;
            let workspace_id = format!("w{}", state.minted_workspaces);
            let workspace = json!({
                "workspace_id": workspace_id,
                "label": text(&params, "label").unwrap_or_default(),
            });
            state.workspaces.push(workspace.clone());
            // The daemon opens a workspace with a tab and a pane in it; the client reads only the
            // workspace id, but the shape is the real one.
            let tab_id = format!("{workspace_id}:t{}", state.minted);
            let pane_id = format!("{workspace_id}:p{}", state.minted);
            state.panes.push(
                json!({ "tab_id": tab_id, "pane_id": pane_id, "workspace_id": workspace_id }),
            );
            end(json!({
                "id": id,
                "result": {
                    "workspace": workspace,
                    "tab": { "tab_id": tab_id, "workspace_id": workspace_id },
                    "root_pane": { "pane_id": pane_id, "tab_id": tab_id, "workspace_id": workspace_id },
                },
            }))
        }
        "workspace.rename" => {
            let wanted = text(&params, "workspace_id").unwrap_or_default();
            match state
                .workspaces
                .iter_mut()
                .find(|workspace| workspace["workspace_id"] == wanted.as_str())
            {
                Some(workspace) => {
                    workspace["label"] = json!(text(&params, "label").unwrap_or_default());
                    ok(&id)
                }
                None => error(&id, -32001, format!("no such workspace {wanted}")),
            }
        }
        "pane.report_agent" | "pane.release_agent" | "pane.focus" | "pane.send_input"
        | "tab.rename" => ok(&id),
        "pane.list" => {
            let listed = state.list_only.as_ref().unwrap_or(&state.panes);
            let panes: Vec<&Value> = match text(&params, "workspace_id") {
                Some(scope) => listed
                    .iter()
                    .filter(|pane| pane["workspace_id"] == scope.as_str())
                    .collect(),
                None => listed.iter().collect(),
            };
            end(json!({ "id": id, "result": { "panes": panes } }))
        }
        "tab.close" => {
            // A closed tab takes its panes silently: the listing drops them and one `tab_closed` goes
            // out, with no `pane_closed` for any of them.
            let tab_id = text(&params, "tab_id").unwrap_or_default();
            state.panes.retain(|pane| pane["tab_id"] != tab_id.as_str());
            if let Some(list_only) = &mut state.list_only {
                list_only.retain(|pane| pane["tab_id"] != tab_id.as_str());
            }
            let event = event_line(
                "tab_closed",
                json!({ "tab_id": tab_id, "workspace_id": "w1" }),
            );
            Action::End(ok_line(&id), Some(event))
        }
        "pane.read" => {
            // A pane at its shell prompt.
            let pane_id = text(&params, "pane_id").unwrap_or_default();
            if state
                .panes
                .iter()
                .any(|pane| pane["pane_id"] == pane_id.as_str())
            {
                end(json!({
                    "id": id,
                    "result": { "read": { "text": "$ ", "revision": 0, "truncated": false } },
                }))
            } else {
                error(&id, -32000, format!("pane {pane_id} not found"))
            }
        }
        "pane.close" => {
            // A closed pane announces itself.
            let pane_id = text(&params, "pane_id").unwrap_or_default();
            state
                .panes
                .retain(|pane| pane["pane_id"] != pane_id.as_str());
            if let Some(list_only) = &mut state.list_only {
                list_only.retain(|pane| pane["pane_id"] != pane_id.as_str());
            }
            let event = event_line(
                "pane_closed",
                json!({ "pane_id": pane_id, "workspace_id": "w1" }),
            );
            Action::End(ok_line(&id), Some(event))
        }
        _ => error(&id, -32601, format!("unknown method {method}")),
    }
}
