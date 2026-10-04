//! The Console's socket, server side (ws.ts, issue #161, ADR-0032): the one WebSocket at `/api/ws` every
//! tab holds, and everything the server pushes down it. The work a push takes is done once per server,
//! not once per tab.
//!
//! Four things go out. The snapshot: whole when a socket opens, then one delta per coalesced change,
//! diffed against the one version every socket was last sent and serialised once for all of them. The
//! live values (activity, peeks, grades): one check for every tab on a 2 s timer that runs only while a
//! tab is visible, sending only what moved. The subscribed cards' data: body, events and log window on
//! subscribe, then what changed, found by a watch on runs/ and issues/ with the live check's stat of the
//! same files as the backstop. And the replies to requests, each after the delta that carries its
//! effect. Ahead of all of it, the served page carries the version a socket would open with.
//!
//! Every function here runs with the server's state locked ([`Inner`]), as ws.ts runs on the event
//! loop; the frames go into each socket's queue in the order the TypeScript would send them, and a
//! writer task per socket drains it.

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use futures::{SinkExt, StreamExt};
use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, mpsc};
use tokio::task::AbortHandle;

use ac_core::js;
use ac_core::streamlog::list_attempt_logs;
use ac_protocol::{
    CLOSE_STOPPED, EnrichedSnapshot, LIVE_CHECK_MS, LogAttemptInfo, PROTOCOL_VERSION, RequestKind,
};

use crate::push::{self, ClientFrame, ProtocolError, Pushed, decode_client_message};
use crate::reads::{self, EVENTS_SUFFIX};
use crate::routes::{self, Answer, LogOffset, LogQuery};
use crate::server::{Inner, Server};

/// The most a log pane holds while it follows the tail (the Console's LOG_PANE_MAX_CHARS). A socket that
/// fell further behind than this gets a fresh window instead of the appends.
const LOG_PANE_MAX_BYTES: u64 = 256 * 1024;

/// The appends one check sends a socket at most.
const APPENDS_PER_CHECK: usize = 8;

/// How many peeks the live check has in flight at once.
const LIVE_READS: usize = 4;

/// The most cards one socket holds.
pub const CARDS_PER_SOCKET: usize = 32;

/// The largest frame a client may send.
pub const CLIENT_FRAME_MAX_BYTES: usize = 64 * 1024;

/// How much a socket may have queued and unwritten before it is closed rather than sent a stream with
/// frames missing (Bun's backpressure limit, with closeOnBackpressureLimit).
const BACKPRESSURE_LIMIT: usize = 16 * 1024 * 1024;

const HEARTBEAT_FRAME: &str = r#"{"type":"heartbeat"}"#;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// What a socket's writer is asked to do.
enum Outgoing {
    Text(Utf8Bytes),
    Close(u16, &'static str),
    Terminate,
}

/// A log the socket's pane holds: which file, and how far it has. A file's inode is 0 while it does not
/// exist yet.
#[derive(Debug, Clone)]
struct HeldLog {
    attempt: u64,
    stream: bool,
    ino: u64,
    offset: u64,
}

/// Which log a subscribed card follows: an attempt picked by hand, or the latest.
#[derive(Debug, Clone)]
struct Follow {
    attempt: Option<f64>,
    stream: bool,
}

/// A card one socket holds: what its log follows and what it was sent.
struct CardSub {
    follow: Follow,
    log: Option<HeldLog>,
    /// The attempt list as this socket last got it, as JSON.
    attempts: Option<String>,
}

/// What every subscriber of one card shares: its body and events as they were last sent.
struct CardWatch {
    subscribers: IndexSet<u64>,
    body_sig: Option<String>,
    body_json: String,
    events_sig: Option<String>,
    events_json: String,
}

/// One socket's own state.
struct SocketEntry {
    tx: mpsc::UnboundedSender<Outgoing>,
    queued: Arc<AtomicUsize>,
    terminated: Arc<Notify>,
    visible: bool,
    cards: IndexMap<String, CardSub>,
    /// Cleared on close, so an answer that lands after it goes nowhere.
    open: bool,
    /// In the hub's set of sockets (opened, not yet closed).
    member: bool,
}

struct Timer {
    id: u64,
    handle: AbortHandle,
}

/// The hub's whole state, kept inside the server's.
pub(crate) struct HubState {
    epoch: String,
    hello_frame: String,
    sockets: IndexMap<u64, SocketEntry>,
    visible_count: usize,
    closed: bool,
    pub watching_engine: bool,
    /// The version every socket was last sent, and the enriched snapshot it was made from.
    last_pushed: Option<Arc<Pushed>>,
    pushed_from: Option<Arc<EnrichedSnapshot>>,
    /// The emit whose version could not be encoded, passed over until the next emit replaces it.
    unencodable: Option<Arc<EnrichedSnapshot>>,
    snapshot_text: Option<(u64, String)>,
    send_timer: Option<Timer>,
    activity: IndexMap<String, (String, Value)>,
    peeks: IndexMap<String, (String, Value)>,
    grades: (String, Value),
    whole_live: Option<Option<String>>,
    parked: HashMap<String, String>,
    live_key: String,
    live_timer: Option<Timer>,
    live_soon: Option<Timer>,
    checking: bool,
    check_again: bool,
    grades_soon: Option<Timer>,
    watches: IndexMap<String, CardWatch>,
    dirty: IndexSet<String>,
    card_timer: Option<Timer>,
    watchers: Vec<notify::RecommendedWatcher>,
    known_ids: Option<(u64, HashSet<String>)>,
    heartbeat: Option<Timer>,
    html: Option<(f64, String)>,
    made: Option<(f64, u64, String)>,
    /// How a full snapshot becomes its pushed version: `push::to_pushed`, or a failing stand-in a test
    /// supplies.
    pub encode: fn(&EnrichedSnapshot, u64) -> Result<Pushed, String>,
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn encode_pushed(full: &EnrichedSnapshot, rev: u64) -> Result<Pushed, String> {
    push::to_pushed(full, rev).map_err(|err| err.to_string())
}

impl HubState {
    pub fn new(heartbeat: Duration) -> HubState {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut random = std::collections::hash_map::RandomState::new().build_hasher();
        random.write_u64(now);
        let epoch = format!(
            "{}-{}",
            base36(now),
            &format!("{:0>6}", base36(random.finish()))[..6]
        );
        let hello_frame = js::stringify(&json!({
            "type": "hello",
            "protocol": PROTOCOL_VERSION,
            "epoch": epoch,
            "heartbeatMs": heartbeat.as_millis() as u64,
        }));
        HubState {
            epoch,
            hello_frame,
            sockets: IndexMap::new(),
            visible_count: 0,
            closed: false,
            watching_engine: false,
            last_pushed: None,
            pushed_from: None,
            unencodable: None,
            snapshot_text: None,
            send_timer: None,
            activity: IndexMap::new(),
            peeks: IndexMap::new(),
            grades: ("{}".to_owned(), json!({})),
            whole_live: None,
            parked: HashMap::new(),
            live_key: String::new(),
            live_timer: None,
            live_soon: None,
            checking: false,
            check_again: false,
            grades_soon: None,
            watches: IndexMap::new(),
            dirty: IndexSet::new(),
            card_timer: None,
            watchers: Vec::new(),
            known_ids: None,
            heartbeat: None,
            html: None,
            made: None,
            encode: encode_pushed,
        }
    }

