/**
 * What `plans.validate` says of a draft Plan, seen from outside the server
 * (ADR-0036): every rule of the Plan format refuses with the node or edge it
 * is about and a word that says why, every problem comes back at once, and
 * a Plan that follows the rules comes back with none. Each rule is one case,
 * asked over `POST /api/plans/validate` and on the socket's `plans.validate`,
 * whose answers must be the same.
 *
 * Origin: docs/specs/build-your-own-factory.md, Slices item 3 ("New
 * `plans-validate`: each rule refuses with its node or edge, all problems
 * together, an uncapped cycle through an operator gate accepted") and the
 * rules listed under "The Plan". The words pinned are the keywords the core
 * was told to use, so a message may say more but never less. Where a rule's
 * problem could sit on either of two edges of a cycle, both are accepted.
 */

import { expect } from "bun:test";
import type { PlanFile } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import {
  atEdge,
  atNode,
  atPlan,
  edge,
  expectProblem,
  node,
  plan,
  plansPool,
  richPlan,
  smallPlan,
  validateBoth,
  type Expected,
} from "./plans-support.ts";

interface Rule {
  name: string;
  draft: PlanFile;
  expected: Expected;
}

/** Three Agent nodes, `a` and `b` reached only through `start`, for the cycle rules. */
function cyclePlan(back: Parameters<typeof edge>[3]): PlanFile {
  return plan(
    [node.agent("start"), node.agent("a"), node.agent("b"), node.finish()],
    [edge("start", "done", "a"), edge("a", "done", "b"), edge("b", "done", "a", back)],
  );
}

const PER_ITEM = { copies: { perItem: 2 } } as const;

