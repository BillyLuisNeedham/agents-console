//! Pool settings (issue #121; pool-settings.ts): the slice of one Pool's console.json the Console's
//! Settings pane edits, and the only writer of that file inside the server. The file stays the source
//! of truth (ADR-0018), so editing it by hand and editing it from the pane are the same act.
//!
//! Two rules shape everything here. A write is a patch, never a replacement: `assign` belongs to the
//! Tickets, and a key this module has never heard of belongs to whoever put it there, so both survive a
//! save untouched. And only some of what the pane edits takes effect without a Restart: the assignment
//! slice, the Spawn caps and the Steward entry reload at the next super-step boundary, the Pool title
//! shows the moment it is saved, and BOOT_ONLY_KEYS is the rest, which the running process froze at
//! boot and the Console badges as such.

use ac_protocol::json::{True, Unchecked};
use ac_protocol::{
    EffectiveSettings, MachineDefaultsView, PoolSettingsView, RestartResponse, SettingsResponse,
};
use serde_json::{Map, Value};

use crate::config::{ConfigError, PoolConfig, config_path, read_config};
use crate::js_compat;
use crate::machine_defaults::{
    MachineDefaultsPaths, read_machine_defaults, read_machine_defaults_file,
};
use crate::pool_title::normalise_title;
use crate::spawn_caps::is_spawn_cap;
use crate::steward::is_steward_budget;

/// The keys the Settings pane owns. A patch may carry any subset; anything else in a patch body is
/// ignored rather than written, so a stale tab cannot smuggle `assign` through the pane.
pub const POOL_SETTINGS_KEYS: [&str; 10] = [
    "defaults",
    "resolver",
    "terminal",
    "port",
    "selection",
    "reviewer",
    "checkpoint",
    "title",
    "spawnCaps",
    "steward",
];

/// The settings a saved edit does not reach until the next Restart: selection, terminal and port stay
/// as this process read them at boot, and terminal and port must never move under a live run.
pub const BOOT_ONLY_KEYS: [&str; 3] = ["selection", "terminal", "port"];

/// Where a pool keeps its config.
pub fn pool_settings_path(pool_dir: &str) -> String {
    config_path(pool_dir)
}

/// The file as it is on disk, parsed but not filtered.
#[derive(Debug, Clone, PartialEq)]
pub struct PoolSettings {
    pub path: String,
    pub config: PoolConfig,
}

/// The file as it is on disk: `assign`, the boot-only keys and anything unknown all come back, because
/// the pane shows what is there and a save has to preserve what it did not touch. An absent file is the
/// empty config. A malformed one is an error: the server booted off this file, so a parse failure here
/// means it was edited into a broken state since, and saying so beats serving an empty config the next
/// save would write over.
pub fn read_pool_settings(pool_dir: &str) -> Result<PoolSettings, ConfigError> {
    Ok(PoolSettings {
        path: pool_settings_path(pool_dir),
        config: read_config(pool_dir)?,
    })
}

/// Merge a patch over the pool's config and write the result atomically.
///
/// A key absent from the patch is left exactly as it was. A key present with null or "" is removed,
/// which is how the pane clears a pinned port or drops `terminal` back to headless. `defaults`,
/// `spawnCaps` and `steward` are replaced whole when present (their empty fields dropped, an all-empty
/// one removing the key): the pane shows every field at once, so a field the operator emptied is an
/// instruction, not an omission.
///
/// Validation is the boot parse's, plus a port in range and a harness the pool knows (`harnesses`, the
/// table's names; empty skips the check). Every failure names the field and nothing is written. The
/// existing config comes through the boot parse, which leaves out the retired keys, so a save drops a
/// stale `roster` or `agents` without a word.
pub fn write_pool_settings(
    pool_dir: &str,
    patch: &Map<String, Value>,
    harnesses: &[String],
) -> Result<PoolConfig, ConfigError> {
    let mut next = read_pool_settings(pool_dir)?.config;
    for key in POOL_SETTINGS_KEYS {
        let Some(value) = patch.get(key) else {
            continue;
        };
        match normalise_key(key, value, harnesses)? {
            Some(resolved) => next.set(key, resolved),
            None => {
                next.remove(key);
            }
        }
    }
    write_config_atomically(pool_dir, &next)?;
    Ok(next)
}

/// The pool's config file, replaced whole through a rename so a reader never sees half a file: written
/// to `console.json.tmp-<pid>` as `JSON.stringify(config, null, 2)` and a newline, then renamed over
/// it. Every writer of console.json in the server goes through here: the Settings pane and Reassign.
pub fn write_config_atomically(pool_dir: &str, config: &PoolConfig) -> Result<(), ConfigError> {
    let path = pool_settings_path(pool_dir);
    js_compat::mkdir_all(pool_dir).map_err(ConfigError)?;
    let tmp = format!("{path}.tmp-{}", std::process::id());
    let text = format!("{}\n", config.to_pretty_json());
    js_compat::write_via_rename(&path, &tmp, &text).map_err(ConfigError)
}

