import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

interface GitProbe {
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

function refExists(repoRoot: string, ref: string): boolean {
  return git(repoRoot, ["rev-parse", "--verify", ref]).ok;
}

// Worktree mode needs a real repo with at least one commit; without one the
// engine runs tickets in the main checkout, exactly as before.
export function gitAvailable(repoRoot: string): boolean {
  return refExists(repoRoot, "HEAD");
}

export function currentBranch(repoRoot: string): string {
  const probe = git(repoRoot, ["branch", "--show-current"]);
  return probe.out || "main";
}

// Completes an in-progress merge in a worktree: the resolver leaves a staged
// resolution and a MERGE_HEAD in the worktree, and committing turns it into a
// merge commit on the ticket's branch, making the working branch an ancestor
// so the follow-up merge fast-forwards.
export function commitMerge(worktree: WorktreeInfo): GitProbe {
  return git(worktree.path, ["commit", "-qm", `merge ${worktree.branch} by resolver`]);
}

// The solo branch keeps the well-known name; a verify fan-out's attempt
// branches suffix the attempt number. Dotted rather than slashed, so an
// attempt branch never collides with a parked solo branch: git forbids
// refs where one is a prefix path of the other.
export function branchFor(ticketId: string, attempt?: number): string {
  return attempt === undefined
    ? `pool/${ticketId}`
    : `pool/${ticketId}.attempt-${attempt}`;
}

// Worktrees live inside the common git dir so they never appear in a
// checkout's status, where an in-place ticket could sweep one into a commit.
// The common dir is the main checkout's .git for every worktree of the repo —
// a linked worktree's own .git is a file, not a directory, so anchoring there
// would break ticket worktree creation.
const commonDirCache = new Map<string, string>();

function gitCommonDir(repoRoot: string): string {
  const cached = commonDirCache.get(repoRoot);
  if (cached) return cached;
  const probe = git(repoRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const dir = probe.ok && probe.out ? probe.out : join(repoRoot, ".git");
  commonDirCache.set(repoRoot, dir);
  return dir;
}

export function worktreePathFor(
  repoRoot: string,
  ticketId: string,
  attempt?: number,
): string {
  return join(
    gitCommonDir(repoRoot),
    "pool-worktrees",
    attempt === undefined ? ticketId : `${ticketId}.attempt-${attempt}`,
  );
}

export function branchExists(
  repoRoot: string,
  ticketId: string,
  attempt?: number,
): boolean {
  return refExists(repoRoot, branchFor(ticketId, attempt));
}

// A parked branch or worktree (left by a checkpoint, a crash or a conflict)
// is reused, so the ticket keeps the work it already did; the base is never
// moved under it. Fresh tickets branch from HEAD. An attempt number names a
// verify fan-out's per-attempt branch and worktree; attempt numbers never
// repeat for a ticket, so an attempt worktree is always created fresh.
export function prepareWorktree(
  repoRoot: string,
  ticketId: string,
  attempt?: number,
): WorktreeInfo {
  const branch = branchFor(ticketId, attempt);
  const path = worktreePathFor(repoRoot, ticketId, attempt);
  git(repoRoot, ["worktree", "prune"]);
  const registered = git(repoRoot, ["worktree", "list", "--porcelain"])
    .out.split("\n")
    .includes(`worktree ${path}`);
  if (!registered) {
    mkdirSync(dirname(path), { recursive: true });
    const add = branchExists(repoRoot, ticketId, attempt)
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
  if (!refExists(repoRoot, branch)) {
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
