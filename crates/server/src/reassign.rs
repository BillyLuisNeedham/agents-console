//! Reassign (issue #126, reassign.ts): the operator changing a Ticket's Assignment from the Console by
//! writing that Ticket's `assign` entry in console.json, one Ticket from its Detail or many from the
//! Pool settings. The engine picks the write up at its next Config reload (ADR-0018), the same seam a
//! hand edit uses; nothing here touches the engine's scheduling.
//!
//! This module owns the per-ticket eligibility and provenance the snapshot carries, and the validated,
//! atomic write of `assign` entries. Only the server uses it, so it lives here rather than in ac-engine.

use std::collections::HashSet;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use ac_core::assignment::{
    Assignment, Assignments, assignment_view_of, engine_ticket_build_id, resolve_pool_assignments,
};
use ac_core::config::PoolConfig;
use ac_core::harness::{Harnesses, effort_applies, pool_harness_mode};
use ac_core::js;
use ac_core::pool::TicketMarker;
use ac_core::pool_settings::{read_pool_settings, require_known_harness, write_config_atomically};
use ac_protocol::{
    AssignmentSource, AssignmentSources, AssignmentView, ReassignSkipped, TicketReassignView,
    TicketStatus,
};

const ASSIGNMENT_FIELDS: [&str; 4] = ["harness", "model", "effort", "drivers"];

// The view a ticket the resolver never reached gets: no layer answered for it.
const NO_SOURCES: AssignmentSources = AssignmentSources {
    harness: AssignmentSource::Unset,
    model: AssignmentSource::Unset,
    effort: AssignmentSource::Unset,
    drivers: AssignmentSource::Unset,
};

/// Why a Reassign write did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReassignError {
    /// reassign.ts `ReassignRefusal`: a request this module refused (400 on the route, 409 on the
    /// Steward's).
    Refusal(String),
    /// reassign.ts `ConfigUnreadableError`: console.json no longer parses (500).
    ConfigUnreadable(String),
    /// Anything else thrown on the way, a write that failed (500).
    Failed(String),
}

impl ReassignError {
    pub fn message(&self) -> &str {
        match self {
            ReassignError::Refusal(m)
            | ReassignError::ConfigUnreadable(m)
            | ReassignError::Failed(m) => m,
        }
    }
}

fn refusal(message: impl Into<String>) -> ReassignError {
    ReassignError::Refusal(message.into())
}

/// One ticket's Reassign row: the wire view, plus the Assignment resolved from the config file as it
/// stands now. `assignment` is `None` for a ticket that is not eligible, because there the engine's own
/// frozen record is the truth.
#[derive(Debug, Clone, PartialEq)]
pub struct TicketReassignEntry {
    pub reassign: TicketReassignView,
    pub assignment: Option<AssignmentView>,
}

/// What every Reassign row is judged against: the pool's markers and harness table, and the engine's
/// last snapshot's view of which tickets run, their statuses and their resolved Assignments.
pub struct ReassignContext<'a> {
    pub markers: &'a [TicketMarker],
    pub harnesses: &'a Harnesses,
    /// The ticket ids with an Attempt in flight, from the engine's snapshot.
    pub live_attempts: &'a HashSet<String>,
    pub statuses: &'a IndexMap<String, TicketStatus>,
    /// The engine's own resolved Assignment per id (Conversations included), for the frozen seed the
    /// dry run shares with the engine's own reload.
    pub engine_assignments: &'a IndexMap<String, AssignmentView>,
}

// The wire renders an unassigned field as null; the resolver's own record spells it as the empty
// string.
fn assignment_of(view: &AssignmentView) -> Assignment {
    Assignment {
        harness: view.harness.clone().unwrap_or_default(),
        model: view.model.clone().unwrap_or_default(),
        effort: view.effort.clone().filter(|effort| !effort.is_empty()),
        drivers: view.drivers.clone(),
        verify: None,
    }
}

