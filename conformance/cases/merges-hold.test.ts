/**
 * The Merge hold (ADR-0014) and the Merge queue it feeds (issue #129), seen
 * from outside the server (ADR-0036): the snapshot's mergeQueue, the pool
 * log, the Ticket markers, git state in the world's repository, the stub
 * launches the server made and the frames on /api/ws.
 *
 * A Ticket "done on an unmerged branch" is seeded before the server starts:
 * its marker says done and its pool branch, `pool/<key>/<id>`, holds a commit
 * the merge target lacks. Two Tickets conflict when both overwrite
 * shared.txt, committed in the world's first commit; the second waits until
 * the first's commit is on main before it commits, so it is always the
 * second merge that conflicts.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../engine/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import {
  approveReview,
  branches,
  cardOf,
  gitIn,
  gitOk,
  poolLog,
  resume,
  stateOf,
  ticketWorktree,
  untilLogged,
  untilState,
} from "../harness/git-pool.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";

const CONFIG: PoolConfig = { defaults: { harness: "claude", model: "m" } };
const NO_RESOLVER: PoolConfig = { ...CONFIG, resolver: "none" };
const PAUSED = "merge hold (ADR-0014): pool paused";

function marker(id: string, status = "ready", blockedBy = "none"): string {
  return `<!-- state: id=${id} blocked-by=${blockedBy} status=${status} -->`;
}

function ticket(id: string, status = "ready", blockedBy = "none") {
  return { file: `${id}-t.md`, marker: marker(id, status, blockedBy) };
}

/** Bash for a stub: overwrite `file` with `line` and commit it as `message`. */
function overwrite(file: string, line: string, message: string): string {
  return `printf '%s\\n' '${line}' > ${file}; git add -A; git commit -qm '${message}'`;
}

/** Bash for a stub: wait (up to 30 s) until a commit titled `subject` is on main. */
function waitOnMain(subject: string): string {
  // grep without -q reads the whole log, so git never dies of SIGPIPE.
  const seen = `git log main --format=%s | grep -x '${subject}' >/dev/null`;
  return `for _ in $(seq 1 600); do if ${seen}; then break; fi; sleep 0.05; done; ${seen}`;
}

/** Ticket `id`'s pool branch, made before the server starts with a commit main lacks. */
function seedBranch(world: World, id: string, checkout = world.repo): string {
  const { branch } = ticketWorktree(checkout, id);
  world.git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(world.repo, `w-${id}.txt`), `work for ${id}\n`);
  world.git(["add", `w-${id}.txt`]);
  world.git(["commit", "-qm", `work ${id}`]);
  world.git(["checkout", "-q", "main"]);
  return branch;
}

/** Point `branch` at a fresh commit off main, without touching any checkout. */
function commitOffMain(world: World, branch: string, message: string): void {
  const sha = world.git(["commit-tree", "main^{tree}", "-p", "main", "-m", message]).trim();
  world.git(["update-ref", `refs/heads/${branch}`, sha]);
}

/** The operator's merge by hand in the checkout: it conflicts, they keep `resolved`. */
function handResolve(world: World, branch: string, message: string): void {
  expect(gitOk(world.repo, ["merge", "--no-edit", branch])).toBe(false);
  writeFileSync(join(world.repo, "shared.txt"), "resolved\n");
  world.git(["add", "shared.txt"]);
  world.git(["commit", "-qm", message]);
}

function launches(world: World, key: string): number {
  return world.stubs.calls().filter((call) => call.key === key).length;
}

function untilLaunched(world: World, key: string, ms = 15_000): Promise<unknown> {
  return until(() => launches(world, key), (n) => n > 0, { ms, what: `a launch of ${key}` });
}

function queueOf(snapshot: { state: { mergeQueue: { ticketId: string; state: string }[] } }) {
  return snapshot.state.mergeQueue;
}

/** The hold stands on exactly `ids`, as the snapshot's Merge queue names them. */
function untilHeld(server: CaseServer, ids: string[], ms = 15_000) {
  return untilState(
    server,
    (s) => JSON.stringify(queueOf(s).map((e) => e.ticketId)) === JSON.stringify(ids),
    { ms, what: `a Merge queue of [${ids.join(", ")}]` },
  );
}

