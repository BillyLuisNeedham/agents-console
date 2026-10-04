//! The durable record of a drive death (engine.ts's reportDriveDeath): one JSON line per death in
//! `runs/errors.jsonl`, `{"at", "error", "stack"?}`, beside the pool log line the Console's log drawer
//! shows. The disk may be exactly what is failing, so the caller treats a write that fails as
//! best-effort and goes on to the dead phase regardless.

use std::path::Path;

use serde_json::{Map, Value};

use crate::js;

/// The file's name under runs/.
pub const ERRORS_LOG_NAME: &str = "errors.jsonl";

/// Append one drive death to `runs/errors.jsonl`, making runs/ first. `stack` is written only when
/// there is one.
pub fn record_drive_death(
    runs_dir: &Path,
    message: &str,
    stack: Option<&str>,
) -> Result<(), js::FsError> {
    js::mkdir_all(runs_dir)?;
    let mut record = Map::new();
    record.insert("at".into(), Value::String(js::now_iso()));
    record.insert("error".into(), Value::String(message.to_owned()));
    if let Some(stack) = stack.filter(|stack| !stack.is_empty()) {
        record.insert("stack".into(), Value::String(stack.to_owned()));
    }
    js::append_file(
        &runs_dir.join(ERRORS_LOG_NAME),
        &format!("{}\n", js::stringify(&Value::Object(record))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_one_line_per_death_with_a_stack_only_when_there_is_one() {
        let dir = tempfile::Builder::new()
            .prefix("drive-errors-")
            .tempdir()
            .unwrap();
        let runs = dir.path().join("runs");
        record_drive_death(&runs, "Executable not found in $PATH: \"claude\"", None).unwrap();
        record_drive_death(&runs, "boom", Some("at drive (engine)")).unwrap();
        record_drive_death(&runs, "quiet", Some("")).unwrap();
        let text = std::fs::read_to_string(runs.join(ERRORS_LOG_NAME)).unwrap();
        let lines: Vec<Value> = text.lines().map(|line| js::parse(line).unwrap()).collect();
        assert!(text.ends_with('\n'));
        assert_eq!(lines.len(), 3);
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&lines[0]), ["at", "error"]);
        assert_eq!(
            lines[0]["error"],
            "Executable not found in $PATH: \"claude\""
        );
        assert_eq!(keys(&lines[1]), ["at", "error", "stack"]);
        assert_eq!(lines[1]["stack"], "at drive (engine)");
        assert_eq!(keys(&lines[2]), ["at", "error"]);
        assert_eq!(lines[0]["at"].as_str().unwrap().len(), 24);
    }
}
