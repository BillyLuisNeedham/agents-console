//! The Spawn ledger (engine/spawn-ledger.ts; issue #150, CONTEXT.md: Spawn ledger): one file in the
//! pool, `runs/spawn-ledger.md`, listing the work the pool has and the work on its way: every Ticket
//! and Conversation, every Pending spawn and every Held spawn. Agents are taught its path and read it
//! before they propose a Spawn, so a second agent does not propose what the first already did, and a
//! proposal that still overlaps something there says so (`overlaps`) and is held for the operator.
//!
//! The engine rewrites it whole, through a rename, whenever what it lists changes; it is derived, never
//! read back. Agents read it, so it is pinned byte for byte.

use std::path::{Path, PathBuf};

use ac_protocol::{HeldSpawnReason, SpawnKind, SpawnProposal};

use crate::js;
use crate::spawn_proposals::{HeldSpawn, PendingSpawn};

/// `runs/spawn-ledger.md`.
pub fn spawn_ledger_path(runs_dir: &Path) -> PathBuf {
    runs_dir.join("spawn-ledger.md")
}

/// One Ticket or Conversation row of the ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerEntry {
    pub id: String,
    pub title: String,
    pub status: String,
}

/// What the ledger lists.
#[derive(Debug, Clone, Copy)]
pub struct SpawnLedgerInput<'a> {
    pub tickets: &'a [LedgerEntry],
    pub conversations: &'a [LedgerEntry],
    pub pending: &'a [PendingSpawn],
    pub held: &'a [HeldSpawn],
}

// How much of a proposal's body the ledger shows: enough to tell two proposals apart, not the whole
// brief.
const SUMMARY_CHARS: usize = 160;

/// A table cell: one line, and no pipe to split the row.
fn cell(text: &str) -> String {
    js::trim(&js::collapse_whitespace(text)).replace('|', "\\|")
}

fn summary(body: &str) -> String {
    let flat = js::trim(&js::collapse_whitespace(body)).to_owned();
    if js::utf16_len(&flat) > SUMMARY_CHARS {
        cell(&format!(
            "{}…",
            js::utf16_prefix_lossy(&flat, SUMMARY_CHARS - 1)
        ))
    } else {
        cell(&flat)
    }
}

/// Why a Held spawn waits, in the words the Console uses.
pub fn held_reason_text(
    reason: HeldSpawnReason,
    overlaps: &[String],
    unknown: &[String],
    refusal: Option<&str>,
) -> String {
    match reason {
        HeldSpawnReason::PerAttempt => "per-attempt cap".to_owned(),
        HeldSpawnReason::PerRun => "per-run cap".to_owned(),
        HeldSpawnReason::Overlaps => {
            let mut text = format!("overlaps {}", overlaps.join(", "));
            if !unknown.is_empty() {
                text.push_str(&format!(" ({} not in the pool)", unknown.join(", ")));
            }
            text
        }
        HeldSpawnReason::Operator => "held by operator".to_owned(),
        HeldSpawnReason::Refused => match refusal {
            Some(refusal) if !refusal.is_empty() => format!("refused at landing: {refusal}"),
            _ => "refused at landing".to_owned(),
        },
    }
}

/// A Spawn's file heads its title with its id ("07-spawn-1: Fix"); the ledger's id column already
/// says that.
fn ticket_title<'a>(id: &str, title: &'a str) -> &'a str {
    title
        .strip_prefix(id)
        .and_then(|rest| rest.strip_prefix(": "))
        .unwrap_or(title)
}

fn table(header: &[&str], rows: Vec<Vec<String>>) -> Vec<String> {
    if rows.is_empty() {
        return vec!["_(none)_".to_owned()];
    }
    let mut lines = vec![
        format!("| {} |", header.join(" | ")),
        format!("| {} |", vec!["---"; header.len()].join(" | ")),
    ];
    lines.extend(
        rows.into_iter()
            .map(|row| format!("| {} |", row.join(" | "))),
    );
    lines
}

