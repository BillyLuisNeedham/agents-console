/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { Vitals } from "./vitals";
import type { EnrichedSnapshot, TicketActivityResponse, TicketStatus } from "./project";

// The store is fed by hand: update() with a snapshot, apply() with a live
// frame's activity, and tick(now) for the wall-clock tick, whose own timer
// is pushed out of every test's way. Nothing here fetches (issue #161).

const NEVER_MS = 60_000;

function snap(
  tickets: Record<string, TicketStatus>,
  resolvers: string[] = [],
): EnrichedSnapshot {
  return {
    seq: 1,
    phase: "running",
    poolName: "repo/pool",
    poolTitle: null,
    poolDir: "/tmp/pool",
    finishedTerminals: 0,
    spawnUsage: { spawnedThisRun: 0, perAttempt: 5, perRun: 20 },
    pendingSpawns: [],
    heldSpawns: [],
    state: {
      tickets: Object.entries(tickets).map(([id, status]) => ({
        id,
        title: `ticket ${id}`,
        blockedBy: [],
        status,
        mergeState: resolvers.includes(id) ? ("resolving" as const) : null,
        enlisted: false,
        assignment: { harness: null, model: null, drivers: "implement" },
        liveAttempt: resolvers.includes(id)
          ? {
              attempt: 2,
              paneId: null,
              role: "resolver" as const,
              startedAt: new Date().toISOString(),
            }
          : null,
        heldPane: null,
        reassign: {
          eligible: status !== "done",
          reason: null,
          verify: null,
          sources: {
            harness: "default" as const,
            model: "default" as const,
            effort: "unset" as const,
            drivers: "default" as const,
          },
        },
      })),
      conversations: [],
      log: [],
      outcomes: {},
      interrupts: [],
      mergeQueue: [],
      queuedAnswers: [],
      config: {},
    },
  };
}

// A fixed moment the payloads are stamped at, so a tick's copy depends only
// on the `now` a test hands it.
const AT = Date.parse("2026-10-02T10:00:00.000Z");

function response(running: boolean, total = 10, ticketId = "x"): TicketActivityResponse {
  return {
    ticketId,
    running,
    diff: { added: total, removed: 0, files: ["a"] },
    log: { size: 8, mtime: new Date(AT).toISOString() },
    lastEventAt: new Date(AT).toISOString(),
  };
}

interface Harness {
  store: Vitals;
  changes: () => number;
}

function makeStore(tickets: Record<string, TicketStatus>, resolvers: string[] = []): Harness {
  let changes = 0;
  const store = new Vitals({
    onChange: () => {
      changes += 1;
    },
    tickMs: NEVER_MS,
  });
  store.update(snap(tickets, resolvers));
  return { store, changes: () => changes };
}

