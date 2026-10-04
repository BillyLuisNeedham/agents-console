//! The pool's config file, `console.json` (engine.ts from `readConfig` to the end): its one parser, the
//! keys the engine retired, the Config reload's slice of it, and the canonical spelling of the pool
//! directory it is read from.
//!
//! The engine's live config (`PoolConfig`) is arbitrary JSON, held exactly as the TypeScript holds it,
//! never the typed `ac_protocol::PoolConfig` (that is the file's declared shape, for the TypeScript
//! generator):
//!
//! - At boot it is console.json parsed in file order, with `roster` and `agents` deleted, or `{}` when
//!   the file is absent or empty. The parse checks only `selection`, `terminal`, `spawnCaps` and
//!   `steward`; unknown keys and unchecked values (a null, a string port) pass through.
//! - After a Config reload it is `{ ...previous, defaults, assign, resolver, spawnCaps, steward }`
//!   (`reload_candidate`): existing keys keep their place, new ones go last, and a slice key the file
//!   no longer has stays in its place as JavaScript's `undefined`, which no serialization writes.
//! - The snapshot's `state.config` sends it verbatim: `PoolConfig` serializes as that object, its keys
//!   in JavaScript's order and its numbers as JavaScript prints them.
//!
//! Each field is read where it is used, as leniently as the TypeScript reads it:
//!
//! | Accessor | The TypeScript's read |
//! | --- | --- |
//! | `get(key)` | `config[key]`, the value as the file has it; `None` for absent or undefined |
//! | `selection_mode()` | `config.selection === "human" ? "human" : "auto"` |
//! | `terminal()` | `config.terminal === "herdr"` (the only backing) |
//! | `terminal_text()` | `config.terminal` where it is a string, for `poolHarnessMode` |
//! | `port()` | `config.port`, raw: ports.ts and the Restart judge it |
//! | `resolver()` | `config.resolver`, raw: a harness name, "none", or `{ harness, model, effort }` |
//! | `assignment::defaults_layer` | `config.defaults`, its four fields as `firstSet` reads them |
//! | `assignment::assign_request` | `config.assign?.[id]`, the layer plus a raw `verify` |
//! | `spawn_caps::spawn_caps_of` | `config.spawnCaps?.perAttempt ?? 5`, `?.perRun ?? 20` |
//! | `steward::steward_budget_of` | `config.steward?.budget ?? 5` |
//! | `steward::steward_may_close_of` | `config.steward?.mayClose === true` |
//! | `steward::steward_assign_of` | `config.steward?.assign` |
//! | `pool_title::title_of` | `config.title` where it is a string, normalised |
//!
//! `repoRootOf` runs git, so it lives with the git edge: `ac_io::git::repo_root_of`.

use std::fmt;

use ac_protocol::{SelectionMode, TerminalKind};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::harness::Harnesses;
use crate::js;
use crate::spawn_caps::check_spawn_caps;
use crate::steward::check_steward_config;

/// The config file's name inside the pool directory.
pub const CONSOLE_JSON: &str = "console.json";

/// Keys a pool config once held and the engine no longer reads (ADR-0031): the subagent `roster` prose
/// and the `agents` JSON once handed to claude's `--agents`. A file that still carries them reads as if
/// it did not, with no warning, and every writer that starts from a read drops them on its next write.
pub const RETIRED_CONFIG_KEYS: [&str; 2] = ["roster", "agents"];

/// The keys the Config reload touches (ADR-0018): the assignment slice, and the Spawn caps (ADR-0029)
/// and the Steward entry (ADR-0030) beside it. Everything else (selection, terminal, port) stays as it
/// was at boot for the life of the run.
pub const CONFIG_SLICE_KEYS: [&str; 5] = ["defaults", "assign", "resolver", "spawnCaps", "steward"];

/// A refusal or a failure whose message is the TypeScript's thrown `Error` message, verbatim: the
/// caller prints it, logs it or answers it exactly as the TypeScript did.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ConfigError(pub String);

