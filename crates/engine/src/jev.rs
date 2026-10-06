//! Jev, the judgement model (ADR-0020, jev.ts), as the engine holds it: the TypeSafe port (`ac_io::jev`)
//! behind a handle the session clones into the flows that ask, and the pool-log lines its notice board's
//! announcements become.

use std::sync::Arc;

use ac_io::jev::{
    Evidence, Jev as JevPort, JevCause, JevNotice, JevResult, NoticeListener, Questions,
    Unsubscribe,
};

/// The model every Jev call names.
pub const JEV_MODEL: &str = ac_io::jev::JEV_MODEL;

/// One pool's Jev port. Cheap to clone: every clone asks through the same port and hears the same
/// notice board.
#[derive(Clone, Default)]
pub struct Jev {
    port: Option<Arc<dyn JevPort>>,
}

impl Jev {
    /// The port with no key: every call site takes its heuristic path.
    pub fn unconfigured() -> Self {
        Jev { port: None }
    }

    /// A pool's port: the real TypeSafe client, or a test's fake.
    pub fn new(port: Arc<dyn JevPort>) -> Self {
        Jev { port: Some(port) }
    }

    /// Whether the CLI boundary handed the port a key.
    pub fn configured(&self) -> bool {
        self.port.as_ref().is_some_and(|port| port.configured())
    }

    /// Ask every question over one Evidence. Never fails: a port that is not there falls back as
    /// `not-configured`, as an unconfigured one does.
    pub async fn ask(&self, evidence: &Evidence, questions: &Questions) -> JevResult {
        match &self.port {
            Some(port) => port.ask(evidence, questions).await,
            None => JevResult::FellBack {
                cause: JevCause::NotConfigured,
                detail: "no TYPESAFE_API_KEY at launch".to_owned(),
            },
        }
    }

    /// Hear each fallback cause once (and a recovery). `None` for a pool with no port at all.
    pub fn subscribe(&self, listener: NoticeListener) -> Option<Unsubscribe> {
        self.port.as_ref().map(|port| port.subscribe(listener))
    }
}

/// `jevNoticeLine`: the pool log's line for a notice.
pub fn jev_notice_line(notice: &JevNotice) -> String {
    match notice {
        JevNotice::Recovered => "Jev answering again".to_owned(),
        JevNotice::Unavailable { cause, detail } => {
            format!("Jev unavailable ({cause}: {detail}); heuristics until it answers")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notice_reads_as_the_pool_log_line() {
        assert_eq!(
            jev_notice_line(&JevNotice::Unavailable {
                cause: JevCause::RateLimited,
                detail: "HTTP 429".into()
            }),
            "Jev unavailable (rate-limited: HTTP 429); heuristics until it answers"
        );
        assert_eq!(
            jev_notice_line(&JevNotice::Recovered),
            "Jev answering again"
        );
    }

    #[tokio::test]
    async fn an_unconfigured_handle_falls_back_without_a_port() {
        let jev = Jev::unconfigured();
        assert!(!jev.configured());
        let result = jev.ask(&Evidence::new(), &Questions::new()).await;
        assert_eq!(result.cause(), Some(JevCause::NotConfigured));
        assert!(jev.subscribe(Box::new(|_| {})).is_none());
    }
}
