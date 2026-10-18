//! Spawns end to end over a headless git pool and the stub harness (engine.test.ts "pending spawns
//! (issue #150)" and its neighbours). The cases a server can see are conformance cases; these keep
//! what lives inside the process: the drive's close and the Adopt that arrives while it closes.

use std::sync::{Arc, Mutex};

use ac_core::checkpoints::CheckpointStore;
use ac_protocol::{HeldSpawnReason, ResumeAction, RunPhase, TicketEventKind, TicketStatus};
use serde_json::{Value, json};

use crate::actor::Engine;
use crate::testkit::{MemoryStore, Pool, Script, answer, last, settled, wait_for};

const BODY: &str = "A body long enough to stand as a ticket.";

fn proposal(title: &str, extra: Value) -> Value {
    let mut proposal = json!({ "title": title, "body": BODY });
    if let (Value::Object(base), Value::Object(extra)) = (&mut proposal, extra) {
        base.extend(extra);
    }
    proposal
}

fn spawning(proposals: Vec<Value>) -> Script {
    Script {
        exit: 0,
        outcome: Some(
            json!({ "status": "done", "summary": "spawned", "commitSha": null, "spawn": proposals })
                .to_string(),
        ),
        work: None,
    }
}

fn configure(pool: &Pool, extra: Value) {
    let mut config = json!({ "defaults": { "harness": "stub", "model": "m" } });
    if let (Value::Object(base), Value::Object(extra)) = (&mut config, extra) {
        base.extend(extra);
    }
    std::fs::write(pool.file("console.json"), config.to_string()).unwrap();
}

fn ledger(pool: &Pool) -> String {
    pool.read("runs/spawn-ledger.md")
}

fn spawn_events(pool: &Pool, id: &str, kind: TicketEventKind) -> Vec<Value> {
    pool.events(id)
        .into_iter()
        .filter(|event| event.kind == kind)
        .map(|event| Value::Object(event.payload))
        .collect()
}

// A checkpoint store that lets a hook see every write: the drive's own persists, which the close
// makes between the Review's raise and its quiescent settle.
struct HookedStore {
    inner: MemoryStore,
    on_write: Box<dyn FnMut(&Value) + Send>,
}

impl CheckpointStore for HookedStore {
    fn write(&mut self, state: &Value) -> anyhow::Result<()> {
        self.inner.write(state)?;
        (self.on_write)(state);
        Ok(())
    }

    fn latest(&mut self) -> anyhow::Result<Option<Value>> {
        self.inner.latest()
    }

