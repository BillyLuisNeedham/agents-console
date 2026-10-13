/**
 * Restart and takeover of Tickets, seen from outside the server (ADR-0036):
 * what a server starting on a pool makes of the state lines, the last
 * checkpoint in console.db and the files the last server left, and what a
 * killed server leaves for the next. Ticket C05 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over, or the uncovered behaviour it pins.
 *
 * The state lines are the truth at boot: an in-progress Ticket with no live
 * agent goes back to ready with the engine's note, a stored Interrupt whose
 * state line says done or ready is cleared, and a checkpoint state line with
 * no stored Interrupt raises one from the Ticket file's Brief.
 */

import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushedSnapshot, ServerMessage } from "../../protocol/protocol.ts";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";
import { applySnapshotDelta } from "../fixtures/socket-protocol.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { readCheckpoints, readEvents, readMarkers, readStateLine, readTicketFile, until } from "../harness/pool-files.ts";
import { takeover, type Leg } from "../harness/takeover.ts";
import type { World } from "../harness/world.ts";
import {
  CONFIG,
  ENGINE_RESET_NOTE,
  REVIEW,
  answer,
  interruptsOf,
  approveReview,
  eventLine,
  launchKeys,
  poolLog,
  quiescentWith,
  restartCase,
  setStatus,
  settle,
  startLeg,
  statusesOf,
  ticket,
  untilLogged,
  untilState,
} from "./restart-support.ts";

/** The persistence Interrupt's Ticket id (PERSISTENCE_TICKET_ID in engine/engine.ts). */
const PERSISTENCE = "PERSISTENCE";

/** An exclusive lock on the pool's console.db, held from this process. */
interface StoreLock {
  release(): void;
}

/**
 * Lock console.db exclusively, as a second writer would (BEGIN EXCLUSIVE in
 * SQLite's default rollback journal): every write the server tries fails
 * with "database is locked" until the case lets go. The teardown lets go too.
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

/** Each Ticket's status as its state line says now, by id. */
function diskStatuses(world: World): Record<string, string> {
  return Object.fromEntries(Object.values(readMarkers(world.pool)).map((marker) => [marker.id, marker.status]));
}

/** Wait until a Ticket has been launched `n` times. */
function untilLaunched(world: World, id: string, n: number): Promise<unknown> {
  return until(() => launchKeys(world).filter((key) => key === id).length, (count) => count >= n, {
    what: `${id} launched ${n} time(s)`,
    ms: 30_000,
  });
}

/** Commit `text` to shared.txt in the worktree Ticket `id`'s first launch ran in. */
function commitIn(world: World, id: string, text: string): void {
  const launch = world.stubs.calls().find((call) => call.key === id && call.n === 1);
  if (!launch || launch.cwd === world.repo) throw new Error(`${id} did not launch in a worktree of its own`);
  writeFileSync(join(launch.cwd, "shared.txt"), text);
  world.git(["-C", launch.cwd, "add", "-A"]);
  world.git(["-C", launch.cwd, "commit", "-qm", `${id} edits shared.txt`]);
}

// ---------------------------------------------------------------------------
// The state lines at boot
// ---------------------------------------------------------------------------

// engine/engine.test.ts:10238
conformance("restart", "an in-progress state line goes back to ready at boot when no agent holds it", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a", { status: "in-progress", body: "# 01\n\nDo 01." })], config: CONFIG });
  const server = await t.start(world);
  await approveReview(server);

  expect(launchKeys(world)).toEqual(["01"]);
  expect(await poolLog(server)).toContain("ticket 01: marker was in-progress with no live agent; back to ready");
  expectSameBytes(
    readTicketFile(world.pool, "01-a.md"),
    "<!-- state: id=01 blocked-by=none status=done -->\n\n# 01\n\nDo 01.\n" + ENGINE_RESET_NOTE,
  );
});

