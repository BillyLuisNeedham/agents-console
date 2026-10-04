//! Boot's launch half (issue #121; boot-launch.ts): the wait a Restart handoff needs, starting the
//! server so it outlives Boot, and reading its boot verdict back out of the log.
//!
//! The parts worth testing are the decisions rather than the spawns, so they are separate functions
//! here: what port the server came up on is one line of a log file, and whether the pool lock is
//! released is a pid file and a liveness check.
//!
//! Boot no longer builds the Console (ADR-0036): the release binary embeds the UI and the shim
//! rebuilds a stale binary, so boot-launch.ts's build staleness decision has no counterpart here.

use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use ac_core::js;
use regex::Regex;

static BOOT_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"pool server on http://localhost:([0-9]+)").expect("the boot line pattern compiles")
});

/// The port from the server's boot line, `pool server on http://localhost:<port> (<pool>)`. The last
/// line wins, because a relaunch appends to a log the caller has truncated and only this boot's line is
/// of interest. The port comes back as JavaScript's `Number` reads the digits.
pub fn parse_boot_line(log: &str) -> Option<f64> {
    let digits = BOOT_LINE.captures_iter(log).last()?;
    let port = js::number_from_text(&digits[1]);
    (port.is_finite() && port.fract() == 0.0).then_some(port)
}

/// The outcome of waiting on the previous server's pool lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PidRelease {
    Released,
    /// The pid still holding the lock.
    Held(i64),
}

/// What the wait below reads and how it passes time, so it can be tested without processes.
pub trait PidWaitDeps {
    /// The pid the lock file names, or `None` when it is gone or names none.
    fn read_pid(&mut self) -> Option<i64>;
    /// Whether that process is still alive.
    fn is_alive(&mut self, pid: i64) -> bool;
    fn wait(&mut self, ms: u64);
    /// Milliseconds on some clock that only moves forward.
    fn now(&mut self) -> u64;
}

/// The Restart handoff's wait (ADR-0026). The Console stops its own server and starts Boot, and the old
/// server releases its pool lock last of all, after stopping its attempts. So Boot waits for
/// `runs/server.pid` to go rather than racing it into the engine's own refusal. A lock file left behind
/// by a server that is already gone counts as released: the engine treats a stale lock the same way,
/// and stopping for it would strand the pool on a file no process owns.
pub fn wait_for_pid_release(deps: &mut dyn PidWaitDeps, timeout_ms: u64) -> PidRelease {
    let deadline = deps.now() + timeout_ms;
    loop {
        let Some(pid) = deps.read_pid() else {
            return PidRelease::Released;
        };
        if !deps.is_alive(pid) {
            return PidRelease::Released;
        }
        if deps.now() >= deadline {
            return PidRelease::Held(pid);
        }
        deps.wait(250);
    }
}

/// How long a Restart's Boot waits for the previous server to release the pool.
pub const PID_RELEASE_TIMEOUT_MS: u64 = 15_000;

/// The real deps for the wait above, reading the pool's own lock file.
pub struct PoolLockFile {
    file: String,
    started: Instant,
}

impl PoolLockFile {
    pub fn new(pool_dir: &str) -> Self {
        PoolLockFile {
            file: js::path_join(&[pool_dir, "runs", "server.pid"]),
            started: Instant::now(),
        }
    }
}

impl PidWaitDeps for PoolLockFile {
    fn read_pid(&mut self) -> Option<i64> {
        if !js::exists(&self.file) {
            return None;
        }
        let text = js::read_text(&self.file).ok()?;
        let pid = js::number_from_text(js::trim(&text));
        (pid.is_finite() && pid.fract() == 0.0 && pid > 0.0).then_some(pid as i64)
    }

    fn is_alive(&mut self, pid: i64) -> bool {
        signal_zero(pid)
    }

