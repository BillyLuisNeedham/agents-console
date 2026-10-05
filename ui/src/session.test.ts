/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  PROTOCOL_VERSION,
  type CardSubscription,
  type LogFollow,
  type LogFollowResult,
  type LogPush,
  type RequestKind,
  type ServerMessage,
  type SocketLike,
} from "../../protocol/protocol.ts";
import { diffSnapshot, encodeMessage, toPushed } from "./protocol";
import { createConsole } from "./console";
import { ConsoleSession, type ConsoleSessionOptions } from "./session";
import { RequestRefused } from "./socket";
import { answered } from "./optimistic";
import {
  projectPool,
  type ConversationView,
  type EnrichedSnapshot,
  type EnrichedTicketState,
  type HeldSpawnView,
  type TicketEventKind,
  type TicketEventsResponse,
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
    sources: { harness: "default", model: "default", effort: "unset", drivers: "default" },
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
    spawnUsage: { spawnedThisRun: 0, perAttempt: 5, perRun: 20 },
    pendingSpawns: [],
    heldSpawns: [],
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

function heldSpawnView(id: string): HeldSpawnView {
  return {
    id,
    parentId: "A",
    origin: "ticket",
    kind: "ticket",
    title: `proposal ${id}`,
    body: "",
    blockedBy: [],
    blocks: null,
    overlaps: [],
    unknownOverlaps: [],
    reason: "per-run",
    at: "2026-09-29T10:00:00Z",
    adopting: false,
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

/** Let the session's settled-request continuations run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventsResponse(kind: TicketEventKind, attempt = 1): TicketEventsResponse {
  return {
    events: [{ at: "2026-09-12T10:00:00Z", attempt, kind, payload: {} }],
    attempts: [],
    reconstructed: false,
    spec: "",
  };
}

function window(content: string, attempt = 1): LogPush {
  return {
    mode: "window",
    attempt,
    stream: false,
    content,
    offset: 0,
    nextOffset: content.length,
    totalSize: content.length,
    attempts: [
      { attempt, kind: "implement", logFile: `runs/A/${attempt}.log`, streamFile: null, current: true },
    ],
  };
}

/** A refusal as the socket hands one over. */
function refused(reason: string, status = 409): RequestRefused {
  return new RequestRefused({ reason, status });
}

interface SentRequest {
  kind: RequestKind;
  payload: unknown;
  deferred: Deferred<unknown>;
}

/**
 * A rig of a hand-settled fake socket: every request parks on a deferred
 * the test settles when it chooses, subscriptions are logged as `+id` and
 * `-id`, the projection is spy-counted, and onChange calls are counted, so
 * a test pins what was sent and the repaint cadence before any reply lands.
 */
function rig() {
  const requests: SentRequest[] = [];
  const subscriptions: string[] = [];
  const follows: { id: string; follow: LogFollow; deferred: Deferred<LogFollowResult> }[] = [];
  const probes: number[] = [];
  const relaunched: number[] = [];
  const activity: unknown[] = [];
  const peeks: unknown[] = [];
  const grades: unknown[] = [];
  let projectCalls = 0;
  let changes = 0;
  // What the relaunch probe answers; a test flips it to stand the new server
  // up part way through the poll.
  let probeAnswer = false;
  const options: ConsoleSessionOptions = {
    socket: {
      request: (kind, payload) => {
        const d = deferred<unknown>();
        requests.push({ kind, payload, deferred: d });
        return d.promise as never;
      },
      subscribe: (card: CardSubscription) => {
        subscriptions.push(`+${card.id}`);
      },
      unsubscribe: (id) => {
        subscriptions.push(`-${id}`);
      },
      follow: (id, follow) => {
        const d = deferred<LogFollowResult>();
        follows.push({ id, follow, deferred: d });
        return d.promise;
      },
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
    hoverDwellMs: 1,
    cardRetryMs: 5,
    vitals: {
      update: () => {},
      apply: (a) => {
        activity.push(a);
      },
      state: () => ({}),
    },
    terminal: {
      update: () => {},
      apply: (p) => {
        peeks.push(p);
      },
      state: () => ({}),
    },
    projectPool: (...args) => {
      projectCalls += 1;
      grades.push(args[1]);
      return projectPool(...args);
    },
    onChange: () => {
      changes += 1;
    },
  };
  /** The latest request of a kind, which a test settles. */
  const last = (kind: RequestKind): SentRequest => {
    const found = requests.filter((r) => r.kind === kind).at(-1);
    if (!found) throw new Error(`no ${kind} request was sent`);
    return found;
  };
  return {
    options,
    requests,
    subscriptions,
    follows,
    probes,
    relaunched,
    activity,
    peeks,
    grades,
    last,
    kinds: () => requests.map((r) => r.kind),
    setProbeAnswer: (value: boolean) => {
      probeAnswer = value;
    },
    projectCalls: () => projectCalls,
    changes: () => changes,
  };
}

/** A session over the rig, holding a snapshot and one derivation of it,
 *  as a rendered page would. */
function sessionOver(snap: EnrichedSnapshot, r = rig()) {
  const session = new ConsoleSession(r.options);
  session.setSnapshot(snap);
  session.model({});
  return { r, session };
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

describe("pushed snapshots (issue #161)", () => {
  it("applies a delta's version, keeping every unchanged ticket's identity for the projection", () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    const first = toPushed(snapshot({ state: { tickets: [ticket("A"), ticket("B")] } }), 1);
    session.setPushed(first, null);
    session.model({});
    const next = toPushed(
      snapshot({ state: { tickets: [ticket("A"), ticket("B", { status: "in-progress" })] } }),
      2,
    );
    const delta = diffSnapshot(first, next)!;
    // What the socket hands the session: the delta applied to what it held.
    const applied = {
      ...next,
      snapshot: {
        ...next.snapshot,
        state: {
          ...next.snapshot.state,
          tickets: [first.snapshot.state.tickets[0]!, next.snapshot.state.tickets[1]!],
        },
      },
    };
    session.setPushed(applied, delta);
    const model = session.model({});
    const b = model.cards.find((c) => c.id === "ticket:B");
    expect(b?.kind === "ticket" && b.status).toBe("in-progress");
  });

  it("feeds a live frame's activity and peeks to their stores and holds the grades whole", () => {
    const { r, session } = sessionOver(snapshot({ state: { tickets: [ticket("A")] } }));
    const before = r.changes();
    const grade = { attempt: 1, score: 0.8, verdict: "pass" } as never;
    session.applyLive({
      type: "live",
      activity: { A: { ticketId: "A", running: true, diff: null, log: null, lastEventAt: null } },
      peeks: { A: { ticket: "A", error: "pane gone" } },
      grades: { A: grade },
    });
    expect(r.activity).toHaveLength(1);
    expect(r.peeks).toHaveLength(1);
    expect(r.changes()).toBe(before + 1);
    session.model({});
    expect(r.grades.at(-1)).toEqual({ A: grade });
  });

  it("asks the server to start a pool it has not started, and banners a refusal", async () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.start();
    expect(r.kinds()).toEqual(["start"]);
    r.last("start").deferred.reject(refused("no tickets", 400));
    await flush();
    expect(session.model({}).error).toBe("failed to start the pool: no tickets");
  });
});

describe("selection and card subscriptions (issue #161)", () => {
  it("subscribes the selected card and lets the one it replaced go", () => {
    const { r, session } = sessionOver(
      snapshot({ state: { tickets: [ticket("A"), ticket("B")] } }),
    );
    session.select("ticket:A");
    session.select("ticket:B");
    session.select(null);
    expect(r.subscriptions).toEqual(["+A", "+B", "-A", "-B"]);
  });

  it("draws the body, the timeline and the log from the card's one frame", () => {
    const { r, session } = sessionOver(snapshot({ state: { tickets: [ticket("A")] } }));
    session.select("ticket:A");
    const shell = session.model({});
    expect(shell.detail?.kind).toBe("ticket");
    expect(shell.detailBody).toBeUndefined();
    expect(shell.timeline).toBeNull();
    const before = r.changes();
    session.applyCard({
      type: "card",
      id: "A",
      body: { id: "A", body: "# A\n\nthe spec" },
      events: eventsResponse("spawned"),
      log: window("[tool] Edit\n"),
    });
    expect(r.changes()).toBeGreaterThan(before);
    const model = session.model({});
    expect(model.detailBody).toBe("# A\n\nthe spec");
    expect(model.timeline?.attempts[0]?.number).toBe(1);
    expect(model.logPane?.content).toBe("[tool] Edit\n");
    expect(model.timeline?.attempts[0]?.streamFile).toBeNull();
  });

  it("hands the Detail the same timeline rows across deltas and repeated events frames", () => {
    const { session } = sessionOver(snapshot({ state: { tickets: [ticket("A")] } }));
    session.select("ticket:A");
    session.applyCard({ type: "card", id: "A", events: eventsResponse("spawned") });
    const first = session.model({}).timeline!;
    // A delta that leaves the ticket alone draws the very same timeline.
    session.setSnapshot(snapshot({ seq: 2, state: { tickets: [ticket("A")] } }));
    expect(session.model({}).timeline).toBe(first);
    // An events frame that repeats what is held keeps every attempt row.
    session.applyCard({ type: "card", id: "A", events: eventsResponse("spawned") });
    expect(session.model({}).timeline!.attempts[0]).toBe(first.attempts[0]!);
  });

  it("follows an events frame, a missing body and an unknown id", () => {
    const { session } = sessionOver(snapshot({ state: { tickets: [ticket("A")] } }));
    session.select("ticket:A");
    session.applyCard({ type: "card", id: "A", body: null, events: eventsResponse("spawned") });
    expect(session.model({}).detailBody).toBeNull();
    session.applyCard({ type: "card", id: "A", events: eventsResponse("spawned", 2) });
    expect(session.model({}).timeline?.attempts.map((a) => a.number)).toEqual([2]);
    session.applyCard({ type: "card", id: "A", error: "unknown ticket A" });
    expect(session.model({}).detailBodyError).toContain("unknown ticket A");
    session.dispose();
  });

  it("asks again for a card the server could not read while it stays selected (#161)", async () => {
    const { r, session } = sessionOver(
      snapshot({ state: { tickets: [ticket("A"), ticket("B")] } }),
    );
    session.select("ticket:A");
    session.applyCard({ type: "card", id: "A", error: "events file unreadable" });
    expect(r.subscriptions).toEqual(["+A", "-A"]);
    expect(session.model({}).detailBodyError).toContain("events file unreadable");
    await wait(15);
    expect(r.subscriptions).toEqual(["+A", "-A", "+A"]);
    // A frame that reads clears the error.
    session.applyCard({ type: "card", id: "A", body: { id: "A", body: "the spec" } });
    expect(session.model({}).detailBodyError).toBeNull();
    expect(session.model({}).detailBody).toBe("the spec");
    // A card let go of before the retry is not asked for again.
    session.select("ticket:B");
    session.applyCard({ type: "card", id: "B", error: "boom" });
    session.select(null);
    await wait(15);
    expect(r.subscriptions.filter((s) => s.endsWith("B"))).toEqual(["+B", "-B"]);
  });

  it("subscribes a Conversation by its own id, with a timeline and no log pane", () => {
    const { r, session } = sessionOver(
      snapshot({ state: { conversations: [conversation("c1")] } }),
    );
    session.select("conversation:c1");
    expect(r.subscriptions).toEqual(["+c1"]);
    session.applyCard({
      type: "card",
      id: "c1",
      body: null,
      events: eventsResponse("spawned"),
      log: null,
    });
    const model = session.model({});
    expect(model.timeline?.attempts[0]?.running).toBe(true);
    expect(model.logPane).toBeNull();
    expect(session.logs.state.ticketId).toBeNull();
  });

  it("drops a frame for a card it has let go of", () => {
    const { r, session } = sessionOver(
      snapshot({ state: { tickets: [ticket("A"), ticket("B")] } }),
    );
    session.select("ticket:A");
    session.select("ticket:B");
    const before = r.changes();
    session.applyCard({ type: "card", id: "A", body: { id: "A", body: "late" } });
    expect(r.changes()).toBe(before);
    session.select("ticket:A");
    expect(session.model({}).detailBody).toBeUndefined();
  });

  it("subscribes nothing for a spawn's card", () => {
    const { r, session } = sessionOver(
      snapshot({ heldSpawns: [heldSpawnView("held-1")], state: { tickets: [ticket("A")] } }),
    );
    const spawn = session.model({}).cards.find((c) => c.kind === "spawn");
    expect(spawn).toBeDefined();
    session.select(spawn!.id);
    expect(r.subscriptions).toEqual([]);
  });

  it("prints the State inspector only while it is open, once per snapshot (#157)", () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    const first = snapshot({ state: { tickets: [ticket("A")] } });
    session.setSnapshot(first);
    expect(session.model({}).inspectorJson).toBe("");
    session.toggleInspector();
    const printed = session.model({}).inspectorJson;
    expect(JSON.parse(printed)).toEqual(first.state);
    // The same snapshot hands back the very same string, not a fresh print.
    expect(session.model({}).inspectorJson).toBe(printed);
    session.setSnapshot(snapshot({ state: { tickets: [ticket("A"), ticket("B")] } }));
    expect(session.model({}).inspectorJson).not.toBe(printed);
  });
});

describe("hover prefetch (issue #161)", () => {
  const four = () =>
    snapshot({ state: { tickets: [ticket("A"), ticket("B"), ticket("C"), ticket("D")] } });

  it("subscribes a card the pointer rests on, and nothing for a pass-over", async () => {
    const { r, session } = sessionOver(four());
    session.hover("ticket:A");
    session.hover("ticket:B");
    session.hover(null);
    await wait(10);
    expect(r.subscriptions).toEqual([]);
    session.hover("ticket:C");
    await wait(10);
    expect(r.subscriptions).toEqual(["+C"]);
  });

  it("holds two hovered cards, letting the least recently hovered go first", async () => {
    const { r, session } = sessionOver(four());
    for (const id of ["A", "B", "C"]) {
      session.hover(`ticket:${id}`);
      await wait(10);
    }
    expect(r.subscriptions).toEqual(["+A", "+B", "+C", "-A"]);
    // Coming back to B makes it the most recent, so D lets C go, not B.
    session.hover("ticket:B");
    session.hover("ticket:D");
    await wait(10);
    expect(r.subscriptions).toEqual(["+A", "+B", "+C", "-A", "+D", "-C"]);
  });

  it("never counts the selected card against the two", async () => {
    const { r, session } = sessionOver(four());
    session.select("ticket:A");
    session.hover("ticket:A");
    for (const id of ["B", "C"]) {
      session.hover(`ticket:${id}`);
      await wait(10);
    }
    expect(r.subscriptions).toEqual(["+A", "+B", "+C"]);
  });

  it("holds a hovered card's frames without a repaint, and draws them whole on the click", async () => {
    const { r, session } = sessionOver(four());
    session.hover("ticket:B");
    await wait(10);
    const before = r.changes();
    session.applyCard({
      type: "card",
      id: "B",
      body: { id: "B", body: "B's spec" },
      events: eventsResponse("spawned"),
      log: window("B's tail\n"),
    });
    expect(r.changes()).toBe(before);
    session.select("ticket:B");
    const model = session.model({});
    expect(model.detailBody).toBe("B's spec");
    expect(model.timeline).not.toBeNull();
    expect(model.logPane?.content).toBe("B's tail\n");
    // Already subscribed: the click sends nothing.
    expect(r.subscriptions).toEqual(["+B"]);
  });

  it("stops its timers when disposed: a dwell under way subscribes nothing", async () => {
    const { r, session } = sessionOver(four());
    session.hover("ticket:A");
    session.dispose();
    await wait(10);
    expect(r.subscriptions).toEqual([]);
  });

  it("drops a card's held data once it is let go", async () => {
    const { session } = sessionOver(four());
    session.hover("ticket:A");
    await wait(10);
    session.applyCard({ type: "card", id: "A", body: { id: "A", body: "A's spec" } });
    for (const id of ["B", "C"]) {
      session.hover(`ticket:${id}`);
      await wait(10);
    }
    session.select("ticket:A");
    expect(session.model({}).detailBody).toBeUndefined();
  });
});

describe("optimistic presses (issue #161)", () => {
  const waiting = () =>
    snapshot({
      phase: "quiescent",
      state: {
        tickets: [ticket("A", { status: "checkpoint" })],
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief" }],
      },
    });
  const queuedOf = (session: ConsoleSession) =>
    session.model({}).needsInput.find((row) => row.ticketId === "A")?.interrupt.queued;

  it("draws an answer as queued in the press's frame and sends it", async () => {
    const { r, session } = sessionOver(waiting());
    const before = r.changes();
    const settled = session.answer("A", "resume", "go on");
    expect(r.changes()).toBeGreaterThan(before);
    expect(queuedOf(session)).toBe(true);
    expect(r.last("resume").payload).toEqual({ ticketId: "A", action: "resume", note: "go on" });
    // The confirming delta lands ahead of the reply; the reply drops the
    // overlay and nothing on screen moves.
    session.setSnapshot({
      ...waiting(),
      state: {
        ...waiting().state,
        queuedAnswers: [
          { seq: 1, ticketId: "A", kind: "checkpoint", note: "go on", at: "now", processedAt: null },
        ],
      },
    });
    r.last("resume").deferred.resolve({});
    await settled;
    expect(queuedOf(session)).toBe(true);
    expect(session.model({}).answerFailures).toEqual({});
  });

  it("draws a Close as closing in the press's frame and sends it as close (issue #154)", () => {
    const { r, session } = sessionOver(waiting());
    void session.answer("A", "close", "not needed").catch(() => {});
    const row = session.model({}).needsInput.find((x) => x.ticketId === "A");
    expect(row?.interrupt.queued).toBe(true);
    expect(row?.interrupt.closing).toBe(true);
    expect(r.last("resume").payload).toEqual({ ticketId: "A", action: "close", note: "not needed" });
  });

  it("draws an Adopt as queued in the press's frame and sends its Candidate (ADR-0035)", () => {
    const paused = snapshot({
      phase: "quiescent",
      state: {
        tickets: [ticket("A", { status: "checkpoint" })],
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief", candidates: [2, 3] }],
      },
    });
    const { r, session } = sessionOver(paused);
    void session.answer("A", "adopt", "the passing one", 3).catch(() => {});
    const row = session.model({}).needsInput.find((x) => x.ticketId === "A");
    expect(row?.interrupt.queued).toBe(true);
    expect(row?.interrupt.closing).toBe(false);
    expect(r.last("resume").payload).toEqual({
      ticketId: "A",
      action: "adopt",
      note: "the passing one",
      attempt: 3,
    });
  });

  it("queues the optimistic Adopt with its action and attempt, as the engine will (ADR-0035)", () => {
    const paused = snapshot({
      phase: "quiescent",
      state: {
        tickets: [ticket("A", { status: "checkpoint" })],
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief", candidates: [2] }],
      },
    });
    const queued = answered("A", "adopt", undefined, 2)(paused).state.queuedAnswers;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ ticketId: "A", kind: "checkpoint", action: "adopt", attempt: 2 });
    expect(queued[0]).not.toHaveProperty("note");
    // Every other answer names no attempt.
    const resumed = answered("A", "resume", "go")(paused).state.queuedAnswers[0];
    expect(resumed).not.toHaveProperty("attempt");
    expect(resumed).not.toHaveProperty("action");
  });

  it("rolls a refused answer back and puts the reason beside it until the next answer", async () => {
    const { r, session } = sessionOver(waiting());
    const settled = session.answer("A", "resume").catch((err: unknown) => err);
    expect(queuedOf(session)).toBe(true);
    r.last("resume").deferred.reject(refused("the interrupt was already answered"));
    expect(await settled).toBeInstanceOf(RequestRefused);
    expect(queuedOf(session)).toBe(false);
    expect(session.model({}).answerFailures).toEqual({ A: "the interrupt was already answered" });
    expect(session.model({}).error).toBeNull();
    void session.answer("A", "resume").catch(() => {});
    expect(session.model({}).answerFailures).toEqual({});
  });

  it("drops a refused answer's reason once the interrupt resolves", async () => {
    const { r, session } = sessionOver(waiting());
    const settled = session.answer("A", "resume").catch(() => {});
    r.last("resume").deferred.reject(refused("no"));
    await settled;
    session.setSnapshot(snapshot({ state: { tickets: [ticket("A")] } }));
    expect(session.model({}).answerFailures).toEqual({});
  });

  it("draws any overlay until its reply and rolls it back on a refusal", async () => {
    const { r, session } = sessionOver(snapshot({ heldSpawns: [heldSpawnView("held-1")] }));
    const settled = session
      .optimistic("spawns.held.discard", { id: "held-1" }, (s) => ({ ...s, heldSpawns: [] }))
      .catch((err: unknown) => err);
    expect(session.model({}).heldSpawns).toHaveLength(0);
    expect(r.last("spawns.held.discard").payload).toEqual({ id: "held-1" });
    r.last("spawns.held.discard").deferred.reject(refused("no such spawn"));
    expect(((await settled) as Error).message).toBe("no such spawn");
    expect(session.model({}).heldSpawns).toHaveLength(1);
  });

  it("leaves the snapshot it draws over untouched", () => {
    const base = snapshot({ heldSpawns: [heldSpawnView("held-1")] });
    const { session } = sessionOver(base);
    void session
      .optimistic("spawns.held.discard", { id: "held-1" }, (s) => ({ ...s, heldSpawns: [] }))
      .catch(() => {});
    session.toggleInspector();
    expect(JSON.parse(session.model({}).inspectorJson)).toEqual(base.state);
    expect(base.heldSpawns).toHaveLength(1);
  });
});

