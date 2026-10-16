use super::*;
use ac_protocol::OutcomeStatus;
use serde_json::json;

fn brief() -> LineBrief {
    parse_brief(r#"{"spec": "docs/specs/x.md", "finish": "none"}"#).unwrap()
}

fn outcome(verdict: Option<Value>) -> Outcome {
    Outcome {
        status: OutcomeStatus::Done,
        summary: "did it".into(),
        commit_sha: None,
        brief: None,
        spawn: None,
        verdict,
    }
}

fn failed(brief: &str) -> Outcome {
    Outcome {
        brief: Some(brief.into()),
        ..outcome(Some(json!({"prove": "fail", "evidence": "proof/fail.txt"})))
    }
}

fn passed() -> Outcome {
    outcome(Some(json!({"prove": "pass", "evidence": "proof/ok.txt"})))
}

fn findings(list: Value) -> Outcome {
    outcome(Some(json!({ "findings": list })))
}

fn decide(verdict: Value) -> Outcome {
    outcome(Some(verdict))
}

fn next(routed: Result<Routed, String>) -> NewTicket {
    match routed.expect("routes") {
        Routed::Next(ticket) => *ticket,
        other => panic!("expected a next ticket, got {other:?}"),
    }
}

fn started() -> (LineState, ResolvedFactory) {
    let factory = resolve_factory(&FactoryLayers::default(), &brief());
    let (line, first) = start_line(
        brief(),
        "docs/specs/x.brief.json",
        &factory,
        LinePlaces::default(),
    );
    assert_eq!(first.id, "r1-implement");
    (line, factory)
}

// Drive the Line one ending at a time, returning the id of each Ticket it writes.
fn walk(line: &mut LineState, factory: &ResolvedFactory, ends: &[StationEnd<'_>]) -> Vec<String> {
    ends.iter()
        .map(
            |end| match route(line, factory, end.clone()).expect("routes") {
                Routed::Next(ticket) => ticket.id,
                Routed::Done => "DONE".into(),
                Routed::Closed => "CLOSED".into(),
            },
        )
        .collect()
}

#[test]
fn the_built_in_settings_are_the_specs() {
    let factory = default_factory();
    assert_eq!(
        (
            factory.implement.drivers.as_str(),
            factory.implement.effort.as_str()
        ),
        ("implement", "high")
    );
    assert_eq!(factory.prove.drivers, "my-verify");
    assert_eq!(factory.prove.effort, "medium");
    assert_eq!(factory.review.drivers, "code-review");
    assert_eq!(factory.decide.drivers, "html");
    assert_eq!(factory.decide.effort, "medium");
    assert_eq!(factory.grill.drivers, "my-grill-with-docs show-me");
    assert_eq!(factory.grill.effort, "high");
    assert!(
        [
            &factory.implement,
            &factory.prove,
            &factory.review,
            &factory.decide,
            &factory.grill
        ]
        .iter()
        .all(|s| s.harness == "claude" && s.model == "opus" && s.enabled)
    );
    assert_eq!(
        (factory.prove_fails_per_round, factory.extra_rounds),
        (2, 1)
    );
    assert_eq!(factory.finish, "none");
}

#[test]
fn a_brief_overrides_field_by_field() {
    let brief = parse_brief(
        r#"{"spec": "s.md", "finish": "draft-pr", "factory": {
            "stations": {"prove": {"assign": {"model": "sonnet"}, "note": "use the CLI"}},
            "limits": {"extraRounds": 0}}}"#,
    )
    .unwrap();
    let factory = resolve_factory(&FactoryLayers::default(), &brief);
    assert_eq!(factory.prove.model, "sonnet");
    assert_eq!(factory.prove.effort, "medium");
    assert_eq!(factory.prove.drivers, "my-verify");
    assert_eq!(factory.prove.note, "use the CLI");
    assert_eq!(
        (factory.prove_fails_per_round, factory.extra_rounds),
        (2, 0)
    );
    assert_eq!(factory.finish, "draft-pr");
}

