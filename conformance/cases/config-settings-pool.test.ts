/**
 * Pool settings (issue #121), seen from outside the server (ADR-0036): what
 * GET /api/settings reads of console.json, and what PUT /api/settings/pool
 * writes there. A save is a patch over the file, never a replacement: keys it
 * does not name, `assign` and keys the pane has never heard of survive it, a
 * key it clears goes, and a value the engine would not accept is refused with
 * 400 { error } naming the field, leaving the file's bytes as they were. The
 * inventory's ticket C20, area `config`; each case names the engine test it
 * came from.
 *
 * Every pool's Tickets are done, so nothing runs under the case. JSON is
 * compared once parsed (ADR-0036).
 */

import { expect } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig, SettingsResponse } from "../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { readConsoleJson } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  consoleText,
  doneTicket,
  errorOf,
  putPool,
  rawConfig,
  restedSnapshot,
  settingsOf,
} from "./config-support.ts";

const DEFAULTS: PoolConfig = { defaults: { harness: "claude", model: "m" } };
const KNOWN = "Known: claude, cursor, opencode";

/**
 * A started pool at rest whose one Ticket is done, on `config` as written
 * (none at all when null). A config naming `terminal: "herdr"` gets a fake
 * herdr, as a terminal-backed pool would have.
 */
async function settledPool(t: Case, config: PoolConfig | null): Promise<{ world: World; server: CaseServer }> {
  const world = t.world({ tickets: [doneTicket("01")], ...(config === null ? {} : { config }) });
  const herdr = config?.terminal === "herdr" ? await t.herdr(world) : undefined;
  const server = await t.start(world, herdr ? { herdr } : {});
  await restedSnapshot(server);
  return { world, server };
}

/** A save that must land: 200, and the answer's pool config is the file. */
async function saved(server: CaseServer, world: World, config: Record<string, unknown>): Promise<SettingsResponse> {
  const answer = await putPool(server, config);
  expect(answer.status, answer.text).toBe(200);
  const settings = answer.json<SettingsResponse>();
  expect(settings.pool.config).toEqual(readConsoleJson(world.pool)!);
  return settings;
}

/** A save that must be refused with 400, leaving console.json's bytes alone. */
async function refused(server: CaseServer, world: World, config: Record<string, unknown>): Promise<string> {
  const before = consoleText(world);
  const answer = await putPool(server, config);
  expect(answer.status, answer.text).toBe(400);
  expect(consoleText(world)).toBe(before);
  return errorOf(answer);
}

// engine/pool-settings.test.ts:37 pool settings › reads an absent file as no config, and the file as it is otherwise
conformance("config", "Pool settings read an absent console.json as no config, and the file as written otherwise", async (t) => {
  const bare = await settledPool(t, null);
  const bareSettings = await settingsOf(bare.server);
  expect(bareSettings.pool.config).toEqual({});
  expect(bareSettings.pool.path).toBe(join(bare.world.pool, "console.json"));

  const written = await settledPool(t, { port: 8790, assign: { "01": { harness: "claude" } } });
  const writtenSettings = await settingsOf(written.server);
  expect(writtenSettings.pool.config).toEqual({ port: 8790, assign: { "01": { harness: "claude" } } });
  expect(writtenSettings.pool.path).toBe(join(written.world.pool, "console.json"));
});

// engine/pool-settings.test.ts:48 pool settings › merges a patch over the file, preserving assign and unknown keys
conformance("config", "a Pool settings save merges over the file, keeping assign, the port and keys it does not know", async (t) => {
  const { world, server } = await settledPool(
    t,
    rawConfig({
      ...DEFAULTS,
      assign: { "01": { harness: "claude", verify: 2 } },
      port: 8787,
      somethingElse: { kept: true },
    }),
  );

  await saved(server, world, { defaults: { harness: "claude", model: "opus" }, selection: "human" });

  expect(readConsoleJson(world.pool)).toEqual(
    rawConfig({
      defaults: { harness: "claude", model: "opus" },
      assign: { "01": { harness: "claude", verify: 2 } },
      port: 8787,
      somethingElse: { kept: true },
      selection: "human",
    }),
  );
});

