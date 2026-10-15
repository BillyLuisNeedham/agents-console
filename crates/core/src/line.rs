//! The Factory's Line (issue #187, ADR-0037, ADR-0038): the Line brief, the built-in Factory
//! settings, the typed verdicts a Station writes in its Outcome, the routing from one Station to the
//! next with its two counters, and the Station Tickets the engine writes. Everything here is a decision
//! over values; the engine's `line` module reads the pool and writes what these return.
//!
//! The Line runs Rounds of Implement, Prove, Review and Decide. A Prove fail sends the Round back to a
//! fix Implement; past `limits.proveFailsPerRound` failures the next fix is written at a checkpoint,
//! and each Resume of it buys one more. Decide starts another Round (at most `limits.extraRounds` past
//! the first) or ends the Line at the Finish checkpoint, a Ticket no agent runs: Resume "approved" ends
//! the Line, Resume with notes starts another Round. Closing a Station Ticket halts the Line: Decide
//! still runs, then the Line waits at the Finish checkpoint.

use std::path::{Path, PathBuf};

use ac_protocol::{
    DecideChoice, DecideItem, DecideVerdict, FactorySettings, FactoryStations, FindingSeverity,
    LineBrief, LineProve, LineRound, LineState, LineStatus, Outcome, OutcomeStatus, ProveResult,
    ProveVerdict, ReviewVerdict, SpawnAssignRequest, Station, StationAssign, StationSettings,
};
use serde_json::Value;

use crate::js;
use crate::outcome::ValidOutcome;
use crate::pool::encode_spawn_assign;

/// `line.json` in the pool directory: the Line's state.
pub const LINE_FILE: &str = "line.json";

/// Where the Grill writes a Line brief, and where Start the Line looks for one when none is named.
pub const BRIEF_DIR: &str = "docs/specs";
pub const BRIEF_SUFFIX: &str = ".brief.json";

/// The first line of the Brief an Outcome without a valid verdict checkpoints with.
pub const NO_VERDICT: &str = "no verdict";

/// What the operator answers on the Finish checkpoint to end the Line.
pub const APPROVED: &str = "approved";

// ---------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------

/// One Station's settings with every field filled in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedStation {
    pub enabled: bool,
    pub drivers: String,
    pub harness: String,
    pub model: String,
    pub effort: String,
    pub note: String,
}

impl ResolvedStation {
    /// The Station's Assignment as the `spawn-assign` token on its Tickets carries it.
    pub fn assign(&self) -> SpawnAssignRequest {
        let some = |text: &str| (!text.is_empty()).then(|| text.to_owned());
        SpawnAssignRequest {
            harness: some(&self.harness),
            model: some(&self.model),
            effort: some(&self.effort),
            drivers: some(&self.drivers),
        }
    }
}

/// The Factory settings a Line runs on: the built-in defaults under the Machine defaults' layer, the
/// Pool settings' and the Line brief's, each field falling through on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFactory {
    pub implement: ResolvedStation,
    pub prove: ResolvedStation,
    pub review: ResolvedStation,
    pub decide: ResolvedStation,
    pub grill: ResolvedStation,
    pub prove_fails_per_round: u64,
    pub extra_rounds: u64,
    pub finish: String,
}

fn station_default(drivers: &str, effort: &str) -> ResolvedStation {
    ResolvedStation {
        enabled: true,
        drivers: drivers.to_owned(),
        harness: "claude".to_owned(),
        model: "opus".to_owned(),
        effort: effort.to_owned(),
        note: String::new(),
    }
}

/// The built-in Factory settings (the spec's `factory` block).
pub fn default_factory() -> ResolvedFactory {
    ResolvedFactory {
        implement: station_default("implement", "high"),
        prove: station_default("my-verify", "medium"),
        review: station_default("code-review", "high"),
        decide: station_default("html", "medium"),
        grill: station_default("my-grill-with-docs show-me", "high"),
        prove_fails_per_round: 2,
        extra_rounds: 1,
        finish: "none".to_owned(),
    }
}

// One string field of a layer: set and not blank, or it falls through.
fn take(base: &mut String, field: Option<&String>) {
    if let Some(value) = field.map(|v| js::trim(v)).filter(|v| !v.is_empty()) {
        value.clone_into(base);
    }
}

// `enabled` reaches only a Station that can be switched off (Prove, Review): a layer that switches off
// Implement or Decide is refused where it is written, and never obeyed here.
fn overlay_station(base: &mut ResolvedStation, layer: Option<&StationSettings>, switchable: bool) {
    let Some(layer) = layer else {
        return;
    };
    if let Some(enabled) = layer.enabled.filter(|_| switchable) {
        base.enabled = enabled;
    }
    take(&mut base.drivers, layer.drivers.as_ref());
    take(&mut base.note, layer.note.as_ref());
    if let Some(assign) = &layer.assign {
        take(&mut base.harness, assign.harness.as_ref());
        take(&mut base.model, assign.model.as_ref());
        take(&mut base.effort, assign.effort.as_ref());
    }
}

/// One settings layer over `base`, each field falling through on its own.
pub fn overlay_factory(base: &mut ResolvedFactory, layer: &FactorySettings) {
    if let Some(stations) = &layer.stations {
        overlay_station(&mut base.implement, stations.implement.as_ref(), false);
        overlay_station(&mut base.prove, stations.prove.as_ref(), true);
        overlay_station(&mut base.review, stations.review.as_ref(), true);
        overlay_station(&mut base.decide, stations.decide.as_ref(), false);
        overlay_station(&mut base.grill, stations.grill.as_ref(), false);
    }
    if let Some(limits) = &layer.limits {
        if let Some(fails) = limits.prove_fails_per_round {
            base.prove_fails_per_round = fails;
        }
        if let Some(extra) = limits.extra_rounds {
            base.extra_rounds = extra;
        }
    }
    take(&mut base.finish, layer.finish.as_ref());
}

