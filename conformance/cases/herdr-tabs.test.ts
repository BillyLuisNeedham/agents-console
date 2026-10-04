/**
 * The herdr tabs a terminal-backed pool opens and closes, the agent it
 * reports in herdr's sidebar, and the RPC client itself, seen from outside
 * the server: the calls on the fake herdr's socket, the spawned events, and
 * the terminal routes' answers. Rows of the `herdr` area in the Rust port
 * inventory (docs/research/rust-port/test-inventory.md, ticket C14).
 */

import { expect } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance, type Case } from "../harness/case.ts";
import type { HerdrProcess } from "../harness/herdr.ts";
import {
  answerPrompt,
  awaitPrompt,
  callsOf,
  doneOutcome,
  readyTicket,
  spawnedPayloads,
  TERMINAL_CONFIG,
  TUI_FRAMES,
  tuiStandIn,
  untilTicketStatus,
  type TuiStandIn,
  type TypedPrompt,
} from "../harness/herdr-tui.ts";
import { readEvents, readMarkers, until } from "../harness/pool-files.ts";
import type { World, WorldSpec } from "../harness/world.ts";

const SOURCE = "herdr:agent-console";

function terminalWorld(t: Case, spec: WorldSpec = {}): { world: World; tui: TuiStandIn } {
  const world = t.world({ config: TERMINAL_CONFIG, ...spec });
  return { world, tui: tuiStandIn(world) };
}

function fakeHerdr(t: Case, world: World, options: { workspaces?: string[]; fail?: string[] } = {}): Promise<HerdrProcess> {
  return t.herdr(world, { rendered: TUI_FRAMES.claude, ...options });
}

async function runToDone(herdr: HerdrProcess, world: World, id: string): Promise<TypedPrompt> {
  const typed = await answerPrompt(herdr, id, doneOutcome());
  await untilTicketStatus(world, id, "done");
  return typed;
}

/** The label the pool gave its first tab, once that tab is opened. */
async function firstTabLabel(herdr: HerdrProcess): Promise<string> {
  return String((await herdr.waitForCall((call) => call.method === "tab.create")).params.label);
}

/** The working directory of the Attempt whose prompt went to `paneId`. */
function cwdOfPane(world: World, ids: string[], paneId: string): string {
  for (const id of ids) {
    const spawned = spawnedPayloads(world, id).find((payload) => payload.pane_id === paneId);
    if (spawned) return String(spawned.cwd);
  }
  throw new Error(`no spawned event names pane ${paneId}`);
}

/** Commit one file in a worktree, the work an agent leaves; its sha. */
function commitWork(world: World, cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `${file}\n`);
  world.git(["-C", cwd, "add", file]);
  world.git(["-C", cwd, "commit", "-qm", `work ${file}`]);
  return world.git(["-C", cwd, "rev-parse", "HEAD"]).trim();
}

/** Play a candidate Attempt that commits its work and ends done. */
async function candidate(herdr: HerdrProcess, world: World, key: string, file: string): Promise<TypedPrompt> {
  const typed = await awaitPrompt(herdr, key);
  const sha = commitWork(world, cwdOfPane(world, ["01"], typed.paneId), file);
  writeFileSync(typed.outcomePath, JSON.stringify({ status: "done", summary: `${key} done`, commitSha: sha }));
  return typed;
}

function graderOutcome(score: number, verdict: "pass" | "flag"): Record<string, unknown> {
  return { status: "done", summary: "graded", commitSha: null, grade: { score, verdict, reasons: `scored ${score}` } };
}

/** Every tab id the spawned events of `ids` recorded. */
function spawnedTabs(world: World, ids: string[]): string[] {
  return ids.flatMap((id) =>
    spawnedPayloads(world, id)
      .map((payload) => payload.tab_id)
      .filter((tab): tab is string => typeof tab === "string"),
  );
}

