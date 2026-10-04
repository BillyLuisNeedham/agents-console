//! The tick: Turn state, Notice delivery and this Conversation's own mid-run Spawn proposal file, every
//! 2 s per live Conversation.

use std::time::Duration;

use ac_core::harness::{HarnessDescriptor, harness_descriptor, idle_pattern_for};
use ac_core::js;
use ac_core::outcome::validate_spawn_proposals;
use ac_core::turn_state::{IDLE_STABLE_READS, next_turn_state};
use ac_io::herdr::{HerdrError, PaneAgentState, PaneReadSource};
use ac_protocol::{ConversationRole, SpawnKind, TicketEventKind, TurnSide};
use serde_json::{Value, json};

use super::*;
use crate::actor::Engine;

/// One Turn-state read from the pane, publishing when the read changes what the snapshot shows and
/// reporting the herdr sidebar state on a flip. A failed read leaves the state as it was; the caller
/// decides whether that is fatal (the enlist claim) or one tick's blip.
///
/// The read is of the viewport only (`visible`, issue #122): Turn state needs no more than the prompt
/// area at the bottom, and a scrollback read moves the viewport of the operator sitting in the pane.
/// What was read is recorded for the card Peek, so this is the one read of the pane per tick.
pub(crate) async fn read_turn(
    engine: &Engine,
    rt: &Rt,
    descriptor: Option<&HarnessDescriptor>,
) -> Result<(), HerdrError> {
    let (herdr, pane) = rt.with(|r| (r.herdr.clone(), r.pane_id.clone()));
    let Some(pane) = pane else { return Ok(()) };
    let text = herdr.peek_pane(&pane, PaneReadSource::Visible).await?;
    // A harness the engine has no descriptor for has no idle pattern: the Turn never reads waiting.
    let idle = descriptor.map_or("", idle_pattern_for).to_owned();
    let rt = rt.clone();
    // The engine going away mid-read is a read that never finished.
    let _ = engine
        .call(move |s| apply_read(s, &rt, &pane, text, &idle))
        .await;
    Ok(())
}

fn apply_read(s: &mut Session, rt: &Rt, pane: &str, text: String, idle: &str) {
    let at = js::now_iso();
    s.pane_reads.record(pane, text.clone(), at.clone());
    let (changed, flipped, state) = rt.with(|r| {
        let transition = next_turn_state(&r.turn, &text, idle, &at);
        let flipped = r.turn.state != transition.turn.state;
        let state = transition.turn.state;
        r.turn = transition.turn;
        (transition.publish, flipped, state)
    });
    if changed {
        publish(s);
    }
    if flipped {
        report_agent(
            rt,
            if state == TurnSide::Waiting {
                PaneAgentState::Blocked
            } else {
                PaneAgentState::Working
            },
        );
    }
}

/// Settle a freshly claimed pane's Turn state from consecutive reads (the same rule turn-state applies
/// on its own tick): one read establishes the transcript, then `IDLE_STABLE_READS` more with the idle
/// pattern present flip the state to waiting. A failure leaves the caller to decide whether that is
/// fatal (the enlist claim) or one boot's blip (the re-adoption).
pub(crate) async fn settle_turn(
    engine: &Engine,
    rt: &Rt,
    descriptor: Option<&HarnessDescriptor>,
) -> Result<(), HerdrError> {
    for _ in 0..=IDLE_STABLE_READS {
        read_turn(engine, rt, descriptor).await?;
        if rt.with(|r| r.turn.state) == TurnSide::Waiting {
            break;
        }
    }
    Ok(())
}

/// Start the tick: every poll, one `tick` task, whether or not the last has finished (a timer's
/// interval, not a loop that waits on its work).
pub(crate) fn start_tick(s: &mut Session, rt: &Rt) {
    let poll = Duration::from_millis(s.conversation_poll_ms.unwrap_or(CONVERSATION_POLL_MS));
    let engine = s.engine();
    let id = rt.id();
    let timer = tokio::spawn(async move {
        let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + poll, poll);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            tokio::spawn(tick(engine.clone(), id.clone()));
        }
    });
    rt.with(|r| r.timer = Some(timer));
}

