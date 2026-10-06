//! Questions asked of a checkout: does a ref exist, which branch is checked out, which commit, where is
//! the top level, has one branch landed in another. Each is one git run, read the way its TypeScript
//! call site reads it.

use std::path::Path;

use super::runner::{git, run_git};
use ac_core::js;

/// Whether `git rev-parse --verify <name>` resolves the name (worktrees.ts's refExists): a branch, a
/// tag, a full ref, `HEAD`, a commit.
pub fn ref_exists(cwd: impl AsRef<Path>, name: &str) -> bool {
    git(cwd, ["rev-parse", "--verify", name]).ok
}

/// Whether the pool can run in worktree mode: a real repo with at least one commit. Without one the
/// engine runs tickets in the main checkout.
pub fn git_available(repo_root: impl AsRef<Path>) -> bool {
    ref_exists(repo_root, "HEAD")
}

/// The checkout's current branch, or `main` when git names none (a detached HEAD, no checkout at all).
pub fn current_branch(repo_root: impl AsRef<Path>) -> String {
    let out = git(repo_root, ["branch", "--show-current"]).out;
    if out.is_empty() {
        "main".to_string()
    } else {
        out
    }
}

/// The branch checked out in `directory`, or `None` when the directory is not a checkout or HEAD is
/// detached (enlist.ts's branchAt).
pub fn branch_at(directory: impl AsRef<Path>) -> Option<String> {
    let probe = git(directory, ["branch", "--show-current"]);
    (probe.ok && !probe.out.is_empty()).then_some(probe.out)
}

/// The commit SHA the checkout or worktree at `cwd` is at, resolved with git at call time (ADR-0012).
/// Works in the main checkout and in any linked worktree of the same repo; `None` when git is unavailable
/// or the cwd is not a checkout with a HEAD, so a pool that does not run in git records the fact as
/// absent rather than as a wrong SHA.
pub fn commit_sha_at(cwd: impl AsRef<Path>) -> Option<String> {
    let probe = git(cwd, ["rev-parse", "HEAD"]);
    (probe.ok && !probe.out.is_empty()).then_some(probe.out)
}

/// What `git rev-parse <rev>` prints, even when it fails: rev-parse echoes a name it cannot resolve.
/// engine.ts's mergeTargetSha reads it this way.
pub fn rev_parse(cwd: impl AsRef<Path>, rev: &str) -> String {
    git(cwd, ["rev-parse", rev]).out
}

/// The top level of the checkout `cwd` is in, or `None` when it is in none. A pool worktree is a
/// checkout of its own, with its own top level.
pub fn show_toplevel(cwd: impl AsRef<Path>) -> Option<String> {
    let probe = git(cwd, ["rev-parse", "--show-toplevel"]);
    (probe.ok && !probe.out.is_empty()).then_some(probe.out)
}

/// The best common ancestor of two commits, or `None` when they share none or git cannot say.
pub fn merge_base(cwd: impl AsRef<Path>, a: &str, b: &str) -> Option<String> {
    let probe = git(cwd, ["merge-base", a, b]);
    probe.ok.then_some(probe.out)
}

/// Whether `branch` has landed in `target` (`git merge-base --is-ancestor`): the Merge hold's test.
pub fn is_ancestor(repo_root: impl AsRef<Path>, branch: &str, target: &str) -> bool {
    git(repo_root, ["merge-base", "--is-ancestor", branch, target]).ok
}

/// Whether `branch` has commits `target` lacks (`git rev-list --count <target>..<branch>` above 0): what
/// decides whether an ending Conversation has work to merge.
pub fn has_commits_beyond(cwd: impl AsRef<Path>, target: &str, branch: &str) -> bool {
    let range = format!("{target}..{branch}");
    let probe = git(cwd, ["rev-list", "--count", &range]);
    probe.ok && js::number_from_text(&probe.out) > 0.0
}

/// A file as committed at a revision (`git show <rev>:<path>`), whole and untrimmed, or `None` when git
/// cannot show it: the branch's or the merge base's copy of a Ticket file.
pub fn show_file(cwd: impl AsRef<Path>, spec: &str) -> Option<String> {
    let shown = run_git(Some(cwd.as_ref()), ["show", spec]);
    shown.ok().then(|| shown.stdout_text())
}

