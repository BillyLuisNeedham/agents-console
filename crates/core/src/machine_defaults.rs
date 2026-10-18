//! Machine defaults (issue #121; machine-defaults.ts): the per-machine harness, model, effort, drivers,
//! terminal and engine path a new Pool inherits when nothing more specific says otherwise, and the
//! `maxLive` under every pool's own (ADR-0040). One JSON
//! file under `~/.agent-graphs/`, edited from the Console's Settings pane and read by Boot and by the
//! engine's resolver fallback.
//!
//! Two older files carried slices of this before: `~/.issue-runner` (`harness=..` / `model=..`) and
//! `~/.console-runner` (`engine=<path>`). Both stay readable as a fallback, so a machine that never
//! wrote the new file behaves as before; a field present in the new file always wins, field by field.
//!
//! Every path is computed from a home directory the caller passes in: only the CLI reads the
//! environment.

use std::collections::HashMap;

use ac_protocol::{MachineDefaults, TerminalKind};
use serde_json::{Map, Value};

use crate::config::ConfigError;
use crate::file_lock::{FileLock, write_through_own_temp};
use crate::js;
use crate::max_live::{is_max_live, max_live_value};

/// The fields the file may hold.
pub const MACHINE_DEFAULTS_KEYS: [&str; 7] = [
    "harness", "model", "effort", "drivers", "terminal", "engine", "maxLive",
];

// The string fields, in the order the file is written.
const STRING_KEYS: [&str; 5] = ["harness", "model", "effort", "drivers", "engine"];

// The file's writers, one at a time: the server answers Settings saves on several threads.
static MACHINE_DEFAULTS: FileLock = FileLock::new();

/// Where the file lives under a home directory.
pub fn default_machine_defaults_path(home: &str) -> String {
    js::path_join(&[home, ".agent-graphs", "defaults.json"])
}

/// The JSON file of record and the two legacy files behind it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineDefaultsPaths {
    /// The JSON file of record.
    pub file: String,
    /// Legacy `harness=` / `model=` file; read only when the field is absent above.
    pub issue_runner: String,
    /// Legacy `engine=` file; read only when `engine` is absent above.
    pub console_runner: String,
}

/// The three files under a home directory.
pub fn default_machine_defaults_paths(home: &str) -> MachineDefaultsPaths {
    MachineDefaultsPaths {
        file: default_machine_defaults_path(home),
        issue_runner: js::path_join(&[home, ".issue-runner"]),
        console_runner: js::path_join(&[home, ".console-runner"]),
    }
}

/// The defaults in force: the JSON file's fields, with each missing field filled from the legacy file
/// that used to hold it. An unreadable or malformed JSON file counts as absent rather than failing the
/// caller: the defaults are a convenience, never a gate.
pub fn read_machine_defaults(paths: &MachineDefaultsPaths) -> MachineDefaults {
    let mut merged = read_machine_defaults_file(&paths.file);
    let runner = read_key_value_file(&paths.issue_runner);
    let console = read_key_value_file(&paths.console_runner);
    let fill = |field: &mut Option<String>, source: &HashMap<String, String>, key: &str| {
        if field.as_deref().unwrap_or("").is_empty()
            && let Some(value) = source.get(key).filter(|value| !value.is_empty())
        {
            *field = Some(value.clone());
        }
    };
    fill(&mut merged.harness, &runner, "harness");
    fill(&mut merged.model, &runner, "model");
    fill(&mut merged.engine, &console, "engine");
    merged
}

/// Only the JSON file's own fields, no legacy fallback; empty when absent or malformed.
pub fn read_machine_defaults_file(file: &str) -> MachineDefaults {
    if !js::exists(file) {
        return no_defaults();
    }
    let Ok(text) = js::read_text(file) else {
        return no_defaults();
    };
    match js::parse(&text) {
        Ok(parsed) => sanitize_machine_defaults(&parsed),
        Err(_) => no_defaults(),
    }
}

