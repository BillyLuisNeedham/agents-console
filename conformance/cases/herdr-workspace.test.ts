/**
 * The Pool workspace (issue #94, issue #100), seen from outside the server:
 * the herdr workspace a terminal-backed pool opens every tab in, which
 * workspace it resolves at boot and after a refused tab, what it remembers
 * in `runs/pool-workspace.json`, and when it relabels the workspace to the
 * Pool title. Rows of the `herdr` area in the Rust port inventory
 * (docs/research/rust-port/test-inventory.md, ticket C14).
 */

import { expect } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conformance, type Case } from "../harness/case.ts";
import type { HerdrProcess } from "../harness/herdr.ts";
import {
  answerPrompt,
  callsOf,
  doneOutcome,
  poolLog,
  readyTicket,
  rememberedWorkspace,
  spawnedPayloads,
  TERMINAL_CONFIG,
  TUI_FRAMES,
  tuiStandIn,
  untilTicketStatus,
} from "../harness/herdr-tui.ts";
import { until } from "../harness/pool-files.ts";
import type { World, WorldSpec } from "../harness/world.ts";

/** The pool's directory name, which labels a workspace it creates untitled. */
const POOL = "herdr-pool";

/** A terminal-backed world with a TUI stand-in for claude. */
function terminalWorld(t: Case, spec: WorldSpec = {}): World {
  const world = t.world({ poolName: POOL, config: TERMINAL_CONFIG, ...spec });
  tuiStandIn(world);
  return world;
}

function titled(title: string): WorldSpec["config"] {
  return { ...TERMINAL_CONFIG, title };
}

function remembers(content: string): Record<string, string> {
  return { "runs/pool-workspace.json": content };
}

/** The fake herdr for a terminal world, drawing claude's ready frame. */
function fakeHerdr(t: Case, world: World, workspaces: string[] = [], fail: string[] = []): Promise<HerdrProcess> {
  return t.herdr(world, { rendered: TUI_FRAMES.claude, workspaces, fail });
}

/** Run Ticket `id`'s Attempt to done in its pane. */
async function runToDone(herdr: HerdrProcess, world: World, id: string): Promise<void> {
  await answerPrompt(herdr, id, doneOutcome());
  await untilTicketStatus(world, id, "done");
}

async function retitle(server: { http: { put(path: string, body?: unknown): Promise<{ status: number }> } }, title: string): Promise<void> {
  const answer = await server.http.put("/api/settings/pool", { config: { title } });
  expect(answer.status).toBe(200);
}

/** Wait until the snapshot's Pool title reads `title`: the run has taken the edit. */
async function untilPoolTitle(server: { http: { get(path: string): Promise<{ json<T>(): T }> } }, title: string | null): Promise<void> {
  await until(
    async () => (await server.http.get("/api/state")).json<{ snapshot: { poolTitle: string | null } | null }>().snapshot?.poolTitle,
    (got) => got === title,
    { what: `the snapshot's poolTitle to read ${JSON.stringify(title)}` },
  );
}

/**
 * Wait for a pool log line starting `prefix` that a relabel adds after the
 * Settings save that caused it. The line rides the run's next snapshot, so
 * each poll saves the same `title` again: a save on an idle pool publishes
 * one, and the same title asks herdr nothing.
 */
async function untilLogged(server: Parameters<typeof retitle>[0] & Parameters<typeof poolLog>[0], title: string, prefix: string): Promise<string[]> {
  return until(
    async () => {
      await retitle(server, title);
      return poolLog(server);
    },
    (lines) => lines.some((line) => line.startsWith(prefix)),
    { what: `a pool log line starting ${prefix}` },
  );
}

const LAUNCH = { HERDR_WORKSPACE_ID: "w-launch" };

conformance("herdr", "a terminal pool remembering nothing creates its Pool workspace at boot, remembers it, and opens the tab in it", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world);
  const server = await t.start(world, { herdr });
  await runToDone(herdr, world, "01");

  expect(callsOf(herdr, "workspace.create").map((call) => call.params)).toEqual([
    { label: POOL, cwd: world.repo, focus: false },
  ]);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w1", created: true, label: POOL });
  expect(String(spawnedPayloads(world, "01")[0]!.pane_id)).toStartWith("w1:");
  expect(callsOf(herdr, "workspace.list")).toEqual([]);
  expect(await poolLog(server)).toContain("Pool workspace w1 created for this pool's tabs");
});

