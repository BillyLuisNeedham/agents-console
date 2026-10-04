//! `agent-console server --pool <dir> [--port <n>] [--registry <file>]` (server.ts `runServerCli`): the
//! one place the server's environment is read, the boot line, and the one way out. A signal, a Stop
//! from the Console (issue #97) and a Restart (issue #121) all take the same orderly stop, bounded by a
//! hard limit, and a Restart then hands the pool to Boot.

use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::Value;

use ac_core::fleet::default_registry_path;
use ac_core::js;
use ac_core::machine_defaults::default_machine_defaults_paths;
use ac_io::herdr::default_socket_path;
use ac_server::{PoolServerOptions, Server};

/// Well past the children's TERM grace plus the drive's settle wait: a stop that has not finished by
/// then is stuck on something the exit will free.
const SHUTDOWN_HARD_LIMIT: Duration = Duration::from_millis(15_000);

const USAGE: &str = "usage: agent-console server --pool <dir> [--port <n>] [--registry <file>]";

/// Node's `os.homedir()`: `$HOME` when set, else the password database's entry for this user.
pub fn home_dir() -> String {
    if let Some(home) = std::env::var_os("HOME") {
        return home.to_string_lossy().into_owned();
    }
    nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|user| user.dir.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// An environment variable as `process.env.X || undefined` reads it: unset and empty are both absent.
fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// The CLI's one way out (ADR-0017): stop the attempts, release the pool, exit. A second arrival during
/// the stop is ignored rather than cutting the stop short; a stop that hangs past its bound exits 1.
struct StopAndExit {
    server: OnceLock<Server>,
    stopping: AtomicBool,
    runtime: tokio::runtime::Handle,
}

impl StopAndExit {
    fn run(self: &Arc<Self>, reason: &str, after_stop: Option<Box<dyn FnOnce() + Send>>) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        println!("{reason}: stopping attempts, then exiting");
        std::thread::spawn(|| {
            std::thread::sleep(SHUTDOWN_HARD_LIMIT);
            std::process::exit(1);
        });
        let this = self.clone();
        self.runtime.spawn(async move {
            if let Some(server) = this.server.get() {
                server.shutdown(None).await;
            }
            // A Restart's hand-off, run only on the orderly path: a stop that hangs past its bound exits
            // without relaunching rather than leaving two Consoles racing for one pool.
            if let Some(after_stop) = after_stop {
                after_stop();
            }
            std::process::exit(0);
        });
    }
}

/// The Restart's second half (issue #121): start Boot for the same Pool, detached, its output appended
/// to the pool's boot log, on the port the route promised the tab, passed as a pin even when nothing
/// pinned it. Port 0 is any free port, never a pin, so it is never passed on.
fn hand_off_to_boot(pool_dir: &str, port: &Value) -> Result<(), String> {
    let runs = Path::new(pool_dir).join("runs");
    js::mkdir_all(&runs).map_err(|err| err.to_string())?;
    let log_path = runs.join("boot.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| js::FsError::new(&err, "open", &log_path).to_string())?;
    let err_log = log.try_clone().map_err(|err| err.to_string())?;
    let mut args = vec![
        "boot".to_owned(),
        "--pool".to_owned(),
        pool_dir.to_owned(),
        "--yes".to_owned(),
        "--relaunch".to_owned(),
    ];
    let number = match port {
        Value::String(text) => js::number_from_text(text),
        other => js::number_of(other).unwrap_or(f64::NAN),
    };
    if number > 0.0 {
        args.push("--port".to_owned());
        args.push(js::string_of(port));
    }
    // `agent-console` as PATH finds it, as the TypeScript runs `bun` by name; with none on PATH, this
    // same binary.
    let spawn = |program: PathBuf, log: std::fs::File, err_log: std::fs::File| {
        let mut command = Command::new(program);
        command
            .args(&args)
            .current_dir(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err_log));
        // SAFETY: setsid is async-signal-safe and touches nothing of the parent's.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        command.spawn().map(drop)
    };
    let (log_again, err_again) = (
        log.try_clone().map_err(|err| err.to_string())?,
        err_log.try_clone().map_err(|err| err.to_string())?,
    );
    match spawn(PathBuf::from("agent-console"), log, err_log) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let own = std::env::current_exe().map_err(|err| format!("{err}"))?;
            spawn(own, log_again, err_again).map_err(|err| format!("{err}"))
        }
        other => other.map_err(|err| format!("{err}")),
    }
}

