/**
 * What the `config` cases share: Ticket and Conversation seeds, reading the
 * snapshot, answering the final Review, holding a stub open while a case
 * edits console.json under the run, the settings and Reassign routes, and a
 * server that refuses its pool at load. Everything here works from outside
 * the server, as the cases do.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EnrichedSnapshot,
  EnrichedTicketState,
  PoolConfig,
  ReassignResponse,
  SettingsResponse,
} from "../../engine/wire.ts";
import type { CaseServer } from "../harness/case.ts";
import type { HttpAnswer } from "../harness/http.ts";
import { until } from "../harness/pool-files.ts";
import { freePort, serverArgv, serverChoice } from "../harness/server.ts";
import type { StubCall } from "../harness/stubs.ts";
import type { TicketSeed, World } from "../harness/world.ts";

/**
 * A Ticket file `<id>-t.md`: ready unless told otherwise, titled by its id.
 * `extra` is further marker fields as written, `enlisted-from=<pane>` say.
 */
export function ticket(
  id: string,
  options: { blockedBy?: string[]; status?: string; spawnedBy?: string; extra?: string } = {},
): TicketSeed {
  const blocked = options.blockedBy && options.blockedBy.length > 0 ? options.blockedBy.join(",") : "none";
  const spawned = options.spawnedBy ? ` spawned-by=${options.spawnedBy}` : "";
  const extra = options.extra ? ` ${options.extra}` : "";
  return {
    file: `${id}-t.md`,
    marker: `<!-- state: id=${id} blocked-by=${blocked} status=${options.status ?? "ready"}${spawned}${extra} -->`,
    body: `# ${id}: Ticket ${id}\n\nDo the work of ${id}.`,
  };
}

/** A Ticket already done, so the pool never launches it. */
export function doneTicket(id: string, options: { blockedBy?: string[]; spawnedBy?: string } = {}): TicketSeed {
  return ticket(id, { ...options, status: "done" });
}

/**
 * An ended Conversation's record, `conversations/<id>.md`, as a pool file.
 * Each value is URI-encoded, as the engine writes it, so drivers may hold a
 * space.
 */
export function conversationRecord(
  id: string,
  fields: { harness: string; model: string; effort?: string; drivers?: string },
): Record<string, string> {
  const effort = fields.effort !== undefined ? ` effort=${encodeURIComponent(fields.effort)}` : "";
  const drivers = encodeURIComponent(fields.drivers ?? "implement");
  return {
    [`conversations/${id}.md`]:
      `<!-- conversation: id=${id} status=ended spawned-by=none harness=${encodeURIComponent(fields.harness)} ` +
      `model=${encodeURIComponent(fields.model)}${effort} drivers=${drivers} -->\n\n# ${id}\n`,
  };
}

/** console.json as written, values the type rules out included. */
export function rawConfig(value: unknown): PoolConfig {
  return value as PoolConfig;
}

/** The server's snapshot now. */
export async function snapshotOf(server: CaseServer): Promise<EnrichedSnapshot> {
  const answer = await server.http.get("/api/state");
  expect(answer.status).toBe(200);
  const { snapshot } = answer.json<{ snapshot: EnrichedSnapshot | null }>();
  if (snapshot === null) throw new Error("GET /api/state carried no snapshot");
  return snapshot;
}

/** One Ticket of a snapshot, by id. */
export function ticketOf(snapshot: EnrichedSnapshot, id: string): EnrichedTicketState {
  const found = snapshot.state.tickets.find((ticket) => ticket.id === id);
  if (!found) throw new Error(`the snapshot has no Ticket ${id}: ${snapshot.state.tickets.map((ticket) => ticket.id).join(", ")}`);
  return found;
}

/** Poll the snapshot until `done` holds of it. */
export function untilSnapshot(
  server: CaseServer,
  done: (snapshot: EnrichedSnapshot) => boolean,
  what: string,
  ms = 20_000,
): Promise<EnrichedSnapshot> {
  return until(() => snapshotOf(server), done, { what, ms });
}

/** Wait for the final Review, approve it, and wait for the run to end done. */
export async function approveReview(server: CaseServer): Promise<EnrichedSnapshot> {
  await untilSnapshot(
    server,
    (s) => s.state.interrupts.some((i) => i.ticketId === "REVIEW"),
    "the final Review",
    30_000,
  );
  const answer = await server.http.post("/api/resume", { ticketId: "REVIEW", action: "approve" });
  expect(answer.status).toBe(202);
  return untilSnapshot(server, (s) => s.phase === "done", "the run to end done");
}

/** The file a held stub waits for; creating it releases the stub. */
export function holdFile(world: World, key: string): string {
  return join(world.root, `release-${key}`);
}

