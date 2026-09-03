/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPoolMarkers, readMarker } from "./pool.ts";

const tempDirs: string[] = [];

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pool-test-"));
  tempDirs.push(dir);
  const file = join(dir, "01-a.md");
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

describe("issue file metadata", () => {
  it("reads the title heading and the spec body after it", () => {
    const file = tempFile(`${marker}\n\n# Ticket title\n\nSpec: what to build\n`);
    expect(readMarker(file)).toMatchObject({
      id: "01",
      blockedBy: [],
      status: "ready",
      title: "Ticket title",
      spec: "Spec: what to build",
    });
  });

  it("titles a file with no heading as (untitled)", () => {
    const file = tempFile(`${marker}\n\nno heading here\n`);
    expect(readMarker(file).title).toBe("(untitled)");
    // No heading means the spec fallback is the whole file, marker included,
    // matching the served behavior the server previously produced.
    expect(readMarker(file).spec).toContain("no heading here");
  });

  it("loadPoolMarkers exposes the metadata for every issue file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-test-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "01-a.md"), `${marker}\n\n# First\n\nbody one\n`);
    writeFileSync(
      join(dir, "02-b.md"),
      "<!-- state: id=02 blocked-by=01 status=ready -->\n\n# Second\n\nbody two\n",
    );
    const markers = loadPoolMarkers(dir);
    expect(markers.map((m) => m.title)).toEqual(["First", "Second"]);
    expect(markers.map((m) => m.spec)).toEqual(["body one", "body two"]);
    expect(markers.map((m) => m.blockedBy)).toEqual([[], ["01"]]);
  });
});

describe("spawn namespace reservation", () => {
  function poolWithFiles(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pool-test-"));
    tempDirs.push(dir);
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents);
    }
    return dir;
  }

  const parent = `${marker}\n\n# Parent\n\nbody\n`;

  it("parses spawned-by on an engine-written spawn ticket", () => {
    const file = tempFile(
      "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 -->\n\n# Spawned\n\nbody\n",
    );
    const loaded = readMarker(file);
    expect(loaded.spawnedBy).toBe("01");
  });

  it("loads an engine-written spawn ticket whose parent is in the pool", () => {
    const dir = poolWithFiles({
      "01-a.md": parent,
      "01-spawn-1.md":
        "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 -->\n\n# Spawned\n\nbody\n",
    });
    const markers = loadPoolMarkers(dir);
    expect(markers.map((m) => m.id)).toEqual(["01", "01-spawn-1"]);
    expect(markers[1].spawnedBy).toBe("01");
  });

  it("rejects a hand-written ticket in the reserved namespace", () => {
    const dir = poolWithFiles({
      "01-a.md": parent,
      "01-spawn-9.md": "<!-- state: id=01-spawn-9 blocked-by=none status=ready -->\n\n# Hand-written\n\nbody\n",
    });
    expect(() => loadPoolMarkers(dir)).toThrow(/reserved/);
  });

  it("rejects a spawn ticket whose spawned-by does not match its id's parent", () => {
    const dir = poolWithFiles({
      "01-a.md": parent,
      "02-b.md": "<!-- state: id=02 blocked-by=none status=ready -->\n\n# Other\n\nbody\n",
      "01-spawn-1.md":
        "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=02 -->\n\n# Mismatched\n\nbody\n",
    });
    expect(() => loadPoolMarkers(dir)).toThrow(/reserved/);
  });

  it("rejects a spawn ticket whose parent has left the pool", () => {
    const dir = poolWithFiles({
      "02-b.md": "<!-- state: id=02 blocked-by=none status=ready -->\n\n# Other\n\nbody\n",
      "01-spawn-1.md":
        "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 -->\n\n# Orphan\n\nbody\n",
    });
    expect(() => loadPoolMarkers(dir)).toThrow(/names no ticket/);
  });
});
