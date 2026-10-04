/**
 * Headless orphans across a stop and start, seen from outside the server
 * (ADR-0017, ADR-0036). A stopping server stops every headless Attempt with
 * its whole process group, TERM first and KILL once the 5 s grace has
 * passed, records each stop as what it was and raises no crash Interrupt for
 * it, so the next boot puts the Ticket back to ready. A booting server stops
 * an Attempt a previous server left running in its working tree before it
 * schedules anything, and leaves alone a recorded pid that is alive but
 * working elsewhere. Ticket C05 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over.
 *
 * A headless Attempt's spawned event records its pid, the leader of a
 * process group of its own. The stubs fork their grandchildren from their
 * `run` scripts and write each one's pid where the case reads it. An orphan
 * at boot is a stub a SIGKILLed server left behind, or a process the case
 * starts itself as its own group leader, with the events file and state line
 * a server would have left.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, TicketEvent } from "../../engine/wire.ts";
import { applySnapshotDelta } from "../fixtures/socket-protocol.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { conformance, type Case } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { readEvents, readStateLine, readTicketFile, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  CONFIG,
  ENGINE_RESET_NOTE,
  REVIEW,
  eventLine,
  launchKeys,
  poolLog,
  quiescentWith,
  restartCase,
  settle,
  stateLine,
  startLeg,
  ticket,
} from "./restart-support.ts";

/** How long a stopped harness gets on TERM before KILL (CHILD_STOP_GRACE_MS in engine/children.ts). */
const GRACE_MS = 5_000;

/** Timer slack: a timer may fire a hair before its time. */
const SLACK_MS = 100;

/** A stop gives every Attempt the grace and the drive its settle wait: well past both on a loaded box. */
const STOP_MS = 30_000;

/** A Ticket's body as `ticket()` seeds it, so its file can be pinned whole. */
const body = (id: string): string => `# ${id}\n\nWork on ${id}.`;

/**
 * The stub's work for an Attempt that lingers: it forks a sleeper, writes
 * the sleeper's pid to `grandchild-<key>.pid` in the stubs directory, and
 * waits on it, as a harness waits on its tool calls. All of it runs in the
 * stub's process group.
 */
const LINGER = 'sleep 120 & echo $! > "$CONFORMANCE_STUBS/grandchild-$STUB_KEY.pid"; wait';

/** The crash reason of a headless Attempt a shutdown stopped. */
const stoppedByShutdown = (code: number): string => `harness stopped by engine shutdown (exited ${code})`;

/** The crash reason of an orphan a boot stopped. */
const orphanStopped = (pid: number): string =>
  `orphan attempt (pid ${pid}) from a previous engine process was still running at boot; stopped by the engine`;

/**
 * The note the engine appends to a Ticket whose Attempt it found still
 * running at boot and stopped (engineOrphanNote in engine/engine.ts), byte
 * for byte.
 */
const orphanNote = (attempt: number, pid: number): string =>
  "\n---\n\n## Brief, written by the engine\n\n" +
  "The engine process stopped while this ticket was in-progress, and at " +
  `the next boot attempt ${attempt} (pid ${pid}) was found still running in the working tree. ` +
  "The engine stopped it before scheduling anything, so the work is part " +
  "done at best and the agent left no brief. The ticket is back to ready; " +
  "read the working tree before it runs again.\n";

/** The working directory read from /proc, which the server's orphan check depends on. */
const LINUX_ONLY =
  process.platform === "linux"
    ? undefined
    : "the server reads a pid's working directory from /proc; off Linux it trusts liveness alone (engine/children.ts processCwd)";

/**
 * Whether `pid` names a process still running: one that has exited but not
 * been reaped yet (a zombie, where /proc can say so) counts as gone.
 */
function running(pid: number): boolean {
  let stat: string | null = null;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    // No procfs (macOS), or no such process.
  }
  if (stat !== null) return stat[stat.lastIndexOf(")") + 2] !== "Z";
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wait until `pid` is gone. */
async function untilGone(pid: number, what: string, ms = 30_000): Promise<void> {
  await until(() => running(pid), (alive) => !alive, { what: `${what} (pid ${pid}) to be gone`, ms });
}

/** Kill a process group at teardown, whatever is left of it. */
function killGroupAtTeardown(t: Case, pid: () => number): void {
  t.defer(() => {
    const leader = pid();
    if (leader <= 0) return;
    try {
      process.kill(-leader, "SIGKILL");
    } catch {
      // Gone already, which is the point.
    }
  });
}

