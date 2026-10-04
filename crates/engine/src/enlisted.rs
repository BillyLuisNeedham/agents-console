//! Enlisted attempts (issue #101, enlisted.ts): the runtime half of enlisting a live herdr pane the
//! operator opened as a Pool Ticket. Where the one-shot enlist ([`crate::enlist_flow`]) resolves the
//! pane, applies the branch rule and writes the pool, this module owns what lives on: the pane, its
//! tab, the Agent identity claim, the Turn state read from the pane, and the Turns the engine has to
//! type into it.
//!
//! A spawned terminal attempt gets its pane, its agent report and its prompt from the Attempt-run
//! module; an enlisted one has all three already (ADR-0014, ADR-0015). So registration here takes the
//! found pane and does the claim: report the agent identity, relabel the operator's tab to the attempt
//! label, and type the teaching Turn. Turn state is read from the pane as it is for a Conversation
//! (turn_state); the teaching Turn is typed only while the pane is waiting and queued while it is
//! working, so it never lands mid-reply.
//!
//! There is no wrapper, so there is no exit-code file and no Stream file: the Attempt ending is raced
//! between two observations (spec "Attempt ending for an enlisted Ticket"), a valid Outcome appearing
//! on disk and the pane leaving herdr's listing. The watch reports the ending to the engine, which owns
//! the record; a pane that goes after the Outcome is a trailing exit and changes nothing about the
//! ticket. [`wait_for_enlisted_ending`] is public so boot re-adoption, which has no runtime here,
//! waits the same way.
//!
//! The tick reads the pane's viewport and nothing above it (issue #122): the operator sits in an
//! enlisted pane, and a scrollback read moves their viewport. Each read is recorded in the pane read
//! register so the Console's card Peek is served from it; the entry goes when the tick stops.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use ac_core::harness::{HarnessDescriptor, harness_descriptor, idle_pattern_for};
use ac_core::js;
use ac_core::turn_state::{FRESH_TURN, IDLE_STABLE_READS, TurnState, next_turn_state};
use ac_io::herdr::{Herdr, PaneAgentState, PaneReadSource, attempt_tab_label};
use ac_protocol::TurnSide;

use crate::actor::Engine;
use crate::pane_session::{READINESS_TIMEOUT_MS, still_working_reason, type_verified};

/// How often an enlisted attempt re-reads its pane, unless a test shortens it.
pub const ENLISTED_POLL_MS: u64 = 2_000;

/// How an enlisted attempt ended. There is no wrapper and so no exit-code file: the Outcome landing is
/// `Outcome`, and the pane leaving herdr's listing with no Outcome behind it is `PaneGone`. A pane that
/// goes after the Outcome is a trailing exit, not an ending: the attempt already ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnlistedEnding {
    Outcome,
    PaneGone,
}

/// Whether a complete Outcome is on disk. A file that exists but is not yet parseable JSON is a write
/// in flight, not an ending, so the wait keeps polling; the engine's own validator decides the shape
/// afterwards.
fn outcome_is_on_disk(path: &str) -> bool {
    if !js::exists(path) {
        return false;
    }
    js::read_text(path)
        .ok()
        .is_some_and(|text| js::parse(&text).is_ok())
}

/// A pane listing, or `None` when the daemon could not answer this sweep.
async fn live_pane_ids(herdr: &Herdr) -> Option<Vec<String>> {
    herdr.list_pane_ids(None).await.ok()
}

/// A sleep that ends early when `signal` fires.
async fn sleep_abortable(ms: u64, signal: &CancellationToken) {
    tokio::select! {
        () = tokio::time::sleep(Duration::from_millis(ms)) => {}
        () = signal.cancelled() => {}
    }
}

/// `waitForEnlistedEnding`: wait for an enlisted attempt's ending: an Outcome on disk, or the pane
/// leaving herdr's listing, whichever the poll sees first. The Outcome check comes first each sweep, so
/// an Outcome that landed just before the pane went still reads as `Outcome`. A daemon the listing
/// cannot answer says nothing about the pane, so that sweep is skipped rather than read as a gone pane.
/// `None` when the wait was aborted: there is no ending to report.
pub async fn wait_for_enlisted_ending(
    herdr: &Herdr,
    pane_id: &str,
    outcome_path: &str,
    signal: &CancellationToken,
    poll_ms: u64,
) -> Option<EnlistedEnding> {
    loop {
        if outcome_is_on_disk(outcome_path) {
            return Some(EnlistedEnding::Outcome);
        }
        if signal.is_cancelled() {
            return None;
        }
        sleep_abortable(poll_ms, signal).await;
        if signal.is_cancelled() {
            return None;
        }
        let live = live_pane_ids(herdr).await;
        if signal.is_cancelled() {
            return None;
        }
        if let Some(live) = live
            && !live.iter().any(|id| id == pane_id)
        {
            return Some(EnlistedEnding::PaneGone);
        }
    }
}

