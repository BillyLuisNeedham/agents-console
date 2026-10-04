//! The diffs the Console reads: a Ticket's Vitals from its worktree (the activity endpoint), an attempt
//! branch's work for its grader and for Jev's Evidence, and the diff summary a done-Notice carries.

use std::collections::HashMap;
use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::node::{js_number, js_trim, node_join, path_text};
use super::runner::{git, git_async};

/// The diff summary of `range` in `cwd` (`git diff --stat`), or `(no changes)` when it says nothing or
/// fails: the Diff line of the Notice a parent gets when a Ticket it spawned ends (notices.ts).
pub fn diff_stat_summary(cwd: impl AsRef<Path>, range: &str) -> String {
    let probe = git(cwd, ["diff", "--stat", range]);
    let out = if probe.ok { js_trim(&probe.out) } else { "" };
    if out.is_empty() {
        "(no changes)".to_string()
    } else {
        out.to_string()
    }
}

/// Why an attempt branch has no diff to show, in the words the grader's prompt and Jev's `diff_note`
/// use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchDiffFailure {
    /// `git merge-base HEAD <branch>` found none.
    NoCommonAncestor,
    /// `git diff` itself failed.
    DiffFailed,
}

impl fmt::Display for BranchDiffFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            BranchDiffFailure::NoCommonAncestor => "no common ancestor with the attempt branch",
            BranchDiffFailure::DiffFailed => "git diff failed",
        })
    }
}

/// A branch's work as a diff, trimmed: the branch against the commit it was cut from (`git merge-base
/// HEAD <branch>`), so sibling merges onto the working branch during a verify fan-out never leak into one
/// attempt's grade (engine.ts's attemptDiff and attemptDiffParts). `no_context` asks for `-U0`, the
/// changed lines alone, Evidence's base budget.
pub fn branch_diff(
    cwd: impl AsRef<Path>,
    branch: &str,
    no_context: bool,
) -> Result<String, BranchDiffFailure> {
    let cwd = cwd.as_ref();
    let base = git(cwd, ["merge-base", "HEAD", branch]);
    if !base.ok {
        return Err(BranchDiffFailure::NoCommonAncestor);
    }
    let range = format!("{}..{branch}", base.out);
    let mut args = vec!["diff"];
    if no_context {
        args.push("-U0");
    }
    args.push(&range);
    let diff = git(cwd, &args);
    if !diff.ok {
        return Err(BranchDiffFailure::DiffFailed);
    }
    Ok(diff.out)
}

/// A worktree's diff totals as a Ticket's Vitals show them: lines added and removed against HEAD, and
/// every file touched, untracked ones included, in the order git first named them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityDiff {
    pub added: u64,
    pub removed: u64,
    pub files: Vec<String>,
}

/// An untracked file this size or larger counts as touched, with no lines.
const UNTRACKED_MAX_BYTES: u64 = 256 * 1024;
/// Untracked files past this many are not counted.
const UNTRACKED_MAX_FILES: usize = 100;