/// The two settings layers under a Line brief: the Machine defaults' `factory` and the Pool settings'.
/// The engine reads both afresh at each super-step boundary (ADR-0018), so a change reaches the next
/// Station Ticket it writes and never one already written.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FactoryLayers {
    pub machine: Option<FactorySettings>,
    pub pool: Option<FactorySettings>,
}

/// The settings a Line runs on: the built-in defaults, the Machine defaults, the Pool settings, then
/// the brief's `factory` and its `finish`, each field falling through on its own.
pub fn resolve_factory(layers: &FactoryLayers, brief: &LineBrief) -> ResolvedFactory {
    let mut factory = default_factory();
    for layer in [&layers.machine, &layers.pool, &brief.factory]
        .into_iter()
        .flatten()
    {
        overlay_factory(&mut factory, layer);
    }
    if let Some(finish) = brief.finish.as_deref().filter(|f| !js::trim(f).is_empty()) {
        js::trim(finish).clone_into(&mut factory.finish);
    }
    factory
}

const STATION_KEYS: [&str; 5] = ["implement", "prove", "review", "decide", "grill"];

fn station_layer<'a>(stations: &'a FactoryStations, key: &str) -> Option<&'a StationSettings> {
    match key {
        "implement" => stations.implement.as_ref(),
        "prove" => stations.prove.as_ref(),
        "review" => stations.review.as_ref(),
        "decide" => stations.decide.as_ref(),
        _ => stations.grill.as_ref(),
    }
}

/// What every layer of Factory settings must hold to: only Prove and Review switch off, and a Station's
/// drivers, when a layer names them, are not blank. The reason names the field.
pub fn check_factory_layer(layer: &FactorySettings) -> Result<(), String> {
    let Some(stations) = &layer.stations else {
        return Ok(());
    };
    for key in STATION_KEYS {
        let Some(station) = station_layer(stations, key) else {
            continue;
        };
        if station.enabled == Some(false) && !matches!(key, "prove" | "review") {
            return Err(format!(
                "factory.stations.{key}.enabled is false: only Prove and Review can be switched off"
            ));
        }
        if station.drivers.as_deref().is_some_and(blank) {
            return Err(format!("factory.stations.{key}.drivers is blank"));
        }
    }
    Ok(())
}

// A field's text trimmed, `None` when it is blank.
fn tidy(text: Option<String>) -> Option<String> {
    text.map(|t| js::trim(&t).to_owned())
        .filter(|t| !t.is_empty())
}

fn tidy_station(station: Option<StationSettings>) -> Option<StationSettings> {
    let station = station?;
    let assign = station.assign.and_then(|assign| {
        let assign = StationAssign {
            harness: tidy(assign.harness),
            model: tidy(assign.model),
            effort: tidy(assign.effort),
        };
        (assign.harness.is_some() || assign.model.is_some() || assign.effort.is_some())
            .then_some(assign)
    });
    let station = StationSettings {
        enabled: station.enabled,
        drivers: tidy(station.drivers),
        assign,
        note: tidy(station.note),
    };
    let empty = station.enabled.is_none()
        && station.drivers.is_none()
        && station.assign.is_none()
        && station.note.is_none();
    (!empty).then_some(station)
}

// A limit the Settings pane's text input sent as digits is read as its number; "" is no value.
fn limits_as_numbers(value: &mut Value) {
    let Some(limits) = value.get_mut("limits").and_then(Value::as_object_mut) else {
        return;
    };
    for limit in limits.values_mut() {
        if let Value::String(text) = limit {
            let trimmed = js::trim(text);
            *limit = if trimmed.is_empty() {
                Value::Null
            } else if let Ok(n) = trimmed.parse::<u64>() {
                Value::from(n)
            } else {
                continue;
            };
        }
    }
}

/// A layer of Factory settings as the Settings pane or a file writes it, checked and tidied: strings
/// trimmed, blank fields and empty objects dropped, `None` when nothing is left. The reason, prefixed
/// with `subject`, names the field that is wrong.
pub fn normalise_factory(value: &Value, subject: &str) -> Result<Option<FactorySettings>, String> {
    if !value.is_object() {
        return Err(format!("{subject} must be an object"));
    }
    let mut value = value.clone();
    limits_as_numbers(&mut value);
    let layer: FactorySettings =
        serde_json::from_value(value).map_err(|e| format!("{subject}: {e}"))?;
    let stations = layer.stations.and_then(|stations| {
        let stations = FactoryStations {
            implement: tidy_station(stations.implement),
            prove: tidy_station(stations.prove),
            review: tidy_station(stations.review),
            decide: tidy_station(stations.decide),
            grill: tidy_station(stations.grill),
        };
        let empty = stations.implement.is_none()
            && stations.prove.is_none()
            && stations.review.is_none()
            && stations.decide.is_none()
            && stations.grill.is_none();
        (!empty).then_some(stations)
    });
    let limits = layer
        .limits
        .filter(|limits| limits.prove_fails_per_round.is_some() || limits.extra_rounds.is_some());
    let layer = FactorySettings {
        stations,
        limits,
        finish: tidy(layer.finish),
    };
    check_factory_layer(&layer).map_err(|reason| format!("{subject}: {reason}"))?;
    let empty = layer.stations.is_none() && layer.limits.is_none() && layer.finish.is_none();
    Ok((!empty).then_some(layer))
}