// What the tick's first stretch found: the runtime and the descriptor its harness names.
fn tick_begin(s: &Session, id: &str) -> Option<(Rt, Option<&'static HarnessDescriptor>)> {
    let rt = s.conversations.runtime(id)?;
    let (ending, pane, file) = rt.with(|r| (r.ending, r.pane_id.clone(), r.file.clone()));
    if ending || pane.is_none() {
        return None;
    }
    // A single tick's failure (a transient read error, a record momentarily unreadable) must never take
    // the tick down for every other live Conversation, nor stop this one's own future ticks: swallow and
    // let the next tick try again, the same tolerance peekPane's own callers already apply to a daemon
    // blip.
    let rec = ac_core::conversation_record::read_conversation(&file).ok()?;
    Some((rt, harness_descriptor(&rec.harness)))
}

async fn tick(engine: Engine, id: String) {
    let key = id.clone();
    let Ok(Some((rt, descriptor))) = engine.call(move |s| tick_begin(s, &key)).await else {
        return;
    };
    if read_turn(&engine, &rt, descriptor).await.is_err() {
        // One tick's failure is not fatal.
        return;
    }
    let _ = engine.call(move |s| tick_after_read(s, &id)).await;
}

fn tick_after_read(s: &mut Session, id: &str) {
    // The runtime may have ended while this read was in flight (the tab closes as soon as End is called,
    // well before the pane's fate is known); re-fetch rather than trusting the earlier reference.
    let Some(live) = s.conversations.runtime(id) else {
        return;
    };
    if live.with(|r| r.ending) {
        return;
    }
    // A Steward hears about what is pending without polling (ADR-0030): offered here, each item once,
    // and delivered below while it waits.
    if live.with(|r| r.role) == Some(ConversationRole::Steward) {
        offer_steward(s, &live);
    }
    if live.with(|r| r.turn.state == TurnSide::Waiting && !r.notices.is_empty()) {
        super::notices::spawn_deliver(s, id);
    }
    poll_spawn_proposals(s, id);
}

/// Read `runs/<id>.spawn.json`, consume it (remove it, whether it parsed or not: a malformed file left
/// in place would be re-read and re-rejected forever), and hand its `spawn` field to the host, which
/// validates it against exactly the shape a Ticket's outcome.spawn is held to and adopts the survivors.
/// Rejected entries are logged first, the same way an outcome's are (spawn-rejected on this
/// Conversation's own file, since it is both proposer and parent here).
fn poll_spawn_proposals(s: &mut Session, id: &str) {
    let path = js::path_join(&[&s.runs_dir, &format!("{id}.spawn.json")]);
    if !js::exists(&path) {
        return;
    }
    let parsed = js::read_text(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let _ = std::fs::remove_file(&path);
    let Some(raw) = parsed else { return };
    adopt_spawns(s, id, raw.as_object().and_then(|map| map.get("spawn")));
}

// ConversationHost.adoptSpawns: validate a Conversation's raw spawn proposals, log the malformed entries
// before the survivors are queued, and land them at once when the engine is idle.
fn adopt_spawns(s: &mut Session, parent_id: &str, raw: Option<&Value>) {
    let validation = validate_spawn_proposals(raw);
    for rejection in &validation.rejections {
        let mut payload = serde_json::Map::new();
        if let Some(index) = rejection.index {
            payload.insert("index".into(), json!(index));
        }
        payload.insert("reason".into(), json!(rejection.reason));
        let attempt = last_attempt_of(s, parent_id);
        event(
            s,
            parent_id,
            TicketEventKind::SpawnRejected,
            payload,
            attempt,
        );
    }
    if validation.proposals.is_empty() {
        return;
    }
    let pending = match crate::spawns::take_spawn_proposals(
        s,
        parent_id,
        validation.proposals,
        SpawnKind::Conversation,
    ) {
        Ok((pending, _held)) => !pending.is_empty(),
        Err(_) => return,
    };
    // Idle: land what is pending (write the files / start the child Conversations) and kick a drive at
    // once, since nothing else will reach the boundary that does this. In flight: leave it pending: the
    // driving super-step's own adoption at its next boundary picks it up, and landing here too would
    // mutate the markers and the state concurrently with that in-flight work.
    if !s.driving && pending {
        let _ = crate::spawns::adopt_spawn_proposals(s);
        let _ = crate::answers::kick_processing(s);
    } else {
        let phase = if s.driving {
            ac_protocol::RunPhase::Running
        } else {
            s.idle_phase()
        };
        emit_snapshot(s, phase);
    }
}