#[test]
fn an_invalid_brief_says_why() {
    let reason = |text: &str| parse_brief(text).unwrap_err();
    assert!(reason("{").starts_with("not valid JSON"));
    assert_eq!(reason("[]"), "not a JSON object");
    assert!(reason("{}").contains("missing field `spec`"));
    assert_eq!(
        reason(r#"{"spec": " "}"#),
        "spec is blank: it must name the Line's spec"
    );
    assert!(
        reason(r#"{"spec": "s", "factory": {"limits": {"proveFailPerRound": 3}}}"#)
            .contains("unknown field `proveFailPerRound`")
    );
    assert_eq!(
        reason(r#"{"spec": "s", "factory": {"stations": {"implement": {"enabled": false}}}}"#),
        "factory.stations.implement.enabled is false: only Prove and Review can be switched off"
    );
}

#[test]
fn prove_needs_pass_or_fail_and_evidence() {
    let check = VerdictCheck::of(Station::Prove);
    assert_eq!(
        verdict_problem(&check, Some(&json!({"prove": "pass", "evidence": "e"}))),
        None
    );
    assert_eq!(
        verdict_problem(&check, None).as_deref(),
        Some("the Outcome has no verdict")
    );
    assert!(
        verdict_problem(&check, Some(&json!({"prove": "passed", "evidence": "e"})))
            .unwrap()
            .contains("unknown variant `passed`")
    );
    assert!(
        verdict_problem(&check, Some(&json!({"prove": "fail", "evidence": " "})))
            .unwrap()
            .contains("evidence is blank")
    );
}

#[test]
fn review_findings_parse_with_their_severity() {
    let verdict = review_verdict(Some(&json!({"findings": [
        {"severity": "must", "title": "t", "detail": "d"},
        {"severity": "nit", "title": "n", "detail": ""}
    ]})))
    .unwrap();
    assert_eq!(verdict.findings[0].severity, FindingSeverity::Must);
    assert!(review_verdict(Some(&json!({"findings": []}))).is_ok());
    assert!(
        review_verdict(Some(
            &json!({"findings": [{"severity": "blocker", "title": "t", "detail": ""}]})
        ))
        .unwrap_err()
        .contains("unknown variant `blocker`")
    );
    assert_eq!(
        review_verdict(Some(
            &json!({"findings": [{"severity": "must", "title": "", "detail": ""}]})
        ))
        .unwrap_err(),
        "finding 1 has a blank title"
    );
}

#[test]
fn decide_accounts_for_every_must() {
    let musts = vec!["A".to_string(), "B".to_string()];
    let fixed = json!({"decide": "round", "fixes": [{"title": "A", "reason": "r"}],
                       "dropped": [{"title": "B", "reason": "r"}]});
    assert!(decide_verdict(Some(&fixed), &musts).is_ok());
    let short = json!({"decide": "round", "fixes": [{"title": "A", "reason": "r"}]});
    assert_eq!(
        decide_verdict(Some(&short), &musts).unwrap_err(),
        "every must finding has to be fixed or dropped with a reason; not accounted for: \"B\""
    );
    // A finish fixes nothing: a must only in the fixes is not accounted for.
    let finish = json!({"decide": "finish", "fixes": [{"title": "A", "reason": "r"}],
                        "dropped": [{"title": "B", "reason": "r"}]});
    assert!(
        decide_verdict(Some(&finish), &musts)
            .unwrap_err()
            .contains("not accounted for: \"A\"")
    );
    assert_eq!(
        decide_verdict(Some(&json!({"decide": "round"})), &[]).unwrap_err(),
        "a round names at least one fix"
    );
    assert_eq!(
        decide_verdict(
            Some(&json!({"decide": "finish", "dropped": [{"title": "A", "reason": ""}]})),
            &[]
        )
        .unwrap_err(),
        "dropped item 1 needs a title and a reason"
    );
    assert!(decide_verdict(Some(&json!({"decide": "finish"})), &[]).is_ok());
}

#[test]
fn a_done_outcome_without_a_verdict_becomes_the_no_verdict_checkpoint() {
    let check = VerdictCheck::of(Station::Review);
    let valid = |o: Outcome| ValidOutcome {
        outcome: o,
        spawn_rejections: vec![],
    };
    let checked = check_station_outcome(&check, valid(outcome(None)));
    assert_eq!(checked.outcome.status, OutcomeStatus::Checkpoint);
    let brief = checked.outcome.brief.unwrap();
    assert!(brief.starts_with("no verdict\n\nthe Outcome has no verdict."));
    assert!(brief.contains("\"findings\""));
    let fine = check_station_outcome(&check, valid(findings(json!([]))));
    assert_eq!(fine.outcome.status, OutcomeStatus::Done);
    // Implement needs no verdict.
    let implement = VerdictCheck::of(Station::Implement);
    assert_eq!(
        check_station_outcome(&implement, valid(outcome(None)))
            .outcome
            .status,
        OutcomeStatus::Done
    );
    // The agent's own checkpoint stands.
    let mut own = outcome(None);
    own.status = OutcomeStatus::Checkpoint;
    own.brief = Some("need a key".into());
    let stood = check_station_outcome(&check, valid(own));
    assert_eq!(stood.outcome.brief.as_deref(), Some("need a key"));
}

#[test]
fn the_pass_path_runs_one_round_to_the_finish() {
    let (mut line, factory) = started();
    let review = findings(json!([{"severity": "nit", "title": "n", "detail": "d"}]));
    let finish = decide(json!({"decide": "finish"}));
    let passed = passed();
    let ids = walk(
        &mut line,
        &factory,
        &[
            StationEnd::Done(&outcome(None)),
            StationEnd::Done(&passed),
            StationEnd::Done(&review),
            StationEnd::Done(&finish),
            StationEnd::Approved,
        ],
    );
    assert_eq!(
        ids,
        ["r1-prove", "r1-review", "r1-decide", "r1-finish", "DONE"]
    );
    assert_eq!(line.status, LineStatus::Done);
    assert_eq!(line.rounds.len(), 1);
    assert_eq!(line.rounds[0].proves[0].evidence, "proof/ok.txt");
    assert_eq!(line.rounds[0].findings.len(), 1);
}

#[test]
fn a_prove_fail_goes_to_a_fix_and_back_to_prove() {
    let (mut line, factory) = started();
    let fail = failed("the CLI exits 2 on an empty pool");
    let pass = passed();
    let implement = outcome(None);
    let ids = walk(
        &mut line,
        &factory,
        &[
            StationEnd::Done(&implement),
            StationEnd::Done(&fail),
            StationEnd::Done(&implement),
            StationEnd::Done(&pass),
        ],
    );
    assert_eq!(ids, ["r1-prove", "r1-fix-1", "r1-prove-2", "r1-review"]);
    assert_eq!(line.prove_fails, 1);
}

#[test]
fn a_fix_body_carries_proves_brief_and_evidence() {
    let (mut line, factory) = started();
    route(&mut line, &factory, StationEnd::Done(&outcome(None))).unwrap();
    let fix = next(route(
        &mut line,
        &factory,
        StationEnd::Done(&failed("exits 2 on empty")),
    ));
    assert_eq!(fix.station, Station::Implement);
    assert_eq!(fix.blocked_by.as_deref(), Some("r1-prove"));
    assert!(
        fix.body
            .contains("## What Prove found\n\nexits 2 on empty\n\nEvidence: `proof/fail.txt`")
    );
    assert!(fix.body.contains("`docs/specs/x.md`"));
    assert_eq!(fix.checkpoint, None);
}

#[test]
fn the_third_fail_checkpoints_the_next_fix_and_a_resume_buys_one_more() {
    let (mut line, factory) = started();
    let implement = outcome(None);
    let fail = failed("still broken");
    let ids = walk(
        &mut line,
        &factory,
        &[
            StationEnd::Done(&implement),
            StationEnd::Done(&fail),
            StationEnd::Done(&implement),
            StationEnd::Done(&fail),
            StationEnd::Done(&implement),
        ],
    );
    assert_eq!(
        ids,
        [
            "r1-prove",
            "r1-fix-1",
            "r1-prove-2",
            "r1-fix-2",
            "r1-prove-3"
        ]
    );
    let gated = next(route(&mut line, &factory, StationEnd::Done(&fail)));
    assert_eq!(gated.id, "r1-fix-3");
    assert!(
        gated
            .checkpoint
            .as_deref()
            .unwrap()
            .starts_with("Prove has failed 3 times in Round 1 (limits.proveFailsPerRound is 2)")
    );
    assert!(line.gated);
    // The resumed fix ran: one fix bought, so the next fail is gated again, not the one after.
    let ids = walk(&mut line, &factory, &[StationEnd::Done(&implement)]);
    assert_eq!(ids, ["r1-prove-4"]);
    assert_eq!(line.fixes_bought, 1);
    let gated = next(route(&mut line, &factory, StationEnd::Done(&fail)));
    assert_eq!(gated.id, "r1-fix-4");
    assert!(gated.checkpoint.is_some());
}

#[test]
fn decide_round_starts_the_next_round_with_its_fixes_up_to_the_limit() {
    let (mut line, factory) = started();
    let implement = outcome(None);
    let pass = passed();
    let review =
        findings(json!([{"severity": "must", "title": "Leak", "detail": "the pane leaks"}]));
    let again = decide(json!({"decide": "round", "fixes": [{"title": "Leak", "reason": "must"}]}));
    let ids = walk(
        &mut line,
        &factory,
        &[
            StationEnd::Done(&implement),
            StationEnd::Done(&pass),
            StationEnd::Done(&review),
        ],
    );
    assert_eq!(ids, ["r1-prove", "r1-review", "r1-decide"]);
    assert_eq!(
        verdict_check(&line, &factory, Station::Decide).musts,
        ["Leak"]
    );
    let r2 = next(route(&mut line, &factory, StationEnd::Done(&again)));
    assert_eq!(r2.id, "r2-implement");
    assert!(
        r2.body
            .contains("- **Leak**: must\n  the pane leaks (must)")
    );
    assert_eq!((line.round, line.extra_rounds, line.prove_fails), (2, 1, 0));
    // Round 2 asks for a third Round: the one extra Round is spent, so the Line goes to its Finish.
    let ids = walk(
        &mut line,
        &factory,
        &[
            StationEnd::Done(&implement),
            StationEnd::Done(&pass),
            StationEnd::Done(&review),
        ],
    );
    assert_eq!(ids, ["r2-prove", "r2-review", "r2-decide"]);
    let finish = next(route(&mut line, &factory, StationEnd::Done(&again)));
    assert_eq!(finish.id, "r2-finish");
    assert!(finish.checkpoint.unwrap().contains(
        "Decide chose another Round, but the Line has started its 1 extra Round already"
    ));
    assert_eq!(line.status, LineStatus::Finish);
}

#[test]
fn notes_on_the_finish_start_another_round_past_the_limit() {
    let (mut line, factory) = started();
    line.extra_rounds = 1;
    let implement = outcome(None);
    let pass = passed();
    let none = findings(json!([]));
    let finish = decide(json!({"decide": "finish"}));
    walk(
        &mut line,
        &factory,
        &[
            StationEnd::Done(&implement),
            StationEnd::Done(&pass),
            StationEnd::Done(&none),
            StationEnd::Done(&finish),
        ],
    );
    let r2 = next(route(
        &mut line,
        &factory,
        StationEnd::Notes("rename the flag".into()),
    ));
    assert_eq!(r2.id, "r2-implement");
    assert!(
        r2.body
            .contains("## The operator's notes\n\nrename the flag")
    );
    assert_eq!(line.status, LineStatus::Running);
}

#[test]
fn closing_a_station_halts_the_line_through_decide_to_the_finish() {
    let (mut line, factory) = started();
    let implement = outcome(None);
    walk(&mut line, &factory, &[StationEnd::Done(&implement)]);
    let decide_ticket = next(route(&mut line, &factory, StationEnd::Closed));
    assert_eq!(decide_ticket.id, "r1-decide");
    assert_eq!(decide_ticket.blocked_by, None);
    assert!(
        decide_ticket
            .body
            .contains("The Line was halted (r1-prove was closed)")
    );
    assert_eq!(line.halted.as_deref(), Some("r1-prove was closed"));
    // Even a round verdict ends a halted Line at its Finish.
    let round = decide(json!({"decide": "round", "fixes": [{"title": "x", "reason": "y"}]}));
    let finish = next(route(&mut line, &factory, StationEnd::Done(&round)));
    assert_eq!(finish.id, "r1-finish");
    assert!(
        finish
            .checkpoint
            .unwrap()
            .contains("The Line was halted: r1-prove was closed.")
    );
    assert_eq!(walk(&mut line, &factory, &[StationEnd::Closed]), ["CLOSED"]);
    assert_eq!(line.status, LineStatus::Closed);
}

#[test]
fn closing_decide_goes_straight_to_the_finish() {
    let (mut line, factory) = started();
    let implement = outcome(None);
    let pass = passed();
    let none = findings(json!([]));
    let ids = walk(
        &mut line,
        &factory,
        &[
            StationEnd::Done(&implement),
            StationEnd::Done(&pass),
            StationEnd::Done(&none),
            StationEnd::Closed,
        ],
    );
    assert_eq!(ids, ["r1-prove", "r1-review", "r1-decide", "r1-finish"]);
    assert_eq!(line.halted.as_deref(), Some("r1-decide was closed"));
}

// A Line whose pool layer switches off the Stations named, walked from Implement's done.
fn walk_switched_off(off: &[&str], ends: &[StationEnd<'_>]) -> Vec<String> {
    let stations: serde_json::Map<String, Value> = off
        .iter()
        .map(|key| ((*key).to_owned(), json!({"enabled": false})))
        .collect();
    let layers = FactoryLayers {
        machine: None,
        pool: layer(json!({ "stations": stations })),
    };
    let factory = resolve_factory(&layers, &brief());
    let (mut line, _) = start_line(brief(), "b.json", &factory, LinePlaces::default());
    walk(&mut line, &factory, ends)
}

#[test]
fn switched_off_stations_are_skipped() {
    let done = outcome(None);
    let pass = passed();
    let none = findings(json!([]));
    // Prove off: Implement routes to Review.
    assert_eq!(
        walk_switched_off(
            &["prove"],
            &[StationEnd::Done(&done), StationEnd::Done(&none)]
        ),
        ["r1-review", "r1-decide"]
    );
    // Review off: Prove's pass routes to Decide.
    assert_eq!(
        walk_switched_off(
            &["review"],
            &[StationEnd::Done(&done), StationEnd::Done(&pass)]
        ),
        ["r1-prove", "r1-decide"]
    );
    // Both off: Implement routes to Decide, which has no findings to account for.
    let brief = parse_brief(
        r#"{"spec": "s.md", "factory": {"stations": {"prove": {"enabled": false}, "review": {"enabled": false}}}}"#,
    )
    .unwrap();
    let factory = resolve_factory(&FactoryLayers::default(), &brief);
    let (mut line, _) = start_line(brief, "b.json", &factory, LinePlaces::default());
    let decide_ticket = next(route(&mut line, &factory, StationEnd::Done(&outcome(None))));
    assert_eq!(decide_ticket.id, "r1-decide");
    assert!(
        decide_ticket
            .body
            .contains("## Review findings\n\n_(none)_")
    );
    assert!(musts_of(&line).is_empty());
}

fn layer(value: Value) -> Option<FactorySettings> {
    normalise_factory(&value, "test").expect("a valid layer")
}

#[test]
fn each_layer_overrides_its_own_fields_and_the_rest_fall_through() {
    let layers = FactoryLayers {
        machine: layer(json!({
            "stations": {"implement": {"assign": {"model": "machine-model"}, "note": "machine note"}},
            "limits": {"proveFailsPerRound": 5},
            "finish": "draft-pr"
        })),
        pool: layer(json!({
            "stations": {"implement": {"assign": {"effort": "low"}}, "review": {"enabled": false}},
            "limits": {"extraRounds": 3}
        })),
    };
    let brief = parse_brief(
        r#"{"spec": "s.md", "factory": {"stations": {"implement": {"drivers": "tdd implement"}}}}"#,
    )
    .unwrap();
    let factory = resolve_factory(&layers, &brief);
    // The machine's model, the pool's effort, the brief's drivers, the built-in harness.
    assert_eq!(factory.implement.model, "machine-model");
    assert_eq!(factory.implement.effort, "low");
    assert_eq!(factory.implement.drivers, "tdd implement");
    assert_eq!(factory.implement.harness, "claude");
    assert_eq!(factory.implement.note, "machine note");
    assert!(!factory.review.enabled);
    assert!(factory.prove.enabled);
    assert_eq!(factory.prove, default_factory().prove);
    assert_eq!(
        (factory.prove_fails_per_round, factory.extra_rounds),
        (5, 3)
    );
    assert_eq!(factory.finish, "draft-pr");

    // A later layer wins the field it sets, and only that field.
    let pool_wins = FactoryLayers {
        pool: layer(
            json!({"stations": {"implement": {"assign": {"model": "pool-model"}}}, "finish": "pr"}),
        ),
        ..layers.clone()
    };
    let factory = resolve_factory(&pool_wins, &brief);
    assert_eq!(factory.implement.model, "pool-model");
    assert_eq!(factory.implement.note, "machine note");
    assert_eq!(factory.finish, "pr");
    assert!(factory.review.enabled);
    let brief_wins = parse_brief(
        r#"{"spec": "s.md", "finish": "none", "factory": {"stations": {"implement": {"assign": {"model": "brief-model"}}}}}"#,
    )
    .unwrap();
    let factory = resolve_factory(&pool_wins, &brief_wins);
    assert_eq!(factory.implement.model, "brief-model");
    assert_eq!(factory.implement.effort, "high");
    assert_eq!(factory.finish, "none");
}

#[test]
fn a_layer_cannot_switch_off_implement_or_decide() {
    // Refused where a layer is written…
    assert_eq!(
        normalise_factory(
            &json!({"stations": {"decide": {"enabled": false}}}),
            "pool settings: factory"
        )
        .unwrap_err(),
        "pool settings: factory: factory.stations.decide.enabled is false: only Prove and Review can be switched off"
    );
    // …and never obeyed when one reaches the resolution anyway.
    let mut factory = default_factory();
    overlay_factory(
        &mut factory,
        &serde_json::from_value(json!({"stations": {"implement": {"enabled": false}}})).unwrap(),
    );
    assert!(factory.implement.enabled);
}

#[test]
fn a_layer_is_tidied_to_what_it_sets() {
    assert_eq!(
        normalise_factory(
            &json!({
                "stations": {
                    "implement": {"drivers": " implement ", "assign": {"harness": "", "model": " m "}, "note": " "},
                    "prove": {"assign": {"effort": ""}}
                },
                "limits": {"proveFailsPerRound": "3", "extraRounds": ""},
                "finish": "  "
            }),
            "f"
        )
        .unwrap(),
        layer(json!({
            "stations": {"implement": {"drivers": "implement", "assign": {"model": "m"}}},
            "limits": {"proveFailsPerRound": 3}
        }))
    );
    assert_eq!(
        normalise_factory(&json!({"stations": {"review": {}}, "limits": {}}), "f").unwrap(),
        None
    );
    assert!(
        normalise_factory(&json!({"stations": {"build": {}}}), "pool config: factory")
            .unwrap_err()
            .starts_with("pool config: factory: unknown field `build`")
    );
    assert_eq!(
        normalise_factory(&json!("on"), "pool config: factory").unwrap_err(),
        "pool config: factory must be an object"
    );
    assert!(normalise_factory(&json!({"limits": {"extraRounds": -1}}), "f").is_err());
    assert_eq!(factory_layer_of(Some(&json!({"finish": 3}))), None);
}

#[test]
fn the_resolved_finish_reaches_decide_and_the_finish_checkpoint() {
    let layers = FactoryLayers {
        machine: None,
        pool: layer(
            json!({"finish": "draft-pr", "stations": {"decide": {"note": "keep the report short"}}}),
        ),
    };
    let brief = parse_brief(r#"{"spec": "docs/specs/x.md"}"#).unwrap();
    let factory = resolve_factory(&layers, &brief);
    let (mut line, _) = start_line(brief, "b.json", &factory, LinePlaces::default());
    let done = outcome(None);
    let pass = passed();
    let none = findings(json!([]));
    let mut ids = walk(
        &mut line,
        &factory,
        &[StationEnd::Done(&done), StationEnd::Done(&pass)],
    );
    let decide_ticket = next(route(&mut line, &factory, StationEnd::Done(&none)));
    ids.push(decide_ticket.id.clone());
    assert_eq!(ids, ["r1-prove", "r1-review", "r1-decide"]);
    assert!(
        decide_ticket
            .body
            .contains("1. Carry out the Finish. `draft-pr`:")
    );
    assert!(
        decide_ticket
            .body
            .contains("## Note for this Station\n\nkeep the report short")
    );
    let finish = decide(json!({"decide": "finish"}));
    let finish_ticket = next(route(&mut line, &factory, StationEnd::Done(&finish)));
    assert!(finish_ticket.body.contains("Finish: `draft-pr`."));
}

#[test]
fn approval_is_no_note_or_approved() {
    assert!(approves(None));
    assert!(approves(Some("  ")));
    assert!(approves(Some("Approved.")));
    assert!(!approves(Some("approved, but rename the flag")));
}

#[test]
fn a_station_ticket_carries_its_station_and_assignment_on_the_state_line() {
    let (_, factory) = started();
    let (_, first) = start_line(
        brief(),
        "docs/specs/x.brief.json",
        &factory,
        LinePlaces::default(),
    );
    let text = station_ticket_text(&first);
    let line_one = text.lines().next().unwrap();
    assert_eq!(
        line_one,
        format!(
            "<!-- state: id=r1-implement blocked-by=none status=ready station=implement spawn-assign={} -->",
            encode_spawn_assign(&factory.implement.assign())
        )
    );
    assert!(text.contains("# r1-implement: Implement, Round 1\n"));
}

#[test]
fn a_brief_or_spec_path_must_stay_in_the_checkout() {
    let dir = std::env::temp_dir().join(format!("ac-line-brief-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("docs/specs")).unwrap();
    std::fs::write(dir.join("docs/specs/x.md"), "spec").unwrap();
    std::fs::write(dir.join("b.json"), r#"{"spec": "../x.md"}"#).unwrap();
    assert_eq!(
        read_brief(&dir, "/etc/passwd").unwrap_err(),
        "the Line brief's path /etc/passwd must be relative to the pool checkout and stay inside it"
    );
    assert!(read_brief(&dir, "docs/../../b.json").is_err());
    assert_eq!(
        read_brief(&dir, "b.json").unwrap_err(),
        "Line brief b.json: its spec ../x.md must be relative to the pool checkout and stay inside it"
    );
    std::fs::write(dir.join("b.json"), r#"{"spec": "docs/specs/x.md"}"#).unwrap();
    assert!(read_brief(&dir, "./b.json").is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}

// A place a test fills: file names under docs/specs and the texts at their paths.
struct Branch(Vec<(&'static str, &'static str)>);

impl BriefPlace for Branch {
    fn name(&self) -> String {
        "the Grill's committed branch pool/p/conv-1".to_owned()
    }
    fn names_in(&self, dir: &str) -> Vec<String> {
        self.0
            .iter()
            .filter_map(|(path, _)| path.strip_prefix(&format!("{dir}/")))
            .map(str::to_owned)
            .collect()
    }
    fn read(&self, path: &str) -> Option<Result<String, String>> {
        self.0
            .iter()
            .find(|(p, _)| *p == path)
            .map(|(_, text)| Ok((*text).to_owned()))
    }
}

#[test]
fn a_brief_is_found_and_read_in_any_place_its_reasons_naming_the_place() {
    let empty = Branch(vec![]);
    assert_eq!(
        find_brief_in(&empty, None).unwrap_err(),
        "no Line brief: docs/specs/ in the Grill's committed branch pool/p/conv-1 holds no *.brief.json"
    );
    let no_spec = Branch(vec![(
        "docs/specs/x.brief.json",
        r#"{"spec": "docs/specs/x.md"}"#,
    )]);
    let path = find_brief_in(&no_spec, None).unwrap();
    assert_eq!(path, "docs/specs/x.brief.json");
    assert_eq!(
        read_brief_in(&no_spec, &path).unwrap_err(),
        "Line brief docs/specs/x.brief.json: its spec docs/specs/x.md is not in the Grill's committed branch pool/p/conv-1"
    );
    let ready = Branch(vec![
        (
            "docs/specs/x.brief.json",
            r#"{"spec": "docs/specs/x.md", "finish": "draft-pr"}"#,
        ),
        ("docs/specs/x.md", "# X\n"),
    ]);
    let brief = read_brief_in(&ready, &path).unwrap();
    assert_eq!(brief.finish.as_deref(), Some("draft-pr"));
}

#[test]
fn a_line_is_named_after_its_branch() {
    assert_eq!(line_name_of("line/186"), "186");
    assert_eq!(line_name_of("line/a/b"), "a-b");
    assert_eq!(line_name_of("feature/x"), "feature-x");
    assert_eq!(line_name_of("line/"), "line");
}

#[test]
fn the_grill_is_taught_its_skills_the_two_files_and_the_operators_start() {
    let teaching = grill_teaching("186", "my-grill-with-docs show-me");
    assert!(teaching.contains("Use these skills, in this order: my-grill-with-docs, show-me."));
    assert!(teaching.contains(
        "the spec at `docs/specs/186.md` and the Line brief at `docs/specs/186.brief.json`"
    ));
    assert!(teaching.contains(r#"{"spec": "docs/specs/186.md", "finish": "none", "factory": {}}"#));
    assert!(teaching.contains("The operator then presses Start the Line"));
    assert!(
        teaching.contains("Ask the operator about pushBase only when the finish is pr or draft-pr")
    );
    assert!(!grill_teaching("x", "").contains("Use these skills"));
}

// A Line started with its places: a branch, and a report path under a scratch directory.
fn placed(dir: &Path, finish: &str) -> (LineState, ResolvedFactory) {
    let brief = parse_brief(&format!(
        r#"{{"spec": "docs/specs/186.md", "finish": "{finish}"}}"#
    ))
    .unwrap();
    let factory = resolve_factory(&FactoryLayers::default(), &brief);
    let places = LinePlaces {
        branch: "line/186".into(),
        base: None,
        report: js::path_text(&dir.join(report_file_name("docs/specs/186.brief.json"))),
    };
    let (line, _) = start_line(brief, "docs/specs/186.brief.json", &factory, places);
    (line, factory)
}

#[test]
fn the_report_is_named_after_the_brief() {
    assert_eq!(line_name_of_brief("docs/specs/186.brief.json"), "186");
    assert_eq!(line_name_of_brief("docs/specs/line.json"), "line");
    assert_eq!(line_name_of_brief(""), "line");
    assert_eq!(
        report_file_name("docs/specs/186.brief.json"),
        "186-report.html"
    );
}

#[test]
fn a_decide_that_finishes_must_have_written_the_report() {
    let dir = tempfile::tempdir().unwrap();
    let (mut line, factory) = placed(dir.path(), "none");
    let done = outcome(None);
    let pass = passed();
    let none = findings(json!([]));
    let decide_ticket = {
        walk(
            &mut line,
            &factory,
            &[StationEnd::Done(&done), StationEnd::Done(&pass)],
        );
        next(route(&mut line, &factory, StationEnd::Done(&none)))
    };
    assert!(
        decide_ticket
            .body
            .contains(&format!("Write the report with /html to `{}`", line.report))
    );
    assert!(
        decide_ticket
            .body
            .contains("`none`: nothing beyond the report.")
    );
    let check = verdict_check(&line, &factory, Station::Decide);
    let finish = json!({"decide": "finish"});
    let problem = verdict_problem(&check, Some(&finish)).unwrap();
    assert!(problem.starts_with("the report is not at "), "{problem}");
    // Without the report the routing refuses too: the engine turns it into the no-verdict checkpoint.
    let finish_outcome = decide(finish.clone());
    let mut copy = line.clone();
    assert!(route(&mut copy, &factory, StationEnd::Done(&finish_outcome)).is_err());
    std::fs::write(&line.report, "<html></html>").unwrap();
    assert_eq!(verdict_problem(&check, Some(&finish)), None);
    let finish_ticket = next(route(
        &mut line,
        &factory,
        StationEnd::Done(&finish_outcome),
    ));
    let brief = finish_ticket.checkpoint.unwrap();
    assert!(
        brief.contains(&format!("The report: {} ", line.report)),
        "{brief}"
    );
}

#[test]
fn a_round_needs_no_report_but_a_halted_or_spent_line_does() {
    let dir = tempfile::tempdir().unwrap();
    let (mut line, factory) = placed(dir.path(), "none");
    let round = json!({"decide": "round", "fixes": [{"title": "t", "reason": "r"}]});
    assert_eq!(
        verdict_problem(
            &verdict_check(&line, &factory, Station::Decide),
            Some(&round)
        ),
        None
    );
    // With every extra Round spent a `round` goes to the Finish, so it needs the report too.
    line.extra_rounds = factory.extra_rounds;
    assert!(
        verdict_problem(
            &verdict_check(&line, &factory, Station::Decide),
            Some(&round)
        )
        .is_some()
    );
    line.extra_rounds = 0;
    line.halted = Some("r1-prove was closed".into());
    assert!(
        verdict_problem(
            &verdict_check(&line, &factory, Station::Decide),
            Some(&round)
        )
        .is_some()
    );
}

#[test]
fn the_finish_act_says_what_decide_does_for_each_kind() {
    let dir = tempfile::tempdir().unwrap();
    let (line, _) = placed(dir.path(), "none");
    assert_eq!(
        finish_act("none", &line),
        "`none`: nothing beyond the report."
    );
    let draft = finish_act("draft-pr", &line);
    assert!(
        draft.contains("delete the Line's spec and brief (`docs/specs/186*`)"),
        "{draft}"
    );
    assert!(draft.contains("git push origin HEAD:line/186"));
    assert!(draft.contains("gh pr create --draft --base main --head line/186"));
    // Prove's evidence belongs in the pool: a `.verify/` committed anyway leaves in the final commit.
    assert!(
        draft.contains(
            "and any `.verify/` directory committed on the Line's branch (Prove's evidence belongs \
             in the pool, never in the PR), in one final commit on your branch"
        ),
        "{draft}"
    );
    let pr = finish_act("pr", &line);
    assert!(pr.contains("gh pr create --base main --head line/186") && !pr.contains("draft"));
    assert!(pr.contains("and any `.verify/` directory committed on the Line's branch"));
    let mut shared = line.clone();
    shared.branch = "main".into();
    let refused = finish_act("draft-pr", &shared);
    assert!(
        refused.contains("is not a Line branch (line/...), so push nothing and open no PR"),
        "{refused}"
    );
    assert!(!refused.contains("git push"));
    assert_eq!(
        finish_act("tag a release", &line),
        "carry this out as written, and say in the report what came of it: tag a release"
    );
}

#[test]
fn prove_keeps_its_evidence_in_the_pool_and_out_of_git() {
    let dir = tempfile::tempdir().unwrap();
    let (mut line, factory) = placed(dir.path(), "none");
    let done = outcome(None);
    let fail = failed("it breaks");
    let prove = next(route(&mut line, &factory, StationEnd::Done(&done)));
    assert_eq!(prove.id, "r1-prove");
    let evidence = js::path_text(&dir.path().join("r1-prove.evidence"));
    assert_eq!(evidence_dir(&line, "r1-prove"), Some(evidence.clone()));
    assert!(
        prove.body.contains(&format!(
            "Write the evidence to `{evidence}/`, and name that path in your verdict's \"evidence\"."
        )),
        "{}",
        prove.body
    );
    assert!(prove.body.contains(
        "this one path is yours to write despite the rule against writing into the pool directory"
    ));
    assert!(prove.body.contains("Never commit the evidence."));
    assert!(prove.body.contains("use the evidence path as that folder"));
    assert!(!prove.body.contains("commit it"));
    // A second Prove in the Round gets its own directory.
    walk(&mut line, &factory, &[StationEnd::Done(&fail)]);
    let again = next(route(&mut line, &factory, StationEnd::Done(&done)));
    assert_eq!(again.id, "r1-prove-2");
    assert!(
        again
            .body
            .contains(&js::path_text(&dir.path().join("r1-prove-2.evidence")))
    );
    // With no report path the body still points into the pool's runs directory.
    let (mut bare, factory) = started();
    let prove = next(route(&mut bare, &factory, StationEnd::Done(&done)));
    assert_eq!(evidence_dir(&bare, "r1-prove"), None);
    assert!(
        prove
            .body
            .contains("Write the evidence to `runs/r1-prove.evidence/` in the pool directory")
    );
}

#[test]
fn the_report_links_each_proves_evidence_beside_it() {
    let dir = tempfile::tempdir().unwrap();
    let (mut line, factory) = placed(dir.path(), "none");
    let done = outcome(None);
    let pass = passed();
    let none = findings(json!([]));
    walk(
        &mut line,
        &factory,
        &[StationEnd::Done(&done), StationEnd::Done(&pass)],
    );
    let decide = next(route(&mut line, &factory, StationEnd::Done(&none)));
    assert!(
        decide.body.contains(&format!(
            "Write the report with /html to `{}`: every Round's Prove evidence, linked at its path \
             in the pool's runs directory beside the report (`<prove ticket>.evidence/`, so a \
             relative link works), every Review finding",
            line.report
        )),
        "{}",
        decide.body
    );
}

#[test]
fn decide_hears_what_earlier_rounds_did() {
    let dir = tempfile::tempdir().unwrap();
    let (mut line, factory) = placed(dir.path(), "none");
    let done = outcome(None);
    let pass = passed();
    let must = findings(json!([{"severity": "must", "title": "Leak", "detail": "closes nothing"}]));
    let round = decide(json!({"decide": "round", "fixes": [{"title": "Leak", "reason": "real"}]}));
    walk(
        &mut line,
        &factory,
        &[
            StationEnd::Done(&done),
            StationEnd::Done(&pass),
            StationEnd::Done(&must),
            StationEnd::Done(&round),
            StationEnd::Done(&done),
            StationEnd::Done(&pass),
        ],
    );
    let none = findings(json!([]));
    let decide_ticket = next(route(&mut line, &factory, StationEnd::Done(&none)));
    assert_eq!(decide_ticket.id, "r2-decide");
    assert!(
        decide_ticket
            .body
            .contains("## Earlier Rounds\n\n### Round 1\n- Prove r1-prove: pass")
    );
    assert!(
        decide_ticket
            .body
            .contains("- [must] **Leak**: closes nothing")
    );
    assert!(decide_ticket.body.contains("  - fixed: Leak: real"));
}

#[test]
fn a_switched_on_station_on_an_unknown_harness_cannot_launch() {
    let (_, mut factory) = started();
    let harnesses = Harnesses::defaults();
    assert_eq!(factory.unknown_harness(&harnesses), None);
    factory.prove.harness = "nope".into();
    let problem = factory.unknown_harness(&harnesses).unwrap();
    assert!(
        problem.starts_with("the Prove Station names unknown harness 'nope'. Known: "),
        "{problem}"
    );
    // A Station switched off never launches, so its harness is never asked for.
    factory.prove.enabled = false;
    assert_eq!(factory.unknown_harness(&harnesses), None);
}

const CUT: &str = "0123456789abcdef0123456789abcdef01234567";

// A Line cut from `base_ref` at CUT, its brief granting pushBase or not.
fn based(dir: &Path, finish: &str, base_ref: &str, push_base: bool) -> LineState {
    let (mut line, _) = placed(dir, finish);
    line.base = Some(LineBase {
        base_ref: base_ref.into(),
        commit: CUT.into(),
    });
    line.brief.push_base = push_base;
    line
}

#[test]
fn start_line_carries_the_line_base_it_was_given() {
    let brief = brief();
    let factory = resolve_factory(&FactoryLayers::default(), &brief);
    let base = LineBase {
        base_ref: "experiment/x".into(),
        commit: CUT.into(),
    };
    let places = LinePlaces {
        branch: "line/186".into(),
        base: Some(base.clone()),
        report: String::new(),
    };
    let (line, _) = start_line(brief, "b.json", &factory, places);
    assert_eq!(line.base, Some(base));
    let saved = serde_json::to_value(&line).unwrap();
    assert_eq!(saved["base"], json!({"ref": "experiment/x", "commit": CUT}));
    // A Line from before the Line base reads as one with none, and writes none back.
    let mut old = saved.clone();
    old.as_object_mut().unwrap().remove("base");
    let read: LineState = serde_json::from_value(old).unwrap();
    assert_eq!(read.base, None);
    assert!(serde_json::to_value(&read).unwrap().get("base").is_none());
}

fn review_body(line: &mut LineState) -> String {
    let factory = resolve_factory(&FactoryLayers::default(), &line.brief);
    let done = outcome(None);
    let pass = passed();
    walk(line, &factory, &[StationEnd::Done(&done)]);
    next(route(line, &factory, StationEnd::Done(&pass))).body
}

#[test]
fn review_diffs_from_the_cut_commit_and_a_line_with_no_base_from_main() {
    let dir = tempfile::tempdir().unwrap();
    let mut line = based(dir.path(), "none", "experiment/x", false);
    let body = review_body(&mut line);
    assert!(
        body.contains(&format!(
            "Review the work on the Line's branch (the changes since it left `experiment/x` at \
             `{CUT}`: `git diff {CUT}..HEAD`) against the spec"
        )),
        "{body}"
    );
    let (mut old, _) = placed(dir.path(), "none");
    let body = review_body(&mut old);
    assert!(
        body.contains(
            "Review the work on the Line's branch (the changes since it left main) against the spec"
        ),
        "{body}"
    );
}

#[test]
fn a_pr_targets_the_line_bases_name_on_origin() {
    let dir = tempfile::tempdir().unwrap();
    let local = finish_act(
        "draft-pr",
        &based(dir.path(), "draft-pr", "experiment/x", false),
    );
    assert!(
        local.contains("gh pr create --draft --base experiment/x --head line/186"),
        "{local}"
    );
    assert!(local.contains("open the PR from `line/186` against `experiment/x`"));
    let remote = finish_act("pr", &based(dir.path(), "pr", "origin/experiment/x", false));
    assert!(
        remote.contains("gh pr create --base experiment/x --head line/186"),
        "{remote}"
    );
    assert!(!remote.contains("--draft"));
    // The act is the act alone: what it checks of the base on origin is a section of its own.
    for text in [&local, &remote] {
        assert!(
            !text.contains("ls-remote") && !text.contains("pushBase"),
            "{text}"
        );
    }
    // Every Finish that opens a PR checks origin as it runs, never another remote.
    for (finish, base_ref) in [("draft-pr", "experiment/x"), ("pr", "origin/experiment/x")] {
        let text = finish_base(finish, &based(dir.path(), finish, base_ref, false)).unwrap();
        assert!(
            text.contains("`git ls-remote --heads origin experiment/x`"),
            "{text}"
        );
        assert!(text.contains("origin only, never another remote"));
    }
    // A Line with no base targets main and says nothing of one.
    let (old, _) = placed(dir.path(), "draft-pr");
    assert!(
        finish_act("draft-pr", &old).contains("gh pr create --draft --base main --head line/186")
    );
    assert_eq!(finish_base("draft-pr", &old), None);
    // No PR, no base to check: another Finish, or a pool off a Line branch.
    let mut shared = based(dir.path(), "pr", "experiment/x", true);
    assert_eq!(finish_base("none", &shared), None);
    assert_eq!(finish_base("tag a release", &shared), None);
    shared.branch = "experiment/x".into();
    assert_eq!(finish_base("pr", &shared), None);
}

fn decide_body(line: &mut LineState) -> String {
    let factory = resolve_factory(&FactoryLayers::default(), &line.brief);
    let done = outcome(None);
    let pass = passed();
    let none = findings(json!([]));
    walk(
        line,
        &factory,
        &[StationEnd::Done(&done), StationEnd::Done(&pass)],
    );
    next(route(line, &factory, StationEnd::Done(&none))).body
}

#[test]
fn the_line_base_on_origin_is_a_section_after_the_finish_list() {
    let dir = tempfile::tempdir().unwrap();
    let mut line = based(dir.path(), "draft-pr", "experiment/x", false);
    let body = decide_body(&mut line);
    let base = finish_base("draft-pr", &line).unwrap();
    // Item 1 points at the section, and item 2 follows it on the next line.
    let first = body
        .find("\n1. Carry out the Finish. `draft-pr`: ")
        .expect("item 1");
    let second = body
        .find("\n2. Write the report with /html to ")
        .expect("item 2");
    let item_1 = &body[first + 1..second];
    assert!(
        item_1.ends_with(
            "The PR's link is the Finish's result. Before you push anything, check the Line base \
             on origin as the section below says."
        ),
        "{item_1}"
    );
    assert!(!item_1.contains('\n'), "{item_1}");
    // The section stands after the list, set off by blank lines, before the operator's approval.
    let section =
        format!("### The Line base on origin\n\n{base}\n\nThe operator approves the Line");
    let at = body.find(&section).unwrap_or_else(|| panic!("{body}"));
    assert!(at > second);
    assert!(body[..at].ends_with(".\n\n"), "{body}");
    assert!(base.ends_with("the Finish was not carried out, and why."));

    // No base, no section and no pointer: the list is as it was.
    let (mut old, _) = placed(dir.path(), "draft-pr");
    let body = decide_body(&mut old);
    assert!(!body.contains("### The Line base on origin"), "{body}");
    assert!(!body.contains("check the Line base on origin"));
    assert!(body.contains(
        "\n\nThe operator approves the Line from the report at the Finish checkpoint the engine \
         raises next."
    ));
}

#[test]
fn a_malformed_line_base_is_refused_never_read_as_main() {
    let good = json!({"ref": "experiment/x", "commit": CUT});
    assert_eq!(
        line_base_of(&good),
        Ok(LineBase {
            base_ref: "experiment/x".into(),
            commit: CUT.into(),
        })
    );
    for (bad, why) in [
        (
            json!("experiment/x"),
            "invalid type: string \"experiment/x\", expected",
        ),
        (json!(null), "invalid type: null"),
        (json!({"ref": "experiment/x"}), "missing field `commit`"),
        (
            json!({"ref": "", "commit": CUT}),
            "its ref \"\" names no branch",
        ),
        (
            json!({"ref": "origin/", "commit": CUT}),
            "its ref \"origin/\" names no branch",
        ),
        (
            json!({"ref": "experiment/x", "commit": " "}),
            "its commit is blank",
        ),
    ] {
        let err = line_base_of(&bad).unwrap_err();
        assert!(err.contains(why), "{bad}: {err}");
    }
}

#[test]
fn the_push_grant_rows_say_what_decide_does_on_origin() {
    let dir = tempfile::tempdir().unwrap();
    let granted = finish_base(
        "draft-pr",
        &based(dir.path(), "draft-pr", "experiment/x", true),
    )
    .unwrap();
    assert!(
        granted.contains(
            "The Line brief grants `pushBase`: you may push the Line base `experiment/x` to \
             origin, but only to create it or to fast-forward it. Never force-push it."
        ),
        "{granted}"
    );
    for row in [
        "- origin has no `experiment/x`: push the local base to create it (`git push origin \
         refs/heads/experiment/x:refs/heads/experiment/x`), then open the PR.",
        "- origin's `experiment/x` is the local `experiment/x`: open the PR.",
        "- the local `experiment/x` is ahead of origin's (a fast-forward): push it (`git push \
         origin refs/heads/experiment/x:refs/heads/experiment/x`), then open the PR.",
        "- they have diverged, so it would take a force-push: push nothing and open no PR, and \
         say in the report and your Outcome's summary that the Finish was not carried out, and \
         why.",
    ] {
        assert!(granted.contains(row), "{row}\n\n{granted}");
    }
    assert!(!granted.contains("--force"));

    let refused = finish_base("pr", &based(dir.path(), "pr", "experiment/x", false)).unwrap();
    assert!(
        refused.contains(
            "The Line brief does not grant `pushBase`: never push the Line base `experiment/x` \
             to origin."
        ),
        "{refused}"
    );
    for row in [
        "- origin has no `experiment/x`: push nothing and open no PR, and say in the report and \
         your Outcome's summary that the Finish was not carried out, and why.",
        "- origin's `experiment/x` is the local `experiment/x`: open the PR.",
        "- the local `experiment/x` is ahead of origin's: open the PR, and note in the report \
         that it carries the base's unpushed commits.",
        "- they have diverged, so it would take a force-push: push nothing and open no PR, and \
         say in the report and your Outcome's summary that the Finish was not carried out, and \
         why.",
    ] {
        assert!(refused.contains(row), "{row}\n\n{refused}");
    }
    assert!(!refused.contains("refs/heads/experiment/x:"));

    // Cut from origin's branch there is no local base: origin already has it, so the PR, or none.
    let remote = finish_base("pr", &based(dir.path(), "pr", "origin/experiment/x", true)).unwrap();
    assert!(
        remote.contains(
            "The Line was cut from `origin/experiment/x`, so origin already had its Line base and \
             there is no local base to push: never push `experiment/x`."
        ),
        "{remote}"
    );
    assert!(remote.contains("If origin still has `experiment/x`, open the PR."));
    assert!(remote.contains("If it no longer does, push nothing and open no PR"));
    assert!(!remote.contains("refs/heads/experiment/x:"));
}

#[test]
fn a_brief_takes_push_base_and_still_refuses_an_unknown_field() {
    let granted = parse_brief(r#"{"spec": "s.md", "finish": "pr", "pushBase": true}"#).unwrap();
    assert!(granted.push_base);
    assert!(!parse_brief(r#"{"spec": "s.md"}"#).unwrap().push_base);
    assert!(
        parse_brief(r#"{"spec": "s.md", "pushbase": true}"#)
            .unwrap_err()
            .contains("unknown field `pushbase`")
    );
}
