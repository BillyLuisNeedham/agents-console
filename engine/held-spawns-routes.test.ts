/// <reference types="bun" />

/**
 * The Held spawn routes (issue #149, ADR-0029). The engine's own cases cover
 * what holding, adopting and discarding do to the pool; these cover the
 * seam: that the held list and the Spawn usage ride on every snapshot, that
 * Adopt and Discard answer in the keep-talking convention (a 400 for a
 * request with no id, a 409 `reason` for one the engine refuses), and that
 * the snapshot after either shows it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createPoolServer, type PoolServer } from "./server.ts";
import type { HeldSpawnResponse } from "./wire.ts";
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
        id: "held-1",
        parentId: "01",
        origin: "ticket",
        kind: "ticket",
        title: "Held",
        body: BODY,
        blockedBy: [],
        blocks: null,
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

    const res = await post(server, "/api/spawns/held/adopt", { id: "held-1" });

    expect(res.status).toBe(202);
    expect((await res.json()) as HeldSpawnResponse).toEqual({ id: "held-1" });
    await server.settled();
    expect(server.latest?.heldSpawns).toEqual([]);
    expect(server.latest?.state.tickets.map((t) => t.id)).toContain("01-spawn-2");
  });

  it("answers a 409 with the reason for an id the pool does not hold", async () => {
    const server = await startRig();
    const res = await post(server, "/api/spawns/held/adopt", { id: "held-7" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("no held spawn held-7");
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

    const res = await post(server, "/api/spawns/held/discard", { id: "held-1" });

    expect(res.status).toBe(200);
    expect((await res.json()) as HeldSpawnResponse).toEqual({ id: "held-1" });
    expect(server.latest?.heldSpawns).toEqual([]);

    const again = await post(server, "/api/spawns/held/discard", { id: "held-1" });
    expect(again.status).toBe(409);
  });
});
