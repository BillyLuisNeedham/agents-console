//! The pool's config file, `console.json` (engine.ts from `readConfig` to the end): its one parser, the
//! keys the engine retired, the Config reload's slice of it, and the canonical spelling of the pool
//! directory it is read from.
//!
//! The parsed config is the file's own JSON object, unknown keys and all, exactly as the TypeScript
//! holds it after `JSON.parse`: the parse checks only `selection`, `terminal`, `spawnCaps` and
//! `steward`, and every other key is read where it is used, as leniently as the TypeScript reads it.
//! `ac_protocol::PoolConfig` is the same file's declared shape for the wire; this is the file.
//!
//! `repoRootOf` runs git, so it lives with the git edge: `ac_io::git::repo_root_of`.

use std::fmt;

use ac_protocol::{SelectionMode, TerminalKind};
use serde_json::{Map, Value};

use crate::harness::Harnesses;
use crate::js_compat;
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

/// One pool's console.json as parsed: the file's own object with the retired keys left out, every
/// other key in the order the file has it. An absent or empty file is the empty config.
#[derive(Clone, Default, PartialEq)]
pub struct PoolConfig(Map<String, Value>);

impl fmt::Debug for PoolConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl PoolConfig {
    /// A config held as given, unchecked: what a caller builds by hand (a test, a candidate).
    pub fn from_map(map: Map<String, Value>) -> Self {
        PoolConfig(map)
    }

    /// The config's object, in the file's order.
    pub fn as_map(&self) -> &Map<String, Value> {
        &self.0
    }

    pub fn into_map(self) -> Map<String, Value> {
        self.0
    }

    /// The config as a JSON value, as the TypeScript hands the parsed object on (the Settings pane's
    /// `pool.config`).
    pub fn to_value(&self) -> Value {
        Value::Object(self.0.clone())
    }

    /// One top-level key's value as the file has it: `config[key]`.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// The merge resolver's entry: a harness name, "none", or `{ harness, model, effort }`, unchecked.
    pub fn resolver(&self) -> Option<&Value> {
        self.get("resolver")
    }

    /// The pinned port as written, unchecked (ports.ts judges it).
    pub fn port(&self) -> Option<&Value> {
        self.get("port")
    }

    /// Who picks the winner of a verify fan-out, when the file says (the parse refuses anything else).
    pub fn selection(&self) -> Option<SelectionMode> {
        match self.get("selection")?.as_str()? {
            "auto" => Some(SelectionMode::Auto),
            "human" => Some(SelectionMode::Human),
            _ => None,
        }
    }

    /// The terminal backing, when the file names one (the parse refuses anything but "herdr").
    pub fn terminal(&self) -> Option<TerminalKind> {
        (self.get("terminal")?.as_str()? == "herdr").then_some(TerminalKind::Herdr)
    }

    /// `config.terminal` as JavaScript reads it: absent, or the string the file holds.
    pub fn terminal_text(&self) -> Option<&str> {
        self.get("terminal").and_then(Value::as_str)
    }

    /// `config[key] = value`: an existing key keeps its place, a new one goes last.
    pub fn set(&mut self, key: &str, value: Value) {
        self.0.insert(key.to_owned(), value);
    }

    /// `delete config[key]`, keeping every other key in its place.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.0.shift_remove(key)
    }

    /// `JSON.stringify(config, null, 2)`: the file's text as the TypeScript writes it, without the
    /// trailing newline its writers add.
    pub fn to_pretty_json(&self) -> String {
        js_compat::stringify_pretty(&Value::Object(self.0.clone()))
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
    js_compat::path_join(&[pool_dir, CONSOLE_JSON])
}

fn read_optional(path: &str) -> Result<Option<String>, ConfigError> {
    if !js_compat::exists(path) {
        return Ok(None);
    }
    js_compat::read_text(path).map(Some).map_err(ConfigError)
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
    Ok(PoolConfig(parsed))
}

// JSON.parse, then the one shape rule both parsers share: the file is an object.
fn parse_object(raw: &str, pool_dir: &str) -> Result<Map<String, Value>, ConfigError> {
    match js_compat::parse(raw).map_err(ConfigError)? {
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

/// The config a reload would commit: the running config with the slice's five keys taken from the
/// file, every other key exactly as it was at boot.
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
            None => {
                candidate.remove(key);
            }
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
        .filter(|key| {
            previous.get(key).map(js_compat::stringify) != next.get(key).map(js_compat::stringify)
        })
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
        .map(js_compat::trim)
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
            config.as_map().keys().collect::<Vec<_>>(),
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
        assert_eq!(config.selection(), Some(SelectionMode::Human));
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
