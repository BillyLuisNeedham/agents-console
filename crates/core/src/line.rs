//! The Line's helpers the run and Boot share (ADR-0037, ADR-0038, ADR-0039): where a Line keeps its
//! files, the verdicts a Prove or Review Ticket writes, approval, the Line base, and `line.json`.
//! The run itself, a frozen Plan advanced over the pool's facts, is [`run`].

use std::path::{Path, PathBuf};

use ac_protocol::{LineBase, ProveVerdict, ReviewVerdict};
use serde_json::Value;

use crate::js;
use run::LineRun;

/// `line.json` in the pool directory: the Line's state.
pub const LINE_FILE: &str = "line.json";

/// Where a Line's Conversation writes its brief: `docs/specs/<line>.<conversation>.brief.json`.
pub const BRIEF_DIR: &str = "docs/specs";
pub const BRIEF_SUFFIX: &str = ".brief.json";

/// The first line of the Brief an Outcome without a valid verdict checkpoints with.
pub const NO_VERDICT: &str = "no verdict";

/// What the operator answers on a hold to open it.
pub const APPROVED: &str = "approved";

/// A Decide pass's report in the pool's runs directory: `<line>-<node>-<pass>-report.html`.
pub const REPORT_SUFFIX: &str = "-report.html";

/// A Prove Ticket's evidence directory in the pool's runs directory: `<ticket>.evidence/`.
pub const EVIDENCE_SUFFIX: &str = ".evidence";

/// The run folder a proving skill may leave in the checkout, which the Finish Ticket removes.
pub const VERIFY_DIR: &str = ".verify";

pub fn line_path(pool_dir: &Path) -> PathBuf {
    pool_dir.join(LINE_FILE)
}

/// The pool's Line, `None` when it runs none. A file that does not load stops the pool load, an old
/// one from before Plans with the message to start a new Line: the run cannot be guessed.
pub fn load_line(pool_dir: &Path) -> anyhow::Result<Option<LineRun>> {
    let file = line_path(pool_dir);
    if !file.exists() {
        return Ok(None);
    }
    let text = js::read_text(&file)?;
    LineRun::from_json(&text)
        .map(Some)
        .map_err(|e| anyhow::anyhow!("pool load: {}: {e}", file.display()))
}

/// Write the Line whole, through a rename.
pub fn save_line(pool_dir: &Path, line: &LineRun) -> anyhow::Result<()> {
    let file = line_path(pool_dir);
    let mut aside = file.clone().into_os_string();
    aside.push(".tmp");
    js::write_through_rename(&file, Path::new(&aside), &line.to_json())?;
    Ok(())
}

fn verdict_of<T: serde::de::DeserializeOwned>(verdict: Option<&Value>) -> Result<T, String> {
    let Some(verdict) = verdict else {
        return Err("the Outcome has no verdict".into());
    };
    serde_json::from_value(verdict.clone()).map_err(|e| format!("the verdict does not parse: {e}"))
}

fn blank(text: &str) -> bool {
    js::trim(text).is_empty()
}

/// Prove's verdict, checked.
pub fn prove_verdict(verdict: Option<&Value>) -> Result<ProveVerdict, String> {
    let prove: ProveVerdict = verdict_of(verdict)?;
    if blank(&prove.evidence) {
        return Err("the verdict's evidence is blank: give the path of the evidence".into());
    }
    Ok(prove)
}

/// Review's verdict, checked.
pub fn review_verdict(verdict: Option<&Value>) -> Result<ReviewVerdict, String> {
    let review: ReviewVerdict = verdict_of(verdict)?;
    if let Some(i) = review.findings.iter().position(|f| blank(&f.title)) {
        return Err(format!("finding {} has a blank title", i + 1));
    }
    Ok(review)
}

/// Whether a Resume note on a hold approves it: no note, or "approved".
pub fn approves(note: Option<&str>) -> bool {
    let Some(note) = note.map(js::trim) else {
        return true;
    };
    let word = note.trim_end_matches(['.', '!']).to_lowercase();
    word.is_empty() || word == APPROVED || word == "approve"
}

/// A Line base's branch: a local one, or origin's, never another remote's (ADR-0038). `lineBase.ref`
/// writes it `x` or `origin/x`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BaseBranch {
    Local(String),
    Origin(String),
}

impl BaseBranch {
    /// A Line base's ref as `lineBase` writes it: `origin/x` is origin's `x`, anything else local.
    pub fn of(base_ref: &str) -> Self {
        match base_ref.strip_prefix("origin/") {
            Some(name) => BaseBranch::Origin(name.to_owned()),
            None => BaseBranch::Local(base_ref.to_owned()),
        }
    }

    /// The branch's name, which is its name on origin too, where the Line's PR targets it.
    pub fn name(&self) -> &str {
        match self {
            BaseBranch::Local(name) | BaseBranch::Origin(name) => name,
        }
    }

    /// The ref as `lineBase` writes it: `x`, or `origin/x`.
    pub fn base_ref(&self) -> String {
        match self {
            BaseBranch::Local(name) => name.clone(),
            BaseBranch::Origin(name) => format!("origin/{name}"),
        }
    }

    /// The full ref git cuts from: `refs/heads/x`, or `refs/remotes/origin/x`.
    pub fn full_ref(&self) -> String {
        match self {
            BaseBranch::Local(name) => format!("refs/heads/{name}"),
            BaseBranch::Origin(name) => format!("refs/remotes/origin/{name}"),
        }
    }
}

/// A Line base as console.json's `lineBase` holds it, checked: `{ ref, commit }` with neither blank,
/// naming a branch. A malformed one is refused rather than read as main, since a Line read as cut from
/// main opens its PR against main (ADR-0038).
pub fn line_base_of(value: &Value) -> Result<LineBase, String> {
    let base: LineBase = serde_json::from_value(value.clone()).map_err(|err| err.to_string())?;
    if blank(BaseBranch::of(&base.base_ref).name()) {
        return Err(format!("its ref {:?} names no branch", base.base_ref));
    }
    if blank(&base.commit) {
        return Err("its commit is blank".to_owned());
    }
    Ok(base)
}

/// The prefix of every Line branch Boot cuts (ADR-0038).
pub const LINE_BRANCH_PREFIX: &str = "line/";

/// The Line's name, as its spec and brief are named in `docs/specs/`: the Line branch without its
/// `line/` prefix, or any other branch with its slashes made dashes.
pub fn line_name_of(branch: &str) -> String {
    let name = branch.strip_prefix(LINE_BRANCH_PREFIX).unwrap_or(branch);
    let name = name.replace('/', "-");
    if name.is_empty() {
        "line".to_owned()
    } else {
        name
    }
}

/// Where a Line Conversation pass commits its Line brief: `docs/specs/<line>.<id>.brief.json`.
pub fn brief_path(branch: &str, conversation: &str) -> String {
    format!(
        "{BRIEF_DIR}/{}.{conversation}{BRIEF_SUFFIX}",
        line_name_of(branch)
    )
}

/// The issue number a piece of work names, when it is only that: `186` or `#186`.
pub fn issue_number(work: &str) -> Option<String> {
    let digits = js::trim(work).trim_start_matches('#');
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())).then(|| digits.to_owned())
}

/// A commit as the operator reads it: its first seven characters.
pub fn short_commit(commit: &str) -> &str {
    commit.get(..7).unwrap_or(commit)
}

pub mod run;

#[cfg(test)]
mod tests;
