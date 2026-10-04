//! The pane survey (issue #139; pane-survey.ts): the engine's cached answer to "which herdr panes and
//! tabs are open right now", for the two things the snapshot says about panes nobody is watching. A
//! Held pane is shown only while its pane is still listed, and the Finished terminals count is the
//! tabs the pool opened that are still listed. One listing serves both.
//!
//! The snapshot is emitted far more often than panes come and go, so the survey lists on a slow
//! cadence and on demand (a pane held, a bulk close done, a Continued attempt ended) and the snapshot
//! reads the last listing. Every listing is handed to the engine ([`crate::held::survey_listed`]),
//! which emits when what it derives from it moved.
//!
//! A listing the daemon cannot answer says nothing about any pane: the last good listing stands.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};

use ac_core::js;
use ac_io::herdr::{Herdr, HerdrPane};

use crate::actor::Engine;
use crate::session::Session;

/// How often the survey lists while nothing asks for a fresher answer: slow, because the operator
/// closing a tab by hand is the only change it exists to notice on its own.
pub const PANE_SURVEY_MS: u64 = 15_000;

/// One pane as herdr lists it; a field the daemon does not report is `None`.
pub type ListedPane = HerdrPane;

/// A listing the daemon answered.
#[derive(Debug, Clone, Default)]
pub struct PaneListing {
    /// Every listed pane, by id.
    pub panes: HashMap<String, ListedPane>,
    /// Every tab a listed pane sits in.
    pub tabs: HashSet<String>,
}

/// A pane as the engine recorded it on a `spawned` event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedPane {
    pub pane_id: String,
    pub tab_id: Option<String>,
    pub cwd: Option<String>,
    /// herdr's never-reused terminal id, on records made since herdr gave one.
    pub terminal_id: Option<String>,
}

/// A directory as herdr reports it: the physical path (herdr resolves symlinks, macOS's /tmp among
/// them), so the recorded one is resolved the same way before they are compared.
fn trim_slash(path: &str) -> String {
    let physical = js::canonical_dir(path);
    if physical.chars().count() > 1 {
        physical.trim_end_matches('/').to_owned()
    } else {
        physical
    }
}

/// `listedAsRecorded`: whether the listing still has the pane the engine recorded, and it is the same
/// pane (issue #139): a herdr id is only an id, and a daemon that was restarted, or a pane closed and
/// its id reused, can list a different pane under a recorded one. So the listed pane must sit in the
/// recorded tab, in the Pool workspace when one is named (`workspace_id`; `None` for a pane that is the
/// operator's and lives wherever they put it), and in the recorded directory, each checked only where
/// the listing reports it. Where both the record and the listing carry herdr's `terminal_id`, which is
/// unique per terminal and never reused, it alone decides.
pub fn listed_as_recorded(
    listing: &PaneListing,
    recorded: &RecordedPane,
    workspace_id: Option<&str>,
) -> bool {
    let Some(listed) = listing.panes.get(&recorded.pane_id) else {
        return false;
    };
    if let (Some(recorded_terminal), Some(listed_terminal)) = (
        recorded.terminal_id.as_deref().filter(|id| !id.is_empty()),
        listed.terminal_id.as_deref().filter(|id| !id.is_empty()),
    ) {
        return listed_terminal == recorded_terminal;
    }
    if let (Some(recorded_tab), Some(listed_tab)) = (&recorded.tab_id, &listed.tab_id)
        && listed_tab != recorded_tab
    {
        return false;
    }
    if let (Some(workspace), Some(listed_workspace)) = (workspace_id, &listed.workspace_id)
        && listed_workspace != workspace
    {
        return false;
    }
    if let (Some(recorded_cwd), Some(listed_cwd)) = (&recorded.cwd, &listed.cwd)
        && trim_slash(listed_cwd) != trim_slash(recorded_cwd)
    {
        return false;
    }
    true
}

/// One listing in flight: resolves whether the daemon answered it. Already running; awaiting it only
/// waits.
pub type Listing = Shared<BoxFuture<'static, bool>>;

/// The survey's state, held by the session.
pub struct PaneSurvey {
    last: Option<Arc<PaneListing>>,
    in_flight: Option<(u64, Listing)>,
    /// The listing queued behind the one in flight, shared by every caller that arrives while it runs.
    queued: Option<Listing>,
    stopped: bool,
    seq: u64,
}