async function untilDone(server: CaseServer, ms = 30_000): Promise<void> {
  await approveReview(server, { ms });
  await untilState(server, (s) => s.phase === "done", { ms, what: "the run to end done" });
}

/** Ticket 02's merge-conflict Interrupt, raised once its merge clashed with 01's. */
function untilConflict(server: CaseServer, id = "02", ms = 30_000) {
  return untilState(
    server,
    (s) => s.state.interrupts.some((i) => i.ticketId === id && i.kind === "merge-conflict"),
    { ms, what: `a merge-conflict Interrupt on ${id}` },
  );
}

/** 01 and 02 both overwrite shared.txt; 02 commits only once 01's work is on main. */
function scriptClash(world: World, second = "02", first = "01"): void {
  world.stubs.script(first, { run: overwrite("shared.txt", `from-${first}`, `work-${first}`) });
  world.stubs.script(second, {
    run: `${waitOnMain(`work-${first}`)}; ${overwrite("shared.txt", `from-${second}`, `work-${second}`)}`,
  });
}

conformance(
  "merges",
  "a clashing merge holds the pool, the unrelated Tickets it already ran finish and merge, and a hand merge plus resume ends the run done",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02"), ticket("03")],
      config: NO_RESOLVER,
      repoFiles: { "shared.txt": "base\n" },
    });
    scriptClash(world);
    world.stubs.script("03", { run: `echo three > three.txt; git add -A; git commit -qm work-03` });
    const server = await t.start(world);
    const two = ticketWorktree(world.repo, "02");

    await untilConflict(server);
    const held = await untilState(
      server,
      (s) => ["01", "02", "03"].every((id) => cardOf(s, id).status === "done") && queueOf(s).length === 1,
      { what: "all three done under the hold" },
    );
    expect(world.stubs.calls().map((c) => c.key).sort()).toEqual(["01", "02", "03"]);
    for (const id of ["01", "02", "03"]) expect(readStateLine(world.pool, `${id}-t.md`).status).toBe("done");
    const interrupts = held.state.interrupts;
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.ticketId).toBe("02");
    expect(interrupts[0]!.kind).toBe("merge-conflict");
    expect(interrupts[0]!.body).toContain("shared.txt");
    expect(interrupts[0]!.body).toContain(two.branch);
    expect(queueOf(held)).toEqual([{ ticketId: "02", state: "needs-you" }]);
    // The checkout is left clean: no half-made merge, 01's line, 03's file.
    expect(gitOk(world.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).toBe(false);
    expect(readFileSync(join(world.repo, "shared.txt"), "utf8")).toBe("from-01\n");
    expect(existsSync(join(world.repo, "three.txt"))).toBe(true);
    expect(branches(world.repo, "pool")).toEqual([two.branch]);
    expect(existsSync(two.path)).toBe(true);

    handResolve(world, two.branch, "resolve pool/02");
    await resume(server, "02");
    await untilDone(server);

    const done = await stateOf(server);
    expect(done.state.interrupts).toEqual([]);
    expect(readFileSync(join(world.repo, "shared.txt"), "utf8")).toBe("resolved\n");
    expect(branches(world.repo, "pool")).toEqual([]);
    expect(existsSync(two.path)).toBe(false);
  },
  { timeoutMs: 90_000 },
);

conformance(
  "merges",
  "a downstream Ticket waits until its blocker's conflicted merge lands, then runs with the blocker's outcome in its prompt",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02"), ticket("03", "ready", "02")],
      config: NO_RESOLVER,
      repoFiles: { "shared.txt": "base\n" },
    });
    scriptClash(world);
    world.stubs.script("02", {
      run: `${waitOnMain("work-01")}; ${overwrite("shared.txt", "from-02", "work-02")}`,
      outcome: { summary: "schema v2", commitSha: null },
    });
    world.stubs.script("03", { run: `echo three > three.txt; git add -A; git commit -qm work-03` });
    const server = await t.start(world);

    await untilConflict(server);
    await untilState(server, (s) => cardOf(s, "02").status === "done", { what: "02 done" });
    // Long enough for a held boundary to have scheduled 03 if it were going to.
    await Bun.sleep(1_000);
    expect(world.stubs.calls().map((c) => c.key).sort()).toEqual(["01", "02"]);
    expect(readStateLine(world.pool, "03-t.md").status).toBe("ready");

    handResolve(world, ticketWorktree(world.repo, "02").branch, "resolve pool/02");
    await resume(server, "02");
    await untilLaunched(world, "03");
    const three = world.stubs.calls().find((c) => c.key === "03")!;
    // A lone Ticket runs in the checkout itself, not a worktree.
    expect(three.cwd).toBe(world.repo);
    expect(three.argv.join("\n")).toContain("02: schema v2");
    await untilDone(server);
    expect(readStateLine(world.pool, "03-t.md").status).toBe("done");
  },
  { timeoutMs: 90_000 },
);

