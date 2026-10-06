//! The Steward (ADR-0030; steward.ts): a Conversation in the role of keeping the Pool's Tickets moving
//! while the operator is away. This module holds what the role adds to a Conversation and nothing that
//! needs a Session: the `steward` entry of console.json (a Pool setting holding the Steward budget, the
//! Steward's Assignment and whether it may Close, reloaded with the assignment slice and the Spawn
//! caps), which pending items the Steward is told about and the text that tells it, and the command it
//! answers with. The budget rule and the notes file sit beside it (`steward_notes`,
//! `ac_engine::steward_actions`); the wire shapes of the routes are in `ac-protocol`.

use std::collections::HashSet;

use ac_protocol::{Interrupt, MergeQueueEntry, MergeQueueState, StewardAssign};
use serde_json::Value;

use crate::config::{ConfigError, PoolConfig};
use crate::js;

/// The Steward budget unless the pool sets one.
pub const DEFAULT_STEWARD_BUDGET: u64 = 5;

const ASSIGN_FIELDS: [&str; 4] = ["harness", "model", "effort", "drivers"];

/// Whether the Steward may Close under a config: only while the pool says true (issue #154).
pub fn steward_may_close_of(config: &PoolConfig) -> bool {
    steward_field(config, "mayClose") == Some(&Value::Bool(true))
}

/// The Steward budget in force under a config: 5 unless the pool says otherwise.
pub fn steward_budget_of(config: &PoolConfig) -> u64 {
    steward_field(config, "budget")
        .and_then(js::number_of)
        .map_or(DEFAULT_STEWARD_BUDGET, |budget| budget as u64)
}

/// The Steward's Assignment fields as the entry sets them, layered between a Steward's start request
/// and the pool defaults (conversations.ts's start resolution).
pub fn steward_assign_of(config: &PoolConfig) -> Option<StewardAssign> {
    let assign = steward_field(config, "assign")?.as_object()?;
    let field = |name: &str| assign.get(name).and_then(Value::as_str).map(str::to_owned);
    Some(StewardAssign {
        harness: field("harness"),
        model: field("model"),
        effort: field("effort"),
        drivers: field("drivers"),
    })
}

fn steward_field<'a>(config: &'a PoolConfig, name: &str) -> Option<&'a Value> {
    config.get("steward")?.get(name)
}

/// A Steward budget: a whole number, 1 or more.
pub fn is_steward_budget(value: &Value) -> bool {
    js::is_integer(value) && js::number_of(value).is_some_and(|budget| budget >= 1.0)
}