// engine/engine.test.ts:10300
restartCase("a pending checkpoint Interrupt is restored across a restart and stays answerable", async (t) => {
  const world = t.world({
    tickets: [
      ticket("01", "a", { body: "# 01\n\n## Brief\n\npick a name" }),
      ticket("02", "b", { blockedBy: "01" }),
      ticket("03", "c"),
    ],
    config: CONFIG,
  });
  world.stubs.script("01", { statuses: ["checkpoint", "done"], brief: "pick a name" });
  const first = await startLeg(t, world, 0);
  await settle(first, "01's checkpoint with 03 done", (s) =>
    quiescentWith("01:checkpoint")(s) && s.state.tickets.find((each) => each.id === "03")?.status === "done",
  );
  await first.stop();

  const second = await startLeg(t, world, 1);
  const restored = await settle(second, "01's checkpoint restored", quiescentWith("01:checkpoint"));
  expect(restored.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "pick a name" }]);
  expect(launchKeys(world).sort()).toEqual(["01", "03"]);

  await answer(second, { ticketId: "01", note: "the name is Foo" });
  await approveReview(second);
  expect(launchKeys(world).slice(2)).toEqual(["01", "02"]);
  const text = readTicketFile(world.pool, "01-a.md");
  expect(text).toContain("## Resume note");
  expect(text).toContain("the name is Foo");
});

// engine/engine.test.ts:10200
restartCase("a stored checkpoint Interrupt is cleared at boot when its state line says done", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\nneed a decision" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  world.stubs.script("01", { status: "checkpoint" });
  const first = await startLeg(t, world, 0);
  await settle(first, "01's checkpoint", quiescentWith("01:checkpoint"));
  await first.stop();

  // A human finished 01 by hand: the state line wins over the stored Interrupt.
  setStatus(world, "01-a.md", "done");
  const second = await startLeg(t, world, 1);
  await untilLogged(second, "interrupt cleared for 01 (checkpoint): marker says done");
  const done = await approveReview(second);
  expect(done.state.interrupts).toEqual([]);
  expect(statusesOf(done)).toEqual({ "01": "done", "02": "done" });
  expect(launchKeys(world)).toEqual(["01", "02"]);
});

// engine/engine.test.ts:10266
restartCase("a stored checkpoint Interrupt is cleared at boot when a human set its state line back to ready", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\nneed a decision" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const first = await startLeg(t, world, 0);
  await settle(first, "01's checkpoint", quiescentWith("01:checkpoint"));
  await first.stop();

  setStatus(world, "01-a.md", "ready");
  const second = await startLeg(t, world, 1);
  await untilLogged(second, "interrupt cleared for 01 (checkpoint): marker says ready");
  const done = await approveReview(second);
  expect(done.state.interrupts).toEqual([]);
  expect(launchKeys(world)).toEqual(["01", "01", "02"]);
});

// engine/engine.test.ts:10166, with the gap at engine/engine.ts:2592-2606 (the
// review gate's own log line, which the engine test does not assert).
restartCase("a Ticket set back to ready after an approved Review runs again, and the Review is asked afresh", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b", { blockedBy: "01" })], config: CONFIG });
  const first = await startLeg(t, world, 0);
  await approveReview(first);
  await first.stop();

  // run.sh reset 02: the state line is the truth, the checkpoint's done is
  // stale, and the approval lapses with it.
  setStatus(world, "02-b.md", "ready");
  const second = await startLeg(t, world, 1);
  await untilLogged(
    second,
    "review gate cleared: markers on disk are not all done, so a fresh Review will be raised when they finish",
  );
  const done = await approveReview(second);
  expect(statusesOf(done)).toEqual({ "01": "done", "02": "done" });
  expect(launchKeys(world)).toEqual(["01", "02", "02"]);
});

// engine/engine.test.ts:10428
conformance("restart", "a pool run.sh halted raises its checkpoint Interrupt from the Brief, and a resume runs on to done", async (t) => {
  const world = t.world({
    tickets: [
      ticket("01", "a", { status: "done" }),
      ticket("02", "b", { status: "checkpoint", blockedBy: "01", body: "# 02\n\n## Brief\n\nrun.sh stopped here" }),
      ticket("03", "c", { blockedBy: "02" }),
    ],
    config: CONFIG,
  });
  const server = await t.start(world);
  const raised = await settle(server, "02's checkpoint", quiescentWith("02:checkpoint"));
  expect(raised.state.interrupts).toEqual([{ ticketId: "02", kind: "checkpoint", body: "run.sh stopped here" }]);
  expect(launchKeys(world)).toEqual([]);
  expect(existsSync(join(world.pool, "console.db"))).toBe(true);

  await answer(server, { ticketId: "02" });
  const done = await approveReview(server);
  expect(statusesOf(done)).toEqual({ "01": "done", "02": "done", "03": "done" });
  expect(launchKeys(world)).toEqual(["02", "03"]);
});

