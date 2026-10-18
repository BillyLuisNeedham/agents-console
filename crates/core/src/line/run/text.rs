//! Everything a Line writes in words: Ticket bodies, hold texts, the Finish Ticket's act, the
//! verdict teaching and checks, and the Ticket file text. Each is a pure function of run state and
//! facts, so the same projection always writes the same bytes.

use ac_protocol::{
    DecideItem, FindingSeverity, Outcome, ProveResult, ReviewVerdict, SpawnAssignRequest,
};
use serde::Deserialize;
use serde_json::Value;

use super::{
    EdgeRun, Handoff, LineFacts, LinePlaces, LineRun, NewConversation, NewHold, NewTicket,
    OutcomeCheck, Owner, Pass, TicketId, pass_number,
};
use crate::js;
use crate::line::{
    BRIEF_DIR, BaseBranch, EVIDENCE_SUFFIX, LINE_BRANCH_PREFIX, NO_VERDICT, VERIFY_DIR,
    brief_path, issue_number, line_name_of, prove_verdict, review_verdict, short_commit,
};
use crate::plan::{
    CheckpointPolicy, EdgeKey, FinishAct, Node, NodeBody, NodeId, SpawnPolicy, TicketKind,
    TicketNode, Verdict, WhenSpent,
};
use crate::pool::encode_spawn_assign;

// -------------------------------------------------------------------------------------------------
// Verdicts
// -------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct DecideVerdict {
    decide: String,
    #[serde(default)]
    fixes: Vec<DecideItem>,
    #[serde(default)]
    dropped: Vec<DecideItem>,
}

fn blank(text: &str) -> bool {
    js::trim(text).is_empty()
}

fn parse<T: serde::de::DeserializeOwned>(verdict: Option<&Value>) -> Result<T, String> {
    let verdict = verdict.ok_or("the Outcome has no verdict")?;
    serde_json::from_value(verdict.clone()).map_err(|e| format!("the verdict does not parse: {e}"))
}

fn decide(verdict: Option<&Value>) -> Result<(Verdict, DecideVerdict), String> {
    let decide: DecideVerdict = parse(verdict)?;
    let choice = match decide.decide.as_str() {
        "ship" => Verdict::Ship,
        "another-round" => Verdict::AnotherRound,
        other => {
            return Err(format!(
                "decide is \"{other}\": it must be \"ship\" or \"another-round\""
            ));
        }
    };
    for (list, items) in [("fixes", &decide.fixes), ("dropped", &decide.dropped)] {
        if let Some(i) = items
            .iter()
            .position(|item| blank(&item.title) || blank(&item.reason))
        {
            return Err(format!("{list} item {} needs a title and a reason", i + 1));
        }
    }
    if choice == Verdict::AnotherRound && decide.fixes.is_empty() {
        return Err("another-round names at least one fix".into());
    }
    Ok((choice, decide))
}

/// A Line Ticket's verdict as its node's kind reads it from the Outcome: the one conversion the
/// attempt's exit and the run's facts share.
pub fn verdict_of(kind: TicketKind, verdict: Option<&Value>) -> Result<Verdict, String> {
    match kind {
        TicketKind::Agent => Ok(Verdict::Done),
        TicketKind::Prove => Ok(match prove_verdict(verdict)?.prove {
            ProveResult::Pass => Verdict::Pass,
            ProveResult::Fail => Verdict::Fail,
        }),
        TicketKind::Review => Ok(if review_verdict(verdict)?.findings.is_empty() {
            Verdict::Clean
        } else {
            Verdict::Findings
        }),
        TicketKind::Decide => decide(verdict).map(|(choice, _)| choice),
    }
}

impl OutcomeCheck {
    /// Why a done Outcome's verdict does not pass, `None` when it does. `exists` says whether a
    /// file is at a path: Decide's report must be.
    pub fn problem(
        &self,
        verdict: Option<&Value>,
        exists: &dyn Fn(&str) -> bool,
    ) -> Option<String> {
        match self {
            OutcomeCheck::Agent => None,
            OutcomeCheck::Prove => verdict_of(TicketKind::Prove, verdict).err(),
            OutcomeCheck::Review => verdict_of(TicketKind::Review, verdict).err(),
            OutcomeCheck::Decide { musts, report } => {
                let (choice, decide) = match decide(verdict) {
                    Ok(parsed) => parsed,
                    Err(problem) => return Some(problem),
                };
                let named = |items: &[DecideItem], title: &str| {
                    items
                        .iter()
                        .any(|item| js::trim(&item.title) == js::trim(title))
                };
                let round = choice == Verdict::AnotherRound;
                let missing: Vec<String> = musts
                    .iter()
                    .filter(|must| {
                        !(round && named(&decide.fixes, must)) && !named(&decide.dropped, must)
                    })
                    .map(|must| format!("\"{must}\""))
                    .collect();
                if !missing.is_empty() {
                    return Some(format!(
                        "every must finding has to be {} with a reason; not accounted for: {}",
                        if round {
                            "fixed or dropped"
                        } else {
                            "dropped (ship fixes nothing)"
                        },
                        missing.join(", ")
                    ));
                }
                (!exists(report)).then(|| {
                    format!(
                        "the report is not at {report}: write the report there, then record the \
                         verdict"
                    )
                })
            }
            OutcomeCheck::FinishAct(FinishAct::Pr | FinishAct::DraftPr) => {
                let url = verdict
                    .and_then(|v| v.get("url"))
                    .and_then(Value::as_str)
                    .filter(|url| !blank(url));
                url.is_none()
                    .then(|| "the verdict has no url: give the PR's url".to_owned())
            }
            OutcomeCheck::FinishAct(_) => None,
        }
    }