/// A layer read where a bad one must not stop anything (a hand-edited Machine defaults file): the
/// layer when it is valid, otherwise none.
pub fn factory_layer_of(value: Option<&Value>) -> Option<FactorySettings> {
    normalise_factory(value?, "factory").ok().flatten()
}

impl ResolvedFactory {
    pub fn station(&self, station: Station) -> &ResolvedStation {
        match station {
            Station::Implement | Station::Finish => &self.implement,
            Station::Prove => &self.prove,
            Station::Review => &self.review,
            Station::Decide => &self.decide,
        }
    }
}

// ---------------------------------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------------------------------

/// A Line brief's text read and checked: the reason when it is not one.
pub fn parse_brief(text: &str) -> Result<LineBrief, String> {
    let value: Value = js::parse(text).map_err(|e| format!("not valid JSON ({e})"))?;
    if !value.is_object() {
        return Err("not a JSON object".into());
    }
    let brief: LineBrief = serde_json::from_value(value).map_err(|e| e.to_string())?;
    if js::trim(&brief.spec).is_empty() {
        return Err("spec is blank: it must name the Line's spec".into());
    }
    if brief
        .finish
        .as_deref()
        .is_some_and(|finish| js::trim(finish).is_empty())
    {
        return Err("finish is blank: leave it out for the default, or name the Finish".into());
    }
    if let Some(layer) = &brief.factory {
        check_factory_layer(layer)?;
    }
    Ok(brief)
}

/// Where a Line brief and the spec it names are read: the pool checkout on disk, or the committed tree
/// of the Grill's branch (Start the Line on the Grill reads there before it merges anything).
pub trait BriefPlace {
    /// How a reason names the place: "the pool checkout".
    fn name(&self) -> String;
    /// The file names directly under `dir`, a path relative to the place.
    fn names_in(&self, dir: &str) -> Vec<String>;
    /// The text of the file at `path`: `None` when there is no file there.
    fn read(&self, path: &str) -> Option<Result<String, String>>;
}

/// The pool checkout on disk.
pub struct CheckoutPlace<'a>(pub &'a Path);

impl BriefPlace for CheckoutPlace<'_> {
    fn name(&self) -> String {
        "the pool checkout".to_owned()
    }
    fn names_in(&self, dir: &str) -> Vec<String> {
        std::fs::read_dir(self.0.join(dir))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default()
    }
    fn read(&self, path: &str) -> Option<Result<String, String>> {
        let file = self.0.join(path);
        file.is_file()
            .then(|| js::read_text(&file).map_err(|e| e.to_string()))
    }
}

/// Where Start the Line reads its brief: the named path in the pool checkout, or else the one
/// `docs/specs/*.brief.json` there. The path comes back relative to the checkout.
pub fn find_brief(checkout: &Path, named: Option<&str>) -> Result<String, String> {
    find_brief_in(&CheckoutPlace(checkout), named)
}

/// [`find_brief`] in any [`BriefPlace`].
pub fn find_brief_in(place: &dyn BriefPlace, named: Option<&str>) -> Result<String, String> {
    if let Some(named) = named.map(js::trim).filter(|n| !n.is_empty()) {
        return Ok(named.to_owned());
    }
    let mut found: Vec<String> = place
        .names_in(BRIEF_DIR)
        .into_iter()
        .filter(|name| name.ends_with(BRIEF_SUFFIX))
        .collect();
    found.sort();
    match found.as_slice() {
        [] => Err(format!(
            "no Line brief: {BRIEF_DIR}/ in {} holds no *{BRIEF_SUFFIX}",
            place.name()
        )),
        [one] => Ok(format!("{BRIEF_DIR}/{one}")),
        many => Err(format!(
            "more than one Line brief in {BRIEF_DIR}/ ({}): name one as brief",
            many.join(", ")
        )),
    }
}

