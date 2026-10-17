//! crates/core/src/line/run.rs (sketch): a Line running its frozen Plan. Pure: no I/O, no clock,
//! no git.
//!
//! The one idea: run state records structure and what it has absorbed; every status is a fact
//! read from the pool. A copy's status is never stored here: the Ticket file's state line owns it.
//! Merged-ness is never stored anywhere: git owns it (ADR-0014's "derived, never persisted"
//! stands). A Conversation node's Line brief is never stored before it is absorbed: the shell reads
//! it from the Conversation's committed branch on every advance. The Line owns only what nothing
//! else knows: which passes, copies, queues, inboxes, parked handoffs, gate arrivals and loop counts
//! exist, and which endings it has already routed.
//!
//! The transition is level-triggered:
//!
//!   observe(run, facts) -> [LineEvent]   facts the run has not absorbed yet, in a fixed order
//!   apply(run, event)                    absorbs one event; a second apply of it is a no-op
//!   advance(run, facts) -> Advanced      observe/apply to a fixpoint, then the projection
//!
//! The effects are a projection: every Ticket, hold Ticket and Conversation the run names that the
//! pool does not have yet. The shell saves `line.json` first and writes the projection second, at
//! every tick. A crash before the save replays the same facts; a crash after it lets the next
//! tick's projection write what is missing. Ids are a pure function of run state, so every write is
//! create-if-absent. No event log, no outbox.
//!
//! Every act on a Line except a plan edit arrives as an ordinary Interrupt answer on a Ticket
//! (Resume, Resume with notes, Close): a gate, a spent loop and the Finish are hold Tickets no agent
//! runs. One answer path, one Steward check (`steward_may_answer`), one Console form.

use std::collections::VecDeque;

use indexmap::IndexMap;

use super::plan::{
    Assign, Cap, CheckpointPolicy, Conflict, EdgeKey, FinishAct, NodeId, Plan, PlanEdit, PlanProblem,
    TicketKind, Verdict,
};

/// A Ticket or Conversation id the Line writes. Readable and deterministic:
/// - `{node}-{pass}`: a one-copy pass (`implement-2`), a Conversation pass (`grill-1`), a gate's
///   hold (`approve-1`), the Finish hold (`finish-1`);
/// - `{node}-{pass}.{seq}`: a per-item copy (`build-2.3`);
/// - `{from}-{on}-{to}-{n}`: a spent loop's hold (`prove-fail-implement-3`);
/// - `{finish}-{pass}-act`: the Finish Ticket that carries out the act (`finish-1-act`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TicketId(String);

/// From an Outcome's typed `items` or a Line brief's `items`, bounded at the parse like `spawn[]`
/// (title <= 200 chars, body <= 16k, <= 64 items).
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub title: String,
    pub body: String,
}

// -------------------------------------------------------------------------------------------------
// Run state: line.json's `run`
// -------------------------------------------------------------------------------------------------

/// `line.json` is `{ horde: 1, plan, rev, places, run }`, the plan as `Plan::to_json` writes it.
#[derive(Debug, Clone, PartialEq)]
pub struct LineRun {
    /// The frozen copy. Library edits never reach it; `PlanEdited` replaces it.
    plan: Plan,
    /// Bumped by every applied plan edit; an edit names the rev it was made against.
    rev: u64,
    pub places: LinePlaces,
    status: LineStatus,
    /// One entry per node ever handed anything, in plan order.
    nodes: IndexMap<NodeId, NodeRun>,
    /// One entry per loop edge ever traversed or held.
    edges: IndexMap<EdgeKey, EdgeRun>,
}

