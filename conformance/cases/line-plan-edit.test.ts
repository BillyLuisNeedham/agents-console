/**
 * Edits to a running Line's Plan (ADR-0039), seen from outside the server: POST /api/line/plan and
 * the socket's `line.plan.edit` take typed edits made against the Plan's rev and answer the new
 * rev, which GET /api/line and line.json show. A stale rev, and an edit that would orphan live run
 * state, are refused with nothing changed. Linking a parked verdict hands it on, so the next tick
 * writes the downstream Ticket. The frozen copy changes and the Plan library does not.
 */

import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LineFile, LinePlanEditResponse, PlanEditFile } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import { untilLaunched } from "./line-copies-support.ts";
import { FAIL, begun, lineOf, lineWorld, reason } from "./line-support.ts";
import { edge, node, plan, planFile, plansDir } from "./plans-support.ts";

/** build -> test (a Prove with no fail edge) -> finish. */
const TESTED = plan(
  [node.agent("build"), node.prove("test"), node.finish()],
  [edge("build", "done", "test"), edge("test", "pass", "finish")],
  "Tested",
);

const lineFile = (world: World): string => readFileSync(join(world.pool, "line.json"), "utf8");

const moveTest = (x: number): PlanEditFile => ({ edit: "move", id: "test", x, y: 60 });

conformance("line", "an edit bumps the Plan's rev in GET /api/line and line.json, never the library's copy, and a stale rev or a live node's removal is refused with nothing changed", async (t) => {
  const world = lineWorld(t);
  mkdirSync(plansDir(world), { recursive: true });
  writeFileSync(planFile(world, "tested"), JSON.stringify(TESTED));
  const library = readFileSync(planFile(world, "tested"), "utf8");
  const build = world.stubs.hold("build-1");
  const server = await t.start(world);
  expect((await begun(server, { plan: "tested", work: "#1" })).rev).toBe(0);
  await untilLaunched(world, ["build-1"]);

  const moved = await server.http.post("/api/line/plan", { baseRev: 0, edits: [moveTest(900)] });
  expect(moved.status, moved.text).toBe(200);
  expect(moved.json<LinePlanEditResponse>()).toEqual({ rev: 1, notes: [] });
  expect((await lineOf(server))?.rev).toBe(1);
  const saved = JSON.parse(lineFile(world)) as LineFile;
  expect(saved.rev).toBe(1);
  expect(saved.plan.nodes.find((n) => n.id === "test")).toMatchObject({ x: 900 });
  expect(readFileSync(planFile(world, "tested"), "utf8")).toBe(library);

  const before = lineFile(world);
  const stale = await server.http.post("/api/line/plan", { baseRev: 0, edits: [moveTest(100)] });
  expect(stale.status).toBe(409);
  expect(reason(stale)).toBe("the Plan has changed since: it is at rev 1");
  const live = await server.http.post("/api/line/plan", { baseRev: 1, edits: [{ edit: "removeNode", id: "build" }] });
  expect(live.status).toBe(409);
  expect(reason(live)).toBe("build has 1 live copy: its work must end before the node is removed");
  expect(lineFile(world)).toBe(before);
  expect((await lineOf(server))?.rev).toBe(1);

  const socket = await t.socket(server);
  await socket.sync();
  const reply = await socket.request("line.plan.edit", { baseRev: 1, edits: [moveTest(1200)] });
  if (!reply.ok) throw new Error(`line.plan.edit was refused: ${JSON.stringify(reply.refusal)}`);
  expect(reply.result).toEqual({ rev: 2, notes: [] });
  expect((await lineOf(server))?.rev).toBe(2);
  expect(readFileSync(planFile(world, "tested"), "utf8")).toBe(library);
  await build.release();
});

conformance("line", "linking a parked verdict hands it on, and the next tick writes the downstream Ticket blocked by the one that parked it", async (t) => {
  const world = lineWorld(t);
  world.stubs.script("test-1", FAIL);
  const server = await t.start(world);
  await begun(server, { plan: TESTED, work: "#1" });
  const parked = await until(
    () => lineOf(server),
    (line) => line?.nodes.find((n) => n.id === "test")?.parked.includes("fail") ?? false,
    { what: "test's fail to park", ms: 30_000 },
  );
  expect(parked?.nodes.find((n) => n.id === "test")?.parked).toEqual(["fail"]);

  const linked = await server.http.post("/api/line/plan", {
    baseRev: 0,
    edits: [
      { edit: "addNode", kind: "agent", x: 600, y: 300 },
      { edit: "link", edge: edge("test", "fail", "agent") },
      { edit: "link", edge: edge("agent", "done", "finish") },
    ],
  });
  expect(linked.status, linked.text).toBe(200);
  expect(linked.json<LinePlanEditResponse>().rev).toBe(1);
  await untilLaunched(world, ["agent-1"]);
  expect(readStateLine(world.pool, "agent-1.md").line).toContain("blocked-by=test-1");
  expect((await lineOf(server))?.nodes.find((n) => n.id === "test")?.parked).toEqual([]);
});