    /// The Brief of the "no verdict" checkpoint (ADR-0037): why, and the shape to write.
    pub fn no_verdict_brief(&self, problem: &str) -> String {
        format!(
            "{NO_VERDICT}\n\n{problem}. The engine routes this Line from the verdict and never \
             guesses one. Resume (or Keep talking) and record the Outcome again with a valid \
             verdict.\n\n{}",
            self.teaching().unwrap_or_default()
        )
    }

    /// What the agent is taught about its verdict, in its Ticket and its no-verdict checkpoint.
    pub fn teaching(&self) -> Option<String> {
        let (who, shape) = match self {
            OutcomeCheck::FinishAct(FinishAct::Pr | FinishAct::DraftPr) => {
                ("the Finish", "\"verdict\": {\"url\": \"the PR's url\"}.")
            }
            OutcomeCheck::Prove => (
                "a Prove node",
                "\"verdict\": {\"prove\": \"pass\" or \"fail\", \"evidence\": \"the path of the \
                 evidence you gathered\"}. On a fail, the Outcome's \"brief\" says what failed and \
                 how to reproduce it: the work that follows starts from it.",
            ),
            OutcomeCheck::Review => (
                "a Review node",
                "\"verdict\": {\"findings\": [{\"severity\": \"must\" or \"should\" or \"nit\", \
                 \"title\": \"...\", \"detail\": \"...\"}, ...]}, the list empty when you found \
                 nothing. A must is something the Line cannot finish with.",
            ),
            OutcomeCheck::Decide { .. } => (
                "a Decide node",
                "\"verdict\": {\"decide\": \"ship\" or \"another-round\", \"fixes\": [{\"title\": \
                 \"...\", \"reason\": \"...\"}, ...], \"dropped\": [{\"title\": \"...\", \
                 \"reason\": \"...\"}, ...]}. another-round names at least one fix. Account for \
                 every must finding by its exact title: fixed in the next round or dropped with a \
                 reason (on ship, dropped).",
            ),
            OutcomeCheck::Agent | OutcomeCheck::FinishAct(_) => return None,
        };
        Some(format!(
            "This Ticket runs {who} of a Line. Its Outcome must carry a verdict beside status \
             \"done\": {shape} An Outcome without a valid verdict checkpoints the Ticket with \
             \"{NO_VERDICT}\". The engine routes the Line from the verdict: never propose the next \
             node yourself."
        ))
    }
}

// -------------------------------------------------------------------------------------------------
// What a Decide pass reads
// -------------------------------------------------------------------------------------------------

fn kind_of(run: &LineRun, ticket: &TicketId) -> Option<TicketKind> {
    let Some(Owner::Copy(node)) = run.owner(ticket) else {
        return None;
    };
    match &run.plan.node(node)?.body {
        NodeBody::Ticket(t) => Some(t.kind),
        _ => None,
    }
}

/// The Prove and Review Tickets settled before `end` in the settle order, back to the previous
/// Ticket of `node`.
pub(super) fn reads_before(run: &LineRun, node: &NodeId, end: usize) -> Vec<TicketId> {
    let mut reads: Vec<TicketId> = run.settled[..end]
        .iter()
        .rev()
        .take_while(|t| run.node_of(t) != Some(node))
        .filter(|t| {
            matches!(
                kind_of(run, t),
                Some(TicketKind::Prove | TicketKind::Review)
            )
        })
        .cloned()
        .collect();
    reads.reverse();
    reads
}

fn findings_of(reads: &[TicketId], facts: &dyn LineFacts) -> Vec<(TicketId, ReviewVerdict)> {
    reads
        .iter()
        .filter_map(|t| {
            let verdict = review_verdict(facts.outcome(t)?.verdict.as_ref()).ok()?;
            Some((t.clone(), verdict))
        })
        .collect()
}

/// The titles of the must findings among the Reviews a Decide pass reads.
pub(super) fn musts(reads: &[TicketId], facts: &dyn LineFacts) -> Vec<String> {
    findings_of(reads, facts)
        .into_iter()
        .flat_map(|(_, v)| v.findings)
        .filter(|f| f.severity == FindingSeverity::Must)
        .map(|f| js::trim(&f.title).to_owned())
        .collect()
}

// -------------------------------------------------------------------------------------------------
// Ticket bodies
// -------------------------------------------------------------------------------------------------

fn kind_name(kind: TicketKind) -> &'static str {
    match kind {
        TicketKind::Agent => "Agent",
        TicketKind::Prove => "Prove",
        TicketKind::Review => "Review",
        TicketKind::Decide => "Decide",
    }
}

fn spec_section(places: &LinePlaces) -> Option<String> {
    places.spec.as_ref().map(|spec| {
        format!(
            "## The spec\n\n`{}` in the pool checkout. Read it in full before you start: every \
             decision is already made there.",
            js::trim(spec)
        )
    })
}

