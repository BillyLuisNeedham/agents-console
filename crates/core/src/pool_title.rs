//! The Pool title (issue #100; pool-title.ts): one line of free text the operator gives a Pool so
//! several running at once can be told apart. Display-only: the Pool's identity stays its directory.
//! It lives in the Pool's console.json under `title`, written by Boot when it creates the Pool and
//! editable from the Settings pane. A Pool with no title falls back to its directory's name wherever a
//! title would show. Nothing here ever makes a title up: it is the operator's word or it is absent.

use serde_json::Value;

use crate::config::{PoolConfig, config_path};
use crate::js;

/// The longest title kept, in characters; a longer one is cut, not refused.
pub const TITLE_MAX: usize = 80;

/// A title as it is kept: one line, runs of whitespace (newlines included) collapsed to a single space,
/// any other control character dropped (the title is also a herdr workspace label, drawn in a
/// terminal), cut to TITLE_MAX characters and the ends trimmed. Empty is no title. The cut comes
/// before the trim, so leading whitespace counts against the 80.
pub fn normalise_title(value: &str) -> Option<String> {
    let mut line = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.chars() {
        if js::is_whitespace(c) {
            if !in_space {
                line.push(' ');
            }
            in_space = true;
        } else {
            line.push(c);
            in_space = false;
        }
    }
    let line: String = line.chars().filter(|c| !c.is_control()).collect();
    let cut: String = line.chars().take(TITLE_MAX).collect();
    let cut = js::trim(&cut);
    (!cut.is_empty()).then(|| cut.to_owned())
}

/// The title a parsed config carries, or `None` when it has none.
pub fn title_of(config: &PoolConfig) -> Option<String> {
    title_in(config.get("title"))
}

fn title_in(raw: Option<&Value>) -> Option<String> {
    raw.and_then(Value::as_str).and_then(normalise_title)
}

/// The title straight off disk, for the callers that hold no parsed config (Boot's pick-a-pool list).
/// A missing or unreadable file is no title rather than an error: a broken config is Boot's to report
/// when it reads the Pool it is actually starting, not a reason to refuse to list the others.
pub fn read_pool_title(pool_dir: &str) -> Option<String> {
    let file = config_path(pool_dir);
    if !js::exists(&file) {
        return None;
    }
    let text = js::read_text(&file).ok()?;
    match js::parse(&text).ok()? {
        Value::Object(map) => title_in(map.get("title")),
        _ => None,
    }
}

/// The label a Pool workspace the Console created carries: the title, else the directory's name, which
/// is what every created workspace was labelled before titles existed (ADR-0015).
pub fn pool_workspace_label(title: Option<&str>, pool_dir: &str) -> String {
    match title {
        Some(title) => title.to_owned(),
        None => js::basename(pool_dir).to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // pool-title.test.ts
    #[test]
    fn collapses_whitespace_to_one_line_and_trims() {
        assert_eq!(
            normalise_title("  Jev as\n the\tgrader  ").as_deref(),
            Some("Jev as the grader")
        );
    }

    #[test]
    fn blank_is_no_title() {
        assert_eq!(normalise_title(" \n "), None);
        assert_eq!(normalise_title(""), None);
    }

    #[test]
    fn drops_control_characters_so_a_terminal_escape_cannot_ride_a_workspace_label() {
        assert_eq!(
            normalise_title("\x1b[31mRed\x07 pool").as_deref(),
            Some("[31mRed pool")
        );
        // U+0085 is a control character but not JavaScript whitespace: dropped, not collapsed.
        assert_eq!(normalise_title("a\u{85}b").as_deref(), Some("ab"));
        // Whitespace collapses before the control characters go, so the spaces either side stay two.
        assert_eq!(normalise_title("a \x01 b").as_deref(), Some("a  b"));
    }

    #[test]
    fn cuts_a_pasted_wall_of_text_to_the_maximum() {
        assert_eq!(
            normalise_title(&"x".repeat(500)).unwrap().chars().count(),
            TITLE_MAX
        );
    }

    #[test]
    fn cuts_by_character_never_splitting_one_in_two() {
        let title = normalise_title(&"🙂".repeat(TITLE_MAX + 5)).unwrap();
        assert_eq!(title.chars().count(), TITLE_MAX);
    }

    // The progress log's C20 note: the cut comes before the trim, so leading whitespace counts.
    #[test]
    fn cuts_before_it_trims() {
        let title = normalise_title(&format!("   {}", "y".repeat(100))).unwrap();
        assert_eq!(title, "y".repeat(TITLE_MAX - 1));
    }

    #[test]
    fn reads_a_title_off_disk_or_none() {
        let dir = tempfile::tempdir().unwrap();
        let pool = dir.path().to_str().unwrap();
        assert_eq!(read_pool_title(pool), None);
        std::fs::write(dir.path().join("console.json"), "{ not json").unwrap();
        assert_eq!(read_pool_title(pool), None);
        std::fs::write(dir.path().join("console.json"), r#"{"title":5}"#).unwrap();
        assert_eq!(read_pool_title(pool), None);
        std::fs::write(
            dir.path().join("console.json"),
            r#"{"title":" Jev\npool "}"#,
        )
        .unwrap();
        assert_eq!(read_pool_title(pool).as_deref(), Some("Jev pool"));
    }

    #[test]
    fn labels_a_created_workspace_with_the_title_else_the_directory() {
        assert_eq!(pool_workspace_label(Some("Jev"), "/repos/pool"), "Jev");
        assert_eq!(pool_workspace_label(None, "/repos/pool"), "pool");
    }
}
