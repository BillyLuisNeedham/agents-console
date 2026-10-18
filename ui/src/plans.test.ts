/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type {
  PlanBootResponse,
  PlanDraftResponse,
  PlanEditFile,
  PlanFile,
  PlanProblem,
  PlanResponse,
  PlanSaveResponse,
  PlanSummary,
  PlansListResponse,
} from "../../protocol/wire.ts";
import { h } from "./dom";
import { commit } from "./morph";
import { PlansStore } from "./plans";
import { withField } from "./plan-inspector";
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

const BUILD = { kind: "agent", id: "build", title: "Build", x: 40, y: 60, skill: "tdd" } as const;

const DOC: PlanFile = {
  horde: 1,
  name: "Two steps",
  nodes: [
    BUILD,
    { kind: "prove", id: "prove", title: "Prove", x: 340, y: 60 },
    { kind: "finish", id: "finish", title: "Finish", x: 640, y: 60 },
  ],
  edges: [
    { from: "build", on: "done", to: "prove" },
    { from: "prove", on: "pass", to: "finish" },
    { from: "prove", on: "fail", to: "build", cap: { max: 2 } },
  ],
};

const VERDICTS: Record<string, string[]> = {
  agent: ["done", "closed"],
  prove: ["pass", "fail", "closed"],
  finish: ["revise"],
};

function reply(plan: PlanFile, extra: Partial<PlanDraftResponse> = {}): PlanDraftResponse {
  return {
    plan,
    problems: [],
    notes: [],
    verdicts: plan.nodes.map((n) => ({ id: n.id, verdicts: VERDICTS[n.kind] ?? [] })),
    ...extra,
  };
}

const LIST: PlanSummary[] = [
  { slug: "factory-today", preset: true, name: "Factory today", author: "Agent Console", source: "docs/adr/0039.md", note: "the fixed Line", problems: [] },
  { slug: "addy-commands", preset: true, name: "Addy · Commands", author: "Addy Osmani", problems: [] },
  { slug: "mine", preset: false, name: "Mine", problems: [] },
  { slug: "broken", preset: false, name: "Broken", problems: [{ at: { kind: "plan" }, message: "no Finish" }] },
];

function setup() {
  const lists: Deferred<PlansListResponse>[] = [];
  const gets: { slug: string; d: Deferred<PlanResponse> }[] = [];
  const edits: { plan: PlanFile; edits: PlanEditFile[]; d: Deferred<PlanDraftResponse> }[] = [];
  const saves: { slug: string; plan: PlanFile; d: Deferred<PlanSaveResponse> }[] = [];
  const deletes: { slug: string; d: Deferred<void> }[] = [];
  const boots: { slug: string; work: string; d: Deferred<PlanBootResponse> }[] = [];
  const root = document.createElement("div");
  const store: PlansStore = new PlansStore({
    onListPlans: () => {
      const d = deferred<PlansListResponse>();
      lists.push(d);
      return d.promise;
    },
    onGetPlan: (slug) => {
      const d = deferred<PlanResponse>();
      gets.push({ slug, d });
      return d.promise;
    },
    onEditPlan: (plan, sent) => {
      const d = deferred<PlanDraftResponse>();
      edits.push({ plan, edits: sent, d });
      return d.promise;
    },
    onSavePlan: (slug, plan) => {
      const d = deferred<PlanSaveResponse>();
      saves.push({ slug, plan, d });
      return d.promise;
    },
    onDeletePlan: (slug) => {
      const d = deferred<void>();
      deletes.push({ slug, d });
      return d.promise;
    },
    onBootPlan: (slug, work) => {
      const d = deferred<PlanBootResponse>();
      boots.push({ slug, work, d });
      return d.promise;
    },
    onChange: () => draw(),
  });
  const draw = () => commit(root, () => h("div", {}, store.render()));
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  const click = async (selector: string) => {
    const el = $<HTMLButtonElement>(selector);
    if (!el) throw new Error(`no ${selector}`);
    el.click();
    await tick();
  };

  /** Open the pane and a Plan, answered with `doc` (by core, after an empty edit). */
  async function opened(slug = "mine", doc = DOC, extra: Partial<PlanDraftResponse> = {}) {
    void store.open();
    lists[lists.length - 1]!.resolve({ plans: LIST });
    await tick();
    store.openPlan(slug);
    await tick();
    const preset = LIST.find((p) => p.slug === slug)?.preset ?? false;
    gets[gets.length - 1]!.d.resolve({ slug, preset, plan: doc, problems: [] });
    await tick();
    edits[edits.length - 1]!.d.resolve(reply(doc, extra));
    await tick();
  }
  return { store, root, $, click, draw, lists, gets, edits, saves, deletes, boots, opened };
}

