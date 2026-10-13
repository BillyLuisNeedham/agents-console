//! File reads the engine repeats on every snapshot (issue #157): the Ticket and Conversation files, the
//! events files, the git refs behind the Merge hold. Each is re-derived from disk on purpose, so a file
//! written by hand or by another process is seen at the next read; what this module saves is the re-read
//! and re-parse of a file that has not changed since.
//!
//! A file's stamp is what `stat` says about it: device, inode, size, and the modification and change
//! times. Any write moves the times, and git's lockfile-and-rename moves the inode as well. The one write
//! a stamp can miss is one that lands within the filesystem's timestamp granularity of the read it would
//! invalidate, with the size unchanged (git calls this the racy case). So a file modified within
//! [`RACY_MS`] of now has no stamp: its readers read it afresh every time until it has been quiet that
//! long, and a stamp taken before a read can never vouch for a write that came after it.
//!
//! Ported from engine/stat-cache.ts. A stamp is only ever compared with another stamp taken by the same
//! process, so its text carries the times to the nanosecond rather than as JavaScript's float
//! milliseconds.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::Metadata;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a file must have been quiet before its stamp is trusted.
pub const RACY_MS: i64 = 2_000;

/// The stamp of a path with nothing at it (or nothing `stat` can reach).
pub const ABSENT: &str = "absent";

/// Milliseconds since the epoch, the clock `Date.now()` reads: what a stamp's racy window is measured
/// against.
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    }
}

/// The file's stamp now: [`ABSENT`] when there is nothing at the path, `None` when it changed too
/// recently to vouch for (the racy case above).
pub fn file_stamp(path: impl AsRef<Path>) -> Option<String> {
    file_stamp_at(path, now_ms())
}

/// The file's stamp as of `now_ms`: [`ABSENT`] when there is nothing at the path, `None` in the racy
/// case.
pub fn file_stamp_at(path: impl AsRef<Path>, now_ms: i64) -> Option<String> {
    match std::fs::metadata(path) {
        Ok(meta) => stamp_of(&meta, now_ms),
        Err(_) => Some(ABSENT.to_string()),
    }
}