impl std::fmt::Debug for PaneSurvey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PaneSurvey")
            .field("listed", &self.last.is_some())
            .field("stopped", &self.stopped)
            .finish()
    }
}

impl PaneSurvey {
    fn new() -> Self {
        PaneSurvey {
            last: None,
            in_flight: None,
            queued: None,
            stopped: false,
            seq: 0,
        }
    }

    /// The last listing the daemon answered, or `None` before the first.
    pub fn latest(&self) -> Option<Arc<PaneListing>> {
        self.last.clone()
    }
}

/// `createPaneSurvey`: start the survey and its cadence. Only a terminal-backed pool has panes to list.
pub fn create_pane_survey(session: &mut Session, interval_ms: Option<u64>) {
    session.pane_survey = Some(PaneSurvey::new());
    let engine = session.engine();
    let every = Duration::from_millis(interval_ms.unwrap_or(PANE_SURVEY_MS).max(1));
    tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let running = engine
                .call(|s| {
                    if s.pane_survey.as_ref().is_none_or(|survey| survey.stopped) {
                        return false;
                    }
                    let _ = refresh(s);
                    true
                })
                .await;
            if !matches!(running, Ok(true)) {
                return;
            }
        }
    });
}

/// `stop`: stop the cadence for good; the engine is shutting down.
pub fn stop_pane_survey(session: &mut Session) {
    if let Some(survey) = session.pane_survey.as_mut() {
        survey.stopped = true;
    }
}

/// `refresh`: a listing that began after this call, so a caller that just changed something (a claim,
/// a close, an ending) is not answered by one already in flight before it. Calls made while one
/// listing runs share the single listing queued behind it. `None` in a pool with no survey. The
/// listing is already running; await it for whether it landed (when it did not, the last one stands).
pub fn refresh(session: &mut Session) -> Option<Listing> {
    let engine = session.engine.clone()?;
    let survey = session.pane_survey.as_mut()?;
    let Some((_, in_flight)) = survey.in_flight.clone() else {
        return Some(start(session));
    };
    if let Some(queued) = &survey.queued {
        return Some(queued.clone());
    }
    let queued: Listing = async move {
        let _ = in_flight.await;
        let next = engine
            .call(|s| {
                if let Some(survey) = s.pane_survey.as_mut() {
                    survey.queued = None;
                }
                if s.pane_survey.is_some() {
                    Some(start(s))
                } else {
                    None
                }
            })
            .await
            .ok()
            .flatten();
        match next {
            Some(listing) => listing.await,
            None => false,
        }
    }
    .boxed()
    .shared();
    drive(queued.clone());
    survey.queued = Some(queued.clone());
    Some(queued)
}

/// `void survey.refresh()`: ask for a fresher listing and carry on.
pub fn refresh_in_background(session: &mut Session) {
    let _ = refresh(session);
}

fn drive(listing: Listing) {
    tokio::spawn(async move {
        let _ = listing.await;
    });
}

// One listing. Its synchronous prologue is the TypeScript `list` callback's: the opened tabs and the
// enlisted terminals are recomputed from the events as the listing begins.
fn start(session: &mut Session) -> Listing {
    session.opened_tabs = crate::terminals::opened_tabs(
        std::path::Path::new(&session.runs_dir),
        &crate::terminals::tab_owners(session),
    );
    session.enlisted_terminals = crate::terminals::enlisted_terminals_of(session);
    let engine = session.engine();
    let herdr = Herdr::new(&session.herdr_socket);
    let survey = session
        .pane_survey
        .as_mut()
        .expect("a listing starts only in a pool with a survey");
    survey.seq += 1;
    let id = survey.seq;
    let listing: Listing = async move {
        let listed = herdr.list_panes().await;
        engine
            .call(move |s| {
                let landed = match listed {
                    Ok(listed) => land(s, listed),
                    Err(_) => false,
                };
                // The listing is over: a later caller starts its own.
                if let Some(survey) = s.pane_survey.as_mut()
                    && survey.in_flight.as_ref().is_some_and(|(n, _)| *n == id)
                {
                    survey.in_flight = None;
                }
                landed
            })
            .await
            .unwrap_or(false)
    }
    .boxed()
    .shared();
    survey.in_flight = Some((id, listing.clone()));
    drive(listing.clone());
    listing
}

