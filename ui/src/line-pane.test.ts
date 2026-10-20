/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { LineGraphView, LinePlanEditResponse, PlanEditFile, PlanFile } from "../../protocol/wire.ts";
import { h } from "./dom";
import { LinePane } from "./line-pane";
import { projectLine, type LineLive } from "./line-projection";
import { commit } from "./morph";
import { setOrClearField } from "./plan-inspector";
import { useDom } from "./test-dom";

useDom();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** build -> test -> finish, with test's fail parked: no edge takes it. */
const PLAN: PlanFile = {
  horde: 1,
  name: "Tested",
  nodes: [
    { kind: "agent", id: "build", title: "Build", x: 40, y: 60 },
    { kind: "prove", id: "test", title: "Test", x: 340, y: 60 },
    { kind: "finish", id: "finish", title: "Finish", x: 640, y: 60 },
  ],
  edges: [
    { from: "build", on: "done", to: "test" },
    { from: "test", on: "pass", to: "finish" },
  ],
};

function graph(rev: number, plan: PlanFile = PLAN, parked = ["fail"]): LineGraphView {
  const view = (id: string, verdicts: string[], extra = {}) => ({
    id,
    verdicts,
    passes: 1,
    tickets: [],
    queued: 0,
    inbox: 0,
    parked: [],
    arrived: [],
    ...extra,
  });
  return {
    plan,
    rev,
    status: "running",
    waitingFor: [],
    nodes: [
      view("build", ["done"], { tickets: ["build-1"] }),
      view("test", ["pass", "fail"], { parked }),
      view("finish", [], { passes: 0 }),
    ],
    edges: [],
  };
}

const at = (g: LineGraphView): LineLive => projectLine(g, [{ id: "build-1", status: "done" }], [], [], null);

function setup(rev = 3) {
  const sent: { baseRev: number; edits: PlanEditFile[]; d: Deferred<LinePlanEditResponse> }[] = [];
  const savedAs: PlanFile[] = [];
  const opened: string[] = [];
  const root = document.createElement("div");
  let live: LineLive | null = at(graph(rev));
  const pane: LinePane = new LinePane({
    onChange: () => draw(),
    onOpenCard: (card) => opened.push(card),
    onEditLine: (baseRev, edits) => {
      const d = deferred<LinePlanEditResponse>();
      sent.push({ baseRev, edits, d });
      return d.promise;
    },
    onSaveAs: (plan) => savedAs.push(plan),
  });
  const draw = () => commit(root, () => h("div", {}, pane.render(live)));
  const push = (next: LineLive | null) => {
    live = next;
    draw();
  };
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  pane.open();
  return { pane, root, $, sent, savedAs, opened, push };
}

const left = (t: ReturnType<typeof setup>, id: string) => t.$<HTMLElement>(`.plan-node[data-node="${id}"]`)!.style.left;
const LINK: PlanEditFile = { edit: "link", edge: { from: "test", on: "fail", to: "build" } };
const titled = (title: string) => ({
  kind: "node" as const,
  id: "build",
  change: (node: PlanFile["nodes"][number]) => setOrClearField(node, "title", title),
});

describe("LinePane: edits on a running Line", () => {
  it("sends a parked verdict's link from the inspector as one line.plan.edit at the rev it drew", async () => {
    const t = setup(3);
    expect(t.$('.plan-port[data-node="test"][data-on="fail"]')?.textContent).toBe("● fail");
    t.pane.select({ kind: "node", id: "test" });
    t.$<HTMLSelectElement>(".plan-link-on")!.value = "fail";
    t.$<HTMLSelectElement>(".plan-link-to")!.value = "build";
    t.$<HTMLButtonElement>(".plan-link-make")!.click();
    await tick();
    expect(t.sent.map(({ baseRev, edits }) => ({ baseRev, edits }))).toEqual([{ baseRev: 3, edits: [LINK] }]);
  });

  it("applies nothing itself: the link is drawn when the snapshot at the new rev carries it", async () => {
    const t = setup(3);
    t.pane.change({ kind: "edit", edit: LINK });
    t.sent[0]!.d.resolve({ rev: 4, notes: [] });
    await tick();
    expect(t.$('[data-key="edge:test.fail>build"]')).toBeNull();
    t.push(at(graph(4, { ...PLAN, edges: [...PLAN.edges, { from: "test", on: "fail", to: "build" }] }, [])));
    expect(t.$('[data-key="edge:test.fail>build"]')).not.toBeNull();
    expect(t.$('.plan-port[data-node="test"][data-on="fail"]')?.textContent).toBe("fail");
  });

  it("holds what queues while a batch is out until the snapshot reaches the rev core applied it at, then sends it from that Plan", async () => {
    const t = setup(3);
    t.pane.move("build", { x: 120, y: 60 });
    t.pane.change(titled("Build it"));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.edits).toEqual([{ edit: "move", id: "build", x: 120, y: 60 }]);
    t.sent[0]!.d.resolve({ rev: 4, notes: [] });
    await tick();
    expect(t.sent).toHaveLength(1);
    expect(left(t, "build")).toBe("120px");
    const moved = { ...PLAN, nodes: PLAN.nodes.map((n) => (n.id === "build" ? { ...n, x: 120 } : n)) };
    t.push(at(graph(4, moved)));
    expect(left(t, "build")).toBe("120px");
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.baseRev).toBe(4);
    expect(t.sent[1]!.edits).toEqual([{ edit: "setNode", node: { ...moved.nodes[0]!, title: "Build it" } }]);
  });

  it("shows a refusal inside the view, puts the card back, and the next edit clears it", async () => {
    const t = setup(3);
    t.pane.move("build", { x: 120, y: 60 });
    expect(left(t, "build")).toBe("120px");
    t.sent[0]!.d.reject(new Error("the Plan has changed since: it is at rev 5"));
    await tick();
    expect(t.$(".line-pane .line-refusal.error-inline")?.textContent).toBe("the Plan has changed since: it is at rev 5");
    expect(left(t, "build")).toBe("40px");
    t.pane.change({ kind: "edit", edit: LINK });
    expect(t.$(".line-refusal")).toBeNull();
    expect(t.sent[1]!.baseRev).toBe(3);
  });

  it("drops the reply to an edit whose Line has gone", async () => {
    const t = setup(3);
    t.pane.change({ kind: "edit", edit: LINK });
    t.push(null);
    t.sent[0]!.d.reject(new Error("no Line"));
    await tick();
    t.push(at(graph(0)));
    t.pane.open();
    expect(t.$(".line-pane")).not.toBeNull();
    expect(t.$(".line-refusal")).toBeNull();
  });
});

describe("LinePane: Save as and copies", () => {
  it("hands Save as the frozen Plan", () => {
    const t = setup(3);
    t.$<HTMLButtonElement>(".line-save-as")!.click();
    expect(t.savedAs).toEqual([PLAN]);
  });

  it("opens a copy's Ticket from its dot", () => {
    const t = setup(3);
    t.$<HTMLElement>('[data-card="ticket:build-1"]')!.click();
    expect(t.opened).toEqual(["ticket:build-1"]);
    expect(t.sent).toHaveLength(0);
  });
});