impl ConfigError {
    pub fn new(message: impl Into<String>) -> Self {
        ConfigError(message.into())
    }
}

impl From<js::FsError> for ConfigError {
    fn from(err: js::FsError) -> Self {
        ConfigError(err.to_string())
    }
}

impl From<js::JsonParseError> for ConfigError {
    fn from(err: js::JsonParseError) -> Self {
        ConfigError(err.to_string())
    }
}

/// One pool's live config: the JSON object the TypeScript holds, in its key order. A key whose value
/// is `None` is present as JavaScript's `undefined` (a reload's slice key the file no longer has): it
/// keeps its place, reads as absent, and is never written.
#[derive(Clone, Default, PartialEq)]
pub struct PoolConfig(IndexMap<String, Option<Value>>);

impl fmt::Debug for PoolConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.to_map().fmt(f)
    }
}

impl PoolConfig {
    /// A config held as given, unchecked: what a caller builds by hand (a test, a candidate).
    pub fn from_map(map: Map<String, Value>) -> Self {
        PoolConfig(
            map.into_iter()
                .map(|(key, value)| (key, Some(value)))
                .collect(),
        )
    }

    /// The defined keys and their values, in the object's order.
    pub fn entries(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0
            .iter()
            .filter_map(|(key, value)| value.as_ref().map(|value| (key, value)))
    }

    /// The config's defined keys as a JSON object, in the object's order.
    pub fn to_map(&self) -> Map<String, Value> {
        self.entries()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    /// The config as a JSON value, as the TypeScript hands the object on (the Settings pane's
    /// `pool.config`, the snapshot's `state.config`).
    pub fn to_value(&self) -> Value {
        Value::Object(self.to_map())
    }

    /// `config[key]`: the value as the file has it, `None` when absent or undefined.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)?.as_ref()
    }

    /// The pool's selection mode: auto unless the config says human (`selectionMode`).
    pub fn selection_mode(&self) -> SelectionMode {
        if self.get("selection").and_then(Value::as_str) == Some("human") {
            SelectionMode::Human
        } else {
            SelectionMode::Auto
        }
    }

    /// The terminal backing: herdr when `config.terminal === "herdr"`, else headless.
    pub fn terminal(&self) -> Option<TerminalKind> {
        (self.terminal_text() == Some("herdr")).then_some(TerminalKind::Herdr)
    }

    /// `config.terminal` where it is a string, as `poolHarnessMode` takes it.
    pub fn terminal_text(&self) -> Option<&str> {
        self.get("terminal").and_then(Value::as_str)
    }

    /// The pinned port as written, unchecked (ports.ts judges it).
    pub fn port(&self) -> Option<&Value> {
        self.get("port")
    }

    /// The merge resolver's entry, unchecked: a harness name, "none", or `{ harness, model, effort }`.
    pub fn resolver(&self) -> Option<&Value> {
        self.get("resolver")
    }

    /// `config[key] = value`: an existing key keeps its place, a new one goes last.
    pub fn set(&mut self, key: &str, value: Value) {
        self.0.insert(key.to_owned(), Some(value));
    }

    /// `config[key] = undefined`: the key keeps (or takes, last) its place and reads as absent.
    pub fn set_undefined(&mut self, key: &str) {
        self.0.insert(key.to_owned(), None);
    }

    /// `delete config[key]`, keeping every other key in its place.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.0.shift_remove(key).flatten()
    }

    /// `JSON.stringify(config, null, 2)`: the file's text as the TypeScript writes it, without the
    /// trailing newline its writers add.
    pub fn to_pretty_json(&self) -> String {
        js::stringify_pretty(&self.to_value())
    }
}

impl Serialize for PoolConfig {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        js::JsOrdered(&self.to_value()).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PoolConfig {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Map::<String, Value>::deserialize(deserializer).map(PoolConfig::from_map)
    }
}

/// The pool's config loader, the single parser of console.json. The server consumes the same parsed
/// config it hands the engine, so the file is read and validated exactly once.
pub fn read_config(pool_dir: &str) -> Result<PoolConfig, ConfigError> {
    parse_config(read_config_text(pool_dir)?.as_deref(), pool_dir)
}