/** Attempt `attempt`'s spawned event once it records a pid. */
async function spawnedPid(world: World, id: string, attempt = 1): Promise<number> {
  const events = await until(
    () => readEvents(world.pool, id),
    (all) => all.some((event) => event.kind === "spawned" && event.attempt === attempt && typeof event.payload.pid === "number"),
    { what: `${id}'s attempt ${attempt} spawned with a pid`, ms: 30_000 },
  );
  return events.find((event) => event.kind === "spawned" && event.attempt === attempt)!.payload.pid as number;
}

/** The pid of the sleeper a LINGER stub forked, once it has written it. */
async function grandchildPid(world: World, key: string): Promise<number> {
  const path = join(world.stubs.dir, `grandchild-${key}.pid`);
  const text = await until(
    () => (existsSync(path) ? readFileSync(path, "utf8").trim() : ""),
    (got) => /^\d+$/.test(got),
    { what: `${key}'s grandchild pid`, ms: 30_000 },
  );
  return Number(text);
}

/** A Ticket's events of one kind. */
function eventsOf(world: World, id: string, kind: string): TicketEvent[] {
  return readEvents(world.pool, id).filter((event) => event.kind === kind);
}

/** The phase and seq every snapshot or delta frame on a socket left it at, in order. */
function framePhases(socket: SocketClient): { seq: number; phase: string }[] {
  let pushed: Parameters<typeof applySnapshotDelta>[0] | null = null;
  const out: { seq: number; phase: string }[] = [];
  for (const frame of socket.frames) {
    if (frame.type === "snapshot") {
      pushed = frame.snapshot === null ? null : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
    } else if (frame.type === "delta") {
      pushed = applySnapshotDelta(pushed!, frame.delta);
    } else {
      continue;
    }
    if (pushed !== null) out.push({ seq: pushed.snapshot.seq, phase: pushed.snapshot.phase });
  }
  return out;
}

/** The snapshot a socket's frames built last. */
function lastPushed(socket: SocketClient): EnrichedSnapshot {
  if (socket.pushed === null) throw new Error("the socket was pushed no snapshot");
  return socket.pushed.snapshot;
}

/** A process the case starts itself, its own group leader, as a previous server's harness was. */
function startOrphan(t: Case, cwd: string, script: string): number {
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd,
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  killGroupAtTeardown(t, () => proc.pid);
  return proc.pid;
}

/** A sleeper that holds its working directory and ignores nothing. */
const SLEEPER = "sleep 120 & wait";

/**
 * What a previous server left of a headless Attempt it never saw end: the
 * Ticket in-progress, and attempt 1 scheduled and spawned with its pid and
 * working directory, the spawned event in the shape a headless launch
 * writes it (the payload's argv and environment trimmed to what this pool's
 * launch would show).
 */
function leftInProgress(world: World, id: string, file: string, pid: number, cwd: string): void {
  const runs = join(world.pool, "runs");
  mkdirSync(runs, { recursive: true });
  const at = new Date().toISOString();
  const events = [
    { at, attempt: 1, kind: "scheduled", payload: {} },
    {
      at,
      attempt: 1,
      kind: "spawned",
      payload: {
        argv: ["claude", "-p", `/implement ${join(world.pool, "issues", file)}\n\n<prompt>`, "--model", "m"],
        cwd,
        branch: null,
        commitSha: null,
        env: { PWD: cwd },
        harness: "claude",
        model: "m",
        pid,
      },
    },
  ];
  writeFileSync(join(runs, `${id}.events.jsonl`), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
}

// engine/attempt-ending.test.ts:361
conformance(
  "restart",
  "a stop mid-attempt records the harness as stopped by the engine shutdown, raises no crash Interrupt and leaves the Ticket in-progress",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
    world.stubs.script("01", { run: LINGER });
    const server = await t.start(world);
    const socket = await t.socket(server, { visible: true });
    const pid = await spawnedPid(world, "01");
    killGroupAtTeardown(t, () => pid);
    await grandchildPid(world, "01");
    expect(running(pid)).toBe(true);

    await server.stop(STOP_MS);

    expect(running(pid)).toBe(false);
    expect(eventLine(world, "01")).toEqual(["1 scheduled", "1 spawned", "1 exited", "1 crash"]);
    expect(eventsOf(world, "01", "exited")[0]!.payload).toEqual({
      code: 143,
      status: "in-progress",
      logTail: [],
      outcomeExists: false,
    });
    expect(eventsOf(world, "01", "crash")[0]!.payload).toEqual({
      code: 143,
      reason: stoppedByShutdown(143),
      logTail: [],
      outcomeExists: false,
    });
    // No crash Interrupt: the farewell the socket was sent carries none, and
    // the Ticket waits in-progress for the next boot to put it back to ready.
    await socket.closed;
    expect(lastPushed(socket).phase).toBe("stopped");
    expect(lastPushed(socket).state.interrupts).toEqual([]);
    expectSameBytes(readStateLine(world.pool, "01-a.md").line, stateLine("01", "in-progress"));
  },
);