/// What the engine's next reload will not re-resolve, seeded with what it holds for them now: every
/// Conversation's Assignment (the snapshot's assignments that are not tickets), and the frozen tickets.
/// An enlisted ticket is frozen for as long as the engine holds its pane, which the server cannot see
/// the end of, so it is treated as frozen throughout when `enlisted` asks.
fn frozen_seed(context: &ReassignContext<'_>, enlisted: bool) -> Assignments {
    let mut seed = Assignments::new();
    let ticket_ids: HashSet<&str> = context.markers.iter().map(|m| m.id.as_str()).collect();
    for (id, view) in context.engine_assignments {
        if !ticket_ids.contains(id.as_str()) {
            seed.insert(id.clone(), assignment_of(view));
        }
    }
    for marker in context.markers {
        let frozen = context.live_attempts.contains(&marker.id)
            || (enlisted && marker.enlisted_from.is_some());
        if !frozen {
            continue;
        }
        if let Some(view) = context.engine_assignments.get(&marker.id) {
            seed.insert(marker.id.clone(), assignment_of(view));
        }
    }
    seed
}

// `config.assign?.[id]`, on an object or (written by hand) an array.
fn assign_entry<'a>(config: &'a PoolConfig, id: &str) -> Option<&'a Value> {
    match config.get("assign")? {
        Value::Object(entries) => entries.get(id),
        Value::Array(items) => js::array_index(id).and_then(|index| items.get(index as usize)),
        _ => None,
    }
}

// A verify the file actually carries; anything else reads as absent here.
fn verify_of(entry: Option<&Value>) -> Option<u64> {
    let verify = entry?.get("verify")?;
    let number = js::number_of(verify)?;
    (number.is_finite() && number.fract() == 0.0 && number >= 1.0).then_some(number as u64)
}

/// Whether a write to this ticket's assign entry would reach the run, and the one line the Detail
/// shows when it would not. Grader and head-to-head tickets are the engine's own; an Attempt in flight
/// froze its Assignment and a done ticket will not run again. Enlisted is a note, not a refusal.
fn eligibility_of(
    marker: &TicketMarker,
    live_attempts: &HashSet<String>,
    status: TicketStatus,
) -> (bool, Option<String>) {
    if engine_ticket_build_id(&marker.id).is_some() {
        return (
            false,
            Some("the engine runs this one and assigns it from its build ticket".to_owned()),
        );
    }
    if live_attempts.contains(&marker.id) {
        return (false, Some("an Attempt is running".to_owned()));
    }
    if matches!(status, TicketStatus::Done | TicketStatus::Closed) {
        return (false, Some(status.as_str().to_owned()));
    }
    if marker.enlisted_from.is_some() {
        return (
            true,
            Some(
                "enlisted: only the harness can change, and it waits until the engine releases it"
                    .to_owned(),
            ),
        );
    }
    (true, None)
}

/// Every ticket's Reassign row, from the config file rather than the engine's session, so a saved
/// Reassign shows on the card at once. A config that will not parse (`config_error`) makes every ticket
/// ineligible with that error as the reason. A ticket the file does not resolve is ineligible on its
/// own, with its own reason, and every other ticket stays offered (issue #159).
pub fn reassign_views(
    context: &ReassignContext<'_>,
    config: Option<&PoolConfig>,
    config_error: Option<&str>,
) -> IndexMap<String, TicketReassignEntry> {
    let resolved = match (config, config_error) {
        (Some(config), None) => Some(resolve_pool_assignments(
            context.markers,
            config,
            context.harnesses,
            Some(&frozen_seed(context, true)),
        )),
        _ => None,
    };
    let mode = pool_harness_mode(config.and_then(PoolConfig::terminal_text));
    let mut views = IndexMap::new();
    for marker in context.markers {
        let sources = resolved
            .as_ref()
            .and_then(|r| r.sources.get(&marker.id))
            .cloned()
            .unwrap_or(NO_SOURCES);
        let own = resolved.as_ref().and_then(|r| r.failures.get(&marker.id));
        let (eligible, reason) = if let Some(failure) = config_error {
            (
                false,
                Some(format!("the pool config does not resolve: {failure}")),
            )
        } else if let Some(own) = own {
            (
                false,
                Some(format!(
                    "the pool config does not resolve: {own} (the engine keeps the whole pool on its last good config until this resolves)"
                )),
            )
        } else {
            eligibility_of(
                marker,
                context.live_attempts,
                context
                    .statuses
                    .get(&marker.id)
                    .copied()
                    .unwrap_or(TicketStatus::Ready),
            )
        };
        // An enlisted ticket's verify is stripped by the engine (issue #101), so whatever the file says
        // is not this ticket's verify count.
        let verify = if marker.enlisted_from.is_some() {
            None
        } else {
            config.and_then(|config| verify_of(assign_entry(config, &marker.id)))
        };
        let assignment = resolved
            .as_ref()
            .and_then(|r| r.assignments.get(&marker.id))
            .filter(|_| eligible)
            .map(|assignment| {
                assignment_view_of(
                    assignment,
                    effort_applies(context.harnesses, &assignment.harness, mode),
                )
            });
        views.insert(
            marker.id.clone(),
            TicketReassignEntry {
                reassign: TicketReassignView {
                    eligible,
                    reason,
                    verify,
                    sources,
                },
                assignment,
            },
        );
    }
    views
}