/// console.json's text, or `None` when the pool has none: what the Config reload compares against the
/// text it last considered.
pub fn read_config_text(pool_dir: &str) -> Result<Option<String>, ConfigError> {
    read_optional(&config_path(pool_dir))
}

/// Where a pool keeps its config, spelled as Node's `path.join` spells it.
pub fn config_path(pool_dir: &str) -> String {
    js::path_join(&[pool_dir, CONSOLE_JSON])
}

fn read_optional(path: &str) -> Result<Option<String>, ConfigError> {
    if !js::exists(path) {
        return Ok(None);
    }
    js::read_text(path).map(Some).map_err(ConfigError::from)
}

/// The same parse, over text the caller already has. The Console reads the file itself to key a cache
/// on its exact bytes (issue #126), and parsing that same text here is what keeps the cache key and the
/// parsed config from ever describing two different reads of the file.
pub fn parse_config(raw: Option<&str>, pool_dir: &str) -> Result<PoolConfig, ConfigError> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok(PoolConfig::default());
    };
    let mut parsed = parse_object(raw, pool_dir)?;
    if let Some(selection) = parsed.get("selection")
        && selection.as_str() != Some("auto")
        && selection.as_str() != Some("human")
    {
        return Err(ConfigError::new(
            r#"pool config: selection must be "auto" or "human""#,
        ));
    }
    if let Some(terminal) = parsed.get("terminal")
        && terminal.as_str() != Some("herdr")
    {
        return Err(ConfigError::new(r#"pool config: terminal must be "herdr""#));
    }
    check_spawn_caps(parsed.get("spawnCaps"))?;
    check_steward_config(parsed.get("steward"))?;
    for key in RETIRED_CONFIG_KEYS {
        parsed.shift_remove(key);
    }
    Ok(PoolConfig::from_map(parsed))
}

// JSON.parse, then the one shape rule both parsers share: the file is an object.
fn parse_object(raw: &str, pool_dir: &str) -> Result<Map<String, Value>, ConfigError> {
    match js::parse(raw).map_err(ConfigError::from)? {
        Value::Object(map) => Ok(map),
        _ => Err(ConfigError(format!(
            "pool config: {} must be a JSON object",
            config_path(pool_dir)
        ))),
    }
}

/// The reloadable slice of a console.json body (ADR-0018): each key as the file has it, absent when it
/// does not.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfigSlice {
    pub defaults: Option<Value>,
    pub assign: Option<Value>,
    pub resolver: Option<Value>,
    pub spawn_caps: Option<Value>,
    pub steward: Option<Value>,
}

/// Parses only the reloadable slice out of a console.json body. Deliberately does not validate
/// selection or terminal (the boot parse's job, boot-only): an edit to a field the reload never touches
/// must never block an otherwise-good edit of the slice. The caps and the Steward entry's shape are
/// checked here, since nothing downstream resolves them; the Steward's harness is checked in the dry
/// run, beside every ticket's.
pub fn parse_config_slice(raw: &str, pool_dir: &str) -> Result<ConfigSlice, ConfigError> {
    let parsed = parse_object(raw, pool_dir)?;
    check_spawn_caps(parsed.get("spawnCaps"))?;
    check_steward_config(parsed.get("steward"))?;
    Ok(ConfigSlice {
        defaults: parsed.get("defaults").cloned(),
        assign: parsed.get("assign").cloned(),
        resolver: parsed.get("resolver").cloned(),
        spawn_caps: parsed.get("spawnCaps").cloned(),
        steward: parsed.get("steward").cloned(),
    })
}

/// The config a reload would commit, `{ ...config, defaults, assign, resolver, spawnCaps, steward }`:
/// the slice's five keys taken from the file (one the file lacks set to undefined, keeping its place),
/// every other key exactly as it was at boot.
pub fn reload_candidate(config: &PoolConfig, slice: &ConfigSlice) -> PoolConfig {
    let mut candidate = config.clone();
    for (key, value) in [
        ("defaults", &slice.defaults),
        ("assign", &slice.assign),
        ("resolver", &slice.resolver),
        ("spawnCaps", &slice.spawn_caps),
        ("steward", &slice.steward),
    ] {
        match value {
            Some(value) => candidate.set(key, value.clone()),
            None => candidate.set_undefined(key),
        }
    }
    candidate
}