// One key's value, validated: None means remove the key. Empty is always a removal, whatever the key's
// shape, so the pane's "clear this field" is one gesture.
fn normalise_key(
    key: &str,
    value: &Value,
    harnesses: &[String],
) -> Result<Option<Value>, ConfigError> {
    if value.is_null() {
        return Ok(None);
    }
    match key {
        "defaults" => normalise_defaults(value, harnesses),
        "resolver" => normalise_resolver(value, harnesses),
        "port" => normalise_port(value),
        "terminal" => normalise_choice("terminal", value, &["herdr"], r#""herdr""#),
        "selection" => normalise_choice(
            "selection",
            value,
            &["auto", "human"],
            r#""auto" or "human""#,
        ),
        "reviewer" | "checkpoint" => normalise_prose(key, value),
        "title" => normalise_pool_title(value),
        "spawnCaps" => normalise_spawn_caps(value),
        _ => normalise_steward(value, harnesses),
    }
}

fn refused(message: String) -> ConfigError {
    ConfigError(message)
}

// The fields of an object the pane shows whole, each a string or absent, trimmed, empty dropped.
fn string_fields(
    raw: &Map<String, Value>,
    fields: &[&str],
    subject: &str,
) -> Result<Map<String, Value>, ConfigError> {
    let mut out = Map::new();
    for field in fields {
        let entry = match raw.get(*field) {
            None | Some(Value::Null) => continue,
            Some(Value::String(entry)) => entry,
            Some(_) => {
                return Err(refused(format!(
                    "pool settings: {subject}.{field} must be a string"
                )));
            }
        };
        let trimmed = js_compat::trim(entry);
        if !trimmed.is_empty() {
            out.insert((*field).to_owned(), Value::String(trimmed.to_owned()));
        }
    }
    Ok(out)
}

fn non_empty(out: Map<String, Value>) -> Option<Value> {
    (!out.is_empty()).then_some(Value::Object(out))
}

// A numeric string the pane's text input sent, read as its number; anything else as it came.
fn text_number(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => {
            let trimmed = js_compat::trim(text);
            if trimmed.is_empty() {
                None
            } else if is_digits(trimmed) {
                Some(js_compat::number_value(js_compat::number_from_text(
                    trimmed,
                )))
            } else {
                Some(value.clone())
            }
        }
        other => Some(other.clone()),
    }
}

// `/^\d+$/`: ASCII digits only, at least one.
fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

// The Steward entry (ADR-0030) is replaced whole: a field the operator emptied goes back to its default
// (a budget of 5, the pool defaults). The budget is a text input, so a numeric string is a budget. A
// named harness must be one the pool knows. "Steward may Close checkpoints" (issue #154) is a checkbox:
// true is kept, false or absent leaves it out, since off is the default.
fn normalise_steward(value: &Value, harnesses: &[String]) -> Result<Option<Value>, ConfigError> {
    let Value::Object(raw) = value else {
        return Err(refused("pool settings: steward must be an object".into()));
    };
    let mut out = Map::new();
    if let Some(budget) = raw.get("budget").and_then(text_number)
        && !budget.is_null()
    {
        if !is_steward_budget(&budget) {
            return Err(refused(
                "pool settings: steward.budget must be a whole number, 1 or more".into(),
            ));
        }
        out.insert("budget".into(), budget);
    }
    if let Some(assign) = raw.get("assign").filter(|assign| !assign.is_null()) {
        let Value::Object(assign) = assign else {
            return Err(refused(
                "pool settings: steward.assign must be an object".into(),
            ));
        };
        let assign = string_fields(
            assign,
            &["harness", "model", "effort", "drivers"],
            "steward.assign",
        )?;
        if let Some(harness) = assign.get("harness").and_then(Value::as_str) {
            require_known_harness("pool settings: steward.assign.harness", harness, harnesses)?;
        }
        if !assign.is_empty() {
            out.insert("assign".into(), Value::Object(assign));
        }
    }
    if let Some(may_close) = raw.get("mayClose").filter(|may_close| !may_close.is_null()) {
        let Value::Bool(may_close) = may_close else {
            return Err(refused(
                "pool settings: steward.mayClose must be true or false".into(),
            ));
        };
        if *may_close {
            out.insert("mayClose".into(), Value::Bool(true));
        }
    }
    Ok(non_empty(out))
}

// The Spawn caps (issue #149) are replaced whole: a field the operator emptied goes back to the
// engine's default. Each field is a text input, so a numeric string is a cap; a cap of 0 holds every
// proposal for the operator (issue #150).
fn normalise_spawn_caps(value: &Value) -> Result<Option<Value>, ConfigError> {
    let Value::Object(raw) = value else {
        return Err(refused("pool settings: spawnCaps must be an object".into()));
    };
    let mut out = Map::new();
    for field in ["perAttempt", "perRun"] {
        let Some(entry) = raw
            .get(field)
            .filter(|entry| !entry.is_null())
            .and_then(text_number)
        else {
            continue;
        };
        if !is_spawn_cap(&entry) {
            return Err(refused(format!(
                "pool settings: spawnCaps.{field} must be a whole number, 0 or more"
            )));
        }
        out.insert(field.to_owned(), entry);
    }
    Ok(non_empty(out))
}

// The Pool title (issue #100) is one line: whatever was typed is folded onto it rather than refused.
fn normalise_pool_title(value: &Value) -> Result<Option<Value>, ConfigError> {
    let Value::String(text) = value else {
        return Err(refused("pool settings: title must be a string".into()));
    };
    Ok(normalise_title(text).map(Value::String))
}

fn normalise_prose(key: &str, value: &Value) -> Result<Option<Value>, ConfigError> {
    let Value::String(text) = value else {
        return Err(refused(format!("pool settings: {key} must be a string")));
    };
    let trimmed = js_compat::trim(text);
    Ok((!trimmed.is_empty()).then(|| Value::String(trimmed.to_owned())))
}

