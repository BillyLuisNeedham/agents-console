/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { ConsoleSession, type ConsoleSessionOptions } from "./session";
import {
  projectPool,
  type GradeView,
  type PoolConversationState,
  type PoolSnapshot,
  type PoolTicketState,
  type TicketBodyResponse,
  type TicketEventsResponse,
} from "./project";

function ticket(
  id: string,
  overrides: Partial<PoolTicketState> = {},
): PoolTicketState {
  return {
    id,
    title: `ticket ${id}`,
    blockedBy: [],
    status: "ready",
    assignment: { harness: null, model: null, drivers: "implement" },
    ...overrides,
  };
}

function conversation(
  id: string,
  overrides: Partial<PoolConversationState> = {},
): PoolConversationState {
  return {
    id,
    title: `conversation ${id}`,
    status: "live",
    spawnedBy: null,
    assignment: { harness: null, model: null, drivers: "implement" },
    paneId: null,
    branch: null,
    turn: { state: "working", lastLine: "", idleSince: null },
    children: [],
    ...overrides,
  };
}

function snapshot(
  overrides: Omit<Partial<PoolSnapshot>, "state"> & {
    state?: Partial<PoolSnapshot["state"]>;
  } = {},
): PoolSnapshot {
  return {
    seq: 0,
    phase: "running",
    poolName: "repo/pool",
    ...overrides,
    state: {
      tickets: [],
      log: [],
      outcomes: {},
      interrupts: [],
      queuedAnswers: [],
      config: {},
      ...overrides.state,
    },
  };
}

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

/** Let the session's settled-fetch continuations run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function eventsResponse(kind: string): TicketEventsResponse {
  return {
    events: [{ at: "2026-09-12T10:00:00Z", attempt: 1, kind, payload: {} }],
    attempts: [],
    reconstructed: false,
    spec: "",
  };
}

/**
 * A rig of hand-settled fake seams: every fetch parks on a per-id deferred
 * the test settles when it chooses, the projection is spy-counted, and
 * onChange calls are counted, so a test pins dispatch order and repaint
 * cadence before any outcome lands.
 */
function rig() {
  const events = new Map<string, Deferred<TicketEventsResponse>[]>();
  const bodies = new Map<string, Deferred<TicketBodyResponse | null>[]>();
  const logCalls: string[] = [];
  let projectCalls = 0;
  let changes = 0;
  const options: ConsoleSessionOptions = {
    getState: () => Promise.resolve(null),
    getEvents: (id) => {
      const d = deferred<TicketEventsResponse>();
      const list = events.get(id) ?? [];
      list.push(d);
      events.set(id, list);
      return d.promise;
    },
    getTicket: (id) => {
      const d = deferred<TicketBodyResponse | null>();
      const list = bodies.get(id) ?? [];
      list.push(d);
      bodies.set(id, list);
      return d.promise;
    },
    getGrades: () => Promise.resolve({} as Record<string, GradeView>),
    getLog: (ticketId) => {
      logCalls.push(ticketId);
      return new Promise(() => {});
    },
    answer: () => Promise.resolve(snapshot()),
    stream: () => () => {},
    vitals: { update: () => {}, state: () => ({}) },
    terminal: { update: () => {}, state: () => ({}) },
    projectPool: (...args) => {
      projectCalls += 1;
      return projectPool(...args);
    },
    onChange: () => {
      changes += 1;
    },
  };
  return {
    options,
    events,
    bodies,
    logCalls,
    projectCalls: () => projectCalls,
    changes: () => changes,
  };
}

describe("one derivation per cycle", () => {
  it("runs projectPool once for a snapshot's render, Detail included", () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(snapshot({ state: { tickets: [ticket("A")] } }));
    session.model({});
    expect(r.projectCalls()).toBe(1);
    // The Detail reads the same derivation: a selection and a re-render add
    // exactly one more derivation, not a second one hidden inside it.
    session.select("ticket:A");
    const model = session.model({});
    expect(model.detail?.kind).toBe("ticket");
    expect(r.projectCalls()).toBe(2);
  });
});

