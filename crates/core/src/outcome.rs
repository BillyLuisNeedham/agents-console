//! The Outcome contract's validator (engine.ts `validateOutcome` and `validateSpawnProposals`): what an
//! Attempt's result JSON must hold to count as an ending, and the per-proposal check of its Spawn
//! proposals (ADR-0010). The engine, not the agent, writes the status to the Ticket's marker
//! (ADR-0005); this only decides whether the file is a valid Outcome. A malformed proposal never fails
//! the Attempt: it is dropped with its index and a reason, and the Outcome's own status stands.
//!
//! The same proposal check serves a Conversation's spawn.json batches, so the two cannot drift.

use ac_protocol::{
    AllTickets, Outcome, OutcomeStatus, SpawnAssignRequest, SpawnBlocks, SpawnKind, SpawnProposal,
};
use serde_json::{Map, Value};

use crate::js;
use ac_protocol::json::True;

/// A proposal's body must carry enough intent for a fresh agent to work from; anything thinner is a
/// note, not a ticket. The prompt teaching names the same floor.
pub const SPAWN_BODY_MIN_CHARS: usize = 20;

/// One spawn entry the schema rejected: where it sat in the array (absent when the spawn key itself is
/// malformed) and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnRejection {
    pub index: Option<usize>,
    pub reason: String,
}

/// The well-formed proposals and the rejected entries of one spawn array.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpawnValidation {
    pub proposals: Vec<SpawnProposal>,
    pub rejections: Vec<SpawnRejection>,
}

/// A valid Outcome and the spawn entries its validation dropped.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidOutcome {
    pub outcome: Outcome,
    pub spawn_rejections: Vec<SpawnRejection>,
}

fn reject(rejections: &mut Vec<SpawnRejection>, index: usize, reason: impl Into<String>) {
    rejections.push(SpawnRejection {
        index: Some(index),
        reason: reason.into(),
    });
}

// A list of non-blank strings, as `blockedBy`, `blocks` and `overlaps` must each be.
fn id_list(value: &Value) -> Option<Vec<String>> {
    let items = value.as_array()?;
    items
        .iter()
        .map(|item| match item {
            Value::String(id) if !js::trim(id).is_empty() => Some(id.clone()),
            _ => None,
        })
        .collect()
}

/// Per-proposal spawn validation (ADR-0010, with the Conversations ADR's kind and assign): the
/// well-formed entries come back as proposals, the malformed ones as rejections carrying their index
/// and a reason. `raw` is `None` when the key is absent.
pub fn validate_spawn_proposals(raw: Option<&Value>) -> SpawnValidation {
    let mut out = SpawnValidation::default();
    let Some(raw) = raw else {
        return out;
    };
    let Some(entries) = raw.as_array() else {
        out.rejections.push(SpawnRejection {
            index: None,
            reason: "spawn is not an array".into(),
        });
        return out;
    };
    for (index, entry) in entries.iter().enumerate() {
        match validate_one(entry) {
            Ok(proposal) => out.proposals.push(proposal),
            Err(reason) => reject(&mut out.rejections, index, reason),
        }
    }
    out
}