/// A console.json `steward` value, checked for shape: absent, or an object whose budget, where
/// present, is a whole number of 1 or more, whose assign, where present, is an object of strings, and
/// whose mayClose, where present, is a boolean. Boot's parse and the boundary's reload share it, so a
/// value the reload would refuse never boots. Whether the assign names a harness the pool knows is the
/// caller's check (`config::check_steward_harness`): only the engine has the harness table.
pub fn check_steward_config(raw: Option<&Value>) -> Result<(), ConfigError> {
    let Some(raw) = raw else { return Ok(()) };
    let Value::Object(steward) = raw else {
        return Err(ConfigError::new("pool config: steward must be an object"));
    };
    if let Some(budget) = steward.get("budget")
        && !is_steward_budget(budget)
    {
        return Err(ConfigError::new(
            "pool config: steward.budget must be a whole number, 1 or more",
        ));
    }
    if let Some(may_close) = steward.get("mayClose")
        && !may_close.is_boolean()
    {
        return Err(ConfigError::new(
            "pool config: steward.mayClose must be true or false",
        ));
    }
    if let Some(assign) = steward.get("assign") {
        let Value::Object(assign) = assign else {
            return Err(ConfigError::new(
                "pool config: steward.assign must be an object",
            ));
        };
        for field in ASSIGN_FIELDS {
            if let Some(value) = assign.get(field)
                && !value.is_string()
            {
                return Err(ConfigError(format!(
                    "pool config: steward.assign.{field} must be a string"
                )));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// What the Steward is told about: every pending Ticket Interrupt it may answer and has not left, and
// a stalled Merge queue head.
// ---------------------------------------------------------------------------

/// The Interrupt kinds the Steward never answers: the operator's final judgement, and an engine store
/// failure.
pub const STEWARD_EXCLUDED_KINDS: [&str; 2] = ["review", "persistence"];

/// The Interrupt kinds a Steward may Close while the pool allows it: never a deadlock (ADR-0030).
pub const STEWARD_CLOSE_KINDS: [&str; 2] = ["checkpoint", "merge-conflict"];

/// What an item tells the Steward. A waiting Ticket and a stalled head ask for an act; a merged Ticket
/// and the pool reaching Review only inform, so the Steward can tell when its orders are done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StewardItemKind {
    Interrupt,
    MergeStall,
    Merged,
    Pool,
}

impl StewardItemKind {
    /// The Notice kind the item travels as (`steward-interrupt` and so on).
    pub fn as_str(self) -> &'static str {
        match self {
            StewardItemKind::Interrupt => "steward-interrupt",
            StewardItemKind::MergeStall => "steward-merge-stall",
            StewardItemKind::Merged => "steward-merged",
            StewardItemKind::Pool => "steward-pool",
        }
    }
}

/// One thing the Steward should hear about, as a Notice: its identity, the Ticket it is about, and
/// the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StewardItem {
    /// `interrupt:<ticket>:<kind>`, `merge-stall:<ticket>`, `merged:<ticket>` or `pool:<review|done>`.
    pub key: String,
    pub kind: StewardItemKind,
    /// The Ticket the item is about, whose log records the Notice; `None` for the pool's own.
    pub ticket_id: Option<String>,
    pub text: String,
}

/// Where the final Review stands: waiting for the operator, or approved. Not yet raised is `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StewardReview {
    Pending,
    Approved,
}

/// The pool as the item rule reads it; the engine builds it from its Session.
pub struct StewardPoolView<'a> {
    pub interrupts: &'a [Interrupt],
    pub title_of: &'a dyn Fn(&str) -> Option<String>,
    /// Ids that are Conversations: their Interrupts are outside the Steward's remit.
    pub conversations: &'a HashSet<String>,
    /// Tickets with an answer already queued: already answered, by someone.
    pub queued: &'a HashSet<String>,
    /// Whether the Steward left this Interrupt with a note (ticket, kind).
    pub left: &'a dyn Fn(&str, &str) -> bool,
    /// Whether a checkpoint's pane is still alive to Keep talking in.
    pub keep_talking: &'a dyn Fn(&str) -> bool,
    pub budget: u64,
    pub used: &'a dyn Fn(&str) -> u64,
    /// "Steward may Close checkpoints", read live: whether Close is among the answers offered.
    pub may_close: bool,
    pub merge_queue: &'a [MergeQueueEntry],
    /// Tickets done with their branch landed: what has merged.
    pub merged: &'a [String],
    pub review: Option<StewardReview>,
}

/// A pending Interrupt the Steward may answer at all: a Ticket's, not review or persistence, not a
/// Conversation's.
pub fn steward_may_answer(ticket_id: &str, kind: &str, conversations: &HashSet<String>) -> bool {
    !STEWARD_EXCLUDED_KINDS.contains(&kind) && !conversations.contains(ticket_id)
}