describe("selection", () => {
  it("fetches the selected ticket's events and body", () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(snapshot({ state: { tickets: [ticket("A")] } }));
    session.model({});
    session.select("ticket:A");
    expect(r.events.get("A")).toHaveLength(1);
    expect(r.bodies.get("A")).toHaveLength(1);
  });

  it("fetches a Conversation's events through the same path, without a log pane or a body", async () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(
      snapshot({ state: { conversations: [conversation("c1")] } }),
    );
    session.model({});
    session.select("conversation:c1");
    expect(r.events.get("c1")).toHaveLength(1);
    expect(r.bodies.has("c1")).toBe(false);
    r.events.get("c1")![0].resolve(eventsResponse("spawned"));
    await flush();
    const model = session.model({});
    expect(model.timeline?.attempts[0]?.running).toBe(true);
    expect(session.logs.state.ticketId).toBe(null);
    expect(r.logCalls).toHaveLength(0);
  });

  it("clears the timeline and the log pane when the selection clears", async () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(snapshot({ state: { tickets: [ticket("A")] } }));
    session.model({});
    session.select("ticket:A");
    r.events.get("A")![0].resolve(eventsResponse("spawned"));
    await flush();
    session.select(null);
    expect(session.model({}).timeline).toBeNull();
    expect(session.logs.state.ticketId).toBe(null);
  });
});

describe("stale-answer guards", () => {
  it("drops a timeline answer that lands after the selection moved on", async () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(
      snapshot({ state: { tickets: [ticket("A"), ticket("B")] } }),
    );
    session.model({});
    session.select("ticket:A");
    session.select("ticket:B");
    // A's fetch is still out when B's selection supersedes it; its late
    // answer must not clobber B's timeline.
    r.events.get("A")![0].resolve(eventsResponse("spawned"));
    await flush();
    expect(session.model({}).timeline).toBeNull();
    r.events.get("B")![0].resolve(eventsResponse("exited"));
    await flush();
    expect(session.model({}).timeline?.attempts[0]?.events[0]?.kind).toBe("exited");
  });

  it("keeps only the newest events fetch when snapshots outpace it", async () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(snapshot({ state: { tickets: [ticket("A")] } }));
    session.model({});
    session.select("ticket:A");
    // A second snapshot refetches on the same selection; the first fetch's
    // answer is the stale one now.
    session.setSnapshot(snapshot({ state: { tickets: [ticket("A")] } }));
    expect(r.events.get("A")).toHaveLength(2);
    r.events.get("A")![0].resolve(eventsResponse("spawned"));
    await flush();
    expect(session.model({}).timeline).toBeNull();
    r.events.get("A")![1].resolve(eventsResponse("exited"));
    await flush();
    expect(session.model({}).timeline?.attempts[0]?.events[0]?.kind).toBe("exited");
  });

  it("drops a body answer that lands after the selection moved on", async () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(
      snapshot({ state: { tickets: [ticket("A"), ticket("B")] } }),
    );
    session.model({});
    session.select("ticket:A");
    session.select("ticket:B");
    const changesAtSelect = r.changes();
    r.bodies.get("A")![0].resolve({ id: "A", body: "body A" });
    await flush();
    // A's late body caches silently: no repaint while B is showing.
    expect(r.changes()).toBe(changesAtSelect);
    expect(session.model({}).detailBody).toBeUndefined();
    r.bodies.get("B")![0].resolve({ id: "B", body: "body B" });
    await flush();
    expect(session.model({}).detailBody).toBe("body B");
  });
});

describe("ticket body cache", () => {
  it("caches a missing body and never refetches it", async () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(snapshot({ state: { tickets: [ticket("A")] } }));
    session.model({});
    session.select("ticket:A");
    r.bodies.get("A")![0].resolve(null);
    await flush();
    expect(session.model({}).detailBody).toBe(null);
    session.select("ticket:B");
    session.select("ticket:A");
    await flush();
    expect(r.bodies.get("A")).toHaveLength(1);
    expect(session.model({}).detailBody).toBe(null);
  });

  it("dedups a body fetch already in flight", () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(snapshot({ state: { tickets: [ticket("A")] } }));
    session.model({});
    session.select("ticket:A");
    session.select("ticket:A");
    expect(r.bodies.get("A")).toHaveLength(1);
  });
});

describe("tab override", () => {
  it("activates a manually chosen tab for its own ticket only", () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(
      snapshot({
        state: { tickets: [ticket("A", { status: "done" }), ticket("B")] },
      }),
    );
    session.model({});
    session.select("ticket:A");
    // A done ticket defaults to Outcome.
    expect(session.model({}).detailTabs?.find((t) => t.active)?.id).toBe("outcome");
    session.selectTab("A", "spec");
    expect(session.model({}).detailTabs?.find((t) => t.active)?.id).toBe("spec");
    // A choice made for another ticket replaces it and does not apply: the
    // selected ticket's default reasserts itself.
    session.selectTab("B", "progress");
    expect(session.model({}).detailTabs?.find((t) => t.active)?.id).toBe("outcome");
  });
});
