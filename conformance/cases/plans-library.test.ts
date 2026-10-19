/**
 * The Plan library, seen from outside the server (ADR-0036): the files
 * `~/.agent-graphs/plans/<slug>.json` that `PUT /api/plans/<slug>` writes and
 * `DELETE` removes, what `GET /api/plans` and `GET /api/plans/<slug>` read
 * back from them and from the compiled-in Presets, and the refusals, each in
 * the status the route names. Every world has a HOME of its own, so nothing
 * here reads or writes the operator's library. The socket's `plans.*` verbs
 * are driven in one case, on the same library.
 *
 * Origin: docs/specs/build-your-own-factory.md (last tracked at 5182816), Slices item 3 ("New
 * `plans-library` (fenced HOME: save writes the file, a Preset slug is
 * refused, a broken file is listed with its problems)") and "Wire: verbs and
 * snapshot". The refusal words are the ones the core was told to use.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanResponse, PlanSaveResponse, PlanSummary, PlansListResponse } from "../../protocol/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import type { HttpAnswer } from "../harness/http.ts";
import { atEdge, edge, expectProblem, node, plan, planFile, plansDir, plansPool, smallPlan } from "./plans-support.ts";

/** A refusal's reason: the plans routes say `reason`. */
function reasonOf(answer: HttpAnswer): string {
  const { reason } = answer.json<{ reason?: unknown }>();
  expect(typeof reason, answer.text).toBe("string");
  return reason as string;
}

