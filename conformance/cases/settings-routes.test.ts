/**
 * The Settings and Restart routes (issue #121), seen from outside the server
 * (ADR-0036): the payloads the routes answer, what lands in console.json and
 * in the Machine defaults file under the world's HOME, the snapshot, the
 * herdr calls a title save makes, and what a Restart leaves behind: the
 * farewell on the socket, the exit, and the Boot hand-off.
 *
 * The Boot hand-off is observed through a recording stand-in: the server
 * runs the shim of the checkout its binary sits in, so a case that restarts
 * starts the server from a copy of the binary in a checkout whose shim is
 * the recorder (harness/boot-recorder.ts). The recorder notes its argv and
 * prints one line, which lands in the pool's runs/boot.log, and starts
 * nothing.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig, RestartResponse, SettingsResponse } from "../../protocol/wire.ts";
import { bootRecorder, type BootHandOff, type BootRecorder } from "../harness/boot-recorder.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { readConsoleJson, readEvents, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";

const DEFAULTS: PoolConfig = { defaults: { harness: "claude", model: "m" } };
const DONE = "<!-- state: id=01 blocked-by=none status=done -->";
const READY = "<!-- state: id=01 blocked-by=none status=ready -->";
// protocol/protocol.ts CLOSE_STOPPED: how the server closes a socket on its way out.
const CLOSE_STOPPED = { code: 1000, reason: "stopped" };

/** A world whose one Ticket is done already, so the pool settles at once. */
function settledWorld(t: Case, config: Record<string, unknown> = {}): World {
  return t.world({
    tickets: [{ file: "01-a.md", marker: DONE }],
    config: { ...DEFAULTS, ...config } as PoolConfig,
  });
}

async function snapshot(server: CaseServer): Promise<EnrichedSnapshot | null> {
  const answer = await server.http.get("/api/state");
  expect(answer.status).toBe(200);
  return answer.json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
}

/** Wait for the pool to settle: every Ticket done, the final Review raised. */
async function settled(server: CaseServer): Promise<EnrichedSnapshot> {
  return (await until(
    () => snapshot(server),
    (got) => got?.phase === "quiescent",
    { what: "the pool to settle", ms: 30_000 },
  ))!;
}

async function getSettings(server: CaseServer): Promise<SettingsResponse> {
  const answer = await server.http.get("/api/settings");
  expect(answer.status).toBe(200);
  return answer.json<SettingsResponse>();
}

function onDisk(world: World): Record<string, unknown> {
  return readConsoleJson(world.pool) as Record<string, unknown>;
}

function errorOf(answer: { json<T>(): T }): string {
  return answer.json<{ error: string }>().error;
}

/** The Machine defaults file under the world's HOME. */
function machineFile(world: World): string {
  return join(world.home, ".agent-graphs", "defaults.json");
}

// ---------------------------------------------------------------------------
// The Boot hand-off
// ---------------------------------------------------------------------------

/** The `--port` a hand-off's argv carries, or null without one. */
function portArg(argv: string[]): number | null {
  const i = argv.indexOf("--port");
  return i >= 0 ? Number(argv[i + 1]) : null;
}

/**
 * A hand-off is Boot for this pool, unattended, as a relaunch, run by the
 * shim of the checkout the server's binary sits in and from that checkout:
 * not an `agent-console` found on PATH, and not handed the `boot` the shim
 * adds itself.
 */
function expectBootFor(call: BootHandOff, world: World, recorder: BootRecorder): void {
  expect(call.ran).toBe("shim");
  expect(call.cwd).toBe(recorder.checkout);
  expect(call.argv).not.toContain("boot");
  const argv = call.argv;
  const pool = argv.indexOf("--pool");
  expect(pool).toBeGreaterThanOrEqual(0);
  expect(argv[pool + 1]).toBe(world.pool);
  expect(argv).toContain("--yes");
  expect(argv).toContain("--relaunch");
}

/** Wait for the server to exit on its own, and require it exited 0 with the lock released. */
async function exitedCleanly(server: CaseServer, world: World): Promise<void> {
  const code = await until(() => server.exitCode(), (got) => got !== null, {
    what: "the server to exit",
    ms: 30_000,
  });
  expect(code).toBe(0);
  expect(existsSync(join(world.pool, "runs", "server.pid"))).toBe(false);
}

