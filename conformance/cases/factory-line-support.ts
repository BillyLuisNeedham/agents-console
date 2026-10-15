/**
 * What the Factory's Line cases share (issue #187, ADR-0037): a pool whose
 * checkout holds a spec and a Line brief, the stub Outcomes each Station
 * writes, and the reads of the Line's state from outside the server.
 */

import { expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  EnrichedSnapshot,
  LineResponse,
  LineStartResponse,
  LineState,
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
 * A Factory pool before its Line starts: no Ticket yet, the spec and the
 * brief committed in the pool checkout. A conversations/ directory lets the
 * pool boot with no Ticket, as Boot's Factory mode does.
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

/** POST /api/line/start. */
export function startLine(server: CaseServer, body: Record<string, unknown> = {}): Promise<HttpAnswer> {
  return server.http.post("/api/line/start", body);
}

/** Start the Line, which must be accepted with 202 and r1-implement. */
export async function started(server: CaseServer): Promise<void> {
  const got = await startLine(server);
  expect(got.status).toBe(202);
  expect(got.json<LineStartResponse>()).toEqual({ ticketId: "r1-implement" });
}

/** GET /api/line's Line. */
export async function lineOf(server: CaseServer): Promise<LineState | null> {
  return (await server.http.get("/api/line")).json<LineResponse>().line;
}

/** A done Outcome carrying `verdict`, as a Station's stub writes it. */
export function verdict(value: unknown, extra: Record<string, unknown> = {}): ConformanceStubBehaviour {
  return {
    outcomeRaw: JSON.stringify({ status: "done", summary: "station done", commitSha: null, verdict: value, ...extra }),
  };
}

/** Where Decide writes the Line's report: `runs/<line>-report.html`, `<line>` the brief's name. */
export const REPORT = "runs/line-report.html";

/** The report a Decide stub writes before it records its verdict. */
export const REPORT_HTML = "<!doctype html><title>Line report</title><h1>The Line report</h1>";

/** Bash that writes the report where Decide's body says: the runs directory beside the Ticket's issues/. */
const WRITE_REPORT = `pool="$(dirname "$(dirname "$STUB_ISSUE")")"; mkdir -p "$pool/runs"; printf '%s' '${REPORT_HTML}' > "$pool/${REPORT}"`;

/** A Decide that ends the Line: it writes the report, then records `value`. */
export function finishing(value: unknown, extra: Record<string, unknown> = {}): ConformanceStubBehaviour {
  return { ...verdict(value, extra), run: WRITE_REPORT };
}

export const PASS = verdict({ prove: "pass", evidence: "proof/ok.txt" });
export const FAIL = verdict({ prove: "fail", evidence: "proof/fail.txt" }, { brief: "the CLI exits 2 on an empty pool" });
export const NO_FINDINGS = verdict({ findings: [] });
export const FINISH = finishing({ decide: "finish" });

/**
 * Approve the Finish checkpoint and wait for the run to be done: in a Factory pool that approval is
 * the Review, so no run-wide Review follows it.
 */
export async function approveFinish(server: CaseServer, id: string): Promise<EnrichedSnapshot> {
  await answer(server, { ticketId: id, note: "approved" });
  return settle(server, (snap) => snap.phase === "done", { what: "the run to be done" });
}

/** Every Ticket on a snapshot as `id:status`, in the snapshot's order. */
export function cards(snap: EnrichedSnapshot): string[] {
  return snap.state.tickets.map((ticket) => `${ticket.id}:${ticket.status}`);
}

/** Every Ticket's Station, by id. */
export function stations(snap: EnrichedSnapshot): Record<string, string | undefined> {
  return Object.fromEntries(snap.state.tickets.map((ticket) => [ticket.id, ticket.station]));
}

/** Every launch's key, in launch order. */
export function launches(world: World): string[] {
  return world.stubs.calls().map((call) => call.key);
}

/** The run once it rests with a checkpoint Interrupt on `id`. */
export function atCheckpoint(server: CaseServer, id: string): Promise<EnrichedSnapshot> {
  return settle(
    server,
    (snap) => snap.state.interrupts.some((i) => i.ticketId === id && i.kind === "checkpoint"),
    { what: `a checkpoint on ${id}` },
  );
}
