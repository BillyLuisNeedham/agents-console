//! The Session: everything one pool's run knows (engine.ts `Session`), owned by the actor
//! ([`crate::actor`]) and touched only inside its jobs.
//!
//! PLACEHOLDER: the foundation port (F1-engine) fills this in with every field of the TypeScript
//! Session; the skeleton carries only what the actor and the handle need to compile.

use crate::actor::{Engine, SnapshotPublisher};
use crate::children::ChildTracker;
use crate::live_attempts::LiveAttempts;
use crate::pane_reads::PaneReadRegister;

/// One pool's run.
pub struct Session {
    /// This session's own handle, set by the actor before its first job, so session functions can
    /// start flows (`tokio::spawn` with a clone).
    pub engine: Option<Engine>,
    /// Where every emit publishes its snapshot.
    pub publisher: SnapshotPublisher,
    /// The pane read register (pane-reads.ts).
    pub pane_reads: PaneReadRegister,
    /// The headless children of this engine process (ADR-0017).
    pub children: ChildTracker,
    /// The Live attempts registry: every Attempt between its launch and its ending.
    pub live_attempts: LiveAttempts,
}
