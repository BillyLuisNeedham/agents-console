/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { PlanFile, PlanNodeKind } from "../../protocol/wire.ts";
import { commit } from "./morph";
import { PlanCanvas, type PlanCanvasModel, type PlanSelection } from "./plan-canvas";
import type { EdgeKey } from "./plan-projection";
import type { Point } from "./geometry";
import { useDom } from "./test-dom";

useDom();

const plan: PlanFile = {
  horde: 1,
  name: "Two steps",
  nodes: [
    { kind: "agent", id: "build", title: "Build", x: 40, y: 60 },
    { kind: "finish", id: "finish", title: "Finish", x: 640, y: 60 },
  ],
  edges: [{ from: "build", on: "done", to: "finish" }],
};

function setup(editable = true) {
  const seen: { select: PlanSelection[]; move: [string, Point][]; link: EdgeKey[]; add: [PlanNodeKind, Point][] } = {
    select: [],
    move: [],
    link: [],
    add: [],
  };
  const canvas = new PlanCanvas({
    select: (s) => seen.select.push(s),
    move: (id, at) => seen.move.push([id, at]),
    link: (key) => seen.link.push(key),
    add: (kind, at) => seen.add.push([kind, at]),
    remove: () => {},
  });
  const model: PlanCanvasModel = {
    docKey: "1",
    plan,
    problems: [],
    verdicts: new Map([
      ["build", ["done", "closed"]],
      ["finish", ["revise"]],
    ]),
    moved: new Map(),
    selection: null,
    editable,
  };
  const root = document.createElement("div");
  const draw = () => {
    commit(root, () => canvas.render(model));
    canvas.bind(root.querySelector<HTMLElement>(".plan-viewport")!);
  };
  draw();
  const viewport = () => root.querySelector<HTMLElement>(".plan-viewport")!;
  // Before a fit the view is panned by (24, 24) at zoom 1, and happy-dom
  // lays nothing out, so a client point is its world point plus 24.
  const pointer = (type: string, target: Element, world: Point) =>
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: world.x + 24, clientY: world.y + 24 }),
    );
  return { canvas, root, draw, viewport, pointer, seen };
}

describe("PlanCanvas", () => {
  it("keeps each card's node across renders, keyed by its id", () => {
    const t = setup();
    const card = t.root.querySelector('[data-key="plan-node:build"]');
    t.draw();
    expect(t.root.querySelector('[data-key="plan-node:build"]')).toBe(card);
    expect(t.root.querySelectorAll(".plan-node")).toHaveLength(2);
  });

  it("links a verdict port dragged onto a card, and sends nothing for a drop on blank", () => {
    const t = setup();
    const port = t.root.querySelector('.plan-port[data-on="closed"]')!;
    t.pointer("pointerdown", port, { x: 200, y: 180 });
    t.pointer("pointermove", t.viewport(), { x: 400, y: 120 });
    t.pointer("pointerup", t.viewport(), { x: 700, y: 100 });
    expect(t.seen.link).toEqual([{ from: "build", on: "closed", to: "finish" }]);
    t.pointer("pointerdown", t.root.querySelector('.plan-port[data-on="done"]')!, { x: 100, y: 180 });
    t.pointer("pointermove", t.viewport(), { x: 400, y: 500 });
    t.pointer("pointerup", t.viewport(), { x: 400, y: 500 });
    expect(t.seen.link).toHaveLength(1);
  });

  it("moves a dragged card by the pointer's travel, and selects a card only tapped", () => {
    const t = setup();
    const head = t.root.querySelector('.plan-node[data-node="build"] .plan-node-head')!;
    t.pointer("pointerdown", head, { x: 50, y: 70 });
    t.pointer("pointermove", t.viewport(), { x: 80, y: 90 });
    t.draw();
    expect(t.root.querySelector<HTMLElement>('.plan-node[data-node="build"]')!.style.left).toBe("70px");
    t.pointer("pointerup", t.viewport(), { x: 80, y: 90 });
    expect(t.seen.move).toEqual([["build", { x: 70, y: 80 }]]);
    t.pointer("pointerdown", head, { x: 50, y: 70 });
    t.pointer("pointerup", t.viewport(), { x: 51, y: 70 });
    expect(t.seen.select).toEqual([{ kind: "node", id: "build" }]);
  });

  it("selects an edge from its label and clears the selection on blank", () => {
    const t = setup();
    const label = t.root.querySelector('[data-edge="build.done>finish"]')!;
    t.pointer("pointerdown", label, { x: 400, y: 200 });
    t.pointer("pointerup", t.viewport(), { x: 400, y: 200 });
    t.pointer("pointerdown", t.viewport(), { x: 400, y: 500 });
    t.pointer("pointerup", t.viewport(), { x: 400, y: 500 });
    expect(t.seen.select).toEqual([{ kind: "edge", key: { from: "build", on: "done", to: "finish" } }, null]);
  });

  it("moves no card and offers no shelf on a Plan core cannot edit", () => {
    const t = setup(false);
    const head = t.root.querySelector('.plan-node[data-node="build"] .plan-node-head')!;
    t.pointer("pointerdown", head, { x: 50, y: 70 });
    t.pointer("pointermove", t.viewport(), { x: 120, y: 90 });
    t.pointer("pointerup", t.viewport(), { x: 120, y: 90 });
    expect(t.seen.move).toEqual([]);
    expect(t.root.querySelector(".plan-shelf-add")).toBeNull();
  });
});
