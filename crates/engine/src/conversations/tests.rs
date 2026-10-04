//! Unit tests of the Conversation runtime: the rows the conformance suite cannot see from outside
//! (the claim per id, the queue claimed whole, a failed Turn put back, a Turn-state read that fails, the
//! boot's exit-code rule, an End on an unadopted record) and the Notice and end paths with a scripted
//! herdr.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use ac_core::conversation_record::{ConversationRecord, write_conversation};
use ac_core::notices::{Notice, NoticeKind};
use ac_io::herdr::fake::{FakeHerdr, Options, Reply};
use ac_protocol::{ConversationStatus, TicketEventKind, TurnSide};

use super::adopt::{Next, decide_started};
use super::end::end_with;
use super::*;
use crate::testkit::Pool;

/// What the scripted pane shows and whether its calls are refused.
#[derive(Default)]
struct Screen {
    frame: String,
    refuse_sends: bool,
    refuse_reads: bool,
    sent: Vec<String>,
}

struct Rig {
    pool: Pool,
    fake: FakeHerdr,
    engine: Engine,
    screen: Arc<Mutex<Screen>>,
}

fn reply(result: Value) -> Option<Reply> {
    Some(Reply::Line(
        json!({ "id": "1", "result": result }).to_string(),
    ))
}

impl Rig {
    async fn new() -> Rig {
        let screen = Arc::new(Mutex::new(Screen::default()));
        let scripted = Arc::clone(&screen);
        let fake = FakeHerdr::start(Options {
            foreign_panes: vec![json!({ "pane_id": "p-conv-1", "tab_id": "t1" })],
            script: Some(Arc::new(move |method: &str, params: &Value| {
                let mut screen = scripted.lock().unwrap();
                match method {
                    "pane.read" if screen.refuse_reads => Some(Reply::Close),
                    "pane.read" => reply(json!({ "read": { "text": screen.frame } })),
                    "pane.send_input" if screen.refuse_sends => Some(Reply::Close),
                    "pane.send_input" => {
                        if let Some(text) = params.get("text").and_then(Value::as_str) {
                            screen.sent.push(text.to_owned());
                            screen.frame = text.to_owned();
                        }
                        None
                    }
                    _ => None,
                }
            })),
            ..Options::default()
        })
        .await;
        let pool = Pool::git(&[]);
        std::fs::write(
            pool.file("console.json"),
            r#"{"defaults": {"harness": "claude", "model": "m"}, "terminal": "herdr"}"#,
        )
        .unwrap();
        // A Seeded Pool (a conversations/ directory) may start with no Tickets.
        std::fs::create_dir_all(pool.file("conversations")).unwrap();
        let mut options = pool.options();
        options.herdr_socket = Some(ac_core::js::path_text(fake.herdr().socket_path()));
        options.conversation_poll_ms = Some(3_600_000);
        let engine = crate::boot::start_pool(options).await.unwrap();
        Rig {
            pool,
            fake,
            engine,
            screen,
        }
    }

    fn record(&self, id: &str) -> ConversationRecord {
        ConversationRecord {
            id: id.to_owned(),
            file: self.pool.file(&format!("conversations/{id}.md")),
            title: format!("Talk {id}"),
            opening: String::new(),
            status: ConversationStatus::Live,
            spawned_by: None,
            harness: "claude".into(),
            model: "m".into(),
            effort: None,
            drivers: "implement".into(),
            enlisted: None,
            role: None,
        }
    }

    async fn write_record(&self, id: &str) {
        let rec = self.record(id);
        self.engine
            .call(move |s| write_conversation(&conversations_dir(s), &rec).unwrap())
            .await
            .unwrap();
    }

