/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSpawnProposals } from "./spawn-proposals.ts";
import { makeTempDir } from "./tmp.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function runsDir(): string {
  const dir = makeTempDir("spawn-proposals-");
  dirs.push(dir);
  return dir;
}

const proposal = (title: string) => ({ title, body: "A body long enough to stand." });

describe("held spawns in the spawn proposals", () => {
  it("starts empty when the pool has never held a spawn", () => {
    const store = loadSpawnProposals(runsDir());
    expect(store.held()).toEqual([]);
  });

  // The ids are the pool's, never reused: a discarded proposal-1 must not come
  // back as the name of a different proposal after a restart.
  it("holds proposals under ids that survive a reload and are never reused", () => {
    const dir = runsDir();
    const store = loadSpawnProposals(dir);
    const held = store.hold([
      { parentId: "01", origin: "ticket", proposal: proposal("A"), reason: "per-attempt", at: "t1" },
      { parentId: "01", origin: "ticket", proposal: proposal("B"), reason: "per-run", at: "t1" },
    ]);
    expect(held.map((h) => h.id)).toEqual(["proposal-1", "proposal-2"]);
    expect(store.removeHeld("proposal-2")?.proposal.title).toBe("B");

    const reloaded = loadSpawnProposals(dir);
    expect(reloaded.held()).toEqual([
      { id: "proposal-1", parentId: "01", origin: "ticket", proposal: proposal("A"), reason: "per-attempt", at: "t1" },
    ]);
    const [next] = reloaded.hold([
      { parentId: "02", origin: "conversation", proposal: proposal("C"), reason: "per-attempt", at: "t2" },
    ]);
    expect(next!.id).toBe("proposal-3");
    expect(reloaded.removeHeld("proposal-9")).toBeNull();
  });

  // Recovery (ADR-0029) must run once per truncation, whatever the operator
  // did with what it recovered since: the mark and the holds land together.
  it("records a recovery with its holds in one write, so it is never run twice", () => {
    const dir = runsDir();
    const store = loadSpawnProposals(dir);
    expect(store.wasRecovered("01@t0")).toBe(false);
    const held = store.recover("01@t0", [
      { parentId: "01", origin: "ticket", proposal: proposal("Lost"), reason: "per-run", at: "t0" },
    ]);
    expect(held.map((h) => h.id)).toEqual(["proposal-1"]);
    store.removeHeld("proposal-1");

    const reloaded = loadSpawnProposals(dir);
    expect(reloaded.wasRecovered("01@t0")).toBe(true);
    expect(reloaded.held()).toEqual([]);
  });

  // An Adopt the boundary refused leaves the spawn held with the reason
  // (ADR-0029), kept across a restart, and the next Adopt clears it.
  it("records a refused Adopt's reason on the held spawn until the next Adopt", () => {
    const dir = runsDir();
    const store = loadSpawnProposals(dir);
    store.hold([
      { parentId: "01", origin: "ticket", proposal: proposal("A"), reason: "per-run", at: "t1" },
    ]);
    store.beginAdopt("proposal-1");
    expect(store.heldViews()[0]).toMatchObject({ adopting: true });
    expect(store.heldViews()[0]!.adoptError).toBeUndefined();

    store.refuseAdopt("proposal-1", "blocks names done tickets: 02");
    expect(store.heldViews()[0]).toMatchObject({
      adopting: false,
      adoptError: "blocks names done tickets: 02",
    });
    expect(loadSpawnProposals(dir).heldViews()[0]!.adoptError).toBe("blocks names done tickets: 02");

    store.beginAdopt("proposal-1");
    expect(store.heldViews()[0]!.adoptError).toBeUndefined();
    expect(loadSpawnProposals(dir).heldViews()[0]!.adoptError).toBeUndefined();
  });

  it("writes through a rename, leaving no temporary file behind", () => {
    const dir = runsDir();
    loadSpawnProposals(dir).hold([
      { parentId: "01", origin: "ticket", proposal: proposal("A"), reason: "per-attempt", at: "t1" },
    ]);
    expect(readdirSync(dir)).toEqual(["held-spawns.json"]);
    expect(JSON.parse(readFileSync(join(dir, "held-spawns.json"), "utf8")).held).toHaveLength(1);
  });

  it("refuses a file it cannot read rather than holding over it", () => {
    const dir = runsDir();
    writeFileSync(join(dir, "held-spawns.json"), "{torn");
    expect(() => loadSpawnProposals(dir)).toThrow(/held-spawns\.json/);
  });

  // The Console's view: the proposal flattened, and whether an Adopt is
  // already on its way to the boundary.
  it("serves each held spawn as the Console shows it, adopting included", () => {
    const store = loadSpawnProposals(runsDir());
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
    store.beginAdopt("proposal-2");
    expect(store.heldViews()).toEqual([
      {
        id: "proposal-1",
        parentId: "01",
        origin: "ticket",
        kind: "ticket",
        title: "A",
        body: "A body long enough to stand.",
        blockedBy: ["02"],
        blocks: "all",
        overlaps: [],
        reason: "per-run",
        at: "t1",
        adopting: false,
      },
      {
        id: "proposal-2",
        parentId: "c-1",
        origin: "conversation",
        kind: "conversation",
        title: "B",
        body: "A body long enough to stand.",
        blockedBy: [],
        blocks: null,
        overlaps: [],
        reason: "per-attempt",
        at: "t2",
        adopting: true,
      },
    ]);
  });
});

