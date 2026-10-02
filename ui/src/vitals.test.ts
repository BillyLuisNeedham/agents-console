/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { Vitals } from "./vitals";
import type { EnrichedSnapshot, TicketActivityResponse, TicketStatus } from "./project";

// The store's cadence logic drives through update() and a short poll
// interval; the fetch is injected, so no server and no real 2s wait exists.

const POLL_MS = 5;

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

function response(running: boolean, total = 10): TicketActivityResponse {
  return {
    ticketId: "x",
    running,
    diff: { added: total, removed: 0, files: ["a"] },
    log: { size: 8, mtime: new Date().toISOString() },
    lastEventAt: new Date().toISOString(),
  };
}

interface Harness {
  store: Vitals;
  fetched: string[];
}

function makeStore(
  tickets: Record<string, TicketStatus>,
  respond: (ticketId: string) => Promise<TicketActivityResponse>,
): Harness {
  const fetched: string[] = [];
  const store = new Vitals({
    fetch: (ticketId) => {
      fetched.push(ticketId);
      return respond(ticketId);
    },
    onChange: () => {},
    pollMs: POLL_MS,
  });
  store.update(snap(tickets));
  return { store, fetched };
}

async function ticks(n = 4): Promise<void> {
  await Bun.sleep(POLL_MS * n);
}