    /// A live Conversation's record on disk and its runtime in the session, on pane `p-<id>`.
    async fn live(&self, id: &str, waiting: bool) -> Rt {
        let rec = self.record(id);
        let id = id.to_owned();
        self.engine
            .call(move |s| {
                write_conversation(&conversations_dir(s), &rec).unwrap();
                let directory = s.cwd.clone();
                let rt = enlisted_runtime(
                    s,
                    EnlistedFacts {
                        id: &id,
                        file: rec.file.clone(),
                        pane_id: &format!("p-{id}"),
                        tab_id: None,
                        harness: "claude",
                        title: &rec.title,
                        directory: &directory,
                        branch: "main",
                        role: None,
                    },
                );
                rt.with(|r| {
                    r.turn.state = if waiting {
                        TurnSide::Waiting
                    } else {
                        TurnSide::Working
                    }
                });
                s.conversations.runtimes.insert(id, rt.clone());
                rt
            })
            .await
            .unwrap()
    }

    fn events(&self, id: &str) -> Vec<ac_protocol::TicketEvent> {
        self.pool.events(id)
    }

    fn kinds(&self, id: &str) -> Vec<TicketEventKind> {
        self.events(id).iter().map(|e| e.kind).collect()
    }
}

fn notice(to: &str, from: &str, text: &str) -> Notice {
    Notice {
        to: to.to_owned(),
        from: from.to_owned(),
        kind: NoticeKind::TicketEnded,
        text: text.to_owned(),
        key: None,
    }
}

async fn wait_until(held: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !held() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the condition holds");
}

// enqueue: a parent that is mid-End takes no Notice; it is dropped and logged on the child's own file.
#[tokio::test]
async fn a_notice_for_a_parent_that_is_ending_is_dropped_on_the_childs_log() {
    let rig = Rig::new().await;
    let rt = rig.live("conv-1", false).await;
    rt.with(|r| r.ending = true);
    rig.engine
        .call(|s| super::notices::enqueue(s, notice("conv-1", "conv-1-spawn-1", "done")))
        .await
        .unwrap();
    let events = rig.events("conv-1-spawn-1");
    let dropped: Vec<_> = events
        .iter()
        .filter(|e| e.kind == TicketEventKind::NoticeDropped)
        .collect();
    assert_eq!(dropped.len(), 1);
    assert_eq!(
        dropped[0].payload["reason"],
        "parent conversation is ending"
    );
    assert_eq!(dropped[0].payload["kind"], "ticket-ended");
    assert_eq!(dropped[0].payload["to"], "conv-1");
    assert!(rt.with(|r| r.notices.is_empty()));
    assert!(rig.screen.lock().unwrap().sent.is_empty());
}

// A parent that was never live gets the other reason.
#[tokio::test]
async fn a_notice_for_a_parent_that_is_not_live_says_so() {
    let rig = Rig::new().await;
    rig.engine
        .call(|s| super::notices::enqueue(s, notice("conv-9", "conv-9-spawn-1", "done")))
        .await
        .unwrap();
    let events = rig.events("conv-9-spawn-1");
    assert_eq!(
        events[0].payload["reason"],
        "parent conversation is not live"
    );
}

// The queue is claimed whole before the first Turn is typed, so a racing tick never types one twice.
#[tokio::test]
async fn the_notice_queue_is_claimed_whole_before_the_first_turn_is_typed() {
    let rig = Rig::new().await;
    let rt = rig.live("conv-1", true).await;
    let (first, second) = rig
        .engine
        .call(move |s| {
            rt.with(|r| {
                r.notices.push(notice("conv-1", "a", "one"));
                r.notices.push(notice("conv-1", "b", "two"));
            });
            let first = super::notices::deliver_begin(s, "conv-1");
            let second = super::notices::deliver_begin(s, "conv-1");
            (first.is_some(), second.is_some())
        })
        .await
        .unwrap();
    assert!(first, "the first trigger claims the queue");
    assert!(!second, "a second trigger finds nothing left to type");
}

