/**
 * What the `spawns` cases share (ADR-0036): the Ticket seeds, the proposal
 * shapes their stub Outcomes carry, and the reads and answers a case makes
 * on a running server to see a Spawn land, wait, or be held. Everything
 * here goes through HTTP or the pool's files, never the engine.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig, TicketEvent } from "../../engine/wire.ts";
import type { CaseServer } from "../harness/case.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";

/** A body long enough to stand as a Ticket (20+ characters). */
export const GOOD_BODY = "A body long enough to stand as a ticket.";

/** The pool config the cases boot with: every Ticket on the stubbed claude. */
export const CONFIG = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;

/** A config with Spawn caps on top of the defaults. */
export function withCaps(spawnCaps: { perAttempt?: number; perRun?: number }): PoolConfig {
  return { ...CONFIG, spawnCaps };
}

/** A Ticket seed, `<id>-t.md`, at a status (ready by default). */
export function ticket(
  id: string,
  blockedBy = "none",
  status = "ready",
  extra = "",
): TicketSeed {
  return {
    file: `${id}-t.md`,
    marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=${status}${extra} -->`,
    body: `# Ticket ${id}\n\nDo ${id}.`,
  };
}

/** One well-formed proposal, with any further fields. */
export function proposal(title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { title, body: GOOD_BODY, ...extra };
}

/** The release file a held stub waits for, and the way to release it. */
export function releaseFile(world: World, name: string): { path: string; release(): void } {
  const path = join(world.root, `release-${name}`);
  return { path, release: () => writeFileSync(path, "go") };
}

/** The current snapshot from GET /api/state. */
export async function snapshot(server: CaseServer): Promise<EnrichedSnapshot> {
  const answer = await server.http.get("/api/state");
  const body = answer.json<{ snapshot: EnrichedSnapshot | null }>();
  if (!body.snapshot) throw new Error("GET /api/state carried no snapshot");
  return body.snapshot;
}

/** Poll the snapshot until `done` holds of it. */
export function snapshotUntil(
  server: CaseServer,
  done: (snap: EnrichedSnapshot) => boolean,
  what: string,
  ms = 20_000,
): Promise<EnrichedSnapshot> {
  return until(() => snapshot(server), done, { what, ms });
}

/** Wait for the pool to come to rest: quiescent with an interrupt waiting, or done. */
export function settled(server: CaseServer, what = "the pool to settle", ms = 20_000): Promise<EnrichedSnapshot> {
  return snapshotUntil(server, (snap) => snap.phase === "quiescent" || snap.phase === "done", what, ms);
}

/** POST /api/resume with an answer for one interrupt. */
export function answer(server: CaseServer, ticketId: string, action: string, note?: string) {
  return server.http.post("/api/resume", { ticketId, action, ...(note !== undefined ? { note } : {}) });
}

/**
 * Settle the pool, approve its final Review, and wait for the run to end
 * done. Fails when the pool settles on anything but the Review alone.
 */
export async function runAndApprove(server: CaseServer, ms = 30_000): Promise<EnrichedSnapshot> {
  const quiet = await snapshotUntil(
    server,
    (snap) => snap.phase === "quiescent" && snap.state.interrupts.some((i) => i.kind === "review"),
    "the final Review",
    ms,
  );
  const others = quiet.state.interrupts.filter((i) => i.kind !== "review");
  if (others.length > 0) throw new Error(`the pool settled with interrupts besides the Review: ${JSON.stringify(others)}`);
  const sent = await answer(server, "REVIEW", "approve");
  if (sent.status !== 202) throw new Error(`approving the Review answered ${sent.status}: ${sent.text}`);
  return snapshotUntil(server, (snap) => snap.phase === "done", "the run to end done", ms);
}

/** The whole pool log, through GET /api/pool-log. */
export async function poolLog(server: CaseServer): Promise<string[]> {
  const answer = await server.http.get("/api/pool-log?before=1000000&limit=100000");
  return answer.json<{ lines: string[] }>().lines;
}

/** The events of one kind on a Ticket's log. */
export function eventsOf(world: World, id: string, kind: string): TicketEvent[] {
  return readEvents(world.pool, id).filter((event) => event.kind === kind);
}

/** The event kinds on a Ticket's log, in order. */
export function eventKinds(world: World, id: string): string[] {
  return readEvents(world.pool, id).map((event) => event.kind);
}

/** Whether a Ticket file exists under issues/. */
export function hasTicket(world: World, file: string): boolean {
  return existsSync(join(world.pool, "issues", file));
}

/** runs/held-spawns.json parsed, or null when there is none. */
export function heldSpawnsFile(world: World): Record<string, unknown> | null {
  const path = join(world.pool, "runs", "held-spawns.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : null;
}

/** runs/spawn-ledger.md, or "" when there is none. */
export function ledger(world: World): string {
  const path = join(world.pool, "runs", "spawn-ledger.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
