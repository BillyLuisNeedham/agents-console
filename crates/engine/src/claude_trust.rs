//! Folder trust for claude (issue #127, ADR-0025; claude-trust.ts): the engine vouches for the
//! directories it makes, so an interactive claude never meets its workspace trust dialog in a pool
//! worktree.
//!
//! claude keeps a per-directory record of the operator having accepted that dialog,
//! `projects[<absolute path>].hasTrustDialogAccepted` in `~/.claude.json`, and skips the dialog when it
//! is true. Every pool worktree is a directory claude has never seen, so without a seed every
//! terminal-backed claude Attempt starts on the dialog, inside the readiness wait's budget.
//!
//! The write is add-only and mirrors claude's own: the whole file re-read, the one entry set, the result
//! written to a sibling temp file and renamed over the original. Two-space indent and no trailing
//! newline match claude's output, so a diff of the file shows only the entry. A seed can in principle be
//! lost to another claude session that read the file before it and wrote after; the pane's dialog
//! handler (`pane_session`) remains behind the seed for that case. Nothing is ever removed.

use std::io::Read;

use serde_json::{Map, Value, json};

use ac_core::js;

/// Where claude keeps its per-machine state, the file the seed lands in: `.claude.json` under
/// `CLAUDE_CONFIG_DIR` when that is set and not blank, as claude itself resolves it, else under the home
/// directory. The caller reads the variable and the home directory (only the CLI reads the
/// environment).
pub fn default_claude_config_path(claude_config_dir: Option<&str>, home: &str) -> String {
    let config_dir = claude_config_dir.map(js::trim).unwrap_or_default();
    let dir = if config_dir.is_empty() {
        home
    } else {
        config_dir
    };
    js::path_join(&[dir, ".claude.json"])
}

/// What one seed did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderTrustSeed {
    /// The entry was written for these paths (the path and, when it differs, its realpath).
    Seeded { paths: Vec<String> },
    /// claude already trusted the directory; the file was not touched.
    Already,
    /// The file could not be seeded; the reason says why, for the pool log and the spawned event.
    Skipped { reason: String },
}

impl FolderTrustSeed {
    /// The `spawned` event's record of the seed: one word, or a skip with its reason.
    pub fn note(&self) -> String {
        match self {
            FolderTrustSeed::Seeded { .. } => "seeded".to_owned(),
            FolderTrustSeed::Already => "already".to_owned(),
            FolderTrustSeed::Skipped { reason } => format!("skipped: {reason}"),
        }
    }
}

// claude's own default entry for a directory it has just seen (read from the 2.1.276 binary); the seed
// adds the trust flag to it so a fresh entry looks the way claude would have written it.
fn fresh_project_entry() -> Value {
    json!({
        "allowedTools": [],
        "mcpContextUris": [],
        "mcpServers": {},
        "enabledMcpjsonServers": [],
        "disabledMcpjsonServers": [],
        "hasTrustDialogAccepted": true,
        "hasClaudeMdExternalIncludesApproved": false,
        "hasClaudeMdExternalIncludesWarningShown": false,
    })
}

fn is_trusted(entry: Option<&Value>) -> bool {
    entry
        .and_then(Value::as_object)
        .and_then(|entry| entry.get("hasTrustDialogAccepted"))
        == Some(&Value::Bool(true))
}

