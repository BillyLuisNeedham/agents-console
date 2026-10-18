use std::collections::HashMap;

use ac_protocol::{LineBase, OutcomeStatus};
use indexmap::IndexMap;
use serde_json::{Value, json};

use super::file::OLD_LINE_FILE;
use super::*;
use crate::plan::PRESETS;

// -------------------------------------------------------------------------------------------------
// A fake pool
// -------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Pool {
    tickets: HashMap<String, TicketFact>,
    outcomes: HashMap<String, Outcome>,
    conversations: HashMap<String, ConversationFact>,
    outside: Vec<Blocker>,
    /// Every Ticket file the shell wrote, by id.
    written: IndexMap<String, String>,
}

impl LineFacts for Pool {
    fn ticket(&self, id: &TicketId) -> TicketFact {
        self.tickets
            .get(id.as_str())
            .cloned()
            .unwrap_or(TicketFact::Unwritten)
    }
    fn conversation(&self, id: &TicketId) -> ConversationFact {
        self.conversations
            .get(id.as_str())
            .cloned()
            .unwrap_or(ConversationFact::Unopened)
    }
    fn outcome(&self, id: &TicketId) -> Option<&Outcome> {
        self.outcomes.get(id.as_str())
    }
    fn outside_blockers(&self) -> Vec<Blocker> {
        self.outside.clone()
    }
    fn runs_dir(&self) -> String {
        "/pool/runs".to_owned()
    }
}

impl Pool {
    fn done(&mut self, id: &str, kind: TicketKind, verdict: Option<Value>, brief: Option<&str>) {
        let fact = TicketFact::Done {
            verdict: verdict_of(kind, verdict.as_ref()).expect("a valid verdict"),
            items: Vec::new(),
            merged: true,
        };
        self.outcomes.insert(
            id.to_owned(),
            Outcome {
                status: OutcomeStatus::Done,
                summary: format!("{id} did its work"),
                commit_sha: None,
                brief: brief.map(str::to_owned),
                spawn: None,
                verdict,
            },
        );
        self.tickets.insert(id.to_owned(), fact);
    }

    fn agent(&mut self, id: &str) {
        self.done(id, TicketKind::Agent, None, None);
    }

    fn prove(&mut self, id: &str, pass: bool) {
        let verdict = json!({
            "prove": if pass { "pass" } else { "fail" },
            "evidence": format!("/pool/runs/{id}.evidence"),
        });
        let brief = (!pass).then_some("the login button does nothing");
        self.done(id, TicketKind::Prove, Some(verdict), brief);
    }

    fn review(&mut self, id: &str, findings: Value) {
        self.done(
            id,
            TicketKind::Review,
            Some(json!({ "findings": findings })),
            None,
        );
    }

    fn decide(&mut self, id: &str, verdict: Value) {
        self.done(id, TicketKind::Decide, Some(verdict), None);
    }

    fn answer(&mut self, id: &str, note: Option<&str>, by_steward: bool) {
        self.tickets.insert(
            id.to_owned(),
            TicketFact::Answered {
                note: note.map(str::to_owned),
                by_steward,
            },
        );
    }

    fn close(&mut self, id: &str) {
        self.tickets.insert(id.to_owned(), TicketFact::Closed);
    }
}

/// Applying every observed event twice leaves the run as applying it once does.
fn assert_idempotent(run: &LineRun, pool: &Pool) {
    let mut once = run.clone();
    let mut twice = run.clone();
    for event in run.observe(pool) {
        let _ = once.apply(event.clone());
        let _ = twice.apply(event.clone());
        let _ = twice.apply(event);
    }
    assert_eq!(once, twice, "a second apply changed the run");
}

/// One tick as the shell runs it: advance, then write the projection, each new Ticket live.
fn tick(run: &mut LineRun, pool: &mut Pool) -> Advanced {
    assert_idempotent(run, pool);
    let advanced = run.advance(pool);
    let mut again = run.clone();
    assert!(
        !again.advance(pool).changed,
        "advance stopped short of its fixpoint"
    );
    for ticket in &advanced.effects.tickets {
        pool.written
            .insert(ticket.id.to_string(), ticket_text(ticket));
        pool.tickets.insert(ticket.id.to_string(), TicketFact::Live);
    }
    for hold in &advanced.effects.holds {
        pool.written.insert(hold.id.to_string(), hold_text(hold));
        pool.tickets.insert(hold.id.to_string(), TicketFact::Live);
    }
    for conversation in &advanced.effects.conversations {
        pool.conversations
            .insert(conversation.id.to_string(), ConversationFact::Open);
    }
    advanced
}

fn written(advanced: &Advanced) -> Vec<String> {
    let tickets = advanced.effects.tickets.iter().map(|t| t.id.to_string());
    let holds = advanced.effects.holds.iter().map(|h| h.id.to_string());
    tickets.chain(holds).collect()
}

fn id(raw: &str) -> TicketId {
    TicketId::new(raw)
}

fn node(raw: &str) -> NodeId {
    NodeId::parse(raw).unwrap()
}

fn factory_today() -> Plan {
    Plan::parse(PRESETS[0].json).unwrap()
}

fn places() -> LinePlaces {
    LinePlaces {
        branch: "line/demo".to_owned(),
        base: Some(LineBase {
            base_ref: "main".to_owned(),
            commit: "abc123".to_owned(),
        }),
        ..LinePlaces::default()
    }
}

fn brief(json: &str) -> LineBrief {
    LineBrief::parse(json).unwrap()
}

/// Factory today started from a brief, its first tick taken.
fn started(finish: &str) -> (LineRun, Pool) {
    let text = format!(r#"{{"spec": "docs/specs/demo.md", "finish": "{finish}"}}"#);
    let mut run =
        LineRun::start(factory_today(), places(), LineStart::Brief(brief(&text))).unwrap();
    let mut pool = Pool::default();
    assert_eq!(written(&tick(&mut run, &mut pool)), ["implement-1"]);
    (run, pool)
}

fn ticket<'a>(advanced: &'a Advanced, raw: &str) -> &'a NewTicket {
    advanced
        .effects
        .tickets
        .iter()
        .find(|t| t.id.as_str() == raw)
        .unwrap_or_else(|| panic!("{raw} was not projected: {:?}", written(advanced)))
}

