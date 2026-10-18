use ac_protocol::wire::{PlanAtEdge, PlanAtNode, PlanAtPlan, PlanProblemAt};
use serde_json::json;

use super::*;

fn id(raw: &str) -> NodeId {
    NodeId::parse(raw).unwrap()
}

fn key(from: &str, on: Verdict, to: &str) -> EdgeKey {
    EdgeKey {
        from: id(from),
        on,
        to: id(to),
    }
}

fn node(kind: &str, raw: &str) -> Value {
    json!({"kind": kind, "id": raw, "title": raw, "x": 0, "y": 0})
}

fn with(mut node: Value, fields: Value) -> Value {
    for (k, v) in fields.as_object().unwrap() {
        node[k] = v.clone();
    }
    node
}

fn per_item(raw: &str) -> Value {
    with(node("agent", raw), json!({"copies": {"perItem": 2}}))
}

fn merger(raw: &str, of: &str) -> Value {
    with(node("merger", raw), json!({"of": of}))
}

fn gate(raw: &str, open: &str) -> Value {
    with(node("gate", raw), json!({"open": open}))
}

fn edge(from: &str, on: &str, to: &str) -> Value {
    json!({"from": from, "on": on, "to": to})
}

fn capped(from: &str, on: &str, to: &str, max: u32) -> Value {
    json!({"from": from, "on": on, "to": to, "cap": {"max": max}})
}

fn file(nodes: Vec<Value>, edges: Vec<Value>) -> Value {
    json!({"horde": 1, "name": "Test", "nodes": nodes, "edges": edges})
}

fn problems(value: &Value) -> Vec<PlanProblem> {
    Plan::check(value)
}

fn at_plan() -> PlanProblemAt {
    PlanProblemAt::Plan(PlanAtPlan {})
}

fn at_node(raw: &str) -> PlanProblemAt {
    PlanProblemAt::Node(PlanAtNode { id: raw.to_owned() })
}

fn at_edge(from: &str, on: &str, to: &str) -> PlanProblemAt {
    PlanProblemAt::Edge(PlanAtEdge {
        from: from.to_owned(),
        on: on.to_owned(),
        to: to.to_owned(),
    })
}

#[track_caller]
fn assert_refused(value: &Value, at: PlanProblemAt, keyword: &str) {
    let found = problems(value);
    assert!(
        found
            .iter()
            .any(|p| p.at == at && p.message.contains(keyword)),
        "no problem at {at:?} containing {keyword:?} in {found:#?}"
    );
}

/// `a` hands on to the Finish.
fn simple(extra_nodes: Vec<Value>, extra_edges: Vec<Value>) -> Value {
    let mut nodes = vec![node("agent", "a"), node("finish", "finish")];
    nodes.extend(extra_nodes);
    let mut edges = vec![edge("a", "done", "finish")];
    edges.extend(extra_edges);
    file(nodes, edges)
}

fn factory_today() -> Value {
    let ticket = |kind: &str, raw: &str| with(node(kind, raw), json!({"checkpoint": "steward"}));
    file(
        vec![
            node("conversation", "grill"),
            ticket("agent", "implement"),
            ticket("prove", "prove"),
            ticket("review", "review"),
            ticket("decide", "decide"),
            node("finish", "finish"),
        ],
        vec![
            edge("grill", "done", "implement"),
            edge("implement", "done", "prove"),
            edge("prove", "pass", "review"),
            json!({"from": "prove", "on": "fail", "to": "implement",
                   "cap": {"max": 2, "stewardExtra": true, "whenSpent": "hold"}}),
            edge("review", "clean", "decide"),
            edge("review", "findings", "decide"),
            edge("decide", "ship", "finish"),
            json!({"from": "decide", "on": "another-round", "to": "implement",
                   "cap": {"max": 1, "whenSpent": {"to": "finish"}}}),
            edge("finish", "revise", "implement"),
            edge("implement", "closed", "decide"),
            edge("prove", "closed", "decide"),
            edge("review", "closed", "decide"),
        ],
    )
}

#[test]
fn accepts_a_plain_plan() {
    assert_eq!(problems(&simple(vec![], vec![])), []);
}

