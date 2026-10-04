//! The fleet registry (fleet.ts): a machine-wide JSON file recording every live Console server, so any
//! of them can be found by pool directory. Servers upsert their own entry after binding; hygiene is
//! entirely prune-on-read. A stopping server never touches the registry (ADR-0017), because cleanup
//! under kill -9 would be unreliable anyway, so a dead pid or a deleted pool directory only drops from
//! view on the next read. There is no unregistering.
//!
//! The registry's location is computed from a home directory the caller passes in: only the CLI reads
//! the environment.

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::config::ConfigError;
use crate::js;

/// The line the fleet list prints when no Console is live.
pub const NO_LIVE_CONSOLES: &str = "no live consoles";

/// How long a registry write waits on a foreign lock before giving up.
pub const FLEET_LOCK_TIMEOUT: Duration = Duration::from_millis(10_000);

// How long a registry write sleeps between looks at a held lock.
const FLEET_LOCK_POLL: Duration = Duration::from_millis(10);

/// One Console server's entry. The registry keeps whatever else an entry carries: the raw object is
/// what a rewrite writes back, so a key this server does not know survives.
#[derive(Debug, Clone, PartialEq)]
pub struct FleetEntry {
    pub pool_dir: String,
    /// The bound port, as the file has it (a JavaScript number).
    pub port: f64,
    /// The server's pid, as the file has it (a JavaScript number).
    pub pid: f64,
    pub started_at: String,
    raw: Map<String, Value>,
}

impl FleetEntry {
    /// A server's own entry, as it registers itself after the bind.
    pub fn new(pool_dir: &str, port: u64, pid: u32, started_at: &str) -> Self {
        let mut raw = Map::new();
        raw.insert("poolDir".to_owned(), Value::from(pool_dir));
        raw.insert("port".to_owned(), Value::from(port));
        raw.insert("pid".to_owned(), Value::from(pid));
        raw.insert("startedAt".to_owned(), Value::from(started_at));
        FleetEntry {
            pool_dir: pool_dir.to_owned(),
            port: port as f64,
            pid: f64::from(pid),
            started_at: started_at.to_owned(),
            raw,
        }
    }

    /// The entry as the registry holds it, unknown keys included.
    pub fn to_value(&self) -> Value {
        Value::Object(self.raw.clone())
    }

    /// The port as JavaScript prints it, for the lines and messages that name it.
    pub fn port_text(&self) -> String {
        js::number_string(self.port)
    }

    /// The pid as JavaScript prints it.
    pub fn pid_text(&self) -> String {
        js::number_string(self.pid)
    }

    // An entry of the right shape: poolDir and startedAt strings, port and pid numbers.
    fn of(value: Value) -> Option<Self> {
        let Value::Object(raw) = value else {
            return None;
        };
        let pool_dir = raw.get("poolDir")?.as_str()?.to_owned();
        let port = js::number_of(raw.get("port")?)?;
        let pid = js::number_of(raw.get("pid")?)?;
        let started_at = raw.get("startedAt")?.as_str()?.to_owned();
        Some(FleetEntry {
            pool_dir,
            port,
            pid,
            started_at,
            raw,
        })
    }
}

/// The registry's machine-wide location under a home directory, outside any repo.
pub fn default_registry_path(home: &str) -> String {
    js::path_join(&[home, ".agent-graphs", "pools.json"])
}

// The raw registry: every entry of the right shape. A missing or corrupt file, or one that is not an
// array, reads as empty.
fn read_registry(registry_path: &str) -> Vec<FleetEntry> {
    let Ok(text) = js::read_text(registry_path) else {
        return Vec::new();
    };
    match js::parse(&text) {
        Ok(Value::Array(items)) => items.into_iter().filter_map(FleetEntry::of).collect(),
        _ => Vec::new(),
    }
}

