/**
 * Where a terminal-backed Attempt runs, seen from outside the server
 * (ADR-0036): the named herdr tab it opens in the Pool workspace, the one
 * re-resolve a refused tab costs, and the headless run it falls back to when
 * no tab can be had, with the reason on its spawned event. Rows of the
 * `attempts` area the Rust port inventory gives ticket C12
 * (docs/research/rust-port/test-inventory.md).
 */

import { expect } from "bun:test";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { poolKey } from "../harness/git-pool.ts";
import { awaitPrompt, callsOf, spawnedPayloads, untilTicketStatus } from "../harness/herdr-tui.ts";
import {
  interactiveArgv,
  poolLogLines,
  READY,
  sends,
  terminalConfig,
  ticket,
  wrapperFor,
} from "./attempts-terminal-support.ts";

/** The headless claude argv Ticket `id` falls back to, as the stub records it. */
const HEADLESS_FLAG = "-p";

// attempt-run.test.ts:448 the Pool workspace (issue #94), and the inventory gap on
// terminal_id (engine/attempt-run.ts:999-1002)
conformance("attempts", "an Attempt's tab opens in the Pool workspace and its pane is the root pane tab.create answered with", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Tabs in the Pool workspace")], config: terminalConfig() });
  const herdr = await t.herdr(world, { rendered: READY.claude });
  await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  const tabs = callsOf(herdr, "tab.create");
  expect(tabs.map((call) => call.params)).toEqual([
    { label: "01 · Tabs in the Pool workspace", focus: false, cwd: world.repo, workspace_id: "w1" },
  ]);
  // The fake answered with root pane w1:p1 in tab w1:t1, terminal term-1.
  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(spawned).toMatchObject({ pane_id: "w1:p1", tab_id: "w1:t1", terminal_id: "term-1" });
  expect(spawned.terminal_error).toBeUndefined();
  expect(spawned.pid).toBeUndefined();
  // The pane came off the answer, not a listing: between the tab and the
  // wrapper the server only reads the new pane, waiting for its shell. The
  // pane survey's own unscoped listing, on its 15 s cadence, may fall anywhere.
  const from = herdr.calls.indexOf(tabs[0]!);
  const wrapper = herdr.calls.indexOf(sends(herdr)[0]!);
  const between = herdr.calls
    .slice(from + 1, wrapper)
    .filter((call) => !(call.method === "pane.list" && Object.keys(call.params).length === 0));
  expect(between.length).toBeGreaterThan(0);
  expect(between.every((call) => call.method === "pane.read" && call.params.pane_id === "w1:p1")).toBe(true);
});

// attempt-run.test.ts:484 the Pool workspace (issue #94)
conformance("attempts", "a tab refused because the Pool workspace is gone re-resolves once and opens in the new workspace", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Re-resolve")], config: terminalConfig() });
  const herdr = await t.herdr(world, { rendered: READY.claude });
  // Boot creates w1; the operator closes it as the Attempt's tab is asked for.
  await herdr.control("removeWorkspaceOn", "tab.create", "w1");
  const server = await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  const firstTab = herdr.calls.indexOf(callsOf(herdr, "tab.create")[0]!);
  expect(
    herdr.calls
      .slice(firstTab)
      .filter((call) => ["tab.create", "workspace.get", "workspace.create"].includes(call.method))
      .map((call) => [call.method, call.params.workspace_id ?? null]),
  ).toEqual([
    ["tab.create", "w1"],
    ["workspace.get", "w1"],
    ["workspace.create", null],
    ["tab.create", "w2"],
  ]);
  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(spawned).toMatchObject({ pane_id: "w2:p1", tab_id: "w2:t1", terminal_id: "term-1" });
  expect(spawned.terminal_error).toBeUndefined();
  expect(await poolLogLines(server)).toContain("Pool workspace w1 is gone; the pool's tabs now open in w2");
});

