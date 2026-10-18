/**
 * Beginning the Line (ADR-0039), seen from outside the server: POST /api/line freezes a Plan, by
 * slug or as a file, into line.json with the Line brief or the work it is given, writes no Ticket
 * itself, and the first tick writes the entry node's Ticket with its node and Assignment on the
 * state line. It refuses with the reason, writing nothing, a Plan that is invalid or that this
 * build cannot run, a harness the machine lacks, a missing or invalid brief, and a second Line. A
 * Conversation node anywhere in the Plan begins.
 *
 * The stubs on PATH play the Ticket nodes.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LineFile, PlanFile } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { snapshot, ticketOf } from "../harness/pool-run.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import { BRIEF, SPEC, beginLine, begun, issue, lineOf, lineWorld, reason } from "./line-support.ts";

/** A two-node Plan: one Agent node, then the Finish. */
function buildThenFinish(build: Record<string, unknown> = {}): PlanFile {
  return {
    horde: 1,
    name: "Build then finish",
    nodes: [
      { kind: "agent", id: "build", title: "Build", x: 0, y: 0, ...build },
      { kind: "finish", id: "finish", title: "Finish", x: 0, y: 0, act: "none" },
    ],
    edges: [{ from: "build", on: "done", to: "finish" }],
  } as PlanFile;
}

conformance("line", "POST /api/line refuses a bad body, an invalid or unrunnable Plan, an unknown harness and a missing or invalid brief, and writes nothing", async (t) => {
  const world = lineWorld(t, null);
  const server = await t.start(world);
  const brief = join(world.repo, BRIEF);

  const bodies: [Record<string, unknown>, string][] = [
    [{ brief: BRIEF }, "plan is required: a Plan's slug or its file"],
    [{ plan: "factory-today" }, "give exactly one of work or brief"],
    [{ plan: "factory-today", work: "#1", brief: BRIEF }, "give exactly one of work or brief"],
    [{ plan: "factory-today", brief: 7 }, "brief must be a non-empty string"],
  ];
  for (const [body, why] of bodies) {
    const got = await beginLine(server, body);
    expect(got.status).toBe(400);
    expect(reason(got)).toBe(why);
  }
  const unknown = await beginLine(server, { plan: "no-such-plan", work: "#1" });
  expect(unknown.status).toBe(404);

  const noFinish = buildThenFinish();
  const invalid = await beginLine(server, { plan: { ...noFinish, nodes: noFinish.nodes.slice(0, 1), edges: [] }, work: "#1" });
  expect(invalid.status).toBe(409);
  expect(reason(invalid)).toStartWith("the Line cannot begin: its Plan is not valid: ");
  const perItem = await beginLine(server, { plan: buildThenFinish({ copies: { perItem: 2 } }), work: "#1" });
  expect(reason(perItem)).toBe(
    "the Line cannot begin: node build makes one copy per item, which this build cannot run yet",
  );
  const harness = await beginLine(server, { plan: buildThenFinish({ assign: { harness: "nope" } }), work: "#1" });
  expect(reason(harness)).toStartWith("the Line cannot begin: node build names unknown harness 'nope'. Known: ");

  const missing = await beginLine(server);
  expect(missing.status).toBe(409);
  expect(reason(missing)).toBe("Line brief docs/specs/line.brief.json: not found in the pool checkout");
  writeFileSync(brief, "{");
  expect(reason(await beginLine(server))).toStartWith("Line brief docs/specs/line.brief.json: not valid JSON");
  writeFileSync(brief, JSON.stringify({ spec: "docs/specs/missing.md" }));
  expect(reason(await beginLine(server))).toBe(
    "Line brief docs/specs/line.brief.json: its spec docs/specs/missing.md is not in the pool checkout",
  );
  writeFileSync(brief, JSON.stringify({ spec: SPEC, factory: { limits: {} } }));
  expect(reason(await beginLine(server))).toContain("Line brief docs/specs/line.brief.json: unknown field `factory`");
  writeFileSync(brief, JSON.stringify({ spec: SPEC, nodes: { nope: { note: "n" } } }));
  expect(reason(await beginLine(server))).toBe("the Line cannot begin: nodes: the Plan has no node nope");
  const outside = await beginLine(server, { plan: "factory-today", brief: "../line.brief.json" });
  expect(reason(outside)).toBe("Line brief ../line.brief.json: name it by its path inside the pool checkout");

  expect(await lineOf(server)).toBeNull();
  expect(existsSync(join(world.pool, "line.json"))).toBe(false);
  expect(existsSync(join(world.pool, "issues", "implement-1.md"))).toBe(false);
  expect((await snapshot(server)).state.tickets).toEqual([]);
});

