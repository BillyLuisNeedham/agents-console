//! The prompts of the verify flow and of Keep talking (engine/prompt.ts): a grader's, the
//! head-to-head judge's and the teaching Turn a Continued attempt starts with. Pure text, every visible
//! string as the TypeScript writes it.

use crate::js;
use crate::outcome::SPAWN_BODY_MIN_CHARS;
use crate::prompt::{SPAWN_BLOCKS_TEACHING, spawn_ledger_teaching};

/// What a grader's prompt is built from.
#[derive(Debug, Clone, Copy)]
pub struct GraderPromptParts<'a> {
    pub build_id: &'a str,
    pub attempt: u64,
    /// The pool's verify skill, or `None` when the pool has none.
    pub skill: Option<&'a str>,
    pub ticket_path: &'a str,
    pub outcome_path: &'a str,
    pub diff_path: &'a str,
    pub log_path: &'a str,
    pub grader_outcome_path: &'a str,
}

// The pool's verify skill, trimmed, or the placeholder a pool without one gets (`skill?.trim() || ...`).
fn skill_text(skill: Option<&str>, placeholder: &str) -> String {
    match skill.map(js::trim) {
        Some(text) if !text.is_empty() => text.to_owned(),
        _ => placeholder.to_owned(),
    }
}

/// `buildGraderPrompt`: the pool's verify skill parameterized with the bound attempt's artifact paths,
/// then the grade contract.
pub fn build_grader_prompt(parts: &GraderPromptParts<'_>) -> String {
    let sections: Vec<String> = vec![
        format!(
            "You are a grader. One attempt is bound to you: attempt {} of ticket {}. Grade that \
             attempt against the ticket, judge the artifacts, and put the grade in your outcome \
             JSON. The engine owns every status write; you write none.",
            parts.attempt, parts.build_id
        ),
        String::new(),
        "---".into(),
        String::new(),
        skill_text(
            parts.skill,
            "_(the pool has no verify skill: no verify.md beside AGENT.md, so grade on the criteria \
             below and say so in your reasons)_",
        ),
        String::new(),
        "---".into(),
        String::new(),
        "The bound attempt's artifacts, in the order the skill reads them:".into(),
        String::new(),
        format!("1. The ticket file: {}", parts.ticket_path),
        format!("2. The attempt's Outcome JSON: {}", parts.outcome_path),
        format!("3. The diff at the attempt's commit: {}", parts.diff_path),
        format!(
            "4. The attempt log, trimmed to its last ~20k tokens when huge: {}",
            parts.log_path
        ),
        String::new(),
        "Trust terminal output over the agent's self-assessment.".into(),
        String::new(),
        "---".into(),
        String::new(),
        format!(
            "When you finish, record your outcome as JSON at {}: {{\"status\": \"done\", \
             \"summary\": \"what you graded, in a sentence or two\", \"commitSha\": null, \"grade\": \
             {{\"score\": 0-10, \"verdict\": \"pass\" or \"flag\", \"reasons\": \"one to three \
             short sentences naming the evidence\"}}}}. You write no status, raise no interrupts, \
             and merge nothing: the grade in this file is your only output.",
            parts.grader_outcome_path
        ),
    ];
    sections.join("\n")
}

/// One side of the comparison a head-to-head judge is handed.
#[derive(Debug, Clone, Copy)]
pub struct HeadToHeadSideParts<'a> {
    pub attempt: u64,
    pub outcome_path: &'a str,
    pub diff_path: &'a str,
    pub log_path: &'a str,
    pub score: f64,
    pub verdict: &'a str,
    pub reasons: &'a str,
}

/// What the head-to-head judge's prompt is built from.
#[derive(Debug, Clone, Copy)]
pub struct HeadToHeadPromptParts<'a> {
    pub build_id: &'a str,
    pub ticket_path: &'a str,
    /// The pool's verify skill, or `None` when the pool has none.
    pub skill: Option<&'a str>,
    pub top: HeadToHeadSideParts<'a>,
    pub runner_up: HeadToHeadSideParts<'a>,
    pub outcome_path: &'a str,
}

