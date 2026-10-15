/**
 * Start the Line (issue #187, ADR-0037), seen from outside the server: POST
 * /api/line/start reads the Line brief from the pool checkout, writes
 * line.json and Round 1's Implement Ticket with its Station and Assignment on
 * the state line, and refuses with the reason when the brief is missing or
 * invalid or the Line has already started. GET /api/line serves line.json.
 *
 * The stubs on PATH play the Stations.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LineStartResponse } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { snapshot, ticketOf } from "../harness/pool-run.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import { BRIEF, SPEC, lineOf, lineWorld, startLine } from "./factory-line-support.ts";

const reason = (answer: { json<T>(): T }): string => answer.json<{ reason: string }>().reason;

conformance("factory", "Start the Line refuses a missing or invalid brief with the reason and writes nothing", async (t) => {
  const world = lineWorld(t, null);
  const server = await t.start(world);
  const brief = join(world.repo, BRIEF);

  const none = await startLine(server);
  expect(none.status).toBe(409);
  expect(reason(none)).toBe("no Line brief: docs/specs/ in the pool checkout holds no *.brief.json");

  writeFileSync(brief, "{");
  const torn = await startLine(server);
  expect(torn.status).toBe(409);
  expect(reason(torn)).toStartWith("Line brief docs/specs/line.brief.json: not valid JSON");

  writeFileSync(brief, JSON.stringify({ finish: "none" }));
  expect(reason(await startLine(server))).toContain("Line brief docs/specs/line.brief.json: missing field `spec`");

  writeFileSync(brief, JSON.stringify({ spec: "docs/specs/missing.md" }));
  expect(reason(await startLine(server))).toBe(
    "Line brief docs/specs/line.brief.json: its spec docs/specs/missing.md is not in the pool checkout",
  );

  writeFileSync(brief, JSON.stringify({ spec: SPEC, factory: { limits: { proveFailPerRound: 3 } } }));
  expect(reason(await startLine(server))).toContain("unknown field `proveFailPerRound`");

  writeFileSync(brief, JSON.stringify({ spec: SPEC, factory: { stations: { decide: { enabled: false } } } }));
  expect(reason(await startLine(server))).toBe(
    "Line brief docs/specs/line.brief.json: factory.stations.decide.enabled is false: only Prove and Review can be switched off",
  );

  writeFileSync(brief, JSON.stringify({ spec: SPEC, factory: { stations: { prove: { assign: { harness: "nope" } } } } }));
  expect(reason(await startLine(server))).toStartWith(
    "the Line cannot start: the Prove Station names unknown harness 'nope'. Known: ",
  );

  const named = await startLine(server, { brief: "docs/specs/other.brief.json" });
  expect(named.status).toBe(409);
  expect(reason(named)).toBe("no Line brief at docs/specs/other.brief.json in the pool checkout");

  const outside = await startLine(server, { brief: "../line.brief.json" });
  expect(reason(outside)).toBe(
    "the Line brief's path ../line.brief.json must be relative to the pool checkout and stay inside it",
  );

  writeFileSync(brief, JSON.stringify({ spec: SPEC }));
  writeFileSync(join(world.repo, "docs/specs/another.brief.json"), JSON.stringify({ spec: SPEC }));
  expect(reason(await startLine(server))).toBe(
    "more than one Line brief in docs/specs/ (another.brief.json, line.brief.json): name one as brief",
  );

  const badBody = await startLine(server, { brief: 7 });
  expect(badBody.status).toBe(400);
  expect(reason(badBody)).toBe("brief must be a path string");

  expect(await lineOf(server)).toBeNull();
  expect(existsSync(join(world.pool, "line.json"))).toBe(false);
  expect(existsSync(join(world.pool, "issues", "r1-implement.md"))).toBe(false);
  expect((await snapshot(server)).state.tickets).toEqual([]);
});

conformance("factory", "Start the Line writes line.json and r1-implement with its Station and Assignment, and refuses a second start", async (t) => {
  const world = lineWorld(t, { spec: SPEC, finish: "draft-pr", factory: { stations: { implement: { note: "keep it small" } } } });
  const hold = world.stubs.hold("r1-implement");
  const server = await t.start(world);

  const first = await startLine(server);
  expect(first.status).toBe(202);
  expect(first.json<LineStartResponse>()).toEqual({ ticketId: "r1-implement" });

  const assign = encodeURIComponent(JSON.stringify({ harness: "claude", model: "opus", effort: "high", drivers: "implement" }));
  await until(
    () => readStateLine(world.pool, "r1-implement.md").line,
    (line) => line.includes("status=in-progress"),
    { what: "r1-implement to launch" },
  );
  expect(readStateLine(world.pool, "r1-implement.md").line).toBe(
    `<!-- state: id=r1-implement blocked-by=none status=in-progress station=implement spawn-assign=${assign} -->`,
  );
  const file = readFileSync(join(world.pool, "issues", "r1-implement.md"), "utf8");
  expect(file).toContain("# r1-implement: Implement, Round 1\n");
  expect(file).toContain("`docs/specs/line.md` in the pool checkout (the Line brief is `docs/specs/line.brief.json`)");
  expect(file).toContain("## Note for this Station\n\nkeep it small");

  const line = await lineOf(server);
  expect(line).toEqual({
    brief: { spec: SPEC, finish: "draft-pr", factory: { stations: { implement: { note: "keep it small" } } } },
    briefPath: BRIEF,
    status: "running",
    round: 1,
    station: "implement",
    ticket: "r1-implement",
    proveFails: 0,
    fixesBought: 0,
    gated: false,
    extraRounds: 0,
    halted: null,
    rounds: [{ round: 1, proves: [], findings: [], decide: null }],
    // The pool's target branch as the Line started, and where Decide writes the report at the Finish.
    branch: "main",
    report: join(world.pool, "runs", "line-report.html"),
  });
  expect(JSON.parse(readFileSync(join(world.pool, "line.json"), "utf8"))).toEqual(line);

  const card = ticketOf(await snapshot(server), "r1-implement");
  expect(card.station).toBe("implement");
  expect(card.assignment).toMatchObject({ harness: "claude", model: "opus", drivers: "implement" });

  const again = await startLine(server);
  expect(again.status).toBe(409);
  expect(reason(again)).toBe("the Line has already started: Round 1, r1-implement (running)");
  await hold.release();
});
