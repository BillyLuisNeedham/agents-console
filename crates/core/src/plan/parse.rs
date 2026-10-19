//! The one boundary: a Plan file into a valid `Plan`, and every rule that decides "valid".

use std::collections::{HashMap, HashSet};

use ac_protocol::wire::{
    AllItems, PlanAssign, PlanAtEdge, PlanAtNode, PlanAtPlan, PlanCap, PlanCheckpoint,
    PlanConflict, PlanConversationNode, PlanCopies, PlanEdgeFile, PlanEditFile, PlanFinishAct,
    PlanFinishNode, PlanGateNode, PlanHold, PlanJoin, PlanLoopCap, PlanMergerNode, PlanNamedAct,
    PlanNodeFile, PlanOneCopy, PlanOpener, PlanOtherAct, PlanPerItem, PlanProblemAt, PlanResolver,
    PlanSpawns, PlanSpentTo, PlanTicketNode, PlanWait, PlanWhenSpent,
};
use serde::Deserialize;

use super::*;

const RESERVED: [&str; 5] = ["plan", "line", "spawn", "grader", "enlist"];

const PLAN_FIELDS: [&str; 8] = [
    "horde",
    "name",
    "author",
    "source",
    "note",
    "stewardEdits",
    "nodes",
    "edges",
];

pub(super) fn node_id(raw: &str) -> Result<NodeId, String> {
    let mut chars = raw.chars();
    let shaped = raw.len() <= 40
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !shaped {
        return Err(format!(
            "`{raw}` is not a node id: use a lowercase letter, then at most 39 lowercase letters, digits or hyphens"
        ));
    }
    if raw
        .rsplit_once('-')
        .is_some_and(|(_, tail)| !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()))
    {
        return Err(format!(
            "`{raw}` is not a node id: it ends in -<digits>, which Ticket ids append"
        ));
    }
    if RESERVED.contains(&raw) {
        return Err(format!("`{raw}` is not a node id: it is a reserved word"));
    }
    Ok(NodeId(raw.to_owned()))
}

pub(super) fn at_plan(message: String) -> PlanProblem {
    PlanProblem {
        at: PlanProblemAt::Plan(PlanAtPlan {}),
        message,
    }
}

pub(super) fn at_node(id: &str, message: String) -> PlanProblem {
    PlanProblem {
        at: PlanProblemAt::Node(PlanAtNode { id: id.to_owned() }),
        message,
    }
}

pub(super) fn at_edge(from: &str, on: &str, to: &str, message: String) -> PlanProblem {
    PlanProblem {
        at: PlanProblemAt::Edge(PlanAtEdge {
            from: from.to_owned(),
            on: on.to_owned(),
            to: to.to_owned(),
        }),
        message,
    }
}

/// A Plan before `validate` has judged it. Its `NodeId`s are unchecked: judging them is
/// `validate`'s first rule, and only a valid draft becomes a `Plan`.
pub(super) struct Draft {
    pub meta: PlanMeta,
    pub nodes: Vec<Node>,
    pub edges: Vec<DraftEdge>,
    /// The ids of nodes the file holds but that could not be read, so an edge naming one is not
    /// also reported as naming no node.
    pub unread: Vec<String>,
    /// Every node and edge was read. The whole-graph rules run only then, since a missing node
    /// would make them echo the problem that dropped it.
    pub whole: bool,
}

/// An edge whose `on` is still a word, so a word that is no verdict is reported by `validate`
/// beside the others rather than dropping the edge.
pub(super) struct DraftEdge {
    pub from: NodeId,
    pub on: String,
    pub to: NodeId,
    pub cap: Option<LoopCap>,
}

impl DraftEdge {
    fn typed(self) -> Result<Edge, PlanProblem> {
        let Some(on) = Verdict::parse(&self.on) else {
            let (from, to) = (self.from.as_str(), self.to.as_str());
            return Err(at_edge(
                from,
                &self.on,
                to,
                format!("`{}` is not a verdict", self.on),
            ));
        };
        Ok(Edge {
            key: EdgeKey {
                from: self.from,
                on,
                to: self.to,
            },
            cap: self.cap,
        })
    }
}

impl From<Edge> for DraftEdge {
    fn from(edge: Edge) -> Self {
        DraftEdge {
            from: edge.key.from,
            on: edge.key.on.as_str().to_owned(),
            to: edge.key.to,
            cap: edge.cap,
        }
    }
}

pub(super) fn from_value(value: &Value) -> Result<Plan, Vec<PlanProblem>> {
    let Read {
        draft,
        mut problems,
        ..
    } = read(value);
    match validate(draft) {
        Ok(plan) if problems.is_empty() => Ok(plan),
        Ok(_) => Err(problems),
        Err(more) => {
            problems.extend(more);
            Err(problems)
        }
    }
}

