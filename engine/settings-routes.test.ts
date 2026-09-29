/// <reference types="bun" />

/**
 * The Settings and Restart routes (issue #121). The Console's Settings pane
 * is a second way to edit the pool's own config file, never a second copy of
 * it, so these cases are mostly about what a write leaves alone. Restart is
 * the Stop route's twin with one deliberate difference: any phase may take
 * it, because a Restart is how a live run picks up a boot-only setting.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoolServer, type PoolServer } from "./server.ts";
import type { PoolConfig } from "./engine.ts";
import type { SettingsResponse } from "./pool-settings.ts";
import type { MachineDefaults, MachineDefaultsPaths } from "./machine-defaults.ts";
import {
  STUB_DEFAULTS,
  cleanupPools,
  makePool,
  registerTempDir,
  stubHarness,
} from "./pool-fixture.ts";
import { makeTempDir } from "./tmp.ts";
import { startExecutingFakeHerdr, type ExecutingFakeHerdr } from "./herdr-executing-fake.ts";

const servers: PoolServer[] = [];
const fakes: ExecutingFakeHerdr[] = [];

afterEach(async () => {
  await cleanupPools(servers);
  while (fakes.length > 0) await fakes.pop()!.close();
});

const READY = "<!-- state: id=01 blocked-by=none status=ready -->";

/** A temp home for the Machine defaults, so no test reads or writes the
 *  developer's own `~/.agent-graphs/defaults.json`. */
function machineHome(): MachineDefaultsPaths {
  const home = makeTempDir("machine-home-");
  registerTempDir(home);
  return {
    file: join(home, "defaults.json"),
    issueRunner: join(home, ".issue-runner"),
    consoleRunner: join(home, ".console-runner"),
  };
}

interface Rig {
  poolDir: string;
  server: PoolServer;
  machine: MachineDefaultsPaths;
  herdr: ExecutingFakeHerdr;
}

async function startRig(
  config: Partial<PoolConfig> = {},
  options: { onRestartRequested?: (port: number) => void; start?: boolean } = {},
): Promise<Rig> {
  const poolDir = makePool({
    tickets: [{ file: "01-a.md", marker: READY }],
    config: { ...STUB_DEFAULTS, ...config },
  });
  const machine = machineHome();
  // Every rig gets its own herdr: a `terminal: herdr` rig left on the default
  // socket would open real workspaces and tabs in the operator's daemon.
  const fake = await startExecutingFakeHerdr();
  fakes.push(fake);
  const server = createPoolServer({
    poolDir,
    port: 0,
    herdrSocket: fake.socketPath,
    harnesses: stubHarness(poolDir, {}).harnesses,
    distDir: "/nonexistent",
    registryPath: join(poolDir, "fleet.json"),
    machineDefaultsPaths: machine,
    ...(options.onRestartRequested
      ? { onRestartRequested: options.onRestartRequested }
      : {}),
  });
  servers.push(server);
  if (options.start !== false) {
    await server.start();
    await server.settled();
  }
  return { poolDir, server, machine, herdr: fake };
}

function onDisk(poolDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(poolDir, "console.json"), "utf8"));
}

async function getSettings(server: PoolServer): Promise<SettingsResponse> {
  const res = await fetch(`${server.url}/api/settings`);
  expect(res.status).toBe(200);
  return (await res.json()) as SettingsResponse;
}

function putJson(server: PoolServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Read a snapshot stream to its end, or until the deadline. */
async function drainStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 10_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return text;
    const step = await Promise.race([
      reader.read().then(
        (r) => (r.done ? ({ kind: "end" } as const) : ({ kind: "chunk", value: r.value } as const)),
        () => ({ kind: "end" }) as const,
      ),
      Bun.sleep(left).then(() => ({ kind: "end" }) as const),
    ]);
    if (step.kind !== "chunk") return text;
    text += decoder.decode(step.value, { stream: true });
  }
}