/// `stewardItems`: everything the Steward should hear about under this view of the pool.
pub fn steward_items(pool: &StewardPoolView<'_>) -> Vec<StewardItem> {
    let mut items = Vec::new();
    for interrupt in pool.interrupts {
        let kind = interrupt.kind.as_str();
        let ticket_id = interrupt.ticket_id.as_str();
        if !steward_may_answer(ticket_id, kind, pool.conversations) {
            continue;
        }
        if pool.queued.contains(ticket_id) || (pool.left)(ticket_id, kind) {
            continue;
        }
        let used = (pool.used)(ticket_id);
        items.push(StewardItem {
            key: format!("interrupt:{ticket_id}:{kind}"),
            kind: StewardItemKind::Interrupt,
            ticket_id: Some(ticket_id.to_owned()),
            text: steward_interrupt_text(&StewardInterruptText {
                ticket_id,
                title: (pool.title_of)(ticket_id),
                kind,
                body: &interrupt.body,
                keep_talking: kind == "checkpoint" && (pool.keep_talking)(ticket_id),
                may_close: pool.may_close,
                remaining: pool.budget.saturating_sub(used),
                budget: pool.budget,
            }),
        });
    }
    if let Some(head) = pool.merge_queue.first()
        && head.state == MergeQueueState::Stalled
    {
        items.push(StewardItem {
            key: format!("merge-stall:{}", head.ticket_id),
            kind: StewardItemKind::MergeStall,
            ticket_id: Some(head.ticket_id.clone()),
            text: steward_merge_stall_text(
                &head.ticket_id,
                (pool.title_of)(&head.ticket_id).as_deref(),
                &pool.merge_queue[1..]
                    .iter()
                    .map(|entry| entry.ticket_id.as_str())
                    .collect::<Vec<_>>(),
            ),
        });
    }
    for ticket_id in pool.merged {
        let text = match (pool.title_of)(ticket_id) {
            Some(title) if !title.is_empty() => format!("{ticket_id} \"{title}\""),
            _ => ticket_id.clone(),
        };
        items.push(StewardItem {
            key: format!("merged:{ticket_id}"),
            kind: StewardItemKind::Merged,
            ticket_id: Some(ticket_id.clone()),
            text,
        });
    }
    if let Some(review) = pool.review {
        let (key, text) = match review {
            StewardReview::Pending => (
                "pool:review",
                "Every Ticket is done and merged; Review waits for the operator.",
            ),
            StewardReview::Approved => (
                "pool:done",
                "The operator approved Review: the pool is done.",
            ),
        };
        items.push(StewardItem {
            key: key.to_owned(),
            kind: StewardItemKind::Pool,
            ticket_id: None,
            text: text.to_owned(),
        });
    }
    items
}

/// `freshStewardItems`: which items are news to a Steward, given what it has been told: those not told
/// yet. `told` is updated in place: an item no longer offered is forgotten, so a stall that clears and
/// comes back, or an Interrupt raised again after it went, is told again; each fresh item is
/// remembered. Kept in memory only, per Steward runtime, so a restart re-delivers. A Steward's first
/// look (its start, or its re-adoption) is a `baseline`: what merged before it is no news, so it is
/// remembered as told rather than told.
pub fn fresh_steward_items(
    told: &mut HashSet<String>,
    items: &[StewardItem],
    baseline: bool,
) -> Vec<StewardItem> {
    let offered: HashSet<&str> = items.iter().map(|item| item.key.as_str()).collect();
    told.retain(|key| offered.contains(key.as_str()));
    let fresh: Vec<StewardItem> = items
        .iter()
        .filter(|item| !told.contains(&item.key))
        .cloned()
        .collect();
    for item in &fresh {
        told.insert(item.key.clone());
    }
    if baseline {
        fresh
            .into_iter()
            .filter(|item| item.kind != StewardItemKind::Merged)
            .collect()
    } else {
        fresh
    }
}

// How much of an Interrupt's body a Notice carries: a Brief is usually short, a crash body or a
// selection's grades can run long, and the whole of it is a Ticket file or a state read away.
const BODY_CHARS: usize = 1_500;

fn clip(text: &str) -> String {
    let trimmed = js::trim(text);
    let trimmed = if trimmed.is_empty() {
        "(none written)"
    } else {
        trimmed
    };
    if js::utf16_len(trimmed) <= BODY_CHARS {
        trimmed.to_owned()
    } else {
        format!(
            "{}\n... (cut short: read the Ticket file and its log for the rest)",
            js::utf16_prefix_lossy(trimmed, BODY_CHARS)
        )
    }
}