struct Read {
    draft: Draft,
    problems: Vec<PlanProblem>,
    lossless: bool,
}

pub(super) struct LosslessDraft {
    pub meta: PlanMeta,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

pub(super) fn read_lossless(value: &Value) -> Result<LosslessDraft, Vec<PlanProblem>> {
    let Read {
        draft,
        problems,
        lossless,
    } = read(value);
    let mut refused = if lossless { Vec::new() } else { problems };
    let mut edges = Vec::new();
    for edge in draft.edges {
        match edge.typed() {
            Ok(edge) => edges.push(edge),
            Err(problem) => refused.push(problem),
        }
    }
    if !refused.is_empty() {
        return Err(refused);
    }
    Ok(LosslessDraft {
        meta: draft.meta,
        nodes: draft.nodes,
        edges,
    })
}

/// The file read field by field, so one bad node or edge is one problem and the rest still count.
fn read(value: &Value) -> Read {
    let mut problems = Vec::new();
    let mut blank_name = None;
    let mut draft = Draft {
        meta: PlanMeta::default(),
        nodes: Vec::new(),
        edges: Vec::new(),
        unread: Vec::new(),
        whole: true,
    };
    let Some(file) = value.as_object() else {
        draft.whole = false;
        problems.push(at_plan("a Plan file is a JSON object".to_owned()));
        return Read {
            draft,
            problems,
            lossless: false,
        };
    };
    for key in file
        .keys()
        .filter(|key| !PLAN_FIELDS.contains(&key.as_str()))
    {
        problems.push(at_plan(format!("`{key}` is not a Plan field")));
    }
    if file.get("horde").and_then(Value::as_u64) != Some(u64::from(HORDE_VERSION)) {
        problems.push(at_plan(format!("`horde` must be {HORDE_VERSION}")));
    }
    let named = match file.get("name") {
        Some(Value::String(name)) => {
            draft.meta.name = name.clone();
            !name.trim().is_empty()
        }
        _ => false,
    };
    if !named {
        let problem = at_plan("a Plan needs a `name`".to_owned());
        if matches!(file.get("name"), None | Some(Value::String(_))) {
            blank_name = Some(problem.clone());
        }
        problems.push(problem);
    }
    let mut text = |key: &str| match file.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => {
            problems.push(at_plan(format!("`{key}` must be a string")));
            None
        }
    };
    draft.meta.author = text("author");
    draft.meta.source = text("source");
    draft.meta.note = text("note");
    draft.meta.steward_edits = match file.get("stewardEdits") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(on)) => *on,
        Some(_) => {
            problems.push(at_plan("`stewardEdits` must be true or false".to_owned()));
            false
        }
    };

    let mut array = |key: &str| match file.get(key) {
        Some(Value::Array(items)) => Some(items.as_slice()),
        _ => {
            problems.push(at_plan(format!("`{key}` must be an array")));
            None
        }
    };
    let (nodes, edges) = (array("nodes"), array("edges"));
    draft.whole = nodes.is_some() && edges.is_some();
    let (nodes, edges) = (nodes.unwrap_or_default(), edges.unwrap_or_default());

    for (index, raw) in nodes.iter().enumerate() {
        match PlanNodeFile::deserialize(raw) {
            Ok(node) => draft.nodes.push(node_of(node, &mut problems)),
            Err(err) => {
                let id = raw
                    .get("id")
                    .and_then(Value::as_str)
                    .map_or_else(|| format!("#{index}"), str::to_owned);
                problems.push(at_node(&id, readable(&err, raw)));
                draft.unread.push(id);
                draft.whole = false;
            }
        }
    }
    for raw in edges {
        match PlanEdgeFile::deserialize(raw) {
            Ok(edge) => draft.edges.push(edge_of(edge, &mut problems)),
            Err(err) => {
                let end = |key: &str| raw.get(key).and_then(Value::as_str).unwrap_or("");
                problems.push(at_edge(
                    end("from"),
                    end("on"),
                    end("to"),
                    readable(&err, raw),
                ));
                draft.whole = false;
            }
        }
    }
    let lossless = problems
        .iter()
        .all(|problem| Some(problem) == blank_name.as_ref());
    Read {
        draft,
        problems,
        lossless,
    }
}

