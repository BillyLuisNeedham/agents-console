/**
 * The wrapper a terminal-backed Attempt runs in its pane, seen from outside
 * the server (ADR-0036, ADR-0016): the harness under `script`, recording
 * the session into the Stream file and its exit code into the exit-code
 * file, the readable log derived from that Stream file, the agent the
 * server reports on the pane while the Attempt runs, and an exit code or a
 * lost subscription as the Attempt's ending. Rows of the `attempts` area
 * the Rust port inventory gives ticket C12
 * (docs/research/rust-port/test-inventory.md).
 */

import { expect } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { awaitPrompt, spawnedPayloads, untilTicketStatus } from "../harness/herdr-tui.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import {
  interactiveArgv,
  interruptsOf,
  logTailOf,
  READY,
  RESIZE_RELAY,
  runsFile,
  sends,
  shellQuote,
  terminalConfig,
  ticket,
  untilEvent,
  wrapperFor,
} from "./attempts-terminal-support.ts";
import { callsOf } from "../harness/herdr.ts";

const AGENT_SOURCE = "herdr:agent-console";

/** Wait for a file the pane's wrapper writes a moment after the Attempt has ended. */
function untilWritten(path: string): Promise<string> {
  return until(
    () => (existsSync(path) ? readFileSync(path, "utf8") : ""),
    (text) => text.endsWith("\n"),
    { ms: 20_000, what: `${path} to be written` },
  );
}

// attempt-run.test.ts:660 terminal-backed engine mechanics (ADR-0014)
conformance("attempts", "the harness runs under script in its pane and the wrapper echoes its exit code into the exit-code file", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Wrapped")], config: terminalConfig() });
  const herdr = await t.herdr(world, { rendered: READY.claude });
  await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  // One send: the host's script form, then the exit-code echo, and no exit.
  const wrapper = sends(herdr)[0]!;
  expect(wrapper.params).toEqual({
    pane_id: "w1:p1",
    text: wrapperFor(world, "01", interactiveArgv("claude")),
    keys: ["enter"],
  });
  expect(await untilWritten(runsFile(world, "01.exitcode"))).toBe("0\n");
  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(spawned).toMatchObject({ pane_id: "w1:p1", tab_id: "w1:t1" });
  expect(spawned.pid).toBeUndefined();
  expect(readEvents(world.pool, "01").find((event) => event.kind === "exited")!.payload).toMatchObject({
    code: 0,
    status: "done",
    outcomeExists: true,
  });
});

// attempt-run.test.ts:711 terminal-backed engine mechanics (ADR-0014)
conformance("attempts", "the Stream file is the session's raw typescript and the log its readable lines, ANSI and carriage returns gone", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Painted")], config: terminalConfig() });
  world.stubs.script("01", { stdout: "hello from the pane\n\u001b[32mgreen text\u001b[0m\n" });
  const herdr = await t.herdr(world, { rendered: READY.claude });
  const server = await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");
  // script has exited once the wrapper's echo lands, so the Stream file is whole.
  await untilWritten(runsFile(world, "01.exitcode"));

  const stream = readFileSync(runsFile(world, "01.stream.jsonl"), "utf8");
  expect(stream).toContain("hello from the pane\r\n");
  expect(stream).toContain("\u001b[32mgreen text\u001b[0m\r\n");
  const log = readFileSync(runsFile(world, "01.log"), "utf8");
  const lines = log.split("\n");
  expect(lines).toContain("hello from the pane");
  expect(lines).toContain("green text");
  expect(log).not.toContain("\u001b");
  expect(log).not.toContain("\r");
  // The log route serves the derived log as it is on disk.
  const served = await server.http.get("/api/log?ticket=01");
  expect(served.status).toBe(200);
  expect(served.json<{ content: string }>().content).toBe(log);
});

// attempt-run.test.ts:757 terminal-backed engine mechanics (ADR-0014)
conformance("attempts", "a harness that exits 3 in its pane is the Attempt's crash, with the wrapper's code", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Exits three")], config: terminalConfig() });
  world.stubs.script("01", { outcome: null, exitCode: 3 });
  const herdr = await t.herdr(world, { rendered: READY.claude });
  const server = await t.start(world, { herdr });
  await untilEvent(world, "01", "crash");

  expect(readFileSync(runsFile(world, "01.exitcode"), "utf8")).toBe("3\n");
  const events = readEvents(world.pool, "01");
  expect(events.map((event) => event.kind)).toEqual(["scheduled", "spawned", "exited", "crash"]);
  // The tail is the derived log's, whole by the time the ending is recorded.
  const logTail = logTailOf(runsFile(world, "01.log"));
  expect(events[2]!.payload).toEqual({ code: 3, status: "in-progress", logTail, outcomeExists: false });
  expect(events[3]!.payload).toEqual({ code: 3, reason: "harness exited 3", logTail, outcomeExists: false });
  await until(() => interruptsOf(server), (interrupts) => interrupts.some((i) => i.ticketId === "01" && i.kind === "crash"), {
    what: "01's crash Interrupt",
  });
});