conformance(
  "merges",
  "a pool booted with a done Ticket unmerged holds, and a git merge in the checkout lifts it with no Console action",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "done"), ticket("02", "ready", "01")],
      config: CONFIG,
      repoFiles: { "shared.txt": "base\n" },
    });
    const branch = seedBranch(world, "01");
    world.stubs.script("02", { run: `echo two > two.txt; git add -A; git commit -qm work-02` });
    const server = await t.start(world);

    await untilLogged(server, PAUSED);
    const held = await untilHeld(server, ["01"]);
    // The engine's hold set is not on the wire; the Merge queue and the card carry it.
    expect(queueOf(held)).toEqual([{ ticketId: "01", state: "stalled" }]);
    expect(cardOf(held, "01").mergeState).toBe("stalled");
    expect(cardOf(held, "02").mergeState).toBe(null);
    expect(held.phase).toBe("running");
    await Bun.sleep(1_000);
    expect(launches(world, "02")).toBe(0);

    world.git(["merge", "--no-edit", branch]);
    await untilLaunched(world, "02");
    await untilDone(server);
    const done = await stateOf(server);
    expect(cardOf(done, "01").status).toBe("done");
    expect(cardOf(done, "02").status).toBe("done");
  },
  { timeoutMs: 60_000 },
);

conformance(
  "merges",
  "a verify round's graders are written but withheld while the hold stands, then grade and select once it lifts",
  async (t) => {
    const world = t.world({
      tickets: [{ ...ticket("01"), body: "# 01\n\nverify fan-out" }, ticket("02"), ticket("03")],
      config: { ...NO_RESOLVER, assign: { "01": { verify: 2 } } },
      repoFiles: { "shared.txt": "base\n" },
    });
    for (const key of ["01", "01.attempt-1", "01.attempt-2"]) {
      world.stubs.script(key, { run: `echo one > one.txt; git add -A; git commit -qm work-01` });
    }
    scriptClash(world, "02", "03");
    const server = await t.start(world);

    await untilConflict(server);
    await until(
      () => ["01-grader-1.md", "01-grader-2.md"].map((f) => existsSync(join(world.pool, "issues", f))),
      (seen) => seen.every(Boolean),
      { what: "the grader Tickets written" },
    );
    await Bun.sleep(1_500);
    const before = world.stubs.calls().map((c) => c.key);
    expect(before.filter((key) => key.includes("grader") || key.includes("head-to-head"))).toEqual([]);
    expect(before.filter((key) => key.startsWith("01")).length).toBe(2);
    expect(before.filter((key) => key === "02" || key === "03").sort()).toEqual(["02", "03"]);
    expect(readEvents(world.pool, "01-grader-1")).toEqual([]);
    expect(readEvents(world.pool, "01-grader-2")).toEqual([]);

    handResolve(world, ticketWorktree(world.repo, "02").branch, "resolve pool/02");
    await resume(server, "02");
    await untilLaunched(world, "01-head-to-head", 30_000);
    const after = world.stubs.calls().map((c) => c.key).slice(before.length);
    // Both graders, then the head-to-head their tied default grades call for.
    expect(after.slice().sort()).toEqual(["01-grader-1", "01-grader-2", "01-head-to-head"]);
    expect(after.at(-1)).toBe("01-head-to-head");
    await untilDone(server);
    const done = await stateOf(server);
    expect(cardOf(done, "01").status).toBe("done");
    expect(cardOf(done, "01-head-to-head").status).toBe("done");
  },
  { timeoutMs: 120_000 },
);