    /// The revision every socket is at.
    pub fn rev(&self) -> u64 {
        self.last_pushed.as_ref().map_or(0, |pushed| pushed.rev)
    }

    fn send(&self, socket: u64, text: &str) {
        if let Some(entry) = self.sockets.get(&socket) {
            send_to(entry, text);
        }
    }

    fn broadcast(&self, text: &str) {
        let text = Utf8Bytes::from(text.to_owned());
        for entry in self.sockets.values().filter(|entry| entry.member) {
            send_bytes(entry, text.clone());
        }
    }

    fn close_socket(&self, socket: u64) {
        if let Some(entry) = self.sockets.get(&socket) {
            let _ = entry
                .tx
                .send(Outgoing::Close(CLOSE_STOPPED.code, CLOSE_STOPPED.reason));
        }
    }
}

fn send_to(entry: &SocketEntry, text: &str) {
    send_bytes(entry, Utf8Bytes::from(text.to_owned()));
}

fn send_bytes(entry: &SocketEntry, text: Utf8Bytes) {
    if !entry.open {
        return;
    }
    let queued = entry.queued.fetch_add(text.len(), Ordering::SeqCst) + text.len();
    if queued > BACKPRESSURE_LIMIT {
        // A tab too far behind to take more is closed: the reconnect brings it a fresh snapshot, where
        // a dropped frame would leave a press waiting.
        let _ = entry.tx.send(Outgoing::Terminate);
        entry.terminated.notify_one();
        return;
    }
    let _ = entry.tx.send(Outgoing::Text(text));
}

// ---------------------------------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------------------------------

fn after<F, Fut>(server: &Server, delay: Duration, job: F) -> Timer
where
    F: FnOnce(Server, u64) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let id = next_id();
    let server = server.clone();
    let handle = server
        .0
        .runtime
        .clone()
        .spawn(async move {
            tokio::time::sleep(delay).await;
            job(server, id).await;
        })
        .abort_handle();
    Timer { id, handle }
}

fn every<F>(server: &Server, period: Duration, tick: F) -> Timer
where
    F: Fn(&Server) + Send + 'static,
{
    let id = next_id();
    let server = server.clone();
    let handle = server
        .0
        .runtime
        .clone()
        .spawn(async move {
            loop {
                tokio::time::sleep(period).await;
                tick(&server);
            }
        })
        .abort_handle();
    Timer { id, handle }
}

fn cancel(timer: &mut Option<Timer>) {
    if let Some(timer) = timer.take() {
        timer.handle.abort();
    }
}

// Whether a firing timer is still the one its slot holds; if so the slot is cleared.
fn fired(slot: &mut Option<Timer>, id: u64) -> bool {
    if slot.as_ref().is_some_and(|timer| timer.id == id) {
        *slot = None;
        true
    } else {
        false
    }
}

// ---------------------------------------------------------------------------------------------------
// The snapshot push
// ---------------------------------------------------------------------------------------------------

fn snapshot_frame(hub: &mut HubState) -> Result<String, String> {
    let rev = hub.rev();
    if hub.snapshot_text.as_ref().is_none_or(|(of, _)| *of != rev) {
        let text =
            push::snapshot_frame(hub.last_pushed.as_deref()).map_err(|err| err.to_string())?;
        hub.snapshot_text = Some((rev, text));
    }
    Ok(hub
        .snapshot_text
        .as_ref()
        .map(|(_, text)| text.clone())
        .unwrap_or_default())
}

fn same_arc<T>(a: &Option<Arc<T>>, b: &Arc<T>) -> bool {
    a.as_ref().is_some_and(|a| Arc::ptr_eq(a, b))
}

/// Push whatever is waiting, now. A version counts as pushed only once its frame is written: one that
/// cannot be leaves the hub and every socket at the last good revision. The snapshot is brought up to
/// date even with no tab open, so the ids the routes accept follow the engine.
pub(crate) fn flush(server: &Server, inner: &mut Inner) -> Result<(), String> {
    cancel(&mut inner.hub.send_timer);
    let Some(full) = server.current(inner) else {
        return Ok(());
    };
    let hub = &mut inner.hub;
    if same_arc(&hub.pushed_from, &full) || same_arc(&hub.unencodable, &full) {
        return Ok(());
    }
    let built = (|| -> Result<(Pushed, Option<String>), String> {
        match &hub.last_pushed {
            None => {
                // The first version since the process started goes whole.
                let next = (hub.encode)(&full, 1)?;
                let frame = push::snapshot_frame(Some(&next)).map_err(|err| err.to_string())?;
                Ok((next, Some(frame)))
            }
            Some(last) => {
                let next = (hub.encode)(&full, last.rev + 1)?;
                let frame = push::diff_snapshot(last, &next).map(|delta| {
                    let mut fields = Map::new();
                    fields.insert("delta".into(), delta);
                    push::frame("delta", fields)
                });
                Ok((next, frame))
            }
        }
    })();
    let (next, frame) = match built {
        Ok(built) => built,
        Err(err) => {
            hub.unencodable = Some(full);
            return Err(err);
        }
    };
    hub.pushed_from = Some(full);
    let Some(frame) = frame else {
        return Ok(());
    };
    if hub.last_pushed.is_none() {
        hub.snapshot_text = Some((next.rev, frame.clone()));
    }
    hub.last_pushed = Some(Arc::new(next));
    hub.broadcast(&frame);
    pushed(server, inner);
    Ok(())
}

/// A flush no caller can take the error from: it is reported, and the next emit or request tries again.
pub(crate) fn flush_quietly(server: &Server, inner: &mut Inner) {
    if let Err(err) = flush(server, inner) {
        eprintln!("snapshot push: {err}");
    }
}

/// An engine emit landed (or a write rebuilt the last one): push it at the end of the window.
pub(crate) fn schedule(server: &Server, inner: &mut Inner) {
    if server.0.coalesce.is_zero() {
        flush_quietly(server, inner);
    } else if inner.hub.send_timer.is_none() {
        inner.hub.send_timer = Some(after(server, server.0.coalesce, |server, id| async move {
            let mut inner = server.lock();
            if fired(&mut inner.hub.send_timer, id) {
                flush_quietly(&server, &mut inner);
            }
        }));
    }
}

// ---------------------------------------------------------------------------------------------------
// The live check
// ---------------------------------------------------------------------------------------------------

// The ids the live check reads: each vitals candidate keyed by what decides whether it is still
// running, and each terminal-backed pane by the id the Console keys it under.
fn live_targets(snapshot: Option<&Value>) -> (IndexMap<String, String>, IndexMap<String, String>) {
    let mut candidates = IndexMap::new();
    let mut panes = IndexMap::new();
    let Some(state) = snapshot.and_then(|s| s.get("state")) else {
        return (candidates, panes);
    };
    fn text(value: Option<&Value>) -> Option<&str> {
        value.and_then(Value::as_str).filter(|s| !s.is_empty())
    }
    for ticket in state
        .get("tickets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = ticket
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let status = ticket.get("status").cloned().unwrap_or(Value::Null);
        let live = ticket.get("liveAttempt").cloned().unwrap_or(Value::Null);
        let resolver = live.get("role").and_then(Value::as_str) == Some("resolver");
        if status == "in-progress" || status == "checkpoint" || resolver {
            candidates.insert(id.clone(), js::stringify(&json!([status, live])));
        }
        let pane = text(live.get("paneId"))
            .or_else(|| text(ticket.get("heldPane").and_then(|held| held.get("paneId"))));
        if let Some(pane) = pane {
            panes.insert(id, pane.to_owned());
        }
    }
    for conversation in state
        .get("conversations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(pane) = text(conversation.get("paneId")) {
            let id = conversation.get("id").and_then(Value::as_str).unwrap_or("");
            panes.insert(id.to_owned(), pane.to_owned());
        }
    }
    (candidates, panes)
}

