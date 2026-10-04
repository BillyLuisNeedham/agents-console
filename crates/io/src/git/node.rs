//! The few JavaScript and Node behaviours the git edge reproduces so its strings match the TypeScript's:
//! `String.prototype.trim`, `Number(string)`, `path.join`, `realpathSync` with a fallback, and the text
//! of a failed `fs` call.

use std::io;
use std::path::Path;

/// JavaScript's `trim()`. Its whitespace is not Rust's: it strips U+FEFF and keeps U+0085.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

fn is_js_whitespace(c: char) -> bool {
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

/// JavaScript's `Number(text)`: trimmed, empty is 0, `0x`, `0o` and `0b` integers, signed decimals with
/// an exponent, `Infinity`, and NaN for anything else.
pub(crate) fn js_number(text: &str) -> f64 {
    let text = js_trim(text);
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

/// Node's `path.join` for POSIX paths: the non-empty parts joined with `/`, then normalized (`.` and `..`
/// resolved, repeated separators collapsed, a trailing separator kept).
pub(crate) fn node_join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    node_normalize(&joined)
}

fn node_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut kept: Vec<&str> = Vec::new();
    for segment in path.split('/') {
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
            (true, _) => "/".to_string(),
            (false, true) => "./".to_string(),
            (false, false) => ".".to_string(),
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

/// Node's `path.relative` for POSIX paths: the way from `from` to `to`, both resolved against the
/// process's working directory first; empty when they are the same place.
pub(crate) fn node_relative(from: &str, to: &str) -> String {
    let from = node_resolve(from);
    let to = node_resolve(to);
    if from == to {
        return String::new();
    }
    let from_parts: Vec<&str> = from.split('/').filter(|part| !part.is_empty()).collect();
    let to_parts: Vec<&str> = to.split('/').filter(|part| !part.is_empty()).collect();
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts = vec![".."; from_parts.len() - common];
    parts.extend(&to_parts[common..]);
    parts.join("/")
}

fn node_resolve(path: &str) -> String {
    let absolute = if path.starts_with('/') {
        path.to_string()
    } else {
        let cwd = std::env::current_dir()
            .map(|dir| path_text(&dir))
            .unwrap_or_default();
        format!("{cwd}/{path}")
    };
    let normalized = node_normalize(&absolute);
    match normalized.trim_end_matches('/') {
        "" => "/".to_string(),
        trimmed => trimmed.to_string(),
    }
}

/// A path as a string, the way the TypeScript holds every path.
pub(crate) fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `realpathSync`, or the path as given when there is nothing on disk to resolve (canonicalDir in
/// engine.ts, canonical in enlist.ts).
pub(crate) fn canonical_dir(dir: &str) -> String {
    match std::fs::canonicalize(dir) {
        Ok(real) => path_text(&real),
        Err(_) => dir.to_string(),
    }
}

/// The message Bun's `fs` throws for a failed call on one path: `ENOENT: no such file or directory,
/// mkdir '<path>'`.
pub(crate) fn fs_error(err: &io::Error, syscall: &str, path: &str) -> String {
    match errno_text(err) {
        Some((code, description)) => format!("{code}: {description}, {syscall} '{path}'"),
        None => err.to_string(),
    }
}

/// The message Bun's `renameSync` throws: `ENOENT: no such file or directory, rename '<from>' -> '<to>'`.
pub(crate) fn rename_error(err: &io::Error, from: &str, to: &str) -> String {
    match errno_text(err) {
        Some((code, description)) => {
            format!("{code}: {description}, rename '{from}' -> '{to}'")
        }
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
        libc::EFAULT => ("EFAULT", "bad address in system call argument"),
        libc::EBUSY => ("EBUSY", "resource busy or locked"),
        libc::EEXIST => ("EEXIST", "file already exists"),
        libc::EXDEV => ("EXDEV", "cross-device link not permitted"),
        libc::ENOTDIR => ("ENOTDIR", "not a directory"),
        libc::EISDIR => ("EISDIR", "illegal operation on a directory"),
        libc::EINVAL => ("EINVAL", "invalid argument"),
        libc::ENFILE => ("ENFILE", "file table overflow"),
        libc::EMFILE => ("EMFILE", "too many open files"),
        libc::ETXTBSY => ("ETXTBSY", "text file is busy"),
        libc::EFBIG => ("EFBIG", "file too large"),
        libc::ENOSPC => ("ENOSPC", "no space left on device"),
        libc::EROFS => ("EROFS", "read-only file system"),
        libc::EMLINK => ("EMLINK", "too many links"),
        libc::ENAMETOOLONG => ("ENAMETOOLONG", "name too long"),
        libc::ENOTEMPTY => ("ENOTEMPTY", "directory not empty"),
        libc::ELOOP => ("ELOOP", "too many symbolic links encountered"),
        _ => return None,
    };
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_as_javascript_does() {
        assert_eq!(js_trim(" \t\n x y \r\n"), "x y");
        assert_eq!(js_trim("\u{feff}\u{a0}x\u{3000}"), "x");
        // U+0085 is Rust whitespace, not JavaScript's.
        assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
        // NUL is nobody's whitespace: a -z listing keeps its last separator.
        assert_eq!(js_trim("?? a\0?? b\0\n"), "?? a\0?? b\0");
    }

    #[test]
    fn reads_numbers_as_javascript_does() {
        assert_eq!(js_number("12"), 12.0);
        assert_eq!(js_number(" 7\n"), 7.0);
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("-1"), -1.0);
        assert_eq!(js_number("+3"), 3.0);
        assert_eq!(js_number("1e3"), 1000.0);
        assert_eq!(js_number("1.5"), 1.5);
        assert_eq!(js_number(".5"), 0.5);
        assert_eq!(js_number("5."), 5.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("0b11"), 3.0);
        assert_eq!(js_number("0o17"), 15.0);
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        for nan in [
            "abc",
            "1_0",
            "0x",
            "-0x10",
            "inf",
            "nan",
            "1e",
            ".",
            "e1",
            "1 2",
            "Infinityx",
        ] {
            assert!(js_number(nan).is_nan(), "{nan:?}");
        }
    }

    #[test]
    fn joins_paths_as_node_does() {
        assert_eq!(
            node_join(&["/repo/.git", "pool-worktrees", "abcd1234", "01"]),
            "/repo/.git/pool-worktrees/abcd1234/01"
        );
        assert_eq!(node_join(&["/repo/", "", "./x//y/"]), "/repo/x/y/");
        assert_eq!(node_join(&["/a/b", "../c"]), "/a/c");
        assert_eq!(node_join(&["/", ".."]), "/");
        assert_eq!(node_join(&["a", "../../b"]), "../b");
        assert_eq!(node_join(&["", ""]), ".");
        assert_eq!(node_join(&["a", ".."]), ".");
    }

    #[test]
    fn relates_paths_as_node_does() {
        assert_eq!(
            node_relative("/repo", "/repo/.scratch/pool/issues/01.md"),
            ".scratch/pool/issues/01.md"
        );
        assert_eq!(node_relative("/repo/", "/repo"), "");
        assert_eq!(node_relative("/a/b/c", "/a"), "../..");
        assert_eq!(node_relative("/a/b", "/a/bc/d"), "../bc/d");
        assert_eq!(node_relative("/", "/x"), "x");
        assert_eq!(node_relative("/x/./y/../z", "/x/z/w"), "w");
    }

    #[test]
    fn spells_fs_errors_as_bun_does() {
        let missing = io::Error::from_raw_os_error(libc::ENOENT);
        assert_eq!(
            fs_error(&missing, "mkdir", "/proc/nope"),
            "ENOENT: no such file or directory, mkdir '/proc/nope'"
        );
        assert_eq!(
            rename_error(&missing, "/a", "/b"),
            "ENOENT: no such file or directory, rename '/a' -> '/b'"
        );
        let denied = io::Error::from_raw_os_error(libc::EACCES);
        assert_eq!(
            fs_error(&denied, "rm", "/x"),
            "EACCES: permission denied, rm '/x'"
        );
    }
}
