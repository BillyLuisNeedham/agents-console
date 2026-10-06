/**
 * A terminal-backed launch that does not go to plan, seen from outside the
 * server (ADR-0036): a fresh tab whose shell has not drawn its prompt yet,
 * a wrapper the shell swallowed (a Botched launch, issue #102) retried into
 * a fresh tab, and claude's Blocking dialogs (issue #127), the workspace
 * trust dialog answered by name and the ones only the operator may answer.
 * Rows of the `attempts` area the Rust port inventory gives ticket C12
 * (docs/research/rust-port/test-inventory.md), and that area's gaps on
 * the dialogs and the readiness bound.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { conformance } from "../harness/case.ts";
import { spawnedPayloads, tuiStandIn, untilTicketStatus } from "../harness/herdr-tui.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import {
  BYPASS_WARNING,
  CLAUDE_READY,
  interactiveArgv,
  keySends,
  logTailOf,
  MANAGED_SETTINGS,
  paneFrameLog,
  promptFor,
  READY,
  runsFile,
  sends,
  terminalConfig,
  ticket,
  trustDialog,
  untilEvent,
  wrapperFor,
} from "./attempts-terminal-support.ts";
import { callsOf } from "../harness/herdr.ts";

const LAUNCH_NEVER_RAN = "launch command never ran";

/** What claude shows once it has left the dialog but before it is up: neither a dialog nor its ready frame. */
const STARTING = "starting the session\nplease wait";

/** The wrapper sends the server made, one per tab it tried. */
function wrapperSends(herdr: Parameters<typeof sends>[0]) {
  return sends(herdr).filter((call) => typeof call.params.text === "string" && String(call.params.text).startsWith("script "));
}

// attempt-run.test.ts:1465 Botched launch (issue #102)
conformance(
  "attempts",
  "a launch whose wrapper the shell swallowed is retried in a fresh tab, and only that tab is spawned (slow: the 10 s landed bound)",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "Botched once")], config: terminalConfig() });
    const herdr = await t.herdr(world, { rendered: READY.claude, swallowWrapper: 1 });
    await t.start(world, { herdr });
    await untilTicketStatus(world, "01", "done", 60_000);

    const events = readEvents(world.pool, "01");
    expect(events.map((event) => event.kind)).toEqual(["scheduled", "launch-retried", "spawned", "exited"]);
    expect(events[1]!.payload).toEqual({ try: 1, pane_id: "w1:p1", tab_id: "w1:t1", reason: LAUNCH_NEVER_RAN });
    expect(events[2]!.payload).toMatchObject({ pane_id: "w1:p2", tab_id: "w1:t2", terminal_id: "term-2" });
    expect(callsOf(herdr, "tab.create")).toHaveLength(2);
    // The botched tab is closed; the one the launch ended up in is not.
    await herdr.waitForCall((call) => call.method === "tab.close");
    await herdr.settle();
    expect(callsOf(herdr, "tab.close").map((call) => call.params)).toEqual([{ tab_id: "w1:t1" }]);
    // Each try's wrapper went as one send, and the prompt into the live pane only.
    const wrapper = wrapperFor(world, "01", interactiveArgv("claude"));
    expect(wrapperSends(herdr).map((call) => call.params)).toEqual([
      { pane_id: "w1:p1", text: wrapper, keys: ["enter"] },
      { pane_id: "w1:p2", text: wrapper, keys: ["enter"] },
    ]);
    expect(await herdr.control<string[]>("submitted")).toEqual([promptFor(world, "01")]);
  },
  { slow: true },
);

