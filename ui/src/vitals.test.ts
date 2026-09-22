/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { Vitals } from "./vitals";
import type { EnrichedSnapshot, TicketActivityResponse, TicketStatus } from "./project";

// The store's cadence logic drives through update() and a short poll
// interval; the fetch is injected, so no server and no real 2s wait exists.

const POLL_MS = 5;

function snap(tickets: Record<string, TicketStatus>): EnrichedSnapshot {
  return {
    seq: 1,
    phase: "running",
    poolName: "repo/pool",
    poolDir: "/tmp/pool",
    state: {
      tickets: Object.entries(tickets).map(([id, status]) => ({
        id,
        title: `ticket ${id}`,
        blockedBy: [],
        status,
        mergePending: false,
        enlisted: false,
        assignment: { harness: null, model: null, drivers: "implement" },
        liveAttempt: null,
        reassign: {
          eligible: status !== "done",
          reason: null,
          verify: null,
          sources: {
            harness: "default" as const,
            model: "default" as const,
            drivers: "default" as const,
          },
        },
      })),
      conversations: [],
      log: [],
      outcomes: {},
      interrupts: [],
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