conformance("herdr", "a remembered Pool workspace the daemon still holds is reused, and nothing is created", async (t) => {
  const world = terminalWorld(t, {
    tickets: [readyTicket("01", "Workspaces")],
    poolFiles: remembers('{"workspace_id":"w-kept"}\n'),
  });
  const herdr = await fakeHerdr(t, world, ["w-kept"]);
  await t.start(world, { herdr });
  await runToDone(herdr, world, "01");

  expect(herdr.calls[0]).toMatchObject({ method: "workspace.get", params: { workspace_id: "w-kept" } });
  expect(callsOf(herdr, "workspace.create")).toEqual([]);
  expect(callsOf(herdr, "tab.create").map((call) => call.params.workspace_id)).toEqual(["w-kept"]);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w-kept" });
});

conformance("herdr", "a remembered Pool workspace that is gone falls to the workspace the server was launched in", async (t) => {
  const world = terminalWorld(t, {
    tickets: [readyTicket("01", "Workspaces")],
    poolFiles: remembers('{"workspace_id":"w-closed"}\n'),
  });
  const herdr = await fakeHerdr(t, world, ["w-launch"]);
  await t.start(world, { herdr, env: LAUNCH });
  await runToDone(herdr, world, "01");

  expect(callsOf(herdr, "workspace.get").map((call) => call.params.workspace_id)).toEqual(["w-closed", "w-launch"]);
  expect(callsOf(herdr, "workspace.create")).toEqual([]);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w-launch" });
  expect(String(spawnedPayloads(world, "01")[0]!.pane_id)).toStartWith("w-launch:");
});

conformance("herdr", "boot reconciliation's pane listing is scoped to the Pool workspace", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world, ["w-launch"]);
  await t.start(world, { herdr, env: LAUNCH });
  const listing = await herdr.waitForCall((call) => call.method === "pane.list");
  await runToDone(herdr, world, "01");

  expect(listing.params).toEqual({ workspace_id: "w-launch" });
});

conformance("herdr", "a launch workspace closed mid-run is re-resolved once and the refused tab retried in a new one", async (t) => {
  const world = terminalWorld(t, {
    tickets: [readyTicket("01", "First"), readyTicket("02", "Second", "01")],
  });
  const herdr = await fakeHerdr(t, world, ["w-launch"]);
  const server = await t.start(world, { herdr, env: LAUNCH });
  // The operator closes the workspace while 01 runs, so 02's tab is refused.
  await answerPrompt(herdr, "01", doneOutcome(), { before: () => herdr.control("removeWorkspace", "w-launch") });
  await runToDone(herdr, world, "02");

  expect(callsOf(herdr, "workspace.create")).toHaveLength(1);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w1", created: true, label: POOL });
  const spawned = spawnedPayloads(world, "02")[0]!;
  expect(String(spawned.pane_id)).toStartWith("w1:");
  expect(spawned.terminal_error).toBeUndefined();
  expect(await poolLog(server)).toContain("Pool workspace w-launch is gone; the pool's tabs now open in w1");
});

conformance("herdr", "a refused tab in a Pool workspace that still exists is a blip: the same workspace takes the retry", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world, ["w-launch"]);
  await herdr.control("failNextCall", "tab.create", 1);
  await t.start(world, { herdr, env: LAUNCH });
  await runToDone(herdr, world, "01");

  expect(callsOf(herdr, "tab.create").map((call) => call.params.workspace_id)).toEqual(["w-launch", "w-launch"]);
  expect(callsOf(herdr, "workspace.create")).toEqual([]);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w-launch" });
  expect(String(spawnedPayloads(world, "01")[0]!.pane_id)).toStartWith("w-launch:");
});

