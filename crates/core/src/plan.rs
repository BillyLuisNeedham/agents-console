//! The Plan (ADR-0040): the graph of nodes and edges a Line runs, its file format, its validation, its
//! typed edits, the compiled-in Presets and the machine's Plan library.
//!
//! Nothing outside this module builds a `Plan`. `Plan::parse` (a file, a request body, a Line's frozen
//! copy) and `Plan::edit` (typed edits on a valid Plan) are the only constructors, and both end in the
//! same `validate`, so there is one set of rules. Every problem is reported at once, each on the node
//! or edge the editor marks. The file's serde shape is `ac_protocol::wire::PlanFile`.
//!
//! A node's kind fixes its verdicts, so an edge's `on` is checked here and the run core never meets an
//! unknown verdict. Every node whose verdicts include `closed` sends a `closed` with no edge of its own
//! to the Finish. A loop edge is an edge that closes a cycle and is either capped or leaves a person
//! (an operator or Steward Gate, or the Finish's `revise`); every cycle must hold one. Traversing a
//! loop edge resets the capped loops nested inside its cycle.

use std::num::NonZeroU32;

use ac_protocol::wire::{PlanEditFile, PlanFile, PlanNodeKind, PlanProblem};
use indexmap::IndexMap;
use serde_json::Value;

mod edit;
pub mod library;
mod parse;
mod presets;
mod skills;
#[cfg(test)]
mod tests;

pub use presets::{PRESETS, Preset};
pub use skills::SkillCheck;

/// The `horde` tag this build reads and writes. Bumped when a rule breaks old files.
pub const HORDE_VERSION: u32 = 1;

// -------------------------------------------------------------------------------------------------
// Identity
// -------------------------------------------------------------------------------------------------

/// `[a-z][a-z0-9-]{0,39}`, not ending in `-<digits>` (Ticket ids append `-<pass>`), and none of the
/// reserved words `plan`, `line`, `spawn`, `grader`, `enlist`. Parsed once, so a `NodeId` is always
/// a valid Ticket-id prefix and branch-name fragment.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId(String);

impl NodeId {
    /// The id, or why it cannot be one.
    pub fn parse(raw: &str) -> Result<NodeId, String> {
        parse::node_id(raw)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for NodeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Verdict {
    Done,
    Pass,
    Fail,
    Clean,
    Findings,
    Ship,
    AnotherRound,
    /// A Gate opened.
    Open,
    /// A Gate or the Finish was Resumed with notes, which ride on the handoff.
    Revise,
    /// A Ticket, a Conversation or a hold was Closed.
    Closed,
}

impl Verdict {
    pub const ALL: [Verdict; 10] = [
        Verdict::Done,
        Verdict::Pass,
        Verdict::Fail,
        Verdict::Clean,
        Verdict::Findings,
        Verdict::Ship,
        Verdict::AnotherRound,
        Verdict::Open,
        Verdict::Revise,
        Verdict::Closed,
    ];

    /// The word a file and an Outcome spell it with: `done`, `another-round`, ...
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Done => "done",
            Verdict::Pass => "pass",
            Verdict::Fail => "fail",
            Verdict::Clean => "clean",
            Verdict::Findings => "findings",
            Verdict::Ship => "ship",
            Verdict::AnotherRound => "another-round",
            Verdict::Open => "open",
            Verdict::Revise => "revise",
            Verdict::Closed => "closed",
        }
    }

    pub fn parse(word: &str) -> Option<Verdict> {
        Verdict::ALL.into_iter().find(|v| v.as_str() == word)
    }
}

/// `(from, on, to)` is unique in a Plan, so it names an edge in run state and on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EdgeKey {
    pub from: NodeId,
    pub on: Verdict,
    pub to: NodeId,
}

/// `from.on -> to`, as refusals and Ticket texts name an edge.
impl std::fmt::Display for EdgeKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{} -> {}", self.from, self.on.as_str(), self.to)
    }
}

// -------------------------------------------------------------------------------------------------
// The Plan
// -------------------------------------------------------------------------------------------------