const move = (id: string, x: number, y: number) => ({ id, x, y });

describe("PlansStore: opening", () => {
  it("lists the Presets by author with source and note, then the library with broken files marked", async () => {
    const t = setup();
    void t.store.open();
    t.lists[0]!.resolve({ plans: LIST });
    await tick();
    const groups = [...t.root.querySelectorAll(".plans-group-author")].map((el) => el.textContent);
    expect(groups).toEqual(["Agent Console", "Addy Osmani"]);
    const factory = t.$('.plans-item[data-key="plan:factory-today"]')!;
    expect(factory.querySelector(".plans-item-source")?.textContent).toBe("docs/adr/0039.md");
    expect(factory.querySelector(".plans-item-note")?.textContent).toBe("the fixed Line");
    expect(t.$('.plans-item[data-key="plan:broken"]')!.classList.contains("plans-item-broken")).toBe(true);
    expect(t.$('.plans-item[data-key="plan:mine"]')!.classList.contains("plans-item-broken")).toBe(false);
  });

  it("reads the Plan, asks core for its draft with no edits, and draws what core answers", async () => {
    const t = setup();
    void t.store.open();
    t.lists[0]!.resolve({ plans: LIST });
    await tick();
    await t.click('.plans-item[data-key="plan:mine"]');
    expect(t.gets.map((g) => g.slug)).toEqual(["mine"]);
    t.gets[0]!.d.resolve({ slug: "mine", preset: false, plan: DOC, problems: [] });
    await tick();
    expect(t.edits).toHaveLength(1);
    expect(t.edits[0]!.plan).toEqual(DOC);
    expect(t.edits[0]!.edits).toEqual([]);
    const canonical = { ...DOC, nodes: DOC.nodes.map((n) => ({ ...n, title: n.title.toUpperCase() })) };
    t.edits[0]!.d.resolve(reply(canonical));
    await tick();
    const titles = [...t.root.querySelectorAll(".plan-node-title")].map((el) => el.textContent);
    expect(titles).toEqual(["BUILD", "PROVE", "FINISH"]);
    const ports = [...t.root.querySelectorAll('.plan-node[data-node="prove"] .plan-port')].map((el) => el.textContent);
    expect(ports).toEqual(["pass", "fail", "closed"]);
    expect(t.$('.plan-port[data-node="prove"][data-on="closed"]')!.classList.contains("plan-port-open")).toBe(true);
  });

  it("opens a file core cannot edit read-only, with its problems and only Delete", async () => {
    const t = setup();
    void t.store.open();
    t.lists[0]!.resolve({ plans: LIST });
    await tick();
    t.store.openPlan("broken");
    await tick();
    const problems: PlanProblem[] = [{ at: { kind: "node", id: "build" }, message: "unknown field `colour`" }];
    t.gets[0]!.d.resolve({ slug: "broken", preset: false, plan: DOC, problems });
    await tick();
    t.edits[0]!.d.reject(new Error("`build` has a field core does not read: colour"));
    await tick();
    expect(t.$(".plans-delete")).not.toBeNull();
    expect(t.$(".plans-save")).toBeNull();
    expect(t.$(".plans-save-as")).toBeNull();
    expect(t.$(".plans-boot")).toBeNull();
    expect(t.$(".plan-shelf-add")).toBeNull();
    expect(t.$(".plan-port")).toBeNull();
    expect(t.$(".plans-refusal")?.textContent).toContain("colour");
    expect(t.$(".plan-inspector .plan-problem")?.textContent).toBe("unknown field `colour`");
    expect(t.$('.plan-node[data-node="build"]')!.classList.contains("plan-node-problem")).toBe(true);
  });
});

