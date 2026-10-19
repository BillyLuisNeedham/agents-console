//! `line.json` (`ac_protocol::LineFile`) and the live graph (`LineGraphView`): the run state in its
//! wire shape and back. Loading re-validates the frozen Plan, and every id and verdict is parsed
//! against it.

use std::collections::VecDeque;
use std::num::NonZeroU32;

use ac_protocol::wire::{
    AllItems, LineArrivalFile, LineConversationWork, LineCopyFile, LineEdgeKey, LineEdgeRunFile,
    LineEdgeView, LineFile, LineFinishWork, LineGraphView, LineHandoffFile, LineHeldFile,
    LineHoldWork, LineItem, LineNodeRunFile, LineNodeView, LinePassFile, LinePassWorkFile,
    LinePlacesFile, LineRunFile, LineRunStatus, LineSettledFile, LineTicketsWork, PlanCap,
};
use indexmap::IndexMap;

use super::{
    CopyRun, EdgeRun, Handoff, Item, LinePlaces, LineRun, LineStatus, NodeRun, Pass, PassWork,
    Settled, TicketId,
};
use crate::plan::{Cap, EdgeKey, HORDE_VERSION, NodeId, Plan, Verdict};

/// The refusal for a `line.json` written before Plans.
pub const OLD_LINE_FILE: &str = "line.json is from before Plans (ADR-0040); start a new Line";

fn item_file(item: &Item) -> LineItem {
    LineItem {
        title: item.title.clone(),
        body: item.body.clone(),
    }
}

fn ids(tickets: &[TicketId]) -> Vec<String> {
    tickets.iter().map(|t| t.0.clone()).collect()
}

fn edge_file(key: &EdgeKey) -> LineEdgeKey {
    LineEdgeKey {
        from: key.from.to_string(),
        on: key.on.as_str().to_owned(),
        to: key.to.to_string(),
    }
}

fn handoff_file(handoff: &Handoff) -> LineHandoffFile {
    LineHandoffFile {
        from: handoff.from.as_ref().map(NodeId::to_string),
        verdict: handoff.verdict.as_str().to_owned(),
        items: handoff.items.iter().map(item_file).collect(),
        after: ids(&handoff.after),
        notes: handoff.notes.clone(),
        halted: handoff.halted.clone(),
    }
}

fn cap_file(cap: Cap) -> PlanCap {
    match cap {
        Cap::At(n) => PlanCap::At(n.get()),
        Cap::All => PlanCap::All(AllItems::All),
    }
}

fn status_file(status: &LineStatus) -> (LineRunStatus, Option<String>) {
    match status {
        LineStatus::Running => (LineRunStatus::Running, None),
        LineStatus::Finishing { .. } => (LineRunStatus::Finishing, None),
        LineStatus::Acting { ticket } => (LineRunStatus::Acting, Some(ticket.0.clone())),
        LineStatus::Done => (LineRunStatus::Done, None),
        LineStatus::Closed => (LineRunStatus::Closed, None),
    }
}

fn work_file(work: &PassWork) -> LinePassWorkFile {
    match work {
        PassWork::Tickets {
            copies,
            queue,
            cap,
            next_seq,
        } => LinePassWorkFile::Tickets(LineTicketsWork {
            copies: copies
                .iter()
                .map(|copy| LineCopyFile {
                    ticket: copy.ticket.0.clone(),
                    item: copy.item.as_ref().map(item_file),
                    freed: copy.freed,
                    settled: copy.settled.as_ref().map(|s| LineSettledFile {
                        verdict: s.verdict.as_str().to_owned(),
                        done: s.done,
                        items: s.items.iter().map(item_file).collect(),
                    }),
                })
                .collect(),
            queue: queue.iter().map(item_file).collect(),
            cap: cap_file(*cap),
            next_seq: *next_seq,
        }),
        PassWork::Conversation { id } => {
            LinePassWorkFile::Conversation(LineConversationWork { id: id.0.clone() })
        }
        PassWork::Hold { ticket } => LinePassWorkFile::Hold(LineHoldWork {
            ticket: ticket.0.clone(),
        }),
        PassWork::Finish { hold } => LinePassWorkFile::Finish(LineFinishWork {
            hold: hold.as_ref().map(|t| t.0.clone()),
        }),
    }
}

