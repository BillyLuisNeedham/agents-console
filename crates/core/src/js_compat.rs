//! JavaScript's and Node's own spellings that the config, settings, Machine defaults, fleet and
//! Assignment modules reproduce: `JSON.parse` and `JSON.stringify` (with JavaScript's object key order
//! and number printing), `String()`, `Number.isInteger`, `String.prototype.trim`, the default
//! `Array.prototype.sort`, `path.join`, and the text of a failed `fs` call as Bun throws it.
//!
//! A private copy until `ac_core::js` lands (formats-a); the herdr client (`ac_io::herdr::js`) and the
//! git edge (`ac_io::git::node`) hold their own copies of some of these for the same reason.

use std::cmp::Ordering;
use std::io;

use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};
use serde_json::{Map, Number, Value};

/// `JSON.parse(text)`. The message is the parser's own words and no case pins them; it opens as
/// JavaScriptCore's does.
pub(crate) fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|err| format!("JSON Parse error: {err}"))
}

/// `JSON.stringify(value)`.
pub(crate) fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub(crate) fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value, Some(2), 0);
    out
}

fn write_json(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&json_number(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_json(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push(']');
        }
        Value::Object(fields) => {
            if fields.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (at, (key, item)) in object_entries(fields).into_iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_json(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push('}');
        }
    }
}

fn newline(out: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(width) = indent {
        out.push('\n');
        out.push_str(&" ".repeat(width * depth));
    }
}

// serde_json escapes a string exactly as JSON.stringify does: the quote, the backslash, the five short
// escapes, other control characters as lowercase `\u00xx`, and everything else as itself.
fn write_string(out: &mut String, text: &str) {
    out.push_str(&serde_json::to_string(text).unwrap_or_default());
}

/// A JSON value serialized as JavaScript's `JSON.stringify` would write it, through any serde
/// serializer: every object's keys in JavaScript's order, every whole number without a fraction.
pub(crate) struct JsOrdered<'a>(pub(crate) &'a Value);

impl Serialize for JsOrdered<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Value::Number(number) => match number.as_f64() {
                Some(value) if value.is_finite() => number_value(value).serialize(serializer),
                _ => serializer.serialize_unit(),
            },
            Value::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(&JsOrdered(item))?;
                }
                seq.end()
            }
            Value::Object(fields) => {
                let mut map = serializer.serialize_map(Some(fields.len()))?;
                for (key, item) in object_entries(fields) {
                    map.serialize_entry(key, &JsOrdered(item))?;
                }
                map.end()
            }
            other => other.serialize(serializer),
        }
    }
}

/// An object's entries in JavaScript's own order: the keys that are array indices first, ascending,
/// then every other key in the order it was added. `JSON.parse` and every object literal order keys
/// this way, so a file read and written back by the TypeScript comes out in it.
pub(crate) fn object_entries(fields: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indices: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut others: Vec<(&String, &Value)> = Vec::new();
    for entry in fields {
        match array_index(entry.0) {
            Some(index) => indices.push((index, entry)),
            None => others.push(entry),
        }
    }
    indices.sort_by_key(|(index, _)| *index);
    indices
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(others)
        .collect()
}

/// A canonical array index: "0", or digits with no leading zero, below 2^32 - 1.
pub(crate) fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let index: u64 = key.parse().ok()?;
    (index < u64::from(u32::MAX)).then_some(index as u32)
}

fn json_number(number: &Number) -> String {
    let value = number.as_f64().unwrap_or(f64::NAN);
    // JSON.stringify writes NaN and the infinities as null; a parsed number is never either.
    if !value.is_finite() {
        return "null".to_owned();
    }
    number_string(value)
}