// engine/engine.test.ts:7932
restartCase("a checkpoint Interrupt is raised again from the engine-written Brief when console.db is gone", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  world.stubs.script("01", { status: "checkpoint", brief: "pick a name" });
  const first = await startLeg(t, world, 0);
  await settle(first, "01's checkpoint", quiescentWith("01:checkpoint"));
  await first.stop();
  const landed = readTicketFile(world.pool, "01-a.md");
  expectSameBytes(
    landed,
    "<!-- state: id=01 blocked-by=none status=checkpoint -->\n\n# 01\n\nWork on 01.\n\n---\n\n## Brief\n\npick a name\n",
  );

  // Killed before the boundary's write, say: no stored checkpoint survives,
  // but the state line and the Brief the engine landed are on disk.
  rmSync(join(world.pool, "console.db"), { force: true });
  const second = await startLeg(t, world, 1);
  const raised = await settle(second, "01's checkpoint raised again", quiescentWith("01:checkpoint"));
  expect(raised.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "pick a name" }]);
  expect(launchKeys(world)).toEqual(["01"]);
  expectSameBytes(readTicketFile(world.pool, "01-a.md"), landed);
  expect(eventLine(world, "01").slice(-2)).toEqual(["1 checkpoint", "1 checkpoint"]);
});

// ---------------------------------------------------------------------------
// Interrupts and the Review across a takeover
// ---------------------------------------------------------------------------

/** The run at rest with the Review alone pending. */
async function untilReview(leg: Leg<unknown>): Promise<EnrichedSnapshot> {
  return settle(leg.server, "the Review alone", quiescentWith(`${REVIEW}:review`));
}

// engine/engine.test.ts:7647
takeover("restart", "a crashed Ticket's Interrupt stays pending across each takeover, and a resume runs it again to done", {
  world: { tickets: [ticket("01", "a")], config: CONFIG },
  // The first launch writes no Outcome, so it crashes; the second is done.
  prepare: (world) => world.stubs.script("01", { statuses: ["keep", "done"] }),
  async reach() {},
  async stopPoint(leg) {
    const crashed = await settle(leg.server, "01's crash Interrupt", quiescentWith("01:crash"));
    // The state line still reads in-progress, but the pending Interrupt
    // means no human has looked yet: no boot may run 01 again on its own.
    expect(statusesOf(crashed)).toEqual({ "01": "in-progress" });
    expect(readStateLine(leg.world.pool, "01-a.md").status).toBe("in-progress");
    expect(launchKeys(leg.world)).toEqual(["01"]);
  },
  async finish(leg) {
    await answer(leg.server, { ticketId: "01" });
    await approveReview(leg.server);
    expect(launchKeys(leg.world)).toEqual(["01", "01"]);
  },
});

// engine/engine.test.ts:9881
takeover("restart", "an approved Review ends the run, and each takeover comes up done without asking again", {
  world: { tickets: [ticket("01", "a")], config: CONFIG },
  async reach(leg) {
    await untilReview(leg);
    await answer(leg.server, { ticketId: REVIEW, action: "approve", note: "looks right" });
    const done = await settle(leg.server, "the run done", (s) => s.phase === "done");
    expect(done.state.log).toContain("review approved: the run is complete (looks right)");
    expect(done.state.log.at(-1)).toBe("pool done: every ticket reached done");
  },
  async stopPoint(leg) {
    const done = await settle(leg.server, "the run done", (s) => s.phase === "done");
    expect(done.state.interrupts).toEqual([]);
    expect(launchKeys(leg.world)).toEqual(["01"]);
  },
  async finish() {},
  verify(legs) {
    // No later server asks the Review again, or launches anything.
    for (const leg of legs) {
      expect(readEvents(leg.world.pool, REVIEW).map((event) => event.kind)).toEqual(["answered"]);
    }
  },
});

