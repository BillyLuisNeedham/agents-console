/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFleetEntries,
  readFleetEntry,
  upsertFleetEntry,
} from "./fleet.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-test-"));
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

function makePoolDir(): string {
  const dir = tempDir();
  const poolDir = join(dir, "pool");
  mkdirSync(poolDir, { recursive: true });
  return poolDir;
}

describe("fleet registry upsert", () => {
  it("writes the entry shape on registration", () => {
    const dir = tempDir();
    const poolDir = join(dir, "pool");
    mkdirSync(poolDir, { recursive: true });
    const registry = join(dir, "pools.json");
    const entry = { poolDir, port: 8787, pid: process.pid, startedAt: "t" };
    upsertFleetEntry(registry, entry);
    expect(readFleetEntries(registry)).toEqual([entry]);
  });

  it("upserting the same pool replaces its entry rather than duplicating", () => {
    const dir = tempDir();
    const poolDir = join(dir, "pool");
    mkdirSync(poolDir, { recursive: true });
    const registry = join(dir, "pools.json");
    upsertFleetEntry(registry, {
      poolDir,
      port: 8787,
      pid: process.pid,
      startedAt: "a",
    });
    upsertFleetEntry(registry, {
      poolDir,
      port: 8799,
      pid: process.pid,
      startedAt: "b",
    });
    expect(readFleetEntries(registry)).toEqual([
      { poolDir, port: 8799, pid: process.pid, startedAt: "b" },
    ]);
  });

  it("upserting one pool leaves other pools' entries alone", () => {
    const dir = tempDir();
    const poolA = join(dir, "a");
    const poolB = join(dir, "b");
    mkdirSync(poolA, { recursive: true });
    mkdirSync(poolB, { recursive: true });
    const registry = join(dir, "pools.json");
    upsertFleetEntry(registry, {
      poolDir: poolA,
      port: 8787,
      pid: process.pid,
      startedAt: "a",
    });
    upsertFleetEntry(registry, {
      poolDir: poolB,
      port: 8788,
      pid: process.pid,
      startedAt: "b",
    });
    expect(readFleetEntries(registry)).toHaveLength(2);
  });

  it("creates a missing registry file and its parent directory", () => {
    const dir = tempDir();
    const poolDir = join(dir, "pool");
    mkdirSync(poolDir, { recursive: true });
    const registry = join(dir, "nested", "pools.json");
    upsertFleetEntry(registry, {
      poolDir,
      port: 8787,
      pid: process.pid,
      startedAt: "t",
    });
    expect(readFleetEntries(registry)).toHaveLength(1);
  });

  it("recreates a corrupt registry file on write, not an error", () => {
    const dir = tempDir();
    const poolDir = join(dir, "pool");
    mkdirSync(poolDir, { recursive: true });
    const registry = join(dir, "pools.json");
    writeFileSync(registry, "{ not json");
    upsertFleetEntry(registry, {
      poolDir,
      port: 8787,
      pid: process.pid,
      startedAt: "t",
    });
    expect(readFleetEntries(registry)).toEqual([
      { poolDir, port: 8787, pid: process.pid, startedAt: "t" },
    ]);
  });

  it("recreates a registry that is not an array on write", () => {
    const dir = tempDir();
    const poolDir = join(dir, "pool");
    mkdirSync(poolDir, { recursive: true });
    const registry = join(dir, "pools.json");
    writeFileSync(registry, JSON.stringify({ poolDir: "/elsewhere" }));
    upsertFleetEntry(registry, {
      poolDir,
      port: 8787,
      pid: process.pid,
      startedAt: "t",
    });
    expect(readFleetEntries(registry)).toEqual([
      { poolDir, port: 8787, pid: process.pid, startedAt: "t" },
    ]);
  });
});

describe("fleet registry prune-on-read", () => {
  it("reads a missing registry as empty", () => {
    const registry = join(tempDir(), "pools.json");
    expect(readFleetEntries(registry)).toEqual([]);
  });

  it("reads a corrupt registry as empty", () => {
    const registry = join(tempDir(), "pools.json");
    writeFileSync(registry, "{ not json");
    expect(readFleetEntries(registry)).toEqual([]);
  });

  it("drops an entry whose pid is dead", () => {
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
    expect(readFleetEntries(registry)).toEqual([]);
  });

  it("drops an entry whose pool directory no longer exists", () => {
    const dir = tempDir();
    const registry = join(dir, "pools.json");
    const gone = join(dir, "gone");
    writeFileSync(
      registry,
      JSON.stringify([
        { poolDir: gone, port: 8787, pid: process.pid, startedAt: "t" },
      ]),
    );
    expect(readFleetEntries(registry)).toEqual([]);
  });

  it("keeps an entry whose pid is live and pool directory exists", () => {
    const dir = tempDir();
    const poolDir = join(dir, "pool");
    mkdirSync(poolDir, { recursive: true });
    const registry = join(dir, "pools.json");
    const entry = { poolDir, port: 8787, pid: process.pid, startedAt: "t" };
    writeFileSync(registry, JSON.stringify([entry]));
    expect(readFleetEntries(registry)).toEqual([entry]);
  });
});

describe("fleet registry readFleetEntry", () => {
  it("returns null when the registry is absent", () => {
    const registry = join(tempDir(), "pools.json");
    expect(readFleetEntry(registry, "/pool", process.pid)).toBeNull();
  });

  it("returns null when the registry is corrupt", () => {
    const registry = join(tempDir(), "pools.json");
    writeFileSync(registry, "{ not json");
    expect(readFleetEntry(registry, "/pool", process.pid)).toBeNull();
  });

  it("returns null when nothing matches the pool and pid", () => {
    const dir = tempDir();
    const poolDir = join(dir, "pool");
    mkdirSync(poolDir, { recursive: true });
    const registry = join(dir, "pools.json");
    const other = join(dir, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      registry,
      JSON.stringify([
        { poolDir: other, port: 8788, pid: process.pid, startedAt: "t" },
      ]),
    );
    expect(readFleetEntry(registry, poolDir, process.pid)).toBeNull();
  });

  it("returns the entry matching pool and pid", () => {
    const dir = tempDir();
    const poolDir = join(dir, "pool");
    mkdirSync(poolDir, { recursive: true });
    const registry = join(dir, "pools.json");
    const entry = { poolDir, port: 8787, pid: process.pid, startedAt: "t" };
    writeFileSync(registry, JSON.stringify([entry]));
    expect(readFleetEntry(registry, poolDir, process.pid)).toEqual(entry);
  });

  it("returns null when the matching entry's pid is dead", () => {
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
    expect(readFleetEntry(registry, poolDir, deadPid())).toBeNull();
  });
});