conformance("line", "POST /api/line freezes Factory today with the brief in line.json, the first tick writes implement-1 with its node and Assignment, and a second Line is refused", async (t) => {
  const world = lineWorld(t, { spec: SPEC, finish: "draft-pr", nodes: { implement: { note: "keep it small" } } });
  const hold = world.stubs.hold("implement-1");
  const server = await t.start(world);

  const first = await begun(server);
  expect(first).toMatchObject({ status: "running", rev: 1, waitingFor: [] });
  expect(first.plan.name).toBe("Factory today");
  expect(first.plan.nodes.find((n) => n.id === "finish")).toMatchObject({ act: "draft-pr" });
  expect(first.plan.nodes.find((n) => n.id === "implement")).toMatchObject({ note: "keep it small" });
  expect(first.nodes.find((n) => n.id === "grill")).toMatchObject({ passes: 1, tickets: [] });

  await until(
    () => readStateLine(world.pool, "implement-1.md").line,
    (line) => line.includes("status=in-progress"),
    { what: "implement-1 to launch" },
  );
  const assign = encodeURIComponent(JSON.stringify({ harness: "claude", model: "opus", effort: "high", drivers: "tdd" }));
  expect(readStateLine(world.pool, "implement-1.md").line).toBe(
    `<!-- state: id=implement-1 blocked-by=none status=in-progress node=implement spawn-assign=${assign} -->`,
  );
  const file = issue(world, "implement-1");
  expect(file).toContain("# implement-1: Implement, pass 1\n");
  expect(file).toContain("## The spec\n\n`docs/specs/line.md` in the pool checkout.");
  expect(file).toContain("## Note for this node\n\nkeep it small");

  const line = await lineOf(server);
  expect(line?.nodes.find((n) => n.id === "implement")).toMatchObject({ passes: 1, pass: 1, tickets: ["implement-1"] });
  const saved = JSON.parse(readFileSync(join(world.pool, "line.json"), "utf8")) as LineFile;
  expect(saved).toMatchObject({ horde: 1, rev: 1, places: { branch: "main", spec: SPEC } });
  expect(saved.plan).toEqual(line!.plan);
  expect(saved.run.status).toBe("running");

  const card = ticketOf(await snapshot(server), "implement-1");
  expect(card.node).toBe("implement");
  expect(card.assignment).toMatchObject({ harness: "claude", model: "opus", drivers: "tdd" });

  const again = await beginLine(server);
  expect(again.status).toBe(409);
  expect(reason(again)).toBe("the pool's Line has already begun: a pool runs one Line");
  await hold.release();
});

conformance("line", "a Plan file whose entry is a Ticket node begins on the work, which the entry Ticket's body carries", async (t) => {
  const world = lineWorld(t, null);
  const hold = world.stubs.hold("build-1");
  const server = await t.start(world);

  const line = await begun(server, { plan: buildThenFinish({ note: "one small step" }), work: "issue #186" });
  expect(line.plan.name).toBe("Build then finish");
  await until(
    () => readStateLine(world.pool, "build-1.md").line,
    (state) => state.includes("status=in-progress"),
    { what: "build-1 to launch" },
  );
  expect(readStateLine(world.pool, "build-1.md").line).toBe(
    "<!-- state: id=build-1 blocked-by=none status=in-progress node=build -->",
  );
  const file = issue(world, "build-1");
  expect(file).toContain("## The Line's work\n\nissue #186");
  expect(file).toContain("## Note for this node\n\none small step");
  expect(file).not.toContain("## The spec");
  await hold.release();
});

conformance("line", "a Conversation node after the start of a Plan begins, and a pass the pool cannot host is recorded crashed and hands on closed", async (t) => {
  const world = lineWorld(t, null);
  const server = await t.start(world);
  const plan = {
    horde: 1,
    name: "Build then talk",
    nodes: [
      { kind: "agent", id: "build", title: "Build", x: 0, y: 0 },
      { kind: "conversation", id: "talk", title: "Talk", x: 0, y: 0 },
      { kind: "finish", id: "finish", title: "Finish", x: 0, y: 0, act: "none" },
    ],
    edges: [
      { from: "build", on: "done", to: "talk" },
      { from: "talk", on: "done", to: "finish" },
    ],
  } as PlanFile;

  await begun(server, { plan, work: "issue #186" });
  // A headless pool cannot give the pass a pane: it is recorded crashed with why, and the Line goes on.
  const record = join(world.pool, "conversations", "talk-1.md");
  await until(() => existsSync(record), Boolean, { what: "talk-1's record" });
  expect(readFileSync(record, "utf8").split("\n", 1)[0]).toBe(
    "<!-- conversation: id=talk-1 status=crashed spawned-by=none harness= model= drivers= node=talk -->",
  );
  const finish = await until(
    () => readStateLine(world.pool, "finish-1.md").line,
    (state) => state.includes("status=checkpoint"),
    { what: "the Finish to hold" },
  );
  expect(finish).toContain("node=finish hold");
  const snap = await snapshot(server);
  expect(snap.state.log).toContain(
    'line: talk-1 did not open: conversation start: the pool is not terminal-backed (set console.json terminal: "herdr")',
  );
  expect(snap.state.log).toContain("line: talk-1 hands on closed");
  expect(snap.state.conversations.find((c) => c.id === "talk-1")).toMatchObject({ status: "crashed", node: "talk" });
});