fn whole_live_frame(hub: &mut HubState) -> Option<String> {
    if hub.whole_live.is_none() {
        let mut fields = Map::new();
        if !hub.activity.is_empty() {
            let activity: Map<String, Value> = hub
                .activity
                .iter()
                .map(|(id, (_, value))| (id.clone(), value.clone()))
                .collect();
            fields.insert("activity".into(), Value::Object(activity));
        }
        if !hub.peeks.is_empty() {
            let peeks: Map<String, Value> = hub
                .peeks
                .iter()
                .map(|(id, (_, value))| (id.clone(), value.clone()))
                .collect();
            fields.insert("peeks".into(), Value::Object(peeks));
        }
        if hub.grades.0 != "{}" {
            fields.insert("grades".into(), hub.grades.1.clone());
        }
        hub.whole_live = Some((!fields.is_empty()).then(|| push::frame("live", fields)));
    }
    hub.whole_live.clone().flatten()
}

fn pushed(server: &Server, inner: &mut Inner) {
    let hub = &mut inner.hub;
    let (candidates, panes) = live_targets(hub.last_pushed.as_ref().map(|p| &p.snapshot));
    let key = js::stringify(&json!([
        candidates
            .iter()
            .map(|(k, v)| json!([k, v]))
            .collect::<Vec<_>>(),
        panes.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
    ]));
    if key == hub.live_key {
        return;
    }
    hub.live_key = key;
    if hub.visible_count > 0 {
        check_live_soon(server, inner);
    }
}

fn check_live_soon(server: &Server, inner: &mut Inner) {
    if inner.hub.closed || inner.hub.live_soon.is_some() {
        return;
    }
    inner.hub.live_soon = Some(after(server, server.0.check, |server, id| async move {
        let run = {
            let mut inner = server.lock();
            fired(&mut inner.hub.live_soon, id)
        };
        if run {
            check_live(server).await;
        }
    }));
}

// One check at a time: one asked for while another runs is run once more when it ends.
async fn check_live(server: Server) {
    {
        let mut inner = server.lock();
        if inner.hub.checking {
            inner.hub.check_again = true;
            return;
        }
        inner.hub.checking = true;
    }
    loop {
        server.lock().hub.check_again = false;
        live_check(&server).await;
        let inner = server.lock();
        if !(inner.hub.check_again && !inner.hub.closed) {
            break;
        }
    }
    server.lock().hub.checking = false;
}

async fn live_check(server: &Server) {
    let (due, pane_ids, candidates) = {
        let mut inner = server.lock();
        if inner.hub.closed || inner.hub.visible_count == 0 {
            return;
        }
        // The backstop for a watch event that never came: a missed one costs at most this check's
        // interval.
        let cards: Vec<String> = inner.hub.watches.keys().cloned().collect();
        for id in cards {
            check_card_quietly(server, &mut inner, &id);
        }
        let (candidates, panes) = live_targets(inner.hub.last_pushed.as_ref().map(|p| &p.snapshot));
        let due: Vec<String> = candidates
            .iter()
            .filter(|(id, key)| inner.hub.parked.get(*id) != Some(key))
            .map(|(id, _)| id.clone())
            .collect();
        let pane_ids: Vec<String> = panes.keys().cloned().collect();
        (due, pane_ids, (candidates, panes))
    };
    let activities = async {
        let mut out = Vec::new();
        // One at a time, each after a turn of the runtime: each starts git.
        for id in &due {
            tokio::task::yield_now().await;
            out.push(server.activity(id).await);
        }
        out
    };
    let peeks = futures::stream::iter(pane_ids.clone())
        .map(|id| async move {
            match routes::peek_request(server, &id).await {
                Answer::Ok {
                    result: Ok(result), ..
                } => result,
                Answer::Ok {
                    result: Err(err), ..
                }
                | Answer::Thrown(err)
                | Answer::Refused { reason: err, .. } => json!({ "ticket": id, "error": err }),
            }
        })
        .buffered(LIVE_READS)
        .collect::<Vec<_>>();
    let (activities, peeked) = futures::join!(activities, peeks);

    let mut inner = server.lock();
    if inner.hub.closed {
        return;
    }
    let (candidates, panes) = candidates;
    let hub = &mut inner.hub;
    let mut activity_frame = Map::new();
    for (id, value) in due.iter().zip(activities) {
        if value.get("running") == Some(&Value::Bool(true)) {
            hub.parked.remove(id);
        } else if let Some(key) = candidates.get(id) {
            hub.parked.insert(id.clone(), key.clone());
        }
        let json = js::stringify(&value);
        if hub.activity.get(id).is_some_and(|(held, _)| *held == json) {
            continue;
        }
        hub.activity.insert(id.clone(), (json, value.clone()));
        activity_frame.insert(id.clone(), value);
    }
    let mut peeks_frame = Map::new();
    for (id, value) in pane_ids.iter().zip(peeked) {
        let json = js::stringify(&value);
        if hub.peeks.get(id).is_some_and(|(held, _)| *held == json) {
            continue;
        }
        hub.peeks.insert(id.clone(), (json, value.clone()));
        peeks_frame.insert(id.clone(), value);
    }
    // Ids that left the candidate or pane sets are forgotten, so one that comes back is read and sent
    // afresh.
    hub.activity.retain(|id, _| candidates.contains_key(id));
    hub.parked.retain(|id, _| candidates.contains_key(id));
    hub.peeks.retain(|id, _| panes.contains_key(id));
    hub.whole_live = None;

    let grades_moved = read_grades(server, &mut inner);
    let hub = &mut inner.hub;
    let mut fields = Map::new();
    if !activity_frame.is_empty() {
        fields.insert("activity".into(), Value::Object(activity_frame));
    }
    if !peeks_frame.is_empty() {
        fields.insert("peeks".into(), Value::Object(peeks_frame));
    }
    if grades_moved {
        fields.insert("grades".into(), hub.grades.1.clone());
    }
    if !fields.is_empty() {
        let text = push::frame("live", fields);
        // Grades go to hidden tabs too: they are rare and cheap, and the tab comes back current.
        let hidden = grades_moved.then(|| grades_frame(hub));
        for entry in hub.sockets.values().filter(|entry| entry.member) {
            if entry.visible {
                send_to(entry, &text);
            } else if let Some(hidden) = &hidden {
                send_to(entry, hidden);
            }
        }
    }
}

