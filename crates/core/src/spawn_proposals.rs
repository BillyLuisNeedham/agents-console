//! The Spawn proposals the engine keeps before they land (engine/spawn-proposals.ts; ADR-0029, issue
//! #150; CONTEXT.md: Pending spawn, Held spawn). A proposal taken from an exited attempt, or from a
//! Conversation's spawn.json, is one of two things until it lands or goes:
//!
//! - a **Pending spawn**: within the caps, waiting for the next super-step boundary to land it. The
//!   operator may Hold it or Discard it first.
//! - a **Held spawn**: one a cap had no room for, one the proposing agent marked as overlapping work
//!   already in the pool, or one the operator held back. It waits for the operator's Adopt (past the
//!   caps) or Discard.
//!
//! Both survive a restart. The record of them is one file, `runs/held-spawns.json` (the name ADR-0029
//! gave it, kept so a pool that held spawns before issue #150 reads unchanged), replaced whole through
//! a rename so a crash never leaves half of it. One file keeps a proposal's move from pending to held
//! a single write. It carries both lists, the counter the proposal ids come from (never reused, so a
//! discarded `proposal-1` cannot come back as the name of another proposal, and an id an agent read
//! from the Spawn ledger keeps meaning one proposal), and the keys of the pre-ADR truncations boot has
//! already recovered, so a recovery and the holds it made land in the same write and it never runs
//! twice.
//!
//! A proposal keeps its id from the moment it is taken until it lands or is discarded, whether it is
//! pending or held. Held spawns from before issue #150 keep their `held-N` ids.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use ac_protocol::{HeldSpawnReason, HeldSpawnView, PendingSpawnView, SpawnKind, SpawnProposal};
use anyhow::{Result, anyhow};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js;

/// A proposal waiting for the next super-step boundary to land it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSpawn {
    pub id: String,
    /// The Ticket or Conversation whose proposal this is.
    pub parent_id: String,
    /// Whether the proposal came from a Ticket's Outcome or a Conversation's spawn.json: a landed
    /// Ticket-origin one counts toward the run.
    pub origin: SpawnKind,
    pub proposal: SpawnProposal,
    /// When it was taken from its attempt or spawn.json.
    pub at: String,
    /// The id the boundary is landing it under, written before the ticket file is: a restart that
    /// finds it set checks whether that ticket landed, so a crash mid-landing never lands it twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing: Option<String>,
}

/// A proposal held for the operator's Adopt or Discard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldSpawn {
    pub id: String,
    pub parent_id: String,
    pub origin: SpawnKind,
    pub proposal: SpawnProposal,
    pub reason: HeldSpawnReason,
    /// When it was held (for a recovered one, when the cap truncated it).
    pub at: String,
    /// Why the boundary refused to land it: its last Adopt, or, held for "refused", its landing as a
    /// Pending spawn. Cleared by the next Adopt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adopt_error: Option<String>,
    /// Held for "overlaps": the ids it named that neither the pool nor any proposal of it ever had,
    /// kept so the operator sees the mark may be stale or mistaken. Absent when every id was known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unknown_overlaps: Option<Vec<String>>,
}

/// A spawn to hold under a fresh id: a Held spawn before it has one.
#[derive(Debug, Clone, PartialEq)]
pub struct NewHeldSpawn {
    pub parent_id: String,
    pub origin: SpawnKind,
    pub proposal: SpawnProposal,
    pub reason: HeldSpawnReason,
    pub at: String,
    pub adopt_error: Option<String>,
    pub unknown_overlaps: Option<Vec<String>>,
}

impl NewHeldSpawn {
    fn with_id(self, id: String) -> HeldSpawn {
        HeldSpawn {
            id,
            parent_id: self.parent_id,
            origin: self.origin,
            proposal: self.proposal,
            reason: self.reason,
            at: self.at,
            adopt_error: self.adopt_error,
            unknown_overlaps: self.unknown_overlaps,
        }
    }
}