impl LineRun {
    /// `line.json`'s shape. The Finish's `waiting_for` is not written: the next advance recomputes it.
    pub fn to_file(&self) -> LineFile {
        let (status, act) = status_file(&self.status);
        LineFile {
            horde: HORDE_VERSION,
            plan: self.plan.to_file(),
            rev: self.rev,
            places: LinePlacesFile {
                branch: self.places.branch.clone(),
                base: self.places.base.clone(),
                spec: self.places.spec.clone(),
                push_base: self.places.push_base,
                work: self.places.work.clone(),
            },
            run: LineRunFile {
                status,
                act,
                nodes: self
                    .nodes
                    .iter()
                    .map(|(id, run)| LineNodeRunFile {
                        id: id.to_string(),
                        passes: run.passes,
                        current: run.current.as_ref().map(|pass| LinePassFile {
                            n: pass.n,
                            input: handoff_file(&pass.input),
                            work: work_file(&pass.work),
                            reads: ids(&pass.reads),
                        }),
                        inbox: run.inbox.iter().map(handoff_file).collect(),
                        parked: run.parked.values().map(handoff_file).collect(),
                        arrived: run
                            .arrived
                            .iter()
                            .map(|(edge, handoff)| LineArrivalFile {
                                edge: edge_file(edge),
                                handoff: handoff_file(handoff),
                            })
                            .collect(),
                    })
                    .collect(),
                edges: self
                    .edges
                    .iter()
                    .map(|(key, edge)| LineEdgeRunFile {
                        edge: edge_file(key),
                        count: edge.count,
                        traversals: edge.traversals,
                        bought: edge.bought,
                        steward_used: edge.steward_used,
                        held: edge.held.as_ref().map(|(ticket, handoff)| LineHeldFile {
                            ticket: ticket.0.clone(),
                            handoff: handoff_file(handoff),
                        }),
                    })
                    .collect(),
                settled: ids(&self.settled),
            },
        }
    }

    /// `line.json`'s canonical text.
    pub fn to_json(&self) -> String {
        format!("{}\n", crate::js::to_json_pretty(&self.to_file()))
    }

    /// `line.json`'s text read back: a file without `horde` is from before Plans and is refused.
    pub fn from_json(text: &str) -> Result<LineRun, String> {
        let value = crate::js::parse(text).map_err(|e| format!("line.json is not JSON: {e}"))?;
        if value.get("horde").is_none() {
            return Err(OLD_LINE_FILE.to_owned());
        }
        let file: LineFile =
            serde_json::from_value(value).map_err(|e| format!("line.json: {e}"))?;
        LineRun::from_file(file)
    }

