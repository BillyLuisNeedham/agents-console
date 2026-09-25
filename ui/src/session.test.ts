/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { ConsoleSession, type ConsoleSessionOptions } from "./session";
import {
  projectPool,
  type ConversationView,
  type EnrichedSnapshot,
  type EnrichedTicketState,
  type TicketBodyResponse,
  type TicketEventKind,
  type TicketEventsResponse,
  type RestartResponse,
  type TicketGradeSummary,
  type KeepTalkingResponse,
  type CloseFinishedTerminalsResponse,
} from "./project";

/** The Reassign view the wire carries per ticket (issue #126), derived so a
 *  done or in-flight fixture ticket is not claimed as reassignable. */
function reassignOf(ticket: {
  status: EnrichedTicketState["status"];
  liveAttempt: EnrichedTicketState["liveAttempt"];
}): EnrichedTicketState["reassign"] {
  const eligible = ticket.liveAttempt === null && ticket.status !== "done";
  return {
    eligible,
    reason: eligible
      ? null
      : ticket.status === "done"
        ? "a done ticket keeps the Assignment it ran on"
        : "an Attempt is in flight",
    verify: null,
    sources: { harness: "default", model: "default", drivers: "default" },
  };
}

function ticket(
  id: string,
  overrides: Partial<EnrichedTicketState> = {},
): EnrichedTicketState {
  const base = {
    id,
    title: `ticket ${id}`,
    blockedBy: [],
    status: "ready" as const,
    mergeState: null,
    enlisted: false,
    assignment: { harness: null, model: null, drivers: "implement" },
    liveAttempt: null,
    heldPane: null,
    ...overrides,
  };
  return { ...base, reassign: base.reassign ?? reassignOf(base) };
}

function conversation(
  id: string,
  overrides: Partial<ConversationView> = {},
): ConversationView {
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
    enlisted: false,
    ending: false,
    ...overrides,
  };
}

