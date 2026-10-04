//! JavaScript's own spellings, for every port module whose output the TypeScript produced through them:
//! `new Date().toISOString()`, `String(n)` of a number, `JSON.stringify` (compact and with two-space
//! indent), `JSON.parse`, `String.prototype.trim` and the `\s` of a regular expression, string lengths
//! and cuts in UTF-16 code units, `encodeURIComponent` and `decodeURIComponent`, a replacement string's
//! `$` patterns, `TextDecoder` fed chunk by chunk, `readFileSync(path, "utf8")`, and the text of a failed
//! `fs` call as Bun throws it. The TypeScript leaned on these without saying so, and a file, a log line
//! or an error must read the same from Rust.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::fmt;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Map, Number, Value};

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/// `new Date().toISOString()`: UTC, millisecond precision, `Z` (`2026-10-04T09:30:21.394Z`).
pub fn now_iso() -> String {
    iso_of(SystemTime::now())
}

/// `new Date(time).toISOString()` for a time the system gave: cut to the millisecond, as a `Date`
/// holds it.
pub fn iso_of(time: SystemTime) -> String {
    let ms = match time.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    };
    iso_of_millis(ms)
}

/// `new Date(ms).toISOString()` for a float count of milliseconds (a `stat`'s `mtimeMs`): the
/// fraction is cut toward zero, as a `Date` does.
pub fn iso_of_ms(ms: f64) -> String {
    iso_of_millis(ms.trunc() as i64)
}

fn iso_of_millis(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// A `stat`'s `mtimeMs`: the modification time in milliseconds since the epoch, with its fraction.
pub fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1_000_000.0
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/// A number as JavaScript's `String(n)` prints it (ECMAScript's Number::toString): the shortest
/// digits that read back as the same double, plain from 1e-6 up to 1e21 and in exponent form
/// (`1e+21`, `1.5e-7`) beyond, with no trailing `.0`.
pub fn number_string(value: f64) -> String {
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

/// `Number(digits)` of a string of ASCII digits, as a whole number when it reads back as the digits it
/// came from, which a name built with it must for a parse to round-trip (`01` and `9007199254740993`
/// do not).
pub fn exact_whole_number(digits: &str) -> Option<u64> {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value: u64 = digits.parse().ok()?;
    (number_string(value as f64) == digits).then_some(value)
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value, Some(2), 0);
    out
}

/// `JSON.stringify(value)` of anything serde can turn into a JSON value. Every wire type and file
/// record can; only a map with keys that are not strings cannot, and none of the Console's has one.
pub fn to_json<T: Serialize + ?Sized>(value: &T) -> String {
    stringify(&serde_json::to_value(value).expect("serializes to a JSON value"))
}

/// `JSON.stringify(value, null, 2)` of anything serde can turn into a JSON value.
pub fn to_json_pretty<T: Serialize + ?Sized>(value: &T) -> String {
    stringify_pretty(&serde_json::to_value(value).expect("serializes to a JSON value"))
}

/// `JSON.parse(text)`, its error worded as Bun words a `SyntaxError` well enough to name what broke.
pub fn parse(text: &str) -> Result<Value, JsonParseError> {
    serde_json::from_str(text).map_err(|err| JsonParseError(err.to_string()))
}

/// A `JSON.parse` that threw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonParseError(String);

impl fmt::Display for JsonParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "JSON Parse error: {}", self.0)
    }
}

impl std::error::Error for JsonParseError {}

/// An object's own keys in the order JavaScript enumerates them: the array indices ascending, then
/// every other key in the order it was added. `JSON.stringify` and `Object.values` both walk this
/// order, so an object parsed from `{"b":1,"1":2}` comes back as `{"1":2,"b":1}`.
pub fn own_entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indices: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut others = Vec::with_capacity(map.len());
    for entry in map {
        match array_index(entry.0) {
            Some(index) => indices.push((index, entry)),
            None => others.push(entry),
        }
    }
    if indices.is_empty() {
        return others;
    }
    indices.sort_by_key(|(index, _)| *index);
    indices
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(others)
        .collect()
}

