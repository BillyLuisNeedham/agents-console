/**
 * How a terminal-backed Attempt's ending is observed, seen from outside the
 * server (ADR-0036): herdr's pane end events, the exit-code file the pane
 * wrapper writes, and a valid Outcome, raced; what each ending records; and
 * what herdr's subscriptions are left holding once it is over. Every pool
 * here is terminal-backed on the fake herdr, its claude stub held in its
 * pane until the case lets it go. The waits that need the ending's
 * liveness sweep are the slow cases in attempts-endings-liveness.test.ts.
 *
 * Ticket C13 of the Rust port inventory (docs/research/rust-port/
 * test-inventory.md, area `attempts`); each case names the rows it covers.
 */

import { expect } from "bun:test";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { awaitPrompt } from "../harness/herdr-tui.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  awaitEndingWatch,
  CLAUDE_READY,
  crashBody,
  eventsOf,
  expectedCrashBody,
  heldUntil,
  openSubscriptions,
  PANE_END_SUBSCRIPTION,
  poolLog,
  readRuns,
  ready,
  releaseFile,
  runsExists,
  snapshot,
  TERMINAL,
  transcriptPayload,
  waitForEvent,
  waitForExit,
} from "./attempts-endings-support.ts";
import { callsOf } from "../harness/herdr.ts";

/** The crash reason of an Attempt whose wrapper never wrote its exit code. */
function unreadable(world: World, id: string): string {
  return `harness exit code unreadable: the pane wrapper never wrote a usable ${join(world.pool, "runs", `${id}.exitcode`)}`;
}

/** Wait until the stub launch of `key` has read its prompt from the pane and recorded itself. */
async function promptRead(world: World, key: string): Promise<void> {
  await until(() => world.stubs.calls().some((call) => call.key === key), (seen) => seen, {
    ms: 30_000,
    what: `the stub launch of ${key} to read its prompt`,
  });
}

/** Wait until the fake no longer holds the connection `connection` open. */
async function untilClosed(herdr: Parameters<typeof openSubscriptions>[0], connection: number, what: string): Promise<void> {
  await until(() => herdr.control<number[]>("openConnections"), (open) => !open.includes(connection), { ms: 15_000, what });
}

// attempt-ending.test.ts:62 waitForPaneEnding › ends on the pane's own end, without waiting on a file
// herdr.test.ts:317 waitForPaneEnd › settles exited on the pane's own exit event
// attempt-ending.test.ts:441 exitCrashReason › points at the unwritten file when no code arrived
// attempt-ending.test.ts:479 exitedPhrase › says no code arrived rather than printing the sentinel
// attempt-ending.test.ts:491 exitedPhrase › agrees with the crash reason it sits beside (the pane event's half)
conformance("attempts", "a pane that ends with no exit code ends its Attempt at once, naming the file never written", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  world.stubs.script("01", { outcome: null, run: heldUntil() });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const server = await t.start(world, { herdr });

  const { typed } = await awaitEndingWatch(herdr, "01");
  await promptRead(world, "01");
  const ended = Date.now();
  // The pane's process is killed and herdr reports pane_exited: the
  // wrapper's last word, the exit-code file, is never written.
  await herdr.control("endPane", typed.paneId);
  await waitForEvent(world, "01", "crash", 20_000);
  // The pane's own event ends it within seconds, not a liveness sweep 30 s on.
  expect(Date.now() - ended).toBeLessThan(15_000);

  // Every subscription asks for the three ways a pane ends.
  const subscriptions = callsOf(herdr, "events.subscribe");
  expect(subscriptions.length).toBeGreaterThan(0);
  for (const call of subscriptions) expect(call.params).toEqual(PANE_END_SUBSCRIPTION);

  const reason = unreadable(world, "01");
  expect(eventsOf(world, "01", "spawned")[0]!.payload.pane_id).toBe(typed.paneId);
  expect(eventsOf(world, "01", "exited")[0]!.payload).toEqual({ code: -1, status: "in-progress", logTail: [], outcomeExists: false });
  expect(eventsOf(world, "01", "crash")[0]!.payload).toEqual({ code: -1, reason, logTail: [], outcomeExists: false });
  expect(runsExists(world, "01.exitcode")).toBe(false);
  expect(await crashBody(server, "01")).toBe(expectedCrashBody(world, "01", reason, [], false));

  // The pool log says no code arrived, and never prints the sentinel.
  const log = await poolLog(server);
  expect(log).toContain(`ticket 01: ended with no exit code, marker in-progress, crash: ${reason}`);
  expect(log.filter((line) => line.includes("exited -1") || line.includes("exited -2"))).toEqual([]);
  expect(readStateLine(world.pool, "01-t.md").status).toBe("in-progress");
});

