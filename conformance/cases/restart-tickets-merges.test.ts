/**
 * Merges across a stop and start, seen from outside the server (ADR-0036):
 * the Merge hold a new server derives from what the last one left in the
 * Ticket files and in git, the Merge queue it reads back, and the merge
 * checkout a dead server left registered. Ticket C05 of the inventory's
 * split (docs/research/rust-port/test-inventory.md): each case names the
 * engine test it carries over, or the uncovered behaviour it pins.
 *
 * The hold is never persisted (ADR-0014): every boot derives it afresh from
 * the state lines (a done Ticket) and git (its pool branch not yet in the
 * merge target). A held pool reads phase running while it waits.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../engine/wire.ts";
import type { CaseServer } from "../harness/case.ts";
import { conformance } from "../harness/case.ts";
import { cardOf, commitAll, gitCommonDir, gitIn, poolKey, ticketWorktree, worktreeList } from "../harness/git-pool.ts";
import { CLAUDE_READY, type HerdrCall } from "../harness/herdr.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  CONFIG,
  TERMINAL,
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

/** The pool log line the drive writes as the hold pauses it. */
const PAUSED = "merge hold (ADR-0014): pool paused; awaiting the merge of";

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

/** How many pool log lines contain `text`. */
async function logCount(server: CaseServer, text: string): Promise<number> {
  return (await poolLog(server)).filter((line) => line.includes(text)).length;
}

// engine/engine.test.ts:11223
restartCase(
  "a killed server's Merge hold is derived again by the next from state lines and branches alone",
  async (t) => {
    const config: PoolConfig = { ...CONFIG, resolver: "claude" };
    const world = t.world({
      tickets: [ticket("01", "t"), ticket("02", "t"), ticket("03", "t")],
      config,
      repoFiles: { "shared.txt": "base\n" },
    });
    // 01 and 02 overwrite one line, 02 only once 01's work is on main, so
    // 02's merge always conflicts. The resolver reproduces the conflict and
    // stages its resolution. 03 checkpoints on its first run.
    world.stubs.script("01", { run: overwriteShared("from-01", "work-01") });
    world.stubs.script("02", { run: `${waitOnMain("work-01")}\n${overwriteShared("from-02", "work-02")}` });
    world.stubs.script("03", { statuses: ["checkpoint", "done"] });
    world.stubs.script("02.resolver", {
      run: [
        "git merge main >/dev/null 2>&1 || true",
        "printf '%s\\n' resolved-by-agent > shared.txt",
        "git add shared.txt",
      ].join("\n"),
      outcomeRaw: JSON.stringify({ resolved: true, note: "kept both lines" }),
    });

    // Server one: 02's merge waits on the operator's approval and holds the
    // pool, with 03's checkpoint beside it.
    const first = await startLeg(t, world, 0);
    const held = await untilState(
      first,
      "02's merge-approval holding the pool beside 03's checkpoint",
      (s) => interruptsOf(s).join(" ") === "02:merge-approval 03:checkpoint" && queueOf(s).join(" ") === "02:awaiting-approval",
      60_000,
    );
    const approval = held.state.interrupts.find((i) => i.kind === "merge-approval")!;

    // Resuming 03 under the hold answers its checkpoint: the state line goes
    // back to ready, and nothing launches while the hold stands.
    await answer(first, { ticketId: "03" });
    await until(() => readStateLine(world.pool, "03-t.md").status, (status) => status === "ready", {
      what: "03's state line back to ready",
      ms: 30_000,
    });
    await untilState(first, "03's answer processed", (s) => s.state.queuedAnswers.length === 0 && interruptsOf(s).join(" ") === "02:merge-approval");
    const pausedBefore = await logCount(first, PAUSED);
    await first.kill();
    expect(launchKeys(world).sort()).toEqual(["01", "02", "02.resolver", "03"]);
    const branch = ticketWorktree(world.repo, "02").branch;
    expect(gitIn(world.repo, ["log", "main", "--format=%s"]).split("\n")).not.toContain("work-02");

    // Server two derives the hold afresh: 02's approval is back and alone,
    // and the drive pauses with 03 ready rather than launching it.
    const second = await startLeg(t, world, 1);
    const rederived = await untilState(
      second,
      "the hold derived again, 02's approval alone",
      (s) =>
        interruptsOf(s).join(" ") === "02:merge-approval" &&
        queueOf(s).join(" ") === "02:awaiting-approval" &&
        cardOf(s, "03").status === "ready",
      60_000,
    );
    expect(rederived.state.interrupts).toEqual([approval]);
    expect(cardOf(rederived, "02").mergeState).toBe("awaiting-approval");
    await until(() => logCount(second, PAUSED), (n) => n > pausedBefore, {
      what: "the second server's drive paused by the hold",
      ms: 30_000,
    });
    expect(launchKeys(world).sort()).toEqual(["01", "02", "02.resolver", "03"]);

    // Approving lands 02's merge the way it would have on server one; the
    // hold lifts and 03 runs again from the ready state line.
    await answer(second, { ticketId: "02", action: "approve" });
    const done = await approveReview(second, 60_000);
    expect(Object.fromEntries(done.state.tickets.map((each) => [each.id, each.status]))).toEqual({
      "01": "done",
      "02": "done",
      "03": "done",
    });
    expect(done.state.mergeQueue).toEqual([]);
    expect(launchKeys(world).sort()).toEqual(["01", "02", "02.resolver", "03", "03"]);
    expect(gitIn(world.repo, ["show", "main:shared.txt"])).toBe("resolved-by-agent\n");
    expect(gitIn(world.repo, ["branch", "--list", branch]).trim()).toBe("");
  },
  { timeoutMs: 180_000 },
);

