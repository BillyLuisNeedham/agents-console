//! The checkpoint store (engine/checkpoints.ts): the pool state after every super-step, one row each in
//! the `checkpoints` table of `<pool>/console.db`, so a restart resumes from the latest. The schema,
//! the rows and the state's JSON text are the TypeScript's own, so a pool moves from the Bun server to
//! this one and back without a migration.

use std::path::Path;
use std::time::Duration;

use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::js;

/// The checkpoint store seam (spec no-silent-dead-drives): the pool takes any store with this shape at
/// start, so a test can substitute one whose write fails on demand. The drive treats a failed write as
/// recoverable, never as a reason to close the store.
pub trait CheckpointStore: Send {
    /// Record the pool state as the newest checkpoint.
    fn write(&mut self, state: &Value) -> Result<()>;
    /// The newest checkpoint's state, or `None` when the pool has none.
    fn latest(&mut self) -> Result<Option<Value>>;
    fn close(&mut self);
}

/// The table, exactly as the TypeScript creates it.
pub const CREATE_TABLE: &str = "CREATE TABLE IF NOT EXISTS checkpoints (\
                                seq INTEGER PRIMARY KEY AUTOINCREMENT, \
                                at TEXT NOT NULL, \
                                state TEXT NOT NULL\
                                )";

/// The store on `<pool>/console.db`.
#[derive(Debug)]
pub struct SqliteCheckpointStore {
    db: Option<Connection>,
}

impl SqliteCheckpointStore {
    /// Open (creating) `<pool>/console.db` and its table.
    pub fn open(pool_dir: &Path) -> Result<Self> {
        let db = Connection::open(pool_dir.join("console.db"))?;
        // Bun's SQLite waits for no lock, where rusqlite would wait five seconds: a locked database
        // fails the write at once, and the drive's retry and its persistence Interrupt take it from
        // there, as they do on Bun.
        db.busy_timeout(Duration::ZERO)?;
        db.execute(CREATE_TABLE, [])?;
        Ok(SqliteCheckpointStore { db: Some(db) })
    }

    fn db(&self) -> Result<&Connection> {
        self.db
            .as_ref()
            .ok_or_else(|| anyhow!("Cannot use a closed database"))
    }
}

impl CheckpointStore for SqliteCheckpointStore {
    fn write(&mut self, state: &Value) -> Result<()> {
        self.db()?.execute(
            "INSERT INTO checkpoints (at, state) VALUES (?, ?)",
            (js::now_iso(), js::stringify(state)),
        )?;
        Ok(())
    }