    /// The run from `line.json`'s shape, its frozen Plan validated again and every id and verdict
    /// read against it.
    pub fn from_file(file: LineFile) -> Result<LineRun, String> {
        if file.horde != HORDE_VERSION {
            return Err(format!(
                "line.json has horde {}, and this build reads {HORDE_VERSION}",
                file.horde
            ));
        }
        let value = serde_json::to_value(&file.plan).map_err(|e| e.to_string())?;
        let plan = Plan::from_value(&value).map_err(|problems| {
            let messages: Vec<String> = problems.into_iter().map(|p| p.message).collect();
            format!(
                "line.json's frozen Plan no longer validates: {}",
                messages.join("; ")
            )
        })?;
        let read = Reader { plan: &plan };
        let mut nodes = IndexMap::new();
        for node in file.run.nodes {
            let id = read.node(&node.id)?;
            let current = node
                .current
                .map(|pass| -> Result<Pass, String> {
                    Ok(Pass {
                        n: pass.n,
                        input: read.handoff(pass.input)?,
                        work: read.work(pass.work)?,
                        reads: pass.reads.into_iter().map(TicketId).collect(),
                    })
                })
                .transpose()?;
            let mut parked = IndexMap::new();
            for handoff in node.parked {
                let handoff = read.handoff(handoff)?;
                parked.insert(handoff.verdict, handoff);
            }
            let mut arrived = IndexMap::new();
            for arrival in node.arrived {
                arrived.insert(read.edge(&arrival.edge)?, read.handoff(arrival.handoff)?);
            }
            let inbox = node
                .inbox
                .into_iter()
                .map(|h| read.handoff(h))
                .collect::<Result<VecDeque<_>, _>>()?;
            nodes.insert(
                id,
                NodeRun {
                    passes: node.passes,
                    current,
                    inbox,
                    parked,
                    arrived,
                },
            );
        }
        let mut edges = IndexMap::new();
        for edge in file.run.edges {
            let held = edge
                .held
                .map(|held| -> Result<_, String> {
                    Ok((TicketId(held.ticket), read.handoff(held.handoff)?))
                })
                .transpose()?;
            edges.insert(
                read.key(&edge.edge)?,
                EdgeRun {
                    count: edge.count,
                    traversals: edge.traversals,
                    bought: edge.bought,
                    steward_used: edge.steward_used,
                    held,
                },
            );
        }
        let status = match (file.run.status, file.run.act) {
            (LineRunStatus::Running, _) => LineStatus::Running,
            (LineRunStatus::Finishing, _) => LineStatus::Finishing {
                waiting_for: Vec::new(),
            },
            (LineRunStatus::Acting, Some(ticket)) => LineStatus::Acting {
                ticket: TicketId(ticket),
            },
            (LineRunStatus::Acting, None) => {
                return Err("line.json: an acting Line names no act Ticket".to_owned());
            }
            (LineRunStatus::Done, _) => LineStatus::Done,
            (LineRunStatus::Closed, _) => LineStatus::Closed,
        };
        let places = file.places;
        Ok(LineRun {
            plan,
            rev: file.rev,
            places: LinePlaces {
                branch: places.branch,
                base: places.base,
                spec: places.spec,
                push_base: places.push_base,
                work: places.work,
            },
            status,
            nodes,
            edges,
            settled: file.run.settled.into_iter().map(TicketId).collect(),
        })
    }

    /// The Console's live graph, recomputed per emit.
    pub fn view(&self) -> LineGraphView {
        let (status, act) = status_file(&self.status);
        let waiting_for = match &self.status {
            LineStatus::Finishing { waiting_for } => {
                waiting_for.iter().map(ToString::to_string).collect()
            }
            _ => Vec::new(),
        };
        let nodes = self
            .plan
            .nodes()
            .map(|node| {
                let run = self.nodes.get(&node.id);
                let pass = run.and_then(|r| r.current.as_ref());
                let (tickets, queued, hold) = match pass.map(|p| &p.work) {
                    Some(PassWork::Tickets { copies, queue, .. }) => (
                        copies.iter().map(|c| c.ticket.0.clone()).collect(),
                        queue.len(),
                        None,
                    ),
                    Some(PassWork::Conversation { id }) => (vec![id.0.clone()], 0, None),
                    Some(PassWork::Hold { ticket }) => (Vec::new(), 0, Some(ticket.0.clone())),
                    Some(PassWork::Finish { hold }) => {
                        (Vec::new(), 0, hold.as_ref().map(|t| t.0.clone()))
                    }
                    None => (Vec::new(), 0, None),
                };
                LineNodeView {
                    id: node.id.to_string(),
                    verdicts: self
                        .plan
                        .vocabulary(&node.id)
                        .iter()
                        .map(|v| v.as_str().to_owned())
                        .collect(),
                    passes: run.map_or(0, |r| r.passes),
                    pass: pass.map(|p| p.n),
                    tickets,
                    queued: count(queued),
                    inbox: count(run.map_or(0, |r| r.inbox.len())),
                    parked: run.map_or_else(Vec::new, |r| {
                        r.parked.keys().map(|v| v.as_str().to_owned()).collect()
                    }),
                    arrived: run
                        .map_or_else(Vec::new, |r| r.arrived.keys().map(edge_file).collect()),
                    hold,
                }
            })
            .collect();
        let edges = self
            .plan
            .edges()
            .iter()
            .filter_map(|edge| {
                let cap = edge.cap.as_ref()?;
                let run = self.edges.get(&edge.key);
                Some(LineEdgeView {
                    edge: edge_file(&edge.key),
                    count: run.map_or(0, |r| r.count),
                    max: cap.max.get(),
                    bought: run.map_or(0, |r| r.bought),
                    hold: run.and_then(|r| r.held.as_ref()).map(|(t, _)| t.0.clone()),
                })
            })
            .collect();
        LineGraphView {
            plan: self.plan.to_file(),
            rev: self.rev,
            status,
            waiting_for,
            act,
            nodes,
            edges,
        }
    }
}

