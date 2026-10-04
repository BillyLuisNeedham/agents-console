//! Assignment (CONTEXT.md: Assignment; ADR-0013; assignment.ts and engine.ts's resolution pass): the
//! harness, model, effort and drivers a unit of work runs on, plus the verify count a Ticket may carry.
//! One resolver serves every caller: an ordinary Ticket, a spawned Ticket, an engine-run judge (grader,
//! head-to-head) and a Conversation each supply their own layers, and the resolver applies them field by
//! field in one order: the request (pinned), a spawned Ticket's own requested Assignment (requested),
//! what the unit inherits from its parent or build ticket (inherited), then the pool defaults (default).
//! A named harness must be in the harness table; whether an empty harness or model is an error is the
//! caller's call. Effort layers exactly like model but is never an error.
//!
//! The pool-wide pass (`resolve_pool_assignments`, `resolve_unseen_assignments`) resolves every marker
//! of the pool against a config and the harness table, as pure functions.

use ac_protocol::{
    AssignmentSource, AssignmentSources, AssignmentView, SpawnAssignRequest, StewardAssign,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{ConfigError, PoolConfig};
use crate::harness::Harnesses;
use crate::js_compat;

/// The drivers an Assignment runs when no layer names any.
pub const DEFAULT_DRIVERS: &str = "implement";

/// One resolved Assignment: the engine's record. An unassigned harness or model is the empty string.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Assignment {
    pub harness: String,
    pub model: String,
    /// The harness's own effort word, verbatim; absent when no layer sets one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub drivers: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<u64>,
}

/// One Assignment field as a layer holds it, the way the TypeScript reads it off a parsed file: absent,
/// JSON null, or a value. Null counts as set, as the TypeScript's `!== undefined && !== ""` test counts
/// it, so a hand-written null stops the chain and resolves as nothing; the empty string does not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum LayerField {
    #[default]
    Absent,
    Null,
    /// A string, or any other JSON value as `String()` spells it.
    Text(String),
}

impl LayerField {
    fn of(value: Option<&Value>) -> Self {
        match value {
            None => LayerField::Absent,
            Some(Value::Null) => LayerField::Null,
            Some(value) => LayerField::Text(js_compat::string_of(value)),
        }
    }

    fn of_text(value: Option<&str>) -> Self {
        value.map_or(LayerField::Absent, |text| LayerField::Text(text.to_owned()))
    }

    fn is_set(&self) -> bool {
        match self {
            LayerField::Absent => false,
            LayerField::Null => true,
            LayerField::Text(text) => !text.is_empty(),
        }
    }

    // `?? ""`: the value, or nothing for null.
    fn text(&self) -> Option<&str> {
        match self {
            LayerField::Text(text) => Some(text),
            _ => None,
        }
    }
}

/// One layer's four Assignment fields.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AssignmentLayer {
    pub harness: LayerField,
    pub model: LayerField,
    pub effort: LayerField,
    pub drivers: LayerField,
}

impl AssignmentLayer {
    /// The four fields of a JSON object as a file holds them (console.json `defaults`, an `assign`
    /// entry); anything but an object has none.
    pub fn of_object(value: Option<&Value>) -> Self {
        let field =
            |name: &str| LayerField::of(value.and_then(|value| value.as_object()?.get(name)));
        AssignmentLayer {
            harness: field("harness"),
            model: field("model"),
            effort: field("effort"),
            drivers: field("drivers"),
        }
    }

    /// A layer from four optional strings.
    pub fn of_fields(
        harness: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        drivers: Option<&str>,
    ) -> Self {
        AssignmentLayer {
            harness: LayerField::of_text(harness),
            model: LayerField::of_text(model),
            effort: LayerField::of_text(effort),
            drivers: LayerField::of_text(drivers),
        }
    }
}

impl From<&Assignment> for AssignmentLayer {
    fn from(assignment: &Assignment) -> Self {
        AssignmentLayer::of_fields(
            Some(&assignment.harness),
            Some(&assignment.model),
            assignment.effort.as_deref(),
            Some(&assignment.drivers),
        )
    }
}

impl From<&SpawnAssignRequest> for AssignmentLayer {
    fn from(request: &SpawnAssignRequest) -> Self {
        AssignmentLayer::of_fields(
            request.harness.as_deref(),
            request.model.as_deref(),
            request.effort.as_deref(),
            request.drivers.as_deref(),
        )
    }
}

impl From<&StewardAssign> for AssignmentLayer {
    fn from(assign: &StewardAssign) -> Self {
        AssignmentLayer::of_fields(
            assign.harness.as_deref(),
            assign.model.as_deref(),
            assign.effort.as_deref(),
            assign.drivers.as_deref(),
        )
    }
}

/// The fields a request may set (a console.json assign entry, a Conversation start's assign), with
/// `verify` read as written so a malformed value is reported rather than silently coerced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AssignmentRequest {
    pub layer: AssignmentLayer,
    pub verify: Option<Value>,
}

impl AssignmentRequest {
    /// An `assign` entry as the file holds it.
    pub fn of_entry(value: Option<&Value>) -> Self {
        AssignmentRequest {
            layer: AssignmentLayer::of_object(value),
            verify: value.and_then(|value| value.as_object()?.get("verify").cloned()),
        }
    }
}

impl From<AssignmentLayer> for AssignmentRequest {
    fn from(layer: AssignmentLayer) -> Self {
        AssignmentRequest {
            layer,
            verify: None,
        }
    }
}

/// What `resolve_assignment` takes.
#[derive(Debug, Clone, Copy)]
pub struct ResolveAssignmentParams<'a> {
    /// The prefix every error names the subject by: "pool config: ticket 01" for a Ticket,
    /// "conversation start:" for a Conversation.
    pub subject: &'a str,
    pub request: Option<&'a AssignmentRequest>,
    /// A spawned Ticket's proposal `assign`, persisted on its marker (issue #116): under the request,
    /// over what the unit inherits. Never carries verify.
    pub requested: Option<&'a AssignmentLayer>,
    /// What the unit inherits when the request is silent: the parent Ticket or Conversation of a
    /// spawned unit, the build ticket of a judge, a Steward's entry.
    pub inherited: Option<&'a AssignmentLayer>,
    /// The pool defaults, applied last, field by field.
    pub defaults: Option<&'a AssignmentLayer>,
    /// Strict resolution refuses an empty harness or model; lenient resolution returns them empty so
    /// the misconfiguration renders instead of failing pool load.
    pub strict: bool,
    /// Whether the request's verify is honoured. A judge is never itself verified, and a Conversation
    /// is never verified at all.
    pub verify: bool,
    pub harnesses: &'a Harnesses,
}

// The layers in order, so the index a field lands on names its source.
const LAYERS: [AssignmentSource; 4] = [
    AssignmentSource::Pinned,
    AssignmentSource::Requested,
    AssignmentSource::Inherited,
    AssignmentSource::Default,
];

fn first_set_index(values: [&LayerField; 4]) -> Option<usize> {
    values.iter().position(|value| value.is_set())
}

fn first_set(values: [&LayerField; 4]) -> Option<&LayerField> {
    first_set_index(values).map(|index| values[index])
}

fn source_of(values: [&LayerField; 4]) -> AssignmentSource {
    first_set_index(values).map_or(AssignmentSource::Unset, |index| LAYERS[index])
}