const RULES: Rule[] = [
  // Ids.
  {
    name: "a node id that does not match the id shape is reported on the node",
    draft: plan([node.agent("Bad_Id"), node.finish()], [edge("Bad_Id", "done", "finish")]),
    expected: { at: atNode("Bad_Id"), keyword: "id" },
  },
  {
    name: "a node id ending in a dash and digits is reported on the node",
    draft: plan([node.agent("build-2"), node.finish()], [edge("build-2", "done", "finish")]),
    expected: { at: atNode("build-2"), keyword: "id" },
  },
  {
    name: "a reserved node id is reported on the node",
    draft: plan([node.agent("grader"), node.finish()], [edge("grader", "done", "finish")]),
    expected: { at: atNode("grader"), keyword: "id" },
  },
  {
    name: "a node id used twice is reported on the node",
    draft: plan([node.agent("build"), node.agent("build"), node.finish()], [edge("build", "done", "finish")]),
    expected: { at: atNode("build"), keyword: "twice" },
  },

  // Edges.
  {
    name: "an edge to a node the Plan lacks is reported on the edge",
    draft: plan(
      [node.agent("build"), node.finish()],
      [edge("build", "done", "finish"), edge("build", "closed", "ghost")],
    ),
    expected: { at: atEdge("build", "closed", "ghost"), keyword: "no node" },
  },
  {
    name: "an edge on a verdict an Agent node does not hand on is reported on the edge",
    draft: plan([node.agent("build"), node.finish()], [edge("build", "pass", "finish")]),
    expected: { at: atEdge("build", "pass", "finish"), keyword: "not a verdict" },
  },
  {
    name: "an edge on a verdict a Prove node does not hand on is reported on the edge",
    draft: plan([node.prove("check"), node.finish()], [edge("check", "done", "finish")]),
    expected: { at: atEdge("check", "done", "finish"), keyword: "not a verdict" },
  },
  {
    name: "an edge on a word that is no verdict at all is reported on the edge",
    draft: plan([node.agent("build"), node.finish()], [edge("build", "done", "finish"), edge("build", "sideways", "finish")]),
    expected: { at: atEdge("build", "sideways", "finish"), keyword: "not a verdict" },
  },
  {
    name: "an edge on revise from an auto Gate is reported on the edge, which hands on open alone",
    draft: plan(
      [node.agent("build"), node.gate("pass-on", "auto"), node.finish()],
      [edge("build", "done", "pass-on"), edge("pass-on", "open", "finish"), edge("pass-on", "revise", "finish")],
    ),
    expected: { at: atEdge("pass-on", "revise", "finish"), keyword: "not a verdict" },
  },
  {
    name: "an edge leaving the Finish on anything but revise is reported on the edge",
    draft: plan(
      [node.agent("build"), node.finish()],
      [edge("build", "done", "finish"), edge("finish", "done", "build")],
    ),
    expected: { at: atEdge("finish", "done", "build"), keyword: "not a verdict" },
  },
  {
    name: "the same edge twice is reported on the edge",
    draft: plan([node.agent("build"), node.finish()], [edge("build", "done", "finish"), edge("build", "done", "finish")]),
    expected: { at: atEdge("build", "done", "finish"), keyword: "twice" },
  },

  // The Plan's shape.
  {
    name: "a Plan with no Finish is reported on the Plan",
    draft: plan([node.agent("build")], []),
    expected: { at: atPlan, keyword: "one Finish" },
  },
  {
    name: "a Plan with two Finishes is reported on the second",
    draft: plan(
      [node.agent("build"), node.finish("finish"), node.finish("also-finish")],
      [edge("build", "done", "finish")],
    ),
    expected: { at: atNode("also-finish"), keyword: "one Finish" },
  },
  {
    name: "a Plan with no entry is reported on the Plan",
    draft: plan([node.finish()], []),
    expected: { at: atPlan, keyword: "no entry" },
  },
  {
    name: "a node only a cycle with no entry leads to is reported as never reached",
    draft: plan(
      [node.agent("build"), node.agent("x"), node.agent("y"), node.finish()],
      [edge("build", "done", "finish"), edge("x", "done", "y"), edge("y", "done", "x")],
    ),
    expected: { at: atNode("x"), keyword: "reached" },
  },
  {
    name: "a node that cannot reach the Finish is reported on the node",
    draft: plan(
      [node.agent("build"), node.gate("dead-end", "auto"), node.finish()],
      [edge("build", "done", "dead-end"), edge("build", "closed", "finish")],
    ),
    expected: { at: atNode("dead-end"), keyword: "cannot reach the Finish" },
  },

  // Mergers.
  {
    name: "a Merger of a node that is not per-item is reported on the Merger",
    draft: plan(
      [node.agent("build"), node.merger("merge", "build"), node.finish()],
      [edge("build", "done", "merge"), edge("merge", "done", "finish")],
    ),
    expected: { at: atNode("merge"), keyword: "per-item" },
  },
  {
    name: "a second Merger for one node is reported on the second Merger",
    draft: plan(
      [node.agent("build", PER_ITEM), node.merger("merge-one", "build"), node.merger("merge-two", "build"), node.finish()],
      [edge("build", "done", "merge-one"), edge("merge-one", "done", "finish"), edge("merge-two", "done", "finish")],
    ),
    expected: { at: atNode("merge-two"), keyword: "already has a Merger" },
  },
  {
    name: "an out-edge of a node with a Merger that goes elsewhere is reported on the edge",
    draft: plan(
      [node.agent("build", PER_ITEM), node.merger("merge", "build"), node.finish()],
      [edge("build", "done", "merge"), edge("build", "closed", "finish"), edge("merge", "done", "finish")],
    ),
    expected: { at: atEdge("build", "closed", "finish"), keyword: "must go to its Merger" },
  },
  {
    name: "an edge into a Merger from a node that is not its own is reported on the edge",
    draft: plan(
      [node.agent("build", PER_ITEM), node.agent("other"), node.merger("merge", "build"), node.finish()],
      [
        edge("build", "done", "merge"),
        edge("other", "done", "merge"),
        edge("merge", "done", "finish"),
      ],
    ),
    expected: { at: atEdge("other", "done", "merge"), keyword: "only" },
  },

  // Loops.
  {
    name: "an uncapped cycle with no person on it is reported on an edge of the cycle",
    draft: cyclePlan(undefined),
    expected: { at: [atEdge("b", "done", "a"), atEdge("a", "done", "b")], keyword: "cycle" },
  },
  {
    name: "a cap on an edge that closes no cycle is reported on the edge",
    draft: plan([node.agent("build"), node.finish()], [edge("build", "done", "finish", { max: 2 })]),
    expected: { at: atEdge("build", "done", "finish"), keyword: "closes no cycle" },
  },
  {
    name: "a cap whose max is 0 is reported on the edge",
    draft: cyclePlan({ max: 0 }),
    expected: { at: atEdge("b", "done", "a"), keyword: "at least 1" },
  },
];

