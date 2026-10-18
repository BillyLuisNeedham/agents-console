//! `agent-console server --pool <dir> [--port <n>] [--registry <file>]` (server.ts `runServerCli`): the
//! one place the server's environment is read, the boot line, and the one way out. A signal, a Stop
//! from the Console (issue #97) and a Restart (issue #121) all take the same orderly stop, bounded by a
//! hard limit, and a Restart then hands the pool to Boot. A `plans.boot` from the Console hands Boot a
//! new Line, detached, with the server left running.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::Value;

use ac_core::fleet::default_registry_path;
use ac_core::js;
use ac_core::machine_defaults::default_machine_defaults_paths;
use ac_io::git::git_line;
use ac_io::herdr::default_socket_path;
use ac_io::own_exe::own_exe;
use ac_protocol::PlanBootResponse;
use ac_server::{LineBoot, LineBootRefusal, PoolServerOptions, Server};

use crate::boot::home_dir;
use crate::detach::spawn_detached;

/// Well past the children's TERM grace plus the drive's settle wait: a stop that has not finished by
/// then is stuck on something the exit will free.
const SHUTDOWN_HARD_LIMIT: Duration = Duration::from_millis(15_000);

const USAGE: &str = "usage: agent-console server --pool <dir> [--port <n>] [--registry <file>]";

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
    let (_, log) = open_boot_log(Path::new(pool_dir))?;
    let here = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // Boot may run in another directory, so a pool named relative to this one is named in full.
    let pool = if Path::new(pool_dir).is_relative() {
        js::path_text(&here.join(pool_dir))
    } else {
        pool_dir.to_owned()
    };
    let mut args = vec![
        "--pool".to_owned(),
        pool,
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
    let exe = own_exe().map_err(|err| format!("{err}"))?;
    spawn_boot(&boot_command(&exe, args, here), log)
}

/// `<pool>/runs/boot.log`, opened to append, its directory made.
fn open_boot_log(pool_dir: &Path) -> Result<(PathBuf, File), String> {
    let runs = pool_dir.join("runs");
    js::mkdir_all(&runs).map_err(|err| err.to_string())?;
    let path = runs.join("boot.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| js::FsError::new(&err, "open", &path).to_string())?;
    Ok((path, log))
}

/// Boot, detached, stdin null, both its streams appended to `log`.
fn spawn_boot(boot: &BootCommand, log: File) -> Result<(), String> {
    let err_log = log.try_clone().map_err(|err| err.to_string())?;
    let mut command = Command::new(&boot.program);
    command
        .args(&boot.args)
        .current_dir(&boot.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log));
    spawn_detached(&mut command).map_err(|err| format!("{err}"))
}

/// The flags a Console-started Line boots with: `--yes`, since nobody is at a terminal to answer.
fn line_boot_args(boot: &LineBoot) -> Vec<String> {
    ["--plan", &boot.plan, "--work", &boot.work, "--yes"]
        .map(str::to_owned)
        .to_vec()
}

/// The project a Console-started Line is cut from: the main worktree of the repository the pool sits
/// in, since Line mode cuts from its working directory's checkout. Not the pool's own toplevel: a Line's
/// pool lives in that Line's worktree, and a Line started from there would be cut from its branch.
fn main_worktree(pool_dir: &Path) -> Option<PathBuf> {
    let listed = git_line(pool_dir, ["worktree", "list", "--porcelain"])?;
    let main = PathBuf::from(listed.lines().next()?.strip_prefix("worktree ")?);
    Some(std::fs::canonicalize(&main).unwrap_or(main))
}

/// `plans.boot`'s second half: Boot for a new Line, detached, its output appended to the pool's boot
/// log, run from the project. The program is the one a Restart runs; only the directory differs, since
/// the shim hands Boot the directory it was started in.
fn hand_off_line_boot(
    pool_dir: &str,
    boot: &LineBoot,
) -> Result<PlanBootResponse, LineBootRefusal> {
    let pool = std::path::absolute(pool_dir).unwrap_or_else(|_| PathBuf::from(pool_dir));
    let project = main_worktree(&pool).ok_or_else(|| {
        LineBootRefusal::NoCheckout(format!(
            "plans: the pool at {} is in no git checkout, so there is no project to cut a Line from",
            js::path_text(&pool)
        ))
    })?;
    let argv = line_boot_args(boot);
    let (log_path, log) = open_boot_log(&pool).map_err(LineBootRefusal::Launch)?;
    let exe = own_exe().map_err(|err| LineBootRefusal::Launch(format!("{err}")))?;
    let command = BootCommand {
        cwd: project.clone(),
        ..boot_command(&exe, argv.clone(), project.clone())
    };
    spawn_boot(&command, log).map_err(LineBootRefusal::Launch)?;
    Ok(PlanBootResponse {
        argv,
        cwd: js::path_text(&project),
        log: js::path_text(&log_path),
    })
}

