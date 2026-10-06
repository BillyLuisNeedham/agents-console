/**
 * The liveness sweep of a terminal-backed Attempt's ending, seen from
 * outside the server (ADR-0036). Every 30 s the ending's wait looks for its
 * pane in herdr's listing; a pane that has left it with no exit-code file is
 * given a 10 s grace window for the wrapper's last write, then called gone.
 * A listed pane, or a listing herdr will not give, is never an ending,
 * however many sweeps pass. These wait the server's own timings out for
 * real (the inventory's Decided 2), so they are slow; each runs its worlds
 * side by side, one server and one fake herdr apiece.
 *
 * Ticket C13 of the Rust port inventory (docs/research/rust-port/
 * test-inventory.md, area `attempts`); each case names the rows it covers.
 * The rows ask for short cadences, a seam the server lacks, so the cases
 * wait out the real ones.
 */

import { expect } from "bun:test";
import { join } from "node:path";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { callsOf, type HerdrOptions, type HerdrProcess } from "../harness/herdr.ts";
import { until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  awaitEndingWatch,
  CLAUDE_READY,
  eventsOf,
  heldUntil,
  poolLog,
  readRuns,
  ready,
  releaseFile,
  runsExists,
  snapshot,
  TERMINAL,
  waitForEvent,
  waitForExit,
  type Release,
} from "./attempts-endings-support.ts";

/** How often the ending's wait sweeps herdr's listing, and the grace after a pane leaves it. */
const LIVENESS_MS = 30_000;
const GRACE_MS = 10_000;

interface Running {
  world: World;
  herdr: HerdrProcess;
  server: CaseServer;
  go: Release;
  /** The pane the Attempt runs in. */
  paneId: string;
  /** When the ending's wait began, as the case saw it: its sweep timer starts then. */
  watching: number;
  /** The index in the fake's calls from which the wait's own calls come. */
  from: number;
}

/**
 * A terminal-backed pool whose Ticket 01 holds in its pane with no Outcome
 * until released, then exits `code`; started, and waited on until its
 * ending's wait has begun.
 */
async function holdingAttempt(t: Case, code: number, herdrOptions: HerdrOptions = {}): Promise<Running> {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  const go = releaseFile(world, "release-01");
  world.stubs.script("01", { outcome: null, exitCode: code, run: heldUntil(go) });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY, ...herdrOptions });
  const server = await t.start(world, { herdr });
  const watch = await awaitEndingWatch(herdr, "01", { dropped: herdrOptions.breakSubscriptions === true });
  await until(() => world.stubs.calls().some((call) => call.key === "01"), (seen) => seen, {
    ms: 30_000,
    what: "01's stub to read its prompt",
  });
  const from = (watch.call ? herdr.calls.indexOf(watch.call) : watch.typed.at) + 1;
  return { world, herdr, server, go, paneId: watch.typed.paneId, watching: watch.at, from };
}

/** Wait until `ms` have passed since `from`. */
async function untilElapsed(from: number, ms: number): Promise<void> {
  const left = from + ms - Date.now();
  if (left > 0) await Bun.sleep(left);
}

/** 01 is still running in its pane: no exited or crash event, live on the snapshot. */
async function expectStillRunning(run: Running, what: string): Promise<void> {
  expect(eventsOf(run.world, "01", "exited"), what).toEqual([]);
  expect(eventsOf(run.world, "01", "crash"), what).toEqual([]);
  const ticket = (await snapshot(run.server)).state.tickets.find((t) => t.id === "01");
  expect(ticket?.status, what).toBe("in-progress");
  expect(ticket?.liveAttempt, what).toMatchObject({ attempt: 1, paneId: run.paneId, role: "agent" });
}

/** Two sweeps pass with no ending, then the stub exits and the Attempt ends on its code. */
async function ridesOutSweeps(run: Running, code: number, what: string): Promise<void> {
  await untilElapsed(run.watching, 2 * LIVENESS_MS + 2_000);
  // Each sweep lists herdr's panes (the pane survey lists them as well).
  expect(callsOf(run.herdr, "pane.list", run.from).length, what).toBeGreaterThanOrEqual(2);
  await expectStillRunning(run, what);

  run.go.release();
  const exited = await waitForExit(run.world, "01", 20_000);
  expect(exited.payload.code, what).toBe(code);
  expect(eventsOf(run.world, "01", "crash")[0]?.payload.reason, what).toBe(`harness exited ${code}`);
  expect(readRuns(run.world, "01.exitcode"), what).toBe(`${code}\n`);
}

