/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { Thread } from "@langchain/langgraph-sdk";
import {
  applyStreamPart,
  initRun,
  edgePath,
  layoutGraph,
  mergeLayout,
  parseStoredLayout,
  projectChannels,
  projectLog,
  projectInterruptForm,
  projectNodeCards,
  projectNodeChannels,
  projectNodes,
  projectResume,
  projectStartRun,
  projectThreadSummary,
  projectTicketCards,
  projectTicketEdges,
  projectTopology,
  strokeWidthForZoom,
  syncRunValues,
  visibleThreads,
  zoomAtCursor,
  type RunProjection,
} from "./project";

type Raw = Record<string, unknown>;

function thread(overrides: Partial<Thread<Raw>> = {}): Thread<Raw> {
  return {
    thread_id: "t-1",
    created_at: "2026-08-16T10:00:00Z",
    updated_at: "2026-08-16T10:05:00Z",
    state_updated_at: "2026-08-16T10:05:00Z",
    metadata: {},
    status: "idle",
    values: {},
    interrupts: {},
    ...overrides,
  };
}

describe("projectThreadSummary", () => {
  it("uses metadata.label and metadata.origin when present", () => {
    const summary = projectThreadSummary(
      thread({ metadata: { label: "my run", origin: "ui" } }),
    );
    expect(summary.threadId).toBe("t-1");
    expect(summary.label).toBe("my run");
    expect(summary.origin).toBe("ui");
  });

  it("falls back to the thread id and unknown origin", () => {
    const summary = projectThreadSummary(thread());
    expect(summary.label).toBe("t-1");
    expect(summary.origin).toBe("unknown");
  });

  it("counts pending interrupts across namespaces", () => {
    const summary = projectThreadSummary(
      thread({
        interrupts: {
          "ns/a": [{ id: "1", value: { kind: "approve-spec" } }],
          "ns/b": [{ id: "2", value: { kind: "review" } }, { id: "3", value: { kind: "review" } }],
        },
      }),
    );
    expect(summary.interruptCount).toBe(3);
  });
});

describe("visibleThreads", () => {
  const uiThread = thread({ thread_id: "ui-1", metadata: { origin: "ui" } });
  const otherThread = thread({ thread_id: "smoke-1", metadata: {} });

  it("defaults to Console-created threads only", () => {
    const visible = visibleThreads([uiThread, otherThread], false);
    expect(visible.map((t) => t.thread_id)).toEqual(["ui-1"]);
  });

  it("shows everything when the toggle is on", () => {
    const visible = visibleThreads([uiThread, otherThread], true);
    expect(visible.map((t) => t.thread_id)).toEqual(["ui-1", "smoke-1"]);
  });
});