/// What a registration needs (`RegisterEnlistedInput`).
#[derive(Debug, Clone)]
pub struct RegisterEnlisted {
    pub id: String,
    pub pane_id: String,
    pub tab_id: Option<String>,
    /// herdr's agent label: the harness the pane is running.
    pub harness: String,
    pub title: String,
    pub branch: String,
    pub directory: String,
    /// Where the agent writes its Outcome; the ending watch reads it.
    pub outcome_path: String,
    /// The teaching Turn to type once the pane is waiting: the claim waits for a working pane, bounded
    /// by the teaching wait, and refuses when the bound expires. `None` for a pane taught before a
    /// restart (boot re-adoption), which registers the tick and the ending watch and types nothing.
    pub teaching: Option<String>,
}

// What the tick, the claim and the delivery share.
struct RuntimeState {
    turn: TurnState,
    queued: Vec<String>,
}

/// One enlisted pane's runtime.
pub struct EnlistedRuntime {
    id: String,
    pane_id: String,
    harness: String,
    label: String,
    descriptor: &'static HarnessDescriptor,
    herdr: Herdr,
    engine: Engine,
    state: Mutex<RuntimeState>,
    /// Fires when the runtime is released: the ending watch and the claim's waits stop.
    release: CancellationToken,
    /// Fires when the Turn tick stops (the attempt is over, or the runtime is released).
    tick: CancellationToken,
}

impl std::fmt::Debug for EnlistedRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnlistedRuntime")
            .field("id", &self.id)
            .field("pane_id", &self.pane_id)
            .finish()
    }
}

/// The enlisted runtimes of one pool.
#[derive(Debug, Default)]
pub struct EnlistedAttempts {
    runtimes: HashMap<String, Arc<EnlistedRuntime>>,
}

impl EnlistedAttempts {
    /// `release`: stop the tick and drop the runtime (the agent identity is the caller's).
    pub fn release(&mut self, id: &str) -> Option<Arc<EnlistedRuntime>> {
        let runtime = self.runtimes.remove(id)?;
        runtime.tick.cancel();
        runtime.release.cancel();
        Some(runtime)
    }

    /// `dispose`: stop every enlisted loop this process runs; the panes are the operator's and stay.
    pub fn dispose(&mut self) {
        for runtime in self.runtimes.values() {
            runtime.tick.cancel();
            runtime.release.cancel();
        }
    }
}

