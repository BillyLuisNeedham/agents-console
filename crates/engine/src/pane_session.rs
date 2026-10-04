//! The launch half of a terminal-backed Attempt (pane-session.ts).
//!
//! STUB(pane_session): the attempt launch port owns this module; the engine core only threads the
//! launch cadence a test may override through to the Attempt-run module.

/// The launch half's timings, every field overridable by a test (TypeScript's `Partial<LaunchCadence>`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchCadence {}
