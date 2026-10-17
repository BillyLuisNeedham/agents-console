//! crates/core/src/plan.rs (sketch): the Plan: what the operator builds, what a Line freezes.
//!
//! One module owns the plan's file format, its parse, its validation, its edits and the built-in
//! Presets. Nothing outside it can build a `Plan`: the only constructors are `Plan::parse` (a file, a
//! socket payload, `line.json`) and `Plan::edit` (typed edits on a valid plan, re-validated whole).
//! The run core, the engine shell, the server and the Console (through `plans.validate`) hold a
//! `Plan` and trust it. The serde shape (`PlanFile`) is private to this module and the protocol crate.
//!
//! Shape decisions this file carries:
//! - A node's kind is a closed enum and fixes its verdict vocabulary, so an edge's `on` is checked
//!   at parse and the run core never meets an unknown verdict.
//! - Every Conversation and Ticket node has an implicit `closed` verdict. A `closed` with no edge of
//!   its own goes to the Finish, carrying why (the one routing default), so every plan can end.
//! - The merger is a node of its own, `Merger { of, conflict }`. Its presence means "hand the pass
//!   on together, once every copy has settled"; its absence means "hand each copy on as it settles".
//!   `Plan::edit` places one when a node becomes per-item and lifts it when the node goes back to
//!   one copy; removing it by hand is the opt-out.
//! - A loop edge is an edge that closes a cycle: a capped edge, or an edge leaving a person (an
//!   Operator or Steward gate, or the Finish's `revise`). Every cycle must hold one. The check does
//!   not depend on the order nodes were added, unlike the prototype's "a link back to an ancestor".
//! - Traversing a loop edge resets the counts of the capped loops nested inside its cycle. That is
//!   how "Prove fails per Round" survives as plain edge counts.

use std::num::NonZeroU32;

use indexmap::IndexMap;

// -------------------------------------------------------------------------------------------------
// Identity
// -------------------------------------------------------------------------------------------------

/// `[a-z][a-z0-9-]{0,39}`, not ending in `-<digits>` (Ticket ids append `-<pass>`), and none of the
/// reserved words `plan`, `line`, `spawn`, `grader`. Parsed once, so a `NodeId` is always a valid
/// Ticket-id prefix and branch-name fragment.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Verdict {
    Done,
    Pass,
    Fail,
    Clean,
    Findings,
    Ship,
    AnotherRound,
    /// A gate opened: its hold Ticket was Resumed with no note or "approved".
    Open,
    /// A gate or the Finish Resumed with notes. The notes ride on the handoff.
    Revise,
    /// Implicit on every Conversation and Ticket node: a copy or Conversation was Closed, a gate
    /// hold was Closed, or a spent loop's hold was Closed.
    Closed,
}

/// `(from, on, to)` is unique in a plan, so it names an edge in run state and on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EdgeKey {
    pub from: NodeId,
    pub on: Verdict,
    pub to: NodeId,
}

// -------------------------------------------------------------------------------------------------
// The plan
// -------------------------------------------------------------------------------------------------