fn grades_frame(hub: &HubState) -> String {
    let mut fields = Map::new();
    fields.insert("grades".into(), hub.grades.1.clone());
    push::frame("live", fields)
}

// Re-derives the grades; true when they moved since they were last sent.
fn read_grades(server: &Server, inner: &mut Inner) -> bool {
    server.refresh_meta(inner, None);
    let value = serde_json::to_value(server.pool_grades(inner)).unwrap_or_else(|_| json!({}));
    let json = js::stringify(&value);
    if json == inner.hub.grades.0 {
        return false;
    }
    inner.hub.grades = (json, value);
    inner.hub.whole_live = None;
    true
}

// An events file changed: the grades may have, and they go to every tab.
fn check_grades_soon(server: &Server, inner: &mut Inner) {
    if inner.hub.closed || inner.hub.grades_soon.is_some() {
        return;
    }
    inner.hub.grades_soon = Some(after(server, server.0.check, |server, id| async move {
        let mut inner = server.lock();
        if fired(&mut inner.hub.grades_soon, id) && read_grades(&server, &mut inner) {
            let frame = grades_frame(&inner.hub);
            inner.hub.broadcast(&frame);
        }
    }));
}

fn visible_changed(server: &Server, inner: &mut Inner) {
    let hub = &mut inner.hub;
    if hub.visible_count > 0 && hub.live_timer.is_none() && !hub.closed {
        hub.live_timer = Some(every(
            server,
            Duration::from_millis(LIVE_CHECK_MS),
            |server| {
                let server = server.clone();
                server.0.runtime.clone().spawn(check_live(server));
            },
        ));
    } else if hub.visible_count == 0 {
        cancel(&mut hub.live_timer);
    }
}

// ---------------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------------

// The ids the pushed snapshot holds, gathered once per version: a card is one the Console found there.
fn known(hub: &mut HubState, id: &str) -> bool {
    let rev = hub.rev();
    if hub.known_ids.as_ref().is_none_or(|(of, _)| *of != rev) {
        let mut ids = HashSet::new();
        if let Some(state) = hub
            .last_pushed
            .as_ref()
            .and_then(|p| p.snapshot.get("state"))
        {
            for key in ["tickets", "conversations"] {
                for entity in state
                    .get(key)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(id) = entity.get("id").and_then(Value::as_str) {
                        ids.insert(id.to_owned());
                    }
                }
            }
        }
        hub.known_ids = Some((rev, ids));
    }
    hub.known_ids
        .as_ref()
        .is_some_and(|(_, ids)| ids.contains(id))
}

// A file's identity and size for change detection. Not the stat cache's stamp, which goes null for two
// seconds after every write.
fn sig_of(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => format!(
            "{}:{}:{}",
            meta.ino(),
            meta.len(),
            js::number_string(js::mtime_ms(&meta))
        ),
        Err(_) => "absent".to_owned(),
    }
}

fn events_path(server: &Server, id: &str) -> PathBuf {
    server.0.runs_dir.join(format!("{id}{EVENTS_SUFFIX}"))
}

fn events_json(server: &Server, inner: &mut Inner, id: &str) -> String {
    server.refresh_meta(inner, None);
    js::stringify(&reads::card_events(reads::ticket_events(
        &server.0.runs_dir,
        id,
        &inner.meta,
    )))
}

// Re-reads a card's body and events when their files moved, and sends every subscriber what changed in
// one frame. Both are read before either is kept, so a read that fails leaves the card as it was.
fn refresh_card(server: &Server, inner: &mut Inner, id: &str) -> Result<(), String> {
    let body_file = reads::ticket_body_file(&server.0.issues_dir, id);
    let body_sig = match &body_file {
        None => "none".to_owned(),
        Some(file) => format!("{}:{}", file.display(), sig_of(file)),
    };
    let events_sig = sig_of(&events_path(server, id));
    let Some(card) = inner.hub.watches.get(id) else {
        return Ok(());
    };
    let body_moved = card.body_sig.as_deref() != Some(body_sig.as_str());
    if !body_moved && card.events_sig.as_deref() == Some(events_sig.as_str()) {
        return Ok(());
    }
    let body_json = if body_moved {
        js::to_json(&reads::ticket_body(&server.0.issues_dir, id)?)
    } else {
        card.body_json.clone()
    };
    let events_json = events_json(server, inner, id);
    let Some(card) = inner.hub.watches.get_mut(id) else {
        return Ok(());
    };
    let mut fields = Vec::new();
    if body_json != card.body_json {
        fields.push(format!("\"body\":{body_json}"));
    }
    if events_json != card.events_json {
        fields.push(format!("\"events\":{events_json}"));
    }
    card.body_sig = Some(body_sig);
    card.body_json = body_json;
    card.events_sig = Some(events_sig);
    card.events_json = events_json;
    if !fields.is_empty() && !card.subscribers.is_empty() {
        let text = format!(
            "{{\"type\":\"card\",\"id\":{},{}}}",
            js::to_json(&Value::from(id)),
            fields.join(",")
        );
        let subscribers: Vec<u64> = card.subscribers.iter().copied().collect();
        for socket in subscribers {
            inner.hub.send(socket, &text);
        }
    }
    Ok(())
}

struct Attempts {
    list: Vec<LogAttemptInfo>,
    json: String,
}

fn attempts_of(server: &Server, id: &str) -> Attempts {
    let list = list_attempt_logs(&server.0.runs_dir, id);
    let json = js::to_json(&list);
    Attempts { list, json }
}

struct Target {
    attempt: u64,
    stream: bool,
    file: String,
}

// The log a follow reads: the attempt picked, or the latest when none was, and its derived log or Stream
// file. None while the card has no attempt, or the attempt no Stream file.
fn target_of(follow: &Follow, attempts: &[LogAttemptInfo]) -> Option<Target> {
    let info = match follow.attempt {
        None => attempts.last(),
        Some(attempt) => attempts.iter().find(|a| a.attempt as f64 == attempt),
    }?;
    let file = if follow.stream {
        info.stream_file.clone()?
    } else {
        info.log_file.clone()
    };
    Some(Target {
        attempt: info.attempt,
        stream: follow.stream,
        file,
    })
}

fn follow_of(value: Option<&Value>) -> Follow {
    let object = value.filter(|v| v.is_object());
    Follow {
        attempt: object
            .and_then(|v| v.get("attempt"))
            .and_then(js::number_of),
        stream: object.and_then(|v| v.get("stream")) == Some(&Value::Bool(true)),
    }
}

fn ino_of(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.ino()).unwrap_or(0)
}

// A log window: the last LOG_CHUNK_BYTES of the followed file.
fn window_of(server: &Server, target: &Target, attempts: &Attempts) -> Result<Value, String> {
    let path = server.0.runs_dir.join(&target.file);
    let range = reads::read_log_range(&path, reads::log_tail_offset(&path), None)?;
    let mut push = Map::new();
    push.insert("mode".into(), Value::from("window"));
    push.insert("attempt".into(), Value::from(target.attempt));
    push.insert("stream".into(), Value::from(target.stream));
    push.extend(range.fields());
    push.insert(
        "attempts".into(),
        serde_json::to_value(&attempts.list).unwrap_or(Value::Null),
    );
    Ok(Value::Object(push))
}