/// Mark `cwd` as trusted in claude's config so an interactive claude started there skips its workspace
/// trust dialog. claude keys the map by its process's cwd, which the kernel has already resolved, so
/// when the path and its realpath differ both are seeded. A missing file (claude has never run on this
/// machine) or one that does not parse is left alone: a seed is never worth corrupting the operator's
/// config, and the dialog handler covers the launch.
pub fn seed_claude_folder_trust(cwd: &str, config_path: &str) -> FolderTrustSeed {
    if !js::exists(config_path) {
        return FolderTrustSeed::Skipped {
            reason: format!("{config_path} does not exist"),
        };
    }
    // A dotfile-managed config is often a symlink; the rename below must land on the file it points
    // at, not replace the link with a plain file.
    let config_path = js::realpath(config_path)
        .map(|real| js::path_text(&real))
        .unwrap_or_else(|_| config_path.to_owned());
    let mut config = match js::read_text(&config_path)
        .map_err(|err| err.to_string())
        .and_then(|text| js::parse(&text).map_err(|err| err.to_string()))
    {
        Ok(Value::Object(config)) => config,
        Ok(_) => {
            return FolderTrustSeed::Skipped {
                reason: format!("{config_path} is not a JSON object"),
            };
        }
        Err(message) => {
            return FolderTrustSeed::Skipped {
                reason: format!("{config_path} did not parse: {message}"),
            };
        }
    };
    let mut projects = match config.get("projects") {
        Some(Value::Object(projects)) => projects.clone(),
        _ => Map::new(),
    };
    let mut paths = vec![cwd.to_owned()];
    if let Ok(real) = js::realpath(cwd) {
        let real = js::path_text(&real);
        if real != cwd {
            paths.push(real);
        }
    }
    let untrusted: Vec<String> = paths
        .into_iter()
        .filter(|path| !is_trusted(projects.get(path)))
        .collect();
    if untrusted.is_empty() {
        return FolderTrustSeed::Already;
    }
    for path in &untrusted {
        let entry = match projects.get(path) {
            Some(Value::Object(existing)) => {
                let mut entry = existing.clone();
                entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
                Value::Object(entry)
            }
            _ => fresh_project_entry(),
        };
        projects.insert(path.clone(), entry);
    }
    config.insert("projects".into(), Value::Object(projects));
    let temp_path = format!("{config_path}.tmp.{}.{}", std::process::id(), random_hex(6));
    if let Err(err) = js::write_through_rename(
        &config_path,
        &temp_path,
        &js::stringify_pretty(&Value::Object(config)),
    ) {
        let _ = std::fs::remove_file(&temp_path);
        return FolderTrustSeed::Skipped {
            reason: format!("{config_path} could not be written: {err}"),
        };
    }
    FolderTrustSeed::Seeded { paths: untrusted }
}