/// A valid plan. Fields are private: read through accessors, change through `edit`.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    meta: PlanMeta,
    /// File order. The Console lays nodes out by `at`; the engine ignores `at`.
    nodes: IndexMap<NodeId, Node>,
    edges: Vec<Edge>,
    /// Derived, never in the file: nodes with no incoming edge except loop edges. Non-empty.
    entries: Vec<NodeId>,
    /// Derived: every loop edge, with the capped edges nested inside the cycle it closes (for a
    /// loop edge u -> v: the capped edges, other than itself, with both ends on some v ~> u path).
    loops: IndexMap<EdgeKey, Vec<EdgeKey>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanMeta {
    pub name: String,
    pub author: Option<String>,
    /// The author's own file the flow comes from. Every Preset has one.
    pub source: Option<String>,
    /// One or two sentences: what is distinctive, and what the graph cannot say.
    pub note: Option<String>,
    /// The Steward may send `PlanEdit`s to a Line running this plan. Off unless set.
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
    /// Opens a Conversation per pass. Hands on `done` with the Line brief it committed, or
    /// `closed` when the operator ends it as closed or it crashes.
    Conversation(ConversationNode),
    /// One Ticket per pass, or one per item.
    Ticket(TicketNode),
    /// The fan-in of one per-item node. Runs no agent.
    Merger(MergerNode),
    /// Runs no agent. Opened by the operator, the Steward, or at once.
    Gate(GateNode),
    /// Exactly one per plan.
    Finish(FinishNode),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConversationNode {
    /// The skill the opening Turn names (ADR-0031: what and which skills, never how).
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
    /// Free text added to every Ticket body this node writes (the old Station `note`).
    pub note: Option<String>,
}

/// Fixes the verdict vocabulary and the verdict teaching. Closed on purpose: a new kind is a new
/// verdict schema in the Outcome check, not plan data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketKind {
    /// `done`. (The prototype's agent and builder differed only in defaults.)
    Agent,
    /// `pass | fail`, evidence under `runs/<ticket>.evidence/` (ADR-0038).
    Prove,
    /// `clean | findings`, the findings typed as today.
    Review,
    /// `ship | another-round`; writes the report, and its body lists every Prove and Review
    /// Outcome since this node's previous pass.
    Decide,
}

/// Harness, model and effort. An empty field falls through to the pool defaults when the Ticket
/// is written, as its `spawn-assign` (the "requested" layer of the Assignment). Harness names are
/// checked against the machine by the engine at Line start and at edit, never by `parse`.
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
    PerItem { cap: Cap },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cap {
    At(NonZeroU32),
    All,
}

/// Who answers a checkpoint this node's Tickets raise (the prototype's `wait | steward`;
/// `continue` and `rest` are dropped).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CheckpointPolicy {
    Operator,
    Steward,
}

/// What happens to Spawn proposals this node's Tickets make. `Hold` is ADR-0037's rule.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SpawnPolicy {
    Hold,
    /// Within the Spawn caps, as in a plain pool. Opt-in, because what lands merges into the
    /// Line's branch.
    Land,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergerNode {
    /// The per-item Ticket node this merger folds. Unique: one merger per node.
    pub of: NodeId,
    pub conflict: Conflict,
}

