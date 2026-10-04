//! Enlisted attempts (issue #101, enlisted.ts): the runtime behind every pane the operator enlisted.
//!
//! STUB(enlisted): the enlist port owns this module; the engine core only disposes of it at shutdown.

/// The enlisted runtimes.
#[derive(Debug, Default)]
pub struct EnlistedAttempts {}

impl EnlistedAttempts {
    /// Stop every enlisted loop this process runs; the panes are the operator's and stay.
    pub fn dispose(&mut self) {}
}
