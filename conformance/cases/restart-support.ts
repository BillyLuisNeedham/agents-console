/**
 * What the restart cases for Tickets and Attempts share (ticket C05 of the
 * Rust port's inventory, docs/research/rust-port/test-inventory.md): the
 * pool they start from, the Ticket files they seed and edit while no server
 * runs, and the start of the next server on a pool another one left.
 * Everything goes through HTTP, the socket or the pool's files.
 *
 * A case that starts more than one server on its pool is a takeover case
 * (`restartCase`): each server after the first runs the next leg
 * CONFORMANCE_LEGS names (`startLeg`). Without legs every server is the
 * run's own. A case that seeds the pool on
 * disk and starts one server is a plain case: what it boots on is files, not
 * another server's run.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseOptions, type CaseServer, type CaseStartOptions } from "../harness/case.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";

/** Every Ticket on the stubbed claude. */
export const CONFIG = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;

/** The same, terminal-backed: every Attempt in a herdr pane. */
export const TERMINAL = { ...CONFIG, terminal: "herdr" } satisfies PoolConfig;

/** The final Review's Ticket id. */
export const REVIEW = "REVIEW";

/** A Ticket's state line. */
export function stateLine(id: string, status: string, blockedBy = "none", extra = ""): string {
  return `<!-- state: id=${id} blocked-by=${blockedBy} status=${status}${extra} -->`;
}

/** A Ticket seed, `<id>-<letter>.md`, as the engine tests name them (01-a.md, 02-b.md). */
export function ticket(
  id: string,
  letter: string,
  options: { blockedBy?: string; status?: string; body?: string; extra?: string } = {},
): TicketSeed {
  return {
    file: `${id}-${letter}.md`,
    marker: stateLine(id, options.status ?? "ready", options.blockedBy ?? "none", options.extra ?? ""),
    body: options.body ?? `# ${id}\n\nWork on ${id}.`,
  };
}

/**
 * Set a Ticket file's status on its state line, the rest of the file as it
 * was: a human's edit while no server runs.
 */
export function setStatus(world: World, file: string, status: string): void {
  const path = join(world.pool, "issues", file);
  const text = readFileSync(path, "utf8");
  const newline = text.indexOf("\n");
  const first = newline < 0 ? text : text.slice(0, newline);
  if (!/ status=[a-z-]+/.test(first)) throw new Error(`issues/${file} has no status on its state line: ${first}`);
  writeFileSync(path, first.replace(/ status=[a-z-]+/, ` status=${status}`) + (newline < 0 ? "" : text.slice(newline)));
}

/**
 * The note the engine appends to a Ticket a stop left in-progress when no
 * agent of that process is found still running at the next boot
 * (ENGINE_RESET_NOTE in engine/engine.ts), byte for byte.
 */
export const ENGINE_RESET_NOTE =
  "\n---\n\n## Brief, written by the engine\n\n" +
  "The engine process stopped while this ticket was in-progress (killed, crashed, or the machine restarted). " +
  "No agent from that process was found still running at this boot, so the work is part done at best and the " +
  "agent left no brief. The ticket is back to ready; read the working tree before it runs again.\n";

/** A restart case: a takeover case in the `restart` area, its servers started with `startLeg`. */
export function restartCase(name: string, body: (t: Case) => Promise<void>, options: CaseOptions = {}): void {
  conformance("restart", name, body, { ...options, takeover: true });
}

/**
 * Start server `n` (from 0) of a restart case on the world's pool: leg `n`
 * of CONFORMANCE_LEGS, wrapping round when the case starts more servers
 * than there are legs. The server before it must have stopped.
 */
export function startLeg(t: Case, world: World, n: number, options: CaseStartOptions = {}): Promise<CaseServer> {
  return t.start(world, { ...options, leg: n % t.legs.length });
}

