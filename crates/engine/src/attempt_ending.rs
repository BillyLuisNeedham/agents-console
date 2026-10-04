//! The Attempt ending (attempt-ending.ts): how an Attempt ended, with what code, result and crash
//! reason.
//!
//! STUB(attempt_ending): the attempt launch port owns this module and its waits. What is here is the
//! pure part the engine core reads: the result reader, the engine's own exit codes and the words for
//! them.

use std::path::Path;

use serde_json::Value;

/// No exit code ever arrived: the wrapper's file was missing or unparseable after every retry.
pub const EXIT_CODE_UNREADABLE: i64 = -1;
/// The pane left herdr's listing and no exit code was written.
pub const EXIT_CODE_PANE_GONE: i64 = -2;
/// The engine's own codes for a botched interactive spawn.
pub const SPAWN_INTERACTIVE_READY_FAILED: i64 = -3;
pub const SPAWN_INTERACTIVE_PROMPT_FAILED: i64 = -4;
pub const SPAWN_INTERACTIVE_WRAPPER_LOST: i64 = -5;

/// A site's check of one parse of its result file: the valid result, or why it is not one.
pub type ResultValidator<R> = fn(&Value) -> Result<R, String>;

/// `readAttemptResult`: the one result reader (ADR-0005). A missing file and an unparseable one have
/// the same two reasons everywhere; what a valid result looks like is the site's validator.
pub fn read_attempt_result<R>(path: &Path, validate: ResultValidator<R>) -> Result<R, String> {
    if !path.exists() {
        return Err("no outcome written".into());
    }
    let Ok(text) = ac_core::js::read_text(path) else {
        return Err("outcome is not parseable JSON".into());
    };
    match ac_core::js::parse(&text) {
        Ok(parsed) => validate(&parsed),
        Err(_) => Err("outcome is not parseable JSON".into()),
    }
}

/// `exitCrashReason`: the crash reason for a non-zero exit, whose causes want different words.
pub fn exit_crash_reason(
    code: i64,
    exit_code_path: &str,
    subject: &str,
    pane_id: Option<&str>,
) -> String {
    match code {
        SPAWN_INTERACTIVE_READY_FAILED => "TUI never became ready".into(),
        SPAWN_INTERACTIVE_PROMPT_FAILED => "prompt never landed".into(),
        SPAWN_INTERACTIVE_WRAPPER_LOST => "launch command never ran".into(),
        EXIT_CODE_UNREADABLE => format!(
            "{subject} exit code unreadable: the pane wrapper never wrote a usable {exit_code_path}"
        ),
        EXIT_CODE_PANE_GONE => format!(
            "{subject} pane gone: {} left herdr's listing and no exit code was written to \
             {exit_code_path}",
            pane_id.unwrap_or("the pane")
        ),
        _ => format!("{subject} exited {code}"),
    }
}

/// `attemptCrashReason`: names a shutdown stop as what it was (ADR-0017).
pub fn attempt_crash_reason(
    stopping: bool,
    code: i64,
    exit_code_path: &str,
    subject: &str,
    pane_id: Option<&str>,
) -> String {
    if stopping && pane_id.is_none() && code > 0 {
        return format!("{subject} stopped by engine shutdown (exited {code})");
    }
    exit_crash_reason(code, exit_code_path, subject, pane_id)
}

/// `exitedPhrase`: how the pool log names the ending in passing.
pub fn exited_phrase(code: i64) -> String {
    match code {
        EXIT_CODE_UNREADABLE => "ended with no exit code".into(),
        EXIT_CODE_PANE_GONE => "ended with its pane gone".into(),
        SPAWN_INTERACTIVE_READY_FAILED => "ended before its TUI became ready".into(),
        SPAWN_INTERACTIVE_PROMPT_FAILED => "ended before its prompt landed".into(),
        SPAWN_INTERACTIVE_WRAPPER_LOST => "ended before its launch command ran".into(),
        _ => format!("exited {code}"),
    }
}
