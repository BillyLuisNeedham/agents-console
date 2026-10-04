//! Throwaway repositories for the git edge's tests, the shape worktrees.test.ts builds: a temp dir named
//! canonically, `main` with one commit of `base.txt`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tempfile::TempDir;

use super::node::path_text;
use super::runner::{GitProbe, git};

pub(crate) struct Repo {
    _dir: TempDir,
    root: PathBuf,
}

impl Repo {
    pub(crate) fn new() -> Repo {
        let repo = Repo::bare_dir();
        repo.write("base.txt", "base\n");
        repo.git_ok(["init", "-q", "-b", "main"]);
        repo.git_ok(["config", "user.email", "wt@test"]);
        repo.git_ok(["config", "user.name", "wt"]);
        repo.git_ok(["add", "-A"]);
        repo.git_ok(["commit", "-qm", "init"]);
        repo
    }

    /// An empty temp directory, no repository in it.
    pub(crate) fn bare_dir() -> Repo {
        let dir = tempfile::Builder::new().prefix("wt-").tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        Repo { _dir: dir, root }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn root_text(&self) -> String {
        path_text(&self.root)
    }

    pub(crate) fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    pub(crate) fn git<const N: usize>(&self, args: [&str; N]) -> GitProbe {
        git(&self.root, args)
    }

    pub(crate) fn git_ok<const N: usize>(&self, args: [&str; N]) -> String {
        let probe = self.git(args);
        assert!(probe.ok, "git {args:?}: {}", probe.err);
        probe.out
    }

    pub(crate) fn write(&self, rel: &str, content: &str) {
        let path = self.path(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    pub(crate) fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.path(rel)).unwrap()
    }

    /// A branch off main's current commit that commits `path` with `content`, leaving main checked out.
    pub(crate) fn branch_writing(&self, branch: &str, path: &str, content: &str) {
        self.git_ok(["checkout", "-qb", branch]);
        self.write(path, content);
        self.git_ok(["add", "-A"]);
        self.git_ok(["commit", "-qm", "work"]);
        self.git_ok(["checkout", "-q", "main"]);
    }

    /// A second checkout of the same repo: a linked worktree on its own branch, which is exactly the
    /// shape the live collision had, distinct pool directories, one shared common git dir, one shared
    /// ref namespace.
    pub(crate) fn second_checkout(&self) -> Repo {
        let base = Repo::bare_dir();
        let root = base.root.join("checkout");
        let root_text = path_text(&root);
        let add = self.git(["worktree", "add", &root_text, "-b", "companion", "HEAD"]);
        assert!(add.ok, "worktree add failed: {}", add.err);
        Repo {
            _dir: base._dir,
            root,
        }
    }

    /// Ages every file under the git dir out of the racy window, objects aside.
    pub(crate) fn quiet_git_dir(&self) {
        quiet_tree(&self.root.join(".git"));
    }
}

pub(crate) fn quiet_tree(dir: &Path) {
    let past = SystemTime::now() - Duration::from_secs(60 * 60);
    for entry in fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if entry.file_type().unwrap().is_dir() {
            if entry.file_name() != "objects" {
                quiet_tree(&path);
            }
        } else if entry.file_type().unwrap().is_file() {
            let file = fs::File::options().write(true).open(&path).unwrap();
            file.set_times(fs::FileTimes::new().set_accessed(past).set_modified(past))
                .unwrap();
        }
    }
}