fn work_section(places: &LinePlaces) -> Option<String> {
    places
        .work
        .as_ref()
        .map(|work| format!("## The Line's work\n\n{}", js::trim(work)))
}

fn sections(parts: impl IntoIterator<Item = Option<String>>) -> String {
    parts.into_iter().flatten().collect::<Vec<_>>().join("\n\n")
}

fn ticket_list(tickets: &[TicketId]) -> String {
    tickets
        .iter()
        .map(|t| format!("`{t}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn handoff_sections(input: &Handoff) -> [Option<String>; 2] {
    [
        input
            .halted
            .as_ref()
            .map(|why| format!("## Halted upstream\n\nWork upstream halted: {why}.")),
        input.notes.as_ref().map(|notes| {
            format!(
                "## Notes\n\nThe work came back through a hold answered with these notes: act on \
                 them.\n\n{}",
                js::trim(notes)
            )
        }),
    ]
}

fn items_section(input: &Handoff) -> Option<String> {
    (!input.items.is_empty()).then(|| {
        let items: Vec<String> = input
            .items
            .iter()
            .enumerate()
            .map(|(i, item)| format!("### {}. {}\n\n{}", i + 1, item.title, item.body))
            .collect();
        format!("## Items\n\n{}", items.join("\n\n"))
    })
}

fn finding_line(f: &ac_protocol::ReviewFinding) -> String {
    format!(
        "- [{}] **{}**: {}",
        f.severity,
        js::trim(&f.title),
        f.detail
    )
}

fn failure_of(outcome: &Outcome) -> &str {
    outcome
        .brief
        .as_deref()
        .filter(|b| !blank(b))
        .unwrap_or(&outcome.summary)
}

/// One upstream Ticket's Outcome, as the Ticket after it reads it.
fn before_entry(run: &LineRun, ticket: &TicketId, facts: &dyn LineFacts) -> Option<String> {
    let kind = kind_of(run, ticket)?;
    let outcome = facts.outcome(ticket)?;
    let verdict = outcome.verdict.as_ref();
    Some(match kind {
        TicketKind::Agent => format!("### `{ticket}`\n\n{}", js::trim(&outcome.summary)),
        TicketKind::Prove => {
            let proved = prove_verdict(verdict).ok()?;
            match proved.prove {
                ProveResult::Pass => format!(
                    "### Prove `{ticket}` passed\n\n{}\n\nEvidence: `{}`",
                    js::trim(&outcome.summary),
                    js::trim(&proved.evidence)
                ),
                ProveResult::Fail => format!(
                    "### Prove `{ticket}` failed\n\nThe work is already merged on the Line's \
                     branch: fix what Prove found on top of it, with tests, and commit.\n\nWhat \
                     Prove found:\n\n{}\n\nEvidence: `{}`",
                    js::trim(failure_of(outcome)),
                    js::trim(&proved.evidence)
                ),
            }
        }
        TicketKind::Review => {
            let reviewed = review_verdict(verdict).ok()?;
            if reviewed.findings.is_empty() {
                format!("### Review `{ticket}` found nothing")
            } else {
                let lines: Vec<String> = reviewed.findings.iter().map(finding_line).collect();
                format!("### Review `{ticket}`\n\n{}", lines.join("\n"))
            }
        }
        TicketKind::Decide => {
            let (choice, decided) = decide(verdict).ok()?;
            if choice == Verdict::Ship {
                return Some(format!(
                    "### Decide `{ticket}` chose to ship\n\n{}",
                    js::trim(&outcome.summary)
                ));
            }
            let end = run.settled.iter().position(|t| t == ticket)?;
            let node = run.node_of(ticket)?;
            let findings = findings_of(&reads_before(run, node, end), facts);
            let detail = |title: &str| {
                findings
                    .iter()
                    .flat_map(|(_, v)| &v.findings)
                    .find(|f| js::trim(&f.title) == js::trim(title))
                    .map(|f| format!("\n  {} ({})", f.detail, f.severity))
                    .unwrap_or_default()
            };
            let fixes: Vec<String> = decided
                .fixes
                .iter()
                .map(|item| {
                    format!(
                        "- **{}**: {}{}",
                        js::trim(&item.title),
                        item.reason,
                        detail(&item.title)
                    )
                })
                .collect();
            let dropped: Vec<String> = decided
                .dropped
                .iter()
                .map(|d| format!("- {}: {}", js::trim(&d.title), d.reason))
                .collect();
            format!(
                "### Decide `{ticket}` chose another round\n\nMake each of these fixes on top of \
                 the work already on the Line's branch, with tests, and commit.\n\n{}{}",
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
    })
}

fn before_section(
    run: &LineRun,
    input: &Handoff,
    skip: &[TicketId],
    facts: &dyn LineFacts,
) -> Option<String> {
    let entries: Vec<String> = input
        .after
        .iter()
        .filter(|t| !skip.contains(t))
        .filter_map(|t| before_entry(run, t, facts))
        .collect();
    (!entries.is_empty()).then(|| format!("## What came before\n\n{}", entries.join("\n\n")))
}

fn reads_sections(reads: &[TicketId], facts: &dyn LineFacts) -> [Option<String>; 2] {
    let none = |lines: Vec<String>| {
        if lines.is_empty() {
            "_(none)_".to_owned()
        } else {
            lines.join("\n")
        }
    };
    let proves: Vec<String> = reads
        .iter()
        .filter_map(|t| {
            let proved = prove_verdict(facts.outcome(t)?.verdict.as_ref()).ok()?;
            Some(format!(
                "- `{t}`: {} (evidence `{}`)",
                proved.prove,
                js::trim(&proved.evidence)
            ))
        })
        .collect();
    let findings: Vec<String> = findings_of(reads, facts)
        .into_iter()
        .flat_map(|(t, v)| {
            v.findings
                .iter()
                .map(|f| format!("{} (`{t}`)", finding_line(f)))
                .collect::<Vec<_>>()
        })
        .collect();
    [
        Some(format!(
            "## Prove since the last Decide\n\n{}",
            none(proves)
        )),
        Some(format!(
            "## Review findings since the last Decide\n\n{}",
            none(findings)
        )),
    ]
}

fn evidence_dir(facts: &dyn LineFacts, ticket: &TicketId) -> String {
    format!(
        "{}/{ticket}{EVIDENCE_SUFFIX}",
        facts.runs_dir().trim_end_matches('/')
    )
}

fn what_to_do(run: &LineRun, node: &NodeId, t: &TicketNode, pass: &Pass) -> String {
    let task = match t.kind {
        TicketKind::Agent => "Build what the spec and the sections below ask for, on top of the \
                              work already on the Line's branch, with tests, and commit to the \
                              current branch. Your work merges onto the Line's branch when you \
                              finish; the Line hands it on from there."
            .to_owned(),
        TicketKind::Prove => "Prove the work already merged on the Line's branch: run the change \
                              end to end the way it will be used and gather evidence that it \
                              works or that it does not. This is not a code review. A fail sends \
                              the work back with your brief, so say exactly what failed and how \
                              to reproduce it."
            .to_owned(),
        TicketKind::Review => {
            // The cut commit never moves, so a base pushed, rebased or deleted mid-Line changes
            // nothing here.
            let since = match &run.places.base {
                Some(base) => format!(
                    "the changes since it left `{}` at `{}`: `git diff {}..HEAD`",
                    base.base_ref, base.commit, base.commit
                ),
                None => "the changes since it left main".to_owned(),
            };
            format!(
                "Review the work on the Line's branch ({since}) against the spec and the \
                 repository's standards. Report each finding with a severity: must (the Line \
                 cannot finish with it), should, or nit. Change no code."
            )
        }
        TicketKind::Decide => format!(
            "Decide how this pass ends. {}",
            decide_choice(run, node, pass)
        ),
    };
    format!("## What to do\n\n{task}")
}

fn decide_choice(run: &LineRun, node: &NodeId, pass: &Pass) -> String {
    if let Some(why) = &pass.input.halted {
        return format!(
            "Work upstream halted ({why}). Record \"ship\", dropping every must with the reason \
             that the work halted: the operator decides what next at the Finish."
        );
    }
    let Some(edge) = run.plan.out(node, Verdict::AnotherRound).next() else {
        return "This Plan has no another-round edge from here: record \"ship\", dropping every \
                must with a reason."
            .to_owned();
    };
    let choose = "Choose another round (with the fixes you pick: every must, and any shoulds and \
                  nits worth it) or ship.";
    let Some(cap) = &edge.cap else {
        return choose.to_owned();
    };
    let used = run
        .edges
        .get(&edge.key)
        .map_or((0, 0), |e| (e.count, e.bought));
    let left = (cap.max.get() + used.1).saturating_sub(used.0);
    match (left, &cap.when_spent) {
        (0, WhenSpent::To(to)) => format!(
            "No round is left: another-round now goes to {to} instead, so record \"ship\", \
             dropping every must with a reason."
        ),
        (0, WhenSpent::Hold) => format!(
            "{choose} No round is left: another-round now waits at a hold for the operator, who \
             may buy one more."
        ),
        (1, _) => format!("{choose} 1 more round is left."),
        (left, _) => format!("{choose} {left} more rounds are left."),
    }
}

fn header(node: &Node, kind: &str, n: u32, spawns: SpawnPolicy) -> String {
    format!(
        "**Node** `{}` ({kind}) of this pool's Line, pass {n} (ADR-0039): the engine wrote this \
         Ticket from the Line's Plan and the work handed to it, and routes its Outcome along the \
         Plan's edges. Never propose the next node yourself; {}.",
        node.id,
        match spawns {
            SpawnPolicy::Hold => "anything else you propose is held for the operator",
            SpawnPolicy::Land => "anything else you propose lands as any Ticket's would",
        }
    )
}

pub(super) fn copy_ticket(
    run: &LineRun,
    node: &Node,
    t: &TicketNode,
    pass: &Pass,
    copy: &super::CopyRun,
    facts: &dyn LineFacts,
) -> NewTicket {
    let check = run
        .outcome_check(&copy.ticket, facts)
        .unwrap_or(OutcomeCheck::Agent);
    let [halted, notes] = handoff_sections(&pass.input);
    let items = copy
        .item
        .as_ref()
        .map(|item| format!("## Your item\n\n### {}\n\n{}", item.title, item.body))
        .or_else(|| items_section(&pass.input));
    let [proves, findings] = if t.kind == TicketKind::Decide {
        reads_sections(&pass.reads, facts)
    } else {
        [None, None]
    };
    let evidence = (t.kind == TicketKind::Prove).then(|| {
        format!(
            "## Your evidence\n\nWrite the evidence to `{}/`, and name that path in your \
             verdict's \"evidence\". It is in the pool directory, so it stays out of the Line's \
             branch and out of the PR its Finish opens: this one path is yours to write despite \
             the rule against writing into the pool directory. Never commit the evidence. If the \
             skill you prove with makes its own run folder (`{VERIFY_DIR}/` at the root of your \
             checkout, say), use the evidence path as that folder, or move the folder there when \
             you finish, and leave nothing of it in git.",
            evidence_dir(facts, &copy.ticket)
        )
    });
    let report = match &check {
        OutcomeCheck::Decide { report, .. } => Some(format!(
            "## The report\n\nBefore you record your Outcome, write the report with /html to \
             `{report}`: every Prove's evidence, linked at its path in the pool's runs directory \
             beside the report (`<prove ticket>{EVIDENCE_SUFFIX}/`, so a relative link works), \
             every Review finding and what happened to it (fixed in a later round, or dropped and \
             why), and your decision. It is the one file you write outside your working \
             directory besides your Outcome. Without it the Ticket checkpoints with \
             \"{NO_VERDICT}\". The operator approves the Line from the latest report at the \
             Finish."
        )),
        _ => None,
    };
    let body = sections([
        Some(header(node, kind_name(t.kind), pass.n, t.spawns)),
        spec_section(&run.places),
        work_section(&run.places),
        Some(what_to_do(run, &node.id, t, pass)),
        items,
        halted,
        notes,
        before_section(run, &pass.input, &pass.reads, facts),
        proves,
        findings,
        evidence,
        report,
        t.note
            .as_ref()
            .map(|note| format!("## Note for this node\n\n{}", js::trim(note))),
        check
            .teaching()
            .map(|teaching| format!("## Your verdict\n\n{teaching}")),
    ]);
    let title = match &copy.item {
        Some(item) => format!("{}, pass {}: {}", node.title, pass.n, item.title),
        None => format!("{}, pass {}", node.title, pass.n),
    };
    NewTicket {
        id: copy.ticket.clone(),
        node: node.id.clone(),
        title,
        body,
        blocked_by: pass.input.after.clone(),
        assign: t.assign.clone(),
        skill: t.skill.clone(),
        check,
        checkpoint: t.checkpoint,
        conflict: run.plan.conflict_for(&node.id).cloned(),
    }
}

impl LineRun {
    /// Where a Conversation pass commits its Line brief: `docs/specs/<line>.<id>.brief.json`.
    pub fn brief_path(&self, conversation: &TicketId) -> String {
        brief_path(&self.places.branch, conversation.as_str())
    }
}

// What a Conversation pass opens on: the work as the operator gave it, an issue number spelled out,
// and the Line base it was cut from.
fn talk_work_section(places: &LinePlaces) -> Option<String> {
    let work = js::trim(places.work.as_deref()?);
    let asked = match issue_number(work) {
        Some(number) => format!(
            "The piece of work for this Line is issue #{number}. Read it (gh issue view {number}) \
             and grill me on it."
        ),
        None => work.to_owned(),
    };
    let cut = places.base.as_ref().map(|base| {
        format!(
            "This Line was cut from `{}` at `{}`.",
            base.base_ref,
            short_commit(&base.commit)
        )
    });
    Some(format!(
        "## The Line's work\n\n{}",
        sections([Some(asked), cut])
    ))
}

pub(super) fn conversation(
    run: &LineRun,
    node: &Node,
    pass: &Pass,
    id: &TicketId,
) -> NewConversation {
    let (assign, skill, note) = match &node.body {
        NodeBody::Conversation(c) => (c.assign.clone(), c.skill.clone(), c.note.clone()),
        _ => Default::default(),
    };
    let line = line_name_of(&run.places.branch);
    let [halted, notes] = handoff_sections(&pass.input);
    let opening = sections([
        Some(format!(
            "You are the {} Conversation (`{id}`) of this pool's Line (ADR-0039): you sharpen \
             the work with the operator before the next node runs. When the operator agrees the \
             plan, write the spec at `{BRIEF_DIR}/{line}.md` and the Line brief at `{}`, and \
             commit both on your branch. The brief is JSON, {{\"spec\": \"{BRIEF_DIR}/{line}.md\"}}, \
             which may add \"finish\" (none, draft-pr, pr, fast-forward, or a sentence naming \
             another act), \"pushBase\": true (the Finish may push the Line base to origin, only \
             to create it or fast-forward it, never forcing), \"items\": [{{\"title\": \"...\", \
             \"body\": \"...\"}}], and \"nodes\": {{\"<node id>\": {{\"assign\": {{\"harness\", \
             \"model\", \"effort\"}}, \"note\": \"...\"}}}}. Never start or propose a node \
             yourself: the engine routes the Line.",
            node.title,
            run.brief_path(id)
        )),
        talk_work_section(&run.places),
        items_section(&pass.input),
        halted,
        notes,
        note.map(|note| format!("## Note for this node\n\n{}", js::trim(&note))),
    ]);
    NewConversation {
        id: id.clone(),
        node: node.id.clone(),
        title: format!("{}, pass {}", node.title, pass.n),
        opening,
        assign,
        skill,
    }
}

// -------------------------------------------------------------------------------------------------
// Holds
// -------------------------------------------------------------------------------------------------

fn after_clause(after: &[TicketId]) -> String {
    if after.is_empty() {
        String::new()
    } else {
        format!(", after {}", ticket_list(after))
    }
}

fn hold(
    id: &TicketId,
    node: &NodeId,
    title: String,
    lead: String,
    brief: String,
    after: &[TicketId],
) -> NewHold {
    NewHold {
        id: id.clone(),
        node: node.clone(),
        title,
        body: format!("{lead}\n\n## The hold\n\n{brief}"),
        blocked_by: after.to_vec(),
        brief,
    }
}

pub(super) fn gate_hold(run: &LineRun, node: &Node, pass: &Pass, ticket: &TicketId) -> NewHold {
    let who = match &node.body {
        NodeBody::Gate(g) if g.open == crate::plan::Opener::Steward => {
            "the Steward or the operator"
        }
        _ => "the operator",
    };
    let revise = targets(run, &node.id, Verdict::Revise);
    let brief = format!(
        "The Line waits at the gate {} (`{}`){}. Resume (or Resume with \"approved\") opens it and \
         hands the work on; Resume with notes sends revise with your notes{}; Close sends closed.",
        node.title,
        node.id,
        after_clause(&pass.input.after),
        revise
    );
    hold(
        ticket,
        &node.id,
        format!("{}, pass {}", node.title, pass.n),
        format!(
            "**Gate** `{}` of this pool's Line, pass {} (ADR-0039). No agent runs this Ticket: it \
             waits for {who}.",
            node.id, pass.n
        ),
        brief,
        &pass.input.after,
    )
}

fn targets(run: &LineRun, node: &NodeId, verdict: Verdict) -> String {
    let to: Vec<String> = run
        .plan
        .out(node, verdict)
        .map(|e| e.key.to.to_string())
        .collect();
    if to.is_empty() {
        String::new()
    } else {
        format!(" to {}", to.join(", "))
    }
}

pub(super) fn loop_hold(
    run: &LineRun,
    key: &EdgeKey,
    edge: &EdgeRun,
    ticket: &TicketId,
    handoff: &Handoff,
) -> NewHold {
    let max = run
        .plan
        .edges()
        .iter()
        .find(|e| e.key == *key)
        .and_then(|e| e.cap.as_ref())
        .map_or(0, |cap| cap.max.get())
        + edge.bought;
    let brief = format!(
        "The loop {from} -> {to} is spent ({max} of {max}); Resume buys one more pass, Close \
         stops it. Resume with notes buys it too, and the notes go to {to}. Close hands {from}'s \
         work on as closed.",
        from = key.from,
        to = key.to
    );
    hold(
        ticket,
        &key.from,
        format!("Loop {} -> {} spent", key.from, key.to),
        format!(
            "**Loop hold** on `{}.{} -> {}` of this pool's Line (ADR-0039){}. No agent runs this \
             Ticket: it waits for the operator.",
            key.from,
            key.on.as_str(),
            key.to,
            after_clause(&handoff.after)
        ),
        brief,
        &handoff.after,
    )
}

fn act_word(act: &FinishAct) -> &str {
    match act {
        FinishAct::None => "none",
        FinishAct::DraftPr => "draft-pr",
        FinishAct::Pr => "pr",
        FinishAct::FastForward => "fast-forward",
        FinishAct::Other(text) => text,
    }
}

/// The report of the latest Decide pass that settled done, if any.
fn latest_report(run: &LineRun, facts: &dyn LineFacts) -> Option<String> {
    run.settled.iter().rev().find_map(|t| {
        if kind_of(run, t)? != TicketKind::Decide {
            return None;
        }
        let node = run.node_of(t)?;
        let n = pass_number(t.as_str(), node.as_str())?;
        Some(run.report_path(node, n, &facts.runs_dir()))
    })
}

pub(super) fn finish_hold(
    run: &LineRun,
    node: &Node,
    pass: &Pass,
    ticket: &TicketId,
    facts: &dyn LineFacts,
) -> NewHold {
    let act = run.finish_act();
    let halted = pass
        .input
        .halted
        .as_ref()
        .map(|h| format!("Work upstream halted: {h}. "))
        .unwrap_or_default();
    let report = match latest_report(run, facts) {
        Some(path) => format!("The report: {path} (open it in the Console's Detail). "),
        None => "There is no report. ".to_owned(),
    };
    let approve = match act {
        FinishAct::None => " and end it".to_owned(),
        act => format!(
            ", after which `{ticket}-act` carries out the Finish (`{}`)",
            act_word(act)
        ),
    };
    let revise = match targets(run, &node.id, Verdict::Revise) {
        to if to.is_empty() => "is refused, since this Plan's Finish has no revise edge".to_owned(),
        to => format!("sends them back{to}"),
    };
    let brief = format!(
        "The Line has reached its Finish{}. {halted}{report}Resume with \"{}\" (or no note) to \
         approve the Line{approve}; Resume with notes {revise}; Close ends the Line here. Approval \
         is refused while anything in the pool still runs, queues or waits.",
        after_clause(&pass.input.after),
        crate::line::APPROVED
    );
    hold(
        ticket,
        &node.id,
        format!("{}, pass {}", node.title, pass.n),
        sections([
            Some(format!(
                "**Finish** `{}` of this pool's Line (ADR-0039). No agent runs this Ticket: it is \
                 where the operator approves the Line. Finish: `{}`.",
                node.id,
                act_word(act)
            )),
            spec_section(&run.places),
        ]),
        brief,
        &pass.input.after,
    )
}

// -------------------------------------------------------------------------------------------------
// The Finish Ticket
// -------------------------------------------------------------------------------------------------

fn on_line_branch(places: &LinePlaces) -> bool {
    js::trim(&places.branch).starts_with(LINE_BRANCH_PREFIX)
}

/// The branch on origin a Line's PR targets: its Line base's name there, `main` for none.
fn pr_base(places: &LinePlaces) -> String {
    match &places.base {
        Some(base) => BaseBranch::of(&base.base_ref).name().to_owned(),
        None => "main".to_owned(),
    }
}

// A Finish not carried out is the operator's to answer, so it is a checkpoint: a done `pr` or
// `draft-pr` Outcome must carry the PR's url.
const NOT_CARRIED_OUT: &str = "push nothing and open no PR, and record a checkpoint Outcome whose \
                               brief says the Finish was not carried out, and why";

/// What the Finish Ticket carries out, by its act.
fn act_text(act: &FinishAct, places: &LinePlaces) -> String {
    let name = line_name_of(&places.branch);
    let line_branch = js::trim(&places.branch);
    let branch = format!("`{line_branch}`");
    let cleanup = format!(
        "First delete the Line's spec and briefs (`{BRIEF_DIR}/{name}*`) and any `{VERIFY_DIR}/` \
         directory committed on the Line's branch (Prove's evidence belongs in the pool, never in \
         the PR), in one final commit on your branch. Then push your HEAD as the Line's branch \
         (`git push origin HEAD:{line_branch}`)."
    );
    let not_line = |kind: &str| {
        format!(
            "`{kind}`: but the pool's branch {branch} is not a Line branch \
             ({LINE_BRANCH_PREFIX}...), so {NOT_CARRIED_OUT}."
        )
    };
    let named = matches!(
        act,
        FinishAct::DraftPr | FinishAct::Pr | FinishAct::FastForward
    );
    if named && !on_line_branch(places) {
        return not_line(act_word(act));
    }
    match act {
        FinishAct::None => "`none`: nothing.".to_owned(),
        FinishAct::DraftPr | FinishAct::Pr => {
            let draft = *act == FinishAct::DraftPr;
            let target = pr_base(places);
            format!(
                "`{}`: open a {}PR for the Line. {cleanup} Then open the PR from {branch} against \
                 `{target}` with `gh pr create{} --base {target} --head {line_branch}`, its body \
                 summing up the Line from the report. The PR's url is the Finish's result.",
                act_word(act),
                if draft { "draft " } else { "" },
                if draft { " --draft" } else { "" },
            )
        }
        FinishAct::FastForward => format!("`fast-forward`: {cleanup} {}", fast_forward(places)),
        FinishAct::Other(text) => format!(
            "carry this out as written, and say in your Outcome's summary what came of it: {text}"
        ),
    }
}

fn fast_forward(places: &LinePlaces) -> String {
    let Some(base) = &places.base else {
        return format!(
            "The Line has no recorded base, so fast-forward nothing: {NOT_CARRIED_OUT}."
        );
    };
    match BaseBranch::of(&base.base_ref) {
        BaseBranch::Local(name) => format!(
            "Then fast-forward the local branch `{name}` to your HEAD with `git fetch . \
             HEAD:refs/heads/{name}`, which refuses anything but a fast-forward; if it refuses, \
             stop and record a checkpoint Outcome saying so. {}",
            if places.push_base {
                format!(
                    "The Line brief grants `pushBase`: then push it with `git push origin \
                     refs/heads/{name}:refs/heads/{name}`, never forcing; if origin's `{name}` \
                     has diverged, leave it and say so."
                )
            } else {
                format!("The Line brief does not grant `pushBase`: never push `{name}` to origin.")
            }
        ),
        BaseBranch::Origin(name) if places.push_base => format!(
            "Then fast-forward origin's `{name}` to your HEAD with `git push origin \
             HEAD:refs/heads/{name}`, never forcing; if origin refuses it as not a fast-forward, \
             stop and record a checkpoint Outcome saying so."
        ),
        BaseBranch::Origin(name) => format!(
            "The Line was cut from origin's `{name}` and the Line brief does not grant \
             `pushBase`, so push nothing to `{name}`: record a checkpoint Outcome whose brief says \
             the Finish was not carried out, and why."
        ),
    }
}

/// What a `pr` or `draft-pr` Finish does about the Line base on origin before it pushes anything
/// (ADR-0038): checked when the Finish runs, never inferred.
fn base_on_origin(places: &LinePlaces) -> Option<String> {
    let base = places.base.as_ref()?;
    let branch = BaseBranch::of(&base.base_ref);
    let name = branch.name();
    let check = format!(
        "Before you push anything, check the Line base on origin with `git ls-remote --heads \
         origin {name}` (origin only, never another remote)"
    );
    if let BaseBranch::Origin(_) = branch {
        return Some(format!(
            "The Line was cut from `{}`, so origin already had its Line base and there is no local \
             base to push: never push `{name}`. {check}. If origin still has `{name}`, open the PR. \
             If it no longer does, {NOT_CARRIED_OUT}.",
            base.base_ref
        ));
    }
    let grant = if places.push_base {
        format!(
            "The Line brief grants `pushBase`: you may push the Line base `{name}` to origin, but \
             only to create it or to fast-forward it. Never force-push it."
        )
    } else {
        format!(
            "The Line brief does not grant `pushBase`: never push the Line base `{name}` to origin."
        )
    };
    let rows = if places.push_base {
        format!(
            "- origin has no `{name}`: push the local base to create it (`git push origin \
             refs/heads/{name}:refs/heads/{name}`), then open the PR.\n\
             - origin's `{name}` is the local `{name}`: open the PR.\n\
             - the local `{name}` is ahead of origin's (a fast-forward): push it (`git push origin \
             refs/heads/{name}:refs/heads/{name}`), then open the PR.\n\
             - they have diverged, so it would take a force-push: {NOT_CARRIED_OUT}."
        )
    } else {
        format!(
            "- origin has no `{name}`: {NOT_CARRIED_OUT}.\n\
             - origin's `{name}` is the local `{name}`: open the PR.\n\
             - the local `{name}` is ahead of origin's: open the PR, and note in your summary that \
             it carries the base's unpushed commits.\n\
             - they have diverged, so it would take a force-push: {NOT_CARRIED_OUT}."
        )
    };
    Some(format!(
        "### The Line base on origin\n\n{grant} {check}, compare it with the local branch `{name}` \
         the Line was cut from, and act on what you find:\n\n{rows}"
    ))
}

pub(super) fn act_ticket(run: &LineRun, ticket: &TicketId) -> NewTicket {
    let finish = run.plan.finish();
    let node = run.plan.node(finish).expect("the Plan has its Finish");
    let assign = match &node.body {
        NodeBody::Finish(f) => f.assign.clone(),
        _ => Default::default(),
    };
    let act = run.finish_act();
    let hold = TicketId::new(ticket.as_str().trim_end_matches("-act"));
    let opens_pr = matches!(act, FinishAct::Pr | FinishAct::DraftPr) && on_line_branch(&run.places);
    let check = OutcomeCheck::FinishAct(act.clone());
    let base = opens_pr.then(|| base_on_origin(&run.places)).flatten();
    let check_base = if base.is_some() {
        " Before you push anything, check the Line base on origin as the section below says."
    } else {
        ""
    };
    let body = sections([
        Some(format!(
            "**Finish** `{finish}` of this pool's Line (ADR-0039): the operator approved the Line \
             at `{hold}`, and this Ticket carries out its act. It is safe to run again: before \
             each step, check whether it is already done (an open PR from the Line's branch is the \
             result, a push origin already has changes nothing, a deleted spec stays deleted)."
        )),
        spec_section(&run.places),
        Some(format!(
            "## What to do\n\n{}{check_base}",
            act_text(act, &run.places)
        )),
        base,
        check
            .teaching()
            .map(|teaching| format!("## Your verdict\n\n{teaching}")),
    ]);
    NewTicket {
        id: ticket.clone(),
        node: finish.clone(),
        title: format!("{}: {}", node.title, act_word(act)),
        body,
        blocked_by: vec![hold],
        assign,
        skill: None,
        check,
        checkpoint: CheckpointPolicy::Operator,
        conflict: None,
    }
}

// -------------------------------------------------------------------------------------------------
// Ticket files
// -------------------------------------------------------------------------------------------------

fn blocked_by(ids: &[TicketId]) -> String {
    if ids.is_empty() {
        "none".to_owned()
    } else {
        ids.iter()
            .map(TicketId::as_str)
            .collect::<Vec<_>>()
            .join(",")
    }
}

/// A projected Ticket's whole file: `status=ready node=<id>`, and its Assignment and skill as the
/// `spawn-assign` token when any field is set.
pub fn ticket_text(ticket: &NewTicket) -> String {
    let assign = SpawnAssignRequest {
        harness: ticket.assign.harness.clone(),
        model: ticket.assign.model.clone(),
        effort: ticket.assign.effort.clone(),
        drivers: ticket.skill.clone(),
    };
    let empty = assign.harness.is_none()
        && assign.model.is_none()
        && assign.effort.is_none()
        && assign.drivers.is_none();
    let token = if empty {
        String::new()
    } else {
        format!(" spawn-assign={}", encode_spawn_assign(&assign))
    };
    format!(
        "<!-- state: id={} blocked-by={} status=ready node={}{token} -->\n\n# {}: {}\n\n{}\n",
        ticket.id,
        blocked_by(&ticket.blocked_by),
        ticket.node,
        ticket.id,
        ticket.title,
        ticket.body
    )
}

/// A projected hold's whole file: `status=checkpoint node=<id> hold`, never launched.
pub fn hold_text(hold: &NewHold) -> String {
    format!(
        "<!-- state: id={} blocked-by={} status=checkpoint node={} hold -->\n\n# {}: {}\n\n{}\n",
        hold.id,
        blocked_by(&hold.blocked_by),
        hold.node,
        hold.id,
        hold.title,
        hold.body
    )
}