// engine/children.test.ts:46
conformance(
  "restart",
  "a stop ends every headless Attempt's whole process group, grandchildren included, and the server exits once they are gone",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a"), ticket("02", "b")], config: CONFIG });
    world.stubs.script("01", { run: LINGER });
    world.stubs.script("02", { run: LINGER });
    const server = await t.start(world);
    const stubs = [await spawnedPid(world, "01"), await spawnedPid(world, "02")];
    for (const pid of stubs) killGroupAtTeardown(t, () => pid);
    const grandchildren = [await grandchildPid(world, "01"), await grandchildPid(world, "02")];
    for (const pid of [...stubs, ...grandchildren]) expect(running(pid)).toBe(true);

    await server.stop(STOP_MS);

    // Each stub exited on the TERM, and the server waited for both before it
    // exited: they are gone the moment it is.
    for (const pid of stubs) expect(running(pid)).toBe(false);
    for (const id of ["01", "02"]) {
      expect(eventsOf(world, id, "crash").map((event) => event.payload.reason)).toEqual([stoppedByShutdown(143)]);
    }
    // The TERM went to each stub's whole group, so the sleepers it forked went too.
    for (const pid of grandchildren) await untilGone(pid, "a grandchild");
  },
);

// engine/children.test.ts:62
conformance(
  "restart",
  "a stop kills a headless Attempt that ignores TERM once the 5 s grace has passed, and the server exits after it",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
    // The stub ignores TERM from its first instruction: an ignored signal
    // stays ignored across exec, and in everything the stub forks.
    const wrapper = join(world.stubs.bin, "claude");
    const lines = readFileSync(wrapper, "utf8").split("\n");
    const exec = lines.findIndex((line) => line.startsWith("exec "));
    if (exec < 0) throw new Error(`no exec line in ${wrapper}`);
    lines.splice(exec, 0, "trap '' TERM");
    writeFileSync(wrapper, lines.join("\n"));
    world.stubs.script("01", { run: LINGER });
    const server = await t.start(world);
    const pid = await spawnedPid(world, "01");
    killGroupAtTeardown(t, () => pid);
    const grandchild = await grandchildPid(world, "01");

    const signalled = Date.now();
    const stopped = server.stop(STOP_MS);
    await untilGone(pid, "the stub that ignores TERM");
    const goneAfter = Date.now() - signalled;
    await stopped;

    // It outlived the TERM by the whole grace, and the KILL that followed
    // took its group: the exit code is the KILL's.
    expect(goneAfter).toBeGreaterThanOrEqual(GRACE_MS - SLACK_MS);
    expect(eventsOf(world, "01", "exited")[0]!.payload.code).toBe(137);
    expect(eventsOf(world, "01", "crash").map((event) => event.payload)).toEqual([
      { code: 137, reason: stoppedByShutdown(137), logTail: [], outcomeExists: false },
    ]);
    await untilGone(grandchild, "the grandchild");
  },
);