#[test]
fn refuses_a_node_id_that_is_badly_shaped_numbered_or_reserved() {
    for raw in [
        "Build",
        "1build",
        "build-2",
        "plan",
        "grader",
        &"a".repeat(41),
    ] {
        let value = file(
            vec![node("agent", raw), node("finish", "finish")],
            vec![edge(raw, "done", "finish")],
        );
        assert_refused(&value, at_node(raw), "id");
    }
    assert!(NodeId::parse("build-2").is_err());
    assert!(NodeId::parse("build-v2").is_ok());
}

#[test]
fn refuses_enlist_as_a_node_id_since_an_enlist_pass_would_fail_the_pool_load() {
    assert!(NodeId::parse("enlist").is_err());
    assert!(NodeId::parse("enlisted").is_ok());
}

#[test]
fn refuses_a_node_id_used_twice() {
    assert_refused(
        &simple(vec![node("prove", "a")], vec![]),
        at_node("a"),
        "twice",
    );
}

#[test]
fn refuses_an_edge_naming_no_node() {
    assert_refused(
        &simple(vec![], vec![edge("a", "closed", "ghost")]),
        at_edge("a", "closed", "ghost"),
        "no node",
    );
    assert_refused(
        &simple(vec![], vec![edge("ghost", "done", "a")]),
        at_edge("ghost", "done", "a"),
        "no node",
    );
    let spent = json!({"from": "a", "on": "done", "to": "a",
                       "cap": {"max": 1, "whenSpent": {"to": "ghost"}}});
    assert_refused(
        &simple(vec![], vec![spent]),
        at_edge("a", "done", "a"),
        "no node",
    );
}

#[test]
fn refuses_a_verdict_outside_the_from_nodes_vocabulary() {
    assert_refused(
        &simple(vec![], vec![edge("a", "fail", "finish")]),
        at_edge("a", "fail", "finish"),
        "not a verdict",
    );
    assert_refused(
        &simple(vec![], vec![edge("a", "banana", "finish")]),
        at_edge("a", "banana", "finish"),
        "not a verdict",
    );
    assert_refused(
        &simple(vec![], vec![edge("finish", "done", "a")]),
        at_edge("finish", "done", "a"),
        "not a verdict",
    );
    assert_refused(
        &simple(
            vec![gate("g", "auto")],
            vec![
                edge("a", "closed", "g"),
                edge("g", "revise", "finish"),
                edge("g", "open", "finish"),
            ],
        ),
        at_edge("g", "revise", "finish"),
        "not a verdict",
    );
}

#[test]
fn refuses_an_edge_given_twice() {
    assert_refused(
        &simple(vec![], vec![edge("a", "done", "finish")]),
        at_edge("a", "done", "finish"),
        "twice",
    );
}

#[test]
fn refuses_anything_but_one_finish() {
    assert_refused(
        &file(vec![node("agent", "a")], vec![]),
        at_plan(),
        "one Finish",
    );
    let two = simple(
        vec![node("finish", "end")],
        vec![edge("a", "closed", "end")],
    );
    assert_refused(&two, at_node("end"), "one Finish");
    assert!(
        !problems(&two).iter().any(|p| p.at == at_node("finish")),
        "the first Finish is the one kept"
    );
}

#[test]
fn refuses_a_plan_with_no_entry() {
    assert_refused(
        &file(vec![node("finish", "finish")], vec![]),
        at_plan(),
        "no entry",
    );
}

#[test]
fn refuses_a_node_no_entry_reaches() {
    let value = simple(
        vec![per_item("b"), merger("m", "b"), node("agent", "c")],
        vec![edge("m", "done", "c")],
    );
    assert_refused(&value, at_node("m"), "reached");
    assert_refused(&value, at_node("c"), "reached");
}

#[test]
fn refuses_a_node_that_cannot_reach_the_finish() {
    let value = simple(vec![gate("g", "auto")], vec![edge("a", "closed", "g")]);
    assert_refused(&value, at_node("g"), "cannot reach the Finish");
}

#[test]
fn refuses_a_merger_of_anything_but_a_per_item_ticket_node() {
    let one = simple(
        vec![merger("m", "a")],
        vec![edge("a", "closed", "m"), edge("m", "done", "finish")],
    );
    assert_refused(&one, at_node("m"), "per-item");
    let nothing = simple(vec![merger("m", "ghost")], vec![edge("a", "closed", "m")]);
    assert_refused(&nothing, at_node("m"), "per-item");
    let missing = simple(vec![node("merger", "m")], vec![]);
    assert_refused(&missing, at_node("m"), "per-item");
}