fn hold<'a>(advanced: &'a Advanced, raw: &str) -> &'a NewHold {
    advanced
        .effects
        .holds
        .iter()
        .find(|h| h.id.as_str() == raw)
        .unwrap_or_else(|| panic!("{raw} was not projected: {:?}", written(advanced)))
}

/// A plan from its nodes and edges, each node given a place.
fn plan(nodes: Value, edges: Value) -> Plan {
    let nodes: Vec<Value> = nodes
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            let mut n = n.clone();
            n["x"] = json!(0);
            n["y"] = json!(0);
            n["title"] = n["id"].clone();
            n
        })
        .collect();
    Plan::from_value(&json!({"horde": 1, "name": "test", "nodes": nodes, "edges": edges}))
        .unwrap_or_else(|problems| panic!("{problems:?}"))
}

fn work_run(plan: Plan) -> (LineRun, Pool) {
    let run = LineRun::start(plan, places(), LineStart::Work("make it so".to_owned())).unwrap();
    (run, Pool::default())
}

// -------------------------------------------------------------------------------------------------
// Factory today
// -------------------------------------------------------------------------------------------------

#[test]
fn the_pass_path_reaches_the_finish_hold_then_the_finish_ticket_for_a_draft_pr() {
    let (mut run, mut pool) = started("draft-pr");

    pool.agent("implement-1");
    let prove = tick(&mut run, &mut pool);
    assert_eq!(written(&prove), ["prove-1"]);
    assert_eq!(ticket(&prove, "prove-1").blocked_by, [id("implement-1")]);

    pool.prove("prove-1", true);
    assert_eq!(written(&tick(&mut run, &mut pool)), ["review-1"]);
    pool.review("review-1", json!([]));
    let decide = tick(&mut run, &mut pool);
    assert_eq!(written(&decide), ["decide-1"]);
    assert_eq!(
        ticket(&decide, "decide-1").check,
        OutcomeCheck::Decide {
            musts: Vec::new(),
            report: "/pool/runs/demo-decide-1-report.html".to_owned()
        }
    );

    pool.decide("decide-1", json!({"decide": "ship"}));
    let finish = tick(&mut run, &mut pool);
    assert_eq!(written(&finish), ["finish-1"]);
    let finish_hold = hold(&finish, "finish-1");
    assert_eq!(finish_hold.blocked_by, [id("decide-1")]);
    assert!(
        finish_hold
            .brief
            .contains("/pool/runs/demo-decide-1-report.html"),
        "{}",
        finish_hold.brief
    );
    assert!(
        finish_hold
            .brief
            .contains("`finish-1-act` carries out the Finish (`draft-pr`)")
    );
    assert!(!run.steward_may_answer(&id("finish-1")));

    pool.answer("finish-1", Some("approved"), false);
    let act = tick(&mut run, &mut pool);
    assert_eq!(written(&act), ["finish-1-act"]);
    assert_eq!(
        run.status(),
        &LineStatus::Acting {
            ticket: id("finish-1-act")
        }
    );
    let act_ticket = ticket(&act, "finish-1-act");
    assert_eq!(act_ticket.blocked_by, [id("finish-1")]);
    assert_eq!(
        act_ticket.check,
        OutcomeCheck::FinishAct(FinishAct::DraftPr)
    );
    assert!(
        act_ticket
            .body
            .contains("gh pr create --draft --base main --head line/demo")
    );
    assert!(act_ticket.body.contains("### The Line base on origin"));
    assert!(!run.steward_may_answer(&id("finish-1-act")));

    pool.done(
        "finish-1-act",
        TicketKind::Agent,
        Some(json!({"url": "https://example.test/pr/1"})),
        None,
    );
    let end = tick(&mut run, &mut pool);
    assert_eq!(run.status(), &LineStatus::Done);
    assert_eq!(end.effects.ended, Some(LineStatus::Done));
    assert!(!run.steward_may_answer(&id("implement-1")));
}

#[test]
fn approving_a_finish_with_act_none_ends_the_line_with_no_finish_ticket() {
    let (mut run, mut pool) = started("none");
    pool.agent("implement-1");
    tick(&mut run, &mut pool);
    pool.prove("prove-1", true);
    tick(&mut run, &mut pool);
    pool.review("review-1", json!([]));
    tick(&mut run, &mut pool);
    pool.decide("decide-1", json!({"decide": "ship"}));
    tick(&mut run, &mut pool);
    pool.answer("finish-1", None, false);
    let end = tick(&mut run, &mut pool);
    assert!(written(&end).is_empty());
    assert_eq!(run.status(), &LineStatus::Done);
}

#[test]
fn a_done_copy_that_is_not_merged_does_not_settle() {
    let (mut run, mut pool) = started("none");
    pool.agent("implement-1");
    pool.tickets.insert(
        "implement-1".to_owned(),
        TicketFact::Done {
            verdict: Verdict::Done,
            items: Vec::new(),
            merged: false,
        },
    );
    assert!(written(&tick(&mut run, &mut pool)).is_empty());
    pool.agent("implement-1");
    assert_eq!(written(&tick(&mut run, &mut pool)), ["prove-1"]);
}