/// A Reassign write's answer, less the snapshot the route adds.
#[derive(Debug, Clone, PartialEq)]
pub struct ReassignOutcome {
    pub applied: Vec<String>,
    pub skipped: Vec<ReassignSkipped>,
}

// The tri-state fields, validated: each assignment field absent (leave alone), cleared (None) or set;
// verify absent, cleared, or a whole number as the body wrote it.
struct Fields {
    strings: Vec<(&'static str, Option<String>)>,
    verify: Option<Option<Value>>,
}

impl Fields {
    fn has(&self, field: &str) -> bool {
        if field == "verify" {
            return self.verify.is_some();
        }
        self.strings.iter().any(|(name, _)| *name == field)
    }
}

// The ids the body named, checked for shape here so every caller gets the same refusal.
fn requested_ids(tickets: Option<&Value>) -> Result<Vec<String>, ReassignError> {
    let ids = match tickets {
        Some(Value::Array(items))
            if items
                .iter()
                .all(|id| id.as_str().is_some_and(|id| !id.is_empty())) =>
        {
            items
                .iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        }
        _ => return Err(refusal("reassign: tickets must be an array of ticket ids")),
    };
    if ids.is_empty() {
        return Err(refusal("reassign: name at least one ticket"));
    }
    let mut seen = HashSet::new();
    Ok(ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect())
}

fn normalise_fields(raw: &Value, harnesses: &[String]) -> Result<Fields, ReassignError> {
    let Value::Object(raw) = raw else {
        return Err(refusal("reassign: fields must be an object"));
    };
    let mut strings = Vec::new();
    for field in ASSIGNMENT_FIELDS {
        let Some(value) = raw.get(field) else {
            continue;
        };
        match value {
            Value::Null => strings.push((field, None)),
            Value::String(text) => {
                let trimmed = js::trim(text);
                strings.push((field, (!trimmed.is_empty()).then(|| trimmed.to_owned())));
            }
            _ => {
                return Err(refusal(format!(
                    "reassign: {field} must be a string or null"
                )));
            }
        }
    }
    if let Some((_, Some(harness))) = strings.iter().find(|(name, _)| *name == "harness") {
        require_known_harness("reassign: harness", harness, harnesses)
            .map_err(|err| refusal(err.to_string()))?;
    }
    let verify = match raw.get("verify") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(value) if js::is_integer(value) && js::number_of(value).is_some_and(|n| n >= 1.0) => {
            Some(Some(value.clone()))
        }
        Some(value) => {
            return Err(refusal(format!(
                "reassign: verify must be an integer >= 1 or null (got {})",
                js::stringify(value)
            )));
        }
    };
    Ok(Fields { strings, verify })
}

