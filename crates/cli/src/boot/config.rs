//! The values Boot carries between reading and writing (issue #121; boot-config.ts): the prefill it
//! assembles before it asks anything, the answers the interview returns, and the files it writes from
//! them.
//!
//! The prefill is the whole point of Boot being a program. Four sources answer the same fields, in a
//! fixed order of authority: the Pool's own config, then the chosen Setup, then Machine defaults, then
//! detection. The merge is field by field rather than whole object, so a Setup that names a harness
//! does not blank a model the pool already had.

use ac_core::js;
use ac_protocol::MachineDefaults;
use serde_json::{Map, Value};

use super::detect::Detection;
use super::pool::slugify;

/// Every field Boot can prefill, all optional because any source may be silent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Prefill {
    pub harness: Option<String>,
    pub model: Option<String>,
    /// Carried through, never asked: Boot's interview has no effort question.
    pub effort: Option<String>,
    pub drivers: Option<String>,
    /// The resolver as console.json holds it: a harness name, or an object.
    pub resolver: Option<Value>,
    pub reviewer: Option<String>,
    pub checkpoint: Option<String>,
    /// A concrete pin, the number exactly as the file held it; absent means the engine picks 8787 or the
    /// next free port.
    pub port: Option<Value>,
    /// Terminal backing; "herdr" is the only value.
    pub terminal: bool,
    /// Whether this Pool is seeded, which only the pool's own shape suggests.
    pub seeded: Option<bool>,
}

/// What the port question answered.
#[derive(Debug, Clone, PartialEq)]
pub enum PortAnswer {
    /// "auto": remove the pin.
    Auto,
    /// Pin this number.
    Pin(Value),
}

/// What the terminal question answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalAnswer {
    /// Back attempts with herdr tabs.
    Herdr,
    /// Remove the key.
    None,
}

/// The interview's output. A field left `None` was never asked and the existing file keeps whatever it
/// had; the two sentinels (`PortAnswer::Auto`, `TerminalAnswer::None`) are the operator saying "no
/// value here", which removes the key.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BootAnswers {
    pub harness: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub drivers: Option<String>,
    pub resolver: Option<Value>,
    pub reviewer: Option<String>,
    pub checkpoint: Option<String>,
    pub port: Option<PortAnswer>,
    pub terminal: Option<TerminalAnswer>,
    /// The Pool title (issue #100), asked only when Boot creates the Pool.
    pub title: Option<String>,
}

/// The behavioural keys a Setup carries, and nothing pool-specific. A Setup saved before ADR-0031 may
/// still hold `roster` or `agents`: nothing reads them, and a Setup written from a config never carries
/// them again.
pub const SETUP_KEYS: [&str; 5] = ["defaults", "resolver", "terminal", "reviewer", "checkpoint"];

/// Earlier sources win, field by field; an empty string is no answer.
pub fn merge_prefill(sources: &[Prefill]) -> Prefill {
    fn first_text(values: impl Iterator<Item = Option<String>>) -> Option<String> {
        values.flatten().find(|value| !value.is_empty())
    }
    let text = |pick: fn(&Prefill) -> &Option<String>| {
        first_text(sources.iter().map(|source| pick(source).clone()))
    };
    Prefill {
        harness: text(|p| &p.harness),
        model: text(|p| &p.model),
        effort: text(|p| &p.effort),
        drivers: text(|p| &p.drivers),
        resolver: sources
            .iter()
            .filter_map(|source| source.resolver.clone())
            .find(|value| value.as_str() != Some("")),
        reviewer: text(|p| &p.reviewer),
        checkpoint: text(|p| &p.checkpoint),
        port: sources.iter().find_map(|source| source.port.clone()),
        terminal: sources.iter().any(|source| source.terminal),
        seeded: sources.iter().find_map(|source| source.seeded),
    }
}