    fn close(&mut self) {
        self.inner.close();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lands_a_spawn_queued_while_the_drive_was_closing_without_another_kick() {
    let pool = Pool::git(&[("01", &[])]);
    configure(&pool, json!({ "spawnCaps": { "perAttempt": 1 } }));
    pool.script(
        "01",
        vec![spawning(vec![
            proposal("Lands", json!({})),
            proposal("Held", json!({})),
        ])],
    );
    let engine_slot: Arc<Mutex<Option<Engine>>> = Arc::default();
    let adopted = Arc::new(Mutex::new(false));
    let mut options = pool.options();
    options.store = Some(Box::new(HookedStore {
        inner: pool.store.clone(),
        on_write: {
            let (engine_slot, adopted) = (Arc::clone(&engine_slot), Arc::clone(&adopted));
            Box::new(move |state| {
                let closing = state["interrupts"]
                    .as_array()
                    .is_some_and(|all| all.iter().any(|i| i["kind"] == "review"));
                let mut adopted = adopted.lock().unwrap();
                if closing
                    && !*adopted
                    && let Some(engine) = engine_slot.lock().unwrap().clone()
                {
                    *adopted = true;
                    engine.cast(|s| {
                        crate::spawns::adopt_held_spawn(s, "proposal-2").expect("the Adopt queues");
                    });
                }
            })
        },
    }));
    let engine = crate::boot::start_pool(options).await.unwrap();
    *engine_slot.lock().unwrap() = Some(engine.clone());

    wait_for(&engine, |snapshot| {
        snapshot.state.tickets.get("01-spawn-2") == Some(&TicketStatus::Done)
    })
    .await;
    assert!(*adopted.lock().unwrap());
    let phase = settled(&engine).await;
    assert_eq!(phase, RunPhase::Quiescent);
    assert!(last(&engine).held_spawns.is_empty());
    assert_eq!(
        answer(&engine, "REVIEW".into(), None, ResumeAction::Approve, None)
            .await
            .unwrap(),
        RunPhase::Done
    );
}

// engine.test.ts "holds every proposal when a cap is 0": a cap of 0 is a pool that lands nothing on
// its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn holds_every_proposal_when_a_cap_is_0() {
    for (caps, reason) in [
        (json!({ "perAttempt": 0 }), HeldSpawnReason::PerAttempt),
        (json!({ "perRun": 0 }), HeldSpawnReason::PerRun),
    ] {
        let pool = Pool::git(&[("01", &[])]);
        configure(&pool, json!({ "spawnCaps": caps }));
        pool.script(
            "01",
            vec![spawning(vec![
                proposal("A", json!({})),
                proposal("B", json!({})),
            ])],
        );
        let engine = pool.start().await;
        assert_eq!(settled(&engine).await, RunPhase::Quiescent);
        assert!(!pool.file("issues/01-spawn-1.md").exists());
        let snapshot = last(&engine);
        let held: Vec<(&str, HeldSpawnReason)> = snapshot
            .held_spawns
            .iter()
            .map(|h| (h.title.as_str(), h.reason))
            .collect();
        assert_eq!(held, [("A", reason), ("B", reason)]);
        assert!(snapshot.pending_spawns.is_empty());
    }
}

// A cap too large to count room in is no limit, never a wrapped negative number that holds everything
// (the engine counts room in signed numbers; JavaScript compared 1e300 as it stood).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn takes_every_proposal_when_a_cap_is_too_large_to_count() {
    for caps in [
        json!({ "perAttempt": 9_223_372_036_854_775_808_u64 }),
        json!({ "perRun": 1e300 }),
    ] {
        let pool = Pool::git(&[("01", &[])]);
        configure(&pool, json!({ "spawnCaps": caps }));
        pool.script(
            "01",
            vec![spawning(vec![
                proposal("A", json!({})),
                proposal("B", json!({})),
            ])],
        );
        let engine = pool.start().await;
        assert_eq!(settled(&engine).await, RunPhase::Quiescent);
        let snapshot = last(&engine);
        assert!(snapshot.held_spawns.is_empty(), "{caps}");
        for id in ["01-spawn-1", "01-spawn-2"] {
            assert_eq!(
                snapshot.state.tickets.get(id),
                Some(&TicketStatus::Done),
                "{caps}: {id}"
            );
        }
    }
}

// engine.test.ts "holds a proposal whose overlaps names ids the pool never knew, noting them".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn holds_a_proposal_whose_overlaps_names_ids_the_pool_never_knew_noting_them() {
    let pool = Pool::git(&[("01", &[])]);
    pool.script(
        "01",
        vec![spawning(vec![proposal(
            "Ghostly",
            json!({ "overlaps": ["01", "99", "proposal-7"] }),
        )])],
    );
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    assert!(!pool.file("issues/01-spawn-1.md").exists());
    let snapshot = last(&engine);
    assert_eq!(snapshot.held_spawns.len(), 1);
    assert_eq!(snapshot.held_spawns[0].id, "proposal-1");
    assert_eq!(snapshot.held_spawns[0].reason, HeldSpawnReason::Overlaps);
    assert_eq!(
        snapshot.held_spawns[0].unknown_overlaps,
        ["99", "proposal-7"]
    );
    assert_eq!(
        spawn_events(&pool, "01", TicketEventKind::SpawnHeld),
        [json!({ "held": [{
            "id": "proposal-1", "title": "Ghostly", "reason": "overlaps",
            "overlaps": ["01", "99", "proposal-7"], "unknownOverlaps": ["99", "proposal-7"]
        }] })]
    );
    assert!(snapshot.state.log.contains(
        &"ticket 01: proposal-1 ('Ghostly') held: it overlaps 01, 99, proposal-7 (99, proposal-7 not in the pool or the Spawn ledger)"
            .to_owned()
    ));
    assert!(ledger(&pool).contains("overlaps 01, 99, proposal-7 (99, proposal-7 not in the pool)"));
}

