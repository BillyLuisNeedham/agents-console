//! The enriched snapshot (server.ts `enrich`): the engine's snapshot carries `state.tickets` as an id to
//! status map and `assignments` as the resolved Assignment per ticket (ADR-0013); the server enriches the
//! former into the array of tickets the Console draws, with each Issue file's title and blocked-by edges,
//! the Merge queue's state, the Live attempt and Held pane, and the Reassign row. Every fact on it is the
//! engine's or the pool files'; nothing here reads git or the events files.

use std::collections::HashMap;

use indexmap::IndexMap;

use ac_core::assignment::unassigned_assignment_view;
use ac_core::pool::TicketMarker;
use ac_engine::PoolSnapshot;
use ac_protocol::{
    AssignmentSource, AssignmentSources, EnrichedSnapshot, EnrichedTicketState, SnapshotState,
    TicketReassignView, TicketStatus,
};

use crate::reassign::TicketReassignEntry;

/// The Reassign row a ticket the module did not answer for falls back to: not reassignable, because
/// nothing here can say that a write would reach it. Only a meta id that arrived between the views and
/// the enrichment can hit it.
pub fn unknown_reassign() -> TicketReassignView {
    TicketReassignView {
        eligible: false,
        reason: Some("not yet known to the pool config".to_owned()),
        verify: None,
        // Drivers always resolve to something, so "unset" is a value the resolver never reports for
        // them and the badge would never otherwise show.
        sources: AssignmentSources {
            harness: AssignmentSource::Unset,
            model: AssignmentSource::Unset,
            effort: AssignmentSource::Unset,
            drivers: AssignmentSource::Default,
        },
    }
}

/// The pool's display name: the last two "/" segments of its directory.
pub fn pool_name_of(pool_dir: &str) -> String {
    let segments: Vec<&str> = pool_dir.split('/').collect();
    segments[segments.len().saturating_sub(2)..].join("/")
}

/// Enrich an engine snapshot with the pool's ticket metadata for the Console.
pub fn enrich(
    snapshot: &PoolSnapshot,
    meta: &[TicketMarker],
    pool_name: &str,
    pool_dir: &str,
    // One row per ticket, resolved from the config file rather than from the engine's session, so a
    // save shows on the card before the boundary that will apply it (issue #126).
    reassign: &IndexMap<String, TicketReassignEntry>,
    // The Pool title from the config file as it stands now (issue #100).
    pool_title: Option<String>,
) -> EnrichedSnapshot {
    let merge: HashMap<&str, _> = snapshot
        .merge_queue
        .iter()
        .map(|entry| (entry.ticket_id.as_str(), entry.state))
        .collect();
    let tickets = meta
        .iter()
        .map(|marker| {
            let row = reassign.get(&marker.id);
            EnrichedTicketState {
                id: marker.id.clone(),
                title: marker.title.clone(),
                blocked_by: marker.blocked_by.clone(),
                status: snapshot
                    .state
                    .tickets
                    .get(&marker.id)
                    .copied()
                    .unwrap_or(TicketStatus::Ready),
                merge_state: merge.get(marker.id.as_str()).copied(),
                // A reassignable ticket's Assignment comes from the config file as it stands now, so
                // a Reassign shows at once; everywhere else the engine's record is the truth, and a
                // meta id the engine has not resolved yet reads as unassigned.
                assignment: row
                    .and_then(|row| row.assignment.clone())
                    .or_else(|| snapshot.assignments.get(&marker.id).cloned())
                    .unwrap_or_else(unassigned_assignment_view),
                live_attempt: snapshot.live_attempts.get(&marker.id).cloned(),
                held_pane: snapshot.held_panes.get(&marker.id).cloned(),
                // An enlisted ticket (issue #101) reads "as found": the marker field is the durable fact.
                enlisted: marker.enlisted_from.is_some(),
                reassign: row.map_or_else(unknown_reassign, |row| row.reassign.clone()),
            }
        })
        .collect();
    EnrichedSnapshot {
        seq: snapshot.seq,
        phase: snapshot.phase,
        pool_name: pool_name.to_owned(),
        pool_title,
        pool_dir: pool_dir.to_owned(),
        finished_terminals: snapshot.finished_terminals,
        spawn_usage: snapshot.spawn_usage.clone(),
        pending_spawns: snapshot.pending_spawns.clone(),
        held_spawns: snapshot.held_spawns.clone(),
        steward_budget: Some(snapshot.steward_budget.clone()),
        state: SnapshotState {
            tickets,
            conversations: snapshot.conversations.clone(),
            log: snapshot.state.log.clone(),
            outcomes: snapshot.state.outcomes.clone(),
            interrupts: snapshot.state.interrupts.clone(),
            merge_queue: snapshot.merge_queue.clone(),
            queued_answers: snapshot.queued_answers.clone(),
            config: snapshot.state.config.to_map(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // server.test.ts:283
    #[test]
    fn names_the_pool_by_its_last_two_path_segments() {
        assert_eq!(
            pool_name_of("/tmp/x/ai-agent-graphs-fix/tickets"),
            "ai-agent-graphs-fix/tickets"
        );
        assert_eq!(
            pool_name_of("/tmp/x/repo/.scratch/tickets"),
            ".scratch/tickets"
        );
        assert_eq!(pool_name_of("/pool"), "/pool");
    }
}