// A path the brief or its spec may take: relative, and never climbing out of the pool checkout.
fn in_checkout(path: &str) -> bool {
    let path = Path::new(js::trim(path));
    !path.is_absolute()
        && path.components().all(|c| {
            matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

/// Read and check the Line brief at `path` (relative to the checkout), and that the spec it names is
/// there. Every reason names the brief.
pub fn read_brief(checkout: &Path, path: &str) -> Result<LineBrief, String> {
    read_brief_in(&CheckoutPlace(checkout), path)
}

/// [`read_brief`] in any [`BriefPlace`].
pub fn read_brief_in(place: &dyn BriefPlace, path: &str) -> Result<LineBrief, String> {
    let name = place.name();
    if !in_checkout(path) {
        return Err(format!(
            "the Line brief's path {path} must be relative to {name} and stay inside it"
        ));
    }
    let Some(text) = place.read(path) else {
        return Err(format!("no Line brief at {path} in {name}"));
    };
    let text = text.map_err(|e| format!("Line brief {path}: {e}"))?;
    let brief = parse_brief(&text).map_err(|reason| format!("Line brief {path}: {reason}"))?;
    let spec = js::trim(&brief.spec);
    if !in_checkout(spec) {
        return Err(format!(
            "Line brief {path}: its spec {spec} must be relative to {name} and stay inside it"
        ));
    }
    if place.read(spec).is_none() {
        return Err(format!("Line brief {path}: its spec {spec} is not in {name}"));
    }
    Ok(brief)
}

// ---------------------------------------------------------------------------------------------------
// The Line's state on disk
// ---------------------------------------------------------------------------------------------------

pub fn line_path(pool_dir: &Path) -> PathBuf {
    pool_dir.join(LINE_FILE)
}

/// The pool's Line, `None` when no Line has started. A file that does not parse stops the load: the
/// Line's routing cannot be guessed.
pub fn load_line(pool_dir: &Path) -> anyhow::Result<Option<LineState>> {
    let file = line_path(pool_dir);
    if !file.exists() {
        return Ok(None);
    }
    let text = js::read_text(&file)?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| anyhow::anyhow!("pool load: {}: {e}", file.display()))
}

/// Write the Line's state whole, through a rename.
pub fn save_line(pool_dir: &Path, line: &LineState) -> anyhow::Result<()> {
    let file = line_path(pool_dir);
    let mut aside = file.clone().into_os_string();
    aside.push(".tmp");
    js::write_through_rename(
        &file,
        Path::new(&aside),
        &js::stringify_pretty(&serde_json::to_value(line)?),
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------------------------------

/// What a Station's verdict is checked against: the Station, and for Decide the titles of the must
/// findings it has to account for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerdictCheck {
    pub station: Station,
    pub musts: Vec<String>,
}

fn verdict_of<T: serde::de::DeserializeOwned>(verdict: Option<&Value>) -> Result<T, String> {
    let Some(verdict) = verdict else {
        return Err("the Outcome has no verdict".into());
    };
    serde_json::from_value(verdict.clone()).map_err(|e| format!("the verdict does not parse: {e}"))
}

fn blank(text: &str) -> bool {
    js::trim(text).is_empty()
}

/// Prove's verdict, checked.
pub fn prove_verdict(verdict: Option<&Value>) -> Result<ProveVerdict, String> {
    let prove: ProveVerdict = verdict_of(verdict)?;
    if blank(&prove.evidence) {
        return Err("the verdict's evidence is blank: give the path of the evidence".into());
    }
    Ok(prove)
}

/// Review's verdict, checked.
pub fn review_verdict(verdict: Option<&Value>) -> Result<ReviewVerdict, String> {
    let review: ReviewVerdict = verdict_of(verdict)?;
    if let Some(i) = review.findings.iter().position(|f| blank(&f.title)) {
        return Err(format!("finding {} has a blank title", i + 1));
    }
    Ok(review)
}

/// Decide's verdict, checked: a Round names at least one fix, every item has a title and a reason, and
/// every must is accounted for (in the fixes or the dropped on a Round, in the dropped on a finish).
pub fn decide_verdict(verdict: Option<&Value>, musts: &[String]) -> Result<DecideVerdict, String> {
    let decide: DecideVerdict = verdict_of(verdict)?;
    for (list, items) in [("fixes", &decide.fixes), ("dropped", &decide.dropped)] {
        if let Some(i) = items
            .iter()
            .position(|item| blank(&item.title) || blank(&item.reason))
        {
            return Err(format!("{list} item {} needs a title and a reason", i + 1));
        }
    }
    if decide.decide == DecideChoice::Round && decide.fixes.is_empty() {
        return Err("a round names at least one fix".into());
    }
    let named = |items: &[DecideItem], title: &str| {
        items
            .iter()
            .any(|item| js::trim(&item.title) == js::trim(title))
    };
    let missing: Vec<&String> = musts
        .iter()
        .filter(|must| {
            let fixed = decide.decide == DecideChoice::Round && named(&decide.fixes, must);
            !fixed && !named(&decide.dropped, must)
        })
        .collect();
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|m| format!("\"{m}\"")).collect();
        return Err(format!(
            "every must finding has to be {} with a reason; not accounted for: {}",
            if decide.decide == DecideChoice::Round {
                "fixed or dropped"
            } else {
                "dropped (a finish fixes nothing)"
            },
            names.join(", ")
        ));
    }
    Ok(decide)
}

/// Why a Station's verdict is not valid, or `None` when it is (Implement and Finish need none).
pub fn verdict_problem(check: &VerdictCheck, verdict: Option<&Value>) -> Option<String> {
    match check.station {
        Station::Implement | Station::Finish => None,
        Station::Prove => prove_verdict(verdict).err(),
        Station::Review => review_verdict(verdict).err(),
        Station::Decide => decide_verdict(verdict, &check.musts).err(),
    }
}

/// A Station's done Outcome without a valid verdict is a checkpoint with the Brief "no verdict" (the
/// engine never guesses which way the Line goes). A checkpoint Outcome stands as the agent wrote it.
pub fn check_station_outcome(check: &VerdictCheck, mut valid: ValidOutcome) -> ValidOutcome {
    if valid.outcome.status != OutcomeStatus::Done {
        return valid;
    }
    if let Some(problem) = verdict_problem(check, valid.outcome.verdict.as_ref()) {
        valid.outcome.status = OutcomeStatus::Checkpoint;
        valid.outcome.brief = Some(no_verdict_brief(check.station, &problem));
    }
    valid
}

/// The Brief of the no-verdict checkpoint: "no verdict", why, and the shape the Station must write.
pub fn no_verdict_brief(station: Station, problem: &str) -> String {
    format!(
        "{NO_VERDICT}\n\n{problem}. The engine routes this Line from the verdict and never guesses \
         one. Resume (or Keep talking) and record the Outcome again with a valid verdict.\n\n{}",
        verdict_teaching(station).unwrap_or_default()
    )
}

/// What a Station's agent is taught about its verdict, in its prompt and its Ticket.
pub fn verdict_teaching(station: Station) -> Option<String> {
    let shape = match station {
        Station::Implement | Station::Finish => return None,
        Station::Prove => {
            "\"verdict\": {\"prove\": \"pass\" or \"fail\", \"evidence\": \"the path of the \
             evidence you gathered\"}. On a fail, the Outcome's \"brief\" says what failed and how \
             to reproduce it: the fix Implement works from it."
        }
        Station::Review => {
            "\"verdict\": {\"findings\": [{\"severity\": \"must\" or \"should\" or \"nit\", \
             \"title\": \"...\", \"detail\": \"...\"}, ...]}, the list empty when you found nothing. \
             A must is something the Line cannot finish with."
        }
        Station::Decide => {
            "\"verdict\": {\"decide\": \"round\" or \"finish\", \"fixes\": [{\"title\": \"...\", \
             \"reason\": \"...\"}, ...], \"dropped\": [{\"title\": \"...\", \"reason\": \"...\"}, \
             ...]}. A round names at least one fix. Account for every must finding by its exact \
             title: fixed in the next Round or dropped with a reason (on a finish, dropped)."
        }
    };
    Some(format!(
        "This Ticket is the {} Station of a Line. Its Outcome must carry a verdict beside status \
         \"done\": {shape} An Outcome without a valid verdict checkpoints the Ticket with \"{NO_VERDICT}\". \
         The engine routes the Line from the verdict: never propose the next Station yourself.",
        station_name(station)
    ))
}

fn station_name(station: Station) -> &'static str {
    match station {
        Station::Implement => "Implement",
        Station::Prove => "Prove",
        Station::Review => "Review",
        Station::Decide => "Decide",
        Station::Finish => "Finish",
    }
}