async function untilTabsClosed(herdr: HerdrProcess, tabs: string[]): Promise<string[]> {
  return until(
    () => callsOf(herdr, "tab.close").map((call) => String(call.params.tab_id)),
    (closed) => tabs.every((tab) => closed.includes(tab)),
    { ms: 20_000, what: `tab.close for ${tabs.join(", ")}` },
  );
}

interface StateAnswer {
  snapshot: { state: { interrupts: { ticketId: string }[] } } | null;
}

const VERIFY = (n: number): WorldSpec["config"] => ({ ...TERMINAL_CONFIG, assign: { "01": { verify: n } } });

// --- Tab labels ---------------------------------------------------------

conformance("herdr", "an Attempt's tab is labelled with its id and title joined by a middle dot", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Named herdr tabs")] });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  const label = await firstTabLabel(herdr);
  await runToDone(herdr, world, "01");

  expect(label).toBe("01 · Named herdr tabs");
});

conformance("herdr", "a long title is truncated so the tab label is 40 characters", async (t) => {
  const title = "Named herdr tabs Named herdr tabs Named herdr tabs";
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", title)] });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  const label = await firstTabLabel(herdr);
  await runToDone(herdr, world, "01");

  expect(label).toBe(`01 · ${title.slice(0, 35)}`);
  expect(label).toHaveLength(40);
});

conformance("herdr", "a 60-character title is cut to the label cap", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("07", "x".repeat(60))] });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  const label = await firstTabLabel(herdr);
  await runToDone(herdr, world, "07");

  expect(label).toBe(`07 · ${"x".repeat(35)}`);
});

conformance("herdr", "a label exactly at the cap is kept whole", async (t) => {
  const title = "An exactly capped title of 35 chars";
  expect(title).toHaveLength(35);
  const { world } = terminalWorld(t, { tickets: [readyTicket("07", title)] });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  const label = await firstTabLabel(herdr);
  await runToDone(herdr, world, "07");

  expect(label).toBe(`07 · ${title}`);
  expect(label).toHaveLength(40);
});

// --- Opening the tab ----------------------------------------------------

conformance("herdr", "the Attempt's tab is created unfocused in the Pool workspace and its pane taken off root_pane", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world, { workspaces: ["w7"] });
  await t.start(world, { herdr, env: { HERDR_WORKSPACE_ID: "w7" } });
  await runToDone(herdr, world, "01");

  expect(callsOf(herdr, "tab.create").map((call) => call.params)).toEqual([
    { label: "01 · Workspaces", focus: false, cwd: world.repo, workspace_id: "w7" },
  ]);
  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(spawned.pane_id).toBe("w7:p1");
  expect(spawned.tab_id).toBe("w7:t1");
  // The root pane's terminal id rides the tab.create answer too.
  expect(spawned.terminal_id).toBe("term-1");
});

conformance("herdr", "a refused tab in a created Pool workspace that is gone creates another and opens the tab there", async (t) => {
  const { world } = terminalWorld(t, {
    tickets: [readyTicket("01", "First"), readyTicket("02", "Second", "01")],
  });
  const herdr = await fakeHerdr(t, world);
  const server = await t.start(world, { herdr });
  await answerPrompt(herdr, "01", doneOutcome(), { before: () => herdr.control("removeWorkspace", "w1") });
  await runToDone(herdr, world, "02");

  const tabCreates = callsOf(herdr, "tab.create");
  const refused = herdr.calls.indexOf(tabCreates[1]!);
  expect(herdr.calls.slice(refused).map((call) => [call.method, call.params.workspace_id ?? null]).filter(([method]) =>
    ["tab.create", "workspace.get", "workspace.create"].includes(String(method)),
  )).toEqual([
    ["tab.create", "w1"],
    ["workspace.get", "w1"],
    ["workspace.create", null],
    ["tab.create", "w2"],
  ]);
  expect(spawnedPayloads(world, "02")[0]!.pane_id).toBe("w2:p2");
  const log = (await server.http.get("/api/pool-log?before=1000000000&limit=2000")).json<{ lines: string[] }>().lines;
  expect(log).toContain("Pool workspace w1 is gone; the pool's tabs now open in w2");
});

