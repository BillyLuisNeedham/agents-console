/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { renderTerminalSurface, TerminalSurface } from "./terminal";
import type { EnrichedSnapshot, TerminalPeekResponse, TerminalSurfaceView } from "./project";
import { useDom } from "./test-dom";

// The store is fed by hand: update() with a snapshot, apply() with a live
// frame's peeks. The focus request is injected and parks until the test
// settles it, so nothing here fetches and no real 2s wait exists (issue
// #161).

const CONFIRM_MS = 5;

function snap(
  panes: Record<string, string | undefined>,
  conversationPanes: Record<string, string | undefined> = {},
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
      tickets: Object.entries(panes).map(([id, paneId]) => ({
        id,
        title: `ticket ${id}`,
        blockedBy: [],
        status: "in-progress" as const,
        mergeState: null,
        enlisted: false,
        assignment: { harness: null, model: null, drivers: "implement" },
        liveAttempt:
          paneId === undefined
            ? null
            : { attempt: 1, paneId, role: "agent" as const, startedAt: "2026-09-23T10:00:00.000Z" },
        heldPane: null,
        reassign: {
          eligible: paneId === undefined,
          reason: paneId === undefined ? null : "an Attempt is in flight",
          verify: null,
          sources: {
            harness: "default" as const,
            model: "default" as const,
            effort: "unset" as const,
            drivers: "default" as const,
          },
        },
      })),
      conversations: Object.entries(conversationPanes).map(([id, paneId]) => ({
        id,
        title: `conversation ${id}`,
        status: "live" as const,
        spawnedBy: null,
        assignment: { harness: null, model: null, drivers: "implement" },
        paneId: paneId ?? null,
        branch: null,
        turn: { state: "working" as const, lastLine: "", idleSince: null },
        children: [],
        enlisted: false,
        ending: false,
      })),
      log: [],
      outcomes: {},
      interrupts: [],
      mergeQueue: [],
      queuedAnswers: [],
      config: {},
    },
  };
}

function peek(ticket: string, paneId: string, text: string): TerminalPeekResponse {
  return { ticket, paneId, text };
}

interface Deferred {
  promise: Promise<unknown>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = () => res({ ok: true, paneId: "p" });
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  store: TerminalSurface;
  focused: string[];
  /** The focus requests still out, oldest first, for the test to settle. */
  focuses: Deferred[];
  changes: () => number;
}

function makeStore(
  panes: Record<string, string | undefined>,
  conversationPanes: Record<string, string | undefined> = {},
): Harness {
  const focused: string[] = [];
  const focuses: Deferred[] = [];
  let changes = 0;
  const store = new TerminalSurface({
    focus: (ticketId) => {
      focused.push(ticketId);
      const d = deferred();
      focuses.push(d);
      return d.promise;
    },
    onChange: () => {
      changes += 1;
    },
    confirmMs: CONFIRM_MS,
  });
  store.update(snap(panes, conversationPanes));
  return { store, focused, focuses, changes: () => changes };
}

