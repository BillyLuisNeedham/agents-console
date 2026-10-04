//! The pool's Tickets as their files hold them (engine/pool.ts, and the loads and marker writes of
//! engine/engine.ts): the state line on line 1 (`<!-- state: id=.. blocked-by=.. status=.. -->`), its
//! fields and statuses, the title heading and the spec under it; loading every Ticket of a pool and
//! the rules a pool directory must keep (the reserved `-spawn-` and `enlist-` id namespaces, no
//! duplicate ids, Issue files unless the pool hosts Conversations); and the engine's writes into a
//! Ticket file that change only its state line: the status, an added blocker, and a spawned Ticket's
//! whole file.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use ac_protocol::{SpawnAssignRequest, SpawnProposal, TicketStatus};
use anyhow::{Result, anyhow};
use regex::Regex;
use serde_json::Value;

use crate::assignment::AssignmentMarker;
use crate::conversation_record::load_conversations;
use crate::js;
use crate::stat_cache::StampCache;

/// The pool files' gate, one per process. The TypeScript engine changes the pool's files on its one
/// thread, so no reader ever sees a change half made (the Ticket file a merge steps aside, a state line
/// mid-rewrite). The Rust engine holds the gate for writing through every job on its actor, and a
/// reader on another thread (the server's ticket and Conversation loads) holds it for reading, so the
/// reader sees the files between two jobs, as the TypeScript's readers do. Never held across an await.
pub static POOL_FILES: std::sync::RwLock<()> = std::sync::RwLock::new(());

/// Hold the pool files' gate for reading while `read` runs.
pub fn reading_pool_files<T>(read: impl FnOnce() -> T) -> T {
    let _gate = POOL_FILES
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    read()
}

/// A ticket that will never run again: done, or closed at an Interrupt without merging (issue #154).
/// Only done satisfies a `blocked-by`; this is for the run's own end and the Review gate, which wait on
/// neither.
pub fn is_finished(status: Option<TicketStatus>) -> bool {
    matches!(status, Some(TicketStatus::Done | TicketStatus::Closed))
}

/// One Ticket as its file records it.
#[derive(Debug, Clone, PartialEq)]
pub struct TicketMarker {
    pub id: String,
    pub file: PathBuf,
    pub blocked_by: Vec<String>,
    pub status: TicketStatus,
    /// The issue file's title: its first "# " heading, or "(untitled)".
    pub title: String,
    /// The issue body after the title heading and its leading blank line.
    pub spec: String,
    /// Set on engine-adopted spawn tickets (ADR-0010): the id of the ticket whose attempt proposed this
    /// one. The engine writes the field; the -spawn- namespace is reserved for files that carry it.
    pub spawned_by: Option<String>,
    /// Set on engine-enlisted tickets (issue #101): the herdr pane the operator picked. The engine
    /// writes the field; the `enlist-` namespace is reserved for files that carry it.
    pub enlisted_from: Option<String>,
    /// Set on engine-adopted spawn tickets whose proposal carried an `assign` (issue #116): the child's
    /// requested Assignment, persisted so every resolution pass honours it, not only the run that
    /// adopted it. It ranks under the operator's console.json assign entry for the id and over the
    /// parent's Assignment. The engine writes the field.
    pub spawn_assign: Option<SpawnAssignRequest>,
}

impl AssignmentMarker for TicketMarker {
    fn id(&self) -> &str {
        &self.id
    }

    fn spawned_by(&self) -> Option<&str> {
        self.spawned_by.as_deref()
    }

    fn spawn_assign(&self) -> Option<&SpawnAssignRequest> {
        self.spawn_assign.as_ref()
    }

    fn enlisted_from(&self) -> Option<&str> {
        self.enlisted_from.as_deref()
    }
}

/// The state line on line 1 of a Ticket file.
pub static MARKER_RE: LazyLock<Regex> = LazyLock::new(|| {
    let ws = js::WHITESPACE_CLASS;
    let any = js::ANY_BUT_LINE_TERMINATOR;
    Regex::new(&format!(r"^<!--{ws}*state:{ws}*({any}+?){ws}*-->{ws}*$"))
        .expect("the state line pattern compiles")
});

static STATUS_FIELD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("status=[a-z-]+").expect("the status field pattern compiles"));

static BLOCKED_BY_FIELD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("blocked-by={}*", js::NON_WHITESPACE_CLASS))
        .expect("the blocked-by field pattern compiles")
});

// The engine's own id convention for adopted spawn tickets (ADR-0010): `<parent-id>-spawn-N`, N
// counting per parent across the run. The namespace is reserved alongside `-grader-N`: engine
// scheduling never treats a spawned ticket specially (it is ordinary), but hand-written tickets may not
// use it.
static SPAWN_ID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "^({}+)-spawn-([0-9]+)$",
        js::ANY_BUT_LINE_TERMINATOR
    ))
    .expect("the spawn id pattern compiles")
});

// The engine's id convention for an enlisted ticket (issue #101): `enlist-N`, N counting per pool
// across the run. Reserved the same way as `-spawn-N`, so a hand-written ticket may not claim the
// namespace: an enlisted file carries the pane it came from as `enlisted-from=<paneId>`, and one
// without it fails the load.
static ENLIST_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^enlist-([0-9]+)$").expect("the enlist id pattern compiles"));

// Every load re-reads the issues directory, and the server loads on every snapshot (issue #157): a
// file whose stamp has not moved since its last parse is served from that parse, a changed one is
// parsed afresh. One cache for the process, as the TypeScript module had one.
static READ_CACHE: LazyLock<Mutex<StampCache<TicketMarker>>> =
    LazyLock::new(|| Mutex::new(StampCache::new()));

const SPAWN_ASSIGN_FIELDS: [&str; 4] = ["harness", "model", "effort", "drivers"];

