/**
 * Assignment (CONTEXT.md: Assignment; ADR-0013): the harness, model and
 * drivers a unit of work runs on, plus the verify count a Ticket may carry.
 * One resolver serves every caller: an ordinary Ticket, a spawned Ticket, an
 * engine-run judge (grader, head-to-head) and a Conversation each supply
 * their own layers and the resolver applies them field-wise in one order,
 * request first, then what the unit inherits from its parent or build
 * ticket, then the pool defaults. A named harness must be in the harness
 * table; whether an empty harness or model is an error is the caller's
 * call (a Ticket renders as unassigned, a Conversation refuses to start).
 * Kept free of engine.ts so the rules are trivial to table-test.
 */

import type { HarnessCommand } from "./spawn.ts";

export interface Assignment {
  harness: string;
  model: string;
  drivers: string;
  verify?: number;
}

/**
 * One resolved Assignment on the wire (ADR-0013): the engine's record with
 * no verify (Verify keeps its own surfaces) and the engine's empty string
 * rendered as null for an unassigned field. The UI renders this record
 * verbatim; nothing re-derives it.
 */
export interface AssignmentView {
  harness: string | null;
  model: string | null;
  drivers: string;
}

// The record an unassigned ticket resolves to (ADR-0013): what
// assignmentViewOf returns for a ticket with no assign entry and no pool
// defaults. The server's mid-flight fallback for a meta id the engine has
// not resolved yet quotes this record instead of restating it.
export const UNASSIGNED_ASSIGNMENT_VIEW: AssignmentView = {
  harness: null,
  model: null,
  drivers: "implement",
};

export const DEFAULT_DRIVERS = "implement";

// The wire view of a resolved Assignment: the empty string the engine uses
// for an unassigned field reads as null, and verify stays off the wire.
export function assignmentViewOf(assignment: {
  harness: string;
  model: string;
  drivers: string;
}): AssignmentView {
  return {
    harness: assignment.harness || null,
    model: assignment.model || null,
    drivers: assignment.drivers,
  };
}

/** The fields a request may set: a console.json assign entry, a spawn proposal's assign, a Conversation start's assign. */
export interface AssignmentRequest {
  harness?: string;
  model?: string;
  drivers?: string;
  // Read as written in console.json, so a malformed value is reported
  // rather than silently coerced.
  verify?: unknown;
}

export interface ResolveAssignmentParams {
  // The prefix every error names the subject by: "pool config: ticket 01"
  // for a Ticket, "conversation start:" for a Conversation.
  subject: string;
  request: AssignmentRequest | undefined;
  // What the unit inherits when the request is silent: the parent Ticket
  // or Conversation of a spawned unit, the build ticket of a judge.
  inherited?: Pick<Assignment, "harness" | "model" | "drivers">;
  // The pool defaults, applied last. Absent for a spawned Ticket and a
  // judge, whose parent stands in for the defaults.
  defaults?: { harness?: string; model?: string; drivers?: string };
  // Strict resolution refuses an empty harness or model; lenient resolution
  // returns them empty so the misconfiguration renders instead of failing
  // pool load (the spawn site reports it when the unit actually runs).
  strict: boolean;
  // Whether request.verify is honoured. A judge is never itself verified,
  // and a Conversation is never verified at all.
  verify: boolean;
  harnesses: Record<string, HarnessCommand>;
}

export function resolveAssignment(params: ResolveAssignmentParams): Assignment {
  const { subject, inherited, defaults, harnesses } = params;
  const request = params.request ?? {};
  const harness = request.harness ?? inherited?.harness ?? defaults?.harness ?? "";
  const model = request.model ?? inherited?.model ?? defaults?.model ?? "";
  const drivers =
    request.drivers ?? inherited?.drivers ?? defaults?.drivers ?? DEFAULT_DRIVERS;
  if (params.strict && !harness) {
    throw new Error(
      `${subject} no harness resolved (set assign.harness, inherit ` +
        "from the parent Conversation, or console.json defaults.harness)",
    );
  }
  if (harness && !harnesses[harness]) {
    throw new Error(
      `${subject} names unknown harness '${harness}'. Known: ` +
        `${Object.keys(harnesses).sort().join(", ")}`,
    );
  }
  if (params.strict && !model) {
    throw new Error(
      `${subject} no model resolved (set assign.model, inherit ` +
        "from the parent Conversation, or console.json defaults.model)",
    );
  }
  let verify: number | undefined;
  if (params.verify && request.verify != null) {
    if (!Number.isInteger(request.verify) || (request.verify as number) < 1) {
      throw new Error(
        `${subject} has invalid verify ` +
          `${JSON.stringify(request.verify)} (must be an integer >= 1)`,
      );
    }
    verify = request.verify as number;
  }
  return { harness, model, drivers, ...(verify !== undefined ? { verify } : {}) };
}
