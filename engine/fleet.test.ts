/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFleetEntry } from "./fleet.ts";

const tempDirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-test-"));
  tempDirs.push(dir);
  return join(dir, "pools.json");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("fleet registry read", () => {
  it("returns null when the registry is absent", () => {
    const path = tempFile();
    expect(readFleetEntry(path, "/pool", 123)).toBeNull();
  });

  it("returns null when the registry is corrupt", () => {
    const path = tempFile();
    writeFileSync(path, "{ not json");
    expect(readFleetEntry(path, "/pool", 123)).toBeNull();
  });

  it("returns null when nothing matches the pool and pid", () => {
    const path = tempFile();
    writeFileSync(
      path,
      JSON.stringify([
        { poolDir: "/other", port: 8787, pid: 1, startedAt: "t" },
      ]),
    );
    expect(readFleetEntry(path, "/pool", 123)).toBeNull();
  });

  it("returns the entry matching pool and pid", () => {
    const path = tempFile();
    const entry = { poolDir: "/pool", port: 8787, pid: 123, startedAt: "t" };
    writeFileSync(path, JSON.stringify([entry]));
    expect(readFleetEntry(path, "/pool", 123)).toEqual(entry);
  });
});