describe("projectChannels", () => {
  it("renders known channels in graph order, with tickets structured", () => {
    const channels = projectChannels({
      log: ["writeSpec: spec from packet + pool"],
      specApproved: false,
      topic: "demo",
      packetSource: "stub",
      packet: "packet text",
      spec: "# Spec",
      tickets: [
        { id: "T1", title: "first", blockedBy: [], status: "done" },
        { id: "T2", title: "second", blockedBy: ["T1"], status: "pending" },
      ],
    });
    expect(channels.map((c) => c.name)).toEqual([
      "topic",
      "packetSource",
      "packet",
      "spec",
      "specApproved",
      "tickets",
    ]);
    const tickets = channels.find((c) => c.name === "tickets");
    expect(tickets?.kind).toBe("tickets");
    if (tickets?.kind === "tickets") {
      expect(tickets.tickets).toEqual([
        { id: "T1", title: "first", blockedBy: [], status: "done" },
        { id: "T2", title: "second", blockedBy: ["T1"], status: "pending" },
      ]);
    }
  });

  it("excludes the log channel (it lives in the drawer)", () => {
    const channels = projectChannels({ topic: "x", log: ["a", "b"] });
    expect(channels.some((c) => c.name === "log")).toBe(false);
  });

  it("appends unknown channels as json after the known ones", () => {
    const channels = projectChannels({ topic: "x", extra: { nested: 1 } });
    expect(channels.map((c) => c.name)).toEqual(["topic", "extra"]);
    expect(channels[1].kind).toBe("json");
  });

  it("returns no channels for missing or non-object values", () => {
    expect(projectChannels(null)).toEqual([]);
    expect(projectChannels([{ topic: "x" }])).toEqual([]);
  });

  it("renders booleans and numbers as text", () => {
    const channels = projectChannels({ specApproved: true });
    expect(channels[0]).toEqual({ name: "specApproved", kind: "text", text: "true" });
  });

  it("follows the latest values snapshot so the inspector updates per super-step", () => {
    const first = applyStreamPart(initRun(), {
      event: "values",
      data: { topic: "demo", packet: "p1", log: ["a"] },
    });
    expect(projectChannels(first.values)).toEqual([
      { name: "topic", kind: "text", text: "demo" },
      { name: "packet", kind: "pre", text: "p1" },
    ]);

    const second = applyStreamPart(first, {
      event: "values",
      data: {
        topic: "demo",
        packet: "p1",
        spec: "# Spec",
        specApproved: false,
        tickets: [{ id: "T1", title: "first", blockedBy: [], status: "pending" }],
        log: ["a", "b"],
      },
    });
    expect(projectChannels(second.values).map((c) => c.name)).toEqual([
      "topic",
      "packet",
      "spec",
      "specApproved",
      "tickets",
    ]);
    expect(projectNodeChannels("writeSpec", second.values).map((c) => c.name)).toEqual(["spec"]);
  });
});

