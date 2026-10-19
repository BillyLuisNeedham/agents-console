//! Boot's Line mode (issue #187, ADR-0037, ADR-0038, ADR-0040): a Line pool runs one Line on a branch
//! of its own, so Boot cuts `line/<slug>` from its Line base (the current branch, or `--from`'s)
//! before there is any pool, and the pool lives inside that branch's checkout. The base goes into the
//! pool's console.json as `lineBase`, so the Line knows what it was cut from (issue #193).
//!
//! The engine finds a pool's checkout from the pool directory (the git toplevel above it) and merges
//! into whatever that checkout has out. So Boot gives the Line branch a worktree of its own, at
//! `<checkout>/.scratch/lines/<slug>`, and makes the pool at `<that worktree>/.scratch/<name>`: the
//! pool's target branch is the Line's with no setting to keep in step, and the directory Boot was run
//! from keeps the branch it had, whatever else is running there.
//!
//! Then the Line begins on its Plan (`POST /api/line`), in one of two ways. Asked for the work (an
//! issue number or free text), Boot hands it over, and on a Plan that starts with a Conversation the
//! engine opens that node's first pass on it, which ends once its Line brief has merged. Given a
//! ready brief (`--brief`), Boot commits the brief and its spec onto the Line branch and hands over
//! the brief's path, with no Conversation opened and no question asked.

use ac_protocol::LineBase;
use serde_json::{Map, Value};

use ac_core::js;
use ac_core::line::run::LineBrief;
use ac_core::line::{BRIEF_DIR, BRIEF_SUFFIX, BaseBranch, LINE_BRANCH_PREFIX, issue_number};
use ac_core::pool_title::normalise_title;

use super::BootIo;
use super::pool::{Excluded, ensure_scratch_excluded, git_line, slugify};

/// Where Line worktrees go under the checkout Boot runs from.
pub const LINES_DIR: &str = "lines";

/// A ready brief Boot was handed: the brief as written, its spec's text when it names one, and the
/// name its file gives.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadyBrief {
    pub brief: Map<String, Value>,
    pub spec_text: Option<String>,
    /// The spec's first `# ` heading, which titles the pool when nothing else does.
    pub heading: Option<String>,
    /// The brief's file name without `.brief.json`.
    pub stem: String,
}

/// What the Line starts from: the work, or a ready brief.
#[derive(Debug, Clone, PartialEq)]
pub enum LineWork {
    Work { work: String },
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
    let checked = LineBrief::parse(&text).map_err(|reason| format!("--brief {path}: {reason}"))?;
    let Ok(Value::Object(brief)) = js::parse(&text) else {
        return Err(format!("--brief {path}: not a JSON object"));
    };
    let name = js::basename(&file);
    let stem = name
        .strip_suffix(BRIEF_SUFFIX)
        .or_else(|| name.strip_suffix(".json"))
        .unwrap_or(name)
        .to_owned();
    let Some(spec) = checked.spec else {
        return Ok(ReadyBrief {
            brief,
            spec_text: None,
            heading: None,
            stem,
        });
    };
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
    Ok(ReadyBrief {
        brief,
        heading: first_heading(&spec_text),
        spec_text: Some(spec_text),
        stem,
    })
}

/// A markdown file's first `# ` heading.
pub fn first_heading(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix("# "))
        .and_then(normalise_title)
}

