/**
 * The snapshot's deltas, seen from outside the server (ADR-0036): what the
 * socket carries from one version to the next, and what a client that
 * applies every delta it is sent ends up holding. Ported from the
 * diffSnapshot and applyDelta cases of engine/protocol.test.ts, which diffed
 * made-up snapshots in process; here a real server makes each change and the
 * socket carries its delta. The cited file has since moved to
 * ui/src/protocol.test.ts, each case two lines below the line cited.
 *
 * A pool at rest emits nothing, so a hand edit to a Ticket file reaches the
 * snapshot only when something rebuilds it. These cases rebuild it as the
 * inventory's rows say, with a Reassign: it rebuilds the snapshot from the
 * files as they stand, and pushes the change ahead of its reply.
 */

import { expect } from "bun:test";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushedSnapshot, ServerMessage } from "../../protocol/protocol.ts";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";
import { applySnapshotDelta } from "../fixtures/socket-protocol.ts";
import { conformance } from "../harness/case.ts";
import { expectParsedEqual } from "../harness/equal.ts";
import { snapshotOf, ticket, ticketOf, untilSnapshot } from "./config-support.ts";
import {
  CLAUDE,
  REVIEW,
  deltasFrom,
  interruptFor,
  settledOn,
  startConversation,
  terminalPool,
} from "./protocol-support.ts";

type SnapshotFrame = Extract<ServerMessage, { type: "snapshot" }>;

const atReview = (snap: EnrichedSnapshot): boolean =>
  snap.phase === "quiescent" && snap.state.interrupts.some((i) => i.ticketId === REVIEW);

// engine/protocol.test.ts:92
conformance("protocol", "diffSnapshot and applyDelta › say nothing changed when nothing did", async (t) => {
  // 01 rests at its checkpoint and 02 waits on it, so a Reassign can reach
  // 02, whose own assign entry already names the model the Reassign writes.
  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })],
    config: { ...CLAUDE, assign: { "02": { model: "m" } } },
  });
  world.stubs.script("01", { status: "checkpoint" });
  const server = await t.start(world);
  await interruptFor(server, "01");
  const client = await t.socket(server);
  await client.sync();
  const held = client.rev;
  const from = client.frames.length;

  // The write lands and the snapshot is rebuilt from it: the same snapshot,
  // so no delta goes and the revision the reply names has not moved.
  const reply = await client.request("reassign", { tickets: ["02"], fields: { model: "m" } });
  expect(reply).toMatchObject({ ok: true, rev: held, result: { applied: ["02"], skipped: [] } });
  await client.sync();
  expect(deltasFrom(client, from)).toEqual([]);
  expect(client.rev).toBe(held);
});

// engine/protocol.test.ts:97
conformance(
  "protocol",
  "diffSnapshot and applyDelta › carry a changed ticket alone, keeping its neighbours by reference",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] }), ticket("03", { blockedBy: ["01"] })],
      config: CLAUDE,
    });
    world.stubs.script("01", { status: "checkpoint" });
    const server = await t.start(world);
    await interruptFor(server, "01");
    const client = await t.socket(server);
    await client.sync();
    const held = client.rev;
    const from = client.frames.length;

    const reply = await client.request("reassign", { tickets: ["01"], fields: { model: "x-model" } });
    expect(reply).toMatchObject({ ok: true, rev: held + 1, result: { applied: ["01"], skipped: [] } });
    const after = await snapshotOf(server);
    expect(ticketOf(after, "01").assignment.model).toBe("x-model");
    // One delta, ahead of the reply: 01 whole under upsert, no order since no
    // id moved, and nothing of 02 or 03. Keeping the neighbours by reference
    // is the Console's apply (ui/src/protocol.ts); not resending them is the
    // server's half.
    expectParsedEqual(
      deltasFrom(client, from),
      [{ base: held, rev: held + 1, tickets: { upsert: [ticketOf(after, "01")] } }],
      "the deltas",
    );
    expect(client.pushed?.snapshot).toEqual(after);
  },
);