/** Release a stub scripted with `waitFor: holdFile(world, key)`. */
export function release(world: World, key: string): void {
  writeFileSync(holdFile(world, key), "go\n");
}

/** Every launch of one key so far. */
export function launchesOf(world: World, key: string): StubCall[] {
  return world.stubs.calls().filter((call) => call.key === key);
}

/** Wait until `key` has launched `n` times, and hand back those launches. */
export function untilLaunched(world: World, key: string, n = 1, ms = 20_000): Promise<StubCall[]> {
  return until(() => launchesOf(world, key), (calls) => calls.length >= n, {
    what: `${n} launch(es) of ${key}`,
    ms,
  });
}

/** The value after `flag` in an argv, or undefined when the flag is absent. */
export function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}

/** console.json rewritten whole, as a person or an agent would. */
export function writeConfig(world: World, config: PoolConfig | string): void {
  writeFileSync(
    join(world.pool, "console.json"),
    typeof config === "string" ? config : JSON.stringify(config, null, 2),
  );
}

/** Lines of the pool log that start with `prefix`. */
export function logLines(snapshot: EnrichedSnapshot, prefix: string): string[] {
  return snapshot.state.log.filter((line) => line.startsWith(prefix));
}

/** Whether a Ticket file exists under issues/. */
export function hasTicketFile(world: World, file: string): boolean {
  return existsSync(join(world.pool, "issues", file));
}

/** console.json's bytes as they are on disk now, for "the file is unchanged". */
export function consoleText(world: World): string {
  return readFileSync(join(world.pool, "console.json"), "utf8");
}

/** The `error` of a refused settings or Reassign route. */
export function errorOf(answer: HttpAnswer): string {
  return answer.json<{ error: string }>().error;
}

/** GET /api/settings, which must answer 200. */
export async function settingsOf(server: CaseServer): Promise<SettingsResponse> {
  const answer = await server.http.get("/api/settings");
  expect(answer.status, answer.text).toBe(200);
  return answer.json<SettingsResponse>();
}

/** PUT /api/settings/pool with `config` as the patch, answered as it comes. */
export function putPool(server: CaseServer, config: Record<string, unknown>): Promise<HttpAnswer> {
  return server.http.put("/api/settings/pool", { config });
}

/** PUT /api/reassign, answered as it comes. */
export function putReassign(server: CaseServer, body: unknown): Promise<HttpAnswer> {
  return server.http.put("/api/reassign", body);
}

/**
 * The snapshot built from the pool's files as they stand now. The Bun server
 * builds the snapshot GET /api/state serves at each engine emit and after a
 * Reassign or a settings save, so a hand edit to console.json or a Ticket
 * file shows from the next one, and a pool at rest emits nothing. A Reassign
 * naming only a Ticket that cannot take a write (done, or with an Attempt in
 * flight) writes nothing and is answered with a snapshot built afresh, so
 * this asks for one without moving the pool, then reads it back.
 */
export async function rebuiltSnapshot(server: CaseServer, skippedId: string): Promise<EnrichedSnapshot> {
  const answer = await putReassign(server, { tickets: [skippedId], fields: {} });
  expect(answer.status, answer.text).toBe(200);
  const { applied, skipped } = answer.json<ReassignResponse>();
  expect(applied).toEqual([]);
  expect(skipped.map((entry) => entry.id)).toEqual([skippedId]);
  return snapshotOf(server);
}

/**
 * The snapshot once the pool rests, quiescent. Its first boundary has run by
 * then, so the engine has read console.json for the last time until
 * something drives it again: a hand edit made after this reaches the
 * snapshot's rows and nothing else.
 */
export function restedSnapshot(server: CaseServer, ms = 30_000): Promise<EnrichedSnapshot> {
  return untilSnapshot(server, (s) => s.phase === "quiescent", "the pool to rest", ms);
}

/** Wait until Ticket `id` has an Attempt in flight on the snapshot. */
export function untilInFlight(server: CaseServer, id: string, ms = 30_000): Promise<EnrichedSnapshot> {
  return untilSnapshot(server, (s) => ticketOf(s, id).liveAttempt !== null, `${id}'s Attempt to be in flight`, ms);
}

/**
 * Start the chosen server on a world whose pool it must refuse at load, and
 * wait for it to exit. Hands back the exit code and everything it printed;
 * a server still running at the bound is killed and fails the case.
 */
export async function refusedAtLoad(world: World, ms = 20_000): Promise<{ code: number; output: string }> {
  const choice = serverChoice();
  const proc = Bun.spawn(serverArgv(choice, world.pool, await freePort()), {
    cwd: world.repo,
    env: world.env(join(world.root, "no-herdr.sock")),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  if (!exited) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error(`the ${choice.kind} server was still running ${ms} ms after start on a pool it must refuse`);
  }
  const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: proc.exitCode ?? -1, output };
}
