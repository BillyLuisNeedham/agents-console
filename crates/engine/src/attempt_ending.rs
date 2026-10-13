//! The **Attempt-ending** module (ADR-0014, fifth amendment; ADR-0016; ADR-0017; attempt-ending.ts):
//! the one place that decides an Attempt is over, for every way an Attempt can run.
//! [`wait_for_attempt_ending`] is that decision: a fresh headless child's exit, a fresh terminal-backed
//! attempt's raced forms, and a boot-adopted attempt all come in through the one interface and come out
//! as one result: how it ended, the exit code, and the site's validated result or the crash reason.
//!
//! For a terminal-backed attempt, two observations say so, and they are raced rather than ranked,
//! because each is blind to what the other sees. herdr's pane end is prompt and covers an attempt that
//! never wrote anything, but it travels down a subscription the daemon can drop without saying so. The
//! exit-code file the pane wrapper writes before its shell exits covers exactly that, but it never
//! appears for a pane that was killed. A third observation closes the case where both fail: on a slow
//! cadence the wait re-checks herdr's pane listing, and a pane that has left it with no exit-code file
//! behind it, after a short grace window for the wrapper's last write, is a genuine crash. Liveness,
//! not duration, stands in for a deadline: a real attempt legitimately runs for ninety-eight minutes.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::Value;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use ac_core::js;
use ac_io::herdr::{Herdr, PaneEnd};

use crate::attempt_run::{AttemptHost, on_registries};

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/// What the wait watches. A pane watch serves a fresh terminal-backed attempt and a boot-adopted one
/// alike; a headless watch is the fresh headless child's exit, already in flight (its exit code, or
/// the failure of a log the engine could not write).
pub enum AttemptWatch {
    Pane {
        herdr: Herdr,
        pane_id: String,
    },
    Headless {
        exit: BoxFuture<'static, anyhow::Result<i64>>,
    },
}

/// How an attempt's ending was observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptEnding {
    /// A valid result file appeared (ADR-0016: the attempt ends on a valid result without requiring
    /// pane exit), or was already there when the ending landed.
    Outcome,
    /// The headless child exited; the code is its own.
    ChildExit,
    /// herdr reported the pane exited or closed.
    PaneEnd,
    /// The wrapper's exit-code file appeared, whatever the daemon was doing at the time.
    ExitCode,
    /// The pane left herdr's listing and no exit-code file followed it within the grace window.
    PaneGone,
}

/// How a pane's ending was observed, for the one caller that watches a pane without an attempt's
/// result file (a Conversation's crash watch). `Released` is not an ending of the attempt at all but an
/// ending of the watching: the caller released the wait before any observation landed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneEnding {
    PaneEnd,
    ExitCode,
    PaneGone,
    Released,
}

/// A site's result validator: the parsed JSON to a valid result, or the reason it is not one (the
/// TypeScript's `ReadFailure.reason`).
pub type ResultValidator<R> = Arc<dyn Fn(&Value) -> Result<R, String> + Send + Sync>;

/// The one decision an ending produces: how it ended, the exit code (a real one, or one of the
/// engine's negative sentinels below), the site's validated result or the read failure's reason, and
/// the crash reason, `None` on a clean ending (code 0 with a valid result).
#[derive(Debug, Clone, PartialEq)]
pub struct AttemptEndingDecision<R> {
    pub ending: AttemptEnding,
    pub code: i64,
    pub result: Result<R, String>,
    pub crash_reason: Option<String>,
}

/// What [`wait_for_attempt_ending`] takes: plain fields, with no coupling to the Attempt-run module's
/// handle. `tracker` is only a fresh headless attempt's (engine shutdown stops only those, ADR-0017);
/// the shutdown-stop naming reads it after the wait resolves. `cadence` is the test override for the
/// pane race's slow paths.
pub struct AttemptEndingWait<V> {
    pub watch: AttemptWatch,
    pub exit_code_path: String,
    pub outcome_path: String,
    pub validate: V,
    pub crash_subject: String,
    pub tracker: Option<Arc<dyn AttemptHost>>,
    pub cadence: Option<EndingCadence>,
}

