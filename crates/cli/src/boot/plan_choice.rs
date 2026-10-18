use ac_core::js;
use ac_core::plan::library;
use ac_protocol::wire::PlanSummary;

use super::{BootIo, DEFAULT_PLAN};

pub fn choose_plan(
    named: Option<&str>,
    unattended: bool,
    io: &mut dyn BootIo,
    home: &str,
) -> String {
    if let Some(slug) = named {
        return slug.to_owned();
    }
    if unattended {
        io.log(&format!(
            "no --plan: the Line runs the {DEFAULT_PLAN} Preset"
        ));
        return DEFAULT_PLAN.to_owned();
    }
    let offered = offered_plans(&library::list(home), io);
    io.log(&format!("Plans: {}", offered.join(", ")));
    loop {
        let answer = io.ask("start from which plan", DEFAULT_PLAN);
        let answer = js::trim(&answer);
        if offered.iter().any(|slug| slug == answer) {
            return answer.to_owned();
        }
        io.warn(&format!("no Plan named {answer}"));
    }
}

fn offered_plans(summaries: &[PlanSummary], io: &mut dyn BootIo) -> Vec<String> {
    let mut offered = Vec::new();
    for summary in summaries {
        match summary.problems.first() {
            None => offered.push(summary.slug.clone()),
            Some(problem) => io.warn(&format!(
                "not offering {}: {}",
                summary.slug, problem.message
            )),
        }
    }
    offered
}