describe("PlansStore: the edit pipeline", () => {
  it("queues changes made while a batch is out and sends them as one batch on its reply's document", async () => {
    const t = setup();
    await t.opened();
    t.store.move("build", { x: 50, y: 70 });
    expect(t.edits).toHaveLength(2);
    t.store.move("prove", { x: 350, y: 70 });
    t.store.change({ kind: "edit", edit: { edit: "link", edge: { from: "build", on: "closed", to: "finish" } } });
    t.store.change({ kind: "edit", edit: { edit: "unlink", from: "prove", on: "pass", to: "finish" } });
    expect(t.edits).toHaveLength(2);
    const answered = { ...DOC, nodes: DOC.nodes.map((n) => (n.id === "build" ? { ...n, x: 50, y: 70 } : n)) };
    t.edits[1]!.d.resolve(reply(answered));
    await tick();
    expect(t.edits).toHaveLength(3);
    expect(t.edits[2]!.plan).toEqual(answered);
    expect(t.edits[2]!.edits).toEqual([
      { edit: "move", ...move("prove", 350, 70) },
      { edit: "link", edge: { from: "build", on: "closed", to: "finish" } },
      { edit: "unlink", from: "prove", on: "pass", to: "finish" },
    ]);
  });

  it("builds a node edit from the node as the batch leaves it, so two edits to one node both land", async () => {
    const t = setup();
    await t.opened();
    t.store.move("build", { x: 0, y: 0 });
    const field = (name: string, value: string) =>
      t.store.commit(`node:build:${name}`, value, "", {
        kind: "node",
        id: "build",
        change: (node) => withField(node, name, value),
      });
    field("title", "Build it");
    field("skill", "addy-build");
    t.edits[1]!.d.resolve(reply(DOC));
    await tick();
    const [first, second] = t.edits[2]!.edits;
    expect(first).toEqual({ edit: "setNode", node: { ...DOC.nodes[0]!, title: "Build it" } });
    expect(second).toEqual({ edit: "setNode", node: { ...BUILD, title: "Build it", skill: "addy-build" } });
  });

  it("draws a dropped card at its drop place until the reply that carries it, and the reply's place after", async () => {
    const t = setup();
    await t.opened();
    const left = () => t.$<HTMLElement>('.plan-node[data-node="build"]')!.style.left;
    t.store.move("build", { x: 120, y: 60 });
    expect(left()).toBe("120px");
    t.edits[1]!.d.resolve(
      reply({ ...DOC, nodes: DOC.nodes.map((n) => (n.id === "build" ? { ...n, x: 120 } : n)) }),
    );
    await tick();
    expect(left()).toBe("120px");
  });

  it("shows a refused batch's reason, puts the card back, and still sends what queued on the unchanged document", async () => {
    const t = setup();
    await t.opened();
    const left = () => t.$<HTMLElement>('.plan-node[data-node="build"]')!.style.left;
    t.store.move("build", { x: 120, y: 60 });
    t.store.change({ kind: "edit", edit: { edit: "removeNode", id: "finish" } });
    t.edits[1]!.d.reject(new Error("no node named `nobody`"));
    await tick();
    expect(left()).toBe("40px");
    expect(t.$(".plans-refusal")?.textContent).toBe("no node named `nobody`");
    expect(t.edits[2]!.plan).toEqual(DOC);
    expect(t.edits[2]!.edits).toEqual([{ edit: "removeNode", id: "finish" }]);
  });

  it("drops a reply for a draft that is no longer open", async () => {
    const t = setup();
    await t.opened();
    t.store.move("build", { x: 120, y: 60 });
    t.store.openPlan("factory-today");
    await t.click(".plans-discard");
    const late = { ...DOC, name: "late" };
    t.edits[1]!.d.resolve(reply(late));
    await tick();
    expect(t.$(".plans-doc-name")).toBeNull();
    expect(t.gets.map((g) => g.slug)).toEqual(["mine", "factory-today"]);
  });

  it("settles once nothing is queued or out", async () => {
    const t = setup();
    await t.opened();
    let settled = false;
    t.store.move("build", { x: 1, y: 1 });
    t.store.move("build", { x: 2, y: 2 });
    void t.store.settled().then(() => (settled = true));
    t.edits[1]!.d.resolve(reply(DOC));
    await tick();
    expect(settled).toBe(false);
    t.edits[2]!.d.resolve(reply(DOC));
    await tick();
    expect(settled).toBe(true);
  });

  it("selects a node core added and named, once its reply lands", async () => {
    const t = setup();
    await t.opened();
    await t.click('.plan-shelf-add[data-kind="gate"]');
    expect(t.edits[1]!.edits[0]).toMatchObject({ edit: "addNode", kind: "gate" });
    const added = { ...DOC, nodes: [...DOC.nodes, { kind: "gate" as const, id: "gate", title: "Gate", x: 0, y: 300 }] };
    t.edits[1]!.d.resolve(reply(added));
    await tick();
    expect(t.$(".plan-inspector-head")?.textContent).toBe("Gate · gate");
    expect(t.$('.plan-node[data-node="gate"]')!.classList.contains("plan-node-selected")).toBe(true);
  });
});

