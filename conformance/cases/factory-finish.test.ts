/**
 * The Line's Finish (issue #187, ADR-0037), seen from outside the server:
 * Decide's body says how to carry out the Finish and where to write the
 * report, a Decide that ends the Line without the report is the no-verdict
 * checkpoint, the Finish checkpoint's Brief links the report, GET
 * /api/line/report serves it, and the snapshot carries the Line for the
 * Console's strip. A Factory pool raises no run-wide Review: approving the
 * Finish checkpoint ends the run, and a pool Boot marked as a Factory pool
 * waits on Start the Line instead of resting at a vacuous Review.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { answer, settle, statuses } from "../harness/pool-run.ts";
import {
  CONFIG,
  FINISH,
  NO_FINDINGS,
  PASS,
  REPORT,
  REPORT_HTML,
  approveFinish,
  atCheckpoint,
  launches,
  lineOf,
  lineWorld,
  started,
  verdict,
} from "./factory-line-support.ts";

const issue = (pool: string, id: string): string => readFileSync(join(pool, "issues", `${id}.md`), "utf8");
const interruptOn = (snap: EnrichedSnapshot, id: string): string =>
  snap.state.interrupts.find((i) => i.ticketId === id)?.body ?? "";

conformance("factory", "Finish none: Decide writes the report, the Finish checkpoint links it, GET /api/line/report serves it, and approval ends the run with no Review", async (t) => {
  const world = lineWorld(t);
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  const before = await server.http.get("/api/line/report");
  expect(before.status).toBe(404);
  expect(before.json<{ reason: string }>().reason).toBe("no Line has started");
  await started(server);

  const report = join(world.pool, REPORT);
  const atFinish = await atCheckpoint(server, "r1-finish");
  // Decide's body names the Finish and the report's path; the line.json the engine wrote names both.
  const line = await lineOf(server);
  expect(line?.report).toBe(report);
  const decide = issue(world.pool, "r1-decide");
  expect(decide).toContain("## The Finish\n\n");
  expect(decide).toContain("1. Carry out the Finish. `none`: nothing beyond the report.");
  expect(decide).toContain(`2. Write the report with /html to \`${report}\`: every Round's Prove evidence, every Review finding`);
  expect(readFileSync(report, "utf8")).toBe(REPORT_HTML);
  expect(interruptOn(atFinish, "r1-finish")).toContain(`The report: ${report} (open it in the Console's Detail).`);

  const served = await server.http.get("/api/line/report");
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("text/html;charset=utf-8");
  expect(served.headers.get("cache-control")).toBe("no-store");
  expect(served.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-popups");
  expect(served.text).toBe(REPORT_HTML);

  // The Line rides the snapshot for the Console's header strip.
  expect(atFinish.line).toEqual({
    round: 1,
    station: "finish",
    ticket: "r1-finish",
    status: "finish",
    proveFails: 0,
    proveFailsAllowed: 2,
    finish: "none",
    report: true,
    halted: null,
  });
  // Approving the Finish checkpoint is the Review: the run ends with no run-wide Review raised.
  expect(atFinish.state.interrupts.map((i) => i.ticketId)).toEqual(["r1-finish"]);
  const done = await approveFinish(server, "r1-finish");
  expect(done.state.interrupts).toEqual([]);
  expect(done.line?.status).toBe("done");
  // This pool rested at a vacuous Review before the Line started (it has no factoryPool mark); from
  // Start the Line on, none is raised.
  const from = done.state.log.findIndex((l) => l.startsWith("line: started from"));
  expect(from).toBeGreaterThan(-1);
  expect(done.state.log.slice(from).some((l) => l.includes("REVIEW"))).toBe(false);
});

conformance("factory", "Finish draft-pr: Decide's body says how to open the draft PR from the Line's branch; Resume with notes on the Finish starts another Round", async (t) => {
  const world = lineWorld(t, { spec: "docs/specs/line.md", finish: "draft-pr" });
  // A Factory pool's checkout is on its own Line branch (ADR-0038).
  world.git(["checkout", "-q", "-b", "line/x"]);
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  world.stubs.script("r2-prove", PASS);
  world.stubs.script("r2-review", NO_FINDINGS);
  world.stubs.script("r2-decide", FINISH);
  const server = await t.start(world);
  await started(server);

  const atFinish = await atCheckpoint(server, "r1-finish");
  const line = await lineOf(server);
  expect(line?.branch).toBe("line/x");
  const decide = issue(world.pool, "r1-decide");
  expect(decide).toContain("1. Carry out the Finish. `draft-pr`: open a draft PR for the Line.");
  expect(decide).toContain("delete the Line's spec and brief (`docs/specs/line*`) in a final commit on your branch");
  expect(decide).toContain(`git push origin HEAD:${line?.branch}`);
  expect(decide).toContain(`gh pr create --draft --base main --head ${line?.branch}`);
  expect(existsSync(join(world.pool, REPORT))).toBe(true);
  expect(interruptOn(atFinish, "r1-finish")).toContain(`The report: ${join(world.pool, REPORT)}`);
  expect(atFinish.line).toMatchObject({ finish: "draft-pr", report: true, status: "finish" });

  // Notes instead of approval: another Round, past the extra-Rounds limit, and its own Finish.
  await answer(server, { ticketId: "r1-finish", note: "the flag needs a short form too" });
  const again = await atCheckpoint(server, "r2-finish");
  expect(launches(world)).toEqual([
    "r1-implement", "r1-prove", "r1-review", "r1-decide",
    "r2-implement", "r2-prove", "r2-review", "r2-decide",
  ]);
  expect(issue(world.pool, "r2-implement")).toContain("## The operator's notes\n\nthe flag needs a short form too");
  // Round 2's Decide hears what Round 1 did, for the report.
  expect(issue(world.pool, "r2-decide")).toContain("## Earlier Rounds\n\n### Round 1\n- Prove r1-prove: pass (evidence `proof/ok.txt`)\n- Decide: finish");
  expect(again.line).toMatchObject({ round: 2, station: "finish", ticket: "r2-finish" });
  const done = await approveFinish(server, "r2-finish");
  expect(statuses(done)["r2-finish"]).toBe("done");
  expect((await lineOf(server))?.status).toBe("done");
});

conformance("factory", "a Decide that finishes without writing the report is the no-verdict checkpoint, and the Resume that writes it routes to the Finish", async (t) => {
  const world = lineWorld(t);
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.launches("r1-decide", [verdict({ decide: "finish" }), FINISH]);
  const server = await t.start(world);
  await started(server);

  const report = join(world.pool, REPORT);
  const decide = await atCheckpoint(server, "r1-decide");
  expect(interruptOn(decide, "r1-decide")).toStartWith(
    `no verdict\n\nthe report is not at ${report}: carry out the Finish, write the report there, then record the verdict.`,
  );
  expect(decide.line).toMatchObject({ station: "decide", report: false });
  expect((await server.http.get("/api/line/report")).json<{ reason: string }>().reason).toBe(
    "no report yet: Decide writes it when it ends the Line",
  );
  await answer(server, { ticketId: "r1-decide", note: "write the report first" });
  const atFinish = await atCheckpoint(server, "r1-finish");
  expect(atFinish.line?.report).toBe(true);
});

conformance("factory", "the Line strip's fails count runs against the Prove limit in force", async (t) => {
  const failing = verdict({ prove: "fail", evidence: "proof/fail.txt" }, { brief: "it fails" });
  const world = lineWorld(t, undefined, {}, { ...CONFIG, factory: { limits: { proveFailsPerRound: 1 } } } satisfies PoolConfig);
  world.stubs.script("r1-prove", failing);
  world.stubs.script("r1-prove-2", failing);
  const server = await t.start(world);
  await started(server);

  const limited = await atCheckpoint(server, "r1-fix-2");
  expect(limited.line).toMatchObject({ round: 1, station: "implement", ticket: "r1-fix-2", proveFails: 2, proveFailsAllowed: 1 });
  await answer(server, { ticketId: "r1-fix-2", note: "one more" });
  const bought = await settle(server, (s) => s.line?.proveFailsAllowed === 2, { what: "the bought fix on the strip" });
  expect(bought.line?.proveFails).toBe(2);
});

conformance("factory", "a pool Boot marked as a Factory pool waits on Start the Line with no Review; a plain pool with no Ticket still raises one", async (t) => {
  const factory = lineWorld(t, undefined, {}, { ...CONFIG, factoryPool: true } satisfies PoolConfig);
  const server = await t.start(factory);
  const waiting = await settle(server, (s) => s.state.log.includes("pool quiescent: waiting on Start the Line"), {
    what: "the Factory pool to wait on Start the Line",
  });
  expect(waiting.phase).toBe("quiescent");
  expect(waiting.state.interrupts).toEqual([]);
  expect(waiting.line).toBeUndefined();
  await server.stop();

  const plain = lineWorld(t);
  const other = await t.start(plain);
  const reviewing = await settle(other, (s) => s.state.interrupts.some((i) => i.kind === "review"), { what: "the Review" });
  expect(reviewing.state.interrupts.map((i) => i.ticketId)).toEqual(["REVIEW"]);
});

conformance("factory", "a PR Finish on a pool whose branch is no Line branch tells Decide to push nothing", async (t) => {
  const world = lineWorld(t, { spec: "docs/specs/line.md", finish: "pr" });
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);

  await atCheckpoint(server, "r1-finish");
  const decide = issue(world.pool, "r1-decide");
  expect(decide).toContain(
    "1. Carry out the Finish. `pr`: but the pool's branch `main` is not a Line branch (line/...), so push nothing and open no PR.",
  );
  expect(decide).not.toContain("git push");
});
