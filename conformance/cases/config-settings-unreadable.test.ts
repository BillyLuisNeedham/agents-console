/**
 * A console.json hand-edited into something that will not parse while the
 * server runs, seen from every route that reads it (ADR-0036): the gap the
 * inventory lists under `config` (source engine/server.ts:1815), which
 * NOT-PORTED.md's C19 section left to the routes' ticket, C20. The server
 * parsed the file to start at all, so a file it can no longer read is its own
 * failure where it is the whole answer, and the broken bytes are never
 * written over. The parse error is the JSON parser's own words, so only that
 * there is one is pinned, never its text.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import {
  consoleText,
  errorOf,
  putPool,
  putReassign,
  rawConfig,
  snapshotOf,
  ticket,
  ticketOf,
  untilInFlight,
  untilSnapshot,
  writeConfig,
} from "./config-support.ts";

const DEFAULTS: PoolConfig = { defaults: { harness: "claude", model: "m" } };
const BROKEN = "{ not json";

/** A refusal's error: some words, which are the parser's and not pinned. */
function expectSomeError(error: string): void {
  expect(typeof error).toBe("string");
  expect(error.trim()).not.toBe("");
}

// engine/reassign.test.ts:746 writeReassign: refusals and skips › reports a console.json it cannot read as the server's failure, not the request's
conformance("config", "console.json edited into what will not parse is the server's failure on every route that reads it, and the snapshot keeps the last good title", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })],
    config: rawConfig({ ...DEFAULTS, title: "Boot title" }),
  });
  const held = world.stubs.hold("01");
  const server = await t.start(world);
  await untilInFlight(server, "01");
  // The last good title is one saved since boot.
  expect((await putPool(server, { title: "Saved title" })).status).toBe(200);
  expect((await snapshotOf(server)).poolTitle).toBe("Saved title");

  writeConfig(world, BROKEN);

  const settings = await server.http.get("/api/settings");
  expect(settings.status).toBe(500);
  expectSomeError(errorOf(settings));

  // A save is refused as the request's, and never writes over the broken bytes.
  const save = await putPool(server, { title: "New title" });
  expect(save.status).toBe(400);
  expectSomeError(errorOf(save));
  expect(consoleText(world)).toBe(BROKEN);

  const reassign = await putReassign(server, { tickets: ["01"], fields: { model: "opus" } });
  expect(reassign.status).toBe(500);
  expectSomeError(errorOf(reassign));
  expect(consoleText(world)).toBe(BROKEN);

  // The Bun server writes the Machine defaults, then fails to read the pool
  // half of its answer and refuses with 400 (conformance/NOT-PORTED.md, C20).
  const machine = await server.http.put("/api/settings/machine", { defaults: { harness: "claude" } });
  expect(machine.status).toBe(400);
  expectSomeError(errorOf(machine));
  const machineFile = join(world.home, ".agent-graphs", "defaults.json");
  expect(existsSync(machineFile)).toBe(true);
  expect(JSON.parse(readFileSync(machineFile, "utf8"))).toEqual({ harness: "claude" });

  // GET /api/panes answers 500 with Bun's own error page, so only its
  // status is pinned (conformance/NOT-PORTED.md, C20); its socket twin
  // refuses cleanly.
  expect((await server.http.get("/api/panes")).status).toBe(500);
  const client = await t.socket(server);
  const panes = await client.request("panes.list", {});
  if (panes.ok) throw new Error(`panes.list was not refused: ${JSON.stringify(panes)}`);
  expect(panes.refusal.status).toBe(500);
  expectSomeError(panes.refusal.reason);

  // The next snapshot the run publishes keeps the last good title.
  await held.release();
  const after = await untilSnapshot(server, (s) => ticketOf(s, "01").liveAttempt === null, "01's Attempt to end");
  expect(after.poolTitle).toBe("Saved title");
  expect(consoleText(world)).toBe(BROKEN);
  expect(server.exited()).toBe(false);
});