// One field across the four layers, in order.
fn field_of(
    layers: [Option<&AssignmentLayer>; 4],
    pick: fn(&AssignmentLayer) -> &LayerField,
) -> [&LayerField; 4] {
    static ABSENT: LayerField = LayerField::Absent;
    layers.map(|layer| layer.map_or(&ABSENT, pick))
}

/// Which layer supplied each field of the Assignment `resolve_assignment` would return for the same
/// layers, so the Console can say "pinned" or "inherited" beside a value (Reassign, issue #126). The
/// drivers never resolve to nothing (the engine falls back to `implement`), so drivers no layer sets
/// read as "default".
pub fn resolve_assignment_sources(
    request: Option<&AssignmentLayer>,
    requested: Option<&AssignmentLayer>,
    inherited: Option<&AssignmentLayer>,
    defaults: Option<&AssignmentLayer>,
) -> AssignmentSources {
    let layers = [request, requested, inherited, defaults];
    let drivers = source_of(field_of(layers, |layer| &layer.drivers));
    AssignmentSources {
        harness: source_of(field_of(layers, |layer| &layer.harness)),
        model: source_of(field_of(layers, |layer| &layer.model)),
        effort: source_of(field_of(layers, |layer| &layer.effort)),
        drivers: if drivers == AssignmentSource::Unset {
            AssignmentSource::Default
        } else {
            drivers
        },
    }
}

/// Resolve one unit's Assignment from its layers. The errors are the TypeScript's, verbatim: a strict
/// caller with no harness, then an unknown harness, then a strict caller with no model, then a verify
/// that is not an integer of 1 or more.
pub fn resolve_assignment(params: ResolveAssignmentParams<'_>) -> Result<Assignment, ConfigError> {
    let request = params.request.map(|request| &request.layer);
    let layers = [request, params.requested, params.inherited, params.defaults];
    let resolved = |pick: fn(&AssignmentLayer) -> &LayerField| {
        first_set(field_of(layers, pick)).and_then(LayerField::text)
    };
    let subject = params.subject;
    let harness = resolved(|layer| &layer.harness).unwrap_or("").to_owned();
    let model = resolved(|layer| &layer.model).unwrap_or("").to_owned();
    let effort = resolved(|layer| &layer.effort)
        .map(js_compat::trim)
        .filter(|effort| !effort.is_empty())
        .map(str::to_owned);
    // A null stops the chain and reads as nothing: an empty harness or model, the default drivers.
    let drivers = resolved(|layer| &layer.drivers)
        .unwrap_or(DEFAULT_DRIVERS)
        .to_owned();
    if params.strict && harness.is_empty() {
        return Err(ConfigError(format!(
            "{subject} no harness resolved (set assign.harness, inherit from the parent Conversation, or console.json defaults.harness)"
        )));
    }
    if !harness.is_empty() && !params.harnesses.contains(&harness) {
        return Err(ConfigError(format!(
            "{subject} names unknown harness '{harness}'. Known: {}",
            params.harnesses.known()
        )));
    }
    if params.strict && model.is_empty() {
        return Err(ConfigError(format!(
            "{subject} no model resolved (set assign.model, inherit from the parent Conversation, or console.json defaults.model)"
        )));
    }
    let mut verify = None;
    if params.verify
        && let Some(raw) = params.request.and_then(|request| request.verify.as_ref())
        && !raw.is_null()
    {
        let count = js_compat::number_of(raw).filter(|_| js_compat::is_integer(raw));
        match count {
            Some(count) if count >= 1.0 => verify = Some(count as u64),
            _ => {
                return Err(ConfigError(format!(
                    "{subject} has invalid verify {} (must be an integer >= 1)",
                    js_compat::stringify(raw)
                )));
            }
        }
    }
    Ok(Assignment {
        harness,
        model,
        effort,
        drivers,
        verify,
    })
}

/// The wire view of a resolved Assignment: the empty string the engine uses for an unassigned field
/// reads as null, and verify stays off the wire. `effort_applied` is the caller's: whether the effort
/// reaches the harness depends on the mode the unit launches in (`harness::effort_applies`); the
/// TypeScript's default is true.
pub fn assignment_view_of(assignment: &Assignment, effort_applied: bool) -> AssignmentView {
    let effort = assignment
        .effort
        .clone()
        .filter(|effort| !effort.is_empty());
    AssignmentView {
        harness: Some(assignment.harness.clone()).filter(|harness| !harness.is_empty()),
        model: Some(assignment.model.clone()).filter(|model| !model.is_empty()),
        effort_applied: effort.as_ref().map(|_| effort_applied),
        effort,
        drivers: assignment.drivers.clone(),
    }
}

/// The record an unassigned ticket resolves to (ADR-0013): a ticket with no assign entry and no pool
/// defaults. The server's mid-flight fallback for a meta id quotes it.
pub fn unassigned_assignment_view() -> AssignmentView {
    AssignmentView {
        harness: None,
        model: None,
        effort: None,
        effort_applied: None,
        drivers: DEFAULT_DRIVERS.to_owned(),
    }
}

/// The record a `reassigned` event's from and to carry: the Assignment's wire view plus verify, since
/// a ticket's reassignment forensics are incomplete without it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssignmentEventPayload {
    pub harness: Option<String>,
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub drivers: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<u64>,
}

/// A resolved Assignment as a `reassigned` event records it.
pub fn assignment_event_payload(assignment: &Assignment) -> AssignmentEventPayload {
    let view = assignment_view_of(assignment, true);
    AssignmentEventPayload {
        harness: view.harness,
        model: view.model,
        effort: view.effort,
        drivers: view.drivers,
        verify: assignment.verify,
    }
}

// ---------------------------------------------------------------------------------------------------
// Engine-written Tickets' ids (engine.ts): the grader and head-to-head conventions
// ---------------------------------------------------------------------------------------------------

/// A grader ticket's id: `<build>-grader-<N>`, N the one-based position in the build ticket's fan-out.
pub fn grader_id_for(build_id: &str, index: u64) -> String {
    format!("{build_id}-grader-{index}")
}

/// A grader id's build ticket and attempt position (`^(.+)-grader-(\d+)$`).
pub fn parse_grader_id(id: &str) -> Option<(&str, u64)> {
    let at = id.rfind("-grader-")?;
    let (build, digits) = (&id[..at], &id[at + "-grader-".len()..]);
    if build.is_empty()
        || build.contains('\n')
        || digits.is_empty()
        || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((build, js_compat::number_from_text(digits) as u64))
}

/// The head-to-head ticket's id: exactly one per build ticket.
pub fn head_to_head_id_for(build_id: &str) -> String {
    format!("{build_id}-head-to-head")
}

/// A head-to-head id's build ticket.
pub fn parse_head_to_head_id(id: &str) -> Option<&str> {
    id.strip_suffix("-head-to-head")
}

/// The build ticket behind an engine-written ticket id, grader or head-to-head; `None` for an ordinary
/// ticket the pool's own directory defines. Reassign uses it to never offer an engine-owned ticket.
pub fn engine_ticket_build_id(id: &str) -> Option<&str> {
    parse_grader_id(id)
        .map(|(build, _)| build)
        .or_else(|| parse_head_to_head_id(id))
}

// ---------------------------------------------------------------------------------------------------
// The pool's resolution pass (engine.ts)
// ---------------------------------------------------------------------------------------------------

