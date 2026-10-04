//! The pool server's state and lifecycle (server.ts `createPoolServer`): the pool lock, the bind, the
//! fleet registration, the enriched snapshot as of the engine's last emit, the pool meta and the caches
//! every read shares, the start, and the orderly stop.
//!
//! The TypeScript server is one event loop: everything between two awaits runs whole. Here the state
//! every route, socket and timer touches sits behind one mutex ([`Shared::inner`]), held only for
//! synchronous stretches and never across an await, so the same stretches stay atomic. The engine is
//! read without its actor: [`Engine::snapshot`] is the watch channel's latest emit.

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared as SharedFuture};
use indexmap::IndexMap;
use serde_json::Value;
use tokio::runtime::Handle;
use tokio::sync::{OnceCell, oneshot};

use ac_core::config::{PoolConfig, parse_config, read_config};
use ac_core::conversation_record::load_conversations;
use ac_core::fleet::{FleetEntry, read_fleet_entry_by_port, upsert_fleet_entry};
use ac_core::harness::Harnesses;
use ac_core::js;
use ac_core::machine_defaults::MachineDefaultsPaths;
use ac_core::pool::{TicketMarker, load_pool_tickets};
use ac_core::pool_settings::{SettingsContext, pool_settings_path, settings_payload};
use ac_core::pool_title::title_of;
use ac_engine::{Engine, EngineError, PoolOptions, PoolSnapshot};
use ac_io::herdr::Herdr;
use ac_protocol::{EnrichedSnapshot, HEARTBEAT_MS, SettingsResponse, TicketGradeSummary};

use crate::enrich::{enrich, pool_name_of};
use crate::hub::{self, HubState};
use crate::lock::{acquire_pool_lock, read_locked_pid, release_pool_lock};
use crate::ports::{DEFAULT_PORT, PortResolution, resolve_port};
use crate::reads;
use crate::reassign::{ReassignContext, TicketReassignEntry, reassign_views};
use crate::ui::Ui;

/// How long the socket gathers the engine's emits before pushing the latest of them (issue #157).
pub const SNAPSHOT_COALESCE: Duration = Duration::from_millis(50);

/// How long one worktree diff answers every request for its ticket: just under the live check's 2 s
/// cadence, so each check still sees the diff fresh while a burst of reads shares one.
pub const ACTIVITY_CACHE_TTL: Duration = Duration::from_millis(1500);

// How long a shutdown lets the just-closed sockets flush their farewell before serving stops.
const STREAM_DRAIN: Duration = Duration::from_millis(50);

// How long a stop of serving is waited on before the listener's task is cut.
const SERVE_STOP_WAIT: Duration = Duration::from_millis(100);

/// How the server starts the engine: [`Engine::start_pool`], or a stand-in a test supplies.
pub type Starter =
    Arc<dyn Fn(PoolOptions) -> BoxFuture<'static, Result<Engine, EngineError>> + Send + Sync>;

/// What a Stop from the Console sets in motion once the route has accepted it.
pub type StopHandOff = Arc<dyn Fn() + Send + Sync>;

/// What a Restart from the Console sets in motion, handed the port the route promised the tab
/// (console.json's raw `port` when pinned, else the bound port).
pub type RestartHandOff = Arc<dyn Fn(Value) + Send + Sync>;