// --- Closing tabs -------------------------------------------------------

conformance("herdr", "grader tabs close when their verdicts land, then the winner's at its merge, then the loser's at its discard", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Pick a winner")], config: VERIFY(2) });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  await Promise.all([
    candidate(herdr, world, "01.attempt-1", "cand-1.txt"),
    candidate(herdr, world, "01.attempt-2", "cand-2.txt"),
  ]);
  await Promise.all([
    answerPrompt(herdr, "01-grader-1", graderOutcome(9, "pass")),
    answerPrompt(herdr, "01-grader-2", graderOutcome(4, "flag")),
  ]);
  await untilTicketStatus(world, "01", "done");

  const tabs = spawnedTabs(world, ["01", "01-grader-1", "01-grader-2"]);
  expect(tabs).toHaveLength(4);
  const closed = await untilTabsClosed(herdr, tabs);
  expect([...closed].sort()).toEqual([...tabs].sort());
  const at = (tab: string) => closed.indexOf(tab);
  const winner = spawnedPayloads(world, "01")[0]!.tab_id as string;
  const loser = spawnedPayloads(world, "01")[1]!.tab_id as string;
  for (const grader of spawnedTabs(world, ["01-grader-1", "01-grader-2"])) {
    expect(at(grader)).toBeLessThan(at(winner));
  }
  expect(at(winner)).toBeLessThan(at(loser));
});

conformance("herdr", "the head-to-head judge's tab closes when its verdict lands, with every other tab of the round", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Pick a winner")], config: VERIFY(2) });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  await Promise.all([
    candidate(herdr, world, "01.attempt-1", "cand-1.txt"),
    candidate(herdr, world, "01.attempt-2", "cand-2.txt"),
  ]);
  await Promise.all([
    answerPrompt(herdr, "01-grader-1", graderOutcome(9, "pass")),
    answerPrompt(herdr, "01-grader-2", graderOutcome(8, "pass")),
  ]);
  // A margin of 1 is below the outright band: the judge decides.
  await answerPrompt(herdr, "01-head-to-head", { status: "done", summary: "judged", commitSha: null, winner: 2 });
  await untilTicketStatus(world, "01", "done");

  const tabs = spawnedTabs(world, ["01", "01-grader-1", "01-grader-2", "01-head-to-head"]);
  expect(tabs).toHaveLength(5);
  const closed = await untilTabsClosed(herdr, tabs);
  expect([...closed].sort()).toEqual([...tabs].sort());
});

conformance("herdr", "a crashed grader's tab closes on the failure path, and the build Attempt's tab stays open", async (t) => {
  const { world, tui } = terminalWorld(t, { tickets: [readyTicket("01", "Pick a winner")], config: VERIFY(1) });
  const herdr = await fakeHerdr(t, world);
  const server = await t.start(world, { herdr });
  await candidate(herdr, world, "01.attempt-1", "cand-1.txt");
  // The grader quits with 1 and no outcome, on its first run and both re-spawns.
  let from = 0;
  for (let run = 0; run < 3; run++) {
    const typed = await awaitPrompt(herdr, "01-grader-1", { from });
    tui.release(tui.launches().length, 1);
    from = typed.at + 1;
  }

  const graderTabs = await until(() => spawnedTabs(world, ["01-grader-1"]), (tabs) => tabs.length === 3, {
    ms: 20_000,
    what: "three grader runs",
  });
  const closed = await untilTabsClosed(herdr, graderTabs);
  // The grading spent its re-spawns: 01 waits on an Interrupt, not done.
  await until(
    async () => (await server.http.get("/api/state")).json<StateAnswer>().snapshot?.state.interrupts ?? [],
    (interrupts) => interrupts.some((interrupt) => interrupt.ticketId === "01"),
    { ms: 20_000, what: "an Interrupt on 01" },
  );

  expect(readMarkers(world.pool)["01"]!.status).not.toBe("done");
  expect([...closed].sort()).toEqual([...graderTabs].sort());
  for (const tab of spawnedTabs(world, ["01"])) expect(closed).not.toContain(tab);
});

