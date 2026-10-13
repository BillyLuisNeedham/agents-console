//! Notices (the Conversations ADR, docs/adr/0018-conversations-beside-tickets.md; CONTEXT.md: Notice):
//! the Turn the engine types into a parent Conversation when something it spawned ends. This module is
//! the Notice itself and the text it carries; the queue, delivery and dropping live with the
//! Conversation that owns them (ac-engine's `conversations`).

use crate::js;

/// What a Notice reports. `ticket-ended` and `conversation-ended` are the two things a spawned child
/// reports back. `enlist-teaching` and `opening-turn` are the Turns an enlisted Conversation starts with
/// (issue #101): the operator's opening Turn and the Spawn teaching travel the same queue-then-deliver
/// path as a Notice, so both land only while the pane is waiting. `steward-interrupt` and
/// `steward-merge-stall` are what a Steward is told about (ADR-0030): a pending Ticket Interrupt, and a
/// stalled Merge queue head; `steward-merged` and `steward-pool` only inform it: a Ticket that merged,
/// and the pool reaching Review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NoticeKind {
    TicketEnded,
    ConversationEnded,
    EnlistTeaching,
    OpeningTurn,
    StewardInterrupt,
    StewardMergeStall,
    StewardMerged,
    StewardPool,
}

impl NoticeKind {
    /// The kind as the `notice` event and the dropped-Notice event name it.
    pub fn as_str(self) -> &'static str {
        match self {
            NoticeKind::TicketEnded => "ticket-ended",
            NoticeKind::ConversationEnded => "conversation-ended",
            NoticeKind::EnlistTeaching => "enlist-teaching",
            NoticeKind::OpeningTurn => "opening-turn",
            NoticeKind::StewardInterrupt => "steward-interrupt",
            NoticeKind::StewardMergeStall => "steward-merge-stall",
            NoticeKind::StewardMerged => "steward-merged",
            NoticeKind::StewardPool => "steward-pool",
        }
    }
}

/// One Notice: who it is for, who it is about, what kind, and the text typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub to: String,
    pub from: String,
    pub kind: NoticeKind,
    pub text: String,
    /// A Steward Notice's item key: delivery checks the item is still pending, and types its current
    /// text.
    pub key: Option<String>,
}

/// What a Ticket's ending says of its outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketOutcome {
    Done,
    Checkpoint,
}

/// The Notice a spawned Ticket's merge or checkpoint sends its parent.
pub struct TicketEnded<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub outcome: TicketOutcome,
    pub brief: Option<&'a str>,
    pub branch: &'a str,
    pub diff_stat: &'a str,
}

/// The text of a spawned Ticket's ending.
pub fn ticket_ended_notice_text(params: &TicketEnded<'_>) -> String {
    let outcome = match params.outcome {
        TicketOutcome::Done => "done",
        TicketOutcome::Checkpoint => "checkpoint",
    };
    let mut lines = vec![format!(
        "Ticket {} (\"{}\") ended: {outcome}.",
        params.id, params.title
    )];
    if params.outcome == TicketOutcome::Checkpoint {
        let brief = js::trim(params.brief.unwrap_or(""));
        lines.push(format!(
            "Brief: {}",
            if brief.is_empty() {
                "(none written)"
            } else {
                brief
            }
        ));
    }
    lines.push(format!("Branch: {}", params.branch));
    lines.push(format!("Diff:\n{}", params.diff_stat));
    lines.join("\n")
}

/// A spawned Ticket closed at an Interrupt (issue #154): it ended without merging, so there is no branch
/// or diff to report, only that it was dropped and the note it was dropped with.
pub fn ticket_closed_notice_text(id: &str, title: &str, note: Option<&str>) -> String {
    let mut lines = vec![format!(
        "Ticket {id} (\"{title}\") was closed: its work was not merged."
    )];
    if let Some(note) = note.map(js::trim).filter(|note| !note.is_empty()) {
        lines.push(format!("Close note: {note}"));
    }
    lines.join("\n")
}

/// The text a Conversation's parent hears when it ends.
pub fn conversation_ended_notice_text(branch: &str, closing: Option<&str>) -> String {
    let mut lines = vec![
        "A Conversation you spawned was ended by the operator.".to_owned(),
        format!("Branch: {branch}"),
    ];
    if let Some(closing) = closing.map(js::trim).filter(|closing| !closing.is_empty()) {
        lines.push(format!("Closing note: {closing}"));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    // notices.test.ts
    #[test]
    fn a_done_ticket_names_its_branch_and_diff() {
        let text = ticket_ended_notice_text(&TicketEnded {
            id: "01",
            title: "Fix it",
            outcome: TicketOutcome::Done,
            brief: None,
            branch: "pool/k/01",
            diff_stat: " a | 1 +",
        });
        assert_eq!(
            text,
            "Ticket 01 (\"Fix it\") ended: done.\nBranch: pool/k/01\nDiff:\n a | 1 +"
        );
    }

    #[test]
    fn a_checkpoint_carries_its_brief_or_says_none_was_written() {
        let with = |brief| {
            ticket_ended_notice_text(&TicketEnded {
                id: "01",
                title: "T",
                outcome: TicketOutcome::Checkpoint,
                brief,
                branch: "b",
                diff_stat: "(no changes)",
            })
        };
        assert!(with(Some("  look here  ")).contains("\nBrief: look here\n"));
        assert!(with(Some("   ")).contains("\nBrief: (none written)\n"));
        assert!(with(None).contains("\nBrief: (none written)\n"));
    }

    #[test]
    fn a_closed_ticket_carries_its_trimmed_note_only_when_there_is_one() {
        assert_eq!(
            ticket_closed_notice_text("01", "T", None),
            "Ticket 01 (\"T\") was closed: its work was not merged."
        );
        assert_eq!(
            ticket_closed_notice_text("01", "T", Some("  \n ")),
            "Ticket 01 (\"T\") was closed: its work was not merged."
        );
        assert_eq!(
            ticket_closed_notice_text("01", "T", Some(" wrong plan ")),
            "Ticket 01 (\"T\") was closed: its work was not merged.\nClose note: wrong plan"
        );
    }

    #[test]
    fn an_ended_conversation_names_its_branch_and_closing_note() {
        assert_eq!(
            conversation_ended_notice_text("b", None),
            "A Conversation you spawned was ended by the operator.\nBranch: b"
        );
        assert_eq!(
            conversation_ended_notice_text("b", Some(" bye ")),
            "A Conversation you spawned was ended by the operator.\nBranch: b\nClosing note: bye"
        );
    }
}