// The harness is the only field an enlisted ticket can take (issue #101): a write of any other would
// sit in console.json looking applied and change nothing, so it is refused.
fn refuse_enlisted_fields(
    ids: &[String],
    fields: &Fields,
    markers: &[TicketMarker],
) -> Result<(), ReassignError> {
    let forced: Vec<&str> = ["model", "effort", "drivers", "verify"]
        .into_iter()
        .filter(|field| fields.has(field))
        .collect();
    if forced.is_empty() {
        return Ok(());
    }
    let enlisted: HashSet<&str> = markers
        .iter()
        .filter(|m| m.enlisted_from.is_some())
        .map(|m| m.id.as_str())
        .collect();
    for id in ids {
        if enlisted.contains(id.as_str()) {
            return Err(refusal(format!(
                "reassign: ticket '{id}' is enlisted: only harness can be reassigned (this request names {})",
                forced.join(", ")
            )));
        }
    }
    Ok(())
}

// The config the write will put on disk: the file as read, with only the named tickets' entries merged.
// An entry left with no fields is removed, and an `assign` map left with no entries goes with it.
fn merged_config(config: &PoolConfig, ids: &[String], fields: &Fields) -> PoolConfig {
    let mut assign: Map<String, Value> = match config.get("assign") {
        Some(Value::Object(entries)) => entries.clone(),
        _ => Map::new(),
    };
    for id in ids {
        let mut entry: Map<String, Value> = match assign.get(id) {
            Some(Value::Object(entry)) => entry.clone(),
            _ => Map::new(),
        };
        for (field, value) in &fields.strings {
            match value {
                None => {
                    entry.shift_remove(*field);
                }
                Some(value) => {
                    entry.insert((*field).to_owned(), Value::from(value.clone()));
                }
            }
        }
        match &fields.verify {
            None => {}
            Some(None) => {
                entry.shift_remove("verify");
            }
            Some(Some(verify)) => {
                entry.insert("verify".to_owned(), verify.clone());
            }
        }
        if entry.is_empty() {
            assign.shift_remove(id);
        } else {
            assign.insert(id.clone(), Value::Object(entry));
        }
    }
    let mut next = config.clone();
    if assign.is_empty() {
        next.remove("assign");
    } else {
        next.set("assign", Value::Object(assign));
    }
    next
}

// The proposed file, resolved before it is written: only a failure the write itself brings is refused,
// and a named ticket left with no harness (or, unless enlisted, no model) is refused naming it.
fn dry_run(
    current: &PoolConfig,
    next: &PoolConfig,
    ids: &[String],
    context: &ReassignContext<'_>,
) -> Result<(), ReassignError> {
    let seed = frozen_seed(context, false);
    let resolve = |file: &PoolConfig| {
        resolve_pool_assignments(context.markers, file, context.harnesses, Some(&seed))
    };
    let resolved = resolve(next);
    if !resolved.failures.is_empty() {
        let before = resolve(current).failures;
        for (id, reason) in &resolved.failures {
            if before.contains_key(id) {
                continue;
            }
            return Err(refusal(format!(
                "reassign: ticket '{id}' would not resolve: {reason}"
            )));
        }
    }
    let enlisted: HashSet<&str> = context
        .markers
        .iter()
        .filter(|m| m.enlisted_from.is_some())
        .map(|m| m.id.as_str())
        .collect();
    for id in ids {
        let Some(assignment) = resolved.assignments.get(id) else {
            continue;
        };
        if assignment.harness.is_empty() {
            return Err(refusal(format!(
                "reassign: ticket '{id}' would be left with no harness (set one, or leave the field alone so it follows the pool defaults)"
            )));
        }
        if assignment.model.is_empty() && !enlisted.contains(id.as_str()) {
            return Err(refusal(format!(
                "reassign: ticket '{id}' would be left with no model (set one, or leave the field alone so it follows the pool defaults)"
            )));
        }
    }
    Ok(())
}

