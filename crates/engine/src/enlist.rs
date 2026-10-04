//! Enlist discovery (issue #101, enlist.ts): the engine's judgement of which live herdr panes can become
//! Pool citizens. The Console never talks to herdr; the pool server reads `agent.list` through this
//! module on request and answers with the panes response. The pane list is ephemeral, so it rides no
//! snapshot and is fetched when the picker opens.
//!
//! A pane is enlistable when its harness is one the engine has a descriptor for, its directory is a
//! checkout of the pool's repository (it shares the pool's git common dir, so a worktree or the main
//! checkout both qualify), and no live attempt or Conversation already holds its pane id. Ineligible
//! panes are returned with the reason, never dropped.
//!
//! The listing the server's `GET /api/panes` answers with, and the eligibility it shares with
//! `findEnlistablePane`; the flow that enlists is [`crate::enlist_flow`].

use std::collections::HashSet;
use std::path::Path;

use ac_core::harness::harness_descriptor;
use ac_core::js;
use ac_io::git::{branch_at, git_common_dir};
use ac_io::herdr::{Herdr, HerdrAgent, HerdrError};
use ac_protocol::{EnlistPane, PanesResponse};

/// A pane the engine already holds is in the pool whatever else is true of it.
pub const ALREADY_IN_POOL: &str = "already in the pool";
/// The pane's directory is not a checkout of the pool's repository.
pub const NOT_A_CHECKOUT: &str = "not a checkout of this pool's repository";
/// herdr's agent label names no harness the engine has a descriptor for.
pub const UNKNOWN_HARNESS: &str = "no harness the engine knows";

/// Whether `directory` shares the pool's git common dir. A directory that is not a checkout resolves
/// its own fallback common dir and never matches.
fn shares_pool_repository(directory: &str, pool_common_dir: &str) -> bool {
    js::canonical_dir(&git_common_dir(directory)) == pool_common_dir
}

/// Whether the pane can be enlisted, and why not when it cannot.
pub fn eligibility_of(
    agent: &HerdrAgent,
    pool_common_dir: &str,
    registered_panes: &HashSet<String>,
) -> Result<(), &'static str> {
    // Ownership first: a pane the engine already holds is in the pool whatever else is true of it,
    // including a harness the pool registered by hand.
    if registered_panes.contains(&agent.pane_id) {
        return Err(ALREADY_IN_POOL);
    }
    match agent.directory.as_deref() {
        Some(directory) if shares_pool_repository(directory, pool_common_dir) => {}
        _ => return Err(NOT_A_CHECKOUT),
    }
    match agent.harness.as_deref() {
        Some(harness) if harness_descriptor(&harness.to_lowercase()).is_some() => Ok(()),
        _ => Err(UNKNOWN_HARNESS),
    }
}

/// The pool's git common dir, canonical, as eligibility compares it.
pub fn pool_common_dir(pool_dir: &Path) -> String {
    js::canonical_dir(&git_common_dir(pool_dir))
}

/// `listEnlistPanes`: every pane herdr reports, with the engine's verdict beside it. The pool's common
/// dir is resolved once for the whole listing; the branch per pane, in its own directory.
pub async fn list_enlist_panes(
    herdr: &Herdr,
    pool_dir: &Path,
    registered_panes: &HashSet<String>,
) -> Result<PanesResponse, HerdrError> {
    let agents = herdr.list_agents().await?;
    let common = pool_common_dir(pool_dir);
    let panes = agents
        .into_iter()
        .map(|agent| {
            let verdict = eligibility_of(&agent, &common, registered_panes);
            let branch = agent.directory.as_deref().and_then(branch_at);
            EnlistPane {
                pane_id: agent.pane_id,
                harness: agent.harness,
                status: agent.status,
                title: agent.title,
                directory: agent.directory,
                branch,
                eligible: verdict.is_ok(),
                reason: verdict.err().map(str::to_owned),
            }
        })
        .collect();
    Ok(PanesResponse { panes })
}

/// One live pane resolved and judged for enlist: the found facts the engine records, with eligibility
/// already decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundPane {
    pub pane_id: String,
    pub tab_id: Option<String>,
    pub harness: String,
    pub session_id: Option<String>,
    pub title: String,
    pub directory: String,
    pub branch: String,
}

/// `findEnlistablePane`: resolve one pane the operator picked and judge it again at submit time (issue
/// #101): herdr's list is read afresh because the picker's answer is ephemeral. An absent pane, one
/// already held by a live attempt or Conversation, one outside the pool's repository, one with no known
/// harness, and one whose directory has no branch are all a reason (the inner `Err`), never a thrown
/// error: the route turns the reason into its 409. A daemon that cannot list is the outer `Err`.
pub async fn find_enlistable_pane(
    herdr: &Herdr,
    pool_dir: &Path,
    pane_id: &str,
    registered_panes: &HashSet<String>,
) -> Result<Result<FoundPane, String>, HerdrError> {
    let agents = herdr.list_agents().await?;
    let Some(agent) = agents.into_iter().find(|agent| agent.pane_id == pane_id) else {
        return Ok(Err(format!("pane {pane_id} is gone")));
    };
    let common = pool_common_dir(pool_dir);
    if let Err(reason) = eligibility_of(&agent, &common, registered_panes) {
        return Ok(Err(reason.to_owned()));
    }
    let (Some(directory), Some(harness)) = (agent.directory.clone(), agent.harness.clone()) else {
        return Ok(Err(NOT_A_CHECKOUT.to_owned()));
    };
    let Some(branch) = branch_at(&directory) else {
        return Ok(Err(
            "the pane's directory has no branch checked out".to_owned()
        ));
    };
    Ok(Ok(FoundPane {
        pane_id: agent.pane_id,
        tab_id: agent.tab_id,
        harness,
        session_id: agent.session_id,
        title: agent.title,
        directory,
        branch,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(pane: &str, harness: Option<&str>, directory: Option<&str>) -> HerdrAgent {
        HerdrAgent {
            pane_id: pane.to_owned(),
            tab_id: None,
            harness: harness.map(str::to_owned),
            status: "idle".to_owned(),
            title: String::new(),
            directory: directory.map(str::to_owned),
            session_id: None,
        }
    }

    #[test]
    fn judges_ownership_first_then_the_checkout_then_the_harness() {
        let registered: HashSet<String> = ["p1".to_owned()].into();
        assert_eq!(
            eligibility_of(&agent("p1", Some("claude"), None), "/x", &registered),
            Err(ALREADY_IN_POOL)
        );
        assert_eq!(
            eligibility_of(&agent("p2", Some("claude"), None), "/x", &registered),
            Err(NOT_A_CHECKOUT)
        );
    }
}
