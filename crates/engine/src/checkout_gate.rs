//! The pool checkout has one agent at a time (ADR-0027), so what the engine writes there on its own
//! account across an await is recorded while it writes, and Keep talking refuses beside it or beside an
//! enlisted pane working in the checkout.

use std::path::Path;

use ac_core::events::read_events;
use ac_protocol::TicketEventKind;

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
    if !session.git
        && let Some(id) = session.launched.iter().find(|id| *id != except_id)
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
