//! Continued attempts (issue #139, CONTEXT.md "Continued attempt"; engine/continued.ts): the runtime
//! half of Keep talking. Where the engine's one-shot claim ([`crate::keep_talking::keep_talking`])
//! answers the checkpoint Interrupt, numbers the Attempt and records its `spawned` event, this module
//! owns what lives on in the Held pane: the derived log, the operator's focus, the one teaching Turn
//! and the watch for the ending.
//!
//! A Continued attempt launches nothing. The harness is the checkpointed Attempt's TUI, still running
//! under that attempt's wrapper, so there is no wrapper of its own, no exit-code file of its own and no
//! Stream file of its own: `script` keeps writing the Stream file of the attempt it continues. That
//! shapes the three jobs here.
//!
//! - The log: the pane's Stream file is tailed from where it stood when the Continued attempt began, so
//!   its log is its own part of the session.
//! - The teaching Turn: the agent was told where its Outcome went, and that Outcome is written; it has
//!   to be told a fresh one is expected. The Turn is typed once the pane is waiting, never mid-reply,
//!   exactly as an enlist's is, bounded the same way; a pane that will not take it ends the attempt
//!   untaught, since an agent that does not know it owes an Outcome would leave the ticket running
//!   forever.
//! - The ending: a valid Outcome on disk, raced against two ways the agent can be gone without one. The
//!   TUI can exit while its pane stays open (the wrapper is typed into the pane's own shell, which
//!   outlives it), so the wrapper's exit-code file landing is one; the pane leaving herdr's listing is
//!   the other.
//!
//! The engine records whatever ending this reports; nothing here writes pool state.

use std::time::Duration;

use tokio::sync::oneshot;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use ac_core::harness::{harness_descriptor, idle_pattern_for};
use ac_core::js;
use ac_core::turn_state::{FRESH_TURN, IDLE_STABLE_READS, TurnState, next_turn_state};
use ac_io::herdr::{Herdr, PaneReadSource};
use ac_protocol::TurnSide;

use crate::attempt_run::start_pane_stream_tail;
use crate::pane_session::{READINESS_TIMEOUT_MS, type_verified};

const CONTINUED_POLL_MS: u64 = 2_000;

/// How a Continued attempt ended: its Outcome landed, its pane went with none behind it, or the
/// teaching Turn could not be typed (with why). `Released` is the engine letting go first (an abandoned
/// adoption, a shutdown), which is no ending at all and records nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContinuedEnding {
    Outcome,
    Exited,
    PaneGone,
    Untaught { reason: String },
    Released,
}

/// The pool facts a Continued attempt's runtime runs against.
#[derive(Debug, Clone)]
pub struct ContinuedEnv {
    pub herdr_socket: String,
    /// How often the Turn wait and the ending race re-read; 2 s unless a test shortens it.
    pub poll: Option<Duration>,
    /// How long the teaching Turn waits for a working pane; a Launch's bound unless a test shortens it.
    pub teaching_wait: Option<Duration>,
}

/// Told whether the message landed: `None` once it is in, or why not. The Attempt carries on either
/// way, since the agent was taught.
pub type OnMessage = Box<dyn Fn(Option<String>) + Send + Sync>;

/// What one Continued attempt's runtime watches.
pub struct ContinuedInput {
    pub pane_id: String,
    /// The harness the pane runs, for its Turn-state and echo patterns.
    pub harness: String,
    /// The teaching Turn; `None` for a pane re-adopted at boot, taught before the restart.
    pub teaching: Option<String>,
    /// A Turn typed after the teaching, once the pane is waiting again: the Steward's coaching message
    /// when the Steward chose Keep talking (ADR-0030).
    pub message: Option<String>,
    pub on_message: Option<OnMessage>,
    /// Whether to bring the pane forward in the operator's herdr first.
    pub focus: bool,
    /// Where the agent writes this attempt's Outcome; the ending race reads it.
    pub outcome_path: String,
    /// The wrapper's exit-code file, whose landing says the TUI exited; `None` for an enlisted pane,
    /// which has no wrapper.
    pub exit_code_path: Option<String>,
    /// The Stream file the pane's `script` writes, and where it stood at the start.
    pub stream_path: Option<String>,
    pub stream_offset: u64,
    /// This attempt's derived log.
    pub log_path: String,
}

/// A running Continued attempt: its ending arrives once on `ending` (never fails, the derived log
/// drained first), and `release` lets the pane go without one.
pub struct ContinuedRun {
    pub ending: oneshot::Receiver<ContinuedEnding>,
    pub release: ContinuedRelease,
}

