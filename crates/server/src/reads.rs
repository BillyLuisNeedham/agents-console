//! The per-ticket reads the routes and the socket share (server.ts): a byte range of an attempt's log,
//! ANSI stripped and never splitting a character or an escape sequence; a ticket's events and spec; its
//! Issue file's body; the pool's grades; a ticket's Vitals (activity). Each is a plain function over the
//! pool's files, so a request on the socket and its HTTP twin cannot answer differently.

use std::fs::File;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Map, Value, json};

use ac_core::events::{read_event_values, read_events};
use ac_core::js;
use ac_core::pool::{MARKER_RE, TicketMarker, read_marker};
use ac_core::streamlog::{list_attempt_logs, reconstruct_attempts};
use ac_protocol::{TicketBodyResponse, TicketEventKind, TicketGradeSummary};

/// The largest byte range a single log response serves. Larger logs page.
pub const LOG_CHUNK_BYTES: u64 = 64 * 1024;

/// The most pool log lines one read of its earlier lines serves (issue #161); it serves
/// POOL_LOG_WINDOW when the Console names no limit.
pub const POOL_LOG_MAX_LINES: usize = 2_000;

// ---------------------------------------------------------------------------------------------------
// Log ranges
// ---------------------------------------------------------------------------------------------------

// ANSI escape sequences: CSI (colours, cursor movement) and OSC (title, hyperlinks) are stripped so
// the served log reads as clean text. JavaScript's `\d` is ASCII here, so the digits are spelled out.
static ANSI_ESCAPE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"[\x1B\x{9B}][\[\]()#;?]*(?:(?:(?:[a-zA-Z0-9]*(?:;[-a-zA-Z0-9/#&.:=?%@~_]+)*)?\x07)|(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]))",
    )
    .expect("the ANSI escape pattern compiles")
});

/// The text with every ANSI escape sequence removed.
pub fn strip_ansi(text: &str) -> String {
    ANSI_ESCAPE_RE.replace_all(text, "").into_owned()
}

/// One byte range of a log file. Offsets are JavaScript numbers: a NaN offset (`?offset=abc`) is
/// carried through and serialises as null, as the TypeScript's does.
#[derive(Debug, Clone, PartialEq)]
pub struct LogRange {
    pub content: String,
    pub offset: f64,
    pub next_offset: f64,
    pub total_size: u64,
}

impl LogRange {
    /// The range's fields in order, for a response that adds its own after them.
    pub fn fields(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("content".into(), Value::from(self.content.clone()));
        map.insert("offset".into(), number(self.offset));
        map.insert("nextOffset".into(), number(self.next_offset));
        map.insert("totalSize".into(), Value::from(self.total_size));
        map
    }
}

/// A JavaScript number as JSON: NaN and the infinities as null, as `JSON.stringify` writes them.
pub fn number(value: f64) -> Value {
    if value.is_finite() {
        js::number_value(value)
    } else {
        Value::Null
    }
}

// The UTF-8 length of the leading byte at `index`, or 0 on a continuation byte or past the end.
fn utf8_char_length(bytes: &[u8], index: usize) -> usize {
    match bytes.get(index) {
        None => 0,
        Some(lead) if *lead < 0x80 => 1,
        Some(lead) if lead & 0xe0 == 0xc0 => 2,
        Some(lead) if lead & 0xf0 == 0xe0 => 3,
        Some(lead) if lead & 0xf8 == 0xf0 => 4,
        Some(_) => 0,
    }
}

// Trim a slice so no multi-byte character straddles its tail: a leading byte whose continuation bytes
// fall past `end` is cut out, so the next read (from the trimmed end) brings it back whole.
fn utf8_end(bytes: &[u8], start: usize, end: usize) -> usize {
    let mut cut = end;
    let mut i = end;
    while i > start && bytes[i - 1] & 0xc0 == 0x80 {
        cut = i - 1;
        i -= 1;
    }
    if i > start {
        let lead = i - 1;
        let len = utf8_char_length(bytes, lead);
        if len > 0 && lead + len > end {
            cut = lead;
        }
    }
    cut
}

// How many continuation bytes open the slice: a range that begins mid-character drops the partial
// character and starts at the next leading byte.
fn utf8_head_trim(bytes: &[u8], start: usize, end: usize) -> usize {
    let mut cut = start;
    while cut < end && bytes[cut] & 0xc0 == 0x80 {
        cut += 1;
    }
    cut - start
}