describe("projectLog", () => {
  it("extracts string log lines in order", () => {
    expect(projectLog({ log: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("drops non-string entries", () => {
    expect(projectLog({ log: ["a", 42, "b"] })).toEqual(["a", "b"]);
  });

  it("is empty when there is no log", () => {
    expect(projectLog({})).toEqual([]);
    expect(projectLog(null)).toEqual([]);
  });
});

function play(run: RunProjection, parts: { event: string; data: unknown }[]): RunProjection {
  return parts.reduce(applyStreamPart, run);
}

describe("applyStreamPart", () => {
  it("seeds from an existing snapshot and replaces it on each values part", () => {
    let run = initRun({ topic: "old", log: ["a"] });
    run = applyStreamPart(run, { event: "values", data: { topic: "new", log: ["a", "b"] } });
    expect(projectChannels(run.values).map((c) => c.name)).toContain("topic");
    expect(projectLog(run.values)).toEqual(["a", "b"]);
    expect(run.streaming).toBe(false);
  });

  it("tracks normal super-step progression through updates parts", () => {
    const run = play(initRun(), [
      { event: "values", data: { topic: "demo" } },
      { event: "updates", data: { writeSpec: { spec: "s" } } },
      { event: "values", data: { topic: "demo", spec: "s" } },
      { event: "updates", data: { approveSpec: { specApproved: true } } },
      { event: "updates", data: { schedule: {} } },
      { event: "updates", data: { implementTicket: { tickets: [] } } },
    ]);
    expect(projectNodes(run)).toEqual([
      { node: "writeSpec", status: "ran" },
      { node: "approveSpec", status: "ran" },
      { node: "schedule", status: "ran" },
      { node: "implementTicket", status: "active" },
    ]);
  });

  it("does not duplicate a node when a fan-out runs it across super-steps", () => {
    const run = play(initRun(), [
      { event: "updates", data: { schedule: {} } },
      { event: "updates", data: { implementTicket: {} } },
      { event: "updates", data: { implementTicket: {} } },
    ]);
    expect(run.visitedNodes).toEqual(["schedule", "implementTicket"]);
    expect(run.activeNodes).toEqual(["implementTicket"]);
  });

  it("keeps log append ordering from values snapshots; updates never append", () => {
    const run = play(initRun(), [
      { event: "values", data: { log: ["writeSpec: spec from packet + pool"] } },
      { event: "updates", data: { approveSpec: { log: ["spec approved"] } } },
      {
        event: "values",
        data: { log: ["writeSpec: spec from packet + pool", "spec approved"] },
      },
      { event: "updates", data: { schedule: { log: ["schedule: T1, T3"] } } },
      {
        event: "values",
        data: {
          log: ["writeSpec: spec from packet + pool", "spec approved", "schedule: T1, T3"],
        },
      },
    ]);
    expect(projectLog(run.values)).toEqual([
      "writeSpec: spec from packet + pool",
      "spec approved",
      "schedule: T1, T3",
    ]);
  });

  it("keeps the last full snapshot when a values part carries only interrupt bookkeeping", () => {
    const run = play(initRun(), [
      { event: "values", data: { topic: "demo", spec: "s" } },
      { event: "values", data: { __interrupt__: [{ id: "x", value: {} }] } },
    ]);
    expect(run.values).toEqual({ topic: "demo", spec: "s" });
  });

  it("ignores non-object updates payloads", () => {
    const run = applyStreamPart(initRun(), { event: "updates", data: null });
    expect(run.activeNodes).toEqual([]);
    expect(run.visitedNodes).toEqual([]);
  });

  it("does not treat internal keys like __interrupt__ as nodes", () => {
    const run = play(initRun(), [
      { event: "updates", data: { approveSpec: {} } },
      { event: "updates", data: { __interrupt__: [{ id: "x", value: {} }] } },
    ]);
    expect(run.visitedNodes).toEqual(["approveSpec"]);
    expect(run.activeNodes).toEqual(["approveSpec"]);
  });

  it("maps an interrupt-only updates part onto the node that raised it", () => {
    const run = play(initRun(), [
      { event: "updates", data: { writeSpec: {} } },
      { event: "updates", data: { __interrupt__: [{ value: { kind: "approve-spec" } }] } },
    ]);
    expect(projectNodes(run)).toEqual([
      { node: "writeSpec", status: "ran" },
      { node: "approveSpec", status: "active" },
    ]);
  });

  it("hides internal __-prefixed channels from the channel list", () => {
    const channels = projectChannels({ topic: "x", __interrupt__: [{ id: "x" }] });
    expect(channels.map((c) => c.name)).toEqual(["topic"]);
  });

  it("records error parts and ignores unknown events", () => {
    let run = applyStreamPart(initRun(), { event: "error", data: { message: "boom" } });
    expect(run.streamError).toBe("boom");
    run = applyStreamPart(run, { event: "messages", data: ["junk"] });
    expect(run.streamError).toBe("boom");
  });
});

describe("projectStartRun", () => {
  it("rejects a blank topic", () => {
    expect(projectStartRun({ topic: "", ticketDir: "tickets/", packet: "" })).toBeNull();
    expect(projectStartRun({ topic: "   ", ticketDir: "tickets/", packet: "" })).toBeNull();
  });

  it("trims the topic and puts the ticket pool under configurable.ticketDir", () => {
    const request = projectStartRun({
      topic: "  demo run  ",
      ticketDir: "mock-tickets-deadlock/",
      packet: "",
    });
    expect(request?.input.topic).toBe("demo run");
    expect(request?.config).toEqual({
      configurable: { ticketDir: "mock-tickets-deadlock/" },
    });
  });

  it("includes trimmed packet text when given", () => {
    const request = projectStartRun({
      topic: "demo",
      ticketDir: "tickets/",
      packet: "  # Packet\n\nreal decisions  ",
    });
    expect(request?.input.packet).toBe("# Packet\n\nreal decisions");
  });

  it("omits the packet key when blank, so the graph falls back to the demo packet", () => {
    for (const packet of ["", "   \n  "]) {
      const request = projectStartRun({ topic: "demo", ticketDir: "tickets/", packet });
      expect(request).not.toBeNull();
      expect("packet" in (request?.input ?? {})).toBe(false);
    }
  });
});

describe("syncRunValues", () => {
  it("replaces the snapshot but keeps node tracking", () => {
    let run = play(initRun(), [{ event: "updates", data: { writeSpec: {} } }]);
    run = syncRunValues(run, { topic: "refreshed" });
    expect(run.values).toEqual({ topic: "refreshed" });
    expect(run.visitedNodes).toEqual(["writeSpec"]);
  });

  it("keeps the previous snapshot when the new one is not an object", () => {
    const run = syncRunValues(initRun({ topic: "keep" }), null);
    expect(run.values).toEqual({ topic: "keep" });
  });
});

describe("projectTopology", () => {
  it("maps a getGraph payload onto nodes and edges", () => {
    const topology = projectTopology({
      nodes: [
        { id: "__start__" },
        { id: "writeSpec", name: "writeSpec" },
        { id: 7 },
      ],
      edges: [
        { source: "__start__", target: "writeSpec", conditional: false },
        { source: "writeSpec", target: "approveSpec", conditional: true, data: "ok" },
      ],
    });
    expect(topology.nodes).toEqual([
      { id: "__start__" },
      { id: "writeSpec", name: "writeSpec" },
      { id: "7" },
    ]);
    expect(topology.edges).toEqual([
      { source: "__start__", target: "writeSpec", conditional: false },
      { source: "writeSpec", target: "approveSpec", conditional: true, data: "ok" },
    ]);
  });

  it("returns an empty topology for missing or malformed payloads", () => {
    expect(projectTopology(null)).toEqual({ nodes: [], edges: [] });
    expect(projectTopology({ nodes: "nope" })).toEqual({ nodes: [], edges: [] });
    expect(projectTopology({ nodes: [{}, { id: "ok" }], edges: [{ source: "a" }] })).toEqual({
      nodes: [{ id: "ok" }],
      edges: [],
    });
  });
});

describe("layoutGraph", () => {
  it("places the known spine and parks unknown nodes in a fallback column", () => {
    const positions = layoutGraph([
      { id: "__start__" },
      { id: "writeSpec" },
      { id: "deadlockGate" },
      { id: "mystery" },
    ]);
    expect(positions["__start__"]).toEqual({ x: 300, y: 16 });
    expect(positions.writeSpec).toEqual({ x: 300, y: 196 });
    expect(positions.deadlockGate).toEqual({ x: 620, y: 596 });
    expect(positions.mystery).toEqual({ x: 640, y: 16 });
  });
});

describe("mergeLayout", () => {
  const defaults = {
    writeSpec: { x: 300, y: 196 },
    approveSpec: { x: 300, y: 376 },
  };

  it("overrides defaults with stored positions and drops unknown ids", () => {
    expect(
      mergeLayout(defaults, {
        writeSpec: { x: 10, y: 20 },
        leftover: { x: 1, y: 2 },
      }),
    ).toEqual({
      writeSpec: { x: 10, y: 20 },
      approveSpec: { x: 300, y: 376 },
    });
  });

  it("returns the defaults when nothing is stored", () => {
    expect(mergeLayout(defaults, {})).toEqual(defaults);
  });
});

describe("parseStoredLayout", () => {
  it("keeps finite x/y pairs and drops anything else", () => {
    expect(
      parseStoredLayout({
        writeSpec: { x: 10, y: 20 },
        approveSpec: { x: "no", y: 1 },
        schedule: { x: 1 },
        review: null,
        implementTicket: { x: Number.NaN, y: 0 },
      }),
    ).toEqual({ writeSpec: { x: 10, y: 20 } });
  });

  it("returns empty for non-objects", () => {
    expect(parseStoredLayout(null)).toEqual({});
    expect(parseStoredLayout("nope")).toEqual({});
    expect(parseStoredLayout([{ x: 1, y: 2 }])).toEqual({});
  });
});

describe("edgePath", () => {
  const source = { x: 300, y: 196, w: 280, h: 80 };
  const target = { x: 300, y: 376, w: 280, h: 80 };

  it("routes downward elbows through a mid-Y horizontal", () => {
    expect(edgePath(source, target, "ortho")).toEqual({
      d: "M 440 276 L 440 326 L 440 326 L 440 376",
      lx: 446,
      ly: 326,
    });
  });

  it("draws a straight segment between the facing edges", () => {
    expect(edgePath(source, target, "straight")).toEqual({
      d: "M 440 276 L 440 376",
      lx: 446,
      ly: 326,
    });
  });

  it("leaves the top of the source when the target sits above", () => {
    expect(edgePath(target, source, "ortho").d).toBe(
      "M 440 376 L 440 326 L 440 326 L 440 276",
    );
  });
});

describe("zoomAtCursor", () => {
  it("keeps the world point under the cursor stationary", () => {
    expect(zoomAtCursor({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100 }, 2)).toEqual({
      x: -100,
      y: -100,
      zoom: 2,
    });
  });

  it("clamps at the zoom ceiling and does not shift the view", () => {
    expect(zoomAtCursor({ x: 8, y: 8, zoom: 2.5 }, { x: 40, y: 40 }, 2)).toEqual({
      x: 8,
      y: 8,
      zoom: 2.5,
    });
  });
});

describe("strokeWidthForZoom", () => {
  it("keeps a 1.5px stroke visually constant", () => {
    expect(strokeWidthForZoom(2)).toBe(0.75);
    expect(strokeWidthForZoom(0.5)).toBe(3);
  });
});

describe("projectNodeChannels", () => {
  const values = {
    topic: "demo",
    packetSource: "stub",
    packet: "packet text",
    spec: "# Spec",
    specApproved: false,
    tickets: [
      { id: "T1", title: "first", blockedBy: [], status: "done" },
      { id: "T2", title: "second", blockedBy: ["T1"], status: "pending" },
      { id: "T3", title: "third", blockedBy: [], status: "running" },
    ],
    log: ["writeSpec: drafted"],
  };

  it("shows only the spec on approveSpec", () => {
    expect(projectNodeChannels("approveSpec", values).map((c) => c.name)).toEqual(["spec"]);
  });

  it("shows only pending tickets on deadlockGate", () => {
    const channels = projectNodeChannels("deadlockGate", values);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toEqual({
      name: "tickets",
      kind: "tickets",
      tickets: [{ id: "T2", title: "second", blockedBy: ["T1"], status: "pending" }],
    });
  });

  it("shows the ticket list on review", () => {
    const channels = projectNodeChannels("review", values);
    expect(channels.map((c) => c.name)).toEqual(["tickets"]);
    if (channels[0]?.kind === "tickets") {
      expect(channels[0].tickets.map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
    }
  });

  it("does not leak the log or unrelated channels onto a card", () => {
    const names = projectNodeChannels("writeSpec", values).map((c) => c.name);
    expect(names).toEqual(["spec"]);
    expect(names).not.toContain("log");
    expect(names).not.toContain("topic");
  });
});

describe("projectNodeCards", () => {
  const topology = projectTopology({
    nodes: [
      { id: "__start__" },
      { id: "writeSpec" },
      { id: "approveSpec" },
      { id: "schedule" },
    ],
    edges: [
      { source: "__start__", target: "writeSpec" },
      { source: "writeSpec", target: "approveSpec" },
      { source: "approveSpec", target: "schedule", conditional: true },
      { source: "approveSpec", target: "__end__", conditional: true },
    ],
  });

  it("renders every topology node, idle when no run has started", () => {
    const cards = projectNodeCards(topology, null);
    expect(cards.map((c) => c.id)).toEqual(["__start__", "writeSpec", "approveSpec", "schedule"]);
    expect(cards.every((c) => c.status === "idle")).toBe(true);
    expect(cards[0]?.name).toBe("START");
  });

  it("marks the latest updates node active and its unvisited targets next", () => {
    const run = play(initRun({ spec: "# Spec" }), [
      { event: "updates", data: { writeSpec: { spec: "# Spec" } } },
    ]);
    const byId = Object.fromEntries(projectNodeCards(topology, run).map((c) => [c.id, c]));
    expect(byId.writeSpec?.status).toBe("active");
    expect(byId.approveSpec?.status).toBe("next");
    expect(byId.__start__?.status).toBe("idle");
    expect(byId.schedule?.status).toBe("idle");
    expect(byId.approveSpec?.channels.map((c) => c.name)).toEqual(["spec"]);
  });

  it("marks earlier super-steps as ran once a later node is active", () => {
    const run = play(initRun(), [
      { event: "updates", data: { writeSpec: {} } },
      { event: "updates", data: { approveSpec: {} } },
    ]);
    const byId = Object.fromEntries(projectNodeCards(topology, run).map((c) => [c.id, c]));
    expect(byId.writeSpec?.status).toBe("ran");
    expect(byId.approveSpec?.status).toBe("active");
    expect(byId.schedule?.status).toBe("idle");
  });

  it("does not treat expanded conditional edges as next", () => {
    const run = play(initRun(), [{ event: "updates", data: { approveSpec: {} } }]);
    const byId = Object.fromEntries(projectNodeCards(topology, run).map((c) => [c.id, c]));
    expect(byId.approveSpec?.status).toBe("active");
    expect(byId.schedule?.status).toBe("idle");
    expect(byId.writeSpec?.status).toBe("idle");
  });

  it("puts the deadlock hint on the deadlockGate card", () => {
    const cards = projectNodeCards(
      { nodes: [{ id: "deadlockGate" }], edges: [] },
      initRun({
        tickets: [{ id: "T2", title: "second", blockedBy: ["T1"], status: "pending" }],
      }),
      {
        ns: [{ value: { kind: "deadlock", hint: "reload the pool or abort", pending: ["T2"] } }],
      },
    );
    expect(cards[0]?.channels).toEqual([
      {
        name: "tickets",
        kind: "tickets",
        tickets: [{ id: "T2", title: "second", blockedBy: ["T1"], status: "pending" }],
      },
      { name: "hint", kind: "text", text: "reload the pool or abort" },
    ]);
  });
});

const T1 = { id: "T1", title: "first", blockedBy: [], status: "done" as const };
const T2 = { id: "T2", title: "second", blockedBy: ["T1"], status: "pending" as const };

describe("projectInterruptForm", () => {
  it("projects an approve-spec payload onto the approveSpec form", () => {
    const form = projectInterruptForm(
      {
        graph: [
          {
            value: {
              kind: "approve-spec",
              spec: "# Spec",
              tickets: [T1, T2],
            },
          },
        ],
      },
      "approveSpec",
    );
    expect(form).toEqual({
      kind: "approve-spec",
      spec: "# Spec",
      tickets: [T1, T2],
      raw: { kind: "approve-spec", spec: "# Spec", tickets: [T1, T2] },
    });
  });

  it("projects a deadlock payload onto the deadlockGate form", () => {
    const form = projectInterruptForm(
      {
        ns: [
          {
            value: {
              kind: "deadlock",
              pending: ["T2"],
              hint: "no ticket can start; resume with reload to re-read the pool, or abort",
            },
          },
        ],
      },
      "deadlockGate",
    );
    expect(form).toEqual({
      kind: "deadlock",
      pending: ["T2"],
      hint: "no ticket can start; resume with reload to re-read the pool, or abort",
      raw: {
        kind: "deadlock",
        pending: ["T2"],
        hint: "no ticket can start; resume with reload to re-read the pool, or abort",
      },
    });
  });

  it("projects a review payload onto the review form with ticket ids for retry", () => {
    const tickets = [
      { id: "T1", title: "first", blockedBy: [], status: "done" as const },
      { id: "T3", title: "third", blockedBy: [], status: "done" as const },
    ];
    const form = projectInterruptForm({ graph: [{ value: { kind: "review", tickets } }] }, "review");
    expect(form?.kind).toBe("review");
    if (form?.kind === "review") {
      expect(form.tickets.map((t) => t.id)).toEqual(["T1", "T3"]);
    }
  });

  it("returns null when the node does not own a pending interrupt", () => {
    expect(projectInterruptForm({ graph: [{ value: { kind: "review", tickets: [] } }] }, "approveSpec")).toBeNull();
    expect(projectInterruptForm({}, "review")).toBeNull();
  });
});

describe("projectResume", () => {
  it("wraps reject as the Command resume that returns the run to writeSpec", () => {
    expect(projectResume({ action: "reject" })).toEqual({
      command: { resume: { action: "reject" } },
    });
  });

  it("wraps review retry with the chosen ticket ids", () => {
    expect(projectResume({ action: "retry", ids: ["T1", "T3"] })).toEqual({
      command: { resume: { action: "retry", ids: ["T1", "T3"] } },
    });
  });
});

describe("projectNodeCards interrupt status", () => {
  it("marks the owning card interrupted and attaches the form", () => {
    const cards = projectNodeCards(
      { nodes: [{ id: "approveSpec" }, { id: "writeSpec" }], edges: [] },
      play(initRun({ spec: "# Spec" }), [
        { event: "updates", data: { writeSpec: {} } },
        { event: "updates", data: { __interrupt__: [{ value: { kind: "approve-spec" } }] } },
      ]),
      {
        graph: [{ value: { kind: "approve-spec", spec: "# Spec", tickets: [T1] } }],
      },
    );
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    expect(byId.approveSpec?.status).toBe("interrupted");
    expect(byId.approveSpec?.interrupt?.kind).toBe("approve-spec");
    expect(byId.writeSpec?.status).toBe("ran");
    expect(byId.writeSpec?.interrupt).toBeNull();
  });

  it("after reject, a writeSpec updates part makes writeSpec active again", () => {
    const run = play(initRun(), [
      { event: "updates", data: { writeSpec: {} } },
      { event: "updates", data: { __interrupt__: [{ value: { kind: "approve-spec" } }] } },
      { event: "updates", data: { writeSpec: { spec: "rewritten" } } },
    ]);
    expect(projectNodes(run)).toEqual([
      { node: "writeSpec", status: "active" },
      { node: "approveSpec", status: "ran" },
    ]);
  });
});

describe("projectTicketCards", () => {
  const t1 = { id: "T1", title: "first", blockedBy: [] as string[], status: "running" as const };
  const t2 = { id: "T2", title: "second", blockedBy: ["T1"], status: "pending" as const };
  const t3 = { id: "T3", title: "third", blockedBy: [] as string[], status: "running" as const };

  it("spawns one card per ticket beside implementTicket with a schedule edge", () => {
    const cards = projectTicketCards(initRun({ tickets: [t1, t2, t3] }));
    expect(cards.map((c) => c.ticketId)).toEqual(["T1", "T2", "T3"]);
    expect(cards.map((c) => c.id)).toEqual(["ticket:T1", "ticket:T2", "ticket:T3"]);
    expect(cards.map((c) => c.x)).toEqual([640, 640, 640]);
    expect(cards.map((c) => c.y)).toEqual([736, 896, 1056]);
    expect(projectTicketEdges(cards)).toEqual([
      { source: "schedule", target: "ticket:T1" },
      { source: "schedule", target: "ticket:T2" },
      { source: "schedule", target: "ticket:T3" },
    ]);
  });

  it("tracks ticket status pending → running → done through values parts", () => {
    const ticket = (status: "pending" | "running" | "done") => ({
      id: "T1",
      title: "first",
      blockedBy: [] as string[],
      status,
    });
    let run = initRun({ tickets: [ticket("pending")] });
    expect(projectTicketCards(run)[0]?.status).toBe("pending");
    run = applyStreamPart(run, { event: "values", data: { tickets: [ticket("running")] } });
    expect(projectTicketCards(run)[0]?.status).toBe("running");
    run = applyStreamPart(run, { event: "values", data: { tickets: [ticket("done")] } });
    expect(projectTicketCards(run)[0]?.status).toBe("done");
  });

  it("keeps blockedBy on a pending card", () => {
    const cards = projectTicketCards(initRun({ tickets: [t2] }));
    expect(cards[0]?.blockedBy).toEqual(["T1"]);
    expect(cards[0]?.status).toBe("pending");
  });

  it("keeps done cards in the projection so they stay on the canvas", () => {
    const cards = projectTicketCards(
      initRun({
        tickets: [
          { id: "T1", title: "first", blockedBy: [], status: "done" },
          { id: "T3", title: "third", blockedBy: [], status: "done" },
        ],
      }),
    );
    expect(cards.map((c) => c.ticketId)).toEqual(["T1", "T3"]);
    expect(cards.every((c) => c.status === "done")).toBe(true);
  });

  it("returns no cards when there is no run or no tickets", () => {
    expect(projectTicketCards(null)).toEqual([]);
    expect(projectTicketCards(initRun())).toEqual([]);
    expect(projectTicketEdges([])).toEqual([]);
  });
});
