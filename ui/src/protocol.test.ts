/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  HTTP_TWINS,
  POOL_LOG_WINDOW,
  PROTOCOL_VERSION,
  type PushedSnapshot,
} from "../../engine/protocol.ts";
import {
  applyDelta,
  decodeClientMessage,
  decodeServerMessage,
  diffSnapshot,
  embedBoot,
  encodeMessage,
  ProtocolError,
  readEmbeddedBoot,
  toPushed,
  trimPoolLog,
} from "./protocol";
import type { ConversationView, EnrichedSnapshot, EnrichedTicketState } from "../../engine/wire.ts";

// A ticket as the snapshot carries one, with only the fields these tests
// move filled in faithfully; the rest are plausible stand-ins.
function ticket(id: string, extra: Partial<EnrichedTicketState> = {}): EnrichedTicketState {
  return {
    id,
    title: `Ticket ${id}`,
    blockedBy: [],
    status: "ready",
    mergeState: null,
    assignment: { harness: "claude", model: "opus" },
    liveAttempt: null,
    heldPane: null,
    enlisted: false,
    reassign: { editable: true, reason: null, verify: 1, sources: {} },
    ...extra,
  } as unknown as EnrichedTicketState;
}

function conversation(id: string, extra: Partial<ConversationView> = {}): ConversationView {
  return {
    id,
    title: `Conversation ${id}`,
    status: "live",
    paneId: `pane-${id}`,
    ...extra,
  } as unknown as ConversationView;
}

function snapshot(extra: Partial<EnrichedSnapshot> = {}, state: Partial<EnrichedSnapshot["state"]> = {}): EnrichedSnapshot {
  return {
    seq: 1,
    phase: "running",
    poolName: "pools/demo",
    poolTitle: null,
    poolDir: "/tmp/pools/demo",
    finishedTerminals: 0,
    spawnUsage: { perRun: 10, perAttempt: 3, spawnedThisRun: 0 },
    pendingSpawns: [],
    heldSpawns: [],
    stewardBudget: { budget: 5, used: {} },
    ...extra,
    state: {
      tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] }), ticket("03")],
      conversations: [conversation("c1")],
      log: ["boot", "spawned 01"],
      outcomes: {},
      interrupts: [],
      mergeQueue: [],
      queuedAnswers: [],
      config: { terminal: "herdr" },
      ...state,
    },
  } as unknown as EnrichedSnapshot;
}

// The round trip every case below must pass: what the client holds after
// applying the server's delta is what the server would have sent whole.
function roundTrip(prevFull: EnrichedSnapshot, nextFull: EnrichedSnapshot): PushedSnapshot {
  const prev = toPushed(prevFull, 7);
  const next = toPushed(nextFull, 8);
  const delta = diffSnapshot(prev, next);
  expect(delta).not.toBeNull();
  // The delta crosses the wire as JSON, so it is applied as decoded.
  const wire = JSON.parse(JSON.stringify(delta));
  const applied = applyDelta(prev, wire);
  expect(applied).toEqual(next);
  return applied;
}

