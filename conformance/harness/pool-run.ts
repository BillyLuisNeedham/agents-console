/**
 * Driving a pool run from outside the server: read its snapshot, wait for
 * it to settle, answer its Interrupts. Every call goes through HTTP, so a
 * case reads the same whichever server it drives (ADR-0036).
 */

import type { EnrichedSnapshot, ResumeAction } from "../../protocol/wire.ts";
import type { HttpAnswer } from "./http.ts";
import type { CaseServer } from "./case.ts";
import { until } from "./pool-files.ts";

/** The phases a drive rests in until something answers it. */
const RESTING = new Set(["quiescent", "done", "stalled", "dead"]);

/** The snapshot `GET /api/state` serves now; throws when there is none yet. */
export async function snapshot(server: CaseServer): Promise<EnrichedSnapshot> {
  const answer = await server.http.get("/api/state");
  const snap = answer.json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
  if (!snap) throw new Error("the server has no snapshot yet");
  return snap;
}

/** Each Ticket's status on a snapshot, by id. */
export function statuses(snap: EnrichedSnapshot): Record<string, string> {
  return Object.fromEntries(snap.state.tickets.map((ticket) => [ticket.id, ticket.status]));
}

/** One Ticket of a snapshot, by id; throws when the snapshot has none. */
export function ticketOf(snap: EnrichedSnapshot, id: string): EnrichedSnapshot["state"]["tickets"][number] {
  const ticket = snap.state.tickets.find((t) => t.id === id);
  if (!ticket) throw new Error(`the snapshot has no ticket ${id}`);
  return ticket;
}

/**
 * Wait until the drive rests (quiescent, done, stalled or dead) and `done`,
 * when given, holds of the snapshot. A drive rests between an answer and
 * the work it starts, so a case that answered something passes a `done`
 * naming what it waits for.
 */
export async function settle(
  server: CaseServer,
  done: (snap: EnrichedSnapshot) => boolean = () => true,
  options: { ms?: number; what?: string } = {},
): Promise<EnrichedSnapshot> {
  return until(
    () => snapshot(server),
    (snap) => RESTING.has(snap.phase) && done(snap),
    { ms: options.ms ?? 30_000, what: options.what ?? "the pool to settle" },
  );
}

/** Wait until the drive rests with an Interrupt of `kind` raised for `ticketId`. */
export function settleOn(server: CaseServer, ticketId: string, kind: string, ms?: number): Promise<EnrichedSnapshot> {
  return settle(
    server,
    (snap) => snap.state.interrupts.some((i) => i.ticketId === ticketId && i.kind === kind),
    { ms, what: `a ${kind} interrupt on ${ticketId}` },
  );
}

/** The body of POST /api/resume. */
export interface ResumeBody {
  ticketId: string;
  action?: ResumeAction;
  note?: string;
  attempt?: number;
}

/** POST /api/resume, answered as it comes. */
export function resume(server: CaseServer, body: ResumeBody): Promise<HttpAnswer> {
  return server.http.post("/api/resume", body);
}

/** POST /api/resume, which must be accepted with 202. */
export async function answer(server: CaseServer, body: ResumeBody): Promise<void> {
  const got = await resume(server, body);
  if (got.status !== 202) {
    throw new Error(`POST /api/resume ${JSON.stringify(body)} answered ${got.status}: ${got.text}`);
  }
}

/** Approve the final Review once it is raised, and wait for the run to be done. */
export async function approveReview(server: CaseServer): Promise<EnrichedSnapshot> {
  await settleOn(server, "REVIEW", "review");
  await answer(server, { ticketId: "REVIEW", action: "approve" });
  return settle(server, (snap) => snap.phase === "done", { what: "the run to be done" });
}
