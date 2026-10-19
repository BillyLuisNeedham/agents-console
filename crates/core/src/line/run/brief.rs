//! The Line brief a Conversation node commits, or `--brief` names: `{spec?, items?, finish?,
//! pushBase?, nodes?}`, where `nodes` maps node ids to `{assign?, note?}`. Its overrides become
//! `PlanEdit::SetNode`s on the frozen Plan.

use indexmap::IndexMap;
use serde::Deserialize;

use super::Item;
use crate::js;
use crate::outcome::{ITEM_BODY_MAX, ITEM_TITLE_MAX, ITEMS_MAX};
use crate::plan::{Assign, FinishAct, NodeBody, NodeId, Plan};

#[derive(Debug, Clone, PartialEq, Default)]
pub struct LineBrief {
    pub spec: Option<String>,
    pub items: Vec<Item>,
    pub finish: Option<FinishAct>,
    pub push_base: Option<bool>,
    pub nodes: IndexMap<NodeId, NodeOverride>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NodeOverride {
    pub assign: Option<Assign>,
    pub note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BriefFile {
    spec: Option<String>,
    #[serde(default)]
    items: Vec<ItemFile>,
    finish: Option<String>,
    push_base: Option<bool>,
    #[serde(default)]
    nodes: IndexMap<String, OverrideFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemFile {
    title: String,
    body: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OverrideFile {
    assign: Option<AssignFile>,
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssignFile {
    harness: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

fn tidy(text: Option<String>) -> Option<String> {
    text.map(|t| js::trim(&t).to_owned())
        .filter(|t| !t.is_empty())
}

impl LineBrief {
    /// A brief's text read and checked: the reason when it is not one.
    pub fn parse(text: &str) -> Result<LineBrief, String> {
        let value = js::parse(text).map_err(|e| format!("not valid JSON ({e})"))?;
        if !value.is_object() {
            return Err("not a JSON object".into());
        }
        let file: BriefFile = serde_json::from_value(value).map_err(|e| e.to_string())?;
        let spec = match file.spec {
            Some(spec) => {
                Some(tidy(Some(spec)).ok_or("spec is blank: leave it out, or name the spec")?)
            }
            None => None,
        };
        let finish = match file.finish {
            Some(finish) => Some(finish_act(
                &tidy(Some(finish)).ok_or("finish is blank: leave it out, or name the act")?,
            )),
            None => None,
        };
        if file.items.len() > ITEMS_MAX {
            return Err(format!(
                "items holds {}: at most {ITEMS_MAX}",
                file.items.len()
            ));
        }
        let mut items = Vec::new();
        for (i, item) in file.items.into_iter().enumerate() {
            let title = js::trim(&item.title).to_owned();
            if title.is_empty() || title.chars().count() > ITEM_TITLE_MAX {
                return Err(format!(
                    "item {} needs a title of 1 to {ITEM_TITLE_MAX} characters",
                    i + 1
                ));
            }
            if item.body.len() > ITEM_BODY_MAX {
                return Err(format!(
                    "item {}'s body is over {ITEM_BODY_MAX} bytes",
                    i + 1
                ));
            }
            items.push(Item {
                title,
                body: item.body,
            });
        }
        let mut nodes = IndexMap::new();
        for (id, change) in file.nodes {
            let id = NodeId::parse(&id).map_err(|e| format!("nodes: {e}"))?;
            let assign = change.assign.map(|a| Assign {
                harness: tidy(a.harness),
                model: tidy(a.model),
                effort: tidy(a.effort),
            });
            nodes.insert(
                id,
                NodeOverride {
                    assign,
                    note: tidy(change.note),
                },
            );
        }
        Ok(LineBrief {
            spec,
            items,
            finish,
            push_base: file.push_base,
            nodes,
        })
    }
}

/// The Finish act a brief names: `none`, `draft-pr`, `pr`, `fast-forward`, or free text.
fn finish_act(word: &str) -> FinishAct {
    match word {
        "none" => FinishAct::None,
        "draft-pr" => FinishAct::DraftPr,
        "pr" => FinishAct::Pr,
        "fast-forward" => FinishAct::FastForward,
        other => FinishAct::Other(other.to_owned()),
    }
}

impl NodeOverride {
    /// The node's body with this override applied, `None` for a node it cannot apply to.
    pub(super) fn apply(&self, body: &NodeBody) -> Option<NodeBody> {
        let assign = |base: &Assign| match &self.assign {
            Some(over) => Assign {
                harness: over.harness.clone().or_else(|| base.harness.clone()),
                model: over.model.clone().or_else(|| base.model.clone()),
                effort: over.effort.clone().or_else(|| base.effort.clone()),
            },
            None => base.clone(),
        };
        let note = |base: &Option<String>| self.note.clone().or_else(|| base.clone());
        Some(match body {
            NodeBody::Ticket(t) => {
                let mut t = t.clone();
                t.assign = assign(&t.assign);
                t.note = note(&t.note);
                NodeBody::Ticket(t)
            }
            NodeBody::Conversation(c) => {
                let mut c = c.clone();
                c.assign = assign(&c.assign);
                c.note = note(&c.note);
                NodeBody::Conversation(c)
            }
            NodeBody::Finish(f) if self.note.is_none() => {
                let mut f = f.clone();
                f.assign = assign(&f.assign);
                NodeBody::Finish(f)
            }
            _ => return None,
        })
    }
}

/// Why a brief cannot apply to this Plan: an override on a node it lacks, or on a node with no
/// Assignment or note to override.
pub fn brief_problem(plan: &Plan, brief: &LineBrief) -> Option<String> {
    brief
        .nodes
        .iter()
        .find_map(|(id, change)| match plan.node(id) {
            None => Some(format!("nodes: the Plan has no node {id}")),
            Some(node) if change.apply(&node.body).is_none() => Some(format!(
                "nodes: {id} has no Assignment or note this brief can override"
            )),
            Some(_) => None,
        })
}
