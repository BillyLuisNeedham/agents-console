//! Interrupts (engine.ts 8845-9235): raising and clearing them, the deadlock reconcile, checkpoints
//! and their Briefs, and the final Review with its approve and reject.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Map;

use ac_core::events::{append_event, attempt_outcome_name, event_now, last_attempt};
use ac_core::pool::{TicketMarker, is_finished, write_marker_status};
use ac_protocol::{Interrupt, InterruptKind, TicketEventKind, TicketStatus};

use crate::session::{PoolUpdate, REVIEW_TICKET_ID, Session};

/// The heading of a Brief the engine wrote itself.
pub const ENGINE_BRIEF_HEADING: &str = "## Brief, written by the engine";

/// The engine's Brief for a checkpoint whose agent wrote none.
pub const ENGINE_CHECKPOINT_PLACEHOLDER: &str = "The agent signalled a checkpoint but wrote no \
     brief, so what the attempt completed is only in the ticket log. Answer the interrupt to point the \
     next attempt.";

/// The Interrupts a Close answers (issue #154).
pub const CLOSE_KINDS: [InterruptKind; 3] = [
    InterruptKind::Checkpoint,
    InterruptKind::MergeConflict,
    InterruptKind::Deadlock,
];

/// An Interrupt with no candidates and no Steward note.
pub fn interrupt(ticket_id: &str, kind: InterruptKind, body: impl Into<String>) -> Interrupt {
    Interrupt {
        ticket_id: ticket_id.to_owned(),
        kind,
        body: body.into(),
        candidates: None,
        steward_note: None,
    }
}

fn runs(session: &Session) -> &Path {
    Path::new(&session.runs_dir)
}

/// Append an event at the ticket's latest attempt, as the engine's own records do.
pub fn append_at_last_attempt(
    session: &Session,
    ticket_id: &str,
    kind: TicketEventKind,
    payload: Map<String, serde_json::Value>,
) -> anyhow::Result<()> {
    let attempt = last_attempt(runs(session), ticket_id);
    append_event(runs(session), ticket_id, &event_now(attempt, kind, payload))?;
    Ok(())
}

/// `raiseInterrupt`: every interrupt is raised here, deduped on its ticket and kind.
pub fn raise_interrupt(session: &mut Session, interrupt: Interrupt) {
    if session
        .state
        .interrupts
        .iter()
        .any(|i| i.ticket_id == interrupt.ticket_id && i.kind == interrupt.kind)
    {
        return;
    }
    let line = format!(
        "interrupt raised for {} ({}){}",
        interrupt.ticket_id,
        interrupt.kind,
        if interrupt.kind == InterruptKind::Deadlock {
            format!(": {}", interrupt.body)
        } else {
            String::new()
        }
    );
    let mut interrupts = session.state.interrupts.clone();
    interrupts.push(interrupt);
    session.apply(PoolUpdate {
        interrupts: Some(interrupts),
        log: Some(vec![line]),
        ..PoolUpdate::default()
    });
}

/// The interrupts without `interrupt` (TypeScript's identity filter: a ticket holds one interrupt of
/// a kind at a time, so equality finds the same one).
pub fn without(interrupts: &[Interrupt], interrupt: &Interrupt) -> Vec<Interrupt> {
    interrupts
        .iter()
        .filter(|i| *i != interrupt)
        .cloned()
        .collect()
}

/// `clearInterrupt`: drop the interrupt and add one log line.
pub fn clear_interrupt(session: &mut Session, interrupt: &Interrupt, log: String) {
    let interrupts = without(&session.state.interrupts, interrupt);
    session.apply(PoolUpdate {
        interrupts: Some(interrupts),
        log: Some(vec![log]),
        ..PoolUpdate::default()
    });
}

struct Deadlocks<'a> {
    session: &'a Session,
    resumable: HashSet<&'a str>,
    deadlocked: HashSet<&'a str>,
}

