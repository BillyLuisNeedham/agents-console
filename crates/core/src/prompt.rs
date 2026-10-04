//! The prompts the engine hands an Attempt (engine/prompt.ts): pure text, every visible string as the
//! TypeScript writes it. This module holds the Ticket Attempt's prompt and the merge resolver's; the
//! grader, head-to-head, enlist, Continued, Conversation and Steward texts join it with the ports that
//! use them.

use ac_protocol::Outcome;

use crate::outcome::SPAWN_BODY_MIN_CHARS;
use crate::spawn_caps::SpawnCaps;

// The Spawn ledger (issue #150): the path, never the contents, so the prompt stays short (issue #84)
// and the agent reads the pool as it is when it proposes, not as it was at launch.
pub(crate) fn spawn_ledger_teaching(ledger_path: &str) -> String {
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

/// An Assignment as a teaching names it (engine/prompt.ts's `TeachingAssignment`): every field optional,
/// since an enlisted pane names no model and the pool may name no defaults at all.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TeachingAssignment {
    pub harness: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub drivers: Option<String>,
}

// What the teaching says a field is: an enlisted pane names no model, and the pool may name no defaults
// at all, so the empty case is spelled out rather than left as a blank the agent would read past.
fn describe_assignment(assignment: &TeachingAssignment) -> String {
    let field = |value: &Option<String>| match value.as_deref() {
        Some(text) if !text.is_empty() => text.to_owned(),
        _ => "(none)".to_owned(),
    };
    // Effort is optional (the harness's own default when unset), so it is named only when set rather
    // than as a gap the agent might try to fill.
    let effort = match assignment.effort.as_deref() {
        Some(effort) if !effort.is_empty() => format!(", effort {effort}"),
        _ => String::new(),
    };
    format!(
        "harness {}, model {}{effort}, drivers {}",
        field(&assignment.harness),
        field(&assignment.model),
        field(&assignment.drivers)
    )
}

/// The teaching the Conversation module appends to a Conversation's opening Turn (or types alone when
/// there is none, so the mechanism is learned either way): how to propose Spawns mid-conversation.
pub fn build_conversation_teaching(
    spawn_path: &str,
    own: &TeachingAssignment,
    defaults: &TeachingAssignment,
    per_file: u64,
    ledger_path: &str,
) -> String {
    let mut lines = vec![
        "---".to_owned(),
        String::new(),
        "Load the my-console-citizen skill: it is how to work inside this pool.".to_owned(),
        String::new(),
    ];
    lines.extend(conversation_protocol(
        spawn_path,
        own,
        defaults,
        per_file,
        ledger_path,
        false,
    ));
    lines.join("\n")
}

/// The Conversation protocol both teachings share: how to Spawn, what the Assignment and caps are, what
/// reports back. A Steward's differs in one sentence, since the Interrupts of what it spawns are its to
/// answer.
pub fn conversation_protocol(
    spawn_path: &str,
    own: &TeachingAssignment,
    defaults: &TeachingAssignment,
    per_file: u64,
    ledger_path: &str,
    steward: bool,
) -> Vec<String> {
    let caps = if per_file == 0 {
        "0 entries honored per file written: the pool's cap is 0, so every entry is held for the \
         operator to adopt or discard and none starts on its own; "
            .to_owned()
    } else {
        format!(
            "{per_file} {} honored per file written, and entries beyond it are held for the \
             operator to adopt or discard; ",
            if per_file == 1 { "entry" } else { "entries" }
        )
    };
    vec![
        format!(
            "You can start follow-up work without leaving this conversation. Write JSON to \
             {spawn_path}: {{\"spawn\": [...]}}, one entry per follow-up, each shaped \
             {{\"title\": \"...\", \"body\": \"...\", \"blockedBy\": [\"id\", ...], \"kind\": \"ticket\" \
             or \"conversation\", \"assign\": {{\"harness\": \"...\", \"model\": \"...\", \"effort\": \
             \"...\", \"drivers\": \"...\"}}}}."
        ),
        String::new(),
        format!(
            "The body needs at least {SPAWN_BODY_MIN_CHARS} characters of intent for a fresh agent to \
             work from. \"blockedBy\" is optional and may only name Tickets, never another \
             Conversation (an entry naming one is dropped and logged). \"kind\" defaults to \
             \"ticket\"; \"conversation\" starts a new open-ended talk instead of a Ticket. \"assign\" \
             is optional; when absent the follow-up inherits this Conversation's own Assignment, and \
             any field that leaves empty falls through to the pool defaults. \
             {SPAWN_ASSIGN_FIELDS_TEACHING} {SPAWN_BLOCKS_TEACHING}"
        ),
        String::new(),
        format!(
            "This Conversation's Assignment: {}. The pool defaults: {}. Set \"assign\" only for a \
             field the follow-up needs different; when no model would resolve, ask the operator \
             here before you write the file.",
            describe_assignment(own),
            describe_assignment(defaults)
        ),
        String::new(),
        format!(
            "The engine polls for this file, reads it, and deletes it once read: write it whenever \
             you like, mid-conversation, not only once. Caps: {caps}unlike a Ticket's own spawns \
             there is no run-wide cap on what a Conversation spawns."
        ),
        String::new(),
        spawn_ledger_teaching(ledger_path),
        String::new(),
        format!(
            "A spawned Ticket reports back here as a Turn typed into this conversation once it \
             ends (done, or checkpoint with its Brief) and you are next idle: its id, title, \
             outcome, branch, and a diff summary. A spawned Conversation reports back the same way \
             once the operator ends it: its branch and the operator's closing note, if {}",
            if steward {
                "any. Both only inform; a spawned Ticket's Interrupt reaches you as a Steward \
                 Notice like any other Ticket's."
            } else {
                "any. Both inform only; you cannot answer either one's own Interrupt."
            }
        ),
        String::new(),
        "You never write pool state yourself: no ticket files, no ids, no statuses, no status \
         markers. You propose; the engine writes."
            .to_owned(),
    ]
}