/// serde's text, except where an untagged union would only say "did not match any variant".
fn readable(err: &serde_json::Error, raw: &Value) -> String {
    const SHAPES: [(&str, &str, &str); 4] = [
        (
            "PlanCopies",
            "/copies",
            r#"`copies` must be "one" or {"perItem": a number or "all"}"#,
        ),
        (
            "PlanFinishAct",
            "/act",
            r#"`act` must be "none", "draft-pr", "pr", "fast-forward" or {"other": "what to do"}"#,
        ),
        (
            "PlanConflict",
            "/conflict",
            r#"`conflict` must be "wait" or {"resolver": {harness?, model?, effort?}}"#,
        ),
        (
            "PlanWhenSpent",
            "/cap/whenSpent",
            r#"`whenSpent` must be "hold" or {"to": a node id}"#,
        ),
    ];
    let text = err.to_string();
    if text.contains("missing field `of`") {
        return "a Merger needs `of`, the per-item Ticket node it folds".to_owned();
    }
    if let Some(got @ Value::String(word)) = raw.get("checkpoint")
        && text.contains(&format!("unknown variant `{word}`"))
    {
        return format!(
            r#"`checkpoint` must be "operator" or "steward", not {got}: the engine never answers a checkpoint by itself"#
        );
    }
    SHAPES
        .iter()
        .find(|(name, ..)| text.contains(&format!("untagged enum {name}")))
        .map_or(text, |(_, pointer, shape)| match raw.pointer(pointer) {
            Some(got) => format!("{shape}, not {got}"),
            None => (*shape).to_owned(),
        })
}

fn node_of(file: PlanNodeFile, problems: &mut Vec<PlanProblem>) -> Node {
    let node = |id: String, title: String, x: i32, y: i32, body: NodeBody| Node {
        id: NodeId(id),
        title,
        at: (x, y),
        body,
    };
    match file {
        PlanNodeFile::Conversation(n) => node(
            n.id,
            n.title,
            n.x,
            n.y,
            NodeBody::Conversation(ConversationNode {
                skill: n.skill,
                assign: assign_of(n.assign),
                note: n.note,
            }),
        ),
        PlanNodeFile::Agent(n) => ticket_of(TicketKind::Agent, n, problems),
        PlanNodeFile::Prove(n) => ticket_of(TicketKind::Prove, n, problems),
        PlanNodeFile::Review(n) => ticket_of(TicketKind::Review, n, problems),
        PlanNodeFile::Decide(n) => ticket_of(TicketKind::Decide, n, problems),
        PlanNodeFile::Merger(n) => node(
            n.id,
            n.title,
            n.x,
            n.y,
            NodeBody::Merger(MergerNode {
                of: NodeId(n.of),
                conflict: match n.conflict {
                    None => Conflict::Resolver(Assign::default()),
                    Some(PlanConflict::Wait(_)) => Conflict::Wait,
                    Some(PlanConflict::Resolver(r)) => {
                        Conflict::Resolver(assign_of(Some(r.resolver)))
                    }
                },
            }),
        ),
        PlanNodeFile::Gate(n) => node(
            n.id,
            n.title,
            n.x,
            n.y,
            NodeBody::Gate(GateNode {
                open: match n.open {
                    None | Some(PlanOpener::Operator) => Opener::Operator,
                    Some(PlanOpener::Steward) => Opener::Steward,
                    Some(PlanOpener::Auto) => Opener::Auto,
                },
                join: match n.join {
                    None | Some(PlanJoin::Any) => Join::Any,
                    Some(PlanJoin::All) => Join::All,
                },
            }),
        ),
        PlanNodeFile::Finish(n) => node(
            n.id,
            n.title,
            n.x,
            n.y,
            NodeBody::Finish(FinishNode {
                act: match n.act {
                    None | Some(PlanFinishAct::Named(PlanNamedAct::None)) => FinishAct::None,
                    Some(PlanFinishAct::Named(PlanNamedAct::DraftPr)) => FinishAct::DraftPr,
                    Some(PlanFinishAct::Named(PlanNamedAct::Pr)) => FinishAct::Pr,
                    Some(PlanFinishAct::Named(PlanNamedAct::FastForward)) => FinishAct::FastForward,
                    Some(PlanFinishAct::Other(other)) => FinishAct::Other(other.other),
                },
                assign: assign_of(n.assign),
            }),
        ),
    }
}

