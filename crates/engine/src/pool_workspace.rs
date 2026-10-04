//! The Pool workspace (issue #94; engine.ts 2891-3232): one herdr workspace per pool, where every tab
//! this pool opens lands. Resolved once at boot, re-resolved after a refused `tab.create`, relabelled
//! when the Pool title changes (issue #100), and remembered in the runs directory for the next boot
//! (`ac_core::pool_workspace`).

use std::path::Path;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use tokio::sync::watch;

use ac_core::pool_title::pool_workspace_label;
use ac_core::pool_workspace::{
    RememberedPoolWorkspace, read_remembered_pool_workspace, remember_pool_workspace,
};
use ac_io::herdr::{Herdr, PoolWorkspaceCandidates, PoolWorkspaceOrigin};

use crate::actor::Engine;
use crate::attempt_run::PoolWorkspace;
use crate::session::Session;

/// A flow shared by every caller that raced into it.
type Flow<T> = Shared<BoxFuture<'static, T>>;

/// The session's knowledge of its Pool workspace. `ready` settles once boot resolution has decided
/// (whatever it decided), so a spawn that races the boot RPC waits for it instead of opening its tab
/// elsewhere; `id` is `None` until then, and stays `None` when no workspace could be had at all.
pub struct PoolWorkspaceState {
    pub ready: watch::Sender<bool>,
    pub id: Option<String>,
    /// The workspace the server was launched in (`HERDR_WORKSPACE_ID`), or `None`.
    pub launch: Option<String>,
    /// A re-resolve in flight, shared by every spawn that raced into the same refusal.
    reresolving: Option<Flow<Option<String>>>,
    /// Whether the Console created this workspace (issue #100), this boot or an earlier one as the
    /// remembered file records. Only a created workspace is ever relabelled: the launch workspace, and
    /// any workspace the pool was told about rather than made, keep the label the operator gave them.
    pub created: bool,
    /// The label the Console last gave this workspace, or `None` when it never gave one.
    pub label: Option<String>,
    /// The label it should carry now: the Pool title, else the directory's name.
    pub wanted: String,
    /// The relabel chain, so two quick title edits land in the order they were made.
    relabelling: Flow<()>,
}

impl std::fmt::Debug for PoolWorkspaceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PoolWorkspaceState")
            .field("id", &self.id)
            .field("launch", &self.launch)
            .field("created", &self.created)
            .field("label", &self.label)
            .field("wanted", &self.wanted)
            .finish()
    }
}

impl PoolWorkspaceState {
    /// A workspace nothing has resolved yet. `ready` starts settled: a pool that resolves one (a
    /// terminal-backed pool at boot) unsettles it first.
    pub fn new(launch: Option<String>, wanted: String) -> Self {
        PoolWorkspaceState {
            ready: watch::channel(true).0,
            id: None,
            launch,
            reresolving: None,
            created: false,
            label: None,
            wanted,
            relabelling: futures::future::ready(()).boxed().shared(),
        }
    }
}