/// What the resolution pass reads off a Ticket marker. The pool's marker type implements it.
pub trait AssignmentMarker {
    fn id(&self) -> &str;
    /// The ticket whose attempt proposed this one (ADR-0010).
    fn spawned_by(&self) -> Option<&str>;
    /// The proposal's own `assign`, persisted on the marker (issue #116).
    fn spawn_assign(&self) -> Option<&SpawnAssignRequest>;
    /// The herdr pane an enlisted ticket was picked from (issue #101).
    fn enlisted_from(&self) -> Option<&str>;
}

/// A marker's resolution facts held on their own, for callers (and tests) without a marker at hand.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MarkerFacts {
    pub id: String,
    pub spawned_by: Option<String>,
    pub spawn_assign: Option<SpawnAssignRequest>,
    pub enlisted_from: Option<String>,
}

impl MarkerFacts {
    pub fn new(id: &str) -> Self {
        MarkerFacts {
            id: id.to_owned(),
            ..MarkerFacts::default()
        }
    }
}

impl AssignmentMarker for MarkerFacts {
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

/// Every resolved Assignment by id, in the order the pass resolved them.
pub type Assignments = IndexMap<String, Assignment>;

/// The pool defaults as a layer: console.json `defaults`.
pub fn defaults_layer(config: &PoolConfig) -> AssignmentLayer {
    AssignmentLayer::of_object(config.get("defaults"))
}

/// A ticket's console.json `assign` entry as a request (empty when it has none): `config.assign?.[id]`,
/// which on an array written by hand finds the element at a canonical index.
pub fn assign_request(config: &PoolConfig, id: &str) -> AssignmentRequest {
    AssignmentRequest::of_entry(config.get("assign").and_then(|assign| match assign {
        Value::Object(entries) => entries.get(id),
        Value::Array(items) => {
            js_compat::array_index(id).and_then(|index| items.get(index as usize))
        }
        _ => None,
    }))
}

// The request an engine-run judge's own assign entry may make: harness, model and effort, never the
// build's drivers.
fn engine_ticket_request(assign: &AssignmentRequest) -> AssignmentRequest {
    AssignmentRequest {
        layer: AssignmentLayer {
            drivers: LayerField::Absent,
            ..assign.layer.clone()
        },
        verify: None,
    }
}

fn ticket_subject(id: &str) -> String {
    format!("pool config: ticket {id}")
}

/// An ordinary ticket's Assignment: its assign entry over the pool defaults. Lenient: a ticket with no
/// assign entry and no defaults resolves to an empty harness and model, so the misconfiguration renders
/// instead of failing pool load; only a named but unknown harness (or an invalid verify) fails here.
pub fn resolve_ticket_assignment(
    marker: &impl AssignmentMarker,
    config: &PoolConfig,
    harnesses: &Harnesses,
) -> Result<Assignment, ConfigError> {
    let request = assign_request(config, marker.id());
    let defaults = defaults_layer(config);
    resolve_assignment(ResolveAssignmentParams {
        subject: &ticket_subject(marker.id()),
        request: Some(&request),
        requested: None,
        inherited: None,
        defaults: Some(&defaults),
        strict: false,
        verify: true,
        harnesses,
    })
}

/// An engine-run judge's Assignment (grader or head-to-head): its own assign entry may override the
/// harness, model and effort; what it does not override comes from the build ticket's Assignment, then
/// the pool defaults. Never verified itself, and the drivers stay the build's.
pub fn resolve_engine_ticket_assignment(
    config: &PoolConfig,
    marker: &impl AssignmentMarker,
    build: &Assignment,
    harnesses: &Harnesses,
) -> Result<Assignment, ConfigError> {
    let request = engine_ticket_request(&assign_request(config, marker.id()));
    let inherited = AssignmentLayer::from(build);
    let defaults = defaults_layer(config);
    resolve_assignment(ResolveAssignmentParams {
        subject: &ticket_subject(marker.id()),
        request: Some(&request),
        requested: None,
        inherited: Some(&inherited),
        defaults: Some(&defaults),
        strict: false,
        verify: false,
        harnesses,
    })
}

/// A spawned ticket's Assignment (ADR-0010): its assign entry, then the proposal's own requested
/// Assignment, then the proposing parent's, then the pool defaults. Verify is honoured like any
/// ordinary ticket's.
pub fn resolve_spawned_ticket_assignment(
    config: &PoolConfig,
    marker: &impl AssignmentMarker,
    parent: &Assignment,
    harnesses: &Harnesses,
) -> Result<Assignment, ConfigError> {
    let request = assign_request(config, marker.id());
    let requested = marker.spawn_assign().map(AssignmentLayer::from);
    let inherited = AssignmentLayer::from(parent);
    let defaults = defaults_layer(config);
    resolve_assignment(ResolveAssignmentParams {
        subject: &ticket_subject(marker.id()),
        request: Some(&request),
        requested: requested.as_ref(),
        inherited: Some(&inherited),
        defaults: Some(&defaults),
        strict: false,
        verify: true,
        harnesses,
    })
}

/// Every ticket's Assignment as a config resolves it, the layer each field came from, and why each
/// ticket that did not resolve did not.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PoolAssignments {
    pub assignments: Assignments,
    pub sources: IndexMap<String, AssignmentSources>,
    pub failures: IndexMap<String, String>,
}

/// Every ticket's Assignment as a given config resolves it, with the layer each field came from beside
/// it (Reassign, issue #126): the same pass the engine runs at boot and at a Config reload, over a
/// config the caller supplies.
///
/// `seed` is what the reload's dry run starts from: the frozen record of every ticket it will not
/// re-resolve, and the pool's Conversations (a ticket's spawned-by may name one, issue #156). A seeded
/// id is left exactly as given, its children inherit from it, and it gets no `sources` entry.
///
/// Never fails for a ticket: each one that does not resolve is in `failures` with its own reason, and
/// every other ticket resolves regardless.
pub fn resolve_pool_assignments<M: AssignmentMarker>(
    markers: &[M],
    config: &PoolConfig,
    harnesses: &Harnesses,
    seed: Option<&Assignments>,
) -> PoolAssignments {
    let mut out = PoolAssignments {
        assignments: seed.cloned().unwrap_or_default(),
        ..PoolAssignments::default()
    };
    // With a failures map nothing is ever returned as an error.
    let _ = resolve_assignments_into(
        markers,
        &mut out.assignments,
        config,
        harnesses,
        Some(&mut out.sources),
        Some(&mut out.failures),
    );
    out
}

/// Resolution for the marker ids the map does not know yet, all or nothing: the first failure is the
/// error, naming what went wrong (ADR-0018). Run once at pool start against a map seeded with the
/// pool's Conversations, and by the Config reload's dry run against its frozen seed.
pub fn resolve_unseen_assignments<M: AssignmentMarker>(
    markers: &[M],
    assignments: &mut Assignments,
    config: &PoolConfig,
    harnesses: &Harnesses,
) -> Result<(), ConfigError> {
    resolve_assignments_into(markers, assignments, config, harnesses, None, None)
}