// attempt-ending.test.ts:80 waitForPaneEnding › ends on the exit-code file while the subscription is healthy and silent
conformance("attempts", "an Attempt ends on its exit-code file while herdr keeps the pane and says nothing, and lets go of its subscription", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  const go = releaseFile(world, "release-01");
  world.stubs.script("01", { outcome: null, exitCode: 3, run: heldUntil(go) });
  // A pane keeps its shell after the wrapper exits, so no pane event comes.
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY, holdPane: true });
  const server = await t.start(world, { herdr });

  const { typed, call: watch } = await awaitEndingWatch(herdr, "01");
  await promptRead(world, "01");
  go.release();
  const exited = await waitForExit(world, "01", 20_000);

  expect(readRuns(world, "01.exitcode")).toBe("3\n");
  expect(transcriptPayload(exited.payload)).toEqual({ code: 3, status: "in-progress", logTail: [], outcomeExists: false });
  const [crash] = eventsOf(world, "01", "crash");
  expect(crash!.payload.code).toBe(3);
  expect(crash!.payload.reason).toBe("harness exited 3");
  expect(await herdr.control<string[]>("listedPanes")).toContain(typed.paneId);
  // The ending's subscription is closed once the Attempt is over.
  await untilClosed(herdr, watch!.connection, "the ending's events.subscribe connection to close");
  expect(await poolLog(server)).toContain("ticket 01: exited 3, marker in-progress, crash: harness exited 3");
});

// gap: engine/pane-session.ts:314 (the wrapper's send first removes an exit-code file left from before)
conformance("attempts", "an exit-code file left from before the launch never ends the new Attempt", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL, poolFiles: { "runs/01.exitcode": "0\n" } });
  const go = releaseFile(world, "release-01");
  world.stubs.script("01", { outcome: null, exitCode: 3, run: heldUntil(go) });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  await t.start(world, { herdr });

  // Watching through a subscription at all means the wait did not end on the old file.
  await awaitEndingWatch(herdr, "01");
  await promptRead(world, "01");
  expect(runsExists(world, "01.exitcode")).toBe(false);
  expect(eventsOf(world, "01", "exited")).toEqual([]);

  go.release();
  const exited = await waitForExit(world, "01", 20_000);
  expect(exited.payload.code).toBe(3);
  expect(eventsOf(world, "01", "crash")[0]!.payload.reason).toBe("harness exited 3");
  expect(readRuns(world, "01.exitcode")).toBe("3\n");
});

/** A pool whose fake herdr drops every subscription, its 01 ending on `code` with no Outcome. */
async function droppedSubscriptions(t: Parameters<Parameters<typeof conformance>[2]>[0], code: number) {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  const go = releaseFile(world, "release-01");
  world.stubs.script("01", { outcome: null, exitCode: code, run: heldUntil(go) });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY, breakSubscriptions: true });
  const server = await t.start(world, { herdr });

  await awaitEndingWatch(herdr, "01", { dropped: true });
  await promptRead(world, "01");
  const released = Date.now();
  go.release();
  const exited = await waitForExit(world, "01", 20_000);
  // Within seconds of the exit: the file, not a liveness sweep.
  expect(Date.now() - released).toBeLessThan(15_000);
  expect(callsOf(herdr, "events.subscribe").length).toBeGreaterThan(0);
  expect(readRuns(world, "01.exitcode")).toBe(`${code}\n`);
  return { world, server, exited };
}

// attempt-ending.test.ts:101 waitForPaneEnding › ends on the exit-code file after the daemon hangs up on the subscriber
conformance("attempts", "with every subscription dropped, a clean exit with no Outcome still ends on the exit-code file", async (t) => {
  const { world, exited } = await droppedSubscriptions(t, 0);
  expect(transcriptPayload(exited.payload)).toEqual({ code: 0, status: "in-progress", logTail: [], outcomeExists: false });
  expect(eventsOf(world, "01", "crash")[0]!.payload.reason).toBe("no outcome written");
});

// herdr.test.ts:433 waitForPaneEnd › settles lost when the subscriber connection is dropped
conformance("attempts", "with every subscription dropped, a non-zero exit still ends the Attempt with the harness's code", async (t) => {
  const { world, server } = await droppedSubscriptions(t, 3);
  const [crash] = eventsOf(world, "01", "crash");
  expect(crash!.payload.code).toBe(3);
  expect(crash!.payload.reason).toBe("harness exited 3");
  expect(await poolLog(server)).toContain("ticket 01: exited 3, marker in-progress, crash: harness exited 3");
});