// engine/children.test.ts:86
conformance(
  "restart",
  "boot stops a recorded pid alive in its Attempt's working tree, and leaves one alive elsewhere or whose working tree is gone",
  async (t) => {
    const world = t.world({
      tickets: [
        ticket("01", "a", { status: "in-progress" }),
        ticket("02", "b", { status: "in-progress" }),
        ticket("03", "c", { status: "in-progress" }),
      ],
      config: CONFIG,
    });
    const dir = (name: string): string => {
      const path = join(world.root, name);
      mkdirSync(path, { recursive: true });
      return path;
    };
    // 01's Attempt is still running where it was spawned: an orphan.
    const orphan = startOrphan(t, dir("wt-01"), SLEEPER);
    leftInProgress(world, "01", "01-a.md", orphan, join(world.root, "wt-01"));
    // 02's pid is alive, but working in another directory: a reused pid.
    const elsewhere = startOrphan(t, dir("elsewhere"), SLEEPER);
    dir("wt-02");
    leftInProgress(world, "02", "02-b.md", elsewhere, join(world.root, "wt-02"));
    // 03's pid is alive, but its working tree is gone: nothing there is ours.
    const homeless = startOrphan(t, dir("wt-03"), SLEEPER);
    leftInProgress(world, "03", "03-c.md", homeless, join(world.root, "wt-03"));
    for (const pid of [orphan, elsewhere, homeless]) {
      await until(() => running(pid), (alive) => alive, { what: `pid ${pid} running` });
    }
    rmSync(join(world.root, "wt-03"), { recursive: true });

    const server = await t.start(world);
    await settle(server, "the Review after every re-run", quiescentWith(`${REVIEW}:review`), 60_000);

    expect(running(orphan)).toBe(false);
    expect(eventsOf(world, "01", "crash").map((event) => ({ attempt: event.attempt, payload: event.payload }))).toEqual([
      {
        attempt: 1,
        payload: { code: null, reason: orphanStopped(orphan), logTail: [], outcomeExists: false, pid: orphan },
      },
    ]);
    for (const [id, pid] of [["02", elsewhere], ["03", homeless]] as const) {
      expect(running(pid)).toBe(true);
      expect(eventsOf(world, id, "crash")).toEqual([]);
    }
    const log = await poolLog(server);
    expect(log).toContain(`ticket 01: orphan attempt 1 (pid ${orphan}) stopped at boot`);
    expect(log).toContain("ticket 02: marker was in-progress with no live agent; back to ready");
    expect(log).toContain("ticket 03: marker was in-progress with no live agent; back to ready");
    for (const [id, letter] of [["02", "b"], ["03", "c"]] as const) {
      expectSameBytes(
        readTicketFile(world.pool, `${id}-${letter}.md`),
        `${stateLine(id, "done")}\n\n${body(id)}\n${ENGINE_RESET_NOTE}`,
      );
    }
    expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "done")}\n\n${body("01")}\n${orphanNote(1, orphan)}`);
  },
  { skip: LINUX_ONLY },
);

// engine/children.test.ts:109
conformance(
  "restart",
  "boot gives an orphan that ignores TERM the 5 s grace, then KILL, and records it as stopped by the engine",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a", { status: "in-progress" })], config: CONFIG });
    const worktree = join(world.root, "wt-01");
    mkdirSync(worktree);
    // It notes each TERM it is sent and carries on; the line after the trap
    // says the trap is armed, so no TERM can land before it.
    const terms = join(world.root, "terms");
    const armed = join(world.root, "armed");
    const orphan = startOrphan(
      t,
      worktree,
      `trap 'echo TERM >> "${terms}"' TERM; : > "${armed}"; while :; do sleep 1; done`,
    );
    await until(() => existsSync(armed), (yes) => yes, { what: "the orphan's TERM trap armed" });
    leftInProgress(world, "01", "01-a.md", orphan, worktree);

    const booted = Date.now();
    const server = await t.start(world);
    const crash = await until(
      () => eventsOf(world, "01", "crash"),
      (crashes) => crashes.length > 0,
      { what: "the orphan's stop recorded", ms: 30_000 },
    );

    // TERM first, which it survived; KILL once the grace had passed.
    expect(readFileSync(terms, "utf8")).toContain("TERM");
    await untilGone(orphan, "the orphan");
    expect(Date.parse(crash[0]!.at) - booted).toBeGreaterThanOrEqual(GRACE_MS - SLACK_MS);
    expect(crash.map((event) => ({ attempt: event.attempt, payload: event.payload }))).toEqual([
      {
        attempt: 1,
        payload: { code: null, reason: orphanStopped(orphan), logTail: [], outcomeExists: false, pid: orphan },
      },
    ]);
    expect(await poolLog(server)).toContain(`ticket 01: orphan attempt 1 (pid ${orphan}) stopped at boot`);
  },
);

// engine/engine.test.ts:13101
restartCase(
  "a stop ends a running Attempt and its grandchild and says goodbye with one stopped frame, and the next boot re-runs the Ticket once",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
    world.stubs.launches("01", [{ run: LINGER }, {}]);
    const first = await startLeg(t, world, 0);
    const socket = await t.socket(first, { visible: true });
    const pid = await spawnedPid(world, "01");
    killGroupAtTeardown(t, () => pid);
    const grandchild = await grandchildPid(world, "01");
    expect(running(pid)).toBe(true);
    expect(running(grandchild)).toBe(true);

    await first.stop(STOP_MS);

    // The farewell: the last frame leaves the socket at phase stopped, the
    // only frame that does, past the frame before it; then the socket closes.
    expect(await socket.closed).toEqual({ code: 1000, reason: "stopped" });
    const phases = framePhases(socket);
    expect(phases.at(-1)!.phase).toBe("stopped");
    expect(phases.filter((each) => each.phase === "stopped")).toHaveLength(1);
    expect(phases.at(-1)!.seq).toBeGreaterThan(phases.at(-2)!.seq);
    const farewell = lastPushed(socket);
    expect(farewell.state.interrupts).toEqual([]);
    expect(farewell.state.log).toContain(
      "engine shutdown: super-step joined; no crash interrupts raised and nothing more scheduled",
    );
    // The group went with the harness.
    expect(running(pid)).toBe(false);
    await untilGone(grandchild, "the grandchild");
    expect(eventLine(world, "01")).toEqual(["1 scheduled", "1 spawned", "1 exited", "1 crash"]);
    expect(eventsOf(world, "01", "crash")[0]!.payload.reason).toBe(stoppedByShutdown(143));
    expectSameBytes(readStateLine(world.pool, "01-a.md").line, stateLine("01", "in-progress"));

    // Nothing of that process is alive at the next boot, so the Ticket goes
    // back to ready with the plain note and runs once more.
    const second = await startLeg(t, world, 1);
    await settle(second, "the Review after the re-run", quiescentWith(`${REVIEW}:review`));
    expect(launchKeys(world)).toEqual(["01", "01"]);
    expect(await poolLog(second)).toContain("ticket 01: marker was in-progress with no live agent; back to ready");
    expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "done")}\n\n${body("01")}\n${ENGINE_RESET_NOTE}`);
    expect(eventsOf(world, "01", "crash")).toHaveLength(1);
  },
);

