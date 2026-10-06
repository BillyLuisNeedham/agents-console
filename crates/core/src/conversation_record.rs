//! A Conversation's record on disk (the Conversations ADR, docs/adr/0018-conversations-beside-tickets.md):
//! `conversations/<id>.md`, a line-1 marker in the style of a Ticket's state line, the title heading and
//! the opening Turn. This is the file format only, ported from engine/conversations.ts's storage half:
//! the marker's fields and their order, reading and writing a record byte for byte, the status write,
//! and the ids the next record takes. The runtime that drives a Conversation lives in ac-engine.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use ac_protocol::{ConversationRole, ConversationStatus};
use anyhow::{Result, anyhow};
use regex::Regex;

use crate::js;
use crate::marker_file::{MarkerCache, field, marker_fields, read_marker_file, write_status_field};

/// What an enlisted Conversation was found as (issue #101): the pane the operator opened, its tab, its
/// directory and branch as found, and the harness session herdr reported. Absent for a started
/// Conversation, which has an engine-made worktree of its own; present exactly when the operator
/// enlisted an existing terminal. A live enlisted record is re-adopted at boot when its pane is still
/// in herdr's listing.
///
/// A record with no tab or no session is written `tab=none` or `session=none`, and the TypeScript
/// reads either back as the id `"none"`, not as no id; the port reads it the same way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnlistedConversation {
    pub pane_id: String,
    pub tab_id: Option<String>,
    pub directory: String,
    pub branch: String,
    pub session_id: Option<String>,
}

/// One Conversation as its file records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationRecord {
    pub id: String,
    pub file: PathBuf,
    pub title: String,
    pub opening: String,
    pub status: ConversationStatus,
    pub spawned_by: Option<String>,
    pub harness: String,
    pub model: String,
    /// The Assignment's effort (CONTEXT.md: Effort), when one resolved.
    pub effort: Option<String>,
    pub drivers: String,
    pub enlisted: Option<EnlistedConversation>,
    /// The role it was started or Enlisted in (ADR-0030): a Steward. Absent for an ordinary
    /// Conversation, and fixed for its life.
    pub role: Option<ConversationRole>,
}

/// The line-1 marker: `<!-- conversation: id=.. status=.. -->`.
pub static CONVERSATION_MARKER_RE: LazyLock<Regex> = LazyLock::new(|| {
    let ws = js::WHITESPACE_CLASS;
    let any = js::ANY_BUT_LINE_TERMINATOR;
    Regex::new(&format!(
        r"^<!--{ws}*conversation:{ws}*({any}+?){ws}*-->{ws}*$"
    ))
    .expect("the conversation marker pattern compiles")
});

static STATUS_FIELD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("status=[a-z]+").expect("the status field pattern compiles"));

static CONV_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^conv-([0-9]+)$").expect("the conv id pattern compiles"));

// Every view re-reads the conversations directory, once per snapshot and more (issue #157).
static READ_CACHE: MarkerCache<ConversationRecord> = MarkerCache::new();

fn decode(raw: &str) -> Result<String> {
    js::decode_uri_component(raw).map_err(|err| anyhow!(err))
}

/// The record a marker line describes, less its file, title and opening. Errors name the file.
fn parse_marker_line(line: &str, file: &Path) -> Result<ConversationRecord> {
    let Some(captures) = CONVERSATION_MARKER_RE.captures(line) else {
        return Err(anyhow!(
            "conversation load: {} has no line-1 conversation marker \
             (expected <!-- conversation: id=.. status=.. -->)",
            file.display()
        ));
    };
    let fields = marker_fields(captures.get(1).map_or("", |m| m.as_str()));
    let id = field(&fields, "id").filter(|id| !id.is_empty());
    let status = field(&fields, "status");
    let Some(id) = id else {
        return Err(anyhow!(
            "conversation load: {}: marker is missing id=",
            file.display()
        ));
    };
    let Some(status) = status.and_then(ConversationStatus::parse) else {
        return Err(anyhow!(
            "conversation load: {}: marker status must be one of live|ended|crashed, got '{}'",
            file.display(),
            status.unwrap_or("")
        ));
    };
    let spawned_by = match field(&fields, "spawned-by") {
        Some(raw) if !raw.is_empty() && raw != "none" => {
            Some(decode(raw)?).filter(|s| !s.is_empty())
        }
        _ => None,
    };
    // Enlist provenance (issue #101): written only for an enlisted Conversation, so its absence is
    // the ordinary started one.
    let enlisted = match field(&fields, "pane") {
        Some(pane) if !pane.is_empty() && pane != "none" => Some(EnlistedConversation {
            pane_id: decode(pane)?,
            tab_id: match field(&fields, "tab") {
                Some(tab) if !tab.is_empty() => Some(decode(tab)?),
                _ => None,
            },
            directory: decode(field(&fields, "directory").unwrap_or(""))?,
            branch: decode(field(&fields, "branch").unwrap_or(""))?,
            session_id: match field(&fields, "session") {
                Some(session) if !session.is_empty() => Some(decode(session)?),
                _ => None,
            },
        }),
        _ => None,
    };
    let harness = decode(field(&fields, "harness").unwrap_or(""))?;
    let model = decode(field(&fields, "model").unwrap_or(""))?;
    let effort = match field(&fields, "effort") {
        Some(effort) if !effort.is_empty() => Some(decode(effort)?),
        _ => None,
    };
    Ok(ConversationRecord {
        id: id.to_owned(),
        file: file.to_path_buf(),
        title: String::new(),
        opening: String::new(),
        status,
        spawned_by,
        harness,
        model,
        effort,
        drivers: decode(field(&fields, "drivers").unwrap_or(""))?,
        enlisted,
        role: (field(&fields, "role") == Some("steward")).then_some(ConversationRole::Steward),
    })
}