#[test]
fn refuses_a_second_merger_for_one_node() {
    let value = simple(
        vec![per_item("b"), merger("m", "b"), merger("m2", "b")],
        vec![
            edge("a", "closed", "b"),
            edge("b", "done", "m"),
            edge("b", "closed", "m2"),
        ],
    );
    assert_refused(&value, at_node("m2"), "already has a Merger");
}

#[test]
fn refuses_an_edge_that_skips_a_nodes_merger_or_enters_another_nodes() {
    let value = simple(
        vec![per_item("b"), merger("m", "b")],
        vec![
            edge("a", "closed", "b"),
            edge("b", "done", "m"),
            edge("b", "closed", "finish"),
            edge("a", "closed", "m"),
        ],
    );
    assert_refused(
        &value,
        at_edge("b", "closed", "finish"),
        "must go to its Merger",
    );
    assert_refused(&value, at_edge("a", "closed", "m"), "only");
}

#[test]
fn refuses_a_cycle_with_no_loop_edge_on_its_first_edge() {
    let value = simple(
        vec![node("agent", "b")],
        vec![edge("a", "closed", "b"), edge("b", "done", "a")],
    );
    let found = problems(&value);
    let cycles: Vec<_> = found
        .iter()
        .filter(|p| p.message.contains("cycle"))
        .collect();
    assert_eq!(cycles.len(), 1, "{found:#?}");
    assert_eq!(cycles[0].at, at_edge("a", "closed", "b"));
    assert!(cycles[0].message.contains("`a`") && cycles[0].message.contains("`b`"));

    let selfie = simple(vec![], vec![edge("a", "closed", "a")]);
    assert_refused(&selfie, at_edge("a", "closed", "a"), "cycle");
}

#[test]
fn accepts_a_cycle_through_an_operator_gate_and_refuses_one_through_an_auto_gate() {
    let through = |open: &str| {
        simple(
            vec![gate("g", open)],
            vec![edge("a", "closed", "g"), edge("g", "open", "a")],
        )
    };
    assert_eq!(problems(&through("operator")), []);
    assert_eq!(problems(&through("steward")), []);
    assert_refused(&through("auto"), at_edge("a", "closed", "g"), "cycle");
}

#[test]
fn refuses_a_cap_on_an_edge_that_closes_no_cycle() {
    assert_refused(
        &simple(vec![], vec![capped("a", "closed", "finish", 2)]),
        at_edge("a", "closed", "finish"),
        "closes no cycle",
    );
}

#[test]
fn refuses_a_cap_or_a_per_item_limit_of_zero() {
    assert_refused(
        &simple(vec![], vec![capped("a", "closed", "a", 0)]),
        at_edge("a", "closed", "a"),
        "at least 1",
    );
    let zero = with(node("agent", "b"), json!({"copies": {"perItem": 0}}));
    assert_refused(
        &simple(vec![zero], vec![edge("a", "closed", "b")]),
        at_node("b"),
        "at least 1",
    );
}

#[test]
fn reports_every_problem_at_once() {
    let value = file(
        vec![node("agent", "Bad"), node("agent", "b"), node("agent", "b")],
        vec![edge("b", "fail", "ghost")],
    );
    let found = problems(&value);
    for (at, keyword) in [
        (at_node("Bad"), "id"),
        (at_node("b"), "twice"),
        (at_plan(), "one Finish"),
        (at_edge("b", "fail", "ghost"), "no node"),
        (at_edge("b", "fail", "ghost"), "not a verdict"),
    ] {
        assert!(
            found
                .iter()
                .any(|p| p.at == at && p.message.contains(keyword)),
            "missing {keyword:?} at {at:?} in {found:#?}"
        );
    }
}

