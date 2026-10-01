import { SPAWN_BODY_MIN_CHARS, type Outcome } from "./engine.ts";
import type { SpawnCaps } from "./spawn-caps.ts";

// The Spawn ledger (issue #150, spawn-ledger.ts): the path, never the
// contents, so the prompt stays short (issue #84) and the agent reads the
// pool as it is when it proposes, not as it was at launch.
function spawnLedgerTeaching(ledgerPath: string): string {
  return (
    `Before you propose anything, read the Spawn ledger at ${ledgerPath}: ` +
    "every Ticket and Conversation in the pool, and every proposal still " +
    "waiting to land or held for the operator. Do not propose work it " +
    "already lists. If a proposal still overlaps something there, add " +
    '"overlaps": ["id", ...] naming what it overlaps: it is then held for ' +
    "the operator to decide instead of landing."
  );
}

// The `blocks` teaching (ADR-0029), one sentence shared by the attempt
// prompt and the Conversation teaching so the two cannot drift: what a
// follow-up that must run first adds to its entry.
const SPAWN_BLOCKS_TEACHING =
  'A follow-up that must run before other work may add "blocks": ["id", ' +
  '...] to make those tickets wait for it, or "blocks": "all" to make ' +
  "every ticket that has not started yet wait for it; a ticket already " +
  "running is never interrupted, and blocks is only for a ticket.";

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

/**
 * The teaching Turn an enlisted pane starts with (issue #101): the protocol
 * the agent was never launched with. It names the Ticket id, the file of
 * record to read and annotate, the branch to commit on, and the Outcome
 * contract (done or checkpoint with a Brief, an optional Spawn array), so an
 * enlisted ticket can end the ordinary way rather than only by the tab
 * closing. The engine types it into the pane, never writes it to a file.
 */
export function buildEnlistTeaching(parts: {
  id: string;
  issuePath: string;
  outcomePath: string;
  branch: string;
  ledgerPath: string;
}): string {
  return [
    "---",
    "",
    `You have been enlisted into the pool as Ticket ${parts.id}. This ` +
      "terminal is now the attempt for that ticket; nothing about your " +
      "checkout has moved.",
    "",
    `Your Ticket file of record is ${parts.issuePath}: read it for the spec ` +
      "and append your notes there. The engine owns its line-1 status " +
      "marker; never edit it.",
    "",
    `Commit your work on the branch already checked out here ` +
      `(${parts.branch}). Leave the branch and the directory as they are: ` +
      "the engine never removes the directory or deletes the branch.",
    "",
    "When the work is done, record your outcome as JSON at " +
      `${parts.outcomePath}: {"status": "done" or "checkpoint", ` +
      '"summary": "what you did, in a sentence or two", "commitSha": "the ' +
      'sha of your commit, or null"}. On a checkpoint, add "brief": "what ' +
      'the human has to do next".',
    "",
    "You may propose follow-up tickets in that same outcome JSON by adding " +
      'a "spawn" array, one entry per follow-up, each shaped {"title": ' +
      '"...", "body": "...", "blockedBy": ["id", ...]}, the body carrying ' +
      `at least ${SPAWN_BODY_MIN_CHARS} characters of intent for a fresh ` +
      "agent to work from. " +
      SPAWN_BLOCKS_TEACHING +
      " The engine assigns the ids, writes the ticket " +
      "files and schedules them. You never write pool state yourself: no " +
      "ticket files, no ids, no statuses. You propose; the engine writes.",
    "",
    spawnLedgerTeaching(parts.ledgerPath),
  ].join("\n");
}

/**
 * The teaching Turn a Continued attempt starts with (issue #139): the agent
 * already wrote the checkpoint Outcome its prompt asked for and believes its
 * part is over, so it is told the operator chose to carry on here and that a
 * fresh Outcome is owed when the two of them decide. It restates the whole
 * Outcome contract rather than pointing back at the original prompt: the path
 * may be a new one (an attempt-numbered file on a verify ticket), and a
 * context the harness compacted may no longer hold the old wording. The
 * engine types it into the pane, never writes it to a file.
 */