/// `buildHeadToHeadPrompt`: the pool's verify skill as the criteria both sides are judged against,
/// then each attempt's artifacts side by side with the grade it received, then the pick contract.
pub fn build_head_to_head_prompt(parts: &HeadToHeadPromptParts<'_>) -> String {
    let side = |label: &str, s: &HeadToHeadSideParts<'_>| -> Vec<String> {
        vec![
            format!(
                "{label}: attempt {}, graded {}/10 ({}: {})",
                s.attempt,
                js::number_string(s.score),
                s.verdict,
                js::trim(s.reasons)
            ),
            String::new(),
            format!("1. The attempt's Outcome JSON: {}", s.outcome_path),
            format!("2. The diff at the attempt's commit: {}", s.diff_path),
            format!(
                "3. The attempt log, trimmed to its last ~20k tokens when huge: {}",
                s.log_path
            ),
        ]
    };
    let mut sections: Vec<String> = vec![
        format!(
            "You are the head-to-head judge. Two attempts of ticket {} finished with grades too \
             close to call from separate graders: their scores sit within two points of each \
             other, and separate grading calls do not calibrate against each other. Compare the \
             two attempts side by side, pick the better one, and put the pick in your outcome \
             JSON. The engine owns every status write; you write none.",
            parts.build_id
        ),
        String::new(),
        "---".into(),
        String::new(),
        skill_text(
            parts.skill,
            "_(the pool has no verify skill: no verify.md beside AGENT.md, so judge both sides on \
             the criteria below and say so in your summary)_",
        ),
        String::new(),
        "---".into(),
        String::new(),
        "Both attempts worked the same ticket:".into(),
        String::new(),
        format!("The ticket file: {}", parts.ticket_path),
        String::new(),
        "The first attempt's artifacts:".into(),
        String::new(),
    ];
    sections.extend(side("First", &parts.top));
    sections.push(String::new());
    sections.push("The second attempt's artifacts:".into());
    sections.push(String::new());
    sections.extend(side("Second", &parts.runner_up));
    sections.extend([
        String::new(),
        "Trust terminal output over the agents' self-assessments.".into(),
        String::new(),
        "---".into(),
        String::new(),
        format!(
            "When you finish, record your outcome as JSON at {}: {{\"status\": \"done\", \
             \"summary\": \"why your pick wins, in a sentence or two\", \"commitSha\": null, \
             \"winner\": <attempt number>}}. The winner is the number of the better attempt, \
             exactly one of {} or {}. If you genuinely cannot separate them, write \"winner\": \
             \"tie\" instead; the engine then falls back to the higher score, then the earlier \
             attempt. You write no status, raise no interrupts, and merge nothing: the pick in \
             this file is your only output.",
            parts.outcome_path, parts.top.attempt, parts.runner_up.attempt
        ),
    ]);
    sections.join("\n")
}

/// Who chose to keep talking: the pool's Steward stands in for the operator (ADR-0030).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeptTalkingBy {
    Operator,
    Steward,
}

/// What the teaching Turn a Continued attempt starts with is built from.
#[derive(Debug, Clone, Copy)]
pub struct ContinuedTeachingParts<'a> {
    pub id: &'a str,
    pub issue_path: &'a str,
    pub outcome_path: &'a str,
    pub attempt: u64,
    pub ledger_path: &'a str,
    pub by: KeptTalkingBy,
}

/// `buildContinuedTeaching` (issue #139): the agent already wrote the checkpoint Outcome its prompt
/// asked for and believes its part is over, so it is told the operator chose to carry on here and that
/// a fresh Outcome is owed when the two of them decide. It restates the whole Outcome contract.
pub fn build_continued_teaching(parts: &ContinuedTeachingParts<'_>) -> String {
    let steward = parts.by == KeptTalkingBy::Steward;
    let who = if steward {
        "The pool's Steward, standing in for the operator,"
    } else {
        "The operator"
    };
    [
        "---".to_owned(),
        String::new(),
        format!(
            "{who} chose to keep talking with you here about Ticket {}, instead of starting a \
             fresh attempt. You are now its attempt {}: carry on from where you checkpointed, with \
             the {}, in this same terminal and checkout.",
            parts.id,
            parts.attempt,
            if steward { "Steward" } else { "operator" }
        ),
        String::new(),
        format!(
            "The Ticket file of record is {}; its line-1 status marker is the engine's, never \
             edit it.",
            parts.issue_path
        ),
        String::new(),
        format!(
            "The Outcome you wrote before is spent. When you and the operator decide the work is \
             done, or that it has to pause again, record a fresh outcome as JSON at {}: \
             {{\"status\": \"done\" or \"checkpoint\", \"summary\": \"what you did, in a sentence \
             or two\", \"commitSha\": \"the sha of your commit, or null\"}}. On a checkpoint, add \
             \"brief\": \"what the human has to do next\". Write it only once it is decided: the \
             engine reads the file the moment it appears.",
            parts.outcome_path
        ),
        String::new(),
        format!(
            "You may propose follow-up tickets in that same outcome JSON by adding a \"spawn\" \
             array, one entry per follow-up, each shaped {{\"title\": \"...\", \"body\": \"...\", \
             \"blockedBy\": [\"id\", ...]}}, the body carrying at least {SPAWN_BODY_MIN_CHARS} \
             characters of intent for a fresh agent to work from. {SPAWN_BLOCKS_TEACHING} You \
             never write pool state yourself: no ticket files, no ids, no statuses. You propose; \
             the engine writes."
        ),
        String::new(),
        spawn_ledger_teaching(parts.ledger_path),
    ]
    .join("\n")
}