/// The Line's slug when `--line` names none: the issue's number, the ready brief's name, or the first
/// words of the work.
pub fn derived_slug(work: &LineWork) -> String {
    let slug = match work {
        LineWork::Ready(ready) => slugify(&ready.stem),
        LineWork::Work { work } => match issue_number(work) {
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
        LineWork::Work { work } => match issue_number(work) {
            Some(number) => Some(format!("Issue #{number}")),
            None => normalise_title(work),
        },
    }
}

/// The standing orders of the Steward a Line pool starts with (ADR-0037, ADR-0040).
pub const STEWARD_ORDERS: &str = "Steward this pool's Line while the operator is away: keep its \
Plan moving through the checkpoints and holds your teaching says are yours to answer. The Finish \
and its act are the operator's: when the Line waits there, say in your pane where the Line stands \
and what the Finish waits for, and wait. End yourself once the Line is done.";

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

/// The branch `--from` names: a local branch, else origin's as written (`origin/x`), else origin's by
/// its name there. Branches only, and only local or origin's (ADR-0038, the Finish knows no other
/// remote): another remote's branch, a symbolic `HEAD`, a tag, a commit or anything else is refused,
/// naming why. Nothing is fetched; the refs are taken as they are.
pub fn resolve_from(name: &str, exists: impl Fn(&str) -> bool) -> Result<BaseBranch, String> {
    if js::trim(name).is_empty() {
        return Err("--from needs a branch name".to_owned());
    }
    if name == "HEAD" || name.ends_with("/HEAD") {
        return Err(format!(
            "--from {name}: HEAD is a symbolic ref, not a branch; name the branch it points at"
        ));
    }
    let tried = [
        format!("refs/heads/{name}"),
        format!("refs/remotes/{name}"),
        format!("refs/remotes/origin/{name}"),
    ];
    if exists(&tried[0]) {
        return local_base(name);
    }
    if exists(&tried[1]) {
        return match name.strip_prefix("origin/") {
            Some(on_origin) => Ok(BaseBranch::Origin(on_origin.to_owned())),
            None => Err(format!(
                "--from {name}: {} is another remote's branch; a Line base is a local branch or \
                 origin's, since the Finish opens its PR on origin",
                tried[1]
            )),
        };
    }
    if exists(&tried[2]) {
        return Ok(BaseBranch::Origin(name.to_owned()));
    }
    Err(format!(
        "--from {name}: no branch {}, {} or {}; --from takes a branch (local or origin's), never a \
         tag or a commit",
        tried[0], tried[1], tried[2]
    ))
}

// A local branch as a Line base. One named `origin/...` would read back from lineBase as origin's, and
// the Finish would open its PR against the wrong branch.
fn local_base(name: &str) -> Result<BaseBranch, String> {
    if name.starts_with("origin/") {
        return Err(format!(
            "refs/heads/{name} is a local branch named like origin's, which the Line base would \
             read as origin's {}: rename it, or cut from another branch",
            BaseBranch::of(name).name()
        ));
    }
    Ok(BaseBranch::Local(name.to_owned()))
}

// The Line base's branch: `--from`'s, else the branch the checkout has out.
fn base_branch(top: &str, from: Option<&str>) -> Result<BaseBranch, String> {
    match from {
        Some(name) => resolve_from(name, |full| {
            git_ok(top, &["show-ref", "--verify", "--quiet", full]).is_ok()
        }),
        None => {
            let head = git_line(top, &["symbolic-ref", "--quiet", "HEAD"]).ok_or_else(|| {
                format!(
                    "{top} has a detached HEAD, so there is no current branch to cut the Line \
                     from: check out a branch, or pass --from <branch>"
                )
            })?;
            local_base(head.strip_prefix("refs/heads/").unwrap_or(&head))
        }
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
    let from = base_branch(top, from)?;
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
            &from.full_ref(),
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
            base_ref: from.base_ref(),
            commit,
        },
    })
}

