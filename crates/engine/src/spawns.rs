//! Spawns (ADR-0010, ADR-0029, issue #150; engine.ts 10699-11616): Spawn counters, taking proposals,
//! adoption at the boundary, the Spawn ledger refresh, and Held and Pending spawns.
//!
//! Every function here is the synchronous TypeScript segment it was: a plain function over the Session,
//! called inside one actor job. Landing a Conversation Spawn is the one start that outlives its job: it
//! is a task, as the TypeScript's un-awaited `conversations.start`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::{Map, Value, json};

use ac_core::events::{append_event, last_attempt, read_events};
use ac_core::js;
use ac_core::pool::{
    AddBlocker, TicketMarker, add_blocker_to_ticket, known_conversation_ids, load_pool_tickets,
    parse_spawn_id, write_spawn_ticket,
};
use ac_core::spawn_caps::spawn_caps_of;
use ac_core::spawn_ledger::{
    LedgerEntry, SpawnLedgerInput, render_spawn_ledger, spawn_ledger_path, write_spawn_ledger,
};
use ac_core::spawn_proposals::{HeldSpawn, NewHeldSpawn, PendingSpawn, TakenProposal};
use ac_protocol::{
    ConversationAssign, ConversationView, HeldSpawnReason, SpawnBlocks, SpawnKind, SpawnProposal,
    StartConversationRequest, TicketEvent, TicketEventKind, TicketStatus,
};

use crate::error::EngineError;
use crate::session::{PoolUpdate, Session, apply_update};
use crate::snapshot::emit_snapshot;

/// The per-attempt cap every pool ran under before ADR-0029 made it a setting: what a pre-ADR
/// truncation was measured against.
const PRE_ADR_0029_PER_ATTEMPT: usize = 5;

fn runs(session: &Session) -> &Path {
    Path::new(&session.runs_dir)
}

fn refused(message: impl Into<String>) -> EngineError {
    EngineError::refused(message)
}

// One event on a parent's log, at the attempt `attempt`.
fn append(
    session: &Session,
    parent_id: &str,
    at: &str,
    attempt: u64,
    kind: TicketEventKind,
    payload: Value,
) -> anyhow::Result<()> {
    let Value::Object(payload) = payload else {
        unreachable!("an event payload is an object");
    };
    append_event(
        runs(session),
        parent_id,
        &TicketEvent {
            at: at.to_owned(),
            attempt,
            kind,
            payload,
        },
    )?;
    Ok(())
}

// An event stamped now, at the parent's latest attempt (`lastAttempt` read as the object is built).
fn append_now(
    session: &Session,
    parent_id: &str,
    kind: TicketEventKind,
    payload: Value,
) -> anyhow::Result<()> {
    append(
        session,
        parent_id,
        &js::now_iso(),
        last_attempt(runs(session), parent_id),
        kind,
        payload,
    )
}

fn log_line(session: &mut Session, line: String) {
    apply_update(&mut session.state, PoolUpdate::log([line]));
}

// `spawnCounters`: the highest N each parent's spawned Tickets have reached.
fn spawn_counters(markers: &[TicketMarker]) -> HashMap<String, u64> {
    let mut counters = HashMap::new();
    for marker in markers {
        raise_counter(&mut counters, &marker.id);
    }
    counters
}

fn raise_counter(counters: &mut HashMap<String, u64>, id: &str) {
    if let Some(spawn) = parse_spawn_id(id) {
        let entry = counters.entry(spawn.parent).or_insert(0);
        *entry = (*entry).max(spawn.n);
    }
}

// `combinedSpawnCounters`: a parent's ticket-spawns and Conversation-spawns share one
// `<parent>-spawn-N` namespace, so the counter that hands out the next N sees both kinds of existing
// child, and the ids the Conversation module holds reserved for starts still in flight.
fn combined_spawn_counters(session: &Session) -> anyhow::Result<HashMap<String, u64>> {
    let mut counters = spawn_counters(&session.markers);
    let recorded = ac_core::conversation_record::load_conversations(
        &Path::new(&session.pool_dir).join("conversations"),
    )?;
    for rec in recorded {
        raise_counter(&mut counters, &rec.id);
    }
    for reserved in crate::conversations::reserved_ids(session) {
        raise_counter(&mut counters, &reserved);
    }
    Ok(counters)
}

// What a proposal may name as known work: the pool's Tickets and its recorded Conversations.
struct KnownPoolIds {
    ids: HashSet<String>,
    conversations: HashSet<String>,
}

fn known_pool_ids(session: &Session) -> anyhow::Result<KnownPoolIds> {
    Ok(KnownPoolIds {
        ids: session.markers.iter().map(|m| m.id.clone()).collect(),
        conversations: known_conversation_ids(Path::new(&session.pool_dir))?,
    })
}

// Every ticket a ticket waits on, directly or through its blockers' own blocked-by: what a Spawn must
// never block, or the two would wait on each other for good (ADR-0029).
fn blocked_by_closure(markers: &[TicketMarker], start: &[String]) -> HashSet<String> {
    let by_id: HashMap<&str, &TicketMarker> = markers.iter().map(|m| (m.id.as_str(), m)).collect();
    let mut seen = HashSet::new();
    let mut stack: Vec<String> = start.to_vec();
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(marker) = by_id.get(id.as_str()) {
            stack.extend(marker.blocked_by.iter().cloned());
        }
    }
    seen
}

fn state_of(session: &Session, id: &str) -> Option<TicketStatus> {
    session.state.tickets.get(id).copied()
}

