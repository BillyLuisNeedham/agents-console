/**
 * Cards and the live values on the socket, seen from outside the server
 * (ADR-0036): the inventory's gaps beside engine/ws.ts that no engine test
 * drives. A card with no Attempt yet, then a window on each Attempt as it
 * starts; a Conversation's card; the 64 KiB window and appends and the
 * 256 KiB gap past which a card gets a fresh window; and the grades a hidden
 * tab is still sent.
 */

import { expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { LogPush, ServerMessage } from "../../engine/protocol.ts";
import type { TicketEvent, TicketEventsResponse, TicketGradeSummary } from "../../engine/wire.ts";
import { framesOf, type SocketClient } from "../fixtures/socket-fixture.ts";
import { conformance } from "../harness/case.ts";
import { expectParsedEqual } from "../harness/equal.ts";
import { until } from "../harness/pool-files.ts";
import { doneTicket, ticket, ticketOf, untilSnapshot } from "./config-support.ts";
import { CLAUDE, REVIEW, interruptFor, startConversation, terminalPool } from "./protocol-support.ts";

type Card = Extract<ServerMessage, { type: "card" }>;
type Live = Extract<ServerMessage, { type: "live" }>;

/** The first card frame for `id` at or after `from` that `has` accepts. */
function cardOf(
  client: SocketClient,
  id: string,
  options: { from?: number; ms?: number; what?: string; has?: (frame: Card) => boolean } = {},
): Promise<Card> {
  const has = options.has ?? (() => true);
  return client.waitFor<Card>((frame) => frame.type === "card" && frame.id === id && has(frame), {
    from: options.from,
    ms: options.ms,
    what: options.what ?? `${id}'s card`,
  });
}

/** The log appends a card was sent from frame `from` on, in order. */
function appendsFrom(client: SocketClient, id: string, from: number): LogPush[] {
  return client.frames
    .slice(from)
    .flatMap((frame) => (frame.type === "card" && frame.id === id && frame.log?.mode === "append" ? [frame.log] : []));
}

const isWindow = (frame: Card): boolean => frame.log?.mode === "window";

// The gap at engine/ws.ts:752
conformance(
  "protocol",
  "cards › sends no log for a Ticket with no Attempt yet, then a window on each Attempt as it starts",
  async (t) => {
    const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: CLAUDE });
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    const server = await t.start(world);
    await interruptFor(server, "01");

    // Both cards, each following its latest Attempt.
    const client = await t.socket(server, { visible: true, cards: [{ id: "01" }, { id: "02" }] });
    const one = await cardOf(client, "01");
    const two = await cardOf(client, "02");
    expect(one.log).toMatchObject({ mode: "window", attempt: 1, stream: false });
    expect(two.log).toBeNull();
    expect(two.body).toEqual({ id: "02", body: "# 02: Ticket 02\n\nDo the work of 02.\n" });
    await client.sync();
    const from = client.frames.length;

    // Resumed, 01 starts its second Attempt: its card moves to it, both listed.
    const resumed = await server.http.post("/api/resume", { ticketId: "01", action: "resume" });
    expect(resumed.status).toBe(202);
    const second = await cardOf(client, "01", { from, has: isWindow, what: "01's window on attempt 2", ms: 30_000 });
    expect(second.log).toMatchObject({ mode: "window", attempt: 2, stream: false });
    expect(second.log?.attempts?.map((a) => [a.attempt, a.kind])).toEqual([
      [1, "implement"],
      [2, "implement"],
    ]);
    // 01 done, 02 starts its first: its card gets its first window.
    const started = await cardOf(client, "02", { from, has: isWindow, what: "02's window on attempt 1", ms: 30_000 });
    expect(started.log).toMatchObject({ mode: "window", attempt: 1, stream: false });
    expect(started.log?.attempts?.map((a) => [a.attempt, a.kind])).toEqual([[1, "implement"]]);
    expect(client.frames.indexOf(started)).toBeGreaterThan(client.frames.indexOf(second));
    await interruptFor(server, REVIEW);
  },
  { timeoutMs: 120_000 },
);

// The gap at engine/ws.ts:681
conformance(
  "protocol",
  "cards › holds a Conversation's card: no body, its events and its log's window, then the log's appends",
  async (t) => {
    const { world, server } = await terminalPool(t);
    const talk = await startConversation(server, "Talk");
    const client = await t.socket(server);
    await client.sync();
    const from = client.frames.length;

    client.send({ type: "subscribe", card: { id: talk.id } });
    const card = await cardOf(client, talk.id, { from });
    expect(card.error).toBeUndefined();
    // No Ticket file, so no body; the events are GET /api/events's.
    expect(card.body).toBeNull();
    const events = (await server.http.get(`/api/events?ticket=${talk.id}`)).json<TicketEventsResponse>();
    expectParsedEqual(card.events, events, "the card's events");
    expect(events.events.map((event) => [event.kind, event.attempt])).toContainEqual(["spawned", 1]);
    const window = card.log as LogPush;
    expect(window).toMatchObject({ mode: "window", attempt: 1, stream: false });
    expect(window.attempts?.map((a) => [a.attempt, a.logFile])).toEqual([[1, `${talk.id}.log`]]);

    // The Conversation's log grows: the bytes arrive as appends from where
    // the window ended.
    const grownFrom = client.frames.length;
    appendFileSync(join(world.pool, "runs", `${talk.id}.log`), "hello from the pane\n");
    const appends = await until(
      () => appendsFrom(client, talk.id, grownFrom),
      (got) => got.map((log) => log.content).join("").includes("hello from the pane\n"),
      { what: "the appended line on the card", ms: 10_000 },
    );
    expect(appends[0]?.offset).toBe(window.nextOffset);
    expect(appends.map((log) => log.content).join("").endsWith("hello from the pane\n")).toBe(true);
  },
  { timeoutMs: 180_000 },
);

