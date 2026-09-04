import type { Outcome } from "./engine.ts";

interface ResolverPromptParts {
  id: string;
  worktree: string;
  branch: string;
  workingBranch: string;
  files: string[];
  outcomePath: string;
}

export function buildResolverPrompt(parts: ResolverPromptParts): string {
  return [
    `Resolve the git merge conflict for ticket ${parts.id}.`,
    "",
    `You are in the git worktree at ${parts.worktree}, with branch ` +
      `${parts.branch} checked out. The pool's working branch is ` +
      parts.workingBranch + ".",
    "",
    `To reproduce the conflict, run: git merge ${parts.workingBranch}`,
    "Then resolve each conflicted file " +
      `(${parts.files.join(", ") || "see git status"}), stage the resolution ` +
      "with git add, and DO NOT commit.",
    "",
    "When you have staged a resolution, write JSON to " +
      `${parts.outcomePath}: {"resolved": true, "note": "what you did, in a ` +
      "sentence or two\"}",
    "",
    'If you cannot resolve it, write {"resolved": false, "note": "why"} and exit.',
    "",
  ].join("\n");
}

interface GraderPromptParts {
  buildId: string;
  attempt: number;
  /** The pool's verify skill, or null when the pool has none. */
  skill: string | null;
  ticketPath: string;
  outcomePath: string;
  diffPath: string;
  logPath: string;
  graderOutcomePath: string;
}

// The grader's prompt: the pool's verify skill parameterized with the bound
// attempt's artifact paths, then the grade contract. The skill is prose the
// engine never parses; the glue around it (paths, trust rule, outcome shape)
// is engine-owned so a pool whose skill drifted still grades to the contract.
export function buildGraderPrompt(parts: GraderPromptParts): string {
  const sections: string[] = [
    `You are a grader. One attempt is bound to you: attempt ` +
      `${parts.attempt} of ticket ${parts.buildId}. Grade that attempt ` +
      "against the ticket, judge the artifacts, and put the grade in your " +
      "outcome JSON. The engine owns every status write; you write none.",
    "",
    "---",
    "",
    parts.skill?.trim() ||
      "_(the pool has no verify skill: no verify.md beside AGENT.md, so " +
        "grade on the criteria below and say so in your reasons)_",
    "",
    "---",
    "",
    "The bound attempt's artifacts, in the order the skill reads them:",
    "",
    `1. The ticket file: ${parts.ticketPath}`,
    `2. The attempt's Outcome JSON: ${parts.outcomePath}`,
    `3. The diff at the attempt's commit: ${parts.diffPath}`,
    `4. The attempt log, trimmed to its last ~20k tokens when huge: ` +
      parts.logPath,
    "",
    "Trust terminal output over the agent's self-assessment.",
    "",
    "---",
    "",
    "When you finish, record your outcome as JSON at " +
      `${parts.graderOutcomePath}: {"status": "done", "summary": "what you ` +
      'graded, in a sentence or two", "commitSha": null, "grade": ' +
      '{"score": 0-10, "verdict": "pass" or "flag", "reasons": "one to ' +
      'three short sentences naming the evidence"}}. ' +
      "You write no status, raise no interrupts, and merge nothing: the " +
      "grade in this file is your only output.",
  ];
  return sections.join("\n");
}

interface HeadToHeadSideParts {
  attempt: number;
  outcomePath: string;
  diffPath: string;
  logPath: string;
  score: number;
  verdict: string;
  reasons: string;
}

interface HeadToHeadPromptParts {
  buildId: string;
  ticketPath: string;
  /** The pool's verify skill, or null when the pool has none. */
  skill: string | null;
  top: HeadToHeadSideParts;
  runnerUp: HeadToHeadSideParts;
  outcomePath: string;
}

