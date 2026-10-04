//! Pool worktrees and branches (engine/worktrees.ts): the pool key, the names of a Ticket's branch and
//! worktree, preparing, reusing, removing and discarding them, the engine's merge checkout, and the ref
//! stamp behind the Merge hold memo.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

use ac_core::stat_cache::{file_stamp_at, now_ms};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::repo::ref_exists;
use super::runner::{GitProbe, git};
use ac_core::js;

/// Where a Ticket's work happens when it has a worktree of its own, and the branch checked out there.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
}

// Worktrees live inside the common git dir so they never appear in a checkout's status, where an
// in-place ticket could sweep one into a commit. The common dir is the main checkout's .git for every
// worktree of the repo; a linked worktree's own .git is a file, not a directory, so anchoring there would
// break ticket worktree creation. Each cache is keyed by the directory as the caller spelled it and keeps
// whatever it first computed, the fallback included, for the life of the process.
static COMMON_DIRS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

// The checkout's own git dir, where its HEAD lives: the common dir for the main checkout,
// `<common>/worktrees/<name>` for a linked one.
static GIT_DIRS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

static POOL_KEYS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

fn lock(cache: &Mutex<HashMap<String, String>>) -> MutexGuard<'_, HashMap<String, String>> {
    cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cached(
    cache: &Mutex<HashMap<String, String>>,
    key: &str,
    compute: impl FnOnce() -> String,
) -> String {
    if let Some(hit) = lock(cache).get(key) {
        return hit.clone();
    }
    // Computed outside the lock, since it runs git; should two callers race on a first use, the first
    // value stored is the one every caller gets, as in the TypeScript's one thread.
    let value = compute();
    lock(cache).entry(key.to_string()).or_insert(value).clone()
}

/// The repository's common git dir, absolute, or `<repo_root>/.git` when git cannot say.
pub fn git_common_dir(repo_root: impl AsRef<Path>) -> String {
    let root = js::path_text(repo_root.as_ref());
    cached(&COMMON_DIRS, &root, || {
        let probe = git(
            &root,
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        );
        if probe.ok && !probe.out.is_empty() {
            probe.out
        } else {
            js::path_join(&[&root, ".git"])
        }
    })
}

fn git_dir_of(repo_root: &str) -> String {
    cached(&GIT_DIRS, repo_root, || {
        let probe = git(repo_root, ["rev-parse", "--absolute-git-dir"]);
        if probe.ok && !probe.out.is_empty() {
            probe.out
        } else {
            js::path_join(&[repo_root, ".git"])
        }
    })
}

/// A stamp of the git state that decides, for these branches, whether each exists and whether it has
/// landed in the checkout's current branch (issue #157): the text of the checkout's HEAD, which names
/// that branch, and the file stamp of every place a ref by each name could live (the paths `git
/// rev-parse` tries, loose and packed, and a reftable's table list). Commits never change, so while no
/// ref moves the answers cannot move either, and git moves a ref by writing a lock file and renaming it
/// over the old one, which always changes the stamp. `None` when it cannot vouch: a ref file written
/// within the racy window, or a HEAD it cannot read.
pub fn ref_stamp<I, S>(repo_root: impl AsRef<Path>, branches: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let root = js::path_text(repo_root.as_ref());
    let git_dir = git_dir_of(&root);
    let common = git_common_dir(&root);
    let head = fs::read(js::path_join(&[&git_dir, "HEAD"])).ok()?;
    let head = String::from_utf8_lossy(&head).into_owned();
    let mut names: Vec<String> = branches
        .into_iter()
        .map(|name| name.as_ref().to_string())
        .collect();
    names.extend(head_branch(&head));
    let mut paths = vec![
        js::path_join(&[&common, "packed-refs"]),
        js::path_join(&[&common, "reftable", "tables.list"]),
    ];
    for name in &names {
        paths.extend([
            js::path_join(&[&git_dir, name]),
            js::path_join(&[&common, name]),
            js::path_join(&[&common, "refs", name]),
            js::path_join(&[&common, "refs", "tags", name]),
            js::path_join(&[&common, "refs", "heads", name]),
            js::path_join(&[&common, "refs", "remotes", name]),
            js::path_join(&[&common, "refs", "remotes", name, "HEAD"]),
        ]);
    }
    let now = now_ms();
    let mut stamps = vec![head];
    for path in &paths {
        stamps.push(file_stamp_at(path, now)?);
    }
    Some(stamps.join("\n"))
}

// The branch a HEAD file names, as `/^ref: refs\/heads\/(.+)$/m` and a trim read it: the first line
// (JavaScript's line terminators) that starts with the prefix and has something after it.
fn head_branch(head: &str) -> Option<String> {
    let line = head
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .find_map(|line| {
            line.strip_prefix("ref: refs/heads/")
                .filter(|rest| !rest.is_empty())
        })?;
    let name = js::trim(line);
    (!name.is_empty()).then(|| name.to_string())
}

