//! The Outcome contract's validator (engine.ts `validateOutcome` and `validateSpawnProposals`): what an
//! Attempt's result JSON must hold to count as an ending, and the per-proposal check of its Spawn
//! proposals (ADR-0010). The engine, not the agent, writes the status to the Ticket's marker
//! (ADR-0005); this only decides whether the file is a valid Outcome. A malformed proposal never fails
//! the Attempt: it is dropped with its index and a reason, and the Outcome's own status stands.
//!
//! An Outcome's `items` are checked the same way, entry by entry, against the bounds a Line brief
//! holds its Items to.
//!
//! The same proposal check serves a Conversation's spawn.json batches, so the two cannot drift.

use ac_protocol::{
    AllTickets, LineItem, Outcome, OutcomeStatus, SpawnAssignRequest, SpawnBlocks, SpawnKind,
    SpawnProposal,
};
use serde_json::{Map, Value};

use crate::js;
use ac_protocol::json::True;

/// A proposal's body must carry enough intent for a fresh agent to work from; anything thinner is a
/// note, not a ticket. The prompt teaching names the same floor.
pub const SPAWN_BODY_MIN_CHARS: usize = 20;

/// The bounds on Items, from an Outcome or a Line brief: how many, a title's characters, a body's bytes.
pub const ITEMS_MAX: usize = 64;
pub const ITEM_TITLE_MAX: usize = 200;
pub const ITEM_BODY_MAX: usize = 16 * 1024;

/// One spawn or item entry the schema rejected: where it sat in the array (absent when the key itself
/// is malformed), the title a spawn entry gave, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub index: Option<usize>,
    pub title: Option<String>,
    pub reason: String,
}

/// The well-formed proposals and the rejected entries of one spawn array.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpawnValidation {
    pub proposals: Vec<SpawnProposal>,
    pub rejections: Vec<Rejection>,
}

/// The well-formed Items and the rejected entries of one items array.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ItemValidation {
    pub items: Vec<LineItem>,
    pub rejections: Vec<Rejection>,
}

/// A valid Outcome and the spawn and item entries its validation dropped.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidOutcome {
    pub outcome: Outcome,
    pub spawn_rejections: Vec<Rejection>,
    pub item_rejections: Vec<Rejection>,
}

