//! The pool checkout's gate (ADR-0027; engine.ts 4480-4611): the pool checkout has one agent at a
//! time, so what the engine writes there on its own account is recorded while it writes, and a merge
//! into the checkout waits while a Continued attempt works in it.

use std::path::Path;
use std::time::Duration;

use serde_json::Map;

use ac_core::events::{append_event, event_now, read_events};
use ac_core::merge_hold::MERGE_HOLD_POLL_MS;
use ac_protocol::TicketEventKind;

use crate::actor::Engine;
use crate::session::Session;

/// A writer in the pool checkout, released by [`release_pool_checkout`].
pub type CheckoutHold = u64;

/// `holdPoolCheckout`: mark the engine writing in the pool checkout until released. Keep talking
/// refuses beside it, in these words.
pub fn hold_pool_checkout(session: &mut Session, what: impl Into<String>) -> CheckoutHold {
    session.pool_checkout_writer_seq += 1;
    let key = session.pool_checkout_writer_seq;
    session.pool_checkout_writers.insert(key, what.into());
    key
}

/// The release a hold returns.
pub fn release_pool_checkout(session: &mut Session, hold: CheckoutHold) {
    session.pool_checkout_writers.shift_remove(&hold);
}

/// `inPoolCheckout`: whether a directory is inside the pool checkout's own working tree: its git
/// toplevel is the checkout's, so a subdirectory counts and a pool worktree does not. A directory git
/// cannot answer for counts by its path alone.
pub fn in_pool_checkout(session: &Session, cwd: &str) -> bool {
    if let Some(top) = ac_io::git::show_toplevel(cwd) {
        return ac_core::js::canonical_dir(&top) == session.cwd;
    }
    let path = ac_core::js::canonical_dir(cwd);
    path == session.cwd || path.starts_with(&format!("{}/", session.cwd))
}

/// `otherAgentInPoolCheckout`: what, other than `except_id`'s own agent, is writing in the pool
/// checkout right now, as a phrase for the refusal; `None` when nothing is.
pub fn other_agent_in_pool_checkout(session: &Session, except_id: &str) -> Option<String> {
    if let Some(what) = session.pool_checkout_writers.values().next() {
        return Some(what.clone());
    }
    if let Some(id) = session
        .pool_checkout_planned
        .iter()
        .find(|id| *id != except_id)
    {
        return Some(format!("{id} is working now"));
    }
    let mut ids: Vec<String> = session.live_attempts.ids();
    for id in session.adopted.keys() {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    for id in ids {
        if id == except_id {
            continue;
        }
        let cwd = match session.enlisted_work.get(&id) {
            Some(work) => Some(work.directory.clone()),
            None => read_events(Path::new(&session.runs_dir), &id)
                .iter()
                .rfind(|event| event.kind == TicketEventKind::Spawned)
                .and_then(|event| event.payload.get("cwd"))
                .and_then(|cwd| cwd.as_str())
                .map(str::to_owned),
        };
        if let Some(cwd) = cwd
            && in_pool_checkout(session, &cwd)
        {
            return Some(format!("{id} is working now"));
        }
    }
    for (id, cwd) in crate::conversations::live_directories(session) {
        if id != except_id && in_pool_checkout(session, &cwd) {
            return Some(format!("{id} is working now"));
        }
    }
    None
}

/// `poolCheckoutHeld`: whether a Continued attempt holds the pool checkout while merges land in it.
/// Once an enlist captured the target, merges run in the engine's own merge checkout instead.
pub fn pool_checkout_held(session: &Session) -> bool {
    if session.merge_target.is_some() {
        return false;
    }
    session.continued.values().any(|c| c.in_pool_checkout)
}

/// `poolCheckoutFree`: wait until no Continued attempt holds the pool checkout; false when the engine
/// began shutting down while it waited.
pub async fn pool_checkout_free(engine: &Engine) -> anyhow::Result<bool> {
    loop {
        let (held, stopping) = engine
            .call(|s| (pool_checkout_held(s), s.children.stopping))
            .await?;
        if !held {
            return Ok(true);
        }
        if stopping {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(MERGE_HOLD_POLL_MS)).await;
    }
}

/// The merge a gate passage records as deferred while it waits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeferredMerge {
    pub ticket_id: String,
    pub path: String,
    pub branch: String,
    pub attempt: u64,
}

/// `throughPoolCheckoutGate`: a merge into the pool checkout, run through its gate as it is about to
/// touch the checkout. With no Continued attempt there the merge runs at once; with one, the link waits
/// until it ends, recording the merge `merge-deferred` on its ticket the moment it is held. A merge
/// counts as in flight from the gate until it settles. The merge itself is one job on the actor.
pub async fn through_pool_checkout_gate<T: Send + 'static>(
    engine: &Engine,
    deferred: Option<DeferredMerge>,
    merge: impl FnOnce(&mut Session) -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<Option<T>> {
    let what = match &deferred {
        Some(d) => format!(
            "a merge of {} into the pool checkout is in flight",
            d.ticket_id
        ),
        None => "a Conversation's merge into the pool checkout is in flight".to_owned(),
    };
    // With nothing in the way the merge runs in the same job as the check, as the TypeScript runs it
    // in the same tick; held, the merge comes back to wait.
    let what_now = what.clone();
    let passage = engine
        .call(move |s| {
            if !pool_checkout_held(s) {
                return anyhow::Ok(Passage::Ran(run_held(s, what_now, merge)?));
            }
            if let Some(d) = &deferred {
                let mut payload = Map::new();
                payload.insert("path".into(), d.path.clone().into());
                payload.insert("branch".into(), d.branch.clone().into());
                let event = event_now(d.attempt, TicketEventKind::MergeDeferred, payload);
                append_event(Path::new(&s.runs_dir), &d.ticket_id, &event)?;
            }
            Ok(Passage::Waiting(merge))
        })
        .await??;
    let merge = match passage {
        Passage::Ran(result) => return Ok(Some(result)),
        Passage::Waiting(merge) => merge,
    };
    if !pool_checkout_free(engine).await? {
        return Ok(None);
    }
    engine
        .call(move |s| run_held(s, what, merge).map(Some))
        .await?
}

enum Passage<T, F> {
    Ran(T),
    Waiting(F),
}

// The merge, counted as a writer in the pool checkout while it runs.
fn run_held<T>(
    session: &mut Session,
    what: String,
    merge: impl FnOnce(&mut Session) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let hold = hold_pool_checkout(session, what);
    let result = merge(session);
    release_pool_checkout(session, hold);
    result
}