describe("TerminalSurface store", () => {
  it("seeds a pending entry per terminal-backed ticket and stays off headless ones", () => {
    const h = makeStore({ "01": "pane-1", "02": undefined });
    const state = h.store.state();
    h.store.dispose();
    expect(Object.keys(state)).toEqual(["01"]);
    expect(state["01"]).toEqual({
      paneId: "pane-1",
      status: "pending",
      text: "",
      justFocused: false,
    });
  });

  it("seeds a live Conversation's pane, keyed by its own id, alongside ticket panes", () => {
    const h = makeStore({ "01": "pane-1" }, { "conv-1": "pane-c", "conv-2": undefined });
    const state = h.store.state();
    h.store.dispose();
    expect(Object.keys(state).sort()).toEqual(["01", "conv-1"]);
    expect(state["conv-1"]).toMatchObject({ paneId: "pane-c", status: "pending" });
  });

  it("drops a surface the moment its pane leaves the snapshot", () => {
    const h = makeStore({ "01": "pane-1", "02": "pane-2" }, { "conv-1": "pane-c" });
    h.store.update(snap({ "01": "pane-1", "02": undefined }));
    const state = h.store.state();
    h.store.dispose();
    expect(Object.keys(state)).toEqual(["01"]);
  });

  it("resets the surface to pending when the attempt re-spawns under a new pane id", () => {
    const h = makeStore({ "01": "pane-1" });
    h.store.apply({ "01": peek("01", "pane-1", "old output") });
    expect(h.store.state()["01"]).toMatchObject({ status: "live", text: "old output" });
    h.store.update(snap({ "01": "pane-9" }));
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]).toEqual({
      paneId: "pane-9",
      status: "pending",
      text: "",
      justFocused: false,
    });
  });

  it("shows a pushed peek live, an empty one waiting, and a failure unavailable", () => {
    const h = makeStore({ "01": "pane-1", "02": "pane-2", "03": "pane-3" });
    h.store.apply({
      "01": peek("01", "pane-1", "building..."),
      // An empty read (a background tab still warming up) is waiting,
      // never an error.
      "02": peek("02", "pane-2", ""),
      "03": { ticket: "03", error: "pane gone" },
    });
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]).toMatchObject({ status: "live", text: "building..." });
    expect(state["02"]).toMatchObject({ status: "waiting", text: "" });
    expect(state["03"]).toMatchObject({ status: "unavailable", text: "" });
  });

  it("recovers an unavailable pane on the next read that succeeds", () => {
    const h = makeStore({ "01": "pane-1" });
    h.store.apply({ "01": { ticket: "01", error: "daemon down" } });
    expect(h.store.state()["01"]!.status).toBe("unavailable");
    h.store.apply({ "01": peek("01", "pane-1", "back") });
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]).toMatchObject({ status: "live", text: "back" });
  });

  it("ignores a peek for an id it holds no surface for", () => {
    const h = makeStore({ "01": "pane-1" });
    h.store.apply({ "99": peek("99", "pane-9", "stray") });
    const state = h.store.state();
    h.store.dispose();
    expect(state["99"]).toBeUndefined();
    expect(h.changes()).toBe(0);
  });

  it("drops a read of a pane the attempt re-spawned away from", () => {
    const h = makeStore({ "01": "pane-new" });
    h.store.apply({ "01": peek("01", "pane-old", "stale output") });
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]).toMatchObject({ paneId: "pane-new", status: "pending", text: "" });
    expect(h.changes()).toBe(0);
  });

  it("repaints once per live frame, and only when a surface's status or text moved (#122)", () => {
    const h = makeStore({ "01": "pane-1", "02": "pane-2" });
    h.store.apply({ "01": peek("01", "pane-1", "a"), "02": peek("02", "pane-2", "b") });
    expect(h.changes()).toBe(1);
    // The same reads again: nothing moved, nothing repaints.
    h.store.apply({ "01": peek("01", "pane-1", "a"), "02": peek("02", "pane-2", "b") });
    expect(h.changes()).toBe(1);
    h.store.apply({ "02": peek("02", "pane-2", "c") });
    expect(h.changes()).toBe(2);
    // A failure is a move; the same failure again is not.
    h.store.apply({ "01": { ticket: "01", error: "gone" } });
    h.store.apply({ "01": { ticket: "01", error: "still gone" } });
    h.store.dispose();
    expect(h.changes()).toBe(3);
  });
});

describe("TerminalSurface focus, optimistic (issue #161)", () => {
  it("confirms and sends in the press's own turn, and holds the button while it is out", () => {
    const h = makeStore({ "01": "pane-1" });
    void h.store.focus("01");
    // Nothing awaited yet: the request is out and the card already says so.
    expect(h.focused).toEqual(["01"]);
    expect(h.changes()).toBe(1);
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]).toMatchObject({ justFocused: true, focusing: true, focusFailure: null });
  });

  it("resolves true on the accept and keeps the confirmation for its window", async () => {
    const h = makeStore({ "01": "pane-1" });
    const result = h.store.focus("01");
    h.focuses[0]!.resolve();
    expect(await result).toBe(true);
    const state = h.store.state();
    expect(state["01"]).toMatchObject({ justFocused: true });
    expect(state["01"]!.focusing).toBeFalsy();
    await Bun.sleep(CONFIRM_MS * 4);
    const after = h.store.state();
    h.store.dispose();
    expect(after["01"]!.justFocused).toBe(false);
  });

  it("takes the confirmation back on a refusal and puts the reason beside the button", async () => {
    const h = makeStore({ "01": "pane-1" });
    const result = h.store.focus("01");
    h.focuses[0]!.reject(new Error("pane p1 is not this pool's"));
    expect(await result).toBe(false);
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]).toMatchObject({
      justFocused: false,
      focusing: false,
      focusFailure: "pane p1 is not this pool's",
    });
  });

  it("a new press clears the last refusal's reason", async () => {
    const h = makeStore({ "01": "pane-1" });
    const first = h.store.focus("01");
    h.focuses[0]!.reject(new Error("refused"));
    await first;
    expect(h.store.state()["01"]!.focusFailure).toBe("refused");
    void h.store.focus("01");
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]).toMatchObject({ justFocused: true, focusFailure: null });
  });

  it("sends nothing for a second press while the first is out", async () => {
    const h = makeStore({ "01": "pane-1" });
    const first = h.store.focus("01");
    expect(await h.store.focus("01")).toBe(false);
    expect(h.focused).toEqual(["01"]);
    h.focuses[0]!.resolve();
    await first;
    h.store.dispose();
  });

  it("refuses to focus a ticket that holds no live pane", async () => {
    const h = makeStore({ "01": undefined });
    expect(await h.store.focus("01")).toBe(false);
    h.store.dispose();
    expect(h.focused).toEqual([]);
  });

  it("focuses a Conversation's pane by its own id", async () => {
    const h = makeStore({}, { "conv-1": "pane-conv" });
    const result = h.store.focus("conv-1");
    h.focuses[0]!.resolve();
    expect(await result).toBe(true);
    h.store.dispose();
    expect(h.focused).toEqual(["conv-1"]);
  });
});

