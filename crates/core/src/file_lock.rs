//! The files the server rewrites in answer to a request: console.json (a Settings save, a Reassign) and
//! the Machine defaults. The TypeScript server ran one request at a time, so a read-modify-write of one
//! never met another and `<file>.tmp-<pid>` was a temp name of its own. This server answers on several
//! threads, so each such file has a FileLock its writers hold from the read their change starts from to
//! the rename that lands it, and every write takes a temp name no other write shares: a rename never
//! moves a file another write is part way through.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::js;

/// One file's writers in this process, one at a time. A server process owns one pool, so one lock per
/// process is one lock per pool file; a writer in another process (Boot, another pool's server) is
/// kept apart by the temp name alone.
pub struct FileLock(Mutex<()>);

impl FileLock {
    pub const fn new() -> FileLock {
        FileLock(Mutex::new(()))
    }

    /// The file is this writer's until the guard drops. A writer that panicked still let go of it.
    pub fn hold(&self) -> MutexGuard<'_, ()> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for FileLock {
    fn default() -> Self {
        FileLock::new()
    }
}

// The writes this process has made through a temp name, counted so no two share one.
static TEMP_WRITES: AtomicU64 = AtomicU64::new(0);

/// `<path>.tmp-<pid>-<n>`: a temp name beside `path` no other write in any process shares.
pub fn own_temp_path(path: &str) -> String {
    let n = TEMP_WRITES.fetch_add(1, Ordering::Relaxed);
    format!("{path}.tmp-{}-{n}", std::process::id())
}

/// Replace `path` whole through a temp name of this write's own, so a reader never sees half a file.
/// A temp file a failed write leaves is removed, since its name will never be written again.
pub fn write_through_own_temp(path: &str, text: &str) -> Result<(), js::FsError> {
    let tmp = own_temp_path(path);
    js::write_through_rename(path, &tmp, text).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_every_temp_file_apart() {
        let first = own_temp_path("/pool/console.json");
        let second = own_temp_path("/pool/console.json");
        assert_ne!(first, second);
        let prefix = format!("/pool/console.json.tmp-{}-", std::process::id());
        assert!(first.starts_with(&prefix), "{first}");
        assert!(second.starts_with(&prefix), "{second}");
    }

    #[test]
    fn replaces_the_file_and_leaves_no_temp_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("console.json")
            .to_string_lossy()
            .into_owned();
        write_through_own_temp(&path, "{}\n").unwrap();
        write_through_own_temp(&path, "{ \"title\": \"T\" }\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ \"title\": \"T\" }\n"
        );
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["console.json"]);
    }
}
