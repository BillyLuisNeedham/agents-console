//! Boot's first job (issue #121; boot-pool.ts): work out which Pool directory this run is for, without
//! asking when the answer is already on disk. The operator runs `agent-console` from a project
//! checkout, so Boot has to go from a working directory to a pool the way a person would: is this a
//! pool, is there one under the project's `.scratch/`, are there several, or is this the first one and
//! it has to be created.
//!
//! The decision is pure apart from the filesystem reads; the git lookups arrive through [`RepoProbe`]
//! so it can be tested against a table of directories rather than a real repository.

use ac_core::js;
use ac_core::pool_title::read_pool_title;

/// The three markers that make a directory a Pool. `console.json` is the configured pool; a ticket file
/// under `issues/` is a ticket pool written by `to-tickets`; a `conversations/` directory is a Seeded
/// Pool's opt-in (ADR-0024) and counts even when it is empty.
pub fn is_pool_dir(dir: &str) -> bool {
    if !js::exists(dir) {
        return false;
    }
    if js::exists(js::path_join(&[dir, "console.json"])) {
        return true;
    }
    if js::exists(js::path_join(&[dir, "conversations"])) {
        return true;
    }
    count_tickets(dir) > 0
}

/// Ticket files in the pool's `issues/` directory, which is a legacy name.
pub fn count_tickets(dir: &str) -> usize {
    let issues = js::path_join(&[dir, "issues"]);
    if !js::exists(&issues) {
        return 0;
    }
    js::read_dir_names(&issues)
        .map(|names| names.iter().filter(|name| name.ends_with(".md")).count())
        .unwrap_or(0)
}

/// A name a directory can carry: lowercase, hyphens, nothing else. A branch's slashes become hyphens
/// too, so `feature/try-boot` reads as `feature-try-boot` rather than running its words together.
pub fn slugify(name: &str) -> String {
    let lower = js::trim(name).to_lowercase();
    // Runs of whitespace, underscores and slashes become one hyphen.
    let mut dashed = String::with_capacity(lower.len());
    let mut in_run = false;
    for c in lower.chars() {
        if js::is_whitespace(c) || c == '_' || c == '/' {
            if !in_run {
                dashed.push('-');
            }
            in_run = true;
        } else {
            dashed.push(c);
            in_run = false;
        }
    }
    let kept: String = dashed
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
        .collect();
    let mut collapsed = String::with_capacity(kept.len());
    for c in kept.chars() {
        if c == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(c);
    }
    let start = usize::from(collapsed.starts_with('-'));
    let end = if collapsed.len() > start && collapsed.ends_with('-') {
        collapsed.len() - 1
    } else {
        collapsed.len()
    };
    collapsed[start..end].to_owned()
}

/// What the repository probe has to answer for the decision below.
pub trait RepoProbe {
    /// The git toplevel containing `cwd`, or `None` when there is no checkout.
    fn toplevel(&self, cwd: &str) -> Option<String>;
    /// The checked-out branch, or `None` when the head is detached.
    fn branch(&self, cwd: &str) -> Option<String>;
}

/// Which Pool this Boot is for, or what is left to decide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolResolution {
    Found {
        dir: String,
        why: String,
    },
    Several {
        candidates: Vec<String>,
        scratch: String,
    },
    Create {
        scratch: String,
        suggested: String,
        why: String,
    },
    NoRepo {
        cwd: String,
    },
}

