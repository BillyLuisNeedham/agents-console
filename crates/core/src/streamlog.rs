//! An attempt's Stream file and the log derived from it (engine/streamlog.ts, ADR-0012 and ADR-0016),
//! and the attempt log files around them: the rotation before a re-run (attempt-run.ts's
//! rotateAttemptLog), the attempts GET /api/log lists (server.ts's listAttemptLogs), and the attempts
//! a pool from before events existed is reconstructed into (server.ts's reconstructAttempts).
//!
//! A streaming harness's structured JSONL turns into the human-readable attempt log, live in the spawn
//! pump: assistant text passes through verbatim, and each tool call becomes one `[tool] Name: summary`
//! line, the summary being the call's salient argument (the command for Bash, the file for
//! Read/Write/Edit). Anything the deriver cannot parse or recognize passes through to the log verbatim
//! rather than being dropped: the stream-json schema drifts with harness releases, and a silently
//! degrading log is worse than a raw one. A terminal-backed attempt's Stream file is a `script`
//! typescript instead, and its log is that transcript with the terminal's escapes removed.

use std::collections::BTreeMap;
use std::path::Path;

use ac_protocol::{LogAttemptInfo, LogAttemptKind, ReconstructedAttempt, TicketEventKind};
use serde_json::{Map, Value};

use crate::events::{
    attempt_log_name, attempt_stream_name, last_attempt_of_kind, parse_attempt_log_name,
    read_events,
};
use crate::js;

// ---------------------------------------------------------------------------
// The stream log deriver
// ---------------------------------------------------------------------------

// The one input field worth showing per known tool; anything else falls back to the first string
// field the call carries.
fn tool_summary_field(name: &str) -> ToolField {
    match name {
        "Bash" => ToolField::Key("command"),
        "Read" | "Write" | "Edit" | "MultiEdit" => ToolField::Key("file_path"),
        "NotebookEdit" => ToolField::Key("notebook_path"),
        "Grep" | "Glob" => ToolField::Key("pattern"),
        "WebFetch" => ToolField::Key("url"),
        "WebSearch" => ToolField::Key("query"),
        "Task" | "Agent" => ToolField::Key("description"),
        // The TypeScript's table is a plain object, so a name that is one of Object.prototype's own
        // properties finds that property instead of nothing, and looks up a key no input has.
        "constructor"
        | "__defineGetter__"
        | "__defineSetter__"
        | "hasOwnProperty"
        | "__lookupGetter__"
        | "__lookupSetter__"
        | "isPrototypeOf"
        | "propertyIsEnumerable"
        | "toString"
        | "valueOf"
        | "__proto__"
        | "toLocaleString" => ToolField::Nothing,
        _ => ToolField::Key(""),
    }
}