// A Turn that never shows in the pane stops the drain, and it and everything after it go back to the
// front of the queue, in order; the first failure of an episode is on the logs once, and the delivery
// that ends it after.
#[tokio::test]
async fn a_turn_that_never_lands_goes_back_in_order_and_is_retried() {
    let rig = Rig::new().await;
    let rt = rig.live("conv-1", true).await;
    rig.screen.lock().unwrap().refuse_sends = true;
    rig.engine
        .call({
            let rt = rt.clone();
            move |s| {
                rt.with(|r| {
                    r.notices.push(notice("conv-1", "a", "one"));
                    r.notices.push(notice("conv-1", "b", "two"));
                    r.notices.push(notice("conv-1", "c", "three"));
                });
                super::notices::spawn_deliver(s, "conv-1");
            }
        })
        .await
        .unwrap();
    wait_until(|| rt.with(|r| r.delivery.is_some())).await;
    assert_eq!(
        rt.with(|r| r.notices.iter().map(|n| n.text.clone()).collect::<Vec<_>>()),
        ["one", "two", "three"]
    );
    let failed = rig.events("a");
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].kind, TicketEventKind::Notice);
    assert_eq!(failed[0].payload["delivered"], false);
    assert!(failed[0].payload.get("error").is_some());
    assert_eq!(failed[0].payload["to"], "conv-1");
    // The view says the Notices are not reaching the pane.
    let delivery = rig
        .engine
        .call(|s| {
            views(s)
                .into_iter()
                .find(|v| v.id == "conv-1")
                .and_then(|v| v.delivery)
        })
        .await
        .unwrap();
    assert!(delivery.is_some());

    // Retried while it reads waiting: the same daemon, healthy again.
    rig.screen.lock().unwrap().refuse_sends = false;
    rig.engine
        .call(|s| super::notices::spawn_deliver(s, "conv-1"))
        .await
        .unwrap();
    // The drain claims the whole queue, so the queue is empty while the Turns are still being typed.
    wait_until(|| rig.screen.lock().unwrap().sent.len() == 3).await;
    assert_eq!(rig.screen.lock().unwrap().sent, ["one", "two", "three"]);
    wait_until(|| rt.with(|r| r.delivery.is_none())).await;
    let delivered = rig.events("a");
    assert_eq!(delivered.last().unwrap().payload["delivered"], true);
    // The failure was logged once, then the delivery: two events, not one per retry.
    assert_eq!(delivered.len(), 2);
}

// A Turn-state read that fails leaves the state as it was.
#[tokio::test]
async fn a_turn_state_read_that_fails_leaves_the_state_as_it_was() {
    let rig = Rig::new().await;
    let rt = rig.live("conv-1", true).await;
    let before = rt.with(|r| (r.turn.state, r.turn.last_line.clone()));
    rig.screen.lock().unwrap().refuse_reads = true;
    let descriptor = ac_core::harness::harness_descriptor("claude");
    let read = super::tick::read_turn(&rig.engine, &rt, descriptor).await;
    assert!(read.is_err());
    assert_eq!(
        rt.with(|r| (r.turn.state, r.turn.last_line.clone())),
        before
    );
    // And nothing was recorded for the Peek.
    assert!(rig.engine.pane_read("p-conv-1".into()).await.is_none());
}