/// Which Pool this Boot is for. An explicit directory is taken as given, even when nothing is there
/// yet, because naming a directory is the operator saying where the pool belongs. Otherwise the working
/// directory decides: a pool is used in place, and a checkout looks under its own `.scratch/`.
pub fn resolve_pool(explicit: Option<&str>, cwd: &str, repo: &dyn RepoProbe) -> PoolResolution {
    if let Some(explicit) = explicit.filter(|dir| !dir.is_empty()) {
        return PoolResolution::Found {
            dir: explicit.to_owned(),
            why: "named on the command line".to_owned(),
        };
    }
    if is_pool_dir(cwd) {
        return PoolResolution::Found {
            dir: cwd.to_owned(),
            why: "the working directory is a pool".to_owned(),
        };
    }
    // A pool lives beside a checkout because its Attempts branch from one. Without a checkout there is
    // nothing for the pool to be about, so this is the one resolution that has no answer rather than a
    // question.
    let Some(top) = repo.toplevel(cwd) else {
        return PoolResolution::NoRepo {
            cwd: cwd.to_owned(),
        };
    };
    let scratch = js::path_join(&[&top, ".scratch"]);
    let mut candidates = scratch_pools(&scratch);
    if candidates.len() == 1 {
        return PoolResolution::Found {
            dir: candidates.remove(0),
            why: format!("the only pool under {scratch}"),
        };
    }
    if candidates.len() > 1 {
        return PoolResolution::Several {
            candidates,
            scratch,
        };
    }
    let suggested = repo
        .branch(&top)
        .map(|branch| slugify(&branch))
        .filter(|slug| !slug.is_empty())
        .unwrap_or_else(|| "pool".to_owned());
    PoolResolution::Create {
        why: format!("no pool under {scratch}"),
        scratch,
        suggested,
    }
}

/// The pool directories directly under a project's `.scratch/`, sorted.
pub fn scratch_pools(scratch: &str) -> Vec<String> {
    if !js::exists(scratch) {
        return Vec::new();
    }
    let Ok(names) = js::read_dir_names(scratch) else {
        return Vec::new();
    };
    let mut pools: Vec<String> = names
        .iter()
        .map(|name| js::path_join(&[scratch, name]))
        .filter(|dir| std::fs::metadata(dir).is_ok_and(|meta| meta.is_dir()) && is_pool_dir(dir))
        .collect();
    js::sort_strings(&mut pools);
    pools
}

/// What became of the `.scratch/` line in a checkout's private exclude file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Excluded {
    Added,
    Present,
    Unavailable,
}

/// Create the pool directory and keep `.scratch/` out of the project's history. The exclude goes in
/// `.git/info/exclude` rather than `.gitignore`: pools are this machine's working material, and a line
/// in the tracked ignore file would be a change to the project every operator has to carry.
pub fn create_pool(scratch: &str, slug: &str, git_dir: &str) -> Result<(String, Excluded), String> {
    let dir = js::path_join(&[scratch, slug]);
    js::mkdir_all(&dir).map_err(|err| err.to_string())?;
    let excluded = ensure_scratch_excluded(git_dir);
    Ok((dir, excluded))
}

/// Append `.scratch/` to the checkout's private exclude file when missing.
pub fn ensure_scratch_excluded(git_dir: &str) -> Excluded {
    let info = js::path_join(&[git_dir, "info"]);
    let file = js::path_join(&[&info, "exclude"]);
    let attempt = || -> Result<Excluded, js::FsError> {
        if js::exists(&file) {
            let text = js::read_text(&file)?;
            if text
                .split('\n')
                .map(js::trim)
                .any(|line| line == ".scratch/" || line == ".scratch")
            {
                return Ok(Excluded::Present);
            }
        } else {
            js::mkdir_all(&info)?;
        }
        let needs_newline = js::exists(&file) && !js::read_text(&file)?.ends_with('\n');
        js::append_file(
            &file,
            &format!("{}.scratch/\n", if needs_newline { "\n" } else { "" }),
        )?;
        Ok(Excluded::Added)
    };
    // A worktree or a submodule can put the git directory somewhere Boot cannot write. The pool still
    // works; only the exclude is missed.
    attempt().unwrap_or(Excluded::Unavailable)
}

/// The git probe Boot runs for real, shelling out the way the skill did.
pub struct RealRepoProbe;

impl RepoProbe for RealRepoProbe {
    fn toplevel(&self, cwd: &str) -> Option<String> {
        git_line(cwd, &["rev-parse", "--show-toplevel"])
    }

