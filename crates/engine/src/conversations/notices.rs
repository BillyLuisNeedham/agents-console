//! Notices: queued on the parent's runtime, typed into its pane once it is next waiting, dropped (and
//! logged on the child's file) when the parent is gone or ending.

use std::collections::HashMap;

use ac_core::harness::harness_descriptor;
use ac_core::notices::{
    Notice, NoticeKind, TicketEnded, TicketOutcome, conversation_ended_notice_text,
    ticket_closed_notice_text, ticket_ended_notice_text,
};
use ac_core::pool::TicketMarker;
use ac_io::herdr::Herdr;
use ac_protocol::{NoticeDelivery, TicketEventKind};
use serde_json::{Map, Value};

use super::*;
use crate::actor::Engine;
use crate::pane_session::type_verified;

fn log_dropped(s: &Session, notice: &Notice, reason: &str) {
    let mut payload = Map::new();
    payload.insert("to".into(), notice.to.clone().into());
    payload.insert("kind".into(), notice.kind.as_str().into());
    payload.insert("reason".into(), reason.into());
    payload.insert("text".into(), notice.text.clone().into());
    event(
        s,
        &notice.from,
        TicketEventKind::NoticeDropped,
        payload,
        last_attempt_of(s, &notice.from),
    );
}

/// Queue one Notice for delivery, or drop it at once. Queueing is synchronous bookkeeping on the
/// runtime; a delivery that becomes possible immediately (the parent is already `waiting`) is kicked off
/// in the background rather than awaited here, so no caller needs to become async just to raise one.
pub(crate) fn enqueue(s: &mut Session, notice: Notice) {
    let runtime = s.conversations.runtime(&notice.to);
    let live = runtime
        .as_ref()
        .filter(|rt| !rt.with(|r| r.ending))
        .cloned();
    let Some(rt) = live else {
        // Orphaned: the parent never existed this run, already ended, crashed, or is mid-End (its tab is
        // already closing). Dropped and logged on the CHILD's own file: the spec's wording is explicit
        // that this lands on "the child's ticket log", never the parent's, since the parent may have
        // nothing worth writing to by the time this fires.
        log_dropped(
            s,
            &notice,
            if runtime.is_some() {
                "parent conversation is ending"
            } else {
                "parent conversation is not live"
            },
        );
        return;
    };
    let to = notice.to.clone();
    let waiting = rt.with(|r| {
        r.notices.push(notice);
        r.turn.state == ac_protocol::TurnSide::Waiting
    });
    if waiting {
        spawn_deliver(s, &to);
    }
}

// Whether `id` names a Conversation the pool has ever recorded, live or not. Distinct from live: a
// ticket's spawned-by can name a Conversation that has since ended or crashed, and that case must still
// reach enqueue so its Notice is dropped and *logged*, not silently skipped: only a spawned-by that
// names an ordinary Ticket (not a Conversation at all) should build nothing.
fn is_known(s: &Session, id: &str) -> bool {
    load(s).iter().any(|rec| rec.id == id)
}

fn parent_of<'a>(s: &Session, marker: &'a TicketMarker) -> Option<&'a str> {
    let parent = marker.spawned_by.as_deref().filter(|p| !p.is_empty())?;
    is_known(s, parent).then_some(parent)
}

/// A spawned Ticket reached `done` (its merge landed): if its `spawned-by` names any Conversation the
/// pool has recorded, enqueue a Notice; enqueue itself decides delivery vs. drop from there (the parent
/// may no longer be live). `range` is a git range (`<sha-before>..HEAD`) computed by the caller before
/// the merge removed the ticket's branch: `None` when the range could not be captured (a headless pool,
/// or a fast path that skipped it), in which case the diff reads as unavailable rather than guessing.
pub fn ticket_ended(s: &mut Session, marker: &TicketMarker, branch: &str, range: Option<String>) {
    let Some(parent) = parent_of(s, marker).map(str::to_owned) else {
        return;
    };
    let diff_stat = match &range {
        Some(range) if !range.is_empty() => ac_io::git::diff_stat_summary(&s.cwd, range),
        _ => "(diff unavailable)".to_owned(),
    };
    let text = ticket_ended_notice_text(&TicketEnded {
        id: &marker.id,
        title: &marker.title,
        outcome: TicketOutcome::Done,
        brief: None,
        branch,
        diff_stat: &diff_stat,
    });
    enqueue(
        s,
        Notice {
            to: parent,
            from: marker.id.clone(),
            kind: NoticeKind::TicketEnded,
            text,
            key: None,
        },
    );
}

