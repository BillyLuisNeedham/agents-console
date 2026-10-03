import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "../conformance/fixtures/tmp.ts";
import {
  attemptBranches,
  branchFor,
  mergeBranch,
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
  const root = makeTempDir("wt-");
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
  const base = makeTempDir("wt-");
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

// A merge git refuses before starting (#92): an untracked file in the pool
// checkout that the branch would write. Git refuses even a byte-identical
// copy, so the pre-check clears those and only a differing copy blocks.
describe("merges blocked by untracked pool files (#92)", () => {
  // A branch off main's initial commit that commits `path` with `content`.
  function branchWriting(
    repo: ReturnType<typeof makeRepo>,
    path: string,
    content: string,
  ): string {
    repo.git(["checkout", "-qb", "feat"]);
    mkdirSync(dirname(join(repo.root, path)), { recursive: true });
    writeFileSync(join(repo.root, path), content);
    repo.git(["add", "-A"]);
    repo.git(["commit", "-qm", "work"]);
    repo.git(["checkout", "-q", "main"]);
    return "feat";
  }

  it("deletes an untracked copy identical to the branch's version and merges", () => {
    const repo = makeRepo();
    const branch = branchWriting(repo, "findings/x.md", "fresh\n");
    mkdirSync(join(repo.root, "findings"));
    writeFileSync(join(repo.root, "findings", "x.md"), "fresh\n");

    const result = mergeBranch(repo.root, branch);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.cleared).toEqual(["findings/x.md"]);
    expect(result.blocked).toEqual([]);
    expect(result.detail).toContain("findings/x.md");
    // The branch's version is now the tracked one and the tree is clean.
    expect(readFileSync(join(repo.root, "findings", "x.md"), "utf8")).toBe("fresh\n");
    expect(repo.git(["ls-files", "findings/x.md"]).out).toBe("findings/x.md");
    expect(repo.git(["status", "--porcelain"]).out).toBe("");
  });

  it("refuses to merge over an untracked copy that differs, without starting the merge, and merges once it is gone", () => {
    const repo = makeRepo();
    const branch = branchWriting(repo, "findings/x.md", "fresh\n");
    mkdirSync(join(repo.root, "findings"));
    writeFileSync(join(repo.root, "findings", "x.md"), "stale\n");
    const headBefore = repo.git(["rev-parse", "HEAD"]).out;

    const result = mergeBranch(repo.root, branch);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("blocked");
    expect(result.blocked).toEqual(["findings/x.md"]);
    expect(result.conflicted).toEqual([]);
    expect(result.cleared).toEqual([]);
    expect(result.detail).toContain("findings/x.md");
    // Nothing was touched: the operator's copy is intact, no merge is in
    // progress, and the working branch did not move.
    expect(readFileSync(join(repo.root, "findings", "x.md"), "utf8")).toBe("stale\n");
    expect(repo.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok).toBe(false);
    expect(repo.git(["rev-parse", "HEAD"]).out).toBe(headBefore);

    rmSync(join(repo.root, "findings", "x.md"));
    const again = mergeBranch(repo.root, branch);
    expect(again.ok).toBe(true);
    expect(again.cleared).toEqual([]);
    expect(readFileSync(join(repo.root, "findings", "x.md"), "utf8")).toBe("fresh\n");
  });

  it("ignores untracked files the branch does not touch", () => {
    const repo = makeRepo();
    const branch = branchWriting(repo, "findings/x.md", "fresh\n");
    writeFileSync(join(repo.root, "notes.md"), "mine\n");

    const result = mergeBranch(repo.root, branch);
    expect(result.ok).toBe(true);
    expect(result.cleared).toEqual([]);
    expect(readFileSync(join(repo.root, "notes.md"), "utf8")).toBe("mine\n");
  });

  it("classifies a merge git refused for uncommitted changes as blocked, not conflicted", () => {
    const repo = makeRepo();
    const branch = branchWriting(repo, "base.txt", "from-branch\n");
    // A tracked file with local changes the branch would overwrite: git
    // refuses before starting, with no MERGE_HEAD and no unmerged paths,
    // the same signature as the untracked case.
    writeFileSync(join(repo.root, "base.txt"), "dirty\n");

    const result = mergeBranch(repo.root, branch);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("blocked");
    expect(result.blocked).toEqual(["base.txt"]);
    expect(result.conflicted).toEqual([]);
    expect(result.detail).toContain("local changes");
    expect(readFileSync(join(repo.root, "base.txt"), "utf8")).toBe("dirty\n");
    expect(repo.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok).toBe(false);
  });

  it("still reports a merge git started and could not finish as a conflict", () => {
    const repo = makeRepo();
    const branch = branchWriting(repo, "base.txt", "from-branch\n");
    writeFileSync(join(repo.root, "base.txt"), "from-main\n");
    repo.git(["commit", "-qam", "main moves"]);

    const result = mergeBranch(repo.root, branch);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("conflict");
    expect(result.conflicted).toEqual(["base.txt"]);
    expect(result.blocked).toEqual([]);
    // Aborted, as before: the working branch is left clean.
    expect(repo.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok).toBe(false);
    expect(readFileSync(join(repo.root, "base.txt"), "utf8")).toBe("from-main\n");
  });
});