    fn branch(&self, cwd: &str) -> Option<String> {
        git_line(cwd, &["branch", "--show-current"])
    }
}

/// The `.git` directory for a checkout, which is a file in a worktree.
pub fn git_dir_of(top: &str) -> String {
    ac_io::git::absolute_git_dir(top)
}

/// `git -C <cwd> <args>`'s one trimmed line, or `None` when the directory is missing, git fails or it
/// prints nothing.
pub fn git_line(cwd: &str, args: &[&str]) -> Option<String> {
    ac_io::git::git_line(cwd, args)
}

/// The nearest existing ancestor of a path, itself included. A pool named on the command line may not
/// exist yet, and the git questions asked about it (which checkout is this, what does it commit) have
/// to be asked somewhere that does.
pub fn nearest_existing(dir: &str) -> String {
    let mut current = dir.to_owned();
    loop {
        if js::exists(&current) {
            return current;
        }
        let parent = dirname(&current);
        if parent == current {
            return current;
        }
        current = parent;
    }
}

/// Node's `path.dirname` for POSIX paths.
pub fn dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_owned();
    }
    match trimmed.rfind('/') {
        None => ".".to_owned(),
        Some(at) => {
            let head = trimmed[..at].trim_end_matches('/');
            if head.is_empty() {
                if absolute { "/" } else { "." }.to_owned()
            } else {
                head.to_owned()
            }
        }
    }
}

/// A pool's directory name, which is its identity.
pub fn pool_name(dir: &str) -> &str {
    js::basename(dir)
}

/// One pool in Boot's pick-a-pool list (issue #100): its Pool title with the directory beside it, since
/// the title is how the operator knows it and the directory is what it is; a pool with no title is its
/// directory alone.
pub fn pool_choice_line(dir: &str) -> String {
    match read_pool_title(dir) {
        Some(title) => format!("{title} ({})", pool_name(dir)),
        None => pool_name(dir).to_owned(),
    }
}

