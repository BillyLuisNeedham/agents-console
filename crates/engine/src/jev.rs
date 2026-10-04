//! Jev, the judgement model (ADR-0020, jev.ts), as the engine holds it.
//!
//! STUB(verify): the verify port brings the TypeSafe client (ac_io) and its notice board; the engine
//! core reads only whether a key was configured, for the boot line.

/// The model every Jev call names.
pub const JEV_MODEL: &str = "jev-latest";

/// One pool's Jev port.
#[derive(Debug, Clone, Default)]
pub struct Jev {
    configured: bool,
}

impl Jev {
    /// The port with no key: every call site takes its heuristic path.
    pub fn unconfigured() -> Self {
        Jev { configured: false }
    }

    /// STUB(verify): a configured port; the verify port replaces this with the HTTP client.
    pub fn configured_stub() -> Self {
        Jev { configured: true }
    }

    /// Whether the CLI boundary handed the port a key.
    pub fn configured(&self) -> bool {
        self.configured
    }
}
