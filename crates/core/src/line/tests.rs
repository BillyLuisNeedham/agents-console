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
    let (line, first) = start_line(brief(), "docs/specs/x.brief.json", &factory);
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
    let check = VerdictCheck {
        station: Station::Prove,
        musts: vec![],
    };
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
    let check = VerdictCheck {
        station: Station::Review,
        musts: vec![],
    };
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
    let implement = VerdictCheck {
        station: Station::Implement,
        musts: vec![],
    };
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
    assert_eq!(verdict_check(&line, Station::Decide).musts, ["Leak"]);
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
    let (mut line, _) = start_line(brief(), "b.json", &factory);
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
    let (mut line, _) = start_line(brief, "b.json", &factory);
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
    let (mut line, _) = start_line(brief, "b.json", &factory);
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
            .contains("carry out the Finish before you record it: `draft-pr`")
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
    let (_, first) = start_line(brief(), "docs/specs/x.brief.json", &factory);
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
