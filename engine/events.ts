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
 * attempt.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EVENT_KINDS = [
  "scheduled",
  "spawned",
  "exited",
  "merged",
  "merge-conflict",
  "resolver",
  "checkpoint",
  "crash",
  "deadlock",
  "deadlock-cleared",
  "answered",
  "review-reject",
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

/** The attempt number for a ticket's next spawn: one past the highest attempt recorded. */
export function nextAttempt(runsDir: string, ticketId: string): number {
  return (
    readEvents(runsDir, ticketId).reduce(
      (max, event) => Math.max(max, event.attempt),
      0,
    ) + 1
  );
}

/** The ticket's latest recorded attempt, or 0 before anything has spawned. */
export function lastAttempt(runsDir: string, ticketId: string): number {
  return readEvents(runsDir, ticketId).reduce(
    (max, event) => Math.max(max, event.attempt),
    0,
  );
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
  return readEvents(runsDir, ticketId).reduce(
    (max, event) => (event.kind === kind ? Math.max(max, event.attempt) : max),
    0,
  );
}