/** The Enter that submits a typed Turn: keys alone, no text. */
function submits(call: HerdrCall): boolean {
  return (
    call.method === "pane.send_input" &&
    call.params.text === undefined &&
    Array.isArray(call.params.keys) &&
    (call.params.keys as string[]).includes("enter")
  );
}

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

// engine/merge-hold.test.ts:526
restartCase(
  "a restart takes on a merge a shutdown dropped first, and lists the held Tickets it never took after it, by id",
  async (t) => {
    // 01 is a lone Ticket, so it works in the pool checkout; Keep talking
    // continues it there, and a Continued attempt in the pool checkout holds
    // every merge into it at the gate until it ends.
    const world = t.world({ tickets: [ticket("01", "t")], config: TERMINAL });
    world.stubs.script("01", { status: "checkpoint", brief: "ask me", hold: 120 });
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    const first = await startLeg(t, world, 0, { herdr });
    await untilState(first, "01's pane held at its checkpoint", (s) => cardOf(s, "01").heldPane?.attempt === 1);
    const from = herdr.calls.length;
    const continued = await first.http.post("/api/keep-talking", { ticketId: "01" });
    expect(continued.status).toBe(202);
    await herdr.waitForCall(submits, { from, ms: 30_000 });
    await first.stop();

    // While no server runs: 03, 07 and 09 done on branches main lacks, as a
    // server that died before their merges left them. 07's merge was held
    // at the gate when it stopped, so its events end in merge-deferred.
    doneUnmerged(world, "03");
    const seven = doneUnmerged(world, "07");
    doneUnmerged(world, "09");
    writeFileSync(
      join(world.pool, "runs", "07.events.jsonl"),
      `${JSON.stringify({ at: "2026-09-05T00:00:00.000Z", attempt: 1, kind: "merge-deferred", payload: seven })}\n`,
    );

    const second = await startLeg(t, world, 1, { herdr });
    const taken = await untilState(
      second,
      "07's merge taken on and waiting at the gate",
      (s) => cardOf(s, "01").liveAttempt?.attempt === 2 && s.state.mergeQueue.length === 3,
      60_000,
    );
    // 07 is the one merge the restart took on: first, queued. The two it
    // never took follow, by id, and stall, with no merge Interrupt raised
    // for any; the one Interrupt up is the re-adopted Continued attempt's.
    expect(taken.state.mergeQueue).toEqual([
      { ticketId: "07", state: "queued" },
      { ticketId: "03", state: "stalled" },
      { ticketId: "09", state: "stalled" },
    ]);
    expect(interruptsOf(taken)).toEqual(["01:checkpoint"]);
    expect(await poolLog(second)).toContain("ticket 07: merge dropped at the last shutdown chained again");
    expect(gitIn(world.repo, ["log", "main", "--format=%s"]).split("\n")).not.toContain("work-07");

    // The Continued attempt ends done; the gate opens and 07's merge lands,
    // leaving the two it never took.
    writeFileSync(join(world.pool, "runs", "01.outcome.json"), JSON.stringify({ status: "done", summary: "talked", commitSha: null }));
    const landed = await untilState(
      second,
      "07 merged, 03 and 09 left",
      (s) => s.state.mergeQueue.map((entry) => entry.ticketId).join(" ") === "03 09",
      60_000,
    );
    expect(landed.state.mergeQueue).toEqual([
      { ticketId: "03", state: "stalled" },
      { ticketId: "09", state: "stalled" },
    ]);
    expect(gitIn(world.repo, ["show", "main:07.txt"])).toBe("07's work\n");
  },
  { timeoutMs: 180_000 },
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
