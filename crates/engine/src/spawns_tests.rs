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

// engine.test.ts "lands a spawn queued while the drive was closing, without another kick": an Adopt
// of a Held spawn accepted while the drive is closing (after its last boundary, as the Review is
// raised) keeps the run quiescent and starts a fresh drive that lands the spawn and runs it to done.
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

// engine.test.ts "holds a Pending spawn the boundary can no longer land, with the reason on it": the
// blocks target finished between the take and the boundary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn holds_a_pending_spawn_the_boundary_can_no_longer_land_with_the_reason_on_it() {
    let pool = Pool::git(&[("01", &[]), ("02", &[])]);
    pool.script(
        "01",
        vec![spawning(vec![proposal(
            "Fix first",
            json!({ "blocks": ["02"] }),
        )])],
    );
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let reason = "blocks names done tickets, which have no next attempt to hold: 02";
    assert!(!pool.file("issues/01-spawn-1.md").exists());
    let snapshot = last(&engine);
    assert!(snapshot.pending_spawns.is_empty());
    assert_eq!(snapshot.held_spawns.len(), 1);
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
