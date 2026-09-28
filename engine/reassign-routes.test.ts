/// <reference types="bun" />

/**
 * The Reassign route (issue #126). The module's own cases cover what lands in
 * console.json; these cover the seam: that the answer carries a snapshot
 * already showing the new Assignment, that the badge and the per-field
 * sources ride on every ticket, and that a refused write is a 400 { error }
 * in the Settings convention with the file untouched.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoolServer, type PoolServer } from "./server.ts";
import type { PoolConfig } from "./engine.ts";
import type { EnrichedSnapshot, EnrichedTicketState } from "./wire.ts";
import type { ReassignRequest, ReassignResponse } from "./reassign.ts";
import {
  STUB_DEFAULTS,
  cleanupPools,
  makePool,
  stubHarness,
} from "./pool-fixture.ts";

const servers: PoolServer[] = [];

afterEach(async () => {
  await cleanupPools(servers);
});

const READY = (id: string, blocked = "none") =>
  `<!-- state: id=${id} blocked-by=${blocked} status=ready -->`;

interface Rig {
  poolDir: string;
  server: PoolServer;
}

async function startRig(
  config: Partial<PoolConfig> = {},
  options: { start?: boolean; behaviour?: Parameters<typeof stubHarness>[1] } = {},
): Promise<Rig> {
  const poolDir = makePool({
    tickets: [
      { file: "01-a.md", marker: READY("01") },
      { file: "02-b.md", marker: READY("02", "01") },
    ],
    config: { ...STUB_DEFAULTS, ...config },
  });
  const server = createPoolServer({
    poolDir,
    port: 0,
    harnesses: stubHarness(poolDir, options.behaviour ?? {}).harnesses,
    distDir: "/nonexistent",
    registryPath: join(poolDir, "fleet.json"),
  });
  servers.push(server);
  if (options.start !== false) {
    await server.start();
    await server.settled();
  }
  return { poolDir, server };
}

function onDisk(poolDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(poolDir, "console.json"), "utf8"));
}

function putReassign(server: PoolServer, body: unknown): Promise<Response> {
  return fetch(`${server.url}/api/reassign`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ticket(snapshot: EnrichedSnapshot, id: string): EnrichedTicketState {
  const found = snapshot.state.tickets.find((t) => t.id === id);
  if (!found) throw new Error(`no ticket ${id} in the snapshot`);
  return found;
}

async function getState(server: PoolServer): Promise<EnrichedSnapshot> {
  const res = await fetch(`${server.url}/api/state`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { snapshot: EnrichedSnapshot }).snapshot;
}

describe("the snapshot's Reassign rows", () => {
  it("carries eligibility and per-field sources on every ticket", async () => {
    const { server } = await startRig({ assign: { "02": { model: "opus" } } });

    const state = await getState(server);

    expect(ticket(state, "02").reassign.sources).toEqual({
      harness: "default",
      model: "pinned",
      effort: "unset",
      drivers: "default",
    });
    expect(ticket(state, "02").assignment).toEqual({
      harness: "stub",
      model: "opus",
      drivers: "implement",
    });
    // Both tickets ran to done in this rig, so both are read-only now.
    expect(ticket(state, "01").reassign.eligible).toBe(false);
    expect(ticket(state, "01").reassign.reason).toBe("done");
  });

  // The file is the source of truth, so a Reassign merges over whatever is
  // there now, not over the config the engine's session is still running on.
  it("merges over a hand edit made since the last boundary", async () => {
    const { poolDir, server } = await startRig(
      {},
      { start: false, behaviour: { "01": { waitFor: "/nonexistent-forever" } } },
    );
    await server.start();

    writeFileSync(
      join(poolDir, "console.json"),
      JSON.stringify({ ...STUB_DEFAULTS, assign: { "02": { drivers: "by-hand" } } }),
    );

    const res = await putReassign(server, { tickets: ["02"], fields: { model: "opus" } });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as ReassignResponse;

    expect(onDisk(poolDir).assign).toEqual({ "02": { drivers: "by-hand", model: "opus" } });
    expect(ticket(answer.snapshot, "02").assignment).toEqual({
      harness: "stub",
      model: "opus",
      drivers: "by-hand",
    });
  });

  // The engine's reload seeds every in-flight ticket with its frozen record
  // before resolving the rest (ADR-0018), so a child of an in-flight parent
  // must show what it will really inherit, not what the file's new default
  // would give it. This is the wiring: the server hands the module the
  // engine's own assignments from the snapshot.
  it("shows a spawned child inheriting its in-flight parent's frozen model", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: READY("01") },
        {
          file: "01-spawn-1.md",
          marker: `${READY("01-spawn-1", "01").slice(0, -4)} spawned-by=01 -->`,
        },
      ],
      config: { defaults: { harness: "stub", model: "model-a" } },
    });
    const server = createPoolServer({
      poolDir,
      port: 0,
      harnesses: stubHarness(poolDir, {
        "01": { waitFor: "/nonexistent-forever" },
      }).harnesses,
      distDir: "/nonexistent",
      registryPath: join(poolDir, "fleet.json"),
    });
    servers.push(server);
    await server.start();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (ticket(await getState(server), "01").liveAttempt !== null) break;
      await Bun.sleep(20);
    }

    // The pool default moves while 01's Attempt holds its own Assignment.
    writeFileSync(
      join(poolDir, "console.json"),
      JSON.stringify({ defaults: { harness: "stub", model: "model-b" } }),
    );

    const res = await putReassign(server, {
      tickets: ["01-spawn-1"],
      fields: { drivers: "review" },
    });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as ReassignResponse;

    expect(ticket(answer.snapshot, "01").assignment.model).toBe("model-a");
    expect(ticket(answer.snapshot, "01-spawn-1").assignment).toEqual({
      harness: "stub",
      model: "model-a",
      drivers: "review",
    });
  });
});

describe("PUT /api/reassign", () => {
  it("writes the file and answers with a snapshot already showing it", async () => {
    // A ticket held open so 02 never runs and stays reassignable.
    const { poolDir, server } = await startRig(
      {},
      { start: false, behaviour: { "01": { waitFor: "/nonexistent-forever" } } },
    );
    await server.start();

    const body: ReassignRequest = {
      tickets: ["02"],
      fields: { harness: "stub", model: "opus", verify: 2 },
    };
    const res = await putReassign(server, body);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as ReassignResponse;

    expect(answer.applied).toEqual(["02"]);
    expect(answer.skipped).toEqual([]);
    expect(onDisk(poolDir).assign).toEqual({
      "02": { harness: "stub", model: "opus", verify: 2 },
    });

    const row = ticket(answer.snapshot, "02");
    expect(row.assignment).toEqual({
      harness: "stub",
      model: "opus",
      drivers: "implement",
    });
    expect(row.reassign.verify).toBe(2);
    expect(row.reassign.sources).toEqual({
      harness: "pinned",
      model: "pinned",
      effort: "unset",
      drivers: "default",
    });
  });

  it("answers 400 { error } naming the ticket, and leaves the file alone", async () => {
    const { poolDir, server } = await startRig(
      {},
      { start: false, behaviour: { "01": { waitFor: "/nonexistent-forever" } } },
    );
    await server.start();
    const before = onDisk(poolDir);

    const res = await putReassign(server, {
      tickets: ["02"],
      fields: { harness: "gemini" },
    });

    expect(res.status).toBe(400);
    const answer = (await res.json()) as { error: string };
    expect(answer.error).toContain("unknown harness 'gemini'");
    expect(onDisk(poolDir)).toEqual(before);
  });

  it("answers 400 for an id the pool does not own", async () => {
    const { server } = await startRig(
      {},
      { start: false, behaviour: { "01": { waitFor: "/nonexistent-forever" } } },
    );
    await server.start();

    const res = await putReassign(server, { tickets: ["99"], fields: { model: "opus" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "unknown ticket '99'",
    );
  });

  // The card is read-only while the Attempt runs, and a save aimed at it is
  // reported back rather than applied behind the operator's back.
  it("shows an in-flight ticket as read-only and skips a write to it", async () => {
    const { poolDir, server } = await startRig(
      {},
      { start: false, behaviour: { "01": { waitFor: "/nonexistent-forever" } } },
    );
    await server.start();

    const deadline = Date.now() + 5000;
    let live = false;
    while (!live && Date.now() < deadline) {
      const state = await getState(server);
      live = ticket(state, "01").liveAttempt !== null;
      if (!live) await Bun.sleep(20);
    }
    expect(live).toBe(true);

    const state = await getState(server);
    expect(ticket(state, "01").reassign.eligible).toBe(false);
    expect(ticket(state, "01").reassign.reason).toBe("an Attempt is running");

    const res = await putReassign(server, {
      tickets: ["01", "02"],
      fields: { model: "opus" },
    });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as ReassignResponse;
    expect(answer.applied).toEqual(["02"]);
    expect(answer.skipped).toEqual([{ id: "01", reason: "an Attempt is running" }]);
    expect(onDisk(poolDir).assign).toEqual({ "02": { model: "opus" } });
  });
});
