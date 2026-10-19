/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type {
  ConversationView,
  EnrichedTicketState,
  LineEdgeView,
  LineGraphView,
  LineNodeView,
  PlanFile,
} from "../../protocol/wire.ts";
import { projectLine } from "./line-projection";

const plan: PlanFile = {
  horde: 1,
  name: "Factory today",
  nodes: [
    { kind: "conversation", id: "grill", title: "Grill", x: 0, y: 0 },
    { kind: "agent", id: "build", title: "Build", x: 200, y: 0, copies: { perItem: 2 } },
    { kind: "review", id: "review", title: "Review", x: 400, y: 0 },
    { kind: "gate", id: "join", title: "Join", x: 600, y: 0, join: "all" },
    { kind: "gate", id: "ok", title: "Ok", x: 800, y: 0 },
    { kind: "finish", id: "finish", title: "Finish", x: 1000, y: 0 },
  ],
  edges: [
    { from: "grill", on: "done", to: "build" },
    { from: "build", on: "done", to: "review" },
    { from: "review", on: "findings", to: "build", cap: { max: 2, stewardExtra: true } },
    { from: "review", on: "clean", to: "join" },
    { from: "build", on: "closed", to: "join" },
    { from: "join", on: "open", to: "ok" },
    { from: "ok", on: "open", to: "finish" },
  ],
};

function nodeView(id: string, overrides: Partial<LineNodeView> = {}): LineNodeView {
  return { id, verdicts: ["done"], passes: 0, tickets: [], queued: 0, inbox: 0, parked: [], arrived: [], ...overrides };
}

function line(
  nodes: Partial<LineNodeView> & { id: string },
  overrides: Partial<LineGraphView> = {},
  edges: LineEdgeView[] = [],
): LineGraphView {
  const views = plan.nodes.map((n) => nodeView(n.id, n.id === nodes.id ? nodes : {}));
  return { plan, rev: 3, status: "running", waitingFor: [], nodes: views, edges, ...overrides };
}

const ticket = (id: string, status: EnrichedTicketState["status"]) => ({ id, status });
const conversation = (
  id: string,
  status: ConversationView["status"],
  turn: "working" | "waiting" = "working",
): Pick<ConversationView, "id" | "status" | "turn"> => ({
  id,
  status,
  turn: { state: turn, lastLine: "", idleSince: null },
});