// engine/engine.test.ts:13877
takeover("restart", "a Ticket Closed at its checkpoint stays closed across each takeover, with only the Review asked", {
  world: { tickets: [ticket("01", "a"), ticket("02", "b")], config: CONFIG },
  prepare: (world) => world.stubs.script("01", { status: "checkpoint" }),
  async reach(leg) {
    await settle(leg.server, "01's checkpoint", quiescentWith("01:checkpoint"));
    await answer(leg.server, { ticketId: "01", action: "close" });
  },
  async stopPoint(leg) {
    const reviewed = await untilReview(leg);
    expect(statusesOf(reviewed)).toEqual({ "01": "closed", "02": "done" });
    expect(readStateLine(leg.world.pool, "01-a.md").status).toBe("closed");
    expect(launchKeys(leg.world).sort()).toEqual(["01", "02"]);
  },
  async finish(leg) {
    const done = await approveReview(leg.server);
    expect(statusesOf(done)).toEqual({ "01": "closed", "02": "done" });
  },
});

// ---------------------------------------------------------------------------
// A crash, a dead drive and a store that refuses
// ---------------------------------------------------------------------------

// engine/engine.test.ts:10346
restartCase("a server killed mid-super-step leaves its done Ticket done, and the next server runs only the other", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b")], config: CONFIG });
  world.stubs.script("01", { outcome: { summary: "recovered-01", commitSha: "sha-01" } });
  const second02 = world.stubs.hold("02");
  const first = await startLeg(t, world, 0);
  await until(
    () => diskStatuses(world),
    (disk) => disk["01"] === "done" && disk["02"] === "in-progress",
    { what: "01 done and 02 in-progress on disk", ms: 30_000 },
  );
  await first.kill();
  const orphan = readEvents(world.pool, "02").find((event) => event.kind === "spawned")?.payload.pid;
  if (typeof orphan !== "number") throw new Error("02's attempt 1 recorded no pid");

  const second = await startLeg(t, world, 1);
  await untilLaunched(world, "02", 2);
  await second02.release();
  const done = await approveReview(second);
  expect(launchKeys(world).sort()).toEqual(["01", "02", "02"]);
  // A SIGKILL stops nothing: 02's held launch outlived the server in its
  // worktree, so the boot stops it as an orphan before 02 goes back to ready.
  expect(await poolLog(second)).toContain(
    `ticket 02: marker was in-progress and attempt 1 (pid ${orphan}) is still running from the previous engine process; ` +
      "stopping it before scheduling, ticket back to ready",
  );
  // 01 finished before the kill, but no boundary wrote it: its Outcome file
  // on disk is what the next server reads.
  expect(done.state.outcomes["01"]).toEqual({ status: "done", summary: "recovered-01", commitSha: "sha-01" });
});

// engine/engine.test.ts:7226
restartCase("a pool whose drive died on a missing harness binary runs from disk on the next server", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a", { body: "# 01\n\nDo 01." })], config: CONFIG });
  // No claude on the first server's PATH: the launch inside the first
  // super-step fails and kills the drive.
  const path = world.env("").PATH!.split(":").filter((dir) => dir !== world.stubs.bin).join(":");
  if (Bun.which("claude", { PATH: path }) !== null) {
    throw new Error(`a claude outside the stubs is on ${path}; this case needs none`);
  }
  const first = await startLeg(t, world, 0, { env: { PATH: path } });
  await settle(first, "the drive to die", (s) => s.phase === "dead");
  expect(readStateLine(world.pool, "01-a.md").status).toBe("in-progress");
  const errors = readFileSync(join(world.pool, "runs", "errors.jsonl"), "utf8");
  await first.stop();

  const second = await startLeg(t, world, 1);
  const done = await approveReview(second);
  expect(statusesOf(done)).toEqual({ "01": "done" });
  expect(launchKeys(world)).toEqual(["01"]);
  expect(await poolLog(second)).toContain("ticket 01: marker was in-progress with no live agent; back to ready");
  expectSameBytes(
    readTicketFile(world.pool, "01-a.md"),
    "<!-- state: id=01 blocked-by=none status=done -->\n\n# 01\n\nDo 01.\n" + ENGINE_RESET_NOTE,
  );
  // The dead drive's error log survives the restart as it was.
  expectSameBytes(readFileSync(join(world.pool, "runs", "errors.jsonl"), "utf8"), errors);
});