// engine/pool-settings.test.ts:72 pool settings › leaves a key the patch never mentions exactly as it was
conformance("config", "a Pool settings save leaves a key it never mentions exactly as it was", async (t) => {
  const { world, server } = await settledPool(t, { checkpoint: "a device", terminal: "herdr" });

  await saved(server, world, { reviewer: "acceptance criteria only" });

  expect(readConsoleJson(world.pool)).toEqual({
    checkpoint: "a device",
    terminal: "herdr",
    reviewer: "acceptance criteria only",
  });
});

// engine/pool-settings.test.ts:84 pool settings › removes a key the patch clears with null, an empty string or undefined
conformance("config", "a Pool settings save removes a key it clears with null, an empty string or blanks", async (t) => {
  const { world, server } = await settledPool(t, {
    port: 8787,
    terminal: "herdr",
    reviewer: "- deepseek",
    selection: "human",
    assign: { "01": {} },
  });

  // JSON has no undefined: a key sent as undefined is a key not sent.
  await saved(server, world, { port: null, terminal: "", reviewer: "   ", selection: null });

  expect(readConsoleJson(world.pool)).toEqual({ assign: { "01": {} } });
});

// engine/pool-settings.test.ts:105 pool settings › replaces defaults whole, dropping empty fields, and removes an all-empty one
conformance("config", "a Pool settings save replaces defaults whole, trimmed, dropping empty fields, and removes an all-empty one", async (t) => {
  const { world, server } = await settledPool(t, { defaults: { harness: "claude", model: "m", drivers: "implement" } });

  await saved(server, world, { defaults: { harness: "claude", model: "", drivers: " implement " } });
  expect(readConsoleJson(world.pool)).toEqual({ defaults: { harness: "claude", drivers: "implement" } });

  await saved(server, world, { defaults: { harness: "claude", effort: " xhigh " } });
  expect(readConsoleJson(world.pool)).toEqual({ defaults: { harness: "claude", effort: "xhigh" } });

  expect(await refused(server, world, { defaults: { effort: 3 } })).toBe("pool settings: defaults.effort must be a string");

  await saved(server, world, { defaults: { harness: "", model: "" } });
  expect(readConsoleJson(world.pool)).toEqual({});
});

// engine/pool-settings.test.ts:134 pool settings › keeps the resolver's opt-out and its object form, and clears on empty
conformance("config", "a Pool settings save keeps the resolver's opt-out and its object form, and an empty one clears it", async (t) => {
  const { world, server } = await settledPool(t, DEFAULTS);
  const resolver = () => readConsoleJson(world.pool)!.resolver;

  await saved(server, world, { resolver: "none" });
  expect(resolver()).toBe("none");

  await saved(server, world, { resolver: { harness: "opencode", model: "oc/flash" } });
  expect(resolver()).toEqual({ harness: "opencode", model: "oc/flash" });

  await saved(server, world, { resolver: { harness: "opencode", model: "oc/flash", effort: " max " } });
  expect(resolver()).toEqual({ harness: "opencode", model: "oc/flash", effort: "max" });

  expect(await refused(server, world, { resolver: { effort: 1 } })).toBe("pool settings: resolver.effort must be a string");

  await saved(server, world, { resolver: "" });
  expect(readConsoleJson(world.pool)).toEqual(DEFAULTS);
});

// engine/pool-settings.test.ts:160 pool settings › rejects a port that is not an integer in range, naming the field
conformance("config", "a Pool settings save refuses a port that is not a whole number from 1 to 65535, and takes one typed as text", async (t) => {
  const { world, server } = await settledPool(t, { port: 8787 });

  for (const port of [0, 70000, 12.5, "http"]) {
    expect(await refused(server, world, { port })).toBe(`pool settings: port must be an integer 1-65535, got ${port}`);
  }
  expect(readConsoleJson(world.pool)).toEqual({ port: 8787 });

  // The pane's field is a text input.
  await saved(server, world, { port: "8790" });
  expect(readConsoleJson(world.pool)).toEqual({ port: 8790 });
});