for (const rule of RULES) {
  conformance("plans", `Plan validation › ${rule.name}`, async (t) => {
    const { server, socket } = await plansPool(t);

    expectProblem(await validateBoth(server, socket, rule.draft), rule.expected);
  });
}

for (const word of ["rest", "continue"]) {
  conformance("plans", `Plan validation › a checkpoint of "${word}" is reported on the node, naming the field: the engine never answers a checkpoint by itself`, async (t) => {
    const { server, socket } = await plansPool(t);
    const draft = plan([node.agent("build", { checkpoint: word } as never), node.finish()], [edge("build", "done", "finish")]);

    const problems = await validateBoth(server, socket, draft);

    expectProblem(problems, { at: atNode("build"), keyword: "`checkpoint`" });
    expectProblem(problems, { at: atNode("build"), keyword: "never answers a checkpoint by itself" });
  });
}

conformance("plans", "Plan validation › a Plan with three different problems reports all three in one answer", async (t) => {
  const { server, socket } = await plansPool(t);
  const draft = plan(
    [node.agent("build"), node.agent("build"), node.finish()],
    [edge("build", "done", "finish"), edge("build", "pass", "finish"), edge("build", "closed", "ghost")],
  );

  const problems = await validateBoth(server, socket, draft);

  expectProblem(problems, { at: atNode("build"), keyword: "twice" });
  expectProblem(problems, { at: atEdge("build", "pass", "finish"), keyword: "not a verdict" });
  expectProblem(problems, { at: atEdge("build", "closed", "ghost"), keyword: "no node" });
});

const ACCEPTED: { name: string; draft: PlanFile }[] = [
  { name: "a valid Plan answers no problems", draft: smallPlan() },
  { name: "a Plan using a Conversation, a per-item node with its Merger, a capped loop and an operator Gate answers no problems", draft: richPlan() },
  {
    name: "an uncapped cycle through an operator Gate's revise is accepted",
    draft: plan(
      [node.agent("work"), node.gate("sign-off", "operator"), node.finish()],
      [edge("work", "done", "sign-off"), edge("sign-off", "open", "finish"), edge("sign-off", "revise", "work")],
    ),
  },
  {
    name: "an uncapped cycle back through an operator Gate's open is accepted",
    draft: plan(
      [node.agent("work"), node.gate("sign-off", "operator"), node.finish()],
      [edge("work", "done", "sign-off"), edge("sign-off", "open", "work"), edge("sign-off", "revise", "finish")],
    ),
  },
  {
    name: "an uncapped cycle through a Steward Gate's revise is accepted",
    draft: plan(
      [node.agent("work"), node.gate("sign-off", "steward"), node.finish()],
      [edge("work", "done", "sign-off"), edge("sign-off", "open", "finish"), edge("sign-off", "revise", "work")],
    ),
  },
  {
    name: "an uncapped cycle through the Finish's revise is accepted",
    draft: plan(
      [node.agent("work"), node.finish()],
      [edge("work", "done", "finish"), edge("finish", "revise", "work")],
    ),
  },
  {
    name: "a node with no edge of its own for closed still reaches the Finish",
    draft: plan([node.agent("build"), node.prove("check"), node.finish()], [edge("build", "done", "check"), edge("check", "pass", "finish")]),
  },
  {
    name: "an Agent node with no out-edge at all still reaches the Finish",
    draft: plan([node.agent("build"), node.finish()], []),
  },
];

for (const { name, draft } of ACCEPTED) {
  conformance("plans", `Plan validation › ${name}`, async (t) => {
    const { server, socket } = await plansPool(t);

    expect(await validateBoth(server, socket, draft)).toEqual([]);
  });
}

conformance("plans", "Plan validation › a body with no plan is refused as 400 with a reason, on both routes", async (t) => {
  const { server, socket } = await plansPool(t);

  const http = await server.http.post("/api/plans/validate", {});
  expect(http.status, http.text).toBe(400);
  expect(typeof http.json<{ reason: unknown }>().reason).toBe("string");

  const reply = await socket.request("plans.validate", {} as never);
  expect(reply.ok).toBe(false);
  if (!reply.ok) expect(reply.refusal).toEqual({ reason: http.json<{ reason: string }>().reason, status: 400 });
});