fn land(session: &mut Session, listed: Vec<ListedPane>) -> bool {
    if session.pane_survey.as_ref().is_none_or(|s| s.stopped) {
        return false;
    }
    let tabs = listed
        .iter()
        .filter_map(|pane| pane.tab_id.clone())
        .collect();
    let panes = listed
        .into_iter()
        .map(|pane| (pane.pane_id.clone(), pane))
        .collect();
    if let Some(survey) = session.pane_survey.as_mut() {
        survey.last = Some(Arc::new(PaneListing { panes, tabs }));
    }
    crate::held::survey_listed(session);
    true
}

impl Engine {
    /// `paneSurvey.refresh()` from outside the actor: whether a listing that began after this call
    /// landed. `false` in a pool with no survey.
    pub async fn refresh_pane_survey(&self) -> bool {
        match self.call(refresh).await {
            Ok(Some(listing)) => listing.await,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(id: &str, tab: Option<&str>, workspace: Option<&str>, cwd: Option<&str>) -> ListedPane {
        ListedPane {
            pane_id: id.to_owned(),
            tab_id: tab.map(str::to_owned),
            workspace_id: workspace.map(str::to_owned),
            cwd: cwd.map(str::to_owned),
            terminal_id: None,
        }
    }

    fn listing(panes: Vec<ListedPane>) -> PaneListing {
        PaneListing {
            tabs: panes.iter().filter_map(|p| p.tab_id.clone()).collect(),
            panes: panes.into_iter().map(|p| (p.pane_id.clone(), p)).collect(),
        }
    }

    fn recorded(id: &str, tab: Option<&str>, cwd: Option<&str>) -> RecordedPane {
        RecordedPane {
            pane_id: id.to_owned(),
            tab_id: tab.map(str::to_owned),
            cwd: cwd.map(str::to_owned),
            terminal_id: None,
        }
    }

    #[test]
    fn a_pane_must_be_listed_in_the_recorded_tab_workspace_and_directory() {
        let l = listing(vec![pane(
            "p1",
            Some("t1"),
            Some("w1"),
            Some("/nonexistent/a/"),
        )]);
        assert!(listed_as_recorded(
            &l,
            &recorded("p1", Some("t1"), Some("/nonexistent/a")),
            Some("w1")
        ));
        assert!(!listed_as_recorded(
            &l,
            &recorded("p2", Some("t1"), None),
            None
        ));
        assert!(!listed_as_recorded(
            &l,
            &recorded("p1", Some("t2"), None),
            None
        ));
        assert!(!listed_as_recorded(
            &l,
            &recorded("p1", Some("t1"), None),
            Some("w2")
        ));
        assert!(!listed_as_recorded(
            &l,
            &recorded("p1", None, Some("/nonexistent/b")),
            None
        ));
        // A field the listing does not report is not checked.
        let bare = listing(vec![pane("p1", None, None, None)]);
        assert!(listed_as_recorded(
            &bare,
            &recorded("p1", Some("t9"), Some("/x")),
            Some("w9")
        ));
        // A pane that is the operator's lives wherever they put it.
        assert!(listed_as_recorded(
            &l,
            &recorded("p1", Some("t1"), None),
            None
        ));
    }

    #[test]
    fn a_terminal_id_on_both_sides_decides_alone() {
        let mut moved = pane("p1", Some("t9"), Some("w9"), Some("/elsewhere"));
        moved.terminal_id = Some("term-1".into());
        let l = listing(vec![moved]);
        let mut same = recorded("p1", Some("t1"), Some("/a"));
        same.terminal_id = Some("term-1".into());
        assert!(listed_as_recorded(&l, &same, Some("w1")));
        let mut other = same.clone();
        other.terminal_id = Some("term-2".into());
        assert!(!listed_as_recorded(&l, &other, None));
        // An empty id counts as none.
        let mut empty = recorded("p1", Some("t9"), None);
        empty.terminal_id = Some(String::new());
        assert!(listed_as_recorded(&l, &empty, None));
    }
}