    fn latest(&mut self) -> Result<Option<Value>> {
        let row: Option<String> = self
            .db()?
            .query_row(
                "SELECT state FROM checkpoints ORDER BY seq DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(row.map(|state| js::parse(&state)).transpose()?)
    }

    fn close(&mut self) {
        if let Some(db) = self.db.take() {
            let _ = db.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::process::Command;

    fn temp_pool() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("checkpoints-")
            .tempdir()
            .unwrap()
    }

    fn state(n: u64) -> Value {
        json!({
            "tickets": {"01": "done", "01-spawn-1": "ready"},
            "log": [format!("line {n}"), "é ✓ \"quoted\""],
            "outcomes": {"01": {"status": "done", "summary": "s", "commitSha": null, "score": 0.6}},
            "interrupts": [],
            "reviewApproved": false,
        })
    }

    #[test]
    fn reads_back_the_newest_checkpoint_and_none_before_the_first() {
        let pool = temp_pool();
        let mut store = SqliteCheckpointStore::open(pool.path()).unwrap();
        assert_eq!(store.latest().unwrap(), None);
        store.write(&state(1)).unwrap();
        store.write(&state(2)).unwrap();
        assert_eq!(store.latest().unwrap(), Some(state(2)));
        store.close();
        assert_eq!(
            store.write(&state(3)).unwrap_err().to_string(),
            "Cannot use a closed database"
        );
        let mut again = SqliteCheckpointStore::open(pool.path()).unwrap();
        assert_eq!(again.latest().unwrap(), Some(state(2)));
    }

    #[test]
    fn writes_the_rows_the_typescript_writes() {
        let pool = temp_pool();
        let mut store = SqliteCheckpointStore::open(pool.path()).unwrap();
        store.write(&json!({"n": 1.0, "x": [1e21]})).unwrap();
        store.close();
        let db = Connection::open(pool.path().join("console.db")).unwrap();
        let schema: String = db
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = 'checkpoints'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            schema,
            "CREATE TABLE checkpoints (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, state TEXT NOT NULL)"
        );
        let (seq, at, text): (i64, String, String) = db
            .query_row("SELECT seq, at, state FROM checkpoints", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(seq, 1);
        assert_eq!(at.len(), 24);
        assert_eq!(text, r#"{"n":1,"x":[1e+21]}"#);
    }

    #[test]
    fn reads_a_store_the_typescript_schema_wrote() {
        let pool = temp_pool();
        let db = Connection::open(pool.path().join("console.db")).unwrap();
        db.execute(
            "CREATE TABLE IF NOT EXISTS checkpoints (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, state TEXT NOT NULL)",
            [],
        )
        .unwrap();
        for n in [1, 2] {
            db.execute(
                "INSERT INTO checkpoints (at, state) VALUES (?, ?)",
                ("2026-10-04T09:30:21.394Z", js::stringify(&state(n))),
            )
            .unwrap();
        }
        drop(db);
        let mut store = SqliteCheckpointStore::open(pool.path()).unwrap();
        assert_eq!(store.latest().unwrap(), Some(state(2)));
        store.write(&state(3)).unwrap();
        assert_eq!(store.latest().unwrap(), Some(state(3)));
    }

    #[test]
    fn fails_a_write_at_once_while_another_holds_the_lock() {
        let pool = temp_pool();
        let mut store = SqliteCheckpointStore::open(pool.path()).unwrap();
        let holder = Connection::open(pool.path().join("console.db")).unwrap();
        holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            store.write(&state(1)).unwrap_err().to_string(),
            "database is locked"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        holder.execute_batch("COMMIT").unwrap();
        store.write(&state(1)).unwrap();
    }

    // The store moves Bun -> Rust -> Bun: the TypeScript's own store writes what this one reads, and
    // reads what this one writes. Skipped where no Bun is installed.
    #[test]
    fn round_trips_with_the_typescript_store_through_bun() {
        let home = std::env::var("HOME").unwrap_or_default();
        let bun = [format!("{home}/.bun/bin/bun"), "bun".to_owned()]
            .into_iter()
            .find(|bun| {
                Command::new(bun)
                    .arg("--version")
                    .output()
                    .is_ok_and(|o| o.status.success())
            });
        let Some(bun) = bun else {
            eprintln!("no bun: skipping the Bun round trip");
            return;
        };
        let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../engine/checkpoints.ts");
        let pool = temp_pool();
        let script = pool.path().join("bun-store.ts");
        std::fs::write(
            &script,
            format!(
                "import {{ SqliteCheckpointStore }} from {module:?};\n\
                 const store = new SqliteCheckpointStore(process.argv[2]);\n\
                 if (process.argv[3] === 'write') store.write(JSON.parse(process.argv[4]));\n\
                 else console.log(JSON.stringify(store.latest()));\n\
                 store.close();\n",
                module = module.display().to_string()
            ),
        )
        .unwrap();
        let run = |args: &[&str]| {
            let out = Command::new(&bun).arg(&script).args(args).output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8(out.stdout).unwrap()
        };
        let pool_dir = pool.path().to_str().unwrap();
        run(&[pool_dir, "write", &js::stringify(&state(1))]);
        let mut store = SqliteCheckpointStore::open(pool.path()).unwrap();
        assert_eq!(store.latest().unwrap(), Some(state(1)));
        store.write(&state(2)).unwrap();
        store.close();
        let read = run(&[pool_dir, "read"]);
        assert_eq!(js::parse(read.trim()).unwrap(), state(2));
    }
}