fn reject(rejections: &mut Vec<Rejection>, index: usize, reason: impl Into<String>) {
    rejections.push(Rejection {
        index: Some(index),
        title: None,
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
        out.rejections.push(Rejection {
            index: None,
            title: None,
            reason: "spawn is not an array".into(),
        });
        return out;
    };
    for (index, entry) in entries.iter().enumerate() {
        match validate_one(entry) {
            Ok(proposal) => out.proposals.push(proposal),
            Err(reason) => out.rejections.push(Rejection {
                index: Some(index),
                title: entry
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|title| !js::trim(title).is_empty())
                    .map(str::to_owned),
                reason,
            }),
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

/// Per-entry Item validation: the well-formed entries come back as Items, the rest as rejections
/// carrying their index and a reason. `raw` is `None` when the key is absent.
pub fn validate_items(raw: Option<&Value>) -> ItemValidation {
    let mut out = ItemValidation::default();
    let Some(raw) = raw else {
        return out;
    };
    let Some(entries) = raw.as_array() else {
        out.rejections.push(Rejection {
            index: None,
            title: None,
            reason: "items is not an array".into(),
        });
        return out;
    };
    for (index, entry) in entries.iter().enumerate() {
        let checked = if index >= ITEMS_MAX {
            Err(format!("item is past the first {ITEMS_MAX} a Line takes"))
        } else {
            validate_item(entry)
        };
        match checked {
            Ok(item) => out.items.push(item),
            Err(reason) => reject(&mut out.rejections, index, reason),
        }
    }
    out
}

fn validate_item(entry: &Value) -> Result<LineItem, String> {
    let Some(item) = entry.as_object() else {
        return Err("item is not an object".into());
    };
    if item.keys().any(|key| key != "title" && key != "body") {
        return Err("item has a key other than title and body".into());
    }
    let title = match item.get("title") {
        Some(Value::String(title)) if !js::trim(title).is_empty() => js::trim(title),
        _ => return Err("item has no title".into()),
    };
    if title.chars().count() > ITEM_TITLE_MAX {
        return Err(format!("item's title is over {ITEM_TITLE_MAX} characters"));
    }
    let Some(Value::String(body)) = item.get("body") else {
        return Err("item has no body string".into());
    };
    if body.len() > ITEM_BODY_MAX {
        return Err(format!("item's body is over {ITEM_BODY_MAX} bytes"));
    }
    Ok(LineItem {
        title: title.to_owned(),
        body: body.clone(),
    })
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
    let items = validate_items(field("items"));
    Ok(ValidOutcome {
        outcome: Outcome {
            status,
            summary: summary.clone(),
            commit_sha: field("commitSha")
                .and_then(Value::as_str)
                .map(str::to_owned),
            brief: field("brief").and_then(Value::as_str).map(str::to_owned),
            spawn: field("spawn").map(|_| spawn.proposals),
            items: field("items").map(|_| items.items),
            verdict: field("verdict").filter(|v| !v.is_null()).cloned(),
        },
        spawn_rejections: spawn.rejections,
        item_rejections: items.rejections,
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
            vec![Rejection {
                index: None,
                title: None,
                reason: "spawn is not an array".into()
            }]
        );
        let valid = validate_outcome(&json!({"status": "done", "summary": "s"})).unwrap();
        assert_eq!(valid.outcome.spawn, None);
    }

    #[test]
    fn a_rejected_entry_keeps_the_title_it_gave() {
        let checked = validate_spawn_proposals(Some(&json!([
            {"title": "Thin", "body": "too short"},
            {"title": " ", "body": BODY},
            {"body": BODY, "kind": "epic"},
        ])));
        let titles: Vec<Option<&str>> = checked
            .rejections
            .iter()
            .map(|r| r.title.as_deref())
            .collect();
        assert_eq!(titles, vec![Some("Thin"), None, None]);
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

    #[test]
    fn a_present_items_key_is_kept_even_when_nothing_survives() {
        let valid =
            validate_outcome(&json!({"status": "done", "summary": "s", "items": 3})).unwrap();
        assert_eq!(valid.outcome.items, Some(vec![]));
        assert_eq!(
            valid.item_rejections,
            vec![Rejection {
                index: None,
                title: None,
                reason: "items is not an array".into()
            }]
        );
        let valid =
            validate_outcome(&json!({"status": "done", "summary": "s", "items": []})).unwrap();
        assert_eq!(valid.outcome.items, Some(vec![]));
        assert!(valid.item_rejections.is_empty());
    }

    #[test]
    fn an_outcome_without_items_serialises_without_the_key() {
        let valid = validate_outcome(&json!({"status": "done", "summary": "s"})).unwrap();
        assert_eq!(valid.outcome.items, None);
        assert_eq!(
            js::to_json(&valid.outcome),
            r#"{"status":"done","summary":"s","commitSha":null}"#
        );
    }

    #[test]
    fn well_formed_items_keep_a_trimmed_title_and_the_body_as_written() {
        let valid = validate_outcome(&json!({
            "status": "done", "summary": "s",
            "items": [{"title": "  one  ", "body": "  as written\n"}, {"title": "two", "body": ""}]
        }))
        .unwrap();
        assert!(valid.item_rejections.is_empty());
        let items: Vec<(&str, &str)> = valid
            .outcome
            .items
            .as_ref()
            .unwrap()
            .iter()
            .map(|i| (i.title.as_str(), i.body.as_str()))
            .collect();
        assert_eq!(items, [("one", "  as written\n"), ("two", "")]);
    }

    #[test]
    fn each_item_outside_the_bounds_is_dropped_with_its_index() {
        let long_title = "t".repeat(ITEM_TITLE_MAX + 1);
        let long_body = "b".repeat(ITEM_BODY_MAX + 1);
        let mut entries = vec![
            json!("x"),
            json!({"title": "ok", "body": "fine"}),
            json!({"title": "t", "body": "b", "extra": 1}),
            json!({"title": 4, "body": "b"}),
            json!({"title": " ", "body": "b"}),
            json!({"title": long_title, "body": "b"}),
            json!({"title": "t", "body": null}),
            json!({"title": "t"}),
            json!({"title": "t", "body": long_body}),
            json!({"title": "t".repeat(ITEM_TITLE_MAX), "body": "b".repeat(ITEM_BODY_MAX)}),
        ];
        while entries.len() < ITEMS_MAX + 2 {
            entries.push(json!({"title": "more", "body": "b"}));
        }
        let checked = validate_items(Some(&Value::Array(entries)));
        let dropped: Vec<(Option<usize>, &str)> = checked
            .rejections
            .iter()
            .map(|r| (r.index, r.reason.as_str()))
            .collect();
        assert_eq!(
            dropped,
            vec![
                (Some(0), "item is not an object"),
                (Some(2), "item has a key other than title and body"),
                (Some(3), "item has no title"),
                (Some(4), "item has no title"),
                (Some(5), "item's title is over 200 characters"),
                (Some(6), "item has no body string"),
                (Some(7), "item has no body string"),
                (Some(8), "item's body is over 16384 bytes"),
                (Some(64), "item is past the first 64 a Line takes"),
                (Some(65), "item is past the first 64 a Line takes"),
            ]
        );
        assert_eq!(checked.items.len(), ITEMS_MAX - 8);
        assert_eq!(checked.items[0].title, "ok");
    }
}