function bootLog(world: World): string {
  const path = join(world.pool, "runs", "boot.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------

// engine/settings-routes.test.ts:119
conformance(
  "config",
  "GET /api/settings › serves the pool's config, the boot-only keys, what this process booted with, and the harnesses",
  async (t) => {
    const world = settledWorld(t, { port: 8790, assign: { "01": { harness: "claude", verify: 2 } } });
    writeFileSync(join(world.home, ".issue-runner"), "harness=opencode\nmodel=oc/flash\n");
    const server = await t.start(world);
    await settled(server);

    const settings = await getSettings(server);

    expect(settings.pool.path).toBe(join(world.pool, "console.json"));
    expect(settings.pool.config).toEqual({
      defaults: { harness: "claude", model: "m" },
      port: 8790,
      assign: { "01": { harness: "claude", verify: 2 } },
    });
    expect(settings.pool.bootOnly).toEqual(["selection", "terminal", "port"]);
    // Pinned to 8790 but started on another port: a Restart would move the Console.
    expect(settings.pool.effective.port).toBe(server.port);
    expect(settings.pool.effective.port).not.toBe(8790);
    expect(settings.pool.effective.terminal).toBeNull();
    expect(settings.pool.effective.stale).toEqual(["port"]);

    expect(settings.machine.path).toBe(machineFile(world));
    expect(settings.machine.defaults).toEqual({ harness: "opencode", model: "oc/flash" });
    expect(settings.machine.own).toEqual({});

    expect(settings.harnesses).toContain("claude");
    expect([...settings.harnesses]).toEqual([...settings.harnesses].sort());
  },
);

// engine/settings-routes.test.ts:160
conformance("config", "GET /api/settings › reports the terminal this process booted with", async (t) => {
  const world = settledWorld(t, { terminal: "herdr" });
  const herdr = await t.herdr(world);
  const server = await t.start(world, { herdr });

  const effective = (await getSettings(server)).pool.effective;
  expect(effective.terminal).toBe("herdr");
  expect(effective.stale).toEqual([]);
});

// engine/settings-routes.test.ts:169
conformance("config", "GET /api/settings › names a boot-only key edited since boot, whoever edited it", async (t) => {
  const world = settledWorld(t, { terminal: "herdr" });
  const herdr = await t.herdr(world);
  const server = await t.start(world, { herdr });
  await settled(server);
  expect((await getSettings(server)).pool.effective.stale).toEqual([]);

  // Saved through the pane.
  expect((await server.http.put("/api/settings/pool", { config: { selection: "human" } })).status).toBe(200);
  expect((await getSettings(server)).pool.effective.stale).toEqual(["selection"]);

  // Edited by hand: terminal dropped, a retired roster added, which is read past.
  writeFileSync(join(world.pool, "console.json"), JSON.stringify({ ...DEFAULTS, roster: "- deepseek" }, null, 2));
  const handEdited = await getSettings(server);
  expect(handEdited.pool.effective.stale).toEqual(["terminal"]);
  expect("roster" in handEdited.pool.config).toBe(false);

  // Put back, the badge clears.
  writeFileSync(join(world.pool, "console.json"), JSON.stringify({ ...DEFAULTS, terminal: "herdr" }, null, 2));
  expect((await getSettings(server)).pool.effective.stale).toEqual([]);
});

// engine/settings-routes.test.ts:205
conformance(
  "config",
  "GET /api/settings › judges the port by where a relaunch would bind, not by the pin alone",
  async (t) => {
    const world = settledWorld(t);
    const server = await t.start(world);
    await settled(server);

    expect((await server.http.put("/api/settings/pool", { config: { port: server.port } })).status).toBe(200);
    expect((await getSettings(server)).pool.effective.stale).toEqual([]);

    expect((await server.http.put("/api/settings/pool", { config: { port: null } })).status).toBe(200);
    expect(onDisk(world).port).toBeUndefined();
    expect((await getSettings(server)).pool.effective.stale).toEqual([]);

    expect((await server.http.put("/api/settings/pool", { config: { port: 8790 } })).status).toBe(200);
    expect((await getSettings(server)).pool.effective.stale).toEqual(["port"]);
  },
);

// ---------------------------------------------------------------------------
// PUT /api/settings/pool
// ---------------------------------------------------------------------------

// engine/settings-routes.test.ts:229
conformance(
  "config",
  "PUT /api/settings/pool › writes the patch, preserves assign, and answers with the whole payload",
  async (t) => {
    const world = settledWorld(t, { assign: { "01": { harness: "claude", verify: 2 } } });
    const server = await t.start(world);
    await settled(server);

    const answer = await server.http.put("/api/settings/pool", {
      config: { defaults: { harness: "claude", model: "m2" }, reviewer: "- deepseek" },
    });
    expect(answer.status).toBe(200);
    const settings = answer.json<SettingsResponse>();

    expect(settings.pool.config).toEqual({
      defaults: { harness: "claude", model: "m2" },
      assign: { "01": { harness: "claude", verify: 2 } },
      reviewer: "- deepseek",
    });
    expect(onDisk(world)).toEqual(settings.pool.config as never);
  },
);

// engine/settings-routes.test.ts:251
conformance(
  "config",
  "PUT /api/settings/pool › takes the whole editable slice with nulls for the empty fields, and keeps the rest of the file",
  async (t) => {
    const world = settledWorld(t, {
      port: 8790,
      terminal: "herdr",
      selection: "human",
      assign: { "01": { harness: "claude", verify: 2 } },
    });
    const herdr = await t.herdr(world);
    const server = await t.start(world, { herdr });
    await settled(server);

    const answer = await server.http.put("/api/settings/pool", {
      config: {
        defaults: { harness: "claude", model: "m", drivers: "" },
        resolver: "none",
        terminal: null,
        port: null,
        selection: null,
        reviewer: "acceptance criteria only",
        checkpoint: null,
      },
    });

    expect(answer.status).toBe(200);
    const expected = {
      defaults: { harness: "claude", model: "m" },
      assign: { "01": { harness: "claude", verify: 2 } },
      resolver: "none",
      reviewer: "acceptance criteria only",
    };
    expect(answer.json<SettingsResponse>().pool.config).toEqual(expected as never);
    expect(onDisk(world)).toEqual(expected);
  },
);

// engine/settings-routes.test.ts:286
conformance(
  "config",
  "PUT /api/settings/pool › removes defaults entirely when every one of its fields is empty",
  async (t) => {
    const world = settledWorld(t);
    const server = await t.start(world);
    await settled(server);

    const answer = await server.http.put("/api/settings/pool", {
      config: { defaults: { harness: "", model: "", drivers: "" } },
    });
    expect(answer.status).toBe(200);
    expect(onDisk(world)).toEqual({});
  },
);

// engine/settings-routes.test.ts:295
conformance(
  "config",
  "PUT /api/settings/pool › refuses a harness the pool does not know with a 400 that names the field",
  async (t) => {
    const world = settledWorld(t);
    const server = await t.start(world);
    await settled(server);
    const before = onDisk(world);

    const answer = await server.http.put("/api/settings/pool", {
      config: { defaults: { harness: "gpt", model: "m" } },
    });

    expect(answer.status).toBe(400);
    expect(errorOf(answer)).toContain("defaults.harness");
    expect(onDisk(world)).toEqual(before);
  },
);

// engine/settings-routes.test.ts:308
conformance("config", "PUT /api/settings/pool › refuses a body without a config object", async (t) => {
  const world = settledWorld(t);
  const server = await t.start(world);
  await settled(server);

  const answer = await server.http.put("/api/settings/pool", { config: "everything" });
  expect(answer.status).toBe(400);
  expect(errorOf(answer)).toContain("config");
});

// ---------------------------------------------------------------------------
// The Pool title (issue #100)
// ---------------------------------------------------------------------------

// engine/settings-routes.test.ts:317
conformance(
  "config",
  "the Pool title (issue #100) › carries the title on every snapshot, and null when the pool has none",
  async (t) => {
    const titledWorld = settledWorld(t, { title: "Jev as the grader" });
    const titled = await t.start(titledWorld);
    expect((await settled(titled)).poolTitle).toBe("Jev as the grader");

    const untitledWorld = settledWorld(t);
    const untitled = await t.start(untitledWorld);
    const state = await settled(untitled);
    expect(state.poolTitle).toBeNull();
    expect(state.poolName).toBeTruthy();
  },
);

// engine/settings-routes.test.ts:325
conformance(
  "config",
  "the Pool title (issue #100) › saves a title as one line and shows it at once, with no boundary to wait for",
  async (t) => {
    const world = settledWorld(t, { title: "Old title" });
    const server = await t.start(world);
    await settled(server);

    const answer = await server.http.put("/api/settings/pool", { config: { title: "  New\n  title " } });
    expect(answer.status).toBe(200);
    expect(onDisk(world).title).toBe("New title");
    // Not a boot-only key: nothing is badged for a Restart.
    expect(answer.json<SettingsResponse>().pool.effective.stale).toEqual([]);
    expect((await snapshot(server))?.poolTitle).toBe("New title");

    // Cleared, the key goes and the snapshot falls back to null.
    expect((await server.http.put("/api/settings/pool", { config: { title: null } })).status).toBe(200);
    expect("title" in onDisk(world)).toBe(false);
    expect((await snapshot(server))?.poolTitle).toBeNull();
  },
);

// engine/settings-routes.test.ts:343
conformance(
  "config",
  "the Pool title (issue #100) › relabels the Pool workspace the Console created when the title is saved",
  async (t) => {
    // 01 ready, so the terminal-backed run opens the Pool workspace.
    const world = t.world({
      tickets: [{ file: "01-a.md", marker: READY }],
      config: { ...DEFAULTS, terminal: "herdr", title: "Old title" } as PoolConfig,
    });
    const herdr = await t.herdr(world);
    const server = await t.start(world, { herdr });

    const created = await herdr.waitForCall((call) => call.method === "workspace.create", { ms: 30_000 });
    expect(created.params.label).toBe("Old title");
    const [workspaceId] = await herdr.control<string[]>("workspaceIds");
    expect(workspaceId).toBeDefined();

    const from = herdr.calls.length;
    expect((await server.http.put("/api/settings/pool", { config: { title: "New title" } })).status).toBe(200);
    const rename = await herdr.waitForCall((call) => call.method === "workspace.rename", { from, ms: 15_000 });
    expect(rename.params).toMatchObject({ workspace_id: workspaceId, label: "New title" });
    await until(
      () => herdr.control<string | null>("workspaceLabel", workspaceId),
      (label) => label === "New title",
      { what: "the workspace relabel" },
    );
  },
);

// engine/settings-routes.test.ts:356
conformance("config", "the Pool title (issue #100) › refuses a title that is not a string", async (t) => {
  const world = settledWorld(t);
  const server = await t.start(world);
  await settled(server);

  const answer = await server.http.put("/api/settings/pool", { config: { title: 7 } });
  expect(answer.status).toBe(400);
  expect(errorOf(answer)).toContain("title");
});

// ---------------------------------------------------------------------------
// The Spawn caps (issue #149)
// ---------------------------------------------------------------------------

// engine/settings-routes.test.ts:365
conformance(
  "spawns",
  "the Spawn caps (issue #149) › carries the caps and this run's count on every snapshot, the defaults when unset",
  async (t) => {
    const world = settledWorld(t);
    const server = await t.start(world);
    const state = await settled(server);
    expect(state.spawnUsage).toEqual({ spawnedThisRun: 0, perAttempt: 5, perRun: 20 });
  },
);

// engine/settings-routes.test.ts:376
conformance(
  "config",
  "the Spawn caps (issue #149) › applies a saved cap to a settled pool at once, with no Restart badge",
  async (t) => {
    const world = settledWorld(t);
    const server = await t.start(world);
    await settled(server);

    const answer = await server.http.put("/api/settings/pool", {
      config: { spawnCaps: { perAttempt: "8", perRun: 30 } },
    });

    expect(answer.status).toBe(200);
    expect(onDisk(world).spawnCaps).toEqual({ perAttempt: 8, perRun: 30 });
    expect(answer.json<SettingsResponse>().pool.effective.stale).toEqual([]);
    // On the very next snapshot, with no boundary to wait for.
    expect((await snapshot(server))?.spawnUsage).toEqual({ spawnedThisRun: 0, perAttempt: 8, perRun: 30 });
  },
);

// engine/settings-routes.test.ts:395
conformance(
  "config",
  "the Spawn caps (issue #149) › saves Steward may Close checkpoints and serves it back, refusing a non-boolean",
  async (t) => {
    const world = settledWorld(t);
    const server = await t.start(world);
    await settled(server);

    const on = await server.http.put("/api/settings/pool", { config: { steward: { budget: "2", mayClose: true } } });
    expect(on.status).toBe(200);
    expect(onDisk(world).steward).toEqual({ budget: 2, mayClose: true });
    expect((await getSettings(server)).pool.config.steward).toEqual({ budget: 2, mayClose: true });

    const off = await server.http.put("/api/settings/pool", { config: { steward: { budget: 2 } } });
    expect(off.status).toBe(200);
    expect((await getSettings(server)).pool.config.steward).toEqual({ budget: 2 });

    const bad = await server.http.put("/api/settings/pool", { config: { steward: { mayClose: "on" } } });
    expect(bad.status).toBe(400);
    expect(errorOf(bad)).toContain("steward.mayClose");
  },
);

// engine/settings-routes.test.ts:413
conformance(
  "config",
  "the Spawn caps (issue #149) › refuses a cap that is not a whole number of 0 or more with a 400 naming the field",
  async (t) => {
    const world = settledWorld(t);
    const server = await t.start(world);
    await settled(server);

    const answer = await server.http.put("/api/settings/pool", { config: { spawnCaps: { perRun: -3 } } });
    expect(answer.status).toBe(400);
    expect(errorOf(answer)).toContain("spawnCaps.perRun");
  },
);

// ---------------------------------------------------------------------------
// PUT /api/settings/machine
// ---------------------------------------------------------------------------

// engine/settings-routes.test.ts:424
conformance(
  "config",
  "PUT /api/settings/machine › writes the injected file and answers with the whole payload",
  async (t) => {
    const world = settledWorld(t);
    const server = await t.start(world);
    await settled(server);
    expect(existsSync(machineFile(world))).toBe(false);

    const answer = await server.http.put("/api/settings/machine", {
      defaults: { harness: "claude", model: "opus", terminal: "herdr" },
    });

    expect(answer.status).toBe(200);
    const settings = answer.json<SettingsResponse>();
    expect(settings.machine.own).toEqual({ harness: "claude", model: "opus", terminal: "herdr" });
    expect(JSON.parse(readFileSync(machineFile(world), "utf8"))).toEqual(settings.machine.own as never);
  },
);

// engine/settings-routes.test.ts:442
conformance(
  "config",
  "PUT /api/settings/machine › refuses an illegal terminal with a 400 and leaves the file alone",
  async (t) => {
    const world = settledWorld(t);
    const server = await t.start(world);
    await settled(server);

    const answer = await server.http.put("/api/settings/machine", {
      defaults: { harness: "claude", terminal: "tmux" },
    });
    expect(answer.status).toBe(400);
    expect(errorOf(answer)).toContain("terminal");
    expect(existsSync(machineFile(world))).toBe(false);
  },
);

// ---------------------------------------------------------------------------
// POST /api/restart (#121)
// ---------------------------------------------------------------------------

/** A world whose 01 is held running by its stub until `release` appears (ten seconds at most). */
function heldWorld(t: Case): { world: World; release: string } {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: READY }], config: DEFAULTS });
  const release = join(world.root, "release-01");
  world.stubs.script("01", { waitFor: release });
  return { world, release };
}

