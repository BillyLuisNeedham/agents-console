/**
 * Ticket events: the engine's per-ticket lifecycle record, one JSON line per
 * event appended to `runs/<id>.events.jsonl` at each lifecycle point the
 * engine already passes through (ADR 0002). Append-only and small; it is never
 * folded into the SSE snapshot. The timeline in the ticket's Detail is built
 * from these events, and tickets with no events file (pre-feature pools) are
 * backfilled from their log files at read time.
 *
 * Attempt numbers are per ticket and shared by implement and resolver runs:
 * every spawn of a harness for a ticket increments that ticket's attempt
 * counter, so a resolver run after a conflicted implement attempt is the next
 * attempt. A verify attempt's grade is recorded on the build ticket's file
 * (the graded attempt's number), appended by the engine when the attempt's
 * grader ticket finishes. The selection's winner is recorded the same way,
 * as a selected event on the build ticket's file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EVENT_KINDS = [
  "scheduled",
  "spawned",
  // A terminal-backed launch whose wrapper never ran (issue #102's Botched
  // launch): the tab it was typed into, closed, and the reason; the launch
  // went on into a fresh tab, and only the tab it ended up in is `spawned`.
  "launch-retried",
  "exited",
  "merged",
  "merge-conflict",
  // A merge git refused before starting (#92): untracked files in the pool
  // checkout that differ from the branch's version stood in its way.
  // Nothing conflicted and no resolver runs; the operator clears the way.
  "merge-blocked",
  "resolver",
  "graded",
  "selected",
  "grader-respawn",
  "checkpoint",
  "crash",
  "deadlock",
  "deadlock-cleared",
  "answered",
  "review-reject",
  "spawn-adopted",
  "spawn-rejected",
  "reassigned",
  // The ticket file's two copies (the pool's file of record and the
  // worktree seed the agent committed) changed the same lines differently,
  // so the reconcile at merge left conflict markers in the file of record.
  "ticket-file-conflict",
  // Conversations (the Conversations ADR, docs/adr/0018-conversations-
  // beside-tickets.md): "ended" is an operator-ended Conversation's closing
  // record (merged, ended with no commits, or ended with its branch parked
  // on a rejected merge-approval); "notice" is a Turn the engine typed into
  // a waiting parent Conversation reporting something it spawned finishing;
  // "notice-dropped" is a Notice that never delivered (the parent ended or
  // crashed first, or the queue was still non-empty at End) and is logged on
  // the child's own file instead.
  "ended",
  "notice",
  "notice-dropped",
  // The ticket's solo branch is checked out in a directory the engine does
  // not own (issue #101: the checkout an enlist moved onto its created pool
  // branch), so no worktree could be opened and the ticket waits as a
  // checkpoint until the branch is free.
  "branch-held",
  // The ticket was about to schedule with no harness or model (issue #118:
  // a spawn off an enlisted Conversation, or a pool with no defaults), so
  // it waits as a config interrupt instead of a launch that would throw.
  "unassigned",
  // A tab the engine closed by rule (a merge, a role's end, a Conversation's
  // end, a Resume's fresh launch, the operator's bulk close) that herdr
  // refused to close (issue #139): the close stays best-effort, and this is
  // the record that it failed and why, where a silent catch used to be.
  "tab-close-failed",
] as const;

export type TicketEventKind = (typeof EVENT_KINDS)[number];

export interface TicketEvent {
  at: string;
  attempt: number;
  kind: TicketEventKind;
  payload: Record<string, unknown>;
}

/**
 * One ticket log file name, covering every raw-log variant ADR 0002 names:
 * the well-known paths for the current attempt (`<id>.log`,
 * `<id>.resolver.log`) and the rotated attempt-numbered names
 * (`<id>.attempt-N.log`, `<id>.attempt-N.resolver.log`). `attempt` is null
 * for the well-known paths. The events module owns the naming contract, and
 * the engine rotator plus both server readers call this so the on-disk names
 * cannot drift apart.
 */