conformance(
  "merges",
  "the hold reads the checkout's current branch as the merge target, so a feature branch holds until the Ticket lands there",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02"), ticket("03", "ready", "02")],
      config: NO_RESOLVER,
      repoFiles: { "shared.txt": "base\n" },
    });
    scriptClash(world);
    world.stubs.script("03", { run: `echo three > three.txt; git add -A; git commit -qm work-03` });
    const server = await t.start(world);

    await untilConflict(server);
    await untilHeld(server, ["02"]);
    expect(world.stubs.calls().map((c) => c.key).sort()).toEqual(["01", "02"]);

    world.git(["checkout", "-q", "-b", "feature/x"]);
    handResolve(world, ticketWorktree(world.repo, "02").branch, "resolve pool/02 onto feature/x");
    // No Console action: the derivation sees 02 landed in feature/x.
    await untilLaunched(world, "03");
    expect(world.stubs.calls().find((c) => c.key === "03")!.cwd).toBe(world.repo);
    // The resume only clears the merge-conflict Interrupt the hand merge made moot.
    await resume(server, "02");
    await untilDone(server);
    expect(readStateLine(world.pool, "03-t.md").status).toBe("done");
    expect(readFileSync(join(world.repo, "shared.txt"), "utf8")).toBe("resolved\n");
    expect(gitIn(world.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/x");
  },
  { timeoutMs: 90_000 },
);

// The Merge hold rule, one pool per row (merge-hold.test.ts's derivation
// table). A pool that is not held settles quiescent or reaches Review; a held
// pool stays running (ADR-0014: the pause is a wait, not a quiesce).

conformance("merges", "Merge hold rule: a pool outside any git repository holds nothing", async (t) => {
  const world = t.world({ config: CONFIG });
  const pool = join(world.root, "plain", "pool");
  mkdirSync(join(pool, "issues"), { recursive: true });
  writeFileSync(join(pool, "issues", "01-t.md"), `${marker("01", "done")}\n\n# body\n`);
  writeFileSync(join(pool, "console.json"), JSON.stringify(CONFIG));
  expect(gitOk(pool, ["rev-parse", "--git-dir"])).toBe(false);
  const server = await t.start(world, { pool });
  const review = await untilState(server, (s) => s.state.interrupts.some((i) => i.kind === "review"), {
    what: "the Review gate",
  });
  expect(queueOf(review)).toEqual([]);
  expect((await poolLog(server)).some((line) => line.includes(PAUSED))).toBe(false);
});

conformance(
  "merges",
  "Merge hold rule: with no Ticket done nothing holds, whatever pool branches exist",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "ready", "03"), ticket("02", "in-progress", "03"), ticket("03", "checkpoint")],
      config: CONFIG,
    });
    seedBranch(world, "01");
    seedBranch(world, "02");
    const server = await t.start(world);
    const settled = await untilState(server, (s) => s.phase === "quiescent", { what: "the pool to settle" });
    expect(queueOf(settled)).toEqual([]);
    expect(settled.state.interrupts.map((i) => `${i.ticketId}:${i.kind}`)).toEqual(["03:checkpoint"]);
    expect((await poolLog(server)).some((line) => line.includes(PAUSED))).toBe(false);
    expect(world.stubs.calls()).toEqual([]);
  },
);

conformance(
  "merges",
  "Merge hold rule: done grader and head-to-head Tickets never hold, even with unmerged branches by their names",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "checkpoint"), ticket("01-grader-1", "done"), ticket("01-head-to-head", "done")],
      config: CONFIG,
    });
    seedBranch(world, "01-grader-1");
    seedBranch(world, "01-head-to-head");
    const server = await t.start(world);
    const settled = await untilState(server, (s) => s.phase === "quiescent", { what: "the pool to settle" });
    expect(queueOf(settled)).toEqual([]);
    expect((await poolLog(server)).some((line) => line.includes(PAUSED))).toBe(false);
  },
);

conformance("merges", "Merge hold rule: a done Ticket whose branch is gone reads as landed", async (t) => {
  const world = t.world({ tickets: [ticket("01", "done"), ticket("02", "ready", "01")], config: CONFIG });
  expect(branches(world.repo, "pool")).toEqual([]);
  const server = await t.start(world);
  await untilLaunched(world, "02");
  const review = await untilState(server, (s) => s.state.interrupts.some((i) => i.kind === "review"), {
    what: "the Review gate",
  });
  expect(queueOf(review)).toEqual([]);
  expect((await poolLog(server)).some((line) => line.includes(PAUSED))).toBe(false);
});

