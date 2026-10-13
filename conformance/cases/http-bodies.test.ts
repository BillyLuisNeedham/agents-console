/**
 * Request bodies the JSON routes refuse, seen from outside the server
 * (ADR-0036): a body that is not JSON at all, and one missing the field a
 * route cannot do without. Each route answers in its own convention, `error`
 * or `reason`, and nothing in the pool, or the Machine defaults beside it,
 * is written. Both cases are the inventory's gaps beside engine/server.ts.
 */

import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CaseServer } from "../harness/case.ts";
import { conformance } from "../harness/case.ts";
import type { World } from "../harness/world.ts";
import { doneTicket } from "./config-support.ts";
import { CLAUDE, REVIEW, interruptFor } from "./protocol-support.ts";

/**
 * Every file in the pool by its path there, with its bytes, less the
 * server's own log, which a request may add a line to.
 */
function poolFiles(world: World): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(world.pool, path)] = readFileSync(path).toString("base64");
    }
  };
  walk(world.pool);
  delete out[join("runs", "server.log")];
  return out;
}

/** The Machine defaults file under the world's HOME. */
const machineDefaults = (world: World): string => join(world.home, ".agent-graphs", "defaults.json");

/** A route sent `body` as it is, with the JSON content type, answered as it comes. */
async function send(server: CaseServer, method: string, path: string, body: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.url}${path}`, { method, body, headers: { "content-type": "application/json" } });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) };
}

// The gap at engine/server.ts:1958
conformance("http", "request bodies › answers a body that is not JSON in each route's own convention, writing nothing", async (t) => {
  const world = t.world({ tickets: [doneTicket("01")], config: CLAUDE });
  const server = await t.start(world);
  await interruptFor(server, REVIEW);
  const before = poolFiles(world);

  // Bun's own words for a body its JSON parse refuses.
  const parseError = { error: "Failed to parse JSON" };
  const invalid = { reason: "invalid JSON body" };
  const routes: [string, string, number, unknown][] = [
    ["POST", "/api/resume", 400, parseError],
    ["PUT", "/api/settings/pool", 400, parseError],
    ["PUT", "/api/settings/machine", 400, parseError],
    // The Reassign reads a body it cannot parse as its own failure.
    ["PUT", "/api/reassign", 500, parseError],
    ["POST", "/api/conversations", 400, invalid],
    ["POST", "/api/conversations/end", 400, invalid],
    ["POST", "/api/enlist", 400, invalid],
    ["POST", "/api/keep-talking", 400, invalid],
    ["POST", "/api/spawns/held/adopt", 400, invalid],
    ["POST", "/api/spawns/held/discard", 400, invalid],
    ["POST", "/api/spawns/pending/hold", 400, invalid],
    ["POST", "/api/spawns/pending/discard", 400, invalid],
  ];
  for (const [method, path, status, body] of routes) {
    expect([method, path, await send(server, method, path, "not json")]).toEqual([method, path, { status, body }]);
  }

  expect(poolFiles(world)).toEqual(before);
  expect(existsSync(machineDefaults(world))).toBe(false);
});

// The gap at engine/server.ts:2048
conformance("http", "request bodies › refuses a body missing the field each route needs, writing nothing", async (t) => {
  // Terminal-backed, with no herdr daemon: none of these gets as far as one.
  const world = t.world({ tickets: [doneTicket("01")], config: { ...CLAUDE, terminal: "herdr" } });
  const server = await t.start(world);
  await interruptFor(server, REVIEW);
  const before = poolFiles(world);

  const refusals: [string, string, unknown, unknown][] = [
    ["POST", "/api/enlist", { becomes: "ticket" }, { reason: "paneId is required" }],
    ["POST", "/api/keep-talking", {}, { reason: "ticketId is required" }],
    ["POST", "/api/conversations/end", {}, { reason: "id is required" }],
    ["POST", "/api/conversations", { title: "t", role: "admin" }, { reason: 'role must be "steward" when given' }],
    ["PUT", "/api/settings/machine", { defaults: [] }, { error: "settings: defaults must be an object" }],
  ];
  for (const [method, path, body, refusal] of refusals) {
    const res = await server.http.call(method, path, body);
    expect([method, path, res.status, res.json()]).toEqual([method, path, 400, refusal]);
  }

  expect(poolFiles(world)).toEqual(before);
  expect(existsSync(machineDefaults(world))).toBe(false);
});