// `randomBytes(n).toString("hex")`: from the system's random source, else the clock.
fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    let random = std::fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut buffer))
        .is_ok();
    if !random {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        for (index, byte) in buffer.iter_mut().enumerate() {
            *byte = (nanos >> (index * 8)) as u8;
        }
    }
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    //! engine/claude-trust.test.ts, and the hidden row claude-trust.test.ts:122 (the realpath seeded
    //! beside the path).

    use super::*;
    use std::fs;
    use std::path::Path;

    struct Scratch {
        _dir: tempfile::TempDir,
        dir: String,
        config: String,
        worktree: String,
    }

    fn scratch() -> Scratch {
        let dir = tempfile::Builder::new()
            .prefix("claude-trust-")
            .tempdir()
            .unwrap();
        let root = js::path_text(&fs::canonicalize(dir.path()).unwrap());
        let worktree = format!("{root}/pool-worktrees/abcd1234/01");
        fs::create_dir_all(&worktree).unwrap();
        Scratch {
            config: format!("{root}/claude.json"),
            dir: root,
            worktree,
            _dir: dir,
        }
    }

    // The shape of a real ~/.claude.json, in claude's own formatting.
    fn realistic_config(extra: Option<(&str, Value)>) -> String {
        let mut projects = Map::new();
        projects.insert(
            "/home/op/repos/other".into(),
            json!({ "allowedTools": [], "hasTrustDialogAccepted": true, "lastSessionId": "6f1c" }),
        );
        if let Some((path, entry)) = extra {
            projects.insert(path.into(), entry);
        }
        js::stringify_pretty(&json!({
            "numStartups": 795,
            "installMethod": "native",
            "projects": projects,
            "tipsHistory": { "shift-enter": 3 },
        }))
    }

    fn read(path: &str) -> Value {
        js::parse(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn adds_a_trusted_entry_keeping_everything_else() {
        let s = scratch();
        fs::write(&s.config, realistic_config(None)).unwrap();
        let seed = seed_claude_folder_trust(&s.worktree, &s.config);
        assert_eq!(
            seed,
            FolderTrustSeed::Seeded {
                paths: vec![s.worktree.clone()]
            }
        );
        let text = fs::read_to_string(&s.config).unwrap();
        // claude's formatting: two-space indent, no trailing newline.
        assert!(text.starts_with("{\n  \"numStartups\": 795,"));
        assert!(!text.ends_with('\n'));
        let config = read(&s.config);
        assert_eq!(config["projects"][&s.worktree], fresh_project_entry());
        assert_eq!(
            config["projects"]["/home/op/repos/other"]["lastSessionId"],
            "6f1c"
        );
        assert_eq!(config["tipsHistory"]["shift-enter"], 3);
        let keys: Vec<&String> = config.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            ["numStartups", "installMethod", "projects", "tipsHistory"]
        );
        // No temp file is left behind.
        let leftovers: Vec<_> = fs::read_dir(&s.dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn flips_an_untrusted_entry_and_keeps_its_fields() {
        let s = scratch();
        fs::write(
            &s.config,
            realistic_config(Some((
                &s.worktree,
                json!({ "allowedTools": ["Bash"], "hasTrustDialogAccepted": false, "x": 1 }),
            ))),
        )
        .unwrap();
        assert_eq!(
            seed_claude_folder_trust(&s.worktree, &s.config),
            FolderTrustSeed::Seeded {
                paths: vec![s.worktree.clone()]
            }
        );
        assert_eq!(
            read(&s.config)["projects"][&s.worktree],
            json!({ "allowedTools": ["Bash"], "hasTrustDialogAccepted": true, "x": 1 })
        );
    }

    #[test]
    fn leaves_a_trusted_directory_alone() {
        let s = scratch();
        let text = realistic_config(Some((
            &s.worktree,
            json!({ "hasTrustDialogAccepted": true }),
        )));
        fs::write(&s.config, &text).unwrap();
        assert_eq!(
            seed_claude_folder_trust(&s.worktree, &s.config),
            FolderTrustSeed::Already
        );
        assert_eq!(fs::read_to_string(&s.config).unwrap(), text);
    }

    #[test]
    fn seeds_the_realpath_beside_the_path_when_the_two_differ() {
        let s = scratch();
        fs::write(&s.config, realistic_config(None)).unwrap();
        let link = format!("{}/link", s.dir);
        std::os::unix::fs::symlink(format!("{}/pool-worktrees", s.dir), &link).unwrap();
        let via_link = format!("{link}/abcd1234/01");
        let seed = seed_claude_folder_trust(&via_link, &s.config);
        assert_eq!(
            seed,
            FolderTrustSeed::Seeded {
                paths: vec![via_link.clone(), s.worktree.clone()]
            }
        );
        let projects = &read(&s.config)["projects"];
        assert_eq!(projects[&via_link]["hasTrustDialogAccepted"], true);
        assert_eq!(projects[&s.worktree]["hasTrustDialogAccepted"], true);
    }

    #[test]
    fn writes_through_a_symlinked_config() {
        let s = scratch();
        let target = format!("{}/real-claude.json", s.dir);
        fs::write(&target, realistic_config(None)).unwrap();
        std::os::unix::fs::symlink(&target, &s.config).unwrap();
        assert!(matches!(
            seed_claude_folder_trust(&s.worktree, &s.config),
            FolderTrustSeed::Seeded { .. }
        ));
        assert!(
            fs::symlink_metadata(&s.config)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            read(&target)["projects"][&s.worktree]["hasTrustDialogAccepted"],
            true
        );
    }

    #[test]
    fn skips_a_machine_where_claude_never_ran() {
        let s = scratch();
        assert_eq!(
            seed_claude_folder_trust(&s.worktree, &s.config),
            FolderTrustSeed::Skipped {
                reason: format!("{} does not exist", s.config)
            }
        );
        assert!(!Path::new(&s.config).exists());
    }

    #[test]
    fn skips_a_file_it_cannot_parse() {
        let s = scratch();
        fs::write(&s.config, "{\"projects\": {").unwrap();
        let FolderTrustSeed::Skipped { reason } = seed_claude_folder_trust(&s.worktree, &s.config)
        else {
            panic!("an unparseable config is skipped");
        };
        assert!(reason.contains("did not parse"));
        assert_eq!(fs::read_to_string(&s.config).unwrap(), "{\"projects\": {");
    }

    #[test]
    fn skips_a_file_whose_top_level_is_not_an_object() {
        let s = scratch();
        fs::write(&s.config, "[]").unwrap();
        assert_eq!(
            seed_claude_folder_trust(&s.worktree, &s.config),
            FolderTrustSeed::Skipped {
                reason: format!("{} is not a JSON object", s.config)
            }
        );
        assert_eq!(fs::read_to_string(&s.config).unwrap(), "[]");
    }

    #[test]
    fn the_default_path_follows_claude_config_dir_then_home() {
        assert_eq!(
            default_claude_config_path(Some("/srv/claude"), "/home/op"),
            "/srv/claude/.claude.json"
        );
        assert_eq!(
            default_claude_config_path(Some("  "), "/home/op"),
            "/home/op/.claude.json"
        );
        assert_eq!(
            default_claude_config_path(None, "/home/op"),
            "/home/op/.claude.json"
        );
    }

    #[test]
    fn the_note_is_one_word_or_the_skip_reason() {
        assert_eq!(FolderTrustSeed::Already.note(), "already");
        assert_eq!(FolderTrustSeed::Seeded { paths: vec![] }.note(), "seeded");
        assert_eq!(
            FolderTrustSeed::Skipped {
                reason: "x does not exist".into()
            }
            .note(),
            "skipped: x does not exist"
        );
    }
}