fn card_frame(id: &str, field: &str, value: Value) -> String {
    let mut fields = Map::new();
    fields.insert("id".into(), Value::from(id));
    fields.insert(field.into(), value);
    push::frame("card", fields)
}

// What one check read, by path: subscribers that follow the same file share one stat, and those at the
// same place in it share one read.
#[derive(Default)]
struct CheckMemo {
    stats: HashMap<PathBuf, Option<(u64, u64)>>,
    frames: HashMap<String, (Vec<String>, u64, u64)>,
}

// Brings one socket's log for one card up to date: appends from where it is, or a window when it
// follows another attempt now, the file was replaced or shrank, or more was missed than the pane keeps.
fn push_log(
    server: &Server,
    inner: &mut Inner,
    socket: u64,
    id: &str,
    attempts: &Attempts,
    memo: &mut CheckMemo,
) -> Result<(), String> {
    let Some(sub) = inner.hub.sockets.get(&socket).and_then(|s| s.cards.get(id)) else {
        return Ok(());
    };
    let Some(target) = target_of(&sub.follow, &attempts.list) else {
        return Ok(());
    };
    let path = server.0.runs_dir.join(&target.file);
    let stat = *memo.stats.entry(path.clone()).or_insert_with(|| {
        std::fs::metadata(&path)
            .ok()
            .map(|meta| (meta.ino(), meta.len()))
    });
    let (ino, size) = stat.unwrap_or((0, 0));
    let held = sub.log.clone();
    let continues = held.as_ref().is_some_and(|held| {
        held.attempt == target.attempt
            && held.stream == target.stream
            && (held.ino == ino || held.ino == 0)
            && size >= held.offset
            && size - held.offset <= LOG_PANE_MAX_BYTES
    });
    let sub_attempts = sub.attempts.clone();
    if !continues {
        let key = format!("window:{}", path.display());
        if !memo.frames.contains_key(&key) {
            let push = window_of(server, &target, attempts)?;
            let next = push.get("nextOffset").and_then(Value::as_u64).unwrap_or(0);
            memo.frames
                .insert(key.clone(), (vec![card_frame(id, "log", push)], ino, next));
        }
        let (texts, made_ino, next) = memo.frames[&key].clone();
        for text in &texts {
            inner.hub.send(socket, text);
        }
        if let Some(sub) = inner
            .hub
            .sockets
            .get_mut(&socket)
            .and_then(|s| s.cards.get_mut(id))
        {
            sub.log = Some(HeldLog {
                attempt: target.attempt,
                stream: target.stream,
                ino: made_ino,
                offset: next,
            });
            sub.attempts = Some(attempts.json.clone());
        }
        return Ok(());
    }
    let held = held.unwrap_or(HeldLog {
        attempt: 0,
        stream: false,
        ino: 0,
        offset: 0,
    });
    if let Some(sub) = inner
        .hub
        .sockets
        .get_mut(&socket)
        .and_then(|s| s.cards.get_mut(id))
        && let Some(log) = sub.log.as_mut()
    {
        log.ino = ino;
    }
    let with_attempts = sub_attempts.as_deref() != Some(attempts.json.as_str());
    if size == held.offset && !with_attempts {
        return Ok(());
    }
    let key = format!(
        "append:{}:{}:{}",
        path.display(),
        held.offset,
        with_attempts
    );
    if !memo.frames.contains_key(&key) {
        let (texts, next) = appends_of(
            id,
            &target,
            &path,
            held.offset,
            with_attempts.then_some(&attempts.list),
        )?;
        memo.frames.insert(key.clone(), (texts, ino, next));
    }
    let (texts, _, next) = memo.frames[&key].clone();
    for text in &texts {
        inner.hub.send(socket, text);
    }
    if let Some(sub) = inner
        .hub
        .sockets
        .get_mut(&socket)
        .and_then(|s| s.cards.get_mut(id))
    {
        if let Some(log) = sub.log.as_mut() {
            log.offset = next;
        }
        sub.attempts = Some(attempts.json.clone());
    }
    Ok(())
}

// The bytes past `from`, in LOG_CHUNK_BYTES appends. An attempt list that changed rides the first one,
// which is sent even with no new bytes so the list still arrives.
fn appends_of(
    id: &str,
    target: &Target,
    path: &Path,
    from: u64,
    attempts: Option<&Vec<LogAttemptInfo>>,
) -> Result<(Vec<String>, u64), String> {
    let mut texts = Vec::new();
    let mut offset = from;
    let mut carry = attempts;
    for _ in 0..APPENDS_PER_CHECK {
        let range = reads::read_log_range(path, offset as f64, None)?;
        let next = range.next_offset as u64;
        let moved = next > offset;
        if !moved && carry.is_none() {
            break;
        }
        let mut log = Map::new();
        log.insert("mode".into(), Value::from("append"));
        log.insert("attempt".into(), Value::from(target.attempt));
        log.insert("stream".into(), Value::from(target.stream));
        log.extend(range.fields());
        if let Some(list) = carry.take() {
            log.insert(
                "attempts".into(),
                serde_json::to_value(list).unwrap_or(Value::Null),
            );
        }
        texts.push(card_frame(id, "log", Value::Object(log)));
        // A character or an escape sequence still arriving stops the read short; the next check
        // brings it.
        if !moved {
            break;
        }
        offset = next;
        if offset >= range.total_size {
            break;
        }
    }
    Ok((texts, offset))
}

// One card's check: its body and events for every subscriber, and its log for every visible one.
fn check_card(server: &Server, inner: &mut Inner, id: &str) -> Result<(), String> {
    refresh_card(server, inner, id)?;
    let Some(card) = inner.hub.watches.get(id) else {
        return Ok(());
    };
    let subscribers: Vec<u64> = card.subscribers.iter().copied().collect();
    let mut attempts = None;
    let mut memo = CheckMemo::default();
    for socket in subscribers {
        let Some(entry) = inner.hub.sockets.get(&socket) else {
            continue;
        };
        if !entry.visible || !entry.cards.contains_key(id) {
            continue;
        }
        let attempts = attempts.get_or_insert_with(|| attempts_of(server, id));
        push_log(server, inner, socket, id, attempts, &mut memo)?;
    }
    Ok(())
}

fn check_card_quietly(server: &Server, inner: &mut Inner, id: &str) {
    if let Err(err) = check_card(server, inner, id) {
        eprintln!("card {id}: {err}");
    }
}

fn check_card_soon(server: &Server, inner: &mut Inner, id: &str) {
    if !inner.hub.watches.contains_key(id) {
        return;
    }
    inner.hub.dirty.insert(id.to_owned());
    if inner.hub.closed || inner.hub.card_timer.is_some() {
        return;
    }
    inner.hub.card_timer = Some(after(server, server.0.check, |server, timer| async move {
        let mut inner = server.lock();
        if !fired(&mut inner.hub.card_timer, timer) {
            return;
        }
        let ids: Vec<String> = inner.hub.dirty.drain(..).collect();
        for id in ids {
            if inner.hub.watches.contains_key(&id) {
                check_card_quietly(&server, &mut inner, &id);
            }
        }
    }));
}

fn refuse_card(hub: &HubState, socket: u64, id: &str, error: &str) {
    hub.send(socket, &card_frame(id, "error", Value::from(error)));
}