/// A spawn proposal's `assign` as the one whitespace-free token the state line carries (the line is
/// split on whitespace, and `drivers` may contain a space): encoded JSON. This and the reading in
/// `read_marker` are the only codec.
pub fn encode_spawn_assign(assign: &SpawnAssignRequest) -> String {
    js::encode_uri_component(&js::to_json(assign))
}

fn decode_spawn_assign(raw: &str, file: &Path) -> Result<SpawnAssignRequest> {
    let parsed = js::decode_uri_component(raw)
        .ok()
        .and_then(|text| js::parse(&text).ok())
        .ok_or_else(|| {
            anyhow!(
                "pool load: {}: spawn-assign is not valid encoded JSON",
                file.display()
            )
        })?;
    let Value::Object(fields) = parsed else {
        return Err(anyhow!(
            "pool load: {}: spawn-assign must be a JSON object",
            file.display()
        ));
    };
    let mut request = SpawnAssignRequest {
        harness: None,
        model: None,
        effort: None,
        drivers: None,
    };
    for name in SPAWN_ASSIGN_FIELDS {
        let Some(value) = fields.get(name) else {
            continue;
        };
        let Value::String(text) = value else {
            return Err(anyhow!(
                "pool load: {}: spawn-assign.{name} is not a string",
                file.display()
            ));
        };
        let slot = match name {
            "harness" => &mut request.harness,
            "model" => &mut request.model,
            "effort" => &mut request.effort,
            _ => &mut request.drivers,
        };
        *slot = Some(text.clone());
    }
    Ok(request)
}

/// The state line's fields, as `key=value` words; a later word wins over an earlier one with its key.
fn marker_fields(body: &str) -> Vec<(&str, &str)> {
    let mut fields: Vec<(&str, &str)> = Vec::new();
    for word in js::words(body) {
        if let Some(eq) = word.find('=')
            && eq > 0
        {
            let (key, value) = (&word[..eq], &word[eq + 1..]);
            match fields.iter_mut().find(|(k, _)| *k == key) {
                Some(field) => field.1 = value,
                None => fields.push((key, value)),
            }
        }
    }
    fields
}