async function running(server: CaseServer): Promise<void> {
  await until(
    () => snapshot(server),
    (got) => got?.phase === "running" && got.state.tickets.find((x) => x.id === "01")?.liveAttempt != null,
    { what: "01's Attempt to be in flight", ms: 20_000 },
  );
}

// engine/settings-routes.test.ts:457
conformance(
  "server",
  "POST /api/restart (#121) › is accepted before the pool has started, where a stop is refused",
  async (t) => {
    // The command line starts the pool as it binds, so a pool that is not
    // done stands in for one not started: Stop refuses it, Restart does not.
    const { world } = heldWorld(t);
    const recorder = bootRecorder(world);
    const server = await t.start(world, recorder.start);
    await running(server);

    const stop = await server.http.post("/api/stop");
    expect(stop.status).toBe(409);

    const restart = await server.http.post("/api/restart");
    expect(restart.status).toBe(202);

    await exitedCleanly(server, world);
    const [call] = await recorder.handOffs(1);
    expectBootFor(call!, world, recorder);
    expect(bootLog(world)).toContain("boot recorder:");
  },
);

// engine/settings-routes.test.ts:469
conformance(
  "server",
  "POST /api/restart (#121) › is accepted while an attempt is in flight",
  async (t) => {
    const { world } = heldWorld(t);
    const recorder = bootRecorder(world);
    const server = await t.start(world, recorder.start);
    await running(server);
    const spawned = await until(
      () => readEvents(world.pool, "01").find((event) => event.kind === "spawned"),
      (event) => event !== undefined,
      { what: "01's spawned event" },
    );
    const pid = (spawned!.payload as { pid: number }).pid;

    const answer = await server.http.post("/api/restart");
    expect(answer.status).toBe(202);

    await exitedCleanly(server, world);
    // The headless harness was stopped with the server, well before its own
    // ten-second wait could have ended it.
    await until(
      () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      (alive) => !alive,
      { what: `the stub harness (pid ${pid}) to be stopped`, ms: 5_000 },
    );
    const [call] = await recorder.handOffs(1);
    expectBootFor(call!, world, recorder);
  },
);