// attempt-run.test.ts:1514 Botched launch (issue #102)
conformance(
  "attempts",
  "a launch botched in every one of its three tabs ends as a crash that says the command never ran (slow: three 10 s landed bounds)",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "Botched thrice")], config: terminalConfig() });
    const herdr = await t.herdr(world, { rendered: READY.claude, swallowWrapper: 3 });
    await t.start(world, { herdr });
    await untilEvent(world, "01", "crash", 120_000);

    const events = readEvents(world.pool, "01");
    expect(events.map((event) => event.kind)).toEqual([
      "scheduled",
      "launch-retried",
      "launch-retried",
      "spawned",
      "exited",
      "crash",
    ]);
    expect(events[1]!.payload).toEqual({ try: 1, pane_id: "w1:p1", tab_id: "w1:t1", reason: LAUNCH_NEVER_RAN });
    expect(events[2]!.payload).toEqual({ try: 2, pane_id: "w1:p2", tab_id: "w1:t2", reason: LAUNCH_NEVER_RAN });
    expect(events[3]!.payload).toMatchObject({ pane_id: "w1:p3", tab_id: "w1:t3", terminal_id: "term-3" });
    expect(events[4]!.payload).toEqual({ code: -5, status: "in-progress", logTail: [], outcomeExists: false });
    expect(events[5]!.payload).toEqual({ code: -5, reason: LAUNCH_NEVER_RAN, logTail: [], outcomeExists: false });
    // No harness ever ran: no Stream file, nothing typed but the wrappers.
    expect(existsSync(runsFile(world, "01.stream.jsonl"))).toBe(false);
    expect(callsOf(herdr, "tab.create")).toHaveLength(3);
    expect(sends(herdr)).toHaveLength(3);
    expect(wrapperSends(herdr)).toHaveLength(3);
    expect(await herdr.control<string[]>("submitted")).toEqual([]);
    // The two botched tabs closed by the retries, the last pane by the crash.
    await until(
      () => [callsOf(herdr, "tab.close").length, callsOf(herdr, "pane.close").length],
      ([tabs, panes]) => tabs! >= 2 && panes! >= 1,
      { what: "the botched tabs and the last pane closed" },
    );
    expect(callsOf(herdr, "tab.close").map((call) => call.params)).toEqual([{ tab_id: "w1:t1" }, { tab_id: "w1:t2" }]);
    expect(callsOf(herdr, "pane.close").map((call) => call.params)).toEqual([{ pane_id: "w1:p3" }]);
  },
  { slow: true },
);

// attempt-run.test.ts:1565 Botched launch (issue #102)
conformance("attempts", "the wrapper waits for a fresh tab's shell to draw its prompt", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Shell settles")], config: terminalConfig() });
  // A new pane reads blank for its first 300 ms, as a real tab's does while its shell starts.
  const herdr = await t.herdr(world, { rendered: READY.claude, shellPromptDelayMs: 300 });
  await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  const tab = callsOf(herdr, "tab.create")[0]!;
  const wrapper = sends(herdr)[0]!;
  const reads = herdr.calls
    .slice(herdr.calls.indexOf(tab) + 1, herdr.calls.indexOf(wrapper))
    .filter((call) => call.method === "pane.read");
  expect(reads.length).toBeGreaterThanOrEqual(2);
  expect(wrapper.at - tab.at).toBeGreaterThanOrEqual(300);
  expect(callsOf(herdr, "tab.create")).toHaveLength(1);
  expect(readEvents(world.pool, "01").map((event) => event.kind)).toEqual(["scheduled", "spawned", "exited"]);
});

// attempt-run.test.ts:1634 claude's Blocking dialogs on launch (issue #127)
conformance("attempts", "claude's workspace trust dialog is answered by name, the highlight read back between the keys", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Trust dialog")], config: terminalConfig() });
  // The dialog opens on "No, exit"; down moves the highlight, enter leaves it for the ready frame.
  const herdr = await t.herdr(world, {
    rendered: trustDialog("No, exit"),
    keyFrames: { down: trustDialog("Yes, I trust this folder"), enter: CLAUDE_READY },
  });
  await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  // One down, one confirm, then the prompt's own Enter.
  expect(keySends(herdr)).toEqual([["down"], ["enter"], ["enter"]]);
  const down = sends(herdr)[1]!;
  const confirm = sends(herdr)[2]!;
  // The pane was read between the keys, so enter went only at the row that names the answer.
  expect(
    herdr.calls.slice(herdr.calls.indexOf(down) + 1, herdr.calls.indexOf(confirm)).some((call) => call.method === "pane.read"),
  ).toBe(true);
  expect(sends(herdr)[3]!.params).toEqual({ pane_id: "w1:p1", text: promptFor(world, "01") });
});

