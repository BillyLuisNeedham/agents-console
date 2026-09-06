/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { TerminalSurface } from "./terminal";
import type {
  PoolSnapshot,
  TerminalPeekResponse,
} from "./project";

// The store's cadence logic drives through update() and a short poll
// interval; the peek and focus fetches are injected, so no server and no
// real 2s wait exists.

const POLL_MS = 5;
const CONFIRM_MS = 5;

function snap(panes: Record<string, string | undefined>): PoolSnapshot {
  return {
    seq: 1,
    phase: "running",
    poolName: "repo/pool",
    state: {
      tickets: Object.entries(panes).map(([id, paneId]) => ({
        id,
        title: `ticket ${id}`,
        blockedBy: [],
        status: "in-progress",
        assignment: { harness: null, model: null, drivers: "implement" },
        ...(paneId === undefined ? {} : { paneId }),
      })),
      log: [],
      outcomes: {},
      interrupts: [],
      queuedAnswers: [],
      config: {},
    },
  };
}

function peekResponse(text: string): TerminalPeekResponse {
  return { ticket: "x", paneId: "pane-x", text };
}

interface Harness {
  store: TerminalSurface;
  peeked: string[];
  focused: string[];
  failPeek: Set<string>;
}

function makeStore(
  panes: Record<string, string | undefined>,
  options: { failPeek?: Set<string> } = {},
): Harness {
  const peeked: string[] = [];
  const focused: string[] = [];
  const failPeek = options.failPeek ?? new Set<string>();
  const store = new TerminalSurface({
    peek: (ticketId) => {
      peeked.push(ticketId);
      if (failPeek.has(ticketId)) {
        return Promise.reject(new Error("peek failed"));
      }
      return Promise.resolve(peekResponse(`output for ${ticketId}`));
    },
    focus: (ticketId) => {
      focused.push(ticketId);
      return Promise.resolve();
    },
    onChange: () => {},
    pollMs: POLL_MS,
    confirmMs: CONFIRM_MS,
  });
  store.update(snap(panes));
  return { store, peeked, focused, failPeek };
}

async function ticks(n = 4): Promise<void> {
  await Bun.sleep(POLL_MS * n);
}

describe("TerminalSurface store", () => {
  it("peeks terminal-backed tickets immediately and stays off headless ones", async () => {
    const h = makeStore({ "01": "pane-7", "02": undefined });
    // The first peek fires on the snapshot, before any poll tick.
    expect(h.peeked).toEqual(["01"]);
    await ticks();
    h.store.dispose();
    expect(h.peeked.every((id) => id === "01")).toBe(true);
    expect(h.store.state()["02"]).toBeUndefined();
  });

  it("seeds a pending entry so the surface renders before the first peek lands", async () => {
    const h = makeStore({ "01": "pane-7" });
    // Synchronous state, straight after update: the shell is already there.
    expect(h.store.state()["01"]).toEqual({
      paneId: "pane-7",
      status: "pending",
      text: "",
      justFocused: false,
    });
    await ticks();
    h.store.dispose();
  });

  it("keeps polling a live ticket on the cadence", async () => {
    const h = makeStore({ "01": "pane-7" });
    await ticks();
    h.store.dispose();
    expect(h.peeked.filter((id) => id === "01").length).toBeGreaterThanOrEqual(2);
    expect(h.store.state()["01"]?.status).toBe("live");
    expect(h.store.state()["01"]?.text).toBe("output for 01");
  });

  it("stops polling the moment the pane leaves the snapshot (attempt ended)", async () => {
    const h = makeStore({ "01": "pane-7" });
    await ticks();
    h.store.update(snap({ "01": undefined }));
    const pollsAtEnd = h.peeked.length;
    expect(h.store.state()["01"]).toBeUndefined();
    await ticks();
    h.store.dispose();
    expect(h.peeked.length).toBe(pollsAtEnd);
  });

  it("treats an empty read as waiting, not an error", async () => {
    const peeked: string[] = [];
    const store = new TerminalSurface({
      peek: () => {
        peeked.push("x");
        return Promise.resolve(peekResponse(""));
      },
      focus: () => Promise.resolve(),
      onChange: () => {},
      pollMs: POLL_MS,
      confirmMs: CONFIRM_MS,
    });
    store.update(snap({ "01": "pane-7" }));
    await ticks();
    store.dispose();
    expect(store.state()["01"]?.status).toBe("waiting");
    expect(store.state()["01"]?.text).toBe("");
  });

  it("marks a failed peek unavailable and keeps polling, recovering on the next success", async () => {
    const h = makeStore({ "01": "pane-7" }, { failPeek: new Set(["01"]) });
    await ticks();
    expect(h.store.state()["01"]?.status).toBe("unavailable");
    h.failPeek.clear();
    await ticks();
    h.store.dispose();
    expect(h.peeked.filter((id) => id === "01").length).toBeGreaterThanOrEqual(2);
    expect(h.store.state()["01"]?.status).toBe("live");
  });

  it("resets the surface to pending when the attempt re-spawns under a new pane id", async () => {
    const h = makeStore({ "01": "pane-7" });
    await ticks();
    expect(h.store.state()["01"]?.status).toBe("live");
    h.store.update(snap({ "01": "pane-8" }));
    expect(h.store.state()["01"]).toEqual({
      paneId: "pane-8",
      status: "pending",
      text: "",
      justFocused: false,
    });
    await ticks();
    h.store.dispose();
    expect(h.store.state()["01"]).toMatchObject({ paneId: "pane-8", status: "live" });
  });

  it("confirms a successful focus transiently", async () => {
    const h = makeStore({ "01": "pane-7" });
    await ticks();
    expect(await h.store.focus("01")).toBe(true);
    expect(h.store.state()["01"]?.justFocused).toBe(true);
    await Bun.sleep(CONFIRM_MS * 4);
    h.store.dispose();
    expect(h.store.state()["01"]?.justFocused).toBe(false);
  });

  it("focus failure leaves the card untouched and resolves false", async () => {
    const peeked: string[] = [];
    const store = new TerminalSurface({
      peek: (ticketId) => {
        peeked.push(ticketId);
        return Promise.resolve(peekResponse("output"));
      },
      focus: () => Promise.reject(new Error("daemon gone")),
      onChange: () => {},
      pollMs: POLL_MS,
      confirmMs: CONFIRM_MS,
    });
    store.update(snap({ "01": "pane-7" }));
    await ticks();
    expect(await store.focus("01")).toBe(false);
    store.dispose();
    expect(store.state()["01"]?.justFocused).toBe(false);
    expect(store.state()["01"]?.status).toBe("live");
  });

  it("refuses to focus a ticket that no longer holds a live pane", async () => {
    const h = makeStore({ "01": "pane-7" });
    await ticks();
    h.store.update(snap({ "01": undefined }));
    expect(await h.store.focus("01")).toBe(false);
    h.store.dispose();
    expect(h.focused).toEqual([]);
  });
});