impl Default for PoolWorkspaceState {
    fn default() -> Self {
        PoolWorkspaceState::new(None, String::new())
    }
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// `persistPoolWorkspace`: remember the resolved id, and carry on if that cannot be written. The file
/// is a convenience for the next boot; this run already has its workspace, and an unwritable runs
/// directory must not throw away a resolution that worked.
fn persist_pool_workspace(session: &mut Session, workspace_id: &str) {
    let remembered = RememberedPoolWorkspace {
        id: workspace_id.to_owned(),
        created: session.pool_workspace.created,
        label: session.pool_workspace.label.clone(),
    };
    if let Err(error) = remember_pool_workspace(Path::new(&session.runs_dir), &remembered) {
        session.log(format!(
            "Pool workspace {workspace_id} could not be remembered for the next boot ({}); this run's tabs are unaffected",
            message(error)
        ));
    }
}

/// `adoptWorkspaceProvenance`: record where the resolved Pool workspace came from (issue #100).
/// Created now: the Console made it, labelled with what it wants. Remembered: the file says whether
/// the Console made it and what it last called it. Launch: the operator's workspace, never relabelled.
fn adopt_workspace_provenance(
    session: &mut Session,
    origin: PoolWorkspaceOrigin,
    remembered: Option<&RememberedPoolWorkspace>,
) {
    let workspace = &mut session.pool_workspace;
    match (origin, remembered) {
        (PoolWorkspaceOrigin::Created, _) => {
            workspace.created = true;
            workspace.label = Some(workspace.wanted.clone());
        }
        (PoolWorkspaceOrigin::Remembered, Some(remembered)) => {
            workspace.created = remembered.created;
            workspace.label = remembered.label.clone();
        }
        _ => {
            workspace.created = false;
            workspace.label = None;
        }
    }
}

struct ResolveFacts {
    herdr: Herdr,
    launch: Option<String>,
    wanted: String,
    cwd: String,
}

fn resolve_facts(session: &Session) -> ResolveFacts {
    ResolveFacts {
        herdr: Herdr::new(&session.herdr_socket),
        launch: session.pool_workspace.launch.clone(),
        wanted: session.pool_workspace.wanted.clone(),
        cwd: session.cwd.clone(),
    }
}

/// `resolvePoolWorkspaceForSession`: resolve the Pool workspace at boot (issue #94), before
/// reconciliation so the pane listing can be scoped to it, and before the drive's first scheduling so
/// no attempt ever races it. Only a terminal-backed pool has one: a headless pool opens no tabs at all.
///
/// A failure of all three steps (no remembered workspace, no launch workspace, and a daemon that will
/// not create one) is logged and the pool boots anyway with no Pool workspace: each spawn then takes
/// the per-attempt headless fallback ADR-0014 already promised, rather than the whole pool refusing to
/// start over a terminal convenience.
pub async fn resolve_pool_workspace_for_session(engine: &Engine) {
    let started = engine
        .call(|s| {
            if !crate::tickets::attempt_env_of(s, None).terminal_backed {
                return None;
            }
            let remembered = read_remembered_pool_workspace(Path::new(&s.runs_dir));
            Some((remembered, resolve_facts(s)))
        })
        .await
        .ok()
        .flatten();
    if let Some((remembered, facts)) = started {
        let resolved = facts
            .herdr
            .resolve_pool_workspace(&PoolWorkspaceCandidates {
                remembered: remembered.as_ref().map(|r| r.id.as_str()),
                launch: facts.launch.as_deref(),
                label: &facts.wanted,
                cwd: &facts.cwd,
            })
            .await;
        match resolved {
            Ok(resolution) => {
                let _ = engine
                    .call(move |s| {
                        let id = resolution.workspace_id;
                        s.pool_workspace.id = Some(id.clone());
                        adopt_workspace_provenance(s, resolution.origin, remembered.as_ref());
                        persist_pool_workspace(s, &id);
                        if resolution.origin == PoolWorkspaceOrigin::Created {
                            s.log(format!("Pool workspace {id} created for this pool's tabs"));
                        }
                    })
                    .await;
                // A title edited while the Console was down reaches a workspace it made on an earlier
                // boot here; one it just made already carries it.
                relabel_pool_workspace(engine).await;
            }
            Err(error) => {
                let _ = engine
                    .call(move |s| {
                        s.pool_workspace.id = None;
                        s.log(format!(
                            "no Pool workspace could be resolved ({}); attempts fall back to headless",
                            message(error)
                        ));
                    })
                    .await;
            }
        }
    }
    let _ = engine
        .call(|s| {
            s.pool_workspace.ready.send_replace(true);
        })
        .await;
}

/// `reresolvePoolWorkspace`: re-resolve the Pool workspace after a `tab.create` the daemon refused,
/// given the id that spawn tried. Three guards stand before any workspace is ever created, because
/// the cost of getting this wrong is a second Pool workspace for one pool, which is exactly the
/// scattering the first one exists to prevent:
///
/// 1. The id has already moved on: another spawn's re-resolve finished while this one was failing, so
///    the answer is simply where the pool's tabs go now, and no RPC is needed at all.
/// 2. A re-resolve is in flight: every spawn that raced into the same refusal joins it.
/// 3. The stale id is still there: a `tab.create` can be refused for reasons that have nothing to do
///    with the workspace (a daemon blip, a bad cwd), and `workspace.get` is what tells those apart from
///    a workspace the operator closed.
///
/// Only past all three does the workspace count as gone, and the resolution runs without the
/// remembered id (it is the one that just failed): the launch workspace if that still exists,
/// otherwise a fresh one, persisted and noted on the pool log.
pub async fn reresolve_pool_workspace(engine: &Engine, stale_id: String) -> Option<String> {
    let flow = engine
        .call(move |s| -> Result<Flow<Option<String>>, Option<String>> {
            if s.pool_workspace.id.as_deref() != Some(stale_id.as_str()) {
                return Err(s.pool_workspace.id.clone());
            }
            if let Some(flow) = &s.pool_workspace.reresolving {
                return Ok(flow.clone());
            }
            let engine = s.engine();
            let facts = resolve_facts(s);
            let stale = stale_id.clone();
            let flow: Flow<Option<String>> = async move {
                let outcome = if facts.herdr.workspace_exists(&stale_id).await {
                    Some(stale_id)
                } else {
                    let resolved = facts
                        .herdr
                        .resolve_pool_workspace(&PoolWorkspaceCandidates {
                            remembered: None,
                            launch: facts.launch.as_deref(),
                            label: &facts.wanted,
                            cwd: &facts.cwd,
                        })
                        .await;
                    match resolved {
                        Ok(resolution) => {
                            let new_id = resolution.workspace_id.clone();
                            let origin = resolution.origin;
                            let _ = engine
                                .call(move |s| {
                                    s.pool_workspace.id = Some(new_id.clone());
                                    adopt_workspace_provenance(s, origin, None);
                                    persist_pool_workspace(s, &new_id);
                                    s.log(format!(
                                        "Pool workspace {} is gone; the pool's tabs now open in {new_id}",
                                        stale
                                    ));
                                })
                                .await;
                            Some(resolution.workspace_id)
                        }
                        Err(error) => {
                            let _ = engine
                                .call(move |s| {
                                    s.log(format!(
                                        "the Pool workspace could not be re-resolved after a refused tab ({}); this attempt falls back to headless",
                                        message(error)
                                    ))
                                })
                                .await;
                            None
                        }
                    }
                };
                let _ = engine
                    .call(|s| s.pool_workspace.reresolving = None)
                    .await;
                outcome
            }
            .boxed()
            .shared();
            s.pool_workspace.reresolving = Some(flow.clone());
            tokio::spawn({
                let flow = flow.clone();
                async move {
                    let _ = flow.await;
                }
            });
            Ok(flow)
        })
        .await;
    match flow {
        Ok(Ok(flow)) => flow.await,
        Ok(Err(id)) => id,
        Err(_) => None,
    }
}

/// `relabelPoolWorkspace`: bring a Console-created Pool workspace's label in line with the Pool title
/// (issue #100). A no-op when there is no workspace, when the Console did not create it (the launch
/// workspace, a remembered one it was only told about; an enlisted pane's workspace is never the Pool
/// workspace at all), or when it already carries the label it should. A workspace relabelled in herdr
/// by hand keeps that label until the title next changes, because the check is against the label the
/// Console last gave it, not the one herdr shows now. Best-effort like every herdr call: a refusal is
/// a pool log line.
pub async fn relabel_pool_workspace(engine: &Engine) {
    let started = engine
        .call(|s| {
            let workspace = &s.pool_workspace;
            let id = workspace.id.clone()?;
            if !workspace.created || workspace.label.as_deref() == Some(workspace.wanted.as_str()) {
                return None;
            }
            Some((id, workspace.wanted.clone(), Herdr::new(&s.herdr_socket)))
        })
        .await
        .ok()
        .flatten();
    let Some((workspace_id, wanted, herdr)) = started else {
        return;
    };
    if let Err(error) = herdr.relabel_workspace(&workspace_id, &wanted).await {
        let _ = engine
            .call(move |s| {
                s.log(format!(
                    "Pool workspace {workspace_id} could not be relabelled \"{wanted}\" ({})",
                    message(error)
                ))
            })
            .await;
        return;
    }
    let _ = engine
        .call(move |s| {
            // The workspace may have been re-resolved while the call was out; what was just
            // relabelled is only recorded if it is still the Pool workspace.
            if s.pool_workspace.id.as_deref() != Some(workspace_id.as_str()) {
                return;
            }
            s.pool_workspace.label = Some(wanted.clone());
            persist_pool_workspace(s, &workspace_id);
            s.log(format!(
                "Pool workspace {workspace_id} relabelled \"{wanted}\""
            ));
        })
        .await;
}

impl Engine {
    /// The handle's `retitle` (issue #100): take the new label and relabel once boot resolution has
    /// settled, chained so edits land in the order made. Never fails.
    pub async fn retitle(&self, title: Option<String>) {
        let chain = self
            .call(move |s| {
                s.pool_workspace.wanted = pool_workspace_label(title.as_deref(), &s.pool_dir);
                if !crate::tickets::attempt_env_of(s, None).terminal_backed {
                    return None;
                }
                let previous = s.pool_workspace.relabelling.clone();
                let engine = s.engine();
                let mut ready = s.pool_workspace.ready.subscribe();
                let link: Flow<()> = async move {
                    previous.await;
                    let _ = ready.wait_for(|ready| *ready).await;
                    relabel_pool_workspace(&engine).await;
                }
                .boxed()
                .shared();
                s.pool_workspace.relabelling = link.clone();
                tokio::spawn(link.clone());
                Some(link)
            })
            .await;
        if let Ok(Some(chain)) = chain {
            chain.await;
        }
    }
}

/// The Pool workspace as the Attempt-run module reads it (ADR-0014's pattern: one place decides, every
/// spawn site reads the env): the live id, never a copy taken before boot resolution ran.
#[derive(Clone)]
pub struct EnginePoolWorkspace {
    engine: Engine,
}

impl EnginePoolWorkspace {
    pub fn new(engine: Engine) -> Self {
        EnginePoolWorkspace { engine }
    }
}

impl PoolWorkspace for EnginePoolWorkspace {
    fn id(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let mut ready = self
                .engine
                .call(|s| s.pool_workspace.ready.subscribe())
                .await
                .ok()?;
            let _ = ready.wait_for(|ready| *ready).await;
            self.engine
                .call(|s| s.pool_workspace.id.clone())
                .await
                .ok()?
        })
    }

    fn reresolve(&self, stale_id: String) -> BoxFuture<'_, Option<String>> {
        Box::pin(reresolve_pool_workspace(&self.engine, stale_id))
    }
}