// A canonical array index: `0`, or digits with no leading zero, below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
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
            for (at, (key, item)) in own_entries(fields).into_iter().enumerate() {
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
        out.extend(std::iter::repeat_n(' ', width * depth));
    }
}

// serde_json escapes a string exactly as JSON.stringify does: the quote, the backslash, the five short
// escapes, other control characters as lowercase `\u00xx`, and everything else as itself.
fn write_string(out: &mut String, text: &str) {
    out.push_str(&serde_json::to_string(text).unwrap_or_default());
}

fn json_number(number: &Number) -> String {
    match (number.as_u64(), number.as_i64()) {
        // A whole number JavaScript holds exactly prints as its digits; a bigger one is a double.
        (Some(whole), _) if whole <= 1 << 53 => whole.to_string(),
        (_, Some(whole)) if whole.unsigned_abs() <= 1 << 53 => whole.to_string(),
        _ => {
            let value = number.as_f64().unwrap_or(f64::NAN);
            // JSON.stringify writes NaN and the infinities as null.
            if value.is_finite() {
                number_string(value)
            } else {
                "null".to_owned()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/// Whether JavaScript counts the character as whitespace (`\s`, `trim`): Rust's whitespace less
/// U+0085, plus U+FEFF.
pub fn is_whitespace(c: char) -> bool {
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

/// JavaScript's `\s` as a `regex` character class, for patterns ported from the TypeScript.
pub const WHITESPACE_CLASS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

/// JavaScript's `\S` as a `regex` character class.
pub const NON_WHITESPACE_CLASS: &str = r"[^\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

/// JavaScript's `.` (any character but a line terminator) as a `regex` character class.
pub const ANY_BUT_LINE_TERMINATOR: &str = r"[^\n\r\x{2028}\x{2029}]";

/// `String.prototype.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// `text.replace(/\s+/g, " ")`: every run of whitespace becomes one space.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_whitespace(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `text.split(/\s+/)` with its empty ends dropped: the words of a whitespace-separated line.
pub fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(is_whitespace).filter(|word| !word.is_empty())
}

/// `text.length`: JavaScript counts UTF-16 code units, so a character beyond the Basic Multilingual
/// Plane counts two.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, max)` in UTF-16 code units, for text that goes out as JSON. JavaScript would cut a
/// surrogate pair in half and keep the lone high surrogate, which no Rust string can hold, so a pair
/// straddling the cut is dropped whole.
pub fn utf16_prefix(text: &str, max: usize) -> &str {
    match utf16_cut(text, max) {
        Cut::Whole => text,
        Cut::At(at) | Cut::Straddling(at) => &text[..at],
    }
}

/// `text.slice(0, max)` in UTF-16 code units, for text that goes into a file. A surrogate pair cut in
/// half leaves its lone high half, which Bun writes to UTF-8 as U+FFFD, so that is what stands in for
/// it here.
pub fn utf16_prefix_lossy(text: &str, max: usize) -> Cow<'_, str> {
    match utf16_cut(text, max) {
        Cut::Whole => Cow::Borrowed(text),
        Cut::At(at) => Cow::Borrowed(&text[..at]),
        Cut::Straddling(at) => Cow::Owned(format!("{}\u{fffd}", &text[..at])),
    }
}

enum Cut {
    Whole,
    At(usize),
    Straddling(usize),
}

fn utf16_cut(text: &str, max: usize) -> Cut {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        let next = units + c.len_utf16();
        if next > max {
            return if units == max {
                Cut::At(at)
            } else {
                Cut::Straddling(at)
            };
        }
        units = next;
    }
    Cut::Whole
}

/// The order JavaScript's default `Array.prototype.sort` puts strings in: by UTF-16 code units, which
/// differs from Rust's byte order only where a character beyond U+FFFF meets one from U+E000 up.
pub fn compare_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `text.replace(pattern, replacement)` with a pattern of no capture groups: the first match only, and
/// the replacement's `$$`, `$&`, `` $` `` and `$'` expanded as JavaScript expands them.
pub fn replace_first(text: &str, pattern: &regex::Regex, replacement: &str) -> String {
    let Some(found) = pattern.find(text) else {
        return text.to_owned();
    };
    let (before, matched, after) = (&text[..found.start()], found.as_str(), &text[found.end()..]);
    let mut out = String::with_capacity(text.len() + replacement.len());
    out.push_str(before);
    let mut rest = replacement;
    while let Some(dollar) = rest.find('$') {
        out.push_str(&rest[..dollar]);
        let tail = &rest[dollar + 1..];
        match tail.chars().next() {
            Some('$') => out.push('$'),
            Some('&') => out.push_str(matched),
            Some('`') => out.push_str(before),
            Some('\'') => out.push_str(after),
            _ => {
                out.push('$');
                rest = tail;
                continue;
            }
        }
        rest = &tail[1..];
    }
    out.push_str(rest);
    out.push_str(after);
    out
}

// ---------------------------------------------------------------------------
// URI components
// ---------------------------------------------------------------------------

/// `encodeURIComponent(text)`: every byte of the UTF-8 but the unreserved marks as `%XX`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `decodeURIComponent(text)`: each `%XX` run read as UTF-8, failing as JavaScript's `URIError` does on
/// a `%` without two hex digits after it or a run that is not one whole UTF-8 character.
pub fn decode_uri_component(text: &str) -> Result<String, UriError> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'%' {
            let next = text[at..].find('%').map_or(bytes.len(), |off| at + off);
            out.push_str(&text[at..next]);
            at = next;
            continue;
        }
        let lead = hex_byte(bytes, at)?;
        at += 3;
        if lead < 0x80 {
            out.push(lead as char);
            continue;
        }
        let length = match lead.leading_ones() {
            2 => 2,
            3 => 3,
            4 => 4,
            _ => return Err(UriError),
        };
        let mut sequence = vec![lead];
        for _ in 1..length {
            let byte = hex_byte(bytes, at)?;
            if byte & 0xC0 != 0x80 {
                return Err(UriError);
            }
            sequence.push(byte);
            at += 3;
        }
        out.push_str(std::str::from_utf8(&sequence).map_err(|_| UriError)?);
    }
    Ok(out)
}

