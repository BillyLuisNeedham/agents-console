//! Ticket events (engine/events.ts): the engine's per-ticket lifecycle record, one JSON line per event
//! appended to `runs/<id>.events.jsonl` at each lifecycle point the engine passes through (ADR 0002).
//! Append-only and small; the timeline in the ticket's Detail is built from these events, and tickets
//! with no events file (pre-feature pools) are backfilled from their log files at read time
//! (`streamlog::reconstruct_attempts`).
//!
//! Attempt numbers are per ticket and shared by implement and resolver runs: every spawn of a harness
//! for a ticket increments that ticket's attempt counter, so a resolver run after a conflicted
//! implement attempt is the next attempt. A verify attempt's grade is recorded on the build ticket's
//! file (the graded attempt's number), appended by the engine when the attempt's grader ticket
//! finishes. The selection's winner is recorded the same way, as a selected event on the build
//! ticket's file.
//!
//! This module also owns the naming contract of every per-attempt file under runs/: the log, the
//! Stream file, the exit-code file, the Outcome and the seed copy of the Ticket file.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use ac_protocol::{TicketEvent, TicketEventKind};
use serde_json::{Map, Value};

use crate::js;
use crate::stat_cache::{file_stamp, now_ms, stamp_of};

// ---------------------------------------------------------------------------
// The naming contract
// ---------------------------------------------------------------------------

fn numbered(attempt: Option<u64>) -> String {
    attempt.map_or(String::new(), |n| format!(".attempt-{n}"))
}

fn resolver_suffix(resolver: bool) -> &'static str {
    if resolver { ".resolver" } else { "" }
}

/// One ticket log file name, covering every raw-log variant ADR 0002 names: the well-known paths for
/// the current attempt (`<id>.log`, `<id>.resolver.log`) and the rotated attempt-numbered names
/// (`<id>.attempt-N.log`, `<id>.attempt-N.resolver.log`). `attempt` is `None` for the well-known paths.
/// The engine rotator and both server readers call this, so the on-disk names cannot drift apart.
pub fn attempt_log_name(ticket_id: &str, attempt: Option<u64>, resolver: bool) -> String {
    format!(
        "{ticket_id}{}{}.log",
        numbered(attempt),
        resolver_suffix(resolver)
    )
}

/// One attempt Stream file name, the naming contract extended to the raw stream tee (ADR-0012):
/// `<id>.stream.jsonl`, `<id>.resolver.stream.jsonl` and their attempt-numbered names. Same free
/// variables and rotation rules as `attempt_log_name`, so a re-run rotates both files the same way.
pub fn attempt_stream_name(ticket_id: &str, attempt: Option<u64>, resolver: bool) -> String {
    format!(
        "{ticket_id}{}{}.stream.jsonl",
        numbered(attempt),
        resolver_suffix(resolver)
    )
}

/// One attempt exit-code file name (ADR-0014): the wrapper shell the engine sends to a terminal-backed
/// attempt's pane writes the harness's exit code here, because herdr's API exposes no exit codes.
pub fn attempt_exit_code_name(ticket_id: &str, attempt: Option<u64>, resolver: bool) -> String {
    format!(
        "{ticket_id}{}{}.exitcode",
        numbered(attempt),
        resolver_suffix(resolver)
    )
}

/// One attempt result file name, the naming contract extended to the Outcome (ADR-0005's ending
/// signal): `<id>.outcome.json`, `<id>.resolver.outcome.json`, and the attempt-numbered names a verify
/// fan-out writes directly, so N parallel outcomes never collide.
pub fn attempt_outcome_name(ticket_id: &str, attempt: Option<u64>, resolver: bool) -> String {
    format!(
        "{ticket_id}{}{}.outcome.json",
        numbered(attempt),
        resolver_suffix(resolver)
    )
}

/// The seed file name: the Ticket file as the pool held it when an attempt's worktree was planned,
/// kept under runs/ so the merge can reconcile the worktree's committed copy against the file of
/// record with an exact base (`<id>.seed.md`, or `<id>.attempt-N.seed.md` for a verify attempt's own
/// worktree).
pub fn ticket_seed_name(ticket_id: &str, attempt: Option<u64>) -> String {
    format!("{ticket_id}{}.seed.md", numbered(attempt))
}

/// The free variables one `attempt_log_name` call needed to produce a name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttemptLogName {
    pub attempt: Option<u64>,
    pub resolver: bool,
}