fn validate_one(entry: &Value) -> Result<SpawnProposal, String> {
    let Some(proposal) = entry.as_object() else {
        return Err("spawn entry is not an object".into());
    };
    let title = match proposal.get("title") {
        Some(Value::String(title)) if !js::trim(title).is_empty() => title.clone(),
        _ => return Err("proposal has no title".into()),
    };
    let body = match proposal.get("body") {
        Some(Value::String(body)) if js::utf16_len(js::trim(body)) >= SPAWN_BODY_MIN_CHARS => {
            body.clone()
        }
        _ => {
            return Err(format!(
                "proposal body is missing or thin (needs {SPAWN_BODY_MIN_CHARS}+ characters)"
            ));
        }
    };
    let blocked_by = match proposal.get("blockedBy") {
        None => None,
        Some(value) => Some(
            id_list(value)
                .ok_or_else(|| "proposal's blockedBy is not a list of strings".to_owned())?,
        ),
    };
    let kind = match proposal.get("kind") {
        None => None,
        Some(Value::String(kind)) if kind == "ticket" => Some(SpawnKind::Ticket),
        Some(Value::String(kind)) if kind == "conversation" => Some(SpawnKind::Conversation),
        Some(other) => {
            return Err(format!(
                "proposal's kind must be \"ticket\" or \"conversation\", got '{}'",
                js::string_of(other)
            ));
        }
    };
    let blocks = match proposal.get("blocks") {
        None => None,
        Some(Value::String(all)) if all == "all" => Some(SpawnBlocks::All(AllTickets::All)),
        Some(value) => Some(SpawnBlocks::Ids(id_list(value).ok_or_else(|| {
            "proposal's blocks is not a list of ticket ids or \"all\"".to_owned()
        })?)),
    };
    let overlaps = match proposal.get("overlaps") {
        None => None,
        Some(value) => Some(
            id_list(value).ok_or_else(|| "proposal's overlaps is not a list of ids".to_owned())?,
        ),
    };
    if blocks.is_some() && kind == Some(SpawnKind::Conversation) {
        return Err("proposal's blocks is only for a ticket: a Conversation blocks nothing".into());
    }
    let (assign, verify_ignored) = match proposal.get("assign") {
        None => (None, false),
        Some(Value::Object(fields)) => validate_assign(fields)?,
        Some(_) => return Err("proposal's assign is not an object".into()),
    };
    Ok(SpawnProposal {
        title,
        body,
        blocked_by,
        kind,
        assign,
        verify_ignored: verify_ignored.then_some(True),
        blocks,
        overlaps: overlaps.filter(|ids| !ids.is_empty()),
    })
}

fn validate_assign(
    fields: &Map<String, Value>,
) -> Result<(Option<SpawnAssignRequest>, bool), String> {
    for field in ["harness", "model", "effort", "drivers"] {
        if let Some(value) = fields.get(field)
            && !value.is_string()
        {
            return Err(format!("proposal's assign.{field} is not a string"));
        }
    }
    let text = |field: &str| fields.get(field).and_then(Value::as_str).map(str::to_owned);
    Ok((
        Some(SpawnAssignRequest {
            harness: text("harness"),
            model: text("model"),
            effort: text("effort"),
            drivers: text("drivers"),
        }),
        fields.contains_key("verify"),
    ))
}