/// Run the `server` subcommand; never returns.
pub fn run(args: Vec<String>) -> ! {
    let index = |flag: &str| args.iter().position(|arg| arg == flag);
    let pool_dir = index("--pool").and_then(|i| args.get(i + 1)).cloned();
    // JavaScript's Number of the flag's value: absent reads NaN, "" reads 0.
    let port = index("--port").map(|i| {
        args.get(i + 1)
            .map_or(f64::NAN, |value| js::number_from_text(value))
    });
    let registry = index("--registry")
        .and_then(|i| args.get(i + 1))
        .filter(|value| !value.is_empty())
        .cloned();
    let Some(pool_dir) = pool_dir.filter(|dir| !dir.is_empty()) else {
        eprintln!("{USAGE}");
        std::process::exit(1);
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };
    let home = home_dir();
    // The one read of each of these (issues #94, ADR-0020, ADR-0036): they travel on as options, and
    // nothing below this boundary consults the environment.
    let herdr_socket = default_socket_path(
        std::env::var("HERDR_SOCKET_PATH").ok().as_deref(),
        Path::new(&home),
    );
    let stop = Arc::new(StopAndExit {
        server: OnceLock::new(),
        stopping: AtomicBool::new(false),
        runtime: runtime.handle().clone(),
    });
    let on_stop = {
        let stop = stop.clone();
        Arc::new(move || stop.run("stop requested from the Console", None))
    };
    let on_restart = {
        let stop = stop.clone();
        let pool_dir = pool_dir.clone();
        Arc::new(move |port: Value| {
            println!("restart requested from the Console: handing off to Boot");
            let pool_dir = pool_dir.clone();
            stop.run(
                "restart requested from the Console",
                Some(Box::new(move || {
                    if let Err(err) = hand_off_to_boot(&pool_dir, &port) {
                        eprintln!("{err}");
                        std::process::exit(1);
                    }
                })),
            );
        })
    };
    let options = PoolServerOptions {
        pool_dir: pool_dir.clone(),
        port,
        default_port: None,
        harnesses: None,
        ui: None,
        registry_path: registry.unwrap_or_else(|| default_registry_path(&home)),
        herdr_socket,
        herdr_workspace: env_value("HERDR_WORKSPACE_ID"),
        jev_api_key: env_value("TYPESAFE_API_KEY"),
        jev_base_url: env_value("JEV_BASE_URL"),
        stream_heartbeat: None,
        snapshot_coalesce: None,
        enlist_poll: None,
        conversation_poll: None,
        enlist_teaching_wait: None,
        pane_survey: None,
        on_stop_requested: Some(on_stop),
        on_restart_requested: Some(on_restart),
        machine_defaults_paths: default_machine_defaults_paths(&home),
        parent_env: std::sync::Arc::new(
            std::env::vars_os()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
                .collect(),
        ),
        home: home.clone(),
        starter: None,
    };
    runtime.block_on(async move {
        let server = match Server::create(options) {
            Ok(server) => server,
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        };
        let _ = stop.server.set(server.clone());
        // Trap SIGTERM and SIGINT: an untrapped kill left every headless harness running under init
        // (issue #65).
        for (kind, name) in [
            (tokio::signal::unix::SignalKind::terminate(), "SIGTERM"),
            (tokio::signal::unix::SignalKind::interrupt(), "SIGINT"),
        ] {
            let stop = stop.clone();
            match tokio::signal::unix::signal(kind) {
                Ok(mut signals) => {
                    tokio::spawn(async move {
                        while signals.recv().await.is_some() {
                            stop.run(name, None);
                        }
                    });
                }
                Err(err) => eprintln!("{err}"),
            }
        }
        match server.start().await {
            Ok(_) => println!("pool server on {} ({pool_dir})", server.url()),
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        }
        std::future::pending::<()>().await;
    });
    std::process::exit(0);
}
