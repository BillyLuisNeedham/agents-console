//! The Spawn caps (ADR-0010, made Pool settings by ADR-0029; spawn-caps.ts): how many proposals one
//! attempt (or one Conversation spawn.json) has honored, and how many Ticket-origin Spawns one run
//! adopts, a run being this Console boot. They live in console.json as `spawnCaps`, each field falling
//! back to its default on its own, and reload at the super-step boundary with the assignment slice. A
//! proposal beyond either cap is held for the operator, never dropped.

use serde_json::Value;

use crate::config::{ConfigError, PoolConfig};
use crate::js;

/// The caps in force.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpawnCaps {
    pub per_attempt: u64,
    pub per_run: u64,
}

/// 5 per attempt and 20 per run.
pub const DEFAULT_SPAWN_CAPS: SpawnCaps = SpawnCaps {
    per_attempt: 5,
    per_run: 20,
};

/// The caps in force under a config, field by field over the defaults.
pub fn spawn_caps_of(config: &PoolConfig) -> SpawnCaps {
    let field = |name: &str| {
        config
            .get("spawnCaps")
            .and_then(|caps| caps.get(name))
            .and_then(js::number_of)
            .map(|cap| cap as u64)
    };
    SpawnCaps {
        per_attempt: field("perAttempt").unwrap_or(DEFAULT_SPAWN_CAPS.per_attempt),
        per_run: field("perRun").unwrap_or(DEFAULT_SPAWN_CAPS.per_run),
    }
}

/// A console.json `spawnCaps` value, checked: absent, or an object whose fields, where present, are
/// whole numbers of zero or more. A cap of 0 is a pool that holds every proposal for the operator
/// (issue #150). Boot's parse and the boundary's reload share it, so a cap the reload would refuse
/// never boots.
pub fn check_spawn_caps(raw: Option<&Value>) -> Result<(), ConfigError> {
    let Some(raw) = raw else { return Ok(()) };
    let Value::Object(caps) = raw else {
        return Err(ConfigError::new("pool config: spawnCaps must be an object"));
    };
    for field in ["perAttempt", "perRun"] {
        if let Some(cap) = caps.get(field)
            && !is_spawn_cap(cap)
        {
            return Err(ConfigError(format!(
                "pool config: spawnCaps.{field} must be a whole number, 0 or more"
            )));
        }
    }
    Ok(())
}

/// A Spawn cap: a whole number, 0 (hold everything) or more.
pub fn is_spawn_cap(value: &Value) -> bool {
    js::is_integer(value) && js::number_of(value).is_some_and(|cap| cap >= 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(value: Value) -> PoolConfig {
        match value {
            Value::Object(map) => PoolConfig::from_map(map),
            _ => unreachable!(),
        }
    }

    #[test]
    fn falls_back_to_the_defaults_field_by_field() {
        assert_eq!(spawn_caps_of(&PoolConfig::default()), DEFAULT_SPAWN_CAPS);
        assert_eq!(
            spawn_caps_of(&config(json!({ "spawnCaps": { "perRun": 3 } }))),
            SpawnCaps {
                per_attempt: 5,
                per_run: 3
            }
        );
        assert_eq!(
            spawn_caps_of(&config(
                json!({ "spawnCaps": { "perAttempt": 0, "perRun": 0 } })
            )),
            SpawnCaps {
                per_attempt: 0,
                per_run: 0
            }
        );
    }

    #[test]
    fn takes_whole_numbers_of_zero_or_more_only() {
        assert!(check_spawn_caps(None).is_ok());
        assert!(check_spawn_caps(Some(&json!({}))).is_ok());
        assert!(check_spawn_caps(Some(&json!({ "perAttempt": 0, "perRun": 30.0 }))).is_ok());
        for bad in [json!(-1), json!(1.5), json!("3"), json!(true), json!(null)] {
            assert_eq!(
                check_spawn_caps(Some(&json!({ "perAttempt": bad })))
                    .unwrap_err()
                    .0,
                "pool config: spawnCaps.perAttempt must be a whole number, 0 or more"
            );
        }
        for bad in [json!(5), json!([]), json!(null), json!("x")] {
            assert_eq!(
                check_spawn_caps(Some(&bad)).unwrap_err().0,
                "pool config: spawnCaps must be an object"
            );
        }
    }
}
