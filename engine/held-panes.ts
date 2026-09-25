/**
 * Held panes (issue #139, CONTEXT.md "Held pane"): the still-live herdr pane
 * of a Terminal-backed attempt that ended in a checkpoint Interrupt. The
 * attempt is over, so it is no Live attempt, but its TUI is still there with
 * the whole conversation in it (ADR-0016: a TUI stays alive after its
 * Outcome), and while the Interrupt waits the Console keeps the pane
 * reachable: peek, focus and attach serve it, and Keep talking continues it
 * as a Continued attempt.
 *
 * The engine holds a pane where the checkpoint is raised and reads it back
 * from the attempt's `spawned` event after a restart, so this module is the
 * one reading of that event: which pane and tab the attempt ran in, where,
 * on what branch, under which Assignment, and, for a Continued attempt, which
 * attempt's worktree the work lives in. Whether the pane is still alive is
 * not the event's to say; the pane survey (pane-survey.ts) answers that.
 */

import type { TicketEvent } from "./events.ts";

/** A Held pane as the snapshot carries it; the rest stays engine-side. */
export interface HeldPaneRecord {
  /** The checkpointed Attempt whose pane this is. */
  attempt: number;
  paneId: string;
}

/** Everything a Continued attempt needs to carry on in a Held pane. */
export interface HeldPane extends HeldPaneRecord {
  tabId: string | null;
  /** herdr's never-reused terminal id, when the spawn recorded one. */
  terminalId: string | null;
  /** Where the attempt ran: its worktree, or the pool checkout. */
  cwd: string;
  /** The branch the attempt worked on; null in the pool checkout. */
  branch: string | null;
  /**
   * The Assignment the pane is running: the checkpointed Attempt's own, as
   * its `spawned` event recorded it, whatever a Reassign has written since.
   * Empty when the event predates the record (the caller falls back).
   */
  harness: string;
  model: string;
  /**
   * The Attempt whose worktree and branch the work lives in: the attempt
   * itself, or for a Continued attempt the one its chain began at, since a
   * verify worktree and branch are named by the attempt that made them.
   */
  workAttempt: number;
  /**
   * Whether the attempt's files are attempt-numbered: a verify candidate's
   * are, a solo attempt's are the ticket's well-known ones, and a Continued
   * attempt keeps the naming of the attempt it continues.
   */
  numbered: boolean;
  /**
   * The Stream file the pane's `script` writes, as a Continued attempt's
   * `spawned` event recorded it; null for the attempt that opened the pane,
   * whose own Stream file it is.
   */
  stream: string | null;
  /** When the attempt's `spawned` event was recorded (ISO). */
  spawnedAt: string;
  /**
   * Whether the pane's TUI runs under the engine's wrapper, which writes an
   * exit-code file when the TUI exits: true for an attempt the engine
   * launched, false for an enlisted pane (the operator started its agent),
   * and a Continued attempt keeps the answer of the attempt it continues.
   */
  wrapped: boolean;
}

/**
 * The Held pane candidate of one attempt, read from the ticket's events: the
 * attempt's `spawned` event, when it names a pane. Null for a headless
 * attempt, a headless fallback, an attempt with no spawn on record, and a
 * resolver's attempt (a resolver never checkpoints its ticket). `numberedCwd`
 * is the attempt worktree a verify candidate of this number would run in:
 * an original spawn records no naming, and a candidate is exactly the
 * attempt that ran there.
 */
export function heldPaneOf(
  events: TicketEvent[],
  attempt: number,
  numberedCwd: (attempt: number) => string,
): HeldPane | null {
  if (events.some((event) => event.kind === "resolver" && event.attempt === attempt)) {
    return null;
  }
  const spawned = events
    .filter((event) => event.kind === "spawned" && event.attempt === attempt)
    .pop();
  if (!spawned) return null;
  const payload = spawned.payload;
  if (typeof payload.pane_id !== "string" || typeof payload.cwd !== "string") {
    return null;
  }
  const workAttempt =
    typeof payload.work_attempt === "number" ? payload.work_attempt : attempt;
  return {
    attempt,
    paneId: payload.pane_id,
    tabId: typeof payload.tab_id === "string" ? payload.tab_id : null,
    terminalId: typeof payload.terminal_id === "string" ? payload.terminal_id : null,
    cwd: payload.cwd,
    branch: typeof payload.branch === "string" ? payload.branch : null,
    harness: typeof payload.harness === "string" ? payload.harness : "",
    model: typeof payload.model === "string" ? payload.model : "",
    workAttempt,
    numbered:
      typeof payload.numbered === "boolean"
        ? payload.numbered
        : payload.cwd === numberedCwd(attempt),
    stream: typeof payload.stream === "string" ? payload.stream : null,
    spawnedAt: spawned.at,
    wrapped:
      typeof payload.wrapped === "boolean"
        ? payload.wrapped
        : Array.isArray(payload.argv) && payload.argv.length > 0,
  };
}

/**
 * The attempt a ticket's latest checkpoint was raised for, read back from its
 * `checkpoint` events after a restart; null when it never checkpointed.
 */
export function lastCheckpointAttempt(events: TicketEvent[]): number | null {
  return events.filter((event) => event.kind === "checkpoint").pop()?.attempt ?? null;
}
