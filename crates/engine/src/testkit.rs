//! What the engine's unit tests build pools from: a git pool in a temporary directory, a stub harness
//! scripted per Ticket, and a checkpoint store in memory that can fail on demand.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::watch;

use ac_core::checkpoints::CheckpointStore;
use ac_core::harness::{Harness, Harnesses};
use ac_protocol::{RunPhase, TicketEvent, TicketEventKind};

use crate::actor::{Engine, SnapshotPublisher};
use crate::options::RunOptions;
use crate::session::{Session, SessionBase};
use crate::snapshot::PoolSnapshot;

/// A checkpoint store in memory: every write is kept, and the next `fail` writes fail.
#[derive(Clone, Default)]
pub struct MemoryStore {
    pub writes: Arc<Mutex<Vec<Value>>>,
    pub fail: Arc<AtomicU32>,
    pub closed: Arc<AtomicU32>,
}

impl CheckpointStore for MemoryStore {
    fn write(&mut self, state: &Value) -> anyhow::Result<()> {
        if self
            .fail
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            anyhow::bail!("database is locked");
        }
        self.writes.lock().unwrap().push(state.clone());
        Ok(())
    }

    fn latest(&mut self) -> anyhow::Result<Option<Value>> {
        Ok(self.writes.lock().unwrap().last().cloned())
    }

    fn close(&mut self) {
        self.closed.fetch_add(1, Ordering::SeqCst);
    }
}

