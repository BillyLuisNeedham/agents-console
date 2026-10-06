//! The Steward notes (engine/steward.ts, ADR-0030): the Steward's recommendation on a pending Interrupt
//! it left to the operator, kept across restarts in `runs/steward-notes.json`.
//!
//! One note per pending Interrupt, keyed by the Interrupt's ticket and kind. A note belongs to one
//! raise of its Interrupt: it is cleared when the Interrupt is answered, and pruned once the Interrupt
//! is no longer pending, so the same Ticket raising again starts with none. A note on an Interrupt is
//! also the record that the Steward left it, so the Steward is not told about it again until it
//! changes. The file is rewritten whole through a rename, as the queued answers are. A Ticket has at
//! most one pending Interrupt at a time, so set and clear go by Ticket alone.

use std::path::{Path, PathBuf};

use ac_protocol::StewardNote;
use serde_json::{Map, Value, json};

use crate::js;

/// `runs/steward-notes.json`.
pub fn steward_notes_path(runs_dir: &Path) -> PathBuf {
    runs_dir.join("steward-notes.json")
}

/// The pool's Steward notes and the file that keeps them. Each record is kept as the file had it, so
/// a field this version does not know survives a save.
#[derive(Debug)]
pub struct StewardNotes {
    runs_dir: PathBuf,
    file: PathBuf,
    notes: Vec<Map<String, Value>>,
}

fn text_of<'a>(note: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    note.get(key).and_then(Value::as_str)
}

/// The notes `runs/steward-notes.json` holds. A torn or unreadable file starts with no notes rather
/// than taking the pool down: a note is a recommendation, never a decision. A record without a string
/// ticketId, kind and text is dropped.
pub fn load_steward_notes(runs_dir: &Path) -> StewardNotes {
    let file = steward_notes_path(runs_dir);
    let mut notes = Vec::new();
    if file.exists()
        && let Some(Ok(Value::Object(mut parsed))) =
            js::read_text(&file).ok().map(|t| js::parse(&t))
        && let Some(Value::Array(records)) = parsed.remove("notes")
    {
        notes = records
            .into_iter()
            .filter_map(|record| match record {
                Value::Object(note)
                    if ["ticketId", "kind", "text"]
                        .iter()
                        .all(|key| text_of(&note, key).is_some()) =>
                {
                    Some(note)
                }
                _ => None,
            })
            .collect();
    }
    StewardNotes {
        runs_dir: runs_dir.to_path_buf(),
        file,
        notes,
    }
}

impl StewardNotes {
    fn save(&self) -> Result<(), js::FsError> {
        js::mkdir_all(&self.runs_dir)?;
        let mut aside = self.file.clone().into_os_string();
        aside.push(".tmp");
        js::write_through_rename(
            &self.file,
            Path::new(&aside),
            &js::stringify_pretty(&json!({ "notes": self.notes })),
        )
    }

    fn is(note: &Map<String, Value>, ticket_id: &str, kind: &str) -> bool {
        text_of(note, "ticketId") == Some(ticket_id) && text_of(note, "kind") == Some(kind)
    }

    /// The note on the Ticket's Interrupt of this kind, if the Steward left one.
    pub fn get(&self, ticket_id: &str, kind: &str) -> Option<StewardNote> {
        let note = self
            .notes
            .iter()
            .find(|note| Self::is(note, ticket_id, kind))?;
        let field = |key| text_of(note, key).unwrap_or_default().to_owned();
        Some(StewardNote {
            text: field("text"),
            at: field("at"),
            conversation: field("conversation"),
        })
    }

    /// Set the Ticket's note, replacing whatever note it had, and write the file.
    pub fn set(
        &mut self,
        ticket_id: &str,
        kind: &str,
        note: &StewardNote,
    ) -> Result<(), js::FsError> {
        self.notes
            .retain(|n| text_of(n, "ticketId") != Some(ticket_id));
        let mut record = Map::new();
        record.insert("ticketId".into(), Value::String(ticket_id.to_owned()));
        record.insert("kind".into(), Value::String(kind.to_owned()));
        record.insert("text".into(), Value::String(note.text.clone()));
        record.insert("at".into(), Value::String(note.at.clone()));
        record.insert(
            "conversation".into(),
            Value::String(note.conversation.clone()),
        );
        self.notes.push(record);
        self.save()
    }

