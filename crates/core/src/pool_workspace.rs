//! The per-pool runtime file that remembers the Pool workspace (engine.ts, issue #94):
//! `runs/pool-workspace.json`, `{ "workspace_id": "wT" }`, plus `"created": true` and the `"label"` it
//! last gave a workspace the Console made itself (issue #100). A runtime fact of this engine's own,
//! never pool configuration, so it lives beside the other runs artifacts and never in console.json:
//! the operator neither writes it nor reviews it, and a pool copied elsewhere must not drag another
//! machine's workspace id along in a file under version control.

use std::path::Path;

use serde_json::{Map, Value};

use crate::js;

/// The file's name under runs/.
pub const POOL_WORKSPACE_FILE: &str = "pool-workspace.json";

/// What the runs directory remembers about the Pool workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RememberedPoolWorkspace {
    pub id: String,
    /// The Console created it (issue #100). A file from before titles says nothing, which reads as
    /// false.
    pub created: bool,
    pub label: Option<String>,
}

/// The remembered workspace, or `None` when there is none to trust. Unreadable, torn, or holding
/// something that is not an id: the pool simply forgets where its tabs were and resolves afresh.
/// Provenance is recorded, never guessed: a file that does not say the Console made the workspace is
/// read as the operator's, so a pool remembered from before titles never has its workspace relabelled.
pub fn read_remembered_pool_workspace(runs_dir: &Path) -> Option<RememberedPoolWorkspace> {
    let path = runs_dir.join(POOL_WORKSPACE_FILE);
    if !path.exists() {
        return None;
    }
    let Ok(Value::Object(parsed)) = js::parse(&js::read_text(&path).ok()?) else {
        return None;
    };
    let id = parsed
        .get("workspace_id")?
        .as_str()
        .filter(|id| !id.is_empty())?;
    Some(RememberedPoolWorkspace {
        id: id.to_owned(),
        created: parsed.get("created") == Some(&Value::Bool(true)),
        label: parsed
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// Remember the workspace, written through a rename so a crash mid-write leaves the previous id, never
/// half of one. A workspace the Console created carries that fact and the label it last gave it (issue
/// #100), so a later boot knows it may relabel it; any other is the bare id, as before titles. The
/// error reads as Bun's, for the pool log line that says the id could not be remembered.
pub fn remember_pool_workspace(
    runs_dir: &Path,
    workspace: &RememberedPoolWorkspace,
) -> Result<(), js::FsError> {
    let path = runs_dir.join(POOL_WORKSPACE_FILE);
    let temp = runs_dir.join(format!("{POOL_WORKSPACE_FILE}.tmp"));
    let mut record = Map::new();
    record.insert("workspace_id".into(), Value::String(workspace.id.clone()));
    if workspace.created {
        record.insert("created".into(), Value::Bool(true));
        if let Some(label) = &workspace.label {
            record.insert("label".into(), Value::String(label.clone()));
        }
    }
    js::write_through_rename(
        &path,
        &temp,
        &format!("{}\n", js::stringify(&Value::Object(record))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_runs() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("pool-workspace-")
            .tempdir()
            .unwrap()
    }

    fn remembered(id: &str, created: bool, label: Option<&str>) -> RememberedPoolWorkspace {
        RememberedPoolWorkspace {
            id: id.into(),
            created,
            label: label.map(str::to_owned),
        }
    }

    #[test]
    fn writes_the_bare_id_for_a_workspace_the_console_did_not_make() {
        let runs = temp_runs();
        // The label is the Console's only for a workspace it made.
        remember_pool_workspace(runs.path(), &remembered("w7", false, Some("ignored"))).unwrap();
        assert_eq!(
            fs::read_to_string(runs.path().join(POOL_WORKSPACE_FILE)).unwrap(),
            "{\"workspace_id\":\"w7\"}\n"
        );
        assert_eq!(
            read_remembered_pool_workspace(runs.path()),
            Some(remembered("w7", false, None))
        );
    }

    #[test]
    fn writes_provenance_and_label_for_a_workspace_the_console_made() {
        let runs = temp_runs();
        remember_pool_workspace(runs.path(), &remembered("w8", true, Some("My pool"))).unwrap();
        assert_eq!(
            fs::read_to_string(runs.path().join(POOL_WORKSPACE_FILE)).unwrap(),
            "{\"workspace_id\":\"w8\",\"created\":true,\"label\":\"My pool\"}\n"
        );
        assert_eq!(
            read_remembered_pool_workspace(runs.path()),
            Some(remembered("w8", true, Some("My pool")))
        );
        remember_pool_workspace(runs.path(), &remembered("w8", true, None)).unwrap();
        assert_eq!(
            fs::read_to_string(runs.path().join(POOL_WORKSPACE_FILE)).unwrap(),
            "{\"workspace_id\":\"w8\",\"created\":true}\n"
        );
        let names: Vec<_> = fs::read_dir(runs.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [POOL_WORKSPACE_FILE]);
    }

    #[test]
    fn forgets_a_file_it_cannot_trust() {
        let runs = temp_runs();
        assert_eq!(read_remembered_pool_workspace(runs.path()), None);
        for text in [
            "{torn",
            "[]",
            "{}",
            r#"{"workspace_id":""}"#,
            r#"{"workspace_id":7}"#,
        ] {
            fs::write(runs.path().join(POOL_WORKSPACE_FILE), text).unwrap();
            assert_eq!(read_remembered_pool_workspace(runs.path()), None, "{text}");
        }
        // A file from before titles, or one that does not say true, is the operator's workspace.
        fs::write(
            runs.path().join(POOL_WORKSPACE_FILE),
            r#"{"workspace_id":"w1","created":"yes","label":5}"#,
        )
        .unwrap();
        assert_eq!(
            read_remembered_pool_workspace(runs.path()),
            Some(remembered("w1", false, None))
        );
    }

    #[test]
    fn says_why_it_could_not_remember_as_bun_would() {
        let runs = temp_runs();
        let missing = runs.path().join("gone");
        let err = remember_pool_workspace(&missing, &remembered("w1", false, None)).unwrap_err();
        assert_eq!(
            err.to_string(),
            format!(
                "ENOENT: no such file or directory, open '{}'",
                missing.join("pool-workspace.json.tmp").display()
            )
        );
    }
}
