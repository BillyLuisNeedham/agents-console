import { expect } from "bun:test";
import { existsSync } from "node:fs";
import type { PlanDraftResponse, PlanFile, PlanNodeFile } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { atNode, edge, editBoth, editRefusedBoth, node, plan, plansDir, plansPool, smallPlan, validateBoth, validateBothAnswers } from "./plans-support.ts";

function feeder(): PlanFile {
  return plan(
    [node.agent("tasks", { makesItems: true }), { ...node.agent("build"), x: 600, y: 60 }, node.finish()],
    [edge("tasks", "done", "build"), edge("build", "done", "finish")],
  );
}

function nodeOf(answer: PlanDraftResponse, id: string): PlanNodeFile {
  const found = answer.plan.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id} in ${JSON.stringify(answer.plan.nodes)}`);
  return found;
}

function edgeKeys(answer: PlanDraftResponse): string[] {
  return answer.plan.edges.map((e) => `${e.from}.${e.on} -> ${e.to}`);
}

conformance("plans", "a node set per-item gains its Merger with a note, and set back to one copy loses it", async (t) => {
  const { server, socket } = await plansPool(t);
  const opened = await editBoth(server, socket, feeder(), []);

  const perItem = await editBoth(server, socket, opened.plan, [
    { edit: "setNode", node: { ...nodeOf(opened, "build"), copies: { perItem: 2 } } as PlanNodeFile },
  ]);

  const merger = nodeOf(perItem, "build-merge");
  expect([merger.kind, merger.x, merger.y]).toEqual(["merger", 600, 310]);
  expect(edgeKeys(perItem)).toEqual(["tasks.done -> build", "build-merge.done -> finish", "build.done -> build-merge"]);
  expect(perItem.notes).toEqual(["`build` is per-item now: placed `build-merge` and moved 1 edge onto it"]);
  expect(perItem.problems).toEqual([]);

  const one = await editBoth(server, socket, perItem.plan, [
    { edit: "setNode", node: { ...nodeOf(perItem, "build"), copies: "one" } as PlanNodeFile },
  ]);

  expect(one.plan.nodes.map((n) => n.id)).toEqual(["tasks", "build", "finish"]);
  expect(edgeKeys(one)).toEqual(["tasks.done -> build", "build.done -> finish"]);
  expect(one.notes).toEqual(["`build` is one copy now: lifted `build-merge` and moved 1 edge back onto it"]);
});

conformance("plans", "a link that closes a cycle with no cap is made a loop capped at 2 that holds when spent, with a note, so the draft has no problem", async (t) => {
  const { server, socket } = await plansPool(t);
  const opened = await editBoth(server, socket, feeder(), []);

  const looped = await editBoth(server, socket, opened.plan, [{ edit: "link", edge: edge("build", "closed", "tasks") }]);

  expect(looped.plan.edges).toContainEqual(edge("build", "closed", "tasks", { max: 2, stewardExtra: false, whenSpent: "hold" }));
  expect(looped.notes).toEqual(["`build.closed -> tasks` closes a cycle, so it is a loop capped at 2 passes that holds when spent"]);
  expect(looped.problems).toEqual([]);
});

conformance("plans", "a link from a node with a Merger is made from the Merger, with a note", async (t) => {
  const { server, socket } = await plansPool(t);
  const opened = await editBoth(server, socket, feeder(), []);
  const perItem = await editBoth(server, socket, opened.plan, [
    { edit: "setNode", node: { ...nodeOf(opened, "build"), copies: { perItem: "all" } } as PlanNodeFile },
  ]);

  const linked = await editBoth(server, socket, perItem.plan, [{ edit: "link", edge: edge("build", "closed", "finish") }]);

  expect(edgeKeys(linked)).toContain("build-merge.closed -> finish");
  expect(edgeKeys(linked)).not.toContain("build.closed -> finish");
  expect(linked.notes).toEqual(["linked from `build-merge`, since `build` hands on through its Merger"]);
});

conformance("plans", "an added node is named by its kind in core, then -b, with its kind's defaults and title", async (t) => {
  const { server, socket } = await plansPool(t);

  const added = await editBoth(server, socket, smallPlan(), [
    { edit: "addNode", kind: "agent", x: 40, y: 400 },
    { edit: "addNode", kind: "agent", x: 340, y: 400 },
    { edit: "addNode", kind: "gate", x: 640, y: 400 },
  ]);

  expect(added.plan.nodes.map((n) => n.id)).toEqual(["build", "finish", "agent", "agent-b", "gate"]);
  expect(nodeOf(added, "agent-b")).toEqual({
    kind: "agent",
    id: "agent-b",
    title: "Agent",
    x: 340,
    y: 400,
    copies: "one",
    makesItems: false,
    checkpoint: "operator",
    spawns: "hold",
  });
  expect(nodeOf(added, "gate")).toEqual({ kind: "gate", id: "gate", title: "Gate", x: 640, y: 400, open: "operator", join: "any" });
  expect(added.notes).toEqual([]);
});

conformance("plans", "a draft's problems are the ones plans.validate gives it, and its verdicts are each node's", async (t) => {
  const { server, socket } = await plansPool(t);

  const answer = await editBoth(server, socket, smallPlan(), [
    { edit: "addNode", kind: "finish", x: 0, y: 300 },
    { edit: "addNode", kind: "prove", x: 300, y: 300 },
    { edit: "link", edge: edge("prove", "pass", "nowhere") },
  ]);

  expect(answer.problems.length).toBeGreaterThan(0);
  expect(answer.problems.some((p) => JSON.stringify(p.at) === JSON.stringify(atNode("finish-b")))).toBe(true);
  expect(answer.problems).toEqual(await validateBoth(server, socket, answer.plan));
  expect(answer.verdicts).toEqual([
    { id: "build", verdicts: ["done", "closed"] },
    { id: "finish", verdicts: ["revise"] },
    { id: "finish-b", verdicts: ["revise"] },
    { id: "prove", verdicts: ["pass", "fail", "closed"] },
  ]);
});

conformance("plans", "a batch with an edit that misses is refused whole, naming what it missed", async (t) => {
  const { server, socket } = await plansPool(t);
  const draft = smallPlan();

  const reason = await editRefusedBoth(server, socket, draft, [
    { edit: "move", id: "build", x: 999, y: 999 },
    { edit: "removeNode", id: "nope" },
  ]);

  expect(reason).toContain("nope");
  const unmoved = await editBoth(server, socket, draft, []);
  expect([unmoved.plan.nodes[0]!.x, unmoved.plan.nodes[0]!.y]).toEqual([draft.nodes[0]!.x, draft.nodes[0]!.y]);
});

conformance("plans", "an edit never changes a node's kind", async (t) => {
  const { server, socket } = await plansPool(t);
  const opened = await editBoth(server, socket, smallPlan(), []);

  const reason = await editRefusedBoth(server, socket, opened.plan, [
    { edit: "setNode", node: { ...nodeOf(opened, "build"), kind: "prove" } as PlanNodeFile },
  ]);

  expect(reason).toContain("never changes a node's kind");
});

conformance("plans", "a draft the edits would drop or rewrite is refused, though it still validates with its problems", async (t) => {
  const { server, socket } = await plansPool(t);
  const coloured = plan([{ ...node.agent("x"), colour: "red" } as unknown as PlanNodeFile, node.finish()], [edge("x", "done", "finish")]);
  const unknownVerdict = plan([node.agent("x"), node.finish()], [edge("x", "maybe", "finish")]);

  expect(await editRefusedBoth(server, socket, coloured, [])).toContain("colour");
  expect(await editRefusedBoth(server, socket, unknownVerdict, [])).toContain("maybe");
  expect(await editRefusedBoth(server, socket, {}, [])).not.toBe("");

  const problems = await validateBoth(server, socket, coloured);
  expect(problems.some((p) => JSON.stringify(p.at) === JSON.stringify(atNode("x")))).toBe(true);
});

conformance("plans", "an edit that cannot be read is refused: a verdict that is no word, a bad edit name", async (t) => {
  const { server, socket } = await plansPool(t);

  expect(await editRefusedBoth(server, socket, smallPlan(), [{ edit: "link", edge: edge("build", "maybe", "finish") }])).toContain("maybe");
  const http = await server.http.post("/api/plans/edit", { plan: smallPlan(), edits: [{ edit: "rename", id: "build" }] });
  expect(http.status, http.text).toBe(400);
});

conformance("plans", "plans.edit writes nothing to the Plan library", async (t) => {
  const { world, server, socket } = await plansPool(t);

  await editBoth(server, socket, smallPlan(), [{ edit: "addNode", kind: "review", x: 0, y: 0 }]);
  await editRefusedBoth(server, socket, smallPlan(), [{ edit: "removeNode", id: "nope" }]);

  expect(existsSync(plansDir(world))).toBe(false);
});

conformance("plans", "a draft's warnings are the ones plans.validate gives it, and an edit that names a missing skill brings one", async (t) => {
  const { server, socket } = await plansPool(t);
  const opened = await editBoth(server, socket, smallPlan(), []);
  expect(opened.warnings ?? []).toEqual([]);

  const named = await editBoth(server, socket, opened.plan, [
    { edit: "setNode", node: { ...nodeOf(opened, "build"), skill: "addy-spec" } as PlanNodeFile },
  ]);

  expect(named.problems).toEqual([]);
  expect(named.warnings).toHaveLength(1);
  expect(named.warnings![0]!.at).toEqual(atNode("build"));
  expect(named.warnings![0]!.message).toContain("not installed");
  expect(named.warnings).toEqual((await validateBothAnswers(server, socket, named.plan)).warnings);
});
