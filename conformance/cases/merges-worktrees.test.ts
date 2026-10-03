/**
 * Pool worktrees and branches, seen from outside the server (ADR-0036): where
 * each Ticket's Attempt runs, which branch it commits on, how its work lands
 * on the pool's working branch, and what is left in git afterwards. The
 * rows are the inventory's `merges` worktree rows (engine.test.ts "worktrees"
 * and worktrees.test.ts "pool namespacing") plus two of its `merges` gaps:
 * the worktree key and removeWorktree.
 *
 * The stub harness does the agent's git work through its `run` script, in
 * the working directory the server launched it in, and records what it saw
 * (HEAD, branch, cwd) under $CONFORMANCE_STUBS/rec/<name>.
 */

import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../engine/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import {
  approveReview,
  branches,
  gitCommonDir,
  gitIn,
  gitOk,
  resume,
  ticketWorktree,
  untilLogged,
  untilState,
  worktreeList,
} from "../harness/git-pool.ts";
import { parseJsonl, readEvents, readStateLine, readTicketFile, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";

const CONFIG: PoolConfig = { defaults: { harness: "claude", model: "m" } };

function ready(id: string): { file: string; marker: string } {
  return { file: `${id}-t.md`, marker: `<!-- state: id=${id} blocked-by=none status=ready -->` };
}

/** Bash: record HEAD, the checked-out branch and the cwd under rec/<name>. */
function record(name: string): string {
  return [
    `rec="$CONFORMANCE_STUBS/rec/${name}"`,
    'mkdir -p "$rec"',
    'git rev-parse HEAD > "$rec/head"',
    'git branch --show-current > "$rec/branch"',
    'pwd > "$rec/cwd"',
  ].join("\n");
}

/** Bash: write `file` in the cwd and commit it with `subject`. */
function commit(file: string, subject: string): string {
  return `printf 'work\\n' > ${file}\ngit add ${file}\ngit commit -qm '${subject}'`;
}

/** Bash: wait up to 15 s for `path` to exist, failing the launch if it never does. */
function waitFile(path: string): string {
  return `for _ in $(seq 1 300); do [ -e '${path}' ] && break; sleep 0.05; done\n[ -e '${path}' ]`;
}

/** What a launch recorded under rec/<name>. */
function recorded(world: World, name: string, field: "head" | "branch" | "cwd"): string {
  return readFileSync(join(world.stubs.dir, "rec", name, field), "utf8").trim();
}

/**
 * Every pool/<key>/<id> branch. git's for-each-ref glob `*` stops at a
 * slash, so `refs/heads/pool/*` never matches a keyed branch; the bare
 * prefix `refs/heads/pool` matches everything under it.
 */
function poolBranches(checkout: string): string[] {
  return branches(checkout, "pool");
}

/** Subjects on a branch, newest first. */
function subjects(checkout: string, branch: string): string[] {
  return gitIn(checkout, ["log", "--format=%s", branch]).split("\n").filter((line) => line !== "");
}

/** A second pool in a linked worktree of the world's repository, on its own branch. */
function linkedPool(world: World, branch: string, poolName: string, ids: string[], config: PoolConfig = CONFIG) {
  const checkout = join(world.root, `checkout-${poolName}`);
  world.git(["worktree", "add", "-q", checkout, "-b", branch, "HEAD"]);
  const pool = join(checkout, ".scratch", poolName);
  mkdirSync(join(pool, "issues"), { recursive: true });
  for (const id of ids) {
    const seed = ready(id);
    writeFileSync(join(pool, "issues", seed.file), `${seed.marker}\n\n# body\n`);
  }
  writeFileSync(join(pool, "console.json"), JSON.stringify(config, null, 2));
  return { checkout, pool };
}

async function untilDone(server: CaseServer): Promise<EnrichedSnapshot> {
  await approveReview(server);
  return untilState(server, (s) => s.phase === "done", { ms: 20_000, what: "the run to end done" });
}

function hasInterrupt(snapshot: EnrichedSnapshot, ticketId: string, kind: string): boolean {
  return snapshot.state.interrupts.some((i) => i.ticketId === ticketId && i.kind === kind);
}

/** Bash: the pool directory's name, from the Ticket file the prompt names. */
const POOL_NAME = 'pool="$(basename "$(dirname "$(dirname "$STUB_ISSUE")")")"';

conformance(
  "merges",
  "a multi-ticket super-step runs its Tickets at once, each in its own worktree branched from the same HEAD",
  async (t) => {
    const world = t.world({ tickets: [ready("01"), ready("02")], config: CONFIG });
    const head = world.git(["rev-parse", "HEAD"]).trim();
    const started = (id: string) => join(world.root, `started-${id}`);
    for (const [id, other, file] of [
      ["01", "02", "one.txt"],
      ["02", "01", "two.txt"],
    ] as const) {
      // The rendezvous passes only if both launches are alive at once.
      world.stubs.script(id, {
        run: [`touch '${started(id)}'`, waitFile(started(other)), record(id), commit(file, `work-${id}`)].join("\n"),
      });
    }
    const server = await t.start(world);
    await untilDone(server);

    for (const id of ["01", "02"]) {
      expect(readStateLine(world.pool, `${id}-t.md`).status).toBe("done");
      const worktree = ticketWorktree(world.repo, id);
      expect(recorded(world, id, "head")).toBe(head);
      expect(recorded(world, id, "branch")).toBe(worktree.branch);
      expect(recorded(world, id, "cwd")).toBe(worktree.path);
    }
    expect(subjects(world.repo, "main")).toEqual(expect.arrayContaining(["work-01", "work-02"]));
    expect(existsSync(join(world.repo, "one.txt"))).toBe(true);
    expect(existsSync(join(world.repo, "two.txt"))).toBe(true);
    // Clean merges leave nothing behind: the main checkout only, no pool branch.
    expect(worktreeList(world.repo).map((w) => w.path)).toEqual([realpathSync(world.repo)]);
    expect(poolBranches(world.repo)).toEqual([]);
  },
);

conformance(
  "merges",
  "a pool reached through a symlink runs like its canonical spelling, every prompt naming its Ticket under the real path",
  async (t) => {
    const world = t.world({ tickets: [ready("01"), ready("02")], config: CONFIG });
    const link = join(world.root, "link");
    symlinkSync(world.repo, link);
    const server = await t.start(world, { pool: join(link, ".scratch", "pool") });
    await untilDone(server);

    for (const id of ["01", "02"]) {
      expect(readStateLine(world.pool, `${id}-t.md`).status).toBe("done");
    }
    const canonical = realpathSync(world.pool);
    const calls = world.stubs.calls();
    expect(calls.map((c) => c.key).sort()).toEqual(["01", "02"]);
    for (const call of calls) {
      // Two ready Tickets never take the main checkout: each ran in its worktree.
      expect(call.cwd).toBe(ticketWorktree(world.repo, call.key).path);
      expect(call.issue).toBe(join(canonical, "issues", `${call.key}-t.md`));
      expect(existsSync(call.issue)).toBe(true);
    }
  },
);

conformance(
  "merges",
  "two pools sharing one repository keep out of each other's worktrees and branches",
  async (t) => {
    const world = t.world({ tickets: [ready("01"), ready("02")], config: CONFIG });
    const b = linkedPool(world, "pool-b-main", "pool-b", ["01", "02"]);
    // Both pools launch 01 and 02, so one script serves both, named by pool.
    for (const id of ["01", "02"]) {
      world.stubs.script(id, {
        run: [
          POOL_NAME,
          record("$pool-$STUB_KEY"),
          `printf 'work\\n' > "$pool-$STUB_KEY.txt"`,
          `git add "$pool-$STUB_KEY.txt"`,
          `git commit -qm "work $pool $STUB_KEY"`,
        ].join("\n"),
      });
    }

    const serverA = await t.start(world);
    await untilDone(serverA);
    await serverA.stop();
    const serverB = await t.start(world, { pool: b.pool });
    await untilDone(serverB);

    for (const id of ["01", "02"]) {
      const inA = ticketWorktree(world.repo, id);
      const inB = ticketWorktree(b.checkout, id);
      expect(inA.key).not.toBe(inB.key);
      expect(inA.branch).not.toBe(inB.branch);
      expect(recorded(world, `pool-${id}`, "cwd")).toBe(inA.path);
      expect(recorded(world, `pool-${id}`, "branch")).toBe(inA.branch);
      expect(recorded(world, `pool-b-${id}`, "cwd")).toBe(inB.path);
      expect(recorded(world, `pool-b-${id}`, "branch")).toBe(inB.branch);
    }
    const onMain = subjects(world.repo, "main");
    const onB = subjects(world.repo, "pool-b-main");
    expect(onMain).toEqual(expect.arrayContaining(["work pool 01", "work pool 02"]));
    expect(onMain.filter((s) => s.startsWith("work pool-b"))).toEqual([]);
    expect(onB).toEqual(expect.arrayContaining(["work pool-b 01", "work pool-b 02"]));
    expect(onB.filter((s) => s.startsWith("work pool 0"))).toEqual([]);
  },
);

conformance(
  "merges",
  "a worktree Attempt is handed the main checkout's absolute Ticket path, and its done Outcome merges it",
  async (t) => {
    const world = t.world({ tickets: [ready("01"), ready("02")], config: CONFIG });
    world.stubs.script("01", { run: commit("one.txt", "work-01") });
    world.stubs.script("02", { run: commit("two.txt", "work-02") });
    const server = await t.start(world);
    await untilDone(server);

    const canonical = realpathSync(world.pool);
    for (const id of ["01", "02"]) {
      const call = world.stubs.calls().find((c) => c.key === id)!;
      expect(call.issue).toBe(join(canonical, "issues", `${id}-t.md`));
      expect(call.cwd).toBe(ticketWorktree(world.repo, id).path);
      expect(readStateLine(world.pool, `${id}-t.md`).line).toBe(
        `<!-- state: id=${id} blocked-by=none status=done -->`,
      );
      expect(readEvents(world.pool, id).filter((e) => e.kind === "merged")).toHaveLength(1);
    }
    expect(subjects(world.repo, "main")).toEqual(expect.arrayContaining(["work-01", "work-02"]));
  },
);

conformance(
  "merges",
  "finished branches merge in completion order, and a running Ticket's branch is never rebased",
  async (t) => {
    const world = t.world({ tickets: [ready("01"), ready("02")], config: CONFIG });
    const head = world.git(["rev-parse", "HEAD"]).trim();
    // 01 stays alive until 02's commit is on main, then looks at its own HEAD.
    world.stubs.script("01", {
      run: [
        "for _ in $(seq 1 300); do",
        `  case "$(git -C '${world.repo}' log --format=%s main)" in *work-02*) break;; esac`,
        "  sleep 0.05",
        "done",
        `case "$(git -C '${world.repo}' log --format=%s main)" in *work-02*) ;; *) exit 42;; esac`,
        record("01"),
        commit("one.txt", "work-01"),
      ].join("\n"),
    });
    world.stubs.script("02", { run: commit("two.txt", "work-02") });
    const server = await t.start(world);
    await untilDone(server);

    expect(recorded(world, "01", "head")).toBe(head);
    const sha = (subject: string) =>
      gitIn(world.repo, ["log", "--format=%H %s", "main"])
        .split("\n")
        .find((line) => line.slice(41) === subject)!
        .slice(0, 40);
    const merge = gitIn(world.repo, ["rev-list", "--merges", "-n", "1", "main"]).trim();
    const parents = gitIn(world.repo, ["rev-list", "--parents", "-n", "1", merge]).trim().split(" ").slice(1);
    expect(parents).toEqual([sha("work-02"), sha("work-01")]);
    const baseOf01 = gitIn(world.repo, ["rev-list", "--parents", "-n", "1", sha("work-01")]).trim().split(" ")[1];
    expect(baseOf01).toBe(head);
  },
);

conformance(
  "merges",
  "a checkpointed Ticket's worktree stays parked with its partial work and is reused on resume",
  async (t) => {
    const world = t.world({ tickets: [ready("01"), ready("02")], config: CONFIG });
    world.stubs.script("01", {
      statuses: ["checkpoint", "done"],
      run: [
        `${commit("one.txt", "work-01")}\nprintf 'partial\\n' > partial.txt`,
        `[ -e partial.txt ]\n${record("01-resumed")}\n${commit("one-more.txt", "work-01b")}`,
      ],
    });
    world.stubs.script("02", { run: commit("two.txt", "work-02") });
    const server = await t.start(world);
    const held = await untilState(server, (s) => s.phase === "quiescent" && hasInterrupt(s, "01", "checkpoint"), {
      what: "01's checkpoint Interrupt with the pool quiescent",
    });
    expect(held.state.interrupts.find((i) => i.ticketId === "01")!.body).toBe(
      "The agent signalled a checkpoint but wrote no brief, so what the attempt completed is only " +
        "in the ticket log. Answer the interrupt to point the next attempt.",
    );
    const wt01 = ticketWorktree(world.repo, "01");
    const wt02 = ticketWorktree(world.repo, "02");
    expect(existsSync(join(wt01.path, "partial.txt"))).toBe(true);
    expect(gitOk(world.repo, ["rev-parse", "--verify", wt01.branch])).toBe(true);
    expect(existsSync(wt02.path)).toBe(false);
    expect(gitOk(world.repo, ["rev-parse", "--verify", wt02.branch])).toBe(false);

    await resume(server, "01", { note: "carry on" });
    await untilDone(server);

    const calls = world.stubs.calls();
    expect(calls.map((c) => c.key).slice(0, 2).sort()).toEqual(["01", "02"]);
    expect(calls.map((c) => c.key).slice(2)).toEqual(["01"]);
    expect(calls[2]!.cwd).toBe(wt01.path);
    expect(recorded(world, "01-resumed", "branch")).toBe(wt01.branch);
    expect(subjects(world.repo, "main")).toEqual(expect.arrayContaining(["work-01", "work-01b", "work-02"]));
    expect(existsSync(join(world.repo, "one.txt"))).toBe(true);
    expect(existsSync(join(world.repo, "one-more.txt"))).toBe(true);
    expect(gitOk(world.repo, ["rev-parse", "--verify", wt01.branch])).toBe(false);
    const ticket = readTicketFile(world.pool, "01-t.md");
    expect(ticket).toContain("status=done");
    expect(ticket).toContain("carry on");
  },
);

conformance(
  "merges",
  "a single-ticket super-step runs in the main checkout with no worktree or pool branch",
  async (t) => {
    const world = t.world({ tickets: [ready("01")], config: CONFIG });
    world.stubs.script("01", { run: [record("01"), commit("one.txt", "work-01")].join("\n") });
    const server = await t.start(world);
    await untilDone(server);

    expect(recorded(world, "01", "cwd")).toBe(realpathSync(world.repo));
    expect(recorded(world, "01", "branch")).toBe("main");
    expect(subjects(world.repo, "main")).toContain("work-01");
    expect(existsSync(join(world.repo, "one.txt"))).toBe(true);
    expect(poolBranches(world.repo)).toEqual([]);
    expect(worktreeList(world.repo)).toHaveLength(1);
  },
);

conformance(
  "merges",
  "two pools on one repository key their worktrees and branches apart, and a parked branch whose worktree was removed is reattached",
  async (t) => {
    const world = t.world({ tickets: [ready("02"), ready("03")], config: CONFIG });
    const b = linkedPool(world, "companion", "pool-b", ["02", "03"]);
    const release = join(world.root, "release");
    // Every launch writes its own outcome: pool A's first 02 commits and
    // checkpoints, every other launch is done.
    for (const id of ["02", "03"]) {
      world.stubs.script(id, {
        status: "keep",
        run: [
          POOL_NAME,
          'count="$CONFORMANCE_STUBS/count-$pool-$STUB_KEY"',
          'n=$(( $(cat "$count" 2>/dev/null || echo 0) + 1 ))',
          'echo "$n" > "$count"',
          record("$pool-$STUB_KEY-$n"),
          waitFile(release),
          'if [ "$pool-$STUB_KEY-$n" = "pool-02-1" ]; then',
          commit("parked.txt", "parked-02"),
          `  printf '{"status":"checkpoint","summary":"s","commitSha":null}' > "$STUB_OUTCOME"`,
          "else",
          `  printf '{"status":"done","summary":"s","commitSha":null}' > "$STUB_OUTCOME"`,
          "fi",
        ].join("\n"),
      });
    }
    const serverA = await t.start(world);
    const serverB = await t.start(world, { pool: b.pool });

    const inA = ticketWorktree(world.repo, "02");
    const inB = ticketWorktree(b.checkout, "02");
    // Both pools' 02 worktrees are registered at once, each on its own branch.
    const listed = await until(
      () => worktreeList(world.repo),
      (list) => [inA.path, inB.path].every((path) => list.some((w) => w.path === path)),
      { what: "both pools' 02 worktrees registered" },
    );
    expect(inA.key).toMatch(/^[0-9a-f]{8}$/);
    expect(inB.key).toMatch(/^[0-9a-f]{8}$/);
    expect(inA.key).not.toBe(inB.key);
    const common = gitCommonDir(world.repo);
    expect(inA.path).toBe(join(common, "pool-worktrees", inA.key, "02"));
    expect(inB.path).toBe(join(common, "pool-worktrees", inB.key, "02"));
    expect(listed.find((w) => w.path === inA.path)!.branch).toBe(`pool/${inA.key}/02`);
    expect(listed.find((w) => w.path === inB.path)!.branch).toBe(`pool/${inB.key}/02`);
    writeFileSync(release, "");

    await untilDone(serverB);
    await untilState(serverA, (s) => s.phase === "quiescent" && hasInterrupt(s, "02", "checkpoint"), {
      what: "pool A's 02 checkpointed",
    });
    const parkedTip = gitIn(world.repo, ["rev-parse", inA.branch]).trim();
    gitIn(world.repo, ["worktree", "remove", "--force", inA.path]);
    expect(worktreeList(world.repo).some((w) => w.path === inA.path)).toBe(false);

    await resume(serverA, "02");
    await untilDone(serverA);
    // The resumed 02 ran on its old branch at its parked commit, at the same path.
    expect(recorded(world, "pool-02-2", "cwd")).toBe(inA.path);
    expect(recorded(world, "pool-02-2", "branch")).toBe(inA.branch);
    expect(recorded(world, "pool-02-2", "head")).toBe(parkedTip);
    expect(subjects(world.repo, "main")).toContain("parked-02");
  },
);

conformance(
  "merges",
  "two pools on one repository namespace their verify Attempt branches and worktrees apart",
  async (t) => {
    const config: PoolConfig = { ...CONFIG, assign: { "05": { verify: 1 } } };
    const world = t.world({ tickets: [ready("05")], config });
    const b = linkedPool(world, "companion", "pool-b", ["05"], config);
    const release = join(world.root, "release");
    world.stubs.script("05.attempt-1", { waitFor: release });
    const serverA = await t.start(world);
    const serverB = await t.start(world, { pool: b.pool });

    const inA = ticketWorktree(world.repo, "05.attempt-1");
    const inB = ticketWorktree(b.checkout, "05.attempt-1");
    expect(inA.key).not.toBe(inB.key);
    const listed = await until(
      () => worktreeList(world.repo),
      (list) => [inA.path, inB.path].every((path) => list.some((w) => w.path === path)),
      { what: "both pools' 05.attempt-1 worktrees registered" },
    );
    expect(poolBranches(world.repo).sort()).toEqual([inA.branch, inB.branch].sort());
    expect(inA.branch).toBe(`pool/${inA.key}/05.attempt-1`);
    expect(inB.branch).toBe(`pool/${inB.key}/05.attempt-1`);
    expect(listed.find((w) => w.path === inA.path)!.branch).toBe(inA.branch);
    expect(listed.find((w) => w.path === inB.path)!.branch).toBe(inB.branch);
    writeFileSync(release, "");
    await untilDone(serverA);
    await untilDone(serverB);
  },
);

conformance(
  "merges",
  "a worktree registered at a Ticket's path on a branch that is not the pool's own is refused, and left untouched",
  async (t) => {
    for (const shape of ["foreign branch", "detached HEAD"] as const) {
      const world = t.world({ tickets: [ready("02"), ready("03")], config: CONFIG });
      const foreign = ticketWorktree(world.repo, "02");
      mkdirSync(join(foreign.path, ".."), { recursive: true });
      world.git(
        shape === "foreign branch"
          ? ["worktree", "add", "-q", foreign.path, "-b", "intruder", "HEAD"]
          : ["worktree", "add", "-q", "--detach", foreign.path, "HEAD"],
      );
      const before = worktreeList(world.repo).find((w) => w.path === foreign.path)!;
      expect(before.branch).toBe(shape === "foreign branch" ? "intruder" : null);

      const server = await t.start(world);
      const lines = await untilLogged(server, "pool dead");
      const dead = lines.find((line) => line.includes("pool dead"))!;
      expect(dead).toContain(`worktree ${foreign.path} is checked out on`);
      expect(dead).toContain("refusing to adopt a foreign pool's worktree");
      const errorsPath = join(world.pool, "runs", "errors.jsonl");
      const errors = parseJsonl<{ at: string; error: string }>(readFileSync(errorsPath, "utf8"));
      expect(errors.some((e) => e.error.includes("refusing to adopt a foreign pool's worktree"))).toBe(true);
      await untilState(server, (s) => s.phase === "dead", { what: `the dead phase (${shape})` });
      expect(worktreeList(world.repo).find((w) => w.path === foreign.path)).toEqual(before);
      if (shape === "foreign branch") expect(gitOk(world.repo, ["rev-parse", "--verify", foreign.branch])).toBe(false);
      await server.stop();
    }
  },
);

conformance(
  "merges",
  "the worktree key is the first 8 hex of sha256 of the checkout's real path, so a second server finds and reuses a parked worktree",
  async (t) => {
    const world = t.world({ tickets: [ready("01"), ready("02")], config: CONFIG });
    const link = join(world.root, "link");
    symlinkSync(world.repo, link);
    world.stubs.script("01", {
      statuses: ["checkpoint", "done"],
      run: [commit("parked.txt", "parked-01"), [record("01-second"), commit("more.txt", "work-01b")].join("\n")],
    });
    const first = await t.start(world, { pool: join(link, ".scratch", "pool") });
    await untilState(first, (s) => s.phase === "quiescent" && hasInterrupt(s, "01", "checkpoint"), {
      what: "01 checkpointed and parked",
    });

    const real = realpathSync(world.repo);
    const key = createHash("sha256").update(real).digest("hex").slice(0, 8);
    expect(key).not.toBe(createHash("sha256").update(link).digest("hex").slice(0, 8));
    const path = join(real, ".git", "pool-worktrees", key, "01");
    const branch = `pool/${key}/01`;
    expect(worktreeList(world.repo).find((w) => w.path === path)?.branch).toBe(branch);
    const tip = gitIn(world.repo, ["rev-parse", branch]).trim();
    await first.stop();

    // The second server is given the canonical spelling: the key is the
    // same whichever way the pool is reached.
    const second = await t.start(world);
    await untilState(second, (s) => hasInterrupt(s, "01", "checkpoint"), { what: "01's checkpoint after the restart" });
    await resume(second, "01");
    await untilDone(second);
    expect(recorded(world, "01-second", "cwd")).toBe(path);
    expect(recorded(world, "01-second", "branch")).toBe(branch);
    expect(recorded(world, "01-second", "head")).toBe(tip);
    expect(subjects(world.repo, "main")).toEqual(expect.arrayContaining(["parked-01", "work-01b"]));
  },
);

conformance(
  "merges",
  "a landed merge removes the Ticket's worktree and deletes its pool branch",
  async (t) => {
    const world = t.world({ tickets: [ready("01"), ready("02")], config: CONFIG });
    world.stubs.script("01", { run: commit("one.txt", "work-01") });
    world.stubs.script("02", { run: commit("two.txt", "work-02") });
    await t.start(world);
    const wts = ["01", "02"].map((id) => ({ id, ...ticketWorktree(world.repo, id) }));
    await until(
      () => wts.map((w) => readEvents(world.pool, w.id).some((e) => e.kind === "merged")),
      (merged) => merged.every(Boolean),
      { what: "both merged events" },
    );
    for (const w of wts) {
      expect(world.stubs.calls().find((c) => c.key === w.id)!.cwd).toBe(w.path);
    }
    await until(
      () => ({ list: worktreeList(world.repo), pool: poolBranches(world.repo) }),
      ({ list, pool }) => wts.every((w) => !list.some((e) => e.path === w.path) && !pool.includes(w.branch)),
      { what: "both worktrees and branches gone" },
    );
    for (const w of wts) expect(existsSync(w.path)).toBe(false);
    expect(subjects(world.repo, "main")).toEqual(expect.arrayContaining(["work-01", "work-02"]));
  },
);
