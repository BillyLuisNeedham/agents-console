//! The pool engine: one tokio task owns pool state and takes messages (ADR-0036). The actor
//! ([`actor`]) owns the [`session::Session`] and runs every job against it; [`boot`] starts a pool,
//! [`handle`] is the server's way in, and [`drive`] is the loop that plans, runs and settles
//! Attempts and Conversations. The rest are the engine's areas: Tickets and merges, Interrupts and
//! answers, herdr panes and enlisted terminals, Conversations and the Steward, Spawns, Restart,
//! verify and Jev. The design and the module map from the old TypeScript engine.ts are in git
//! history (`docs/specs/162-rust-port-design.md` before the pull request).

pub mod actor;
pub mod answers;
pub mod attempt_ending;
pub mod attempt_run;
pub mod boot;
pub mod checkout_gate;
pub mod children;
pub mod claude_trust;
pub mod config_reload;
pub mod continued;
pub mod conversations;
pub mod drive;
#[cfg(test)]
mod e2e_tests;
pub mod enlist;
pub mod enlist_flow;
pub mod enlisted;
pub mod error;
pub mod handle;
pub mod held;
pub mod interrupts;
pub mod jev;
pub mod keep_talking;
pub mod live_attempts;
pub mod merges;
pub mod options;
pub mod pane_reads;
pub mod pane_session;
pub mod pane_survey;
pub mod persist;
pub mod pool_workspace;
pub mod restart;
pub mod session;
pub mod snapshot;
pub mod spawns;
pub mod steward_actions;
pub mod terminals;
#[cfg(test)]
mod testkit;
pub mod tickets;
pub mod verify;

pub use actor::{Engine, EngineGone};
pub use boot::start_pool;
pub use error::EngineError;
pub use options::RunOptions;
pub use snapshot::{PoolSnapshot, PoolState};

/// Lock a mutex, taking it as it stands when a holder panicked: the few small mutexes the engine keeps
/// (ADR-0036) hold bookkeeping a panic cannot leave half-written in a way worth refusing.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
