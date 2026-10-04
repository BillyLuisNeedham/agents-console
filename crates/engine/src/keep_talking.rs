//! Keep talking and Continued attempts (issue #139; engine.ts 4611-5190).
//!
//! STUB(keep_talking): the Keep talking port owns this module. With no Continued attempt in flight
//! (the only state a pool without the feature reaches) nothing is owed a grade and nothing holds the
//! pool checkout.

use ac_core::pool::TicketMarker;

use crate::actor::Engine;
use crate::held::HeldPane;
use crate::session::Session;

/// One Continued attempt in flight.
#[derive(Debug, Clone)]
pub struct ContinuedAttempt {
    pub attempt: u64,
    pub work: HeldPane,
    /// Whether it works inside the pool checkout's tree, decided once at its start.
    pub in_pool_checkout: bool,
}

/// A verify ticket's Continued attempt that ended done and waits to be graded as a lone attempt.
#[derive(Debug, Clone)]
pub struct ContinuedGrade {
    pub ticket_id: String,
    pub attempt: u64,
    pub work: HeldPane,
}

/// `gradeContinuedAttempts`: grade, between super-steps, every Continued attempt owed a grade.
/// STUB(keep_talking): the owed grades are left owed.
pub async fn grade_continued_attempts(engine: &Engine) -> anyhow::Result<()> {
    let _ = engine;
    Ok(())
}

/// `owedContinuedGrade`: the lone grade a verify ticket's Continued attempt is still owed at boot.
/// STUB(keep_talking): none.
pub fn owed_continued_grade(session: &Session, marker: &TicketMarker) -> Option<ContinuedGrade> {
    let _ = (session, marker);
    None
}