conformance("herdr", "two spawns refused together in one super-step mint one new Pool workspace, not two", async (t) => {
  const world = terminalWorld(t, {
    tickets: [readyTicket("01", "First"), readyTicket("02", "Second")],
  });
  const herdr = await fakeHerdr(t, world, ["w-launch"]);
  // Closed as boot reconciliation's listing arrives, before either tab.
  await herdr.control("removeWorkspaceOn", "pane.list", "w-launch");
  await t.start(world, { herdr, env: LAUNCH });
  await Promise.all([runToDone(herdr, world, "01"), runToDone(herdr, world, "02")]);

  expect(callsOf(herdr, "workspace.create")).toHaveLength(1);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w1", created: true, label: POOL });
  for (const id of ["01", "02"]) {
    const spawned = spawnedPayloads(world, id)[0]!;
    expect(String(spawned.pane_id)).toStartWith("w1:");
    expect(spawned.terminal_error).toBeUndefined();
  }
});

conformance("herdr", "a Pool workspace that cannot be remembered is still used for the run", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  // A directory where the file goes: neither readable as a record nor writable.
  mkdirSync(join(world.pool, "runs", "pool-workspace.json"), { recursive: true });
  const herdr = await fakeHerdr(t, world, ["w-launch"]);
  const server = await t.start(world, { herdr, env: LAUNCH });
  await runToDone(herdr, world, "01");

  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(String(spawned.pane_id)).toStartWith("w-launch:");
  expect(spawned.terminal_error).toBeUndefined();
  expect((await poolLog(server)).some((line) => line.startsWith("Pool workspace w-launch could not be remembered"))).toBe(true);
});

conformance("herdr", "a remembered record that is unreadable or holds no id is resolved afresh and rewritten", async (t) => {
  for (const content of ['{"workspace_id":7}\n', "not json at all"]) {
    const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")], poolFiles: remembers(content) });
    const herdr = await fakeHerdr(t, world, ["w-launch"]);
    await t.start(world, { herdr, env: LAUNCH });
    await runToDone(herdr, world, "01");

    expect(callsOf(herdr, "workspace.get").map((call) => call.params)).toEqual([{ workspace_id: "w-launch" }]);
    expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w-launch" });
  }
});

conformance("herdr", "a pool that can have no Pool workspace boots and runs its Attempts headless", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world, [], ["workspace.create"]);
  const server = await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  expect((await poolLog(server)).some((line) => line.startsWith("no Pool workspace could be resolved"))).toBe(true);
  expect(callsOf(herdr, "tab.create")).toEqual([]);
  const spawned = spawnedPayloads(world, "01")[0]!;
  expect(spawned.pane_id).toBeNull();
  expect(String(spawned.terminal_error)).toContain("no Pool workspace");
  expect(typeof spawned.pid).toBe("number");
});

conformance("herdr", "a workspace the pool creates is labelled with the Pool title", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")], config: titled("Jev as the grader") });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  await runToDone(herdr, world, "01");

  expect(callsOf(herdr, "workspace.create").map((call) => call.params.label)).toEqual(["Jev as the grader"]);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w1", created: true, label: "Jev as the grader" });
  expect(callsOf(herdr, "workspace.rename")).toEqual([]);
});

conformance("herdr", "the pool relabels its own workspace live when the title changes, and back to the directory when it is cleared", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")], config: titled("First title") });
  const herdr = await fakeHerdr(t, world);
  const server = await t.start(world, { herdr });
  await runToDone(herdr, world, "01");

  await retitle(server, "Second title");
  await herdr.waitForCall((call) => call.method === "workspace.rename");
  await until(() => rememberedWorkspace(world), (got) => (got as { label?: string }).label === "Second title", {
    what: "the record to carry the new label",
  });
  expect(await herdr.control<string | null>("workspaceLabel", "w1")).toBe("Second title");
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w1", created: true, label: "Second title" });

  // The same title again is no change and asks herdr nothing.
  await retitle(server, "Second title");
  await retitle(server, "");
  await until(() => callsOf(herdr, "workspace.rename").length, (n) => n >= 2, { what: "the relabel to the directory" });
  await until(() => rememberedWorkspace(world), (got) => (got as { label?: string }).label === POOL, {
    what: "the record to carry the directory's label",
  });

  expect(callsOf(herdr, "workspace.rename").map((call) => call.params)).toEqual([
    { workspace_id: "w1", label: "Second title" },
    { workspace_id: "w1", label: POOL },
  ]);
  expect(await poolLog(server)).toContain('Pool workspace w1 relabelled "Second title"');
});

