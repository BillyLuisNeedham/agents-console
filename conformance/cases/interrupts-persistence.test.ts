/**
 * The persistence Interrupt, seen from outside the server (ADR-0036): a
 * checkpoint write the store refuses is retried with backoff and the run
 * carries on once one lands; a store that keeps refusing raises the run-level
 * PERSISTENCE Interrupt and the pool waits for a human with the store still
 * open; and none of it ever reports the drive dead. Ticket C08 of the
 * inventory's split (docs/research/rust-port/test-inventory.md): each case
 * names the engine test it carries over.
 *
 * The store is console.db, a SQLite file. A case makes it refuse the way a
 * second writer would: it holds an exclusive lock on it from the test
 * process (BEGIN EXCLUSIVE in SQLite's default rollback journal), so every
 * write the server tries fails with "database is locked" until the case
 * lets go. The lock is taken once 01 has launched, so after the server has
 * opened the store and read its last checkpoint at boot, and before 01 can
 * exit, so before the first super-step boundary writes anything.
 */

import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushedSnapshot } from "../../engine/protocol.ts";
import type { EnrichedSnapshot, PoolConfig } from "../../engine/wire.ts";
import { applySnapshotDelta } from "../fixtures/socket-protocol.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { expectParsedEqual } from "../harness/equal.ts";
import { answer, approveReview, resume, settle, snapshot, statuses } from "../harness/pool-run.ts";
import { readCheckpoints, readEvents, readStateLine, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";

const CONFIG = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;
/** The persistence Interrupt's Ticket id (PERSISTENCE_TICKET_ID in engine/engine.ts). */
const PERSISTENCE = "PERSISTENCE";

const ready = (id: string, blockedBy = "none"): TicketSeed => ({
  file: `${id}-t.md`,
  marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`,
});

/** 01, then 02 blocked by it: the boundary after 01 is the first checkpoint write. */
const CHAIN = [ready("01"), ready("02", "01")];

/** Every launch's key, in launch order. */
const launches = (world: World): string[] => world.stubs.calls().map((call) => call.key);

/** An exclusive lock on the pool's console.db, held from this process. */
interface StoreLock {
  release(): void;
}

/**
 * Lock console.db exclusively. A write the server has in flight is waited
 * out rather than refused. The teardown lets go too, so a case that fails
 * while it holds the lock leaves nothing locked, but every case releases it
 * itself before it ends: a server stopped while it cannot write is not the
 * orderly stop the teardown checks for.
 */
function lockStore(t: Case, world: World): StoreLock {
  const db = new Database(join(world.pool, "console.db"));
  db.run("PRAGMA busy_timeout = 10000");
  db.run("BEGIN EXCLUSIVE");
  let held = true;
  const lock: StoreLock = {
    release() {
      if (!held) return;
      held = false;
      db.run("ROLLBACK");
      db.close();
    },
  };
  t.defer(() => lock.release());
  return lock;
}

/**
 * A world whose 01 waits on a release file, started, with 01 launched and
 * console.db locked: the case lets 01 finish with `release`.
 */
async function lockedAtLaunch(
  t: Case,
  tickets: TicketSeed[],
): Promise<{ world: World; server: CaseServer; lock: StoreLock; socket: SocketClient; release: () => void }> {
  const world = t.world({ tickets, config: CONFIG });
  const gate = join(world.root, "release-01");
  world.stubs.script("01", { waitFor: gate });
  const server = await t.start(world);
  const socket = await t.socket(server, { visible: true });
  await until(() => launches(world), (keys) => keys.length === 1, { what: "01 to launch", ms: 30_000 });
  const lock = lockStore(t, world);
  return { world, server, lock, socket, release: () => writeFileSync(gate, "go") };
}

/**
 * Wait until a Ticket's `exited` event is on disk, looking every few
 * milliseconds rather than at `until`'s pace: the retry the case lets land
 * is due within the server's backoff, a few hundred milliseconds in all.
 */
async function untilExited(world: World, id: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (readEvents(world.pool, id).some((e) => e.kind === "exited")) return;
    } catch {
      // A line mid-append does not parse yet; the next look sees it whole.
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${id}'s exited event`);
    await Bun.sleep(2);
  }
}