/// The pool key: eight hex characters of the sha256 of the pool checkout's realpath. Two pools can share
/// one repo: two checkouts of it (a plain clone and a linked worktree, say) have distinct roots but one
/// common git dir, so a bare ticket id would collide on worktree paths and `pool/<id>` refs across pools,
/// proven live on 2026-09-05, when two engines of different pools shared one worktree concurrently. The
/// key namespaces by the pool's own directory, the identity a pool has on disk: deterministic across
/// restarts, distinct per pool, and independent of the pool's working branch, which a feature-branch
/// merge target changes.
///
/// Where the TypeScript's `realpathSync` would throw (nothing on disk at `repo_root`), the key is taken
/// from the path as given and not remembered, so naming stays total; a running pool's checkout always
/// exists. The functions that change disk ([`prepare_worktree`], [`open_merge_checkout`],
/// [`remove_stale_merge_checkout`]) go through [`try_pool_key_for`] instead and fail there, as the
/// TypeScript does, before any side effect.
pub fn pool_key_for(repo_root: impl AsRef<Path>) -> String {
    let root = js::path_text(repo_root.as_ref());
    try_pool_key_for(&root).unwrap_or_else(|_| key_of(&root))
}

/// The pool key, failing as `realpathSync` throws when there is nothing on disk at `repo_root`:
/// `ENOENT: no such file or directory, lstat '<repo_root>'`.
pub fn try_pool_key_for(repo_root: impl AsRef<Path>) -> Result<String> {
    let root = js::path_text(repo_root.as_ref());
    if let Some(hit) = lock(&POOL_KEYS).get(&root) {
        return Ok(hit.clone());
    }
    let real =
        js::realpath(&root).map_err(|err| anyhow!(js::FsError::new(&err, "lstat", &root)))?;
    let key = key_of(&js::path_text(&real));
    Ok(lock(&POOL_KEYS).entry(root).or_insert(key).clone())
}

