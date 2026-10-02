/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createMergeHoldWatch,
  createMergeLine,
  deriveMergeHold,
  gitMergeHoldProbe,
  type HoldHost,
  type MergeHoldProbe,
  memoizedMergeHold,
  throughMergeHold,
} from "./merge-hold.ts";
import type { TicketStatus } from "./pool.ts";
import { makeTempDir } from "./tmp.ts";
import { branchFor } from "./worktrees.ts";

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

// The memo (issue #157) answers from the last derivation while the key is
// unchanged. ADR-0014 cannot afford a stale "landed": every case that moves
// what git would answer must move the key.
describe("merge hold memo", () => {
  function stamped(repo: Parameters<typeof fakeProbe>[0], stamp: { value: string | null }) {
    const probe = fakeProbe(repo);
    return Object.assign(probe, { stamp: () => stamp.value });
  }

  it("answers an unchanged stamp from the last derivation, spawning no git", () => {
    const stamp = { value: "refs-1" };
    const probe = stamped({ branches: ["pool/key/01"] }, stamp);
    const derive = memoizedMergeHold();
    expect(derive({ "01": "done" }, engineRun, probe)).toEqual(["01"]);
    const calls = probe.calls;
    expect(derive({ "01": "done" }, engineRun, probe)).toEqual(["01"]);
    expect(probe.calls).toBe(calls);
  });

  it("derives again when the stamp moves, so a merge that landed is seen", () => {
    const stamp = { value: "refs-1" };
    const repo = { branches: ["pool/key/01"], landed: [] as string[] };
    const probe = stamped(repo, stamp);
    const derive = memoizedMergeHold();
    expect(derive({ "01": "done" }, engineRun, probe)).toEqual(["01"]);
    // The fake's sets are live: land the branch, and move the stamp with it.
    repo.landed.push("pool/key/01->main");
    const landed = stamped(repo, { value: "refs-2" });
    expect(derive({ "01": "done" }, engineRun, landed)).toEqual([]);
  });

  it("derives again when another ticket reaches done, whatever the stamp says", () => {
    const stamp = { value: "refs-1" };
    const probe = stamped({ branches: ["pool/key/01", "pool/key/02"] }, stamp);
    const derive = memoizedMergeHold();
    expect(derive({ "01": "done", "02": "in-progress" }, engineRun, probe)).toEqual(["01"]);
    expect(derive({ "01": "done", "02": "done" }, engineRun, probe)).toEqual(["01", "02"]);
  });

  it("derives every time a probe cannot vouch for its refs", () => {
    const probe = stamped({ branches: ["pool/key/01"] }, { value: null });
    const derive = memoizedMergeHold();
    derive({ "01": "done" }, engineRun, probe);
    const calls = probe.calls;
    derive({ "01": "done" }, engineRun, probe);
    expect(probe.calls).toBeGreaterThan(calls);
  });

  it("hands every caller its own list", () => {
    const probe = stamped({ branches: ["pool/key/01"] }, { value: "refs-1" });
    const derive = memoizedMergeHold();
    derive({ "01": "done" }, engineRun, probe).pop();
    expect(derive({ "01": "done" }, engineRun, probe)).toEqual(["01"]);
  });
});

