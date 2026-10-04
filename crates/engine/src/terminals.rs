//! Closing tabs and the Finished terminals (issue #139; engine.ts 5189-5316, finished-terminals.ts).
//!
//! Finished terminals are herdr tabs this pool opened that are still open over an Attempt or a
//! Conversation that has ended. The engine closes a tab only when its role ends by rule (a merge, a
//! grade landing, a selection's losers; ADR-0014's amendment), so a crashed attempt's tab, a
//! checkpointed one answered some other way, a tab whose ticket was reset by hand and a done ticket's
//! tab awaiting its merge all stay open. The operator closes them in one go from the pool header; the
//! engine never closes one on its own.
//!
//! The set is derived, never recorded: the tabs every `spawned` event names, less the ones herdr no
//! longer lists, less every tab whose pane is still in use or is anyone's enlisted pane, less every tab
//! herdr now lists differently from how the engine recorded it.

use std::collections::HashSet;
use std::path::Path;

use indexmap::IndexMap;
use serde_json::Value;

use ac_core::events::{last_attempt, read_events};
use ac_core::pool::TicketMarker;
use ac_io::herdr::Herdr;
use ac_protocol::TicketEventKind;

use crate::actor::Engine;
use crate::error::EngineError;
use crate::pane_survey::{PaneListing, RecordedPane, listed_as_recorded};
use crate::session::Session;
use crate::tickets::{close_tab_recorded, tab_recorded_closed};

/// A tab the engine recorded opening, as its `spawned` event named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedTab {
    /// The Ticket or Conversation id whose events name it.
    pub owner: String,
    pub tab_id: String,
    /// The pane the attempt ran in: the tab's root pane.
    pub pane_id: Option<String>,
    /// Where the attempt ran, as the event recorded it.
    pub cwd: Option<String>,
    /// herdr's never-reused terminal id, when the spawn recorded one.
    pub terminal_id: Option<String>,
}

/// Every pane and tab an enlisted owner's events name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnlistedTerminals {
    pub panes: HashSet<String>,
    pub tabs: HashSet<String>,
}

/// Panes and tabs a close must never touch: in use, or someone's enlisted.
#[derive(Debug, Clone, Default)]
pub struct Untouchable {
    pub panes: HashSet<String>,
    pub tabs: HashSet<String>,
}

