/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPoolServer,
  type PoolServer,
  type PoolServerOptions,
} from "./server.ts";
import { readFleetEntries } from "./fleet.ts";
import { REVIEW_TICKET_ID, type HarnessCommand, type PoolConfig } from "./engine.ts";

const servers: PoolServer[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    void server.close();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makePool(
  tickets: { file: string; marker: string }[],
  config: Partial<PoolConfig> = {},
): string {
  const poolDir = mkdtempSync(join(tmpdir(), "pool-server-"));
  tempDirs.push(poolDir);
  mkdirSync(join(poolDir, "issues"), { recursive: true });
  for (const ticket of tickets) {
    writeFileSync(join(poolDir, "issues", ticket.file), `${ticket.marker}\n\n# body\n`);
  }
  writeFileSync(
    join(poolDir, "console.json"),
    JSON.stringify(
      { defaults: { harness: "stub", model: "m" }, ...config } satisfies PoolConfig,
      null,
      2,
    ),
  );
  return poolDir;
}

function stubHarness(behaviour: Record<string, ("done" | "checkpoint")[]>): Record<string, HarnessCommand> {
  const poolLocal = tempDirs[tempDirs.length - 1];
  const stubPath = join(poolLocal, "stub-harness.sh");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'issue="$1"; status="$2"',
      'sed -i "1s/status=[a-z-]*/status=$status/" "$issue"',
      'printf \'{"summary":"smoke","commitSha":null}\' > "$3"',
      "exit 0",
      "",
    ].join("\n"),
  );
  const counts: Record<string, number> = {};
  const harness: HarnessCommand = (ctx) => {
    const statuses = behaviour[ctx.id] ?? ["done"];
    const n = counts[ctx.id] ?? 0;
    counts[ctx.id] = n + 1;
    const status = statuses[Math.min(n, statuses.length - 1)];
    return ["bash", stubPath, ctx.issuePath, status, ctx.outcomePath];
  };
  return { stub: harness };
}

/** A temp registry path inside the pool dir, so tests never touch the real one. */
function fleetRegistry(poolDir: string): string {
  return join(poolDir, "fleet.json");
}

async function startServer(poolDir: string, harnesses: Record<string, HarnessCommand>): Promise<PoolServer> {
  const server = createPoolServer({
    poolDir,
    port: 0,
    harnesses,
    distDir: "/nonexistent",
    registryPath: fleetRegistry(poolDir),
  });
  servers.push(server);
  return server;
}