impl Deadlocks<'_> {
    fn status(&self, id: &str) -> Option<TicketStatus> {
        self.session.state.tickets.get(id).copied()
    }

    fn can_complete(&self, id: &str, visiting: &mut HashSet<String>) -> bool {
        match self.status(id) {
            Some(TicketStatus::Done | TicketStatus::InProgress) => return true,
            // A closed ticket (issue #154) never becomes done, so it never satisfies the edge.
            Some(TicketStatus::Closed) => return false,
            _ => {}
        }
        if self.resumable.contains(id) {
            return true;
        }
        if self.deadlocked.contains(id) || visiting.contains(id) {
            return false;
        }
        let Some(marker) = self.session.marker(id) else {
            return false;
        };
        visiting.insert(id.to_owned());
        let ok = marker
            .blocked_by
            .iter()
            .all(|b| self.can_complete(b, visiting));
        visiting.remove(id);
        ok
    }

    fn completes(&self, id: &str) -> bool {
        self.can_complete(id, &mut HashSet::new())
    }

    // The closed ticket a blocker that can never complete is stuck behind, followed up the chain of
    // blockers that cannot complete either; `None` when the chain reaches none.
    fn closed_behind(&self, id: &str, visiting: &mut HashSet<String>) -> Option<String> {
        if self.status(id) == Some(TicketStatus::Closed) {
            return Some(id.to_owned());
        }
        if !visiting.insert(id.to_owned()) {
            return None;
        }
        let blockers = self
            .session
            .marker(id)
            .map(|m| m.blocked_by.clone())
            .unwrap_or_default();
        for b in blockers {
            if self.completes(&b) {
                continue;
            }
            if let Some(found) = self.closed_behind(&b, visiting) {
                return Some(found);
            }
        }
        None
    }
}

/// `reconcileDeadlocks`: a deadlock Interrupt for every unfinished ticket whose blockers can never
/// complete, and a clear for every deadlock whose blockers can complete again.
pub fn reconcile_deadlocks(session: &mut Session) -> anyhow::Result<()> {
    let (cleared, raised) = {
        let state = &session.state;
        let check = Deadlocks {
            session,
            resumable: state
                .interrupts
                .iter()
                .filter(|i| i.kind != InterruptKind::Deadlock)
                .map(|i| i.ticket_id.as_str())
                .collect(),
            deadlocked: state
                .interrupts
                .iter()
                .filter(|i| i.kind == InterruptKind::Deadlock)
                .map(|i| i.ticket_id.as_str())
                .collect(),
        };
        let cleared: Vec<Interrupt> = state
            .interrupts
            .iter()
            .filter(|i| i.kind == InterruptKind::Deadlock && check.completes(&i.ticket_id))
            .cloned()
            .collect();
        let raised: Vec<(TicketMarker, Vec<String>, Interrupt)> = session
            .markers
            .iter()
            .filter(|marker| {
                !is_finished(check.status(&marker.id))
                    && !check.resumable.contains(marker.id.as_str())
                    && !check.deadlocked.contains(marker.id.as_str())
                    && !check.completes(&marker.id)
            })
            .map(|marker| {
                let blocking: Vec<String> = marker
                    .blocked_by
                    .iter()
                    .filter(|id| !check.completes(id))
                    .cloned()
                    .collect();
                // A blocker that was closed is named as closed; a blocker stuck behind a closed ticket
                // further up its chain names that ticket too.
                let closed: Vec<&String> = blocking
                    .iter()
                    .filter(|id| check.status(id) == Some(TicketStatus::Closed))
                    .collect();
                let behind: Vec<(&String, Option<String>)> = blocking
                    .iter()
                    .filter(|id| check.status(id) != Some(TicketStatus::Closed))
                    .map(|id| (id, check.closed_behind(id, &mut HashSet::new())))
                    .collect();
                let stuck: Vec<&str> = behind
                    .iter()
                    .filter(|(_, cause)| cause.is_none())
                    .map(|(id, _)| id.as_str())
                    .collect();
                let mut parts = Vec::new();
                if !closed.is_empty() {
                    parts.push(if closed.len() == 1 {
                        format!("blocker {} was closed", closed[0])
                    } else {
                        format!(
                            "blockers {} were closed",
                            closed
                                .iter()
                                .map(|s| s.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    });
                }
                for (id, cause) in &behind {
                    if let Some(cause) = cause {
                        parts.push(format!(
                            "blocker {id} can never complete (blocker {cause} was closed)"
                        ));
                    }
                }
                if !stuck.is_empty() {
                    parts.push(format!("blockers can never complete: {}", stuck.join(", ")));
                }
                let body = parts.join("; ");
                (
                    marker.clone(),
                    blocking,
                    interrupt(&marker.id, InterruptKind::Deadlock, body),
                )
            })
            .collect();
        (cleared, raised)
    };
    if cleared.is_empty() && raised.is_empty() {
        return Ok(());
    }
    let mut interrupts: Vec<Interrupt> = session
        .state
        .interrupts
        .iter()
        .filter(|i| {
            !cleared
                .iter()
                .any(|c| c.ticket_id == i.ticket_id && c.kind == i.kind)
        })
        .cloned()
        .collect();
    let mut log = Vec::new();
    for interrupt in &cleared {
        append_at_last_attempt(
            session,
            &interrupt.ticket_id,
            TicketEventKind::DeadlockCleared,
            Map::new(),
        )?;
        log.push(format!(
            "interrupt cleared for {} (deadlock): blockers can complete again",
            interrupt.ticket_id
        ));
    }
    for (marker, blocking, interrupt) in raised {
        let mut payload = Map::new();
        payload.insert("blockers".into(), serde_json::Value::from(blocking));
        append_at_last_attempt(session, &marker.id, TicketEventKind::Deadlock, payload)?;
        log.push(format!(
            "interrupt raised for {} (deadlock): {}",
            marker.id, interrupt.body
        ));
        interrupts.push(interrupt);
    }
    session.apply(PoolUpdate {
        interrupts: Some(interrupts),
        log: Some(log),
        ..PoolUpdate::default()
    });
    Ok(())
}

/// `checkpointInterrupt`: a checkpoint's interrupt carries the Issue's Brief.
pub fn checkpoint_interrupt(marker: &TicketMarker) -> anyhow::Result<Interrupt> {
    Ok(interrupt(
        &marker.id,
        InterruptKind::Checkpoint,
        extract_brief(&marker.file)?,
    ))
}

/// `raiseCheckpoint`: raise a checkpoint's interrupt and record its checkpoint event. Shared by the
/// at-exit path and the recovery path; `candidates` are the adoptable Candidates of a paused verify
/// round (ADR-0035).
pub fn raise_checkpoint(
    session: &mut Session,
    marker: &TicketMarker,
    attempt: u64,
    candidates: Option<Vec<u64>>,
) -> anyhow::Result<()> {
    let mut checkpoint = checkpoint_interrupt(marker)?;
    if let Some(candidates) = candidates.filter(|c| !c.is_empty()) {
        checkpoint.candidates = Some(candidates);
    }
    let body = checkpoint.body.clone();
    raise_interrupt(session, checkpoint);
    append_event(
        runs(session),
        &marker.id,
        &event_now(attempt, TicketEventKind::Checkpoint, Map::new()),
    )?;
    crate::conversations::ticket_checkpointed(session, marker, &body);
    crate::held::hold_checkpoint_pane(session, marker, attempt);
    Ok(())
}

// "## Brief" and "## Brief, written by the engine" both head a Brief section; "## Briefing" would not
// be one (`/^## Brief(?![a-zA-Z])/`).
fn is_brief_heading(line: &str) -> bool {
    line.strip_prefix("## Brief")
        .is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_alphabetic()))
}