/** A hand-written library file. */
function writeLibrary(dir: string, slug: string, content: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.json`), typeof content === "string" ? content : JSON.stringify(content));
}

/** A Plan with one edge to a node it lacks. */
const brokenPlan = () =>
  plan([node.agent("build"), node.finish()], [edge("build", "done", "finish"), edge("build", "closed", "ghost")], "Broken");

async function listed(server: CaseServer): Promise<PlanSummary[]> {
  const answer = await server.http.get("/api/plans");
  expect(answer.status, answer.text).toBe(200);
  return answer.json<PlansListResponse>().plans;
}

conformance("plans", "a Plan save writes the library file whole, making its directory, and answers the Plan as saved", async (t) => {
  const { world, server } = await plansPool(t);
  // The server registers itself in ~/.agent-graphs at boot, so the directory goes now, for the save to make it again.
  rmSync(join(world.home, ".agent-graphs"), { recursive: true, force: true });

  const saved = await server.http.put("/api/plans/mine", smallPlan("Mine"));

  expect(saved.status, saved.text).toBe(200);
  const body = saved.json<PlanSaveResponse>();
  expect(body.slug).toBe("mine");
  expect(body.plan.name).toBe("Mine");
  expect(body.plan.nodes.map((n) => n.id)).toEqual(["build", "finish"]);
  expect(body.plan.edges.map((e) => [e.from, e.on, e.to])).toEqual([["build", "done", "finish"]]);
  expect(JSON.parse(readFileSync(planFile(world, "mine"), "utf8"))).toEqual(body.plan);
  expect(readdirSync(plansDir(world))).toEqual(["mine.json"]);

  const read = await server.http.get("/api/plans/mine");
  expect(read.status, read.text).toBe(200);
  expect(read.json<PlanResponse>()).toEqual({ slug: "mine", preset: false, plan: body.plan, problems: [] });
});

conformance("plans", "a Plan saved again replaces the file and leaves no temp file beside it", async (t) => {
  const { world, server } = await plansPool(t);

  expect((await server.http.put("/api/plans/mine", smallPlan("First"))).status).toBe(200);
  expect((await server.http.put("/api/plans/mine", smallPlan("Second"))).status).toBe(200);

  expect(JSON.parse(readFileSync(planFile(world, "mine"), "utf8")).name).toBe("Second");
  expect(readdirSync(plansDir(world))).toEqual(["mine.json"]);
});

conformance("plans", "GET /api/plans lists the Presets first, then the library's Plans by slug", async (t) => {
  const { world, server } = await plansPool(t);
  writeLibrary(plansDir(world), "zebra", smallPlan("Zebra"));
  writeLibrary(plansDir(world), "alpha", smallPlan("Alpha"));

  const plans = await listed(server);

  const presets = plans.filter((p) => p.preset);
  expect(presets.length).toBeGreaterThan(0);
  expect(plans.slice(0, presets.length)).toEqual(presets);
  expect(plans.slice(presets.length).map((p) => [p.slug, p.name, p.preset, p.problems])).toEqual([
    ["alpha", "Alpha", false, []],
    ["zebra", "Zebra", false, []],
  ]);
});

conformance("plans", "a library file that is not JSON, and one that is an invalid Plan, are listed with their problems and hide nothing", async (t) => {
  const { world, server } = await plansPool(t);
  writeLibrary(plansDir(world), "broken-text", "{ not json");
  writeLibrary(plansDir(world), "good", smallPlan("Good"));
  writeLibrary(plansDir(world), "invalid", brokenPlan());

  const library = (await listed(server)).filter((p) => !p.preset);

  expect(library.map((p) => p.slug)).toEqual(["broken-text", "good", "invalid"]);
  const [text, good, invalid] = library;
  expect(text!.problems.length).toBeGreaterThan(0);
  expect(good!.problems).toEqual([]);
  expectProblem(invalid!.problems, { at: atEdge("build", "closed", "ghost"), keyword: "no node" });
  expect(invalid!.name).toBe("Broken");
});

conformance("plans", "GET /api/plans/<slug> answers a library file as it stands, with its problems", async (t) => {
  const { world, server } = await plansPool(t);
  const draft = brokenPlan();
  writeLibrary(plansDir(world), "invalid", draft);

  const answer = await server.http.get("/api/plans/invalid");

  expect(answer.status, answer.text).toBe(200);
  const body = answer.json<PlanResponse>();
  expect([body.slug, body.preset, body.plan]).toEqual(["invalid", false, draft]);
  expectProblem(body.problems, { at: atEdge("build", "closed", "ghost"), keyword: "no node" });
});

conformance("plans", "GET /api/plans/<slug> of a library file that is not JSON is refused as 422", async (t) => {
  const { world, server } = await plansPool(t);
  writeLibrary(plansDir(world), "broken-text", "{ not json");

  const answer = await server.http.get("/api/plans/broken-text");

  expect(answer.status, answer.text).toBe(422);
  expect(reasonOf(answer)).not.toBe("");
});

conformance("plans", "a Preset answers by its slug, and a library file under a Preset's slug does not replace it", async (t) => {
  const { world, server } = await plansPool(t);
  writeLibrary(plansDir(world), "factory-today", smallPlan("Imposter"));

  const answer = await server.http.get("/api/plans/factory-today");

  expect(answer.status, answer.text).toBe(200);
  const body = answer.json<PlanResponse>();
  expect([body.slug, body.preset, body.plan.name, body.problems]).toEqual(["factory-today", true, "Factory today", []]);
  expect((await listed(server)).filter((p) => p.slug === "factory-today").map((p) => [p.preset, p.name])).toEqual([
    [true, "Factory today"],
  ]);
});

conformance("plans", "saving or deleting a Preset's slug is refused as 409, writing and removing nothing", async (t) => {
  const { world, server } = await plansPool(t);

  const save = await server.http.put("/api/plans/factory-today", smallPlan("Over it"));
  const remove = await server.http.call("DELETE", "/api/plans/factory-today");

  for (const answer of [save, remove]) {
    expect(answer.status, answer.text).toBe(409);
    expect(reasonOf(answer)).toContain("is a Preset");
  }
  expect(existsSync(planFile(world, "factory-today"))).toBe(false);
  expect((await server.http.get("/api/plans/factory-today")).json<PlanResponse>().plan.name).toBe("Factory today");
});

conformance("plans", "saving an invalid Plan is refused as 400, writing nothing", async (t) => {
  const { world, server } = await plansPool(t);

  const answer = await server.http.put("/api/plans/mine", brokenPlan());

  expect(answer.status, answer.text).toBe(400);
  expect(reasonOf(answer)).toContain("the Plan is invalid");
  expect(existsSync(planFile(world, "mine"))).toBe(false);
});

conformance("plans", "a slug that is not a Plan slug is refused as 400 on every route, touching nothing outside the library", async (t) => {
  const { world, server } = await plansPool(t);
  const slugs = ["BAD", "-leading", "a.b", "x".repeat(65), "validate", "edit", "boot", "..%2Fescape"];

  for (const slug of slugs) {
    for (const [method, body] of [["GET", undefined], ["PUT", smallPlan()], ["DELETE", undefined]] as const) {
      const answer = await server.http.call(method, `/api/plans/${slug}`, body);
      expect([method, slug, answer.status]).toEqual([method, slug, 400]);
      expect(reasonOf(answer)).toContain("is not a Plan slug");
    }
  }
  expect(existsSync(join(world.home, ".agent-graphs", "escape.json"))).toBe(false);
  expect(existsSync(plansDir(world))).toBe(false);
});

conformance("plans", "reading or deleting a slug nobody saved is refused as 404", async (t) => {
  const { server } = await plansPool(t);

  for (const [method, path] of [["GET", "/api/plans/nobody"], ["DELETE", "/api/plans/nobody"]]) {
    const answer = await server.http.call(method!, path!);
    expect([method, answer.status]).toEqual([method, 404]);
    expect(reasonOf(answer)).toContain("no Plan");
  }
});

conformance("plans", "a Plan delete removes the library file and the Plan is gone from reads and the list", async (t) => {
  const { world, server } = await plansPool(t);
  await server.http.put("/api/plans/mine", smallPlan());
  expect(existsSync(planFile(world, "mine"))).toBe(true);

  const removed = await server.http.call("DELETE", "/api/plans/mine");

  expect(removed.status, removed.text).toBe(200);
  expect(removed.json<Record<string, never>>()).toEqual({});
  expect(existsSync(planFile(world, "mine"))).toBe(false);
  expect((await server.http.get("/api/plans/mine")).status).toBe(404);
  expect((await listed(server)).filter((p) => !p.preset)).toEqual([]);
});

conformance("plans", "a POST to a Plan's slug is an unknown route, as any other is, and writes nothing", async (t) => {
  const { world, server } = await plansPool(t);
  const unknown = await server.http.post("/api/no-such-route", smallPlan());

  const answer = await server.http.post("/api/plans/mine", smallPlan());

  expect(answer.status).toBe(unknown.status);
  expect(answer.status).not.toBe(200);
  expect(existsSync(planFile(world, "mine"))).toBe(false);
});

conformance("plans", "the socket's plans verbs save, read, list and delete the same library, and refuse as the routes do", async (t) => {
  const { world, server, socket } = await plansPool(t);

  const saved = await socket.request("plans.save", { slug: "mine", plan: smallPlan("Mine") });
  if (!saved.ok) throw new Error(`plans.save was refused: ${JSON.stringify(saved.refusal)}`);
  expect(saved.result.slug).toBe("mine");
  expect(JSON.parse(readFileSync(planFile(world, "mine"), "utf8"))).toEqual(saved.result.plan);
  expect(readdirSync(plansDir(world))).toEqual(["mine.json"]);

  const read = await socket.request("plans.get", { slug: "mine" });
  expect(read.ok && read.result).toEqual({ slug: "mine", preset: false, plan: saved.result.plan, problems: [] });
  const list = await socket.request("plans.list", {});
  expect(list.ok && list.result.plans.filter((p) => !p.preset).map((p) => p.slug)).toEqual(["mine"]);
  expect((await server.http.get("/api/plans/mine")).json<PlanResponse>().plan).toEqual(saved.result.plan);

  const refusals = [
    await socket.request("plans.get", { slug: "nobody" }),
    await socket.request("plans.save", { slug: "factory-today", plan: smallPlan() }),
    await socket.request("plans.save", { slug: "other", plan: brokenPlan() }),
    await socket.request("plans.save", { slug: "BAD", plan: smallPlan() }),
    await socket.request("plans.delete", { slug: "factory-today" }),
  ].map((reply) => (reply.ok ? null : { status: reply.refusal.status, reason: reply.refusal.reason }));
  expect(refusals.map((r) => r?.status)).toEqual([404, 409, 400, 400, 409]);
  expect(refusals.map((r) => r?.reason)).toEqual([
    expect.stringContaining("no Plan"),
    expect.stringContaining("is a Preset"),
    expect.stringContaining("the Plan is invalid"),
    expect.stringContaining("is not a Plan slug"),
    expect.stringContaining("is a Preset"),
  ]);
  expect(readdirSync(plansDir(world))).toEqual(["mine.json"]);

  const removed = await socket.request("plans.delete", { slug: "mine" });
  expect(removed.ok && removed.result).toEqual({});
  expect(existsSync(planFile(world, "mine"))).toBe(false);
  expect((await server.http.get("/api/plans/mine")).status).toBe(404);
});
