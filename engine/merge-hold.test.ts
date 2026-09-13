/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  createMergeHoldWatch,
  deriveMergeHold,
  type HoldHost,
  type MergeHoldProbe,
  throughMergeHold,
} from "./merge-hold.ts";
import type { TicketStatus } from "./pool.ts";

/**
 * A fake git: the target branch, which pool branches exist, and which of
 * them are ancestors of the target. Every call is counted so a case can
 * assert the derivation spawned nothing.
 */
function fakeProbe(repo: {
  target?: string;
  branches?: string[];
  landed?: string[];
}): MergeHoldProbe & { calls: number } {
  const branches = new Set(repo.branches ?? []);
  const landed = new Set(repo.landed ?? []);
  const probe = {
    calls: 0,
    currentBranch: () => {
      probe.calls += 1;
      return repo.target ?? "main";
    },
    branchFor: (id: string) => `pool/key/${id}`,
    branchExists: (branch: string) => {
      probe.calls += 1;
      return branches.has(branch);
    },
    isAncestor: (branch: string, target: string) => {
      probe.calls += 1;
      return landed.has(`${branch}->${target}`);
    },
  };
  return probe;
}

const engineRun = (id: string): boolean => id.includes("-grader-") || id.endsWith("-head-to-head");

describe("merge hold derivation", () => {
  const cases: {
    name: string;
    tickets: Record<string, TicketStatus>;
    repo: Parameters<typeof fakeProbe>[0] | null;
    hold: string[];
    gitCalls?: number;
  }[] = [
    {
      name: "a git-less pool holds nothing and probes nothing",
      tickets: { "01": "done" },
      repo: null,
      hold: [],
    },
    {
      name: "nothing done: nothing held, and no git spawned",
      tickets: { "01": "ready", "02": "in-progress", "03": "checkpoint" },
      repo: { branches: ["pool/key/01"] },
      hold: [],
      gitCalls: 0,
    },
    {
      name: "an engine-run ticket is skipped by the id rule, and alone spawns no git",
      tickets: { "01-grader-1": "done", "01-head-to-head": "done", "01": "in-progress" },
      repo: { branches: ["pool/key/01-grader-1"] },
      hold: [],
      gitCalls: 0,
    },
    {
      name: "a done ticket whose branch is gone reads as landed",
      tickets: { "01": "done" },
      repo: { branches: [] },
      hold: [],
    },
    {
      name: "a done ticket whose branch exists and has not landed is held",
      tickets: { "01": "done", "02": "done", "03": "ready" },
      repo: { branches: ["pool/key/01", "pool/key/02"], landed: ["pool/key/02->main"] },
      hold: ["01"],
    },
    {
      name: "the target is the working branch: landed in main but not in the feature branch still holds",
      tickets: { "01": "done" },
      repo: { target: "feature/x", branches: ["pool/key/01"], landed: ["pool/key/01->main"] },
      hold: ["01"],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const probe = c.repo === null ? null : fakeProbe(c.repo);
      expect(deriveMergeHold(c.tickets, engineRun, probe)).toEqual(c.hold);
      if (c.gitCalls !== undefined) expect(probe?.calls ?? 0).toBe(c.gitCalls);
    });
  }
});

