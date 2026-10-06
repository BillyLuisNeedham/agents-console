/**
 * How a terminal-backed Attempt's prompt reaches its harness's TUI, seen
 * from outside the server (ADR-0036, ADR-0016): the wait for the TUI's
 * ready frame, the typed prompt and its echo check, the retries and the
 * file-referencing fallback when a paste is lost, and the launch that ends
 * when the TUI never comes up or the harness dies first. Each row runs for
 * every harness it names, one case per harness. Rows of the `attempts` area
 * the Rust port inventory gives ticket C12
 * (docs/research/rust-port/test-inventory.md).
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { conformance } from "../harness/case.ts";
import { callsOf, type HerdrProcess } from "../harness/herdr.ts";
import { awaitPrompt, spawnedPayloads, tuiStandIn, untilTicketStatus } from "../harness/herdr-tui.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  BINARY,
  CLEAR_KEYS,
  HARNESSES,
  interactiveArgv,
  interruptsOf,
  issuePath,
  keySends,
  promptFile,
  promptFileText,
  promptFor,
  READY,
  RETRYING,
  runsFile,
  sends,
  terminalConfig,
  ticket,
  untilEvent,
  wrapperFor,
  type Harness,
} from "./attempts-terminal-support.ts";

const PANE = "w1:p1";

/** The wrapper send, as the first `pane.send_input` carries it. */
function wrapperSend(world: World, harness: Harness): Record<string, unknown> {
  return { pane_id: PANE, text: wrapperFor(world, "01", interactiveArgv(harness)), keys: ["enter"] };
}

/** A text send into the Attempt's pane. */
function typed(text: string): Record<string, unknown> {
  return { pane_id: PANE, text };
}

/** A key send into the Attempt's pane. */
function keyed(keys: string[]): Record<string, unknown> {
  return { pane_id: PANE, keys };
}

/** Wait until the server has sent `n` inputs to its panes. */
function untilSends(herdr: HerdrProcess, n: number, ms = 30_000): Promise<unknown> {
  return until(() => sends(herdr).length, (count) => count >= n, { ms, what: `${n} pane.send_input calls` });
}

/** Play the agent the way the file-reference fallback reaches it: write a done Outcome where the prompt file says. */
function writeDone(world: World): void {
  writeFileSync(runsFile(world, "01.outcome.json"), JSON.stringify({ status: "done", summary: "done from the pane", commitSha: null }));
}

/** The sends of a launch whose first three full pastes were lost, then the fallback typed and submitted. */
function fallbackSends(world: World, harness: Harness, driver = "implement"): Record<string, unknown>[] {
  const prompt = promptFor(world, "01", driver);
  const clear = keyed(CLEAR_KEYS[harness]);
  return [
    wrapperSend(world, harness),
    typed(prompt),
    clear,
    typed(prompt),
    clear,
    typed(prompt),
    clear,
    typed(`/${driver} ${promptFile(world, "01")}`),
    keyed(["enter"]),
  ];
}

