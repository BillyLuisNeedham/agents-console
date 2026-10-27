use super::parse::{
    Draft, DraftEdge, LosslessDraft, at_edge, at_node, file_of, read_lossless, validate,
};
use super::*;

pub(super) fn apply(plan: &Plan, edits: &[PlanEdit]) -> Result<Edited, Vec<PlanProblem>> {
    let Editing {
        meta,
        nodes,
        edges,
        notes,
        moved,
        mut problems,
    } = Editing::from_plan(plan).run(edits);
    let checked = validate(Draft {
        meta,
        nodes,
        edges: edges.into_iter().map(DraftEdge::from).collect(),
        unread: Vec::new(),
        whole: true,
    });
    match checked {
        Ok(plan) if problems.is_empty() => Ok(Edited { plan, notes, moved }),
        Ok(_) => Err(problems),
        Err(more) => {
            problems.extend(more);
            Err(problems)
        }
    }
}

pub(super) fn draft(value: &Value, edits: &[PlanEdit]) -> Result<DraftEdited, Vec<PlanProblem>> {
    let Editing {
        meta,
        nodes,
        edges,
        notes,
        problems,
        ..
    } = Editing::from_draft(read_lossless(value)?).run(edits);
    if !problems.is_empty() {
        return Err(problems);
    }
    let file = file_of(&meta, nodes.iter(), &edges);
    let find = |id: &NodeId| nodes.iter().find(|node| &node.id == id);
    Ok(DraftEdited {
        problems: Plan::check(&serde_json::to_value(&file).expect("a Plan file serializes")),
        file,
        notes,
        verdicts: nodes
            .iter()
            .map(|node| (node.id.as_str().to_owned(), node.body.vocabulary(find)))
            .collect(),
    })
}

struct Editing {
    meta: PlanMeta,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    notes: Vec<String>,
    moved: Vec<(EdgeKey, EdgeKey)>,
    problems: Vec<PlanProblem>,
}

/// The cap a Link gets when it closes a cycle with no loop edge and names no cap of its own.
const LOOP_CAP: u32 = 2;

fn edges_word(n: usize) -> String {
    if n == 1 {
        "1 edge".to_owned()
    } else {
        format!("{n} edges")
    }
}

impl Editing {
    fn from_plan(plan: &Plan) -> Editing {
        Editing::from_draft(LosslessDraft {
            meta: plan.meta.clone(),
            nodes: plan.nodes().cloned().collect(),
            edges: plan.edges.clone(),
        })
    }

    fn from_draft(draft: LosslessDraft) -> Editing {
        Editing {
            meta: draft.meta,
            nodes: draft.nodes,
            edges: draft.edges,
            notes: Vec::new(),
            moved: Vec::new(),
            problems: Vec::new(),
        }
    }

    fn run(mut self, edits: &[PlanEdit]) -> Editing {
        for edit in edits {
            self.apply(edit);
        }
        self
    }