impl EnlistedRuntime {
    fn lock(&self) -> std::sync::MutexGuard<'_, RuntimeState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn report_state(&self, state: PaneAgentState) {
        let herdr = self.herdr.clone();
        let (pane, harness, label) = (
            self.pane_id.clone(),
            self.harness.to_lowercase(),
            self.label.clone(),
        );
        tokio::spawn(async move {
            let _ = herdr
                .report_pane_agent(&pane, &harness, state, &label)
                .await;
        });
    }

    fn release_agent(&self) {
        let herdr = self.herdr.clone();
        let (pane, harness) = (self.pane_id.clone(), self.harness.to_lowercase());
        tokio::spawn(async move {
            let _ = herdr.release_pane_agent(&pane, &harness).await;
        });
    }

    /// `readTurn`: one Turn-state read from the pane; a failed read leaves the state as it was. The read
    /// is of the viewport only (`visible`): Turn state needs no more than the prompt area at the
    /// bottom, and a scrollback read moves the operator's viewport (issue #122). What was read is
    /// recorded for the card Peek, so this is the one read of the pane per tick.
    async fn read_turn(&self) -> Result<(), String> {
        let text = self
            .herdr
            .peek_pane(&self.pane_id, PaneReadSource::Visible)
            .await
            .map_err(|error| error.to_string())?;
        let at = js::now_iso();
        let (pane, recorded, stamp) = (self.pane_id.clone(), text.clone(), at.clone());
        let _ = self
            .engine
            .call(move |s| s.pane_reads.record(&pane, recorded, stamp))
            .await;
        let (flipped, publish, waiting) = {
            let mut state = self.lock();
            let transition =
                next_turn_state(&state.turn, &text, idle_pattern_for(self.descriptor), &at);
            let flipped = state.turn.state != transition.turn.state;
            let waiting = transition.turn.state == TurnSide::Waiting;
            state.turn = transition.turn;
            (flipped, transition.publish, waiting)
        };
        if publish {
            let _ = self
                .engine
                .call(|s| {
                    let phase = s.idle_phase();
                    crate::snapshot::emit_snapshot(s, phase);
                })
                .await;
        }
        if flipped {
            self.report_state(if waiting {
                PaneAgentState::Blocked
            } else {
                PaneAgentState::Working
            });
        }
        Ok(())
    }

    fn is_waiting(&self) -> bool {
        self.lock().turn.state == TurnSide::Waiting
    }

    /// `deliver`: type every queued Turn into the pane, in order. Claims the whole queue up front so a
    /// tick and an enqueue cannot double-type one Turn; a Turn whose echo never confirms (or whose
    /// send fails) stops the drain and the remainder goes back to the front for the next trigger.
    /// Resolves false when anything is still queued.
    async fn deliver(&self) -> bool {
        let queue: Vec<String> = {
            let mut state = self.lock();
            if state.queued.is_empty() {
                return true;
            }
            std::mem::take(&mut state.queued)
        };
        let clear_keys: Vec<String> = self
            .descriptor
            .clear_keys
            .iter()
            .map(|key| (*key).to_owned())
            .collect();
        for (i, text) in queue.iter().enumerate() {
            let echo_targets: Vec<String> = [self.descriptor.echo_pattern, Some(text.as_str())]
                .into_iter()
                .flatten()
                .filter(|target| !target.is_empty())
                .map(str::to_owned)
                .collect();
            let delivered =
                type_verified(&self.herdr, &self.pane_id, text, &echo_targets, &clear_keys)
                    .await
                    .unwrap_or(false);
            if !delivered {
                let mut state = self.lock();
                let mut front: Vec<String> = queue[i..].to_vec();
                front.append(&mut state.queued);
                state.queued = front;
                return false;
            }
        }
        true
    }

    /// One tick: a Turn-state read, then the queued Turns when the pane is waiting. One tick's failure
    /// is not fatal; the next tick tries again.
    async fn tick_once(self: Arc<Self>) {
        if self.read_turn().await.is_err() {
            return;
        }
        let has_queue = !self.lock().queued.is_empty();
        if self.is_waiting() && has_queue {
            let _ = self.deliver().await;
        }
    }

    /// `stopTick`: stop the tick and forget the pane's recorded read with it: the tick is the
    /// register's only writer for this pane, so once it stops the Peek must read live or find nothing,
    /// never a viewport frozen at the last tick.
    async fn stop_tick(&self) {
        self.tick.cancel();
        let pane = self.pane_id.clone();
        let _ = self.engine.call(move |s| s.pane_reads.forget(&pane)).await;
    }
}