for (const harness of HARNESSES) {
  // attempt-run.test.ts:868 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: the server waits for the ready frame, types the prompt, presses Enter, and the Outcome ends the Attempt`, async (t) => {
    const world = t.world({ tickets: [ticket("01", "Typed prompt")], config: terminalConfig(harness) });
    // The stub writes its Outcome and stays up, as a TUI does.
    world.stubs.script("01", { hold: 30 });
    const herdr = await t.herdr(world, { rendered: READY[harness] });
    await t.start(world, { herdr });
    await untilTicketStatus(world, "01", "done");
    await herdr.waitForCall((call) => call.method === "pane.release_agent");
    await herdr.settle();

    const sent = sends(herdr);
    expect(sent.map((call) => call.params)).toEqual([wrapperSend(world, harness), typed(promptFor(world, "01")), keyed(["enter"])]);
    // The readiness wait read the pane between the wrapper and the prompt.
    const between = herdr.calls.slice(herdr.calls.indexOf(sent[0]!), herdr.calls.indexOf(sent[1]!));
    expect(between.some((call) => call.method === "pane.read" && call.params.pane_id === PANE)).toBe(true);
    // The pane ran the TUI's argv, never the batch one.
    expect(spawnedPayloads(world, "01")[0]!.argv).toEqual(interactiveArgv(harness));
    expect(world.stubs.calls().map((call) => [call.key, call.harness, call.argv])).toEqual([
      ["01", BINARY[harness], interactiveArgv(harness).slice(1)],
    ]);
  });

  // attempt-run.test.ts:918 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: a valid Outcome ends the Attempt while the TUI keeps running, its pane left open`, async (t) => {
    const world = t.world({ tickets: [ticket("01", "Pane left open")], config: terminalConfig(harness) });
    const held = world.stubs.hold("01", { hold: 60 });
    const herdr = await t.herdr(world, { rendered: READY[harness] });
    await t.start(world, { herdr });
    const prompt = await awaitPrompt(herdr, "01");
    await herdr.waitForCall((call) => call.method === "events.subscribe", { from: prompt.at + 1 });
    await held.release();

    const exited = await untilEvent(world, "01", "exited");
    expect(exited.payload).toMatchObject({ code: 0, status: "done", outcomeExists: true });
    await untilTicketStatus(world, "01", "done");
    // The TUI is still up: its wrapper has written no exit code, and the pane was never closed.
    expect(existsSync(runsFile(world, "01.exitcode"))).toBe(false);
    expect(callsOf(herdr, "pane.close")).toEqual([]);
  });

  // attempt-run.test.ts:953 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: a pane lost with no Outcome is a crash naming the exit code it never got`, async (t) => {
    const world = t.world({ tickets: [ticket("01", "Pane lost")], config: terminalConfig(harness) });
    world.stubs.script("01", { status: "keep", hold: 60 });
    const herdr = await t.herdr(world, { rendered: READY[harness] });
    await t.start(world, { herdr });
    const prompt = await awaitPrompt(herdr, "01");
    await herdr.waitForCall((call) => call.method === "events.subscribe", { from: prompt.at + 1 });
    await herdr.control("endPane", prompt.paneId);

    const crash = await untilEvent(world, "01", "crash");
    expect(crash.payload).toMatchObject({
      code: -1,
      reason: `harness exit code unreadable: the pane wrapper never wrote a usable ${runsFile(world, "01.exitcode")}`,
      outcomeExists: false,
    });
  });

  // attempt-run.test.ts:1127 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: the echo check finds the Ticket path though the input box wraps it across bordered rows`, async (t) => {
    const world = t.world({ tickets: [ticket("01", "Wrapped echo")], config: terminalConfig(harness) });
    const herdr = await t.herdr(world, { rendered: READY[harness], wrapWidth: 24 });
    await t.start(world, { herdr });
    await untilTicketStatus(world, "01", "done");

    expect(issuePath(world, "01").length).toBeGreaterThan(24);
    // One paste, verified the first time: no clear, no retry, no fallback.
    const prompt = promptFor(world, "01");
    expect(sends(herdr).map((call) => call.params)).toEqual([wrapperSend(world, harness), typed(prompt), keyed(["enter"])]);
    const submitted = await herdr.control<string[]>("submitted");
    expect(submitted).toEqual([prompt]);
    expect(submitted[0]!.split("\n").at(-1)).toBe(issuePath(world, "01"));
  });

  // attempt-run.test.ts:1250 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: a TUI that never paints its ready frame ends the launch when its pane goes, and the pane is closed`, async (t) => {
    const world = t.world({ tickets: [ticket("01", "Never ready")], config: terminalConfig(harness) });
    tuiStandIn(world, BINARY[harness]);
    // The fake paints nothing the readiness pattern matches.
    const herdr = await t.herdr(world);
    await t.start(world, { herdr });
    const wrapper = await herdr.waitForCall((call) => call.method === "pane.send_input");
    const from = herdr.calls.indexOf(wrapper) + 1;
    await herdr.waitForCall((call) => call.method === "pane.read", { from });
    await herdr.waitForCall((call) => call.method === "pane.read", {
      from: herdr.calls.findIndex((call, i) => i >= from && call.method === "pane.read") + 1,
    });
    await herdr.control("endPane", PANE);

    const crash = await untilEvent(world, "01", "crash");
    expect(crash.payload).toMatchObject({ code: -3, reason: "TUI never became ready", outcomeExists: false });
    await herdr.waitForCall((call) => call.method === "pane.close");
    expect(callsOf(herdr, "pane.close").map((call) => call.params)).toEqual([{ pane_id: PANE }]);
    expect(sends(herdr)).toHaveLength(1);
  });

  // attempt-run.test.ts:1287 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: a harness that dies before its TUI comes up ends the launch at once with its own exit code`, async (t) => {
    const world = t.world({ tickets: [ticket("01", "Dies on launch")], config: terminalConfig(harness) });
    // Scripted under the launch's own name, the stub exits 3 at once, before any prompt.
    world.stubs.script(`_${BINARY[harness]}`, { outcome: null, exitCode: 3 });
    // The pane keeps its shell after the wrapper, as a live herdr pane does.
    const herdr = await t.herdr(world, { holdPane: true });
    await t.start(world, { herdr });

    const crash = await untilEvent(world, "01", "crash");
    expect(crash.payload).toMatchObject({ code: 3, reason: "harness exited 3", outcomeExists: false });
    const spawned = readEvents(world.pool, "01").find((event) => event.kind === "spawned")!;
    // Decided by the exit-code file, far inside the 60 s readiness bound.
    expect(Date.parse(crash.at) - Date.parse(spawned.at)).toBeLessThan(30_000);
    // Only the wrapper was typed, and the pane is kept: it shows why the harness died.
    expect(sends(herdr)).toHaveLength(1);
    await herdr.settle();
    expect(callsOf(herdr, "pane.close")).toEqual([]);
  });
}