// A Held pane (issue #139): the ticket's checkpointed Attempt is over, so it
// carries no Live attempt, but its TUI is still alive and the snapshot says
// which pane. The store treats it as a pane to show, keyed by ticket id,
// because the server resolves it for peek and focus the same way.
function held(snapshot: EnrichedSnapshot, ticketId: string, paneId: string): EnrichedSnapshot {
  for (const ticket of snapshot.state.tickets) {
    if (ticket.id !== ticketId) continue;
    ticket.status = "checkpoint";
    ticket.liveAttempt = null;
    ticket.heldPane = { attempt: 1, paneId };
  }
  return snapshot;
}

describe("TerminalSurface store over a Held pane (issue #139)", () => {
  it("shows and focuses a checkpointed ticket's Held pane by ticket id", async () => {
    const h = makeStore({});
    h.store.update(held(snap({ "01": "pane-7" }), "01", "pane-7"));
    h.store.apply({ "01": peek("01", "pane-7", "held output") });
    expect(h.store.state()["01"]).toMatchObject({ paneId: "pane-7", status: "live" });
    const result = h.store.focus("01");
    h.focuses[0]!.resolve();
    expect(await result).toBe(true);
    h.store.dispose();
    expect(h.focused).toEqual(["01"]);
  });

  it("keeps the surface when the Held pane continues as a Live attempt in the same pane", () => {
    const h = makeStore({});
    h.store.update(held(snap({ "01": "pane-7" }), "01", "pane-7"));
    h.store.apply({ "01": peek("01", "pane-7", "held output") });
    // Keep talking: the Continued attempt runs in the pane the checkpoint
    // held, so the surface carries on rather than flashing back to pending.
    h.store.update(snap({ "01": "pane-7" }));
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]).toMatchObject({ paneId: "pane-7", status: "live" });
  });

  it("drops the surface once the ticket has neither a Live attempt nor a Held pane", () => {
    const h = makeStore({});
    h.store.update(held(snap({ "01": "pane-7" }), "01", "pane-7"));
    // Resume answered the checkpoint (or the pane closed): nothing to show.
    h.store.update(snap({ "01": undefined }));
    h.store.apply({ "01": peek("01", "pane-7", "late read") });
    const state = h.store.state();
    h.store.dispose();
    expect(state["01"]).toBeUndefined();
  });
});

describe("renderTerminalSurface", () => {
  useDom();

  const view: TerminalSurfaceView = {
    paneId: "pane-1",
    status: "live",
    text: "output",
    justFocused: false,
  };

  it("labels the focus button Open in herdr, with no in-flight wording", () => {
    const el = renderTerminalSurface({ ...view, focusing: true }, { onFocus: async () => true });
    const button = el.querySelector<HTMLButtonElement>(".terminal-focus")!;
    expect(button.textContent).toBe("Open in herdr");
    expect(button.disabled).toBe(true);
    expect(el.querySelector(".terminal-focus-failure")).toBeNull();
  });

  it("shows the confirmation the moment the press lands", () => {
    const el = renderTerminalSurface({ ...view, justFocused: true }, { onFocus: async () => true });
    expect(el.querySelector(".terminal-note")?.textContent).toBe("focused in herdr");
  });

  it("puts a refused focus's reason beside the button", () => {
    const el = renderTerminalSurface(
      { ...view, focusFailure: "pane gone" },
      { onFocus: async () => false },
    );
    expect(el.querySelector(".terminal-focus")!.textContent).toBe("Open in herdr");
    expect(el.querySelector(".terminal-focus-failure")?.textContent).toBe("pane gone");
  });
});
