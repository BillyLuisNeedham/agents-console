//! The dialog watch: every 2 s it reads the viewport of each live claude Ticket agent's pane and raises
//! a dialog Interrupt while a Blocking dialog holds one mid-run, since the engine never answers a dialog
//! after the Launch and the agent otherwise stops with nothing in Needs input. It clears the Interrupt
//! when the dialog leaves the pane or the attempt ends. It reads the Live attempts registry, so a
//! boot-adopted attempt is watched like a launched one. Only a terminal-backed pool runs it.

use std::time::Duration;

use futures::future::join_all;
use indexmap::IndexSet;

use ac_io::herdr::{Herdr, PaneReadSource};
use ac_protocol::{AttemptRole, Interrupt, InterruptKind};

use crate::interrupts::{clear_interrupt, interrupt, raise_interrupt};
use crate::pane_session::dialog_holding_pane;
use crate::session::Session;
use crate::snapshot::emit_snapshot;

/// How often the watch reads the panes: the Conversation poll's cadence.
pub const DIALOG_WATCH_MS: u64 = 2_000;

/// One live claude Ticket agent's pane, as the watch reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchedPane {
    pub ticket_id: String,
    pub attempt: u64,
    pub pane_id: String,
}

/// What the watch does to one Ticket's dialog Interrupt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogChange {
    Raise { ticket_id: String, body: String },
    Clear { ticket_id: String, why: ClearWhy },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClearWhy {
    LeftThePane,
    AttemptEnded,
}

/// Start the watch on its cadence; [`stop_dialog_watch`] ends it.
pub fn start_dialog_watch(session: &mut Session) {
    let engine = session.engine();
    let herdr = Herdr::new(&session.herdr_socket);
    let every = Duration::from_millis(DIALOG_WATCH_MS);
    session.dialog_watch = Some(tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let Ok(watched) = engine.call(|s| watched_panes(s)).await else {
                return;
            };
            let reads = join_all(watched.into_iter().map(|pane| {
                let herdr = herdr.clone();
                async move {
                    let read = herdr
                        .peek_pane(&pane.pane_id, PaneReadSource::Visible)
                        .await;
                    (pane, read.ok())
                }
            }))
            .await;
            if engine.call(move |s| apply_reads(s, &reads)).await.is_err() {
                return;
            }
        }
    }));
}

/// Stop the watch for good; the engine is shutting down.
pub fn stop_dialog_watch(session: &mut Session) {
    if let Some(watch) = session.dialog_watch.take() {
        watch.abort();
    }
}

/// Clear the Ticket's dialog Interrupt as its attempt ends, so the crash or checkpoint raised next is
/// the Ticket's first Interrupt, the one an answer takes.
pub fn clear_at_ending(session: &mut Session, ticket_id: &str) {
    apply_change(
        session,
        DialogChange::Clear {
            ticket_id: ticket_id.to_owned(),
            why: ClearWhy::AttemptEnded,
        },
    );
}

fn watched_panes(s: &Session) -> Vec<WatchedPane> {
    s.live_attempts
        .entries()
        .filter(|(id, entry)| {
            entry.role == AttemptRole::Agent
                && s.marker(id).is_some()
                && s.assignments
                    .get(*id)
                    .is_some_and(|a| a.harness == "claude")
        })
        .filter_map(|(id, entry)| {
            Some(WatchedPane {
                ticket_id: id.to_owned(),
                attempt: entry.attempt,
                pane_id: entry.pane_id.clone()?,
            })
        })
        .collect()
}

fn apply_reads(s: &mut Session, reads: &[(WatchedPane, Option<String>)]) {
    let changes = dialog_changes(&watched_panes(s), reads, &s.state.interrupts);
    if changes.is_empty() {
        return;
    }
    for change in changes {
        apply_change(s, change);
    }
    emit_snapshot(s, s.current_phase());
}

