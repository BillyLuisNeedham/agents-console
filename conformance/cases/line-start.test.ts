/**
 * Beginning the Line (ADR-0040), seen from outside the server: POST /api/line freezes a Plan, by
 * slug or as a file, into line.json with the Line brief or the work it is given, writes no Ticket
 * itself, and the first tick writes the entry node's Ticket with its node and Assignment on the
 * state line. It refuses with the reason, writing nothing, a Plan that is invalid, a harness the
 * machine lacks (a node's, or a Merger's resolver), a missing or invalid brief, a pool that already
 * holds an id the Line would write, and a second Line.
 * A Conversation node anywhere in the Plan begins, and so does a per-item node with its Merger.
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
import { flagValue, launchesOf } from "./config-support.ts";
import { BRIEF, SPEC, atCheckpoint, beginLine, begun, issue, lineOf, lineWorld, reason } from "./line-support.ts";

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

conformance("line", "POST /api/line refuses a bad body, an invalid Plan, an unknown harness and a missing or invalid brief, and writes nothing", async (t) => {
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
  writeFileSync(brief, JSON.stringify({ spec: SPEC, nodes: { implement: { assign: { harness: "nonesuch" } } } }));
  const unknownHarness = await beginLine(server);
  expect(unknownHarness.status).toBe(409);
  expect(reason(unknownHarness)).toStartWith(
    "Line brief docs/specs/line.brief.json: node implement names unknown harness 'nonesuch'. Known: ",
  );
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
  expect(saved.places).not.toHaveProperty("base");
  expect(saved.run.status).toBe("running");

  const card = ticketOf(await snapshot(server), "implement-1");
  expect(card.node).toBe("implement");
  expect(card.assignment).toMatchObject({ harness: "claude", model: "opus", drivers: "tdd" });

  const again = await beginLine(server);
  expect(again.status).toBe(409);
  expect(reason(again)).toBe("the pool's Line has already begun: a pool runs one Line");
  await hold.release();
});

conformance("line", "a Plan file whose entry is a Ticket node begins on the work, which the entry Ticket's body carries as the issue to read", async (t) => {
  const world = lineWorld(t, null);
  const hold = world.stubs.hold("build-1");
  const server = await t.start(world);

  const line = await begun(server, { plan: buildThenFinish({ note: "one small step" }), work: "37" });
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
  expect(file).toContain("## The Line's work\n\nThe piece of work for this Line is issue #37. Read it (gh issue view 37).");
  expect(file).toContain("## Note for this node\n\none small step");
  expect(file).not.toContain("## The spec");
  await hold.release();
});

conformance("line", "a Ticket node's empty or partial assign falls through per field to console.json, and the resolved model and effort reach the harness", async (t) => {
  const world = lineWorld(t, null, {}, {
    defaults: { harness: "claude", model: "pool-model", effort: "low", drivers: "pool-drivers" },
    assign: { "effort-1": { model: "operator-model" } },
  });
  const server = await t.start(world);
  const plan = {
    horde: 1,
    name: "Three assigns",
    nodes: [
      { kind: "agent", id: "bare", title: "Bare", x: 0, y: 0, assign: {} },
      { kind: "agent", id: "model", title: "Model", x: 0, y: 0, assign: { model: "plan-model" } },
      { kind: "agent", id: "effort", title: "Effort", x: 0, y: 0, assign: { effort: "high" } },
      { kind: "finish", id: "finish", title: "Finish", x: 0, y: 0, act: "none" },
    ],
    edges: [
      { from: "bare", on: "done", to: "model" },
      { from: "model", on: "done", to: "effort" },
      { from: "effort", on: "done", to: "finish" },
    ],
  } as PlanFile;
  await begun(server, { plan, work: "#1" });

  const atFinish = await atCheckpoint(server, "finish-1");
  const flag = (id: string, name: string) => flagValue(launchesOf(world, id)[0]!.argv, name);
  const resolved = (id: string) => ticketOf(atFinish, id).assignment;
  // The operator's assign entry for the id wins, then the node's field, then the pool's defaults.
  expect(resolved("bare-1")).toMatchObject({ harness: "claude", model: "pool-model", effort: "low", drivers: "pool-drivers" });
  expect(resolved("model-1")).toMatchObject({ model: "plan-model", effort: "low" });
  expect(resolved("effort-1")).toMatchObject({ model: "operator-model", effort: "high" });
  expect([flag("bare-1", "--model"), flag("bare-1", "--effort")]).toEqual(["pool-model", "low"]);
  expect([flag("model-1", "--model"), flag("model-1", "--effort")]).toEqual(["plan-model", "low"]);
  expect([flag("effort-1", "--model"), flag("effort-1", "--effort")]).toEqual(["operator-model", "high"]);
});

conformance("line", "a pool that already holds a Ticket or Conversation under an id the Line writes refuses the Line, naming it, and writes nothing", async (t) => {
  const world = lineWorld(t);
  writeFileSync(
    join(world.pool, "issues", "implement-1.md"),
    "<!-- state: id=implement-1 blocked-by=none status=done -->\n\n# implement-1: A plain Ticket\n\nWork somebody else began.\n",
  );
  writeFileSync(
    join(world.pool, "conversations", "grill-1.md"),
    "<!-- conversation: id=grill-1 status=ended spawned-by=none harness=claude model=m drivers=implement -->\n\n# Talk\n\n\n",
  );
  writeFileSync(
    join(world.pool, "issues", "tidy.md"),
    "<!-- state: id=tidy blocked-by=none status=done -->\n\n# tidy: Tidy\n\nNot the Line's id.\n",
  );
  const server = await t.start(world);

  const taken = await beginLine(server);
  expect(taken.status).toBe(409);
  expect(reason(taken)).toBe(
    "the Line cannot begin: the pool already holds implement-1, grill-1, which the Line would write as its own",
  );
  expect(await lineOf(server)).toBeNull();
  expect(existsSync(join(world.pool, "line.json"))).toBe(false);
  expect(readFileSync(join(world.pool, "issues", "implement-1.md"), "utf8")).toContain("Work somebody else began.");
  expect(existsSync(join(world.pool, "issues", "decide-1.md"))).toBe(false);
  expect((await snapshot(server)).state.tickets.map((ticket) => ticket.id)).toEqual(["implement-1", "tidy"]);
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

  await begun(server, { plan, work: "37" });
  // A headless pool cannot give the pass a pane: it is recorded crashed with why, and the Line goes on.
  const snap = await atCheckpoint(server, "finish-1");
  expect(snap.state.log).toContain(
    'line: talk-1 did not open: conversation start: the pool is not terminal-backed (set console.json terminal: "herdr")',
  );
  expect(snap.state.log).toContain("line: talk-1 hands on closed");
  expect(snap.state.conversations.find((c) => c.id === "talk-1")).toMatchObject({ status: "crashed", node: "talk" });
  // The engine publishes a snapshot only after the job that wrote its files, never before.
  expect(readFileSync(join(world.pool, "conversations", "talk-1.md"), "utf8").split("\n", 1)[0]).toBe(
    "<!-- conversation: id=talk-1 status=crashed spawned-by=none harness= model= drivers= node=talk -->",
  );
  expect(readStateLine(world.pool, "finish-1.md").line).toContain("status=checkpoint node=finish hold");
});

/** build (per-item) -> build-merge -> Finish, with the Merger's `conflict` as given. */
function buildThenMerge(conflict?: unknown): PlanFile {
  return {
    horde: 1,
    name: "Build then merge",
    nodes: [
      { kind: "agent", id: "build", title: "Build", x: 0, y: 0, copies: { perItem: 2 } },
      { kind: "merger", id: "build-merge", title: "Merge", x: 0, y: 0, of: "build", ...(conflict === undefined ? {} : { conflict }) },
      { kind: "finish", id: "finish", title: "Finish", x: 0, y: 0, act: "none" },
    ],
    edges: [
      { from: "build", on: "done", to: "build-merge" },
      { from: "build-merge", on: "done", to: "finish" },
    ],
  } as PlanFile;
}