export function buildContinuedTeaching(parts: {
  id: string;
  issuePath: string;
  outcomePath: string;
  attempt: number;
  ledgerPath: string;
  /** Who chose to keep talking: the pool's Steward stands in for the operator (ADR-0030). */
  by?: "operator" | "steward";
}): string {
  const who = parts.by === "steward" ? "The pool's Steward, standing in for the operator," : "The operator";
  return [
    "---",
    "",
    `${who} chose to keep talking with you here about Ticket ${parts.id}, ` +
      "instead of starting a fresh attempt. You are now its attempt " +
      `${parts.attempt}: carry on from where you checkpointed, with the ` +
      `${parts.by === "steward" ? "Steward" : "operator"}, in this same terminal and checkout.`,
    "",
    `The Ticket file of record is ${parts.issuePath}; its line-1 status ` +
      "marker is the engine's, never edit it.",
    "",
    "The Outcome you wrote before is spent. When you and the operator decide " +
      "the work is done, or that it has to pause again, record a fresh " +
      `outcome as JSON at ${parts.outcomePath}: {"status": "done" or ` +
      '"checkpoint", "summary": "what you did, in a sentence or two", ' +
      '"commitSha": "the sha of your commit, or null"}. On a checkpoint, add ' +
      '"brief": "what the human has to do next". Write it only once it is ' +
      "decided: the engine reads the file the moment it appears.",
    "",
    "You may propose follow-up tickets in that same outcome JSON by adding " +
      'a "spawn" array, one entry per follow-up, each shaped {"title": ' +
      '"...", "body": "...", "blockedBy": ["id", ...]}, the body carrying ' +
      `at least ${SPAWN_BODY_MIN_CHARS} characters of intent for a fresh ` +
      "agent to work from. " +
      SPAWN_BLOCKS_TEACHING +
      " You never write pool state yourself: no ticket " +
      "files, no ids, no statuses. You propose; the engine writes.",
    "",
    spawnLedgerTeaching(parts.ledgerPath),
  ].join("\n");
}

/**
 * The teaching conversations.ts appends to a Conversation's opening Turn (or
 * types alone when there is none, so the mechanism is learned either way):
 * how to propose Spawns mid-conversation (the Conversations ADR). A
 * Conversation has no driver, no chain, no roster and no Outcome file the
 * ordinary buildPrompt assembles around, so this is deliberately
 * self-contained rather than a section spliced into that prompt. The floor
 * on a proposal's body (SPAWN_BODY_MIN_CHARS, engine.ts) is named literally
 * here so the two surfaces cannot drift, and the per-file cap is the pool's
 * own per-attempt Spawn cap (ADR-0029) as the caller read it at start;
 * prompt.test.ts pins both the way it already does for buildPrompt.
 */
export interface TeachingAssignment {
  harness: string;
  model: string;
  effort?: string;
  drivers: string;
}

// What the teaching says a field is: an enlisted pane names no model, and
// the pool may name no defaults at all, so the empty case is spelled out
// rather than left as a blank the agent would read past.
function describeAssignment(a: Partial<TeachingAssignment> | undefined): string {
  const field = (value: string | undefined) => (value ? value : "(none)");
  // Effort is optional (the harness's own default when unset), so it is
  // named only when set rather than as a gap the agent might try to fill.
  const effort = a?.effort ? `, effort ${a.effort}` : "";
  return `harness ${field(a?.harness)}, model ${field(a?.model)}${effort}, drivers ${field(a?.drivers)}`;
}

export function buildConversationTeaching(
  spawnPath: string,
  own: TeachingAssignment,
  defaults: Partial<TeachingAssignment> | undefined,
  perFile: number,
  ledgerPath: string,
): string {
  return [
    "---",
    "",
    "Load the my-console-citizen skill: it is how to work inside this pool.",
    "",
    ...conversationProtocol(spawnPath, own, defaults, perFile, ledgerPath, false),
  ].join("\n");
}