// attempt-ending.test.ts:195 waitForPaneEnding › leaves a healthy long attempt waiting however many sweeps pass
// attempt-ending.test.ts:120 waitForPaneEnding › stays waiting after hang-up while the pane is still listed and no file appears
// attempt-ending.test.ts:223 waitForPaneEnding › rides out a daemon that cannot answer for the pane at all
conformance("attempts", "a listed pane, a dropped subscription or a refused listing never ends an Attempt, however many sweeps pass", async (t) => {
  const [healthy, dropped, refused] = await Promise.all([
    holdingAttempt(t, 4),
    holdingAttempt(t, 5, { breakSubscriptions: true }),
    holdingAttempt(t, 6),
  ]);
  // From the ending's subscription on, herdr refuses every listing.
  await refused.herdr.control("fail", "pane.list", true);

  await Promise.all([
    ridesOutSweeps(healthy, 4, "a healthy subscription and a listed pane"),
    ridesOutSweeps(dropped, 5, "every subscription dropped, the pane listed"),
    ridesOutSweeps(refused, 6, "every listing refused"),
  ]);
}, { slow: true });

/** The crash reason of an Attempt whose pane left the listing with no exit code behind it. */
function paneGone(world: World, paneId: string): string {
  return (
    `harness pane gone: ${paneId} left herdr's listing and no exit code was written to ` +
    join(world.pool, "runs", "01.exitcode")
  );
}

/** The pane's process is killed with no event, and no exit code follows: it is gone. */
async function goneForGood(run: Running): Promise<void> {
  await run.herdr.control("endPane", run.paneId);
  const [crash] = await waitForEvent(run.world, "01", "crash", LIVENESS_MS + GRACE_MS + 30_000);
  // A sweep found it gone and the grace window passed first.
  expect(Date.parse(crash!.at) - run.watching).toBeGreaterThanOrEqual(LIVENESS_MS + GRACE_MS / 2);

  const reason = paneGone(run.world, run.paneId);
  expect(crash!.payload).toEqual({ code: -2, reason, logTail: [], outcomeExists: false });
  expect(eventsOf(run.world, "01", "exited")[0]!.payload).toEqual({
    code: -2,
    status: "in-progress",
    logTail: [],
    outcomeExists: false,
  });
  expect(reason).not.toContain("harness exited");
  expect(reason).not.toContain("wrapper never wrote");
  expect(runsExists(run.world, "01.exitcode")).toBe(false);
  const log = await poolLog(run.server);
  expect(log).toContain(`ticket 01: ended with its pane gone, marker in-progress, crash: ${reason}`);
  expect(log.filter((line) => line.includes("exited -1") || line.includes("exited -2"))).toEqual([]);
}

/**
 * The pane leaves the listing while its process runs on; the stub exits 7
 * once a sweep has found it gone, inside the grace window, and the file it
 * leaves is the ending.
 */
async function exitsInGrace(run: Running): Promise<void> {
  await run.herdr.control("delistPane", run.paneId);
  await untilElapsed(run.watching, LIVENESS_MS + 2_000);
  expect(eventsOf(run.world, "01", "exited")).toEqual([]);
  run.go.release();

  const exited = await waitForExit(run.world, "01", 20_000);
  expect(exited.payload.code).toBe(7);
  expect(eventsOf(run.world, "01", "crash")[0]!.payload.reason).toBe("harness exited 7");
  expect(readRuns(run.world, "01.exitcode")).toBe("7\n");
  expect(await poolLog(run.server)).toContain("ticket 01: exited 7, marker in-progress, crash: harness exited 7");
}

// attempt-ending.test.ts:150 waitForPaneEnding › ends as a crash when the pane is gone and no file follows it
// attempt-ending.test.ts:452 exitCrashReason › names the pane and the unwritten file when the pane is gone
// attempt-ending.test.ts:484 exitedPhrase › says the pane went away rather than printing the sentinel
// attempt-ending.test.ts:491 exitedPhrase › agrees with the crash reason it sits beside (the silent half)
// attempt-ending.test.ts:167 waitForPaneEnding › records the real exit code when the file lands inside the grace window
conformance("attempts", "a pane that leaves herdr's listing is gone after the grace window, unless its exit code lands inside it", async (t) => {
  // Both with every subscription dropped, so no pane event can end them.
  const [gone, late] = await Promise.all([
    holdingAttempt(t, 0, { breakSubscriptions: true }),
    holdingAttempt(t, 7, { breakSubscriptions: true }),
  ]);
  await Promise.all([goneForGood(gone), exitsInGrace(late)]);
}, { slow: true });
