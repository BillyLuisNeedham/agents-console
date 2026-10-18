import { expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { cardOf, commitAll, gitCommonDir, gitIn, poolKey, ticketWorktree, worktreeList } from "../harness/git-pool.ts";
import { until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import { events } from "./formats-helpers.ts";
import {
  CONFIG,
  answer,
  approveReview,
  interruptsOf,
  launchKeys,
  poolLog,
  restartCase,
  startLeg,
  stateLine,
  ticket,
  untilState,
} from "./restart-support.ts";

/** Bash for a stub: wait, up to thirty seconds, for a commit titled `subject` on main, then go on. */
function waitOnMain(subject: string): string {
  // grep without -q reads the whole log, so git never dies of SIGPIPE.
  const seen = `git log main --format=%s | grep -x '${subject}' >/dev/null`;
  return `for _ in $(seq 1 600); do if ${seen}; then break; fi; sleep 0.05; done; ${seen}`;
}

/** Bash for a stub: overwrite shared.txt with `line` and commit it as `message`. */
function overwriteShared(line: string, message: string): string {
  return `printf '%s\\n' '${line}' > shared.txt; git add -A; git commit -qm '${message}'`;
}

/** The Merge queue as `<id>:<state>`, in order. */
function queueOf(snapshot: EnrichedSnapshot): string[] {
  return snapshot.state.mergeQueue.map((entry) => `${entry.ticketId}:${entry.state}`);
}

// engine/engine.test.ts:11223
restartCase(
  "a killed server's unmerged Ticket is derived again by the next from state lines and branches alone, and its dependent waits for it",
  async (t) => {
    const config: PoolConfig = { ...CONFIG, resolver: "claude" };
    const world = t.world({
      tickets: [ticket("01", "t"), ticket("02", "t"), ticket("03", "t", { blockedBy: "02" })],
      config,
      repoFiles: { "shared.txt": "base\n" },
    });
    world.stubs.script("01", { run: overwriteShared("from-01", "work-01") });
    world.stubs.script("02", { run: `${waitOnMain("work-01")}\n${overwriteShared("from-02", "work-02")}` });
    world.stubs.script("02.resolver", {
      run: [
        "git merge main >/dev/null 2>&1 || true",
        "printf '%s\\n' resolved-by-agent > shared.txt",
        "git add shared.txt",
      ].join("\n"),
      outcomeRaw: JSON.stringify({ resolved: true, note: "kept both lines" }),
    });

    const first = await startLeg(t, world, 0);
    const held = await untilState(
      first,
      "02's merge-approval with 03 withheld",
      (s) =>
        interruptsOf(s).join(" ") === "02:merge-approval" &&
        queueOf(s).join(" ") === "02:awaiting-approval" &&
        cardOf(s, "01").mergeState === null,
      60_000,
    );
    const approval = held.state.interrupts.find((i) => i.kind === "merge-approval")!;
    expect(cardOf(held, "03").status).toBe("ready");
    await first.kill();
    expect(launchKeys(world).sort()).toEqual(["01", "02", "02.resolver"]);
    const branch = ticketWorktree(world.repo, "02").branch;
    expect(gitIn(world.repo, ["log", "main", "--format=%s"]).split("\n")).not.toContain("work-02");

    const second = await startLeg(t, world, 1);
    const rederived = await untilState(
      second,
      "02 unmerged again, its approval alone",
      (s) =>
        interruptsOf(s).join(" ") === "02:merge-approval" &&
        queueOf(s).join(" ") === "02:awaiting-approval" &&
        cardOf(s, "03").status === "ready",
      60_000,
    );
    expect(rederived.state.interrupts).toEqual([approval]);
    expect(cardOf(rederived, "02").mergeState).toBe("awaiting-approval");
    expect(rederived.phase).toBe("running");
    await Bun.sleep(1_000);
    expect(launchKeys(world).sort()).toEqual(["01", "02", "02.resolver"]);

    await answer(second, { ticketId: "02", action: "approve" });
    const done = await approveReview(second, 60_000);
    expect(Object.fromEntries(done.state.tickets.map((each) => [each.id, each.status]))).toEqual({
      "01": "done",
      "02": "done",
      "03": "done",
    });
    expect(done.state.mergeQueue).toEqual([]);
    expect(launchKeys(world).sort()).toEqual(["01", "02", "02.resolver", "03"]);
    expect(gitIn(world.repo, ["show", "main:shared.txt"])).toBe("resolved-by-agent\n");
    expect(gitIn(world.repo, ["branch", "--list", branch]).trim()).toBe("");
    const three = world.stubs.calls().find((call) => call.key === "03")!;
    expect(gitIn(world.repo, ["show", `${three.head}:shared.txt`])).toBe("resolved-by-agent\n");
  },
  { timeoutMs: 180_000 },
);

/**
 * Ticket `id` done on its pool branch, as a server that died before its
 * merge left it: its worktree on `pool/<key>/<id>` holding one commit main
 * lacks, and its state line done.
 */
function doneUnmerged(world: World, id: string): { path: string; branch: string } {
  const { path, branch } = ticketWorktree(world.repo, id);
  mkdirSync(join(path, ".."), { recursive: true });
  world.git(["worktree", "add", "-q", "-b", branch, path, "main"]);
  writeFileSync(join(path, `${id}.txt`), `${id}'s work\n`);
  commitAll(path, `work-${id}`);
  writeFileSync(join(world.pool, "issues", `${id}-t.md`), `${stateLine(id, "done")}\n\n# ${id}\n\nWork on ${id}.\n`);
  return { path, branch };
}

// A pool checkout gate (ADR-0027) once recorded the merge it held as `merge-deferred`, and a boot chained
// it again. No merge waits at a gate now, so a line an older engine wrote is skipped as an unknown kind.
conformance(
  "restart",
  "a merge-deferred line an older engine wrote is skipped at boot, and its Ticket is listed unmerged beside the others, by id",
  async (t) => {
    const world = t.world({
      config: { ...CONFIG, resolver: "claude" },
      repoFiles: { "shared.txt": "base\n" },
    });
    doneUnmerged(world, "03");
    const seven = doneUnmerged(world, "07");
    doneUnmerged(world, "09");
    mkdirSync(join(world.pool, "runs"), { recursive: true });
    writeFileSync(
      join(world.pool, "runs", "07.events.jsonl"),
      `${JSON.stringify({ at: "2026-09-05T00:00:00.000Z", attempt: 1, kind: "merge-deferred", payload: seven })}\n`,
    );

    const server = await t.start(world);
    const listed = await untilState(server, "the three unmerged Tickets listed", (s) => s.state.mergeQueue.length === 3);
    expect(queueOf(listed)).toEqual(["03:stalled", "07:stalled", "09:stalled"]);
    expect(interruptsOf(listed)).toEqual([]);
    expect(launchKeys(world)).toEqual([]);
    expect((await poolLog(server)).join("\n")).not.toContain("chained again");
    expect((await events(server.http, "07")).events.map((event) => event.kind)).not.toContain("merge-deferred");
    expect(gitIn(world.repo, ["log", "main", "--format=%s"]).split("\n")).not.toContain("work-07");
  },
  { timeoutMs: 120_000 },
);

// Gap: engine/worktrees.ts:332-341 (removeStaleMergeCheckout), called at
// boot from engine/engine.ts:1217.
conformance("restart", "a merge checkout a dead server left registered is dropped at boot, before the first launch", async (t) => {
  const world = t.world({ tickets: [ticket("01", "t")], config: CONFIG });
  // An enlist moved the pool checkout off the merge target, and a server
  // died with its merge checkout open on main, a file left in it.
  world.git(["checkout", "-q", "-b", "feature/x"]);
  const stale = join(gitCommonDir(world.repo), "pool-worktrees", poolKey(world.repo), ".merge-checkout");
  mkdirSync(join(stale, ".."), { recursive: true });
  world.git(["worktree", "add", "-q", stale, "main"]);
  writeFileSync(join(stale, "half-merged.txt"), "left by a dead server\n");
  expect(worktreeList(world.repo).map((entry) => entry.branch)).toEqual(["feature/x", "main"]);
  // 01's launch records what git had registered as it started.
  world.stubs.script("01", {
    run: 'git worktree list --porcelain > "$CONFORMANCE_STUBS/worktrees-at-launch"',
  });

  const server = await t.start(world);
  await until(() => launchKeys(world), (keys) => keys.includes("01"), { what: "01's launch", ms: 30_000 });
  await approveReview(server);

  const atLaunch = join(world.stubs.dir, "worktrees-at-launch");
  expect(existsSync(atLaunch)).toBe(true);
  expect(Bun.file(atLaunch).size).toBeGreaterThan(0);
  expect(await Bun.file(atLaunch).text()).not.toContain(".merge-checkout");
  expect(existsSync(stale)).toBe(false);
  expect(worktreeList(world.repo).map((entry) => [entry.path, entry.branch])).toEqual([[world.repo, "feature/x"]]);
  // main is free to be checked out again.
  const probe = join(world.root, "probe");
  world.git(["worktree", "add", "-q", probe, "main"]);
  world.git(["worktree", "remove", "--force", probe]);
});