/// Validate and write the file, creating its directory when missing. Written whole, via a rename of a
/// temp name of this write's own, so a reader never sees half a file and two saves at once never trip
/// over each other's. Empty strings drop the field rather than storing "no value" as a value. Answers
/// what was written.
pub fn write_machine_defaults(
    defaults: &Value,
    file: &str,
) -> Result<MachineDefaults, ConfigError> {
    let clean = validate_machine_defaults(defaults)?;
    let dir = std::path::Path::new(file)
        .parent()
        .map(|dir| dir.to_string_lossy().into_owned())
        .filter(|dir| !dir.is_empty())
        .unwrap_or_else(|| ".".to_owned());
    js::mkdir_all(&dir).map_err(ConfigError::from)?;
    let text = format!(
        "{}\n",
        js::stringify_pretty(&machine_defaults_value(&clean))
    );
    let _held = MACHINE_DEFAULTS.hold();
    write_through_own_temp(file, &text).map_err(ConfigError::from)?;
    Ok(clean)
}

/// The fields the file may hold, each trimmed; anything else is dropped. A field that is not a string
/// and an illegal `terminal` are refused, matching how the pool config rejects them.
pub fn validate_machine_defaults(input: &Value) -> Result<MachineDefaults, ConfigError> {
    let empty = Map::new();
    let raw = input.as_object().unwrap_or(&empty);
    let mut out = no_defaults();
    for key in STRING_KEYS {
        let value = match raw.get(key) {
            None | Some(Value::Null) => continue,
            Some(Value::String(value)) => value,
            Some(_) => {
                return Err(ConfigError(format!(
                    "machine defaults: {key} must be a string"
                )));
            }
        };
        let trimmed = js::trim(value);
        if !trimmed.is_empty() {
            *string_field(&mut out, key) = Some(trimmed.to_owned());
        }
    }
    match raw.get("terminal") {
        None | Some(Value::Null) => {}
        Some(Value::String(terminal)) if terminal.is_empty() => {}
        Some(Value::String(terminal)) if terminal == "herdr" => {
            out.terminal = Some(TerminalKind::Herdr)
        }
        Some(other) => {
            return Err(ConfigError(format!(
                r#"machine defaults: terminal must be "herdr" (got {})"#,
                js::stringify(other)
            )));
        }
    }
    if let Some(max) = raw.get("maxLive").filter(|max| !max.is_null()) {
        if !is_max_live(max) {
            return Err(ConfigError::new(
                "machine defaults: maxLive must be a whole number, 1 or more",
            ));
        }
        out.max_live = max_live_value(Some(max));
    }
    Ok(out)
}

// A read never throws on a bad value: the field is skipped instead.
fn sanitize_machine_defaults(parsed: &Value) -> MachineDefaults {
    let mut out = no_defaults();
    let Some(raw) = parsed.as_object() else {
        return out;
    };
    for key in STRING_KEYS {
        if let Some(value) = raw.get(key).and_then(Value::as_str) {
            let trimmed = js::trim(value);
            if !trimmed.is_empty() {
                *string_field(&mut out, key) = Some(trimmed.to_owned());
            }
        }
    }
    if raw.get("terminal").and_then(Value::as_str) == Some("herdr") {
        out.terminal = Some(TerminalKind::Herdr);
    }
    out.max_live = max_live_value(raw.get("maxLive"));
    out
}

// The empty record: nothing in force.
fn no_defaults() -> MachineDefaults {
    MachineDefaults {
        harness: None,
        model: None,
        effort: None,
        drivers: None,
        engine: None,
        terminal: None,
        max_live: None,
    }
}

fn string_field<'a>(defaults: &'a mut MachineDefaults, key: &str) -> &'a mut Option<String> {
    match key {
        "harness" => &mut defaults.harness,
        "model" => &mut defaults.model,
        "effort" => &mut defaults.effort,
        "drivers" => &mut defaults.drivers,
        _ => &mut defaults.engine,
    }
}

// The file's object in the order the TypeScript builds it: the string fields, then terminal, then
// maxLive.
fn machine_defaults_value(defaults: &MachineDefaults) -> Value {
    let mut map = Map::new();
    for (key, value) in [
        ("harness", &defaults.harness),
        ("model", &defaults.model),
        ("effort", &defaults.effort),
        ("drivers", &defaults.drivers),
        ("engine", &defaults.engine),
    ] {
        if let Some(value) = value {
            map.insert(key.to_owned(), Value::String(value.clone()));
        }
    }
    if defaults.terminal.is_some() {
        map.insert("terminal".to_owned(), Value::String("herdr".to_owned()));
    }
    if let Some(max) = defaults.max_live {
        map.insert("maxLive".to_owned(), Value::from(max));
    }
    Value::Object(map)
}