enum ToolField {
    Key(&'static str),
    Nothing,
}

// A summary is for scanning, not for reading whole files pasted as arguments; beyond this it
// truncates with an ellipsis.
const TOOL_SUMMARY_MAX_CHARS: usize = 200;

// Current-schema stream events the log has no use for: system init, user (tool results), the final
// result. Recognized, nothing to say, so they contribute no log line; the Stream file keeps them
// verbatim. An event type outside this set and "assistant" is schema drift and passes through.
const SILENT_EVENT_TYPES: [&str; 3] = ["system", "user", "result"];

// Content blocks the log has no use for inside an assistant message: thinking is not the assistant's
// text, and the Stream file keeps it verbatim for forensics.
const SILENT_BLOCK_TYPES: [&str; 2] = ["thinking", "redacted_thinking"];

/// The log text one structured stream line contributes, or `None` when the line is unparseable or
/// unrecognized and must pass through verbatim. A recognized event with nothing to say gives `""` (the
/// caller writes no log line for it). Multi-line assistant text stays multi-line: the text is verbatim.
pub fn derive_stream_line(line: &str) -> Option<String> {
    let Ok(Value::Object(event)) = js::parse(line) else {
        return None;
    };
    let kind = event.get("type");
    if kind.and_then(Value::as_str) != Some("assistant") {
        return match kind {
            Some(Value::String(kind)) if SILENT_EVENT_TYPES.contains(&kind.as_str()) => {
                Some(String::new())
            }
            _ => None,
        };
    }
    let Some(Value::Object(message)) = event.get("message") else {
        return None;
    };
    let Some(Value::Array(content)) = message.get("content") else {
        return None;
    };
    let mut parts: Vec<String> = Vec::new();
    let mut saw_known_block = false;
    let mut saw_unknown_block = false;
    let empty = Map::new();
    for item in content {
        let block = match item {
            Value::Object(block) => block,
            // An array is an object to `typeof`, with none of a block's fields.
            Value::Array(_) => &empty,
            _ => return None,
        };
        let block_type = block.get("type");
        let text = block.get("text").and_then(Value::as_str);
        let name = block.get("name").and_then(Value::as_str);
        match (block_type.and_then(Value::as_str), text, name) {
            (Some("text"), Some(text), _) => {
                saw_known_block = true;
                parts.push(text.to_owned());
            }
            (Some("tool_use"), _, Some(name)) if !js::trim(name).is_empty() => {
                saw_known_block = true;
                let summary = tool_summary(name, block.get("input"));
                parts.push(if summary.is_empty() {
                    format!("[tool] {name}:")
                } else {
                    format!("[tool] {name}: {summary}")
                });
            }
            (Some(kind), _, _) if SILENT_BLOCK_TYPES.contains(&kind) => saw_known_block = true,
            // A content block the deriver does not know is schema drift. It costs the message its
            // line only when nothing in the message is known: known blocks still derive, so drift
            // degrades the log instead of replacing recognized content with a raw JSON wall.
            _ => saw_unknown_block = true,
        }
    }
    if parts.is_empty() && saw_unknown_block && !saw_known_block {
        return None;
    }
    Some(parts.join("\n"))
}

fn tool_summary(name: &str, input: Option<&Value>) -> String {
    let mut text: Option<&str> = None;
    match input {
        Some(Value::Object(fields)) => {
            let salient = match tool_summary_field(name) {
                ToolField::Key(key) => fields.get(key),
                ToolField::Nothing => None,
            };
            text = match salient {
                Some(Value::String(salient)) => Some(salient),
                _ => js::own_entries(fields)
                    .into_iter()
                    .find_map(|(_, value)| value.as_str().filter(|s| !js::trim(s).is_empty())),
            };
        }
        Some(Value::Array(items)) => {
            text = items
                .iter()
                .find_map(|value| value.as_str().filter(|s| !js::trim(s).is_empty()));
        }
        _ => {}
    }
    let flat = join_lines(js::trim(text.unwrap_or("")));
    if js::utf16_len(&flat) > TOOL_SUMMARY_MAX_CHARS {
        return format!(
            "{}...",
            js::utf16_prefix_lossy(&flat, TOOL_SUMMARY_MAX_CHARS)
        );
    }
    flat
}

// `text.replace(/\r?\n\s*/g, " ")`: each line break, with the whitespace after it, becomes one space.
fn join_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let breaks = c == '\n' || (c == '\r' && chars.peek() == Some(&'\n'));
        if !breaks {
            out.push(c);
            continue;
        }
        if c == '\r' {
            chars.next();
        }
        while chars.peek().is_some_and(|c| js::is_whitespace(*c)) {
            chars.next();
        }
        out.push(' ');
    }
    out
}

/// The incremental line splitter the pump feeds raw stream chunks through: bytes accumulate until a
/// newline closes a line, so a line split across chunks (or a multi-byte character split mid-way)
/// derives exactly once, as one line. `\r\n` line endings lose the carriage return: the log is a
/// derived view, and the verbatim bytes live in the Stream file. `push` and `flush` return the lines
/// each call completed, in order.
#[derive(Debug, Default)]
pub struct StreamLineBuffer {
    decoder: js::Utf8Decoder,
    pending: String,
}