fn parse_attempt_name(
    ticket_id: &str,
    file_name: &str,
    ending: &str,
    name: fn(&str, Option<u64>, bool) -> String,
) -> Option<AttemptLogName> {
    let mut rest = file_name.strip_prefix(ticket_id)?;
    let mut attempt = None;
    if let Some(after) = rest.strip_prefix(".attempt-") {
        let digits = after.len() - after.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 {
            return None;
        }
        attempt = Some(js::exact_whole_number(&after[..digits])?);
        rest = &after[digits..];
    }
    let resolver = match rest.strip_prefix(".resolver") {
        Some(after) => {
            rest = after;
            true
        }
        None => false,
    };
    if rest != ending || name(ticket_id, attempt, resolver) != file_name {
        return None;
    }
    Some(AttemptLogName { attempt, resolver })
}

/// Match a file name against a ticket's log naming contract: the four shapes `attempt_log_name`
/// produces. A round trip through the naming function keeps it the single authority, so a name it
/// could not write is not matched. Used by the attempt reconstruction over old pools.
pub fn parse_attempt_log_name(ticket_id: &str, file_name: &str) -> Option<AttemptLogName> {
    parse_attempt_name(ticket_id, file_name, ".log", attempt_log_name)
}

/// Match a file name against a ticket's Stream file naming contract, the four shapes
/// `attempt_stream_name` produces.
pub fn parse_attempt_stream_name(ticket_id: &str, file_name: &str) -> Option<AttemptLogName> {
    parse_attempt_name(ticket_id, file_name, ".stream.jsonl", attempt_stream_name)
}

// ---------------------------------------------------------------------------
// The events file
// ---------------------------------------------------------------------------

/// A Ticket's events file: `<runs>/<id>.events.jsonl`.
pub fn events_file(runs_dir: &Path, ticket_id: &str) -> PathBuf {
    runs_dir.join(format!("{ticket_id}.events.jsonl"))
}

/// The events file's stamp (`stat_cache`), for a reader caching what it derives from the events.
pub fn events_stamp(runs_dir: &Path, ticket_id: &str) -> Option<String> {
    file_stamp(events_file(runs_dir, ticket_id))
}

/// An event that happens now.
pub fn event_now(attempt: u64, kind: TicketEventKind, payload: Map<String, Value>) -> TicketEvent {
    TicketEvent {
        at: js::now_iso(),
        attempt,
        kind,
        payload,
    }
}

/// Append one event to the Ticket's file, as one `JSON.stringify` line, making runs/ first.
pub fn append_event(
    runs_dir: &Path,
    ticket_id: &str,
    event: &TicketEvent,
) -> Result<(), js::FsError> {
    js::mkdir_all(runs_dir)?;
    js::append_file(
        &events_file(runs_dir, ticket_id),
        &format!("{}\n", js::to_json(event)),
    )
}

// How many of the settled bytes' last bytes are kept to recognise the file on the next read: enough to
// cover the last event line, which carries its own timestamp, so a file written afresh at the same
// inode does not match.
const SETTLED_TAIL_BYTES: usize = 4096;

/// One events file's parse, kept between reads.
#[derive(Debug)]
struct ParsedEvents {
    dev: u64,
    ino: u64,
    /// The file's stamp when last read to its end: an unmoved stamp means nothing was appended.
    stamp: Option<String>,
    /// The byte offset just past the last newline parsed.
    settled: u64,
    /// The last bytes before `settled`, as they were read.
    tail: Vec<u8>,
    events: Vec<Arc<TicketEvent>>,
    /// The final line with no newline yet, as last read: parsed, never kept past a change.
    unsettled: Vec<Arc<TicketEvent>>,
}

impl ParsedEvents {
    fn all(&self) -> Vec<Arc<TicketEvent>> {
        self.events.iter().chain(&self.unsettled).cloned().collect()
    }
}

/// The parse of every events file read so far, each kept per file so that only what was appended
/// since is parsed (issue #157): the lines up to the last newline are settled and kept, and a final
/// line with no newline yet is parsed on each read and never kept, since the rest of it may still be
/// on its way. A file that shrank, moved to another inode, or no longer ends its settled part with the
/// bytes it did (removed and written again) is parsed whole, as a new file.
#[derive(Debug, Default)]
pub struct EventsCache {
    parsed: HashMap<PathBuf, ParsedEvents>,
}