describe("merge hold watch", () => {
  async function settle(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("runs nothing while the emitted set is empty", async () => {
    let derives = 0;
    const watch = createMergeHoldWatch({
      derive: () => {
        derives += 1;
        return [];
      },
      onChange: () => {},
      intervalMs: 5,
    });
    watch.emitted([]);
    await settle(30);
    expect(derives).toBe(0);
    watch.stop();
  });

  it("re-derives while held and asks for an emit only when the set changes by value", async () => {
    let hold = ["01", "02"];
    let changes = 0;
    let derives = 0;
    const watch = createMergeHoldWatch({
      derive: () => {
        derives += 1;
        return hold;
      },
      onChange: () => {
        changes += 1;
        // The engine's emit carries the fresh set back to the watch.
        watch.emitted(hold);
      },
      intervalMs: 5,
    });
    watch.emitted(["02", "01"]);
    await settle(30);
    // Same set, other order: no emit asked for.
    expect(changes).toBe(0);
    hold = ["02"];
    await settle(30);
    expect(changes).toBe(1);
    // The hold lifted: one more emit, then the interval stops on the
    // empty set and nothing further is derived.
    hold = [];
    await settle(30);
    expect(changes).toBe(2);
    const quiet = derives;
    hold = ["03"];
    await settle(30);
    expect(changes).toBe(2);
    expect(derives).toBe(quiet);
    watch.stop();
  });

  it("stops for good once stopped, whatever is emitted afterwards", async () => {
    let derives = 0;
    const watch = createMergeHoldWatch({
      derive: () => {
        derives += 1;
        return ["01"];
      },
      onChange: () => {},
      intervalMs: 5,
    });
    watch.emitted(["01"]);
    await settle(20);
    expect(derives).toBeGreaterThan(0);
    watch.stop();
    const at = derives;
    watch.emitted(["01"]);
    await settle(30);
    expect(derives).toBe(at);
  });
});

describe("wait-and-recompute rule", () => {
  /**
   * A scripted host: each derive answers the next entry of `derives`, each
   * drain the next entry of `drained`, and every call the rule makes is
   * counted, so a case can say how many times the rule waited, drained
   * and emitted.
   */
  function scriptedHost(
    derives: string[][],
    drained: boolean[] = [],
  ): HoldHost & { pauses: string[][]; drains: number; emits: number; derived: number } {
    const host = {
      pauses: [] as string[][],
      drains: 0,
      emits: 0,
      derived: 0,
      derive: () => {
        host.derived += 1;
        const next = derives.shift();
        if (next === undefined) throw new Error("derive past the script");
        return next;
      },
      drain: () => {
        host.drains += 1;
        return drained.shift() ?? false;
      },
      engaged: (ids: string[]) => {
        host.pauses.push(ids);
      },
      emit: () => {
        host.emits += 1;
      },
    };
    return host;
  }

  it("hands back the first recompute when nothing holds, without a wait", async () => {
    const h = scriptedHost([]);
    let recomputes = 0;
    const value = await throughMergeHold(h, () => {
      recomputes += 1;
      return { value: ["judge"], hold: [] };
    });
    expect(value).toEqual(["judge"]);
    expect(recomputes).toBe(1);
    expect(h.derived).toBe(0);
    expect(h.emits).toBe(0);
  });

  it("re-waits a hold that re-engages between the wait and the recompute, never handing back a held set", async () => {
    // Recomputes answer, in order: held (the first wait), held again (the
    // re-engagement in the gap after the first wait exits), then clear.
    // The waits poll the host: the first sees hold then clear, the second
    // sees clear at once.
    const recomputed: string[][] = [["01"], ["01"], []];
    const h = scriptedHost([["01"], [], []]);
    let recomputes = 0;
    const value = await throughMergeHold(
      h,
      () => {
        recomputes += 1;
        const hold = recomputed.shift()!;
        return { value: hold.length > 0 ? [] : ["judge"], hold };
      },
      { intervalMs: 1 },
    );
    // A shape that handed the second recompute straight back would return
    // [] here; the rule turns the re-engagement into a second wait and a
    // third recompute.
    expect(value).toEqual(["judge"]);
    expect(recomputes).toBe(3);
    expect(h.pauses).toEqual([["01"], ["01"]]);
  });

  it("logs the engagement once per wait, drains on every tick and emits only when a drain applied something", async () => {
    // One wait of three ticks: the second tick's drain applies an answer.
    const h = scriptedHost([["01"], ["01"], ["01"], []], [false, true, false]);
    const holds: string[][] = [["01", "02"], []];
    await throughMergeHold(
      h,
      () => ({ value: "ready", hold: holds.shift()! }),
      { intervalMs: 1 },
    );
    expect(h.pauses).toEqual([["01", "02"]]);
    expect(h.drains).toBe(3);
    // The engagement's emit, plus one for the applied answer.
    expect(h.emits).toBe(2);
  });
});
