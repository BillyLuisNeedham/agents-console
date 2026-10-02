/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachedByStamp, fileStamp, RACY_MS } from "./stat-cache.ts";
import { makeTempDir } from "./tmp.ts";

const tempDirs: string[] = [];

function tempFile(text: string): string {
  const dir = makeTempDir("stat-cache-");
  tempDirs.push(dir);
  const path = join(dir, "file.md");
  writeFileSync(path, text);
  return path;
}

// Moves the file's modification time out of the racy window, the way an
// hour of quiet would.
function quiet(path: string): void {
  const past = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(path, past, past);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** A reader that counts its reads and parses the file as a word list. */
function countingReader(): { read: (path: string) => { words: string[] }; reads: () => number } {
  let reads = 0;
  return {
    read: (path) => {
      reads += 1;
      return { words: readFileSync(path, "utf8").split(" ") };
    },
    reads: () => reads,
  };
}

describe("file stamps", () => {
  it("reads a quiet file once while it stays unchanged", () => {
    const path = tempFile("one two");
    quiet(path);
    const reader = countingReader();
    const cached = cachedByStamp(reader.read);
    expect(cached(path).words).toEqual(["one", "two"]);
    expect(cached(path).words).toEqual(["one", "two"]);
    expect(reader.reads()).toBe(1);
  });

  it("reads a file changed within the racy window afresh every time", () => {
    const path = tempFile("one two");
    expect(fileStamp(path)).toBeNull();
    const reader = countingReader();
    const cached = cachedByStamp(reader.read);
    cached(path);
    cached(path);
    expect(reader.reads()).toBe(2);
  });

  it("sees a same-size rewrite in place even with its modification time put back", () => {
    const path = tempFile("one two");
    quiet(path);
    const cached = cachedByStamp(countingReader().read);
    expect(cached(path).words).toEqual(["one", "two"]);
    writeFileSync(path, "six ten");
    quiet(path);
    // The change time cannot be put back, so the stamp still moves.
    expect(cached(path).words).toEqual(["six", "ten"]);
  });

  it("hands every caller its own copy, so an edit never reaches the next caller", () => {
    const path = tempFile("one two");
    quiet(path);
    const cached = cachedByStamp(countingReader().read);
    cached(path).words.push("three");
    expect(cached(path).words).toEqual(["one", "two"]);
  });

  it("caches no failed read, and forgets a file that is gone", () => {
    const path = tempFile("one two");
    quiet(path);
    let fail = true;
    const reader = countingReader();
    const cached = cachedByStamp((p) => {
      if (fail) throw new Error("torn");
      return reader.read(p);
    });
    expect(() => cached(path)).toThrow("torn");
    fail = false;
    expect(cached(path).words).toEqual(["one", "two"]);
    rmSync(path);
    expect(() => cached(path)).toThrow();
  });

  it("calls a file quiet once it has gone RACY_MS without a change", () => {
    const path = tempFile("one");
    const now = Date.now();
    expect(fileStamp(path, now)).toBeNull();
    expect(fileStamp(path, now + RACY_MS + 50)).not.toBeNull();
    expect(fileStamp(join(path, "missing"))).toBe("absent");
  });
});