// The head-to-head judge's prompt: the pool's verify skill as the criteria
// both sides are judged against, then each attempt's artifacts side by side
// with the grade it received, then the pick contract. The glue (paths, trust
// rule, pick shape) is engine-owned, so a pool whose skill drifted still
// picks to the contract.
export function buildHeadToHeadPrompt(parts: HeadToHeadPromptParts): string {
  const side = (label: string, s: HeadToHeadSideParts): string[] => [
    `${label}: attempt ${s.attempt}, graded ${s.score}/10 ` +
      `(${s.verdict}: ${s.reasons.trim()})`,
    "",
    `1. The attempt's Outcome JSON: ${s.outcomePath}`,
    `2. The diff at the attempt's commit: ${s.diffPath}`,
    `3. The attempt log, trimmed to its last ~20k tokens when huge: ` +
      s.logPath,
  ];
  const sections: string[] = [
    `You are the head-to-head judge. Two attempts of ticket ` +
      `${parts.buildId} finished with grades too close to call from ` +
      "separate graders: their scores sit within two points of each " +
      "other, and separate grading calls do not calibrate against each " +
      "other. Compare the two attempts side by side, pick the better one, " +
      "and put the pick in your outcome JSON. The engine owns every " +
      "status write; you write none.",
    "",
    "---",
    "",
    parts.skill?.trim() ||
      "_(the pool has no verify skill: no verify.md beside AGENT.md, so " +
        "judge both sides on the criteria below and say so in your " +
        "summary)_",
    "",
    "---",
    "",
    "Both attempts worked the same ticket:",
    "",
    `The ticket file: ${parts.ticketPath}`,
    "",
    "The first attempt's artifacts:",
    "",
    ...side("First", parts.top),
    "",
    "The second attempt's artifacts:",
    "",
    ...side("Second", parts.runnerUp),
    "",
    "Trust terminal output over the agents' self-assessments.",
    "",
    "---",
    "",
    "When you finish, record your outcome as JSON at " +
      `${parts.outcomePath}: {"status": "done", "summary": "why your pick ` +
      'wins, in a sentence or two", "commitSha": null, "winner": ' +
      "<attempt number>}. The winner is the number of the better attempt, " +
      `exactly one of ${parts.top.attempt} or ${parts.runnerUp.attempt}. ` +
      'If you genuinely cannot separate them, write "winner": "tie" ' +
      "instead; the engine then falls back to the higher score, then the " +
      "earlier attempt. You write no status, raise no interrupts, and " +
      "merge nothing: the pick in this file is your only output.",
  ];
  return sections.join("\n");
}

interface PromptParts {
  chain: string[];
  agentMd: string;
  roster: string;
  upstream: { id: string; outcome: Outcome }[];
  outcomePath: string;
}

// The prompt body: the standing instructions, chain, roster, upstream
// outcomes, and the outcome-writing instruction. The driver invocation line is
// no longer part of this string; each harness adapter assembles its own from
// the structured driver and issue-reference fields it receives.
export function buildPrompt(parts: PromptParts): string {
  const sections: string[] = [
    "Standing instructions for this job:",
    "",
    parts.agentMd.trim() || "_(no AGENT.md in the pool directory)_",
  ];
  if (parts.chain.length > 0) {
    sections.push(
      "",
      "---",
      "",
      "Chain for this Issue. When the driver skill's work is done, dispatch " +
        "these subagents in this order, one at a time, and act on what each " +
        `returns: ${parts.chain.join(", ")}.`,
    );
  }
  if (parts.roster.trim()) {
    sections.push(
      "",
      "---",
      "",
      "The subagent roster for this job. Dispatch them by name. Each harness " +
        "defines its own agents; on claude they come from the runner's " +
        "config, on opencode and cursor from your own setup:",
      "",
      parts.roster.trim(),
    );
  }
  if (parts.upstream.length > 0) {
    sections.push(
      "",
      "---",
      "",
      "Outcomes from the tickets this ticket was blocked by. Build on what " +
        "they did; do not rediscover it:",
      "",
      ...parts.upstream.map(
        ({ id, outcome }) =>
          `- ${id}: ${outcome.summary} (commit ${outcome.commitSha ?? "none"})`,
      ),
    );
  }
  sections.push(
    "",
    "---",
    "",
    "When you finish, record your outcome as JSON at " +
      `${parts.outcomePath}: {"status": "done" or "checkpoint", ` +
      '"summary": "what you did, in a sentence or two", "commitSha": "the ' +
      'sha of your commit, or null"}. On a checkpoint, add "brief": "what ' +
      'the human has to do next". The engine reads this file at your exit ' +
      "and writes the final status to the Issue itself. Never edit the " +
      "Issue's line-1 status marker; the engine owns that write.",
    "",
    "Follow-up work you discover mid-attempt is proposed, never written: " +
      'add an optional "spawn" array to that outcome JSON, one entry per ' +
      'follow-up, each shaped {"title": "...", "body": "...", "blockedBy": ' +
      '["id", ...]}, the body carrying at least 20 characters of intent ' +
      "for a fresh agent to work from, blockedBy optional and naming the " +
      "ids the follow-up must wait for. The engine assigns the ids " +
      "(<parent>-spawn-N: ticket 07's first proposal becomes 07-spawn-1), " +
      "writes the ticket files at the super-step boundary, and schedules " +
      "them like any other ticket. Thin or out-of-pool proposals are " +
      "dropped with the reason recorded in the ticket log, and a dropped " +
      "proposal never costs your attempt its result. Caps apply: 5 " +
      "proposals honored per attempt and 20 per run, " +
      "overflow truncated to the log. You never write pool state: no ticket " +
      "files, no ids, no statuses. You propose; the engine writes.",
  );
  return sections.join("\n");
}
