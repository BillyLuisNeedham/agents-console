/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHeldSpawns } from "./held-spawns.ts";
import { makeTempDir } from "./tmp.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function runsDir(): string {
  const dir = makeTempDir("held-spawns-");
  dirs.push(dir);
  return dir;
}

const proposal = (title: string) => ({ title, body: "A body long enough to stand." });

describe("held spawns", () => {
  it("starts empty when the pool has never held a spawn", () => {
    const store = loadHeldSpawns(runsDir());
    expect(store.list()).toEqual([]);
  });

  // The ids are the pool's, never reused: a discarded held-1 must not come
  // back as the name of a different proposal after a restart.
  it("holds proposals under ids that survive a reload and are never reused", () => {
    const dir = runsDir();
    const store = loadHeldSpawns(dir);
    const held = store.hold([
      { parentId: "01", origin: "ticket", proposal: proposal("A"), reason: "per-attempt", at: "t1" },
      { parentId: "01", origin: "ticket", proposal: proposal("B"), reason: "per-run", at: "t1" },
    ]);
    expect(held.map((h) => h.id)).toEqual(["held-1", "held-2"]);
    expect(store.remove("held-2")?.proposal.title).toBe("B");

    const reloaded = loadHeldSpawns(dir);
    expect(reloaded.list()).toEqual([
      { id: "held-1", parentId: "01", origin: "ticket", proposal: proposal("A"), reason: "per-attempt", at: "t1" },
    ]);
    const [next] = reloaded.hold([
      { parentId: "02", origin: "conversation", proposal: proposal("C"), reason: "per-attempt", at: "t2" },
    ]);
    expect(next!.id).toBe("held-3");
    expect(reloaded.remove("held-9")).toBeNull();
  });

  // Recovery (ADR-0029) must run once per truncation, whatever the operator
  // did with what it recovered since: the mark and the holds land together.
  it("records a recovery with its holds in one write, so it is never run twice", () => {
    const dir = runsDir();
    const store = loadHeldSpawns(dir);
    expect(store.wasRecovered("01@t0")).toBe(false);
    const held = store.recover("01@t0", [
      { parentId: "01", origin: "ticket", proposal: proposal("Lost"), reason: "per-run", at: "t0" },
    ]);
    expect(held.map((h) => h.id)).toEqual(["held-1"]);
    store.remove("held-1");

    const reloaded = loadHeldSpawns(dir);
    expect(reloaded.wasRecovered("01@t0")).toBe(true);
    expect(reloaded.list()).toEqual([]);
  });

  it("writes through a rename, leaving no temporary file behind", () => {
    const dir = runsDir();
    loadHeldSpawns(dir).hold([
      { parentId: "01", origin: "ticket", proposal: proposal("A"), reason: "per-attempt", at: "t1" },
    ]);
    expect(readdirSync(dir)).toEqual(["held-spawns.json"]);
    expect(JSON.parse(readFileSync(join(dir, "held-spawns.json"), "utf8")).held).toHaveLength(1);
  });

  it("refuses a file it cannot read rather than holding over it", () => {
    const dir = runsDir();
    writeFileSync(join(dir, "held-spawns.json"), "{torn");
    expect(() => loadHeldSpawns(dir)).toThrow(/held-spawns\.json/);
  });

  // The Console's view: the proposal flattened, and whether an Adopt is
  // already on its way to the boundary.
  it("serves each held spawn as the Console shows it, adopting included", () => {
    const store = loadHeldSpawns(runsDir());
    store.hold([
      {
        parentId: "01",
        origin: "ticket",
        proposal: { ...proposal("A"), blockedBy: ["02"], blocks: "all" },
        reason: "per-run",
        at: "t1",
      },
      { parentId: "c-1", origin: "conversation", proposal: { ...proposal("B"), kind: "conversation" }, reason: "per-attempt", at: "t2" },
    ]);
    store.adopting.add("held-2");
    expect(store.views()).toEqual([
      {
        id: "held-1",
        parentId: "01",
        origin: "ticket",
        kind: "ticket",
        title: "A",
        body: "A body long enough to stand.",
        blockedBy: ["02"],
        blocks: "all",
        reason: "per-run",
        at: "t1",
        adopting: false,
      },
      {
        id: "held-2",
        parentId: "c-1",
        origin: "conversation",
        kind: "conversation",
        title: "B",
        body: "A body long enough to stand.",
        blockedBy: [],
        blocks: null,
        reason: "per-attempt",
        at: "t2",
        adopting: true,
      },
    ]);
  });
});