// The memo over a real repository and the real probe. Every ref file is
// aged out of the racy window before each derivation that should be
// answered from the memo, the way a pool that sat quiet would be; the
// counting wrapper says whether git ran.
describe("merge hold memo over git", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function run(cwd: string, args: string[]): string {
    const probe = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if (probe.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${probe.stderr.toString()}`);
    return probe.stdout.toString().trim();
  }

  function repo(): string {
    const root = makeTempDir("hold-memo-");
    dirs.push(root);
    run(root, ["init", "-q", "-b", "main"]);
    run(root, ["config", "user.email", "memo@test"]);
    run(root, ["config", "user.name", "memo"]);
    writeFileSync(join(root, "base.txt"), "base\n");
    run(root, ["add", "-A"]);
    run(root, ["commit", "-qm", "base"]);
    return root;
  }

  function commitOn(root: string, branch: string, file: string): void {
    run(root, ["checkout", "-qb", branch]);
    writeFileSync(join(root, file), `${file}\n`);
    run(root, ["add", "-A"]);
    run(root, ["commit", "-qm", file]);
    run(root, ["checkout", "-q", "main"]);
  }

  // Ages every file under the git dir out of the racy window.
  function quiet(gitDir: string): void {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "objects") walk(path);
        } else utimesSync(path, past, past);
      }
    };
    walk(gitDir);
  }

  function counted(root: string): MergeHoldProbe & { calls: number } {
    const base = gitMergeHoldProbe(root);
    const probe = {
      ...base,
      calls: 0,
      branchExists: (branch: string) => {
        probe.calls += 1;
        return base.branchExists(branch);
      },
      isAncestor: (branch: string, target: string) => {
        probe.calls += 1;
        return base.isAncestor(branch, target);
      },
    };
    return probe;
  }

  it("holds while quiet with no git, releases on the merge, and holds again when the merge is undone", () => {
    const root = repo();
    const branch = branchFor(root, "01");
    commitOn(root, branch, "one.txt");
    const derive = memoizedMergeHold();
    const tickets = { "01": "done" } as const;

    expect(derive(tickets, engineRun, counted(root))).toEqual(["01"]);
    quiet(join(root, ".git"));
    const warm = counted(root);
    expect(derive(tickets, engineRun, warm)).toEqual(["01"]);
    expect(derive(tickets, engineRun, warm)).toEqual(["01"]);
    const quietCalls = warm.calls;
    expect(derive(tickets, engineRun, warm)).toEqual(["01"]);
    expect(warm.calls).toBe(quietCalls);

    const before = run(root, ["rev-parse", "main"]);
    run(root, ["merge", "-q", "--no-edit", branch]);
    expect(derive(tickets, engineRun, counted(root))).toEqual([]);
    quiet(join(root, ".git"));
    expect(derive(tickets, engineRun, counted(root))).toEqual([]);

    // The merge undone, and the ref file's times put back at once: the
    // rename git writes it with still moves the stamp, so the hold returns.
    run(root, ["update-ref", "refs/heads/main", before]);
    quiet(join(root, ".git"));
    expect(derive(tickets, engineRun, counted(root))).toEqual(["01"]);
  });

  it("sees refs packed away from their loose files, and a branch deleted and made again", () => {
    const root = repo();
    const branch = branchFor(root, "01");
    commitOn(root, branch, "one.txt");
    const derive = memoizedMergeHold();
    const tickets = { "01": "done" } as const;
    quiet(join(root, ".git"));
    expect(derive(tickets, engineRun, counted(root))).toEqual(["01"]);

    run(root, ["pack-refs", "--all"]);
    quiet(join(root, ".git"));
    expect(derive(tickets, engineRun, counted(root))).toEqual(["01"]);

    // Gone reads as landed (ADR-0014); made again off main, it has landed.
    run(root, ["branch", "-D", branch]);
    quiet(join(root, ".git"));
    expect(derive(tickets, engineRun, counted(root))).toEqual([]);
    commitOn(root, branch, "again.txt");
    quiet(join(root, ".git"));
    expect(derive(tickets, engineRun, counted(root))).toEqual(["01"]);
  });

  it("follows a linked checkout's own HEAD to its target", () => {
    const root = repo();
    const linked = join(makeTempDir("hold-memo-linked-"), "checkout");
    dirs.push(dirname(linked));
    run(root, ["worktree", "add", "-q", linked, "-b", "feature"]);
    const branch = branchFor(linked, "01");
    commitOn(root, branch, "one.txt");
    run(root, ["merge", "-q", "--no-edit", branch]);
    const derive = memoizedMergeHold();
    const tickets = { "01": "done" } as const;
    // Landed in main, not in the linked checkout's feature branch.
    quiet(join(root, ".git"));
    expect(derive(tickets, engineRun, counted(linked))).toEqual(["01"]);
    run(linked, ["checkout", "-q", "--detach"]);
    run(linked, ["checkout", "-qB", "feature", "main"]);
    quiet(join(root, ".git"));
    expect(derive(tickets, engineRun, counted(linked))).toEqual([]);
  });
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

describe("merge queue derivation", () => {
  const noResolvers = new Set<string>();

  it("orders the held tickets the way the engine took their merges on, and queues the ones it has not reached", () => {
    const line = createMergeLine();
    line.taken("05");
    line.taken("02");
    line.taken("09");
    line.resolving("05");
    expect(line.queue(["02", "05", "09"], new Set(["05"]), [])).toEqual([
      { ticketId: "05", state: "resolving" },
      { ticketId: "02", state: "queued" },
      { ticketId: "09", state: "queued" },
    ]);
  });

  it("reads resolving from the engine's own handling before the resolver is live, so a slow launch is not a stall", () => {
    const line = createMergeLine();
    line.taken("02");
    line.resolving("02");
    expect(line.queue(["02"], noResolvers, [])).toEqual([{ ticketId: "02", state: "resolving" }]);
  });

  it("names the interrupt a settled head waits at, and keeps its place in the line", () => {
    const line = createMergeLine();
    line.taken("02");
    line.taken("04");
    line.taken("05");
    line.resolving("02");
    line.settled("02");
    line.resolving("04");
    line.settled("04");
    expect(
      line.queue(["02", "04", "05"], noResolvers, [
        { ticketId: "04", kind: "merge-conflict" },
        { ticketId: "02", kind: "merge-approval" },
      ]),
    ).toEqual([
      { ticketId: "02", state: "awaiting-approval" },
      { ticketId: "04", state: "needs-you" },
      { ticketId: "05", state: "queued" },
    ]);
  });

  it("calls a held ticket with nothing running, nothing raised and nothing taken on stalled (#87)", () => {
    const line = createMergeLine();
    line.taken("02");
    line.settled("02");
    expect(line.queue(["02", "03"], noResolvers, [{ ticketId: "03", kind: "crash" }])).toEqual([
      { ticketId: "02", state: "stalled" },
      { ticketId: "03", state: "stalled" },
    ]);
  });

  it("puts a held ticket the engine never took on after the line, by id, the way a restart finds them", () => {
    const line = createMergeLine();
    line.taken("07");
    expect(line.queue(["09", "03", "07"], noResolvers, [])).toEqual([
      { ticketId: "07", state: "queued" },
      { ticketId: "03", state: "stalled" },
      { ticketId: "09", state: "stalled" },
    ]);
  });

  it("reads a live resolver as resolving even when the engine never took the merge on (a boot adoption)", () => {
    const line = createMergeLine();
    expect(line.queue(["02"], new Set(["02"]), [{ ticketId: "02", kind: "merge-conflict" }])).toEqual([
      { ticketId: "02", state: "resolving" },
    ]);
  });

  it("leaves out a ticket that landed, and a re-taken ticket joins the back of the line", () => {
    const line = createMergeLine();
    line.taken("02");
    line.taken("04");
    line.settled("02");
    expect(line.queue(["04"], noResolvers, [])).toEqual([{ ticketId: "04", state: "queued" }]);
    line.taken("02");
    expect(line.queue(["02", "04"], noResolvers, [])).toEqual([
      { ticketId: "04", state: "queued" },
      { ticketId: "02", state: "queued" },
    ]);
  });

  it("is a read: two consecutive queue calls agree, and a dropped ticket keeps its place if held again", () => {
    const line = createMergeLine();
    line.taken("02");
    line.taken("04");
    line.settled("02");
    const interrupts = [{ ticketId: "04", kind: "merge-conflict" }];
    const first = line.queue(["04"], noResolvers, interrupts);
    expect(line.queue(["04"], noResolvers, interrupts)).toEqual(first);
    expect(line.queue(["02", "04"], noResolvers, interrupts)).toEqual([
      { ticketId: "02", state: "stalled" },
      { ticketId: "04", state: "needs-you" },
    ]);
  });

  it("is empty when nothing is held, whatever the engine is doing", () => {
    const line = createMergeLine();
    line.taken("02");
    line.resolving("02");
    expect(line.queue([], new Set(["02"]), [])).toEqual([]);
  });
});