conformance("herdr", "a workspace the pool created is relabelled at boot when the title changed while the server was down", async (t) => {
  const world = terminalWorld(t, {
    tickets: [readyTicket("01", "Workspaces")],
    config: titled("Renamed while down"),
    poolFiles: remembers('{"workspace_id":"w-kept","created":true,"label":"Old title"}\n'),
  });
  const herdr = await fakeHerdr(t, world, ["w-kept"]);
  await t.start(world, { herdr });
  await runToDone(herdr, world, "01");

  expect(callsOf(herdr, "workspace.rename").map((call) => call.params)).toEqual([
    { workspace_id: "w-kept", label: "Renamed while down" },
  ]);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w-kept", created: true, label: "Renamed while down" });
});

conformance("herdr", "the launch workspace is never relabelled when the title changes", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")], config: titled("A title") });
  const herdr = await fakeHerdr(t, world, ["w-launch"]);
  const server = await t.start(world, { herdr, env: LAUNCH });
  await runToDone(herdr, world, "01");

  await retitle(server, "Saved title");
  await untilPoolTitle(server, "Saved title");
  // The relabel is fire-and-forget behind the title: give one a moment to land.
  await Bun.sleep(500);

  expect(callsOf(herdr, "workspace.rename")).toEqual([]);
  expect(await herdr.control<string | null>("workspaceLabel", "w-launch")).toBe("");
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w-launch" });
});

conformance("herdr", "a remembered workspace whose record does not say the Console made it is never relabelled", async (t) => {
  const world = terminalWorld(t, {
    tickets: [readyTicket("01", "Workspaces")],
    config: titled("A title"),
    poolFiles: remembers('{"workspace_id":"w-kept"}\n'),
  });
  const herdr = await fakeHerdr(t, world, ["w-kept"]);
  const server = await t.start(world, { herdr });
  await runToDone(herdr, world, "01");

  await retitle(server, "Saved title");
  await untilPoolTitle(server, "Saved title");
  await Bun.sleep(500);

  expect(callsOf(herdr, "workspace.rename")).toEqual([]);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w-kept" });
});

conformance("herdr", "a refused relabel is logged and the workspace keeps its recorded label", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")], config: titled("First title") });
  const herdr = await fakeHerdr(t, world, [], ["workspace.rename"]);
  const server = await t.start(world, { herdr });
  await runToDone(herdr, world, "01");

  await retitle(server, "Second title");
  await herdr.waitForCall((call) => call.method === "workspace.rename");
  const log = await untilLogged(server, "Second title", 'Pool workspace w1 could not be relabelled "Second title"');

  expect(log.some((line) => line.includes("workspace.rename refused"))).toBe(true);
  expect(await herdr.control<string | null>("workspaceLabel", "w1")).toBe("First title");
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w1", created: true, label: "First title" });
});

conformance("herdr", "neither the remembered nor the launch workspace held: one is created, unfocused, labelled for the pool", async (t) => {
  const world = terminalWorld(t, {
    tickets: [readyTicket("01", "Workspaces")],
    config: titled("pool title"),
    poolFiles: remembers('{"workspace_id":"wR"}\n'),
  });
  const herdr = await fakeHerdr(t, world);
  const server = await t.start(world, { herdr, env: { HERDR_WORKSPACE_ID: "wL" } });
  await runToDone(herdr, world, "01");

  const workspaceCalls = herdr.calls.filter((call) => call.method.startsWith("workspace."));
  expect(workspaceCalls.map((call) => [call.method, call.params])).toEqual([
    ["workspace.get", { workspace_id: "wR" }],
    ["workspace.get", { workspace_id: "wL" }],
    ["workspace.create", { label: "pool title", cwd: world.repo, focus: false }],
  ]);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w1", created: true, label: "pool title" });
  expect(await poolLog(server)).toContain("Pool workspace w1 created for this pool's tabs");
});