fn ticket_of(kind: TicketKind, n: PlanTicketNode, problems: &mut Vec<PlanProblem>) -> Node {
    let copies = match n.copies {
        None | Some(PlanCopies::One(_)) => Copies::One,
        Some(PlanCopies::PerItem(PlanPerItem { per_item })) => Copies::PerItem {
            cap: match per_item {
                PlanCap::All(_) => Cap::All,
                PlanCap::At(max) => NonZeroU32::new(max).map_or_else(
                    || {
                        problems.push(at_node(
                            &n.id,
                            r#"`perItem` must be at least 1, or "all""#.to_owned(),
                        ));
                        // Still per-item, so the Merger rules judge the node as written.
                        Cap::All
                    },
                    Cap::At,
                ),
            },
        },
    };
    Node {
        id: NodeId(n.id),
        title: n.title,
        at: (n.x, n.y),
        body: NodeBody::Ticket(TicketNode {
            kind,
            skill: n.skill,
            assign: assign_of(n.assign),
            copies,
            makes_items: n.makes_items.unwrap_or(false),
            checkpoint: match n.checkpoint {
                None | Some(PlanCheckpoint::Operator) => CheckpointPolicy::Operator,
                Some(PlanCheckpoint::Steward) => CheckpointPolicy::Steward,
            },
            spawns: match n.spawns {
                None | Some(PlanSpawns::Hold) => SpawnPolicy::Hold,
                Some(PlanSpawns::Land) => SpawnPolicy::Land,
            },
            note: n.note,
        }),
    }
}

fn edge_of(e: PlanEdgeFile, problems: &mut Vec<PlanProblem>) -> DraftEdge {
    let cap = e.cap.map(|cap| LoopCap {
        max: NonZeroU32::new(cap.max).unwrap_or_else(|| {
            problems.push(at_edge(
                &e.from,
                &e.on,
                &e.to,
                "a cap's `max` must be at least 1".to_owned(),
            ));
            // Still capped, so the cycle rules judge the edge as written.
            NonZeroU32::MIN
        }),
        steward_extra: cap.steward_extra.unwrap_or(false),
        when_spent: match cap.when_spent {
            None | Some(PlanWhenSpent::Hold(_)) => WhenSpent::Hold,
            Some(PlanWhenSpent::To(to)) => WhenSpent::To(NodeId(to.to)),
        },
    });
    DraftEdge {
        from: NodeId(e.from),
        on: e.on,
        to: NodeId(e.to),
        cap,
    }
}

fn assign_of(file: Option<PlanAssign>) -> Assign {
    file.map_or_else(Assign::default, |a| Assign {
        harness: a.harness,
        model: a.model,
        effort: a.effort,
    })
}

fn assign_file(assign: &Assign) -> Option<PlanAssign> {
    (assign != &Assign::default()).then(|| PlanAssign {
        harness: assign.harness.clone(),
        model: assign.model.clone(),
        effort: assign.effort.clone(),
    })
}

pub(super) fn edit_of(file: &PlanEditFile) -> Result<PlanEdit, Vec<PlanProblem>> {
    let edge = |from: &str, on: &str, to: &str, cap: Option<PlanLoopCap>| {
        edge_read(PlanEdgeFile {
            from: from.to_owned(),
            on: on.to_owned(),
            to: to.to_owned(),
            cap,
        })
    };
    Ok(match file {
        PlanEditFile::AddNode(add) => PlanEdit::AddNode {
            kind: add.kind,
            at: (add.x, add.y),
        },
        PlanEditFile::RemoveNode(remove) => PlanEdit::RemoveNode(NodeId(remove.id.clone())),
        PlanEditFile::SetNode(set) => {
            let mut problems = Vec::new();
            let node = node_of(set.node.clone(), &mut problems);
            if !problems.is_empty() {
                return Err(problems);
            }
            PlanEdit::SetNode {
                id: node.id,
                title: node.title,
                body: node.body,
            }
        }
        PlanEditFile::Link(link) => PlanEdit::Link(edge_read(link.edge.clone())?),
        PlanEditFile::Unlink(key) => PlanEdit::Unlink(edge(&key.from, &key.on, &key.to, None)?.key),
        PlanEditFile::SetCap(set) => {
            let Edge { key, cap } = edge(&set.from, &set.on, &set.to, set.cap.clone())?;
            PlanEdit::SetCap { edge: key, cap }
        }
        PlanEditFile::SetMeta(meta) => PlanEdit::SetMeta(PlanMeta {
            name: meta.name.clone(),
            author: meta.author.clone(),
            source: meta.source.clone(),
            note: meta.note.clone(),
            steward_edits: meta.steward_edits.unwrap_or(false),
        }),
        PlanEditFile::Move(to) => PlanEdit::Move {
            id: NodeId(to.id.clone()),
            at: (to.x, to.y),
        },
    })
}

fn edge_read(file: PlanEdgeFile) -> Result<Edge, Vec<PlanProblem>> {
    let mut problems = Vec::new();
    match edge_of(file, &mut problems).typed() {
        Ok(edge) if problems.is_empty() => Ok(edge),
        Ok(_) => Err(problems),
        Err(problem) => {
            problems.push(problem);
            Err(problems)
        }
    }
}

