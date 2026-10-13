//! The queued-answer store (engine/queued-answers.ts): every accepted Interrupt answer, persisted in
//! submission order alongside the pool's other run artifacts (`runs/queued-answers.json`).
//! Deliberately separate from the pool state (ADR-0004): the super-step join rebuilds state from a
//! pre-flight snapshot and would clobber a queued-answers channel, so the queue lives on its own and
//! survives a server restart. Acceptance enqueues; the drive's boundary drain marks records processed.
//! The file is rewritten whole (tmp and rename) on every change, so a crash mid-write never tears the
//! queue.

use std::path::{Path, PathBuf};

use ac_protocol::{AnswerBy, InterruptKind, QueuedAnswer, QueuedAnswerAction};
use serde_json::{Value, json};

use crate::js;

/// An accepted answer as acceptance hands it over: a Queued answer before the store gives it its
/// submission order.
#[derive(Debug, Clone, PartialEq)]
pub struct AcceptedAnswer {
    pub ticket_id: String,
    /// The interrupt identity: the kind of interrupt this answer addresses.
    pub kind: InterruptKind,
    /// The answer payload: true approve, false reject, `None` resume.
    pub approve: Option<bool>,
    /// A Close (issue #154) or an Adopt (ADR-0035).
    pub action: Option<QueuedAnswerAction>,
    /// The Candidate an Adopt takes.
    pub attempt: Option<u64>,
    pub note: Option<String>,
    /// The Steward gave it (ADR-0030); `None` is the operator's.
    pub by: Option<AnswerBy>,
    pub at: String,
}

/// The pool's Queued answers and the file that keeps them.
#[derive(Debug)]
pub struct QueuedAnswerStore {
    file: PathBuf,
    next_seq: u64,
    answers: Vec<QueuedAnswer>,
}

impl QueuedAnswerStore {
    /// The store as `<runs>/queued-answers.json` has it. A file that is absent, torn or unreadable
    /// starts the queue empty rather than taking the pool down: processed history is not
    /// load-bearing.
    pub fn open(runs_dir: &Path) -> Self {
        let file = runs_dir.join("queued-answers.json");
        let mut store = QueuedAnswerStore {
            file,
            next_seq: 1,
            answers: Vec::new(),
        };
        if let Some((next_seq, answers)) = read_file(&store.file) {
            store.next_seq = next_seq;
            store.answers = answers;
        }
        store
    }

    /// Append an accepted answer, assigning its submission order, and write the file.
    pub fn enqueue(&mut self, answer: AcceptedAnswer) -> Result<QueuedAnswer, js::FsError> {
        let record = QueuedAnswer {
            ticket_id: answer.ticket_id,
            kind: answer.kind,
            approve: answer.approve,
            action: answer.action,
            attempt: answer.attempt,
            note: answer.note,
            by: answer.by,
            at: answer.at,
            seq: self.next_seq,
            processed_at: None,
        };
        self.next_seq += 1;
        self.answers.push(record.clone());
        self.save()?;
        Ok(record)
    }

    /// Unprocessed answers in submission order.
    pub fn pending(&self) -> Vec<QueuedAnswer> {
        self.answers
            .iter()
            .filter(|answer| answer.processed_at.is_none())
            .cloned()
            .collect()
    }

    /// The most recent accepted answer for a ticket with the same payload shape (approve, action and
    /// attempt equal, so a resume never matches a recorded approval, a Close or an Adopt, and an Adopt
    /// of one Candidate never matches an Adopt of another). This is the idempotent-resume lookup: a
    /// retried answer finds its acceptance here and is acknowledged again rather than recorded twice.
    pub fn latest_for(
        &self,
        ticket_id: &str,
        approve: Option<bool>,
        action: Option<QueuedAnswerAction>,
        attempt: Option<u64>,
    ) -> Option<&QueuedAnswer> {
        self.answers.iter().rev().find(|answer| {
            answer.ticket_id == ticket_id
                && answer.approve == approve
                && answer.action == action
                && answer.attempt == attempt
        })
    }

    /// Mark one answer processed now, and write the file; an unknown or already processed one is left.
    pub fn mark_processed(&mut self, seq: u64) -> Result<(), js::FsError> {
        let Some(record) = self.answers.iter_mut().find(|answer| answer.seq == seq) else {
            return Ok(());
        };
        if record.processed_at.is_some() {
            return Ok(());
        }
        record.processed_at = Some(js::now_iso());
        self.save()
    }

    fn save(&self) -> Result<(), js::FsError> {
        if let Some(dir) = self.file.parent() {
            js::mkdir_all(dir)?;
        }
        let mut aside = self.file.clone().into_os_string();
        aside.push(".tmp");
        let text = js::stringify_pretty(&json!({
            "nextSeq": self.next_seq,
            "answers": self.answers,
        }));
        js::write_through_rename(&self.file, Path::new(&aside), &text)
    }
}

