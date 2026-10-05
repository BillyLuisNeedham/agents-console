/**
 * The pool log's window on the socket, seen from outside the server
 * (ADR-0036): a pushed snapshot, on the socket and embedded in the page,
 * carries the log's last POOL_LOG_WINDOW lines and the whole log's length,
 * GET /api/state carries every line, and a delta appends past the window's
 * edge. Ported from the trimPoolLog cases and one diffSnapshot case of
 * engine/protocol.test.ts (since moved to ui/src/protocol.test.ts, each case
 * two lines below the line cited).
 *
 * A pool log longer than the window comes from a restored checkpoint, as the
 * rows allow: restoreLongLog has a first server leave its checkpoint, gives
 * that checkpoint a long log, and the server under test boots on it.
 */

import { expect } from "bun:test";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";
import { framesOf } from "../fixtures/socket-fixture.ts";
import { POOL_LOG_WINDOW } from "../fixtures/socket-protocol.ts";
import { conformance, type Case } from "../harness/case.ts";
import { expectParsedEqual } from "../harness/equal.ts";
import type { World } from "../harness/world.ts";
import { doneTicket, snapshotOf } from "./config-support.ts";
import {
  CLAUDE,
  REVIEW,
  deltasFrom,
  ensureBuiltUi,
  interruptFor,
  restoreLongLog,
  servedPage,
  settledOn,
} from "./protocol-support.ts";

/** A pool of two done Tickets: it boots straight to the final Review and runs nothing. */
function donePool(t: Case): World {
  return t.world({ tickets: [doneTicket("01"), doneTicket("02")], config: CLAUDE });
}

/** The snapshot less its pool log, the part the window leaves alone. */
function withoutLog(snapshot: EnrichedSnapshot): unknown {
  return { ...snapshot, state: { ...snapshot.state, log: null } };
}

// engine/protocol.test.ts:229
conformance("protocol", "trimPoolLog › keeps a short log whole", async (t) => {
  const server = await t.start(donePool(t));
  await interruptFor(server, REVIEW);
  const client = await t.socket(server);
  await client.sync();
  const now = await snapshotOf(server);

  expect(now.state.log.length).toBeGreaterThan(0);
  expect(now.state.log.length).toBeLessThan(POOL_LOG_WINDOW);
  const [frame] = framesOf(client, "snapshot");
  expectParsedEqual(
    frame,
    { type: "snapshot", rev: client.rev, logTotal: now.state.log.length, snapshot: now },
    "the snapshot frame",
  );
});

// engine/protocol.test.ts:233
conformance("protocol", "trimPoolLog › keeps the last window of a long one and counts it all", async (t) => {
  const world = donePool(t);
  await restoreLongLog(t, world, 1230);
  const server = await t.start(world);
  await interruptFor(server, REVIEW);
  const client = await t.socket(server);
  await client.sync();
  const now = await snapshotOf(server);

  const total = now.state.log.length;
  expect(total).toBeGreaterThan(1230);
  const [frame] = framesOf(client, "snapshot");
  expect(frame?.logTotal).toBe(total);
  expect(frame?.snapshot?.state.log).toEqual(now.state.log.slice(total - POOL_LOG_WINDOW));
  expect(frame?.snapshot?.state.log[0]).toBe(`restored line ${total - POOL_LOG_WINDOW + 1}`);
  expect(withoutLog(frame!.snapshot!)).toEqual(withoutLog(now));
});

// engine/protocol.test.ts:247
conformance(
  "protocol",
  "trimPoolLog › trims the pushed snapshot's log and leaves the full one alone",
  async (t) => {
    ensureBuiltUi(t);
    const world = donePool(t);
    // The window's worth restored, and the boot's own lines past it.
    const restored = await restoreLongLog(t, world, POOL_LOG_WINDOW);
    const server = await t.start(world);
    await interruptFor(server, REVIEW);
    const client = await t.socket(server);
    await client.sync();
    const now = await snapshotOf(server);

    const total = now.state.log.length;
    expect(total).toBeGreaterThan(POOL_LOG_WINDOW);
    const [frame] = framesOf(client, "snapshot");
    expect(frame?.logTotal).toBe(total);
    expect(frame?.snapshot?.state.log).toHaveLength(POOL_LOG_WINDOW);
    expect(frame?.snapshot?.state.log).toEqual(now.state.log.slice(total - POOL_LOG_WINDOW));
    // The page embeds the same pushed version, its log trimmed alike.
    const { boot } = await servedPage(server);
    expect([boot.rev, boot.logTotal]).toEqual([frame?.rev, total]);
    expect(boot.snapshot?.state.log).toEqual(frame?.snapshot?.state.log);
    // GET /api/state still serves every line, the restored ones first.
    expect(now.state.log.slice(0, POOL_LOG_WINDOW)).toEqual(restored);
  },
  { timeoutMs: 120_000 },
);

// engine/protocol.test.ts:149
conformance("protocol", "diffSnapshot and applyDelta › append across the window's edge, and say how long the whole log is", async (t) => {
  const world = donePool(t);
  await restoreLongLog(t, world, 600);
  const server = await t.start(world);
  await interruptFor(server, REVIEW);
  const client = await t.socket(server);
  await client.sync();
  const held = client.pushed!;
  expect(held.snapshot.state.log).toHaveLength(POOL_LOG_WINDOW);
  const from = client.frames.length;

  // Approving the Review logs its lines past the end of a log the socket holds
  // only the last window of.
  const approved = await server.http.post("/api/resume", { ticketId: REVIEW, action: "approve" });
  expect(approved.status).toBe(202);
  const settled = await settledOn(server, client, (snap) => snap.phase === "done", "the run to end done");

  const logs = deltasFrom(client, from).flatMap((delta) => (delta.log ? [delta.log] : []));
  expect(logs.length).toBeGreaterThan(0);
  let total = held.logTotal;
  const appended: string[] = [];
  for (const log of logs) {
    if (!("append" in log)) throw new Error(`a delta replaced the pool log: ${JSON.stringify(log)}`);
    expect(log.total).toBe(total + log.append.length);
    total = log.total;
    appended.push(...log.append);
  }
  // Exactly the new lines, and the whole log's length, not the window's.
  expect(appended).toEqual(settled.state.log.slice(held.logTotal));
  expect(total).toBe(settled.state.log.length);
  expect(client.pushed?.logTotal).toBe(settled.state.log.length);
  expect(client.pushed?.snapshot.state.log).toEqual(settled.state.log.slice(-POOL_LOG_WINDOW));
});