// attempt-run.test.ts:512 the Pool workspace (issue #94)
conformance("attempts", "a refused tab whose workspace cannot be re-resolved falls back to headless after one tab.create", async (t) => {
  const world = t.world({ tickets: [ticket("01", "No workspace left")], config: terminalConfig() });
  // The server is launched in w1, which the daemon holds until the tab is
  // asked for; it will not create another.
  const herdr = await t.herdr(world, { rendered: READY.claude, workspaces: ["w1"], fail: ["workspace.create"] });
  await herdr.control("removeWorkspaceOn", "tab.create", "w1");
  const server = await t.start(world, { herdr, env: { HERDR_WORKSPACE_ID: "w1" } });
  await untilTicketStatus(world, "01", "done");

  expect(callsOf(herdr, "tab.create").map((call) => call.params.workspace_id)).toEqual(["w1"]);
  const firstTab = herdr.calls.indexOf(callsOf(herdr, "tab.create")[0]!);
  expect(
    herdr.calls
      .slice(firstTab + 1)
      .filter((call) => call.method.startsWith("workspace."))
      .map((call) => [call.method, call.params.workspace_id ?? null]),
  ).toEqual([
    ["workspace.get", "w1"],
    ["workspace.get", "w1"],
    ["workspace.create", null],
  ]);
  expect(sends(herdr)).toEqual([]);
  // The stub ran headless: its argv is the batch one.
  expect(world.stubs.calls().map((call) => [call.key, call.argv[0]])).toEqual([["01", HEADLESS_FLAG]]);
  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(spawned).toMatchObject({
    pane_id: null,
    tab_id: null,
    pid: expect.any(Number),
    terminal_error: 'tab.create failed: {"code":-32001,"message":"no such workspace w1"}',
  });
  expect(spawned.terminal_id).toBeUndefined();
  expect(await poolLogLines(server)).toContain(
    'the Pool workspace could not be re-resolved after a refused tab (workspace.create failed: {"code":-32000,"message":"workspace.create refused"}); this attempt falls back to headless',
  );
});

// attempt-run.test.ts:534 the Pool workspace (issue #94)
conformance("attempts", "a pool that got no Pool workspace at boot never sends an unplaced tab.create and runs headless", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Nowhere to open")], config: terminalConfig() });
  const herdr = await t.herdr(world, { rendered: READY.claude, fail: ["workspace.create"] });
  const server = await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  expect(callsOf(herdr, "workspace.create")).toHaveLength(1);
  expect(callsOf(herdr, "tab.create")).toEqual([]);
  expect(sends(herdr)).toEqual([]);
  expect(world.stubs.calls().map((call) => [call.key, call.argv[0]])).toEqual([["01", HEADLESS_FLAG]]);
  expect(spawnedPayloads(world, "01")[0]).toMatchObject({
    pane_id: null,
    tab_id: null,
    pid: expect.any(Number),
    terminal_error: "no Pool workspace: the herdr daemon could not give this pool one at boot",
  });
  expect(await poolLogLines(server)).toContain(
    'no Pool workspace could be resolved (workspace.create failed: {"code":-32000,"message":"workspace.create refused"}); attempts fall back to headless',
  );
});

