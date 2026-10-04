//! The Steward (ADR-0030; steward.ts). So far the `steward` entry of console.json: a Pool setting
//! holding the Steward budget, the Steward's Assignment and whether it may Close, reloaded with the
//! assignment slice and the Spawn caps (Config reload). The Steward's texts and notes file join this
//! module when they are ported.

use ac_protocol::StewardAssign;
use serde_json::Value;

use crate::config::{ConfigError, PoolConfig};
use crate::js_compat;

/// The Steward budget unless the pool sets one.
pub const DEFAULT_STEWARD_BUDGET: u64 = 5;

const ASSIGN_FIELDS: [&str; 4] = ["harness", "model", "effort", "drivers"];

/// Whether the Steward may Close under a config: only while the pool says true (issue #154).
pub fn steward_may_close_of(config: &PoolConfig) -> bool {
    steward_field(config, "mayClose") == Some(&Value::Bool(true))
}

/// The Steward budget in force under a config: 5 unless the pool says otherwise.
pub fn steward_budget_of(config: &PoolConfig) -> u64 {
    steward_field(config, "budget")
        .and_then(js_compat::number_of)
        .map_or(DEFAULT_STEWARD_BUDGET, |budget| budget as u64)
}

/// The Steward's Assignment fields as the entry sets them, layered between a Steward's start request
/// and the pool defaults (conversations.ts's start resolution).
pub fn steward_assign_of(config: &PoolConfig) -> Option<StewardAssign> {
    let assign = steward_field(config, "assign")?.as_object()?;
    let field = |name: &str| assign.get(name).and_then(Value::as_str).map(str::to_owned);
    Some(StewardAssign {
        harness: field("harness"),
        model: field("model"),
        effort: field("effort"),
        drivers: field("drivers"),
    })
}

fn steward_field<'a>(config: &'a PoolConfig, name: &str) -> Option<&'a Value> {
    config.get("steward")?.get(name)
}

/// A Steward budget: a whole number, 1 or more.
pub fn is_steward_budget(value: &Value) -> bool {
    js_compat::is_integer(value) && js_compat::number_of(value).is_some_and(|budget| budget >= 1.0)
}

/// A console.json `steward` value, checked for shape: absent, or an object whose budget, where
/// present, is a whole number of 1 or more, whose assign, where present, is an object of strings, and
/// whose mayClose, where present, is a boolean. Boot's parse and the boundary's reload share it, so a
/// value the reload would refuse never boots. Whether the assign names a harness the pool knows is the
/// caller's check (`config::check_steward_harness`): only the engine has the harness table.
pub fn check_steward_config(raw: Option<&Value>) -> Result<(), ConfigError> {
    let Some(raw) = raw else { return Ok(()) };
    let Value::Object(steward) = raw else {
        return Err(ConfigError::new("pool config: steward must be an object"));
    };
    if let Some(budget) = steward.get("budget")
        && !is_steward_budget(budget)
    {
        return Err(ConfigError::new(
            "pool config: steward.budget must be a whole number, 1 or more",
        ));
    }
    if let Some(may_close) = steward.get("mayClose")
        && !may_close.is_boolean()
    {
        return Err(ConfigError::new(
            "pool config: steward.mayClose must be true or false",
        ));
    }
    if let Some(assign) = steward.get("assign") {
        let Value::Object(assign) = assign else {
            return Err(ConfigError::new(
                "pool config: steward.assign must be an object",
            ));
        };
        for field in ASSIGN_FIELDS {
            if let Some(value) = assign.get(field)
                && !value.is_string()
            {
                return Err(ConfigError(format!(
                    "pool config: steward.assign.{field} must be a string"
                )));
            }
        }
    }
    Ok(())
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

    fn refusal(value: Value) -> String {
        check_steward_config(Some(&value)).unwrap_err().0
    }

    // steward.test.ts: the steward entry of console.json
    #[test]
    fn defaults_the_budget_to_5_and_reads_one_that_is_set() {
        assert_eq!(steward_budget_of(&PoolConfig::default()), 5);
        assert_eq!(
            steward_budget_of(&config(json!({ "steward": { "budget": 2 } }))),
            2
        );
    }

    #[test]
    fn refuses_a_budget_that_is_not_a_whole_number_of_1_or_more_and_an_assign_that_is_not_strings()
    {
        assert_eq!(
            refusal(json!({ "budget": 0 })),
            "pool config: steward.budget must be a whole number, 1 or more"
        );
        assert!(refusal(json!({ "budget": 1.5 })).contains("steward.budget"));
        assert!(refusal(json!({ "budget": "3" })).contains("steward.budget"));
        assert!(refusal(json!({ "budget": null })).contains("steward.budget"));
        assert_eq!(
            refusal(json!({ "assign": { "model": 4 } })),
            "pool config: steward.assign.model must be a string"
        );
        assert_eq!(
            refusal(json!({ "assign": [] })),
            "pool config: steward.assign must be an object"
        );
        assert_eq!(
            refusal(json!("x")),
            "pool config: steward must be an object"
        );
        assert!(check_steward_config(None).is_ok());
        assert!(
            check_steward_config(Some(&json!({ "budget": 3, "assign": { "model": "m" } }))).is_ok()
        );
    }

    #[test]
    fn reads_may_close_as_off_unless_it_is_true_and_refuses_one_that_is_not_a_boolean() {
        assert!(!steward_may_close_of(&PoolConfig::default()));
        assert!(!steward_may_close_of(&config(
            json!({ "steward": { "budget": 2 } })
        )));
        assert!(!steward_may_close_of(&config(
            json!({ "steward": { "mayClose": false } })
        )));
        assert!(steward_may_close_of(&config(
            json!({ "steward": { "mayClose": true } })
        )));
        assert_eq!(
            refusal(json!({ "mayClose": "yes" })),
            "pool config: steward.mayClose must be true or false"
        );
        assert!(check_steward_config(Some(&json!({ "budget": 2, "mayClose": true }))).is_ok());
    }

    #[test]
    fn reads_the_stewards_assignment_fields() {
        assert_eq!(steward_assign_of(&PoolConfig::default()), None);
        assert_eq!(
            steward_assign_of(&config(
                json!({ "steward": { "assign": { "model": "judge", "harness": "claude" } } })
            )),
            Some(StewardAssign {
                harness: Some("claude".into()),
                model: Some("judge".into()),
                effort: None,
                drivers: None,
            })
        );
    }
}
