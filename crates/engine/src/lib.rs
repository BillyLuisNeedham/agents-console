//! The pool engine: one tokio task owns pool state and takes messages (ADR-0036). See
//! docs/specs/162-rust-port-design.md for the actor model and the module map from engine.ts.
//!
//! Running note (F1-engine, the foundation of M3):
//!
//! - Done: session (Session, PoolState, PoolUpdate, apply_update), options (RunOptions), boot
//!   (start_pool, seed_enlisted_work, rehydrate for a plain headless restart), handle (accept,
//!   answer, settled, shutdown, close, reload_config), drive (the loop, the boundary, plan, run,
//!   close, settle, drive death), snapshot (emit_snapshot and the hold watch's timer), persist,
//!   interrupts (raise, clear, deadlocks, checkpoints and Briefs, the Review), answers (accept, kick,
//!   drain, process, Close), config_reload, tickets (attempt env, plan, run, attempt tabs, crash
//!   body), merges (the hold over git and the wait-and-recompute rule, the merge target, the Ticket
//!   file reconcile, mergeTicket, resume, the resolver and its approval), checkout_gate. In ac-core:
//!   merge_hold (derivation, memo, watch bookkeeping, Merge line), outcome (Outcome and Spawn
//!   validation), prompt (the Ticket and resolver prompts).
//! - Herdr panes (r-panes): pane_survey (the cached listing and its cadence), held (Held panes,
//!   untouchable panes, the Finished terminals count), terminals (opened tabs, the idle-tab rule, the
//!   bulk close), pool_workspace (boot resolution, re-resolve, relabel), enlisted (the runtime of an
//!   enlisted pane), enlist and enlist_flow (the picker's listing, `POST /api/enlist`, an enlisted
//!   attempt's ending).
//! - STUB modules, each owned by another port: attempt_run, attempt_ending, live_attempts, children,
//!   pane_session (the attempt launch port); conversations; keep_talking; restart (orphans,
//!   adoption); spawns (taking and adopting proposals; the ledger refresh is ported);
//!   steward_actions (the actions; the answer and snapshot helpers are ported); verify (grading,
//!   Selection; the acceptance checks are ported); jev.
//! - Next: the conformance runs once the server and the attempt launch land.

pub mod actor;
pub mod answers;
pub mod attempt_ending;
pub mod attempt_run;
pub mod boot;
pub mod checkout_gate;
pub mod children;
pub mod claude_trust;
pub mod config_reload;
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
pub use handle::PoolOptions;
pub use options::RunOptions;
pub use snapshot::{PoolSnapshot, PoolState};