/// The shared resolution pass (ADR-0010, ADR-0018): resolves every marker id not already in
/// `assignments`. Ordinary tickets resolve from the config; grader and head-to-head ids from their
/// build ticket's Assignment (a stale engine card whose build is gone resolves as an ordinary ticket);
/// spawned ids from their parent, sweeping until the map stops growing so a chain resolves however deep
/// it nests and a parent later in file order is waited for; an enlisted ticket takes only its harness
/// from the config. Without `failures`, the first failure is returned; with it, each one is recorded
/// against its ticket and the rest resolve.
pub fn resolve_assignments_into<M: AssignmentMarker>(
    markers: &[M],
    assignments: &mut Assignments,
    config: &PoolConfig,
    harnesses: &Harnesses,
    mut sources: Option<&mut IndexMap<String, AssignmentSources>>,
    mut failures: Option<&mut IndexMap<String, String>>,
) -> Result<(), ConfigError> {
    let mut progressed = true;
    while progressed {
        progressed = false;
        for marker in markers {
            let id = marker.id();
            if assignments.contains_key(id) || failures.as_ref().is_some_and(|f| f.contains_key(id))
            {
                continue;
            }
            match resolve_one(
                marker,
                markers,
                assignments,
                config,
                harnesses,
                sources.as_deref_mut(),
            ) {
                Ok(resolved) => progressed |= resolved,
                Err(error) => {
                    let Some(failures) = failures.as_deref_mut() else {
                        return Err(error);
                    };
                    failures.insert(id.to_owned(), error.0);
                    progressed = true;
                }
            }
        }
    }
    let unresolved: Vec<&M> = markers
        .iter()
        .filter(|m| {
            !assignments.contains_key(m.id())
                && !failures.as_ref().is_some_and(|f| f.contains_key(m.id()))
        })
        .collect();
    // Every reason first, then recorded: in a cycle each member is in it, not downstream of whichever
    // member happened to be recorded first.
    let reasons: Vec<(String, String)> = unresolved
        .iter()
        .map(|marker| {
            let reason = unresolved_reason(*marker, markers, assignments, failures.as_deref());
            (
                marker.id().to_owned(),
                format!("pool config: ticket {}: {reason}", marker.id()),
            )
        })
        .collect();
    for (id, reason) in reasons {
        let Some(failures) = failures.as_deref_mut() else {
            return Err(ConfigError(reason));
        };
        failures.insert(id, reason);
    }
    Ok(())
}

// Resolves one marker into the map, or answers false when what it inherits from is not resolved yet
// and a later sweep may get to it.
fn resolve_one<M: AssignmentMarker>(
    marker: &M,
    markers: &[M],
    assignments: &mut Assignments,
    config: &PoolConfig,
    harnesses: &Harnesses,
    sources: Option<&mut IndexMap<String, AssignmentSources>>,
) -> Result<bool, ConfigError> {
    let id = marker.id();
    let defaults = defaults_layer(config);
    let request = assign_request(config, id);
    if let Some(build_id) = engine_ticket_build_id(id).filter(|build| !build.is_empty()) {
        let build = assignments.get(build_id).cloned();
        // The build not resolved yet is not the build absent: a grader whose build ticket is in the
        // pool waits for a later sweep; only a stale card whose build is gone resolves as ordinary.
        if build.is_none() && markers.iter().any(|m| m.id() == build_id) {
            return Ok(false);
        }
        let resolved = match &build {
            Some(build) => resolve_engine_ticket_assignment(config, marker, build, harnesses)?,
            None => resolve_ticket_assignment(marker, config, harnesses)?,
        };
        assignments.insert(id.to_owned(), resolved);
        if let Some(sources) = sources {
            let inherited = build.as_ref().map(AssignmentLayer::from);
            // The same narrowed request the judge's resolver takes.
            let layer = match &build {
                Some(_) => engine_ticket_request(&request).layer,
                None => request.layer,
            };
            sources.insert(
                id.to_owned(),
                resolve_assignment_sources(Some(&layer), None, inherited.as_ref(), Some(&defaults)),
            );
        }
        return Ok(true);
    }
    if let Some(parent_id) = marker.spawned_by() {
        let Some(parent) = assignments.get(parent_id).cloned() else {
            return Ok(false);
        };
        let resolved = resolve_spawned_ticket_assignment(config, marker, &parent, harnesses)?;
        assignments.insert(id.to_owned(), resolved);
        if let Some(sources) = sources {
            let requested = marker.spawn_assign().map(AssignmentLayer::from);
            let inherited = AssignmentLayer::from(&parent);
            sources.insert(
                id.to_owned(),
                resolve_assignment_sources(
                    Some(&request.layer),
                    requested.as_ref(),
                    Some(&inherited),
                    Some(&defaults),
                ),
            );
        }
        return Ok(true);
    }
    if marker.enlisted_from().is_some() {
        // An enlisted ticket's Assignment is as found (issue #101): the harness from the config after a
        // restart, model unknown and drivers default, verify stripped so it re-adopts and never fans out.
        let resolved = resolve_ticket_assignment(marker, config, harnesses)?;
        assignments.insert(
            id.to_owned(),
            Assignment {
                harness: resolved.harness,
                model: String::new(),
                effort: None,
                drivers: DEFAULT_DRIVERS.to_owned(),
                verify: None,
            },
        );
        if let Some(sources) = sources {
            let harness =
                resolve_assignment_sources(Some(&request.layer), None, None, Some(&defaults))
                    .harness;
            sources.insert(
                id.to_owned(),
                AssignmentSources {
                    harness,
                    model: AssignmentSource::Unset,
                    effort: AssignmentSource::Unset,
                    drivers: AssignmentSource::Default,
                },
            );
        }
        return Ok(true);
    }
    let resolved = resolve_ticket_assignment(marker, config, harnesses)?;
    assignments.insert(id.to_owned(), resolved);
    if let Some(sources) = sources {
        sources.insert(
            id.to_owned(),
            resolve_assignment_sources(Some(&request.layer), None, None, Some(&defaults)),
        );
    }
    Ok(true)
}