// `key=value` lines, each side trimmed; a later line wins. Missing or unreadable is empty.
fn read_key_value_file(path: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    if !js::exists(path) {
        return fields;
    }
    let Ok(text) = js::read_text(path) else {
        return fields;
    };
    for line in text.split('\n') {
        if let Some(eq) = line.find('=').filter(|eq| *eq > 0) {
            fields.insert(
                js::trim(&line[..eq]).to_owned(),
                js::trim(&line[eq + 1..]).to_owned(),
            );
        }
    }
    fields
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn paths(home: &tempfile::TempDir) -> MachineDefaultsPaths {
        default_machine_defaults_paths(home.path().to_str().unwrap())
    }

    fn defaults(value: Value) -> MachineDefaults {
        serde_json::from_value(value).unwrap()
    }

    // machine-defaults.test.ts
    #[test]
    fn reads_nothing_from_an_empty_home() {
        assert_eq!(read_machine_defaults(&paths(&home())), no_defaults());
    }

    #[test]
    fn computes_the_three_paths_from_the_home_given() {
        assert_eq!(
            default_machine_defaults_paths("/home/op"),
            MachineDefaultsPaths {
                file: "/home/op/.agent-graphs/defaults.json".into(),
                issue_runner: "/home/op/.issue-runner".into(),
                console_runner: "/home/op/.console-runner".into(),
            }
        );
    }

    #[test]
    fn falls_back_to_the_legacy_runner_files_field_by_field() {
        let h = home();
        std::fs::write(
            h.path().join(".issue-runner"),
            "harness=opencode\nmodel=oc/flash\n",
        )
        .unwrap();
        std::fs::write(h.path().join(".console-runner"), "engine=/repo\n").unwrap();
        assert_eq!(
            read_machine_defaults(&paths(&h)),
            defaults(json!({ "harness": "opencode", "model": "oc/flash", "engine": "/repo" }))
        );
    }

    #[test]
    fn lets_the_json_file_win_over_the_legacy_files_field_by_field() {
        let h = home();
        let paths = paths(&h);
        std::fs::write(
            h.path().join(".issue-runner"),
            "harness=opencode\nmodel=oc/flash\n",
        )
        .unwrap();
        write_machine_defaults(
            &json!({ "harness": "claude", "drivers": "implement", "terminal": "herdr" }),
            &paths.file,
        )
        .unwrap();
        assert_eq!(
            read_machine_defaults(&paths),
            defaults(
                json!({ "harness": "claude", "model": "oc/flash", "drivers": "implement", "terminal": "herdr" })
            )
        );
    }

    #[test]
    fn writes_a_whole_file_dropping_empty_fields_and_creates_the_directory() {
        let h = home();
        let paths = paths(&h);
        let written = write_machine_defaults(
            &json!({ "harness": " claude ", "model": "", "effort": " high ", "drivers": "implement", "engine": "/e" }),
            &paths.file,
        )
        .unwrap();
        assert_eq!(
            written,
            defaults(
                json!({ "harness": "claude", "effort": "high", "drivers": "implement", "engine": "/e" })
            )
        );
        assert_eq!(
            read_machine_defaults(&paths).effort.as_deref(),
            Some("high")
        );
        assert_eq!(
            std::fs::read_to_string(&paths.file).unwrap(),
            "{\n  \"harness\": \"claude\",\n  \"effort\": \"high\",\n  \"drivers\": \"implement\",\n  \"engine\": \"/e\"\n}\n"
        );
        // Nothing of the write is left beside the file.
        let names: Vec<_> = std::fs::read_dir(h.path().join(".agent-graphs"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["defaults.json"]);
    }

    #[test]
    fn reads_past_a_retired_roster_and_agents_and_drops_them_on_write() {
        let h = home();
        let paths = paths(&h);
        std::fs::create_dir_all(h.path().join(".agent-graphs")).unwrap();
        std::fs::write(
            &paths.file,
            json!({ "harness": "claude", "roster": "- deepseek", "agents": "{\"deepseek\":{}}" })
                .to_string(),
        )
        .unwrap();
        let read = read_machine_defaults(&paths);
        assert_eq!(read, defaults(json!({ "harness": "claude" })));
        let mut next = serde_json::to_value(&read).unwrap();
        next["model"] = json!("opus");
        write_machine_defaults(&next, &paths.file).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&std::fs::read_to_string(&paths.file).unwrap()).unwrap(),
            json!({ "harness": "claude", "model": "opus" })
        );
    }

    #[test]
    fn treats_a_malformed_file_as_absent() {
        let h = home();
        let paths = paths(&h);
        write_machine_defaults(&json!({ "harness": "claude" }), &paths.file).unwrap();
        std::fs::write(&paths.file, "{ not json").unwrap();
        assert_eq!(read_machine_defaults(&paths), no_defaults());
    }

    #[test]
    fn rejects_an_illegal_terminal_and_a_non_string_field() {
        assert_eq!(
            validate_machine_defaults(&json!({ "terminal": "tmux" }))
                .unwrap_err()
                .0,
            r#"machine defaults: terminal must be "herdr" (got "tmux")"#
        );
        assert_eq!(
            validate_machine_defaults(&json!({ "harness": 3 }))
                .unwrap_err()
                .0,
            "machine defaults: harness must be a string"
        );
        assert!(
            validate_machine_defaults(&json!({ "effort": 3 }))
                .unwrap_err()
                .0
                .contains("effort")
        );
        assert_eq!(
            validate_machine_defaults(&json!({ "terminal": "", "harness": "claude" })).unwrap(),
            defaults(json!({ "harness": "claude" }))
        );
    }

    #[test]
    fn skips_a_bad_value_on_read_rather_than_failing() {
        let h = home();
        let paths = paths(&h);
        std::fs::create_dir_all(h.path().join(".agent-graphs")).unwrap();
        std::fs::write(
            &paths.file,
            r#"{"harness":3,"model":" m ","terminal":"tmux","engine":""}"#,
        )
        .unwrap();
        assert_eq!(
            read_machine_defaults_file(&paths.file),
            defaults(json!({ "model": "m" }))
        );
    }

    #[test]
    fn writes_max_live_at_the_end_and_reads_it_back() {
        let home = home();
        let paths = paths(&home);
        let written = write_machine_defaults(
            &json!({ "maxLive": 3, "terminal": "herdr", "model": "m" }),
            &paths.file,
        )
        .unwrap();
        assert_eq!(written.max_live, Some(3));
        assert_eq!(
            std::fs::read_to_string(&paths.file).unwrap(),
            "{\n  \"model\": \"m\",\n  \"terminal\": \"herdr\",\n  \"maxLive\": 3\n}\n"
        );
        assert_eq!(read_machine_defaults(&paths).max_live, Some(3));
    }

    #[test]
    fn refuses_a_max_live_below_one_or_not_a_number_writing_nothing() {
        let home = home();
        let paths = paths(&home);
        write_machine_defaults(&json!({ "maxLive": 2 }), &paths.file).unwrap();
        for bad in [json!(0), json!(-1), json!(2.5), json!("3"), json!(true)] {
            assert_eq!(
                write_machine_defaults(&json!({ "maxLive": bad }), &paths.file)
                    .unwrap_err()
                    .0,
                "machine defaults: maxLive must be a whole number, 1 or more",
                "{bad}"
            );
        }
        assert_eq!(read_machine_defaults(&paths).max_live, Some(2));
    }

    #[test]
    fn skips_a_bad_max_live_on_read() {
        let home = home();
        let file = paths(&home).file;
        std::fs::create_dir_all(home.path().join(".agent-graphs")).unwrap();
        for bad in [r#"0"#, r#""4""#, r#"1.5"#] {
            std::fs::write(&file, format!(r#"{{"model": "m", "maxLive": {bad}}}"#)).unwrap();
            assert_eq!(
                read_machine_defaults_file(&file),
                defaults(json!({ "model": "m" })),
                "{bad}"
            );
        }
    }
}