/// A session with nothing in it, over a directory that need not exist.
pub fn bare_session(publisher: SnapshotPublisher) -> Session {
    let (_, terminal_reconcile) = watch::channel(true);
    let runs = "/nonexistent/runs";
    Session::new(SessionBase {
        publisher,
        pool_dir: "/nonexistent".into(),
        runs_dir: runs.into(),
        cwd: "/nonexistent".into(),
        git: false,
        harnesses: Harnesses::defaults(),
        config: ac_core::config::PoolConfig::default(),
        store: Box::new(MemoryStore::default()),
        machine_defaults: ac_core::machine_defaults::default_machine_defaults_paths("/nonexistent"),
        herdr_socket: "/nonexistent/herdr.sock".into(),
        spawn_proposals: ac_core::spawn_proposals::load_spawn_proposals(Path::new(runs)).unwrap(),
        terminal_reconcile,
    })
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// One Ticket file's text.
pub fn ticket_text(id: &str, blocked_by: &[&str], status: &str) -> String {
    let blocked = if blocked_by.is_empty() {
        "none".to_owned()
    } else {
        blocked_by.join(",")
    };
    format!(
        "<!-- state: id={id} blocked-by={blocked} status={status} -->\n\n# {id}: ticket {id}\n\nDo {id}.\n"
    )
}

/// The stub harness's script for one Ticket's launches: exit code, the outcome JSON (verbatim), and a
/// shell line run first in the attempt's directory.
#[derive(Debug, Clone, Default)]
pub struct Script {
    pub exit: i32,
    pub outcome: Option<String>,
    pub work: Option<String>,
}

impl Script {
    pub fn done(summary: &str) -> Self {
        Script {
            exit: 0,
            outcome: Some(format!(
                r#"{{"status":"done","summary":"{summary}","commitSha":null}}"#
            )),
            work: None,
        }
    }

    pub fn checkpoint(brief: &str) -> Self {
        Script {
            exit: 0,
            outcome: Some(format!(
                r#"{{"status":"checkpoint","summary":"paused","commitSha":null,"brief":"{brief}"}}"#
            )),
            work: None,
        }
    }

    pub fn crash(code: i32) -> Self {
        Script {
            exit: code,
            outcome: None,
            work: None,
        }
    }

    pub fn with_work(mut self, work: &str) -> Self {
        self.work = Some(work.to_owned());
        self
    }
}

/// A git pool in a temporary directory: the pool directory is the repository.
pub struct Pool {
    pub dir: tempfile::TempDir,
    pub path: String,
    /// Each Ticket's scripted launches, in order; the last repeats.
    pub scripts: Arc<Mutex<HashMap<String, Vec<Script>>>>,
    pub store: MemoryStore,
}

impl Pool {
    /// A git pool with these Tickets, each `(id, blocked-by)`, committed, and console.json naming the
    /// stub harness as the default.
    pub fn git(tickets: &[(&str, &[&str])]) -> Pool {
        let dir = tempfile::Builder::new()
            .prefix("engine-pool-")
            .tempdir()
            .unwrap();
        let path = ac_core::js::canonical_dir(&dir.path().to_string_lossy());
        let root = Path::new(&path);
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@example.com"]);
        git(root, &["config", "user.name", "t"]);
        git(root, &["config", "commit.gpgsign", "false"]);
        std::fs::create_dir_all(root.join("issues")).unwrap();
        for (id, blocked) in tickets {
            std::fs::write(
                root.join("issues").join(format!("{id}.md")),
                ticket_text(id, blocked, "ready"),
            )
            .unwrap();
        }
        std::fs::write(
            root.join("console.json"),
            r#"{"defaults": {"harness": "stub", "model": "m"}}"#,
        )
        .unwrap();
        std::fs::write(root.join(".gitignore"), "runs/\nconsole.db*\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-qm", "pool"]);
        Pool {
            dir,
            path,
            scripts: Arc::new(Mutex::new(HashMap::new())),
            store: MemoryStore::default(),
        }
    }

    pub fn script(&self, id: &str, launches: Vec<Script>) {
        self.scripts.lock().unwrap().insert(id.to_owned(), launches);
    }

    pub fn file(&self, rel: &str) -> PathBuf {
        Path::new(&self.path).join(rel)
    }

    pub fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.file(rel)).unwrap()
    }

    pub fn events(&self, id: &str) -> Vec<TicketEvent> {
        ac_core::events::read_events(&self.file("runs"), id)
            .iter()
            .map(|e| (**e).clone())
            .collect()
    }

    pub fn kinds(&self, id: &str) -> Vec<TicketEventKind> {
        self.events(id).iter().map(|e| e.kind).collect()
    }

    // The stub: a shell command that runs the Ticket's next scripted launch, keyed by how many
    // launches of the Ticket came before.
    fn harness(&self) -> Harness {
        let scripts = Arc::clone(&self.scripts);
        let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
        Harness::Custom(Arc::new(move |ctx| {
            let n = {
                let mut counts = counts.lock().unwrap();
                let n = counts.entry(ctx.id.clone()).or_default();
                *n += 1;
                *n
            };
            let script = scripts
                .lock()
                .unwrap()
                .get(&ctx.id)
                .and_then(|launches| launches.get(n - 1).or(launches.last()).cloned())
                .unwrap_or_else(|| Script::done(&format!("did {}", ctx.id)));
            let mut sh = String::new();
            if let Some(work) = &script.work {
                sh.push_str(work);
                sh.push('\n');
            }
            sh.push_str("echo \"stub ran $STUB_ID\"\n");
            if let Some(outcome) = &script.outcome {
                sh.push_str(&format!(
                    "cat > \"$STUB_OUTCOME\" <<'OUTCOME'\n{outcome}\nOUTCOME\n"
                ));
            }
            sh.push_str(&format!("exit {}\n", script.exit));
            vec![
                "env".into(),
                format!("STUB_ID={}", ctx.id),
                format!("STUB_OUTCOME={}", ctx.outcome_path),
                "sh".into(),
                "-c".into(),
                sh,
            ]
        }))
    }

    pub fn options(&self) -> RunOptions {
        let mut options =
            RunOptions::new(&self.path, self.dir.path().join("home").to_string_lossy());
        let mut harnesses = Harnesses::default();
        harnesses.insert("stub", self.harness());
        options.harnesses = Some(harnesses);
        options.parent_env = Arc::new(std::env::vars().collect());
        options.store = Some(Box::new(self.store.clone()));
        options
    }

    pub async fn start(&self) -> Engine {
        crate::boot::start_pool(self.options()).await.unwrap()
    }
}

/// The settled phase, waited for at most 30 s.
pub async fn settled(engine: &Engine) -> RunPhase {
    tokio::time::timeout(Duration::from_secs(30), engine.settled())
        .await
        .expect("the pool settles")
        .unwrap()
}

/// The last emitted snapshot.
pub fn last(engine: &Engine) -> Arc<PoolSnapshot> {
    engine.snapshot().expect("a snapshot was emitted")
}