function snapshot(
  overrides: Omit<Partial<EnrichedSnapshot>, "state"> & {
    state?: Partial<EnrichedSnapshot["state"]>;
  } = {},
): EnrichedSnapshot {
  return {
    seq: 0,
    phase: "running",
    poolName: "repo/pool",
    poolTitle: null,
    poolDir: "/tmp/pool",
    finishedTerminals: 0,
    ...overrides,
    state: {
      tickets: [],
      conversations: [],
      log: [],
      outcomes: {},
      interrupts: [],
      mergeQueue: [],
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

function eventsResponse(kind: TicketEventKind): TicketEventsResponse {
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
  const stops: Deferred<void>[] = [];
  const restarts: Deferred<RestartResponse>[] = [];
  const keepTalks: { ticketId: string; deferred: Deferred<KeepTalkingResponse> }[] = [];
  const closes: Deferred<CloseFinishedTerminalsResponse>[] = [];
  const probes: number[] = [];
  const relaunched: number[] = [];
  const streamHandlers: {
    onSnapshot: (snapshot: EnrichedSnapshot) => void;
    onError: (message: string) => void;
  }[] = [];
  let projectCalls = 0;
  let changes = 0;
  // What the relaunch probe answers; a test flips it to stand the new server
  // up part way through the poll.
  let probeAnswer = false;
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
    getGrades: () => Promise.resolve({} as Record<string, TicketGradeSummary>),
    getLog: (ticketId) => {
      logCalls.push(ticketId);
      return new Promise(() => {});
    },
    answer: () => Promise.resolve(snapshot()),
    // The stop seam parks like the rest, so a test can watch the control sit
    // on "stopping..." before the 202 lands (issue #97).
    stop: () => {
      const d = deferred<void>();
      stops.push(d);
      return d.promise;
    },
    // The restart seam parks the same way, so a test can watch the control
    // sit on "restarting..." before the 202 lands (ADR-0026).
    restart: () => {
      const d = deferred<RestartResponse>();
      restarts.push(d);
      return d.promise;
    },
    // Keep talking and the bulk close park the same way (issue #139), so a
    // test can watch a button sit disabled before the engine answers.
    keepTalking: (ticketId) => {
      const d = deferred<KeepTalkingResponse>();
      keepTalks.push({ ticketId, deferred: d });
      return d.promise;
    },
    closeFinishedTerminals: () => {
      const d = deferred<CloseFinishedTerminalsResponse>();
      closes.push(d);
      return d.promise;
    },
    probeServer: (port) => {
      probes.push(port);
      return Promise.resolve(probeAnswer);
    },
    onRelaunched: (port) => {
      relaunched.push(port);
    },
    restartPollMs: 1,
    restartWaitMs: 40,
    stream: (handlers) => {
      streamHandlers.push(handlers);
      return () => {};
    },
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
    stops,
    restarts,
    keepTalks,
    closes,
    probes,
    relaunched,
    setProbeAnswer: (value: boolean) => {
      probeAnswer = value;
    },
    streamHandlers,
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

describe("the pool's name (issue #100)", () => {
  it("names the pool by its title, follows a retitle, and falls back to the directory", () => {
    const session = new ConsoleSession(rig().options);
    expect(session.model({}).poolName).toBeNull();
    session.setSnapshot(snapshot({ poolTitle: "Jev as the grader" }));
    expect(session.poolName).toBe("Jev as the grader");
    expect(session.model({}).poolName).toBe("Jev as the grader");
    session.setSnapshot(snapshot({ poolTitle: null }));
    expect(session.model({}).poolName).toBe("repo/pool");
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

/**
 * Capture the timers the session arms instead of running them, so a test can
 * fire the stream's grace timer without waiting it out, and can assert that
 * a path arms no timer at all.
 */
function captureTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending: (() => void)[] = [];
  globalThis.setTimeout = ((fn: () => void) => {
    pending.push(fn);
    return pending.length as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = (() => {}) as unknown as typeof globalThis.clearTimeout;
  return {
    pending,
    runAll: () => {
      for (const fn of pending.splice(0)) fn();
    },
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

describe("stop control (issue #97)", () => {
  /** A connected session sitting on a done pool: the one state that offers Stop. */
  function doneSession() {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.connect();
    session.setSnapshot(snapshot({ phase: "done" }));
    return { r, session };
  }

  it("offers Stop only while the pool is done and the stream is connected", () => {
    const { r, session } = doneSession();
    expect(session.model({}).stop.offered).toBe(true);
    session.setSnapshot(snapshot({ phase: "running" }));
    expect(session.model({}).stop.offered).toBe(false);
    session.setSnapshot(snapshot({ phase: "done" }));
    expect(session.model({}).stop.offered).toBe(true);
    // A dropped stream takes the offer with it: a POST down a dead
    // connection would go nowhere.
    r.streamHandlers[0]!.onError("pool stream disconnected");
    expect(session.model({}).stop.offered).toBe(false);
  });

  it("arms and cancels the inline confirmation without sending anything", () => {
    const { r, session } = doneSession();
    expect(session.model({}).stop.state).toBe("idle");
    session.armStop();
    expect(session.model({}).stop.state).toBe("armed");
    session.cancelStop();
    expect(session.model({}).stop.state).toBe("idle");
    expect(r.stops).toHaveLength(0);
  });

  it("disarms when a snapshot moves the pool off done", () => {
    const { session } = doneSession();
    session.armStop();
    session.setSnapshot(snapshot({ phase: "running" }));
    expect(session.model({}).stop.state).toBe("idle");
    expect(session.model({}).stop.offered).toBe(false);
  });

  it("holds 'stopping...' until the 202, then marks the stop as this page's", async () => {
    const { r, session } = doneSession();
    session.armStop();
    const settled = session.confirmStop();
    // The request is out: the button stays disabled on its in-flight label,
    // because a 202 only means the server accepted the stop.
    expect(session.model({}).stop.state).toBe("requesting");
    expect(r.stops).toHaveLength(1);
    r.stops[0]!.resolve();
    await settled;
    expect(session.model({}).stop.stoppedFromHere).toBe(true);
    // The farewell snapshot withdraws the control and carries the pool
    // directory the relaunch command prints.
    session.setSnapshot(snapshot({ phase: "stopped", poolDir: "/repos/demo/.pool" }));
    const model = session.model({});
    expect(model.phase).toBe("stopped");
    expect(model.phaseLabel).toBe("stopped");
    expect(model.stop.offered).toBe(false);
    expect(model.stop.stoppedFromHere).toBe(true);
    expect(model.stop.relaunch).toBe("bun run engine/server.ts --pool /repos/demo/.pool");
  });

  it("leaves 'from this page' off a tab that did not ask for the stop", () => {
    const { session } = doneSession();
    session.setSnapshot(snapshot({ phase: "stopped" }));
    expect(session.model({}).stop.stoppedFromHere).toBe(false);
  });

  it("puts a refused stop beside the button, never on the global banner", async () => {
    const { r, session } = doneSession();
    session.armStop();
    const settled = session.confirmStop();
    r.stops[0]!.reject(new Error("pool is running, not done: stop refused"));
    await settled;
    const model = session.model({});
    expect(model.stop.state).toBe("idle");
    expect(model.stop.failure).toBe("pool is running, not done: stop refused");
    expect(model.stop.stoppedFromHere).toBe(false);
    expect(model.error).toBeNull();
  });

  it("raises no banner for the disconnect that follows a stopped snapshot, and recovers on relaunch", () => {
    const timers = captureTimers();
    try {
      const r = rig();
      const session = new ConsoleSession(r.options);
      session.connect();
      session.setSnapshot(snapshot({ phase: "stopped", poolDir: "/repos/demo/.pool" }));
      r.streamHandlers[0]!.onError("pool stream disconnected");
      // The stop is the reason the stream ended, so no grace timer is armed
      // at all; running every timer there is proves it.
      expect(timers.pending).toHaveLength(0);
      timers.runAll();
      const stopped = session.model({});
      expect(stopped.error).toBeNull();
      expect(stopped.connected).toBe(false);
      // The client keeps retrying; a relaunched server's first snapshot puts
      // the page back to live, with the stop control's state cleared.
      session.setSnapshot(snapshot({ phase: "done" }));
      const relaunched = session.model({});
      expect(relaunched.error).toBeNull();
      expect(relaunched.connected).toBe(true);
      expect(relaunched.stop.stoppedFromHere).toBe(false);
      expect(relaunched.stop.offered).toBe(true);
    } finally {
      timers.restore();
    }
  });

  it("still banners an ordinary disconnect, so the stopped case is a real exception", () => {
    const timers = captureTimers();
    try {
      const r = rig();
      const session = new ConsoleSession(r.options);
      session.connect();
      session.setSnapshot(snapshot({ phase: "done" }));
      r.streamHandlers[0]!.onError("pool stream disconnected");
      expect(timers.pending).toHaveLength(1);
      timers.runAll();
      expect(session.model({}).error).toBe("pool stream disconnected");
    } finally {
      timers.restore();
    }
  });
});

describe("restart control (ADR-0026)", () => {
  /** Let the poll's async tick run to its next parked await. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  }

  function connected(phase: "running" | "done" = "running") {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.connect();
    session.setSnapshot(snapshot({ phase }));
    return { r, session };
  }

  it("offers Restart in any phase, unlike Stop", () => {
    const { session } = connected("running");
    expect(session.model({}).restart.offered).toBe(true);
    expect(session.model({}).stop.offered).toBe(false);
    session.setSnapshot(snapshot({ phase: "done" }));
    expect(session.model({}).restart.offered).toBe(true);
  });

  it("withdraws the offer on a dead stream, the way Stop does", () => {
    const timers = captureTimers();
    try {
      const { r, session } = connected();
      r.streamHandlers[0]!.onError("pool stream disconnected");
      expect(session.model({}).restart.offered).toBe(false);
    } finally {
      timers.restore();
    }
  });

  it("arms and cancels the inline confirmation without sending anything", () => {
    const { r, session } = connected();
    session.armRestart();
    expect(session.model({}).restart.state).toBe("armed");
    session.cancelRestart();
    expect(session.model({}).restart.state).toBe("idle");
    expect(r.restarts).toHaveLength(0);
  });

  it("keeps an armed confirmation across a phase change, since Restart is offered throughout", () => {
    const { session } = connected("running");
    session.armRestart();
    session.setSnapshot(snapshot({ phase: "done" }));
    expect(session.model({}).restart.state).toBe("armed");
  });

  it("shows a refusal beside the button and never enters the wait", async () => {
    const { r, session } = connected();
    const settled = session.confirmRestart();
    expect(session.model({}).restart.state).toBe("requesting");
    r.restarts[0]!.reject(new Error("no boot script on this pool"));
    await settled;
    const model = session.model({});
    expect(model.restart.state).toBe("idle");
    expect(model.restart.failure).toBe("no boot script on this pool");
    expect(model.restart.waiting).toBe(false);
    // A refused restart is not a broken pool: nothing reaches the banner.
    expect(model.error).toBeNull();
  });

  it("reads the farewell as a restart for the tab that asked", async () => {
    const timers = captureTimers();
    try {
      const { r, session } = connected();
      const settled = session.confirmRestart();
      r.restarts[0]!.resolve({ ok: true, port: 4311 });
      await settled;
      expect(session.model({}).restart.waiting).toBe(true);
      session.setSnapshot(snapshot({ phase: "stopped" }));
      const model = session.model({});
      expect(model.phase).toBe("stopped");
      expect(model.restart.waiting).toBe(true);
      // The control survives the stream going down with the old server, so
      // it can keep saying "restarting...".
      expect(model.restart.offered).toBe(true);
      expect(model.restart.state).toBe("requesting");
    } finally {
      timers.restore();
    }
  });

  it("hands the page over once a server answers on the port the restart named", async () => {
    const timers = captureTimers();
    try {
      const { r, session } = connected();
      const settled = session.confirmRestart();
      r.restarts[0]!.resolve({ ok: true, port: 4311 });
      await settled;
      session.setSnapshot(snapshot({ phase: "stopped" }));
      // Nothing is listening yet: the poll keeps its place.
      timers.runAll();
      await settle();
      expect(r.probes).toEqual([4311]);
      expect(r.relaunched).toEqual([]);
      r.setProbeAnswer(true);
      timers.runAll();
      await settle();
      expect(r.relaunched).toEqual([4311]);
      expect(session.model({}).restart.waiting).toBe(false);
    } finally {
      timers.restore();
    }
  });

  it("gives up after the wait, so the ordinary stopped notice takes over", async () => {
    const timers = captureTimers();
    try {
      const r = rig();
      const session = new ConsoleSession({ ...r.options, restartWaitMs: -1 });
      session.connect();
      session.setSnapshot(snapshot({ phase: "running" }));
      const settled = session.confirmRestart();
      r.restarts[0]!.resolve({ ok: true, port: 4311 });
      await settled;
      timers.runAll();
      await settle();
      const model = session.model({});
      expect(model.restart.waiting).toBe(false);
      expect(model.restart.state).toBe("idle");
      expect(r.relaunched).toEqual([]);
    } finally {
      timers.restore();
    }
  });

  it("starts over when a live snapshot lands, the way the stop control does", async () => {
    const timers = captureTimers();
    try {
      const { r, session } = connected();
      const settled = session.confirmRestart();
      r.restarts[0]!.resolve({ ok: true, port: 4311 });
      await settled;
      session.setSnapshot(snapshot({ phase: "stopped" }));
      session.setSnapshot(snapshot({ phase: "running" }));
      const model = session.model({});
      expect(model.restart.waiting).toBe(false);
      expect(model.restart.state).toBe("idle");
      expect(model.stop.stoppedFromHere).toBe(false);
    } finally {
      timers.restore();
    }
  });
});

describe("Keep talking (issue #139)", () => {
  /** A connected session whose ticket A waits at a checkpoint over a live
   *  Held pane of attempt `attempt`. */
  function heldSnapshot(attempt = 2): EnrichedSnapshot {
    return snapshot({
      phase: "quiescent",
      state: {
        tickets: [ticket("A", { status: "checkpoint", heldPane: { attempt, paneId: "w3:p1" } })],
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief" }],
      },
    });
  }

  function heldSession() {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.connect();
    session.setSnapshot(heldSnapshot());
    return { r, session };
  }

  const offerOf = (session: ConsoleSession) => {
    const card = session.model({}).cards.find((c) => c.id === "ticket:A");
    return card?.kind === "ticket" ? card.interrupt?.keepTalking : undefined;
  };

  it("asks the engine by ticket id and stays disabled after the accept, until the snapshot moves on", async () => {
    const { r, session } = heldSession();
    const settled = session.keepTalking("A");
    expect(r.keepTalks.map((call) => call.ticketId)).toEqual(["A"]);
    expect(offerOf(session)).toEqual({ requesting: true, failure: null });
    // A second click while it is out sends nothing.
    void session.keepTalking("A");
    expect(r.keepTalks).toHaveLength(1);
    r.keepTalks[0]!.deferred.resolve({ ticketId: "A", attempt: 3 });
    await settled;
    // Accepted, but the snapshot still shows the checkpoint: the pane is
    // already claimed, so the button must not invite a second ask.
    expect(offerOf(session)).toEqual({ requesting: true, failure: null });
    // The Continued attempt's snapshot: running, no Held pane, no offer.
    session.setSnapshot(
      snapshot({
        state: {
          tickets: [
            ticket("A", {
              status: "in-progress",
              liveAttempt: { attempt: 3, paneId: "w3:p1", role: "agent", startedAt: "2026-09-25T10:00:00Z" },
            }),
          ],
        },
      }),
    );
    expect(offerOf(session)).toBeUndefined();
    // A later checkpoint's Held pane starts clean.
    session.setSnapshot(heldSnapshot(3));
    expect(offerOf(session)).toEqual({ requesting: false, failure: null });
  });

  it("puts a refusal's reason beside the button, never on the global banner, and lets it retry", async () => {
    const { r, session } = heldSession();
    const settled = session.keepTalking("A");
    r.keepTalks[0]!.deferred.reject(new Error("the pane is gone"));
    await settled;
    expect(offerOf(session)).toEqual({ requesting: false, failure: "the pane is gone" });
    expect(session.model({}).error).toBeNull();
    void session.keepTalking("A");
    expect(r.keepTalks).toHaveLength(2);
    expect(offerOf(session)).toEqual({ requesting: true, failure: null });
  });

  it("sends nothing for a ticket with no Held pane", async () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(snapshot({ state: { tickets: [ticket("A", { status: "checkpoint" })] } }));
    await session.keepTalking("A");
    expect(r.keepTalks).toHaveLength(0);
  });
});

describe("close finished terminals (issue #139)", () => {
  function sessionWith(finishedTerminals: number) {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.connect();
    session.setSnapshot(snapshot({ finishedTerminals }));
    return { r, session };
  }

  it("offers the control only while the snapshot counts a Finished terminal over a live stream", () => {
    const { r, session } = sessionWith(0);
    expect(session.model({}).closeTerminals).toMatchObject({ offered: false, count: 0 });
    session.setSnapshot(snapshot({ finishedTerminals: 2 }));
    expect(session.model({}).closeTerminals).toMatchObject({ offered: true, count: 2 });
    r.streamHandlers[0]!.onError("pool stream disconnected");
    expect(session.model({}).closeTerminals.offered).toBe(false);
  });

  it("arms and cancels without sending anything, and disarms when the count drops to zero", () => {
    const { r, session } = sessionWith(2);
    session.armCloseTerminals();
    expect(session.model({}).closeTerminals.state).toBe("armed");
    session.cancelCloseTerminals();
    expect(session.model({}).closeTerminals.state).toBe("idle");
    session.armCloseTerminals();
    session.setSnapshot(snapshot({ finishedTerminals: 0 }));
    expect(session.model({}).closeTerminals.state).toBe("idle");
    expect(r.closes).toHaveLength(0);
  });

  it("holds 'requesting' while the POST is out, then returns to idle for the snapshot to hide it", async () => {
    const { r, session } = sessionWith(2);
    session.armCloseTerminals();
    const settled = session.confirmCloseTerminals();
    expect(session.model({}).closeTerminals.state).toBe("requesting");
    expect(r.closes).toHaveLength(1);
    r.closes[0]!.resolve({ closed: 2 });
    await settled;
    expect(session.model({}).closeTerminals).toMatchObject({ state: "idle", failure: null });
  });

  it("puts a refusal beside the button, never on the global banner", async () => {
    const { r, session } = sessionWith(2);
    session.armCloseTerminals();
    const settled = session.confirmCloseTerminals();
    r.closes[0]!.reject(new Error("pool is not terminal-backed"));
    await settled;
    const model = session.model({});
    expect(model.closeTerminals).toMatchObject({
      state: "idle",
      failure: "pool is not terminal-backed",
    });
    expect(model.error).toBeNull();
  });
});