conformance("herdr", "each Attempt's tab closes when its Ticket merges", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", "First"), readyTicket("02", "Second")] });
  const herdr = await fakeHerdr(t, world, { workspaces: ["w-launch"] });
  await t.start(world, { herdr, env: { HERDR_WORKSPACE_ID: "w-launch" } });
  await Promise.all(
    ["01", "02"].map(async (id) => {
      const typed = await awaitPrompt(herdr, id);
      const sha = commitWork(world, cwdOfPane(world, [id], typed.paneId), `work-${id}.txt`);
      writeFileSync(typed.outcomePath, JSON.stringify({ status: "done", summary: `${id} done`, commitSha: sha }));
    }),
  );
  await untilTicketStatus(world, "01", "done");
  await untilTicketStatus(world, "02", "done");

  const tabs = spawnedTabs(world, ["01", "02"]);
  const closed = await untilTabsClosed(herdr, tabs);
  expect([...closed].sort()).toEqual([...tabs].sort());
  for (const id of ["01", "02"]) {
    expect(readEvents(world.pool, id).some((event) => event.kind === "merged")).toBe(true);
  }
});

// --- Agent reporting ----------------------------------------------------

conformance("herdr", "the Attempt's agent is reported once at launch and released once at its ending", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  await runToDone(herdr, world, "01");
  await herdr.waitForCall((call) => call.method === "pane.release_agent");

  const reports = callsOf(herdr, "pane.report_agent");
  expect(reports).toHaveLength(1);
  expect(reports[0]!.params).toEqual({
    pane_id: "w1:p1",
    source: SOURCE,
    agent: "claude",
    state: "working",
    seq: expect.any(Number),
    message: "01 · Workspaces",
  });
  const released = callsOf(herdr, "pane.release_agent");
  expect(released).toHaveLength(1);
  expect(released[0]!.params).toMatchObject({ pane_id: "w1:p1", source: SOURCE, agent: "claude" });
});

conformance("herdr", "the release names the Attempt's pane under the engine's own source", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  const typed = await runToDone(herdr, world, "01");
  const release = await herdr.waitForCall((call) => call.method === "pane.release_agent");
  await Bun.sleep(300);

  expect(release.params).toEqual({ pane_id: typed.paneId, source: SOURCE, agent: "claude" });
  expect(callsOf(herdr, "pane.release_agent")).toHaveLength(1);
});

conformance("herdr", "a Conversation's agent is reported working, then blocked with a larger seq once its Turn waits", async (t) => {
  const { world } = terminalWorld(t);
  // A Seeded Pool: no Tickets, and a conversations/ directory to opt in.
  mkdirSync(join(world.pool, "conversations"));
  const herdr = await fakeHerdr(t, world);
  const server = await t.start(world, { herdr });
  const started = await server.http.post("/api/conversations", { title: "Talk it through" });
  expect(started.status).toBe(201);

  await until(
    () => callsOf(herdr, "pane.report_agent").map((call) => call.params.state),
    (states) => states.includes("blocked"),
    { ms: 20_000, what: "the Conversation's agent to be reported blocked" },
  );
  const reports = callsOf(herdr, "pane.report_agent");
  const working = reports.find((call) => call.params.state === "working")!;
  const blocked = reports.find((call) => call.params.state === "blocked")!;
  expect(reports.indexOf(working)).toBeLessThan(reports.indexOf(blocked));
  expect(working.params).toMatchObject({ source: SOURCE, agent: "claude", message: blocked.params.message });
  expect(String(working.params.message)).toContain("Talk it through");
  expect(typeof working.params.seq).toBe("number");
  expect(Number(blocked.params.seq)).toBeGreaterThan(Number(working.params.seq));
});