pub(super) fn to_file(plan: &Plan) -> PlanFile {
    file_of(&plan.meta, plan.nodes(), &plan.edges)
}

pub(super) fn file_of<'a>(
    meta: &PlanMeta,
    nodes: impl Iterator<Item = &'a Node>,
    edges: &[Edge],
) -> PlanFile {
    PlanFile {
        horde: HORDE_VERSION,
        name: meta.name.clone(),
        author: meta.author.clone(),
        source: meta.source.clone(),
        note: meta.note.clone(),
        steward_edits: Some(meta.steward_edits),
        nodes: nodes.map(node_file).collect(),
        edges: edges.iter().map(edge_file).collect(),
    }
}

fn node_file(node: &Node) -> PlanNodeFile {
    let (id, title, (x, y)) = (node.id.0.clone(), node.title.clone(), node.at);
    match &node.body {
        NodeBody::Conversation(c) => PlanNodeFile::Conversation(PlanConversationNode {
            id,
            title,
            x,
            y,
            skill: c.skill.clone(),
            assign: assign_file(&c.assign),
            note: c.note.clone(),
        }),
        NodeBody::Ticket(t) => {
            let file = PlanTicketNode {
                id,
                title,
                x,
                y,
                skill: t.skill.clone(),
                assign: assign_file(&t.assign),
                copies: Some(match t.copies {
                    Copies::One => PlanCopies::One(PlanOneCopy::One),
                    Copies::PerItem { cap } => PlanCopies::PerItem(PlanPerItem {
                        per_item: match cap {
                            Cap::At(max) => PlanCap::At(max.get()),
                            Cap::All => PlanCap::All(AllItems::All),
                        },
                    }),
                }),
                makes_items: Some(t.makes_items),
                checkpoint: Some(match t.checkpoint {
                    CheckpointPolicy::Operator => PlanCheckpoint::Operator,
                    CheckpointPolicy::Steward => PlanCheckpoint::Steward,
                }),
                spawns: Some(match t.spawns {
                    SpawnPolicy::Hold => PlanSpawns::Hold,
                    SpawnPolicy::Land => PlanSpawns::Land,
                }),
                note: t.note.clone(),
            };
            match t.kind {
                TicketKind::Agent => PlanNodeFile::Agent(file),
                TicketKind::Prove => PlanNodeFile::Prove(file),
                TicketKind::Review => PlanNodeFile::Review(file),
                TicketKind::Decide => PlanNodeFile::Decide(file),
            }
        }
        NodeBody::Merger(m) => PlanNodeFile::Merger(PlanMergerNode {
            id,
            title,
            x,
            y,
            of: m.of.0.clone(),
            conflict: Some(match &m.conflict {
                Conflict::Wait => PlanConflict::Wait(PlanWait::Wait),
                Conflict::Resolver(assign) => PlanConflict::Resolver(PlanResolver {
                    resolver: assign_file(assign).unwrap_or(PlanAssign {
                        harness: None,
                        model: None,
                        effort: None,
                    }),
                }),
            }),
        }),
        NodeBody::Gate(g) => PlanNodeFile::Gate(PlanGateNode {
            id,
            title,
            x,
            y,
            open: Some(match g.open {
                Opener::Operator => PlanOpener::Operator,
                Opener::Steward => PlanOpener::Steward,
                Opener::Auto => PlanOpener::Auto,
            }),
            join: Some(match g.join {
                Join::Any => PlanJoin::Any,
                Join::All => PlanJoin::All,
            }),
        }),
        NodeBody::Finish(f) => PlanNodeFile::Finish(PlanFinishNode {
            id,
            title,
            x,
            y,
            act: Some(match &f.act {
                FinishAct::None => PlanFinishAct::Named(PlanNamedAct::None),
                FinishAct::DraftPr => PlanFinishAct::Named(PlanNamedAct::DraftPr),
                FinishAct::Pr => PlanFinishAct::Named(PlanNamedAct::Pr),
                FinishAct::FastForward => PlanFinishAct::Named(PlanNamedAct::FastForward),
                FinishAct::Other(other) => PlanFinishAct::Other(PlanOtherAct {
                    other: other.clone(),
                }),
            }),
            assign: assign_file(&f.assign),
        }),
    }
}

