/**
 * The Factory settings (issue #187, ADR-0037), seen from outside the server:
 * the `factory` block in the Machine defaults (the world's own HOME) and the
 * Pool settings (console.json), under the Line brief, each field falling
 * through on its own. The resolved Station settings reach the Ticket file the
 * engine writes and the harness it starts; Prove and Review switch off; a
 * change lands at the next super-step boundary, on the next Station Ticket
 * written and never on one already written; and the settings routes read,
 * write and refuse the block at both levels.
 */

import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactorySettings, PoolConfig } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { readStateLine } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  errorOf,
  flagValue,
  holdFile,
  launchesOf,
  logLines,
  putPool,
  refusedAtLoad,
  release,
  restedSnapshot,
  settingsOf,
  ticketOf,
  untilLaunched,
  writeConfig,
} from "./config-support.ts";
import {
  CONFIG,
  FINISH,
  NO_FINDINGS,
  PASS,
  SPEC,
  atCheckpoint,
  launches,
  lineWorld,
  started,
} from "./factory-line-support.ts";

const issue = (world: World, id: string): string => readFileSync(join(world.pool, "issues", `${id}.md`), "utf8");

/** The Machine defaults file under the world's HOME. */
function defaultsFile(world: World): string {
  return join(world.home, ".agent-graphs", "defaults.json");
}

/** Write the Machine defaults file whole, as the Settings pane or a person would. */
function writeMachine(world: World, defaults: Record<string, unknown>): void {
  mkdirSync(join(world.home, ".agent-graphs"), { recursive: true });
  writeFileSync(defaultsFile(world), JSON.stringify(defaults, null, 2));
}

/** A pool config carrying a `factory` layer beside the line cases' defaults. */
function withFactory(factory: FactorySettings): PoolConfig {
  return { ...CONFIG, factory };
}

/** The `spawn-assign` token a Station Ticket's state line carries for these fields. */
function assignToken(fields: { harness: string; model: string; effort: string; drivers: string }): string {
  return `spawn-assign=${encodeURIComponent(JSON.stringify(fields))}`;
}

/** The value of `flag` on the first launch of `key`. */
function flagOf(world: World, key: string, flag: string): string | undefined {
  return flagValue(launchesOf(world, key)[0]!.argv, flag);
}

conformance("factory", "the Machine defaults, the Pool settings and the Line brief each set their own fields, and the resolved Assignment, drivers and note reach the Ticket file and the harness started", async (t) => {
  const world = lineWorld(
    t,
    { spec: SPEC, factory: { stations: { prove: { drivers: "my-verify tdd" } } } },
    {},
    withFactory({
      stations: { prove: { assign: { effort: "low" } }, implement: { note: "pool note for Implement" } },
      finish: "draft-pr",
    }),
  );
  writeMachine(world, {
    factory: {
      stations: {
        prove: { assign: { model: "machine-model" }, note: "machine note for Prove" },
        review: { drivers: "review-skill" },
      },
      finish: "pr",
    },
  });
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);

  const atFinish = await atCheckpoint(server, "r1-finish");
  // Prove: the machine's model, the pool's effort, the brief's drivers, the built-in harness.
  expect(readStateLine(world.pool, "r1-prove.md").line).toContain(
    assignToken({ harness: "claude", model: "machine-model", effort: "low", drivers: "my-verify tdd" }),
  );
  expect(ticketOf(atFinish, "r1-prove").assignment).toMatchObject({
    harness: "claude",
    model: "machine-model",
    effort: "low",
    drivers: "my-verify tdd",
  });
  expect(flagOf(world, "r1-prove", "--model")).toBe("machine-model");
  expect(flagOf(world, "r1-prove", "--effort")).toBe("low");
  expect(issue(world, "r1-prove")).toContain("## Note for this Station\n\nmachine note for Prove");
  expect(issue(world, "r1-implement")).toContain("## Note for this Station\n\npool note for Implement");
  // Review: the machine's drivers, everything else built in.
  expect(ticketOf(atFinish, "r1-review").assignment).toMatchObject({ model: "opus", effort: "high", drivers: "review-skill" });
  expect(flagOf(world, "r1-review", "--model")).toBe("opus");
  expect(issue(world, "r1-review")).not.toContain("## Note for this Station");
  // The pool's Finish over the machine's, the brief naming none.
  expect(issue(world, "r1-decide")).toContain("carry out the Finish before you record it: `draft-pr`");
  expect(issue(world, "r1-finish")).toContain("Finish: `draft-pr`.");
});

