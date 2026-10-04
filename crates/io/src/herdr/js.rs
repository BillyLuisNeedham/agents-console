//! JavaScript's own spellings where the herdr client turns data into visible text: `JSON.stringify` of a
//! parsed daemon answer, `String()` of a value, a number as JavaScript prints it, `String.prototype.trim`
//! and lengths counted in UTF-16 code units. The TypeScript client leaned on these without saying so, and
//! its error texts and tab labels must read the same from Rust.

use serde_json::{Number, Value};

/// `JSON.stringify(value)` of a parsed daemon answer, where `None` is JavaScript's `undefined` (an answer
/// line with no `result`), which a template literal prints as `undefined`.
pub(super) fn stringify(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(value) => {
            let mut out = String::new();
            write_json(&mut out, value);
            out
        }
    }
}

/// `String(value)` for a primitive, `JSON.stringify(value)` for an object or array: how the client spells
/// a daemon's error body inside `<method> failed: <detail>`.
pub(super) fn detail(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(number),
        Value::String(text) => text.clone(),
        Value::Array(_) | Value::Object(_) => stringify(Some(value)),
    }
}

fn write_json(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number_text(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Value::Object(fields) => {
            out.push('{');
            for (at, (key, item)) in fields.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_json(out, item);
            }
            out.push('}');
        }
    }
}

// serde_json escapes a string exactly as JSON.stringify does: the quote, the backslash, the five short
// escapes, other control characters as lowercase `\u00xx`, and everything else as itself.
fn write_string(out: &mut String, text: &str) {
    out.push_str(&serde_json::to_string(text).unwrap_or_default());
}

fn number_text(number: &Number) -> String {
    number_string(number.as_f64().unwrap_or(f64::NAN))
}

/// A number as JavaScript's `Number.prototype.toString()` prints it (ECMAScript's Number::toString): the
/// shortest digits that read back as the same double, plain from 1e-6 up to 1e21 and in exponent form
/// (`1e+21`, `1.5e-7`) beyond, with no trailing `.0`.
pub(super) fn number_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // Rust's shortest round-trip digits, in scientific form: `1.2345e3`, `1e21`, `5e-324`.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let power = n - 1;
        let power_sign = if power >= 0 { "+" } else { "-" };
        let lead = if k == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{lead}e{power_sign}{}", power.abs())
    };
    format!("{sign}{body}")
}

/// `String.prototype.trim()`: JavaScript's whitespace is Rust's less U+0085 and plus U+FEFF.
pub(super) fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// `text.length`: JavaScript counts UTF-16 code units, so a character beyond the Basic Multilingual Plane
/// counts two.
pub(super) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, max)` in UTF-16 code units. JavaScript would cut a surrogate pair in half and keep the
/// lone high surrogate, which no Rust string can hold, so a pair straddling the cut is dropped whole.
pub(super) fn utf16_prefix(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &text[..at];
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prints_numbers_as_javascript_does() {
        for (value, printed) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-32000.0, "-32000"),
            (100.0, "100"),
            (0.1, "0.1"),
            (0.6, "0.6"),
            (123.456, "123.456"),
            (0.000001, "0.000001"),
            (0.0000015, "0.0000015"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (1.5e300, "1.5e+300"),
            (123456789012345680000.0, "123456789012345680000"),
            (9007199254740993.0, "9007199254740992"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ] {
            assert_eq!(number_string(value), printed, "{value:e}");
        }
    }

    #[test]
    fn stringifies_answers_as_json_stringify_does() {
        let answer: Value = serde_json::from_str(
            r#"{"type":"tab_created","tab":{"tab_id":"w7:t1","n":1.0,"big":1e21},"list":[null,true,"a\"b\u001b"]}"#,
        )
        .unwrap();
        assert_eq!(
            stringify(Some(&answer)),
            r#"{"type":"tab_created","tab":{"tab_id":"w7:t1","n":1,"big":1e+21},"list":[null,true,"a\"b\u001b"]}"#
        );
        assert_eq!(stringify(None), "undefined");
        assert_eq!(stringify(Some(&Value::Null)), "null");
    }

    #[test]
    fn spells_an_error_body_as_the_client_does() {
        assert_eq!(
            detail(&json!({"code": -1, "message": "daemon says no"})),
            r#"{"code":-1,"message":"daemon says no"}"#
        );
        assert_eq!(detail(&json!("refused")), "refused");
        assert_eq!(detail(&json!(null)), "null");
        assert_eq!(detail(&json!(false)), "false");
        assert_eq!(detail(&json!(7)), "7");
        assert_eq!(detail(&json!(["a", 1])), r#"["a",1]"#);
    }

    #[test]
    fn trims_javascript_whitespace() {
        assert_eq!(trim("  \t title \n"), "title");
        assert_eq!(trim("\u{feff}title\u{a0}"), "title");
        assert_eq!(trim("\u{85}title\u{85}"), "\u{85}title\u{85}");
    }

    #[test]
    fn counts_and_cuts_in_utf16_units() {
        assert_eq!(utf16_len("01 · x"), 6);
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_prefix("abcdef", 3), "abc");
        assert_eq!(utf16_prefix("ab😀c", 4), "ab😀");
        assert_eq!(utf16_prefix("ab😀c", 3), "ab");
        assert_eq!(utf16_prefix("abc", 10), "abc");
    }
}