// The file's counter and records, when it has both. A record the TypeScript would have carried
// unchecked but no Queued answer can hold makes the file as unreadable as a torn one.
fn read_file(file: &Path) -> Option<(u64, Vec<QueuedAnswer>)> {
    if !file.exists() {
        return None;
    }
    let Ok(Value::Object(mut parsed)) = js::parse(&js::read_text(file).ok()?) else {
        return None;
    };
    let next_seq = parsed.get("nextSeq")?.as_f64()?;
    let Some(Value::Array(_)) = parsed.get("answers") else {
        return None;
    };
    let answers = serde_json::from_value(parsed.remove("answers")?).ok()?;
    Some((next_seq.max(0.0) as u64, answers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_runs() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("queued-answers-")
            .tempdir()
            .unwrap()
    }

    fn accepted(ticket_id: &str, at: &str) -> AcceptedAnswer {
        AcceptedAnswer {
            ticket_id: ticket_id.into(),
            kind: InterruptKind::Checkpoint,
            approve: None,
            action: None,
            attempt: None,
            note: None,
            by: None,
            at: at.into(),
        }
    }

    // engine.test.ts:1360: a file from before Adopt reads as it always did, and an Adopt round-trips.
    #[test]
    fn reads_an_older_file_and_tells_an_adopt_of_one_candidate_from_another() {
        let runs = temp_runs();
        let old = json!({
            "seq": 1,
            "ticketId": "01",
            "kind": "checkpoint",
            "note": "carry on",
            "at": "2026-10-01T00:00:00.000Z",
            "processedAt": null,
        });
        fs::write(
            runs.path().join("queued-answers.json"),
            js::stringify(&json!({"nextSeq": 2, "answers": [old]})),
        )
        .unwrap();
        let mut store = QueuedAnswerStore::open(runs.path());
        let pending = store.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(serde_json::to_value(&pending[0]).unwrap(), old);
        assert_eq!(
            store.latest_for("01", None, None, None).map(|a| a.seq),
            Some(1)
        );
        assert!(
            store
                .latest_for("01", None, Some(QueuedAnswerAction::Adopt), Some(2))
                .is_none()
        );

        store
            .enqueue(AcceptedAnswer {
                action: Some(QueuedAnswerAction::Adopt),
                attempt: Some(2),
                note: Some("the tidy one".into()),
                ..accepted("02", "2026-10-01T00:00:01.000Z")
            })
            .unwrap();
        let reread = QueuedAnswerStore::open(runs.path());
        assert_eq!(
            reread
                .pending()
                .iter()
                .map(|a| (a.ticket_id.as_str(), a.action, a.attempt))
                .collect::<Vec<_>>(),
            [
                ("01", None, None),
                ("02", Some(QueuedAnswerAction::Adopt), Some(2))
            ]
        );
        assert_eq!(
            reread
                .latest_for("02", None, Some(QueuedAnswerAction::Adopt), Some(2))
                .map(|a| a.seq),
            Some(2)
        );
        // An Adopt of another Candidate is a different answer.
        assert!(
            reread
                .latest_for("02", None, Some(QueuedAnswerAction::Adopt), Some(3))
                .is_none()
        );
        assert!(reread.latest_for("02", None, None, None).is_none());
    }

    #[test]
    fn writes_the_file_pretty_through_a_rename_and_marks_an_answer_processed_once() {
        let runs = temp_runs();
        let dir = runs.path().join("runs");
        let mut store = QueuedAnswerStore::open(&dir);
        let record = store
            .enqueue(AcceptedAnswer {
                approve: Some(true),
                by: Some(AnswerBy::Steward),
                kind: InterruptKind::MergeApproval,
                ..accepted("01", "2026-10-01T00:00:00.000Z")
            })
            .unwrap();
        assert_eq!(record.seq, 1);
        assert_eq!(
            fs::read_to_string(dir.join("queued-answers.json")).unwrap(),
            "{\n  \"nextSeq\": 2,\n  \"answers\": [\n    {\n      \"ticketId\": \"01\",\n      \"kind\": \"merge-approval\",\n      \"approve\": true,\n      \"by\": \"steward\",\n      \"at\": \"2026-10-01T00:00:00.000Z\",\n      \"seq\": 1,\n      \"processedAt\": null\n    }\n  ]\n}"
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        store.mark_processed(1).unwrap();
        let processed = QueuedAnswerStore::open(&dir).answers[0]
            .processed_at
            .clone()
            .unwrap();
        assert_eq!(processed.len(), 24);
        store.mark_processed(1).unwrap();
        store.mark_processed(9).unwrap();
        assert_eq!(
            QueuedAnswerStore::open(&dir).answers[0]
                .processed_at
                .as_deref(),
            Some(processed.as_str())
        );
        assert!(store.pending().is_empty());
        assert_eq!(
            store
                .latest_for("01", Some(true), None, None)
                .map(|a| a.seq),
            Some(1)
        );
        assert!(store.latest_for("01", Some(false), None, None).is_none());
    }

    #[test]
    fn starts_empty_over_a_torn_or_foreign_file() {
        let runs = temp_runs();
        for text in [
            "{torn",
            "[]",
            r#"{"nextSeq":"2","answers":[]}"#,
            r#"{"nextSeq":2}"#,
        ] {
            fs::write(runs.path().join("queued-answers.json"), text).unwrap();
            let mut store = QueuedAnswerStore::open(runs.path());
            assert!(store.pending().is_empty(), "{text}");
            assert_eq!(store.enqueue(accepted("01", "t")).unwrap().seq, 1, "{text}");
        }
    }
}