// attempt-run.test.ts:1660 claude's Blocking dialogs on launch (issue #127)
conformance("attempts", "a trust dialog whose highlight will not move is left unanswered and the crash says so, the dialog in the log", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Stuck highlight")], config: terminalConfig() });
  tuiStandIn(world, "claude");
  const herdr = await t.herdr(world, { rendered: trustDialog("No, exit") });
  await t.start(world, { herdr });

  const crash = await untilEvent(world, "01", "crash");
  const log = runsFile(world, "01.log");
  expect(readFileSync(log, "utf8")).toBe(paneFrameLog(trustDialog("No, exit")));
  expect(crash.payload).toEqual({
    code: -3,
    reason:
      "TUI never became ready: the workspace trust dialog was on screen and the highlight did not move to " +
      '"Yes, I trust this folder", so it was left unanswered',
    logTail: logTailOf(log),
    outcomeExists: false,
  });
  // Down was sent, enter never was, so claude was not told "No, exit".
  expect(keySends(herdr)).toEqual([["down"]]);
  // Decided at once, not at the 60 s readiness bound.
  const spawned = readEvents(world.pool, "01").find((event) => event.kind === "spawned")!;
  expect(Date.parse(crash.at) - Date.parse(spawned.at)).toBeLessThan(30_000);
  await herdr.waitForCall((call) => call.method === "pane.close");
  expect(callsOf(herdr, "pane.close").map((call) => call.params)).toEqual([{ pane_id: "w1:p1" }]);
});

// attempt-run.test.ts:1696 claude's Blocking dialogs on launch (issue #127)
conformance("attempts", "claude's bypass-permissions warning is never answered and ends the launch at once, naming it", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Bypass warning")], config: terminalConfig() });
  tuiStandIn(world, "claude");
  const herdr = await t.herdr(world, { rendered: BYPASS_WARNING });
  await t.start(world, { herdr });

  const crash = await untilEvent(world, "01", "crash");
  const log = runsFile(world, "01.log");
  expect(readFileSync(log, "utf8")).toBe(paneFrameLog(BYPASS_WARNING));
  expect(crash.payload).toEqual({
    code: -3,
    reason: "TUI never became ready: the bypass-permissions warning was on screen, which only the operator may answer",
    logTail: logTailOf(log),
    outcomeExists: false,
  });
  expect(keySends(herdr)).toEqual([]);
  const spawned = readEvents(world.pool, "01").find((event) => event.kind === "spawned")!;
  expect(Date.parse(crash.at) - Date.parse(spawned.at)).toBeLessThan(30_000);
});

// Gap: engine/pane-session.ts:125 and :419
conformance("attempts", "claude's managed-settings dialog is never answered and ends the launch at once, naming it", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Managed settings")], config: terminalConfig() });
  tuiStandIn(world, "claude");
  const herdr = await t.herdr(world, { rendered: MANAGED_SETTINGS });
  await t.start(world, { herdr });

  const crash = await untilEvent(world, "01", "crash");
  const log = runsFile(world, "01.log");
  expect(readFileSync(log, "utf8")).toBe(paneFrameLog(MANAGED_SETTINGS));
  expect(crash.payload).toEqual({
    code: -3,
    reason: "TUI never became ready: the managed-settings trust dialog was on screen, which only the operator may answer",
    logTail: logTailOf(log),
    outcomeExists: false,
  });
  expect(keySends(herdr)).toEqual([]);
  const spawned = readEvents(world.pool, "01").find((event) => event.kind === "spawned")!;
  expect(Date.parse(crash.at) - Date.parse(spawned.at)).toBeLessThan(30_000);
});

