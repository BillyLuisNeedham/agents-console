//! Boot's Factory mode (issue #187, ADR-0037, ADR-0038): a Factory pool runs one Line on a branch of its
//! own, so Boot cuts `line/<slug>` from its Line base (the current branch, or `--from`'s) before there
//! is any pool, and the pool lives inside that branch's checkout. The base goes into the pool's
//! console.json as `lineBase`, so the Line knows what it was cut from (issue #193).
//!
//! The engine finds a pool's checkout from the pool directory (the git toplevel above it) and merges
//! into whatever that checkout has out. So Boot gives the Line branch a worktree of its own, at
//! `<checkout>/.scratch/lines/<slug>`, and makes the pool at `<that worktree>/.scratch/<name>`: the
//! pool's target branch is the Line's with no setting to keep in step, and the directory Boot was run
//! from keeps the branch it had, whatever else is running there.
//!
//! Then one of two starts. Asked for the work (an issue number or free text), Boot opens the Grill, a
//! Conversation on the Grill Station's skills with the work as its first Turn, and the operator's Start
//! the Line hands off from it. Given a ready brief (`--brief`), Boot commits the brief and its spec onto
//! the Line branch and starts Round 1 at once, with no Grill and no question asked.

use ac_protocol::LineBase;
use serde_json::{Map, Value};

use ac_core::js;
use ac_core::line::{BRIEF_DIR, BRIEF_SUFFIX, LINE_BRANCH_PREFIX, parse_brief};
use ac_core::pool_title::normalise_title;

use super::BootIo;
use super::pool::{Excluded, ensure_scratch_excluded, git_line, slugify};

/// Where Line worktrees go under the checkout Boot runs from.
pub const LINES_DIR: &str = "lines";

/// A ready brief Boot was handed: the brief as written, the spec's text, and the name its file gives.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadyBrief {
    pub brief: Map<String, Value>,
    pub spec_text: String,
    /// The spec's first `# ` heading, which titles the pool when nothing else does.
    pub heading: Option<String>,
    /// The brief's file name without `.brief.json`.
    pub stem: String,
}

/// What the Line starts from: the Grill's first Turn, or a ready brief.
#[derive(Debug, Clone, PartialEq)]
pub enum LineWork {
    Grill { work: String },
    Ready(Box<ReadyBrief>),
}

/// Read a ready brief. Its path is taken from `cwd`; the spec it names is looked for from `cwd` first,
/// then beside the brief, so a brief that names its spec either way works.
pub fn read_ready_brief(path: &str, cwd: &str) -> Result<ReadyBrief, String> {
    let file = js::path_join(&[cwd, path]);
    let file = if std::path::Path::new(path).is_absolute() {
        path.to_owned()
    } else {
        file
    };
    if !std::path::Path::new(&file).is_file() {
        return Err(format!("--brief {path}: no such file"));
    }
    let text = js::read_text(&file).map_err(|err| format!("--brief {path}: {err}"))?;
    let checked = parse_brief(&text).map_err(|reason| format!("--brief {path}: {reason}"))?;
    let Ok(Value::Object(brief)) = js::parse(&text) else {
        return Err(format!("--brief {path}: not a JSON object"));
    };
    let spec = js::trim(&checked.spec).to_owned();
    let beside = super::pool::dirname(&file);
    let candidates = if std::path::Path::new(&spec).is_absolute() {
        vec![spec.clone()]
    } else {
        vec![
            js::path_join(&[cwd, &spec]),
            js::path_join(&[&beside, &spec]),
        ]
    };
    let Some(found) = candidates
        .iter()
        .find(|candidate| std::path::Path::new(candidate).is_file())
    else {
        return Err(format!(
            "--brief {path}: its spec {spec} is neither under {cwd} nor beside the brief"
        ));
    };
    let spec_text = js::read_text(found).map_err(|err| format!("--brief {path}: {err}"))?;
    let name = js::basename(&file);
    let stem = name
        .strip_suffix(BRIEF_SUFFIX)
        .or_else(|| name.strip_suffix(".json"))
        .unwrap_or(name)
        .to_owned();
    Ok(ReadyBrief {
        brief,
        heading: first_heading(&spec_text),
        spec_text,
        stem,
    })
}

