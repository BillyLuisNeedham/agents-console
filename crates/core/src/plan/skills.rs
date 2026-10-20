//! Skill warnings: a node that names a skill its harness cannot find. Advisory only. `Plan::check`
//! stays pure and gates Save and Boot; this reads the disk, so its answer depends on the machine, and
//! it never keeps a Plan from being saved or run.

use ac_protocol::wire::{PlanFile, PlanNodeFile, PlanProblem};
use serde::Deserialize;
use serde_json::Value;

use super::parse::at_node;
use crate::harness::{SkillDirs, harness_descriptor};
use crate::js;

/// What a skill check reads: where this machine installs skills, and the harness a node that names
/// none launches on (the pool's `defaults.harness`).
#[derive(Debug, Clone)]
pub struct SkillCheck {
    pub dirs: SkillDirs,
    pub default_harness: Option<String>,
}

impl SkillCheck {
    /// One warning per missing word of a node's skill, on that node. A node's harness is its own
    /// `assign.harness`, else the default; with neither, or with a harness the engine has no descriptor
    /// for (codex, a pool's own command), nothing is known about where it looks, so nothing is warned.
    /// A word holding `:` is a plugin-namespaced skill, and a word the harness ships with is built in:
    /// neither has a file to look for.
    pub fn warnings(&self, file: &PlanFile) -> Vec<PlanProblem> {
        let mut warnings = Vec::new();
        for node in &file.nodes {
            let (id, skill, assign) = match node {
                PlanNodeFile::Conversation(n) => (&n.id, &n.skill, &n.assign),
                PlanNodeFile::Agent(n)
                | PlanNodeFile::Prove(n)
                | PlanNodeFile::Review(n)
                | PlanNodeFile::Decide(n) => (&n.id, &n.skill, &n.assign),
                PlanNodeFile::Merger(_) | PlanNodeFile::Gate(_) | PlanNodeFile::Finish(_) => {
                    continue;
                }
            };
            let Some(skill) = skill else { continue };
            let own = assign
                .as_ref()
                .and_then(|assign| assign.harness.as_deref())
                .map(js::trim)
                .filter(|harness| !harness.is_empty());
            let Some(harness) = own.or(self.default_harness.as_deref()) else {
                continue;
            };
            let Some(descriptor) = harness_descriptor(harness) else {
                continue;
            };
            let installable =
                |word: &&str| !word.contains(':') && !descriptor.built_in.contains(word);
            for word in skill.split_whitespace().filter(installable) {
                let places = (descriptor.skill_places)(&self.dirs, word);
                if !places.iter().any(js::exists) {
                    warnings.push(at_node(
                        id,
                        format!(
                            "skill {word} is not installed for {harness} (looked in {})",
                            places.join(", ")
                        ),
                    ));
                }
            }
        }
        warnings
    }

    /// `warnings` over a draft that may be invalid. A draft that does not read as a Plan file has
    /// none: its problems are the answer.
    pub fn draft_warnings(&self, draft: &Value) -> Vec<PlanProblem> {
        PlanFile::deserialize(draft)
            .map(|file| self.warnings(&file))
            .unwrap_or_default()
    }
}