conformance("herdr", "a fresh pool launched outside any workspace creates one without asking for any", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world);
  await t.start(world, { herdr });
  await runToDone(herdr, world, "01");

  expect(callsOf(herdr, "workspace.create")).toHaveLength(1);
  expect(callsOf(herdr, "workspace.get")).toEqual([]);
  expect(callsOf(herdr, "tab.create")[0]!.params.workspace_id).toBe("w1");
});

conformance("herdr", "a daemon that will not create a workspace still lets the server boot, and the Attempt runs headless", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world, [], ["workspace.create"]);
  const server = await t.start(world, { herdr });
  await untilTicketStatus(world, "01", "done");

  const log = await poolLog(server);
  expect(log.some((line) => line.startsWith("no Pool workspace could be resolved") && line.endsWith("attempts fall back to headless"))).toBe(true);
  // The headless launch: the stub harness was run with the prompt in argv.
  expect(world.stubs.calls().map((call) => [call.key, call.argv[0]])).toEqual([["01", "-p"]]);
  expect(typeof spawnedPayloads(world, "01")[0]!.terminal_error).toBe("string");
});

conformance("herdr", "a title saved on an untitled pool relabels the workspace it created, by id", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world);
  const server = await t.start(world, { herdr });
  await runToDone(herdr, world, "01");
  expect(await herdr.control<string | null>("workspaceLabel", "w1")).toBe(POOL);

  await retitle(server, "Jev as the grader");
  const rename = await herdr.waitForCall((call) => call.method === "workspace.rename");
  await until(() => rememberedWorkspace(world), (got) => (got as { label?: string }).label === "Jev as the grader", {
    what: "the record to carry the new label",
  });

  expect(rename.params).toEqual({ workspace_id: "w1", label: "Jev as the grader" });
  expect(await herdr.control<string | null>("workspaceLabel", "w1")).toBe("Jev as the grader");
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w1", created: true, label: "Jev as the grader" });
});

conformance("herdr", "relabelling a workspace the daemon no longer holds is logged and the server carries on", async (t) => {
  const world = terminalWorld(t, { tickets: [readyTicket("01", "Workspaces")] });
  const herdr = await fakeHerdr(t, world);
  const server = await t.start(world, { herdr });
  await runToDone(herdr, world, "01");
  await herdr.control("removeWorkspace", "w1");

  await retitle(server, "New title");
  const log = await untilLogged(server, "New title", 'Pool workspace w1 could not be relabelled "New title"');

  expect(log.some((line) => line.includes("no such workspace w1"))).toBe(true);
  expect((await server.http.get("/api/state")).status).toBe(200);
  expect(rememberedWorkspace(world)).toEqual({ workspace_id: "w1", created: true, label: POOL });
});

conformance("herdr", "a workspace that cannot be re-resolved after a refused tab sends that Attempt headless", async (t) => {
  const world = terminalWorld(t, {
    tickets: [readyTicket("01", "First"), readyTicket("02", "Second", "01")],
  });
  const herdr = await fakeHerdr(t, world, ["w-launch"]);
  const server = await t.start(world, { herdr, env: LAUNCH });
  await answerPrompt(herdr, "01", doneOutcome(), {
    before: async () => {
      await herdr.control("removeWorkspace", "w-launch");
      await herdr.control("fail", "workspace.create", true);
    },
  });
  await untilTicketStatus(world, "02", "done");

  // 01's tab, then 02's, refused; no tab is tried anywhere else.
  expect(callsOf(herdr, "tab.create").map((call) => call.params.workspace_id)).toEqual(["w-launch", "w-launch"]);
  expect(callsOf(herdr, "workspace.get").map((call) => call.params.workspace_id)).toContain("w-launch");
  expect(callsOf(herdr, "workspace.create")).toHaveLength(1);
  expect(
    (await poolLog(server)).some((line) => line.startsWith("the Pool workspace could not be re-resolved after a refused tab")),
  ).toBe(true);
  const spawned = spawnedPayloads(world, "02")[0]!;
  expect(spawned.pane_id).toBeNull();
  expect(typeof spawned.terminal_error).toBe("string");
  expect(readFileSync(join(world.pool, "issues", "02-t.md"), "utf8").split("\n", 1)[0]).toBe(
    "<!-- state: id=02 blocked-by=01 status=done -->",
  );
});