fn hex_byte(bytes: &[u8], at: usize) -> Result<u8, UriError> {
    if bytes.get(at) != Some(&b'%') {
        return Err(UriError);
    }
    let digit = |offset: usize| {
        bytes
            .get(at + offset)
            .and_then(|b| (*b as char).to_digit(16))
            .ok_or(UriError)
    };
    Ok((digit(1)? * 16 + digit(2)?) as u8)
}

/// The `URIError` `decodeURIComponent` throws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UriError;

impl fmt::Display for UriError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("URI error")
    }
}

impl std::error::Error for UriError {}

// ---------------------------------------------------------------------------
// Decoding bytes
// ---------------------------------------------------------------------------

/// `new TextDecoder()` and its `decode(chunk, { stream })`: UTF-8, every invalid sequence a U+FFFD
/// (the maximal-subpart rule both follow), a leading byte-order mark dropped once per stream, and a
/// character split across chunks held back until the chunk that completes it. A call without
/// `stream` ends the stream: what is held back becomes one U+FFFD, and the next call starts afresh.
#[derive(Debug, Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
    bom_seen: bool,
    streaming: bool,
}

impl Utf8Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// `decoder.decode(chunk, { stream })`.
    pub fn decode(&mut self, chunk: &[u8], stream: bool) -> String {
        if !self.streaming {
            self.pending.clear();
            self.bom_seen = false;
        }
        self.streaming = stream;
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut out = String::with_capacity(bytes.len());
        let mut at = 0;
        while at < bytes.len() {
            match std::str::from_utf8(&bytes[at..]) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(err) => {
                    let valid = at + err.valid_up_to();
                    out.push_str(std::str::from_utf8(&bytes[at..valid]).unwrap_or_default());
                    match err.error_len() {
                        Some(bad) => {
                            out.push('\u{fffd}');
                            at = valid + bad;
                        }
                        None => {
                            if stream {
                                self.pending = bytes[valid..].to_vec();
                            } else {
                                out.push('\u{fffd}');
                            }
                            break;
                        }
                    }
                }
            }
        }
        if !self.bom_seen && !out.is_empty() {
            self.bom_seen = true;
            if let Some(rest) = out.strip_prefix('\u{feff}') {
                return rest.to_owned();
            }
        }
        out
    }
}