fn subscribe(server: &Server, inner: &mut Inner, socket: u64, subscription: &Value) {
    let id = subscription
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if !known(&mut inner.hub, &id) {
        unsubscribe(inner, socket, &id);
        refuse_card(&inner.hub, socket, &id, &format!("unknown ticket {id}"));
        return;
    }
    let holds = inner
        .hub
        .sockets
        .get(&socket)
        .is_some_and(|s| s.cards.contains_key(&id));
    let held_count = inner.hub.sockets.get(&socket).map_or(0, |s| s.cards.len());
    if !holds && held_count >= CARDS_PER_SOCKET {
        refuse_card(
            &inner.hub,
            socket,
            &id,
            &format!("a socket holds at most {CARDS_PER_SOCKET} cards"),
        );
        return;
    }
    let held = inner.hub.watches.contains_key(&id);
    if !held {
        inner.hub.watches.insert(
            id.clone(),
            CardWatch {
                subscribers: IndexSet::new(),
                body_sig: None,
                body_json: String::new(),
                events_sig: None,
                events_json: String::new(),
            },
        );
    }
    let mut sub = CardSub {
        follow: follow_of(subscription.get("follow")),
        log: None,
        attempts: None,
    };
    let read = (|| -> Result<Option<Value>, String> {
        // Anything that moved since the card was last read goes to the sockets already holding it,
        // before this one joins them.
        refresh_card(server, inner, &id)?;
        let attempts = attempts_of(server, &id);
        let Some(target) = target_of(&sub.follow, &attempts.list) else {
            return Ok(None);
        };
        let ino = ino_of(&server.0.runs_dir.join(&target.file));
        let log = window_of(server, &target, &attempts)?;
        sub.log = Some(HeldLog {
            attempt: target.attempt,
            stream: target.stream,
            ino,
            offset: log.get("nextOffset").and_then(Value::as_u64).unwrap_or(0),
        });
        sub.attempts = Some(attempts.json);
        Ok(Some(log))
    })();
    let log = match read {
        Ok(log) => log,
        Err(err) => {
            // Nothing is kept of a card whose files could not be read: the tab is told, and its next
            // subscribe reads the card afresh.
            if !held {
                inner.hub.watches.shift_remove(&id);
            }
            unsubscribe(inner, socket, &id);
            refuse_card(
                &inner.hub,
                socket,
                &id,
                &format!("card {id} could not be read: {err}"),
            );
            return;
        }
    };
    if let Some(entry) = inner.hub.sockets.get_mut(&socket) {
        entry.cards.insert(id.clone(), sub);
    }
    let Some(card) = inner.hub.watches.get_mut(&id) else {
        return;
    };
    card.subscribers.insert(socket);
    // The three in one frame, so they paint in one render, spliced from the JSON already made.
    let text = format!(
        "{{\"type\":\"card\",\"id\":{},\"body\":{},\"events\":{},\"log\":{}}}",
        js::to_json(&Value::from(id.as_str())),
        card.body_json,
        card.events_json,
        js::stringify(&log.unwrap_or(Value::Null)),
    );
    inner.hub.send(socket, &text);
}

fn unsubscribe(inner: &mut Inner, socket: u64, id: &str) {
    if let Some(entry) = inner.hub.sockets.get_mut(&socket) {
        entry.cards.shift_remove(id);
    }
    let Some(card) = inner.hub.watches.get_mut(id) else {
        return;
    };
    card.subscribers.shift_remove(&socket);
    if card.subscribers.is_empty() {
        inner.hub.watches.shift_remove(id);
        inner.hub.dirty.shift_remove(id);
    }
}

// `log.follow`: point the card's appends at another attempt or variant, answering with that file's tail
// window, named by the attempt and variant it was read from.
fn follow(server: &Server, inner: &mut Inner, socket: u64, payload: &Map<String, Value>) -> Answer {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let wanted = follow_of(Some(&Value::Object(payload.clone())));
    let read = routes::log_read(
        server,
        inner,
        LogQuery {
            id: id.clone(),
            attempt: wanted.attempt,
            offset: LogOffset::Tail,
            end: None,
            stream: wanted.stream,
        },
    );
    // The follow moves even when there is nothing to read yet.
    let holds = inner
        .hub
        .sockets
        .get_mut(&socket)
        .and_then(|s| s.cards.get_mut(&id))
        .map(|sub| {
            sub.follow = wanted.clone();
            sub.log = None;
            sub.attempts = None;
        })
        .is_some();
    let read = match read {
        Ok(read) => read,
        Err(refusal) => return refusal,
    };
    let Some(target) = target_of(&wanted, &read.attempts) else {
        return Answer::Thrown("log.follow: no target".to_owned());
    };
    if holds
        && let Some(sub) = inner
            .hub
            .sockets
            .get_mut(&socket)
            .and_then(|s| s.cards.get_mut(&id))
    {
        sub.log = Some(HeldLog {
            attempt: target.attempt,
            stream: target.stream,
            ino: ino_of(&server.0.runs_dir.join(&target.file)),
            offset: read.range.next_offset as u64,
        });
        sub.attempts = Some(js::to_json(&read.attempts));
    }
    let mut result = read.range.fields();
    result.insert(
        "attempts".into(),
        serde_json::to_value(&read.attempts).unwrap_or(Value::Null),
    );
    result.insert("attempt".into(), Value::from(target.attempt));
    result.insert("stream".into(), Value::from(target.stream));
    Answer::ok_value(200, Value::Object(result))
}

// The runs and issues directories, watched while any socket is open: the runs one also moves the
// grades. Non-recursive; an event that names no file checks every card.
fn watch_files(server: &Server, inner: &mut Inner) {
    if !inner.hub.watchers.is_empty() {
        return;
    }
    for (dir, runs) in [(&server.0.runs_dir, true), (&server.0.issues_dir, false)] {
        let watched = server.clone();
        let handler = move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else {
                return;
            };
            let names: Vec<Option<String>> = if event.paths.is_empty() {
                vec![None]
            } else {
                event
                    .paths
                    .iter()
                    .map(|path| path.file_name().map(|n| n.to_string_lossy().into_owned()))
                    .collect()
            };
            let mut inner = watched.lock();
            if inner.hub.closed {
                return;
            }
            for name in names {
                on_file(&watched, &mut inner, runs, name.as_deref());
            }
        };
        let Ok(mut watcher) = notify::recommended_watcher(handler) else {
            continue;
        };
        use notify::Watcher;
        // Not watchable here: the live check's stat still finds changes.
        if watcher
            .watch(dir, notify::RecursiveMode::NonRecursive)
            .is_ok()
        {
            inner.hub.watchers.push(watcher);
        }
    }
}

fn on_file(server: &Server, inner: &mut Inner, runs: bool, name: Option<&str>) {
    if runs && name.is_none_or(|name| name.ends_with(EVENTS_SUFFIX)) {
        check_grades_soon(server, inner);
    }
    let ids: Vec<String> = inner.hub.watches.keys().cloned().collect();
    for id in ids {
        let touched = match name {
            None => true,
            Some(name) if runs => name.starts_with(&format!("{id}.")),
            Some(name) => name == format!("{id}.md") || name.starts_with(&format!("{id}-")),
        };
        if touched {
            check_card_soon(server, inner, &id);
        }
    }
}

