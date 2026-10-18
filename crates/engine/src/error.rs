//! Why the engine refused an action. The server maps each kind onto the HTTP status and body field its
//! TypeScript route answers with, so the kinds follow the TypeScript's error classes.

/// A refusal from the engine, whose `Display` is the TypeScript error's `message` exactly.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EngineError {
    /// queued-answers.ts `AnswerQueuedConflict`: a different answer is already queued (409).
    #[error("{0}")]
    AnswerQueuedConflict(String),
    /// The Line refuses this answer now (ADR-0039): an approval of the Finish while something
    /// blocks it, or notes on a Finish with no revise edge (409).
    #[error("{0}")]
    LineRefusal(String),
    /// reassign.ts `ReassignRefusal` (400 on the Reassign route, 409 on the Steward's).
    #[error("{0}")]
    ReassignRefusal(String),
    /// reassign.ts `ConfigUnreadableError`: console.json will not parse (500).
    #[error("{0}")]
    ConfigUnreadable(String),
    /// Any other thrown `Error`: its message.
    #[error("{0}")]
    Refused(String),
}

impl EngineError {
    /// A plain refusal with the TypeScript's message.
    pub fn refused(message: impl Into<String>) -> Self {
        EngineError::Refused(message.into())
    }

    /// The message, as the TypeScript's `err.message`.
    pub fn message(&self) -> &str {
        match self {
            EngineError::AnswerQueuedConflict(m)
            | EngineError::LineRefusal(m)
            | EngineError::ReassignRefusal(m)
            | EngineError::ConfigUnreadable(m)
            | EngineError::Refused(m) => m,
        }
    }
}

impl From<crate::actor::EngineGone> for EngineError {
    fn from(gone: crate::actor::EngineGone) -> Self {
        EngineError::Refused(gone.to_string())
    }
}
