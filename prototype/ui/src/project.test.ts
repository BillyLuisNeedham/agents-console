/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { Thread } from "@langchain/langgraph-sdk";
import {
  projectChannels,
  projectLog,
  projectThreadSummary,
  visibleThreads,
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
