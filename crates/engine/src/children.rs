//! The engine's headless children (ADR-0017, children.ts): every harness the Attempt-run module runs
//! headless is tracked from spawn to exit, so a shutdown can stop them all.
//!
//! STUB(children): the attempt launch port owns this module (the orphan liveness checks included);
//! this is the tracker and the stop a headless pool needs, as the TypeScript has them.

use std::time::Duration;

use indexmap::IndexMap;
use tokio::sync::watch;

use crate::actor::Engine;

/// How long a stopped child gets to exit on TERM before KILL follows.
pub const CHILD_STOP_GRACE_MS: u64 = 5_000;

/// The tracked children: each one's pid and a receiver that turns true when it has exited.
#[derive(Debug, Default)]
pub struct ChildTracker {
    /// True once a shutdown has begun. A child that lands after this is stopped on arrival.
    pub stopping: bool,
    live: IndexMap<u32, watch::Receiver<bool>>,
}

impl ChildTracker {
    /// Register a spawned child; `exited` turns true when it exits. One that lands after a shutdown
    /// began is sent TERM at once.
    pub fn track(&mut self, pid: u32, exited: watch::Receiver<bool>) {
        self.live.insert(pid, exited);
        if self.stopping {
            signal_group(pid, nix::sys::signal::Signal::SIGTERM);
        }
    }

    /// The child exited.
    pub fn untrack(&mut self, pid: u32) {
        self.live.shift_remove(&pid);
    }

    pub fn pids(&self) -> Vec<u32> {
        self.live.keys().copied().collect()
    }

    fn exits(&self) -> Vec<(u32, watch::Receiver<bool>)> {
        self.live
            .iter()
            .map(|(pid, exited)| (*pid, exited.clone()))
            .collect()
    }
}

/// Signal a whole process group; a group already gone is not an error.
pub fn signal_group(pid: u32, signal: nix::sys::signal::Signal) {
    let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), signal);
}

async fn all_exited(exits: Vec<(u32, watch::Receiver<bool>)>) {
    for (_, mut exited) in exits {
        let _ = exited.wait_for(|done| *done).await;
    }
}

/// `stopAll`: TERM to each tracked group, wait up to the grace for all to exit, then KILL whatever
/// remains and wait for those.
pub async fn stop_all(engine: &Engine, grace: Option<Duration>) {
    let Ok(exits) = engine
        .call(|s| {
            s.children.stopping = true;
            s.children.exits()
        })
        .await
    else {
        return;
    };
    if exits.is_empty() {
        return;
    }
    for (pid, _) in &exits {
        signal_group(*pid, nix::sys::signal::Signal::SIGTERM);
    }
    let grace = grace.unwrap_or(Duration::from_millis(CHILD_STOP_GRACE_MS));
    if tokio::time::timeout(grace, all_exited(exits.clone()))
        .await
        .is_ok()
    {
        return;
    }
    if let Ok(pids) = engine.call(|s| s.children.pids()).await {
        for pid in pids {
            signal_group(pid, nix::sys::signal::Signal::SIGKILL);
        }
    }
    all_exited(exits).await;
}
