//! What Boot asks git (boot-pool.ts, boot-detect.ts, boot-launch.ts): a checkout's git dir, the recent
//! commit subjects behind the detected commit prefix, and when the UI source last changed. Each read's
//! stderr goes nowhere, as Boot's does.

use std::path::Path;

use super::node::{js_number, js_trim, node_join, path_text};
use super::runner::{git_line, run_git_quiet};

/// A checkout's own git dir, where its HEAD lives (a linked worktree's `.git` is a file), or
/// `<top>/.git` when git cannot say: boot-pool.ts's gitDirOf.
pub fn absolute_git_dir(top: impl AsRef<Path>) -> String {
    let top = top.as_ref();
    git_line(top, ["rev-parse", "--absolute-git-dir"])
        .unwrap_or_else(|| node_join(&[&path_text(top), ".git"]))
}

/// The last twenty commit subjects in `repo_dir`, blank ones left out, or none when it is not a
/// checkout: boot-detect.ts's recentSubjects.
pub fn recent_subjects(repo_dir: impl AsRef<Path>) -> Vec<String> {
    let repo_dir = repo_dir.as_ref();
    if !repo_dir.exists() {
        return Vec::new();
    }
    let log = run_git_quiet(repo_dir, ["log", "-20", "--format=%s"]);
    if !log.ok() {
        return Vec::new();
    }
    log.stdout_text()
        .split('\n')
        .filter(|line| !js_trim(line).is_empty())
        .map(str::to_string)
        .collect()
}

/// When the last commit touching `ui/src` in the engine's checkout was made, in milliseconds, or `None`
/// when that is unknown: boot-launch.ts's uiSourceCommitMs, which decides whether the Console needs a
/// rebuild.
pub fn ui_source_commit_ms(engine_dir: impl AsRef<Path>) -> Option<f64> {
    let log = run_git_quiet(
        engine_dir.as_ref(),
        ["log", "-1", "--format=%ct", "--", "ui/src"],
    );
    if !log.ok() {
        return None;
    }
    let seconds = js_number(js_trim(&log.stdout_text()));
    (seconds.is_finite() && seconds > 0.0).then_some(seconds * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::Repo;

    #[test]
    fn finds_a_checkouts_own_git_dir_linked_or_not() {
        let repo = Repo::new();
        assert_eq!(
            absolute_git_dir(repo.root()),
            format!("{}/.git", repo.root_text())
        );
        let linked = repo.second_checkout();
        assert_eq!(
            absolute_git_dir(linked.root()),
            format!("{}/.git/worktrees/checkout", repo.root_text())
        );
        let plain = Repo::bare_dir();
        assert_eq!(
            absolute_git_dir(plain.root()),
            format!("{}/.git", plain.root_text())
        );
    }

    #[test]
    fn lists_recent_subjects_newest_first_without_blanks() {
        let repo = Repo::new();
        repo.git_ok(["commit", "-q", "--allow-empty", "-m", "feat: two"]);
        repo.git_ok(["commit", "-q", "--allow-empty", "-m", "feat: three"]);
        assert_eq!(
            recent_subjects(repo.root()),
            ["feat: three", "feat: two", "init"]
        );
        for n in 0..25 {
            repo.git_ok(["commit", "-q", "--allow-empty", "-m", &format!("c{n}")]);
        }
        assert_eq!(recent_subjects(repo.root()).len(), 20);
        assert!(recent_subjects(Repo::bare_dir().root()).is_empty());
        assert!(recent_subjects(repo.path("missing")).is_empty());
    }

    #[test]
    fn dates_the_last_ui_source_commit_in_milliseconds() {
        let repo = Repo::new();
        assert_eq!(ui_source_commit_ms(repo.root()), None);
        repo.write("ui/src/main.ts", "x\n");
        repo.git_ok(["add", "-A"]);
        let committed = repo.git(["commit", "-qm", "ui"]);
        assert!(committed.ok);
        let seconds: f64 = repo.git_ok(["log", "-1", "--format=%ct"]).parse().unwrap();
        assert_eq!(ui_source_commit_ms(repo.root()), Some(seconds * 1000.0));
        assert_eq!(ui_source_commit_ms(Repo::bare_dir().root()), None);
    }
}