// engine/protocol.test.ts:114
conformance("protocol", "diffSnapshot and applyDelta › add and remove tickets, with the order they now stand in", async (t) => {
  // 03's assign entry already names the model the re-read's Reassign writes,
  // so 03 itself does not change.
  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] }), ticket("03", { blockedBy: ["01"] })],
    config: { ...CLAUDE, assign: { "03": { model: "m" } } },
  });
  world.stubs.script("01", { status: "checkpoint" });
  const server = await t.start(world);
  await interruptFor(server, "01");
  const client = await t.socket(server);
  await client.sync();
  const held = client.rev;
  const from = client.frames.length;

  unlinkSync(join(world.pool, "issues", "02-t.md"));
  writeFileSync(join(world.pool, "issues", "04-t.md"), "<!-- state: id=04 blocked-by=01 status=ready -->\n\n# 04: Late\n");
  const reply = await client.request("reassign", { tickets: ["03"], fields: { model: "m" } });
  expect(reply).toMatchObject({ ok: true, rev: held + 1, result: { applied: ["03"], skipped: [] } });

  const after = await snapshotOf(server);
  expect(after.state.tickets.map((entry) => entry.id)).toEqual(["01", "03", "04"]);
  expectParsedEqual(
    deltasFrom(client, from),
    [
      {
        base: held,
        rev: held + 1,
        tickets: { upsert: [ticketOf(after, "04")], remove: ["02"], order: ["01", "03", "04"] },
      },
    ],
    "the deltas",
  );
  expect(client.pushed?.snapshot).toEqual(after);
});

// engine/protocol.test.ts:122
conformance("protocol", "diffSnapshot and applyDelta › reorder tickets by id without resending them", async (t) => {
  // Tickets stand in their files' name order; 02's assign entry already
  // names the model the re-read's Reassign writes.
  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] }), ticket("03", { blockedBy: ["01"] })],
    config: { ...CLAUDE, assign: { "02": { model: "m" } } },
  });
  world.stubs.script("01", { status: "checkpoint" });
  const server = await t.start(world);
  await interruptFor(server, "01");
  const client = await t.socket(server);
  await client.sync();
  const held = client.rev;
  const from = client.frames.length;

  // 01's file now sorts last; its state line, id=01, is as it was.
  renameSync(join(world.pool, "issues", "01-t.md"), join(world.pool, "issues", "99-moved.md"));
  const reply = await client.request("reassign", { tickets: ["02"], fields: { model: "m" } });
  expect(reply).toMatchObject({ ok: true, rev: held + 1, result: { applied: ["02"], skipped: [] } });

  const after = await snapshotOf(server);
  expectParsedEqual(
    deltasFrom(client, from),
    [{ base: held, rev: held + 1, tickets: { order: ["02", "03", "01"] } }],
    "the deltas",
  );
  expect(client.pushed?.snapshot).toEqual(after);
});

// engine/protocol.test.ts:130
conformance(
  "protocol",
  "diffSnapshot and applyDelta › key Conversations the same way",
  async (t) => {
    const { server } = await terminalPool(t);
    const first = await startConversation(server, "First talk");
    const client = await t.socket(server);
    await client.sync();
    const from = client.frames.length;

    const second = await startConversation(server, "Second talk");
    const settled = await settledOn(
      server,
      client,
      (snap) => snap.state.conversations.find((c) => c.id === second.id)?.turn.state === "waiting",
      `${second.id}'s Turn to rest`,
    );
    // The first, at rest all along, is as it was.
    expect(settled.state.conversations.find((c) => c.id === first.id)).toEqual(first);

    const deltas = deltasFrom(client, from);
    for (const delta of deltas) {
      // No Ticket moved, and the unchanged Conversation is never resent.
      expect(delta.tickets).toBeUndefined();
      expect((delta.conversations?.upsert ?? []).map((c) => c.id)).not.toContain(first.id);
    }
    // The delta that brought the second in: it alone, with the new order.
    const added = deltas.find((delta) => delta.conversations?.upsert?.some((c) => c.id === second.id));
    expect(added?.conversations).toMatchObject({ order: [first.id, second.id] });
    expect(added?.conversations?.upsert?.map((c) => c.id)).toEqual([second.id]);
    expect(added?.conversations?.remove).toBeUndefined();
    expect(client.pushed?.snapshot.state.conversations).toEqual(settled.state.conversations);
  },
  { timeoutMs: 180_000 },
);