describe("GET /api/settings", () => {
  it("serves the pool's config, the boot-only keys, what this process booted with, and the harnesses", async () => {
    const { poolDir, server, machine } = await startRig({
      port: 8790,
      terminal: undefined,
      assign: { "01": { harness: "stub", verify: 2 } },
    });
    writeFileSync(machine.issueRunner, "harness=opencode\nmodel=oc/flash\n");

    const settings = await getSettings(server);

    expect(settings.pool.path).toBe(join(poolDir, "console.json"));
    expect(settings.pool.config).toEqual({
      defaults: { harness: "stub", model: "m" },
      port: 8790,
      assign: { "01": { harness: "stub", verify: 2 } },
    });
    expect(settings.pool.bootOnly).toEqual([
      "roster",
      "agents",
      "selection",
      "terminal",
      "port",
    ]);
    // The saved port is 8790 and this process bound an ephemeral one, which
    // is exactly the disagreement the pane badges as "on the next Restart".
    expect(settings.pool.effective.port).toBe(Number(new URL(server.url).port));
    expect(settings.pool.effective.port).not.toBe(8790);
    expect(settings.pool.effective.terminal).toBeNull();
    // The saved pin is not the port this process bound, so a Restart would
    // move the Console and the pane says so.
    expect(settings.pool.effective.stale).toEqual(["port"]);

    // The machine half: the legacy file behind the JSON one, and the JSON
    // file's own fields (none yet) reported separately, because the pane
    // writes back only its own.
    expect(settings.machine.path).toBe(machine.file);
    expect(settings.machine.defaults).toEqual({ harness: "opencode", model: "oc/flash" });
    expect(settings.machine.own).toEqual({});

    expect(settings.harnesses).toContain("stub");
    expect([...settings.harnesses]).toEqual([...settings.harnesses].sort());
  });

  it("reports the terminal this process booted with", async () => {
    const { server } = await startRig({ terminal: "herdr" }, { start: false });
    const effective = (await getSettings(server)).pool.effective;
    expect(effective.terminal).toBe("herdr");
    expect(effective.stale).toEqual([]);
  });

  // The badge has to outlive the tab that earned it: a reload, a second tab,
  // and a hand edit of the file all owe the operator the same answer.
  it("names a boot-only key edited since boot, whoever edited it", async () => {
    const { poolDir, server } = await startRig({ terminal: "herdr" });
    expect((await getSettings(server)).pool.effective.stale).toEqual([]);

    // Saved through the pane.
    expect(
      (await putJson(server, "/api/settings/pool", { config: { selection: "human" } })).status,
    ).toBe(200);
    expect((await getSettings(server)).pool.effective.stale).toEqual(["selection"]);

    // Edited by hand, which no save in this tab could have told the Console
    // about. Dropping terminal is stale even though the run is still
    // terminal-backed: that is precisely what a Restart would change.
    writeFileSync(
      join(poolDir, "console.json"),
      JSON.stringify({ ...STUB_DEFAULTS, roster: "- deepseek" }, null, 2),
    );
    expect((await getSettings(server)).pool.effective.stale).toEqual([
      "roster",
      "terminal",
    ]);

    // Putting it back is not stale, so the badge clears rather than latching.
    writeFileSync(
      join(poolDir, "console.json"),
      JSON.stringify({ ...STUB_DEFAULTS, terminal: "herdr" }, null, 2),
    );
    expect((await getSettings(server)).pool.effective.stale).toEqual([]);
  });

  // The port is judged by where a Restart would actually put the Console,
  // not by whether the pin changed: pinning the port the pool already runs
  // on moves nothing, and clearing a pin moves nothing either, because the
  // Restart pins what it is running on so the tab finds it again. A cleared
  // pin takes effect at the next cold Boot instead.
  it("judges the port by where a relaunch would bind, not by the pin alone", async () => {
    const { poolDir, server } = await startRig();
    const bound = Number(new URL(server.url).port);

    expect(
      (await putJson(server, "/api/settings/pool", { config: { port: bound } })).status,
    ).toBe(200);
    expect((await getSettings(server)).pool.effective.stale).toEqual([]);

    expect((await putJson(server, "/api/settings/pool", { config: { port: null } })).status).toBe(
      200,
    );
    expect(onDisk(poolDir).port).toBeUndefined();
    expect((await getSettings(server)).pool.effective.stale).toEqual([]);

    // A pin that is not the running port is the case the badge exists for.
    expect((await putJson(server, "/api/settings/pool", { config: { port: 8790 } })).status).toBe(
      200,
    );
    expect((await getSettings(server)).pool.effective.stale).toEqual(["port"]);
  });
});