/// The handle that lets a Continued attempt's pane go: the watch and the tail stop.
#[derive(Debug, Clone)]
pub struct ContinuedRelease(CancellationToken);

impl ContinuedRelease {
    pub fn release(&self) {
        self.0.cancel();
    }
}

/// `runContinued`: start a Continued attempt's runtime in its Held pane.
pub fn run_continued(env: ContinuedEnv, input: ContinuedInput) -> ContinuedRun {
    let poll = env.poll.unwrap_or(Duration::from_millis(CONTINUED_POLL_MS));
    let teaching_wait = env
        .teaching_wait
        .unwrap_or(Duration::from_millis(READINESS_TIMEOUT_MS));
    let released = CancellationToken::new();
    let herdr = Herdr::new(&env.herdr_socket);
    let tailer = input
        .stream_path
        .as_deref()
        .map(|stream| start_pane_stream_tail(stream, &input.log_path, input.stream_offset));
    let (ending_tx, ending) = oneshot::channel();
    let signal = released.clone();
    tokio::spawn(async move {
        let result = tokio::select! {
            result = watch(&herdr, &input, &signal, poll, teaching_wait) => result,
            () = signal.cancelled() => ContinuedEnding::Released,
        };
        if let Some(tailer) = tailer {
            let _ = tailer.finish().await;
        }
        let _ = ending_tx.send(if signal.is_cancelled() {
            ContinuedEnding::Released
        } else {
            result
        });
    });
    ContinuedRun {
        ending,
        release: ContinuedRelease(released),
    }
}

async fn watch(
    herdr: &Herdr,
    input: &ContinuedInput,
    signal: &CancellationToken,
    poll: Duration,
    teaching_wait: Duration,
) -> ContinuedEnding {
    // The operator chose to talk: the pane comes forward the moment the attempt is theirs.
    // Best-effort, as every focus is.
    if input.focus {
        let _ = herdr.focus_pane(&input.pane_id).await;
    }
    if let Some(teaching) = &input.teaching {
        if let Some(reason) = teach(herdr, input, teaching, poll, teaching_wait, signal).await {
            return ContinuedEnding::Untaught { reason };
        }
        if let Some(message) = &input.message {
            // The same wait as the teaching's: the agent answers the teaching first, and a Turn typed
            // mid-reply would land in its work.
            let said = teach(herdr, input, message, poll, teaching_wait, signal).await;
            if let Some(on_message) = &input.on_message {
                on_message(said);
            }
        }
    }
    wait_for_continued_ending(herdr, input, signal, poll).await
}

/// The ending race: the Outcome first each sweep, so an Outcome that landed just before the TUI exited
/// or the pane went still reads as the Outcome; then the exit-code file; then the pane's presence in
/// herdr's listing, a listing the daemon cannot answer saying nothing about the pane. Released, it never
/// resolves (the caller's release wins the race above it).
async fn wait_for_continued_ending(
    herdr: &Herdr,
    input: &ContinuedInput,
    signal: &CancellationToken,
    poll: Duration,
) -> ContinuedEnding {
    loop {
        if outcome_is_on_disk(&input.outcome_path) {
            return ContinuedEnding::Outcome;
        }
        if exit_code_landed(input) {
            return ContinuedEnding::Exited;
        }
        if signal.is_cancelled() {
            return std::future::pending().await;
        }
        tokio::time::sleep(poll).await;
        if signal.is_cancelled() {
            return std::future::pending().await;
        }
        let live = herdr.list_pane_ids(None).await.ok();
        if let Some(live) = live
            && !live.contains(&input.pane_id)
        {
            // One more look before calling it gone: the Outcome or the exit code may have landed
            // between the sweep and the listing.
            if outcome_is_on_disk(&input.outcome_path) {
                return ContinuedEnding::Outcome;
            }
            if exit_code_landed(input) {
                return ContinuedEnding::Exited;
            }
            return ContinuedEnding::PaneGone;
        }
    }
}

fn exit_code_landed(input: &ContinuedInput) -> bool {
    input.exit_code_path.as_deref().is_some_and(js::exists)
}

/// A complete Outcome on disk: a file that does not parse yet is a write in flight.
fn outcome_is_on_disk(path: &str) -> bool {
    js::exists(path)
        && js::read_text(path)
            .ok()
            .is_some_and(|text| js::parse(&text).is_ok())
}