/// The Brief section of an Issue's text: from its heading to the next "## " heading, trimmed.
pub fn extract_brief_text(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let Some(start) = lines.iter().position(|line| is_brief_heading(line)) else {
        return "(no Brief section in the Issue file)".into();
    };
    let rest = &lines[start + 1..];
    let end = rest
        .iter()
        .position(|line| line.starts_with("## "))
        .unwrap_or(rest.len());
    ac_core::js::trim(&rest[..end].join("\n")).to_owned()
}

/// `extractBrief`: the Issue file's Brief section.
pub fn extract_brief(issue_file: &Path) -> anyhow::Result<String> {
    Ok(extract_brief_text(&ac_core::js::read_text(issue_file)?))
}

/// `stripBriefSections`: remove every Brief section (heading to the next "## " heading or the end),
/// plus the "---" separator an engine append put before it.
pub fn strip_brief_sections(text: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in text.split('\n') {
        if is_brief_heading(line) {
            skipping = true;
            while kept
                .last()
                .is_some_and(|last| ac_core::js::trim(last).is_empty())
            {
                kept.pop();
            }
            if kept
                .last()
                .is_some_and(|last| ac_core::js::trim(last) == "---")
            {
                kept.pop();
            }
            continue;
        }
        if skipping && line.starts_with("## ") {
            skipping = false;
        }
        if !skipping {
            kept.push(line);
        }
    }
    kept.join("\n")
}

static TRAILING_NEWLINES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("\n+$").expect("the trailing newlines pattern compiles"));

