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