export function attemptLogName(
  ticketId: string,
  attempt: number | null,
  resolver: boolean,
): string {
  const numbered = attempt === null ? "" : `.attempt-${attempt}`;
  const suffix = resolver ? ".resolver" : "";
  return `${ticketId}${numbered}${suffix}.log`;
}

/** The free variables one `attemptLogName` call needed to produce a name. */
export interface AttemptLogName {
  attempt: number | null;
  resolver: boolean;
}

/**
 * One attempt Stream file name, the naming contract extended to the raw
 * stream tee (ADR-0012): the well-known paths for the current attempt
 * (`<id>.stream.jsonl`, `<id>.resolver.stream.jsonl`) and the rotated
 * attempt-numbered names (`<id>.attempt-N.stream.jsonl`,
 * `<id>.attempt-N.resolver.stream.jsonl`). Same free variables and rotation
 * rules as `attemptLogName`, so a re-run rotates both files the same way.
 */
export function attemptStreamName(
  ticketId: string,
  attempt: number | null,
  resolver: boolean,
): string {
  const numbered = attempt === null ? "" : `.attempt-${attempt}`;
  const suffix = resolver ? ".resolver" : "";
  return `${ticketId}${numbered}${suffix}.stream.jsonl`;
}

/**
 * One attempt exit-code file name (ADR-0014): the wrapper shell the engine
 * sends to a terminal-backed attempt's pane writes the harness's exit code
 * here, because herdr's API exposes no exit codes. Same naming contract and
 * free variables as `attemptLogName`, so the exit-code file sits beside the
 * attempt's log and Stream file under the same name.
 */
export function attemptExitCodeName(
  ticketId: string,
  attempt: number | null,
  resolver: boolean,
): string {
  const numbered = attempt === null ? "" : `.attempt-${attempt}`;
  const suffix = resolver ? ".resolver" : "";
  return `${ticketId}${numbered}${suffix}.exitcode`;
}

/**
 * One attempt result file name, the naming contract extended to the Outcome
 * (ADR-0005's ending signal): the well-known paths for the current attempt
 * (`<id>.outcome.json`, `<id>.resolver.outcome.json`) and the
 * attempt-numbered names a verify fan-out writes directly
 * (`<id>.attempt-N.outcome.json`), so N parallel outcomes never collide and
 * each grader binds to one attempt's file. Same free variables as
 * `attemptLogName`, so the resolver's result sits beside its log, Stream and
 * exit-code files under the same name rather than a hand-built one.
 */
export function attemptOutcomeName(
  ticketId: string,
  attempt: number | null,
  resolver: boolean,
): string {
  const numbered = attempt === null ? "" : `.attempt-${attempt}`;
  const suffix = resolver ? ".resolver" : "";
  return `${ticketId}${numbered}${suffix}.outcome.json`;
}

/**
 * The seed file name: the Ticket file as the pool held it when an attempt's
 * worktree was planned, kept under runs/ so the merge can reconcile the
 * worktree's committed copy against the file of record with an exact base
 * (`<id>.seed.md`, or `<id>.attempt-N.seed.md` for a verify attempt's own
 * worktree). Overwritten each time the same worktree is re-seeded.
 */
export function ticketSeedName(ticketId: string, attempt: number | null): string {
  const numbered = attempt === null ? "" : `.attempt-${attempt}`;
  return `${ticketId}${numbered}.seed.md`;
}

/**
 * Match a file name against a ticket's Stream file naming contract, the four
 * shapes `attemptStreamName` produces. Round-trip through the naming function
 * keeps it the single authority, exactly as for `parseAttemptLogName`.
 */
export function parseAttemptStreamName(
  ticketId: string,
  fileName: string,
): AttemptLogName | null {
  if (!fileName.startsWith(ticketId)) return null;
  let rest = fileName.slice(ticketId.length);
  let attempt: number | null = null;
  if (rest.startsWith(".attempt-")) {
    const digits = /^\d+/.exec(rest.slice(".attempt-".length));
    if (!digits) return null;
    attempt = Number(digits[0]);
    rest = rest.slice(".attempt-".length + digits[0].length);
  }
  let resolver = false;
  if (rest.startsWith(".resolver")) {
    resolver = true;
    rest = rest.slice(".resolver".length);
  }
  if (rest !== ".stream.jsonl") return null;
  if (attemptStreamName(ticketId, attempt, resolver) !== fileName) return null;
  return { attempt, resolver };
}

