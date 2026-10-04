/**
 * The pool as GET /api/state serves it: the enriched snapshot, a Ticket on
 * it, and the wait for the drive to come to rest, which is the outside view
 * of the engine tests' `server.settled()`. Each read is one request; a case
 * that waits for a change polls with `settled` or `until`.
 */

import type { EnrichedSnapshot } from "../../engine/wire.ts";
import type { Http } from "./http.ts";
import { until } from "./pool-files.ts";

/** The final Review's Ticket id, its Interrupt's `ticketId` (REVIEW_TICKET_ID in engine/engine.ts). */
export const REVIEW = "REVIEW";

/** The phases a drive rests in, with no super-step in flight. */
export const RESTING_PHASES = ["quiescent", "done", "dead", "stopped"] as const;

/** Anything a case can send HTTP through: a CaseServer. */
interface Served {
  http: Http;
}

/**
 * /api/state's snapshot, or null before the pool has started. `S` narrows
 * it to the fields a case reads, when it would rather not name them all.
 */
export async function snapshotOf<S = EnrichedSnapshot>(server: Served): Promise<S | null> {
  const answer = await server.http.get("/api/state");
  if (answer.status !== 200) throw new Error(`GET /api/state answered ${answer.status}: ${answer.text.slice(0, 200)}`);
  return answer.json<{ snapshot: S | null }>().snapshot;
}

/** /api/state's snapshot; throws while the pool has not started, so `until` polls on. */
export async function startedSnapshot<S = EnrichedSnapshot>(server: Served): Promise<S> {
  const snapshot = await snapshotOf<S>(server);
  if (snapshot === null) throw new Error("no snapshot yet");
  return snapshot;
}

/** A Ticket on a snapshot, by id; undefined when it is not there or there is no snapshot. */
export function ticketOf<T extends { id: string }>(
  snapshot: { state: { tickets: T[] } } | null | undefined,
  id: string,
): T | undefined {
  return snapshot?.state.tickets.find((ticket) => ticket.id === id);
}

export interface SettleOptions<S> {
  /** The phases that count as at rest. Default quiescent alone; RESTING_PHASES for any rest. */
  phases?: readonly string[];
  /** What must also hold of the snapshot. */
  done?: (snapshot: S) => boolean;
  /** What the wait is for, in a timeout's message. */
  what?: string;
  /** Default 30 s. */
  ms?: number;
}

/** The snapshot once its phase is one of `phases` and `done` holds of it. */
export async function settled<S extends { phase: string } = EnrichedSnapshot>(
  server: Served,
  options: SettleOptions<S> = {},
): Promise<S> {
  const phases = options.phases ?? ["quiescent"];
  const done = options.done ?? (() => true);
  return (await until(
    () => snapshotOf<S>(server),
    (snapshot) => snapshot !== null && phases.includes(snapshot.phase) && done(snapshot),
    { what: options.what ?? `the pool to be ${phases.join(" or ")}`, ms: options.ms ?? 30_000 },
  ))!;
}