conformance(
  "merges",
  "Merge hold rule: a done Ticket with an unmerged branch holds, one whose branch landed does not",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "done"), ticket("02", "done"), ticket("03")],
      config: CONFIG,
    });
    seedBranch(world, "01");
    world.git(["merge", "-q", "--no-edit", seedBranch(world, "02")]);
    const server = await t.start(world);
    const held = await untilHeld(server, ["01"]);
    expect(queueOf(held)).toEqual([{ ticketId: "01", state: "stalled" }]);
    expect(held.phase).toBe("running");
    await untilLogged(server, `${PAUSED}; awaiting the merge of 01`);
    await Bun.sleep(1_000);
    expect(world.stubs.calls()).toEqual([]);
  },
);

conformance(
  "merges",
  "Merge hold rule: a branch landed in main still holds while the checkout is on feature/x",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "done")], config: CONFIG });
    world.git(["branch", "feature/x"]);
    world.git(["merge", "-q", "--no-edit", seedBranch(world, "01")]);
    world.git(["checkout", "-q", "feature/x"]);
    const server = await t.start(world);
    const held = await untilHeld(server, ["01"]);
    expect(queueOf(held)).toEqual([{ ticketId: "01", state: "stalled" }]);
    expect(held.phase).toBe("running");
  },
);

conformance(
  "merges",
  "the hold releases when the branch is merged by hand, and holds again when main is moved back past the merge",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "done"), ticket("02")], config: CONFIG });
    const branch = seedBranch(world, "01");
    const release = join(world.root, "release-02");
    world.stubs.script("02", { waitFor: release });
    const server = await t.start(world);

    await untilHeld(server, ["01"]);
    await Bun.sleep(1_000);
    expect(launches(world, "02")).toBe(0);

    const before = world.git(["rev-parse", "main"]).trim();
    world.git(["merge", "-q", "--no-edit", branch]);
    await untilLaunched(world, "02");
    await untilHeld(server, []);

    // The merge undone: main moved back with update-ref, the way a reset would.
    world.git(["update-ref", "refs/heads/main", before]);
    writeFileSync(release, "");
    const again = await untilState(server, (s) => cardOf(s, "02").status === "done", { what: "02 done" });
    // The first snapshot after the reset that the drive emitted carries the hold again.
    expect(queueOf(again).map((e) => e.ticketId)).toEqual(["01"]);
  },
);

conformance(
  "merges",
  "the hold sees a branch packed away from its loose ref, reads it deleted as landed, and holds again when it is made anew",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "done"), ticket("02")], config: CONFIG });
    const branch = seedBranch(world, "01");
    const release = join(world.root, "release-02");
    world.stubs.script("02", { waitFor: release });
    const server = await t.start(world);
    const loose = join(world.repo, ".git", "refs", "heads", ...branch.split("/"));

    await untilHeld(server, ["01"]);
    expect(existsSync(loose)).toBe(true);
    world.git(["pack-refs", "--all"]);
    expect(existsSync(loose)).toBe(false);
    // Several poll ticks and a watch interval: still held, nothing launched.
    await Bun.sleep(2_500);
    expect(queueOf(await stateOf(server)).map((e) => e.ticketId)).toEqual(["01"]);
    expect(launches(world, "02")).toBe(0);

    world.git(["branch", "-D", branch]);
    await untilLaunched(world, "02");
    await untilHeld(server, []);

    commitOffMain(world, branch, "again");
    writeFileSync(release, "");
    const again = await untilState(server, (s) => cardOf(s, "02").status === "done", { what: "02 done" });
    expect(queueOf(again).map((e) => e.ticketId)).toEqual(["01"]);
  },
);

