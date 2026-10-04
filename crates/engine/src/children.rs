//! The engine's headless children (ADR-0017; children.ts): every harness the Attempt-run module runs
//! headless is tracked here from spawn to exit, so a shutdown can stop them all, and the liveness checks
//! boot reconciliation uses to tell an orphan of a previous engine process from a reused pid.
//!
//! Each child runs in its own process group (a setsid, as Bun's `detached`), so one signal to the group
//! reaches the harness and everything it forked: a harness's tool calls run as grandchildren, and a kill
//! that reached only the harness would leave those behind.
//!
//! The tracker lives on the Session; the Attempt-run module reaches it through its
//! [`AttemptHost`](crate::attempt_run::AttemptHost), and so does [`stop_all`].

use std::time::Duration;

use futures::future::join_all;
use nix::errno::Errno;
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use tokio::sync::watch;

use ac_core::js;

use crate::attempt_run::{AttemptHost, on_registries};

/// How long a stopped child gets to exit on TERM before KILL follows.
pub const CHILD_STOP_GRACE_MS: u64 = 5_000;

/// The poll cadence while waiting on a process that is not our child.
const ORPHAN_POLL_MS: u64 = 50;

/// One tracked child: its pid, and a receiver that turns true when it has exited (a sender dropped
/// without saying so counts as exited too).
#[derive(Debug, Clone)]
pub struct TrackedChild {
    pub pid: u32,
    pub exited: watch::Receiver<bool>,
}

impl TrackedChild {
    fn has_exited(&self) -> bool {
        *self.exited.borrow() || self.exited.has_changed().is_err()
    }
}

/// Resolves once the child behind `exited` has exited.
pub async fn child_exited(mut exited: watch::Receiver<bool>) {
    let _ = exited.wait_for(|done| *done).await;
}

/// The tracked children.
#[derive(Debug, Default)]
pub struct ChildTracker {
    live: Vec<TrackedChild>,
    /// True once a shutdown has begun. A child that lands after this is stopped on arrival, so a
    /// super-step mid-spawn cannot fork past the shutdown.
    pub stopping: bool,
}

impl ChildTracker {
    /// Register a spawned child; it drops off once `exited` turns true. One that lands after a
    /// shutdown began is sent TERM to its group at once.
    pub fn track(&mut self, pid: u32, exited: watch::Receiver<bool>) {
        self.live.retain(|child| !child.has_exited());
        self.live.push(TrackedChild { pid, exited });
        if self.stopping {
            signal_group(pid, Signal::SIGTERM);
        }
    }

    /// Drop a child from the tracker, whatever its state.
    pub fn untrack(&mut self, pid: u32) {
        self.live.retain(|child| child.pid != pid);
    }

    /// The children still running.
    pub fn live(&self) -> Vec<TrackedChild> {
        self.live
            .iter()
            .filter(|child| !child.has_exited())
            .cloned()
            .collect()
    }

    /// How many children are still running.
    pub fn size(&self) -> usize {
        self.live.iter().filter(|child| !child.has_exited()).count()
    }

    /// The pids of the children still running.
    pub fn pids(&self) -> Vec<u32> {
        self.live().into_iter().map(|child| child.pid).collect()
    }
}

/// `stopAll`: stop every tracked child, TERM to each group, wait up to the grace for all to exit, then
/// KILL whatever remains and wait for those. Resolves once every child tracked at the call has exited
/// (or a KILL was sent to each survivor and its exit observed). Marks the tracker stopping first, so a
/// child that lands later is stopped on arrival.
pub async fn stop_all(host: &dyn AttemptHost, grace: Option<Duration>) {
    let Some(children) = on_registries(host, |_, children| {
        children.stopping = true;
        children.live()
    })
    .await
    else {
        return;
    };
    if children.is_empty() {
        return;
    }
    for child in &children {
        signal_group(child.pid, Signal::SIGTERM);
    }
    let all_exited = || {
        join_all(
            children
                .iter()
                .map(|child| child_exited(child.exited.clone())),
        )
    };
    let grace = grace.unwrap_or(Duration::from_millis(CHILD_STOP_GRACE_MS));
    if tokio::time::timeout(grace, all_exited()).await.is_ok() {
        return;
    }
    let survivors = on_registries(host, |_, children| children.pids())
        .await
        .unwrap_or_else(|| children.iter().map(|child| child.pid).collect());
    for pid in survivors {
        signal_group(pid, Signal::SIGKILL);
    }
    all_exited().await;
}