// engine/settings-routes.test.ts:503
conformance(
  "server",
  "POST /api/restart (#121) › names the pinned port a relaunch will bind, and this server's own when nothing is pinned",
  async (t) => {
    const pinnedWorld = settledWorld(t, { port: 8790 });
    const pinnedBoot = bootRecorder(pinnedWorld);
    const pinned = await t.start(pinnedWorld, pinnedBoot.start);
    await settled(pinned);
    const res = await pinned.http.post("/api/restart");
    expect(res.status).toBe(202);
    expect(res.json<RestartResponse>()).toEqual({ ok: true, port: 8790 });

    const freeWorld = settledWorld(t);
    const freeBoot = bootRecorder(freeWorld);
    const free = await t.start(freeWorld, freeBoot.start);
    await settled(free);
    const own = await free.http.post("/api/restart");
    expect(own.status).toBe(202);
    expect(own.json<RestartResponse>()).toEqual({ ok: true, port: free.port });

    // Boot is handed the same port the tab was promised.
    await exitedCleanly(pinned, pinnedWorld);
    await exitedCleanly(free, freeWorld);
    const [pinnedCall] = await pinnedBoot.handOffs(1);
    const [freeCall] = await freeBoot.handOffs(1);
    expect(portArg(pinnedCall!.argv)).toBe(8790);
    expect(portArg(freeCall!.argv)).toBe(free.port);
  },
);