/// `new TextDecoder().decode(bytes)`: the whole of a byte run, decoded as one stream.
pub fn decode_utf8(bytes: &[u8]) -> String {
    Utf8Decoder::new().decode(bytes, false)
}

/// `readFileSync(path, "utf8")`: the file as text, every invalid sequence a U+FFFD and a byte-order
/// mark kept. Its error reads as Bun's (`ENOENT: no such file or directory, open '<path>'`, or
/// `EISDIR: illegal operation on a directory, read` for a directory).
pub fn read_text(path: &Path) -> Result<String, FsError> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|err| FsError::new(&err, "open", path))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|err| FsError::bare(&err, "read"))?;
    Ok(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(err) => String::from_utf8_lossy(err.as_bytes()).into_owned(),
    })
}

// ---------------------------------------------------------------------------
// fs errors
// ---------------------------------------------------------------------------

/// A failed `fs` call, worded as Bun's `fs` throws it: `ENOENT: no such file or directory, open
/// '<path>'`, or `... rename '<from>' -> '<to>'` for a rename.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsError {
    message: String,
    /// The error's code (`ENOENT`), when the system named one Bun knows.
    pub code: Option<&'static str>,
}

impl FsError {
    /// A failed call Bun names with no path (`ENOENT: no such file or directory, open` from
    /// `appendFileSync`, `EISDIR: illegal operation on a directory, read`).
    pub fn bare(err: &io::Error, syscall: &str) -> Self {
        match errno_text(err) {
            Some((code, description)) => FsError {
                message: format!("{code}: {description}, {syscall}"),
                code: Some(code),
            },
            None => FsError {
                message: err.to_string(),
                code: None,
            },
        }
    }

    pub fn new(err: &io::Error, syscall: &str, path: &Path) -> Self {
        let path = path.display();
        match errno_text(err) {
            Some((code, description)) => FsError {
                message: format!("{code}: {description}, {syscall} '{path}'"),
                code: Some(code),
            },
            None => FsError {
                message: err.to_string(),
                code: None,
            },
        }
    }

    pub fn rename(err: &io::Error, from: &Path, to: &Path) -> Self {
        match errno_text(err) {
            Some((code, description)) => FsError {
                message: format!(
                    "{code}: {description}, rename '{}' -> '{}'",
                    from.display(),
                    to.display()
                ),
                code: Some(code),
            },
            None => FsError {
                message: err.to_string(),
                code: None,
            },
        }
    }
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FsError {}

/// `readdirSync(dir)`: the entry names in the order the system lists them, a name that is not UTF-8
/// read lossily.
pub fn read_dir_names(dir: &Path) -> Result<Vec<String>, FsError> {
    let entries = std::fs::read_dir(dir).map_err(|err| FsError::new(&err, "scandir", dir))?;
    entries
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .map_err(|err| FsError::new(&err, "scandir", dir))
        })
        .collect()
}

/// `mkdirSync(dir, { recursive: true })`.
pub fn mkdir_all(dir: &Path) -> Result<(), FsError> {
    std::fs::create_dir_all(dir).map_err(|err| FsError::new(&err, "mkdir", dir))
}

/// `writeFileSync(path, text)`.
pub fn write_file(path: &Path, text: &str) -> Result<(), FsError> {
    use std::io::Write;
    std::fs::File::create(path)
        .map_err(|err| FsError::new(&err, "open", path))?
        .write_all(text.as_bytes())
        .map_err(|err| FsError::bare(&err, "write"))
}