/** GET /api/state's snapshot; throws while there is none, so `until` polls on. */
export async function snapshotOf(server: CaseServer): Promise<EnrichedSnapshot> {
  const answer = await server.http.get("/api/state");
  if (answer.status !== 200) throw new Error(`GET /api/state answered ${answer.status}: ${answer.text.slice(0, 200)}`);
  const snapshot = answer.json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
  if (snapshot === null) throw new Error("the pool has not started");
  return snapshot;
}

/** Poll the snapshot until `done` holds of it. Generous by default: the box may be loaded. */
export function untilState(
  server: CaseServer,
  what: string,
  done: (snapshot: EnrichedSnapshot) => boolean,
  ms = 30_000,
): Promise<EnrichedSnapshot> {
  return until(() => snapshotOf(server), done, { what, ms });
}

/** The snapshot once the drive has stopped moving and `done` holds of it. */
export function settle(
  server: CaseServer,
  what: string,
  done: (snapshot: EnrichedSnapshot) => boolean = () => true,
  ms = 30_000,
): Promise<EnrichedSnapshot> {
  return untilState(server, what, (snapshot) => snapshot.phase !== "running" && done(snapshot), ms);
}

/** The pending Interrupts as `<ticket id>:<kind>`, sorted. */
export function interruptsOf(snapshot: EnrichedSnapshot): string[] {
  return snapshot.state.interrupts.map((interrupt) => `${interrupt.ticketId}:${interrupt.kind}`).sort();
}

/** Quiescent with exactly these Interrupts pending, each `<ticket id>:<kind>`. */
export function quiescentWith(...expected: string[]): (snapshot: EnrichedSnapshot) => boolean {
  const want = [...expected].sort().join(" ");
  return (snapshot) => snapshot.phase === "quiescent" && interruptsOf(snapshot).join(" ") === want;
}

/** Each Ticket's status, by id. */
export function statusesOf(snapshot: EnrichedSnapshot): Record<string, string> {
  return Object.fromEntries(snapshot.state.tickets.map((each) => [each.id, each.status]));
}

/** POST /api/resume, which must answer `status` (202 by default). */
export async function answer(server: CaseServer, body: Record<string, unknown>, status = 202): Promise<void> {
  const got = await server.http.post("/api/resume", body);
  if (got.status !== status) {
    throw new Error(`POST /api/resume ${JSON.stringify(body)} answered ${got.status}, not ${status}: ${got.text}`);
  }
}

/** Wait for the Review alone, approve it, and wait for the run to end done. */
export async function approveReview(server: CaseServer, ms = 30_000): Promise<EnrichedSnapshot> {
  await settle(server, "the Review alone", quiescentWith(`${REVIEW}:review`), ms);
  await answer(server, { ticketId: REVIEW, action: "approve" });
  return settle(server, "the run to end done", (snapshot) => snapshot.phase === "done", ms);
}

/** The pool log as GET /api/pool-log serves it, every line. */
export async function poolLog(server: CaseServer): Promise<string[]> {
  const got = await server.http.get(`/api/pool-log?before=${Number.MAX_SAFE_INTEGER}&limit=100000`);
  if (got.status !== 200) throw new Error(`GET /api/pool-log answered ${got.status}: ${got.text}`);
  return got.json<{ lines: string[] }>().lines;
}

/** Poll the pool log until a line contains `text`; every line read. */
export function untilLogged(server: CaseServer, text: string, ms = 30_000): Promise<string[]> {
  return until(() => poolLog(server), (lines) => lines.some((line) => line.includes(text)), {
    what: `a pool log line containing ${JSON.stringify(text)}`,
    ms,
  });
}

/** Every launch's key, in launch order. */
export function launchKeys(world: World): string[] {
  return world.stubs.calls().map((call) => call.key);
}

/** A Ticket's events as `<attempt> <kind>`, in order. */
export function eventLine(world: World, id: string): string[] {
  return readEvents(world.pool, id).map((event) => `${event.attempt} ${event.kind}`);
}
