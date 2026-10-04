//! Running git. Every call is `git -C <dir> <args...>` (one, `git merge-file`, runs where the process
//! does), with the server's own environment passed through untouched and stdin closed, exactly as
//! `Bun.spawnSync` and `Bun.spawn` start it: the TypeScript sets no `GIT_*` variable and no `-c` option
//! anywhere. A synchronous run blocks its caller, as `spawnSync` blocked the engine's one thread; the
//! async run is for the reads the TypeScript awaits.

use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use super::node::js_trim;

/// One git run as the TypeScript's probes read it: whether it exited 0, and its stdout and stderr
/// decoded as UTF-8 and trimmed the way JavaScript's `trim()` trims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProbe {
    pub ok: bool,
    pub out: String,
    pub err: String,
}

/// One git run as it came back, untrimmed, for the call sites that read raw stdout (`git show`,
/// `git merge-file -p`) or the exit code itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitOutput {
    /// The exit code; `None` when git was killed by a signal or could not be started at all.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl GitOutput {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// stdout as `Buffer.toString()` reads it: UTF-8, invalid sequences replaced.
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// stderr the same way.
    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }

    /// The probe the TypeScript's `git()` and `gitAsync()` make of this run.
    pub fn probe(&self) -> GitProbe {
        GitProbe {
            ok: self.ok(),
            out: js_trim(&self.stdout_text()).to_string(),
            err: js_trim(&self.stderr_text()).to_string(),
        }
    }
}

/// `git -C <repo_root> <args...>`, waited for: worktrees.ts's `git()`.
pub fn git<I, S>(repo_root: impl AsRef<Path>, args: I) -> GitProbe
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git(Some(repo_root.as_ref()), args).probe()
}

/// `git -C <repo_root> <args...>` without blocking the caller's thread: worktrees.ts's `gitAsync()`, for
/// a read a request handler makes on demand (issue #157), where the answer can wait for git and every
/// other request should not.
pub async fn git_async<I, S>(repo_root: impl AsRef<Path>, args: I) -> GitProbe
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_async(Some(repo_root.as_ref()), args).await.probe()
}

/// `git [-C <cwd>] <args...>`, waited for, with stdout and stderr captured whole.
pub fn run_git<I, S>(cwd: Option<&Path>, args: I) -> GitOutput
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = git_command(cwd, args);
    finished(command.stdin(Stdio::null()).output())
}

/// [`run_git`] on tokio.
pub async fn run_git_async<I, S>(cwd: Option<&Path>, args: I) -> GitOutput
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = tokio::process::Command::from(git_command(cwd, args));
    finished(command.stdin(Stdio::null()).output().await)
}

/// One trimmed line of git's stdout, or `None` when `cwd` does not exist, git fails, or it prints
/// nothing: boot-pool.ts's `gitLine`, whose stderr goes nowhere.
pub fn git_line<I, S>(cwd: impl AsRef<Path>, args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let cwd = cwd.as_ref();
    if !cwd.exists() {
        return None;
    }
    let output = run_git_quiet(cwd, args);
    if !output.ok() {
        return None;
    }
    let line = js_trim(&output.stdout_text()).to_string();
    (!line.is_empty()).then_some(line)
}

/// `git -C <cwd> <args...>`, waited for, with stderr sent nowhere: the runs Boot makes with `stderr:
/// "ignore"`.
pub(crate) fn run_git_quiet<I, S>(cwd: &Path, args: I) -> GitOutput
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = git_command(Some(cwd), args);
    finished(command.stdin(Stdio::null()).stderr(Stdio::null()).output())
}

fn git_command<I, S>(cwd: Option<&Path>, args: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("git");
    if let Some(cwd) = cwd {
        command.arg("-C").arg(cwd);
    }
    command.args(args);
    command
}

// A git that could not be started reads as a failed run carrying the reason, where Bun's spawn would
// have thrown it.
fn finished(output: io::Result<Output>) -> GitOutput {
    match output {
        Ok(output) => GitOutput {
            code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        },
        Err(err) => GitOutput {
            code: None,
            stdout: Vec::new(),
            stderr: if err.kind() == io::ErrorKind::NotFound {
                b"Executable not found in $PATH: \"git\"".to_vec()
            } else {
                err.to_string().into_bytes()
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::Repo;

    #[test]
    fn probes_trim_both_streams_and_read_the_exit_code() {
        let repo = Repo::new();
        let head = git(repo.root(), ["rev-parse", "HEAD"]);
        assert!(head.ok);
        assert_eq!(head.out.len(), 40);
        assert_eq!(head.err, "");

        let missing = git(repo.root(), ["rev-parse", "--verify", "nope"]);
        assert!(!missing.ok);
        assert_eq!(missing.out, "");
        assert_eq!(missing.err, "fatal: Needed a single revision");
    }

    #[test]
    fn a_raw_run_keeps_stdout_whole_and_runs_without_a_directory() {
        let repo = Repo::new();
        let shown = run_git(Some(repo.root()), ["show", "HEAD:base.txt"]);
        assert_eq!(shown.code, Some(0));
        assert_eq!(shown.stdout_text(), "base\n");

        let version = run_git(None, ["--version"]);
        assert!(version.ok());
        assert!(version.stdout_text().starts_with("git version "));
    }

    #[test]
    fn a_missing_directory_fails_the_run() {
        let repo = Repo::new();
        let gone = repo.root().join("gone");
        let probe = git(&gone, ["status"]);
        assert!(!probe.ok);
        assert!(probe.err.contains("cannot change to"), "{}", probe.err);
        assert_eq!(git_line(&gone, ["rev-parse", "--show-toplevel"]), None);
    }

    #[test]
    fn a_line_is_trimmed_and_none_when_empty_or_failed() {
        let repo = Repo::new();
        assert_eq!(
            git_line(repo.root(), ["rev-parse", "--show-toplevel"]).as_deref(),
            Some(repo.root_text().as_str())
        );
        repo.git(["checkout", "-q", "--detach"]);
        assert_eq!(git_line(repo.root(), ["branch", "--show-current"]), None);
        assert_eq!(
            git_line(repo.root(), ["rev-parse", "--verify", "nope"]),
            None
        );
    }

    #[tokio::test]
    async fn the_async_run_reads_as_the_sync_one() {
        let repo = Repo::new();
        let sync = git(repo.root(), ["log", "--format=%s"]);
        let async_probe = git_async(repo.root(), ["log", "--format=%s"]).await;
        assert_eq!(async_probe, sync);
        assert_eq!(async_probe.out, "init");
        let failed = git_async(repo.root(), ["rev-parse", "--verify", "nope"]).await;
        assert!(!failed.ok);
    }
}