/// A spawned Ticket checkpointed: if its `spawned-by` names any Conversation the pool has recorded,
/// enqueue a Notice (same "known, not just live" rule as [`ticket_ended`]). The branch still exists in a
/// git pool (a checkpoint never merges), so the diff is a live three-dot range against the pool's
/// current working branch; a headless pool has neither, and the Notice still goes out (to be delivered
/// or dropped) with placeholders for both.
pub fn ticket_checkpointed(s: &mut Session, marker: &TicketMarker, brief: &str) {
    let Some(parent) = parent_of(s, marker).map(str::to_owned) else {
        return;
    };
    let branch = if s.git {
        ac_io::git::branch_for(&s.cwd, &marker.id, None)
    } else {
        "(no git checkout)".to_owned()
    };
    let diff_stat = if s.git {
        let target = crate::merges::merge_target_branch(s);
        ac_io::git::diff_stat_summary(&s.cwd, &format!("{target}...{branch}"))
    } else {
        "(no git checkout)".to_owned()
    };
    let text = ticket_ended_notice_text(&TicketEnded {
        id: &marker.id,
        title: &marker.title,
        outcome: TicketOutcome::Checkpoint,
        brief: Some(brief),
        branch: &branch,
        diff_stat: &diff_stat,
    });
    enqueue(
        s,
        Notice {
            to: parent,
            from: marker.id.clone(),
            kind: NoticeKind::TicketEnded,
            text,
            key: None,
        },
    );
}

/// A spawned Ticket was closed (issue #154): the same "known, not just live" rule as [`ticket_ended`].
/// Nothing merged, so the Notice carries the closing note rather than a branch and a diff.
pub fn ticket_closed(s: &mut Session, marker: &TicketMarker, note: Option<&str>) {
    let Some(parent) = parent_of(s, marker).map(str::to_owned) else {
        return;
    };
    let text = ticket_closed_notice_text(&marker.id, &marker.title, note);
    enqueue(
        s,
        Notice {
            to: parent,
            from: marker.id.clone(),
            kind: NoticeKind::TicketEnded,
            text,
            key: None,
        },
    );
}

/// A Conversation has genuinely ended (merged, ended with no commits, or ended with its branch parked on
/// reject) or crashed: drop what never delivered, and tell its own parent, if it has one. Called while
/// the runtime is still in the map.
pub(crate) fn note_ended(
    s: &mut Session,
    id: &str,
    branch: &str,
    closing: Option<&str>,
    _crashed: bool,
) {
    if let Some(rt) = s.conversations.runtime(id) {
        let pending: Vec<Notice> = rt.with(|r| r.notices.clone());
        for notice in &pending {
            log_dropped(s, notice, "parent conversation ended before delivery");
        }
    }
    let Some(parent) = record_of(s, id).and_then(|rec| rec.spawned_by) else {
        return;
    };
    let text = conversation_ended_notice_text(branch, closing);
    enqueue(
        s,
        Notice {
            to: parent,
            from: id.to_owned(),
            kind: NoticeKind::ConversationEnded,
            text,
            key: None,
        },
    );
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/// One Turn typed into the pane: the text, and the Notices it reports.
pub(crate) struct Turn {
    text: String,
    notices: Vec<Notice>,
}

/// A claimed queue, on its way into a pane.
pub(crate) struct DeliverPlan {
    id: String,
    rt: Rt,
    herdr: Herdr,
    pane: String,
    echo_pattern: Option<&'static str>,
    clear_keys: Vec<String>,
    turns: Vec<Turn>,
}

/// The Turns a claimed queue is typed as: one per Notice, except a Steward's (ADR-0030), which go
/// together as one Turn where the first of them stood. Each Steward Notice is checked against the items
/// pending now (`current`) and typed with its current text, so an Interrupt answered while its Notice
/// waited is not reported, and a budget is reported as it stands.
fn turns_of(queue: Vec<Notice>, current: Option<&HashMap<String, StewardItem>>) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    let mut notices: Vec<Notice> = Vec::new();
    let mut items: Vec<StewardItem> = Vec::new();
    let mut steward_at: Option<usize> = None;
    for notice in queue {
        let Some(key) = &notice.key else {
            turns.push(Turn {
                text: notice.text.clone(),
                notices: vec![notice],
            });
            continue;
        };
        let Some(item) = current.and_then(|current| current.get(key)) else {
            continue;
        };
        if steward_at.is_none() {
            steward_at = Some(turns.len());
        }
        items.push(item.clone());
        notices.push(notice);
    }
    if let Some(at) = steward_at {
        turns.insert(
            at,
            Turn {
                text: steward_batch_text(&items),
                notices,
            },
        );
    }
    turns
}

