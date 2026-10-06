/**
 * The ticket prompt every Attempt launches with, pinned byte for byte
 * (test-inventory.md, Decided 4): the text the TypeScript server hands an
 * agent today, copied here from its template so a server that rewords one
 * sentence fails the comparison rather than silently changing what agents
 * do. Only the parts a pool varies are parameters: AGENT.md, the chain of
 * skills after the driver, the upstream Outcomes, the paths, and the Spawn
 * caps.
 *
 * Each harness wraps it differently (the batch argv, the typed prompt);
 * `batchPromptArg` and `typedPrompt` give the wrapped forms.
 */

export interface TicketPromptParts {
  /** AGENT.md's content, or null when the pool has none. */
  agentMd: string | null;
  /** The pool's runs directory: the Outcome and the Spawn ledger live there. */
  runs: string;
  /** The Outcome file's stem: `01`, `01.attempt-2`, `01-spawn-1`. */
  outcome: string;
  /** The skills after the driver, in order. */
  chain?: string[];
  /** The Outcomes of the Tickets this one was blocked by, in marker order. */
  upstream?: { id: string; summary: string; commitSha: string | null }[];
  /** The pool's Spawn caps; absent, the defaults of 5 and 20. */
  perAttempt?: number;
  perRun?: number;
}

function capsSentence(perAttempt: number, perRun: number): string {
  if (perAttempt === 0 || perRun === 0) {
    return (
      `Caps apply: this pool's are ${perAttempt} per attempt and ${perRun} per run, and a cap of 0 means ` +
      "every proposal you make is held for the operator to adopt or discard, none lands on its own, so " +
      "propose only what the operator should weigh, most important first."
    );
  }
  return (
    `Caps apply: ${perAttempt} ${perAttempt === 1 ? "proposal" : "proposals"} honored per attempt and ` +
    `${perRun} per run, overflow held for the operator to adopt or discard, so order your proposals ` +
    "most important first."
  );
}

/** The prompt body, exactly as the server builds it. */
export function ticketPrompt(parts: TicketPromptParts): string {
  const outcomePath = `${parts.runs}/${parts.outcome}.outcome.json`;
  const ledgerPath = `${parts.runs}/spawn-ledger.md`;
  const lines: string[] = [
    "Standing instructions for this job:",
    "",
    parts.agentMd?.trim() || "_(no AGENT.md in the pool directory)_",
  ];
  if (parts.chain && parts.chain.length > 0) {
    lines.push(
      "",
      "---",
      "",
      `Skills for this Issue. When the driver skill's work is done, also use these skills, in this order: ${parts.chain.join(", ")}.`,
    );
  }
  if (parts.upstream && parts.upstream.length > 0) {
    lines.push(
      "",
      "---",
      "",
      "Outcomes from the tickets this ticket was blocked by. Build on what they did; do not rediscover it:",
      "",
      ...parts.upstream.map((up) => `- ${up.id}: ${up.summary} (commit ${up.commitSha ?? "none"})`),
    );
  }
  lines.push(
    "",
    "---",
    "",
    `When you finish, record your outcome as JSON at ${outcomePath}: {"status": "done" or "checkpoint", ` +
      `"summary": "what you did, in a sentence or two", "commitSha": "the sha of your commit, or null"}. ` +
      `On a checkpoint, add "brief": "what the human has to do next". The engine reads this file at your ` +
      "exit and writes the final status to the Issue itself. Never edit the Issue's line-1 status marker; " +
      "the engine owns that write.",
    "",
    "Follow-up work you discover mid-attempt is proposed, never written: add an optional \"spawn\" array " +
      'to that outcome JSON, one entry per follow-up, each shaped {"title": "...", "body": "...", ' +
      '"blockedBy": ["id", ...]}, the body carrying at least 20 characters of intent for a fresh agent ' +
      "to work from, blockedBy optional and naming the ids the follow-up must wait for. An entry may add " +
      '"assign": {"harness": "...", "model": "...", "effort": "...", "drivers": "..."} with only the ' +
      "fields the follow-up needs different; when absent it inherits your own Assignment. \"assign\" " +
      "takes harness, model, effort and drivers only; a verify in it is ignored, since grading is the " +
      'operator\'s call. A follow-up that must run before other work may add "blocks": ["id", ...] to ' +
      'make those tickets wait for it, or "blocks": "all" to make every ticket that has not started yet ' +
      "wait for it; a ticket already running is never interrupted, and blocks is only for a ticket. The " +
      "engine assigns the ids (<parent>-spawn-N: ticket 07's first proposal becomes 07-spawn-1), writes " +
      "the ticket files at the super-step boundary, and schedules them like any other ticket. Thin or " +
      "out-of-pool proposals are dropped with the reason recorded in the ticket log, and a dropped " +
      `proposal never costs your attempt its result. ${capsSentence(parts.perAttempt ?? 5, parts.perRun ?? 20)} ` +
      "You never write pool state: no ticket files, no ids, no statuses. You propose; the engine writes.",
    "",
    `Before you propose anything, read the Spawn ledger at ${ledgerPath}: every Ticket and Conversation ` +
      "in the pool, and every proposal still waiting to land or held for the operator. Do not propose " +
      'work it already lists. If a proposal still overlaps something there, add "overlaps": ["id", ...] ' +
      "naming what it overlaps: it is then held for the operator to decide instead of landing.",
  );
  return lines.join("\n");
}

/** The harnesses a pool's defaults know, by Assignment name. */
export type HarnessName = "claude" | "opencode" | "cursor";

/**
 * The argv element a headless launch carries the prompt in: the driver
 * invocation, a blank line and the body for claude and cursor; the Ticket
 * file path, a blank line and the body for opencode, whose driver rides
 * `--command` instead.
 */
export function batchPromptArg(harness: HarnessName, driver: string, issue: string, body: string): string {
  return harness === "opencode" ? `${issue}\n\n${body}` : `/${driver} ${issue}\n\n${body}`;
}

/**
 * The text a terminal-backed launch types into the TUI, the same for every
 * harness: the driver invocation, a blank line, the body, then the Ticket
 * file path alone on the last line.
 */
export function typedPrompt(driver: string, issue: string, body: string): string {
  return `/${driver} ${issue}\n\n${body}\n${issue}`;
}