/// `stewardMessageTurn`: the Turn a Steward's coaching message is typed as after the Keep talking
/// teaching Turn, marked as the Steward's so the agent knows who is talking.
pub fn steward_message_turn(message: &str) -> String {
    format!("From the pool's Steward:\n\n{}", js::trim(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grader_prompt_names_the_bound_attempt_and_the_pools_skill() {
        let parts = GraderPromptParts {
            build_id: "01",
            attempt: 2,
            skill: Some("  grade hard  "),
            ticket_path: "/p/issues/01.md",
            outcome_path: "/p/runs/01.attempt-2.outcome.json",
            diff_path: "/p/runs/01-grader-2.diff.patch",
            log_path: "/p/runs/01-grader-2.trim.log",
            grader_outcome_path: "/p/runs/01-grader-2.outcome.json",
        };
        let prompt = build_grader_prompt(&parts);
        assert!(prompt.starts_with(
            "You are a grader. One attempt is bound to you: attempt 2 of ticket 01. "
        ));
        assert!(prompt.contains("\n---\n\ngrade hard\n\n---\n\n"));
        assert!(prompt.contains("1. The ticket file: /p/issues/01.md\n2. The attempt's Outcome"));
        assert!(prompt.ends_with(
            "\"grade\": {\"score\": 0-10, \"verdict\": \"pass\" or \"flag\", \"reasons\": \"one to \
             three short sentences naming the evidence\"}}. You write no status, raise no \
             interrupts, and merge nothing: the grade in this file is your only output."
        ));
        let none = build_grader_prompt(&GraderPromptParts {
            skill: None,
            ..parts
        });
        assert!(
            none.contains("_(the pool has no verify skill: no verify.md beside AGENT.md, so grade")
        );
        let blank = build_grader_prompt(&GraderPromptParts {
            skill: Some(" \n"),
            ..parts
        });
        assert_eq!(blank, none);
    }

    #[test]
    fn a_head_to_head_prompt_lays_both_sides_out_with_their_grades() {
        let side = |attempt, score| HeadToHeadSideParts {
            attempt,
            outcome_path: "o",
            diff_path: "d",
            log_path: "l",
            score,
            verdict: "pass",
            reasons: " fine \n",
        };
        let prompt = build_head_to_head_prompt(&HeadToHeadPromptParts {
            build_id: "01",
            ticket_path: "/t",
            skill: None,
            top: side(2, 8.2),
            runner_up: side(1, 7.0),
            outcome_path: "/h",
        });
        assert!(
            prompt.contains("First: attempt 2, graded 8.2/10 (pass: fine)\n\n1. The attempt's")
        );
        assert!(prompt.contains("Second: attempt 1, graded 7/10 (pass: fine)"));
        assert!(prompt.contains("exactly one of 2 or 1. If you genuinely cannot"));
    }

    #[test]
    fn a_continued_teaching_says_who_chose_to_carry_on() {
        let parts = ContinuedTeachingParts {
            id: "01",
            issue_path: "/i",
            outcome_path: "/o",
            attempt: 3,
            ledger_path: "/ledger",
            by: KeptTalkingBy::Operator,
        };
        let operator = build_continued_teaching(&parts);
        assert!(operator.starts_with(
            "---\n\nThe operator chose to keep talking with you here about Ticket 01, instead of \
             starting a fresh attempt. You are now its attempt 3: carry on from where you \
             checkpointed, with the operator, in this same terminal and checkout."
        ));
        let steward = build_continued_teaching(&ContinuedTeachingParts {
            by: KeptTalkingBy::Steward,
            ..parts
        });
        assert!(
            steward.contains(
                "The pool's Steward, standing in for the operator, chose to keep talking"
            )
        );
        assert!(steward.contains("with the Steward, in this same terminal"));
        assert!(steward.ends_with("Before you propose anything, read the Spawn ledger at /ledger: every Ticket and Conversation in the pool, and every proposal still waiting to land or held for the operator. Do not propose work it already lists. If a proposal still overlaps something there, add \"overlaps\": [\"id\", ...] naming what it overlaps: it is then held for the operator to decide instead of landing."));
    }

    #[test]
    fn a_steward_message_is_marked_as_the_stewards() {
        assert_eq!(
            steward_message_turn("  look at this \n"),
            "From the pool's Steward:\n\nlook at this"
        );
    }
}