fn kind(proposal: &SpawnProposal) -> &'static str {
    proposal.kind.unwrap_or(SpawnKind::Ticket).as_str()
}

/// The ledger's whole text.
pub fn render_spawn_ledger(input: SpawnLedgerInput<'_>) -> String {
    let mut lines: Vec<String> = vec![
        "# Spawn ledger".into(),
        String::new(),
        "The work this pool has and the work on its way, rewritten by the engine whenever it changes. \
         Read it before you propose a Spawn. Do not propose work listed here again. If a proposal still \
         overlaps something listed, name those ids in its \"overlaps\" and the operator decides whether \
         it lands. Never edit this file."
            .into(),
        String::new(),
        "## Tickets".into(),
        String::new(),
    ];
    lines.extend(table(
        &["id", "status", "title"],
        input
            .tickets
            .iter()
            .map(|t| {
                vec![
                    cell(&t.id),
                    t.status.clone(),
                    cell(ticket_title(&t.id, &t.title)),
                ]
            })
            .collect(),
    ));
    lines.extend(["".into(), "## Conversations".into(), "".into()]);
    lines.extend(table(
        &["id", "status", "title"],
        input
            .conversations
            .iter()
            .map(|c| vec![cell(&c.id), c.status.clone(), cell(&c.title)])
            .collect(),
    ));
    lines.extend([
        "".into(),
        "## Pending spawns".into(),
        "".into(),
        "Proposals that land at the next super-step boundary.".into(),
        "".into(),
    ]);
    lines.extend(table(
        &["id", "parent", "kind", "title", "summary"],
        input
            .pending
            .iter()
            .map(|p| {
                vec![
                    p.id.clone(),
                    cell(&p.parent_id),
                    kind(&p.proposal).into(),
                    cell(&p.proposal.title),
                    summary(&p.proposal.body),
                ]
            })
            .collect(),
    ));
    lines.extend([
        "".into(),
        "## Held spawns".into(),
        "".into(),
        "Proposals waiting for the operator to adopt or discard them.".into(),
        "".into(),
    ]);
    lines.extend(table(
        &["id", "parent", "kind", "reason", "title", "summary"],
        input
            .held
            .iter()
            .map(|h| {
                vec![
                    h.id.clone(),
                    cell(&h.parent_id),
                    kind(&h.proposal).into(),
                    cell(&held_reason_text(
                        h.reason,
                        h.proposal.overlaps.as_deref().unwrap_or_default(),
                        h.unknown_overlaps.as_deref().unwrap_or_default(),
                        h.adopt_error.as_deref(),
                    )),
                    cell(&h.proposal.title),
                    summary(&h.proposal.body),
                ]
            })
            .collect(),
    ));
    lines.push(String::new());
    lines.join("\n")
}

