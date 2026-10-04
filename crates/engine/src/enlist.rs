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
//! Ported so far: the listing the server's `GET /api/panes` answers with, and the eligibility it shares
//! with `findEnlistablePane`, which the enlist flow's port adds beside it.

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