conformance("factory", "Prove switched off in the Pool settings routes Implement to Review", async (t) => {
  const world = lineWorld(t, undefined, {}, withFactory({ stations: { prove: { enabled: false } } }));
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);

  await atCheckpoint(server, "r1-finish");
  expect(launches(world)).toEqual(["r1-implement", "r1-review", "r1-decide"]);
  expect(readStateLine(world.pool, "r1-review.md").line).toContain("blocked-by=r1-implement status=done station=review");
});

conformance("factory", "Review switched off in the Machine defaults routes Prove's pass to Decide, which has no findings to account for", async (t) => {
  const world = lineWorld(t);
  writeMachine(world, { factory: { stations: { review: { enabled: false } } } });
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);

  await atCheckpoint(server, "r1-finish");
  expect(launches(world)).toEqual(["r1-implement", "r1-prove", "r1-decide"]);
  expect(readStateLine(world.pool, "r1-decide.md").line).toContain("blocked-by=r1-prove status=done station=decide");
  expect(issue(world, "r1-decide")).toContain("## Review findings\n\n_(none)_");
});

conformance("factory", "with Prove and Review both off, Implement routes straight to Decide", async (t) => {
  const world = lineWorld(t, undefined, {}, withFactory({ stations: { prove: { enabled: false }, review: { enabled: false } } }));
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);

  await atCheckpoint(server, "r1-finish");
  expect(launches(world)).toEqual(["r1-implement", "r1-decide"]);
  expect(readStateLine(world.pool, "r1-decide.md").line).toContain("blocked-by=r1-implement status=done station=decide");
});

conformance("factory", "a Factory settings change lands at the next boundary: the next Station Ticket written takes it, the one already written keeps what it was written with", async (t) => {
  const world = lineWorld(t);
  world.stubs.script("r1-implement", { waitFor: holdFile(world, "r1-implement") });
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);
  await untilLaunched(world, "r1-implement");
  const before = readStateLine(world.pool, "r1-implement.md").line;
  const builtIn = assignToken({ harness: "claude", model: "opus", effort: "high", drivers: "implement" });
  expect(before).toContain(builtIn);

  // Saved from the Settings pane mid-Ticket: the pool's layer, and the machine's.
  const saved = await putPool(server, {
    factory: {
      stations: {
        implement: { assign: { model: "model-x" }, note: "too late for r1-implement" },
        prove: { assign: { model: "model-b" }, note: "prove it on the CLI" },
      },
    },
  });
  expect(saved.status, saved.text).toBe(200);
  const machine = await server.http.put("/api/settings/machine", {
    defaults: { factory: { stations: { review: { drivers: "review-b" } } } },
  });
  expect(machine.status, machine.text).toBe(200);
  release(world, "r1-implement");

  const atFinish = await atCheckpoint(server, "r1-finish");
  expect(logLines(atFinish, "config reloaded")).toEqual(["config reloaded: factory"]);
  // Never mid-Ticket: r1-implement ran on, and its file still carries, what it was written with.
  expect(readStateLine(world.pool, "r1-implement.md").line).toContain(builtIn);
  expect(flagOf(world, "r1-implement", "--model")).toBe("opus");
  expect(issue(world, "r1-implement")).not.toContain("too late for r1-implement");
  // The next Station Tickets take the change.
  expect(flagOf(world, "r1-prove", "--model")).toBe("model-b");
  expect(issue(world, "r1-prove")).toContain("## Note for this Station\n\nprove it on the CLI");
  expect(ticketOf(atFinish, "r1-review").assignment).toMatchObject({ drivers: "review-b" });
});