/// `process.kill(pid, 0)` succeeds, or fails only for want of permission: the process exists. A pid
/// JavaScript would refuse to signal (not a 32-bit integer) is no live process.
pub fn pid_is_live(pid: f64) -> bool {
    if pid.fract() != 0.0 || pid < f64::from(i32::MIN) || pid > f64::from(i32::MAX) {
        return false;
    }
    // SAFETY: kill with signal 0 sends nothing; it only checks that the pid can be signalled.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Read the fleet, pruning before returning: entries whose pid is dead or whose pool directory no
/// longer exists are dropped. A missing or corrupt registry reads as empty. The file is never
/// rewritten by a read.
pub fn read_fleet_entries(registry_path: &str) -> Vec<FleetEntry> {
    read_registry(registry_path)
        .into_iter()
        .filter(|entry| pid_is_live(entry.pid) && js::exists(&entry.pool_dir))
        .collect()
}

/// Best-effort lookup of a live entry by pool directory and pid, used to enrich a pool-lock refusal
/// with the live server's port. The directory matches by exact string. An absent, corrupt or unmatched
/// registry yields `None`.
pub fn read_fleet_entry(registry_path: &str, pool_dir: &str, pid: u32) -> Option<FleetEntry> {
    read_fleet_entries(registry_path)
        .into_iter()
        .find(|entry| entry.pool_dir == pool_dir && entry.pid == f64::from(pid))
}

/// Best-effort lookup of a live entry by port, used to name the holder on a busy pinned port.
pub fn read_fleet_entry_by_port(registry_path: &str, port: u64) -> Option<FleetEntry> {
    read_fleet_entries(registry_path)
        .into_iter()
        .find(|entry| entry.port == port as f64)
}

/// The lines the fleet list command prints, in registry order: one per live pool as
/// `poolDir → http://localhost:<port>`, or the no-live-consoles line when the pruned registry is empty.
pub fn list_fleet(registry_path: &str) -> Vec<String> {
    let entries = read_fleet_entries(registry_path);
    if entries.is_empty() {
        return vec![NO_LIVE_CONSOLES.to_owned()];
    }
    entries
        .iter()
        .map(|entry| {
            format!(
                "{} → http://localhost:{}",
                entry.pool_dir,
                entry.port_text()
            )
        })
        .collect()
}

// The pid named in a lock file, or None when it is empty or unreadable.
fn read_lock_pid(lock_path: &str) -> Option<f64> {
    let text = js::read_text(lock_path).ok()?;
    let pid = js::number_from_text(js::trim(&text));
    (pid.is_finite() && pid.fract() == 0.0 && pid > 0.0).then_some(pid)
}

/// Upsert one Console's entry, keyed by pool directory: relaunching the same pool replaces its old
/// entry rather than duplicating it, and every other entry is left exactly as it was (the registry is
/// never pruned on write; only entries of the wrong shape drop out). A missing or corrupt registry file
/// is recreated, never an error.
///
/// Writes are serialized with a lock file claimed with O_EXCL, so two servers booting different pools
/// at the same moment cannot lose one entry, and the registry is replaced by rename so a reader never
/// sees a half-written file. A lock whose holder pid is dead is a crashed writer's and is cleared at
/// once; a live holder is waited on, polling every 10 ms, for up to FLEET_LOCK_TIMEOUT; an empty lock
/// (a writer mid-claim) is cleared only once that deadline has passed. Blocks the calling thread while
/// it waits, as the TypeScript's `Bun.sleepSync` did.
pub fn upsert_fleet_entry(registry_path: &str, entry: &FleetEntry) -> Result<(), ConfigError> {
    let lock_path = format!("{registry_path}.lock");
    let dir = std::path::Path::new(registry_path)
        .parent()
        .map(|dir| dir.to_string_lossy().into_owned())
        .filter(|dir| !dir.is_empty())
        .unwrap_or_else(|| ".".to_owned());
    js::mkdir_all(&dir).map_err(ConfigError::from)?;
    let deadline = Instant::now() + FLEET_LOCK_TIMEOUT;
    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut lock) => {
                let claimed = lock
                    .write_all(format!("{}\n", std::process::id()).as_bytes())
                    .map_err(|err| {
                        ConfigError(js::FsError::new(&err, "write", &lock_path).to_string())
                    });
                drop(lock);
                let written = claimed.and_then(|()| write_registry(registry_path, entry));
                let _ = std::fs::remove_file(&lock_path);
                return written;
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {}
            Err(err) => {
                return Err(ConfigError(
                    js::FsError::new(&err, "open", &lock_path).to_string(),
                ));
            }
        }
        match read_lock_pid(&lock_path) {
            Some(holder) if pid_is_live(holder) => {
                if Instant::now() > deadline {
                    return Err(ConfigError(format!(
                        "fleet registry: lock {lock_path} is held by live pid {}",
                        js::number_string(holder)
                    )));
                }
                std::thread::sleep(FLEET_LOCK_POLL);
            }
            // The holder's process is gone: a crashed writer. Clear its lock.
            Some(_) => {
                let _ = std::fs::remove_file(&lock_path);
            }
            // Empty or unreadable: a writer is mid-claim, its pid appears within microseconds. A lock
            // still empty past the deadline is a crashed writer's, so clear it and retry.
            None => {
                if Instant::now() > deadline {
                    let _ = std::fs::remove_file(&lock_path);
                } else {
                    std::thread::sleep(FLEET_LOCK_POLL);
                }
            }
        }
    }
}