/// The Outcome contract's validator, shared by the attempt reader and the grader reader: a status of
/// done or checkpoint and a summary string make a valid Outcome; the reason when not.
pub fn validate_outcome(parsed: &Value) -> Result<ValidOutcome, String> {
    let fields = parsed.as_object();
    let field = |key: &str| fields.and_then(|fields| fields.get(key));
    let status = match field("status").and_then(Value::as_str) {
        Some("done") => OutcomeStatus::Done,
        Some("checkpoint") => OutcomeStatus::Checkpoint,
        _ => return Err("outcome's status is not done or checkpoint".into()),
    };
    let Some(Value::String(summary)) = field("summary") else {
        return Err("outcome has no summary string".into());
    };
    let spawn = validate_spawn_proposals(field("spawn"));
    Ok(ValidOutcome {
        outcome: Outcome {
            status,
            summary: summary.clone(),
            commit_sha: field("commitSha")
                .and_then(Value::as_str)
                .map(str::to_owned),
            brief: field("brief").and_then(Value::as_str).map(str::to_owned),
            spawn: field("spawn").map(|_| spawn.proposals),
        },
        spawn_rejections: spawn.rejections,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BODY: &str = "a follow-up with enough intent to act on";

    #[test]
    fn a_valid_outcome_keeps_only_the_contract_fields() {
        let valid = validate_outcome(&json!({
            "status": "done", "summary": "did it", "commitSha": 7, "brief": null, "extra": 1
        }))
        .unwrap();
        assert_eq!(
            js::to_json(&valid.outcome),
            r#"{"status":"done","summary":"did it","commitSha":null}"#
        );
        assert!(valid.spawn_rejections.is_empty());
        let valid = validate_outcome(&json!({
            "status": "checkpoint", "summary": "", "commitSha": "abc", "brief": "do this"
        }))
        .unwrap();
        assert_eq!(valid.outcome.commit_sha.as_deref(), Some("abc"));
        assert_eq!(valid.outcome.brief.as_deref(), Some("do this"));
    }

    #[test]
    fn an_invalid_outcome_says_why() {
        for parsed in [json!(null), json!(5), json!([]), json!({"status": "ready"})] {
            assert_eq!(
                validate_outcome(&parsed).unwrap_err(),
                "outcome's status is not done or checkpoint"
            );
        }
        assert_eq!(
            validate_outcome(&json!({"status": "done", "summary": 1})).unwrap_err(),
            "outcome has no summary string"
        );
    }

    #[test]
    fn a_present_spawn_key_is_kept_even_when_nothing_survives() {
        let valid =
            validate_outcome(&json!({"status": "done", "summary": "s", "spawn": null})).unwrap();
        assert_eq!(valid.outcome.spawn, Some(vec![]));
        assert_eq!(
            valid.spawn_rejections,
            vec![SpawnRejection {
                index: None,
                reason: "spawn is not an array".into()
            }]
        );
        let valid = validate_outcome(&json!({"status": "done", "summary": "s"})).unwrap();
        assert_eq!(valid.outcome.spawn, None);
    }

    #[test]
    fn each_malformed_entry_is_rejected_with_its_index_and_reason() {
        let checked = validate_spawn_proposals(Some(&json!([
            "x",
            {"title": " ", "body": BODY},
            {"title": "t", "body": "too short"},
            {"title": "t", "body": BODY, "blockedBy": ["01", ""]},
            {"title": "t", "body": BODY, "kind": null},
            {"title": "t", "body": BODY, "blocks": "some"},
            {"title": "t", "body": BODY, "overlaps": "01"},
            {"title": "t", "body": BODY, "kind": "conversation", "blocks": ["01"]},
            {"title": "t", "body": BODY, "assign": []},
            {"title": "t", "body": BODY, "assign": {"model": null}},
        ])));
        assert!(checked.proposals.is_empty());
        let reasons: Vec<(Option<usize>, &str)> = checked
            .rejections
            .iter()
            .map(|r| (r.index, r.reason.as_str()))
            .collect();
        assert_eq!(
            reasons,
            vec![
                (Some(0), "spawn entry is not an object"),
                (Some(1), "proposal has no title"),
                (
                    Some(2),
                    "proposal body is missing or thin (needs 20+ characters)"
                ),
                (Some(3), "proposal's blockedBy is not a list of strings"),
                (
                    Some(4),
                    "proposal's kind must be \"ticket\" or \"conversation\", got 'null'"
                ),
                (
                    Some(5),
                    "proposal's blocks is not a list of ticket ids or \"all\""
                ),
                (Some(6), "proposal's overlaps is not a list of ids"),
                (
                    Some(7),
                    "proposal's blocks is only for a ticket: a Conversation blocks nothing"
                ),
                (Some(8), "proposal's assign is not an object"),
                (Some(9), "proposal's assign.model is not a string"),
            ]
        );
    }

    #[test]
    fn a_well_formed_entry_keeps_its_fields_and_flags_an_ignored_verify() {
        let checked = validate_spawn_proposals(Some(&json!([{
            "title": " t ",
            "body": BODY,
            "blockedBy": ["01"],
            "kind": "ticket",
            "assign": {"harness": "claude", "verify": 2, "other": 1},
            "blocks": "all",
            "overlaps": [],
        }])));
        assert!(checked.rejections.is_empty());
        let proposal = &checked.proposals[0];
        assert_eq!(proposal.title, " t ");
        assert_eq!(proposal.blocked_by, Some(vec!["01".to_string()]));
        assert_eq!(proposal.blocks, Some(SpawnBlocks::All(AllTickets::All)));
        assert_eq!(proposal.overlaps, None);
        assert!(proposal.verify_ignored.is_some());
        assert_eq!(
            js::to_json(proposal.assign.as_ref().unwrap()),
            r#"{"harness":"claude"}"#
        );
    }
}