// engine/settings-routes.test.ts:527
conformance(
  "server",
  "POST /api/restart (#121) › names a port saved through the pane, not the one this process booted with",
  async (t) => {
    const world = settledWorld(t);
    const recorder = bootRecorder(world);
    const server = await t.start(world, recorder.start);
    await settled(server);

    expect((await server.http.put("/api/settings/pool", { config: { port: 8791 } })).status).toBe(200);
    const answer = await server.http.post("/api/restart");
    expect(answer.json<RestartResponse>()).toEqual({ ok: true, port: 8791 });
    await exitedCleanly(server, world);
  },
);

// engine/settings-routes.test.ts:539
conformance(
  "server",
  "POST /api/restart (#121) › lets a pin saved through the pane outrank the port this process was started with",
  async (t) => {
    // Every case's server is started with --port and no pin in console.json.
    const world = settledWorld(t);
    const recorder = bootRecorder(world);
    const server = await t.start(world, recorder.start);
    await settled(server);
    expect(server.port).not.toBe(8795);

    expect((await server.http.put("/api/settings/pool", { config: { port: 8795 } })).status).toBe(200);
    const answer = await server.http.post("/api/restart");
    expect(answer.json<RestartResponse>()).toEqual({ ok: true, port: 8795 });
    await exitedCleanly(server, world);
  },
);