    /// Drop the Ticket's note, whatever its kind; true when there was one.
    pub fn clear(&mut self, ticket_id: &str) -> Result<bool, js::FsError> {
        let before = self.notes.len();
        self.notes
            .retain(|n| text_of(n, "ticketId") != Some(ticket_id));
        if self.notes.len() == before {
            return Ok(false);
        }
        self.save()?;
        Ok(true)
    }

    /// Drop every note whose Interrupt is not among `pending` (ticket id and kind); true when any went.
    pub fn prune(&mut self, pending: &[(&str, &str)]) -> Result<bool, js::FsError> {
        let before = self.notes.len();
        self.notes.retain(|note| {
            pending
                .iter()
                .any(|(ticket_id, kind)| Self::is(note, ticket_id, kind))
        });
        if self.notes.len() == before {
            return Ok(false);
        }
        self.save()?;
        Ok(true)
    }

    pub fn size(&self) -> usize {
        self.notes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn note(text: &str) -> StewardNote {
        StewardNote {
            text: text.into(),
            at: "t".into(),
            conversation: "conv-1".into(),
        }
    }

    // steward.test.ts:266
    #[test]
    fn keeps_a_note_across_a_reload_and_prunes_it_once_its_interrupt_is_no_longer_pending() {
        let dir = tempfile::Builder::new()
            .prefix("steward-notes-")
            .tempdir()
            .unwrap();
        let mut notes = load_steward_notes(dir.path());
        notes
            .set("01", "checkpoint", &note("resume with the smaller fix"))
            .unwrap();
        let mut again = load_steward_notes(dir.path());
        assert_eq!(
            again.get("01", "checkpoint"),
            Some(note("resume with the smaller fix"))
        );
        assert_eq!(again.get("01", "crash"), None);
        assert!(!again.prune(&[("01", "checkpoint")]).unwrap());
        assert!(again.prune(&[("01", "crash")]).unwrap());
        assert_eq!(load_steward_notes(dir.path()).size(), 0);
    }

    #[test]
    fn writes_the_file_pretty_and_keeps_one_note_per_ticket() {
        let dir = tempfile::Builder::new()
            .prefix("steward-notes-")
            .tempdir()
            .unwrap();
        let runs = dir.path().join("runs");
        let mut notes = load_steward_notes(&runs);
        notes.set("01", "checkpoint", &note("first")).unwrap();
        notes.set("01", "crash", &note("second")).unwrap();
        assert_eq!(
            fs::read_to_string(steward_notes_path(&runs)).unwrap(),
            "{\n  \"notes\": [\n    {\n      \"ticketId\": \"01\",\n      \"kind\": \"crash\",\n      \"text\": \"second\",\n      \"at\": \"t\",\n      \"conversation\": \"conv-1\"\n    }\n  ]\n}"
        );
        assert!(notes.clear("01").unwrap());
        assert!(!notes.clear("01").unwrap());
        assert_eq!(load_steward_notes(&runs).size(), 0);
    }

    #[test]
    fn reads_past_a_torn_file_and_drops_records_it_cannot_use() {
        let dir = tempfile::Builder::new()
            .prefix("steward-notes-")
            .tempdir()
            .unwrap();
        let path = steward_notes_path(dir.path());
        fs::write(&path, "{torn").unwrap();
        assert_eq!(load_steward_notes(dir.path()).size(), 0);
        fs::write(
            &path,
            r#"{"notes":[{"ticketId":"01","kind":"crash","text":"x","at":"t","conversation":"c","extra":1},{"ticketId":"02","kind":"crash"},null]}"#,
        )
        .unwrap();
        let mut notes = load_steward_notes(dir.path());
        assert_eq!(notes.size(), 1);
        notes.set("03", "checkpoint", &note("y")).unwrap();
        let written = js::parse(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["notes"][0]["extra"], 1);
    }
}