/// What a Restart runs to bring the pool back: the program, its arguments, and the directory it runs in.
#[derive(Debug, PartialEq)]
struct BootCommand {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
}

/// Boot from the checkout this binary was built in, never whichever `agent-console` is first on PATH: the
/// TypeScript ran its own checkout's boot-cli.ts from that checkout. A binary at
/// `<checkout>/target/<profile>/agent-console` runs that checkout's shim, `bin/agent-console`, which
/// rebuilds what is stale there and hands its arguments to `boot` itself. A binary with no shim beside it
/// runs its own `boot`, from `here`.
fn boot_command(exe: &Path, boot_args: Vec<String>, here: PathBuf) -> BootCommand {
    let exe = std::fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
    let checkout = exe
        .parent()
        .and_then(Path::parent)
        .filter(|target| target.file_name().is_some_and(|name| name == "target"))
        .and_then(Path::parent);
    match checkout.map(|dir| (dir, dir.join("bin").join("agent-console"))) {
        Some((dir, shim)) if shim.is_file() => BootCommand {
            program: shim,
            args: boot_args,
            cwd: dir.to_path_buf(),
        },
        _ => BootCommand {
            program: exe,
            args: std::iter::once("boot".to_owned())
                .chain(boot_args)
                .collect(),
            cwd: here,
        },
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
    let on_line_boot = {
        let pool_dir = pool_dir.clone();
        Arc::new(move |boot: &LineBoot| hand_off_line_boot(&pool_dir, boot))
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
        on_line_boot_requested: Some(on_line_boot),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn boot_args() -> Vec<String> {
        ["--pool", "/p", "--yes", "--relaunch"]
            .map(str::to_owned)
            .to_vec()
    }

    /// A file at `dir/relative`, its parents made.
    fn touch(dir: &Path, relative: &str) -> PathBuf {
        let path = dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "").unwrap();
        path
    }

    #[test]
    fn a_restart_runs_the_shim_of_the_checkout_the_binary_sits_in_from_that_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = std::fs::canonicalize(dir.path()).unwrap();
        let exe = touch(&checkout, "target/release/agent-console");
        let shim = touch(&checkout, "bin/agent-console");
        assert_eq!(
            boot_command(&exe, boot_args(), PathBuf::from("/elsewhere")),
            BootCommand {
                program: shim,
                args: boot_args(),
                cwd: checkout,
            }
        );
    }

    #[test]
    fn a_binary_with_no_shim_beside_it_runs_its_own_boot_from_here() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let exe = touch(&root, "target/release/agent-console");
        let mut args = vec!["boot".to_owned()];
        args.extend(boot_args());
        assert_eq!(
            boot_command(&exe, boot_args(), PathBuf::from("/elsewhere")),
            BootCommand {
                program: exe,
                args,
                cwd: PathBuf::from("/elsewhere"),
            }
        );
    }

    #[test]
    fn a_shim_two_levels_up_counts_only_from_a_target_directory() {
        // A build with its own target directory, ~/.cargo-target/release say, beside a ~/bin that holds
        // some checkout's shim: that shim is not this binary's.
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let exe = touch(&root, "cargo-target/release/agent-console");
        touch(&root, "bin/agent-console");
        let got = boot_command(&exe, boot_args(), PathBuf::from("/elsewhere"));
        assert_eq!(got.program, exe);
        assert_eq!(got.args[0], "boot");
    }

    #[test]
    fn a_console_started_line_boots_with_its_plan_and_work_and_answers_yes() {
        let boot = LineBoot {
            plan: "addy-commands".to_owned(),
            work: "fix the flaky test".to_owned(),
        };
        assert_eq!(
            line_boot_args(&boot),
            [
                "--plan",
                "addy-commands",
                "--work",
                "fix the flaky test",
                "--yes"
            ]
        );
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[test]
    fn a_line_is_cut_from_the_main_worktree_of_the_pools_repository() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join(".scratch/pool")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        git(&repo, &["worktree", "add", "-q", "-b", "line", "../line"]);
        let linked_pool = root.join("line/.scratch/pool");
        std::fs::create_dir_all(&linked_pool).unwrap();

        assert_eq!(
            main_worktree(&repo.join(".scratch/pool")),
            Some(repo.clone())
        );
        assert_eq!(main_worktree(&linked_pool), Some(repo));
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        assert_eq!(main_worktree(&outside), None);
    }
}