// engine/settings-routes.test.ts:565
conformance(
  "server",
  "POST /api/restart (#121) › hands a restart to onRestartRequested exactly once, even on a double POST",
  async (t) => {
    const world = settledWorld(t);
    const recorder = bootRecorder(world);
    const server = await t.start(world, recorder.start);
    await settled(server);

    const first = await server.http.post("/api/restart");
    const second = await server.http.post("/api/restart");
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    // One stop: a clean exit 0. One relaunch: a single Boot hand-off.
    await exitedCleanly(server, world);
    await Bun.sleep(1_000);
    expect(await recorder.handOffs(1)).toHaveLength(1);
  },
);

// engine/settings-routes.test.ts:586
conformance(
  "server",
  "POST /api/restart (#121) › sends the farewell `stopped` snapshot and closes the socket",
  async (t) => {
    const world = settledWorld(t);
    const recorder = bootRecorder(world);
    const server = await t.start(world, recorder.start);
    await settled(server);

    const tab = await t.socket(server);
    await tab.sync();

    const answer = await server.http.post("/api/restart");
    expect(answer.status).toBe(202);

    expect(await tab.closed).toEqual(CLOSE_STOPPED);
    expect(tab.pushed?.snapshot.phase).toBe("stopped");

    await exitedCleanly(server, world);
    let refused = false;
    try {
      await fetch(`${server.url}/api/state`);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  },
);