/// What the teaching a Steward starts with names.
pub struct StewardTeaching<'a> {
    pub spawn_path: &'a str,
    pub own: &'a TeachingAssignment,
    pub defaults: &'a TeachingAssignment,
    pub per_file: u64,
    pub ledger_path: &'a str,
    /// The exact invocation of the Steward's command.
    pub command: &'a str,
    pub budget: u64,
    pub may_close: bool,
}

/// The teaching a Steward starts with (ADR-0030), appended to the operator's standing orders when it is
/// started and typed as an enlist's teaching Turn when it is Enlisted: the Steward's role, the command
/// it answers with, its budget, what it may never answer or do, how to leave an Interrupt and how to end
/// itself, then the Conversation protocol every Conversation is taught. The budget, and whether the pool
/// lets it Close (ADR-0030's #154 amendment), are the ones in force at start; the `state` verb reads
/// both live, and the engine's check is the rule.
pub fn build_steward_teaching(parts: &StewardTeaching<'_>) -> String {
    let command = parts.command;
    let budget = parts.budget;
    let mut lines: Vec<String> = vec![
        "---".to_owned(),
        String::new(),
        "You are this pool's Steward: you keep its Tickets moving while the operator is away, under \
         the orders above. Load the my-console-steward skill now: it is how to judge each Interrupt. \
         It builds on the my-console-citizen skill, which is how to work inside this pool."
            .to_owned(),
        String::new(),
        "You do not poll. Whenever you are waiting, the engine types a Turn here naming every pending \
         Ticket Interrupt you may answer and have not left, and a Merge queue head that has stalled. \
         Items that arrive together come as one Turn. The same Turn also tells you, with nothing to \
         answer, which Tickets merged since your last Notice and when every Ticket is done and Review \
         waits for the operator: that is how you know when orders like \"watch the next super-step, \
         then finish\" are done, and can end yourself."
            .to_owned(),
        String::new(),
        "Act with this command, run in your shell:".to_owned(),
        String::new(),
        format!("    {command} <verb> ..."),
        String::new(),
        "- answer <ticket> resume|approve|reject [note]: the operator's own answer path. resume starts \
         a fresh Attempt with your note in the Ticket file; approve or reject answer a \
         merge-approval; a selection is answered with resume and the attempt number to merge."
            .to_owned(),
    ];
    if parts.may_close {
        lines.push(
            "- close <ticket> <note>: drop a Ticket waiting at a checkpoint or a merge conflict \
             without merging it; its branch and worktree are discarded. Only when the work is no \
             longer wanted, always with a note saying why. It counts against your budget. A \
             deadlocked dependent of a closed Ticket is the operator's to close, not yours."
                .to_owned(),
        );
    }
    lines.extend([
        "- keep-talking <ticket> <message>: continue a checkpointed Attempt in its still-live pane; \
         the engine types your message there after its own teaching Turn."
            .to_owned(),
        "- leave <ticket> <note>: leave the Interrupt to the operator. Your note is your \
         recommendation, shown to them beside it. You are not told about that Interrupt again until \
         it changes."
            .to_owned(),
        "- held adopt|discard <proposal-id>: decide a Held spawn.".to_owned(),
        "- reassign <ticket> field=value...: change a Ticket's Assignment (harness, model, effort, \
         drivers, verify; field= clears one). The engine picks it up at the next boundary, so resume \
         the Ticket after."
            .to_owned(),
        "- state: the pending Interrupts, the Merge queue, the Pending and Held spawns, your budget \
         left per Ticket, and whether the pool lets you Close now."
            .to_owned(),
        "- end [closing line]: end yourself.".to_owned(),
        String::new(),
        "A note or message given as \"-\" is read from standard input.".to_owned(),
        String::new(),
        format!(
            "Your Steward budget is {budget} {} per Ticket since the operator last answered it. \
             Answers, Closes and Keep talks count; leaves, adopts, discards and reassigns do not. The \
             engine refuses an answer beyond it: leave that Ticket with a note.",
            if budget == 1 { "answer" } else { "answers" }
        ),
        String::new(),
        "Never answer a review or a persistence Interrupt: review is the operator's final \
         judgement, and persistence is an engine store failure. The engine refuses both. A \
         Conversation's waits are not yours either: you steward Tickets."
            .to_owned(),
        String::new(),
        if parts.may_close {
            "The operator lets you Close for now; they can turn it off in Settings at any time, and \
             the engine then refuses a close. Run state when in doubt."
        } else {
            "Closing a Ticket without merging it is the operator's in this pool: the engine refuses \
             it from you. To recommend one, leave the Ticket with a note saying so. If the operator \
             turns on Steward may Close checkpoints later, state says so and each Notice offers \
             close."
        }
        .to_owned(),
        String::new(),
        "Decide and talk, never do the work: make no edits in any Ticket's worktree or in the pool \
         checkout. Your only ways to change the code are an answer, a coaching message and a Spawn."
            .to_owned(),
        String::new(),
        "You may push, open pull requests or merge pull requests only if the operator's own words in \
         this pane allow it. Nothing else grants it."
            .to_owned(),
        String::new(),
        "When you cannot decide an Interrupt sensibly, or it is a product decision or anything \
         destructive or irreversible, leave it with a note that recommends an answer and says why."
            .to_owned(),
        String::new(),
        "When your orders are done, run end with a closing line: what you decided, and what waits \
         for the operator."
            .to_owned(),
        String::new(),
        "---".to_owned(),
        String::new(),
    ]);
    lines.extend(conversation_protocol(
        parts.spawn_path,
        parts.own,
        parts.defaults,
        parts.per_file,
        parts.ledger_path,
        true,
    ));
    lines.join("\n")
}