// herdr.test.ts:418 waitForPaneEnd › settles lost when the daemon hangs up on the subscriber
conformance("attempts", "herdr hanging up on the ending's subscription leaves the Attempt running, to end on its exit code", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  const go = releaseFile(world, "release-01");
  world.stubs.script("01", { outcome: null, exitCode: 3, run: heldUntil(go) });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const server = await t.start(world, { herdr });

  const { typed, call: watch } = await awaitEndingWatch(herdr, "01");
  await promptRead(world, "01");
  // A plain FIN on the subscription, after its ack.
  await herdr.control("hangUpSubscribers");
  await untilClosed(herdr, watch!.connection, "the hung-up subscription to close");
  // A hang-up is not an ending: the Attempt is still running.
  await Bun.sleep(2_000);
  expect(eventsOf(world, "01", "exited")).toEqual([]);
  const ticket = (await snapshot(server)).state.tickets.find((t) => t.id === "01");
  expect(ticket?.liveAttempt?.paneId).toBe(typed.paneId);

  go.release();
  const exited = await waitForExit(world, "01", 20_000);
  expect(exited.payload.code).toBe(3);
  expect(eventsOf(world, "01", "crash")[0]!.payload.reason).toBe("harness exited 3");
  expect(readRuns(world, "01.exitcode")).toBe("3\n");
});

// herdr.test.ts:441 waitForPaneEnd › settles lost when there is no daemon to subscribe to
conformance("attempts", "a herdr daemon killed mid-Attempt leaves the Attempt to end on its exit code, and the server up", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  const go = releaseFile(world, "release-01");
  world.stubs.script("01", { outcome: null, exitCode: 3, run: heldUntil(go) });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const server = await t.start(world, { herdr });

  await awaitEndingWatch(herdr, "01");
  await promptRead(world, "01");
  // The daemon dies; the pane's wrapper, its process, lives on.
  await herdr.kill();
  await Bun.sleep(2_000);
  expect(eventsOf(world, "01", "exited")).toEqual([]);

  go.release();
  const exited = await waitForExit(world, "01", 20_000);
  expect(exited.payload.code).toBe(3);
  expect(eventsOf(world, "01", "crash")[0]!.payload.reason).toBe("harness exited 3");
  expect(readRuns(world, "01.exitcode")).toBe("3\n");
  expect(server.exited()).toBe(false);
  expect((await server.http.get("/api/state")).status).toBe(200);
});

// herdr.test.ts:449 waitForPaneEnd › settles lost when the caller releases it
conformance("attempts", "an Attempt that ends on its Outcome lets go of its subscription though its pane is still open", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  const go = releaseFile(world, "release-01");
  // A done Outcome once released, then the TUI stays up, as a real one does.
  world.stubs.script("01", { run: heldUntil(go), hold: 120 });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  await t.start(world, { herdr });

  const { typed, call: watch } = await awaitEndingWatch(herdr, "01");
  await promptRead(world, "01");
  go.release();
  const exited = await waitForExit(world, "01", 20_000);
  expect(exited.payload).toMatchObject({ code: 0, status: "done", outcomeExists: true });
  await untilClosed(herdr, watch!.connection, "the ending's events.subscribe connection to close");
  expect(await openSubscriptions(herdr)).toEqual([]);
  expect(await herdr.control<string[]>("listedPanes")).toContain(typed.paneId);
  expect(callsOf(herdr, "pane.close")).toEqual([]);
  expect(runsExists(world, "01.exitcode")).toBe(false);
});

// herdr.test.ts:462 waitForPaneEnd › settles exited when the pane is already gone as the subscription lands
conformance("attempts", "a pane gone as the ending's subscription lands ends the Attempt at once, on the listing after the ack", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  world.stubs.script("01", { outcome: null, run: heldUntil() });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  // The Bun server subscribes twice for a launch: for its readiness wait,
  // let go before the prompt is typed, then for the Attempt's ending. The
  // pool's first pane, w1:p1, ends as the second arrives, before its ack.
  await herdr.control("endPaneOn", "events.subscribe", "w1:p1", 2);
  const server = await t.start(world, { herdr });

  const typed = await awaitPrompt(herdr, "01");
  expect(typed.paneId).toBe("w1:p1");
  const watch = await herdr.waitForCall((call) => call.method === "events.subscribe", { from: typed.at + 1 });
  const subscribed = Date.now();
  await waitForEvent(world, "01", "crash", 20_000);
  // At once, not after the 30 s liveness sweep: the pane.list that follows
  // the subscription's ack finds the pane gone.
  expect(Date.now() - subscribed).toBeLessThan(15_000);
  expect(callsOf(herdr, "pane.list", herdr.calls.indexOf(watch) + 1).length).toBeGreaterThan(0);
  const reason = unreadable(world, "01");
  expect(eventsOf(world, "01", "crash")[0]!.payload).toEqual({ code: -1, reason, logTail: [], outcomeExists: false });
  expect(await poolLog(server)).toContain(`ticket 01: ended with no exit code, marker in-progress, crash: ${reason}`);
});