fn unwatch_files(hub: &mut HubState) {
    hub.watchers.clear();
}

// ---------------------------------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------------------------------

fn set_visible(server: &Server, inner: &mut Inner, socket: u64, visible: bool) {
    let Some(entry) = inner.hub.sockets.get_mut(&socket) else {
        return;
    };
    if entry.visible == visible {
        return;
    }
    entry.visible = visible;
    if visible {
        inner.hub.visible_count += 1;
    } else {
        inner.hub.visible_count -= 1;
    }
    visible_changed(server, inner);
    if !visible {
        return;
    }
    // Back in view: the live values as they stand, each card's log from where the tab left it, then
    // a fresh check.
    if let Some(whole) = whole_live_frame(&mut inner.hub) {
        inner.hub.send(socket, &whole);
    }
    let cards: Vec<String> = inner
        .hub
        .sockets
        .get(&socket)
        .map(|s| s.cards.keys().cloned().collect())
        .unwrap_or_default();
    for id in cards {
        if !inner.hub.watches.contains_key(&id) {
            continue;
        }
        let attempts = attempts_of(server, &id);
        if let Err(err) = push_log(
            server,
            inner,
            socket,
            &id,
            &attempts,
            &mut CheckMemo::default(),
        ) {
            eprintln!("card {id}: {err}");
        }
    }
    check_live_soon(server, inner);
}

fn hello(server: &Server, inner: &mut Inner, socket: u64, visible: bool, cards: &[Value]) {
    // The hello's cards are the whole of what the tab holds, up to the cap.
    let held = &cards[..cards.len().min(CARDS_PER_SOCKET)];
    let wanted: HashSet<&str> = held
        .iter()
        .filter_map(|card| card.get("id").and_then(Value::as_str))
        .collect();
    let holding: Vec<String> = inner
        .hub
        .sockets
        .get(&socket)
        .map(|s| s.cards.keys().cloned().collect())
        .unwrap_or_default();
    for id in holding {
        if !wanted.contains(id.as_str()) {
            unsubscribe(inner, socket, &id);
        }
    }
    set_visible(server, inner, socket, visible);
    for card in held {
        subscribe(server, inner, socket, card);
    }
}

fn reply_frame(id: u64, kind: RequestKind, rev: u64, answer: &Answer) -> Result<String, String> {
    let mut fields = Map::new();
    fields.insert("id".into(), Value::from(id));
    fields.insert("kind".into(), Value::from(kind.as_str()));
    fields.insert("rev".into(), Value::from(rev));
    match answer {
        Answer::Ok { result, .. } => {
            let result = result.clone()?;
            fields.insert("ok".into(), Value::Bool(true));
            fields.insert("result".into(), result);
        }
        Answer::Refused { status, reason, .. } => {
            fields.insert("ok".into(), Value::Bool(false));
            fields.insert(
                "refusal".into(),
                json!({ "reason": reason, "status": status }),
            );
        }
        Answer::Thrown(reason) => {
            fields.insert("ok".into(), Value::Bool(false));
            fields.insert("refusal".into(), json!({ "reason": reason, "status": 500 }));
        }
    }
    Ok(push::frame("reply", fields))
}

// A result the frame cannot carry is refused instead, so its press is still answered and the socket
// stays up.
fn reply(hub: &HubState, socket: u64, id: u64, kind: RequestKind, answer: &Answer) {
    let text = reply_frame(id, kind, hub.rev(), answer).unwrap_or_else(|err| {
        eprintln!("socket: reply to {} {id}: {err}", kind.as_str());
        let refusal = Answer::refused(
            500,
            routes::Field::Error,
            format!("could not encode the result: {err}"),
        );
        reply_frame(id, kind, hub.rev(), &refusal).unwrap_or_default()
    });
    hub.send(socket, &text);
}

async fn request(
    server: Server,
    socket: u64,
    id: u64,
    kind: RequestKind,
    payload: Map<String, Value>,
) {
    let answer = if kind == RequestKind::LogFollow {
        let mut inner = server.lock();
        follow(&server, &mut inner, socket, &payload)
    } else {
        routes::socket_request(&server, kind, payload).await
    };
    let mut inner = server.lock();
    // An action's effect goes out as a delta ahead of its reply.
    if kind.is_action() {
        flush_quietly(&server, &mut inner);
    }
    reply(&inner.hub, socket, id, kind, &answer);
}

// A frame that is not this protocol's is logged and dropped; a request that can still be answered is
// refused, so its press does not hang.
fn undecodable(inner: &mut Inner, socket: u64, raw: &str, err: &ProtocolError) {
    eprintln!("socket: dropped a frame: {err}");
    let Ok(frame) = push::envelope(raw) else {
        return;
    };
    if frame.get("type").and_then(Value::as_str) != Some("request") || !push::is_id(frame.get("id"))
    {
        return;
    }
    let Some(kind) = frame
        .get("kind")
        .and_then(Value::as_str)
        .and_then(RequestKind::parse)
    else {
        return;
    };
    let id = frame.get("id").and_then(js::number_of).unwrap_or(0.0) as u64;
    reply(
        &inner.hub,
        socket,
        id,
        kind,
        &Answer::refused(400, routes::Field::Error, err.0.clone()),
    );
}

fn message(server: &Server, inner: &mut Inner, socket: u64, raw: &str) {
    match decode_client_message(raw) {
        Err(err) => undecodable(inner, socket, raw, &err),
        Ok(ClientFrame::Hello { visible, cards }) => hello(server, inner, socket, visible, &cards),
        Ok(ClientFrame::Visibility { visible }) => set_visible(server, inner, socket, visible),
        Ok(ClientFrame::Subscribe { card }) => subscribe(server, inner, socket, &card),
        Ok(ClientFrame::Unsubscribe { id }) => unsubscribe(inner, socket, &id),
        Ok(ClientFrame::Request { id, kind, payload }) => {
            server
                .0
                .runtime
                .spawn(request(server.clone(), socket, id, kind, payload));
        }
    }
}

// A socket just opened: anything waiting goes to the sockets already open first, so this one starts
// from the version they are all at; then hello, the snapshot, and the live values as they stand.
fn opened(server: &Server, inner: &mut Inner, socket: u64) -> Result<(), String> {
    flush_quietly(server, inner);
    let hello = inner.hub.hello_frame.clone();
    inner.hub.send(socket, &hello);
    let snapshot = snapshot_frame(&mut inner.hub)?;
    inner.hub.send(socket, &snapshot);
    if inner.hub.closed {
        // Opened in a stop's last moments: the farewell, and the same close.
        inner.hub.close_socket(socket);
        return Ok(());
    }
    if let Some(entry) = inner.hub.sockets.get_mut(&socket) {
        entry.member = true;
    }
    if inner.hub.sockets.values().filter(|e| e.member).count() == 1 {
        let period = server.0.heartbeat;
        inner.hub.heartbeat = Some(every(server, period, |server| {
            server.lock().hub.broadcast(HEARTBEAT_FRAME);
        }));
        watch_files(server, inner);
    }
    // Visible until its hello says otherwise.
    inner.hub.visible_count += 1;
    visible_changed(server, inner);
    if let Some(whole) = whole_live_frame(&mut inner.hub) {
        inner.hub.send(socket, &whole);
    }
    check_live_soon(server, inner);
    Ok(())
}

