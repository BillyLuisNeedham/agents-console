import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  attemptBranches,
  branchFor,
  poolKeyFor,
  prepareWorktree,
  worktreePathFor,
} from "./worktrees.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface GitProbe {
  ok: boolean;
  out: string;
}

function makeRepo(): { root: string; git: (args: string[]) => GitProbe } {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  tempDirs.push(root);
  const git = (args: string[]): GitProbe => {
    const probe = Bun.spawnSync(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: probe.exitCode === 0, out: probe.stdout.toString().trim() };
  };
  writeFileSync(join(root, "base.txt"), "base\n");
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "wt@test"]);
  git(["config", "user.name", "wt"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return { root, git };
}

// A second checkout of the same repo: a linked worktree, which is exactly
// the shape the live collision had, distinct pool directories, one shared
// common git dir, one shared ref namespace.
function secondCheckout(
  repo: ReturnType<typeof makeRepo>,
): { root: string; git: (args: string[]) => GitProbe } {
  const base = mkdtempSync(join(tmpdir(), "wt-"));
  tempDirs.push(base);
  const root = join(base, "checkout");
  const probe = Bun.spawnSync(
    ["git", "-C", repo.root, "worktree", "add", root, "-b", "companion", "HEAD"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (probe.exitCode !== 0) {
    throw new Error(`worktree add failed: ${probe.stderr.toString()}`);
  }
  const git = (args: string[]): GitProbe => {
    const p = Bun.spawnSync(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
  };
  return { root, git };
}

describe("pool namespacing", () => {
  it("keys worktrees and branches by the pool directory, so two pools on one repo never collide", () => {
    const a = makeRepo();
    const b = secondCheckout(a);
    const keyA = poolKeyFor(a.root);
    const keyB = poolKeyFor(b.root);
    expect(keyA).not.toBe(keyB);
    expect(keyA).toMatch(/^[0-9a-f]{8}$/);

    const wa = prepareWorktree(a.root, "02");
    const wb = prepareWorktree(b.root, "02");
    expect(wa.branch).toBe(`pool/${keyA}/02`);
    expect(wb.branch).toBe(`pool/${keyB}/02`);
    expect(wa.branch).not.toBe(wb.branch);
    expect(wa.path).toBe(
      join(a.root, ".git", "pool-worktrees", keyA, "02"),
    );
    expect(wb.path).not.toBe(wa.path);
    expect(wb.path).toContain(join("pool-worktrees", keyB));

    // Both worktrees are registered at once, each on its own pool's branch:
    // the live incident had two agents sharing one worktree concurrently.
    const listed = a.git(["worktree", "list", "--porcelain"]).out;
    expect(listed).toContain(`worktree ${wa.path}`);
    expect(listed).toContain(`worktree ${wb.path}`);

    // The parked-worktree reuse rule survives the namespacing: a second
    // prepare returns the same worktree, and a pruned worktree over an
    // existing branch is re-attached to that branch, not rebranched.
    expect(prepareWorktree(a.root, "02")).toEqual(wa);
    a.git(["worktree", "remove", "--force", wa.path]);
    expect(prepareWorktree(a.root, "02")).toEqual(wa);
  });

  it("namespaces attempt branches and worktrees the same way", () => {
    const a = makeRepo();
    const b = secondCheckout(a);
    const aa = prepareWorktree(a.root, "05", 1);
    const ab = prepareWorktree(b.root, "05", 1);
    expect(aa.branch).toBe(`pool/${poolKeyFor(a.root)}/05.attempt-1`);
    expect(ab.branch).toBe(`pool/${poolKeyFor(b.root)}/05.attempt-1`);
    expect(aa.branch).not.toBe(ab.branch);
    expect(aa.path).not.toBe(ab.path);
    // A ref exists per pool for the same ticket id and attempt number.
    expect(a.git(["rev-parse", "--verify", aa.branch]).ok).toBe(true);
    expect(a.git(["rev-parse", "--verify", ab.branch]).ok).toBe(true);
    expect(attemptBranches(a.root, "05")).toEqual([1]);
    expect(attemptBranches(b.root, "05")).toEqual([1]);
  });

  it("rejects a registered worktree whose checked-out branch belongs to another pool", () => {
    const a = makeRepo();
    // A worktree at this pool's exact path, checked out on someone else's
    // branch: adopting it would graft foreign work into this pool's run.
    const foreign = worktreePathFor(a.root, "02");
    mkdirSync(dirname(foreign), { recursive: true });
    expect(
      a.git(["worktree", "add", foreign, "-b", "intruder", "HEAD"]).ok,
    ).toBe(true);
    expect(() => prepareWorktree(a.root, "02")).toThrow(/refusing to adopt/);

    // A detached HEAD is no pool's branch, so it is foreign too.
    const detached = worktreePathFor(a.root, "03");
    mkdirSync(dirname(detached), { recursive: true });
    expect(a.git(["worktree", "add", "--detach", detached, "HEAD"]).ok).toBe(
      true,
    );
    expect(() => prepareWorktree(a.root, "03")).toThrow(/refusing to adopt/);

    // The rejection leaves the foreign worktree untouched for its owner.
    expect(a.git(["worktree", "list", "--porcelain"]).out).toContain(
      `worktree ${foreign}`,
    );
  });
});