describe("Vitals store", () => {
  it("polls only the tickets that can hold a live attempt", async () => {
    const h = makeStore(
      { "01": "in-progress", "02": "checkpoint", "03": "done", "04": "ready" },
      () => Promise.resolve(response(true)),
    );
    await ticks();
    h.store.dispose();
    expect(new Set(h.fetched)).toEqual(new Set(["01", "02"]));
  });

  it("polls a done ticket while the engine marks its live attempt a resolver (#129)", async () => {
    const fetched: string[] = [];
    const store = new Vitals({
      fetch: (ticketId) => {
        fetched.push(ticketId);
        return Promise.resolve(response(true));
      },
      onChange: () => {},
      pollMs: POLL_MS,
    });
    store.update(snap({ "02": "done", "04": "done" }, ["02"]));
    await ticks();
    store.dispose();
    expect(new Set(fetched)).toEqual(new Set(["02"]));
    expect(fetched.length).toBeGreaterThan(1);
  });

  it("drops a ticket from the cadence once its response says nothing is live", async () => {
    const h = makeStore(
      { "01": "checkpoint" },
      () => Promise.resolve(response(false)),
    );
    await ticks();
    const afterFirst = h.fetched.length;
    await ticks();
    h.store.dispose();
    expect(afterFirst).toBe(1);
    expect(h.fetched.length).toBe(afterFirst);
  });

  it("keeps polling a live ticket on the cadence, one sample pushed per poll", async () => {
    const h = makeStore(
      { "01": "in-progress" },
      () => Promise.resolve(response(true, 30)),
    );
    await ticks();
    h.store.dispose();
    const polls = h.fetched.filter((id) => id === "01").length;
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(h.store.state()["01"]?.samples).toEqual(
      Array.from({ length: polls }, () => 30),
    );
  });

  it("a slow response for one ticket never delays the others", async () => {
    const gate: { release: ((value: TicketActivityResponse) => void) | null } = {
      release: null,
    };
    const h = makeStore(
      { "01": "in-progress", "02": "in-progress" },
      (ticketId) =>
        ticketId === "01"
          ? new Promise<TicketActivityResponse>((resolve) => {
              gate.release = resolve;
            })
          : Promise.resolve(response(true)),
    );
    await ticks();
    h.store.dispose();
    // 01 is still in flight, so it was fetched exactly once while 02 kept
    // polling every tick.
    expect(h.fetched.filter((id) => id === "01")).toHaveLength(1);
    expect(h.fetched.filter((id) => id === "02").length).toBeGreaterThanOrEqual(2);
    expect(gate.release).not.toBeNull();
    gate.release?.(response(false));
  });

  it("refetches every candidate on each snapshot, re-arming stopped tickets", async () => {
    let running = false;
    const h = makeStore({ "01": "checkpoint" }, () =>
      Promise.resolve(response(running)),
    );
    await ticks();
    const stoppedPolls = h.fetched.length;
    expect(stoppedPolls).toBe(1);
    // A resolver starts on the checkpointed ticket: its snapshot refetch
    // reports running, and the ticket rejoins the cadence.
    running = true;
    h.store.update(snap({ "01": "checkpoint" }));
    await ticks();
    h.store.dispose();
    expect(h.fetched.length).toBeGreaterThan(stoppedPolls);
    expect(h.store.state()["01"]?.activity.running).toBe(true);
  });

  it("a burst of snapshots never stacks fetches: one out, one more after it (#157)", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const fetched: string[] = [];
    const store = new Vitals({
      fetch: (ticketId) => {
        fetched.push(ticketId);
        return fetched.length === 1
          ? new Promise<TicketActivityResponse>((resolve) => {
              gate.release = () => resolve(response(false));
            })
          : Promise.resolve(response(false));
      },
      onChange: () => {},
      pollMs: 1_000,
    });
    for (let i = 0; i < 5; i++) store.update(snap({ "01": "checkpoint" }));
    expect(fetched).toEqual(["01"]);
    gate.release?.();
    // The owed refetch waits out half the interval from the first fetch's start.
    await Bun.sleep(600);
    store.dispose();
    expect(fetched).toEqual(["01", "01"]);
  });

  it("repaints on an answer only when it moved what the card shows (#157)", async () => {
    // One payload, byte for byte, every time.
    const fixed: TicketActivityResponse = {
      ticketId: "x",
      running: false,
      diff: null,
      log: { size: 8, mtime: "2026-09-01T10:00:00.000Z" },
      lastEventAt: "2026-09-01T10:00:00.000Z",
    };
    let changes = 0;
    const fetched: string[] = [];
    const store = new Vitals({
      fetch: (ticketId) => {
        fetched.push(ticketId);
        return Promise.resolve(fixed);
      },
      onChange: () => {
        changes += 1;
      },
      pollMs: 20,
    });
    // No staleness tick in this test: only the snapshot refetches run.
    store.dispose();
    store.update(snap({ "01": "checkpoint" }));
    await Bun.sleep(1);
    expect(changes).toBe(1);
    // Past the throttle's gap, the next snapshot refetches; the same answer
    // again moves nothing on the card.
    await Bun.sleep(15);
    store.update(snap({ "01": "checkpoint" }));
    await Bun.sleep(1);
    expect(fetched).toEqual(["01", "01"]);
    expect(changes).toBe(1);
  });

  it("the staleness tick repaints only when the copy it would show moves (#157)", async () => {
    let changes = 0;
    const store = new Vitals({
      fetch: () => Promise.resolve(response(false)),
      onChange: () => {
        changes += 1;
      },
      pollMs: POLL_MS,
    });
    store.update(snap({ "01": "checkpoint" }));
    await Bun.sleep(1);
    const afterAnswer = changes;
    // Ten ticks inside one wall-clock second: the "Ns ago" copy moves at most
    // once, so at most two of them repaint (the first, and one crossing).
    await ticks(10);
    store.dispose();
    expect(changes - afterAnswer).toBeGreaterThanOrEqual(1);
    expect(changes - afterAnswer).toBeLessThanOrEqual(2);
  });

  it("prunes payloads and samples when a ticket leaves the pool", async () => {
    const h = makeStore(
      { "01": "in-progress", "02": "checkpoint" },
      () => Promise.resolve(response(true)),
    );
    await ticks();
    h.store.update(snap({ "02": "checkpoint" }));
    await ticks();
    h.store.dispose();
    expect(h.store.state()["01"]).toBeUndefined();
    expect(h.store.state()["02"]).toBeDefined();
  });
});