/// The first, synchronous stretch of a delivery: claims the whole queue up front, before any await, so
/// a concurrent trigger (the tick's own waiting check racing an enqueue that fired mid-tick) can never
/// double-deliver. `None` when there is nothing to deliver, or when anything it needs cannot be read (a
/// Conversation's record briefly unreadable): the queue is left intact.
pub(crate) fn deliver_begin(s: &mut Session, id: &str) -> Option<DeliverPlan> {
    let rt = s.conversations.runtime(id)?;
    let (ending, pane, empty, file) = rt.with(|r| {
        (
            r.ending,
            r.pane_id.clone(),
            r.notices.is_empty(),
            r.file.clone(),
        )
    });
    let pane = pane?;
    if ending || empty {
        return None;
    }
    let rec = ac_core::conversation_record::read_conversation(&file).ok()?;
    let descriptor = harness_descriptor(&rec.harness);
    // Read before the queue is claimed: a failure here must leave it intact.
    let keyed = rt.with(|r| r.notices.iter().any(|n| n.key.is_some()));
    let current: Option<HashMap<String, StewardItem>> = keyed.then(|| {
        steward_items_now(s)
            .into_iter()
            .map(|item| (item.key.clone(), item))
            .collect()
    });
    let queue = rt.with(|r| std::mem::take(&mut r.notices));
    let turns = turns_of(queue, current.as_ref());
    let herdr = rt.with(|r| r.herdr.clone());
    Some(DeliverPlan {
        id: id.to_owned(),
        rt,
        herdr,
        pane,
        echo_pattern: descriptor.and_then(|d| d.echo_pattern),
        clear_keys: descriptor
            .map(|d| d.clear_keys.iter().map(|k| (*k).to_owned()).collect())
            .unwrap_or_default(),
        turns,
    })
}

/// Kick a delivery off in the background: raising a Notice, or the tick's own waiting check, must never
/// become async just to wait on delivery.
pub(crate) fn spawn_deliver(s: &mut Session, id: &str) {
    if let Some(plan) = deliver_begin(s, id) {
        let engine = s.engine();
        tokio::spawn(async move { deliver_run(&engine, plan).await });
    }
}