// ---------------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------------

/// A Station Ticket the engine writes.
#[derive(Debug, Clone, PartialEq)]
pub struct NewTicket {
    pub id: String,
    pub station: Station,
    pub round: u64,
    pub title: String,
    pub body: String,
    pub blocked_by: Option<String>,
    /// The Station's Assignment; `None` for the Finish checkpoint, which no agent runs.
    pub assign: Option<SpawnAssignRequest>,
    /// The Brief of a Ticket written at a checkpoint (the Prove limit, the Finish).
    pub checkpoint: Option<String>,
}

/// How the current Station Ticket ended, as the engine read it.
#[derive(Debug, Clone, PartialEq)]
pub enum StationEnd<'a> {
    Done(&'a Outcome),
    Closed,
    /// The Finish checkpoint was resumed: approved, or with the operator's notes.
    Approved,
    Notes(String),
}

/// What routing decided.
#[derive(Debug, Clone, PartialEq)]
pub enum Routed {
    Next(Box<NewTicket>),
    /// The operator approved the Finish: the Line is done.
    Done,
    /// The Finish checkpoint was closed: the Line ends there.
    Closed,
}

/// Whether a Resume note on the Finish checkpoint approves it: no note, or "approved".
pub fn approves(note: Option<&str>) -> bool {
    let Some(note) = note.map(js::trim) else {
        return true;
    };
    let word = note.trim_end_matches(['.', '!']).to_lowercase();
    word.is_empty() || word == APPROVED || word == "approve"
}

fn round_of(line: &mut LineState) -> &mut LineRound {
    if line.rounds.last().is_none_or(|r| r.round != line.round) {
        line.rounds.push(LineRound {
            round: line.round,
            proves: Vec::new(),
            findings: Vec::new(),
            decide: None,
        });
    }
    line.rounds.last_mut().expect("the round was just pushed")
}

fn begin_round(line: &mut LineState, round: u64) {
    line.round = round;
    line.prove_fails = 0;
    line.fixes_bought = 0;
    line.gated = false;
    round_of(line);
}

/// The Line as it starts, and its first Ticket.
pub fn start_line(
    brief: LineBrief,
    brief_path: &str,
    factory: &ResolvedFactory,
) -> (LineState, NewTicket) {
    let mut line = LineState {
        brief,
        brief_path: brief_path.to_owned(),
        status: LineStatus::Running,
        round: 1,
        station: Station::Implement,
        ticket: String::new(),
        prove_fails: 0,
        fixes_bought: 0,
        gated: false,
        extra_rounds: 0,
        halted: None,
        rounds: Vec::new(),
    };
    begin_round(&mut line, 1);
    let ticket = implement_ticket(&line, factory, None, Body::First);
    point_at(&mut line, &ticket);
    (line, ticket)
}

fn point_at(line: &mut LineState, ticket: &NewTicket) {
    line.station = ticket.station;
    ticket.id.clone_into(&mut line.ticket);
    line.gated = ticket.station == Station::Implement && ticket.checkpoint.is_some();
    line.status = if ticket.station == Station::Finish {
        LineStatus::Finish
    } else {
        LineStatus::Running
    };
}