    fn apply(&mut self, edit: &PlanEdit) {
        match edit {
            PlanEdit::AddNode { kind, at } => {
                let id = std::iter::once(kind.as_str().to_owned())
                    .chain((2..).map(|n| format!("{}-{}", kind.as_str(), letter_suffix(n))))
                    .map(NodeId)
                    .find(|id| self.position(id).is_none())
                    .expect("the names never run out");
                self.nodes.push(new_node(*kind, id, *at));
            }
            PlanEdit::RemoveNode(id) => {
                let Some(at) = self.position(id) else {
                    return self.no_node(id);
                };
                if let NodeBody::Merger(merger) = &self.nodes[at].body {
                    let of = merger.of.clone();
                    let moved = self.lift(id);
                    self.notes.push(format!(
                        "removed `{id}`, so each copy of `{of}` hands on alone: moved {} back onto it",
                        edges_word(moved)
                    ));
                    return;
                }
                let merger = self.merger_of(id);
                self.drop_node(id);
                if let Some(merger) = merger {
                    self.drop_node(&merger);
                    self.notes.push(format!("removed `{merger}` with `{id}`"));
                }
            }
            PlanEdit::SetNode { id, title, body } => {
                let Some(at) = self.position(id) else {
                    return self.no_node(id);
                };
                let (was, now) = (self.nodes[at].body.kind(), body.kind());
                if was != now {
                    return self.node_problem(
                        id,
                        format!(
                            "`{id}` is a {was} node, and an edit never changes a node's kind: remove it and add a {now} node"
                        ),
                    );
                }
                self.nodes[at].title = title.clone();
                self.nodes[at].body = body.clone();
                match (body.is_per_item(), self.merger_of(id)) {
                    (true, None) => self.place_merger(id),
                    (false, Some(merger)) => {
                        let moved = self.lift(&merger);
                        self.notes.push(format!(
                            "`{id}` is one copy now: lifted `{merger}` and moved {} back onto it",
                            edges_word(moved)
                        ));
                    }
                    _ => {}
                }
            }
            PlanEdit::Link(edge) => {
                let mut edge = edge.clone();
                if let Some(merger) = self.merger_of(&edge.key.from)
                    && edge.key.to != merger
                {
                    self.notes.push(format!(
                        "linked from `{merger}`, since `{}` hands on through its Merger",
                        edge.key.from
                    ));
                    edge.key.from = merger;
                }
                if edge.cap.is_none() && self.closes_bare_cycle(&edge.key) {
                    let EdgeKey { from, on, to } = &edge.key;
                    self.notes.push(format!(
                        "`{from}.{} -> {to}` closes a cycle, so it is a loop capped at {LOOP_CAP} passes that holds when spent",
                        on.as_str()
                    ));
                    edge.cap = Some(LoopCap {
                        max: NonZeroU32::new(LOOP_CAP).expect("the default cap is not 0"),
                        steward_extra: false,
                        when_spent: WhenSpent::Hold,
                    });
                }
                self.edges.push(edge);
            }
            PlanEdit::Unlink(key) => match self.edge(key) {
                Some(at) => {
                    self.edges.remove(at);
                }
                None => self.no_edge(key),
            },
            PlanEdit::SetCap { edge, cap } => match self.edge(edge) {
                Some(at) => self.edges[at].cap = cap.clone(),
                None => self.no_edge(edge),
            },
            PlanEdit::SetMeta(meta) => self.meta = meta.clone(),
            PlanEdit::Move { id, at } => match self.position(id) {
                Some(i) => self.nodes[i].at = *at,
                None => self.no_node(id),
            },
        }
    }

    fn position(&self, id: &NodeId) -> Option<usize> {
        self.nodes.iter().position(|node| &node.id == id)
    }

    fn edge(&self, key: &EdgeKey) -> Option<usize> {
        self.edges.iter().position(|edge| &edge.key == key)
    }

    fn merger_of(&self, id: &NodeId) -> Option<NodeId> {
        self.nodes
            .iter()
            .find(|n| matches!(&n.body, NodeBody::Merger(merger) if &merger.of == id))
            .map(|n| n.id.clone())
    }

    /// Whether `key` would close a cycle that holds no loop edge: its `to` already reaches its
    /// `from` over edges that route, none capped and none leaving an operator or Steward Gate or
    /// the Finish, and it leaves no such node itself.
    fn closes_bare_cycle(&self, key: &EdgeKey) -> bool {
        let find = |id: &NodeId| self.nodes.iter().find(|node| &node.id == id);
        let bare = |from: &NodeId, on: Verdict| {
            find(from).is_some_and(|node| {
                node.body.vocabulary(find).contains(&on) && !node.body.leaves_a_person()
            })
        };
        if !bare(&key.from, key.on) {
            return false;
        }
        let mut seen = vec![&key.to];
        let mut stack = vec![&key.to];
        while let Some(at) = stack.pop() {
            if at == &key.from {
                return true;
            }
            for edge in &self.edges {
                let next = &edge.key.to;
                if &edge.key.from == at
                    && edge.cap.is_none()
                    && bare(at, edge.key.on)
                    && !seen.contains(&next)
                {
                    seen.push(next);
                    stack.push(next);
                }
            }
        }
        false
    }

    fn node_problem(&mut self, id: &NodeId, message: String) {
        self.problems.push(at_node(id.as_str(), message));
    }

    fn no_node(&mut self, id: &NodeId) {
        self.node_problem(id, format!("there is no node `{id}`"));
    }

    fn no_edge(&mut self, key: &EdgeKey) {
        let (from, on, to) = (key.from.as_str(), key.on.as_str(), key.to.as_str());
        self.problems.push(at_edge(
            from,
            on,
            to,
            format!("there is no edge `{from}.{on} -> {to}`"),
        ));
    }

    fn drop_node(&mut self, id: &NodeId) {
        self.nodes.retain(|node| &node.id != id);
        self.edges
            .retain(|edge| &edge.key.from != id && &edge.key.to != id);
    }

