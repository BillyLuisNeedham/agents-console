//! A Line running its frozen Plan (ADR-0039). Pure: no I/O, no clock, no git.
//!
//! Run state records structure and what it has absorbed; every status is a fact read from the pool.
//! A copy's status belongs to its Ticket's state line and merged-ness belongs to git, so neither is
//! stored. The transition is level-triggered: `observe` lists the facts the run has not absorbed,
//! `apply` absorbs one (a second apply is a no-op), and `advance` runs both to a fixpoint, settles
//! the Finish and returns the projection: every Ticket, hold Ticket and Conversation the run names
//! that the pool lacks. Ids are a pure function of run state, so every write is create-if-absent,
//! and the shell saves `line.json` before it writes the projection.

use std::collections::VecDeque;

use ac_protocol::Outcome;
use indexmap::IndexMap;

use crate::plan::{
    Assign, Cap, CheckpointPolicy, Conflict, Copies, EdgeKey, FinishAct, FinishNode, Join,
    NodeBody, NodeId, Opener, Plan, PlanEdit, TicketKind, Verdict, WhenSpent,
};
use ac_protocol::wire::PlanProblem;

mod brief;
mod file;
#[cfg(test)]
mod tests;
mod text;

pub use brief::{LineBrief, NodeOverride, brief_problem};
pub use text::{hold_text, ticket_text, verdict_of};

/// A Ticket or Conversation id the Line writes:
/// - `{node}-{pass}`: a one-copy pass, a Conversation pass, a Gate's hold, the Finish hold;
/// - `{node}-{pass}.{seq}`: a per-item copy;
/// - `{from}-{on}-{to}-{n}`: a spent loop's hold, `n` counting every traversal of that edge;
/// - `{finish}-{pass}-act`: the Finish Ticket.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TicketId(String);

