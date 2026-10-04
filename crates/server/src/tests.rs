//! The server end to end over a real listener, with a stand-in engine whose snapshots the test
//! publishes by hand: what the conformance areas `http`, `socket` and `protocol` check, reachable before
//! the engine core lands, and the hidden rows the inventory gives the server.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{FutureExt, SinkExt, StreamExt};
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

use ac_core::machine_defaults::default_machine_defaults_paths;
use ac_engine::{Engine, PoolSnapshot, PoolState};
use ac_protocol::{RunPhase, SpawnUsage, StewardBudgetView, TicketStatus};

use crate::push::Pushed;
use crate::ui::Ui;
use crate::{PoolServerOptions, Server};

fn snapshot(
    seq: u64,
    phase: RunPhase,
    tickets: &[(&str, TicketStatus)],
    log: &[&str],
) -> PoolSnapshot {
    PoolSnapshot {
        seq,
        phase,
        state: PoolState {
            tickets: tickets
                .iter()
                .map(|(id, status)| ((*id).to_owned(), *status))
                .collect(),
            log: log.iter().map(|line| (*line).to_owned()).collect(),
            outcomes: IndexMap::new(),
            config: ac_core::config::PoolConfig::default(),
            interrupts: Vec::new(),
            review_approved: false,
        },
        queued_answers: Vec::new(),
        assignments: IndexMap::new(),
        conversations: Vec::new(),
        live_attempts: IndexMap::new(),
        held_panes: IndexMap::new(),
        finished_terminals: 0,
        merge_hold: Vec::new(),
        merge_queue: Vec::new(),
        spawn_usage: SpawnUsage {
            spawned_this_run: 0,
            per_attempt: 5,
            per_run: 20,
        },
        pending_spawns: Vec::new(),
        held_spawns: Vec::new(),
        steward_budget: StewardBudgetView {
            budget: 5,
            used: IndexMap::new(),
        },
    }
}

// A stand-in engine: the real actor, holding a placeholder session whose publisher the test drives.
async fn fake_engine(first: PoolSnapshot) -> Engine {
    let (publisher, snapshots) = watch::channel(None);
    let session = ac_engine::session::stand_in_session(publisher);
    let engine = Engine::spawn(session, snapshots, |session, engine| {
        session.engine = Some(engine)
    });
    publish(&engine, first).await;
    engine
}

async fn publish(engine: &Engine, snapshot: PoolSnapshot) {
    engine
        .call(move |session| {
            session.publisher.send_replace(Some(Arc::new(snapshot)));
        })
        .await
        .unwrap();
}

struct Rig {
    dir: tempfile::TempDir,
    server: Server,
    engine_slot: Arc<Mutex<Option<Engine>>>,
    stops: Arc<AtomicUsize>,
}

struct RigOptions {
    coalesce: Duration,
    hand_off_stop: bool,
    start: bool,
}

impl Default for RigOptions {
    fn default() -> Self {
        RigOptions {
            coalesce: Duration::from_millis(50),
            hand_off_stop: false,
            start: true,
        }
    }
}