/// Which of the slice keys actually changed, by value as `JSON.stringify` writes it (key order
/// included): a file rewritten differently but with the same slice (say, only its port changed)
/// reloads nothing and logs nothing.
pub fn changed_slice_keys(previous: &PoolConfig, next: &PoolConfig) -> Vec<&'static str> {
    CONFIG_SLICE_KEYS
        .into_iter()
        .filter(|key| previous.get(key).map(js::stringify) != next.get(key).map(js::stringify))
        .collect()
}

/// The Steward's harness, when its entry names one, must be one the pool knows (ADR-0030): checked
/// where the harness table is, the reload's dry run, so a bad entry is refused whole like a bad assign.
pub fn check_steward_harness(
    config: &PoolConfig,
    harnesses: &Harnesses,
) -> Result<(), ConfigError> {
    let Some(harness) = config
        .get("steward")
        .and_then(|steward| steward.get("assign"))
        .and_then(|assign| assign.get("harness"))
        .and_then(Value::as_str)
        .map(js::trim)
    else {
        return Ok(());
    };
    if harness.is_empty() || harnesses.contains(harness) {
        return Ok(());
    }
    Err(ConfigError(format!(
        "pool config: steward.assign names unknown harness '{harness}'. Known: {}",
        harnesses.known()
    )))
}

