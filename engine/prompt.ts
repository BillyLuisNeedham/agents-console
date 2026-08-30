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

interface PromptParts {
  chain: string[];
  agentMd: string;
  roster: string;
  upstream: { id: string; outcome: Outcome }[];
  outcomePath: string;
  issuePath: string;
}

// The prompt body: the standing instructions (the pool's AGENT.md plus the
// Issue-file location rule), chain, roster, upstream outcomes, and the
// outcome-writing instruction. The driver invocation line is no longer part
// of this string; each harness adapter assembles its own from the structured
// driver and issue-reference fields it receives.
export function buildPrompt(parts: PromptParts): string {
  const sections: string[] = [
    "Standing instructions for this job:",
    "",
    parts.agentMd.trim() || "_(no AGENT.md in the pool directory)_",
    "",
    "---",
    "",
    `The Issue file for this ticket lives outside this job's working ` +
      `directory, at the absolute path ${parts.issuePath}. Every status edit ` +
      "must target that exact absolute path. Never edit it by a repo-relative " +
      "path, and never edit any copy of it that may exist inside the working " +
      "directory: that copy is context only.",
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
      `${parts.outcomePath}: {"summary": "what you did, in a sentence or ` +
      'two", "commitSha": "the sha of your commit, or null"}.',
  );
  return sections.join("\n");
}