#[test]
fn prove_fails_twice_then_holds_and_each_resume_buys_exactly_one_pass() {
    let (mut run, mut pool) = started("none");
    pool.agent("implement-1");
    tick(&mut run, &mut pool);

    pool.prove("prove-1", false);
    let fix = tick(&mut run, &mut pool);
    assert_eq!(written(&fix), ["implement-2"]);
    let body = &ticket(&fix, "implement-2").body;
    assert!(
        body.contains("What Prove found:\n\nthe login button does nothing"),
        "{body}"
    );
    assert!(
        body.contains("Evidence: `/pool/runs/prove-1.evidence`"),
        "{body}"
    );
    pool.agent("implement-2");
    tick(&mut run, &mut pool);
    pool.prove("prove-2", false);
    assert_eq!(written(&tick(&mut run, &mut pool)), ["implement-3"]);
    pool.agent("implement-3");
    tick(&mut run, &mut pool);

    pool.prove("prove-3", false);
    let spent = tick(&mut run, &mut pool);
    assert_eq!(written(&spent), ["prove-fail-implement-3"]);
    let loop_hold = hold(&spent, "prove-fail-implement-3");
    assert!(
        loop_hold
            .brief
            .starts_with("The loop prove -> implement is spent (2 of 2); Resume buys one more pass, Close stops it"),
        "{}",
        loop_hold.brief
    );
    assert_eq!(loop_hold.blocked_by, [id("prove-3")]);
    assert_eq!(
        run.node_of(&id("prove-fail-implement-3")),
        Some(&node("prove"))
    );
    assert!(run.is_hold(&id("prove-fail-implement-3")));
    assert!(run.steward_may_answer(&id("prove-fail-implement-3")));

    pool.answer("prove-fail-implement-3", None, true);
    let bought = tick(&mut run, &mut pool);
    assert_eq!(written(&bought), ["implement-4"]);
    assert_eq!(
        ticket(&bought, "implement-4").blocked_by,
        [id("prove-3"), id("prove-fail-implement-3")]
    );
    pool.agent("implement-4");
    tick(&mut run, &mut pool);

    pool.prove("prove-4", false);
    let again = tick(&mut run, &mut pool);
    assert_eq!(written(&again), ["prove-fail-implement-4"]);
    assert!(
        !run.steward_may_answer(&id("prove-fail-implement-4")),
        "the Steward answers a spent loop once per reset"
    );

    pool.answer(
        "prove-fail-implement-4",
        Some("try the other driver"),
        false,
    );
    let notes = tick(&mut run, &mut pool);
    assert_eq!(written(&notes), ["implement-5"]);
    assert!(
        ticket(&notes, "implement-5")
            .body
            .contains("try the other driver")
    );
    pool.agent("implement-5");
    tick(&mut run, &mut pool);
    pool.prove("prove-5", false);
    assert_eq!(
        written(&tick(&mut run, &mut pool)),
        ["prove-fail-implement-5"]
    );
}

#[test]
fn closing_a_spent_loop_hands_prove_on_closed_to_decide() {
    let (mut run, mut pool) = started("none");
    for n in 1..=3 {
        pool.agent(&format!("implement-{n}"));
        tick(&mut run, &mut pool);
        pool.prove(&format!("prove-{n}"), false);
        tick(&mut run, &mut pool);
    }
    pool.close("prove-fail-implement-3");
    let decide = tick(&mut run, &mut pool);
    assert_eq!(written(&decide), ["decide-1"]);
    let body = &ticket(&decide, "decide-1").body;
    assert!(
        body.contains("the loop prove -> implement was stopped"),
        "{body}"
    );
    assert!(body.contains("- `prove-1`: fail"), "{body}");
    assert!(body.contains("- `prove-3`: fail"), "{body}");
}

/// Runs Factory today to `decide-1` with one Prove failure and a must finding.
fn to_first_decide(run: &mut LineRun, pool: &mut Pool) {
    pool.agent("implement-1");
    tick(run, pool);
    pool.prove("prove-1", false);
    tick(run, pool);
    pool.agent("implement-2");
    tick(run, pool);
    pool.prove("prove-2", true);
    tick(run, pool);
    pool.review(
        "review-1",
        json!([
            {"severity": "must", "title": "Login leaks", "detail": "the token is logged"},
            {"severity": "nit", "title": "Typo", "detail": "recieve"}
        ]),
    );
    tick(run, pool);
}

#[test]
fn another_round_lists_its_fixes_and_resets_the_prove_loop() {
    let (mut run, mut pool) = started("none");
    to_first_decide(&mut run, &mut pool);
    let check = run.outcome_check(&id("decide-1"), &pool).unwrap();
    let OutcomeCheck::Decide { musts, report } = &check else {
        panic!("{check:?}")
    };
    assert_eq!(musts, &["Login leaks"]);
    let written_report = |path: &str| path == report;
    let missing =
        json!({"decide": "another-round", "fixes": [{"title": "Typo", "reason": "cheap"}]});
    assert!(
        check
            .problem(Some(&missing), &written_report)
            .unwrap()
            .contains("\"Login leaks\"")
    );
    let verdict = json!({
        "decide": "another-round",
        "fixes": [{"title": "Login leaks", "reason": "a must"}],
        "dropped": [{"title": "Typo", "reason": "a nit"}],
    });
    assert_eq!(check.problem(Some(&verdict), &written_report), None);
    assert!(
        check
            .problem(Some(&verdict), &|_| false)
            .unwrap()
            .contains("the report is not at /pool/runs/demo-decide-1-report.html")
    );

    pool.decide("decide-1", verdict);
    let round = tick(&mut run, &mut pool);
    assert_eq!(written(&round), ["implement-3"]);
    let body = &ticket(&round, "implement-3").body;
    assert!(
        body.contains("- **Login leaks**: a must\n  the token is logged (must)"),
        "{body}"
    );
    assert!(
        body.contains("Dropped, so leave them alone:\n\n- Typo: a nit"),
        "{body}"
    );
    let prove_loop = run
        .view()
        .edges
        .into_iter()
        .find(|e| e.edge.on == "fail")
        .unwrap();
    assert_eq!((prove_loop.count, prove_loop.max), (0, 2));

    pool.agent("implement-3");
    tick(&mut run, &mut pool);
    pool.prove("prove-3", false);
    assert_eq!(written(&tick(&mut run, &mut pool)), ["implement-4"]);
    pool.agent("implement-4");
    tick(&mut run, &mut pool);
    pool.prove("prove-4", false);
    assert_eq!(
        written(&tick(&mut run, &mut pool)),
        ["implement-5"],
        "the reset gave Prove two fresh failures"
    );
}