impl TicketId {
    pub fn new(id: impl Into<String>) -> TicketId {
        TicketId(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for TicketId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub title: String,
    pub body: String,
}

// -------------------------------------------------------------------------------------------------
// Run state: line.json's `run`
// -------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct LineRun {
    plan: Plan,
    rev: u64,
    pub places: LinePlaces,
    status: LineStatus,
    /// One entry per node ever handed anything.
    nodes: IndexMap<NodeId, NodeRun>,
    /// One entry per loop edge ever traversed or held.
    edges: IndexMap<EdgeKey, EdgeRun>,
    /// Every done copy, in the order it settled: what a Decide pass reads.
    settled: Vec<TicketId>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct LinePlaces {
    pub branch: String,
    pub base: Option<ac_protocol::LineBase>,
    pub spec: Option<String>,
    pub push_base: bool,
    /// The Line's work as Boot was given it (`--work`).
    pub work: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LineStatus {
    Running,
    /// The Finish has its handoff. `waiting_for` is recomputed at every advance; the Finish hold is
    /// written the first time it is empty.
    Finishing {
        waiting_for: Vec<Blocker>,
    },
    /// The Finish was approved and its act is not `none`: the Finish Ticket is owed or running.
    Acting {
        ticket: TicketId,
    },
    Done,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NodeRun {
    passes: u32,
    current: Option<Pass>,
    inbox: VecDeque<Handoff>,
    parked: IndexMap<Verdict, Handoff>,
    arrived: IndexMap<EdgeKey, Handoff>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pass {
    n: u32,
    input: Handoff,
    work: PassWork,
    /// A Decide pass's Prove and Review Tickets since the node's previous pass, fixed at its start
    /// so its body and its must-accounting never move.
    reads: Vec<TicketId>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PassWork {
    Tickets {
        copies: Vec<CopyRun>,
        queue: VecDeque<Item>,
        cap: Cap,
        next_seq: u32,
    },
    Conversation {
        id: TicketId,
    },
    Hold {
        ticket: TicketId,
    },
    Finish {
        hold: Option<TicketId>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct CopyRun {
    ticket: TicketId,
    item: Option<Item>,
    freed: bool,
    settled: Option<Settled>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    verdict: Verdict,
    done: bool,
    items: Vec<Item>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Handoff {
    /// `None` for what the Line started with.
    pub from: Option<NodeId>,
    pub verdict: Verdict,
    pub items: Vec<Item>,
    /// Done Tickets and answered hold Tickets, never a Closed one (ADR-0033): the next Tickets are
    /// `blocked-by` them.
    pub after: Vec<TicketId>,
    pub notes: Option<String>,
    pub halted: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct EdgeRun {
    count: u32,
    /// Every traversal ever, never reset: a loop hold's id counts these.
    traversals: u32,
    bought: u32,
    steward_used: bool,
    held: Option<(TicketId, Handoff)>,
}

// -------------------------------------------------------------------------------------------------
// Facts: what the run reads from the pool
// -------------------------------------------------------------------------------------------------

pub trait LineFacts {
    fn ticket(&self, id: &TicketId) -> TicketFact;
    fn conversation(&self, id: &TicketId) -> ConversationFact;
    /// A done Ticket's Outcome, which the next bodies quote.
    fn outcome(&self, id: &TicketId) -> Option<&Outcome>;
    /// What outside the Line's own Tickets keeps the Finish from completing: any other Ticket not
    /// Done or Closed, any other done Ticket not merged, any Held or Pending spawn, any pending
    /// Interrupt on a Ticket the Line did not write.
    fn outside_blockers(&self) -> Vec<Blocker>;
    /// The pool's runs directory, where Decide writes its reports and Prove its evidence.
    fn runs_dir(&self) -> String;
}

/// A Line Ticket as the pool has it. A done Ticket's verdict was checked at its exit, where a bad
/// one became the "no verdict" checkpoint (ADR-0037).
#[derive(Debug, Clone, PartialEq)]
pub enum TicketFact {
    Unwritten,
    /// Ready, in progress, or at a checkpoint: it holds its slot.
    Live,
    Done {
        verdict: Verdict,
        items: Vec<Item>,
        /// True by rule for a Ticket with no branch.
        merged: bool,
    },
    Closed,
    /// A hold Ticket Resumed: its state line is Done, and the last Resume note in its file says
    /// what was answered and whether the Steward wrote it.
    Answered {
        note: Option<String>,
        by_steward: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConversationFact {
    Unopened,
    Open,
    Ended { brief: LineBrief, merged: bool },
    Closed { why: String },
}

/// One thing the Finish waits for.
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

impl std::fmt::Display for Blocker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let plural = |n: usize, one: &str, many: &str| if n == 1 { one } else { many }.to_owned();
        match self {
            Blocker::Copy(t) => write!(f, "{t}"),
            Blocker::Queued { node, items } => {
                write!(
                    f,
                    "{items} queued {} on {node}",
                    plural(*items, "item", "items")
                )
            }
            Blocker::Inbox { node, handoffs } => write!(
                f,
                "{handoffs} {} waiting at {node}",
                plural(*handoffs, "handoff", "handoffs")
            ),
            Blocker::Hold(t) => write!(f, "the hold {t}"),
            Blocker::Conversation(t) => write!(f, "the Conversation {t}"),
            Blocker::Ticket(t) => write!(f, "{t}"),
            Blocker::Unmerged(t) => write!(f, "{t} (done, not merged)"),
            Blocker::HeldSpawn(s) => write!(f, "the Held spawn {s}"),
            Blocker::PendingSpawn(s) => write!(f, "the Pending spawn {s}"),
            Blocker::Interrupt(t) => write!(f, "the Interrupt on {t}"),
        }
    }
}

fn blocker_list(blockers: &[Blocker]) -> String {
    blockers
        .iter()
        .map(Blocker::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

// -------------------------------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum LineEvent {
    /// A copy's Ticket is Done or Closed and the run had it holding a slot.
    CopyFreed { node: NodeId, ticket: TicketId },
    /// A copy is Done and merged, or Closed, and the run has not absorbed its verdict.
    CopySettled {
        node: NodeId,
        ticket: TicketId,
        verdict: Verdict,
        done: bool,
        items: Vec<Item>,
    },
    /// A Conversation pass ended, and if briefed, its branch merged.
    ConversationEnded {
        node: NodeId,
        id: TicketId,
        outcome: ConversationOutcome,
    },
    /// A Gate hold, a loop hold or the Finish hold was answered.
    HoldAnswered {
        ticket: TicketId,
        answer: HoldAnswer,
        by: Editor,
    },
    /// The Finish Ticket is Done and merged, or Closed.
    ActEnded { ticket: TicketId, done: bool },
    /// The only event not derived from facts.
    PlanEdited {
        by: Editor,
        base_rev: u64,
        edits: Vec<PlanEdit>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConversationOutcome {
    Briefed(LineBrief),
    Closed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum HoldAnswer {
    Open,
    Revise(String),
    Closed,
}

impl HoldAnswer {
    /// A Resume and its note: no note, or "approved", opens; any other note is `revise`.
    pub fn of_resume(note: Option<&str>) -> HoldAnswer {
        match note.map(crate::js::trim) {
            Some(note) if !super::approves(Some(note)) => HoldAnswer::Revise(note.to_owned()),
            _ => HoldAnswer::Open,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Editor {
    Operator,
    Steward,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    StaleRev {
        now: u64,
    },
    StewardMayNotEdit,
    Invalid(Vec<PlanProblem>),
    /// The edit would orphan live run state, or this build cannot apply it to a running Line.
    Live(String),
    LineEnded,
    FinishBlocked(Vec<Blocker>),
    NoRevise,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::StaleRev { now } => {
                write!(f, "the Plan has changed since: it is at rev {now}")
            }
            Refusal::StewardMayNotEdit => f.write_str("this Plan does not let the Steward edit it"),
            Refusal::Invalid(problems) => {
                let messages: Vec<&str> = problems.iter().map(|p| p.message.as_str()).collect();
                write!(f, "the edited Plan is not valid: {}", messages.join("; "))
            }
            Refusal::Live(why) => f.write_str(why),
            Refusal::LineEnded => f.write_str("the Line has ended"),
            Refusal::FinishBlocked(blockers) => {
                write!(f, "the Finish is waiting for: {}", blocker_list(blockers))
            }
            Refusal::NoRevise => f.write_str(
                "this Plan's Finish has no revise edge: Resume with no note to approve, or Close",
            ),
        }
    }
}

pub enum LineStart {
    /// `--work`: the entry nodes start on it; an entry Conversation node opens with it.
    Work(String),
    /// `--brief`: an entry Conversation node's pass is absorbed at once as answered with it, and
    /// entry Ticket nodes start on it.
    Brief(LineBrief),
}

// -------------------------------------------------------------------------------------------------
// Effects
// -------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Advanced {
    pub changed: bool,
    /// One line per absorbed event, for the pool log.
    pub log: Vec<String>,
    pub effects: Effects,
}

/// What the shell must make true in the pool, each entry create-if-absent by id.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Effects {
    pub tickets: Vec<NewTicket>,
    /// Written `status=checkpoint node=<id> hold`, their Interrupt raised with `brief`.
    pub holds: Vec<NewHold>,
    pub conversations: Vec<NewConversation>,
    /// The Line has ended: the shell settles the pool Done or Closed.
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
    /// The node's skill, carried as the Ticket's drivers.
    pub skill: Option<String>,
    pub check: OutcomeCheck,
    pub checkpoint: CheckpointPolicy,
    pub conflict: Option<Conflict>,
}

/// The check the attempt's exit applies to a Line Ticket's done Outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutcomeCheck {
    Agent,
    Prove,
    Review,
    /// Every `must` among the Review findings this pass reads must be accounted for, and the
    /// report for this pass must be written.
    Decide {
        musts: Vec<String>,
        report: String,
    },
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
    pub opening: String,
    pub assign: Assign,
    pub skill: Option<String>,
}

/// What a Line id is, read against the Plan and the run.
#[derive(Debug, Clone, PartialEq)]
enum Owner<'a> {
    Copy(&'a NodeId),
    Conversation(&'a NodeId),
    GateHold(&'a NodeId),
    FinishHold(&'a NodeId),
    LoopHold(&'a EdgeKey),
    Act(&'a NodeId),
}

// -------------------------------------------------------------------------------------------------
// The transition
// -------------------------------------------------------------------------------------------------

impl LineRun {
    /// The Line at Boot: the Plan frozen, a first pass delivered to every entry node, nothing
    /// written. The brief is checked against the Plan first.
    pub fn start(plan: Plan, places: LinePlaces, with: LineStart) -> Result<LineRun, String> {
        let mut run = LineRun {
            plan,
            rev: 0,
            places,
            status: LineStatus::Running,
            nodes: IndexMap::new(),
            edges: IndexMap::new(),
            settled: Vec::new(),
        };
        let entries = run.plan.entries().to_vec();
        match with {
            LineStart::Work(work) => {
                run.places.work = Some(work);
                for entry in entries {
                    run.deliver(&entry, None, Handoff::start(Vec::new()));
                }
            }
            LineStart::Brief(brief) => {
                if let Some(problem) = brief_problem(&run.plan, &brief) {
                    return Err(problem);
                }
                run.absorb_brief(&brief);
                for entry in entries {
                    if run.is_conversation(&entry) {
                        run.node_mut(&entry).passes += 1;
                        let handoff = Handoff {
                            from: Some(entry.clone()),
                            ..Handoff::start(brief.items.clone())
                        };
                        run.emit(&entry, handoff);
                    } else {
                        run.deliver(&entry, None, Handoff::start(brief.items.clone()));
                    }
                }
            }
        }
        Ok(run)
    }

    /// Facts not yet absorbed, in Plan-node order then copy order. Never mutates.
    pub fn observe(&self, facts: &dyn LineFacts) -> Vec<LineEvent> {
        let mut events = Vec::new();
        if self.ended() {
            return events;
        }
        for node in self.plan.nodes() {
            let Some(pass) = self
                .nodes
                .get(&node.id)
                .and_then(|run| run.current.as_ref())
            else {
                continue;
            };
            match &pass.work {
                PassWork::Tickets { copies, .. } => {
                    // A node that was not taught the field never fans anything out.
                    let makes_items = matches!(&node.body, NodeBody::Ticket(t) if t.makes_items);
                    for copy in copies {
                        let fact = facts.ticket(&copy.ticket);
                        let ended = matches!(fact, TicketFact::Done { .. } | TicketFact::Closed);
                        if ended && !copy.freed {
                            events.push(LineEvent::CopyFreed {
                                node: node.id.clone(),
                                ticket: copy.ticket.clone(),
                            });
                        }
                        if copy.settled.is_some() {
                            continue;
                        }
                        let settled = match fact {
                            TicketFact::Done {
                                verdict,
                                items,
                                merged: true,
                            } => {
                                Some((verdict, true, if makes_items { items } else { Vec::new() }))
                            }
                            TicketFact::Closed => Some((Verdict::Closed, false, Vec::new())),
                            _ => None,
                        };
                        if let Some((verdict, done, items)) = settled {
                            events.push(LineEvent::CopySettled {
                                node: node.id.clone(),
                                ticket: copy.ticket.clone(),
                                verdict,
                                done,
                                items,
                            });
                        }
                    }
                }
                PassWork::Conversation { id } => {
                    let outcome = match facts.conversation(id) {
                        ConversationFact::Ended {
                            brief,
                            merged: true,
                        } => Some(ConversationOutcome::Briefed(brief)),
                        ConversationFact::Closed { why } => Some(ConversationOutcome::Closed(why)),
                        _ => None,
                    };
                    if let Some(outcome) = outcome {
                        events.push(LineEvent::ConversationEnded {
                            node: node.id.clone(),
                            id: id.clone(),
                            outcome,
                        });
                    }
                }
                PassWork::Hold { ticket } | PassWork::Finish { hold: Some(ticket) } => {
                    events.extend(hold_event(ticket, facts))
                }
                PassWork::Finish { hold: None } => {}
            }
        }
        for edge in self.edges.values() {
            if let Some((ticket, _)) = &edge.held {
                events.extend(hold_event(ticket, facts));
            }
        }
        if let LineStatus::Acting { ticket } = &self.status {
            let done = match facts.ticket(ticket) {
                TicketFact::Done { merged: true, .. } => Some(true),
                TicketFact::Closed => Some(false),
                _ => None,
            };
            if let Some(done) = done {
                events.push(LineEvent::ActEnded {
                    ticket: ticket.clone(),
                    done,
                });
            }
        }
        events
    }

    /// Absorb one event. Deterministic; an event already absorbed is a no-op.
    pub fn apply(&mut self, event: LineEvent) -> Result<(), Refusal> {
        match event {
            LineEvent::CopyFreed { node, ticket } => {
                if let Some(copy) = self.copy_mut(&node, &ticket).filter(|c| !c.freed) {
                    copy.freed = true;
                    self.fill_slots(&node);
                }
            }
            LineEvent::CopySettled {
                node,
                ticket,
                verdict,
                done,
                items,
            } => self.settle(&node, &ticket, verdict, done, items),
            LineEvent::ConversationEnded { node, id, outcome } => {
                let live = matches!(
                    self.current(&node).map(|p| &p.work),
                    Some(PassWork::Conversation { id: live }) if *live == id
                );
                if live {
                    let input = self.end_pass(&node).input;
                    let handoff = match outcome {
                        ConversationOutcome::Briefed(brief) => {
                            self.absorb_brief(&brief);
                            Handoff {
                                from: Some(node.clone()),
                                ..Handoff::start(brief.items)
                            }
                        }
                        ConversationOutcome::Closed(why) => Handoff {
                            from: Some(node.clone()),
                            verdict: Verdict::Closed,
                            items: Vec::new(),
                            after: Vec::new(),
                            notes: None,
                            halted: Some(why).or(input.halted),
                        },
                    };
                    self.emit(&node, handoff);
                    self.next_from_inbox(&node);
                }
            }
            LineEvent::HoldAnswered { ticket, answer, by } => self.answer_hold(&ticket, answer, by),
            LineEvent::ActEnded { ticket, done } => {
                if matches!(&self.status, LineStatus::Acting { ticket: t } if *t == ticket) {
                    self.status = if done {
                        LineStatus::Done
                    } else {
                        LineStatus::Closed
                    };
                }
            }
            LineEvent::PlanEdited {
                by,
                base_rev,
                edits,
            } => {
                if self.ended() {
                    return Err(Refusal::LineEnded);
                }
                if by == Editor::Steward && !self.plan.meta().steward_edits {
                    return Err(Refusal::StewardMayNotEdit);
                }
                if base_rev != self.rev {
                    return Err(Refusal::StaleRev { now: self.rev });
                }
                self.plan.edit(&edits).map_err(Refusal::Invalid)?;
                return Err(Refusal::Live(
                    "editing a running Line's Plan is not in this build yet".to_owned(),
                ));
            }
        }
        Ok(())
    }

    /// observe/apply to a fixpoint, then the Finish, then the projection. The engine's one call.
    pub fn advance(&mut self, facts: &dyn LineFacts) -> Advanced {
        let before = self.clone();
        let mut log = Vec::new();
        loop {
            let events = self.observe(facts);
            if events.is_empty() {
                break;
            }
            for event in events {
                log.push(describe(&event));
                // Derived events are never refused.
                let _ = self.apply(event);
            }
        }
        if matches!(
            self.status,
            LineStatus::Running | LineStatus::Finishing { .. }
        ) {
            let finish = self.plan.finish().clone();
            if let Some(n) = self.current(&finish).map(|p| p.n) {
                let waiting_for = self.blockers(facts);
                if let Some(Pass {
                    work: PassWork::Finish { hold },
                    ..
                }) = self.node_mut(&finish).current.as_mut()
                    && hold.is_none()
                    && waiting_for.is_empty()
                {
                    *hold = Some(TicketId(format!("{finish}-{n}")));
                    log.push(format!("line: the Finish holds at {finish}-{n}"));
                }
                self.status = LineStatus::Finishing { waiting_for };
            }
        }
        Advanced {
            changed: *self != before,
            log,
            effects: self.effects(facts),
        }
    }

    /// Everything the run names that the pool does not have yet. Pure.
    pub fn effects(&self, facts: &dyn LineFacts) -> Effects {
        let mut effects = Effects::default();
        if self.ended() {
            effects.ended = Some(self.status.clone());
            return effects;
        }
        for node in self.plan.nodes() {
            let Some(pass) = self.current(&node.id) else {
                continue;
            };
            match (&pass.work, &node.body) {
                (PassWork::Tickets { copies, .. }, NodeBody::Ticket(t)) => {
                    for copy in copies {
                        if facts.ticket(&copy.ticket) == TicketFact::Unwritten {
                            effects
                                .tickets
                                .push(text::copy_ticket(self, node, t, pass, copy, facts));
                        }
                    }
                }
                (PassWork::Conversation { id }, _)
                    if facts.conversation(id) == ConversationFact::Unopened =>
                {
                    effects
                        .conversations
                        .push(text::conversation(self, node, pass, id));
                }
                (PassWork::Hold { ticket }, _) if facts.ticket(ticket) == TicketFact::Unwritten => {
                    effects
                        .holds
                        .push(text::gate_hold(self, node, pass, ticket));
                }
                (PassWork::Finish { hold: Some(ticket) }, _)
                    if facts.ticket(ticket) == TicketFact::Unwritten =>
                {
                    effects
                        .holds
                        .push(text::finish_hold(self, node, pass, ticket, facts));
                }
                _ => {}
            }
        }
        for (key, edge) in &self.edges {
            if let Some((ticket, handoff)) = &edge.held
                && facts.ticket(ticket) == TicketFact::Unwritten
            {
                effects
                    .holds
                    .push(text::loop_hold(self, key, edge, ticket, handoff));
            }
        }
        if let LineStatus::Acting { ticket } = &self.status
            && facts.ticket(ticket) == TicketFact::Unwritten
        {
            effects.tickets.push(text::act_ticket(self, ticket));
        }
        effects
    }

    /// What the Finish waits for: the Line's unsettled copies, queued items, inbox handoffs, Gate
    /// and loop holds, open Conversation passes, then what lies outside the Line. A `join: all`
    /// Gate still collecting, and a parked handoff, do not block.
    pub fn blockers(&self, facts: &dyn LineFacts) -> Vec<Blocker> {
        let mut blockers = Vec::new();
        for node in self.plan.nodes() {
            let Some(run) = self.nodes.get(&node.id) else {
                continue;
            };
            if let Some(pass) = &run.current {
                match &pass.work {
                    PassWork::Tickets { copies, queue, .. } => {
                        blockers.extend(
                            copies
                                .iter()
                                .filter(|c| c.settled.is_none())
                                .map(|c| Blocker::Copy(c.ticket.clone())),
                        );
                        if !queue.is_empty() {
                            blockers.push(Blocker::Queued {
                                node: node.id.clone(),
                                items: queue.len(),
                            });
                        }
                    }
                    PassWork::Conversation { id } => {
                        blockers.push(Blocker::Conversation(id.clone()));
                    }
                    PassWork::Hold { ticket } => blockers.push(Blocker::Hold(ticket.clone())),
                    PassWork::Finish { .. } => {}
                }
            }
            if !run.inbox.is_empty() {
                blockers.push(Blocker::Inbox {
                    node: node.id.clone(),
                    handoffs: run.inbox.len(),
                });
            }
        }
        blockers.extend(
            self.edges
                .values()
                .filter_map(|e| e.held.as_ref())
                .map(|(ticket, _)| Blocker::Hold(ticket.clone())),
        );
        blockers.extend(facts.outside_blockers());
        blockers
    }

    /// Asked when an answer on a Line Ticket is accepted and again when it drains. On the live
    /// Finish hold an approval while anything blocks is refused with the list, and notes are refused
    /// when the Finish has no `revise` edge. Every other answer passes.
    pub fn check_answer(
        &self,
        ticket: &TicketId,
        answer: &HoldAnswer,
        facts: &dyn LineFacts,
    ) -> Result<(), Refusal> {
        let finish = self.plan.finish();
        let live_hold = matches!(
            self.current(finish).map(|p| &p.work),
            Some(PassWork::Finish { hold: Some(hold) }) if hold == ticket
        );
        if !live_hold {
            return Ok(());
        }
        match answer {
            HoldAnswer::Open => {
                let blockers = self.blockers(facts);
                if blockers.is_empty() {
                    Ok(())
                } else {
                    Err(Refusal::FinishBlocked(blockers))
                }
            }
            HoldAnswer::Revise(_) if self.plan.out(finish, Verdict::Revise).next().is_none() => {
                Err(Refusal::NoRevise)
            }
            HoldAnswer::Revise(_) | HoldAnswer::Closed => Ok(()),
        }
    }

    /// Whether the Steward may answer this Line Ticket's Interrupt: a copy of a node on
    /// `checkpoint: steward`, the hold of a Gate that opens `steward`, or a spent loop's hold on a
    /// `stewardExtra` edge the Steward has not answered since its last reset. Never the Finish hold,
    /// never the Finish Ticket, never anything once the Line has ended.
    pub fn steward_may_answer(&self, ticket: &TicketId) -> bool {
        if self.ended() {
            return false;
        }
        match self.owner(ticket) {
            Some(Owner::Copy(node)) => matches!(
                self.plan.node(node).map(|n| &n.body),
                Some(NodeBody::Ticket(t)) if t.checkpoint == CheckpointPolicy::Steward
            ),
            Some(Owner::GateHold(node)) => matches!(
                self.plan.node(node).map(|n| &n.body),
                Some(NodeBody::Gate(g)) if g.open == Opener::Steward
            ),
            Some(Owner::LoopHold(key)) => {
                let extra = self
                    .plan
                    .edges()
                    .iter()
                    .find(|e| e.key == *key)
                    .and_then(|e| e.cap.as_ref())
                    .is_some_and(|cap| cap.steward_extra);
                extra && self.edges.get(key).is_some_and(|e| !e.steward_used)
            }
            Some(Owner::FinishHold(_) | Owner::Act(_) | Owner::Conversation(_)) | None => false,
        }
    }

    pub fn status(&self) -> &LineStatus {
        &self.status
    }

    pub fn plan(&self) -> (&Plan, u64) {
        (&self.plan, self.rev)
    }

    /// Whether this id is one of the Line's, and which node wrote it (a loop hold's is the node its
    /// edge leaves).
    pub fn node_of(&self, ticket: &TicketId) -> Option<&NodeId> {
        Some(match self.owner(ticket)? {
            Owner::Copy(node)
            | Owner::Conversation(node)
            | Owner::GateHold(node)
            | Owner::FinishHold(node)
            | Owner::Act(node) => node,
            Owner::LoopHold(key) => &key.from,
        })
    }

    /// Whether this id is a hold Ticket of the Line's: no agent runs it.
    pub fn is_hold(&self, ticket: &TicketId) -> bool {
        matches!(
            self.owner(ticket),
            Some(Owner::GateHold(_) | Owner::FinishHold(_) | Owner::LoopHold(_))
        )
    }

    /// The live Conversation pass of `node`, if it has one.
    pub fn live_conversation(&self, node: &NodeId) -> Option<&TicketId> {
        match &self.current(node)?.work {
            PassWork::Conversation { id } => Some(id),
            _ => None,
        }
    }

    /// The check a Line Ticket's done Outcome must pass at its exit, `None` for an id that runs no
    /// agent or is not the Line's.
    pub fn outcome_check(&self, ticket: &TicketId, facts: &dyn LineFacts) -> Option<OutcomeCheck> {
        match self.owner(ticket)? {
            Owner::Copy(node) => {
                let NodeBody::Ticket(t) = &self.plan.node(node)?.body else {
                    return None;
                };
                Some(match t.kind {
                    TicketKind::Agent => OutcomeCheck::Agent,
                    TicketKind::Prove => OutcomeCheck::Prove,
                    TicketKind::Review => OutcomeCheck::Review,
                    TicketKind::Decide => {
                        let pass = self.current(node);
                        OutcomeCheck::Decide {
                            musts: pass
                                .map(|p| text::musts(&p.reads, facts))
                                .unwrap_or_default(),
                            report: self.report_path(
                                node,
                                pass.map_or_else(|| self.passes(node), |p| p.n),
                                &facts.runs_dir(),
                            ),
                        }
                    }
                })
            }
            Owner::Act(_) => Some(OutcomeCheck::FinishAct(self.finish_act().clone())),
            _ => None,
        }
    }

    /// Where a Decide pass writes its report: `<runs>/<line>-<node>-<pass>-report.html`.
    pub fn report_path(&self, node: &NodeId, pass: u32, runs_dir: &str) -> String {
        format!(
            "{}/{}-{node}-{pass}{}",
            runs_dir.trim_end_matches('/'),
            super::line_name_of(&self.places.branch),
            super::REPORT_SUFFIX
        )
    }

    // --- steps the transitions share ---------------------------------------------------------

    fn ended(&self) -> bool {
        matches!(self.status, LineStatus::Done | LineStatus::Closed)
    }

    fn node_mut(&mut self, node: &NodeId) -> &mut NodeRun {
        self.nodes.entry(node.clone()).or_default()
    }

    fn current(&self, node: &NodeId) -> Option<&Pass> {
        self.nodes.get(node)?.current.as_ref()
    }

    fn passes(&self, node: &NodeId) -> u32 {
        self.nodes.get(node).map_or(0, |run| run.passes)
    }

    fn is_conversation(&self, node: &NodeId) -> bool {
        matches!(
            self.plan.node(node).map(|n| &n.body),
            Some(NodeBody::Conversation(_))
        )
    }

    fn finish_act(&self) -> &FinishAct {
        match self.plan.node(self.plan.finish()).map(|n| &n.body) {
            Some(NodeBody::Finish(finish)) => &finish.act,
            _ => &FinishAct::None,
        }
    }

    fn copy_mut(&mut self, node: &NodeId, ticket: &TicketId) -> Option<&mut CopyRun> {
        match &mut self.nodes.get_mut(node)?.current.as_mut()?.work {
            PassWork::Tickets { copies, .. } => copies.iter_mut().find(|c| c.ticket == *ticket),
            _ => None,
        }
    }

    fn end_pass(&mut self, node: &NodeId) -> Pass {
        self.node_mut(node)
            .current
            .take()
            .expect("a pass ends only while it is live")
    }

    fn next_from_inbox(&mut self, node: &NodeId) {
        if self.current(node).is_none()
            && let Some(handoff) = self.node_mut(node).inbox.pop_front()
        {
            self.start_pass(node, handoff);
        }
    }

    /// Start queued items while fewer than the cap's copies are live.
    fn fill_slots(&mut self, node: &NodeId) {
        let run = self.node_mut(node);
        let Some(pass) = run.current.as_mut() else {
            return;
        };
        let n = pass.n;
        let PassWork::Tickets {
            copies,
            queue,
            cap,
            next_seq,
        } = &mut pass.work
        else {
            return;
        };
        while !queue.is_empty() && cap_allows(*cap, copies.iter().filter(|c| !c.freed).count()) {
            let item = queue.pop_front();
            copies.push(CopyRun {
                ticket: TicketId(format!("{node}-{n}.{next_seq}")),
                item,
                freed: false,
                settled: None,
            });
            *next_seq += 1;
        }
    }

    fn settle(
        &mut self,
        node: &NodeId,
        ticket: &TicketId,
        verdict: Verdict,
        done: bool,
        items: Vec<Item>,
    ) {
        let has_merger = self.plan.merger_of(node).is_some();
        let Some(copy) = self.copy_mut(node, ticket).filter(|c| c.settled.is_none()) else {
            return;
        };
        copy.settled = Some(Settled {
            verdict,
            done,
            items: items.clone(),
        });
        if done {
            self.settled.push(ticket.clone());
        }
        let input_halted = self.current(node).and_then(|p| p.input.halted.clone());
        if !has_merger {
            let handoff = Handoff {
                from: Some(node.clone()),
                verdict,
                items,
                after: if done {
                    vec![ticket.clone()]
                } else {
                    Vec::new()
                },
                notes: None,
                halted: if done {
                    input_halted
                } else {
                    Some(format!("{ticket} was closed"))
                },
            };
            self.emit(node, handoff);
        }
        self.complete_pass_if_done(node);
    }

    /// A Ticket pass is done when every copy settled and nothing is queued. With a Merger the pass
    /// hands on one verdict: `closed` if any copy closed, else the first one that is not the kind's
    /// ok verdict, else the ok verdict.
    fn complete_pass_if_done(&mut self, node: &NodeId) {
        let Some(Pass {
            work: PassWork::Tickets { copies, queue, .. },
            ..
        }) = self.current(node)
        else {
            return;
        };
        if !queue.is_empty() || copies.iter().any(|c| c.settled.is_none()) {
            return;
        }
        let pass = self.end_pass(node);
        if self.plan.merger_of(node).is_some() {
            let PassWork::Tickets { copies, .. } = &pass.work else {
                unreachable!("matched above")
            };
            let settled: Vec<(&TicketId, &Settled)> = copies
                .iter()
                .filter_map(|c| c.settled.as_ref().map(|s| (&c.ticket, s)))
                .collect();
            let ok = self
                .plan
                .vocabulary(node)
                .first()
                .copied()
                .unwrap_or(Verdict::Done);
            let verdict = if settled.iter().any(|(_, s)| s.verdict == Verdict::Closed) {
                Verdict::Closed
            } else {
                settled
                    .iter()
                    .map(|(_, s)| s.verdict)
                    .find(|v| *v != ok)
                    .unwrap_or(ok)
            };
            let closed: Vec<String> = settled
                .iter()
                .filter(|(_, s)| s.verdict == Verdict::Closed)
                .map(|(t, _)| format!("{t} was closed"))
                .collect();
            let handoff = Handoff {
                from: Some(node.clone()),
                verdict,
                items: settled.iter().flat_map(|(_, s)| s.items.clone()).collect(),
                after: settled
                    .iter()
                    .filter(|(_, s)| s.done)
                    .map(|(t, _)| (*t).clone())
                    .collect(),
                notes: None,
                halted: if closed.is_empty() {
                    pass.input.halted.clone()
                } else {
                    Some(closed.join("; "))
                },
            };
            self.emit(node, handoff);
        }
        self.next_from_inbox(node);
    }

    /// Fan a verdict out to every matching edge. With none, `closed` goes to the Finish and any
    /// other verdict parks on its node.
    fn emit(&mut self, node: &NodeId, handoff: Handoff) {
        let edges: Vec<EdgeKey> = self
            .plan
            .out(node, handoff.verdict)
            .map(|e| e.key.clone())
            .collect();
        if edges.is_empty() {
            if handoff.verdict == Verdict::Closed {
                let finish = self.plan.finish().clone();
                self.deliver(&finish, None, handoff);
            } else {
                self.node_mut(node).parked.insert(handoff.verdict, handoff);
            }
            return;
        }
        for edge in edges {
            self.traverse(&edge, handoff.clone());
        }
    }

    /// Cross one edge. A loop edge resets the capped loops nested in its cycle; a capped one counts,
    /// and once spent sends the handoff to its `whenSpent` node or holds it.
    fn traverse(&mut self, key: &EdgeKey, handoff: Handoff) {
        let cap = self
            .plan
            .edges()
            .iter()
            .find(|e| e.key == *key)
            .and_then(|e| e.cap.clone());
        if let Some(cap) = &cap {
            let max = cap.max.get();
            let edge = self.edges.entry(key.clone()).or_default();
            if edge.count >= max + edge.bought {
                let spent = format!(
                    "the loop {} -> {} is spent ({} of {})",
                    key.from,
                    key.to,
                    edge.count,
                    max + edge.bought
                );
                match &cap.when_spent {
                    WhenSpent::To(to) => {
                        let to = to.clone();
                        let handoff = Handoff {
                            halted: Some(spent),
                            ..handoff
                        };
                        self.deliver(&to, None, handoff);
                    }
                    WhenSpent::Hold => {
                        let held = match edge.held.take() {
                            Some((ticket, earlier)) => (ticket, earlier.join(handoff)),
                            None => (
                                TicketId(format!(
                                    "{}-{}-{}-{}",
                                    key.from,
                                    key.on.as_str(),
                                    key.to,
                                    edge.traversals + 1
                                )),
                                handoff,
                            ),
                        };
                        edge.held = Some(held);
                    }
                }
                return;
            }
            edge.count += 1;
            edge.traversals += 1;
        }
        if self.plan.is_loop(key) {
            for nested in self.plan.nested_loops(key).to_vec() {
                if let Some(inner) = self.edges.get_mut(&nested) {
                    inner.count = 0;
                    inner.bought = 0;
                    inner.steward_used = false;
                }
            }
        }
        self.deliver(&key.to.clone(), Some(key), handoff);
    }

    fn deliver(&mut self, node: &NodeId, via: Option<&EdgeKey>, handoff: Handoff) {
        let Some(body) = self.plan.node(node).map(|n| n.body.clone()) else {
            return;
        };
        match body {
            NodeBody::Merger(_) => {
                let handoff = Handoff {
                    from: Some(node.clone()),
                    ..handoff
                };
                self.emit(node, handoff);
            }
            NodeBody::Gate(gate) => {
                let handoff = match (gate.join, via) {
                    (Join::All, Some(via)) => {
                        let run = self.node_mut(node);
                        run.arrived.insert(via.clone(), handoff);
                        let incoming: Vec<EdgeKey> =
                            self.plan.incoming(node).map(|e| e.key.clone()).collect();
                        let run = self.node_mut(node);
                        if !incoming.iter().all(|e| run.arrived.contains_key(e)) {
                            return;
                        }
                        let mut arrivals = std::mem::take(&mut run.arrived).into_values();
                        let first = arrivals.next().expect("every incoming edge arrived");
                        arrivals.fold(first, Handoff::join)
                    }
                    _ => handoff,
                };
                if gate.open == Opener::Auto {
                    let handoff = Handoff {
                        from: Some(node.clone()),
                        verdict: Verdict::Open,
                        notes: None,
                        ..handoff
                    };
                    self.emit(node, handoff);
                } else {
                    self.start_or_queue(node, handoff);
                }
            }
            NodeBody::Ticket(_) | NodeBody::Conversation(_) | NodeBody::Finish(_) => {
                self.start_or_queue(node, handoff);
            }
        }
    }

    fn start_or_queue(&mut self, node: &NodeId, handoff: Handoff) {
        if self.current(node).is_some() {
            self.node_mut(node).inbox.push_back(handoff);
        } else {
            self.start_pass(node, handoff);
        }
    }

    fn start_pass(&mut self, node: &NodeId, input: Handoff) {
        let Some(body) = self.plan.node(node).map(|n| n.body.clone()) else {
            return;
        };
        let n = self.passes(node) + 1;
        let id = TicketId(format!("{node}-{n}"));
        let mut reads = Vec::new();
        let work = match body {
            NodeBody::Ticket(t) => {
                if t.kind == TicketKind::Decide {
                    reads = text::reads_before(self, node, self.settled.len());
                }
                match t.copies {
                    Copies::PerItem { cap } if !input.items.is_empty() => PassWork::Tickets {
                        copies: Vec::new(),
                        queue: input.items.iter().cloned().collect(),
                        cap,
                        next_seq: 1,
                    },
                    _ => PassWork::Tickets {
                        copies: vec![CopyRun {
                            ticket: id,
                            item: None,
                            freed: false,
                            settled: None,
                        }],
                        queue: VecDeque::new(),
                        cap: Cap::All,
                        next_seq: 1,
                    },
                }
            }
            NodeBody::Conversation(_) => PassWork::Conversation { id },
            NodeBody::Gate(_) => PassWork::Hold { ticket: id },
            NodeBody::Finish(_) => {
                if self.status == LineStatus::Running {
                    self.status = LineStatus::Finishing {
                        waiting_for: Vec::new(),
                    };
                }
                PassWork::Finish { hold: None }
            }
            NodeBody::Merger(_) => return,
        };
        let run = self.node_mut(node);
        run.passes = n;
        run.current = Some(Pass {
            n,
            input,
            work,
            reads,
        });
        self.fill_slots(node);
    }

    fn answer_hold(&mut self, ticket: &TicketId, answer: HoldAnswer, by: Editor) {
        if let Some(key) = self
            .edges
            .iter()
            .find(|(_, e)| e.held.as_ref().is_some_and(|(t, _)| t == ticket))
            .map(|(k, _)| k.clone())
        {
            let edge = self.edges.get_mut(&key).expect("found above");
            let (_, held) = edge.held.take().expect("found above");
            if by == Editor::Steward {
                edge.steward_used = true;
            }
            match answer {
                HoldAnswer::Open | HoldAnswer::Revise(_) => {
                    edge.bought += 1;
                    let notes = match answer {
                        HoldAnswer::Revise(notes) => Some(notes),
                        _ => held.notes.clone(),
                    };
                    let mut after = held.after.clone();
                    after.push(ticket.clone());
                    let handoff = Handoff {
                        after,
                        notes,
                        ..held
                    };
                    self.traverse(&key, handoff);
                }
                HoldAnswer::Closed => {
                    let handoff = Handoff {
                        from: Some(key.from.clone()),
                        verdict: Verdict::Closed,
                        notes: None,
                        halted: Some(format!("the loop {} -> {} was stopped", key.from, key.to)),
                        ..held
                    };
                    self.emit(&key.from.clone(), handoff);
                }
            }
            return;
        }
        let Some(node) = self
            .nodes
            .iter()
            .find(|(_, run)| {
                matches!(
                    run.current.as_ref().map(|p| &p.work),
                    Some(PassWork::Hold { ticket: t } | PassWork::Finish { hold: Some(t) })
                        if t == ticket
                )
            })
            .map(|(node, _)| node.clone())
        else {
            return;
        };
        let pass = self.end_pass(&node);
        let is_finish = matches!(pass.work, PassWork::Finish { .. });
        let mut after = vec![ticket.clone()];
        after.extend(pass.input.after.iter().cloned());
        // Notes are a person's answer to whatever halted the work upstream, so revised work starts
        // without the halt: a Decide downstream may choose another round again.
        let onward = |verdict: Verdict, notes: Option<String>| Handoff {
            from: Some(node.clone()),
            verdict,
            items: pass.input.items.clone(),
            after: after.clone(),
            halted: notes.is_none().then(|| pass.input.halted.clone()).flatten(),
            notes,
        };
        match (is_finish, answer) {
            (true, HoldAnswer::Open) => {
                self.status = match self.finish_act() {
                    FinishAct::None => LineStatus::Done,
                    _ => LineStatus::Acting {
                        ticket: TicketId(format!("{ticket}-act")),
                    },
                };
            }
            (true, HoldAnswer::Closed) => self.status = LineStatus::Closed,
            (true, HoldAnswer::Revise(notes)) => {
                self.status = LineStatus::Running;
                self.emit(&node, onward(Verdict::Revise, Some(notes)));
            }
            (false, HoldAnswer::Open) => self.emit(&node, onward(Verdict::Open, None)),
            (false, HoldAnswer::Revise(notes)) => {
                self.emit(&node, onward(Verdict::Revise, Some(notes)));
            }
            (false, HoldAnswer::Closed) => {
                let handoff = Handoff {
                    after: pass.input.after.clone(),
                    halted: Some(format!("{ticket} was closed")),
                    ..onward(Verdict::Closed, None)
                };
                self.emit(&node, handoff);
            }
        }
        self.next_from_inbox(&node);
    }

    /// A Line brief's spec and `pushBase` go to the Line; its finish and node overrides are
    /// operator edits on the frozen Plan, made with no rev check.
    fn absorb_brief(&mut self, brief: &LineBrief) {
        if let Some(spec) = &brief.spec {
            self.places.spec = Some(spec.clone());
        }
        if let Some(push_base) = brief.push_base {
            self.places.push_base = push_base;
        }
        let mut edits = Vec::new();
        if let Some(act) = &brief.finish
            && let Some(node) = self.plan.node(self.plan.finish())
            && let NodeBody::Finish(finish) = &node.body
        {
            edits.push(PlanEdit::SetNode {
                id: node.id.clone(),
                title: node.title.clone(),
                body: NodeBody::Finish(FinishNode {
                    act: act.clone(),
                    assign: finish.assign.clone(),
                }),
            });
        }
        for (id, change) in &brief.nodes {
            if let Some(node) = self.plan.node(id)
                && let Some(body) = change.apply(&node.body)
            {
                edits.push(PlanEdit::SetNode {
                    id: id.clone(),
                    title: node.title.clone(),
                    body,
                });
            }
        }
        if !edits.is_empty()
            && let Ok(edited) = self.plan.edit(&edits)
            && edited.plan != self.plan
        {
            self.plan = edited.plan;
            self.rev += 1;
        }
    }

    fn owner(&self, ticket: &TicketId) -> Option<Owner<'_>> {
        let id = ticket.as_str();
        let finish = self.plan.finish();
        if let Some(n) = id
            .strip_suffix("-act")
            .and_then(|rest| pass_number(rest, finish.as_str()))
            && n <= self.passes(finish)
        {
            return Some(Owner::Act(finish));
        }
        for key in self.edges.keys() {
            let prefix = format!("{}-{}-{}", key.from, key.on.as_str(), key.to);
            if pass_number(id, &prefix).is_some() {
                return Some(Owner::LoopHold(key));
            }
        }
        for node in self.plan.nodes() {
            let passes = self.passes(&node.id);
            let Some(rest) = id
                .strip_prefix(node.id.as_str())
                .and_then(|r| r.strip_prefix('-'))
            else {
                continue;
            };
            let (pass, seq) = match rest.split_once('.') {
                Some((pass, seq)) => (pass, Some(seq)),
                None => (rest, None),
            };
            let numbered = digits(pass).is_some_and(|n| (1..=passes).contains(&n));
            if !numbered || seq.is_some_and(|s| digits(s).is_none()) {
                continue;
            }
            return match (&node.body, seq) {
                (NodeBody::Ticket(_), _) => Some(Owner::Copy(&node.id)),
                (NodeBody::Conversation(_), None) => Some(Owner::Conversation(&node.id)),
                (NodeBody::Gate(_), None) => Some(Owner::GateHold(&node.id)),
                (NodeBody::Finish(_), None) => Some(Owner::FinishHold(&node.id)),
                _ => None,
            };
        }
        None
    }
}

impl Handoff {
    fn start(items: Vec<Item>) -> Handoff {
        Handoff {
            from: None,
            verdict: Verdict::Done,
            items,
            after: Vec::new(),
            notes: None,
            halted: None,
        }
    }

    /// Two handoffs as one: items and `after` concatenated, notes and halts joined.
    fn join(self, other: Handoff) -> Handoff {
        let both = |a: Option<String>, b: Option<String>| match (a, b) {
            (Some(a), Some(b)) => Some(format!("{a}\n\n{b}")),
            (a, b) => a.or(b),
        };
        let mut after = self.after;
        after.extend(other.after);
        let mut items = self.items;
        items.extend(other.items);
        Handoff {
            from: self.from,
            verdict: self.verdict,
            items,
            after,
            notes: both(self.notes, other.notes),
            halted: both(self.halted, other.halted),
        }
    }
}

fn cap_allows(cap: Cap, live: usize) -> bool {
    match cap {
        Cap::All => true,
        Cap::At(max) => live < max.get() as usize,
    }
}

fn digits(text: &str) -> Option<u32> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// `{prefix}-{n}` gives `n`.
fn pass_number(id: &str, prefix: &str) -> Option<u32> {
    digits(id.strip_prefix(prefix)?.strip_prefix('-')?)
}

fn hold_event(ticket: &TicketId, facts: &dyn LineFacts) -> Option<LineEvent> {
    let (answer, by) = match facts.ticket(ticket) {
        TicketFact::Answered { note, by_steward } => (
            HoldAnswer::of_resume(note.as_deref()),
            if by_steward {
                Editor::Steward
            } else {
                Editor::Operator
            },
        ),
        TicketFact::Closed => (HoldAnswer::Closed, Editor::Operator),
        _ => return None,
    };
    Some(LineEvent::HoldAnswered {
        ticket: ticket.clone(),
        answer,
        by,
    })
}

fn describe(event: &LineEvent) -> String {
    match event {
        LineEvent::CopyFreed { ticket, .. } => format!("line: {ticket} ended"),
        LineEvent::CopySettled {
            ticket, verdict, ..
        } => format!("line: {ticket} hands on {}", verdict.as_str()),
        LineEvent::ConversationEnded { id, outcome, .. } => match outcome {
            ConversationOutcome::Briefed(_) => format!("line: {id} hands on its brief"),
            ConversationOutcome::Closed(_) => format!("line: {id} hands on closed"),
        },
        LineEvent::HoldAnswered { ticket, answer, .. } => {
            let word = match answer {
                HoldAnswer::Open => "open",
                HoldAnswer::Revise(_) => "revise",
                HoldAnswer::Closed => "closed",
            };
            format!("line: {ticket} answered {word}")
        }
        LineEvent::ActEnded { ticket, done } => {
            format!("line: {ticket} {}", if *done { "done" } else { "closed" })
        }
        LineEvent::PlanEdited { base_rev, .. } => format!("line: plan edited at rev {base_rev}"),
    }
}
