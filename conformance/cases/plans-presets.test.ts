/**
 * The Presets the server ships, seen from outside it (ADR-0036): the eleven
 * Plans `plans.list` offers before the library's, each with the author and
 * source file it comes from, each a Plan the validator accepts, and Factory
 * today as ADR-0037's fixed Line, edge for edge.
 *
 * Origin: docs/specs/build-your-own-factory.md (last tracked at 5182816), Slices item 3 ("New
 * `plans-presets` (each validates and has `author` and `source`)") and
 * "Presets", whose table gives each slug's author and source and whose list
 * gives Factory today's twelve edges.
 */

import { expect } from "bun:test";
import type { PlanEdgeFile, PlanFile, PlanResponse, PlanSummary, PlansListResponse } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { plansPool } from "./plans-support.ts";

/** The spec's Presets table, in its order. */
const PRESETS: [slug: string, author: string, source: string][] = [
  ["factory-today", "Agent Console", "docs/adr/0040-the-factory-runs-a-plan-the-operator-builds.md"],
  ["matt-pocock-main", "Matt Pocock", "skills/engineering/ask-matt/SKILL.md"],
  ["matt-pocock-quick", "Matt Pocock", "skills/engineering/implement/SKILL.md"],
  ["matt-pocock-bug", "Matt Pocock", "skills/engineering/diagnosing-bugs/SKILL.md"],
  ["matt-pocock-foggy", "Matt Pocock", "skills/engineering/wayfinder/SKILL.md"],
  ["pstack-feature", "Pstack (Lauren Tan)", "skills/pstack/pstack-poteto-mode/playbooks/feature.md"],
  ["pstack-bug-fix", "Pstack (Lauren Tan)", "skills/pstack/pstack-poteto-mode/playbooks/bug-fix.md"],
  ["pclaude-feature", "PClaude", "skills/pclaude/pclaude-poteto-mode/playbooks/feature.md"],
  ["pclaude-bug-fix", "PClaude", "skills/pclaude/pclaude-poteto-mode/playbooks/bug-fix.md"],
  ["addy-commands", "Addy Osmani", "skills/addy/addy-using-agent-skills/SKILL.md"],
  ["addy-bug-fix", "Addy Osmani", "skills/addy/addy-using-agent-skills/SKILL.md"],
];

/** An edge with its cap's defaults written out, so a file that spells them and one that omits them compare equal. */
function normalised(e: PlanEdgeFile): PlanEdgeFile {
  return {
    from: e.from,
    on: e.on,
    to: e.to,
    ...(e.cap ? { cap: { max: e.cap.max, stewardExtra: e.cap.stewardExtra ?? false, whenSpent: e.cap.whenSpent ?? "hold" } } : {}),
  };
}

const byKey = (a: { from: string; on: string; to: string }, b: { from: string; on: string; to: string }) =>
  `${a.from}.${a.on}.${a.to}`.localeCompare(`${b.from}.${b.on}.${b.to}`);

conformance("plans", "plans.list holds the eleven Presets in the spec's order, each with its author and source and no problems", async (t) => {
  const { server, socket } = await plansPool(t);

  const http = await server.http.get("/api/plans");
  expect(http.status, http.text).toBe(200);
  const reply = await socket.request("plans.list", {});
  if (!reply.ok) throw new Error(`plans.list was refused: ${JSON.stringify(reply.refusal)}`);

  expect(reply.result).toEqual(http.json<PlansListResponse>());
  const presets: PlanSummary[] = reply.result.plans.filter((p) => p.preset);
  expect(presets.map((p) => p.slug)).toEqual(PRESETS.map(([slug]) => slug));
  expect(reply.result.plans.slice(0, presets.length)).toEqual(presets);
  expect(presets.map((p) => [p.slug, p.author, p.source, p.problems])).toEqual(PRESETS.map(([slug, author, source]) => [slug, author, source, []]));
  for (const preset of presets) expect(preset.name, preset.slug).not.toBe("");
});

conformance("plans", "every Preset's file validates with no problems", async (t) => {
  const { server } = await plansPool(t);

  for (const [slug, author, source] of PRESETS) {
    const read = await server.http.get(`/api/plans/${slug}`);
    expect([slug, read.status]).toEqual([slug, 200]);
    const body = read.json<PlanResponse>();
    expect([body.slug, body.preset, body.plan.author, body.plan.source, body.problems]).toEqual([slug, true, author, source, []]);

    const checked = await server.http.post("/api/plans/validate", { plan: body.plan });
    expect([slug, checked.status, checked.json()]).toEqual([slug, 200, { problems: [] }]);
  }
});

conformance("plans", "Factory today is ADR-0037's fixed Line: a Grill, four one-copy Ticket nodes on the Steward, and the spec's twelve edges", async (t) => {
  const { server } = await plansPool(t);

  const read = await server.http.get("/api/plans/factory-today");
  const plan: PlanFile = read.json<PlanResponse>().plan;

  expect(plan.nodes.map((n) => [n.kind, n.id])).toEqual([
    ["conversation", "grill"],
    ["agent", "implement"],
    ["prove", "prove"],
    ["review", "review"],
    ["decide", "decide"],
    ["finish", "finish"],
  ]);
  for (const n of plan.nodes) {
    if (n.kind === "agent" || n.kind === "prove" || n.kind === "review" || n.kind === "decide") {
      expect([n.id, n.copies ?? "one", n.checkpoint]).toEqual([n.id, "one", "steward"]);
    }
    if (n.kind === "finish") expect(n.act ?? "none").toBe("none");
  }
  const edges: PlanEdgeFile[] = [
    { from: "grill", on: "done", to: "implement" },
    { from: "implement", on: "done", to: "prove" },
    { from: "prove", on: "pass", to: "review" },
    { from: "prove", on: "fail", to: "implement", cap: { max: 2, stewardExtra: true, whenSpent: "hold" } },
    { from: "review", on: "clean", to: "decide" },
    { from: "review", on: "findings", to: "decide" },
    { from: "decide", on: "ship", to: "finish" },
    { from: "decide", on: "another-round", to: "implement", cap: { max: 1, stewardExtra: false, whenSpent: { to: "finish" } } },
    { from: "finish", on: "revise", to: "implement" },
    { from: "implement", on: "closed", to: "decide" },
    { from: "prove", on: "closed", to: "decide" },
    { from: "review", on: "closed", to: "decide" },
  ];
  expect(plan.edges.map(normalised).sort(byKey)).toEqual(edges.sort(byKey));
});