describe("Vitals store", () => {
  it("holds the payloads a live frame carries and sends nothing of its own", () => {
    const h = makeStore({ "01": "in-progress" });
    h.store.apply({ "01": response(true, 4) });
    const state = h.store.state();
    h.store.dispose();
    expect(Object.keys(state)).toEqual(["01"]);
    expect(state["01"]!.activity.running).toBe(true);
    // No sample until the tick takes one.
    expect(state["01"]!.samples).toEqual([]);
  });

  it("samples only the tickets that can hold a live attempt", () => {
    const h = makeStore({ "01": "in-progress", "02": "checkpoint", "03": "ready", "04": "done" });
    h.store.apply({
      "01": response(true, 1),
      "02": response(true, 2),
      "03": response(true, 3),
      "04": response(true, 4),
    });
    h.store.tick(AT + 1_000);
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]!.samples).toEqual([1]);
    expect(state["02"]!.samples).toEqual([2]);
    expect(state["03"]!.samples).toEqual([]);
    expect(state["04"]!.samples).toEqual([]);
  });

  it("samples a done ticket while the engine marks its live attempt a resolver (#129)", () => {
    const h = makeStore({ "01": "done", "02": "done" }, ["01"]);
    h.store.apply({ "01": response(true, 6), "02": response(true, 6) });
    h.store.tick(AT + 1_000);
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]!.samples).toEqual([6]);
    expect(state["02"]!.samples).toEqual([]);
  });

  it("takes one sample per tick from the held payload, and none while it says nothing runs", () => {
    const h = makeStore({ "01": "in-progress", "02": "checkpoint" });
    h.store.apply({ "01": response(true, 3), "02": response(false, 9) });
    h.store.tick(AT + 1_000);
    h.store.apply({ "01": response(true, 5) });
    h.store.tick(AT + 3_000);
    h.store.tick(AT + 5_000);
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]!.samples).toEqual([3, 5, 5]);
    expect(state["02"]!.samples).toEqual([]);
  });

  it("repaints once per live frame, and only when a payload actually changed", () => {
    const h = makeStore({ "01": "in-progress", "02": "in-progress" });
    h.store.apply({ "01": response(true, 3), "02": response(true, 4) });
    expect(h.changes()).toBe(1);
    // The same payloads again: nothing moved, nothing repaints.
    h.store.apply({ "01": response(true, 3), "02": response(true, 4) });
    expect(h.changes()).toBe(1);
    h.store.apply({ "02": response(true, 7) });
    h.store.dispose();
    expect(h.changes()).toBe(2);
  });

  it("the tick repaints when a sparkline moved", () => {
    const h = makeStore({ "01": "in-progress" });
    h.store.apply({ "01": response(true, 3) });
    const before = h.changes();
    // The same moment twice: the copy holds, but the sparkline grows.
    h.store.tick(AT + 1_000);
    h.store.tick(AT + 1_000);
    h.store.dispose();
    expect(h.changes()).toBe(before + 2);
  });

  it("the tick repaints when the staleness copy moved, and not when neither moved (#157)", () => {
    // A frozen checkpoint: no samples, so only the copy can move.
    const h = makeStore({ "01": "checkpoint" });
    h.store.apply({ "01": response(false, 3) });
    const before = h.changes();
    h.store.tick(AT + 5_000);
    expect(h.changes()).toBe(before + 1);
    // The same moment again draws the same words: nothing to repaint.
    h.store.tick(AT + 5_000);
    expect(h.changes()).toBe(before + 1);
    // Minutes later the copy reads differently.
    h.store.tick(AT + 5 * 60_000);
    h.store.dispose();
    expect(h.changes()).toBe(before + 2);
  });

  it("a full sparkline of one unchanged total stops repainting", () => {
    const h = makeStore({ "01": "checkpoint" });
    // A checkpoint whose resolver runs: live, so it samples, and the copy
    // stays put at one moment.
    h.store.apply({ "01": response(true, 3) });
    for (let i = 0; i < 60; i += 1) h.store.tick(AT + 1_000);
    const before = h.changes();
    h.store.tick(AT + 1_000);
    h.store.dispose();
    expect(h.changes()).toBe(before);
  });

  it("never repaints on a tick with nothing to show", () => {
    const h = makeStore({ "01": "ready" });
    h.store.tick(AT + 1_000);
    h.store.tick(AT + 60_000);
    h.store.dispose();
    expect(h.changes()).toBe(0);
  });

  it("prunes payloads and samples when a ticket leaves the pool", () => {
    const h = makeStore({ "01": "in-progress", "02": "in-progress" });
    h.store.apply({ "01": response(true, 1), "02": response(true, 2) });
    h.store.tick(AT + 1_000);
    h.store.update(snap({ "02": "in-progress" }));
    const state = h.store.state();
    h.store.dispose();
    expect(Object.keys(state)).toEqual(["02"]);
    expect(state["02"]!.samples).toEqual([2]);
  });

  it("stops sampling a ticket the snapshot moved off the candidates", () => {
    const h = makeStore({ "01": "in-progress" });
    h.store.apply({ "01": response(true, 1) });
    h.store.tick(AT + 1_000);
    h.store.update(snap({ "01": "done" }));
    h.store.tick(AT + 3_000);
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]!.samples).toEqual([1]);
  });
});