#[test]
fn reads_a_bad_node_or_edge_as_one_problem_and_keeps_reading() {
    let value = simple(
        vec![
            with(node("finish", "end"), json!({"act": "merge"})),
            with(node("agent", "b"), json!({"copies": "many"})),
        ],
        vec![edge("a", "closed", "b"), json!({"from": "a", "on": "done"})],
    );
    let found = problems(&value);
    let on = |at: PlanProblemAt| found.iter().filter(move |p| p.at == at).collect::<Vec<_>>();
    let end = on(at_node("end"));
    assert_eq!(end.len(), 1, "{found:#?}");
    assert!(end[0].message.contains("`act`") && end[0].message.contains("merge"));
    let b = on(at_node("b"));
    assert_eq!(b.len(), 1, "{found:#?}");
    assert!(b[0].message.contains("`copies`"));
    assert!(
        on(at_edge("a", "closed", "b")).is_empty(),
        "an unread node is not missing"
    );
    assert_eq!(on(at_edge("a", "done", "")).len(), 1, "{found:#?}");
}

#[test]
fn refuses_a_file_with_a_bad_top_level() {
    assert_refused(&json!([]), at_plan(), "object");
    let value = json!({"horde": 2, "name": " ", "nodes": {}, "edges": [], "extra": 1});
    assert_refused(&value, at_plan(), "`horde`");
    assert_refused(&value, at_plan(), "`name`");
    assert_refused(&value, at_plan(), "`nodes`");
    assert_refused(&value, at_plan(), "`extra`");
    assert!(Plan::parse("{").is_err_and(|ps| ps[0].message.contains("not JSON")));
}

#[test]
fn derives_factory_todays_entries_and_nested_loops() {
    let plan = Plan::from_value(&factory_today()).unwrap();
    assert_eq!(plan.entries(), [id("grill")]);
    assert_eq!(plan.finish(), &id("finish"));
    let fail = key("prove", Verdict::Fail, "implement");
    let round = key("decide", Verdict::AnotherRound, "implement");
    let revise = key("finish", Verdict::Revise, "implement");
    let loops: Vec<_> = plan.loops.keys().cloned().collect();
    assert_eq!(loops, [fail.clone(), round.clone(), revise.clone()]);
    assert_eq!(plan.nested_loops(&fail), []);
    assert_eq!(plan.nested_loops(&round), std::slice::from_ref(&fail));
    assert_eq!(plan.nested_loops(&revise), [fail.clone(), round.clone()]);
    assert!(!plan.is_loop(&key("implement", Verdict::Done, "prove")));
}

#[test]
fn every_preset_is_a_valid_plan_that_round_trips() {
    for preset in PRESETS {
        let plan = Plan::parse(preset.json)
            .unwrap_or_else(|problems| panic!("{} is invalid: {problems:#?}", preset.slug));
        if preset.slug == "factory-today" {
            let spec = Plan::from_value(&factory_today()).unwrap();
            assert_eq!((plan.entries(), &plan.loops), (spec.entries(), &spec.loops));
        }
        assert_eq!(Plan::parse(&plan.to_json()), Ok(plan), "{}", preset.slug);
    }
}

#[test]
fn nests_inner_loops_in_an_outer_round_and_never_the_reverse() {
    let value = file(
        vec![
            with(node("agent", "tasks"), json!({"makesItems": true})),
            per_item("build"),
            merger("build-merge", "build"),
            node("prove", "test"),
            node("review", "review"),
            node("decide", "ship"),
            node("finish", "finish"),
        ],
        vec![
            edge("tasks", "done", "build"),
            edge("build", "done", "build-merge"),
            edge("build-merge", "done", "test"),
            edge("test", "pass", "review"),
            capped("test", "fail", "build", 2),
            edge("review", "clean", "ship"),
            capped("review", "findings", "build", 2),
            edge("ship", "ship", "finish"),
            capped("ship", "another-round", "build", 1),
        ],
    );
    let plan = Plan::from_value(&value).unwrap();
    let fail = key("test", Verdict::Fail, "build");
    let findings = key("review", Verdict::Findings, "build");
    let round = key("ship", Verdict::AnotherRound, "build");
    assert_eq!(plan.nested_loops(&round), [fail.clone(), findings.clone()]);
    assert_eq!(plan.nested_loops(&findings), std::slice::from_ref(&fail));
    assert_eq!(plan.nested_loops(&fail), []);
    assert_eq!(plan.merger_of(&id("build")), Some(&id("build-merge")));
    assert_eq!(
        plan.conflict_for(&id("build")),
        Some(&Conflict::Resolver(Assign::default()))
    );
    assert_eq!(plan.conflict_for(&id("test")), None);
    assert_eq!(
        plan.vocabulary(&id("build-merge")),
        [Verdict::Done, Verdict::Closed]
    );
}