// Claims on one id run one at a time, and the id is free again after.
#[tokio::test]
async fn claims_on_one_id_run_one_at_a_time() {
    let rig = Rig::new().await;
    let inside = Arc::new(AtomicUsize::new(0));
    let overlaps = Arc::new(AtomicBool::new(false));
    let mut claims = Vec::new();
    for _ in 0..4 {
        let (engine, inside, overlaps) = (
            rig.engine.clone(),
            Arc::clone(&inside),
            Arc::clone(&overlaps),
        );
        claims.push(tokio::spawn(async move {
            claim(&engine, "conv-1", async {
                if inside.fetch_add(1, Ordering::SeqCst) > 0 {
                    overlaps.store(true, Ordering::SeqCst);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
                inside.fetch_sub(1, Ordering::SeqCst);
            })
            .await
        }));
    }
    for claim in claims {
        assert!(claim.await.unwrap().is_some());
    }
    assert!(!overlaps.load(Ordering::SeqCst), "two claims ran at once");
    let held = rig.engine.call(|s| claiming(s, "conv-1")).await.unwrap();
    assert!(!held);
}

// A started Conversation's `spawned` event, as a launch records it.
fn record_launch(rig: &Rig, id: &str, pane: &str, tab: &str, terminal: Option<&str>, at: &str) {
    let mut payload = serde_json::Map::new();
    payload.insert("pane_id".into(), pane.into());
    payload.insert("tab_id".into(), tab.into());
    if let Some(terminal) = terminal {
        payload.insert("terminal_id".into(), terminal.into());
    }
    let event = ac_protocol::TicketEvent {
        at: at.to_owned(),
        attempt: 1,
        kind: TicketEventKind::Spawned,
        payload,
    };
    ac_core::events::append_event(&rig.pool.file("runs"), id, &event).unwrap();
}

fn listing_of(panes: &[(&str, &str, Option<&str>)]) -> crate::pane_survey::PaneListing {
    let mut listing = crate::pane_survey::PaneListing::default();
    for (pane, tab, terminal) in panes {
        listing.panes.insert(
            (*pane).to_owned(),
            ac_io::herdr::HerdrPane {
                pane_id: (*pane).to_owned(),
                tab_id: Some((*tab).to_owned()),
                workspace_id: None,
                cwd: None,
                terminal_id: terminal.map(str::to_owned),
            },
        );
        listing.tabs.insert((*tab).to_owned());
    }
    listing
}

// ADR-0018 amendment (issue #140): the TUI counts as exited at boot only if its exit-code file is no
// older than the launch it belongs to; one left by an earlier run of the same id is not this talk's.
#[tokio::test]
async fn the_tui_counts_as_exited_at_boot_only_if_its_exit_code_is_no_older_than_the_launch() {
    let rig = Rig::new().await;
    rig.write_record("conv-1").await;
    let launched = "2026-01-01T00:00:10.000Z";
    record_launch(&rig, "conv-1", "p1", "t1", None, launched);
    let exit_file = rig.pool.file("runs/conv-1.exitcode");
    std::fs::write(&exit_file, "0\n").unwrap();
    let set_mtime = |iso: &str| {
        let at: std::time::SystemTime = chrono::DateTime::parse_from_rfc3339(iso).unwrap().into();
        std::fs::File::options()
            .write(true)
            .open(&exit_file)
            .unwrap()
            .set_modified(at)
            .unwrap();
    };
    let listing = listing_of(&[("p1", "t1", None)]);
    let decide = |listing: crate::pane_survey::PaneListing| {
        rig.engine
            .call(move |s| match decide_started(s, "conv-1", &listing, None) {
                Next::Adopt(..) => "adopt",
                Next::Done => "done",
                Next::Skip => "skip",
                Next::FinishEnd => "finish",
            })
    };

    // Older than the launch: a leftover. The pane is adopted.
    set_mtime("2026-01-01T00:00:05.000Z");
    assert_eq!(decide(listing.clone()).await.unwrap(), "adopt");

    // As new as the launch: its TUI has exited. The Conversation crashes with its reason.
    set_mtime(launched);
    assert_eq!(decide(listing.clone()).await.unwrap(), "done");
    let crash = rig
        .events("conv-1")
        .into_iter()
        .find(|e| e.kind == TicketEventKind::Crash)
        .unwrap();
    assert_eq!(
        crash.payload["reason"],
        "engine restarted and its TUI had exited"
    );
}

// An End on an unadopted record whose pane herdr lists as another terminal releases no agent and closes
// no tab: the id no longer names this Conversation's terminal.
#[tokio::test]
async fn an_end_on_an_unadopted_record_whose_pane_is_another_terminal_touches_nothing() {
    let rig = Rig::new().await;
    rig.write_record("conv-1").await;
    record_launch(
        &rig,
        "conv-1",
        "p1",
        "t1",
        Some("term-old"),
        "2026-01-01T00:00:10.000Z",
    );
    let listing = listing_of(&[("p1", "t1", Some("term-new"))]);
    let before = rig.fake.methods().len();
    end_with(
        &rig.engine,
        "conv-1",
        Some("bye".into()),
        Some(listing),
        ac_protocol::AnswerBy::Operator,
    )
    .await
    .unwrap();
    // Nothing the End started in the background is still to come.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let methods: Vec<String> = rig.fake.methods()[before..].to_vec();
    assert!(
        !methods
            .iter()
            .any(|m| m == "tab.close" || m == "pane.release_agent"),
        "herdr was asked to touch a terminal that is not this Conversation's: {methods:?}"
    );
    let kinds = rig.kinds("conv-1");
    assert!(kinds.contains(&TicketEventKind::EndRequested));
    assert!(kinds.contains(&TicketEventKind::Ended));
    assert!(!kinds.contains(&TicketEventKind::TabClosed));
}

// Two Ends of one record, or an End and a re-adoption, build one runtime and record the ending once.
#[tokio::test]
async fn two_ends_of_one_unadopted_record_record_the_ending_once() {
    let rig = Rig::new().await;
    rig.write_record("conv-1").await;
    record_launch(&rig, "conv-1", "p1", "t1", None, "2026-01-01T00:00:10.000Z");
    let listing = listing_of(&[("p1", "t1", None)]);
    let ends = (0..2).map(|_| {
        end_with(
            &rig.engine,
            "conv-1",
            None,
            Some(listing.clone()),
            ac_protocol::AnswerBy::Operator,
        )
    });
    let results = futures::future::join_all(ends).await;
    // The second finds the first's runtime already ending and returns; neither fails.
    assert!(results.iter().all(Result::is_ok), "{results:?}");
    let kinds = rig.kinds("conv-1");
    let count = |kind| kinds.iter().filter(|k| **k == kind).count();
    assert_eq!(count(TicketEventKind::Ended), 1);
    assert_eq!(count(TicketEventKind::EndRequested), 1);
}

// An End on a Conversation the pool never recorded as live says so.
#[tokio::test]
async fn ending_an_unknown_conversation_names_the_id() {
    let rig = Rig::new().await;
    let err = end(
        &rig.engine,
        "conv-99",
        None,
        ac_protocol::AnswerBy::Operator,
    )
    .await
    .unwrap_err();
    assert_eq!(
        err.message(),
        "end conversation: no live conversation conv-99"
    );
}

// Unadopted live records are tried again on every call (the pane survey's listing calls this), until a
// try settles them: a pane that could not be read changes nothing.
#[tokio::test]
async fn an_unadopted_conversation_is_retried_until_its_pane_can_be_read() {
    let rig = Rig::new().await;
    rig.write_record("conv-1").await;
    record_launch(
        &rig,
        "conv-1",
        "p-conv-1",
        "t1",
        None,
        "2026-01-01T00:00:10.000Z",
    );
    rig.screen.lock().unwrap().refuse_reads = true;
    readopt_pending(&rig.engine).await.unwrap();
    let (live, status) = rig
        .engine
        .call(|s| {
            (
                s.conversations.is_live("conv-1"),
                record_of(s, "conv-1").unwrap().status,
            )
        })
        .await
        .unwrap();
    assert!(
        !live,
        "the pane could not be read, so the record stays unadopted"
    );
    assert_eq!(status, ConversationStatus::Live);

    rig.screen.lock().unwrap().refuse_reads = false;
    readopt_pending(&rig.engine).await.unwrap();
    let live = rig
        .engine
        .call(|s| s.conversations.is_live("conv-1"))
        .await
        .unwrap();
    assert!(live, "the next listing re-adopts it");
    assert!(!rig.kinds("conv-1").contains(&TicketEventKind::Crash));
}

fn spawned_ticket(id: &str, title: &str, parent: &str) -> ac_core::pool::TicketMarker {
    ac_core::pool::TicketMarker {
        id: id.to_owned(),
        file: std::path::PathBuf::from(format!("/nowhere/{id}.md")),
        blocked_by: Vec::new(),
        status: ac_protocol::TicketStatus::Done,
        title: title.to_owned(),
        spec: String::new(),
        spawned_by: Some(parent.to_owned()),
        enlisted_from: None,
        spawn_assign: None,
    }
}

// The ticket hooks queue a Notice for a parent the pool has recorded, and type it whole the moment the
// parent reads waiting: the done text with no Brief, the checkpoint's with its Brief, the closed one with
// its trimmed note.
#[tokio::test]
async fn a_spawned_tickets_endings_are_typed_into_a_waiting_parent_in_their_own_words() {
    let rig = Rig::new().await;
    rig.live("conv-1", true).await;
    let done = spawned_ticket("conv-1-spawn-1", "Old idea", "conv-1");
    rig.engine
        .call(move |s| {
            super::ticket_ended(s, &done, "pool/key/conv-1-spawn-1", None);
            super::ticket_checkpointed(
                s,
                &spawned_ticket("conv-1-spawn-2", "Next", "conv-1"),
                "  look here  ",
            );
            super::ticket_closed(
                s,
                &spawned_ticket("conv-1-spawn-3", "Gone", "conv-1"),
                Some(" superseded by 3 "),
            );
            // A Ticket that no Conversation spawned tells nobody.
            super::ticket_closed(s, &spawned_ticket("07-spawn-1", "Other", "07"), None);
        })
        .await
        .unwrap();
    wait_until(|| rig.screen.lock().unwrap().sent.len() == 3).await;
    let sent = rig.screen.lock().unwrap().sent.clone();
    assert_eq!(
        sent[0],
        "Ticket conv-1-spawn-1 (\"Old idea\") ended: done.\nBranch: pool/key/conv-1-spawn-1\nDiff:\n(diff unavailable)"
    );
    assert!(sent[1].starts_with(
        "Ticket conv-1-spawn-2 (\"Next\") ended: checkpoint.\nBrief: look here\nBranch: pool/"
    ));
    assert!(sent[1].ends_with("\nDiff:\n(no changes)"));
    assert_eq!(
        sent[2],
        "Ticket conv-1-spawn-3 (\"Gone\") was closed: its work was not merged.\nClose note: superseded by 3"
    );
    // Both sides of each telling are on the logs, delivered.
    wait_until(|| {
        rig.events("conv-1-spawn-3")
            .iter()
            .any(|e| e.kind == TicketEventKind::Notice)
    })
    .await;
    let told = rig.events("conv-1-spawn-3");
    assert_eq!(told[0].payload["delivered"], true);
    assert_eq!(told[0].payload["to"], "conv-1");
    assert_eq!(told[0].payload["kind"], "ticket-ended");
    assert!(rig.events("07-spawn-1").is_empty());
}

// A Conversation's own ending tells its parent by branch, and what never delivered is dropped and logged
// on the child's file before it goes.
#[tokio::test]
async fn an_ending_conversation_drops_what_it_never_delivered_and_tells_its_parent() {
    let rig = Rig::new().await;
    rig.live("conv-1", false).await;
    let child = rig.live("conv-1-spawn-1", false).await;
    // The child's record names its parent.
    let mut rec = rig.record("conv-1-spawn-1");
    rec.spawned_by = Some("conv-1".into());
    rig.engine
        .call({
            let (child, rec) = (child.clone(), rec.clone());
            move |s| {
                write_conversation(&conversations_dir(s), &rec).unwrap();
                child.with(|r| {
                    r.notices
                        .push(notice("conv-1-spawn-1", "conv-1-spawn-1-spawn-1", "late"));
                    r.closing = Some(" wrapped up ".into());
                });
                super::notices::note_ended(
                    s,
                    "conv-1-spawn-1",
                    "pool/key/b",
                    Some(" wrapped up "),
                    false,
                );
            }
        })
        .await
        .unwrap();
    let dropped = rig.events("conv-1-spawn-1-spawn-1");
    assert_eq!(dropped[0].kind, TicketEventKind::NoticeDropped);
    assert_eq!(
        dropped[0].payload["reason"],
        "parent conversation ended before delivery"
    );
    assert_eq!(dropped[0].payload["text"], "late");
    // The parent reads working, so its Notice waits in the queue as the ended Conversation's own.
    let queued = rig
        .engine
        .call(|s| {
            s.conversations
                .runtime("conv-1")
                .unwrap()
                .with(|r| r.notices.clone())
        })
        .await
        .unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].kind, NoticeKind::ConversationEnded);
    assert_eq!(
        queued[0].text,
        "A Conversation you spawned was ended by the operator.\nBranch: pool/key/b\nClosing note: wrapped up"
    );
}