fn pid_of(pid: u32) -> Option<Pid> {
    i32::try_from(pid).ok().map(Pid::from_raw)
}

/// Signal a whole process group; a group already gone is not an error. A group we cannot signal
/// (EPERM), or a pid that never led one, falls back to the process itself, so a harness that changed
/// its own group still receives the stop.
pub fn signal_group(pid: u32, signal: Signal) {
    let Some(pid) = pid_of(pid) else {
        return;
    };
    match killpg(pid, signal) {
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(_) => {
            let _ = kill(pid, signal);
        }
    }
}

/// Whether a pid names a live process. EPERM means alive but not ours.
pub fn process_is_live(pid: u32) -> bool {
    let Some(pid) = pid_of(pid) else {
        return false;
    };
    match kill(pid, None) {
        Ok(()) => true,
        Err(errno) => errno == Errno::EPERM,
    }
}

/// The working directory of a live process, or `None` when the platform cannot say (no procfs) or the
/// process is gone or not ours to read.
pub fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|cwd| js::path_text(&cwd))
}

/// Whether a pid recorded on an attempt's spawned event is that attempt's harness still running: live,
/// and working in the attempt's worktree. A live pid whose cwd is elsewhere is a reused pid, not an
/// orphan; one whose cwd cannot be read (no procfs) is trusted on liveness alone, the same bet the pool
/// lock makes on `server.pid`.
pub fn orphan_is_live(pid: u32, cwd: &str) -> bool {
    if !process_is_live(pid) {
        return false;
    }
    let Some(actual) = process_cwd(pid) else {
        return true;
    };
    match js::realpath(cwd) {
        Ok(expected) => actual == js::path_text(&expected),
        // The worktree itself is gone: nothing running there is ours.
        Err(_) => false,
    }
}

/// Stop an orphan that is not our child: TERM to its group, poll liveness up to the grace, then KILL
/// and poll once more. True once the pid is gone, false if it survived even the KILL (not ours to
/// signal).
pub async fn stop_orphan(pid: u32, grace: Option<Duration>) -> bool {
    let grace = grace.unwrap_or(Duration::from_millis(CHILD_STOP_GRACE_MS));
    signal_group(pid, Signal::SIGTERM);
    if gone_within(pid, grace).await {
        return true;
    }
    signal_group(pid, Signal::SIGKILL);
    gone_within(pid, grace).await
}

async fn gone_within(pid: u32, within: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + within;
    while process_is_live(pid) {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(ORPHAN_POLL_MS)).await;
    }
    true
}

#[cfg(test)]
mod tests {
    //! engine/children.test.ts, the hidden row children.test.ts:76 (a child tracked after the stop
    //! began is stopped on arrival) included.

    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::Stdio;
    use std::time::Instant;

    use tokio::task::JoinHandle;

    use crate::attempt_run::test_support::LocalHost;

    struct Sleeper {
        pid: u32,
        exited: watch::Receiver<bool>,
        code: JoinHandle<i32>,
    }

    // A child in its own process group, as the engine starts harnesses, whose exit the test can await
    // and read the way Bun reports it (128 + the signal for a signalled death).
    fn sleeper(cwd: &str, script: &str) -> Sleeper {
        let mut child = tokio::process::Command::new("bash")
            .args(["-c", script])
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let (tx, exited) = watch::channel(false);
        let code = tokio::spawn(async move {
            let status = child.wait().await.unwrap();
            let _ = tx.send(true);
            status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
        });
        Sleeper { pid, exited, code }
    }