#[test]
fn a_spent_another_round_goes_to_the_finish_with_its_note() {
    let (mut run, mut pool) = started("none");
    to_first_decide(&mut run, &mut pool);
    let round =
        json!({"decide": "another-round", "fixes": [{"title": "Login leaks", "reason": "must"}]});
    pool.decide("decide-1", round.clone());
    tick(&mut run, &mut pool);
    pool.agent("implement-3");
    tick(&mut run, &mut pool);
    pool.prove("prove-3", true);
    tick(&mut run, &mut pool);
    pool.review("review-2", json!([]));
    let decide = tick(&mut run, &mut pool);
    let body = &ticket(&decide, "decide-2").body;
    assert!(
        body.contains("No round is left: another-round now goes to finish"),
        "{body}"
    );
    assert!(body.contains("- `prove-3`: pass"), "{body}");
    assert!(
        !body.contains("prove-1"),
        "a Decide reads only since its previous pass: {body}"
    );

    pool.decide("decide-2", round);
    let finish = tick(&mut run, &mut pool);
    assert_eq!(written(&finish), ["finish-1"]);
    let brief = &hold(&finish, "finish-1").brief;
    assert!(
        brief.contains("the loop decide -> implement is spent (1 of 1)"),
        "{brief}"
    );
    assert!(
        brief.contains("/pool/runs/demo-decide-2-report.html"),
        "{brief}"
    );
}

#[test]
fn notes_on_the_finish_go_back_to_implement_and_reset_the_round_count() {
    let (mut run, mut pool) = started("none");
    to_first_decide(&mut run, &mut pool);
    pool.decide(
        "decide-1",
        json!({"decide": "another-round", "fixes": [{"title": "Login leaks", "reason": "must"}]}),
    );
    tick(&mut run, &mut pool);
    pool.agent("implement-3");
    tick(&mut run, &mut pool);
    pool.prove("prove-3", true);
    tick(&mut run, &mut pool);
    pool.review("review-2", json!([]));
    tick(&mut run, &mut pool);
    pool.decide("decide-2", json!({"decide": "ship"}));
    tick(&mut run, &mut pool);

    assert_eq!(
        run.check_answer(&id("finish-1"), &HoldAnswer::Revise("more".into()), &pool),
        Ok(())
    );
    pool.answer("finish-1", Some("rename the flag"), false);
    let back = tick(&mut run, &mut pool);
    assert_eq!(written(&back), ["implement-4"]);
    assert!(
        ticket(&back, "implement-4")
            .body
            .contains("rename the flag")
    );
    assert_eq!(run.status(), &LineStatus::Running);
    let round_loop = run
        .view()
        .edges
        .into_iter()
        .find(|e| e.edge.on == "another-round")
        .unwrap();
    assert_eq!(round_loop.count, 0);
}

#[test]
fn notes_on_the_finish_after_a_spent_round_send_the_work_back_without_the_halt() {
    let (mut run, mut pool) = started("none");
    to_first_decide(&mut run, &mut pool);
    let round =
        json!({"decide": "another-round", "fixes": [{"title": "Login leaks", "reason": "must"}]});
    pool.decide("decide-1", round.clone());
    tick(&mut run, &mut pool);
    pool.agent("implement-3");
    tick(&mut run, &mut pool);
    pool.prove("prove-3", true);
    tick(&mut run, &mut pool);
    pool.review("review-2", json!([]));
    tick(&mut run, &mut pool);
    pool.decide("decide-2", round);
    tick(&mut run, &mut pool);

    pool.answer("finish-1", Some("rename the flag"), false);
    let back = tick(&mut run, &mut pool);
    let body = &ticket(&back, "implement-4").body;
    assert!(!body.contains("Halted upstream"), "{body}");
    pool.agent("implement-4");
    tick(&mut run, &mut pool);
    pool.prove("prove-4", true);
    tick(&mut run, &mut pool);
    pool.review("review-3", json!([]));
    let decide = tick(&mut run, &mut pool);
    let body = &ticket(&decide, "decide-3").body;
    assert!(
        body.contains("Choose another round") && body.contains("1 more round is left."),
        "{body}"
    );
}

#[test]
fn closing_implement_runs_decide_with_halted_then_the_finish() {
    let (mut run, mut pool) = started("none");
    pool.close("implement-1");
    let decide = tick(&mut run, &mut pool);
    assert_eq!(written(&decide), ["decide-1"]);
    let decide_ticket = ticket(&decide, "decide-1");
    assert!(
        decide_ticket.blocked_by.is_empty(),
        "a Closed blocker would deadlock"
    );
    assert!(
        decide_ticket
            .body
            .contains("Work upstream halted (implement-1 was closed)"),
        "{}",
        decide_ticket.body
    );

    pool.close("decide-1");
    let finish = tick(&mut run, &mut pool);
    assert_eq!(
        written(&finish),
        ["finish-1"],
        "an unrouted closed reaches the Finish"
    );
    assert!(
        hold(&finish, "finish-1")
            .brief
            .contains("decide-1 was closed")
    );
    pool.close("finish-1");
    tick(&mut run, &mut pool);
    assert_eq!(run.status(), &LineStatus::Closed);
}

// -------------------------------------------------------------------------------------------------
// The Finish waits
// -------------------------------------------------------------------------------------------------

