//! `Plan::edit`: typed edits that keep Mergers in step, validated whole after.

use super::parse::{Draft, DraftEdge, at_edge, at_node, validate};
use super::*;

pub(super) fn apply(plan: &Plan, edits: &[PlanEdit]) -> Result<Edited, Vec<PlanProblem>> {
    let mut draft = Editing {
        meta: plan.meta.clone(),
        nodes: plan.nodes().cloned().collect(),
        edges: plan.edges.clone(),
        notes: Vec::new(),
        problems: Vec::new(),
    };
    for edit in edits {
        draft.apply(edit);
    }
    let Editing {
        meta,
        nodes,
        edges,
        notes,
        mut problems,
    } = draft;
    let checked = validate(Draft {
        meta,
        nodes,
        edges: edges.into_iter().map(DraftEdge::from).collect(),
        unread: Vec::new(),
        whole: true,
    });
    match checked {
        Ok(plan) if problems.is_empty() => Ok(Edited { plan, notes }),
        Ok(_) => Err(problems),
        Err(more) => {
            problems.extend(more);
            Err(problems)
        }
    }
}

struct Editing {
    meta: PlanMeta,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    notes: Vec<String>,
    problems: Vec<PlanProblem>,
}

fn edges_word(n: usize) -> String {
    if n == 1 {
        "1 edge".to_owned()
    } else {
        format!("{n} edges")
    }
}

impl Editing {
    fn apply(&mut self, edit: &PlanEdit) {
        match edit {
            PlanEdit::AddNode(node) => {
                if self.position(&node.id).is_some() {
                    self.node_problem(&node.id, format!("there is already a node `{}`", node.id));
                    return;
                }
                self.nodes.push(node.clone());
                match &node.body {
                    NodeBody::Merger(merger) => self.opt_in(&node.id, &merger.of),
                    body if body.is_per_item() => self.place_merger(&node.id),
                    _ => {}
                }
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

    /// A Merger added by hand for a per-item node takes its out-edges, unless the node has another.
    fn opt_in(&mut self, merger: &NodeId, of: &NodeId) {
        let per_item = self
            .position(of)
            .is_some_and(|at| self.nodes[at].body.is_per_item());
        if !per_item || self.merger_of(of).as_ref() != Some(merger) {
            return;
        }
        let moved = self.move_onto_merger(of, merger);
        self.notes.push(format!(
            "`{merger}` folds `{of}` again: moved {} onto it",
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
                edge.key.from = merger.clone();
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
                edge.key.from = of.clone();
                moved += 1;
            }
        }
        moved
    }
}