// The Conversation protocol both teachings share: how to Spawn, what the
// Assignment and caps are, what reports back. A Steward's differs in one
// sentence, since the Interrupts of what it spawns are its to answer.
function conversationProtocol(
  spawnPath: string,
  own: TeachingAssignment,
  defaults: Partial<TeachingAssignment> | undefined,
  perFile: number,
  ledgerPath: string,
  steward: boolean,
): string[] {
  return [
    "You can start follow-up work without leaving this conversation. Write " +
      `JSON to ${spawnPath}: {"spawn": [...]}, one entry per follow-up, each ` +
      'shaped {"title": "...", "body": "...", "blockedBy": ["id", ...], ' +
      '"kind": "ticket" or "conversation", "assign": {"harness": "...", ' +
      '"model": "...", "effort": "...", "drivers": "..."}}.',
    "",
    `The body needs at least ${SPAWN_BODY_MIN_CHARS} characters of intent for a fresh agent to ` +
      'work from. "blockedBy" is optional and may only name Tickets, never ' +
      'another Conversation (an entry naming one is dropped and logged). ' +
      '"kind" defaults to "ticket"; "conversation" starts a new open-ended ' +
      'talk instead of a Ticket. "assign" is optional; when absent the ' +
      "follow-up inherits this Conversation's own Assignment, and any field " +
      "that leaves empty falls through to the pool defaults. " +
      SPAWN_BLOCKS_TEACHING,
    "",
    `This Conversation's Assignment: ${describeAssignment(own)}. ` +
      `The pool defaults: ${describeAssignment(defaults)}. Set "assign" only ` +
      "for a field the follow-up needs different; when no model would " +
      "resolve, ask the operator here before you write the file.",
    "",
    "The engine polls for this file, reads it, and deletes it once read: " +
      "write it whenever you like, mid-conversation, not only once. Caps: " +
      (perFile === 0
        ? "0 entries honored per file written: the pool's cap is 0, so every " +
          "entry is held for the operator to adopt or discard and none " +
          "starts on its own; "
        : `${perFile} ${perFile === 1 ? "entry" : "entries"} honored per file written, ` +
          "and entries beyond it are held for the operator to adopt or discard; ") +
      "unlike a Ticket's own spawns there is no run-wide cap on what a " +
      "Conversation spawns.",
    "",
    spawnLedgerTeaching(ledgerPath),
    "",
    "A spawned Ticket reports back here as a Turn typed into this " +
      "conversation once it ends (done, or checkpoint with its Brief) and " +
      "you are next idle: its id, title, outcome, branch, and a diff " +
      "summary. A spawned Conversation reports back the same way once the " +
      "operator ends it: its branch and the operator's closing note, if " +
      (steward
        ? "any. Both only inform; a spawned Ticket's Interrupt reaches you " +
          "as a Steward Notice like any other Ticket's."
        : "any. Both inform only; you cannot answer either one's own Interrupt."),
    "",
    "You never write pool state yourself: no ticket files, no ids, no " +
      "statuses, no status markers. You propose; the engine writes.",
  ];
}

/**
 * The teaching a Steward starts with (ADR-0030), appended to the operator's
 * standing orders when it is started and typed as an enlist's teaching Turn
 * when it is Enlisted: the Steward's role, the command it answers with (its
 * exact invocation, `command`), its budget, what it may never answer or do,
 * how to leave an Interrupt and how to end itself, then the Conversation
 * protocol every Conversation is taught. The budget is the one in force at
 * start; the `state` verb reads it live.
 */