#[test]
fn the_finish_hold_waits_for_every_blocker_and_approval_is_refused_with_the_list() {
    let (mut run, mut pool) = started("none");
    pool.agent("implement-1");
    tick(&mut run, &mut pool);
    pool.prove("prove-1", true);
    tick(&mut run, &mut pool);
    pool.review("review-1", json!([]));
    tick(&mut run, &mut pool);
    pool.decide("decide-1", json!({"decide": "ship"}));
    pool.outside = vec![
        Blocker::Ticket("side-quest".into()),
        Blocker::PendingSpawn("spawn-1".into()),
    ];
    assert!(written(&tick(&mut run, &mut pool)).is_empty());
    assert_eq!(
        run.view().waiting_for,
        ["side-quest", "the Pending spawn spawn-1"]
    );

    pool.outside.clear();
    assert_eq!(written(&tick(&mut run, &mut pool)), ["finish-1"]);
    assert!(run.view().waiting_for.is_empty());

    pool.outside = vec![Blocker::Unmerged("side-quest".into())];
    let refused = run
        .check_answer(&id("finish-1"), &HoldAnswer::Open, &pool)
        .unwrap_err();
    assert_eq!(refused, Refusal::FinishBlocked(pool.outside.clone()));
    assert_eq!(
        refused.to_string(),
        "the Finish is waiting for: side-quest (done, not merged)"
    );
    assert_eq!(
        run.check_answer(&id("finish-1"), &HoldAnswer::Closed, &pool),
        Ok(())
    );
    assert_eq!(
        run.check_answer(&id("implement-1"), &HoldAnswer::Open, &pool),
        Ok(())
    );
    pool.outside.clear();
    assert_eq!(
        run.check_answer(&id("finish-1"), &HoldAnswer::Open, &pool),
        Ok(())
    );
}

#[test]
fn notes_on_a_finish_with_no_revise_edge_are_refused() {
    let (mut run, mut pool) = work_run(plan(
        json!([{"kind": "agent", "id": "build"}, {"kind": "finish", "id": "finish"}]),
        json!([{"from": "build", "on": "done", "to": "finish"}]),
    ));
    tick(&mut run, &mut pool);
    pool.agent("build-1");
    assert_eq!(written(&tick(&mut run, &mut pool)), ["finish-1"]);
    assert_eq!(
        run.check_answer(&id("finish-1"), &HoldAnswer::Revise("redo".into()), &pool),
        Err(Refusal::NoRevise)
    );
}

// -------------------------------------------------------------------------------------------------
// Gates
// -------------------------------------------------------------------------------------------------

fn gated(open: &str) -> Plan {
    plan(
        json!([
            {"kind": "agent", "id": "draft"},
            {"kind": "gate", "id": "approve", "open": open},
            {"kind": "agent", "id": "ship"},
            {"kind": "finish", "id": "finish"}
        ]),
        json!([
            {"from": "draft", "on": "done", "to": "approve"},
            {"from": "approve", "on": "open", "to": "ship"},
            {"from": "approve", "on": "revise", "to": "draft"},
            {"from": "ship", "on": "done", "to": "finish"}
        ]),
    )
}

#[test]
fn an_operator_gate_holds_and_its_answers_open_revise_or_close() {
    let (mut run, mut pool) = work_run(gated("operator"));
    let first = tick(&mut run, &mut pool);
    assert!(
        ticket(&first, "draft-1")
            .body
            .contains("## The Line's work\n\nmake it so")
    );
    pool.agent("draft-1");
    let gate = tick(&mut run, &mut pool);
    assert_eq!(written(&gate), ["approve-1"]);
    assert!(
        hold(&gate, "approve-1")
            .brief
            .contains("sends revise with your notes to draft")
    );
    assert!(!run.steward_may_answer(&id("approve-1")));
    assert!(pool.written["approve-1"].starts_with(
        "<!-- state: id=approve-1 blocked-by=draft-1 status=checkpoint node=approve hold -->"
    ));

    pool.answer("approve-1", Some("shorter please"), false);
    let revised = tick(&mut run, &mut pool);
    assert_eq!(written(&revised), ["draft-2"]);
    assert!(ticket(&revised, "draft-2").body.contains("shorter please"));
    assert_eq!(
        ticket(&revised, "draft-2").blocked_by,
        [id("approve-1"), id("draft-1")]
    );

    pool.agent("draft-2");
    tick(&mut run, &mut pool);
    pool.answer("approve-2", Some("Approved."), false);
    assert_eq!(written(&tick(&mut run, &mut pool)), ["ship-1"]);

    let (mut closed, mut pool) = work_run(gated("operator"));
    tick(&mut closed, &mut pool);
    pool.agent("draft-1");
    tick(&mut closed, &mut pool);
    pool.close("approve-1");
    let finish = tick(&mut closed, &mut pool);
    assert_eq!(written(&finish), ["finish-1"]);
    assert_eq!(hold(&finish, "finish-1").blocked_by, [id("draft-1")]);
}

#[test]
fn a_steward_gate_is_the_stewards_and_an_auto_gate_opens_at_once() {
    let (mut run, mut pool) = work_run(gated("steward"));
    tick(&mut run, &mut pool);
    pool.agent("draft-1");
    tick(&mut run, &mut pool);
    assert!(run.steward_may_answer(&id("approve-1")));
    assert!(
        !run.steward_may_answer(&id("draft-1")),
        "draft is on the operator's checkpoint"
    );

    let (mut auto, mut pool) = work_run(plan(
        json!([
            {"kind": "agent", "id": "draft"},
            {"kind": "gate", "id": "approve", "open": "auto"},
            {"kind": "agent", "id": "ship"},
            {"kind": "finish", "id": "finish"}
        ]),
        json!([
            {"from": "draft", "on": "done", "to": "approve"},
            {"from": "approve", "on": "open", "to": "ship"},
            {"from": "ship", "on": "done", "to": "finish"}
        ]),
    ));
    tick(&mut auto, &mut pool);
    pool.agent("draft-1");
    let ship = tick(&mut auto, &mut pool);
    assert_eq!(written(&ship), ["ship-1"]);
    assert_eq!(ticket(&ship, "ship-1").blocked_by, [id("draft-1")]);
}