#[test]
fn nests_a_loop_whose_target_lies_after_the_outer_loops_target() {
    let value = file(
        vec![
            node("agent", "plan-it"),
            node("agent", "build"),
            node("prove", "test"),
            node("decide", "ship"),
            node("finish", "finish"),
        ],
        vec![
            edge("plan-it", "done", "build"),
            edge("build", "done", "test"),
            edge("test", "pass", "ship"),
            capped("test", "fail", "test", 2),
            edge("ship", "ship", "finish"),
            capped("ship", "another-round", "build", 1),
        ],
    );
    let plan = Plan::from_value(&value).unwrap();
    let retest = key("test", Verdict::Fail, "test");
    let round = key("ship", Verdict::AnotherRound, "build");
    assert_eq!(plan.nested_loops(&round), std::slice::from_ref(&retest));
    assert_eq!(plan.nested_loops(&retest), []);
}

#[test]
fn round_trips_through_its_canonical_json() {
    let every_field = file(
        vec![
            with(
                node("conversation", "grill"),
                json!({"skill": "grill-me", "assign": {"harness": "claude"}, "note": "Ask."}),
            ),
            with(
                per_item("build"),
                json!({"makesItems": true, "checkpoint": "steward", "spawns": "land",
                       "assign": {"model": "opus", "effort": "high"}}),
            ),
            with(merger("build-merge", "build"), json!({"conflict": "wait"})),
            with(gate("ok", "steward"), json!({"join": "all"})),
            with(
                node("finish", "finish"),
                json!({"act": {"other": "tag it"}, "assign": {"harness": "codex"}}),
            ),
        ],
        vec![
            edge("grill", "done", "build"),
            edge("build", "done", "build-merge"),
            edge("build-merge", "done", "ok"),
            edge("ok", "open", "finish"),
            json!({"from": "ok", "on": "revise", "to": "build",
                   "cap": {"max": 3, "stewardExtra": true, "whenSpent": {"to": "finish"}}}),
        ],
    );
    for value in [factory_today(), every_field] {
        let plan = Plan::from_value(&value).unwrap();
        let text = plan.to_json();
        assert!(text.ends_with("}\n"));
        assert_eq!(Plan::parse(&text), Ok(plan));
    }
    let written: Value =
        serde_json::from_str(&Plan::from_value(&simple(vec![], vec![])).unwrap().to_json())
            .unwrap();
    assert_eq!(
        written["nodes"][0],
        json!({"kind": "agent", "id": "a", "title": "a", "x": 0, "y": 0, "copies": "one",
               "makesItems": false, "checkpoint": "operator", "spawns": "hold"})
    );
    assert_eq!(written["stewardEdits"], json!(false));
}

/// `tasks -> build -> review -> finish`, with `review.findings` looping back to `build`.
fn editable() -> Plan {
    Plan::from_value(&file(
        vec![
            node("agent", "tasks"),
            with(
                node("agent", "build"),
                json!({"title": "Build", "x": 10, "y": 20}),
            ),
            node("review", "review"),
            node("finish", "finish"),
        ],
        vec![
            edge("tasks", "done", "build"),
            edge("build", "done", "review"),
            edge("build", "closed", "review"),
            edge("review", "clean", "finish"),
            capped("review", "findings", "build", 2),
        ],
    ))
    .unwrap()
}

fn edge_keys(plan: &Plan) -> Vec<String> {
    plan.edges()
        .iter()
        .map(|e| format!("{}.{} -> {}", e.key.from, e.key.on.as_str(), e.key.to))
        .collect()
}

fn node_ids(plan: &Plan) -> Vec<&str> {
    plan.nodes().map(|n| n.id.as_str()).collect()
}

fn body(plan: &Plan, raw: &str) -> NodeBody {
    plan.node(&id(raw)).unwrap().body.clone()
}

fn with_copies(body: NodeBody, copies: Copies) -> NodeBody {
    let NodeBody::Ticket(ticket) = body else {
        panic!("not a Ticket node")
    };
    NodeBody::Ticket(TicketNode { copies, ..ticket })
}