/// A number as JavaScript's `Number.prototype.toString()` prints it: the shortest digits that read
/// back as the same double, plain from 1e-6 up to 1e21 and in exponent form beyond, no trailing `.0`.
pub(crate) fn number_string(value: f64) -> String {
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

/// `String(value)`, as a template literal coerces a value it interpolates.
pub(crate) fn string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        // Array.prototype.join: null and undefined elements print as nothing.
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => string_of(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// The value as a JavaScript number, when it is one.
pub(crate) fn number_of(value: &Value) -> Option<f64> {
    value.as_number().and_then(Number::as_f64)
}

/// JavaScript's `Number(text)`: trimmed, empty is 0, `0x`, `0o` and `0b` integers, signed decimals with
/// an exponent, `Infinity`, and NaN for anything else.
pub(crate) fn number_from_text(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = match text.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &text[2..];
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut value = 0.0_f64;
        for c in digits.chars() {
            match c.to_digit(radix) {
                Some(d) => value = value * f64::from(radix) + f64::from(d),
                None => return f64::NAN,
            }
        }
        return value;
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // Rust's float grammar is JavaScript's decimal literal once its words (inf, nan) are kept out.
    if !text
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E'))
    {
        return f64::NAN;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// A JavaScript number as a JSON value: a whole number as an integer, so it prints without a fraction
/// in either serializer.
pub(crate) fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        if value >= 0.0 {
            return Value::from(value as u64);
        }
        return Value::from(value as i64);
    }
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// `Number.isInteger(value)`.
pub(crate) fn is_integer(value: &Value) -> bool {
    number_of(value).is_some_and(|n| n.is_finite() && n.fract() == 0.0)
}

/// `String.prototype.trim()`: JavaScript's whitespace is not Rust's, it strips U+FEFF and keeps U+0085.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// A character JavaScript's `trim()` and the regular expression `\s` both count as whitespace.
pub(crate) fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// The default `Array.prototype.sort()` of strings: by UTF-16 code units.
pub(crate) fn sort_strings(items: &mut [String]) {
    items.sort_by(|a, b| utf16_cmp(a, b));
}

fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Node's `path.join` for POSIX paths: the non-empty parts joined with `/`, then normalized (`.` and
/// `..` resolved, repeated separators collapsed, a trailing separator kept).
pub(crate) fn path_join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        return ".".to_owned();
    }
    let absolute = joined.starts_with('/');
    let trailing = joined.ends_with('/');
    let mut kept: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if kept.last().is_some_and(|last| *last != "..") {
                    kept.pop();
                } else if !absolute {
                    kept.push("..");
                }
            }
            other => kept.push(other),
        }
    }
    let mut normalized = kept.join("/");
    if normalized.is_empty() {
        return match (absolute, trailing) {
            (true, _) => "/".to_owned(),
            (false, true) => "./".to_owned(),
            (false, false) => ".".to_owned(),
        };
    }
    if trailing {
        normalized.push('/');
    }
    if absolute {
        format!("/{normalized}")
    } else {
        normalized
    }
}

/// Node's `path.basename(path)` for POSIX paths: the last segment, trailing separators ignored.
pub(crate) fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "";
    }
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// `readFileSync(path, "utf8")`: the bytes decoded, a malformed sequence read as U+FFFD; a failure
/// spelled as Bun spells it.
pub(crate) fn read_text(path: &str) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(err) => Err(read_error(&err, path)),
    }
}

/// `existsSync(path)`: false for anything that cannot be stat'd, a dangling link included.
pub(crate) fn exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

fn read_error(err: &io::Error, path: &str) -> String {
    // Reading a directory fails at read(2), after the open succeeded, and Bun names no path for it.
    if err.raw_os_error() == Some(libc::EISDIR) {
        return "EISDIR: illegal operation on a directory, read".to_owned();
    }
    fs_error(err, "open", path)
}

/// The message Bun's `fs` throws for a failed call on one path: `ENOENT: no such file or directory,
/// open '<path>'`.
pub(crate) fn fs_error(err: &io::Error, syscall: &str, path: &str) -> String {
    match errno_text(err) {
        Some((code, description)) => format!("{code}: {description}, {syscall} '{path}'"),
        None => err.to_string(),
    }
}

/// The message Bun's `renameSync` throws: `ENOENT: no such file or directory, rename '<from>' -> '<to>'`.
pub(crate) fn rename_error(err: &io::Error, from: &str, to: &str) -> String {
    match errno_text(err) {
        Some((code, description)) => format!("{code}: {description}, rename '{from}' -> '{to}'"),
        None => err.to_string(),
    }
}

// The error's code and libuv's description of it, as Bun's fs errors spell them.
fn errno_text(err: &io::Error) -> Option<(&'static str, &'static str)> {
    let text = match err.raw_os_error()? {
        libc::EPERM => ("EPERM", "operation not permitted"),
        libc::ENOENT => ("ENOENT", "no such file or directory"),
        libc::EIO => ("EIO", "i/o error"),
        libc::EBADF => ("EBADF", "bad file descriptor"),
        libc::EAGAIN => ("EAGAIN", "resource temporarily unavailable"),
        libc::ENOMEM => ("ENOMEM", "not enough memory"),
        libc::EACCES => ("EACCES", "permission denied"),
        libc::EBUSY => ("EBUSY", "resource busy or locked"),
        libc::EEXIST => ("EEXIST", "file already exists"),
        libc::EXDEV => ("EXDEV", "cross-device link not permitted"),
        libc::ENOTDIR => ("ENOTDIR", "not a directory"),
        libc::EISDIR => ("EISDIR", "illegal operation on a directory"),
        libc::EINVAL => ("EINVAL", "invalid argument"),
        libc::ENFILE => ("ENFILE", "file table overflow"),
        libc::EMFILE => ("EMFILE", "too many open files"),
        libc::EFBIG => ("EFBIG", "file too large"),
        libc::ENOSPC => ("ENOSPC", "no space left on device"),
        libc::EROFS => ("EROFS", "read-only file system"),
        libc::ENAMETOOLONG => ("ENAMETOOLONG", "name too long"),
        libc::ENOTEMPTY => ("ENOTEMPTY", "directory not empty"),
        libc::ELOOP => ("ELOOP", "too many symbolic links encountered"),
        _ => return None,
    };
    Some(text)
}

