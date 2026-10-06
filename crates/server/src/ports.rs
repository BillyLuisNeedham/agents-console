//! Pool port resolution (ports.ts). The order at boot is: the --port CLI flag wins, then the
//! console.json pin, then the default 8787-or-next-free. A port that is pinned (by flag or config) must
//! bind exactly, or boot fails loudly naming the port; only the unpinned path hunts for a free port. Port
//! 0 means "any free port", the system's ephemeral pick, and is never a pin.

use serde_json::Value;

use ac_core::js;

/// Where the unpinned hunt starts.
pub const DEFAULT_PORT: f64 = 8787.0;

/// The port to bind and whether it is a pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortResolution {
    pub port: u16,
    pub pinned: bool,
}

/// A port must be an integer in 0-65535. Port 0 means "any free port". The refusal prints the value as
/// a template literal would (`NaN`, `1.5`, `-1`).
pub fn valid_port(value: f64, source: &str) -> Result<u16, String> {
    if !value.is_finite() || value.fract() != 0.0 || !(0.0..=65535.0).contains(&value) {
        return Err(port_refusal(source, &js::number_string(value)));
    }
    Ok(value as u16)
}

// The pin as console.json has it: a number goes through `valid_port`, anything else is refused,
// printed as `String(value)` prints it.
fn valid_config_port(value: &Value) -> Result<u16, String> {
    match js::number_of(value) {
        Some(number) => valid_port(number, "console.json"),
        None => Err(port_refusal("console.json", &js::string_of(value))),
    }
}

fn port_refusal(source: &str, got: &str) -> String {
    format!("{source}: port must be an integer 0-65535, got {got}")
}

/// The port this server binds: the flag, else console.json's `port`, else the hunt from
/// `default_port`. Each pin is validated where it comes from, and refused with its source named.
pub fn resolve_port(
    cli_port: Option<f64>,
    config_port: Option<&Value>,
    default_port: f64,
) -> Result<PortResolution, String> {
    if let Some(cli) = cli_port {
        let port = valid_port(cli, "--port")?;
        return Ok(PortResolution {
            port,
            pinned: port != 0,
        });
    }
    if let Some(config) = config_port {
        let port = valid_config_port(config)?;
        return Ok(PortResolution {
            port,
            pinned: port != 0,
        });
    }
    Ok(PortResolution {
        port: valid_port(default_port, "default port")?,
        pinned: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_flag_wins_then_the_pin_then_the_default() {
        assert_eq!(
            resolve_port(Some(9001.0), Some(&json!(8788)), DEFAULT_PORT),
            Ok(PortResolution {
                port: 9001,
                pinned: true
            })
        );
        assert_eq!(
            resolve_port(None, Some(&json!(8788)), DEFAULT_PORT),
            Ok(PortResolution {
                port: 8788,
                pinned: true
            })
        );
        assert_eq!(
            resolve_port(None, None, DEFAULT_PORT),
            Ok(PortResolution {
                port: 8787,
                pinned: false
            })
        );
    }

    // ports.test.ts:23
    #[test]
    fn an_explicit_default_overrides_8787_for_the_unpinned_hunt() {
        assert_eq!(
            resolve_port(None, None, 9100.0),
            Ok(PortResolution {
                port: 9100,
                pinned: false
            })
        );
    }

    #[test]
    fn port_0_is_never_a_pin_and_the_flag_wins_even_at_0() {
        assert_eq!(
            resolve_port(Some(0.0), Some(&json!(8788)), DEFAULT_PORT),
            Ok(PortResolution {
                port: 0,
                pinned: false
            })
        );
        assert_eq!(
            resolve_port(None, Some(&json!(0)), DEFAULT_PORT),
            Ok(PortResolution {
                port: 0,
                pinned: false
            })
        );
    }

    #[test]
    fn refuses_non_integers_and_out_of_range_values_naming_the_source() {
        for (value, text) in [
            (-1.0, "-1"),
            (65536.0, "65536"),
            (1.5, "1.5"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
        ] {
            assert_eq!(
                resolve_port(Some(value), None, DEFAULT_PORT),
                Err(format!(
                    "--port: port must be an integer 0-65535, got {text}"
                ))
            );
        }
        assert_eq!(
            resolve_port(None, Some(&json!("8788")), DEFAULT_PORT),
            Err("console.json: port must be an integer 0-65535, got 8788".to_owned())
        );
        assert_eq!(
            resolve_port(None, Some(&json!(null)), DEFAULT_PORT),
            Err("console.json: port must be an integer 0-65535, got null".to_owned())
        );
        assert_eq!(
            resolve_port(None, Some(&json!(65535)), DEFAULT_PORT)
                .unwrap()
                .port,
            65535
        );
    }
}