/// `register`: claim a found pane and register its runtime; the error is the reason on failure.
pub async fn register_enlisted(engine: &Engine, input: RegisterEnlisted) -> Result<(), String> {
    let Some(descriptor) = harness_descriptor(&js::trim(&input.harness).to_lowercase()) else {
        return Err("no harness the engine knows".to_owned());
    };
    let (herdr, poll_ms, teaching_wait_ms) = engine
        .call(|s| {
            (
                Herdr::new(&s.herdr_socket),
                s.enlist_poll_ms.unwrap_or(ENLISTED_POLL_MS),
                s.teaching_wait_ms.unwrap_or(READINESS_TIMEOUT_MS),
            )
        })
        .await
        .map_err(|error| error.to_string())?;
    let runtime = Arc::new(EnlistedRuntime {
        id: input.id.clone(),
        pane_id: input.pane_id.clone(),
        harness: input.harness.clone(),
        label: attempt_tab_label(&input.id, &input.title),
        descriptor,
        herdr,
        engine: engine.clone(),
        state: Mutex::new(RuntimeState {
            turn: FRESH_TURN,
            queued: input.teaching.iter().cloned().collect(),
        }),
        release: CancellationToken::new(),
        tick: CancellationToken::new(),
    });

    // A refused enlist leaves nothing, the settling reads' register entry included: no tick will
    // follow them, so nothing may serve them.
    let refuse = |reason: String| {
        let engine = engine.clone();
        let pane = input.pane_id.clone();
        async move {
            let _ = engine.call(move |s| s.pane_reads.forget(&pane)).await;
            Err(reason)
        }
    };

    // Settle the Turn state from consecutive reads (the same rule turn_state applies on its own tick),
    // so an idle pane is taught now. One read establishes the transcript, then IDLE_STABLE_READS more
    // with the idle pattern present flip the state to waiting. A pane still working then is given the
    // same bound a Launch gives a TUI to reach its ready frame, re-read every poll, so the teaching
    // lands the moment the agent is waiting on the operator and never mid-reply (spec, story 14); past
    // the bound the enlist is refused and leaves nothing, never a Ticket whose agent was not taught.
    let settled: Result<Option<String>, String> = async {
        for _ in 0..=IDLE_STABLE_READS {
            runtime.read_turn().await?;
            if runtime.is_waiting() {
                break;
            }
        }
        if input.teaching.is_some() {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(teaching_wait_ms);
            while !runtime.is_waiting() {
                if tokio::time::Instant::now() >= deadline {
                    return Ok(Some(still_working_reason(teaching_wait_ms)));
                }
                sleep_abortable(poll_ms, &runtime.release).await;
                runtime.read_turn().await?;
            }
        }
        Ok(None)
    }
    .await;
    match settled {
        Err(error) => {
            return refuse(format!("the pane could not be read ({error})")).await;
        }
        Ok(Some(reason)) => return refuse(reason).await,
        Ok(None) => {}
    }

    runtime.report_state(if runtime.is_waiting() {
        PaneAgentState::Blocked
    } else {
        PaneAgentState::Working
    });

    if runtime.is_waiting() && !runtime.deliver().await {
        runtime.release_agent();
        return refuse("the teaching Turn could not be delivered".to_owned()).await;
    }
    // The operator's tab is relabelled only once the claim has held, so a refused enlist leaves the
    // label as it found it; awaited (still best-effort) so the claim is whole when the enlist answers.
    if let Some(tab_id) = &input.tab_id {
        let _ = runtime.herdr.relabel_tab(tab_id, &runtime.label).await;
    }

    let registered = Arc::clone(&runtime);
    let _ = engine
        .call(move |s| {
            s.enlisted
                .runtimes
                .insert(registered.id.clone(), registered);
        })
        .await;
    tokio::spawn({
        let runtime = Arc::clone(&runtime);
        async move {
            let mut ticks = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_millis(poll_ms),
                Duration::from_millis(poll_ms),
            );
            loop {
                tokio::select! {
                    _ = ticks.tick() => { tokio::spawn(Arc::clone(&runtime).tick_once()); }
                    () = runtime.tick.cancelled() => return,
                }
            }
        }
    });
    tokio::spawn(watch_ending(
        Arc::clone(&runtime),
        input.outcome_path,
        poll_ms,
    ));
    Ok(())
}

/// `watchEnding`: wait for the two-form race and tell the engine. The Turn tick stops the moment the
/// attempt is over, so no further Turn is typed into a finished attempt. On an Outcome the runtime
/// stays for one more job, watching the pane so a later tab close is reported as a trailing exit; on a
/// gone pane there is nothing left to watch and the runtime is dropped.
async fn watch_ending(runtime: Arc<EnlistedRuntime>, outcome_path: String, poll_ms: u64) {
    let Some(ending) = wait_for_enlisted_ending(
        &runtime.herdr,
        &runtime.pane_id,
        &outcome_path,
        &runtime.release,
        poll_ms,
    )
    .await
    else {
        return;
    };
    if runtime.release.is_cancelled() {
        return;
    }
    runtime.stop_tick().await;
    let id = runtime.id.clone();
    let _ = runtime
        .engine
        .call(move |s| crate::enlist_flow::end_enlisted_attempt(s, &id, ending, None))
        .await;
    match ending {
        EnlistedEnding::Outcome => watch_trailing_exit(runtime, poll_ms).await,
        EnlistedEnding::PaneGone => {
            let id = runtime.id.clone();
            let _ = runtime
                .engine
                .call(move |s| s.enlisted.runtimes.remove(&id))
                .await;
        }
    }
}

/// `watchTrailingExit`: wait for the pane to leave the listing after its Outcome, once.
async fn watch_trailing_exit(runtime: Arc<EnlistedRuntime>, poll_ms: u64) {
    loop {
        sleep_abortable(poll_ms, &runtime.release).await;
        if runtime.release.is_cancelled() {
            return;
        }
        let live = live_pane_ids(&runtime.herdr).await;
        if runtime.release.is_cancelled() {
            return;
        }
        if let Some(live) = live
            && !live.iter().any(|id| *id == runtime.pane_id)
        {
            break;
        }
    }
    let id = runtime.id.clone();
    let _ = runtime
        .engine
        .call(move |s| {
            s.enlisted.runtimes.remove(&id);
            crate::enlist_flow::record_enlisted_trailing_exit(s, &id);
        })
        .await;
}