describe("pending spawns in the spawn proposals", () => {
  const taken = (title: string, held?: "per-attempt" | "per-run" | "overlaps") => ({
    parentId: "01",
    origin: "ticket" as const,
    proposal: proposal(title),
    at: "t1",
    ...(held !== undefined ? { held } : {}),
  });

  // Issue #150: a proposal taken from an exited attempt is on disk at once,
  // so a restart before the boundary finds it still pending.
  it("takes proposals as pending or held in one write, in order, surviving a reload", () => {
    const dir = runsDir();
    const store = loadSpawnProposals(dir);
    const { pending, held } = store.take([taken("A"), taken("B", "per-run"), taken("C")]);
    expect(pending.map((p) => p.id)).toEqual(["proposal-1", "proposal-3"]);
    expect(held.map((h) => [h.id, h.reason])).toEqual([["proposal-2", "per-run"]]);

    const reloaded = loadSpawnProposals(dir);
    expect(reloaded.pending()).toEqual([
      { id: "proposal-1", parentId: "01", origin: "ticket", proposal: proposal("A"), at: "t1" },
      { id: "proposal-3", parentId: "01", origin: "ticket", proposal: proposal("C"), at: "t1" },
    ]);
    expect(reloaded.held().map((h) => h.id)).toEqual(["proposal-2"]);
  });

  // The id an agent read from the Spawn ledger keeps naming the proposal
  // when the operator holds it.
  it("holds a pending spawn for the operator under the same id", () => {
    const dir = runsDir();
    const store = loadSpawnProposals(dir);
    store.take([taken("A")]);
    const held = store.holdPending("proposal-1", "t2");
    expect(held).toEqual({
      id: "proposal-1",
      parentId: "01",
      origin: "ticket",
      proposal: proposal("A"),
      reason: "operator",
      at: "t2",
    });
    expect(store.pending()).toEqual([]);
    expect(loadSpawnProposals(dir).held().map((h) => h.id)).toEqual(["proposal-1"]);
    expect(store.holdPending("proposal-1", "t3")).toBeNull();
  });

  it("removes a pending spawn once, and forgets landed ones in one write", () => {
    const dir = runsDir();
    const store = loadSpawnProposals(dir);
    store.take([taken("A"), taken("B"), taken("C")]);
    expect(store.removePending("proposal-2")?.proposal.title).toBe("B");
    expect(store.removePending("proposal-2")).toBeNull();
    store.landed(["proposal-1", "proposal-3"]);
    expect(loadSpawnProposals(dir).pending()).toEqual([]);
  });

  // A crash between the landing mark and the ticket file is told apart at
  // boot by the id the mark names.
  it("keeps a landing mark across a reload until it is cleared", () => {
    const dir = runsDir();
    const store = loadSpawnProposals(dir);
    store.take([taken("A"), taken("B")]);
    store.markLanding(new Map([["proposal-2", "01-spawn-1"]]));
    const reloaded = loadSpawnProposals(dir);
    expect(reloaded.getPending("proposal-2")?.landing).toBe("01-spawn-1");
    expect(reloaded.getPending("proposal-1")?.landing).toBeUndefined();
    reloaded.clearLanding("proposal-2");
    expect(loadSpawnProposals(dir).getPending("proposal-2")?.landing).toBeUndefined();
  });

  // An overlaps mark may name a proposal that has since landed or gone.
  it("knows every proposal id it ever issued, and none it did not", () => {
    const store = loadSpawnProposals(runsDir());
    store.take([taken("A"), taken("B")]);
    store.removePending("proposal-1");
    expect(store.isProposalId("proposal-1")).toBe(true);
    expect(store.isProposalId("proposal-2")).toBe(true);
    expect(store.isProposalId("proposal-3")).toBe(false);
    expect(store.isProposalId("held-2")).toBe(true);
    expect(store.isProposalId("07")).toBe(false);
  });

  // A pool that held spawns before issue #150 has no pending list.
  it("reads a held-spawns file from before pending spawns existed", () => {
    const dir = runsDir();
    writeFileSync(
      join(dir, "held-spawns.json"),
      JSON.stringify({
        seq: 2,
        held: [{ id: "held-2", parentId: "01", origin: "ticket", proposal: proposal("A"), reason: "per-run", at: "t0" }],
        recovered: [],
      }),
    );
    const store = loadSpawnProposals(dir);
    expect(store.pending()).toEqual([]);
    expect(store.held().map((h) => h.id)).toEqual(["held-2"]);
    const { pending } = store.take([taken("B")]);
    expect(pending[0]!.id).toBe("proposal-3");
  });

  it("serves each pending spawn as the Console shows it", () => {
    const store = loadSpawnProposals(runsDir());
    store.take([
      {
        parentId: "01",
        origin: "ticket",
        proposal: { ...proposal("A"), blockedBy: ["02"], overlaps: ["03"] },
        at: "t1",
      },
    ]);
    expect(store.pendingViews()).toEqual([
      {
        id: "proposal-1",
        parentId: "01",
        origin: "ticket",
        kind: "ticket",
        title: "A",
        body: "A body long enough to stand.",
        blockedBy: ["02"],
        blocks: null,
        overlaps: ["03"],
        at: "t1",
      },
    ]);
  });
});