describe("PlansStore: problems and notes", () => {
  it("marks each problem on its node or edge, and shows the Plan's own and the edit's notes in the banner", async () => {
    const t = setup();
    await t.opened("mine", DOC, {
      problems: [
        { at: { kind: "node", id: "prove" }, message: "`prove` is unreachable" },
        { at: { kind: "edge", from: "prove", on: "fail", to: "build" }, message: "a loop needs a cap" },
        { at: { kind: "plan" }, message: "a Plan needs a name" },
      ],
    });
    const prove = t.$('.plan-node[data-node="prove"]')!;
    expect(prove.classList.contains("plan-node-problem")).toBe(true);
    expect(prove.getAttribute("title")).toBe("`prove` is unreachable");
    expect(t.$('.plan-node[data-node="build"]')!.classList.contains("plan-node-problem")).toBe(false);
    const edge = t.$('[data-key="edge:prove.fail>build"]')!;
    expect(edge.getAttribute("class")).toContain("plan-edge-problem");
    expect(t.$('[data-key="edge:build.done>prove"]')!.getAttribute("class")).not.toContain("plan-edge-problem");
    expect(t.$(".plans-banner .plan-problem")?.textContent).toBe("a Plan needs a name");
    t.store.move("build", { x: 99, y: 60 });
    t.edits[1]!.d.resolve(reply(DOC, { notes: ["`build` is per-item now: placed `build-merge`"] }));
    await tick();
    expect(t.$(".plans-note")?.textContent).toContain("build-merge");
    await t.click(".plans-dismiss");
    expect(t.$(".plans-note")).toBeNull();
  });
});

describe("PlansStore: the inspector", () => {
  it("holds a title's typed text while it is out, then commits it as one setNode", async () => {
    const t = setup();
    await t.opened();
    t.store.select({ kind: "node", id: "build" });
    const input = t.$<HTMLInputElement>('[data-key="input:node:build:title"]')!;
    input.value = "Build it";
    input.dispatchEvent(new Event("input"));
    expect(t.edits).toHaveLength(1);
    expect(t.$<HTMLInputElement>('[data-key="input:node:build:title"]')).toBe(input);
    expect(input.value).toBe("Build it");
    input.dispatchEvent(new Event("change"));
    expect(t.edits[1]!.edits).toEqual([{ edit: "setNode", node: { ...DOC.nodes[0]!, title: "Build it" } }]);
    t.draw();
    expect(input.value).toBe("Build it");
    t.edits[1]!.d.resolve(reply({ ...DOC, nodes: DOC.nodes.map((n) => (n.id === "build" ? { ...n, title: "Build it" } : n)) }));
    await tick();
    expect(input.value).toBe("Build it");
    expect(t.$(".plan-node-title")?.textContent).toBe("Build it");
  });

  it("sets a node's Assignment from a harness quick pick and clears it back to the pool default", async () => {
    const t = setup();
    await t.opened();
    t.store.select({ kind: "node", id: "build" });
    await t.click('[data-key="node:build:assign:harness"] .plan-pick[data-key="codex"]');
    expect(t.edits[1]!.edits).toEqual([{ edit: "setNode", node: { ...BUILD, assign: { harness: "codex" } } }]);
    const withCodex = { ...DOC, nodes: DOC.nodes.map((n) => (n.id === "build" ? { ...n, assign: { harness: "codex" } } : n)) };
    t.edits[1]!.d.resolve(reply(withCodex));
    await tick();
    await t.click('[data-key="node:build:assign:harness"] .plan-pick[data-key="default"]');
    expect(t.edits[2]!.edits).toEqual([{ edit: "setNode", node: DOC.nodes[0]! }]);
  });

  it("caps an edge from its panel and uncaps it when the field is cleared", async () => {
    const t = setup();
    await t.opened();
    t.store.select({ kind: "edge", key: { from: "prove", on: "fail", to: "build" } });
    const max = t.$<HTMLInputElement>('[data-key="input:edge:prove.fail>build:max"]')!;
    max.value = "3";
    max.dispatchEvent(new Event("change"));
    expect(t.edits[1]!.edits).toEqual([{ edit: "setCap", from: "prove", on: "fail", to: "build", cap: { max: 3 } }]);
    t.edits[1]!.d.resolve(reply(DOC));
    await tick();
    max.value = "";
    max.dispatchEvent(new Event("change"));
    expect(t.edits[2]!.edits).toEqual([{ edit: "setCap", from: "prove", on: "fail", to: "build" }]);
  });
});

