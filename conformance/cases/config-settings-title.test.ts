/**
 * The Pool title (issue #100), seen from outside the server (ADR-0036): what
 * a title saved through PUT /api/settings/pool, or written in console.json at
 * boot, becomes. It is kept as one line of at most 80 characters, control
 * characters dropped, blank meaning none, and it is the same in console.json,
 * on the snapshot and on the Pool workspace the server creates. The
 * inventory's ticket C20, area `config`; each case names the engine test it
 * came from.
 */

import { expect } from "bun:test";
import type { PoolConfig } from "../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { readConsoleJson } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import { doneTicket, putPool, rawConfig, restedSnapshot, snapshotOf } from "./config-support.ts";

const DEFAULTS: PoolConfig = { defaults: { harness: "claude", model: "m" } };

/** A started pool at rest, its one Ticket done. */
async function settledPool(t: Case, config: PoolConfig = DEFAULTS): Promise<{ world: World; server: CaseServer }> {
  const world = t.world({ tickets: [doneTicket("01")], config });
  const server = await t.start(world);
  await restedSnapshot(server);
  return { world, server };
}

/** Save a title, which must be accepted. */
async function saveTitle(server: CaseServer, title: string): Promise<void> {
  const answer = await putPool(server, { title });
  expect(answer.status, answer.text).toBe(200);
}

/** The title as console.json holds it and as the snapshot serves it. */
async function titles(world: World, server: CaseServer): Promise<{ file: unknown; snapshot: string | null }> {
  return { file: readConsoleJson(world.pool)!.title, snapshot: (await snapshotOf(server)).poolTitle };
}

// engine/pool-title.test.ts:5 normaliseTitle › collapses whitespace to one line and trims
conformance("config", "a saved Pool title has its whitespace collapsed onto one line and trimmed", async (t) => {
  const { world, server } = await settledPool(t);

  await saveTitle(server, "  Jev as\n the\tgrader  ");

  expect(await titles(world, server)).toEqual({ file: "Jev as the grader", snapshot: "Jev as the grader" });
});

// engine/pool-title.test.ts:9 normaliseTitle › blank is no title
conformance("config", "a blank Pool title is no title: the key goes and the snapshot's title is null", async (t) => {
  const { world, server } = await settledPool(t, rawConfig({ ...DEFAULTS, title: "Old title" }));
  expect((await snapshotOf(server)).poolTitle).toBe("Old title");

  await saveTitle(server, "  \n ");

  expect(readConsoleJson(world.pool)).toEqual(DEFAULTS);
  expect((await snapshotOf(server)).poolTitle).toBeNull();
});

// engine/pool-title.test.ts:13 normaliseTitle › drops control characters, so a terminal escape cannot ride a workspace label
conformance("config", "a Pool title's control characters are dropped from the workspace label and the snapshot", async (t) => {
  const world = t.world({
    tickets: [doneTicket("01")],
    config: rawConfig({ ...DEFAULTS, terminal: "herdr", title: "\x1b[31mRed\x07 pool" }),
  });
  const herdr = await t.herdr(world);
  const server = await t.start(world, { herdr });

  const created = await herdr.waitForCall((call) => call.method === "workspace.create", { ms: 30_000 });
  expect(created.params.label).toBe("[31mRed pool");
  expect((await restedSnapshot(server)).poolTitle).toBe("[31mRed pool");
});

// engine/pool-title.test.ts:17 normaliseTitle › cuts a pasted wall of text to the maximum
conformance("config", "a pasted wall of text is cut to its first 80 characters as a Pool title", async (t) => {
  const { world, server } = await settledPool(t);
  const wall = Array.from({ length: 500 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

  await saveTitle(server, wall);

  expect(await titles(world, server)).toEqual({ file: wall.slice(0, 80), snapshot: wall.slice(0, 80) });
});

// engine/pool-title.test.ts:22 normaliseTitle › cuts by character, never splitting one in two
conformance("config", "a Pool title is cut by character, never splitting one outside the basic plane in two", async (t) => {
  const { world, server } = await settledPool(t);

  await saveTitle(server, "🙂".repeat(85));

  const { file, snapshot } = await titles(world, server);
  expect(snapshot).toBe("🙂".repeat(80));
  expect([...snapshot!]).toHaveLength(80);
  expect(file).toBe("🙂".repeat(80));
});