/// What the enlist teaching names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnlistTeachingParts<'a> {
    pub id: &'a str,
    pub issue_path: &'a str,
    pub outcome_path: &'a str,
    pub branch: &'a str,
    pub ledger_path: &'a str,
}

/// The teaching Turn an enlisted pane starts with (issue #101): the protocol the agent was never
/// launched with. It names the Ticket id, the file of record to read and annotate, the branch to
/// commit on, and the Outcome contract (done or checkpoint with a Brief, an optional Spawn array), so
/// an enlisted ticket can end the ordinary way rather than only by the tab closing. The engine types
/// it into the pane, never writes it to a file.
pub fn build_enlist_teaching(parts: &EnlistTeachingParts<'_>) -> String {
    [
        "---".to_owned(),
        String::new(),
        format!(
            "You have been enlisted into the pool as Ticket {}. This terminal is now the attempt for \
             that ticket; nothing about your checkout has moved.",
            parts.id
        ),
        String::new(),
        format!(
            "Your Ticket file of record is {}: read it for the spec and append your notes there. The \
             engine owns its line-1 status marker; never edit it.",
            parts.issue_path
        ),
        String::new(),
        format!(
            "Commit your work on the branch already checked out here ({}). Leave the branch and the \
             directory as they are: the engine never removes the directory or deletes the branch.",
            parts.branch
        ),
        String::new(),
        format!(
            "When the work is done, record your outcome as JSON at {}: {{\"status\": \"done\" or \
             \"checkpoint\", \"summary\": \"what you did, in a sentence or two\", \"commitSha\": \"the \
             sha of your commit, or null\"}}. On a checkpoint, add \"brief\": \"what the human has to do \
             next\".",
            parts.outcome_path
        ),
        String::new(),
        format!(
            "You may propose follow-up tickets in that same outcome JSON by adding a \"spawn\" array, \
             one entry per follow-up, each shaped {{\"title\": \"...\", \"body\": \"...\", \
             \"blockedBy\": [\"id\", ...]}}, the body carrying at least {SPAWN_BODY_MIN_CHARS} \
             characters of intent for a fresh agent to work from. {SPAWN_BLOCKS_TEACHING} The engine \
             assigns the ids, writes the ticket files and schedules them. You never write pool state \
             yourself: no ticket files, no ids, no statuses. You propose; the engine writes."
        ),
        String::new(),
        spawn_ledger_teaching(parts.ledger_path),
    ]
    .join("\n")
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

    // prompt.test.ts: the Conversation teaching, compared with what the TypeScript builds for the same
    // inputs (crates/core/testdata/conversation_teaching.json).
    #[test]
    fn the_conversation_teaching_is_the_typescripts_byte_for_byte() {
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../testdata/conversation_teaching.json")).unwrap();
        let text = |name: &str| expected[name].as_str().unwrap().to_owned();
        let own = |model: &str, effort: Option<&str>, drivers: &str| TeachingAssignment {
            harness: Some("claude".into()),
            model: Some(model.into()),
            effort: effort.map(str::to_owned),
            drivers: Some(drivers.into()),
        };
        let defaults = TeachingAssignment {
            harness: Some("opencode".into()),
            model: Some("x".into()),
            effort: None,
            drivers: Some("implement review".into()),
        };
        assert_eq!(
            build_conversation_teaching(
                "/p/runs/conv-1.spawn.json",
                &own("m", Some("high"), "implement"),
                &defaults,
                5,
                "/p/runs/spawn-ledger.md"
            ),
            text("a")
        );
        assert_eq!(
            build_conversation_teaching(
                "/s",
                &own("", None, "implement"),
                &TeachingAssignment::default(),
                0,
                "/l"
            ),
            text("b")
        );
        assert_eq!(
            build_conversation_teaching(
                "/s",
                &own("", None, "implement"),
                &TeachingAssignment::default(),
                1,
                "/l"
            ),
            text("c")
        );
    }

    #[test]
    fn the_steward_teaching_is_the_typescripts_byte_for_byte() {
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../testdata/steward_teaching.json")).unwrap();
        let own = TeachingAssignment {
            harness: Some("claude".into()),
            model: Some("m".into()),
            effort: None,
            drivers: Some("implement".into()),
        };
        let defaults = TeachingAssignment {
            harness: Some("opencode".into()),
            model: Some("x".into()),
            ..TeachingAssignment::default()
        };
        let build = |budget, may_close| {
            build_steward_teaching(&StewardTeaching {
                spawn_path: "/p/runs/conv-1.spawn.json",
                own: &own,
                defaults: &defaults,
                per_file: 5,
                ledger_path: "/p/runs/spawn-ledger.md",
                command: "/bin/ac steward --pool /p --as conv-1",
                budget,
                may_close,
            })
        };
        assert_eq!(build(1, true), expected["a"].as_str().unwrap());
        assert_eq!(build(5, false), expected["b"].as_str().unwrap());
    }

    // The whole teaching, byte for byte as the TypeScript renders it (prompt.ts buildEnlistTeaching).
    #[test]
    fn renders_the_enlist_teaching_as_the_typescript_does() {
        assert_eq!(
            build_enlist_teaching(&EnlistTeachingParts {
                id: "enlist-1",
                issue_path: "/p/issues/enlist-1.md",
                outcome_path: "/p/runs/enlist-1.outcome.json",
                branch: "feature/x",
                ledger_path: "/p/runs/spawn-ledger.md",
            }),
            "---\n\nYou have been enlisted into the pool as Ticket enlist-1. This terminal is now the attempt for that ticket; nothing about your checkout has moved.\n\nYour Ticket file of record is /p/issues/enlist-1.md: read it for the spec and append your notes there. The engine owns its line-1 status marker; never edit it.\n\nCommit your work on the branch already checked out here (feature/x). Leave the branch and the directory as they are: the engine never removes the directory or deletes the branch.\n\nWhen the work is done, record your outcome as JSON at /p/runs/enlist-1.outcome.json: {\"status\": \"done\" or \"checkpoint\", \"summary\": \"what you did, in a sentence or two\", \"commitSha\": \"the sha of your commit, or null\"}. On a checkpoint, add \"brief\": \"what the human has to do next\".\n\nYou may propose follow-up tickets in that same outcome JSON by adding a \"spawn\" array, one entry per follow-up, each shaped {\"title\": \"...\", \"body\": \"...\", \"blockedBy\": [\"id\", ...]}, the body carrying at least 20 characters of intent for a fresh agent to work from. A follow-up that must run before other work may add \"blocks\": [\"id\", ...] to make those tickets wait for it, or \"blocks\": \"all\" to make every ticket that has not started yet wait for it; a ticket already running is never interrupted, and blocks is only for a ticket. The engine assigns the ids, writes the ticket files and schedules them. You never write pool state yourself: no ticket files, no ids, no statuses. You propose; the engine writes.\n\nBefore you propose anything, read the Spawn ledger at /p/runs/spawn-ledger.md: every Ticket and Conversation in the pool, and every proposal still waiting to land or held for the operator. Do not propose work it already lists. If a proposal still overlaps something there, add \"overlaps\": [\"id\", ...] naming what it overlaps: it is then held for the operator to decide instead of landing."
        );
    }
}