fn edge_file(edge: &Edge) -> PlanEdgeFile {
    PlanEdgeFile {
        from: edge.key.from.0.clone(),
        on: edge.key.on.as_str().to_owned(),
        to: edge.key.to.0.clone(),
        cap: edge.cap.as_ref().map(|cap| PlanLoopCap {
            max: cap.max.get(),
            steward_extra: Some(cap.steward_extra),
            when_spent: Some(match &cap.when_spent {
                WhenSpent::Hold => PlanWhenSpent::Hold(PlanHold::Hold),
                WhenSpent::To(to) => PlanWhenSpent::To(PlanSpentTo { to: to.0.clone() }),
            }),
        }),
    }
}

/// An edge both of whose ends exist, as indices into the draft's nodes.
struct Link {
    /// Its place in the draft's edges.
    at: usize,
    from: usize,
    to: usize,
    /// The verdict is one its from node hands on. An edge whose word is wrong still counts for
    /// reachability and never for cycles, so it is reported once, as that.
    routes: bool,
    capped: bool,
}

/// Every rule, every problem at once, in Plan order: ids, the Finish, Mergers, edges, then the
/// whole graph.
pub(super) fn validate(draft: Draft) -> Result<Plan, Vec<PlanProblem>> {
    let Draft {
        meta,
        nodes,
        edges,
        unread,
        whole,
    } = draft;
    let mut problems = Vec::new();

    let mut index: HashMap<&str, usize> = HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        let id = node.id.as_str();
        if let Err(message) = node_id(id) {
            problems.push(at_node(id, message));
        }
        if index.contains_key(id) {
            problems.push(at_node(id, format!("node id `{id}` appears twice")));
        } else {
            index.insert(id, i);
        }
    }
    let first_of = |i: usize| index.get(nodes[i].id.as_str()) == Some(&i);

    let finishes: Vec<usize> = (0..nodes.len())
        .filter(|&i| matches!(nodes[i].body, NodeBody::Finish(_)))
        .collect();
    let finish = finishes.first().copied();
    if finish.is_none() && whole {
        problems.push(at_plan("a Plan needs one Finish".to_owned()));
    }
    for &extra in finishes.iter().skip(1) {
        let id = nodes[extra].id.as_str();
        problems.push(at_node(
            id,
            format!("a Plan has one Finish, and `{id}` is another"),
        ));
    }

    let mut merger_of: HashMap<usize, usize> = HashMap::new();
    let mut folds: HashMap<usize, usize> = HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        let NodeBody::Merger(merger) = &node.body else {
            continue;
        };
        let (id, of) = (node.id.as_str(), merger.of.as_str());
        match index
            .get(of)
            .copied()
            .filter(|&o| nodes[o].body.is_per_item())
        {
            None if of.is_empty() => problems.push(at_node(
                id,
                format!("Merger `{id}` needs `of`, the per-item Ticket node it folds"),
            )),
            None => problems.push(at_node(
                id,
                format!("Merger `{id}` folds `{of}`, which is not a per-item Ticket node"),
            )),
            Some(o) => match merger_of.get(&o) {
                Some(&first) => problems.push(at_node(
                    id,
                    format!("`{of}` already has a Merger, `{}`", nodes[first].id),
                )),
                None => {
                    merger_of.insert(o, i);
                    folds.insert(i, o);
                }
            },
        }
    }
    // A Merger whose `of` is wrong has no vocabulary, so its edges go unchecked rather than each
    // repeating that one problem.
    let vocabulary = |i: usize| match &nodes[i].body {
        NodeBody::Merger(_) => folds.get(&i).and_then(|&o| nodes[o].body.own_vocabulary()),
        body => body.own_vocabulary(),
    };

    let mut links = Vec::new();
    let mut typed = Vec::new();
    let mut seen = HashSet::new();
    for (k, e) in edges.iter().enumerate() {
        let here = |message: String| at_edge(e.from.as_str(), &e.on, e.to.as_str(), message);
        let from = index.get(e.from.as_str()).copied();
        let to = index.get(e.to.as_str()).copied();
        for (end, found) in [(&e.from, from), (&e.to, to)] {
            if found.is_none() && !unread.iter().any(|id| id == end.as_str()) {
                problems.push(here(format!("there is no node `{end}`")));
            }
        }
        if let Some(LoopCap {
            when_spent: WhenSpent::To(spent),
            ..
        }) = &e.cap
            && !index.contains_key(spent.as_str())
        {
            problems.push(here(format!(
                "`whenSpent` goes to `{spent}`, but there is no node `{spent}`"
            )));
        }
        let verdict = Verdict::parse(&e.on);
        let routes = match (verdict, from.and_then(vocabulary)) {
            (None, _) => {
                problems.push(here(format!("`{}` is not a verdict", e.on)));
                false
            }
            (Some(v), Some(words)) if !words.contains(&v) => {
                let words: Vec<_> = words.iter().map(|w| w.as_str()).collect();
                problems.push(here(format!(
                    "`{}` is not a verdict `{}` hands on: it hands on {}",
                    e.on,
                    e.from,
                    words.join(", ")
                )));
                false
            }
            (Some(_), _) => true,
        };
        if !seen.insert((e.from.as_str(), e.on.as_str(), e.to.as_str())) {
            problems.push(here(format!(
                "the edge `{}.{} -> {}` appears twice",
                e.from, e.on, e.to
            )));
        }
        if let (Some(v), true) = (verdict, routes) {
            typed.push(Edge {
                key: EdgeKey {
                    from: e.from.clone(),
                    on: v,
                    to: e.to.clone(),
                },
                cap: e.cap.clone(),
            });
        }
        let (Some(from), Some(to)) = (from, to) else {
            continue;
        };
        if let Some(&merger) = merger_of.get(&from)
            && to != merger
        {
            problems.push(here(format!(
                "`{}` has a Merger, so this edge must go to its Merger `{}`",
                e.from, nodes[merger].id
            )));
        }
        if let Some(&of) = folds.get(&to)
            && from != of
        {
            problems.push(here(format!(
                "only `{}` hands on to its Merger `{}`",
                nodes[of].id, e.to
            )));
        }
        links.push(Link {
            at: k,
            from,
            to,
            routes,
            capped: e.cap.is_some(),
        });
    }

    // Not whole means a read problem is already reported, so no Plan comes of the empty default.
    let Judged {
        problems: graph_problems,
        entries,
        loops,
    } = if whole {
        Graph::new(&nodes, &edges, &links, finish, vocabulary).judge(&nodes, &edges, first_of)
    } else {
        Judged::default()
    };
    problems.extend(graph_problems);
    if !problems.is_empty() {
        return Err(problems);
    }
    // No problem means every edge routes, so `typed` holds them all, in order.
    let loops = loops
        .into_iter()
        .map(|(k, nested)| {
            (
                typed[k].key.clone(),
                nested.into_iter().map(|n| typed[n].key.clone()).collect(),
            )
        })
        .collect();
    let entries = entries.into_iter().map(|i| nodes[i].id.clone()).collect();
    Ok(Plan {
        meta,
        nodes: nodes.into_iter().map(|n| (n.id.clone(), n)).collect(),
        edges: typed,
        entries,
        loops,
    })
}

