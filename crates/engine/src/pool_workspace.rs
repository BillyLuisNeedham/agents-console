//! The Pool workspace (issue #94; engine.ts 2891-3232): one herdr workspace per pool, where every tab
//! this pool opens lands.
//!
//! STUB(pool_workspace): the herdr panes port owns this module. A headless pool never resolves one
//! (the TypeScript returns at once when the pool is not terminal-backed), and that is the behaviour
//! here.

use crate::actor::Engine;

/// The session's knowledge of its Pool workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PoolWorkspaceState {
    /// The workspace's id once boot resolution has settled; `None` when none could be resolved.
    pub id: Option<String>,
    /// The herdr workspace the server was launched in, the second candidate.
    pub launch: Option<String>,
    /// Whether the Console created this workspace (issue #100).
    pub created: bool,
    /// The label the Console last gave a workspace it created.
    pub label: Option<String>,
    /// The label the pool wants: its title, or its directory's name.
    pub wanted: String,
}

/// `resolvePoolWorkspaceForSession`: resolve the Pool workspace at boot. STUB(pool_workspace): only a
/// terminal-backed pool resolves one, and none is resolved here.
pub async fn resolve_pool_workspace_for_session(engine: &Engine) {
    let _ = engine;
}