// attempt-run.test.ts:790 terminal-backed engine mechanics (ADR-0014)
conformance("attempts", "an Attempt still ends when the daemon drops every pane-end subscription", async (t) => {
  const world = t.world({ tickets: [ticket("01", "No subscription")], config: terminalConfig() });
  const held = world.stubs.hold("01");
  const herdr = await t.herdr(world, { rendered: READY.claude, breakSubscriptions: true });
  await t.start(world, { herdr });
  // The ending wait tries its subscription once the prompt is in, and loses it.
  const typed = await awaitPrompt(herdr, "01");
  await herdr.waitForCall((call) => call.method === "events.subscribe", { from: typed.at + 1 });
  await held.release();
  await untilTicketStatus(world, "01", "done");

  expect(callsOf(herdr, "events.subscribe").length).toBeGreaterThanOrEqual(1);
  expect(readEvents(world.pool, "01").find((event) => event.kind === "exited")!.payload).toMatchObject({
    code: 0,
    status: "done",
    outcomeExists: true,
  });
  expect(await untilWritten(runsFile(world, "01.exitcode"))).toBe("0\n");
});

// engine.test.ts:6548 terminal-backed engine mechanics (ADR-0014)
conformance("attempts", "the pane's script(1) is handed the argv its platform expects, the model's space and quote intact", async (t) => {
  const model = "m o'del";
  const world = t.world({
    tickets: [ticket("01", "Quoted model")],
    config: { defaults: { harness: "claude", model }, terminal: "herdr" },
  });
  // A stand-in script(1) first on the pane's PATH: it records its argv and exits 3.
  const record = join(world.root, "script-argv");
  const standIn = join(world.stubs.bin, "script");
  writeFileSync(standIn, `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > ${shellQuote(record)}\nexit 3\n`);
  chmodSync(standIn, 0o755);
  const herdr = await t.herdr(world, { rendered: READY.claude });
  await t.start(world, { herdr });
  const crash = await untilEvent(world, "01", "crash");

  const argv = readFileSync(record, "utf8").split("\0").slice(0, -1);
  const stream = runsFile(world, "01.stream.jsonl");
  const words = interactiveArgv("claude", model);
  if (process.platform === "darwin") {
    // BSD script: the file, then the command's words, behind the resize relay
    // handed the pane's terminal (the fake's pane has none).
    expect(argv).toEqual(["-eqF", stream, "sh", "-c", RESIZE_RELAY, "sh", "not a tty", ...words]);
  } else {
    // util-linux script: the command as one shell-quoted string after -c.
    expect(argv).toEqual(["-eqfc", words.map(shellQuote).join(" "), stream]);
  }
  expect(readFileSync(runsFile(world, "01.exitcode"), "utf8")).toBe("3\n");
  expect(crash.payload).toMatchObject({ code: 3, reason: "harness exited 3" });
  expect(sends(herdr)).toHaveLength(1);
});

// attempt-run.test.ts:1326 interactive terminal-backed attempts (ADR-0016)
conformance("attempts", "opencode, raw when headless, gets a Stream file in its pane and a readable log derived from it", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Opencode transcript")], config: terminalConfig("opencode") });
  world.stubs.script("01", { stdout: "opencode agent working\n" });
  const herdr = await t.herdr(world, { rendered: READY.opencode });
  await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  expect(readFileSync(runsFile(world, "01.stream.jsonl"), "utf8")).toContain("opencode agent working");
  expect(readFileSync(runsFile(world, "01.log"), "utf8").split("\n")).toContain("opencode agent working");
});

// Gap: engine/attempt-run.ts:667 and :780, helpers at :928-958. The agent is
// reported once the wrapper has landed and released at the ending, done or crashed.
conformance("attempts", "the pane's agent is reported working once the wrapper lands and released at the ending, done or crashed", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "Reported"), ticket("02", "Crashed", "01")],
    config: terminalConfig(),
  });
  world.stubs.script("02", { outcome: null, exitCode: 3 });
  const herdr = await t.herdr(world, { rendered: READY.claude });
  await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");
  await untilEvent(world, "02", "crash");
  await until(() => callsOf(herdr, "pane.release_agent"), (calls) => calls.length >= 2, {
    what: "both panes' agents released",
  });
  await herdr.settle();

  const reports = callsOf(herdr, "pane.report_agent");
  expect(reports.map((call) => call.params)).toEqual([
    { pane_id: "w1:p1", source: AGENT_SOURCE, agent: "claude", state: "working", seq: expect.any(Number), message: "01 · Reported" },
    { pane_id: "w1:p2", source: AGENT_SOURCE, agent: "claude", state: "working", seq: expect.any(Number), message: "02 · Crashed" },
  ]);
  expect(Number(reports[1]!.params.seq)).toBeGreaterThan(Number(reports[0]!.params.seq));
  const releases = callsOf(herdr, "pane.release_agent");
  expect(releases.map((call) => call.params)).toEqual([
    { pane_id: "w1:p1", source: AGENT_SOURCE, agent: "claude" },
    { pane_id: "w1:p2", source: AGENT_SOURCE, agent: "claude" },
  ]);
  for (const [n, pane] of ["w1:p1", "w1:p2"].entries()) {
    const ofPane = sends(herdr).filter((call) => call.params.pane_id === pane);
    const at = (call: (typeof ofPane)[number]) => herdr.calls.indexOf(call);
    // After the wrapper, before the prompt; released once the prompt's Enter is in.
    expect(at(reports[n]!)).toBeGreaterThan(at(ofPane[0]!));
    expect(at(reports[n]!)).toBeLessThan(at(ofPane[1]!));
    expect(at(releases[n]!)).toBeGreaterThan(at(ofPane[2]!));
  }
});