/** The phase of every version a socket was pushed, in order. */
function pushedPhases(socket: SocketClient): string[] {
  const phases: string[] = [];
  let held: PushedSnapshot | null = null;
  for (const frame of socket.frames) {
    if (frame.type === "snapshot") {
      held = frame.snapshot === null ? null : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
    } else if (frame.type === "delta" && held !== null) {
      held = applySnapshotDelta(held, frame.delta);
    } else {
      continue;
    }
    if (held !== null) phases.push(held.snapshot.phase);
  }
  return phases;
}

const PERSISTENCE_BODY =
  "persistence is failing: the checkpoint store failed to write after 4 attempts with backoff.\n" +
  "last error: database is locked\n" +
  "the store remains open. answer this interrupt once the store is healthy to retry persistence and " +
  "continue the run.";

// engine/engine.test.ts:7033
conformance("interrupts", "a checkpoint write refused at the boundary is retried, and the run carries on", async (t) => {
  const { world, server, lock, release } = await lockedAtLaunch(t, CHAIN);
  release();
  // 01's exit and the boundary write after it run in one stretch of the
  // server's event loop, so a request sent once 01's exit is on disk is
  // answered only when that loop is next free: in the backoff after the
  // boundary's first write attempt, which the lock refused. Letting go then
  // leaves the retry to land.
  await untilExited(world, "01");
  expect((await server.http.get("/api/state")).status).toBe(200);
  lock.release();

  const reviewed = await settle(server, (s) => s.state.interrupts.length > 0, { what: "the Review" });
  expect(reviewed.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["REVIEW", "review"]]);
  expect(reviewed.state.log).not.toContain(`interrupt raised for ${PERSISTENCE} (persistence)`);
  expect(launches(world)).toEqual(["01", "02"]);
  expect(reviewed.state.log).toContain("super-step 2: 02");
  const rows = readCheckpoints(world.pool);
  expect(rows.length).toBeGreaterThan(0);
  expect((rows[0]!.state as { tickets: Record<string, string> }).tickets).toEqual({ "01": "done", "02": "ready" });
  expect(existsSync(join(world.pool, "runs", `${PERSISTENCE}.events.jsonl`))).toBe(false);

  await approveReview(server);
});

// engine/engine.test.ts:7071
conformance(
  "interrupts",
  "a store that keeps refusing raises the PERSISTENCE Interrupt and stops scheduling, and a resume once it is healthy carries on",
  async (t) => {
    const { world, server, lock, release } = await lockedAtLaunch(t, CHAIN);
    release();

    const stuck = await settle(server, (s) => s.state.interrupts.length > 0, { what: "the persistence Interrupt" });
    expect(stuck.phase).toBe("quiescent");
    expect(stuck.state.interrupts).toEqual([{ ticketId: PERSISTENCE, kind: "persistence", body: PERSISTENCE_BODY }]);
    expect(statuses(stuck)).toEqual({ "01": "done", "02": "ready" });
    expect(stuck.state.log.slice(-3)).toEqual([
      "ticket 01: exited 0, marker done",
      `interrupt raised for ${PERSISTENCE} (persistence)`,
      `pool quiescent: interrupts pending for ${PERSISTENCE}`,
    ]);
    // The state lines are written before the store is, so they moved on.
    expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
    expect(readStateLine(world.pool, "02-t.md").status).toBe("ready");
    expect(launches(world)).toEqual(["01"]);

    // Healthy again: nothing has written a row, and nothing does until the
    // Interrupt is answered.
    lock.release();
    expect(readCheckpoints(world.pool)).toEqual([]);
    expect((await snapshot(server)).state.interrupts.map((i) => i.ticketId)).toEqual([PERSISTENCE]);

    await answer(server, { ticketId: PERSISTENCE });
    const reviewed = await settle(server, (s) => s.state.interrupts.some((i) => i.kind === "review"), {
      what: "the Review",
    });
    expect(reviewed.state.log).toContain(
      `interrupt answered for ${PERSISTENCE} (persistence): the drive retries the checkpoint write`,
    );
    expect(reviewed.state.log).toContain("super-step 2: 02");
    expect(launches(world)).toEqual(["01", "02"]);
    expect(readEvents(world.pool, PERSISTENCE).map((e) => [e.attempt, e.kind, e.payload])).toEqual([
      [0, "answered", { kind: "persistence" }],
    ]);
    const rows = readCheckpoints(world.pool);
    expect(rows.length).toBeGreaterThan(0);
    expect((rows[0]!.state as { tickets: Record<string, string> }).tickets).toEqual({ "01": "done", "02": "ready" });

    const done = await approveReview(server);
    expect(statuses(done)).toEqual({ "01": "done", "02": "done" });
  },
);

