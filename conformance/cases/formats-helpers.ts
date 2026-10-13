/**
 * What the `formats` cases (the inventory's ticket C01) share: Ticket seeds,
 * the snapshot and events reads, waiting on a Ticket's status, and a server
 * start that is meant to be refused.
 */

import { expect } from "bun:test";
import { join } from "node:path";
import type { EnrichedSnapshot, EnrichedTicketState, TicketEventsResponse } from "../../protocol/wire.ts";
import type { Http } from "../harness/http.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import { freePort, serverArgv, serverChoice } from "../harness/server.ts";
import type { TicketSeed, World } from "../harness/world.ts";

/** A Ticket `<id>-t.md` titled `T<id>`, ready unless `status` says otherwise. */
export function ticket(id: string, options: { blockedBy?: string; status?: string; extra?: string } = {}): TicketSeed {
  const extra = options.extra ? ` ${options.extra}` : "";
  return {
    file: `${id}-t.md`,
    marker: `<!-- state: id=${id} blocked-by=${options.blockedBy ?? "none"} status=${options.status ?? "ready"}${extra} -->`,
    body: `# T${id}\n\nWork.`,
  };
}

export async function snapshot(http: Http): Promise<EnrichedSnapshot> {
  return (await http.get("/api/state")).json<{ snapshot: EnrichedSnapshot }>().snapshot;
}

export async function ticketView(http: Http, id: string): Promise<EnrichedTicketState | undefined> {
  return (await snapshot(http))?.state.tickets.find((t) => t.id === id);
}

export async function events(http: Http, id: string): Promise<TicketEventsResponse> {
  const answer = await http.get(`/api/events?ticket=${id}`);
  expect(answer.status, answer.text).toBe(200);
  return answer.json<TicketEventsResponse>();
}

/** Wait for a Ticket file's state line to carry `status`. */
export function untilStatus(world: World, file: string, status: string, ms = 30_000) {
  return until(
    () => readStateLine(world.pool, file),
    (line) => line.status === status,
    { ms, what: `issues/${file} to say status=${status}` },
  );
}

/** Wait for the snapshot to show the final Review Interrupt. */
export function untilReview(http: Http, ms = 30_000) {
  return until(
    () => snapshot(http),
    (snap) => snap?.state.interrupts.some((i) => i.ticketId === "REVIEW") ?? false,
    { ms, what: "the final Review Interrupt" },
  );
}

/**
 * Start the chosen server on a world's pool when it is meant to refuse:
 * wait for its exit and hand back the code and everything it printed. A
 * server still running after `ms` is killed and reported with code null.
 */
export async function refusedStart(world: World, ms = 15_000): Promise<{ code: number | null; output: string }> {
  const proc = Bun.spawn(serverArgv(serverChoice(), world.pool, await freePort()), {
    env: world.env(join(world.root, "no-herdr.sock")),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await Promise.race([proc.exited, Bun.sleep(ms).then(() => null)]);
  if (code === null) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code, output };
}