describe("PlansStore: save, save as, delete", () => {
  it("offers a Preset Save as but no Save, saves it under the new slug once settled, and the draft becomes that library Plan", async () => {
    const t = setup();
    await t.opened("factory-today");
    expect(t.$(".plans-save")).toBeNull();
    expect(t.$(".plans-delete")).toBeNull();
    t.store.move("build", { x: 99, y: 60 });
    await t.click(".plans-save-as");
    expect(t.$<HTMLInputElement>(".plans-slug")!.value).toBe("factory-today-copy");
    await t.click(".plans-save-as-confirm");
    expect(t.saves).toHaveLength(0);
    const moved = { ...DOC, nodes: DOC.nodes.map((n) => (n.id === "build" ? { ...n, x: 99 } : n)) };
    t.edits[1]!.d.resolve(reply(moved));
    await tick();
    expect(t.saves.map((s) => [s.slug, s.plan])).toEqual([["factory-today-copy", moved]]);
    t.saves[0]!.d.resolve({ slug: "factory-today-copy", plan: moved });
    await tick();
    expect(t.$(".plans-doc-origin")?.textContent).toBe("library factory-today-copy");
    expect(t.$(".plans-save")).not.toBeNull();
    expect(t.$<HTMLButtonElement>(".plans-save")!.disabled).toBe(true);
    expect(t.lists).toHaveLength(2);
  });

  it("asks before Save as replaces a library Plan already listed", async () => {
    const t = setup();
    await t.opened("factory-today");
    await t.click(".plans-save-as");
    t.store.setSaveAsSlug("mine");
    await t.click(".plans-save-as-confirm");
    expect(t.saves).toHaveLength(0);
    expect(t.$(".plans-save-as-confirm")?.textContent).toBe("Replace mine");
    await t.click(".plans-save-as-confirm");
    expect(t.saves.map((s) => s.slug)).toEqual(["mine"]);
  });

  it("shows a refused Save as on its row and keeps the draft unsaved", async () => {
    const t = setup();
    await t.opened("factory-today");
    t.store.move("build", { x: 99, y: 60 });
    t.edits[1]!.d.resolve(reply({ ...DOC, nodes: DOC.nodes.map((n) => (n.id === "build" ? { ...n, x: 99 } : n)) }));
    await tick();
    await t.click(".plans-save-as");
    t.store.setSaveAsSlug("addy-commands");
    await t.click(".plans-save-as-confirm");
    t.saves[0]!.d.reject(new Error("`addy-commands` is a Preset: save it under another slug"));
    await tick();
    expect(t.$(".plans-control-failure")?.textContent).toContain("is a Preset");
    expect(t.$(".plans-doc-origin")?.textContent).toBe("preset factory-today · unsaved");
  });

  it("saves a library Plan over its own slug and is clean after", async () => {
    const t = setup();
    await t.opened("mine");
    expect(t.$<HTMLButtonElement>(".plans-save")!.disabled).toBe(true);
    t.store.move("build", { x: 99, y: 60 });
    const moved = { ...DOC, nodes: DOC.nodes.map((n) => (n.id === "build" ? { ...n, x: 99 } : n)) };
    t.edits[1]!.d.resolve(reply(moved));
    await tick();
    await t.click(".plans-save");
    expect(t.saves.map((s) => [s.slug, s.plan])).toEqual([["mine", moved]]);
    t.saves[0]!.d.resolve({ slug: "mine", plan: moved });
    await tick();
    expect(t.$(".plans-doc-origin")?.textContent).toBe("library mine");
  });

  it("does not offer Save while the draft has problems", async () => {
    const t = setup();
    await t.opened("mine", DOC, { problems: [{ at: { kind: "plan" }, message: "no Finish" }] });
    t.store.move("build", { x: 99, y: 60 });
    t.edits[1]!.d.resolve(reply(DOC, { problems: [{ at: { kind: "plan" }, message: "no Finish" }] }));
    await tick();
    expect(t.$<HTMLButtonElement>(".plans-save")!.disabled).toBe(true);
  });

  it("deletes a library Plan after asking, and goes back to the list", async () => {
    const t = setup();
    await t.opened("mine");
    await t.click(".plans-delete");
    expect(t.deletes).toHaveLength(0);
    await t.click(".plans-delete-confirm");
    expect(t.deletes.map((d) => d.slug)).toEqual(["mine"]);
    t.deletes[0]!.d.resolve();
    await tick();
    expect(t.$(".plans-doc-name")).toBeNull();
    expect(t.lists).toHaveLength(2);
  });

  it("asks before closing over unsaved changes", async () => {
    const t = setup();
    await t.opened("mine");
    t.store.move("build", { x: 99, y: 60 });
    t.store.close();
    expect(t.store.isOpen).toBe(true);
    expect(t.$(".plans-discard")).not.toBeNull();
    await t.click(".plans-discard");
    expect(t.store.isOpen).toBe(false);
  });
});