impl StreamLineBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one raw chunk; returns the lines it completed, in order.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.push_str(&self.decoder.decode(chunk, true));
        take_lines(&mut self.pending)
            .into_iter()
            .map(strip_carriage_return)
            .collect()
    }

    /// A final unterminated line, if one remains, at end of stream.
    pub fn flush(&mut self) -> Vec<String> {
        let rest = std::mem::take(&mut self.pending) + &self.decoder.decode(&[], false);
        if rest.is_empty() {
            Vec::new()
        } else {
            vec![strip_carriage_return(rest)]
        }
    }
}

fn take_lines(pending: &mut String) -> Vec<String> {
    let Some(last) = pending.rfind('\n') else {
        return Vec::new();
    };
    let rest = pending.split_off(last + 1);
    let done = std::mem::replace(pending, rest);
    let mut lines: Vec<String> = done.split('\n').map(str::to_owned).collect();
    lines.pop();
    lines
}

fn strip_carriage_return(mut line: String) -> String {
    if line.ends_with('\r') {
        line.pop();
    }
    line
}

/// The transcript line buffer for a terminal-backed attempt (ADR-0016): the Stream file is a `script`
/// typescript, raw ANSI recording both directions of the session, and the derived log is that
/// transcript with the ANSI and control noise removed. The buffer strips escape sequences
/// incrementally (a sequence split across chunks is held back until the next chunk completes it), then
/// splits on line endings exactly like `StreamLineBuffer`. What the log keeps is the readable text:
/// printable characters, `\n`, and `\t`. Everything else a terminal paints with is dropped: CSI
/// sequences (colours, cursor moves), OSC sequences (title and kitty sequences), other escape
/// sequences (charset designators, screen saves), and C0 controls including the `\r` of a CRLF line
/// ending and the standalone carriage return a redraw uses to overwrite a line.
#[derive(Debug, Default)]
pub struct TranscriptLineBuffer {
    decoder: js::Utf8Decoder,
    pending: String,
    escape: Option<String>,
}