impl EventsCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The events of the file at `path`, in file order. A missing file is no events.
    pub fn read(&mut self, path: &Path) -> Vec<Arc<TicketEvent>> {
        let Ok(meta) = std::fs::metadata(path) else {
            self.parsed.remove(path);
            return Vec::new();
        };
        let stamp = stamp_of(&meta, now_ms());
        if let Some(entry) = self.parsed.get(path)
            && stamp.is_some()
            && entry.stamp == stamp
        {
            return entry.all();
        }
        let fresh_start = !self.parsed.get(path).is_some_and(|entry| {
            entry.dev == meta.dev()
                && entry.ino == meta.ino()
                && meta.size() >= entry.settled
                && ends_settled_with(path, entry)
        });
        if fresh_start {
            self.parsed.insert(
                path.to_path_buf(),
                ParsedEvents {
                    dev: meta.dev(),
                    ino: meta.ino(),
                    stamp: None,
                    settled: 0,
                    tail: Vec::new(),
                    events: Vec::new(),
                    unsettled: Vec::new(),
                },
            );
        }
        let entry = self.parsed.get_mut(path).expect("the entry was just made");
        let Ok(fresh) = read_from(path, entry.settled) else {
            // Gone between the stat and the read: as absent.
            self.parsed.remove(path);
            return Vec::new();
        };
        let last_newline = fresh.iter().rposition(|b| *b == b'\n');
        let unsettled_from = match last_newline {
            Some(at) => {
                entry.events.extend(parse_lines(&fresh[..=at]));
                entry.settled += (at + 1) as u64;
                entry.tail = fresh[(at + 1).saturating_sub(SETTLED_TAIL_BYTES)..=at].to_vec();
                at + 1
            }
            None => 0,
        };
        entry.unsettled = parse_lines(&fresh[unsettled_from..]);
        entry.stamp = stamp;
        entry.all()
    }
}

fn read_from(path: &Path, offset: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn ends_settled_with(path: &Path, entry: &ParsedEvents) -> bool {
    if entry.settled == 0 {
        return true;
    }
    let read = || -> std::io::Result<Vec<u8>> {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(entry.settled - entry.tail.len() as u64))?;
        let mut bytes = vec![0; entry.tail.len()];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    };
    read().is_ok_and(|bytes| bytes == entry.tail)
}

/// Parse events lines. The file is only ever appended to, but a crash could tear a line, so a
/// malformed or partial line is skipped and the rest of the timeline stays readable. A line whose kind
/// is not a known event kind, or whose attempt is not a number, is skipped the same way.
fn parse_lines(bytes: &[u8]) -> Vec<Arc<TicketEvent>> {
    if bytes.is_empty() {
        return Vec::new();
    }
    js::decode_utf8(bytes)
        .split('\n')
        .filter(|line| !js::trim(line).is_empty())
        .filter_map(parse_line)
        .map(Arc::new)
        .collect()
}

fn parse_line(line: &str) -> Option<TicketEvent> {
    let value = js::parse(line).ok()?;
    let Value::Object(fields) = &value else {
        return None;
    };
    TicketEventKind::parse(fields.get("kind")?.as_str()?)?;
    if !fields.get("attempt")?.is_number() {
        return None;
    }
    // A line the TypeScript would take but no TicketEvent can hold (an attempt that is not a whole
    // number, no `at` or `payload`) is as torn as one that does not parse; the engine writes none.
    serde_json::from_value(value).ok()
}

// Every snapshot, request and survey reads these files (issue #157): one cache for the process, as
// the TypeScript module had one.
static EVENTS_CACHE: LazyLock<Mutex<EventsCache>> =
    LazyLock::new(|| Mutex::new(EventsCache::new()));

/// A Ticket's events, in the order they were appended, read through the process's events cache. Every
/// caller gets its own list; the events in it are shared, so they cannot be changed.
pub fn read_events(runs_dir: &Path, ticket_id: &str) -> Vec<Arc<TicketEvent>> {
    let path = events_file(runs_dir, ticket_id);
    EVENTS_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .read(&path)
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/// The highest recorded attempt, optionally only across events of one kind; 0 when there is none.
pub fn max_attempt<'a>(
    events: impl IntoIterator<Item = &'a Arc<TicketEvent>>,
    kind: Option<TicketEventKind>,
) -> u64 {
    events
        .into_iter()
        .filter(|event| kind.is_none_or(|kind| event.kind == kind))
        .map(|event| event.attempt)
        .fold(0, u64::max)
}

/// The attempt number for a ticket's next spawn: one past the highest attempt recorded.
pub fn next_attempt(runs_dir: &Path, ticket_id: &str) -> u64 {
    max_attempt(&read_events(runs_dir, ticket_id), None) + 1
}