const PER_ITEM: Copies = Copies::PerItem { cap: Cap::All };

fn set_copies(plan: &Plan, raw: &str, copies: Copies) -> Edited {
    plan.edit(&[PlanEdit::SetNode {
        id: id(raw),
        title: plan.node(&id(raw)).unwrap().title.clone(),
        body: with_copies(body(plan, raw), copies),
    }])
    .unwrap()
}

#[test]
fn places_a_merger_when_a_node_becomes_per_item() {
    let edited = set_copies(&editable(), "build", PER_ITEM);
    let plan = &edited.plan;
    assert_eq!(
        node_ids(plan),
        ["tasks", "build", "build-merge", "review", "finish"]
    );
    let placed = plan.node(&id("build-merge")).unwrap();
    assert_eq!(placed.title, "Merge Build");
    assert_eq!(placed.at, (10, 270));
    assert_eq!(
        placed.body,
        NodeBody::Merger(MergerNode {
            of: id("build"),
            conflict: Conflict::Resolver(Assign::default()),
        })
    );
    assert_eq!(
        edge_keys(plan),
        [
            "tasks.done -> build",
            "build-merge.done -> review",
            "build-merge.closed -> review",
            "review.clean -> finish",
            "review.findings -> build",
            "build.done -> build-merge",
            "build.closed -> build-merge",
        ]
    );
    assert_eq!(
        edited.notes,
        ["`build` is per-item now: placed `build-merge` and moved 2 edges onto it"]
    );
}

#[test]
fn lifts_the_merger_when_a_node_goes_back_to_one_copy() {
    let edited = set_copies(
        &set_copies(&editable(), "build", PER_ITEM).plan,
        "build",
        Copies::One,
    );
    assert_eq!(
        node_ids(&edited.plan),
        ["tasks", "build", "review", "finish"]
    );
    assert_eq!(
        edge_keys(&edited.plan),
        [
            "tasks.done -> build",
            "build.done -> review",
            "build.closed -> review",
            "review.clean -> finish",
            "review.findings -> build",
        ]
    );
    assert_eq!(
        edited.notes,
        ["`build` is one copy now: lifted `build-merge` and moved 2 edges back onto it"]
    );
}

#[test]
fn removing_a_merger_hands_each_copy_on_alone() {
    let merged = set_copies(&editable(), "build", PER_ITEM).plan;
    let edited = merged
        .edit(&[PlanEdit::RemoveNode(id("build-merge"))])
        .unwrap();
    assert!(edited.plan.node(&id("build")).unwrap().body.is_per_item());
    assert_eq!(edited.plan.merger_of(&id("build")), None);
    assert!(edge_keys(&edited.plan).contains(&"build.done -> review".to_owned()));
    assert!(edge_keys(&edited.plan).contains(&"build.closed -> review".to_owned()));
    assert_eq!(
        edited.notes,
        [
            "removed `build-merge`, so each copy of `build` hands on alone: moved 2 edges back onto it"
        ]
    );

    let back = edited
        .plan
        .edit(&[PlanEdit::AddNode(Node {
            id: id("fold"),
            title: "Fold".to_owned(),
            at: (0, 0),
            body: NodeBody::Merger(MergerNode {
                of: id("build"),
                conflict: Conflict::Wait,
            }),
        })])
        .unwrap();
    assert_eq!(back.plan.merger_of(&id("build")), Some(&id("fold")));
    let keys = edge_keys(&back.plan);
    for expected in [
        "fold.done -> review",
        "fold.closed -> review",
        "build.done -> fold",
        "build.closed -> fold",
    ] {
        assert!(keys.contains(&expected.to_owned()), "{keys:?}");
    }
    assert_eq!(
        back.notes,
        ["`fold` folds `build` again: moved 2 edges onto it"]
    );
}

#[test]
fn removing_a_per_item_node_removes_its_merger() {
    let merged = set_copies(&editable(), "build", PER_ITEM).plan;
    let edited = merged.edit(&[PlanEdit::RemoveNode(id("build"))]).unwrap();
    assert_eq!(node_ids(&edited.plan), ["tasks", "review", "finish"]);
    assert_eq!(edge_keys(&edited.plan), ["review.clean -> finish"]);
    assert_eq!(edited.notes, ["removed `build-merge` with `build`"]);
    assert_eq!(edited.plan.entries(), [id("tasks"), id("review")]);
}