// engine.test.ts:5477 terminal-backed attempts (named herdr tabs)
conformance("attempts", "a terminal-backed Attempt opens a named unfocused tab in its cwd, types the wrapper and waits on the pane's end", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Named herdr tabs")], config: terminalConfig() });
  const held = world.stubs.hold("01");
  const herdr = await t.herdr(world, { rendered: READY.claude });
  await t.start(world, { herdr });
  // The stub holds once it has read its prompt, so the ending wait
  // subscribes for the pane's end before the Outcome lands.
  const typed = await awaitPrompt(herdr, "01");
  await herdr.waitForCall((call) => call.method === "events.subscribe", { from: typed.at + 1 });
  await held.release();
  await untilTicketStatus(world, "01", "done");

  // The Pool workspace first, then boot reconciliation's listing scoped to
  // it, then the tab.
  expect(herdr.calls.slice(0, 3).map((call) => [call.method, call.method === "workspace.create" ? null : call.params])).toEqual([
    ["workspace.create", null],
    ["pane.list", { workspace_id: "w1" }],
    ["tab.create", { label: "01 · Named herdr tabs", focus: false, cwd: world.repo, workspace_id: "w1" }],
  ]);
  // The wrapper goes as one send, text and Enter together.
  expect(sends(herdr)[0]!.params).toEqual({
    pane_id: "w1:p1",
    text: wrapperFor(world, "01", interactiveArgv("claude")),
    keys: ["enter"],
  });
  // One subscription for the readiness wait, one for the ending wait, each
  // naming the three ends a pane can have.
  const subscriptions = callsOf(herdr, "events.subscribe");
  expect(subscriptions.map((call) => call.params)).toEqual([
    { subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }, { type: "tab.closed" }] },
    { subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }, { type: "tab.closed" }] },
  ]);
  expect(herdr.calls.indexOf(subscriptions[1]!)).toBeGreaterThan(typed.at);
  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(spawned).toMatchObject({ pane_id: "w1:p1", tab_id: "w1:t1" });
  expect(spawned.terminal_error).toBeUndefined();
});

// engine.test.ts:5575 terminal-backed attempts (named herdr tabs)
conformance("attempts", "a verify fan-out opens a tab for every Attempt, its graders included", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "Pick a winner")],
    config: terminalConfig("claude", { assign: { "01": { verify: 2 } } }),
  });
  world.stubs.script("01.attempt-1", { work: { file: "cand-1.txt", message: "cand-1" } });
  world.stubs.script("01.attempt-2", { work: { file: "cand-2.txt", message: "cand-2" } });
  world.stubs.script("01-grader-1", { grade: { score: 9, verdict: "pass", reasons: "first" } });
  world.stubs.script("01-grader-2", { grade: { score: 4, verdict: "flag", reasons: "second" } });
  const herdr = await t.herdr(world, { rendered: READY.claude });
  await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done", 60_000);

  const tabs = callsOf(herdr, "tab.create");
  expect(tabs).toHaveLength(4);
  for (const tab of tabs) {
    expect(tab.params.focus).toBe(false);
    expect(String(tab.params.label).length).toBeLessThanOrEqual(40);
    expect(tab.params.workspace_id).toBe("w1");
  }
  const worktrees = join(world.repo, ".git", "pool-worktrees", poolKey(world.repo));
  const builds = tabs.filter((tab) => String(tab.params.label).startsWith("01 · "));
  expect(builds.map((tab) => tab.params.label)).toEqual(["01 · Pick a winner", "01 · Pick a winner"]);
  expect(builds.map((tab) => tab.params.cwd).sort()).toEqual([
    join(worktrees, "01.attempt-1"),
    join(worktrees, "01.attempt-2"),
  ]);
  const graders = tabs.filter((tab) => String(tab.params.label).startsWith("01-grader-"));
  expect(graders).toHaveLength(2);
  for (const grader of graders) expect(grader.params.cwd).toBe(world.repo);
  for (const id of ["01-grader-1", "01-grader-2"]) {
    expect(String(spawnedPayloads(world, id)[0]!.pane_id)).toMatch(/^w1:p\d+$/);
  }
}, { timeoutMs: 90_000 });

// engine.test.ts:5857 terminal-backed attempts (named herdr tabs)
conformance("attempts", "a terminal-backed pool whose herdr socket has no daemon behind it runs headless and says why", async (t) => {
  const world = t.world({ tickets: [ticket("01", "No daemon")], config: terminalConfig() });
  // No fake: HERDR_SOCKET_PATH names a socket nobody listens on.
  const server = await t.start(world);
  await untilTicketStatus(world, "01", "done");

  expect(world.stubs.calls().map((call) => [call.key, call.argv[0]])).toEqual([["01", HEADLESS_FLAG]]);
  expect(spawnedPayloads(world, "01")[0]).toMatchObject({
    pane_id: null,
    tab_id: null,
    pid: expect.any(Number),
    terminal_error: "no Pool workspace: the herdr daemon could not give this pool one at boot",
  });
  // The connect error's own words are the runtime's; the line around them is the server's.
  const line = (await poolLogLines(server)).find((entry) => entry.startsWith("no Pool workspace could be resolved ("));
  expect(line).toBeDefined();
  expect(line!.endsWith("); attempts fall back to headless")).toBe(true);
});