for (const harness of RETRYING) {
  // attempt-run.test.ts:985 and :1066 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: three lost pastes are each cleared and retried, then the file-reference fallback goes into an emptied input`, async (t) => {
    const world = t.world({ tickets: [ticket("01", "Lost pastes")], config: terminalConfig(harness) });
    tuiStandIn(world, BINARY[harness]);
    const herdr = await t.herdr(world, { rendered: READY[harness], dropInputs: 3 });
    await t.start(world, { herdr });
    await untilSends(herdr, 9);
    writeDone(world);
    await untilTicketStatus(world, "01", "done");

    expect(sends(herdr).map((call) => call.params)).toEqual(fallbackSends(world, harness));
    expect(readFileSync(promptFile(world, "01"), "utf8")).toBe(promptFileText(world, "01"));
    expect(await herdr.control<string[]>("submitted")).toEqual([`/implement ${promptFile(world, "01")}`]);
  });

  // attempt-run.test.ts:1035 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: the fallback types the Attempt's own driver, not a hardcoded one`, async (t) => {
    const world = t.world({
      tickets: [ticket("01", "Own driver")],
      config: terminalConfig(harness, { assign: { "01": { drivers: "tdd" } } }),
    });
    tuiStandIn(world, BINARY[harness]);
    const herdr = await t.herdr(world, { rendered: READY[harness], dropInputs: 3 });
    await t.start(world, { herdr });
    await untilSends(herdr, 9);
    writeDone(world);
    await untilTicketStatus(world, "01", "done");

    expect(sends(herdr).map((call) => call.params)).toEqual(fallbackSends(world, harness, "tdd"));
  });

  // attempt-run.test.ts:1092 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: a fallback whose echo misses too fails the launch, with nothing ever submitted`, async (t) => {
    const world = t.world({ tickets: [ticket("01", "Fallback lost")], config: terminalConfig(harness) });
    tuiStandIn(world, BINARY[harness]);
    const herdr = await t.herdr(world, { rendered: READY[harness], dropInputs: 4 });
    const server = await t.start(world, { herdr });

    const crash = await untilEvent(world, "01", "crash");
    expect(crash.payload).toMatchObject({ code: -4, reason: "prompt never landed", outcomeExists: false });
    expect(readEvents(world.pool, "01").find((event) => event.kind === "exited")!.payload).toMatchObject({
      code: -4,
      status: "in-progress",
    });
    // The wrapper, the three pastes and their clears, the fallback: no Enter after any of them.
    expect(sends(herdr).map((call) => call.params)).toEqual(fallbackSends(world, harness).slice(0, 8));
    expect(keySends(herdr).some((keys) => keys.includes("enter"))).toBe(false);
    expect(await herdr.control<string[]>("submitted")).toEqual([]);
    await herdr.waitForCall((call) => call.method === "pane.close");
    expect(callsOf(herdr, "pane.close").map((call) => call.params)).toEqual([{ pane_id: PANE }]);
    await until(() => interruptsOf(server), (interrupts) => interrupts.some((i) => i.ticketId === "01" && i.kind === "crash"), {
      what: "01's crash Interrupt",
    });
  });

  // attempt-run.test.ts:1163 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: the fallback's echo is found though the input box wraps the prompt file's path`, async (t) => {
    const world = t.world({ tickets: [ticket("01", "Wrapped fallback")], config: terminalConfig(harness) });
    tuiStandIn(world, BINARY[harness]);
    const herdr = await t.herdr(world, { rendered: READY[harness], dropInputs: 3, wrapWidth: 24 });
    await t.start(world, { herdr });
    await untilSends(herdr, 9);
    writeDone(world);
    await untilTicketStatus(world, "01", "done");

    expect(promptFile(world, "01").length).toBeGreaterThan(24);
    expect(sends(herdr).map((call) => call.params)).toEqual(fallbackSends(world, harness));
    expect(await herdr.control<string[]>("submitted")).toEqual([`/implement ${promptFile(world, "01")}`]);
  });

  // attempt-run.test.ts:1194 interactive terminal-backed attempts (ADR-0016) › harness
  conformance("attempts", `${harness}: a paste that landed unseen is cleared before the retry, so one clean prompt is submitted`, async (t) => {
    const world = t.world({ tickets: [ticket("01", "Unseen paste")], config: terminalConfig(harness) });
    const herdr = await t.herdr(world, { rendered: READY[harness], hideInputs: 1 });
    await t.start(world, { herdr });
    await untilTicketStatus(world, "01", "done");

    const prompt = promptFor(world, "01");
    expect(sends(herdr).map((call) => call.params)).toEqual([
      wrapperSend(world, harness),
      typed(prompt),
      keyed(CLEAR_KEYS[harness]),
      typed(prompt),
      keyed(["enter"]),
    ]);
    const submitted = await herdr.control<string[]>("submitted");
    expect(submitted).toEqual([prompt]);
    // One leading reference and one trailing echo line: a concatenated retry would carry four.
    expect(submitted[0]!.split(issuePath(world, "01")).length - 1).toBe(2);
  });
}