/// Everything a pool server is made with (server.ts `PoolServerOptions`). Only the CLI reads the
/// environment; it fills these in.
pub struct PoolServerOptions {
    pub pool_dir: String,
    /// The --port flag, as JavaScript's `Number` read it; a pin when present.
    pub port: Option<f64>,
    /// Where the unpinned hunt starts; 8787 unless set.
    pub default_port: Option<f64>,
    /// The harness table; the engine's own when absent.
    pub harnesses: Option<Harnesses>,
    /// Where the Console's files come from; the build's own when absent.
    pub ui: Option<Ui>,
    /// The fleet registry.
    pub registry_path: String,
    pub herdr_socket: PathBuf,
    pub herdr_workspace: Option<String>,
    pub jev_api_key: Option<String>,
    pub jev_base_url: Option<String>,
    /// The socket's heartbeat interval; HEARTBEAT_MS when absent.
    pub stream_heartbeat: Option<Duration>,
    /// The snapshot push's coalescing window; zero sends every emit as it lands.
    pub snapshot_coalesce: Option<Duration>,
    pub enlist_poll: Option<Duration>,
    pub conversation_poll: Option<Duration>,
    pub enlist_teaching_wait: Option<Duration>,
    pub pane_survey: Option<Duration>,
    /// What an accepted Stop does; absent, the server shuts itself down in place.
    pub on_stop_requested: Option<StopHandOff>,
    /// What an accepted Restart does; absent, the server shuts itself down in place.
    pub on_restart_requested: Option<RestartHandOff>,
    pub machine_defaults_paths: MachineDefaultsPaths,
    /// The environment every harness child inherits (`process.env`, read by the CLI).
    pub parent_env: Arc<Vec<(String, String)>>,
    /// How the engine starts; [`Engine::start_pool`] when absent.
    pub starter: Option<Starter>,
}

// The pool config, parsed once per distinct file text (issue #126): keyed on the text so a hand edit
// and a save are both caught, however fast they land.
struct ConfigCache {
    text: String,
    config: Option<PoolConfig>,
    error: Option<String>,
}

// One ticket's worktree diff, shared by every request that arrives while it runs, then serving for the
// TTL from when it landed; a new worktree reads afresh.
struct DiffEntry {
    worktree: String,
    landed_at: Arc<OnceLock<Instant>>,
    diff: SharedFuture<BoxFuture<'static, Option<Value>>>,
}

/// The state every route, socket and timer shares, behind [`Shared::inner`].
pub(crate) struct Inner {
    pub meta: Vec<TicketMarker>,
    pub ticket_ids: HashSet<String>,
    pub conversation_ids: HashSet<String>,
    /// The enriched snapshot as last built. Read it through [`Server::current`].
    latest: Option<Arc<EnrichedSnapshot>>,
    /// The engine snapshot `latest` was built from.
    enriched_from: Option<Arc<PoolSnapshot>>,
    /// Set by a write that changes the enrichment without an engine emit (a Reassign, a settings save).
    dirty: bool,
    config_cache: ConfigCache,
    /// The Pool title as the config last parsed it, and the one the engine was last told.
    pool_title: Option<String>,
    grades_cache: Option<(String, IndexMap<String, TicketGradeSummary>)>,
    diff_cache: HashMap<String, DiffEntry>,
    /// Set the moment a Stop or Restart is accepted, so a second one is only acknowledged.
    pub stop_requested: bool,
    pub hub: HubState,
}

/// The server, shared by every task that serves it.
pub(crate) struct Shared {
    pub pool_dir: String,
    pub runs_dir: PathBuf,
    pub issues_dir: PathBuf,
    pub pool_name: String,
    pub boot_config: PoolConfig,
    pub harnesses: Harnesses,
    pub herdr: Herdr,
    pub herdr_socket: PathBuf,
    pub herdr_workspace: Option<String>,
    pub jev_api_key: Option<String>,
    pub jev_base_url: Option<String>,
    pub enlist_poll: Option<Duration>,
    pub conversation_poll: Option<Duration>,
    pub enlist_teaching_wait: Option<Duration>,
    pub pane_survey: Option<Duration>,
    pub machine_paths: MachineDefaultsPaths,
    pub parent_env: Arc<Vec<(String, String)>>,
    pub ui: Ui,
    pub port: u16,
    pub heartbeat: Duration,
    pub coalesce: Duration,
    pub check: Duration,
    pub on_stop: Option<StopHandOff>,
    pub on_restart: Option<RestartHandOff>,
    starter: Starter,
    pub runtime: Handle,
    engine: OnceCell<Engine>,
    pub inner: Mutex<Inner>,
    stopping: Mutex<Option<SharedFuture<BoxFuture<'static, ()>>>>,
    serve: Mutex<Option<(oneshot::Sender<()>, tokio::task::JoinHandle<()>)>>,
}