/// Route the current Station Ticket's ending: the Line's state moves on, and the next Ticket (if any)
/// comes back for the engine to write. An error is a verdict that does not parse, which the engine
/// turns into the no-verdict checkpoint.
pub fn route(
    line: &mut LineState,
    factory: &ResolvedFactory,
    end: StationEnd<'_>,
) -> Result<Routed, String> {
    let from = line.ticket.clone();
    let routed = match (line.station, end) {
        (Station::Finish, StationEnd::Approved | StationEnd::Done(_)) => {
            line.status = LineStatus::Done;
            return Ok(Routed::Done);
        }
        (Station::Finish, StationEnd::Closed) => {
            line.status = LineStatus::Closed;
            return Ok(Routed::Closed);
        }
        (Station::Finish, StationEnd::Notes(notes)) => {
            line.halted = None;
            let next = line.round + 1;
            begin_round(line, next);
            implement_ticket(line, factory, Some(&from), Body::Notes(&notes))
        }
        (_, StationEnd::Approved | StationEnd::Notes(_)) => {
            return Err(format!("{from} is not the Finish checkpoint"));
        }
        (Station::Decide, StationEnd::Closed) => {
            line.halted
                .get_or_insert_with(|| format!("{from} was closed"));
            finish_ticket(
                line,
                factory,
                None,
                "Decide was closed, so there is no report from it.",
            )
        }
        (_, StationEnd::Closed) => {
            line.halted = Some(format!("{from} was closed"));
            decide_ticket(line, factory, None)
        }
        (Station::Implement, StationEnd::Done(_)) => {
            if line.gated {
                line.fixes_bought += 1;
            }
            after_implement(line, factory, &from)
        }
        (Station::Prove, StationEnd::Done(outcome)) => {
            let verdict = prove_verdict(outcome.verdict.as_ref())?;
            round_of(line).proves.push(LineProve {
                ticket: from.clone(),
                prove: verdict.prove,
                evidence: verdict.evidence.clone(),
            });
            match verdict.prove {
                ProveResult::Pass => after_prove(line, factory, &from),
                ProveResult::Fail => {
                    line.prove_fails += 1;
                    fix_ticket(line, factory, &from, outcome, &verdict)
                }
            }
        }
        (Station::Review, StationEnd::Done(outcome)) => {
            let verdict = review_verdict(outcome.verdict.as_ref())?;
            round_of(line).findings = verdict.findings;
            decide_ticket(line, factory, Some(&from))
        }
        (Station::Decide, StationEnd::Done(outcome)) => {
            let verdict = decide_verdict(outcome.verdict.as_ref(), &musts_of(line))?;
            round_of(line).decide = Some(verdict.clone());
            if line.halted.is_some() || verdict.decide == DecideChoice::Finish {
                finish_ticket(line, factory, Some(&from), "")
            } else if line.extra_rounds >= factory.extra_rounds {
                finish_ticket(
                    line,
                    factory,
                    Some(&from),
                    &format!(
                        "Decide chose another Round, but the Line has started its {} extra \
                         Round{} already (limits.extraRounds). Resume with notes to start one \
                         anyway.",
                        factory.extra_rounds,
                        if factory.extra_rounds == 1 { "" } else { "s" }
                    ),
                )
            } else {
                line.extra_rounds += 1;
                let next = line.round + 1;
                begin_round(line, next);
                implement_ticket(line, factory, Some(&from), Body::Fixes(&verdict))
            }
        }
    };
    point_at(line, &routed);
    Ok(Routed::Next(Box::new(routed)))
}