/**
 * Match a file name against a ticket's log naming contract: the four shapes
 * `attemptLogName` produces. Returns the free variables, or null when the
 * name is not one of this ticket's logs. A round-trip through the naming
 * function keeps it the single authority, so a name it could not write is not
 * matched. Used by the server's attempt reconstruction over old pools.
 */
export function parseAttemptLogName(
  ticketId: string,
  fileName: string,
): AttemptLogName | null {
  if (!fileName.startsWith(ticketId)) return null;
  let rest = fileName.slice(ticketId.length);
  let attempt: number | null = null;
  if (rest.startsWith(".attempt-")) {
    const digits = /^\d+/.exec(rest.slice(".attempt-".length));
    if (!digits) return null;
    attempt = Number(digits[0]);
    rest = rest.slice(".attempt-".length + digits[0].length);
  }
  let resolver = false;
  if (rest.startsWith(".resolver")) {
    resolver = true;
    rest = rest.slice(".resolver".length);
  }
  if (rest !== ".log") return null;
  if (attemptLogName(ticketId, attempt, resolver) !== fileName) return null;
  return { attempt, resolver };
}

function eventsFile(runsDir: string, ticketId: string): string {
  return join(runsDir, `${ticketId}.events.jsonl`);
}

export function appendEvent(
  runsDir: string,
  ticketId: string,
  event: TicketEvent,
): void {
  mkdirSync(runsDir, { recursive: true });
  appendFileSync(eventsFile(runsDir, ticketId), `${JSON.stringify(event)}\n`);
}

/**
 * Parse the append-only events file. The file is only ever appended to, but a
 * crash could tear a line, so a malformed or partial line is skipped and the
 * rest of the timeline stays readable. A line whose kind is not in the
 * module's known kind list is skipped the same way, so the reader validates
 * against the one list that also drives the kind type.
 */
export function readEvents(runsDir: string, ticketId: string): TicketEvent[] {
  const path = eventsFile(runsDir, ticketId);
  if (!existsSync(path)) return [];
  const events: TicketEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as TicketEvent;
      if (
        typeof parsed?.kind !== "string" ||
        typeof parsed.attempt !== "number" ||
        !(EVENT_KINDS as readonly string[]).includes(parsed.kind)
      ) {
        continue;
      }
      events.push(parsed);
    } catch {
      // torn line: skip it
    }
  }
  return events;
}

/** The highest recorded attempt, optionally only across events of one kind. */
function maxAttempt(
  events: TicketEvent[],
  kind?: TicketEventKind,
): number {
  return events.reduce(
    (max, event) =>
      kind === undefined || event.kind === kind
        ? Math.max(max, event.attempt)
        : max,
    0,
  );
}

/** The attempt number for a ticket's next spawn: one past the highest attempt recorded. */
export function nextAttempt(runsDir: string, ticketId: string): number {
  return maxAttempt(readEvents(runsDir, ticketId)) + 1;
}

/** The ticket's latest recorded attempt, or 0 before anything has spawned. */
export function lastAttempt(runsDir: string, ticketId: string): number {
  return maxAttempt(readEvents(runsDir, ticketId));
}

/**
 * The ticket's latest attempt carrying the given event kind, or 0 if none.
 * Used by attempt rotation to name a well-known raw log by the run that wrote
 * it: the last implement spawn for `<id>.log`, the last resolver run for
 * `<id>.resolver.log`.
 */
export function lastAttemptOfKind(
  runsDir: string,
  ticketId: string,
  kind: TicketEventKind,
): number {
  return maxAttempt(readEvents(runsDir, ticketId), kind);
}