/// The Issue's text with its Brief replaced by `brief`, or by the engine's placeholder when the agent
/// wrote none.
pub fn landed_brief_text(text: &str, brief: Option<&str>) -> String {
    let trimmed = ac_core::js::trim(brief.unwrap_or(""));
    let stripped = strip_brief_sections(text);
    let stripped = TRAILING_NEWLINES.replace(&stripped, "");
    let section = if trimmed.is_empty() {
        format!("{ENGINE_BRIEF_HEADING}\n\n{ENGINE_CHECKPOINT_PLACEHOLDER}")
    } else {
        format!("## Brief\n\n{trimmed}")
    };
    format!("{stripped}\n\n---\n\n{section}\n")
}

/// `landCheckpointBrief`: on a checkpoint the Brief travels in the outcome JSON (ADR-0005) and the
/// engine lands it in the canonical Issue, replacing the Brief section outright.
pub fn land_checkpoint_brief(issue_file: &Path, brief: Option<&str>) -> anyhow::Result<()> {
    let text = ac_core::js::read_text(issue_file)?;
    ac_core::js::write_file(issue_file, &landed_brief_text(&text, brief))?;
    Ok(())
}

/// `reviewInterrupt`: the final Review, listing every ticket's summary.
pub fn review_interrupt(session: &Session) -> Interrupt {
    let closed = session
        .markers
        .iter()
        .any(|marker| marker.status == TicketStatus::Closed);
    let lines: Vec<String> = session
        .markers
        .iter()
        .map(|marker| {
            let what = if marker.status == TicketStatus::Closed {
                "closed without merging".to_owned()
            } else {
                session
                    .state
                    .outcomes
                    .get(&marker.id)
                    .map_or("(no outcome recorded)".to_owned(), |o| o.summary.clone())
            };
            format!("- {}: {what}", marker.id)
        })
        .collect();
    interrupt(
        REVIEW_TICKET_ID,
        InterruptKind::Review,
        format!(
            "{}{}\napprove to end the run, or reject with a note naming the tickets to send back; \
             their downstream tickets return to ready with them.",
            if closed {
                "every ticket is done or closed.\n"
            } else {
                "every ticket is done.\n"
            },
            lines.join("\n")
        ),
    )
}

/// `approveReview`: approving ends the run, but only while the markers reloaded from disk are all
/// finished.
pub fn approve_review(session: &mut Session, review: &Interrupt, note: Option<&str>) {
    let all_done = session.markers.iter().all(|m| is_finished(Some(m.status)));
    let note = ac_core::js::trim(note.unwrap_or(""));
    let line = if all_done {
        format!(
            "review approved: the run is complete{}",
            if note.is_empty() {
                String::new()
            } else {
                format!(" ({note})")
            }
        )
    } else {
        "review approved, but markers on disk are not all done: the run continues to a fresh review"
            .to_owned()
    };
    let tickets = session.marker_statuses();
    let interrupts = without(&session.state.interrupts, review);
    session.apply(PoolUpdate {
        tickets: Some(tickets),
        interrupts: Some(interrupts),
        log: Some(vec![line]),
        review_approved: Some(all_done),
        ..PoolUpdate::default()
    });
}

/// `namesTicket`: an id counts as named when it appears in the note delimited by non-id characters.
pub fn names_ticket(note: &str, id: &str) -> bool {
    let pattern = format!("(^|[^A-Za-z0-9_-]){}($|[^A-Za-z0-9_-])", regex::escape(id));
    Regex::new(&pattern).is_ok_and(|re| re.is_match(note))
}

/// The tickets a review reject can send back: every one but a closed ticket.
pub fn reopenable(markers: &[TicketMarker]) -> impl Iterator<Item = &TicketMarker> {
    markers
        .iter()
        .filter(|marker| marker.status != TicketStatus::Closed)
}

/// The ticket ids a review reject's note names.
pub fn named_review_tickets(markers: &[TicketMarker], note: Option<&str>) -> Vec<String> {
    let text = ac_core::js::trim(note.unwrap_or(""));
    reopenable(markers)
        .filter(|marker| names_ticket(text, &marker.id))
        .map(|marker| marker.id.clone())
        .collect()
}