describe("pool server", () => {
  it("drives a pool to the review gate and serves the enriched state", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=01 status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}));

    const snapshot = await server.start();
    expect(snapshot.phase).toBe("quiescent");
    expect(snapshot.state.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const statuses = Object.fromEntries(snapshot.state.tickets.map((t) => [t.id, t.status]));
    expect(statuses).toEqual({ "01": "done", "02": "done" });
    expect(snapshot.state.tickets.map((t) => t.blockedBy)).toEqual([[], ["01"]]);
    expect(snapshot.state.tickets.map((t) => t.title)).toEqual(["body", "body"]);

    // Approving the review ends the run; the server stays up with the final
    // state inspectable.
    const approved = await server.answer(REVIEW_TICKET_ID, "approve");
    expect(approved.phase).toBe("done");
    expect(approved.state.interrupts).toEqual([]);
    expect(server.latest?.phase).toBe("done");
  });

  it("serves get state, start, and resume over HTTP", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({ "01": ["checkpoint", "done"] }));

    const first = await server.start();
    expect(first.phase).toBe("quiescent");
    expect(first.state.interrupts[0]?.kind).toBe("checkpoint");
    expect(first.state.tickets[0]?.status).toBe("checkpoint");

    const stateRes = await fetch(`${server.url}/api/state`);
    const stateBody = (await stateRes.json()) as { snapshot: typeof first };
    expect(stateBody.snapshot.phase).toBe("quiescent");

    const resumeRes = await fetch(`${server.url}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: "01", action: "resume", note: "go on" }),
    });
    const resumeBody = (await resumeRes.json()) as { snapshot: typeof first };
    expect(resumeBody.snapshot.phase).toBe("quiescent");
    expect(resumeBody.snapshot.state.tickets[0]?.status).toBe("done");
    expect(resumeBody.snapshot.state.interrupts[0]?.kind).toBe("review");

    const approveRes = await fetch(`${server.url}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: REVIEW_TICKET_ID, action: "approve" }),
    });
    const approveBody = (await approveRes.json()) as { snapshot: typeof first };
    expect(approveBody.snapshot.phase).toBe("done");
  });

  it("streams the latest snapshot to an SSE client on connect", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}));
    await server.start();
    await server.answer(REVIEW_TICKET_ID, "approve");

    const res = await fetch(`${server.url}/api/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let data = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !data.includes('"phase"')) {
      const { value, done } = await reader!.read();
      if (done) break;
      data += decoder.decode(value, { stream: true });
    }
    expect(data).toContain("event: snapshot");
    expect(data).toContain('"phase":"done"');
    reader!.cancel();
  });

  it("keeps the stream open through more than ten seconds of a quiet pool", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({ "01": ["checkpoint", "done"] }));
    await server.start();
    // The pool now waits at the checkpoint interrupt: the stream goes silent.

    const res = await fetch(`${server.url}/api/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let data = "";
    while (!data.includes('"phase"')) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed before the replayed snapshot");
      data += decoder.decode(value, { stream: true });
    }

    // A dropped stream rejects the pending read rather than ending cleanly.
    let closed = false;
    const nextFrame = reader.read().then(
      ({ done }) => {
        if (done) closed = true;
      },
      () => {
        closed = true;
      },
    );
    // The default ten-second timeout's close reaches the client a couple of
    // seconds late, so wait well past both.
    await Bun.sleep(14_000);
    expect(closed).toBe(false);

    // The same connection still delivers the next broadcast after the silence.
    await server.answer("01", "resume");
    const arrived = await Promise.race([
      nextFrame.then(() => true),
      Bun.sleep(3000).then(() => false),
    ]);
    expect(arrived).toBe(true);
    expect(closed).toBe(false);
    reader.cancel();
  }, 25_000);
});