// engine.test.ts:5878 terminal-backed attempts (named herdr tabs)
conformance("attempts", "a headless pool never calls herdr and records no pane facts", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Headless")], config: { defaults: { harness: "claude", model: "m" } } });
  const herdr = await t.herdr(world, { rendered: READY.claude });
  await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");
  await herdr.settle();

  expect(herdr.calls).toEqual([]);
  const spawned = spawnedPayloads(world, "01")[0]!;
  for (const key of ["pane_id", "tab_id", "terminal_id", "terminal_error"]) {
    expect(Object.keys(spawned)).not.toContain(key);
  }
  expect(spawned.pid).toEqual(expect.any(Number));
});

// herdr.test.ts:122 openAttemptTab, and the inventory gap on terminal_id
// (engine/attempt-run.ts:999-1002): a fallback's spawned event carries none
conformance("attempts", "a tab.create herdr refuses, retried once in the same workspace, falls back to headless with the daemon's error", async (t) => {
  const world = t.world({ tickets: [ticket("01", "Refused tab")], config: terminalConfig() });
  const herdr = await t.herdr(world, { rendered: READY.claude, fail: ["tab.create"] });
  await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  // The workspace is still there, so the refusal was something else: the
  // same workspace again, one retry, then headless.
  const firstTab = herdr.calls.indexOf(callsOf(herdr, "tab.create")[0]!);
  expect(
    herdr.calls
      .slice(firstTab)
      .filter((call) => ["tab.create", "workspace.get", "workspace.create"].includes(call.method))
      .map((call) => [call.method, call.params.workspace_id ?? null]),
  ).toEqual([
    ["tab.create", "w1"],
    ["workspace.get", "w1"],
    ["tab.create", "w1"],
  ]);
  expect(sends(herdr)).toEqual([]);
  expect(world.stubs.calls().map((call) => [call.key, call.argv[0]])).toEqual([["01", HEADLESS_FLAG]]);
  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(spawned).toMatchObject({
    pane_id: null,
    tab_id: null,
    pid: expect.any(Number),
    terminal_error: 'tab.create failed: {"code":-32000,"message":"tab.create refused"}',
  });
  expect(Object.keys(spawned)).not.toContain("terminal_id");
});

// herdr.test.ts:142 openAttemptTab
conformance("attempts", "a tab.create answered without a root pane falls back to headless, naming the answer", async (t) => {
  const world = t.world({ tickets: [ticket("01", "No root pane")], config: terminalConfig() });
  // A daemon before herdr protocol 20: the tab opens, its pane is not named.
  const herdr = await t.herdr(world, { rendered: READY.claude, noRootPane: true });
  await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  expect(callsOf(herdr, "tab.create").map((call) => call.params.workspace_id)).toEqual(["w1", "w1"]);
  expect(sends(herdr)).toEqual([]);
  expect(world.stubs.calls().map((call) => [call.key, call.argv[0]])).toEqual([["01", HEADLESS_FLAG]]);
  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(spawned).toMatchObject({ pane_id: null, tab_id: null, pid: expect.any(Number) });
  // The answer rides the error as JSON; its key order is the server's to choose.
  const error = String(spawned.terminal_error);
  const prefix = "tab.create returned no root pane id: ";
  expect(error.startsWith(prefix)).toBe(true);
  expect(JSON.parse(error.slice(prefix.length))).toEqual({
    type: "tab_created",
    tab: { tab_id: "w1:t2", workspace_id: "w1" },
  });
});