/// Why a ticket the pass could not resolve did not, in words an operator can act on: it sits on a real
/// spawned-by cycle (walked out in full), its parent (or build ticket) is a ticket that did not resolve
/// itself, or its parent is no ticket and has no Assignment (a Conversation nobody seeded).
pub fn unresolved_reason<M: AssignmentMarker>(
    marker: &M,
    markers: &[M],
    assignments: &Assignments,
    failures: Option<&IndexMap<String, String>>,
) -> String {
    let by_id = |id: &str| markers.iter().rev().find(|m| m.id() == id);
    let upstream = |m: &M| -> Option<String> {
        engine_ticket_build_id(m.id())
            .or_else(|| m.spawned_by())
            .map(str::to_owned)
    };
    let unresolved =
        |id: &str| !assignments.contains_key(id) && !failures.is_some_and(|f| f.contains_key(id));
    let mut chain: Vec<String> = vec![marker.id().to_owned()];
    let mut up = upstream(marker);
    while let Some(next_id) = up {
        if next_id == marker.id() {
            chain.push(next_id);
            return format!("spawned-by cycle: {}", chain.join(" -> "));
        }
        let next = by_id(&next_id);
        let Some(next) = next.filter(|_| unresolved(&next_id) && !chain.contains(&next_id)) else {
            break;
        };
        chain.push(next_id);
        up = upstream(next);
    }
    let parent = upstream(marker).unwrap_or_default();
    let role = if engine_ticket_build_id(marker.id()).is_some_and(|build| !build.is_empty()) {
        "build ticket"
    } else {
        "parent"
    };
    if by_id(&parent).is_some() {
        format!("{role} {parent} did not resolve")
    } else {
        format!("{role} {parent} has no Assignment")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::HarnessCommand;
    use serde_json::json;
    use std::sync::Arc;

    fn table(names: &[&str]) -> Harnesses {
        let mut harnesses = Harnesses::default();
        for name in names {
            let argv = vec![(*name).to_owned()];
            let command: HarnessCommand = Arc::new(move |_| argv.clone());
            harnesses.insert_command(name, command);
        }
        harnesses
    }

    fn harnesses() -> Harnesses {
        table(&["claude", "codex"])
    }

    const KNOWN: &str = "Known: claude, codex";

    fn layer(value: Value) -> AssignmentLayer {
        AssignmentLayer::of_object(Some(&value))
    }

    fn request(value: Value) -> AssignmentRequest {
        AssignmentRequest::of_entry(Some(&value))
    }

    fn assignment(value: Value) -> Assignment {
        serde_json::from_value(value).unwrap()
    }

    fn parent() -> AssignmentLayer {
        layer(json!({ "harness": "codex", "model": "o3", "drivers": "implement review" }))
    }

    fn defaults() -> AssignmentLayer {
        layer(json!({ "harness": "claude", "model": "opus", "drivers": "implement" }))
    }

    fn parent_assignment() -> Assignment {
        assignment(json!({ "harness": "codex", "model": "o3", "drivers": "implement review" }))
    }

    fn defaults_assignment() -> Assignment {
        assignment(json!({ "harness": "claude", "model": "opus", "drivers": "implement" }))
    }

    /// The four callers, each with its own overrides (ticket 04's Design).
    #[derive(Clone, Copy)]
    enum Caller {
        Ordinary,
        Spawned,
        Grader,
        Conversation,
    }

    struct Call {
        caller: Caller,
        request: Option<AssignmentRequest>,
        inherited: Option<Option<AssignmentLayer>>,
        defaults: Option<Option<AssignmentLayer>>,
    }

    fn call(caller: Caller) -> Call {
        Call {
            caller,
            request: None,
            inherited: None,
            defaults: None,
        }
    }

    impl Call {
        fn request(mut self, value: Value) -> Self {
            self.request = Some(request(value));
            self
        }

        fn inherited(mut self, layer: Option<AssignmentLayer>) -> Self {
            self.inherited = Some(layer);
            self
        }

        fn defaults(mut self, layer: Option<AssignmentLayer>) -> Self {
            self.defaults = Some(layer);
            self
        }

        fn resolve(&self) -> Result<Assignment, ConfigError> {
            let harnesses = harnesses();
            let (subject, inherited, defaults, strict, verify) = match self.caller {
                Caller::Ordinary => (
                    "pool config: ticket 01",
                    None,
                    Some(defaults()),
                    false,
                    true,
                ),
                Caller::Spawned => (
                    "pool config: ticket 01-spawn-1",
                    Some(parent()),
                    None,
                    false,
                    true,
                ),
                Caller::Grader => (
                    "pool config: ticket 01-grader-1",
                    Some(parent()),
                    None,
                    false,
                    false,
                ),
                Caller::Conversation => (
                    "conversation start:",
                    Some(parent()),
                    Some(defaults()),
                    true,
                    false,
                ),
            };
            let inherited = self.inherited.clone().unwrap_or(inherited);
            let defaults = self.defaults.clone().unwrap_or(defaults);
            resolve_assignment(ResolveAssignmentParams {
                subject,
                request: self.request.as_ref(),
                requested: None,
                inherited: inherited.as_ref(),
                defaults: defaults.as_ref(),
                strict,
                verify,
                harnesses: &harnesses,
            })
        }

        fn ok(&self) -> Assignment {
            self.resolve().unwrap()
        }

        fn err(&self) -> String {
            self.resolve().unwrap_err().0
        }
    }

    // assignment.test.ts: resolveAssignment: field-wise overrides
    #[test]
    fn ordinary_ticket_request_over_defaults_empty_when_neither_says() {
        assert_eq!(call(Caller::Ordinary).ok(), defaults_assignment());
        assert_eq!(
            call(Caller::Ordinary)
                .request(json!({ "model": "haiku" }))
                .ok(),
            Assignment {
                model: "haiku".into(),
                ..defaults_assignment()
            }
        );
        assert_eq!(
            call(Caller::Ordinary).defaults(None).ok(),
            assignment(json!({ "harness": "", "model": "", "drivers": "implement" }))
        );
    }

    #[test]
    fn spawned_ticket_request_over_the_parent_the_parent_over_the_defaults() {
        assert_eq!(call(Caller::Spawned).ok(), parent_assignment());
        assert_eq!(
            call(Caller::Spawned)
                .request(json!({ "harness": "claude", "drivers": "fix" }))
                .ok(),
            assignment(json!({ "harness": "claude", "model": "o3", "drivers": "fix" }))
        );
        let no_model =
            layer(json!({ "harness": "codex", "model": "", "drivers": "implement review" }));
        assert_eq!(
            call(Caller::Spawned)
                .inherited(Some(no_model.clone()))
                .defaults(Some(defaults()))
                .ok(),
            assignment(
                json!({ "harness": "codex", "model": "opus", "drivers": "implement review" })
            )
        );
        assert_eq!(
            call(Caller::Spawned).inherited(Some(no_model)).ok(),
            Assignment {
                model: String::new(),
                ..parent_assignment()
            }
        );
    }

    #[test]
    fn grader_harness_and_model_over_the_builds_drivers_pinned_verify_ignored() {
        assert_eq!(
            call(Caller::Grader)
                .request(json!({ "model": "haiku", "verify": 3 }))
                .ok(),
            assignment(
                json!({ "harness": "codex", "model": "haiku", "drivers": "implement review" })
            )
        );
    }

    #[test]
    fn conversation_request_then_the_parent_then_the_defaults() {
        assert_eq!(
            call(Caller::Conversation)
                .request(json!({ "model": "sonnet" }))
                .ok(),
            assignment(
                json!({ "harness": "codex", "model": "sonnet", "drivers": "implement review" })
            )
        );
        assert_eq!(
            call(Caller::Conversation).inherited(None).ok(),
            defaults_assignment()
        );
        assert_eq!(
            call(Caller::Conversation)
                .inherited(None)
                .defaults(Some(layer(json!({ "harness": "claude", "model": "opus" }))))
                .ok(),
            assignment(json!({ "harness": "claude", "model": "opus", "drivers": "implement" }))
        );
    }

    // assignment.test.ts: resolveAssignment: effort layers like model
    #[test]
    fn effort_takes_the_request_then_the_parent_then_the_defaults_field_by_field() {
        let with_effort = layer(
            json!({ "harness": "claude", "model": "opus", "drivers": "implement", "effort": "high" }),
        );
        assert_eq!(
            call(Caller::Ordinary)
                .defaults(Some(with_effort.clone()))
                .ok(),
            Assignment {
                effort: Some("high".into()),
                ..defaults_assignment()
            }
        );
        assert_eq!(
            call(Caller::Ordinary)
                .defaults(Some(with_effort.clone()))
                .request(json!({ "effort": "max" }))
                .ok(),
            Assignment {
                effort: Some("max".into()),
                ..defaults_assignment()
            }
        );
        let low_parent = layer(
            json!({ "harness": "codex", "model": "o3", "drivers": "implement review", "effort": "low" }),
        );
        assert_eq!(
            call(Caller::Spawned)
                .inherited(Some(low_parent.clone()))
                .defaults(Some(with_effort.clone()))
                .ok(),
            Assignment {
                effort: Some("low".into()),
                ..parent_assignment()
            }
        );
        assert_eq!(
            call(Caller::Spawned).defaults(Some(with_effort)).ok(),
            Assignment {
                effort: Some("high".into()),
                ..parent_assignment()
            }
        );
        assert_eq!(
            call(Caller::Grader)
                .request(json!({ "effort": "xhigh" }))
                .inherited(Some(low_parent))
                .ok(),
            Assignment {
                effort: Some("xhigh".into()),
                ..parent_assignment()
            }
        );
    }

    #[test]
    fn leaves_effort_off_when_nothing_sets_it_and_never_refuses_for_it() {
        assert_eq!(call(Caller::Conversation).ok().effort, None);
        assert!(
            call(Caller::Conversation)
                .request(json!({ "effort": "" }))
                .resolve()
                .is_ok()
        );
    }

    #[test]
    fn passes_a_harnesss_own_word_through_verbatim_trimmed() {
        assert_eq!(
            call(Caller::Ordinary)
                .request(json!({ "effort": "  minimal " }))
                .ok()
                .effort
                .as_deref(),
            Some("minimal")
        );
        // Whitespace alone is no effort.
        assert_eq!(
            call(Caller::Ordinary)
                .request(json!({ "effort": "   " }))
                .ok()
                .effort,
            None
        );
    }

    #[test]
    fn names_the_layer_effort_came_from_like_every_other_field() {
        let low_parent = layer(
            json!({ "harness": "codex", "model": "o3", "drivers": "implement review", "effort": "low" }),
        );
        let high = layer(json!({ "effort": "high" }));
        let effort =
            |request: Value, inherited: Option<&AssignmentLayer>, defaults: &AssignmentLayer| {
                resolve_assignment_sources(Some(&layer(request)), None, inherited, Some(defaults))
                    .effort
            };
        assert_eq!(
            effort(json!({ "effort": "max" }), Some(&low_parent), &high),
            AssignmentSource::Pinned
        );
        assert_eq!(
            effort(json!({}), Some(&low_parent), &high),
            AssignmentSource::Inherited
        );
        assert_eq!(
            effort(json!({}), Some(&parent()), &high),
            AssignmentSource::Default
        );
        assert_eq!(
            effort(json!({}), None, &defaults()),
            AssignmentSource::Unset
        );
    }

    #[test]
    fn names_requested_and_reads_unset_drivers_as_default() {
        let sources = resolve_assignment_sources(
            Some(&layer(json!({ "model": "m" }))),
            Some(&layer(json!({ "harness": "claude" }))),
            None,
            None,
        );
        assert_eq!(
            sources,
            AssignmentSources {
                harness: AssignmentSource::Requested,
                model: AssignmentSource::Pinned,
                effort: AssignmentSource::Unset,
                drivers: AssignmentSource::Default,
            }
        );
    }

    // assignment.test.ts: resolveAssignment: errors, verbatim
    #[test]
    fn a_named_harness_must_be_known_in_every_mode() {
        let gemini = json!({ "harness": "gemini" });
        assert_eq!(
            call(Caller::Ordinary).request(gemini.clone()).err(),
            format!("pool config: ticket 01 names unknown harness 'gemini'. {KNOWN}")
        );
        assert_eq!(
            call(Caller::Spawned).request(gemini.clone()).err(),
            format!("pool config: ticket 01-spawn-1 names unknown harness 'gemini'. {KNOWN}")
        );
        assert_eq!(
            call(Caller::Grader).request(gemini.clone()).err(),
            format!("pool config: ticket 01-grader-1 names unknown harness 'gemini'. {KNOWN}")
        );
        assert_eq!(
            call(Caller::Conversation).request(gemini).err(),
            format!("conversation start: names unknown harness 'gemini'. {KNOWN}")
        );
    }

    #[test]
    fn strict_no_harness_then_unknown_harness_then_no_model_in_that_order() {
        let bare = || call(Caller::Conversation).inherited(None).defaults(None);
        assert_eq!(
            bare().err(),
            "conversation start: no harness resolved (set assign.harness, inherit from the parent Conversation, or console.json defaults.harness)"
        );
        assert_eq!(
            bare().request(json!({ "harness": "claude" })).err(),
            "conversation start: no model resolved (set assign.model, inherit from the parent Conversation, or console.json defaults.model)"
        );
        assert_eq!(
            bare().request(json!({ "harness": "gemini" })).err(),
            format!("conversation start: names unknown harness 'gemini'. {KNOWN}")
        );
    }

    #[test]
    fn lenient_an_empty_harness_or_model_is_not_an_error() {
        assert_eq!(
            call(Caller::Ordinary)
                .request(json!({ "harness": "" }))
                .defaults(None)
                .ok()
                .harness,
            ""
        );
    }

    #[test]
    fn verify_honoured_when_integer_at_least_1_null_absent_otherwise_rejected_verbatim() {
        assert_eq!(
            call(Caller::Ordinary)
                .request(json!({ "verify": 3 }))
                .ok()
                .verify,
            Some(3)
        );
        assert_eq!(
            call(Caller::Spawned)
                .request(json!({ "verify": 1 }))
                .ok()
                .verify,
            Some(1)
        );
        assert_eq!(
            call(Caller::Ordinary)
                .request(json!({ "verify": 2.0 }))
                .ok()
                .verify,
            Some(2)
        );
        assert_eq!(
            call(Caller::Ordinary)
                .request(json!({ "verify": null }))
                .ok()
                .verify,
            None
        );
        assert_eq!(call(Caller::Ordinary).request(json!({})).ok().verify, None);
        for (verify, printed) in [
            (json!(0), "0"),
            (json!(-1), "-1"),
            (json!(2.5), "2.5"),
            (json!("3"), "\"3\""),
            (json!(true), "true"),
            (json!({}), "{}"),
        ] {
            assert_eq!(
                call(Caller::Ordinary)
                    .request(json!({ "verify": verify }))
                    .err(),
                format!(
                    "pool config: ticket 01 has invalid verify {printed} (must be an integer >= 1)"
                )
            );
        }
        assert_eq!(
            call(Caller::Grader)
                .request(json!({ "verify": "bad" }))
                .ok()
                .verify,
            None
        );
    }

    #[test]
    fn a_null_field_stops_the_chain_as_the_typescript_reads_it() {
        // `harness: null` is set by firstSet's test, so the defaults never get a say, and it reads as "".
        let resolved = call(Caller::Ordinary)
            .request(json!({ "harness": null, "drivers": null }))
            .ok();
        assert_eq!(resolved.harness, "");
        assert_eq!(resolved.drivers, "implement");
        let sources = resolve_assignment_sources(
            Some(&layer(json!({ "harness": null }))),
            None,
            None,
            Some(&defaults()),
        );
        assert_eq!(sources.harness, AssignmentSource::Pinned);
    }

    // assignment.test.ts: assignmentViewOf
    #[test]
    fn renders_empty_harness_and_model_as_null_and_drivers_verbatim() {
        let unassigned = assignment(json!({ "harness": "", "model": "", "drivers": "implement" }));
        assert_eq!(
            assignment_view_of(&unassigned, true),
            unassigned_assignment_view()
        );
        assert_eq!(
            assignment_view_of(
                &assignment(json!({ "harness": "", "model": "", "drivers": "" })),
                true
            )
            .drivers,
            ""
        );
        assert_eq!(
            serde_json::to_value(assignment_view_of(
                &assignment(json!({ "harness": "claude", "model": "opus", "drivers": "fix" })),
                true
            ))
            .unwrap(),
            json!({ "harness": "claude", "model": "opus", "drivers": "fix" })
        );
        assert_eq!(
            serde_json::to_value(unassigned_assignment_view()).unwrap(),
            json!({ "harness": null, "model": null, "drivers": "implement" })
        );
    }

    #[test]
    fn carries_an_effort_with_whether_it_applies_and_nothing_when_there_is_none() {
        let with = assignment(
            json!({ "harness": "cursor", "model": "gpt-5", "effort": "high", "drivers": "implement" }),
        );
        assert_eq!(
            serde_json::to_value(assignment_view_of(&with, false)).unwrap(),
            json!({ "harness": "cursor", "model": "gpt-5", "effort": "high", "effortApplied": false, "drivers": "implement" })
        );
        assert_eq!(assignment_view_of(&with, true).effort_applied, Some(true));
        let none = assignment_view_of(
            &assignment(json!({ "harness": "cursor", "model": "gpt-5", "drivers": "implement" })),
            false,
        );
        assert_eq!(none.effort, None);
        assert_eq!(none.effort_applied, None);
    }

    #[test]
    fn records_a_reassigned_events_payload_with_verify_and_no_effort_applied() {
        let resolved = assignment(
            json!({ "harness": "", "model": "m", "effort": "high", "drivers": "implement", "verify": 2 }),
        );
        assert_eq!(
            serde_json::to_value(assignment_event_payload(&resolved)).unwrap(),
            json!({ "harness": null, "model": "m", "effort": "high", "drivers": "implement", "verify": 2 })
        );
    }

    // engine.ts: the engine-written ticket id conventions
    #[test]
    fn decodes_the_grader_and_head_to_head_conventions() {
        assert_eq!(grader_id_for("01", 2), "01-grader-2");
        assert_eq!(parse_grader_id("01-grader-2"), Some(("01", 2)));
        assert_eq!(
            parse_grader_id("a-grader-1-grader-12"),
            Some(("a-grader-1", 12))
        );
        assert_eq!(parse_grader_id("-grader-1"), None);
        assert_eq!(parse_grader_id("01-grader-x"), None);
        assert_eq!(parse_grader_id("01-grader-"), None);
        assert_eq!(head_to_head_id_for("01"), "01-head-to-head");
        assert_eq!(parse_head_to_head_id("01-head-to-head"), Some("01"));
        assert_eq!(engine_ticket_build_id("01-grader-1"), Some("01"));
        assert_eq!(engine_ticket_build_id("01-head-to-head"), Some("01"));
        assert_eq!(engine_ticket_build_id("01"), None);
    }

    // ------------------------------------------------------------------------------------------------
    // The pool pass
    // ------------------------------------------------------------------------------------------------

    fn config(value: Value) -> PoolConfig {
        match value {
            Value::Object(map) => PoolConfig::from_map(map),
            _ => unreachable!(),
        }
    }

    fn spawned(id: &str, parent: &str) -> MarkerFacts {
        MarkerFacts {
            spawned_by: Some(parent.into()),
            ..MarkerFacts::new(id)
        }
    }

    fn stub_config() -> PoolConfig {
        config(json!({ "defaults": { "harness": "claude", "model": "m" } }))
    }

    // engine.test.ts: verify assignment
    #[test]
    fn resolves_a_tickets_verify_onto_its_assignment_and_none_when_the_entry_omits_it() {
        let marker = MarkerFacts::new("01");
        for n in [1, 3] {
            let config = config(
                json!({ "defaults": { "harness": "claude", "model": "m" }, "assign": { "01": { "verify": n } } }),
            );
            assert_eq!(
                resolve_ticket_assignment(&marker, &config, &harnesses())
                    .unwrap()
                    .verify,
                Some(n)
            );
        }
        assert_eq!(
            resolve_ticket_assignment(&marker, &stub_config(), &harnesses())
                .unwrap()
                .verify,
            None
        );
        let null = config(
            json!({ "defaults": { "harness": "claude", "model": "m" }, "assign": { "01": { "verify": null } } }),
        );
        assert_eq!(
            resolve_ticket_assignment(&marker, &null, &harnesses())
                .unwrap()
                .verify,
            None
        );
        // verify in the pool defaults is ignored: activation is per ticket.
        let in_defaults =
            config(json!({ "defaults": { "harness": "claude", "model": "m", "verify": 3 } }));
        assert_eq!(
            resolve_ticket_assignment(&marker, &in_defaults, &harnesses())
                .unwrap()
                .verify,
            None
        );
        // Unknown assign keys are ignored, with and without verify.
        let mystery = config(
            json!({ "defaults": { "harness": "claude", "model": "m" }, "assign": { "01": { "mystery": "x" } } }),
        );
        assert_eq!(
            resolve_ticket_assignment(&marker, &mystery, &harnesses())
                .unwrap()
                .verify,
            None
        );
        let both = config(
            json!({ "defaults": { "harness": "claude", "model": "m" }, "assign": { "01": { "mystery": "x", "verify": 2 } } }),
        );
        assert_eq!(
            resolve_ticket_assignment(&marker, &both, &harnesses())
                .unwrap()
                .verify,
            Some(2)
        );
    }

    #[test]
    fn rejects_invalid_verify_values_at_pool_load_naming_the_ticket() {
        for verify in [
            json!(0),
            json!(-1),
            json!(2.5),
            json!("3"),
            json!(true),
            json!({}),
        ] {
            let config = config(
                json!({ "defaults": { "harness": "claude", "model": "m" }, "assign": { "01": { "verify": verify } } }),
            );
            let mut assignments = Assignments::new();
            let error = resolve_unseen_assignments(
                &[MarkerFacts::new("01")],
                &mut assignments,
                &config,
                &harnesses(),
            )
            .unwrap_err();
            assert!(
                error
                    .0
                    .starts_with("pool config: ticket 01 has invalid verify"),
                "{error}"
            );
        }
    }

    #[test]
    fn resolves_a_spawn_chain_in_any_file_order_from_the_parent_and_the_proposal() {
        let markers = vec![
            spawned("01-spawn-1-spawn-1", "01-spawn-1"),
            MarkerFacts {
                spawn_assign: Some(SpawnAssignRequest {
                    harness: None,
                    model: Some("asked".into()),
                    effort: None,
                    drivers: None,
                }),
                ..spawned("01-spawn-1", "01")
            },
            MarkerFacts::new("01"),
        ];
        let config = config(json!({
            "defaults": { "harness": "claude", "model": "m" },
            "assign": { "01": { "harness": "codex", "effort": "high" }, "01-spawn-1-spawn-1": { "model": "pinned" } }
        }));
        let out = resolve_pool_assignments(&markers, &config, &harnesses(), None);
        assert!(out.failures.is_empty());
        assert_eq!(
            out.assignments.keys().collect::<Vec<_>>(),
            ["01", "01-spawn-1", "01-spawn-1-spawn-1"]
        );
        assert_eq!(
            out.assignments["01-spawn-1"],
            assignment(
                json!({ "harness": "codex", "model": "asked", "effort": "high", "drivers": "implement" })
            )
        );
        assert_eq!(
            out.assignments["01-spawn-1-spawn-1"],
            assignment(
                json!({ "harness": "codex", "model": "pinned", "effort": "high", "drivers": "implement" })
            )
        );
        assert_eq!(out.sources["01-spawn-1"].model, AssignmentSource::Requested);
        assert_eq!(
            out.sources["01-spawn-1"].harness,
            AssignmentSource::Inherited
        );
        assert_eq!(
            out.sources["01-spawn-1-spawn-1"].model,
            AssignmentSource::Pinned
        );
        assert_eq!(out.sources["01"].drivers, AssignmentSource::Default);
    }

    #[test]
    fn resolves_a_judge_from_its_build_ticket_and_a_stale_card_as_ordinary() {
        let markers = vec![
            MarkerFacts::new("01-grader-1"),
            MarkerFacts::new("01"),
            MarkerFacts::new("02-head-to-head"),
        ];
        let config = config(json!({
            "defaults": { "harness": "claude", "model": "m" },
            "assign": {
                "01": { "harness": "codex", "model": "o3", "drivers": "fix", "verify": 2 },
                "01-grader-1": { "model": "judge", "drivers": "ignored", "verify": 9 }
            }
        }));
        let out = resolve_pool_assignments(&markers, &config, &harnesses(), None);
        assert_eq!(
            out.assignments["01-grader-1"],
            assignment(json!({ "harness": "codex", "model": "judge", "drivers": "fix" }))
        );
        assert_eq!(
            out.sources["01-grader-1"],
            AssignmentSources {
                harness: AssignmentSource::Inherited,
                model: AssignmentSource::Pinned,
                effort: AssignmentSource::Unset,
                drivers: AssignmentSource::Inherited,
            }
        );
        // 02 is gone from the pool: its head-to-head card resolves as an ordinary ticket.
        assert_eq!(
            out.assignments["02-head-to-head"],
            assignment(json!({ "harness": "claude", "model": "m", "drivers": "implement" }))
        );
    }

    #[test]
    fn takes_only_the_harness_from_the_config_for_an_enlisted_ticket() {
        let markers = vec![MarkerFacts {
            enlisted_from: Some("w1:p1".into()),
            ..MarkerFacts::new("enlist-1")
        }];
        let config = config(json!({
            "defaults": { "harness": "claude", "model": "m", "effort": "high" },
            "assign": { "enlist-1": { "harness": "codex", "verify": 3 } }
        }));
        let out = resolve_pool_assignments(&markers, &config, &harnesses(), None);
        assert_eq!(
            out.assignments["enlist-1"],
            assignment(json!({ "harness": "codex", "model": "", "drivers": "implement" }))
        );
        assert_eq!(
            out.sources["enlist-1"],
            AssignmentSources {
                harness: AssignmentSource::Pinned,
                model: AssignmentSource::Unset,
                effort: AssignmentSource::Unset,
                drivers: AssignmentSource::Default,
            }
        );
    }

    #[test]
    fn records_each_failure_against_its_own_ticket_and_resolves_the_rest() {
        let markers = vec![
            MarkerFacts::new("01"),
            MarkerFacts::new("02"),
            spawned("02-spawn-1", "02"),
            spawned("conv-3-spawn-1", "conv-3"),
            spawned("conv-3-spawn-1-spawn-1", "conv-3-spawn-1"),
            spawned("a", "b"),
            spawned("b", "a"),
        ];
        let config = config(
            json!({ "defaults": { "harness": "claude", "model": "m" }, "assign": { "02": { "harness": "gemini" } } }),
        );
        let out = resolve_pool_assignments(
            &markers,
            &config,
            &table(&["claude", "cursor", "opencode"]),
            None,
        );
        assert_eq!(out.assignments.keys().collect::<Vec<_>>(), ["01"]);
        assert_eq!(
            out.failures,
            IndexMap::from([
                ("02".to_owned(), "pool config: ticket 02 names unknown harness 'gemini'. Known: claude, cursor, opencode".to_owned()),
                ("02-spawn-1".to_owned(), "pool config: ticket 02-spawn-1: parent 02 did not resolve".to_owned()),
                ("conv-3-spawn-1".to_owned(), "pool config: ticket conv-3-spawn-1: parent conv-3 has no Assignment".to_owned()),
                (
                    "conv-3-spawn-1-spawn-1".to_owned(),
                    "pool config: ticket conv-3-spawn-1-spawn-1: parent conv-3-spawn-1 did not resolve".to_owned()
                ),
                ("a".to_owned(), "pool config: ticket a: spawned-by cycle: a -> b -> a".to_owned()),
                ("b".to_owned(), "pool config: ticket b: spawned-by cycle: b -> a -> b".to_owned()),
            ])
        );
    }

    #[test]
    fn reads_a_hand_written_assign_array_by_index_as_the_typescript_does() {
        let config = config(json!({ "defaults": "nope", "assign": [{ "harness": "x" }] }));
        let out = resolve_pool_assignments(
            &[MarkerFacts::new("0"), MarkerFacts::new("1")],
            &config,
            &harnesses(),
            None,
        );
        assert_eq!(
            out.failures["0"],
            format!("pool config: ticket 0 names unknown harness 'x'. {KNOWN}")
        );
        assert_eq!(
            out.assignments["1"],
            assignment(json!({ "harness": "", "model": "", "drivers": "implement" }))
        );
    }

    #[test]
    fn resolves_from_a_seeded_conversation_and_leaves_a_seeded_id_alone() {
        let markers = vec![spawned("conv-3-spawn-1", "conv-3"), MarkerFacts::new("01")];
        let mut seed = Assignments::new();
        seed.insert(
            "conv-3".into(),
            assignment(json!({ "harness": "codex", "model": "o3", "drivers": "implement" })),
        );
        seed.insert(
            "01".into(),
            assignment(json!({ "harness": "claude", "model": "frozen", "drivers": "implement" })),
        );
        let out = resolve_pool_assignments(&markers, &stub_config(), &harnesses(), Some(&seed));
        assert_eq!(out.assignments["conv-3-spawn-1"].model, "o3");
        assert_eq!(out.assignments["01"].model, "frozen");
        assert!(!out.sources.contains_key("01"));
    }

    #[test]
    fn fails_the_unseen_pass_whole_on_the_first_failure() {
        let markers = vec![spawned("x", "conv-9"), MarkerFacts::new("01")];
        let mut assignments = Assignments::new();
        let error =
            resolve_unseen_assignments(&markers, &mut assignments, &stub_config(), &harnesses())
                .unwrap_err();
        assert_eq!(
            error.0,
            "pool config: ticket x: parent conv-9 has no Assignment"
        );
        let config = config(json!({ "assign": { "01": { "harness": "gemini" } } }));
        let error = resolve_unseen_assignments(
            &[MarkerFacts::new("01")],
            &mut Assignments::new(),
            &config,
            &harnesses(),
        )
        .unwrap_err();
        assert_eq!(
            error.0,
            format!("pool config: ticket 01 names unknown harness 'gemini'. {KNOWN}")
        );
    }

    #[test]
    fn names_an_unresolved_judges_build_ticket() {
        let markers = vec![MarkerFacts::new("01-grader-1"), spawned("01", "conv-1")];
        let out = resolve_pool_assignments(&markers, &stub_config(), &harnesses(), None);
        assert_eq!(
            out.failures["01-grader-1"],
            "pool config: ticket 01-grader-1: build ticket 01 did not resolve"
        );
        assert_eq!(
            out.failures["01"],
            "pool config: ticket 01: parent conv-1 has no Assignment"
        );
    }
}