#[test]
fn a_join_all_gate_waits_for_every_incoming_edge() {
    let (mut run, mut pool) = work_run(plan(
        json!([
            {"kind": "agent", "id": "front"},
            {"kind": "agent", "id": "back"},
            {"kind": "gate", "id": "both", "open": "operator", "join": "all"},
            {"kind": "finish", "id": "finish"}
        ]),
        json!([
            {"from": "front", "on": "done", "to": "both"},
            {"from": "back", "on": "done", "to": "both"},
            {"from": "both", "on": "open", "to": "finish"}
        ]),
    ));
    assert_eq!(written(&tick(&mut run, &mut pool)), ["front-1", "back-1"]);
    pool.agent("back-1");
    assert!(written(&tick(&mut run, &mut pool)).is_empty());
    assert_eq!(run.view().nodes[2].arrived.len(), 1);
    pool.agent("front-1");
    let gate = tick(&mut run, &mut pool);
    assert_eq!(written(&gate), ["both-1"]);
    let mut after = hold(&gate, "both-1").blocked_by.clone();
    after.sort();
    assert_eq!(after, [id("back-1"), id("front-1")]);
}

// -------------------------------------------------------------------------------------------------
// Determinism and persistence
// -------------------------------------------------------------------------------------------------

/// Factory today through one Prove failure, as file texts in write order.
fn scripted() -> (LineRun, IndexMap<String, String>) {
    let (mut run, mut pool) = started("pr");
    pool.agent("implement-1");
    tick(&mut run, &mut pool);
    pool.prove("prove-1", false);
    tick(&mut run, &mut pool);
    (run, pool.written)
}

#[test]
fn the_same_facts_give_the_same_ids_and_the_same_bytes() {
    let (first, texts) = scripted();
    let (second, again) = scripted();
    assert_eq!(first, second);
    assert_eq!(texts, again);
    assert_eq!(
        texts.keys().collect::<Vec<_>>(),
        ["implement-1", "prove-1", "implement-2"]
    );
}

#[test]
fn a_deleted_unlaunched_projection_is_written_again_byte_for_byte() {
    let (mut run, mut pool) = started("none");
    let before = pool.written["implement-1"].clone();
    pool.tickets.remove("implement-1");
    let again = tick(&mut run, &mut pool);
    assert_eq!(written(&again), ["implement-1"]);
    assert!(!again.changed);
    assert_eq!(pool.written["implement-1"], before);
}

#[test]
fn ticket_files_carry_node_and_spawn_assign_and_leave_empty_fields_out() {
    let (_, texts) = scripted();
    let implement = &texts["implement-1"];
    let state = implement.lines().next().unwrap();
    assert!(state.starts_with(
        "<!-- state: id=implement-1 blocked-by=none status=ready node=implement spawn-assign="
    ));
    assert!(state.contains("%22drivers%22%3A%22tdd%22"), "{state}");
    assert!(implement.contains("# implement-1: Implement, pass 1\n\n**Node** `implement` (Agent)"));
    assert!(
        texts["implement-2"]
            .starts_with("<!-- state: id=implement-2 blocked-by=prove-1 status=ready")
    );

    let (mut bare, mut pool) = work_run(plan(
        json!([{"kind": "agent", "id": "build"}, {"kind": "finish", "id": "finish"}]),
        json!([{"from": "build", "on": "done", "to": "finish"}]),
    ));
    tick(&mut bare, &mut pool);
    assert!(
        pool.written["build-1"]
            .starts_with("<!-- state: id=build-1 blocked-by=none status=ready node=build -->")
    );
}

#[test]
fn line_json_round_trips_and_the_old_shape_is_refused() {
    let (mut run, mut pool) = started("draft-pr");
    for n in 1..=3 {
        pool.agent(&format!("implement-{n}"));
        tick(&mut run, &mut pool);
        pool.prove(&format!("prove-{n}"), false);
        tick(&mut run, &mut pool);
    }
    let text = run.to_json();
    assert!(text.contains("\"horde\": 1"));
    let back = LineRun::from_json(&text).unwrap();
    assert_eq!(back, run);
    assert_eq!(back.to_json(), text);

    let old = json!({
        "brief": {"spec": "docs/specs/x.md"}, "briefPath": "docs/specs/x.brief.json",
        "status": "running", "round": 1, "station": "implement", "ticket": "r1-implement",
        "proveFails": 0, "fixesBought": 0, "gated": false, "extraRounds": 0, "halted": null,
        "rounds": []
    });
    assert_eq!(
        LineRun::from_json(&old.to_string()),
        Err(OLD_LINE_FILE.to_owned())
    );
    let mut broken = run.to_file();
    broken.run.nodes[0].id = "nowhere".to_owned();
    assert!(
        LineRun::from_file(broken)
            .unwrap_err()
            .contains("no node nowhere")
    );
}

// -------------------------------------------------------------------------------------------------
// Briefs, verdicts and what Line start refuses
// -------------------------------------------------------------------------------------------------

