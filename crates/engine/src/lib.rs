//! The pool engine: one tokio task owns pool state and takes messages (ADR-0036). See
//! docs/specs/162-rust-port-design.md for the actor model and the module map from engine.ts.

pub mod actor;
pub mod attempt_ending;
pub mod attempt_run;
pub mod children;
pub mod claude_trust;
pub mod error;
pub mod handle;
pub mod live_attempts;
pub mod pane_reads;
pub mod pane_session;
pub mod session;
pub mod snapshot;

pub use actor::{Engine, EngineGone};
pub use error::EngineError;
pub use snapshot::{PoolSnapshot, PoolState};
