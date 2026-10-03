/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSpawnAssign, loadPoolMarkers, readMarker } from "./pool.ts";

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

  // Issue #116: a proposal's assign rides on the child's marker as one
  // whitespace-free token.
  it("round-trips a spawn proposal's assign off the marker, effort and a space in drivers and all", () => {
    const assign = encodeSpawnAssign({
      model: "child-model",
      effort: "max",
      drivers: "implement code-review",
    });
    expect(assign).not.toMatch(/\s/);
    const file = tempFile(
      `<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 spawn-assign=${assign} -->\n\n# Spawned\n\nbody\n`,
    );
    expect(readMarker(file).spawnAssign).toEqual({
      model: "child-model",
      effort: "max",
      drivers: "implement code-review",
    });
  });

  it("keeps only the four Assignment fields off a spawn-assign, never a verify", () => {
    const assign = encodeURIComponent(JSON.stringify({ effort: "max", verify: 3 }));
    const file = tempFile(
      `<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 spawn-assign=${assign} -->\n\n# Spawned\n\nbody\n`,
    );
    expect(readMarker(file).spawnAssign).toEqual({ effort: "max" });
  });

  it("fails pool load on a malformed spawn-assign, naming the file", () => {
    const dir = poolWithFiles({
      "01-a.md": parent,
      "01-spawn-1.md":
        "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 spawn-assign=not-json -->\n\n# Spawned\n\nbody\n",
    });
    expect(() => loadPoolMarkers(dir)).toThrow(
      `pool load: ${join(dir, "01-spawn-1.md")}: spawn-assign is not valid encoded JSON`,
    );
  });

  it("fails pool load on a spawn-assign field that is not a string, naming the file", () => {
    const assign = encodeURIComponent(JSON.stringify({ effort: 5 }));
    const dir = poolWithFiles({
      "01-a.md": parent,
      "01-spawn-1.md": `<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 spawn-assign=${assign} -->\n\n# Spawned\n\nbody\n`,
    });
    expect(() => loadPoolMarkers(dir)).toThrow(
      `pool load: ${join(dir, "01-spawn-1.md")}: spawn-assign.effort is not a string`,
    );
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

  // The Conversations ADR (docs/adr/0018-conversations-beside-tickets.md):
  // a Ticket may be spawned by a Conversation as well as by another Ticket,
  // and a Conversation's own record lives outside issues/ entirely (engine/
  // conversations.ts), so loadPoolMarkers cannot see it in `markers` the way
  // it sees a parent ticket. The caller (engine.ts's startPool and every
  // reload site) passes the known Conversation ids it loaded separately.
  it("accepts a spawn ticket whose spawned-by names a known Conversation, not a ticket", () => {
    const dir = poolWithFiles({
      "conv-1-spawn-1.md":
        "<!-- state: id=conv-1-spawn-1 blocked-by=none status=ready spawned-by=conv-1 -->\n\n# From a Conversation\n\nbody\n",
    });
    const markers = loadPoolMarkers(dir, new Set(["conv-1"]));
    expect(markers.map((m) => m.id)).toEqual(["conv-1-spawn-1"]);
    expect(markers[0].spawnedBy).toBe("conv-1");
  });

  it("still rejects that same ticket when the Conversation id is not in the known set", () => {
    const dir = poolWithFiles({
      "conv-1-spawn-1.md":
        "<!-- state: id=conv-1-spawn-1 blocked-by=none status=ready spawned-by=conv-1 -->\n\n# From a Conversation\n\nbody\n",
    });
    expect(() => loadPoolMarkers(dir, new Set(["conv-2"]))).toThrow(
      /names no ticket or known Conversation/,
    );
    // The old caller shape (no third argument at all) fails the same way,
    // so every pre-existing call site's behavior is unchanged.
    expect(() => loadPoolMarkers(dir)).toThrow(/names no ticket or known Conversation/);
  });

  // The Conversations ADR: a pool that is nothing but Conversations has an
  // empty issues/ legitimately, from its very first boot, not the mistake
  // the bare throw exists to catch.
  it("returns an empty list for an empty issues/ when allowEmptyIssues is set", () => {
    const dir = poolWithFiles({});
    expect(loadPoolMarkers(dir, undefined, { allowEmptyIssues: true })).toEqual([]);
  });

  it("still throws for an empty issues/ without allowEmptyIssues, matching every existing caller", () => {
    const dir = poolWithFiles({});
    expect(() => loadPoolMarkers(dir)).toThrow(/no Issue files/);
    expect(() => loadPoolMarkers(dir, new Set(["conv-1"]))).toThrow(/no Issue files/);
    // The refusal names the opt-in (issue #71), since the operator's only
    // entry point surfaces this message verbatim.
    expect(() => loadPoolMarkers(dir)).toThrow(/conversations\/ directory/);
  });
});