fn field<'a>(fields: &[(&'a str, &'a str)], key: &str) -> Option<&'a str> {
    fields.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

const STATUS_LIST: &str = "ready|in-progress|done|checkpoint|closed";

fn parse_marker_line(line: &str, file: &Path) -> Result<TicketMarker> {
    let Some(captures) = MARKER_RE.captures(line) else {
        return Err(anyhow!(
            "pool load: {} has no line-1 state marker \
             (expected <!-- state: id=.. blocked-by=.. status=.. -->)",
            file.display()
        ));
    };
    let fields = marker_fields(captures.get(1).map_or("", |m| m.as_str()));
    let Some(id) = field(&fields, "id").filter(|id| !id.is_empty()) else {
        return Err(anyhow!(
            "pool load: {}: marker is missing id=",
            file.display()
        ));
    };
    let status = field(&fields, "status");
    let Some(status) = status.and_then(TicketStatus::parse) else {
        return Err(anyhow!(
            "pool load: {}: marker status must be one of {STATUS_LIST}, got '{}'",
            file.display(),
            status.unwrap_or("")
        ));
    };
    let blocked_by = match field(&fields, "blocked-by").unwrap_or("none") {
        "none" => Vec::new(),
        raw => raw
            .split(',')
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect(),
    };
    let spawn_assign = match field(&fields, "spawn-assign") {
        Some(raw) => Some(decode_spawn_assign(raw, file)?),
        None => None,
    };
    let non_empty = |key: &str| {
        field(&fields, key)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    Ok(TicketMarker {
        id: id.to_owned(),
        file: file.to_path_buf(),
        blocked_by,
        status,
        title: String::new(),
        spec: String::new(),
        spawned_by: non_empty("spawned-by"),
        enlisted_from: non_empty("enlisted-from"),
        spawn_assign,
    })
}

// The issue file's heading grammar, parsed here beside the marker loading: the title is the first "# "
// heading, the spec everything after it. One parser owns this format, so a heading-format change breaks
// exactly here.
fn read_title(lines: &[&str]) -> String {
    match lines.iter().find(|line| line.starts_with("# ")) {
        Some(heading) => js::trim(&heading[1..]).to_owned(),
        None => "(untitled)".to_owned(),
    }
}

fn read_spec(lines: &[&str]) -> String {
    let start = lines
        .iter()
        .position(|line| line.starts_with("# "))
        .map_or(0, |at| at + 1);
    js::trim(&lines[start..].join("\n")).to_owned()
}

/// One Ticket file, read and parsed. Errors name the file.
pub fn read_marker(file: &Path) -> Result<TicketMarker> {
    let text = js::read_text(file)?;
    let lines: Vec<&str> = text.split('\n').collect();
    let mut marker = parse_marker_line(lines[0], file)?;
    marker.title = read_title(&lines);
    marker.spec = read_spec(&lines);
    Ok(marker)
}

fn read_marker_cached(file: &Path) -> Result<TicketMarker> {
    let mut cache = READ_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.read(file, read_marker)
}

/// Rewrite only the state line's `status=` field, every other byte of the file kept, CRLF endings too.
pub fn write_marker_status(file: &Path, status: TicketStatus) -> Result<()> {
    let raw = js::read_text(file)?;
    let newline = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = raw.split(newline).map(str::to_owned).collect();
    if !MARKER_RE.is_match(&lines[0]) {
        return Err(anyhow!(
            "marker write: {} has no line-1 state marker",
            file.display()
        ));
    }
    lines[0] = js::replace_first(&lines[0], &STATUS_FIELD_RE, &format!("status={status}"));
    js::write_file(file, &lines.join(newline))?;
    Ok(())
}

/// Markers dual-write (engine.ts's writeMarkers): before every checkpoint write, the state lines on
/// disk are brought into agreement with the pool state, so the pool directory is always inspectable
/// and the markers stay the shared truth. `status_of` is the state's status for a Ticket id; a marker
/// it has no status for is left alone.
pub fn write_markers(
    markers: &mut [TicketMarker],
    status_of: impl Fn(&str) -> Option<TicketStatus>,
) -> Result<()> {
    for marker in markers {
        if let Some(status) = status_of(&marker.id)
            && status != marker.status
        {
            write_marker_status(&marker.file, status)?;
            marker.status = status;
        }
    }
    Ok(())
}

/// A spawned Ticket's id read back: the parent it names and its N.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnId {
    pub parent: String,
    pub n: u64,
}

/// The parent and N of a `<parent>-spawn-N` id, or `None` when the id is not one.
pub fn parse_spawn_id(id: &str) -> Option<SpawnId> {
    let caps = SPAWN_ID_RE.captures(id)?;
    Some(SpawnId {
        parent: caps[1].to_owned(),
        n: whole(&caps[2]),
    })
}

/// The N of an `enlist-N` id, or `None` when the id is not one, so the engine mints the next id from
/// this one definition, as it does for Spawn.
pub fn parse_enlist_id(id: &str) -> Option<u64> {
    ENLIST_ID_RE.captures(id).map(|caps| whole(&caps[1]))
}

// `Number(digits)`, held as a whole number: one too big to count is as far up as a count goes.
fn whole(digits: &str) -> u64 {
    digits.parse().unwrap_or(u64::MAX)
}

/// Every Ticket in an issues directory, in file name order, with the pool rules every reader applies
/// (engine, server, rehydrate). `known_parents` are the ids of every Conversation the pool knows
/// about: a ticket's `spawned-by` may name one of these the same way it names a ticket id (the
/// Conversations ADR). An empty directory, or none, is the "no Issue files yet" mistake unless
/// `allow_empty_issues` says the pool hosts Conversations and may start with no Tickets.
pub fn load_pool_markers(
    issues_dir: &Path,
    known_parents: Option<&HashSet<String>>,
    allow_empty_issues: bool,
) -> Result<Vec<TicketMarker>> {
    let mut files: Vec<String> = if issues_dir.exists() {
        js::read_dir_names(issues_dir)?
            .into_iter()
            .filter(|name| name.ends_with(".md"))
            .collect()
    } else {
        Vec::new()
    };
    files.sort_by(|a, b| js::compare_utf16(a, b));
    if files.is_empty() {
        if allow_empty_issues {
            return Ok(Vec::new());
        }
        return Err(anyhow!(
            "pool load: no Issue files in {} (a Seeded Pool, which starts with no Tickets and grows by \
             Enlist and Spawn, opts in by having a conversations/ directory)",
            issues_dir.display()
        ));
    }
    let markers = files
        .iter()
        .map(|name| read_marker_cached(&issues_dir.join(name)))
        .collect::<Result<Vec<_>>>()?;
    let mut seen = HashSet::new();
    for marker in &markers {
        if !seen.insert(marker.id.as_str()) {
            return Err(anyhow!("pool load: duplicate ticket id '{}'", marker.id));
        }
        // The reservation, enforced here so every reader of the pool rejects the same files for the
        // same reason: an id in the engine's spawn namespace must carry the marker field the engine
        // writes and name the ticket the id already names. A hand-written file without it fails the
        // load; the engine's own files re-load cleanly.
        let Some(spawn) = parse_spawn_id(&marker.id) else {
            if ENLIST_ID_RE.is_match(&marker.id) && marker.enlisted_from.is_none() {
                return Err(anyhow!(
                    "pool load: {}: the 'enlist-' id namespace is reserved for engine-enlisted tickets \
                     (issue #101); a hand-written ticket may not use it, and an enlisted one carries \
                     enlisted-from=<paneId> in its marker",
                    marker.file.display()
                ));
            }
            continue;
        };
        if marker.spawned_by.as_deref() != Some(spawn.parent.as_str()) {
            return Err(anyhow!(
                "pool load: {}: the '-spawn-' id namespace is reserved for engine-adopted tickets \
                 (ADR-0010); a hand-written ticket may not use it, and an adopted one carries \
                 spawned-by={} in its marker",
                marker.file.display(),
                spawn.parent
            ));
        }
        let parent = spawn.parent.as_str();
        if !markers.iter().any(|m| m.id == parent)
            && !known_parents.is_some_and(|known| known.contains(parent))
        {
            return Err(anyhow!(
                "pool load: {}: spawned-by '{parent}' names no ticket or known Conversation in the pool",
                marker.file.display()
            ));
        }
    }
    Ok(markers)
}

/// The ids of every Conversation the pool has ever recorded (live, ended, or crashed): the "known
/// parent" set threaded through `load_pool_markers`, so a Ticket whose spawned-by names a Conversation
/// survives the reload the way one whose spawned-by names a Ticket always has.
pub fn known_conversation_ids(pool_dir: &Path) -> Result<HashSet<String>> {
    Ok(load_conversations(&pool_dir.join("conversations"))?
        .into_iter()
        .map(|rec| rec.id)
        .collect())
}

/// The pool's Tickets as every reader loads them: start, each boundary reload, and the server's
/// pre-flight and per-snapshot meta. Two rules ride along with the parse, and they belong to every
/// load or none: the pool's recorded Conversations are the known parents, and a pool with a
/// conversations/ directory (even an empty one) loads an empty issues/ as zero Tickets.
/// `allow_empty_issues` covers the one case that cannot infer itself: a Ticket-less pool asked to boot
/// before its first Conversation has ever started and before the directory exists.
pub fn load_pool_tickets(pool_dir: &Path, allow_empty_issues: bool) -> Result<Vec<TicketMarker>> {
    let known = known_conversation_ids(pool_dir)?;
    load_pool_markers(
        &pool_dir.join("issues"),
        Some(&known),
        allow_empty_issues || pool_dir.join("conversations").exists(),
    )
}

/// A spawned Ticket's whole file (engine.ts's writeSpawnTicket): an ordinary ticket with the
/// engine-assigned id, the ordinary blocking edge, and spawned-by naming the ticket (or Conversation)
/// whose proposal it was. A proposal that carried an `assign` writes it as `spawn-assign`, so the
/// child's requested Assignment survives a reload and a restart (issue #116).
pub fn spawn_ticket_text(parent_id: &str, id: &str, proposal: &SpawnProposal) -> String {
    let blocked_by = match proposal.blocked_by.as_deref() {
        Some(ids) if !ids.is_empty() => ids.join(","),
        _ => "none".to_owned(),
    };
    let assign = match &proposal.assign {
        Some(assign)
            if assign.harness.is_some()
                || assign.model.is_some()
                || assign.effort.is_some()
                || assign.drivers.is_some() =>
        {
            format!(" spawn-assign={}", encode_spawn_assign(assign))
        }
        _ => String::new(),
    };
    format!(
        "<!-- state: id={id} blocked-by={blocked_by} status=ready spawned-by={parent_id}{assign} -->\n\n\
         # {id}: {}\n\n\
         **Spawned by** ticket {parent_id} (ADR-0010): the engine wrote this ticket at the super-step \
         boundary from the attempt's Outcome proposal, engine-assigned id included. It is ordinary from \
         here on: it schedules, verifies, and may itself spawn, and the operator can edit or kill it \
         before it schedules.\n\n\
         {}\n",
        js::trim(&proposal.title),
        js::trim(&proposal.body)
    )
}

/// Write a spawned Ticket's file as `<issues_dir>/<id>.md`.
pub fn write_spawn_ticket(
    issues_dir: &Path,
    parent_id: &str,
    id: &str,
    proposal: &SpawnProposal,
) -> Result<()> {
    js::write_file(
        issues_dir.join(format!("{id}.md")),
        &spawn_ticket_text(parent_id, id, proposal),
    )?;
    Ok(())
}

/// What adding a blocker to a Ticket did.
#[derive(Debug, Clone, PartialEq)]
pub enum AddBlocker {
    /// The blocker is on the Ticket's state line now; `changed` is false when it already was, and
    /// nothing was written. The pool's Tickets come back as reloaded after the write.
    Added {
        changed: bool,
        markers: Vec<TicketMarker>,
    },
    /// Refused, and why: the Ticket is not in the pool, or it is finished.
    Refused(String),
}

/// One ticket id added to another Ticket's `blocked-by` (engine.ts's addBlockerToTicket: the Enlist
/// form's Blocks list and a Spawn's `blocks`). The state-line edit is the whole write: only the
/// `blocked-by` token on line one changes, every other byte of the Ticket file is preserved. A
/// finished Ticket refuses: blocked-by gates the ticket's next Attempt, and a finished ticket has none.
pub fn add_blocker_to_ticket(
    pool_dir: &Path,
    ticket_id: &str,
    blocker_id: &str,
) -> Result<AddBlocker> {
    let markers = load_pool_tickets(pool_dir, false)?;
    let Some(target) = markers.iter().find(|marker| marker.id == ticket_id) else {
        return Ok(AddBlocker::Refused(format!(
            "ticket {ticket_id} is not in the pool"
        )));
    };
    if is_finished(Some(target.status)) {
        return Ok(AddBlocker::Refused(format!(
            "ticket {ticket_id} is {}; blocked-by cannot be added to it",
            target.status
        )));
    }
    if target.blocked_by.iter().any(|id| id == blocker_id) {
        return Ok(AddBlocker::Added {
            changed: false,
            markers,
        });
    }
    let raw = js::read_text(&target.file)?;
    let newline = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = raw.split(newline).map(str::to_owned).collect();
    if !MARKER_RE.is_match(&lines[0]) {
        return Err(anyhow!(
            "marker write: {} has no line-1 state marker",
            target.file.display()
        ));
    }
    if !BLOCKED_BY_FIELD_RE.is_match(&lines[0]) {
        return Err(anyhow!(
            "marker write: {} has no blocked-by= field",
            target.file.display()
        ));
    }
    let mut blocked_by = target.blocked_by.clone();
    blocked_by.push(blocker_id.to_owned());
    lines[0] = js::replace_first(
        &lines[0],
        &BLOCKED_BY_FIELD_RE,
        &format!("blocked-by={}", blocked_by.join(",")),
    );
    js::write_file(&target.file, &lines.join(newline))?;
    Ok(AddBlocker::Added {
        changed: true,
        markers: load_pool_tickets(pool_dir, false)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const MARKER: &str = "<!-- state: id=01 blocked-by=none status=ready -->";

    fn temp() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("pool-test-")
            .tempdir()
            .unwrap()
    }

    fn temp_file(dir: &tempfile::TempDir, contents: &str) -> PathBuf {
        let file = dir.path().join("01-a.md");
        fs::write(&file, contents).unwrap();
        file
    }

    fn pool_with_files(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = temp();
        for (name, contents) in files {
            fs::write(dir.path().join(name), contents).unwrap();
        }
        dir
    }

    fn assign(
        harness: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        drivers: Option<&str>,
    ) -> SpawnAssignRequest {
        SpawnAssignRequest {
            harness: harness.map(str::to_owned),
            model: model.map(str::to_owned),
            effort: effort.map(str::to_owned),
            drivers: drivers.map(str::to_owned),
        }
    }

    fn err(result: Result<Vec<TicketMarker>>) -> String {
        result.unwrap_err().to_string()
    }

    const PARENT: &str = "<!-- state: id=01 blocked-by=none status=ready -->\n\n# Parent\n\nbody\n";

    // pool.test.ts:28
    #[test]
    fn reads_the_title_heading_and_the_spec_body_after_it() {
        let dir = temp();
        let file = temp_file(
            &dir,
            &format!("{MARKER}\n\n# Ticket title\n\nSpec: what to build\n"),
        );
        let marker = read_marker(&file).unwrap();
        assert_eq!(marker.id, "01");
        assert_eq!(marker.blocked_by, Vec::<String>::new());
        assert_eq!(marker.status, TicketStatus::Ready);
        assert_eq!(marker.title, "Ticket title");
        assert_eq!(marker.spec, "Spec: what to build");
    }

    // pool.test.ts:39
    #[test]
    fn titles_a_file_with_no_heading_as_untitled() {
        let dir = temp();
        let content = format!("{MARKER}\nno heading here\n");
        let file = temp_file(&dir, &content);
        let marker = read_marker(&file).unwrap();
        assert_eq!(marker.title, "(untitled)");
        // No heading means the spec is the whole file, marker included.
        assert_eq!(marker.spec, content.trim());
    }

    // pool.test.ts:47
    #[test]
    fn load_pool_markers_exposes_the_metadata_for_every_issue_file() {
        let dir = pool_with_files(&[
            (
                "02-b.md",
                "<!-- state: id=02 blocked-by=01 status=ready -->\n\n# Second\n\nbody two\n",
            ),
            ("01-a.md", &format!("{MARKER}\n\n# First\n\nbody one\n")),
            ("notes.txt", "not a ticket"),
        ]);
        let markers = load_pool_markers(dir.path(), None, false).unwrap();
        assert_eq!(
            markers.iter().map(|m| m.title.as_str()).collect::<Vec<_>>(),
            ["First", "Second"]
        );
        assert_eq!(
            markers.iter().map(|m| m.spec.as_str()).collect::<Vec<_>>(),
            ["body one", "body two"]
        );
        assert_eq!(markers[1].blocked_by, ["01"]);
        assert_eq!(markers[0].file, dir.path().join("01-a.md"));
    }

    #[test]
    fn reads_a_crlf_file_and_the_last_of_a_repeated_field() {
        let dir = temp();
        let file = temp_file(
            &dir,
            "<!--state:  id=01 blocked-by=a,,b status=ready status=done -->\r\n\r\n#   Title here \r\n\r\nSpec\r\n",
        );
        let marker = read_marker(&file).unwrap();
        assert_eq!(marker.status, TicketStatus::Done);
        assert_eq!(marker.blocked_by, ["a", "b"]);
        assert_eq!(marker.title, "Title here");
        assert_eq!(marker.spec, "Spec");
    }

    #[test]
    fn hands_the_resolution_pass_its_marker_facts() {
        let dir = temp();
        let token = encode_spawn_assign(&assign(None, Some("m"), None, None));
        let file = temp_file(
            &dir,
            &format!(
                "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 enlisted-from=w1:p2 spawn-assign={token} -->\n"
            ),
        );
        let marker = read_marker(&file).unwrap();
        let facts: &dyn AssignmentMarker = &marker;
        assert_eq!(facts.id(), "01-spawn-1");
        assert_eq!(facts.spawned_by(), Some("01"));
        assert_eq!(facts.enlisted_from(), Some("w1:p2"));
        assert_eq!(
            facts.spawn_assign(),
            Some(&assign(None, Some("m"), None, None))
        );
    }

    // pool.test.ts:74
    #[test]
    fn parses_spawned_by_on_an_engine_written_spawn_ticket() {
        let dir = temp();
        let file = temp_file(
            &dir,
            "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 -->\n\n# Spawned\n\nbody\n",
        );
        assert_eq!(
            read_marker(&file).unwrap().spawned_by.as_deref(),
            Some("01")
        );
    }

    #[test]
    fn loads_an_engine_written_spawn_ticket_whose_parent_is_in_the_pool() {
        let dir = pool_with_files(&[
            ("01-a.md", PARENT),
            (
                "01-spawn-1.md",
                "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 -->\n\n# Spawned\n\nbody\n",
            ),
        ]);
        let markers = load_pool_markers(dir.path(), None, false).unwrap();
        assert_eq!(
            markers.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["01", "01-spawn-1"]
        );
        assert_eq!(markers[1].spawned_by.as_deref(), Some("01"));
    }

    // pool.test.ts:95
    #[test]
    fn round_trips_a_spawn_proposals_assign_off_the_marker_effort_and_a_space_in_drivers_and_all() {
        let request = assign(
            None,
            Some("child-model"),
            Some("max"),
            Some("implement code-review"),
        );
        let token = encode_spawn_assign(&request);
        assert!(!token.chars().any(js::is_whitespace));
        assert_eq!(
            token,
            js::encode_uri_component(
                r#"{"model":"child-model","effort":"max","drivers":"implement code-review"}"#
            )
        );
        let dir = temp();
        let file = temp_file(
            &dir,
            &format!(
                "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 spawn-assign={token} -->\n\n# Spawned\n\nbody\n"
            ),
        );
        assert_eq!(read_marker(&file).unwrap().spawn_assign, Some(request));
    }

    // pool.test.ts:112
    #[test]
    fn keeps_only_the_four_assignment_fields_off_a_spawn_assign_never_a_verify() {
        let token = js::encode_uri_component(r#"{"effort":"max","verify":3}"#);
        let dir = temp();
        let file = temp_file(
            &dir,
            &format!(
                "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 spawn-assign={token} -->\n\n# Spawned\n\nbody\n"
            ),
        );
        assert_eq!(
            read_marker(&file).unwrap().spawn_assign,
            Some(assign(None, None, Some("max"), None))
        );
    }

    // pool.test.ts:120 and :131
    #[test]
    fn fails_pool_load_on_a_malformed_spawn_assign_naming_the_file() {
        for (token, says) in [
            (
                "not-json".to_owned(),
                "spawn-assign is not valid encoded JSON",
            ),
            (String::new(), "spawn-assign is not valid encoded JSON"),
            ("%E0".to_owned(), "spawn-assign is not valid encoded JSON"),
            (
                js::encode_uri_component("[1]"),
                "spawn-assign must be a JSON object",
            ),
            (
                js::encode_uri_component("null"),
                "spawn-assign must be a JSON object",
            ),
            (
                js::encode_uri_component(r#"{"effort":5}"#),
                "spawn-assign.effort is not a string",
            ),
            (
                js::encode_uri_component(r#"{"model":null}"#),
                "spawn-assign.model is not a string",
            ),
        ] {
            let dir = pool_with_files(&[
                ("01-a.md", PARENT),
                (
                    "01-spawn-1.md",
                    &format!(
                        "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 spawn-assign={token} -->\n\n# Spawned\n\nbody\n"
                    ),
                ),
            ]);
            assert_eq!(
                err(load_pool_markers(dir.path(), None, false)),
                format!(
                    "pool load: {}: {says}",
                    dir.path().join("01-spawn-1.md").display()
                ),
                "{token}"
            );
        }
    }

    #[test]
    fn rejects_a_hand_written_ticket_in_the_reserved_namespace() {
        let dir = pool_with_files(&[
            ("01-a.md", PARENT),
            (
                "01-spawn-9.md",
                "<!-- state: id=01-spawn-9 blocked-by=none status=ready -->\n\n# Hand-written\n\nbody\n",
            ),
        ]);
        assert_eq!(
            err(load_pool_markers(dir.path(), None, false)),
            format!(
                "pool load: {}: the '-spawn-' id namespace is reserved for engine-adopted tickets (ADR-0010); \
                 a hand-written ticket may not use it, and an adopted one carries spawned-by=01 in its marker",
                dir.path().join("01-spawn-9.md").display()
            )
        );
    }

    #[test]
    fn rejects_a_spawn_ticket_whose_spawned_by_does_not_match_its_ids_parent() {
        let dir = pool_with_files(&[
            ("01-a.md", PARENT),
            (
                "02-b.md",
                "<!-- state: id=02 blocked-by=none status=ready -->\n\n# Other\n\nbody\n",
            ),
            (
                "01-spawn-1.md",
                "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=02 -->\n\n# Mismatched\n\nbody\n",
            ),
        ]);
        assert!(err(load_pool_markers(dir.path(), None, false)).contains("reserved"));
    }

    #[test]
    fn rejects_a_spawn_ticket_whose_parent_has_left_the_pool() {
        let dir = pool_with_files(&[
            (
                "02-b.md",
                "<!-- state: id=02 blocked-by=none status=ready -->\n\n# Other\n\nbody\n",
            ),
            (
                "01-spawn-1.md",
                "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 -->\n\n# Orphan\n\nbody\n",
            ),
        ]);
        assert_eq!(
            err(load_pool_markers(dir.path(), None, false)),
            format!(
                "pool load: {}: spawned-by '01' names no ticket or known Conversation in the pool",
                dir.path().join("01-spawn-1.md").display()
            )
        );
    }

    #[test]
    fn accepts_a_spawn_ticket_whose_spawned_by_names_a_known_conversation_and_only_then() {
        let dir = pool_with_files(&[(
            "conv-1-spawn-1.md",
            "<!-- state: id=conv-1-spawn-1 blocked-by=none status=ready spawned-by=conv-1 -->\n\n# From a Conversation\n\nbody\n",
        )]);
        let known: HashSet<String> = ["conv-1".to_owned()].into();
        let markers = load_pool_markers(dir.path(), Some(&known), false).unwrap();
        assert_eq!(markers[0].spawned_by.as_deref(), Some("conv-1"));
        let other: HashSet<String> = ["conv-2".to_owned()].into();
        assert!(
            err(load_pool_markers(dir.path(), Some(&other), false))
                .contains("names no ticket or known Conversation")
        );
        assert!(
            err(load_pool_markers(dir.path(), None, false))
                .contains("names no ticket or known Conversation")
        );
    }

    #[test]
    fn rejects_a_hand_written_enlist_ticket_and_loads_an_enlisted_one() {
        let hand = pool_with_files(&[(
            "enlist-1.md",
            "<!-- state: id=enlist-1 blocked-by=none status=ready -->\n",
        )]);
        assert_eq!(
            err(load_pool_markers(hand.path(), None, false)),
            format!(
                "pool load: {}: the 'enlist-' id namespace is reserved for engine-enlisted tickets (issue #101); \
                 a hand-written ticket may not use it, and an enlisted one carries enlisted-from=<paneId> in its marker",
                hand.path().join("enlist-1.md").display()
            )
        );
        let enlisted = pool_with_files(&[(
            "enlist-1.md",
            "<!-- state: id=enlist-1 blocked-by=none status=in-progress enlisted-from=w1:p3 -->\n",
        )]);
        let markers = load_pool_markers(enlisted.path(), None, false).unwrap();
        assert_eq!(markers[0].enlisted_from.as_deref(), Some("w1:p3"));
    }

    #[test]
    fn rejects_a_duplicate_id_and_names_a_bad_marker_line() {
        let dupes = pool_with_files(&[("01-a.md", PARENT), ("01-b.md", PARENT)]);
        assert_eq!(
            err(load_pool_markers(dupes.path(), None, false)),
            "pool load: duplicate ticket id '01'"
        );
        for (content, says) in [
            (
                "# no marker here\n\nbody\n",
                " has no line-1 state marker (expected <!-- state: id=.. blocked-by=.. status=.. -->)",
            ),
            (
                "<!-- state: blocked-by=none status=ready -->\n\n# A\n",
                ": marker is missing id=",
            ),
            (
                "<!-- state: id= status=ready -->\n",
                ": marker is missing id=",
            ),
            (
                "<!-- state: id=01 blocked-by=none status=blocked -->\n\n# A\n",
                ": marker status must be one of ready|in-progress|done|checkpoint|closed, got 'blocked'",
            ),
            (
                "<!-- state: id=01 -->\n",
                ": marker status must be one of ready|in-progress|done|checkpoint|closed, got ''",
            ),
        ] {
            let dir = pool_with_files(&[("01-a.md", content)]);
            assert_eq!(
                err(load_pool_markers(dir.path(), None, false)),
                format!("pool load: {}{says}", dir.path().join("01-a.md").display())
            );
        }
    }

    // pool.test.ts: the empty issues/ rules
    #[test]
    fn loads_an_empty_issues_dir_only_when_the_pool_hosts_conversations() {
        let dir = temp();
        assert_eq!(load_pool_markers(dir.path(), None, true).unwrap(), []);
        let refused = err(load_pool_markers(dir.path(), None, false));
        assert_eq!(
            refused,
            format!(
                "pool load: no Issue files in {} (a Seeded Pool, which starts with no Tickets and grows by \
                 Enlist and Spawn, opts in by having a conversations/ directory)",
                dir.path().display()
            )
        );
        let pool = temp();
        fs::create_dir(pool.path().join("issues")).unwrap();
        assert!(err(load_pool_tickets(pool.path(), false)).contains("no Issue files"));
        assert_eq!(load_pool_tickets(pool.path(), true).unwrap(), []);
        fs::create_dir(pool.path().join("conversations")).unwrap();
        assert_eq!(load_pool_tickets(pool.path(), false).unwrap(), []);
    }

    #[test]
    fn a_pool_ticket_spawned_by_a_recorded_conversation_loads() {
        let pool = temp();
        fs::create_dir_all(pool.path().join("issues")).unwrap();
        fs::create_dir_all(pool.path().join("conversations")).unwrap();
        fs::write(
            pool.path().join("conversations/conv-1.md"),
            "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude model=m drivers=implement -->\n\n# Talk\n",
        )
        .unwrap();
        fs::write(
            pool.path().join("issues/conv-1-spawn-1.md"),
            "<!-- state: id=conv-1-spawn-1 blocked-by=none status=ready spawned-by=conv-1 -->\n\n# Child\n",
        )
        .unwrap();
        let markers = load_pool_tickets(pool.path(), false).unwrap();
        assert_eq!(markers[0].id, "conv-1-spawn-1");
        assert_eq!(
            known_conversation_ids(pool.path()).unwrap(),
            ["conv-1".to_owned()].into()
        );
    }

    // pool.ts:156-165, and the conformance case for a CRLF Ticket file.
    #[test]
    fn a_status_write_changes_only_status_and_keeps_every_crlf() {
        let dir = temp();
        let original =
            "<!-- state: id=01 blocked-by=none status=ready -->\r\n\r\n# A\r\n\r\nWork.\r\n";
        let file = temp_file(&dir, original);
        write_marker_status(&file, TicketStatus::InProgress).unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            original.replace("status=ready", "status=in-progress")
        );
        write_marker_status(&file, TicketStatus::Done).unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            original.replace("status=ready", "status=done")
        );

        let bare = temp_file(&dir, "# no marker\n");
        assert_eq!(
            write_marker_status(&bare, TicketStatus::Done)
                .unwrap_err()
                .to_string(),
            format!(
                "marker write: {} has no line-1 state marker",
                bare.display()
            )
        );
    }

    #[test]
    fn write_markers_brings_each_changed_status_to_disk() {
        let dir = pool_with_files(&[
            ("01-a.md", PARENT),
            (
                "02-b.md",
                "<!-- state: id=02 blocked-by=01 status=ready -->\n\n# Two\n",
            ),
        ]);
        let mut markers = load_pool_markers(dir.path(), None, false).unwrap();
        write_markers(&mut markers, |id| {
            (id == "01").then_some(TicketStatus::Checkpoint)
        })
        .unwrap();
        assert_eq!(markers[0].status, TicketStatus::Checkpoint);
        assert_eq!(markers[1].status, TicketStatus::Ready);
        assert_eq!(
            fs::read_to_string(dir.path().join("01-a.md")).unwrap(),
            PARENT.replace("status=ready", "status=checkpoint")
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("02-b.md")).unwrap(),
            "<!-- state: id=02 blocked-by=01 status=ready -->\n\n# Two\n"
        );
    }

    #[test]
    fn reads_spawn_and_enlist_ids() {
        assert_eq!(
            parse_spawn_id("01-spawn-3"),
            Some(SpawnId {
                parent: "01".into(),
                n: 3
            })
        );
        assert_eq!(
            parse_spawn_id("a-spawn-1-spawn-2"),
            Some(SpawnId {
                parent: "a-spawn-1".into(),
                n: 2
            })
        );
        assert_eq!(parse_spawn_id("01-spawn-"), None);
        assert_eq!(parse_spawn_id("-spawn-1"), None);
        assert_eq!(parse_spawn_id("01-spawn-١"), None);
        assert_eq!(parse_enlist_id("enlist-12"), Some(12));
        assert_eq!(parse_enlist_id("enlist-x"), None);
        assert_eq!(parse_enlist_id("my-enlist-1"), None);
        assert!(is_finished(Some(TicketStatus::Closed)));
        assert!(is_finished(Some(TicketStatus::Done)));
        assert!(!is_finished(Some(TicketStatus::Checkpoint)));
        assert!(!is_finished(None));
    }

    // gap: engine/engine.ts:9753, the conformance case for a spawned Ticket's bytes.
    #[test]
    fn writes_a_spawned_ticket_byte_for_byte() {
        let request = assign(
            None,
            Some("child-model"),
            Some("max"),
            Some("implement code-review"),
        );
        let proposal = SpawnProposal {
            title: "  Tidy up  ".into(),
            body: "\n  Make it tidy, every file of it.\n\n".into(),
            blocked_by: None,
            kind: None,
            assign: Some(request.clone()),
            verify_ignored: None,
            blocks: None,
            overlaps: None,
        };
        let token = encode_spawn_assign(&request);
        assert_eq!(
            spawn_ticket_text("01", "01-spawn-1", &proposal),
            format!(
                "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 spawn-assign={token} -->\n\n\
                 # 01-spawn-1: Tidy up\n\n\
                 **Spawned by** ticket 01 (ADR-0010): the engine wrote this ticket at the super-step boundary \
                 from the attempt's Outcome proposal, engine-assigned id included. It is ordinary from here on: it \
                 schedules, verifies, and may itself spawn, and the operator can edit or kill it before it schedules.\n\n\
                 Make it tidy, every file of it.\n"
            )
        );
        let plain = SpawnProposal {
            blocked_by: Some(vec!["02".into(), "03".into()]),
            assign: Some(assign(None, None, None, None)),
            ..proposal
        };
        let text = spawn_ticket_text("conv-1", "conv-1-spawn-2", &plain);
        assert!(text.starts_with(
            "<!-- state: id=conv-1-spawn-2 blocked-by=02,03 status=ready spawned-by=conv-1 -->\n\n# conv-1-spawn-2: Tidy up\n\n**Spawned by** ticket conv-1 "
        ));

        let dir = pool_with_files(&[("01-a.md", PARENT)]);
        write_spawn_ticket(dir.path(), "01", "01-spawn-1", &plain).unwrap();
        let loaded = load_pool_markers(dir.path(), None, false).unwrap();
        assert_eq!(loaded[1].blocked_by, ["02", "03"]);
        assert_eq!(loaded[1].title, "01-spawn-1: Tidy up");
    }

    fn pool_dir_with(tickets: &[(&str, &str)]) -> tempfile::TempDir {
        let pool = temp();
        fs::create_dir(pool.path().join("issues")).unwrap();
        for (name, text) in tickets {
            fs::write(pool.path().join("issues").join(name), text).unwrap();
        }
        pool
    }

    // engine.test.ts:9759, and the conformance case that adds a spawn's blocks.
    #[test]
    fn adds_a_blocker_to_a_ready_ticket_and_leaves_every_other_byte_of_the_file_unchanged() {
        let original = "<!-- state: id=01 blocked-by=00 status=ready -->\n\n# One\n\nKeep   these  bytes.\n\n- a list\n\ttabbed\n";
        let pool = pool_dir_with(&[
            (
                "00-t.md",
                "<!-- state: id=00 blocked-by=none status=done -->\n\n# Zero\n",
            ),
            ("01-t.md", original),
        ]);
        let AddBlocker::Added { changed, markers } =
            add_blocker_to_ticket(pool.path(), "01", "02").unwrap()
        else {
            panic!("refused");
        };
        assert!(changed);
        assert_eq!(markers[1].blocked_by, ["00", "02"]);
        assert_eq!(
            fs::read_to_string(pool.path().join("issues/01-t.md")).unwrap(),
            original.replace("blocked-by=00 ", "blocked-by=00,02 ")
        );
    }

    // engine.test.ts:9780
    #[test]
    fn reports_a_no_op_and_touches_nothing_when_the_blocker_is_already_present() {
        let original = "<!-- state: id=01 blocked-by=00 status=ready -->\r\n\r\n# One\r\n";
        let pool = pool_dir_with(&[
            (
                "00-t.md",
                "<!-- state: id=00 blocked-by=none status=ready -->\n",
            ),
            ("01-t.md", original),
        ]);
        let result = add_blocker_to_ticket(pool.path(), "01", "00").unwrap();
        assert!(matches!(result, AddBlocker::Added { changed: false, .. }));
        assert_eq!(
            fs::read_to_string(pool.path().join("issues/01-t.md")).unwrap(),
            original
        );
    }

    // engine.test.ts:13897
    #[test]
    fn refuses_to_add_a_blocker_to_a_closed_or_missing_ticket() {
        let original = "<!-- state: id=01 blocked-by=none status=closed -->\n\n# One\n";
        let pool = pool_dir_with(&[("01-t.md", original)]);
        assert_eq!(
            add_blocker_to_ticket(pool.path(), "01", "00").unwrap(),
            AddBlocker::Refused("ticket 01 is closed; blocked-by cannot be added to it".into())
        );
        assert_eq!(
            fs::read_to_string(pool.path().join("issues/01-t.md")).unwrap(),
            original
        );
        assert_eq!(
            add_blocker_to_ticket(pool.path(), "09", "00").unwrap(),
            AddBlocker::Refused("ticket 09 is not in the pool".into())
        );
    }

    #[test]
    fn refuses_a_state_line_with_no_blocked_by_field() {
        let pool = pool_dir_with(&[("01-t.md", "<!-- state: id=01 status=ready -->\n")]);
        assert_eq!(
            add_blocker_to_ticket(pool.path(), "01", "00")
                .unwrap_err()
                .to_string(),
            format!(
                "marker write: {} has no blocked-by= field",
                pool.path().join("issues/01-t.md").display()
            )
        );
    }
}