/** `count` lines of 1 KiB each: 1023 `x` and a newline. */
const kib = (count: number): string => `${"x".repeat(1023)}\n`.repeat(count);
const KIB = 1024;

// The gap at engine/ws.ts:758
conformance(
  "protocol",
  "cards › opens a log on its last 64 KiB, sends a long append as 64 KiB appends, and a gap past 256 KiB as a fresh window",
  async (t) => {
    // 01 done long ago with 200 KiB of log and no events file: its one
    // Attempt is the log's.
    const world = t.world({ tickets: [doneTicket("01")], config: CLAUDE, poolFiles: { "runs/01.log": kib(200) } });
    const server = await t.start(world);
    await interruptFor(server, REVIEW);
    const logFile = join(world.pool, "runs", "01.log");

    const client = await t.socket(server, { visible: true, cards: [{ id: "01" }] });
    const card = await cardOf(client, "01");
    const window = card.log as LogPush;
    expect({ ...window, content: window.content.length }).toMatchObject({
      mode: "window",
      attempt: 1,
      offset: 200 * KIB - 64 * KIB,
      content: 64 * KIB,
      nextOffset: 200 * KIB,
      totalSize: 200 * KIB,
    });

    // 100 KiB in one write: two appends from where the window ended, the
    // first a whole 64 KiB.
    let from = client.frames.length;
    appendFileSync(logFile, kib(100));
    const appends = await until(
      () => appendsFrom(client, "01", from),
      (got) => got.at(-1)?.nextOffset === 300 * KIB,
      { what: "the 100 KiB on the card", ms: 10_000 },
    );
    expect(appends.map((log) => [log.offset, log.content.length, log.nextOffset, log.totalSize])).toEqual([
      [200 * KIB, 64 * KIB, 264 * KIB, 300 * KIB],
      [264 * KIB, 36 * KIB, 300 * KIB, 300 * KIB],
    ]);

    // 300 KiB in one write is more than the pane keeps past where it is: a
    // fresh window on the file's last 64 KiB, and no appends.
    from = client.frames.length;
    appendFileSync(logFile, kib(300));
    const fresh = await cardOf(client, "01", { from, has: (frame) => frame.log != null, what: "the card's next log" });
    const next = fresh.log as LogPush;
    expect({ ...next, content: next.content.length }).toMatchObject({
      mode: "window",
      attempt: 1,
      offset: 600 * KIB - 64 * KIB,
      content: 64 * KIB,
      nextOffset: 600 * KIB,
      totalSize: 600 * KIB,
    });
    await client.sync();
    expect(appendsFrom(client, "01", from)).toEqual([]);
  },
);

const T0 = "2026-01-01T00:00:00.000Z";

// The gap at engine/ws.ts:614-626 and 640-650
conformance(
  "protocol",
  "the live check › sends a hidden socket the grades when they move, and never activity or peeks",
  async (t) => {
    // 01 done and graded; 02 runs, held, so the live check has activity to send.
    const graded = (score: number, verdict: string, at: string): TicketEvent => ({
      at,
      attempt: 1,
      kind: "graded",
      payload: { score, verdict, reasons: `scored ${score}` },
    });
    const events: TicketEvent[] = [
      { at: T0, attempt: 1, kind: "spawned", payload: {} },
      { at: T0, attempt: 1, kind: "exited", payload: { code: 0, status: "done" } },
      graded(8, "pass", T0),
    ];
    const world = t.world({
      tickets: [doneTicket("01"), ticket("02")],
      config: CLAUDE,
      poolFiles: { "runs/01.events.jsonl": events.map((event) => `${JSON.stringify(event)}\n`).join("") },
    });
    const held = world.stubs.hold("02");
    const server = await t.start(world);
    await untilSnapshot(
      server,
      (snap) => ticketOf(snap, "02").liveAttempt !== null,
      "02's Attempt to be in flight",
      30_000,
    );

    // Once its hello has landed, the hidden socket is past the moment a
    // socket counts as visible.
    const hidden = await t.socket(server, { visible: false });
    await hidden.sync();
    const from = hidden.frames.length;
    const shown = await t.socket(server, { visible: true });
    await shown.waitFor<Live>((frame) => frame.type === "live" && frame.activity?.["02"] !== undefined, {
      what: "02's activity on the visible socket",
      ms: 15_000,
    });

    // A new grade for 01 moves the grades, which every socket is sent.
    const regraded = graded(3, "flag", new Date().toISOString());
    appendFileSync(join(world.pool, "runs", "01.events.jsonl"), `${JSON.stringify(regraded)}\n`);
    const live = await hidden.waitFor<Live>(
      (frame) => frame.type === "live" && frame.grades?.["01"]?.score === 3,
      { from, what: "the new grade on the hidden socket", ms: 10_000 },
    );
    const grades = (await server.http.get("/api/grades")).json<{ grades: Record<string, TicketGradeSummary> }>().grades;
    expect(grades["01"]).toEqual({ attempt: 1, score: 3, verdict: "flag", winner: null });
    expect(live.grades).toEqual(grades);
    await hidden.sync();
    for (const frame of framesOf(hidden, "live").filter((frame) => hidden.frames.indexOf(frame) >= from)) {
      expect(Object.keys(frame).sort()).toEqual(["grades", "type"]);
    }

    await held.release(30_000);
    await interruptFor(server, REVIEW);
  },
  { timeoutMs: 90_000 },
);