#[test]
fn adding_a_per_item_node_places_its_merger() {
    let built = body(&editable(), "build");
    let edited = editable()
        .edit(&[
            PlanEdit::AddNode(Node {
                id: id("fan"),
                title: "Fan".to_owned(),
                at: (5, 5),
                body: with_copies(built, PER_ITEM),
            }),
            PlanEdit::Link(Edge {
                key: key("tasks", Verdict::Closed, "fan"),
                cap: None,
            }),
        ])
        .unwrap();
    assert_eq!(
        node_ids(&edited.plan),
        ["tasks", "build", "review", "finish", "fan", "fan-merge"]
    );
    assert!(edge_keys(&edited.plan).contains(&"fan.done -> fan-merge".to_owned()));
    assert_eq!(
        edited.notes,
        ["`fan` is per-item now: placed `fan-merge` and moved 0 edges onto it"]
    );
}

#[test]
fn a_link_from_a_node_with_a_merger_is_made_from_the_merger() {
    let merged = set_copies(&editable(), "build", PER_ITEM).plan;
    let edited = merged
        .edit(&[PlanEdit::Link(Edge {
            key: key("build", Verdict::Done, "finish"),
            cap: None,
        })])
        .unwrap();
    assert!(edge_keys(&edited.plan).contains(&"build-merge.done -> finish".to_owned()));
    assert!(!edge_keys(&edited.plan).contains(&"build.done -> finish".to_owned()));
    assert_eq!(
        edited.notes,
        ["linked from `build-merge`, since `build` hands on through its Merger"]
    );
}

#[test]
fn plain_edits_change_only_what_they_name() {
    let plan = editable();
    let findings = key("review", Verdict::Findings, "build");
    let edited = plan
        .edit(&[
            PlanEdit::Move {
                id: id("tasks"),
                at: (7, 8),
            },
            PlanEdit::SetMeta(PlanMeta {
                name: "Renamed".to_owned(),
                steward_edits: true,
                ..PlanMeta::default()
            }),
            PlanEdit::SetCap {
                edge: findings.clone(),
                cap: Some(LoopCap {
                    max: NonZeroU32::new(5).unwrap(),
                    steward_extra: true,
                    when_spent: WhenSpent::Hold,
                }),
            },
            PlanEdit::Unlink(key("build", Verdict::Closed, "review")),
        ])
        .unwrap();
    assert_eq!(edited.plan.node(&id("tasks")).unwrap().at, (7, 8));
    assert_eq!(edited.plan.meta().name, "Renamed");
    assert!(edited.plan.meta().steward_edits);
    let cap = edited
        .plan
        .edges()
        .iter()
        .find(|e| e.key == findings)
        .unwrap();
    assert_eq!(cap.cap.as_ref().unwrap().max.get(), 5);
    assert!(!edge_keys(&edited.plan).contains(&"build.closed -> review".to_owned()));
    assert_eq!(edited.notes, Vec::<String>::new());
}

#[test]
fn refuses_edits_on_what_is_not_there_and_edits_that_break_a_rule() {
    let plan = editable();
    let refused = plan
        .edit(&[
            PlanEdit::RemoveNode(id("ghost")),
            PlanEdit::Unlink(key("tasks", Verdict::Done, "review")),
            PlanEdit::AddNode(plan.node(&id("tasks")).unwrap().clone()),
        ])
        .unwrap_err();
    assert!(
        refused
            .iter()
            .any(|p| p.at == at_node("ghost") && p.message.contains("no node"))
    );
    assert!(
        refused
            .iter()
            .any(|p| p.at == at_edge("tasks", "done", "review"))
    );
    assert!(
        refused
            .iter()
            .any(|p| p.at == at_node("tasks") && p.message.contains("already"))
    );

    let uncapped = plan
        .edit(&[PlanEdit::SetCap {
            edge: key("review", Verdict::Findings, "build"),
            cap: None,
        }])
        .unwrap_err();
    assert!(
        uncapped.iter().any(|p| p.message.contains("cycle")),
        "{uncapped:#?}"
    );
}

mod library_files {
    use super::super::library::{self, LibraryError};
    use super::*;
    use crate::js;