/// The stamp of a file already stat'd: `None` in the racy case.
pub fn stamp_of(meta: &Metadata, now_ms: i64) -> Option<String> {
    let mtime_ns = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
    let quiet_since_ns = (i128::from(now_ms) - i128::from(RACY_MS)) * 1_000_000;
    if mtime_ns > quiet_since_ns {
        return None;
    }
    Some(format!(
        "{}:{}:{}:{}.{:09}:{}.{:09}",
        meta.dev(),
        meta.ino(),
        meta.size(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec()
    ))
}

/// A read behind a per-path cache keyed on the file's stamp. The stamp is taken before the read, so a
/// write racing the read leaves the entry under a stamp the next call no longer matches. A read that
/// fails is not cached: the next call reads again and fails again, the way the bare read would. Every
/// caller gets its own clone of what was read. Entries are keyed by the path exactly as spelled, so
/// `dir/x.md` and `dir/./x.md` are two entries, as they are two keys of the TypeScript's map.
#[derive(Debug)]
pub struct StampCache<T> {
    entries: HashMap<OsString, Entry<T>>,
}

#[derive(Debug)]
struct Entry<T> {
    stamp: String,
    value: T,
}

impl<T> Default for StampCache<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<T: Clone> StampCache<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// `read(path)`, or what it returned last time while the file's stamp has not moved since.
    pub fn read<E>(
        &mut self,
        path: impl AsRef<Path>,
        read: impl FnOnce(&Path) -> Result<T, E>,
    ) -> Result<T, E> {
        let path = path.as_ref();
        let stamp = file_stamp(path);
        if let (Some(stamp), Some(hit)) = (&stamp, self.entries.get(path.as_os_str()))
            && hit.stamp == *stamp
        {
            return Ok(hit.value.clone());
        }
        let value = read(path)?;
        match stamp {
            Some(stamp) if stamp != ABSENT => {
                self.entries.insert(
                    path.as_os_str().to_owned(),
                    Entry {
                        stamp,
                        value: value.clone(),
                    },
                );
            }
            _ => {
                self.entries.remove(path.as_os_str());
            }
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::fs::{self, File, FileTimes};
    use std::path::PathBuf;
    use std::time::Duration;

    fn temp_file(text: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("stat-cache-")
            .tempdir()
            .unwrap();
        let path = dir.path().join("file.md");
        fs::write(&path, text).unwrap();
        (dir, path)
    }

    // Moves the file's modification time out of the racy window, the way an hour of quiet would.
    fn quiet(path: &Path) {
        let past = SystemTime::now() - Duration::from_secs(60 * 60);
        let file = File::options().write(true).open(path).unwrap();
        file.set_times(FileTimes::new().set_accessed(past).set_modified(past))
            .unwrap();
    }

    /// A reader that counts its reads and parses the file as a word list.
    fn words(reads: &Cell<u32>, path: &Path) -> std::io::Result<Vec<String>> {
        reads.set(reads.get() + 1);
        Ok(fs::read_to_string(path)?
            .split(' ')
            .map(str::to_string)
            .collect())
    }

    #[test]
    fn reads_a_quiet_file_once_while_it_stays_unchanged() {
        let (_dir, path) = temp_file("one two");
        quiet(&path);
        let reads = Cell::new(0);
        let mut cache = StampCache::new();
        assert_eq!(
            cache.read(&path, |p| words(&reads, p)).unwrap(),
            ["one", "two"]
        );
        assert_eq!(
            cache.read(&path, |p| words(&reads, p)).unwrap(),
            ["one", "two"]
        );
        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn reads_a_file_changed_within_the_racy_window_afresh_every_time() {
        let (_dir, path) = temp_file("one two");
        assert_eq!(file_stamp(&path), None);
        let reads = Cell::new(0);
        let mut cache = StampCache::new();
        cache.read(&path, |p| words(&reads, p)).unwrap();
        cache.read(&path, |p| words(&reads, p)).unwrap();
        assert_eq!(reads.get(), 2);
    }

    #[test]
    fn sees_a_same_size_rewrite_in_place_even_with_its_modification_time_put_back() {
        let (_dir, path) = temp_file("one two");
        quiet(&path);
        let reads = Cell::new(0);
        let mut cache = StampCache::new();
        assert_eq!(
            cache.read(&path, |p| words(&reads, p)).unwrap(),
            ["one", "two"]
        );
        fs::write(&path, "six ten").unwrap();
        quiet(&path);
        // The change time cannot be put back, so the stamp still moves.
        assert_eq!(
            cache.read(&path, |p| words(&reads, p)).unwrap(),
            ["six", "ten"]
        );
    }

    #[test]
    fn caches_no_failed_read_and_forgets_a_file_that_is_gone() {
        let (_dir, path) = temp_file("one two");
        quiet(&path);
        let reads = Cell::new(0);
        let mut cache: StampCache<Vec<String>> = StampCache::new();
        let torn = cache.read(&path, |_| Err::<Vec<String>, String>("torn".into()));
        assert_eq!(torn, Err("torn".to_string()));
        assert_eq!(reads.get(), 0);
        assert_eq!(
            cache.read(&path, |p| words(&reads, p)).unwrap(),
            ["one", "two"]
        );
        assert_eq!(reads.get(), 1);

        fs::remove_file(&path).unwrap();
        // Gone: the cached parse is never served, and the read fails as a bare read would.
        assert!(cache.read(&path, |p| words(&reads, p)).is_err());
        assert_eq!(reads.get(), 2);
        // A reader that tolerates the absence is asked every time and nothing is kept for the path.
        let absent = Vec::new();
        assert_eq!(
            cache.read(&path, |_| Ok::<_, String>(absent.clone())),
            Ok(vec![])
        );
        assert!(!cache.entries.contains_key(path.as_os_str()));
        assert_eq!(cache.read(&path, |p| words(&reads, p)).ok(), None);
        assert_eq!(reads.get(), 3);
    }

    #[test]
    fn keeps_each_spelling_of_a_path_as_its_own_entry() {
        let (dir, path) = temp_file("one two");
        quiet(&path);
        let reads = Cell::new(0);
        let mut cache = StampCache::new();
        let dotted = dir.path().join(".").join("file.md");
        cache.read(&path, |p| words(&reads, p)).unwrap();
        cache.read(&dotted, |p| words(&reads, p)).unwrap();
        cache.read(&path, |p| words(&reads, p)).unwrap();
        cache.read(&dotted, |p| words(&reads, p)).unwrap();
        assert_eq!(reads.get(), 2);
        assert_eq!(cache.entries.len(), 2);
    }

    #[test]
    fn calls_a_file_quiet_once_it_has_gone_racy_ms_without_a_change() {
        let (_dir, path) = temp_file("one");
        let now = now_ms();
        assert_eq!(file_stamp_at(&path, now), None);
        assert!(file_stamp_at(&path, now + RACY_MS + 50).is_some());
        assert_eq!(file_stamp(path.join("missing")).as_deref(), Some(ABSENT));
    }

    #[test]
    fn stamps_device_inode_size_and_both_times() {
        let (_dir, path) = temp_file("one two");
        quiet(&path);
        let meta = fs::metadata(&path).unwrap();
        let stamp = stamp_of(&meta, now_ms()).unwrap();
        let fields: Vec<&str> = stamp.split(':').collect();
        assert_eq!(fields.len(), 5);
        assert_eq!(fields[0], meta.dev().to_string());
        assert_eq!(fields[1], meta.ino().to_string());
        assert_eq!(fields[2], "7");
        // A rewrite that moves the inode (git's lockfile and rename) moves the stamp.
        let renamed = path.with_extension("lock");
        fs::write(&renamed, "one two").unwrap();
        fs::rename(&renamed, &path).unwrap();
        quiet(&path);
        assert_ne!(file_stamp(&path).unwrap(), stamp);
    }
}