/// A markdown file's first `# ` heading.
pub fn first_heading(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix("# "))
        .and_then(normalise_title)
}

/// The issue number a piece of work names, when it is only that: `186` or `#186`.
pub fn issue_number(work: &str) -> Option<String> {
    let digits = js::trim(work).trim_start_matches('#');
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())).then(|| digits.to_owned())
}

/// The Line's slug when `--line` names none: the issue's number, the ready brief's name, or the first
/// words of the work.
pub fn derived_slug(work: &LineWork) -> String {
    let slug = match work {
        LineWork::Ready(ready) => slugify(&ready.stem),
        LineWork::Grill { work } => match issue_number(work) {
            Some(number) => number,
            None => {
                let words: Vec<&str> = work.split_whitespace().take(6).collect();
                let slug = slugify(&words.join(" "));
                slug.chars()
                    .take(40)
                    .collect::<String>()
                    .trim_end_matches('-')
                    .to_owned()
            }
        },
    };
    if slug.is_empty() {
        "line".to_owned()
    } else {
        slug
    }
}

/// The pool's title when `--title` gives none: the issue, the spec's heading, or the work itself.
pub fn derived_title(work: &LineWork, slug: &str) -> Option<String> {
    match work {
        LineWork::Ready(ready) => ready
            .heading
            .clone()
            .or_else(|| normalise_title(&format!("Line {slug}"))),
        LineWork::Grill { work } => match issue_number(work) {
            Some(number) => Some(format!("Issue #{number}")),
            None => normalise_title(work),
        },
    }
}

/// The standing orders of the Steward a Factory pool starts with (ADR-0037).
pub const STEWARD_ORDERS: &str = "Steward this Factory pool's Line while the operator is away: keep \
its Stations moving through the checkpoints that are yours to answer. The Finish checkpoint is the \
operator's: when the Line waits there, say in your pane where the Line stands and wait. End yourself \
once the Line is done.";

/// The Grill's first Turn: the work as the operator gave it, an issue number spelled out, and the Line
/// base it was cut from.
pub fn grill_opening(work: &str, base: &LineBase) -> String {
    let cut = format!(
        "This Line was cut from `{}` at `{}`.",
        base.base_ref,
        short_commit(&base.commit)
    );
    match issue_number(work) {
        Some(number) => format!(
            "The piece of work for this Line is issue #{number}. Read it (gh issue view {number}) \
             and grill me on it. {cut}"
        ),
        None => format!(
            "The piece of work for this Line:\n\n{}\n\n{cut}",
            js::trim(work)
        ),
    }
}

/// A commit as Boot shows it: its first seven characters.
pub fn short_commit(commit: &str) -> &str {
    commit.get(..7).unwrap_or(commit)
}

/// A slug whose `line/<slug>` branch and worktree directory are both free: the slug itself, else the
/// first `-2`, `-3`, … that is. A Line branch is never reused, since what is on it is another Line's.
pub fn free_line_slug(slug: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(slug) {
        return slug.to_owned();
    }
    (2..)
        .map(|n| format!("{slug}-{n}"))
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| slug.to_owned())
}

/// The branch `--from` names, as a full ref: a local branch, else a remote-tracking one as written
/// (`origin/x`), else origin's. Branches only: a tag, a commit or anything else is refused, naming what
/// was tried. Nothing is fetched; the refs are taken as they are.
pub fn resolve_from(name: &str, exists: impl Fn(&str) -> bool) -> Result<String, String> {
    let tried = [
        format!("refs/heads/{name}"),
        format!("refs/remotes/{name}"),
        format!("refs/remotes/origin/{name}"),
    ];
    tried
        .iter()
        .find(|full| exists(full))
        .cloned()
        .ok_or_else(|| {
            format!(
                "--from {name}: no branch {}, {} or {}; --from takes a branch (local or \
                 remote-tracking), never a tag or a commit",
                tried[0], tried[1], tried[2]
            )
        })
}