impl TranscriptLineBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one raw chunk; returns the transcript lines it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let text = self.decoder.decode(chunk, true);
        let cleaned = self.clean(&text);
        self.pending.push_str(&cleaned);
        take_lines(&mut self.pending)
    }

    /// A final unterminated line, if one remains, at end of stream.
    pub fn flush(&mut self) -> Vec<String> {
        let tail = self.decoder.decode(&[], false);
        let rest = std::mem::take(&mut self.pending) + &self.clean(&tail);
        if rest.is_empty() {
            Vec::new()
        } else {
            vec![rest]
        }
    }

    // Cleaned text: ANSI escapes and control characters removed. A partial escape sequence at the end
    // of the input is held in `escape` until the next call completes it.
    fn clean(&mut self, text: &str) -> String {
        let work: Vec<char> = self
            .escape
            .take()
            .unwrap_or_default()
            .chars()
            .chain(text.chars())
            .collect();
        let held = |from: usize| work[from..].iter().collect::<String>();
        let n = work.len();
        let mut out = String::with_capacity(text.len());
        let mut i = 0;
        while i < n {
            let ch = work[i];
            if ch != '\x1b' {
                if ch == '\n' || ch == '\t' || ch >= ' ' {
                    out.push(ch);
                }
                i += 1;
                continue;
            }
            let Some(&next) = work.get(i + 1) else {
                self.escape = Some(held(i));
                break;
            };
            if next == '[' {
                // CSI: `ESC [` parameter and intermediate bytes then a final byte in [@-~]. A sequence
                // that runs out of input is held back.
                let Some(end) = (i + 2..n).find(|&j| ('@'..='~').contains(&work[j])) else {
                    self.escape = Some(held(i));
                    break;
                };
                i = end + 1;
            } else if matches!(next, ']' | 'P' | '_' | '^' | 'X') {
                // OSC, DCS, APC, PM and SOS string sequences: payload until BEL or ST (`ESC \`).
                // Anything until the terminator is dropped.
                let end = (i + 2..n).find_map(|j| match work[j] {
                    '\x07' => Some(j),
                    '\x1b' if work.get(j + 1) == Some(&'\\') => Some(j + 1),
                    _ => None,
                });
                let Some(end) = end else {
                    self.escape = Some(held(i));
                    break;
                };
                i = end + 1;
            } else if matches!(next, '(' | ')' | '*' | '+' | '-' | '.' | '/') {
                // Charset designator `ESC ( X`: three code units, held back if split.
                let Some(third) = work.get(i + 2) else {
                    self.escape = Some(held(i));
                    break;
                };
                // Three code units end inside a character beyond U+FFFF: its low half is kept, which
                // reaches the log file as U+FFFD.
                if third.len_utf16() == 2 {
                    out.push('\u{fffd}');
                }
                i += 3;
            } else {
                // Two-byte escape (`ESC 7`, `ESC M`, ...): drop both, and as above for a character
                // beyond U+FFFF.
                if next.len_utf16() == 2 {
                    out.push('\u{fffd}');
                }
                i += 2;
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Attempt log files
// ---------------------------------------------------------------------------

/// Attempt rotation on re-run (ADR 0002): before a new attempt writes, an existing well-known log
/// moves to its attempt-numbered name so a re-run never destroys the ticket's history, and its Stream
/// file rotates with it (ADR-0012). The number is the attempt the events file recorded for the run
/// that wrote the file: the last exited implement (or engine-run) attempt for the base log, the last
/// resolver run for the resolver log, so `kind` is `Exited` or `Resolver`. A log from before events
/// existed rotates to attempt-0.
pub fn rotate_attempt_log(
    runs_dir: &Path,
    ticket_id: &str,
    well_known_path: &Path,
    kind: TicketEventKind,
) -> Result<(), js::FsError> {
    let resolver = kind == TicketEventKind::Resolver;
    let attempt = last_attempt_of_kind(runs_dir, ticket_id, kind);
    if well_known_path.exists() {
        js::rename(
            well_known_path,
            runs_dir.join(attempt_log_name(ticket_id, Some(attempt), resolver)),
        )?;
    }
    // The Stream file was written by the run that wrote the log, so it rotates under the same attempt
    // number. Rotated independently of the log: a stream-only leftover (a run that died before any
    // log line derived) must still rotate.
    let well_known_stream = runs_dir.join(attempt_stream_name(ticket_id, None, resolver));
    if well_known_stream.exists() {
        js::rename(
            &well_known_stream,
            runs_dir.join(attempt_stream_name(ticket_id, Some(attempt), resolver)),
        )?;
    }
    Ok(())
}

/// The attempts GET /api/log lists for a Ticket, each with its log file and its Stream file. The
/// current attempt of each kind reads from the well-known name while it is on disk; every other one
/// from its attempt-numbered name. A Stream file that is not on disk is `None`, so a raw harness's
/// attempt shows no link rather than a dead one. A verify fan-out's attempts write attempt-numbered
/// logs directly and the well-known name never appears, so the current attempt falls back to its own
/// number. A ticket with no events file lists the reconstructed rows, each with the log file it was
/// built from and no Stream file.
pub fn list_attempt_logs(runs_dir: &Path, ticket_id: &str) -> Vec<LogAttemptInfo> {
    let events = read_events(runs_dir, ticket_id);
    if events.is_empty() {
        let reconstructed = reconstruct_attempts(runs_dir, ticket_id);
        let last = reconstructed.len().saturating_sub(1);
        return reconstructed
            .into_iter()
            .enumerate()
            .map(|(index, row)| LogAttemptInfo {
                attempt: row.attempt,
                kind: LogAttemptKind::Reconstructed,
                current: index == last,
                log_file: row.log_file,
                stream_file: None,
            })
            .collect();
    }
    let attempts_of = |kind: TicketEventKind| {
        events
            .iter()
            .filter(move |event| event.kind == kind)
            .map(|event| event.attempt)
    };
    let mut by_attempt: BTreeMap<u64, LogAttemptInfo> = BTreeMap::new();
    for (kind, resolver, row_kind) in [
        (TicketEventKind::Spawned, false, LogAttemptKind::Implement),
        (TicketEventKind::Resolver, true, LogAttemptKind::Resolver),
    ] {
        let max = attempts_of(kind).fold(0, u64::max);
        let well_known_log = runs_dir
            .join(attempt_log_name(ticket_id, None, resolver))
            .exists();
        let well_known_stream = runs_dir
            .join(attempt_stream_name(ticket_id, None, resolver))
            .exists();
        for attempt in attempts_of(kind) {
            let current = attempt == max;
            let stream = attempt_stream_name(
                ticket_id,
                (!(current && well_known_stream)).then_some(attempt),
                resolver,
            );
            by_attempt.insert(
                attempt,
                LogAttemptInfo {
                    attempt,
                    kind: row_kind,
                    current,
                    log_file: attempt_log_name(
                        ticket_id,
                        (!(current && well_known_log)).then_some(attempt),
                        resolver,
                    ),
                    stream_file: runs_dir.join(&stream).exists().then_some(stream),
                },
            );
        }
    }
    by_attempt.into_values().collect()
}

/// A pre-feature Ticket's attempts (no events file): one row per log file of the four names the naming
/// contract produces, in modification-time order, numbered from 1.
pub fn reconstruct_attempts(runs_dir: &Path, ticket_id: &str) -> Vec<ReconstructedAttempt> {
    let Ok(files) = js::read_dir_names(runs_dir) else {
        return Vec::new();
    };
    let mut logs: Vec<(String, f64)> = files
        .into_iter()
        .filter(|file| parse_attempt_log_name(ticket_id, file).is_some())
        .filter_map(|file| {
            let meta = std::fs::metadata(runs_dir.join(&file)).ok()?;
            Some((file, js::mtime_ms(&meta)))
        })
        .collect();
    logs.sort_by(|a, b| a.1.total_cmp(&b.1));
    logs.into_iter()
        .enumerate()
        .map(|(index, (file, mtime))| ReconstructedAttempt {
            attempt: index as u64 + 1,
            log_file: file,
            modified_at: js::iso_of_ms(mtime),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::append_event;
    use ac_protocol::TicketEvent;
    use std::fs;

    fn derive(line: &str) -> Option<String> {
        derive_stream_line(line)
    }

    #[test]
    fn passes_assistant_text_through_verbatim_and_multi_line() {
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the spec now."}]}}"#).as_deref(),
            Some("Reading the spec now.")
        );
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"line one\nline two"}]}}"#).as_deref(),
            Some("line one\nline two")
        );
    }

    #[test]
    fn derives_one_tool_line_per_call_with_its_salient_field() {
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test engine/"}}]}}"#).as_deref(),
            Some("[tool] Bash: bun test engine/")
        );
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a/b.ts","limit":10}}]}}"#).as_deref(),
            Some("[tool] Read: /a/b.ts")
        );
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Mystery","input":{"count":3,"target":"the thing"}}]}}"#).as_deref(),
            Some("[tool] Mystery: the thing")
        );
        // Object.values walks array-index keys first.
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Mystery","input":{"b":"second","7":"first"}}]}}"#).as_deref(),
            Some("[tool] Mystery: first")
        );
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":""}}]}}"#).as_deref(),
            Some("[tool] Bash:")
        );
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"toString","input":{"":"x"}}]}}"#).as_deref(),
            Some("[tool] toString: x")
        );
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"X","input":["", " y "]}]}}"#).as_deref(),
            Some("[tool] X: y")
        );
        // Cut in UTF-16 units: 100 emoji fill the 200 exactly, and the 101st goes.
        let emoji = "😀".repeat(101);
        assert_eq!(
            derive(&format!(
                r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":"{emoji}"}}}}]}}}}"#
            )),
            Some(format!("[tool] Bash: {}...", "😀".repeat(100)))
        );
    }

    #[test]
    fn collapses_newlines_inside_a_summary_and_truncates_a_long_one() {
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo a\necho b"}}]}}"#).as_deref(),
            Some("[tool] Bash: echo a echo b")
        );
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"a\r\n   \n b\rc"}}]}}"#).as_deref(),
            Some("[tool] Bash: a b\rc")
        );
        let long = "x".repeat(300);
        assert_eq!(
            derive(&format!(
                r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":"{long}"}}}}]}}}}"#
            )),
            Some(format!("[tool] Bash: {}...", "x".repeat(200)))
        );
    }

    #[test]
    fn derives_text_and_tool_blocks_of_one_event_in_content_order() {
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Running"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#).as_deref(),
            Some("Running\n[tool] Bash: ls")
        );
    }

    #[test]
    fn writes_no_line_for_events_it_recognises_and_has_no_use_for() {
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[]}}"#).as_deref(),
            Some("")
        );
        assert_eq!(
            derive(r#"{"type":"system","subtype":"init"}"#).as_deref(),
            Some("")
        );
        assert_eq!(
            derive(r#"{"type":"result","usage":{}}"#).as_deref(),
            Some("")
        );
        assert_eq!(
            derive(
                r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#
            )
            .as_deref(),
            Some("")
        );
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"The answer."}]}}"#).as_deref(),
            Some("The answer.")
        );
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}"#).as_deref(),
            Some("")
        );
    }

    #[test]
    fn passes_through_lines_and_shapes_it_does_not_know() {
        for line in [
            r#"{"type":"future-event","data":{}}"#,
            "fake claude ran",
            "",
            "[1,2,3]",
            r#""just a string""#,
            r#"{"type":"assistant","message":{"content":"a plain string"}}"#,
            r#"{"type":"assistant"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"future-block"}]}}"#,
            r#"{"type":"assistant","message":{"content":[[]]}}"#,
            r#"{"type":"assistant","message":{"content":["text"]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"a"},null]}}"#,
        ] {
            assert_eq!(derive(line), None, "{line}");
        }
        // Drift costs a message its line only when nothing in it is known.
        assert_eq!(
            derive(r#"{"type":"assistant","message":{"content":[{"type":"future-block"},{"type":"text","text":"kept"}]}}"#).as_deref(),
            Some("kept")
        );
    }

    #[test]
    fn stream_line_buffer_splits_reassembles_and_flushes_once() {
        let mut buffer = StreamLineBuffer::new();
        assert_eq!(buffer.push(b"alpha\nbeta\n"), ["alpha", "beta"]);
        let bytes = "one-two-three\n".as_bytes();
        assert!(buffer.push(&bytes[..5]).is_empty());
        assert_eq!(buffer.push(&bytes[5..]), ["one-two-three"]);
        let bytes = "héllo\n".as_bytes();
        assert!(buffer.push(&bytes[..2]).is_empty());
        assert_eq!(buffer.push(&bytes[2..]), ["héllo"]);
        assert_eq!(buffer.push(b"cr-lf\r\n"), ["cr-lf"]);
        assert_eq!(buffer.push(b"complete\npartial\r"), ["complete"]);
        assert_eq!(buffer.flush(), ["partial"]);
        assert!(buffer.flush().is_empty());
        assert_eq!(buffer.push(b"done\n"), ["done"]);
        assert!(buffer.flush().is_empty());
    }

    #[test]
    fn transcript_buffer_keeps_the_readable_text_of_a_typescript() {
        let mut buffer = TranscriptLineBuffer::new();
        assert_eq!(
            buffer.push(b"\x1b[32mClaude Code v2.1.263\x1b[0m\r\nhello from the TUI\r\n"),
            ["Claude Code v2.1.263", "hello from the TUI"]
        );
        assert_eq!(
            buffer.push(b"\x1b]0;title\x07agent output\x1b7\x1b8\x1b[1A\x1b[2Kprogress done\r\n"),
            ["agent outputprogress done"]
        );
        assert_eq!(
            buffer.push("❯ /implement /tmp/pool/issues/01-t.md\r\n".as_bytes()),
            ["❯ /implement /tmp/pool/issues/01-t.md"]
        );
        assert_eq!(
            buffer.push("one\r\n\r\ntwo ✓\r\n".as_bytes()),
            ["one", "", "two ✓"]
        );
        assert_eq!(buffer.push(b"a\x1b(Bb\x1b]2;t\x1b\\c\x01\td\n"), ["abc\td"]);
        // An escape that ends inside a character beyond U+FFFF keeps its low half, as U+FFFD.
        assert_eq!(
            buffer.push("a\x1b(😀b\x1b😀c\n".as_bytes()),
            ["a\u{fffd}b\u{fffd}c"]
        );
    }

    #[test]
    fn transcript_buffer_holds_back_a_split_escape_and_flushes_once() {
        let mut buffer = TranscriptLineBuffer::new();
        let bytes = b"\x1b[32mcoloured\x1b[0m\r\n";
        assert!(buffer.push(&bytes[..4]).is_empty());
        assert_eq!(buffer.push(&bytes[4..]), ["coloured"]);
        assert!(buffer.push(b"x\x1b").is_empty());
        assert_eq!(buffer.push(b"]0;t"), Vec::<String>::new());
        assert_eq!(buffer.push(b"\x07y\n"), ["xy"]);
        assert!(buffer.push(b"partial\x1b[0m").is_empty());
        assert_eq!(buffer.flush(), ["partial"]);
        assert!(buffer.flush().is_empty());
        assert!(buffer.push(b"tail\x1b(").is_empty());
        assert_eq!(buffer.flush(), ["tail"]);
    }

    fn temp_runs() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("streamlog-test-")
            .tempdir()
            .unwrap()
    }

    fn event(attempt: u64, kind: TicketEventKind) -> TicketEvent {
        TicketEvent {
            at: "2026-01-01T00:00:00.000Z".into(),
            attempt,
            kind,
            payload: Map::new(),
        }
    }

    // attempt-run.test.ts:347, and the conformance case for a pre-events log.
    #[test]
    fn rotates_the_well_known_log_and_stream_file_to_the_last_exited_attempt() {
        let runs = temp_runs();
        let dir = runs.path();
        fs::write(dir.join("01.log"), "attempt one's log\n").unwrap();
        fs::write(dir.join("01.stream.jsonl"), "{}\n").unwrap();
        for e in [
            event(1, TicketEventKind::Spawned),
            event(1, TicketEventKind::Exited),
            event(2, TicketEventKind::Spawned),
        ] {
            append_event(dir, "01", &e).unwrap();
        }
        rotate_attempt_log(dir, "01", &dir.join("01.log"), TicketEventKind::Exited).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("01.attempt-1.log")).unwrap(),
            "attempt one's log\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("01.attempt-1.stream.jsonl")).unwrap(),
            "{}\n"
        );
        assert!(!dir.join("01.log").exists());
        assert!(!dir.join("01.stream.jsonl").exists());

        // A lone leftover Stream file from before events rotates to attempt-0 by itself.
        fs::write(dir.join("02.stream.jsonl"), "old\n").unwrap();
        rotate_attempt_log(dir, "02", &dir.join("02.log"), TicketEventKind::Exited).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("02.attempt-0.stream.jsonl")).unwrap(),
            "old\n"
        );
        assert!(!dir.join("02.attempt-0.log").exists());
    }

    #[test]
    fn rotates_a_resolver_log_under_the_last_resolver_run() {
        let runs = temp_runs();
        let dir = runs.path();
        fs::write(dir.join("02.resolver.log"), "first\n").unwrap();
        fs::write(dir.join("02.resolver.stream.jsonl"), "s\n").unwrap();
        for e in [
            event(1, TicketEventKind::Exited),
            event(2, TicketEventKind::Resolver),
            event(3, TicketEventKind::Exited),
        ] {
            append_event(dir, "02", &e).unwrap();
        }
        rotate_attempt_log(
            dir,
            "02",
            &dir.join("02.resolver.log"),
            TicketEventKind::Resolver,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("02.attempt-2.resolver.log")).unwrap(),
            "first\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("02.attempt-2.resolver.stream.jsonl")).unwrap(),
            "s\n"
        );
    }

    #[test]
    fn lists_each_attempt_with_its_log_and_stream_file() {
        let runs = temp_runs();
        let dir = runs.path();
        for e in [
            event(1, TicketEventKind::Spawned),
            event(1, TicketEventKind::Exited),
            event(2, TicketEventKind::Spawned),
            event(3, TicketEventKind::Spawned),
            event(3, TicketEventKind::Resolver),
        ] {
            append_event(dir, "01", &e).unwrap();
        }
        for file in [
            "01.attempt-1.log",
            "01.attempt-1.stream.jsonl",
            "01.log",
            "01.resolver.log",
            "01.resolver.stream.jsonl",
        ] {
            fs::write(dir.join(file), "x").unwrap();
        }
        let info = |attempt, kind, current, log: &str, stream: Option<&str>| LogAttemptInfo {
            attempt,
            kind,
            current,
            log_file: log.into(),
            stream_file: stream.map(str::to_owned),
        };
        assert_eq!(
            list_attempt_logs(dir, "01"),
            [
                info(
                    1,
                    LogAttemptKind::Implement,
                    false,
                    "01.attempt-1.log",
                    Some("01.attempt-1.stream.jsonl")
                ),
                info(
                    2,
                    LogAttemptKind::Implement,
                    false,
                    "01.attempt-2.log",
                    None
                ),
                // The resolver's own spawned event is overwritten by its resolver row.
                info(
                    3,
                    LogAttemptKind::Resolver,
                    true,
                    "01.resolver.log",
                    Some("01.resolver.stream.jsonl")
                ),
            ]
        );
    }

    // events.test.ts:133 and :152, the reconstruction of a pool with no events file.
    #[test]
    fn reconstructs_a_pre_events_pool_from_its_log_names_by_age() {
        let runs = temp_runs();
        let dir = runs.path();
        let files = [
            "01.log",
            "01.attempt-3.log",
            "01.resolver.log",
            "01.attempt-4.resolver.log",
        ];
        for (i, file) in files.iter().enumerate() {
            let path = dir.join(file);
            fs::write(&path, "x").unwrap();
            let at =
                std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_767_225_600 + i as u64);
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(at))
                .unwrap();
        }
        for other in [
            "02.log",
            "01.outcome.json",
            "01.attempt-x.log",
            "01.attempt-01.log",
        ] {
            fs::write(dir.join(other), "x").unwrap();
        }
        let rows = reconstruct_attempts(dir, "01");
        assert_eq!(
            rows,
            files
                .iter()
                .enumerate()
                .map(|(i, file)| ReconstructedAttempt {
                    attempt: i as u64 + 1,
                    log_file: (*file).into(),
                    modified_at: format!("2026-01-01T00:00:0{i}.000Z"),
                })
                .collect::<Vec<_>>()
        );
        let listed = list_attempt_logs(dir, "01");
        assert_eq!(listed.len(), 4);
        assert!(listed[3].current && !listed[2].current);
        assert_eq!(listed[0].kind, LogAttemptKind::Reconstructed);
        assert_eq!(reconstruct_attempts(&dir.join("missing"), "01"), []);
    }
}