    /// `<id>-merge`, right after a node that became per-item, with the node's out-edges on it.
    fn place_merger(&mut self, id: &NodeId) {
        if self.merger_of(id).is_some() {
            return;
        }
        let Some(at) = self.position(id) else {
            return;
        };
        let node = &self.nodes[at];
        let merger = NodeId(format!("{id}-merge"));
        let placed = Node {
            id: merger.clone(),
            title: format!("Merge {}", node.title),
            at: (node.at.0, node.at.1 + 250),
            body: NodeBody::Merger(MergerNode {
                of: id.clone(),
                conflict: Conflict::Resolver(Assign::default()),
            }),
        };
        self.nodes.insert(at + 1, placed);
        let moved = self.move_onto_merger(id, &merger);
        self.notes.push(format!(
            "`{id}` is per-item now: placed `{merger}` and moved {} onto it",
            edges_word(moved)
        ));
    }

    /// Every `id.v -> t` becomes `merger.v -> t`, and `id.v -> merger` is linked for each verdict
    /// moved, or for the node's first verdict when nothing moved.
    fn move_onto_merger(&mut self, id: &NodeId, merger: &NodeId) -> usize {
        let mut verdicts = Vec::new();
        let mut moved = 0;
        for edge in &mut self.edges {
            if &edge.key.from == id && &edge.key.to != merger {
                let was = edge.key.clone();
                edge.key.from = merger.clone();
                self.moved.push((was, edge.key.clone()));
                moved += 1;
                if !verdicts.contains(&edge.key.on) {
                    verdicts.push(edge.key.on);
                }
            }
        }
        if verdicts.is_empty() {
            let first = self.position(id).and_then(|at| {
                self.nodes[at]
                    .body
                    .own_vocabulary()
                    .and_then(|words| words.first().copied())
            });
            verdicts.extend(first);
        }
        for on in verdicts {
            let key = EdgeKey {
                from: id.clone(),
                on,
                to: merger.clone(),
            };
            if self.edge(&key).is_none() {
                self.edges.push(Edge { key, cap: None });
            }
        }
        moved
    }

    /// Remove a Merger: the edges into it go, and every `merger.v -> t` becomes `of.v -> t`.
    fn lift(&mut self, merger: &NodeId) -> usize {
        let Some(at) = self.position(merger) else {
            return 0;
        };
        let NodeBody::Merger(MergerNode { of, .. }) = self.nodes.remove(at).body else {
            return 0;
        };
        self.edges.retain(|edge| &edge.key.to != merger);
        let mut moved = 0;
        for edge in &mut self.edges {
            if &edge.key.from == merger {
                let was = edge.key.clone();
                edge.key.from = of.clone();
                self.moved.push((was, edge.key.clone()));
                moved += 1;
            }
        }
        moved
    }
}

fn new_node(kind: PlanNodeKind, id: NodeId, at: (i32, i32)) -> Node {
    let ticket = |kind: TicketKind| {
        NodeBody::Ticket(TicketNode {
            kind,
            skill: None,
            assign: Assign::default(),
            copies: Copies::One,
            makes_items: false,
            checkpoint: CheckpointPolicy::Operator,
            spawns: SpawnPolicy::Hold,
            note: None,
        })
    };
    let (title, body) = match kind {
        PlanNodeKind::Conversation => (
            "Conversation",
            NodeBody::Conversation(ConversationNode::default()),
        ),
        PlanNodeKind::Agent => ("Agent", ticket(TicketKind::Agent)),
        PlanNodeKind::Prove => ("Prove", ticket(TicketKind::Prove)),
        PlanNodeKind::Review => ("Review", ticket(TicketKind::Review)),
        PlanNodeKind::Decide => ("Decide", ticket(TicketKind::Decide)),
        PlanNodeKind::Gate => (
            "Gate",
            NodeBody::Gate(GateNode {
                open: Opener::Operator,
                join: Join::Any,
            }),
        ),
        PlanNodeKind::Finish => (
            "Finish",
            NodeBody::Finish(FinishNode {
                act: FinishAct::None,
                assign: Assign::default(),
            }),
        ),
    };
    Node {
        id,
        title: title.to_owned(),
        at,
        body,
    }
}

fn letter_suffix(mut n: usize) -> String {
    let mut out = Vec::new();
    while n > 0 {
        n -= 1;
        out.push(b'a' + (n % 26) as u8);
        n /= 26;
    }
    out.reverse();
    String::from_utf8(out).expect("ASCII letters")
}