fn apply_change(s: &mut Session, change: DialogChange) {
    match change {
        DialogChange::Raise { ticket_id, body } => {
            raise_interrupt(s, interrupt(&ticket_id, InterruptKind::Dialog, body));
        }
        DialogChange::Clear { ticket_id, why } => {
            let Some(pending) = dialog_interrupt(&s.state.interrupts, &ticket_id).cloned() else {
                return;
            };
            let because = match why {
                ClearWhy::LeftThePane => "the dialog left its pane",
                ClearWhy::AttemptEnded => "its attempt ended",
            };
            clear_interrupt(
                s,
                &pending,
                format!("interrupt cleared for {ticket_id} (dialog): {because}"),
            );
        }
    }
}

fn dialog_interrupt<'a>(interrupts: &'a [Interrupt], ticket_id: &str) -> Option<&'a Interrupt> {
    interrupts
        .iter()
        .find(|i| i.ticket_id == ticket_id && i.kind == InterruptKind::Dialog)
}

/// The changes one round of reads makes. `watched` is the set as it stands now, so a read of an
/// attempt that ended while it was in flight counts for nothing; `None` is a read that failed, which
/// changes nothing. A Ticket's dialog Interrupt is raised when any of its panes shows a dialog only the
/// operator may answer (the trust dialog is the Launch's to answer), cleared when every one of its
/// panes read clean, and cleared when it has no watched pane left.
pub fn dialog_changes(
    watched: &[WatchedPane],
    reads: &[(WatchedPane, Option<String>)],
    interrupts: &[Interrupt],
) -> Vec<DialogChange> {
    let mut changes: Vec<DialogChange> = interrupts
        .iter()
        .filter(|i| i.kind == InterruptKind::Dialog)
        .filter(|i| !watched.iter().any(|pane| pane.ticket_id == i.ticket_id))
        .map(|i| DialogChange::Clear {
            ticket_id: i.ticket_id.clone(),
            why: ClearWhy::AttemptEnded,
        })
        .collect();
    let current: Vec<&(WatchedPane, Option<String>)> = reads
        .iter()
        .filter(|(pane, _)| watched.contains(pane))
        .collect();
    let tickets: IndexSet<&str> = current
        .iter()
        .map(|(pane, _)| pane.ticket_id.as_str())
        .collect();
    for ticket_id in tickets {
        let of_ticket = || {
            current
                .iter()
                .filter(|(pane, _)| pane.ticket_id == ticket_id)
        };
        let held = of_ticket().find_map(|(pane, text)| {
            let dialog = dialog_holding_pane(text.as_deref()?)?;
            dialog.accept.is_none().then_some((pane, dialog))
        });
        let raised = dialog_interrupt(interrupts, ticket_id).is_some();
        if let Some((pane, dialog)) = held {
            if !raised {
                changes.push(DialogChange::Raise {
                    ticket_id: ticket_id.to_owned(),
                    body: format!(
                        "claude's {} is up in this Ticket's pane {} (attempt {}): \"{}\". It holds the \
                         agent until it is answered, and the engine never answers it, so answer it in \
                         the pane. This Interrupt clears once the dialog leaves the pane; dismissing it \
                         here leaves the dialog up.",
                        dialog.name, pane.pane_id, pane.attempt, dialog.heading
                    ),
                });
            }
        } else if raised && of_ticket().all(|(_, text)| text.is_some()) {
            changes.push(DialogChange::Clear {
                ticket_id: ticket_id.to_owned(),
                why: ClearWhy::LeftThePane,
            });
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUTO_MODE: &str = " Teach auto mode about your environment?\n\n Auto mode works better when it \
                             knows your environment. Takes about a minute.\n\n ❯ 1. Yes\n   2. Not now\n   \
                             3. Don't show again\n\n Enter to confirm · Esc to cancel\n";
    const READY: &str = "Claude Code v2.1.276\n❯ ";
    const TRUST: &str = "Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  \
                         Yes, I trust this folder\nEnter to confirm · Esc to cancel";

    fn pane(ticket_id: &str, attempt: u64) -> WatchedPane {
        WatchedPane {
            ticket_id: ticket_id.into(),
            attempt,
            pane_id: format!("p-{ticket_id}-{attempt}"),
        }
    }

    fn read(pane: &WatchedPane, text: Option<&str>) -> (WatchedPane, Option<String>) {
        (pane.clone(), text.map(str::to_owned))
    }

    fn dialog(ticket_id: &str) -> Interrupt {
        interrupt(ticket_id, InterruptKind::Dialog, "up")
    }

    fn kinds(changes: &[DialogChange]) -> Vec<(&str, &str)> {
        changes
            .iter()
            .map(|change| match change {
                DialogChange::Raise { ticket_id, .. } => (ticket_id.as_str(), "raise"),
                DialogChange::Clear {
                    ticket_id,
                    why: ClearWhy::LeftThePane,
                } => (ticket_id.as_str(), "left"),
                DialogChange::Clear {
                    ticket_id,
                    why: ClearWhy::AttemptEnded,
                } => (ticket_id.as_str(), "ended"),
            })
            .collect()
    }

    #[test]
    fn raises_once_naming_the_dialog_and_its_heading() {
        let watched = [pane("01", 1)];
        let p = &watched[0];
        let changes = dialog_changes(&watched, &[read(p, Some(AUTO_MODE))], &[]);
        let [DialogChange::Raise { ticket_id, body }] = changes.as_slice() else {
            panic!("{changes:?}");
        };
        assert_eq!(ticket_id, "01");
        assert!(body.contains("auto-mode setup dialog"), "{body}");
        assert!(
            body.contains("\"Teach auto mode about your environment?\""),
            "{body}"
        );
        assert!(body.contains("p-01-1"), "{body}");
        assert!(dialog_changes(&watched, &[read(p, Some(AUTO_MODE))], &[dialog("01")]).is_empty());
    }

    #[test]
    fn clears_when_the_pane_reads_clean_and_a_failed_read_changes_nothing() {
        let watched = [pane("01", 1)];
        let p = &watched[0];
        assert_eq!(
            kinds(&dialog_changes(
                &watched,
                &[read(p, Some(READY))],
                &[dialog("01")]
            )),
            [("01", "left")]
        );
        assert!(dialog_changes(&watched, &[read(p, None)], &[dialog("01")]).is_empty());
        assert!(dialog_changes(&watched, &[read(p, None)], &[]).is_empty());
    }

    #[test]
    fn clears_a_ticket_with_no_watched_pane_and_ignores_a_read_of_an_ended_attempt() {
        let ended = pane("01", 1);
        assert_eq!(
            kinds(&dialog_changes(
                &[],
                &[read(&ended, Some(AUTO_MODE))],
                &[dialog("01")]
            )),
            [("01", "ended")]
        );
        assert!(dialog_changes(&[], &[read(&ended, Some(AUTO_MODE))], &[]).is_empty());
        // Attempt 2 went live in the same pane slot after attempt 1's read was taken.
        let next = pane("01", 2);
        assert!(dialog_changes(&[next], &[read(&ended, Some(AUTO_MODE))], &[]).is_empty());
    }

    #[test]
    fn leaves_the_trust_dialog_to_the_launch() {
        let watched = [pane("01", 1)];
        let p = &watched[0];
        assert!(dialog_changes(&watched, &[read(p, Some(TRUST))], &[]).is_empty());
    }

    #[test]
    fn a_fan_out_holds_while_any_pane_shows_the_dialog_and_clears_only_when_all_read_clean() {
        let (a, b) = (pane("01", 1), pane("01", 2));
        let watched = [a.clone(), b.clone()];
        assert_eq!(
            kinds(&dialog_changes(
                &watched,
                &[read(&a, Some(READY)), read(&b, Some(AUTO_MODE))],
                &[]
            )),
            [("01", "raise")]
        );
        assert!(
            dialog_changes(
                &watched,
                &[read(&a, Some(READY)), read(&b, None)],
                &[dialog("01")]
            )
            .is_empty()
        );
        assert_eq!(
            kinds(&dialog_changes(
                &watched,
                &[read(&a, Some(READY)), read(&b, Some(READY))],
                &[dialog("01")]
            )),
            [("01", "left")]
        );
    }

    #[test]
    fn leaves_other_kinds_alone() {
        let watched = [pane("01", 1)];
        let p = &watched[0];
        let crash = interrupt("02", InterruptKind::Crash, "c");
        assert!(dialog_changes(&watched, &[read(p, Some(READY))], &[crash]).is_empty());
    }
}
