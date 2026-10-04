//! The prompts the engine hands an Attempt (engine/prompt.ts): pure text, every visible string as the
//! TypeScript writes it. This module holds the Ticket Attempt's prompt and the merge resolver's; the
//! grader, head-to-head, enlist, Continued, Conversation and Steward texts join it with the ports that
//! use them.

use ac_protocol::Outcome;

use crate::outcome::SPAWN_BODY_MIN_CHARS;
use crate::spawn_caps::SpawnCaps;

// The Spawn ledger (issue #150): the path, never the contents, so the prompt stays short (issue #84)
// and the agent reads the pool as it is when it proposes, not as it was at launch.
fn spawn_ledger_teaching(ledger_path: &str) -> String {
    format!(
        "Before you propose anything, read the Spawn ledger at {ledger_path}: every Ticket and \
         Conversation in the pool, and every proposal still waiting to land or held for the \
         operator. Do not propose work it already lists. If a proposal still overlaps something \
         there, add \"overlaps\": [\"id\", ...] naming what it overlaps: it is then held for the \
         operator to decide instead of landing."
    )
}

/// What a proposal's "assign" may set (issue #116): the same four fields the engine's validator
/// keeps, and never verify, which stays the operator's.
pub const SPAWN_ASSIGN_FIELDS_TEACHING: &str = "\"assign\" takes harness, model, effort and drivers \
     only; a verify in it is ignored, since grading is the operator's call.";

/// The `assign` teaching shared by the attempt prompt and the Conversation teaching.
pub fn spawn_assign_teaching() -> String {
    format!(
        "An entry may add \"assign\": {{\"harness\": \"...\", \"model\": \"...\", \"effort\": \
         \"...\", \"drivers\": \"...\"}} with only the fields the follow-up needs different; when \
         absent it inherits your own Assignment. {SPAWN_ASSIGN_FIELDS_TEACHING}"
    )
}

/// The `blocks` teaching (ADR-0029), one sentence shared by the attempt prompt and the Conversation
/// teaching so the two cannot drift.
pub const SPAWN_BLOCKS_TEACHING: &str = "A follow-up that must run before other work may add \
     \"blocks\": [\"id\", ...] to make those tickets wait for it, or \"blocks\": \"all\" to make \
     every ticket that has not started yet wait for it; a ticket already running is never \
     interrupted, and blocks is only for a ticket.";

/// What the merge resolver's prompt names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolverPromptParts<'a> {
    pub id: &'a str,
    pub worktree: &'a str,
    pub branch: &'a str,
    pub working_branch: &'a str,
    pub files: &'a [String],
    pub outcome_path: &'a str,
}

/// The resolver's prompt: reproduce the conflict, stage a resolution without committing, and write
/// the resolved flag and a note.
pub fn build_resolver_prompt(parts: &ResolverPromptParts<'_>) -> String {
    let files = if parts.files.is_empty() {
        "see git status".to_owned()
    } else {
        parts.files.join(", ")
    };
    [
        format!("Resolve the git merge conflict for ticket {}.", parts.id),
        String::new(),
        format!(
            "You are in the git worktree at {}, with branch {} checked out. The pool's working \
             branch is {}.",
            parts.worktree, parts.branch, parts.working_branch
        ),
        String::new(),
        format!(
            "To reproduce the conflict, run: git merge {}",
            parts.working_branch
        ),
        format!(
            "Then resolve each conflicted file ({files}), stage the resolution with git add, and DO \
             NOT commit."
        ),
        String::new(),
        format!(
            "When you have staged a resolution, write JSON to {}: {{\"resolved\": true, \"note\": \
             \"what you did, in a sentence or two\"}}",
            parts.outcome_path
        ),
        String::new(),
        "If you cannot resolve it, write {\"resolved\": false, \"note\": \"why\"} and exit."
            .to_owned(),
        String::new(),
    ]
    .join("\n")
}

/// An upstream Outcome the prompt passes on: the blocker's id and what it recorded.
#[derive(Debug, Clone, PartialEq)]
pub struct Upstream<'a> {
    pub id: &'a str,
    pub outcome: &'a Outcome,
}

/// What a Ticket Attempt's prompt is built from.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptParts<'a> {
    /// The drivers after the first: skills to use, in order, once the driver's work is done.
    pub chain: &'a [&'a str],
    /// The pool's AGENT.md, read at every spawn.
    pub agent_md: &'a str,
    pub upstream: &'a [Upstream<'a>],
    pub outcome_path: &'a str,
    /// The pool's Spawn caps as this attempt's boundary left them (ADR-0029).
    pub spawn_caps: SpawnCaps,
    /// The pool's Spawn ledger (issue #150): read before proposing.
    pub ledger_path: &'a str,
}