/// One proposal as it is taken: held for the reason given, or pending.
#[derive(Debug, Clone, PartialEq)]
pub struct TakenProposal {
    pub parent_id: String,
    pub origin: SpawnKind,
    pub proposal: SpawnProposal,
    pub at: String,
    pub held: Option<HeldSpawnReason>,
    /// With `held: Overlaps`, the ids named that the pool never knew.
    pub unknown_overlaps: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpawnProposalsFile {
    seq: u64,
    /// The counter's value when ids became `proposal-N` (issue #150): every id at or below it was
    /// issued as `held-N`, every one above it as `proposal-N`. A file from before has none, and takes
    /// its seq.
    proposal_from: u64,
    pending: Vec<PendingSpawn>,
    held: Vec<HeldSpawn>,
    recovered: Vec<String>,
}

/// `runs/held-spawns.json`.
pub fn spawn_proposals_path(runs_dir: &Path) -> PathBuf {
    runs_dir.join("held-spawns.json")
}

static PROPOSAL_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^(proposal|held)-([0-9]+)$").expect("the proposal id pattern compiles")
});

/// The pool's Pending and Held spawns, and the file that keeps them.
#[derive(Debug)]
pub struct SpawnProposals {
    runs_dir: PathBuf,
    path: PathBuf,
    file: SpawnProposalsFile,
    adopting: Vec<String>,
}

fn count(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_f64).map(|n| {
        if n.is_finite() && n > 0.0 {
            n as u64
        } else {
            0
        }
    })
}

fn list<T: serde::de::DeserializeOwned>(value: Option<Value>) -> serde_json::Result<Vec<T>> {
    match value {
        Some(value @ Value::Array(_)) => serde_json::from_value(value),
        _ => Ok(Vec::new()),
    }
}

/// The pool's pending and held proposals as the file has them. An absent file is none; a file from
/// before issue #150 has no pending list and reads as none pending. A file that does not parse fails
/// with its path: writing over it would lose whatever it held, and saying so beats that.
pub fn load_spawn_proposals(runs_dir: &Path) -> Result<SpawnProposals> {
    let path = spawn_proposals_path(runs_dir);
    let mut file = SpawnProposalsFile {
        seq: 0,
        proposal_from: 0,
        pending: Vec::new(),
        held: Vec::new(),
        recovered: Vec::new(),
    };
    if path.exists() {
        let cannot = |err: &dyn std::fmt::Display| {
            anyhow!("spawn proposals: {} cannot be read ({err})", path.display())
        };
        let text = js::read_text(&path).map_err(|err| cannot(&err))?;
        let parsed = js::parse(&text).map_err(|err| cannot(&err))?;
        let mut fields = match parsed {
            Value::Object(fields) => fields,
            Value::Null => {
                return Err(cannot(&"null is not an object (evaluating 'parsed.seq')"));
            }
            _ => serde_json::Map::new(),
        };
        let seq = count(fields.get("seq")).unwrap_or(0);
        file = SpawnProposalsFile {
            seq,
            proposal_from: count(fields.get("proposalFrom")).unwrap_or(seq),
            pending: list(fields.remove("pending")).map_err(|err| cannot(&err))?,
            held: list(fields.remove("held")).map_err(|err| cannot(&err))?,
            recovered: list(fields.remove("recovered")).map_err(|err| cannot(&err))?,
        };
    }
    Ok(SpawnProposals {
        runs_dir: runs_dir.to_path_buf(),
        path,
        file,
        adopting: Vec::new(),
    })
}

impl SpawnProposals {
    fn write(&self) -> Result<(), js::FsError> {
        js::mkdir_all(&self.runs_dir)?;
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(format!(".tmp-{}", std::process::id()));
        js::write_through_rename(
            &self.path,
            Path::new(&tmp),
            &format!("{}\n", js::to_json_pretty(&self.file)),
        )
    }

    fn next_id(&mut self) -> String {
        self.file.seq += 1;
        format!("proposal-{}", self.file.seq)
    }

    pub fn pending(&self) -> &[PendingSpawn] {
        &self.file.pending
    }

    pub fn get_pending(&self, id: &str) -> Option<&PendingSpawn> {
        self.file.pending.iter().find(|p| p.id == id)
    }

    pub fn held(&self) -> &[HeldSpawn] {
        &self.file.held
    }

    pub fn get_held(&self, id: &str) -> Option<&HeldSpawn> {
        self.file.held.iter().find(|h| h.id == id)
    }