/// The titles of the current Round's must findings: what Decide must account for.
pub fn musts_of(line: &LineState) -> Vec<String> {
    line.rounds
        .iter()
        .rfind(|r| r.round == line.round)
        .map(|r| {
            r.findings
                .iter()
                .filter(|f| f.severity == FindingSeverity::Must)
                .map(|f| f.title.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// The verdict check for a Ticket of this Line's: its Station, and for Decide this Round's musts.
pub fn verdict_check(line: &LineState, station: Station) -> VerdictCheck {
    VerdictCheck {
        station,
        musts: if station == Station::Decide {
            musts_of(line)
        } else {
            Vec::new()
        },
    }
}

fn after_implement(line: &mut LineState, factory: &ResolvedFactory, from: &str) -> NewTicket {
    if factory.prove.enabled {
        prove_ticket(line, factory, from)
    } else {
        after_prove(line, factory, from)
    }
}

fn after_prove(line: &mut LineState, factory: &ResolvedFactory, from: &str) -> NewTicket {
    if factory.review.enabled {
        review_ticket(line, factory, from)
    } else {
        decide_ticket(line, factory, Some(from))
    }
}

// ---------------------------------------------------------------------------------------------------
// The Tickets
// ---------------------------------------------------------------------------------------------------

enum Body<'a> {
    First,
    Fixes(&'a DecideVerdict),
    Notes(&'a str),
}

fn spec_section(line: &LineState) -> String {
    format!(
        "## The spec\n\n`{}` in the pool checkout (the Line brief is `{}`). Read it in full before \
         you start: every decision is already made there.",
        js::trim(&line.brief.spec),
        line.brief_path
    )
}

fn note_section(station: &ResolvedStation) -> String {
    if blank(&station.note) {
        String::new()
    } else {
        format!(
            "\n\n## Note for this Station\n\n{}",
            js::trim(&station.note)
        )
    }
}

fn verdict_section(station: Station) -> String {
    verdict_teaching(station)
        .map(|t| format!("\n\n## Your verdict\n\n{t}"))
        .unwrap_or_default()
}

fn ticket(
    line: &LineState,
    factory: &ResolvedFactory,
    id: String,
    station: Station,
    title: String,
    work: String,
    blocked_by: Option<&str>,
) -> NewTicket {
    let settings = factory.station(station);
    NewTicket {
        id,
        station,
        round: line.round,
        title,
        body: format!(
            "{}\n\n{work}{}{}",
            spec_section(line),
            note_section(settings),
            verdict_section(station)
        ),
        blocked_by: blocked_by.map(str::to_owned),
        assign: Some(settings.assign()),
        checkpoint: None,
    }
}

fn finding_detail(line: &LineState, round: u64, title: &str) -> Option<String> {
    line.rounds
        .iter()
        .find(|r| r.round == round)?
        .findings
        .iter()
        .find(|f| js::trim(&f.title) == js::trim(title))
        .map(|f| format!("{} ({})", f.detail, f.severity))
}

fn implement_ticket(
    line: &LineState,
    factory: &ResolvedFactory,
    from: Option<&str>,
    body: Body<'_>,
) -> NewTicket {
    let n = line.round;
    let work = match body {
        Body::First => "## What to do\n\nBuild what the spec asks for, with tests, and commit to \
                        the current branch. Your work merges onto the Line's branch when you \
                        finish; Prove then runs it end to end."
            .to_owned(),
        Body::Fixes(verdict) => {
            let item = |item: &DecideItem| {
                let detail = finding_detail(line, n - 1, &item.title)
                    .map(|d| format!("\n  {d}"))
                    .unwrap_or_default();
                format!("- **{}**: {}{detail}", js::trim(&item.title), item.reason)
            };
            let fixes: Vec<String> = verdict.fixes.iter().map(item).collect();
            let dropped: Vec<String> = verdict
                .dropped
                .iter()
                .map(|d| format!("- {}: {}", js::trim(&d.title), d.reason))
                .collect();
            format!(
                "## What to do\n\nRound {n}: Decide chose these fixes from Round {}'s Review. \
                 Make each one on top of the work already on the Line's branch, with tests, and \
                 commit.\n\n{}{}",
                n - 1,
                fixes.join("\n"),
                if dropped.is_empty() {
                    String::new()
                } else {
                    format!(
                        "\n\nDropped, so leave them alone:\n\n{}",
                        dropped.join("\n")
                    )
                }
            )
        }
        Body::Notes(notes) => format!(
            "## What to do\n\nRound {n}: the operator answered the Finish checkpoint with notes \
             instead of approving the Line. Act on them on top of the work already on the Line's \
             branch, with tests, and commit.\n\n## The operator's notes\n\n{}",
            js::trim(notes)
        ),
    };
    ticket(
        line,
        factory,
        format!("r{n}-implement"),
        Station::Implement,
        format!("Implement, Round {n}"),
        work,
        from,
    )
}

fn prove_ticket(line: &LineState, factory: &ResolvedFactory, from: &str) -> NewTicket {
    let n = line.round;
    let k = line
        .rounds
        .iter()
        .rfind(|r| r.round == n)
        .map_or(0, |r| r.proves.len())
        + 1;
    let id = if k == 1 {
        format!("r{n}-prove")
    } else {
        format!("r{n}-prove-{k}")
    };
    let work = "## What to do\n\nProve the Round's work, already merged on the Line's branch: \
                run the change end to end the way it will be used and gather evidence that it \
                works or that it does not. This is not a code review. Keep the evidence in a file \
                in your working directory, commit it, and name its path in your verdict. A fail \
                sends the Round back to a fix Implement with your brief, so say exactly what failed \
                and how to reproduce it."
        .to_owned();
    ticket(
        line,
        factory,
        id,
        Station::Prove,
        format!(
            "Prove, Round {n}{}",
            if k == 1 {
                String::new()
            } else {
                format!(" (run {k})")
            }
        ),
        work,
        Some(from),
    )
}

fn fix_ticket(
    line: &LineState,
    factory: &ResolvedFactory,
    from: &str,
    outcome: &Outcome,
    verdict: &ProveVerdict,
) -> NewTicket {
    let n = line.round;
    let k = line.prove_fails;
    let failure = outcome
        .brief
        .as_deref()
        .filter(|b| !blank(b))
        .unwrap_or(&outcome.summary);
    let work = format!(
        "## What to do\n\nProve failed in Round {n} ({from}). The Round's work is already merged \
         on the Line's branch: fix what Prove found on top of it, with tests, and commit. Prove \
         runs again when you finish.\n\n## What Prove found\n\n{}\n\nEvidence: `{}`",
        js::trim(failure),
        js::trim(&verdict.evidence)
    );
    let mut fix = ticket(
        line,
        factory,
        format!("r{n}-fix-{k}"),
        Station::Implement,
        format!("Fix {k}, Round {n}"),
        work,
        Some(from),
    );
    let allowed = factory.prove_fails_per_round + line.fixes_bought;
    if k > allowed {
        fix.checkpoint = Some(format!(
            "Prove has failed {k} times in Round {n} (limits.proveFailsPerRound is {}), so the \
             Line stopped before this fix. Resume, with a note for the fix if you have one, to buy \
             one more fix: the note goes into this Ticket. Close halts the Line: Decide still \
             runs, then the Line waits at its Finish checkpoint.",
            factory.prove_fails_per_round
        ));
    }
    fix
}

fn review_ticket(line: &LineState, factory: &ResolvedFactory, from: &str) -> NewTicket {
    let n = line.round;
    let work = "## What to do\n\nReview the work on the Line's branch (the changes since it left \
                main) against the spec and the repository's standards. Prove has passed it. \
                Report each finding with a severity: must (the Line cannot finish with it), \
                should, or nit. Change no code."
        .to_owned();
    ticket(
        line,
        factory,
        format!("r{n}-review"),
        Station::Review,
        format!("Review, Round {n}"),
        work,
        Some(from),
    )
}

fn decide_ticket(line: &LineState, factory: &ResolvedFactory, from: Option<&str>) -> NewTicket {
    let n = line.round;
    let round = line.rounds.iter().rfind(|r| r.round == n);
    let proves: Vec<String> = round
        .map(|r| {
            r.proves
                .iter()
                .map(|p| format!("- {}: {} (evidence `{}`)", p.ticket, p.prove, p.evidence))
                .collect()
        })
        .unwrap_or_default();
    let findings: Vec<String> = round
        .map(|r| {
            r.findings
                .iter()
                .map(|f| {
                    format!(
                        "- [{}] **{}**: {}",
                        f.severity,
                        js::trim(&f.title),
                        f.detail
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let left = factory.extra_rounds.saturating_sub(line.extra_rounds);
    let choice = match &line.halted {
        Some(why) => format!(
            "The Line was halted ({why}). Start no Round: record \"finish\", dropping every must \
             with the reason that the Line was halted. The operator decides what next at the \
             Finish checkpoint."
        ),
        None if left == 0 => "No extra Round is left: record \"finish\", dropping every must \
                              with a reason."
            .to_owned(),
        None => format!(
            "Choose: another Round (with the fixes you pick: every must, and any shoulds and nits \
             worth it) or the Finish. {left} extra Round{} left.",
            if left == 1 { " is" } else { "s are" }
        ),
    };
    let work = format!(
        "## What to do\n\nDecide how Round {n} ends. {choice}\n\nOn finish, carry out the \
         Finish before you record it: `{}` (`none` is only the verdict). The operator approves the \
         Line at the Finish checkpoint the engine raises next.\n\n## Prove in this Round\n\n{}\n\n\
         ## Review findings\n\n{}",
        js::trim(&factory.finish),
        if proves.is_empty() {
            "_(none)_".to_owned()
        } else {
            proves.join("\n")
        },
        if findings.is_empty() {
            "_(none)_".to_owned()
        } else {
            findings.join("\n")
        }
    );
    ticket(
        line,
        factory,
        format!("r{n}-decide"),
        Station::Decide,
        format!("Decide, Round {n}"),
        work,
        from,
    )
}

fn finish_ticket(
    line: &LineState,
    factory: &ResolvedFactory,
    from: Option<&str>,
    why: &str,
) -> NewTicket {
    let n = line.round;
    let halted = line
        .halted
        .as_ref()
        .map(|h| format!("The Line was halted: {h}. "))
        .unwrap_or_default();
    let brief = format!(
        "The Line has reached its Finish after Round {n}. {halted}{why}{}Resume with \"{APPROVED}\" \
         (or no note) to approve the Line and end it; Resume with notes to start another Round \
         that acts on them; Close ends the Line here.",
        if why.is_empty() { "" } else { " " }
    );
    NewTicket {
        id: format!("r{n}-finish"),
        station: Station::Finish,
        round: n,
        title: format!("Finish, after Round {n}"),
        body: format!(
            "{}\n\n## The Finish checkpoint\n\nNo agent runs this Ticket: it is where the operator \
             approves the Line. Finish: `{}`.",
            spec_section(line),
            js::trim(&factory.finish)
        ),
        blocked_by: from.map(str::to_owned),
        assign: None,
        checkpoint: Some(brief),
    }
}

/// A Station Ticket's whole file: the ordinary state line plus its `station` and, for a Station an
/// agent runs, its Assignment as the `spawn-assign` token.
pub fn station_ticket_text(ticket: &NewTicket) -> String {
    let assign = ticket
        .assign
        .as_ref()
        .map(|a| format!(" spawn-assign={}", encode_spawn_assign(a)))
        .unwrap_or_default();
    format!(
        "<!-- state: id={} blocked-by={} status=ready station={}{assign} -->\n\n\
         # {}: {}\n\n\
         **Station** {} of this pool's Line, Round {} (ADR-0037): the engine wrote this Ticket \
         from the Line brief and the previous Station's Outcome, and routes its Outcome to the \
         next Station. Never propose the next Station yourself; anything else you propose is held \
         for the operator.\n\n\
         {}\n",
        ticket.id,
        ticket.blocked_by.as_deref().unwrap_or("none"),
        ticket.station,
        ticket.id,
        ticket.title,
        station_name(ticket.station),
        ticket.round,
        ticket.body
    )
}

// ---------------------------------------------------------------------------------------------------
// The Grill
// ---------------------------------------------------------------------------------------------------

/// The prefix of every Line branch Boot cuts (ADR-0038).
pub const LINE_BRANCH_PREFIX: &str = "line/";

/// The Line's name, as its spec and brief are named in `docs/specs/`: the Line branch without its
/// `line/` prefix, or any other branch with its slashes made dashes.
pub fn line_name_of(branch: &str) -> String {
    let name = branch.strip_prefix(LINE_BRANCH_PREFIX).unwrap_or(branch);
    let name = name.replace('/', "-");
    if name.is_empty() { "line".to_owned() } else { name }
}

/// What the Grill is taught beside the Conversation teaching: its skills, the spec and the Line brief it
/// writes and where, and that only the operator's Start the Line hands off.
pub fn grill_teaching(line: &str, drivers: &str) -> String {
    let skills: Vec<&str> = drivers.split_whitespace().collect();
    let skills = if skills.is_empty() {
        String::new()
    } else {
        format!(" Use these skills, in this order: {}.", skills.join(", "))
    };
    format!(
        "You are the Grill of this pool's Line (the Factory, ADR-0037): the Conversation that \
         sharpens one piece of work with the operator before any Station runs.{skills} When the \
         operator agrees the plan, write the spec at `{BRIEF_DIR}/{line}.md` and the Line brief at \
         `{BRIEF_DIR}/{line}{BRIEF_SUFFIX}`, and commit both on your branch. The brief is JSON: \
         {{\"spec\": \"{BRIEF_DIR}/{line}.md\", \"finish\": \"none\", \"factory\": {{}}}}, where finish \
         is none, draft-pr, pr, or a sentence naming another act the Decide Station carries out, \
         and factory holds only the Station settings this Line overrides. The operator then \
         presses Start the Line: the engine merges your branch into the Line's branch, ends this \
         Conversation and starts Round 1. Never start or propose a Station yourself: the engine \
         routes the Line."
    )
}

#[cfg(test)]
mod tests;