describe("ticket events endpoint", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("serves a ticket's parsed events after a run", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));
    await server.start();
    await server.answer(REVIEW_TICKET_ID, "approve");

    const res = await fetch(`${server.url}/api/events?ticket=01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { at: string; attempt: number; kind: string; payload: Record<string, unknown> }[];
      attempts: unknown[];
      reconstructed: boolean;
    };
    expect(body.reconstructed).toBe(false);
    expect(body.attempts).toEqual([]);
    expect(body.events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
    ]);
    expect(body.events[0].attempt).toBe(1);
    expect(typeof body.events[0].at).toBe("string");
    const exited = body.events.find((e) => e.kind === "exited");
    expect(exited?.payload).toEqual({ code: 0, status: "done" });
  });

  it("backfills reconstructed attempt rows for a ticket with no events file", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "first attempt output\n");
    writeFileSync(join(runsDir, "01.attempt-2.log"), "second attempt output\n");
    // Distinct modification times, so the reconstruction orders the attempts
    // the way they happened.
    const now = Date.now();
    utimesSync(join(runsDir, "01.log"), new Date(now - 60_000), new Date(now - 60_000));
    utimesSync(join(runsDir, "01.attempt-2.log"), new Date(now), new Date(now));

    const server = await startServer(poolDir, stubHarness({}));
    const res = await fetch(`${server.url}/api/events?ticket=01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      attempts: { attempt: number; logFile: string; modifiedAt: string }[];
      reconstructed: boolean;
    };
    expect(body.reconstructed).toBe(true);
    expect(body.events).toEqual([]);
    expect(body.attempts).toEqual([
      {
        attempt: 1,
        logFile: "01.log",
        modifiedAt: new Date(now - 60_000).toISOString(),
      },
      {
        attempt: 2,
        logFile: "01.attempt-2.log",
        modifiedAt: new Date(now).toISOString(),
      },
    ]);
  });

  it("rejects a ticket id the pool does not own", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/events?ticket=zzz`);
    expect(res.status).toBe(404);
  });
});

function writePidFile(poolDir: string, pid: number): void {
  mkdirSync(join(poolDir, "runs"), { recursive: true });
  writeFileSync(join(poolDir, "runs", "server.pid"), `${pid}\n`);
}

/** A real pid that has exited and been reaped, so it probes as dead. */
function deadPid(): number {
  const child = spawnSync("true");
  if (!child.pid) throw new Error("failed to spawn a child for a dead pid");
  return child.pid;
}

function makeLockedPool(): string {
  return makePool([
    { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
  ]);
}

describe("pool lock", () => {
  it("writes its own pid on a successful boot", () => {
    const poolDir = makeLockedPool();
    const server = createPoolServer({ poolDir, port: 0, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(readFileSync(join(poolDir, "runs", "server.pid"), "utf8").trim()).toBe(
      `${process.pid}`,
    );
  });

  it("refuses a live lock, naming the live pid and the pool directory", () => {
    const poolDir = makeLockedPool();
    writePidFile(poolDir, process.pid);
    let message = "";
    try {
      createPoolServer({ poolDir, port: 0, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(process.pid));
    expect(message).toContain(poolDir);
    expect(message).not.toContain("on port");
  });

  it("names the live server's port when the registry knows it", () => {
    const poolDir = makeLockedPool();
    writePidFile(poolDir, process.pid);
    const registryPath = join(poolDir, "pools.json");
    writeFileSync(
      registryPath,
      JSON.stringify([
        { poolDir, port: 8799, pid: process.pid, startedAt: "t" },
      ]),
    );
    expect(() =>
      createPoolServer({ poolDir, port: 0, distDir: "/nonexistent", registryPath }),
    ).toThrow("on port 8799");
  });

  it("takes over a stale pid file on boot", () => {
    const poolDir = makeLockedPool();
    writePidFile(poolDir, deadPid());
    const server = createPoolServer({ poolDir, port: 0, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(readFileSync(join(poolDir, "runs", "server.pid"), "utf8").trim()).toBe(
      `${process.pid}`,
    );
  });

  it("takes over a pid file that is not a positive integer", () => {
    for (const bogus of ["0", "-1", "not-a-pid", ""]) {
      const poolDir = makeLockedPool();
      mkdirSync(join(poolDir, "runs"), { recursive: true });
      writeFileSync(join(poolDir, "runs", "server.pid"), bogus);
      const server = createPoolServer({ poolDir, port: 0, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
      servers.push(server);
      expect(readFileSync(join(poolDir, "runs", "server.pid"), "utf8").trim()).toBe(
        `${process.pid}`,
      );
    }
  });

  it("has no force override: a live lock refuses even when forced", () => {
    const poolDir = makeLockedPool();
    writePidFile(poolDir, process.pid);
    const forced = {
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath: fleetRegistry(poolDir),
      force: true,
    } as unknown as PoolServerOptions;
    expect(() => createPoolServer(forced)).toThrow(/locked by live server/);
  });

  it("exits non-zero from the CLI against a live lock, naming pid and pool", async () => {
    const poolDir = makeLockedPool();
    writePidFile(poolDir, process.pid);
    const repoDir = join(import.meta.dir, "..");
    const child = Bun.spawn(
      ["bun", "run", "engine/server.ts", "--pool", poolDir, "--port", "8799"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(String(process.pid));
    expect(stderr).toContain(poolDir);
  });
});

const portMarker = "<!-- state: id=01 blocked-by=none status=ready -->";

/** Bind a real socket on an ephemeral port and keep it open. */
async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("held") });
  const port = server.port;
  if (port === undefined) throw new Error("failed to bind an ephemeral port");
  return { port, release: () => server.stop(true) };
}

/** A port that is free right now, on an ephemeral range. */
async function freePort(): Promise<number> {
  const held = await holdPort();
  const port = held.port;
  await held.release();
  return port;
}

describe("pinned pool ports", () => {
  it("binds the console.json port on every launch", async () => {
    const port = await freePort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }], { port });
    const serverA = createPoolServer({ poolDir, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(serverA);
    expect(serverA.url).toBe(`http://localhost:${port}`);
    await serverA.close();
    // Relaunch the same pool: the previous server is gone, so its pid is stale
    // and the lock lets the new boot take over and bind the same pin.
    writePidFile(poolDir, deadPid());
    const serverB = createPoolServer({ poolDir, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(serverB);
    expect(serverB.url).toBe(`http://localhost:${port}`);
  });

  it("a failed pinned bind clears the lock it claimed, so a retry can boot", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }], { port: held.port });
    let message = "";
    try {
      createPoolServer({ poolDir, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(held.port));
    // The failed boot must not leave a live-looking pid, or the retry refuses.
    expect(existsSync(join(poolDir, "runs", "server.pid"))).toBe(false);
    await held.release();
    const server = createPoolServer({ poolDir, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).toBe(`http://localhost:${held.port}`);
  });

  it("refuses a busy console.json pin, naming the port", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }], { port: held.port });
    let message = "";
    try {
      createPoolServer({ poolDir, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(held.port));
    await held.release();
  });

  it("refuses a busy --port pin, naming the port", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }]);
    let message = "";
    try {
      createPoolServer({ poolDir, port: held.port, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(held.port));
    await held.release();
  });

  it("--port overrides the console.json pin for that launch", async () => {
    const configPort = await freePort();
    const flagPort = await freePort();
    expect(flagPort).not.toBe(configPort);
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }], { port: configPort });
    const server = createPoolServer({ poolDir, port: flagPort, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).toBe(`http://localhost:${flagPort}`);
  });

  it("with no pin, binds the default port when it is free", async () => {
    const port = await freePort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }]);
    const server = createPoolServer({ poolDir, defaultPort: port, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).toBe(`http://localhost:${port}`);
  });

  it("with no pin, hunts to the next free port when the default is busy", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }]);
    const server = createPoolServer({ poolDir, defaultPort: held.port, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).not.toBe(`http://localhost:${held.port}`);
    expect(server.url).toMatch(/^http:\/\/localhost:\d+$/);
    await held.release();
  });

  it("exits non-zero from the CLI when a --port pin is busy, naming the port", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }]);
    const repoDir = join(import.meta.dir, "..");
    const child = Bun.spawn(
      ["bun", "run", "engine/server.ts", "--pool", poolDir, "--port", String(held.port)],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(String(held.port));
    await held.release();
  });
});