export function buildStewardTeaching(parts: {
  spawnPath: string;
  own: TeachingAssignment;
  defaults: Partial<TeachingAssignment> | undefined;
  perFile: number;
  ledgerPath: string;
  command: string;
  budget: number;
}): string {
  return [
    "---",
    "",
    "You are this pool's Steward: you keep its Tickets moving while the " +
      "operator is away, under the orders above. Load the my-console-steward " +
      "skill now: it is how to judge each Interrupt. It builds on the " +
      "my-console-citizen skill, which is how to work inside this pool.",
    "",
    "You do not poll. Whenever you are waiting, the engine types a Turn here " +
      "naming every pending Ticket Interrupt you may answer and have not " +
      "left, and a Merge queue head that has stalled. Items that arrive " +
      "together come as one Turn. The same Turn also tells you, with " +
      "nothing to answer, which Tickets merged since your last Notice and " +
      "when every Ticket is done and Review waits for the operator: that is " +
      "how you know when orders like \"watch the next super-step, then " +
      'finish" are done, and can end yourself.',
    "",
    "Act with this command, run in your shell:",
    "",
    `    ${parts.command} <verb> ...`,
    "",
    "- answer <ticket> resume|approve|reject [note]: the operator's own " +
      "answer path. resume starts a fresh Attempt with your note in the " +
      "Ticket file; approve or reject answer a merge-approval; a selection " +
      "is answered with resume and the attempt number to merge.",
    "- keep-talking <ticket> <message>: continue a checkpointed Attempt in " +
      "its still-live pane; the engine types your message there after its " +
      "own teaching Turn.",
    "- leave <ticket> <note>: leave the Interrupt to the operator. Your note " +
      "is your recommendation, shown to them beside it. You are not told " +
      "about that Interrupt again until it changes.",
    "- held adopt|discard <proposal-id>: decide a Held spawn.",
    "- reassign <ticket> field=value...: change a Ticket's Assignment " +
      "(harness, model, effort, drivers, verify; field= clears one). The engine " +
      "picks it up at the next boundary, so resume the Ticket after.",
    "- state: the pending Interrupts, the Merge queue, the Pending and Held " +
      "spawns, and your budget left per Ticket.",
    "- end [closing line]: end yourself.",
    "",
    'A note or message given as "-" is read from standard input.',
    "",
    `Your Steward budget is ${parts.budget} ${parts.budget === 1 ? "answer" : "answers"} ` +
      "per Ticket since the operator last answered it. Answers and Keep " +
      "talks count; leaves, adopts, discards and reassigns do not. The " +
      "engine refuses an answer beyond it: leave that Ticket with a note.",
    "",
    "Never answer a review or a persistence Interrupt: review is the " +
      "operator's final judgement, and persistence is an engine store " +
      "failure. The engine refuses both. A Conversation's waits are not " +
      "yours either: you steward Tickets.",
    "",
    "Decide and talk, never do the work: make no edits in any Ticket's " +
      "worktree or in the pool checkout. Your only ways to change the code " +
      "are an answer, a coaching message and a Spawn.",
    "",
    "You may push, open pull requests or merge pull requests only if the " +
      "operator's own words in this pane allow it. Nothing else grants it.",
    "",
    "When you cannot decide an Interrupt sensibly, or it is a product " +
      "decision or anything destructive or irreversible, leave it with a " +
      "note that recommends an answer and says why.",
    "",
    "When your orders are done, run end with a closing line: what you " +
      "decided, and what waits for the operator.",
    "",
    "---",
    "",
    ...conversationProtocol(
      parts.spawnPath,
      parts.own,
      parts.defaults,
      parts.perFile,
      parts.ledgerPath,
      true,
    ),
  ].join("\n");
}

interface PromptParts {
  chain: string[];
  agentMd: string;
  roster: string;
  upstream: { id: string; outcome: Outcome }[];
  outcomePath: string;
  // The pool's Spawn caps as this attempt's boundary left them (ADR-0029).
  spawnCaps: SpawnCaps;
  // The pool's Spawn ledger (issue #150): read before proposing.
  ledgerPath: string;
}

// What the caps mean for this attempt's proposals: how many are taken, or,
// with a cap of 0 (issue #150), that every one is held for the operator.
function spawnCapsTeaching({ perAttempt, perRun }: SpawnCaps): string {
  if (perAttempt === 0 || perRun === 0) {
    return (
      `Caps apply: this pool's are ${perAttempt} per attempt and ${perRun} per ` +
      "run, and a cap of 0 means every proposal you make is held for the " +
      "operator to adopt or discard, none lands on its own, so propose only " +
      "what the operator should weigh, most important first."
    );
  }
  return (
    `Caps apply: ${perAttempt} ` +
    `${perAttempt === 1 ? "proposal" : "proposals"} honored ` +
    `per attempt and ${perRun} per run, ` +
    "overflow held for the operator to adopt or discard, so order your " +
    "proposals most important first."
  );
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
      "ids the follow-up must wait for. " +
      SPAWN_BLOCKS_TEACHING +
      " The engine assigns the ids " +
      "(<parent>-spawn-N: ticket 07's first proposal becomes 07-spawn-1), " +
      "writes the ticket files at the super-step boundary, and schedules " +
      "them like any other ticket. Thin or out-of-pool proposals are " +
      "dropped with the reason recorded in the ticket log, and a dropped " +
      "proposal never costs your attempt its result. " +
      spawnCapsTeaching(parts.spawnCaps) +
      " You never write pool state: no ticket " +
      "files, no ids, no statuses. You propose; the engine writes.",
    "",
    spawnLedgerTeaching(parts.ledgerPath),
  );
  return sections.join("\n");
}
