/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { Thread } from "@langchain/langgraph-sdk";
import {
  applyStreamPart,
  initRun,
  projectChannels,
  projectLog,
  projectNodes,
  projectThreadSummary,
  syncRunValues,
  visibleThreads,
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