async fn rig(options: RigOptions) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let pool = dir.path().join("pool");
    std::fs::create_dir_all(pool.join("issues")).unwrap();
    std::fs::create_dir_all(dir.path().join("ui")).unwrap();
    std::fs::write(
        dir.path().join("ui/index.html"),
        "<html><head><title>Console</title></head><body></body></html>",
    )
    .unwrap();
    std::fs::write(
        pool.join("issues/01-first.md"),
        "<!-- state: id=01 blocked-by=none status=done -->\n\n# First\n\nDone already.\n",
    )
    .unwrap();
    std::fs::write(
        pool.join("issues/02-second.md"),
        "<!-- state: id=02 blocked-by=01 status=ready -->\n\n# Second\n",
    )
    .unwrap();
    std::fs::write(
        pool.join("console.json"),
        r#"{ "defaults": { "harness": "claude", "model": "m" } }"#,
    )
    .unwrap();
    let engine_slot: Arc<Mutex<Option<Engine>>> = Arc::new(Mutex::new(None));
    let slot = engine_slot.clone();
    let stops = Arc::new(AtomicUsize::new(0));
    let counted = stops.clone();
    let home = dir.path().join("home").to_string_lossy().into_owned();
    let server = Server::create(PoolServerOptions {
        pool_dir: pool.to_string_lossy().into_owned(),
        port: Some(0.0),
        default_port: None,
        harnesses: None,
        ui: Some(Ui::Disk(dir.path().join("ui"))),
        registry_path: dir.path().join("pools.json").to_string_lossy().into_owned(),
        herdr_socket: dir.path().join("no-herdr.sock"),
        herdr_workspace: None,
        jev_api_key: None,
        jev_base_url: None,
        stream_heartbeat: None,
        snapshot_coalesce: Some(options.coalesce),
        enlist_poll: None,
        conversation_poll: None,
        enlist_teaching_wait: None,
        pane_survey: None,
        on_stop_requested: options.hand_off_stop.then(|| {
            Arc::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
            }) as crate::StopHandOff
        }),
        on_restart_requested: None,
        machine_defaults_paths: default_machine_defaults_paths(&home),
        parent_env: Default::default(),
        starter: Some(Arc::new(move |_options| {
            let slot = slot.clone();
            async move {
                let engine = fake_engine(snapshot(
                    0,
                    RunPhase::Quiescent,
                    &[("01", TicketStatus::Done)],
                    &["pool quiescent"],
                ))
                .await;
                *slot.lock().unwrap() = Some(engine.clone());
                Ok(engine)
            }
            .boxed()
        })),
    })
    .unwrap();
    if options.start {
        server.start().await.unwrap();
    }
    Rig {
        dir,
        server,
        engine_slot,
        stops,
    }
}

impl Rig {
    fn engine(&self) -> Engine {
        self.engine_slot.lock().unwrap().clone().unwrap()
    }

    fn pool(&self) -> std::path::PathBuf {
        self.dir.path().join("pool")
    }

    async fn http(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> (u16, Vec<(String, String)>, String) {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", self.server.port()))
            .await
            .unwrap();
        let body = body.unwrap_or("");
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).into_owned();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .filter_map(|line| line.split_once(": "))
            .map(|(k, v)| (k.to_ascii_lowercase(), v.to_owned()))
            .collect();
        (status, headers, body.to_owned())
    }

    async fn json(&self, method: &str, path: &str, body: Option<&str>) -> (u16, Value) {
        let (status, _, text) = self.http(method, path, body).await;
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::String(text)),
        )
    }

    async fn socket(&self) -> Socket {
        let (ws, _) = tokio_tungstenite::connect_async(format!(
            "ws://127.0.0.1:{}/api/ws",
            self.server.port()
        ))
        .await
        .unwrap();
        Socket { ws }
    }
}