/// Where the Line lives. `spec` and `push_base` come from the latest Line brief that set them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LinePlaces {
    pub branch: String,
    pub base: Option<String>,
    pub spec: Option<String>,
    pub push_base: bool,
    /// The Line's work as Boot was given it (`--work`), handed to the entry nodes.
    pub work: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LineStatus {
    Running,
    /// The Finish has its handoff. `waiting_for` is recomputed at every advance (a cache for the
    /// view); the Finish hold is written the first time it is empty.
    Finishing { waiting_for: Vec<Blocker> },
    /// The operator approved the Finish hold and the act is not `none`: the Finish Ticket is owed
    /// or running. Persisted before the Ticket is written, so a crash re-projects the same id.
    Acting { ticket: TicketId },
    /// The pool is done (no run-wide Review: a Line's gates and its Finish are its review).
    Done,
    /// The Finish hold or the Finish Ticket was Closed.
    Closed,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NodeRun {
    /// Passes started; the next is `passes + 1`.
    passes: u32,
    current: Option<Pass>,
    /// Handoffs that arrived while a pass was live; each starts one later pass, oldest first.
    inbox: VecDeque<Handoff>,
    /// A verdict with no out edge (other than `closed`, which defaults to the Finish). The newest
    /// replaces an older one on the same verdict. A `Link` flows it on. Never blocks the Finish.
    parked: IndexMap<Verdict, Handoff>,
    /// A `join: all` gate's arrivals, by incoming edge, until every incoming edge has one.
    arrived: IndexMap<EdgeKey, Handoff>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pass {
    n: u32,
    input: Handoff,
    work: PassWork,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PassWork {
    Tickets {
        copies: Vec<CopyRun>,
        /// Items beyond the cap, started one per freed slot.
        queue: VecDeque<Item>,
        cap: Cap,
        next_seq: u32,
    },
    Conversation {
        id: TicketId,
    },
    /// An Operator or Steward gate's hold Ticket, unanswered.
    Hold {
        ticket: TicketId,
    },
    /// The Finish has its handoff. `hold` is set when the Finish hold has been projected.
    Finish {
        hold: Option<TicketId>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct CopyRun {
    ticket: TicketId,
    item: Option<Item>,
    /// Absorbed: the copy ended, done or closed, so its slot is free and the queue moves.
    freed: bool,
    /// Absorbed: the copy settled (done and merged into the Line's branch, or closed) with this
    /// verdict and these items. Set exactly once, never before `freed`.
    settled: Option<Settled>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    verdict: Verdict,
    /// Only a done copy has a branch on the Line; a closed copy contributes nothing to `after`.
    done: bool,
    items: Vec<Item>,
    /// With no merger: whether this copy has been handed on alone.
    handed: bool,
}

/// What travels along an edge.
#[derive(Debug, Clone, PartialEq)]
pub struct Handoff {
    pub from: NodeId,
    pub verdict: Verdict,
    pub items: Vec<Item>,
    /// The Tickets whose work this handoff carries; the next Tickets are `blocked-by` them, so the
    /// scheduler's merge gate and the Console's topology edges both see the flow. Done Tickets and
    /// answered hold Tickets only, never a Closed one: a Closed blocker would deadlock its
    /// dependent (ADR-0033), so a closed copy's work is simply absent.
    pub after: Vec<TicketId>,
    /// A gate's, the Finish's, or a loop hold's Resume notes.
    pub notes: Option<String>,
    /// Why the work upstream halted (a Close, a crash, a spent loop), shown in the next body.
    pub halted: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct EdgeRun {
    count: u32,
    /// Traversals past `max` bought by Resumes of this loop's hold. Each Resume buys exactly one.
    bought: u32,
    /// The Steward has answered this loop's hold since the last reset.
    steward_used: bool,
    /// A spent loop: the handoff that could not cross, waiting on its hold Ticket.
    held: Option<(TicketId, Handoff)>,
}

// -------------------------------------------------------------------------------------------------
// Facts: what the run reads from the pool (the engine implements this over Session)
// -------------------------------------------------------------------------------------------------

pub trait LineFacts {
    fn ticket(&self, id: &TicketId) -> TicketFact<'_>;
    fn conversation(&self, id: &TicketId) -> ConversationFact;
    /// What outside the Line keeps the Finish from completing: any non-Line Ticket not Done or
    /// Closed, any done Ticket not merged, any Held or Pending spawn, any pending Interrupt other
    /// than the Finish hold's own.
    fn outside_blockers(&self) -> Vec<Blocker>;
}

/// A Line Ticket as the pool has it. A done Ticket's verdict is already valid: the attempt's exit
/// ran the kind's verdict check and turned a bad one into the "no verdict" checkpoint (ADR-0037),
/// and `items` was parsed with the Outcome.
pub enum TicketFact<'a> {
    Unwritten,
    /// Ready, in progress, or at a checkpoint: it holds its slot.
    Live,
    Done {
        verdict: Verdict,
        items: &'a [Item],
        /// Its branch is an ancestor of the Line's branch. True by rule, never by reading git,
        /// for a Ticket that has no branch: a hold Ticket, an engine-run Ticket.
        merged: bool,
    },
    Closed,
    /// A hold Ticket Resumed: its state line is Done, the note on its events.
    Answered { note: Option<&'a str> },
}

pub enum ConversationFact {
    Unopened,
    Open,
    /// Ended by the operator with a valid Line brief (End is refused without one, unless the
    /// operator ends it as closed). The brief is read from the Conversation's branch, or from the
    /// Line's branch once that branch has merged and gone, on every advance until absorbed.
    Ended { brief: LineBrief, merged: bool },
    /// Ended as closed, or crashed.
    Closed { why: String },
}

/// What a Conversation node commits at `docs/specs/<line>.<conversation>.brief.json`, or what
/// `--brief` names for the entry Conversation node. Every field is optional. The overrides are
/// applied to the frozen plan as `PlanEdit::SetNode`s by the operator, the one way a plan changes.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LineBrief {
    pub spec: Option<String>,
    pub items: Vec<Item>,
    pub finish: Option<FinishAct>,
    pub push_base: Option<bool>,
    pub nodes: IndexMap<NodeId, NodeOverride>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NodeOverride {
    pub assign: Option<Assign>,
    pub note: Option<String>,
}

/// One thing the Finish waits for, named so the Console and the refusal can say it.
#[derive(Debug, Clone, PartialEq)]
pub enum Blocker {
    Copy(TicketId),
    Queued { node: NodeId, items: usize },
    Inbox { node: NodeId, handoffs: usize },
    Hold(TicketId),
    Conversation(TicketId),
    Ticket(String),
    Unmerged(String),
    HeldSpawn(String),
    PendingSpawn(String),
    Interrupt(String),
}

// -------------------------------------------------------------------------------------------------
// Events and the transition
// -------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum LineEvent {
    /// Derived: a copy's Ticket is Done or Closed and the run had it holding a slot.
    CopyFreed { node: NodeId, ticket: TicketId },
    /// Derived: a copy is Done and merged, or Closed, and the run has not absorbed its verdict.
    CopySettled { node: NodeId, ticket: TicketId, verdict: Verdict, done: bool, items: Vec<Item> },
    /// Derived: a Conversation pass ended, and if briefed, its branch merged.
    ConversationEnded { node: NodeId, outcome: ConversationOutcome },
    /// Derived: a gate hold, a loop hold or the Finish hold was answered.
    HoldAnswered { ticket: TicketId, answer: HoldAnswer },
    /// Derived: the Finish Ticket is Done and merged, or Closed.
    ActEnded { ticket: TicketId, done: bool },
    /// The only event not derived from facts: applied in the job that receives `line.plan.edit`.
    PlanEdited { by: Editor, base_rev: u64, edits: Vec<PlanEdit> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConversationOutcome {
    Briefed(LineBrief),
    Closed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum HoldAnswer {
    /// Resume with no note, or "approved".
    Open,
    Revise(String),
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Editor {
    Operator,
    Steward,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    StaleRev { now: u64 },
    StewardMayNotEdit,
    Invalid(Vec<PlanProblem>),
    /// The edit would orphan live run state: remove a node with a live pass, queue or inbox;
    /// unlink an edge holding a spent loop; change a node's kind while a pass is live.
    Live(String),
    LineEnded,
    /// Approving the Finish while anything blocks it. The verb refuses with this list.
    FinishBlocked(Vec<Blocker>),
    /// Resume with notes on the Finish, in a plan whose Finish has no `revise` edge.
    NoRevise,
}

pub enum LineStart {
    /// `--work`: the entry nodes start on it; an entry Conversation node opens with it.
    Work(String),
    /// `--brief`: the entry Conversation node's pass is absorbed at once as answered with this
    /// brief, and no Conversation opens. A plan with no entry Conversation node applies the brief
    /// (spec, finish, pushBase, overrides, items) to the Line and starts its entry Tickets on it.
    Brief(LineBrief),
}

impl LineRun {
    /// The Line at Boot: the plan frozen, a first pass delivered to every entry node, nothing
    /// written. The first tick's projection writes it.
    pub fn start(plan: Plan, places: LinePlaces, with: LineStart) -> LineRun {
        todo!()
    }

    /// Facts not yet absorbed, in plan-node order then copy order, so the same facts always give
    /// the same list. Never mutates.
    pub fn observe(&self, facts: &dyn LineFacts) -> Vec<LineEvent> {
        // TODO for each node's current pass:
        //   Tickets: per copy: Done|Closed && !freed -> CopyFreed;
        //            (Done{merged: true} | Closed) && settled.is_none() -> CopySettled.
        //   Conversation: Ended{merged: true} | Closed -> ConversationEnded.
        //   Hold / Finish{hold: Some}: Answered{note} -> HoldAnswered(Open | Revise); Closed -> Closed.
        // for each edge with `held`: the same for its loop hold.
        // status Acting{ticket}: Done{merged: true} | Closed -> ActEnded.
        todo!()
    }

    /// Absorb one event. Deterministic; an event already absorbed is a no-op.
    pub fn apply(&mut self, event: LineEvent) -> Result<(), Refusal> {
        // TODO
        // CopyFreed: mark freed; pull the queue while live < cap.
        // CopySettled: record Settled. No merger: hand on alone at once,
        //   Handoff { verdict, items, after: if done { [ticket] } else { [] } }, mark handed.
        //   Then complete_pass_if_done(node).
        // ConversationEnded: Briefed -> apply the brief (places.spec/push_base; finish and node
        //   overrides as operator SetNode edits, no rev check: the brief is the operator's);
        //   emit(node, Done, items = brief.items, after = []); Closed(why) -> emit(node, Closed,
        //   halted = why). End the pass; start the next from the inbox.
        // HoldAnswered on a gate hold: emit(gate, Open | Revise | Closed) with the collected
        //   handoff, notes attached, after = [hold] + collected.after (the hold passes the merge
        //   gate by rule: it has no branch).
        // HoldAnswered on a loop hold: Open | Revise -> bought += 1, then traverse the held
        //   handoff (notes ride along); Closed -> emit(edge.from, Closed, halted = "the loop
        //   {from} -> {to} was stopped").
        // HoldAnswered on the Finish hold: Open -> act None ? status = Done : status = Acting
        //   { "{finish}-{pass}-act" }; Revise(notes) -> emit(finish, Revise, notes) (the Finish
        //   pass ends; `revise` exists, `check_finish_answer` saw to it); Closed -> status = Closed.
        // ActEnded: done -> Done; closed -> Closed.
        // PlanEdited: Steward && !steward_edits -> StewardMayNotEdit; base_rev != rev ->
        //   StaleRev; plan.edit(edits)? -> check_edit(&new)?; swap, rev += 1; flow every parked
        //   handoff that now has an out edge.
        todo!()
    }

    /// observe/apply to a fixpoint, then the Finish, then the projection. The engine's one call.
    pub fn advance(&mut self, facts: &dyn LineFacts) -> Advanced {
        // TODO
        // loop { let evs = self.observe(facts); if evs.is_empty() { break } for e in evs { self.apply(e) } }
        // if status is Running|Finishing and a Finish pass exists: status = Finishing { waiting_for:
        //   self.blockers(facts) }; when that is empty and the Finish hold is unset, set it
        //   ("{finish}-{pass}"): once set it stays, and approval re-checks.
        // Advanced { changed: self != before, log, effects: self.effects(facts) }
        todo!()
    }

    /// Everything the run names that the pool does not have yet. Pure, so a second write of the
    /// same projection writes nothing.
    pub fn effects(&self, facts: &dyn LineFacts) -> Effects {
        // TODO: every CopyRun, gate/loop/Finish hold, Conversation pass and owed Finish Ticket whose
        // fact is Unwritten | Unopened, built from the plan node and the pass input; blocked_by =
        // input.after. Bodies quote upstream Outcomes through the facts (a Decide body: every Prove
        // and Review Outcome since this node's previous pass).
        todo!()
    }

    /// What the Finish waits for: the Line's live copies, queued items, inbox handoffs, gate and
    /// loop holds, open Conversation passes, then `facts.outside_blockers()`. A `join: all` gate
    /// still collecting, and a parked handoff, do not block.
    pub fn blockers(&self, facts: &dyn LineFacts) -> Vec<Blocker> {
        todo!()
    }

    /// Called by the answer path in the job that accepts an answer on a Line Ticket, and again when
    /// a queued answer drains. For the Finish hold: an approval while `blockers` is non-empty is
    /// `FinishBlocked(list)`; notes with no `revise` edge are `NoRevise`. Every other answer passes.
    pub fn check_answer(
        &self,
        ticket: &TicketId,
        answer: &HoldAnswer,
        facts: &dyn LineFacts,
    ) -> Result<(), Refusal> {
        todo!()
    }

    /// Whether the Steward may answer this Line Ticket's Interrupt. Yes for: a copy whose node is
    /// `checkpoint: steward`; the hold of a gate that opens `steward`; a spent loop's hold on a
    /// `steward_extra` edge whose `steward_used` is false. Never the Finish hold, never the Finish
    /// Ticket, never anything once the Line has ended. `steward_actions.rs` asks this in place of
    /// today's hard-coded Finish refusal, and the Steward is told only of what this allows.
    pub fn steward_may_answer(&self, ticket: &TicketId) -> bool {
        todo!()
    }

    pub fn status(&self) -> &LineStatus {
        &self.status
    }
    pub fn plan(&self) -> (&Plan, u64) {
        (&self.plan, self.rev)
    }
    /// Whether this id is one of the Line's, and which node wrote it (for `node=` and the view).
    pub fn node_of(&self, ticket: &TicketId) -> Option<&NodeId> {
        todo!()
    }

    /// The Console's live graph: the frozen plan and rev; per node its passes, current copies by
    /// ticket id (the Console joins status from the snapshot's tickets), queued and inbox counts,
    /// parked verdicts, gate arrivals, hold ticket; per loop edge count/max/bought/held; the status
    /// with `waiting_for`. Recomputed per emit, never stored.
    pub fn view(&self) -> LineGraphView {
        todo!()
    }

    // --- steps the transitions share ------------------------------------------------------------

    /// A pass of `node` is done when no copy is live, the queue is empty and every copy settled.
    /// Verdict: `Closed` if any copy closed, else the first non-ok verdict in copy order, else the
    /// kind's ok verdict. With a merger: emit that verdict to the merger with `after` = the done
    /// copies and `items` = their items in copy order (the merger hands it straight on). Without
    /// one: nothing more to emit. Then start the next pass from the inbox.
    fn complete_pass_if_done(&mut self, node: &NodeId) {
        todo!()
    }

    /// Fan a verdict out to every matching edge. None: `closed` goes to the Finish with `halted`;
    /// any other verdict parks.
    fn emit(&mut self, node: &NodeId, handoff: Handoff) {
        todo!()
    }

    /// Cross one edge. Not a loop edge: deliver. A loop edge: count += 1 if capped and not spent,
    /// reset every `plan.nested_loops(edge)` (count, bought, steward_used), deliver. Spent
    /// (`count == max + bought`): `WhenSpent::To(n)` -> deliver to n with the note "the loop
    /// {from} -> {to} is spent ({max} of {max})"; `WhenSpent::Hold` -> held = (TicketId
    /// "{from}-{on}-{to}-{count + 1}", handoff).
    fn traverse(&mut self, edge: &EdgeKey, handoff: Handoff) {
        todo!()
    }

    /// Hand `handoff` to `node`:
    /// - Ticket node with a live pass -> inbox. Idle -> new pass: `One` -> one copy (its body lists
    ///   every item); `PerItem` with items -> min(cap, n) copies, the rest queued; `PerItem` with
    ///   none -> one copy on the Line's work.
    /// - Conversation node -> a pass opening "{node}-{pass}" (live pass -> inbox).
    /// - Merger -> hand the verdict straight on (it already waited, as its node's pass).
    /// - Gate: `join: all` records in `arrived` until every incoming edge has one, then combines
    ///   (items and `after` concatenated). `Auto` emits `open` at once; else a Hold pass.
    /// - Finish -> the Finish pass (a second handoff while one is live goes to the inbox).
    fn deliver(&mut self, node: &NodeId, via: Option<&EdgeKey>, handoff: Handoff) {
        todo!()
    }

    fn check_edit(&self, next: &Plan) -> Result<(), Refusal> {
        todo!()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Advanced {
    pub changed: bool,
    pub log: Vec<String>,
    pub effects: Effects,
}

/// What the shell must make true in the pool. Each entry is create-if-absent by id.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Effects {
    /// Ordinary Tickets, the Finish Ticket among them: `status=ready node=<id>
    /// spawn-assign=<...>`, `blocked-by` = the handoff's `after`.
    pub tickets: Vec<NewTicket>,
    /// Written `status=checkpoint node=<id> hold`, and their Interrupt raised with `brief`. The
    /// scheduler never launches one.
    pub holds: Vec<NewHold>,
    pub conversations: Vec<NewConversation>,
    /// Set when this advance ended the Line: the shell settles the pool Done or Closed.
    pub ended: Option<LineStatus>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewTicket {
    pub id: TicketId,
    pub node: NodeId,
    pub title: String,
    pub body: String,
    pub blocked_by: Vec<TicketId>,
    pub assign: Assign,
    /// The Outcome check the attempt's exit applies: the kind's verdicts, `items` if the node makes
    /// them; for the Finish Ticket, the act's result (a PR url for `pr` and `draft-pr`).
    pub check: OutcomeCheck,
    pub checkpoint: CheckpointPolicy,
    pub conflict: Option<Conflict>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OutcomeCheck {
    Verdict { kind: TicketKind, makes_items: bool },
    FinishAct(FinishAct),
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewHold {
    pub id: TicketId,
    pub node: NodeId,
    pub title: String,
    pub body: String,
    pub blocked_by: Vec<TicketId>,
    /// The Interrupt's text: what Resume, Resume with notes and Close each do here.
    pub brief: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewConversation {
    pub id: TicketId,
    pub node: NodeId,
    pub title: String,
    /// The Line's work or the pass input, the node's skill and note, and how to write the brief.
    pub opening: String,
    pub assign: Assign,
}

pub struct LineGraphView; // the wire type lives in ac_protocol (wire.rs), generated into wire.ts