/// A full branch ref as the Line base names it: `experiment/x`, or `origin/experiment/x`.
pub fn short_ref(full: &str) -> &str {
    full.strip_prefix("refs/heads/")
        .or_else(|| full.strip_prefix("refs/remotes/"))
        .unwrap_or(full)
}

// The full ref the Line is cut from: `--from`'s branch, else the branch the checkout has out.
fn base_ref(top: &str, from: Option<&str>) -> Result<String, String> {
    match from {
        Some(name) => resolve_from(name, |full| {
            git_ok(top, &["show-ref", "--verify", "--quiet", full]).is_ok()
        }),
        None => git_line(top, &["symbolic-ref", "--quiet", "HEAD"]).ok_or_else(|| {
            format!(
                "{top} has a detached HEAD, so there is no current branch to cut the Line from: \
                 check out a branch, or pass --from <branch>"
            )
        }),
    }
}

fn git_ok(cwd: &str, args: &[&str]) -> Result<(), String> {
    let run = ac_io::git::run_git(Some(std::path::Path::new(cwd)), args.iter().copied());
    if run.code == Some(0) {
        Ok(())
    } else {
        Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&run.stderr).trim()
        ))
    }
}

/// The Line's checkout, cut and ready.
#[derive(Debug, Clone, PartialEq)]
pub struct CutLine {
    pub slug: String,
    pub branch: String,
    pub worktree: String,
    /// The Line base: the branch it was cut from and the commit it was cut at.
    pub base: LineBase,
}

/// Cut `line/<slug>` from its Line base (`from`, else the current branch) into its own worktree under
/// `<top>/.scratch/lines/`, keeping `.scratch/` out of the history the worktree shares. The Line branch
/// never tracks its base, so a bare `git push` of it can never land there.
pub fn cut_line(
    top: &str,
    slug: &str,
    from: Option<&str>,
    io: &mut dyn BootIo,
) -> Result<CutLine, String> {
    let from = base_ref(top, from)?;
    let lines = js::path_join(&[top, ".scratch", LINES_DIR]);
    let slug = free_line_slug(slug, |candidate| {
        let branch = format!("refs/heads/{LINE_BRANCH_PREFIX}{candidate}");
        git_line(top, &["rev-parse", "--verify", "--quiet", &branch]).is_some()
            || js::exists(js::path_join(&[&lines, candidate]))
    });
    let branch = format!("{LINE_BRANCH_PREFIX}{slug}");
    let worktree = js::path_join(&[&lines, &slug]);
    js::mkdir_all(&lines).map_err(|err| err.to_string())?;
    if let Some(common) = git_line(
        top,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) && ensure_scratch_excluded(&common) == Excluded::Added
    {
        io.log(&format!("added .scratch/ to {common}/info/exclude"));
    }
    git_ok(
        top,
        &[
            "worktree",
            "add",
            "-q",
            "--no-track",
            "-b",
            &branch,
            &worktree,
            &from,
        ],
    )?;
    // The commit the new branch points at is the cut, whatever the base does afterwards.
    let commit = git_line(
        top,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}^{{commit}}"),
        ],
    )
    .ok_or_else(|| format!("{branch} was cut but has no commit"))?;
    Ok(CutLine {
        slug,
        branch,
        worktree,
        base: LineBase {
            base_ref: short_ref(&from).to_owned(),
            commit,
        },
    })
}

