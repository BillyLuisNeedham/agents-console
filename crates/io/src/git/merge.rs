//! Merging done work into its merge target: the merge itself with its untracked-file pre-check (#92),
//! what a blocked merge tells the operator, the resolver's commit and the aborts, the three-way merge of
//! a Ticket file's two copies, and the merge steps of engine.ts that are git and files alone (the merge
//! checkout wrapper, and the Ticket file stepping aside for a merge in the pool's own checkout).

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::Path;

use anyhow::{Result, anyhow};

use super::repo::{current_branch, ref_exists, show_toplevel};
use super::runner::{GitOutput, GitProbe, git, run_git};
use super::worktrees::{WorktreeInfo, close_merge_checkout, err_or_out, open_merge_checkout};
use ac_core::js;

/// Why a merge did not land.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeFailure {
    /// Git started the merge and hit unmerged paths (named in `conflicted`); the engine aborted it and
    /// the resolver can reproduce it.
    Conflict,
    /// Git refused before starting, typically because the checkout holds untracked files the merge
    /// would overwrite (named in `blocked`); nothing conflicted, there is nothing for a resolver to
    /// resolve, and only the operator can clear the way.
    Blocked,
}

impl MergeFailure {
    /// The TypeScript's `reason`: `"conflict"` or `"blocked"`.
    pub fn as_str(self) -> &'static str {
        match self {
            MergeFailure::Conflict => "conflict",
            MergeFailure::Blocked => "blocked",
        }
    }
}

/// What came of merging a branch (worktrees.ts's MergeResult).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeResult {
    pub ok: bool,
    /// Why a failed merge failed; `None` when it landed.
    pub reason: Option<MergeFailure>,
    pub conflicted: Vec<String>,
    pub blocked: Vec<String>,
    /// Untracked files in the checkout that were byte-identical to the branch's version and were
    /// deleted so the merge could write them.
    pub cleared: Vec<String>,
    pub detail: String,
}

#[derive(Default)]
struct UntrackedInTheWay {
    blocked: Vec<String>,
    identical: Vec<String>,
}

// The checkout's top level: `git status` and `git diff --name-only` name paths relative to it whatever
// directory the pool runs in.
fn toplevel_of(repo_root: &Path) -> String {
    show_toplevel(repo_root).unwrap_or_else(|| js::path_text(repo_root))
}

// Untracked files in the checkout that merging `branch` would write: the intersection of the
// checkout's untracked entries with the files the branch changes against the merge base. Git refuses
// such a merge outright (#92), even when the file's bytes already match, so each one is sorted into
// byte-identical (safe to delete) or differing (the operator's call). Ignored files are not listed: git
// overwrites those without asking.
fn untracked_in_the_way(repo_root: &Path, branch: &str) -> UntrackedInTheWay {
    let mut way = UntrackedInTheWay::default();
    let base = git(repo_root, ["merge-base", "HEAD", branch]);
    if !base.ok || base.out.is_empty() {
        return way;
    }
    let touched: HashSet<String> = git(repo_root, ["diff", "--name-only", &base.out, branch])
        .out
        .split('\n')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect();
    if touched.is_empty() {
        return way;
    }
    let listing = git(repo_root, ["status", "--porcelain=v1", "-z", "-uall"]).out;
    let untracked: Vec<&str> = listing
        .split('\0')
        .filter_map(|entry| entry.strip_prefix("?? "))
        .filter(|path| touched.contains(*path))
        .collect();
    let toplevel = toplevel_of(repo_root);
    for path in untracked {
        // No blob on the branch means the branch deleted the file; the merge then has nothing to
        // write over the untracked copy.
        let theirs = git(
            repo_root,
            ["rev-parse", "-q", "--verify", &format!("{branch}:{path}")],
        );
        if !theirs.ok {
            continue;
        }
        let ours = git(
            repo_root,
            ["hash-object", "--", &js::path_join(&[&toplevel, path])],
        );
        if ours.ok && ours.out == theirs.out {
            way.identical.push(path.to_string());
        } else {
            way.blocked.push(path.to_string());
        }
    }
    way
}