fn socket_closed(server: &Server, inner: &mut Inner, socket: u64) {
    let Some(entry) = inner.hub.sockets.get_mut(&socket) else {
        return;
    };
    entry.open = false;
    let member = entry.member;
    let visible = entry.visible;
    if !member {
        inner.hub.sockets.shift_remove(&socket);
        return;
    }
    let cards: Vec<String> = entry.cards.keys().cloned().collect();
    for id in cards {
        unsubscribe(inner, socket, &id);
    }
    inner.hub.sockets.shift_remove(&socket);
    if visible {
        inner.hub.visible_count -= 1;
        visible_changed(server, inner);
    }
    if !inner.hub.sockets.values().any(|e| e.member) {
        cancel(&mut inner.hub.heartbeat);
        unwatch_files(&mut inner.hub);
    }
}

/// Serve one upgraded socket: register it, say hello, then read its frames until it closes, while a
/// writer drains what the hub queues for it.
pub(crate) async fn serve_socket(server: Server, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
    let queued = Arc::new(AtomicUsize::new(0));
    let terminated = Arc::new(Notify::new());
    let id = next_id();
    {
        let mut inner = server.lock();
        inner.hub.sockets.insert(
            id,
            SocketEntry {
                tx,
                queued: queued.clone(),
                terminated: terminated.clone(),
                visible: true,
                cards: IndexMap::new(),
                open: true,
                member: false,
            },
        );
        // A throw out of the open handler drops the socket with no close frame, logged.
        if let Err(err) = opened(&server, &mut inner, id) {
            eprintln!("socket: open: {err}");
            if let Some(entry) = inner.hub.sockets.get(&id) {
                let _ = entry.tx.send(Outgoing::Terminate);
            }
            terminated.notify_one();
        }
    }
    let writer_queued = queued.clone();
    let writer_terminated = terminated.clone();
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            match out {
                Outgoing::Text(text) => {
                    let len = text.len();
                    let sent = sink.send(Message::Text(text)).await;
                    writer_queued.fetch_sub(len, Ordering::SeqCst);
                    if sent.is_err() {
                        break;
                    }
                }
                Outgoing::Close(code, reason) => {
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: Utf8Bytes::from_static(reason),
                        })))
                        .await;
                    break;
                }
                Outgoing::Terminate => {
                    writer_terminated.notify_one();
                    break;
                }
            }
        }
    });
    loop {
        tokio::select! {
            _ = terminated.notified() => break,
            frame = stream.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    let mut inner = server.lock();
                    message(&server, &mut inner, id, text.as_str());
                }
                Some(Ok(Message::Binary(_))) => eprintln!("socket: dropped a binary frame"),
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
    {
        let mut inner = server.lock();
        socket_closed(&server, &mut inner, id);
    }
    writer.abort();
}

/// The served index.html with the first snapshot in it, after a flush, so the Console paints before
/// any script runs or the socket opens; `None` when there is no such file. Read once per build and made
/// once per revision.
pub(crate) fn page(server: &Server, inner: &mut Inner) -> Option<String> {
    let file = server.0.ui.file("/index.html")?;
    if inner
        .hub
        .html
        .as_ref()
        .is_none_or(|(stamp, _)| *stamp != file.stamp)
    {
        inner.hub.html = Some((file.stamp, js::decode_utf8(&file.bytes)));
    }
    flush_quietly(server, inner);
    let rev = inner.hub.rev();
    let hub = &mut inner.hub;
    let (stamp, html) = hub.html.clone()?;
    if hub
        .made
        .as_ref()
        .is_none_or(|(at, made_rev, _)| *at != stamp || *made_rev != rev)
    {
        let boot = json!({
            "protocol": PROTOCOL_VERSION,
            "epoch": hub.epoch,
            "rev": rev,
            "logTotal": hub.last_pushed.as_ref().map_or(0, |p| p.log_total),
            "snapshot": hub.last_pushed.as_ref().map_or(Value::Null, |p| p.snapshot.clone()),
        });
        match push::embed_boot(&html, &boot) {
            Ok(text) => hub.made = Some((stamp, rev, text)),
            Err(err) => {
                // A version that no longer encodes whole: the page goes as built.
                eprintln!("page: {err}");
                return Some(html);
            }
        }
    }
    hub.made.as_ref().map(|(_, _, text)| text.clone())
}

/// Stop every timer and watch.
pub(crate) fn dispose(inner: &mut Inner) {
    let hub = &mut inner.hub;
    hub.closed = true;
    for timer in [
        &mut hub.send_timer,
        &mut hub.live_soon,
        &mut hub.card_timer,
        &mut hub.grades_soon,
        &mut hub.live_timer,
        &mut hub.heartbeat,
    ] {
        cancel(timer);
    }
    unwatch_files(hub);
}

/// The stop's farewell: flush, so the `stopped` delta goes, then close every socket with CLOSE_STOPPED.
pub(crate) fn close_sockets(server: &Server, inner: &mut Inner) {
    flush_quietly(server, inner);
    dispose(inner);
    let members: Vec<u64> = inner
        .hub
        .sockets
        .iter()
        .filter(|(_, e)| e.member)
        .map(|(id, _)| *id)
        .collect();
    for socket in members {
        inner.hub.close_socket(socket);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ws.test.ts:533: a result the frame cannot carry is refused with 500, and the socket keeps its
    // queue for the next reply.
    #[test]
    fn refuses_a_result_it_cannot_encode_and_answers_the_next() {
        let mut hub = HubState::new(Duration::from_millis(20_000));
        let (tx, mut rx) = mpsc::unbounded_channel();
        hub.sockets.insert(
            1,
            SocketEntry {
                tx,
                queued: Arc::new(AtomicUsize::new(0)),
                terminated: Arc::new(Notify::new()),
                visible: true,
                cards: IndexMap::new(),
                open: true,
                member: true,
            },
        );
        let unencodable = Answer::Ok {
            status: 200,
            result: Err("a circular reference".to_owned()),
        };
        reply(&hub, 1, 4, RequestKind::SettingsGet, &unencodable);
        reply(
            &hub,
            1,
            5,
            RequestKind::SettingsGet,
            &Answer::ok_value(200, json!({})),
        );
        let frames: Vec<Value> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|out| match out {
                Outgoing::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
                _ => panic!("only text"),
            })
            .collect();
        assert_eq!(
            frames,
            vec![
                json!({ "type": "reply", "id": 4, "kind": "settings.get", "rev": 0, "ok": false,
                    "refusal": { "reason": "could not encode the result: a circular reference", "status": 500 } }),
                json!({ "type": "reply", "id": 5, "kind": "settings.get", "rev": 0, "ok": true, "result": {} }),
            ]
        );
    }

    #[test]
    fn names_the_epoch_in_base36_with_six_random_characters() {
        let hub = HubState::new(Duration::from_millis(20_000));
        let (time, random) = hub.epoch.split_once('-').unwrap();
        assert!(!time.is_empty() && time.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(random.len(), 6);
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
    }
}