/// Type one Turn (the teaching, or the message after it) once the pane is waiting on the operator: one
/// read establishes the transcript, [`IDLE_STABLE_READS`] more with the idle pattern present settle it
/// as waiting (turn-state's rule, as an enlist settles it), and a pane still working is re-read every
/// poll up to the bound. `None` once the Turn is in, or why it is not. A custom harness has no idle
/// pattern to wait on, so its Turn is typed at once and verified on its own text.
async fn teach(
    herdr: &Herdr,
    input: &ContinuedInput,
    turn_text: &str,
    poll: Duration,
    wait: Duration,
    signal: &CancellationToken,
) -> Option<String> {
    let descriptor = harness_descriptor(&js::trim(&input.harness).to_lowercase());
    if let Some(descriptor) = descriptor {
        let idle = idle_pattern_for(descriptor);
        let mut turn = FRESH_TURN;
        let read = |turn: &TurnState| {
            let herdr = herdr.clone();
            let pane = input.pane_id.clone();
            let current = turn.clone();
            async move {
                herdr
                    .peek_pane(&pane, PaneReadSource::Visible)
                    .await
                    .map(|text| next_turn_state(&current, &text, idle, &js::now_iso()).turn)
            }
        };
        let mut reads = 0;
        while reads <= IDLE_STABLE_READS && turn.state != TurnSide::Waiting {
            match read(&turn).await {
                Ok(next) => turn = next,
                Err(err) => return Some(unreadable(&err.to_string())),
            }
            reads += 1;
        }
        let deadline = Instant::now() + wait;
        while turn.state != TurnSide::Waiting {
            if signal.is_cancelled() {
                return Some("released".to_owned());
            }
            if Instant::now() >= deadline {
                return Some(format!(
                    "the pane was still working after {} s",
                    js_round(wait.as_secs_f64())
                ));
            }
            tokio::time::sleep(poll).await;
            match read(&turn).await {
                Ok(next) => turn = next,
                Err(err) => return Some(unreadable(&err.to_string())),
            }
        }
    }
    let mut echo_targets: Vec<String> = Vec::new();
    if let Some(pattern) = descriptor.and_then(|d| d.echo_pattern) {
        echo_targets.push(pattern.to_owned());
    }
    if !turn_text.is_empty() {
        echo_targets.push(turn_text.to_owned());
    }
    let clear_keys: Vec<String> = descriptor
        .map(|d| d.clear_keys.iter().map(|k| (*k).to_owned()).collect())
        .unwrap_or_default();
    let delivered = type_verified(herdr, &input.pane_id, turn_text, &echo_targets, &clear_keys)
        .await
        .unwrap_or(false);
    if delivered {
        None
    } else {
        Some("the Turn could not be delivered".to_owned())
    }
}

fn unreadable(why: &str) -> String {
    format!("the pane could not be read ({why})")
}

// `Math.round(ms / 1000)` of the wait, as the TypeScript words it.
fn js_round(seconds: f64) -> String {
    js::number_string((seconds + 0.5).floor())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wait_is_worded_in_whole_seconds() {
        assert_eq!(js_round(60.0), "60");
        assert_eq!(js_round(0.4), "0");
        assert_eq!(js_round(2.5), "3");
    }

    #[tokio::test]
    async fn an_outcome_on_disk_ends_the_attempt_and_a_half_written_one_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = dir.path().join("o.json");
        assert!(!outcome_is_on_disk(outcome.to_str().unwrap()));
        std::fs::write(&outcome, "{\"status\": \"do").unwrap();
        assert!(!outcome_is_on_disk(outcome.to_str().unwrap()));
        std::fs::write(&outcome, "{\"status\":\"done\"}").unwrap();
        assert!(outcome_is_on_disk(outcome.to_str().unwrap()));
    }

    #[tokio::test]
    async fn a_released_run_reports_released_and_no_other_ending() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_continued(
            ContinuedEnv {
                herdr_socket: dir.path().join("none.sock").to_string_lossy().into_owned(),
                poll: Some(Duration::from_millis(5)),
                teaching_wait: None,
            },
            ContinuedInput {
                pane_id: "p1".into(),
                harness: "claude".into(),
                teaching: None,
                message: None,
                on_message: None,
                focus: false,
                outcome_path: dir.path().join("o.json").to_string_lossy().into_owned(),
                exit_code_path: None,
                stream_path: None,
                stream_offset: 0,
                log_path: dir.path().join("l.log").to_string_lossy().into_owned(),
            },
        );
        run.release.release();
        assert_eq!(run.ending.await.unwrap(), ContinuedEnding::Released);
    }
}