#[test]
fn a_brief_sets_the_line_and_overrides_nodes_on_the_frozen_plan() {
    let line_brief = brief(
        r#"{"spec": "docs/specs/demo.md", "pushBase": true, "finish": "pr",
            "nodes": {"implement": {"assign": {"model": "sonnet"}, "note": "keep it small"}}}"#,
    );
    let run = LineRun::start(factory_today(), places(), LineStart::Brief(line_brief)).unwrap();
    assert_eq!(run.places.spec.as_deref(), Some("docs/specs/demo.md"));
    assert!(run.places.push_base);
    let (plan, rev) = run.plan();
    assert_eq!(rev, 1);
    let NodeBody::Ticket(implement) = &plan.node(&node("implement")).unwrap().body else {
        panic!()
    };
    assert_eq!(implement.assign.model.as_deref(), Some("sonnet"));
    assert_eq!(implement.assign.harness.as_deref(), Some("claude"));
    assert_eq!(implement.note.as_deref(), Some("keep it small"));
    assert_eq!(run.finish_act(), &FinishAct::Pr);

    assert!(LineBrief::parse(r#"{"factory": {}}"#).is_err());
    assert!(LineBrief::parse(r#"{"spec": " "}"#).is_err());
    let unknown = brief(r#"{"nodes": {"nowhere": {"note": "x"}}}"#);
    assert_eq!(
        LineRun::start(factory_today(), places(), LineStart::Brief(unknown)).unwrap_err(),
        "nodes: the Plan has no node nowhere"
    );
}

/// Factory today begun on `work`, its first tick taken: `grill-1` is open.
fn grilling(work: &str) -> (LineRun, Pool, NewConversation) {
    let mut run = LineRun::start(factory_today(), places(), LineStart::Work(work.into())).unwrap();
    let mut pool = Pool::default();
    let opened = tick(&mut run, &mut pool);
    assert_eq!(opened.effects.conversations.len(), 1);
    let grill = opened.effects.conversations[0].clone();
    (run, pool, grill)
}

#[test]
fn work_on_a_plan_with_an_entry_conversation_opens_its_first_pass() {
    let (mut run, mut pool, grill) = grilling("#186");
    assert_eq!(grill.id, id("grill-1"));
    assert_eq!(grill.node, node("grill"));
    assert_eq!(grill.title, "Grill, pass 1");
    assert_eq!(grill.skill.as_deref(), Some("my-grill-with-docs"));
    assert_eq!(grill.assign.model.as_deref(), Some("opus"));
    assert!(grill.opening.starts_with(
        "You are the Grill Conversation (`grill-1`) of this pool's Line (ADR-0039)"
    ));
    assert!(grill.opening.contains(
        "## The Line's work\n\nThe piece of work for this Line is issue #186. Read it (gh issue \
         view 186) and grill me on it.\n\nThis Line was cut from `main` at `abc123`."
    ));
    assert_eq!(run.live_conversation(&node("grill")), Some(&id("grill-1")));
    assert_eq!(
        run.brief_path(&id("grill-1")),
        "docs/specs/demo.grill-1.brief.json"
    );
    assert!(
        tick(&mut run, &mut pool).effects.conversations.is_empty(),
        "an open pass is not opened again"
    );
    let (_, _, words) = grilling("tidy the header");
    assert!(words.opening.contains(
        "## The Line's work\n\ntidy the header\n\nThis Line was cut from `main` at `abc123`."
    ));
}

#[test]
fn a_brief_absorbs_its_spec_and_overrides_before_it_hands_on_done_with_its_items() {
    let (mut run, mut pool, _) = grilling("#186");
    let text = r#"{"spec": "docs/specs/demo.md", "pushBase": true, "finish": "pr",
        "items": [{"title": "Parse it", "body": "the parser"}, {"title": "Print it", "body": ""}],
        "nodes": {"implement": {"assign": {"model": "sonnet"}, "note": "keep it small"}}}"#;
    // A brief seen before its merge landed does not count; seen merged, it is absorbed once.
    pool.conversations.insert(
        "grill-1".into(),
        ConversationFact::Ended {
            brief: brief(text),
            merged: false,
        },
    );
    assert!(written(&tick(&mut run, &mut pool)).is_empty());
    assert_eq!(run.plan().1, 0);
    pool.conversations.insert(
        "grill-1".into(),
        ConversationFact::Ended {
            brief: brief(text),
            merged: true,
        },
    );
    let advanced = tick(&mut run, &mut pool);
    assert_eq!(advanced.log, ["line: grill-1 hands on its brief"]);
    assert_eq!(written(&advanced), ["implement-1"]);
    assert_eq!(run.places.spec.as_deref(), Some("docs/specs/demo.md"));
    assert!(run.places.push_base);
    assert_eq!(run.plan().1, 1, "the finish and the node override are one edit");
    assert_eq!(run.finish_act(), &FinishAct::Pr);
    let implement = ticket(&advanced, "implement-1");
    assert_eq!(implement.assign.model.as_deref(), Some("sonnet"));
    assert!(implement.blocked_by.is_empty());
    for part in [
        "`docs/specs/demo.md`",
        "keep it small",
        "Parse it",
        "the parser",
        "Print it",
    ] {
        assert!(implement.body.contains(part), "{part}: {}", implement.body);
    }
    let again = tick(&mut run, &mut pool);
    assert!(again.log.is_empty() && written(&again).is_empty());
    assert_eq!(run.plan().1, 1, "absorbed once");
}

#[test]
fn a_closed_conversation_pass_hands_closed_to_the_finish() {
    let (mut run, mut pool, _) = grilling("#186");
    pool.conversations.insert(
        "grill-1".into(),
        ConversationFact::Closed {
            why: "ended as closed".into(),
        },
    );
    let advanced = tick(&mut run, &mut pool);
    assert_eq!(
        advanced.log,
        [
            "line: grill-1 hands on closed",
            "line: the Finish holds at finish-1"
        ]
    );
    let finish = hold(&advanced, "finish-1");
    assert!(finish.body.contains("ended as closed"), "{}", finish.body);
    assert_eq!(run.live_conversation(&node("grill")), None);
}

#[test]
fn a_handoff_to_a_live_conversation_pass_queues_the_next_pass() {
    let talks = plan(
        json!([
            {"kind": "agent", "id": "left"},
            {"kind": "agent", "id": "right"},
            {"kind": "conversation", "id": "talk"},
            {"kind": "finish", "id": "finish"}
        ]),
        json!([
            {"from": "left", "on": "done", "to": "talk"},
            {"from": "right", "on": "done", "to": "talk"},
            {"from": "talk", "on": "done", "to": "finish"}
        ]),
    );
    assert!(LineRun::unsupported(&talks).is_empty());
    let (mut run, mut pool) = work_run(talks);
    assert_eq!(written(&tick(&mut run, &mut pool)), ["left-1", "right-1"]);
    pool.agent("left-1");
    pool.agent("right-1");
    let first = tick(&mut run, &mut pool);
    assert_eq!(first.effects.conversations.len(), 1);
    assert_eq!(first.effects.conversations[0].id, id("talk-1"));
    assert_eq!(
        run.blockers(&pool),
        [
            Blocker::Conversation(id("talk-1")),
            Blocker::Inbox {
                node: node("talk"),
                handoffs: 1
            }
        ]
    );

    let text = run.to_json();
    assert_eq!(LineRun::from_json(&text).unwrap(), run, "line.json keeps a live pass");

    pool.conversations.insert(
        "talk-1".into(),
        ConversationFact::Ended {
            brief: LineBrief::default(),
            merged: true,
        },
    );
    let second = tick(&mut run, &mut pool);
    assert_eq!(second.effects.conversations.len(), 1);
    assert_eq!(second.effects.conversations[0].id, id("talk-2"));
    assert_eq!(run.live_conversation(&node("talk")), Some(&id("talk-2")));
    assert!(!run.steward_may_answer(&id("talk-2")));
    assert_eq!(run.node_of(&id("talk-2")), Some(&node("talk")));
}

#[test]
fn a_brief_is_bounded_and_refuses_what_it_does_not_know() {
    let item = |title: &str, body: &str| json!({"title": title, "body": body});
    let parse = |value: Value| LineBrief::parse(&value.to_string());
    let items = |n: usize| json!({"items": vec![item("t", "b"); n]});
    assert_eq!(parse(items(64)).unwrap().items.len(), 64);
    assert_eq!(parse(items(65)).unwrap_err(), "items holds 65: at most 64");
    let titled = |title: String| parse(json!({"items": [item(&title, "")]}));
    assert!(titled("x".repeat(200)).is_ok());
    for title in [String::new(), "  ".into(), "x".repeat(201)] {
        assert_eq!(
            titled(title).unwrap_err(),
            "item 1 needs a title of 1 to 200 characters"
        );
    }
    let bodied = |len: usize| parse(json!({"items": [item("t", &"b".repeat(len))]}));
    assert!(bodied(16 * 1024).is_ok());
    assert_eq!(
        bodied(16 * 1024 + 1).unwrap_err(),
        "item 1's body is over 16384 bytes"
    );
    assert_eq!(
        parse(json!({"spec": " "})).unwrap_err(),
        "spec is blank: leave it out, or name the spec"
    );
    assert_eq!(
        parse(json!({"finish": ""})).unwrap_err(),
        "finish is blank: leave it out, or name the act"
    );
    assert!(
        parse(json!({"factory": {}}))
            .unwrap_err()
            .contains("unknown field `factory`")
    );
    assert!(parse(json!({"items": [{"title": "t", "body": "b", "x": 1}]})).is_err());
    assert_eq!(LineBrief::parse("[]").unwrap_err(), "not a JSON object");
    assert!(LineBrief::parse("{").unwrap_err().starts_with("not valid JSON"));
}

#[test]
fn verdicts_are_read_by_kind() {
    let prove = |v: Value| verdict_of(TicketKind::Prove, Some(&v));
    assert_eq!(
        prove(json!({"prove": "fail", "evidence": "e"})),
        Ok(Verdict::Fail)
    );
    assert!(prove(json!({"prove": "pass", "evidence": " "})).is_err());
    assert!(verdict_of(TicketKind::Prove, None).is_err());
    let review = |v: Value| verdict_of(TicketKind::Review, Some(&v));
    assert_eq!(review(json!({"findings": []})), Ok(Verdict::Clean));
    assert_eq!(
        review(json!({"findings": [{"severity": "nit", "title": "t", "detail": "d"}]})),
        Ok(Verdict::Findings)
    );
    let decide = |v: Value| verdict_of(TicketKind::Decide, Some(&v));
    assert!(decide(json!({"decide": "round", "fixes": []})).is_err());
    assert!(decide(json!({"decide": "another-round"})).is_err());
    assert_eq!(decide(json!({"decide": "ship"})), Ok(Verdict::Ship));
    assert_eq!(verdict_of(TicketKind::Agent, None), Ok(Verdict::Done));

    let pr = OutcomeCheck::FinishAct(FinishAct::Pr);
    assert!(pr.problem(None, &|_| true).is_some());
    assert_eq!(
        pr.problem(Some(&json!({"url": "https://x"})), &|_| true),
        None
    );
    assert_eq!(
        OutcomeCheck::FinishAct(FinishAct::FastForward).problem(None, &|_| true),
        None
    );
    assert!(
        pr.no_verdict_brief("the verdict has no url")
            .starts_with("no verdict\n\n")
    );
}

#[test]
fn line_start_names_what_this_build_cannot_run() {
    assert!(LineRun::unsupported(&factory_today()).is_empty());
    let addy = PRESETS.iter().find(|p| p.slug == "addy-commands").unwrap();
    let problems = LineRun::unsupported(&Plan::parse(addy.json).unwrap());
    assert!(
        problems.iter().any(|p| p.contains("one copy per item")),
        "{problems:?}"
    );
    assert!(
        problems.iter().any(|p| p.contains("is a Merger")),
        "{problems:?}"
    );
}

#[test]
fn a_copy_on_the_stewards_checkpoint_is_the_stewards() {
    let (run, _) = started("none");
    assert!(run.steward_may_answer(&id("implement-1")));
    assert_eq!(run.node_of(&id("implement-1")), Some(&node("implement")));
    assert_eq!(
        run.node_of(&id("implement-2")),
        None,
        "not a pass the Line has started"
    );
    assert_eq!(run.node_of(&id("conv-1")), None);
}

#[test]
fn plan_edits_on_a_running_line_are_refused_for_now() {
    let (mut run, _) = started("none");
    let edit = |by, base_rev| LineEvent::PlanEdited {
        by,
        base_rev,
        edits: Vec::new(),
    };
    assert_eq!(
        run.apply(edit(Editor::Steward, 0)),
        Err(Refusal::StewardMayNotEdit)
    );
    assert_eq!(
        run.apply(edit(Editor::Operator, 7)),
        Err(Refusal::StaleRev { now: 0 })
    );
    assert!(matches!(
        run.apply(edit(Editor::Operator, 0)),
        Err(Refusal::Live(_))
    ));
}