    /// Take proposals under fresh ids, in the order given, each pending or held as it says, all in one
    /// write before this returns.
    pub fn take(
        &mut self,
        entries: Vec<TakenProposal>,
    ) -> Result<(Vec<PendingSpawn>, Vec<HeldSpawn>), js::FsError> {
        let mut pending = Vec::new();
        let mut held = Vec::new();
        for entry in entries {
            let id = self.next_id();
            match entry.held {
                None => pending.push(PendingSpawn {
                    id,
                    parent_id: entry.parent_id,
                    origin: entry.origin,
                    proposal: entry.proposal,
                    at: entry.at,
                    landing: None,
                }),
                Some(reason) => held.push(HeldSpawn {
                    id,
                    parent_id: entry.parent_id,
                    origin: entry.origin,
                    proposal: entry.proposal,
                    reason,
                    at: entry.at,
                    adopt_error: None,
                    unknown_overlaps: entry.unknown_overlaps.filter(|ids| !ids.is_empty()),
                }),
            }
        }
        self.file.pending.extend(pending.iter().cloned());
        self.file.held.extend(held.iter().cloned());
        self.write()?;
        Ok((pending, held))
    }

    /// Hold proposals under fresh ids, written before this returns.
    pub fn hold(&mut self, entries: Vec<NewHeldSpawn>) -> Result<Vec<HeldSpawn>, js::FsError> {
        let held: Vec<HeldSpawn> = entries
            .into_iter()
            .map(|entry| {
                let id = self.next_id();
                entry.with_id(id)
            })
            .collect();
        self.file.held.extend(held.iter().cloned());
        self.write()?;
        Ok(held)
    }

    fn move_to_held(
        &mut self,
        id: &str,
        reason: HeldSpawnReason,
        at: &str,
        adopt_error: Option<String>,
    ) -> Result<Option<HeldSpawn>, js::FsError> {
        let Some(index) = self.file.pending.iter().position(|p| p.id == id) else {
            return Ok(None);
        };
        let found = self.file.pending.remove(index);
        self.file.pending.retain(|p| p.id != id);
        let held = HeldSpawn {
            id: id.to_owned(),
            parent_id: found.parent_id,
            origin: found.origin,
            proposal: found.proposal,
            reason,
            at: at.to_owned(),
            adopt_error,
            unknown_overlaps: None,
        };
        self.file.held.push(held.clone());
        self.write()?;
        Ok(Some(held))
    }

    /// The operator's Hold of a Pending spawn: held for "operator" under the same id, in one write.
    /// `None` when it is not pending (landed, discarded, or never).
    pub fn hold_pending(&mut self, id: &str, at: &str) -> Result<Option<HeldSpawn>, js::FsError> {
        self.move_to_held(id, HeldSpawnReason::Operator, at, None)
    }

    /// The boundary could not land a Pending spawn: held for "refused" under the same id, the reason
    /// kept as its adoptError, in one write.
    pub fn hold_refused(
        &mut self,
        id: &str,
        reason: &str,
        at: &str,
    ) -> Result<Option<HeldSpawn>, js::FsError> {
        self.move_to_held(id, HeldSpawnReason::Refused, at, Some(reason.to_owned()))
    }

    /// Drop a Pending spawn (discarded by the operator).
    pub fn remove_pending(&mut self, id: &str) -> Result<Option<PendingSpawn>, js::FsError> {
        let Some(found) = self.get_pending(id).cloned() else {
            return Ok(None);
        };
        self.file.pending.retain(|p| p.id != id);
        self.write()?;
        Ok(Some(found))
    }

    /// Record the ids the boundary is about to land these Pending spawns under, in one write before any
    /// ticket file is.
    pub fn mark_landing(&mut self, landing: &HashMap<String, String>) -> Result<(), js::FsError> {
        if landing.is_empty() {
            return Ok(());
        }
        for pending in &mut self.file.pending {
            if let Some(id) = landing.get(&pending.id) {
                pending.landing = Some(id.clone());
            }
        }
        self.write()
    }

    /// Forget a landing mark whose ticket never landed: it waits again.
    pub fn clear_landing(&mut self, id: &str) -> Result<(), js::FsError> {
        let Some(found) = self.file.pending.iter_mut().find(|p| p.id == id) else {
            return Ok(());
        };
        if found.landing.take().is_none() {
            return Ok(());
        }
        self.write()
    }

    /// Drop Pending spawns that landed, in one write.
    pub fn landed(&mut self, ids: &[String]) -> Result<(), js::FsError> {
        if ids.is_empty() {
            return Ok(());
        }
        self.file.pending.retain(|p| !ids.contains(&p.id));
        self.write()
    }

    /// Drop one held spawn (adopted or discarded), written before this returns.
    pub fn remove_held(&mut self, id: &str) -> Result<Option<HeldSpawn>, js::FsError> {
        let Some(found) = self.get_held(id).cloned() else {
            return Ok(None);
        };
        self.file.held.retain(|h| h.id != id);
        self.adopting.retain(|a| a != id);
        self.write()?;
        Ok(Some(found))
    }