const ESC: u8 = 0x1b;

// The longest escape sequence a read holds back waiting for its end (an OSC hyperlink carries a whole
// URL); past it the bytes go as they are, so a stray ESC can never hold a log back for good.
const ESCAPE_MAX_BYTES: usize = 4096;

// Whether the escape sequence starting at `esc` has ended by `end`. A CSI (ESC [) ends at its final
// byte, an OSC (ESC ]) at BEL, a charset designator a byte after its introducer, and every other escape
// at its second byte. A byte a sequence cannot hold ends it too.
fn escape_ended(bytes: &[u8], esc: usize, end: usize) -> bool {
    if esc + 1 >= end {
        return false;
    }
    match bytes[esc + 1] {
        0x5b => bytes[esc + 2..end]
            .iter()
            .any(|byte| *byte < 0x20 || *byte >= 0x40),
        0x5d => bytes[esc + 2..end].contains(&0x07),
        0x28 | 0x29 | 0x23 => esc + 2 < end,
        _ => true,
    }
}

// Trim a slice so no ANSI escape sequence straddles its tail (issue #161): a tail still inside a
// sequence is cut at its ESC, so the next read brings the sequence whole.
fn escape_end(bytes: &[u8], start: usize, end: usize) -> usize {
    let from = start.max(end.saturating_sub(ESCAPE_MAX_BYTES));
    for i in (from..end).rev() {
        if bytes[i] == ESC {
            return if escape_ended(bytes, i, end) { end } else { i };
        }
    }
    end
}

/// Read a byte range of a log file: from `offset` up to LOG_CHUNK_BYTES more bytes (or EOF), ANSI
/// stripped. The client pages by requesting from the returned `next_offset` until it equals
/// `total_size`. An optional `end` bounds the range below the chunk size, which is how "load earlier"
/// reads exactly the missing prefix before the bytes the pane already holds. A file that cannot be
/// opened reads as empty. A whole range read from a fractional offset fails as Node's positioned read
/// does.
pub fn read_log_range(path: &Path, offset: f64, end: Option<f64>) -> Result<LogRange, String> {
    let Ok(file) = File::open(path) else {
        return Ok(LogRange {
            content: String::new(),
            offset: 0.0,
            next_offset: 0.0,
            total_size: 0,
        });
    };
    let total_size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let total = total_size as f64;
    // Math.min(Math.max(0, offset), totalSize), NaN carried through.
    let start = if offset.is_nan() {
        f64::NAN
    } else {
        offset.max(0.0).min(total)
    };
    let bound = match end {
        Some(end) if end.is_finite() => start.max(end),
        _ => start + LOG_CHUNK_BYTES as f64,
    };
    let range_end = (start + LOG_CHUNK_BYTES as f64).min(bound).min(total);
    let length = {
        let length = (range_end - start).max(0.0);
        if length.is_nan() {
            0
        } else {
            length.trunc() as usize
        }
    };
    let mut bytes = vec![0u8; length];
    let mut read = 0;
    if length > 0 && start.fract() != 0.0 {
        return Err(format!(
            "The value of \"position\" is out of range. It must be an integer. Received {}",
            js::number_string(start)
        ));
    }
    while read < bytes.len() {
        match file.read_at(&mut bytes[read..], start as u64 + read as u64) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(err) => return Err(js::FsError::new(&err, "read", path).to_string()),
        }
    }
    bytes.truncate(read);
    let head_trim = utf8_head_trim(&bytes, 0, bytes.len());
    let mut decode_end = utf8_end(&bytes, head_trim, bytes.len());
    // A forward read (a tail, or a page on from the last one) is continued from its next offset, so it
    // stops short of an escape still arriving. A read bounded by `end` meets bytes the reader already
    // holds, and keeps every byte up to them.
    if !end.is_some_and(f64::is_finite) {
        decode_end = escape_end(&bytes, head_trim, decode_end);
    }
    let decode_end = decode_end.max(head_trim);
    Ok(LogRange {
        content: strip_ansi(&js::decode_utf8(&bytes[head_trim..decode_end])),
        offset: start + head_trim as f64,
        next_offset: start + decode_end as f64,
        total_size,
    })
}