fn key_of(real_path: &str) -> String {
    Sha256::digest(real_path.as_bytes())[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A Ticket's branch. The solo branch keeps the well-known name; a verify fan-out's attempt branches
/// suffix the attempt number. Dotted rather than slashed, so an attempt branch never collides with a
/// parked solo branch: git forbids refs where one is a prefix path of the other.
pub fn branch_for(repo_root: impl AsRef<Path>, ticket_id: &str, attempt: Option<u32>) -> String {
    let key = pool_key_for(repo_root);
    match attempt {
        None => format!("pool/{key}/{ticket_id}"),
        Some(n) => format!("pool/{key}/{ticket_id}.attempt-{n}"),
    }
}

/// A Ticket's worktree: `<common git dir>/pool-worktrees/<pool key>/<id>[.attempt-N]`.
pub fn worktree_path_for(
    repo_root: impl AsRef<Path>,
    ticket_id: &str,
    attempt: Option<u32>,
) -> String {
    let root = repo_root.as_ref();
    let leaf = match attempt {
        None => ticket_id.to_string(),
        Some(n) => format!("{ticket_id}.attempt-{n}"),
    };
    js::path_join(&[
        &git_common_dir(root),
        "pool-worktrees",
        &pool_key_for(root),
        &leaf,
    ])
}

/// Whether `path` is a directory the engine made for an Attempt: every pool worktree lives under the
/// repo's `pool-worktrees` root ([`worktree_path_for`]), and nothing else does. The test the engine's
/// folder-trust seed keys on: it vouches only for directories it created, never for the operator's own
/// checkout.
pub fn is_pool_worktree(path: &str) -> bool {
    path.split(['/', '\\']).any(|part| part == "pool-worktrees")
}

/// Whether this pool's branch for the Ticket (or its attempt) exists.
pub fn branch_exists(repo_root: impl AsRef<Path>, ticket_id: &str, attempt: Option<u32>) -> bool {
    let root = repo_root.as_ref();
    ref_exists(root, &branch_for(root, ticket_id, attempt))
}

/// The enlist branch rule's in-place half (issue #101): create `branch` at the found checkout's current
/// HEAD and check it out there, leaving the working tree untouched so uncommitted changes come along.
/// Used when the operator's pane sits on the pool's merge target, so the enlisted ticket has a branch of
/// its own to merge from without re-homing the checkout. A branch that already exists (a re-run, or a
/// hand-made branch) is checked out rather than recreated; the probe carries git's own message on
/// failure so the route can name the reason.
pub fn checkout_new_branch(cwd: impl AsRef<Path>, branch: &str) -> GitProbe {
    let cwd = cwd.as_ref();
    if ref_exists(cwd, branch) {
        return git(cwd, ["checkout", branch]);
    }
    git(cwd, ["checkout", "-b", branch])
}

/// Put an enlisted checkout back on the branch it was found on and delete the pool branch the enlist
/// created there (engine.ts's removeEnlistedBranch). Only the branch the engine made is removed; the
/// found branch is never deleted.
pub fn restore_found_branch(directory: impl AsRef<Path>, found_branch: &str, pool_branch: &str) {
    let directory = directory.as_ref();
    git(directory, ["checkout", found_branch]);
    git(directory, ["branch", "-D", pool_branch]);
}

// One entry of `git worktree list --porcelain`: its path, and its branch as a full ref (None on a
// detached HEAD).
struct RegisteredWorktree {
    path: String,
    branch: Option<String>,
}

fn registered_worktrees(repo_root: &Path) -> Vec<RegisteredWorktree> {
    let listing = git(repo_root, ["worktree", "list", "--porcelain"]).out;
    let mut trees: Vec<RegisteredWorktree> = Vec::new();
    for line in listing.split('\n') {
        if let Some(path) = line.strip_prefix("worktree ") {
            trees.push(RegisteredWorktree {
                path: path.to_string(),
                branch: None,
            });
        } else if let (Some(current), Some(branch)) =
            (trees.last_mut(), line.strip_prefix("branch "))
        {
            current.branch = Some(branch.to_string());
        }
    }
    trees
}

/// The Ticket's worktree, made or found. A parked branch or worktree (left by a checkpoint, a crash or a
/// conflict) is reused, so the ticket keeps the work it already did; the base is never moved under it.
/// Fresh tickets branch from `base`: the pool checkout's HEAD (`"HEAD"`, the TypeScript's default) unless
/// the engine's merge target lives elsewhere (issue #101). An attempt number names a verify fan-out's
/// per-attempt branch and worktree; attempt numbers never repeat for a ticket, so an attempt worktree is
/// always created fresh.
///
/// The reuse rule only trusts a worktree on this pool's own branch: two pools sharing one repo share the
/// worktree registry too, and the old bare-id paths let one pool silently adopt another's worktree,
/// proven live on 2026-09-05. A registered worktree at this path on any other branch (or a detached HEAD)
/// is foreign, and reusing it would graft one pool's parked work into another's run, so it is rejected
/// loudly.
pub fn prepare_worktree(
    repo_root: impl AsRef<Path>,
    ticket_id: &str,
    attempt: Option<u32>,
    base: &str,
) -> Result<WorktreeInfo> {
    let root = repo_root.as_ref();
    try_pool_key_for(root)?;
    let branch = branch_for(root, ticket_id, attempt);
    let path = worktree_path_for(root, ticket_id, attempt);
    git(root, ["worktree", "prune"]);
    let existing = registered_worktrees(root)
        .into_iter()
        .find(|tree| tree.path == path);
    if let Some(existing) = existing {
        if existing.branch.as_deref() != Some(format!("refs/heads/{branch}").as_str()) {
            return Err(anyhow!(
                "worktree {path} is checked out on {}, not this pool's {branch}; refusing to adopt a \
                 foreign pool's worktree",
                existing.branch.as_deref().unwrap_or("a detached HEAD")
            ));
        }
    } else {
        make_parent_dir(&path)?;
        let add = if branch_exists(root, ticket_id, attempt) {
            git(root, ["worktree", "add", &path, &branch])
        } else {
            git(root, ["worktree", "add", &path, "-b", &branch, base])
        };
        if !add.ok {
            return Err(anyhow!(
                "worktree add failed for ticket {ticket_id}: {}",
                err_or_out(&add)
            ));
        }
    }
    Ok(WorktreeInfo { path, branch })
}

/// The engine's short-lived merge checkout (issue #101, ADR-0021): a linked worktree on the pool's merge
/// target, used only once an enlist has moved the pool's own checkout onto a created pool branch and so
/// handed that checkout to the operator. One fixed path per pool, so a crash between open and close
/// leaves at most one stale worktree, which the next open prunes and replaces. The leading dot keeps it
/// apart from every ticket worktree beside it, since a ticket id never starts with one.
pub fn merge_checkout_path_for(repo_root: impl AsRef<Path>) -> String {
    let root = repo_root.as_ref();
    js::path_join(&[
        &git_common_dir(root),
        "pool-worktrees",
        &pool_key_for(root),
        ".merge-checkout",
    ])
}

/// Drop a merge checkout a dead engine left registered, so the merge target is not held between merges:
/// called at boot and before every open. Fails only when its directory cannot be removed.
pub fn remove_stale_merge_checkout(repo_root: impl AsRef<Path>) -> Result<()> {
    let root = repo_root.as_ref();
    try_pool_key_for(root)?;
    let path = merge_checkout_path_for(root);
    git(root, ["worktree", "prune"]);
    if registered_worktrees(root)
        .iter()
        .any(|tree| tree.path == path)
    {
        git(root, ["worktree", "remove", "--force", &path]);
    }
    remove_tree(&path)
}

/// Open the merge checkout on `branch` (the merge target) and return its path.
pub fn open_merge_checkout(repo_root: impl AsRef<Path>, branch: &str) -> Result<String> {
    let root = repo_root.as_ref();
    try_pool_key_for(root)?;
    let path = merge_checkout_path_for(root);
    remove_stale_merge_checkout(root)?;
    make_parent_dir(&path)?;
    let add = git(root, ["worktree", "add", &path, branch]);
    if !add.ok {
        return Err(anyhow!(
            "the merge checkout on {branch} could not be opened: {}",
            err_or_out(&add)
        ));
    }
    Ok(path)
}

/// Close the merge checkout. Its branch is the merge target: only the worktree goes, never the branch.
pub fn close_merge_checkout(repo_root: impl AsRef<Path>, path: &str) {
    git(repo_root, ["worktree", "remove", "--force", path]);
}

/// The worktree a branch is checked out in, or `None` when none has it. Git allows a branch in one
/// worktree at a time, so this is where a `worktree add` on that branch would be refused.
pub fn branch_checked_out_at(repo_root: impl AsRef<Path>, branch: &str) -> Option<String> {
    let root = repo_root.as_ref();
    git(root, ["worktree", "prune"]);
    let held = format!("refs/heads/{branch}");
    registered_worktrees(root)
        .into_iter()
        .find(|tree| tree.branch.as_deref() == Some(held.as_str()))
        .map(|tree| tree.path)
}

/// Remove a merged Ticket's worktree and branch. Only called once the branch has merged, so anything left
/// uncommitted in the worktree is debris; `--force` discards it. `branch -d` keeps a branch that has not
/// merged after all.
pub fn remove_worktree(repo_root: impl AsRef<Path>, info: &WorktreeInfo) {
    let root = repo_root.as_ref();
    git(root, ["worktree", "remove", "--force", &info.path]);
    git(root, ["branch", "-d", &info.branch]);
}

/// The attempt branches a verify ticket currently has on disk: every `pool/<key>/<id>.attempt-N` ref,
/// numbered, in git's order. Selection keeps the winner's branch and discards the rest, so a superseded
/// round's branches are cleaned up with the round that beat them. A suffix counts as JavaScript's
/// `Number` reads it as a whole number; one that is no attempt number Rust can hold is left out.
pub fn attempt_branches(repo_root: impl AsRef<Path>, ticket_id: &str) -> Vec<u32> {
    let root = repo_root.as_ref();
    let prefix = format!(
        "refs/heads/pool/{}/{ticket_id}.attempt-",
        pool_key_for(root)
    );
    let pattern = format!("{prefix}*");
    git(root, ["for-each-ref", "--format=%(refname)", &pattern])
        .out
        .split('\n')
        .filter_map(|refname| refname.strip_prefix(&prefix))
        .map(js::number_from_text)
        .filter(|n| n.is_finite() && n.fract() == 0.0)
        .filter(|n| (0.0..=f64::from(u32::MAX)).contains(n))
        .map(|n| n as u32)
        .collect()
}

/// Discard a losing verify attempt's branch and worktree. The branch never merged, so unlike
/// [`remove_worktree`] the deletion is forced: `-d` would refuse an unmerged branch. Anything uncommitted
/// in the worktree is debris by the same reading that lets [`remove_worktree`] force it. Missing pieces (a
/// pruned worktree, a branch a human already removed) probe as failures and are left alone.
pub fn discard_worktree(repo_root: impl AsRef<Path>, info: &WorktreeInfo) {
    let root = repo_root.as_ref();
    git(root, ["worktree", "remove", "--force", &info.path]);
    git(root, ["branch", "-D", &info.branch]);
}

// What a failed git run says: its stderr, or its stdout when stderr is empty (`err || out`).
pub(crate) fn err_or_out(probe: &GitProbe) -> &str {
    if probe.err.is_empty() {
        &probe.out
    } else {
        &probe.err
    }
}

// `mkdirSync(dirname(path), { recursive: true })`, failing with Bun's message for the directory it could
// not make.
fn make_parent_dir(path: &str) -> Result<()> {
    match Path::new(path).parent() {
        Some(parent) => make_dirs(parent)
            .map_err(|(err, at)| anyhow!(js::FsError::new(&err, "mkdir", js::path_text(&at)))),
        None => Ok(()),
    }
}

fn make_dirs(dir: &Path) -> Result<(), (io::Error, PathBuf)> {
    let made = |dir: &Path| match fs::create_dir(dir) {
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists && dir.is_dir() => Ok(()),
        other => other,
    };
    match made(dir) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => match dir.parent() {
            Some(parent) if !parent.as_os_str().is_empty() && parent != dir => {
                make_dirs(parent)?;
                made(dir).map_err(|err| (err, dir.to_path_buf()))
            }
            _ => Err((err, dir.to_path_buf())),
        },
        Err(err) => Err((err, dir.to_path_buf())),
    }
}

// `rmSync(path, { recursive: true, force: true })`: a file, a link or a whole tree, nothing when there is
// nothing there.
fn remove_tree(path: &str) -> Result<()> {
    let gone = |result: io::Result<()>| match result {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    };
    let removed = match fs::symlink_metadata(path) {
        Err(err) => gone(Err(err)),
        Ok(meta) if meta.is_dir() => gone(fs::remove_dir_all(path)),
        Ok(_) => gone(fs::remove_file(path)),
    };
    removed.map_err(|err| anyhow!(js::FsError::new(&err, "rm", path)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::{Repo, quiet_tree};

    fn porcelain(repo: &Repo) -> String {
        repo.git_ok(["worktree", "list", "--porcelain"])
    }

    // pool namespacing (worktrees.test.ts)

    #[test]
    fn keys_worktrees_and_branches_by_the_pool_directory_so_two_pools_on_one_repo_never_collide() {
        let a = Repo::new();
        let b = a.second_checkout();
        let key_a = pool_key_for(a.root());
        let key_b = pool_key_for(b.root());
        assert_ne!(key_a, key_b);
        assert!(
            key_a.len() == 8
                && key_a
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );

        let wa = prepare_worktree(a.root(), "02", None, "HEAD").unwrap();
        let wb = prepare_worktree(b.root(), "02", None, "HEAD").unwrap();
        assert_eq!(wa.branch, format!("pool/{key_a}/02"));
        assert_eq!(wb.branch, format!("pool/{key_b}/02"));
        assert_ne!(wa.branch, wb.branch);
        assert_eq!(
            wa.path,
            format!("{}/.git/pool-worktrees/{key_a}/02", a.root_text())
        );
        assert_ne!(wb.path, wa.path);
        assert!(wb.path.contains(&format!("pool-worktrees/{key_b}")));

        // Both worktrees are registered at once, each on its own pool's branch: the live incident had
        // two agents sharing one worktree concurrently.
        let listed = porcelain(&a);
        assert!(listed.contains(&format!("worktree {}", wa.path)));
        assert!(listed.contains(&format!("worktree {}", wb.path)));

        // The parked-worktree reuse rule survives the namespacing: a second prepare returns the same
        // worktree, and a pruned worktree over an existing branch is re-attached to that branch, not
        // rebranched.
        assert_eq!(prepare_worktree(a.root(), "02", None, "HEAD").unwrap(), wa);
        a.git_ok(["worktree", "remove", "--force", &wa.path]);
        assert_eq!(prepare_worktree(a.root(), "02", None, "HEAD").unwrap(), wa);
    }

    #[test]
    fn namespaces_attempt_branches_and_worktrees_the_same_way() {
        let a = Repo::new();
        let b = a.second_checkout();
        let aa = prepare_worktree(a.root(), "05", Some(1), "HEAD").unwrap();
        let ab = prepare_worktree(b.root(), "05", Some(1), "HEAD").unwrap();
        assert_eq!(
            aa.branch,
            format!("pool/{}/05.attempt-1", pool_key_for(a.root()))
        );
        assert_eq!(
            ab.branch,
            format!("pool/{}/05.attempt-1", pool_key_for(b.root()))
        );
        assert_ne!(aa.branch, ab.branch);
        assert_ne!(aa.path, ab.path);
        // A ref exists per pool for the same ticket id and attempt number.
        assert!(a.git(["rev-parse", "--verify", &aa.branch]).ok);
        assert!(a.git(["rev-parse", "--verify", &ab.branch]).ok);
        assert_eq!(attempt_branches(a.root(), "05"), [1]);
        assert_eq!(attempt_branches(b.root(), "05"), [1]);
    }

    #[test]
    fn rejects_a_registered_worktree_whose_checked_out_branch_belongs_to_another_pool() {
        let a = Repo::new();
        // A worktree at this pool's exact path, checked out on someone else's branch: adopting it would
        // graft foreign work into this pool's run.
        let foreign = worktree_path_for(a.root(), "02", None);
        fs::create_dir_all(Path::new(&foreign).parent().unwrap()).unwrap();
        a.git_ok(["worktree", "add", &foreign, "-b", "intruder", "HEAD"]);
        let refused = prepare_worktree(a.root(), "02", None, "HEAD").unwrap_err();
        assert_eq!(
            refused.to_string(),
            format!(
                "worktree {foreign} is checked out on refs/heads/intruder, not this pool's {}; \
                 refusing to adopt a foreign pool's worktree",
                branch_for(a.root(), "02", None)
            )
        );

        // A detached HEAD is no pool's branch, so it is foreign too.
        let detached = worktree_path_for(a.root(), "03", None);
        a.git_ok(["worktree", "add", "--detach", &detached, "HEAD"]);
        let refused = prepare_worktree(a.root(), "03", None, "HEAD").unwrap_err();
        assert!(
            refused
                .to_string()
                .contains("is checked out on a detached HEAD, not this pool's"),
            "{refused}"
        );
        assert!(
            refused
                .to_string()
                .ends_with("refusing to adopt a foreign pool's worktree")
        );

        // The rejection leaves the foreign worktree untouched for its owner.
        assert!(porcelain(&a).contains(&format!("worktree {foreign}")));
    }

    // the pool key and the names built on it

    #[test]
    fn keys_a_pool_by_the_sha256_of_its_checkout_realpath_whatever_spelling_reaches_it() {
        let a = Repo::new();
        let link_dir = Repo::bare_dir();
        let link = link_dir.path("via-link");
        std::os::unix::fs::symlink(a.root(), &link).unwrap();
        let expected: String = Sha256::digest(a.root_text().as_bytes())[..4]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(pool_key_for(a.root()), expected);
        assert_eq!(pool_key_for(&link), expected);
        assert_eq!(pool_key_for(format!("{}/", a.root_text())), expected);
    }

    #[test]
    fn a_missing_root_fails_the_disk_changes_before_any_side_effect() {
        let plain = Repo::bare_dir();
        let root = plain.path("gone");
        let root_text = js::path_text(&root);
        let missing = format!("ENOENT: no such file or directory, lstat '{root_text}'");
        assert_eq!(try_pool_key_for(&root).unwrap_err().to_string(), missing);
        assert_eq!(
            prepare_worktree(&root, "01", None, "HEAD")
                .unwrap_err()
                .to_string(),
            missing
        );
        assert_eq!(
            open_merge_checkout(&root, "main").unwrap_err().to_string(),
            missing
        );
        assert_eq!(
            remove_stale_merge_checkout(&root).unwrap_err().to_string(),
            missing
        );
        assert!(!root.exists());
        // Naming stays total, and nothing wrong is remembered for the root once it exists.
        assert_eq!(pool_key_for(&root), key_of(&root_text));
        fs::create_dir(&root).unwrap();
        assert_eq!(try_pool_key_for(&root).unwrap(), key_of(&root_text));
    }

    #[test]
    fn names_solo_and_attempt_branches_and_worktrees() {
        let a = Repo::new();
        let key = pool_key_for(a.root());
        assert_eq!(branch_for(a.root(), "01", None), format!("pool/{key}/01"));
        assert_eq!(
            branch_for(a.root(), "01", Some(3)),
            format!("pool/{key}/01.attempt-3")
        );
        let common = format!("{}/.git", a.root_text());
        assert_eq!(
            worktree_path_for(a.root(), "01", None),
            format!("{common}/pool-worktrees/{key}/01")
        );
        assert_eq!(
            worktree_path_for(a.root(), "01", Some(3)),
            format!("{common}/pool-worktrees/{key}/01.attempt-3")
        );
        assert_eq!(
            merge_checkout_path_for(a.root()),
            format!("{common}/pool-worktrees/{key}/.merge-checkout")
        );
        // A linked checkout keeps its worktrees in the shared common dir, under its own key.
        let b = a.second_checkout();
        assert_eq!(
            worktree_path_for(b.root(), "01", None),
            format!("{common}/pool-worktrees/{}/01", pool_key_for(b.root()))
        );
    }

    #[test]
    fn tells_a_pool_worktree_by_its_path() {
        assert!(is_pool_worktree("/r/.git/pool-worktrees/abcd1234/01"));
        assert!(is_pool_worktree("C:\\r\\.git\\pool-worktrees\\k\\01"));
        assert!(!is_pool_worktree("/r/pool-worktrees-not/01"));
        assert!(!is_pool_worktree("/home/me/project"));
    }

    #[test]
    fn finds_the_common_dir_from_any_checkout_and_falls_back_beside_a_plain_directory() {
        let a = Repo::new();
        let common = format!("{}/.git", a.root_text());
        assert_eq!(git_common_dir(a.root()), common);
        let b = a.second_checkout();
        assert_eq!(git_common_dir(b.root()), common);
        let sub = a.path("sub");
        fs::create_dir(&sub).unwrap();
        assert_eq!(git_common_dir(&sub), common);
        let plain = Repo::bare_dir();
        let inner = plain.path("inner");
        fs::create_dir(&inner).unwrap();
        assert_eq!(
            git_common_dir(&inner),
            format!("{}/inner/.git", plain.root_text())
        );
        // Remembered as first computed, the fallback included: a repository made around it later is not
        // seen.
        plain.git_ok(["init", "-q", "-b", "main"]);
        assert!(git(&inner, ["rev-parse", "--git-common-dir"]).ok);
        assert_eq!(
            git_common_dir(&inner),
            format!("{}/inner/.git", plain.root_text())
        );
    }

    #[test]
    fn branch_exists_reads_this_pools_branch_for_the_ticket() {
        let a = Repo::new();
        assert!(!branch_exists(a.root(), "01", None));
        prepare_worktree(a.root(), "01", None, "HEAD").unwrap();
        assert!(branch_exists(a.root(), "01", None));
        assert!(!branch_exists(a.root(), "01", Some(1)));
        let b = a.second_checkout();
        assert!(!branch_exists(b.root(), "01", None));
    }

    #[test]
    fn a_fresh_worktree_branches_from_the_base_it_is_given() {
        let a = Repo::new();
        a.branch_writing("target", "target.txt", "on target\n");
        let wt = prepare_worktree(a.root(), "07", None, "target").unwrap();
        assert!(Path::new(&wt.path).join("target.txt").exists());
        let head = git(&wt.path, ["rev-parse", "HEAD"]).out;
        assert_eq!(head, a.git_ok(["rev-parse", "target"]));
        // A parked branch is reused as it is: the base is never moved under it.
        a.git_ok(["worktree", "remove", "--force", &wt.path]);
        let again = prepare_worktree(a.root(), "07", None, "HEAD").unwrap();
        assert_eq!(again, wt);
        assert_eq!(git(&again.path, ["rev-parse", "HEAD"]).out, head);
    }

    #[test]
    fn a_failed_worktree_add_names_the_ticket_and_gits_reason() {
        let a = Repo::new();
        let err = prepare_worktree(a.root(), "08", None, "no-such-base").unwrap_err();
        let text = err.to_string();
        assert!(
            text.starts_with("worktree add failed for ticket 08: "),
            "{text}"
        );
        assert!(text.contains("no-such-base"), "{text}");
        assert!(!branch_exists(a.root(), "08", None));
    }

    #[test]
    fn a_worktree_directory_that_cannot_be_made_fails_with_buns_mkdir_message() {
        let a = Repo::new();
        let pool_worktrees = format!("{}/.git/pool-worktrees", a.root_text());
        fs::write(&pool_worktrees, "a file in the way").unwrap();
        let err = prepare_worktree(a.root(), "09", None, "HEAD").unwrap_err();
        assert_eq!(
            err.to_string(),
            format!(
                "ENOTDIR: not a directory, mkdir '{pool_worktrees}/{}'",
                pool_key_for(a.root())
            )
        );
    }

    #[test]
    fn checks_out_a_new_branch_in_place_keeping_uncommitted_changes_or_the_existing_one() {
        let a = Repo::new();
        a.write("base.txt", "dirty\n");
        let made = checkout_new_branch(a.root(), "pool/x/01");
        assert!(made.ok, "{}", made.err);
        assert_eq!(a.git_ok(["branch", "--show-current"]), "pool/x/01");
        assert_eq!(a.read("base.txt"), "dirty\n");
        a.git_ok(["checkout", "-q", "main"]);
        let again = checkout_new_branch(a.root(), "pool/x/01");
        assert!(again.ok, "{}", again.err);
        assert_eq!(a.git_ok(["branch", "--show-current"]), "pool/x/01");
        let refused = checkout_new_branch(a.root(), "bad..name");
        assert!(!refused.ok);
        assert!(!refused.err.is_empty());
    }

    #[test]
    fn restores_an_enlisted_checkout_to_its_found_branch_and_deletes_only_the_pool_branch() {
        let a = Repo::new();
        a.git_ok(["checkout", "-qb", "found"]);
        assert!(checkout_new_branch(a.root(), "pool/x/02").ok);
        restore_found_branch(a.root(), "found", "pool/x/02");
        assert_eq!(a.git_ok(["branch", "--show-current"]), "found");
        assert!(!a.git(["rev-parse", "--verify", "pool/x/02"]).ok);
        assert!(a.git(["rev-parse", "--verify", "found"]).ok);
    }

    // the merge checkout

    #[test]
    fn opens_the_merge_checkout_on_the_target_and_closes_it_without_touching_the_branch() {
        let a = Repo::new();
        a.git_ok(["branch", "target"]);
        let path = open_merge_checkout(a.root(), "target").unwrap();
        assert_eq!(path, merge_checkout_path_for(a.root()));
        assert_eq!(
            branch_checked_out_at(a.root(), "target"),
            Some(path.clone())
        );
        assert_eq!(git(&path, ["branch", "--show-current"]).out, "target");

        // A second open replaces the first: one fixed path per pool.
        assert_eq!(open_merge_checkout(a.root(), "target").unwrap(), path);
        close_merge_checkout(a.root(), &path);
        assert!(!Path::new(&path).exists());
        assert_eq!(branch_checked_out_at(a.root(), "target"), None);
        assert!(a.git(["rev-parse", "--verify", "target"]).ok);
    }

    #[test]
    fn a_merge_checkout_that_cannot_open_says_why() {
        let a = Repo::new();
        // main is checked out in the pool's own checkout, so git refuses a second worktree on it.
        let err = open_merge_checkout(a.root(), "main")
            .unwrap_err()
            .to_string();
        assert!(
            err.starts_with("the merge checkout on main could not be opened: "),
            "{err}"
        );
        assert!(err.contains("main"), "{err}");
    }

    #[test]
    fn drops_a_stale_merge_checkout_registered_or_left_as_a_bare_directory() {
        let a = Repo::new();
        a.git_ok(["branch", "target"]);
        let path = open_merge_checkout(a.root(), "target").unwrap();
        remove_stale_merge_checkout(a.root()).unwrap();
        assert!(!Path::new(&path).exists());
        assert!(!porcelain(&a).contains(&path));
        assert_eq!(branch_checked_out_at(a.root(), "target"), None);

        // A directory a crash left behind, never registered (or already pruned), goes too.
        fs::create_dir_all(Path::new(&path).join("debris")).unwrap();
        fs::write(Path::new(&path).join("debris/file"), "x").unwrap();
        remove_stale_merge_checkout(a.root()).unwrap();
        assert!(!Path::new(&path).exists());
        // Nothing there at all is fine.
        remove_stale_merge_checkout(a.root()).unwrap();
    }

    #[test]
    fn finds_the_worktree_holding_a_branch() {
        let a = Repo::new();
        assert_eq!(branch_checked_out_at(a.root(), "main"), Some(a.root_text()));
        let wt = prepare_worktree(a.root(), "04", None, "HEAD").unwrap();
        assert_eq!(
            branch_checked_out_at(a.root(), &wt.branch),
            Some(wt.path.clone())
        );
        // A worktree deleted by hand is pruned first, so its branch reads as free.
        fs::remove_dir_all(&wt.path).unwrap();
        assert_eq!(branch_checked_out_at(a.root(), &wt.branch), None);
        assert_eq!(branch_checked_out_at(a.root(), "nope"), None);
    }

    // removing and discarding

    #[test]
    fn removes_a_merged_worktree_and_its_branch_but_keeps_an_unmerged_branch() {
        let a = Repo::new();
        let merged = prepare_worktree(a.root(), "10", None, "HEAD").unwrap();
        fs::write(Path::new(&merged.path).join("debris.txt"), "x").unwrap();
        remove_worktree(a.root(), &merged);
        assert!(!Path::new(&merged.path).exists());
        assert!(!branch_exists(a.root(), "10", None));

        let unmerged = prepare_worktree(a.root(), "11", None, "HEAD").unwrap();
        fs::write(Path::new(&unmerged.path).join("work.txt"), "work\n").unwrap();
        git(&unmerged.path, ["add", "-A"]);
        git(&unmerged.path, ["commit", "-qm", "work"]);
        remove_worktree(a.root(), &unmerged);
        assert!(!Path::new(&unmerged.path).exists());
        assert!(branch_exists(a.root(), "11", None));
    }

    #[test]
    fn discards_a_losing_attempt_even_unmerged_and_leaves_missing_pieces_alone() {
        let a = Repo::new();
        let loser = prepare_worktree(a.root(), "12", Some(2), "HEAD").unwrap();
        fs::write(Path::new(&loser.path).join("work.txt"), "work\n").unwrap();
        git(&loser.path, ["add", "-A"]);
        git(&loser.path, ["commit", "-qm", "work"]);
        discard_worktree(a.root(), &loser);
        assert!(!Path::new(&loser.path).exists());
        assert!(!branch_exists(a.root(), "12", Some(2)));
        // Again, with both pieces gone: nothing to do and nothing thrown.
        discard_worktree(a.root(), &loser);
    }

    #[test]
    fn lists_only_this_tickets_attempt_numbers_in_gits_order() {
        let a = Repo::new();
        for n in [1, 2, 10] {
            prepare_worktree(a.root(), "05", Some(n), "HEAD").unwrap();
        }
        prepare_worktree(a.root(), "050", Some(4), "HEAD").unwrap();
        prepare_worktree(a.root(), "05", None, "HEAD").unwrap();
        assert_eq!(attempt_branches(a.root(), "05"), [1, 10, 2]);
        assert_eq!(attempt_branches(a.root(), "050"), [4]);
        assert!(attempt_branches(a.root(), "06").is_empty());
        // A suffix only JavaScript's Number reads as a whole number still counts; one it does not is
        // left out.
        let key = pool_key_for(a.root());
        a.git_ok(["branch", &format!("pool/{key}/07.attempt-1e1")]);
        a.git_ok(["branch", &format!("pool/{key}/07.attempt-x")]);
        a.git_ok(["branch", &format!("pool/{key}/07.attempt-1.5")]);
        assert_eq!(attempt_branches(a.root(), "07"), [10]);
    }

    // the ref stamp

    #[test]
    fn stamps_refs_only_once_quiet_and_moves_with_every_ref_change() {
        let a = Repo::new();
        let branch = branch_for(a.root(), "01", None);
        let branches = [branch.clone()];
        // Just written: nothing can be vouched for yet.
        assert_eq!(ref_stamp(a.root(), &branches), None);
        a.quiet_git_dir();
        let quiet = ref_stamp(a.root(), &branches).unwrap();
        assert!(quiet.starts_with("ref: refs/heads/main\n"));
        assert_eq!(ref_stamp(a.root(), &branches).unwrap(), quiet);

        a.branch_writing(&branch, "one.txt", "one\n");
        a.quiet_git_dir();
        let made = ref_stamp(a.root(), &branches).unwrap();
        assert_ne!(made, quiet);

        a.git_ok(["pack-refs", "--all"]);
        a.quiet_git_dir();
        let packed = ref_stamp(a.root(), &branches).unwrap();
        assert_ne!(packed, made);

        a.git_ok(["branch", "-D", &branch]);
        a.quiet_git_dir();
        let deleted = ref_stamp(a.root(), &branches).unwrap();
        assert_ne!(deleted, packed);

        // The target moved and its times put back at once: the rename git writes it with still moves
        // the stamp.
        let before = a.git_ok(["rev-parse", "main"]);
        a.write("two.txt", "two\n");
        a.git_ok(["add", "-A"]);
        a.git_ok(["commit", "-qm", "two"]);
        a.quiet_git_dir();
        let moved = ref_stamp(a.root(), &branches).unwrap();
        a.git_ok(["update-ref", "refs/heads/main", &before]);
        a.quiet_git_dir();
        assert_ne!(ref_stamp(a.root(), &branches).unwrap(), moved);
    }

    #[test]
    fn follows_a_linked_checkouts_own_head() {
        let a = Repo::new();
        let b = a.second_checkout();
        quiet_tree(&a.root().join(".git"));
        let stamp = ref_stamp(b.root(), Vec::<String>::new()).unwrap();
        assert!(stamp.starts_with("ref: refs/heads/companion\n"), "{stamp}");
        // Its target's loose ref is among the stamped paths: moving it moves the stamp.
        git(
            b.root(),
            ["commit", "-q", "--allow-empty", "-m", "on companion"],
        );
        quiet_tree(&a.root().join(".git"));
        assert_ne!(ref_stamp(b.root(), Vec::<String>::new()).unwrap(), stamp);
    }

    #[test]
    fn cannot_vouch_without_a_readable_head() {
        let plain = Repo::bare_dir();
        assert_eq!(ref_stamp(plain.root(), ["main"]), None);
    }

    #[test]
    fn reads_the_head_branch_as_the_typescript_regex_does() {
        assert_eq!(
            head_branch("ref: refs/heads/main\n").as_deref(),
            Some("main")
        );
        assert_eq!(
            head_branch("ref: refs/heads/main\r\n").as_deref(),
            Some("main")
        );
        assert_eq!(
            head_branch("ref: refs/heads/pool/k/01 \n").as_deref(),
            Some("pool/k/01")
        );
        assert_eq!(head_branch("0123456789abcdef\n"), None);
        assert_eq!(head_branch("ref: refs/heads/\n"), None);
        assert_eq!(head_branch("ref: refs/heads/   \n"), None);
        assert_eq!(
            head_branch("x\nref: refs/heads/second\n").as_deref(),
            Some("second")
        );
    }
}