describe("“…ing” presses (issue #161)", () => {
  it("shows Stop, Restart and the bulk close in flight in the press's frame", () => {
    const { r, session } = sessionOver(snapshot({ phase: "done", finishedTerminals: 2 }));
    session.connection({ up: true });
    void session.confirmStop();
    void session.confirmRestart();
    void session.confirmCloseTerminals();
    const model = session.model({});
    expect(model.stop.state).toBe("requesting");
    expect(model.restart.state).toBe("requesting");
    expect(model.closeTerminals.state).toBe("requesting");
    expect(r.kinds()).toEqual(["stop", "restart", "terminals.closeFinished"]);
  });

  it("disables Keep talking in the press's frame", () => {
    const { session } = sessionOver(
      snapshot({
        state: {
          tickets: [ticket("A", { status: "checkpoint", heldPane: { attempt: 2, paneId: "w3:p1" } })],
          interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief" }],
        },
      }),
    );
    void session.keepTalking("A");
    const card = session.model({}).cards.find((c) => c.id === "ticket:A");
    expect(card?.kind === "ticket" && card.interrupt?.keepTalking?.requesting).toBe(true);
  });
});

describe("the pool log (issue #161)", () => {
  const lines = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => `line ${from + i}`);
  /** The drawer's lines, the drawer open. */
  const held = (session: ConsoleSession) => session.model({}).logText.split("\n");
  /** A session over the rig with its pool log drawer open. */
  const opened = (r: ReturnType<typeof rig>) => {
    const session = new ConsoleSession(r.options);
    session.toggleLog();
    return session;
  };

  it("offers the lines before the window and prepends them", async () => {
    const r = rig();
    const session = opened(r);
    session.setPushed(
      { rev: 1, logTotal: 800, snapshot: snapshot({ state: { log: lines(300, 800) } }) },
      null,
    );
    expect(session.model({}).logTotal).toBe(800);
    void session.loadEarlierPoolLog();
    expect(session.model({}).logEarlier.loading).toBe(true);
    expect(r.last("poolLog.read").payload).toEqual({ before: 300 });
    r.last("poolLog.read").deferred.resolve({ start: 0, lines: lines(0, 300), total: 800 });
    await flush();
    const model = session.model({});
    expect(held(session)).toEqual(lines(0, 800));
    expect(model.logHeld).toBe(800);
    expect(model.logEarlier.loading).toBe(false);
  });

  it("joins no text while the drawer is shut", () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(snapshot({ state: { log: lines(0, 10) } }));
    expect(session.model({}).logText).toBe("");
    expect(session.model({}).logHeld).toBe(10);
    session.toggleLog();
    expect(held(session)).toEqual(lines(0, 10));
  });

  it("lets the oldest earlier lines go past its cap, and reads them back on asking", async () => {
    const r = rig();
    const session = opened(r);
    session.setPushed(
      { rev: 1, logTotal: 800, snapshot: snapshot({ state: { log: lines(300, 800) } }) },
      null,
    );
    void session.loadEarlierPoolLog();
    r.last("poolLog.read").deferred.resolve({ start: 0, lines: lines(0, 300), total: 800 });
    await flush();
    // A burst pushes 6,000 lines past the window: 300 + 6,000 above it now.
    session.setPushed(
      { rev: 2, logTotal: 6_800, snapshot: snapshot({ state: { log: lines(6_300, 6_800) } }) },
      { base: 1, rev: 2, log: { append: lines(800, 6_800), total: 6_800 } },
    );
    const model = session.model({});
    expect(model.logHeld).toBe(5_000 + 500);
    expect(held(session)[0]).toBe("line 1300");
    expect(held(session).at(-1)).toBe("line 6799");
    void session.loadEarlierPoolLog();
    expect(r.last("poolLog.read").payload).toEqual({ before: 1_300 });
  });

  it("keeps the drawer contiguous as appends push lines out of the window", async () => {
    const r = rig();
    const session = opened(r);
    const first = { rev: 1, logTotal: 800, snapshot: snapshot({ state: { log: lines(300, 800) } }) };
    session.setPushed(first, null);
    void session.loadEarlierPoolLog();
    // Two lines land while the read is out: the window lets 300 and 301 go.
    const grown = {
      rev: 2,
      logTotal: 802,
      snapshot: snapshot({ state: { log: lines(302, 802) } }),
    };
    session.setPushed(grown, { base: 1, rev: 2, log: { append: lines(800, 802), total: 802 } });
    r.last("poolLog.read").deferred.resolve({ start: 100, lines: lines(100, 300), total: 802 });
    await flush();
    expect(held(session)).toEqual(lines(100, 802));
    // And again once the earlier lines are held.
    session.setPushed(
      { rev: 3, logTotal: 803, snapshot: snapshot({ state: { log: lines(303, 803) } }) },
      { base: 2, rev: 3, log: { append: lines(802, 803), total: 803 } },
    );
    expect(held(session)).toEqual(lines(100, 803));
    void session.loadEarlierPoolLog();
    expect(r.last("poolLog.read").payload).toEqual({ before: 100 });
  });

  it("starts over on a new log", async () => {
    const r = rig();
    const session = opened(r);
    session.setPushed(
      { rev: 1, logTotal: 800, snapshot: snapshot({ state: { log: lines(300, 800) } }) },
      null,
    );
    void session.loadEarlierPoolLog();
    r.last("poolLog.read").deferred.resolve({ start: 0, lines: lines(0, 300), total: 800 });
    await flush();
    session.setPushed(
      { rev: 2, logTotal: 2, snapshot: snapshot({ state: { log: ["new", "run"] } }) },
      { base: 1, rev: 2, log: { replace: ["new", "run"], total: 2 } },
    );
    expect(held(session)).toEqual(["new", "run"]);
  });

  it("never asks for lines before the first", () => {
    const r = rig();
    const session = new ConsoleSession(r.options);
    session.setSnapshot(snapshot({ state: { log: ["only"] } }));
    void session.loadEarlierPoolLog();
    expect(r.requests).toHaveLength(0);
  });
});

