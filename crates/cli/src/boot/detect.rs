//! Boot's detection pass (issue #121; boot-detect.ts): everything Boot can read rather than ask. The
//! skill's step 1 asked the operator to confirm a ten item brief; Boot has no reason to, so detection
//! here only feeds the prefills and the printed summary.
//!
//! The parsing is kept apart from the lookups so the interesting part, which is the commit prefix, is
//! testable without a repository.

use std::process::{Command, Stdio};
use std::sync::LazyLock;

use ac_core::js;
use regex::Regex;

use super::pool::count_tickets;

/// The harnesses the engine has spawn descriptors for (ac_core::harness).
pub const KNOWN_HARNESSES: [&str; 3] = ["claude", "opencode", "cursor"];

/// The port the engine takes when nothing pins one (ports.ts's DEFAULT_PORT).
pub const DEFAULT_PORT: u16 = 8787;

/// What detection found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detection {
    /// Ticket files in `issues/`.
    pub tickets: usize,
    /// A `conversations/` directory, the Seeded Pool opt-in (ADR-0024).
    pub conversations: bool,
    /// Markdown beside `issues/` that is pool context rather than engine prose.
    pub context_files: Vec<String>,
    /// The commit prefix this repository writes, when it writes one.
    pub commit_prefix: Option<String>,
    /// Which of the known harnesses answer on PATH.
    pub harnesses: Vec<String>,
    /// herdr's binary, which Enlist and tabs both need.
    pub herdr_binary: bool,
    /// herdr's daemon socket.
    pub herdr_socket: bool,
    /// Whether 8787 is free, which decides what the port question recommends.
    pub default_port_free: bool,
    /// The agent-console checkout the engine runs from.
    pub engine_dir: String,
}

/// The two prose files the template owns, which are never pool context.
const ENGINE_FILES: [&str; 2] = ["AGENT.md", "verify.md"];

/// Markdown sitting in the pool directory itself, which agents read as context.
pub fn context_files_in(pool_dir: &str) -> Vec<String> {
    if !js::exists(pool_dir) {
        return Vec::new();
    }
    let Ok(names) = js::read_dir_names(pool_dir) else {
        return Vec::new();
    };
    let mut files: Vec<String> = names
        .into_iter()
        .filter(|name| name.ends_with(".md") && !ENGINE_FILES.contains(&name.as_str()))
        .filter(|name| {
            std::fs::metadata(js::path_join(&[pool_dir, name])).is_ok_and(|meta| meta.is_file())
        })
        .collect();
    js::sort_strings(&mut files);
    files
}

static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^([a-z][a-z0-9-]*)(\([^)]*\))?!?:{}",
        js::WHITESPACE_CLASS
    ))
    .expect("the commit prefix pattern compiles")
});

/// The commit prefix a repository writes, read off its recent subjects. A prefix only counts when it is
/// the shape `word:` at the head of the subject, and the most common one wins outright: a repository
/// that writes no prefixes, or a different one every time, answers `None` and the template keeps its
/// placeholder rather than inventing a convention.
pub fn common_commit_prefix(subjects: &[String]) -> Option<String> {
    // First seen first, so a tie goes to the prefix met first.
    let mut counts: Vec<(String, usize)> = Vec::new();
    for subject in subjects {
        let Some(found) = PREFIX.captures(js::trim(subject)) else {
            continue;
        };
        let prefix = &found[1];
        match counts.iter_mut().find(|(seen, _)| seen == prefix) {
            Some((_, count)) => *count += 1,
            None => counts.push((prefix.to_owned(), 1)),
        }
    }
    let mut best: Option<String> = None;
    let mut best_count = 0;
    for (prefix, count) in counts {
        if count > best_count {
            best = Some(prefix);
            best_count = count;
        }
    }
    best
}

/// Whether a command answers on PATH, asked the way a shell would.
pub fn on_path(command: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {command}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Whether a TCP port can be bound right now on the loopback interface.
pub fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Everything detection reads for one Boot.
pub fn detect(pool_dir: &str, repo_dir: &str, engine_dir: &str, home: &str) -> Detection {
    Detection {
        tickets: count_tickets(pool_dir),
        conversations: js::exists(js::path_join(&[pool_dir, "conversations"])),
        context_files: context_files_in(pool_dir),
        commit_prefix: common_commit_prefix(&ac_io::git::recent_subjects(repo_dir)),
        harnesses: KNOWN_HARNESSES
            .iter()
            .filter(|name| on_path(name))
            .map(|name| (*name).to_owned())
            .collect(),
        herdr_binary: on_path("herdr"),
        herdr_socket: js::exists(js::path_join(&[home, ".config", "herdr", "herdr.sock"])),
        default_port_free: port_is_free(DEFAULT_PORT),
        engine_dir: engine_dir.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subjects(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|line| (*line).to_owned()).collect()
    }

    #[test]
    fn reads_the_commit_prefix_the_repository_actually_writes() {
        assert_eq!(
            common_commit_prefix(&subjects(&[
                "feat: one",
                "fix: two",
                "feat: three",
                "no prefix here"
            ])),
            Some("feat".to_owned())
        );
    }

    #[test]
    fn answers_none_when_the_repository_writes_no_prefix() {
        assert_eq!(common_commit_prefix(&subjects(&["one", "two"])), None);
        // The colon must be followed by whitespace, and the word must start lowercase.
        assert_eq!(
            common_commit_prefix(&subjects(&["feat:one", "Feat: two"])),
            None
        );
    }

    #[test]
    fn counts_a_scoped_prefix_as_its_type() {
        assert_eq!(
            common_commit_prefix(&subjects(&["feat(ui): one", "feat(ui)!: two"])),
            Some("feat".to_owned())
        );
    }

    #[test]
    fn gives_a_tie_to_the_prefix_met_first() {
        assert_eq!(
            common_commit_prefix(&subjects(&["fix: a", "feat: b", "feat: c", "fix: d"])),
            Some("fix".to_owned())
        );
    }

    #[test]
    fn lists_pool_context_files_and_leaves_the_templates_own_out() {
        let pool = tempfile::tempdir().unwrap();
        for name in ["SPEC.md", "AGENT.md", "verify.md", "NOTES.md", "notes.txt"] {
            std::fs::write(pool.path().join(name), "x").unwrap();
        }
        std::fs::create_dir(pool.path().join("DIR.md")).unwrap();
        assert_eq!(
            context_files_in(&js::path_text(pool.path())),
            ["NOTES.md", "SPEC.md"]
        );
        assert!(context_files_in("/no/such/pool").is_empty());
    }
}