// engine/protocol.test.ts:141
conformance("protocol", "diffSnapshot and applyDelta › append new pool log lines rather than resend the log", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CLAUDE });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  await interruptFor(server, "01");
  const client = await t.socket(server);
  await client.sync();
  const before = client.pushed!.snapshot.state.log;
  const from = client.frames.length;

  const resumed = await server.http.post("/api/resume", { ticketId: "01", action: "resume" });
  expect(resumed.status).toBe(202);
  const settled = await settledOn(server, client, atReview, "the final Review");

  const logs = deltasFrom(client, from).flatMap((delta) => (delta.log ? [delta.log] : []));
  expect(logs.length).toBeGreaterThan(0);
  // Each delta appends only the lines new since the one before, and says how
  // long the whole log is now.
  let total = before.length;
  const appended: string[] = [];
  for (const log of logs) {
    if (!("append" in log)) throw new Error(`a delta replaced the pool log: ${JSON.stringify(log)}`);
    expect(log.total).toBe(total + log.append.length);
    total = log.total;
    appended.push(...log.append);
  }
  expect(settled.state.log.slice(0, before.length)).toEqual(before);
  expect(appended).toEqual(settled.state.log.slice(before.length));
  expect(total).toBe(settled.state.log.length);
});

// engine/protocol.test.ts:184
conformance(
  "protocol",
  "diffSnapshot and applyDelta › replace a changed state field whole and leave untouched lists by reference",
  async (t) => {
    const world = t.world({ tickets: [ticket("01")], config: CLAUDE });
    const held = world.stubs.hold("01", { status: "checkpoint" });
    const server = await t.start(world);
    await untilSnapshot(
      server,
      (snap) => ticketOf(snap, "01").liveAttempt !== null,
      "01's Attempt to be in flight",
      30_000,
    );
    const client = await t.socket(server);
    await client.sync();
    let version: PushedSnapshot = client.pushed!;
    const from = client.frames.length;

    await held.release(30_000);
    const settled = await settledOn(
      server,
      client,
      (snap) => snap.phase === "quiescent" && snap.state.interrupts.some((i) => i.ticketId === "01"),
      "01's checkpoint Interrupt",
    );

    // Over the version the socket held before each delta: a state field goes
    // only when it changed, and then whole.
    const sent = new Set<string>();
    for (const delta of deltasFrom(client, from)) {
      for (const [key, value] of Object.entries(delta.state ?? {})) {
        sent.add(key);
        const old = version.snapshot.state[key as keyof EnrichedSnapshot["state"]];
        expect([key, value]).not.toEqual([key, old]);
      }
      version = applySnapshotDelta(version, delta);
    }
    expect(sent.has("interrupts")).toBe(true);
    // The lists that did not move are never resent; keeping them by
    // reference is the Console's apply (ui/src/protocol.ts).
    for (const untouched of ["config", "mergeQueue", "queuedAnswers"]) {
      expect([untouched, sent.has(untouched)]).toEqual([untouched, false]);
    }
    const last = deltasFrom(client, from).filter((delta) => delta.state?.interrupts !== undefined).at(-1);
    expect(last?.state?.interrupts).toEqual(settled.state.interrupts);
    expect(version.snapshot).toEqual(settled);
  },
);

// engine/protocol.test.ts:211
conformance("protocol", "diffSnapshot and applyDelta › chain over many versions to what the server holds", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: CLAUDE });
  const held = world.stubs.hold("01");
  // 02 is held too, so the run's remaining versions cannot all fall inside one 50 ms push window.
  const second = world.stubs.hold("02");
  const server = await t.start(world);
  await untilSnapshot(
    server,
    (snap) => ticketOf(snap, "01").liveAttempt !== null,
    "01's Attempt to be in flight",
    30_000,
  );
  // Open while the run has most of its way to go.
  const early = await t.socket(server);
  await early.sync();
  const from = early.frames.length;

  await held.release(30_000);
  await untilSnapshot(
    server,
    (snap) => ticketOf(snap, "02").liveAttempt !== null,
    "02's Attempt to be in flight",
    30_000,
  );
  await second.release(30_000);
  await settledOn(server, early, atReview, "the final Review");
  expect(deltasFrom(early, from).length).toBeGreaterThan(1);

  // A socket opened now is sent the version whole, and every delta the early
  // one applied, in order, built exactly that.
  const late = await t.socket(server);
  const whole = await late.waitFor<SnapshotFrame>((frame) => frame.type === "snapshot", {
    what: "the late socket's snapshot",
  });
  await early.sync();
  expect(early.rev).toBe(whole.rev);
  expectParsedEqual(
    early.pushed,
    { rev: whole.rev, logTotal: whole.logTotal, snapshot: whole.snapshot },
    "what the deltas built",
  );
});