    /// Whether this id was ever issued to a proposal of this pool: pending, held, or since landed or
    /// discarded. An `overlaps` mark may name any of them.
    pub fn is_proposal_id(&self, id: &str) -> bool {
        let Some(caps) = PROPOSAL_ID.captures(id) else {
            return false;
        };
        let n: f64 = caps[2].parse().unwrap_or(f64::INFINITY);
        let (from, seq) = (self.file.proposal_from as f64, self.file.seq as f64);
        if &caps[1] == "held" {
            n >= 1.0 && n <= from
        } else {
            n > from && n <= seq
        }
    }

    /// Whether boot has already recovered the truncation under this key.
    pub fn was_recovered(&self, key: &str) -> bool {
        self.file.recovered.iter().any(|k| k == key)
    }

    /// Hold a recovery's proposals and mark its key, in one write.
    pub fn recover(
        &mut self,
        key: &str,
        entries: Vec<NewHeldSpawn>,
    ) -> Result<Vec<HeldSpawn>, js::FsError> {
        let held: Vec<HeldSpawn> = entries
            .into_iter()
            .map(|entry| {
                let id = self.next_id();
                entry.with_id(id)
            })
            .collect();
        self.file.held.extend(held.iter().cloned());
        self.file.recovered.push(key.to_owned());
        self.write()?;
        Ok(held)
    }

    /// The held ids an Adopt has queued for the boundary, in the order the operator adopted them. In
    /// memory only: after a restart the spawn is simply held again.
    pub fn adopting(&self) -> &[String] {
        &self.adopting
    }

    pub fn is_adopting(&self, id: &str) -> bool {
        self.adopting.iter().any(|a| a == id)
    }

    /// An Adopt is queued: mark it adopting and clear any earlier refusal.
    pub fn begin_adopt(&mut self, id: &str) -> Result<(), js::FsError> {
        if !self.is_adopting(id) {
            self.adopting.push(id.to_owned());
        }
        let Some(held) = self.file.held.iter_mut().find(|h| h.id == id) else {
            return Ok(());
        };
        if held.adopt_error.take().is_none() {
            return Ok(());
        }
        self.write()
    }

    /// The boundary refused the Adopt: still held, the reason kept on it.
    pub fn refuse_adopt(&mut self, id: &str, reason: &str) -> Result<(), js::FsError> {
        self.adopting.retain(|a| a != id);
        let Some(held) = self.file.held.iter_mut().find(|h| h.id == id) else {
            return Ok(());
        };
        held.adopt_error = Some(reason.to_owned());
        self.write()
    }

    /// Each Pending spawn as the Console shows it.
    pub fn pending_views(&self) -> Vec<PendingSpawnView> {
        self.file
            .pending
            .iter()
            .map(|p| {
                let base = view_base(&p.proposal);
                PendingSpawnView {
                    id: p.id.clone(),
                    parent_id: p.parent_id.clone(),
                    origin: p.origin,
                    kind: base.kind,
                    title: base.title,
                    body: base.body,
                    blocked_by: base.blocked_by,
                    blocks: base.blocks,
                    overlaps: base.overlaps,
                    at: p.at.clone(),
                }
            })
            .collect()
    }

    /// Each Held spawn as the Console shows it, whether an Adopt is on its way included.
    pub fn held_views(&self) -> Vec<HeldSpawnView> {
        self.file
            .held
            .iter()
            .map(|h| {
                let base = view_base(&h.proposal);
                HeldSpawnView {
                    id: h.id.clone(),
                    parent_id: h.parent_id.clone(),
                    origin: h.origin,
                    kind: base.kind,
                    title: base.title,
                    body: base.body,
                    blocked_by: base.blocked_by,
                    blocks: base.blocks,
                    overlaps: base.overlaps,
                    at: h.at.clone(),
                    reason: h.reason,
                    unknown_overlaps: h.unknown_overlaps.clone().unwrap_or_default(),
                    adopting: self.is_adopting(&h.id),
                    adopt_error: h.adopt_error.clone(),
                }
            })
            .collect()
    }
}

struct ViewBase {
    kind: SpawnKind,
    title: String,
    body: String,
    blocked_by: Vec<String>,
    blocks: Option<ac_protocol::SpawnBlocks>,
    overlaps: Vec<String>,
}