/// The pool's own console.json as a prefill, which outranks every other source.
pub fn prefill_from_config(config: &Map<String, Value>) -> Prefill {
    let defaults = config.get("defaults").and_then(Value::as_object);
    let field = |key: &str| {
        defaults
            .and_then(|defaults| defaults.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let top = |key: &str| config.get(key).and_then(Value::as_str).map(str::to_owned);
    Prefill {
        harness: field("harness"),
        model: field("model"),
        effort: field("effort"),
        drivers: field("drivers"),
        resolver: config
            .get("resolver")
            .filter(|value| value.is_string() || value.is_object())
            .cloned(),
        reviewer: top("reviewer"),
        checkpoint: top("checkpoint"),
        port: config
            .get("port")
            .filter(|value| value.is_number())
            .cloned(),
        terminal: config.get("terminal").and_then(Value::as_str) == Some("herdr"),
        seeded: None,
    }
}

/// A Setup file as a prefill. Same shape as a config, minus port and assign.
pub fn prefill_from_setup(setup: &Map<String, Value>) -> Prefill {
    Prefill {
        port: None,
        ..prefill_from_config(setup)
    }
}

/// Machine defaults as a prefill: the fields a machine, not a pool, settles.
pub fn prefill_from_machine_defaults(defaults: &MachineDefaults) -> Prefill {
    let text = |value: &Option<String>| value.clone().filter(|value| !value.is_empty());
    Prefill {
        harness: text(&defaults.harness),
        model: text(&defaults.model),
        effort: text(&defaults.effort),
        drivers: text(&defaults.drivers),
        terminal: defaults.terminal.is_some(),
        ..Prefill::default()
    }
}

/// Detection as the last prefill. It answers two fields and leaves the rest: a herdr binary with a live
/// socket means a terminal-backed pool is what to recommend, and the pool's shape says whether it looks
/// seeded. The port is deliberately not prefilled, because no pin is the good default.
pub fn prefill_from_detection(detection: &Detection) -> Prefill {
    Prefill {
        drivers: Some("implement".to_owned()),
        terminal: detection.herdr_binary && detection.herdr_socket,
        seeded: if detection.conversations {
            Some(true)
        } else if detection.tickets > 0 {
            Some(false)
        } else {
            None
        },
        ..Prefill::default()
    }
}

/// `{ ...value }`: an object's own entries, an array's or a string's by index, nothing for anything
/// else.
fn spread(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item.clone()))
            .collect(),
        Some(Value::String(text)) => text
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| {
                (
                    index.to_string(),
                    Value::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        _ => Map::new(),
    }
}

/// The pool config to write: the answers laid over whatever the file already held. `assign` and any
/// key Boot does not know about survive untouched, because a pool's per-ticket overrides and its
/// `selection` are the operator's and no interview asked about them.
pub fn merge_console_config(
    existing: &Map<String, Value>,
    answers: &BootAnswers,
) -> Map<String, Value> {
    let mut out = existing.clone();
    // Keys the engine retired (ADR-0031): a pool that still carries them loses them here, silently.
    out.shift_remove("roster");
    out.shift_remove("agents");
    let mut defaults = spread(existing.get("defaults"));
    for (key, value) in [
        ("harness", &answers.harness),
        ("model", &answers.model),
        ("effort", &answers.effort),
        ("drivers", &answers.drivers),
    ] {
        if let Some(value) = value.as_ref().filter(|value| !value.is_empty()) {
            defaults.insert(key.to_owned(), Value::String(value.clone()));
        }
    }
    if !defaults.is_empty() {
        out.insert("defaults".to_owned(), Value::Object(defaults));
    }
    if let Some(resolver) = answers
        .resolver
        .as_ref()
        .filter(|value| value.as_str() != Some(""))
    {
        out.insert("resolver".to_owned(), resolver.clone());
    }
    for (key, value) in [
        ("reviewer", &answers.reviewer),
        ("checkpoint", &answers.checkpoint),
    ] {
        if let Some(value) = value.as_ref().filter(|value| !value.is_empty()) {
            out.insert(key.to_owned(), Value::String(value.clone()));
        }
    }
    match &answers.port {
        Some(PortAnswer::Auto) => {
            out.shift_remove("port");
        }
        Some(PortAnswer::Pin(port)) => {
            out.insert("port".to_owned(), port.clone());
        }
        None => {}
    }
    match answers.terminal {
        Some(TerminalAnswer::None) => {
            out.shift_remove("terminal");
        }
        Some(TerminalAnswer::Herdr) => {
            out.insert("terminal".to_owned(), Value::String("herdr".to_owned()));
        }
        None => {}
    }
    if let Some(title) = answers.title.as_ref().filter(|title| !title.is_empty()) {
        out.insert("title".to_owned(), Value::String(title.clone()));
    }
    out
}

/// console.json as it is on disk, or an empty object when there is none. A file that is there but does
/// not parse is refused rather than counting as absent: Boot writes this file back, and treating a
/// broken one as empty would quietly drop the `assign` entries and the hand edits it holds.
pub fn read_console_config(pool_dir: &str) -> Result<Map<String, Value>, String> {
    let file = js::path_join(&[pool_dir, "console.json"]);
    if !js::exists(&file) {
        return Ok(Map::new());
    }
    let text = js::read_text(&file).map_err(|err| err.to_string())?;
    match js::parse(&text) {
        Err(err) => Err(format!(
            "{file} does not parse as JSON ({err}); fix it or move it aside, then boot again"
        )),
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(format!("{file} must be a JSON object")),
    }
}

/// `JSON.stringify(config, null, 2)` and a newline: how Boot writes console.json and a Setup.
pub fn json_file_text(config: &Map<String, Value>) -> String {
    format!("{}\n", js::stringify_pretty(&Value::Object(config.clone())))
}

pub fn write_console_config(pool_dir: &str, config: &Map<String, Value>) -> Result<(), String> {
    js::write_file(
        js::path_join(&[pool_dir, "console.json"]),
        &json_file_text(config),
    )
    .map_err(|err| err.to_string())
}

/// The behavioural slice of a pool config, which is what a Setup is.
pub fn setup_from_config(config: &Map<String, Value>) -> Map<String, Value> {
    SETUP_KEYS
        .iter()
        .filter_map(|key| {
            config
                .get(*key)
                .filter(|value| value.as_str() != Some(""))
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect()
}

pub fn setups_dir(home: &str) -> String {
    js::path_join(&[home, ".agent-graphs", "setups"])
}

pub fn setup_path(name: &str, home: &str) -> String {
    js::path_join(&[&setups_dir(home), &format!("{}.json", slugify(name))])
}

/// Setups on this machine by name, with anything unreadable left out.
pub fn list_setups(home: &str) -> Vec<String> {
    let dir = setups_dir(home);
    if !js::exists(&dir) {
        return Vec::new();
    }
    let Ok(names) = js::read_dir_names(&dir) else {
        return Vec::new();
    };
    let mut setups: Vec<String> = names
        .iter()
        .filter_map(|name| name.strip_suffix(".json"))
        .map(str::to_owned)
        .collect();
    js::sort_strings(&mut setups);
    setups
}

pub fn read_setup(name: &str, home: &str) -> Option<Map<String, Value>> {
    let file = setup_path(name, home);
    if !js::exists(&file) {
        return None;
    }
    match js::parse(&js::read_text(&file).ok()?) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Write a Setup under its slug, answering the file it went to.
pub fn write_setup(name: &str, setup: &Map<String, Value>, home: &str) -> Result<String, String> {
    let file = setup_path(name, home);
    js::mkdir_all(setups_dir(home)).map_err(|err| err.to_string())?;
    js::write_file(&file, &json_file_text(setup)).map_err(|err| err.to_string())?;
    Ok(file)
}

/// The marker the template puts between the engine's prose and the pool's.
pub const CONFIG_MARKER: &str =
    "<!-- ============================================================ CONFIG -->";

/// What Boot fills in below the marker of a new `AGENT.md`.
#[derive(Debug, Clone, Default)]
pub struct AgentFill {
    pub context_files: Vec<String>,
    pub commit_prefix: Option<String>,
    pub reviewer: Option<String>,
    pub checkpoint: Option<String>,
}

/// `AGENT.md` from the template: everything above the CONFIG marker exactly as the template has it,
/// because that half is the same in every runner, and a filled-in version of the half below. The last
/// section keeps its placeholder: which tickets are expected to stop is a judgement about this pool's
/// work, and a program that guessed at it would be writing fiction.
pub fn fill_agent_template(template: &str, fill: &AgentFill) -> String {
    let head = match template.find(CONFIG_MARKER) {
        Some(marker) => template[..marker + CONFIG_MARKER.len()].to_owned(),
        None => format!(
            "{}\n\n{CONFIG_MARKER}",
            template.trim_end_matches(js::is_whitespace)
        ),
    };
    let context = if fill.context_files.is_empty() {
        "- (none found beside `issues/`; name them here as they arrive)".to_owned()
    } else {
        fill.context_files
            .iter()
            .map(|name| format!("- `{name}`: (what it is for)"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut constraints: Vec<String> = Vec::new();
    if let Some(reviewer) = fill.reviewer.as_ref().filter(|text| !text.is_empty()) {
        constraints.push(format!("- reviewer: {reviewer}"));
    }
    if let Some(checkpoint) = fill.checkpoint.as_ref().filter(|text| !text.is_empty()) {
        constraints.push(format!("- checkpoint: {checkpoint}"));
    }
    if constraints.is_empty() {
        constraints.push(
            "- (secrets files, external systems, environment quirks, known-red tests)".to_owned(),
        );
    }
    let prefix = fill.commit_prefix.as_deref().unwrap_or("<prefix>");
    let constraints = constraints.join("\n");
    format!(
        "{head}

Boot filled this in from detection and its interview. The `my-console-runner` skill
improves the prose; the engine's half above the marker stays as it is.

## Read before you touch anything

In this order: your ticket, then the files this pool's context lives in.

{context}

## Commit message format

```
{prefix}: <what changed, in the imperative>
```

## This pool's constraints

{constraints}

## Which tickets are expected to stop

- (name them, so a checkpoint on those reads as correct rather than as a failure)
"
    )
}

/// An existing `AGENT.md` with the engine's half replaced by the template's (issue #155): the template
/// up to and including its CONFIG marker, then the file's own bytes after its marker, untouched. Bytes
/// rather than a string so the pool's half survives exactly as written, whatever it holds. `None` when
/// either side has no marker: a hand-written `AGENT.md` has no line saying where the engine's half
/// ends, so there is nothing safe to replace.
pub fn refresh_agent_head(existing: &[u8], template: &str) -> Option<Vec<u8>> {
    let template_marker = template.find(CONFIG_MARKER)?;
    let marker = existing
        .windows(CONFIG_MARKER.len())
        .position(|window| window == CONFIG_MARKER.as_bytes())?;
    let mut out = template.as_bytes()[..template_marker + CONFIG_MARKER.len()].to_vec();
    out.extend_from_slice(&existing[marker + CONFIG_MARKER.len()..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            other => panic!("not an object: {other}"),
        }
    }

    fn detection() -> Detection {
        Detection {
            tickets: 0,
            conversations: true,
            context_files: Vec::new(),
            commit_prefix: None,
            harnesses: vec!["claude".to_owned()],
            herdr_binary: true,
            herdr_socket: true,
            default_port_free: true,
            engine_dir: "/engine".to_owned(),
        }
    }

    fn machine(fields: Value) -> MachineDefaults {
        serde_json::from_value(fields).unwrap()
    }

    #[test]
    fn takes_the_pool_config_over_the_setup_the_setup_over_machine_defaults() {
        let merged = merge_prefill(&[
            prefill_from_config(&object(json!({ "defaults": { "harness": "claude" } }))),
            prefill_from_setup(&object(json!({
                "defaults": { "harness": "cursor", "model": "setup-model" },
                "resolver": "cursor"
            }))),
            prefill_from_machine_defaults(&machine(json!({
                "harness": "opencode", "model": "machine-model", "drivers": "implement"
            }))),
            prefill_from_detection(&detection()),
        ]);
        assert_eq!(merged.harness.as_deref(), Some("claude"));
        assert_eq!(merged.model.as_deref(), Some("setup-model"));
        assert_eq!(merged.drivers.as_deref(), Some("implement"));
        assert_eq!(merged.resolver, Some(json!("cursor")));
        assert!(merged.terminal);
        assert_eq!(merged.seeded, Some(true));
    }

    #[test]
    fn carries_effort_field_wise_from_the_pool_the_setup_and_the_machine() {
        let from_setup = merge_prefill(&[
            prefill_from_config(&object(
                json!({ "defaults": { "harness": "claude", "model": "m" } }),
            )),
            prefill_from_setup(&object(json!({ "defaults": { "effort": "high" } }))),
            prefill_from_machine_defaults(&machine(json!({ "effort": "low" }))),
        ]);
        assert_eq!(from_setup.effort.as_deref(), Some("high"));
        assert_eq!(from_setup.model.as_deref(), Some("m"));
        let from_pool = merge_prefill(&[
            prefill_from_config(&object(json!({ "defaults": { "effort": "max" } }))),
            prefill_from_machine_defaults(&machine(json!({ "effort": "low" }))),
        ]);
        assert_eq!(from_pool.effort.as_deref(), Some("max"));
        let from_machine = merge_prefill(&[
            prefill_from_config(&Map::new()),
            prefill_from_machine_defaults(&machine(json!({ "effort": "low" }))),
        ]);
        assert_eq!(from_machine.effort.as_deref(), Some("low"));
    }

    #[test]
    fn never_lets_a_setup_carry_a_port_into_the_next_pool() {
        assert_eq!(
            prefill_from_setup(&object(json!({ "port": 9000 }))).port,
            None
        );
        assert_eq!(
            prefill_from_config(&object(json!({ "port": 9000 }))).port,
            Some(json!(9000))
        );
    }

    #[test]
    fn skips_an_empty_answer_for_a_later_source() {
        let merged = merge_prefill(&[
            prefill_from_config(&object(
                json!({ "defaults": { "model": "" }, "resolver": "" }),
            )),
            prefill_from_config(&object(
                json!({ "defaults": { "model": "m" }, "resolver": { "harness": "claude" } }),
            )),
        ]);
        assert_eq!(merged.model.as_deref(), Some("m"));
        assert_eq!(merged.resolver, Some(json!({ "harness": "claude" })));
    }

    #[test]
    fn merges_over_the_existing_file_and_keeps_assign_and_unknown_keys() {
        let existing = object(json!({
            "defaults": { "harness": "opencode", "model": "old-model", "drivers": "implement" },
            "assign": { "04": { "harness": "claude", "verify": 2 } },
            "selection": "human",
            "port": 9001,
        }));
        let merged = merge_console_config(
            &existing,
            &BootAnswers {
                harness: Some("claude".to_owned()),
                model: Some("new-model".to_owned()),
                terminal: Some(TerminalAnswer::Herdr),
                ..BootAnswers::default()
            },
        );
        assert_eq!(
            Value::Object(merged.clone()),
            json!({
                "defaults": { "harness": "claude", "model": "new-model", "drivers": "implement" },
                "assign": { "04": { "harness": "claude", "verify": 2 } },
                "selection": "human",
                "port": 9001,
                "terminal": "herdr",
            })
        );
        // An effort the file already had survives answers that never name one.
        let kept = merge_console_config(
            &object(json!({ "defaults": { "harness": "claude", "effort": "high" } })),
            &BootAnswers {
                model: Some("m".to_owned()),
                ..BootAnswers::default()
            },
        );
        assert_eq!(
            kept["defaults"],
            json!({ "harness": "claude", "effort": "high", "model": "m" })
        );
        assert_eq!(
            js::stringify(&kept["defaults"]),
            r#"{"harness":"claude","effort":"high","model":"m"}"#
        );
    }

    // Hidden row, boot-cli.test.ts:348.
    #[test]
    fn removes_the_port_pin_on_an_explicit_auto_and_the_terminal_key_on_a_no() {
        let merged = merge_console_config(
            &object(
                json!({ "port": 9001, "terminal": "herdr", "assign": {}, "selection": "human" }),
            ),
            &BootAnswers {
                port: Some(PortAnswer::Auto),
                terminal: Some(TerminalAnswer::None),
                ..BootAnswers::default()
            },
        );
        assert!(!merged.contains_key("port"));
        assert!(!merged.contains_key("terminal"));
        assert_eq!(
            js::stringify(&Value::Object(merged)),
            r#"{"assign":{},"selection":"human"}"#
        );
    }

    #[test]
    fn drops_a_retired_roster_and_agents_on_write_and_never_prefills_them() {
        let existing = object(json!({
            "defaults": { "harness": "claude", "model": "m" },
            "roster": "- deepseek",
            "agents": "{\"deepseek\":{}}",
            "reviewer": "r",
        }));
        let merged = merge_console_config(&existing, &BootAnswers::default());
        assert!(!merged.contains_key("roster"));
        assert!(!merged.contains_key("agents"));
        assert_eq!(merged["reviewer"], json!("r"));
        assert_eq!(
            js::stringify(&Value::Object(merged)),
            r#"{"defaults":{"harness":"claude","model":"m"},"reviewer":"r"}"#
        );
    }

    #[test]
    fn writes_the_title_into_console_json_beside_the_rest() {
        let merged = merge_console_config(
            &object(json!({ "port": 9001 })),
            &BootAnswers {
                title: Some("Jev as the grader".to_owned()),
                ..BootAnswers::default()
            },
        );
        assert_eq!(
            Value::Object(merged),
            json!({ "port": 9001, "title": "Jev as the grader" })
        );
        // A pool Boot did not create is never given a title it was not asked for.
        assert!(
            !merge_console_config(&object(json!({ "port": 9001 })), &BootAnswers::default())
                .contains_key("title")
        );
    }

    #[test]
    fn refuses_a_config_that_is_there_but_does_not_parse() {
        let pool = tempfile::tempdir().unwrap();
        let dir = js::path_text(pool.path());
        assert_eq!(read_console_config(&dir), Ok(Map::new()));
        std::fs::write(pool.path().join("console.json"), "{ not json").unwrap();
        let err = read_console_config(&dir).unwrap_err();
        assert!(err.starts_with(&format!("{dir}/console.json does not parse as JSON (")));
        assert!(err.ends_with("); fix it or move it aside, then boot again"));
        std::fs::write(pool.path().join("console.json"), "[]").unwrap();
        assert_eq!(
            read_console_config(&dir),
            Err(format!("{dir}/console.json must be a JSON object"))
        );
    }

    #[test]
    fn saves_the_behavioural_keys_and_never_the_pool_specific_or_retired_ones() {
        let home = tempfile::tempdir().unwrap();
        let home = js::path_text(home.path());
        let config = object(json!({
            "defaults": { "harness": "claude", "model": "m" },
            "assign": { "01": { "harness": "cursor" } },
            "roster": "- one",
            "agents": "{}",
            "resolver": "claude",
            "terminal": "herdr",
            "reviewer": "r",
            "checkpoint": "c",
            "port": 9001,
        }));
        let file = write_setup("My Build  Setup", &setup_from_config(&config), &home).unwrap();
        assert_eq!(
            file,
            format!("{home}/.agent-graphs/setups/my-build-setup.json")
        );
        let saved = read_setup("my-build-setup", &home).unwrap();
        let mut keys: Vec<&String> = saved.keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["checkpoint", "defaults", "resolver", "reviewer", "terminal"]
        );
        assert_eq!(list_setups(&home), ["my-build-setup"]);
        assert_eq!(read_setup("nothing-here", &home), None);
    }

    const TEMPLATE: &str = "# Runner agent instructions\n\nThe engine's half, identical in every runner.\n\n<!-- ============================================================ CONFIG -->\n\nAuthor everything below.\n\n## Which tickets are expected to stop";

    #[test]
    fn leaves_everything_above_the_marker_untouched_and_fills_below_it() {
        let filled = fill_agent_template(
            TEMPLATE,
            &AgentFill {
                context_files: vec!["SPEC.md".to_owned()],
                commit_prefix: Some("feat".to_owned()),
                reviewer: Some("acceptance criteria only".to_owned()),
                checkpoint: Some("a device or an external write".to_owned()),
            },
        );
        let head = &filled[..filled.find(CONFIG_MARKER).unwrap()];
        assert_eq!(head, &TEMPLATE[..TEMPLATE.find(CONFIG_MARKER).unwrap()]);
        assert!(filled.contains("- `SPEC.md`"));
        assert!(filled.contains("feat: <what changed, in the imperative>"));
        assert!(filled.contains("- reviewer: acceptance criteria only"));
        assert!(filled.contains("- checkpoint: a device or an external write"));
        assert!(filled.contains("## Which tickets are expected to stop"));
        assert!(filled.contains("(name them, so a checkpoint on those reads as correct"));
    }

    #[test]
    fn keeps_the_placeholder_prefix_when_the_repository_writes_none() {
        let filled = fill_agent_template(TEMPLATE, &AgentFill::default());
        assert!(filled.contains("<prefix>: <what changed, in the imperative>"));
        assert!(filled.contains("(none found beside `issues/`"));
        assert!(
            filled.contains(
                "- (secrets files, external systems, environment quirks, known-red tests)"
            )
        );
        // A template with no marker gets one after its trimmed text.
        let unmarked = fill_agent_template("# Head \n\n", &AgentFill::default());
        assert!(unmarked.starts_with(&format!("# Head\n\n{CONFIG_MARKER}\n\nBoot filled")));
    }

    const OLD_HEAD: &str = "# Runner agent instructions\n\n## Your role\n\nYou are an **orchestrator**. Delegate to the subagents in your roster.\n\n";
    const NEW_HEAD: &str = "# Runner agent instructions\n\n## Your job\n\nYou work one ticket.\n";
    // Odd bytes on purpose: trailing spaces, CRLF, no final newline, and a non-ASCII character, all of
    // which must come back exactly.
    const POOL_HALF: &str =
        "\n\n## Read before you touch anything  \r\n- `SPEC.md`: the spec, café\n\n## Notes";

    #[test]
    fn replaces_the_old_engine_half_and_keeps_the_pools_half_byte_for_byte() {
        let template = format!("{NEW_HEAD}{CONFIG_MARKER}\n\nAuthor everything below.\n");
        let existing = format!("{OLD_HEAD}{CONFIG_MARKER}{POOL_HALF}").into_bytes();
        let refreshed = refresh_agent_head(&existing, &template).unwrap();
        assert_eq!(
            refreshed,
            format!("{NEW_HEAD}{CONFIG_MARKER}{POOL_HALF}").into_bytes()
        );
        // Bytes that are not UTF-8 below the marker survive too.
        let mut odd = format!("{OLD_HEAD}{CONFIG_MARKER}").into_bytes();
        odd.extend_from_slice(&[0xff, 0xfe, b'\n']);
        let refreshed = refresh_agent_head(&odd, &template).unwrap();
        assert!(refreshed.ends_with(&[0xff, 0xfe, b'\n']));
    }

    #[test]
    fn returns_nothing_to_write_for_a_file_with_no_marker() {
        let template = format!("{NEW_HEAD}{CONFIG_MARKER}\n");
        assert_eq!(
            refresh_agent_head(b"# Hand written\n\nNo marker here.\n", &template),
            None
        );
    }

    // Hidden row, boot-cli.test.ts:451.
    #[test]
    fn returns_nothing_to_write_when_the_template_itself_has_no_marker() {
        let existing = format!("{OLD_HEAD}{CONFIG_MARKER}{POOL_HALF}").into_bytes();
        assert_eq!(refresh_agent_head(&existing, "# no marker\n"), None);
    }
}