/// Where a log's last window starts: its last LOG_CHUNK_BYTES.
pub fn log_tail_offset(path: &Path) -> f64 {
    std::fs::metadata(path)
        .map(|meta| meta.len().saturating_sub(LOG_CHUNK_BYTES) as f64)
        .unwrap_or(0.0)
}

// ---------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------

/// GET /api/events's answer: the events file's lines verbatim when it has any, else the reconstructed
/// attempt rows; `spec` from the ticket's marker, "" for a Conversation.
pub fn ticket_events(runs_dir: &Path, ticket_id: &str, meta: &[TicketMarker]) -> Value {
    let events = read_event_values(runs_dir, ticket_id);
    let spec = meta
        .iter()
        .find(|marker| marker.id == ticket_id)
        .map_or("", |marker| marker.spec.as_str());
    if !events.is_empty() {
        return json!({
            "events": events.iter().map(|event| (**event).clone()).collect::<Vec<_>>(),
            "attempts": [],
            "reconstructed": false,
            "spec": spec,
        });
    }
    json!({
        "events": [],
        "attempts": reconstruct_attempts(runs_dir, ticket_id),
        "reconstructed": true,
        "spec": spec,
    })
}

/// A card's events as its frames carry them (ws.ts `cardEvents`): each event's `logTail` left out of an
/// object payload, every other key where it was.
pub fn card_events(mut events: Value) -> Value {
    if let Some(Value::Array(list)) = events.get_mut("events") {
        for event in list {
            if let Some(Value::Object(payload)) = event.get_mut("payload") {
                payload.shift_remove("logTail");
            }
        }
    }
    events
}

// ---------------------------------------------------------------------------------------------------
// The ticket body
// ---------------------------------------------------------------------------------------------------

/// The line-1 state marker is pool metadata, never prose for the UI: drop it, and the blank lines that
/// separated it from the body.
pub fn strip_state_marker(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    if !MARKER_RE.is_match(lines[0]) {
        return text.to_owned();
    }
    let mut first = 1;
    while first < lines.len() && js::trim(lines[first]).is_empty() {
        first += 1;
    }
    lines[first..].join("\n")
}

/// A ticket's Issue file: `<id>.md` first, then, among the `.md` files whose prefix before their first `-`
/// is the id, the one whose state line names the id, so `01-a.md` answers for 01 beside an adopted
/// `01-spawn-1.md` whatever order the directory lists them in. A file with no readable state line is the
/// last resort, the first by name. Scoped to what the issues directory lists, so an arbitrary id can never
/// walk out of it.
pub fn ticket_body_file(issues_dir: &Path, ticket_id: &str) -> Option<PathBuf> {
    let files = js::read_dir_names(issues_dir).ok()?;
    let mut markdown: Vec<&String> = files.iter().filter(|file| file.ends_with(".md")).collect();
    markdown.sort();
    let exact = format!("{ticket_id}.md");
    if let Some(file) = markdown.iter().find(|file| ***file == exact) {
        return Some(issues_dir.join(file.as_str()));
    }
    let mut unmarked = None;
    for file in markdown.into_iter().filter(|file| {
        file.find('-')
            .is_some_and(|dash| dash > 0 && file[..dash] == *ticket_id)
    }) {
        let path = issues_dir.join(file.as_str());
        match read_marker(&path) {
            Ok(marker) if marker.id == ticket_id => return Some(path),
            Ok(_) => {}
            Err(_) => {
                unmarked.get_or_insert(path);
            }
        }
    }
    unmarked
}

/// GET /api/ticket's answer, or `None` when the id has no Issue file. A file that cannot be read is the
/// error.
pub fn ticket_body(
    issues_dir: &Path,
    ticket_id: &str,
) -> Result<Option<TicketBodyResponse>, String> {
    let Some(file) = ticket_body_file(issues_dir, ticket_id) else {
        return Ok(None);
    };
    let text = js::read_text(&file).map_err(|err| err.to_string())?;
    Ok(Some(TicketBodyResponse {
        id: ticket_id.to_owned(),
        body: strip_state_marker(&text),
    }))
}

// ---------------------------------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------------------------------

