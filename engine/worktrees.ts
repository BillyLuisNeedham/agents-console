import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface GitProbe {
  ok: boolean;
  out: string;
  err: string;
}

export function git(repoRoot: string, args: string[]): GitProbe {
  const probe = Bun.spawnSync({
    cmd: ["git", "-C", repoRoot, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: probe.exitCode === 0,
    out: probe.stdout.toString().trim(),
    err: probe.stderr.toString().trim(),
  };
}

// Worktree mode needs a real repo with at least one commit; without one the
// engine runs tickets in the main checkout, exactly as before.
export function gitAvailable(repoRoot: string): boolean {
  return git(repoRoot, ["rev-parse", "--verify", "HEAD"]).ok;
}

export function branchFor(ticketId: string): string {
  return `pool/${ticketId}`;
}

// Worktrees live inside .git so they never appear in the main checkout's
// status, where an in-place ticket could sweep one into a commit.
export function worktreePathFor(repoRoot: string, ticketId: string): string {
  return join(repoRoot, ".git", "pool-worktrees", ticketId);
}

export function branchExists(repoRoot: string, ticketId: string): boolean {
  return git(repoRoot, ["rev-parse", "--verify", branchFor(ticketId)]).ok;
}

// A parked branch or worktree (left by a checkpoint, a crash or a conflict)
// is reused, so the ticket keeps the work it already did; the base is never
// moved under it. Fresh tickets branch from HEAD.
export function prepareWorktree(
  repoRoot: string,
  ticketId: string,
): WorktreeInfo {
  const branch = branchFor(ticketId);
  const path = worktreePathFor(repoRoot, ticketId);
  git(repoRoot, ["worktree", "prune"]);
  const registered = git(repoRoot, ["worktree", "list", "--porcelain"])
    .out.split("\n")
    .includes(`worktree ${path}`);
  if (!registered) {
    mkdirSync(dirname(path), { recursive: true });
    const add = branchExists(repoRoot, ticketId)
      ? git(repoRoot, ["worktree", "add", path, branch])
      : git(repoRoot, ["worktree", "add", path, "-b", branch, "HEAD"]);
    if (!add.ok) {
      throw new Error(
        `worktree add failed for ticket ${ticketId}: ${add.err || add.out}`,
      );
    }
  }
  return { path, branch };
}

// Only called once the branch has merged, so anything left uncommitted in
// the worktree is debris; --force discards it.
export function removeWorktree(repoRoot: string, info: WorktreeInfo): void {
  git(repoRoot, ["worktree", "remove", "--force", info.path]);
  git(repoRoot, ["branch", "-d", info.branch]);
}

export interface MergeResult {
  ok: boolean;
  conflicted: string[];
  detail: string;
}

// Merges the ticket's branch onto whatever the pool's working branch
// currently is. A failure aborts the merge so the working branch is never
// left half-merged; the caller surfaces the conflict. A missing branch means
// a human finished the job by hand and cleaned up, which counts as merged.
export function mergeBranch(repoRoot: string, branch: string): MergeResult {
  if (!git(repoRoot, ["rev-parse", "--verify", branch]).ok) {
    return { ok: true, conflicted: [], detail: `branch ${branch} is gone` };
  }
  const merge = git(repoRoot, ["merge", "--no-edit", branch]);
  if (merge.ok) return { ok: true, conflicted: [], detail: merge.out };
  const conflicted = git(repoRoot, ["diff", "--name-only", "--diff-filter=U"])
    .out.split("\n")
    .filter(Boolean);
  if (git(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) {
    git(repoRoot, ["merge", "--abort"]);
  }
  return { ok: false, conflicted, detail: merge.err || merge.out };
}