/// The worktree's diff summary (server.ts's computeActivityDiff), read with git off the caller's thread
/// (issue #157), one run after the other (issue #161): `git diff --numstat HEAD` for tracked changes, a
/// binary file counting as a file without lines, then `git status --porcelain` for untracked files,
/// each counted as all-added lines. `None` when either git run fails.
pub async fn activity_diff(cwd: impl AsRef<Path>) -> Option<ActivityDiff> {
    let cwd = cwd.as_ref();
    let numstat = git_async(cwd, ["diff", "--numstat", "HEAD"]).await;
    let status = git_async(cwd, ["status", "--porcelain"]).await;
    if !numstat.ok || !status.ok {
        return None;
    }
    let mut lines: HashMap<String, (u64, u64)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut record = |path: String, added: u64, removed: u64| match lines.get_mut(&path) {
        Some(counts) => {
            counts.0 += added;
            counts.1 += removed;
        }
        None => {
            lines.insert(path.clone(), (added, removed));
            order.push(path);
        }
    };
    for line in numstat.out.split('\n') {
        if js_trim(line).is_empty() {
            continue;
        }
        let mut fields = line.split('\t');
        let added = fields.next().unwrap_or("");
        let removed = fields.next().unwrap_or("");
        let path = fields.collect::<Vec<_>>().join("\t");
        if path.is_empty() {
            continue;
        }
        record(path, numstat_count(added), numstat_count(removed));
    }
    let root = path_text(cwd);
    let mut untracked = 0;
    for line in status.out.split('\n') {
        let Some(listed) = line.strip_prefix("?? ") else {
            continue;
        };
        if untracked >= UNTRACKED_MAX_FILES {
            break;
        }
        untracked += 1;
        let path = unquoted(listed).to_string();
        let full = node_join(&[&root, &path]);
        let Ok(info) = tokio::fs::metadata(&full).await else {
            continue;
        };
        if !info.is_file() {
            continue;
        }
        if info.len() >= UNTRACKED_MAX_BYTES {
            // Over the read cap it still counts as a touched file, just with no line counts.
            record(path, 0, 0);
            continue;
        }
        let Ok(bytes) = tokio::fs::read(&full).await else {
            continue;
        };
        record(path, count_lines(&bytes), 0);
    }
    let added = order.iter().map(|path| lines[path].0).sum();
    let removed = order.iter().map(|path| lines[path].1).sum();
    Some(ActivityDiff {
        added,
        removed,
        files: order,
    })
}

// One count of a numstat line: `-` (a binary file) and anything that is not a number count as 0
// (`Number(x) || 0`).
fn numstat_count(field: &str) -> u64 {
    if field == "-" {
        return 0;
    }
    let n = js_number(field);
    if n.is_nan() { 0 } else { n as u64 }
}

// A porcelain path git quoted, with its quotes dropped (its escapes are kept, as the TypeScript keeps
// them).
fn unquoted(path: &str) -> &str {
    if path.starts_with('"') && path.ends_with('"') {
        path.get(1..path.len().saturating_sub(1)).unwrap_or("")
    } else {
        path
    }
}