/// The ticket's latest recorded attempt, or 0 before anything has spawned.
pub fn last_attempt(runs_dir: &Path, ticket_id: &str) -> u64 {
    max_attempt(&read_events(runs_dir, ticket_id), None)
}

/// The ticket's latest attempt carrying the given event kind, or 0 if none. Used by attempt rotation
/// to name a well-known raw log by the run that wrote it: the last implement spawn for `<id>.log`, the
/// last resolver run for `<id>.resolver.log`.
pub fn last_attempt_of_kind(runs_dir: &Path, ticket_id: &str, kind: TicketEventKind) -> u64 {
    max_attempt(&read_events(runs_dir, ticket_id), Some(kind))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::fs::OpenOptions;
    use std::io::Write;

    fn temp_runs() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("events-test-")
            .tempdir()
            .unwrap()
    }

    fn line(second: u32, kind: &str) -> String {
        format!(
            "{}\n",
            js::to_json(&serde_json::json!({
                "at": format!("2026-01-01T00:00:{second:02}.000Z"),
                "attempt": 1,
                "kind": kind,
                "payload": {},
            }))
        )
    }

    fn file(runs: &Path) -> PathBuf {
        runs.join("01.events.jsonl")
    }

    fn append(path: &Path, text: &str) {
        OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }

    /// Each read checked against a fresh parse of the same bytes, as the TypeScript's tests do.
    fn kinds(cache: &mut EventsCache, runs: &Path) -> Vec<&'static str> {
        let read: Vec<_> = cache
            .read(&file(runs))
            .iter()
            .map(|e| e.kind.as_str())
            .collect();
        let fresh: Vec<_> = EventsCache::new()
            .read(&file(runs))
            .iter()
            .map(|e| e.kind.as_str())
            .collect();
        assert_eq!(read, fresh, "the cached read agrees with a fresh parse");
        read
    }

    // events.test.ts:31
    #[test]
    fn reads_back_events_written_through_append_event() {
        let runs = temp_runs();
        let event = TicketEvent {
            at: "2026-01-01T00:00:00.000Z".into(),
            attempt: 1,
            kind: TicketEventKind::Spawned,
            payload: serde_json::json!({"pid": 42, "argv": ["claude", "-p"], "branch": null})
                .as_object()
                .unwrap()
                .clone(),
        };
        append_event(&runs.path().join("nested"), "01", &event).unwrap();
        assert_eq!(
            fs::read_to_string(runs.path().join("nested/01.events.jsonl")).unwrap(),
            "{\"at\":\"2026-01-01T00:00:00.000Z\",\"attempt\":1,\"kind\":\"spawned\",\"payload\":{\"pid\":42,\"argv\":[\"claude\",\"-p\"],\"branch\":null}}\n"
        );
        let events = read_events(&runs.path().join("nested"), "01");
        assert_eq!(events.len(), 1);
        assert_eq!(*events[0], event);
    }

    // events.test.ts:45, and the conformance gap at events.ts:419-426
    #[test]
    fn skips_a_line_of_an_unknown_kind_or_whose_attempt_is_not_a_number() {
        let runs = temp_runs();
        let text = [
            line(0, "scheduled"),
            r#"{"at":"2026-01-01T00:00:01.000Z","attempt":1,"kind":"bogus","payload":{}}"#
                .to_owned()
                + "\n",
            r#"{"at":"2026-01-01T00:00:01.000Z","attempt":"1","kind":"spawned","payload":{}}"#
                .to_owned()
                + "\n",
            "null\n[1]\n\"x\"\n{torn\n   \n".to_owned(),
        ]
        .concat();
        fs::write(file(runs.path()), text).unwrap();
        let mut cache = EventsCache::new();
        assert_eq!(kinds(&mut cache, runs.path()), ["scheduled"]);
    }

    // events.test.ts:73
    #[test]
    fn picks_up_each_append_and_a_torn_final_line_once_the_rest_of_it_lands() {
        let runs = temp_runs();
        let mut cache = EventsCache::new();
        fs::write(file(runs.path()), line(0, "scheduled")).unwrap();
        assert_eq!(kinds(&mut cache, runs.path()), ["scheduled"]);
        let spawned = line(1, "spawned");
        append(&file(runs.path()), &spawned[..20]);
        assert_eq!(kinds(&mut cache, runs.path()), ["scheduled"]);
        append(&file(runs.path()), &spawned[20..]);
        assert_eq!(kinds(&mut cache, runs.path()), ["scheduled", "spawned"]);
        append(&file(runs.path()), &line(2, "exited"));
        assert_eq!(
            kinds(&mut cache, runs.path()),
            ["scheduled", "spawned", "exited"]
        );
    }

    // events.test.ts:86
    #[test]
    fn reads_a_final_line_with_no_newline_yet_when_it_is_whole_and_never_keeps_it() {
        let runs = temp_runs();
        let mut cache = EventsCache::new();
        fs::write(
            file(runs.path()),
            line(0, "scheduled") + line(1, "spawned").trim_end(),
        )
        .unwrap();
        assert_eq!(kinds(&mut cache, runs.path()), ["scheduled", "spawned"]);
        append(&file(runs.path()), &format!("\n{}", line(2, "exited")));
        assert_eq!(
            kinds(&mut cache, runs.path()),
            ["scheduled", "spawned", "exited"]
        );
    }

    // events.test.ts:94
    #[test]
    fn reads_a_file_removed_and_written_again_as_a_new_file_at_the_same_size_too() {
        let runs = temp_runs();
        let mut cache = EventsCache::new();
        fs::write(
            file(runs.path()),
            line(0, "scheduled") + &line(1, "spawned"),
        )
        .unwrap();
        assert_eq!(kinds(&mut cache, runs.path()), ["scheduled", "spawned"]);
        fs::remove_file(file(runs.path())).unwrap();
        assert!(kinds(&mut cache, runs.path()).is_empty());
        // Same length as before, and on most filesystems the same inode.
        fs::write(
            file(runs.path()),
            line(5, "spawned") + &line(6, "scheduled"),
        )
        .unwrap();
        assert_eq!(kinds(&mut cache, runs.path()), ["spawned", "scheduled"]);
    }

    #[test]
    fn reads_a_file_rewritten_in_place_at_the_same_size_as_a_new_file() {
        let runs = temp_runs();
        let mut cache = EventsCache::new();
        fs::write(
            file(runs.path()),
            line(0, "scheduled") + &line(1, "spawned"),
        )
        .unwrap();
        assert_eq!(kinds(&mut cache, runs.path()), ["scheduled", "spawned"]);
        // Truncated and written again through the same inode: the settled tail no longer matches.
        fs::write(
            file(runs.path()),
            line(7, "spawned") + &line(8, "scheduled"),
        )
        .unwrap();
        assert_eq!(kinds(&mut cache, runs.path()), ["spawned", "scheduled"]);
    }

    // events.test.ts:105
    #[test]
    fn reads_a_file_cut_shorter_as_a_new_file() {
        let runs = temp_runs();
        let mut cache = EventsCache::new();
        fs::write(
            file(runs.path()),
            line(0, "scheduled") + &line(1, "spawned"),
        )
        .unwrap();
        assert_eq!(kinds(&mut cache, runs.path()), ["scheduled", "spawned"]);
        fs::write(file(runs.path()), line(2, "exited")).unwrap();
        assert_eq!(kinds(&mut cache, runs.path()), ["exited"]);
    }

    #[test]
    fn serves_a_quiet_unchanged_file_from_its_parse() {
        let runs = temp_runs();
        let path = file(runs.path());
        fs::write(&path, line(0, "scheduled")).unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(past))
            .unwrap();
        let mut cache = EventsCache::new();
        let first = cache.read(&path);
        let second = cache.read(&path);
        assert!(Arc::ptr_eq(&first[0], &second[0]));
        assert!(cache.parsed[&path].stamp.is_some());
    }

    #[test]
    fn derives_attempt_numbers_from_the_events() {
        let runs = temp_runs();
        let at = |attempt: u64, kind: TicketEventKind| TicketEvent {
            at: "t".into(),
            attempt,
            kind,
            payload: Map::new(),
        };
        assert_eq!(next_attempt(runs.path(), "01"), 1);
        assert_eq!(last_attempt(runs.path(), "01"), 0);
        for event in [
            at(1, TicketEventKind::Spawned),
            at(1, TicketEventKind::Exited),
            at(2, TicketEventKind::Spawned),
            at(2, TicketEventKind::Resolver),
        ] {
            append_event(runs.path(), "01", &event).unwrap();
        }
        assert_eq!(next_attempt(runs.path(), "01"), 3);
        assert_eq!(last_attempt(runs.path(), "01"), 2);
        assert_eq!(
            last_attempt_of_kind(runs.path(), "01", TicketEventKind::Exited),
            1
        );
        assert_eq!(
            last_attempt_of_kind(runs.path(), "01", TicketEventKind::Resolver),
            2
        );
        assert_eq!(
            last_attempt_of_kind(runs.path(), "01", TicketEventKind::Merged),
            0
        );
        assert!(events_stamp(runs.path(), "02").as_deref() == Some(crate::stat_cache::ABSENT));
        let event = event_now(4, TicketEventKind::Crash, Map::new());
        assert_eq!(event.at.len(), 24);
    }

    // events.test.ts:122, :128
    #[test]
    fn names_the_base_and_resolver_logs_and_their_attempt_numbered_variants() {
        assert_eq!(attempt_log_name("01", None, false), "01.log");
        assert_eq!(attempt_log_name("01", Some(1), false), "01.attempt-1.log");
        assert_eq!(attempt_log_name("01", Some(0), false), "01.attempt-0.log");
        assert_eq!(attempt_log_name("01", None, true), "01.resolver.log");
        assert_eq!(
            attempt_log_name("01", Some(2), true),
            "01.attempt-2.resolver.log"
        );
        assert_eq!(
            attempt_exit_code_name("01", None, true),
            "01.resolver.exitcode"
        );
        assert_eq!(
            attempt_exit_code_name("01", Some(3), false),
            "01.attempt-3.exitcode"
        );
        assert_eq!(
            attempt_outcome_name("01", None, true),
            "01.resolver.outcome.json"
        );
        assert_eq!(
            attempt_outcome_name("01", Some(2), false),
            "01.attempt-2.outcome.json"
        );
        assert_eq!(ticket_seed_name("01", None), "01.seed.md");
        assert_eq!(ticket_seed_name("01", Some(2)), "01.attempt-2.seed.md");
    }

    // events.test.ts:162, :168
    #[test]
    fn names_the_base_and_resolver_streams_and_their_attempt_numbered_variants() {
        assert_eq!(attempt_stream_name("01", None, false), "01.stream.jsonl");
        assert_eq!(
            attempt_stream_name("01", Some(1), false),
            "01.attempt-1.stream.jsonl"
        );
        assert_eq!(
            attempt_stream_name("01", Some(0), false),
            "01.attempt-0.stream.jsonl"
        );
        assert_eq!(
            attempt_stream_name("01", None, true),
            "01.resolver.stream.jsonl"
        );
        assert_eq!(
            attempt_stream_name("01", Some(2), true),
            "01.attempt-2.resolver.stream.jsonl"
        );
    }

    // events.test.ts:133, :152, :175, :193
    #[test]
    fn parses_back_the_four_shapes_it_names_and_rejects_the_rest() {
        let name = |attempt, resolver| Some(AttemptLogName { attempt, resolver });
        assert_eq!(parse_attempt_log_name("01", "01.log"), name(None, false));
        assert_eq!(
            parse_attempt_log_name("01", "01.attempt-3.log"),
            name(Some(3), false)
        );
        assert_eq!(
            parse_attempt_log_name("01", "01.resolver.log"),
            name(None, true)
        );
        assert_eq!(
            parse_attempt_log_name("01", "01.attempt-4.resolver.log"),
            name(Some(4), true)
        );
        for rejected in [
            "02.log",
            "01.events.jsonl",
            "01.outcome.json",
            "01.attempt-x.log",
            "01.attempt-01.log",
            "01.attempt-.log",
            "01.resolver.attempt-1.log",
        ] {
            assert_eq!(parse_attempt_log_name("01", rejected), None, "{rejected}");
        }
        assert_eq!(
            parse_attempt_stream_name("01", "01.stream.jsonl"),
            name(None, false)
        );
        assert_eq!(
            parse_attempt_stream_name("01", "01.attempt-3.stream.jsonl"),
            name(Some(3), false)
        );
        assert_eq!(
            parse_attempt_stream_name("01", "01.resolver.stream.jsonl"),
            name(None, true)
        );
        assert_eq!(
            parse_attempt_stream_name("01", "01.attempt-4.resolver.stream.jsonl"),
            name(Some(4), true)
        );
        for rejected in [
            "02.stream.jsonl",
            "01.log",
            "01.stream.json",
            "01.attempt-x.stream.jsonl",
            "01.attempt-01.stream.jsonl",
        ] {
            assert_eq!(
                parse_attempt_stream_name("01", rejected),
                None,
                "{rejected}"
            );
        }
    }
}
