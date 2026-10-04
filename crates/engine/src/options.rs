//! What starts a pool (engine.ts `RunOptions`): every option the TypeScript takes, with its default.
//! Only the CLI reads the environment (ADR-0036), so what the TypeScript read from `process.env` or
//! `os.homedir()` at the point of use arrives here as a value: the home directory the Machine defaults
//! and the herdr socket default from, and the environment every harness child inherits.

use std::sync::Arc;

use ac_core::checkpoints::CheckpointStore;
use ac_core::harness::Harnesses;

use crate::jev::Jev;
use crate::pane_session::LaunchCadence;
use crate::snapshot::PoolSnapshot;

/// A test's hook on every emitted snapshot (`onSnapshot`); the server reads the watch channel instead.
pub type SnapshotHook = Arc<dyn Fn(&Arc<PoolSnapshot>) + Send + Sync>;

/// How a pool run starts.
pub struct RunOptions {
    pub pool_dir: String,
    /// Harnesses beyond (or replacing) the defaults, by name: `{ ...defaultHarnesses, ...harnesses }`.
    pub harnesses: Option<Harnesses>,
    pub on_snapshot: Option<SnapshotHook>,
    /// The home directory (`os.homedir()`), read by the CLI: the Machine defaults files and the herdr
    /// socket's default live under it.
    pub home: String,
    /// The environment a harness child inherits (`process.env`), read by the CLI.
    pub parent_env: Arc<Vec<(String, String)>>,
    /// The legacy `~/.issue-runner` file, still the fallback for a harness or model the Machine
    /// defaults file does not carry. Tests point it at a temp file.
    pub issue_runner_path: Option<String>,
    /// The Machine defaults file (issue #121), which wins field by field over the legacy one above.
    pub machine_defaults_path: Option<String>,
    /// The Machine defaults files whole, in place of the ones under `home` (the server passes its
    /// own); the two overrides above still apply over them.
    pub machine_defaults: Option<ac_core::machine_defaults::MachineDefaultsPaths>,
    /// The checkpoint store seam: tests substitute a store whose write fails on demand. Defaults to
    /// the real SQLite store on `<pool>/console.db`.
    pub store: Option<Box<dyn CheckpointStore>>,
    /// The herdr daemon socket for terminal-backed attempts; the default is the daemon's path under
    /// `home`.
    pub herdr_socket: Option<String>,
    /// The launch half's timings (pane-session.ts), for a test that drives a Botched launch fast.
    pub launch_cadence: Option<LaunchCadence>,
    /// How often an enlisted attempt re-reads its pane for Turn state (2 s unset).
    pub enlist_poll_ms: Option<u64>,
    /// How often a live Conversation's tick re-reads its pane (2 s unset).
    pub conversation_poll_ms: Option<u64>,
    /// How long an enlist waits for a working pane to reach waiting before refusing.
    pub enlist_teaching_wait_ms: Option<u64>,
    /// How often the pane survey lists herdr's panes (15 s unset).
    pub pane_survey_ms: Option<u64>,
    /// The herdr workspace the server was launched in (issue #94), the second candidate for the Pool
    /// workspace after the id this pool remembers.
    pub herdr_workspace: Option<String>,
    /// Force-allow an empty issues/ even when the pool has no conversations/ directory yet.
    pub allow_empty_issues: bool,
    /// Jev (ADR-0020), built at the CLI boundary from the key; absent, the unconfigured port.
    pub jev: Option<Jev>,
    /// Where Jev's TypeSafe calls go (`JEV_BASE_URL`), for the verify port's client. STUB(verify).
    pub jev_base_url: Option<String>,
    /// The Console's URL when a server runs this engine (ADR-0030).
    pub console_url: Option<String>,
    /// How many emitted snapshots the engine keeps, newest last (issue #157); `None` keeps them all.
    pub snapshot_history: Option<usize>,
}

impl RunOptions {
    /// The options for a pool with every other field at its default.
    pub fn new(pool_dir: impl Into<String>, home: impl Into<String>) -> Self {
        RunOptions {
            pool_dir: pool_dir.into(),
            harnesses: None,
            on_snapshot: None,
            home: home.into(),
            parent_env: Arc::new(Vec::new()),
            issue_runner_path: None,
            machine_defaults_path: None,
            machine_defaults: None,
            store: None,
            herdr_socket: None,
            launch_cadence: None,
            enlist_poll_ms: None,
            conversation_poll_ms: None,
            enlist_teaching_wait_ms: None,
            pane_survey_ms: None,
            herdr_workspace: None,
            allow_empty_issues: false,
            jev: None,
            jev_base_url: None,
            console_url: None,
            snapshot_history: None,
        }
    }
}