struct Socket {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl Socket {
    async fn send(&mut self, value: Value) {
        self.ws
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    async fn send_text(&mut self, text: &str) {
        self.ws
            .send(Message::Text(text.to_owned().into()))
            .await
            .unwrap();
    }

    /// The next frame within `ms`, or None.
    async fn next_within(&mut self, ms: u64) -> Option<Message> {
        tokio::time::timeout(Duration::from_millis(ms), self.ws.next())
            .await
            .ok()
            .flatten()
            .map(Result::unwrap)
    }

    async fn frame(&mut self) -> Value {
        loop {
            match self.next_within(5_000).await.expect("a frame in time") {
                Message::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
                Message::Close(frame) => panic!("closed: {frame:?}"),
                _ => continue,
            }
        }
    }

    /// The next frame of a type, skipping others (heartbeats, live values).
    async fn frame_of(&mut self, kind: &str) -> Value {
        loop {
            let frame = self.frame().await;
            if frame["type"] == kind {
                return frame;
            }
        }
    }

    async fn hello(&mut self, cards: Value) {
        self.send(json!({ "type": "hello", "protocol": 1, "visible": true, "cards": cards }))
            .await;
    }
}

#[tokio::test]
async fn serves_the_enriched_snapshot_and_the_ticket_reads() {
    let rig = rig(RigOptions::default()).await;
    let (status, state) = rig.json("GET", "/api/state", None).await;
    assert_eq!(status, 200);
    let snapshot = &state["snapshot"];
    assert_eq!(snapshot["phase"], "quiescent");
    assert_eq!(
        snapshot["poolName"],
        format!(
            "{}/pool",
            rig.dir.path().file_name().unwrap().to_string_lossy()
        )
    );
    assert_eq!(snapshot["poolTitle"], Value::Null);
    assert_eq!(
        snapshot["stewardBudget"],
        json!({ "budget": 5, "used": {} })
    );
    assert_eq!(
        snapshot["state"]["tickets"][1],
        json!({
            "id": "02", "title": "Second", "blockedBy": ["01"], "status": "ready", "mergeState": null,
            "assignment": { "harness": "claude", "model": "m", "drivers": "implement" },
            "liveAttempt": null, "heldPane": null, "enlisted": false,
            "reassign": {
                "eligible": true, "reason": null, "verify": null,
                "sources": { "harness": "default", "model": "default", "effort": "unset", "drivers": "default" },
            },
        })
    );
    assert_eq!(
        snapshot["state"]["tickets"][0]["reassign"]["reason"],
        "done"
    );

    let (status, ticket) = rig.json("GET", "/api/ticket?id=01", None).await;
    assert_eq!(
        (status, ticket),
        (
            200,
            json!({ "id": "01", "body": "# First\n\nDone already.\n" })
        )
    );
    assert_eq!(
        rig.json("GET", "/api/ticket?id=zz", None).await,
        (404, json!({ "error": "not found" }))
    );
    assert_eq!(
        rig.json("GET", "/api/events?ticket=zz", None).await,
        (404, json!({ "error": "unknown ticket zz" }))
    );
    assert_eq!(
        rig.json("GET", "/api/events?ticket=01", None).await,
        (
            200,
            json!({ "events": [], "attempts": [], "reconstructed": true, "spec": "Done already." })
        )
    );
    assert_eq!(
        rig.json("GET", "/api/pool-log?before=nope", None).await,
        (400, json!({ "error": "before must be a line number" }))
    );
    assert_eq!(
        rig.json("GET", "/api/pool-log?before=1", None).await,
        (
            200,
            json!({ "start": 0, "lines": ["pool quiescent"], "total": 1 })
        )
    );
    assert_eq!(
        rig.json("GET", "/api/terminal/peek?ticket=01", None).await,
        (
            404,
            json!({ "error": "no terminal-backed pane for ticket 01" })
        )
    );
    assert_eq!(
        rig.json("GET", "/api/grades", None).await,
        (200, json!({ "grades": {} }))
    );
    assert_eq!(
        rig.json("POST", "/api/resume", Some("null")).await,
        (
            400,
            json!({ "error": "null is not an object (evaluating 'body.ticketId')" })
        )
    );
    assert_eq!(
        rig.json(
            "POST",
            "/api/resume",
            Some(r#"{"ticketId":"01","action":"nope"}"#)
        )
        .await,
        (
            400,
            json!({ "error": "unknown action \"nope\": expected one of resume, approve, reject, close, adopt" })
        )
    );
    assert_eq!(
        rig.json("POST", "/api/resume", Some("")).await,
        (400, json!({ "error": "Unexpected end of JSON input" }))
    );
    assert_eq!(
        rig.json("POST", "/api/conversations", Some("{")).await,
        (400, json!({ "reason": "invalid JSON body" }))
    );
    assert_eq!(
        rig.json("POST", "/api/stop", None).await,
        (
            409,
            json!({ "error": "pool is quiescent, not done: stop refused" })
        )
    );
    assert_eq!(
        rig.json("GET", "/api/panes", None).await,
        (
            409,
            json!({ "reason": "enlist requires a terminal-backed pool (set console.json \"terminal\": \"herdr\")" })
        )
    );
    assert_eq!(
        rig.json(
            "POST",
            "/api/steward/answer",
            Some(r#"{"conversation":"c1","action":"adopt"}"#)
        )
        .await,
        (
            400,
            json!({ "reason": "adopting a candidate is the operator's: leave the ticket with a note naming the one you recommend" })
        )
    );
    assert_eq!(
        rig.json("GET", "/api/steward/nope", None).await,
        (
            404,
            json!({ "reason": "no steward route /api/steward/nope" })
        )
    );
    let (status, settings) = rig.json("GET", "/api/settings", None).await;
    assert_eq!(status, 200);
    assert_eq!(
        settings["pool"]["bootOnly"],
        json!(["selection", "terminal", "port"])
    );
    assert_eq!(
        settings["harnesses"],
        json!(["claude", "cursor", "opencode"])
    );
}

#[tokio::test]
async fn reassigns_from_the_file_and_answers_with_the_fresh_snapshot() {
    let rig = rig(RigOptions::default()).await;
    let (status, answer) = rig
        .json(
            "PUT",
            "/api/reassign",
            Some(r#"{"tickets":["02"],"fields":{"model":"x-model"}}"#),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(answer["applied"], json!(["02"]));
    assert_eq!(answer["skipped"], json!([]));
    assert_eq!(
        answer["snapshot"]["state"]["tickets"][1]["assignment"]["model"],
        "x-model"
    );
    assert_eq!(
        rig.json(
            "PUT",
            "/api/reassign",
            Some(r#"{"tickets":["zz"],"fields":{}}"#)
        )
        .await,
        (400, json!({ "error": "reassign: unknown ticket 'zz'" }))
    );
    assert_eq!(
        rig.json("PUT", "/api/reassign", Some("[1]")).await,
        (500, json!({ "error": "reassign: body must be an object" }))
    );
}

#[tokio::test]
async fn serves_the_page_with_the_boot_snapshot_the_socket_repeats() {
    let rig = rig(RigOptions::default()).await;
    let (status, headers, page) = rig.http("GET", "/", None).await;
    assert_eq!(status, 200);
    assert!(headers.contains(&("content-type".into(), "text/html".into())));
    assert!(headers.contains(&("cache-control".into(), "no-store".into())));
    let start = page
        .find(r#"<script id="console-boot" type="application/json">"#)
        .unwrap();
    assert!(start < page.find("</head>").unwrap());
    let json_start = page[start..].find('>').unwrap() + start + 1;
    let json_end = page[json_start..].find("</script>").unwrap() + json_start;
    let boot: Value = serde_json::from_str(&page[json_start..json_end]).unwrap();
    let mut socket = rig.socket().await;
    let hello = socket.frame().await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["heartbeatMs"], 20000);
    assert_eq!(hello["epoch"], boot["epoch"]);
    let first = socket.frame().await;
    assert_eq!(first["type"], "snapshot");
    assert_eq!(first["rev"], boot["rev"]);
    assert_eq!(first["snapshot"], boot["snapshot"]);
    let (status, _, _) = rig.http("GET", "/missing.js", None).await;
    assert_eq!(status, 500);
}

#[tokio::test]
async fn refuses_a_cross_origin_socket_and_a_plain_request_at_its_path() {
    let rig = rig(RigOptions::default()).await;
    let (status, _, body) = rig.http("GET", "/api/ws", None).await;
    assert_eq!(
        (status, body.as_str()),
        (400, "expected a WebSocket upgrade")
    );
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", rig.server.port()))
        .await
        .unwrap();
    stream
        .write_all(b"GET /api/ws HTTP/1.1\r\nHost: localhost\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.unwrap();
    assert!(raw.starts_with("HTTP/1.1 403"));
    assert!(raw.ends_with("cross-origin socket refused"));
}

#[tokio::test]
async fn pushes_one_delta_per_coalesced_change_and_replies_after_it() {
    let rig = rig(RigOptions::default()).await;
    let mut socket = rig.socket().await;
    socket.frame_of("hello").await;
    let first = socket.frame_of("snapshot").await;
    assert_eq!(first["rev"], 1);
    for seq in 1..=3 {
        publish(
            &rig.engine(),
            snapshot(
                seq,
                RunPhase::Quiescent,
                &[("01", TicketStatus::Done)],
                &["pool quiescent", "more"],
            ),
        )
        .await;
    }
    let delta = socket.frame_of("delta").await;
    assert_eq!(delta["delta"]["base"], 1);
    assert_eq!(delta["delta"]["rev"], 2);
    assert_eq!(delta["delta"]["set"], json!({ "seq": 3 }));
    assert_eq!(
        delta["delta"]["log"],
        json!({ "append": ["more"], "total": 2 })
    );

    // A settings save is an action: the delta carrying its title goes ahead of the reply.
    socket
        .send(json!({ "type": "request", "id": 7, "kind": "settings.pool.put", "payload": { "config": { "title": "Renamed" } } }))
        .await;
    // The save's Config reload has the stand-in engine emit its own (empty) state too, so the delta
    // also carries that snapshot's seq and phase.
    let delta = socket.frame_of("delta").await;
    assert_eq!(delta["delta"]["set"]["poolTitle"], "Renamed");
    let reply = socket.frame_of("reply").await;
    assert_eq!(reply["id"], 7);
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["rev"], delta["delta"]["rev"]);
    // The stand-in's own emit replaced the published state; publish it again.
    publish(
        &rig.engine(),
        snapshot(
            4,
            RunPhase::Quiescent,
            &[("01", TicketStatus::Done)],
            &["pool quiescent", "more"],
        ),
    )
    .await;
    socket.frame_of("delta").await;

    // Refusals carry the HTTP twin's status.
    socket
        .send(json!({ "type": "request", "id": 8, "kind": "terminal.focus", "payload": { "ticketId": "01" } }))
        .await;
    let reply = socket.frame_of("reply").await;
    assert_eq!(
        reply["refusal"],
        json!({ "reason": "no terminal-backed pane for ticket 01", "status": 404 })
    );
    socket
        .send_text(r#"{"type":"request","id":9,"kind":"stop"}"#)
        .await;
    let reply = socket.frame_of("reply").await;
    assert_eq!(reply["id"], 9);
    assert_eq!(
        reply["refusal"],
        json!({ "reason": "request without payload", "status": 400 })
    );
    // Frames that are not this protocol's get no reply, and the socket stays up.
    for junk in [
        "nope",
        "[1]",
        r#"{"type":"nope"}"#,
        r#"{"type":"request","id":1,"kind":"rm -rf","payload":{}}"#,
    ] {
        socket.send_text(junk).await;
    }
    socket
        .send(json!({ "type": "request", "id": 10, "kind": "poolLog.read", "payload": { "before": 5, "limit": 1 } }))
        .await;
    let reply = socket.frame_of("reply").await;
    assert_eq!(reply["id"], 10);
    assert_eq!(
        reply["result"],
        json!({ "start": 1, "lines": ["more"], "total": 2 })
    );
}

#[tokio::test]
async fn pushes_every_emit_as_its_own_frame_with_a_zero_window() {
    let rig = rig(RigOptions {
        coalesce: Duration::ZERO,
        ..RigOptions::default()
    })
    .await;
    let mut socket = rig.socket().await;
    socket.frame_of("snapshot").await;
    for seq in 1..=3 {
        publish(
            &rig.engine(),
            snapshot(seq, RunPhase::Quiescent, &[("01", TicketStatus::Done)], &[]),
        )
        .await;
        let delta = socket.frame_of("delta").await;
        assert_eq!(delta["delta"]["set"]["seq"], seq);
    }
}

#[tokio::test]
async fn sends_a_subscribed_card_whole_then_its_appends_and_events() {
    let rig = rig(RigOptions::default()).await;
    let runs = rig.pool().join("runs");
    std::fs::create_dir_all(&runs).unwrap();
    std::fs::write(
        runs.join("01.events.jsonl"),
        "{\"at\":\"t\",\"attempt\":1,\"kind\":\"spawned\",\"payload\":{}}\n{\"at\":\"t\",\"attempt\":1,\"kind\":\"exited\",\"payload\":{\"logTail\":[\"x\"],\"code\":0}}\n",
    )
    .unwrap();
    std::fs::write(runs.join("01.log"), "first line\n").unwrap();
    let mut socket = rig.socket().await;
    socket.frame_of("snapshot").await;
    socket.hello(json!([{ "id": "01" }, { "id": "99" }])).await;
    let card = socket.frame_of("card").await;
    assert_eq!(card["id"], "01");
    assert_eq!(card["body"]["body"], "# First\n\nDone already.\n");
    assert_eq!(
        card["events"]["events"][1]["payload"],
        json!({ "code": 0 }),
        "logTail left out"
    );
    assert_eq!(card["log"]["mode"], "window");
    assert_eq!(card["log"]["content"], "first line\n");
    assert_eq!(card["log"]["nextOffset"], 11);
    let refused = socket.frame_of("card").await;
    assert_eq!(
        refused,
        json!({ "type": "card", "id": "99", "error": "unknown ticket 99" })
    );

    let mut log = std::fs::OpenOptions::new()
        .append(true)
        .open(runs.join("01.log"))
        .unwrap();
    std::io::Write::write_all(&mut log, b"second line\n").unwrap();
    let append = tokio::time::timeout(Duration::from_millis(1500), socket.frame_of("card"))
        .await
        .expect("the append within 1.5 s");
    assert_eq!(append["log"]["mode"], "append");
    assert_eq!(append["log"]["offset"], 11);
    assert_eq!(append["log"]["content"], "second line\n");

    let (status, events) = rig.json("GET", "/api/events?ticket=01", None).await;
    assert_eq!(status, 200);
    assert_eq!(
        events["events"][1]["payload"]["logTail"],
        json!(["x"]),
        "HTTP keeps logTail"
    );
}

#[tokio::test]
async fn stop_replies_pushes_what_waits_and_closes_1000_stopped() {
    let rig = rig(RigOptions {
        coalesce: Duration::from_secs(60),
        ..RigOptions::default()
    })
    .await;
    let mut socket = rig.socket().await;
    assert_eq!(
        socket.frame_of("snapshot").await["snapshot"]["phase"],
        "quiescent"
    );
    // Done, waiting in a 60 s window: the stop's flush ahead of its reply pushes it.
    publish(
        &rig.engine(),
        snapshot(1, RunPhase::Done, &[("01", TicketStatus::Done)], &[]),
    )
    .await;
    socket
        .send(json!({ "type": "request", "id": 1, "kind": "stop", "payload": {} }))
        .await;
    let delta = socket.frame_of("delta").await;
    assert_eq!(delta["delta"]["set"]["phase"], "done");
    let reply = socket.frame_of("reply").await;
    assert_eq!(reply["result"], json!({ "stopping": true }));
    assert_eq!(reply["rev"], delta["delta"]["rev"]);
    loop {
        match socket.next_within(5_000).await {
            Some(Message::Close(Some(frame))) => {
                assert_eq!(
                    (u16::from(frame.code), frame.reason.as_str()),
                    (1000, "stopped")
                );
                break;
            }
            Some(Message::Text(_)) | Some(_) => {}
            None => panic!("the socket never closed"),
        }
    }
    // The lock is released and the port stops answering.
    for _ in 0..50 {
        if !rig.pool().join("runs/server.pid").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!rig.pool().join("runs/server.pid").exists());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", rig.server.port()))
            .await
            .is_err()
    );
}

// server.test.ts:3425
#[tokio::test]
async fn hands_a_stop_to_its_owner_exactly_once_and_does_not_shut_itself_down() {
    let rig = rig(RigOptions {
        hand_off_stop: true,
        ..RigOptions::default()
    })
    .await;
    publish(
        &rig.engine(),
        snapshot(1, RunPhase::Done, &[("01", TicketStatus::Done)], &[]),
    )
    .await;
    assert_eq!(
        rig.json("POST", "/api/stop", None).await,
        (202, json!({ "stopping": true }))
    );
    assert_eq!(
        rig.json("POST", "/api/stop", None).await,
        (202, json!({ "stopping": true }))
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(rig.stops.load(Ordering::SeqCst), 1);
    assert_eq!(
        rig.json("GET", "/api/state", None).await.0,
        200,
        "still serving"
    );
}

fn failing_encode(_: &ac_protocol::EnrichedSnapshot, _: u64) -> Result<Pushed, String> {
    Err("a BigInt cannot be serialised".to_owned())
}

// ws.test.ts:598, :571
#[tokio::test]
async fn keeps_every_socket_at_the_last_good_revision_when_a_version_cannot_be_encoded() {
    let rig = rig(RigOptions::default()).await;
    let mut socket = rig.socket().await;
    assert_eq!(socket.frame_of("snapshot").await["rev"], 1);
    rig.server.lock().hub.encode = failing_encode;
    publish(
        &rig.engine(),
        snapshot(1, RunPhase::Quiescent, &[("01", TicketStatus::Done)], &[]),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    // A socket opening meanwhile is sent the last good revision.
    let mut late = rig.socket().await;
    let opened = late.frame_of("snapshot").await;
    assert_eq!(opened["rev"], 1);
    assert_eq!(opened["snapshot"]["seq"], 0);
    rig.server.lock().hub.encode =
        |full, rev| crate::push::to_pushed(full, rev).map_err(|e| e.to_string());
    publish(
        &rig.engine(),
        snapshot(2, RunPhase::Quiescent, &[("01", TicketStatus::Done)], &[]),
    )
    .await;
    let delta = socket.frame_of("delta").await;
    assert_eq!(
        (
            delta["delta"]["base"].clone(),
            delta["delta"]["rev"].clone()
        ),
        (json!(1), json!(2))
    );
    assert_eq!(late.frame_of("delta").await, delta);
}

// ws.test.ts:655
#[tokio::test]
async fn never_counts_a_first_snapshot_it_cannot_encode() {
    let rig = rig(RigOptions::default()).await;
    {
        let mut inner = rig.server.lock();
        // Back to before any push: the first version is pushed afresh, and it cannot be encoded.
        inner.hub = crate::hub::HubState::new(Duration::from_millis(20_000));
        inner.hub.encode = failing_encode;
    }
    let mut socket = rig.socket().await;
    socket.frame_of("hello").await;
    let opened = socket.frame_of("snapshot").await;
    assert_eq!(
        opened,
        json!({ "type": "snapshot", "rev": 0, "logTotal": 0, "snapshot": null })
    );
    rig.server.lock().hub.encode =
        |full, rev| crate::push::to_pushed(full, rev).map_err(|e| e.to_string());
    publish(
        &rig.engine(),
        snapshot(5, RunPhase::Quiescent, &[("01", TicketStatus::Done)], &[]),
    )
    .await;
    let whole = socket.frame_of("snapshot").await;
    assert_eq!(whole["rev"], 1);
    assert_eq!(whole["snapshot"]["seq"], 5);
}

// server.test.ts:2089
#[tokio::test]
async fn serves_a_cached_diff_inside_the_ttl_and_reads_again_after_it() {
    let rig = rig(RigOptions::default()).await;
    let repo = rig.dir.path().join("worktree");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    };
    git(&["init", "-q"]);
    git(&[
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "base",
    ]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    let runs = rig.pool().join("runs");
    std::fs::create_dir_all(&runs).unwrap();
    std::fs::write(
        runs.join("01.events.jsonl"),
        format!(
            "{{\"at\":\"t\",\"attempt\":1,\"kind\":\"spawned\",\"payload\":{{\"cwd\":{}}}}}\n",
            Value::from(repo.to_string_lossy().into_owned())
        ),
    )
    .unwrap();
    let first = rig.server.activity("01").await;
    assert_eq!(
        first["diff"],
        json!({ "added": 1, "removed": 0, "files": ["a.txt"] })
    );
    std::fs::write(repo.join("b.txt"), "two\n").unwrap();
    let cached = rig.server.activity("01").await;
    assert_eq!(cached["diff"], first["diff"]);
    tokio::time::sleep(Duration::from_millis(1600)).await;
    let fresh = rig.server.activity("01").await;
    assert_eq!(
        fresh["diff"],
        json!({ "added": 2, "removed": 0, "files": ["a.txt", "b.txt"] })
    );
    assert_eq!(fresh["lastEventAt"], "t");
    assert_eq!(fresh["running"], false);
}

// server.test.ts:3319, :4022, and ws.test.ts:1142's half before the start
#[tokio::test]
async fn answers_before_the_pool_starts_without_tearing_anything_down() {
    let rig = rig(RigOptions {
        start: false,
        ..RigOptions::default()
    })
    .await;
    assert_eq!(
        rig.json("POST", "/api/stop", None).await,
        (409, json!({ "error": "pool not started: nothing to stop" }))
    );
    assert_eq!(
        rig.json("GET", "/api/state", None).await,
        (200, json!({ "snapshot": null }))
    );
    assert_eq!(
        rig.json("POST", "/api/conversations", Some(r#"{"title":"Talk"}"#))
            .await,
        (409, json!({ "reason": "pool not started" }))
    );
    assert_eq!(
        rig.json("POST", "/api/conversations/end", Some(r#"{"id":"c1"}"#))
            .await,
        (409, json!({ "reason": "pool not started" }))
    );
    assert_eq!(
        rig.json("POST", "/api/resume", Some(r#"{"ticketId":"01"}"#))
            .await,
        (400, json!({ "error": "pool not started" }))
    );
    assert_eq!(
        rig.json(
            "PUT",
            "/api/reassign",
            Some(r#"{"tickets":["02"],"fields":{}}"#)
        )
        .await,
        (500, json!({ "error": "reassign: pool not started" }))
    );
    let (_, _, page) = rig.http("GET", "/index.html", None).await;
    let start =
        page.find(r#"type="application/json">"#).unwrap() + r#"type="application/json">"#.len();
    let end = page[start..].find("</script>").unwrap() + start;
    let boot: Value = serde_json::from_str(&page[start..end]).unwrap();
    assert_eq!(
        (
            boot["protocol"].clone(),
            boot["rev"].clone(),
            boot["snapshot"].clone()
        ),
        (json!(1), json!(0), Value::Null)
    );
    let mut socket = rig.socket().await;
    socket.frame_of("hello").await;
    assert_eq!(
        socket.frame_of("snapshot").await,
        json!({ "type": "snapshot", "rev": 0, "logTotal": 0, "snapshot": null })
    );
    assert!(
        rig.pool().join("runs/server.pid").exists(),
        "still serving, still locked"
    );
}

// server.test.ts:861: inside the window the route already serves the latest seq; the socket has not
// been sent it yet.
#[tokio::test]
async fn serves_the_latest_emit_over_http_while_the_window_holds_the_push() {
    let rig = rig(RigOptions {
        coalesce: Duration::from_millis(500),
        ..RigOptions::default()
    })
    .await;
    let mut socket = rig.socket().await;
    socket.frame_of("snapshot").await;
    publish(
        &rig.engine(),
        snapshot(4, RunPhase::Quiescent, &[("01", TicketStatus::Done)], &[]),
    )
    .await;
    assert_eq!(
        rig.json("GET", "/api/state", None).await.1["snapshot"]["seq"],
        4
    );
    assert!(
        socket.next_within(200).await.is_none(),
        "nothing pushed inside the window"
    );
    assert_eq!(socket.frame_of("delta").await["delta"]["set"]["seq"], 4);
}

// server.test.ts:884: closing the sockets on stop sends what the window still holds, then closes.
#[tokio::test]
async fn sends_a_waiting_snapshot_before_the_sockets_close() {
    let rig = rig(RigOptions {
        coalesce: Duration::from_secs(60),
        ..RigOptions::default()
    })
    .await;
    let mut socket = rig.socket().await;
    socket.frame_of("snapshot").await;
    publish(
        &rig.engine(),
        snapshot(1, RunPhase::Stopped, &[("01", TicketStatus::Done)], &[]),
    )
    .await;
    rig.server.shutdown(None).await;
    let delta = socket.frame_of("delta").await;
    assert_eq!(delta["delta"]["set"]["phase"], "stopped");
    match socket.next_within(2_000).await {
        Some(Message::Close(Some(frame))) => {
            assert_eq!(
                (u16::from(frame.code), frame.reason.as_str()),
                (1000, "stopped")
            )
        }
        other => panic!("expected the stopped close, got {other:?}"),
    }
}
