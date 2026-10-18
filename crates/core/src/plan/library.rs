//! The machine's Plan library: one file per Plan under `<home>/.agent-graphs/plans/<slug>.json`,
//! offered after the Presets. `home` is passed in; core never reads the environment.

use ac_protocol::wire::{PlanProblem, PlanSummary};
use serde_json::Value;

use super::parse::at_plan;
use super::{PRESETS, Plan};
use crate::file_lock::{FileLock, write_through_own_temp};
use crate::js;

// The library's writers, one at a time: the server answers saves and deletes on several threads.
static PLANS: FileLock = FileLock::new();

/// Why a library call was refused.
#[derive(Debug, Clone, PartialEq)]
pub enum LibraryError {
    /// The slug is not `[a-z0-9][a-z0-9-]{0,63}`, or is `validate`, which the routes need.
    BadSlug(String),
    /// Presets are read-only: their slugs cannot be saved over or deleted.
    PresetSlug(String),
    NotFound(String),
    /// The Plan does not validate.
    Invalid(Vec<PlanProblem>),
    /// The library file exists but is not JSON.
    Unreadable(String),
    /// Reading the directory or writing the file failed.
    Io(String),
}

/// The refusal text, the same on HTTP and the socket.
impl std::fmt::Display for LibraryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LibraryError::BadSlug(slug) => write!(
                f,
                "plans: `{slug}` is not a Plan slug: use up to 64 lowercase letters, digits and hyphens, starting with a letter or digit, and not `validate`"
            ),
            LibraryError::PresetSlug(slug) => {
                write!(f, "plans: `{slug}` is a Preset, and Presets are read-only")
            }
            LibraryError::NotFound(slug) => write!(f, "plans: there is no Plan `{slug}`"),
            LibraryError::Invalid(problems) => {
                let messages: Vec<_> = problems.iter().map(|p| p.message.as_str()).collect();
                write!(f, "plans: the Plan is invalid: {}", messages.join("; "))
            }
            LibraryError::Unreadable(slug) => {
                write!(f, "plans: the library file for `{slug}` is not JSON")
            }
            LibraryError::Io(err) => write!(f, "plans: {err}"),
        }
    }
}

/// One Plan's file as it stands: a Preset's, or a library file's, valid or not.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredPlan {
    pub slug: String,
    pub preset: bool,
    pub file: Value,
    pub problems: Vec<PlanProblem>,
}

/// `<home>/.agent-graphs/plans`.
pub fn plans_dir(home: &str) -> String {
    js::path_join(&[home, ".agent-graphs", "plans"])
}

fn plan_path(home: &str, slug: &str) -> String {
    js::path_join(&[&plans_dir(home), &format!("{slug}.json")])
}

fn checked_slug(slug: &str) -> Result<(), LibraryError> {
    let mut chars = slug.chars();
    let shaped = slug.len() <= 64
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if shaped && slug != "validate" {
        Ok(())
    } else {
        Err(LibraryError::BadSlug(slug.to_owned()))
    }
}

fn preset(slug: &str) -> Option<&'static super::Preset> {
    PRESETS.iter().find(|preset| preset.slug == slug)
}

fn preset_file(json: &str) -> Value {
    serde_json::from_str(json).unwrap_or(Value::Null)
}

fn summary(slug: &str, preset: bool, file: &Value, problems: Vec<PlanProblem>) -> PlanSummary {
    let text = |key: &str| file.get(key).and_then(Value::as_str).map(str::to_owned);
    PlanSummary {
        slug: slug.to_owned(),
        preset,
        name: text("name")
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| slug.to_owned()),
        author: text("author"),
        source: text("source"),
        note: text("note"),
        problems,
    }
}

/// Presets first, in `PRESETS` order, then library files by slug. A file that fails to parse is
/// listed with its problems and never hides the others. A library file whose slug a Preset holds is
/// left out: the Preset wins.
pub fn list(home: &str) -> Vec<PlanSummary> {
    let mut plans: Vec<PlanSummary> = PRESETS
        .iter()
        .map(|preset| {
            let file = preset_file(preset.json);
            summary(preset.slug, true, &file, Plan::check(&file))
        })
        .collect();
    // A name that is no slug could be neither read back nor deleted through the routes.
    let mut slugs: Vec<String> = js::read_dir_names(plans_dir(home))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|name| name.strip_suffix(".json").map(str::to_owned))
        .filter(|slug| checked_slug(slug).is_ok() && preset(slug).is_none())
        .collect();
    js::sort_strings(&mut slugs);
    plans.extend(slugs.iter().map(|slug| {
        let file = js::read_text(plan_path(home, slug))
            .map_err(|err| err.to_string())
            .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|err| err.to_string()));
        match file {
            Ok(file) => summary(slug, false, &file, Plan::check(&file)),
            Err(err) => summary(
                slug,
                false,
                &Value::Null,
                vec![at_plan(format!("the library file is not JSON: {err}"))],
            ),
        }
    }));
    plans
}

/// A Preset by its slug, else the library file.
pub fn get(home: &str, slug: &str) -> Result<StoredPlan, LibraryError> {
    checked_slug(slug)?;
    let preset = preset(slug);
    let file = match preset {
        Some(preset) => preset_file(preset.json),
        None => {
            let path = plan_path(home, slug);
            if !js::exists(&path) {
                return Err(LibraryError::NotFound(slug.to_owned()));
            }
            let text = js::read_text(&path).map_err(|err| LibraryError::Io(err.to_string()))?;
            serde_json::from_str(&text).map_err(|_| LibraryError::Unreadable(slug.to_owned()))?
        }
    };
    Ok(StoredPlan {
        slug: slug.to_owned(),
        preset: preset.is_some(),
        problems: Plan::check(&file),
        file,
    })
}

/// A valid Plan by its slug, for Boot.
pub fn load(home: &str, slug: &str) -> Result<Plan, LibraryError> {
    Plan::from_value(&get(home, slug)?.file).map_err(LibraryError::Invalid)
}

/// Validate, then write `to_json` through a temp file and a rename, making the directory. A Preset
/// slug is refused.
pub fn save(home: &str, slug: &str, file: &Value) -> Result<Plan, LibraryError> {
    checked_slug(slug)?;
    if preset(slug).is_some() {
        return Err(LibraryError::PresetSlug(slug.to_owned()));
    }
    let plan = Plan::from_value(file).map_err(LibraryError::Invalid)?;
    let io = |err: js::FsError| LibraryError::Io(err.to_string());
    js::mkdir_all(plans_dir(home)).map_err(io)?;
    let _held = PLANS.hold();
    write_through_own_temp(&plan_path(home, slug), &plan.to_json()).map_err(io)?;
    Ok(plan)
}

/// Remove the library file. A Preset slug is refused.
pub fn delete(home: &str, slug: &str) -> Result<(), LibraryError> {
    checked_slug(slug)?;
    if preset(slug).is_some() {
        return Err(LibraryError::PresetSlug(slug.to_owned()));
    }
    let path = plan_path(home, slug);
    let _held = PLANS.hold();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Err(LibraryError::NotFound(slug.to_owned()))
        }
        Err(err) => Err(LibraryError::Io(
            js::FsError::new(&err, "unlink", &path).to_string(),
        )),
    }
}