// The paths git names when it refuses a merge before starting: the tab-indented lines of "The following
// untracked working tree files would be overwritten by merge:" and "Your local changes to the following
// files would be overwritten by merge:".
fn refused_paths(stderr: &str) -> Vec<String> {
    stderr
        .split('\n')
        .filter(|line| line.starts_with('\t'))
        .map(|line| js::trim(line).to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// Merge `branch` onto whatever the checkout at `repo_root` has checked out (the pool's working branch,
/// or the merge checkout's target). A failure aborts the merge so the working branch is never left
/// half-merged; the caller surfaces the conflict. A missing branch means a human finished the job by
/// hand and cleaned up, which counts as merged.
///
/// Before merging, untracked files in the checkout that the branch would overwrite are checked (#92):
/// byte-identical copies are deleted so the merge can proceed, and a differing copy blocks the merge
/// without starting it, reported as [`MergeFailure::Blocked`] rather than as a conflict. A merge git
/// refuses for any other reason before starting (no MERGE_HEAD, no unmerged paths) is classified the same
/// way, with git's own message as the detail. Fails only when an identical copy cannot be deleted.
pub fn merge_branch(repo_root: impl AsRef<Path>, branch: &str) -> Result<MergeResult> {
    let root = repo_root.as_ref();
    if !ref_exists(root, branch) {
        return Ok(MergeResult {
            ok: true,
            reason: None,
            conflicted: Vec::new(),
            blocked: Vec::new(),
            cleared: Vec::new(),
            detail: format!("branch {branch} is gone"),
        });
    }
    let way = untracked_in_the_way(root, branch);
    if !way.blocked.is_empty() {
        let detail = format!(
            "untracked files in the checkout would be overwritten by the merge and differ from the \
             branch's version: {}",
            way.blocked.join(", ")
        );
        return Ok(MergeResult {
            ok: false,
            reason: Some(MergeFailure::Blocked),
            conflicted: Vec::new(),
            blocked: way.blocked,
            cleared: Vec::new(),
            detail,
        });
    }
    let toplevel = toplevel_of(root);
    for path in &way.identical {
        remove_file_forced(&js::path_join(&[&toplevel, path]))?;
    }
    let cleared = way.identical;
    let cleared_note = if cleared.is_empty() {
        String::new()
    } else {
        format!(
            " (deleted untracked copies identical to the branch's: {})",
            cleared.join(", ")
        )
    };
    let merge = git(root, ["merge", "--no-edit", branch]);
    if merge.ok {
        return Ok(MergeResult {
            ok: true,
            reason: None,
            conflicted: Vec::new(),
            blocked: Vec::new(),
            cleared,
            detail: format!("{}{cleared_note}", merge.out),
        });
    }
    let conflicted: Vec<String> = git(root, ["diff", "--name-only", "--diff-filter=U"])
        .out
        .split('\n')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect();
    let in_progress = git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok;
    if in_progress {
        git(root, ["merge", "--abort"]);
    }
    let detail = format!("{}{cleared_note}", err_or_out(&merge));
    if conflicted.is_empty() && !in_progress {
        return Ok(MergeResult {
            ok: false,
            reason: Some(MergeFailure::Blocked),
            conflicted: Vec::new(),
            blocked: refused_paths(&merge.err),
            cleared,
            detail,
        });
    }
    Ok(MergeResult {
        ok: false,
        reason: Some(MergeFailure::Conflict),
        conflicted,
        blocked: Vec::new(),
        cleared,
        detail,
    })
}

/// Where a blocked merge's files are and what the operator does about them: the shared explanation the
/// engine's and the Conversation module's Interrupts both carry, so the two never describe the refusal
/// differently.
pub fn blocked_merge_explanation(repo_root: impl AsRef<Path>, result: &MergeResult) -> String {
    let files = if result.blocked.is_empty() {
        "(none named)".to_string()
    } else {
        result.blocked.join(", ")
    };
    format!(
        "git refused to start the merge; nothing conflicted and the working branch was not touched.\n\
         files in the way: {files}\n\
         these files are untracked in the pool directory ({}), or carry uncommitted changes there, and \
         differ from the branch's committed version. Move or delete them (commit them if tracked), then \
         resume; the merge is re-attempted on resume.\n",
        toplevel_of(repo_root.as_ref())
    )
}

/// Complete an in-progress merge in a worktree: the resolver leaves a staged resolution and a
/// MERGE_HEAD in the worktree, and committing turns it into a merge commit on the ticket's branch,
/// making the working branch an ancestor so the follow-up merge fast-forwards.
pub fn commit_merge(worktree: &WorktreeInfo) -> GitProbe {
    let message = format!("merge {} by resolver", worktree.branch);
    git(&worktree.path, ["commit", "-qm", &message])
}

/// Abandon a merge in progress in `cwd` (`git merge --abort`): a resolver's staged resolution
/// discarded, the parked branch restored.
pub fn merge_abort(cwd: impl AsRef<Path>) -> GitProbe {
    git(cwd, ["merge", "--abort"])
}

/// `git merge-file -p -L <ours> -L <base> -L <theirs> <ours> <base> <theirs>`, run where the process
/// runs (no `-C`): the three-way merge of a Ticket file's pool copy and branch copy against its seed.
/// The exit code is the conflict count, or above 127 on error (git's negative status); `code` is `None`
/// when git died on a signal, which the TypeScript's `exitCode` reads as null.
pub fn merge_file(labels: [&str; 3], paths: [&Path; 3]) -> GitOutput {
    let mut args: Vec<&OsStr> = vec![OsStr::new("merge-file"), OsStr::new("-p")];
    for label in labels {
        args.push(OsStr::new("-L"));
        args.push(OsStr::new(label));
    }
    args.extend(paths.iter().map(|path| path.as_os_str()));
    run_git(None, args)
}

/// Run `body` in a checkout that holds the merge target (issue #101, ADR-0021) and hand back what it
/// returns. Ordinarily that is the pool's own checkout (`repo_root`), whose HEAD is the target: with no
/// captured `merge_target`, or with the checkout found back on it (the operator moved it by hand), `body`
/// gets `repo_root` as its text. Otherwise an enlisted agent is working in the pool's checkout and the
/// engine never moves it back: the merge runs in a short-lived merge checkout on the target, removed as
/// soon as `body` returns, whatever it returned. Fails when the merge checkout cannot be opened.
pub fn with_merge_checkout<T>(
    repo_root: impl AsRef<Path>,
    merge_target: Option<&str>,
    body: impl FnOnce(&str) -> Result<T>,
) -> Result<T> {
    let root = js::path_text(repo_root.as_ref());
    let target = match merge_target {
        Some(target) if current_branch(&root) != target => target,
        _ => return body(&root),
    };
    let cwd = open_merge_checkout(&root, target)?;
    let result = body(&cwd);
    close_merge_checkout(&root, &cwd);
    result
}

/// A merge of a Ticket's branch and what it did to the Ticket file: `theirs` is the branch's copy as
/// the merge wrote it, or `None` when the merge failed or never touched the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedTicketFile {
    pub result: MergeResult,
    pub theirs: Option<String>,
}

/// The merge in the pool's own checkout (engine.ts's mergeInPlace): the pool copy of the Ticket file
/// steps aside to `<file>.pool-aside` (git refuses a merge that would touch a dirty file) and comes back
/// untouched when the merge failed or the branch never wrote it; when the branch did, the merge's write is
/// `theirs` and the caller reconciles over it. Fails as the file moves fail, and as [`merge_branch`]
/// fails, which leaves the pool copy aside.
pub fn merge_in_place(
    pool_checkout: impl AsRef<Path>,
    ticket_file: &str,
    branch: &str,
) -> Result<MergedTicketFile> {
    let aside = format!("{ticket_file}.pool-aside");
    fs::rename(ticket_file, &aside)
        .map_err(|err| anyhow!(js::FsError::rename(&err, ticket_file, &aside)))?;
    let result = merge_branch(pool_checkout, branch)?;
    if !result.ok || !Path::new(ticket_file).exists() {
        fs::rename(&aside, ticket_file)
            .map_err(|err| anyhow!(js::FsError::rename(&err, &aside, ticket_file)))?;
        return Ok(MergedTicketFile {
            result,
            theirs: None,
        });
    }
    let theirs = read_text(ticket_file)?;
    remove_file_forced(&aside)?;
    Ok(MergedTicketFile {
        result,
        theirs: Some(theirs),
    })
}

/// The merge in the engine's merge checkout (engine.ts's mergeInCheckout, issue #101): the pool copy is
/// not in the way there, so nothing steps aside. The branch's copy of the Ticket file (the file at the
/// same place relative to `checkout` as `ticket_file` is to `pool_checkout`) is `theirs` only when the
/// merge changed it, the same reading the in-place merge takes from the file it wrote.
pub fn merge_in_checkout(
    pool_checkout: impl AsRef<Path>,
    checkout: &str,
    ticket_file: &str,
    branch: &str,
) -> Result<MergedTicketFile> {
    let rel = js::path_relative(&js::path_text(pool_checkout.as_ref()), ticket_file);
    let copy = js::path_join(&[checkout, &rel]);
    let before = if Path::new(&copy).exists() {
        Some(read_text(&copy)?)
    } else {
        None
    };
    let result = merge_branch(checkout, branch)?;
    if !result.ok || !Path::new(&copy).exists() {
        return Ok(MergedTicketFile {
            result,
            theirs: None,
        });
    }
    let after = read_text(&copy)?;
    let theirs = (before.as_ref() != Some(&after)).then_some(after);
    Ok(MergedTicketFile { result, theirs })
}

// `readFileSync(path, "utf8")`, failing with Bun's texts: a directory is the read's EISDIR, which names
// no path.
fn read_text(path: &str) -> Result<String> {
    let bytes = fs::read(path).map_err(|err| match err.raw_os_error() {
        Some(libc::EISDIR) => anyhow!("EISDIR: illegal operation on a directory, read"),
        _ => anyhow!(js::FsError::new(&err, "open", path)),
    })?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// `rmSync(path, { force: true })`: a file, or nothing when there is nothing there. Bun reports a
// directory, or a path through a file, as EFAULT.
fn remove_file_forced(path: &str) -> Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => match err.raw_os_error() {
            Some(libc::EISDIR | libc::ENOTDIR) => Err(anyhow!(
                "EFAULT: bad address in system call argument, rm '{path}'"
            )),
            _ => Err(anyhow!(js::FsError::new(&err, "rm", path))),
        },
        Ok(()) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::Repo;
    use crate::git::worktrees::prepare_worktree;

    fn merge_head(repo: &Repo) -> bool {
        repo.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok
    }

    // merges blocked by untracked pool files (#92), worktrees.test.ts

    #[test]
    fn deletes_an_untracked_copy_identical_to_the_branchs_version_and_merges() {
        let repo = Repo::new();
        repo.branch_writing("feat", "findings/x.md", "fresh\n");
        repo.write("findings/x.md", "fresh\n");

        let result = merge_branch(repo.root(), "feat").unwrap();
        assert!(result.ok);
        assert_eq!(result.reason, None);
        assert_eq!(result.cleared, ["findings/x.md"]);
        assert!(result.blocked.is_empty());
        assert!(result.detail.contains("findings/x.md"));
        assert!(
            result
                .detail
                .ends_with(" (deleted untracked copies identical to the branch's: findings/x.md)")
        );
        // The branch's version is now the tracked one and the tree is clean.
        assert_eq!(repo.read("findings/x.md"), "fresh\n");
        assert_eq!(repo.git_ok(["ls-files", "findings/x.md"]), "findings/x.md");
        assert_eq!(repo.git_ok(["status", "--porcelain"]), "");
    }

    #[test]
    fn refuses_to_merge_over_an_untracked_copy_that_differs_without_starting_the_merge_and_merges_once_it_is_gone()
     {
        let repo = Repo::new();
        repo.branch_writing("feat", "findings/x.md", "fresh\n");
        repo.write("findings/x.md", "stale\n");
        let head_before = repo.git_ok(["rev-parse", "HEAD"]);

        let result = merge_branch(repo.root(), "feat").unwrap();
        assert!(!result.ok);
        assert_eq!(result.reason, Some(MergeFailure::Blocked));
        assert_eq!(result.blocked, ["findings/x.md"]);
        assert!(result.conflicted.is_empty());
        assert!(result.cleared.is_empty());
        assert_eq!(
            result.detail,
            "untracked files in the checkout would be overwritten by the merge and differ from the \
             branch's version: findings/x.md"
        );
        // Nothing was touched: the operator's copy is intact, no merge is in progress, and the working
        // branch did not move.
        assert_eq!(repo.read("findings/x.md"), "stale\n");
        assert!(!merge_head(&repo));
        assert_eq!(repo.git_ok(["rev-parse", "HEAD"]), head_before);

        fs::remove_file(repo.path("findings/x.md")).unwrap();
        let again = merge_branch(repo.root(), "feat").unwrap();
        assert!(again.ok);
        assert!(again.cleared.is_empty());
        assert_eq!(repo.read("findings/x.md"), "fresh\n");
    }

    #[test]
    fn ignores_untracked_files_the_branch_does_not_touch() {
        let repo = Repo::new();
        repo.branch_writing("feat", "findings/x.md", "fresh\n");
        repo.write("notes.md", "mine\n");

        let result = merge_branch(repo.root(), "feat").unwrap();
        assert!(result.ok);
        assert!(result.cleared.is_empty());
        assert_eq!(repo.read("notes.md"), "mine\n");
    }

    #[test]
    fn classifies_a_merge_git_refused_for_uncommitted_changes_as_blocked_not_conflicted() {
        let repo = Repo::new();
        repo.branch_writing("feat", "base.txt", "from-branch\n");
        // A tracked file with local changes the branch would overwrite: git refuses before starting,
        // with no MERGE_HEAD and no unmerged paths, the same signature as the untracked case.
        repo.write("base.txt", "dirty\n");

        let result = merge_branch(repo.root(), "feat").unwrap();
        assert!(!result.ok);
        assert_eq!(result.reason, Some(MergeFailure::Blocked));
        assert_eq!(result.blocked, ["base.txt"]);
        assert!(result.conflicted.is_empty());
        assert!(result.detail.contains("local changes"), "{}", result.detail);
        assert_eq!(repo.read("base.txt"), "dirty\n");
        assert!(!merge_head(&repo));
    }

    #[test]
    fn still_reports_a_merge_git_started_and_could_not_finish_as_a_conflict() {
        let repo = Repo::new();
        repo.branch_writing("feat", "base.txt", "from-branch\n");
        repo.write("base.txt", "from-main\n");
        repo.git_ok(["commit", "-qam", "main moves"]);

        let result = merge_branch(repo.root(), "feat").unwrap();
        assert!(!result.ok);
        assert_eq!(result.reason, Some(MergeFailure::Conflict));
        assert_eq!(result.conflicted, ["base.txt"]);
        assert!(result.blocked.is_empty());
        // Git's own words, from stderr or (with nothing there) stdout; rerere, when on, speaks first.
        assert!(!result.detail.is_empty());
        // Aborted, as before: the working branch is left clean.
        assert!(!merge_head(&repo));
        assert_eq!(repo.read("base.txt"), "from-main\n");
    }

    // the rest of the merge mechanics

    #[test]
    fn counts_a_gone_branch_as_merged() {
        let repo = Repo::new();
        let result = merge_branch(repo.root(), "pool/k/01").unwrap();
        assert_eq!(
            result,
            MergeResult {
                ok: true,
                reason: None,
                conflicted: vec![],
                blocked: vec![],
                cleared: vec![],
                detail: "branch pool/k/01 is gone".to_string(),
            }
        );
    }

    #[test]
    fn names_a_failure_as_the_typescript_reason() {
        assert_eq!(MergeFailure::Conflict.as_str(), "conflict");
        assert_eq!(MergeFailure::Blocked.as_str(), "blocked");
    }

    #[test]
    fn carries_gits_own_words_for_a_merge_that_landed() {
        let repo = Repo::new();
        repo.branch_writing("feat", "x.txt", "x\n");
        let result = merge_branch(repo.root(), "feat").unwrap();
        assert!(result.ok);
        assert!(result.detail.starts_with("Updating "), "{}", result.detail);
        assert!(result.detail.contains("Fast-forward"), "{}", result.detail);
        assert!(!result.detail.ends_with('\n'));
    }

    #[test]
    fn reads_refused_paths_from_gits_tab_indented_lines() {
        let stderr = "error: The following untracked working tree files would be overwritten by merge:\n\
                      \ta.txt\n\tdir/b.txt\n\t \nPlease move or remove them before you merge.\nAborting";
        assert_eq!(refused_paths(stderr), ["a.txt", "dir/b.txt"]);
        assert!(refused_paths("").is_empty());
    }

    #[test]
    fn explains_a_blocked_merge_with_the_files_and_the_pool_directory() {
        let repo = Repo::new();
        let mut result = MergeResult {
            ok: false,
            reason: Some(MergeFailure::Blocked),
            conflicted: vec![],
            blocked: vec!["a.txt".to_string(), "b.txt".to_string()],
            cleared: vec![],
            detail: String::new(),
        };
        let root = repo.root_text();
        assert_eq!(
            blocked_merge_explanation(repo.root(), &result),
            format!(
                "git refused to start the merge; nothing conflicted and the working branch was not \
                 touched.\nfiles in the way: a.txt, b.txt\nthese files are untracked in the pool \
                 directory ({root}), or carry uncommitted changes there, and differ from the branch's \
                 committed version. Move or delete them (commit them if tracked), then resume; the \
                 merge is re-attempted on resume.\n"
            )
        );
        result.blocked.clear();
        let sub = repo.path("deep/er");
        fs::create_dir_all(&sub).unwrap();
        let none_named = blocked_merge_explanation(&sub, &result);
        assert!(none_named.contains("files in the way: (none named)\n"));
        assert!(none_named.contains(&format!("pool directory ({root})")));
    }

    #[test]
    fn commits_a_resolvers_staged_resolution_so_the_branch_then_merges_clean() {
        let repo = Repo::new();
        let wt = prepare_worktree(repo.root(), "01", None, "HEAD").unwrap();
        fs::write(Path::new(&wt.path).join("base.txt"), "from-ticket\n").unwrap();
        git(&wt.path, ["commit", "-qam", "ticket"]);
        repo.write("base.txt", "from-main\n");
        repo.git_ok(["commit", "-qam", "main moves"]);
        assert_eq!(
            merge_branch(repo.root(), &wt.branch).unwrap().reason,
            Some(MergeFailure::Conflict)
        );

        // The resolver reproduces the merge in the worktree and stages a resolution.
        assert!(!git(&wt.path, ["merge", "--no-edit", "main"]).ok);
        fs::write(Path::new(&wt.path).join("base.txt"), "both\n").unwrap();
        git(&wt.path, ["add", "base.txt"]);
        let committed = commit_merge(&wt);
        assert!(committed.ok, "{}", committed.err);
        assert_eq!(
            git(&wt.path, ["log", "-1", "--format=%s"]).out,
            format!("merge {} by resolver", wt.branch)
        );
        let landed = merge_branch(repo.root(), &wt.branch).unwrap();
        assert!(landed.ok, "{}", landed.detail);
        assert_eq!(repo.read("base.txt"), "both\n");
    }

    #[test]
    fn aborts_a_merge_in_progress_restoring_the_branch() {
        let repo = Repo::new();
        repo.branch_writing("feat", "base.txt", "from-branch\n");
        repo.write("base.txt", "from-main\n");
        repo.git_ok(["commit", "-qam", "main moves"]);
        assert!(!repo.git(["merge", "--no-edit", "feat"]).ok);
        assert!(merge_head(&repo));
        assert!(merge_abort(repo.root()).ok);
        assert!(!merge_head(&repo));
        assert_eq!(repo.read("base.txt"), "from-main\n");
        // Nothing to abort reads as a failed probe and changes nothing.
        assert!(!merge_abort(repo.root()).ok);
    }

    #[test]
    fn merges_a_ticket_files_two_copies_against_its_seed_with_labels() {
        let dir = Repo::bare_dir();
        dir.write("pool", "a\nmine\nc\n");
        dir.write("seed", "a\nb\nc\n");
        dir.write("branch", "a\nb\nc\nbranch note\n");
        let paths = [dir.path("pool"), dir.path("seed"), dir.path("branch")];
        let labels = ["pool (file of record)", "seed", "branch pool/k/01"];
        let clean = merge_file(labels, [&paths[0], &paths[1], &paths[2]]);
        assert_eq!(clean.code, Some(0));
        assert_eq!(clean.stdout_text(), "a\nmine\nc\nbranch note\n");

        dir.write("branch", "a\ntheirs\nc\n");
        let conflicted = merge_file(labels, [&paths[0], &paths[1], &paths[2]]);
        assert_eq!(conflicted.code, Some(1));
        assert_eq!(
            conflicted.stdout_text(),
            "a\n<<<<<<< pool (file of record)\nmine\n=======\ntheirs\n>>>>>>> branch pool/k/01\nc\n"
        );
    }

    #[test]
    fn steps_the_ticket_file_aside_for_an_in_place_merge() {
        let repo = Repo::new();
        repo.write("pool/issues/01.md", "<!-- state -->\nspec\n");
        repo.git_ok(["add", "-A"]);
        repo.git_ok(["commit", "-qm", "ticket"]);
        let file = repo.path("pool/issues/01.md");
        let file = file.to_str().unwrap();

        // A branch that never touches the file: it comes back untouched, dirty as it was.
        repo.branch_writing("other", "x.txt", "x\n");
        repo.write("pool/issues/01.md", "<!-- state: done -->\nspec\n");
        let merged = merge_in_place(repo.root(), file, "other").unwrap();
        assert!(merged.result.ok, "{}", merged.result.detail);
        assert_eq!(merged.theirs, None);
        assert_eq!(
            repo.read("pool/issues/01.md"),
            "<!-- state: done -->\nspec\n"
        );
        assert!(!Path::new(&format!("{file}.pool-aside")).exists());

        // A branch that edits it: the merge's write is theirs, and the aside copy is gone.
        repo.git_ok(["checkout", "-q", "-b", "notes"]);
        repo.write(
            "pool/issues/01.md",
            "<!-- state -->\nspec\nnote from the branch\n",
        );
        repo.git_ok(["commit", "-qam", "note"]);
        repo.git_ok(["checkout", "-q", "main"]);
        repo.write("pool/issues/01.md", "<!-- state: done -->\nspec\n");
        let merged = merge_in_place(repo.root(), file, "notes").unwrap();
        assert!(merged.result.ok, "{}", merged.result.detail);
        assert_eq!(
            merged.theirs.as_deref(),
            Some("<!-- state -->\nspec\nnote from the branch\n")
        );
        assert!(!Path::new(&format!("{file}.pool-aside")).exists());

        // A failed merge puts the pool copy back.
        repo.git_ok(["checkout", "-q", "-b", "clash"]);
        repo.write("base.txt", "clash\n");
        repo.git_ok(["commit", "-qam", "clash"]);
        repo.git_ok(["checkout", "-q", "main"]);
        repo.write("base.txt", "main\n");
        repo.git_ok(["commit", "-qam", "main"]);
        repo.write("pool/issues/01.md", "<!-- state: done -->\nmine\n");
        let failed = merge_in_place(repo.root(), file, "clash").unwrap();
        assert_eq!(failed.result.reason, Some(MergeFailure::Conflict));
        assert_eq!(failed.theirs, None);
        assert_eq!(
            repo.read("pool/issues/01.md"),
            "<!-- state: done -->\nmine\n"
        );
    }

    #[test]
    fn a_ticket_file_that_cannot_step_aside_fails_with_buns_rename_message() {
        let repo = Repo::new();
        let file = format!("{}/missing.md", repo.root_text());
        let err = merge_in_place(repo.root(), &file, "main").unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("ENOENT: no such file or directory, rename '{file}' -> '{file}.pool-aside'")
        );
    }

    #[test]
    fn spells_the_file_failures_as_bun_does() {
        let dir = Repo::bare_dir();
        let root = dir.root_text();
        assert_eq!(
            read_text(&root).unwrap_err().to_string(),
            "EISDIR: illegal operation on a directory, read"
        );
        let missing = format!("{root}/missing");
        assert_eq!(
            read_text(&missing).unwrap_err().to_string(),
            format!("ENOENT: no such file or directory, open '{missing}'")
        );
        assert_eq!(
            remove_file_forced(&root).unwrap_err().to_string(),
            format!("EFAULT: bad address in system call argument, rm '{root}'")
        );
        dir.write("file", "x");
        let through = format!("{root}/file/inner");
        assert_eq!(
            remove_file_forced(&through).unwrap_err().to_string(),
            format!("EFAULT: bad address in system call argument, rm '{through}'")
        );
        remove_file_forced(&missing).unwrap();
    }

    #[test]
    fn merges_in_the_merge_checkout_reading_theirs_only_when_the_merge_changed_the_file() {
        let repo = Repo::new();
        repo.write("pool/issues/01.md", "<!-- state -->\nspec\n");
        repo.git_ok(["add", "-A"]);
        repo.git_ok(["commit", "-qm", "ticket"]);
        repo.git_ok(["branch", "target"]);
        repo.git_ok(["checkout", "-q", "-b", "notes", "target"]);
        repo.write("pool/issues/01.md", "<!-- state -->\nspec\nnote\n");
        repo.git_ok(["commit", "-qam", "note"]);
        repo.git_ok(["checkout", "-q", "-b", "other", "target"]);
        repo.write("x.txt", "x\n");
        repo.git_ok(["add", "-A"]);
        repo.git_ok(["commit", "-qm", "other"]);
        // The pool checkout moves off the target, as an enlist moves it.
        repo.git_ok(["checkout", "-q", "-b", "enlisted", "main"]);
        let file = repo.path("pool/issues/01.md");
        let file = file.to_str().unwrap();

        let merged = with_merge_checkout(repo.root(), Some("target"), |cwd| {
            assert_ne!(cwd, repo.root_text());
            merge_in_checkout(repo.root(), cwd, file, "other")
        })
        .unwrap();
        assert!(merged.result.ok, "{}", merged.result.detail);
        assert_eq!(merged.theirs, None);

        let merged = with_merge_checkout(repo.root(), Some("target"), |cwd| {
            merge_in_checkout(repo.root(), cwd, file, "notes")
        })
        .unwrap();
        assert!(merged.result.ok, "{}", merged.result.detail);
        assert_eq!(
            merged.theirs.as_deref(),
            Some("<!-- state -->\nspec\nnote\n")
        );
        // Both landed on the target, and the pool checkout never moved.
        assert_eq!(repo.git_ok(["branch", "--show-current"]), "enlisted");
        assert_eq!(
            repo.git_ok(["show", "target:pool/issues/01.md"]),
            "<!-- state -->\nspec\nnote"
        );
        assert!(
            repo.git(["merge-base", "--is-ancestor", "other", "target"])
                .ok
        );
    }

    #[test]
    fn runs_in_the_pool_checkout_unless_the_target_lives_elsewhere_and_always_closes_the_merge_checkout()
     {
        let repo = Repo::new();
        let root = repo.root_text();
        assert_eq!(
            with_merge_checkout(repo.root(), None, |cwd| Ok(cwd.to_string())).unwrap(),
            root
        );
        assert_eq!(
            with_merge_checkout(repo.root(), Some("main"), |cwd| Ok(cwd.to_string())).unwrap(),
            root
        );

        repo.git_ok(["checkout", "-q", "-b", "enlisted"]);
        let mut seen = String::new();
        let failed: Result<()> = with_merge_checkout(repo.root(), Some("main"), |cwd| {
            seen = cwd.to_string();
            assert_eq!(git(cwd, ["branch", "--show-current"]).out, "main");
            Err(anyhow!("the body failed"))
        });
        assert_eq!(failed.unwrap_err().to_string(), "the body failed");
        assert!(seen.ends_with("/.merge-checkout"), "{seen}");
        assert!(!Path::new(&seen).exists());
        assert!(
            !repo
                .git_ok(["worktree", "list", "--porcelain"])
                .contains(&seen)
        );

        // A target that cannot be checked out there fails with the open's own message.
        let err = with_merge_checkout(repo.root(), Some("nope"), |_| Ok(())).unwrap_err();
        assert!(
            err.to_string()
                .starts_with("the merge checkout on nope could not be opened: "),
            "{err}"
        );
    }
}