// engine.test.ts "writes the Spawn ledger with every ticket, pending and held spawn".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_the_spawn_ledger_with_every_ticket_pending_and_held_spawn() {
    let pool = Pool::git(&[("01", &[])]);
    configure(&pool, json!({ "spawnCaps": { "perAttempt": 1 } }));
    pool.script(
        "01",
        vec![spawning(vec![
            proposal("Lands", json!({})),
            proposal("Waits | with a pipe", json!({})),
        ])],
    );
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let text = ledger(&pool);
    assert!(text.contains("# Spawn ledger"));
    assert!(text.contains("| 01 | done |"));
    assert!(text.contains("| 01-spawn-1 | done | Lands |"));
    assert!(text.contains("## Conversations\n\n_(none)_"));
    assert!(text.contains("## Pending spawns"));
    assert!(
        text.contains("| proposal-2 | 01 | ticket | per-attempt cap | Waits \\| with a pipe |")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn holds_a_pending_spawn_the_tick_can_no_longer_land_with_the_reason_on_it() {
    let pool = Pool::git(&[("01", &[]), ("02", &[])]);
    for id in ["01", "02"] {
        std::fs::write(
            pool.file(&format!("issues/{id}.md")),
            crate::testkit::ticket_text(id, &[], "done"),
        )
        .unwrap();
    }
    let mut proposals = ac_core::spawn_proposals::load_spawn_proposals(&pool.file("runs")).unwrap();
    proposals
        .take(vec![ac_core::spawn_proposals::TakenProposal {
            parent_id: "01".into(),
            origin: ac_protocol::SpawnKind::Ticket,
            proposal: serde_json::from_value(proposal("Fix first", json!({ "blocks": ["02"] })))
                .unwrap(),
            at: "2026-01-01T00:00:00.000Z".into(),
            held: None,
            unknown_overlaps: None,
        }])
        .unwrap();
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let reason = "blocks names done tickets, which have no next attempt to hold: 02";
    assert!(!pool.file("issues/01-spawn-1.md").exists());
    let snapshot = last(&engine);
    assert!(snapshot.pending_spawns.is_empty());
    assert_eq!(snapshot.held_spawns.len(), 1, "{:#?}", snapshot.state.log);
    assert_eq!(snapshot.held_spawns[0].reason, HeldSpawnReason::Refused);
    assert_eq!(snapshot.held_spawns[0].adopt_error.as_deref(), Some(reason));
    assert_eq!(
        spawn_events(&pool, "01", TicketEventKind::SpawnHeld).last(),
        Some(&json!({ "held": [
            { "id": "proposal-1", "title": "Fix first", "reason": "refused", "refusal": reason }
        ] }))
    );
    assert!(snapshot.state.log.contains(&format!(
        "ticket 01: pending spawn proposal-1 ('Fix first') could not land: {reason}; it is held for the operator"
    )));
    assert!(ledger(&pool).contains(&format!("refused at landing: {reason}")));
}

fn session_in(dir: &std::path::Path, caps: Value) -> crate::session::Session {
    let runs = dir.join("runs");
    std::fs::create_dir_all(&runs).unwrap();
    let (publisher, _) = tokio::sync::watch::channel(None);
    let mut session = crate::testkit::bare_session(publisher);
    session.pool_dir = dir.to_string_lossy().into_owned();
    session.issues_dir = dir.join("issues").to_string_lossy().into_owned();
    session.runs_dir = runs.to_string_lossy().into_owned();
    session.spawn_proposals = ac_core::spawn_proposals::load_spawn_proposals(&runs).unwrap();
    session.state.config = ac_core::config::PoolConfig::from_map(
        json!({ "spawnCaps": caps }).as_object().unwrap().clone(),
    );
    session.markers.push(ac_core::pool::TicketMarker {
        id: "01".into(),
        file: dir.join("issues/01.md"),
        blocked_by: Vec::new(),
        status: TicketStatus::Done,
        title: "t".into(),
        spec: String::new(),
        spawned_by: None,
        enlisted_from: None,
        spawn_assign: None,
        station: None,
    });
    session
        .state
        .tickets
        .insert("01".into(), TicketStatus::Done);
    session
}

fn spawn_file(dir: &std::path::Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join("runs/held-spawns.json")).unwrap())
        .unwrap()
}