/// Commit a ready brief and its spec onto the Line branch as `docs/specs/<slug>.md` and
/// `docs/specs/<slug>.brief.json`, the brief's spec renamed to match. Answers the brief's path in the
/// Line's checkout, which Start the Line is then given.
pub fn commit_ready_brief(line: &CutLine, ready: &ReadyBrief) -> Result<String, String> {
    let spec_path = format!("{BRIEF_DIR}/{}.md", line.slug);
    let brief_path = format!("{BRIEF_DIR}/{}{BRIEF_SUFFIX}", line.slug);
    let mut brief = ready.brief.clone();
    brief.insert("spec".to_owned(), Value::String(spec_path.clone()));
    js::mkdir_all(js::path_join(&[&line.worktree, BRIEF_DIR])).map_err(|err| err.to_string())?;
    js::write_file(
        js::path_join(&[&line.worktree, &spec_path]),
        &ready.spec_text,
    )
    .map_err(|err| err.to_string())?;
    let text =
        serde_json::to_string_pretty(&Value::Object(brief)).map_err(|err| err.to_string())?;
    js::write_file(
        js::path_join(&[&line.worktree, &brief_path]),
        &format!("{text}\n"),
    )
    .map_err(|err| err.to_string())?;
    git_ok(&line.worktree, &["add", "--", &spec_path, &brief_path])?;
    let message = format!("Write down the spec and the Line brief for {}", line.branch);
    let mut commit: Vec<&str> = Vec::new();
    // A machine with no git identity still gets its Line: the commit says who made it.
    if git_line(&line.worktree, &["config", "user.email"]).is_none() {
        commit.extend([
            "-c",
            "user.name=agent-console",
            "-c",
            "user.email=agent-console@localhost",
        ]);
    }
    commit.extend(["commit", "-q", "-m", &message]);
    git_ok(&line.worktree, &commit)?;
    Ok(brief_path)
}