// engine/pool-settings.test.ts:176 pool settings › replaces spawnCaps whole, taking numeric strings and removing an all-empty one
conformance("config", "a Pool settings save replaces the Spawn caps whole, taking numbers typed as text, and removes all-empty caps", async (t) => {
  const { world, server } = await settledPool(t, { ...DEFAULTS, spawnCaps: { perAttempt: 5, perRun: 20 } });
  const caps = () => readConsoleJson(world.pool)!.spawnCaps;

  await saved(server, world, { spawnCaps: { perAttempt: 8, perRun: " 30 " } });
  expect(caps()).toEqual({ perAttempt: 8, perRun: 30 });

  await saved(server, world, { spawnCaps: { perAttempt: "", perRun: 40 } });
  expect(caps()).toEqual({ perRun: 40 });

  await saved(server, world, { spawnCaps: { perAttempt: null, perRun: "" } });
  expect(readConsoleJson(world.pool)).toEqual(DEFAULTS);
});

// engine/pool-settings.test.ts:192 pool settings › rejects a spawn cap that is not a whole number of 0 or more, naming the field
conformance("config", "a Pool settings save refuses a Spawn cap that is not a whole number of 0 or more, naming the field", async (t) => {
  const { world, server } = await settledPool(t, { ...DEFAULTS, spawnCaps: { perRun: 20 } });

  for (const perRun of [-1, 2.5, "many", "-2", true]) {
    expect(await refused(server, world, { spawnCaps: { perRun } })).toBe(
      "pool settings: spawnCaps.perRun must be a whole number, 0 or more",
    );
  }
  expect(await refused(server, world, { spawnCaps: { perAttempt: -1 } })).toBe(
    "pool settings: spawnCaps.perAttempt must be a whole number, 0 or more",
  );
  expect(await refused(server, world, { spawnCaps: 5 })).toBe("pool settings: spawnCaps must be an object");
  expect(readConsoleJson(world.pool)).toEqual({ ...DEFAULTS, spawnCaps: { perRun: 20 } });
});

// engine/pool-settings.test.ts:211 pool settings › carries steward.mayClose beside the budget and assign, false leaving it out
conformance("config", "a Pool settings save keeps Steward may Close beside the budget and the assign, and false leaves it out", async (t) => {
  const { world, server } = await settledPool(t, { ...DEFAULTS, steward: { budget: 3 } });
  const steward = () => readConsoleJson(world.pool)!.steward;

  await saved(server, world, { steward: { budget: "3", assign: { model: "judge" }, mayClose: true } });
  expect(steward()).toEqual({ budget: 3, assign: { model: "judge" }, mayClose: true });

  await saved(server, world, { steward: { budget: 3, mayClose: false } });
  expect(steward()).toEqual({ budget: 3 });

  // As the pane sends it when the box is off: the key absent.
  await saved(server, world, { steward: { budget: 3 } });
  expect(steward()).toEqual({ budget: 3 });

  await saved(server, world, { steward: { mayClose: true } });
  expect(steward()).toEqual({ mayClose: true });
});

// engine/pool-settings.test.ts:234 pool settings › refuses a steward.mayClose that is not true or false, leaving the file as it was
conformance("config", "a Pool settings save refuses a Steward may Close that is not true or false", async (t) => {
  const { world, server } = await settledPool(t, { ...DEFAULTS, steward: { mayClose: true } });

  for (const mayClose of ["true", 1, {}]) {
    expect(await refused(server, world, { steward: { mayClose } })).toBe(
      "pool settings: steward.mayClose must be true or false",
    );
  }
  expect(readConsoleJson(world.pool)).toEqual({ ...DEFAULTS, steward: { mayClose: true } });
});

// engine/pool-settings.test.ts:245 pool settings › takes a cap of 0, as a number or as the pane's text
conformance("config", "a Pool settings save takes a Spawn cap of 0, as a number or as text", async (t) => {
  const { world, server } = await settledPool(t, DEFAULTS);

  await saved(server, world, { spawnCaps: { perAttempt: 0, perRun: "0" } });

  expect(readConsoleJson(world.pool)!.spawnCaps).toEqual({ perAttempt: 0, perRun: 0 });
});

// engine/pool-settings.test.ts:253 pool settings › rejects a terminal and a selection the engine would not accept
conformance("config", "a Pool settings save refuses a terminal other than herdr and a selection other than auto or human", async (t) => {
  const { world, server } = await settledPool(t, DEFAULTS);

  expect(await refused(server, world, { terminal: "tmux" })).toBe('pool settings: terminal must be "herdr" (got "tmux")');
  expect(await refused(server, world, { selection: "coin-toss" })).toBe(
    'pool settings: selection must be "auto" or "human" (got "coin-toss")',
  );
});