/// A valid Plan. Read through accessors, change through `edit`.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    meta: PlanMeta,
    /// File order. The Console lays nodes out by `at`; the engine ignores it.
    nodes: IndexMap<NodeId, Node>,
    edges: Vec<Edge>,
    /// Derived: the nodes a Line starts at, those with no incoming edge but loop edges. Never the
    /// Finish or a Merger. Non-empty.
    entries: Vec<NodeId>,
    /// Derived: every loop edge, with the capped edges nested inside the cycle it closes.
    loops: IndexMap<EdgeKey, Vec<EdgeKey>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PlanMeta {
    pub name: String,
    pub author: Option<String>,
    /// The author's own file the flow comes from. Every Preset has one.
    pub source: Option<String>,
    /// One or two sentences: what is distinctive, and what the graph cannot say.
    pub note: Option<String>,
    /// The Steward may edit a Line running this Plan.
    pub steward_edits: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub id: NodeId,
    pub title: String,
    pub at: (i32, i32),
    pub body: NodeBody,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NodeBody {
    /// Opens a Conversation per pass: `done` with the Line brief it committed, or `closed`.
    Conversation(ConversationNode),
    /// One Ticket per pass, or one per item.
    Ticket(TicketNode),
    /// The fan-in of one per-item Ticket node. Runs no agent.
    Merger(MergerNode),
    /// Runs no agent. Opened by the operator, the Steward, or at once.
    Gate(GateNode),
    /// Exactly one per Plan.
    Finish(FinishNode),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ConversationNode {
    pub skill: Option<String>,
    pub assign: Assign,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TicketNode {
    pub kind: TicketKind,
    pub skill: Option<String>,
    pub assign: Assign,
    pub copies: Copies,
    /// Taught to return `items: [{title, body}]` in its Outcome.
    pub makes_items: bool,
    pub checkpoint: CheckpointPolicy,
    pub spawns: SpawnPolicy,
    /// Added to every Ticket body this node writes.
    pub note: Option<String>,
}

/// Fixes the verdict vocabulary. Closed on purpose: a new kind is a new verdict schema in the
/// Outcome check, not Plan data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketKind {
    /// `done`.
    Agent,
    /// `pass | fail`.
    Prove,
    /// `clean | findings`.
    Review,
    /// `ship | another-round`; writes the report.
    Decide,
}

/// Harness, model and effort. An empty field falls through to the pool defaults when the Ticket is
/// written. Harness names are checked against the machine by the engine, never here.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Assign {
    pub harness: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Copies {
    One,
    /// One copy per item handed in, at most `cap` live at once. Never best-of-N.
    PerItem {
        cap: Cap,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cap {
    At(NonZeroU32),
    All,
}

/// Who answers a checkpoint this node's Tickets raise.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CheckpointPolicy {
    Operator,
    Steward,
}

/// What happens to the Spawns this node's Tickets propose. `Hold` is ADR-0037's rule.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SpawnPolicy {
    Hold,
    Land,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergerNode {
    /// The per-item Ticket node this Merger folds.
    pub of: NodeId,
    pub conflict: Conflict,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Conflict {
    /// A resolver on this Assignment; empty fields fall through to console.json's `resolver`, then
    /// the pool defaults.
    Resolver(Assign),
    /// A merge-conflict Interrupt for the operator.
    Wait,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GateNode {
    pub open: Opener,
    pub join: Join,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Opener {
    Operator,
    Steward,
    /// No hold: the Gate hands on `open` at once.
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Join {
    Any,
    /// Waits for a handoff on every incoming edge.
    All,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FinishNode {
    pub act: FinishAct,
    pub assign: Assign,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinishAct {
    /// Approval ends the Line; no Finish Ticket is written.
    None,
    DraftPr,
    Pr,
    /// Fast-forward the Line base to the Line's branch. Never a force.
    FastForward,
    /// Carried out as written by the Finish Ticket's agent.
    Other(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Edge {
    pub key: EdgeKey,
    /// Present on a capped loop edge.
    pub cap: Option<LoopCap>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoopCap {
    pub max: NonZeroU32,
    /// The Steward may answer this loop's spent hold once per reset.
    pub steward_extra: bool,
    pub when_spent: WhenSpent,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WhenSpent {
    /// A loop hold: Resume buys one more traversal, Close hands on `closed`.
    Hold,
    /// The handoff goes to this node instead, with a note that the loop was spent.
    To(NodeId),
}

impl NodeBody {
    /// The verdicts an edge out of this node may route on. A Merger hands on its `of` node's, so it
    /// needs the Plan to answer; `Plan::vocabulary` does.
    pub fn own_vocabulary(&self) -> Option<&'static [Verdict]> {
        use Verdict::*;
        Some(match self {
            NodeBody::Conversation(_) => &[Done, Closed],
            NodeBody::Ticket(ticket) => match ticket.kind {
                TicketKind::Agent => &[Done, Closed],
                TicketKind::Prove => &[Pass, Fail, Closed],
                TicketKind::Review => &[Clean, Findings, Closed],
                TicketKind::Decide => &[Ship, AnotherRound, Closed],
            },
            NodeBody::Merger(_) => return None,
            NodeBody::Gate(gate) => match gate.open {
                Opener::Operator | Opener::Steward => &[Open, Revise, Closed],
                Opener::Auto => &[Open],
            },
            NodeBody::Finish(_) => &[Revise],
        })
    }

    fn vocabulary<'a>(&self, node: impl Fn(&NodeId) -> Option<&'a Node>) -> &'static [Verdict] {
        let body = match self {
            NodeBody::Merger(merger) => node(&merger.of).map(|of| &of.body),
            body => Some(body),
        };
        body.and_then(NodeBody::own_vocabulary).unwrap_or(&[])
    }

    /// An operator or Steward Gate, or the Finish: an edge out of it closes a cycle as a loop edge
    /// with no cap, since a person answers before it is crossed.
    fn leaves_a_person(&self) -> bool {
        matches!(
            self,
            NodeBody::Finish(_)
                | NodeBody::Gate(GateNode {
                    open: Opener::Operator | Opener::Steward,
                    ..
                })
        )
    }

    fn kind(&self) -> &'static str {
        match self {
            NodeBody::Conversation(_) => "conversation",
            NodeBody::Ticket(ticket) => match ticket.kind {
                TicketKind::Agent => "agent",
                TicketKind::Prove => "prove",
                TicketKind::Review => "review",
                TicketKind::Decide => "decide",
            },
            NodeBody::Merger(_) => "merger",
            NodeBody::Gate(_) => "gate",
            NodeBody::Finish(_) => "finish",
        }
    }

    fn is_per_item(&self) -> bool {
        matches!(
            self,
            NodeBody::Ticket(TicketNode {
                copies: Copies::PerItem { .. },
                ..
            })
        )
    }
}

impl Plan {
    /// Parse a Plan file's text and validate it. Every problem is reported, not only the first.
    pub fn parse(json: &str) -> Result<Plan, Vec<PlanProblem>> {
        match serde_json::from_str(json) {
            Ok(value) => Plan::from_value(&value),
            Err(err) => Err(vec![parse::at_plan(format!("the Plan is not JSON: {err}"))]),
        }
    }

    /// Parse a Plan file already read as JSON: a request body, a socket payload.
    pub fn from_value(value: &Value) -> Result<Plan, Vec<PlanProblem>> {
        parse::from_value(value)
    }

    /// What `plans.validate` answers: every problem, none when the Plan is valid.
    pub fn check(value: &Value) -> Vec<PlanProblem> {
        Plan::from_value(value).err().unwrap_or_default()
    }

    /// The file shape, every policy field written out, for the library, `line.json` and the wire.
    pub fn to_file(&self) -> PlanFile {
        parse::to_file(self)
    }

    /// Canonical file text: `to_file`, pretty, with a trailing newline.
    pub fn to_json(&self) -> String {
        format!("{}\n", crate::js::to_json_pretty(&self.to_file()))
    }

    /// Apply typed edits in order, then validate the result whole with the same rules as `parse`.
    /// Mergers are kept in step, and each move is reported in `Edited::notes`.
    pub fn edit(&self, edits: &[PlanEdit]) -> Result<Edited, Vec<PlanProblem>> {
        edit::apply(self, edits)
    }

    /// Apply typed edits to a draft that need not be valid, keeping Mergers in step as `edit` does,
    /// and answer the file it becomes with everything wrong with it. A batch is all or none: an edit
    /// that names no node or edge, or a kind change, refuses it. So does a draft `read` could not
    /// take in whole as written (an unreadable node, an unknown or mistyped field, an `on` that is no
    /// verdict, a 0 cap), since editing it would drop or rewrite what someone wrote. A missing `name`
    /// is no refusal: the file keeps reporting it.
    pub fn edit_draft(draft: &Value, edits: &[PlanEdit]) -> Result<DraftEdited, Vec<PlanProblem>> {
        edit::draft(draft, edits)
    }

    pub fn meta(&self) -> &PlanMeta {
        &self.meta
    }

    pub fn node(&self, id: &NodeId) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    pub fn edges(&self) -> &[Edge] {
        &self.edges
    }

    pub fn entries(&self) -> &[NodeId] {
        &self.entries
    }

    /// The one Finish node.
    pub fn finish(&self) -> &NodeId {
        self.nodes()
            .find(|node| matches!(node.body, NodeBody::Finish(_)))
            .map(|node| &node.id)
            .expect("validate admits only a Plan with one Finish")
    }

    /// The verdicts an edge out of `node` may route on.
    pub fn vocabulary(&self, node: &NodeId) -> &'static [Verdict] {
        self.node(node)
            .map_or(&[], |node| node.body.vocabulary(|id| self.node(id)))
    }

    /// Every edge out of `from` on `on`, in Plan order. A verdict fans out to all of them.
    pub fn out(&self, from: &NodeId, on: Verdict) -> impl Iterator<Item = &Edge> {
        let from = from.clone();
        self.edges
            .iter()
            .filter(move |e| e.key.from == from && e.key.on == on)
    }

    pub fn incoming(&self, to: &NodeId) -> impl Iterator<Item = &Edge> {
        let to = to.clone();
        self.edges.iter().filter(move |e| e.key.to == to)
    }

    pub fn is_loop(&self, edge: &EdgeKey) -> bool {
        self.loops.contains_key(edge)
    }

    /// The capped loops whose counts reset when `edge` is traversed.
    pub fn nested_loops(&self, edge: &EdgeKey) -> &[EdgeKey] {
        self.loops.get(edge).map_or(&[], Vec::as_slice)
    }

    /// The Merger folding `node`, if it has one.
    pub fn merger_of(&self, node: &NodeId) -> Option<&NodeId> {
        self.nodes()
            .find(|n| matches!(&n.body, NodeBody::Merger(merger) if &merger.of == node))
            .map(|n| &n.id)
    }

    /// The conflict policy for a Ticket this node writes: its Merger's, or `None` for the pool's own
    /// `resolver` setting.
    pub fn conflict_for(&self, node: &NodeId) -> Option<&Conflict> {
        match &self.node(self.merger_of(node)?)?.body {
            NodeBody::Merger(merger) => Some(&merger.conflict),
            _ => None,
        }
    }
}

/// A valid Plan after edits, and what the edits moved on their own (a Merger placed or lifted, a
/// Link made from a Merger).
#[derive(Debug, Clone, PartialEq)]
pub struct Edited {
    pub plan: Plan,
    pub notes: Vec<String>,
    /// Each edge a Merger move rekeyed, old key then new, in the order the edits moved them.
    pub moved: Vec<(EdgeKey, EdgeKey)>,
}

/// A draft after edits: not a `Plan`, since it may be invalid, which is an editor's usual state.
#[derive(Debug, Clone, PartialEq)]
pub struct DraftEdited {
    pub file: PlanFile,
    /// `Plan::check` of `file`, so they are always what `plans.validate` says of it.
    pub problems: Vec<PlanProblem>,
    pub notes: Vec<String>,
    /// Each node's id and the verdicts an edge out of it may route on, in file order.
    pub verdicts: Vec<(String, &'static [Verdict])>,
}

/// The typed edit verb, shared by the Console and the Steward. There is no parser for words.
#[derive(Debug, Clone, PartialEq)]
pub enum PlanEdit {
    /// A node of `kind` with its kind's defaults, named by the edit: the kind's word, else the first
    /// of `<kind>-b`, `<kind>-c`, ... that no node holds.
    AddNode {
        kind: PlanNodeKind,
        at: (i32, i32),
    },
    RemoveNode(NodeId),
    /// Replace a node's title and body; its id, kind and place stay.
    SetNode {
        id: NodeId,
        title: String,
        body: NodeBody,
    },
    Link(Edge),
    Unlink(EdgeKey),
    SetCap {
        edge: EdgeKey,
        cap: Option<LoopCap>,
    },
    SetMeta(PlanMeta),
    Move {
        id: NodeId,
        at: (i32, i32),
    },
}

impl PlanEdit {
    /// The one way in for an edit off the wire, through the same readers a file's nodes and edges
    /// go through. Refused: an `on` that is no verdict, a cap or `perItem` of 0. Ids are carried
    /// unchecked, so a bad one is a problem on its node, judged with every other rule.
    pub fn read(file: &PlanEditFile) -> Result<PlanEdit, Vec<PlanProblem>> {
        parse::edit_of(file)
    }

    /// Every edit read, or every refusal together.
    pub fn read_all(files: &[PlanEditFile]) -> Result<Vec<PlanEdit>, Vec<PlanProblem>> {
        let mut edits = Vec::new();
        let mut problems = Vec::new();
        for file in files {
            match PlanEdit::read(file) {
                Ok(edit) => edits.push(edit),
                Err(more) => problems.extend(more),
            }
        }
        if problems.is_empty() {
            Ok(edits)
        } else {
            Err(problems)
        }
    }
}