describe("PlansStore: Boot a Line", () => {
  it("boots only a saved Plan, sends one plans.boot, and shows what Boot ran and where its log goes", async () => {
    const t = setup();
    await t.opened("factory-today");
    t.store.move("build", { x: 99, y: 60 });
    expect(t.$<HTMLButtonElement>(".plans-boot")!.disabled).toBe(true);
    t.edits[1]!.d.resolve(reply(DOC));
    await tick();
    expect(t.$<HTMLButtonElement>(".plans-boot")!.disabled).toBe(false);
    await t.click(".plans-boot");
    const work = t.$<HTMLInputElement>(".plans-work")!;
    work.value = "186";
    work.dispatchEvent(new Event("input"));
    t.$<HTMLButtonElement>(".plans-boot-confirm")!.click();
    t.$<HTMLButtonElement>(".plans-boot-confirm")!.click();
    await tick();
    expect(t.boots.map((b) => [b.slug, b.work])).toEqual([["factory-today", "186"]]);
    t.boots[0]!.d.resolve({
      argv: ["--plan", "factory-today", "--work", "186", "--yes"],
      cwd: "/home/me/repo",
      log: "/home/me/repo/.scratch/pool/runs/boot.log",
    });
    await tick();
    expect(t.$(".plans-argv")?.textContent).toBe("boot --plan factory-today --work 186 --yes");
    expect(t.$(".plans-log")?.textContent).toBe("/home/me/repo/.scratch/pool/runs/boot.log");
  });

  it("shows a refused boot on its row", async () => {
    const t = setup();
    await t.opened("factory-today");
    await t.click(".plans-boot");
    t.store.setBootWork("--yes");
    await t.click(".plans-boot-confirm");
    t.boots[0]!.d.reject(new Error("the work cannot start with --"));
    await tick();
    expect(t.$(".plans-control-failure")?.textContent).toBe("the work cannot start with --");
    expect(t.$<HTMLButtonElement>(".plans-boot-confirm")!.disabled).toBe(false);
  });
});