describe("PUT /api/settings/pool", () => {
  it("writes the patch, preserves assign, and answers with the whole payload", async () => {
    const { poolDir, server } = await startRig({
      assign: { "01": { harness: "stub", verify: 2 } },
    });

    const res = await putJson(server, "/api/settings/pool", {
      config: { defaults: { harness: "stub", model: "m2" }, roster: "- deepseek" },
    });
    expect(res.status).toBe(200);
    const settings = (await res.json()) as SettingsResponse;

    expect(settings.pool.config).toEqual({
      defaults: { harness: "stub", model: "m2" },
      assign: { "01": { harness: "stub", verify: 2 } },
      roster: "- deepseek",
    });
    expect(onDisk(poolDir)).toEqual(settings.pool.config as never);
  });

  // The Console sends the whole editable slice on every save, null for every
  // field the operator left empty, so this is the request shape in practice
  // rather than a sparse patch.
  it("takes the whole editable slice with nulls for the empty fields, and keeps the rest of the file", async () => {
    const { poolDir, server } = await startRig({
      port: 8790,
      terminal: "herdr",
      roster: "- deepseek",
      selection: "human",
      assign: { "01": { harness: "stub", verify: 2 } },
    });

    const res = await putJson(server, "/api/settings/pool", {
      config: {
        defaults: { harness: "stub", model: "m", drivers: "" },
        resolver: "none",
        terminal: null,
        port: null,
        selection: null,
        roster: null,
        agents: null,
        reviewer: "acceptance criteria only",
        checkpoint: null,
      },
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as SettingsResponse).pool.config).toEqual({
      defaults: { harness: "stub", model: "m" },
      assign: { "01": { harness: "stub", verify: 2 } },
      resolver: "none",
      reviewer: "acceptance criteria only",
    });
    expect(onDisk(poolDir)).toEqual({
      defaults: { harness: "stub", model: "m" },
      assign: { "01": { harness: "stub", verify: 2 } },
      resolver: "none",
      reviewer: "acceptance criteria only",
    });
  });

  it("removes defaults entirely when every one of its fields is empty", async () => {
    const { poolDir, server } = await startRig();
    const res = await putJson(server, "/api/settings/pool", {
      config: { defaults: { harness: "", model: "", drivers: "" } },
    });
    expect(res.status).toBe(200);
    expect(onDisk(poolDir)).toEqual({});
  });

  it("refuses a harness the pool does not know with a 400 that names the field", async () => {
    const { poolDir, server } = await startRig();
    const before = onDisk(poolDir);

    const res = await putJson(server, "/api/settings/pool", {
      config: { defaults: { harness: "gpt", model: "m" } },
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("defaults.harness");
    expect(onDisk(poolDir)).toEqual(before);
  });

  it("refuses a body without a config object", async () => {
    const { server } = await startRig();
    const res = await putJson(server, "/api/settings/pool", { config: "everything" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("config");
  });
});

describe("the Pool title (issue #100)", () => {
  it("carries the title on every snapshot, and null when the pool has none", async () => {
    const titled = await startRig({ title: "Jev as the grader" });
    expect(titled.server.latest?.poolTitle).toBe("Jev as the grader");
    const untitled = await startRig();
    expect(untitled.server.latest?.poolTitle).toBeNull();
    expect(untitled.server.latest?.poolName).toBeTruthy();
  });

  it("saves a title as one line and shows it at once, with no boundary to wait for", async () => {
    const { poolDir, server } = await startRig({ title: "Old title" });

    const res = await putJson(server, "/api/settings/pool", {
      config: { title: "  New\n  title " },
    });
    expect(res.status).toBe(200);
    expect(onDisk(poolDir).title).toBe("New title");
    // Not a boot-only key: nothing is badged for a Restart.
    expect(((await res.json()) as SettingsResponse).pool.effective.stale).toEqual([]);
    expect(server.latest?.poolTitle).toBe("New title");

    // Cleared, the key goes and the Console falls back to the directory.
    await putJson(server, "/api/settings/pool", { config: { title: null } });
    expect("title" in onDisk(poolDir)).toBe(false);
    expect(server.latest?.poolTitle).toBeNull();
  });

  it("relabels the Pool workspace the Console created when the title is saved", async () => {
    const { server, herdr } = await startRig({ terminal: "herdr", title: "Old title" });
    const created = herdr.requests.find((r) => r.method === "workspace.create");
    expect(created?.params.label).toBe("Old title");
    const workspaceId = herdr.workspaceIds()[0]!;

    await putJson(server, "/api/settings/pool", { config: { title: "New title" } });
    await waitFor(
      () => herdr.workspaceLabel(workspaceId) === "New title",
      "the workspace relabel",
    );
  });

  it("refuses a title that is not a string", async () => {
    const { server } = await startRig();
    const res = await putJson(server, "/api/settings/pool", { config: { title: 7 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("title");
  });
});

describe("the Spawn caps (issue #149)", () => {
  it("carries the caps and this run's count on every snapshot, the defaults when unset", async () => {
    const { server } = await startRig();
    expect(server.latest?.spawnUsage).toEqual({
      spawnedThisRun: 0,
      perAttempt: 5,
      perRun: 20,
    });
  });

  // A settled pool reaches no super-step boundary, so the save itself asks
  // the run to reload: the new caps are on the snapshot before the answer.
  it("applies a saved cap to a settled pool at once, with no Restart badge", async () => {
    const { poolDir, server } = await startRig();

    const res = await putJson(server, "/api/settings/pool", {
      config: { spawnCaps: { perAttempt: "8", perRun: 30 } },
    });

    expect(res.status).toBe(200);
    expect(onDisk(poolDir).spawnCaps).toEqual({ perAttempt: 8, perRun: 30 });
    expect(((await res.json()) as SettingsResponse).pool.effective.stale).toEqual([]);
    expect(server.latest?.spawnUsage).toEqual({
      spawnedThisRun: 0,
      perAttempt: 8,
      perRun: 30,
    });
  });

  it("refuses a cap that is not a positive integer with a 400 naming the field", async () => {
    const { server } = await startRig();
    const res = await putJson(server, "/api/settings/pool", {
      config: { spawnCaps: { perRun: -3 } },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("spawnCaps.perRun");
  });
});

describe("PUT /api/settings/machine", () => {
  it("writes the injected file and answers with the whole payload", async () => {
    const { server, machine } = await startRig();
    expect(existsSync(machine.file)).toBe(false);

    const res = await putJson(server, "/api/settings/machine", {
      defaults: { harness: "claude", model: "opus", terminal: "herdr" } satisfies MachineDefaults,
    });

    expect(res.status).toBe(200);
    const settings = (await res.json()) as SettingsResponse;
    expect(settings.machine.own).toEqual({
      harness: "claude",
      model: "opus",
      terminal: "herdr",
    });
    expect(JSON.parse(readFileSync(machine.file, "utf8"))).toEqual(settings.machine.own as never);
  });

  it("refuses an illegal terminal with a 400 and leaves the file alone", async () => {
    const { server, machine } = await startRig();
    const res = await putJson(server, "/api/settings/machine", {
      defaults: { harness: "claude", terminal: "tmux" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("terminal");
    expect(existsSync(machine.file)).toBe(false);
  });
});

describe("POST /api/restart (#121)", () => {
  // Stop refuses every phase but done, because any other phase may have work
  // in flight. Restart is the opposite: it exists to bring a live pool back
  // on new boot-only settings, and the operator has already confirmed.
  it("is accepted before the pool has started, where a stop is refused", async () => {
    let restarts = 0;
    const { server } = await startRig({}, { start: false, onRestartRequested: () => { restarts += 1; } });

    const stop = await fetch(`${server.url}/api/stop`, { method: "POST" });
    expect(stop.status).toBe(409);

    const restart = await fetch(`${server.url}/api/restart`, { method: "POST" });
    expect(restart.status).toBe(202);
    await waitFor(() => restarts > 0, "the restart callback to fire");
  });

  it("is accepted while an attempt is in flight", async () => {
    let restarts = 0;
    const poolDir = makePool({
      tickets: [{ file: "01-a.md", marker: READY }],
      config: STUB_DEFAULTS,
    });
    const sentinel = join(poolDir, "go");
    const server = createPoolServer({
      poolDir,
      port: 0,
      harnesses: stubHarness(poolDir, { "01": { waitFor: sentinel } }).harnesses,
      distDir: "/nonexistent",
      registryPath: join(poolDir, "fleet.json"),
      machineDefaultsPaths: machineHome(),
      onRestartRequested: () => {
        restarts += 1;
      },
    });
    servers.push(server);
    await server.start();
    await waitFor(() => server.latest?.phase === "running", "the attempt to be in flight");

    const res = await fetch(`${server.url}/api/restart`, { method: "POST" });
    expect(res.status).toBe(202);
    await waitFor(() => restarts > 0, "the restart callback to fire");

    // Release the held attempt rather than leaving a live harness for the
    // teardown to race; the callback owns the stop, so this server is still up.
    writeFileSync(sentinel, "go");
    expect((await fetch(`${server.url}/api/state`)).status).toBe(200);
  }, 20_000);

  // The port is the one thing a reconnecting tab cannot work out for itself:
  // a Restart is how a newly pinned port takes effect, so the reply names it.
  it("names the pinned port a relaunch will bind, and this server's own when nothing is pinned", async () => {
    const handed: number[] = [];
    const record = (port: number): void => {
      handed.push(port);
    };

    const pinned = await startRig({ port: 8790 }, { onRestartRequested: record });
    const res = await fetch(`${pinned.server.url}/api/restart`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, port: 8790 });

    const free = await startRig({}, { onRestartRequested: record });
    const own = await fetch(`${free.server.url}/api/restart`, { method: "POST" });
    const ownPort = Number(new URL(free.server.url).port);
    expect(await own.json()).toEqual({ ok: true, port: ownPort });

    // The handover is given the same number the tab was promised, so Boot
    // cannot come back on a port nobody is watching.
    await waitFor(() => handed.length === 2, "both restart callbacks to fire");
    expect(handed).toEqual([8790, ownPort]);
  });

  // A port saved through the pane a moment ago is the port the relaunch will
  // bind, so the answer reads the file rather than this process's memory.
  it("names a port saved through the pane, not the one this process booted with", async () => {
    const { server } = await startRig({}, { onRestartRequested: () => {} });
    expect((await putJson(server, "/api/settings/pool", { config: { port: 8791 } })).status).toBe(
      200,
    );
    const res = await fetch(`${server.url}/api/restart`, { method: "POST" });
    expect(await res.json()).toEqual({ ok: true, port: 8791 });
  });

  // Every Restart hands Boot a --port, so the port this process was started
  // with must not outrank a pin saved since: if it did, a pin saved after the
  // first Restart could never take effect.
  it("lets a pin saved through the pane outrank the port this process was started with", async () => {
    const poolDir = makePool({
      tickets: [{ file: "01-a.md", marker: READY }],
      config: { ...STUB_DEFAULTS },
    });
    const server = createPoolServer({
      poolDir,
      port: 8794,
      harnesses: stubHarness(poolDir, {}).harnesses,
      distDir: "/nonexistent",
      registryPath: join(poolDir, "fleet.json"),
      machineDefaultsPaths: machineHome(),
      onRestartRequested: () => {},
    });
    servers.push(server);
    await server.start();
    await server.settled();
    expect(Number(new URL(server.url).port)).toBe(8794);

    expect((await putJson(server, "/api/settings/pool", { config: { port: 8795 } })).status).toBe(
      200,
    );
    const res = await fetch(`${server.url}/api/restart`, { method: "POST" });
    expect(await res.json()).toEqual({ ok: true, port: 8795 });
  });

  it("hands a restart to onRestartRequested exactly once, even on a double POST", async () => {
    let restarts = 0;
    const { server } = await startRig({}, { onRestartRequested: () => { restarts += 1; } });

    const first = await fetch(`${server.url}/api/restart`, { method: "POST" });
    const second = await fetch(`${server.url}/api/restart`, { method: "POST" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    await waitFor(() => restarts > 0, "the restart callback to fire");
    await Bun.sleep(100);
    expect(restarts).toBe(1);

    // The callback owns the stop, so this server is untouched.
    expect((await fetch(`${server.url}/api/state`)).status).toBe(200);
    expect(server.latest?.phase).not.toBe("stopped");
  });

  // ADR-0019's farewell is owed to a Restart exactly as to a Stop: the tab
  // that asked knows it was a restart, and every other tab sees the same
  // orderly goodbye rather than a dropped connection.
  it("sends the farewell `stopped` snapshot and ends the stream", async () => {
    const { server } = await startRig();

    const stream = await fetch(`${server.url}/api/stream`);
    const reader = stream.body!.getReader();

    const res = await fetch(`${server.url}/api/restart`, { method: "POST" });
    expect(res.status).toBe(202);

    const text = await drainStream(reader);
    expect(text).toContain('"phase":"stopped"');

    // Joining the in-flight stop (shutdown is latched) makes the port
    // assertion exact rather than racy.
    await server.shutdown();
    await expect(fetch(`${server.url}/api/state`)).rejects.toThrow();
  }, 20_000);
});