/// The draft as arcs between node indices, for the whole-graph rules.
struct Graph<'a> {
    n: usize,
    links: &'a [Link],
    finish: Option<usize>,
    /// `closed` with no edge of its own goes to the Finish.
    defaults: Vec<(usize, usize)>,
    /// Capped edges, and edges leaving a person: an operator or Steward Gate, or the Finish.
    candidates: Vec<bool>,
}

impl<'a> Graph<'a> {
    fn new(
        nodes: &[Node],
        edges: &[DraftEdge],
        links: &'a [Link],
        finish: Option<usize>,
        vocabulary: impl Fn(usize) -> Option<&'static [Verdict]>,
    ) -> Graph<'a> {
        let defaults = finish.map_or_else(Vec::new, |fin| {
            (0..nodes.len())
                .filter(|&i| {
                    vocabulary(i).is_some_and(|words| words.contains(&Verdict::Closed))
                        && !edges
                            .iter()
                            .any(|e| e.from == nodes[i].id && e.on == Verdict::Closed.as_str())
                })
                .map(|i| (i, fin))
                .collect()
        });
        let candidates = links
            .iter()
            .map(|link| {
                link.routes
                    && (link.capped
                        || matches!(
                            nodes[link.from].body,
                            NodeBody::Finish(_)
                                | NodeBody::Gate(GateNode {
                                    open: Opener::Operator | Opener::Steward,
                                    ..
                                })
                        ))
            })
            .collect();
        Graph {
            n: nodes.len(),
            links,
            finish,
            defaults,
            candidates,
        }
    }

    /// Reflexive reachability over the links `keep` admits, plus the `closed` defaults.
    fn closure(&self, keep: impl Fn(usize, &Link) -> bool) -> Vec<Vec<bool>> {
        let mut out = vec![Vec::new(); self.n];
        let arcs = self
            .links
            .iter()
            .enumerate()
            .filter(|(j, link)| keep(*j, link))
            .map(|(_, link)| (link.from, link.to));
        for (a, b) in arcs.chain(self.defaults.iter().copied()) {
            out[a].push(b);
        }
        (0..self.n)
            .map(|start| {
                let mut seen = vec![false; self.n];
                seen[start] = true;
                let mut stack = vec![start];
                while let Some(at) = stack.pop() {
                    for &next in &out[at] {
                        if !seen[next] {
                            seen[next] = true;
                            stack.push(next);
                        }
                    }
                }
                seen
            })
            .collect()
    }

    /// The cycle, cap, entry and reachability rules.
    fn judge(
        &self,
        nodes: &[Node],
        edges: &[DraftEdge],
        first_of: impl Fn(usize) -> bool,
    ) -> Judged {
        let mut problems = Vec::new();
        let mut loops = IndexMap::new();
        let at = |link: &Link, message: String| {
            let e = &edges[link.at];
            at_edge(e.from.as_str(), &e.on, e.to.as_str(), message)
        };

        let rest = self.closure(|j, link| link.routes && !self.candidates[j]);
        let mut placed = vec![false; self.n];
        for i in 0..self.n {
            if placed[i] {
                continue;
            }
            let cycle: Vec<usize> = (0..self.n).filter(|&j| rest[i][j] && rest[j][i]).collect();
            let looped = |link: &Link| cycle.contains(&link.from) && cycle.contains(&link.to);
            let first = self
                .links
                .iter()
                .enumerate()
                .find(|(j, link)| link.routes && !self.candidates[*j] && looped(link));
            // A lone node is a cycle only through a self-edge, which `first` is then.
            let Some((_, first)) = first else {
                continue;
            };
            for &j in &cycle {
                placed[j] = true;
            }
            let names: Vec<_> = cycle
                .iter()
                .map(|&j| format!("`{}`", nodes[j].id))
                .collect();
            problems.push(at(
                first,
                format!(
                    "the cycle through {} holds no loop edge: cap an edge on it, or route it through an operator or Steward Gate",
                    names.join(", ")
                ),
            ));
        }

        let full = self.closure(|_, link| link.routes);
        let is_loop: Vec<bool> = self
            .links
            .iter()
            .enumerate()
            .map(|(j, link)| self.candidates[j] && full[link.to][link.from])
            .collect();
        for (j, link) in self.links.iter().enumerate() {
            if link.capped && link.routes && !is_loop[j] {
                problems.push(at(
                    link,
                    "this edge is capped but closes no cycle".to_owned(),
                ));
            }
        }
        // In a valid Plan `plain` is acyclic, so two loops contain each other only when they share
        // both ends. Such a pair runs the same cycle side by side: neither is nested, or each
        // traversal would reset the other and neither cap would ever be spent.
        let plain = self.closure(|j, link| link.routes && !is_loop[j]);
        for (_, link) in self.links.iter().enumerate().filter(|(j, _)| is_loop[*j]) {
            let nested = self
                .links
                .iter()
                .enumerate()
                .filter(|(m, inner)| {
                    (inner.from, inner.to) != (link.from, link.to)
                        && is_loop[*m]
                        && inner.capped
                        && plain[link.to][inner.to]
                        && plain[inner.from][link.from]
                })
                .map(|(_, inner)| inner.at)
                .collect();
            loops.insert(link.at, nested);
        }

        let entries: Vec<usize> = (0..self.n)
            .filter(|&i| {
                first_of(i)
                    && !matches!(nodes[i].body, NodeBody::Finish(_) | NodeBody::Merger(_))
                    && !self
                        .links
                        .iter()
                        .enumerate()
                        .any(|(j, link)| link.to == i && !is_loop[j])
            })
            .collect();
        let every = self.closure(|_, _| true);
        if entries.is_empty() {
            problems.push(at_plan(
                "the Plan has no entry: every node has an incoming edge that is not a loop edge"
                    .to_owned(),
            ));
        } else {
            for i in (0..self.n).filter(|&i| first_of(i)) {
                if !entries.iter().any(|&e| every[e][i]) {
                    let id = nodes[i].id.as_str();
                    problems.push(at_node(id, format!("`{id}` is not reached from an entry")));
                }
            }
        }
        if let Some(fin) = self.finish {
            for i in (0..self.n).filter(|&i| first_of(i)) {
                if !every[i][fin] {
                    let id = nodes[i].id.as_str();
                    problems.push(at_node(id, format!("`{id}` cannot reach the Finish")));
                }
            }
        }
        Judged {
            problems,
            entries,
            loops,
        }
    }
}

/// What the whole-graph rules found, and what they derive for the Plan a valid draft becomes, as
/// indices into the draft's nodes and edges.
#[derive(Default)]
struct Judged {
    problems: Vec<PlanProblem>,
    entries: Vec<usize>,
    loops: IndexMap<usize, Vec<usize>>,
}