// attempt-run.test.ts:1720 claude's Blocking dialogs on launch (issue #127)
conformance("attempts", "a dialog-shaped frame on another harness's pane is ignored: no key, and the bare never-ready ending", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Not claude")], config: terminalConfig("opencode") });
  tuiStandIn(world, "opencode");
  // opencode's pane happens to show claude's words.
  const herdr = await t.herdr(world, { rendered: BYPASS_WARNING });
  await t.start(world, { herdr });
  const wrapper = herdr.calls.indexOf(await herdr.waitForCall((call) => call.method === "pane.send_input"));
  await until(
    () => herdr.calls.slice(wrapper + 1).filter((call) => call.method === "pane.read").length,
    (reads) => reads >= 3,
    { what: "the readiness wait to read the pane three times" },
  );
  await herdr.control("endPane", "w1:p1");

  const crash = await untilEvent(world, "01", "crash");
  expect(crash.payload).toMatchObject({ code: -3, reason: "TUI never became ready", outcomeExists: false });
  expect(keySends(herdr)).toEqual([]);
});

// Gap: engine/pane-session.ts:420-430, engine/attempt-run.ts:690-699
conformance("attempts", "a trust dialog still on screen after it was answered ends the launch, the dialog in the log", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Dialog stays")], config: terminalConfig() });
  tuiStandIn(world, "claude");
  // The highlight moves on down, but enter does not take the dialog away.
  const herdr = await t.herdr(world, {
    rendered: trustDialog("No, exit"),
    keyFrames: { down: trustDialog("Yes, I trust this folder") },
  });
  await t.start(world, { herdr });

  const crash = await untilEvent(world, "01", "crash");
  const log = runsFile(world, "01.log");
  expect(readFileSync(log, "utf8")).toBe(paneFrameLog(trustDialog("Yes, I trust this folder")));
  expect(crash.payload).toEqual({
    code: -3,
    reason: "TUI never became ready: the workspace trust dialog was still on screen after it was answered",
    logTail: logTailOf(log),
    outcomeExists: false,
  });
  // Answered once, however many reads saw it after.
  expect(keySends(herdr)).toEqual([["down"], ["enter"]]);
});

// Gap: engine/attempt-run.ts:1099-1106 (the readiness bound)
conformance(
  "attempts",
  "a trust dialog answered after which the ready frame never comes ends at the readiness bound, the last frame in the log (slow: the 60 s bound)",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "Never up")], config: terminalConfig() });
    tuiStandIn(world, "claude");
    const herdr = await t.herdr(world, {
      rendered: trustDialog("No, exit"),
      keyFrames: { down: trustDialog("Yes, I trust this folder"), enter: STARTING },
    });
    await t.start(world, { herdr });

    const crash = await untilEvent(world, "01", "crash", 150_000);
    const log = runsFile(world, "01.log");
    expect(readFileSync(log, "utf8")).toBe(paneFrameLog(STARTING));
    expect(crash.payload).toEqual({
      code: -3,
      reason: "TUI never became ready: the workspace trust dialog was answered and the ready frame still never came",
      logTail: logTailOf(log),
      outcomeExists: false,
    });
    expect(keySends(herdr)).toEqual([["down"], ["enter"]]);
    // The bound restarted once the dialog was answered.
    const confirm = sends(herdr)[2]!;
    expect(Date.parse(crash.at) - confirm.at).toBeGreaterThanOrEqual(60_000);
    expect(spawnedPayloads(world, "01")[0]).toMatchObject({ pane_id: "w1:p1" });
  },
  { slow: true },
);