// herdr.test.ts:398 waitForPaneEnd › settles closed when the pane vanished without exiting
conformance("attempts", "a pane closed by hand ends its Attempt at once as a crash", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  world.stubs.script("01", { outcome: null, run: heldUntil() });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const server = await t.start(world, { herdr });

  const { typed } = await awaitEndingWatch(herdr, "01");
  await promptRead(world, "01");
  const closed = Date.now();
  await herdr.control("closePane", typed.paneId);
  await waitForEvent(world, "01", "crash", 20_000);
  expect(Date.now() - closed).toBeLessThan(15_000);
  const reason = unreadable(world, "01");
  expect(eventsOf(world, "01", "crash")[0]!.payload).toEqual({ code: -1, reason, logTail: [], outcomeExists: false });
  expect(await crashBody(server, "01")).toBe(expectedCrashBody(world, "01", reason, [], false));
});

// herdr.test.ts:337 waitForPaneEnd › settles closed when the pane's tab is closed
conformance("attempts", "a tab closed by hand ends its Attempt at once, though herdr sends no pane event", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  world.stubs.script("01", { outcome: null, run: heldUntil() });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  await t.start(world, { herdr });

  await awaitEndingWatch(herdr, "01");
  await promptRead(world, "01");
  const tab = String(eventsOf(world, "01", "spawned")[0]!.payload.tab_id);
  await herdr.settle();
  const before = herdr.calls.length;
  const closed = Date.now();
  await herdr.control("closeTab", tab);
  await waitForEvent(world, "01", "crash", 20_000);
  expect(Date.now() - closed).toBeLessThan(15_000);
  // tab_closed names no pane: the server looked its pane up in the listing.
  expect(callsOf(herdr, "pane.list", before).length).toBeGreaterThan(0);
  expect(eventsOf(world, "01", "crash")[0]!.payload).toEqual({
    code: -1,
    reason: unreadable(world, "01"),
    logTail: [],
    outcomeExists: false,
  });
});

// herdr.test.ts:351 waitForPaneEnd › keeps waiting through another tab's close
// herdr.test.ts:406 waitForPaneEnd › ignores another pane's event
conformance("attempts", "another Attempt's tab closing and its pane's events leave an Attempt running", async (t) => {
  const world = t.world({ tickets: [ready("01"), ready("02")], config: TERMINAL });
  const go = releaseFile(world, "release-01");
  world.stubs.script("01", { run: heldUntil(go) });
  world.stubs.script("02", { outcome: null, run: heldUntil() });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const server = await t.start(world, { herdr });

  const first = await awaitPrompt(herdr, "01");
  const second = await awaitPrompt(herdr, "02");
  await promptRead(world, "01");
  await promptRead(world, "02");
  // Both endings are watched: two subscriptions held open.
  await until(() => openSubscriptions(herdr), (open) => open.length >= 2, { ms: 20_000, what: "both endings watched" });
  const tab = String(eventsOf(world, "02", "spawned")[0]!.payload.tab_id);
  const live = async () => (await snapshot(server)).state.tickets.find((ticket) => ticket.id === "01")?.liveAttempt;

  // 02's tab is closed: 02 ends, and 01, told of the close too, runs on.
  await herdr.control("closeTab", tab);
  await waitForEvent(world, "02", "crash", 20_000);
  // Then 02's pane exits and closes, events every subscriber hears.
  await herdr.control("endPane", second.paneId);
  await herdr.control("closePane", second.paneId);
  await Bun.sleep(2_000);
  expect(eventsOf(world, "01", "exited")).toEqual([]);
  expect(eventsOf(world, "01", "crash")).toEqual([]);
  expect(await live()).toMatchObject({ attempt: 1, paneId: first.paneId, role: "agent" });

  // 01 ends on its own Outcome once its stub goes on.
  go.release();
  const exited = await waitForExit(world, "01", 20_000);
  expect(exited.payload).toMatchObject({ code: 0, status: "done", outcomeExists: true });
  expect(eventsOf(world, "01", "crash")).toEqual([]);
});
