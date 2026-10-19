/**
 * What the Line cases share (ADR-0040): a pool whose checkout holds a spec and a Line brief, the
 * Line begun on a Plan through POST /api/line, the stub Outcomes each Ticket node writes, and the
 * reads of the Line from outside the server.
 */

import { expect } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EnrichedSnapshot,
  LineBeginRequest,
  LineGraphView,
  LineResponse,
  PoolConfig,
} from "../../protocol/wire.ts";
import type { Case, CaseServer } from "../harness/case.ts";
import type { HttpAnswer } from "../harness/http.ts";
import { answer, settle } from "../harness/pool-run.ts";
import type { ConformanceStubBehaviour } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";

export const CONFIG = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;
export const SPEC = "docs/specs/line.md";
export const BRIEF = "docs/specs/line.brief.json";

/**
 * A pool before its Line begins: no Ticket yet, the spec and the brief committed in the pool
 * checkout. A conversations/ directory lets the pool boot with no Ticket, as Boot's Line mode does.
 */
export function lineWorld(
  t: Case,
  brief: unknown = { spec: SPEC, finish: "none" },
  repoFiles: Record<string, string> = {},
  config: PoolConfig = CONFIG,
): World {
  const world = t.world({
    config,
    repoFiles: {
      [SPEC]: "# The spec\n\nBuild the thing.\n",
      ...(brief === null ? {} : { [BRIEF]: typeof brief === "string" ? brief : JSON.stringify(brief) }),
      ...repoFiles,
    },
  });
  mkdirSync(join(world.pool, "conversations"), { recursive: true });
  return world;
}

/** POST /api/line, by default Factory today on the checkout's brief. */
export function beginLine(
  server: CaseServer,
  body: object = { plan: "factory-today", brief: BRIEF } satisfies LineBeginRequest,
): Promise<HttpAnswer> {
  return server.http.post("/api/line", body);
}

/** Begin the Line, which must be accepted with 202 and the Line it froze. */
export async function begun(server: CaseServer, body?: LineBeginRequest): Promise<LineGraphView> {
  const got = await beginLine(server, body);
  expect(got.status).toBe(202);
  const line = got.json<LineResponse>().line;
  expect(line).not.toBeNull();
  return line!;
}

/** GET /api/line's Line. */
export async function lineOf(server: CaseServer): Promise<LineGraphView | null> {
  return (await server.http.get("/api/line")).json<LineResponse>().line;
}

/** A 409's reason. */
export const reason = (got: HttpAnswer): string => got.json<{ reason: string }>().reason;

/** A done Outcome carrying `verdict`, as a Ticket node's stub writes it. */
export function verdict(value: unknown, extra: Record<string, unknown> = {}): ConformanceStubBehaviour {
  return {
    outcomeRaw: JSON.stringify({ status: "done", summary: "node done", commitSha: null, verdict: value, ...extra }),
  };
}

/** Where a Line on `branch` keeps Decide's report for one pass: `runs/<line>-<node>-<pass>-report.html`. */
export function reportOf(world: World, pass: number, line = "main", node = "decide"): string {
  return join(world.pool, "runs", `${line}-${node}-${pass}-report.html`);
}

/** The report a Decide stub writes before it records its verdict. */
export const REPORT_HTML = "<!doctype html><title>Line report</title><h1>The Line report</h1>";

/** Bash that writes the report where the Decide Ticket's body tells it to. */
const WRITE_REPORT =
  "report=\"$(grep -o 'write the report with /html to `[^`]*`' \"$STUB_ISSUE\" | head -1 | cut -d'`' -f2)\"; " +
  `[ -n "$report" ] && mkdir -p "$(dirname "$report")" && printf '%s' '${REPORT_HTML}' > "$report"`;

/** A Decide that writes its report, then records `value`. */
export function deciding(value: unknown, extra: Record<string, unknown> = {}): ConformanceStubBehaviour {
  return { ...verdict(value, extra), run: WRITE_REPORT };
}

export const PASS = verdict({ prove: "pass", evidence: "proof/ok.txt" });
export const FAIL = verdict({ prove: "fail", evidence: "proof/fail.txt" }, { brief: "the CLI exits 2 on an empty pool" });
export const NO_FINDINGS = verdict({ findings: [] });
export const SHIP = deciding({ decide: "ship" });

/** Factory today's pass path from Prove on, every node clean. */
export function passPath(world: World): void {
  world.stubs.script("prove-1", PASS);
  world.stubs.script("review-1", NO_FINDINGS);
  world.stubs.script("decide-1", SHIP);
}

/** Approve the Finish hold and wait for the run to be done: a Line pool's Review is its Finish. */
export async function approveFinish(server: CaseServer, id: string): Promise<EnrichedSnapshot> {
  await answer(server, { ticketId: id, note: "approved" });
  return settle(server, (snap) => snap.phase === "done", { what: "the run to be done" });
}

/** Every Ticket's node, by id. */
export function nodes(snap: EnrichedSnapshot): Record<string, string | undefined> {
  return Object.fromEntries(snap.state.tickets.map((ticket) => [ticket.id, ticket.node]));
}

/** Every launch's key, in launch order. */
export function launches(world: World): string[] {
  return world.stubs.calls().map((call) => call.key);
}

/** A Ticket file in the pool. */
export function issue(world: World, id: string): string {
  return readFileSync(join(world.pool, "issues", `${id}.md`), "utf8");
}

/** The body of the Interrupt on `id`, empty when none. */
export function interruptOn(snap: EnrichedSnapshot, id: string): string {
  return snap.state.interrupts.find((i) => i.ticketId === id)?.body ?? "";
}

/** The run once it rests with a checkpoint Interrupt on `id`. */
export function atCheckpoint(server: CaseServer, id: string): Promise<EnrichedSnapshot> {
  return settle(
    server,
    (snap) => snap.state.interrupts.some((i) => i.ticketId === id && i.kind === "checkpoint"),
    { what: `a checkpoint on ${id}` },
  );
}
