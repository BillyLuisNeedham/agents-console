//! The pool lock (server.ts `acquirePoolLock`): one server per pool. If runs/server.pid names a live
//! process, the start is refused with a message naming that pid, its fleet-registry port when known, and
//! the pool directory. Otherwise the pool is claimed by writing our own pid. There is no force override:
//! a live lock always means use the running console or kill it.
//!
//! The claim is atomic (an exclusive create), so two near-simultaneous launches of the same pool cannot
//! both pass. A stale lock is cleared only when it still names a dead pid or is still unreadable after a
//! beat, so a lock another server is mid-way through claiming is never trampled.

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use ac_core::fleet::{pid_is_live, read_fleet_entry};
use ac_core::js;

/// How many times a claim is tried before giving up.
const CLAIM_ATTEMPTS: usize = 5;

/// How long an empty lock is given for its writer's pid to land.
const EMPTY_LOCK_BEAT: Duration = Duration::from_millis(25);

fn lock_path(pool_dir: &str) -> PathBuf {
    Path::new(pool_dir).join("runs").join("server.pid")
}

/// The pid runs/server.pid names, when it names a positive whole number.
pub fn read_locked_pid(pool_dir: &str) -> Option<f64> {
    let raw = std::fs::read(lock_path(pool_dir)).ok()?;
    let pid = js::number_from_text(js::trim(&js::decode_utf8(&raw)));
    (pid.is_finite() && pid.fract() == 0.0 && pid > 0.0).then_some(pid)
}

fn own_pid() -> f64 {
    f64::from(std::process::id())
}

/// Claim the pool for this process, or refuse naming the live holder.
pub fn acquire_pool_lock(pool_dir: &str, registry_path: &str) -> Result<(), String> {
    let path = lock_path(pool_dir);
    js::mkdir_all(Path::new(pool_dir).join("runs")).map_err(|err| err.to_string())?;
    for _ in 0..CLAIM_ATTEMPTS {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                return file
                    .write_all(format!("{}\n", std::process::id()).as_bytes())
                    .map_err(|err| js::FsError::new(&err, "write", &path).to_string());
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {}
            Err(err) => return Err(js::FsError::new(&err, "open", &path).to_string()),
        }
        if let Some(holder) = read_locked_pid(pool_dir) {
            if pid_is_live(holder) {
                let port = read_fleet_entry(registry_path, pool_dir, holder as u32)
                    .map(|entry| format!(" on port {}", entry.port_text()))
                    .unwrap_or_default();
                return Err(format!(
                    "pool {pool_dir} is locked by live server pid {}{port}; open the running console or kill it",
                    js::number_string(holder)
                ));
            }
            // A dead holder is a stale lock. Remove it only if it still names the same dead pid on
            // re-read: a live server may have claimed it since.
            if read_locked_pid(pool_dir) == Some(holder) {
                let _ = std::fs::remove_file(&path);
            }
            continue;
        }
        // Empty or unreadable: a writer may be mid-claim, its pid landing within microseconds. Wait a
        // beat and re-read; a lock still empty afterwards is garbage from a crashed or bogus earlier
        // state, and is cleared.
        std::thread::sleep(EMPTY_LOCK_BEAT);
        if read_locked_pid(pool_dir).is_none() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Err(format!(
        "pool {pool_dir}: could not claim the pool lock after five attempts"
    ))
}

/// Release the pool lock, only if it still names this process: a relaunch that already reclaimed the
/// pool must keep its lock. A crash still leaves the file, and the next boot's stale-lock check clears
/// it.
pub fn release_pool_lock(pool_dir: &str) {
    if read_locked_pid(pool_dir) == Some(own_pid()) {
        let _ = std::fs::remove_file(lock_path(pool_dir));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        (dir, path)
    }

    fn lock_text(pool: &str) -> String {
        std::fs::read_to_string(lock_path(pool)).unwrap()
    }

    #[test]
    fn claims_a_free_pool_and_releases_only_its_own_lock() {
        let (_dir, pool) = pool();
        acquire_pool_lock(&pool, "/nonexistent/pools.json").unwrap();
        assert_eq!(lock_text(&pool), format!("{}\n", std::process::id()));
        release_pool_lock(&pool);
        assert!(!lock_path(&pool).exists());
        std::fs::write(lock_path(&pool), "1\n").unwrap();
        release_pool_lock(&pool);
        assert!(lock_path(&pool).exists(), "another pid's lock survives");
    }

    // server.test.ts:2198: a pid file that is not a positive integer is taken over.
    #[test]
    fn takes_over_a_lock_that_names_no_positive_pid() {
        for content in ["0", "-1", "not-a-pid", ""] {
            let (_dir, pool) = pool();
            std::fs::create_dir_all(Path::new(&pool).join("runs")).unwrap();
            std::fs::write(lock_path(&pool), content).unwrap();
            acquire_pool_lock(&pool, "/nonexistent/pools.json").unwrap();
            assert_eq!(lock_text(&pool), format!("{}\n", std::process::id()));
        }
    }

    #[test]
    fn refuses_a_live_holder_naming_its_pid_and_the_pool() {
        let (_dir, pool) = pool();
        std::fs::create_dir_all(Path::new(&pool).join("runs")).unwrap();
        // Our parent is alive for as long as this test runs.
        let parent = std::os::unix::process::parent_id();
        std::fs::write(lock_path(&pool), format!("{parent}\n")).unwrap();
        assert_eq!(
            acquire_pool_lock(&pool, "/nonexistent/pools.json"),
            Err(format!(
                "pool {pool} is locked by live server pid {parent}; open the running console or kill it"
            ))
        );
    }
}