fn join(ids: &[&String]) -> String {
    ids.iter()
        .map(|id| id.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

// `spawnProposalProblem`: why a proposal cannot be adopted into the pool as it stands, or `None` when
// it can: a blockedBy naming a Conversation or an id outside the pool, or an assign.harness the pool
// does not know. The boundary's adoption drops a proposal on this reason, and an operator's Adopt of a
// Held spawn is refused on it before anything is queued.
fn spawn_proposal_problem(
    session: &Session,
    proposal: &SpawnProposal,
    known: &KnownPoolIds,
) -> Option<String> {
    let blocked_by = proposal.blocked_by.clone().unwrap_or_default();
    let conversation_blockers: Vec<&String> = blocked_by
        .iter()
        .filter(|id| known.conversations.contains(*id))
        .collect();
    let unknown_tickets: Vec<&String> = blocked_by
        .iter()
        .filter(|id| !known.ids.contains(*id) && !known.conversations.contains(*id))
        .collect();
    if !conversation_blockers.is_empty() || !unknown_tickets.is_empty() {
        let mut reasons = Vec::new();
        if !conversation_blockers.is_empty() {
            reasons.push(format!(
                "blockedBy names Conversations, which cannot block a ticket: {}",
                join(&conversation_blockers)
            ));
        }
        if !unknown_tickets.is_empty() {
            reasons.push(format!(
                "blockedBy names tickets outside the pool: {}",
                join(&unknown_tickets)
            ));
        }
        return Some(reasons.join("; "));
    }
    if let Some(harness) = proposal
        .assign
        .as_ref()
        .and_then(|assign| assign.harness.as_deref())
        .filter(|harness| !harness.is_empty())
        && !session.harnesses.contains(harness)
    {
        return Some(format!("assign.harness names unknown harness '{harness}'"));
    }
    // Named blocks (ADR-0029) go onto each ticket's blocked-by at adoption, so each must be a ticket
    // with a next Attempt to hold, and none may be one the proposal itself waits on, which would
    // deadlock the two. "all" picks its tickets at adoption and has nothing to check here.
    if let Some(SpawnBlocks::Ids(named)) = &proposal.blocks {
        let waits_on = blocked_by_closure(&session.markers, &blocked_by);
        let in_pool = |id: &String| known.ids.contains(id);
        let with_state = |status: TicketStatus| -> Vec<&String> {
            named
                .iter()
                .filter(|id| in_pool(id) && state_of(session, id) == Some(status))
                .collect()
        };
        let problems: [(&str, Vec<&String>); 6] = [
            (
                "blocks names Conversations, which cannot be blocked",
                named
                    .iter()
                    .filter(|id| known.conversations.contains(*id))
                    .collect(),
            ),
            (
                "blocks names tickets outside the pool",
                named
                    .iter()
                    .filter(|id| !known.ids.contains(*id) && !known.conversations.contains(*id))
                    .collect(),
            ),
            (
                "blocks names done tickets, which have no next attempt to hold",
                with_state(TicketStatus::Done),
            ),
            (
                "blocks names closed tickets, which never run again",
                with_state(TicketStatus::Closed),
            ),
            (
                "blocks names engine-run tickets, which the engine schedules itself",
                named
                    .iter()
                    .filter(|id| {
                        in_pool(id) && ac_core::assignment::engine_ticket_build_id(id).is_some()
                    })
                    .collect(),
            ),
            (
                "blocks names tickets this proposal already waits on, a cycle",
                named.iter().filter(|id| waits_on.contains(*id)).collect(),
            ),
        ];
        let reasons: Vec<String> = problems
            .iter()
            .filter(|(_, ids)| !ids.is_empty())
            .map(|(reason, ids)| format!("{reason}: {}", join(ids)))
            .collect();
        if !reasons.is_empty() {
            return Some(reasons.join("; "));
        }
    }
    None
}

// `applySpawnBlocks`: a just-adopted Spawn's blocks (ADR-0029), onto the pool: the Spawn joins each
// target's blocked-by, through the same marker write the Enlist form's Blocks uses, with the in-memory
// marker kept in step for the ready set this boundary computes next. "all" is every ticket not yet
// started (ready) as the adoption lands, sibling Spawns included, excluding the Spawn itself,
// everything it waits on, and engine-run tickets. A ticket already running is never a target and never
// interrupted. Named targets were checked at validation; one an earlier Spawn of the same boundary
// made a cycle of, or that the file refuses, is skipped with a log line rather than written. Returns
// the tickets actually blocked.
fn apply_spawn_blocks(
    session: &mut Session,
    spawn_id: &str,
    blocks: &SpawnBlocks,
    log: &mut Vec<String>,
) -> anyhow::Result<Vec<String>> {
    let Some(spawn) = session.markers.iter().find(|m| m.id == spawn_id) else {
        return Ok(Vec::new());
    };
    let waits_on = blocked_by_closure(&session.markers, &spawn.blocked_by.clone());
    let targets: Vec<String> = match blocks {
        SpawnBlocks::All(_) => session
            .markers
            .iter()
            .filter(|m| {
                m.id != spawn_id
                    && state_of(session, &m.id) == Some(TicketStatus::Ready)
                    && !waits_on.contains(&m.id)
                    && ac_core::assignment::engine_ticket_build_id(&m.id).is_none()
            })
            .map(|m| m.id.clone())
            .collect(),
        SpawnBlocks::Ids(ids) => ids.clone(),
    };
    let mut blocked = Vec::new();
    for target_id in targets {
        let Some(target) = session.markers.iter().find(|m| m.id == target_id) else {
            continue;
        };
        if target.blocked_by.iter().any(|id| id == spawn_id) {
            continue;
        }
        if waits_on.contains(&target_id) {
            log.push(format!(
                "ticket {spawn_id}: not blocking {target_id}, which it already waits on"
            ));
            continue;
        }
        if let AddBlocker::Refused(reason) =
            add_blocker_to_ticket(Path::new(&session.pool_dir), &target_id, spawn_id)?
        {
            log.push(format!(
                "ticket {spawn_id}: not blocking {target_id}: {reason}"
            ));
            continue;
        }
        if let Some(target) = session.marker_mut(&target_id) {
            target.blocked_by.push(spawn_id.to_owned());
        }
        blocked.push(target_id);
    }
    Ok(blocked)
}

// The ids a proposal's `overlaps` mark (issue #150) names that the agent could not have read in the
// Spawn ledger: neither a Ticket, a Conversation, nor any proposal this pool ever issued. They never
// reject the proposal: the agent flagged a possible duplicate, so it is held for the operator either
// way, the unknown ids noted beside the mark in case it is stale or mistaken.
fn unknown_overlaps(
    session: &Session,
    proposal: &SpawnProposal,
    known: &KnownPoolIds,
) -> Vec<String> {
    proposal
        .overlaps
        .iter()
        .flatten()
        .filter(|id| {
            !known.ids.contains(*id)
                && !known.conversations.contains(*id)
                && !session.spawn_proposals.is_proposal_id(id)
        })
        .cloned()
        .collect()
}

// The per-run room Pending spawns hold (issue #150): a Ticket-origin Pending spawn reserves its place
// under the run cap until it lands, when it counts toward the run, or is held or discarded, when the
// room is free again.
fn pending_run_reservations(session: &Session) -> i64 {
    session
        .spawn_proposals
        .pending()
        .iter()
        .filter(|p| p.origin != SpawnKind::Conversation)
        .count() as i64
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// `takeSpawnProposals` (issue #150, on ADR-0010 and ADR-0029): the moment an Outcome becomes its
/// ticket's, or a Conversation's spawn.json is read, each proposal is checked against the pool as it
/// stands and settled on disk before anything else happens, so a restart before the boundary finds
/// every one of them. A proposal the pool would reject is dropped with the reason on the parent's log
/// (a spawn-rejected event), the parent's own result standing. One the agent marked as overlapping work
/// in the pool is held for the operator, whatever ids the mark names. The rest meet the caps: the
/// per-attempt cap takes the first ones in order, and the per-run cap, for a Ticket's own
/// outcome.spawn only (a Conversation's spawn.json has none), takes what the run has room for once
/// this run's landed Spawns and the Pending spawns already reserving room are counted. What a cap
/// cannot take is held, in its place in the proposal's order; what it takes is a Pending spawn,
/// landing at the next boundary unless the operator holds or discards it first. A cap of 0 holds
/// everything.
pub fn take_spawn_proposals(
    session: &mut Session,
    parent_id: &str,
    proposals: Vec<SpawnProposal>,
    origin: SpawnKind,
) -> anyhow::Result<(Vec<PendingSpawn>, Vec<HeldSpawn>)> {
    let known = known_pool_ids(session)?;
    let caps = spawn_caps_of(&session.state.config);
    let at = js::now_iso();
    let attempt = last_attempt(runs(session), parent_id);
    let mut log: Vec<String> = Vec::new();
    let mut taken: Vec<TakenProposal> = Vec::new();
    let mut attempt_room = caps.per_attempt as i64;
    // `None` is a Conversation's unbounded run room.
    let mut run_room: Option<i64> = match origin {
        SpawnKind::Conversation => None,
        SpawnKind::Ticket => Some(
            (caps.per_run as i64
                - session.spawned_this_run as i64
                - pending_run_reservations(session))
            .max(0),
        ),
    };
    for mut proposal in proposals {
        if proposal.verify_ignored.take().is_some() {
            log.push(format!(
                "ticket {parent_id}: spawn proposal '{}' asked for assign.verify; ignored, since \
                 whether a Ticket is graded is the operator's call",
                proposal.title
            ));
        }
        if let Some(reason) = spawn_proposal_problem(session, &proposal, &known) {
            append(
                session,
                parent_id,
                &at,
                attempt,
                TicketEventKind::SpawnRejected,
                json!({ "title": proposal.title, "reason": reason }),
            )?;
            log.push(format!(
                "ticket {parent_id}: spawn proposal '{}' rejected: {reason}",
                proposal.title
            ));
            continue;
        }
        let entry = |held: Option<HeldSpawnReason>, unknown: Option<Vec<String>>| TakenProposal {
            parent_id: parent_id.to_owned(),
            origin,
            proposal: proposal.clone(),
            at: at.clone(),
            held,
            unknown_overlaps: unknown,
        };
        if !proposal.overlaps.as_deref().unwrap_or_default().is_empty() {
            taken.push(entry(
                Some(HeldSpawnReason::Overlaps),
                Some(unknown_overlaps(session, &proposal, &known)),
            ));
        } else if attempt_room <= 0 {
            taken.push(entry(Some(HeldSpawnReason::PerAttempt), None));
        } else if run_room.is_some_and(|room| room <= 0) {
            attempt_room -= 1;
            taken.push(entry(Some(HeldSpawnReason::PerRun), None));
        } else {
            attempt_room -= 1;
            if let Some(room) = run_room.as_mut() {
                *room -= 1;
            }
            taken.push(entry(None, None));
        }
    }
    let (pending, held) = if taken.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        session.spawn_proposals.take(taken)?
    };
    if !pending.is_empty() {
        append(
            session,
            parent_id,
            &at,
            attempt,
            TicketEventKind::SpawnPending,
            json!({
                "pending": pending
                    .iter()
                    .map(|p| json!({ "id": p.id, "title": p.proposal.title }))
                    .collect::<Vec<_>>()
            }),
        )?;
        log.push(format!(
            "ticket {parent_id}: spawn proposal{} {} pending for the next boundary",
            plural(pending.len()),
            pending
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !held.is_empty() {
        append(
            session,
            parent_id,
            &at,
            attempt,
            TicketEventKind::SpawnHeld,
            json!({ "held": held.iter().map(held_event_entry).collect::<Vec<_>>() }),
        )?;
        let at_caps: Vec<&HeldSpawn> = held
            .iter()
            .filter(|h| {
                matches!(
                    h.reason,
                    HeldSpawnReason::PerAttempt | HeldSpawnReason::PerRun
                )
            })
            .collect();
        if !at_caps.is_empty() {
            log.push(format!(
                "ticket {parent_id}: {} proposal{} held at the caps ({} per attempt, {} per run): {}",
                at_caps.len(),
                plural(at_caps.len()),
                caps.per_attempt,
                caps.per_run,
                at_caps
                    .iter()
                    .map(|h| h.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        for h in held
            .iter()
            .filter(|h| h.reason == HeldSpawnReason::Overlaps)
        {
            log.push(format!(
                "ticket {parent_id}: {} ('{}') held: it overlaps {}{}",
                h.id,
                h.proposal.title,
                h.proposal
                    .overlaps
                    .as_deref()
                    .unwrap_or_default()
                    .join(", "),
                match &h.unknown_overlaps {
                    Some(unknown) => format!(
                        " ({} not in the pool or the Spawn ledger)",
                        unknown.join(", ")
                    ),
                    None => String::new(),
                }
            ));
        }
    }
    if !log.is_empty() {
        apply_update(&mut session.state, PoolUpdate::log(log));
    }
    refresh_spawn_ledger_from_last(session);
    Ok((pending, held))
}

// `heldEventEntry`: one held spawn as a spawn-held event names it: its id, title and reason, the ids
// an overlaps hold named (and which of them the pool never knew), and why the boundary refused to land
// a "refused" one.
fn held_event_entry(held: &HeldSpawn) -> Value {
    let mut entry = Map::new();
    entry.insert("id".into(), json!(held.id));
    entry.insert("title".into(), json!(held.proposal.title));
    entry.insert("reason".into(), json!(held.reason.as_str()));
    if held.reason == HeldSpawnReason::Overlaps {
        entry.insert(
            "overlaps".into(),
            json!(held.proposal.overlaps.clone().unwrap_or_default()),
        );
    }
    if let Some(unknown) = &held.unknown_overlaps {
        entry.insert("unknownOverlaps".into(), json!(unknown));
    }
    if held.reason == HeldSpawnReason::Refused
        && let Some(error) = &held.adopt_error
    {
        entry.insert("refusal".into(), json!(error));
    }
    Value::Object(entry)
}

// `landSpawn`: landing one proposal under its minted id: a Conversation started, or a ticket file
// written (true, so the caller reloads the pool's markers).
//
// A Conversation start is a task, as the TypeScript's fire-and-forget `start`: it opens a herdr tab
// and waits for the TUI, and this boundary is synchronous by ADR-0010's own contract. A launch failure
// is logged on the proposing parent, the same disposition a malformed proposal gets. The id is
// reserved with the Conversation module at once, so a second adoption before the record reaches disk
// cannot mint it again.
fn land_spawn(
    session: &mut Session,
    parent_id: &str,
    id: &str,
    proposal: &SpawnProposal,
) -> anyhow::Result<bool> {
    if proposal.kind == Some(SpawnKind::Conversation) {
        crate::conversations::reserve(session, id);
        let engine = session.engine();
        let request = StartConversationRequest {
            title: js::trim(&proposal.title).to_owned(),
            opening: Some(proposal.body.clone()),
            role: None,
            assign: proposal.assign.as_ref().map(|assign| ConversationAssign {
                harness: assign.harness.clone(),
                model: assign.model.clone(),
                effort: assign.effort.clone(),
                drivers: assign.drivers.clone(),
            }),
            spawned_by: Some(parent_id.to_owned()),
            id: Some(id.to_owned()),
        };
        let parent_id = parent_id.to_owned();
        let title = proposal.title.clone();
        tokio::spawn(async move {
            let Err(error) = engine.start_conversation(request).await else {
                return;
            };
            let reason = format!("conversation start failed: {}", error.message());
            let _ = engine
                .call(move |s| {
                    let _ = append_now(
                        s,
                        &parent_id,
                        TicketEventKind::SpawnRejected,
                        json!({ "title": title, "reason": reason }),
                    );
                })
                .await;
        });
        return Ok(false);
    }
    write_spawn_ticket(Path::new(&session.issues_dir), parent_id, id, proposal)?;
    Ok(true)
}

// A parent's adopted Spawns, each with the tickets it blocked.
type BlockedSpawns = Vec<(String, Vec<String>)>;

// What each landing settled, recorded on its parent's log once the blocks have landed, so its
// spawn-adopted event names them.
struct Settled {
    parent_id: String,
    adopted: Vec<String>,
    from_pending: Option<Vec<String>>,
    from_held: Option<String>,
    // The Steward whose Adopt this was (ADR-0030).
    steward: Option<String>,
    at: String,
}

/// `adoptSpawnProposals`: the boundary's spawn landing (ADR-0010, extended by the Conversations ADR,
/// ADR-0029 and issue #150): every Pending spawn, and every Held spawn the operator has adopted since,
/// is checked again against the pool as the boundary found it, and the ones that pass are written as
/// ordinary ticket files or started as Conversations, after which the pool's markers and assignments
/// reload so the drive loop schedules the ticket ones like any other. Every aspect of that stays per
/// proposal, never per batch.
///
/// The caps were met when each proposal was taken (`take_spawn_proposals`): a Pending spawn lands on
/// the room it reserved, and an adopted Held spawn passes both caps, the Adopt being the decision the
/// caps exist to ask for. A Pending spawn the pool can no longer take (a blocks target finished after
/// it was taken) is held for "refused" instead, the reason on it, so the operator sees why and
/// decides. A held one's Adopt is refused the same way: it stays held with the reason on it
/// (ADR-0029).
///
/// Writing the files is the commit point. The Pending spawns' landing ids go on disk first, so a crash
/// after a ticket file but before its Pending spawn is forgotten is settled at the next start
/// (`settle_landing_spawns`) instead of landing it twice.
pub fn adopt_spawn_proposals(session: &mut Session) -> anyhow::Result<()> {
    let pending: Vec<PendingSpawn> = session.spawn_proposals.pending().to_vec();
    let adopting: Vec<HeldSpawn> = session
        .spawn_proposals
        .adopting()
        .iter()
        .filter_map(|id| session.spawn_proposals.get_held(id).cloned())
        .collect();
    if pending.is_empty() && adopting.is_empty() {
        return Ok(());
    }
    // Membership validates against the markers as the boundary found them, so a proposal naming
    // another proposal's future id drops as unknown: the agent never proposes ids and cannot know one.
    let known = known_pool_ids(session)?;
    let mut counters = combined_spawn_counters(session)?;
    let mut log: Vec<String> = Vec::new();
    let mut wrote = false;
    let mut mint = |parent_id: &str| -> String {
        let n = counters.get(parent_id).copied().unwrap_or(0) + 1;
        counters.insert(parent_id.to_owned(), n);
        format!("{parent_id}-spawn-{n}")
    };
    let mut settled: Vec<Settled> = Vec::new();
    let mut blocking: Vec<(String, String, SpawnBlocks)> = Vec::new();

    let mut landing: Vec<(String, String)> = Vec::new();
    for entry in &pending {
        match spawn_proposal_problem(session, &entry.proposal, &known) {
            None => landing.push((entry.id.clone(), mint(&entry.parent_id))),
            Some(reason) => {
                let Some(held) =
                    session
                        .spawn_proposals
                        .hold_refused(&entry.id, &reason, &js::now_iso())?
                else {
                    continue;
                };
                append(
                    session,
                    &entry.parent_id,
                    &held.at,
                    last_attempt(runs(session), &entry.parent_id),
                    TicketEventKind::SpawnHeld,
                    json!({ "held": [held_event_entry(&held)] }),
                )?;
                log.push(format!(
                    "ticket {}: pending spawn {} ('{}') could not land: {reason}; it is held for the operator",
                    entry.parent_id, entry.id, entry.proposal.title
                ));
            }
        }
    }
    let landing_map: HashMap<String, String> = landing.iter().cloned().collect();
    session.spawn_proposals.mark_landing(&landing_map)?;
    let mut by_parent: Vec<(String, Vec<String>, Vec<String>)> = Vec::new();
    for entry in &pending {
        let Some(spawn_id) = landing_map.get(&entry.id) else {
            continue;
        };
        if land_spawn(session, &entry.parent_id, spawn_id, &entry.proposal)? {
            wrote = true;
            if let Some(blocks) = &entry.proposal.blocks {
                blocking.push((entry.parent_id.clone(), spawn_id.clone(), blocks.clone()));
            }
        }
        if entry.origin != SpawnKind::Conversation {
            session.spawned_this_run += 1;
        }
        match by_parent
            .iter_mut()
            .find(|(parent, _, _)| *parent == entry.parent_id)
        {
            Some((_, adopted, from_pending)) => {
                adopted.push(spawn_id.clone());
                from_pending.push(entry.id.clone());
            }
            None => by_parent.push((
                entry.parent_id.clone(),
                vec![spawn_id.clone()],
                vec![entry.id.clone()],
            )),
        }
    }
    session
        .spawn_proposals
        .landed(&landing.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>())?;
    let at = js::now_iso();
    for (parent_id, adopted, from_pending) in by_parent {
        log.push(format!(
            "ticket {parent_id}: adopted spawn tickets {}",
            adopted.join(", ")
        ));
        settled.push(Settled {
            parent_id,
            adopted,
            from_pending: Some(from_pending),
            from_held: None,
            steward: None,
            at: at.clone(),
        });
    }

    for held in &adopting {
        if let Some(reason) = spawn_proposal_problem(session, &held.proposal, &known) {
            // An Adopt the pool can no longer take (it passed its check when queued, and the pool
            // moved since) is refused, not lost: the proposal stays held with the reason on it
            // (ADR-0029).
            append_now(
                session,
                &held.parent_id,
                TicketEventKind::SpawnRejected,
                json!({ "title": held.proposal.title, "reason": reason, "fromHeld": held.id }),
            )?;
            session.spawn_proposals.refuse_adopt(&held.id, &reason)?;
            session.steward_adopts.remove(&held.id);
            log.push(format!(
                "ticket {}: adopting held spawn {} ('{}') refused: {reason}; it stays held",
                held.parent_id, held.id, held.proposal.title
            ));
            continue;
        }
        let spawn_id = mint(&held.parent_id);
        if land_spawn(session, &held.parent_id, &spawn_id, &held.proposal)? {
            wrote = true;
            if let Some(blocks) = &held.proposal.blocks {
                blocking.push((held.parent_id.clone(), spawn_id.clone(), blocks.clone()));
            }
        }
        if held.origin != SpawnKind::Conversation {
            session.spawned_this_run += 1;
        }
        // The held spawn leaves the Held spawns once it has landed: until then a restart finds it
        // still held.
        session.spawn_proposals.remove_held(&held.id)?;
        let steward = session.steward_adopts.remove(&held.id);
        log.push(format!(
            "ticket {}: adopted held spawn {} as {spawn_id}{}",
            held.parent_id,
            held.id,
            if steward.is_some() {
                " (the Steward's Adopt)"
            } else {
                ""
            }
        ));
        settled.push(Settled {
            parent_id: held.parent_id.clone(),
            adopted: vec![spawn_id],
            from_pending: None,
            from_held: Some(held.id.clone()),
            steward,
            at: at.clone(),
        });
    }

    if wrote {
        // The adopted files join the pool the way answer processing brings a hand-written ticket in:
        // markers reload, unseen ids resolve their assignments (parent inheritance), and the tickets
        // channel folds them in at their on-disk statuses.
        session.markers = load_pool_tickets(Path::new(&session.pool_dir), false)?;
        ac_core::assignment::resolve_unseen_assignments(
            &session.markers,
            &mut session.assignments,
            &session.state.config,
            &session.harnesses,
        )?;
        let tickets = session.marker_statuses();
        apply_update(
            &mut session.state,
            PoolUpdate {
                tickets: Some(tickets),
                ..PoolUpdate::default()
            },
        );
    }
    // Blocks land once every Spawn of this boundary is in the pool, so "all" reaches a sibling adopted
    // alongside, whichever order they came in.
    let mut blocked: Vec<(String, BlockedSpawns)> = Vec::new();
    for (parent_id, spawn_id, blocks) in &blocking {
        let targets = apply_spawn_blocks(session, spawn_id, blocks, &mut log)?;
        if targets.is_empty() {
            continue;
        }
        log.push(format!(
            "ticket {parent_id}: spawn {spawn_id} blocks {}",
            targets.join(", ")
        ));
        match blocked.iter_mut().find(|(parent, _)| parent == parent_id) {
            Some((_, spawns)) => spawns.push((spawn_id.clone(), targets)),
            None => blocked.push((parent_id.clone(), vec![(spawn_id.clone(), targets)])),
        }
    }
    for entry in settled {
        let mine: Vec<&(String, Vec<String>)> = blocked
            .iter()
            .find(|(parent, _)| *parent == entry.parent_id)
            .map(|(_, spawns)| {
                spawns
                    .iter()
                    .filter(|(id, _)| entry.adopted.contains(id))
                    .collect()
            })
            .unwrap_or_default();
        let mut payload = Map::new();
        payload.insert("adopted".into(), json!(entry.adopted));
        if let Some(from_pending) = &entry.from_pending {
            payload.insert("fromPending".into(), json!(from_pending));
        }
        if let Some(from_held) = &entry.from_held {
            payload.insert("fromHeld".into(), json!(from_held));
        }
        if let Some(steward) = &entry.steward {
            payload.insert("by".into(), json!("steward"));
            payload.insert("conversation".into(), json!(steward));
        }
        if !mine.is_empty() {
            let blocks: Map<String, Value> = mine
                .into_iter()
                .map(|(id, targets)| (id.clone(), json!(targets)))
                .collect();
            payload.insert("blocks".into(), Value::Object(blocks));
        }
        append(
            session,
            &entry.parent_id,
            &entry.at,
            last_attempt(runs(session), &entry.parent_id),
            TicketEventKind::SpawnAdopted,
            Value::Object(payload),
        )?;
    }
    if !log.is_empty() {
        apply_update(&mut session.state, PoolUpdate::log(log));
    }
    refresh_spawn_ledger_from_last(session);
    Ok(())
}

/// `settleLandingSpawns`: a crash between a Pending spawn's landing mark and its forgetting
/// (`adopt_spawn_proposals`) leaves it pending with the id it was landing under. At boot the pool says
/// which way it went: a ticket (or Conversation) under that id landed, and the Pending spawn is
/// forgotten with its spawn-adopted event; otherwise the mark is cleared and it lands at the next
/// boundary, as it would have.
pub fn settle_landing_spawns(session: &mut Session) -> anyhow::Result<()> {
    let mut log: Vec<String> = Vec::new();
    let conversations = known_conversation_ids(Path::new(&session.pool_dir))?;
    let entries: Vec<PendingSpawn> = session.spawn_proposals.pending().to_vec();
    for entry in entries {
        let Some(landing) = entry.landing.clone() else {
            continue;
        };
        let landed =
            session.markers.iter().any(|m| m.id == landing) || conversations.contains(&landing);
        if !landed {
            session.spawn_proposals.clear_landing(&entry.id)?;
            continue;
        }
        session
            .spawn_proposals
            .landed(std::slice::from_ref(&entry.id))?;
        // The crash may have come before the landing's blocks: they go on again, the way the boundary
        // puts them on, and a target that already waits on the Spawn is left as it is.
        let blocked = match &entry.proposal.blocks {
            Some(blocks) => apply_spawn_blocks(session, &landing, blocks, &mut log)?,
            None => Vec::new(),
        };
        let mut payload = Map::new();
        payload.insert("adopted".into(), json!([landing]));
        payload.insert("fromPending".into(), json!([entry.id]));
        if !blocked.is_empty() {
            let mut blocks = Map::new();
            blocks.insert(landing.clone(), json!(blocked));
            payload.insert("blocks".into(), Value::Object(blocks));
        }
        append_now(
            session,
            &entry.parent_id,
            TicketEventKind::SpawnAdopted,
            Value::Object(payload),
        )?;
        log.push(format!(
            "ticket {}: pending spawn {} had landed as {landing} before the restart{}",
            entry.parent_id,
            entry.id,
            if blocked.is_empty() {
                String::new()
            } else {
                format!("; it blocks {}", blocked.join(", "))
            }
        ));
    }
    if !log.is_empty() {
        apply_update(&mut session.state, PoolUpdate::log(log));
    }
    Ok(())
}

/// `refreshSpawnLedger`: the Spawn ledger follows every emit, so what agents read there is never
/// staler than what the Console shows (issue #150). An unchanged ledger writes nothing; a write that
/// fails is left for the next change to try again.
pub fn refresh_spawn_ledger(session: &mut Session, conversations: &[ConversationView]) {
    let tickets: Vec<LedgerEntry> = session
        .markers
        .iter()
        .map(|marker| LedgerEntry {
            id: marker.id.clone(),
            title: marker.title.clone(),
            status: session
                .status_of(&marker.id)
                .unwrap_or(marker.status)
                .to_string(),
        })
        .collect();
    let conversations: Vec<LedgerEntry> = conversations
        .iter()
        .map(|c| LedgerEntry {
            id: c.id.clone(),
            title: c.title.clone(),
            status: c.status.to_string(),
        })
        .collect();
    let text = render_spawn_ledger(SpawnLedgerInput {
        tickets: &tickets,
        conversations: &conversations,
        pending: session.spawn_proposals.pending(),
        held: session.spawn_proposals.held(),
    });
    if session.spawn_ledger.as_deref() == Some(text.as_str()) {
        return;
    }
    if write_spawn_ledger(Path::new(&session.runs_dir), &text).is_ok() {
        session.spawn_ledger = Some(text);
    }
}

/// `refreshSpawnLedger` with its default conversations: the last emitted snapshot's.
pub fn refresh_spawn_ledger_from_last(session: &mut Session) {
    let conversations = session
        .snapshots
        .back()
        .map(|snapshot| snapshot.conversations.clone())
        .unwrap_or_default();
    refresh_spawn_ledger(session, &conversations);
}

/// `spawnsAwaitBoundary`: Pending spawns, and Held spawns an Adopt has queued, wait for a boundary to
/// land them. A drive that closes with any leaves the next drive to land them.
pub fn spawns_await_boundary(session: &Session) -> bool {
    !session.spawn_proposals.pending().is_empty() || !session.spawn_proposals.adopting().is_empty()
}

/// The path of the Spawn ledger, as the Steward's state read names it.
pub fn ledger_path(session: &Session) -> String {
    js::path_text(&spawn_ledger_path(runs(session)))
}

fn emit_current(session: &mut Session) {
    let phase = session.current_phase();
    emit_snapshot(session, phase);
}

/// `adoptHeldSpawn`: the operator's Adopt of a Held spawn (ADR-0029). It is refused up front, the
/// spawn staying held, when the pool as it stands would reject the proposal (a blocker gone from the
/// pool, a harness no longer known) or when the pool has finished and its store is closed, since the
/// drive that would schedule the new ticket could not record it; a Restart reopens the pool with the
/// spawn still held. Otherwise it queues for the boundary, past the caps: at once when the engine is
/// idle, the way a Conversation's spawn.json is adopted, and at the next boundary when a drive is in
/// flight. A boundary that finds the pool has moved since and refuses it leaves it held with the
/// reason (adoptError), which the next Adopt clears. An overlaps mark is not checked again: the Adopt
/// is the operator's answer to it.
pub fn adopt_held_spawn(session: &mut Session, id: &str) -> Result<(), EngineError> {
    let Some(held) = session.spawn_proposals.get_held(id).cloned() else {
        return Err(refused(format!("no held spawn {id}")));
    };
    if session.spawn_proposals.is_adopting(id) {
        return Ok(());
    }
    if !session.store_open {
        return Err(refused(format!(
            "held spawn {id} cannot be adopted: the pool has finished; Restart the Console to adopt it"
        )));
    }
    let known = known_pool_ids(session).map_err(|e| refused(e.to_string()))?;
    if let Some(problem) = spawn_proposal_problem(session, &held.proposal, &known) {
        return Err(refused(format!(
            "held spawn {id} cannot be adopted: {problem}"
        )));
    }
    session
        .spawn_proposals
        .begin_adopt(id)
        .map_err(|e| refused(e.to_string()))?;
    if !session.driving {
        adopt_spawn_proposals(session).map_err(|e| refused(e.to_string()))?;
        crate::answers::kick_processing(session).map_err(|e| refused(e.to_string()))?;
    } else {
        emit_snapshot(session, ac_protocol::RunPhase::Running);
    }
    Ok(())
}

/// `discardHeldSpawn`: the operator's Discard of a Held spawn (ADR-0029): gone for good, the discard
/// on the parent's log. One an Adopt has already queued is past discarding: the boundary is about to
/// write it.
pub fn discard_held_spawn(
    session: &mut Session,
    id: &str,
    steward: Option<&str>,
) -> Result<(), EngineError> {
    let Some(held) = session.spawn_proposals.get_held(id).cloned() else {
        return Err(refused(format!("no held spawn {id}")));
    };
    if session.spawn_proposals.is_adopting(id) {
        return Err(refused(format!("held spawn {id} is already being adopted")));
    }
    session
        .spawn_proposals
        .remove_held(id)
        .map_err(|e| refused(e.to_string()))?;
    let mut payload = Map::new();
    payload.insert("id".into(), json!(id));
    payload.insert("title".into(), json!(held.proposal.title));
    if let Some(steward) = steward {
        payload.insert("by".into(), json!("steward"));
        payload.insert("conversation".into(), json!(steward));
    }
    append_now(
        session,
        &held.parent_id,
        TicketEventKind::SpawnDiscarded,
        Value::Object(payload),
    )
    .map_err(|e| refused(e.to_string()))?;
    log_line(
        session,
        format!(
            "ticket {}: held spawn {id} ('{}') discarded by the {}",
            held.parent_id,
            held.proposal.title,
            if steward.is_some() {
                "Steward"
            } else {
                "operator"
            }
        ),
    );
    emit_current(session);
    Ok(())
}

// Why a Pending spawn cannot be held or discarded: it is not pending. The boundary lands pending
// spawns synchronously, so an operator's action that arrives after it finds the spawn gone rather
// than half landed.
fn not_pending(session: &Session, id: &str) -> EngineError {
    refused(if session.spawn_proposals.get_held(id).is_some() {
        format!("spawn {id} is already held")
    } else {
        format!("no pending spawn {id}: it has landed or been discarded")
    })
}

/// `holdPendingSpawn`: the operator's Hold of a Pending spawn (issue #150): kept back from the
/// boundary as a Held spawn, held by the operator, under the same id, so the Spawn ledger's name for
/// it still holds. Its run room is free again until an Adopt lands it.
pub fn hold_pending_spawn(session: &mut Session, id: &str) -> Result<(), EngineError> {
    if session.spawn_proposals.get_pending(id).is_none() {
        return Err(not_pending(session, id));
    }
    let held = session
        .spawn_proposals
        .hold_pending(id, &js::now_iso())
        .map_err(|e| refused(e.to_string()))?
        .ok_or_else(|| not_pending(session, id))?;
    append(
        session,
        &held.parent_id,
        &held.at,
        last_attempt(runs(session), &held.parent_id),
        TicketEventKind::SpawnHeld,
        json!({ "held": [held_event_entry(&held)] }),
    )
    .map_err(|e| refused(e.to_string()))?;
    log_line(
        session,
        format!(
            "ticket {}: pending spawn {id} ('{}') held by the operator",
            held.parent_id, held.proposal.title
        ),
    );
    emit_current(session);
    Ok(())
}

/// `discardPendingSpawn`: the operator's Discard of a Pending spawn (issue #150): gone for good, the
/// discard on the parent's log, its run room free again.
pub fn discard_pending_spawn(session: &mut Session, id: &str) -> Result<(), EngineError> {
    let Some(pending) = session.spawn_proposals.get_pending(id).cloned() else {
        return Err(not_pending(session, id));
    };
    session
        .spawn_proposals
        .remove_pending(id)
        .map_err(|e| refused(e.to_string()))?;
    append_now(
        session,
        &pending.parent_id,
        TicketEventKind::SpawnDiscarded,
        json!({ "id": id, "title": pending.proposal.title, "pending": true }),
    )
    .map_err(|e| refused(e.to_string()))?;
    log_line(
        session,
        format!(
            "ticket {}: pending spawn {id} ('{}') discarded by the operator",
            pending.parent_id, pending.proposal.title
        ),
    );
    emit_current(session);
    Ok(())
}

/// `recoverTruncatedSpawns`: recovery of the proposals the caps truncated before ADR-0029 (issue
/// #149's og-review loss): at boot, each is held as if the cap had held it. What survives of one is the
/// parent's checkpointed Outcome, whose spawn array is every schema-valid proposal in order, and the
/// parent's last `spawn-adopted` event, which a pre-ADR adoption wrote with the ids it adopted and a
/// `truncated` count (a post-ADR one has no such count, so it is never mistaken for one). The adoption
/// dropped the proposals it rejected, logging each as a `spawn-rejected` event carrying its title just
/// before the `spawn-adopted`, then honored the survivors in order and truncated the tail; so the
/// truncated proposals are the last `truncated` survivors once those rejected titles are taken out.
/// The rule holds only when the parent's Outcome is the one that adoption read, which the count checks
/// (survivors must number exactly adopted plus truncated), and when the rejected titles are
/// unambiguous (none is shared by two proposals); otherwise the parent is left alone with a log line.
/// Only the last adoption of a parent can match its Outcome, and only a Ticket has an Outcome, so a
/// truncated Conversation batch is past recovering. Each recovery is keyed by parent and event time
/// and recorded with its holds in one write, so it runs once however the operator later adopts or
/// discards what it held.
pub fn recover_truncated_spawns(session: &mut Session) -> anyhow::Result<()> {
    let mut log: Vec<String> = Vec::new();
    let outcomes: Vec<(String, Vec<SpawnProposal>)> = session
        .state
        .outcomes
        .iter()
        .filter_map(|(id, outcome)| {
            outcome
                .spawn
                .clone()
                .filter(|spawn| !spawn.is_empty())
                .map(|spawn| (id.clone(), spawn))
        })
        .collect();
    for (parent_id, spawn) in outcomes {
        let events = read_events(runs(session), &parent_id);
        let adoptions: Vec<usize> = events
            .iter()
            .enumerate()
            .filter(|(_, event)| event.kind == TicketEventKind::SpawnAdopted)
            .map(|(index, _)| index)
            .collect();
        let Some(&last) = adoptions.last() else {
            continue;
        };
        let event = &events[last];
        let truncated = match event.payload.get("truncated").and_then(js::number_of) {
            Some(n) if n > 0.0 => n as usize,
            _ => continue,
        };
        let key = format!("{parent_id}@{}", event.at);
        if session.spawn_proposals.was_recovered(&key) {
            continue;
        }
        let from = if adoptions.len() >= 2 {
            adoptions[adoptions.len() - 2] + 1
        } else {
            0
        };
        let mut rejected: Vec<String> = events[from..last]
            .iter()
            .filter(|e| e.kind == TicketEventKind::SpawnRejected)
            .filter_map(|e| e.payload.get("title").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        // A rejected title shared by two proposals leaves which one was rejected unknown, and guessing
        // could hold one already adopted, whose Adopt would write it twice: such a parent is not
        // recovered.
        let twin = rejected
            .iter()
            .find(|title| spawn.iter().filter(|p| &p.title == *title).count() > 1)
            .cloned();
        if let Some(twin) = twin {
            session.spawn_proposals.recover(&key, Vec::new())?;
            log.push(format!(
                "ticket {parent_id}: {truncated} spawn proposal{} truncated before held spawns \
                 existed could not be recovered: its rejected proposal '{twin}' shares a title with \
                 another, so which one was rejected is unknown",
                plural(truncated)
            ));
            continue;
        }
        let survivors: Vec<SpawnProposal> = spawn
            .into_iter()
            .filter(
                |proposal| match rejected.iter().position(|t| *t == proposal.title) {
                    None => true,
                    Some(at) => {
                        rejected.remove(at);
                        false
                    }
                },
            )
            .collect();
        let adopted = event
            .payload
            .get("adopted")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        if survivors.len() != adopted + truncated {
            session.spawn_proposals.recover(&key, Vec::new())?;
            log.push(format!(
                "ticket {parent_id}: {truncated} spawn proposal{} truncated before held spawns \
                 existed could not be matched to its Outcome; not recovered",
                plural(truncated)
            ));
            continue;
        }
        let first = survivors.len() - truncated;
        let entries: Vec<NewHeldSpawn> = survivors
            .into_iter()
            .skip(first)
            .enumerate()
            .map(|(i, proposal)| NewHeldSpawn {
                parent_id: parent_id.clone(),
                origin: SpawnKind::Ticket,
                proposal,
                reason: if first + i >= PRE_ADR_0029_PER_ATTEMPT {
                    HeldSpawnReason::PerAttempt
                } else {
                    HeldSpawnReason::PerRun
                },
                at: event.at.clone(),
                adopt_error: None,
                unknown_overlaps: None,
            })
            .collect();
        let held = session.spawn_proposals.recover(&key, entries)?;
        append_now(
            session,
            &parent_id,
            TicketEventKind::SpawnHeld,
            json!({
                "held": held
                    .iter()
                    .map(|h| json!({ "id": h.id, "title": h.proposal.title, "reason": h.reason.as_str() }))
                    .collect::<Vec<_>>(),
                "recovered": true,
            }),
        )?;
        log.push(format!(
            "ticket {parent_id}: recovered {} spawn proposal{} a cap truncated before held spawns \
             existed: {}",
            held.len(),
            plural(held.len()),
            held.iter()
                .map(|h| h.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !log.is_empty() {
        apply_update(&mut session.state, PoolUpdate::log(log));
    }
    Ok(())
}

#[cfg(test)]
#[path = "spawns_tests.rs"]
mod tests;