    fn here() -> String {
        js::path_text(&std::env::current_dir().unwrap())
    }

    async fn eventually(cond: impl Fn() -> bool) {
        for _ in 0..120 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("eventually: timed out");
    }

    // A child that ignores TERM, once its trap is armed.
    async fn stubborn_sleeper() -> Sleeper {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("armed");
        let child = sleeper(
            &here(),
            &format!(
                "trap '' TERM; : > \"{}\"; while :; do sleep 1; done",
                marker.display()
            ),
        );
        eventually(|| marker.exists()).await;
        child
    }

    #[tokio::test]
    async fn stop_all_terminates_every_tracked_group_and_drops_them() {
        let host = LocalHost::default();
        let a = sleeper(&here(), "sleep 60 & wait");
        let b = sleeper(&here(), "sleep 60 & wait");
        host.children(|children| {
            children.track(a.pid, a.exited.clone());
            children.track(b.pid, b.exited.clone());
            assert_eq!(children.size(), 2);
        });
        stop_all(&host, Some(Duration::from_secs(1))).await;
        assert_eq!(a.code.await.unwrap(), 143);
        assert_eq!(b.code.await.unwrap(), 143);
        host.children(|children| {
            assert_eq!(children.size(), 0);
            assert!(children.stopping);
        });
    }

    #[tokio::test]
    async fn stop_all_falls_through_to_kill_when_a_child_ignores_term() {
        let host = LocalHost::default();
        let stubborn = stubborn_sleeper().await;
        host.children(|children| children.track(stubborn.pid, stubborn.exited.clone()));
        let started = Instant::now();
        stop_all(&host, Some(Duration::from_millis(300))).await;
        assert_eq!(stubborn.code.await.unwrap(), 137);
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(!process_is_live(stubborn.pid));
    }

    #[tokio::test]
    async fn a_child_tracked_after_the_stop_began_is_stopped_on_arrival() {
        let host = LocalHost::default();
        stop_all(&host, Some(Duration::from_millis(100))).await;
        let late = sleeper(&here(), "sleep 60 & wait");
        host.children(|children| children.track(late.pid, late.exited.clone()));
        assert_eq!(late.code.await.unwrap(), 143);
    }

    #[tokio::test]
    async fn an_orphan_is_live_only_alive_and_working_in_the_recorded_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let root = js::path_text(&std::fs::canonicalize(dir.path()).unwrap());
        let wt = format!("{root}/wt");
        std::fs::create_dir(&wt).unwrap();
        let orphan = sleeper(&wt, "sleep 60 & wait");
        if cfg!(target_os = "linux") {
            assert!(orphan_is_live(orphan.pid, &wt));
            // Alive elsewhere: a reused pid, never an orphan of this worktree.
            assert!(!orphan_is_live(orphan.pid, &root));
            assert!(!orphan_is_live(std::process::id(), &wt));
            // A worktree that no longer exists has nothing of ours in it.
            assert!(!orphan_is_live(orphan.pid, &format!("{root}/gone")));
        }
        signal_group(orphan.pid, Signal::SIGKILL);
        assert_eq!(orphan.code.await.unwrap(), 137);
        assert!(!orphan_is_live(orphan.pid, &wt));
    }

    #[tokio::test]
    async fn stop_orphan_terms_first_and_kills_when_ignored() {
        let polite = sleeper(&here(), "sleep 60 & wait");
        assert!(stop_orphan(polite.pid, Some(Duration::from_secs(1))).await);
        let stubborn = stubborn_sleeper().await;
        assert!(stop_orphan(stubborn.pid, Some(Duration::from_millis(300))).await);
        assert!(!process_is_live(stubborn.pid));
        assert_eq!(stubborn.code.await.unwrap(), 137);
        assert_eq!(polite.code.await.unwrap(), 143);
    }
}