/// The record's line-1 marker, its fields in the order the TypeScript wrote them.
pub fn marker_line(rec: &ConversationRecord) -> String {
    let mut fields = vec![
        format!("id={}", rec.id),
        format!("status={}", rec.status),
        format!(
            "spawned-by={}",
            match rec.spawned_by.as_deref() {
                Some(parent) if !parent.is_empty() => js::encode_uri_component(parent),
                _ => "none".to_owned(),
            }
        ),
        format!("harness={}", js::encode_uri_component(&rec.harness)),
        format!("model={}", js::encode_uri_component(&rec.model)),
    ];
    // Written only when set, so a record with none reads exactly as before.
    if let Some(effort) = rec.effort.as_deref().filter(|e| !e.is_empty()) {
        fields.push(format!("effort={}", js::encode_uri_component(effort)));
    }
    fields.push(format!(
        "drivers={}",
        js::encode_uri_component(&rec.drivers)
    ));
    if let Some(enlisted) = &rec.enlisted {
        let or_none = |value: &Option<String>| match value.as_deref() {
            Some(text) if !text.is_empty() => js::encode_uri_component(text),
            _ => "none".to_owned(),
        };
        fields.push(format!(
            "pane={}",
            js::encode_uri_component(&enlisted.pane_id)
        ));
        fields.push(format!("tab={}", or_none(&enlisted.tab_id)));
        fields.push(format!(
            "directory={}",
            js::encode_uri_component(&enlisted.directory)
        ));
        fields.push(format!(
            "branch={}",
            js::encode_uri_component(&enlisted.branch)
        ));
        fields.push(format!("session={}", or_none(&enlisted.session_id)));
    }
    // Written only for a Steward, so an ordinary record reads exactly as before.
    if let Some(role) = rec.role {
        fields.push(format!("role={role}"));
    }
    format!("<!-- conversation: {} -->", fields.join(" "))
}

/// One Conversation's file, read and parsed.
pub fn read_conversation(file: &Path) -> Result<ConversationRecord> {
    let read = read_marker_file(file, parse_marker_line)?;
    Ok(ConversationRecord {
        title: read.title,
        opening: read.body,
        ..read.marker
    })
}

fn read_conversation_cached(file: &Path) -> Result<ConversationRecord> {
    READ_CACHE.read(file, read_conversation)
}

/// Every Conversation on disk, sorted by file name. An absent directory reads as none: a pool with no
/// Conversations yet is ordinary, unlike issues/.
pub fn load_conversations(dir: &Path) -> Result<Vec<ConversationRecord>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files: Vec<String> = js::read_dir_names(dir)?
        .into_iter()
        .filter(|name| name.ends_with(".md"))
        .collect();
    files.sort_by(|a, b| js::compare_utf16(a, b));
    files
        .iter()
        .map(|name| read_conversation_cached(&dir.join(name)))
        .collect()
}

/// The record's whole file: its marker, a blank line, the title heading, a blank line and the opening
/// Turn.
pub fn conversation_text(rec: &ConversationRecord) -> String {
    format!(
        "{}\n\n# {}\n\n{}\n",
        marker_line(rec),
        rec.title,
        rec.opening
    )
}

/// Write the record to its file, making the directory first.
pub fn write_conversation(dir: &Path, rec: &ConversationRecord) -> Result<()> {
    js::mkdir_all(dir)?;
    js::write_file(&rec.file, &conversation_text(rec))?;
    Ok(())
}

