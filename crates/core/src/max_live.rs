use serde_json::Value;

use crate::config::{ConfigError, PoolConfig};
use crate::js;

/// The pool's own `maxLive` (ADR-0040), `None` when it sets none and the Machine default applies.
pub fn max_live_of(config: &PoolConfig) -> Option<u64> {
    max_live_value(config.get("maxLive"))
}

/// A `maxLive` as a file holds it, when it is one.
pub fn max_live_value(raw: Option<&Value>) -> Option<u64> {
    raw.filter(|value| is_max_live(value))
        .and_then(js::number_of)
        .map(|max| max as u64)
}

pub fn check_max_live(raw: Option<&Value>) -> Result<(), ConfigError> {
    match raw {
        Some(value) if !is_max_live(value) => Err(ConfigError::new(
            "pool config: maxLive must be a whole number, 1 or more",
        )),
        _ => Ok(()),
    }
}

/// A `maxLive`: a whole number, 1 or more. 0 would never launch anything, so it is refused.
pub fn is_max_live(value: &Value) -> bool {
    js::is_integer(value) && js::number_of(value).is_some_and(|max| max >= 1.0)
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
    fn reads_the_pools_own_bound_and_none_when_it_sets_none() {
        assert_eq!(max_live_of(&PoolConfig::default()), None);
        assert_eq!(max_live_of(&config(json!({ "maxLive": 3 }))), Some(3));
        assert_eq!(max_live_of(&config(json!({ "maxLive": 2.0 }))), Some(2));
        assert_eq!(
            max_live_of(&config(json!({ "maxLive": 1e300 }))),
            Some(u64::MAX)
        );
    }

    #[test]
    fn takes_whole_numbers_of_one_or_more_only() {
        assert!(check_max_live(None).is_ok());
        assert!(check_max_live(Some(&json!(1))).is_ok());
        assert!(check_max_live(Some(&json!(40.0))).is_ok());
        for bad in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("3"),
            json!(true),
            json!(null),
        ] {
            assert_eq!(
                check_max_live(Some(&bad)).unwrap_err().0,
                "pool config: maxLive must be a whole number, 1 or more",
                "{bad}"
            );
        }
    }
}
