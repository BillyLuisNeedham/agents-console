//! This process's own binary, as a path that runs.
//!
//! On Linux `current_exe` reads `/proc/self/exe`, and once the file the process started from is replaced
//! under it (a `cargo build` relinks `target/release/agent-console` in place) that link reads
//! `<path> (deleted)`. Nothing runs at that path. The path before the mark is where the replacement lives,
//! and it is the one a Steward is taught and a Restart runs.

use std::path::{Path, PathBuf};

/// What the kernel appends to the link of an executable whose file was unlinked.
const DELETED_MARK: &str = " (deleted)";

/// `std::env::current_exe`, with a ` (deleted)` mark taken off.
pub fn own_exe() -> std::io::Result<PathBuf> {
    std::env::current_exe().map(|exe| without_deleted_mark(&exe))
}

/// The path before a trailing ` (deleted)` when nothing is at the path as given; otherwise the path as
/// given, so a file that really is named that way is left alone.
pub fn without_deleted_mark(path: &Path) -> PathBuf {
    match path.to_str().and_then(|text| text.strip_suffix(DELETED_MARK)) {
        Some(live) if !path.exists() => PathBuf::from(live),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_marked_path_with_nothing_there_loses_its_mark() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("agent-console");
        std::fs::write(&live, "").unwrap();
        let marked = PathBuf::from(format!("{} (deleted)", live.display()));
        assert_eq!(without_deleted_mark(&marked), live);
    }

    #[test]
    fn a_file_really_named_with_the_mark_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let named = dir.path().join("agent-console (deleted)");
        std::fs::write(&named, "").unwrap();
        assert_eq!(without_deleted_mark(&named), named);
    }

    #[test]
    fn a_path_without_the_mark_is_left_alone() {
        let path = Path::new("/nowhere/agent-console");
        assert_eq!(without_deleted_mark(path), path);
    }

    /// The kernel side, on a real process: a binary replaced while it runs is read back marked, and the
    /// mark comes off to name the replacement.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_running_binary_replaced_under_it_reads_back_as_its_own_path() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("sleeper");
        std::fs::copy("/bin/sleep", &exe).unwrap();
        let mut child = std::process::Command::new(&exe).arg("30").spawn().unwrap();
        let link = PathBuf::from(format!("/proc/{}/exe", child.id()));
        // The child has exec'd once its link names the copy rather than this test's binary.
        let mut read = std::fs::read_link(&link).unwrap();
        for _ in 0..200 {
            if read.starts_with(dir.path()) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
            read = std::fs::read_link(&link).unwrap();
        }
        let fresh = dir.path().join("sleeper.new");
        std::fs::copy("/bin/sleep", &fresh).unwrap();
        std::fs::rename(&fresh, &exe).unwrap();
        let replaced = std::fs::read_link(&link).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(replaced, PathBuf::from(format!("{} (deleted)", exe.display())));
        assert_eq!(without_deleted_mark(&replaced), exe);
    }
}