fn item(file: LineItem) -> Item {
    Item {
        title: file.title,
        body: file.body,
    }
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Reads run state's strings against the frozen Plan.
struct Reader<'a> {
    plan: &'a Plan,
}

impl Reader<'_> {
    fn id(raw: &str) -> Result<NodeId, String> {
        NodeId::parse(raw).map_err(|e| format!("line.json: {e}"))
    }

    fn node(&self, raw: &str) -> Result<NodeId, String> {
        let id = Self::id(raw)?;
        self.plan
            .node(&id)
            .map(|_| id.clone())
            .ok_or_else(|| format!("line.json: the frozen Plan has no node {raw}"))
    }

    fn verdict(&self, raw: &str) -> Result<Verdict, String> {
        Verdict::parse(raw).ok_or_else(|| format!("line.json: {raw} is not a verdict"))
    }

    /// A loop edge's key, which an edit may have unlinked since, its ends with it.
    fn key(&self, key: &LineEdgeKey) -> Result<EdgeKey, String> {
        Ok(EdgeKey {
            from: Self::id(&key.from)?,
            on: self.verdict(&key.on)?,
            to: Self::id(&key.to)?,
        })
    }

    fn edge(&self, key: &LineEdgeKey) -> Result<EdgeKey, String> {
        let edge = self.key(key)?;
        if self.plan.edges().iter().any(|e| e.key == edge) {
            Ok(edge)
        } else {
            Err(format!(
                "line.json: the frozen Plan has no edge {}.{} -> {}",
                key.from, key.on, key.to
            ))
        }
    }

    fn items(&self, items: Vec<LineItem>) -> Vec<Item> {
        items.into_iter().map(item).collect()
    }

    fn handoff(&self, file: LineHandoffFile) -> Result<Handoff, String> {
        Ok(Handoff {
            from: file.from.as_deref().map(|f| self.node(f)).transpose()?,
            verdict: self.verdict(&file.verdict)?,
            items: self.items(file.items),
            after: file.after.into_iter().map(TicketId).collect(),
            notes: file.notes,
            halted: file.halted,
        })
    }

    fn work(&self, file: LinePassWorkFile) -> Result<PassWork, String> {
        Ok(match file {
            LinePassWorkFile::Tickets(work) => PassWork::Tickets {
                copies: work
                    .copies
                    .into_iter()
                    .map(|copy| -> Result<CopyRun, String> {
                        Ok(CopyRun {
                            ticket: TicketId(copy.ticket),
                            item: copy.item.map(item),
                            freed: copy.freed,
                            settled: copy
                                .settled
                                .map(|s| -> Result<Settled, String> {
                                    Ok(Settled {
                                        verdict: self.verdict(&s.verdict)?,
                                        done: s.done,
                                        items: self.items(s.items),
                                    })
                                })
                                .transpose()?,
                        })
                    })
                    .collect::<Result<_, _>>()?,
                queue: self.items(work.queue).into(),
                cap: match work.cap {
                    PlanCap::At(n) => {
                        Cap::At(NonZeroU32::new(n).ok_or("line.json: a pass's cap is 0")?)
                    }
                    PlanCap::All(_) => Cap::All,
                },
                next_seq: work.next_seq,
            },
            LinePassWorkFile::Conversation(work) => PassWork::Conversation {
                id: TicketId(work.id),
            },
            LinePassWorkFile::Hold(work) => PassWork::Hold {
                ticket: TicketId(work.ticket),
            },
            LinePassWorkFile::Finish(work) => PassWork::Finish {
                hold: work.hold.map(TicketId),
            },
        })
    }
}