fn parent_events(dir: &std::path::Path, kind: TicketEventKind) -> Vec<Value> {
    ac_core::events::read_events(&dir.join("runs"), "01")
        .iter()
        .filter(|event| event.kind == kind)
        .map(|event| Value::Object(event.payload.clone()))
        .collect()
}

#[test]
fn a_conversation_spawn_the_pool_cannot_host_is_rejected_in_the_tick_that_adopts_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = session_in(dir.path(), json!({}));
    let proposals =
        vec![serde_json::from_value(proposal("Talk", json!({ "kind": "conversation" }))).unwrap()];
    crate::spawns::take_spawn_proposals(
        &mut session,
        "01",
        proposals,
        ac_protocol::SpawnKind::Conversation,
    )
    .unwrap();

    crate::spawns::adopt_spawn_proposals(&mut session).unwrap();

    assert_eq!(
        parent_events(dir.path(), TicketEventKind::SpawnRejected),
        [json!({
            "title": "Talk",
            "reason": r#"conversation start failed: conversation start: the pool is not terminal-backed (set console.json terminal: "herdr")"#
        })]
    );
    assert!(crate::conversations::reserved_ids(&session).is_empty());
}

#[test]
fn a_queued_adopt_the_tick_refuses_keeps_the_spawn_held_with_the_reason_on_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = session_in(dir.path(), json!({ "perAttempt": 0 }));
    let proposals = vec![
        serde_json::from_value(proposal(
            "Waits on a ticket",
            json!({ "blockedBy": ["02"] }),
        ))
        .unwrap(),
    ];
    let mut waited_on = session.markers[0].clone();
    waited_on.id = "02".into();
    session.markers.push(waited_on);
    let (_, held) = crate::spawns::take_spawn_proposals(
        &mut session,
        "01",
        proposals,
        ac_protocol::SpawnKind::Ticket,
    )
    .unwrap();
    assert_eq!(held[0].id, "proposal-1");
    session.spawn_proposals.begin_adopt("proposal-1").unwrap();
    session.markers.retain(|marker| marker.id != "02");
    let reason = "blockedBy names tickets outside the pool: 02";

    crate::spawns::adopt_spawn_proposals(&mut session).unwrap();

    assert!(!dir.path().join("issues/01-spawn-1.md").exists());
    assert_eq!(
        parent_events(dir.path(), TicketEventKind::SpawnRejected),
        [json!({ "title": "Waits on a ticket", "reason": reason, "fromHeld": "proposal-1" })]
    );
    let file = spawn_file(dir.path());
    assert_eq!(file["held"][0]["id"], "proposal-1");
    assert_eq!(file["held"][0]["adoptError"], reason);
    assert!(session.state.log.contains(&format!(
        "ticket 01: adopting held spawn proposal-1 ('Waits on a ticket') refused: {reason}; it stays held"
    )));
    assert!(!session.spawn_proposals.is_adopting("proposal-1"));
}