// The answers each kind takes, in the command's own words. Close is offered only while the pool allows
// it, and only on the kinds it may close.
fn answers_for(kind: &str, ticket_id: &str, keep_talking: bool, may_close: bool) -> String {
    let close = if may_close && STEWARD_CLOSE_KINDS.contains(&kind) {
        format!(", or close {ticket_id} <note>")
    } else {
        String::new()
    };
    match kind {
        "checkpoint" => format!(
            "answer {ticket_id} resume [note]{}{close}",
            if keep_talking {
                format!(", or keep-talking {ticket_id} <message> (its pane is still alive)")
            } else {
                String::new()
            }
        ),
        "merge-approval" => {
            format!("answer {ticket_id} approve [note], or answer {ticket_id} reject [note]")
        }
        "selection" => format!("answer {ticket_id} resume <the attempt number to merge>"),
        "config" => format!("reassign {ticket_id} field=value..., then answer {ticket_id} resume"),
        "merge-conflict" => {
            format!("answer {ticket_id} resume (re-attempts the merge){close}")
        }
        _ => format!("answer {ticket_id} resume [note]"),
    }
}

/// What `steward_interrupt_text` renders.
pub struct StewardInterruptText<'a> {
    pub ticket_id: &'a str,
    pub title: Option<String>,
    pub kind: &'a str,
    pub body: &'a str,
    pub keep_talking: bool,
    pub may_close: bool,
    pub remaining: u64,
    pub budget: u64,
}

/// `stewardInterruptText`: the Notice that tells the Steward a Ticket waits at an Interrupt.
pub fn steward_interrupt_text(params: &StewardInterruptText<'_>) -> String {
    let ticket_id = params.ticket_id;
    let title = match &params.title {
        Some(title) if !title.is_empty() => format!(" (\"{title}\")"),
        _ => String::new(),
    };
    let lines = [
        format!(
            "Ticket {ticket_id}{title} is waiting at a {} Interrupt.",
            params.kind
        ),
        format!(
            "{}:",
            if params.kind == "checkpoint" {
                "Brief"
            } else {
                "Body"
            }
        ),
        clip(params.body),
        format!(
            "Answers: {}; or leave {ticket_id} <note> for the operator.",
            answers_for(
                params.kind,
                ticket_id,
                params.keep_talking,
                params.may_close
            )
        ),
        if params.remaining > 0 {
            format!(
                "Steward budget on {ticket_id}: {} of {} answers left.",
                params.remaining, params.budget
            )
        } else {
            format!(
                "Steward budget on {ticket_id} is spent ({} of {}): leave it to the operator with a note.",
                params.budget, params.budget
            )
        },
    ];
    lines.join("\n")
}

/// `stewardMergeStallText`: the Notice that tells the Steward the Merge queue head is stalled.
pub fn steward_merge_stall_text(ticket_id: &str, title: Option<&str>, behind: &[&str]) -> String {
    let title = match title {
        Some(title) if !title.is_empty() => format!(" (\"{title}\")"),
        _ => String::new(),
    };
    [
        format!(
            "The Merge queue head, Ticket {ticket_id}{title}, is stalled: it is done, its branch has not landed, and no resolver runs and no Interrupt is raised for it. Nothing in the pool moves until it lands."
        ),
        if behind.is_empty() {
            "Nothing else waits behind it.".to_owned()
        } else {
            format!("Waiting behind it: {}.", behind.join(", "))
        },
        "There is no Interrupt to answer. Read its Ticket log and branch, and tell the operator in this pane what you found; merge it by hand only if the operator's own words allowed you to.".to_owned(),
    ]
    .join("\n")
}