/// Rewrite only the marker's `status=` field, every other byte of the file kept, CRLF endings too.
pub fn write_conversation_status(file: &Path, status: ConversationStatus) -> Result<()> {
    write_status_field(
        file,
        &CONVERSATION_MARKER_RE,
        &STATUS_FIELD_RE,
        &status.to_string(),
        || {
            anyhow!(
                "conversation marker write: {} has no line-1 marker",
                file.display()
            )
        },
    )
}

/// The next operator-started id: `conv-N`, one past the highest existing and clear of any start still
/// in flight. Spawned Conversations get `<parent>-spawn-N` instead (`next_conversation_spawn_id`).
pub fn next_conversation_id<'a>(
    existing: impl IntoIterator<Item = &'a ConversationRecord>,
    reserved: impl Fn(&str) -> bool,
) -> String {
    let highest = existing
        .into_iter()
        .filter_map(|rec| CONV_ID_RE.captures(&rec.id))
        .filter_map(|caps| caps[1].parse::<f64>().ok())
        .fold(0.0_f64, f64::max);
    let mut n = highest;
    loop {
        n += 1.0;
        let id = format!("conv-{}", js::number_string(n));
        if !reserved(&id) {
            return id;
        }
    }
}

/// A spawned Conversation's id: `<parent>-spawn-N`, the same namespace ADR-0010 reserves for spawned
/// tickets (`pool::parse_spawn_id`), N counting per parent.
pub fn next_conversation_spawn_id<'a>(
    parent_id: &str,
    existing: impl IntoIterator<Item = &'a ConversationRecord>,
) -> String {
    let pattern = Regex::new(&format!("^{}-spawn-([0-9]+)$", regex::escape(parent_id)))
        .expect("an escaped id makes a valid pattern");
    let highest = existing
        .into_iter()
        .filter_map(|rec| pattern.captures(&rec.id))
        .filter_map(|caps| caps[1].parse::<f64>().ok())
        .fold(0.0_f64, f64::max);
    format!("{parent_id}-spawn-{}", js::number_string(highest + 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("conv-storage-")
            .tempdir()
            .unwrap()
    }

    fn record(dir: &Path) -> ConversationRecord {
        ConversationRecord {
            id: "conv-1".into(),
            file: dir.join("conv-1.md"),
            title: "Plan the migration".into(),
            opening: "Let's talk through the migration plan.".into(),
            status: ConversationStatus::Live,
            spawned_by: Some("conv-0".into()),
            harness: "claude".into(),
            model: "opus".into(),
            effort: None,
            // Multi-word, matching a ticket's driver chain: the marker line itself is
            // whitespace-split, so this only round-trips if the field is percent-encoded.
            drivers: "implement resolving-merge-conflicts".into(),
            enlisted: None,
            role: None,
        }
    }

    // conversations.test.ts:322
    #[test]
    fn round_trips_a_marker_through_write_and_read_with_a_spawned_by_and_a_multi_word_drivers_chain()
     {
        let dir = temp();
        let rec = record(dir.path());
        write_conversation(dir.path(), &rec).unwrap();
        assert_eq!(
            fs::read_to_string(&rec.file).unwrap(),
            "<!-- conversation: id=conv-1 status=live spawned-by=conv-0 harness=claude model=opus \
             drivers=implement%20resolving-merge-conflicts -->\n\n# Plan the migration\n\n\
             Let's talk through the migration plan.\n"
        );
        assert_eq!(read_conversation(&rec.file).unwrap(), rec);

        write_conversation_status(&rec.file, ConversationStatus::Ended).unwrap();
        assert_eq!(
            read_conversation(&rec.file).unwrap().status,
            ConversationStatus::Ended
        );

        let all = load_conversations(dir.path()).unwrap();
        assert_eq!(
            all.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["conv-1"]
        );
        assert_eq!(next_conversation_id(&all, |_| false), "conv-2");
        assert_eq!(next_conversation_id(&all, |id| id == "conv-2"), "conv-3");
    }

    // conversations.test.ts:351
    #[test]
    fn round_trips_an_effort_and_writes_no_effort_field_for_a_record_with_none() {
        let dir = temp();
        let rec = ConversationRecord {
            title: "Think hard".into(),
            opening: String::new(),
            spawned_by: None,
            effort: Some("xhigh".into()),
            drivers: "implement".into(),
            ..record(dir.path())
        };
        write_conversation(dir.path(), &rec).unwrap();
        assert_eq!(read_conversation(&rec.file).unwrap(), rec);
        write_conversation_status(&rec.file, ConversationStatus::Ended).unwrap();
        assert_eq!(
            read_conversation(&rec.file).unwrap().effort.as_deref(),
            Some("xhigh")
        );

        let plain = ConversationRecord {
            id: "conv-2".into(),
            file: dir.path().join("conv-2.md"),
            effort: None,
            ..rec
        };
        write_conversation(dir.path(), &plain).unwrap();
        let text = fs::read_to_string(&plain.file).unwrap();
        assert!(!text.contains("effort="));
        assert_eq!(
            text,
            "<!-- conversation: id=conv-2 status=live spawned-by=none harness=claude model=opus drivers=implement -->\n\n# Think hard\n\n\n"
        );
        assert_eq!(read_conversation(&plain.file).unwrap().effort, None);
    }

    #[test]
    fn reads_none_from_a_pool_with_no_conversations_directory() {
        let dir = temp();
        assert_eq!(
            load_conversations(&dir.path().join("conversations")).unwrap(),
            []
        );
    }

    #[test]
    fn round_trips_an_enlisted_steward_record() {
        let dir = temp();
        let rec = ConversationRecord {
            enlisted: Some(EnlistedConversation {
                pane_id: "w1:p2".into(),
                tab_id: None,
                directory: "/work/my pool".into(),
                branch: "feature/x y".into(),
                session_id: Some("abc".into()),
            }),
            role: Some(ConversationRole::Steward),
            ..record(dir.path())
        };
        write_conversation(dir.path(), &rec).unwrap();
        let line = fs::read_to_string(&rec.file)
            .unwrap()
            .split('\n')
            .next()
            .unwrap()
            .to_owned();
        assert_eq!(
            line,
            "<!-- conversation: id=conv-1 status=live spawned-by=conv-0 harness=claude model=opus \
             drivers=implement%20resolving-merge-conflicts pane=w1%3Ap2 tab=none \
             directory=%2Fwork%2Fmy%20pool branch=feature%2Fx%20y session=abc role=steward -->"
        );
        // tab=none reads back as the id "none", as the TypeScript reads it.
        let read = read_conversation(&rec.file).unwrap();
        assert_eq!(
            read.enlisted.as_ref().unwrap().tab_id.as_deref(),
            Some("none")
        );
        let mut expected = rec.clone();
        expected.enlisted.as_mut().unwrap().tab_id = Some("none".into());
        assert_eq!(read, expected);
    }

    #[test]
    fn keeps_every_crlf_through_a_status_write() {
        let dir = temp();
        let file = dir.path().join("conv-1.md");
        let original = "<!-- conversation: id=conv-1 status=live spawned-by=none harness=claude model=m drivers=implement -->\r\n\r\n# T\r\n\r\nhello\r\n";
        fs::write(&file, original).unwrap();
        write_conversation_status(&file, ConversationStatus::Crashed).unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            original.replace("status=live", "status=crashed")
        );
        let rec = read_conversation(&file).unwrap();
        assert_eq!(rec.title, "T");
        assert_eq!(rec.opening, "hello");
    }

    #[test]
    fn names_the_file_when_a_marker_is_wrong() {
        let dir = temp();
        let file = dir.path().join("conv-1.md");
        for (text, says) in [
            (
                "# no marker\n",
                format!(
                    "conversation load: {} has no line-1 conversation marker (expected <!-- conversation: id=.. status=.. -->)",
                    file.display()
                ),
            ),
            (
                "<!-- conversation: status=live -->\n",
                format!(
                    "conversation load: {}: marker is missing id=",
                    file.display()
                ),
            ),
            (
                "<!-- conversation: id=conv-1 status=waiting -->\n",
                format!(
                    "conversation load: {}: marker status must be one of live|ended|crashed, got 'waiting'",
                    file.display()
                ),
            ),
            (
                "<!-- conversation: id=conv-1 status=live model=%zz -->\n",
                "URI error".to_owned(),
            ),
        ] {
            fs::write(&file, text).unwrap();
            assert_eq!(read_conversation(&file).unwrap_err().to_string(), says);
        }
        fs::write(&file, "# x\n").unwrap();
        assert_eq!(
            write_conversation_status(&file, ConversationStatus::Ended)
                .unwrap_err()
                .to_string(),
            format!(
                "conversation marker write: {} has no line-1 marker",
                file.display()
            )
        );
    }

    #[test]
    fn mints_spawn_ids_per_parent() {
        let dir = temp();
        let with_id = |id: &str| ConversationRecord {
            id: id.into(),
            ..record(dir.path())
        };
        let existing = [
            with_id("conv-1-spawn-2"),
            with_id("conv-1-spawn-10"),
            with_id("conv-10-spawn-40"),
        ];
        assert_eq!(
            next_conversation_spawn_id("conv-1", &existing),
            "conv-1-spawn-11"
        );
        assert_eq!(next_conversation_spawn_id("a.b", &existing), "a.b-spawn-1");
    }
}