/// The winning attempt's latest well-formed grade per ticket, in Issue file order; before a selection
/// has landed, the latest graded event stands in. A selected event names the winner, a merged event
/// only on a ticket graded before Selection existed. A named winner whose own grade is malformed serves
/// nothing, and a ticket with no grade is absent.
pub fn pool_grades(runs_dir: &Path, meta: &[TicketMarker]) -> IndexMap<String, TicketGradeSummary> {
    let mut grades = IndexMap::new();
    for marker in meta {
        let events = read_events(runs_dir, &marker.id);
        let graded: Vec<_> = events
            .iter()
            .filter(|event| {
                event.kind == TicketEventKind::Graded
                    && event.payload.get("score").is_some_and(Value::is_number)
                    && event.payload.get("verdict").is_some_and(Value::is_string)
                    && event.payload.get("reasons").is_some_and(Value::is_string)
            })
            .collect();
        let Some(last) = graded.last() else {
            continue;
        };
        let last_of = |kind: TicketEventKind| {
            events
                .iter()
                .rfind(|event| event.kind == kind)
                .map(|event| event.attempt)
        };
        let winner =
            last_of(TicketEventKind::Selected).or_else(|| last_of(TicketEventKind::Merged));
        let pick = match winner {
            Some(winner) => graded.iter().rfind(|event| event.attempt == winner),
            None => Some(last),
        };
        let Some(pick) = pick else {
            continue;
        };
        grades.insert(
            marker.id.clone(),
            TicketGradeSummary {
                attempt: pick.attempt,
                score: js::number_of(&pick.payload["score"]).unwrap_or(f64::NAN),
                verdict: pick.payload["verdict"].as_str().unwrap_or("").to_owned(),
                winner,
            },
        );
    }
    grades
}

// ---------------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------------

/// What a ticket's Vitals read off the runs directory, before the worktree diff: the worktree the last
/// spawned or resolver event names, the last event's raw `at` (`None` with no events, `Some(None)` when
/// that line has none), and the current attempt log's size and change time.
pub struct ActivityFacts {
    pub worktree: Option<String>,
    pub last_event_at: Option<Option<Value>>,
    pub log: Value,
}