describe("projectLine's node state", () => {
  const state = (view: Parameters<typeof line>[0], tickets: ReturnType<typeof ticket>[] = [], overrides: Partial<LineGraphView> = {}) => {
    const live = projectLine(line(view, overrides), tickets, [], null);
    return live.nodes.get(view.id)!;
  };

  it("shows a 5-item pass under cap 2 as 2 running and 3 queued", () => {
    const node = state(
      { id: "build", passes: 1, pass: 2, tickets: ["b-1", "b-2"], queued: 3 },
      [ticket("b-1", "in-progress"), ticket("b-2", "ready")],
    );
    expect(node.state).toEqual({ tone: "running", text: "2 running · 3 queued" });
    expect(node.summary).toEqual(["pass 2 · 2 running · 3 queued", "2 running · 3 queued"]);
    expect(node.queued).toBe(3);
    expect(node.copies.map((c) => [c.id, c.card, c.tone])).toEqual([
      ["b-1", "ticket:b-1", "running"],
      ["b-2", "ticket:b-2", "pending"],
    ]);
  });

  it("counts a finished copy of a live pass out of the running ones", () => {
    const node = state(
      { id: "build", pass: 1, tickets: ["b-1", "b-2", "b-3"], queued: 1 },
      [ticket("b-1", "done"), ticket("b-2", "in-progress"), ticket("b-3", "in-progress")],
    );
    expect(node.state.text).toBe("2 running · 1 queued");
    expect(node.copies.map((c) => c.tone)).toEqual(["done", "running", "running"]);
  });

  it("reads running without a queue, and a one-copy pass as just its number", () => {
    const perItem = state({ id: "build", pass: 1, tickets: ["b-1", "b-2"] }, [
      ticket("b-1", "in-progress"),
      ticket("b-2", "in-progress"),
    ]);
    expect(perItem.state.text).toBe("running 2");
    expect(perItem.summary).toEqual(["pass 1 · 2 running", "2 running"]);
    const single = state({ id: "review", pass: 4, tickets: ["r-4"] }, [ticket("r-4", "in-progress")]);
    expect(single.state.text).toBe("running 1");
    expect(single.summary).toEqual(["pass 4"]);
  });

  it("treats a copy the snapshot has not got yet as pending", () => {
    const node = state({ id: "review", pass: 1, tickets: ["r-1"] });
    expect(node.copies[0]!.tone).toBe("pending");
    expect(node.state.text).toBe("running 1");
  });

  it("needs you while any copy is at a checkpoint", () => {
    const node = state({ id: "build", pass: 1, tickets: ["b-1", "b-2"] }, [
      ticket("b-1", "in-progress"),
      ticket("b-2", "checkpoint"),
    ]);
    expect(node.state).toEqual({ tone: "needs", text: "needs you" });
  });

  it("waits on you at a Gate that holds", () => {
    const node = state({ id: "ok", hold: "ok-1", passes: 0 }, [ticket("ok-1", "checkpoint")]);
    expect(node.state).toEqual({ tone: "needs", text: "waiting on you" });
    expect(node.hold).toEqual({ id: "ok-1", card: "ticket:ok-1", tone: "checkpoint", selected: false });
  });

  it("counts a join:all Gate's arrivals against the edges into it", () => {
    const node = state({
      id: "join",
      arrived: [{ from: "review", on: "clean", to: "join" }],
    });
    expect(node.state).toEqual({ tone: "collecting", text: "1 of 2 in" });
  });

  it("parks a node whose verdict has no edge", () => {
    const node = state({ id: "review", passes: 1, parked: ["findings"] });
    expect(node.state).toEqual({ tone: "parked", text: "done · waiting" });
    expect(node.parked).toEqual(["findings"]);
  });

  it("says a node finished its passes, singular for one", () => {
    expect(state({ id: "review", passes: 1 }).state).toEqual({ tone: "done", text: "done · 1 pass" });
    expect(state({ id: "review", passes: 3 }).state).toEqual({ tone: "done", text: "done · 3 passes" });
    expect(state({ id: "review", passes: 3 }).summary).toBeNull();
  });

  it("is not run before its first pass", () => {
    expect(state({ id: "review" }).state).toEqual({ tone: "idle", text: "not run" });
  });

  it("marks the node a spent loop leaves", () => {
    const spent: LineEdgeView = { edge: plan.edges[2]!, count: 2, max: 2, bought: 0, hold: "hold-1" };
    const live = projectLine(line({ id: "review", passes: 2 }, {}, [spent]), [ticket("hold-1", "checkpoint")], [], null);
    expect(live.nodes.get("review")!.state).toEqual({ tone: "needs", text: "loop spent" });
    expect(live.nodes.get("review")!.hold?.card).toBe("ticket:hold-1");
  });

  it("has every node with passes read done once the Line is done or closed", () => {
    const node = state({ id: "review", passes: 2, pass: 2, tickets: ["r-2"] }, [ticket("r-2", "in-progress")], {
      status: "closed",
    });
    expect(node.state).toEqual({ tone: "done", text: "done · 2 passes" });
    expect(state({ id: "ok" }, [], { status: "done" }).state.text).toBe("not run");
  });

  it("joins a Conversation node's pass against the Conversation, not a Ticket", () => {
    const live = projectLine(
      line({ id: "grill", pass: 1, tickets: ["grill-1"] }),
      [ticket("grill-1", "done")],
      [conversation("grill-1", "live", "waiting")],
      "conversation:grill-1",
    );
    const node = live.nodes.get("grill")!;
    expect(node.copies).toEqual([{ id: "grill-1", card: "conversation:grill-1", tone: "checkpoint", selected: true }]);
    expect(node.state.text).toBe("needs you");
    const ended = projectLine(line({ id: "grill", passes: 1 }), [], [conversation("grill-1", "ended")], null);
    expect(ended.nodes.get("grill")!.state.text).toBe("done · 1 pass");
  });

  it("marks the selected copy by its card id", () => {
    const live = projectLine(
      line({ id: "build", pass: 1, tickets: ["b-1", "b-2"] }),
      [ticket("b-1", "in-progress"), ticket("b-2", "in-progress")],
      [],
      "ticket:b-2",
    );
    expect(live.nodes.get("build")!.copies.map((c) => c.selected)).toEqual([false, true]);
  });
});