// Uncovered behaviour: engine/engine.ts:5587-5592 (the drain's persist) and
// engine/server.ts:1943.
conformance(
  "interrupts",
  "an answer to the PERSISTENCE Interrupt while the store still refuses is refused with the store's error, and taken once it is healthy",
  async (t) => {
    const { world, server, lock, release } = await lockedAtLaunch(t, CHAIN);
    release();
    await settle(server, (s) => s.state.interrupts.length > 0, { what: "the persistence Interrupt" });

    const early = await resume(server, { ticketId: PERSISTENCE });
    expect(early.status).toBe(400);
    expectParsedEqual(early.text, { error: "database is locked" }, "the 400");
    const still = await snapshot(server);
    expect(still.phase).toBe("quiescent");
    expect(still.state.interrupts).toEqual([{ ticketId: PERSISTENCE, kind: "persistence", body: PERSISTENCE_BODY }]);
    expect(launches(world)).toEqual(["01"]);
    // Accepted before its processing failed: the answer is recorded, and
    // still waits to be processed.
    const queue = (): { answers: { ticketId: string; processedAt: string | null }[] } =>
      JSON.parse(readFileSync(join(world.pool, "runs", "queued-answers.json"), "utf8"));
    expect(queue().answers.map((a) => [a.ticketId, a.processedAt])).toEqual([[PERSISTENCE, null]]);
    expect(readEvents(world.pool, PERSISTENCE).map((e) => e.kind)).toEqual(["answered"]);

    lock.release();
    await answer(server, { ticketId: PERSISTENCE });
    const reviewed = await settle(server, (s) => s.state.interrupts.some((i) => i.kind === "review"), {
      what: "the Review",
    });
    expect(launches(world)).toEqual(["01", "02"]);
    expect(reviewed.state.log).toContain(
      `interrupt answered for ${PERSISTENCE} (persistence): the drive retries the checkpoint write`,
    );
    expect(queue().answers.map((a) => [a.ticketId, a.processedAt !== null])).toEqual([[PERSISTENCE, true]]);
    expect(readEvents(world.pool, PERSISTENCE).map((e) => e.kind)).toEqual(["answered"]);
    expect(readCheckpoints(world.pool).length).toBeGreaterThan(0);
  },
);

// engine/engine.test.ts:7146
conformance("interrupts", "a store that keeps refusing never reports the drive dead", async (t) => {
  const { world, server, lock, socket, release } = await lockedAtLaunch(t, [ready("01")]);
  release();

  const stuck: EnrichedSnapshot = await settle(server, (s) => s.state.interrupts.length > 0, {
    what: "the persistence Interrupt",
  });
  expect(stuck.phase).toBe("quiescent");
  expect(stuck.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([[PERSISTENCE, "persistence"]]);
  // The socket is pushed the same resting version, once its coalescing
  // window has passed.
  const phases = await until(() => pushedPhases(socket), (seen) => seen.at(-1) === "quiescent", {
    what: "the quiescent version pushed on the socket",
    ms: 30_000,
  });
  expect(phases).not.toContain("dead");
  expect(stuck.state.log.some((line) => line.startsWith("pool dead"))).toBe(false);
  expect(existsSync(join(world.pool, "runs", "errors.jsonl"))).toBe(false);
  lock.release();
});
