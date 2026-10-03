/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOOT_ONLY_KEYS,
  POOL_SETTINGS_KEYS,
  readPoolSettings,
  writePoolSettings,
} from "./pool-settings.ts";
import { makeTempDir } from "./tmp.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A pool directory holding the given console.json (none when omitted). */
function pool(config?: Record<string, unknown>): string {
  const dir = makeTempDir("pool-settings-");
  dirs.push(dir);
  if (config) {
    writeFileSync(join(dir, "console.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  return dir;
}

function onDisk(poolDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(poolDir, "console.json"), "utf8"));
}

const HARNESSES = ["claude", "opencode", "stub"];

describe("pool settings", () => {
  it("reads an absent file as no config, and the file as it is otherwise", () => {
    expect(readPoolSettings(pool()).config).toEqual({});
    const dir = pool({ port: 8790, assign: { "01": { harness: "claude" } } });
    const read = readPoolSettings(dir);
    expect(read.path).toBe(join(dir, "console.json"));
    expect(read.config).toEqual({ port: 8790, assign: { "01": { harness: "claude" } } });
  });

  // The pane edits its own keys and nothing else: a ticket's assign entry
  // belongs to the Ticket, and a key this module has never heard of belongs
  // to whoever wrote it there.
  it("merges a patch over the file, preserving assign and unknown keys", () => {
    const dir = pool({
      defaults: { harness: "stub", model: "m" },
      assign: { "01": { harness: "claude", verify: 2 } },
      port: 8787,
      somethingElse: { kept: true },
    });

    const written = writePoolSettings(
      dir,
      { defaults: { harness: "claude", model: "opus" }, selection: "human" },
      { harnesses: HARNESSES },
    );

    expect(written).toEqual({
      defaults: { harness: "claude", model: "opus" },
      assign: { "01": { harness: "claude", verify: 2 } },
      port: 8787,
      somethingElse: { kept: true },
      selection: "human",
    } as never);
    expect(onDisk(dir)).toEqual(written as never);
  });

  it("leaves a key the patch never mentions exactly as it was", () => {
    const dir = pool({ checkpoint: "a device", terminal: "herdr" });
    writePoolSettings(dir, { reviewer: "acceptance criteria only" }, { harnesses: [] });
    expect(onDisk(dir)).toEqual({
      checkpoint: "a device",
      terminal: "herdr",
      reviewer: "acceptance criteria only",
    });
  });

  // Clearing is how the pane unpins a port back to "any free port" or drops
  // a pool back to headless, so every empty form of a value removes the key.
  it("removes a key the patch clears with null, an empty string or undefined", () => {
    const dir = pool({
      port: 8787,
      terminal: "herdr",
      reviewer: "- deepseek",
      selection: "human",
      assign: { "01": {} },
    });

    const written = writePoolSettings(
      dir,
      { port: null, terminal: "", reviewer: "   ", selection: undefined },
      { harnesses: HARNESSES },
    );

    expect(written).toEqual({ assign: { "01": {} } });
    expect(onDisk(dir)).toEqual({ assign: { "01": {} } });
  });

  // `defaults` is the one key the pane shows whole, so a field the operator
  // emptied is an instruction rather than an omission.
  it("replaces defaults whole, dropping empty fields, and removes an all-empty one", () => {
    const dir = pool({ defaults: { harness: "stub", model: "m", drivers: "implement" } });

    expect(
      writePoolSettings(
        dir,
        { defaults: { harness: "claude", model: "", drivers: " implement " } },
        { harnesses: HARNESSES },
      ).defaults,
    ).toEqual({ harness: "claude", drivers: "implement" });

    expect(
      writePoolSettings(
        dir,
        { defaults: { harness: "claude", effort: " xhigh " } },
        { harnesses: HARNESSES },
      ).defaults,
    ).toEqual({ harness: "claude", effort: "xhigh" });
    expect(() =>
      writePoolSettings(dir, { defaults: { effort: 3 } }, { harnesses: HARNESSES }),
    ).toThrow("pool settings: defaults.effort must be a string");

    expect(
      writePoolSettings(dir, { defaults: { harness: "", model: "" } }, { harnesses: HARNESSES }),
    ).toEqual({});
  });

  // "none" is the resolver's opt-out and a real value; an empty string is the
  // pane clearing the key, which is not the same thing.
  it("keeps the resolver's opt-out and its object form, and clears on empty", () => {
    const dir = pool({});
    expect(writePoolSettings(dir, { resolver: "none" }, { harnesses: HARNESSES }).resolver).toBe(
      "none",
    );
    expect(
      writePoolSettings(
        dir,
        { resolver: { harness: "opencode", model: "oc/flash" } },
        { harnesses: HARNESSES },
      ).resolver,
    ).toEqual({ harness: "opencode", model: "oc/flash" });
    // The resolver's own effort sits beside its own model.
    expect(
      writePoolSettings(
        dir,
        { resolver: { harness: "opencode", model: "oc/flash", effort: " max ", } },
        { harnesses: HARNESSES },
      ).resolver,
    ).toEqual({ harness: "opencode", model: "oc/flash", effort: "max" });
    expect(() =>
      writePoolSettings(dir, { resolver: { effort: 1 } }, { harnesses: HARNESSES }),
    ).toThrow("pool settings: resolver.effort must be a string");
    expect(writePoolSettings(dir, { resolver: "" }, { harnesses: HARNESSES })).toEqual({});
  });

  it("rejects a port that is not an integer in range, naming the field", () => {
    const dir = pool({ port: 8787 });
    expect(() => writePoolSettings(dir, { port: 0 }, { harnesses: [] })).toThrow(/port/);
    expect(() => writePoolSettings(dir, { port: 70000 }, { harnesses: [] })).toThrow(/port/);
    expect(() => writePoolSettings(dir, { port: 12.5 }, { harnesses: [] })).toThrow(/port/);
    expect(() => writePoolSettings(dir, { port: "http" }, { harnesses: [] })).toThrow(/port/);
    // A refused write leaves the file exactly as it was.
    expect(onDisk(dir)).toEqual({ port: 8787 });
    // The pane's field is a text input, so a numeric string is a port.
    expect(writePoolSettings(dir, { port: "8790" }, { harnesses: [] }).port).toBe(8790);
  });

  // The Spawn caps (issue #149) are shown whole like `defaults`, so a field
  // the operator emptied goes back to the engine's default rather than
  // keeping its old value; the pane's fields are text inputs, so a numeric
  // string is a cap.
  it("replaces spawnCaps whole, taking numeric strings and removing an all-empty one", () => {
    const dir = pool({ spawnCaps: { perAttempt: 5, perRun: 20 } });

    expect(
      writePoolSettings(dir, { spawnCaps: { perAttempt: 8, perRun: " 30 " } }, { harnesses: [] })
        .spawnCaps,
    ).toEqual({ perAttempt: 8, perRun: 30 });
    expect(
      writePoolSettings(dir, { spawnCaps: { perAttempt: "", perRun: 40 } }, { harnesses: [] })
        .spawnCaps,
    ).toEqual({ perRun: 40 });
    expect(
      writePoolSettings(dir, { spawnCaps: { perAttempt: null, perRun: "" } }, { harnesses: [] }),
    ).toEqual({});
  });

  it("rejects a spawn cap that is not a whole number of 0 or more, naming the field", () => {
    const dir = pool({ spawnCaps: { perRun: 20 } });
    for (const bad of [-1, 2.5, "many", "-2", true]) {
      expect(() =>
        writePoolSettings(dir, { spawnCaps: { perRun: bad } }, { harnesses: [] }),
      ).toThrow("pool settings: spawnCaps.perRun must be a whole number, 0 or more");
    }
    expect(() =>
      writePoolSettings(dir, { spawnCaps: { perAttempt: -1 } }, { harnesses: [] }),
    ).toThrow("pool settings: spawnCaps.perAttempt must be a whole number, 0 or more");
    expect(() => writePoolSettings(dir, { spawnCaps: 5 }, { harnesses: [] })).toThrow(
      "pool settings: spawnCaps must be an object",
    );
    expect(onDisk(dir)).toEqual({ spawnCaps: { perRun: 20 } });
  });

  // "Steward may Close checkpoints" (issue #154) is a checkbox inside the
  // Steward entry: true is kept beside the budget and the assign, false
  // leaves it out as the default, and anything else is refused by name.
  it("carries steward.mayClose beside the budget and assign, false leaving it out", () => {
    const dir = pool({ steward: { budget: 3 } });
    expect(
      writePoolSettings(
        dir,
        { steward: { budget: "3", assign: { model: "judge" }, mayClose: true } },
        { harnesses: HARNESSES },
      ).steward,
    ).toEqual({ budget: 3, assign: { model: "judge" }, mayClose: true });
    expect(onDisk(dir).steward).toEqual({ budget: 3, assign: { model: "judge" }, mayClose: true });
    expect(
      writePoolSettings(dir, { steward: { budget: 3, mayClose: false } }, { harnesses: HARNESSES })
        .steward,
    ).toEqual({ budget: 3 });
    // As the pane sends it when the box is off: the key absent.
    expect(writePoolSettings(dir, { steward: { budget: 3 } }, { harnesses: HARNESSES }).steward).toEqual({
      budget: 3,
    });
    expect(writePoolSettings(dir, { steward: { mayClose: true } }, { harnesses: HARNESSES }).steward).toEqual({
      mayClose: true,
    });
  });

  it("refuses a steward.mayClose that is not true or false, leaving the file as it was", () => {
    const dir = pool({ steward: { mayClose: true } });
    for (const bad of ["true", 1, {}]) {
      expect(() =>
        writePoolSettings(dir, { steward: { mayClose: bad } }, { harnesses: HARNESSES }),
      ).toThrow("pool settings: steward.mayClose must be true or false");
    }
    expect(onDisk(dir)).toEqual({ steward: { mayClose: true } });
  });

  // Issue #150: a cap of 0 holds every proposal for the operator.
  it("takes a cap of 0, as a number or as the pane's text", () => {
    const dir = pool({});
    expect(
      writePoolSettings(dir, { spawnCaps: { perAttempt: 0, perRun: "0" } }, { harnesses: [] })
        .spawnCaps,
    ).toEqual({ perAttempt: 0, perRun: 0 });
  });

  it("rejects a terminal and a selection the engine would not accept", () => {
    const dir = pool({});
    expect(() => writePoolSettings(dir, { terminal: "tmux" }, { harnesses: [] })).toThrow(
      /terminal/,
    );
    expect(() => writePoolSettings(dir, { selection: "coin-toss" }, { harnesses: [] })).toThrow(
      /selection/,
    );
  });

  it("rejects a harness the pool does not know, in defaults and in the resolver", () => {
    const dir = pool({});
    expect(() =>
      writePoolSettings(dir, { defaults: { harness: "gpt" } }, { harnesses: HARNESSES }),
    ).toThrow(/defaults\.harness names unknown harness 'gpt'/);
    expect(() => writePoolSettings(dir, { resolver: "gpt" }, { harnesses: HARNESSES })).toThrow(
      /resolver names unknown harness 'gpt'/,
    );
    expect(() =>
      writePoolSettings(dir, { resolver: { harness: "gpt" } }, { harnesses: HARNESSES }),
    ).toThrow(/resolver\.harness/);
    // No harness table means no check, rather than refusing every harness.
    expect(
      writePoolSettings(dir, { defaults: { harness: "gpt" } }, { harnesses: [] }).defaults,
    ).toEqual({ harness: "gpt" });
  });

  // ADR-0031: roster and agents are retired. A file that still carries them
  // reads as if it did not, and the next save drops them without a word.
  it("reads past a retired roster and agents, and drops them on the next save", () => {
    const dir = pool({ roster: "- deepseek", agents: '{"deepseek":{}}', port: 8787 });
    expect(readPoolSettings(dir).config).toEqual({ port: 8787 });
    writePoolSettings(dir, { reviewer: "r" }, { harnesses: [] });
    expect(onDisk(dir)).toEqual({ port: 8787, reviewer: "r" });
  });

  it("ignores a retired key a stale tab still sends, valid or not", () => {
    const dir = pool({});
    const written = writePoolSettings(
      dir,
      { roster: "- deepseek", agents: "{not json" },
      { harnesses: [] },
    );
    expect(written).toEqual({});
    expect(onDisk(dir)).toEqual({});
  });

  it("ignores a key outside the pane's own, so a stale tab cannot write assign", () => {
    const dir = pool({ assign: { "01": { harness: "claude" } } });
    writePoolSettings(
      dir,
      { assign: { "99": { harness: "stub" } }, roster: "- deepseek" },
      { harnesses: HARNESSES },
    );
    expect(onDisk(dir).assign).toEqual({ "01": { harness: "claude" } });
  });

  // The engine re-reads this file at a super-step boundary, which can land
  // mid-write: the rename is what stops it reading half a file, and nothing
  // of the write may be left behind for the next boundary to trip over.
  it("writes through a rename, leaving no temporary file behind", () => {
    const dir = pool({ port: 8787 });
    writePoolSettings(dir, { reviewer: "- deepseek" }, { harnesses: [] });
    expect(readdirSync(dir)).toEqual(["console.json"]);
  });

  it("writes a pool that had no console.json at all", () => {
    const dir = pool();
    expect(writePoolSettings(dir, { terminal: "herdr" }, { harnesses: [] })).toEqual({
      terminal: "herdr",
    });
    expect(onDisk(dir)).toEqual({ terminal: "herdr" });
  });

  it("names the boot-only keys as a subset of the pane's own", () => {
    for (const key of BOOT_ONLY_KEYS) {
      expect(POOL_SETTINGS_KEYS).toContain(key);
    }
    // The Spawn caps reload at the boundary (issue #149), so no Restart badge.
    expect(POOL_SETTINGS_KEYS).toContain("spawnCaps");
    expect([...BOOT_ONLY_KEYS]).toEqual([
      "selection",
      "terminal",
      "port",
    ]);
  });
});