// The lines in a file's text: its newlines, plus one for a last line that has none.
fn count_lines(text: &[u8]) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let newlines = text.iter().filter(|&&byte| byte == b'\n').count() as u64;
    if text.ends_with(b"\n") {
        newlines
    } else {
        newlines + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::Repo;
    use std::fs;

    #[test]
    fn summarizes_a_real_diff_between_two_revisions() {
        let repo = Repo::new();
        repo.write("base.txt", "base\ntwo\n");
        repo.git_ok(["commit", "-qam", "second"]);
        let summary = diff_stat_summary(repo.root(), "HEAD~1..HEAD");
        assert!(summary.contains("base.txt"), "{summary}");
        assert!(
            summary.ends_with("1 file changed, 1 insertion(+)"),
            "{summary}"
        );
    }

    #[test]
    fn reads_as_no_changes_for_an_empty_or_failing_diff() {
        let repo = Repo::new();
        assert_eq!(diff_stat_summary(repo.root(), "HEAD..HEAD"), "(no changes)");
        assert_eq!(
            diff_stat_summary(repo.root(), "not-a-real-ref..HEAD"),
            "(no changes)"
        );
    }

    #[test]
    fn diffs_a_branch_against_its_fork_point_not_the_moved_target() {
        let repo = Repo::new();
        repo.branch_writing("attempt", "work.txt", "one\ntwo\n");
        // A sibling merged onto main after the fork never shows in the attempt's diff.
        repo.write("sibling.txt", "sibling\n");
        repo.git_ok(["add", "-A"]);
        repo.git_ok(["commit", "-qm", "sibling"]);
        let diff = branch_diff(repo.root(), "attempt", false).unwrap();
        assert!(
            diff.starts_with("diff --git a/work.txt b/work.txt"),
            "{diff}"
        );
        assert!(diff.ends_with("+one\n+two"), "{diff}");
        assert!(!diff.contains("sibling"));
        let changed_only = branch_diff(repo.root(), "attempt", true).unwrap();
        assert!(changed_only.contains("@@ -0,0 +1,2 @@"), "{changed_only}");
    }

    #[test]
    fn says_why_a_branch_has_no_diff() {
        let repo = Repo::new();
        assert_eq!(
            branch_diff(repo.root(), "nope", false),
            Err(BranchDiffFailure::NoCommonAncestor)
        );
        repo.git_ok(["checkout", "-q", "--orphan", "island"]);
        repo.git_ok(["commit", "-qm", "island"]);
        repo.git_ok(["checkout", "-q", "main"]);
        assert_eq!(
            branch_diff(repo.root(), "island", true),
            Err(BranchDiffFailure::NoCommonAncestor)
        );
        assert_eq!(
            BranchDiffFailure::NoCommonAncestor.to_string(),
            "no common ancestor with the attempt branch"
        );
        assert_eq!(BranchDiffFailure::DiffFailed.to_string(), "git diff failed");
    }

    #[tokio::test]
    async fn totals_tracked_changes_and_untracked_files_in_order() {
        let repo = Repo::new();
        repo.write("gone.txt", "a\nb\nc\n");
        repo.write("bin.dat", "x");
        repo.git_ok(["add", "-A"]);
        repo.git_ok(["commit", "-qm", "more"]);
        repo.write("base.txt", "base\nadded\n");
        fs::remove_file(repo.path("gone.txt")).unwrap();
        fs::write(repo.path("bin.dat"), [0u8, 1, 2, 0, 9]).unwrap();
        repo.write("new.md", "one\ntwo");
        repo.write("empty.md", "");
        // A whole untracked directory is listed as the directory, which is no file, so it counts for
        // nothing.
        repo.write("newdir/inside.md", "x\n");
        let diff = activity_diff(repo.root()).await.unwrap();
        assert_eq!(
            diff,
            ActivityDiff {
                added: 1 + 2,
                removed: 3,
                files: vec![
                    "base.txt".to_string(),
                    "bin.dat".to_string(),
                    "gone.txt".to_string(),
                    "empty.md".to_string(),
                    "new.md".to_string(),
                ],
            }
        );
        assert_eq!(
            serde_json::to_string(&diff).unwrap(),
            r#"{"added":3,"removed":3,"files":["base.txt","bin.dat","gone.txt","empty.md","new.md"]}"#
        );
    }

    #[tokio::test]
    async fn counts_a_large_untracked_file_without_lines_and_caps_the_untracked_count() {
        let repo = Repo::new();
        repo.write("big.txt", &"line\n".repeat(60_000));
        for n in 0..120 {
            repo.write(&format!("f{n:03}.txt"), "x\n");
        }
        let diff = activity_diff(repo.root()).await.unwrap();
        assert_eq!(diff.files.len(), UNTRACKED_MAX_FILES);
        assert_eq!(diff.files[0], "big.txt");
        assert_eq!(diff.added, 99);
        assert_eq!(diff.removed, 0);
    }

    #[tokio::test]
    async fn reads_nothing_outside_a_checkout() {
        assert_eq!(activity_diff(Repo::bare_dir().root()).await, None);
    }

    #[test]
    fn reads_numstat_counts_and_quoted_paths_as_the_typescript_does() {
        assert_eq!(numstat_count("12"), 12);
        assert_eq!(numstat_count("-"), 0);
        assert_eq!(numstat_count("x"), 0);
        assert_eq!(unquoted("\"a b.txt\""), "a b.txt");
        assert_eq!(unquoted("\""), "");
        assert_eq!(unquoted("plain"), "plain");
        assert_eq!(count_lines(b""), 0);
        assert_eq!(count_lines(b"a"), 1);
        assert_eq!(count_lines(b"a\n"), 1);
        assert_eq!(count_lines(b"a\nb"), 2);
        assert_eq!(count_lines(b"\xef\xbb\xbf"), 1);
    }
}