/// `stewardBatchText`: one Turn telling the Steward everything delivered together: what asks for an
/// act first, then, tersely, what merged since its last Notice and where the pool stands.
pub fn steward_batch_text(items: &[StewardItem]) -> String {
    let mut sections: Vec<String> = items
        .iter()
        .filter(|item| {
            matches!(
                item.kind,
                StewardItemKind::Interrupt | StewardItemKind::MergeStall
            )
        })
        .map(|item| item.text.clone())
        .collect();
    let merged: Vec<&str> = items
        .iter()
        .filter(|item| item.kind == StewardItemKind::Merged)
        .map(|item| item.text.as_str())
        .collect();
    if !merged.is_empty() {
        sections.push(format!(
            "Merged since your last Notice: {}.",
            merged.join(", ")
        ));
    }
    sections.extend(
        items
            .iter()
            .filter(|item| item.kind == StewardItemKind::Pool)
            .map(|item| item.text.clone()),
    );
    if sections.len() == 1 {
        return format!("Pool news for the Steward:\n\n{}", sections[0]);
    }
    format!(
        "Pool news for the Steward ({} items):\n\n{}",
        sections.len(),
        sections.join("\n\n---\n\n")
    )
}

// A shell word: bare when it is plainly safe, single-quoted otherwise.
fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    if plain {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// `stewardCommand`: the exact invocation the teaching names: this binary's `steward` subcommand (an
/// ADR-0036 change from the TypeScript's `bun engine/steward-cli.ts`), the pool directory (how the
/// command finds the Console again after a Restart moved its port), the Console's URL when the engine
/// knows it, and the Steward's own Conversation id, which every route checks against the live Steward.
pub fn steward_command(exe: &str, pool_dir: &str, url: Option<&str>, conversation: &str) -> String {
    let mut words = vec![
        shell_word(exe),
        "steward".to_owned(),
        "--pool".to_owned(),
        shell_word(pool_dir),
    ];
    if let Some(url) = url.filter(|url| !url.is_empty()) {
        words.push("--url".to_owned());
        words.push(shell_word(url));
    }
    words.push("--as".to_owned());
    words.push(shell_word(conversation));
    words.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(value: Value) -> PoolConfig {
        match value {
            Value::Object(map) => PoolConfig::from_map(map),
            _ => unreachable!(),
        }
    }

    fn refusal(value: Value) -> String {
        check_steward_config(Some(&value)).unwrap_err().0
    }

    // steward.test.ts: the steward entry of console.json
    #[test]
    fn defaults_the_budget_to_5_and_reads_one_that_is_set() {
        assert_eq!(steward_budget_of(&PoolConfig::default()), 5);
        assert_eq!(
            steward_budget_of(&config(json!({ "steward": { "budget": 2 } }))),
            2
        );
    }

    #[test]
    fn refuses_a_budget_that_is_not_a_whole_number_of_1_or_more_and_an_assign_that_is_not_strings()
    {
        assert_eq!(
            refusal(json!({ "budget": 0 })),
            "pool config: steward.budget must be a whole number, 1 or more"
        );
        assert!(refusal(json!({ "budget": 1.5 })).contains("steward.budget"));
        assert!(refusal(json!({ "budget": "3" })).contains("steward.budget"));
        assert!(refusal(json!({ "budget": null })).contains("steward.budget"));
        assert_eq!(
            refusal(json!({ "assign": { "model": 4 } })),
            "pool config: steward.assign.model must be a string"
        );
        assert_eq!(
            refusal(json!({ "assign": [] })),
            "pool config: steward.assign must be an object"
        );
        assert_eq!(
            refusal(json!("x")),
            "pool config: steward must be an object"
        );
        assert!(check_steward_config(None).is_ok());
        assert!(
            check_steward_config(Some(&json!({ "budget": 3, "assign": { "model": "m" } }))).is_ok()
        );
    }

    #[test]
    fn reads_may_close_as_off_unless_it_is_true_and_refuses_one_that_is_not_a_boolean() {
        assert!(!steward_may_close_of(&PoolConfig::default()));
        assert!(!steward_may_close_of(&config(
            json!({ "steward": { "budget": 2 } })
        )));
        assert!(!steward_may_close_of(&config(
            json!({ "steward": { "mayClose": false } })
        )));
        assert!(steward_may_close_of(&config(
            json!({ "steward": { "mayClose": true } })
        )));
        assert_eq!(
            refusal(json!({ "mayClose": "yes" })),
            "pool config: steward.mayClose must be true or false"
        );
        assert!(check_steward_config(Some(&json!({ "budget": 2, "mayClose": true }))).is_ok());
    }

    #[test]
    fn reads_the_stewards_assignment_fields() {
        assert_eq!(steward_assign_of(&PoolConfig::default()), None);
        assert_eq!(
            steward_assign_of(&config(
                json!({ "steward": { "assign": { "model": "judge", "harness": "claude" } } })
            )),
            Some(StewardAssign {
                harness: Some("claude".into()),
                model: Some("judge".into()),
                effort: None,
                drivers: None,
            })
        );
    }

    // steward.test.ts: what the Steward is told about
    fn interrupt(ticket_id: &str, kind: &str, body: &str) -> Interrupt {
        let kind = match kind {
            "checkpoint" => ac_protocol::InterruptKind::Checkpoint,
            "review" => ac_protocol::InterruptKind::Review,
            "persistence" => ac_protocol::InterruptKind::Persistence,
            "merge-conflict" => ac_protocol::InterruptKind::MergeConflict,
            "crash" => ac_protocol::InterruptKind::Crash,
            "merge-approval" => ac_protocol::InterruptKind::MergeApproval,
            "config" => ac_protocol::InterruptKind::Config,
            "deadlock" => ac_protocol::InterruptKind::Deadlock,
            other => panic!("no kind {other}"),
        };
        Interrupt {
            ticket_id: ticket_id.to_owned(),
            kind,
            body: body.to_owned(),
            candidates: None,
            steward_note: None,
        }
    }

    fn queue(entries: &[(&str, MergeQueueState)]) -> Vec<MergeQueueEntry> {
        entries
            .iter()
            .map(|(id, state)| MergeQueueEntry {
                ticket_id: (*id).to_owned(),
                state: *state,
            })
            .collect()
    }

    struct View {
        interrupts: Vec<Interrupt>,
        conversations: HashSet<String>,
        queued: HashSet<String>,
        left: Vec<&'static str>,
        keep_talking: Vec<&'static str>,
        used: Vec<(&'static str, u64)>,
        may_close: bool,
        merge_queue: Vec<MergeQueueEntry>,
        merged: Vec<String>,
        review: Option<StewardReview>,
    }

    fn view() -> View {
        View {
            interrupts: Vec::new(),
            conversations: HashSet::new(),
            queued: HashSet::new(),
            left: Vec::new(),
            keep_talking: Vec::new(),
            used: Vec::new(),
            may_close: false,
            merge_queue: Vec::new(),
            merged: Vec::new(),
            review: None,
        }
    }

    fn items_of(v: &View) -> Vec<StewardItem> {
        let title_of = |id: &str| Some(format!("title of {id}"));
        let left = |id: &str, _: &str| v.left.contains(&id);
        let keep_talking = |id: &str| v.keep_talking.contains(&id);
        let used = |id: &str| v.used.iter().find(|(i, _)| *i == id).map_or(0, |(_, n)| *n);
        steward_items(&StewardPoolView {
            interrupts: &v.interrupts,
            title_of: &title_of,
            conversations: &v.conversations,
            queued: &v.queued,
            left: &left,
            keep_talking: &keep_talking,
            budget: 5,
            used: &used,
            may_close: v.may_close,
            merge_queue: &v.merge_queue,
            merged: &v.merged,
            review: v.review,
        })
    }

    #[test]
    fn tells_every_pending_ticket_interrupt_but_review_persistence_a_conversations_a_queued_one_and_a_left_one()
     {
        let mut v = view();
        v.interrupts = vec![
            interrupt("01", "checkpoint", "ask me"),
            interrupt("REVIEW", "review", "review"),
            interrupt("PERSISTENCE", "persistence", "disk"),
            interrupt("conv-1", "merge-conflict", "conflict"),
            interrupt("02", "crash", "crashed"),
            interrupt("03", "merge-approval", "staged"),
            interrupt("04", "config", "no model"),
        ];
        v.conversations.insert("conv-1".into());
        v.queued.insert("02".into());
        v.left = vec!["04"];
        v.keep_talking = vec!["01"];
        v.used = vec![("03", 5), ("01", 2)];
        let items = items_of(&v);
        assert_eq!(
            items.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(),
            ["interrupt:01:checkpoint", "interrupt:03:merge-approval"]
        );
        let checkpoint = &items[0].text;
        assert!(
            checkpoint
                .contains("Ticket 01 (\"title of 01\") is waiting at a checkpoint Interrupt.")
        );
        assert!(checkpoint.contains("Brief:\nask me"));
        assert!(checkpoint.contains("keep-talking 01 <message> (its pane is still alive)"));
        assert!(checkpoint.contains("Steward budget on 01: 3 of 5 answers left."));
        let approval = &items[1].text;
        assert!(approval.contains("answer 03 approve [note], or answer 03 reject [note]"));
        assert!(approval.contains("Steward budget on 03 is spent (5 of 5)"));
    }

    #[test]
    fn never_offers_adopt_even_on_a_checkpoint_naming_candidates_with_close_on() {
        let mut v = view();
        let mut round = interrupt("01", "checkpoint", "a round paused");
        round.candidates = Some(vec![2, 3]);
        v.interrupts = vec![round];
        v.may_close = true;
        let items = items_of(&v);
        assert!(
            items[0]
                .text
                .contains("Answers: answer 01 resume [note], or close 01 <note>;")
        );
        assert!(!items[0].text.contains("adopt"));
    }

    #[test]
    fn offers_close_on_a_checkpoint_and_a_merge_conflict_only_while_the_pool_lets_the_steward_close()
     {
        let mut v = view();
        v.interrupts = vec![
            interrupt("01", "checkpoint", "ask me"),
            interrupt("02", "merge-conflict", "conflict"),
            interrupt("03", "deadlock", "blocker 09 was closed"),
            interrupt("04", "crash", "died"),
        ];
        for item in items_of(&v) {
            assert!(!item.text.contains("close "));
        }
        v.may_close = true;
        let items = items_of(&v);
        assert!(
            items[0]
                .text
                .contains("Answers: answer 01 resume [note], or close 01 <note>;")
        );
        assert!(
            items[1]
                .text
                .contains("answer 02 resume (re-attempts the merge), or close 02 <note>;")
        );
        assert!(!items[2].text.contains("close 03"));
        assert!(!items[3].text.contains("close 04"));
    }

    #[test]
    fn tells_a_stalled_merge_queue_head_and_only_the_head() {
        let mut v = view();
        v.merge_queue = queue(&[
            ("05", MergeQueueState::NeedsYou),
            ("06", MergeQueueState::Stalled),
        ]);
        assert_eq!(items_of(&v), Vec::<StewardItem>::new());
        v.merge_queue = queue(&[
            ("05", MergeQueueState::Stalled),
            ("06", MergeQueueState::Stalled),
        ]);
        let items = items_of(&v);
        assert_eq!(items[0].key, "merge-stall:05");
        assert!(items[0].text.contains("The Merge queue head, Ticket 05"));
        assert!(items[0].text.contains("Waiting behind it: 06."));
    }

    #[test]
    fn tells_what_merged_and_where_review_stands_only_informing() {
        let mut v = view();
        v.merged = vec!["01".into(), "03".into()];
        v.review = Some(StewardReview::Pending);
        let items = items_of(&v);
        let seen: Vec<(&str, &str, Option<&str>)> = items
            .iter()
            .map(|i| (i.key.as_str(), i.kind.as_str(), i.ticket_id.as_deref()))
            .collect();
        assert_eq!(
            seen,
            [
                ("merged:01", "steward-merged", Some("01")),
                ("merged:03", "steward-merged", Some("03")),
                ("pool:review", "steward-pool", None),
            ]
        );
        let mut approved = view();
        approved.review = Some(StewardReview::Approved);
        assert_eq!(
            items_of(&approved)[0].text,
            "The operator approved Review: the pool is done."
        );
    }

    #[test]
    fn batches_news_into_one_turn_what_asks_for_an_act_first_then_one_line_of_merges_then_the_pool()
    {
        let mut v = view();
        v.interrupts = vec![interrupt("02", "crash", "died")];
        v.merged = vec!["01".into(), "03".into()];
        let text = steward_batch_text(&items_of(&v));
        assert!(text.starts_with("Pool news for the Steward (2 items):\n\nTicket 02"));
        assert!(
            text.ends_with(r#"Merged since your last Notice: 01 "title of 01", 03 "title of 03"."#)
        );
        let mut merged_only = view();
        merged_only.merged = vec!["01".into()];
        assert_eq!(
            steward_batch_text(&items_of(&merged_only)),
            "Pool news for the Steward:\n\nMerged since your last Notice: 01 \"title of 01\"."
        );
    }

    #[test]
    fn takes_what_merged_before_a_stewards_first_look_as_told_and_tells_later_merges() {
        let mut told = HashSet::new();
        let mut v = view();
        v.merged = vec!["01".into()];
        v.merge_queue = queue(&[("02", MergeQueueState::Stalled)]);
        let keys = |items: Vec<StewardItem>| items.into_iter().map(|i| i.key).collect::<Vec<_>>();
        assert_eq!(
            keys(fresh_steward_items(&mut told, &items_of(&v), true)),
            ["merge-stall:02"]
        );
        let mut later = view();
        later.merged = vec!["01".into(), "02".into()];
        assert_eq!(
            keys(fresh_steward_items(&mut told, &items_of(&later), false)),
            ["merged:02"]
        );
    }

    #[test]
    fn tells_each_item_once_and_again_once_it_went_and_came_back() {
        let mut told = HashSet::new();
        let mut v = view();
        v.merge_queue = queue(&[("05", MergeQueueState::Stalled)]);
        let stalled = items_of(&v);
        let first = fresh_steward_items(&mut told, &stalled, false);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].key, "merge-stall:05");
        assert!(fresh_steward_items(&mut told, &stalled, false).is_empty());
        assert!(fresh_steward_items(&mut told, &[], false).is_empty());
        assert_eq!(fresh_steward_items(&mut told, &stalled, false).len(), 1);
    }

    #[test]
    fn clips_a_long_body_and_marks_an_empty_one() {
        let mut v = view();
        v.interrupts = vec![
            interrupt("01", "crash", &"x".repeat(1_600)),
            interrupt("02", "crash", "  \n "),
        ];
        let items = items_of(&v);
        assert!(items[0].text.contains(&format!(
            "{}\n... (cut short: read the Ticket file and its log for the rest)",
            "x".repeat(1_500)
        )));
        assert!(items[1].text.contains("Body:\n(none written)"));
    }

    // steward.test.ts: the Steward's command, here this binary's subcommand
    #[test]
    fn names_this_binary_its_steward_subcommand_the_pool_and_the_steward_quoting_what_needs_it() {
        assert_eq!(
            steward_command(
                "/home/me/bin/agent-console",
                "/work/my pool",
                Some("http://localhost:8790"),
                "conv-3"
            ),
            "/home/me/bin/agent-console steward --pool '/work/my pool' --url http://localhost:8790 --as conv-3"
        );
        assert_eq!(
            steward_command("/b", "/p", None, "it's"),
            "/b steward --pool /p --as 'it'\\''s'"
        );
    }
}