// engine/engine.test.ts:7114
restartCase("a pool whose store kept refusing resumes from its state lines on the next server, and 01 never runs again", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b", { blockedBy: "01" })], config: CONFIG });
  const held = world.stubs.hold("01");
  const first = await startLeg(t, world, 0);
  await untilLaunched(world, "01", 1);
  // From 01's launch, after the server has opened its store and read it at
  // boot, every write the server tries is refused.
  const lock = lockStore(t, world);
  await held.release();
  const stuck = await settle(first, "the persistence Interrupt", quiescentWith(`${PERSISTENCE}:persistence`));
  expect(statusesOf(stuck)).toEqual({ "01": "done", "02": "ready" });
  await first.stop();
  lock.release();

  // The state lines were written before the store refused, so disk already
  // says 01 is done: restarting from disk is the way out.
  expect(diskStatuses(world)).toEqual({ "01": "done", "02": "ready" });
  expect(readCheckpoints(world.pool)).toEqual([]);
  const second = await startLeg(t, world, 1);
  const done = await approveReview(second);
  expect(statusesOf(done)).toEqual({ "01": "done", "02": "done" });
  expect(launchKeys(world)).toEqual(["01", "02"]);
});

// ---------------------------------------------------------------------------
// The state lines and every snapshot
// ---------------------------------------------------------------------------

/** One look at the state lines: on disk once `frame` (an index into the pushed versions) had arrived. */
interface DiskLook {
  frame: number;
  disk: Record<string, string>;
}

/** The Ticket statuses of every version a socket was pushed, in order. */
function pushedStatuses(socket: SocketClient): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let held: PushedSnapshot | null = null;
  for (const frame of socket.frames as ServerMessage[]) {
    if (frame.type === "snapshot") {
      held = frame.snapshot === null ? null : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
    } else if (frame.type === "delta" && held !== null) {
      held = applySnapshotDelta(held, frame.delta);
    } else {
      continue;
    }
    if (held !== null) out.push(statusesOf(held.snapshot));
  }
  return out;
}

// engine/engine.test.ts:10119
conformance("restart", "the state lines agree with every snapshot the socket is pushed, and with the last checkpoint at rest", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\nneed a decision" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  const held = world.stubs.hold("01", { status: "checkpoint" });
  const server = await t.start(world);
  const socket = await t.socket(server, { visible: false });

  // Read the state lines each time a version arrives. The engine writes a
  // state line before it emits the snapshot that shows it, so what a read
  // finds once version i has arrived is version i's statuses or a later
  // version's: never one no version shows, and never an older one.
  const looks: DiskLook[] = [];
  let watching = true;
  const watch = (async () => {
    let seen = 0;
    while (watching) {
      const versions = pushedStatuses(socket).length;
      if (versions > seen) {
        seen = versions;
        looks.push({ frame: versions - 1, disk: diskStatuses(world) });
      }
      await Bun.sleep(2);
    }
  })();

  // While 01's launch is held nothing can move, so the in-progress version
  // and the state lines must agree exactly.
  await untilLaunched(world, "01", 1);
  await until(
    () => pushedStatuses(socket).at(-1),
    (latest) => latest?.["01"] === "in-progress",
    { what: "a version with 01 in-progress", ms: 30_000 },
  );
  expect(pushedStatuses(socket).at(-1)).toEqual({ "01": "in-progress", "02": "ready" });
  expect(diskStatuses(world)).toEqual({ "01": "in-progress", "02": "ready" });

  await held.release();
  await settle(server, "01's checkpoint", quiescentWith("01:checkpoint"));
  await until(
    () => pushedStatuses(socket).at(-1),
    (latest) => latest?.["01"] === "checkpoint",
    { what: "the checkpoint version pushed", ms: 30_000 },
  );
  watching = false;
  await watch;

  const versions = pushedStatuses(socket);
  expect(looks.length).toBeGreaterThan(0);
  for (const look of looks) {
    const later = versions.slice(look.frame).some((statuses) => Bun.deepEquals(statuses, look.disk));
    expect(later, `the state lines read after version ${look.frame}: ${JSON.stringify(look.disk)}`).toBe(true);
  }
  const atRest = { "01": "checkpoint", "02": "ready" };
  expect(versions.at(-1)).toEqual(atRest);
  expect(diskStatuses(world)).toEqual(atRest);
  // The newest checkpoint row agrees too, once it has landed.
  await until(
    () => (readCheckpoints(world.pool).at(-1)?.state as { tickets?: Record<string, string> } | undefined)?.tickets,
    (tickets) => Bun.deepEquals(tickets, atRest),
    { what: "the newest checkpoint row to agree with the state lines", ms: 30_000 },
  );
});