/// Drain a Conversation's queued Notices by typing each as its own Turn (typeVerified + Enter:
/// type_verified sends the Enter itself once the echo confirms). A delivery that fails to echo (it
/// answers false) *or throws* (a herdr RPC failure: a daemon blip, a socket error) stops the drain and
/// puts the undelivered remainder back at the front of the queue for the next trigger to retry, rather
/// than skipping ahead or losing it. This never fails: every failure is caught, logged once as this
/// attempt's own "notice" event, and turned into "still queued".
pub(crate) async fn deliver_run(engine: &Engine, plan: DeliverPlan) {
    let DeliverPlan {
        id,
        rt,
        herdr,
        pane,
        echo_pattern,
        clear_keys,
        turns,
    } = plan;
    let remaining: Vec<Turn> = turns;
    let mut index = 0;
    while index < remaining.len() {
        let text = remaining[index].text.clone();
        let echo_targets: Vec<String> = [echo_pattern.map(str::to_owned), Some(text.clone())]
            .into_iter()
            .flatten()
            .filter(|target| !target.is_empty())
            .collect();
        let mut delivered = false;
        let mut error: Option<String> = None;
        match type_verified(&herdr, &pane, &text, &echo_targets, &clear_keys).await {
            Ok(done) => delivered = done,
            Err(err) => error = Some(err.to_string()),
        }
        let step = {
            let (id, rt) = (id.clone(), rt.clone());
            let rest: Vec<Notice> = remaining[index..]
                .iter()
                .flat_map(|turn| turn.notices.clone())
                .collect();
            let reported = remaining[index].notices.clone();
            engine
                .call(move |s| record_delivery(s, &id, &rt, &reported, rest, delivered, error))
                .await
        };
        if !matches!(step, Ok(true)) {
            return;
        }
        index += 1;
    }
    drop(remaining);
}

// What follows one Turn's attempt, in one stretch: the events, then either the next Turn or the stop.
// Whether the drain goes on.
fn record_delivery(
    s: &mut Session,
    id: &str,
    rt: &Rt,
    reported: &[Notice],
    rest: Vec<Notice>,
    delivered: bool,
    error: Option<String>,
) -> bool {
    // A stuck pane is retried every tick: only the first failure of the episode is on the logs, and
    // then the delivery that ends it.
    let first_failure = !delivered && rt.with(|r| r.delivery.is_none());
    if delivered || first_failure {
        for notice in reported {
            let payload = |side: (&str, &str)| {
                let mut payload = Map::new();
                payload.insert("kind".into(), notice.kind.as_str().into());
                payload.insert("delivered".into(), Value::Bool(delivered));
                if let Some(error) = error.as_ref().filter(|e| !e.is_empty()) {
                    payload.insert("error".into(), error.clone().into());
                }
                payload.insert(side.0.into(), side.1.into());
                payload
            };
            event(
                s,
                &notice.from,
                TicketEventKind::Notice,
                payload(("to", &notice.to)),
                last_attempt_of(s, &notice.from),
            );
            event(
                s,
                id,
                TicketEventKind::Notice,
                payload(("from", &notice.from)),
                last_attempt_of(s, id),
            );
        }
    }
    if !delivered {
        let (failing_since, last_error) = rt.with(|r| {
            r.notices.splice(0..0, rest);
            let failing_since = r
                .delivery
                .as_ref()
                .map_or_else(js::now_iso, |d| d.failing_since.clone());
            let last_error = error.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| {
                "the Turn never showed in the pane, so it was not sent".to_owned()
            });
            r.delivery = Some(NoticeDelivery {
                failing_since: failing_since.clone(),
                last_error: last_error.clone(),
            });
            (failing_since, last_error)
        });
        let _ = failing_since;
        if first_failure {
            s.log(format!(
                "conversation {id}: Notices are not reaching its pane ({last_error}); retrying while it reads as waiting"
            ));
            publish(s);
        }
        return false;
    }
    let was_failing = rt.with(|r| r.delivery.take());
    if let Some(failing) = was_failing {
        s.log(format!(
            "conversation {id}: Notices reach its pane again (failing since {})",
            failing.failing_since
        ));
        publish(s);
    }
    true
}

/// `deliver(id)`: begin and run one delivery, for a caller that waits on it.
#[allow(dead_code)]
pub(crate) async fn deliver(engine: &Engine, id: &str) {
    let id = id.to_owned();
    if let Ok(Some(plan)) = engine.call(move |s| deliver_begin(s, &id)).await {
        deliver_run(engine, plan).await;
    }
}