// attempt-run.test.ts:1222 interactive terminal-backed attempts (ADR-0016) › harness
conformance("attempts", "claude: with no clear keys, the first lost paste fails the launch with nothing submitted", async (t) => {
  const world = t.world({ tickets: [ticket("01", "One paste only")], config: terminalConfig("claude") });
  tuiStandIn(world, "claude");
  const herdr = await t.herdr(world, { rendered: READY.claude, dropInputs: 1 });
  await t.start(world, { herdr });

  const crash = await untilEvent(world, "01", "crash");
  expect(crash.payload).toMatchObject({ code: -4, reason: "prompt never landed", outcomeExists: false });
  expect(sends(herdr).map((call) => call.params)).toEqual([wrapperSend(world, "claude"), typed(promptFor(world, "01"))]);
  expect(await herdr.control<string[]>("submitted")).toEqual([]);
  await herdr.waitForCall((call) => call.method === "pane.close");
  expect(callsOf(herdr, "pane.close").map((call) => call.params)).toEqual([{ pane_id: PANE }]);
});

// Gap: engine/attempt-run.ts:1064. herdr takes the wrapper, then refuses
// every input after it: the prompt never lands, and nothing falls back to headless.
conformance("attempts", "a daemon that refuses the paste after taking the wrapper ends the launch as a prompt that never landed", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Paste refused")], config: terminalConfig("claude") });
  const tui = tuiStandIn(world, "claude");
  const herdr = await t.herdr(world, { rendered: READY.claude, failFrom: { "pane.send_input": 2 } });
  const server = await t.start(world, { herdr });

  const crash = await untilEvent(world, "01", "crash");
  expect(crash.payload).toMatchObject({ code: -4, reason: "prompt never landed", outcomeExists: false });
  expect(readEvents(world.pool, "01").find((event) => event.kind === "exited")!.payload).toMatchObject({
    code: -4,
    status: "in-progress",
    outcomeExists: false,
  });
  await until(
    () => [...callsOf(herdr, "pane.close"), ...callsOf(herdr, "pane.release_agent")].map((call) => call.method).sort(),
    (methods) => methods.length >= 2,
    { what: "the pane's close and its agent's release" },
  );
  expect(callsOf(herdr, "pane.close").map((call) => call.params)).toEqual([{ pane_id: PANE }]);
  expect(callsOf(herdr, "pane.release_agent").map((call) => call.params.pane_id)).toEqual([PANE]);
  // The TUI was launched once in its pane; no headless child followed it.
  expect(tui.launches()).toHaveLength(1);
  expect(world.stubs.calls()).toEqual([]);
  await until(() => interruptsOf(server), (interrupts) => interrupts.some((i) => i.ticketId === "01" && i.kind === "crash"), {
    what: "01's crash Interrupt",
  });
});
