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
  );
  return sections.join("\n");
}