conformance("herdr", "a refused agent report changes nothing: the Attempt runs in its pane to done", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world, { fail: ["pane.report_agent"] });
  await t.start(world, { herdr });
  await runToDone(herdr, world, "01");

  expect(callsOf(herdr, "pane.report_agent")).toHaveLength(1);
  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(spawned.pane_id).toBe("w1:p1");
  expect(spawned.terminal_error).toBeUndefined();
});

// --- The RPC client -----------------------------------------------------

conformance("herdr", "every herdr call goes out as one request on its own connection, and only the subscription stays open", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  const typed = await awaitPrompt(herdr, "01");
  // Mid-Attempt: the server waits on the pane's end over a subscription,
  // and every answered call's connection has closed.
  const open = await until(
    () => herdr.control<number[]>("openConnections"),
    (ids) => ids.length === 1,
    { what: "every answered connection to close" },
  );
  expect(herdr.calls.filter((call) => call.connection === open[0]).map((call) => call.method)).toEqual(["events.subscribe"]);
  writeFileSync(typed.outcomePath, JSON.stringify(doneOutcome()));
  await untilTicketStatus(world, "01", "done");
  await herdr.waitForCall((call) => call.method === "pane.release_agent");

  const methods = new Set(herdr.calls.map((call) => call.method));
  for (const method of ["workspace.create", "pane.list", "tab.create", "pane.read", "pane.send_input", "events.subscribe"]) {
    expect(methods).toContain(method);
  }
  const connections = herdr.calls.map((call) => call.connection);
  expect(new Set(connections).size).toBe(connections.length);
});

conformance("herdr", "a herdr refusal reaches the terminal route as a 502 carrying the daemon's error", async (t) => {
  const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world, { fail: ["pane.focus"] });
  const server = await t.start(world, { herdr });
  const typed = await awaitPrompt(herdr, "01");

  const answer = await server.http.post("/api/terminal/focus?ticket=01");
  writeFileSync(typed.outcomePath, JSON.stringify(doneOutcome()));
  await untilTicketStatus(world, "01", "done");

  expect(answer.status).toBe(502);
  expect(answer.json<{ error: string }>().error).toContain("pane.focus refused");
});

conformance(
  "herdr",
  "a herdr call the daemon never answers times out after 10 s as a 502 (slow: the client's fixed watchdog)",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
    const herdr = await fakeHerdr(t, world);
    await herdr.control("hang", "pane.focus", true);
    const server = await t.start(world, { herdr });
    const typed = await awaitPrompt(herdr, "01");

    const began = Date.now();
    const answer = await server.http.post("/api/terminal/focus?ticket=01");
    const took = Date.now() - began;
    writeFileSync(typed.outcomePath, JSON.stringify(doneOutcome()));
    await untilTicketStatus(world, "01", "done");

    expect(answer.status).toBe(502);
    expect(answer.json<{ error: string }>().error).toContain("herdr rpc timed out (pane.focus)");
    expect(took).toBeGreaterThanOrEqual(9_000);
  },
  { timeoutMs: 90_000 },
);

conformance("herdr", "with HERDR_SOCKET_PATH unset or blank the server finds the daemon at HOME/.config/herdr/herdr.sock", async (t) => {
  for (const socketPath of [null, "   "]) {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
    const herdr = await fakeHerdr(t, world);
    mkdirSync(join(world.home, ".config", "herdr"), { recursive: true });
    symlinkSync(herdr.socketPath, join(world.home, ".config", "herdr", "herdr.sock"));
    await t.start(world, { env: { HERDR_SOCKET_PATH: socketPath } });
    await runToDone(herdr, world, "01");

    expect(callsOf(herdr, "workspace.create")).toHaveLength(1);
    expect(callsOf(herdr, "tab.create")).toHaveLength(1);
  }
});