/// Lay `--config`'s keys over the pool's config, each top-level key replacing the one there.
pub fn overlay_config(
    config: &mut Map<String, Value>,
    path: &str,
    cwd: &str,
) -> Result<(), String> {
    let file = if std::path::Path::new(path).is_absolute() {
        path.to_owned()
    } else {
        js::path_join(&[cwd, path])
    };
    let text = js::read_text(&file).map_err(|err| format!("--config {path}: {err}"))?;
    let Ok(Value::Object(extra)) = js::parse(&text) else {
        return Err(format!("--config {path}: not a JSON object"));
    };
    for (key, value) in extra {
        config.insert(key, value);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_issue_number_with_or_without_its_hash() {
        assert_eq!(issue_number("186"), Some("186".to_owned()));
        assert_eq!(issue_number(" #179 "), Some("179".to_owned()));
        assert_eq!(issue_number("fix #179"), None);
        assert_eq!(issue_number("#"), None);
    }

    #[test]
    fn derives_the_slug_from_the_issue_the_brief_or_the_first_words() {
        let grill = |work: &str| LineWork::Grill {
            work: work.to_owned(),
        };
        assert_eq!(derived_slug(&grill("#186")), "186");
        assert_eq!(
            derived_slug(&grill(
                "Make the header strip show the Round and the Station too"
            )),
            "make-the-header-strip-show-the"
        );
        assert_eq!(derived_slug(&grill("!!!")), "line");
        let ready = LineWork::Ready(Box::new(ReadyBrief {
            brief: Map::new(),
            spec_text: String::new(),
            heading: None,
            stem: "186".to_owned(),
        }));
        assert_eq!(derived_slug(&ready), "186");
        assert_eq!(derived_title(&ready, "186"), Some("Line 186".to_owned()));
        assert_eq!(
            derived_title(&grill("#186"), "186"),
            Some("Issue #186".to_owned())
        );
    }

    #[test]
    fn a_taken_slug_takes_the_first_free_number() {
        let taken = ["186", "186-2"];
        assert_eq!(free_line_slug("186", |s| taken.contains(&s)), "186-3");
        assert_eq!(free_line_slug("179", |s| taken.contains(&s)), "179");
    }

    #[test]
    fn the_grill_opening_spells_out_an_issue_keeps_free_text_and_names_the_base() {
        let base = LineBase {
            base_ref: "experiment/x".to_owned(),
            commit: "abc1234def5678".to_owned(),
        };
        let issue = grill_opening("#186", &base);
        assert!(issue.starts_with("The piece of work for this Line is issue #186."));
        assert!(issue.ends_with("This Line was cut from `experiment/x` at `abc1234`."));
        assert_eq!(
            grill_opening("  tidy the header  ", &base),
            "The piece of work for this Line:\n\ntidy the header\n\nThis Line was cut from \
             `experiment/x` at `abc1234`."
        );
    }

    #[test]
    fn from_resolves_a_local_branch_then_a_remote_tracking_one_then_origins() {
        let refs = [
            "refs/heads/experiment/x",
            "refs/remotes/origin/experiment/x",
            "refs/remotes/origin/only-remote",
            "refs/remotes/upstream/y",
        ];
        let exists = |full: &str| refs.contains(&full);
        assert_eq!(
            resolve_from("experiment/x", exists).unwrap(),
            "refs/heads/experiment/x"
        );
        assert_eq!(
            resolve_from("origin/experiment/x", exists).unwrap(),
            "refs/remotes/origin/experiment/x"
        );
        assert_eq!(
            resolve_from("only-remote", exists).unwrap(),
            "refs/remotes/origin/only-remote"
        );
        assert_eq!(
            resolve_from("upstream/y", exists).unwrap(),
            "refs/remotes/upstream/y"
        );
        assert_eq!(
            resolve_from("v1.0", exists).unwrap_err(),
            "--from v1.0: no branch refs/heads/v1.0, refs/remotes/v1.0 or refs/remotes/origin/v1.0; \
             --from takes a branch (local or remote-tracking), never a tag or a commit"
        );
        assert_eq!(short_ref("refs/heads/experiment/x"), "experiment/x");
        assert_eq!(
            short_ref("refs/remotes/origin/experiment/x"),
            "origin/experiment/x"
        );
        assert_eq!(short_commit("abc1234def"), "abc1234");
        assert_eq!(short_commit("abc"), "abc");
    }

    #[test]
    fn the_first_heading_titles_the_spec() {
        assert_eq!(
            first_heading("intro\n# The title\n## Not this"),
            Some("The title".to_owned())
        );
        assert_eq!(first_heading("## only a second level"), None);
    }

    #[test]
    fn reads_a_brief_whose_spec_is_under_the_cwd_or_beside_it() {
        let dir = std::env::temp_dir().join(format!("ac-ready-brief-{}", std::process::id()));
        let dir = js::path_text(&dir);
        let pilots = js::path_join(&[&dir, "pilots"]);
        js::mkdir_all(&pilots).unwrap();
        js::write_file(js::path_join(&[&pilots, "186.md"]), "# Fix it\n\nbody\n").unwrap();
        js::write_file(
            js::path_join(&[&pilots, "186.brief.json"]),
            r#"{"spec": "pilots/186.md", "finish": "draft-pr", "factory": {}}"#,
        )
        .unwrap();
        js::write_file(
            js::path_join(&[&pilots, "beside.brief.json"]),
            r#"{"spec": "186.md"}"#,
        )
        .unwrap();
        let ready = read_ready_brief("pilots/186.brief.json", &dir).unwrap();
        assert_eq!(ready.stem, "186");
        assert_eq!(ready.heading.as_deref(), Some("Fix it"));
        assert_eq!(
            ready.brief.get("finish"),
            Some(&Value::String("draft-pr".into()))
        );
        assert_eq!(
            read_ready_brief("pilots/beside.brief.json", &dir)
                .unwrap()
                .spec_text,
            "# Fix it\n\nbody\n"
        );
        js::write_file(
            js::path_join(&[&pilots, "lost.brief.json"]),
            r#"{"spec": "nowhere.md"}"#,
        )
        .unwrap();
        assert_eq!(
            read_ready_brief("pilots/lost.brief.json", &dir).unwrap_err(),
            format!(
                "--brief pilots/lost.brief.json: its spec nowhere.md is neither under {dir} nor beside the brief"
            )
        );
        assert!(
            read_ready_brief("pilots/none.brief.json", &dir)
                .unwrap_err()
                .ends_with("no such file")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