/// Commit a ready brief and its spec onto the Line branch as `docs/specs/<slug>.md` and
/// `docs/specs/<slug>.brief.json`, the brief's spec renamed to match. Answers the brief's path in the
/// Line's checkout, which `POST /api/line` is then given.
pub fn commit_ready_brief(line: &CutLine, ready: &ReadyBrief) -> Result<String, String> {
    let spec_path = format!("{BRIEF_DIR}/{}.md", line.slug);
    let brief_path = format!("{BRIEF_DIR}/{}{BRIEF_SUFFIX}", line.slug);
    let mut brief = ready.brief.clone();
    js::mkdir_all(js::path_join(&[&line.worktree, BRIEF_DIR])).map_err(|err| err.to_string())?;
    let mut paths = vec![brief_path.as_str()];
    if let Some(spec_text) = &ready.spec_text {
        brief.insert("spec".to_owned(), Value::String(spec_path.clone()));
        js::write_file(js::path_join(&[&line.worktree, &spec_path]), spec_text)
            .map_err(|err| err.to_string())?;
        paths.push(&spec_path);
    }
    let text =
        serde_json::to_string_pretty(&Value::Object(brief)).map_err(|err| err.to_string())?;
    js::write_file(
        js::path_join(&[&line.worktree, &brief_path]),
        &format!("{text}\n"),
    )
    .map_err(|err| err.to_string())?;
    let mut add = vec!["add", "--"];
    add.extend(paths);
    git_ok(&line.worktree, &add)?;
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
    fn derives_the_slug_from_the_issue_the_brief_or_the_first_words() {
        let work = |work: &str| LineWork::Work {
            work: work.to_owned(),
        };
        assert_eq!(derived_slug(&work("#186")), "186");
        assert_eq!(
            derived_slug(&work(
                "Make the header strip show the Round and the node too"
            )),
            "make-the-header-strip-show-the"
        );
        assert_eq!(derived_slug(&work("!!!")), "line");
        let ready = LineWork::Ready(Box::new(ReadyBrief {
            brief: Map::new(),
            spec_text: None,
            heading: None,
            stem: "186".to_owned(),
        }));
        assert_eq!(derived_slug(&ready), "186");
        assert_eq!(derived_title(&ready, "186"), Some("Line 186".to_owned()));
        assert_eq!(
            derived_title(&work("#186"), "186"),
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
    fn from_resolves_a_local_branch_then_origins_as_written_then_origins_by_name() {
        let refs = [
            "refs/heads/experiment/x",
            "refs/heads/origin/mistake",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/experiment/x",
            "refs/remotes/origin/only-remote",
            "refs/remotes/upstream/y",
        ];
        let exists = |full: &str| refs.contains(&full);
        let local = |name: &str| BaseBranch::Local(name.to_owned());
        let origin = |name: &str| BaseBranch::Origin(name.to_owned());
        assert_eq!(
            resolve_from("experiment/x", exists),
            Ok(local("experiment/x"))
        );
        assert_eq!(
            resolve_from("origin/experiment/x", exists),
            Ok(origin("experiment/x"))
        );
        assert_eq!(
            resolve_from("only-remote", exists),
            Ok(origin("only-remote"))
        );
        assert_eq!(
            resolve_from("v1.0", exists).unwrap_err(),
            "--from v1.0: no branch refs/heads/v1.0, refs/remotes/v1.0 or refs/remotes/origin/v1.0; \
             --from takes a branch (local or origin's), never a tag or a commit"
        );
        // Origin only: the Finish knows no other remote.
        assert_eq!(
            resolve_from("upstream/y", exists).unwrap_err(),
            "--from upstream/y: refs/remotes/upstream/y is another remote's branch; a Line base is \
             a local branch or origin's, since the Finish opens its PR on origin"
        );
        // A symbolic HEAD is no branch, whichever rule would have matched it.
        for name in ["origin/HEAD", "HEAD"] {
            assert_eq!(
                resolve_from(name, exists).unwrap_err(),
                format!(
                    "--from {name}: HEAD is a symbolic ref, not a branch; name the branch it \
                     points at"
                )
            );
        }
        for name in ["", "  "] {
            assert_eq!(
                resolve_from(name, exists).unwrap_err(),
                "--from needs a branch name"
            );
        }
        // A local branch named like origin's would read back from lineBase as origin's.
        assert_eq!(
            resolve_from("origin/mistake", exists).unwrap_err(),
            "refs/heads/origin/mistake is a local branch named like origin's, which the Line base \
             would read as origin's mistake: rename it, or cut from another branch"
        );
    }

    #[test]
    fn a_base_branch_writes_and_reads_back_as_line_base_writes_it() {
        let local = BaseBranch::Local("experiment/x".to_owned());
        assert_eq!(local.base_ref(), "experiment/x");
        assert_eq!(local.full_ref(), "refs/heads/experiment/x");
        assert_eq!(BaseBranch::of(&local.base_ref()), local);
        let origin = BaseBranch::Origin("experiment/x".to_owned());
        assert_eq!(origin.base_ref(), "origin/experiment/x");
        assert_eq!(origin.full_ref(), "refs/remotes/origin/experiment/x");
        assert_eq!(BaseBranch::of(&origin.base_ref()), origin);
        assert_eq!(origin.name(), "experiment/x");
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
            r#"{"spec": "pilots/186.md", "finish": "draft-pr"}"#,
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
                .spec_text
                .as_deref(),
            Some("# Fix it\n\nbody\n")
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