/// `writeFileSync(tmp, text)` then `renameSync(tmp, path)`: a file replaced whole, so a reader never
/// sees half of it. Each failure is spelled as Bun spells it.
pub(crate) fn write_via_rename(path: &str, tmp: &str, text: &str) -> Result<(), String> {
    std::fs::write(tmp, text).map_err(|err| fs_error(&err, "open", tmp))?;
    std::fs::rename(tmp, path).map_err(|err| rename_error(&err, tmp, path))
}

/// `mkdirSync(dir, { recursive: true })`.
pub(crate) fn mkdir_all(dir: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| fs_error(&err, "mkdir", dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stringifies_as_json_stringify_does() {
        let value = parse(
            r#"{"b":1.0,"2":"x","a":[1e21,0.5,null,true],"10":{},"01":[],"e":{"1":2,"z":3}}"#,
        )
        .unwrap();
        assert_eq!(
            stringify(&value),
            r#"{"2":"x","10":{},"b":1,"a":[1e+21,0.5,null,true],"01":[],"e":{"1":2,"z":3}}"#
        );
        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"2\": \"x\",\n  \"10\": {},\n  \"b\": 1,\n  \"a\": [\n    1e+21,\n    0.5,\n    null,\n    true\n  ],\n  \"01\": [],\n  \"e\": {\n    \"1\": 2,\n    \"z\": 3\n  }\n}"
        );
        assert_eq!(stringify_pretty(&json!({})), "{}");
        assert_eq!(stringify_pretty(&json!([])), "[]");
        assert_eq!(stringify(&json!("a\"b\u{1b}\n")), r#""a\"b\u001b\n""#);
    }

    #[test]
    fn serializes_through_serde_as_json_stringify_writes() {
        let value = parse(r#"{"b":1.0,"2":[{"z":0.5,"1":-0.0}],"a":1e21}"#).unwrap();
        assert_eq!(
            serde_json::to_string(&JsOrdered(&value)).unwrap(),
            r#"{"2":[{"1":0,"z":0.5}],"b":1,"a":1e+21}"#
        );
    }

    #[test]
    fn keeps_the_last_of_a_duplicated_key_where_the_first_stood() {
        let value = parse(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(stringify(&value), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn coerces_as_string_does() {
        assert_eq!(string_of(&json!(5)), "5");
        assert_eq!(string_of(&json!(2.5)), "2.5");
        assert_eq!(string_of(&json!(true)), "true");
        assert_eq!(string_of(&json!(null)), "null");
        assert_eq!(string_of(&json!(["a", null, 1])), "a,,1");
        assert_eq!(string_of(&json!({"a": 1})), "[object Object]");
    }

    #[test]
    fn tells_integers_as_number_is_integer_does() {
        assert!(is_integer(&json!(3)));
        assert!(is_integer(&json!(3.0)));
        assert!(is_integer(&json!(-1)));
        assert!(!is_integer(&json!(2.5)));
        assert!(!is_integer(&json!("3")));
        assert!(!is_integer(&json!(true)));
    }

    #[test]
    fn sorts_and_joins_as_javascript_does() {
        let mut names = vec![
            "opencode".to_owned(),
            "claude".to_owned(),
            "Zed".to_owned(),
            "cursor".to_owned(),
        ];
        sort_strings(&mut names);
        assert_eq!(names, ["Zed", "claude", "cursor", "opencode"]);
        assert_eq!(path_join(&["/pool", "console.json"]), "/pool/console.json");
        assert_eq!(path_join(&["/pool/", "console.json"]), "/pool/console.json");
        assert_eq!(path_join(&["./pool", "console.json"]), "pool/console.json");
        assert_eq!(
            path_join(&["/home", ".agent-graphs", "defaults.json"]),
            "/home/.agent-graphs/defaults.json"
        );
        assert_eq!(basename("/repos/my-pool/"), "my-pool");
        assert_eq!(basename("pool"), "pool");
    }

    #[test]
    fn trims_javascript_whitespace() {
        assert_eq!(trim("  \t title \n"), "title");
        assert_eq!(trim("\u{feff}title\u{a0}"), "title");
        assert_eq!(trim("\u{85}title\u{85}"), "\u{85}title\u{85}");
    }
}