// ---------------------------------------------------------------------------
// Gaps the inventory lists for `restart`
// ---------------------------------------------------------------------------

/** 02 done, its merge conflict waiting on the operator and holding the pool. */
function heldBehind02(snapshot: EnrichedSnapshot): boolean {
  const card = snapshot.state.tickets.find((each) => each.id === "02");
  return interruptsOf(snapshot).join(" ") === "02:merge-conflict" && card?.mergeState === "needs-you";
}

// Gap: engine/engine.ts:2608-2623. A merge Interrupt is kept while the state
// line says done; one whose state line says closed is cleared.
restartCase("a merge-conflict Interrupt survives a restart while its state line says done, and is cleared once it says closed", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\nEdit shared.txt." }), ticket("02", "b", { body: "# 02\n\nEdit it too." })],
    // No resolver: the conflict waits on the operator rather than an Attempt.
    config: { ...CONFIG, resolver: "none" },
    repoFiles: { "shared.txt": "base\n" },
  });
  const first01 = world.stubs.hold("01");
  const first02 = world.stubs.hold("02");
  const first = await startLeg(t, world, 0);
  await untilLaunched(world, "01", 1);
  await untilLaunched(world, "02", 1);
  commitIn(world, "01", "from 01\n");
  commitIn(world, "02", "from 02\n");
  await first01.release();
  // 02 is still held, so the drive is still running: any phase will do.
  await untilState(first, "01 done and merged", (s) => {
    const card = s.state.tickets.find((each) => each.id === "01");
    return card?.status === "done" && card.mergeState === null;
  });
  await first02.release();
  // A done Ticket whose merge waits on the operator holds the pool, which
  // reads running while it waits: wait on the Interrupt, not on a rest.
  await untilState(first, "02's merge conflict", heldBehind02);
  await first.stop();

  const second = await startLeg(t, world, 1);
  const kept = await untilState(second, "02's merge conflict kept", heldBehind02);
  expect(statusesOf(kept)).toEqual({ "01": "done", "02": "done" });
  expect((await poolLog(second)).filter((line) => line.startsWith("interrupt cleared for 02"))).toEqual([]);
  await second.stop();

  setStatus(world, "02-b.md", "closed");
  const third = await startLeg(t, world, 2);
  await untilLogged(third, "interrupt cleared for 02 (merge-conflict): marker says closed");
  const reviewed = await settle(third, "the Review alone", quiescentWith(`${REVIEW}:review`));
  expect(statusesOf(reviewed)).toEqual({ "01": "done", "02": "closed" });
  const done = await approveReview(third);
  expect(done.state.interrupts).toEqual([]);
  // A closed Ticket's branch is never merged.
  expect(world.git(["show", "main:shared.txt"])).toBe("from 01\n");
  expect(launchKeys(world).sort()).toEqual(["01", "02"]);
});