// Under the lock: every other pool's entry as it was, this pool's replaced and put last, written to
// pools.json.tmp and renamed over the registry.
fn write_registry(registry_path: &str, entry: &FleetEntry) -> Result<(), ConfigError> {
    let mut entries: Vec<Value> = read_registry(registry_path)
        .into_iter()
        .filter(|existing| existing.pool_dir != entry.pool_dir)
        .map(|existing| existing.to_value())
        .collect();
    entries.push(entry.to_value());
    let temp_path = format!("{registry_path}.tmp");
    let text = js::stringify_pretty(&Value::Array(entries));
    js::write_through_rename(registry_path, &temp_path, &text).map_err(ConfigError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A real pid that has exited and been reaped, so it probes as dead.
    fn dead_pid() -> u32 {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    fn me() -> u32 {
        std::process::id()
    }

    struct World {
        dir: tempfile::TempDir,
    }

    impl World {
        fn new() -> Self {
            World {
                dir: tempfile::tempdir().unwrap(),
            }
        }

        fn path(&self, name: &str) -> String {
            self.dir.path().join(name).to_string_lossy().into_owned()
        }

        fn pool(&self, name: &str) -> String {
            let pool = self.path(name);
            std::fs::create_dir_all(&pool).unwrap();
            pool
        }

        fn registry(&self) -> String {
            self.path("pools.json")
        }
    }

    // fleet.test.ts: fleet registry upsert
    #[test]
    fn writes_the_entry_shape_on_registration() {
        let world = World::new();
        let pool = world.pool("pool");
        let entry = FleetEntry::new(&pool, 8787, me(), "t");
        upsert_fleet_entry(&world.registry(), &entry).unwrap();
        assert_eq!(read_fleet_entries(&world.registry()), [entry]);
        assert_eq!(
            std::fs::read_to_string(world.registry()).unwrap(),
            format!(
                "[\n  {{\n    \"poolDir\": {},\n    \"port\": 8787,\n    \"pid\": {},\n    \"startedAt\": \"t\"\n  }}\n]",
                json!(pool),
                me()
            )
        );
    }

    #[test]
    fn upserting_the_same_pool_replaces_its_entry_rather_than_duplicating() {
        let world = World::new();
        let pool = world.pool("pool");
        upsert_fleet_entry(&world.registry(), &FleetEntry::new(&pool, 8787, me(), "t1")).unwrap();
        upsert_fleet_entry(&world.registry(), &FleetEntry::new(&pool, 8799, me(), "t2")).unwrap();
        assert_eq!(
            read_fleet_entries(&world.registry()),
            [FleetEntry::new(&pool, 8799, me(), "t2")]
        );
    }

    #[test]
    fn upserting_one_pool_leaves_other_pools_entries_alone() {
        let world = World::new();
        let a = world.pool("a");
        let b = world.pool("b");
        upsert_fleet_entry(&world.registry(), &FleetEntry::new(&a, 8787, me(), "t")).unwrap();
        upsert_fleet_entry(&world.registry(), &FleetEntry::new(&b, 8788, me(), "t")).unwrap();
        assert_eq!(
            read_fleet_entries(&world.registry()),
            [
                FleetEntry::new(&a, 8787, me(), "t"),
                FleetEntry::new(&b, 8788, me(), "t")
            ]
        );
    }

    #[test]
    fn keeps_dead_entries_and_unknown_keys_on_write_dropping_only_malformed_ones() {
        let world = World::new();
        let pool = world.pool("pool");
        let other = world.pool("other");
        let dead = dead_pid();
        std::fs::write(
            world.registry(),
            json!([
                { "poolDir": other, "port": 8788.0, "pid": dead, "startedAt": "t", "extra": [1] },
                { "poolDir": 5, "port": 1, "pid": 1, "startedAt": "t" },
                "junk",
            ])
            .to_string(),
        )
        .unwrap();
        upsert_fleet_entry(&world.registry(), &FleetEntry::new(&pool, 8787, me(), "t")).unwrap();
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(world.registry()).unwrap()).unwrap();
        assert_eq!(
            written,
            json!([
                { "poolDir": other, "port": 8788, "pid": dead, "startedAt": "t", "extra": [1] },
                { "poolDir": pool, "port": 8787, "pid": me(), "startedAt": "t" },
            ])
        );
        assert!(
            std::fs::read_to_string(world.registry())
                .unwrap()
                .contains("\"port\": 8788,")
        );
    }

    #[test]
    fn creates_a_missing_registry_file_and_its_parent_directory() {
        let world = World::new();
        let pool = world.pool("pool");
        let registry = world.path("nested/.agent-graphs/pools.json");
        upsert_fleet_entry(&registry, &FleetEntry::new(&pool, 8787, me(), "t")).unwrap();
        assert_eq!(
            read_fleet_entries(&registry),
            [FleetEntry::new(&pool, 8787, me(), "t")]
        );
    }

    #[test]
    fn recreates_a_corrupt_registry_file_on_write_not_an_error() {
        let world = World::new();
        let pool = world.pool("pool");
        for corrupt in ["{ not json", r#"{"poolDir":"x"}"#] {
            std::fs::write(world.registry(), corrupt).unwrap();
            upsert_fleet_entry(&world.registry(), &FleetEntry::new(&pool, 8787, me(), "t"))
                .unwrap();
            assert_eq!(
                read_fleet_entries(&world.registry()),
                [FleetEntry::new(&pool, 8787, me(), "t")]
            );
        }
    }

    #[test]
    fn clears_a_lock_left_by_a_crashed_writer_and_upserts_anyway() {
        let world = World::new();
        let pool = world.pool("pool");
        let lock = format!("{}.lock", world.registry());
        std::fs::write(&lock, format!("{}\n", dead_pid())).unwrap();
        upsert_fleet_entry(&world.registry(), &FleetEntry::new(&pool, 8787, me(), "t")).unwrap();
        assert_eq!(
            read_fleet_entries(&world.registry()),
            [FleetEntry::new(&pool, 8787, me(), "t")]
        );
        assert!(!std::path::Path::new(&lock).exists());
    }

    #[test]
    fn replaces_the_registry_by_rename_leaving_no_temp_or_lock_file_behind() {
        let world = World::new();
        let pool = world.pool("pool");
        upsert_fleet_entry(&world.registry(), &FleetEntry::new(&pool, 8787, me(), "t")).unwrap();
        let mut names: Vec<_> = std::fs::read_dir(world.dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["pool", "pools.json"]);
    }

    // fleet.test.ts: fleet registry prune-on-read
    #[test]
    fn reads_a_missing_or_corrupt_registry_as_empty() {
        let world = World::new();
        assert!(read_fleet_entries(&world.registry()).is_empty());
        std::fs::write(world.registry(), "{ not json").unwrap();
        assert!(read_fleet_entries(&world.registry()).is_empty());
    }

    #[test]
    fn drops_an_entry_whose_pid_is_dead_or_whose_pool_directory_is_gone() {
        let world = World::new();
        let pool = world.pool("pool");
        let gone = world.path("gone");
        std::fs::write(
            world.registry(),
            json!([
                { "poolDir": pool, "port": 8787, "pid": dead_pid(), "startedAt": "t" },
                { "poolDir": gone, "port": 8787, "pid": me(), "startedAt": "t" },
            ])
            .to_string(),
        )
        .unwrap();
        assert!(read_fleet_entries(&world.registry()).is_empty());
    }

    #[test]
    fn keeps_an_entry_whose_pid_is_live_and_pool_directory_exists() {
        let world = World::new();
        let pool = world.pool("pool");
        let entry = json!({ "poolDir": pool, "port": 8787, "pid": me(), "startedAt": "t" });
        std::fs::write(world.registry(), json!([entry]).to_string()).unwrap();
        let read = read_fleet_entries(&world.registry());
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].to_value(), entry);
    }

    // fleet.test.ts: fleet registry readFleetEntry
    #[test]
    fn finds_an_entry_by_pool_and_pid_or_by_port_and_nothing_else() {
        let world = World::new();
        assert_eq!(read_fleet_entry(&world.registry(), "/pool", me()), None);
        std::fs::write(world.registry(), "{ not json").unwrap();
        assert_eq!(read_fleet_entry(&world.registry(), "/pool", me()), None);

        let pool = world.pool("pool");
        let other = world.pool("other");
        std::fs::write(
            world.registry(),
            json!([{ "poolDir": other, "port": 8788, "pid": me(), "startedAt": "t" }]).to_string(),
        )
        .unwrap();
        assert_eq!(read_fleet_entry(&world.registry(), &pool, me()), None);
        assert_eq!(
            read_fleet_entry_by_port(&world.registry(), 8788).map(|e| e.pool_dir),
            Some(other.clone())
        );
        assert_eq!(read_fleet_entry_by_port(&world.registry(), 8787), None);

        std::fs::write(
            world.registry(),
            json!([{ "poolDir": pool, "port": 8787, "pid": me(), "startedAt": "t" }]).to_string(),
        )
        .unwrap();
        assert_eq!(
            read_fleet_entry(&world.registry(), &pool, me()).map(|e| e.port_text()),
            Some("8787".to_owned())
        );
        // The directory matches by exact string, not by where it points.
        assert_eq!(
            read_fleet_entry(&world.registry(), &format!("{pool}/"), me()),
            None
        );

        let dead = dead_pid();
        std::fs::write(
            world.registry(),
            json!([{ "poolDir": pool, "port": 8787, "pid": dead, "startedAt": "t" }]).to_string(),
        )
        .unwrap();
        assert_eq!(read_fleet_entry(&world.registry(), &pool, dead), None);
    }

    // fleet-cli.test.ts
    #[test]
    fn lists_every_live_pool_one_per_line_in_registry_order() {
        let world = World::new();
        let a = world.pool("a");
        let b = world.pool("b");
        std::fs::write(
            world.registry(),
            json!([
                { "poolDir": a, "port": 8787, "pid": me(), "startedAt": "t" },
                { "poolDir": world.path("gone"), "port": 8790, "pid": me(), "startedAt": "t" },
                { "poolDir": b, "port": 8799, "pid": me(), "startedAt": "t" },
            ])
            .to_string(),
        )
        .unwrap();
        let before = std::fs::read(world.registry()).unwrap();
        assert_eq!(
            list_fleet(&world.registry()),
            [
                format!("{a} → http://localhost:8787"),
                format!("{b} → http://localhost:8799")
            ]
        );
        // The list never rewrites the registry it reads.
        assert_eq!(std::fs::read(world.registry()).unwrap(), before);
    }

    #[test]
    fn prints_the_no_live_consoles_line_for_an_absent_empty_or_fully_pruned_registry() {
        let world = World::new();
        assert_eq!(list_fleet(&world.registry()), [NO_LIVE_CONSOLES]);
        std::fs::write(world.registry(), "[]").unwrap();
        assert_eq!(list_fleet(&world.registry()), [NO_LIVE_CONSOLES]);
        let pool = world.pool("pool");
        std::fs::write(
            world.registry(),
            json!([{ "poolDir": pool, "port": 8787, "pid": dead_pid(), "startedAt": "t" }])
                .to_string(),
        )
        .unwrap();
        assert_eq!(list_fleet(&world.registry()), [NO_LIVE_CONSOLES]);
    }

    #[test]
    fn counts_a_pid_it_may_not_signal_as_live() {
        assert!(pid_is_live(f64::from(me())));
        assert!(!pid_is_live(f64::from(dead_pid())));
        assert!(!pid_is_live(1.5));
        // pid 1 belongs to root: kill answers EPERM, which still means the process exists.
        assert!(pid_is_live(1.0));
    }
}