/// The refusal of a review reject that names no ticket.
pub fn review_reject_unnamed_error(markers: &[TicketMarker]) -> String {
    format!(
        "review reject: name at least one ticket in the note (known: {})",
        reopenable(markers)
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// `rejectReview`: the named tickets go back to ready with the note on their Issue files, and their
/// downstream tickets with them; their Outcomes are dropped from the channel and from disk.
pub fn reject_review(
    session: &mut Session,
    review: &Interrupt,
    note: Option<&str>,
) -> anyhow::Result<()> {
    let named = named_review_tickets(&session.markers, note);
    if named.is_empty() {
        anyhow::bail!(review_reject_unnamed_error(&session.markers));
    }
    let mut reset: Vec<String> = named.clone();
    let mut grew = true;
    while grew {
        grew = false;
        for marker in reopenable(&session.markers) {
            if !reset.contains(&marker.id) && marker.blocked_by.iter().any(|b| reset.contains(b)) {
                reset.push(marker.id.clone());
                grew = true;
            }
        }
    }
    let note_text = ac_core::js::trim(note.unwrap_or("")).to_owned();
    let runs_dir = session.runs_dir.clone();
    for index in 0..session.markers.len() {
        let id = session.markers[index].id.clone();
        if !reset.contains(&id) {
            continue;
        }
        append_at_last_attempt(session, &id, TicketEventKind::ReviewReject, Map::new())?;
        let file = session.markers[index].file.clone();
        write_marker_status(&file, TicketStatus::Ready)?;
        session.markers[index].status = TicketStatus::Ready;
        if named.contains(&id) {
            ac_core::js::append_file(&file, &format!("\n## Review note\n\n{note_text}\n"))?;
        }
        let outcome = Path::new(&runs_dir).join(attempt_outcome_name(&id, None, false));
        let _ = std::fs::remove_file(outcome);
    }
    let downstream: Vec<&String> = reset.iter().filter(|id| !named.contains(id)).collect();
    let line = format!(
        "review rejected: {} back to ready{}",
        named.join(", "),
        if downstream.is_empty() {
            String::new()
        } else {
            format!(
                "; downstream {} also reset",
                downstream
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
    );
    let tickets = session.marker_statuses();
    let interrupts = without(&session.state.interrupts, review);
    session.apply(PoolUpdate {
        tickets: Some(tickets),
        interrupts: Some(interrupts),
        log: Some(vec![line]),
        ..PoolUpdate::default()
    });
    // The outcomes channel is a keyed merge, so removals go around the reducer.
    session.state.outcomes.retain(|id, _| !reset.contains(id));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_brief_heading_is_brief_or_the_engines_but_never_briefing() {
        assert!(is_brief_heading("## Brief"));
        assert!(is_brief_heading("## Brief, written by the engine"));
        assert!(is_brief_heading("## Brief: next"));
        assert!(!is_brief_heading("## Briefing"));
        assert!(!is_brief_heading("### Brief"));
    }

    #[test]
    fn extracts_the_first_brief_up_to_the_next_heading() {
        let text = "# 01: t\n\nspec\n\n## Brief\n\n do this \n\n## Resume note\n\nlater\n";
        assert_eq!(extract_brief_text(text), "do this");
        assert_eq!(
            extract_brief_text("# 01\n"),
            "(no Brief section in the Issue file)"
        );
    }

    #[test]
    fn a_landed_brief_replaces_every_earlier_one_with_its_separator() {
        let original = "<!-- state: id=01 -->\n\n# 01: t\n\nspec\n";
        let once = landed_brief_text(original, Some("  first  "));
        assert_eq!(
            once,
            "<!-- state: id=01 -->\n\n# 01: t\n\nspec\n\n---\n\n## Brief\n\nfirst\n"
        );
        let twice = landed_brief_text(&once, None);
        assert_eq!(
            twice,
            format!(
                "<!-- state: id=01 -->\n\n# 01: t\n\nspec\n\n---\n\n{ENGINE_BRIEF_HEADING}\n\n{ENGINE_CHECKPOINT_PLACEHOLDER}\n"
            )
        );
        let noted = format!("{once}\n## Resume note\n\nkeep me\n");
        assert_eq!(
            landed_brief_text(&noted, Some("second")),
            "<!-- state: id=01 -->\n\n# 01: t\n\nspec\n\n## Resume note\n\nkeep me\n\n---\n\n## Brief\n\nsecond\n"
        );
    }

    #[test]
    fn a_ticket_is_named_only_between_non_id_characters() {
        assert!(names_ticket("redo 03 and 05", "03"));
        assert!(names_ticket("03", "03"));
        assert!(!names_ticket("redo 033", "03"));
        assert!(!names_ticket("redo a-03", "03"));
        assert!(names_ticket("redo (a.b)", "a.b"));
    }
}