conformance("config", "the Settings routes read, write and refuse the factory block at both the machine and the pool level", async (t) => {
  const world = lineWorld(t);
  const server = await t.start(world);
  await restedSnapshot(server);

  const pool = await putPool(server, {
    factory: {
      stations: { implement: { drivers: " tdd ", assign: { model: "", effort: "low" }, note: "" }, review: { enabled: false } },
      limits: { proveFailsPerRound: "3", extraRounds: "" },
      finish: " draft-pr ",
    },
  });
  expect(pool.status, pool.text).toBe(200);
  const tidied = {
    stations: { implement: { drivers: "tdd", assign: { effort: "low" } }, review: { enabled: false } },
    limits: { proveFailsPerRound: 3 },
    finish: "draft-pr",
  };
  expect(JSON.parse(readFileSync(join(world.pool, "console.json"), "utf8")).factory).toEqual(tidied);
  expect((await settingsOf(server)).pool.config.factory).toEqual(tidied);

  const machine = await server.http.put("/api/settings/machine", {
    defaults: { model: "m", factory: { stations: { prove: { enabled: false, note: " run it " } }, limits: { extraRounds: 0 } } },
  });
  expect(machine.status, machine.text).toBe(200);
  const own = { model: "m", factory: { stations: { prove: { enabled: false, note: "run it" } }, limits: { extraRounds: 0 } } };
  expect(JSON.parse(readFileSync(defaultsFile(world), "utf8"))).toEqual(own);
  const read = await settingsOf(server);
  expect(read.machine.own).toEqual(own);
  expect(read.machine.defaults.factory).toEqual(own.factory);

  // Refused whole, naming the field, the files untouched.
  const consoleBefore = readFileSync(join(world.pool, "console.json"), "utf8");
  for (const [patch, error] of [
    [
      { stations: { implement: { enabled: false } } },
      "pool settings: factory: factory.stations.implement.enabled is false: only Prove and Review can be switched off",
    ],
    [
      { stations: { decide: { assign: { harness: "nope" } } } },
      "pool settings: factory.stations.decide.assign.harness names unknown harness 'nope'. Known: ",
    ],
  ] as const) {
    const refused = await putPool(server, { factory: patch });
    expect(refused.status, refused.text).toBe(400);
    expect(errorOf(refused)).toStartWith(error);
  }
  expect(readFileSync(join(world.pool, "console.json"), "utf8")).toBe(consoleBefore);
  const refusedMachine = await server.http.put("/api/settings/machine", {
    defaults: { factory: { stations: { decide: { enabled: false } } } },
  });
  expect(refusedMachine.status, refusedMachine.text).toBe(400);
  expect(errorOf(refusedMachine)).toBe(
    "machine defaults: factory: factory.stations.decide.enabled is false: only Prove and Review can be switched off",
  );
  expect(JSON.parse(readFileSync(defaultsFile(world), "utf8"))).toEqual(own);

  // An emptied pool layer goes back to inheriting by leaving the key out.
  const cleared = await putPool(server, { factory: null });
  expect(cleared.status, cleared.text).toBe(200);
  expect(JSON.parse(readFileSync(join(world.pool, "console.json"), "utf8")).factory).toBeUndefined();
});

conformance("config", "a malformed factory block stops the pool at load, and a hand edit to one is rejected whole mid-run", async (t) => {
  const bad = { ...CONFIG, factory: { stations: { decide: { enabled: false } } } } as PoolConfig;
  const { code, output } = await refusedAtLoad(lineWorld(t, undefined, {}, bad));
  expect(code === 0).toBe(false);
  expect(output).toContain(
    "pool config: factory: factory.stations.decide.enabled is false: only Prove and Review can be switched off",
  );

  const world = lineWorld(t);
  world.stubs.script("r1-implement", { waitFor: holdFile(world, "r1-implement") });
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);
  await untilLaunched(world, "r1-implement");
  writeConfig(world, { ...CONFIG, factory: { stations: { prove: { assign: { model: "model-b" } }, build: {} } } } as PoolConfig);
  release(world, "r1-implement");

  const atFinish = await atCheckpoint(server, "r1-finish");
  const rejected = logLines(atFinish, "config reload");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toStartWith("config reload rejected: pool config: factory: unknown field `build`");
  expect(flagOf(world, "r1-prove", "--model")).toBe("opus");
});
