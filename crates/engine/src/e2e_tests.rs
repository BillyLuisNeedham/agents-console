//! The engine driven end to end over a headless git pool and the stub harness: Tickets launch, exit
//! with Outcomes, statuses and events land, done Tickets merge, checkpoints and crashes raise their
//! Interrupts, the Review is raised and an approve ends the run.

use ac_protocol::{InterruptKind, ResumeAction, RunPhase, TicketEventKind, TicketStatus};

use crate::testkit::{Pool, Script, last, settled};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_ready_tickets_run_in_worktrees_merge_and_end_at_the_review() {
    let pool = Pool::git(&[("01", &[]), ("02", &[])]);
    pool.script(
        "01",
        vec![
            Script::done("one")
                .with_work("echo one > one.txt && git add one.txt && git commit -qm one"),
        ],
    );
    pool.script(
        "02",
        vec![
            Script::done("two")
                .with_work("echo two > two.txt && git add two.txt && git commit -qm two"),
        ],
    );
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let snap = last(&engine);
    assert_eq!(snap.state.tickets["01"], TicketStatus::Done);
    assert_eq!(snap.state.tickets["02"], TicketStatus::Done);
    assert_eq!(snap.state.interrupts.len(), 1);
    assert_eq!(snap.state.interrupts[0].kind, InterruptKind::Review);
    assert_eq!(
        snap.state.interrupts[0].body,
        "every ticket is done.\n- 01: one\n- 02: two\napprove to end the run, or reject with a note naming the tickets to send back; their downstream tickets return to ready with them."
    );
    assert!(pool.file("one.txt").exists() && pool.file("two.txt").exists());
    assert_eq!(
        pool.kinds("01"),
        [
            TicketEventKind::Scheduled,
            TicketEventKind::Spawned,
            TicketEventKind::Exited,
            TicketEventKind::Merged
        ]
    );
    assert!(
        pool.read("issues/01.md")
            .starts_with("<!-- state: id=01 blocked-by=none status=done -->")
    );
    let log = &snap.state.log;
    assert!(
        log.contains(&"super-step 1: 01, 02".to_string()),
        "{log:#?}"
    );
    assert!(log.iter().any(|l| l.starts_with("ticket 01: merged pool/")));
    assert_eq!(
        log.last().unwrap(),
        "pool quiescent: interrupts pending for REVIEW"
    );
    let phase = engine
        .answer(
            "REVIEW".into(),
            Some("ship it".into()),
            ResumeAction::Approve,
            None,
        )
        .await
        .unwrap();
    assert_eq!(phase, RunPhase::Done);
    let snap = last(&engine);
    assert!(snap.state.review_approved);
    assert!(
        snap.state
            .log
            .contains(&"review approved: the run is complete (ship it)".to_string())
    );
    assert_eq!(
        snap.state.log.last().unwrap(),
        "pool done: every ticket reached done"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lone_ticket_runs_in_the_pool_checkout_and_a_blocked_one_waits_for_it() {
    let pool = Pool::git(&[("01", &[]), ("02", &["01"])]);
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let snap = last(&engine);
    let log = &snap.state.log;
    assert!(log.contains(&"super-step 1: 01".to_string()), "{log:#?}");
    assert!(log.contains(&"super-step 2: 02".to_string()));
    assert!(log.contains(&"ticket 01: exited 0, marker done".to_string()));
    // Run in the pool checkout: no merge to record.
    assert_eq!(
        pool.kinds("01"),
        [
            TicketEventKind::Scheduled,
            TicketEventKind::Spawned,
            TicketEventKind::Exited
        ]
    );
    let spawned = &pool.events("02")[1];
    assert_eq!(spawned.payload["cwd"], pool.path.as_str());
    assert_eq!(spawned.payload["branch"], serde_json::Value::Null);
    assert_eq!(spawned.payload["harness"], "stub");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_checkpoint_raises_its_interrupt_from_the_brief_and_a_resume_runs_it_again() {
    let pool = Pool::git(&[("01", &[])]);
    pool.script(
        "01",
        vec![Script::checkpoint("pick a colour"), Script::done("painted")],
    );
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let snap = last(&engine);
    assert_eq!(snap.state.tickets["01"], TicketStatus::Checkpoint);
    assert_eq!(snap.state.interrupts.len(), 1);
    assert_eq!(snap.state.interrupts[0].kind, InterruptKind::Checkpoint);
    assert_eq!(snap.state.interrupts[0].body, "pick a colour");
    assert!(
        pool.read("issues/01.md")
            .ends_with("\n\n---\n\n## Brief\n\npick a colour\n")
    );
    assert!(pool.kinds("01").contains(&TicketEventKind::Checkpoint));
    let phase = engine
        .answer("01".into(), Some("blue".into()), ResumeAction::Resume, None)
        .await
        .unwrap();
    assert_eq!(phase, RunPhase::Quiescent);
    let snap = last(&engine);
    assert_eq!(snap.state.tickets["01"], TicketStatus::Done);
    assert_eq!(snap.state.interrupts[0].kind, InterruptKind::Review);
    assert!(
        pool.read("issues/01.md")
            .contains("\n## Resume note\n\nblue\n")
    );
    assert!(
        snap.state
            .log
            .contains(&"interrupt answered for 01 (checkpoint): resumed".to_string())
    );
    let answered = pool
        .events("01")
        .into_iter()
        .find(|e| e.kind == TicketEventKind::Answered)
        .unwrap();
    assert_eq!(
        serde_json::Value::Object(answered.payload),
        serde_json::json!({"kind": "checkpoint"})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_raises_its_interrupt_at_the_boundary_with_the_exit_facts() {
    let pool = Pool::git(&[("01", &[])]);
    pool.script("01", vec![Script::crash(3)]);
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let snap = last(&engine);
    assert_eq!(snap.state.tickets["01"], TicketStatus::InProgress);
    let crash = &snap.state.interrupts[0];
    assert_eq!(crash.kind, InterruptKind::Crash);
    let runs = pool.file("runs");
    assert_eq!(
        crash.body,
        format!(
            "crash: harness exited 3\n{}/01.log\n\nstub ran 01\n\noutcome file: {}/01.outcome.json (missing)\n",
            runs.display(),
            runs.display()
        )
    );
    assert_eq!(
        pool.kinds("01"),
        [
            TicketEventKind::Scheduled,
            TicketEventKind::Spawned,
            TicketEventKind::Exited,
            TicketEventKind::Crash
        ]
    );
    assert!(
        snap.state.log.contains(
            &"ticket 01: exited 3, marker in-progress, crash: harness exited 3".to_string()
        )
    );
    assert!(
        pool.read("issues/01.md")
            .starts_with("<!-- state: id=01 blocked-by=none status=in-progress -->")
    );
}