fn normalise_defaults(value: &Value, harnesses: &[String]) -> Result<Option<Value>, ConfigError> {
    let Value::Object(raw) = value else {
        return Err(refused("pool settings: defaults must be an object".into()));
    };
    let out = string_fields(raw, &["harness", "model", "effort", "drivers"], "defaults")?;
    if let Some(harness) = out.get("harness").and_then(Value::as_str) {
        require_known_harness("pool settings: defaults.harness", harness, harnesses)?;
    }
    Ok(non_empty(out))
}

// The resolver takes three shapes: a harness name, the opt-out "none", or { harness, model, effort }
// when it runs on a harness of its own. An empty string is the pane clearing the key, not the opt-out;
// "none" is the opt-out and is kept verbatim.
fn normalise_resolver(value: &Value, harnesses: &[String]) -> Result<Option<Value>, ConfigError> {
    if let Value::String(text) = value {
        let trimmed = js_compat::trim(text);
        if trimmed.is_empty() {
            return Ok(None);
        }
        if trimmed != "none" {
            require_known_harness("pool settings: resolver", trimmed, harnesses)?;
        }
        return Ok(Some(Value::String(trimmed.to_owned())));
    }
    let Value::Object(raw) = value else {
        return Err(refused(
            r#"pool settings: resolver must be a harness name, "none", or { harness, model, effort }"#.into(),
        ));
    };
    let out = string_fields(raw, &["harness", "model", "effort"], "resolver")?;
    if let Some(harness) = out.get("harness").and_then(Value::as_str)
        && harness != "none"
    {
        require_known_harness("pool settings: resolver.harness", harness, harnesses)?;
    }
    Ok(non_empty(out))
}

// A pinned port, or nothing. Port 0 is not a pin, so the pane clears the key instead. A numeric string
// is accepted because the pane's field is a text input; anything else is refused by name.
fn normalise_port(value: &Value) -> Result<Option<Value>, ConfigError> {
    match value {
        Value::String(text) => {
            let trimmed = js_compat::trim(text);
            if trimmed.is_empty() {
                return Ok(None);
            }
            if !is_digits(trimmed) {
                return Err(refused(format!(
                    "pool settings: port must be an integer 1-65535, got {text}"
                )));
            }
            checked_port(js_compat::number_from_text(trimmed)).map(Some)
        }
        Value::Number(_) => checked_port(js_compat::number_of(value).unwrap_or(f64::NAN)).map(Some),
        _ => Err(refused(
            "pool settings: port must be an integer 1-65535".into(),
        )),
    }
}

fn checked_port(port: f64) -> Result<Value, ConfigError> {
    if !port.is_finite() || port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) {
        return Err(refused(format!(
            "pool settings: port must be an integer 1-65535, got {}",
            js_compat::number_string(port)
        )));
    }
    Ok(Value::from(port as u64))
}

// terminal and selection: "" clears, one of the legal words is kept, anything else is refused with
// the value as JSON.stringify writes it.
fn normalise_choice(
    key: &str,
    value: &Value,
    legal: &[&str],
    expected: &str,
) -> Result<Option<Value>, ConfigError> {
    match value.as_str() {
        Some("") => Ok(None),
        Some(word) if legal.contains(&word) => Ok(Some(value.clone())),
        _ => Err(refused(format!(
            "pool settings: {key} must be {expected} (got {})",
            js_compat::stringify(value)
        ))),
    }
}

/// The one check that a named harness is one this pool knows, shared by the Settings pane's
/// `defaults.harness`, resolver and Steward harness and by Reassign's per-ticket harness (issue #126).
/// `subject` is the whole prefix the message opens with ("pool settings: defaults.harness", "reassign:
/// harness"). An empty table skips the check.
pub fn require_known_harness(
    subject: &str,
    harness: &str,
    harnesses: &[String],
) -> Result<(), ConfigError> {
    if harnesses.is_empty() || harnesses.iter().any(|known| known == harness) {
        return Ok(());
    }
    let mut known = harnesses.to_vec();
    js_compat::sort_strings(&mut known);
    Err(refused(format!(
        "{subject} names unknown harness '{harness}'. Known: {}",
        known.join(", ")
    )))
}

// ---------------------------------------------------------------------------------------------------
// The Settings payload (GET /api/settings and both PUTs) and the Restart answer
// ---------------------------------------------------------------------------------------------------

/// What the Settings payload is built from beside the files: what this process booted with.
#[derive(Debug, Clone, Copy)]
pub struct SettingsContext<'a> {
    pub pool_dir: &'a str,
    /// The config this process parsed at boot, which the boot-only keys still run on.
    pub boot_config: &'a PoolConfig,
    pub machine_paths: &'a MachineDefaultsPaths,
    /// The harness names this pool knows, in table order (they are sorted for the pane).
    pub harnesses: &'a [String],
}

/// Everything the Settings pane draws, in one payload: the pool's config as it is on disk right now
/// (re-read on every call, so a hand edit and a save both show), which of its keys a save will not
/// reach until a Restart, what this process booted with, the Machine defaults in force beside the
/// file's own fields, and the harness names to offer. Fails only when console.json was edited into a
/// broken state since boot.
pub fn settings_payload(
    context: SettingsContext<'_>,
    bound_port: u64,
) -> Result<SettingsResponse, ConfigError> {
    let pool = read_pool_settings(context.pool_dir)?;
    let relaunch = relaunch_port(context.pool_dir, bound_port);
    let stale = stale_boot_only_keys(&pool.config, context.boot_config, bound_port, &relaunch);
    let mut harnesses = context.harnesses.to_vec();
    js_compat::sort_strings(&mut harnesses);
    Ok(SettingsResponse {
        pool: PoolSettingsView {
            path: pool.path,
            config: Unchecked::new(pool.config.to_value()),
            boot_only: BOOT_ONLY_KEYS.iter().map(|key| (*key).to_owned()).collect(),
            effective: EffectiveSettings {
                port: bound_port,
                terminal: context.boot_config.terminal(),
                stale,
            },
        },
        machine: MachineDefaultsView {
            path: context.machine_paths.file.clone(),
            defaults: read_machine_defaults(context.machine_paths),
            own: read_machine_defaults_file(&context.machine_paths.file),
        },
        harnesses,
    })
}