    fn wait(&mut self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn now(&mut self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

/// `process.kill(pid, 0)` succeeds: the process is there and may be signalled. A pid Node would refuse
/// to signal (beyond 32 bits) counts as gone.
fn signal_zero(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: kill with signal 0 sends nothing; it only checks that the pid can be signalled.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// The server Boot started, which the log poll checks between reads.
pub struct StartedServer {
    child: Option<Child>,
}

impl StartedServer {
    /// Whether the child has exited.
    pub fn exited(&mut self) -> bool {
        match &mut self.child {
            // A child that could not be started at all has nothing to wait for.
            None => true,
            Some(child) => !matches!(child.try_wait(), Ok(None)),
        }
    }
}

/// Start the pool server detached, in a session of its own, with both its streams appended to the
/// pool's log. Detached on purpose: the Console outlives the terminal Boot ran in, which is what makes
/// `agent-console` a launcher rather than a foreground process the operator has to keep a window open
/// for. The pid file is never written here; that file is the engine's pool lock and it claims it
/// itself. The server is this same binary's `server` subcommand.
pub fn start_server(
    program: &str,
    engine_dir: &str,
    pool_dir: &str,
    port: Option<u16>,
    log_path: &str,
) -> Result<StartedServer, String> {
    let open_log = || {
        OpenOptions::new()
            .append(true)
            .create(true)
            .open(log_path)
            .map_err(|err| js::FsError::new(&err, "open", log_path).to_string())
    };
    let out = open_log()?;
    let err = out
        .try_clone()
        .map_err(|err| js::FsError::bare(&err, "dup").to_string())?;
    let mut command = Command::new(program);
    command.args(["server", "--pool", pool_dir]);
    if let Some(port) = port {
        command.args(["--port", &port.to_string()]);
    }
    command
        .current_dir(engine_dir)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    detach(&mut command);
    // A spawn that fails reads as a server that exited at once, as Bun's would: its failure goes to the
    // log, and the log is what Boot shows.
    match command.spawn() {
        Ok(child) => Ok(StartedServer { child: Some(child) }),
        Err(spawn_err) => {
            let _ = js::append_file(log_path, &format!("{spawn_err}\n"));
            Ok(StartedServer { child: None })
        }
    }
}

// Its own session, as Bun's `detached: true`.
fn detach(command: &mut Command) {
    // SAFETY: setsid is async-signal-safe and touches nothing in the parent.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

/// What the log poll concluded.
#[derive(Debug, Clone, PartialEq)]
pub enum BootVerdict {
    Up { port: f64 },
    Exited { tail: String },
    Timeout { tail: String },
}

/// How long Boot waits for the server's boot line.
pub const BOOT_TIMEOUT_MS: u64 = 10_000;

/// Poll the log for the boot line. An exit before the line means the engine refused, most often because
/// the pool is already locked or a pinned port is busy, and its own message is the useful thing to show.
pub fn wait_for_boot(log_path: &str, server: &mut StartedServer, timeout_ms: u64) -> BootVerdict {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let log = js::read_text(log_path).unwrap_or_default();
        if let Some(port) = parse_boot_line(&log) {
            return BootVerdict::Up { port };
        }
        if server.exited() {
            return BootVerdict::Exited {
                tail: tail_of(&log, 8),
            };
        }
        if Instant::now() >= deadline {
            return BootVerdict::Timeout {
                tail: tail_of(&log, 8),
            };
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// How long Boot waits for `/api/state` once the boot line is out.
pub const STATE_TIMEOUT_MS: u64 = 10_000;

/// Poll `/api/state` until the pool answers with a snapshot.
pub fn wait_for_state(url: &str, timeout_ms: u64) -> bool {
    let state = format!("{url}/api/state");
    super::on_own_runtime(async {
        let Ok(client) = reqwest::Client::builder().no_proxy().build() else {
            return false;
        };
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            // Not listening yet is ordinary: the boot line is printed as the server starts, so a short
            // gap before the socket accepts is no fault.
            if let Ok(response) = client.get(&state).send().await
                && response.status().is_success()
                && response.bytes().await.is_ok()
            {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .unwrap_or(false)
}

/// Open the Console with the platform's opener, and say nothing if it fails.
pub fn open_browser(url: &str) -> bool {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut command = Command::new(opener);
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut command);
    command.spawn().is_ok()
}

/// The last few lines of a log, which is what a failed boot has to say.
pub fn tail_of(log: &str, lines: usize) -> String {
    let kept: Vec<&str> = log.split('\n').filter(|line| !line.is_empty()).collect();
    kept[kept.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_port_off_the_last_boot_line_in_the_log() {
        let log = [
            "pool server on http://localhost:8787 (/pools/old)",
            "some other line",
            "pool server on http://localhost:8901 (/pools/new)",
        ]
        .join("\n");
        assert_eq!(parse_boot_line(&log), Some(8901.0));
        assert_eq!(parse_boot_line("nothing here"), None);
        assert_eq!(
            parse_boot_line("pool server on http://localhost:08080 (/p)"),
            Some(8080.0)
        );
    }

    #[test]
    fn keeps_the_last_lines_of_a_log_for_a_failed_boot() {
        assert_eq!(tail_of("a\nb\n\nc\n", 2), "b\nc");
        assert_eq!(tail_of("", 8), "");
        assert_eq!(tail_of("one\n", 8), "one");
    }

    struct Fake {
        pids: Vec<Option<i64>>,
        alive: bool,
        clock: u64,
        tick: u64,
    }

    impl PidWaitDeps for Fake {
        fn read_pid(&mut self) -> Option<i64> {
            if self.pids.len() > 1 {
                self.pids.remove(0)
            } else {
                self.pids[0]
            }
        }
        fn is_alive(&mut self, _pid: i64) -> bool {
            self.alive
        }
        fn wait(&mut self, ms: u64) {
            self.clock += ms * self.tick;
        }
        fn now(&mut self) -> u64 {
            self.clock
        }
    }

    #[test]
    fn waits_for_the_previous_server_to_release_the_pool_lock() {
        let mut deps = Fake {
            pids: vec![Some(4242), Some(4242), None],
            alive: true,
            clock: 0,
            tick: 0,
        };
        assert_eq!(
            wait_for_pid_release(&mut deps, PID_RELEASE_TIMEOUT_MS),
            PidRelease::Released
        );
    }

    #[test]
    fn treats_a_lock_left_by_a_dead_process_as_released() {
        let mut deps = Fake {
            pids: vec![Some(4242)],
            alive: false,
            clock: 0,
            tick: 0,
        };
        assert_eq!(
            wait_for_pid_release(&mut deps, PID_RELEASE_TIMEOUT_MS),
            PidRelease::Released
        );
    }

    #[test]
    fn gives_up_naming_the_pid_when_a_live_server_keeps_the_lock() {
        let mut deps = Fake {
            pids: vec![Some(4242)],
            alive: true,
            clock: 0,
            tick: 1,
        };
        assert_eq!(
            wait_for_pid_release(&mut deps, 1000),
            PidRelease::Held(4242)
        );
        assert_eq!(deps.clock, 1000);
    }

    #[test]
    fn reads_the_pool_lock_file_as_the_engine_writes_it() {
        let pool = tempfile::tempdir().unwrap();
        let dir = js::path_text(pool.path());
        let mut lock = PoolLockFile::new(&dir);
        assert_eq!(lock.read_pid(), None);
        std::fs::create_dir_all(pool.path().join("runs")).unwrap();
        for (text, pid) in [
            ("4242\n", Some(4242)),
            ("  17 ", Some(17)),
            ("0", None),
            ("-3", None),
            ("1.5", None),
            ("pid", None),
        ] {
            std::fs::write(pool.path().join("runs/server.pid"), text).unwrap();
            assert_eq!(lock.read_pid(), pid, "{text:?}");
        }
        assert!(lock.is_alive(i64::from(std::process::id())));
        assert!(!lock.is_alive(i64::from(i32::MAX) + 1));
    }

    #[test]
    fn reports_an_exit_before_the_boot_line_with_the_logs_tail() {
        let pool = tempfile::tempdir().unwrap();
        let log = js::path_text(&pool.path().join("server.log"));
        std::fs::write(&log, "").unwrap();
        let mut server = start_server(
            "sh",
            &js::path_text(pool.path()),
            "/no/such/pool",
            Some(0),
            &log,
        )
        .unwrap();
        // `sh server ...` fails at once, reading `server` as a script that is not there.
        match wait_for_boot(&log, &mut server, 5_000) {
            BootVerdict::Exited { tail } => assert!(tail.contains("server"), "{tail}"),
            other => panic!("expected an exit, got {other:?}"),
        }
    }

    #[test]
    fn reports_a_spawn_that_fails_as_an_exit() {
        let pool = tempfile::tempdir().unwrap();
        let log = js::path_text(&pool.path().join("server.log"));
        std::fs::write(&log, "").unwrap();
        let mut server = start_server(
            "/no/such/program",
            &js::path_text(pool.path()),
            "/p",
            None,
            &log,
        )
        .unwrap();
        assert!(matches!(
            wait_for_boot(&log, &mut server, 1_000),
            BootVerdict::Exited { .. }
        ));
    }
}