/// Replace the ledger whole, through a rename, so a reader never sees half.
pub fn write_spawn_ledger(runs_dir: &Path, text: &str) -> Result<(), js::FsError> {
    js::mkdir_all(runs_dir)?;
    let path = spawn_ledger_path(runs_dir);
    let mut tmp = path.clone().into_os_string();
    tmp.push(format!(".tmp-{}", std::process::id()));
    js::write_through_rename(&path, Path::new(&tmp), text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn proposal(title: &str, body: &str) -> SpawnProposal {
        SpawnProposal {
            title: title.into(),
            body: body.into(),
            blocked_by: None,
            kind: None,
            assign: None,
            verify_ignored: None,
            blocks: None,
            overlaps: None,
        }
    }

    fn entry(id: &str, title: &str, status: &str) -> LedgerEntry {
        LedgerEntry {
            id: id.into(),
            title: title.into(),
            status: status.into(),
        }
    }

    fn pending(id: &str, parent: &str, title: &str, body: &str) -> PendingSpawn {
        PendingSpawn {
            id: id.into(),
            parent_id: parent.into(),
            origin: SpawnKind::Ticket,
            proposal: proposal(title, body),
            at: "t".into(),
            landing: None,
        }
    }

    fn held(id: &str, reason: HeldSpawnReason, title: &str) -> HeldSpawn {
        HeldSpawn {
            id: id.into(),
            parent_id: "07".into(),
            origin: SpawnKind::Ticket,
            proposal: proposal(title, &format!("The body of {title}, long enough to land.")),
            reason,
            at: "2026-01-01T00:00:00.000Z".into(),
            adopt_error: None,
            unknown_overlaps: None,
        }
    }

    const EMPTY: SpawnLedgerInput<'static> = SpawnLedgerInput {
        tickets: &[],
        conversations: &[],
        pending: &[],
        held: &[],
    };

    // spawn-ledger.test.ts:9, and the Seeded Pool's ledger byte for byte.
    #[test]
    fn lists_every_section_saying_none_rather_than_leaving_one_out() {
        assert_eq!(
            render_spawn_ledger(EMPTY),
            "# Spawn ledger\n\n\
             The work this pool has and the work on its way, rewritten by the engine whenever it changes. \
             Read it before you propose a Spawn. Do not propose work listed here again. If a proposal still \
             overlaps something listed, name those ids in its \"overlaps\" and the operator decides whether \
             it lands. Never edit this file.\n\n\
             ## Tickets\n\n_(none)_\n\n\
             ## Conversations\n\n_(none)_\n\n\
             ## Pending spawns\n\nProposals that land at the next super-step boundary.\n\n_(none)_\n\n\
             ## Held spawns\n\nProposals waiting for the operator to adopt or discard them.\n\n_(none)_\n"
        );
    }

    // spawn-ledger.test.ts:18
    #[test]
    fn names_each_piece_of_work_by_the_id_an_overlaps_mark_would_use() {
        let mut talk = HeldSpawn {
            parent_id: "conv-1".into(),
            origin: SpawnKind::Conversation,
            ..held("proposal-4", HeldSpawnReason::Overlaps, "Talk it over")
        };
        talk.proposal = proposal("Talk it over", "A body long enough to stand.");
        talk.proposal.kind = Some(SpawnKind::Conversation);
        talk.proposal.overlaps = Some(vec!["07".into(), "proposal-3".into()]);
        let text = render_spawn_ledger(SpawnLedgerInput {
            tickets: &[
                entry("07", "Build the parser", "in-progress"),
                entry("07-spawn-1", "07-spawn-1: Fix the lexer", "ready"),
            ],
            conversations: &[entry("conv-1", "Plan | the release", "waiting")],
            pending: &[pending(
                "proposal-3",
                "07",
                "Docs",
                "A body long enough to stand.",
            )],
            held: &[talk],
        });
        assert!(text.contains(
            "| id | status | title |\n| --- | --- | --- |\n| 07 | in-progress | Build the parser |"
        ));
        assert!(text.contains("| 07-spawn-1 | ready | Fix the lexer |"));
        assert!(text.contains("| conv-1 | waiting | Plan \\| the release |"));
        assert!(
            text.contains("| proposal-3 | 07 | ticket | Docs | A body long enough to stand. |")
        );
        assert!(text.contains(
            "| proposal-4 | conv-1 | conversation | overlaps 07, proposal-3 | Talk it over | A body long enough to stand. |"
        ));
    }

    // spawn-ledger.test.ts:48, and the conformance cases for a pending and a held summary.
    #[test]
    fn keeps_a_proposals_summary_to_one_short_line() {
        let long = format!("First line\nsecond line\n{}", "x".repeat(300));
        let rows = [pending("proposal-1", "08", "Long one", &long)];
        let text = render_spawn_ledger(SpawnLedgerInput {
            pending: &rows,
            ..EMPTY
        });
        let row = text
            .lines()
            .find(|l| l.starts_with("| proposal-1 "))
            .unwrap();
        assert!(row.ends_with(&format!("| First line second line {}… |", "x".repeat(136))));
        assert!(js::utf16_len(row) < 220);
        // A cut that would split a character beyond U+FFFF leaves U+FFFD, as Bun writes it.
        let emoji = format!("{}{}", "a".repeat(158), "😀".repeat(5));
        let rows = [pending("proposal-1", "08", "E", &emoji)];
        let text = render_spawn_ledger(SpawnLedgerInput {
            pending: &rows,
            ..EMPTY
        });
        assert!(text.contains(&format!("| {}\u{fffd}… |", "a".repeat(158))));
    }

    // spawn-ledger.test.ts:62
    #[test]
    fn words_each_hold_reason_the_way_the_console_does() {
        let ids = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            held_reason_text(HeldSpawnReason::PerAttempt, &[], &[], None),
            "per-attempt cap"
        );
        assert_eq!(
            held_reason_text(HeldSpawnReason::PerRun, &[], &[], None),
            "per-run cap"
        );
        assert_eq!(
            held_reason_text(HeldSpawnReason::Overlaps, &ids(&["02"]), &[], None),
            "overlaps 02"
        );
        assert_eq!(
            held_reason_text(HeldSpawnReason::Operator, &[], &[], None),
            "held by operator"
        );
        assert_eq!(
            held_reason_text(
                HeldSpawnReason::Overlaps,
                &ids(&["02", "99"]),
                &ids(&["99"]),
                None
            ),
            "overlaps 02, 99 (99 not in the pool)"
        );
        assert_eq!(
            held_reason_text(
                HeldSpawnReason::Refused,
                &[],
                &[],
                Some("blocks names done tickets: 02")
            ),
            "refused at landing: blocks names done tickets: 02"
        );
        assert_eq!(
            held_reason_text(HeldSpawnReason::Refused, &[], &[], Some("")),
            "refused at landing"
        );
    }

    // The conformance case that words every hold reason, row for row.
    #[test]
    fn renders_every_held_reason_in_its_row() {
        let mut overlapping = held("proposal-4", HeldSpawnReason::Overlaps, "Overlapping");
        overlapping.proposal.overlaps = Some(vec!["07".into(), "proposal-3".into()]);
        let mut stale = held("proposal-6", HeldSpawnReason::Overlaps, "Stale mark");
        stale.proposal.overlaps = Some(vec!["07".into(), "99".into()]);
        stale.unknown_overlaps = Some(vec!["99".into()]);
        let mut refused = held("proposal-8", HeldSpawnReason::Refused, "Refused");
        refused.adopt_error = Some("blocked-by names 42, which is not in the pool".into());
        let rows = [
            held("proposal-3", HeldSpawnReason::PerAttempt, "Cap one"),
            overlapping,
            stale,
            held("proposal-7", HeldSpawnReason::Operator, "Held back"),
            refused,
        ];
        let text = render_spawn_ledger(SpawnLedgerInput {
            held: &rows,
            ..EMPTY
        });
        let body = |title: &str| format!("The body of {title}, long enough to land.");
        for (id, reason, title) in [
            ("proposal-3", "per-attempt cap", "Cap one"),
            ("proposal-4", "overlaps 07, proposal-3", "Overlapping"),
            (
                "proposal-6",
                "overlaps 07, 99 (99 not in the pool)",
                "Stale mark",
            ),
            ("proposal-7", "held by operator", "Held back"),
            (
                "proposal-8",
                "refused at landing: blocked-by names 42, which is not in the pool",
                "Refused",
            ),
        ] {
            let row = format!(
                "| {id} | 07 | ticket | {reason} | {title} | {} |",
                body(title)
            );
            assert!(text.contains(&row), "{row}");
        }
    }

    #[test]
    fn writes_the_ledger_through_a_rename() {
        let dir = tempfile::Builder::new()
            .prefix("spawn-ledger-")
            .tempdir()
            .unwrap();
        let runs = dir.path().join("runs");
        write_spawn_ledger(&runs, "# Spawn ledger\n").unwrap();
        assert_eq!(
            fs::read_to_string(spawn_ledger_path(&runs)).unwrap(),
            "# Spawn ledger\n"
        );
        let names: Vec<_> = fs::read_dir(&runs)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["spawn-ledger.md"]);
    }
}