    fn home() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        (dir, home)
    }

    #[test]
    fn saves_a_plan_as_its_canonical_file_and_leaves_no_temp() {
        let (_dir, home) = home();
        let saved = library::save(&home, "mine", &factory_today()).unwrap();
        let dir = library::plans_dir(&home);
        assert_eq!(js::read_dir_names(&dir).unwrap(), ["mine.json"]);
        let text = std::fs::read_to_string(format!("{dir}/mine.json")).unwrap();
        assert_eq!(text, saved.to_json());
        assert_eq!(library::load(&home, "mine"), Ok(saved));
    }

    #[test]
    fn refuses_a_bad_slug_an_invalid_plan_and_a_preset_slug() {
        let (_dir, home) = home();
        for slug in ["Mine", "-mine", "validate", "", &"a".repeat(65)] {
            let refused = library::save(&home, slug, &factory_today()).unwrap_err();
            assert_eq!(refused, LibraryError::BadSlug(slug.to_owned()));
            assert!(refused.to_string().contains("is not a Plan slug"));
        }
        let invalid = library::save(&home, "mine", &file(vec![], vec![])).unwrap_err();
        assert!(matches!(invalid, LibraryError::Invalid(_)));
        assert!(
            invalid
                .to_string()
                .starts_with("plans: the Plan is invalid: ")
        );
        assert!(!js::exists(library::plans_dir(&home)));
        if let Some(preset) = PRESETS.first() {
            let refused = library::save(&home, preset.slug, &factory_today()).unwrap_err();
            assert!(refused.to_string().contains("is a Preset"), "{refused}");
        }
    }

    #[test]
    fn lists_presets_first_then_library_files_by_slug_broken_ones_included() {
        let (_dir, home) = home();
        library::save(&home, "zeta", &factory_today()).unwrap();
        library::save(&home, "alpha", &simple(vec![], vec![])).unwrap();
        let dir = library::plans_dir(&home);
        std::fs::write(format!("{dir}/broken.json"), "not json").unwrap();
        std::fs::write(
            format!("{dir}/cyclic.json"),
            js::to_json(&simple(vec![], vec![edge("a", "closed", "a")])),
        )
        .unwrap();
        std::fs::write(format!("{dir}/alpha.json.tmp-1-0"), "{}").unwrap();

        let listed = library::list(&home);
        let presets = PRESETS.len();
        assert!(listed[..presets].iter().all(|p| p.preset));
        let slugs: Vec<_> = listed[presets..].iter().map(|p| p.slug.as_str()).collect();
        assert_eq!(slugs, ["alpha", "broken", "cyclic", "zeta"]);
        let broken = &listed[presets + 1];
        assert_eq!(broken.name, "broken");
        assert_eq!(broken.problems.len(), 1);
        assert_eq!(broken.problems[0].at, at_plan());
        assert!(broken.problems[0].message.contains("is not JSON"));
        let cyclic = &listed[presets + 2];
        assert_eq!(cyclic.name, "Test");
        assert!(cyclic.problems.iter().any(|p| p.message.contains("cycle")));
        assert!(listed[presets].problems.is_empty());
    }

    #[test]
    fn deletes_a_library_file_and_refuses_a_preset_or_missing_slug() {
        let (_dir, home) = home();
        library::save(&home, "mine", &factory_today()).unwrap();
        library::delete(&home, "mine").unwrap();
        let missing = library::delete(&home, "mine").unwrap_err();
        assert_eq!(missing, LibraryError::NotFound("mine".to_owned()));
        assert!(missing.to_string().contains("no Plan"));
        assert_eq!(
            library::get(&home, "mine"),
            Err(LibraryError::NotFound("mine".to_owned()))
        );
        if let Some(preset) = PRESETS.first() {
            assert_eq!(
                library::delete(&home, preset.slug),
                Err(LibraryError::PresetSlug(preset.slug.to_owned()))
            );
        }
    }

    #[test]
    fn reads_a_broken_library_file_as_unreadable() {
        let (_dir, home) = home();
        let dir = library::plans_dir(&home);
        js::mkdir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/broken.json"), "not json").unwrap();
        let refused = library::get(&home, "broken").unwrap_err();
        assert_eq!(refused, LibraryError::Unreadable("broken".to_owned()));
        assert!(refused.to_string().contains("is not JSON"));
    }
}
