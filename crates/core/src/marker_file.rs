//! The one parser of the markdown files the pool keeps with a line-1 marker: Tickets (`issues/`,
//! [`crate::pool`]) and Conversations (`conversations/`, [`crate::conversation_record`]). Each owner
//! parses its own marker's fields; the grammar they share lives here, so a change to it breaks exactly
//! here: the `key=value` words, the title heading and the body under it, the `status=` rewrite, and the
//! stamp cache a directory load reads through.

use std::path::Path;
use std::sync::{LazyLock, Mutex};

use anyhow::Result;
use regex::Regex;

use crate::js;
use crate::stat_cache::StampCache;

/// The marker's fields, as `key=value` words; a later word wins over an earlier one with its key.
pub(crate) fn marker_fields(body: &str) -> Vec<(&str, &str)> {
    let mut fields: Vec<(&str, &str)> = Vec::new();
    for word in js::words(body) {
        if let Some(eq) = word.find('=')
            && eq > 0
        {
            let (key, value) = (&word[..eq], &word[eq + 1..]);
            match fields.iter_mut().find(|(k, _)| *k == key) {
                Some(field) => field.1 = value,
                None => fields.push((key, value)),
            }
        }
    }
    fields
}

pub(crate) fn field<'a>(fields: &[(&'a str, &'a str)], key: &str) -> Option<&'a str> {
    fields.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

// The heading grammar: the title is the first "# " heading, the body (a Ticket's spec, a
// Conversation's opening Turn) everything after it.
fn read_title(lines: &[&str]) -> String {
    match lines.iter().find(|line| line.starts_with("# ")) {
        Some(heading) => js::trim(&heading[1..]).to_owned(),
        None => "(untitled)".to_owned(),
    }
}

fn read_body(lines: &[&str]) -> String {
    let start = lines
        .iter()
        .position(|line| line.starts_with("# "))
        .map_or(0, |at| at + 1);
    js::trim(&lines[start..].join("\n")).to_owned()
}

/// A marker file, read: what its line-1 marker parsed to, its title, and the body under the title.
pub(crate) struct MarkerFile<T> {
    pub marker: T,
    pub title: String,
    pub body: String,
}

/// Read one marker file, parsing line 1 with `parse_marker_line`, whose errors name the file.
pub(crate) fn read_marker_file<T>(
    file: &Path,
    parse_marker_line: impl FnOnce(&str, &Path) -> Result<T>,
) -> Result<MarkerFile<T>> {
    let text = js::read_text(file)?;
    let lines: Vec<&str> = text.split('\n').collect();
    Ok(MarkerFile {
        marker: parse_marker_line(lines[0], file)?,
        title: read_title(&lines),
        body: read_body(&lines),
    })
}

/// Rewrite only line 1's `status=` field (the first `status_re` match), every other byte of the file
/// kept, CRLF endings too. A line 1 that `marker_re` does not match is refused with `missing`'s error.
pub(crate) fn write_status_field(
    file: &Path,
    marker_re: &Regex,
    status_re: &Regex,
    status: &str,
    missing: impl FnOnce() -> anyhow::Error,
) -> Result<()> {
    let raw = js::read_text(file)?;
    let newline = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = raw.split(newline).map(str::to_owned).collect();
    if !marker_re.is_match(&lines[0]) {
        return Err(missing());
    }
    lines[0] = js::replace_first(&lines[0], status_re, &format!("status={status}"));
    js::write_file(file, &lines.join(newline))?;
    Ok(())
}

/// A process-wide cache of parsed marker files (issue #157): every load re-reads its directory, once
/// per snapshot and more, so a file whose stamp has not moved since its last parse is served from that
/// parse, and a changed one is parsed afresh. One per format, as the TypeScript modules had one each.
pub(crate) struct MarkerCache<T>(LazyLock<Mutex<StampCache<T>>>);

impl<T: Clone> MarkerCache<T> {
    pub(crate) const fn new() -> Self {
        Self(LazyLock::new(|| Mutex::new(StampCache::new())))
    }

    pub(crate) fn read(&self, file: &Path, read: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
        let mut cache = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.read(file, read)
    }
}