/**
 * Capture the timers the session arms instead of running them, so a test can
 * fire the connection's grace timer without waiting it out, and can assert
 * that a path arms no timer at all.
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

const DOWN = { up: false, reason: "pool socket closed (1006)", stopped: false } as const;

describe("the connection banner", () => {
  it("banners an ordinary close only after the grace, and a reconnect clears it", () => {
    const timers = captureTimers();
    try {
      const { session } = sessionOver(snapshot({ phase: "done" }));
      session.connection(DOWN);
      expect(session.model({}).connected).toBe(false);
      expect(session.model({}).error).toBeNull();
      expect(timers.pending).toHaveLength(1);
      // A dead server closes every retry: the grace arms once per outage.
      session.connection(DOWN);
      expect(timers.pending).toHaveLength(1);
      timers.runAll();
      expect(session.model({}).error).toBe("pool socket closed (1006)");
      session.connection({ up: true });
      expect(session.model({}).error).toBeNull();
      expect(session.model({}).connected).toBe(true);
    } finally {
      timers.restore();
    }
  });

  it("says the Console was updated when it would not reload again", () => {
    const { session } = sessionOver(snapshot());
    session.versionChanged();
    session.setSnapshot(snapshot());
    expect(session.model({}).error).toBe("Console was updated: reload the page");
  });
});

describe("stop control (issue #97)", () => {
  /** A connected session sitting on a done pool: the one state that offers Stop. */
  function doneSession() {
    const { r, session } = sessionOver(snapshot({ phase: "done" }));
    session.connection({ up: true });
    return { r, session };
  }

  it("offers Stop only while the pool is done and the socket is connected", () => {
    const timers = captureTimers();
    try {
      const { session } = doneSession();
      expect(session.model({}).stop.offered).toBe(true);
      session.setSnapshot(snapshot({ phase: "running" }));
      expect(session.model({}).stop.offered).toBe(false);
      session.setSnapshot(snapshot({ phase: "done" }));
      expect(session.model({}).stop.offered).toBe(true);
      // A dropped socket takes the offer with it: a request down a dead
      // connection would go nowhere.
      session.connection(DOWN);
      expect(session.model({}).stop.offered).toBe(false);
    } finally {
      timers.restore();
    }
  });

  it("arms and cancels the inline confirmation without sending anything", () => {
    const { r, session } = doneSession();
    expect(session.model({}).stop.state).toBe("idle");
    session.armStop();
    expect(session.model({}).stop.state).toBe("armed");
    session.cancelStop();
    expect(session.model({}).stop.state).toBe("idle");
    expect(r.requests).toHaveLength(0);
  });

  it("disarms when a snapshot moves the pool off done", () => {
    const { session } = doneSession();
    session.armStop();
    session.setSnapshot(snapshot({ phase: "running" }));
    expect(session.model({}).stop.state).toBe("idle");
    expect(session.model({}).stop.offered).toBe(false);
  });

  it("holds 'stopping...' until the accept, then marks the stop as this page's", async () => {
    const { r, session } = doneSession();
    session.armStop();
    const settled = session.confirmStop();
    // The request is out: the button stays disabled on its in-flight label,
    // because an accept only means the server took the stop.
    expect(session.model({}).stop.state).toBe("requesting");
    expect(r.kinds()).toEqual(["stop"]);
    r.last("stop").deferred.resolve({ stopping: true });
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
    r.last("stop").deferred.reject(refused("pool is running, not done: stop refused"));
    await settled;
    const model = session.model({});
    expect(model.stop.state).toBe("idle");
    expect(model.stop.failure).toBe("pool is running, not done: stop refused");
    expect(model.stop.stoppedFromHere).toBe(false);
    expect(model.error).toBeNull();
  });

  it("raises no banner for the farewell close, and recovers on relaunch", () => {
    const timers = captureTimers();
    try {
      const { session } = sessionOver(snapshot({ phase: "stopped", poolDir: "/repos/demo/.pool" }));
      session.connection({ up: false, reason: "stopped", stopped: true });
      // The stop is the reason the socket closed, so no grace timer is armed
      // at all; running every timer there is proves it.
      expect(timers.pending).toHaveLength(0);
      timers.runAll();
      const stopped = session.model({});
      expect(stopped.error).toBeNull();
      expect(stopped.connected).toBe(false);
      // The socket keeps retrying; a relaunched server's first snapshot puts
      // the page back to live, with the stop control's state cleared.
      session.setSnapshot(snapshot({ phase: "done" }));
      session.connection({ up: true });
      const relaunched = session.model({});
      expect(relaunched.error).toBeNull();
      expect(relaunched.connected).toBe(true);
      expect(relaunched.stop.stoppedFromHere).toBe(false);
      expect(relaunched.stop.offered).toBe(true);
    } finally {
      timers.restore();
    }
  });

  it("still banners an ordinary close after a stopped snapshot's relaunch", () => {
    const timers = captureTimers();
    try {
      const { session } = doneSession();
      session.connection(DOWN);
      expect(timers.pending).toHaveLength(1);
      timers.runAll();
      expect(session.model({}).error).toBe("pool socket closed (1006)");
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
    const { r, session } = sessionOver(snapshot({ phase }));
    session.connection({ up: true });
    return { r, session };
  }

  it("offers Restart in any phase, unlike Stop", () => {
    const { session } = connected("running");
    expect(session.model({}).restart.offered).toBe(true);
    expect(session.model({}).stop.offered).toBe(false);
    session.setSnapshot(snapshot({ phase: "done" }));
    expect(session.model({}).restart.offered).toBe(true);
  });

  it("withdraws the offer on a dead socket, the way Stop does", () => {
    const timers = captureTimers();
    try {
      const { session } = connected();
      session.connection(DOWN);
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
    expect(r.requests).toHaveLength(0);
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
    r.last("restart").deferred.reject(refused("no boot script on this pool"));
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
      r.last("restart").deferred.resolve({ ok: true, port: 4311 });
      await settled;
      expect(session.model({}).restart.waiting).toBe(true);
      session.setSnapshot(snapshot({ phase: "stopped" }));
      session.connection({ up: false, reason: "stopped", stopped: true });
      const model = session.model({});
      expect(model.phase).toBe("stopped");
      expect(model.restart.waiting).toBe(true);
      // The control survives the socket going down with the old server, so
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
      r.last("restart").deferred.resolve({ ok: true, port: 4311 });
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

  it("hands the page over when its own socket finds the relaunched server first", async () => {
    const timers = captureTimers();
    try {
      const { r, session } = connected();
      const settled = session.confirmRestart();
      r.last("restart").deferred.resolve({ ok: true, port: 4311 });
      await settled;
      session.setSnapshot(snapshot({ phase: "stopped" }));
      session.setSnapshot(snapshot({ phase: "running" }));
      expect(r.relaunched).toEqual([4311]);
      const model = session.model({});
      expect(model.restart.waiting).toBe(false);
      expect(model.restart.state).toBe("idle");
      expect(model.stop.stoppedFromHere).toBe(false);
    } finally {
      timers.restore();
    }
  });

  it("gives up after the wait, so the ordinary stopped notice takes over", async () => {
    const timers = captureTimers();
    try {
      const r = rig();
      const session = new ConsoleSession({ ...r.options, restartWaitMs: -1 });
      session.setSnapshot(snapshot({ phase: "running" }));
      const settled = session.confirmRestart();
      r.last("restart").deferred.resolve({ ok: true, port: 4311 });
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
});

describe("Keep talking (issue #139)", () => {
  /** A session whose ticket A waits at a checkpoint over a live Held pane
   *  of attempt `attempt`. */
  function heldSnapshot(attempt = 2): EnrichedSnapshot {
    return snapshot({
      phase: "quiescent",
      state: {
        tickets: [ticket("A", { status: "checkpoint", heldPane: { attempt, paneId: "w3:p1" } })],
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief" }],
      },
    });
  }

  const offerOf = (session: ConsoleSession) => {
    const card = session.model({}).cards.find((c) => c.id === "ticket:A");
    return card?.kind === "ticket" ? card.interrupt?.keepTalking : undefined;
  };

  it("asks the engine by ticket id and stays disabled after the accept, until the snapshot moves on", async () => {
    const { r, session } = sessionOver(heldSnapshot());
    const settled = session.keepTalking("A");
    expect(r.last("keepTalking").payload).toEqual({ ticketId: "A" });
    expect(offerOf(session)).toEqual({ requesting: true, failure: null });
    // A second click while it is out sends nothing.
    void session.keepTalking("A");
    expect(r.kinds()).toEqual(["keepTalking"]);
    r.last("keepTalking").deferred.resolve({ ticketId: "A", attempt: 3 });
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
    const { r, session } = sessionOver(heldSnapshot());
    const settled = session.keepTalking("A");
    r.last("keepTalking").deferred.reject(refused("the pane is gone"));
    await settled;
    expect(offerOf(session)).toEqual({ requesting: false, failure: "the pane is gone" });
    expect(session.model({}).error).toBeNull();
    void session.keepTalking("A");
    expect(r.kinds()).toEqual(["keepTalking", "keepTalking"]);
    expect(offerOf(session)).toEqual({ requesting: true, failure: null });
  });

  it("sends nothing for a ticket with no Held pane", async () => {
    const { r, session } = sessionOver(
      snapshot({ state: { tickets: [ticket("A", { status: "checkpoint" })] } }),
    );
    await session.keepTalking("A");
    expect(r.requests).toHaveLength(0);
  });
});

describe("close finished terminals (issue #139)", () => {
  function sessionWith(finishedTerminals: number) {
    const { r, session } = sessionOver(snapshot({ finishedTerminals }));
    session.connection({ up: true });
    return { r, session };
  }

  it("offers the control only while the snapshot counts a Finished terminal over a live socket", () => {
    const timers = captureTimers();
    try {
      const { session } = sessionWith(0);
      expect(session.model({}).closeTerminals).toMatchObject({ offered: false, count: 0 });
      session.setSnapshot(snapshot({ finishedTerminals: 2 }));
      expect(session.model({}).closeTerminals).toMatchObject({ offered: true, count: 2 });
      session.connection(DOWN);
      expect(session.model({}).closeTerminals.offered).toBe(false);
    } finally {
      timers.restore();
    }
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
    expect(r.requests).toHaveLength(0);
  });

  it("holds 'requesting' while the request is out, then returns to idle for the snapshot to hide it", async () => {
    const { r, session } = sessionWith(2);
    session.armCloseTerminals();
    const settled = session.confirmCloseTerminals();
    expect(session.model({}).closeTerminals.state).toBe("requesting");
    expect(r.kinds()).toEqual(["terminals.closeFinished"]);
    r.last("terminals.closeFinished").deferred.resolve({ closed: 2 });
    await settled;
    expect(session.model({}).closeTerminals).toMatchObject({ state: "idle", failure: null });
  });

  it("puts a refusal beside the button, never on the global banner", async () => {
    const { r, session } = sessionWith(2);
    session.armCloseTerminals();
    const settled = session.confirmCloseTerminals();
    r.last("terminals.closeFinished").deferred.reject(refused("pool is not terminal-backed"));
    await settled;
    const model = session.model({});
    expect(model.closeTerminals).toMatchObject({
      state: "idle",
      failure: "pool is not terminal-backed",
    });
    expect(model.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Console composed (console.ts): the boot from the embedded snapshot
// ---------------------------------------------------------------------------

/** A socket whose server side the test plays, as in socket.test.ts. */
class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: { type: string; kind?: string }[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
  }

  push(message: ServerMessage): void {
    this.onmessage?.({ data: encodeMessage(message) });
  }

  greet(epoch: string, rev: number, snap: EnrichedSnapshot | null): void {
    this.readyState = 1;
    this.onopen?.({});
    this.push({ type: "hello", protocol: PROTOCOL_VERSION, epoch, heartbeatMs: 20_000 });
    this.push({ type: "snapshot", rev, logTotal: snap?.state.log.length ?? 0, snapshot: snap });
  }
}

/** The ticket cards a model draws, by card id. */
function ticketCards(model: ReturnType<ConsoleSession["model"]>): string[] {
  return model.cards.filter((c) => c.kind === "ticket").map((c) => c.id);
}

/** The Console over a fake socket, its renders counted and its models kept
 *  instead of drawn (no DOM here). */
function mount(boot: Parameters<typeof createConsole>[0]["boot"]) {
  const sockets: FakeSocket[] = [];
  const models: ReturnType<ConsoleSession["model"]>[] = [];
  const app = createConsole({
    root: {} as HTMLElement,
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    boot,
    render: (a) => {
      models.push(a.session.model(a.view.conversationEndState()));
    },
    frame: () => {},
    pressTarget: null,
  });
  return { app, sockets, models };
}

describe("boot from the embedded snapshot (issue #161)", () => {
  const embedded = snapshot({ state: { tickets: [ticket("A"), ticket("B")] } });

  it("renders the embedded snapshot before the socket is even opened", () => {
    let socketsAtRender = -1;
    const sockets: FakeSocket[] = [];
    const app = createConsole({
      root: {} as HTMLElement,
      openSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      boot: { protocol: PROTOCOL_VERSION, epoch: "e1", rev: 7, logTotal: 0, snapshot: embedded },
      render: (a) => {
        socketsAtRender = sockets.length;
        expect(ticketCards(a.session.model({}))).toEqual(["ticket:A", "ticket:B"]);
      },
      frame: () => {},
      pressTarget: null,
    });
    app.start();
    expect(socketsAtRender).toBe(0);
    expect(sockets).toHaveLength(1);
    app.dispose();
  });

  it("does not render again for a socket snapshot of the same epoch and revision", () => {
    const { app, sockets, models } = mount({
      protocol: PROTOCOL_VERSION,
      epoch: "e1",
      rev: 7,
      logTotal: 0,
      snapshot: embedded,
    });
    app.start();
    expect(models).toHaveLength(1);
    sockets[0]!.greet("e1", 7, JSON.parse(JSON.stringify(embedded)) as EnrichedSnapshot);
    app.renders.flush();
    expect(models).toHaveLength(1);
    // Another revision is news, and renders.
    sockets[0]!.push({
      type: "delta",
      delta: diffSnapshot(
        toPushed(embedded, 7),
        toPushed(snapshot({ state: { tickets: [ticket("A"), ticket("B", { status: "done" })] } }), 8),
      )!,
    });
    app.renders.flush();
    expect(models).toHaveLength(2);
    app.dispose();
  });

  it("asks the server to start a pool it has not started", () => {
    const { app, sockets, models } = mount({
      protocol: PROTOCOL_VERSION,
      epoch: "e1",
      rev: 0,
      logTotal: 0,
      snapshot: null,
    });
    app.start();
    expect(models).toHaveLength(0);
    sockets[0]!.greet("e1", 0, null);
    expect(sockets[0]!.sent.filter((m) => m.type === "request").map((m) => m.kind)).toEqual([
      "start",
    ]);
    sockets[0]!.greet("e1", 1, embedded);
    app.renders.flush();
    expect(ticketCards(models.at(-1)!)).toEqual(["ticket:A", "ticket:B"]);
    app.dispose();
  });

  it("shows connecting with no embedded snapshot until the socket's first", () => {
    const { app, sockets, models } = mount(null);
    app.start();
    app.renders.request();
    app.renders.flush();
    expect(models.at(-1)!.phaseLabel).toBe("connecting");
    sockets[0]!.greet("e1", 1, embedded);
    app.renders.flush();
    expect(ticketCards(models.at(-1)!)).toEqual(["ticket:A", "ticket:B"]);
    app.dispose();
  });
});