/// Wait for an Attempt to end, and decide how it ended.
///
/// A headless watch resolves on the child's exit and reads the result after. A pane watch races the
/// pane race against the result-file poll (a TUI deliberately stays alive after the agent declares
/// done, so a valid result ends the attempt without requiring pane exit), and the loser is dropped so
/// one attempt costs the pool no subscription and no timer once it is over. An exit-code file already
/// on disk ends it at once, without connecting at all: the boot-time adopted-attempt fast path.
/// Fails only when the headless child's log could not be written.
pub async fn wait_for_attempt_ending<R, V>(
    wait: AttemptEndingWait<V>,
) -> anyhow::Result<AttemptEndingDecision<R>>
where
    V: Fn(&Value) -> Result<R, String>,
{
    let AttemptEndingWait {
        watch,
        exit_code_path,
        outcome_path,
        validate,
        crash_subject,
        tracker,
        cadence,
    } = wait;
    let mut pane_id = None;
    let (ending, code) = match watch {
        AttemptWatch::Headless { exit } => (AttemptEnding::ChildExit, exit.await?),
        AttemptWatch::Pane {
            herdr,
            pane_id: pane,
        } => {
            let observed = tokio::select! {
                biased;
                ending = wait_for_pane_ending(&herdr, &pane, &exit_code_path, None, cadence) => {
                    Observed::Pane(ending)
                }
                () = outcome_completed(&outcome_path, &validate) => Observed::Outcome,
            };
            pane_id = Some(pane);
            // The result may have been written a moment before the ending landed; confirm before
            // reading the ending as a crash.
            if observed == Observed::Outcome
                || read_attempt_result(&outcome_path, &validate).is_ok()
            {
                (AttemptEnding::Outcome, 0)
            } else {
                match observed {
                    // A pane that left the listing has already had the race's grace window to write
                    // its file: nothing to read and nothing to wait for.
                    Observed::Pane(PaneEnding::PaneGone) => {
                        (AttemptEnding::PaneGone, EXIT_CODE_PANE_GONE)
                    }
                    // The exit-code file is written before the shell exits, so it is already there in
                    // the normal case; the retry covers a daemon that reaps the pane first.
                    Observed::Pane(PaneEnding::PaneEnd) => (
                        AttemptEnding::PaneEnd,
                        read_exit_code(&exit_code_path).await,
                    ),
                    Observed::Pane(PaneEnding::ExitCode) => (
                        AttemptEnding::ExitCode,
                        read_exit_code(&exit_code_path).await,
                    ),
                    // Unreachable: no caller release is passed to the pane race above, so it never
                    // ends released. Withdraw rather than misreport an ending.
                    Observed::Pane(PaneEnding::Released) | Observed::Outcome => {
                        return std::future::pending().await;
                    }
                }
            }
        }
    };
    let result = read_attempt_result(&outcome_path, &validate);
    let crash_reason = if code != 0 {
        let stopping = match &tracker {
            Some(tracker) if pane_id.is_none() && code > 0 => {
                on_registries(tracker.as_ref(), |_, children| children.stopping)
                    .await
                    .unwrap_or(false)
            }
            _ => false,
        };
        Some(attempt_crash_reason(
            stopping,
            code,
            &exit_code_path,
            &crash_subject,
            pane_id.as_deref(),
        ))
    } else {
        result.as_ref().err().cloned()
    };
    Ok(AttemptEndingDecision {
        ending,
        code,
        result,
        crash_reason,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Observed {
    Outcome,
    Pane(PaneEnding),
}

// ---------------------------------------------------------------------------
// The result reader
// ---------------------------------------------------------------------------

/// The one result reader (ADR-0005: the result file is the only ending signal). A missing file and an
/// unparseable one have the same two reasons everywhere; what a valid result looks like is the site's
/// validator.
pub fn read_attempt_result<R, V>(path: impl AsRef<Path>, validate: V) -> Result<R, String>
where
    V: Fn(&Value) -> Result<R, String>,
{
    let path = path.as_ref();
    if !js::exists(path) {
        return Err("no outcome written".into());
    }
    match js::read_text(path)
        .ok()
        .and_then(|text| js::parse(&text).ok())
    {
        Some(parsed) => validate(&parsed),
        None => Err("outcome is not parseable JSON".into()),
    }
}

// The result half of the pane watch's completion race: resolves once a valid result holds, polling at
// the completion cadence. Dropped with the race once the race is lost.
const ATTEMPT_COMPLETE_POLL_MS: u64 = 250;

async fn outcome_completed<R, V>(outcome_path: &str, validate: &V)
where
    V: Fn(&Value) -> Result<R, String>,
{
    loop {
        if read_attempt_result(outcome_path, validate).is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(ATTEMPT_COMPLETE_POLL_MS)).await;
    }
}

// ---------------------------------------------------------------------------
// The pane race
// ---------------------------------------------------------------------------

/// How often the engine looks at a pane's files: the follow-file tailer polls the Stream file at this
/// cadence, and the ending's watch on the exit-code file rides the same one.
pub const PANE_TAIL_POLL_MS: u64 = 250;

/// How often the wait re-checks that the pane is still in herdr's listing.
const PANE_LIVENESS_MS: u64 = 30_000;

/// How long the exit-code file gets to appear after the pane has left the listing.
const EXIT_CODE_GRACE_MS: u64 = 10_000;

/// The cadences, overridable so a test can drive the slow paths in milliseconds instead of minutes.
/// Callers in the engine pass none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndingCadence {
    pub poll_ms: u64,
    pub liveness_ms: u64,
    pub grace_ms: u64,
}

impl Default for EndingCadence {
    fn default() -> Self {
        EndingCadence {
            poll_ms: PANE_TAIL_POLL_MS,
            liveness_ms: PANE_LIVENESS_MS,
            grace_ms: EXIT_CODE_GRACE_MS,
        }
    }
}

/// The three-form pane race on its own, for the one caller that watches a pane with no result file in
/// play: a Conversation's crash watch, which also passes its own release. Every attempt-ending caller
/// goes through [`wait_for_attempt_ending`].
///
/// An exit-code file already on disk ends it at once, without connecting. Otherwise all three
/// observations run together and the first one home wins. A lost subscription is not an ending: it
/// says only that herdr has stopped talking, and the other two carry the wait from there. The wait is
/// never re-subscribed and never bounded by the clock. Whichever observations lose are dropped as the
/// wait settles (the subscription's connection closes with its future), so a pool that runs for days
/// leaks neither a subscription nor a timer per attempt. `release` is the caller's own way out.
pub async fn wait_for_pane_ending(
    herdr: &Herdr,
    pane_id: &str,
    exit_code_path: &str,
    release: Option<&CancellationToken>,
    cadence: Option<EndingCadence>,
) -> PaneEnding {
    if js::exists(exit_code_path) {
        return PaneEnding::ExitCode;
    }
    if release.is_some_and(CancellationToken::is_cancelled) {
        return PaneEnding::Released;
    }
    let cadence = cadence.unwrap_or_default();
    tokio::select! {
        ending = pane_reported_its_end(herdr, pane_id) => ending,
        ending = exit_code_file_appeared(exit_code_path, cadence) => ending,
        ending = pane_left_the_listing(herdr, pane_id, exit_code_path, cadence) => ending,
        () = caller_released(release) => PaneEnding::Released,
    }
}

// herdr's own report. Lost is the daemon going quiet, not the attempt ending, so it withdraws from the
// race rather than settling it.
async fn pane_reported_its_end(herdr: &Herdr, pane_id: &str) -> PaneEnding {
    match herdr.wait_for_pane_end(pane_id, None).await {
        PaneEnd::Lost => std::future::pending().await,
        _ => PaneEnding::PaneEnd,
    }
}

// The observation that does not depend on the daemon.
async fn exit_code_file_appeared(exit_code_path: &str, cadence: EndingCadence) -> PaneEnding {
    loop {
        tokio::time::sleep(Duration::from_millis(cadence.poll_ms)).await;
        if js::exists(exit_code_path) {
            return PaneEnding::ExitCode;
        }
    }
}

// The backstop for both of the others failing at once: a pane that has left herdr's listing without
// an event and without a file. A listing the daemon cannot answer says nothing about the pane, so the
// wait rides it out and looks again next sweep.
async fn pane_left_the_listing(
    herdr: &Herdr,
    pane_id: &str,
    exit_code_path: &str,
    cadence: EndingCadence,
) -> PaneEnding {
    loop {
        tokio::time::sleep(Duration::from_millis(cadence.liveness_ms)).await;
        let Ok(live) = herdr.list_pane_ids(None).await else {
            continue;
        };
        if live.iter().any(|id| id == pane_id) {
            continue;
        }
        let grace_ends = Instant::now() + Duration::from_millis(cadence.grace_ms);
        loop {
            if js::exists(exit_code_path) {
                return PaneEnding::ExitCode;
            }
            if Instant::now() >= grace_ends {
                return PaneEnding::PaneGone;
            }
            tokio::time::sleep(Duration::from_millis(cadence.poll_ms)).await;
        }
    }
}

async fn caller_released(release: Option<&CancellationToken>) {
    match release {
        Some(release) => release.cancelled().await,
        None => std::future::pending().await,
    }
}

// ---------------------------------------------------------------------------
// Exit codes and crash reasons
// ---------------------------------------------------------------------------

/// No exit code ever arrived: the wrapper's file was missing or unparseable after every retry. A shell
/// exit status is 0-255, so a negative never collides with a real one.
pub const EXIT_CODE_UNREADABLE: i64 = -1;

/// The pane left herdr's listing and the race's grace window passed with no file behind it.
pub const EXIT_CODE_PANE_GONE: i64 = -2;

/// The engine's own negative "exit codes" for a botched interactive spawn, produced by the Attempt-run
/// module's prompt delivery: the TUI never became ready.
pub const SPAWN_INTERACTIVE_READY_FAILED: i64 = -3;
/// The prompt never landed.
pub const SPAWN_INTERACTIVE_PROMPT_FAILED: i64 = -4;
/// The launch command itself never ran, on every try: `script` never created the Stream file after
/// the wrapper was sent (issue #102's botched launch).
pub const SPAWN_INTERACTIVE_WRAPPER_LOST: i64 = -5;

/// The crash reason for a non-zero exit, whose causes want different words. A real code came from the
/// harness; [`EXIT_CODE_UNREADABLE`] points at the pane wrapper; [`EXIT_CODE_PANE_GONE`] names the
/// pane; the botched-spawn codes are the engine's own. `pane_id` is `None` for a headless attempt.
pub fn exit_crash_reason(
    code: i64,
    exit_code_path: &str,
    subject: &str,
    pane_id: Option<&str>,
) -> String {
    match code {
        SPAWN_INTERACTIVE_READY_FAILED => "TUI never became ready".into(),
        SPAWN_INTERACTIVE_PROMPT_FAILED => "prompt never landed".into(),
        SPAWN_INTERACTIVE_WRAPPER_LOST => "launch command never ran".into(),
        EXIT_CODE_UNREADABLE => format!(
            "{subject} exit code unreadable: the pane wrapper never wrote a usable {exit_code_path}"
        ),
        EXIT_CODE_PANE_GONE => format!(
            "{subject} pane gone: {} left herdr's listing and no exit code was written to {exit_code_path}",
            pane_id.unwrap_or("the pane")
        ),
        _ => format!("{subject} exited {code}"),
    }
}

/// The crash reason for an attempt's non-zero exit, naming a shutdown stop as what it was (ADR-0017):
/// a headless child the engine stopped exits on the signal, and "exited 143" would read as the
/// harness's own failure. `stopping` is the child tracker's, read after the wait resolved.
pub fn attempt_crash_reason(
    stopping: bool,
    code: i64,
    exit_code_path: &str,
    subject: &str,
    pane_id: Option<&str>,
) -> String {
    if stopping && pane_id.is_none() && code > 0 {
        return format!("{subject} stopped by engine shutdown (exited {code})");
    }
    exit_crash_reason(code, exit_code_path, subject, pane_id)
}

/// How the pool log names the ending in passing: a real code reads as the shell's status, a sentinel
/// says what happened instead of printing a number no shell produced.
pub fn exited_phrase(code: i64) -> String {
    match code {
        EXIT_CODE_UNREADABLE => "ended with no exit code".into(),
        EXIT_CODE_PANE_GONE => "ended with its pane gone".into(),
        SPAWN_INTERACTIVE_READY_FAILED => "ended before its TUI became ready".into(),
        SPAWN_INTERACTIVE_PROMPT_FAILED => "ended before its prompt landed".into(),
        SPAWN_INTERACTIVE_WRAPPER_LOST => "ended before its launch command ran".into(),
        _ => format!("exited {code}"),
    }
}

/// `Number.parseInt(text, 10)` of an already-trimmed text, when it is finite: an optional sign and the
/// leading digits, whatever follows them.
fn parse_int(text: &str) -> Option<i64> {
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let value = digits[..end].bytes().fold(0i64, |sum, digit| {
        sum.saturating_mul(10)
            .saturating_add(i64::from(digit - b'0'))
    });
    Some(if negative { -value } else { value })
}

/// Read the wrapper-written exit code, retrying briefly for a reaping race (10 reads 200 ms apart),
/// and translating a missing or malformed file into [`EXIT_CODE_UNREADABLE`]. Also the launch half's
/// read when a harness exited before its TUI came up.
pub async fn read_exit_code(path: &str) -> i64 {
    for _ in 0..10 {
        if let Some(code) = js::read_text(path)
            .ok()
            .and_then(|text| parse_int(js::trim(&text)))
        {
            return code;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    EXIT_CODE_UNREADABLE
}

#[cfg(test)]
mod tests {
    //! engine/attempt-ending.test.ts: the ending race against a fake herdr in paused time, the hidden
    //! row attempt-ending.test.ts:269 (a caller's release settles released and drops the subscription),
    //! and the grace-window row C13 asks for (an exit-code file landing inside the grace window ends
    //! with the file's code, never as pane gone).

    use super::*;
    use std::sync::Mutex;

    use ac_io::herdr::fake::{FakeHerdr, Options, Reply, until};
    use serde_json::json;

    use crate::attempt_run::test_support::LocalHost;

    #[derive(Debug, Clone, PartialEq)]
    struct Valid(String);

    type Validator = fn(&Value) -> Result<Valid, String>;

    fn validate(parsed: &Value) -> Result<Valid, String> {
        match parsed.get("status").and_then(Value::as_str) {
            Some(status) => Ok(Valid(status.to_owned())),
            None => Err("outcome has no status".into()),
        }
    }

    struct Rig {
        _dir: tempfile::TempDir,
        exit_code: String,
        outcome: String,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let root = js::path_text(dir.path());
        Rig {
            exit_code: format!("{root}/01.exitcode"),
            outcome: format!("{root}/01.outcome.json"),
            _dir: dir,
        }
    }

    const FAST: EndingCadence = EndingCadence {
        poll_ms: 20,
        liveness_ms: 60,
        grace_ms: 200,
    };

    async fn fake_with_pane(listed: Arc<Mutex<bool>>) -> FakeHerdr {
        FakeHerdr::start(Options {
            script: Some(Arc::new(move |method: &str, _: &Value| {
                (method == "pane.list").then(|| {
                    let panes = if *listed.lock().unwrap() {
                        json!([{ "pane_id": "p1", "tab_id": "t1" }])
                    } else {
                        json!([])
                    };
                    Reply::Line(json!({ "id": "1", "result": { "panes": panes } }).to_string())
                })
            })),
            ..Options::default()
        })
        .await
    }

    fn pane_wait(
        fake: &FakeHerdr,
        rig: &Rig,
        cadence: EndingCadence,
    ) -> AttemptEndingWait<Validator> {
        AttemptEndingWait {
            watch: AttemptWatch::Pane {
                herdr: fake.herdr(),
                pane_id: "p1".into(),
            },
            exit_code_path: rig.exit_code.clone(),
            outcome_path: rig.outcome.clone(),
            validate,
            crash_subject: "harness".into(),
            tracker: None,
            cadence: Some(cadence),
        }
    }

    #[tokio::test]
    async fn ends_on_the_panes_own_end_without_waiting_on_a_file() {
        let rig = rig();
        let fake = fake_with_pane(Arc::new(Mutex::new(true))).await;
        let herdr = fake.herdr();
        let waiting = tokio::spawn({
            let exit_code = rig.exit_code.clone();
            async move { wait_for_pane_ending(&herdr, "p1", &exit_code, None, None).await }
        });
        until("a subscriber", || fake.subscribers() == 1).await;
        fake.push_event("pane_exited", json!({ "pane_id": "p1" }));
        assert_eq!(waiting.await.unwrap(), PaneEnding::PaneEnd);
        until("the subscription let go", || fake.subscribers() == 0).await;
    }

    #[tokio::test]
    async fn ends_on_the_exit_code_file_while_the_subscription_is_silent() {
        let rig = rig();
        let fake = fake_with_pane(Arc::new(Mutex::new(true))).await;
        let herdr = fake.herdr();
        let waiting = tokio::spawn({
            let exit_code = rig.exit_code.clone();
            async move { wait_for_pane_ending(&herdr, "p1", &exit_code, None, Some(FAST)).await }
        });
        until("a subscriber", || fake.subscribers() == 1).await;
        std::fs::write(&rig.exit_code, "3\n").unwrap();
        assert_eq!(waiting.await.unwrap(), PaneEnding::ExitCode);
        until("the subscription let go", || fake.subscribers() == 0).await;
    }

    #[tokio::test]
    async fn ends_on_the_file_after_the_daemon_hangs_up_on_the_subscriber() {
        let rig = rig();
        let fake = fake_with_pane(Arc::new(Mutex::new(true))).await;
        let herdr = fake.herdr();
        let waiting = tokio::spawn({
            let exit_code = rig.exit_code.clone();
            async move { wait_for_pane_ending(&herdr, "p1", &exit_code, None, Some(FAST)).await }
        });
        until("a subscriber", || fake.subscribers() == 1).await;
        fake.drop_subscribers();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !waiting.is_finished(),
            "a lost subscription is not an ending"
        );
        std::fs::write(&rig.exit_code, "0").unwrap();
        assert_eq!(waiting.await.unwrap(), PaneEnding::ExitCode);
    }

    #[tokio::test]
    async fn ends_as_pane_gone_when_the_pane_leaves_the_listing_and_no_file_follows() {
        let rig = rig();
        let listed = Arc::new(Mutex::new(true));
        let fake = fake_with_pane(Arc::clone(&listed)).await;
        let herdr = fake.herdr();
        let waiting = tokio::spawn({
            let exit_code = rig.exit_code.clone();
            async move { wait_for_pane_ending(&herdr, "p1", &exit_code, None, Some(FAST)).await }
        });
        until("a subscriber", || fake.subscribers() == 1).await;
        fake.drop_subscribers();
        // Several sweeps with the pane still listed change nothing.
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(!waiting.is_finished());
        *listed.lock().unwrap() = false;
        assert_eq!(waiting.await.unwrap(), PaneEnding::PaneGone);
    }

    #[tokio::test]
    async fn an_exit_code_file_inside_the_grace_window_ends_with_its_code_never_pane_gone() {
        let rig = rig();
        let listed = Arc::new(Mutex::new(true));
        let fake = fake_with_pane(Arc::clone(&listed)).await;
        let wait = pane_wait(
            &fake,
            &rig,
            EndingCadence {
                poll_ms: 20,
                liveness_ms: 50,
                grace_ms: 1_000,
            },
        );
        let waiting = tokio::spawn(wait_for_attempt_ending(wait));
        until("a subscriber", || fake.subscribers() == 1).await;
        // The acknowledgement's own listing check, with the pane still listed.
        until("the acknowledgement's listing", || {
            fake.methods().iter().any(|m| m == "pane.list")
        })
        .await;
        fake.drop_subscribers();
        until("the subscription dropped", || fake.subscribers() == 0).await;
        *listed.lock().unwrap() = false;
        // The sweep finds the pane gone; the file lands inside the grace window.
        let listings = fake.methods().iter().filter(|m| *m == "pane.list").count();
        until("a sweep with the pane gone", || {
            fake.methods().iter().filter(|m| *m == "pane.list").count() > listings
        })
        .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        std::fs::write(&rig.exit_code, "7\n").unwrap();
        let decision = waiting.await.unwrap().unwrap();
        assert_eq!(decision.ending, AttemptEnding::ExitCode);
        assert_eq!(decision.code, 7);
        assert_eq!(decision.crash_reason.as_deref(), Some("harness exited 7"));
    }

    #[tokio::test]
    async fn a_daemon_that_cannot_list_is_ridden_out() {
        let rig = rig();
        let fake = FakeHerdr::start(Options {
            script: Some(Arc::new(|method: &str, _: &Value| {
                (method == "pane.list").then(|| Reply::Line("not json".into()))
            })),
            ..Options::default()
        })
        .await;
        let herdr = fake.herdr();
        let waiting = tokio::spawn({
            let exit_code = rig.exit_code.clone();
            async move { wait_for_pane_ending(&herdr, "p1", &exit_code, None, Some(FAST)).await }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiting.is_finished());
        std::fs::write(&rig.exit_code, "0").unwrap();
        assert_eq!(waiting.await.unwrap(), PaneEnding::ExitCode);
    }

    #[tokio::test]
    async fn ends_at_once_on_a_file_already_there_without_connecting() {
        let rig = rig();
        let fake = fake_with_pane(Arc::new(Mutex::new(true))).await;
        std::fs::write(&rig.exit_code, "0").unwrap();
        let ending = wait_for_pane_ending(&fake.herdr(), "p1", &rig.exit_code, None, None).await;
        assert_eq!(ending, PaneEnding::ExitCode);
        assert_eq!(fake.connections(), 0);
    }

    #[tokio::test]
    async fn a_callers_release_settles_released_and_drops_the_subscription() {
        let rig = rig();
        let fake = fake_with_pane(Arc::new(Mutex::new(true))).await;
        let herdr = fake.herdr();
        let release = CancellationToken::new();
        let waiting = tokio::spawn({
            let exit_code = rig.exit_code.clone();
            let release = release.clone();
            async move { wait_for_pane_ending(&herdr, "p1", &exit_code, Some(&release), None).await }
        });
        until("a subscriber", || fake.subscribers() == 1).await;
        release.cancel();
        assert_eq!(waiting.await.unwrap(), PaneEnding::Released);
        until("the subscription let go", || fake.subscribers() == 0).await;
        // A release given before the wait starts settles without connecting.
        let connections = fake.connections();
        let ending =
            wait_for_pane_ending(&fake.herdr(), "p1", &rig.exit_code, Some(&release), None).await;
        assert_eq!(ending, PaneEnding::Released);
        assert_eq!(fake.connections(), connections);
    }

    #[tokio::test]
    async fn a_valid_outcome_ends_the_pane_watch_with_the_pane_left_alive() {
        let rig = rig();
        let fake = fake_with_pane(Arc::new(Mutex::new(true))).await;
        let waiting = tokio::spawn(wait_for_attempt_ending(pane_wait(&fake, &rig, FAST)));
        until("a subscriber", || fake.subscribers() == 1).await;
        std::fs::write(&rig.outcome, r#"{"status":"done"}"#).unwrap();
        let decision = waiting.await.unwrap().unwrap();
        assert_eq!(decision.ending, AttemptEnding::Outcome);
        assert_eq!(decision.code, 0);
        assert_eq!(decision.result, Ok(Valid("done".into())));
        assert_eq!(decision.crash_reason, None);
        until("the subscription let go", || fake.subscribers() == 0).await;
    }

    #[tokio::test]
    async fn a_pane_end_with_no_file_reads_as_exit_code_unreadable() {
        let rig = rig();
        let fake = fake_with_pane(Arc::new(Mutex::new(true))).await;
        let waiting = tokio::spawn(wait_for_attempt_ending(pane_wait(&fake, &rig, FAST)));
        until("a subscriber", || fake.subscribers() == 1).await;
        fake.push_event("pane_closed", json!({ "pane_id": "p1" }));
        let decision = waiting.await.unwrap().unwrap();
        assert_eq!(decision.ending, AttemptEnding::PaneEnd);
        assert_eq!(decision.code, EXIT_CODE_UNREADABLE);
        assert_eq!(
            decision.crash_reason.unwrap(),
            format!(
                "harness exit code unreadable: the pane wrapper never wrote a usable {}",
                rig.exit_code
            )
        );
    }

    fn headless(code: i64) -> AttemptWatch {
        AttemptWatch::Headless {
            exit: Box::pin(async move { Ok(code) }),
        }
    }

    fn headless_wait(
        rig: &Rig,
        code: i64,
        tracker: Option<Arc<dyn AttemptHost>>,
    ) -> AttemptEndingWait<Validator> {
        AttemptEndingWait {
            watch: headless(code),
            exit_code_path: rig.exit_code.clone(),
            outcome_path: rig.outcome.clone(),
            validate,
            crash_subject: "harness".into(),
            tracker,
            cadence: None,
        }
    }

    #[tokio::test]
    async fn a_headless_watch_ends_on_the_childs_exit_and_reads_the_result_after() {
        let rig = rig();
        std::fs::write(&rig.outcome, r#"{"status":"done"}"#).unwrap();
        let decision = wait_for_attempt_ending(headless_wait(&rig, 0, None))
            .await
            .unwrap();
        assert_eq!(decision.ending, AttemptEnding::ChildExit);
        assert_eq!(decision.result, Ok(Valid("done".into())));
        assert_eq!(decision.crash_reason, None);

        let decision = wait_for_attempt_ending(headless_wait(&rig, 3, None))
            .await
            .unwrap();
        assert_eq!(decision.code, 3);
        assert_eq!(decision.crash_reason.as_deref(), Some("harness exited 3"));

        std::fs::remove_file(&rig.outcome).unwrap();
        let decision = wait_for_attempt_ending(headless_wait(&rig, 0, None))
            .await
            .unwrap();
        assert_eq!(decision.crash_reason.as_deref(), Some("no outcome written"));
    }

    #[tokio::test]
    async fn names_a_shutdown_stop_as_what_it_was() {
        let rig = rig();
        let host = Arc::new(LocalHost::default());
        host.children(|children| children.stopping = true);
        let tracker: Arc<dyn AttemptHost> = host;
        let decision = wait_for_attempt_ending(headless_wait(&rig, 143, Some(tracker)))
            .await
            .unwrap();
        assert_eq!(
            decision.crash_reason.as_deref(),
            Some("harness stopped by engine shutdown (exited 143)")
        );
    }

    #[tokio::test]
    async fn the_boot_fast_path_decides_on_files_already_on_disk() {
        let rig = rig();
        let fake = fake_with_pane(Arc::new(Mutex::new(true))).await;
        std::fs::write(&rig.exit_code, "0\n").unwrap();
        let decision = wait_for_attempt_ending(pane_wait(&fake, &rig, FAST))
            .await
            .unwrap();
        assert_eq!(decision.ending, AttemptEnding::ExitCode);
        assert_eq!(decision.crash_reason.as_deref(), Some("no outcome written"));
        assert_eq!(fake.connections(), 0);
        std::fs::write(&rig.outcome, r#"{"status":"done"}"#).unwrap();
        let decision = wait_for_attempt_ending(pane_wait(&fake, &rig, FAST))
            .await
            .unwrap();
        assert_eq!(decision.ending, AttemptEnding::Outcome);
        assert_eq!(decision.crash_reason, None);
    }

    #[test]
    fn the_result_reader_shares_its_preamble_then_defers_to_the_validator() {
        let rig = rig();
        assert_eq!(
            read_attempt_result(&rig.outcome, validate),
            Err("no outcome written".into())
        );
        std::fs::write(&rig.outcome, "{not json").unwrap();
        assert_eq!(
            read_attempt_result(&rig.outcome, validate),
            Err("outcome is not parseable JSON".into())
        );
        std::fs::write(&rig.outcome, "{}").unwrap();
        assert_eq!(
            read_attempt_result(&rig.outcome, validate),
            Err("outcome has no status".into())
        );
        std::fs::write(&rig.outcome, r#"{"status":"x"}"#).unwrap();
        assert_eq!(
            read_attempt_result(&rig.outcome, validate),
            Ok(Valid("x".into()))
        );
    }

    #[test]
    fn crash_reasons_and_phrases_name_each_ending() {
        assert_eq!(
            exit_crash_reason(3, "/r/01.exitcode", "harness", None),
            "harness exited 3"
        );
        assert_eq!(
            exit_crash_reason(3, "/r/01.exitcode", "resolver", None),
            "resolver exited 3"
        );
        assert_eq!(
            exit_crash_reason(
                EXIT_CODE_UNREADABLE,
                "/r/01.exitcode",
                "harness",
                Some("p1")
            ),
            "harness exit code unreadable: the pane wrapper never wrote a usable /r/01.exitcode"
        );
        assert_eq!(
            exit_crash_reason(EXIT_CODE_PANE_GONE, "/r/01.exitcode", "harness", Some("p1")),
            "harness pane gone: p1 left herdr's listing and no exit code was written to /r/01.exitcode"
        );
        assert_eq!(
            exit_crash_reason(EXIT_CODE_PANE_GONE, "/r/x", "harness", None),
            "harness pane gone: the pane left herdr's listing and no exit code was written to /r/x"
        );
        assert_eq!(
            exit_crash_reason(-3, "", "harness", None),
            "TUI never became ready"
        );
        assert_eq!(
            exit_crash_reason(-4, "", "harness", None),
            "prompt never landed"
        );
        assert_eq!(
            exit_crash_reason(-5, "", "harness", None),
            "launch command never ran"
        );
        assert_eq!(exited_phrase(3), "exited 3");
        assert_eq!(exited_phrase(-1), "ended with no exit code");
        assert_eq!(exited_phrase(-2), "ended with its pane gone");
        assert_eq!(exited_phrase(-3), "ended before its TUI became ready");
        assert_eq!(exited_phrase(-4), "ended before its prompt landed");
        assert_eq!(exited_phrase(-5), "ended before its launch command ran");
        // A shutdown stop only names a headless child's real code.
        assert_eq!(
            attempt_crash_reason(true, 143, "", "harness", Some("p1")),
            "harness exited 143"
        );
        assert_eq!(
            attempt_crash_reason(true, -1, "x", "harness", None),
            exit_crash_reason(-1, "x", "harness", None)
        );
    }

    #[test]
    fn parse_int_reads_like_javascript() {
        assert_eq!(parse_int("3"), Some(3));
        assert_eq!(parse_int("143"), Some(143));
        assert_eq!(parse_int("-2"), Some(-2));
        assert_eq!(parse_int("+5"), Some(5));
        assert_eq!(parse_int("7abc"), Some(7));
        assert_eq!(parse_int("0x10"), Some(0));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int(""), None);
        assert_eq!(parse_int("-"), None);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unreadable_exit_code_file_is_retried_then_read_as_unreadable() {
        let rig = rig();
        std::fs::write(&rig.exit_code, "garbage").unwrap();
        assert_eq!(read_exit_code(&rig.exit_code).await, EXIT_CODE_UNREADABLE);
        std::fs::write(&rig.exit_code, " 12 \n").unwrap();
        assert_eq!(read_exit_code(&rig.exit_code).await, 12);
    }
}