/// The boot-only keys whose saved value is not what this process is running on, so the Console can
/// badge them as waiting for a Restart: derived from the file rather than from what a save changed, so
/// a reload, a second tab or a hand edit shows the same badge. Port is judged by where a Restart would
/// actually put the Console (`relaunch`, from `relaunch_port`), so pinning the port the pool already
/// runs on, or clearing a pin, moves nothing.
pub fn stale_boot_only_keys(
    config: &PoolConfig,
    boot_config: &PoolConfig,
    bound_port: u64,
    relaunch: &Value,
) -> Vec<String> {
    let mut stale = Vec::new();
    for key in BOOT_ONLY_KEYS {
        let differs = match key {
            "port" => js_compat::number_of(relaunch) != Some(bound_port as f64),
            "terminal" => strict_or_null(config.get(key)) != strict_or_null(boot_config.get(key)),
            _ => {
                config.get(key).map(js_compat::stringify)
                    != boot_config.get(key).map(js_compat::stringify)
            }
        };
        if differs {
            stale.push(key.to_owned());
        }
    }
    stale
}

// `value ?? null` as `!==` compares it: strings by their text, null and absent alike. Anything else is
// never equal to anything (an object compares by identity), which the boot parse rules out anyway.
fn strict_or_null(value: Option<&Value>) -> Option<Result<&str, ()>> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(Ok(text)),
        Some(_) => Some(Err(())),
    }
}

/// Where the tab should look for the Console once Boot has relaunched it: the pin in console.json,
/// re-read from disk because the pane may have saved one a moment ago and that save is what a Restart
/// exists to apply; otherwise this server's bound port. Port 0 is never a pin. The pin is answered as
/// the file has it, unchecked; a console.json that no longer parses answers the bound port.
pub fn relaunch_port(pool_dir: &str, bound_port: u64) -> Value {
    match read_pool_settings(pool_dir) {
        Ok(settings) => match settings.config.port() {
            Some(pin) if js_compat::number_of(pin) != Some(0.0) => pin.clone(),
            _ => Value::from(bound_port),
        },
        Err(_) => Value::from(bound_port),
    }
}

