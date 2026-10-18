/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { PlanFile, PlanProblem } from "../../protocol/wire.ts";
import {
  CARD_H,
  CARD_W,
  edgeDomKey,
  edgeRoute,
  fitView,
  freeSpot,
  hitNode,
  projectPlan,
} from "./plan-projection";

const plan: PlanFile = {
  horde: 1,
  name: "Two steps",
  nodes: [
    { kind: "agent", id: "build", title: "Build", x: 40, y: 60 },
    { kind: "prove", id: "prove", title: "Prove", x: 340, y: 60 },
    { kind: "finish", id: "finish", title: "Finish", x: 640, y: 60 },
  ],
  edges: [
    { from: "build", on: "done", to: "prove" },
    { from: "prove", on: "pass", to: "finish" },
    { from: "prove", on: "fail", to: "build", cap: { max: 2, stewardExtra: true } },
  ],
};

const verdicts = new Map([
  ["build", ["done", "closed"]],
  ["prove", ["pass", "fail", "closed"]],
  ["finish", ["revise"]],
]);

const draw = (problems: PlanProblem[] = [], places = new Map<string, { x: number; y: number }>()) =>
  projectPlan({ plan, problems, verdicts, places });

describe("projectPlan", () => {
  it("draws one port per verdict, open where no edge leaves on it", () => {
    const prove = draw().nodes.find((n) => n.node.id === "prove")!;
    expect(prove.ports.map((p) => [p.on, p.linked])).toEqual([
      ["pass", true],
      ["fail", true],
      ["closed", false],
    ]);
    for (const port of prove.ports) {
      expect(port.at.y).toBe(60 + CARD_H);
      expect(port.at.x).toBeGreaterThan(340);
      expect(port.at.x).toBeLessThan(340 + CARD_W);
    }
    const xs = prove.ports.map((p) => p.at.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("keys each edge from.on>to and labels a capped loop with its max and the Steward's pass", () => {
    const edges = draw().edges;
    expect(edges.map((e) => e.key)).toEqual(["build.done>prove", "prove.pass>finish", "prove.fail>build"]);
    expect(edges.map((e) => e.label)).toEqual(["done", "pass", "fail · 2 · S"]);
    expect(edges.map((e) => e.route.back)).toEqual([false, false, true]);
  });

  it("numbers a duplicate edge apart for the DOM, so both are drawn, and keeps its key the edge's text", () => {
    const twice = { ...plan, edges: [...plan.edges, plan.edges[0]!] };
    const edges = projectPlan({ plan: twice, problems: [], verdicts, places: new Map() }).edges;
    expect(edges.slice(-1)[0]!.key).toBe("build.done>prove");
    expect(edges.map(edgeDomKey)).toContain("build.done>prove#1");
  });

  it("puts each problem on its node or edge, and the rest on the Plan", () => {
    const drawing = draw([
      { at: { kind: "node", id: "build" }, message: "no skill" },
      { at: { kind: "edge", from: "prove", on: "fail", to: "build" }, message: "loop too long" },
      { at: { kind: "edge", from: "ghost", on: "done", to: "prove" }, message: "names no node" },
      { at: { kind: "node", id: "gone" }, message: "unknown node" },
      { at: { kind: "plan" }, message: "no name" },
    ]);
    expect(drawing.nodes.find((n) => n.node.id === "build")!.problems).toEqual(["no skill"]);
    expect(drawing.edges.find((e) => e.key === "prove.fail>build")!.problems).toEqual(["loop too long"]);
    expect(drawing.planProblems).toEqual(["names no node", "unknown node", "no name"]);
  });

  it("draws a held place over the document's, and routes its edges from there", () => {
    const moved = draw([], new Map([["prove", { x: 400, y: 300 }]]));
    expect(moved.nodes.find((n) => n.node.id === "prove")!.at).toEqual({ x: 400, y: 300 });
    expect(moved.edges[0]!.route.d).not.toBe(draw().edges[0]!.route.d);
  });

  it("drops an edge into a card right below its source straight down", () => {
    const route = edgeRoute({ x: 0, y: 0 }, { x: 50, y: CARD_H }, { x: 0, y: 250 });
    expect(route.back).toBe(false);
    expect(route.d.endsWith(`${CARD_W / 2} 250`)).toBe(true);
  });
});

describe("hitNode", () => {
  const nodes = draw().nodes;
  it("finds the card under a world point and nothing over blank", () => {
    expect(hitNode(nodes, { x: 350, y: 70 })).toBe("prove");
    expect(hitNode(nodes, { x: 300, y: 70 })).toBeNull();
  });
  it("picks the card drawn last where two overlap", () => {
    const over = [...nodes, { node: { ...plan.nodes[0]!, id: "top" }, at: { x: 360, y: 80 } }];
    expect(hitNode(over, { x: 380, y: 90 })).toBe("top");
  });
});

describe("freeSpot", () => {
  it("centres a new card on the point when it is clear", () => {
    expect(freeSpot([], { x: 500, y: 500 })).toEqual({ x: 500 - CARD_W / 2, y: 500 - CARD_H / 2 });
  });
  it("moves off a card already there", () => {
    const nodes = draw().nodes;
    const spot = freeSpot(nodes, { x: 340 + CARD_W / 2, y: 60 + CARD_H / 2 });
    expect(hitNode(nodes, spot)).toBeNull();
    expect(hitNode(nodes, { x: spot.x + CARD_W, y: spot.y + CARD_H })).toBeNull();
  });
});

describe("fitView", () => {
  it("frames a small Plan whole, never past zoom 1", () => {
    const view = fitView(draw().nodes, { w: 2000, h: 1000 });
    expect(view.zoom).toBe(1);
    expect(view.x + 40 * view.zoom).toBeGreaterThan(0);
    expect(view.x + (640 + CARD_W) * view.zoom).toBeLessThan(2000);
  });
  it("starts a Plan too wide to read whole at its left end", () => {
    const view = fitView(draw().nodes, { w: 300, h: 600 });
    expect(view.zoom).toBe(0.5);
    expect(view.x + 40 * view.zoom).toBeGreaterThan(0);
  });
});