fn string_at(event: &ac_protocol::TicketEvent, key: &str) -> Option<String> {
    event
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// `openedTabs`: every tab the owners' `spawned` events name, once each, less the ones their events
/// record closed (a `tab-closed`). A Continued attempt names the tab of the attempt it continues, so a
/// tab can be named twice; the later spawn's pane is kept.
pub fn opened_tabs(runs_dir: &Path, owners: &[String]) -> Vec<OpenedTab> {
    let mut tabs: IndexMap<String, OpenedTab> = IndexMap::new();
    for owner in owners {
        let events = read_events(runs_dir, owner);
        for event in &events {
            if event.kind != TicketEventKind::Spawned {
                continue;
            }
            let Some(tab_id) = string_at(event, "tab_id") else {
                continue;
            };
            tabs.insert(
                tab_id.clone(),
                OpenedTab {
                    owner: owner.clone(),
                    tab_id,
                    pane_id: string_at(event, "pane_id"),
                    cwd: string_at(event, "cwd"),
                    terminal_id: string_at(event, "terminal_id"),
                },
            );
        }
        // A tab the engine recorded closing is not open, whatever a listing taken before the close
        // still says.
        let closed: Vec<String> = tabs
            .values()
            .filter(|tab| {
                &tab.owner == owner
                    && tab_recorded_closed(&events, &tab.tab_id, tab.terminal_id.as_deref())
            })
            .map(|tab| tab.tab_id.clone())
            .collect();
        for tab_id in closed {
            tabs.shift_remove(&tab_id);
        }
    }
    tabs.into_values().collect()
}

/// `finishedTerminals`: the opened tabs that are Finished terminals: herdr still lists the tab's root
/// pane as the engine recorded it ([`listed_as_recorded`]: the same tab, the Pool workspace, the
/// recorded directory), and neither that pane, the tab, nor any other listed pane in the tab is
/// untouchable. A tab whose root pane was never recorded cannot be checked, so it is never one.
pub fn finished_terminals(
    opened: &[OpenedTab],
    listing: &PaneListing,
    untouchable: &Untouchable,
    workspace_id: Option<&str>,
) -> Vec<OpenedTab> {
    let mut held_tabs = untouchable.tabs.clone();
    for pane in listing.panes.values() {
        if let Some(tab) = &pane.tab_id
            && untouchable.panes.contains(&pane.pane_id)
        {
            held_tabs.insert(tab.clone());
        }
    }
    opened
        .iter()
        .filter(|tab| {
            let Some(pane_id) = &tab.pane_id else {
                return false;
            };
            let recorded = RecordedPane {
                pane_id: pane_id.clone(),
                tab_id: Some(tab.tab_id.clone()),
                cwd: tab.cwd.clone(),
                terminal_id: tab.terminal_id.clone(),
            };
            if !listed_as_recorded(listing, &recorded, workspace_id) {
                return false;
            }
            if untouchable.panes.contains(pane_id) {
                return false;
            }
            !held_tabs.contains(&tab.tab_id)
        })
        .cloned()
        .collect()
}

/// `tabOwners`: whose `spawned` events name tabs the pool opened: every Ticket (graders and the
/// head-to-head judge are Tickets too) and every Conversation, less the enlisted ones, whose tab was
/// the operator's before it was the pool's.
pub fn tab_owners(session: &Session) -> Vec<String> {
    session
        .markers
        .iter()
        .filter(|marker| marker.enlisted_from.is_none())
        .map(|marker| marker.id.clone())
        .chain(
            session
                .conversations
                .views()
                .into_iter()
                .filter(|view| !view.enlisted)
                .map(|view| view.id),
        )
        .collect()
}

/// `enlistedTerminalsOf`: every pane and tab the enlisted Tickets' and Conversations' `spawned` events
/// name, their Continued attempts' included.
pub fn enlisted_terminals_of(session: &Session) -> EnlistedTerminals {
    let owners: Vec<String> = session
        .markers
        .iter()
        .filter(|marker| marker.enlisted_from.is_some())
        .map(|marker| marker.id.clone())
        .chain(
            session
                .conversations
                .views()
                .into_iter()
                .filter(|view| view.enlisted)
                .map(|view| view.id),
        )
        .collect();
    let mut out = EnlistedTerminals::default();
    for owner in owners {
        for event in read_events(Path::new(&session.runs_dir), &owner) {
            if event.kind != TicketEventKind::Spawned {
                continue;
            }
            if let Some(pane) = string_at(&event, "pane_id") {
                out.panes.insert(pane);
            }
            if let Some(tab) = string_at(&event, "tab_id") {
                out.tabs.insert(tab);
            }
        }
    }
    out
}

/// A tab the engine recorded opening, as the idle rule closes it.
#[derive(Debug, Clone)]
struct IdleTab {
    owner: String,
    attempt: u64,
    tab_id: String,
    pane_id: String,
    cwd: Option<String>,
    terminal_id: Option<String>,
}

/// `closeCheckpointedTabs`: plain Resume closes the old pane (issue #139): just before a ticket's
/// fresh Attempt launches, the tab of its checkpointed Attempt closes, so the old TUI, idle on the
/// spent checkpoint, never shares the worktree and the ticket's well-known Outcome and exit-code files
/// with the new attempt. The tab is the one the Attempt named by the ticket's latest `checkpoint`
/// event ran in, and it closes once: the close is recorded as a `tab-closed` event, and a tab already
/// recorded closed is never asked about again. A headless fallback recorded no tab and closes nothing,
/// and a crashed attempt's tab stays, as ADR-0014 has it: when a later attempt ran in the checkpointed
/// tab after the checkpoint, the tab is that attempt's now and stays open.
///
/// It closes only what is certainly the pool's own and idle: never a tab whose pane is untouchable,
/// and never one herdr now lists differently from how it was recorded; a listing that could not be had
/// closes nothing.
pub async fn close_checkpointed_tabs(engine: &Engine, markers: &[TicketMarker]) {
    let markers: Vec<TicketMarker> = {
        let mut seen = HashSet::new();
        markers
            .iter()
            .filter(|marker| seen.insert(marker.id.clone()))
            .cloned()
            .collect()
    };
    let candidates = engine
        .call(move |s| {
            s.pane_survey.as_ref()?;
            let mut candidates = Vec::new();
            for marker in &markers {
                if marker.enlisted_from.is_some() {
                    continue;
                }
                s.held.shift_remove(&marker.id);
                let events = read_events(Path::new(&s.runs_dir), &marker.id);
                let Some(checkpoint_at) = events
                    .iter()
                    .rposition(|event| event.kind == TicketEventKind::Checkpoint)
                else {
                    continue;
                };
                let attempt = events[checkpoint_at].attempt;
                let Some(spawned) = events.iter().rfind(|event| {
                    event.kind == TicketEventKind::Spawned && event.attempt == attempt
                }) else {
                    continue;
                };
                let (Some(tab_id), Some(pane_id)) =
                    (string_at(spawned, "tab_id"), string_at(spawned, "pane_id"))
                else {
                    continue;
                };
                let cwd = string_at(spawned, "cwd");
                let terminal_id = string_at(spawned, "terminal_id");
                if tab_recorded_closed(&events, &tab_id, terminal_id.as_deref()) {
                    continue;
                }
                let reused = events.iter().skip(checkpoint_at + 1).any(|event| {
                    event.kind == TicketEventKind::Spawned
                        && event.payload.get("tab_id").and_then(Value::as_str) == Some(&tab_id)
                });
                if reused {
                    continue;
                }
                candidates.push(IdleTab {
                    owner: marker.id.clone(),
                    attempt,
                    tab_id,
                    pane_id,
                    cwd,
                    terminal_id,
                });
            }
            Some(candidates)
        })
        .await
        .ok()
        .flatten();
    if let Some(candidates) = candidates {
        close_idle_tabs(engine, candidates, "resume").await;
    }
}

/// `closeIdleTabs`: close the tabs given that are certainly the pool's own and idle, by the rule
/// [`close_checkpointed_tabs`] states: never one over an untouchable pane, never one herdr lists
/// differently from how it was recorded, and nothing at all when no listing could be had.
async fn close_idle_tabs(engine: &Engine, candidates: Vec<IdleTab>, reason: &str) {
    if candidates.is_empty() {
        return;
    }
    let has_survey = engine
        .call(|s| s.pane_survey.is_some())
        .await
        .unwrap_or(false);
    if !has_survey || !engine.refresh_pane_survey().await {
        return;
    }
    let ready = engine
        .call(|s| {
            let listing = s.pane_survey.as_ref()?.latest()?;
            let off = crate::held::untouchable(s);
            Some((
                listing,
                off,
                s.pool_workspace.id.clone(),
                Herdr::new(&s.herdr_socket),
            ))
        })
        .await
        .ok()
        .flatten();
    let Some((listing, off, workspace, herdr)) = ready else {
        return;
    };
    futures::future::join_all(candidates.into_iter().map(|tab| {
        let engine = engine.clone();
        let herdr = herdr.clone();
        let off_limits = off.panes.contains(&tab.pane_id) || off.tabs.contains(&tab.tab_id);
        let recorded = RecordedPane {
            pane_id: tab.pane_id.clone(),
            tab_id: Some(tab.tab_id.clone()),
            cwd: tab.cwd.clone(),
            terminal_id: tab.terminal_id.clone(),
        };
        let listed = listed_as_recorded(&listing, &recorded, workspace.as_deref());
        let reason = reason.to_owned();
        async move {
            if off_limits || !listed {
                return;
            }
            close_tab_recorded(
                &engine,
                &herdr,
                tab.owner,
                tab.attempt,
                tab.tab_id,
                tab.terminal_id,
                reason,
            )
            .await;
        }
    }))
    .await;
}

/// `closeTicketTabs`: a closed ticket's tabs (issue #154): its role has ended as a merge ends it, so
/// every tab it opened goes, the Held pane's included, but by the idle rule rather than
/// `closeAttemptTabs`' unconditional close. One close per terminal, as `closeAttemptTabs` keys them.
pub async fn close_ticket_tabs(engine: &Engine, ticket_id: &str) {
    let id = ticket_id.to_owned();
    let tabs = engine
        .call(move |s| {
            let events = read_events(Path::new(&s.runs_dir), &id);
            let mut tabs: IndexMap<String, IdleTab> = IndexMap::new();
            for spawned in &events {
                if spawned.kind != TicketEventKind::Spawned {
                    continue;
                }
                let (Some(tab_id), Some(pane_id)) =
                    (string_at(spawned, "tab_id"), string_at(spawned, "pane_id"))
                else {
                    continue;
                };
                let terminal = string_at(spawned, "terminal_id");
                if tab_recorded_closed(&events, &tab_id, terminal.as_deref()) {
                    continue;
                }
                let key = match &terminal {
                    Some(terminal) => format!("terminal:{terminal}"),
                    None => format!("tab:{tab_id}"),
                };
                tabs.insert(
                    key,
                    IdleTab {
                        owner: id.clone(),
                        attempt: spawned.attempt,
                        tab_id,
                        pane_id,
                        cwd: string_at(spawned, "cwd"),
                        terminal_id: terminal,
                    },
                );
            }
            tabs.into_values().collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
    close_idle_tabs(engine, tabs, "closed").await;
}

/// `closeFinishedTerminals`: close every Finished terminal (issue #139): the operator's bulk close
/// from the pool header, and the only way one closes. The set is derived afresh, from a listing begun
/// after the request, so a tab that came back into use since the last snapshot, or was enlisted, is
/// never closed from under it; a listing that could not be had closes nothing. Resolves with how many
/// closed.
pub async fn close_finished_terminals(engine: &Engine) -> Result<u64, EngineError> {
    let has_survey = engine.call(|s| s.pane_survey.is_some()).await?;
    if !has_survey {
        return Err(EngineError::refused(
            "close finished terminals: the pool is not terminal-backed",
        ));
    }
    if !engine.refresh_pane_survey().await {
        return Err(EngineError::refused(
            "close finished terminals: the herdr daemon could not list its panes",
        ));
    }
    let (finished, herdr) = engine
        .call(|s| {
            let runs = std::path::PathBuf::from(&s.runs_dir);
            let finished = match s.pane_survey.as_ref().and_then(|survey| survey.latest()) {
                Some(listing) => crate::held::finished_now(s, &listing)
                    .into_iter()
                    .map(|tab| {
                        let attempt = last_attempt(&runs, &tab.owner);
                        (tab, attempt)
                    })
                    .collect::<Vec<_>>(),
                None => Vec::new(),
            };
            (finished, Herdr::new(&s.herdr_socket))
        })
        .await?;
    let closed = futures::future::join_all(finished.into_iter().map(|(tab, attempt)| {
        let engine = engine.clone();
        let herdr = herdr.clone();
        async move {
            close_tab_recorded(
                &engine,
                &herdr,
                tab.owner,
                attempt,
                tab.tab_id,
                tab.terminal_id,
                "finished terminals closed".to_owned(),
            )
            .await
        }
    }))
    .await;
    let count = closed.into_iter().filter(|closed| *closed).count() as u64;
    engine
        .call(move |s| {
            s.log(format!(
                "closed {count} finished terminal{}",
                if count == 1 { "" } else { "s" }
            ))
        })
        .await?;
    engine.refresh_pane_survey().await;
    engine
        .call(|s| {
            let phase = s.current_phase();
            crate::snapshot::emit_snapshot(s, phase);
        })
        .await?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ac_io::herdr::HerdrPane;

    fn tab(owner: &str, tab: &str, pane: Option<&str>) -> OpenedTab {
        OpenedTab {
            owner: owner.into(),
            tab_id: tab.into(),
            pane_id: pane.map(str::to_owned),
            cwd: None,
            terminal_id: None,
        }
    }

    fn listing(panes: &[(&str, &str)]) -> PaneListing {
        let panes: Vec<HerdrPane> = panes
            .iter()
            .map(|(pane, tab)| HerdrPane {
                pane_id: (*pane).into(),
                tab_id: Some((*tab).into()),
                workspace_id: None,
                cwd: None,
                terminal_id: None,
            })
            .collect();
        PaneListing {
            tabs: panes.iter().filter_map(|p| p.tab_id.clone()).collect(),
            panes: panes.into_iter().map(|p| (p.pane_id.clone(), p)).collect(),
        }
    }

    #[test]
    fn a_tab_is_finished_while_listed_and_nothing_untouchable_is_in_it() {
        let opened = [
            tab("01", "t1", Some("p1")),
            tab("02", "t2", Some("p2")),
            tab("03", "t3", Some("p3")),
            tab("04", "t4", None),
            tab("05", "t5", Some("gone")),
        ];
        let l = listing(&[("p1", "t1"), ("p2", "t2"), ("p3", "t3"), ("p3b", "t3")]);
        let off = Untouchable {
            panes: ["p2".to_owned(), "p3b".to_owned()].into(),
            tabs: HashSet::new(),
        };
        let finished = finished_terminals(&opened, &l, &off, None);
        assert_eq!(
            finished
                .iter()
                .map(|t| t.owner.as_str())
                .collect::<Vec<_>>(),
            ["01"],
            "02 is untouchable, 03 shares its tab with an untouchable pane, 04 never recorded a pane, 05 is not listed"
        );
        let off_tabs = Untouchable {
            panes: HashSet::new(),
            tabs: ["t1".to_owned()].into(),
        };
        assert_eq!(finished_terminals(&opened, &l, &off_tabs, None).len(), 2);
    }
}
