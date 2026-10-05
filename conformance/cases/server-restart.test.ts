/**
 * The Restart hand-off end to end (the inventory's ticket C03, its `server`
 * gap at engine/server.ts:2821): POST /api/restart stops this server and
 * hands the pool to Boot, and the Boot it starts brings a new server up on
 * the port the reply promised. The route cases (settings-routes.test.ts)
 * stand a recorder in for Boot; here the real one runs, so the case reads
 * what it leaves: runs/boot.log, a new pid in runs/server.pid, and a server
 * answering on the promised port.
 *
 * Boot opens the Console in a browser once its server answers, so the
 * browser opener is a recorder first on the server's PATH, inherited by the
 * Boot it starts. The Boot and the server it starts outlive the server the
 * case started, so teardown stops the server runs/server.pid names.
 */

import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RestartResponse } from "../../protocol/wire.ts";
import { CLOSE_STOPPED } from "../fixtures/socket-protocol.ts";
import { conformance } from "../harness/case.ts";
import { ensureUiBuilt } from "../harness/cli.ts";
import { until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import { CONFIG, readLock, ticket, untilSnapshot } from "./server-support.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * `xdg-open` and `open` that write down the URL they were given rather than
 * open it, first on the PATH this returns for the server.
 */
function browserRecorder(world: World): string {
  const bin = join(world.root, "opener-bin");
  const calls = join(world.root, "opener.calls");
  mkdirSync(bin, { recursive: true });
  for (const name of ["xdg-open", "open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return `${bin}:${world.env("").PATH}`;
}

/** SIGTERM the server runs/server.pid names, unless it is `except`, and wait for it to go. */
async function stopRelaunched(world: World, except: number): Promise<void> {
  const pid = Number(readLock(world.pool)?.trim());
  if (!Number.isInteger(pid) || pid <= 0 || pid === except || !alive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(25);
  if (alive(pid)) process.kill(pid, "SIGKILL");
}

// The gap at engine/server.ts:2821.
conformance(
  "server",
  "the Restart hand-off › POST /api/restart answers its port, says farewell and exits 0, and the Boot it hands the pool to brings a new server up on that port",
  async (t) => {
    // Boot rebuilds a stale Console build before it starts a server; the
    // Bun build is brought up to date first, as the Boot cases do.
    if (t.kind === "bun") await ensureUiBuilt();
    const world = t.world({ tickets: [ticket("01", { status: "done" })], config: CONFIG });
    const server = await t.start(world, { env: { PATH: browserRecorder(world) } });
    t.defer(() => stopRelaunched(world, server.pid));
    await untilSnapshot(server, (snapshot) => snapshot.phase === "quiescent", "the pool to settle at its Review");
    const bootLog = join(world.pool, "runs", "boot.log");
    expect(existsSync(bootLog)).toBe(false);
    const tab = await t.socket(server);
    await tab.sync();

    const answer = await server.http.post("/api/restart");
    expect(answer.status).toBe(202);
    expect(answer.json<RestartResponse>()).toEqual({ ok: true, port: server.port });

    // The farewell, then the exit.
    expect(await tab.closed).toEqual(CLOSE_STOPPED);
    expect(tab.pushed?.snapshot.phase).toBe("stopped");
    const code = await until(() => server.exitCode(), (got) => got !== null, { ms: 30_000, what: "the server to exit" });
    expect(code).toBe(0);

    // Boot's report, in the log the hand-off made for it.
    const consoleLine = `Console on http://localhost:${server.port}`;
    await until(() => readIfPresent(bootLog), (text) => text.split("\n").includes(consoleLine), {
      ms: 90_000,
      what: `runs/boot.log to say ${consoleLine}`,
    });

    // A new server holds the pool and answers on the promised port.
    const pid = Number(readLock(world.pool)?.trim());
    expect(pid).not.toBe(server.pid);
    expect(alive(pid)).toBe(true);
    const state = await fetch(`http://localhost:${server.port}/api/state`);
    expect(state.status).toBe(200);
    await state.arrayBuffer();
  },
  { timeoutMs: 180_000 },
);