/// The parts of a ticket's Vitals read fresh on every request: each is a stat or a cached events
/// parse. Legacy events carry no cwd; the search falls back to an older attempt that has one.
pub fn activity_facts(runs_dir: &Path, ticket_id: &str) -> ActivityFacts {
    let events = read_event_values(runs_dir, ticket_id);
    let worktree = events.iter().rev().find_map(|event| {
        let kind = event.get("kind").and_then(Value::as_str)?;
        if kind != "spawned" && kind != "resolver" {
            return None;
        }
        event
            .get("payload")
            .and_then(|payload| payload.get("cwd"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let last_event_at = events.last().map(|event| event.get("at").cloned());
    let attempts = list_attempt_logs(runs_dir, ticket_id);
    let log = attempts
        .last()
        .and_then(|current| std::fs::metadata(runs_dir.join(&current.log_file)).ok())
        .map_or(
            Value::Null,
            |meta| json!({ "size": meta.len(), "mtime": js::iso_of_ms(js::mtime_ms(&meta)) }),
        );
    ActivityFacts {
        worktree,
        last_event_at,
        log,
    }
}

/// A ticket's Vitals as GET /api/activity answers them, in the TypeScript's key order; `lastEventAt`
/// absent when the last event line has no `at`.
pub fn activity_value(
    ticket_id: &str,
    running: bool,
    diff: Option<Value>,
    facts: ActivityFacts,
) -> Value {
    let mut map = Map::new();
    map.insert("ticketId".into(), Value::from(ticket_id));
    map.insert("running".into(), Value::from(running));
    map.insert("diff".into(), diff.unwrap_or(Value::Null));
    map.insert("log".into(), facts.log);
    match facts.last_event_at {
        None => {
            map.insert("lastEventAt".into(), Value::Null);
        }
        Some(Some(at)) => {
            map.insert("lastEventAt".into(), at);
        }
        Some(None) => {}
    }
    Value::Object(map)
}

/// A worktree diff as the activity answer carries it.
pub fn diff_value(diff: &ac_io::git::ActivityDiff) -> Value {
    json!({ "added": diff.added, "removed": diff.removed, "files": diff.files })
}

/// The stamps the grades cache is keyed on, or `None` while any events file is inside the racy window.
pub fn grades_key(runs_dir: &Path, meta: &[TicketMarker]) -> Option<String> {
    let mut ordered = Vec::new();
    for marker in meta {
        let stamp = ac_core::events::events_stamp(runs_dir, &marker.id)?;
        ordered.push(json!([marker.id, stamp]));
    }
    Some(js::stringify(&Value::Array(ordered)))
}

/// An events file name's suffix (events.ts's `eventsFile`).
pub const EVENTS_SUFFIX: &str = ".events.jsonl";

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn log_file(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("01.log");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
        (dir, path)
    }

    // server.test.ts:1473
    #[test]
    fn serves_a_range_from_an_offset_with_the_total_size() {
        let (_dir, path) = log_file(b"0123456789abcdef\n");
        let range = read_log_range(&path, 4.0, None).unwrap();
        assert_eq!(range.content, "456789abcdef\n");
        assert_eq!(
            (range.offset, range.next_offset, range.total_size),
            (4.0, 17.0, 17)
        );
    }

    // server.test.ts:1504
    #[test]
    fn strips_csi_and_osc_sequences() {
        let (_dir, path) = log_file(b"line \x1b[31mred\x1b[0m text\n\x1b]0;title\x07next\n");
        assert_eq!(
            read_log_range(&path, 0.0, None).unwrap().content,
            "line red text\nnext\n"
        );
    }

    // server.test.ts:1519, :1631
    #[test]
    fn pages_a_log_larger_than_one_chunk() {
        let mut bytes = vec![b'x'; 65552];
        bytes.push(b'\n');
        let (_dir, path) = log_file(&bytes);
        let first = read_log_range(&path, 0.0, None).unwrap();
        assert_eq!(first.content.len(), 65536);
        assert_eq!((first.next_offset, first.total_size), (65536.0, 65553));
        let second = read_log_range(&path, first.next_offset, None).unwrap();
        assert_eq!(second.content, format!("{}\n", "x".repeat(16)));
        assert_eq!(second.next_offset, 65553.0);
        let clamped = read_log_range(&path, 0.0, Some(65553.0)).unwrap();
        assert_eq!(
            (clamped.content.len(), clamped.next_offset),
            (65536, 65536.0)
        );
    }

    // server.test.ts:1545, :1572
    #[test]
    fn never_splits_a_character_at_either_end() {
        let mut bytes = vec![b'a'; 65535];
        bytes.extend_from_slice("é tail\n".as_bytes());
        let (_dir, path) = log_file(&bytes);
        let first = read_log_range(&path, 0.0, None).unwrap();
        assert!(!first.content.contains('\u{FFFD}'));
        assert_eq!(first.next_offset, 65535.0);
        let second = read_log_range(&path, first.next_offset, None).unwrap();
        assert_eq!(second.content, "é tail\n");

        let (_dir, path) = log_file("aaaaaaaaaaé tail\n".as_bytes());
        let mid = read_log_range(&path, 11.0, None).unwrap();
        assert_eq!(mid.content, " tail\n");
        assert_eq!(
            (mid.offset, mid.next_offset, mid.total_size),
            (12.0, 18.0, 18)
        );
    }

    // server.test.ts:1597, :1610
    #[test]
    fn reads_nothing_past_the_end_and_bounds_a_range_by_its_end() {
        let (_dir, path) = log_file(b"short\n");
        let past = read_log_range(&path, 100.0, None).unwrap();
        assert_eq!((past.content.as_str(), past.total_size), ("", 6));
        let (_dir, path) = log_file(b"0123456789abcdef\n");
        let bounded = read_log_range(&path, 4.0, Some(10.0)).unwrap();
        assert_eq!(bounded.content, "456789");
        assert_eq!((bounded.offset, bounded.next_offset), (4.0, 10.0));
    }

    // ws.test.ts:921: a forward read stops short of an escape still arriving.
    #[test]
    fn holds_back_an_escape_sequence_still_arriving() {
        let (_dir, path) = log_file(b"red \x1b[38;5");
        let first = read_log_range(&path, 0.0, None).unwrap();
        assert_eq!((first.content.as_str(), first.next_offset), ("red ", 4.0));
    }

    #[test]
    fn a_nan_offset_reads_nothing_and_serialises_as_null() {
        let (_dir, path) = log_file(b"short\n");
        let range = read_log_range(&path, f64::NAN, None).unwrap();
        assert_eq!(range.content, "");
        assert_eq!(
            Value::Object(range.fields()),
            json!({"content": "", "offset": null, "nextOffset": null, "totalSize": 6})
        );
    }

    #[test]
    fn a_fractional_offset_fails_as_a_positioned_read_does() {
        let (_dir, path) = log_file(b"short\n");
        assert_eq!(
            read_log_range(&path, 1.5, None),
            Err(
                "The value of \"position\" is out of range. It must be an integer. Received 1.5"
                    .into()
            )
        );
    }

    #[test]
    fn a_missing_file_reads_as_empty() {
        let range = read_log_range(Path::new("/nonexistent/01.log"), 5.0, None).unwrap();
        assert_eq!(
            (range.offset, range.next_offset, range.total_size),
            (0.0, 0.0, 0)
        );
    }

    // server.test.ts:1439
    #[test]
    fn strips_the_state_marker_and_the_blank_lines_after_it() {
        assert_eq!(
            strip_state_marker(
                "<!-- state: id=01 blocked-by=none status=ready -->\n\n# Ticket body\n\nSpec: what to build\n"
            ),
            "# Ticket body\n\nSpec: what to build\n"
        );
        assert_eq!(strip_state_marker("# no marker\n"), "# no marker\n");
    }

    // server.test.ts:1417, :1428
    #[test]
    fn finds_the_issue_file_by_exact_name_then_by_prefix() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("01-ticket-body.md"), "x").unwrap();
        std::fs::write(dir.path().join("012.md"), "x").unwrap();
        assert_eq!(
            ticket_body_file(dir.path(), "01"),
            Some(dir.path().join("01-ticket-body.md"))
        );
        std::fs::write(dir.path().join("01.md"), "x").unwrap();
        assert_eq!(
            ticket_body_file(dir.path(), "01"),
            Some(dir.path().join("01.md"))
        );
        assert_eq!(ticket_body_file(dir.path(), "zzz"), None);
    }

    // NOT-PORTED.md, http "Left out": GET /api/ticket?id=01 beside an adopted 01-spawn-1.md.
    #[test]
    fn ticket_body_lookup_takes_the_file_whose_state_line_names_the_id_in_any_listing_order() {
        for spawn_first in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let own = "<!-- state: id=01 blocked-by=none status=done -->\n\n# own\n";
            let child = "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 -->\n\n# child\n";
            let files = [("01-a.md", own), ("01-spawn-1.md", child)];
            let order: Vec<_> = if spawn_first {
                files.iter().rev().collect()
            } else {
                files.iter().collect()
            };
            for (name, text) in order {
                std::fs::write(dir.path().join(name), text).unwrap();
            }
            assert_eq!(
                ticket_body_file(dir.path(), "01"),
                Some(dir.path().join("01-a.md"))
            );
            assert_eq!(
                ticket_body(dir.path(), "01").unwrap().unwrap().body,
                "# own\n"
            );
            assert_eq!(
                ticket_body_file(dir.path(), "01-spawn-1"),
                Some(dir.path().join("01-spawn-1.md"))
            );
        }
        // A child alone never answers for its parent's id.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("01-spawn-1.md"),
            "<!-- state: id=01-spawn-1 blocked-by=none status=ready -->\n",
        )
        .unwrap();
        assert_eq!(ticket_body_file(dir.path(), "01"), None);
    }

    #[test]
    fn card_events_drop_log_tail_from_object_payloads_only() {
        let events = json!({
            "events": [
                {"at": "t", "attempt": 1, "kind": "exited", "payload": {"code": 0, "logTail": ["x"], "status": "done"}},
                {"at": "t", "attempt": 1, "kind": "spawned", "payload": "odd"},
            ],
            "attempts": [], "reconstructed": false, "spec": "",
        });
        assert_eq!(
            card_events(events)["events"],
            json!([
                {"at": "t", "attempt": 1, "kind": "exited", "payload": {"code": 0, "status": "done"}},
                {"at": "t", "attempt": 1, "kind": "spawned", "payload": "odd"},
            ])
        );
    }
}