/// A handle to the running server; cheap to clone.
#[derive(Clone)]
pub struct Server(pub(crate) Arc<Shared>);

fn is_address_in_use(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::AddrInUse
}

// One bind of the port on every interface: IPv6 and IPv4 on one dual-stack socket where the host has
// IPv6, IPv4 alone where it does not. Address reuse is on, as Bun's listener has it, so a relaunch can
// bind the port its predecessor just let go.
fn bind_once(port: u16) -> io::Result<tokio::net::TcpListener> {
    let v6 = (|| {
        let socket = tokio::net::TcpSocket::new_v6()?;
        socket.set_reuseaddr(true)?;
        let off: libc::c_int = 0;
        // SAFETY: a valid socket descriptor and an int-sized option value, as setsockopt documents.
        unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::IPPROTO_IPV6,
                libc::IPV6_V6ONLY,
                (&off as *const libc::c_int).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            );
        }
        socket.bind(SocketAddr::V6(SocketAddrV6::new(
            Ipv6Addr::UNSPECIFIED,
            port,
            0,
            0,
        )))?;
        socket.listen(1024)
    })();
    match v6 {
        Err(err) if !is_address_in_use(&err) && err.kind() != io::ErrorKind::PermissionDenied => {
            let socket = tokio::net::TcpSocket::new_v4()?;
            socket.set_reuseaddr(true)?;
            socket.bind(SocketAddr::V4(SocketAddrV4::new(
                std::net::Ipv4Addr::UNSPECIFIED,
                port,
            )))?;
            socket.listen(1024)
        }
        other => other,
    }
}

/// Bind the pool server per the resolution. A pinned port that is busy is a hard failure naming the
/// port and, when the fleet registry knows the holder, its pool and pid; only the unpinned path hunts
/// upward for a free one. Port 0 is any free port.
fn bind_pool_server(
    resolution: PortResolution,
    registry_path: &str,
) -> Result<tokio::net::TcpListener, String> {
    if resolution.pinned {
        return bind_once(resolution.port).map_err(|err| {
            if is_address_in_use(&err) {
                let holder = read_fleet_entry_by_port(registry_path, u64::from(resolution.port))
                    .map(|entry| format!(" by pool {} (pid {})", entry.pool_dir, entry.pid_text()))
                    .unwrap_or_default();
                format!(
                    "port {} is already in use{holder}; free it or pass a different --port",
                    resolution.port
                )
            } else {
                err.to_string()
            }
        });
    }
    if resolution.port == 0 {
        return bind_once(0).map_err(|err| err.to_string());
    }
    let mut port = u32::from(resolution.port);
    while port <= 65535 {
        match bind_once(port as u16) {
            Ok(listener) => return Ok(listener),
            Err(err) if is_address_in_use(&err) => port += 1,
            Err(err) => return Err(err.to_string()),
        }
    }
    Err(format!(
        "no free port found from {} upward",
        resolution.port
    ))
}

