/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** A real pid that has exited and been reaped, so it probes as dead. */
function deadPid(): number {
  const child = spawnSync("true");
  if (!child.pid) throw new Error("failed to spawn a child for a dead pid");
  return child.pid;
}

/** Run the real fleet command against a registry path, capturing its output. */
async function runFleetCli(
  registryPath: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const repoDir = join(import.meta.dir, "..");
  const child = Bun.spawn(
    ["bun", "run", "engine/fleet-cli.ts", "--registry", registryPath],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  return { exitCode, stdout, stderr };
}

describe("fleet list command", () => {
  it("lists every live pool as poolDir → http://localhost:<port>, one per line", async () => {
    const dir = tempDir();
    const poolA = join(dir, "pool-a");
    const poolB = join(dir, "pool-b");
    mkdirSync(poolA, { recursive: true });
    mkdirSync(poolB, { recursive: true });
    const registry = join(dir, "pools.json");
    writeFileSync(
      registry,
      JSON.stringify([
        { poolDir: poolA, port: 8787, pid: process.pid, startedAt: "t" },
        { poolDir: poolB, port: 8799, pid: process.pid, startedAt: "t" },
      ]),
    );
    const { exitCode, stdout, stderr } = await runFleetCli(registry);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toEqual([
      `${poolA} → http://localhost:8787`,
      `${poolB} → http://localhost:8799`,
    ]);
  });

  it("prunes dead-pid and missing-poolDir entries, printing only live pools", async () => {
    const dir = tempDir();
    const livePool = join(dir, "live");
    const deadPoolDir = join(dir, "dead-pool");
    mkdirSync(livePool, { recursive: true });
    mkdirSync(deadPoolDir, { recursive: true });
    const gonePoolDir = join(dir, "gone");
    const registry = join(dir, "pools.json");
    writeFileSync(
      registry,
      JSON.stringify([
        { poolDir: livePool, port: 8787, pid: process.pid, startedAt: "t" },
        { poolDir: deadPoolDir, port: 8790, pid: deadPid(), startedAt: "t" },
        { poolDir: gonePoolDir, port: 8791, pid: process.pid, startedAt: "t" },
      ]),
    );
    const { exitCode, stdout } = await runFleetCli(registry);
    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toEqual([
      `${livePool} → http://localhost:8787`,
    ]);
  });

  it("prints the no-live-consoles line for an absent registry and exits zero", async () => {
    const registry = join(tempDir(), "pools.json");
    const { exitCode, stdout } = await runFleetCli(registry);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("no live consoles");
  });

  it("prints the no-live-consoles line for an empty registry and exits zero", async () => {
    const dir = tempDir();
    const registry = join(dir, "pools.json");
    writeFileSync(registry, JSON.stringify([]));
    const { exitCode, stdout } = await runFleetCli(registry);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("no live consoles");
  });

  it("prints the no-live-consoles line when every entry is pruned", async () => {
    const dir = tempDir();
    const poolDir = join(dir, "pool");
    mkdirSync(poolDir, { recursive: true });
    const registry = join(dir, "pools.json");
    writeFileSync(
      registry,
      JSON.stringify([
        { poolDir, port: 8787, pid: deadPid(), startedAt: "t" },
      ]),
    );
    const { exitCode, stdout } = await runFleetCli(registry);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("no live consoles");
  });

  it("never rewrites the registry file it reads", async () => {
    const dir = tempDir();
    const livePool = join(dir, "live");
    const deadPoolDir = join(dir, "dead");
    mkdirSync(livePool, { recursive: true });
    mkdirSync(deadPoolDir, { recursive: true });
    const registry = join(dir, "pools.json");
    const raw = JSON.stringify([
      { poolDir: livePool, port: 8787, pid: process.pid, startedAt: "t" },
      { poolDir: deadPoolDir, port: 8790, pid: deadPid(), startedAt: "t" },
    ]);
    writeFileSync(registry, raw);
    await runFleetCli(registry);
    // Prune is read-time: dead entries stay on disk, they just never print.
    // A list command must not rewrite the registry.
    expect(readFileSync(registry, "utf8")).toBe(raw);
  });
});