/// What a merge conflict on one of the `of` node's copies does.
#[derive(Debug, Clone, PartialEq)]
pub enum Conflict {
    /// A resolver Attempt on this Assignment; empty fields fall through to console.json's
    /// `resolver`, then the pool defaults.
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
    /// The Steward may answer the gate's hold Ticket; the operator always may.
    Steward,
    /// No hold Ticket: the gate hands on `open` at once.
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
    /// The default act; a Line brief's `finish` replaces it for one Line (as a plan edit).
    pub act: FinishAct,
    /// The Finish Ticket's Assignment, falling through to the pool defaults.
    pub assign: Assign,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FinishAct {
    /// Approval ends the Line; no Finish Ticket is written.
    None,
    DraftPr,
    Pr,
    /// Fast-forward the Line base to the Line's branch: locally, and on origin only under the
    /// brief's `pushBase` grant (ADR-0038). Never a force.
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
    pub max: u32,
    /// The Steward may answer this loop's spent hold once per reset; otherwise only the operator.
    pub steward_extra: bool,
    pub when_spent: WhenSpent,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WhenSpent {
    /// A loop hold Ticket asks the operator: Resume buys exactly one more traversal, Close stops
    /// the loop (the `from` node hands on `closed`).
    Hold,
    /// The handoff goes to this node instead, with a note that the loop was spent. Factory today:
    /// `decide.another-round -> implement` spent goes to `finish`, as Decide does now.
    To(NodeId),
}

// -------------------------------------------------------------------------------------------------
// Parse and validate: the one boundary
// -------------------------------------------------------------------------------------------------

/// Everything wrong with a plan, each pointing at what the editor highlights. The Console shows
/// these verbatim and never re-derives them.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanProblem {
    pub at: ProblemAt,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProblemAt {
    Plan,
    Node(String),
    Edge { from: String, on: String, to: String },
}

impl Plan {
    /// Parse `{horde: 1, name, author?, source?, note?, stewardEdits?, nodes: [...], edges: [...]}`
    /// and validate it. Every problem is reported, not only the first.
    pub fn parse(json: &str) -> Result<Plan, Vec<PlanProblem>> {
        // TODO
        // 1. serde into private `PlanFile` (deny_unknown_fields; `horde` must be 1).
        // 2. nodes: NodeId::parse; ids unique; per-kind field rules (copies, makes_items, spawns
        //    only on Ticket nodes; a Merger's `of` is a PerItem Ticket node; at most one merger per
        //    node; a Gate has no assign).
        // 3. edges: both ends exist; `on` is in from's vocabulary:
        //      Conversation: done | closed       Ticket: the kind's verdicts | closed
        //      Merger: its `of` node's vocabulary (it hands the pass verdict on)
        //      Gate (Operator/Steward): open | revise | closed       Gate (Auto): open
        //      Finish: revise only
        //    no duplicate key; nothing enters a Merger except from its `of` node; every out-edge of
        //    a per-item node that has a merger goes to that merger.
        // 4. exactly one Finish; at least one entry; every node reachable from an entry; the
        //    Finish reachable from every node (through `closed`'s default if need be).
        // 5. cycles: drop the loop-edge candidates (capped edges, edges leaving an Operator/Steward
        //    gate, finish.revise); the rest must be acyclic (Kahn). A cap on an edge that closes no
        //    cycle is a problem. `when_spent: To(n)` names an existing node.
        // 6. derive `entries` and `loops` (with their nested capped edges).
        todo!()
    }

    /// What `plans.validate` answers.
    pub fn check(json: &str) -> Vec<PlanProblem> {
        Plan::parse(json).err().unwrap_or_default()
    }

    /// Canonical file text (stable key order), for the library, `line.json` and Save as.
    pub fn to_json(&self) -> String {
        todo!()
    }

    /// Apply typed edits in order, then re-validate the result whole with `parse(to_json(..))`, so
    /// there is one validator. Edits that change a node's copies also place or lift its merger:
    /// - a Ticket node set to PerItem with no merger gains `<id>-merge` (`Conflict::Resolver` with
    ///   an empty Assign), placed beside it, and its out-edges move to the merger;
    /// - a node set back to One loses its merger, whose out-edges move back onto the node;
    /// - `RemoveNode(merger)` moves the merger's out-edges onto its `of` node (the opt-out);
    /// - `AddNode(Merger { of })` moves `of`'s out-edges onto the new merger (opting back in);
    /// - a `Link` from a node that has a merger is made from the merger instead.
    /// Each such move is reported in `Edited::notes` so the editor can say what it did.
    pub fn edit(&self, edits: &[PlanEdit]) -> Result<Edited, Vec<PlanProblem>> {
        todo!()
    }

    pub fn meta(&self) -> &PlanMeta {
        &self.meta
    }
    pub fn node(&self, id: &NodeId) -> &Node {
        &self.nodes[id]
    }
    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }
    pub fn entries(&self) -> &[NodeId] {
        &self.entries
    }
    pub fn finish(&self) -> &NodeId {
        todo!("the one Finish node")
    }
    /// Every edge out of `from` on `on`, in plan order. A verdict fans out to all of them.
    pub fn out(&self, from: &NodeId, on: Verdict) -> impl Iterator<Item = &Edge> {
        self.edges.iter().filter(move |e| &e.key.from == from && e.key.on == on)
    }
    pub fn incoming(&self, to: &NodeId) -> impl Iterator<Item = &Edge> {
        self.edges.iter().filter(move |e| &e.key.to == to)
    }
    pub fn is_loop(&self, edge: &EdgeKey) -> bool {
        self.loops.contains_key(edge)
    }
    /// The capped loops whose counts reset when `edge` is traversed.
    pub fn nested_loops(&self, edge: &EdgeKey) -> &[EdgeKey] {
        self.loops.get(edge).map_or(&[], Vec::as_slice)
    }
    pub fn merger_of(&self, node: &NodeId) -> Option<&NodeId> {
        todo!()
    }
    /// The conflict policy for a Ticket this node writes: its merger's, or `None` for the pool's
    /// own `resolver` setting (one-copy nodes, per-item nodes without a merger).
    pub fn conflict_for(&self, node: &NodeId) -> Option<&Conflict> {
        todo!()
    }
}

pub struct Edited {
    pub plan: Plan,
    pub notes: Vec<String>,
}

/// The typed edit verb, shared by the Console (on a library plan, or on a running Line through
/// `line.plan.edit`) and by the Steward (on a running Line, only when `steward_edits`). It replaces
/// the prototype's text command language; there is no parser for words.
#[derive(Debug, Clone, PartialEq)]
pub enum PlanEdit {
    AddNode(Node),
    RemoveNode(NodeId),
    /// Replace a node's title and body; its id stays.
    SetNode { id: NodeId, title: String, body: NodeBody },
    Link(Edge),
    Unlink(EdgeKey),
    SetCap { edge: EdgeKey, cap: Option<LoopCap> },
    SetMeta(PlanMeta),
    Move { id: NodeId, at: (i32, i32) },
}

// -------------------------------------------------------------------------------------------------
// Presets and the Plan library
// -------------------------------------------------------------------------------------------------

/// A built-in Preset, compiled in with `include_str!("plan/presets/<slug>.json")`. A unit test
/// parses every one and checks it has `author` and `source`, so a Preset that does not validate
/// fails the tests, not a Boot.
pub struct Preset {
    pub slug: &'static str,
    pub json: &'static str,
}

/// The one list. `factory-today` reproduces ADR-0037's Line:
///   grill.done -> implement            implement.done -> prove
///   prove.pass -> review               prove.fail -> implement   (cap 2, steward_extra, Hold)
///   review.clean -> decide             review.findings -> decide
///   decide.ship -> finish              decide.another-round -> implement (cap 1, To(finish))
///   finish.revise -> implement         (a loop edge: it leaves a person)
///   implement.closed | prove.closed | review.closed -> decide   (Decide runs with `halted`)
/// Then, from the prototype's sources: matt-pocock-main, matt-pocock-quick, matt-pocock-bug,
/// matt-pocock-foggy, pstack-feature, pstack-bug-fix, pclaude-feature, pclaude-bug-fix,
/// addy-commands, addy-bug-fix.
pub const PRESETS: &[Preset] = &[];

#[derive(Debug, Clone, PartialEq)]
pub enum PlanRef {
    Preset(String),
    /// `~/.agent-graphs/plans/<slug>.json`.
    Library(String),
}

/// The machine Plan library. `home` is passed in; core never reads the environment.
pub mod library {
    use super::*;
    use std::path::Path;

    /// Presets first, then library files by slug. A file that fails to parse is listed with its
    /// problems and never hides the others.
    pub fn list(home: &Path) -> Vec<PlanSummary> {
        todo!()
    }
    pub fn load(home: &Path, plan: &PlanRef) -> Result<Plan, Vec<PlanProblem>> {
        todo!()
    }
    /// Write-then-rename. A slug a Preset uses is refused: Presets are read-only.
    pub fn save(home: &Path, slug: &str, plan: &Plan) -> anyhow::Result<()> {
        todo!()
    }
    pub fn delete(home: &Path, slug: &str) -> anyhow::Result<()> {
        todo!("refused for a Preset slug")
    }

    pub struct PlanSummary {
        pub plan: PlanRef,
        pub name: String,
        pub author: Option<String>,
        pub source: Option<String>,
        pub note: Option<String>,
        pub problems: Vec<PlanProblem>,
    }
}