conformance("line", "a per-item node with a Merger begins, and a Merger whose resolver names a harness the machine lacks is refused naming it", async (t) => {
  const world = lineWorld(t, null);
  const hold = world.stubs.hold("build-1");
  const server = await t.start(world);

  const bad = await beginLine(server, { plan: buildThenMerge({ resolver: { harness: "nope", model: "m" } }), work: "#1" });
  expect(bad.status).toBe(409);
  expect(reason(bad)).toStartWith("the Line cannot begin: node build-merge names unknown harness 'nope'. Known: ");
  expect(await lineOf(server)).toBeNull();
  expect(existsSync(join(world.pool, "line.json"))).toBe(false);
  expect(existsSync(join(world.pool, "issues", "build-1.md"))).toBe(false);

  const line = await begun(server, { plan: buildThenMerge({ resolver: { harness: "opencode" } }), work: "#1" });
  expect(line.plan.nodes.find((n) => n.id === "build")).toMatchObject({ copies: { perItem: 2 } });
  expect(line.plan.nodes.find((n) => n.id === "build-merge")).toMatchObject({ kind: "merger", of: "build" });
  await until(
    () => readStateLine(world.pool, "build-1.md").line,
    (state) => state.includes("status=in-progress"),
    { what: "build-1 to launch" },
  );
  expect(readStateLine(world.pool, "build-1.md").line).toBe(
    "<!-- state: id=build-1 blocked-by=none status=in-progress node=build -->",
  );
  await hold.release();
});