conformance(
  "merges",
  "a pool in a linked checkout holds against that checkout's own branch, and releases when that branch takes the merge",
  async (t) => {
    const world = t.world({ config: CONFIG });
    const linked = join(world.root, "linked");
    world.git(["worktree", "add", "-q", linked, "-b", "feature"]);
    const pool = join(linked, ".scratch", "pool");
    mkdirSync(join(pool, "issues"), { recursive: true });
    writeFileSync(join(pool, "issues", "01-t.md"), `${marker("01", "done")}\n\n# body\n`);
    writeFileSync(join(pool, "issues", "02-t.md"), `${marker("02", "ready", "01")}\n\n# body\n`);
    writeFileSync(join(pool, "console.json"), JSON.stringify(CONFIG));
    // 01's branch is keyed by the linked checkout, and landed in main only.
    const branch = seedBranch(world, "01", linked);
    expect(branch).not.toBe(ticketWorktree(world.repo, "01").branch);
    world.git(["merge", "-q", "--no-edit", branch]);

    const server = await t.start(world, { pool });
    const held = await untilHeld(server, ["01"]);
    expect(queueOf(held)).toEqual([{ ticketId: "01", state: "stalled" }]);
    await Bun.sleep(1_000);
    expect(launches(world, "02")).toBe(0);

    gitIn(linked, ["checkout", "-q", "--detach"]);
    gitIn(linked, ["checkout", "-qB", "feature", "main"]);
    await untilLaunched(world, "02");
    expect(world.stubs.calls().find((c) => c.key === "02")!.cwd).toBe(linked);
    await untilHeld(server, []);
  },
);

conformance(
  "merges",
  "a held pool pushes no snapshot while the hold is unchanged, and one with an empty Merge queue soon after a hand merge",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "done"), ticket("02")], config: CONFIG });
    const branch = seedBranch(world, "01");
    const release = join(world.root, "release-02");
    world.stubs.script("02", { waitFor: release });
    const server = await t.start(world);
    await untilHeld(server, ["01"]);

    const socket = await t.socket(server, { visible: true });
    await socket.sync();
    expect(queueOf(socket.pushed!.snapshot).map((e) => e.ticketId)).toEqual(["01"]);
    const pushes = () => socket.frames.filter((f) => f.type === "snapshot" || f.type === "delta").length;
    const quiet = pushes();
    // Two and a half watch intervals and twenty wait ticks.
    await Bun.sleep(5_000);
    await socket.sync();
    expect(pushes()).toBe(quiet);

    world.git(["merge", "-q", "--no-edit", branch]);
    const merged = Date.now();
    await until(
      () => socket.pushed!.snapshot,
      (s) => queueOf(s).length === 0,
      { ms: 5_000, what: "a pushed snapshot with an empty Merge queue" },
    );
    expect(Date.now() - merged).toBeLessThan(3_000);
    await untilLaunched(world, "02");
    writeFileSync(release, "");
  },
);

conformance(
  "merges",
  "a held boundary logs its pause once, applies a resume within a poll tick, and pushes nothing while idle",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01", "done"), ticket("02", "done"), ticket("03", "checkpoint")],
      config: CONFIG,
    });
    seedBranch(world, "01");
    seedBranch(world, "02");
    const server = await t.start(world);
    const held = await untilHeld(server, ["01", "02"]);
    expect(held.state.interrupts.map((i) => `${i.ticketId}:${i.kind}`)).toEqual(["03:checkpoint"]);

    const socket = await t.socket(server, { visible: true });
    await socket.sync();
    const pushes = () => socket.frames.filter((f) => f.type === "snapshot" || f.type === "delta").length;
    let quiet = pushes();
    await Bun.sleep(1_500);
    await socket.sync();
    expect(pushes()).toBe(quiet);

    const asked = Date.now();
    await resume(server, "03");
    await until(
      () => socket.pushed!.snapshot,
      (s) => s.state.interrupts.length === 0 && cardOf(s, "03").status === "ready",
      { ms: 3_000, what: "the resume applied" },
    );
    expect(Date.now() - asked).toBeLessThan(1_000);
    expect(readStateLine(world.pool, "03-t.md").status).toBe("ready");

    // Applied, then idle: no further push, and 03 stays withheld.
    await Bun.sleep(300);
    await socket.sync();
    quiet = pushes();
    await Bun.sleep(1_500);
    await socket.sync();
    expect(pushes()).toBe(quiet);
    expect(world.stubs.calls()).toEqual([]);
    const paused = (await poolLog(server)).filter((line) => line.includes(PAUSED));
    expect(paused).toEqual([expect.stringContaining(`${PAUSED}; awaiting the merge of 01, 02`)]);
  },
);