describe("fleet registration", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("upserts its entry in the registry after a successful bind", () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const registryPath = fleetRegistry(poolDir);
    const server = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(server);
    const entries = readFleetEntries(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      poolDir,
      pid: process.pid,
    });
    expect(typeof entries[0].port).toBe("number");
    expect(typeof entries[0].startedAt).toBe("string");
    expect(entries[0].port).toBe(Number(new URL(server.url).port));
  });

  it("relaunching the same pool updates the entry rather than duplicating", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const registryPath = fleetRegistry(poolDir);
    const serverA = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(serverA);
    const portA = Number(new URL(serverA.url).port);
    expect(readFleetEntries(registryPath)).toHaveLength(1);

    // Stop the first server and stale its pid, then relaunch: the pool's lock
    // passes, so the new server binds and upserts its own entry in place.
    await serverA.close();
    writePidFile(poolDir, deadPid());
    const serverB = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(serverB);
    const portB = Number(new URL(serverB.url).port);
    const entries = readFleetEntries(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(process.pid);
    expect(entries[0].port).toBe(portB);
  });

  it("a corrupt registry file is recreated on write, not a boot failure", () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const registryPath = fleetRegistry(poolDir);
    writeFileSync(registryPath, "{ not json");
    const server = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(server);
    expect(readFleetEntries(registryPath)).toHaveLength(1);
  });

  it("an absent registry is created on write, not a boot failure", () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const registryPath = join(poolDir, "nested", "pools.json");
    const server = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(server);
    expect(readFleetEntries(registryPath)).toHaveLength(1);
  });

  it("a failed bind registers nothing", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker }], { port: held.port });
    const registryPath = fleetRegistry(poolDir);
    let message = "";
    try {
      createPoolServer({ poolDir, distDir: "/nonexistent", registryPath });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(held.port));
    // Registration happens only after a successful bind: a failed boot must
    // never advertise a port in the registry.
    expect(readFleetEntries(registryPath)).toEqual([]);
    await held.release();
  });
});