// engine/pool-settings.test.ts:263 pool settings › rejects a harness the pool does not know, in defaults and in the resolver
conformance("config", "a Pool settings save refuses a harness the pool does not know, in the defaults and in the resolver", async (t) => {
  const { world, server } = await settledPool(t, DEFAULTS);

  expect(await refused(server, world, { defaults: { harness: "gpt" } })).toBe(
    `pool settings: defaults.harness names unknown harness 'gpt'. ${KNOWN}`,
  );
  expect(await refused(server, world, { resolver: "gpt" })).toBe(
    `pool settings: resolver names unknown harness 'gpt'. ${KNOWN}`,
  );
  expect(await refused(server, world, { resolver: { harness: "gpt" } })).toBe(
    `pool settings: resolver.harness names unknown harness 'gpt'. ${KNOWN}`,
  );
});

// engine/pool-settings.test.ts:289 pool settings › ignores a retired key a stale tab still sends, valid or not
conformance("config", "a Pool settings save ignores a retired roster and agents a stale tab still sends", async (t) => {
  const { world, server } = await settledPool(t, {});

  await saved(server, world, { roster: "- deepseek", agents: "{not json" });

  expect(readConsoleJson(world.pool)).toEqual({});
});

// engine/pool-settings.test.ts:300 pool settings › ignores a key outside the pane's own, so a stale tab cannot write assign
conformance("config", "a Pool settings save ignores keys outside the pane's own, so it cannot write assign", async (t) => {
  const { world, server } = await settledPool(t, { assign: { "01": { harness: "claude" } } });

  await saved(server, world, { assign: { "99": { harness: "opencode" } }, roster: "- deepseek" });

  expect(readConsoleJson(world.pool)).toEqual({ assign: { "01": { harness: "claude" } } });
});

// engine/pool-settings.test.ts:313 pool settings › writes through a rename, leaving no temporary file behind
conformance("config", "a Pool settings save leaves no temporary file beside console.json", async (t) => {
  const { world, server } = await settledPool(t, { ...DEFAULTS, port: 8787 });

  await saved(server, world, { reviewer: "- deepseek" });

  expect(readdirSync(world.pool).filter((name) => name.startsWith("console.json"))).toEqual(["console.json"]);
  expect(readConsoleJson(world.pool)).toEqual({ ...DEFAULTS, port: 8787, reviewer: "- deepseek" });
});

// engine/pool-settings.test.ts:319 pool settings › writes a pool that had no console.json at all
conformance("config", "a Pool settings save on a pool with no console.json creates it holding the patch alone", async (t) => {
  const { world, server } = await settledPool(t, null);

  await saved(server, world, { terminal: "herdr" });

  expect(readConsoleJson(world.pool)).toEqual({ terminal: "herdr" });
});

// engine/pool-settings.test.ts:327 pool settings › names the boot-only keys as a subset of the pane's own
conformance("config", "the boot-only keys are selection, terminal and port, each saved through the pane, and the Spawn caps are never stale", async (t) => {
  const { world, server } = await settledPool(t, DEFAULTS);
  expect(server.port).not.toBe(8790);
  expect((await settingsOf(server)).pool.bootOnly).toEqual(["selection", "terminal", "port"]);

  const steps: [Record<string, unknown>, string[]][] = [
    [{ spawnCaps: { perRun: 7 } }, []],
    [{ selection: "human" }, ["selection"]],
    [{ terminal: "herdr" }, ["selection", "terminal"]],
    [{ port: 8790 }, ["selection", "terminal", "port"]],
  ];
  for (const [patch, stale] of steps) {
    const settings = await saved(server, world, patch);
    expect([patch, settings.pool.effective.stale]).toEqual([patch, stale]);
    expect(settings.pool.bootOnly).toEqual(["selection", "terminal", "port"]);
  }
  expect(readConsoleJson(world.pool)).toEqual({
    ...DEFAULTS,
    spawnCaps: { perRun: 7 },
    selection: "human",
    terminal: "herdr",
    port: 8790,
  });
});