/// `appendFileSync(path, text)`. Bun names no path when it fails.
pub fn append_file(path: &Path, text: &str) -> Result<(), FsError> {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .map_err(|err| FsError::bare(&err, "open"))?
        .write_all(text.as_bytes())
        .map_err(|err| FsError::bare(&err, "write"))
}

/// `renameSync(from, to)`.
pub fn rename(from: &Path, to: &Path) -> Result<(), FsError> {
    std::fs::rename(from, to).map_err(|err| FsError::rename(&err, from, to))
}

/// `writeFileSync(tmp, text)` then `renameSync(tmp, path)`: the way the engine replaces a file whole,
/// so a reader never sees half of it.
pub fn write_through_rename(path: &Path, tmp: &Path, text: &str) -> Result<(), FsError> {
    write_file(tmp, text)?;
    rename(tmp, path)
}

// The error's code and libuv's description of it, as Bun's fs errors spell them.
fn errno_text(err: &io::Error) -> Option<(&'static str, &'static str)> {
    const EPERM: i32 = 1;
    const ENOENT: i32 = 2;
    const EIO: i32 = 5;
    const EBADF: i32 = 9;
    const EAGAIN: i32 = 11;
    const ENOMEM: i32 = 12;
    const EACCES: i32 = 13;
    const EFAULT: i32 = 14;
    const EBUSY: i32 = 16;
    const EEXIST: i32 = 17;
    const EXDEV: i32 = 18;
    const ENOTDIR: i32 = 20;
    const EISDIR: i32 = 21;
    const EINVAL: i32 = 22;
    const ENFILE: i32 = 23;
    const EMFILE: i32 = 24;
    const ETXTBSY: i32 = 26;
    const EFBIG: i32 = 27;
    const ENOSPC: i32 = 28;
    const EROFS: i32 = 30;
    const EMLINK: i32 = 31;
    const ENAMETOOLONG: i32 = 36;
    const ENOTEMPTY: i32 = 39;
    const ELOOP: i32 = 40;
    let text = match err.raw_os_error()? {
        EPERM => ("EPERM", "operation not permitted"),
        ENOENT => ("ENOENT", "no such file or directory"),
        EIO => ("EIO", "i/o error"),
        EBADF => ("EBADF", "bad file descriptor"),
        EAGAIN => ("EAGAIN", "resource temporarily unavailable"),
        ENOMEM => ("ENOMEM", "not enough memory"),
        EACCES => ("EACCES", "permission denied"),
        EFAULT => ("EFAULT", "bad address in system call argument"),
        EBUSY => ("EBUSY", "resource busy or locked"),
        EEXIST => ("EEXIST", "file already exists"),
        EXDEV => ("EXDEV", "cross-device link not permitted"),
        ENOTDIR => ("ENOTDIR", "not a directory"),
        EISDIR => ("EISDIR", "illegal operation on a directory"),
        EINVAL => ("EINVAL", "invalid argument"),
        ENFILE => ("ENFILE", "file table overflow"),
        EMFILE => ("EMFILE", "too many open files"),
        ETXTBSY => ("ETXTBSY", "text file is busy"),
        EFBIG => ("EFBIG", "file too large"),
        ENOSPC => ("ENOSPC", "no space left on device"),
        EROFS => ("EROFS", "read-only file system"),
        EMLINK => ("EMLINK", "too many links"),
        ENAMETOOLONG => ("ENAMETOOLONG", "name too long"),
        ENOTEMPTY => ("ENOTEMPTY", "directory not empty"),
        ELOOP => ("ELOOP", "too many symbolic links encountered"),
        _ => return None,
    };
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prints_iso_times_as_a_date_does() {
        let at = UNIX_EPOCH + std::time::Duration::from_nanos(1_790_000_000_123_999_999);
        assert_eq!(iso_of(at), "2026-09-21T14:13:20.123Z");
        assert_eq!(iso_of(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_of_ms(1_767_225_600_000.9), "2026-01-01T00:00:00.000Z");
        let now = now_iso();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z'));
        assert_eq!(&now[19..20], ".");
    }

    #[test]
    fn prints_numbers_as_javascript_does() {
        for (value, printed) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-32000.0, "-32000"),
            (0.1, "0.1"),
            (0.6, "0.6"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123.456, "123.456"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (9007199254740993.0, "9007199254740992"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(number_string(value), printed, "{value:e}");
        }
    }

    #[test]
    fn reads_a_whole_number_only_when_it_round_trips() {
        assert_eq!(exact_whole_number("3"), Some(3));
        assert_eq!(exact_whole_number("0"), Some(0));
        assert_eq!(exact_whole_number("01"), None);
        assert_eq!(exact_whole_number("9007199254740993"), None);
        assert_eq!(
            exact_whole_number("9007199254740994"),
            Some(9007199254740994)
        );
        assert_eq!(exact_whole_number(""), None);
        assert_eq!(exact_whole_number("1x"), None);
    }

    #[test]
    fn stringifies_as_json_stringify_does() {
        let value: Value =
            serde_json::from_str(r#"{"b":1.0,"1":[1e21,-0.5,null],"a":"q\"\u001b\n","0":{}}"#)
                .unwrap();
        assert_eq!(
            stringify(&value),
            r#"{"0":{},"1":[1e+21,-0.5,null],"b":1,"a":"q\"\u001b\n"}"#
        );
        assert_eq!(
            stringify(&json!(12345678901234567890u64)),
            "12345678901234567000"
        );
        assert_eq!(stringify(&json!(-7)), "-7");
        assert_eq!(stringify(&json!([])), "[]");
    }

    #[test]
    fn pretty_prints_with_two_spaces_as_json_stringify_does() {
        let value = json!({"nextSeq": 2, "answers": [{"seq": 1, "processedAt": null}], "empty": [], "none": {}});
        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"nextSeq\": 2,\n  \"answers\": [\n    {\n      \"seq\": 1,\n      \"processedAt\": null\n    }\n  ],\n  \"empty\": [],\n  \"none\": {}\n}"
        );
        assert_eq!(stringify_pretty(&json!("x")), "\"x\"");
    }

    #[test]
    fn trims_and_collapses_javascript_whitespace() {
        assert_eq!(trim("  \t title \n"), "title");
        assert_eq!(trim("\u{feff}title\u{a0}"), "title");
        assert_eq!(trim("\u{85}title\u{85}"), "\u{85}title\u{85}");
        assert_eq!(collapse_whitespace("a \n\t b\u{feff}c "), "a b c ");
        assert_eq!(
            words(" id=01  status=ready\r").collect::<Vec<_>>(),
            ["id=01", "status=ready"]
        );
    }

    #[test]
    fn counts_and_cuts_in_utf16_units() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_prefix("ab😀c", 3), "ab");
        assert_eq!(utf16_prefix("ab😀c", 4), "ab😀");
        assert_eq!(utf16_prefix_lossy("ab😀c", 3), "ab\u{fffd}");
        assert_eq!(utf16_prefix_lossy("ab😀c", 2), "ab");
        assert_eq!(utf16_prefix_lossy("abc", 10), "abc");
        assert_eq!(compare_utf16("\u{ffff}", "😀"), Ordering::Greater);
        assert_eq!(compare_utf16("a", "b"), Ordering::Less);
    }

    #[test]
    fn replaces_the_first_match_expanding_dollar_patterns() {
        let pattern = regex::Regex::new("blocked-by=[^ ]*").unwrap();
        assert_eq!(
            replace_first(
                "a blocked-by=00 b blocked-by=x",
                &pattern,
                "blocked-by=00,01"
            ),
            "a blocked-by=00,01 b blocked-by=x"
        );
        assert_eq!(
            replace_first("x blocked-by=00 y", &pattern, "[$&|$`|$'|$$|$1]"),
            "x [blocked-by=00|x | y|$|$1] y"
        );
        assert_eq!(replace_first("nothing", &pattern, "z"), "nothing");
    }

    #[test]
    fn encodes_and_decodes_uri_components() {
        let assign = r#"{"model":"child-model","drivers":"implement code-review"}"#;
        let encoded = encode_uri_component(assign);
        assert_eq!(
            encoded,
            "%7B%22model%22%3A%22child-model%22%2C%22drivers%22%3A%22implement%20code-review%22%7D"
        );
        assert_eq!(decode_uri_component(&encoded).unwrap(), assign);
        assert_eq!(encode_uri_component("a-_.!~*'()é/"), "a-_.!~*'()%C3%A9%2F");
        assert_eq!(decode_uri_component("%c3%a9 x+y").unwrap(), "é x+y");
        assert_eq!(decode_uri_component("not-json").unwrap(), "not-json");
        for bad in ["%", "%z1", "%C3", "%C3%41", "%FF%FF", "%ED%A0%80"] {
            assert_eq!(decode_uri_component(bad), Err(UriError), "{bad}");
        }
        assert_eq!(UriError.to_string(), "URI error");
    }

    #[test]
    fn decodes_a_stream_as_text_decoder_does() {
        let bytes = "héllo ✓".as_bytes();
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.decode(&bytes[..2], true), "h");
        assert_eq!(decoder.decode(&bytes[2..9], true), "éllo ");
        assert_eq!(decoder.decode(&bytes[9..], true), "✓");
        // A cut character at the end of the stream is one replacement.
        assert_eq!(decoder.decode(&[0xE2, 0x9C], false), "\u{fffd}");
        // The byte-order mark goes once per stream, and invalid bytes are replaced.
        assert_eq!(decoder.decode(b"\xEF\xBB\xBFa\xFFb", true), "a\u{fffd}b");
        assert_eq!(decoder.decode(b"\xEF\xBB\xBFc", false), "\u{feff}c");
        assert_eq!(decode_utf8(b"\xEF\xBB\xBF{}"), "{}");
        assert_eq!(decode_utf8(b"\xF0\x9F\x98"), "\u{fffd}");
    }

    #[test]
    fn words_fs_errors_as_bun_does() {
        let missing = Path::new("/nonexistent-dir-for-test/x");
        assert_eq!(
            read_text(missing).unwrap_err().to_string(),
            "ENOENT: no such file or directory, open '/nonexistent-dir-for-test/x'"
        );
        let err = rename(missing, Path::new("/nonexistent-dir-for-test/y")).unwrap_err();
        assert_eq!(
            err.to_string(),
            "ENOENT: no such file or directory, rename '/nonexistent-dir-for-test/x' -> '/nonexistent-dir-for-test/y'"
        );
        assert_eq!(err.code, Some("ENOENT"));
        assert_eq!(
            append_file(missing, "x").unwrap_err().to_string(),
            "ENOENT: no such file or directory, open"
        );
        assert_eq!(
            write_file(missing, "x").unwrap_err().to_string(),
            "ENOENT: no such file or directory, open '/nonexistent-dir-for-test/x'"
        );
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_text(dir.path()).unwrap_err().to_string(),
            "EISDIR: illegal operation on a directory, read"
        );
        let file = dir.path().join("f");
        std::fs::write(&file, "").unwrap();
        assert_eq!(
            mkdir_all(&file.join("sub")).unwrap_err().to_string(),
            format!(
                "ENOTDIR: not a directory, mkdir '{}'",
                file.join("sub").display()
            )
        );
        assert_eq!(
            read_dir_names(&file).unwrap_err().to_string(),
            format!("ENOTDIR: not a directory, scandir '{}'", file.display())
        );
    }

    #[test]
    fn walks_own_keys_in_javascript_order() {
        let value: Value =
            serde_json::from_str(r#"{"z":1,"10":2,"2":3,"01":4,"4294967295":5}"#).unwrap();
        let Value::Object(map) = value else {
            unreachable!()
        };
        let keys: Vec<&str> = own_entries(&map)
            .into_iter()
            .map(|(k, _)| k.as_str())
            .collect();
        assert_eq!(keys, ["2", "10", "z", "01", "4294967295"]);
    }
}