// Gap: engine/engine.ts:2530-2534.
restartCase("a restart says how many Interrupts and outcomes it restored from the last checkpoint", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b")], config: CONFIG });
  world.stubs.script("02", { statuses: ["checkpoint", "done"], brief: "which way" });
  const first = await startLeg(t, world, 0);
  await settle(first, "02's checkpoint with 01 done", (s) =>
    quiescentWith("02:checkpoint")(s) && statusesOf(s)["01"] === "done",
  );
  // A fresh pool has no checkpoint to restore from.
  expect((await poolLog(first)).filter((line) => line.startsWith("rehydrated from checkpoint"))).toEqual([]);
  await until(
    () => readCheckpoints(world.pool).at(-1)?.state as { interrupts?: unknown[]; outcomes?: Record<string, unknown> } | undefined,
    (state) => state?.interrupts?.length === 1 && Object.keys(state.outcomes ?? {}).length === 2,
    { what: "a checkpoint row with one Interrupt and two outcomes", ms: 30_000 },
  );
  await first.stop();

  const second = await startLeg(t, world, 1);
  await settle(second, "02's checkpoint restored", quiescentWith("02:checkpoint"));
  const lines = await untilLogged(second, "rehydrated from checkpoint");
  expect(lines.filter((line) => line.startsWith("rehydrated from checkpoint"))).toEqual([
    "rehydrated from checkpoint: 1 interrupt(s), 2 outcome(s) restored",
  ]);
});

/** The socket's hello frame. */
async function helloOf(socket: SocketClient): Promise<Extract<ServerMessage, { type: "hello" }>> {
  return socket.waitFor<Extract<ServerMessage, { type: "hello" }>>((frame) => frame.type === "hello", {
    what: "the hello",
    ms: 30_000,
  });
}

/** Save a Pool title and wait until the socket has been pushed the version carrying it. */
async function pushTitle(server: CaseServer, socket: SocketClient, title: string): Promise<void> {
  const saved = await server.http.put("/api/settings/pool", { config: { title } });
  if (saved.status !== 200) throw new Error(`saving the title answered ${saved.status}: ${saved.text}`);
  await until(() => socket.pushed?.snapshot.poolTitle, (pushed) => pushed === title, {
    what: `the title ${title} pushed`,
    ms: 30_000,
  });
}

// Gap: engine/ws.ts:382.
restartCase("a restarted server greets its sockets under a new epoch and counts its revisions afresh", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  const first = await startLeg(t, world, 0);
  await approveReview(first);
  const before = await t.socket(first, { visible: false });
  const greeted = await helloOf(before);
  await until(() => before.pushed, (pushed) => pushed !== null, { what: "the first snapshot", ms: 30_000 });
  // Every title saved is a version of its own, so the first server's
  // revision climbs well past anything a fresh boot pushes.
  for (let n = 1; n <= 12; n++) await pushTitle(first, before, `title ${n}`);
  const lastRev = before.rev;
  expect(lastRev).toBeGreaterThanOrEqual(12);
  await first.stop();

  const second = await startLeg(t, world, 1);
  await settle(second, "the run done", (s) => s.phase === "done");
  const after = await t.socket(second, { visible: false });
  const regreeted = await helloOf(after);
  expect(regreeted.epoch).not.toBe(greeted.epoch);
  // The first version the new socket is sent goes whole, at the new
  // server's own revision.
  const whole = await after.waitFor<Extract<ServerMessage, { type: "snapshot" }>>(
    (frame) => frame.type === "snapshot" || frame.type === "delta",
    { what: "the first version", ms: 30_000 },
  );
  expect(whole.type).toBe("snapshot");
  expect(whole.rev).toBeGreaterThanOrEqual(1);
  expect(whole.rev).toBeLessThan(lastRev);
  // And the next version is a delta from it.
  const from = after.frames.length;
  await pushTitle(second, after, "after the restart");
  const delta = await after.waitFor<Extract<ServerMessage, { type: "delta" }>>((frame) => frame.type === "delta", {
    from,
    what: "the delta after the title",
    ms: 30_000,
  });
  expect([delta.delta.base, delta.delta.rev]).toEqual([whole.rev, whole.rev + 1]);
});
