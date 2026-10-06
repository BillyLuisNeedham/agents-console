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
            crate::conversations::views(session)
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
            crate::conversations::views(session)
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
    //! engine/finished-terminals.test.ts.

    use super::*;
    use ac_core::events::{append_event, event_now};
    use ac_io::herdr::HerdrPane;
    use serde_json::{Map, json};
    use std::sync::Arc;

    fn pane(id: &str, tab: Option<&str>) -> HerdrPane {
        HerdrPane {
            pane_id: id.into(),
            tab_id: tab.map(str::to_owned),
            workspace_id: None,
            cwd: None,
            terminal_id: None,
        }
    }

    fn listing(panes: Vec<HerdrPane>) -> PaneListing {
        PaneListing {
            tabs: panes.iter().filter_map(|p| p.tab_id.clone()).collect(),
            panes: panes.into_iter().map(|p| (p.pane_id.clone(), p)).collect(),
        }
    }

    fn tab(owner: &str, n: u32, cwd: Option<&str>, terminal: Option<&str>) -> OpenedTab {
        OpenedTab {
            owner: owner.into(),
            tab_id: format!("t{n}"),
            pane_id: Some(format!("p{n}")),
            cwd: cwd.map(str::to_owned),
            terminal_id: terminal.map(str::to_owned),
        }
    }

    fn off(panes: &[&str], tabs: &[&str]) -> Untouchable {
        Untouchable {
            panes: panes.iter().map(|p| (*p).to_owned()).collect(),
            tabs: tabs.iter().map(|t| (*t).to_owned()).collect(),
        }
    }

    fn append(runs: &Path, owner: &str, attempt: u64, kind: TicketEventKind, payload: Value) {
        let payload: Map<String, Value> = payload.as_object().cloned().unwrap_or_default();
        append_event(runs, owner, &event_now(attempt, kind, payload)).unwrap();
    }

    fn tab_ids(tabs: Vec<OpenedTab>) -> Vec<String> {
        tabs.into_iter().map(|t| t.tab_id).collect()
    }

    #[test]
    fn reads_every_tab_the_owners_spawned_events_name_once_each() {
        let dir = tempfile::tempdir().unwrap();
        let runs = dir.path();
        append(
            runs,
            "01",
            1,
            TicketEventKind::Spawned,
            json!({"cwd": "/w", "pane_id": "p1", "tab_id": "t1", "terminal_id": "term_a"}),
        );
        append(
            runs,
            "01",
            2,
            TicketEventKind::Spawned,
            json!({"cwd": "/w", "pane_id": "p1", "tab_id": "t1", "continued": true}),
        );
        append(runs, "01", 3, TicketEventKind::Spawned, json!({"pid": 7}));
        append(
            runs,
            "conv-1",
            1,
            TicketEventKind::Spawned,
            json!({"pane_id": "pc", "tab_id": "tc"}),
        );
        append(
            runs,
            "enlist-1",
            1,
            TicketEventKind::Spawned,
            json!({"pane_id": "pe", "tab_id": "te"}),
        );
        let opened = opened_tabs(runs, &["01".to_owned(), "conv-1".to_owned()]);
        assert_eq!(
            opened,
            vec![
                OpenedTab {
                    owner: "01".into(),
                    tab_id: "t1".into(),
                    pane_id: Some("p1".into()),
                    cwd: Some("/w".into()),
                    terminal_id: None,
                },
                OpenedTab {
                    owner: "conv-1".into(),
                    tab_id: "tc".into(),
                    pane_id: Some("pc".into()),
                    cwd: None,
                    terminal_id: None,
                },
            ]
        );
    }

    #[test]
    fn counts_the_tabs_herdr_still_lists_whose_panes_nothing_is_using() {
        let opened: Vec<OpenedTab> = (1..=5)
            .map(|n| tab(&format!("0{n}"), n, None, None))
            .collect();
        let listed = listing(vec![
            pane("p1", Some("t1")), // crashed, still open
            pane("p2", Some("t2")), // a Live attempt's
            pane("p3", Some("t3")), // a Held pane's
            // p4 closed already
            pane("p5", Some("t5")), // the operator split a busy pane into t5
            pane("p5b", Some("t5")),
        ]);
        let untouchable = off(&["p2", "p3", "p5b"], &[]);
        assert_eq!(
            tab_ids(finished_terminals(&opened, &listed, &untouchable, None)),
            ["t1"]
        );
    }

    #[test]
    fn never_counts_a_tab_someone_enlisted_from_whoever_opened_it() {
        // A done ticket's still-open tab whose agent the operator then enlisted as a new Ticket: the
        // tab is theirs now.
        let opened = [tab("01", 1, None, None)];
        let listed = listing(vec![pane("p1", Some("t1"))]);
        assert!(finished_terminals(&opened, &listed, &off(&[], &["t1"]), None).is_empty());
        assert!(finished_terminals(&opened, &listed, &off(&["p1"], &[]), None).is_empty());
    }

    #[test]
    fn never_counts_a_tab_herdr_lists_differently_from_how_it_was_recorded() {
        let opened = [tab("01", 1, Some("/pool/wt/01"), None)];
        let none = off(&[], &[]);
        // Recorded pane now sits in another tab: an id reused by a new pane.
        assert!(
            finished_terminals(&opened, &listing(vec![pane("p1", Some("t9"))]), &none, None)
                .is_empty()
        );
        // Outside the Pool workspace.
        let mut elsewhere = pane("p1", Some("t1"));
        elsewhere.workspace_id = Some("w-other".into());
        assert!(
            finished_terminals(&opened, &listing(vec![elsewhere]), &none, Some("w1")).is_empty()
        );
        // In another directory.
        let mut moved = pane("p1", Some("t1"));
        moved.cwd = Some("/elsewhere".into());
        assert!(finished_terminals(&opened, &listing(vec![moved]), &none, None).is_empty());
        // As recorded, fields the daemon does not report are not held against it.
        let mut as_recorded = pane("p1", Some("t1"));
        as_recorded.workspace_id = Some("w1".into());
        as_recorded.cwd = Some("/pool/wt/01/".into());
        assert_eq!(
            finished_terminals(&opened, &listing(vec![as_recorded]), &none, Some("w1")).len(),
            1
        );
        assert_eq!(
            finished_terminals(&opened, &listing(vec![pane("p1", None)]), &none, Some("w1")).len(),
            1
        );
        assert!(finished_terminals(&opened, &listing(vec![]), &none, None).is_empty());
    }

    #[test]
    fn never_counts_a_tab_whose_terminal_herdr_now_names_differently() {
        let opened = [tab("01", 1, None, Some("term_65b1"))];
        let none = off(&[], &[]);
        let with_terminal = |terminal: &str| {
            let mut p = pane("p1", Some("t1"));
            p.terminal_id = Some(terminal.into());
            listing(vec![p])
        };
        // Same pane and tab ids, another terminal behind them: not ours.
        assert!(finished_terminals(&opened, &with_terminal("term_ffff"), &none, None).is_empty());
        assert_eq!(
            finished_terminals(&opened, &with_terminal("term_65b1"), &none, None).len(),
            1
        );
        // A record from before herdr gave terminal ids falls back to the other checks.
        assert_eq!(
            finished_terminals(
                &[tab("01", 1, None, None)],
                &with_terminal("term_ffff"),
                &none,
                None
            )
            .len(),
            1
        );
    }

    #[test]
    fn knows_a_tab_closed_by_its_terminal_id_when_one_was_recorded_by_its_tab_id_otherwise() {
        let closed = |payload: Value| {
            vec![Arc::new(ac_protocol::TicketEvent {
                at: "2026-09-25T10:00:00.000Z".into(),
                attempt: 1,
                kind: TicketEventKind::TabClosed,
                payload: payload.as_object().cloned().unwrap(),
            })]
        };
        // The same short tab id, reused by a later terminal: not the one closed.
        assert!(!tab_recorded_closed(
            &closed(json!({"tab_id": "t1", "terminal_id": "term_a"})),
            "t1",
            Some("term_b")
        ));
        assert!(tab_recorded_closed(
            &closed(json!({"tab_id": "t1", "terminal_id": "term_a"})),
            "t9",
            Some("term_a")
        ));
        // Records without terminal ids fall back to the tab id.
        assert!(tab_recorded_closed(
            &closed(json!({"tab_id": "t1"})),
            "t1",
            Some("term_b")
        ));
        assert!(tab_recorded_closed(
            &closed(json!({"tab_id": "t1", "terminal_id": "term_a"})),
            "t1",
            None
        ));
        assert!(!tab_recorded_closed(&[], "t1", None));
    }

    #[test]
    fn leaves_out_a_tab_its_owners_events_record_closed() {
        let dir = tempfile::tempdir().unwrap();
        let runs = dir.path();
        append(
            runs,
            "01",
            1,
            TicketEventKind::Spawned,
            json!({"pane_id": "p1", "tab_id": "t1", "terminal_id": "term_a"}),
        );
        append(
            runs,
            "01",
            2,
            TicketEventKind::Spawned,
            json!({"pane_id": "p2", "tab_id": "t2"}),
        );
        append(
            runs,
            "01",
            1,
            TicketEventKind::TabClosed,
            json!({"tab_id": "t1", "terminal_id": "term_a"}),
        );
        assert_eq!(tab_ids(opened_tabs(runs, &["01".to_owned()])), ["t2"]);
    }
}