/// Write the named tickets' `assign` entries, or refuse the whole request. `tickets` and `fields` are
/// the body's as sent (`fields` already defaulted to `{}` when absent or null). Validation covers the
/// request as a whole and writes nothing on a refusal; a ticket that stopped being eligible is left
/// alone and named in `skipped`; the write is one atomic replace of the file read fresh from disk.
pub fn write_reassign(
    pool_dir: &str,
    tickets: Option<&Value>,
    fields: &Value,
    context: &ReassignContext<'_>,
) -> Result<ReassignOutcome, ReassignError> {
    let ids = requested_ids(tickets)?;
    let fields = normalise_fields(fields, &context.harnesses.names())?;
    let config = read_pool_settings(pool_dir)
        .map_err(|err| ReassignError::ConfigUnreadable(err.to_string()))?
        .config;
    let views = reassign_views(context, Some(&config), None);
    let mut applied = Vec::new();
    let mut skipped = Vec::new();
    for id in &ids {
        let Some(view) = views.get(id) else {
            return Err(refusal(format!("reassign: unknown ticket '{id}'")));
        };
        if view.reassign.eligible {
            applied.push(id.clone());
        } else {
            skipped.push(ReassignSkipped {
                id: id.clone(),
                reason: view
                    .reassign
                    .reason
                    .clone()
                    .unwrap_or_else(|| "not reassignable".to_owned()),
            });
        }
    }
    refuse_enlisted_fields(&applied, &fields, context.markers)?;
    if applied.is_empty() {
        return Ok(ReassignOutcome { applied, skipped });
    }
    let next = merged_config(&config, &applied, &fields);
    dry_run(&config, &next, &applied, context)?;
    write_config_atomically(pool_dir, &next)
        .map_err(|err| ReassignError::Failed(err.to_string()))?;
    Ok(ReassignOutcome { applied, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ac_core::pool::load_pool_tickets;
    use serde_json::json;
    use std::path::Path;

    struct Pool {
        dir: tempfile::TempDir,
    }

    impl Pool {
        fn new(tickets: &[(&str, &str)], config: Value) -> Pool {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(dir.path().join("issues")).unwrap();
            for (id, extra) in tickets {
                std::fs::write(
                    dir.path().join(format!("issues/{id}-t.md")),
                    format!(
                        "<!-- state: id={id} blocked-by=none status=ready{extra} -->\n\n# T {id}\n"
                    ),
                )
                .unwrap();
            }
            std::fs::write(
                dir.path().join("console.json"),
                js::stringify_pretty(&config),
            )
            .unwrap();
            Pool { dir }
        }

        fn path(&self) -> String {
            self.dir.path().to_string_lossy().into_owned()
        }

        fn markers(&self) -> Vec<TicketMarker> {
            load_pool_tickets(Path::new(&self.path()), false).unwrap()
        }

        fn config(&self) -> Value {
            serde_json::from_str(
                &std::fs::read_to_string(self.dir.path().join("console.json")).unwrap(),
            )
            .unwrap()
        }
    }

    fn write(pool: &Pool, tickets: Value, fields: Value) -> Result<ReassignOutcome, ReassignError> {
        write_with(pool, tickets, fields, &HashSet::new(), &IndexMap::new())
    }

    fn write_with(
        pool: &Pool,
        tickets: Value,
        fields: Value,
        live: &HashSet<String>,
        statuses: &IndexMap<String, TicketStatus>,
    ) -> Result<ReassignOutcome, ReassignError> {
        let markers = pool.markers();
        let harnesses = Harnesses::defaults();
        let engine = IndexMap::new();
        let context = ReassignContext {
            markers: &markers,
            harnesses: &harnesses,
            live_attempts: live,
            statuses,
            engine_assignments: &engine,
        };
        write_reassign(&pool.path(), Some(&tickets), &fields, &context)
    }

    fn defaults() -> Value {
        json!({ "defaults": { "harness": "claude", "model": "m" } })
    }

    #[test]
    fn writes_the_named_fields_and_leaves_the_rest_of_the_file_alone() {
        let pool = Pool::new(
            &[("01", ""), ("02", "")],
            json!({ "port": 8787, "defaults": { "harness": "claude", "model": "m" } }),
        );
        let outcome = write(
            &pool,
            json!(["01", "01"]),
            json!({ "model": " x-model ", "verify": 2 }),
        )
        .unwrap();
        assert_eq!(
            outcome,
            ReassignOutcome {
                applied: vec!["01".into()],
                skipped: vec![]
            }
        );
        assert_eq!(
            pool.config(),
            json!({ "port": 8787, "defaults": { "harness": "claude", "model": "m" }, "assign": { "01": { "model": "x-model", "verify": 2 } } })
        );
        // Clearing every field drops the entry, and the map with it.
        write(
            &pool,
            json!(["01"]),
            json!({ "model": null, "verify": null }),
        )
        .unwrap();
        assert_eq!(
            pool.config(),
            json!({ "port": 8787, "defaults": { "harness": "claude", "model": "m" } })
        );
    }

    #[test]
    fn refuses_a_malformed_request_naming_what_is_wrong() {
        let pool = Pool::new(&[("01", "")], defaults());
        let refused = |tickets: Value, fields: Value| {
            write(&pool, tickets, fields)
                .unwrap_err()
                .message()
                .to_owned()
        };
        assert_eq!(
            refused(json!("01"), json!({})),
            "reassign: tickets must be an array of ticket ids"
        );
        assert_eq!(
            refused(json!([]), json!({})),
            "reassign: name at least one ticket"
        );
        assert_eq!(
            refused(json!(["01"]), json!([])),
            "reassign: fields must be an object"
        );
        assert_eq!(
            refused(json!(["01"]), json!({ "model": 5 })),
            "reassign: model must be a string or null"
        );
        assert_eq!(
            refused(json!(["01"]), json!({ "verify": 1.5 })),
            "reassign: verify must be an integer >= 1 or null (got 1.5)"
        );
        assert_eq!(
            refused(json!(["zz"]), json!({})),
            "reassign: unknown ticket 'zz'"
        );
        assert!(
            refused(json!(["01"]), json!({ "harness": "nope" }))
                .starts_with("reassign: harness names unknown harness 'nope'")
        );
        let no_model = Pool::new(
            &[("01", "")],
            json!({ "defaults": { "harness": "claude" } }),
        );
        assert_eq!(
            write(&no_model, json!(["01"]), json!({ "model": "" }))
                .unwrap_err()
                .message(),
            "reassign: ticket '01' would be left with no model (set one, or leave the field alone so it follows the pool defaults)"
        );
    }

    #[test]
    fn skips_a_ticket_that_is_no_longer_eligible() {
        let pool = Pool::new(&[("01", ""), ("02", "")], defaults());
        let live: HashSet<String> = ["02".to_owned()].into();
        let outcome = write_with(
            &pool,
            json!(["01", "02"]),
            json!({ "model": "x" }),
            &live,
            &IndexMap::new(),
        )
        .unwrap();
        assert_eq!(outcome.applied, vec!["01".to_owned()]);
        assert_eq!(
            outcome.skipped,
            vec![ReassignSkipped {
                id: "02".into(),
                reason: "an Attempt is running".into()
            }]
        );
    }

    #[test]
    fn judges_each_ticket_and_names_where_its_fields_came_from() {
        let pool = Pool::new(
            &[("01", ""), ("02", "")],
            json!({ "defaults": { "harness": "claude", "model": "m" }, "assign": { "02": { "model": "x", "verify": 3 } } }),
        );
        let markers = pool.markers();
        let harnesses = Harnesses::defaults();
        let mut statuses = IndexMap::new();
        statuses.insert("01".to_owned(), TicketStatus::Done);
        let config = ac_core::config::read_config(&pool.path()).unwrap();
        let context = ReassignContext {
            markers: &markers,
            harnesses: &harnesses,
            live_attempts: &HashSet::new(),
            statuses: &statuses,
            engine_assignments: &IndexMap::new(),
        };
        let views = reassign_views(&context, Some(&config), None);
        assert_eq!(views["01"].reassign.reason.as_deref(), Some("done"));
        assert_eq!(views["01"].assignment, None);
        let two = &views["02"];
        assert!(two.reassign.eligible);
        assert_eq!(two.reassign.verify, Some(3));
        assert_eq!(two.reassign.sources.model, AssignmentSource::Pinned);
        assert_eq!(two.assignment.as_ref().unwrap().model.as_deref(), Some("x"));

        let broken = reassign_views(&context, None, Some("JSON Parse error"));
        assert_eq!(
            broken["02"].reassign.reason.as_deref(),
            Some("the pool config does not resolve: JSON Parse error")
        );
        assert_eq!(broken["02"].reassign.sources, NO_SOURCES);
    }
}