// What the caps mean for this attempt's proposals: how many are taken, or, with a cap of 0 (issue
// #150), that every one is held for the operator.
fn spawn_caps_teaching(caps: SpawnCaps) -> String {
    let SpawnCaps {
        per_attempt,
        per_run,
    } = caps;
    if per_attempt == 0 || per_run == 0 {
        return format!(
            "Caps apply: this pool's are {per_attempt} per attempt and {per_run} per run, and a cap \
             of 0 means every proposal you make is held for the operator to adopt or discard, none \
             lands on its own, so propose only what the operator should weigh, most important \
             first."
        );
    }
    let proposals = if per_attempt == 1 {
        "proposal"
    } else {
        "proposals"
    };
    format!(
        "Caps apply: {per_attempt} {proposals} honored per attempt and {per_run} per run, overflow \
         held for the operator to adopt or discard, so order your proposals most important first."
    )
}

/// The prompt body: the standing instructions, chain, upstream outcomes, and the outcome-writing
/// instruction. The driver invocation line is not part of it; each harness adapter assembles its own.
pub fn build_prompt(parts: &PromptParts<'_>) -> String {
    let agent_md = crate::js::trim(parts.agent_md);
    let mut sections: Vec<String> = vec![
        "Standing instructions for this job:".into(),
        String::new(),
        if agent_md.is_empty() {
            "_(no AGENT.md in the pool directory)_".into()
        } else {
            agent_md.to_owned()
        },
    ];
    if !parts.chain.is_empty() {
        sections.extend([
            String::new(),
            "---".into(),
            String::new(),
            format!(
                "Skills for this Issue. When the driver skill's work is done, also use these skills, \
                 in this order: {}.",
                parts.chain.join(", ")
            ),
        ]);
    }
    if !parts.upstream.is_empty() {
        sections.extend([
            String::new(),
            "---".into(),
            String::new(),
            "Outcomes from the tickets this ticket was blocked by. Build on what they did; do not \
             rediscover it:"
                .into(),
            String::new(),
        ]);
        sections.extend(parts.upstream.iter().map(|up| {
            format!(
                "- {}: {} (commit {})",
                up.id,
                up.outcome.summary,
                up.outcome.commit_sha.as_deref().unwrap_or("none")
            )
        }));
    }
    sections.extend([
        String::new(),
        "---".into(),
        String::new(),
        format!(
            "When you finish, record your outcome as JSON at {}: {{\"status\": \"done\" or \
             \"checkpoint\", \"summary\": \"what you did, in a sentence or two\", \"commitSha\": \
             \"the sha of your commit, or null\"}}. On a checkpoint, add \"brief\": \"what the human \
             has to do next\". The engine reads this file at your exit and writes the final status \
             to the Issue itself. Never edit the Issue's line-1 status marker; the engine owns that \
             write.",
            parts.outcome_path
        ),
        String::new(),
        format!(
            "Follow-up work you discover mid-attempt is proposed, never written: add an optional \
             \"spawn\" array to that outcome JSON, one entry per follow-up, each shaped {{\"title\": \
             \"...\", \"body\": \"...\", \"blockedBy\": [\"id\", ...]}}, the body carrying at least \
             {SPAWN_BODY_MIN_CHARS} characters of intent for a fresh agent to work from, blockedBy \
             optional and naming the ids the follow-up must wait for. {} {SPAWN_BLOCKS_TEACHING} \
             The engine assigns the ids (<parent>-spawn-N: ticket 07's first proposal becomes \
             07-spawn-1), writes the ticket files at the super-step boundary, and schedules them \
             like any other ticket. Thin or out-of-pool proposals are dropped with the reason \
             recorded in the ticket log, and a dropped proposal never costs your attempt its \
             result. {} You never write pool state: no ticket files, no ids, no statuses. You \
             propose; the engine writes.",
            spawn_assign_teaching(),
            spawn_caps_teaching(parts.spawn_caps)
        ),
        String::new(),
        spawn_ledger_teaching(parts.ledger_path),
    ]);
    sections.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spawn_caps::DEFAULT_SPAWN_CAPS;
    use ac_protocol::OutcomeStatus;

    const LEDGER: &str = "/tmp/pool/runs/spawn-ledger.md";

    fn parts<'a>(chain: &'a [&'a str], caps: SpawnCaps, outcome: &'a str) -> PromptParts<'a> {
        PromptParts {
            chain,
            agent_md: "Do the thing.",
            upstream: &[],
            outcome_path: outcome,
            spawn_caps: caps,
            ledger_path: LEDGER,
        }
    }

    fn prompt() -> String {
        build_prompt(&parts(
            &[],
            DEFAULT_SPAWN_CAPS,
            "/tmp/pool/runs/01.outcome.json",
        ))
    }

    // The whole body, byte for byte as the TypeScript renders it (prompt.ts buildPrompt).
    #[test]
    fn renders_the_whole_body_as_the_typescript_does() {
        let outcome = Outcome {
            status: OutcomeStatus::Done,
            summary: "built it".into(),
            commit_sha: None,
            brief: None,
            spawn: None,
        };
        let upstream = [Upstream {
            id: "00",
            outcome: &outcome,
        }];
        let body = build_prompt(&PromptParts {
            chain: &["tdd", "code-review"],
            agent_md: "  \n",
            upstream: &upstream,
            outcome_path: "/p/runs/01.outcome.json",
            spawn_caps: DEFAULT_SPAWN_CAPS,
            ledger_path: LEDGER,
        });
        let expected = "Standing instructions for this job:\n\n_(no AGENT.md in the pool directory)_\n\n---\n\nSkills for this Issue. When the driver skill's work is done, also use these skills, in this order: tdd, code-review.\n\n---\n\nOutcomes from the tickets this ticket was blocked by. Build on what they did; do not rediscover it:\n\n- 00: built it (commit none)\n\n---\n\nWhen you finish, record your outcome as JSON at /p/runs/01.outcome.json: {\"status\": \"done\" or \"checkpoint\", \"summary\": \"what you did, in a sentence or two\", \"commitSha\": \"the sha of your commit, or null\"}. On a checkpoint, add \"brief\": \"what the human has to do next\". The engine reads this file at your exit and writes the final status to the Issue itself. Never edit the Issue's line-1 status marker; the engine owns that write.\n\nFollow-up work you discover mid-attempt is proposed, never written: add an optional \"spawn\" array to that outcome JSON, one entry per follow-up, each shaped {\"title\": \"...\", \"body\": \"...\", \"blockedBy\": [\"id\", ...]}, the body carrying at least 20 characters of intent for a fresh agent to work from, blockedBy optional and naming the ids the follow-up must wait for. An entry may add \"assign\": {\"harness\": \"...\", \"model\": \"...\", \"effort\": \"...\", \"drivers\": \"...\"} with only the fields the follow-up needs different; when absent it inherits your own Assignment. \"assign\" takes harness, model, effort and drivers only; a verify in it is ignored, since grading is the operator's call. A follow-up that must run before other work may add \"blocks\": [\"id\", ...] to make those tickets wait for it, or \"blocks\": \"all\" to make every ticket that has not started yet wait for it; a ticket already running is never interrupted, and blocks is only for a ticket. The engine assigns the ids (<parent>-spawn-N: ticket 07's first proposal becomes 07-spawn-1), writes the ticket files at the super-step boundary, and schedules them like any other ticket. Thin or out-of-pool proposals are dropped with the reason recorded in the ticket log, and a dropped proposal never costs your attempt its result. Caps apply: 5 proposals honored per attempt and 20 per run, overflow held for the operator to adopt or discard, so order your proposals most important first. You never write pool state: no ticket files, no ids, no statuses. You propose; the engine writes.\n\nBefore you propose anything, read the Spawn ledger at /tmp/pool/runs/spawn-ledger.md: every Ticket and Conversation in the pool, and every proposal still waiting to land or held for the operator. Do not propose work it already lists. If a proposal still overlaps something there, add \"overlaps\": [\"id\", ...] naming what it overlaps: it is then held for the operator to decide instead of landing.";
        assert_eq!(body, expected);
    }

    // prompt.test.ts:41
    #[test]
    fn has_no_chain_section_when_there_is_no_chain() {
        assert!(!prompt().contains("Skills for this Issue"));
        assert!(prompt().starts_with("Standing instructions for this job:\n\nDo the thing.\n"));
    }

    // prompt.test.ts:102, 128
    #[test]
    fn names_the_pool_caps_in_the_singular_and_teaches_a_cap_of_zero() {
        let one = build_prompt(&parts(
            &[],
            SpawnCaps {
                per_attempt: 1,
                per_run: 12,
            },
            "/o",
        ));
        assert!(one.contains("1 proposal honored per attempt and 12 per run"));
        let zero = build_prompt(&parts(
            &[],
            SpawnCaps {
                per_attempt: 0,
                per_run: 20,
            },
            "/o",
        ));
        assert!(zero.contains("0 per attempt and 20 per run"));
        assert!(zero.contains("every proposal you make is held for the operator"));
        assert!(!zero.contains("proposals honored per attempt"));
    }

    #[test]
    fn the_resolver_prompt_reads_as_the_typescript_writes_it() {
        let files = vec!["a.txt".to_string(), "b.txt".to_string()];
        let body = build_resolver_prompt(&ResolverPromptParts {
            id: "02",
            worktree: "/w",
            branch: "pool/k/02",
            working_branch: "main",
            files: &files,
            outcome_path: "/r/02.resolver.outcome.json",
        });
        assert_eq!(
            body,
            "Resolve the git merge conflict for ticket 02.\n\nYou are in the git worktree at /w, with branch pool/k/02 checked out. The pool's working branch is main.\n\nTo reproduce the conflict, run: git merge main\nThen resolve each conflicted file (a.txt, b.txt), stage the resolution with git add, and DO NOT commit.\n\nWhen you have staged a resolution, write JSON to /r/02.resolver.outcome.json: {\"resolved\": true, \"note\": \"what you did, in a sentence or two\"}\n\nIf you cannot resolve it, write {\"resolved\": false, \"note\": \"why\"} and exit.\n"
        );
        let none = build_resolver_prompt(&ResolverPromptParts {
            files: &[],
            ..ResolverPromptParts {
                id: "02",
                worktree: "/w",
                branch: "b",
                working_branch: "main",
                files: &[],
                outcome_path: "/o",
            }
        });
        assert!(none.contains("(see git status)"));
    }
}