describe("projectLine's Finish", () => {
  const finish = (view: Partial<LineNodeView>, overrides: Partial<LineGraphView>) =>
    projectLine(line({ id: "finish", ...view }, overrides), [ticket("fin-1", "checkpoint")], [], null);

  it("lists what it waits for and counts it while the Line is finishing", () => {
    const live = finish({}, { status: "finishing", waitingFor: ["build-1", "build-2", "review-1"] });
    expect(live.nodes.get("finish")!.state).toEqual({ tone: "needs", text: "waiting for 3" });
    expect(live.nodes.get("finish")!.waitingFor).toEqual(["build-1", "build-2", "review-1"]);
    expect(live.waitingFor).toEqual(["build-1", "build-2", "review-1"]);
    expect(live.nodes.get("build")!.waitingFor).toEqual([]);
  });

  it("needs you once its hold is written", () => {
    const live = finish({ hold: "fin-1" }, { status: "finishing" });
    expect(live.nodes.get("finish")!.state).toEqual({ tone: "needs", text: "needs you" });
    expect(live.nodes.get("finish")!.hold?.card).toBe("ticket:fin-1");
  });

  it("is running while it acts and done at the end", () => {
    expect(finish({ pass: 1, tickets: ["fin-act"] }, { status: "acting" }).nodes.get("finish")!.state.tone).toBe("running");
    expect(finish({ passes: 1 }, { status: "done" }).nodes.get("finish")!.state.text).toBe("done · 1 pass");
  });
});

describe("projectLine's edges and headline", () => {
  const capped = plan.edges[2]!;
  const capKey = "review.findings>build";

  it("labels a capped edge with its count against the cap, what was bought and the Steward mark", () => {
    const view = (count: number, bought: number): LineEdgeView => ({ edge: capped, count, max: 2, bought });
    const label = (e: LineEdgeView) => projectLine(line({ id: "build" }, {}, [e]), [], [], null).edges.get(capKey)!;
    expect(label(view(1, 0))).toEqual({ label: "findings · 1/2 · S", spent: false, hold: null });
    expect(label(view(2, 1)).label).toBe("findings · 2/2 +1 · S");
  });

  it("leaves out the Steward mark when the Plan's cap has none", () => {
    const noSteward: PlanFile = {
      ...plan,
      edges: [{ ...capped, cap: { max: 2 } }],
    };
    const g = { ...line({ id: "build" }, {}, [{ edge: capped, count: 0, max: 2, bought: 0 }]), plan: noSteward };
    expect(projectLine(g, [], [], null).edges.get(capKey)!.label).toBe("findings · 0/2");
  });

  it("keeps the plain verdict on an uncapped edge", () => {
    const live = projectLine(line({ id: "build" }), [], [], null);
    expect(live.edges.get("grill.done>build")).toEqual({ label: "done", spent: false, hold: null });
  });

  it("marks a spent loop and its hold Ticket", () => {
    const spent: LineEdgeView = { edge: capped, count: 2, max: 2, bought: 0, hold: "hold-1" };
    const edge = projectLine(line({ id: "build" }, {}, [spent]), [ticket("hold-1", "checkpoint")], [], null).edges.get(capKey)!;
    expect(edge.spent).toBe(true);
    expect(edge.hold).toEqual({ id: "hold-1", card: "ticket:hold-1", tone: "checkpoint", selected: false });
  });

  it("reads the Plan and its status as the headline, and carries the rev and the verdicts", () => {
    const live = projectLine(line({ id: "build", verdicts: ["done", "closed"] }, { status: "acting" }), [], [], null);
    expect(live.headline).toBe("Factory today · acting");
    expect(live.rev).toBe(3);
    expect(live.verdicts.get("build")).toEqual(["done", "closed"]);
    for (const status of ["running", "finishing", "done", "closed"] as const) {
      expect(projectLine(line({ id: "build" }, { status }), [], [], null).headline).toBe(`Factory today · ${status}`);
    }
  });
});