describe("diffSnapshot and applyDelta", () => {
  it("say nothing changed when nothing did", () => {
    const full = snapshot();
    expect(diffSnapshot(toPushed(full, 1), toPushed(structuredClone(full), 2))).toBeNull();
  });

  it("carry a changed ticket alone, keeping its neighbours by reference", () => {
    const prev = snapshot();
    const next = snapshot({ seq: 2 }, {
      tickets: [ticket("01", { status: "in-progress" }), ticket("02", { blockedBy: ["01"] }), ticket("03")],
    });
    const pushedPrev = toPushed(prev, 7);
    const delta = diffSnapshot(pushedPrev, toPushed(next, 8))!;
    expect(delta.tickets?.upsert?.map((t) => t.id)).toEqual(["01"]);
    expect(delta.tickets?.order).toBeUndefined();
    expect(delta.set).toEqual({ seq: 2 });
    const applied = roundTrip(prev, next);
    const held = applyDelta(pushedPrev, delta);
    expect(held.snapshot.state.tickets[1]).toBe(pushedPrev.snapshot.state.tickets[1]!);
    expect(held.snapshot.state.tickets[2]).toBe(pushedPrev.snapshot.state.tickets[2]!);
    expect(applied.snapshot.state.tickets[0]!.status).toBe("in-progress");
  });

  it("add and remove tickets, with the order they now stand in", () => {
    const prev = snapshot();
    const next = snapshot({}, { tickets: [ticket("01"), ticket("03"), ticket("04")] });
    const delta = diffSnapshot(toPushed(prev, 1), toPushed(next, 2))!;
    expect(delta.tickets).toEqual({ upsert: [ticket("04")], remove: ["02"], order: ["01", "03", "04"] });
    roundTrip(prev, next);
  });

  it("reorder tickets by id without resending them", () => {
    const prev = snapshot();
    const next = snapshot({}, { tickets: [ticket("03"), ticket("01"), ticket("02", { blockedBy: ["01"] })] });
    const delta = diffSnapshot(toPushed(prev, 1), toPushed(next, 2))!;
    expect(delta.tickets).toEqual({ order: ["03", "01", "02"] });
    roundTrip(prev, next);
  });

  it("key Conversations the same way", () => {
    const prev = snapshot();
    const next = snapshot({}, {
      conversations: [conversation("c1", { status: "ended" }), conversation("c2")],
    });
    const delta = diffSnapshot(toPushed(prev, 1), toPushed(next, 2))!;
    expect(delta.conversations?.upsert?.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(delta.tickets).toBeUndefined();
    roundTrip(prev, next);
  });

  it("append new pool log lines rather than resend the log", () => {
    const prev = snapshot();
    const next = snapshot({}, { log: ["boot", "spawned 01", "merged 01"] });
    const delta = diffSnapshot(toPushed(prev, 1), toPushed(next, 2))!;
    expect(delta.log).toEqual({ append: ["merged 01"], total: 3 });
    roundTrip(prev, next);
  });

  it("append across the window's edge, and say how long the whole log is", () => {
    const long = Array.from({ length: POOL_LOG_WINDOW + 20 }, (_, i) => `line ${i}`);
    const prev = snapshot({}, { log: long });
    const next = snapshot({}, { log: [...long, "a", "b"] });
    const delta = diffSnapshot(toPushed(prev, 1), toPushed(next, 2))!;
    expect(delta.log).toEqual({ append: ["a", "b"], total: POOL_LOG_WINDOW + 22 });
    const applied = roundTrip(prev, next);
    expect(applied.snapshot.state.log.length).toBe(POOL_LOG_WINDOW);
    expect(applied.snapshot.state.log.at(-1)).toBe("b");
    expect(applied.logTotal).toBe(POOL_LOG_WINDOW + 22);
  });

  it("replace a log that did not simply grow", () => {
    const prev = snapshot();
    const next = snapshot({}, { log: ["a new run", "spawned 02", "merged 02"] });
    const delta = diffSnapshot(toPushed(prev, 1), toPushed(next, 2))!;
    expect(delta.log).toEqual({ replace: ["a new run", "spawned 02", "merged 02"], total: 3 });
    roundTrip(prev, next);
  });

  it("replace a changed top-level field whole and drop one that went", () => {
    const prev = snapshot();
    const next = snapshot({
      phase: "done",
      heldSpawns: [{ id: "h1" }] as unknown as EnrichedSnapshot["heldSpawns"],
      stewardBudget: undefined,
    });
    const delta = diffSnapshot(toPushed(prev, 1), toPushed(next, 2))!;
    expect(Object.keys(delta.set ?? {}).sort()).toEqual(["heldSpawns", "phase"]);
    expect(delta.unset).toEqual(["stewardBudget"]);
    const applied = applyDelta(toPushed(prev, 1), JSON.parse(JSON.stringify(delta)));
    expect("stewardBudget" in applied.snapshot).toBe(false);
    expect(applied.snapshot.phase).toBe("done");
  });

  it("replace a changed state field whole and leave untouched lists by reference", () => {
    const prev = snapshot();
    const next = snapshot({}, {
      interrupts: [{ ticketId: "02", kind: "checkpoint" }] as unknown as EnrichedSnapshot["state"]["interrupts"],
    });
    const pushedPrev = toPushed(prev, 1);
    const delta = diffSnapshot(pushedPrev, toPushed(next, 2))!;
    expect(Object.keys(delta.state ?? {})).toEqual(["interrupts"]);
    roundTrip(prev, next);
    const held = applyDelta(pushedPrev, delta);
    expect(held.snapshot.state.tickets).toBe(pushedPrev.snapshot.state.tickets);
    expect(held.snapshot.state.conversations).toBe(pushedPrev.snapshot.state.conversations);
    expect(held.snapshot.state.log).toBe(pushedPrev.snapshot.state.log);
  });

  it("keep the whole state by reference when only a top-level field moved", () => {
    const pushedPrev = toPushed(snapshot(), 1);
    const delta = diffSnapshot(pushedPrev, toPushed(snapshot({ seq: 9 }), 2))!;
    expect(applyDelta(pushedPrev, delta).snapshot.state).toBe(pushedPrev.snapshot.state);
  });

  it("refuse a delta made for another revision", () => {
    const prev = toPushed(snapshot(), 1);
    const delta = diffSnapshot(prev, toPushed(snapshot({ seq: 2 }), 2))!;
    expect(() => applyDelta({ ...prev, rev: 5 }, delta)).toThrow(ProtocolError);
  });

  it("chain over many versions to what the server holds", () => {
    let server = toPushed(snapshot(), 0);
    let client = server;
    const steps: EnrichedSnapshot[] = [
      snapshot({ seq: 2 }, { log: ["boot", "spawned 01", "x"] }),
      snapshot({ seq: 3 }, { log: ["boot", "spawned 01", "x"], tickets: [ticket("02"), ticket("01")] }),
      snapshot({ seq: 4, phase: "done" }, { log: ["fresh"], tickets: [], conversations: [] }),
    ];
    for (const [i, full] of steps.entries()) {
      const next = toPushed(full, i + 1);
      client = applyDelta(client, JSON.parse(JSON.stringify(diffSnapshot(server, next))));
      server = next;
    }
    expect(client).toEqual(server);
  });
});

describe("trimPoolLog", () => {
  it("keeps a short log whole", () => {
    expect(trimPoolLog(["a", "b"])).toEqual({ lines: ["a", "b"], total: 2 });
  });

  it("keeps the last window of a long one and counts it all", () => {
    const log = Array.from({ length: 1234 }, (_, i) => String(i));
    const { lines, total } = trimPoolLog(log);
    expect(total).toBe(1234);
    expect(lines.length).toBe(POOL_LOG_WINDOW);
    expect(lines[0]).toBe(String(1234 - POOL_LOG_WINDOW));
    expect(lines.at(-1)).toBe("1233");
  });

  it("never shares the array it was given", () => {
    const log = ["a"];
    expect(trimPoolLog(log).lines).not.toBe(log);
  });

  it("trims the pushed snapshot's log and leaves the full one alone", () => {
    const log = Array.from({ length: POOL_LOG_WINDOW + 1 }, (_, i) => String(i));
    const full = snapshot({}, { log });
    const pushed = toPushed(full, 3);
    expect(pushed.logTotal).toBe(POOL_LOG_WINDOW + 1);
    expect(pushed.snapshot.state.log.length).toBe(POOL_LOG_WINDOW);
    expect(full.state.log.length).toBe(POOL_LOG_WINDOW + 1);
  });
});

describe("the envelope", () => {
  it("round-trips a request and its reply", () => {
    const request = decodeClientMessage(
      encodeMessage({ type: "request", id: 3, kind: "terminal.focus", payload: { ticketId: "01" } }),
    );
    expect(request).toEqual({ type: "request", id: 3, kind: "terminal.focus", payload: { ticketId: "01" } });
    const reply = decodeServerMessage(
      encodeMessage({
        type: "reply",
        id: 3,
        kind: "terminal.focus",
        rev: 12,
        ok: false,
        refusal: { reason: "no pane", status: 404 },
      }),
    );
    expect(reply.type).toBe("reply");
  });

  it("refuses what is not this protocol's", () => {
    for (const text of [
      "not json",
      "[]",
      JSON.stringify({ type: "nope" }),
      JSON.stringify({ type: "request", id: 1, kind: "rm -rf", payload: {} }),
      JSON.stringify({ type: "request", kind: "stop", payload: {} }),
      JSON.stringify({ type: "subscribe" }),
    ]) {
      expect(() => decodeClientMessage(text)).toThrow(ProtocolError);
    }
    for (const text of [
      JSON.stringify({ type: "delta", delta: { rev: 2 } }),
      JSON.stringify({ type: "reply", id: 1, kind: "stop", rev: 1, ok: false }),
      JSON.stringify({ type: "hello", protocol: 1, epoch: "e" }),
    ]) {
      expect(() => decodeServerMessage(text)).toThrow(ProtocolError);
    }
  });

  it("names an HTTP twin for every request kind", () => {
    for (const twin of Object.values(HTTP_TWINS)) {
      expect(twin).toMatch(/^(GET|POST|PUT) \/api\//);
    }
  });
});

describe("the embedded boot snapshot", () => {
  const html = "<!doctype html><html><head><title>Console</title></head><body></body></html>";

  it("reads back what was embedded, a hostile title included", () => {
    const full = snapshot({}, { tickets: [ticket("01", { title: "</script><script>alert(1)</script>" })] });
    const pushed = toPushed(full, 4);
    const page = embedBoot(html, { protocol: PROTOCOL_VERSION, epoch: "e1", ...pushed });
    expect(page.match(/<\/script>/g)?.length).toBe(1);
    const text = page.slice(page.indexOf('type="application/json">') + 24, page.indexOf("</script>"));
    const boot = readEmbeddedBoot(text);
    expect(boot?.snapshot).toEqual(pushed.snapshot);
    expect(boot?.rev).toBe(4);
  });

  it("ignores one made for another protocol, or none at all", () => {
    expect(readEmbeddedBoot(null)).toBeNull();
    expect(readEmbeddedBoot("{")).toBeNull();
    expect(
      readEmbeddedBoot(JSON.stringify({ protocol: PROTOCOL_VERSION + 1, epoch: "e", rev: 1, logTotal: 0, snapshot: null })),
    ).toBeNull();
  });
});
