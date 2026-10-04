//! The engine driven end to end over a headless git pool and the stub harness: Tickets launch, exit
//! with Outcomes, statuses and events land, done Tickets merge, checkpoints and crashes raise their
//! Interrupts, the Review is raised and an approve ends the run.

use ac_protocol::{InterruptKind, ResumeAction, RunPhase, TicketEventKind, TicketStatus};

use crate::testkit::{Pool, Script, answer, has_interrupt, last, pool_git, settled, wait_for};

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
    let phase = answer(
        &engine,
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
    let phase = answer(
        &engine,
        "01".into(),
        Some("blue".into()),
        ResumeAction::Resume,
        None,
    )
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

fn commit(file: &str, text: &str) -> String {
    format!("echo {text} > {file} && git add {file} && git commit -qm {text}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_conflicted_merge_with_no_resolver_waits_for_the_operator_and_a_resume_lands_it() {
    let pool = Pool::git(&[("01", &[]), ("02", &[])]);
    pool.script(
        "01",
        vec![Script::done("one").with_work(&commit("f.txt", "one"))],
    );
    pool.script(
        "02",
        vec![Script::done("two").with_work(&commit("f.txt", "two"))],
    );
    let engine = pool.start().await;
    let snap = wait_for(&engine, |s| {
        has_interrupt(s, "01", InterruptKind::MergeConflict)
            || has_interrupt(s, "02", InterruptKind::MergeConflict)
    })
    .await;
    let conflicted = &snap
        .state
        .interrupts
        .iter()
        .find(|i| i.kind == InterruptKind::MergeConflict)
        .unwrap();
    let id = conflicted.ticket_id.clone();
    assert!(
        conflicted.body.starts_with("merging pool/"),
        "{}",
        conflicted.body
    );
    assert!(conflicted.body.contains("conflicted files: f.txt\n"));
    assert!(conflicted.body.ends_with(
        "resolve the conflict and resume this ticket; the merge is re-attempted on resume.\nThe resolver agent attempted: no resolver harness available (set console.json resolver= or a ~/.issue-runner default)"
    ));
    assert!(pool.kinds(&id).contains(&TicketEventKind::MergeConflict));
    // The pool waits in the merge hold, which says why.
    let snap = wait_for(&engine, |s| {
        s.state
            .log
            .iter()
            .any(|l| l.starts_with("merge hold (ADR-0014): pool paused; awaiting the merge of"))
    })
    .await;
    assert_eq!(snap.merge_hold, std::slice::from_ref(&id));
    assert_eq!(
        snap.merge_queue[0].state,
        ac_protocol::MergeQueueState::NeedsYou
    );
    // The operator merges by hand, then resumes.
    let branch = ac_io::git::branch_for(&pool.path, &id, None);
    let _ = std::process::Command::new("git")
        .args(["-C", &pool.path, "merge", "--no-edit", &branch])
        .output();
    std::fs::write(pool.file("f.txt"), "both\n").unwrap();
    pool_git(&pool, &["add", "f.txt"]);
    pool_git(&pool, &["commit", "-qm", "by hand"]);
    let phase = answer(&engine, id.clone(), None, ResumeAction::Resume, None)
        .await
        .unwrap();
    assert_eq!(phase, RunPhase::Quiescent);
    let snap = last(&engine);
    assert!(
        snap.state.log.contains(&format!(
            "interrupt answered for {id} (merge-conflict): merge landed"
        )),
        "{:#?}",
        snap.state.log
    );
    assert_eq!(snap.state.interrupts[0].kind, InterruptKind::Review);
    assert_eq!(pool.kinds(&id).last(), Some(&TicketEventKind::Merged));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resolver_stages_a_resolution_and_an_approval_commits_and_merges_it() {
    let pool = Pool::git(&[("01", &[]), ("02", &[])]);
    std::fs::write(
        pool.file("console.json"),
        r#"{"defaults": {"harness": "stub", "model": "m"}, "resolver": "stub"}"#,
    )
    .unwrap();
    pool_git(&pool, &["commit", "-qam", "resolver"]);
    let resolve = Script {
        exit: 0,
        outcome: Some(r#"{"resolved": true, "note": "kept both"}"#.into()),
        work: Some("git merge main >/dev/null 2>&1; echo both > f.txt; git add f.txt".into()),
    };
    pool.script(
        "01",
        vec![
            Script::done("one").with_work(&commit("f.txt", "one")),
            resolve.clone(),
        ],
    );
    pool.script(
        "02",
        vec![
            Script::done("two").with_work(&commit("f.txt", "two")),
            resolve,
        ],
    );
    let engine = pool.start().await;
    let snap = wait_for(&engine, |s| {
        s.state
            .interrupts
            .iter()
            .any(|i| i.kind == InterruptKind::MergeApproval)
    })
    .await;
    let approval = snap
        .state
        .interrupts
        .iter()
        .find(|i| i.kind == InterruptKind::MergeApproval)
        .unwrap()
        .clone();
    let id = approval.ticket_id.clone();
    assert_eq!(
        approval.body,
        format!(
            "The resolver agent resolved the merge conflict for ticket {id}.\nIt attempted: kept both\nconflicted files: f.txt\nthe resolution is staged on branch {}; approve to commit it and continue, or reject to resolve by hand.",
            ac_io::git::branch_for(&pool.path, &id, None)
        )
    );
    let kinds = pool.kinds(&id);
    assert!(
        kinds.ends_with(&[
            TicketEventKind::MergeConflict,
            TicketEventKind::Resolver,
            TicketEventKind::Spawned
        ]),
        "{kinds:?}"
    );
    let phase = answer(&engine, id.clone(), None, ResumeAction::Approve, None)
        .await
        .unwrap();
    assert_eq!(phase, RunPhase::Quiescent);
    let snap = last(&engine);
    assert!(snap.state.log.contains(&format!(
        "interrupt answered for {id} (merge-approval): resolver resolution committed"
    )));
    assert_eq!(pool.read("f.txt"), "both\n");
    assert_eq!(snap.state.interrupts[0].kind, InterruptKind::Review);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ticket_with_no_harness_waits_at_a_config_interrupt_and_a_resume_after_the_fix_runs_it() {
    let pool = Pool::git(&[("01", &[])]);
    std::fs::write(pool.file("console.json"), "{}").unwrap();
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let snap = last(&engine);
    let config = &snap.state.interrupts[0];
    assert_eq!(config.kind, InterruptKind::Config);
    assert_eq!(
        config.body,
        "ticket 01 has no harness: set one in console.json (an assign entry for 01, or defaults.harness) and answer resume. The pool reloads console.json at the next super-step boundary and schedules the ticket on what it finds."
    );
    assert_eq!(snap.state.tickets["01"], TicketStatus::Checkpoint);
    assert_eq!(pool.kinds("01"), [TicketEventKind::Unassigned]);
    assert!(snap.state.log.contains(
        &"ticket 01: no harness; config interrupt raised instead of a launch".to_string()
    ));
    std::fs::write(
        pool.file("console.json"),
        r#"{"defaults": {"harness": "stub", "model": "m"}}"#,
    )
    .unwrap();
    let phase = answer(&engine, "01".into(), None, ResumeAction::Resume, None)
        .await
        .unwrap();
    assert_eq!(phase, RunPhase::Quiescent);
    let snap = last(&engine);
    assert_eq!(snap.state.tickets["01"], TicketStatus::Done);
    assert!(
        snap.state
            .log
            .contains(&"config reloaded: defaults".to_string()),
        "{:#?}",
        snap.state.log
    );
    let reassigned = pool
        .events("01")
        .into_iter()
        .find(|e| e.kind == TicketEventKind::Reassigned)
        .unwrap();
    assert_eq!(
        serde_json::Value::Object(reassigned.payload),
        serde_json::json!({
            "from": {"harness": null, "model": null, "drivers": "implement"},
            "to": {"harness": "stub", "model": "m", "drivers": "implement"}
        })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_that_keeps_failing_raises_the_persistence_interrupt_and_an_answer_retries() {
    let pool = Pool::git(&[("01", &[])]);
    // The boundary persist fails all four attempts; the close's own persist then lands.
    pool.store
        .fail
        .store(4, std::sync::atomic::Ordering::SeqCst);
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let snap = last(&engine);
    let persistence = snap
        .state
        .interrupts
        .iter()
        .find(|i| i.kind == InterruptKind::Persistence)
        .unwrap();
    assert_eq!(persistence.ticket_id, "PERSISTENCE");
    assert_eq!(
        persistence.body,
        "persistence is failing: the checkpoint store failed to write after 4 attempts with backoff.\nlast error: database is locked\nthe store remains open. answer this interrupt once the store is healthy to retry persistence and continue the run."
    );
    assert_eq!(
        pool.store.closed.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    let phase = answer(
        &engine,
        "PERSISTENCE".into(),
        None,
        ResumeAction::Resume,
        None,
    )
    .await
    .unwrap();
    assert_eq!(phase, RunPhase::Quiescent);
    let snap = last(&engine);
    assert!(snap.state.log.contains(
        &"interrupt answered for PERSISTENCE (persistence): the drive retries the checkpoint write"
            .to_string()
    ));
    assert_eq!(snap.state.interrupts[0].kind, InterruptKind::Review);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_a_checkpointed_blocker_deadlocks_its_dependent_and_the_review_names_it_closed() {
    let pool = Pool::git(&[("01", &[]), ("02", &["01"])]);
    pool.script("01", vec![Script::checkpoint("stuck")]);
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let phase = answer(
        &engine,
        "01".into(),
        Some("not needed".into()),
        ResumeAction::Close,
        None,
    )
    .await
    .unwrap();
    assert_eq!(phase, RunPhase::Quiescent);
    let snap = last(&engine);
    assert_eq!(snap.state.tickets["01"], TicketStatus::Closed);
    let deadlock = &snap.state.interrupts[0];
    assert_eq!(deadlock.ticket_id, "02");
    assert_eq!(deadlock.kind, InterruptKind::Deadlock);
    assert_eq!(deadlock.body, "blocker 01 was closed");
    assert!(snap.state.log.contains(
        &"interrupt answered for 01 (checkpoint): closed; it ran in the pool checkout, so its work was left in place there; nothing was reset".to_string()
    ), "{:#?}", snap.state.log);
    assert!(
        pool.read("issues/01.md")
            .contains("\n## Close note\n\nnot needed\n")
    );
    // Closing the dependent too finishes the run at a Review naming both as closed.
    let phase = answer(&engine, "02".into(), None, ResumeAction::Close, None)
        .await
        .unwrap();
    assert_eq!(phase, RunPhase::Quiescent);
    let snap = last(&engine);
    assert_eq!(
        snap.state.interrupts[0].body,
        "every ticket is done or closed.\n- 01: closed without merging\n- 02: closed without merging\napprove to end the run, or reject with a note naming the tickets to send back; their downstream tickets return to ready with them."
    );
    let phase = answer(&engine, "REVIEW".into(), None, ResumeAction::Approve, None)
        .await
        .unwrap();
    assert_eq!(phase, RunPhase::Done);
    assert_eq!(
        last(&engine).state.log.last().unwrap(),
        "pool done: every ticket reached done or was closed (01, 02 closed)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_review_reject_reopens_the_named_ticket_and_its_downstream() {
    let pool = Pool::git(&[("01", &[]), ("02", &["01"]), ("03", &[])]);
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let refused = answer(
        &engine,
        "REVIEW".into(),
        Some("nothing named".into()),
        ResumeAction::Reject,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(
        refused.to_string(),
        "review reject: name at least one ticket in the note (known: 01, 02, 03)"
    );
    let phase = answer(
        &engine,
        "REVIEW".into(),
        Some("redo 01".into()),
        ResumeAction::Reject,
        None,
    )
    .await
    .unwrap();
    assert_eq!(phase, RunPhase::Quiescent);
    let snap = last(&engine);
    assert!(
        snap.state
            .log
            .contains(&"review rejected: 01 back to ready; downstream 02 also reset".to_string())
    );
    assert!(
        pool.read("issues/01.md")
            .contains("\n## Review note\n\nredo 01\n")
    );
    assert_eq!(snap.state.interrupts[0].kind, InterruptKind::Review);
    assert_eq!(
        pool.events("01")
            .iter()
            .filter(|e| e.kind == TicketEventKind::Spawned)
            .count(),
        2
    );
    assert_eq!(
        pool.events("03")
            .iter()
            .filter(|e| e.kind == TicketEventKind::Spawned)
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acceptance_refuses_in_the_typescripts_order() {
    let pool = Pool::git(&[("01", &[])]);
    pool.script("01", vec![Script::checkpoint("wait")]);
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let refuse = |id: &str, action, attempt| {
        let engine = engine.clone();
        let id = id.to_owned();
        async move {
            engine
                .accept(id, None, action, attempt)
                .await
                .unwrap_err()
                .to_string()
        }
    };
    assert_eq!(
        refuse("01", ResumeAction::Adopt, None).await,
        "answer: adopt needs the attempt number of the candidate to take for 01"
    );
    assert_eq!(
        refuse("01", ResumeAction::Resume, Some(1)).await,
        "answer: an attempt only goes with adopt, not resume, for 01"
    );
    assert_eq!(
        refuse("09", ResumeAction::Resume, None).await,
        "resume: no pending interrupt for ticket 09"
    );
    assert_eq!(
        refuse("01", ResumeAction::Adopt, Some(1)).await,
        "answer: 01's checkpoint names no finished candidate to adopt; resume or close it"
    );
    assert_eq!(
        refuse("REVIEW", ResumeAction::Close, None).await,
        "resume: no pending interrupt for ticket REVIEW"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_puts_an_in_progress_ticket_with_no_live_agent_back_to_ready_with_a_note() {
    let pool = Pool::git(&[("01", &[])]);
    std::fs::write(
        pool.file("issues/01.md"),
        crate::testkit::ticket_text("01", &[], "in-progress"),
    )
    .unwrap();
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let snap = last(&engine);
    assert_eq!(snap.state.tickets["01"], TicketStatus::Done);
    let log = &snap.state.log;
    assert_eq!(
        log[0],
        "ticket 01: marker was in-progress with no live agent; back to ready"
    );
    assert_eq!(log[1], "Jev not configured, heuristics only");
    assert!(pool
        .read("issues/01.md")
        .contains("\n---\n\n## Brief, written by the engine\n\nThe engine process stopped while this ticket was in-progress"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_restores_the_checkpointed_state_and_re_raises_nothing_it_already_holds() {
    let pool = Pool::git(&[("01", &[])]);
    pool.script("01", vec![Script::crash(2)]);
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    engine.shutdown(None).await;
    assert_eq!(last(&engine).phase, RunPhase::Stopped);
    // A second engine on the same pool and store.
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let snap = last(&engine);
    assert_eq!(snap.state.interrupts.len(), 1);
    assert_eq!(snap.state.interrupts[0].kind, InterruptKind::Crash);
    assert!(snap.state.log.contains(
        &"rehydrated from checkpoint: 1 interrupt(s), 0 outcome(s) restored".to_string()
    ));
    assert_eq!(snap.state.tickets["01"], TicketStatus::InProgress);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shutdown_stops_the_headless_attempt_raises_no_crash_and_says_farewell() {
    let pool = Pool::git(&[("01", &[])]);
    pool.script(
        "01",
        vec![Script::done("never").with_work("touch started; sleep 30")],
    );
    let engine = pool.start().await;
    let started = pool.file("started");
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !started.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    engine
        .shutdown(Some(std::time::Duration::from_millis(500)))
        .await;
    let snap = last(&engine);
    assert_eq!(snap.phase, RunPhase::Stopped);
    assert!(snap.state.interrupts.is_empty());
    assert!(snap.state.log.contains(
        &"engine shutdown: super-step joined; no crash interrupts raised and nothing more scheduled"
            .to_string()
    ), "{:#?}", snap.state.log);
    let crash = pool
        .events("01")
        .into_iter()
        .find(|e| e.kind == TicketEventKind::Crash)
        .unwrap();
    assert_eq!(
        crash.payload["reason"],
        "harness stopped by engine shutdown (exited 143)"
    );
    assert_eq!(
        pool.store.closed.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_drive_that_cannot_go_on_dies_with_a_record_and_a_dead_phase() {
    let pool = Pool::git(&[("01", &[])]);
    // AGENT.md is read at every spawn: a directory there fails the read and kills the drive.
    std::fs::create_dir(pool.file("AGENT.md")).unwrap();
    let engine = pool.start().await;
    let error = tokio::time::timeout(std::time::Duration::from_secs(30), engine.settled())
        .await
        .unwrap()
        .unwrap_err();
    let snap = last(&engine);
    assert_eq!(snap.phase, RunPhase::Dead);
    let line = snap.state.log.last().unwrap();
    assert_eq!(line, &format!("pool dead: {error}"));
    let record = pool.read("runs/errors.jsonl");
    let parsed: serde_json::Value = serde_json::from_str(record.trim()).unwrap();
    assert_eq!(parsed["error"], error.to_string());
    assert_eq!(
        pool.store.closed.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_accept_processes_at_once_and_starts_a_fresh_drive() {
    let pool = Pool::git(&[("01", &[])]);
    pool.script("01", vec![Script::checkpoint("wait"), Script::done("done")]);
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    engine
        .accept("01".into(), None, ResumeAction::Resume, None)
        .await
        .unwrap();
    // Processed inside the call: the snapshot right after holds the answered state, running.
    let snap = last(&engine);
    assert_eq!(snap.phase, RunPhase::Running);
    assert!(snap.state.interrupts.is_empty());
    assert!(snap.queued_answers.is_empty());
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    // A retry of the processed answer is acknowledged with nothing new recorded.
    let answered = |pool: &Pool| {
        pool.events("01")
            .iter()
            .filter(|e| e.kind == TicketEventKind::Answered)
            .count()
    };
    assert_eq!(answered(&pool), 1);
    engine
        .accept("01".into(), None, ResumeAction::Resume, None)
        .await
        .unwrap();
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    assert_eq!(answered(&pool), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_an_agent_commits_to_its_worktree_copy_of_the_ticket_file_reaches_the_file_of_record()
{
    let pool = Pool::git(&[("01", &[]), ("02", &[])]);
    pool.script(
        "01",
        vec![Script::done("one").with_work(
            "echo '- note from 01' >> issues/01.md && git add issues/01.md && git commit -qm note",
        )],
    );
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let file = pool.read("issues/01.md");
    assert!(
        file.starts_with("<!-- state: id=01 blocked-by=none status=done -->\n"),
        "{file}"
    );
    assert!(file.ends_with("Do 01.\n- note from 01\n"), "{file}");
    assert!(
        !pool
            .kinds("01")
            .contains(&TicketEventKind::TicketFileConflict)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn both_copies_changing_the_same_lines_leave_conflict_markers_and_a_record() {
    let pool = Pool::git(&[("01", &[]), ("02", &[])]);
    let go = pool.file("go");
    pool.script(
        "01",
        vec![Script::done("one").with_work(&format!(
            "while [ ! -f {} ]; do sleep 0.05; done; sed -i 's/Do 01./Done by the agent./' issues/01.md && git add issues/01.md && git commit -qm note",
            go.display()
        ))],
    );
    // The operator edits the same line of the file of record while the attempt runs.
    let file = pool.file("issues/01.md");
    let engine = pool.start().await;
    let _ = wait_for(&engine, |s| {
        s.state.log.iter().any(|l| l.starts_with("super-step 1:"))
    })
    .await;
    let text = std::fs::read_to_string(&file).unwrap();
    std::fs::write(&file, text.replace("Do 01.", "Do 01, by the operator.")).unwrap();
    std::fs::write(&go, "").unwrap();
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("<<<<<<< pool (file of record)\n"), "{text}");
    assert!(text.contains(">>>>>>> branch pool/"), "{text}");
    assert!(
        pool.kinds("01")
            .contains(&TicketEventKind::TicketFileConflict)
    );
    let log = &last(&engine).state.log;
    assert!(log.contains(&"01: the pool's ticket file and the branch's copy changed the same lines; conflict markers left in issues/01.md".to_string()), "{log:#?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_store_gains_a_checkpoint_at_every_super_step_the_review_and_its_approval() {
    let pool = Pool::git(&[("01", &[]), ("02", &["01"])]);
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let phase = answer(&engine, "REVIEW".into(), None, ResumeAction::Approve, None)
        .await
        .unwrap();
    assert_eq!(phase, RunPhase::Done);
    let rows = pool.store.writes.lock().unwrap().clone();
    assert_eq!(rows.len(), 6);
    assert_eq!(
        rows[0]["tickets"],
        serde_json::json!({"01": "done", "02": "ready"})
    );
    assert_eq!(
        rows[1]["tickets"],
        serde_json::json!({"01": "done", "02": "done"})
    );
    assert_eq!(rows[1]["outcomes"]["01"]["summary"], "did 01");
    assert_eq!(rows[4]["interrupts"], serde_json::json!([]));
    assert_eq!(rows[4]["reviewApproved"], true);
    assert_eq!(
        rows[5]["log"].as_array().unwrap().last().unwrap(),
        "pool done: every ticket reached done"
    );
    assert_eq!(
        pool.store.closed.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blocked_by_cycle_raises_deadlocks_without_launching_anything() {
    let pool = Pool::git(&[("01", &["02"]), ("02", &["01"])]);
    let engine = pool.start().await;
    assert_eq!(settled(&engine).await, RunPhase::Quiescent);
    let snap = last(&engine);
    let bodies: Vec<(&str, &str)> = snap
        .state
        .interrupts
        .iter()
        .map(|i| (i.ticket_id.as_str(), i.body.as_str()))
        .collect();
    assert_eq!(
        bodies,
        [
            ("01", "blockers can never complete: 02"),
            ("02", "blockers can never complete: 01")
        ]
    );
    assert!(snap.state.log.contains(
        &"interrupt raised for 01 (deadlock): blockers can never complete: 02".to_string()
    ));
    assert_eq!(pool.kinds("01"), [TicketEventKind::Deadlock]);
    assert_eq!(
        serde_json::Value::Object(pool.events("01")[0].payload.clone()),
        serde_json::json!({"blockers": ["02"]})
    );
}