// engine/engine.test.ts:13174
restartCase(
  "boot stops an Attempt a killed server left running in its working tree before it schedules, then re-runs the Ticket",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
    world.stubs.launches("01", [{ run: LINGER }, {}]);
    const first = await startLeg(t, world, 0);
    const pid = await spawnedPid(world, "01");
    killGroupAtTeardown(t, () => pid);
    const grandchild = await grandchildPid(world, "01");

    // A SIGKILL stops nothing: the Attempt's group runs on without a server.
    await first.kill();
    expect(running(pid)).toBe(true);
    expect(running(grandchild)).toBe(true);
    expectSameBytes(readStateLine(world.pool, "01-a.md").line, stateLine("01", "in-progress"));

    const second = await startLeg(t, world, 1);
    await settle(second, "the Review after the re-run", quiescentWith(`${REVIEW}:review`));

    expect(running(pid)).toBe(false);
    await untilGone(grandchild, "the orphan's grandchild");
    // The stop is on attempt 1's record before attempt 2 is scheduled.
    expect(eventLine(world, "01")).toEqual([
      "1 scheduled",
      "1 spawned",
      "1 crash",
      "2 scheduled",
      "2 spawned",
      "2 exited",
    ]);
    expect(eventsOf(world, "01", "crash")[0]!.payload).toEqual({
      code: null,
      reason: orphanStopped(pid),
      logTail: [],
      outcomeExists: false,
      pid,
    });
    const log = await poolLog(second);
    expect(log).toContain(
      `ticket 01: marker was in-progress and attempt 1 (pid ${pid}) is still running from the previous engine process; ` +
        "stopping it before scheduling, ticket back to ready",
    );
    expect(log).toContain(`ticket 01: orphan attempt 1 (pid ${pid}) stopped at boot`);
    expect(launchKeys(world)).toEqual(["01", "01"]);
    expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "done")}\n\n${body("01")}\n${orphanNote(1, pid)}`);
  },
);

// engine/engine.test.ts:13235
conformance(
  "restart",
  "boot leaves alone a recorded pid that is alive but working elsewhere, a reused pid, and re-runs the Ticket",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a", { status: "in-progress" })], config: CONFIG });
    mkdirSync(join(world.root, "wt-01"));
    mkdirSync(join(world.root, "elsewhere"));
    const reused = startOrphan(t, join(world.root, "elsewhere"), SLEEPER);
    await until(() => running(reused), (alive) => alive, { what: "the process holding the pid" });
    leftInProgress(world, "01", "01-a.md", reused, join(world.root, "wt-01"));

    const server = await t.start(world);
    await settle(server, "the Review after the re-run", quiescentWith(`${REVIEW}:review`));

    expect(running(reused)).toBe(true);
    expect(eventsOf(world, "01", "crash")).toEqual([]);
    expect(eventLine(world, "01")).toEqual(["1 scheduled", "1 spawned", "2 scheduled", "2 spawned", "2 exited"]);
    expect(await poolLog(server)).toContain("ticket 01: marker was in-progress with no live agent; back to ready");
    expect(launchKeys(world)).toEqual(["01"]);
    expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "done")}\n\n${body("01")}\n${ENGINE_RESET_NOTE}`);
  },
  { skip: LINUX_ONLY },
);