/// A directory in its canonical spelling, symlinks resolved. The pool directory reaches the engine
/// however the caller spelled it, while `git rev-parse --show-toplevel` always answers with the
/// physical path, so on any pool behind a symlink the two disagree and every path derived by relating
/// one to the other lands outside the tree it was meant for. Resolved once where the pool dir enters.
/// Nothing on disk to resolve yet hands back what was given, and the caller's own read fails with its
/// own message.
pub fn canonical_dir(dir: &str) -> String {
    let target = if dir.is_empty() { "." } else { dir };
    match std::fs::canonicalize(target) {
        Ok(real) => real.to_string_lossy().into_owned(),
        Err(_) => dir.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value) -> Result<PoolConfig, ConfigError> {
        parse_config(Some(&value.to_string()), "/pool")
    }

    fn refusal(value: Value) -> String {
        parse(value).unwrap_err().0
    }

    #[test]
    fn reads_no_file_and_an_empty_file_as_no_config() {
        assert_eq!(parse_config(None, "/pool").unwrap(), PoolConfig::default());
        assert_eq!(
            parse_config(Some(""), "/pool").unwrap(),
            PoolConfig::default()
        );
    }

    #[test]
    fn keeps_every_key_in_the_file_order_but_the_retired_ones() {
        let config = parse_config(
            Some(r#"{"roster":"- deepseek","port":8787,"agents":"{}","mystery":{"kept":true},"defaults":{"harness":"claude"}}"#),
            "/pool",
        )
        .unwrap();
        assert_eq!(
            config.entries().map(|(key, _)| key).collect::<Vec<_>>(),
            ["port", "mystery", "defaults"]
        );
        assert_eq!(config.port(), Some(&json!(8787)));
    }

    #[test]
    fn refuses_a_file_that_is_not_an_object_naming_its_path() {
        for text in ["[]", "3", "\"x\"", "null"] {
            assert_eq!(
                parse_config(Some(text), "/pool/").unwrap_err().0,
                "pool config: /pool/console.json must be a JSON object"
            );
        }
        assert!(
            parse_config(Some("{ not json"), "/pool")
                .unwrap_err()
                .0
                .starts_with("JSON Parse error: ")
        );
    }

    #[test]
    fn refuses_a_selection_or_terminal_the_engine_would_not_run() {
        for selection in [json!("coin-toss"), json!(null), json!(1)] {
            assert_eq!(
                refusal(json!({ "selection": selection })),
                r#"pool config: selection must be "auto" or "human""#
            );
        }
        for terminal in [json!("tmux"), json!(null), json!(true)] {
            assert_eq!(
                refusal(json!({ "terminal": terminal })),
                r#"pool config: terminal must be "herdr""#
            );
        }
        let config = parse(json!({ "selection": "human", "terminal": "herdr" })).unwrap();
        assert_eq!(config.selection_mode(), SelectionMode::Human);
        assert_eq!(config.terminal(), Some(TerminalKind::Herdr));
    }

    #[test]
    fn refuses_malformed_spawn_caps_and_steward_entries_at_parse() {
        assert_eq!(
            refusal(json!({ "spawnCaps": { "perAttempt": -1 } })),
            "pool config: spawnCaps.perAttempt must be a whole number, 0 or more"
        );
        assert_eq!(
            refusal(json!({ "spawnCaps": { "perRun": 1.5 } })),
            "pool config: spawnCaps.perRun must be a whole number, 0 or more"
        );
        assert_eq!(
            refusal(json!({ "spawnCaps": null })),
            "pool config: spawnCaps must be an object"
        );
        assert!(refusal(json!({ "steward": { "mayClose": 1 } })).contains("steward.mayClose"));
        assert!(refusal(json!({ "steward": { "budget": 0 } })).contains("steward.budget"));
        assert_eq!(
            parse(json!({ "steward": { "budget": 4 } }))
                .unwrap()
                .get("steward"),
            Some(&json!({ "budget": 4 }))
        );
    }

    #[test]
    fn writes_back_in_javascripts_key_order_and_number_spelling() {
        let config = parse_config(
            Some(r#"{"port":8790.0,"assign":{"b":{},"10":{},"2":{"verify":2}}}"#),
            "/pool",
        )
        .unwrap();
        assert_eq!(
            config.to_pretty_json(),
            "{\n  \"port\": 8790,\n  \"assign\": {\n    \"2\": {\n      \"verify\": 2\n    },\n    \"10\": {},\n    \"b\": {}\n  }\n}"
        );
    }

    #[test]
    fn parses_the_reload_slice_without_judging_the_boot_only_keys() {
        let slice = parse_config_slice(
            r#"{"selection":"coin-toss","defaults":{"harness":"claude"},"spawnCaps":{"perRun":3}}"#,
            "/pool",
        )
        .unwrap();
        assert_eq!(slice.defaults, Some(json!({ "harness": "claude" })));
        assert_eq!(slice.spawn_caps, Some(json!({ "perRun": 3 })));
        assert_eq!(slice.assign, None);
        assert_eq!(
            parse_config_slice(r#"{"spawnCaps":{"perRun":-3}}"#, "/pool")
                .unwrap_err()
                .0,
            "pool config: spawnCaps.perRun must be a whole number, 0 or more"
        );
        assert_eq!(
            parse_config_slice("[]", "/pool").unwrap_err().0,
            "pool config: /pool/console.json must be a JSON object"
        );
    }

    #[test]
    fn takes_the_slice_into_the_candidate_and_names_what_changed() {
        let running = parse(json!({ "port": 8787, "defaults": { "harness": "claude", "model": "m" }, "selection": "human" })).unwrap();
        let slice =
            parse_config_slice(r#"{"port":9999,"assign":{"01":{"model":"x"}}}"#, "/pool").unwrap();
        let candidate = reload_candidate(&running, &slice);
        assert_eq!(
            candidate.to_value(),
            json!({ "port": 8787, "selection": "human", "assign": { "01": { "model": "x" } } })
        );
        assert_eq!(
            changed_slice_keys(&running, &candidate),
            ["defaults", "assign"]
        );
        assert!(changed_slice_keys(&running, &running.clone()).is_empty());
        // The same object with its keys in another order is a change, as JSON.stringify sees it.
        let reordered = parse(json!({ "port": 8787, "defaults": { "model": "m", "harness": "claude" }, "selection": "human" })).unwrap();
        assert_eq!(changed_slice_keys(&running, &reordered), ["defaults"]);
    }

    #[test]
    fn keeps_a_slice_key_the_file_dropped_in_its_place_as_undefined() {
        let boot = parse(json!({ "defaults": { "harness": "claude" }, "port": 8787 })).unwrap();
        let dropped = reload_candidate(
            &boot,
            &parse_config_slice(r#"{"assign":{}}"#, "/pool").unwrap(),
        );
        assert_eq!(dropped.get("defaults"), None);
        assert_eq!(dropped.to_value(), json!({ "port": 8787, "assign": {} }));
        assert_eq!(
            dropped.to_pretty_json(),
            "{\n  \"port\": 8787,\n  \"assign\": {}\n}"
        );
        assert_eq!(changed_slice_keys(&boot, &dropped), ["defaults", "assign"]);
        // Back again, it takes its old place rather than going last.
        let back = reload_candidate(
            &dropped,
            &parse_config_slice(r#"{"defaults":{"model":"m"},"assign":{}}"#, "/pool").unwrap(),
        );
        assert_eq!(
            serde_json::to_string(&back).unwrap(),
            r#"{"defaults":{"model":"m"},"port":8787,"assign":{}}"#
        );
    }

    #[test]
    fn reads_selection_and_terminal_as_the_typescript_does_and_passes_the_rest_through_raw() {
        let config = PoolConfig::from_map(
            json!({ "selection": "Human", "terminal": "tmux", "port": "8790", "resolver": null, "x": [1] })
                .as_object()
                .unwrap()
                .clone(),
        );
        assert_eq!(config.selection_mode(), SelectionMode::Auto);
        assert_eq!(config.terminal(), None);
        assert_eq!(config.terminal_text(), Some("tmux"));
        assert_eq!(config.port(), Some(&json!("8790")));
        assert_eq!(config.resolver(), Some(&Value::Null));
        assert_eq!(config.get("x"), Some(&json!([1])));
        assert_eq!(PoolConfig::default().selection_mode(), SelectionMode::Auto);
        assert_eq!(
            serde_json::from_str::<PoolConfig>(r#"{"a":1,"b":null}"#)
                .unwrap()
                .to_value(),
            json!({ "a": 1, "b": null })
        );
    }

    #[test]
    fn checks_the_stewards_harness_against_the_table() {
        let harnesses = Harnesses::defaults();
        let config = parse(json!({ "steward": { "assign": { "harness": " nope " } } })).unwrap();
        assert_eq!(
            check_steward_harness(&config, &harnesses).unwrap_err().0,
            "pool config: steward.assign names unknown harness 'nope'. Known: claude, cursor, opencode"
        );
        let known = parse(json!({ "steward": { "assign": { "harness": "claude" } } })).unwrap();
        assert!(check_steward_harness(&known, &harnesses).is_ok());
        let blank = parse(json!({ "steward": { "assign": { "harness": "  " } } })).unwrap();
        assert!(check_steward_harness(&blank, &harnesses).is_ok());
        assert!(check_steward_harness(&PoolConfig::default(), &harnesses).is_ok());
    }

    #[test]
    fn reads_the_file_from_the_pool_directory() {
        let dir = tempfile::tempdir().unwrap();
        let pool = dir.path().to_str().unwrap();
        assert_eq!(read_config(pool).unwrap(), PoolConfig::default());
        assert_eq!(read_config_text(pool).unwrap(), None);
        std::fs::write(dir.path().join("console.json"), r#"{"title":"T"}"#).unwrap();
        assert_eq!(read_config(pool).unwrap().get("title"), Some(&json!("T")));
        assert_eq!(
            read_config_text(pool).unwrap().as_deref(),
            Some(r#"{"title":"T"}"#)
        );
    }

    #[test]
    fn canonicalizes_a_directory_or_hands_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(
            canonical_dir(link.to_str().unwrap()),
            real.to_str().unwrap()
        );
        assert_eq!(canonical_dir("/no/such/dir"), "/no/such/dir");
    }
}