/// POST /api/restart's acknowledgement: the port the relaunched Console will listen on.
pub fn restart_response(pool_dir: &str, serving_port: u64) -> RestartResponse {
    RestartResponse {
        ok: True,
        port: Unchecked::new(relaunch_port(pool_dir, serving_port)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine_defaults::default_machine_defaults_paths;
    use serde_json::json;

    const HARNESSES: [&str; 3] = ["claude", "opencode", "stub"];

    fn harnesses() -> Vec<String> {
        HARNESSES.iter().map(|name| (*name).to_owned()).collect()
    }

    struct Pool {
        dir: tempfile::TempDir,
    }

    impl Pool {
        /// A pool directory holding the given console.json (none when omitted).
        fn new(config: Option<Value>) -> Self {
            let dir = tempfile::tempdir().unwrap();
            if let Some(config) = config {
                std::fs::write(
                    dir.path().join("console.json"),
                    format!("{}\n", js_compat::stringify_pretty(&config)),
                )
                .unwrap();
            }
            Pool { dir }
        }

        fn path(&self) -> &str {
            self.dir.path().to_str().unwrap()
        }

        fn on_disk(&self) -> Value {
            serde_json::from_str(
                &std::fs::read_to_string(self.dir.path().join("console.json")).unwrap(),
            )
            .unwrap()
        }

        fn write(&self, patch: Value, harnesses: &[String]) -> Result<Value, String> {
            let Value::Object(patch) = patch else {
                unreachable!()
            };
            write_pool_settings(self.path(), &patch, harnesses)
                .map(|config| config.to_value())
                .map_err(|err| err.0)
        }
    }

    // pool-settings.test.ts
    #[test]
    fn reads_an_absent_file_as_no_config_and_the_file_as_it_is_otherwise() {
        assert_eq!(
            read_pool_settings(Pool::new(None).path()).unwrap().config,
            PoolConfig::default()
        );
        let pool = Pool::new(Some(
            json!({ "port": 8790, "assign": { "01": { "harness": "claude" } } }),
        ));
        let read = read_pool_settings(pool.path()).unwrap();
        assert_eq!(read.path, format!("{}/console.json", pool.path()));
        assert_eq!(
            read.config.to_value(),
            json!({ "port": 8790, "assign": { "01": { "harness": "claude" } } })
        );
    }

    #[test]
    fn merges_a_patch_over_the_file_preserving_assign_and_unknown_keys() {
        let pool = Pool::new(Some(json!({
            "defaults": { "harness": "stub", "model": "m" },
            "assign": { "01": { "harness": "claude", "verify": 2 } },
            "port": 8787,
            "somethingElse": { "kept": true },
        })));
        let written = pool
            .write(json!({ "defaults": { "harness": "claude", "model": "opus" }, "selection": "human" }), &harnesses())
            .unwrap();
        let expected = json!({
            "defaults": { "harness": "claude", "model": "opus" },
            "assign": { "01": { "harness": "claude", "verify": 2 } },
            "port": 8787,
            "somethingElse": { "kept": true },
            "selection": "human",
        });
        assert_eq!(written, expected);
        assert_eq!(pool.on_disk(), expected);
        // The exact bytes: the file's own order, the new key last, two-space indent and a newline.
        assert_eq!(
            std::fs::read_to_string(pool.dir.path().join("console.json")).unwrap(),
            format!("{}\n", js_compat::stringify_pretty(&expected))
        );
    }

    #[test]
    fn leaves_a_key_the_patch_never_mentions_exactly_as_it_was() {
        let pool = Pool::new(Some(
            json!({ "checkpoint": "a device", "terminal": "herdr" }),
        ));
        pool.write(json!({ "reviewer": "acceptance criteria only" }), &[])
            .unwrap();
        assert_eq!(
            pool.on_disk(),
            json!({ "checkpoint": "a device", "terminal": "herdr", "reviewer": "acceptance criteria only" })
        );
    }

    #[test]
    fn removes_a_key_the_patch_clears_with_null_or_an_empty_string() {
        let pool = Pool::new(Some(json!({
            "port": 8787, "terminal": "herdr", "reviewer": "- deepseek", "selection": "human", "assign": { "01": {} },
        })));
        let written = pool
            .write(
                json!({ "port": null, "terminal": "", "reviewer": "   ", "selection": null }),
                &harnesses(),
            )
            .unwrap();
        assert_eq!(written, json!({ "assign": { "01": {} } }));
        assert_eq!(pool.on_disk(), json!({ "assign": { "01": {} } }));
    }

    #[test]
    fn replaces_defaults_whole_dropping_empty_fields_and_removes_an_all_empty_one() {
        let pool = Pool::new(Some(
            json!({ "defaults": { "harness": "stub", "model": "m", "drivers": "implement" } }),
        ));
        assert_eq!(
            pool.write(json!({ "defaults": { "harness": "claude", "model": "", "drivers": " implement " } }), &harnesses())
                .unwrap()["defaults"],
            json!({ "harness": "claude", "drivers": "implement" })
        );
        assert_eq!(
            pool.write(
                json!({ "defaults": { "harness": "claude", "effort": " xhigh " } }),
                &harnesses()
            )
            .unwrap()["defaults"],
            json!({ "harness": "claude", "effort": "xhigh" })
        );
        assert_eq!(
            pool.write(json!({ "defaults": { "effort": 3 } }), &harnesses())
                .unwrap_err(),
            "pool settings: defaults.effort must be a string"
        );
        assert_eq!(
            pool.write(
                json!({ "defaults": { "harness": "", "model": "" } }),
                &harnesses()
            )
            .unwrap(),
            json!({})
        );
        assert_eq!(
            pool.write(json!({ "defaults": [] }), &harnesses())
                .unwrap_err(),
            "pool settings: defaults must be an object"
        );
    }

    #[test]
    fn keeps_the_resolvers_opt_out_and_its_object_form_and_clears_on_empty() {
        let pool = Pool::new(Some(json!({})));
        assert_eq!(
            pool.write(json!({ "resolver": "none" }), &harnesses())
                .unwrap()["resolver"],
            json!("none")
        );
        assert_eq!(
            pool.write(
                json!({ "resolver": { "harness": "opencode", "model": "oc/flash" } }),
                &harnesses()
            )
            .unwrap()["resolver"],
            json!({ "harness": "opencode", "model": "oc/flash" })
        );
        assert_eq!(
            pool.write(json!({ "resolver": { "harness": "opencode", "model": "oc/flash", "effort": " max " } }), &harnesses())
                .unwrap()["resolver"],
            json!({ "harness": "opencode", "model": "oc/flash", "effort": "max" })
        );
        assert_eq!(
            pool.write(json!({ "resolver": { "effort": 1 } }), &harnesses())
                .unwrap_err(),
            "pool settings: resolver.effort must be a string"
        );
        assert_eq!(
            pool.write(json!({ "resolver": "" }), &harnesses()).unwrap(),
            json!({})
        );
        assert_eq!(
            pool.write(json!({ "resolver": 5 }), &harnesses())
                .unwrap_err(),
            r#"pool settings: resolver must be a harness name, "none", or { harness, model, effort }"#
        );
    }

    #[test]
    fn rejects_a_port_that_is_not_an_integer_in_range_naming_the_field() {
        let pool = Pool::new(Some(json!({ "port": 8787 })));
        assert_eq!(
            pool.write(json!({ "port": 0 }), &[]).unwrap_err(),
            "pool settings: port must be an integer 1-65535, got 0"
        );
        assert_eq!(
            pool.write(json!({ "port": 70000 }), &[]).unwrap_err(),
            "pool settings: port must be an integer 1-65535, got 70000"
        );
        assert_eq!(
            pool.write(json!({ "port": 12.5 }), &[]).unwrap_err(),
            "pool settings: port must be an integer 1-65535, got 12.5"
        );
        assert_eq!(
            pool.write(json!({ "port": " http" }), &[]).unwrap_err(),
            "pool settings: port must be an integer 1-65535, got  http"
        );
        assert_eq!(
            pool.write(json!({ "port": true }), &[]).unwrap_err(),
            "pool settings: port must be an integer 1-65535"
        );
        assert_eq!(pool.on_disk(), json!({ "port": 8787 }));
        assert_eq!(
            pool.write(json!({ "port": "8790" }), &[]).unwrap()["port"],
            json!(8790)
        );
        assert_eq!(
            pool.write(json!({ "port": 8791.0 }), &[]).unwrap()["port"],
            json!(8791)
        );
    }

    #[test]
    fn replaces_spawn_caps_whole_taking_numeric_strings_and_removing_an_all_empty_one() {
        let pool = Pool::new(Some(
            json!({ "spawnCaps": { "perAttempt": 5, "perRun": 20 } }),
        ));
        assert_eq!(
            pool.write(
                json!({ "spawnCaps": { "perAttempt": 8, "perRun": " 30 " } }),
                &[]
            )
            .unwrap()["spawnCaps"],
            json!({ "perAttempt": 8, "perRun": 30 })
        );
        assert_eq!(
            pool.write(
                json!({ "spawnCaps": { "perAttempt": "", "perRun": 40 } }),
                &[]
            )
            .unwrap()["spawnCaps"],
            json!({ "perRun": 40 })
        );
        assert_eq!(
            pool.write(
                json!({ "spawnCaps": { "perAttempt": null, "perRun": "" } }),
                &[]
            )
            .unwrap(),
            json!({})
        );
    }

    #[test]
    fn rejects_a_spawn_cap_that_is_not_a_whole_number_of_0_or_more_naming_the_field() {
        let pool = Pool::new(Some(json!({ "spawnCaps": { "perRun": 20 } })));
        for bad in [
            json!(-1),
            json!(2.5),
            json!("many"),
            json!("-2"),
            json!(true),
        ] {
            assert_eq!(
                pool.write(json!({ "spawnCaps": { "perRun": bad } }), &[])
                    .unwrap_err(),
                "pool settings: spawnCaps.perRun must be a whole number, 0 or more"
            );
        }
        assert_eq!(
            pool.write(json!({ "spawnCaps": { "perAttempt": -1 } }), &[])
                .unwrap_err(),
            "pool settings: spawnCaps.perAttempt must be a whole number, 0 or more"
        );
        assert_eq!(
            pool.write(json!({ "spawnCaps": 5 }), &[]).unwrap_err(),
            "pool settings: spawnCaps must be an object"
        );
        assert_eq!(pool.on_disk(), json!({ "spawnCaps": { "perRun": 20 } }));
    }

    #[test]
    fn carries_steward_may_close_beside_the_budget_and_assign_false_leaving_it_out() {
        let pool = Pool::new(Some(json!({ "steward": { "budget": 3 } })));
        assert_eq!(
            pool.write(json!({ "steward": { "budget": "3", "assign": { "model": "judge" }, "mayClose": true } }), &harnesses())
                .unwrap()["steward"],
            json!({ "budget": 3, "assign": { "model": "judge" }, "mayClose": true })
        );
        assert_eq!(
            pool.on_disk()["steward"],
            json!({ "budget": 3, "assign": { "model": "judge" }, "mayClose": true })
        );
        assert_eq!(
            pool.write(
                json!({ "steward": { "budget": 3, "mayClose": false } }),
                &harnesses()
            )
            .unwrap()["steward"],
            json!({ "budget": 3 })
        );
        assert_eq!(
            pool.write(json!({ "steward": { "budget": 3 } }), &harnesses())
                .unwrap()["steward"],
            json!({ "budget": 3 })
        );
        assert_eq!(
            pool.write(json!({ "steward": { "mayClose": true } }), &harnesses())
                .unwrap()["steward"],
            json!({ "mayClose": true })
        );
    }

    #[test]
    fn refuses_a_steward_may_close_that_is_not_true_or_false_leaving_the_file_as_it_was() {
        let pool = Pool::new(Some(json!({ "steward": { "mayClose": true } })));
        for bad in [json!("true"), json!(1), json!({})] {
            assert_eq!(
                pool.write(json!({ "steward": { "mayClose": bad } }), &harnesses())
                    .unwrap_err(),
                "pool settings: steward.mayClose must be true or false"
            );
        }
        assert_eq!(pool.on_disk(), json!({ "steward": { "mayClose": true } }));
    }

    // steward.test.ts: is a Pool setting, replaced whole, its budget typed as text, its harness checked
    #[test]
    fn replaces_the_steward_entry_whole_its_budget_typed_as_text_its_harness_checked() {
        let pool = Pool::new(Some(
            json!({ "defaults": { "harness": "claude", "model": "m" } }),
        ));
        let two = vec!["claude".to_owned(), "opencode".to_owned()];
        assert_eq!(
            pool.write(
                json!({ "steward": { "budget": " 3 ", "assign": { "model": " judge ", "harness": "", "effort": "high" } } }),
                &two
            )
            .unwrap()["steward"],
            json!({ "budget": 3, "assign": { "model": "judge", "effort": "high" } })
        );
        assert_eq!(
            pool.write(json!({ "steward": { "budget": "0" } }), &[])
                .unwrap_err(),
            "pool settings: steward.budget must be a whole number, 1 or more"
        );
        assert_eq!(
            pool.write(
                json!({ "steward": { "assign": { "harness": "nope" } } }),
                &["claude".to_owned()]
            )
            .unwrap_err(),
            "pool settings: steward.assign.harness names unknown harness 'nope'. Known: claude"
        );
        assert_eq!(
            pool.write(json!({ "steward": { "assign": 3 } }), &[])
                .unwrap_err(),
            "pool settings: steward.assign must be an object"
        );
        assert_eq!(
            pool.write(json!({ "steward": { "assign": { "drivers": 1 } } }), &[])
                .unwrap_err(),
            "pool settings: steward.assign.drivers must be a string"
        );
        assert_eq!(
            pool.write(json!({ "steward": [] }), &[]).unwrap_err(),
            "pool settings: steward must be an object"
        );
        // An entry the operator emptied goes back to the defaults by leaving the key out.
        assert_eq!(
            pool.write(json!({ "steward": { "budget": "", "assign": {} } }), &[])
                .unwrap()
                .get("steward"),
            None
        );
    }

    #[test]
    fn takes_a_cap_of_0_as_a_number_or_as_the_panes_text() {
        let pool = Pool::new(Some(json!({})));
        assert_eq!(
            pool.write(
                json!({ "spawnCaps": { "perAttempt": 0, "perRun": "0" } }),
                &[]
            )
            .unwrap()["spawnCaps"],
            json!({ "perAttempt": 0, "perRun": 0 })
        );
    }

    #[test]
    fn rejects_a_terminal_and_a_selection_the_engine_would_not_accept() {
        let pool = Pool::new(Some(json!({})));
        assert_eq!(
            pool.write(json!({ "terminal": "tmux" }), &[]).unwrap_err(),
            r#"pool settings: terminal must be "herdr" (got "tmux")"#
        );
        assert_eq!(
            pool.write(json!({ "selection": "coin-toss" }), &[])
                .unwrap_err(),
            r#"pool settings: selection must be "auto" or "human" (got "coin-toss")"#
        );
        assert_eq!(
            pool.write(json!({ "selection": 3 }), &[]).unwrap_err(),
            r#"pool settings: selection must be "auto" or "human" (got 3)"#
        );
    }

    #[test]
    fn rejects_a_harness_the_pool_does_not_know_in_defaults_and_in_the_resolver() {
        let pool = Pool::new(Some(json!({})));
        assert_eq!(
            pool.write(json!({ "defaults": { "harness": "gpt" } }), &harnesses())
                .unwrap_err(),
            "pool settings: defaults.harness names unknown harness 'gpt'. Known: claude, opencode, stub"
        );
        assert_eq!(
            pool.write(json!({ "resolver": "gpt" }), &harnesses())
                .unwrap_err(),
            "pool settings: resolver names unknown harness 'gpt'. Known: claude, opencode, stub"
        );
        assert!(
            pool.write(json!({ "resolver": { "harness": "gpt" } }), &harnesses())
                .unwrap_err()
                .contains("resolver.harness")
        );
        // No harness table means no check, rather than refusing every harness.
        assert_eq!(
            pool.write(json!({ "defaults": { "harness": "gpt" } }), &[])
                .unwrap()["defaults"],
            json!({ "harness": "gpt" })
        );
    }

    #[test]
    fn reads_past_a_retired_roster_and_agents_and_drops_them_on_the_next_save() {
        let pool = Pool::new(Some(
            json!({ "roster": "- deepseek", "agents": "{\"deepseek\":{}}", "port": 8787 }),
        ));
        assert_eq!(
            read_pool_settings(pool.path()).unwrap().config.to_value(),
            json!({ "port": 8787 })
        );
        pool.write(json!({ "reviewer": "r" }), &[]).unwrap();
        assert_eq!(pool.on_disk(), json!({ "port": 8787, "reviewer": "r" }));
    }

    #[test]
    fn ignores_a_retired_key_or_any_key_outside_the_panes_own() {
        let pool = Pool::new(Some(json!({})));
        assert_eq!(
            pool.write(
                json!({ "roster": "- deepseek", "agents": "{not json" }),
                &[]
            )
            .unwrap(),
            json!({})
        );
        assert_eq!(pool.on_disk(), json!({}));
        let pool = Pool::new(Some(json!({ "assign": { "01": { "harness": "claude" } } })));
        pool.write(
            json!({ "assign": { "99": { "harness": "stub" } }, "roster": "- deepseek" }),
            &harnesses(),
        )
        .unwrap();
        assert_eq!(
            pool.on_disk()["assign"],
            json!({ "01": { "harness": "claude" } })
        );
    }

    #[test]
    fn writes_through_a_rename_leaving_no_temporary_file_behind() {
        let pool = Pool::new(Some(json!({ "port": 8787 })));
        pool.write(json!({ "reviewer": "- deepseek" }), &[])
            .unwrap();
        let names: Vec<_> = std::fs::read_dir(pool.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["console.json"]);
    }

    #[test]
    fn writes_a_pool_that_had_no_console_json_at_all() {
        let pool = Pool::new(None);
        assert_eq!(
            pool.write(json!({ "terminal": "herdr" }), &[]).unwrap(),
            json!({ "terminal": "herdr" })
        );
        assert_eq!(pool.on_disk(), json!({ "terminal": "herdr" }));
    }

    #[test]
    fn refuses_a_save_over_a_file_that_no_longer_parses_and_writes_nothing() {
        let pool = Pool::new(None);
        std::fs::write(pool.dir.path().join("console.json"), "{ not json").unwrap();
        assert!(pool.write(json!({ "title": "x" }), &[]).is_err());
        assert_eq!(
            std::fs::read_to_string(pool.dir.path().join("console.json")).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn folds_a_title_onto_one_line_and_refuses_one_that_is_not_a_string() {
        let pool = Pool::new(None);
        assert_eq!(
            pool.write(json!({ "title": "  Jev\nas grader " }), &[])
                .unwrap()["title"],
            json!("Jev as grader")
        );
        assert_eq!(
            pool.write(json!({ "title": " \n" }), &[]).unwrap(),
            json!({})
        );
        assert_eq!(
            pool.write(json!({ "title": 5 }), &[]).unwrap_err(),
            "pool settings: title must be a string"
        );
        assert_eq!(
            pool.write(json!({ "reviewer": 5 }), &[]).unwrap_err(),
            "pool settings: reviewer must be a string"
        );
    }

    #[test]
    fn names_the_boot_only_keys_as_a_subset_of_the_panes_own() {
        for key in BOOT_ONLY_KEYS {
            assert!(POOL_SETTINGS_KEYS.contains(&key));
        }
        assert!(POOL_SETTINGS_KEYS.contains(&"spawnCaps"));
        assert_eq!(BOOT_ONLY_KEYS, ["selection", "terminal", "port"]);
    }

    // The Settings payload and the Restart answer (server.ts)
    fn config(value: Value) -> PoolConfig {
        let Value::Object(map) = value else {
            unreachable!()
        };
        PoolConfig::from_map(map)
    }

    #[test]
    fn answers_the_relaunch_port_from_the_pin_on_disk_else_the_bound_port() {
        let pool = Pool::new(None);
        assert_eq!(relaunch_port(pool.path(), 8787), json!(8787));
        pool.write(json!({ "port": 8790 }), &[]).unwrap();
        assert_eq!(relaunch_port(pool.path(), 8787), json!(8790));
        std::fs::write(pool.dir.path().join("console.json"), r#"{"port":0}"#).unwrap();
        assert_eq!(relaunch_port(pool.path(), 8787), json!(8787));
        // Unchecked, as the TypeScript re-reads it.
        std::fs::write(pool.dir.path().join("console.json"), r#"{"port":"9000"}"#).unwrap();
        assert_eq!(relaunch_port(pool.path(), 8787), json!("9000"));
        std::fs::write(pool.dir.path().join("console.json"), r#"{"port":null}"#).unwrap();
        assert_eq!(relaunch_port(pool.path(), 8787), json!(null));
        std::fs::write(pool.dir.path().join("console.json"), "{ not json").unwrap();
        assert_eq!(relaunch_port(pool.path(), 8787), json!(8787));
        assert_eq!(
            serde_json::to_value(restart_response(pool.path(), 8787)).unwrap(),
            json!({ "ok": true, "port": 8787 })
        );
    }

    #[test]
    fn badges_a_boot_only_key_whose_saved_value_is_not_what_is_running() {
        let boot = config(json!({ "selection": "human", "port": 8787 }));
        assert!(stale_boot_only_keys(&boot, &boot, 8787, &json!(8787)).is_empty());
        let saved = config(json!({ "selection": "auto", "terminal": "herdr", "port": 9000 }));
        assert_eq!(
            stale_boot_only_keys(&saved, &boot, 8787, &json!(9000)),
            ["selection", "terminal", "port"]
        );
        // A pin on the port it already runs on moves nothing; a string pin is never the bound port.
        assert!(stale_boot_only_keys(&boot, &boot, 8787, &json!(8787.0)).is_empty());
        assert_eq!(
            stale_boot_only_keys(&boot, &boot, 8787, &json!("8787")),
            ["port"]
        );
        // Absent and null terminal are the same; a cleared selection is a change.
        let null_terminal = config(json!({ "selection": "human", "terminal": null }));
        assert!(stale_boot_only_keys(&null_terminal, &boot, 8787, &json!(8787)).is_empty());
        assert_eq!(
            stale_boot_only_keys(&config(json!({})), &boot, 8787, &json!(8787)),
            ["selection"]
        );
    }

    #[test]
    fn builds_the_settings_payload_from_the_files_and_what_this_process_booted_with() {
        let pool = Pool::new(Some(
            json!({ "terminal": "herdr", "roster": "x", "mystery": 1 }),
        ));
        let home = tempfile::tempdir().unwrap();
        let machine = default_machine_defaults_paths(home.path().to_str().unwrap());
        std::fs::write(home.path().join(".issue-runner"), "harness=opencode\n").unwrap();
        let boot = PoolConfig::default();
        let names = vec![
            "opencode".to_owned(),
            "claude".to_owned(),
            "cursor".to_owned(),
        ];
        let context = SettingsContext {
            pool_dir: pool.path(),
            boot_config: &boot,
            machine_paths: &machine,
            harnesses: &names,
        };
        let payload = serde_json::to_value(settings_payload(context, 8787).unwrap()).unwrap();
        assert_eq!(
            payload,
            json!({
                "pool": {
                    "path": format!("{}/console.json", pool.path()),
                    "config": { "terminal": "herdr", "mystery": 1 },
                    "bootOnly": ["selection", "terminal", "port"],
                    "effective": { "port": 8787, "terminal": null, "stale": ["terminal"] },
                },
                "machine": {
                    "path": machine.file,
                    "defaults": { "harness": "opencode" },
                    "own": {},
                },
                "harnesses": ["claude", "cursor", "opencode"],
            })
        );
        std::fs::write(pool.dir.path().join("console.json"), "{ not json").unwrap();
        assert!(settings_payload(context, 8787).is_err());
    }

    #[test]
    fn names_the_known_harnesses_sorted_when_refusing_one() {
        let names = vec!["opencode".to_owned(), "claude".to_owned()];
        assert_eq!(
            require_known_harness("reassign: harness", "gemini", &names)
                .unwrap_err()
                .0,
            "reassign: harness names unknown harness 'gemini'. Known: claude, opencode"
        );
        assert!(require_known_harness("reassign: harness", "claude", &names).is_ok());
        assert!(require_known_harness("reassign: harness", "anything", &[]).is_ok());
    }
}
