/// <reference types="bun" />

/**
 * The Held spawn routes (issue #149, ADR-0029) and the Pending spawn routes
 * (issue #150). The engine's own cases cover what holding, adopting and
 * discarding do to the pool; these cover the seam: that the pending and
 * held lists and the Spawn usage ride on every snapshot, that Adopt,
 * Discard and Hold answer in the keep-talking convention (a 400 for a
 * request with no id, a 409 `reason` for one the engine refuses), and that
 * the snapshot after each shows it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoolServer, type PoolServer } from "./server.ts";
import type { HeldSpawnResponse, PendingSpawnResponse } from "./wire.ts";
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

const BODY = "A body long enough to stand as a ticket.";

/** A pool whose one ticket proposes two follow-ups under a per-attempt cap
 *  of one, so the second is held once the pool settles. */
async function startRig(): Promise<PoolServer> {
  const poolDir = makePool({
    tickets: [{ file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" }],
    config: { ...STUB_DEFAULTS, spawnCaps: { perAttempt: 1 } },
  });
  const server = createPoolServer({
    poolDir,
    port: 0,
    harnesses: stubHarness(poolDir, {
      "01": {
        spawn: [
          { title: "Adopted", body: BODY },
          { title: "Held", body: BODY },
        ],
      },
    }).harnesses,
    distDir: "/nonexistent",
    registryPath: join(poolDir, "fleet.json"),
  });
  servers.push(server);
  await server.start();
  await server.settled();
  return server;
}

function post(server: PoolServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("held spawns on the snapshot", () => {
  it("carries every held spawn and the Spawn usage", async () => {
    const server = await startRig();
    expect(server.latest?.heldSpawns).toEqual([
      {
        id: "proposal-2",
        parentId: "01",
        origin: "ticket",
        kind: "ticket",
        title: "Held",
        body: BODY,
        blockedBy: [],
        blocks: null,
        overlaps: [],
        reason: "per-attempt",
        at: expect.any(String),
        adopting: false,
      },
    ]);
    expect(server.latest?.spawnUsage).toEqual({
      spawnedThisRun: 1,
      perAttempt: 1,
      perRun: 20,
    });
  });
});

describe("POST /api/spawns/held/adopt", () => {
  it("adopts a held spawn past the caps and the next snapshot shows its ticket", async () => {
    const server = await startRig();

    const res = await post(server, "/api/spawns/held/adopt", { id: "proposal-2" });

    expect(res.status).toBe(202);
    expect((await res.json()) as HeldSpawnResponse).toEqual({ id: "proposal-2" });
    await server.settled();
    expect(server.latest?.heldSpawns).toEqual([]);
    expect(server.latest?.state.tickets.map((t) => t.id)).toContain("01-spawn-2");
  });

  it("answers a 409 with the reason for an id the pool does not hold", async () => {
    const server = await startRig();
    const res = await post(server, "/api/spawns/held/adopt", { id: "proposal-7" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("no held spawn proposal-7");
  });

  it("answers a 400 for a body with no id", async () => {
    const server = await startRig();
    const res = await post(server, "/api/spawns/held/adopt", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("id is required");
  });
});

describe("POST /api/spawns/held/discard", () => {
  it("discards a held spawn and the snapshot drops it", async () => {
    const server = await startRig();

    const res = await post(server, "/api/spawns/held/discard", { id: "proposal-2" });

    expect(res.status).toBe(200);
    expect((await res.json()) as HeldSpawnResponse).toEqual({ id: "proposal-2" });
    expect(server.latest?.heldSpawns).toEqual([]);

    const again = await post(server, "/api/spawns/held/discard", { id: "proposal-2" });
    expect(again.status).toBe(409);
  });
});

/** A pool whose ticket 01 proposes two follow-ups while 02, in the same
 *  super-step, is held open: both wait as Pending spawns until 02 is
 *  released. */
async function startPendingRig(): Promise<{ server: PoolServer; release: string }> {
  const poolDir = makePool({
    tickets: [
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
    ],
    config: STUB_DEFAULTS,
  });
  const release = join(poolDir, "release-02");
  const server = createPoolServer({
    poolDir,
    port: 0,
    harnesses: stubHarness(poolDir, {
      "01": {
        spawn: [
          { title: "Keep back", body: BODY },
          { title: "Drop", body: BODY },
        ],
      },
      "02": { waitFor: release },
    }).harnesses,
    distDir: "/nonexistent",
    registryPath: join(poolDir, "fleet.json"),
  });
  servers.push(server);
  await server.start();
  const deadline = Date.now() + 10000;
  while ((server.latest?.pendingSpawns.length ?? 0) < 2) {
    if (Date.now() > deadline) throw new Error("no pending spawns arrived");
    await Bun.sleep(20);
  }
  return { server, release };
}

describe("pending spawns on the snapshot", () => {
  it("carries every Pending spawn until the boundary lands it", async () => {
    const { server, release } = await startPendingRig();
    expect(server.latest?.pendingSpawns).toEqual([
      {
        id: "proposal-1",
        parentId: "01",
        origin: "ticket",
        kind: "ticket",
        title: "Keep back",
        body: BODY,
        blockedBy: [],
        blocks: null,
        overlaps: [],
        at: expect.any(String),
      },
      expect.objectContaining({ id: "proposal-2", title: "Drop" }),
    ]);
    writeFileSync(release, "");
    await server.settled();
    expect(server.latest?.pendingSpawns).toEqual([]);
    expect(server.latest?.state.tickets.map((t) => t.id)).toContain("01-spawn-2");
  });
});

describe("POST /api/spawns/pending/hold and /discard", () => {
  it("holds one and discards another before the boundary, and refuses both once it has landed", async () => {
    const { server, release } = await startPendingRig();

    const hold = await post(server, "/api/spawns/pending/hold", { id: "proposal-1" });
    expect(hold.status).toBe(200);
    expect((await hold.json()) as PendingSpawnResponse).toEqual({ id: "proposal-1" });
    expect(server.latest?.heldSpawns.map((h) => [h.id, h.reason])).toEqual([
      ["proposal-1", "operator"],
    ]);

    const again = await post(server, "/api/spawns/pending/hold", { id: "proposal-1" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { reason: string }).reason).toBe(
      "spawn proposal-1 is already held",
    );

    const discard = await post(server, "/api/spawns/pending/discard", { id: "proposal-2" });
    expect(discard.status).toBe(200);
    expect(server.latest?.pendingSpawns).toEqual([]);

    writeFileSync(release, "");
    await server.settled();
    expect(server.latest?.state.tickets.map((t) => t.id)).not.toContain("01-spawn-1");
    expect(server.latest?.heldSpawns.map((h) => h.id)).toEqual(["proposal-1"]);
  });

  it("answers a 409 for a spawn that has already landed", async () => {
    const { server, release } = await startPendingRig();
    writeFileSync(release, "");
    await server.settled();

    const res = await post(server, "/api/spawns/pending/discard", { id: "proposal-1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "no pending spawn proposal-1: it has landed or been discarded",
    );
  });

  it("answers a 400 for a body with no id", async () => {
    const server = await startRig();
    const res = await post(server, "/api/spawns/pending/hold", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("id is required");
  });
});