fn view_base(proposal: &SpawnProposal) -> ViewBase {
    ViewBase {
        kind: proposal.kind.unwrap_or(SpawnKind::Ticket),
        title: proposal.title.clone(),
        body: proposal.body.clone(),
        blocked_by: proposal.blocked_by.clone().unwrap_or_default(),
        blocks: proposal.blocks.clone(),
        overlaps: proposal.overlaps.clone().unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ac_protocol::{AllTickets, SpawnBlocks};
    use serde_json::json;
    use std::fs;

    fn runs_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("spawn-proposals-")
            .tempdir()
            .unwrap()
    }

    fn proposal(title: &str) -> SpawnProposal {
        SpawnProposal {
            title: title.into(),
            body: "A body long enough to stand.".into(),
            blocked_by: None,
            kind: None,
            assign: None,
            verify_ignored: None,
            blocks: None,
            overlaps: None,
        }
    }

    fn to_hold(
        parent: &str,
        origin: SpawnKind,
        title: &str,
        reason: HeldSpawnReason,
        at: &str,
    ) -> NewHeldSpawn {
        NewHeldSpawn {
            parent_id: parent.into(),
            origin,
            proposal: proposal(title),
            reason,
            at: at.into(),
            adopt_error: None,
            unknown_overlaps: None,
        }
    }

    fn taken(title: &str, held: Option<HeldSpawnReason>) -> TakenProposal {
        TakenProposal {
            parent_id: "01".into(),
            origin: SpawnKind::Ticket,
            proposal: proposal(title),
            at: "t1".into(),
            held,
            unknown_overlaps: None,
        }
    }

    fn ids<T>(items: &[T], id: impl Fn(&T) -> &str) -> Vec<String> {
        items.iter().map(|item| id(item).to_owned()).collect()
    }

    #[test]
    fn starts_empty_when_the_pool_has_never_held_a_spawn() {
        let dir = runs_dir();
        assert!(load_spawn_proposals(dir.path()).unwrap().held().is_empty());
    }

    // The ids are the pool's, never reused: a discarded proposal-1 must not come back as the name of a
    // different proposal after a restart.
    #[test]
    fn holds_proposals_under_ids_that_survive_a_reload_and_are_never_reused() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        let held = store
            .hold(vec![
                to_hold(
                    "01",
                    SpawnKind::Ticket,
                    "A",
                    HeldSpawnReason::PerAttempt,
                    "t1",
                ),
                to_hold("01", SpawnKind::Ticket, "B", HeldSpawnReason::PerRun, "t1"),
            ])
            .unwrap();
        assert_eq!(ids(&held, |h| &h.id), ["proposal-1", "proposal-2"]);
        assert_eq!(
            store
                .remove_held("proposal-2")
                .unwrap()
                .unwrap()
                .proposal
                .title,
            "B"
        );

        let mut reloaded = load_spawn_proposals(dir.path()).unwrap();
        assert_eq!(
            serde_json::to_value(reloaded.held()).unwrap(),
            json!([{ "id": "proposal-1", "parentId": "01", "origin": "ticket",
                     "proposal": {"title": "A", "body": "A body long enough to stand."},
                     "reason": "per-attempt", "at": "t1" }])
        );
        let next = reloaded
            .hold(vec![to_hold(
                "02",
                SpawnKind::Conversation,
                "C",
                HeldSpawnReason::PerAttempt,
                "t2",
            )])
            .unwrap();
        assert_eq!(next[0].id, "proposal-3");
        assert_eq!(reloaded.remove_held("proposal-9").unwrap(), None);
    }

    // Recovery (ADR-0029) must run once per truncation, whatever the operator did with what it
    // recovered since: the mark and the holds land together.
    #[test]
    fn records_a_recovery_with_its_holds_in_one_write_so_it_is_never_run_twice() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        assert!(!store.was_recovered("01@t0"));
        let held = store
            .recover(
                "01@t0",
                vec![to_hold(
                    "01",
                    SpawnKind::Ticket,
                    "Lost",
                    HeldSpawnReason::PerRun,
                    "t0",
                )],
            )
            .unwrap();
        assert_eq!(ids(&held, |h| &h.id), ["proposal-1"]);
        store.remove_held("proposal-1").unwrap();
        let reloaded = load_spawn_proposals(dir.path()).unwrap();
        assert!(reloaded.was_recovered("01@t0"));
        assert!(reloaded.held().is_empty());
    }

    // An Adopt the boundary refused leaves the spawn held with the reason (ADR-0029), kept across a
    // restart, and the next Adopt clears it.
    #[test]
    fn records_a_refused_adopts_reason_on_the_held_spawn_until_the_next_adopt() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        store
            .hold(vec![to_hold(
                "01",
                SpawnKind::Ticket,
                "A",
                HeldSpawnReason::PerRun,
                "t1",
            )])
            .unwrap();
        store.begin_adopt("proposal-1").unwrap();
        assert!(store.held_views()[0].adopting);
        assert_eq!(store.held_views()[0].adopt_error, None);
        assert_eq!(store.adopting(), ["proposal-1"]);

        store
            .refuse_adopt("proposal-1", "blocks names done tickets: 02")
            .unwrap();
        let view = &store.held_views()[0];
        assert!(!view.adopting);
        assert_eq!(
            view.adopt_error.as_deref(),
            Some("blocks names done tickets: 02")
        );
        assert_eq!(
            load_spawn_proposals(dir.path()).unwrap().held_views()[0]
                .adopt_error
                .as_deref(),
            Some("blocks names done tickets: 02")
        );

        store.begin_adopt("proposal-1").unwrap();
        assert_eq!(store.held_views()[0].adopt_error, None);
        assert_eq!(
            load_spawn_proposals(dir.path()).unwrap().held_views()[0].adopt_error,
            None
        );
    }

    #[test]
    fn writes_through_a_rename_leaving_no_temporary_file_behind() {
        let dir = runs_dir();
        load_spawn_proposals(dir.path())
            .unwrap()
            .hold(vec![to_hold(
                "01",
                SpawnKind::Ticket,
                "A",
                HeldSpawnReason::PerAttempt,
                "t1",
            )])
            .unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["held-spawns.json"]);
        assert_eq!(
            fs::read_to_string(dir.path().join("held-spawns.json")).unwrap(),
            "{\n  \"seq\": 1,\n  \"proposalFrom\": 0,\n  \"pending\": [],\n  \"held\": [\n    {\n      \"id\": \"proposal-1\",\n      \"parentId\": \"01\",\n      \"origin\": \"ticket\",\n      \"proposal\": {\n        \"title\": \"A\",\n        \"body\": \"A body long enough to stand.\"\n      },\n      \"reason\": \"per-attempt\",\n      \"at\": \"t1\"\n    }\n  ],\n  \"recovered\": []\n}\n"
        );
    }

    #[test]
    fn refuses_a_file_it_cannot_read_rather_than_holding_over_it() {
        let dir = runs_dir();
        let path = dir.path().join("held-spawns.json");
        fs::write(&path, "{torn").unwrap();
        let err = load_spawn_proposals(dir.path()).unwrap_err().to_string();
        assert!(
            err.starts_with(&format!(
                "spawn proposals: {} cannot be read (JSON Parse error: ",
                path.display()
            )),
            "{err}"
        );
        fs::write(&path, r#"{"seq":1,"held":[{"id":"proposal-1"}]}"#).unwrap();
        assert!(
            load_spawn_proposals(dir.path())
                .unwrap_err()
                .to_string()
                .contains("cannot be read")
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"seq":1,"held":[{"id":"proposal-1"}]}"#
        );
    }

    // The Console's view: the proposal flattened, and whether an Adopt is already on its way.
    #[test]
    fn serves_each_held_spawn_as_the_console_shows_it_adopting_included() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        let mut first = to_hold("01", SpawnKind::Ticket, "A", HeldSpawnReason::PerRun, "t1");
        first.proposal.blocked_by = Some(vec!["02".into()]);
        first.proposal.blocks = Some(SpawnBlocks::All(AllTickets::All));
        let mut second = to_hold(
            "c-1",
            SpawnKind::Conversation,
            "B",
            HeldSpawnReason::PerAttempt,
            "t2",
        );
        second.proposal.kind = Some(SpawnKind::Conversation);
        store.hold(vec![first, second]).unwrap();
        store.begin_adopt("proposal-2").unwrap();
        assert_eq!(
            serde_json::to_value(store.held_views()).unwrap(),
            json!([
                { "id": "proposal-1", "parentId": "01", "origin": "ticket", "kind": "ticket", "title": "A",
                  "body": "A body long enough to stand.", "blockedBy": ["02"], "blocks": "all", "overlaps": [],
                  "at": "t1", "reason": "per-run", "unknownOverlaps": [], "adopting": false },
                { "id": "proposal-2", "parentId": "c-1", "origin": "conversation", "kind": "conversation",
                  "title": "B", "body": "A body long enough to stand.", "blockedBy": [], "blocks": null,
                  "overlaps": [], "at": "t2", "reason": "per-attempt", "unknownOverlaps": [], "adopting": true },
            ])
        );
    }

    // Issue #150: a proposal taken from an exited attempt is on disk at once, so a restart before the
    // boundary finds it still pending.
    #[test]
    fn takes_proposals_as_pending_or_held_in_one_write_in_order_surviving_a_reload() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        let mut overlapping = taken("D", Some(HeldSpawnReason::Overlaps));
        overlapping.unknown_overlaps = Some(Vec::new());
        let (pending, held) = store
            .take(vec![
                taken("A", None),
                taken("B", Some(HeldSpawnReason::PerRun)),
                taken("C", None),
                overlapping,
            ])
            .unwrap();
        assert_eq!(ids(&pending, |p| &p.id), ["proposal-1", "proposal-3"]);
        assert_eq!(
            held.iter()
                .map(|h| (h.id.as_str(), h.reason))
                .collect::<Vec<_>>(),
            [
                ("proposal-2", HeldSpawnReason::PerRun),
                ("proposal-4", HeldSpawnReason::Overlaps)
            ]
        );
        // An empty unknownOverlaps is left out.
        assert_eq!(held[1].unknown_overlaps, None);

        let reloaded = load_spawn_proposals(dir.path()).unwrap();
        assert_eq!(
            serde_json::to_value(reloaded.pending()).unwrap(),
            json!([
                { "id": "proposal-1", "parentId": "01", "origin": "ticket",
                  "proposal": {"title": "A", "body": "A body long enough to stand."}, "at": "t1" },
                { "id": "proposal-3", "parentId": "01", "origin": "ticket",
                  "proposal": {"title": "C", "body": "A body long enough to stand."}, "at": "t1" },
            ])
        );
        assert_eq!(
            ids(reloaded.held(), |h| &h.id),
            ["proposal-2", "proposal-4"]
        );
    }

    // The id an agent read from the Spawn ledger keeps naming the proposal when the operator holds it.
    #[test]
    fn holds_a_pending_spawn_for_the_operator_under_the_same_id() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        store.take(vec![taken("A", None)]).unwrap();
        let held = store.hold_pending("proposal-1", "t2").unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&held).unwrap(),
            json!({ "id": "proposal-1", "parentId": "01", "origin": "ticket",
                    "proposal": {"title": "A", "body": "A body long enough to stand."},
                    "reason": "operator", "at": "t2" })
        );
        assert!(store.pending().is_empty());
        assert_eq!(
            ids(load_spawn_proposals(dir.path()).unwrap().held(), |h| &h.id),
            ["proposal-1"]
        );
        assert_eq!(store.hold_pending("proposal-1", "t3").unwrap(), None);
    }

    #[test]
    fn removes_a_pending_spawn_once_and_forgets_landed_ones_in_one_write() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        store
            .take(vec![taken("A", None), taken("B", None), taken("C", None)])
            .unwrap();
        assert_eq!(
            store
                .remove_pending("proposal-2")
                .unwrap()
                .unwrap()
                .proposal
                .title,
            "B"
        );
        assert_eq!(store.remove_pending("proposal-2").unwrap(), None);
        store
            .landed(&["proposal-1".into(), "proposal-3".into()])
            .unwrap();
        assert!(
            load_spawn_proposals(dir.path())
                .unwrap()
                .pending()
                .is_empty()
        );
    }

    // A crash between the landing mark and the ticket file is told apart at boot by the id the mark
    // names.
    #[test]
    fn keeps_a_landing_mark_across_a_reload_until_it_is_cleared() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        store
            .take(vec![taken("A", None), taken("B", None)])
            .unwrap();
        store
            .mark_landing(&HashMap::from([(
                "proposal-2".to_owned(),
                "01-spawn-1".to_owned(),
            )]))
            .unwrap();
        let mut reloaded = load_spawn_proposals(dir.path()).unwrap();
        assert_eq!(
            reloaded
                .get_pending("proposal-2")
                .unwrap()
                .landing
                .as_deref(),
            Some("01-spawn-1")
        );
        assert_eq!(reloaded.get_pending("proposal-1").unwrap().landing, None);
        reloaded.clear_landing("proposal-2").unwrap();
        assert_eq!(
            load_spawn_proposals(dir.path())
                .unwrap()
                .get_pending("proposal-2")
                .unwrap()
                .landing,
            None
        );
    }

    // An overlaps mark may name a proposal that has since landed or gone.
    #[test]
    fn knows_every_proposal_id_it_ever_issued_and_none_it_did_not() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        store
            .take(vec![taken("A", None), taken("B", None)])
            .unwrap();
        store.remove_pending("proposal-1").unwrap();
        assert!(store.is_proposal_id("proposal-1"));
        assert!(store.is_proposal_id("proposal-2"));
        assert!(!store.is_proposal_id("proposal-3"));
        // No held-N was ever issued in this pool.
        assert!(!store.is_proposal_id("held-2"));
        assert!(!store.is_proposal_id("07"));
    }

    // A pool that held spawns before issue #150 issued held-1..held-N; the ids issued since are
    // proposal-N, and neither name stands for the other.
    #[test]
    fn tells_the_held_n_ids_issued_before_issue_150_from_the_proposal_n_ids_after() {
        let dir = runs_dir();
        fs::write(
            dir.path().join("held-spawns.json"),
            js::stringify(&json!({"seq": 2, "held": [], "recovered": []})),
        )
        .unwrap();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        store.take(vec![taken("A", None)]).unwrap();
        let reloaded = load_spawn_proposals(dir.path()).unwrap();
        for s in [&store, &reloaded] {
            assert!(s.is_proposal_id("held-1"));
            assert!(s.is_proposal_id("held-2"));
            assert!(!s.is_proposal_id("held-3"));
            assert!(!s.is_proposal_id("held-0"));
            assert!(!s.is_proposal_id("proposal-2"));
            assert!(s.is_proposal_id("proposal-3"));
        }
    }

    // Issue #150 review: the boundary refusing a Pending spawn holds it, the reason kept, rather than
    // dropping it.
    #[test]
    fn holds_a_pending_spawn_the_boundary_refused_under_the_same_id_with_the_reason() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        store.take(vec![taken("A", None)]).unwrap();
        let held = store
            .hold_refused("proposal-1", "blocks names done tickets: 02", "t2")
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                held.id.as_str(),
                held.reason,
                held.adopt_error.as_deref(),
                held.at.as_str()
            ),
            (
                "proposal-1",
                HeldSpawnReason::Refused,
                Some("blocks names done tickets: 02"),
                "t2"
            )
        );
        assert!(store.pending().is_empty());
        let view = &load_spawn_proposals(dir.path()).unwrap().held_views()[0];
        assert_eq!(view.reason, HeldSpawnReason::Refused);
        assert_eq!(
            view.adopt_error.as_deref(),
            Some("blocks names done tickets: 02")
        );
        assert_eq!(
            store.hold_refused("proposal-1", "again", "t3").unwrap(),
            None
        );
    }

    // A pool that held spawns before issue #150 has no pending list.
    #[test]
    fn reads_a_held_spawns_file_from_before_pending_spawns_existed() {
        let dir = runs_dir();
        fs::write(
            dir.path().join("held-spawns.json"),
            js::stringify(&json!({
                "seq": 2,
                "held": [{ "id": "held-2", "parentId": "01", "origin": "ticket",
                           "proposal": {"title": "A", "body": "A body long enough to stand."},
                           "reason": "per-run", "at": "t0" }],
                "recovered": [],
            })),
        )
        .unwrap();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        assert!(store.pending().is_empty());
        assert_eq!(ids(store.held(), |h| &h.id), ["held-2"]);
        let (pending, _) = store.take(vec![taken("B", None)]).unwrap();
        assert_eq!(pending[0].id, "proposal-3");
        let written =
            js::parse(&fs::read_to_string(dir.path().join("held-spawns.json")).unwrap()).unwrap();
        assert_eq!(written["proposalFrom"], json!(2));
        assert_eq!(written["seq"], json!(3));
    }

    #[test]
    fn serves_each_pending_spawn_as_the_console_shows_it() {
        let dir = runs_dir();
        let mut store = load_spawn_proposals(dir.path()).unwrap();
        let mut entry = taken("A", None);
        entry.proposal.blocked_by = Some(vec!["02".into()]);
        entry.proposal.overlaps = Some(vec!["03".into()]);
        store.take(vec![entry]).unwrap();
        assert_eq!(
            serde_json::to_value(store.pending_views()).unwrap(),
            json!([{ "id": "proposal-1", "parentId": "01", "origin": "ticket", "kind": "ticket", "title": "A",
                     "body": "A body long enough to stand.", "blockedBy": ["02"], "blocks": null,
                     "overlaps": ["03"], "at": "t1" }])
        );
    }
}