/// The checkout a pool runs in: the git top level holding the pool directory, canonical, or the pool
/// directory itself (canonical when it exists) when it is in no checkout (engine.ts's repoRootOf).
pub fn repo_root_of(pool_dir: impl AsRef<Path>) -> String {
    let pool_dir = pool_dir.as_ref();
    let probe = run_git(Some(pool_dir), ["rev-parse", "--show-toplevel"]);
    if probe.ok() {
        let root = js::trim(&probe.stdout_text()).to_string();
        if !root.is_empty() {
            return js::canonical_dir(&root);
        }
    }
    js::canonical_dir(&js::path_text(pool_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::Repo;
    use std::fs;

    #[test]
    fn resolves_refs_and_says_when_git_is_available() {
        let repo = Repo::new();
        assert!(ref_exists(repo.root(), "HEAD"));
        assert!(ref_exists(repo.root(), "main"));
        assert!(ref_exists(repo.root(), "refs/heads/main"));
        assert!(!ref_exists(repo.root(), "refs/heads/nope"));
        assert!(git_available(repo.root()));

        let unborn = Repo::bare_dir();
        assert!(!git_available(unborn.root()));
        unborn.git_ok(["init", "-q", "-b", "main"]);
        assert!(!git_available(unborn.root()));
    }

    #[test]
    fn reads_the_current_branch_with_main_when_git_names_none() {
        let repo = Repo::new();
        assert_eq!(current_branch(repo.root()), "main");
        assert_eq!(branch_at(repo.root()).as_deref(), Some("main"));
        repo.git_ok(["checkout", "-qb", "feature/x"]);
        assert_eq!(current_branch(repo.root()), "feature/x");
        assert_eq!(branch_at(repo.root()).as_deref(), Some("feature/x"));
        repo.git_ok(["checkout", "-q", "--detach"]);
        assert_eq!(current_branch(repo.root()), "main");
        assert_eq!(branch_at(repo.root()), None);

        let plain = Repo::bare_dir();
        assert_eq!(current_branch(plain.root()), "main");
        assert_eq!(branch_at(plain.root()), None);
    }

    #[test]
    fn reads_the_commit_a_checkout_is_at_or_none() {
        let repo = Repo::new();
        let sha = commit_sha_at(repo.root()).unwrap();
        assert_eq!(sha, repo.git_ok(["rev-parse", "HEAD"]));
        assert_eq!(rev_parse(repo.root(), "main"), sha);
        // An unknown name is echoed back, as the TypeScript read it.
        assert_eq!(rev_parse(repo.root(), "nope"), "nope");
        assert_eq!(commit_sha_at(Repo::bare_dir().root()), None);
    }

    #[test]
    fn finds_the_top_level_from_a_subdirectory_and_none_outside_a_checkout() {
        let repo = Repo::new();
        let sub = repo.path("a/b");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(show_toplevel(&sub), Some(repo.root_text()));
        assert_eq!(show_toplevel(Repo::bare_dir().root()), None);
    }

    #[test]
    fn answers_ancestry_merge_bases_and_commits_beyond() {
        let repo = Repo::new();
        let fork = repo.git_ok(["rev-parse", "HEAD"]);
        repo.branch_writing("feat", "x.txt", "x\n");
        assert_eq!(merge_base(repo.root(), "main", "feat"), Some(fork.clone()));
        assert_eq!(merge_base(repo.root(), "main", "nope"), None);
        assert!(!is_ancestor(repo.root(), "feat", "main"));
        assert!(is_ancestor(repo.root(), "main", "feat"));
        assert!(has_commits_beyond(repo.root(), "main", "feat"));
        assert!(!has_commits_beyond(repo.root(), "feat", "main"));
        assert!(!has_commits_beyond(repo.root(), "main", "nope"));
        repo.git_ok(["merge", "-q", "--no-edit", "feat"]);
        assert!(is_ancestor(repo.root(), "feat", "main"));
        assert!(!has_commits_beyond(repo.root(), "main", "feat"));
    }

    #[test]
    fn shows_a_committed_file_whole() {
        let repo = Repo::new();
        repo.branch_writing("feat", "notes.md", "line\n\n  indented  \n\n");
        assert_eq!(
            show_file(repo.root(), "feat:notes.md").as_deref(),
            Some("line\n\n  indented  \n\n")
        );
        assert_eq!(show_file(repo.root(), "main:notes.md"), None);
    }

    #[test]
    fn roots_a_pool_at_its_checkouts_top_level_canonically() {
        let repo = Repo::new();
        let pool = repo.path(".scratch/pool");
        fs::create_dir_all(&pool).unwrap();
        assert_eq!(repo_root_of(&pool), repo.root_text());

        // Reached through a symlink, the root is still the realpath.
        let links = Repo::bare_dir();
        let link = links.path("link");
        std::os::unix::fs::symlink(repo.root(), &link).unwrap();
        assert_eq!(repo_root_of(link.join(".scratch/pool")), repo.root_text());

        // Outside any checkout the pool directory is its own root; missing, it stays as given.
        let plain = Repo::bare_dir();
        assert_eq!(repo_root_of(plain.root()), plain.root_text());
        let missing = plain.path("missing");
        assert_eq!(repo_root_of(&missing), js::path_text(&missing));
    }
}