/// A directory name under `.scratch/` nothing already holds: the slug as it is when it is free, else the
/// slug with the first free `-2`, `-3`, ... on the end. A title is not unique, so two pools titled alike
/// must still land in two directories rather than one pool quietly adopting another's.
pub fn free_slug(scratch: &str, slug: &str) -> String {
    if !js::exists(js::path_join(&[scratch, slug])) {
        return slug.to_owned();
    }
    (2..)
        .map(|n| format!("{slug}-{n}"))
        .find(|candidate| !js::exists(js::path_join(&[scratch, candidate])))
        .expect("some suffix is free")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Probe {
        top: Option<String>,
        branch: Option<String>,
    }

    impl RepoProbe for Probe {
        fn toplevel(&self, _cwd: &str) -> Option<String> {
            self.top.clone()
        }
        fn branch(&self, _cwd: &str) -> Option<String> {
            self.branch.clone()
        }
    }

    fn probe(top: Option<&str>, branch: Option<&str>) -> Probe {
        Probe {
            top: top.map(str::to_owned),
            branch: branch.map(str::to_owned),
        }
    }

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn text(dir: &tempfile::TempDir) -> String {
        js::path_text(dir.path())
    }

    // A pool directory with tickets in it.
    fn ticket_pool(parent: &str, name: &str) -> String {
        let dir = js::path_join(&[parent, name]);
        fs::create_dir_all(js::path_join(&[&dir, "issues"])).unwrap();
        fs::write(
            js::path_join(&[&dir, "issues", "01-first.md"]),
            "<!-- state: id=01 -->\n# First\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn takes_an_explicit_directory_as_given() {
        let cwd = temp();
        assert_eq!(
            resolve_pool(Some("/tmp/named-pool"), &text(&cwd), &probe(None, None)),
            PoolResolution::Found {
                dir: "/tmp/named-pool".to_owned(),
                why: "named on the command line".to_owned()
            }
        );
    }

    #[test]
    fn uses_the_working_directory_when_it_is_itself_a_pool() {
        let root = temp();
        let pool = ticket_pool(&text(&root), "here");
        assert_eq!(
            resolve_pool(None, &pool, &probe(Some(&text(&root)), None)),
            PoolResolution::Found {
                dir: pool,
                why: "the working directory is a pool".to_owned()
            }
        );
    }

    #[test]
    fn counts_a_conversations_directory_as_a_pool_empty_or_not() {
        let root = temp();
        let pool = js::path_join(&[&text(&root), "seeded"]);
        fs::create_dir_all(js::path_join(&[&pool, "conversations"])).unwrap();
        assert!(is_pool_dir(&pool));
        assert!(!is_pool_dir(&js::path_join(&[&text(&root), "missing"])));
    }

    #[test]
    fn picks_the_only_pool_under_scratch() {
        let top = temp();
        let scratch = js::path_join(&[&text(&top), ".scratch"]);
        let pool = ticket_pool(&scratch, "only");
        let cwd = js::path_join(&[&text(&top), "src"]);
        assert_eq!(
            resolve_pool(None, &cwd, &probe(Some(&text(&top)), None)),
            PoolResolution::Found {
                dir: pool,
                why: format!("the only pool under {scratch}")
            }
        );
    }

    #[test]
    fn offers_a_choice_when_scratch_holds_several() {
        let top = temp();
        let scratch = js::path_join(&[&text(&top), ".scratch"]);
        let beta = ticket_pool(&scratch, "beta");
        let alpha = ticket_pool(&scratch, "alpha");
        // A plain directory is no pool, and a file is no directory.
        fs::create_dir_all(js::path_join(&[&scratch, "plain"])).unwrap();
        fs::write(js::path_join(&[&scratch, "note.md"]), "x").unwrap();
        assert_eq!(
            resolve_pool(None, &text(&top), &probe(Some(&text(&top)), None)),
            PoolResolution::Several {
                candidates: vec![alpha, beta],
                scratch
            }
        );
    }

    #[test]
    fn suggests_a_name_from_the_branch_when_there_is_no_pool_yet() {
        let top = temp();
        let scratch = js::path_join(&[&text(&top), ".scratch"]);
        let resolution = resolve_pool(
            None,
            &text(&top),
            &probe(Some(&text(&top)), Some("feature/Add Boot Script")),
        );
        assert_eq!(
            resolution,
            PoolResolution::Create {
                why: format!("no pool under {scratch}"),
                scratch: scratch.clone(),
                suggested: "feature-add-boot-script".to_owned(),
            }
        );
        // A detached head, or a branch that slugifies to nothing, suggests "pool".
        for branch in [None, Some("!!!")] {
            let PoolResolution::Create { suggested, .. } =
                resolve_pool(None, &text(&top), &probe(Some(&text(&top)), branch))
            else {
                panic!("expected a create");
            };
            assert_eq!(suggested, "pool");
        }
    }

    #[test]
    fn refuses_when_the_working_directory_is_not_in_a_checkout() {
        let cwd = temp();
        assert_eq!(
            resolve_pool(None, &text(&cwd), &probe(None, None)),
            PoolResolution::NoRepo { cwd: text(&cwd) }
        );
    }

    #[test]
    fn creates_the_pool_and_excludes_scratch_without_touching_gitignore() {
        let top = temp();
        let status = std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(top.path())
            .status()
            .unwrap();
        assert!(status.success());
        let git = js::path_join(&[&text(&top), ".git"]);
        let (dir, excluded) =
            create_pool(&js::path_join(&[&text(&top), ".scratch"]), "new-pool", &git).unwrap();
        assert!(js::exists(&dir));
        assert_eq!(excluded, Excluded::Added);
        let exclude = fs::read_to_string(js::path_join(&[&git, "info", "exclude"])).unwrap();
        assert!(exclude.contains(".scratch/"));
        assert!(!js::exists(js::path_join(&[&text(&top), ".gitignore"])));
        // Idempotent: a second boot finds the line already there.
        assert_eq!(ensure_scratch_excluded(&git), Excluded::Present);
    }

    #[test]
    fn appends_the_exclude_line_on_a_line_of_its_own() {
        let git = temp();
        let info = js::path_join(&[&text(&git), "info"]);
        fs::create_dir_all(&info).unwrap();
        let file = js::path_join(&[&info, "exclude"]);
        fs::write(&file, "# ours").unwrap();
        assert_eq!(ensure_scratch_excluded(&text(&git)), Excluded::Added);
        assert_eq!(fs::read_to_string(&file).unwrap(), "# ours\n.scratch/\n");
        fs::write(&file, "  .scratch  \n").unwrap();
        assert_eq!(ensure_scratch_excluded(&text(&git)), Excluded::Present);
        // A git dir that is a file cannot take an info/ directory.
        let not_dir = js::path_join(&[&text(&git), "plain-file"]);
        fs::write(&not_dir, "x").unwrap();
        assert_eq!(ensure_scratch_excluded(&not_dir), Excluded::Unavailable);
    }

    #[test]
    fn falls_back_to_the_nearest_existing_ancestor_for_a_pool_not_there_yet() {
        let root = temp();
        assert_eq!(
            nearest_existing(&js::path_join(&[&text(&root), "a", "b", "c"])),
            text(&root)
        );
        assert_eq!(nearest_existing(&text(&root)), text(&root));
    }

    #[test]
    fn slugifies_a_name_to_something_a_directory_can_be_called() {
        assert_eq!(slugify("My Pool_Name!"), "my-pool-name");
        assert_eq!(slugify("feature/try-boot"), "feature-try-boot");
        assert_eq!(slugify("  "), "");
        assert_eq!(
            slugify("feature/Add-Boot_Script"),
            "feature-add-boot-script"
        );
        assert_eq!(slugify("--a--b--"), "a-b");
        assert_eq!(slugify("!!!"), "");
        assert_eq!(slugify("café crème"), "caf-crme");
    }

    #[test]
    fn takes_dirname_as_node_does() {
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("/"), "/");
        assert_eq!(dirname("/a/b/"), "/a");
        assert_eq!(dirname("a"), ".");
        assert_eq!(dirname("a/b"), "a");
    }

    #[test]
    fn lists_a_titled_pool_by_its_title_with_the_directory_beside_it() {
        let root = temp();
        let scratch = js::path_join(&[&text(&root), ".scratch"]);
        let titled = ticket_pool(&scratch, "jev-integration");
        fs::write(
            js::path_join(&[&titled, "console.json"]),
            r#"{"title":"Jev as the grader"}"#,
        )
        .unwrap();
        let untitled = ticket_pool(&scratch, "other");
        assert_eq!(
            pool_choice_line(&titled),
            "Jev as the grader (jev-integration)"
        );
        assert_eq!(pool_choice_line(&untitled), "other");
    }

    #[test]
    fn lists_a_pool_whose_config_does_not_parse_by_its_directory() {
        let root = temp();
        let pool = ticket_pool(&js::path_join(&[&text(&root), ".scratch"]), "broken");
        fs::write(js::path_join(&[&pool, "console.json"]), "{ not json").unwrap();
        assert_eq!(pool_choice_line(&pool), "broken");
    }

    #[test]
    fn finds_a_free_slug_under_scratch() {
        let root = temp();
        let scratch = js::path_join(&[&text(&root), ".scratch"]);
        fs::create_dir_all(js::path_join(&[&scratch, "jev-as-the-grader"])).unwrap();
        fs::create_dir_all(js::path_join(&[&scratch, "taken"])).unwrap();
        fs::create_dir_all(js::path_join(&[&scratch, "taken-2"])).unwrap();
        assert_eq!(
            free_slug(&scratch, "jev-as-the-grader"),
            "jev-as-the-grader-2"
        );
        assert_eq!(free_slug(&scratch, "taken"), "taken-3");
        assert_eq!(free_slug(&scratch, "fresh"), "fresh");
    }
}