impl Server {
    /// Lock the pool, read its config and meta, bind, register in the fleet, and start serving. The
    /// pool's run starts with [`Server::start`]. A refusal is the TypeScript's message; a refusal after
    /// the lock leaves it naming this process (the next start takes it over), except a failed bind,
    /// which releases it.
    pub fn create(options: PoolServerOptions) -> Result<Server, String> {
        let pool_dir = js::path_resolve(&options.pool_dir);
        // The config as this process booted with it: the port resolution and the Settings pane's
        // `effective` read this one parse, since the boot-only keys are frozen for the life of the run.
        let boot_config = read_config(&pool_dir).map_err(|err| err.to_string())?;
        acquire_pool_lock(&pool_dir, &options.registry_path)?;
        let harnesses = options.harnesses.unwrap_or_else(Harnesses::defaults);
        // The pool's ticket metadata, as the engine parses it, so the server accepts exactly the pools
        // the engine does.
        let meta = load_pool_tickets(std::path::Path::new(&pool_dir), false)
            .map_err(|err| err.to_string())?;
        let conversations =
            load_conversations(&std::path::Path::new(&pool_dir).join("conversations"))
                .map_err(|err| err.to_string())?;
        let pool_name = pool_name_of(&pool_dir);
        let resolution = resolve_port(
            options.port,
            boot_config.port(),
            options.default_port.unwrap_or(DEFAULT_PORT),
        )?;
        let listener = match bind_pool_server(resolution, &options.registry_path) {
            Ok(listener) => listener,
            Err(message) => {
                // The lock was claimed before the bind; a bind that never happened must not leave our
                // own live-looking pid behind. Only our pid is removed.
                if read_locked_pid(&pool_dir) == Some(f64::from(std::process::id())) {
                    let _ = std::fs::remove_file(
                        std::path::Path::new(&pool_dir)
                            .join("runs")
                            .join("server.pid"),
                    );
                }
                return Err(message);
            }
        };
        let port = listener
            .local_addr()
            .map(|addr| addr.port())
            .map_err(|err| err.to_string())?;

        let heartbeat = options
            .stream_heartbeat
            .unwrap_or(Duration::from_millis(HEARTBEAT_MS));
        let coalesce = options.snapshot_coalesce.unwrap_or(SNAPSHOT_COALESCE);
        let ticket_ids = meta.iter().map(|m| m.id.clone()).collect();
        let conversation_ids = conversations.into_iter().map(|c| c.id).collect();
        let shared = Arc::new(Shared {
            runs_dir: std::path::Path::new(&pool_dir).join("runs"),
            issues_dir: std::path::Path::new(&pool_dir).join("issues"),
            pool_name,
            herdr: Herdr::new(options.herdr_socket.clone()),
            herdr_socket: options.herdr_socket,
            herdr_workspace: options.herdr_workspace,
            jev_api_key: options.jev_api_key,
            jev_base_url: options.jev_base_url,
            enlist_poll: options.enlist_poll,
            conversation_poll: options.conversation_poll,
            enlist_teaching_wait: options.enlist_teaching_wait,
            pane_survey: options.pane_survey,
            machine_paths: options.machine_defaults_paths,
            parent_env: options.parent_env,
            ui: options.ui.unwrap_or_else(Ui::default_for_build),
            port,
            heartbeat,
            coalesce,
            check: SNAPSHOT_COALESCE,
            on_stop: options.on_stop_requested,
            on_restart: options.on_restart_requested,
            starter: options
                .starter
                .unwrap_or_else(|| Arc::new(|options| Engine::start_pool(options).boxed())),
            runtime: Handle::current(),
            engine: OnceCell::new(),
            inner: Mutex::new(Inner {
                meta,
                ticket_ids,
                conversation_ids,
                latest: None,
                enriched_from: None,
                dirty: false,
                config_cache: ConfigCache {
                    text: String::new(),
                    config: Some(PoolConfig::default()),
                    error: None,
                },
                pool_title: title_of(&boot_config),
                grades_cache: None,
                diff_cache: HashMap::new(),
                stop_requested: false,
                hub: HubState::new(heartbeat),
            }),
            harnesses,
            boot_config,
            pool_dir: pool_dir.clone(),
            stopping: Mutex::new(None),
            serve: Mutex::new(None),
        });
        let server = Server(shared);
        server.serve(listener);

        // The bind succeeded, so the pool is live and advertises itself: lock, then bind, then
        // register, so the registry never names a port that was not bound. Best-effort.
        if let Err(err) = upsert_fleet_entry(
            &options.registry_path,
            &FleetEntry::new(
                &pool_dir,
                u64::from(port),
                std::process::id(),
                &js::now_iso(),
            ),
        ) {
            eprintln!("fleet registry: {err}");
        }
        Ok(server)
    }

    fn serve(&self, listener: tokio::net::TcpListener) {
        let (stop, stopped) = oneshot::channel::<()>();
        let app = crate::http::router(self.clone());
        let task = self.0.runtime.spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await;
        });
        *self.0.serve.lock().unwrap_or_else(|p| p.into_inner()) = Some((stop, task));
    }

    /// The port this server listens on.
    pub fn port(&self) -> u16 {
        self.0.port
    }

    /// `http://localhost:<port>`.
    pub fn url(&self) -> String {
        format!("http://localhost:{}", self.0.port)
    }

    /// The pool directory as resolved.
    pub fn pool_dir(&self) -> &str {
        &self.0.pool_dir
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The engine, once the pool has started.
    pub fn engine(&self) -> Option<Engine> {
        self.0.engine.get().cloned()
    }

    /// The engine's last snapshot as it arrived (server.ts `lastRaw`).
    pub(crate) fn last_raw(&self) -> Option<Arc<PoolSnapshot>> {
        self.engine().and_then(|engine| engine.snapshot())
    }

    /// Start the pool's run once; later calls answer the snapshot as it is. Resolves with the snapshot
    /// as of the run's first emit, or with the first load's refusal.
    pub async fn start(&self) -> Result<Arc<EnrichedSnapshot>, String> {
        let shared = self.0.clone();
        let engine = self
            .0
            .engine
            .get_or_try_init(|| async move {
                let options = PoolOptions {
                    pool_dir: shared.pool_dir.clone(),
                    harnesses: shared.harnesses.clone(),
                    herdr_socket: shared.herdr_socket.clone(),
                    herdr_workspace: shared.herdr_workspace.clone(),
                    jev_api_key: shared.jev_api_key.clone(),
                    jev_base_url: shared.jev_base_url.clone(),
                    // The Steward's teaching names where its command reaches (ADR-0030).
                    console_url: format!("http://localhost:{}", shared.port),
                    enlist_poll: shared.enlist_poll,
                    conversation_poll: shared.conversation_poll,
                    enlist_teaching_wait: shared.enlist_teaching_wait,
                    pane_survey: shared.pane_survey,
                    parent_env: shared.parent_env.clone(),
                    machine_defaults: shared.machine_paths.clone(),
                };
                (shared.starter)(options).await
            })
            .await
            .map_err(|err| err.message().to_owned())?
            .clone();
        if !self.lock().hub.watching_engine {
            self.watch_engine(engine);
        }
        let mut inner = self.lock();
        self.current(&mut inner)
            .ok_or_else(|| "pool not started".to_owned())
    }

    // Every emit the engine publishes: readers see it at once, the socket at the end of the window.
    fn watch_engine(&self, engine: Engine) {
        {
            let mut inner = self.lock();
            if inner.hub.watching_engine {
                return;
            }
            inner.hub.watching_engine = true;
            hub::schedule(self, &mut inner);
        }
        let server = self.clone();
        let mut emits = engine.subscribe();
        self.0.runtime.spawn(async move {
            while emits.changed().await.is_ok() {
                let mut inner = server.lock();
                hub::schedule(&server, &mut inner);
            }
        });
    }

    /// The enriched snapshot as of the engine's last emit: an emit that arrived since the last build
    /// (or a write that changed the enrichment) is enriched here first, so every reader answers with it.
    pub(crate) fn current(&self, inner: &mut Inner) -> Option<Arc<EnrichedSnapshot>> {
        if let Some(raw) = self.last_raw() {
            let fresh = inner
                .enriched_from
                .as_ref()
                .is_some_and(|from| Arc::ptr_eq(from, &raw));
            if !fresh || inner.dirty {
                self.refresh_meta(inner, Some(&raw));
                let rows = self.reassign_rows(inner, &raw);
                let title = self.title_now(inner);
                inner.latest = Some(Arc::new(enrich(
                    &raw,
                    &inner.meta,
                    &self.0.pool_name,
                    &self.0.pool_dir,
                    &rows,
                    title,
                )));
                inner.enriched_from = Some(raw);
                inner.dirty = false;
            }
        }
        inner.latest.clone()
    }

    /// The enriched snapshot, taking the lock for the read.
    pub fn snapshot(&self) -> Option<Arc<EnrichedSnapshot>> {
        let mut inner = self.lock();
        self.current(&mut inner)
    }

    /// Rebuild the enriched snapshot from the last engine snapshot and the config file as it is now,
    /// and push it to every open tab: a Reassign or a settings save shows at once, without waiting for
    /// the run to tick.
    pub(crate) fn reenrich(&self, inner: &mut Inner) -> Option<Arc<EnrichedSnapshot>> {
        if self.last_raw().is_some() {
            inner.dirty = true;
            hub::schedule(self, inner);
        }
        self.current(inner)
    }

    /// Re-read the pool's tickets and Conversations from disk: the engine writes ticket files mid-run,
    /// and each must render as a card and be accepted by the ticket endpoints the moment it lands. A
    /// reload that fails keeps the last-known-good meta.
    pub(crate) fn refresh_meta(&self, inner: &mut Inner, raw: Option<&Arc<PoolSnapshot>>) {
        let pool_dir = std::path::Path::new(&self.0.pool_dir);
        let (tickets, conversations) = ac_core::pool::reading_pool_files(|| {
            (
                load_pool_tickets(pool_dir, false),
                load_conversations(&pool_dir.join("conversations")),
            )
        });
        if let Ok(meta) = tickets {
            inner.ticket_ids = meta.iter().map(|m| m.id.clone()).collect();
            inner.meta = meta;
        }
        let mut ids: HashSet<String> = match conversations {
            Ok(records) => records.into_iter().map(|record| record.id).collect(),
            Err(_) => std::mem::take(&mut inner.conversation_ids),
        };
        // Union in whatever the live snapshot already knows: a Conversation that started this instant
        // is on disk before its record here is re-read, so this is belt-and-braces.
        let raw = raw.cloned().or_else(|| self.last_raw());
        if let Some(raw) = raw {
            ids.extend(raw.conversations.iter().map(|c| c.id.clone()));
        }
        inner.conversation_ids = ids;
    }

    // The pool config through the cached parse, or why it does not parse.
    fn current_config(&self, inner: &mut Inner) -> (Option<PoolConfig>, Option<String>) {
        let path = pool_settings_path(&self.0.pool_dir);
        let text = if js::exists(&path) {
            match js::read_text(&path) {
                Ok(text) => text,
                Err(err) => return (None, Some(err.to_string())),
            }
        } else {
            String::new()
        };
        if text != inner.config_cache.text {
            // The text just read, not a second read of the file, so the cache key and the parse describe
            // one version of console.json.
            inner.config_cache = match parse_config(Some(&text), &self.0.pool_dir) {
                Ok(config) => ConfigCache {
                    text,
                    config: Some(config),
                    error: None,
                },
                Err(err) => ConfigCache {
                    text,
                    config: None,
                    error: Some(err.to_string()),
                },
            };
        }
        (
            inner.config_cache.config.clone(),
            inner.config_cache.error.clone(),
        )
    }

    // The Pool title for the next snapshot. A title that moved since the last snapshot is handed to the
    // run so a Pool workspace the Console created is relabelled; a file that no longer parses keeps the
    // last good title.
    fn title_now(&self, inner: &mut Inner) -> Option<String> {
        let (config, _) = self.current_config(inner);
        let Some(config) = config else {
            return inner.pool_title.clone();
        };
        let title = title_of(&config);
        if title != inner.pool_title {
            inner.pool_title = title.clone();
            if let Some(engine) = self.engine() {
                self.0
                    .runtime
                    .spawn(async move { engine.retitle(title).await });
            }
        }
        inner.pool_title.clone()
    }

    fn reassign_rows(
        &self,
        inner: &mut Inner,
        raw: &PoolSnapshot,
    ) -> IndexMap<String, TicketReassignEntry> {
        let (config, error) = self.current_config(inner);
        let live = live_attempt_ids(raw);
        let context = ReassignContext {
            markers: &inner.meta,
            harnesses: &self.0.harnesses,
            live_attempts: &live,
            statuses: &raw.state.tickets,
            engine_assignments: &raw.assignments,
        };
        reassign_views(&context, config.as_ref(), error.as_deref())
    }

    /// The Settings pane's payload, re-read from the files on every call.
    pub(crate) fn settings_payload(&self) -> Result<SettingsResponse, String> {
        let names = self.0.harnesses.names();
        settings_payload(
            SettingsContext {
                pool_dir: &self.0.pool_dir,
                boot_config: &self.0.boot_config,
                machine_paths: &self.0.machine_paths,
                harnesses: &names,
            },
            u64::from(self.0.port),
        )
        .map_err(|err| err.to_string())
    }

    /// The grades as last derived, re-derived when a ticket or an events file moved (issue #157); an
    /// events file inside the racy window has no stamp, so the grades are derived afresh until it
    /// settles.
    pub(crate) fn pool_grades(&self, inner: &mut Inner) -> IndexMap<String, TicketGradeSummary> {
        let runs = &self.0.runs_dir;
        let Some(key) = reads::grades_key(runs, &inner.meta) else {
            return reads::pool_grades(runs, &inner.meta);
        };
        if inner.grades_cache.as_ref().is_none_or(|(at, _)| *at != key) {
            inner.grades_cache = Some((key, reads::pool_grades(runs, &inner.meta)));
        }
        inner
            .grades_cache
            .as_ref()
            .map(|(_, grades)| grades.clone())
            .unwrap_or_default()
    }

    // The worktree diff through the cache: a read in flight is shared, and its answer serves for the
    // TTL from when it landed.
    fn worktree_diff(
        &self,
        inner: &mut Inner,
        ticket_id: &str,
        worktree: &str,
    ) -> SharedFuture<BoxFuture<'static, Option<Value>>> {
        if let Some(hit) = inner.diff_cache.get(ticket_id)
            && hit.worktree == worktree
            && hit
                .landed_at
                .get()
                .is_none_or(|landed| landed.elapsed() < ACTIVITY_CACHE_TTL)
        {
            return hit.diff.clone();
        }
        let landed_at = Arc::new(OnceLock::new());
        let landed = landed_at.clone();
        let path = worktree.to_owned();
        let diff = async move {
            let diff = ac_io::git::activity_diff(&path)
                .await
                .map(|diff| reads::diff_value(&diff));
            let _ = landed.set(Instant::now());
            diff
        }
        .boxed()
        .shared();
        inner.diff_cache.insert(
            ticket_id.to_owned(),
            DiffEntry {
                worktree: worktree.to_owned(),
                landed_at,
                diff: diff.clone(),
            },
        );
        diff
    }

    /// A ticket's Vitals (GET /api/activity, the live check's activity): `running` from the last
    /// snapshot's Live attempt, the runs directory read fresh, the worktree diff through the cache.
    pub(crate) async fn activity(&self, ticket_id: &str) -> Value {
        let (running, facts, diff) = {
            let mut inner = self.lock();
            let running = self
                .current(&mut inner)
                .and_then(|snapshot| {
                    snapshot
                        .state
                        .tickets
                        .iter()
                        .find(|ticket| ticket.id == ticket_id)
                        .map(|ticket| ticket.live_attempt.is_some())
                })
                .unwrap_or(false);
            let facts = reads::activity_facts(&self.0.runs_dir, ticket_id);
            let diff = facts
                .worktree
                .as_deref()
                .filter(|worktree| js::exists(worktree))
                .map(|worktree| self.worktree_diff(&mut inner, ticket_id, worktree));
            (running, facts, diff)
        };
        let diff = match diff {
            Some(diff) => diff.await,
            None => None,
        };
        reads::activity_value(ticket_id, running, diff, facts)
    }

    /// Whether a Stop or Restart is already under way.
    pub(crate) fn stop_under_way(&self, inner: &Inner) -> bool {
        inner.stop_requested
            || self
                .0
                .stopping
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_some()
    }

    /// Hand an accepted Stop to its owner, or shut down in place.
    pub(crate) fn request_stop(&self) {
        match &self.0.on_stop {
            Some(hand_off) => hand_off(),
            None => {
                let server = self.clone();
                self.0
                    .runtime
                    .spawn(async move { server.shutdown(None).await });
            }
        }
    }

    /// Hand an accepted Restart to its owner with the port it promised, or shut down in place.
    pub(crate) fn request_restart(&self, port: Value) {
        match &self.0.on_restart {
            Some(hand_off) => hand_off(port),
            None => {
                let server = self.clone();
                self.0
                    .runtime
                    .spawn(async move { server.shutdown(None).await });
            }
        }
    }

    /// The orderly stop (ADR-0017), one per server: the attempts stop first and the run's farewell
    /// `stopped` snapshot goes out to every socket; the sockets close (CLOSE_STOPPED); serving stops;
    /// the lock goes last. A second call joins the first.
    pub async fn shutdown(&self, grace: Option<Duration>) {
        let stopping = {
            let mut slot = self.0.stopping.lock().unwrap_or_else(|p| p.into_inner());
            slot.get_or_insert_with(|| {
                let server = self.clone();
                let task = self.0.runtime.spawn(async move {
                    if let Some(engine) = server.engine() {
                        engine.shutdown(grace).await;
                    }
                    {
                        let mut inner = server.lock();
                        hub::close_sockets(&server, &mut inner);
                    }
                    // A closed socket still has its last frames in flight: one short pause lets them
                    // flush before the connections are cut.
                    tokio::time::sleep(STREAM_DRAIN).await;
                    server.stop_serving().await;
                    release_pool_lock(&server.0.pool_dir);
                });
                async move {
                    let _ = task.await;
                }
                .boxed()
                .shared()
            })
            .clone()
        };
        stopping.await;
    }

    async fn stop_serving(&self) {
        let serving = self
            .0
            .serve
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some((stop, mut task)) = serving {
            let _ = stop.send(());
            if tokio::time::timeout(SERVE_STOP_WAIT, &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
    }

    /// Stop every timer and serving, and close the engine's store, without the farewell: what an
    /// in-process caller that owns the run does.
    pub async fn close(&self) {
        {
            let mut inner = self.lock();
            hub::dispose(&mut inner);
        }
        self.stop_serving().await;
        if let Some(engine) = self.engine() {
            engine.close().await;
        }
    }
}

/// The ticket ids with an Attempt in flight, from an engine snapshot.
pub(crate) fn live_attempt_ids(snapshot: &PoolSnapshot) -> HashSet<String> {
    snapshot.live_attempts.keys().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The NOT-PORTED row on ports.test.ts:15: with neither a flag nor a pin, the server binds the first
    // free port from the start port upward; a pinned busy port refuses, naming it.
    #[tokio::test]
    async fn hunts_upward_from_a_busy_start_and_refuses_a_busy_pin() {
        let held = bind_once(0).unwrap();
        let busy = held.local_addr().unwrap().port();
        let hunted = bind_pool_server(
            PortResolution {
                port: busy,
                pinned: false,
            },
            "/nonexistent/pools.json",
        )
        .unwrap();
        assert!(hunted.local_addr().unwrap().port() > busy);
        let refused = bind_pool_server(
            PortResolution {
                port: busy,
                pinned: true,
            },
            "/nonexistent/pools.json",
        )
        .unwrap_err();
        assert_eq!(
            refused,
            format!("port {busy} is already in use; free it or pass a different --port")
        );
    }
}
